/**
 * Repo root, and the context pack the prompts read.
 *
 * The context pack is the editable half of this pipeline: rubric, profile,
 * proposal rules and style examples live as markdown under context/ so tuning
 * the system is a reviewable diff rather than a code change.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readContextPack() {
  const read = (p) => readFileSync(join(ROOT, 'context', p), 'utf8').trim();
  const exampleDir = join(ROOT, 'context', 'examples');
  const examples = readdirSync(exampleDir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()
    .map((f) => readFileSync(join(exampleDir, f), 'utf8').trim());

  return {
    rubric: read('rubric.md'),
    profile: read('profile.md'),
    proposalRules: read('proposal-rules.md'),
    examples,
  };
}

/** Banned openers are parsed out of the rules doc so the list lives in one place. */
export function bannedOpeners(pack) {
  return (pack.proposalRules.match(/^- "(.+)"$/gm) || [])
    .map((l) => l.replace(/^- "/, '').replace(/"$/, ''));
}
