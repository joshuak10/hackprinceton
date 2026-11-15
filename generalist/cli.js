// General environment commands; the existing crowd CLI remains compatible.
import { readFile, writeFile, mkdir, access, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeBrief, buildEnvironment } from './builder.js';
import { validateEnvironment } from './spec.js';

const stdout = line => process.stdout.write(line + '\n');
const stderr = line => process.stderr.write(line + '\n');

async function readInput(file, cwd, json = true) {
  const path = resolve(cwd, file);
  const info = await stat(path);
  if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('Input must be a file no larger than 2 MB.');
  const text = await readFile(path, 'utf8');
  if (!json) return text;
  try { return JSON.parse(text); } catch { throw new Error(`${file} is not valid JSON.`); }
}

async function exportTarget(flags, cwd) {
  if (!flags.out) return null;
  const file = resolve(cwd, flags.out);
  if (!flags.force) {
    try { await access(file); } catch (err) { if (err.code === 'ENOENT') return file; throw err; }
    throw new Error(`${file} already exists. Choose another --out path or use --force.`);
  }
  return file;
}

async function exportSpec(file, spec, force) {
  if (!file) return;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(spec, null, 2) + '\n', { flag: force ? 'w' : 'wx' });
}

async function defaultService(options) {
  const { createEnvironmentService } = await import('./service.js');
  return createEnvironmentService(options);
}

function whole(value, name, fallback, max) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`--${name} must be a whole number between 0 and ${max}.`);
  return n;
}

async function interrupted(task) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  try { return await task(controller.signal); }
  finally { process.removeListener('SIGINT', stop); }
}

function cancelled() { return Object.assign(new Error('Environment operation cancelled.'), { name: 'AbortError' }); }

async function followJob(service, initial, signal, progress) {
  let job = initial, shown = '';
  for (;;) {
    if (signal.aborted) { await service.cancel(job.id); throw cancelled(); }
    const status = job.status ?? job.state;
    if (status === 'done') return job;
    if (status === 'error' || status === 'cancelled') throw new Error(job.error || `Environment job ${status}.`);
    const message = `${status}${job.progress?.tick != null ? ` · tick ${job.progress.tick}` : ''}`;
    if (message !== shown) { progress(message); shown = message; }
    await delay(100);
    job = await service.getJob(job.id);
  }
}

export async function cmdEnvironmentBuild(args, flags, {
  cwd = process.cwd(), out = stdout, err = stderr, build = buildEnvironment, serviceFactory = defaultService
} = {}) {
  if (flags.brief && args.length) throw new Error('Use a description or --brief FILE, not both.');
  let raw = flags.brief ? await readInput(flags.brief, cwd) : { description: args.join(' ') };
  if (flags.objectives !== undefined) raw = { ...raw, objectives: flags.objectives };
  if (flags.constraints !== undefined) raw = { ...raw, constraints: flags.constraints };
  let brief = normalizeBrief(raw);
  if (flags.guidelines) {
    const text = await readInput(flags.guidelines, cwd, false);
    brief = normalizeBrief({ ...brief, guidelines: [...brief.guidelines, ...text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)] });
  }
  // Check export collisions before a paid generation call.
  const file = await exportTarget(flags, cwd);
  return interrupted(async signal => {
    const result = await build(brief, {
      backend: flags.backend || 'claude-code', model: flags.model, signal,
      onProgress: event => err(`${event.stage} · attempt ${event.attempt}/${event.maxAttempts}`)
    });
    if (signal.aborted) throw cancelled();
    const service = await serviceFactory({ root: cwd });
    try {
      const artifact = await service.saveEnvironment(result);
      await exportSpec(file, artifact.spec, flags.force);
      if (flags.json) out(JSON.stringify({ ...artifact, ...(file ? { file } : {}) }, null, 2));
      else {
        out(`Built ${artifact.spec.title} · ${artifact.id}`);
        out(`${artifact.spec.roles.reduce((n, role) => n + role.count, 0)} actors · ${artifact.spec.actions.length} actions · ${artifact.spec.ticks} ticks`);
        out(`Saved under data/environments/${artifact.id}.json${file ? `; exported ${file}` : ''}`);
        for (const warning of result.warnings) out(`Note: ${warning}`);
        out(`Run: swarm env-run ${file || `data/environments/${artifact.id}.json`} --provider jev`);
      }
      return 0;
    } finally { await service.close(); }
  });
}

export async function cmdEnvironmentValidate([file], flags, { cwd = process.cwd(), out = stdout } = {}) {
  const input = await readInput(file, cwd);
  const checked = validateEnvironment(input?.spec ?? input);
  if (flags.json) out(JSON.stringify(checked, null, 2));
  else {
    out(checked.ok ? `Valid environment: ${checked.spec.title}` : 'Invalid environment');
    for (const error of checked.errors) out(`Error: ${error}`);
    for (const warning of checked.warnings) out(`Note: ${warning}`);
  }
  return checked.ok ? 0 : 1;
}

export async function cmdEnvironmentRun([file], flags, {
  cwd = process.cwd(), out = stdout, err = stderr, serviceFactory = defaultService
} = {}) {
  const provider = flags.provider || 'rules';
  if (!['rules', 'jev'].includes(provider)) throw new Error('--provider must be rules or jev.');
  const seed = whole(flags.seed, 'seed', 7, 0x7fffffff);
  const maxRequests = whole(flags['max-requests'], 'max-requests', 2000, 20000);
  const input = await readInput(file, cwd);
  const service = await serviceFactory({ root: cwd });
  try {
    return await interrupted(async signal => {
      const artifact = await service.saveEnvironment(input?.spec ? input : { spec: input });
      const started = await service.run({ environmentId: artifact.id, provider, seed, maxRequests });
      const job = await followJob(service, started, signal, err);
      const run = await service.getRun(job.runId ?? job.id);
      if (flags.json) out(JSON.stringify(run, null, 2));
      else {
        const meta = run.meta ?? run;
        const result = run.result ?? run;
        out(`${artifact.spec.title} · ${provider} · seed ${seed}`);
        out(`Run: ${meta.id ?? meta.runId ?? job.runId ?? job.id}`);
        out(JSON.stringify(result.metrics, null, 2));
        out(`Replay in Scope: /scope/?mode=environment`);
      }
      return 0;
    });
  } finally { await service.close(); }
}

export async function cmdEnvironmentRuns(_args, flags, {
  cwd = process.cwd(), out = stdout, serviceFactory = defaultService
} = {}) {
  const service = await serviceFactory({ root: cwd });
  try {
    const runs = await service.listRuns();
    if (flags.json) out(JSON.stringify(runs, null, 2));
    else if (!runs.length) out('No general environment runs yet. Use swarm env-run FILE.');
    else for (const run of runs) out(`${run.id ?? run.runId} · ${run.title} · ${run.provider} · seed ${run.seed} · ${run.status}`);
    return 0;
  } finally { await service.close(); }
}

export async function cmdEnvironmentExamples([id], flags, {
  cwd = process.cwd(), out = stdout, serviceFactory = defaultService
} = {}) {
  if (flags.out && !id) throw new Error('--out needs an example id. Run swarm env-examples to list them.');
  const target = await exportTarget(flags, cwd);
  const service = await serviceFactory({ root: cwd });
  try {
    const examples = await service.examples();
    if (!id) {
      if (flags.json) out(JSON.stringify(examples, null, 2));
      else for (const example of examples) out(`${example.id} · ${example.title ?? example.spec?.title}`);
    } else {
      const example = examples.find(item => item.id === id);
      if (!example) throw new Error(`Unknown environment example: ${id}.`);
      const spec = example.spec;
      if (!spec) throw new Error(`Example ${id} has no environment spec.`);
      await exportSpec(target, spec, flags.force);
      if (!target || flags.json) out(JSON.stringify(spec, null, 2));
      else out(`Wrote ${target}`);
    }
    return 0;
  } finally { await service.close(); }
}
