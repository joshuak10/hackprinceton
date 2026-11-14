// Offline test of validation/jev-sanity.js with a fake Jev (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSanity, WAITS, MAX_HTTP_CALLS } from '../validation/jev-sanity.js';

// A fake Jev whose join probability falls with the wait in `now`, and whose choice answers either
// ignore option order or favor the first option by `firstBias`.
function fakeJev({ firstBias = 0, status = 200 } = {}) {
  const fetch = async (url, init) => {
    fetch.calls++;
    if (status !== 200) return new Response(JSON.stringify({ detail: 'bad request' }), { status });
    const body = JSON.parse(init.body);
    const wait = Number(/about (\d+) min/.exec(body.state.now ?? '')?.[1] ?? 0);
    const answers = {};
    for (const [name, q] of Object.entries(body.questions)) {
      if (q.type === 'noul') answers[name] = { type: 'noul', noul: name === 'join' ? Math.max(0.02, 0.97 - wait / 100) : 0.3 };
      else if (q.type === 'score') answers[name] = { type: 'score', score: 1, confidence: 1, legend: {}, probabilities: { 0: 0, 1: 1, 2: 0, 3: 0, 4: 0 } };
      else {
        const keys = Object.keys(q.criteria);
        const sorted = keys.slice().sort();
        const raw = keys.map(k => (sorted.indexOf(k) + 1) + (k === keys[0] ? firstBias * keys.length * 3 : 0));
        const total = raw.reduce((s, x) => s + x, 0);
        answers[name] = { type: 'choice', choice: keys[0], confidence: 0.5, probabilities: Object.fromEntries(keys.map((k, i) => [k, raw[i] / total])) };
      }
    }
    return new Response(JSON.stringify({ model: 'jev-1.14.0', answers, usage: { input_tokens: 700, output_tokens: 50 } }), { status: 200 });
  };
  fetch.calls = 0;
  return fetch;
}

test('passes when join probability falls and option order does not matter', async () => {
  const lines = [];
  const fetch = fakeJev();
  const r = await runSanity({ apiKey: 'k', fetch, log: l => lines.push(l) });
  assert.equal(r.pass, true, lines.join('\n'));
  assert.equal(r.ladder.length, 2);
  r.ladder.forEach(row => assert.equal(row.probs.length, WAITS.length));
  assert.equal(r.order.length, 3);
  assert.equal(fetch.calls, 18);
  assert.ok(fetch.calls < MAX_HTTP_CALLS);
  assert.ok(lines.some(l => l === 'Overall: PASS'));
  assert.ok(lines.some(l => l.includes('model jev-1.14.0')));
});

test('fails when the first option is favored', async () => {
  const lines = [];
  const r = await runSanity({ apiKey: 'k', fetch: fakeJev({ firstBias: 0.5 }), log: l => lines.push(l) });
  assert.equal(r.pass, false);
  assert.ok(r.order.some(o => !o.pass));
  assert.ok(r.ladder.every(o => o.pass));
  assert.ok(lines.some(l => l === 'Overall: FAIL'));
});

test('fails and reports the error when Jev rejects the bodies', async () => {
  const lines = [];
  const r = await runSanity({ apiKey: 'k', fetch: fakeJev({ status: 422 }), log: l => lines.push(l) });
  assert.equal(r.pass, false);
  assert.ok(r.problems.length > 0);
  assert.ok(lines.some(l => l.startsWith('Error: HTTP 422')));
});
