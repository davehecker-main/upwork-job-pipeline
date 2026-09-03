#!/usr/bin/env node
/**
 * One scheduled pass: discover jobs through Upwork's MCP server, score them,
 * post the survivors to Slack.
 *
 * Discovery shells out to `claude -p` because the Upwork MCP connection lives
 * in Claude Code - that is what holds the OAuth token (macOS Keychain) and
 * refreshes it. Everything after discovery is plain Node against the same
 * tested modules.
 *
 * Usage:
 *   node scripts/poll.mjs                  # dry run: score and print
 *   node scripts/poll.mjs --post           # ...and post cards to #upwork-jobs
 *   node scripts/poll.mjs --post --test    # ...to #upwork-jobs-test instead
 */

import { requireEnv, loadEnv } from './lib/env.mjs';
import { searchJobs } from './lib/mcp.mjs';
import { scoreResponse, postCards, loadState } from './lib/pipeline.mjs';
import { SEARCH_QUERIES, SEARCH_FILTERS } from '../src/thresholds.js';

loadEnv();
const args = process.argv.slice(2);
const post = args.includes('--post');
const useTest = args.includes('--test');

const orgUid = requireEnv('UPWORK_ORG_UID', 'Your freelancer org_uid.');
const apiKey = requireEnv('ANTHROPIC_API_KEY');

const state = loadState();
const jobs = [];
let failures = 0;

for (const search of SEARCH_QUERIES) {
  process.stdout.write(`\n[${search.key}] searching Upwork… `);
  try {
    const response = searchJobs(search.query, orgUid, SEARCH_FILTERS);
    const found = (response.jobs || []).length;
    console.log(`${found} results`);
    jobs.push(...(response.jobs || []));
  } catch (error) {
    failures += 1;
    console.log(`FAILED\n  ${String(error.message).slice(0, 300)}`);
  }
}

if (failures === SEARCH_QUERIES.length) {
  // Every search failed: almost always an expired MCP token. Say so loudly -
  // this is the silent-failure mode the old health check existed to catch.
  console.error('\nAll searches failed. The Upwork MCP token has most likely expired:');
  console.error('  run `claude` interactively, then /mcp -> upwork -> reauthenticate.\n');
  process.exit(1);
}

console.log('');
const result = await scoreResponse({ jobs }, apiKey, { state });
console.log(`\n${result.qualified.length} passed the threshold · scoring cost $${result.cost.toFixed(4)}`);

if (!post) {
  console.log('(dry run — pass --post to send cards to Slack)\n');
  process.exit(0);
}

if (!result.qualified.length) {
  console.log('nothing to post\n');
  process.exit(0);
}

const token = requireEnv('SLACK_BOT_TOKEN');
const channel = useTest ? requireEnv('SLACK_TEST_CHANNEL') : requireEnv('SLACK_CHANNEL');
await postCards(result.qualified, { token, channel, state: result.state || state });
console.log('');
