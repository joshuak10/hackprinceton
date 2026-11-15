// Builder selection is separate from Jev/rules: it controls environment authoring only.
export const BUILDER_BACKENDS = ['claude-code', 'anthropic'];
export const builderName = () => 'Claude';

export function builderHelp(backend, health = {}) {
  if (backend === 'claude-code') {
    return 'A headless Claude Code agent (claude -p) is given the goal of writing the environment. It uses your local Claude Code sign-in; if needed, run claude auth login in a terminal. The definition is validated before any agent runs.';
  }
  return (health.claude ? 'Anthropic API is configured.' : 'Requires ANTHROPIC_API_KEY in .env.local.') +
    ' Claude returns a validated environment definition.';
}

function modelFromRecord(value) {
  if (typeof value !== 'string') return '';
  const model = value.trim();
  // Older records used a display label in this field. It is not a model identifier.
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model) ? model : '';
}

export function createBuilderSelection(initial = 'claude-code') {
  let backend = BUILDER_BACKENDS.includes(initial) ? initial : 'claude-code';
  const drafts = new Map(BUILDER_BACKENDS.map(name => [name, '']));
  const value = () => ({ backend, model: drafts.get(backend) });
  return {
    select(next, currentModel = drafts.get(backend)) {
      drafts.set(backend, String(currentModel ?? ''));
      if (BUILDER_BACKENDS.includes(next)) backend = next;
      return value();
    },
    restore(builder, currentModel = drafts.get(backend)) {
      drafts.set(backend, String(currentModel ?? ''));
      if (BUILDER_BACKENDS.includes(builder?.backend)) {
        backend = builder.backend;
        drafts.set(backend, modelFromRecord(builder.model));
      }
      return value();
    }
  };
}
