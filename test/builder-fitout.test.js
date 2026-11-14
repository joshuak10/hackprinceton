// Fit-out tests (docs/PROTOTYPE.md §14f): applyFitout and `swarm fitout`. Everything here is hand-made and
// fictional: a tiny shell of three rooms in model meters (y up), and a fit-out placed inside it.
//
//   y=8 ┌──────── A ────────┬──────── B ────────┬──── C ────┐
//       │                   │                   │  (sealed) │
//  front ║  door 1.6 m       ║ door 1.2 m        │           │
//  (y=4)│                   │                   │           │
//   y=0 └───────────────────┴───────────────────┴───────────┘
//      x=0                 10                  20          26
//
// With margin 8 the 26 m x 8 m box maps to X = 8 + x * s, Y = 50 + (4 - y) * s, where s = 84 / 26
// (y is flipped: up in the model is down on the map), and one map unit is 26 / 84 m.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { applyFitout } from '../builder/fitout.js';
import { cmdFitout } from '../builder/fitout-cli.js';
import * as matterport from '../builder/matterport.js';
import * as fitoutModule from '../builder/fitout.js';
import { validateWorld } from '../engine/spec.js';
import { crossesWall } from '../engine/walls.js';
import { Sim } from '../engine/sim.js';

const { extractFloorplan, toMapUnits } = matterport;
const S = 84 / 26;
const MPU = 26 / 84;
const X = x => 8 + x * S;
const Y = y => 50 + (4 - y) * S;
const close = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

// ---------- a raw Matterport model (the GraphQL shape extractFloorplan reads) ----------
function rawModel() {
  const V = { a: [0, 0], b: [10, 0], c: [20, 0], d: [26, 0], e: [0, 8], f: [10, 8], g: [20, 8], h: [26, 8] };
  const v = k => ({ id: `v_${k}`, position: { x: V[k][0], y: V[k][1] } });
  const edge = (id, p, q, openings = []) => ({ id, type: 'wall', thickness: 0.1, centerLineBias: 0.5, openings, vertices: [v(p), v(q)] });
  const doorway = (id, width) => ({ id, type: 'doorway', width, height: 2.1, lowerElevation: 0, relativeCenter: 0.5 });
  const ab = edge('e_ab', 'b', 'f', [doorway('o_ab', 1.2)]);
  const bc = edge('e_bc', 'c', 'g');
  const room = (id, edges) => ({ id, label: '', classifications: [{ id: 'cl', label: 'Other' }], floor: { id: 'fl0' }, boundary: { edges }, holes: [] });
  return {
    data: {
      model: {
        id: 'FictionalShell1',
        floors: [{ id: 'fl0', sequence: 0, label: 'Floor 1' }],
        rooms: [
          room('room_a', [edge('e_as', 'a', 'b'), ab, edge('e_an', 'f', 'e'), edge('e_aw', 'e', 'a', [doorway('o_front', 1.6)])]),
          room('room_b', [edge('e_bs', 'b', 'c'), bc, edge('e_bn', 'g', 'f'), ab]),
          room('room_c', [edge('e_cs', 'c', 'd'), edge('e_ce', 'd', 'h'), edge('e_cn', 'h', 'g'), bc])
        ]
      }
    }
  };
}

// ---------- the same shell written by hand as a plan: no bounds, no door ends, no `outside` flags ----------
function handPlan() {
  const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  return {
    units: 'm', modelId: 'FictionalShell1', floor: { id: 'fl0', sequence: 0, label: 'Floor 1' },
    rooms: [
      { id: 'room_a', label: '', classification: 'Other', polygon: rect(0, 0, 10, 8), centroid: { x: 5, y: 4 }, area: 80 },
      { id: 'room_b', label: '', classification: 'Other', polygon: rect(10, 0, 20, 8), centroid: { x: 15, y: 4 }, area: 80 },
      { id: 'room_c', label: '', classification: 'Other', polygon: rect(20, 0, 26, 8), centroid: { x: 23, y: 4 }, area: 48 }
    ],
    walls: [
      { x1: 0, y1: 0, x2: 26, y2: 0, edgeId: 's' }, { x1: 0, y1: 8, x2: 26, y2: 8, edgeId: 'n' },
      { x1: 0, y1: 0, x2: 0, y2: 3.2, edgeId: 'w' }, { x1: 0, y1: 4.8, x2: 0, y2: 8, edgeId: 'w' },
      { x1: 10, y1: 0, x2: 10, y2: 3.4, edgeId: 'ab' }, { x1: 10, y1: 4.6, x2: 10, y2: 8, edgeId: 'ab' },
      { x1: 20, y1: 0, x2: 20, y2: 8, edgeId: 'bc' }, { x1: 26, y1: 0, x2: 26, y2: 8, edgeId: 'e' }
    ],
    doors: [
      { id: 'front', x: 0, y: 4, width: 1.6, type: 'doorway', edgeId: 'w', roomIds: ['room_a', null] },
      { id: 'mid', x: 10, y: 4, width: 1.2, type: 'doorway', edgeId: 'ab', roomIds: ['room_a', 'room_b'] }
    ],
    warnings: []
  };
}

function makeFitout(overrides = {}) {
  return {
    model: 'FictionalShell1', floor: 0,
    title: 'Fictional shell at lunch (proposed fit-out)', question: 'Where does the lunch line form?',
    context: 'A made-up two-room shop for tests.', leaveLabel: 'Leave',
    clockStart: 690, duration: 30, walkMetersPerMinute: 60,
    arrivals: { total: 12, start: 0, end: 10, shape: 'uniform' },
    gates: [
      { id: 'front', name: 'Front door', at: { x: -1, y: 4 }, weight: 3 },
      { id: 'staff', name: 'Staff room', at: { x: 18, y: 6 }, weight: 1, exit: false }
    ],
    places: [
      { id: 'cafe', name: 'Cafe', at: { x: 5, y: 4 }, servers: 1, serviceTime: 2, appeal: 0.7, price: 5, tags: ['food'], about: 'Coffee and buns.' },
      { id: 'shop', name: 'Shop', at: { x: 15, y: 2 }, servers: 1, serviceTime: 1.5, appeal: 0.5, price: 9, tags: ['retail'], about: 'Odds and ends.' }
    ],
    archetypes: [
      { id: 'visitors', name: 'Visitors', share: 0.7, needs: ['food', 'retail'], visits: 2, patience: 10, entries: ['front'], exits: ['front'] },
      { id: 'staff', name: 'Staff', share: 0.3, needs: ['food'], visits: 1, patience: 5, entries: ['staff'], exits: ['front'] }
    ],
    minds: [
      { id: 'ana', name: 'Ana Test', age: 30, archetype: 'visitors', bio: 'Fictional visitor.', personality: 'calm', goal: 'coffee', social: 'none', entry: 'front' },
      { id: 'ben', name: 'Ben Test', age: 41, archetype: 'staff', bio: 'Fictional staff member.', personality: 'busy', goal: 'lunch', social: 'none' }
    ],
    provenance: { places: 'assumed', 'gates (front door)': 'data' },
    ...overrides
  };
}

const PLAN = extractFloorplan(rawModel(), { floor: 0 });
const node = (world, id) => world.nodes.find(n => n.id === id);
const withPlace = (id, at) => makeFitout({ places: makeFitout().places.map(p => (p.id === id ? { ...p, at } : p)) });

function segDist(px, py, w) {
  const dx = w.x2 - w.x1, dy = w.y2 - w.y1, l2 = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((px - w.x1) * dx + (py - w.y1) * dy) / l2));
  return Math.hypot(w.x1 + t * dx - px, w.y1 + t * dy - py);
}

describe('applyFitout', () => {
  test('converts gate and place positions from model meters with the toMapUnits transform (y flipped)', () => {
    const { world, report } = applyFitout(PLAN, makeFitout());
    const t = toMapUnits(PLAN, { margin: 8 }).transform;
    assert.ok(close(t.scale, S, 1e-9) && close(t.tx, 8, 1e-9) && close(t.ty, 50 + 4 * S, 1e-9));
    for (const [id, x, y] of [['front', -1, 4], ['staff', 18, 6], ['cafe', 5, 4], ['shop', 15, 2]]) {
      const n = node(world, id);
      assert.ok(close(n.x, X(x)) && close(n.y, Y(y)), `${id} at (${n.x}, ${n.y}), expected (${X(x)}, ${Y(y)})`);
    }
    // Lower in the model (smaller y) is further down the map (larger y).
    assert.ok(node(world, 'shop').y > node(world, 'cafe').y);
    assert.ok(close(report.metersPerUnit, MPU, 1e-6));
    assert.equal(world.geo.metersPerUnit, report.metersPerUnit);
  });

  test('the world validates, carries walls, geo, doors and provenance, and passes the fit-out through', () => {
    const fit = makeFitout();
    const { world, report } = applyFitout(PLAN, fit);
    const check = validateWorld(world);
    assert.deepEqual(check.errors, []);
    assert.equal(check.ok, true);
    assert.equal(report.validation.ok, true);
    assert.equal(world.mode, 'visit');
    for (const k of ['title', 'question', 'context', 'leaveLabel', 'clockStart', 'duration', 'arrivals']) assert.deepEqual(world[k], fit[k], k);
    assert.deepEqual(world.archetypes, fit.archetypes);   // entries and exits included
    assert.deepEqual(world.minds, fit.minds);
    assert.ok(world.walls.length >= 8 && world.walls.every(w => w.source === 'matterport-vector'));
    assert.equal(world.geo.source, 'matterport-vector');
    assert.equal(world.geo.floor, 'Floor 1');
    // Clearance: at most a quarter of the narrowest door (1.2 m) in map units, within 0.02-1.
    assert.ok(world.geo.clearance <= 1.2 / MPU / 4 + 1e-9 && world.geo.clearance >= 0.02 && world.geo.clearance <= 1);
    assert.equal(world.provenance.walls, 'data');
    assert.equal(world.provenance.doors, 'data');
    assert.equal(world.provenance['geo.metersPerUnit'], 'data');
    assert.equal(world.provenance.places, 'assumed');
    assert.equal(world.provenance['gates (front door)'], 'data');
    const cafe = node(world, 'cafe');
    assert.deepEqual({ servers: cafe.servers, serviceTime: cafe.serviceTime, appeal: cafe.appeal, price: cafe.price, tags: cafe.tags, about: cafe.about },
      { servers: 1, serviceTime: 2, appeal: 0.7, price: 5, tags: ['food'], about: 'Coffee and buns.' });
    assert.equal(cafe.kind, 'service');
    assert.equal(node(world, 'front').weight, 3);
    assert.deepEqual({ gates: report.gates, places: report.places, doors: report.doors, walls: report.walls },
      { gates: 2, places: 2, doors: 2, walls: world.walls.length });
    assert.deepEqual(report.warnings, []);
  });

  test('a gate with exit: false becomes an entry node; other gates stay gates', () => {
    const { world, report } = applyFitout(PLAN, makeFitout());
    assert.equal(node(world, 'staff').kind, 'entry');
    assert.equal(node(world, 'front').kind, 'gate');
    assert.deepEqual(report.entries, ['staff']);
  });

  test('travelSpeed is walkMetersPerMinute / metersPerUnit; a missing walking speed defaults to 75 m/min with a warning', () => {
    const { world, report } = applyFitout(PLAN, makeFitout());
    assert.ok(close(world.travelSpeed, 60 / MPU), `travelSpeed ${world.travelSpeed}, expected ${60 / MPU}`);
    assert.equal(report.travelSpeed, world.travelSpeed);
    const fit = makeFitout();
    delete fit.walkMetersPerMinute;
    const def = applyFitout(PLAN, fit);
    assert.ok(close(def.world.travelSpeed, 75 / MPU));
    assert.ok(def.report.warnings.some(w => /walkMetersPerMinute/.test(w)));
  });

  test('door segments sit in the wall gaps and are named by what they join', () => {
    const { world, report } = applyFitout(PLAN, makeFitout());
    assert.equal(world.doors.length, 2);
    const ext = world.doors.find(d => d.exterior), int = world.doors.find(d => !d.exterior);
    // The exterior gap: x = 0 m, y 3.2-4.8 m. The interior gap: x = 10 m, y 3.4-4.6 m.
    for (const [d, gx, ylo, yhi] of [[ext, 0, 3.2, 4.8], [int, 10, 3.4, 4.6]]) {
      assert.ok(close(d.x1, X(gx)) && close(d.x2, X(gx)), `${d.name} is on the wall line`);
      const ys = [d.y1, d.y2].sort((a, b) => a - b);
      assert.ok(ys[0] >= Y(yhi) - 1e-6 && ys[1] <= Y(ylo) + 1e-6, `${d.name} stays inside the gap`);
      assert.ok(ys[1] - ys[0] > 0.8 * (yhi - ylo) * S, `${d.name} spans most of the gap`);
      assert.equal(crossesWall(world.walls, d.x1, d.y1, d.x2, d.y2), -1, `${d.name} touches no wall`);
      for (const [px, py] of [[d.x1, d.y1], [d.x2, d.y2]]) assert.ok(Math.min(...world.walls.map(w => segDist(px, py, w))) < 0.5, 'each end is next to a jamb');
    }
    assert.equal(ext.name, 'Front door');           // the gate within 3 m
    assert.equal(int.name, 'Cafe / Shop');          // the nearest place on each side, nearer first
    assert.deepEqual(report.doorNames, world.doors.map(d => d.name));
    assert.deepEqual(report.doorList.map(d => [d.exterior, d.widthM]).sort(), [[false, 1.2], [true, 1.6]]);
  });

  test('an exterior door with no gate within 3 m is "Exterior door N"; an interior door with no place on one side is "Interior door N"', () => {
    const fit = makeFitout({
      gates: [{ id: 'lobby', name: 'Lobby', at: { x: 3, y: 7 } }],
      places: [makeFitout().places[0]],
      archetypes: [{ id: 'visitors', name: 'Visitors', share: 1, needs: ['food'], entries: ['lobby'] }],
      minds: [{ id: 'ana', name: 'Ana Test', archetype: 'visitors' }]
    });
    const { world } = applyFitout(PLAN, fit);
    assert.equal(world.doors.find(d => d.exterior).name, 'Exterior door 1');
    assert.equal(world.doors.find(d => !d.exterior).name, 'Interior door 1');
    assert.equal(validateWorld(world).ok, true);
  });

  test('a place inside a wall, or closer than 0.3 m to one, is rejected by name with its position', () => {
    assert.throws(() => applyFitout(PLAN, withPlace('cafe', { x: 10, y: 2 })), err => {
      assert.match(err.message, /place "cafe" \(Cafe\) at \(10, 2\) m/);
      assert.match(err.message, /0 m from a wall/);
      assert.equal(err.problems.length, 1);
      return true;
    });
    assert.throws(() => applyFitout(PLAN, withPlace('cafe', { x: 9.75, y: 2 })), /place "cafe".*0\.25 m from a wall.*at least 0\.3 m/);
    assert.doesNotThrow(() => applyFitout(PLAN, withPlace('cafe', { x: 9.65, y: 2 })));
  });

  test('a place outside the map, or outside the node range, is rejected by name', () => {
    assert.throws(() => applyFitout(PLAN, withPlace('shop', { x: 200, y: 4 })), /place "shop" \(Shop\) at \(200, 4\) m.*outside the 0-100 map/);
    assert.throws(() => applyFitout(PLAN, withPlace('shop', { x: -2, y: 4 })), /place "shop".*outside the 3-97 range/);
  });

  test('a place in a sealed room is rejected by name; so is a gate that reaches no place', () => {
    assert.throws(() => applyFitout(PLAN, withPlace('shop', { x: 23, y: 4 })), /place "shop" \(Shop\) at \(23, 4\) m.*cannot be reached on foot from any gate/);
    const fit = makeFitout({ gates: [...makeFitout().gates, { id: 'closet', name: 'Closet', at: { x: 23, y: 4 } }] });
    assert.throws(() => applyFitout(PLAN, fit), /gate "closet" \(Closet\).*no place can be reached on foot/);
  });

  test('every failed item is listed in one error', () => {
    const fit = makeFitout({ places: [{ ...makeFitout().places[0], at: { x: 10, y: 2 } }, { ...makeFitout().places[1], at: { x: 23, y: 4 } }] });
    assert.throws(() => applyFitout(PLAN, fit), err => {
      assert.equal(err.problems.length, 2);
      assert.match(err.message, /cafe/);
      assert.match(err.message, /shop/);
      return true;
    });
  });

  test('a hand-written plan without door ends or bounds gives the same doors from the wall pieces', () => {
    const { world } = applyFitout(handPlan(), makeFitout());
    assert.equal(validateWorld(world).ok, true);
    const int = world.doors.find(d => !d.exterior), ext = world.doors.find(d => d.exterior);
    assert.equal(ext.name, 'Front door');
    assert.equal(int.name, 'Cafe / Shop');
    assert.ok(close(int.x1, X(10)) && close(int.x2, X(10)));
    const ys = [int.y1, int.y2].sort((a, b) => a - b);
    assert.ok(ys[0] >= Y(4.6) - 1e-6 && ys[1] <= Y(3.4) + 1e-6);
    assert.equal(crossesWall(world.walls, int.x1, int.y1, int.x2, int.y2), -1);
    assert.ok(close(node(world, 'cafe').x, X(5)) && close(node(world, 'cafe').y, Y(4)));
  });

  test('bad input: a map-unit plan, a fit-out without places, duplicate ids, and archetype references are reported', () => {
    assert.throws(() => applyFitout(toMapUnits(PLAN), makeFitout()), /already in map units.*meters/);
    assert.throws(() => applyFitout(PLAN, makeFitout({ places: [] })), /places: the fit-out needs a non-empty list/);
    const dup = makeFitout({ places: [{ ...makeFitout().places[0], id: 'front' }, makeFitout().places[1]] });
    assert.throws(() => applyFitout(PLAN, dup), /"front" is used more than once/);
    const odd = makeFitout({ archetypes: [{ ...makeFitout().archetypes[0], exits: ['front', 'staff', 'nowhere'] }, makeFitout().archetypes[1]] });
    const { report } = applyFitout(PLAN, odd);
    assert.ok(report.warnings.some(w => /exits: "staff" has exit: false/.test(w)));
    assert.ok(report.warnings.some(w => /exits: "nowhere" is not a gate/.test(w)));
    const other = applyFitout(PLAN, makeFitout({ model: 'OtherModel99', floor: 1 }));
    assert.ok(other.report.warnings.some(w => /model OtherModel99/.test(w)));
    assert.ok(other.report.warnings.some(w => /floor 1/.test(w)));
  });

  test('the world runs: people walk through the doors and never through a wall', () => {
    const { world } = applyFitout(PLAN, makeFitout());
    const m = new Sim(world, { seed: 3 }).runToEnd().metrics();
    assert.ok(m.spawned > 0);
    assert.equal(m.walls.violations, 0);
    assert.ok(m.walls.checkedMoves > 0);
    const front = m.doors.find(d => d.name === 'Front door');
    assert.ok(front && front.crossings > 0, 'people cross the front door');
  });
});

describe('swarm fitout', () => {
  let dir, lines, errs;
  const io = extra => ({ cwd: dir, out: s => lines.push(s), err: s => errs.push(s), env: {}, ...extra });
  const write = (rel, value) => { const f = join(dir, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(value)); return rel; };
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fitout-')); lines = []; errs = []; });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('--plan-raw writes a valid world and prints the report', async () => {
    write('raw.json', rawModel());
    write('fit.json', makeFitout());
    const code = await cmdFitout(['fit.json'], { 'plan-raw': 'raw.json', out: 'data/worlds/shell.json' }, io());
    assert.equal(code, 0, errs.join('\n'));
    const world = JSON.parse(readFileSync(join(dir, 'data/worlds/shell.json'), 'utf8'));
    assert.equal(validateWorld(world).ok, true);
    const text = lines.join('\n');
    assert.match(text, /World: 2 gates · 2 places · \d+ walls · 2 doors/);
    assert.match(text, /Front door/);
    assert.match(text, /Cafe \/ Shop/);
    assert.match(text, /Validation: OK · 0 error\(s\)/);
    assert.match(text, /Wrote data\/worlds\/shell\.json/);
    assert.match(text, /swarm\.js run data\/worlds\/shell\.json --provider jev/);
    assert.deepEqual(errs, []);
  });

  test('with no plan flag it reads data/<model>.json and writes under data/worlds/ by default', async () => {
    write('data/FictionalShell1.json', rawModel());
    write('buildings/FictionalShell1/fitout-lunch.json', makeFitout());
    const code = await cmdFitout(['buildings/FictionalShell1/fitout-lunch.json'], {}, io());
    assert.equal(code, 0, errs.join('\n'));
    assert.ok(existsSync(join(dir, 'data/worlds/FictionalShell1-fitout-lunch.json')));
    assert.match(lines.join('\n'), /Floor plan: data\/FictionalShell1\.json/);
  });

  test('a missing default floor plan is a readable error', async () => {
    write('fit.json', makeFitout());
    const code = await cmdFitout(['fit.json'], {}, io());
    assert.equal(code, 1);
    assert.match(errs.join('\n'), /data\/FictionalShell1\.json does not exist.*/s);
    assert.match(errs.join('\n'), /--plan-raw/);
  });

  test('--model without Matterport keys stops before any fetch and names both keys', async () => {
    write('fit.json', makeFitout());
    let fetched = 0;
    const modules = { matterport: { ...matterport, fetchModelGeometry: async () => { fetched++; return rawModel(); } }, fitout: fitoutModule };
    const code = await cmdFitout(['fit.json'], { model: 'FictionalShell1' }, io({ modules, env: { MATTERPORT_API_KEY: 'only-the-id' } }));
    assert.equal(code, 1);
    assert.equal(fetched, 0);
    assert.match(errs.join('\n'), /MATTERPORT_API_KEY.*MATTERPORT_API_TOKEN.*missing: MATTERPORT_API_TOKEN/s);
    assert.doesNotMatch(errs.join('\n'), /only-the-id/);
  });

  test('--model with keys fetches through the injected client and never prints the keys', async () => {
    write('fit.json', makeFitout());
    let args = null;
    const modules = { matterport: { ...matterport, fetchModelGeometry: async a => { args = a; return rawModel(); } }, fitout: fitoutModule };
    const env = { MATTERPORT_API_KEY: 'fake-token-id-123', MATTERPORT_API_TOKEN: 'fake-token-secret-456' };
    const code = await cmdFitout(['fit.json'], { model: 'FictionalShell1', out: 'data/worlds/w.json' }, io({ modules, env }));
    assert.equal(code, 0, errs.join('\n'));
    assert.deepEqual(args, { modelId: 'FictionalShell1', tokenId: 'fake-token-id-123', tokenSecret: 'fake-token-secret-456' });
    const all = [...lines, ...errs].join('\n');
    assert.doesNotMatch(all, /fake-token-id-123|fake-token-secret-456/);
  });

  test('a failing check exits 1 with the item named and writes nothing', async () => {
    write('raw.json', rawModel());
    write('fit.json', withPlace('shop', { x: 23, y: 4 }));
    const code = await cmdFitout(['fit.json'], { 'plan-raw': 'raw.json', out: 'data/worlds/bad.json' }, io());
    assert.equal(code, 1);
    assert.match(errs.join('\n'), /^swarm fitout: .*place "shop" \(Shop\).*cannot be reached on foot/s);
    assert.ok(!existsSync(join(dir, 'data/worlds/bad.json')));
  });

  test('flag problems: an unknown floor, a bad margin, and both plan sources', async () => {
    write('raw.json', rawModel());
    write('fit.json', makeFitout());
    assert.equal(await cmdFitout(['fit.json'], { 'plan-raw': 'raw.json', floor: '4' }, io()), 1);
    assert.match(errs.at(-1), /Could not read floor 4 .*not found/);
    assert.equal(await cmdFitout(['fit.json'], { 'plan-raw': 'raw.json', margin: 'wide' }, io()), 1);
    assert.match(errs.at(-1), /--margin must be a number/);
    assert.equal(await cmdFitout(['fit.json'], { 'plan-raw': 'raw.json', model: 'FictionalShell1' }, io()), 1);
    assert.match(errs.at(-1), /either --model or --plan-raw/);
    assert.equal(await cmdFitout([], {}, io()), 1);
    assert.match(errs.at(-1), /needs a fit-out file/);
  });

  test('--floor overrides the fit-out floor; writing outside data/ prints a note', async () => {
    write('raw.json', rawModel());
    write('fit.json', makeFitout({ floor: 7 }));
    const code = await cmdFitout(['fit.json'], { 'plan-raw': 'raw.json', floor: '0', out: 'worlds/shell.json' }, io());
    assert.equal(code, 0, errs.join('\n'));
    assert.match(errs.join('\n'), /real floor plan; keep it out of git/);
    assert.match(lines.join('\n'), /the fit-out is for floor 7, but the floor plan is floor 0/);
  });

  test('bin/swarm.js wires the fitout command (help line and a run with a saved plan)', () => {
    const bin = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'swarm.js');
    const help = spawnSync(process.execPath, [bin, '--help'], { cwd: dir, encoding: 'utf8' });
    assert.match(help.stdout, /fitout <fitout\.json> \[--plan-raw data\/<id>\.json \| --model <id>\]/);
    write('raw.json', rawModel());
    write('fit.json', makeFitout());
    const run = spawnSync(process.execPath, [bin, 'fitout', 'fit.json', '--plan-raw', 'raw.json', '--out', 'data/worlds/cli.json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(existsSync(join(dir, 'data/worlds/cli.json')));
    const bad = spawnSync(process.execPath, [bin, 'fitout', 'fit.json', '--profile', 'x.json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /does not take --profile/);
  });
});
