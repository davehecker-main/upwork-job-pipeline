/**
 * Build the Anthropic /v1/messages request that scores one job.
 *
 * Pure: takes a normalized job plus the context pack, returns a request body.
 * The same builder feeds the n8n Code node and scripts/run-eval.mjs, which is
 * the whole point - the eval scores the exact prompt production sends.
 */

export const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    score: {
      type: 'integer',
      minimum: 0,
      maximum: 100,
      description: 'Overall fit and client-quality score.',
    },
    verdict: {
      type: 'string',
      enum: ['qualify', 'maybe', 'reject'],
    },
    reasoning: {
      type: 'string',
      description: 'One or two sentences. What decided this score. No preamble.',
    },
    red_flags: {
      type: 'array',
      items: { type: 'string' },
      description: 'Short phrases naming concrete red flags found. Empty array if none.',
    },
  },
  required: ['score', 'verdict', 'reasoning', 'red_flags'],
  additionalProperties: false,
};

function jobBlock(job) {
  const lines = [
    `Title: ${job.title}`,
    `Budget: ${job.budget_display}`,
    `Experience level requested: ${job.experience_level || 'not stated'}`,
    `Duration: ${job.duration || 'not stated'}`,
  ];
  if (job.engagement) lines.push(`Workload: ${job.engagement}`);
  if (job.skills && job.skills.length) lines.push(`Skills tagged: ${job.skills.join(', ')}`);
  lines.push(
    `Proposals so far: ${job.proposals == null ? 'none yet' : job.proposals}`,
    `Published: ${job.published_date || 'not stated'}`,
    `Client: ${job.client_summary}`,
    '',
    'Description:',
    job.description || '(no description text available)',
  );
  // Say it out loud rather than letting the model infer a vague client from an
  // API artifact - this is the single most costly misreading available to it.
  if (job.description_truncated) {
    lines.push(
      '',
      'NOTE: the description above is Upwork\'s search snippet and is cut off.'
      + ' Do not treat the truncation as vague scope.',
    );
  }
  return lines.join('\n');
}

/**
 * @param {object} job normalized job (see src/normalize.js)
 * @param {{rubric: string}} ctx context pack
 * @param {{model?: string, mode?: 'structured'|'tool'}} [opts]
 */
export function buildScoreRequest(job, ctx, opts = {}) {
  const model = opts.model || 'claude-haiku-4-5';
  const mode = opts.mode || 'structured';

  const system = [
    'You screen Upwork job postings for a senior automation consultant.',
    'Apply the rubric below exactly. Return only the structured result.',
    '',
    ctx.rubric,
  ].join('\n');

  const base = {
    model,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: jobBlock(job) }],
  };

  // No cache_control here on purpose: the rubric prefix is well under the
  // minimum cacheable prefix for a Haiku-class model, so a breakpoint would
  // cost a write and never read. The drafting call is where caching pays.

  if (mode === 'tool') {
    return {
      ...base,
      tools: [{
        name: 'record_score',
        description: 'Record the screening result for this job.',
        input_schema: SCORE_SCHEMA,
        strict: true,
      }],
      tool_choice: { type: 'tool', name: 'record_score' },
    };
  }

  return {
    ...base,
    output_config: {
      format: { type: 'json_schema', schema: SCORE_SCHEMA },
    },
  };
}

/**
 * Pull the score object out of an API response, whichever mode produced it.
 * Throws on an unusable response so the n8n node fails loudly and the error
 * workflow fires - a silently defaulted score would let bad jobs through.
 */
export function parseScoreResponse(response) {
  if (!response || typeof response !== 'object') throw new Error('empty scoring response');
  if (response.stop_reason === 'refusal') {
    throw new Error(`scoring refused: ${response.stop_details?.category || 'unknown'}`);
  }
  const blocks = Array.isArray(response.content) ? response.content : [];

  const toolBlock = blocks.find((b) => b.type === 'tool_use' && b.name === 'record_score');
  if (toolBlock) return validateScore(toolBlock.input);

  const textBlock = blocks.find((b) => b.type === 'text' && b.text && b.text.trim());
  if (!textBlock) throw new Error('scoring response contained no text or tool_use block');
  // Tolerate a fenced block, which is what a non-structured fallback produces.
  const raw = textBlock.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  return validateScore(JSON.parse(raw));
}

export function validateScore(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const score = Number(o.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error(`score out of range: ${JSON.stringify(o.score)}`);
  }
  if (!['qualify', 'maybe', 'reject'].includes(o.verdict)) {
    throw new Error(`unknown verdict: ${JSON.stringify(o.verdict)}`);
  }
  return {
    score: Math.round(score),
    verdict: o.verdict,
    reasoning: String(o.reasoning || '').trim(),
    red_flags: Array.isArray(o.red_flags) ? o.red_flags.map(String) : [],
  };
}
