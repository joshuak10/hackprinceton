// Where runs come from: precomputed mock RunBundles (data/ first, then mock/), or runs recorded by the engine
// and served by `node bin/swarm.js serve` (docs/PROTOTYPE.md §9, §9b).
import { isEngineRun, adaptEngineRun } from './engine.js';

async function getJson(url, { timeoutMs = 0 } = {}) {
  const ctrl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-cache' });
    if (!res.ok) throw Object.assign(new Error(`${url} answered ${res.status}`), { status: res.status });
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

export const CASE_IDS = ['building', 'parking', 'sushi'];

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

// Recorded building runs (visit mode with walls), newest first, Jev runs before rules runs at the same time.
// `title` keeps only runs of the world with that title (a case's runTitle); `notTitles` leaves those worlds out,
// so one case's many runs cannot push another case's runs off the list.
export async function apiBuildingRuns({ max = 12, title = null, notTitles = [] } = {}) {
  const metas = await getJson('/api/runs').catch(() => []);
  const candidates = metas.filter(m => m.status === 'done' && m.mode === 'visit' && (title ? m.title === title : !notTitles.includes(m.title)))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, max * 2);
  const out = [];
  for (const meta of candidates) {
    const spec = await getJson(`/api/runs/${encodeURIComponent(meta.runId)}/spec`).catch(() => null);
    if (spec && Array.isArray(spec.walls) && spec.walls.length) out.push({ meta, spec });
    if (out.length >= max) break;
  }
  return out;
}

// One run's metrics, fetched once: the before/after line needs them for a handful of runs.
const metricsCache = new Map();
export function apiRunMetrics(runId) {
  if (!metricsCache.has(runId)) metricsCache.set(runId, getJson(`/api/runs/${encodeURIComponent(runId)}/metrics`).catch(() => { metricsCache.delete(runId); return null; }));
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
export async function apiStartRun({ spec, provider = 'rules', seed = 7, onStatus, signal }) {
  const res = await fetch('/api/runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spec, provider, seed }), signal
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = Array.isArray(body.errors) && body.errors.length ? ` ${body.errors.slice(0, 2).map(String).join(' ')}` : '';
    throw new Error(`${body.error || `Starting the run failed (${res.status}).`}${why}`);
  }
  const id = body.runId;
  for (;;) {
    if (signal?.aborted) throw new Error('Cancelled.');
    const st = await getJson(`/api/runs/${encodeURIComponent(id)}/status`);
    onStatus?.(st);
    if (st.state === 'done') return id;
    if (st.state === 'error') throw new Error(st.error || 'The run failed.');
    await new Promise(r => setTimeout(r, 600));
  }
}
