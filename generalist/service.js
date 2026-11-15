// Persistent, local environment library and bounded asynchronous build/run jobs.
import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeEnvironment, validateEnvironment, environmentHash } from './spec.js';
import { normalizeBrief, buildEnvironment } from './builder.js';
import { runEnvironment } from './runtime.js';
import { makeProvider } from '../providers/index.js';

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const TERMINAL = new Set(['done', 'error', 'cancelled']);
const PROCESS_JOBS = new Set();
const now = () => new Date().toISOString();
const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, extra });
const id = prefix => `${prefix}-${randomUUID()}`;
function safeId(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw fail(400, 'Invalid environment, run or job id.');
  return value;
}
function ownerAlive(record) {
  if (!Number.isInteger(record.ownerPid) || record.ownerPid <= 0) return false;
  if (record.ownerPid === process.pid) return PROCESS_JOBS.has(record.jobId ?? record.id);
  try { process.kill(record.ownerPid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') throw fail(404, 'The requested environment, run or job does not exist.'); throw error; }
}
async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
}
async function entries(dir) {
  try { return await readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function options(input) {
  const provider = input.provider ?? 'rules';
  if (!['rules', 'jev'].includes(provider)) throw fail(400, 'provider must be rules or jev.');
  const seed = input.seed ?? 7, maxRequests = input.maxRequests ?? 2000;
  if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) throw fail(400, 'seed must be an integer from 0 to 2147483647.');
  if (!Number.isInteger(maxRequests) || maxRequests < 0 || maxRequests > 20000) throw fail(400, 'maxRequests must be an integer from 0 to 20000.');
  return { provider, seed, maxRequests };
}

export function createEnvironmentService({ root = process.cwd(), builder = buildEnvironment, runner = runEnvironment, providerFactory = makeProvider } = {}) {
  const base = join(resolve(root), 'data');
  const envDir = join(base, 'environments'), runDir = join(base, 'environment-runs'), jobDir = join(base, 'environment-jobs');
  const jobs = new Map(), active = new Map();
  let closed = false;
  const init = async () => {
    if (closed) throw fail(503, 'The environment service is shutting down.');
    await Promise.all([envDir, runDir, jobDir].map(dir => mkdir(dir, { recursive: true })));
  };
  const publicJob = job => structuredClone(job);
  const persist = job => atomicJson(join(jobDir, `${job.id}.json`), job);
  const environmentFile = value => join(envDir, `${safeId(value)}.json`);
  const runPath = value => join(runDir, safeId(value));
  const getEnvironment = value => readJson(environmentFile(value));

  async function saveEnvironment(input) {
    const checked = validateEnvironment(input.spec);
    if (!checked.ok) throw fail(400, 'The environment definition is invalid.', { errors: checked.errors, warnings: checked.warnings });
    const brief = input.brief == null ? null : normalizeBrief(input.brief);
    await init();
    const artifact = {
      id: id('env'), createdAt: now(), title: checked.spec.title, source: input.builder?.backend ?? 'manual',
      hash: environmentHash(checked.spec), spec: checked.spec, brief,
      builder: input.builder ?? null, attempts: input.attempts ?? null,
      warnings: [...new Set([...checked.warnings, ...(input.warnings ?? [])])]
    };
    await atomicJson(environmentFile(artifact.id), artifact);
    return artifact;
  }
  async function listEnvironments() {
    const out = [];
    for (const entry of await entries(envDir)) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const artifact = await readJson(join(envDir, entry.name));
      const { id, title, createdAt, source, hash } = artifact;
      out.push({ id, title, createdAt, source, hash });
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function examples() {
    const dir = new URL('../environments/', import.meta.url), out = [];
    for (const entry of await entries(dir)) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const spec = normalizeEnvironment(await readJson(new URL(entry.name, dir)));
      out.push({ id: entry.name.slice(0, -5), title: spec.title, spec });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }
  async function getJob(value) {
    safeId(value);
    const live = jobs.get(value);
    if (live) return publicJob(live);
    const saved = await readJson(join(jobDir, `${value}.json`));
    // A restart cannot resume an external model request. Never leave an orphan looking active.
    if (!TERMINAL.has(saved.status) && !ownerAlive(saved)) return { ...saved, status: 'error', error: 'The process stopped before this job finished. Start a new job.' };
    return saved;
  }
  async function getRun(value) {
    const dir = runPath(value), meta = await readJson(join(dir, 'meta.json'));
    let result = null;
    try { result = await readJson(join(dir, 'result.json')); }
    catch (error) { if (error.status !== 404) throw error; }
    if (!TERMINAL.has(meta.status) && !ownerAlive(meta)) {
      meta.status = 'error'; meta.error = 'The process stopped before this run finished.';
    }
    return { ...meta, result };
  }
  async function listRuns() {
    const out = [];
    for (const entry of await entries(runDir)) {
      if (!entry.isDirectory() || !ID.test(entry.name)) continue;
      let meta;
      try { meta = await readJson(join(runDir, entry.name, 'meta.json')); }
      catch (error) { if (error.status === 404) continue; throw error; }
      const { id, environmentId, title, provider, seed, createdAt, jobId } = meta;
      const status = !TERMINAL.has(meta.status) && !ownerAlive(meta) ? 'error' : meta.status;
      out.push({ id, environmentId, title, provider, seed, createdAt, status });
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // Reserve the slot synchronously before any I/O. Completed jobs remain on disk; only 100
  // recent jobs stay in memory. The build and run pools are separate and each allows one job.
  function launch(type, work) {
    if (closed) throw fail(503, 'The environment service is shutting down.');
    if ([...active.values()].some(item => item.type === type)) throw fail(409, `An environment ${type} is already active. Wait for it or cancel it first.`);
    const job = { id: id('job'), type, status: 'queued', createdAt: now(), ownerPid: process.pid, progress: null, error: null };
    const controller = new AbortController();
    const record = { type, controller, promise: null };
    jobs.set(job.id, job); active.set(job.id, record); PROCESS_JOBS.add(job.id);
    record.promise = (async () => {
      let outcome = 'done';
      try {
        await init();
        controller.signal.throwIfAborted();
        job.status = 'running'; await persist(job);
        const progress = detail => { job.progress = structuredClone(detail); };
        const result = await work({ job, signal: controller.signal, onProgress: progress });
        // Work checks cancellation before committing artifacts. A late cancel during the final
        // atomic write must not relabel an already saved successful run as cancelled.
        Object.assign(job, result);
      } catch (error) {
        outcome = controller.signal.aborted || error.name === 'AbortError' ? 'cancelled' : 'error';
        job.error = outcome === 'cancelled' ? 'Job cancelled.' : error.message;
        if (error.errors) job.errors = error.errors;
      } finally {
        const finished = { ...job, status: outcome, finishedAt: now() };
        // Publish completion only after the record is durable and the slot can be released.
        // Otherwise a client observing "done" can immediately hit a spurious "already active".
        try { await persist(finished); Object.assign(job, finished); }
        catch (error) { job.status = 'error'; job.error = `Could not persist job: ${error.message}`; }
        active.delete(job.id);
        PROCESS_JOBS.delete(job.id);
        for (const [key, old] of jobs) {
          if (jobs.size <= 100) break;
          if (TERMINAL.has(old.status) && !active.has(key)) jobs.delete(key);
        }
      }
    })();
    return publicJob(job);
  }

  function build(input) {
    const brief = normalizeBrief(input.brief);
    const backend = input.backend ?? 'claude-code';
    if (!['claude-code', 'codex', 'anthropic'].includes(backend)) throw fail(400, 'backend must be claude-code, codex or anthropic.');
    if (input.model !== undefined && (typeof input.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(input.model))) throw fail(400, 'model must be a model identifier.');
    return launch('build', async ({ signal, onProgress, job }) => {
      const result = await builder(brief, { backend, model: input.model, signal, onProgress });
      signal.throwIfAborted();
      const artifact = await saveEnvironment(result);
      job.environmentId = artifact.id;
      return { environmentId: artifact.id };
    });
  }
  async function run(input) {
    const opts = options(input);
    const environment = await getEnvironment(input.environmentId);
    const spec = normalizeEnvironment(environment.spec);
    // Provider construction checks credentials before allocating a run or starting a job.
    let provider;
    try { provider = providerFactory(opts.provider, { maxRequests: opts.maxRequests }); }
    catch (error) { throw fail(400, error.message); }
    return launch('run', async ({ signal, onProgress, job }) => {
      const runId = id('run'), dir = runPath(runId);
      job.runId = runId;
      const meta = {
        id: runId, jobId: job.id, ownerPid: process.pid, environmentId: environment.id, title: spec.title, createdAt: now(),
        status: 'running', ...opts, hash: environmentHash(spec), spec,
        brief: environment.brief, builder: environment.builder, warnings: environment.warnings
      };
      await mkdir(dir, { recursive: true });
      await atomicJson(join(dir, 'meta.json'), meta);
      try {
        const result = await runner(spec, { provider, seed: opts.seed, signal, onProgress });
        signal.throwIfAborted();
        await atomicJson(join(dir, 'result.json'), result);
        const decisions = result.decisions?.length ?? 0;
        const fallbacks = result.providerStats?.fallbacks ?? 0;
        const fallbackRate = decisions ? fallbacks / decisions : 0;
        Object.assign(meta, { status: 'done', finishedAt: now(), providerStats: result.providerStats, fallbackRate });
        if (opts.provider === 'jev' && fallbackRate > 0.2) meta.warnings = [...meta.warnings, 'Over 20% of decisions fell back to rules; this is not a reliable Jev run.'];
        await atomicJson(join(dir, 'meta.json'), meta);
        return { runId, environmentId: environment.id };
      } catch (error) {
        if (error.partialResult) await atomicJson(join(dir, 'result.json'), error.partialResult);
        Object.assign(meta, { status: signal.aborted || error.name === 'AbortError' ? 'cancelled' : 'error', error: error.message, finishedAt: now() });
        await atomicJson(join(dir, 'meta.json'), meta);
        throw error;
      }
    });
  }
  async function cancel(value) {
    const job = await getJob(value);
    const running = active.get(value);
    if (running) {
      running.controller.abort(new DOMException('Job cancelled.', 'AbortError'));
      const live = jobs.get(value); live.progress = { stage: 'cancelling' };
      return { ...publicJob(live), cancelling: true };
    }
    if (!TERMINAL.has(job.status)) throw fail(409, 'This job belongs to another process. Cancel it from the CLI or server that started it.');
    return job;
  }
  async function close() {
    closed = true;
    const running = [...active.values()];
    for (const record of running) record.controller.abort(new DOMException('Server stopped.', 'AbortError'));
    await Promise.allSettled(running.map(record => record.promise));
  }
  return { saveEnvironment, getEnvironment, listEnvironments, examples, build, run, getJob, getRun, listRuns, cancel, close };
}
