import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { access } from 'node:fs/promises';
import { buildEnvironment, normalizeBrief } from '../generalist/builder.js';

const valid = () => ({
  version: 1, title: 'Claims desk', description: 'A fictional claims desk. One tick is one minute.', ticks: 12,
  guidelines: ['Explain decisions plainly.'], assumptions: ['Review takes two minutes.'],
  world: { reviewed: 0 }, resources: [{ id: 'reviewer', name: 'Review capacity', capacity: 1 }],
  roles: [{ id: 'claim', name: 'Standard claim', goal: 'Receive a fair review.', count: 4, initialState: 'waiting', state: { completed: 0 } }],
  actions: [{ id: 'review', label: 'Submit for review', from: ['waiting'], to: 'done', duration: 2,
    resources: [{ id: 'reviewer', units: 1 }], effects: [{ scope: 'world', key: 'reviewed', op: 'add', value: 1 }] }],
  metrics: [{ id: 'reviewed', label: 'Reviewed claims', scope: 'world', key: 'reviewed', aggregation: 'sum' }]
});
const brief = { description: 'An insurance claims workflow.', guidelines: ['Never invent source data.'], objectives: 'Measure reviewed claims.', constraints: 'One reviewer.' };

function fakeSpawn(replies, { stalled = false, exitCode = 0, chunkSize = Infinity } = {}) {
  const calls = [];
  function spawn(executable, args, options) {
    const call = { executable, args, options, prompt: '', signals: [] };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = signal => { call.signals.push(signal); queueMicrotask(() => child.emit('close', null)); return true; };
    child.stdin = new Writable({
      write(chunk, encoding, done) { call.prompt += chunk.toString(); done(); },
      final(done) {
        done();
        if (stalled) return;
        queueMicrotask(() => {
          const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
          const bytes = Buffer.from(typeof reply === 'string' ? reply : JSON.stringify(reply));
          for (let at = 0; at < bytes.length; at += chunkSize) child.stdout.write(bytes.subarray(at, at + chunkSize));
          child.stdout.end(); child.emit('close', exitCode);
        });
      }
    });
    return child;
  }
  return { spawn, calls };
}

test('brief validation bounds inputs before generation, preserving explicit fields', async () => {
  assert.deepEqual(normalizeBrief({ description: '  claim flow ', guidelines: 'Be clear.\n\nKeep a record.\n' }), {
    description: 'claim flow', guidelines: ['Be clear.', 'Keep a record.'], objectives: '', constraints: ''
  });
  for (const bad of [null, {}, { description: ' ' }, { description: 'x', guidelines: [1] }, { description: 'x', command: 'touch bad' }, { description: 'x'.repeat(12001) }]) {
    let called = false;
    await assert.rejects(buildEnvironment(bad, { generator: () => { called = true; } }), err => err.code === 'INVALID_BRIEF');
    assert.equal(called, false);
  }
});

test('build preserves the brief, user guidelines and assumptions with real validation', async () => {
  const stages = [];
  const result = await buildEnvironment(brief, {
    generator: async args => {
      assert.match(args.prompt, /insurance claims workflow/);
      assert.match(args.prompt, /One reviewer/);
      assert.match(args.system, /No|Do not write program code/);
      return valid();
    },
    onProgress: event => stages.push(event.stage)
  });
  assert.deepEqual(result.brief, brief);
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.spec.guidelines, ['Never invent source data.', 'Explain decisions plainly.']);
  assert.deepEqual(result.spec.assumptions, ['Review takes two minutes.']);
  assert.deepEqual(stages, ['building', 'validating', 'ready']);
  assert.match(result.warnings.at(-1), /Only declared requirements/);
});

test('invalid generated references are fed back and repaired within the bounded loop', async () => {
  const calls = [];
  const result = await buildEnvironment(brief, {
    generator: async args => {
      calls.push(args);
      const spec = valid();
      if (args.attempt === 1) spec.actions[0].resources[0].id = 'unknown';
      return spec;
    }
  });
  assert.equal(result.attempts, 2);
  assert.ok(calls[1].errors.length > 0);
  assert.match(calls[1].prompt, /unknown/);
  await assert.rejects(buildEnvironment(brief, { maxAttempts: 2, generator: async () => ({ version: 1 }) }), err => err.code === 'BUILD_FAILED' && err.errors.length > 0);
});

test('headless backend fixes permissions, tools and settings and sends user data only on stdin', async () => {
  const { spawn, calls } = fakeSpawn([{ type: 'result', subtype: 'success', structured_output: valid() }]);
  const result = await buildEnvironment({ ...brief, description: '$(touch do-not-run); --dangerously-skip-permissions' }, { spawn, executable: '/test/claude', model: 'test-model' });
  assert.equal(result.attempts, 1);
  const call = calls[0];
  assert.equal(call.executable, '/test/claude');
  assert.equal(call.options.shell, false);
  assert.notEqual(call.options.cwd, process.cwd());
  for (const option of ['--print', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(call.args.includes(option));
  assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
  assert.equal(call.args[call.args.indexOf('--setting-sources') + 1], '');
  assert.equal(call.args[call.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(!call.args.includes('--dangerously-skip-permissions'));
  assert.ok(!call.args.some(arg => arg.includes('touch do-not-run')));
  assert.match(call.prompt, /touch do-not-run/);
  await assert.rejects(access(call.options.cwd), err => err.code === 'ENOENT');
});

test('headless invalid JSON repairs; process failures do not retry or expose diagnostics', async () => {
  const repaired = fakeSpawn(['not json', { result: JSON.stringify(valid()) }]);
  const result = await buildEnvironment(brief, { spawn: repaired.spawn });
  assert.equal(result.attempts, 2);
  assert.match(repaired.calls[1].prompt, /invalid JSON/);
  const failed = fakeSpawn(['secret-looking stdout'], { exitCode: 1 });
  await assert.rejects(buildEnvironment(brief, { spawn: failed.spawn }), err => err.code === 'BUILDER_FAILED' && !err.message.includes('secret-looking'));
  assert.equal(failed.calls.length, 1);
  await assert.rejects(access(failed.calls[0].options.cwd), err => err.code === 'ENOENT');
});

test('headless output preserves Unicode when a character crosses pipe chunks', async () => {
  const spec = valid();
  spec.title = '索赔审核';
  const { spawn } = fakeSpawn([{ structured_output: spec }], { chunkSize: 1 });
  const result = await buildEnvironment(brief, { spawn });
  assert.equal(result.spec.title, '索赔审核');
});

test('headless timeouts and cancellation terminate the child and remove its temporary workspace', async () => {
  const timed = fakeSpawn([], { stalled: true });
  await assert.rejects(buildEnvironment(brief, { spawn: timed.spawn, timeoutMs: 15 }), err => err.code === 'BUILDER_TIMEOUT');
  assert.deepEqual(timed.calls[0].signals, ['SIGTERM']);
  await assert.rejects(access(timed.calls[0].options.cwd), err => err.code === 'ENOENT');
  const cancelled = fakeSpawn([], { stalled: true });
  const controller = new AbortController();
  const promise = buildEnvironment(brief, { spawn: cancelled.spawn, signal: controller.signal });
  const timer = setInterval(() => { if (cancelled.calls.length) controller.abort(); }, 2);
  try { await assert.rejects(promise, err => err.name === 'AbortError'); } finally { clearInterval(timer); }
  assert.deepEqual(cancelled.calls[0].signals, ['SIGTERM']);
  await assert.rejects(access(cancelled.calls[0].options.cwd), err => err.code === 'ENOENT');
});

test('headless output cap kills oversized output', async () => {
  const { spawn, calls } = fakeSpawn(['x'.repeat(2 * 1024 * 1024 + 1)]);
  await assert.rejects(buildEnvironment(brief, { spawn }), err => err.code === 'BUILDER_OUTPUT_LIMIT');
  assert.deepEqual(calls[0].signals, ['SIGTERM']);
});

test('Anthropic backend submits the schema and supports validation repairs without a live client', async () => {
  const calls = [];
  const client = { messages: { stream(params, options) {
    calls.push({ params, options });
    return { finalMessage: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'submit_environment', input: calls.length === 1 ? { version: 1 } : valid() }] }) };
  } } };
  const result = await buildEnvironment(brief, { backend: 'anthropic', model: 'test-model', client });
  assert.equal(result.attempts, 2);
  assert.equal(calls[0].params.tools[0].name, 'submit_environment');
  assert.equal(calls[0].params.tools[0].input_schema.properties.version.const, 1);
  assert.equal(calls[0].params.model, 'test-model');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.match(calls[1].params.messages[0].content, /failed validation/);
});

test('Anthropic errors remain bounded and do not leak credential-bearing SDK messages', async () => {
  await assert.rejects(buildEnvironment(brief, { backend: 'anthropic', model: 'test-model', apiKey: '' }), err => err.code === 'NO_ANTHROPIC_KEY');
  const client = { messages: { stream() { throw Object.assign(new Error('API secret xyz'), { status: 401 }); } } };
  await assert.rejects(buildEnvironment(brief, { backend: 'anthropic', model: 'test-model', client }), err => err.code === 'BUILDER_FAILED' && err.message.includes('401') && !err.message.includes('xyz'));
});

test('builder rejects invalid options and cancelled work before calling a generator', async () => {
  for (const options of [{ backend: 'shell' }, { model: '--bad' }, { maxAttempts: 4 }, { timeoutMs: 0 }]) {
    await assert.rejects(buildEnvironment(brief, { ...options, generator: () => assert.fail('must not generate') }), err => err.code === 'INVALID_BUILDER_OPTION');
  }
  await assert.rejects(buildEnvironment(brief, { signal: AbortSignal.abort(), generator: () => assert.fail('must not generate') }), err => err.name === 'AbortError');
});
