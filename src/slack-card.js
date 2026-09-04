/**
 * Render the Slack approval message for a scored job.
 *
 * Kept out of the n8n node's expression field on purpose: message text is the
 * part of this pipeline Dave will fiddle with most, and here it is testable and
 * reviewable in a diff.
 */

function scoreBadge(score) {
  if (score >= 85) return '🟢';
  if (score >= 70) return '🟡';
  return '🔴';
}

/** @returns {string} Slack mrkdwn */
export function renderJobCard(job, score) {
  const lines = [
    `${scoreBadge(score.score)} *${score.score}/100* · ${score.verdict}`,
    `*<${job.url}|${job.title || 'untitled posting'}>*`,
    `💰 ${job.budget_display}   👤 ${job.client_summary}`,
  ];
  const facts = [];
  if (job.proposals != null) facts.push(`📊 ${job.proposals} proposals so far`);
  // Connects are what applying actually costs. Knowing it on the card is the
  // difference between "worth a look" and "worth 20 connects".
  if (job.connects_cost != null) facts.push(`🎟️ ${job.connects_cost} connects to apply`);
  if (job.preferred_locations && job.preferred_locations.length) {
    facts.push(`📍 client prefers ${job.preferred_locations.join(', ')}`);
  }
  if (facts.length) lines.push(facts.join('   '));
  lines.push('', `_${score.reasoning}_`);
  if (score.red_flags && score.red_flags.length) {
    lines.push('', `⚠️ ${score.red_flags.join(' · ')}`);
  }
  return lines.join('\n');
}

/**
 * The draft, posted as a threaded reply so the card stays scannable.
 * `draft.proposal` is expected to already carry the fixed header - the code
 * block must contain exactly what gets pasted into Upwork, nothing added or
 * withheld at render time.
 */
export function renderDraftMessage(job, draft) {
  return [
    `*Draft proposal — ${job.title || 'untitled posting'}*`,
    '',
    '```',
    draft.proposal,
    '```',
    '',
    `💵 ${draft.rate_note}`,
    `🔗 <${job.url}|Open the posting>`,
    job.apply_url ? `📝 <${job.apply_url}|Apply directly> — paste the text above` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Upwork's application form for a job. Opening it is free; Connects are charged
 * only on submit, and the same amount whichever route you submit through.
 * Built from the ~ciphertext, which is what the job URL carries.
 */
export function applyUrl(jobUrl) {
  const m = String(jobUrl || '').match(/~([0-9a-zA-Z]{12,})/);
  return m ? `https://www.upwork.com/nx/proposals/job/~${m[1]}/apply/` : null;
}

export function renderHealthAlert({ jobsLast24h, windowHours = 24 }) {
  return [
    '🚨 *Upwork pipeline may be broken*',
    `The daily canary search returned ${jobsLast24h} jobs (expected at least 1).`,
    'Likely causes, in order: the Upwork OAuth token failed to refresh, the',
    'GraphQL field names changed under us, or the search query itself now matches',
    'nothing. Check the n8n executions list, then run',
    '`node scripts/verify-upwork-graphql.mjs` locally - it names any field the',
    'API has started rejecting.',
  ].join('\n');
}
