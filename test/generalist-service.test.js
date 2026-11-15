import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause, setImmediate as nextTurn } from 'node:timers/promises';
import { createEnvironmentService } from '../generalist/service.js';

const spec = JSON.parse(await readFile(new URL('../environments/incident-response.json', import.meta.url), 'utf8'));
async function fixture(t, injections = {}) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-environment-'));
  const service = createEnvironmentService({ root, ...injections });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { root, service };
}
async function finished(service, id) {
  for (let i = 0; i < 200; i++) {
    const job = await service.getJob(id);
    if (['done', 'error', 'cancelled'].includes(job.status)) return job;
    await pause(5);
  }
  throw new Error('Job did not finish');
}

test('environment library saves immutable revisions, runs, and reloads an auditable result', async t => {
  const { root, service } = await fixture(t);
  const artifact = await service.saveEnvironment({ spec, brief: { description: 'Investigate an outage.' } });
  const second = await service.saveEnvironment({ spec: { ...spec, ticks: 10 } });
  assert.notEqual(artifact.id, second.id);
  assert.equal((await service.listEnvironments()).length, 2);
  assert.deepEqual((await service.getEnvironment(artifact.id)).spec, artifact.spec);
  const start = await service.run({ environmentId: artifact.id, provider: 'rules', seed: 19 });
  const job = await finished(service, start.id);
  assert.equal(job.status, 'done', job.error);
  const run = await service.getRun(job.runId);
  assert.equal(run.status, 'done');
  assert.equal(run.environmentId, artifact.id);
  assert.equal(run.seed, 19);
  assert.ok(run.result.decisions.length > 0);
  assert.equal(run.result.environmentHash, artifact.hash);
  assert.equal(run.result.frames.at(-1).tick, spec.ticks);
  assert.equal(run.brief.description, 'Investigate an outage.');
  const reloaded = createEnvironmentService({ root });
  t.after(() => reloaded.close());
  assert.deepEqual(await reloaded.getRun(job.runId), run);
  assert.equal((await reloaded.getJob(job.id)).status, 'done');
  assert.equal((await reloaded.listRuns()).length, 1);
});

test('builder output is validated, stores brief and provenance, and reports progress', async t => {
  let received;
  const { service } = await fixture(t, { builder: async (brief, options) => {
    received = { brief, backend: options.backend };
    options.onProgress({ stage: 'validating', attempt: 1 });
    return { spec, brief, builder: { backend: options.backend, model: 'fixture' }, attempts: 1, warnings: ['Synthetic'] };
  } });
  const start = service.build({ brief: { description: 'Custom incident response', guidelines: ['Protect customer data.'] }, backend: 'claude-code' });
  const job = await finished(service, start.id);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.progress.stage, 'validating');
  const artifact = await service.getEnvironment(job.environmentId);
  assert.equal(artifact.source, 'claude-code');
  assert.equal(artifact.attempts, 1);
  assert.deepEqual(artifact.brief, received.brief);
  assert.ok(artifact.warnings.includes('Synthetic'));
});

test('concurrent builds are refused and cancellation permits another build', async t => {
  const { service } = await fixture(t, { builder: (brief, { signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const input = { brief: { description: 'A workflow' } };
  const first = service.build(input);
  assert.throws(() => service.build(input), error => error.status === 409);
  await service.cancel(first.id);
  assert.equal((await finished(service, first.id)).status, 'cancelled');
  const second = service.build(input);
  assert.notEqual(first.id, second.id);
  await service.cancel(second.id);
  assert.equal((await finished(service, second.id)).status, 'cancelled');
  assert.equal((await service.listEnvironments()).length, 0);
});

test('invalid generated environments fail without saving an artifact', async t => {
  const { service } = await fixture(t, { builder: async () => ({ spec: { version: 1 } }) });
  const start = service.build({ brief: { description: 'Invalid fixture' } });
  const job = await finished(service, start.id);
  assert.equal(job.status, 'error');
  assert.match(job.error, /invalid/);
  assert.deepEqual(await service.listEnvironments(), []);
});

test('a terminal job is durable and immediately permits the next build', async t => {
  const { root, service } = await fixture(t, { builder: async () => { throw new Error('fixture failure'); } });
  for (let attempt = 0; attempt < 4; attempt++) {
    const started = service.build({ brief: { description: 'test retry' } });
    let job;
    for (let poll = 0; poll < 10000; poll++) {
      job = await service.getJob(started.id);
      if (job.status === 'error') break;
      await nextTurn();
    }
    assert.equal(job.status, 'error');
    const saved = JSON.parse(await readFile(join(root, 'data', 'environment-jobs', `${job.id}.json`), 'utf8'));
    assert.equal(saved.status, 'error');
    assert.equal(saved.finishedAt, job.finishedAt);
  }
});

test('failed runs retain partial state and reject concurrent runs', async t => {
  let failRun;
  const { service } = await fixture(t, { runner: () => new Promise((resolve, reject) => { failRun = reject; }) });
  const artifact = await service.saveEnvironment({ spec });
  const first = await service.run({ environmentId: artifact.id });
  await assert.rejects(service.run({ environmentId: artifact.id }), error => error.status === 409);
  while (!failRun) await pause(2);
  failRun(Object.assign(new Error('Transport stopped'), { partialResult: { frames: [{ tick: 0 }], decisions: [] } }));
  const job = await finished(service, first.id);
  assert.equal(job.status, 'error');
  const run = await service.getRun(job.runId);
  assert.equal(run.status, 'error');
  assert.equal(run.result.frames[0].tick, 0);
  assert.equal(run.error, 'Transport stopped');
});

test('persisted unfinished jobs and runs are marked interrupted after restart', async t => {
  const { root, service } = await fixture(t);
  await mkdir(join(root, 'data', 'environment-jobs'), { recursive: true });
  await writeFile(join(root, 'data', 'environment-jobs', 'job-old.json'), JSON.stringify({ id: 'job-old', status: 'running' }));
  await mkdir(join(root, 'data', 'environment-runs', 'run-old'), { recursive: true });
  await writeFile(join(root, 'data', 'environment-runs', 'run-old', 'meta.json'), JSON.stringify({ id: 'run-old', jobId: 'job-old', status: 'running' }));
  assert.equal((await service.getJob('job-old')).status, 'error');
  assert.equal((await service.getRun('run-old')).status, 'error');
  assert.equal((await service.listRuns())[0].status, 'error');
});

test('another service can browse an active CLI-style run without calling it interrupted', async t => {
  let finishRun;
  const { root, service } = await fixture(t, { runner: () => new Promise(resolve => { finishRun = resolve; }) });
  const viewer = createEnvironmentService({ root });
  t.after(() => viewer.close());
  const artifact = await service.saveEnvironment({ spec });
  const job = await service.run({ environmentId: artifact.id });
  while (!finishRun) await pause(2);
  const active = await service.getJob(job.id);
  assert.equal((await viewer.getJob(job.id)).status, 'running');
  assert.equal((await viewer.getRun(active.runId)).status, 'running');
  assert.equal((await viewer.listRuns())[0].status, 'running');
  await assert.rejects(viewer.cancel(job.id), error => error.status === 409);
  finishRun({ decisions: [], frames: [], providerStats: { fallbacks: 0 } });
  assert.equal((await finished(service, job.id)).status, 'done');
  assert.equal((await viewer.getRun(active.runId)).status, 'done');
});

test('invalid input and path traversal are rejected without model calls', async t => {
  let builds = 0;
  const { service } = await fixture(t, { builder: async () => { builds++; } });
  assert.throws(() => service.build({ brief: { description: '   ' } }), /required/);
  assert.throws(() => service.build({ brief: { description: 'valid' }, backend: 'shell' }), /backend/);
  await assert.rejects(service.saveEnvironment({ spec: { ...spec, code: 'arbitrary()' } }), error => error.status === 400 && error.extra.errors.length > 0);
  await assert.rejects(service.getJob('../secrets'), error => error.status === 400);
  assert.throws(() => service.getEnvironment('../secrets'), error => error.status === 400);
  for (const bad of [{ provider: 'random' }, { seed: -1 }, { maxRequests: 20001 }, { seed: '7' }]) {
    await assert.rejects(service.run({ environmentId: 'unused', ...bad }), error => error.status === 400);
  }
  assert.equal(builds, 0);
  assert.ok((await service.examples()).length >= 2);
});
