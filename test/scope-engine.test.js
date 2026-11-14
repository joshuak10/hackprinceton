// The scope display reads runs recorded by the engine (web/scope/lib/engine.js, docs/PROTOTYPE.md §9b).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSwarm } from '../run/runner.js';
import { makeProvider } from '../providers/index.js';
import { createRecorder, loadRun } from '../run/recorder.js';
import { isEngineRun, adaptEngineRun, floorFill, decisionsFromTraces } from '../web/scope/lib/engine.js';
import { prepareFrames, agentsAt } from '../web/scope/lib/frames.js';
import { deriveRun } from '../web/scope/lib/incidents.js';

// Two rooms joined by a narrow middle door; a busy desk with impatient visitors, so people walk away.
const OUTER = [[10, 10, 90, 10], [90, 10, 90, 50], [90, 50, 10, 50], [10, 10, 10, 28], [10, 32, 10, 50]];
const WORLD = {
  title: 'Two-room test office (fictional)', question: 'Who gives up at the desk?',
  context: 'A made-up two-room office used by the display tests.', mode: 'visit',
  duration: 120, clockStart: 600, travelSpeed: 8,
  arrivals: { total: 80, start: 0, end: 40, shape: 'uniform' },
  nodes: [
    { id: 'front', name: 'Front door', kind: 'gate', x: 10, y: 30 },
    { id: 'desk', name: 'Help desk', kind: 'service', x: 80, y: 40, servers: 1, serviceTime: 6, tags: ['help'] }
  ],
  archetypes: [{ id: 'visitor', name: 'Visitors', share: 1, visits: 1, patience: 5, info: 1 }],
  minds: [{ id: 'ana', name: 'Ana Ruiz', age: 30, archetype: 'visitor', bio: 'Needs a form signed', goal: 'Be quick', social: 'her sister', informed: true, weight: 1 }],
  walls: [...OUTER, [50, 10, 50, 14], [50, 18, 50, 50]],
  doors: [
    { id: 'front_door', name: 'Front door', x1: 10, y1: 28, x2: 10, y2: 32, exterior: true },
    { id: 'mid', name: 'Middle door', x1: 50, y1: 14, x2: 50, y2: 18, exterior: false }
  ],
  geo: { clearance: 0.2, metersPerUnit: 0.5, floor: 'Floor 1', source: 'matterport-vector' }
};

async function record(root, provider) {
  const rec = createRecorder({ root, spec: WORLD, seed: 5, providerName: 'rules' });
  const { runDir } = await runSwarm({ spec: WORLD, seed: 5, provider: makeProvider(provider), recorder: rec });
  return loadRun(runDir);
}

describe('engine runs in the scope display', () => {
  let root, inline, external;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'scope-engine-'));
    inline = await record(join(root, 'inline'), 'rules');
    external = await record(join(root, 'external'), 'rules-external');
  });
  after(async () => { await rm(root, { recursive: true, force: true }); });

  const raw = run => ({ meta: run.meta, spec: run.spec, frames: run.frames, metrics: run.metrics, agents: run.agents, remarks: run.remarks, decisions: run.decisions || [] });

  test('is recognised and becomes a one-floor interior with walls, doors and scale', () => {
    const r = raw(inline);
    assert.equal(isEngineRun(r), true);
    const b = adaptEngineRun(r, { modelId: 'ABC123' });
    const f = b.geometry.floors[0];
    assert.equal(b.geometry.kind, 'interior');
    assert.equal(b.geometry.metersPerUnit, 0.5);
    assert.equal(b.geometry.source.provider, 'matterport');
    assert.equal(b.geometry.source.modelId, 'ABC123');
    assert.equal(f.walls.length, WORLD.walls.length);
    const sides = Object.fromEntries(f.openings.map(o => [o.id, o.side]));
    assert.deepEqual(sides, { front_door: 'exterior', mid: 'interior' });
    assert.ok(Math.abs(f.openings.find(o => o.id === 'mid').widthM - 2) < 1e-9);
    assert.deepEqual(b.frames.nodes.map(n => n.kind), ['entry', 'service']);
    const [x0, y0, x1, y1] = f.bounds;
    assert.ok(x0 <= 10 && y0 <= 10 && x1 >= 90 && y1 >= 50 && x0 >= 0 && x1 <= 100);
  });

  test('the cast keeps its people and gets the fields the inspector reads', () => {
    const b = adaptEngineRun(raw(inline));
    const ana = b.spec.minds.find(m => m.id === 'ana');
    assert.equal(ana.about, 'Needs a form signed');
    assert.equal(ana.wants, 'Be quick');
    assert.equal(ana.listens_to, 'her sister');
  });

  test('the floor fill covers both rooms and stays inside the building', () => {
    const fill = floorFill(WORLD.walls, WORLD.doors, WORLD.nodes, [0, 0, 100, 60]);
    assert.ok(fill, 'a fill was made');
    const at = (x, y) => fill.data[Math.floor(y / fill.cell) * fill.w + Math.floor(x / fill.cell)];
    assert.equal(at(80, 40), 1, 'the desk room');
    assert.equal(at(30, 30), 1, 'the front room, through the middle door');
    assert.equal(at(5, 30), 0, 'outside the front door');
    assert.equal(at(50, 55), 0, 'below the building');
  });

  test('a gap in the walls means no fill rather than a flooded map', () => {
    const leaky = WORLD.walls.filter(w => !(w[0] === 90 && w[2] === 90));
    assert.equal(floorFill(leaky, WORLD.doors, WORLD.nodes, [0, 0, 100, 60]), null);
  });

  test('frames use the default 3 s spacing and stride 4', () => {
    const b = adaptEngineRun(raw(inline));
    const F = prepareFrames(b.frames);
    assert.equal(F.stride, 4);
    assert.ok(Math.abs(F.list[1].t - F.list[0].t - 0.05) < 1e-3);
    assert.ok(agentsAt(F, 30).length > 0);
  });

  test('inline rules runs: walk-aways come from agent traces', () => {
    const b = adaptEngineRun(raw(inline));
    assert.equal(b.decisions.length, 0);
    const fromTraces = decisionsFromTraces(b.agents, b.frames.nodes);
    assert.ok(fromTraces.length > 0, 'impatient visitors walk away');
    const R = deriveRun(b, prepareFrames(b.frames));
    const gaveUp = R.incidents.filter(i => i.cat === 'decision');
    assert.equal(gaveUp.length, fromTraces.length);
    assert.ok(gaveUp.every(i => i.placeId === 'desk' && /Help desk/.test(i.text)));
  });

  test('runs with decision records: incidents come from the decisions', () => {
    const b = adaptEngineRun(raw(external));
    assert.ok(b.decisions.length > 0);
    const refusals = b.decisions.filter(d => (d.kind === 'line' || d.kind === 'long') && d.applied?.yes === false).length;
    const R = deriveRun(b, prepareFrames(b.frames));
    assert.equal(R.incidents.filter(i => i.cat === 'decision').length, refusals);
    assert.ok(refusals > 0);
  });
});
