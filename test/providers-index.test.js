import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeProvider, RulesProvider, JevProvider, ReplayProvider, PROVIDER_NAMES } from '../providers/index.js';

// Runs fn with TYPESAFE_API_KEY set to `value` (undefined removes it), then restores it.
function withKey(value, fn) {
  const saved = process.env.TYPESAFE_API_KEY;
  if (value === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = saved;
  }
}

test('rules and rules-external', () => {
  const inline = makeProvider('rules');
  assert.ok(inline instanceof RulesProvider);
  assert.equal(inline.external, false);
  const ext = makeProvider('rules-external');
  assert.ok(ext instanceof RulesProvider);
  assert.equal(ext.external, true);
});

test('jev throws a clear error when TYPESAFE_API_KEY is missing', () => {
  withKey(undefined, () => assert.throws(() => makeProvider('jev'), /TYPESAFE_API_KEY is not set/));
  withKey('   ', () => assert.throws(() => makeProvider('jev'), /TYPESAFE_API_KEY/));
});

test('jev reads the key from the environment and passes options through', () => {
  const p = withKey('env-key-for-test', () => makeProvider('jev', { model: 'jev-preview', concurrency: 4, maxRequests: 10, fetch: async () => {} }));
  assert.ok(p instanceof JevProvider);
  assert.equal(p.model, 'jev-preview');
  assert.equal(p.maxRequests, 10);
  assert.equal(p.limit.concurrency, 4);
  assert.ok(!JSON.stringify(p).includes('env-key-for-test'));
  const explicit = withKey(undefined, () => makeProvider('jev', { apiKey: 'explicit', fetch: async () => {} }));
  assert.ok(explicit instanceof JevProvider);
});

test('replay needs runDir', () => {
  assert.throws(() => makeProvider('replay'), /runDir/);
  const dir = mkdtempSync(join(tmpdir(), 'swarm-index-test-'));
  try {
    writeFileSync(join(dir, 'decisions.jsonl'), '');
    assert.ok(makeProvider('replay', { runDir: dir }) instanceof ReplayProvider);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown names list the valid ones', () => {
  assert.throws(() => makeProvider('claude'), /Unknown provider "claude".*rules, rules-external, jev, replay/);
  assert.deepEqual(PROVIDER_NAMES, ['rules', 'rules-external', 'jev', 'replay']);
});
