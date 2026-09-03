/**
 * Thin fetch wrapper for the Messages API, used by the eval scripts.
 *
 * The workflow itself calls the API through n8n's HTTP Request node with the
 * request body these same builders produce - this file exists only so the
 * offline harness can send the identical body.
 */

const URL = 'https://api.anthropic.com/v1/messages';

export async function callAnthropic(body, apiKey, { retries = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const res = await fetch(URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (res.ok) return res.json();

    const text = await res.text();
    // 4xx other than 429 will not get better on retry - fail fast and loudly.
    if (res.status !== 429 && res.status < 500) {
      throw new Error(`Anthropic ${res.status}: ${text}`);
    }
    lastError = new Error(`Anthropic ${res.status}: ${text}`);
    const wait = Number(res.headers.get('retry-after')) * 1000 || 2000 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, wait));
  }
  throw lastError;
}

/** Run tasks with a concurrency cap, preserving input order in the results. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/** Per-model rates, USD per million tokens. Update when pricing moves. */
export const RATES = {
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  'claude-sonnet-5': { input: 2.0, output: 10.0 },
  'claude-opus-5': { input: 5.0, output: 25.0 },
};

export function costOf(model, usage) {
  const rate = RATES[model];
  if (!rate || !usage) return 0;
  const cacheRead = (usage.cache_read_input_tokens || 0) * rate.input * 0.1;
  const cacheWrite = (usage.cache_creation_input_tokens || 0) * rate.input * 1.25;
  const input = (usage.input_tokens || 0) * rate.input;
  const output = (usage.output_tokens || 0) * rate.output;
  return (input + output + cacheRead + cacheWrite) / 1e6;
}
