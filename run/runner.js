// Runner: drives a Sim with a decision provider (docs/PROTOTYPE.md §3, §7).
// Engine modules are imported on first use, so callers that inject SimClass (the tests) don't load the engine.

const PROGRESS_MS = 250;

export const KPI_NAMES = {
  visit: ['abandonRate', 'avgWait', 'served', 'abandoned', 'spawned'],
  route: ['avgTrip', 'avgDelay', 'arrived']
};

// Places (visit) or edges (route) ranked by bottleneck score: wait minutes + 30 × abandoned, or delay minutes.
export function rankedPlaces(metrics) {
  const list = metrics.mode === 'route'
    ? (metrics.edges ?? []).map(e => ({ id: e.id, name: e.name, score: e.delayMinutes }))
    : (metrics.nodes ?? []).map(n => ({ id: n.id, name: n.name, score: n.score }));
  return list.sort((a, b) => b.score - a.score);
}

export function headlineKpis(metrics) {
  const kpis = { mode: metrics.mode };
  for (const k of KPI_NAMES[metrics.mode]) kpis[k] = metrics[k];
  kpis.top = rankedPlaces(metrics).slice(0, 3);
  return kpis;
}

const idNumber = id => Number(String(id).slice(1));

// Provider stats for one run when the provider instance is shared by several runs (runSeeds, compareRuns):
// top-level counters (requests, tokens, cost, ...) count from `start`; latency and firstError stay cumulative.
function statsSince(start, now) {
  const out = { ...now };
  for (const [k, v] of Object.entries(now)) {
    if (Number.isFinite(v) && Number.isFinite(start[k])) out[k] = v - start[k];
  }
  return out;
}

export async function runSwarm({
  spec, seed = 7, provider, recorder = null, simOpts = {}, onProgress = null, signal = null, SimClass = null
}) {
  const Sim = SimClass ?? (await import('../engine/sim.js')).Sim;
  const startStats = provider.stats();
  const runStats = () => statsSince(startStats, provider.stats());
  let sim = null;
  let decisions = 0;
  let lastProgress = -Infinity;

  const progress = () => {
    if (!onProgress) return;
    const now = Date.now();
    if (now - lastProgress < PROGRESS_MS) return;
    lastProgress = now;
    onProgress({ t: sim.t, duration: sim.spec.duration, decisions, providerStats: runStats() });
  };

  // Released requests are answered together and applied in request-id order,
  // so a run never depends on the order API responses come back in.
  const resolveAll = async reqs => {
    reqs.sort((a, b) => idNumber(a.id) - idNumber(b.id));
    const ds = await provider.decideMany(reqs, { seed, spec: sim.spec });
    if (!Array.isArray(ds) || ds.length !== reqs.length) {
      throw new Error(`Provider ${provider.name} returned ${ds?.length ?? 'no'} decisions for ${reqs.length} requests`);
    }
    for (let i = 0; i < reqs.length; i++) {
      const applied = sim.resolve(reqs[i].id, ds[i]);
      recorder?.decision(reqs[i], ds[i], applied);
      decisions++;
    }
  };

  try {
    sim = new Sim(spec, { ...simOpts, seed, external: provider.external });
    while (!sim.done) {
      signal?.throwIfAborted();
      sim.step();
      if (provider.external) {
        const reqs = sim.pending();
        if (reqs.length) await resolveAll(reqs);
      }
      progress();
    }
    if (provider.external) {
      for (let reqs = sim.pending(); reqs.length; reqs = sim.pending()) await resolveAll(reqs);
    }
  } catch (err) {
    recordFailure(recorder, sim, runStats, err);
    throw err;
  }

  const metrics = sim.metrics();
  const providerStats = runStats();
  recorder?.finish({ sim, metrics, providerStats, status: 'done' });
  return { metrics, providerStats, runDir: recorder?.dir ?? null, runId: recorder?.runId ?? null, sim };
}

// Records a failed run as well as the partial state allows. The caller rethrows the original error,
// so a second failure here is reported on stderr instead of replacing it.
function recordFailure(recorder, sim, runStats, err) {
  if (!recorder) return;
  let metrics = null;
  try {
    metrics = sim ? sim.metrics() : null;
  } catch {
    // Partial state the metrics code can't summarize: record the run without metrics.
  }
  try {
    recorder.finish({ sim, metrics, providerStats: runStats(), status: 'error', error: err?.message ?? String(err) });
  } catch (recordErr) {
    process.stderr.write(`Could not record the failed run in ${recorder.dir}: ${recordErr.message}\n`);
  }
}

function meanSd(values) {
  const n = values.length;
  if (!n) return { mean: 0, sd: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const sd = n > 1 ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0;
  return { mean, sd };
}

// Mean and sample standard deviation of each headline KPI, how often each place ranks #1 (and top 3),
// each place's mean bottleneck score, and decision counts summed over the runs.
export function summarizeRuns(runs) {
  const mode = runs[0]?.metrics.mode ?? 'visit';
  const kpis = {};
  for (const k of KPI_NAMES[mode]) kpis[k] = meanSd(runs.map(r => r.kpis[k]));

  const frequency = new Map();
  const scores = new Map();
  const decisions = { total: 0, byProvider: {}, byKind: {} };
  const addCounts = (into, counts) => {
    for (const [k, n] of Object.entries(counts ?? {})) into[k] = (into[k] ?? 0) + n;
  };
  for (const r of runs) {
    decisions.total += r.metrics.decisions?.total ?? 0;
    addCounts(decisions.byProvider, r.metrics.decisions?.byProvider);
    addCounts(decisions.byKind, r.metrics.decisions?.byKind);
    r.kpis.top.forEach((p, i) => {
      if (!frequency.has(p.id)) frequency.set(p.id, { id: p.id, name: p.name, first: 0, top3: 0 });
      const f = frequency.get(p.id);
      if (i === 0) f.first++;
      f.top3++;
    });
    for (const p of rankedPlaces(r.metrics)) {
      if (!scores.has(p.id)) scores.set(p.id, { id: p.id, name: p.name, total: 0 });
      scores.get(p.id).total += p.score;
    }
  }
  return {
    mode,
    seeds: runs.map(r => r.seed),
    kpis,
    decisions,
    bottleneckFrequency: [...frequency.values()].sort((a, b) => b.first - a.first || b.top3 - a.top3),
    places: [...scores.values()]
      .map(p => ({ id: p.id, name: p.name, meanScore: p.total / runs.length }))
      .sort((a, b) => b.meanScore - a.meanScore)
  };
}

// Runs seeds one after another with the same provider. `recorderFor(seed)` returns a recorder or null.
// Run entries leave out `sim` so many seeds don't keep every simulation in memory.
export async function runSeeds({ spec, seeds, provider, recorderFor = null, onProgress = null, ...rest }) {
  const runs = [];
  for (const seed of seeds) {
    const r = await runSwarm({
      ...rest,
      spec,
      seed,
      provider,
      recorder: recorderFor ? recorderFor(seed) : null,
      onProgress: onProgress && (p => onProgress({ ...p, seed }))
    });
    runs.push({
      seed, runId: r.runId, runDir: r.runDir, metrics: r.metrics, providerStats: r.providerStats, kpis: headlineKpis(r.metrics)
    });
  }
  return { runs, summary: summarizeRuns(runs) };
}

// Before/after on the same seeds. `recorderFor(seed, side)` gets side 'before' or 'after'.
// `runs.before` / `runs.after` keep each seed's run entry (metrics included) so effects can be paired seed by
// seed; `offers` are the offers the patch added, as the engine normalized them (ids and names resolved).
export async function compareRuns({ spec, patch, seeds, provider, recorderFor = null, ...rest }) {
  const { normalizeSpec, applyPatch } = await import('../engine/spec.js');
  const base = normalizeSpec(spec);
  const { spec: patched, applied, skipped } = applyPatch(base, patch);
  const side = name => recorderFor && (seed => recorderFor(seed, name));
  const b = await runSeeds({ ...rest, spec: base, seeds, provider, recorderFor: side('before') });
  const a = await runSeeds({ ...rest, spec: patched, seeds, provider, recorderFor: side('after') });
  const before = b.summary, after = a.summary;
  const delta = {};
  for (const k of Object.keys(before.kpis)) delta[k] = after.kpis[k].mean - before.kpis[k].mean;
  const offers = (patched.offers ?? []).slice((base.offers ?? []).length);
  return { applied, skipped, before, after, delta, runs: { before: b.runs, after: a.runs }, offers };
}
