import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBuilderSelection, builderHelp } from '../web/studio/builders.js';

test('changing authoring backends never carries a model ID to another backend', () => {
  const selection = createBuilderSelection();
  assert.deepEqual(selection.select('codex', 'claude-example'), { backend: 'codex', model: '' });
  assert.deepEqual(selection.select('anthropic', 'codex-example'), { backend: 'anthropic', model: '' });
  assert.deepEqual(selection.select('claude-code', 'api-example'), { backend: 'claude-code', model: 'claude-example' });
  assert.deepEqual(selection.select('codex', 'claude-edited'), { backend: 'codex', model: 'codex-example' });
  assert.deepEqual(selection.select('anthropic', 'codex-edited'), { backend: 'anthropic', model: 'api-example' });
});

test('saved run metadata restores its builder and model while preserving other drafts', () => {
  const selection = createBuilderSelection();
  assert.deepEqual(selection.restore({ backend: 'codex', model: 'codex-recorded' }, 'claude-draft'),
    { backend: 'codex', model: 'codex-recorded' });
  assert.deepEqual(selection.select('claude-code', 'codex-recorded'), { backend: 'claude-code', model: 'claude-draft' });
  assert.deepEqual(selection.restore({ backend: 'codex', model: null }, 'claude-draft'), { backend: 'codex', model: '' });
});

test('legacy default display labels are never sent back as model identifiers', () => {
  const selection = createBuilderSelection('codex');
  assert.deepEqual(selection.restore({ backend: 'claude-code', model: 'Claude Code configured default' }, 'codex-draft'),
    { backend: 'claude-code', model: '' });
  assert.deepEqual(selection.restore({ backend: 'manual' }, 'current-draft'),
    { backend: 'claude-code', model: 'current-draft' });
});

test('headless builders explain their own sign-in path and the API uses key guidance', () => {
  assert.match(builderHelp('codex'), /codex login/);
  assert.doesNotMatch(builderHelp('codex'), /ANTHROPIC|Claude/);
  assert.match(builderHelp('claude-code'), /claude auth login/);
  assert.match(builderHelp('anthropic'), /ANTHROPIC_API_KEY/);
});
