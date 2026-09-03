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

/* ------------------------------------------------------------------ IMAP */

console.log('\nGmail IMAP');
if (!env.IMAP_USER || !env.IMAP_PASSWORD) {
  skip('not set', 'IMAP_USER / IMAP_PASSWORD (the 16-char app password)');
} else {
  // No IMAP client in the dependency-free JS here; python3's imaplib is
  // already on macOS and is the shortest honest path to a real login test.
  const py = `
import imaplib, sys
try:
    m = imaplib.IMAP4_SSL(${JSON.stringify(env.IMAP_HOST || 'imap.gmail.com')}, ${Number(env.IMAP_PORT || 993)})
    m.login(sys.argv[1], sys.argv[2])
    boxes = [b.decode().split(' "/" ')[-1].strip('"') for b in (m.list()[1] or [])]
    mailbox = sys.argv[3]
    status, data = m.select(mailbox, readonly=True)
    if status != 'OK':
        print('MAILBOX_MISSING|' + '|'.join(boxes[:40]))
    else:
        print('OK|' + data[0].decode() + '|' + '|'.join(boxes[:40]))
    m.logout()
except imaplib.IMAP4.error as e:
    print('AUTH_FAIL|' + str(e))
except Exception as e:
    print('ERROR|' + str(e))
`;
  try {
    const mailbox = env.IMAP_MAILBOX || 'vollna-alerts';
    const out = execFileSync('python3', ['-c', py, env.IMAP_USER, env.IMAP_PASSWORD.replace(/\s/g, ''), mailbox], {
      encoding: 'utf8', timeout: 30000,
    }).trim();
    const [status, ...rest] = out.split('|');
    if (status === 'OK') {
      ok('login works', `mailbox "${mailbox}" has ${rest[0]} messages`);
      if (rest[0] === '0') console.log('     note: no messages yet — forward a Vollna alert into that label to smoke test');
    } else if (status === 'MAILBOX_MISSING') {
      bad(`mailbox "${mailbox}" not found`, `available: ${rest.filter(Boolean).slice(0, 8).join(', ')}`);
      console.log('     fix: Gmail → search from:(vollna.com) → Create filter → apply label vollna-alerts');
    } else if (status === 'AUTH_FAIL') {
      bad('login rejected', 'app password wrong, or IMAP not enabled in Gmail settings');
    } else {
      bad('error', rest.join('|').slice(0, 200));
    }
  } catch (e) {
    bad('could not run the IMAP check', e.message.slice(0, 200));
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

/* ------------------------------------------------------------------- n8n */

console.log('\nn8n API');
if (!env.N8N_BASE_URL || !env.N8N_API_KEY) {
  skip('not set', 'N8N_BASE_URL / N8N_API_KEY (Settings → n8n API)');
} else {
  try {
    const res = await fetch(`${env.N8N_BASE_URL.replace(/\/$/, '')}/api/v1/workflows?limit=1`, {
      headers: { 'X-N8N-API-KEY': env.N8N_API_KEY, accept: 'application/json' },
    });
    if (res.ok) {
      const body = await res.json();
      ok('API reachable', `${(body.data || []).length ? 'existing workflows found' : 'no workflows yet'}`);
    } else if (res.status === 401) {
      bad('API key rejected', 'regenerate it under Settings → n8n API');
    } else {
      bad(`HTTP ${res.status}`, (await res.text()).slice(0, 200));
    }
  } catch (e) {
    bad('unreachable', `${e.message} — is N8N_BASE_URL right, and the instance running?`);
  }
}

console.log(failures ? `\n${failures} credential check(s) failed.\n` : '\nAll configured credentials work.\n');
process.exit(failures ? 1 : 0);
