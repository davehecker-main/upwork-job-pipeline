#!/usr/bin/env node
/**
 * Create (or find) the two Slack channels and write their ids into .env.
 * Idempotent: re-running finds the existing channels instead of failing.
 *
 * Usage: node scripts/setup-slack.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/inline.mjs';
import { requireEnv, loadEnv } from './lib/env.mjs';

loadEnv();
const token = requireEnv('SLACK_BOT_TOKEN', 'Install the app, then copy the xoxb- token from OAuth & Permissions.');

const call = async (method, body) => {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  return res.json();
};

const list = async () => {
  const out = [];
  let cursor;
  do {
    const res = await fetch(
      `https://slack.com/api/conversations.list?${new URLSearchParams({
        // public_channel only: listing private channels needs groups:read, and
        // the two channels this pipeline uses are public by design.
        types: 'public_channel', limit: '200', ...(cursor ? { cursor } : {}),
      })}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const body = await res.json();
    if (!body.ok) throw new Error(`conversations.list: ${body.error}`);
    out.push(...body.channels);
    cursor = body.response_metadata?.next_cursor || '';
  } while (cursor);
  return out;
};

const existing = await list();
const wanted = [
  ['SLACK_CHANNEL', 'upwork-jobs', 'production job cards and drafts'],
  ['SLACK_TEST_CHANNEL', 'upwork-jobs-test', 'headless and smoke-test runs'],
];

const resolved = {};
for (const [envKey, name, purpose] of wanted) {
  const found = existing.find((c) => c.name === name);
  if (found) {
    console.log(`#${name} already exists — ${found.id}`);
    resolved[envKey] = found.id;
    continue;
  }
  const created = await call('conversations.create', { name, is_private: false });
  if (created.ok) {
    console.log(`#${name} created — ${created.channel.id}`);
    resolved[envKey] = created.channel.id;
    await call('conversations.setPurpose', { channel: created.channel.id, purpose });
  } else if (created.error === 'missing_scope') {
    console.error(`\ncannot create #${name}: the bot lacks channels:manage.`);
    console.error('Either add that scope and reinstall, or create the channel in Slack by hand');
    console.error('and re-run this script — it will find it.\n');
    process.exit(1);
  } else {
    console.error(`\nconversations.create failed for #${name}: ${created.error}\n`);
    process.exit(1);
  }
}

/* Write the ids back into .env without disturbing anything else in it. */
const envPath = join(ROOT, '.env');
let text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
for (const [key, value] of Object.entries(resolved)) {
  const line = `${key}=${value}`;
  text = new RegExp(`^${key}=.*$`, 'm').test(text)
    ? text.replace(new RegExp(`^${key}=.*$`, 'm'), line)
    : `${text.replace(/\n*$/, '\n')}${line}\n`;
}
writeFileSync(envPath, text);
console.log('\nchannel ids written to .env');

/* Prove the bot can actually post where it will need to. */
const probe = await call('chat.postMessage', {
  channel: resolved.SLACK_TEST_CHANNEL,
  text: ':white_check_mark: Upwork Pipeline is connected. This is the test channel — job cards go to #upwork-jobs.',
});
if (probe.ok) console.log('posted a confirmation message to #upwork-jobs-test');
else console.error(`could not post to the test channel: ${probe.error}`);
