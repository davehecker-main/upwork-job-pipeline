/**
 * Dedupe and status state for the pipeline.
 *
 * Deliberately a set of pure functions over a plain object, so the whole
 * lifecycle is unit testable. In n8n the object is the workflow's static data
 * (`$getWorkflowStaticData('global')`), which n8n persists in its own database
 * and which therefore survives container restarts and Docker image upgrades.
 *
 * Why not a Data Table or SQLite node: this needs to behave identically on the
 * n8n Cloud trial and on the micro PC, with no node parameters to get wrong and
 * no writable volume to depend on. The trade-off is that state is not
 * queryable from outside n8n and should stay small - hence prune(). When the
 * proposal log needs to be a real queryable store (Phase 2 tuning against reply
 * data), move it to SQLite on the micro PC volume and keep this module for
 * dedupe only.
 */

export const STATUS = {
  SEEN: 'seen',
  REJECTED: 'rejected',
  QUALIFIED: 'qualified',
  DRAFTED: 'drafted',
  SKIPPED: 'skipped',
  ERROR: 'error',
};

/** Get the jobs map, creating it on first use. Mutates `state` by design. */
export function jobsOf(state) {
  if (!state || typeof state !== 'object') throw new Error('state must be an object');
  if (!state.jobs || typeof state.jobs !== 'object') state.jobs = {};
  return state.jobs;
}

export function hasSeen(state, jobId) {
  return Object.prototype.hasOwnProperty.call(jobsOf(state), String(jobId));
}

/**
 * Record a first sighting. Returns false and touches nothing if the job is
 * already known, which is exactly the dedupe decision the workflow branches on.
 */
export function markSeen(state, job, now = Date.now()) {
  const jobs = jobsOf(state);
  const id = String(job.job_id);
  if (!id) throw new Error('cannot mark a job with no job_id');
  if (Object.prototype.hasOwnProperty.call(jobs, id)) return false;
  jobs[id] = {
    status: STATUS.SEEN,
    title: job.title || '',
    url: job.url || '',
    first_seen: now,
    updated: now,
  };
  return true;
}

export function updateStatus(state, jobId, status, extra = {}, now = Date.now()) {
  const jobs = jobsOf(state);
  const id = String(jobId);
  if (!Object.prototype.hasOwnProperty.call(jobs, id)) {
    throw new Error(`cannot update unknown job ${id}`);
  }
  if (!Object.values(STATUS).includes(status)) throw new Error(`unknown status ${status}`);
  jobs[id] = { ...jobs[id], ...extra, status, updated: now };
  return jobs[id];
}

export function get(state, jobId) {
  return jobsOf(state)[String(jobId)] || null;
}

/** How many jobs were first seen in the window. This is the WF3 canary input. */
export function countSince(state, sinceMs) {
  return Object.values(jobsOf(state)).filter((j) => j.first_seen >= sinceMs).length;
}

export function countByStatus(state) {
  const out = {};
  for (const j of Object.values(jobsOf(state))) out[j.status] = (out[j.status] || 0) + 1;
  return out;
}

/**
 * Drop records older than maxAgeDays so static data cannot grow without bound.
 * Drafted jobs are kept regardless - they are the record of what was actually
 * sent, and Phase 2 retunes the rubric against them.
 */
export function prune(state, maxAgeDays = 120, now = Date.now()) {
  const jobs = jobsOf(state);
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const [id, j] of Object.entries(jobs)) {
    if (j.status === STATUS.DRAFTED) continue;
    if (j.first_seen < cutoff) {
      delete jobs[id];
      removed += 1;
    }
  }
  return removed;
}
