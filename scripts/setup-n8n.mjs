#!/usr/bin/env node
/**
 * Wire the whole thing up in n8n over the public API: create the four
 * credentials, push the three workflows with those credentials already
 * attached, cross-link them (WF3 needs WF1's id, WF1 needs the error
 * workflow's id), and activate.
 *
 * This is the step that would otherwise be twenty minutes of clicking through
 * fourteen nodes, and the step most likely to be done slightly differently the
 * second time. Idempotent: ids are recorded in setup/.n8n-ids.json and reused,
 * so re-running updates in place rather than creating duplicates.
 *
 * Usage:
 *   node scripts/setup-n8n.mjs              # create/update, do not activate
 *   node scripts/setup-n8n.mjs --activate   # …and activate WF1 + WF3
 *   node scripts/setup-n8n.mjs --dry-run    # print what it would do
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/inline.mjs';
import { requireEnv, loadEnv } from './lib/env.mjs';

loadEnv();
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const activate = args.includes('--activate');

const base = requireEnv('N8N_BASE_URL', 'Your instance URL, e.g. https://you.app.n8n.cloud').replace(/\/$/, '');
const apiKey = requireEnv('N8N_API_KEY', 'n8n → Settings → n8n API → Create an API key');

const idsPath = join(ROOT, 'setup', '.n8n-ids.json');
const ids = existsSync(idsPath) ? JSON.parse(readFileSync(idsPath, 'utf8')) : { credentials: {}, workflows: {} };
const saveIds = () => {
  // A dry run must never write the id cache: doing so would make the next real
  // run think everything already exists and skip creating any of it.
  if (dryRun) return;
  mkdirSync(join(ROOT, 'setup'), { recursive: true });
  writeFileSync(idsPath, `${JSON.stringify(ids, null, 2)}\n`);
};

async function api(method, path, body) {
  if (dryRun) {
    console.log(`[dry-run] ${method} ${path}${body ? ` (${JSON.stringify(body).length} bytes)` : ''}`);
    return { id: `dry-${path.replace(/\W/g, '')}`, name: 'dry-run' };
  }
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      'X-N8N-API-KEY': apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    // The n8n API's validation messages are specific and worth reading in full
    // rather than summarising - most failures here are one wrong field name.
    throw new Error(`${method} ${path} -> ${res.status}\n${text}`);
  }
  return text ? JSON.parse(text) : {};
}

/* ------------------------------------------------------------- credentials */

/**
 * n8n's public API can create credentials but cannot list them, so identity is
 * tracked locally. Deleting setup/.n8n-ids.json and re-running would create a
 * second copy of each - delete the credentials in the UI first if you do that.
 */
const credentialSpecs = [
  {
    key: 'upwork',
    type: 'oAuth2Api',
    name: 'Upwork OAuth2',
    data: () => ({
      grantType: 'authorizationCode',
      authUrl: 'https://www.upwork.com/ab/account-security/oauth2/authorize',
      accessTokenUrl: 'https://www.upwork.com/api/v3/oauth2/token',
      clientId: requireEnv('UPWORK_CLIENT_ID', 'From your app at upwork.com/developer/apps'),
      clientSecret: requireEnv('UPWORK_CLIENT_SECRET', 'From the same app'),
      scope: '',
      authQueryParameters: '',
      authentication: 'header',
      // n8n owns the refresh cycle from here. This credential is the one thing
      // in the pipeline that needs a human click, once, in the n8n UI.
    }),
  },
  {
    key: 'anthropic',
    type: 'httpHeaderAuth',
    name: 'Anthropic x-api-key (Header Auth)',
    data: () => ({
      name: 'x-api-key',
      value: requireEnv('ANTHROPIC_API_KEY', 'console.anthropic.com → API keys'),
    }),
  },
  {
    key: 'slack',
    type: 'slackApi',
    name: 'Upwork Pipeline bot',
    data: () => ({
      accessToken: requireEnv('SLACK_BOT_TOKEN', 'The xoxb- token from OAuth & Permissions'),
    }),
  },
];

console.log(`\nn8n: ${base}\n`);
console.log('credentials');
for (const spec of credentialSpecs) {
  if (ids.credentials[spec.key]) {
    console.log(`  · ${spec.name} — already created (${ids.credentials[spec.key].id})`);
    continue;
  }
  const created = await api('POST', '/credentials', {
    name: spec.name, type: spec.type, data: spec.data(),
  });
  ids.credentials[spec.key] = { id: created.id, name: spec.name };
  saveIds();
  console.log(`  ✅ ${spec.name} — ${created.id}`);
}

/* ---------------------------------------------------------------- workflows */

const cred = (key) => ({ id: ids.credentials[key].id, name: ids.credentials[key].name });

const load = (file) => JSON.parse(readFileSync(join(ROOT, 'workflows', file), 'utf8'));

/** Attach real credential ids and patch the placeholders the build left behind. */
function prepare(wf, { wf1Id, wfErrorId } = {}) {
  const slackChannel = requireEnv('SLACK_CHANNEL', 'Run scripts/setup-slack.mjs first');

  for (const node of wf.nodes) {
    if (node.credentials?.slackApi) node.credentials.slackApi = cred('slack');
    if (node.credentials?.httpHeaderAuth) {
      // Only the Anthropic key uses Header Auth now - the old n8n-API header
      // credential went away with the execution-counting health check.
      node.credentials.httpHeaderAuth = cred('anthropic');
    }
    if (node.credentials?.oAuth2Api) node.credentials.oAuth2Api = cred('upwork');
    // The org id is baked into the generated artifact; patch it if the build
    // ran without UPWORK_ORG_UID set.
    for (const h of node.parameters?.headerParameters?.parameters || []) {
      if (h.name === 'X-Upwork-API-TenantId' && h.value === 'REPLACE_ME_ORG_UID') {
        h.value = requireEnv('UPWORK_ORG_UID', 'Your freelancer org_uid from list_accounts');
      }
    }
    if (node.parameters?.channelId?.value === 'REPLACE-ME') {
      node.parameters.channelId = { __rl: true, value: slackChannel, mode: 'id' };
    }
    if (node.parameters?.url?.includes('REPLACE-ME')) {
      node.parameters.url = node.parameters.url.replace(/https:\/\/REPLACE-ME\.app\.n8n\.cloud/, base);
    }
    for (const p of node.parameters?.queryParameters?.parameters || []) {
      if (p.value === 'REPLACE_ME_WF1_ID' && wf1Id) p.value = wf1Id;
    }
  }

  if (wf.settings?.errorWorkflow === 'REPLACE_ME_WF_ERROR_ID') {
    if (wfErrorId) wf.settings.errorWorkflow = wfErrorId;
    else delete wf.settings.errorWorkflow;
  }

  // The public API accepts only these fields on create.
  return { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings };
}

async function upsert(key, file, patch = {}) {
  const prepared = prepare(load(file), patch);
  if (ids.workflows[key]) {
    const id = ids.workflows[key];
    await api('PUT', `/workflows/${id}`, prepared);
    console.log(`  ↻ ${prepared.name} — updated (${id})`);
    return id;
  }
  const created = await api('POST', '/workflows', prepared);
  ids.workflows[key] = created.id;
  saveIds();
  console.log(`  ✅ ${prepared.name} — ${created.id}`);
  return created.id;
}

console.log('\nworkflows');
// Order matters: WF1 references the error workflow, WF3 references WF1.
const wfErrorId = await upsert('wfError', 'wf-error.failure-ping.json');
const wf1Id = await upsert('wf1', 'wf1.poll-qualify-draft.json', { wfErrorId });
const wf3Id = await upsert('wf3', 'wf3.health-check.json', { wf1Id });

/* --------------------------------------------------------------- activation */

if (activate) {
  console.log('\nactivation');
  for (const [label, id] of [['WF1', wf1Id], ['WF3', wf3Id]]) {
    try {
      await api('POST', `/workflows/${id}/activate`);
      console.log(`  ✅ ${label} active`);
    } catch (e) {
      console.log(`  ❌ ${label} would not activate:\n${e.message}`);
    }
  }
} else {
  console.log('\nnot activated. Review the workflows in the UI, then re-run with --activate');
}

/* --------------------------------------------------------- write ids to .env */

if (!dryRun) {
  const envPath = join(ROOT, '.env');
  let text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  for (const [key, value] of [['N8N_WF1_ID', wf1Id], ['N8N_WF3_ID', wf3Id]]) {
    text = new RegExp(`^${key}=.*$`, 'm').test(text)
      ? text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`)
      : `${text.replace(/\n*$/, '\n')}${key}=${value}\n`;
  }
  writeFileSync(envPath, text);
  console.log('\nworkflow ids written to .env — the drift check in ./test.sh is now live');
}

console.log(`\nOpen ${base}/workflow/${wf1Id}\n`);
