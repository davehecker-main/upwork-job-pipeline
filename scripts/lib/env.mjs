/** Minimal .env reader. Avoids a dependency for four variables. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './context.mjs';

export function loadEnv() {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) return process.env;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, '');
    if (value && !process.env[m[1]]) process.env[m[1]] = value;
  }
  return process.env;
}

export function requireEnv(name, hint) {
  loadEnv();
  const v = process.env[name];
  if (!v) {
    console.error(`\nMissing ${name}.${hint ? ` ${hint}` : ''}`);
    console.error('Set it in .env (see .env.example) or export it.\n');
    process.exit(2);
  }
  return v;
}
