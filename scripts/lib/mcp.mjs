/**
 * Upwork access through Claude Code's authenticated MCP connection.
 *
 * Node cannot speak to the MCP server directly - the OAuth token lives in
 * Claude Code's credential store, which also owns its refresh. So every Upwork
 * read shells out to `claude -p` with --allowed-tools naming exactly the one
 * read-only tool it needs, and nothing else in the Upwork account is reachable
 * from a scheduled run.
 */

import { execFileSync } from 'node:child_process';

/**
 * ANTHROPIC_API_KEY must not reach the child: if it does, `claude`
 * authenticates with that key, billing API credits instead of the subscription
 * and disabling claude.ai connectors. Discovery rides the interactive login
 * that owns the MCP token.
 */
function childEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

function runClaude(prompt, tool) {
  const out = execFileSync('claude', [
    '-p', prompt,
    '--allowed-tools', tool,
    '--permission-mode', 'acceptEdits',
  ], { encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024, env: childEnv() });

  // Claude sometimes fences JSON despite instructions; tolerate that rather
  // than losing a whole poll to a code fence.
  const cleaned = out.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = cleaned.indexOf('{');
  if (start === -1) throw new Error(`no JSON in the output: ${out.slice(0, 200)}`);
  return JSON.parse(cleaned.slice(start));
}

/** One marketplace search. Returns `{ jobs: [...] }`. */
export function searchJobs(query, orgUid, filters = {}) {
  const params = JSON.stringify({ query, ...filters });
  return runClaude([
    `Call the Upwork MCP tool find_jobs with action=search, org_uid=${orgUid},`,
    `params=${params}.`,
    'Then print the tool result as compact JSON: an object with a single "jobs"',
    'key holding the jobs array exactly as returned, every field preserved.',
    'No prose, no markdown fence, no commentary.',
  ].join(' '), 'mcp__upwork__upwork__find_jobs');
}

/**
 * The FULL posting for one job. Search results truncate the description to
 * ~250 characters, which is far too little to write a proposal from - this is
 * what makes a draft specific rather than a guess.
 */
export function getPosting(jobId, orgUid) {
  return runClaude([
    `Call the Upwork MCP tool find_jobs with action=get, org_uid=${orgUid},`,
    `params={"id":"${jobId}"}.`,
    'Then print compact JSON with exactly these keys, taken from the result:',
    '"description" (the complete job description text, not a snippet),',
    '"skills" (array of skill names, or []),',
    '"preferred_qualifications" (object or null),',
    '"questions" (array of screening questions, or []),',
    '"connects_cost" (number or null),',
    '"total_applicants" (number or null).',
    'No prose, no markdown fence, no commentary.',
  ].join(' '), 'mcp__upwork__upwork__find_jobs');
}
