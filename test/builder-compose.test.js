// Composer tests (docs/PROTOTYPE.md §14c): room assignment and the composed building world. The floor plan
// is hand-made in the §13e map-unit shape: a corridor, six rooms with doors, a stairs room, one exterior
// door, and walls with gaps. The CoStar profile is the fictional fixture in test/fixtures/costar/.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { assignTenantsToRooms, composeBuildingWorld, LIMITS } from '../builder/compose.js';
import { validateProfile } from '../builder/profile.js';
import { validateWorld } from '../engine/spec.js';
import { crossesWall } from '../engine/walls.js';
import { Sim } from '../engine/sim.js';

const read = rel => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const PROFILE = read('./fixtures/costar/sample-profile.json');
const RAW_COSTAR = read('./fixtures/costar/sample-raw.json');
const KESSLER = 'Kessler & Moss Law (fictional)', BRIGHT = 'Brightline Software (fictional)', DENTAL = 'Northgate Dental (fictional)';
const COFFEE = 'Bluebird Coffee (fictional)', GIFTS = 'Fernway Gifts (fictional)';

// ---------- the plan fixture ----------
//   y=20 ┌──── r1 ────┬──── r2 ────┬────── r3 ──────┐
//        │            │            │                │
//   y=45 ├──d──────────────d────────────────d───────┤
//   entry  corridor (y 45-55)                       │
//   y=55 ├──d───────┬───d────┬────d──────┬───d──────┤
//        │   r4     │   r5   │    r6     │  stairs  │
//   y=80 └──────────┴────────┴───────────┴──────────┘
//        x=10      30       50          74         90
function makePlan({ exterior = true, stairsLabel = 'Stairs' } = {}) {
  const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  const room = (id, label, classification, x0, y0, x1, y1) => ({
    id, label, classification, polygon: rect(x0, y0, x1, y1), centroid: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, area: (x1 - x0) * (y1 - y0)
  });
  const rooms = [
    room('corr', 'Corridor', 'Hallway', 10, 45, 90, 55),
    room('r1', '', 'Office', 10, 20, 34, 45), room('r2', '', 'Office', 34, 20, 58, 45), room('r3', '', 'Office', 58, 20, 90, 45),
    room('r4', '', 'Office', 10, 55, 30, 80), room('r5', '', 'Office', 30, 55, 50, 80), room('r6', '', 'Office', 50, 55, 74, 80),
    room('st', stairsLabel, stairsLabel === 'Stairs' ? 'Stairs' : 'Other', 74, 55, 90, 80)
  ];
  const walls = [], doors = [];
  // A wall edge, cut into two pieces around a door when it has one (§13e: the gap is the doorway).
  const edge = (id, x1, y1, x2, y2, roomIds, door) => {
    if (!door) { walls.push({ x1, y1, x2, y2, edgeId: id, roomIds }); return; }
    const len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len;
    const t = (door.x - x1) * ux + (door.y - y1) * uy, h = door.width / 2;
    walls.push({ x1, y1, x2: x1 + ux * (t - h), y2: y1 + uy * (t - h), edgeId: id, roomIds });
    walls.push({ x1: x1 + ux * (t + h), y1: y1 + uy * (t + h), x2, y2, edgeId: id, roomIds });
    doors.push({ x: door.x, y: door.y, width: door.width, type: 'doorway', edgeId: id, roomIds: roomIds.length === 2 ? roomIds : [roomIds[0], null] });
  };
  edge('e_r1', 10, 45, 34, 45, ['corr', 'r1'], { x: 22, y: 45, width: 3 });
  edge('e_r2', 34, 45, 58, 45, ['corr', 'r2'], { x: 46, y: 45, width: 3 });
  edge('e_r3', 58, 45, 90, 45, ['corr', 'r3'], { x: 74, y: 45, width: 3 });
  edge('e_r4', 10, 55, 30, 55, ['corr', 'r4'], { x: 20, y: 55, width: 3 });
  edge('e_r5', 30, 55, 50, 55, ['corr', 'r5'], { x: 40, y: 55, width: 3 });
  edge('e_r6', 50, 55, 74, 55, ['corr', 'r6'], { x: 62, y: 55, width: 3 });
  edge('e_st', 74, 55, 90, 55, ['corr', 'st'], { x: 82, y: 55, width: 3 });
  edge('e_cw', 10, 45, 10, 55, ['corr'], exterior ? { x: 10, y: 50, width: 4 } : null);
  edge('e_ce', 90, 45, 90, 55, ['corr']);
  edge('e_n', 10, 20, 90, 20, ['r1']); edge('e_s', 10, 80, 90, 80, ['r4']);
  edge('e_w1', 10, 20, 10, 45, ['r1']); edge('e_w2', 10, 55, 10, 80, ['r4']);
  edge('e_e1', 90, 20, 90, 45, ['r3']); edge('e_e2', 90, 55, 90, 80, ['st']);
  edge('p12', 34, 20, 34, 45, ['r1', 'r2']); edge('p23', 58, 20, 58, 45, ['r2', 'r3']);
  edge('p45', 30, 55, 30, 80, ['r4', 'r5']); edge('p56', 50, 55, 50, 80, ['r5', 'r6']); edge('p6s', 74, 55, 74, 80, ['r6', 'st']);
  return { units: 'map', floor: { id: 'f1', sequence: 0, label: 'Ground floor' }, rooms, walls, doors, metersPerUnit: 0.66, warnings: [] };
}

const PLAN = makePlan();
const roomOf = id => PLAN.rooms.find(r => r.id === id);
const inRect = (room, p) => {
  const xs = room.polygon.map(q => q.x), ys = room.polygon.map(q => q.y);
  return p.x > Math.min(...xs) && p.x < Math.max(...xs) && p.y > Math.min(...ys) && p.y < Math.max(...ys);
};
const segDist = (px, py, w) => {
  const dx = w.x2 - w.x1, dy = w.y2 - w.y1, l2 = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((px - w.x1) * dx + (py - w.y1) * dy) / l2));
  return Math.hypot(w.x1 + t * dx - px, w.y1 + t * dy - py);
};
const wallGap = (world, p) => Math.min(...world.walls.map(w => segDist(p.x, p.y, w)));

describe('assignTenantsToRooms', () => {
  const profile = validateProfile(PROFILE).profile;

  test('stairs are vertical, the corridor is common, and floor-1 tenants match rooms by area', () => {
    const { assignments, warnings, offFloor, floor } = assignTenantsToRooms(PLAN, profile);
    const at = Object.fromEntries(assignments.map(a => [a.roomId, a]));
    assert.equal(floor.number, 1);
    assert.deepEqual([at.st.use, at.st.how], ['vertical', 'vertical']);
    assert.deepEqual([at.corr.use, at.corr.how, at.corr.tenantName], ['common', 'common', null]);
    // Largest tenant to largest room: r3 (800) > r1 = r2 = r6 (600, plan order) > r4 = r5 (500).
    assert.equal(at.r3.tenantName, KESSLER);
    assert.equal(at.r1.tenantName, BRIGHT);
    assert.equal(at.r2.tenantName, DENTAL);
    assert.equal(at.r6.tenantName, COFFEE);
    assert.equal(at.r4.tenantName, GIFTS);
    assert.deepEqual([at.r5.tenantName, at.r5.how], [null, 'common']);
    for (const id of ['r1', 'r2', 'r3', 'r4', 'r6']) assert.equal(at[id].how, 'area-match');
    assert.equal(at.r6.use, 'restaurant');
    assert.deepEqual(offFloor.map(o => o.tenantName).sort(), ['Halvorsen Insurance (fictional)', 'Juniper Yoga (fictional)', 'Ledgerline Accounting (fictional)']);
    for (const o of offFloor) assert.deepEqual(o.via, ['st']);
    assert.deepEqual(warnings, []);
  });

  test('overrides come first', () => {
    const { assignments, warnings } = assignTenantsToRooms(PLAN, profile, {
      overrides: { rooms: { r5: 'Bluebird Coffee', r6: 'common', nope: KESSLER, r2: 'Nobody Inc' }, verticalRooms: ['r4'] }
    });
    const at = Object.fromEntries(assignments.map(a => [a.roomId, a]));
    assert.deepEqual([at.r5.tenantName, at.r5.how], [COFFEE, 'override']);
    assert.deepEqual([at.r6.use, at.r6.how], ['common', 'override']);
    assert.deepEqual([at.r4.use, at.r4.how], ['vertical', 'override']);
    // The remaining four floor-1 tenants fill the remaining rooms by area: r3, r1, r2, then none left.
    assert.equal(at.r3.tenantName, KESSLER);
    assert.equal(at.r1.tenantName, BRIGHT);
    assert.equal(at.r2.tenantName, DENTAL);
    assert.ok(warnings.some(w => w.startsWith('overrides.rooms.nope:')));
    assert.ok(warnings.some(w => w.startsWith('overrides.rooms.r2:')));
    assert.ok(warnings.some(w => w.startsWith(`"${GIFTS}"`) && w.includes('got no room')));
  });

  test('warns about a floor with no stairs or elevator, and about tenants without a room', () => {
    const plan = makePlan({ stairsLabel: 'Back room' });
    const { warnings, offFloor } = assignTenantsToRooms(plan, profile);
    assert.ok(warnings.some(w => w.includes('has no stairs or elevator room') && w.includes('Halvorsen Insurance')));
    for (const o of offFloor) assert.deepEqual(o.via, []);
    const crowded = { ...profile, tenants: [...profile.tenants, ...[1, 2, 3].map(i => ({ ...profile.tenants[4], name: `Kiosk ${i} (fictional)`, sf: 100 }))] };
    // "Back room" is not stairs, so it is matched too: 7 rooms for 8 floor-1 tenants leaves the smallest out.
    const r = assignTenantsToRooms(plan, crowded);
    assert.ok(r.assignments.find(a => a.roomId === 'st').tenantName);
    assert.equal(r.unplaced.length, 1);
    assert.equal(r.warnings.filter(w => w.includes('got no room')).length, 1);
  });
});

describe('composeBuildingWorld: weekday-lunch', () => {
  const { world, report } = composeBuildingWorld({ plan: PLAN, profile: PROFILE, scenario: 'weekday-lunch' });
  const node = id => world.nodes.find(n => n.id === id);
  const services = world.nodes.filter(n => n.kind === 'service');

  test('passes validateWorld, including the wall rules', () => {
    const v = validateWorld(world);
    assert.equal(v.ok, true, v.errors.join('\n'));
    assert.deepEqual(v.warnings, []);
    assert.equal(report.validation.ok, true);
    assert.equal(world.mode, 'visit');
    assert.deepEqual([world.clockStart, world.duration], [690, 120]);
  });

  test('the exterior door is a gate in its doorway gap, clear of every wall', () => {
    const door = world.doors.find(d => d.exterior);
    assert.equal(door.name, 'Main entrance');
    const gate = world.nodes.find(n => n.kind === 'gate' && n.name === 'Main entrance');
    assert.ok(gate);
    assert.ok(Math.abs(gate.x - 10) < 1e-9 && gate.y > 48 && gate.y < 52, `gate at (${gate.x}, ${gate.y})`);
    for (const n of world.nodes) assert.ok(wallGap(world, n) >= 0.05, `${n.id} is ${wallGap(world, n)} from a wall`);
  });

  test('a place per open tenant on this floor, inside its room', () => {
    const want = { [KESSLER]: 'r3', [BRIGHT]: 'r1', [DENTAL]: 'r2', [COFFEE]: 'r6', [GIFTS]: 'r4' };
    for (const [name, roomId] of Object.entries(want)) {
      const s = services.find(n => n.name === name);
      assert.ok(s, `place for ${name}`);
      assert.ok(inRect(roomOf(roomId), s), `${name} inside ${roomId}`);
      assert.ok(s.tags.includes(name.toLowerCase()));
    }
    assert.ok(services.find(n => n.name === COFFEE).tags.includes('public'));
    assert.ok(!services.find(n => n.name === KESSLER).tags.includes('public'));
    const stairs = services.find(n => n.name === 'Stairs to other floors');
    assert.ok(stairs && inRect(roomOf('st'), stairs));
    assert.equal(services.length, 6);
  });

  test('each group starts at the right gates and can only go where it makes sense', () => {
    const exterior = world.nodes.filter(n => n.kind === 'gate' && n.name === 'Main entrance').map(n => n.id);
    const arch = id => world.archetypes.find(a => a.id === id);
    const kessler = world.archetypes.find(a => a.name.startsWith('Kessler'));
    assert.equal(kessler.entries.length, 1);
    const desks = node(kessler.entries[0]);
    assert.equal(desks.kind, 'gate');
    assert.ok(inRect(roomOf('r3'), desks), 'Kessler staff start inside their own suite');
    assert.deepEqual(arch('staff_other_floors').entries.map(id => node(id).name), ['Stairs landing']);
    for (const id of ['lunch_customers', 'appointments', 'office_visitors']) assert.deepEqual(arch(id).entries, exterior);
    const reach = a => services.filter(s => s.tags.some(t => a.needs.includes(t))).map(s => s.name);
    assert.ok(!reach(kessler).includes(KESSLER), 'staff go out, not to an office');
    assert.ok(!reach(kessler).includes(DENTAL), 'nobody picks the dentist for lunch');
    assert.ok(reach(kessler).includes(COFFEE));
    assert.deepEqual(reach(arch('office_visitors')).sort(), [BRIGHT, KESSLER, 'Stairs to other floors'].sort());
    assert.deepEqual(reach(arch('appointments')).sort(), [DENTAL, 'Stairs to other floors'].sort());
    assert.equal(world.archetypes.length, 6);
    assert.equal(world.arrivals.total, world.archetypes.reduce((s, a) => s + a.share, 0));
  });

  test('door segments lie in the wall gaps without touching any wall', () => {
    assert.equal(world.doors.length, 8);
    for (const d of world.doors) {
      assert.equal(crossesWall(world.walls, d.x1, d.y1, d.x2, d.y2), -1, `${d.name} touches a wall`);
      const plan = PLAN.doors.find(p => Math.abs((d.x1 + d.x2) / 2 - p.x) < 1e-6 && Math.abs((d.y1 + d.y2) / 2 - p.y) < 1e-6);
      assert.ok(plan, `${d.name} is centered on a plan doorway`);
      const len = Math.hypot(d.x2 - d.x1, d.y2 - d.y1);
      assert.ok(len < plan.width && len > plan.width * 0.8, `${d.name} spans the gap (${len} of ${plan.width})`);
      // Each end sits just inside a wall end (the jamb).
      for (const p of [{ x: d.x1, y: d.y1 }, { x: d.x2, y: d.y2 }]) assert.ok(wallGap(world, p) < 0.5, `${d.name} end near a jamb`);
    }
    const names = world.doors.map(d => d.name);
    assert.ok(names.includes(`Corridor / ${DENTAL}`));
    assert.ok(names.includes('Corridor / Stairs'));
    assert.ok(names.includes('Corridor / Office'), 'an unassigned room is named by its classification');
  });

  test('walls, geo, provenance and a placeholder cast', () => {
    assert.equal(world.walls.length, PLAN.walls.length);
    assert.ok(world.walls.every(w => w.source === 'matterport-vector'));
    assert.equal(world.geo.metersPerUnit, 0.66);
    assert.equal(world.geo.floor, 1);
    assert.ok(world.geo.clearance > 0 && world.geo.clearance <= 3 / 4);
    const pv = world.provenance;
    assert.equal(pv.walls, 'data');
    assert.equal(pv.doors, 'data');
    world.nodes.forEach((n, i) => {
      if (n.kind === 'service') for (const f of ['servers', 'serviceTime', 'appeal', 'price']) assert.ok(pv[`nodes[${i}].${f}`], `nodes[${i}].${f}`);
      if (n.kind === 'gate') assert.equal(pv[`nodes[${i}].weight`], 'assumed');
      assert.equal(pv[`nodes[${i}].x`], 'data');
    });
    world.archetypes.forEach((a, i) => { for (const f of ['share', 'visits', 'patience', 'info']) assert.equal(pv[`archetypes[${i}].${f}`], 'assumed'); });
    assert.ok(Object.keys(pv).length <= 300);
    assert.equal(world.minds.length, world.archetypes.length);
    for (const m of world.minds) assert.ok(world.archetypes.some(a => a.id === m.archetype) && /Placeholder/.test(m.bio));
    assert.match(world.context, /weekday lunch hour, 11:30 am to 1:30 pm, at Sample Plaza \(made-up test data\), a 45,200 SF office\/retail building in Testville, NJ/);
    assert.match(world.question, /ground floor of Sample Plaza/);
    assert.ok(world.title.length <= 80 && world.context.length <= 300);
  });

  test('the report lists rooms, tenants, assignments, doors, warnings and assumptions', () => {
    assert.equal(report.floor.label, 'Ground floor');
    assert.equal(report.rooms.length, 8);
    assert.equal(report.assignments.length, 8);
    assert.equal(report.doors.length, 8);
    assert.ok(Array.isArray(report.warnings));
    // 1.2 m/s at 0.66 m per unit is about 109 units per minute: within the §14d maximum of 600, so no clamp.
    assert.equal(world.travelSpeed, Math.round(1.2 * 60 / 0.66 * 100) / 100);
    assert.ok(!report.warnings.some(w => w.includes('above the world maximum')), 'no walking speed clamp');
    const status = Object.fromEntries(report.tenants.map(t => [t.name, t.status]));
    assert.equal(status[COFFEE], 'placed');
    assert.equal(status['Juniper Yoga (fictional)'], 'other floor, reached by stairs or elevator');
    const keys = report.assumptionsUsed.map(a => a.key);
    for (const k of ['officeAttendance', 'lunchOutShare', 'walkingSpeedMps', 'vertical.stairs.servers', 'entranceWeightBy']) assert.ok(keys.includes(k), k);
    assert.deepEqual(report.limits, LIMITS);
    assert.ok(report.notes.some(n => n.includes('nearest exit')));
  });

  test('a rules run of the composed world respects the walls and counts the doorways', () => {
    const sim = new Sim(world, { seed: 7 });
    sim.runToEnd();
    const m = sim.metrics();
    assert.equal(m.walls.violations, 0);
    assert.ok(m.walls.checkedMoves > 0);
    const main = m.doors.find(d => d.name === 'Main entrance');
    assert.ok(main.crossings > 0, 'people come in through the main entrance');
    assert.ok(m.served > 0);
  });

  test('composing twice gives the same world', () => {
    const again = composeBuildingWorld({ plan: makePlan(), profile: PROFILE, scenario: 'weekday-lunch' });
    assert.equal(JSON.stringify(again.world), JSON.stringify(world));
  });
});

describe('composeBuildingWorld: other scenarios and edge cases', () => {
  test('weekday-morning: staff come in from outside and stay at their desks', () => {
    const { world, report } = composeBuildingWorld({ plan: PLAN, profile: PROFILE, scenario: 'weekday-morning' });
    assert.equal(validateWorld(world).ok, true);
    const kessler = world.nodes.find(n => n.name === KESSLER);
    assert.deepEqual([kessler.serviceTime, kessler.serviceDist, kessler.servers], [150, 'fixed', 38]);
    assert.ok(!world.nodes.some(n => n.name.endsWith(' desks')), 'no gates inside suites in the morning');
    const staff = world.archetypes.find(a => a.name.startsWith('Kessler'));
    assert.deepEqual(staff.needs, [KESSLER.toLowerCase(), 'restaurant']);
    assert.equal(report.tenants.find(t => t.name === GIFTS).status, 'closed on a weekday morning');
    assert.ok(report.notes.some(n => n.includes('stay at their desks')));
  });

  test('saturday-afternoon: offices are not places and only outside groups come', () => {
    const { world, report } = composeBuildingWorld({ plan: PLAN, profile: PROFILE, scenario: 'saturday-afternoon' });
    assert.equal(validateWorld(world).ok, true);
    assert.ok(!world.nodes.some(n => n.name === KESSLER || n.name === BRIGHT));
    const exterior = world.nodes.filter(n => n.kind === 'gate' && n.name === 'Main entrance').map(n => n.id);
    for (const a of world.archetypes) assert.deepEqual(a.entries, exterior);
    assert.equal(report.tenants.find(t => t.name === KESSLER).status, 'closed on a Saturday afternoon');
  });

  test('no exterior door: the best-connected room\'s door is the entrance, with a warning', () => {
    const { world, report } = composeBuildingWorld({ plan: makePlan({ exterior: false }), profile: PROFILE });
    const v = validateWorld(world);
    assert.equal(v.ok, true, v.errors.join('\n'));
    const gate = world.nodes.find(n => n.name === 'Main entrance (assumed)');
    assert.ok(gate);
    assert.ok(report.warnings.some(w => w.startsWith('the plan has no exterior door') && w.includes('"Corridor"')));
    assert.ok(!world.doors.some(d => d.exterior));
  });

  test('a raw CoStar record works as the profile', () => {
    const { world, report } = composeBuildingWorld({ plan: PLAN, profile: RAW_COSTAR, scenario: 'weekday-lunch' });
    assert.equal(validateWorld(world).ok, true);
    assert.ok(report.warnings.some(w => w.startsWith('the profile was read as a raw CoStar record')));
    assert.ok(world.nodes.some(n => n.name === COFFEE));
  });

  test('overrides reach the world', () => {
    const { world } = composeBuildingWorld({ plan: PLAN, profile: PROFILE, overrides: { rooms: { r5: COFFEE } } });
    assert.ok(inRect(roomOf('r5'), world.nodes.find(n => n.name === COFFEE)));
  });

  test('walking speed: the map-unit speed is kept up to 600 per minute, and clamped above it with a warning', () => {
    // A tiny plan scale (0.1 m per unit): 1.2 m/s is 720 units per minute, above the maximum of 600.
    const { world, report } = composeBuildingWorld({ plan: { ...makePlan(), metersPerUnit: 0.1 }, profile: PROFILE, scenario: 'weekday-lunch' });
    assert.equal(world.travelSpeed, 600);
    assert.ok(report.warnings.some(w => w.includes('720 map units per minute, above the world maximum of 600') && w.includes('1.2x slow')), report.warnings.join('\n'));
    assert.equal(validateWorld(world).spec.travelSpeed, 600);
    // At 0.2 m per unit it is 360: kept as is, no warning.
    const mid = composeBuildingWorld({ plan: { ...makePlan(), metersPerUnit: 0.2 }, profile: PROFILE, scenario: 'weekday-lunch' });
    assert.equal(mid.world.travelSpeed, 360);
    assert.ok(!mid.report.warnings.some(w => w.includes('above the world maximum')));
  });

  test('bad input fails with a clear message', () => {
    assert.throws(() => composeBuildingWorld({ plan: PLAN, profile: PROFILE, scenario: 'brunch' }), /unknown scenario "brunch"/);
    assert.throws(() => composeBuildingWorld({ plan: { ...PLAN, units: 'm' }, profile: PROFILE }), /toMapUnits/);
    assert.throws(() => composeBuildingWorld({ profile: PROFILE }), /map-unit plan/);
    const closed = { source: 'manual', name: 'Closed (fictional)', tenants: [{ name: 'Night Law (fictional)', use: 'office', sf: 1000, floor: 1 }] };
    assert.throws(() => composeBuildingWorld({ plan: PLAN, profile: closed, scenario: 'saturday-afternoon' }), /nothing to simulate/);
  });
});

// The real chain on the hand-made Matterport fixture, when the walls team's builder is present.
const HAS_MATTERPORT = existsSync(new URL('../builder/matterport.js', import.meta.url)) &&
  existsSync(new URL('./fixtures/matterport/sample-model.json', import.meta.url));

describe('real chain: extractFloorplan → toMapUnits → composeBuildingWorld', { skip: !HAS_MATTERPORT && 'builder/matterport.js not available yet' }, () => {
  test('the sample Matterport model composes into a valid world for every scenario', async () => {
    const { extractFloorplan, toMapUnits } = await import('../builder/matterport.js');
    const plan = toMapUnits(extractFloorplan(read('./fixtures/matterport/sample-model.json')));
    for (const scenario of ['weekday-morning', 'weekday-lunch', 'saturday-afternoon']) {
      const { world, report } = composeBuildingWorld({ plan, profile: PROFILE, scenario });
      const v = validateWorld(world);
      assert.equal(v.ok, true, `${scenario}: ${v.errors.join('\n')}`);
      const gate = world.nodes.find(n => n.kind === 'gate' && n.name === 'Main entrance');
      assert.ok(gate, `${scenario}: a gate at the exterior door`);
      for (const d of world.doors) assert.equal(crossesWall(world.walls, d.x1, d.y1, d.x2, d.y2), -1, `${scenario}: ${d.name}`);
      assert.ok(report.warnings.some(w => w.includes('no stairs or elevator room')), 'the fixture floor has no stairs');
      const sim = new Sim(world, { seed: 7 });
      sim.runToEnd();
      assert.equal(sim.metrics().walls.violations, 0);
    }
  });
});
