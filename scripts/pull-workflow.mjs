#!/usr/bin/env node
/**
 * Drift check: does the workflow running in n8n still contain the code in git?
 *
 * Anyone can edit a Code node in the n8n UI. That is the failure mode this
 * catches - it downloads the live workflows, re-extracts the inlined regions
 * from each Code node, and compares them byte for byte against src/ on disk.
 *
 * Skips cleanly (exit 0) when no n8n credentials are configured, so ./test.sh
 * still runs offline.
 *
 * Usage: node scripts/pull-workflow.mjs [--save]
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, extractInlinedRegions, stripModuleSyntax } from './lib/inline.mjs';
import { loadEnv } from './lib/env.mjs';

loadEnv();
const base = process.env.N8N_BASE_URL;
const key = process.env.N8N_API_KEY;
const ids = [
  ['wf1', process.env.N8N_WF1_ID],
  ['wf3', process.env.N8N_WF3_ID],
].filter(([, id]) => id);

if (!base || !key || !ids.length) {
  console.log('drift check skipped: set N8N_BASE_URL, N8N_API_KEY and N8N_WF1_ID in .env to enable it');
  process.exit(0);
}

const save = process.argv.includes('--save');
let mismatches = 0;
let checked = 0;

for (const [label, id] of ids) {
  const res = await fetch(`${base}/api/v1/workflows/${id}`, {
    headers: { 'X-N8N-API-KEY': key, accept: 'application/json' },
  });
  if (!res.ok) {
    console.error(`could not fetch ${label} (${id}): ${res.status} ${await res.text()}`);
    process.exit(2);
  }
  const wf = await res.json();

  if (save) {
    const dir = join(ROOT, 'workflows', '.pulled');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${label}.json`), `${JSON.stringify(wf, null, 2)}\n`);
  }

  for (const node of (wf.nodes || []).filter((n) => n.type === 'n8n-nodes-base.code')) {
    for (const [rel, live] of Object.entries(extractInlinedRegions(node.parameters.jsCode || ''))) {
      if (rel === 'context/') continue; // context is data, compared separately below
      checked += 1;
      const onDisk = stripModuleSyntax(readFileSync(join(ROOT, rel), 'utf8'), rel);
      if (live !== onDisk) {
        mismatches += 1;
        console.error(`DRIFT  ${label} / ${node.name} / ${rel}`);
      }
    }
    const liveContext = extractInlinedRegions(node.parameters.jsCode || '')['context/'];
    if (liveContext) {
      checked += 1;
      const { readContextPack } = await import('./lib/inline.mjs');
      if (liveContext.trim() !== readContextPack().split('\n').slice(1, -1).join('\n').trim()) {
        mismatches += 1;
        console.error(`DRIFT  ${label} / ${node.name} / context pack`);
      }
    }
  }
}

if (mismatches) {
  console.error(`\n${mismatches} of ${checked} inlined regions differ from git.`);
  console.error('Either the n8n UI was edited directly, or a rebuilt workflow was never re-imported.');
  console.error('Fix: bring the change back into src/ (or discard it), then');
  console.error('  node scripts/build-workflow.mjs  and re-import workflows/*.json into n8n.\n');
  process.exit(1);
}
console.log(`drift check passed: ${checked} inlined regions match git`);
