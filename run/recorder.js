// Run recorder: writes runs/<runId>/ as described in docs/PROTOTYPE.md §7, and reads runs back.
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { slug } from '../engine/util.js';
import { specHash } from '../engine/spec.js';

// Decision lines are buffered and appended in chunks rather than one write per decision.
const FLUSH_LINES = 200;

function stamp(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Creates the run directory, adding -2, -3, ... if a run with the same id already exists.
function makeRunDir(root, baseId) {
  mkdirSync(root, { recursive: true });
  for (let n = 1; ; n++) {
    const runId = n === 1 ? baseId : `${baseId}-${n}`;
    const dir = join(root, runId);
    try {
      mkdirSync(dir);
      return { runId, dir };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

function decisionLine(req, decision, applied) {
  let recorded = decision;
  if (decision?.provider === 'rules' && decision.answers !== undefined) {
    const { answers, ...rest } = decision;
    recorded = rest;
  }
  return {
    id: req.id, t: req.t, clock: req.clock, agentId: req.agentId, personaId: req.personaId,
    kind: req.kind, why: req.why, placeId: req.placeId, options: req.options, asks: req.asks,
    observation: req.observation, auto: req.auto, decision: recorded, applied
  };
}

// `link` ties a run to a test of one change (docs/PROTOTYPE.md §9b): { test, role, base, change }. The server validates it.
export function createRecorder({ root = 'runs', spec, seed, providerName, label = null, link = null }) {
  const createdAt = new Date();
  const { runId, dir } = makeRunDir(resolve(root), `${slug(spec?.title, 0)}-${providerName}-s${seed}-${stamp(createdAt)}`);
  const decisionsPath = join(dir, 'decisions.jsonl');
  writeFileSync(decisionsPath, '');
  let buffer = [];
  let count = 0;
  const flush = () => {
    if (!buffer.length) return;
    appendFileSync(decisionsPath, buffer.join(''));
    buffer = [];
  };
  const write = (name, value, pretty = false) =>
    writeFileSync(join(dir, name), JSON.stringify(value, null, pretty ? 2 : 0) + (pretty ? '\n' : ''));

  return {
    runId,
    dir,
    decision(req, decision, applied) {
      buffer.push(JSON.stringify(decisionLine(req, decision, applied)) + '\n');
      count++;
      if (buffer.length >= FLUSH_LINES) flush();
    },
    // Writes every run file. `sim` is null only when the Sim could not be constructed.
    // meta.json is written last, so its presence marks a finished run.
    finish({ sim = null, metrics = null, providerStats = null, status = 'done', error = null }) {
      flush();
      const runSpec = sim?.spec ?? spec;
      let agentCount = 0;
      write('spec.json', runSpec, true);
      if (sim) {
        const agents = sim.agentsSummary();
        agentCount = agents.length;
        write('metrics.json', metrics, true);
        write('frames.json', sim.frames);
        write('agents.json', agents);
        write('remarks.json', sim.remarks);
      }
      const meta = {
        runId,
        createdAt: createdAt.toISOString(),
        status,
        error: error ?? null,
        title: runSpec?.title ?? null,
        question: runSpec?.question ?? null,
        mode: runSpec?.mode ?? null,
        duration: runSpec?.duration ?? null,
        clockStart: runSpec?.clockStart ?? null,
        seed,
        specHash: sim ? specHash(sim.spec) : null,
        provider: providerName,
        model: providerStats?.model ?? null,
        decisions: count,
        agents: metrics?.spawned ?? agentCount,
        providerStats,
        simOpts: sim?.opts ?? null,
        label,
        link
      };
      write('meta.json', meta, true);
      return meta;
    }
  };
}

function readJson(dir, name) {
  const file = join(dir, name);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

export function readDecisions(dir) {
  const file = join(dir, 'decisions.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
}

// Files a failed run never wrote come back as null.
export function loadRun(dir) {
  const abs = resolve(dir);
  const meta = readJson(abs, 'meta.json');
  if (!meta) throw new Error(`No recorded run at ${dir} (meta.json is missing)`);
  return {
    dir: abs,
    meta,
    spec: readJson(abs, 'spec.json'),
    metrics: readJson(abs, 'metrics.json'),
    frames: readJson(abs, 'frames.json'),
    agents: readJson(abs, 'agents.json'),
    remarks: readJson(abs, 'remarks.json'),
    decisions: readDecisions(abs)
  };
}

// Finished runs (those with a readable meta.json), newest first.
export function listRuns(root = 'runs') {
  const abs = resolve(root);
  if (!existsSync(abs)) return [];
  const metas = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const meta = readJson(join(abs, entry.name), 'meta.json');
      if (meta) metas.push(meta);
    } catch {
      // A half-written or hand-edited meta.json: leave that run out of the listing.
    }
  }
  return metas.sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.runId).localeCompare(String(a.runId)));
}
