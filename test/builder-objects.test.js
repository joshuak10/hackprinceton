// Solid objects from the mesh (builder/objects.js), carried by worlds as `objects` (engine/spec.js, §13f), placed by
// the fit-out builder and drawn by the scope display. Everything here is generated and fictional.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { meshObjects, floorLevels } from '../builder/objects.js';
import { parseObj } from '../builder/mesh.js';
import { applyFitout } from '../builder/fitout.js';
import { normalizeSpec, validateWorld, cleanSpec } from '../engine/spec.js';
import { Sim } from '../engine/sim.js';
import { polylineCrossesWall } from '../engine/walls.js';
import { adaptEngineRun } from '../web/scope/lib/engine.js';

// ---------- a generated mesh: a 10 m x 8 m room with a doorway, a crate, a table, a door leaf and a floor above ----------
// Boxes as [x0, y0, z0, x1, y1, z1] in meters, z up, floor at z = 0.
const BOXES = {
  south: [0, -0.1, 0, 10, 0.1, 3], north: [0, 7.9, 0, 10, 8.1, 3], west: [-0.1, 0, 0, 0.1, 8, 3],
  eastLow: [9.9, 0, 0, 10.1, 3, 3], eastHigh: [9.9, 4.2, 0, 10.1, 8, 3],
  doorLeaf: [9.95, 3, 0, 10.05, 4.2, 2.1],          // a closed door in the doorway
  crate: [3, 3, 0, 4, 4, 1.2],                      // 1 m x 1 m, 1.2 m high
  tableTop: [6, 5, 0.72, 8, 6, 0.75],               // 2 m x 1 m top on thin legs
  leg1: [6, 5, 0, 6.05, 5.05, 0.72], leg2: [7.95, 5.95, 0, 8, 6, 0.72],
  pebble: [2, 6, 0, 2.05, 6.05, 0.4],               // a speck: scan noise
  floor: [0, 0, -0.2, 10, 8, 0],
  slab: [0, 0, 3.8, 10, 8, 4.0]                     // the next floor up
};

function boxObj(boxes) {
  const lines = [];
  let n = 0;
  for (const [x0, y0, z0, x1, y1, z1] of Object.values(boxes)) {
    const c = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    for (const [x, y, z] of c) lines.push(`v ${x} ${y} ${z}`);
    // Outward faces, counterclockwise seen from outside (the top faces up, the bottom down).
    for (const f of [[1, 4, 3, 2], [5, 6, 7, 8], [1, 2, 6, 5], [2, 3, 7, 6], [3, 4, 8, 7], [4, 1, 5, 8]]) {
      lines.push(`f ${f.map(i => i + n).join(' ')}`);
    }
    n += 8;
  }
  return lines.join('\n') + '\n';
}

const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const PLAN = {
  units: 'm', modelId: 'FictionalRoom1', floor: { id: 'f0', sequence: 0, label: 'Floor 1' },
  rooms: [{ id: 'shop', classification: 'Other', polygon: rect(0, 0, 10, 8), holes: [] }],
  walls: [
    { x1: 0, y1: 0, x2: 10, y2: 0 }, { x1: 0, y1: 8, x2: 10, y2: 8 }, { x1: 0, y1: 0, x2: 0, y2: 8 },
    { x1: 10, y1: 0, x2: 10, y2: 3 }, { x1: 10, y1: 4.2, x2: 10, y2: 8 }
  ],
  doors: [{ id: 'front', x: 10, y: 3.6, x1: 10, y1: 3, x2: 10, y2: 4.2, width: 1.2, roomIds: ['shop', null], outside: true }],
  warnings: []
};
const MESH = boxObj(BOXES);

describe('meshObjects', () => {
  const found = meshObjects(MESH, PLAN);
  const near = (o, x, y) => o.polygon.reduce((s, p) => s + p.x, 0) / o.polygon.length - x < 0.6 &&
    Math.abs(o.polygon.reduce((s, p) => s + p.y, 0) / o.polygon.length - y) < 0.6;

  test('finds the floors in the mesh and cuts the lowest one', () => {
    assert.equal(floorLevels(parseObj(MESH)).length, 2);
    assert.equal(found.levels.length, 2);
    assert.ok(Math.abs(found.levels[0]) < 0.05 && Math.abs(found.levels[1] - 4) < 0.05, found.levels.join(', '));
    assert.ok(Math.abs(found.floorHeight) < 0.05);
  });

  test('finds the crate and the table, not the walls, the door leaf or the speck', () => {
    assert.equal(found.objects.length, 2, JSON.stringify(found.objects.map(o => [o.id, o.areaM2, o.sizeM])));
    const [table, crate] = found.objects;
    assert.ok(Math.abs(table.areaM2 - 2) < 0.4 && near(table, 7, 5.5), `table ${table.areaM2} m²`);
    assert.ok(Math.abs(crate.areaM2 - 1) < 0.3 && near(crate, 3.5, 3.5), `crate ${crate.areaM2} m²`);
    assert.deepEqual(found.objects.map(o => o.id), ['obj1', 'obj2']);
    assert.ok(found.dropped.specks >= 1);
  });

  test('outlines cover each object and are counterclockwise', () => {
    for (const o of found.objects) {
      let a = 0;
      for (let i = 0; i < o.polygon.length; i++) { const p = o.polygon[i], q = o.polygon[(i + 1) % o.polygon.length]; a += p.x * q.y - q.x * p.y; }
      assert.ok(a > 0, `${o.id} winds clockwise`);
    }
    const crate = found.objects[1];
    const xs = crate.polygon.map(p => p.x), ys = crate.polygon.map(p => p.y);
    assert.ok(Math.min(...xs) <= 3.05 && Math.max(...xs) >= 3.95 && Math.min(...ys) <= 3.05 && Math.max(...ys) >= 3.95);
  });

  test('a given floor height is used as is, and an empty cut finds nothing', () => {
    const above = meshObjects(MESH, PLAN, { floorHeight: 4 });
    assert.equal(above.floorHeight, 4);
    assert.equal(above.objects.length, 0);
  });

  test('is deterministic', () => {
    assert.deepEqual(meshObjects(MESH, PLAN).objects, found.objects);
  });
});

// ---------- worlds with objects ----------
const WORLD = {
  title: 'Fictional room with a crate', question: 'Does the crate get in the way?', context: 'A made-up room for tests.',
  mode: 'visit', duration: 30, clockStart: 600, travelSpeed: 20,
  arrivals: { total: 30, start: 0, end: 10, shape: 'uniform' },
  nodes: [
    { id: 'door', name: 'Door', kind: 'gate', x: 10, y: 50 },
    { id: 'desk', name: 'Desk', kind: 'service', x: 90, y: 50, servers: 1, serviceTime: 1 }
  ],
  archetypes: [{ id: 'v', name: 'Visitors', share: 1, visits: 1, patience: 10 }],
  minds: [{ id: 'a', name: 'Ann Test', archetype: 'v', bio: 'Fictional.' }],
  walls: [[5, 20, 95, 20], [5, 80, 95, 80], [5, 20, 5, 45], [5, 55, 5, 80], [95, 20, 95, 80]],
  objects: [{ id: 'crate', name: 'Crate', kind: 'object', source: 'mesh-slice', polygon: [[40, 30], [60, 30], [60, 70], [40, 70]] }],
  geo: { metersPerUnit: 0.1, clearance: 0.5 }
};

describe('objects in a world', () => {
  test('each outline joins the walls, and normalizing twice gives the same walls', () => {
    const spec = normalizeSpec(WORLD);
    assert.equal(spec.objects.length, 1);
    assert.equal(spec.walls.length, 5 + 4);
    assert.ok(spec.walls.slice(5).every(w => w.source === 'mesh-slice'));
    const again = normalizeSpec(spec);
    assert.equal(again.walls.length, 9);
    assert.deepEqual(normalizeSpec(cleanSpec(spec)).walls, spec.walls);
  });

  test('a node inside an object fails validation and names the object', () => {
    const bad = { ...WORLD, nodes: [...WORLD.nodes, { id: 'shelf', name: 'Shelf', kind: 'service', x: 50, y: 50 }] };
    const { ok, errors } = validateWorld(bad);
    assert.equal(ok, false);
    assert.ok(errors.some(e => /inside object "Crate"/.test(e)), errors.join('\n'));
  });

  test('a message about touching an object names the object, not a wall index', () => {
    const bad = { ...WORLD, nodes: [WORLD.nodes[0], { ...WORLD.nodes[1], x: 60, y: 50.01 }] };
    const { errors } = validateWorld({ ...bad, nodes: [...bad.nodes] });
    assert.ok(errors.some(e => /objects\[0\] \("Crate"\)/.test(e)), errors.join('\n'));
  });

  test('a bad outline is dropped with a warning', () => {
    const { ok, warnings } = validateWorld({ ...WORLD, objects: [{ name: 'Flat', polygon: [[10, 10], [20, 20], [30, 30]] }] });
    assert.equal(ok, true);
    assert.ok(warnings.some(w => /objects\[0\]: needs an outline/.test(w)));
  });

  test('people walk around the object: no recorded move crosses it', () => {
    const sim = new Sim(WORLD, { seed: 3 });
    sim.runToEnd();
    const crate = sim.spec.walls.slice(5);
    assert.equal(sim.wallStats.violations, 0);
    assert.ok(sim.wallStats.checkedMoves > 0);
    let positions = 0;
    for (const f of sim.frames.list) {
      for (let i = 0; i < f.a.length; i += 4) {
        const id = f.a[i], p = { x: f.a[i + 1] / 10, y: f.a[i + 2] / 10 };
        assert.ok(!(p.x > 40.5 && p.x < 59.5 && p.y > 30.5 && p.y < 69.5), `agent ${id} inside the crate at ${p.x}, ${p.y}`);
        positions++;
      }
    }
    assert.ok(positions > 100);
    assert.equal(sim.metrics().served > 0, true);
    assert.ok(polylineCrossesWall(crate, [{ x: 10, y: 50 }, { x: 90, y: 50 }]), 'the straight line would cross the crate');
  });
});

// ---------- the fit-out builder ----------
describe('applyFitout with objects', () => {
  const fitout = {
    model: 'FictionalRoom1', floor: 0, title: 'Fictional shop (proposed fit-out)', question: 'Where do lines form?',
    context: 'A made-up shop for tests.', clockStart: 600, duration: 30, walkMetersPerMinute: 60,
    arrivals: { total: 10, start: 0, end: 10, shape: 'uniform' },
    gates: [{ id: 'front', name: 'Front door', at: { x: 9.3, y: 3.6 } }],
    places: [{ id: 'till', name: 'Till', at: { x: 2, y: 2 }, servers: 1, serviceTime: 1 }],
    archetypes: [{ id: 'v', name: 'Visitors', share: 1, visits: 1, patience: 10 }],
    minds: [{ id: 'a', name: 'Ann Test', archetype: 'v', bio: 'Fictional.' }]
  };
  const plan = { ...PLAN, objects: meshObjects(MESH, PLAN).objects };

  test('writes the objects in map units and records them as data', () => {
    const { world, report } = applyFitout(plan, fitout);
    assert.equal(world.objects.length, 2);
    assert.equal(report.objects, 2);
    assert.equal(world.provenance.objects, 'data');
    assert.ok(world.objects.every(o => o.polygon.every(([x, y]) => x >= 0 && x <= 100 && y >= 0 && y <= 100)));
    assert.equal(validateWorld(world).ok, true);
  });

  test('a place too close to an object fails and names the object', () => {
    const fit = { ...fitout, places: [{ ...fitout.places[0], at: { x: 3.5, y: 4.15 } }] };
    assert.throws(() => applyFitout(plan, fit), /from Object 2 .*\(obj2, from the mesh\)/);
  });
});

// ---------- the display ----------
test('the scope display draws objects as filled shapes with thin outlines', () => {
  const sim = new Sim(WORLD, { seed: 3 });
  const frames = { walls: sim.walls.map(w => [w.x1, w.y1, w.x2, w.y2].map(v => Math.round(v * 100) / 100)), doors: [], nodes: WORLD.nodes, list: [] };
  const b = adaptEngineRun({ meta: {}, spec: normalizeSpec(WORLD), frames, agents: [] });
  const f = b.geometry.floors[0];
  assert.equal(f.objects.length, 1);
  assert.ok(f.obstacles && f.obstacles.rle.includes(','));
  const thin = f.walls.filter(w => w[4] < 0.5), thick = f.walls.filter(w => w[4] >= 1);
  assert.equal(thin.length, 4);
  assert.equal(thick.length, 5);
});
