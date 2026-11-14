// Where runs come from. MockSource reads precomputed RunBundles (data/ first, then mock/).
// ApiSource talks to the teammate's server (docs/PROTOTYPE.md §9 and §9b) once it serves these worlds.

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

export async function loadCases() {
  const mock = await getJson('mock/index.json').catch(() => ({ cases: {} }));
  const data = await getJson('data/index.json').catch(() => ({ cases: {} }));
  const cases = {};
  for (const id of ['building', 'parking']) {
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
  if (!bundles.has(file)) bundles.set(file, getJson(file).then(normalizeBundle).catch(err => { bundles.delete(file); throw err; }));
  return bundles.get(file);
}

// ---------- live server (wired to the contract, untested until the server has these worlds) ----------

export async function apiHealth() {
  try {
    const h = await getJson('/api/health', { timeoutMs: 800 });
    return h && h.ok ? h : null;
  } catch {
    return null;
  }
}

export async function apiRun({ world, provider = 'jev', seed = 7, onStatus, signal }) {
  const res = await fetch('/api/runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ world, provider, seed }), signal
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Starting the run failed (${res.status}).`);
  const id = body.runId;
  for (;;) {
    if (signal?.aborted) throw new Error('Cancelled.');
    const st = await getJson(`/api/runs/${encodeURIComponent(id)}/status`);
    onStatus?.(st);
    if (st.state === 'done') break;
    if (st.state === 'error') throw new Error(st.error || 'The run failed.');
    await new Promise(r => setTimeout(r, 700));
  }
  const part = name => getJson(`/api/runs/${encodeURIComponent(id)}/${name}`);
  const [meta, spec, frames, metrics, agents, remarks] = await Promise.all(['meta', 'spec', 'frames', 'metrics', 'agents', 'remarks'].map(part));
  const decisions = await part('decisions').catch(() => []);
  const incidents = await part('incidents').catch(() => undefined);
  return normalizeBundle({ meta, spec, frames, metrics, agents, remarks, decisions, incidents });
}
