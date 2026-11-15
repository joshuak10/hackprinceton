import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cmdEnvironmentBuild, cmdEnvironmentValidate, cmdEnvironmentRun, cmdEnvironmentRuns } from '../generalist/cli.js';

const spec = {
  version: 1, title: 'Offline handoff', description: 'One handoff per agent.', ticks: 3,
  world: { finished: 0 },
  roles: [{ id: 'task', name: 'Task', goal: 'Finish', count: 2, initialState: 'ready' }],
  actions: [{ id: 'finish', label: 'Complete the handoff', from: ['ready'], to: 'done', effects: [{ scope: 'world', key: 'finished', op: 'add', value: 1 }] }],
  metrics: [{ id: 'finished', label: 'Finished', scope: 'world', key: 'finished', aggregation: 'sum' }]
};
async function workspace(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'swarm-general-cli-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}
const cli = fileURLToPath(new URL('../bin/swarm.js', import.meta.url));

test('env-validate handles plain definitions, artifacts and invalid JSON values', async t => {
  const cwd = await workspace(t), lines = [];
  await writeFile(join(cwd, 'plain.json'), JSON.stringify(spec));
  await writeFile(join(cwd, 'artifact.json'), JSON.stringify({ id: 'env-test', spec }));
  await writeFile(join(cwd, 'bad.json'), 'null');
  assert.equal(await cmdEnvironmentValidate(['plain.json'], { json: true }, { cwd, out: line => lines.push(line) }), 0);
  assert.equal(JSON.parse(lines.at(-1)).spec.title, spec.title);
  assert.equal(await cmdEnvironmentValidate(['artifact.json'], {}, { cwd, out: line => lines.push(line) }), 0);
  assert.equal(await cmdEnvironmentValidate(['bad.json'], {}, { cwd, out: line => lines.push(line) }), 1);
});

test('env-build persists the original brief and generation metadata and exports plain JSON', async t => {
  const cwd = await workspace(t), lines = [];
  await writeFile(join(cwd, 'brief.json'), JSON.stringify({ description: 'A handoff workflow.', guidelines: ['Keep an audit trail.'] }));
  await writeFile(join(cwd, 'guidelines.txt'), 'No invisible work.\n');
  const build = async (brief, options) => {
    assert.deepEqual(brief.guidelines, ['Keep an audit trail.', 'No invisible work.']);
    assert.equal(options.backend, 'claude-code');
    return { spec, brief, warnings: [], attempts: 2, builder: { backend: 'test', model: 'fixture' } };
  };
  const code = await cmdEnvironmentBuild([], { brief: 'brief.json', guidelines: 'guidelines.txt', out: 'output.json', json: true }, { cwd, build, out: line => lines.push(line), err: () => {} });
  assert.equal(code, 0);
  const artifact = JSON.parse(lines.at(-1));
  assert.equal(artifact.attempts, 2);
  assert.equal(artifact.builder.model, 'fixture');
  assert.equal(artifact.brief.description, 'A handoff workflow.');
  assert.equal(JSON.parse(await readFile(join(cwd, 'output.json'), 'utf8')).version, 1);
  assert.ok((await readdir(join(cwd, 'data', 'environments'))).includes(artifact.id + '.json'));
});

test('env-build refuses accidental overwrite before requesting generation', async t => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, 'existing.json'), 'keep');
  await assert.rejects(cmdEnvironmentBuild(['Workflow'], { out: 'existing.json' }, { cwd, build: () => assert.fail('must not generate') }), /already exists/);
  assert.equal(await readFile(join(cwd, 'existing.json'), 'utf8'), 'keep');
  await assert.rejects(cmdEnvironmentBuild(['Workflow'], { brief: 'brief.json' }, { cwd }), /not both/);
});

test('env-run records an offline rules simulation and env-runs lists it', async t => {
  const cwd = await workspace(t), lines = [];
  await writeFile(join(cwd, 'spec.json'), JSON.stringify(spec));
  assert.equal(await cmdEnvironmentRun(['spec.json'], { json: true }, { cwd, out: line => lines.push(line), err: () => {} }), 0);
  const run = JSON.parse(lines.at(-1));
  assert.equal(run.status, 'done');
  assert.equal(run.provider, 'rules');
  assert.equal(run.result.world.finished, 2);
  assert.equal(run.result.decisions.length, 2);
  assert.equal(await cmdEnvironmentRuns([], { json: true }, { cwd, out: line => lines.push(line) }), 0);
  assert.equal(JSON.parse(lines.at(-1))[0].id, run.id);
});

test('actual swarm CLI dispatches environment commands and keeps JSON output machine-readable', async t => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, 'spec.json'), JSON.stringify(spec));
  const validated = spawnSync(process.execPath, [cli, 'env-validate', 'spec.json', '--json'], { cwd, encoding: 'utf8' });
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(JSON.parse(validated.stdout).ok, true);
  const ran = spawnSync(process.execPath, [cli, 'env-run', 'spec.json', '--provider', 'rules', '--seed', '11', '--json'], { cwd, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(JSON.parse(ran.stdout).seed, 11);
  assert.equal(JSON.parse(ran.stdout).result.world.finished, 2);
  const invalid = spawnSync(process.execPath, [cli, 'env-run', 'spec.json', '--provider', 'invalid'], { cwd, encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /provider must be rules or jev/);
  const help = spawnSync(process.execPath, [cli, '--help'], { cwd, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--backend claude-code\|anthropic/);
});
