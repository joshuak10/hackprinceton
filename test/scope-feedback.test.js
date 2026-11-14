// Suggestions in the scope display: which run is analyzed, and how the advisor's measured effects read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedbackTarget, effectWords, valueWords } from '../web/scope/lib/feedback.js';

test('engine runs are analyzed by run id; mock cases by case', () => {
  const engineCase = { id: 'building', runs: [{ meta: { runId: 'r1' } }] };
  assert.deepEqual(feedbackTarget({ meta: { runId: 'r2' } }, engineCase), { runId: 'r2' });
  // A mock bundle has a meta.runId too ("mock-building-…"), but it is not a run on the server.
  assert.deepEqual(feedbackTarget({ meta: { runId: 'mock-building-synthetic-s7' } }, { id: 'building' }), { caseId: 'building' });
  assert.deepEqual(feedbackTarget({ meta: {} }, { id: 'parking', runs: [] }), { caseId: 'parking' });
});

test("the advisor's measured effects read as before and after, with how many seeds agree", () => {
  assert.equal(valueWords('abandonRate', 0.125), '12.5%');
  assert.equal(valueWords('avgWait', 6.25), '6.3 min');
  assert.equal(
    effectWords('abandonRate', { before: 0.2, after: 0.12, change: -0.08, spread: 0.01, bySeed: [-0.1, -0.07, 0.01] }),
    'Walk-away rate: 20.0% to 12.0%, same direction on 2 of 3 seeds'
  );
  assert.equal(effectWords('avgWait', { after: 4 }), 'Average wait: 4.0 min after the change');
  assert.equal(effectWords('avgWait', null), 'Average wait: n/a');
});
