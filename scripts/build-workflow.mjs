#!/usr/bin/env node
/**
 * Generate the n8n workflow JSON from the modules under src/ and context/.
 *
 * The workflows are build artifacts. Everything interesting - parsing,
 * scoring prompts, thresholds, dedupe, Slack copy - lives in tested modules and
 * is inlined here. Import the generated JSON into n8n once, attach credentials,
 * and from then on a logic change is: edit src/, ./test.sh, re-import.
 *
 * Usage: node scripts/build-workflow.mjs [--n8n-base-url https://x.app.n8n.cloud]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, codeNodeBody } from './lib/inline.mjs';
// Node PARAMETERS need these too, not just the inlined logic - so the poll
// interval and approval window come from the same single source as the runtime.
import { POLL_MINUTES, APPROVAL_TIMEOUT_HOURS } from '../src/thresholds.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const N8N_BASE_URL = flag('n8n-base-url', process.env.N8N_BASE_URL || 'https://REPLACE-ME.app.n8n.cloud');
const SLACK_CHANNEL = flag('slack-channel', process.env.SLACK_CHANNEL || 'REPLACE-ME');
const UPWORK_ORG_UID = flag('upwork-org-uid', process.env.UPWORK_ORG_UID || 'REPLACE_ME_ORG_UID');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

/* ------------------------------------------------------------------ helpers */

let idSeq = 0;
const nextId = () => `node-${(idSeq += 1)}`;

function node(name, type, typeVersion, parameters, position, extra = {}) {
  return { parameters, id: nextId(), name, type, typeVersion, position, ...extra };
}

function codeNode(name, position, modules, logic, opts = {}) {
  return node(name, 'n8n-nodes-base.code', 2, {
    mode: opts.mode || 'runOnceForAllItems',
    jsCode: codeNodeBody(modules, logic, opts),
  }, position, opts.extra || {});
}

/** POST to the Anthropic Messages API. The body is built by the prior Code node. */
function anthropicNode(name, position) {
  return node(name, 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST',
    url: ANTHROPIC_URL,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'anthropic-version', value: '2023-06-01' },
        { name: 'content-type', value: 'application/json' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.requestBody) }}',
    options: { timeout: 120000 },
  }, position, {
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 3000,
    credentials: {
      httpHeaderAuth: { id: 'REPLACE_ME', name: 'Anthropic x-api-key (Header Auth)' },
    },
  });
}

/**
 * POST to Upwork's GraphQL API. The body is built by the prior Code node, and
 * auth is an n8n OAuth2 credential so n8n owns the refresh cycle.
 */
function upworkNode(name, position) {
  return node(name, 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST',
    url: 'https://api.upwork.com/graphql',
    authentication: 'genericCredentialType',
    genericAuthType: 'oAuth2Api',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'X-Upwork-API-TenantId', value: UPWORK_ORG_UID },
        { name: 'content-type', value: 'application/json' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.requestBody) }}',
    options: { timeout: 60000 },
  }, position, {
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 5000,
    credentials: {
      oAuth2Api: { id: 'REPLACE_ME', name: 'Upwork OAuth2' },
    },
  });
}

function slackNode(name, position, parameters, extra = {}) {
  return node(name, 'n8n-nodes-base.slack', 2.3, parameters, position, {
    credentials: { slackApi: { id: 'REPLACE_ME', name: 'Upwork Pipeline bot' } },
    ...extra,
  });
}

function connect(pairs) {
  const connections = {};
  for (const [from, to, outputIndex = 0] of pairs) {
    connections[from] = connections[from] || { main: [] };
    while (connections[from].main.length <= outputIndex) connections[from].main.push([]);
    connections[from].main[outputIndex].push({ node: to, type: 'main', index: 0 });
  }
  return connections;
}

function workflow(name, nodes, connections, settings = {}) {
  return {
    name,
    nodes,
    connections,
    settings: { executionOrder: 'v1', ...settings },
    pinData: {},
    meta: { generatedBy: 'scripts/build-workflow.mjs' },
  };
}

/* ------------------------------------------------------------------- logic */

// One search request per configured niche. Upwork's server-side filters do the
// first pass of the rubric for free - verified payment, proposal ceiling.
const BUILD_SEARCH_LOGIC = `
return SEARCH_QUERIES.map((search) => ({
  json: {
    search_key: search.key,
    query: search.query,
    requestBody: buildSearchRequest(search, SEARCH_FILTERS),
  },
}));
`;

// The signed-in search API has no created_after filter, so recency is narrowed
// here against a high-water mark kept in the workflow's own static data.
const NORMALIZE_LOGIC = `
const state = $getWorkflowStaticData('global');
prune(state, 120);

const out = [];
for (let i = 0; i < $input.all().length; i += 1) {
  const response = $input.all()[i].json;
  const search = $('Build searches').all()[i].json;

  // GraphQL reports field errors in a 200 body - fail loudly, do not score junk.
  if (response.errors && response.errors.length) {
    throw new Error('Upwork GraphQL: ' + response.errors.map((e) => e.message).join('; '));
  }

  const mark = state.high_water && state.high_water[search.search_key];
  const jobs = jobsFromSearchResponse(response)
    .map(normalizeUpworkJob)
    .filter(isScorable);

  for (const job of publishedSince(jobs, mark)) {
    if (!markSeen(state, job)) continue;   // dedupe across polls and niches
    out.push({ json: { ...job, search_key: search.search_key } });
  }

  // Advance the mark even when everything was a duplicate, so the window does
  // not grow without bound.
  state.high_water = state.high_water || {};
  state.high_water[search.search_key] = highWaterMark(jobs, mark);
}

// No new jobs is the normal outcome of most polls, not an error.
return out;
`;

const SCORE_REQUEST_LOGIC = `
return $input.all().map((item) => ({
  json: {
    ...item.json,
    requestBody: buildScoreRequest(item.json, CONTEXT_PACK, {
      model: SCORING_MODEL,
      mode: SCORING_JSON_MODE,
    }),
  },
}));
`;

const PARSE_SCORE_LOGIC = `
const state = $getWorkflowStaticData('global');

return $input.all().map((item, i) => {
  // The HTTP node returns the API response; the job it belongs to is the
  // matching item on the node before it.
  const job = $('Build score request').all()[i].json;
  const score = parseScoreResponse(item.json);
  const qualified = score.score >= SCORE_THRESHOLD;

  updateStatus(state, job.job_id, qualified ? 'qualified' : 'rejected', {
    score: score.score,
    verdict: score.verdict,
    reasoning: score.reasoning,
  });

  return {
    json: {
      ...job,
      score,
      qualified,
      card: renderJobCard(job, score),
    },
  };
});
`;

// Search truncates descriptions to ~250 chars. Fetch the full posting, but
// only for a job that survived scoring AND the human tap - roughly 3 a day.
const FETCH_DETAIL_LOGIC = `
return $input.all().map((item) => ({
  json: {
    ...item.json,
    requestBody: buildJobDetailRequest(item.json.job.job_id),
  },
}));
`;

const MERGE_DETAIL_LOGIC = `
return $input.all().map((item, i) => {
  const carried = $('Fetch full posting').all()[i].json;
  const job = { ...carried.job };
  const posting = item.json && item.json.data && item.json.data.marketplaceJobPosting;

  // A failed enrichment must not block the draft - it degrades it, and the
  // prompt is told the description is partial either way.
  if (posting && posting.description) {
    job.description = unfence(posting.description);
    job.description_truncated = false;
    if (posting.preferredQualifications) {
      job.preferred_qualifications = posting.preferredQualifications;
    }
  }

  return { json: { ...carried, job } };
});
`;

const DRAFT_REQUEST_LOGIC = `
return $input.all().map((item) => {
  const job = item.json.job;
  return {
    json: {
      ...item.json,
      requestBody: buildDraftRequest(job, CONTEXT_PACK, {
        model: DRAFTING_MODEL,
        effort: DRAFT_EFFORT,
        score: item.json.score,
        minWords: DRAFT_MIN_WORDS,
        maxWords: DRAFT_MAX_WORDS,
      }),
    },
  };
});
`;

// Send-and-Wait resumes with the approval result but not the original item, so
// carry the job forward explicitly from the node that built the card.
const CARRY_APPROVAL_LOGIC = `
return $input.all().map((item, i) => {
  const scored = $('Parse score').all()[i].json;
  const data = item.json.data || item.json;
  return {
    json: {
      job: scored,
      score: scored.score,
      approved: Boolean(data.approved),
    },
  };
});
`;

const PARSE_DRAFT_LOGIC = `
const state = $getWorkflowStaticData('global');

return $input.all().map((item, i) => {
  const carried = $('Build draft request').all()[i].json;
  const job = carried.job;
  const draft = parseDraftResponse(item.json);

  const failures = checkDraft(draft, job, {
    minWords: DRAFT_MIN_WORDS,
    maxWords: DRAFT_MAX_WORDS,
    bannedOpeners: BANNED_OPENERS,
  });

  updateStatus(state, job.job_id, 'drafted', {
    score: carried.score && carried.score.score,
    proposal: draft.proposal,
    rate_note: draft.rate_note,
    draft_warnings: failures,
  });

  return {
    json: {
      job,
      draft,
      warnings: failures,
      message: renderDraftMessage(job, draft)
        + (failures.length ? '\\n\\n:warning: draft checks: ' + failures.join('; ') : ''),
    },
  };
});
`;

const MARK_SKIPPED_LOGIC = `
const state = $getWorkflowStaticData('global');
return $input.all().map((item) => {
  const job = item.json.job;
  updateStatus(state, job.job_id, 'skipped');
  return { json: { job_id: job.job_id, status: 'skipped' } };
});
`;

// Banned openers are parsed out of the rules doc so the list lives in one place.
const BANNED_OPENERS_SNIPPET = `
const BANNED_OPENERS = (CONTEXT_PACK.proposalRules.match(/^- "(.+)"$/gm) || [])
  .map((l) => l.replace(/^- "/, '').replace(/"$/, ''));
`;

const HEALTH_LOGIC = `
// Runs the real search once a day and alerts when it comes back empty or
// rejected. WF1 succeeding is NOT evidence of health any more: on a schedule
// trigger it succeeds happily while returning zero jobs, so a broken token,
// a changed field name or a dead query would look identical to a quiet day.
const response = $input.first().json;

if (response.errors && response.errors.length) {
  return [{
    json: {
      unhealthy: true,
      jobsSeen: 0,
      message: ':rotating_light: *Upwork pipeline is broken*\\nGraphQL rejected the search: '
        + response.errors.map((e) => e.message).join('; ')
        + '\\nFix the field names in src/upwork-query.js, rebuild and re-import.',
    },
  }];
}

const jobs = jobsFromSearchResponse(response);
const unhealthy = jobs.length < MIN_JOBS_PER_DAY;

return [{
  json: {
    jobsSeen: jobs.length,
    unhealthy,
    message: renderHealthAlert({ jobsLast24h: jobs.length }),
  },
}];
`;

const ERROR_LOGIC = `
const e = $input.first().json;
const wf = e.workflow || {};
const err = e.execution || {};
return [{
  json: {
    message: [
      ':rotating_light: *n8n workflow failed*',
      '*Workflow:* ' + (wf.name || 'unknown'),
      '*Node:* ' + ((err.lastNodeExecuted) || 'unknown'),
      '*Error:* ' + ((err.error && err.error.message) || 'unknown'),
      err.url ? '<' + err.url + '|Open the execution>' : '',
    ].filter(Boolean).join('\\n'),
  },
}];
`;

/* ---------------------------------------------------------------- WF1 build */

function buildWf1() {
  const nodes = [
    node('Poll Upwork', 'n8n-nodes-base.scheduleTrigger', 1.2, {
      rule: { interval: [{ field: 'minutes', minutesInterval: POLL_MINUTES }] },
    }, [-480, 300]),

    codeNode('Build searches', [-260, 300],
      ['src/thresholds.js', 'src/upwork-query.js'], BUILD_SEARCH_LOGIC),

    upworkNode('Upwork: search', [-40, 300]),

    codeNode('Normalize & dedupe', [180, 300],
      ['src/upwork-query.js', 'src/normalize-upwork.js', 'src/state.js'], NORMALIZE_LOGIC),

    codeNode('Build score request', [400, 300],
      ['src/thresholds.js', 'src/score-prompt.js'], SCORE_REQUEST_LOGIC, { context: true }),

    anthropicNode('Score (Haiku)', [620, 300]),

    codeNode('Parse score', [840, 300],
      ['src/thresholds.js', 'src/score-prompt.js', 'src/state.js', 'src/slack-card.js'],
      PARSE_SCORE_LOGIC),

    node('Above threshold?', 'n8n-nodes-base.if', 2.2, {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'qualified',
          leftValue: '={{ $json.qualified }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        }],
        combinator: 'and',
      },
      options: {},
    }, [1060, 300]),

    slackNode('Ask: draft or skip?', [1280, 200], {
      operation: 'sendAndWait',
      select: 'channel',
      channelId: { __rl: true, value: SLACK_CHANNEL, mode: 'id' },
      message: '={{ $json.card }}',
      approvalOptions: {
        values: {
          approvalType: 'double',
          approveLabel: 'Draft proposal',
          buttonApprovalStyle: 'primary',
          disapproveLabel: 'Skip',
          buttonDisapprovalStyle: 'danger',
        },
      },
      options: { limitWaitTime: true, resumeAmount: APPROVAL_TIMEOUT_HOURS, resumeUnit: 'hours' },
    }),

    codeNode('Carry approval', [1500, 200], [], CARRY_APPROVAL_LOGIC),

    node('Approved?', 'n8n-nodes-base.if', 2.2, {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'approved',
          leftValue: '={{ $json.approved }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        }],
        combinator: 'and',
      },
      options: {},
    }, [1720, 200]),

    codeNode('Fetch full posting', [1940, 100],
      ['src/upwork-query.js'], FETCH_DETAIL_LOGIC),

    upworkNode('Upwork: job detail', [2160, 100]),

    codeNode('Merge full posting', [2380, 100],
      ['src/normalize-upwork.js'], MERGE_DETAIL_LOGIC),

    codeNode('Build draft request', [2600, 100],
      ['src/thresholds.js', 'src/draft-prompt.js'], DRAFT_REQUEST_LOGIC, { context: true }),

    anthropicNode('Draft (Sonnet)', [2820, 100]),

    codeNode('Parse draft', [3040, 100],
      ['src/thresholds.js', 'src/draft-prompt.js', 'src/state.js', 'src/slack-card.js'],
      `${BANNED_OPENERS_SNIPPET}\n${PARSE_DRAFT_LOGIC}`, { context: true }),

    slackNode('Post draft', [3260, 100], {
      select: 'channel',
      channelId: { __rl: true, value: SLACK_CHANNEL, mode: 'id' },
      text: '={{ $json.message }}',
      otherOptions: {
        thread_ts: {
          replyValues: { thread_ts: '={{ $(\'Ask: draft or skip?\').first().json.messageTs }}' },
        },
      },
    }),

    codeNode('Mark skipped', [1940, 320], ['src/state.js'], MARK_SKIPPED_LOGIC),
  ];

  const connections = connect([
    ['Poll Upwork', 'Build searches'],
    ['Build searches', 'Upwork: search'],
    ['Upwork: search', 'Normalize & dedupe'],
    ['Normalize & dedupe', 'Build score request'],
    ['Build score request', 'Score (Haiku)'],
    ['Score (Haiku)', 'Parse score'],
    ['Parse score', 'Above threshold?'],
    ['Above threshold?', 'Ask: draft or skip?', 0],
    ['Ask: draft or skip?', 'Carry approval'],
    ['Carry approval', 'Approved?'],
    ['Approved?', 'Fetch full posting', 0],
    ['Approved?', 'Mark skipped', 1],
    ['Fetch full posting', 'Upwork: job detail'],
    ['Upwork: job detail', 'Merge full posting'],
    ['Merge full posting', 'Build draft request'],
    ['Build draft request', 'Draft (Sonnet)'],
    ['Draft (Sonnet)', 'Parse draft'],
    ['Parse draft', 'Post draft'],
  ]);

  return workflow('WF1 — Poll, Qualify & Draft', nodes, connections, {
    errorWorkflow: 'REPLACE_ME_WF_ERROR_ID',
  });
}

/* ---------------------------------------------------------------- WF3 build */

function buildWf3() {
  const nodes = [
    node('Daily 09:00', 'n8n-nodes-base.scheduleTrigger', 1.2, {
      rule: { interval: [{ field: 'cronExpression', expression: '0 9 * * *' }] },
    }, [-260, 300]),

    codeNode('Build canary search', [-40, 300],
      ['src/thresholds.js', 'src/upwork-query.js'], `
return [{ json: { requestBody: buildSearchRequest(SEARCH_QUERIES[0], SEARCH_FILTERS) } }];
`),

    upworkNode('Upwork: canary search', [180, 300]),

    codeNode('Evaluate health', [400, 300],
      ['src/thresholds.js', 'src/upwork-query.js', 'src/slack-card.js'], HEALTH_LOGIC),

    node('Unhealthy?', 'n8n-nodes-base.if', 2.2, {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'unhealthy',
          leftValue: '={{ $json.unhealthy }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        }],
        combinator: 'and',
      },
      options: {},
    }, [620, 300]),

    slackNode('Ping the channel', [840, 220], {
      select: 'channel',
      channelId: { __rl: true, value: SLACK_CHANNEL, mode: 'id' },
      text: '={{ $json.message }}',
      otherOptions: {},
    }),
  ];

  const connections = connect([
    ['Daily 09:00', 'Build canary search'],
    ['Build canary search', 'Upwork: canary search'],
    ['Upwork: canary search', 'Evaluate health'],
    ['Evaluate health', 'Unhealthy?'],
    ['Unhealthy?', 'Ping the channel', 0],
  ]);

  return workflow('WF3 — Health check', nodes, connections, {
    errorWorkflow: 'REPLACE_ME_WF_ERROR_ID',
  });
}

/* -------------------------------------------------------------- WF-error */

function buildWfError() {
  const nodes = [
    node('On any workflow error', 'n8n-nodes-base.errorTrigger', 1, {}, [-260, 300]),
    codeNode('Format failure', [-40, 300], [], ERROR_LOGIC),
    slackNode('Post failure', [180, 300], {
      select: 'channel',
      channelId: { __rl: true, value: SLACK_CHANNEL, mode: 'id' },
      text: '={{ $json.message }}',
      otherOptions: {},
    }),
  ];
  const connections = connect([
    ['On any workflow error', 'Format failure'],
    ['Format failure', 'Post failure'],
  ]);
  return workflow('WF-error — Failure ping', nodes, connections);
}

/* -------------------------------------------------------------------- main */

const outDir = join(ROOT, 'workflows');
mkdirSync(outDir, { recursive: true });

const artifacts = [
  ['wf1.poll-qualify-draft.json', buildWf1()],
  ['wf3.health-check.json', buildWf3()],
  ['wf-error.failure-ping.json', buildWfError()],
];

for (const [file, wf] of artifacts) {
  writeFileSync(join(outDir, file), `${JSON.stringify(wf, null, 2)}\n`);
  const codeNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code');
  const bytes = JSON.stringify(wf).length;
  console.log(`${file}  ${wf.nodes.length} nodes, ${codeNodes.length} code nodes, ${(bytes / 1024).toFixed(1)} KB`);
}
console.log(`\nn8n base URL baked into WF3: ${N8N_BASE_URL}`);
console.log(`Slack channel baked in: ${SLACK_CHANNEL}`);
