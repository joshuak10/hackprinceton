// Where runs come from: precomputed mock RunBundles (data/ first, then mock/), or runs recorded by the engine
// and served by `node bin/swarm.js serve` (docs/PROTOTYPE.md §9, §9b).
import { isEngineRun, adaptEngineRun } from './engine.js';

async function getJson(url, { timeoutMs = 0 } = {}) {
  const ctrl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-cache' });
    if (!res.ok) {
      // Drop the unread error body, so the request ends and the network can go idle (an optional file that
      // is missing, such as a run's incidents, answers 404 with a body nobody reads).
      await res.body?.cancel().catch(() => {});
      throw Object.assign(new Error(`${url} answered ${res.status}`), { status: res.status });
    }
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function normalizeBundle(b) {
  const bundle = { ...b };
  bundle.geometry = b.geometry || b.spec?.geometry;
  if (!bundle.geometry) throw new Error('This run has no geometry (spec.geometry), so there is nothing to draw it on.');
  bundle.decisions = b.decisions || [];
  bundle.remarks = b.remarks || [];
  bundle.agents = b.agents || [];
  return bundle;
}

// The places the display offers (?case=<id>): the building, the parking lot sample and the sushi restaurant. They
// are picked from the card under the prompt box, or from Run details. The parking lot is sample data only.
const CASE_IDS = ['building', 'parking', 'sushi'];

export async function loadCases() {
  const mock = await getJson('mock/index.json').catch(() => ({ cases: {} }));
  const data = await getJson('data/index.json').catch(() => ({ cases: {} }));
  const cases = {};
  for (const id of CASE_IDS) {
    const c = data.cases?.[id] || mock.cases?.[id];
    if (c) cases[id] = { id, ...c };
  }
  return cases;
}

export async function loadConfig() {
  return getJson('data/config.json').catch(() => ({}));
}

const bundles = new Map();
export function loadBundle(file) {
  // A case file is either a mock bundle with its own geometry or a recorded engine run packed into one file.
  const open = raw => (isEngineRun(raw) ? adaptEngineRun(raw) : normalizeBundle(raw));
  if (!bundles.has(file)) bundles.set(file, getJson(file).then(open).catch(err => { bundles.delete(file); throw err; }));
  return bundles.get(file);
}

// ---------- engine server (node bin/swarm.js serve) ----------

export async function apiHealth() {
  try {
    const h = await getJson('/api/health', { timeoutMs: 800 });
    return h && h.ok ? h : null;
  } catch {
    return null;
  }
}

// Recorded runs of one place (visit mode with walls), newest first, as { runs: [{ meta, spec }], metas, worlds }.
// `metas` is every finished run's meta.json, including each run's test link (meta.link, §9b).
// `title` keeps only runs of the world with that title (a case's runTitle, or a world opened with ?place=); without
// it the runs are the building's. `notTitles` are the worlds of the cases that have a title: they are never the
// building's, so one place's many runs cannot push another place's runs off the list.
// `home` is the title of the building's own world, when its case names one (homeTitle).
// `worlds` says which recorded walled worlds are which, as { building: [...], others: [...] } of
// { title, placeName }: `others` are neither a titled case nor the building, and open with ?place=<title>.
export async function apiBuildingRuns({ max = 18, title = null, notTitles = [], home = null } = {}) {
  const metas = await getJson('/api/runs');
  const visits = metas.filter(m => m.status === 'done' && m.mode === 'visit')
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const specs = new Map();
  const specOf = async meta => {
    if (!specs.has(meta.runId)) specs.set(meta.runId, await getJson(`/api/runs/${encodeURIComponent(meta.runId)}/spec`).catch(() => null));
    return specs.get(meta.runId);
  };
  const walled = spec => Boolean(spec && Array.isArray(spec.walls) && spec.walls.length);
  // Other walled worlds recorded on this machine (a waiting room drawn by hand, say) must not take the building's
  // place just by being newer: when any recorded world came from a Matterport floor plan, only those worlds are the
  // building. Each world is looked at once, by the newest run with its title.
  const firstOf = new Map();
  for (const m of visits) if (!notTitles.includes(m.title) && !firstOf.has(m.title)) firstOf.set(m.title, m);
  const scanned = [];
  // The newest 16 worlds are looked at, and the building's own world however old its last run is.
  const look = [...firstOf].slice(0, 16);
  if (home && firstOf.has(home) && !look.some(([t]) => t === home)) look.push([home, firstOf.get(home)]);
  for (const [worldTitle, meta] of look) {
    const spec = await specOf(meta);
    if (!walled(spec)) continue;
    scanned.push({
      title: worldTitle, placeName: typeof spec.placeName === 'string' ? spec.placeName : null,
      matterport: String(spec.geo?.source || '').startsWith('matterport')
    });
  }
  const fromPlan = scanned.filter(w => w.matterport);
  // `home` pins the building to one world by title (its case's homeTitle). While that world has a recorded run it
  // alone is the building, and every other walled world is another place, from a Matterport plan or not: a second
  // scanned building does not take the front page by being newer.
  const pinned = home ? scanned.filter(w => w.title === home) : [];
  const building = pinned.length ? pinned : fromPlan.length ? fromPlan : scanned;
  const keep = new Set(building.map(w => w.title));
  const candidates = visits.filter(m => (title ? m.title === title : keep.has(m.title)));
  const out = [];
  for (const meta of candidates.slice(0, max * 2)) {
    const spec = await specOf(meta);
    if (walled(spec)) out.push({ meta, spec });
    if (out.length >= max) break;
  }
  const named = w => ({ title: w.title, placeName: w.placeName });
  return { runs: out, metas, worlds: { building: building.map(named), others: scanned.filter(w => !keep.has(w.title)).map(named) } };
}

// One run's metrics, fetched once: a test and a changed room's comparison need them for a handful of runs.
const metricsCache = new Map();
export function apiRunMetrics(runId) {
  if (!metricsCache.has(runId)) metricsCache.set(runId, getJson(`/api/runs/${encodeURIComponent(runId)}/metrics`).catch(err => { metricsCache.delete(runId); throw err; }));
  return metricsCache.get(runId);
}

export async function apiLoadRun(runId, { modelId = null } = {}) {
  const part = name => getJson(`/api/runs/${encodeURIComponent(runId)}/${name}`);
  const [meta, spec, frames, metrics, agents, remarks] = await Promise.all(['meta', 'spec', 'frames', 'metrics', 'agents', 'remarks'].map(part));
  const decisions = await part('decisions').catch(() => []);
  const incidents = await part('incidents').catch(() => undefined);
  const raw = { meta, spec, frames, metrics, agents, remarks, decisions, ...(incidents ? { incidents } : {}) };
  return isEngineRun(raw) ? adaptEngineRun(raw, { modelId }) : normalizeBundle(raw);
}

// Start a run of a world spec on the server and wait for it. Returns the new run id.
// `link` marks the run as one side of a test of one change; the server checks it and stores it in meta.json.
// Words -> a world with a floor plan, written by Claude on the server (POST /api/compile). It takes a few minutes.
export async function apiCompile(description, { signal } = {}) {
  const res = await fetch('/api/compile', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description, plan: true }), signal
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Writing the place failed (${res.status}).`);
  return body;
}

// One recorded choice asked again, as recorded and with one more sentence about the person's day (§9c).
export async function apiAskAgain(runId, agentId, decision, today, pool = null) {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agentId)}/ask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, today, ...(pool ? { pool } : {}) })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Asking again failed (${res.status}).`);
  return body;
}

// The saved two-month results for a pool of diners (§21f): { pool, found, meta, results }.
export const apiDays = pool => getJson(`/api/days?pool=${encodeURIComponent(pool)}`);

export async function apiStartRun({ spec, provider = 'rules', seed = 7, link = null, onStatus, signal }) {
  const res = await fetch('/api/runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spec, provider, seed, ...(link ? { link } : {}) }), signal
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = Array.isArray(body.errors) && body.errors.length ? ` ${body.errors.slice(0, 2).map(String).join(' ')}` : '';
    throw new Error(`${body.error || `Starting the run failed (${res.status}).`}${why}`);
  }
  const id = body.runId;
  for (;;) {
    if (signal?.aborted) throw Object.assign(new Error('Cancelled.'), { name: 'AbortError' });
    const st = await getJson(`/api/runs/${encodeURIComponent(id)}/status`);
    onStatus?.(st);
    if (st.state === 'done') return id;
    if (st.state === 'error') throw new Error(st.error || 'The run failed.');
    await new Promise(r => setTimeout(r, 600));
  }
}
