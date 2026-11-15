// The saved results of the multi-day loop for one pool (docs/PROTOTYPE.md §21f), for GET /api/days.
// `swarm days … --out data/days/<name>.json` writes one file per command; a pool's results can be spread over
// several. This reads every file in that folder made from the pool and keeps one result per change label, the
// newest. It only reads, only inside the folder it is given, and leaves out the runs themselves (megabytes).
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const POOL_RE = /^pools\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.json$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.json$/;
const MAX_BYTES = 64 * 1024 * 1024;
const METRICS = ['visitsPerWeek', 'servedPerWeek', 'walkAwaysPerWeek', 'firstTimersPerWeek', 'avgWait', 'regulars', 'goodRemarksPerWeek', 'badRemarksPerWeek'];

// A pool is named by its path in the repository, as the days command takes it: "pools/<name>.json".
export const validPool = pool => typeof pool === 'string' && POOL_RE.test(pool) && !pool.includes('..');

const num = v => (Number.isFinite(v) ? v : null);
function effectsOf(raw) {
  const out = {};
  for (const k of METRICS) {
    const e = raw?.[k];
    if (!e || typeof e !== 'object') continue;
    out[k] = { before: num(e.before), after: num(e.after), mean: num(e.mean), min: num(e.min), max: num(e.max), agrees: e.agrees === true };
  }
  return out;
}

/**
 * @param {string} dir   the folder of saved results (data/days)
 * @param {string} pool  "pools/<name>.json"
 * @returns {Promise<{ pool: string, found: boolean, meta: object|null, results: object[] }>}
 *   results: one per change label, newest file first: { label, from, to, days, runs, provider, createdAt, file, effects }
 */
export async function savedDays(dir, pool) {
  if (!validPool(pool)) throw Object.assign(new Error('Name the pool as pools/<name>.json.'), { code: 'BAD_POOL' });
  let names = [];
  try { names = (await readdir(dir)).filter(n => FILE_RE.test(n)).sort(); } catch { /* nothing saved on this computer */ }
  const files = [];
  for (const name of names) {
    const file = join(dir, name);
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_BYTES) continue;
      const saved = JSON.parse(await readFile(file, 'utf8'));
      if (saved?.pool !== pool || !Array.isArray(saved.results)) continue;
      files.push({ name, saved, at: typeof saved.createdAt === 'string' ? saved.createdAt : info.mtime.toISOString() });
    } catch { /* a file that cannot be read is not a result */ }
  }
  files.sort((a, b) => b.at.localeCompare(a.at) || b.name.localeCompare(a.name));
  const byLabel = new Map();
  for (const { name, saved, at } of files) {
    for (const r of saved.results) {
      const label = typeof r?.change?.label === 'string' ? r.change.label : '';
      if (!label || byLabel.has(label)) continue;                 // the newest file's result for a label wins
      byLabel.set(label, {
        label, from: num(r.change.from), to: num(r.change.to),
        days: num(saved.days), runs: Array.isArray(saved.seeds) ? saved.seeds.length : null,
        provider: typeof saved.provider === 'string' ? saved.provider : null, createdAt: at, file: name,
        effects: effectsOf(r.effects)
      });
    }
  }
  const m = files[0]?.saved?.baselines?.[0]?.run?.meta;
  const meta = m && typeof m === 'object' ? {
    daysPerWeek: num(m.daysPerWeek), dayName: typeof m.dayName === 'string' ? m.dayName : null,
    regular: m.regular && typeof m.regular === 'object' ? { visits: num(m.regular.visits), days: num(m.regular.days) } : null,
    shopName: typeof m.shopName === 'string' ? m.shopName : null
  } : null;
  return { pool, found: byLabel.size > 0, meta, results: [...byLabel.values()] };
}
