import { describe, expect, it } from 'vitest';
import { buildScoreRequest, parseScoreResponse, validateScore, SCORE_SCHEMA } from '../src/score-prompt.js';
import { buildDraftRequest, parseDraftResponse, checkDraft, wordCount, distinctiveTerms } from '../src/draft-prompt.js';
import { renderJobCard, renderDraftMessage, renderHealthAlert } from '../src/slack-card.js';
import { normalizeJob } from '../src/normalize.js';
import { SCORING_MODEL, DRAFTING_MODEL, SCORE_THRESHOLD } from '../src/thresholds.js';

const job = normalizeJob({
  job_id: '01abc',
  url: 'https://www.upwork.com/jobs/x_~01abc',
  title: 'n8n workflow to sync Airtable and HubSpot',
  description: 'We need an n8n workflow that watches Airtable and creates HubSpot deals without duplicates.',
  budget_type: 'hourly',
  budget_hourly_min: 45,
  budget_hourly_max: 80,
  client_payment_verified: true,
  client_total_spent: 47300,
  client_hires: 31,
  client_rating: 4.9,
  proposals: 8,
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
    expect(content).toContain('$47300 total spent');
    expect(content).toContain('31 hires');
    expect(content).toContain('Proposals so far: 8');
    expect(content).toContain('without duplicates');
  });

  it('defaults to structured outputs', () => {
    const req = buildScoreRequest(job, ctx);
    expect(req.output_config.format).toEqual({ type: 'json_schema', schema: SCORE_SCHEMA });
    expect(req.tools).toBeUndefined();
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

  it('says so out loud when the alert carried no description', () => {
    const bare = normalizeJob({ job_id: 'x', title: 'A title long enough' });
    expect(buildScoreRequest(bare, ctx).messages[0].content).toContain('no description captured');
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
  const body = (n) => Array.from({ length: n }, () => 'word').join(' ');

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
    const card = renderJobCard(normalizeJob({ job_id: 'x', url: 'u' }), score);
    expect(card).toContain('untitled posting');
    expect(card).not.toContain('undefined');
  });

  it('wraps the draft in a code block so Slack does not mangle it', () => {
    const msg = renderDraftMessage(job, { proposal: 'body', rate_note: '$85/hr' });
    expect(msg).toContain('```\nbody\n```');
    expect(msg).toContain('$85/hr');
  });

  it('health alert names the likely causes in diagnosis order', () => {
    const alert = renderHealthAlert({ jobsLast24h: 0 });
    expect(alert).toContain('may be broken');
    expect(alert).toContain('app password');
    expect(alert).toContain('template changed');
  });
});
