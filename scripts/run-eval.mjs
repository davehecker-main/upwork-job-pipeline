#!/usr/bin/env node
/**
 * Grade the scoring prompt against tests/evals/jobs.jsonl, and optionally the
 * drafting prompt against a sample of the qualifying rows.
 *
 * This is the test that actually protects the pipeline. Parser tests catch a
 * broken template; only this catches a rubric edit that quietly starts
 * rejecting good jobs. It hits the live API, so it costs money and is opt-in.
 *
 * Usage:
 *   node scripts/run-eval.mjs --yes                 # score every row
 *   node scripts/run-eval.mjs --yes --drafts 3      # plus 3 draft checks
 *   node scripts/run-eval.mjs --yes --real-only     # only rows labelled real
 *   node scripts/run-eval.mjs                       # print the cost, do nothing
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/inline.mjs';
import { requireEnv } from './lib/env.mjs';
import { callAnthropic, mapLimit, costOf } from './lib/anthropic.mjs';
import { readContextPack } from './lib/inline.mjs';
import { normalizeJob } from '../src/normalize.js';
import { buildScoreRequest, parseScoreResponse } from '../src/score-prompt.js';
import { buildDraftRequest, parseDraftResponse, checkDraft } from '../src/draft-prompt.js';
import {
  SCORE_THRESHOLD, SCORING_MODEL, DRAFTING_MODEL, DRAFT_EFFORT, SCORING_JSON_MODE,
  DRAFT_MIN_WORDS, DRAFT_MAX_WORDS,
} from '../src/thresholds.js';

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const val = (f, d) => (args.indexOf(`--${f}`) === -1 ? d : args[args.indexOf(`--${f}`) + 1]);

/** Gates. A false negative is a missed paying job, so it is the tight one. */
const MAX_FALSE_NEGATIVES = Number(val('max-fn', 1));
const MIN_ACCURACY = Number(val('min-accuracy', 0.8));
const CONCURRENCY = Number(val('concurrency', 5));

// The context pack is read through the same helper the build script uses, so
// the eval scores the prompt production will actually send.
const CONTEXT_PACK = JSON.parse(
  readContextPack().match(/const CONTEXT_PACK = ([\s\S]*);/)[1],
);

const BANNED_OPENERS = (CONTEXT_PACK.proposalRules.match(/^- "(.+)"$/gm) || [])
  .map((l) => l.replace(/^- "/, '').replace(/"$/, ''));

const rows = readFileSync(join(ROOT, 'tests/evals/jobs.jsonl'), 'utf8')
  .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => (has('real-only') ? r.source === 'real' : true));

const draftSample = Number(val('drafts', 0));

/* ------------------------------------------------------------- cost preview */

// ~1.1k input / 150 output for scoring; ~3k input / 500 output for a draft.
const estScore = rows.length * (1100 * 1 + 150 * 5) / 1e6;
const estDraft = draftSample * (3000 * 2 + 500 * 10) / 1e6;
const estimate = estScore + estDraft;

console.log(`\nScoring eval: ${rows.length} rows on ${SCORING_MODEL} (mode: ${SCORING_JSON_MODE})`);
if (draftSample) console.log(`Draft eval:   ${draftSample} rows on ${DRAFTING_MODEL} (effort: ${DRAFT_EFFORT})`);
console.log(`Threshold:    ${SCORE_THRESHOLD}`);
console.log(`Gates:        accuracy >= ${MIN_ACCURACY}, false negatives <= ${MAX_FALSE_NEGATIVES}`);
console.log(`Estimated cost: ~$${estimate.toFixed(3)}\n`);

if (!has('yes')) {
  console.log('This run spends real money. Re-run with --yes to execute it.\n');
  process.exit(0);
}
if (!rows.length) {
  console.log('No rows selected. Nothing to do.\n');
  process.exit(0);
}

const apiKey = requireEnv('ANTHROPIC_API_KEY', 'Create one at console.anthropic.com -> API keys.');

/* ------------------------------------------------------------------ scoring */

const scored = await mapLimit(rows, CONCURRENCY, async (row) => {
  const job = normalizeJob(row.job);
  const body = buildScoreRequest(job, CONTEXT_PACK, {
    model: SCORING_MODEL, mode: SCORING_JSON_MODE,
  });
  const response = await callAnthropic(body, apiKey);
  return { row, job, score: parseScoreResponse(response), usage: response.usage, model: response.model };
});

let cost = 0;
const results = [];
const errors = [];

scored.forEach((r, i) => {
  if (!r.ok) {
    errors.push({ id: rows[i].id, error: r.error.message });
    return;
  }
  cost += costOf(r.value.model || SCORING_MODEL, r.value.usage);
  const { row, score } = r.value;
  const predicted = score.score >= SCORE_THRESHOLD ? 'qualify' : 'reject';
  results.push({
    id: row.id,
    source: row.source || 'unknown',
    expected: row.expected,
    predicted,
    score: score.score,
    verdict: score.verdict,
    reasoning: score.reasoning,
    red_flags: score.red_flags,
    correct: row.expected === 'maybe' ? null : predicted === row.expected,
    note: row.note,
  });
});

/* ------------------------------------------------------------------ grading */

const graded = results.filter((r) => r.correct !== null);
const truePos = graded.filter((r) => r.expected === 'qualify' && r.predicted === 'qualify').length;
const falseNeg = graded.filter((r) => r.expected === 'qualify' && r.predicted === 'reject');
const trueNeg = graded.filter((r) => r.expected === 'reject' && r.predicted === 'reject').length;
const falsePos = graded.filter((r) => r.expected === 'reject' && r.predicted === 'qualify');
const accuracy = graded.length ? (truePos + trueNeg) / graded.length : 0;

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(`${pad('id', 12)}${pad('exp', 9)}${pad('got', 9)}${pad('score', 7)}reasoning`);
console.log('-'.repeat(96));
for (const r of results) {
  const mark = r.correct === null ? '·' : r.correct ? ' ' : '✗';
  console.log(`${mark}${pad(r.id, 11)}${pad(r.expected, 9)}${pad(r.predicted, 9)}${pad(r.score, 7)}${r.reasoning.slice(0, 58)}`);
}

console.log(`\n              predicted qualify   predicted reject`);
console.log(`expect qualify        ${pad(truePos, 18)}${falseNeg.length}`);
console.log(`expect reject         ${pad(falsePos.length, 18)}${trueNeg}`);
console.log(`\naccuracy: ${(accuracy * 100).toFixed(1)}%  (${truePos + trueNeg}/${graded.length})`);
console.log(`false negatives (missed paying work): ${falseNeg.length}${falseNeg.length ? ` -> ${falseNeg.map((r) => r.id).join(', ')}` : ''}`);
console.log(`false positives (wasted attention):   ${falsePos.length}${falsePos.length ? ` -> ${falsePos.map((r) => r.id).join(', ')}` : ''}`);
if (errors.length) console.log(`\nAPI errors on ${errors.length} rows: ${errors.map((e) => `${e.id} (${e.error})`).join('; ')}`);

/* ------------------------------------------------------------- draft checks */

const draftResults = [];
if (draftSample > 0) {
  const candidates = results.filter((r) => r.predicted === 'qualify').slice(0, draftSample);
  const drafted = await mapLimit(candidates, Math.min(CONCURRENCY, 3), async (r) => {
    const row = rows.find((x) => x.id === r.id);
    const job = normalizeJob(row.job);
    const body = buildDraftRequest(job, CONTEXT_PACK, {
      model: DRAFTING_MODEL,
      effort: DRAFT_EFFORT,
      score: { score: r.score, verdict: r.verdict, reasoning: r.reasoning, red_flags: r.red_flags },
      minWords: DRAFT_MIN_WORDS,
      maxWords: DRAFT_MAX_WORDS,
    });
    const response = await callAnthropic(body, apiKey);
    const draft = parseDraftResponse(response);
    return {
      id: r.id,
      job,
      draft,
      usage: response.usage,
      model: response.model,
      failures: checkDraft(draft, job, {
        minWords: DRAFT_MIN_WORDS, maxWords: DRAFT_MAX_WORDS, bannedOpeners: BANNED_OPENERS,
      }),
    };
  });

  console.log('\n--- draft checks ---');
  for (const d of drafted) {
    if (!d.ok) { console.log(`✗ draft failed: ${d.error.message}`); continue; }
    cost += costOf(d.value.model || DRAFTING_MODEL, d.value.usage);
    draftResults.push(d.value);
    const words = d.value.draft.proposal.trim().split(/\s+/).length;
    console.log(`${d.value.failures.length ? '✗' : ' '}${pad(d.value.id, 11)}${words} words  ${d.value.failures.join('; ') || 'passed'}`);
    console.log(`   observation: ${d.value.draft.specific_observation}`);
    console.log(`   rate note:   ${d.value.draft.rate_note}`);
  }
}

/* -------------------------------------------------------------------- output */

const outDir = join(ROOT, 'tests/evals/results');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifact = {
  ran_at: new Date().toISOString(),
  scoring_model: SCORING_MODEL,
  drafting_model: draftSample ? DRAFTING_MODEL : null,
  threshold: SCORE_THRESHOLD,
  json_mode: SCORING_JSON_MODE,
  accuracy,
  false_negatives: falseNeg.map((r) => r.id),
  false_positives: falsePos.map((r) => r.id),
  cost_usd: cost,
  results,
  drafts: draftResults.map((d) => ({ id: d.id, failures: d.failures, proposal: d.draft.proposal })),
  errors,
};
writeFileSync(join(outDir, `${stamp}.json`), `${JSON.stringify(artifact, null, 2)}\n`);

console.log(`\nactual cost: $${cost.toFixed(4)}`);
console.log(`written: tests/evals/results/${stamp}.json`);

const draftFailures = draftResults.filter((d) => d.failures.length).length;
const fail = accuracy < MIN_ACCURACY
  || falseNeg.length > MAX_FALSE_NEGATIVES
  || errors.length > 0
  || draftFailures > 0;

if (fail) {
  console.log('\nEVAL FAILED');
  if (accuracy < MIN_ACCURACY) console.log(`  accuracy ${(accuracy * 100).toFixed(1)}% < ${MIN_ACCURACY * 100}%`);
  if (falseNeg.length > MAX_FALSE_NEGATIVES) console.log(`  ${falseNeg.length} false negatives > ${MAX_FALSE_NEGATIVES}`);
  if (errors.length) console.log(`  ${errors.length} API errors`);
  if (draftFailures) console.log(`  ${draftFailures} drafts failed structural checks`);
  process.exit(1);
}
console.log('\nEVAL PASSED\n');
