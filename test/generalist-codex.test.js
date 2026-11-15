import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import Ajv from 'ajv';
import { buildEnvironment } from '../generalist/builder.js';

const spec = () => ({
  version: 1, title: 'Task desk', description: 'Two fictional workers. One tick is one minute.', ticks: 3,
  world: { completed: 0 }, roles: [{ id: 'worker', name: 'Worker', goal: 'Finish a task.', count: 2, initialState: 'ready' }],
  actions: [{ id: 'finish', label: 'Finish task', from: ['ready'], to: 'done', duration: 1,
    effects: [{ scope: 'world', key: 'completed', op: 'add', value: 1 }] }]
});
const reply = environment => [
  { type: 'thread.started', thread_id: 'fixture' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'Preparing the definition.' } },
  { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ environment_json: JSON.stringify(environment) }) } },
  { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }
].map(event => JSON.stringify(event)).join('\n');

function fixture(replies, { exitCode = 0, stderr = '', stalled = false, chunkSize = Infinity } = {}) {
  const calls = [];
  const spawn = (executable, args, options) => {
    const call = { executable, args, options, prompt: '', signals: [],
      schema: JSON.parse(readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8')) };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = signal => { call.signals.push(signal); queueMicrotask(() => child.emit('close', null)); };
    child.stdin = new Writable({
      write(chunk, encoding, done) { call.prompt += chunk; done(); },
      final(done) {
        done(); if (stalled) return;
        queueMicrotask(() => {
          const bytes = Buffer.from(replies[Math.min(calls.length - 1, replies.length - 1)]);
          for (let i = 0; i < bytes.length; i += chunkSize) child.stdout.write(bytes.subarray(i, i + chunkSize));
          child.stdout.end(); child.stderr.end(stderr); child.emit('close', exitCode);
        });
      }
    });
    return child;
  };
  return { spawn, calls };
}

test('Codex uses an isolated read-only command, strict transport, stdin and shared validation', async () => {
  const fake = fixture([reply(spec())]);
  const built = await buildEnvironment({ description: '$(touch bad); --model injected', guidelines: ['Keep a record.'] },
    { backend: 'codex', model: 'fixture-model', executable: '/test/codex', spawn: fake.spawn });
  assert.equal(built.builder.backend, 'codex');
  assert.equal(built.builder.model, 'fixture-model');
  assert.equal(built.spec.roles[0].count, 2);
  assert.ok(built.spec.guidelines.includes('Keep a record.'));
  const call = fake.calls[0];
  assert.equal(call.executable, '/test/codex');
  assert.equal(call.args[0], 'exec');
  assert.equal(call.args.at(-1), '-');
  assert.equal(call.options.shell, false);
  assert.notEqual(call.options.cwd, process.cwd());
  for (const flag of ['--json', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--strict-config', '--skip-git-repo-check']) assert.ok(call.args.includes(flag));
  assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(call.args.includes('approval_policy="never"'));
  assert.ok(call.args.includes('approvals_reviewer="user"'));
  assert.ok(call.args.includes('orchestrator.mcp.enabled=false'));
  assert.ok(call.args.includes('orchestrator.skills.enabled=false'));
  assert.ok(call.args.includes('project_doc_max_bytes=0'));
  for (const feature of ['shell_tool', 'unified_exec', 'code_mode', 'hooks', 'plugins', 'apps', 'multi_agent']) {
    assert.equal(call.args[call.args.indexOf(feature) - 1], '--disable');
  }
  assert.ok(!call.args.some(arg => arg.includes('touch bad')));
  assert.match(call.prompt, /touch bad/);
  assert.match(call.prompt, /environment_json/);
  const validate = new Ajv().compile(call.schema);
  assert.equal(validate({ environment_json: JSON.stringify(spec()) }), true);
  assert.equal(validate(spec()), false);
  assert.equal(validate({ environment_json: '{}', extra: 'ignored' }), false);
  await assert.rejects(access(call.options.cwd), { code: 'ENOENT' });
});

test('Codex repairs malformed transport and invalid environment mechanics using canonical feedback', async () => {
  const invalid = spec(); invalid.actions[0].effects[0].key = 'undeclared';
  const fake = fixture(['not a JSONL stream', reply(invalid), reply(spec())]);
  const result = await buildEnvironment('A task desk.', { backend: 'codex', spawn: fake.spawn });
  assert.equal(result.attempts, 3);
  assert.match(fake.calls[1].prompt, /invalid response stream/);
  assert.match(fake.calls[2].prompt, /undeclared/);
  assert.equal(result.spec.world.completed, 0);
  for (const call of fake.calls) await assert.rejects(access(call.options.cwd), { code: 'ENOENT' });
});

test('Codex requires a completed turn and valid inner JSON, preserving Unicode across chunks', async () => {
  const unicode = spec(); unicode.title = '任务桌';
  const missingCompletion = reply(spec()).split('\n').slice(0, -1).join('\n');
  const fake = fixture([missingCompletion, reply(unicode)], { chunkSize: 1 });
  const result = await buildEnvironment('A task desk.', { backend: 'codex', spawn: fake.spawn });
  assert.equal(result.attempts, 2);
  assert.equal(result.spec.title, unicode.title);
  const malformed = fixture([reply(spec()).replace(/environment_json/g, 'wrong_field')]);
  await assert.rejects(buildEnvironment('A desk.', { backend: 'codex', maxAttempts: 1, spawn: malformed.spawn }), { code: 'BUILD_FAILED' });
});

test('Codex failure diagnostics are actionable, private and never retried as model repairs', async () => {
  for (const [stderr, code, expected] of [
    ['Not logged in. Run codex login. SECRET-123', 'BUILDER_AUTH_REQUIRED', /codex login/],
    ['error: unexpected argument --ignore-user-config SECRET-123', 'BUILDER_CONFIG_INVALID', /Update the Codex CLI/],
    ['Invalid schema for response_format SECRET-123', 'BUILDER_SCHEMA_INVALID', /schema/],
    ['The model is not supported with this account. model_not_found SECRET-123', 'BUILDER_MODEL_UNAVAILABLE', /SWARM_CODEX_MODEL/],
    ['This model requires a newer version of Codex. model_not_found SECRET-123', 'BUILDER_CLI_OUTDATED', /SWARM_CODEX_BIN/],
    ['Internal connection failure SECRET-123', 'BUILDER_FAILED', /configuration/]
  ]) {
    const fake = fixture([''], { exitCode: 1, stderr });
    await assert.rejects(buildEnvironment('A desk.', { backend: 'codex', spawn: fake.spawn }), error => {
      assert.equal(error.code, code); assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /SECRET-123|claude auth/); return true;
    });
    assert.equal(fake.calls.length, 1);
    await assert.rejects(access(fake.calls[0].options.cwd), { code: 'ENOENT' });
  }
  const failed = fixture([JSON.stringify({ type: 'turn.failed', error: { message: 'Model unavailable SECRET-123' } })]);
  await assert.rejects(buildEnvironment('A desk.', { backend: 'codex', spawn: failed.spawn }), error => error.code === 'BUILDER_FAILED' && !error.message.includes('SECRET-123'));
  assert.equal(failed.calls.length, 1);
});

test('Codex deadlines, cancellation and output limits terminate children and clean temporary schemas', async () => {
  for (const [options, config, code] of [
    [{ stalled: true }, { timeoutMs: 15 }, 'BUILDER_TIMEOUT'],
    [{ stderr: 'x'.repeat(65537) }, {}, 'BUILDER_OUTPUT_LIMIT'],
    [{}, {}, 'BUILDER_OUTPUT_LIMIT']
  ]) {
    const fake = fixture([options.stalled || options.stderr ? '' : 'x'.repeat(2 * 1024 * 1024 + 1)], options);
    await assert.rejects(buildEnvironment('A desk.', { backend: 'codex', spawn: fake.spawn, ...config }), { code });
    assert.deepEqual(fake.calls[0].signals, ['SIGTERM']);
    await assert.rejects(access(fake.calls[0].options.cwd), { code: 'ENOENT' });
  }
  const fake = fixture([], { stalled: true }), controller = new AbortController();
  const pending = buildEnvironment('A desk.', { backend: 'codex', spawn: fake.spawn, signal: controller.signal });
  const timer = setInterval(() => { if (fake.calls.length) controller.abort(); }, 2);
  try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearInterval(timer); }
  assert.deepEqual(fake.calls[0].signals, ['SIGTERM']);
  await assert.rejects(access(fake.calls[0].options.cwd), { code: 'ENOENT' });
});

test('Codex settings do not inherit a Claude model or executable and CLI defaults have honest metadata', async () => {
  const keys = ['SWARM_BUILDER_MODEL', 'SWARM_CLAUDE_BIN', 'SWARM_CODEX_MODEL', 'SWARM_CODEX_BIN'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.SWARM_BUILDER_MODEL = 'claude-only'; process.env.SWARM_CLAUDE_BIN = '/fixture/claude';
    delete process.env.SWARM_CODEX_MODEL; delete process.env.SWARM_CODEX_BIN;
    const fake = fixture([reply(spec())]);
    const built = await buildEnvironment('A desk.', { backend: 'codex', spawn: fake.spawn });
    assert.equal(fake.calls[0].executable, 'codex');
    assert.ok(!fake.calls[0].args.includes('--model'));
    assert.equal(built.builder.model, null);
    process.env.SWARM_CODEX_MODEL = 'codex-only'; process.env.SWARM_CODEX_BIN = '/fixture/codex';
    await buildEnvironment('A desk.', { backend: 'codex', spawn: fake.spawn });
    assert.equal(fake.calls[1].executable, '/fixture/codex');
    assert.equal(fake.calls[1].args[fake.calls[1].args.indexOf('--model') + 1], 'codex-only');
    const explicit = await buildEnvironment('A desk.', { backend: 'codex', model: 'explicit-model', spawn: fake.spawn });
    assert.equal(explicit.builder.model, 'explicit-model');
  } finally {
    for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});

test('missing Codex executable reports its own setup guidance and cleans its workspace', async () => {
  let cwd;
  await assert.rejects(buildEnvironment('A desk.', { backend: 'codex', spawn: (bin, args, options) => {
    cwd = options.cwd; throw new Error('private installation path');
  } }), error => error.code === 'BUILDER_UNAVAILABLE' && error.message.includes('SWARM_CODEX_BIN') && !error.message.includes('private installation path'));
  await assert.rejects(access(cwd), { code: 'ENOENT' });
});
