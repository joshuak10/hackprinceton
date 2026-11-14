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

// ---------- the one hard-coded suggestion ----------
import { hardCodedSuggestion, applySuggestion, compareRows } from '../web/scope/lib/feedback.js';

const SPEC = { nodes: [
  { id: 'door', name: 'Door', kind: 'gate' },
  { id: 'deli', name: 'Deli', kind: 'service', servers: 2 },
  { id: 'cafe', name: 'Cafe', kind: 'service', servers: 1 }
] };
const METRICS = { abandoned: 30, abandonRate: 0.25, avgWait: 6, served: 90, nodes: [
  { id: 'deli', score: 100, abandoned: 5, avgWait: 3 }, { id: 'cafe', score: 900, abandoned: 25, avgWait: 9.5 }
] };

test('the hard-coded suggestion adds one server at the worst bottleneck', () => {
  const s = hardCodedSuggestion(SPEC, METRICS);
  assert.equal(s.nodeId, 'cafe');
  assert.equal(s.label, 'Add one more server at Cafe');
  assert.equal(s.change, 'Cafe: 1 server to 2');
  assert.match(s.why, /25 people walked away .* 9\.5 min/);
  // No metrics: the first place with a line. No places: no suggestion.
  assert.equal(hardCodedSuggestion(SPEC, null).nodeId, 'deli');
  assert.equal(hardCodedSuggestion({ nodes: [SPEC.nodes[0]] }, METRICS), null);
});

test('applying the suggestion changes only that place, on a copy', () => {
  const s = hardCodedSuggestion(SPEC, METRICS);
  const out = applySuggestion(SPEC, s);
  assert.equal(out.nodes[2].servers, 2);
  assert.equal(SPEC.nodes[2].servers, 1);
  assert.deepEqual(out.nodes.slice(0, 2), SPEC.nodes.slice(0, 2));
  assert.throws(() => applySuggestion({ nodes: [] }, s), /no place "cafe"/);
});

test('the comparison lists both runs\' headline numbers and the changed place', () => {
  const s = hardCodedSuggestion(SPEC, METRICS);
  const after = { abandoned: 12, abandonRate: 0.1, avgWait: 4, served: 108, nodes: [{ id: 'cafe', abandoned: 6, avgWait: 4.5 }] };
  const rows = compareRows(METRICS, after, s);
  assert.deepEqual(rows.map(r => [r.label, r.before, r.after]), [
    ['Walked away', 30, 12], ['Walk-away rate', 0.25, 0.1], ['Average wait', 6, 4], ['Served', 90, 108],
    ['Average wait at Cafe', 9.5, 4.5], ['Walked away at Cafe', 25, 6]
  ]);
});
