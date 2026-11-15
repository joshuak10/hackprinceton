// Load KEY=VALUE pairs from .env.local then .env (if present) into process.env.
// Never overrides variables that are already set. Returns the names loaded (never the values).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

// Other names accepted for a key, when the canonical name is not set: [canonical, alias].
// JEV_API_KEY is the name TypeSafe's own docs use for the Jev key.
export const KEY_ALIASES = [['TYPESAFE_API_KEY', 'JEV_API_KEY']];

export function loadEnv({ cwd = process.cwd(), files = ['.env.local', '.env'] } = {}) {
  const loaded = [];
  for (const f of files) {
    const p = join(cwd, f);
    if (!existsSync(p)) continue;
    const vars = parseEnv(readFileSync(p, 'utf8'));
    for (const [k, v] of Object.entries(vars)) {
      if (process.env[k] === undefined || process.env[k] === '') {
        process.env[k] = v;
        loaded.push(k);
      }
    }
  }
  for (const [name, alias] of KEY_ALIASES) {
    if (!hasKey(name) && hasKey(alias)) {
      process.env[name] = process.env[alias];
      loaded.push(name);
    }
  }
  return loaded;
}

export function hasKey(name) { return typeof process.env[name] === 'string' && process.env[name].trim().length > 0; }
