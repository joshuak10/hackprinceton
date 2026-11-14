// Mock runs and incident derivation for the scope display (docs/PROTOTYPE.md §9b).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { syntheticBuilding, syntheticLot } from '../mockgen/synthetic.js';
import { runBuilding } from '../mockgen/building.js';
import { runParking } from '../mockgen/parking.js';
import { prepareFrames, agentsAt, heldAt, frameIndex } from '../web/scope/lib/frames.js';
import { deriveRun, keyMoments, minuteBins } from '../web/scope/lib/incidents.js';
import { matchCase } from '../web/scope/lib/prompt.js';

const hash = o => createHash('sha256').update(JSON.stringify(o)).digest('hex');
const short = { duration: 30, mix: { office: 40, cafe: 50, shopper: 40, visitor: 4, courier: 4 } };

test('building mock is deterministic for a seed and differs across seeds', () => {
  const g = syntheticBuilding();
  const a = runBuilding(g, { seed: 3, ...short });
  const b = runBuilding(g, { seed: 3, ...short });
  const c = runBuilding(g, { seed: 4, ...short });
  assert.equal(hash(a), hash(b));
  assert.notEqual(hash(a), hash(c));
});

test('building frames follow the contract: stride 5, floor index, queue lengths per service', () => {
  const run = runBuilding(syntheticBuilding(), { seed: 7, ...short });
  const F = prepareFrames(run.frames);
  assert.equal(F.stride, 5);
  assert.equal(run.frames.list[0].q.length, run.frames.services.length);
  const mid = agentsAt(F, 15);
  assert.ok(mid.length > 0);
  for (const a of mid) assert.ok(a.floor === 0 || a.floor === 1);
  for (const d of run.decisions) {
    assert.equal(d.decision.provider, 'mock');
    if (d.decision.choiceProbs) assert.ok(Math.abs(Object.values(d.decision.choiceProbs).reduce((x, y) => x + y, 0) - 1) < 1e-6);
  }
});

test('incidents come from refusals, complaints and crowding, in time order', () => {
  const run = runBuilding(syntheticBuilding(), { seed: 7, ...short });
  run.geometry = run.spec.geometry;
  const F = prepareFrames(run.frames);
  const R = deriveRun(run, F);
  const refusals = run.decisions.filter(d => (d.kind === 'line' || d.kind === 'long') && d.applied.yes === false).length;
  assert.equal(R.incidents.filter(i => i.cat === 'decision').length, refusals);
  for (let i = 1; i < R.incidents.length; i++) assert.ok(R.incidents[i].t >= R.incidents[i - 1].t);
  const fi = frameIndex(F, 30);
  const top = R.bottlenecks.at(fi, 30)[0];
  assert.ok(top.score >= top.waitMin);
});

test('door crowding needs a sustained crowd; one passer-by is not an incident', () => {
  const geometry = { kind: 'interior', metersPerUnit: 0.5, floors: [{ openings: [{ x: 10, y: 10, widthM: 1, side: 'interior' }] }] };
  const crowd = n => Array.from({ length: n }, (_, k) => [k + 1, 100 + k, 100, 0, 0]).flat();
  const frames = { stride: 5, nodes: [], services: [], list: [0, 1, 2, 3, 4, 5].map(i => ({ t: i / 15, a: i >= 1 && i <= 4 ? crowd(4) : crowd(1), q: [], c: {} })) };
  const R = deriveRun({ geometry, frames, meta: { duration: 1, clockStart: 720 }, decisions: [], remarks: [], agents: [] }, prepareFrames(frames));
  const doors = R.incidents.filter(i => i.kind === 'door_crowding');
  assert.equal(doors.length, 1);
  assert.equal(doors[0].peak, 4);
});

test('key moments pick separated peaks', () => {
  const inc = [...Array(12)].map((_, i) => ({ t: 10 + (i % 3) * 0.2, cat: 'decision', group: 'A' }))
    .concat([...Array(9)].map((_, i) => ({ t: 50 + (i % 3) * 0.2, cat: 'congestion', group: 'B' })))
    .concat([{ t: 30, cat: 'complaint', group: 'C' }]);
  const m = keyMoments(inc, minuteBins(inc, 60), 720);
  assert.deepEqual(m.map(x => x.label), ['A', 'B']);
});

test('parking mock holds stalls and reports them as a hex bitmask', () => {
  const g = syntheticLot();
  const run = runParking(g, { seed: 7, duration: 40, mix: { errands: 60, weekly: 50, browsers: 30 } });
  const F = prepareFrames(run.frames);
  const held = heldAt(F, 30, g.lot.stalls.length);
  const occupied = held.reduce((a, b) => a + b, 0);
  const f = run.frames.list[frameIndex(F, 30)];
  assert.equal(occupied, g.lot.stalls.length - f.c.free);
  assert.ok(occupied >= 34, 'staff stalls are always held');
});

test('prompt matching sends questions to the right case and refuses unrelated ones', () => {
  assert.equal(matchCase('Where do people get stuck in this building at lunch?').id, 'building');
  assert.equal(matchCase('Why do shoppers circle the parking lot on Saturday?').id, 'parking');
  assert.equal(matchCase('How many bananas fit in a minivan?'), null);
});
