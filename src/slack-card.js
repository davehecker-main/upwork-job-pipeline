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
  if (job.proposals != null) lines.push(`📊 ${job.proposals} proposals so far`);
  lines.push('', `_${score.reasoning}_`);
  if (score.red_flags && score.red_flags.length) {
    lines.push('', `⚠️ ${score.red_flags.join(' · ')}`);
  }
  return lines.join('\n');
}

/** The draft, posted as a threaded reply so the card stays scannable. */
export function renderDraftMessage(job, draft) {
  return [
    `*Draft proposal — ${job.title || 'untitled posting'}*`,
    '',
    '```',
    draft.proposal,
    '```',
    '',
    `💵 ${draft.rate_note}`,
    `🔗 <${job.url}|Open the posting to submit>`,
  ].join('\n');
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
