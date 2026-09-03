/**
 * Run the GENERATED n8n Code-node bodies, offline.
 *
 * Every Code node is compiled and executed with stubs for the n8n runtime
 * globals it uses. That buys a syntax check on the inlined output, proof the
 * inlining did not mangle anything, and coverage of the paths that are
 * otherwise only exercised in production: both approval branches, duplicate
 * polls, the recency window, a GraphQL error body, and a failed enrichment.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeUpworkJob } from '../src/normalize-upwork.js';
import { extractInlinedRegions, stripModuleSyntax } from '../scripts/lib/inline.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const loadWf = (f) => JSON.parse(readFileSync(join(root, 'workflows', f), 'utf8'));

const wf1 = loadWf('wf1.poll-qualify-draft.json');
const wf3 = loadWf('wf3.health-check.json');
const wfErr = loadWf('wf-error.failure-ping.json');
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'upwork-search.json'), 'utf8'));

const bodyOf = (wf, nodeName) => {
  const n = wf.nodes.find((x) => x.name === nodeName);
  if (!n) throw new Error(`no node named ${nodeName} in ${wf.name}`);
  return n.parameters.jsCode;
};

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
  return new Function('$input', '$getWorkflowStaticData', '$', 'console', body)(
    $input, () => state, $, console,
  );
}

const searchItem = (key = 'n8n') => ({ json: { search_key: key, query: 'n8n automation' } });
const scoreResponse = (score) => ({
  content: [{
    type: 'text',
    text: JSON.stringify({
      score, verdict: score >= 70 ? 'qualify' : 'reject', reasoning: 'Because.', red_flags: [],
    }),
  }],
});
const job = () => normalizeUpworkJob(fixture.jobs[1]);

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
    for (const wf of [wf1, wf3]) {
      for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
        for (const [rel, inlined] of Object.entries(extractInlinedRegions(n.parameters.jsCode))) {
          if (rel === 'context/') continue;
          const onDisk = stripModuleSyntax(readFileSync(join(root, rel), 'utf8'), rel);
          expect(inlined, `${n.name} / ${rel}`).toBe(onDisk);
        }
      }
    }
  });

  it('carries no real secrets into the artifact', () => {
    const json = JSON.stringify([wf1, wf3, wfErr]);
    expect(json).not.toMatch(/sk-ant-/);
    expect(json).not.toMatch(/xoxb-/);
    expect(json).toMatch(/REPLACE_ME|REPLACE-ME/);
  });

  it('polls on the interval declared in thresholds, not a hardcoded one', () => {
    const trigger = wf1.nodes.find((n) => n.name === 'Poll Upwork');
    expect(trigger.parameters.rule.interval[0].minutesInterval).toBe(10);
  });

  it('sends the org id and OAuth2 credential on both Upwork calls', () => {
    for (const name of ['Upwork: search', 'Upwork: job detail']) {
      const n = wf1.nodes.find((x) => x.name === name);
      expect(n.parameters.url).toBe('https://api.upwork.com/graphql');
      expect(n.parameters.genericAuthType).toBe('oAuth2Api');
      expect(n.parameters.headerParameters.parameters.map((p) => p.name))
        .toContain('X-Upwork-API-TenantId');
      expect(n.retryOnFail).toBe(true);
    }
  });

  it('wires the approval branch to enrich-then-draft on true and skip on false', () => {
    const approved = wf1.connections['Approved?'].main;
    expect(approved[0][0].node).toBe('Fetch full posting');
    expect(approved[1][0].node).toBe('Mark skipped');
  });

  it('sets the approval window from thresholds so a Friday post survives', () => {
    const ask = wf1.nodes.find((n) => n.name === 'Ask: draft or skip?');
    expect(ask.parameters.options.resumeAmount).toBe(72);
    expect(ask.parameters.approvalOptions.values.approveLabel).toBe('Draft proposal');
  });
});

describe('Build searches node', () => {
  it('emits one request per configured niche, with the server-side filters', () => {
    const out = runNode(bodyOf(wf1, 'Build searches'));
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.json.search_key)).toEqual(['n8n', 'claude-code']);
    const vars = out[0].json.requestBody.variables.request;
    expect(vars.paymentVerified_eq).toBe(true);
    expect(vars.proposalRange.rangeEnd).toBe(40);
    expect(vars.sortAttributes[0].field).toBe('RECENCY');
  });
});

describe('Normalize & dedupe node', () => {
  const body = bodyOf(wf1, 'Normalize & dedupe');
  const run = (state, response = fixture) => runNode(body, {
    items: [{ json: response }],
    state,
    nodes: { 'Build searches': [searchItem()] },
  });

  it('normalizes a search response and marks every job seen', () => {
    const state = {};
    const out = run(state);
    expect(out).toHaveLength(6);
    expect(out[0].json.client_summary).toContain('per hire');
    expect(Object.keys(state.jobs)).toHaveLength(6);
    expect(out[0].json.search_key).toBe('n8n');
  });

  it('emits nothing on a second identical poll', () => {
    const state = {};
    run(state);
    expect(run(state)).toEqual([]);
    expect(Object.keys(state.jobs)).toHaveLength(6);
  });

  it('advances the high-water mark so the window cannot grow forever', () => {
    const state = {};
    run(state);
    expect(state.high_water.n8n).toBe('2026-09-03T20:06:31+0000');
  });

  it('drops jobs published at or before the mark', () => {
    const state = { high_water: { n8n: '2026-09-03T19:00:00+0000' } };
    const out = run(state);
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.json.published_date > '2026-09-03T19:00:00+0000')).toBe(true);
  });

  it('throws on a GraphQL error body rather than scoring junk', () => {
    expect(() => run({}, { errors: [{ message: "Cannot query field 'totalFeedback'" }] }))
      .toThrow(/totalFeedback/);
  });

  it('returns [] for an empty result set without failing the execution', () => {
    expect(run({}, { data: { marketplaceJobPostings: { edges: [] } } })).toEqual([]);
  });
});

describe('scoring path', () => {
  it('Build score request produces a Haiku body carrying the client signals', () => {
    const out = runNode(bodyOf(wf1, 'Build score request'), { items: [{ json: job() }] });
    const req = out[0].json.requestBody;
    expect(req.model).toBe('claude-haiku-4-5');
    expect(req.system).toContain('Spend per hire is the sharpest client signal');
    expect(req.messages[0].content).toContain('per hire');
    expect(req.messages[0].content).toContain('Skills tagged:');
  });

  it('tells the model a truncated snippet is not vague scope', () => {
    const out = runNode(bodyOf(wf1, 'Build score request'), { items: [{ json: job() }] });
    expect(out[0].json.requestBody.messages[0].content)
      .toContain('Do not treat the truncation as vague scope');
  });

  it('Parse score qualifies, writes state and renders the card', () => {
    const state = { jobs: { [job().job_id]: { status: 'seen', first_seen: 1 } } };
    const out = runNode(bodyOf(wf1, 'Parse score'), {
      items: [{ json: scoreResponse(84) }],
      state,
      nodes: { 'Build score request': [{ json: job() }] },
    });
    expect(out[0].json.qualified).toBe(true);
    expect(out[0].json.card).toContain('*84/100*');
    expect(state.jobs[job().job_id].status).toBe('qualified');
  });

  it('Parse score rejects below threshold', () => {
    const state = { jobs: { [job().job_id]: { status: 'seen', first_seen: 1 } } };
    const out = runNode(bodyOf(wf1, 'Parse score'), {
      items: [{ json: scoreResponse(31) }],
      state,
      nodes: { 'Build score request': [{ json: job() }] },
    });
    expect(out[0].json.qualified).toBe(false);
    expect(state.jobs[job().job_id].status).toBe('rejected');
  });

  it('Parse score throws on a refusal so the error workflow fires', () => {
    expect(() => runNode(bodyOf(wf1, 'Parse score'), {
      items: [{ json: { stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] } }],
      state: { jobs: { [job().job_id]: { status: 'seen', first_seen: 1 } } },
      nodes: { 'Build score request': [{ json: job() }] },
    })).toThrow(/refused/);
  });
});

describe('resume paths', () => {
  const scored = () => ({
    ...job(),
    score: { score: 84, verdict: 'qualify', reasoning: 'Because.', red_flags: [] },
  });

  it('Draft approved: carries the job and requests the full posting', () => {
    const carry = runNode(bodyOf(wf1, 'Carry approval'), {
      items: [{ json: { data: { approved: true } } }],
      nodes: { 'Parse score': [{ json: scored() }] },
    });
    expect(carry[0].json.approved).toBe(true);

    const detail = runNode(bodyOf(wf1, 'Fetch full posting'), { items: carry });
    expect(detail[0].json.requestBody.variables.id).toBe(job().job_id);
  });

  it('Merge full posting replaces the snippet and clears the truncation flag', () => {
    const carried = { job: job(), score: { score: 84 } };
    const full = 'The complete posting text, well past two hundred and fifty characters.';
    const out = runNode(bodyOf(wf1, 'Merge full posting'), {
      items: [{
        json: {
          data: {
            marketplaceJobPosting: {
              description: `<untrusted_participant_content>${full}</untrusted_participant_content>`,
              preferredQualifications: { minJobSuccessScore: 90 },
            },
          },
        },
      }],
      nodes: { 'Fetch full posting': [{ json: carried }] },
    });
    expect(out[0].json.job.description).toBe(full);
    expect(out[0].json.job.description_truncated).toBe(false);
    expect(out[0].json.job.preferred_qualifications.minJobSuccessScore).toBe(90);
  });

  it('a failed enrichment degrades the draft instead of blocking it', () => {
    const carried = { job: job(), score: { score: 84 } };
    const out = runNode(bodyOf(wf1, 'Merge full posting'), {
      items: [{ json: { errors: [{ message: 'not found' }] } }],
      nodes: { 'Fetch full posting': [{ json: carried }] },
    });
    expect(out[0].json.job.description_truncated).toBe(true);
    expect(out[0].json.job.description).toBe(job().description);
  });

  it('Build draft request caches the context prefix and keeps the job out of it', () => {
    const req = runNode(bodyOf(wf1, 'Build draft request'), {
      items: [{ json: { job: job(), score: { score: 84 } } }],
    });
    const body = req[0].json.requestBody;
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[0].text).not.toContain(job().title);
    expect(body.messages[0].content).toContain(job().title);
  });

  it('Skip: routes to Mark skipped and records it', () => {
    const carry = runNode(bodyOf(wf1, 'Carry approval'), {
      items: [{ json: { data: { approved: false } } }],
      nodes: { 'Parse score': [{ json: scored() }] },
    });
    const state = { jobs: { [job().job_id]: { status: 'qualified', first_seen: 1 } } };
    const out = runNode(bodyOf(wf1, 'Mark skipped'), { items: carry, state });
    expect(out[0].json.status).toBe('skipped');
    expect(state.jobs[job().job_id].status).toBe('skipped');
  });

  it('Parse draft stores the proposal and flags check failures', () => {
    const draftText = `You mentioned the ecommerce automation system. ${'word '.repeat(140)}`;
    const state = { jobs: { [job().job_id]: { status: 'qualified', first_seen: 1 } } };
    const out = runNode(bodyOf(wf1, 'Parse draft'), {
      items: [{
        json: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              proposal: draftText, specific_observation: 'ecommerce', rate_note: '$120/hr',
            }),
          }],
        },
      }],
      state,
      nodes: { 'Build draft request': [{ json: { job: job(), score: { score: 84 } } }] },
    });
    expect(state.jobs[job().job_id].status).toBe('drafted');
    expect(out[0].json.message).toContain('Draft proposal');
    expect(out[0].json.warnings).toEqual([]);
  });

  it('Parse draft surfaces a banned opener rather than hiding it', () => {
    const bad = `I hope this message finds you well. Ecommerce automation. ${'word '.repeat(140)}`;
    const out = runNode(bodyOf(wf1, 'Parse draft'), {
      items: [{ json: { content: [{ type: 'text', text: JSON.stringify({ proposal: bad, rate_note: 'x' }) }] } }],
      state: { jobs: { [job().job_id]: { status: 'qualified', first_seen: 1 } } },
      nodes: { 'Build draft request': [{ json: { job: job(), score: { score: 84 } } }] },
    });
    expect(out[0].json.warnings.join(' ')).toMatch(/banned opener/);
  });
});

describe('WF3 canary and error workflow', () => {
  it('builds a real search rather than counting executions', () => {
    const out = runNode(bodyOf(wf3, 'Build canary search'));
    expect(out[0].json.requestBody.variables.request.searchExpression_eq).toBeTruthy();
  });

  it('is healthy when the canary search returns jobs', () => {
    const out = runNode(bodyOf(wf3, 'Evaluate health'), { items: [{ json: fixture }] });
    expect(out[0].json.unhealthy).toBe(false);
    expect(out[0].json.jobsSeen).toBe(6);
  });

  it('alerts when the search comes back empty', () => {
    const out = runNode(bodyOf(wf3, 'Evaluate health'), {
      items: [{ json: { data: { marketplaceJobPostings: { edges: [] } } } }],
    });
    expect(out[0].json.unhealthy).toBe(true);
    expect(out[0].json.message).toContain('may be broken');
  });

  it('names the rejected field when GraphQL breaks under us', () => {
    const out = runNode(bodyOf(wf3, 'Evaluate health'), {
      items: [{ json: { errors: [{ message: "Cannot query field 'totalFeedback' on type 'Client'" }] } }],
    });
    expect(out[0].json.unhealthy).toBe(true);
    expect(out[0].json.message).toContain('totalFeedback');
    expect(out[0].json.message).toContain('src/upwork-query.js');
  });

  it('formats a failure ping with workflow, node, error and link', () => {
    const out = runNode(bodyOf(wfErr, 'Format failure'), {
      items: [{
        json: {
          workflow: { name: 'WF1 — Poll, Qualify & Draft' },
          execution: {
            lastNodeExecuted: 'Upwork: search',
            error: { message: '401 Unauthorized' },
            url: 'https://x.app.n8n.cloud/execution/42',
          },
        },
      }],
    });
    expect(out[0].json.message).toContain('Upwork: search');
    expect(out[0].json.message).toContain('401');
    expect(out[0].json.message).toContain('/execution/42');
  });
});
