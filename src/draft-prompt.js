/**
 * Build the Anthropic /v1/messages request that drafts one proposal.
 *
 * The context pack (profile, rules, style examples) is the stable prefix and
 * carries the cache breakpoint; the job is the only volatile tail. Keep it that
 * way - moving anything job-specific above the breakpoint silently kills the
 * cache hit and roughly triples the per-draft cost.
 */

export const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    proposal: {
      type: 'string',
      description: 'The proposal text, ready to paste into Upwork. Plain text, no markdown.',
    },
    specific_observation: {
      type: 'string',
      description: 'The detail from this posting that the opening line is built on.',
    },
    rate_note: {
      type: 'string',
      description: 'One internal line: suggested rate or range, and why. Not part of the proposal.',
    },
  },
  required: ['proposal', 'specific_observation', 'rate_note'],
  additionalProperties: false,
};

function jobBlock(job, score) {
  const lines = [
    'Draft a proposal for this posting.',
    '',
    `Title: ${job.title}`,
    `Budget: ${job.budget_display}`,
    `Client: ${job.client_summary}`,
    `Proposals so far: ${job.proposals == null ? 'not stated' : job.proposals}`,
    '',
    'Description:',
    job.description || '(no description captured from the alert email)',
  ];
  if (score) {
    lines.push(
      '',
      `Screening score: ${score.score}/100 (${score.verdict}). ${score.reasoning}`,
    );
    if (score.red_flags && score.red_flags.length) {
      lines.push(`Noted concerns: ${score.red_flags.join('; ')}`);
      lines.push('Do not raise these concerns in the proposal. They are context for you.');
    }
  }
  return lines.join('\n');
}

/**
 * @param {object} job normalized job
 * @param {{profile: string, proposalRules: string, examples: string[]}} ctx
 * @param {{score?: object, model?: string, effort?: string, minWords?: number, maxWords?: number}} [opts]
 */
export function buildDraftRequest(job, ctx, opts = {}) {
  const model = opts.model || 'claude-sonnet-5';
  const minWords = opts.minWords || 120;
  const maxWords = opts.maxWords || 350;

  const examples = (ctx.examples || []).filter(Boolean);
  const stable = [
    'You write Upwork proposals for the consultant described below.',
    'You write as him, in first person. You never invent facts about him that',
    'the profile does not support.',
    '',
    '# Profile',
    ctx.profile,
    '',
    '# Rules',
    ctx.proposalRules,
    '',
    `Length: ${minWords}-${maxWords} words.`,
    '',
    examples.length
      ? `# Style examples\n\nImitate the voice of these, not their content.\n\n${examples
          .map((e, i) => `## Example ${i + 1}\n\n${e}`)
          .join('\n\n')}`
      : '# Style examples\n\n(none provided yet)',
  ].join('\n');

  const request = {
    model,
    max_tokens: 4096,
    system: [
      {
        type: 'text',
        text: stable,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: jobBlock(job, opts.score) }],
    output_config: {
      format: { type: 'json_schema', schema: DRAFT_SCHEMA },
    },
  };

  // effort and format both live in output_config; merge rather than overwrite.
  if (opts.effort) request.output_config.effort = opts.effort;

  return request;
}

export function parseDraftResponse(response) {
  if (!response || typeof response !== 'object') throw new Error('empty draft response');
  if (response.stop_reason === 'refusal') {
    throw new Error(`drafting refused: ${response.stop_details?.category || 'unknown'}`);
  }
  const blocks = Array.isArray(response.content) ? response.content : [];
  const textBlock = blocks.find((b) => b.type === 'text' && b.text && b.text.trim());
  if (!textBlock) throw new Error('draft response contained no text block');
  const raw = textBlock.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  const parsed = JSON.parse(raw);
  if (!parsed.proposal || !String(parsed.proposal).trim()) {
    throw new Error('draft response contained an empty proposal');
  }
  return {
    proposal: String(parsed.proposal).trim(),
    specific_observation: String(parsed.specific_observation || '').trim(),
    rate_note: String(parsed.rate_note || '').trim(),
  };
}

export function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Structural checks on a draft. Used by the draft eval and importable by the
 * workflow if you ever want to gate a draft before it reaches Slack.
 * Returns an array of failure strings; empty means it passed.
 */
export function checkDraft(draft, job, opts = {}) {
  const minWords = opts.minWords || 120;
  const maxWords = opts.maxWords || 350;
  const bannedOpeners = opts.bannedOpeners || [];
  const failures = [];
  const text = String(draft && draft.proposal || '');

  const words = wordCount(text);
  if (words < minWords) failures.push(`too short: ${words} words`);
  if (words > maxWords) failures.push(`too long: ${words} words`);

  const head = text.slice(0, 200).toLowerCase();
  for (const opener of bannedOpeners) {
    if (head.includes(opener.toLowerCase())) failures.push(`banned opener: "${opener}"`);
  }

  if (/^#{1,6}\s|\*\*/m.test(text)) failures.push('contains markdown formatting');

  // The "one specific observation" rule, checked mechanically: the proposal
  // must reuse a distinctive term from the posting.
  const jobTerms = distinctiveTerms(`${job.title} ${job.description}`);
  const lower = text.toLowerCase();
  const hits = jobTerms.filter((t) => lower.includes(t));
  if (!hits.length) failures.push('no distinctive term from the posting appears in the proposal');

  return failures;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'you', 'your', 'our', 'are', 'have', 'has',
  'need', 'needs', 'looking', 'want', 'wants', 'work', 'project', 'help', 'able', 'will',
  'would', 'like', 'about', 'from', 'into', 'them', 'they', 'some', 'more', 'must', 'can',
  'should', 'when', 'what', 'who', 'how', 'not', 'but', 'all', 'any', 'been', 'was', 'were',
  'someone', 'expert', 'freelancer', 'developer', 'experience', 'please', 'thanks', 'job',
]);

/** Longer, non-stopword tokens from the posting - proxies for its specifics. */
export function distinctiveTerms(text) {
  const seen = new Set();
  for (const raw of String(text || '').toLowerCase().match(/[a-z][a-z0-9.+#_-]{3,}/g) || []) {
    const t = raw.replace(/[.]+$/, '');
    if (t.length < 4 || STOPWORDS.has(t)) continue;
    seen.add(t);
  }
  return [...seen];
}
