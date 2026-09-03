/**
 * Turn a raw parsed job into the canonical record every downstream step uses:
 * the Data Table row, the scoring prompt, the Slack card, the draft prompt.
 *
 * Pure and idempotent. Inlined into the n8n "parse" Code node alongside
 * parse-vollna.js, so it must stay dependency free.
 */

export const SCHEMA_VERSION = 1;

/** Collapse whitespace and clip, so a runaway description can't blow up a prompt. */
function clean(s, max = 4000) {
  if (s == null) return '';
  const out = String(s).replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

function money(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n);
}

/** Human-readable budget for the Slack card and the prompt. */
export function budgetDisplay(job) {
  if (job.budget_type === 'hourly') {
    const lo = job.budget_hourly_min;
    const hi = job.budget_hourly_max;
    if (lo && hi && lo !== hi) return `$${lo}-$${hi}/hr`;
    if (lo) return `$${lo}/hr`;
    return 'hourly, rate not stated';
  }
  if (job.budget_type === 'fixed') {
    return job.budget_fixed ? `$${money(job.budget_fixed)} fixed` : 'fixed, budget not stated';
  }
  return 'not stated';
}

/**
 * Client credibility summary in the form the rubric reasons about. Posted
 * budget is a weak signal and placeholder budgets are common, so the prompt is
 * handed spend/hires/rating explicitly rather than left to infer them.
 */
export function clientSummary(job) {
  const parts = [];
  parts.push(job.client_payment_verified ? 'payment verified' : 'payment NOT verified');
  if (job.client_total_spent != null) parts.push(`$${money(job.client_total_spent)} total spent`);
  else parts.push('spend unknown');
  if (job.client_hires != null) parts.push(`${job.client_hires} hires`);
  if (job.client_jobs_posted != null) parts.push(`${job.client_jobs_posted} jobs posted`);
  if (job.client_rating != null) parts.push(`${job.client_rating}/5 rating`);
  if (job.client_country) parts.push(job.client_country);
  return parts.join(', ');
}

/**
 * @param {object} raw a record from parseVollnaEmail(), or an already
 *                     normalized record (in which case it is returned as-is
 *                     apart from re-derived display fields).
 */
export function normalizeJob(raw) {
  const j = raw && typeof raw === 'object' ? raw : {};
  const normalized = {
    schema_version: SCHEMA_VERSION,
    job_id: clean(j.job_id, 64),
    url: clean(j.url, 500),
    title: clean(j.title, 250),
    description: clean(j.description, 4000),
    budget_type: ['hourly', 'fixed', 'unknown'].includes(j.budget_type) ? j.budget_type : 'unknown',
    budget_fixed: money(j.budget_fixed),
    budget_hourly_min: money(j.budget_hourly_min),
    budget_hourly_max: money(j.budget_hourly_max),
    client_total_spent: money(j.client_total_spent),
    client_hires: Number.isFinite(j.client_hires) ? j.client_hires : null,
    client_jobs_posted: Number.isFinite(j.client_jobs_posted) ? j.client_jobs_posted : null,
    client_rating: Number.isFinite(j.client_rating) ? j.client_rating : null,
    client_payment_verified: Boolean(j.client_payment_verified),
    client_country: j.client_country ? clean(j.client_country, 60) : null,
    proposals: Number.isFinite(j.proposals) ? j.proposals : null,
    experience_level: j.experience_level ? clean(j.experience_level, 30) : null,
    posted_at_raw: j.posted_at_raw ? clean(j.posted_at_raw, 60) : null,
    alert_subject: j.alert_subject ? clean(j.alert_subject, 200) : null,
  };
  normalized.budget_display = budgetDisplay(normalized);
  normalized.client_summary = clientSummary(normalized);
  return normalized;
}

/** A job is worth scoring only if we got the two fields the rubric needs. */
export function isScorable(job) {
  return Boolean(job && job.job_id && job.title && job.title.length >= 8);
}
