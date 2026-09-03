#!/usr/bin/env node
/**
 * Prove each credential in .env actually works, before any of them get wired
 * into n8n. Every failure here is far cheaper to diagnose than the same
 * failure inside a workflow execution.
 *
 * Usage: node scripts/verify-creds.mjs
 * Costs about $0.00002 (one 8-token Haiku call).
 */

import { execFileSync } from 'node:child_process';
import { loadEnv } from './lib/env.mjs';

loadEnv();
const env = process.env;
let failures = 0;

const ok = (label, detail) => console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, detail) => { failures += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); };
const skip = (label, detail) => console.log(`  ⏭️  ${label}${detail ? ` — ${detail}` : ''}`);

/* ------------------------------------------------------------- Anthropic */

console.log('\nAnthropic API key');
if (!env.ANTHROPIC_API_KEY) {
  skip('not set', 'console.anthropic.com → API keys');
} else {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      }),
    });
    const body = await res.json();
    if (res.ok) ok('key works', `model ${body.model}`);
    else if (res.status === 401) bad('key rejected', 'wrong or revoked key');
    else if (res.status === 400 && /credit/i.test(JSON.stringify(body))) bad('no credit', 'Plans & Billing → Buy credits');
    else bad(`HTTP ${res.status}`, JSON.stringify(body).slice(0, 200));
  } catch (e) {
    bad('network error', e.message);
  }
}

/* ----------------------------------------------------------------- Slack */

console.log('\nSlack bot token');
if (!env.SLACK_BOT_TOKEN) {
  skip('not set', 'SLACK_BOT_TOKEN (xoxb-…) from OAuth & Permissions after Install');
} else {
  const call = async (method, params = {}) => {
    const res = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
      headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
    return res.json();
  };
  const auth = await call('auth.test');
  if (!auth.ok) {
    bad('token rejected', auth.error);
  } else {
    ok('token works', `${auth.team} as @${auth.user}`);
    const scopes = (await fetch('https://slack.com/api/auth.test', {
      method: 'POST', headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    })).headers?.get?.('x-oauth-scopes');
    if (scopes) {
      const missing = ['chat:write', 'channels:read'].filter((s) => !scopes.split(',').includes(s));
      if (missing.length) bad('missing scopes', missing.join(', '));
      else ok('scopes present', 'chat:write, channels:read');
    }
    for (const [label, id] of [['SLACK_CHANNEL', env.SLACK_CHANNEL], ['SLACK_TEST_CHANNEL', env.SLACK_TEST_CHANNEL]]) {
      if (!id) { skip(`${label} not set`, 'run scripts/setup-slack.mjs to create the channels'); continue; }
      const info = await call('conversations.info', { channel: id });
      if (info.ok) ok(`${label} reachable`, `#${info.channel.name}`);
      else bad(`${label} unreachable`, info.error);
    }
  }
}

/* ------------------------------------------------------- Upwork via Claude */

console.log('\nUpwork MCP (through Claude Code)');
try {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('claude', ['mcp', 'list'], { encoding: 'utf8', timeout: 60000 });
  const line = out.split('\n').find((l) => l.trim().startsWith('upwork:'));
  if (!line) {
    bad('not configured', 'claude mcp add --scope user --transport http upwork https://mcp.upwork.com/mcp');
  } else if (/needs authentication/i.test(line)) {
    bad('not authenticated', 'run `claude`, then /mcp -> upwork -> Authenticate');
  } else {
    ok('connected', line.trim().slice(0, 80));
  }
} catch (e) {
  bad('could not run `claude mcp list`', String(e.message).slice(0, 120));
}

if (!env.UPWORK_ORG_UID) skip('UPWORK_ORG_UID not set', 'your freelancer org_uid');
else ok('UPWORK_ORG_UID set', env.UPWORK_ORG_UID);

console.log(failures ? `\n${failures} credential check(s) failed.\n` : '\nAll configured credentials work.\n');
process.exit(failures ? 1 : 0);
