// engine/walls.js tests: normalization, touch-inclusive crossing tests, polyline helpers and
// wall-free navigation (docs/PROTOTYPE.md §13). All layouts are hand-made or generated here.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWalls, crossesWall, polylineCrossesWall, polylineLength, pointAlong, createNav
} from '../engine/walls.js';
import { mulberry32 } from '../engine/util.js';

// ---------- helpers ----------

const seg = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
const box = (x1, y1, x2, y2) => [seg(x1, y1, x2, y1), seg(x2, y1, x2, y2), seg(x2, y2, x1, y2), seg(x1, y2, x1, y1)];
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);
// A detour around wall ends is at least the touching limit (bending exactly at the ends), at most
// the length of bending once at a point `clearance` beyond them, and within 2% of the limit.
function assertDetour(p, limit, oneBend) {
  assert.ok(p.length >= limit - 1e-9, `${p.length} is shorter than the touching limit ${limit}`);
  assert.ok(p.length <= oneBend + 1e-9, `${p.length} is longer than bending once at clearance (${oneBend})`);
  assert.ok(p.length <= 1.02 * limit, `${p.length} is more than 2% over the touching limit ${limit}`);
}
// Every bend sits on the clearance circle of one of the given corners.
function assertBendsAt(p, corners, c) {
  for (const q of p.points.slice(1, -1)) {
    const d = Math.min(...corners.map(([x, y]) => Math.hypot(q.x - x, q.y - y)));
    close(d, c, 1e-9, `bend (${q.x}, ${q.y}) distance from its corner`);
  }
}

// Independent check, written separately from engine/walls.js: do segments p-q and w share a point?
// Classic orientation test with explicit handling of collinear and endpoint cases.
function orient(ax, ay, bx, by, cx, cy) {
  const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return v > 1e-12 ? 1 : v < -1e-12 ? -1 : 0;
}
function within(ax, ay, bx, by, px, py) {
  return Math.min(ax, bx) - 1e-12 <= px && px <= Math.max(ax, bx) + 1e-12 &&
    Math.min(ay, by) - 1e-12 <= py && py <= Math.max(ay, by) + 1e-12;
}
function intersects(p, q, w) {
  const o1 = orient(w.x1, w.y1, w.x2, w.y2, p.x, p.y), o2 = orient(w.x1, w.y1, w.x2, w.y2, q.x, q.y);
  const o3 = orient(p.x, p.y, q.x, q.y, w.x1, w.y1), o4 = orient(p.x, p.y, q.x, q.y, w.x2, w.y2);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  return (o1 === 0 && within(w.x1, w.y1, w.x2, w.y2, p.x, p.y)) ||
    (o2 === 0 && within(w.x1, w.y1, w.x2, w.y2, q.x, q.y)) ||
    (o3 === 0 && within(p.x, p.y, q.x, q.y, w.x1, w.y1)) ||
    (o4 === 0 && within(p.x, p.y, q.x, q.y, w.x2, w.y2));
}
function assertWallFree(walls, points, label = 'path') {
  for (let i = 0; i + 1 < points.length; i++) {
    for (let k = 0; k < walls.length; k++) {
      assert.ok(!intersects(points[i], points[i + 1], walls[k]), `${label}: piece ${i} touches wall ${k}`);
    }
  }
}
function assertPathShape(p, x1, y1, x2, y2) {
  assert.deepEqual(p.points[0], { x: x1, y: y1 });
  assert.deepEqual(p.points[p.points.length - 1], { x: x2, y: y2 });
  close(p.length, polylineLength(p.points), 1e-9, 'length');
}
// Where the polyline crosses the vertical line x = x0 (the y values).
function crossingsAtX(points, x0) {
  const ys = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    if ((a.x - x0) * (b.x - x0) <= 0 && a.x !== b.x) ys.push(a.y + ((x0 - a.x) / (b.x - a.x)) * (b.y - a.y));
  }
  return ys;
}
function crossingsAtY(points, y0) {
  return crossingsAtX(points.map(p => ({ x: p.y, y: p.x })), y0);
}

// A grid of rooms with one door in every interior wall, padded with short furniture walls.
function floorPlan(rooms, door, rng, target) {
  const walls = [], step = 90 / rooms, o = 5;
  for (let i = 0; i <= rooms; i++) {
    for (let j = 0; j < rooms; j++) {
      const fixed = o + i * step, a1 = o + j * step, a2 = a1 + step;
      for (const horiz of [true, false]) {
        const piece = (s, e) => walls.push(horiz ? seg(s, fixed, e, fixed) : seg(fixed, s, fixed, e));
        if (i === 0 || i === rooms) { piece(a1, a2); continue; }
        const mid = a1 + step * (0.2 + 0.6 * rng());
        piece(a1, mid - door / 2);
        piece(mid + door / 2, a2);
      }
    }
  }
  while (walls.length < target) {
    const cx = o + (Math.floor(rng() * rooms) + 0.25 + 0.5 * rng()) * step;
    const cy = o + (Math.floor(rng() * rooms) + 0.25 + 0.5 * rng()) * step;
    const a = rng() * Math.PI, half = step * 0.1;
    walls.push(seg(cx - Math.cos(a) * half, cy - Math.sin(a) * half, cx + Math.cos(a) * half, cy + Math.sin(a) * half));
  }
  return walls.slice(0, target);
}

// ---------- normalizeWalls ----------

describe('normalizeWalls', () => {
  test('missing walls give an empty list without warnings; a non-array is ignored with a warning', () => {
    assert.deepEqual(normalizeWalls(undefined), { walls: [], warnings: [] });
    assert.deepEqual(normalizeWalls(null), { walls: [], warnings: [] });
    const r = normalizeWalls({ x1: 1 });
    assert.deepEqual(r.walls, []);
    assert.match(r.warnings[0], /^walls: expected an array/);
  });

  test('accepts object and array forms, numeric strings, and keeps a known source', () => {
    const r = normalizeWalls([
      { x1: 10, y1: 20, x2: 30, y2: 20, source: 'drawn' },
      [40, 40, 40, 60],
      { x1: '1', y1: '2', x2: '3', y2: '4', source: 'mesh-slice' }
    ]);
    assert.deepEqual(r.walls, [
      { x1: 10, y1: 20, x2: 30, y2: 20, source: 'drawn' },
      { x1: 40, y1: 40, x2: 40, y2: 60 },
      { x1: 1, y1: 2, x2: 3, y2: 4, source: 'mesh-slice' }
    ]);
    assert.deepEqual(r.warnings, []);
  });

  test('clamps out-of-range coordinates to the 0-100 map, naming the field', () => {
    const r = normalizeWalls([[-5, 10, 120, 10]]);
    assert.deepEqual(r.walls, [{ x1: 0, y1: 10, x2: 100, y2: 10 }]);
    assert.deepEqual(r.warnings, [
      'walls[0].x1: -5 is below the minimum 0; using 0',
      'walls[0].x2: 120 is above the maximum 100; using 100'
    ]);
  });

  test('drops zero-length, non-numeric and malformed segments with warnings', () => {
    const r = normalizeWalls([
      [5, 5, 5, 5],                 // zero length
      [-3, 10, -1, 10],             // zero length once clamped
      { x1: 1, y1: 'a', x2: 3, y2: 4 },
      { x1: 1, y1: 2, x2: 3 },      // missing y2
      [1, 2, 3],
      'wall',
      [10, 10, 20, 20]
    ]);
    assert.deepEqual(r.walls, [{ x1: 10, y1: 10, x2: 20, y2: 20 }]);
    assert.equal(r.warnings.filter(w => w.endsWith('zero length; dropped')).length, 2);
    assert.ok(r.warnings.includes('walls[2].y1: "a" is not a number; dropped'));
    assert.ok(r.warnings.includes('walls[3].y2: undefined is not a number; dropped'));
    assert.ok(r.warnings.some(w => w.startsWith('walls[4]: expected [x1, y1, x2, y2]')));
    assert.ok(r.warnings.some(w => w.startsWith('walls[5]: not a segment')));
  });

  test('drops an unknown source and reports unknown fields once', () => {
    const r = normalizeWalls([
      { x1: 0, y1: 0, x2: 10, y2: 0, source: 'lidar', edgeId: 'e1' },
      { x1: 0, y1: 5, x2: 10, y2: 5, edgeId: 'e2', roomIds: ['a'] }
    ]);
    assert.deepEqual(r.walls, [seg(0, 0, 10, 0), seg(0, 5, 10, 5)]);
    assert.ok(r.warnings.some(w => w.startsWith('walls[0].source: "lidar" is not one of')));
    assert.ok(r.warnings.includes('walls: unknown field "edgeId" ignored (in 2 segments)'));
    assert.ok(r.warnings.includes('walls: unknown field "roomIds" ignored (in 1 segment)'));
  });

  test('keeps at most 4000 segments', () => {
    const raw = Array.from({ length: 4005 }, (_, i) => [0, (i % 100), 1, (i % 100)]);
    const r = normalizeWalls(raw);
    assert.equal(r.walls.length, 4000);
    assert.ok(r.warnings[0].includes('4005 segments is above the maximum 4000'));
  });
});

// ---------- crossing tests ----------

describe('crossesWall and polylineCrossesWall', () => {
  const walls = [seg(10, 10, 30, 10), seg(30, 10, 30, 30), seg(50, 50, 70, 50)];

  test('a proper crossing returns the wall index; a clear segment returns -1', () => {
    assert.equal(crossesWall(walls, 20, 5, 20, 15), 0);
    assert.equal(crossesWall(walls, 60, 40, 60, 60), 2);
    assert.equal(crossesWall(walls, 0, 0, 5, 5), -1);
    assert.equal(crossesWall([], 0, 0, 100, 100), -1);
  });

  test('touching counts: wall endpoints, a shared corner, and ending on a wall', () => {
    assert.equal(crossesWall(walls, 5, 10, 10, 10), 0, 'segment ending on a wall endpoint');
    assert.equal(crossesWall(walls, 50, 45, 50, 55), 2, 'segment passing through a wall endpoint');
    assert.equal(crossesWall(walls, 25, 5, 35, 15), 0, 'segment through the corner where walls 0 and 1 meet');
    assert.equal(crossesWall(walls, 60, 40, 60, 50), 2, 'segment ending on the middle of a wall');
    assert.equal(crossesWall(walls, 60, 50, 60, 50), 2, 'a point on a wall');
    assert.equal(crossesWall(walls, 60, 50.5, 60, 50.5), -1, 'a point off every wall');
  });

  test('collinear overlap touches; collinear with a gap does not', () => {
    assert.equal(crossesWall(walls, 65, 50, 90, 50), 2);
    assert.equal(crossesWall(walls, 40, 50, 55, 50), 2);
    assert.equal(crossesWall(walls, 70.001, 50, 90, 50), -1);
  });

  test('epsilon is 1e-9: a parallel segment 1e-10 away touches, 1e-6 away does not', () => {
    assert.equal(crossesWall(walls, 55, 50 + 1e-10, 65, 50 + 1e-10), 2);
    assert.equal(crossesWall(walls, 55, 50 + 1e-6, 65, 50 + 1e-6), -1);
    assert.equal(crossesWall(walls, 70 + 1e-6, 45, 70 + 1e-6, 55), -1, 'passing just beyond a wall end');
  });

  test('returns the first wall touched and accepts the array form', () => {
    assert.equal(crossesWall([seg(0, 5, 10, 5), seg(0, 6, 10, 6)], 5, 0, 5, 10), 0);
    assert.equal(crossesWall([[0, 6, 10, 6], [0, 5, 10, 5]], 5, 0, 5, 10), 0);
    assert.equal(crossesWall([[0, 5, 10, 5]], 5, 0, 5, 4), -1);
  });

  test('polylineCrossesWall names the wall and the piece', () => {
    assert.equal(polylineCrossesWall(walls, [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 40, y: 5 }]), null);
    assert.deepEqual(polylineCrossesWall(walls, [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }, { x: 20, y: 20 }]), { wall: 1, piece: 2 });
    assert.equal(polylineCrossesWall(walls, [{ x: 0, y: 0 }]), null);
  });
});

// ---------- polyline helpers ----------

describe('polylineLength and pointAlong', () => {
  const pts = [{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 10 }];

  test('length sums the pieces', () => {
    assert.equal(polylineLength(pts), 11);
    assert.equal(polylineLength([{ x: 1, y: 1 }]), 0);
    assert.equal(polylineLength([]), 0);
  });

  test('pointAlong walks the pieces and clamps d to [0, length]', () => {
    assert.deepEqual(pointAlong(pts, 0), { x: 0, y: 0 });
    assert.deepEqual(pointAlong(pts, 2.5), { x: 1.5, y: 2 });
    assert.deepEqual(pointAlong(pts, 5), { x: 3, y: 4 });
    assert.deepEqual(pointAlong(pts, 8), { x: 3, y: 7 });
    assert.deepEqual(pointAlong(pts, 11), { x: 3, y: 10 });
    assert.deepEqual(pointAlong(pts, 50), { x: 3, y: 10 });
    assert.deepEqual(pointAlong(pts, -4), { x: 0, y: 0 });
    assert.deepEqual(pointAlong([{ x: 2, y: 2 }], 3), { x: 2, y: 2 });
    assert.deepEqual(pointAlong([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 4, y: 5 }], 2.5), { x: 2.5, y: 3 });
    assert.equal(pointAlong([], 1), null);
  });
});

// ---------- navigation ----------

describe('createNav paths', () => {
  test('no walls: always the straight line, never blocked', () => {
    const nav = createNav([]);
    assert.equal(nav.blocked(0, 0, 100, 100), false);
    const p = nav.path(10, 20, 80, 90);
    assert.deepEqual(p.points, [{ x: 10, y: 20 }, { x: 80, y: 90 }]);
    close(p.length, Math.hypot(70, 70), 1e-12);
    assert.equal(nav.distance(0, 0, 3, 4), 5);
  });

  test('straight line when clear, with walls elsewhere', () => {
    const walls = [seg(50, 30, 50, 70)];
    const nav = createNav(walls);
    const p = nav.path(10, 10, 90, 20);
    assert.deepEqual(p.points, [{ x: 10, y: 10 }, { x: 90, y: 20 }]);
    assert.equal(nav.blocked(10, 10, 90, 20), false);
    assert.equal(nav.blocked(40, 50, 60, 50), true);
  });

  test('detour around a single wall has the expected length', () => {
    const walls = [seg(50, 30, 50, 70)];
    const nav = createNav(walls, { clearance: 0.2 });
    const p = nav.path(40, 50, 60, 50);
    assertPathShape(p, 40, 50, 60, 50);
    assertWallFree(walls, p.points);
    // Around either end, keeping 0.2 from it: between 2 x hypot(10, 20) and 2 x hypot(10, 20.2).
    assertDetour(p, 2 * Math.hypot(10, 20), 2 * Math.hypot(10, 20.2));
    assertBendsAt(p, [[50, 70], [50, 30]], 0.2);
    assert.ok(p.points.length >= 3);
    assert.equal(nav.distance(40, 50, 60, 50), p.length);
  });

  test('goes through a doorway 0.5 wide with clearance 0.2', () => {
    const walls = [seg(0, 50, 49.75, 50), seg(50.25, 50, 100, 50)];
    const nav = createNav(walls, { clearance: 0.2 });
    const p = nav.path(20, 40, 20, 60);
    assert.ok(p, 'a path exists');
    assertPathShape(p, 20, 40, 20, 60);
    assertWallFree(walls, p.points);
    const ys = crossingsAtY(p.points, 50);
    assert.ok(ys.length >= 1 && ys.every(x => x > 49.75 && x < 50.25), `crosses y=50 inside the door, got ${ys}`);
    assert.ok(p.length <= 1.02 * 2 * Math.hypot(29.75, 10), 'within 2% of the touching limit');
  });

  test('finds a gap of exactly 2.5 x clearance at any scale and angle', () => {
    for (const [c, angle] of [[0.02, 0], [0.02, 0.7], [0.2, 2.1], [1, 0.3]]) {
      // A long wall through (50, 50) at the given angle, with a gap of 2.5c centered there.
      const ux = Math.cos(angle), uy = Math.sin(angle), half = 1.25 * c;
      const walls = [
        seg(50 - 45 * ux, 50 - 45 * uy, 50 - half * ux, 50 - half * uy),
        seg(50 + half * ux, 50 + half * uy, 50 + 45 * ux, 50 + 45 * uy)
      ];
      const nav = createNav(walls, { clearance: c });
      // Start and end on opposite sides, offset along the wall so the straight line is blocked.
      const nx = -uy, ny = ux;
      const s = [50 + 20 * ux + 5 * nx, 50 + 20 * uy + 5 * ny], e = [50 + 20 * ux - 5 * nx, 50 + 20 * uy - 5 * ny];
      assert.equal(nav.blocked(...s, ...e), true);
      const p = nav.path(...s, ...e);
      assert.ok(p, `gap 2.5c found for c=${c}, angle=${angle}`);
      assertWallFree(walls, p.points, `c=${c}`);
      assert.ok(p.length < 2 * Math.hypot(20, 5) + 4 * c, `goes through the gap, not around (c=${c})`);
    }
  });

  test('a sealed room is unreachable from outside and reachable inside', () => {
    const walls = box(40, 40, 60, 60);
    const nav = createNav(walls);
    assert.equal(nav.path(50, 50, 80, 80), null);
    assert.equal(nav.path(80, 80, 50, 50), null);
    assert.equal(nav.distance(50, 50, 80, 80), Infinity);
    assert.deepEqual(nav.path(45, 45, 55, 52).points, [{ x: 45, y: 45 }, { x: 55, y: 52 }]);
    const out = nav.path(30, 50, 70, 50);
    assertWallFree(walls, out.points);
  });

  test('two-room floor: the path goes through the door', () => {
    const walls = [...box(10, 10, 90, 90), seg(50, 10, 50, 60), seg(50, 62, 50, 90)];
    const nav = createNav(walls, { clearance: 0.2 });
    const p = nav.path(30, 20, 70, 20);
    assertPathShape(p, 30, 20, 70, 20);
    assertWallFree(walls, p.points);
    const ys = crossingsAtX(p.points, 50);
    assert.ok(ys.length === 1 && ys[0] > 60 && ys[0] < 62, `crosses the divider in the door, got ${ys}`);
    assertDetour(p, 2 * Math.hypot(20, 40), 2 * Math.hypot(20, 40.2));
    assertBendsAt(p, [[50, 60]], 0.2);
  });

  test('two doors in one straight wall: the path runs alongside the wall between them', () => {
    // Rooms below y = 50 open through doors at x in (20, 22) and (78, 80) into a hall above.
    const walls = [seg(0, 50, 20, 50), seg(22, 50, 78, 50), seg(80, 50, 100, 50), seg(50, 0, 50, 50)];
    const nav = createNav(walls, { clearance: 0.2 });
    const p = nav.path(30, 45, 70, 45);
    assertWallFree(walls, p.points);
    // Up through one door, along the wall, down through the other: barely longer than the touching limit.
    const limit = Math.hypot(8, 5) + 56 + Math.hypot(8, 5);
    assert.ok(p.length <= limit * 1.02, `near-shortest along the wall: ${p.length} vs ${limit}`);
  });

  test('turning back around a wall end keeps its distance from the end', () => {
    const walls = [seg(50, 20, 50, 70)];
    for (const c of [0.2, 1]) {
      const nav = createNav(walls, { clearance: c });
      const p = nav.path(50 - c, 70 - 2 * c, 50 + c, 70 - 2 * c);
      assertWallFree(walls, p.points);
      assertBendsAt(p, [[50, 70]], c);
      for (let i = 0; i + 1 < p.points.length; i++) {
        const a = p.points[i], b = p.points[i + 1];
        const t = Math.max(0, Math.min(1, ((50 - a.x) * (b.x - a.x) + (70 - a.y) * (b.y - a.y)) / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2)));
        const d = Math.hypot(a.x + t * (b.x - a.x) - 50, a.y + t * (b.y - a.y) - 70);
        assert.ok(d >= 0.1 * c - 1e-9, `piece ${i} passes ${d} from the wall end (c=${c})`);
      }
    }
  });

  test('corners and T-junctions cannot be squeezed through', () => {
    const L = [seg(40, 40, 60, 40), seg(60, 40, 60, 60)];
    const navL = createNav(L);
    assert.equal(navL.blocked(55, 35, 65, 45), true, 'straight through the shared corner');
    const p = navL.path(55, 45, 65, 35);
    assertWallFree(L, p.points);
    // Around a free end, (40, 40) or (60, 60), never through the corner at (60, 40).
    assertDetour(p, Math.hypot(5, 15) + Math.hypot(5, 25), Math.hypot(5, 15.2) + Math.hypot(5, 25.2));
    assertBendsAt(p, [[40, 40], [60, 60]], 0.2);

    const T = [seg(30, 50, 70, 50), seg(50, 50, 50, 80)];
    const navT = createNav(T);
    assert.equal(navT.blocked(49, 49, 51, 51), true, 'through the junction');
    const q = navT.path(45, 60, 55, 60);
    assertWallFree(T, q.points);
    // Over the top of the stem, never through the junction at (50, 50).
    assertDetour(q, 2 * Math.hypot(5, 20), 2 * Math.hypot(5, 20.2));
    assertBendsAt(q, [[50, 80]], 0.2);
  });

  test('collinear, overlapping and duplicate walls act as one wall', () => {
    const walls = [seg(20, 50, 60, 50), seg(40, 50, 80, 50), seg(20, 50, 60, 50), seg(60, 50, 20, 50)];
    const nav = createNav(walls, { clearance: 0.2 });
    for (const x of [40, 60]) assert.equal(nav.blocked(x, 45, x, 55), true, `no gap where pieces overlap at x=${x}`);
    const p = nav.path(50, 40, 50, 60);
    assertWallFree(walls, p.points);
    // Around an outer end, (20, 50) or (80, 50); the overlap points add no waypoints.
    assertDetour(p, 2 * Math.hypot(30, 10), 2 * Math.hypot(30.2, 10));
    assertBendsAt(p, [[20, 50], [80, 50]], 0.2);
  });

  test('start or end closer to a wall than the clearance still works', () => {
    const walls = [seg(50, 20, 50, 80)];
    const nav = createNav(walls, { clearance: 0.5 });
    const p = nav.path(49.95, 50, 50.05, 50);
    assertPathShape(p, 49.95, 50, 50.05, 50);
    assertWallFree(walls, p.points);
    // Just past a wall end: a straight line is fine.
    assert.equal(nav.path(49.9, 80.05, 50.1, 80.05).points.length, 2);
  });

  test('start equal to end gives a zero-length path; a point on a wall gives null', () => {
    const walls = box(40, 40, 60, 60);
    const nav = createNav(walls);
    assert.deepEqual(nav.path(30, 30, 30, 30), { length: 0, points: [{ x: 30, y: 30 }, { x: 30, y: 30 }] });
    assert.equal(nav.path(50, 40, 50, 40), null);
    assert.equal(nav.path(50, 40, 80, 80), null, 'start on a wall');
  });

  test('a gap between a wall end and the map edge is used; waypoints never leave the map', () => {
    const c = 0.1;
    const walls = [...box(0, 0, 100, 100), seg(0.3, 50, 100, 50)];
    const nav = createNav(walls, { clearance: c });
    const p = nav.path(50, 40, 50, 60);
    assert.ok(p, 'the 0.3 gap at the map edge is 3 x clearance');
    assertWallFree(walls, p.points);
    for (const q of p.points) assert.ok(q.x >= 0 && q.x <= 100 && q.y >= 0 && q.y <= 100);
    const sealed = createNav([...box(0, 0, 100, 100), seg(0, 50, 100, 50)], { clearance: c });
    assert.equal(sealed.path(50, 40, 50, 60), null);
  });

  test('no waypoints inside a wall-to-wall gap narrower than the clearance', () => {
    // A stub ending 0.1 above a long wall: the path goes over the stub, not through the slot.
    const walls = [seg(20, 50, 80, 50), seg(50, 50.1, 50, 70)];
    const nav = createNav(walls, { clearance: 0.2 });
    const p = nav.path(40, 55, 60, 55);
    assertWallFree(walls, p.points);
    const ys = crossingsAtX(p.points, 50);
    assert.ok(ys.length === 1 && ys[0] > 70, `passes over the stub, got ${ys}`);
  });

  test('exact endpoints are kept when the cache key (rounded to 1e-3) is shared', () => {
    const walls = [seg(50, 30, 50, 70)];
    const nav = createNav(walls);
    const a = nav.path(40, 50, 60, 50), b = nav.path(40.0003, 50.0002, 60, 49.9998);
    assertPathShape(a, 40, 50, 60, 50);
    assertPathShape(b, 40.0003, 50.0002, 60, 49.9998);
    assertWallFree(walls, b.points);
    close(a.length, b.length, 2e-3);
    b.points[1].x = -1;   // callers get their own copies
    assert.notEqual(nav.path(40.0003, 50.0002, 60, 49.9998).points[1].x, -1);
  });

  test('rejects non-finite coordinates', () => {
    const nav = createNav([seg(50, 30, 50, 70)]);
    assert.throws(() => nav.path(NaN, 0, 1, 1), TypeError);
    assert.throws(() => nav.blocked(0, 0, Infinity, 1), TypeError);
  });

  test('deterministic: same walls and endpoints give identical paths in any call order', () => {
    const walls = floorPlan(5, 2, mulberry32(11), 80);
    const rng = mulberry32(12);
    const pairs = Array.from({ length: 40 }, () => [rng() * 90 + 5, rng() * 90 + 5, rng() * 90 + 5, rng() * 90 + 5]);
    const navA = createNav(walls), navB = createNav(walls);
    const a = pairs.map(q => navA.path(...q));
    const b = pairs.slice().reverse().map(q => navB.path(...q)).reverse();
    assert.deepEqual(a, b);
    assert.deepEqual(pairs.map(q => navA.path(...q)), a, 'cached results match');
  });

  test('nav.blocked agrees with crossesWall over the walls and the sealed cracks', () => {
    const rng = mulberry32(5);
    const walls = normalizeWalls(Array.from({ length: 120 }, () => {
      const x = rng() * 100, y = rng() * 100, a = rng() * Math.PI * 2, len = 2 + rng() * 20;
      return [x, y, x + Math.cos(a) * len, y + Math.sin(a) * len];
    })).walls;
    const nav = createNav(walls);
    const seals = nav.seals;
    assert.ok(seals.length > 0, 'random walls leave some cracks narrower than 2 x clearance');
    for (let i = 0; i < 3000; i++) {
      const w = walls[Math.floor(rng() * walls.length)];
      const onEnd = i % 3 === 0;
      const x1 = onEnd ? w.x1 : rng() * 100, y1 = onEnd ? w.y1 : rng() * 100;
      const x2 = rng() * 100, y2 = rng() * 100;
      assert.equal(nav.blocked(x1, y1, x2, y2), crossesWall(walls, x1, y1, x2, y2) >= 0 || crossesWall(seals, x1, y1, x2, y2) >= 0);
    }
  });
});

// ---------- cracks (found by an independent fuzz: paths went through hairline gaps) ----------

// Independent of engine/walls.js: from every wall end to the nearest point of each other wall closer
// than 2c (not touching), and to the map edge when closer than 2c. A path must cross none of these.
function crackConnectors(walls, c) {
  const lim = 2 * c * (1 - 1e-6), out = [];
  const near = (px, py, w) => {
    const vx = w.x2 - w.x1, vy = w.y2 - w.y1, L = vx * vx + vy * vy;
    const u = Math.max(0, Math.min(1, ((px - w.x1) * vx + (py - w.y1) * vy) / L));
    return { x: w.x1 + u * vx, y: w.y1 + u * vy };
  };
  for (const w of walls) {
    for (const [px, py] of [[w.x1, w.y1], [w.x2, w.y2]]) {
      for (const o of walls) {
        const q = near(px, py, o), d = Math.hypot(q.x - px, q.y - py);
        if (d > 1e-9 && d < lim) out.push(seg(px, py, q.x, q.y));
      }
      if (px > 1e-9 && px < lim) out.push(seg(px, py, 0, py));
      if (100 - px > 1e-9 && 100 - px < lim) out.push(seg(px, py, 100, py));
      if (py > 1e-9 && py < lim) out.push(seg(px, py, px, 0));
      if (100 - py > 1e-9 && 100 - py < lim) out.push(seg(px, py, px, 100));
    }
  }
  return out;
}

describe('cracks narrower than 2 x clearance are sealed', () => {
  // A 20 x 20 room at (40, 40) with no door, its walls broken by one crack.
  const rooms = {
    'collinear crack 1e-6': [seg(40, 40, 50, 40), seg(50 + 1e-6, 40, 60, 40), seg(60, 40, 60, 60), seg(60, 60, 40, 60), seg(40, 60, 40, 40)],
    'collinear crack 1e-3': [seg(40, 40, 50, 40), seg(50.001, 40, 60, 40), seg(60, 40, 60, 60), seg(60, 60, 40, 60), seg(40, 60, 40, 40)],
    'corner crack 0.05': [seg(40, 40, 59.95, 40), seg(60, 40, 60, 60), seg(60, 60, 40, 60), seg(40, 60, 40, 40)],
    // The right wall stops 0.1 above the bottom wall, which runs on past it.
    'T crack 0.1': [seg(40, 40, 62, 40), seg(60, 40.1, 60, 60), seg(60, 60, 40, 60), seg(40, 60, 40, 40)]
  };

  test('a room closed except for a crack keeps everyone in (the original walked straight through 1e-6)', () => {
    for (const [name, walls] of Object.entries(rooms)) {
      const nav = createNav(walls, { clearance: 0.2 });
      for (const [x, y] of [[50.5, 41], [45, 41], [55, 41], [59, 41], [50, 50]]) {
        assert.equal(nav.path(x, y, 50.5, 30), null, `${name}: (${x}, ${y}) inside to outside`);
        assert.equal(nav.path(50.5, 30, x, y), null, `${name}: outside to (${x}, ${y}) inside`);
      }
      assert.ok(nav.seals.length >= 1, `${name}: the crack is listed in nav.seals`);
      assert.ok(nav.path(45, 45, 55, 55), `${name}: moving around inside still works`);
    }
    // The straight segment through the 1e-6 crack touches no wall, yet it is blocked.
    const walls = rooms['collinear crack 1e-6'];
    const nav = createNav(walls, { clearance: 0.2 });
    assert.equal(crossesWall(walls, 50 + 5e-7, 39, 50 + 5e-7, 41), -1);
    assert.equal(nav.blocked(50 + 5e-7, 39, 50 + 5e-7, 41), true);
  });

  test('the cavity between the two faces of a thick wall cannot be walked through or into', () => {
    // Faces at y = 50 and y = 50.3 (thinner than 2 x clearance), doors cut through both, no jambs.
    const misaligned = [seg(0, 50, 20, 50), seg(22, 50, 100, 50), seg(0, 50.3, 78, 50.3), seg(80, 50.3, 100, 50.3)];
    const aligned = [seg(0, 50, 40, 50), seg(42, 50, 100, 50), seg(0, 50.3, 40, 50.3), seg(42, 50.3, 100, 50.3)];
    // With the doors on different sides, the only way across was along the cavity.
    assert.equal(createNav(misaligned, { clearance: 0.2 }).path(21, 45, 79, 55), null);
    const nav = createNav(aligned, { clearance: 0.2 });
    const p = nav.path(21, 45, 79, 55);
    assertWallFree(aligned, p.points);
    // Wherever the path is within the wall's thickness, it is in the doorway.
    for (let d = 0; d <= p.length; d += 0.01) {
      const q = pointAlong(p.points, d);
      if (q.y >= 50 && q.y <= 50.3) assert.ok(q.x > 40 && q.x < 42, `inside the wall at (${q.x}, ${q.y})`);
    }
    assert.equal(nav.path(70, 50.15, 70, 45), null, 'a point inside the cavity is sealed in');
  });

  test('a gap of exactly 2 x clearance stays open despite rounding; just under it is sealed', () => {
    // 8.2 - 8 is 0.19999999999999929 in floating point.
    const open = createNav([seg(0, 50, 8, 50), seg(8.2, 50, 100, 50)], { clearance: 0.1 });
    assert.equal(open.seals.length, 0);
    assert.ok(open.path(8.1, 45, 8.1, 55));
    const shut = createNav([seg(0, 50, 8, 50), seg(8.199, 50, 100, 50)], { clearance: 0.1 });
    assert.equal(shut.seals.length, 1);
    assert.equal(shut.path(8.1, 45, 8.1, 55), null);
  });

  test('a gap between a wall end and the map edge narrower than 2 x clearance is sealed', () => {
    const walls = [seg(0.15, 50, 100, 50)];
    const nav = createNav(walls, { clearance: 0.1 });
    assert.deepEqual(nav.seals, [seg(0.15, 50, 0, 50)]);
    assert.equal(nav.path(0.05, 45, 0.05, 55), null);
    assert.ok(createNav([seg(0.25, 50, 100, 50)], { clearance: 0.1 }).path(0.05, 45, 0.05, 55), '0.25 is wider than 2c');
  });

  test('property: no path goes through a crack narrower than 2c (independent connectors)', () => {
    let paths = 0, checked = 0;
    for (let layout = 0; layout < 15; layout++) {
      const rng = mulberry32(700 + layout);
      const c = [0.05, 0.2, 0.5][layout % 3];
      // Rooms whose walls stop short of each other by cracks of 1e-8 to 1.5c, plus random walls.
      const raw = [];
      for (let r = 0; r < 6; r++) {
        const x0 = 5 + rng() * 70, y0 = 5 + rng() * 70, s = 6 + rng() * 15;
        const gap = () => [1e-8, 1e-5, 0.01, c * 0.5, c * 1.5][Math.floor(rng() * 5)];
        raw.push([x0, y0, x0 + s - gap(), y0], [x0 + s, y0 + gap(), x0 + s, y0 + s], [x0 + s - gap(), y0 + s, x0, y0 + s], [x0, y0 + s, x0, y0 + gap()]);
      }
      for (let i = 0; i < 30; i++) {
        const x = rng() * 100, y = rng() * 100, a = rng() * Math.PI * 2, len = 1 + rng() * 15;
        raw.push([x, y, x + Math.cos(a) * len, y + Math.sin(a) * len]);
      }
      const walls = normalizeWalls(raw).walls;
      const cracks = crackConnectors(walls, c);
      const nav = createNav(walls, { clearance: c });
      for (let k = 0; k < 30; k++) {
        const x1 = rng() * 100, y1 = rng() * 100, x2 = rng() * 100, y2 = rng() * 100;
        const p = nav.path(x1, y1, x2, y2);
        if (!p) continue;
        paths++;
        assertWallFree(walls, p.points, `layout ${layout} pair ${k}`);
        assertWallFree(cracks, p.points, `layout ${layout} pair ${k} (crack)`);
        checked += cracks.length;
      }
    }
    assert.ok(paths > 150 && checked > 0, `coverage: ${paths} paths`);
  });
});

// ---------- property test ----------

test('property: 30 random layouts x 20 point pairs, every path is wall-free (independent check)', () => {
  let paths = 0, detours = 0, unreachable = 0;
  for (let layout = 0; layout < 30; layout++) {
    const rng = mulberry32(9000 + layout);
    const c = [0.1, 0.2, 0.5][layout % 3];
    const raw = [];
    const count = 10 + Math.floor(rng() * 40);
    for (let i = 0; i < count; i++) {
      const x = rng() * 100, y = rng() * 100, a = rng() * Math.PI * 2, len = 3 + rng() * 27;
      raw.push([x, y, x + Math.cos(a) * len, y + Math.sin(a) * len]);
    }
    // A room with a door, a T-junction and a collinear overlap, so junctions are always present.
    const x0 = 10 + rng() * 60, y0 = 10 + rng() * 60, s = 10 + rng() * 15, door = c * (2.5 + 2 * rng());
    raw.push([x0, y0, x0 + s, y0], [x0 + s, y0, x0 + s, y0 + s], [x0 + s, y0 + s, x0, y0 + s],
      [x0, y0 + s, x0, y0 + s / 2 + door / 2], [x0, y0 + s / 2 - door / 2, x0, y0],
      [x0 + s / 2, y0, x0 + s / 2, y0 + s / 3], [x0 + s, y0 + s / 2, x0 + s + 8, y0 + s / 2]);
    const walls = normalizeWalls(raw).walls;
    const nav = createNav(walls, { clearance: c });
    // Points anywhere, plus points just off wall ends where paths graze corners.
    const point = () => {
      if (rng() < 0.3) {
        const w = walls[Math.floor(rng() * walls.length)], a = rng() * Math.PI * 2, r = c * (0.2 + 2 * rng());
        return [Math.min(100, Math.max(0, w.x1 + r * Math.cos(a))), Math.min(100, Math.max(0, w.y1 + r * Math.sin(a)))];
      }
      return [rng() * 100, rng() * 100];
    };
    for (let k = 0; k < 20; k++) {
      const [x1, y1] = point(), [x2, y2] = point();
      const p = nav.path(x1, y1, x2, y2);
      if (!p) { unreachable++; continue; }
      paths++;
      assertPathShape(p, x1, y1, x2, y2);
      assertWallFree(walls, p.points, `layout ${layout} pair ${k}`);
      for (const q of p.points) assert.ok(q.x >= 0 && q.x <= 100 && q.y >= 0 && q.y <= 100, 'stays on the map');
      if (p.points.length > 2) { detours++; assert.equal(nav.blocked(x1, y1, x2, y2), true, 'detours only when blocked'); }
      else assert.equal(nav.blocked(x1, y1, x2, y2), false);
    }
  }
  assert.ok(paths > 400 && detours > 100, `enough coverage: ${paths} paths, ${detours} detours, ${unreachable} unreachable`);
});

// ---------- performance ----------

test('performance with 500 walls (loose bounds: 5x the budget)', t => {
  const walls = floorPlan(10, 1.5, mulberry32(42), 500);
  assert.equal(walls.length, 500);
  let t0 = performance.now();
  const nav = createNav(walls, { clearance: 0.2 });
  const build = performance.now() - t0;
  const rng = mulberry32(43);
  const pairs = Array.from({ length: 1000 }, () => [rng() * 90 + 5, rng() * 90 + 5, rng() * 90 + 5, rng() * 90 + 5]);
  t0 = performance.now();
  let found = 0;
  for (const q of pairs) if (nav.path(...q)) found++;
  const search = performance.now() - t0;
  t.diagnostic(`createNav ${build.toFixed(1)} ms; 1000 uncached paths ${search.toFixed(0)} ms (${found} found)`);
  assert.equal(found, 1000, 'every room is reachable');
  assert.ok(build < 2500, `createNav took ${build} ms`);
  assert.ok(search < 10000, `1000 paths took ${search} ms`);
});
