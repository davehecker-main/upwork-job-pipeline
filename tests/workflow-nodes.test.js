/**
 * Run the GENERATED n8n Code-node bodies, offline.
 *
 * Every Code node is compiled and executed here with stubs for the n8n runtime
 * globals it uses. That buys three things without an n8n instance: a syntax
 * check on the inlined output, proof that the inlining itself did not mangle
 * anything, and coverage of both resume paths (Draft approved / Skip) plus the
 * duplicate and no-jobs cases.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';
import { normalizeJob } from '../src/normalize.js';
import { extractInlinedRegions, stripModuleSyntax } from '../scripts/lib/inline.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const loadWf = (f) => JSON.parse(readFileSync(join(root, 'workflows', f), 'utf8'));

const wf1 = loadWf('wf1.ingest-qualify-draft.json');
const wf3 = loadWf('wf3.health-check.json');
const wfErr = loadWf('wf-error.failure-ping.json');

const bodyOf = (wf, nodeName) => {
  const n = wf.nodes.find((x) => x.name === nodeName);
  if (!n) throw new Error(`no node named ${nodeName} in ${wf.name}`);
  return n.parameters.jsCode;
};

/** Compile a Code-node body with the n8n globals it is allowed to use. */
function runNode(body, { items = [], state = {}, nodes = {} } = {}) {
  const $input = {
    all: () => items,
    first: () => items[0],
    last: () => items[items.length - 1],
  };
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`node body referenced $('${name}') which the test did not stub`);
    const list = nodes[name];
    return { all: () => list, first: () => list[0], last: () => list[list.length - 1] };
  };
  const fn = new Function('$input', '$getWorkflowStaticData', '$', 'console', body);
  return fn($input, () => state, $, console);
}

const scoreResponse = (score) => ({
  content: [{
    type: 'text',
    text: JSON.stringify({
      score, verdict: score >= 70 ? 'qualify' : 'reject', reasoning: 'Because.', red_flags: [],
    }),
  }],
});

const job = () => normalizeJob({
  job_id: '01abc',
  url: 'https://www.upwork.com/jobs/x_~01abc',
  title: 'n8n workflow to sync Airtable and HubSpot',
  description: 'We need an n8n workflow that watches Airtable and creates HubSpot deals without duplicates.',
  budget_type: 'hourly',
  budget_hourly_min: 45,
  budget_hourly_max: 80,
  client_payment_verified: true,
  client_total_spent: 47300,
  client_hires: 31,
  client_rating: 4.9,
});

describe('generated artifact hygiene', () => {
  it('every Code node compiles', () => {
    for (const wf of [wf1, wf3, wfErr]) {
      for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
        expect(() => new Function('$input', '$getWorkflowStaticData', '$', n.parameters.jsCode),
          `${wf.name} / ${n.name}`).not.toThrow();
      }
    }
  });

  it('no module syntax survives inlining', () => {
    for (const wf of [wf1, wf3, wfErr]) {
      for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
        expect(n.parameters.jsCode, `${wf.name} / ${n.name}`).not.toMatch(/^export\s/m);
        expect(n.parameters.jsCode, `${wf.name} / ${n.name}`).not.toMatch(/^import\s/m);
      }
    }
  });

  it('inlined regions match the modules on disk byte for byte', () => {
    for (const n of wf1.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
      for (const [rel, inlined] of Object.entries(extractInlinedRegions(n.parameters.jsCode))) {
        if (rel === 'context/') continue;
        const onDisk = stripModuleSyntax(readFileSync(join(root, rel), 'utf8'), rel);
        expect(inlined, `${n.name} / ${rel}`).toBe(onDisk);
      }
    }
  });

  it('carries no real secrets into the artifact', () => {
    const json = JSON.stringify([wf1, wf3, wfErr]);
    expect(json).not.toMatch(/sk-ant-/);
    expect(json).not.toMatch(/xoxb-/);
    expect(json).toMatch(/REPLACE_ME|REPLACE-ME/); // credentials are placeholders
  });

  it('wires the approval branch to draft on true and skip on false', () => {
    const approved = wf1.connections['Approved?'].main;
    expect(approved[0][0].node).toBe('Build draft request');
    expect(approved[1][0].node).toBe('Mark skipped');
  });

  it('sets a 72h approval window so a Friday post survives the weekend', () => {
    const ask = wf1.nodes.find((n) => n.name === 'Ask: draft or skip?');
    expect(ask.parameters.options.resumeAmount).toBe(72);
    expect(ask.parameters.approvalOptions.values.approveLabel).toBe('Draft proposal');
  });

  it('retries the Anthropic calls rather than dropping a job on a blip', () => {
    for (const name of ['Score (Haiku)', 'Draft (Sonnet)']) {
      const n = wf1.nodes.find((x) => x.name === name);
      expect(n.retryOnFail).toBe(true);
      expect(n.maxTries).toBe(3);
    }
  });
});

describe('Parse & dedupe node', () => {
  const body = bodyOf(wf1, 'Parse & dedupe');
  const imapItem = (file) => ({
    json: { subject: 'Vollna alert', textHtml: readFileSync(join(here, 'fixtures', file), 'utf8') },
  });

  it('turns one alert email into normalized job items and marks them seen', () => {
    const state = {};
    const out = runNode(body, { items: [imapItem('single-job.html')], state });
    expect(out).toHaveLength(1);
    expect(out[0].json.job_id).toBe('021847392017465829301');
    expect(out[0].json.budget_display).toBe('$45-$80/hr');
    expect(state.jobs['021847392017465829301'].status).toBe('seen');
  });

  it('emits nothing the second time the same alert arrives', () => {
    const state = {};
    runNode(body, { items: [imapItem('single-job.html')], state });
    const second = runNode(body, { items: [imapItem('single-job.html')], state });
    expect(second).toEqual([]);
    expect(Object.keys(state.jobs)).toHaveLength(1);
  });

  it('fans a digest out into three items', () => {
    const state = {};
    expect(runNode(body, { items: [imapItem('digest-three-jobs.html')], state })).toHaveLength(3);
  });

  it('returns [] for an alert with no jobs instead of failing the execution', () => {
    expect(runNode(body, { items: [imapItem('malformed-no-jobs.html')], state: {} })).toEqual([]);
  });

  it('reads the alternative IMAP field names some node versions emit', () => {
    const html = readFileSync(join(here, 'fixtures', 'single-job.html'), 'utf8');
    const out = runNode(body, { items: [{ json: { Subject: 's', html } }], state: {} });
    expect(out).toHaveLength(1);
  });
});

describe('scoring path', () => {
  it('Build score request produces a Haiku request body per job', () => {
    const out = runNode(bodyOf(wf1, 'Build score request'), { items: [{ json: job() }] });
    expect(out[0].json.requestBody.model).toBe('claude-haiku-4-5');
    expect(out[0].json.requestBody.system).toContain('Client credibility');
    expect(out[0].json.requestBody.messages[0].content).toContain('Airtable');
  });

  it('Parse score qualifies a high score, writes state, and renders the card', () => {
    const state = { jobs: { '01abc': { status: 'seen', first_seen: 1 } } };
    const out = runNode(bodyOf(wf1, 'Parse score'), {
      items: [{ json: scoreResponse(84) }],
      state,
      nodes: { 'Build score request': [{ json: job() }] },
    });
    expect(out[0].json.qualified).toBe(true);
    expect(out[0].json.card).toContain('*84/100*');
    expect(state.jobs['01abc'].status).toBe('qualified');
    expect(state.jobs['01abc'].score).toBe(84);
  });

  it('Parse score rejects below the threshold and records why', () => {
    const state = { jobs: { '01abc': { status: 'seen', first_seen: 1 } } };
    const out = runNode(bodyOf(wf1, 'Parse score'), {
      items: [{ json: scoreResponse(31) }],
      state,
      nodes: { 'Build score request': [{ json: job() }] },
    });
    expect(out[0].json.qualified).toBe(false);
    expect(state.jobs['01abc'].status).toBe('rejected');
    expect(state.jobs['01abc'].reasoning).toBe('Because.');
  });

  it('Parse score throws on a refusal so the error workflow fires', () => {
    expect(() => runNode(bodyOf(wf1, 'Parse score'), {
      items: [{ json: { stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] } }],
      state: { jobs: { '01abc': { status: 'seen', first_seen: 1 } } },
      nodes: { 'Build score request': [{ json: job() }] },
    })).toThrow(/refused/);
  });
});

describe('resume paths', () => {
  const scored = () => ({ ...job(), score: { score: 84, verdict: 'qualify', reasoning: 'Because.', red_flags: [] } });

  it('Draft approved: carries the job through and builds a Sonnet request', () => {
    const carry = runNode(bodyOf(wf1, 'Carry approval'), {
      items: [{ json: { data: { approved: true } } }],
      nodes: { 'Parse score': [{ json: scored() }] },
    });
    expect(carry[0].json.approved).toBe(true);

    const req = runNode(bodyOf(wf1, 'Build draft request'), { items: carry });
    expect(req[0].json.requestBody.model).toBe('claude-sonnet-5');
    expect(req[0].json.requestBody.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(req[0].json.requestBody.output_config.effort).toBe('low');
  });

  it('Skip: carries approved=false so the IF routes to Mark skipped', () => {
    const carry = runNode(bodyOf(wf1, 'Carry approval'), {
      items: [{ json: { data: { approved: false } } }],
      nodes: { 'Parse score': [{ json: scored() }] },
    });
    expect(carry[0].json.approved).toBe(false);

    const state = { jobs: { '01abc': { status: 'qualified', first_seen: 1 } } };
    const out = runNode(bodyOf(wf1, 'Mark skipped'), { items: carry, state });
    expect(out[0].json.status).toBe('skipped');
    expect(state.jobs['01abc'].status).toBe('skipped');
  });

  it('Parse draft stores the proposal, renders Slack copy, and flags check failures', () => {
    const carried = { job: job(), score: { score: 84 } };
    const draftText = `You mentioned Airtable is already the source of truth. ${'word '.repeat(140)}`;
    const state = { jobs: { '01abc': { status: 'qualified', first_seen: 1 } } };

    const out = runNode(bodyOf(wf1, 'Parse draft'), {
      items: [{
        json: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              proposal: draftText, specific_observation: 'Airtable', rate_note: '$85/hr',
            }),
          }],
        },
      }],
      state,
      nodes: { 'Build draft request': [{ json: carried }] },
    });

    expect(state.jobs['01abc'].status).toBe('drafted');
    expect(state.jobs['01abc'].proposal).toContain('Airtable');
    expect(out[0].json.message).toContain('Draft proposal');
    expect(out[0].json.warnings).toEqual([]);
  });

  it('Parse draft surfaces a banned opener as a warning instead of hiding it', () => {
    const bad = `I hope this message finds you well. Airtable. ${'word '.repeat(140)}`;
    const out = runNode(bodyOf(wf1, 'Parse draft'), {
      items: [{ json: { content: [{ type: 'text', text: JSON.stringify({ proposal: bad, rate_note: 'x' }) }] } }],
      state: { jobs: { '01abc': { status: 'qualified', first_seen: 1 } } },
      nodes: { 'Build draft request': [{ json: { job: job(), score: { score: 84 } } }] },
    });
    expect(out[0].json.warnings.join(' ')).toMatch(/banned opener/);
    expect(out[0].json.message).toMatch(/draft checks/);
  });
});

describe('WF3 and error workflow', () => {
  it('flags an unhealthy pipeline when no executions land in the window', () => {
    const out = runNode(bodyOf(wf3, 'Evaluate health'), { items: [{ json: { data: [] } }] });
    expect(out[0].json.unhealthy).toBe(true);
    expect(out[0].json.message).toContain('may be broken');
  });

  it('stays quiet when executions did land in the window', () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const out = runNode(bodyOf(wf3, 'Evaluate health'), {
      items: [{ json: { data: [{ startedAt: recent }, { startedAt: recent }] } }],
    });
    expect(out[0].json.unhealthy).toBe(false);
    expect(out[0].json.jobsLast24h).toBe(2);
  });

  it('ignores executions older than the window', () => {
    const old = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const out = runNode(bodyOf(wf3, 'Evaluate health'), { items: [{ json: { data: [{ startedAt: old }] } }] });
    expect(out[0].json.unhealthy).toBe(true);
  });

  it('formats a failure ping with workflow, node, error and a link', () => {
    const out = runNode(bodyOf(wfErr, 'Format failure'), {
      items: [{
        json: {
          workflow: { name: 'WF1 — Ingest, Qualify & Draft' },
          execution: {
            lastNodeExecuted: 'Score (Haiku)',
            error: { message: 'connect ETIMEDOUT' },
            url: 'https://x.app.n8n.cloud/execution/42',
          },
        },
      }],
    });
    expect(out[0].json.message).toContain('WF1');
    expect(out[0].json.message).toContain('Score (Haiku)');
    expect(out[0].json.message).toContain('ETIMEDOUT');
    expect(out[0].json.message).toContain('/execution/42');
  });

  it('formats a failure ping even when the trigger payload is sparse', () => {
    const out = runNode(bodyOf(wfErr, 'Format failure'), { items: [{ json: {} }] });
    expect(out[0].json.message).toContain('unknown');
  });
});
