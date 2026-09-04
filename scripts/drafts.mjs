#!/usr/bin/env node
/**
 * List or print the proposals this pipeline has drafted.
 *
 * They live in setup/state.json and are posted into each job card's Slack
 * thread. This is the way to read them without Slack - and the way to copy one
 * for pasting into Upwork's application form.
 *
 * Usage:
 *   node scripts/drafts.mjs              # list every drafted job
 *   node scripts/drafts.mjs <n>          # print draft n in full
 *   node scripts/drafts.mjs <n> --copy   # ...and put it on the clipboard
 */

import { execSync } from 'node:child_process';
import { loadState } from './lib/pipeline.mjs';
import { applyUrl } from '../src/slack-card.js';

const args = process.argv.slice(2);
const pick = args.find((a) => /^\d+$/.test(a));
const copy = args.includes('--copy');

const state = loadState();
const drafts = Object.entries(state.jobs || {})
  .filter(([, r]) => r.proposal)
  .sort((a, b) => (b[1].updated || 0) - (a[1].updated || 0));

if (!drafts.length) {
  console.log('\nno drafts yet — approve a card with ✅ and run scripts/check-approvals.mjs\n');
  process.exit(0);
}

if (!pick) {
  console.log('');
  drafts.forEach(([id, r], i) => {
    const words = r.proposal.replace(/^[\s\S]*?\n\n/, '').trim().split(/\s+/).length;
    const warn = (r.draft_warnings || []).length ? `  ⚠️  ${r.draft_warnings.join('; ')}` : '';
    console.log(`${String(i + 1).padStart(2)}. ${(r.title || id).slice(0, 58)}`);
    console.log(`    ${r.score}/100 · ${words} words · ${r.rate_note ? r.rate_note.slice(0, 70) : 'no rate note'}${warn}`);
  });
  console.log(`\nnode scripts/drafts.mjs <n>          print one in full`);
  console.log(`node scripts/drafts.mjs <n> --copy   print it and copy to clipboard\n`);
  process.exit(0);
}

const entry = drafts[Number(pick) - 1];
if (!entry) {
  console.error(`\nno draft ${pick} — there are ${drafts.length}\n`);
  process.exit(2);
}
const [id, r] = entry;

console.log(`\n${r.title}`);
console.log(`${r.score}/100 ${r.verdict} · ${r.budget_display}`);
console.log(`${r.client_summary}`);
console.log(`\nposting: ${r.url}`);
console.log(`apply:   ${applyUrl(r.url)}`);
if ((r.draft_warnings || []).length) console.log(`\n⚠️  ${r.draft_warnings.join('; ')}`);
console.log(`\n${'-'.repeat(70)}\n`);
console.log(r.proposal);
console.log(`\n${'-'.repeat(70)}`);
console.log(`rate note: ${r.rate_note}\n`);

if (copy) {
  try {
    execSync('pbcopy', { input: r.proposal });
    console.log('copied to clipboard — paste it straight into the Upwork form\n');
  } catch {
    console.log('(could not reach pbcopy; copy it from above)\n');
  }
}
