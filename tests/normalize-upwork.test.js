import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  normalizeUpworkJob, normalizeSearchResponse, isScorable, parseMoney, unfence,
  isTruncated, avgSpendPerHire, publishedSince, highWaterMark, SCHEMA_VERSION,
} from '../src/normalize-upwork.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'upwork-search.json'), 'utf8'));
const jobs = normalizeSearchResponse(fixture);
const byId = (suffix) => jobs.find((j) => j.job_id.endsWith(suffix));

describe('parseMoney', () => {
  it('parses Upwork\'s formatted currency strings', () => {
    expect(parseMoney('$25,875.82')).toBe(25876);
    expect(parseMoney('$0.00')).toBe(0);
    expect(parseMoney('50.0')).toBe(50);
  });

  it('returns null rather than 0 for absent data', () => {
    expect(parseMoney(null)).toBeNull();
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('not a number')).toBeNull();
  });
});

describe('unfence and isTruncated', () => {
  it('strips Upwork\'s untrusted-content tags', () => {
    expect(unfence('<untrusted_participant_content>\nhi there\n</untrusted_participant_content>'))
      .toBe('hi there');
  });

  it('detects the search API\'s truncation marker', () => {
    expect(isTruncated('a description that stops ...')).toBe(true);
    expect(isTruncated('a description that stops …')).toBe(true);
    expect(isTruncated('a complete description.')).toBe(false);
  });
});

describe('avgSpendPerHire', () => {
  it('exposes the churn-client signal raw hire count hides', () => {
    expect(avgSpendPerHire({ total_spent: '$7,628.15', total_hires: 193 })).toBe(40);
    expect(avgSpendPerHire({ total_spent: '$25,875.82', total_hires: 31 })).toBe(835);
  });

  it('is null when either side is missing, never 0 or Infinity', () => {
    expect(avgSpendPerHire({ total_spent: '$500', total_hires: 0 })).toBeNull();
    expect(avgSpendPerHire({ total_hires: 10 })).toBeNull();
    expect(avgSpendPerHire({})).toBeNull();
  });
});

describe('normalizeSearchResponse', () => {
  it('normalizes every job in a real-shaped response', () => {
    expect(jobs).toHaveLength(6);
    expect(jobs.every((j) => j.schema_version === SCHEMA_VERSION)).toBe(true);
    expect(jobs.every((j) => j.source === 'upwork')).toBe(true);
  });

  it('keeps a fixed-price budget and renders it', () => {
    const j = byId('0002');
    expect(j.budget_type).toBe('fixed');
    expect(j.budget_fixed).toBe(6000);
    expect(j.budget_display).toBe('$6000 fixed');
  });

  it('does not invent an hourly rate the search API never sends', () => {
    const j = byId('0003');
    expect(j.budget_type).toBe('hourly');
    expect(j.budget_fixed).toBeNull();
    expect(j.budget_hourly_min).toBeNull();
    expect(j.budget_display).toContain('client set a range');
  });

  it('distinguishes the three hourly budget kinds', () => {
    expect(byId('0005').budget_display).toBe('hourly, no rate stated');
    expect(byId('0006').budget_display).toBe('hourly, platform default range');
  });

  it('treats budget "0.0" on hourly as absent, not as a $0 budget', () => {
    expect(byId('0003').budget_fixed).toBeNull();
    expect(byId('0005').budget_fixed).toBeNull();
  });

  it('maps VERIFIED to a boolean', () => {
    expect(jobs.every((j) => j.client_payment_verified === true)).toBe(true);
    expect(normalizeUpworkJob({ id: 'x', title: 'title', client: { verification_status: 'NONE' } })
      .client_payment_verified).toBe(false);
  });

  it('survives a client with no rating, hires or reviews', () => {
    const j = byId('0004');
    expect(j.client_rating).toBeNull();
    expect(j.client_hires).toBeNull();
    expect(j.client_avg_spend_per_hire).toBeNull();
    expect(j.client_summary).toContain('never reviewed by a freelancer');
    expect(j.client_summary).toContain('$0 lifetime spend');
  });

  it('survives a posting with no skills array', () => {
    expect(byId('0005').skills).toEqual([]);
    expect(byId('0002').skills).toContain('Selenium');
  });

  it('reports missing proposal_count as null, not zero', () => {
    expect(byId('0001').proposals).toBeNull();
    expect(byId('0006').proposals).toBe(253);
  });

  it('unfences the description and flags truncation', () => {
    const j = byId('0001');
    expect(j.description).not.toContain('untrusted_participant_content');
    expect(j.description).toContain('invoice and payment tracking');
    expect(j.description_truncated).toBe(true);
    expect(byId('0005').description_truncated).toBe(false);
  });

  it('lowercases the experience level enum', () => {
    expect(byId('0002').experience_level).toBe('expert');
    expect(byId('0005').experience_level).toBe('entry_level');
  });

  it('accepts country as a name or an ISO-3 code without mangling either', () => {
    expect(byId('0001').client_country).toBe('ARE');
    expect(byId('0006').client_country).toBe('United States');
  });

  it('surfaces spend-per-hire in the client summary the prompt reads', () => {
    expect(byId('0001').client_summary).toContain('~$40 per hire');
    expect(byId('0002').client_summary).toContain('~$835 per hire');
  });

  it('is idempotent', () => {
    const once = normalizeUpworkJob(fixture.jobs[1]);
    expect(normalizeUpworkJob(once)).toEqual(once);
  });

  it('drops nothing scorable and rejects junk', () => {
    expect(isScorable(byId('0001'))).toBe(true);
    expect(isScorable(normalizeUpworkJob({}))).toBe(false);
    expect(normalizeSearchResponse({})).toEqual([]);
    expect(normalizeSearchResponse(null)).toEqual([]);
  });
});

describe('recency windowing (there is no created_after filter server-side)', () => {
  it('keeps only jobs published after the high-water mark', () => {
    const recent = publishedSince(jobs, '2026-09-01T00:00:00+0000');
    expect(recent).toHaveLength(4);
    expect(recent.every((j) => j.published_date > '2026-09-01T00:00:00+0000')).toBe(true);
  });

  it('passes everything through when there is no mark yet (first run)', () => {
    expect(publishedSince(jobs, null)).toHaveLength(6);
  });

  it('computes the next mark from the newest job in the batch', () => {
    expect(highWaterMark(jobs)).toBe('2026-09-03T20:06:31+0000');
  });

  it('keeps the old mark when a poll returns nothing', () => {
    expect(highWaterMark([], '2026-09-03T20:06:31+0000')).toBe('2026-09-03T20:06:31+0000');
  });
});
