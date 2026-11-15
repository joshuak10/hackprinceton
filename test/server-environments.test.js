import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { startServer } from '../server/server.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function fixture(t, environmentOptions) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-environment-http-'));
  const server = await startServer({ port: 0, root, environmentOptions });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const get = async path => {
    const response = await fetch(server.url + path);
    return { status: response.status, data: await response.json() };
  };
  const post = async (path, body, headers = {}) => {
    const response = await fetch(server.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const finished = async id => {
    for (let i = 0; i < 200; i++) {
      const { data } = await get(`/api/environment-jobs/${id}`);
      if (['done', 'error', 'cancelled'].includes(data.status)) return data;
      await pause(5);
    }
    throw new Error('Job did not complete');
  };
  return { server, get, post, finished };
}

test('HTTP example → saved environment → rules run → persisted replay works end to end', async t => {
  const { get, post, finished } = await fixture(t);
  const health = await get('/api/health');
  assert.equal(health.data.capabilities.environments, 1);
  assert.equal(health.data.capabilities.spatialWorlds, 1);
  const examples = await get('/api/environment-examples');
  assert.equal(examples.status, 200);
  assert.ok(examples.data.examples.length >= 2);
  const saved = await post('/api/environments', { spec: examples.data.examples[0].spec });
  assert.equal(saved.status, 201);
  const start = await post('/api/environment-runs', { environmentId: saved.data.id, provider: 'rules', seed: 7, maxRequests: 100 });
  assert.equal(start.status, 202);
  const job = await finished(start.data.id);
  assert.equal(job.status, 'done', job.error);
  const { data: run } = await get(`/api/environment-runs/${job.runId}`);
  assert.equal(run.status, 'done');
  assert.equal(run.result.frames.at(-1).tick, run.spec.ticks);
  assert.ok(run.result.decisions.length);
  assert.equal((await get('/api/environment-runs')).data.runs[0].id, job.runId);
  assert.equal((await get('/api/environments')).data.environments[0].id, saved.data.id);
  assert.equal((await get(`/api/environments/${saved.data.id}`)).data.spec.title, run.title);
});

test('HTTP build passes only approved arguments and never accepts executable paths', async t => {
  let received;
  const { get, post, finished } = await fixture(t, { builder: async (brief, options) => {
    received = { brief, keys: Object.keys(options) };
    const { data } = await get('/api/environment-examples');
    return { brief, spec: data.examples[0].spec, builder: { backend: 'fixture' }, warnings: [] };
  } });
  const { data, status } = await post('/api/environment-builds', { brief: { description: 'A custom environment' }, backend: 'claude-code', executable: 'touch', spawn: 'malicious' });
  assert.equal(status, 202);
  assert.equal((await finished(data.id)).status, 'done');
  assert.equal(received.brief.description, 'A custom environment');
  assert.ok(!received.keys.includes('executable'));
  assert.ok(!received.keys.includes('spawn'));
});

test('HTTP Codex builds preserve provider selection while executable and configuration overrides stay private', async t => {
  let received;
  const { get, post, finished } = await fixture(t, { builder: async (brief, options) => {
    received = options;
    const { data } = await get('/api/environment-examples');
    return { brief, spec: data.examples[0].spec, builder: { backend: options.backend, model: options.model }, attempts: 1, warnings: [] };
  } });
  const started = await post('/api/environment-builds', {
    brief: { description: 'A Codex environment' }, backend: 'codex', model: 'codex-fixture',
    executable: '/untrusted/codex', codexExecutable: '/untrusted/codex', env: { CODEX_HOME: '/untrusted' }, args: ['--yolo']
  });
  assert.equal(started.status, 202, started.data.error);
  const job = await finished(started.data.id);
  assert.equal(job.status, 'done', job.error);
  assert.equal(received.backend, 'codex');
  assert.equal(received.model, 'codex-fixture');
  assert.deepEqual(Object.keys(received).sort(), ['backend', 'model', 'onProgress', 'signal']);
  const artifact = await get(`/api/environments/${job.environmentId}`);
  assert.equal(artifact.data.source, 'codex');
  assert.equal(artifact.data.builder.model, 'codex-fixture');
  assert.equal((await post('/api/environment-builds', { brief: { description: 'Invalid backend' }, backend: 'arbitrary-shell' })).status, 400);
});

test('HTTP builder errors and cancellation are observable job states', async t => {
  let started = false;
  const { post, finished } = await fixture(t, { builder: (brief, { signal }) => {
    if (brief.description === 'fail') throw new Error('Fixture model unavailable');
    started = true;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const failed = await post('/api/environment-builds', { brief: { description: 'fail' } });
  assert.equal((await finished(failed.data.id)).error, 'Fixture model unavailable');
  const build = await post('/api/environment-builds', { brief: { description: 'wait' } });
  assert.equal(build.status, 202, build.data.error);
  while (!started) await pause(2);
  assert.equal((await post('/api/environment-builds', { brief: { description: 'another' } })).status, 409);
  assert.equal((await post(`/api/environment-jobs/${build.data.id}/cancel`, {})).status, 200);
  assert.equal((await finished(build.data.id)).status, 'cancelled');
});

test('HTTP authoring routes enforce origin, input and identifier boundaries', async t => {
  const { get, post } = await fixture(t);
  assert.equal((await post('/api/environment-builds', { brief: { description: 'test' } }, { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await post('/api/environments', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('/api/environment-builds', { brief: { description: '' } })).status, 400);
  assert.equal((await post('/api/environments', { spec: { version: 1 } })).status, 400);
  assert.equal((await get('/api/environments/no-such-environment')).status, 404);
  assert.equal((await get('/api/environments/.hidden')).status, 400);
  assert.equal((await get('/api/environment-jobs/no-such-job')).status, 404);
  assert.equal((await post('/api/environment-runs', { environmentId: 'unknown', provider: 'bad' })).status, 400);
});

test('custom environments reuse Scope while existing spatial case URLs stay intact', async t => {
  const { server } = await fixture(t);
  const custom = await fetch(`${server.url}/scope/?mode=environment`);
  const alias = await fetch(`${server.url}/studio/`);
  assert.equal(custom.status, 200);
  assert.match(custom.headers.get('content-security-policy'), /script-src 'self'/);
  const markup = await custom.text();
  assert.equal(markup, await alias.text());
  assert.match(markup, /\/scope\/style\.css/);
  assert.match(markup, /\/studio\/app\.js/);
  const physical = await fetch(`${server.url}/scope/?case=building`);
  assert.equal(physical.status, 200);
  assert.match(await physical.text(), /id="floorTabs"/);
});

test('npm web entrypoint serves environment APIs as well as the Scope page', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarm-web-entrypoint-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/serve_web.js', import.meta.url))], {
    cwd: root, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let exited = false;
  const closed = new Promise(resolve => child.once('close', () => { exited = true; resolve(); }));
  t.after(async () => {
    if (!exited) child.kill('SIGTERM');
    await closed;
    await rm(root, { recursive: true, force: true });
  });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Web server did not start')), 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); reject(new Error(`Web server exited with ${code}`)); });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  assert.equal((await (await fetch(`${url}/api/health`)).json()).capabilities.environments, 1);
  assert.ok((await (await fetch(`${url}/api/environment-examples`)).json()).examples.length >= 2);
  assert.equal((await fetch(`${url}/scope/`)).status, 200);
  const landing = await fetch(url, { redirect: 'manual' });
  assert.equal(landing.status, 302);
  assert.equal(landing.headers.get('location'), '/scope/');
});
