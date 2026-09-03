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

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const N8N_BASE_URL = flag('n8n-base-url', process.env.N8N_BASE_URL || 'https://REPLACE-ME.app.n8n.cloud');
const SLACK_CHANNEL = flag('slack-channel', process.env.SLACK_CHANNEL || 'REPLACE-ME');
const MAILBOX = flag('mailbox', 'vollna-alerts');

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

// The IMAP node's field names have varied across versions, so read defensively
// rather than pinning one shape and failing silently on upgrade.
const PARSE_LOGIC = `
const state = $getWorkflowStaticData('global');
prune(state, 120);

const out = [];
for (const item of $input.all()) {
  const d = item.json || {};
  const email = {
    subject: d.subject || d.Subject || (d.headers && d.headers.subject) || null,
    text: d.textPlain || d.text || d.textAsHtml || null,
    html: d.textHtml || d.html || null,
  };

  for (const raw of parseVollnaEmail(email)) {
    const job = normalizeJob(raw);
    if (!isScorable(job)) continue;          // no usable title: nothing to score
    if (!markSeen(state, job)) continue;     // dedupe: already known
    out.push({ json: job });
  }
}

// No new jobs is a normal outcome, not an error. Returning [] ends the branch.
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
// Counts WF1 executions in the window via the n8n API. Deliberately not read
// from workflow static data: static data is per-workflow, and an IMAP trigger
// that never fires would leave WF1's state untouched and this check blind.
const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const executions = ($input.first().json.data || []).filter((e) => e.startedAt >= since);
const jobsLast24h = executions.length;

return [{
  json: {
    jobsLast24h,
    unhealthy: jobsLast24h < MIN_JOBS_PER_DAY,
    message: renderHealthAlert({ jobsLast24h }),
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
    node('Vollna alert (IMAP)', 'n8n-nodes-base.emailReadImap', 2, {
      mailbox: MAILBOX,
      postProcessAction: 'read',
      format: 'resolved',
      options: {},
    }, [-260, 300], {
      credentials: { imap: { id: 'REPLACE_ME', name: 'Gmail IMAP (app password)' } },
    }),

    codeNode('Parse & dedupe', [-40, 300],
      ['src/parse-vollna.js', 'src/normalize.js', 'src/state.js'], PARSE_LOGIC),

    codeNode('Build score request', [180, 300],
      ['src/thresholds.js', 'src/score-prompt.js'], SCORE_REQUEST_LOGIC, { context: true }),

    anthropicNode('Score (Haiku)', [400, 300]),

    codeNode('Parse score', [620, 300],
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
    }, [840, 300]),

    slackNode('Ask: draft or skip?', [1060, 200], {
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
      options: { limitWaitTime: true, resumeAmount: 72, resumeUnit: 'hours' },
    }),

    codeNode('Carry approval', [1280, 200], [], CARRY_APPROVAL_LOGIC),

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
    }, [1500, 200]),

    codeNode('Build draft request', [1720, 100],
      ['src/thresholds.js', 'src/draft-prompt.js'], DRAFT_REQUEST_LOGIC, { context: true }),

    anthropicNode('Draft (Sonnet)', [1940, 100]),

    codeNode('Parse draft', [2160, 100],
      ['src/thresholds.js', 'src/draft-prompt.js', 'src/state.js', 'src/slack-card.js'],
      `${BANNED_OPENERS_SNIPPET}\n${PARSE_DRAFT_LOGIC}`, { context: true }),

    slackNode('Post draft', [2380, 100], {
      select: 'channel',
      channelId: { __rl: true, value: SLACK_CHANNEL, mode: 'id' },
      text: '={{ $json.message }}',
      otherOptions: {
        thread_ts: {
          replyValues: { thread_ts: '={{ $(\'Ask: draft or skip?\').first().json.messageTs }}' },
        },
      },
    }),

    codeNode('Mark skipped', [1720, 320], ['src/state.js'], MARK_SKIPPED_LOGIC),
  ];

  const connections = connect([
    ['Vollna alert (IMAP)', 'Parse & dedupe'],
    ['Parse & dedupe', 'Build score request'],
    ['Build score request', 'Score (Haiku)'],
    ['Score (Haiku)', 'Parse score'],
    ['Parse score', 'Above threshold?'],
    ['Above threshold?', 'Ask: draft or skip?', 0],
    ['Ask: draft or skip?', 'Carry approval'],
    ['Carry approval', 'Approved?'],
    ['Approved?', 'Build draft request', 0],
    ['Approved?', 'Mark skipped', 1],
    ['Build draft request', 'Draft (Sonnet)'],
    ['Draft (Sonnet)', 'Parse draft'],
    ['Parse draft', 'Post draft'],
  ]);

  return workflow('WF1 — Ingest, Qualify & Draft', nodes, connections, {
    errorWorkflow: 'REPLACE_ME_WF_ERROR_ID',
  });
}

/* ---------------------------------------------------------------- WF3 build */

function buildWf3() {
  const nodes = [
    node('Daily 09:00', 'n8n-nodes-base.scheduleTrigger', 1.2, {
      rule: { interval: [{ field: 'cronExpression', expression: '0 9 * * *' }] },
    }, [-260, 300]),

    node('WF1 executions (n8n API)', 'n8n-nodes-base.httpRequest', 4.2, {
      method: 'GET',
      url: `${N8N_BASE_URL}/api/v1/executions`,
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'workflowId', value: 'REPLACE_ME_WF1_ID' },
          { name: 'status', value: 'success' },
          { name: 'limit', value: '100' },
        ],
      },
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      options: {},
    }, [-40, 300], {
      credentials: { httpHeaderAuth: { id: 'REPLACE_ME', name: 'n8n API (X-N8N-API-KEY)' } },
    }),

    codeNode('Evaluate health', [180, 300],
      ['src/thresholds.js', 'src/slack-card.js'], HEALTH_LOGIC),

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
    }, [400, 300]),

    slackNode('Ping the channel', [620, 220], {
      select: 'channel',
      channelId: { __rl: true, value: SLACK_CHANNEL, mode: 'id' },
      text: '={{ $json.message }}',
      otherOptions: {},
    }),
  ];

  const connections = connect([
    ['Daily 09:00', 'WF1 executions (n8n API)'],
    ['WF1 executions (n8n API)', 'Evaluate health'],
    ['Evaluate health', 'Unhealthy?'],
    ['Unhealthy?', 'Ping the channel', 0],
  ]);

  return workflow('WF3 — Health check', nodes, connections);
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
  ['wf1.ingest-qualify-draft.json', buildWf1()],
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
