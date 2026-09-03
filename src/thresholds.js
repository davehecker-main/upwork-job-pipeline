/**
 * Every tunable number in the pipeline. One file so Phase 2 retuning is a
 * single reviewable diff, and so the eval harness and the workflow can never
 * disagree about the threshold.
 */

/** Scores at or above this get a Slack card. Below, the job is logged and dropped. */
export const SCORE_THRESHOLD = 70;

/** Slack Send-and-Wait timeout. A Friday-night post must survive the weekend. */
export const APPROVAL_TIMEOUT_HOURS = 72;

/** WF3 fires if fewer than this many jobs were seen in the last 24h. */
export const MIN_JOBS_PER_DAY = 1;

/** Draft length gate, enforced by the draft eval and stated in the prompt. */
export const DRAFT_MIN_WORDS = 120;
export const DRAFT_MAX_WORDS = 350;

/** Model choices. Scoring is high-volume and mechanical; drafting is not. */
export const SCORING_MODEL = 'claude-haiku-4-5';
export const DRAFTING_MODEL = 'claude-sonnet-5';

/** Drafting effort. Sonnet 5 accepts low|medium|high|xhigh|max. */
export const DRAFT_EFFORT = 'low';

/**
 * Scoring response mode. 'structured' uses output_config.format; 'tool' uses a
 * strict tool with forced tool_choice. Settle this with scripts/check-json-mode.mjs
 * before wiring the workflow - it is a live-API fact, not a guess.
 */
export const SCORING_JSON_MODE = 'structured';

/**
 * Upwork marketplace searches WF1 runs on each poll. One entry per niche; the
 * queries stay here so tuning them is a reviewable diff rather than a click in
 * the n8n UI.
 */
export const SEARCH_QUERIES = [
  { key: 'n8n', query: 'n8n automation workflow' },
  { key: 'claude-code', query: 'Claude Code AI coding agent coaching training' },
];

/**
 * Server-side filters applied to every search. These cut junk before a single
 * token is spent - Upwork does the first pass of the rubric for free.
 * proposals_max keeps out postings that are effectively already closed.
 */
export const SEARCH_FILTERS = {
  verified_payment_only: true,
  proposals_max: 40,
  sort: 'recency',
  limit: 10,
};

/** How often WF1 polls. 10 minutes is ~288 calls/day, 0.003 req/s average. */
export const POLL_MINUTES = 10;
