#!/usr/bin/env node
/**
 * Settle one live-API question before the workflow is wired: does the scoring
 * model accept `output_config.format` (structured outputs), or does it need a
 * strict forced tool instead?
 *
 * Run this once, then set SCORING_JSON_MODE in src/thresholds.js to whichever
 * mode passes. Costs about a tenth of a cent.
 *
 * Usage: node scripts/check-json-mode.mjs
 */

import { requireEnv } from './lib/env.mjs';
import { callAnthropic } from './lib/anthropic.mjs';
import { buildScoreRequest, parseScoreResponse } from '../src/score-prompt.js';
import { normalizeJob } from '../src/normalize.js';
import { SCORING_MODEL } from '../src/thresholds.js';

const apiKey = requireEnv('ANTHROPIC_API_KEY');

const job = normalizeJob({
  job_id: 'probe',
  title: 'n8n workflow to sync Airtable and HubSpot',
  description: 'A small, clearly scoped n8n automation for a client with a long hiring history.',
  budget_type: 'fixed',
  budget_fixed: 1500,
  client_payment_verified: true,
  client_total_spent: 50000,
  client_hires: 30,
  client_rating: 4.9,
});
const ctx = { rubric: 'Score fit for n8n automation work. Credible client, clear scope, good fit.' };

for (const mode of ['structured', 'tool']) {
  process.stdout.write(`${SCORING_MODEL} / ${mode}: `);
  try {
    const response = await callAnthropic(
      buildScoreRequest(job, ctx, { model: SCORING_MODEL, mode }), apiKey, { retries: 1 },
    );
    const score = parseScoreResponse(response);
    console.log(`OK  -> score ${score.score}, verdict ${score.verdict}`);
  } catch (error) {
    console.log(`FAILED -> ${error.message.slice(0, 220)}`);
  }
}

console.log('\nSet SCORING_JSON_MODE in src/thresholds.js to a mode that printed OK,');
console.log('then run: node scripts/build-workflow.mjs && ./test.sh\n');
