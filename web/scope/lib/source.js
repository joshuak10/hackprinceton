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

// The places the display offers: the building, and the sushi restaurant (?case=sushi, reached from Run details).
// The parking mock still exists (mockgen/), but is not offered here (v0.27).
const CASE_IDS = ['building', 'sushi'];

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

// Recorded runs of one place (visit mode with walls), newest first, as { runs: [{ meta, spec }], metas }.
// `metas` is every finished run's meta.json, including each run's test link (meta.link, §9b).
// `title` keeps only runs of the world with that title (a case's runTitle); `notTitles` leaves those worlds out,
// so one place's many runs cannot push another place's runs off the list.
export async function apiBuildingRuns({ max = 18, title = null, notTitles = [] } = {}) {
  const metas = await getJson('/api/runs');
  const candidates = metas.filter(m => m.status === 'done' && m.mode === 'visit' && (title ? m.title === title : !notTitles.includes(m.title)))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, max * 2);
  const out = [];
  for (const meta of candidates) {
    const spec = await getJson(`/api/runs/${encodeURIComponent(meta.runId)}/spec`).catch(() => null);
    if (spec && Array.isArray(spec.walls) && spec.walls.length) out.push({ meta, spec });
    if (out.length >= max) break;
  }
  return { runs: out, metas };
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
