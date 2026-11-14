// builder/mesh.js tests (docs/PROTOTYPE.md §13e). Every mesh is generated in code by
// test/fixtures/mesh/room.js; the Matterport API is a mocked fetch (no network).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { parseObj, meshToWalls, fetchMeshObj, MESH_QUERY, MATTERPORT_GRAPH_ENDPOINT } from '../builder/mesh.js';
import { ORIGIN, roomObj, roomCounts, noisyRoomObj, gridObj, boxesObj } from './fixtures/mesh/room.js';

// ---------- helpers (room-local coordinates: south-west outer corner at 0, 0) ----------

const toLocal = w => ({ x1: w.x1 - ORIGIN.x, y1: w.y1 - ORIGIN.y, x2: w.x2 - ORIGIN.x, y2: w.y2 - ORIGIN.y });
const localWalls = result => result.walls.map(toLocal);
const length = w => Math.hypot(w.x2 - w.x1, w.y2 - w.y1);

// Fraction of the segment a-b covered by walls that run along it (both ends within tol of its line).
function covered(walls, ax, ay, bx, by, tol = 0.03) {
  const L = Math.hypot(bx - ax, by - ay);
  const dx = (bx - ax) / L, dy = (by - ay) / L;
  const spans = [];
  for (const w of walls) {
    const o1 = -dy * (w.x1 - ax) + dx * (w.y1 - ay), o2 = -dy * (w.x2 - ax) + dx * (w.y2 - ay);
    if (Math.abs(o1) > tol || Math.abs(o2) > tol) continue;
    const t1 = dx * (w.x1 - ax) + dy * (w.y1 - ay), t2 = dx * (w.x2 - ax) + dy * (w.y2 - ay);
    const lo = Math.max(0, Math.min(t1, t2)), hi = Math.min(L, Math.max(t1, t2));
    if (hi > lo) spans.push([lo, hi]);
  }
  spans.sort((p, q) => p[0] - q[0]);
  let total = 0, end = 0;
  for (const [lo, hi] of spans) {
    if (hi <= end) continue;
    total += hi - Math.max(lo, end);
    end = hi;
  }
  return total / L;
}

// Do segments p1-p2 and q1-q2 share any point (touching counts)?
function touches(p1x, p1y, p2x, p2y, q1x, q1y, q2x, q2y) {
  const orient = (ax, ay, bx, by, cx, cy) => {
    const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    return Math.abs(v) < 1e-12 ? 0 : Math.sign(v);
  };
  const onSeg = (ax, ay, bx, by, cx, cy) =>
    Math.min(ax, bx) - 1e-12 <= cx && cx <= Math.max(ax, bx) + 1e-12 &&
    Math.min(ay, by) - 1e-12 <= cy && cy <= Math.max(ay, by) + 1e-12;
  const o1 = orient(p1x, p1y, p2x, p2y, q1x, q1y), o2 = orient(p1x, p1y, p2x, p2y, q2x, q2y);
  const o3 = orient(q1x, q1y, q2x, q2y, p1x, p1y), o4 = orient(q1x, q1y, q2x, q2y, p2x, p2y);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSeg(p1x, p1y, p2x, p2y, q1x, q1y)) || (o2 === 0 && onSeg(p1x, p1y, p2x, p2y, q2x, q2y)) ||
    (o3 === 0 && onSeg(q1x, q1y, q2x, q2y, p1x, p1y)) || (o4 === 0 && onSeg(q1x, q1y, q2x, q2y, p2x, p2y));
}
const blocked = (walls, x1, y1, x2, y2) => walls.some(w => touches(x1, y1, x2, y2, w.x1, w.y1, w.x2, w.y2));

// Does any wall have a point inside the axis-aligned box?
function anyWallIn(walls, x0, y0, x1, y1) {
  return walls.some(w => {
    const inside = (x, y) => x > x0 && x < x1 && y > y0 && y < y1;
    if (inside(w.x1, w.y1) || inside(w.x2, w.y2)) return true;
    return blocked([w], x0, y0, x1, y0) || blocked([w], x1, y0, x1, y1) ||
      blocked([w], x1, y1, x0, y1) || blocked([w], x0, y1, x0, y0);
  });
}

// Expected wall faces of the room (local coordinates), as [ax, ay, bx, by].
const OUTER_FACES = {
  'south outer': [0, 0, 8, 0], 'south inner': [0.2, 0.2, 7.8, 0.2],
  'north outer': [0, 6, 8, 6], 'north inner': [0.2, 5.8, 7.8, 5.8],
  'west outer': [0, 0, 0, 6], 'west inner': [0.2, 0.2, 0.2, 5.8],
  'east outer': [8, 0, 8, 6], 'east inner': [7.8, 0.2, 7.8, 5.8]
};
const INTERIOR_FACES = {
  'interior west, south of door': [3.94, 0.2, 3.94, 2.5], 'interior west, north of door': [3.94, 3.4, 3.94, 5.8],
  'interior east, south of door': [4.06, 0.2, 4.06, 2.5], 'interior east, north of door': [4.06, 3.4, 4.06, 5.8]
};
const CABINET_FACES = {
  'cabinet front': [6.0, 5.1, 7.2, 5.1], 'cabinet back': [6.0, 5.7, 7.2, 5.7],
  'cabinet west side': [6.0, 5.1, 6.0, 5.7], 'cabinet east side': [7.2, 5.1, 7.2, 5.7]
};
const TABLE = [1.5, 1.0, 3.0, 2.0];
const COUNTER = [5.0, 1.0, 7.0, 1.6];

function assertFaces(walls, faces, minFraction = 0.98, tol = 0.03) {
  for (const [name, [ax, ay, bx, by]] of Object.entries(faces)) {
    const f = covered(walls, ax, ay, bx, by, tol);
    assert.ok(f >= minFraction, `${name} should be a wall (covered ${(f * 100).toFixed(1)}%)`);
  }
}

function assertDoorOpen(walls) {
  // Nothing in the doorway between the jambs, and a straight walk through it is clear.
  assert.equal(anyWallIn(walls, 3.9, 2.52, 4.1, 3.38), false, 'a wall segment lies in the door gap');
  assert.equal(blocked(walls, 3.0, 2.95, 5.0, 2.95), false, 'walking through the door is blocked');
  assert.equal(blocked(walls, 3.0, 2.6, 5.0, 3.3), false, 'walking diagonally through the door is blocked');
  // The wall either side of the door does block.
  assert.equal(blocked(walls, 3.0, 1.5, 5.0, 1.5), true, 'the interior wall south of the door leaks');
  assert.equal(blocked(walls, 3.0, 4.5, 5.0, 4.5), true, 'the interior wall north of the door leaks');
}

const ROOM_Z = roomObj({ up: 'z' });
const ROOM_Y = roomObj({ up: 'y' });

// ---------- parseObj ----------

describe('parseObj', () => {
  test('reads v and f lines in every index form, with negative indices and fan triangulation', () => {
    const text = [
      '# comment', 'mtllib x.mtl', 'o thing', 'g part', 'usemtl stone', 's 1',
      'v 0 0 0', 'v 1.5E+1 0 0', 'v 1 1e-3 0', 'v -.5 +2 0.25',
      'vt 0 0', 'vt 1 0', 'vt 1 1', 'vt 0 1', 'vn 0 0 1',
      'f 1 2 3',                         // plain
      'f 1/1 2/2 3/3 4/4',               // v/vt quad -> 2 triangles
      'f 1//1 3//1 4//1',                // v//vn
      'f 1/1/1 2/2/1 3/3/1',             // v/vt/vn
      'f -4 -3 -2 -1',                   // negative quad -> 2 triangles
      'v 2 2 2',
      'f -1 1 2 3 4',                    // pentagon (negative first) -> 3 triangles
      'l 1 2', 'p 3', 'vp 0.5', 'curv 0 1 1 2', '',
      '  v 3 3 3', '\tf 5 6 1 # trailing comment'
    ].join('\r\n');
    const { vertices, faces, warnings } = parseObj(text);
    assert.deepEqual(warnings, []);
    assert.equal(vertices.length / 3, 6);
    assert.ok(vertices instanceof Float64Array && faces instanceof Uint32Array);
    assert.deepEqual([...vertices.subarray(3, 12)], [15, 0, 0, 1, 0.001, 0, -0.5, 2, 0.25]);
    assert.deepEqual([...vertices.subarray(15, 18)], [3, 3, 3]);
    assert.equal(faces.length / 3, 1 + 2 + 1 + 1 + 2 + 3 + 1);
    assert.deepEqual([...faces], [
      0, 1, 2,
      0, 1, 2, 0, 2, 3,
      0, 2, 3,
      0, 1, 2,
      0, 1, 2, 0, 2, 3,
      4, 0, 1, 4, 1, 2, 4, 2, 3,
      4, 5, 0
    ]);
  });

  test('parses long decimals and exponents like Number() does', () => {
    const values = ['0.1', '-123.456789012345', '6.02214076e23', '1e-7', '-0.000000123456789', '42', '3.', '7E2'];
    const { vertices } = parseObj(values.map(v => `v ${v} ${v} ${v}`).join('\n'));
    values.forEach((v, i) => {
      const got = vertices[3 * i], want = Number(v);
      assert.ok(Math.abs(got - want) <= Math.abs(want) * 1e-14, `${v}: got ${got}`);
    });
  });

  test('ignores extra vertex values and drops bad faces with warnings', () => {
    const text = [
      'v 0 0 0 1', 'v 1 0 0 0.5 0.5 0.5', 'v 0 1 0', 'v nan 0 0',
      'f 1 2 3',
      'f 1 2',          // too few vertices
      'f 0 1 2',        // 0 is not a valid OBJ index
      'f 1 2 9',        // past the end of the file
      'f -9 1 2',       // relative index before the first vertex
      'f 1 2 4'         // uses the non-finite vertex
    ].join('\n');
    const { vertices, faces, warnings } = parseObj(text);
    assert.equal(vertices.length / 3, 4);
    assert.deepEqual([...faces], [0, 1, 2]);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /skipped 3 face line/);
    assert.match(warnings[1], /dropped 2 triangle/);
  });

  test('counts the generated room in both orientations, from text, CRLF text or bytes', () => {
    const want = roomCounts();
    for (const input of [ROOM_Z, ROOM_Y, roomObj({ crlf: true }), Buffer.from(ROOM_Z), new TextEncoder().encode(ROOM_Y).buffer]) {
      const { vertices, faces, warnings } = parseObj(input);
      assert.equal(vertices.length / 3, want.vertices);
      assert.equal(faces.length / 3, want.triangles);
      assert.deepEqual(warnings, []);
    }
    assert.throws(() => parseObj(42), TypeError);
  });

  test('parses a large file in one fast pass', () => {
    const text = gridObj(500);   // 251,001 vertices, 500,000 triangles, about 22 MB
    const start = performance.now();
    const { vertices, faces } = parseObj(text);
    const ms = performance.now() - start;
    assert.equal(vertices.length / 3, 501 * 501);
    assert.equal(faces.length / 3, 2 * 500 * 500);
    assert.ok(ms < 5000, `parse took ${ms.toFixed(0)} ms`);
  });
});

// ---------- meshToWalls on the clean room ----------

describe('meshToWalls on the generated room', () => {
  const result = meshToWalls(ROOM_Z);
  const walls = localWalls(result);

  test('detects z as up and the floor at its height, and reports the cut levels', () => {
    assert.equal(result.up, 'z');
    assert.ok(Math.abs(result.floorHeight - ORIGIN.z) < 1e-6, `floor ${result.floorHeight}`);
    assert.deepEqual(result.levels, [1.35, 1.85]);
    assert.equal(result.units, 'm');
    assert.equal(result.source, 'mesh-slice');
  });

  test('finds every outer wall face (thick walls give two parallel lines)', () => {
    assertFaces(walls, OUTER_FACES);
  });

  test('finds both faces of the interior wall', () => {
    assertFaces(walls, INTERIOR_FACES);
  });

  test('leaves the door gap open even though a lintel spans it above 2.1 m', () => {
    assertDoorOpen(walls);
    assert.ok(covered(walls, 3.94, 2.5, 3.94, 3.4) < 0.01);
    assert.ok(covered(walls, 4.06, 2.5, 4.06, 3.4) < 0.01);
  });

  test('drops the table (below every cut) and the counter (cut at 1.0 m only)', () => {
    assert.equal(anyWallIn(walls, TABLE[0] - 0.05, TABLE[1] - 0.05, TABLE[2] + 0.05, TABLE[3] + 0.05), false);
    assert.equal(anyWallIn(walls, COUNTER[0] - 0.05, COUNTER[1] - 0.05, COUNTER[2] + 0.05, COUNTER[3] + 0.05), false);
  });

  test('keeps the 1.9 m cabinet as a false wall, as documented', () => {
    assertFaces(walls, CABINET_FACES);
    assert.ok(result.warnings.some(w => /human check/.test(w) && /false walls/.test(w)));
  });

  test('returns merged, labeled, rounded segments in model coordinates with bounds', () => {
    assert.equal(result.walls.length, 16);   // 8 outer faces + 4 interior pieces + 4 cabinet sides
    for (const w of result.walls) {
      assert.deepEqual(Object.keys(w), ['x1', 'y1', 'x2', 'y2', 'source']);
      assert.equal(w.source, 'mesh-slice');
      assert.ok(length(w) >= 0.3);
      for (const v of [w.x1, w.y1, w.x2, w.y2]) assert.equal(v, Math.round(v * 1000) / 1000);
    }
    // Ends that meet another wall's side are pushed 1 cm through it (robust to later rounding), so
    // the inner faces poke 1 cm past the outer corners.
    const want = { minX: 10, minY: 20, maxX: 18, maxY: 26 };
    for (const k of Object.keys(want)) assert.ok(Math.abs(result.bounds[k] - want[k]) <= 0.0101, `bounds.${k} ${result.bounds[k]}`);
  });

  test('closes the corners: every wall end meets another wall except at the door jambs', () => {
    // "Meets" = shares the end point, or crosses another wall within 2 cm of the end (an end that
    // met a wall's side was pushed 1 cm through it).
    for (const w of walls) {
      const L = length(w);
      for (const [x, y, ox, oy] of [[w.x1, w.y1, w.x2, w.y2], [w.x2, w.y2, w.x1, w.y1]]) {
        const jamb = Math.abs(x - 4) < 0.1 && (Math.abs(y - 2.5) < 1e-6 || Math.abs(y - 3.4) < 1e-6);
        if (jamb) continue;
        const bx = x + (ox - x) * 0.02 / L, by = y + (oy - y) * 0.02 / L;
        const meets = walls.some(o => o !== w && touches(x, y, bx, by, o.x1, o.y1, o.x2, o.y2));
        assert.ok(meets, `free wall end at (${x.toFixed(3)}, ${y.toFixed(3)})`);
      }
    }
  });

  test('accepts parseObj output directly and gives the same walls', () => {
    assert.deepEqual(meshToWalls(parseObj(ROOM_Z)).walls, result.walls);
  });
});

// ---------- up axis ----------

describe('meshToWalls up axis', () => {
  test('auto-detects y on a Y-up copy and gives the same plan', () => {
    const zUp = meshToWalls(ROOM_Z), yUp = meshToWalls(ROOM_Y);
    assert.equal(zUp.up, 'z');
    assert.equal(yUp.up, 'y');
    assert.ok(Math.abs(yUp.floorHeight - ORIGIN.z) < 1e-6);
    // Y-up plan coordinates are (x, -z), so the copy maps back onto the Z-up plan exactly.
    assert.deepEqual(yUp.walls, zUp.walls);
    assert.deepEqual(yUp.bounds, zUp.bounds);
    assert.ok(!yUp.warnings.some(w => /up axis/.test(w)));
  });

  test('auto-detects the up axis on the noisy scan-like mesh too', () => {
    assert.equal(meshToWalls(noisyRoomObj()).up, 'z');
  });

  test('a close call falls back to z (as Matterport documents) with a warning', () => {
    // Thick double-faced walls round a small floor with no ceiling: the wall area facing y nearly
    // matches the floor area per meter, which is the case the heuristic cannot settle.
    const lShape = boxesObj([[0, 0, 0, 4, 0.2, 2.7], [4.03, -0.1, 0, 4.23, 4, 2.7], [0, 3.8, 0, 4.03, 4, 2.7]]);
    const result = meshToWalls(lShape);
    assert.equal(result.up, 'z');
    assert.ok(result.warnings.some(w => /could not tell the up axis for sure/.test(w)));
    assert.ok(!meshToWalls(ROOM_Z).warnings.some(w => /up axis/.test(w)));
  });

  test('the up option overrides detection', () => {
    assert.deepEqual(meshToWalls(ROOM_Z, { up: 'z' }).walls, meshToWalls(ROOM_Z).walls);
    const forced = meshToWalls(ROOM_Z, { up: 'y' });
    assert.equal(forced.up, 'y');
    assert.notDeepEqual(forced.walls, meshToWalls(ROOM_Z).walls);
    assert.throws(() => meshToWalls(ROOM_Z, { up: 'x' }), RangeError);
  });
});

// ---------- options ----------

describe('meshToWalls options', () => {
  test('minLength drops short pieces after merging', () => {
    const short = localWalls(meshToWalls(ROOM_Z, { minLength: 0.1 }));
    // The 0.12 m door jamb faces survive only with the lower minLength.
    assert.ok(covered(short, 3.94, 2.5, 4.06, 2.5) > 0.98, 'jamb face missing at minLength 0.1');
    const normal = localWalls(meshToWalls(ROOM_Z));
    assert.ok(covered(normal, 3.94, 2.5, 4.06, 2.5) < 0.01, 'jamb face kept at minLength 0.3');

    const long = meshToWalls(ROOM_Z, { minLength: 0.7 });
    const longWalls = localWalls(long);
    for (const w of long.walls) assert.ok(length(w) >= 0.7);
    assertFaces(longWalls, { ...OUTER_FACES, ...INTERIOR_FACES, 'cabinet front': CABINET_FACES['cabinet front'] });
    assert.ok(covered(longWalls, 6.0, 5.1, 6.0, 5.7) < 0.01, 'the 0.6 m cabinet side should be dropped');
  });

  test('a cut must appear at every slice height', () => {
    const lintelOnly = localWalls(meshToWalls(ROOM_Z, { sliceHeights: [2.3] }));
    assert.ok(covered(lintelOnly, 3.94, 2.5, 3.94, 3.4) > 0.98, 'a cut through the lintel should close the door');
    assert.ok(covered(lintelOnly, 6.0, 5.1, 7.2, 5.1) < 0.01, 'the cabinet is below 2.3 m');

    const both = localWalls(meshToWalls(ROOM_Z, { sliceHeights: [1.0, 2.3] }));
    assertDoorOpen(both);
    assertFaces(both, { ...OUTER_FACES, ...INTERIOR_FACES });

    const lowOnly = localWalls(meshToWalls(ROOM_Z, { sliceHeights: [1.0] }));
    assert.ok(covered(lowOnly, 5.0, 1.0, 7.0, 1.0) > 0.98, 'a single cut at 1.0 m keeps the counter');
  });

  test('floorHeight overrides detection', () => {
    const same = meshToWalls(ROOM_Z, { floorHeight: ORIGIN.z });
    assert.deepEqual(same.walls, meshToWalls(ROOM_Z).walls);
    // Raising the floor by 0.5 m cuts at 1.5 m and 2.0 m above the real floor: the cabinet top
    // (1.9 m) is now below one cut, so it disappears, and the door is still open.
    const raised = meshToWalls(ROOM_Z, { floorHeight: ORIGIN.z + 0.5 });
    assert.deepEqual(raised.levels, [1.85, 2.35]);
    const walls = localWalls(raised);
    assert.equal(anyWallIn(walls, 5.9, 5.0, 7.3, 5.75), false, 'cabinet should be gone');
    assertDoorOpen(walls);
  });

  test('mergeTolerance decides whether nearby cuts count as the same wall', () => {
    // With a tolerance wider than the 0.12 m interior wall, its two faces merge into one line.
    const wide = meshToWalls(ROOM_Z, { mergeTolerance: 0.15 });
    const interior = localWalls(wide).filter(w => w.x1 > 3.8 && w.x1 < 4.2 && w.x2 > 3.8 && w.x2 < 4.2 && length(w) > 1);
    assert.equal(interior.length, 2, 'one line south and one north of the door');
    assertDoorOpen(localWalls(wide));
  });

  test('snapTolerance closes a crack where a wall stops just short of another', () => {
    // An L of two walls that miss each other by 3 cm at the corner (as noisy scans do), plus a
    // north wall. The east wall reaches 0.1 m further south, so no face is collinear across the
    // crack and only snapping can close it.
    const obj = boxesObj([
      [0, 0, 0, 4, 0.2, 2.7],          // south wall, ends at x = 4.00
      [4.03, -0.1, 0, 4.23, 4, 2.7],   // east wall, starts at x = 4.03
      [0, 3.8, 0, 4.03, 4, 2.7]        // north wall
    ]);
    const through = walls => blocked(walls, 4.015, 2, 4.015, -2);   // straight down through the crack
    const snapped = meshToWalls(obj, { up: 'z' });
    assert.equal(through(snapped.walls), true, 'the 3 cm crack should be closed');
    const unsnapped = meshToWalls(obj, { up: 'z', snapTolerance: 0 });
    assert.equal(through(unsnapped.walls), false, 'without snapping the crack stays open');
    // Snapping never bridges a real opening: the room's 0.9 m door is still open after it.
    assertDoorOpen(localWalls(meshToWalls(ROOM_Z, { snapTolerance: 0.3 })));
  });

  test('rejects bad options and handles an empty mesh', () => {
    assert.throws(() => meshToWalls(ROOM_Z, { sliceHeights: [] }), RangeError);
    assert.throws(() => meshToWalls(ROOM_Z, { sliceHeights: [1, 'x'] }), RangeError);
    assert.throws(() => meshToWalls(ROOM_Z, { sliceHeights: Array.from({ length: 17 }, (_, i) => 0.5 + i * 0.1) }), RangeError);
    assert.equal(meshToWalls(ROOM_Z, { sliceHeights: Array.from({ length: 16 }, (_, i) => 0.9 + i * 0.05) }).walls.length > 0, true);
    assert.throws(() => meshToWalls(ROOM_Z, { mergeTolerance: 0 }), RangeError);
    assert.throws(() => meshToWalls(ROOM_Z, { minLength: -1 }), RangeError);
    assert.throws(() => meshToWalls(ROOM_Z, { floorHeight: 'low' }), RangeError);
    const empty = meshToWalls('# nothing here\nv 0 0 0\n');
    assert.deepEqual(empty.walls, []);
    assert.equal(empty.bounds, null);
    assert.ok(empty.warnings.some(w => /no faces/.test(w)));
  });
});

// ---------- scan-like noise ----------

describe('meshToWalls on a noisy, finely triangulated room', () => {
  const result = meshToWalls(noisyRoomObj({ cell: 0.1, noise: 0.015 }));
  const walls = localWalls(result);

  test('finds the walls and the floor despite 1.5 cm of surface noise', () => {
    assert.ok(Math.abs(result.floorHeight - ORIGIN.z) < 0.02);
    assertFaces(walls, { ...OUTER_FACES, ...INTERIOR_FACES }, 0.95, 0.05);
  });

  test('keeps the door open and drops the table and counter', () => {
    assertDoorOpen(walls);
    assert.equal(anyWallIn(walls, TABLE[0], TABLE[1], TABLE[2], TABLE[3]), false);
    assert.equal(anyWallIn(walls, COUNTER[0], COUNTER[1], COUNTER[2], COUNTER[3]), false);
  });

  const assertSealed = (ws, label) => {
    for (const [cx, cy] of [[2, 4], [6, 3], [1, 1], [7, 5.5]]) {
      for (let k = 0; k < 3600; k++) {
        const a = (k / 3600) * 2 * Math.PI;
        const hit = blocked(ws, cx, cy, cx + 30 * Math.cos(a), cy + 30 * Math.sin(a));
        assert.ok(hit, `${label}: ray from (${cx}, ${cy}) at ${(a * 180 / Math.PI).toFixed(1)} degrees escapes`);
      }
    }
  };

  test('the outer shell has no cracks: every ray from inside the room hits a wall', () => {
    assertSealed(walls, 'as built');
  });

  test('junctions survive later rounding of the coordinates to whole centimeters', () => {
    const r2 = v => Math.round(v * 100) / 100;
    assertSealed(walls.map(w => ({ x1: r2(w.x1), y1: r2(w.y1), x2: r2(w.x2), y2: r2(w.y2) })), 'rounded');
  });
});

// ---------- Matterport Model API (mocked) ----------

const TOKEN_ID = 'test-token-id';
const TOKEN_SECRET = 'test-token-secret-do-not-leak';
const OBJ_URL = 'https://cdn.example.test/signed/model.obj?sig=abc';

function graphResponse(meshes, extra = {}) {
  return new Response(JSON.stringify({ data: { model: { id: 'm1', assets: { meshes } } }, ...extra }), {
    status: 200, headers: { 'content-type': 'application/json' }
  });
}

function mockFetch(responses) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return typeof next === 'function' ? next(url, init) : next;
  };
  return { fn, calls };
}

// A minimal zip archive: a stored .mtl and a deflated .obj (CRCs are not checked by the reader).
function makeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data, deflate } of entries) {
    const nameBytes = Buffer.from(name);
    const body = deflate ? deflateRawSync(data) : Buffer.from(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, eocd]);
}

describe('fetchMeshObj (mocked Matterport Model API)', () => {
  test('MESH_QUERY asks for the model meshes and the fields used', () => {
    assert.match(MESH_QUERY, /model\(id: \$modelId\)/);
    assert.match(MESH_QUERY, /assets\s*\{\s*meshes\s*\{/);
    for (const field of ['format', 'resolution', 'status', 'url', 'validUntil', 'filename']) {
      assert.match(MESH_QUERY, new RegExp(`\\b${field}\\b`));
    }
    assert.equal(MATTERPORT_GRAPH_ENDPOINT, 'https://api.matterport.com/api/models/graph');
  });

  test('posts the query with Basic auth, then downloads the OBJ without credentials', async () => {
    const { fn, calls } = mockFetch([
      graphResponse([
        { id: 'a', format: 'dam', resolution: 'high', status: 'available', url: 'https://cdn.example.test/x.dam' },
        { id: 'b', format: 'obj', resolution: 'low', status: 'available', url: OBJ_URL, filename: 'model.obj', validUntil: '2026-11-14T12:00:00Z' }
      ]),
      new Response(ROOM_Z, { status: 200 })
    ]);
    const out = await fetchMeshObj({ modelId: 'm1', tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET, fetch: fn });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, MATTERPORT_GRAPH_ENDPOINT);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.authorization, 'Basic ' + Buffer.from(`${TOKEN_ID}:${TOKEN_SECRET}`).toString('base64'));
    assert.deepEqual(JSON.parse(calls[0].init.body), { query: MESH_QUERY, variables: { modelId: 'm1' } });
    assert.equal(calls[1].url, OBJ_URL);
    assert.equal(JSON.stringify(calls[1].init).includes('authorization'), false);
    assert.ok(out.obj instanceof Uint8Array);
    assert.equal(new TextDecoder().decode(out.obj), ROOM_Z);
    assert.deepEqual(out.asset, { id: 'b', format: 'obj', resolution: 'low', filename: 'model.obj', validUntil: '2026-11-14T12:00:00Z' });
    assert.deepEqual(out.warnings, []);
    assert.equal(meshToWalls(out.obj).walls.length, 16);
  });

  test('unzips an OBJ delivered inside a zip archive', async () => {
    const zip = makeZip([
      { name: 'model.mtl', data: 'newmtl wall\n' },
      { name: 'mesh/model.obj', data: ROOM_Z, deflate: true }
    ]);
    const { fn } = mockFetch([
      graphResponse([{ id: 'b', format: 'obj', resolution: 'high', status: 'available', url: OBJ_URL }]),
      new Response(zip, { status: 200 })
    ]);
    const out = await fetchMeshObj({ modelId: 'm1', tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET, fetch: fn });
    assert.equal(out.asset.entry, 'mesh/model.obj');
    assert.equal(new TextDecoder().decode(out.obj), ROOM_Z);
  });

  test('explains a locked or missing OBJ mesh (MatterPak) without leaking credentials', async () => {
    const locked = mockFetch([graphResponse([{ id: 'b', format: 'obj', resolution: 'high', status: 'locked', url: null }])]);
    await assert.rejects(
      fetchMeshObj({ modelId: 'm1', tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET, fetch: locked.fn }),
      err => /not available/.test(err.message) && /mp:matterpak/.test(err.message) && !err.message.includes(TOKEN_SECRET)
    );
    const none = mockFetch([graphResponse([{ id: 'a', format: 'dam', resolution: 'high', status: 'available', url: 'https://x.test/a' }])]);
    await assert.rejects(
      fetchMeshObj({ modelId: 'm1', tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET, fetch: none.fn }),
      err => /no OBJ mesh/.test(err.message) && /dam\/high \(available\)/.test(err.message) && !err.message.includes('https://x.test')
    );
    assert.equal(none.calls.length, 1, 'nothing is downloaded when there is no OBJ');
  });

  test('reports auth failures, HTTP errors, GraphQL errors and failed downloads', async () => {
    const opts = { modelId: 'm1', tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET };
    for (const status of [401, 403]) {
      const { fn } = mockFetch([new Response('nope', { status })]);
      await assert.rejects(fetchMeshObj({ ...opts, fetch: fn }),
        err => /rejected the API credentials/.test(err.message) && !err.message.includes(TOKEN_SECRET) && !err.message.includes(TOKEN_ID));
    }
    const server = mockFetch([new Response('oops', { status: 500 })]);
    await assert.rejects(fetchMeshObj({ ...opts, fetch: server.fn }), /HTTP 500/);
    const gql = mockFetch([new Response(JSON.stringify({ data: { model: null }, errors: [{ message: 'model.not.found' }] }), { status: 200 })]);
    await assert.rejects(fetchMeshObj({ ...opts, fetch: gql.fn }), /model\.not\.found/);
    const gone = mockFetch([
      graphResponse([{ id: 'b', format: 'obj', resolution: 'high', status: 'available', url: OBJ_URL, validUntil: '2026-11-14T12:00:00Z' }]),
      new Response('expired', { status: 403 })
    ]);
    await assert.rejects(fetchMeshObj({ ...opts, fetch: gone.fn }), /HTTP 403.*valid until/);
  });

  test('requires a model id and both credentials before calling the API', async () => {
    const { fn, calls } = mockFetch([]);
    await assert.rejects(fetchMeshObj({ tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET, fetch: fn }), /modelId/);
    await assert.rejects(fetchMeshObj({ modelId: 'm1', tokenId: TOKEN_ID, fetch: fn }), /MATTERPORT_API_KEY/);
    await assert.rejects(fetchMeshObj({ modelId: 'm1', tokenSecret: TOKEN_SECRET, fetch: fn }), /token ID and secret/);
    assert.equal(calls.length, 0);
  });
});
