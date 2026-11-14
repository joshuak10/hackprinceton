// Building fields of the world spec (docs/PROTOTYPE.md §13a and §14d): walls, geo, edges[].via, doors,
// provenance, archetypes[].entries and archetypes[].exits normalize, round-trip through cleanSpec with the
// same specHash, and are checked by validateWorld; travelSpeed goes up to 600. Every world here is small,
// hand-written and fictional.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeSpec, validateWorld, cleanSpec, specHash, applyPatch, PATCH_FIELDS } from '../engine/spec.js';

const clone = o => JSON.parse(JSON.stringify(o));

// ---------- fixtures ----------

// Two rooms side by side (x 10-90, y 20-80), split at x = 50. The street door is the gap x 20-30 in the
// bottom wall; the inner doorway is the gap y 45-55 in the dividing wall. Walls 5 and 6 are the divider.
const WALLS = [
  { x1: 10, y1: 20, x2: 90, y2: 20 },
  [10, 20, 10, 80],
  [90, 20, 90, 80],
  { x1: 10, y1: 80, x2: 20, y2: 80 },
  { x1: 30, y1: 80, x2: 90, y2: 80 },
  { x1: 50, y1: 20, x2: 50, y2: 45, source: 'drawn' },
  { x1: 50, y1: 55, x2: 50, y2: 80 }
];
const SEALED = [...WALLS.slice(0, 5), { x1: 50, y1: 20, x2: 50, y2: 80 }]; // no inner doorway

const BUILDING = {
  title: 'Two-room test floor',
  question: 'Which room backs up at lunch?',
  context: 'A weekday lunch hour on a fictional test floor.',
  mode: 'visit', duration: 120, clockStart: 690, travelSpeed: 20,
  arrivals: { total: 100, start: 0, end: 60, shape: 'peak' },
  nodes: [
    { id: 'street', name: 'Street door', kind: 'gate', x: 25, y: 88 },
    { id: 'cafe', name: 'Cafe', kind: 'service', x: 30.04, y: 50, servers: 2, serviceTime: 4, tags: ['food'], about: 'Sandwich counter by the door' },
    { id: 'clinic', name: 'Clinic', kind: 'service', x: 70, y: 50, servers: 1, serviceTime: 10, tags: ['care'], about: 'Walk-in clinic in the back room' }
  ],
  archetypes: [{ id: 'visitors', name: 'Visitors', share: 1, visits: 2, patience: 20, entries: ['Street door'] }],
  minds: [{ id: 'ana', name: 'Ana Ruiz', archetype: 'visitors', bio: 'On a short lunch break from a nearby office.' }],
  walls: WALLS,
  geo: { metersPerUnit: 0.8, clearance: 0.2, floor: 1, source: 'hand-drawn test plan' },
  doors: [
    { id: 'front', name: 'Front door', x1: 20, y1: 80, x2: 30, y2: 80, exterior: true },
    { id: 'inner', name: 'Inner doorway', x1: 50, y1: 45, x2: 50, y2: 55 }
  ],
  provenance: { 'nodes[1].servers': 'assumed', walls: 'data', 'nodes[2].about': 'owner-reported' }
};

const ROUTE = {
  title: 'Two-room corridor test',
  question: 'Which doorway slows people down?',
  context: 'Morning arrivals on a fictional test floor.',
  mode: 'route', duration: 60, clockStart: 480,
  arrivals: { total: 50, start: 0, end: 30, shape: 'uniform' },
  nodes: [
    { id: 'street', name: 'Street', kind: 'origin', x: 25, y: 88 },
    { id: 'lobby', name: 'Lobby', kind: 'intersection', x: 30, y: 30 },
    { id: 'suite', name: 'Suite', kind: 'destination', x: 70, y: 30 }
  ],
  edges: [
    { from: 'street', to: 'lobby', name: 'Front door' },
    { from: 'lobby', to: 'suite', name: 'Inner doorway', via: [{ x: 50, y: 50 }] }
  ],
  archetypes: [{ id: 'staff', name: 'Staff', share: 1 }],
  minds: [{ id: 'bo', name: 'Bo Lindqvist', archetype: 'staff', bio: 'Arrives early to open the suite.' }],
  walls: WALLS
};

const withChanges = (base, changes) => ({ ...clone(base), ...changes });
const hasMessage = (list, re) => list.some(m => re.test(m));

// ---------- existing worlds ----------

describe('worlds without building fields', () => {
  // Recorded before the building fields existed (Nov 14). If a world file is edited on purpose, update its hash.
  const HASHES = {
    'er-network': '1bcb5c29fcb7',
    'food-hall-lunch': '569d711c89f3',
    'office-lobby-morning': '5061c84d8699',
    'rush-hour-roads': 'd3699c03c97d',
    'theme-park': 'cd0203f2cebd'
  };
  const NEW_KEYS = ['walls', 'geo', 'doors', 'provenance'];

  for (const [name, hash] of Object.entries(HASHES)) {
    test(`${name} keeps its specHash and cleanSpec has no building fields`, () => {
      const raw = JSON.parse(readFileSync(new URL(`../worlds/${name}.json`, import.meta.url), 'utf8'));
      const spec = normalizeSpec(raw);
      assert.equal(specHash(spec), hash);
      const clean = cleanSpec(spec);
      for (const k of NEW_KEYS) assert.equal(k in clean, false, `cleanSpec has ${k}`);
      for (const e of clean.edges ?? []) assert.equal('via' in e, false);
      for (const a of clean.archetypes) assert.equal('entries' in a, false);
      for (const a of clean.archetypes) assert.equal('exits' in a, false);
      for (const a of spec.archetypes) assert.deepEqual([a.entries, a.exits], [[], []]);
      assert.deepEqual([spec.walls, spec.geo, spec.doors, spec.provenance], [[], null, [], null]);
      const checked = validateWorld(raw);
      assert.equal(checked.ok, true);
      assert.deepEqual(checked.warnings, []);
    });
  }
});

// ---------- normalizing each field ----------

describe('walls', () => {
  test('both input forms normalize to { x1, y1, x2, y2 } and keep a valid source', () => {
    const spec = normalizeSpec(BUILDING);
    assert.equal(spec.walls.length, 7);
    assert.deepEqual(spec.walls[1], { x1: 10, y1: 20, x2: 10, y2: 80 });
    assert.deepEqual(spec.walls[5], { x1: 50, y1: 20, x2: 50, y2: 45, source: 'drawn' });
  });

  test('dropped and clamped walls are warnings, and later errors name the input index', () => {
    const raw = withChanges(BUILDING, { walls: [[1, 2], [3, 3, 3, 3], ...WALLS, [-5, 1, 2, 1]] });
    const { ok, errors, warnings } = validateWorld(raw);
    assert.equal(ok, true, errors.join('\n'));
    assert.ok(hasMessage(warnings, /^walls\[0\]: .*dropped/));
    assert.ok(hasMessage(warnings, /^walls\[1\]: zero length; dropped/));
    assert.ok(hasMessage(warnings, /^walls\[9\]\.x1: -5 is below the minimum 0; using 0/));

    // The divider piece is input walls[7] (two dropped walls come first), not kept walls[5].
    raw.nodes.push({ id: 'booth', name: 'Booth', kind: 'service', x: 50.03, y: 30 });
    const bad = validateWorld(raw);
    assert.ok(hasMessage(bad.errors, /^nodes\[3\]: "Booth" .* from walls\[7\];/), bad.errors.join('\n'));
  });

  test('more than 4000 walls is an error that normalizeSpec throws; 4000 is allowed', () => {
    const far = n => Array.from({ length: n }, () => [1, 1, 2, 1]);
    const many = withChanges(BUILDING, { walls: [...WALLS, ...far(3994)] });
    const { ok, errors, warnings } = validateWorld(many);
    assert.equal(ok, false);
    assert.ok(hasMessage(errors, /^walls: The world has 4001 walls, above the maximum 4000;/));
    assert.equal(hasMessage(warnings, /keeping the first/), false);
    assert.throws(() => normalizeSpec(many), /The world has 4001 walls, above the maximum 4000/);
    assert.equal(normalizeSpec(withChanges(BUILDING, { walls: [...WALLS, ...far(3993)] })).walls.length, 4000);
  });
});

describe('geo', () => {
  test('fills defaults: clearance 0.2, the rest empty', () => {
    const spec = normalizeSpec(withChanges(BUILDING, { geo: {} }));
    assert.deepEqual(spec.geo, { metersPerUnit: null, clearance: 0.2, floor: null, source: '' });
  });

  test('keeps given values and clamps clearance to 0.02-1', () => {
    assert.deepEqual(normalizeSpec(BUILDING).geo, { metersPerUnit: 0.8, clearance: 0.2, floor: 1, source: 'hand-drawn test plan' });
    const hi = validateWorld(withChanges(BUILDING, { geo: { clearance: 5, floor: 'Level 2' } }));
    assert.equal(hi.spec.geo.clearance, 1);
    assert.equal(hi.spec.geo.floor, 'Level 2');
    assert.ok(hasMessage(hi.warnings, /^geo\.clearance: 5 is above the maximum 1; using 1/));
    const lo = validateWorld(withChanges(BUILDING, { geo: { clearance: 0.001 } }));
    assert.equal(lo.spec.geo.clearance, 0.02);
  });

  test('a non-object geo or an unknown geo field is a warning', () => {
    const bad = validateWorld(withChanges(BUILDING, { geo: 'meters', walls: undefined }));
    assert.equal(bad.spec.geo, null);
    assert.ok(hasMessage(bad.warnings, /^geo: "meters" is not an object; ignored/));
    const odd = validateWorld(withChanges(BUILDING, { geo: { units: 'm', metersPerUnit: 'wide' } }));
    assert.ok(hasMessage(odd.warnings, /^geo\.units: unknown field/));
    assert.ok(hasMessage(odd.warnings, /^geo\.metersPerUnit: "wide" is not a number; ignored/));
    assert.equal(odd.spec.geo.metersPerUnit, null);
  });
});

describe('edges[].via', () => {
  const plain = { ...clone(ROUTE), walls: undefined };

  test('takes { x, y } and [x, y] points, clamped to the map, at most 12', () => {
    const via = [{ x: 40, y: 40 }, [120, 50], ...Array.from({ length: 11 }, (_, i) => ({ x: 45 + i, y: 45 }))];
    const raw = clone(plain);
    raw.edges[1].via = via;
    const { spec, warnings } = validateWorld(raw);
    const got = spec.edges[1].via;
    assert.equal(got.length, 12);
    assert.deepEqual(got.slice(0, 2), [{ x: 40, y: 40 }, { x: 100, y: 50 }]);
    assert.ok(hasMessage(warnings, /^edges\[1\]\.via: 13 entries; only the first 12 are used/));
    assert.ok(hasMessage(warnings, /^edges\[1\]\.via\[1\]\.x: 120 is above the maximum 100; using 100/));
  });

  test('drops points that are not points', () => {
    const raw = clone(plain);
    raw.edges[1].via = ['here', { x: 50 }, { x: 50, y: 50 }];
    const { spec, warnings } = validateWorld(raw);
    assert.deepEqual(spec.edges[1].via, [{ x: 50, y: 50 }]);
    assert.ok(hasMessage(warnings, /^edges\[1\]\.via\[0\]: "here" is not a point/));
    assert.ok(hasMessage(warnings, /^edges\[1\]\.via\[1\]\.y: missing; point dropped/));
  });

  test('with no explicit length, length is the polyline length / 2; edges without via are unchanged', () => {
    const spec = normalizeSpec(plain);
    // lobby (30, 30) → (50, 50) → suite (70, 30): two legs of 20√2.
    assert.ok(Math.abs(spec.edges[1].length - 20 * Math.SQRT2) < 1e-9);
    assert.equal(spec.edges[0].length, Math.hypot(25 - 30, 88 - 30) / 2);
    assert.deepEqual(spec.edges[0].via, []);
    const given = clone(plain);
    given.edges[1].length = 3;
    assert.equal(normalizeSpec(given).edges[1].length, 3);
  });
});

describe('doors', () => {
  test('normalize with unique ids, names and exterior flags', () => {
    const raw = withChanges(BUILDING, {
      doors: [...BUILDING.doors, { id: 'front', x1: 60, y1: 80.5, x2: 62, y2: 80.5, exterior: 'yes' }]
    });
    const { spec, warnings } = validateWorld(raw);
    assert.deepEqual(spec.doors[0], { id: 'front', name: 'Front door', x1: 20, y1: 80, x2: 30, y2: 80, exterior: true });
    assert.deepEqual(spec.doors[1], { id: 'inner', name: 'Inner doorway', x1: 50, y1: 45, x2: 50, y2: 55, exterior: false });
    assert.equal(spec.doors[2].id, 'front_2');
    assert.equal(spec.doors[2].name, 'front_2');
    assert.equal(spec.doors[2].exterior, true);
    assert.ok(hasMessage(warnings, /^doors\[2\]\.id: "front" is already used; using "front_2"/));
    assert.ok(hasMessage(warnings, /^doors\[2\]\.exterior: "yes" is not true or false; using true/));
  });

  test('entries that are not doors are dropped with warnings', () => {
    const raw = withChanges(BUILDING, {
      doors: ['front', { id: 'half', x1: 20, y1: 80, y2: 80 }, { id: 'dot', x1: 40, y1: 40, x2: 40, y2: 40 }, { id: 'far', x1: -3, y1: 79, x2: 1, y2: 79 }]
    });
    const { ok, spec, warnings } = validateWorld(raw);
    assert.equal(ok, true);
    assert.deepEqual(spec.doors.map(d => d.id), ['far']);
    assert.equal(spec.doors[0].x1, 0);
    assert.ok(hasMessage(warnings, /^doors\[0\]: not an object; ignored/));
    assert.ok(hasMessage(warnings, /^doors\[1\]\.x2: missing; door dropped/));
    assert.ok(hasMessage(warnings, /^doors\[2\]: zero length; dropped/));
    assert.ok(hasMessage(warnings, /^doors\[3\]\.x1: -3 is below the minimum 0; using 0/));
  });

  test('at most 500 are kept', () => {
    const doors = Array.from({ length: 501 }, (_, i) => ({ id: `d${i}`, x1: 20, y1: 80, x2: 30, y2: 80 }));
    const { spec, warnings } = validateWorld(withChanges(BUILDING, { doors }));
    assert.equal(spec.doors.length, 500);
    assert.ok(hasMessage(warnings, /^doors: 501 entries; only the first 500 are used/));
  });

  test('a door in a wall gap is silent; one that touches a wall or sits away from every wall is a warning', () => {
    assert.deepEqual(validateWorld(BUILDING).warnings, []);
    const raw = withChanges(BUILDING, {
      doors: [...BUILDING.doors, { id: 'through', x1: 40, y1: 30, x2: 60, y2: 30 }, { id: 'loose', x1: 30, y1: 60, x2: 32, y2: 60 }]
    });
    const { ok, warnings } = validateWorld(raw);
    assert.equal(ok, true);
    assert.ok(hasMessage(warnings, /^doors\[2\]: door "through" touches walls\[5\]; a door should sit in a gap/));
    assert.ok(hasMessage(warnings, /^doors\[3\]: door "loose" is not in a gap between walls/));
    assert.equal(warnings.length, 2);
  });
});

describe('provenance', () => {
  test('is kept as-is', () => {
    assert.deepEqual(normalizeSpec(BUILDING).provenance, BUILDING.provenance);
  });

  test('keeps at most 300 keys and flags values that are not provenance labels', () => {
    const big = {};
    for (let i = 0; i < 301; i++) big[`nodes[${i}].servers`] = 'assumed';
    big['nodes[0].servers'] = 'guess';
    const { spec, warnings } = validateWorld(withChanges(BUILDING, { provenance: big }));
    assert.equal(Object.keys(spec.provenance).length, 300);
    assert.equal(spec.provenance['nodes[0].servers'], 'guess');
    assert.ok(hasMessage(warnings, /^provenance: 301 keys; only the first 300 are kept/));
    assert.ok(hasMessage(warnings, /^provenance: 1 value is not one of data, vision, assumed, owner-reported .*kept as-is/));
  });

  test('a non-object is a warning, and an empty object is the same as none', () => {
    const bad = validateWorld(withChanges(BUILDING, { provenance: ['data'] }));
    assert.equal(bad.spec.provenance, null);
    assert.ok(hasMessage(bad.warnings, /^provenance: \["data"\] is not an object; ignored/));
    assert.equal(specHash(normalizeSpec(withChanges(BUILDING, { provenance: {} }))),
      specHash(normalizeSpec(withChanges(BUILDING, { provenance: undefined }))));
  });
});

describe('archetypes[].entries', () => {
  test('resolve gate or entry nodes by id or exact name', () => {
    const raw = clone(BUILDING);
    raw.nodes.push({ id: 'side', name: 'Side door', kind: 'entry', x: 95, y: 50 });
    raw.walls[2] = [90, 20, 90, 45];
    raw.walls.push([90, 55, 90, 80]);
    raw.archetypes[0].entries = ['Street door', 'side', 'street'];
    const { ok, errors, spec } = validateWorld(raw);
    assert.equal(ok, true, errors.join('\n'));
    assert.deepEqual(spec.archetypes[0].entries, ['street', 'side']);
  });

  test('default is every entry ([]); references to nothing are warnings, not errors', () => {
    assert.deepEqual(normalizeSpec(withChanges(BUILDING, { archetypes: [{ id: 'v', name: 'V' }] })).archetypes[0].entries, []);
    const raw = clone(BUILDING);
    raw.archetypes[0].entries = ['street', 'nowhere', 'cafe'];
    const { ok, spec, warnings } = validateWorld(raw);
    assert.equal(ok, true);
    assert.deepEqual(spec.archetypes[0].entries, ['street']);
    assert.ok(hasMessage(warnings, /^archetypes\[0\]\.entries\[1\]: "nowhere" is not a node id or name; ignored/));
    assert.ok(hasMessage(warnings, /^archetypes\[0\]\.entries\[2\]: "cafe" is a service, not a gate or entry; ignored/));
    raw.archetypes[0].entries = ['nowhere'];
    const none = validateWorld(raw);
    assert.deepEqual(none.spec.archetypes[0].entries, []);
    assert.ok(hasMessage(none.warnings, /^archetypes\[0\]\.entries: no usable gate or entry listed; using every entry/));
  });

  test('are ignored in route mode', () => {
    const raw = clone(ROUTE);
    raw.archetypes[0].entries = ['street'];
    const { spec, warnings } = validateWorld(raw);
    assert.deepEqual(spec.archetypes[0].entries, []);
    assert.ok(hasMessage(warnings, /^archetypes\[0\]\.entries: ignored in route mode/));
  });
});

describe('archetypes[].exits', () => {
  // BUILDING plus a side exit in a gap of the right wall (people may leave there; nobody enters there)
  // and a rear entry outside the left wall (people may enter there; nobody leaves there).
  const withSideExit = () => {
    const raw = clone(BUILDING);
    raw.nodes.push({ id: 'side', name: 'Side exit', kind: 'exit', x: 95, y: 50 });
    raw.nodes.push({ id: 'rear', name: 'Rear entry', kind: 'entry', x: 5, y: 50 });
    raw.walls[2] = [90, 20, 90, 45];
    raw.walls.push([90, 55, 90, 80]);
    return raw;
  };

  test('resolve gate or exit nodes by id or exact name, without duplicates', () => {
    const raw = withSideExit();
    raw.archetypes[0].exits = ['Side exit', 'street', 'side'];
    const { ok, errors, warnings, spec } = validateWorld(raw);
    assert.equal(ok, true, errors.join('\n'));
    assert.deepEqual(warnings, []);
    assert.deepEqual(spec.archetypes[0].exits, ['side', 'street']);
  });

  test('default is every exit ([]); references to nothing are warnings, not errors', () => {
    assert.deepEqual(normalizeSpec(BUILDING).archetypes[0].exits, []);
    assert.deepEqual(normalizeSpec(withChanges(BUILDING, { archetypes: [{ id: 'v', name: 'V', exits: [] }] })).archetypes[0].exits, []);
    const raw = withSideExit();
    raw.archetypes[0].exits = ['side', 'nowhere', 'cafe', 'rear'];
    const { ok, errors, spec, warnings } = validateWorld(raw);
    assert.equal(ok, true, errors.join('\n'));
    assert.deepEqual(spec.archetypes[0].exits, ['side']);
    assert.ok(hasMessage(warnings, /^archetypes\[0\]\.exits\[1\]: "nowhere" is not a node id or name; ignored$/));
    assert.ok(hasMessage(warnings, /^archetypes\[0\]\.exits\[2\]: "cafe" is a service, not a gate or exit; ignored$/));
    assert.ok(hasMessage(warnings, /^archetypes\[0\]\.exits\[3\]: "rear" is an entry, not a gate or exit; ignored$/));
    assert.equal(warnings.length, 3);
    raw.archetypes[0].exits = ['nowhere'];
    const none = validateWorld(raw);
    assert.equal(none.ok, true);
    assert.deepEqual(none.spec.archetypes[0].exits, []);
    assert.ok(hasMessage(none.warnings, /^archetypes\[0\]\.exits: no usable gate or exit listed; using every exit$/));
    raw.archetypes[0].exits = 'side';
    const notList = validateWorld(raw);
    assert.deepEqual(notList.spec.archetypes[0].exits, []);
    assert.ok(hasMessage(notList.warnings, /^archetypes\[0\]\.exits: "side" is not a list; using every exit$/));
  });

  test('are ignored in route mode', () => {
    const raw = clone(ROUTE);
    raw.archetypes[0].exits = ['suite'];
    const { ok, spec, warnings } = validateWorld(raw);
    assert.equal(ok, true);
    assert.deepEqual(spec.archetypes[0].exits, []);
    assert.ok(hasMessage(warnings, /^archetypes\[0\]\.exits: ignored in route mode$/));
    assert.equal('exits' in cleanSpec(spec).archetypes[0], false);
  });

  test('cleanSpec emits them only when non-empty; a cleaned or recorded spec keeps them and its hash', () => {
    const raw = withSideExit();
    raw.archetypes[0].exits = ['side'];
    const spec = normalizeSpec(raw);
    const clean = cleanSpec(spec);
    assert.deepEqual(clean.archetypes[0].exits, ['side']);
    assert.deepEqual(Object.keys(clean.archetypes[0]).slice(-2), ['entries', 'exits']);
    const again = normalizeSpec(clone(clean));
    assert.equal(specHash(again), specHash(spec));
    assert.deepEqual(cleanSpec(again), clean);
    assert.equal(specHash(normalizeSpec(clone(spec))), specHash(spec));
    const checked = validateWorld(clone(clean));
    assert.equal(checked.ok, true, checked.errors.join('\n'));
    assert.deepEqual(checked.warnings, []);

    // Missing and [] clean and hash the same; a list changes the hash.
    const missingExits = normalizeSpec(withSideExit());
    const emptyRaw = withSideExit();
    emptyRaw.archetypes[0].exits = [];
    assert.equal('exits' in cleanSpec(missingExits).archetypes[0], false);
    assert.equal(specHash(normalizeSpec(emptyRaw)), specHash(missingExits));
    assert.notEqual(specHash(spec), specHash(missingExits));

    // What-if patches go through cleanSpec, so they keep the group's exits.
    const { spec: patched, applied } = applyPatch(spec, [{ kind: 'archetype', id: 'visitors', field: 'patience', value: 30 }]);
    assert.equal(applied.length, 1);
    assert.deepEqual(patched.archetypes[0].exits, ['side']);
  });
});

describe('travelSpeed range (§14d)', () => {
  const at = speed => withChanges(BUILDING, { travelSpeed: speed });

  test('accepts up to 600 map units per minute; the default and the minimum are unchanged', () => {
    for (const v of [60, 60.5, 135, 600]) {
      const { ok, warnings, spec } = validateWorld(at(v));
      assert.equal(ok, true);
      assert.equal(spec.travelSpeed, v);
      assert.deepEqual(warnings, []);
      assert.equal(cleanSpec(spec).travelSpeed, v);
      assert.equal(specHash(normalizeSpec(clone(cleanSpec(spec)))), specHash(spec));
    }
    assert.equal(normalizeSpec(at(undefined)).travelSpeed, 4);
    const low = validateWorld(at(0.1));
    assert.equal(low.spec.travelSpeed, 0.2);
    assert.ok(hasMessage(low.warnings, /^travelSpeed: 0\.1 is below the minimum 0\.2; using 0\.2$/));
  });

  test('above 600 is clamped with a warning, for travelSpeed and its alias walkSpeed', () => {
    const high = validateWorld(at(700));
    assert.equal(high.ok, true);
    assert.equal(high.spec.travelSpeed, 600);
    assert.deepEqual(high.warnings, ['travelSpeed: 700 is above the maximum 600; using 600']);
    const alias = validateWorld(withChanges(BUILDING, { travelSpeed: undefined, walkSpeed: 1000 }));
    assert.equal(alias.spec.travelSpeed, 600);
    assert.deepEqual(alias.warnings, ['walkSpeed: 1000 is above the maximum 600; using 600']);
    assert.equal(normalizeSpec(at(1e6)).travelSpeed, 600);
  });

  test('is patchable up to 600', () => {
    const spec = normalizeSpec(BUILDING);
    assert.equal(applyPatch(spec, [{ kind: 'global', field: 'travelSpeed', value: 300 }]).spec.travelSpeed, 300);
    assert.equal(applyPatch(spec, [{ kind: 'global', field: 'travelSpeed', value: 900 }]).spec.travelSpeed, 600);
  });

  test('route mode still ignores it silently', () => {
    const { warnings } = validateWorld(withChanges(ROUTE, { travelSpeed: 900 }));
    assert.deepEqual(warnings, []);
  });
});

// ---------- round trips ----------

describe('round trips', () => {
  for (const [label, world] of [['visit building', BUILDING], ['route building', ROUTE]]) {
    test(`${label}: cleanSpec and a recorded spec re-normalize to the same specHash`, () => {
      const spec = normalizeSpec(world);
      const clean = cleanSpec(spec);
      const again = normalizeSpec(clone(clean));
      assert.equal(specHash(again), specHash(spec));
      assert.deepEqual(cleanSpec(again), clean);
      // The recorder writes the full normalized spec (run/recorder.js); replays normalize it again.
      assert.equal(specHash(normalizeSpec(clone(spec))), specHash(spec));
      const checked = validateWorld(clone(clean));
      assert.equal(checked.ok, true, checked.errors.join('\n'));
      assert.deepEqual(checked.warnings, []);
    });
  }

  test('cleanSpec outputs every building field', () => {
    const clean = cleanSpec(normalizeSpec(BUILDING));
    assert.equal(clean.walls.length, 7);
    assert.deepEqual(clean.walls[5], { x1: 50, y1: 20, x2: 50, y2: 45, source: 'drawn' });
    assert.deepEqual(clean.geo, { metersPerUnit: 0.8, clearance: 0.2, floor: 1, source: 'hand-drawn test plan' });
    assert.deepEqual(clean.doors.map(d => d.id), ['front', 'inner']);
    assert.deepEqual(clean.provenance, BUILDING.provenance);
    assert.deepEqual(clean.archetypes[0].entries, ['street']);
    assert.deepEqual(cleanSpec(normalizeSpec(ROUTE)).edges[1].via, [{ x: 50, y: 50 }]);
    assert.equal('via' in cleanSpec(normalizeSpec(ROUTE)).edges[0], false);
  });

  test('with walls, node positions stay exact (rounding could move a node onto a wall)', () => {
    assert.equal(cleanSpec(normalizeSpec(BUILDING)).nodes[1].x, 30.04);
    assert.equal(cleanSpec(normalizeSpec(withChanges(BUILDING, { walls: undefined }))).nodes[1].x, 30);
  });

  test('each building field changes the hash', () => {
    const base = specHash(normalizeSpec(BUILDING));
    const variants = [
      { walls: WALLS.slice(0, 6).concat([[50, 56, 50, 80]]) },
      { geo: { ...BUILDING.geo, clearance: 0.25 } },
      { doors: BUILDING.doors.slice(0, 1) },
      { provenance: { walls: 'data' } },
      { archetypes: [{ ...BUILDING.archetypes[0], entries: [] }] },
      { archetypes: [{ ...BUILDING.archetypes[0], exits: ['street'] }] }
    ];
    for (const v of variants) assert.notEqual(specHash(normalizeSpec(withChanges(BUILDING, v))), base, JSON.stringify(v));
  });
});

// ---------- validation rules (§13a) ----------

describe('validateWorld wall rules', () => {
  test('a correct building has no errors and no warnings', () => {
    for (const w of [BUILDING, ROUTE]) {
      const { ok, errors, warnings } = validateWorld(w);
      assert.equal(ok, true, errors.join('\n'));
      assert.deepEqual(warnings, []);
    }
  });

  test('every node is at least 0.05 from every wall', () => {
    const raw = clone(BUILDING);
    raw.nodes.push({ id: 'booth', name: 'Booth', kind: 'service', x: 50.03, y: 30, tags: ['food'] });
    const { ok, errors } = validateWorld(raw);
    assert.equal(ok, false);
    assert.deepEqual(errors, ['nodes[3]: "Booth" at (50.03, 30) is 0.03 units from walls[5]; every node must be at least 0.05 from every wall']);
    assert.throws(() => normalizeSpec(raw), /"Booth" .* at least 0\.05 from every wall/);
    raw.nodes[3].x = 50.05; // exactly 0.05 away is allowed
    assert.equal(validateWorld(raw).ok, true);
  });

  test('route mode: an edge that touches a wall names the edge and the wall', () => {
    const raw = clone(ROUTE);
    delete raw.edges[1].via; // lobby (30, 30) → suite (70, 30) runs straight into the divider
    const { ok, errors } = validateWorld(raw);
    assert.equal(ok, false);
    assert.deepEqual(errors, ['edges[1]: edge "Inner doorway" (lobby > suite) touches walls[5]; add via points that pass through a gap in the walls']);
    assert.throws(() => normalizeSpec(raw), /edge "Inner doorway" \(lobby > suite\) touches walls\[5\]/);
    raw.edges[1].via = [{ x: 50, y: 50 }, { x: 60, y: 20 }]; // second leg ends on the top wall
    assert.match(validateWorld(raw).errors[0], /^edges\[1\]: .*touches walls\[0\] on piece 2 of 3;/);
  });

  test('visit mode: every service is reachable on foot from an entry', () => {
    const { ok, errors } = validateWorld(withChanges(BUILDING, { walls: SEALED, doors: BUILDING.doors.slice(0, 1) }));
    assert.equal(ok, false);
    assert.ok(errors.includes('nodes[2]: "Clinic" cannot be reached on foot from any gate or entry; leave a doorway in the walls between them'), errors.join('\n'));
    assert.equal(hasMessage(errors, /"Cafe"/), false);
    assert.throws(() => normalizeSpec(withChanges(BUILDING, { walls: SEALED })), /"Clinic" cannot be reached on foot/);
  });

  test('visit mode: every service can reach at least one exit', () => {
    // People come in at the street entry; the only exit is inside a sealed closet in the back room.
    const closet = [[75, 25, 85, 25], [85, 25, 85, 35], [85, 35, 75, 35], [75, 35, 75, 25]];
    const raw = withChanges(BUILDING, { walls: [...WALLS, ...closet] });
    raw.nodes[0].kind = 'entry';
    raw.nodes.push({ id: 'back', name: 'Back exit', kind: 'exit', x: 80, y: 30 });
    const { ok, errors } = validateWorld(raw);
    assert.equal(ok, false);
    assert.deepEqual(errors, [
      'nodes[1]: "Cafe" has no walking path to any gate or exit; leave a doorway in the walls between them',
      'nodes[2]: "Clinic" has no walking path to any gate or exit; leave a doorway in the walls between them'
    ]);
    raw.walls.pop(); // open the closet's left side
    assert.equal(validateWorld(raw).ok, true);
  });

  test('without walls, none of the wall rules run', () => {
    const raw = withChanges(BUILDING, { walls: undefined });
    raw.nodes.push({ id: 'booth', name: 'Booth', kind: 'service', x: 50.03, y: 30, tags: ['food'] });
    assert.equal(validateWorld(raw).ok, true);
  });
});

// ---------- documentation ----------

test('the building example in worlds/SCHEMA.md validates without errors or warnings', () => {
  const md = readFileSync(new URL('../worlds/SCHEMA.md', import.meta.url), 'utf8');
  const section = md.slice(md.indexOf('## 14. Buildings'));
  const json = section.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(json, 'no json example in section 14');
  const world = JSON.parse(json[1]);
  const { ok, errors, warnings, spec } = validateWorld(world);
  assert.equal(ok, true, errors.join('\n'));
  assert.deepEqual(warnings, []);
  assert.equal(spec.walls.length, 7);
  assert.equal(spec.doors.length, 2);
  assert.deepEqual(spec.archetypes[0].entries, ['street']);
});

test('worlds/schema.json describes every building field and its $refs resolve', () => {
  const schema = JSON.parse(readFileSync(new URL('../worlds/schema.json', import.meta.url), 'utf8'));
  for (const k of ['walls', 'geo', 'doors', 'provenance']) assert.ok(schema.properties[k], k);
  assert.ok(schema.$defs.edge.properties.via);
  assert.ok(schema.$defs.archetype.properties.entries);
  assert.equal(schema.$defs.archetype.properties.exits.type, 'array');
  assert.deepEqual(
    [schema.properties.travelSpeed.minimum, schema.properties.travelSpeed.maximum, schema.properties.travelSpeed.default], [0.2, 600, 4]);
  assert.equal(schema.properties.walls.maxItems, 4000);
  assert.equal(schema.properties.doors.maxItems, 500);
  assert.equal(schema.$defs.edge.properties.via.maxItems, 12);
  assert.equal(schema.properties.provenance.maxProperties, 300);
  const refs = JSON.stringify(schema).match(/"\$ref":"#\/\$defs\/[a-z]+"/gi) ?? [];
  for (const r of refs) assert.ok(schema.$defs[r.split('/').pop().replace('"', '')], r);
});

test('worlds/SCHEMA.md documents the travelSpeed range and archetypes[].exits', () => {
  const md = readFileSync(new URL('../worlds/SCHEMA.md', import.meta.url), 'utf8');
  assert.match(md, /\| `travelSpeed` \| map units per minute, 0\.2–600 \| 4 \|/);
  assert.match(md, /\| `exits` \| visit \| gate or exit node ids/);
  assert.doesNotMatch(md, /at most 60\b/);
});

// ---------- patches ----------

describe('PATCH_FIELDS.node weight', () => {
  test('is patchable on gates and entries, and skipped elsewhere', () => {
    assert.ok(PATCH_FIELDS.node.includes('weight'));
    const spec = normalizeSpec(BUILDING);
    const { spec: patched, applied, skipped } = applyPatch(spec, [
      { kind: 'node', id: 'street', field: 'weight', value: 3 },
      { kind: 'node', id: 'cafe', field: 'weight', value: 3 }
    ]);
    assert.deepEqual(applied, ['Street door · weight 1 → 3']);
    assert.deepEqual(skipped, [{ kind: 'node', id: 'cafe', field: 'weight', value: 3 }]);
    assert.equal(patched.nodes.find(n => n.id === 'street').weight, 3);
    // The patched world keeps its walls, doors and exact positions.
    assert.equal(patched.walls.length, 7);
    assert.equal(patched.doors.length, 2);
    assert.equal(patched.nodes.find(n => n.id === 'cafe').x, 30.04);
    const route = applyPatch(normalizeSpec(ROUTE), [{ kind: 'node', id: 'street', field: 'weight', value: 2 }]);
    assert.equal(route.applied.length, 0);
    assert.equal(route.skipped.length, 1);
  });
});
