// Shared geometry modules for the scope display and the world builder (docs/PROTOTYPE.md §9b).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMatterport, outerLoop, openingSpan, solidSpans, pointInRoom } from '../geometry/matterport.js';
import { parseObj, sliceToGrid, rle, unrle } from '../geometry/obj-slice.js';
import { buildWalkGrid, distanceField, cellIndex } from '../geometry/walkgrid.js';
import { syntheticBuilding } from '../mockgen/synthetic.js';

test('outerLoop ignores dangling wall stubs and returns the outline', () => {
  const P = { a: [0, 0], b: [4, 0], c: [4, 3], d: [0, 3], s: [2, 1.5] };
  const edges = [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a'], ['b', 's']];   // b–s is a stub into the room
  const loop = outerLoop(edges, id => P[id]);
  assert.equal(loop.length, 4);
  assert.deepEqual(new Set(loop), new Set(['a', 'b', 'c', 'd']));
});

test('openings split a wall into solid pieces around their span', () => {
  const span = openingSpan({ relativeCenter: 0.5, width: 1 }, 4);
  assert.deepEqual(span, [0.375, 0.625]);
  assert.deepEqual(solidSpans([span]), [[0, 0.375], [0.625, 1]]);
});

test('normalizeMatterport scales the longer side to 100 map units and flips y', () => {
  const g = syntheticBuilding();
  const [, , W, H] = g.bounds;
  assert.ok(Math.abs(Math.max(W, H) - 100) < 1e-6);
  assert.equal(g.floors.length, 2);
  // Matterport y grows north; map y grows down, so the café (north) sits above the market.
  const cafe = g.floors[0].rooms.find(r => r.id === 'syn_cafe');
  const market = g.floors[0].rooms.find(r => r.id === 'syn_market');
  const cy = r => r.poly.reduce((a, p) => a + p[1], 0) / r.poly.length;
  assert.ok(cy(cafe) < cy(market));
});

test('walk grid classifies storefronts as exterior and the restroom door as interior', () => {
  const g = syntheticBuilding();
  const grid = buildWalkGrid(g.floors[0], { metersPerUnit: g.metersPerUnit });
  const sides = grid.openings.map(o => `${o.widthM}:${o.side}`).sort();
  assert.deepEqual(sides, ['0.9:interior', '1.3:exterior', '3.2:exterior', '4.5:exterior', '5:exterior']);
  for (const o of grid.openings.filter(x => x.side === 'exterior')) {
    const i = cellIndex(grid, o.spawn[0], o.spawn[1]);
    assert.ok(i >= 0 && grid.free[i], 'spawn point outside each entrance is walkable');
  }
});

test('agents cannot walk through mesh obstacles: shelves block the straight line', () => {
  const g = syntheticBuilding();
  const f = g.floors[0];
  const grid = buildWalkGrid(f, { metersPerUnit: g.metersPerUnit });
  const toMap = (x, y) => [(x - f.transform.x0) * f.transform.scale, (f.transform.y1 - y) * f.transform.scale];
  const [sx, sy] = toMap(22, 3.45);   // inside the first shelf (12–33 m, 3–3.9 m)
  assert.equal(grid.free[cellIndex(grid, sx, sy)], 0);
  // Two points either side of the shelf are connected only by walking around it.
  const [ax, ay] = toMap(22, 2.2), [bx, by] = toMap(22, 4.6);
  const field = distanceField(grid, [cellIndex(grid, bx, by)]);
  const d = field[cellIndex(grid, ax, ay)];
  const straight = Math.hypot(bx - ax, by - ay) / grid.cell;
  assert.ok(Number.isFinite(d) && d > straight * 3, `detour ${d.toFixed(1)} cells vs straight ${straight.toFixed(1)}`);
});

test('mesh slice keeps walking-height surfaces and drops the floor and ceiling', () => {
  // A 1 m cube standing on the floor (0..1 m) and a ceiling plate at 3 m.
  const obj = [
    'v 1 1 0', 'v 2 1 0', 'v 2 2 0', 'v 1 2 0', 'v 1 1 1', 'v 2 1 1', 'v 2 2 1', 'v 1 2 1',
    'v 0 0 3', 'v 4 0 3', 'v 4 4 3', 'v 0 4 3',
    'f 1 2 6', 'f 1 6 5', 'f 2 3 7', 'f 2 7 6', 'f 3 4 8', 'f 3 8 7', 'f 4 1 5', 'f 4 5 8', 'f 5 6 7', 'f 5 7 8',
    'f 9 10 11', 'f 9 11 12'
  ].join('\n');
  const mesh = parseObj(obj);
  const grid = sliceToGrid(mesh, { up: { axis: 'z' }, floorZ: 0, zMin: 0.3, zMax: 1.5, cell: 0.25, boundsMeters: [0, 0, 4, 4] });
  const at = (x, y) => grid.data[Math.floor((4 - y) / 0.25) * grid.w + Math.floor(x / 0.25)];
  assert.equal(at(1.5, 1.5), 1, 'cube top at 1 m is an obstacle');
  assert.equal(at(3.5, 3.5), 0, 'ceiling at 3 m is not');
  assert.deepEqual(unrle(rle(grid.data), grid.data.length), grid.data);
});

test('pointInRoom respects holes', () => {
  const room = { poly: [[0, 0], [10, 0], [10, 10], [0, 10]], holes: [[[4, 4], [6, 4], [6, 6], [4, 6]]] };
  assert.equal(pointInRoom(2, 2, room), true);
  assert.equal(pointInRoom(5, 5, room), false);
});

test('normalizeMatterport handles an empty model with a clear error', () => {
  assert.throws(() => normalizeMatterport({ floors: [], rooms: [] }), /no floor-plan vertices/);
});
