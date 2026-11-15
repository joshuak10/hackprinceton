import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBuilderSelection, builderHelp, BUILDER_BACKENDS } from '../web/studio/builders.js';

test('the headless Claude agent is the default builder, and Codex is not offered', () => {
  assert.deepEqual(BUILDER_BACKENDS, ['claude-code', 'anthropic']);
  assert.deepEqual(createBuilderSelection().select('codex', ''), { backend: 'claude-code', model: '' });
});

test('changing authoring backends never carries a model ID to another backend', () => {
  const selection = createBuilderSelection();
  assert.deepEqual(selection.select('anthropic', 'claude-example'), { backend: 'anthropic', model: '' });
  assert.deepEqual(selection.select('claude-code', 'api-example'), { backend: 'claude-code', model: 'claude-example' });
  assert.deepEqual(selection.select('anthropic', 'claude-edited'), { backend: 'anthropic', model: 'api-example' });
});

test('saved run metadata restores its builder and model while preserving other drafts', () => {
  const selection = createBuilderSelection();
  assert.deepEqual(selection.restore({ backend: 'anthropic', model: 'api-recorded' }, 'claude-draft'),
    { backend: 'anthropic', model: 'api-recorded' });
  assert.deepEqual(selection.select('claude-code', 'api-recorded'), { backend: 'claude-code', model: 'claude-draft' });
  assert.deepEqual(selection.restore({ backend: 'anthropic', model: null }, 'claude-draft'), { backend: 'anthropic', model: '' });
  // A run saved while Codex was a builder opens on the default builder.
  assert.deepEqual(selection.restore({ backend: 'codex', model: 'gpt-fixture' }, '').backend, 'anthropic');
});

test('legacy default display labels are never sent back as model identifiers', () => {
  const selection = createBuilderSelection('anthropic');
  assert.deepEqual(selection.restore({ backend: 'claude-code', model: 'Claude Code configured default' }, 'api-draft'),
    { backend: 'claude-code', model: '' });
  assert.deepEqual(selection.restore({ backend: 'manual' }, 'current-draft'),
    { backend: 'claude-code', model: 'current-draft' });
});

test('the headless builder explains its own sign-in path and the API uses key guidance', () => {
  assert.match(builderHelp('claude-code'), /claude auth login/);
  assert.match(builderHelp('claude-code'), /claude -p/);
  assert.match(builderHelp('anthropic'), /ANTHROPIC_API_KEY/);
});
