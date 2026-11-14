// Recorder tests (docs/PROTOTYPE.md §7): run directory, decisions.jsonl, finish() files, loadRun and listRuns.
// Uses a temporary directory and a minimal Sim stand-in; no engine simulation.
import { test, describe, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createRecorder, loadRun, listRuns, readDecisions } from '../run/recorder.js';
import { normalizeSpec, specHash } from '../engine/spec.js';

const SPEC = normalizeSpec({
  title: 'Harbor Lights Park', question: 'Where do lines form?', mode: 'visit', duration: 90, clockStart: 600,
  nodes: [
    { id: 'gate', name: 'Gate', kind: 'entry', x: 10, y: 10 },
    { id: 's', name: 'Spin', kind: 'service', x: 50, y: 50, servers: 1, serviceTime: 2 }
  ],
  archetypes: [{ id: 'a', name: 'Guests', share: 1 }],
  arrivals: { total: 20 }
});

const AGENTS = [
  { id: 0, personaId: 'a', personaName: 'A', archetypeId: 'a', informed: true, served: 2, waitTotal: 8.5, abandons: 0,
    frustration: 1.2, born: 3, done: 40, trace: [{ t: 3, m: 'arrived' }, { t: 12, m: 'rode Spin' }] },
  { id: 1, personaId: 'a', personaName: 'A', archetypeId: 'a', informed: false, served: 0, waitTotal: 30, abandons: 1,
    frustration: null, born: 5, done: 60, trace: [] }
];
const REMARKS = [{ t: 20, agentId: 0, personaName: 'A', archetypeId: 'a', kind: 'long_line', placeId: 's', edgeId: null, informed: true }];

const fakeSim = (over = {}) => ({
  spec: SPEC,
  opts: { seed: 7, external: true, dt: 0.5, batchWindow: 1, frameEvery: 1 },
  frames: { mode: 'visit', nodes: [{ id: 's', name: 'Spin', kind: 'service', x: 50, y: 50 }], services: ['s'], list: [{ t: 0, a: [], q: [0], load: null, c: { active: 0, served: 0, abandoned: 0, arrived: 0 } }] },
  remarks: REMARKS,
  agentsSummary: () => AGENTS,
  ...over
});
const METRICS = { mode: 'visit', abandonRate: 0.1, avgWait: 4, served: 18, abandoned: 2, spawned: 20, nodes: [] };

const request = (id, extra = {}) => ({
  id, t: 12.5, clock: '10:12', kind: 'choose', why: 'start', agentId: 0, decisionIndex: 0, personaId: 'a', personaName: 'A', archetypeId: 'a',
  placeId: null, aboutPlace: null, aboutEdge: null, asks: { choice: 'next_place', yesNo: null, frustration: false, tellOthers: false },
  options: [{ key: 's', label: 'Go to Spin' }, { key: 'leave', label: 'Leave' }], remarkKinds: null, observation: { now: 'Just arrived.' },
  auto: { action: 's' }, ...extra
});
const applied = { id: 'd1', agentId: 0, kind: 'choose', yes: null, action: 's', tell: false, remarkKind: null, frustration: null, summary: 'went to Spin', provider: 'jev' };

let root;
before(() => { root = mkdtempSync(join(tmpdir(), 'swarm-recorder-')); });
after(() => { rmSync(root, { recursive: true, force: true }); });

const fresh = name => join(root, name);

describe('createRecorder', () => {
  test('creates runs/<runId>/ with runId = <slug(title)>-<provider>-s<seed>-<YYYYMMDD-HHMMSS>', () => {
    const rec = createRecorder({ root: fresh('ids'), spec: SPEC, seed: 7, providerName: 'rules' });
    assert.match(rec.runId, /^harbor_lights_park-rules-s7-\d{8}-\d{6}$/);
    assert.equal(rec.dir, join(resolve(fresh('ids')), rec.runId));
    assert.ok(existsSync(rec.dir));
    assert.equal(readFileSync(join(rec.dir, 'decisions.jsonl'), 'utf8'), '');
  });

  test('the timestamp is the local creation time', () => {
    mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 14, 9, 5, 3) });
    try {
      const rec = createRecorder({ root: fresh('stamp'), spec: SPEC, seed: 3, providerName: 'jev' });
      assert.equal(rec.runId, 'harbor_lights_park-jev-s3-20261114-090503');
    } finally {
      mock.timers.reset();
    }
  });

  test('creates the root when it does not exist', () => {
    const rec = createRecorder({ root: join(fresh('deep'), 'a', 'b'), spec: SPEC, seed: 1, providerName: 'rules' });
    assert.ok(existsSync(rec.dir));
  });

  test('two runs created in the same second get distinct directories', () => {
    mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 14, 9, 5, 3) });
    try {
      const a = createRecorder({ root: fresh('dup'), spec: SPEC, seed: 1, providerName: 'rules' });
      const b = createRecorder({ root: fresh('dup'), spec: SPEC, seed: 1, providerName: 'rules' });
      assert.notEqual(a.dir, b.dir);
      assert.notEqual(a.runId, b.runId);
      assert.ok(existsSync(a.dir) && existsSync(b.dir));
    } finally {
      mock.timers.reset();
    }
  });
});

describe('decision()', () => {
  test('appends one valid JSON line per decision with the documented fields', () => {
    const rec = createRecorder({ root: fresh('lines'), spec: SPEC, seed: 7, providerName: 'jev' });
    const jev = { provider: 'jev', choiceProbs: { s: 0.7, leave: 0.3 }, model: 'jev-1.14.0', latencyMs: 120, answers: { next_place: { probabilities: { s: 0.7 } } } };
    rec.decision(request('d1'), jev, applied);
    rec.decision(request('d2', { kind: 'line', why: null, placeId: 's' }), { provider: 'rules', action: 's' }, { ...applied, id: 'd2' });
    rec.finish({ sim: fakeSim(), metrics: METRICS, providerStats: { provider: 'jev', model: 'jev-1.14.0' } });

    const text = readFileSync(join(rec.dir, 'decisions.jsonl'), 'utf8');
    assert.ok(text.endsWith('\n'));
    const lines = text.trimEnd().split('\n').map(l => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual(Object.keys(lines[0]),
      ['id', 't', 'clock', 'agentId', 'personaId', 'kind', 'why', 'placeId', 'options', 'asks', 'observation', 'auto', 'decision', 'applied']);
    assert.equal(lines[0].id, 'd1');
    assert.equal(lines[0].t, 12.5);
    assert.equal(lines[0].clock, '10:12');
    assert.deepEqual(lines[0].options, request('d1').options);
    assert.deepEqual(lines[0].observation, { now: 'Just arrived.' });
    assert.deepEqual(lines[0].auto, { action: 's' });
    assert.deepEqual(lines[0].applied, applied);
    assert.equal(lines[1].kind, 'line');
    assert.equal(lines[1].placeId, 's');
    assert.equal(lines[1].why, null);
  });

  test('keeps the whole decision, including raw answers, for Jev', () => {
    const rec = createRecorder({ root: fresh('jev-answers'), spec: SPEC, seed: 7, providerName: 'jev' });
    const jev = { provider: 'jev', choiceProbs: { s: 0.7 }, model: 'm', requestHash: 'ab12', answers: { x: 1 } };
    rec.decision(request('d1'), jev, applied);
    rec.finish({ sim: fakeSim(), metrics: METRICS });
    assert.deepEqual(readDecisions(rec.dir)[0].decision, jev);
  });

  test('omits only answers when the provider is rules', () => {
    const rec = createRecorder({ root: fresh('rules-answers'), spec: SPEC, seed: 7, providerName: 'rules' });
    rec.decision(request('d1'), { provider: 'rules', action: 's', answers: { big: 'blob' }, requestHash: 'h' }, applied);
    rec.finish({ sim: fakeSim(), metrics: METRICS });
    assert.deepEqual(readDecisions(rec.dir)[0].decision, { provider: 'rules', action: 's', requestHash: 'h' });
  });

  test('decisions reach disk in batches before finish, and finish flushes the rest', () => {
    const rec = createRecorder({ root: fresh('flush'), spec: SPEC, seed: 7, providerName: 'rules' });
    for (let i = 1; i <= 250; i++) rec.decision(request(`d${i}`), { provider: 'rules', action: 's' }, applied);
    const mid = readFileSync(join(rec.dir, 'decisions.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert.ok(mid.length > 0 && mid.length < 250, `mid-run lines: ${mid.length}`);
    rec.finish({ sim: fakeSim(), metrics: METRICS });
    const all = readDecisions(rec.dir);
    assert.equal(all.length, 250);
    assert.deepEqual(all.map(d => d.id), Array.from({ length: 250 }, (_, i) => `d${i + 1}`));
  });
});

describe('finish()', () => {
  const finished = (name, extra = {}) => {
    const rec = createRecorder({ root: fresh(name), spec: SPEC, seed: 7, providerName: 'jev', label: 'baseline' });
    rec.decision(request('d1'), { provider: 'jev', choiceProbs: { s: 1 } }, applied);
    rec.decision(request('d2'), { provider: 'jev', choiceProbs: { s: 1 } }, applied);
    const stats = { provider: 'jev', model: 'jev-1.14.0', requests: 2 };
    const meta = rec.finish({ sim: fakeSim(), metrics: METRICS, providerStats: stats, ...extra });
    return { rec, meta, stats };
  };

  test('writes every file in §7', () => {
    const { rec } = finished('files');
    assert.deepEqual(readdirSync(rec.dir).sort(),
      ['agents.json', 'decisions.jsonl', 'frames.json', 'meta.json', 'metrics.json', 'remarks.json', 'spec.json']);
  });

  test('meta.json has the documented fields and values', () => {
    const { rec, meta, stats } = finished('meta');
    const onDisk = JSON.parse(readFileSync(join(rec.dir, 'meta.json'), 'utf8'));
    assert.deepEqual(onDisk, JSON.parse(JSON.stringify(meta)), 'finish returns what it wrote');
    for (const key of ['runId', 'createdAt', 'status', 'error', 'title', 'question', 'mode', 'duration', 'clockStart', 'seed',
      'specHash', 'provider', 'model', 'decisions', 'agents', 'providerStats', 'simOpts']) {
      assert.ok(key in onDisk, `meta.json is missing ${key}`);
    }
    assert.equal(onDisk.runId, rec.runId);
    assert.ok(!Number.isNaN(Date.parse(onDisk.createdAt)));
    assert.equal(onDisk.status, 'done');
    assert.equal(onDisk.error, null);
    assert.equal(onDisk.title, 'Harbor Lights Park');
    assert.equal(onDisk.question, 'Where do lines form?');
    assert.equal(onDisk.mode, 'visit');
    assert.equal(onDisk.duration, 90);
    assert.equal(onDisk.clockStart, 600);
    assert.equal(onDisk.seed, 7);
    assert.match(onDisk.specHash, /^[0-9a-f]{12}$/);
    assert.equal(onDisk.specHash, specHash(SPEC));
    assert.equal(onDisk.provider, 'jev');
    assert.equal(onDisk.model, 'jev-1.14.0');
    assert.equal(onDisk.decisions, 2);
    assert.equal(onDisk.agents, 20, 'agents is the number of agents spawned');
    assert.deepEqual(onDisk.providerStats, stats);
    assert.deepEqual(onDisk.simOpts, fakeSim().opts);
    assert.equal(onDisk.label, 'baseline');
  });

  test('agents falls back to the length of agents.json when metrics has no spawned count', () => {
    const rec = createRecorder({ root: fresh('agents-count'), spec: SPEC, seed: 7, providerName: 'rules' });
    const meta = rec.finish({ sim: fakeSim(), metrics: { mode: 'visit' } });
    assert.equal(meta.agents, 2);
  });

  test('each file has the documented shape', () => {
    const { rec } = finished('shapes');
    const read = name => JSON.parse(readFileSync(join(rec.dir, name), 'utf8'));
    assert.deepEqual(read('spec.json'), SPEC);
    assert.deepEqual(read('metrics.json'), METRICS);
    assert.deepEqual(read('frames.json'), fakeSim().frames);
    assert.deepEqual(read('agents.json'), AGENTS);
    assert.deepEqual(read('remarks.json'), REMARKS);
    for (const a of read('agents.json')) {
      for (const key of ['id', 'personaId', 'personaName', 'archetypeId', 'informed', 'served', 'waitTotal', 'abandons', 'frustration', 'born', 'done', 'trace']) {
        assert.ok(key in a, `agents.json entry is missing ${key}`);
      }
    }
  });

  test('spec.json is the sim\'s normalized spec when it differs from the input spec', () => {
    const rec = createRecorder({ root: fresh('sim-spec'), spec: { title: 'Raw input' }, seed: 1, providerName: 'rules' });
    rec.finish({ sim: fakeSim(), metrics: METRICS });
    assert.deepEqual(JSON.parse(readFileSync(join(rec.dir, 'spec.json'), 'utf8')), SPEC);
    assert.equal(loadRun(rec.dir).meta.title, 'Harbor Lights Park');
  });

  test('an error run writes the status and error, and only the files it has', () => {
    const rec = createRecorder({ root: fresh('error'), spec: SPEC, seed: 7, providerName: 'jev' });
    rec.decision(request('d1'), { provider: 'jev' }, applied);
    const meta = rec.finish({ sim: null, status: 'error', error: 'Jev auth failed', providerStats: { provider: 'jev' } });
    assert.equal(meta.status, 'error');
    assert.equal(meta.error, 'Jev auth failed');
    assert.equal(meta.specHash, null);
    assert.equal(meta.decisions, 1);
    assert.equal(meta.simOpts, null);
    assert.deepEqual(readdirSync(rec.dir).sort(), ['decisions.jsonl', 'meta.json', 'spec.json']);
    const run = loadRun(rec.dir);
    assert.equal(run.metrics, null);
    assert.equal(run.frames, null);
    assert.equal(run.agents, null);
    assert.equal(run.remarks, null);
    assert.deepEqual(run.spec.title, SPEC.title);
    assert.equal(run.decisions.length, 1);
  });

  test('model is null when the provider stats carry none', () => {
    const rec = createRecorder({ root: fresh('no-model'), spec: SPEC, seed: 7, providerName: 'rules' });
    const meta = rec.finish({ sim: fakeSim(), metrics: METRICS, providerStats: { provider: 'rules' } });
    assert.equal(meta.model, null);
  });
});

describe('loadRun', () => {
  test('round-trips everything finish() wrote', () => {
    const rec = createRecorder({ root: fresh('roundtrip'), spec: SPEC, seed: 7, providerName: 'jev' });
    const lineA = [request('d1'), { provider: 'jev', choiceProbs: { s: 0.6, leave: 0.4 }, yesProb: 0.2 }, applied];
    const lineB = [request('d2', { kind: 'line', placeId: 's' }), { provider: 'jev-cache', yesProb: 0.9 }, { ...applied, id: 'd2', yes: true }];
    rec.decision(...lineA);
    rec.decision(...lineB);
    rec.finish({ sim: fakeSim(), metrics: METRICS, providerStats: { provider: 'jev', model: 'jev-1.14.0' } });

    const run = loadRun(rec.dir);
    assert.equal(run.dir, rec.dir);
    assert.equal(run.meta.runId, rec.runId);
    assert.deepEqual(run.spec, SPEC);
    assert.deepEqual(run.metrics, METRICS);
    assert.deepEqual(run.frames, fakeSim().frames);
    assert.deepEqual(run.agents, AGENTS);
    assert.deepEqual(run.remarks, REMARKS);
    assert.equal(run.decisions.length, 2);
    assert.deepEqual(run.decisions[0].decision, lineA[1]);
    assert.deepEqual(run.decisions[1].decision, lineB[1]);
    assert.deepEqual(run.decisions[1].applied, lineB[2]);
    assert.equal(run.decisions[1].placeId, 's');
  });

  test('accepts a relative directory path', () => {
    const rec = createRecorder({ root: fresh('relative'), spec: SPEC, seed: 7, providerName: 'rules' });
    rec.finish({ sim: fakeSim(), metrics: METRICS });
    const rel = relative(process.cwd(), rec.dir);
    assert.ok(!isAbsolute(rel));
    assert.equal(loadRun(rel).meta.runId, rec.runId);
  });

  test('throws a clear error when meta.json is missing', () => {
    const dir = fresh('no-meta');
    mkdirSync(dir);
    assert.throws(() => loadRun(dir), /No recorded run at .*meta\.json is missing/);
    assert.throws(() => loadRun(fresh('does-not-exist')), /No recorded run/);
  });

  test('readDecisions skips blank lines and returns [] with no file', () => {
    const dir = fresh('blank-lines');
    mkdirSync(dir);
    assert.deepEqual(readDecisions(dir), []);
    writeFileSync(join(dir, 'decisions.jsonl'), '{"id":"d1"}\n\n  \n{"id":"d2"}\n');
    assert.deepEqual(readDecisions(dir).map(d => d.id), ['d1', 'd2']);
  });
});

describe('listRuns', () => {
  test('lists finished runs newest first', () => {
    const dir = fresh('list');
    const made = [];
    mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 14, 9, 0, 0) });
    try {
      for (const [seed, title] of [[1, 'First'], [2, 'Second'], [3, 'Third']]) {
        const rec = createRecorder({ root: dir, spec: { ...SPEC, title }, seed, providerName: 'rules' });
        rec.finish({ sim: fakeSim({ spec: { ...SPEC, title } }), metrics: METRICS });
        made.push(rec.runId);
        mock.timers.tick(60_000);
      }
    } finally {
      mock.timers.reset();
    }
    const runs = listRuns(dir);
    assert.deepEqual(runs.map(r => r.runId), [...made].reverse());
    assert.deepEqual(runs.map(r => r.seed), [3, 2, 1]);
    assert.ok(runs.every(r => 'createdAt' in r && 'status' in r), 'entries are the meta records');
  });

  test('leaves out unfinished runs, plain files and unreadable metas', () => {
    const dir = fresh('list-skip');
    const good = createRecorder({ root: dir, spec: SPEC, seed: 1, providerName: 'rules' });
    good.finish({ sim: fakeSim(), metrics: METRICS });
    createRecorder({ root: dir, spec: SPEC, seed: 2, providerName: 'rules' }); // never finished: no meta.json
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    mkdirSync(join(dir, 'corrupt'));
    writeFileSync(join(dir, 'corrupt', 'meta.json'), '{ not json');
    assert.deepEqual(listRuns(dir).map(r => r.runId), [good.runId]);
  });

  test('returns [] for a missing root', () => {
    assert.deepEqual(listRuns(fresh('never-created')), []);
  });
});
