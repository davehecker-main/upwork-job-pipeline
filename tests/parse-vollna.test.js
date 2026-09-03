import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { htmlToText, parseVollnaEmail } from '../src/parse-vollna.js';
import { normalizeJob, isScorable, SCHEMA_VERSION } from '../src/normalize.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');
const parseHtml = (name, subject = 'Vollna alert') =>
  parseVollnaEmail({ subject, html: fixture(name) });

describe('parseVollnaEmail', () => {
  it('extracts a single job with hourly range and full client stats', () => {
    const jobs = parseHtml('single-job.html');
    expect(jobs).toHaveLength(1);
    const j = jobs[0];
    expect(j.job_id).toBe('021847392017465829301');
    expect(j.title).toBe('n8n Workflow Automation Specialist Needed');
    expect(j.budget_type).toBe('hourly');
    expect(j.budget_hourly_min).toBe(45);
    expect(j.budget_hourly_max).toBe(80);
    expect(j.client_payment_verified).toBe(true);
    expect(j.client_total_spent).toBe(47300);
    expect(j.client_hires).toBe(31);
    expect(j.client_jobs_posted).toBe(12);
    expect(j.client_rating).toBe(4.9);
    expect(j.client_country).toBe('United States');
    expect(j.proposals).toBe(8);
    expect(j.experience_level).toBe('intermediate');
    expect(j.description).toMatch(/Airtable/);
    expect(j.description).toMatch(/without creating duplicates/);
  });

  it('does not emit a second record for the repeated "Apply now" link', () => {
    expect(parseHtml('single-job.html')).toHaveLength(1);
  });

  it('splits a digest into one record per job, in order', () => {
    const jobs = parseHtml('digest-three-jobs.html');
    expect(jobs).toHaveLength(3);
    expect(jobs.map((j) => j.job_id)).toEqual([
      '010000000000000000001',
      '010000000000000000002',
      '010000000000000000003',
    ]);
    expect(jobs[0].title).toBe('Claude Code onboarding for our dev team');
    expect(jobs[0].budget_type).toBe('fixed');
    expect(jobs[0].budget_fixed).toBe(2500);
    expect(jobs[0].client_total_spent).toBe(128000); // "$128k" suffix expanded
    expect(jobs[2].budget_type).toBe('hourly');
    expect(jobs[2].budget_hourly_min).toBe(15);
  });

  it('keeps each job\'s fields inside its own segment', () => {
    const [claude, ninja, wordpress] = parseHtml('digest-three-jobs.html');
    expect(claude.proposals).toBe(14);
    expect(ninja.proposals).toBe(61);
    expect(wordpress.proposals).toBe(22);
    expect(ninja.client_payment_verified).toBe(false);
    expect(ninja.client_total_spent).toBeNull();
    expect(wordpress.client_rating).toBe(4.6);
  });

  it('handles a posting with no budget stated', () => {
    const [j] = parseHtml('no-budget.html');
    expect(j.budget_type).toBe('unknown');
    expect(j.budget_fixed).toBeNull();
    expect(j.budget_hourly_min).toBeNull();
    expect(j.client_total_spent).toBe(9850);
  });

  it('returns [] for an alert with no job links, without throwing', () => {
    expect(parseHtml('malformed-no-jobs.html')).toEqual([]);
  });

  it('returns [] for garbage input, without throwing', () => {
    expect(parseVollnaEmail({ text: fixture('garbage.txt') })).toEqual([]);
    expect(parseVollnaEmail({})).toEqual([]);
    expect(parseVollnaEmail(null)).toEqual([]);
    expect(parseVollnaEmail({ html: '' })).toEqual([]);
  });

  it('prefers the plain-text part when the email has one', () => {
    const jobs = parseVollnaEmail({
      text: 'Automate something <https://www.upwork.com/jobs/x_~010000000000000000009>\nBudget: $900',
      html: fixture('single-job.html'),
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].budget_fixed).toBe(900);
  });

  it('carries the alert subject through, so the source filter is traceable', () => {
    const [j] = parseHtml('single-job.html', 'New match: n8n Automation Jobs');
    expect(j.alert_subject).toBe('New match: n8n Automation Jobs');
  });
});

describe('htmlToText', () => {
  it('renders anchors as "label <href>" so titles stay next to their URL', () => {
    const text = htmlToText('<a href="https://x.test/a">Click me</a>');
    expect(text).toBe('Click me <https://x.test/a>');
  });

  it('decodes the entities these emails actually use', () => {
    expect(htmlToText('<p>A &amp; B &middot; C &mdash; D &nbsp;E</p>')).toBe('A & B . C - D E');
  });

  it('drops script and style content', () => {
    expect(htmlToText('<style>p{color:red}</style><p>hi</p>')).toBe('hi');
  });

  it('is safe on empty and nullish input', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText(null)).toBe('');
    expect(htmlToText(undefined)).toBe('');
  });
});

describe('normalizeJob', () => {
  const raw = () => parseHtml('single-job.html')[0];

  it('produces the canonical shape with derived display fields', () => {
    const j = normalizeJob(raw());
    expect(j.schema_version).toBe(SCHEMA_VERSION);
    expect(j.budget_display).toBe('$45-$80/hr');
    expect(j.client_summary).toContain('payment verified');
    expect(j.client_summary).toContain('$47300 total spent');
    expect(j.client_summary).toContain('31 hires');
    expect(j.client_summary).toContain('4.9/5 rating');
  });

  it('drops the raw segment so it never reaches a prompt or a Data Table row', () => {
    expect(normalizeJob(raw()).raw_segment).toBeUndefined();
  });

  it('is idempotent', () => {
    const once = normalizeJob(raw());
    expect(normalizeJob(once)).toEqual(once);
  });

  it('gives a stable job_id across two alerts about the same posting', () => {
    const a = normalizeJob(raw());
    const b = normalizeJob(parseVollnaEmail({
      subject: 'resend',
      html: fixture('single-job.html').replace('8 proposals', '19 proposals'),
    })[0]);
    expect(b.job_id).toBe(a.job_id);
    expect(b.proposals).toBe(19);
  });

  it('describes a missing budget honestly rather than inventing zero', () => {
    const j = normalizeJob(parseHtml('no-budget.html')[0]);
    expect(j.budget_display).toBe('not stated');
    expect(j.budget_fixed).toBeNull();
  });

  it('survives an empty object', () => {
    const j = normalizeJob({});
    expect(j.job_id).toBe('');
    expect(j.budget_display).toBe('not stated');
    expect(isScorable(j)).toBe(false);
  });

  it('isScorable requires an id and a usable title', () => {
    expect(isScorable(normalizeJob(raw()))).toBe(true);
    expect(isScorable(normalizeJob({ job_id: 'x', title: 'short' }))).toBe(false);
  });
});
