/**
 * The pipeline's shared core: state on disk, scoring, and Slack posting.
 *
 * Used by scripts/poll.mjs (scheduled discovery) and scripts/run-once.mjs
 * (a saved response, for testing). Everything here is transport-agnostic - it
 * takes an Upwork search response and does not care how it was fetched.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, readContextPack, bannedOpeners } from './context.mjs';
import { callAnthropic, mapLimit, costOf } from './anthropic.mjs';
import { normalizeUpworkJob, isScorable } from '../../src/normalize-upwork.js';
import { buildScoreRequest, parseScoreResponse } from '../../src/score-prompt.js';
import { buildDraftRequest, parseDraftResponse, checkDraft } from '../../src/draft-prompt.js';
import { renderJobCard, renderDraftMessage } from '../../src/slack-card.js';
import {
  SCORE_THRESHOLD, SCORING_MODEL, SCORING_JSON_MODE, DRAFTING_MODEL, DRAFT_EFFORT,
  DRAFT_MIN_WORDS, DRAFT_MAX_WORDS,
} from '../../src/thresholds.js';
import { STATUS, hasSeen, markSeen, updateStatus, get, prune } from '../../src/state.js';

export const STATE_PATH = join(ROOT, 'setup', 'state.json');
export const CONTEXT_PACK = readContextPack();
export const BANNED_OPENERS = bannedOpeners(CONTEXT_PACK);

export function loadState() {
  return existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {};
}

export function saveState(state) {
  mkdirSync(join(ROOT, 'setup'), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

/** Slack Web API call. Returns the parsed body; never throws on a Slack error. */
export async function slack(method, body, token) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function slackGet(method, params, token) {
  const res = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.json();
}

/**
 * Score the unseen jobs in a search response. Mutates and persists state.
 * @returns {{qualified: Array, scored: number, cost: number, skipped: number}}
 */
export async function scoreResponse(response, apiKey, { state = loadState(), log = console.log } = {}) {
  prune(state, 120);
  const all = (response.jobs || []).map(normalizeUpworkJob).filter(isScorable);
  const fresh = all.filter((j) => !hasSeen(state, j.job_id));

  log(`${all.length} jobs returned, ${fresh.length} not seen before`);
  if (!fresh.length) {
    saveState(state);
    return { qualified: [], scored: 0, cost: 0, skipped: all.length };
  }

  const results = await mapLimit(fresh, 4, async (job) => {
    const res = await callAnthropic(
      buildScoreRequest(job, CONTEXT_PACK, { model: SCORING_MODEL, mode: SCORING_JSON_MODE }),
      apiKey,
    );
    return { job, score: parseScoreResponse(res), usage: res.usage, model: res.model };
  });

  let cost = 0;
  const qualified = [];

  for (const r of results) {
    if (!r.ok) { log(`  scoring failed: ${r.error.message.slice(0, 140)}`); continue; }
    const { job, score } = r.value;
    cost += costOf(r.value.model || SCORING_MODEL, r.value.usage);
    markSeen(state, job);
    const passes = score.score >= SCORE_THRESHOLD;
    updateStatus(state, job.job_id, passes ? STATUS.QUALIFIED : STATUS.REJECTED, {
      score: score.score,
      verdict: score.verdict,
      reasoning: score.reasoning,
      red_flags: score.red_flags,
      // Kept so an approval can be drafted later without re-fetching.
      url: job.url,
      budget_display: job.budget_display,
      client_summary: job.client_summary,
      description: job.description,
      description_truncated: job.description_truncated,
      skills: job.skills,
      proposals: job.proposals,
    });
    log(`  ${passes ? '✅' : '· '} ${score.score}/100 ${score.verdict}  ${job.title.slice(0, 58)}`);
    if (passes) qualified.push({ job, score });
  }

  saveState(state);
  return { qualified, scored: results.length, cost, skipped: all.length - fresh.length, state };
}

/** Post one card per qualifying job and record the message timestamp. */
export async function postCards(qualified, { token, channel, state = loadState(), log = console.log }) {
  for (const { job, score } of qualified) {
    const body = await slack('chat.postMessage', {
      channel,
      text: renderJobCard(job, score),
      unfurl_links: false,
    }, token);

    if (!body.ok) { log(`  slack failed (${body.error}): ${job.title.slice(0, 50)}`); continue; }

    updateStatus(state, job.job_id, STATUS.QUALIFIED, { slack_ts: body.ts, slack_channel: channel });
    log(`  posted: ${job.title.slice(0, 58)}`);

    // Seed the two reactions so approving is one tap rather than a hunt
    // through the emoji picker. This is the whole approval UI, so a failure
    // here must be visible - a silently unseeded card looks identical to one
    // waiting on a decision.
    for (const name of ['white_check_mark', 'x']) {
      const r = await slack('reactions.add', { channel, timestamp: body.ts, name }, token);
      if (!r.ok && r.error !== 'already_reacted') {
        log(`    could not seed :${name}: (${r.error})`
          + (r.error === 'missing_scope' ? ' — the app needs reactions:write' : ''));
      }
    }
  }
  saveState(state);
}

/** Draft a proposal for one approved job and post it in the card's thread. */
export async function draftFor(jobId, { apiKey, token, state = loadState(), log = console.log }) {
  const rec = get(state, jobId);
  if (!rec) throw new Error(`unknown job ${jobId}`);

  // The stored record IS the job for drafting purposes - scoreResponse keeps
  // every field the draft prompt reads.
  const job = {
    job_id: jobId,
    title: rec.title,
    url: rec.url,
    description: rec.description || '',
    description_truncated: Boolean(rec.description_truncated),
    budget_display: rec.budget_display || 'not stated',
    client_summary: rec.client_summary || '',
    skills: rec.skills || [],
    proposals: rec.proposals ?? null,
  };
  const score = {
    score: rec.score, verdict: rec.verdict, reasoning: rec.reasoning, red_flags: rec.red_flags || [],
  };

  const res = await callAnthropic(buildDraftRequest(job, CONTEXT_PACK, {
    model: DRAFTING_MODEL,
    effort: DRAFT_EFFORT,
    score,
    minWords: DRAFT_MIN_WORDS,
    maxWords: DRAFT_MAX_WORDS,
  }), apiKey);

  const draft = parseDraftResponse(res);
  const failures = checkDraft(draft, job, {
    minWords: DRAFT_MIN_WORDS, maxWords: DRAFT_MAX_WORDS, bannedOpeners: BANNED_OPENERS,
  });

  let message = renderDraftMessage(job, draft);
  if (failures.length) message += `\n\n:warning: draft checks: ${failures.join('; ')}`;

  const posted = await slack('chat.postMessage', {
    channel: rec.slack_channel,
    thread_ts: rec.slack_ts,
    text: message,
    unfurl_links: false,
  }, token);

  updateStatus(state, jobId, STATUS.DRAFTED, {
    proposal: draft.proposal,
    rate_note: draft.rate_note,
    draft_warnings: failures,
  });
  saveState(state);

  if (!posted.ok) log(`  drafted but Slack rejected the thread reply: ${posted.error}`);
  return { draft, failures, cost: costOf(res.model || DRAFTING_MODEL, res.usage) };
}
