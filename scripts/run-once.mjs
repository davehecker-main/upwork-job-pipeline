#!/usr/bin/env node
/**
 * One full pass of the pipeline, outside n8n: take an Upwork search response,
 * score every job against the rubric, and post the qualifying ones to Slack.
 *
 * This is the runtime for the Claude-Code architecture: a scheduled
 * `claude -p` run fetches jobs through the Upwork MCP, writes the response to a
 * file, and calls this. Discovery is the only part that needs MCP; everything
 * here is the same tested modules the n8n build uses.
 *
 * Usage:
 *   node scripts/run-once.mjs <search-response.json> [--post] [--channel test]
 *
 * Without --post it scores and prints, and spends only the Haiku tokens.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, readContextPack } from './lib/inline.mjs';
import { loadEnv, requireEnv } from './lib/env.mjs';
import { callAnthropic, mapLimit, costOf } from './lib/anthropic.mjs';
import { normalizeUpworkJob, isScorable } from '../src/normalize-upwork.js';
import { buildScoreRequest, parseScoreResponse } from '../src/score-prompt.js';
import { renderJobCard } from '../src/slack-card.js';
import {
  SCORE_THRESHOLD, SCORING_MODEL, SCORING_JSON_MODE,
} from '../src/thresholds.js';
import {
  STATUS, hasSeen, markSeen, updateStatus, countByStatus,
} from '../src/state.js';

loadEnv();
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const post = args.includes('--post');
const useTest = args.includes('--channel') && args[args.indexOf('--channel') + 1] === 'test';

if (!file || !existsSync(file)) {
  console.error('\nusage: node scripts/run-once.mjs <search-response.json> [--post] [--channel test]\n');
  process.exit(2);
}

/* State lives in a plain JSON file - state.js is pure functions over an object,
 * so the same dedupe logic serves this runtime and the n8n one unchanged. */
const statePath = join(ROOT, 'setup', 'state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const saveState = () => {
  mkdirSync(join(ROOT, 'setup'), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
};

const CONTEXT_PACK = JSON.parse(readContextPack().match(/const CONTEXT_PACK = ([\s\S]*);/)[1]);
const apiKey = requireEnv('ANTHROPIC_API_KEY');

const response = JSON.parse(readFileSync(file, 'utf8'));
const all = (response.jobs || []).map(normalizeUpworkJob).filter(isScorable);
const fresh = all.filter((j) => !hasSeen(state, j.job_id));

console.log(`\n${all.length} jobs in the response, ${fresh.length} not seen before`);
if (!fresh.length) {
  console.log('nothing new — this is the normal outcome of most polls\n');
  process.exit(0);
}

const scored = await mapLimit(fresh, 4, async (job) => {
  const body = buildScoreRequest(job, CONTEXT_PACK, {
    model: SCORING_MODEL, mode: SCORING_JSON_MODE,
  });
  const res = await callAnthropic(body, apiKey);
  return { job, score: parseScoreResponse(res), usage: res.usage, model: res.model };
});

let cost = 0;
const qualified = [];

for (const r of scored) {
  if (!r.ok) { console.log(`  ✗ scoring failed: ${r.error.message.slice(0, 120)}`); continue; }
  const { job, score } = r.value;
  cost += costOf(r.value.model || SCORING_MODEL, r.value.usage);
  markSeen(state, job);

  const passes = score.score >= SCORE_THRESHOLD;
  updateStatus(state, job.job_id, passes ? STATUS.QUALIFIED : STATUS.REJECTED, {
    score: score.score, verdict: score.verdict, reasoning: score.reasoning,
  });

  const mark = passes ? '✅' : '· ';
  console.log(`\n${mark} ${score.score}/100 ${score.verdict}  ${job.title.slice(0, 62)}`);
  console.log(`     ${job.budget_display} · ${job.client_summary.slice(0, 100)}`);
  console.log(`     ${score.reasoning}`);
  if (score.red_flags.length) console.log(`     ⚠️  ${score.red_flags.join(' · ')}`);
  if (passes) qualified.push({ job, score });
}

saveState();
console.log(`\n${qualified.length} of ${scored.length} passed the threshold of ${SCORE_THRESHOLD}`);
console.log(`scoring cost: $${cost.toFixed(4)}`);
console.log(`state: ${JSON.stringify(countByStatus(state))}`);

if (!post) {
  console.log('\n(dry run — pass --post to send the cards to Slack)\n');
  process.exit(0);
}

const token = requireEnv('SLACK_BOT_TOKEN');
const channel = useTest
  ? requireEnv('SLACK_TEST_CHANNEL')
  : requireEnv('SLACK_CHANNEL');

for (const { job, score } of qualified) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      channel,
      text: renderJobCard(job, score),
      unfurl_links: false,
    }),
  });
  const body = await res.json();
  if (body.ok) {
    updateStatus(state, job.job_id, STATUS.QUALIFIED, { slack_ts: body.ts });
    console.log(`posted: ${job.title.slice(0, 60)}`);
  } else {
    console.log(`slack failed (${body.error}): ${job.title.slice(0, 50)}`);
  }
}
saveState();
console.log('');
