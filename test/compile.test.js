// compileWorld tests with a fake Anthropic client (no network, no API key).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileWorld, NO_KEY_MESSAGE } from '../compile/compile.js';
import { validateWorld } from '../engine/spec.js';

const readJson = p => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const VALID = readJson('../worlds/er-network.json');
const SCHEMA = readJson('../worlds/schema.json');
const INVALID = { ...structuredClone(VALID), mode: 'teleport', nodes: 'not a list' };
const DESCRIPTION = 'A small emergency room on a Friday night. Which step is the bottleneck?';

// A tool_use reply the way the API returns it.
const toolReply = (input, id = 'toolu_1') => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id, name: 'submit_world', input }]
});

// Fake client: each stream() call snapshots its params (the loop mutates messages afterwards)
// and answers with the next scripted reply.
function fakeClient(replies) {
  const calls = [];
  const client = {
    beta: {
      messages: {
        stream(params) {
          calls.push(structuredClone(params));
          const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
          return { finalMessage: async () => structuredClone(reply) };
        }
      }
    }
  };
  return { client, calls };
}

describe('compileWorld', () => {
  test('the fixture world is valid and the invalid one is not', () => {
    assert.equal(validateWorld(VALID).ok, true);
    assert.equal(validateWorld(INVALID).ok, false);
  });

  test('a valid world on the first try returns spec, attempts 1 and warnings', async () => {
    const { client, calls } = fakeClient([toolReply(VALID)]);
    const out = await compileWorld(DESCRIPTION, { client });
    assert.deepEqual(out.spec, VALID);
    assert.equal(out.attempts, 1);
    assert.ok(Array.isArray(out.warnings));
    assert.deepEqual(out.warnings, validateWorld(VALID).warnings);
    assert.equal(calls.length, 1);
  });

  test('the description reaches the model in the first user message', async () => {
    const { client, calls } = fakeClient([toolReply(VALID)]);
    await compileWorld(`  ${DESCRIPTION}  `, { client });
    const first = calls[0].messages[0];
    assert.equal(first.role, 'user');
    assert.ok(first.content.includes(DESCRIPTION));
  });

  test('an invalid world is fed back as a tool error, then a fixed one gives attempts 2', async () => {
    const { client, calls } = fakeClient([toolReply(INVALID, 'toolu_bad'), toolReply(VALID, 'toolu_good')]);
    const out = await compileWorld(DESCRIPTION, { client });
    assert.equal(out.attempts, 2);
    assert.deepEqual(out.spec, VALID);
    assert.equal(calls.length, 2);

    const expectedErrors = validateWorld(INVALID).errors;
    const msgs = calls[1].messages;
    assert.equal(msgs.length, 3);
    assert.equal(msgs[1].role, 'assistant');
    assert.equal(msgs[1].content[0].id, 'toolu_bad');
    const feedback = msgs[2];
    assert.equal(feedback.role, 'user');
    const result = feedback.content[0];
    assert.equal(result.type, 'tool_result');
    assert.equal(result.tool_use_id, 'toolu_bad');
    assert.equal(result.is_error, true);
    assert.ok(expectedErrors.length > 0);
    assert.ok(result.content.includes(expectedErrors[0]), 'first validation error is in the feedback');
  });

  test('still invalid after maxAttempts throws a clear error with the last problems', async () => {
    const { client, calls } = fakeClient([toolReply(INVALID)]);
    await assert.rejects(
      compileWorld(DESCRIPTION, { client, maxAttempts: 2 }),
      err => {
        assert.match(err.message, /Could not compile a valid world in 2 attempts/);
        assert.equal(err.code, 'COMPILE_FAILED');
        assert.ok(err.errors.length > 0);
        assert.ok(err.message.includes(err.errors[0]));
        return true;
      }
    );
    assert.equal(calls.length, 2);
  });

  test('maxAttempts defaults to 3', async () => {
    const { client, calls } = fakeClient([toolReply(INVALID)]);
    await assert.rejects(compileWorld(DESCRIPTION, { client }), /3 attempts/);
    assert.equal(calls.length, 3);
  });

  test('the request offers the submit_world tool with worlds/schema.json as its input schema', async () => {
    const { client, calls } = fakeClient([toolReply(VALID)]);
    await compileWorld(DESCRIPTION, { client, model: 'test-model' });
    const req = calls[0];
    assert.equal(req.model, 'test-model');
    assert.equal(req.tools.length, 1);
    assert.equal(req.tools[0].name, 'submit_world');
    assert.deepEqual(req.tools[0].input_schema, SCHEMA);
    assert.ok(req.system.includes('submit_world'));
    assert.ok(req.system.includes(readFileSync(new URL('../worlds/SCHEMA.md', import.meta.url), 'utf8').slice(0, 200)));
  });

  test('tool_choice: the code uses auto with no parallel calls, and the loop enforces the call', async () => {
    // Contract 10 says "forces" submit_world; compile.js instead sends tool_choice auto (the model
    // rejects forced tool use) and retries when the tool is not called. Pin both behaviours.
    const { client, calls } = fakeClient([
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here is a world in prose.' }] },
      toolReply(VALID)
    ]);
    const out = await compileWorld(DESCRIPTION, { client });
    assert.deepEqual(calls[0].tool_choice, { type: 'auto', disable_parallel_tool_use: true });
    assert.equal(out.attempts, 2);
    const nudge = calls[1].messages.at(-1);
    assert.equal(nudge.role, 'user');
    assert.match(nudge.content, /submit_world/);
  });

  test('never calling the tool exhausts the attempts with a clear error', async () => {
    const { client } = fakeClient([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'no tool' }] }]);
    await assert.rejects(compileWorld(DESCRIPTION, { client, maxAttempts: 2 }), /did not call submit_world/);
  });

  test('a refusal throws immediately', async () => {
    const { client, calls } = fakeClient([{ stop_reason: 'refusal', stop_details: { explanation: 'policy' }, content: [] }]);
    await assert.rejects(compileWorld(DESCRIPTION, { client }), /declined.*policy/);
    assert.equal(calls.length, 1);
  });

  test('a non-object tool input is rejected and retried', async () => {
    const { client } = fakeClient([toolReply('just a string'), toolReply(VALID)]);
    const out = await compileWorld(DESCRIPTION, { client });
    assert.equal(out.attempts, 2);
  });

  test('an empty description is refused before any call', async () => {
    const { client, calls } = fakeClient([toolReply(VALID)]);
    await assert.rejects(compileWorld('   ', { client }), /Describe a place/);
    assert.equal(calls.length, 0);
  });
});

describe('compileWorld without a client', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  const restore = () => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  };

  test('no key and no client throws an error that explains the /swarm path', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await assert.rejects(compileWorld(DESCRIPTION), err => {
        assert.ok(err.message.includes('/swarm'));
        assert.equal(err.code, 'NO_ANTHROPIC_KEY');
        assert.equal(err.message, NO_KEY_MESSAGE);
        return true;
      });
      await assert.rejects(compileWorld(DESCRIPTION, { apiKey: '   ' }), /\/swarm/);
    } finally { restore(); }
  });

  test('the key value never appears in an error message', async () => {
    const SECRET = 'sk-ant-test-SECRET-1234567890';
    // Key passed as an option, with a client that fails on every attempt.
    const { client } = fakeClient([toolReply(INVALID)]);
    const errors = [];
    try { await compileWorld(DESCRIPTION, { apiKey: SECRET, client, maxAttempts: 1 }); } catch (e) { errors.push(e); }
    // Key from the environment, no client and no key option: must not echo it either.
    process.env.ANTHROPIC_API_KEY = SECRET;
    try {
      try { await compileWorld('   '); } catch (e) { errors.push(e); }
      // Real SDK client with the key but an unreachable base URL is avoided: no network here.
    } finally { restore(); }
    // No-key failure with a secret-looking apiKey of whitespace only.
    try { await compileWorld(DESCRIPTION, { apiKey: ' ' }); } catch (e) { errors.push(e); }
    assert.ok(errors.length >= 3);
    for (const e of errors) {
      assert.ok(!String(e.message).includes(SECRET));
      assert.ok(!String(e.stack).includes(SECRET));
      assert.ok(!JSON.stringify(e, Object.getOwnPropertyNames(e)).includes(SECRET));
    }
  });
});
