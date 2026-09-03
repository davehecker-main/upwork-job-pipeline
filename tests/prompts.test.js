import { describe, expect, it } from 'vitest';
import { buildScoreRequest, parseScoreResponse, validateScore, SCORE_SCHEMA } from '../src/score-prompt.js';
import {
  buildDraftRequest, parseDraftResponse, checkDraft, wordCount, distinctiveTerms, withHeader,
} from '../src/draft-prompt.js';
import { renderJobCard, renderDraftMessage, renderHealthAlert, applyUrl } from '../src/slack-card.js';
import { normalizeUpworkJob as normalizeJob } from '../src/normalize-upwork.js';
import {
  SCORING_MODEL, DRAFTING_MODEL, SCORE_THRESHOLD, PROPOSAL_HEADER,
} from '../src/thresholds.js';

const job = normalizeJob({
  id: '01abc',
  url: 'https://www.upwork.com/jobs/x_~01abc',
  title: 'n8n workflow to sync Airtable and HubSpot',
  description: 'We need an n8n workflow that watches Airtable and creates HubSpot deals without duplicates.',
  job_type: 'hourly',
  budget_hourly_min: 45,
  budget_hourly_max: 80,
  duration: '1 to 3 months',
  skills: ['n8n', 'API Integration'],
  proposal_count: 8,
  published_date: '2026-09-03T19:45:02+0000',
  client: {
    verification_status: 'VERIFIED',
    total_spent: '$47,300.00',
    total_hires: 31,
    rating: 4.9,
    total_reviews: 20,
  },
});

const ctx = {
  rubric: '# Rubric\nClient credibility over posted budget.',
  profile: '# Profile\n25 years, ex-CTO.',
  proposalRules: '# Rules\nOpen with a specific observation.',
  examples: ['An example proposal.'],
};

describe('buildScoreRequest', () => {
  it('uses the scoring model and embeds the rubric in the system prompt', () => {
    const req = buildScoreRequest(job, ctx, { model: SCORING_MODEL });
    expect(req.model).toBe('claude-haiku-4-5');
    expect(req.system).toContain('Client credibility over posted budget');
    expect(req.max_tokens).toBe(1024);
  });

  it('puts every field the rubric needs into the user turn', () => {
    const content = buildScoreRequest(job, ctx).messages[0].content;
    expect(content).toContain('n8n workflow to sync Airtable and HubSpot');
    expect(content).toContain('$45-$80/hr');
    expect(content).toContain('$47300 lifetime spend');
    expect(content).toContain('31 hires');
    expect(content).toContain('Proposals so far: 8');
    expect(content).toContain('without duplicates');
  });

  it('defaults to structured outputs', () => {
    const req = buildScoreRequest(job, ctx);
    expect(req.output_config.format).toEqual({ type: 'json_schema', schema: SCORE_SCHEMA });
    expect(req.tools).toBeUndefined();
  });

  it('omits integer bounds the API rejects, and enforces them in code instead', () => {
    expect(SCORE_SCHEMA.properties.score.minimum).toBeUndefined();
    expect(SCORE_SCHEMA.properties.score.maximum).toBeUndefined();
    expect(SCORE_SCHEMA.properties.score.description).toMatch(/0 to 100/);
    expect(() => validateScore({ score: 140, verdict: 'qualify' })).toThrow(/out of range/);
  });

  it('emits a strict forced tool in tool mode instead', () => {
    const req = buildScoreRequest(job, ctx, { mode: 'tool' });
    expect(req.output_config).toBeUndefined();
    expect(req.tools[0].strict).toBe(true);
    expect(req.tools[0].input_schema.additionalProperties).toBe(false);
    expect(req.tool_choice).toEqual({ type: 'tool', name: 'record_score' });
  });

  it('sends no cache breakpoint - the scoring prefix is too short to cache', () => {
    expect(JSON.stringify(buildScoreRequest(job, ctx))).not.toContain('cache_control');
  });

  it('says so out loud when no description text came back', () => {
    const bare = normalizeJob({ id: 'x', title: 'A title long enough' });
    expect(buildScoreRequest(bare, ctx).messages[0].content).toContain('no description text available');
  });

  it('warns the model that a truncated snippet is not vague scope', () => {
    const truncated = normalizeJob({
      id: 'x', title: 'A title long enough', description_snippet: 'We need an n8n flow that ...',
    });
    const content = buildScoreRequest(truncated, ctx).messages[0].content;
    expect(content).toContain('Do not treat the truncation as vague scope');
  });

  it('passes skills and duration through to the prompt', () => {
    const content = buildScoreRequest(job, ctx).messages[0].content;
    expect(content).toContain('Skills tagged: n8n, API Integration');
    expect(content).toContain('Duration: 1 to 3 months');
  });
});

describe('parseScoreResponse', () => {
  const good = { score: 82, verdict: 'qualify', reasoning: 'Strong fit.', red_flags: [] };

  it('reads a structured-output text block', () => {
    expect(parseScoreResponse({ content: [{ type: 'text', text: JSON.stringify(good) }] })).toEqual(good);
  });

  it('reads a tool_use block', () => {
    expect(parseScoreResponse({
      content: [{ type: 'tool_use', name: 'record_score', input: good }],
    })).toEqual(good);
  });

  it('tolerates a fenced code block', () => {
    const text = '```json\n' + JSON.stringify(good) + '\n```';
    expect(parseScoreResponse({ content: [{ type: 'text', text }] })).toEqual(good);
  });

  it('throws on a refusal rather than defaulting the score', () => {
    expect(() => parseScoreResponse({
      stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [],
    })).toThrow(/refused/);
  });

  it('throws on an empty or contentless response', () => {
    expect(() => parseScoreResponse(null)).toThrow(/empty/);
    expect(() => parseScoreResponse({ content: [] })).toThrow(/no text or tool_use/);
  });

  it('throws on an out-of-range score or unknown verdict', () => {
    expect(() => validateScore({ score: 140, verdict: 'qualify' })).toThrow(/out of range/);
    expect(() => validateScore({ score: 50, verdict: 'probably' })).toThrow(/unknown verdict/);
  });

  it('coerces a float score and a missing red_flags array', () => {
    expect(validateScore({ score: 71.6, verdict: 'maybe', reasoning: ' x ' }))
      .toEqual({ score: 72, verdict: 'maybe', reasoning: 'x', red_flags: [] });
  });
});

describe('buildDraftRequest', () => {
  const score = { score: 82, verdict: 'qualify', reasoning: 'Strong fit.', red_flags: ['thin history'] };

  it('uses the drafting model and caches the context-pack prefix', () => {
    const req = buildDraftRequest(job, ctx, { model: DRAFTING_MODEL, effort: 'low' });
    expect(req.model).toBe('claude-sonnet-5');
    expect(req.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(req.output_config.effort).toBe('low');
    expect(req.output_config.format.type).toBe('json_schema');
  });

  it('keeps the job out of the cached prefix', () => {
    const req = buildDraftRequest(job, ctx);
    expect(req.system[0].text).not.toContain('Airtable');
    expect(req.messages[0].content).toContain('Airtable');
  });

  it('includes profile, rules and style examples in the prefix', () => {
    const prefix = buildDraftRequest(job, ctx).system[0].text;
    expect(prefix).toContain('25 years, ex-CTO');
    expect(prefix).toContain('Open with a specific observation');
    expect(prefix).toContain('An example proposal.');
  });

  it('passes red flags as context but forbids raising them in the proposal', () => {
    const content = buildDraftRequest(job, ctx, { score }).messages[0].content;
    expect(content).toContain('thin history');
    expect(content).toContain('Do not raise these concerns');
  });

  it('stays structurally valid with no style examples yet', () => {
    const prefix = buildDraftRequest(job, { ...ctx, examples: [] }).system[0].text;
    expect(prefix).toContain('(none provided yet)');
  });
});

describe('the fixed proposal header', () => {
  it('carries the three credential lines verbatim', () => {
    expect(PROPOSAL_HEADER).toContain('100% Job Success & 5 Star Feedback');
    expect(PROPOSAL_HEADER).toContain('Expert-Vetted (Top 1% Of Upwork)');
    expect(PROPOSAL_HEADER).toContain('n8n Expert, Claude Certified');
    expect(PROPOSAL_HEADER.split('\n')).toHaveLength(3);
  });

  it('sits above the body, separated by a blank line', () => {
    const out = withHeader('The body starts here.', PROPOSAL_HEADER);
    expect(out.startsWith(PROPOSAL_HEADER)).toBe(true);
    expect(out).toContain('\n\nThe body starts here.');
  });

  it('is a no-op when no header is configured', () => {
    expect(withHeader('  body  ', '')).toBe('body');
    expect(withHeader('body', null)).toBe('body');
  });

  it('tells the model not to write its own header', () => {
    const prefix = buildDraftRequest(job, ctx).system[0].text;
    expect(prefix).toContain('prepended to your text automatically');
    expect(prefix).toContain('Do not write one');
  });

  it('is excluded from the word count, so the bounds still bind the writing', () => {
    const body = `Airtable. ${'word '.repeat(15)}done.`;
    const withIt = withHeader(body, PROPOSAL_HEADER);
    expect(wordCount(withIt)).toBeGreaterThan(wordCount(body));
    // checkDraft is always given the body, never the assembled text.
    expect(checkDraft({ proposal: body }, job, { minWords: 10, maxWords: 40, bannedOpeners: [] }))
      .toEqual([]);
  });
});

describe('parseDraftResponse', () => {
  it('returns the three fields, trimmed', () => {
    const payload = { proposal: '  text  ', specific_observation: 'Airtable', rate_note: ' $85/hr ' };
    expect(parseDraftResponse({ content: [{ type: 'text', text: JSON.stringify(payload) }] }))
      .toEqual({ proposal: 'text', specific_observation: 'Airtable', rate_note: '$85/hr' });
  });

  it('throws rather than posting an empty proposal to Slack', () => {
    expect(() => parseDraftResponse({
      content: [{ type: 'text', text: JSON.stringify({ proposal: '   ' }) }],
    })).toThrow(/empty proposal/);
  });

  it('throws on a refusal', () => {
    expect(() => parseDraftResponse({ stop_reason: 'refusal', content: [] })).toThrow(/refused/);
  });
});

describe('checkDraft', () => {
  const opts = { minWords: 10, maxWords: 40, bannedOpeners: ['I hope this message finds you well'] };
  const body = (n) => `${Array.from({ length: n }, () => 'word').join(' ')}.`;

  it('passes a draft that reuses a distinctive term from the posting', () => {
    expect(checkDraft({ proposal: `You mentioned Airtable. ${body(15)}` }, job, opts)).toEqual([]);
  });

  it('fails a draft with no term from the posting', () => {
    expect(checkDraft({ proposal: body(15) }, job, opts))
      .toContain('no distinctive term from the posting appears in the proposal');
  });

  it('fails on length in both directions', () => {
    expect(checkDraft({ proposal: 'Airtable' }, job, opts)[0]).toMatch(/too short/);
    expect(checkDraft({ proposal: `Airtable ${body(60)}` }, job, opts)[0]).toMatch(/too long/);
  });

  it('fails a banned opener even with correct capitalisation changed', () => {
    const p = `i hope this message finds you well. Airtable ${body(15)}`;
    expect(checkDraft({ proposal: p }, job, opts).some((f) => f.includes('banned opener'))).toBe(true);
  });

  it('fails a draft that trails off mid-sentence', () => {
    const trailing = `You mentioned Airtable. ${'word '.repeat(15)}so I know the gap between`;
    expect(checkDraft({ proposal: trailing }, job, opts))
      .toContain('does not end in a complete sentence');
    expect(checkDraft({ proposal: `Airtable ${'word '.repeat(15)}done.` }, job, opts))
      .not.toContain('does not end in a complete sentence');
  });

  it('fails markdown formatting, which Upwork renders literally', () => {
    expect(checkDraft({ proposal: `**Airtable** ${body(15)}` }, job, opts))
      .toContain('contains markdown formatting');
  });

  it('wordCount and distinctiveTerms behave on empty input', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount(null)).toBe(0);
    expect(distinctiveTerms('')).toEqual([]);
    expect(distinctiveTerms('the and for with')).toEqual([]);
  });
});

describe('slack rendering', () => {
  const score = { score: 82, verdict: 'qualify', reasoning: 'Strong fit.', red_flags: ['low budget'] };

  it('puts score, title link, budget, client and reasoning on the card', () => {
    const card = renderJobCard(job, score);
    expect(card).toContain('*82/100*');
    expect(card).toContain(`<${job.url}|${job.title}>`);
    expect(card).toContain('$45-$80/hr');
    expect(card).toContain('31 hires');
    expect(card).toContain('Strong fit.');
    expect(card).toContain('low budget');
  });

  it('uses a badge that reflects the threshold bands', () => {
    expect(renderJobCard(job, { ...score, score: 90 })).toContain('🟢');
    expect(renderJobCard(job, { ...score, score: SCORE_THRESHOLD })).toContain('🟡');
    expect(renderJobCard(job, { ...score, score: 40 })).toContain('🔴');
  });

  it('handles an untitled posting without rendering "undefined"', () => {
    const card = renderJobCard(normalizeJob({ id: 'x', url: 'u' }), score);
    expect(card).toContain('untitled posting');
    expect(card).not.toContain('undefined');
  });

  it('wraps the draft in a code block so Slack does not mangle it', () => {
    const msg = renderDraftMessage(job, { proposal: 'body', rate_note: '$85/hr' });
    expect(msg).toContain('```\nbody\n```');
    expect(msg).toContain('$85/hr');
  });

  it('builds the application-form link from the job ciphertext', () => {
    expect(applyUrl('https://www.upwork.com/jobs/~022095570890031119235'))
      .toBe('https://www.upwork.com/nx/proposals/job/~022095570890031119235/apply/');
    expect(applyUrl('https://example.com/no-ciphertext')).toBeNull();
    expect(applyUrl(null)).toBeNull();
  });

  it('puts the apply link in the draft message when there is one', () => {
    const msg = renderDraftMessage({ ...job, apply_url: 'https://x.test/apply' }, { proposal: 'body', rate_note: 'n' });
    expect(msg).toContain('Apply directly');
    expect(renderDraftMessage(job, { proposal: 'body', rate_note: 'n' })).not.toContain('Apply directly');
  });

  it('health alert names the likely causes in diagnosis order', () => {
    const alert = renderHealthAlert({ jobsLast24h: 0 });
    expect(alert).toContain('may be broken');
    expect(alert).toContain('OAuth token failed to refresh');
    expect(alert).toContain('GraphQL field names changed');
    expect(alert).toContain('verify-upwork-graphql');
  });
});
