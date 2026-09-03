#!/usr/bin/env node
/**
 * Read the reactions on posted job cards and act on them: a white_check_mark
 * gets a proposal drafted into the card's thread, an x marks the job skipped.
 *
 * This replaces the paused-workflow approval gate. It needs no public webhook,
 * no interactivity endpoint and no always-on server - the state is Slack's own
 * reactions, read on a schedule.
 *
 * Usage:
 *   node scripts/check-approvals.mjs           # act on approvals
 *   node scripts/check-approvals.mjs --dry-run # report what it would do
 */

import { requireEnv, loadEnv } from './lib/env.mjs';
import { loadState, saveState, slackGet, draftFor, enrichPosting } from './lib/pipeline.mjs';
import { STATUS, updateStatus } from '../src/state.js';

loadEnv();
const dryRun = process.argv.includes('--dry-run');

const token = requireEnv('SLACK_BOT_TOKEN');
const apiKey = requireEnv('ANTHROPIC_API_KEY');
const state = loadState();

// Only cards that are posted and still awaiting a decision.
const waiting = Object.entries(state.jobs || {})
  .filter(([, r]) => r.status === STATUS.QUALIFIED && r.slack_ts);

if (!waiting.length) {
  console.log('\nno cards awaiting a decision\n');
  process.exit(0);
}

console.log(`\n${waiting.length} card(s) awaiting a decision\n`);
let drafted = 0;
let skipped = 0;
let cost = 0;

for (const [jobId, rec] of waiting) {
  const res = await slackGet('reactions.get', {
    channel: rec.slack_channel, timestamp: rec.slack_ts,
  }, token);

  if (!res.ok) {
    if (res.error === 'missing_scope') {
      console.error('Slack rejected reactions.get: the app needs the reactions:read scope.');
      console.error('Update setup/slack-app-manifest.json in the app, then reinstall it.\n');
      process.exit(2);
    }
    console.log(`  ${rec.title?.slice(0, 50)}: could not read reactions (${res.error})`);
    continue;
  }

  const reactions = res.message?.reactions || [];
  // The bot seeds both emoji, so its own reaction is always present: a human
  // decision is a count above one, not merely the emoji existing.
  const votes = (name) => {
    const r = reactions.find((x) => x.name === name);
    return r ? r.count - (r.users?.includes(res.message?.bot_id) ? 1 : 0) : 0;
  };
  const approve = reactions.find((r) => r.name === 'white_check_mark');
  const reject = reactions.find((r) => r.name === 'x');
  const approved = approve && approve.count > 1;
  const rejected = reject && reject.count > 1;

  const label = (rec.title || jobId).slice(0, 52);

  if (approved && rejected) {
    console.log(`  ? ${label}: both ✅ and ❌ — leaving it alone`);
    continue;
  }
  if (!approved && !rejected) {
    console.log(`  · ${label}: no decision yet`);
    continue;
  }

  if (rejected) {
    console.log(`  ✗ ${label}: skipped`);
    if (!dryRun) updateStatus(state, jobId, STATUS.SKIPPED);
    skipped += 1;
    continue;
  }

  console.log(`  ✅ ${label}: approved`);
  if (dryRun) { drafted += 1; continue; }

  // Fetch the full posting BEFORE drafting. Search truncates the description
  // to ~250 characters, and a proposal written from that is a guess dressed up
  // as a proposal. This is the one Upwork call made per approved job.
  try {
    const before = (state.jobs[jobId].description || '').length;
    const after = await enrichPosting(jobId, { state });
    console.log(`     posting fetched: ${before} -> ${after} chars`);
  } catch (error) {
    console.log(`     could not fetch the full posting (${String(error.message).slice(0, 90)})`);
    console.log('     drafting from the search snippet instead');
  }

  try {
    const out = await draftFor(jobId, { apiKey, token, state });
    cost += out.cost;
    drafted += 1;
    const words = out.draft.proposal.trim().split(/\s+/).length;
    console.log(`     ${words} words · ${out.failures.length ? out.failures.join('; ') : 'checks passed'}`);
    console.log(`     rate note: ${out.draft.rate_note}`);
  } catch (error) {
    console.log(`     draft failed: ${String(error.message).slice(0, 160)}`);
  }
}

if (!dryRun) saveState(state);
console.log(`\n${drafted} drafted, ${skipped} skipped${cost ? ` · drafting cost $${cost.toFixed(4)}` : ''}`);
console.log(dryRun ? '(dry run — nothing was changed)\n' : '');
