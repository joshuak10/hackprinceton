// Runner tests (docs/PROTOTYPE.md §3, §4, §7) with a scripted FakeSim and a fake provider: no engine, no network.
import { test, describe, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runSwarm, runSeeds, compareRuns, summarizeRuns, headlineKpis, rankedPlaces, KPI_NAMES
} from '../run/runner.js';
import { createRecorder, loadRun } from '../run/recorder.js';
import { normalizeSpec } from '../engine/spec.js';

// ---------- fakes ----------

const WORLD = {
  title: 'Fake Fair', mode: 'visit', duration: 60,
  nodes: [
    { id: 'gate', name: 'Gate', kind: 'entry', x: 10, y: 10 },
    { id: 's', name: 'Spin', kind: 'service', x: 50, y: 50, servers: 1, serviceTime: 2 },
    { id: 't', name: 'Twirl', kind: 'service', x: 70, y: 30, servers: 2, serviceTime: 2 }
  ],
  archetypes: [{ id: 'a', name: 'Guests', share: 1 }],
  arrivals: { total: 20 }
};
const SPEC = normalizeSpec(WORLD);

const request = id => ({
  id, t: 0, clock: '08:00', kind: 'choose', why: 'start', agentId: Number(id.slice(1)), decisionIndex: 0,
  personaId: 'a', personaName: 'A', archetypeId: 'a', placeId: null, aboutPlace: null, aboutEdge: null,
  asks: { choice: 'next_place', yesNo: null, frustration: false, tellOthers: false },
  options: [{ key: 's', label: 'Go to Spin' }, { key: 'leave', label: 'Leave' }],
  remarkKinds: null, observation: {}, auto: { action: 's' }
});

// Builds a Sim stand-in with the contract §4 surface. `config.script[tick]` lists the request ids created on that tick
// (in the order given, which is deliberately not id order); `config.late` are created on the last tick but only
// released by pending() once the sim is done. `config.metrics(spec, opts)` supplies metrics().
function makeFakeSim(config = {}) {
  const log = { constructed: [], resolved: [], pendingCalls: 0 };
  const ticks = config.ticks ?? 6;
  class FakeSim {
    constructor(spec, opts) {
      this.spec = spec;
      this.opts = { dt: 0.5, batchWindow: 1, frameEvery: 1, ...opts };
      this.tick = 0;
      this.t = 0;
      this.frames = { mode: spec.mode, nodes: [], services: [], list: [] };
      this.remarks = [];
      this.ready = [];
      this.held = [];
      this.open = new Set();
      this.closed = new Set();
      log.constructed.push({ spec, opts: this.opts });
    }
    get done() { return this.tick >= ticks; }
    step() {
      this.tick++;
      this.t = this.tick * this.opts.dt;
      const made = (config.script?.[this.tick] ?? []).map(request);
      for (const r of made) this.open.add(r.id);
      this.ready.push(...made);
      if (this.tick === ticks) {
        const late = (config.late ?? []).map(request);
        for (const r of late) this.open.add(r.id);
        this.held.push(...late);
      }
    }
    pending() {
      log.pendingCalls++;
      const out = this.ready;
      this.ready = [];
      if (this.done) { out.push(...this.held); this.held = []; }
      return out;
    }
    resolve(id, decision) {
      if (this.closed.has(id) || !this.open.has(id)) throw new Error(`Unknown or already resolved request ${id}`);
      this.open.delete(id);
      this.closed.add(id);
      log.resolved.push({ id, decision });
      return { id, agentId: Number(id.slice(1)), kind: 'choose', yes: null, action: 's', tell: false, remarkKind: null,
        frustration: null, summary: 'went to Spin', provider: decision.provider };
    }
    metrics() {
      const base = {
        mode: this.spec.mode, abandonRate: 0.1, avgWait: 5, served: 10, abandoned: 1, spawned: 11,
        nodes: [{ id: 's', name: 'Spin', score: 5 }, { id: 't', name: 'Twirl', score: 2 }],
        decisions: { total: log.resolved.length, byProvider: { rules: log.resolved.length }, byKind: { choose: log.resolved.length } }
      };
      return config.metrics ? config.metrics(this.spec, this.opts, base) : base;
    }
    agentsSummary() { return []; }
  }
  return { FakeSim, log };
}

// A provider that answers every request with an echo of its id. Answers complete in reverse order:
// the last request resolves first, so a runner that applied decisions as they arrived would be out of order.
function makeProvider({ external = true, fail = null } = {}) {
  const seen = [];
  const counters = { requests: 0, cacheHits: 0, inputTokens: 0, estCostUSD: 0, latency: { p50: 5 }, firstError: null };
  return {
    name: 'fake', external, seen, counters,
    async decideMany(reqs, ctx) {
      seen.push({ ids: reqs.map(r => r.id), ctx });
      if (fail) throw fail;
      counters.requests += reqs.length;
      counters.inputTokens += reqs.length * 100;
      await Promise.all(reqs.map((r, i) => new Promise(res => setTimeout(res, (reqs.length - i) * 3))));
      return reqs.map(r => ({ provider: 'jev', choiceProbs: { s: 0.6, leave: 0.4 }, echo: r.id }));
    },
    stats() { return { provider: 'fake', ...counters, latency: { ...counters.latency } }; }
  };
}

let tmp;
before(() => { tmp = mkdtempSync(join(tmpdir(), 'swarm-runner-')); });
after(() => { rmSync(tmp, { recursive: true, force: true }); });

// ---------- runSwarm ----------

describe('runSwarm', () => {
  test('resolves each released batch in request-id order, however the ids arrive', async () => {
    // d10 and d9 arrive before d2 and d1: numeric order is d1, d2, d9, d10 (a string sort would put d10 before d2).
    const { FakeSim, log } = makeFakeSim({ script: { 2: ['d10', 'd2', 'd9', 'd1'], 4: ['d12', 'd11'] } });
    const provider = makeProvider();
    const r = await runSwarm({ spec: SPEC, seed: 3, provider, SimClass: FakeSim });
    assert.deepEqual(provider.seen[0].ids, ['d1', 'd2', 'd9', 'd10']);
    assert.deepEqual(provider.seen[1].ids, ['d11', 'd12']);
    assert.deepEqual(log.resolved.map(x => x.id), ['d1', 'd2', 'd9', 'd10', 'd11', 'd12']);
    // decision i belongs to request i
    for (const { id, decision } of log.resolved) assert.equal(decision.echo, id);
    assert.equal(r.runDir, null);
    assert.equal(r.runId, null);
    assert.ok(r.sim);
  });

  test('passes seed and spec to the provider and builds the sim with seed, external and simOpts', async () => {
    const { FakeSim, log } = makeFakeSim({ script: { 1: ['d1'] } });
    const provider = makeProvider();
    await runSwarm({ spec: SPEC, seed: 42, provider, simOpts: { dt: 0.1, batchWindow: 0 }, SimClass: FakeSim });
    assert.equal(provider.seen[0].ctx.seed, 42);
    assert.equal(provider.seen[0].ctx.spec, log.constructed[0].spec);
    assert.deepEqual(
      { seed: log.constructed[0].opts.seed, external: log.constructed[0].opts.external, dt: log.constructed[0].opts.dt, bw: log.constructed[0].opts.batchWindow },
      { seed: 42, external: true, dt: 0.1, bw: 0 }
    );
  });

  test('seed overrides a seed inside simOpts', async () => {
    const { FakeSim, log } = makeFakeSim();
    await runSwarm({ spec: SPEC, seed: 9, provider: makeProvider(), simOpts: { seed: 1 }, SimClass: FakeSim });
    assert.equal(log.constructed[0].opts.seed, 9);
  });

  test('requests still pending after the loop are resolved, in id order', async () => {
    const { FakeSim, log } = makeFakeSim({ script: { 3: ['d1'] }, late: ['d7', 'd5', 'd6'] });
    const provider = makeProvider();
    const r = await runSwarm({ spec: SPEC, provider, SimClass: FakeSim });
    assert.deepEqual(log.resolved.map(x => x.id), ['d1', 'd5', 'd6', 'd7']);
    assert.equal(r.metrics.decisions.total, 4);
  });

  test('every released request is resolved exactly once (the fake sim throws on a repeat)', async () => {
    const { FakeSim, log } = makeFakeSim({ script: { 1: ['d1', 'd2'], 2: ['d3'], 6: ['d4'] }, late: ['d5'] });
    await runSwarm({ spec: SPEC, provider: makeProvider(), SimClass: FakeSim });
    assert.deepEqual(log.resolved.map(x => x.id), ['d1', 'd2', 'd3', 'd4', 'd5']);
  });

  test('an inline provider (external false) just steps to the end and never decides', async () => {
    const { FakeSim, log } = makeFakeSim({ ticks: 4, script: { 1: ['d1'] } });
    const provider = makeProvider({ external: false });
    const r = await runSwarm({ spec: SPEC, provider, SimClass: FakeSim });
    assert.equal(provider.seen.length, 0);
    assert.equal(log.pendingCalls, 0);
    assert.equal(log.constructed[0].opts.external, false);
    assert.equal(r.sim.done, true);
    assert.equal(r.sim.tick, 4);
    assert.equal(r.metrics.mode, 'visit');
  });

  test('returns the sim metrics and the provider stats for the run', async () => {
    const { FakeSim } = makeFakeSim({ script: { 1: ['d1', 'd2'] } });
    const r = await runSwarm({ spec: SPEC, provider: makeProvider(), SimClass: FakeSim });
    assert.equal(r.metrics.served, 10);
    assert.equal(r.providerStats.requests, 2);
    assert.equal(r.providerStats.inputTokens, 200);
  });

  test('providerStats count only this run when the provider is shared', async () => {
    const provider = makeProvider();
    const first = makeFakeSim({ script: { 1: ['d1', 'd2', 'd3'] } });
    const second = makeFakeSim({ script: { 1: ['d1'] } });
    const a = await runSwarm({ spec: SPEC, provider, SimClass: first.FakeSim });
    const b = await runSwarm({ spec: SPEC, provider, SimClass: second.FakeSim });
    assert.equal(a.providerStats.requests, 3);
    assert.equal(b.providerStats.requests, 1);
    assert.equal(b.providerStats.inputTokens, 100);
    assert.equal(provider.stats().requests, 4);
  });

  test('a provider that returns the wrong number of decisions fails the run', async () => {
    const { FakeSim } = makeFakeSim({ script: { 1: ['d1', 'd2'] } });
    const provider = makeProvider();
    provider.decideMany = async () => [{ provider: 'jev' }];
    await assert.rejects(runSwarm({ spec: SPEC, provider, SimClass: FakeSim }), /returned 1 decisions for 2 requests/);
  });

  test('an already aborted signal stops the run', async () => {
    const { FakeSim } = makeFakeSim();
    const ctl = new AbortController();
    ctl.abort();
    await assert.rejects(runSwarm({ spec: SPEC, provider: makeProvider(), signal: ctl.signal, SimClass: FakeSim }), { name: 'AbortError' });
  });

  describe('onProgress', () => {
    test('is throttled to one call per 250 ms of wall time', async () => {
      let clock = 0;
      const dateNow = mock.method(Date, 'now', () => { const v = clock; clock += 100; return v; });
      try {
        const { FakeSim } = makeFakeSim({ ticks: 12 });
        const calls = [];
        await runSwarm({ spec: SPEC, provider: makeProvider(), onProgress: p => calls.push(p), SimClass: FakeSim });
        // Date.now reads once per tick: 0, 100, 200, 300, ... The first read fires, then every fourth (300 ms apart).
        assert.equal(calls.length, 4);
      } finally {
        dateNow.mock.restore();
      }
    });

    test('reports t, duration, decisions and run-scoped providerStats', async () => {
      const { FakeSim } = makeFakeSim({ ticks: 3, script: { 1: ['d1', 'd2'] } });
      const calls = [];
      await runSwarm({ spec: SPEC, provider: makeProvider(), onProgress: p => calls.push(p), SimClass: FakeSim });
      assert.ok(calls.length >= 1);
      const first = calls[0];
      assert.deepEqual(Object.keys(first).sort(), ['decisions', 'duration', 'providerStats', 't']);
      assert.equal(first.duration, SPEC.duration);
      assert.equal(first.t, 0.5);
      assert.equal(first.decisions, 2);
      assert.equal(first.providerStats.requests, 2);
    });

    test('fast runs without a clock mock produce far fewer calls than ticks', async () => {
      const { FakeSim } = makeFakeSim({ ticks: 300 });
      let n = 0;
      await runSwarm({ spec: SPEC, provider: makeProvider({ external: false }), onProgress: () => n++, SimClass: FakeSim });
      assert.ok(n >= 1 && n < 30, `got ${n} progress calls`);
    });
  });

  describe('recording', () => {
    test('a recorder gets every decision in id order and a done meta', async () => {
      const { FakeSim } = makeFakeSim({ script: { 2: ['d3', 'd1', 'd2'] } });
      const rec = createRecorder({ root: join(tmp, 'ok'), spec: SPEC, seed: 5, providerName: 'fake' });
      const r = await runSwarm({ spec: SPEC, seed: 5, provider: makeProvider(), recorder: rec, SimClass: FakeSim });
      assert.equal(r.runId, rec.runId);
      assert.equal(r.runDir, rec.dir);
      const run = loadRun(rec.dir);
      assert.equal(run.meta.status, 'done');
      assert.equal(run.meta.decisions, 3);
      assert.deepEqual(run.decisions.map(d => d.id), ['d1', 'd2', 'd3']);
      assert.equal(run.decisions[0].applied.summary, 'went to Spin');
      assert.equal(run.meta.providerStats.requests, 3);
    });

    test('a provider error is recorded as a failed run and rethrown', async () => {
      const { FakeSim } = makeFakeSim({ script: { 1: ['d1'], 2: ['d2'] } });
      const provider = makeProvider({ fail: new Error('Jev is down') });
      const rec = createRecorder({ root: join(tmp, 'fail'), spec: SPEC, seed: 5, providerName: 'fake' });
      await assert.rejects(runSwarm({ spec: SPEC, seed: 5, provider, recorder: rec, SimClass: FakeSim }), /Jev is down/);
      assert.ok(existsSync(join(rec.dir, 'meta.json')));
      const meta = JSON.parse(readFileSync(join(rec.dir, 'meta.json'), 'utf8'));
      assert.equal(meta.status, 'error');
      assert.equal(meta.error, 'Jev is down');
      assert.equal(meta.decisions, 0);
      assert.equal(meta.runId, rec.runId);
    });

    test('a failed run keeps the decisions made before the error', async () => {
      const { FakeSim } = makeFakeSim({ script: { 1: ['d1'], 3: ['d2'] } });
      const provider = makeProvider();
      const original = provider.decideMany;
      let calls = 0;
      provider.decideMany = async (reqs, ctx) => {
        if (++calls === 2) throw new Error('second batch failed');
        return original(reqs, ctx);
      };
      const rec = createRecorder({ root: join(tmp, 'partial'), spec: SPEC, seed: 5, providerName: 'fake' });
      await assert.rejects(runSwarm({ spec: SPEC, provider, recorder: rec, SimClass: FakeSim }), /second batch failed/);
      const run = loadRun(rec.dir);
      assert.equal(run.meta.status, 'error');
      assert.deepEqual(run.decisions.map(d => d.id), ['d1']);
      assert.equal(run.meta.decisions, 1);
      assert.ok(run.metrics, 'partial metrics are recorded');
    });

    test('a failure with no recorder just rejects with the original error', async () => {
      const { FakeSim } = makeFakeSim({ script: { 1: ['d1'] } });
      await assert.rejects(
        runSwarm({ spec: SPEC, provider: makeProvider({ fail: new TypeError('bad body') }), SimClass: FakeSim }),
        { name: 'TypeError', message: 'bad body' }
      );
    });

    test('an error while building the sim is recorded without a sim', async () => {
      class Broken { constructor() { throw new Error('bad spec'); } }
      const rec = createRecorder({ root: join(tmp, 'broken'), spec: SPEC, seed: 1, providerName: 'fake' });
      await assert.rejects(runSwarm({ spec: SPEC, provider: makeProvider(), recorder: rec, SimClass: Broken }), /bad spec/);
      const run = loadRun(rec.dir);
      assert.equal(run.meta.status, 'error');
      assert.equal(run.meta.error, 'bad spec');
      assert.equal(run.metrics, null);
    });
  });
});

// ---------- headline KPIs and rankings ----------

describe('headlineKpis and rankedPlaces', () => {
  test('visit KPIs and the top 3 places by score', () => {
    const metrics = {
      mode: 'visit', abandonRate: 0.2, avgWait: 7, served: 40, abandoned: 10, spawned: 50, extra: 1,
      nodes: [
        { id: 'a', name: 'A', score: 3 }, { id: 'b', name: 'B', score: 30 }, { id: 'c', name: 'C', score: 12 },
        { id: 'd', name: 'D', score: 8 }
      ]
    };
    const k = headlineKpis(metrics);
    assert.deepEqual(Object.keys(k), ['mode', ...KPI_NAMES.visit, 'top']);
    assert.equal(k.abandonRate, 0.2);
    assert.deepEqual(k.top.map(p => p.id), ['b', 'c', 'd']);
    assert.deepEqual(rankedPlaces(metrics).map(p => p.id), ['b', 'c', 'd', 'a']);
  });

  test('route KPIs rank edges by delay minutes', () => {
    const metrics = {
      mode: 'route', avgTrip: 22, avgDelay: 6, arrived: 100,
      edges: [{ id: 'x>y', name: 'Bridge', delayMinutes: 90 }, { id: 'y>z', name: 'Tunnel', delayMinutes: 400 }]
    };
    const k = headlineKpis(metrics);
    assert.deepEqual(Object.keys(k), ['mode', 'avgTrip', 'avgDelay', 'arrived', 'top']);
    assert.deepEqual(k.top, [{ id: 'y>z', name: 'Tunnel', score: 400 }, { id: 'x>y', name: 'Bridge', score: 90 }]);
  });
});

// ---------- runSeeds ----------

describe('runSeeds', () => {
  // avgWait = 10 × seed; Spin is #1 for seeds 1 and 2, Twirl for seed 3.
  const seedMetrics = (spec, opts, base) => ({
    ...base,
    avgWait: 10 * opts.seed,
    abandonRate: 0.1 * opts.seed,
    nodes: opts.seed === 3
      ? [{ id: 's', name: 'Spin', score: 1 }, { id: 't', name: 'Twirl', score: 9 }, { id: 'u', name: 'Urn', score: 4 }]
      : [{ id: 's', name: 'Spin', score: 7 }, { id: 't', name: 'Twirl', score: 2 }, { id: 'u', name: 'Urn', score: 4 }],
    decisions: { total: 4, byProvider: { jev: 3, 'rules-fallback': 1 }, byKind: { choose: 3, line: 1 } }
  });

  test('runs each seed in order and summarizes mean, standard deviation and bottleneck frequency', async () => {
    const { FakeSim, log } = makeFakeSim({ metrics: seedMetrics });
    const { runs, summary } = await runSeeds({ spec: SPEC, seeds: [1, 2, 3], provider: makeProvider({ external: false }), SimClass: FakeSim });
    assert.deepEqual(log.constructed.map(c => c.opts.seed), [1, 2, 3]);
    assert.deepEqual(runs.map(r => r.seed), [1, 2, 3]);
    assert.ok(runs.every(r => !('sim' in r)), 'runs leave out the sim');
    assert.deepEqual(summary.seeds, [1, 2, 3]);
    assert.equal(summary.mode, 'visit');
    // avgWait 10, 20, 30: mean 20, sample standard deviation 10
    assert.equal(summary.kpis.avgWait.mean, 20);
    assert.equal(summary.kpis.avgWait.sd, 10);
    assert.ok(Math.abs(summary.kpis.abandonRate.mean - 0.2) < 1e-12);
    assert.ok(Math.abs(summary.kpis.abandonRate.sd - 0.1) < 1e-12);
    // constant KPIs have zero spread
    assert.deepEqual(summary.kpis.served, { mean: 10, sd: 0 });
    const freq = Object.fromEntries(summary.bottleneckFrequency.map(f => [f.id, f]));
    assert.equal(freq.s.first, 2);
    assert.equal(freq.t.first, 1);
    assert.equal(freq.u?.first ?? 0, 0);
    assert.equal(freq.s.top3, 3);
    assert.equal(freq.u.top3, 3);
    assert.equal(summary.bottleneckFrequency[0].id, 's');
    assert.equal(summary.bottleneckFrequency[0].name, 'Spin');
  });

  test('summarizes per-place mean scores and sums decision counts', async () => {
    const { FakeSim } = makeFakeSim({ metrics: seedMetrics });
    const { summary } = await runSeeds({ spec: SPEC, seeds: [1, 2, 3], provider: makeProvider({ external: false }), SimClass: FakeSim });
    const mean = Object.fromEntries(summary.places.map(p => [p.id, p.meanScore]));
    assert.equal(mean.s, 5);   // (7 + 7 + 1) / 3
    assert.equal(mean.t, 13 / 3);
    assert.equal(mean.u, 4);
    assert.deepEqual(summary.places.map(p => p.id), ['s', 't', 'u'].sort((a, b) => mean[b] - mean[a]));
    assert.deepEqual(summary.decisions, { total: 12, byProvider: { jev: 9, 'rules-fallback': 3 }, byKind: { choose: 9, line: 3 } });
  });

  test('a single seed has zero standard deviation', async () => {
    const { FakeSim } = makeFakeSim({ metrics: seedMetrics });
    const { summary } = await runSeeds({ spec: SPEC, seeds: [2], provider: makeProvider({ external: false }), SimClass: FakeSim });
    assert.deepEqual(summary.kpis.avgWait, { mean: 20, sd: 0 });
  });

  test('summarizeRuns of route runs uses the route KPIs', () => {
    const run = (seed, avgTrip) => {
      const metrics = { mode: 'route', avgTrip, avgDelay: 2, arrived: 50, edges: [{ id: 'e', name: 'E', delayMinutes: 10 * seed }] };
      return { seed, metrics, kpis: headlineKpis(metrics) };
    };
    const s = summarizeRuns([run(1, 10), run(2, 14)]);
    assert.equal(s.mode, 'route');
    assert.deepEqual(Object.keys(s.kpis), ['avgTrip', 'avgDelay', 'arrived']);
    assert.equal(s.kpis.avgTrip.mean, 12);
    assert.ok(Math.abs(s.kpis.avgTrip.sd - Math.sqrt(8)) < 1e-12);
    assert.equal(s.places[0].meanScore, 15);
  });

  test('recorderFor is called once per seed and per-seed runs carry their runId', async () => {
    const { FakeSim } = makeFakeSim({ script: { 1: ['d1'] } });
    const root = join(tmp, 'seeds');
    const { runs } = await runSeeds({
      spec: SPEC, seeds: [11, 12], provider: makeProvider(), SimClass: FakeSim,
      recorderFor: seed => createRecorder({ root, spec: SPEC, seed, providerName: 'fake' })
    });
    assert.equal(runs.length, 2);
    assert.match(runs[0].runId, /-s11-/);
    assert.match(runs[1].runId, /-s12-/);
    assert.equal(loadRun(runs[1].runDir).meta.seed, 12);
  });

  test('onProgress calls carry the seed', async () => {
    const { FakeSim } = makeFakeSim();
    const seen = [];
    await runSeeds({ spec: SPEC, seeds: [4, 5], provider: makeProvider(), SimClass: FakeSim, onProgress: p => seen.push(p.seed) });
    assert.ok(seen.includes(4) && seen.includes(5));
  });
});

// ---------- compareRuns ----------

describe('compareRuns', () => {
  // Spin's wait falls as servers rise: avgWait = 20 / servers + seed.
  const metrics = (spec, opts, base) => {
    const servers = spec.nodes.find(n => n.id === 's').servers;
    return { ...base, avgWait: 20 / servers + opts.seed, abandonRate: 0.4 / servers, served: 10 * servers };
  };

  test('averages both sides over the same seeds and reports the delta', async () => {
    const { FakeSim, log } = makeFakeSim({ metrics });
    const sides = [];
    const out = await compareRuns({
      spec: WORLD, seeds: [1, 2, 3], provider: makeProvider({ external: false }), SimClass: FakeSim,
      patch: [{ kind: 'node', id: 's', field: 'servers', value: 2 }, { kind: 'node', id: 'nope', field: 'servers', value: 9 }],
      recorderFor: (seed, side) => { sides.push(`${side}:${seed}`); return null; }
    });
    // before runs all seeds, then after runs the same seeds
    assert.deepEqual(log.constructed.map(c => c.opts.seed), [1, 2, 3, 1, 2, 3]);
    assert.deepEqual(log.constructed.map(c => c.spec.nodes.find(n => n.id === 's').servers), [1, 1, 1, 2, 2, 2]);
    assert.deepEqual(sides, ['before:1', 'before:2', 'before:3', 'after:1', 'after:2', 'after:3']);
    assert.deepEqual(out.before.seeds, [1, 2, 3]);
    assert.deepEqual(out.after.seeds, [1, 2, 3]);
    assert.equal(out.before.kpis.avgWait.mean, 22);  // 20 + mean(1,2,3)
    assert.equal(out.after.kpis.avgWait.mean, 12);   // 10 + 2
    assert.equal(out.delta.avgWait, -10);
    assert.ok(Math.abs(out.delta.abandonRate - (-0.2)) < 1e-12);
    assert.equal(out.delta.served, 10);
    assert.deepEqual(Object.keys(out.delta).sort(), [...KPI_NAMES.visit].sort());
    assert.equal(out.applied.length, 1);
    assert.match(out.applied[0], /Spin · servers 1 → 2/);
    assert.equal(out.skipped.length, 1);
    assert.equal(out.skipped[0].id, 'nope');
  });

  test('an empty patch applies nothing and gives zero delta', async () => {
    const { FakeSim } = makeFakeSim({ metrics });
    const out = await compareRuns({ spec: WORLD, seeds: [1, 2], provider: makeProvider({ external: false }), SimClass: FakeSim, patch: [] });
    assert.deepEqual(out.applied, []);
    for (const v of Object.values(out.delta)) assert.equal(v, 0);
  });

  test('works through an external provider as well', async () => {
    const { FakeSim } = makeFakeSim({ metrics, script: { 1: ['d1', 'd2'] } });
    const provider = makeProvider();
    const out = await compareRuns({
      spec: WORLD, seeds: [1], provider, SimClass: FakeSim, patch: [{ kind: 'node', id: 's', field: 'servers', value: 4 }]
    });
    assert.equal(out.delta.avgWait, 5 - 20);
    assert.equal(provider.seen.length, 2);
  });
});
