/**
 * Parse a Vollna job-alert email into raw job records.
 *
 * Pure: no I/O, no globals, no dependencies. This module is unit tested by
 * vitest AND inlined verbatim into the n8n "parse" Code node by
 * scripts/build-workflow.mjs, so it must stay dependency free.
 *
 * A Vollna alert can carry several jobs in one email. Segmentation is driven by
 * Upwork job URLs: every job in the digest links to one, and the ~token in that
 * URL is the only identifier Upwork guarantees to be stable, which makes it the
 * right dedupe key.
 *
 * Field extraction is deliberately pattern-table driven. Vollna's template will
 * change eventually; when it does, the fix belongs in FIELD_PATTERNS and a new
 * fixture under tests/fixtures/, not in the control flow below.
 */

// The ~token is the stable Upwork job id. Vollna wraps job links in tracking
// redirects often enough that we look for the token anywhere in the URL.
const JOB_URL_RE =
  /https?:\/\/(?:[\w.-]*\.)?upwork\.com\/[^\s"'<>)\]]*?~([0-9a-zA-Z]{12,})/g;

const FIELD_PATTERNS = {
  fixedBudget: /(?:budget|fixed[\s-]*price)\D{0,16}\$\s*([\d,]+(?:\.\d{1,2})?)/i,
  hourlyRange:
    /\$\s*([\d,.]+)\s*(?:-|–|—|to)\s*\$\s*([\d,.]+)\s*(?:\/|\s)?\s*(?:hr|hour)/i,
  hourlySingle: /\$\s*([\d,.]+)\s*(?:\/|\s)?\s*(?:hr|hour)\b/i,
  clientSpend: /\$\s*([\d,.]+)\s*([KkMm])?\+?\s*(?:total\s+)?spent/i,
  clientHires: /(\d+)\s+hires?\b/i,
  clientRating: /\b([0-5](?:\.\d{1,2})?)\s*(?:\/\s*5|stars?\b|\brating)/i,
  clientJobsPosted: /(\d+)\s+jobs?\s+posted/i,
  paymentVerified: /payment\s*(?:method\s*)?verified/i,
  proposals: /(\d+)\s+proposals?\b/i,
  country: /(?:country|location)\s*[:\-]\s*([A-Za-z][A-Za-z .'-]{1,40})/i,
  postedAt: /posted\s*(?:on)?\s*[:\-]?\s*([A-Za-z0-9,:\s/+-]{4,40}?)(?:\r?\n|$)/i,
  experienceLevel: /\b(entry[\s-]*level|intermediate|expert)\b/i,
};

// Lines that are chrome, not content: Vollna footer, unsubscribe, filter names.
const CHROME_RE =
  /^(?:unsubscribe|manage (?:your )?(?:alerts|filters)|vollna|view (?:this )?job|apply now|powered by|you (?:are )?receiv|this email|sent to|filter:|\W*$)/i;

/** Decode the handful of HTML entities that actually show up in these emails. */
function decodeEntities(s) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"',
    hellip: '...', middot: '.', bull: '*',
  };
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in named ? named[n.toLowerCase()] : m));
}

/**
 * Flatten an HTML email body to text, rendering anchors as `label <href>` so a
 * job's title and its URL survive on the same line. That adjacency is what the
 * title extraction below relies on.
 *
 * The href is parked behind control-character sentinels while the remaining
 * tags are stripped, because an already-rewritten `<https://...>` is itself
 * tag-shaped and would otherwise be deleted by the strip pass.
 */
export function htmlToText(html) {
  if (!html) return '';
  return decodeEntities(
    String(html)
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
        (_, href, label) => ` ${label.replace(/<[^>]*>/g, ' ')} \u0001${href}\u0002 `)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|table|td)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\u0001/g, '<')
      .replace(/\u0002/g, '>')
  )
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function toNumber(raw, suffix) {
  if (raw == null) return null;
  const n = Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = suffix ? { k: 1e3, m: 1e6 }[String(suffix).toLowerCase()] || 1 : 1;
  return n * mult;
}

function match(segment, key) {
  const m = segment.match(FIELD_PATTERNS[key]);
  return m || null;
}

/**
 * Pick the job description out of a segment: the longest run of prose that is
 * not a label line, not chrome, and not the title itself.
 */
function extractDescription(segment, title) {
  const candidates = segment
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 60)
    .filter((l) => !CHROME_RE.test(l))
    .filter((l) => l !== title)
    .filter((l) => !/^\w[\w ]{0,20}:\s*\S/.test(l) || l.length > 140);
  if (!candidates.length) return '';
  return candidates.sort((a, b) => b.length - a.length)[0];
}

/**
 * Title = the text preceding the job URL on its own line. Falls back to the
 * previous non-chrome line, which is where Vollna puts it when the link markup
 * wraps.
 */
function extractTitle(segment, url) {
  const lines = segment.split('\n');
  const idx = lines.findIndex((l) => l.includes(url));
  if (idx === -1) return '';
  const inline = lines[idx].split(`<${url}>`)[0].replace(url, '').trim();
  const clean = (s) => s.replace(/[\s|>·•\-]+$/, '').replace(/^[\s|<·•\-]+/, '').trim();
  if (clean(inline).length >= 8) return clean(inline);
  for (let i = idx - 1; i >= 0 && i >= idx - 3; i -= 1) {
    const prev = clean(lines[i]);
    if (prev.length >= 8 && !CHROME_RE.test(prev)) return prev;
  }
  return clean(inline);
}

/**
 * @param {{subject?: string, text?: string, html?: string}} email
 * @returns {Array<object>} raw job records; [] when nothing parseable is found.
 *                          Never throws - a malformed email must not stall the
 *                          workflow, it must fall through to the WF3 canary.
 */
export function parseVollnaEmail(email) {
  const source = email && typeof email === 'object' ? email : {};
  const body = source.text && source.text.trim()
    ? String(source.text)
    : htmlToText(source.html);
  if (!body) return [];

  const hits = [];
  JOB_URL_RE.lastIndex = 0;
  let m;
  while ((m = JOB_URL_RE.exec(body)) !== null) {
    hits.push({ url: m[0], jobId: m[1], index: m.index });
    if (hits.length > 200) break; // pathological input guard
  }
  if (!hits.length) return [];

  // One segment per job: from the start of the line holding this job's URL to
  // the start of the line holding the next one.
  const lineStart = (i) => body.lastIndexOf('\n', i) + 1;
  const seen = new Set();
  const jobs = [];

  for (let i = 0; i < hits.length; i += 1) {
    const hit = hits[i];
    if (seen.has(hit.jobId)) continue; // Vollna repeats the link in "Apply now"
    seen.add(hit.jobId);
    const from = lineStart(hit.index);
    const nextNew = hits.slice(i + 1).find((h) => !seen.has(h.jobId));
    const to = nextNew ? lineStart(nextNew.index) : body.length;
    const segment = body.slice(from, to);

    const title = extractTitle(segment, hit.url);
    const hourly = match(segment, 'hourlyRange');
    const hourlyOne = hourly ? null : match(segment, 'hourlySingle');
    const fixed = match(segment, 'fixedBudget');
    const spend = match(segment, 'clientSpend');
    const rating = match(segment, 'clientRating');

    jobs.push({
      job_id: hit.jobId,
      url: hit.url,
      title,
      description: extractDescription(segment, title),
      budget_type: hourly || hourlyOne ? 'hourly' : fixed ? 'fixed' : 'unknown',
      budget_fixed: fixed ? toNumber(fixed[1]) : null,
      budget_hourly_min: hourly ? toNumber(hourly[1]) : hourlyOne ? toNumber(hourlyOne[1]) : null,
      budget_hourly_max: hourly ? toNumber(hourly[2]) : hourlyOne ? toNumber(hourlyOne[1]) : null,
      client_total_spent: spend ? toNumber(spend[1], spend[2]) : null,
      client_hires: match(segment, 'clientHires') ? Number(match(segment, 'clientHires')[1]) : null,
      client_jobs_posted: match(segment, 'clientJobsPosted')
        ? Number(match(segment, 'clientJobsPosted')[1]) : null,
      client_rating: rating ? Number(rating[1]) : null,
      client_payment_verified: Boolean(match(segment, 'paymentVerified')),
      client_country: match(segment, 'country') ? match(segment, 'country')[1].trim() : null,
      proposals: match(segment, 'proposals') ? Number(match(segment, 'proposals')[1]) : null,
      experience_level: match(segment, 'experienceLevel')
        ? match(segment, 'experienceLevel')[1].toLowerCase() : null,
      posted_at_raw: match(segment, 'postedAt') ? match(segment, 'postedAt')[1].trim() : null,
      alert_subject: source.subject ? String(source.subject) : null,
      raw_segment: segment,
    });
  }

  return jobs;
}
