#!/usr/bin/env node
/**
 * Score a saved Upwork search response, without touching the network for
 * discovery. Useful for testing rubric changes against a captured response, or
 * for replaying a poll that failed after discovery.
 *
 * Usage:
 *   node scripts/run-once.mjs <search-response.json> [--post] [--test]
 */

import { existsSync, readFileSync } from 'node:fs';
import { requireEnv, loadEnv } from './lib/env.mjs';
import { scoreResponse, postCards, loadState } from './lib/pipeline.mjs';

loadEnv();
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const post = args.includes('--post');
const useTest = args.includes('--test');

if (!file || !existsSync(file)) {
  console.error('\nusage: node scripts/run-once.mjs <search-response.json> [--post] [--test]\n');
  process.exit(2);
}

const apiKey = requireEnv('ANTHROPIC_API_KEY');
const state = loadState();
const response = JSON.parse(readFileSync(file, 'utf8'));

console.log('');
const result = await scoreResponse(response, apiKey, { state });
console.log(`\n${result.qualified.length} passed the threshold · scoring cost $${result.cost.toFixed(4)}`);

if (!post || !result.qualified.length) {
  console.log(post ? 'nothing to post\n' : '(dry run — pass --post to send cards to Slack)\n');
  process.exit(0);
}

await postCards(result.qualified, {
  token: requireEnv('SLACK_BOT_TOKEN'),
  channel: useTest ? requireEnv('SLACK_TEST_CHANNEL') : requireEnv('SLACK_CHANNEL'),
  state: result.state || state,
});
console.log('');
