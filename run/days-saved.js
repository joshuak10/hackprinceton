// The saved results of the multi-day loop for one pool (docs/PROTOTYPE.md §21f), for GET /api/days.
// `swarm days … --out data/days/<name>.json` writes one file per command; a pool's results can be spread over
// several. This reads every file in that folder made from the pool and keeps one result per change label, the
// newest. It only reads, only inside the folder it is given, and leaves out the runs themselves (megabytes).
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

// One run of the loop as numbers per day, for the owner's view (§21g): people seated, of whom new, people turned
// away, money taken, and minutes waited by the people seated. A new customer is one of a kind the pool marks as
// new to the place (`newcomer`: a first date, a walk-in, a student treating herself), the same rule the map uses
// to colour people, so the picture and the number agree. `newcomers` is a Set of those kinds' ids.
export function daySeries(run, newcomers = new Set()) {
  const days = (run?.days || []).map(d => ({ seated: 0, fresh: 0, away: Number(d.left) || 0, revenue: 0, waited: 0 }));
  for (const person of run?.people || []) {
    const fresh = newcomers.has(person.persona);
    for (const v of person.visits || []) {
      const d = days[v.day];
      if (!d || v.outcome !== 'served') continue;
      d.seated++;
      if (fresh) d.fresh++;
      d.revenue += Number(v.paid) || 0;
      d.waited += Number(v.wait) || 0;
    }
  }
  return days;
}

// The average meal in minutes across the business's seats, as the world has it and with a change made to the
// first place: "2 more seats (…)" or "Meals 15% quicker (…)" (the labels run/days.js writes).
export function mealMinutes(world, placeIds, label = '') {
  const places = (placeIds || []).map(id => (world?.nodes || []).find(n => n.id === id)).filter(Boolean)
    .map(n => ({ seats: Number(n.servers) || 0, minutes: Number(n.serviceTime) || 0 }));
  if (!places.length) return null;
  const more = /^(\d+) more seat/.exec(label), quicker = /(\d+)% quicker/.exec(label);
  if (more) places[0].seats += Number(more[1]);
  if (quicker) places[0].minutes *= 1 - Number(quicker[1]) / 100;
  const seats = places.reduce((s, p) => s + p.seats, 0);
  return seats ? places.reduce((s, p) => s + p.seats * p.minutes, 0) / seats : null;
}

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
export async function savedDays(dir, pool, { root = null } = {}) {
  if (!validPool(pool)) throw Object.assign(new Error('Name the pool as pools/<name>.json.'), { code: 'BAD_POOL' });
  // The pool itself, when the repository is given: who is new to the place, and how long a meal takes.
  let poolFile = null, world = null;
  if (root) {
    poolFile = await readFile(join(root, pool), 'utf8').then(JSON.parse).catch(() => null);
    const w = typeof poolFile?.world === 'string' && /^worlds\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.json$/.test(poolFile.world) ? poolFile.world : null;
    world = w ? await readFile(join(root, w), 'utf8').then(JSON.parse).catch(() => null) : null;
  }
  const placeIds = Array.isArray(poolFile?.places) ? poolFile.places.map(String) : poolFile?.shop ? [String(poolFile.shop)] : [];
  const newcomers = Object.entries(poolFile?.people || {}).filter(([, p]) => p?.newcomer === true).map(([id]) => id);
  const newSet = new Set(newcomers);
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
        effects: effectsOf(r.effects),
        // Per run and per day, before and after, on the same runs (§21g).
        series: { base: (saved.baselines || []).map(b => daySeries(b.run, newSet)), after: (r.arms || []).map(a => daySeries(a.run, newSet)) },
        meal: world ? { base: mealMinutes(world, placeIds), after: mealMinutes(world, placeIds, label) } : null
      });
    }
  }
  const m = files[0]?.saved?.baselines?.[0]?.run?.meta;
  const meta = m && typeof m === 'object' ? {
    daysPerWeek: num(m.daysPerWeek), dayName: typeof m.dayName === 'string' ? m.dayName : null,
    regular: m.regular && typeof m.regular === 'object' ? { visits: num(m.regular.visits), days: num(m.regular.days) } : null,
    shopName: typeof m.shopName === 'string' ? m.shopName : null
  } : null;
  return { pool, found: byLabel.size > 0, meta, newcomers, results: [...byLabel.values()] };
}
