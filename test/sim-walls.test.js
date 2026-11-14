// Engine walls and doors (docs/PROTOTYPE.md §13c, §14d): wall-free walking, door traffic, unreachable
// places, route polylines, WallViolation, archetypes[].entries and .exits, and unchanged behavior for
// worlds without walls.
// Every world here is small, hand-written and fictional, and goes through normalizeSpec (via new Sim).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Sim, WallViolation } from '../engine/sim.js';
import { createNav, polylineLength } from '../engine/walls.js';
import { selectHeard } from '../engine/observe.js';

// ---------- fixtures ----------

// Two rooms side by side, joined by one door low in the middle wall. The gate sits in a gap of the
// left outer wall (the front door); the help desk is in the right room.
const OUTER_TWO = [[10, 10, 90, 10], [90, 10, 90, 50], [90, 50, 10, 50], [10, 10, 10, 28], [10, 32, 10, 50]];
const TWO_ROOMS = {
  title: 'Two-room test office (fictional)', question: 'Does the middle door carry everyone?',
  context: 'A made-up two-room office used by the engine tests.', mode: 'visit',
  duration: 240, clockStart: 600, travelSpeed: 8,
  arrivals: { total: 30, start: 0, end: 60, shape: 'uniform' },
  nodes: [
    { id: 'front', name: 'Front door', kind: 'gate', x: 10, y: 30 },
    { id: 'desk', name: 'Help desk', kind: 'service', x: 80, y: 40, servers: 2, serviceTime: 3, tags: ['help'] }
  ],
  archetypes: [{ id: 'visitor', name: 'Visitors', share: 1, visits: 1, patience: 240, info: 1 }],
  walls: [...OUTER_TWO, [50, 10, 50, 14], [50, 18, 50, 50]],
  doors: [
    { id: 'front_door', name: 'Front door', x1: 10, y1: 28, x2: 10, y2: 32, exterior: true },
    { id: 'mid', name: 'Middle door', x1: 50, y1: 14, x2: 50, y2: 18, exterior: false }
  ],
  geo: { clearance: 0.2 }
};

// Three rooms off a corridor, five doors, three places: for the frame-by-frame no-teleport check.
const OFFICE = {
  title: 'Corridor test office (fictional)', question: 'Which doorway is busiest?',
  context: 'A made-up office floor with a corridor, used by the engine tests.', mode: 'visit',
  duration: 150, clockStart: 690, travelSpeed: 6,
  arrivals: { total: 40, start: 0, end: 50, shape: 'uniform' },
  nodes: [
    { id: 'front', name: 'Front door', kind: 'gate', x: 10, y: 43 },
    { id: 'mail', name: 'Mail room', kind: 'service', x: 30, y: 25, servers: 1, serviceTime: 2 },
    { id: 'cafe', name: 'Cafe', kind: 'service', x: 70, y: 25, servers: 2, serviceTime: 5 },
    { id: 'gym', name: 'Gym', kind: 'service', x: 50, y: 60, servers: 3, serviceTime: 6 },
    // 2 units from the outer wall, with a line: queued dots must stay inside the building.
    { id: 'printer', name: 'Printer', kind: 'service', x: 88, y: 20, servers: 1, serviceTime: 2.5, appeal: 1 }
  ],
  archetypes: [{ id: 'staff', name: 'Staff', share: 1, visits: 3, patience: 30, info: 0.5 }],
  walls: [
    [10, 10, 90, 10], [90, 10, 90, 70], [90, 70, 10, 70], [10, 10, 10, 41], [10, 45, 10, 70],
    [10, 40, 20, 40], [23, 40, 60, 40], [63, 40, 90, 40],          // corridor's south wall, doors at x 20-23 and 60-63
    [10, 46, 40, 46], [43, 46, 75, 46], [78, 46, 90, 46],          // corridor's north wall, doors at x 40-43 and 75-78
    [50, 10, 50, 40]                                                // between the two south rooms
  ],
  doors: [
    { id: 'front_door', name: 'Front door', x1: 10, y1: 41, x2: 10, y2: 45, exterior: true },
    { id: 'sw', name: 'Mail room door', x1: 20, y1: 40, x2: 23, y2: 40 },
    { id: 'se', name: 'Cafe door', x1: 60, y1: 40, x2: 63, y2: 40 },
    { id: 'n1', name: 'Gym west door', x1: 40, y1: 46, x2: 43, y2: 46 },
    { id: 'n2', name: 'Gym east door', x1: 75, y1: 46, x2: 78, y2: 46 }
  ]
};

// Two closed buildings. Everyone enters the main one (archetypes[].entries); the vault is only
// reachable from the annex gate, which no group uses, so nobody can ever get there.
const WALLED_OFF = {
  title: 'Walled-off vault (fictional)', question: 'Is the vault ever offered?',
  context: 'A made-up shop with a sealed annex, used by the engine tests.', mode: 'visit',
  duration: 180, clockStart: 540, travelSpeed: 6,
  arrivals: { total: 40, start: 0, end: 60, shape: 'uniform' },
  nodes: [
    { id: 'e1', name: 'Shop door', kind: 'gate', x: 20, y: 20 },
    { id: 'e2', name: 'Annex door', kind: 'gate', x: 75, y: 15 },
    { id: 'shop', name: 'Shop counter', kind: 'service', x: 40, y: 40, servers: 1, serviceTime: 4 },
    { id: 'vault', name: 'Vault', kind: 'service', x: 85, y: 25, servers: 1, serviceTime: 2, appeal: 1 }
  ],
  archetypes: [{ id: 'shoppers', name: 'Shoppers', share: 1, visits: 2, patience: 20, info: 1, entries: ['e1'] }],
  walls: [
    [10, 10, 60, 10], [60, 10, 60, 60], [60, 60, 10, 60], [10, 60, 10, 10],
    [70, 10, 90, 10], [90, 10, 90, 30], [90, 30, 70, 30], [70, 30, 70, 10]
  ]
};

// Two places 10 units apart in a straight line but about 45 apart on foot (through a low door).
const NEIGHBORS = {
  title: 'Wall between neighbors (fictional)', question: 'Does distance mean walking distance?',
  context: 'A made-up pair of rooms used by the engine tests.', mode: 'visit',
  duration: 120, travelSpeed: 6,
  arrivals: { total: 20, start: 0, end: 30, shape: 'uniform' },
  nodes: [
    { id: 'gate', name: 'Entrance', kind: 'gate', x: 20, y: 40 },
    { id: 'copy', name: 'Copy room', kind: 'service', x: 45, y: 40, servers: 4, serviceTime: 1, appeal: 1 },
    { id: 'desk', name: 'Front desk', kind: 'service', x: 55, y: 40, servers: 4, serviceTime: 1, appeal: 0 }
  ],
  archetypes: [{ id: 'temps', name: 'Temps', share: 1, visits: 2, patience: 60, info: 0, weights: { appeal: 5, distance: 0 } }],
  walls: [[10, 10, 90, 10], [90, 10, 90, 50], [90, 50, 10, 50], [10, 50, 10, 10], [50, 10, 50, 14], [50, 18, 50, 50]]
};

// A hallway that bends around a wall: the edge's shape is from → via → to.
const HALL = {
  title: 'Bent hallway (fictional)', question: 'Do walkers follow the bend?', mode: 'route',
  duration: 60, arrivals: { total: 20, start: 0, end: 20, shape: 'uniform' },
  nodes: [
    { id: 'o', name: 'West door', kind: 'origin', x: 10, y: 50 },
    { id: 'd', name: 'East door', kind: 'destination', x: 90, y: 50 }
  ],
  edges: [{ from: 'o', to: 'd', name: 'Hall', via: [{ x: 50, y: 80 }], length: 10, capacity: 50 }],
  walls: [[50, 20, 50, 70]],
  archetypes: [{ id: 'walkers', name: 'Walkers', share: 1 }]
};

// Recorded before walls and doors were added to the engine (rules, seed 7): sha256 (first 16 hex) of
// JSON.stringify(metrics) without the new walls/doors keys, and of frames without walls/doors/d.
const BEFORE = {
  'er-network': {
    metrics: 'a4fde64fbdb332ce', frames: '64beecbfe14a675d',
    head: { spawned: 560, served: 470, abandoned: 145, avgWait: 54.4593253968254, abandonRate: 0.22342064714946072 }
  },
  'theme-park': {
    metrics: 'bb6585f3ecb1539d', frames: '7a0e937b8014d557',
    head: { spawned: 2600, served: 15241, abandoned: 185, avgWait: 8.231710517682567, abandonRate: 0.011992739530662518 }
  },
  'rush-hour-roads': {
    metrics: '8a6423d1068a1f1d', frames: '10911414f75c119b',
    head: { spawned: 3600, arrived: 3483, avgTrip: 29.9777916265028, avgDelay: 9.048133285991764 }
  }
};

// Two rooms side by side, each with its own street door (a gate standing in a gap of its outer wall),
// joined by an inner doorway low in the middle wall. Everyone comes in by the west door; the kiosk is in
// the east room, 10 units from the east gate and about 75 on foot from the west gate.
const TWO_GATES = {
  title: 'Two rooms, two street doors (fictional)', question: 'Which street door do people leave by?',
  context: 'A made-up two-room shop used by the engine tests.', mode: 'visit',
  duration: 240, clockStart: 600, travelSpeed: 8,
  arrivals: { total: 80, start: 0, end: 60, shape: 'uniform' },
  nodes: [
    { id: 'west', name: 'West gate', kind: 'gate', x: 10, y: 30 },
    { id: 'east', name: 'East gate', kind: 'gate', x: 90, y: 30 },
    { id: 'kiosk', name: 'Kiosk', kind: 'service', x: 80, y: 30, servers: 6, serviceTime: 2 }
  ],
  archetypes: [
    { id: 'regulars', name: 'Regulars', share: 1, visits: 1, patience: 240, info: 1, entries: ['west'], exits: ['West gate'] },
    { id: 'passers', name: 'Passers-by', share: 1, visits: 1, patience: 240, info: 1, entries: ['west'] }
  ],
  minds: [
    { id: 'rae', name: 'Rae Fictional', archetype: 'regulars', bio: 'Parks on the west side every day.' },
    { id: 'pim', name: 'Pim Fictional', archetype: 'passers', bio: 'Cutting through on the way east.' }
  ],
  walls: [
    [10, 10, 90, 10], [90, 10, 90, 28], [90, 32, 90, 50], [90, 50, 10, 50], [10, 10, 10, 28], [10, 32, 10, 50],
    [50, 10, 50, 14], [50, 18, 50, 50]
  ],
  doors: [
    { id: 'west_door', name: 'West door', x1: 10, y1: 28, x2: 10, y2: 32, exterior: true },
    { id: 'east_door', name: 'East door', x1: 90, y1: 28, x2: 90, y2: 32, exterior: true },
    { id: 'inner', name: 'Inner doorway', x1: 50, y1: 14, x2: 50, y2: 18 }
  ],
  geo: { clearance: 0.2 }
};

// Recorded before archetypes[].exits existed (rules, seed 7): sha256 (first 16 hex) of
// JSON.stringify(sim.metrics()) and of JSON.stringify(sim.frames), whole. Metrics fields added later
// (segments and offers, §15) are left out before hashing.
const BEFORE_EXITS = {
  'er-network': { metrics: 'c0877539ffffd9c3', frames: '6bc3d5f27edc9b3e' },
  'food-hall-lunch': { metrics: '8320f2286bb3225d', frames: 'ca3ab6350c930e73' }
};

// ---------- helpers ----------

const copy = w => JSON.parse(JSON.stringify(w));
const hash16 = s => createHash('sha256').update(s).digest('hex').slice(0, 16);
const loadWorld = name => JSON.parse(readFileSync(new URL(`../worlds/${name}.json`, import.meta.url), 'utf8'));

function runExternal(world, opts = {}) {
  const sim = new Sim(world, { ...opts, external: true });
  const reqs = [];
  const answer = () => {
    for (const r of sim.pending()) { reqs.push(r); sim.resolve(r.id, { provider: 'rules', action: r.auto?.action ?? undefined }); }
  };
  while (!sim.done) { sim.step(); answer(); }
  answer();
  return { sim, reqs };
}

// frames.list → [{ t, pos: Map agentId → { x, y, s } }]
function decodeFrames(frames) {
  return frames.list.map(f => {
    const pos = new Map();
    for (let i = 0; i < f.a.length; i += 4) pos.set(f.a[i], { x: f.a[i + 1] / 10, y: f.a[i + 2] / 10, s: f.a[i + 3] });
    return { t: f.t, pos };
  });
}

function distToPolyline(p, pts) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y));
  }
  return best;
}

// Metrics fields added after the recorded hashes: walls and doors (§13, §14), segments and offers (§15).
const withoutAdvisor = m => { const { segments, offers, ...rest } = m; return rest; };
const withoutNew = m => { const { walls, doors, ...rest } = withoutAdvisor(m); return rest; };
const framesWithoutNew = f => ({ ...f, walls: undefined, doors: undefined, list: f.list.map(({ d, ...r }) => r) });

// ---------- tests ----------

describe('walking through a door (two rooms)', () => {
  test('agents arrive, travel time follows the path through the door, doors count every trip', () => {
    const sim = new Sim(TWO_ROOMS, { seed: 3 });
    const nav = createNav(sim.spec.walls, { clearance: 0.2 });
    const through = nav.path(10, 30, 80, 40);
    assert.ok(through, 'the desk is reachable from the front door');
    // Shortest way is via the middle door's top jamb (50, 18): within 2% of that, and longer than the straight 70.7.
    const viaJamb = Math.hypot(40, 12) + Math.hypot(30, 22);
    assert.ok(through.length >= viaJamb - 1e-9 && through.length <= viaJamb * 1.02, `path length ${through.length}`);
    assert.ok(through.length > Math.hypot(70, 10) + 5);
    const back = nav.path(80, 40, 10, 30);

    // Step by hand: every walk's duration is path length / travelSpeed + 0.5, and the agent reaches the
    // desk on the first tick at or after that time.
    const walks = new Map(), arrivedAt = new Map(), allWalks = new Map();
    while (!sim.done) {
      const t = sim.t;
      sim.step();
      for (const a of sim.agents) {
        if (a.state === 'walk' && !walks.has(a.id)) walks.set(a.id, { t0: a.t0, t1: a.t1 });
        if ((a.state === 'walk' || a.state === 'leave') && !allWalks.has(`${a.id}@${a.t0}`)) {
          allWalks.set(`${a.id}@${a.t0}`, { t0: a.t0, t1: a.t1, path: a.state === 'walk' ? through : back });
        }
        if ((a.state === 'queue' || a.state === 'serve') && !arrivedAt.has(a.id)) arrivedAt.set(a.id, t);
      }
    }
    const m = sim.metrics();
    assert.equal(m.spawned, 30);
    assert.equal(m.finished, 30, 'the run is long enough for everyone to go in and come back out');
    assert.equal(m.nodes.find(n => n.id === 'desk').arrivals, 30);
    assert.equal(walks.size, 30);
    for (const [id, w] of walks) {
      assert.ok(Math.abs((w.t1 - w.t0) - (through.length / 8 + 0.5)) < 1e-9, `agent ${id} walk time ${w.t1 - w.t0}`);
      const at = arrivedAt.get(id);
      assert.ok(at >= w.t1 - 1e-9 && at < w.t1 + sim.dt + 1e-9, `agent ${id} arrived at ${at}, due ${w.t1}`);
    }
    assert.ok(Math.abs(back.length - through.length) < 0.05);

    // Each person crosses each door twice: in, then out through the front door they came from.
    const doors = Object.fromEntries(m.doors.map(d => [d.id, d]));
    assert.equal(doors.mid.crossings, 2 * m.spawned);
    assert.equal(doors.front_door.crossings, 2 * m.spawned);
    assert.equal(doors.front_door.exterior, true);
    assert.equal(doors.mid.exterior, false);
    assert.equal(doors.mid.name, 'Middle door');
    for (const d of m.doors) {
      assert.ok(d.peakPer5Min >= 1 && d.peakPer5Min <= d.crossings);
      assert.match(d.peakClock, /^\d\d:\d\d$/);
    }
    assert.deepEqual(m.walls, { count: 7, checkedMoves: 60, violations: 0 });

    // Frames: walls (2 decimals), doors, and nondecreasing cumulative crossings per door.
    assert.equal(sim.frames.walls.length, 7);
    assert.deepEqual(sim.frames.walls[5], [50, 10, 50, 14]);
    assert.deepEqual(sim.frames.doors.map(d => d.id), ['front_door', 'mid']);
    assert.deepEqual(sim.frames.doors[1], { id: 'mid', name: 'Middle door', x1: 50, y1: 14, x2: 50, y2: 18, exterior: false });
    let prev = [0, 0];
    for (const f of sim.frames.list) {
      assert.equal(f.d.length, 2);
      f.d.forEach((v, i) => assert.ok(v >= prev[i]));
      prev = f.d;
    }
    assert.ok(prev[1] > 0 && prev[1] <= doors.mid.crossings);

    // A crossing counts when the walker reaches the door, not when the walk starts: the middle door is
    // reached at (distance along the path to x = 50) / length of the way through the walk.
    const midAt = path => {
      let along = 0;
      for (let i = 0; i + 1 < path.points.length; i++) {
        const a = path.points[i], b = path.points[i + 1], len = Math.hypot(b.x - a.x, b.y - a.y);
        if ((a.x - 50) * (b.x - 50) <= 0) return along + len * (50 - a.x) / (b.x - a.x);
        along += len;
      }
      return null;
    };
    const midTimes = [...allWalks.values()].map(w => w.t0 + (midAt(w.path) / w.path.length) * (w.t1 - w.t0));
    assert.equal(midTimes.length, 60);
    for (const f of sim.frames.list) {
      assert.equal(f.d[1], midTimes.filter(x => x <= f.t + 1e-9).length, `middle door count at t ${f.t}`);
    }
  });

  test('door hits: a path vertex on a door is one crossing; starting on a door and crossing back both count', () => {
    const sim = new Sim(TWO_ROOMS, { seed: 1 });
    const P = (x, y) => ({ x, y });
    // Vertex (50, 16) sits on the middle door: both pieces touch it, one crossing at distance 10.
    assert.deepEqual(sim.doorHits([P(40, 16), P(50, 16), P(60, 20)]), [{ door: 1, s: 10 }]);
    // Starting on the front door counts it at distance 0; through the middle door at 40.
    assert.deepEqual(sim.doorHits([P(10, 30), P(50, 16), P(60, 16)]).map(h => [h.door, +h.s.toFixed(6)]),
      [[0, 0], [1, +Math.hypot(40, 14).toFixed(6)]]);
    // In and back out through the same door: two crossings.
    assert.deepEqual(sim.doorHits([P(45, 15), P(55, 15), P(55, 17), P(45, 17)]).map(h => h.door), [1, 1]);
    // Running along a door line counts once, where it first touches it.
    assert.deepEqual(sim.doorHits([P(50, 5), P(50, 20)]), [{ door: 1, s: 9 }]);
    assert.deepEqual(sim.doorHits([P(20, 20), P(40, 40)]), []);
  });

  test('a door pulled in from its jambs still counts a path that rounds a jamb inside the pull-in', () => {
    // The middle door drawn 0.1 short of both jambs (50, 14) and (50, 18), the way builders draw doors.
    const world = { ...TWO_ROOMS, doors: [TWO_ROOMS.doors[0], { id: 'mid', name: 'Middle door', x1: 50, y1: 14.1, x2: 50, y2: 17.9 }] };
    const sim = new Sim(world, { seed: 1 });
    const P = (x, y) => ({ x, y });
    // Crosses x = 50 at y = 17.995: between the drawn end (17.9) and the jamb (18). One crossing, at x = 50.
    const hits = sim.doorHits([P(40, 29.99), P(60, 6)]);
    assert.deepEqual(hits.map(h => h.door), [1]);
    assert.ok(Math.abs(hits[0].s - Math.hypot(10, 11.995)) < 1e-6);
    // ... and just inside the bottom jamb (y = 14.004).
    assert.deepEqual(sim.doorHits([P(40, 5), P(60, 23.008)]).map(h => h.door), [1]);
    // The counting segment reaches 0.02 past each jamb; the drawn door (frames, viewer) is unchanged.
    const gap = sim.doorList[1].gap;
    assert.ok(Math.abs(gap.y1 - 13.98) < 1e-9 && Math.abs(gap.y2 - 18.02) < 1e-9 && gap.x1 === 50 && gap.x2 === 50);
    assert.deepEqual(sim.frames.doors[1], { id: 'mid', name: 'Middle door', x1: 50, y1: 14.1, x2: 50, y2: 17.9, exterior: false });
    // A door end with no wall within reach is not extended.
    const free = new Sim({ ...TWO_ROOMS, doors: [{ id: 'bar', name: 'Free bar', x1: 30, y1: 20, x2: 30, y2: 25 }] }, { seed: 1 });
    assert.deepEqual(free.doorList[0].gap, { x1: 30, y1: 20, x2: 30, y2: 25 });
    assert.deepEqual(free.doorHits([P(25, 25.05), P(35, 25.05)]), []);
    // Doors that already touch their jambs, and doors in a world without walls, are used exactly as drawn.
    assert.deepEqual(new Sim(TWO_ROOMS, { seed: 1 }).doorList[1].gap, { x1: 50, y1: 14, x2: 50, y2: 18 });
    const { walls, ...noWalls } = world;
    assert.deepEqual(new Sim(noWalls, { seed: 1 }).doorList[1].gap, { x1: 50, y1: 14.1, x2: 50, y2: 17.9 });
  });

  test('walks between two storefront doors around a thick pier are counted at both doors', () => {
    // Fictional storefront: two units split by a party wall, each with a door in the facade (x = 80),
    // a pier between the doors with an alcove open to the street, and a short jamb stub at the south
    // door. Doors are drawn 0.094 short of their jambs. People come down stairs in the north unit, walk
    // out the north door, along the street and in the south door to the shop, and back.
    const STOREFRONT = {
      title: 'Storefront jamb test (fictional)', question: 'Are walks that round a jamb counted?', mode: 'visit',
      duration: 120, clockStart: 600, travelSpeed: 20,
      arrivals: { total: 20, start: 0, end: 30, shape: 'uniform' },
      nodes: [
        { id: 'stairs', name: 'Stairs (north unit)', kind: 'gate', x: 70, y: 25 },
        { id: 'shop', name: 'South shop', kind: 'service', x: 60, y: 70, servers: 4, serviceTime: 2, tags: ['shop'] }
      ],
      archetypes: [{ id: 'staff', name: 'Staff', share: 1, visits: 1, patience: 120, info: 1, needs: ['shop'] }],
      walls: [
        [10, 10, 80, 10], [10, 90, 80, 90], [10, 10, 10, 90], [80, 10, 80, 30],
        [80, 36, 79, 36], [79, 36, 79, 40], [79, 40, 80, 40], [80, 40, 80, 40.15], [80, 46, 80, 90],
        [10, 38, 79, 38]
      ],
      doors: [
        { id: 'north', name: 'North door', x1: 80, y1: 30.094, x2: 80, y2: 35.906, exterior: true },
        { id: 'south', name: 'South door', x1: 80, y1: 40.244, x2: 80, y2: 45.906, exterior: true }
      ],
      geo: { clearance: 0.377 }
    };
    const sim = new Sim(STOREFRONT, { seed: 1 }).runToEnd();
    const m = sim.metrics();
    assert.equal(m.spawned, 20);
    assert.equal(m.finished, 20);
    assert.equal(m.walls.violations, 0);
    const doors = Object.fromEntries(m.doors.map(d => [d.id, d.crossings]));
    assert.deepEqual(doors, { north: 2 * m.spawned, south: 2 * m.spawned });
  });

  test('busiest door first; identical runs give identical door traffic', () => {
    const a = new Sim(OFFICE, { seed: 5 }).runToEnd().metrics();
    const b = new Sim(OFFICE, { seed: 5 }).runToEnd().metrics();
    assert.deepEqual(a.doors, b.doors);
    assert.equal(a.doors.length, 5);
    for (let i = 1; i < a.doors.length; i++) assert.ok(a.doors[i - 1].crossings >= a.doors[i].crossings);
    assert.ok(a.doors.find(d => d.id === 'front_door').crossings > 0);
    assert.ok(a.walls.checkedMoves > 0);
    assert.equal(a.walls.violations, 0);
  });
});

describe('no dot ever jumps a wall', () => {
  test('consecutive frames are never further apart on foot than 1.5 x straight + 0.5', () => {
    const { sim, reqs } = runExternal(OFFICE, { seed: 11, dt: 0.1, frameEvery: 0.1 });
    assert.ok(reqs.length > 0);
    const nav = createNav(sim.spec.walls, { clearance: 0.2 });
    const frames = decodeFrames(sim.frames);
    assert.ok(frames.length > 1000);
    let pairs = 0, moving = 0;
    for (let k = 1; k < frames.length; k++) {
      for (const [id, p] of frames[k].pos) {
        const q = frames[k - 1].pos.get(id);
        if (!q) continue;
        const straight = Math.hypot(p.x - q.x, p.y - q.y);
        const walk = nav.distance(q.x, q.y, p.x, p.y);
        assert.ok(walk <= 1.5 * straight + 0.5,
          `agent ${id} t ${frames[k - 1].t}→${frames[k].t}: (${q.x}, ${q.y}) → (${p.x}, ${p.y}) is ${walk} on foot, ${straight} straight`);
        pairs++;
        if (straight > 0) moving++;
      }
    }
    assert.ok(pairs > 10000, `${pairs} frame pairs checked`);
    assert.ok(moving > 1000);
    const m = sim.metrics();
    assert.ok(m.nodes.find(n => n.id === 'printer').maxQueue >= 3, 'the printer by the wall had a line to lay out');
    assert.ok(m.walls.checkedMoves > 0);
    assert.equal(m.walls.violations, 0);
  });

  test('frame rounding never moves a dot onto or across a wall', () => {
    // Positions are stored ×10 as integers; a point 0.03 left of the wall x = 50 would round onto it.
    const sim = new Sim(OFFICE, { seed: 1 });
    const nav = createNav(sim.spec.walls, { clearance: 0.2 });
    let nearWall = 0;
    for (let x = 49.9; x < 50; x += 0.007) {
      for (let y = 20; y <= 30; y += 0.37) {
        const [qx, qy] = sim.frameXY(x, y);
        assert.ok(!nav.blocked(x, y, qx / 10, qy / 10), `(${x}, ${y}) stored as (${qx / 10}, ${qy / 10})`);
        if (Math.round(x * 10) === 500) nearWall++;
      }
    }
    assert.ok(nearWall > 100, 'the sweep includes points whose plain rounding lands on the wall');
  });

  test('the same check catches straight-line motion through a wall', () => {
    // Sanity check of the check itself: two points either side of the middle wall.
    const nav = createNav(OFFICE.walls.map(([x1, y1, x2, y2]) => ({ x1, y1, x2, y2 })), { clearance: 0.2 });
    const walk = nav.distance(49.6, 25, 50.4, 25);
    assert.ok(walk > 1.5 * 0.8 + 0.5);
  });
});

describe('unreachable places', () => {
  test('a walled-off place is never offered and nobody arrives there', () => {
    const { sim, reqs } = runExternal(WALLED_OFF, { seed: 2 });
    assert.ok(reqs.length > 0);
    let offered = 0;
    for (const r of reqs) {
      assert.ok(!r.options.some(o => o.key === 'vault'), `${r.id} offers the vault`);
      assert.ok(!(r.observation.places || []).some(p => p.option === 'vault'), `${r.id} shows the vault`);
      if (r.options.some(o => o.key === 'shop')) offered++;
    }
    assert.ok(offered > 0, 'the reachable shop is offered');
    const m = sim.metrics();
    assert.equal(m.nodes.find(n => n.id === 'vault').arrivals, 0);
    assert.ok(m.nodes.find(n => n.id === 'shop').arrivals > 0);
    assert.equal(m.walls.violations, 0);
    // archetypes[].entries: everyone appears at the shop door.
    for (const a of sim.agentsSummary()) assert.equal(a.trace[0].m, 'Arrived at Shop door');
  });

  test('inline rules never pick an unreachable place either', () => {
    const m = new Sim(WALLED_OFF, { seed: 4 }).runToEnd().metrics();
    assert.equal(m.nodes.find(n => n.id === 'vault').arrivals, 0);
    assert.ok(m.nodes.find(n => n.id === 'shop').arrivals > 0);
  });

  test('distance words and line visibility use walking distance', () => {
    const { reqs } = runExternal(NEIGHBORS, { seed: 1 });
    const fromCopy = reqs.filter(r => r.kind === 'choose' && r.why === 'next' && r.aboutPlace === 'copy' && r.options.some(o => o.key === 'desk'));
    assert.ok(fromCopy.length > 0);
    for (const r of fromCopy) {
      const desk = r.observation.places.find(p => p.option === 'desk');
      assert.equal(desk.distance, 'far');                              // 10 units straight, about 45 on foot
      assert.equal(desk.line, "unknown (can't see it from here)");     // beyond 30 units on foot, no app
    }
  });

  test('people leave through the nearest exit on foot, not the nearest in a straight line', () => {
    // The back door is 10 units from the copy room in a straight line but about 45 on foot; the
    // entrance is 25 away in the same room.
    const world = copy(NEIGHBORS);
    world.nodes = [
      { id: 'gate', name: 'Entrance', kind: 'gate', x: 20, y: 40 },
      { id: 'back', name: 'Back door', kind: 'exit', x: 55, y: 40 },
      { id: 'copy', name: 'Copy room', kind: 'service', x: 45, y: 40, servers: 4, serviceTime: 1 }
    ];
    world.archetypes = [{ id: 'temps', name: 'Temps', share: 1, visits: 1, patience: 60 }];
    const sim = new Sim(world, { seed: 6 }).runToEnd();
    const leaving = sim.agentsSummary().map(a => a.trace.find(e => / heading to /.test(e.m))?.m).filter(Boolean);
    assert.ok(leaving.length > 10);
    for (const m of leaving) assert.match(m, /heading to Entrance$/);
  });

  test('a remark about a place behind a wall is not overheard (10 units straight, about 45 on foot)', () => {
    // Clerks go to the front desk and talk about it; temps finish in the copy room next door, where
    // the desk is close in a straight line but far on foot. Nobody has the app.
    const world = copy(NEIGHBORS);
    world.nodes[1].tags = ['copy'];
    world.nodes[2].tags = ['desk'];
    world.archetypes = [
      { id: 'temps', name: 'Temps', share: 1, visits: 2, patience: 60, info: 0, needs: ['copy'] },
      { id: 'clerks', name: 'Clerks', share: 1, visits: 1, patience: 60, info: 0, needs: ['desk'] }
    ];
    const sim = new Sim(world, { seed: 4, external: true });
    const reqs = [];
    const answer = () => {
      for (const r of sim.pending()) {
        reqs.push(r);
        sim.resolve(r.id, { provider: 'rules', action: r.auto?.action ?? undefined, tellProb: 1, remarkProbs: { good_experience: 1 } });
      }
    };
    while (!sim.done) { sim.step(); answer(); }
    answer();
    const deskRemarks = sim.remarks.filter(r => r.placeId === 'desk');
    assert.ok(deskRemarks.length > 0);
    const atCopy = reqs.filter(r => r.archetypeId === 'temps' && r.aboutPlace === 'copy' && r.t >= deskRemarks[0].t);
    assert.ok(atCopy.length > 0, 'temps choose at the copy room after clerks talked about the desk');
    for (const r of atCopy) {
      assert.ok(!(r.observation.heard || []).some(h => h.includes('Front desk')), `${r.id} overheard the desk through the wall`);
    }
  });

  test('overheard remarks use walking distance when the viewer supplies it', () => {
    const remarks = [{ t: 10, agentId: 2, personaName: 'Dana Fictional', archetypeId: 'other', kind: 'long_line', placeId: 'desk', edgeId: null }];
    const viewer = {
      mode: 'visit', t: 20, agentId: 1, archetypeId: 'temps', informed: false, x: 45, y: 40,
      placePos: new Map([['desk', { x: 55, y: 40 }]])
    };
    const names = { place: new Map([['desk', 'Front desk']]), edge: new Map() };
    assert.equal(selectHeard(remarks, viewer, names).length, 1);
    assert.match(selectHeard(remarks, viewer, names)[0], /overheard nearby/);
    assert.deepEqual(selectHeard(remarks, { ...viewer, distanceTo: () => 45.5 }, names), []);
    assert.equal(selectHeard(remarks, { ...viewer, distanceTo: () => 12 }, names).length, 1);
  });
});

describe('route mode polylines', () => {
  test('agents on a link with via points are drawn on its polyline', () => {
    const sim = new Sim(HALL, { seed: 7, frameEvery: 0.25 }).runToEnd();
    const pts = [{ x: 10, y: 50 }, { x: 50, y: 80 }, { x: 90, y: 50 }];
    assert.deepEqual(sim.frames.edges[0].via, [{ x: 50, y: 80 }]);
    assert.deepEqual(sim.frames.walls, [[50, 20, 50, 70]]);
    let drawn = 0;
    for (const f of decodeFrames(sim.frames)) {
      for (const [id, p] of f.pos) {
        if (p.s !== 5) continue;
        assert.ok(distToPolyline(p, pts) <= 0.075, `agent ${id} at (${p.x}, ${p.y}) is off the hallway`);
        drawn++;
      }
    }
    assert.ok(drawn > 50);
    const m = sim.metrics();
    assert.ok(m.arrived > 0);
    assert.equal(m.walls.count, 1);
    assert.equal(m.walls.checkedMoves, m.spawned);                    // one link per trip, each checked
    assert.equal(m.walls.violations, 0);
    assert.deepEqual(m.doors, []);
  });

  test('without walls, route agents keep their lane offset beside the polyline', () => {
    const world = copy(HALL);
    delete world.walls;
    const sim = new Sim(world, { seed: 7, frameEvery: 0.25 }).runToEnd();
    const pts = [{ x: 10, y: 50 }, { x: 50, y: 80 }, { x: 90, y: 50 }];
    let drawn = 0;
    for (const f of decodeFrames(sim.frames)) {
      for (const p of f.pos.values()) {
        if (p.s !== 5) continue;
        const d = distToPolyline(p, pts);
        assert.ok(d <= 1.0 + 0.075 && d >= 0.4 - 0.075 - 1e-9 || polylineLength(pts) === 0, `lane offset ${d}`);
        drawn++;
      }
    }
    assert.ok(drawn > 50);
    assert.equal(sim.metrics().walls.checkedMoves, 0);
  });
});

describe('fail loudly', () => {
  test('a route edge through a wall throws WallViolation (validation bypassed)', () => {
    // normalizeSpec rejects such an edge, so the wall is handed to the Sim after construction.
    const sim = new Sim(HALL, { seed: 7 });
    sim.walls.push({ x1: 30, y1: 60, x2: 30, y2: 90 });
    assert.throws(() => sim.runToEnd(), err => {
      assert.ok(err instanceof WallViolation);
      assert.equal(err.name, 'WallViolation');
      assert.equal(err.wall, 1);
      assert.equal(err.edgeId, 'o>d');
      assert.deepEqual(err.from, { x: 10, y: 50 });
      assert.deepEqual(err.to, { x: 90, y: 50 });
      assert.match(err.message, /^agent \d+ would move from \(10\.00, 50\.00\) to \(90\.00, 50\.00\) along o>d through wall 1/);
      return true;
    });
    assert.equal(sim.metrics().walls.violations, 1);
  });

  test('a walking path through a wall the navigator did not know about throws WallViolation', () => {
    // The navigator is built at construction; a wall added afterwards closes the middle door behind its
    // back, so only the Sim's own check stands between the agent and the wall.
    const sim = new Sim(TWO_ROOMS, { seed: 3 });
    sim.walls.push({ x1: 50, y1: 14, x2: 50, y2: 18 });
    assert.throws(() => sim.runToEnd(), err => err instanceof WallViolation && err.wall === 7 && err.edgeId === null &&
      err.from.x === 10 && err.from.y === 30 && err.to.x === 80 && err.to.y === 40);
  });
});

describe('archetypes[].entries', () => {
  const gates = {
    title: 'Two gates (fictional)', mode: 'visit', duration: 60, arrivals: { total: 400, start: 0, end: 30 },
    nodes: [
      { id: 'g1', name: 'North gate', kind: 'gate', x: 20, y: 20 },
      { id: 'g2', name: 'South gate', kind: 'gate', x: 20, y: 80, weight: 3 },
      { id: 'p', name: 'Kiosk', kind: 'service', x: 60, y: 50 }
    ],
    archetypes: [{ id: 'a', name: 'A', share: 1 }]
  };
  const entryCounts = sim => {
    const c = {};
    for (const a of sim.agentsSummary()) c[a.trace[0].m] = (c[a.trace[0].m] || 0) + 1;
    return c;
  };

  test('a group with entries appears only there; a cast member\'s own entry still wins about half the time', () => {
    const only = entryCounts(new Sim({ ...gates, archetypes: [{ id: 'a', name: 'A', share: 1, entries: ['g1'] }] }, { seed: 1 }).runToEnd());
    assert.deepEqual(Object.keys(only), ['Arrived at North gate']);

    const cast = {
      ...gates,
      archetypes: [{ id: 'a', name: 'A', share: 1, entries: ['g1'] }],
      minds: [{ id: 'sam', name: 'Sam Fictional', archetype: 'a', entry: 'g2' }]
    };
    const c = entryCounts(new Sim(cast, { seed: 1 }).runToEnd());
    const south = c['Arrived at South gate'] / 400;
    assert.ok(south > 0.4 && south < 0.6, `own entry share ${south}`);
  });

  test('without entries, spawning is unchanged (every entry by weight, same people)', () => {
    const a = new Sim(gates, { seed: 9 }).runToEnd();
    const b = new Sim({ ...gates, archetypes: [{ id: 'a', name: 'A', share: 1, entries: [] }] }, { seed: 9 }).runToEnd();
    assert.deepEqual(a.metrics(), b.metrics());
    assert.deepEqual(a.frames, b.frames);
    const south = entryCounts(a)['Arrived at South gate'] / 400;
    assert.ok(south > 0.65 && south < 0.85, `weight-3 gate share ${south}`);
  });
});

describe('archetypes[].exits', () => {
  const leftBy = a => a.trace.find(e => / heading to /.test(e.m))?.m.match(/ heading to (.+)$/)[1] ?? null;
  const byGroup = (sim, id) => sim.agentsSummary().filter(a => a.archetypeId === id);
  const crossings = sim => Object.fromEntries(sim.metrics().doors.map(d => [d.id, d.crossings]));

  test('a group with exits always leaves through its own gate; a group without takes the nearest; doors count it', () => {
    const sim = new Sim(TWO_GATES, { seed: 4 }).runToEnd();
    const m = sim.metrics();
    assert.equal(m.finished, m.spawned);
    const regulars = byGroup(sim, 'regulars'), passers = byGroup(sim, 'passers');
    const R = regulars.length, P = passers.length;
    assert.ok(R > 20 && P > 20, `${R} regulars, ${P} passers`);
    for (const a of regulars) assert.equal(leftBy(a), 'West gate', `agent ${a.id}`);
    for (const a of passers) assert.equal(leftBy(a), 'East gate', `agent ${a.id}`);
    // Everyone starts on the west door and crosses the inner doorway to the kiosk. Regulars walk back
    // through both; passers step out of the east door 10 units away.
    assert.deepEqual(crossings(sim), { west_door: 2 * R + P, east_door: P, inner: 2 * R + P });
    assert.equal(m.doors[0].id, 'west_door');
    assert.equal(m.walls.violations, 0);
  });

  test('without exits everyone takes the nearest gate, and nothing before leaving changes', () => {
    const plain = copy(TWO_GATES);
    delete plain.archetypes[0].exits;
    const withExits = new Sim(TWO_GATES, { seed: 4 }).runToEnd(), without = new Sim(plain, { seed: 4 }).runToEnd();
    const N = without.metrics().spawned;
    for (const a of without.agentsSummary()) assert.equal(leftBy(a), 'East gate');
    assert.deepEqual(crossings(without), { west_door: N, east_door: N, inner: N });
    // Leaving draws no random numbers: the same people arrive, choose and are served the same way.
    const upToLeaving = sim => sim.agentsSummary().map(a => ({
      id: a.id, personaId: a.personaId, archetypeId: a.archetypeId, informed: a.informed, born: a.born,
      served: a.served, waitTotal: a.waitTotal, trace: a.trace.map(e => ({ t: e.t, m: e.m.replace(/ heading to .+$/, '') }))
    }));
    assert.deepEqual(upToLeaving(withExits), upToLeaving(without));
    const nodes = sim => sim.metrics().nodes;
    assert.deepEqual(nodes(withExits), nodes(without));
  });

  test('the external decision path leaves through the same exits', () => {
    const { sim, reqs } = runExternal(TWO_GATES, { seed: 4 });
    assert.ok(reqs.some(r => r.kind === 'choose'));
    const regulars = byGroup(sim, 'regulars'), passers = byGroup(sim, 'passers');
    assert.ok(regulars.length && passers.length);
    for (const a of regulars) assert.equal(leftBy(a), 'West gate');
    for (const a of passers) assert.equal(leftBy(a), 'East gate');
    assert.deepEqual(crossings(sim), { west_door: 2 * regulars.length + passers.length, east_door: passers.length, inner: 2 * regulars.length + passers.length });
  });

  test('exits that list every exit, or [], run exactly like no exits', () => {
    const plain = copy(TWO_GATES);
    delete plain.archetypes[0].exits;
    const base = new Sim(plain, { seed: 11 }).runToEnd();
    for (const exits of [[], ['west', 'east'], ['East gate', 'West gate']]) {
      const w = copy(plain);
      for (const ar of w.archetypes) ar.exits = exits;
      const sim = new Sim(w, { seed: 11 }).runToEnd();
      assert.deepEqual(sim.metrics(), base.metrics(), JSON.stringify(exits));
      assert.deepEqual(sim.frames, base.frames);
      assert.deepEqual(sim.agentsSummary(), base.agentsSummary());
    }
  });

  test('without walls, a group with exits walks to its own exit even when another is nearer', () => {
    const open = {
      title: 'Open lot (fictional)', mode: 'visit', duration: 120, arrivals: { total: 100, start: 0, end: 40 },
      nodes: [
        { id: 'g1', name: 'North gate', kind: 'gate', x: 20, y: 20 },
        { id: 'g2', name: 'South gate', kind: 'gate', x: 20, y: 80 },
        { id: 'x', name: 'Back exit', kind: 'exit', x: 30, y: 72 },
        { id: 'p', name: 'Kiosk', kind: 'service', x: 20, y: 70, servers: 10, serviceTime: 1 }
      ],
      archetypes: [{ id: 'a', name: 'A', share: 1, visits: 1, patience: 60, entries: ['g2'], exits: ['g1'] }]
    };
    const sim = new Sim(open, { seed: 2 }).runToEnd();
    assert.equal(sim.metrics().finished, sim.metrics().spawned);
    for (const a of sim.agentsSummary()) assert.equal(leftBy(a), 'North gate');
    const nearest = new Sim({ ...open, archetypes: [{ ...open.archetypes[0], exits: [] }] }, { seed: 2 }).runToEnd();
    for (const a of nearest.agentsSummary()) assert.equal(leftBy(a), 'South gate');   // 10 away; the back exit is about 10.2
  });

  test('when walls leave none of the group\'s exits reachable, people take the nearest reachable exit', () => {
    // The annex gate is sealed inside its own building, so shoppers can never reach it.
    const w = copy(WALLED_OFF);
    w.archetypes[0].exits = ['e2'];
    const sim = new Sim(w, { seed: 3 }).runToEnd();
    const agents = sim.agentsSummary();
    assert.ok(agents.length > 20);
    assert.equal(sim.metrics().finished, agents.length);
    for (const a of agents) {
      const line = a.trace.find(e => /^Done /.test(e.m)).m;
      assert.match(line, / heading to Shop door \(none of this group's exits can be reached on foot from here\)$/);
    }
    assert.equal(sim.metrics().walls.violations, 0);
  });
});

describe('worlds without exits give the same metrics as before exits existed', () => {
  for (const name of Object.keys(BEFORE_EXITS)) {
    test(`${name}: rules, seed 7`, () => {
      const sim = new Sim(loadWorld(name), { seed: 7 }).runToEnd();
      assert.equal(hash16(JSON.stringify(withoutAdvisor(sim.metrics()))), BEFORE_EXITS[name].metrics);
      assert.equal(hash16(JSON.stringify(sim.frames)), BEFORE_EXITS[name].frames);
      assert.ok(sim.spec.archetypes.every(a => Array.isArray(a.exits) && a.exits.length === 0));
    });
  }
});

describe('worlds without walls behave exactly as before', () => {
  for (const name of Object.keys(BEFORE)) {
    test(`${name}: same metrics and frames as before walls (rules, seed 7)`, () => {
      const sim = new Sim(loadWorld(name), { seed: 7 }).runToEnd();
      const m = sim.metrics();
      const head = m.mode === 'visit'
        ? { spawned: m.spawned, served: m.served, abandoned: m.abandoned, avgWait: m.avgWait, abandonRate: m.abandonRate }
        : { spawned: m.spawned, arrived: m.arrived, avgTrip: m.avgTrip, avgDelay: m.avgDelay };
      assert.deepEqual(head, BEFORE[name].head);
      assert.equal(hash16(JSON.stringify(withoutNew(m))), BEFORE[name].metrics);
      assert.equal(hash16(JSON.stringify(framesWithoutNew(sim.frames))), BEFORE[name].frames);
      assert.deepEqual(m.walls, { count: 0, checkedMoves: 0, violations: 0 });
      assert.deepEqual(m.doors, []);
      assert.deepEqual(sim.frames.walls, []);
      assert.deepEqual(sim.frames.doors, []);
      assert.ok(sim.frames.list.every(f => f.d === null));
    });
  }
});
