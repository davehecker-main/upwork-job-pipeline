/**
 * Turn one Upwork marketplace search result into the canonical job record the
 * rest of the pipeline uses.
 *
 * Pure and idempotent, no dependencies - unit tested by vitest and inlined into
 * the n8n Code node by scripts/build-workflow.mjs.
 *
 * Written against a real `find_jobs action=search` response. Every defensive
 * branch below exists because a real result exercised it:
 *   - `skills` is absent on some postings entirely
 *   - `proposal_count` is absent until the first proposal lands
 *   - `budget` is the string "0.0" on hourly jobs, and hourly search results
 *     carry only `hourly_budget_type` - NOT the actual rate range
 *   - `client.rating` / `total_hires` / `total_reviews` are absent for a client
 *     who has never been reviewed
 *   - `country` arrives as a name ("United States") or an ISO-3 code ("ARE")
 *   - `total_spent` is a formatted string, "$25,875.82"
 *   - descriptions arrive fenced in <untrusted_participant_content> tags and
 *     TRUNCATED (~250 chars) - the full text needs a per-job get call
 */

export const SCHEMA_VERSION = 2;

/** "$25,875.82" -> 25875. Returns null rather than 0 for absent data. */
export function parseMoney(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
}

function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clean(s, max = 6000) {
  if (s == null) return '';
  const out = String(s).replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/**
 * Strip Upwork's own untrusted-content fence. Their server wraps client-written
 * text in it, which is the correct instinct - we keep treating the text as data,
 * but the tags themselves are noise in a prompt.
 */
export function unfence(text) {
  if (!text) return '';
  return String(text)
    .replace(/<\/?untrusted_participant_content>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the description we hold is Upwork's truncated search snippet. */
export function isTruncated(text) {
  return /(?:\.\.\.|…)\s*$/.test(String(text || '').trim());
}

/**
 * Average spend per hire - the single most useful derived client signal, and
 * the one the rubric's "45 hires at $500 vs 45 at $50k" rule needs. Note
 * total_hires can EXCEED total_posted_jobs (several hires on one posting), so a
 * hires/posts "rate" is not meaningful and is deliberately not computed.
 */
export function avgSpendPerHire(client) {
  const spent = parseMoney(client && client.total_spent);
  const hires = num(client && client.total_hires);
  if (spent == null || !hires) return null;
  return Math.round(spent / hires);
}

export function budgetDisplay(job) {
  if (job.budget_type === 'hourly') {
    if (job.budget_hourly_min && job.budget_hourly_max) {
      return `$${job.budget_hourly_min}-$${job.budget_hourly_max}/hr`;
    }
    // Search results give only the KIND of hourly budget, never the numbers.
    // The two transports spell it differently ("client-specified range" from
    // the MCP shape, "CLIENT_SPECIFIED_RANGE" from GraphQL), so match loosely.
    const kind = String(job.hourly_budget_type || '').toLowerCase().replace(/[\s_-]+/g, ' ');
    return {
      'client specified range': 'hourly, client set a range (not shown in search)',
      'platform default range': 'hourly, platform default range',
      'no rate stated': 'hourly, no rate stated',
    }[kind] || 'hourly, rate not stated';
  }
  if (job.budget_type === 'fixed') {
    return job.budget_fixed ? `$${job.budget_fixed} fixed` : 'fixed, budget not stated';
  }
  return 'not stated';
}

/**
 * Client credibility in the form the rubric reasons about. Kept as prose
 * because that is what goes into the prompt, and because "spend unknown" must
 * read as a fact rather than silently become a zero.
 */
export function clientSummary(job) {
  const parts = [];
  parts.push(job.client_payment_verified ? 'payment verified' : 'payment NOT verified');
  parts.push(job.client_total_spent == null
    ? 'spend unknown'
    : `$${job.client_total_spent} lifetime spend`);
  if (job.client_hires != null) parts.push(`${job.client_hires} hires`);
  if (job.client_avg_spend_per_hire != null) {
    parts.push(`~$${job.client_avg_spend_per_hire} per hire`);
  }
  if (job.client_posted_jobs != null) parts.push(`${job.client_posted_jobs} jobs posted`);
  if (job.client_rating != null) {
    parts.push(`${job.client_rating}/5 from ${job.client_reviews ?? 0} freelancer reviews`);
  } else {
    parts.push('never reviewed by a freelancer');
  }
  if (job.client_country) parts.push(job.client_country);
  return parts.join(', ');
}

/**
 * @param {object} raw one entry from a search response's `jobs[]`, or an
 *                     already-normalized record (returned as-is with display
 *                     fields re-derived).
 */
export function normalizeUpworkJob(raw) {
  const j = raw && typeof raw === 'object' ? raw : {};
  const c = (j.client && typeof j.client === 'object' ? j.client : j) || {};

  const jobType = String(j.job_type || j.budget_type || '').toLowerCase();
  const budgetType = jobType === 'hourly' ? 'hourly' : jobType === 'fixed' ? 'fixed' : 'unknown';
  const fixedBudget = budgetType === 'fixed' ? parseMoney(j.budget ?? j.budget_fixed) : null;

  // Truncation must be judged AFTER unfencing: the raw snippet ends with the
  // closing </untrusted_participant_content> tag, so the "..." is never last.
  const description = unfence(j.description_snippet || j.description || '');

  const out = {
    schema_version: SCHEMA_VERSION,
    source: 'upwork',
    job_id: clean(j.id ?? j.job_id, 64),
    url: clean(j.url, 500),
    title: clean(j.title, 250),
    description,
    description_truncated: isTruncated(description),
    skills: Array.isArray(j.skills) ? j.skills.map((s) => clean(s, 60)) : [],
    budget_type: budgetType,
    budget_fixed: fixedBudget && fixedBudget > 0 ? fixedBudget : null,
    hourly_budget_type: j.hourly_budget_type ? clean(j.hourly_budget_type, 40) : null,
    budget_hourly_min: num(j.budget_hourly_min),
    budget_hourly_max: num(j.budget_hourly_max),
    duration: j.duration ? clean(j.duration, 40) : null,
    engagement: j.engagement ? clean(j.engagement, 40) : null,
    experience_level: j.experience_level ? String(j.experience_level).toLowerCase() : null,
    freelancers_to_hire: num(j.freelancers_to_hire),
    proposals: num(j.proposal_count ?? j.proposals),
    created_date: j.created_date || null,
    published_date: j.published_date || j.created_date || null,

    client_payment_verified: String(c.verification_status || '').toUpperCase() === 'VERIFIED'
      || Boolean(c.client_payment_verified),
    client_total_spent: parseMoney(c.total_spent ?? c.client_total_spent),
    client_hires: num(c.total_hires ?? c.client_hires),
    client_posted_jobs: num(c.total_posted_jobs ?? c.client_posted_jobs),
    client_rating: num(c.rating ?? c.client_rating),
    client_reviews: num(c.total_reviews ?? c.client_reviews),
    client_country: (c.country ?? c.client_country) ? clean(c.country ?? c.client_country, 60) : null,
  };

  out.client_avg_spend_per_hire = avgSpendPerHire({
    total_spent: out.client_total_spent, total_hires: out.client_hires,
  });
  out.budget_display = budgetDisplay(out);
  out.client_summary = clientSummary(out);
  return out;
}

/** Map a whole search response to canonical jobs, newest first. */
export function normalizeSearchResponse(response) {
  const jobs = response && Array.isArray(response.jobs) ? response.jobs : [];
  return jobs.map(normalizeUpworkJob).filter(isScorable);
}

export function isScorable(job) {
  return Boolean(job && job.job_id && job.title && job.title.length >= 3);
}

/**
 * Client-side recency window - the signed-in search API has no created_after
 * filter, so polling narrows here instead. `sinceIso` is the previous poll's
 * high-water mark.
 */
export function publishedSince(jobs, sinceIso) {
  if (!sinceIso) return jobs;
  return jobs.filter((j) => (j.published_date || j.created_date || '') > sinceIso);
}

/** The newest published_date in a batch, for the next poll's high-water mark. */
export function highWaterMark(jobs, fallback = null) {
  return jobs.reduce(
    (max, j) => {
      const d = j.published_date || j.created_date;
      return d && d > max ? d : max;
    },
    fallback || '',
  ) || fallback;
}
