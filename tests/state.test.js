import { beforeEach, describe, expect, it } from 'vitest';
import {
  STATUS, hasSeen, markSeen, updateStatus, get, countSince, countByStatus, prune, jobsOf,
} from '../src/state.js';

const DAY = 24 * 60 * 60 * 1000;
const job = (id) => ({ job_id: id, title: `Job ${id}`, url: `https://u/${id}` });

describe('state', () => {
  let s;
  beforeEach(() => { s = {}; });

  it('marks a first sighting and reports it as seen', () => {
    expect(hasSeen(s, 'a')).toBe(false);
    expect(markSeen(s, job('a'))).toBe(true);
    expect(hasSeen(s, 'a')).toBe(true);
    expect(get(s, 'a').status).toBe(STATUS.SEEN);
  });

  it('refuses a duplicate without touching the existing record', () => {
    markSeen(s, job('a'), 1000);
    updateStatus(s, 'a', STATUS.DRAFTED, {}, 2000);
    expect(markSeen(s, job('a'), 3000)).toBe(false);
    expect(get(s, 'a').status).toBe(STATUS.DRAFTED);
    expect(get(s, 'a').updated).toBe(2000);
  });

  it('treats numeric and string ids as the same job', () => {
    markSeen(s, { job_id: 123, title: 'x' });
    expect(hasSeen(s, '123')).toBe(true);
  });

  it('walks the full lifecycle and stores the score alongside', () => {
    markSeen(s, job('a'));
    updateStatus(s, 'a', STATUS.QUALIFIED, { score: 82 });
    updateStatus(s, 'a', STATUS.DRAFTED, { proposal: 'text' });
    const rec = get(s, 'a');
    expect(rec.status).toBe(STATUS.DRAFTED);
    expect(rec.score).toBe(82);
    expect(rec.proposal).toBe('text');
    expect(rec.title).toBe('Job a');
  });

  it('throws on an unknown job or an unknown status, rather than inventing a row', () => {
    expect(() => updateStatus(s, 'missing', STATUS.DRAFTED)).toThrow(/unknown job/);
    markSeen(s, job('a'));
    expect(() => updateStatus(s, 'a', 'invented')).toThrow(/unknown status/);
  });

  it('throws when a job has no id', () => {
    expect(() => markSeen(s, { job_id: '' })).toThrow(/no job_id/);
  });

  it('counts sightings in a window for the health canary', () => {
    const now = 100 * DAY;
    markSeen(s, job('old'), now - 3 * DAY);
    markSeen(s, job('new'), now - 2 * 60 * 60 * 1000);
    expect(countSince(s, now - DAY)).toBe(1);
    expect(countSince(s, now - 10 * DAY)).toBe(2);
  });

  it('summarises by status', () => {
    markSeen(s, job('a')); markSeen(s, job('b')); markSeen(s, job('c'));
    updateStatus(s, 'a', STATUS.DRAFTED);
    updateStatus(s, 'b', STATUS.REJECTED);
    expect(countByStatus(s)).toEqual({ drafted: 1, rejected: 1, seen: 1 });
  });

  it('prunes old records but never a drafted one', () => {
    const now = 200 * DAY;
    markSeen(s, job('old-rejected'), now - 150 * DAY);
    updateStatus(s, 'old-rejected', STATUS.REJECTED, {}, now - 150 * DAY);
    markSeen(s, job('old-drafted'), now - 150 * DAY);
    updateStatus(s, 'old-drafted', STATUS.DRAFTED, {}, now - 150 * DAY);
    markSeen(s, job('recent'), now - 5 * DAY);
    expect(prune(s, 120, now)).toBe(1);
    expect(hasSeen(s, 'old-rejected')).toBe(false);
    expect(hasSeen(s, 'old-drafted')).toBe(true);
    expect(hasSeen(s, 'recent')).toBe(true);
  });

  it('initialises the jobs map on a fresh static-data object', () => {
    expect(jobsOf({})).toEqual({});
    expect(() => jobsOf(null)).toThrow(/must be an object/);
  });
});
