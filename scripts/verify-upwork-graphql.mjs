#!/usr/bin/env node
/**
 * Run both Upwork GraphQL queries against the real API and report exactly
 * which fields it rejects. This is the one step that turns src/upwork-query.js
 * from composed-from-docs into verified.
 *
 * GraphQL reports every unknown field by name, so a failing run is a to-do
 * list, not a mystery.
 *
 * Usage: UPWORK_ACCESS_TOKEN=... node scripts/verify-upwork-graphql.mjs
 */

import { loadEnv, requireEnv } from './lib/env.mjs';
import { GRAPHQL_URL, buildSearchRequest } from '../src/upwork-query.js';
import { jobsFromSearchResponse } from '../src/upwork-query.js';
import { normalizeUpworkJob } from '../src/normalize-upwork.js';
import { SEARCH_QUERIES, SEARCH_FILTERS } from '../src/thresholds.js';

loadEnv();
const token = requireEnv('UPWORK_ACCESS_TOKEN', 'An Upwork OAuth2 access token for api.upwork.com.');
const org = requireEnv('UPWORK_ORG_UID', 'Your freelancer org_uid.');

const body = buildSearchRequest(SEARCH_QUERIES[0], SEARCH_FILTERS);
console.log(`\nPOST ${GRAPHQL_URL}\nquery: ${SEARCH_QUERIES[0].query}\n`);

const res = await fetch(GRAPHQL_URL, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'X-Upwork-API-TenantId': org,
  },
  body: JSON.stringify(body),
});

const text = await res.text();
let payload;
try { payload = JSON.parse(text); } catch { payload = null; }

if (!payload) {
  console.error(`HTTP ${res.status}, unparseable body:\n${text.slice(0, 800)}\n`);
  process.exit(1);
}

if (payload.errors?.length) {
  console.error(`GraphQL rejected ${payload.errors.length} thing(s) — fix these in src/upwork-query.js:\n`);
  for (const e of payload.errors) {
    console.error(`  • ${e.message}`);
    if (e.path) console.error(`    at ${e.path.join('.')}`);
  }
  console.error('');
  process.exit(1);
}

const jobs = jobsFromSearchResponse(payload).map(normalizeUpworkJob);
console.log(`✅ query accepted — ${jobs.length} jobs normalized\n`);
for (const j of jobs.slice(0, 3)) {
  console.log(`  ${j.title}`);
  console.log(`    ${j.budget_display} · ${j.client_summary}`);
  console.log(`    published ${j.published_date} · ${j.url}\n`);
}
const missing = ['title', 'url', 'published_date', 'client_total_spent']
  .filter((k) => jobs.length && jobs[0][k] == null);
if (missing.length) {
  console.log(`⚠️  came back empty for: ${missing.join(', ')} — check the mapping in fromGraphQL()\n`);
}
