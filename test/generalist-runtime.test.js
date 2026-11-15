import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateEnvironment, normalizeEnvironment, environmentHash, ENVIRONMENT_LIMITS } from '../generalist/spec.js';
import { runEnvironment } from '../generalist/runtime.js';
import { RulesProvider } from '../providers/rules.js';
import { JevProvider, buildJevRequest } from '../providers/jev.js';

const example = name => JSON.parse(readFileSync(new URL(`../environments/${name}.json`, import.meta.url), 'utf8'));
const tiny = () => ({
  version: 1, title: 'Work review', description: 'Workers submit a reviewed task.', ticks: 4,
  guidelines: ['Review before completing.'], assumptions: ['Each tick is one minute.'],
  world: { completed: 0 }, resources: [{ id: 'reviewer', name: 'Reviewer', capacity: 1 }],
  roles: [{ id: 'worker', name: 'Worker', goal: 'Finish the task', count: 2, initialState: 'ready', state: { completed: 0 } }],
  actions: [{ id: 'review', label: 'Complete a review', from: ['ready'], to: 'done', duration: 2, resources: [{ id: 'reviewer', units: 1 }], effects: [
    { scope: 'world', key: 'completed', op: 'add', value: 1 }, { scope: 'agent', key: 'completed', op: 'add', value: 1 }
  ] }],
  metrics: [{ id: 'done', label: 'Tasks completed', scope: 'world', key: 'completed', aggregation: 'sum' }, { id: 'share', label: 'Completion share', scope: 'agent', key: 'completed', aggregation: 'mean' }]
});
const fakeProvider = handler => {
  const seen = [];
  return { name: 'fake', external: true, seen,
    async decideMany(requests, context) { seen.push({ requests: structuredClone(requests), context }); return handler ? handler(requests, context) : requests.map(request => ({ provider: 'fake', choiceProbs: { [request.options[0].key]: 1 } })); },
    stats() { return { provider: 'fake', requests: seen.reduce((sum, batch) => sum + batch.requests.length, 0), fallbacks: 0 }; }
  };
};

describe('general environment contract', () => {
  test('validates and normalizes both distinct operational examples', () => {
    for (const name of ['incident-response', 'warehouse-fulfillment']) {
      const result = validateEnvironment(example(name));
      assert.equal(result.ok, true, result.errors.join('\n'));
      assert.ok(result.spec.actions.every(action => Array.isArray(action.requirements) && action.duration >= 1));
      assert.ok(result.warnings.some(warning => warning.includes('Only declared requirements')));
    }
  });

  test('rejects unsupported code, missing references, unsafe keys, invalid types and excess actors', () => {
    const cases = [
      spec => { spec.script = 'process.exit(0)'; },
      spec => { spec.version = 2; },
      spec => { spec.roles[0].count = 501; },
      spec => { spec.roles.push({ ...spec.roles[0], id: 'second', count: 500 }); },
      spec => { spec.actions[0].resources[0].id = 'missing'; },
      spec => { spec.actions[0].resources[0].units = 2; },
      spec => { spec.actions[0].resources.push({ id: 'reviewer', units: 1 }); },
      spec => { spec.actions[0].effects[0].key = 'missing'; },
      spec => { spec.actions[0].effects[0].value = 'a number'; },
      spec => { spec.actions[0].roles = ['missing']; },
      spec => { spec.actions[0].from = ['unreachable']; },
      spec => { spec.actions[0].id = 'constructor'; },
      spec => { spec.world = JSON.parse('{"__proto__":1}'); },
      spec => { spec.ticks = Infinity; },
      spec => { spec.actions[0].duration = 0; },
      spec => { spec.metrics[0].aggregation = 'eval'; },
      spec => { spec.world.completed = 'none'; }
    ];
    for (const mutate of cases) {
      const spec = tiny(); mutate(spec);
      const result = validateEnvironment(spec);
      assert.equal(result.ok, false, JSON.stringify(spec));
      assert.ok(result.errors.length);
      assert.throws(() => normalizeEnvironment(spec), { code: 'INVALID_ENVIRONMENT' });
    }
    assert.equal(validateEnvironment(null).ok, false);
  });

  test('normalization preserves inputs and a content hash changes with guidelines', () => {
    const spec = tiny(), before = structuredClone(spec);
    normalizeEnvironment(spec);
    assert.deepEqual(spec, before);
    const hash = environmentHash(spec);
    assert.equal(hash, environmentHash(structuredClone(spec)));
    spec.guidelines.push('Escalate uncertainty.');
    assert.notEqual(hash, environmentHash(spec));
  });

  test('rejects oversized or cyclic definitions before normalization', () => {
    const spec = tiny();
    spec.description = 'x'.repeat(ENVIRONMENT_LIMITS.definitionBytes + 1);
    assert.match(validateEnvironment(spec).errors[0], /512 KiB/);
    const cycle = tiny(); cycle.world.self = cycle;
    assert.match(validateEnvironment(cycle).errors[0], /JSON serializable/);
  });
});

describe('general environment execution', () => {
  test('reserves shared capacity, applies effects only at completion and records stale choices', async () => {
    const result = await runEnvironment(tiny(), { provider: fakeProvider() });
    assert.equal(result.metrics.completedActions, 2);
    assert.equal(result.metrics.blockedDecisions, 1);
    assert.equal(result.metrics.terminalAgents, 2);
    assert.equal(result.world.completed, 2);
    assert.equal(result.resources[0].peak, 1);
    assert.equal(result.resources[0].used, 0);
    assert.deepEqual(result.metrics.custom.map(metric => metric.value), [2, 1]);
    assert.equal(result.frames.find(frame => frame.tick === 1).world.completed, 0);
    assert.equal(result.frames.find(frame => frame.tick === 2).world.completed, 1);
    for (const frame of result.frames) assert.ok(frame.resources[0].used <= 1);
    assert.ok(result.decisions.every(decision => decision.observation && decision.decision && decision.applied));
    assert.equal(result.events.filter(event => event.type === 'started').length, 2);
  });

  test('completion rechecks shared state and commits all effects atomically', async () => {
    const spec = tiny();
    spec.ticks = 2; spec.world.stock = 1; spec.actions[0].resources = [];
    spec.actions[0].requirements = [{ scope: 'world', key: 'stock', op: 'gte', value: 1 }];
    spec.actions[0].effects.push({ scope: 'world', key: 'stock', op: 'add', value: -1 });
    const result = await runEnvironment(spec, { provider: fakeProvider() });
    assert.equal(result.world.stock, 0);
    assert.equal(result.world.completed, 1);
    assert.equal(result.metrics.rejectedCompletions, 1);
    assert.equal(result.agents.reduce((sum, actor) => sum + actor.attributes.completed, 0), 1);
    assert.equal(result.events.filter(event => event.type === 'rejected').length, 1);
  });

  test('role filters and requirements restrict the options sent to Jev; guidelines reach observations', async () => {
    const spec = tiny();
    spec.roles.push({ id: 'observer', name: 'Observer', goal: 'Observe', count: 1, initialState: 'ready', state: { completed: 0 } });
    spec.actions[0].roles = ['worker'];
    spec.actions.push({ id: 'forbidden', label: 'Unavailable without evidence', from: ['ready'], to: 'done', requirements: [{ scope: 'agent', key: 'completed', op: 'gte', value: 10 }] });
    const provider = fakeProvider();
    await runEnvironment(spec, { provider });
    assert.ok(provider.seen.every(batch => batch.requests.every(request => request.archetypeId === 'worker')));
    const request = provider.seen[0].requests[0];
    assert.deepEqual(request.options.map(option => option.key), ['review']);
    assert.deepEqual(request.observation.guidelines, spec.guidelines);
    assert.equal(request.asks.choice, 'action');
    const wire = buildJevRequest(request).body;
    assert.ok(wire.questions.action.instructions.includes('`guidelines`'));
    assert.deepEqual(Object.keys(wire.questions.action.criteria), ['review']);
    assert.ok(!JSON.stringify(wire).includes('next_place'));
  });

  test('uses the real Jev transport and parser for arbitrary environment action choices', async () => {
    const sent = [];
    const provider = new JevProvider({ apiKey: 'test-secret', fetch: async (url, init) => {
      const body = JSON.parse(init.body); sent.push(body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ model: 'test-jev', answers: { action: { probabilities: { review: 1 } } }, usage: { input_tokens: 10, output_tokens: 2 } }) };
    } });
    const result = await runEnvironment(tiny(), { provider });
    assert.equal(result.world.completed, 2);
    assert.ok(sent.length > 0);
    assert.equal(result.providerStats.fallbacks, 0);
    assert.ok(result.decisions.every(decision => decision.decision.provider.startsWith('jev')));
    assert.ok(!JSON.stringify(result).includes('test-secret'));
  });

  test('rules runs are reproducible across fresh providers and do not mutate input', async () => {
    const spec = example('warehouse-fulfillment'), before = structuredClone(spec);
    const first = await runEnvironment(spec, { seed: 21, provider: new RulesProvider() });
    const second = await runEnvironment(spec, { seed: 21, provider: new RulesProvider() });
    assert.deepEqual(first, second);
    assert.deepEqual(spec, before);
    assert.ok(first.world.stock >= 0);
    assert.ok(first.metrics.completedActions > 0);
    for (const frame of first.frames) for (const resource of frame.resources) assert.ok(resource.used <= resource.capacity && resource.used >= 0);
  });

  test('unfinished actions retain their resource reservations at the horizon', async () => {
    const spec = tiny(); spec.ticks = 1;
    const result = await runEnvironment(spec);
    assert.equal(result.world.completed, 0);
    assert.equal(result.metrics.activeAgents, 1);
    assert.equal(result.resources[0].used, 1);
    assert.equal(result.frames.at(-1).tick, 1);
  });

  test('provider errors carry an auditable partial result', async () => {
    const provider = fakeProvider(() => { throw new Error('Provider unavailable'); });
    await assert.rejects(runEnvironment(tiny(), { provider }), error => {
      assert.match(error.message, /Provider unavailable/);
      assert.equal(error.partialResult.metrics.completedActions, 0);
      assert.equal(error.partialResult.frames.at(-1).tick, 0);
      return true;
    });
  });

  test('aborting before or during decisions prevents new state mutations', async () => {
    const before = new AbortController(); before.abort();
    const untouched = fakeProvider();
    await assert.rejects(runEnvironment(tiny(), { provider: untouched, signal: before.signal }), { name: 'AbortError' });
    assert.equal(untouched.seen.length, 0);
    const during = new AbortController();
    const provider = fakeProvider(requests => { during.abort(); return requests.map(request => ({ action: request.auto.action })); });
    await assert.rejects(runEnvironment(tiny(), { provider, signal: during.signal }), error => {
      assert.equal(error.name, 'AbortError');
      assert.equal(error.partialResult.events.length, 0);
      assert.equal(error.partialResult.resources[0].used, 0);
      return true;
    });
  });

  test('Jev cancellation aborts the active fetch and prevents queued calls or fallbacks', async () => {
    const control = new AbortController();
    let started = 0, fetchAborted = false;
    const provider = new JevProvider({ apiKey: 'test', concurrency: 1, fetch: async (url, init) => {
      started++;
      queueMicrotask(() => control.abort());
      return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => { fetchAborted = true; reject(init.signal.reason); }, { once: true }));
    } });
    await assert.rejects(runEnvironment(tiny(), { provider, signal: control.signal }), { name: 'AbortError' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started, 1);
    assert.equal(fetchAborted, true);
    assert.equal(provider.stats().retries, 0);
    assert.equal(provider.stats().fallbacks, 0);
  });

  test('Jev cancellation interrupts a retry-after delay before any retry', async () => {
    const control = new AbortController();
    let started = 0;
    const provider = new JevProvider({ apiKey: 'test', concurrency: 1, fetch: async () => {
      started++;
      setTimeout(() => control.abort(), 10);
      return { ok: false, status: 429, headers: { get: () => '60' }, text: async () => 'busy' };
    } });
    await assert.rejects(runEnvironment(tiny(), { provider, signal: control.signal }), { name: 'AbortError' });
    assert.equal(started, 1);
    assert.equal(provider.stats().retries, 0);
    assert.equal(provider.stats().fallbacks, 0);
  });

  test('rejects malformed provider batches and invalid seed values', async () => {
    await assert.rejects(runEnvironment(tiny(), { provider: fakeProvider(() => []) }), /decisions for 2 requests/);
    await assert.rejects(runEnvironment(tiny(), { seed: NaN }), /safe integer/);
  });

  test('bounds decision volume and retains the partial run', async () => {
    const spec = tiny(); spec.ticks = 1000; spec.roles[0].count = 500;
    spec.actions[0].resources = []; spec.actions[0].duration = 1; spec.actions[0].to = 'ready';
    await assert.rejects(runEnvironment(spec), error => {
      assert.equal(error.code, 'DECISION_LIMIT');
      assert.equal(error.partialResult.decisions.length, ENVIRONMENT_LIMITS.decisions);
      return true;
    });
  });

  test('frames are bounded and progress includes completion', async () => {
    const spec = tiny(); spec.ticks = 1000;
    const progress = [];
    const result = await runEnvironment(spec, { onProgress: value => progress.push(value) });
    assert.ok(result.frames.length <= ENVIRONMENT_LIMITS.frames);
    assert.equal(progress.at(-1).tick, 1000);
    assert.equal(progress.at(-1).ticks, 1000);
  });

  test('bounds a large observation batch before calling the provider', async () => {
    const spec = tiny(); spec.roles[0].count = 500;
    for (let index = 0; index < 63; index++) spec.world[`note${index}`] = 'x'.repeat(2000);
    const provider = fakeProvider();
    await assert.rejects(runEnvironment(spec, { provider }), error => {
      assert.equal(error.code, 'TRACE_LIMIT');
      assert.equal(error.partialResult.decisions.length, 0);
      assert.equal(error.partialResult.events.length, 0);
      return true;
    });
    assert.equal(provider.seen.length, 0);
  });
});
