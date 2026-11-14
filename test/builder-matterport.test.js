// builder/matterport.js against a hand-designed fixture in the Matterport vector-data response shape.
// No network: fetchModelGeometry is tested with a fake fetch.
//
// test/fixtures/matterport/sample-model.json, ground floor (model metres, y up):
//
//   y=6  +---------+---------+---------+.........+
//        | Office  | Office  |  open   :  open   |   Office B's north wall has a window (stays solid).
//        |   A     |   B  [wall/invis] west  : east    |   Office B | open west: B says wall, open-west says invisible.
//   y=1  +--d------+---d-----+----d----+---------+   open west | open east: an invisible edge (no wall).
//        D            Main corridor              |   D = the only exterior doorway (x=-10).
//   y=-1 +--------------------+---d----+--d------+   corridor's south edge is one long edge; the rooms
//        |  L-shaped |  arm   d  Room C |  Room D |   below have their own edges 0.4 mm off it. Room C's
//        |  meeting  +--------+  [col]  o         |   door is recorded on both; Room D's only on the corridor.
//        |  room     | Storage|        |          |   L room -> Room C door is only on the L room's edge.
//   y=-6 +-----------+--------+--------+----------+   Storage has no door. o = an "opening" (C <-> D).
//      x=-10        -6       -1        4         10
//
// Second floor: one 8 x 8 m room with a doorway.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  VECTOR_QUERY, fetchModelGeometry, extractFloorplan, toMapUnits, floorplanToWorld
} from '../builder/matterport.js';
import { createNav, polylineCrossesWall } from '../engine/walls.js';
import { validateWorld } from '../engine/spec.js';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/matterport/sample-model.json', import.meta.url), 'utf8'));
const fixture = () => structuredClone(FIXTURE);

// ---------- independent geometry helpers (touching counts as crossing) ----------

function pointSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

function segmentsTouch(a, b, c, d, eps = 1e-9) {
  const cross = (o, p, q) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return pointSegDist(a.x, a.y, c.x, c.y, d.x, d.y) <= eps || pointSegDist(b.x, b.y, c.x, c.y, d.x, d.y) <= eps
    || pointSegDist(c.x, c.y, a.x, a.y, b.x, b.y) <= eps || pointSegDist(d.x, d.y, a.x, a.y, b.x, b.y) <= eps;
}

function polylineTouchesWall(walls, pts) {
  for (let i = 0; i + 1 < pts.length; i++) {
    for (const w of walls) if (segmentsTouch(pts[i], pts[i + 1], { x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 })) return true;
  }
  return false;
}

const covered = (walls, x, y, eps = 1e-6) => walls.some(w => pointSegDist(x, y, w.x1, w.y1, w.x2, w.y2) <= eps);
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;
const pairKey = ids => ids.map(v => v ?? 'outside').sort().join('|');

// ---------- the query and the fetch ----------

describe('VECTOR_QUERY', () => {
  test('asks for floors, the room-floor link, boundaries, holes, edges, openings and vertices', () => {
    for (const part of ['model(id: $modelId)', 'floors { id sequence label }', 'floor { id }', 'classifications { id label }',
      'boundary { ...BoundedRegionData }', 'holes { ...BoundedRegionData }', 'fragment BoundedRegionData on BoundedRegion',
      'centerLineBias', 'thickness', 'openings { id type width height lowerElevation relativeCenter }', 'vertices { id position { x y } }',
      'dimensionEstimates(units: metric)']) {
      assert.ok(VECTOR_QUERY.includes(part), `missing ${part}`);
    }
  });
});

describe('fetchModelGeometry', () => {
  const creds = { modelId: 'SampleOffice01', tokenId: 'tok-id-1234', tokenSecret: 'tok-secret-5678' };

  test('POSTs the query with Basic auth and returns the GraphQL data', async () => {
    const calls = [];
    const fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(FIXTURE), { status: 200 }); };
    const data = await fetchModelGeometry({ ...creds, fetch });
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, 'https://api.matterport.com/api/models/graph');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Basic ' + Buffer.from('tok-id-1234:tok-secret-5678').toString('base64'));
    assert.equal(init.headers['Content-Type'], 'application/json');
    const body = JSON.parse(init.body);
    assert.equal(body.query, VECTOR_QUERY);
    assert.deepEqual(body.variables, { modelId: 'SampleOffice01' });
    assert.deepEqual(data, FIXTURE.data);
    assert.equal(extractFloorplan(data).rooms.length, 9);
  });

  test('uses a custom endpoint', async () => {
    let seen;
    const fetch = async url => { seen = url; return new Response(JSON.stringify(FIXTURE)); };
    await fetchModelGeometry({ ...creds, endpoint: 'https://example.test/graph', fetch });
    assert.equal(seen, 'https://example.test/graph');
  });

  test('rejects on HTTP 401 without revealing the credentials', async () => {
    const fetch = async () => new Response('{"errors":[{"message":"bad token tok-secret-5678"}]}', { status: 401 });
    await assert.rejects(fetchModelGeometry({ ...creds, fetch }), err => {
      assert.match(err.message, /HTTP 401/);
      assert.match(err.message, /token ID and secret/);
      assert.ok(!err.message.includes('tok-secret-5678') && !err.message.includes('tok-id-1234'));
      return true;
    });
  });

  test('scrubs credentials from network errors', async () => {
    const basic = Buffer.from('tok-id-1234:tok-secret-5678').toString('base64');
    const fetch = async () => { throw new Error(`socket hang up (auth ${basic})`); };
    await assert.rejects(fetchModelGeometry({ ...creds, fetch }), err => {
      assert.match(err.message, /Matterport request failed/);
      assert.ok(!err.message.includes(basic));
      return true;
    });
  });

  test('rejects GraphQL errors with no model, and passes partial errors along', async () => {
    const bad = async () => new Response(JSON.stringify({ errors: [{ message: 'Not authorized for Property Insights' }], data: { model: null } }));
    await assert.rejects(fetchModelGeometry({ ...creds, fetch: bad }), /Not authorized for Property Insights/);
    const partial = async () => new Response(JSON.stringify({ ...FIXTURE, errors: [{ message: 'dimensionEstimates unavailable' }] }));
    const data = await fetchModelGeometry({ ...creds, fetch: partial });
    assert.deepEqual(data.errors, ['dimensionEstimates unavailable']);
    assert.ok(extractFloorplan(data).warnings.some(w => /dimensionEstimates unavailable/.test(w)));
  });

  test('rejects without calling fetch when credentials or the model id are missing', async () => {
    let called = false;
    const fetch = async () => { called = true; return new Response('{}'); };
    await assert.rejects(fetchModelGeometry({ modelId: 'x', tokenId: '', tokenSecret: '', fetch }), /MATTERPORT_API_KEY/);
    await assert.rejects(fetchModelGeometry({ ...creds, modelId: '', fetch }), /modelId/);
    assert.equal(called, false);
  });
});

// ---------- extractFloorplan ----------

describe('extractFloorplan', () => {
  const plan = extractFloorplan(fixture());
  const room = id => plan.rooms.find(r => r.id === id);

  test('defaults to the floor with the most rooms and keys rooms by model and room id', () => {
    assert.equal(plan.units, 'm');
    assert.equal(plan.modelId, 'SampleOffice01');
    assert.deepEqual(plan.floor, { id: 'f0g7km2x1q', sequence: 0, label: 'Ground floor' });
    assert.equal(plan.rooms.length, 9);
    assert.deepEqual(plan.floors.map(f => f.rooms), [9, 1]);
    assert.equal(room('r_offa').key, 'SampleOffice01:r_offa');
    assert.equal(room('r_corr').label, 'Main corridor');
    assert.equal(room('r_offa').classification, 'Office');
    assert.ok(near(room('r_c').area, 5 * 4.9996 - 0.25, 1e-6), 'the column is subtracted');
    assert.ok(near(room('r_meet').area, 27.5, 0.01));
  });

  test('each room gets a point inside it, clear of its walls and of the column', () => {
    for (const r of plan.rooms) {
      const p = r.inside;
      assert.ok(p, r.id);
      assert.ok(plan.walls.every(w => pointSegDist(p.x, p.y, w.x1, w.y1, w.x2, w.y2) > 0.3), `${r.id} point is near a wall`);
    }
    const c = room('r_c').inside;
    assert.ok(!(c.x > 1.25 && c.x < 1.75 && c.y > -3.75 && c.y < -3.25), 'Room C point is inside the column');
    const l = room('r_meet').inside;
    assert.ok(l.x < -6, 'L room point is in the wide part of the L');
  });

  test('wall edges become walls with gaps cut at doorways and openings', () => {
    const W = plan.walls;
    assert.ok(!covered(W, -7.5, 1), 'Office A doorway is open');
    assert.ok(covered(W, -8.5, 1) && covered(W, -6.5, 1), 'the wall on either side of it stays');
    assert.ok(!covered(W, -3.5, 1), 'Office B doorway (relativeCenter from a reversed edge) is open');
    assert.ok(covered(W, -2.5, 1));
    assert.ok(!covered(W, -10, 0) && covered(W, -10, -0.8) && covered(W, -10, 0.8), 'exterior doorway');
    assert.ok(!covered(W, 4, -4.5) && covered(W, 4, -5.5) && covered(W, 4, -3.5), '"opening" type is cut too');
    assert.ok(covered(W, 0, -6) && covered(W, -10, 3) && covered(W, 10, -3), 'outer walls are solid');
  });

  test('invisible edges produce no wall, and become passages between the rooms they split', () => {
    for (const y of [1.5, 3.5, 5.5]) assert.ok(!covered(plan.walls, 5, y), `wall found at (5, ${y})`);
    const open = plan.doors.filter(d => d.type === 'invisible');
    assert.equal(open.length, 1);
    assert.deepEqual(open[0].roomIds, ['r_ow', 'r_oe']);
    assert.ok(near(open[0].width, 5, 1e-6));
  });

  test('a window stays solid and is reported by type', () => {
    assert.ok(covered(plan.walls, -2.5, 6), 'the window does not cut the wall');
    assert.ok(plan.warnings.some(w => /"window"/.test(w) && /b_n/.test(w)));
    assert.ok(!plan.doors.some(d => near(d.y, 6, 0.01)));
  });

  test('walls in holes (a column) are kept', () => {
    const column = plan.walls.filter(w => [w.x1, w.x2].every(x => x >= 1.24 && x <= 1.76) && [w.y1, w.y2].every(y => y >= -3.76 && y <= -3.24));
    assert.equal(column.length, 4);
    assert.ok(column.every(w => w.roomIds.includes('r_c')));
  });

  test('shared walls are deduped by id and merged geometrically', () => {
    const W = plan.walls;
    for (let i = 0; i < W.length; i++) {
      for (let j = i + 1; j < W.length; j++) {
        const a = W[i], b = W[j];
        const ux = a.x2 - a.x1, uy = a.y2 - a.y1, len = Math.hypot(ux, uy);
        const cross = Math.abs(ux * (b.y2 - b.y1) - uy * (b.x2 - b.x1)) / (len * Math.hypot(b.x2 - b.x1, b.y2 - b.y1));
        if (cross > 1e-6 || pointSegDist(b.x1, b.y1, a.x1 - ux * 1e3, a.y1 - uy * 1e3, a.x2 + ux * 1e3, a.y2 + uy * 1e3) > 1e-3) continue;
        const s = p => ((p.x - a.x1) * ux + (p.y - a.y1) * uy) / len;
        const s1 = s({ x: b.x1, y: b.y1 }), s2 = s({ x: b.x2, y: b.y2 });
        const overlap = Math.min(len, Math.max(s1, s2)) - Math.max(0, Math.min(s1, s2));
        assert.ok(overlap <= 1e-6, `walls ${i} and ${j} overlap by ${overlap}`);
      }
    }
    // a_s is one edge object listed by both the corridor and Office A.
    const shared = W.find(w => w.edgeId === 'a_s');
    assert.ok(shared.roomIds.includes('r_corr') && shared.roomIds.includes('r_offa'));
    // Room C's doorway is recorded by both the corridor's long edge and Room C's own edge: one door.
    const cDoors = plan.doors.filter(d => near(d.y, -1, 0.01) && d.x > 1 && d.x < 2);
    assert.equal(cDoors.length, 1);
    assert.ok(cDoors[0].width >= 0.9 && cDoors[0].width < 0.95);
    // Room D's doorway is only in the corridor's data; the L room's only in its own. Both cut the merged wall.
    assert.ok(!covered(W, 7, -1));
    assert.ok(!covered(W, -1, -1.75));
    // The south rooms' edges sit 0.4 mm off the corridor's: no wall is left at y = -1.0004.
    assert.ok(!W.some(w => near(w.y1, -1.0004, 1e-6) && near(w.y2, -1.0004, 1e-6)));
  });

  test('a wall edge coinciding with an invisible edge stays a wall, with a warning', () => {
    assert.ok(covered(plan.walls, 0, 3.5));
    assert.ok(plan.warnings.some(w => /b_e/.test(w) && /ow_w/.test(w) && /invisible/.test(w) && /kept the wall/.test(w)));
  });

  test('doors list every passable opening with the rooms on each side', () => {
    const expected = [
      ['r_corr', null], ['r_corr', 'r_offa'], ['r_corr', 'r_offb'], ['r_corr', 'r_ow'], ['r_ow', 'r_oe'],
      ['r_meet', 'r_c'], ['r_corr', 'r_c'], ['r_corr', 'r_d'], ['r_c', 'r_d']
    ];
    assert.deepEqual(plan.doors.map(d => pairKey(d.roomIds)).sort(), expected.map(pairKey).sort());
    const ext = plan.doors.find(d => d.roomIds.includes(null));
    assert.deepEqual(ext.roomIds, ['r_corr', null]);
    assert.equal(ext.outside, true);
    assert.equal(ext.type, 'doorway');
    assert.ok(near(ext.x, -10, 1e-9) && near(ext.y, 0, 1e-9) && near(ext.width, 1.2, 1e-9));
    assert.equal(plan.doors.filter(d => d.outside).length, 1);
    assert.equal(plan.doors.find(d => pairKey(d.roomIds) === pairKey(['r_c', 'r_d'])).type, 'opening');
    for (const d of plan.doors) {
      assert.ok(near(Math.hypot(d.x2 - d.x1, d.y2 - d.y1), d.width, 1e-9), 'gap endpoints span the width');
      assert.ok(!covered(plan.walls, d.x, d.y), `door ${d.id} centre is on a wall`);
    }
  });

  test('selects a floor by sequence, label or id, and rejects an unknown floor', () => {
    for (const floor of [1, '1', 'second floor', 'f1h8ln3y2r']) {
      const p = extractFloorplan(fixture(), { floor });
      assert.equal(p.floor.id, 'f1h8ln3y2r', String(floor));
      assert.deepEqual(p.rooms.map(r => r.id), ['r_up']);
      assert.equal(p.doors.length, 1);
      assert.equal(p.walls.length, 5);
    }
    assert.equal(extractFloorplan(fixture(), { floor: 0 }).rooms.length, 9);
    assert.throws(() => extractFloorplan(fixture(), { floor: 'roof' }), /Ground floor.*Second floor/);
  });

  test('never throws on missing or partial data', () => {
    const cases = [
      undefined, null, 42, {}, { data: null }, { data: { model: null } },
      { data: { model: { floors: null, rooms: null } } },
      { data: { model: { floors: [{ id: 'f' }], rooms: [null, { id: 'a', boundary: null, holes: null }] } } },
      { model: { rooms: [{ id: 'b', boundary: { edges: [{ id: 'e1', type: 'wall', vertices: [{ id: 'v', position: null }] }, null] } }] } },
      { model: { rooms: [{ id: 'c', boundary: { edges: [{ id: 'e2', type: 'wall', openings: [{ type: 'doorway' }, null], vertices: [{ position: { x: 0, y: 0 } }, { position: { x: 3, y: 0 } }] }] } }] } }
    ];
    for (const raw of cases) {
      const p = extractFloorplan(raw);
      assert.equal(p.units, 'm');
      assert.ok(Array.isArray(p.rooms) && Array.isArray(p.walls) && Array.isArray(p.doors));
      assert.ok(p.warnings.length > 0, JSON.stringify(raw));
    }
    const last = extractFloorplan(cases.at(-1));
    assert.equal(last.walls.length, 1, 'a lone wall edge still becomes a wall');
    assert.ok(last.warnings.some(w => /no usable width/.test(w)));
  });

  test('an unknown edge type is treated as a wall', () => {
    const raw = fixture();
    raw.data.model.rooms[0].boundary.edges.find(e => e.id === 'c_e').type = 'railing';
    const p = extractFloorplan(raw);
    assert.ok(covered(p.walls, 10, 0));
    assert.ok(p.warnings.some(w => /c_e/.test(w) && /railing/.test(w) && /treated as a wall/.test(w)));
  });

  test('two different edges that share an id are both kept', () => {
    const raw = fixture();
    raw.data.model.rooms.find(r => r.id === 'r_offa').boundary.edges.find(e => e.id === 'a_n').id = 'ab';
    const p = extractFloorplan(raw);
    assert.ok(covered(p.walls, -7.5, 6) && covered(p.walls, -5, 3.5));
    assert.ok(p.warnings.some(w => /edge ab/.test(w) && /different positions/.test(w)));
  });

  test('a vertex listed without a position is recovered from another edge by its id', () => {
    const raw = fixture();
    const edge = raw.data.model.rooms[0].boundary.edges.find(e => e.id === 'c_e');
    delete edge.vertices[0].position;
    const p = extractFloorplan(raw);
    assert.ok(covered(p.walls, 10, 0), 'the corridor east wall is still there');
    assert.ok(!p.warnings.some(w => /needs two vertices/.test(w)));
  });

  test('rooms without floor links in a multi-floor model are treated as one floor, with a warning', () => {
    const raw = fixture();
    for (const r of raw.data.model.rooms) delete r.floor;
    const p = extractFloorplan(raw);
    assert.equal(p.rooms.length, 10);
    assert.ok(p.warnings.some(w => /no floor link/.test(w)));
  });

  test('warns when outlines disagree with the metric area estimates (a units check)', () => {
    const raw = fixture();
    for (const r of raw.data.model.rooms) r.dimensionEstimates.area *= 10.764;   // as if the coordinates were feet
    assert.ok(extractFloorplan(raw).warnings.some(w => /check the coordinate units/.test(w)));
    assert.ok(!plan.warnings.some(w => /coordinate units/.test(w)));
  });
});

// ---------- toMapUnits ----------

describe('toMapUnits', () => {
  const plan = extractFloorplan(fixture());
  const map = toMapUnits(plan);

  test('fits the floor into 0-100 with the margin, keeping the aspect ratio', () => {
    assert.equal(map.units, 'map');
    assert.ok(near(map.metersPerUnit, 20 / 94, 1e-12));
    assert.deepEqual(map.bounds, { minX: 3, minY: 21.8, maxX: 97, maxY: 78.2 });
    const all = [...map.walls.flatMap(w => [w.x1, w.y1, w.x2, w.y2]), ...map.doors.flatMap(d => [d.x, d.y])];
    assert.ok(all.every(v => v >= 3 && v <= 97));
    for (let i = 0; i < plan.walls.length; i++) {
      const a = plan.walls[i], b = map.walls[i];
      assert.ok(near(Math.hypot(b.x2 - b.x1, b.y2 - b.y1) * map.metersPerUnit, Math.hypot(a.x2 - a.x1, a.y2 - a.y1), 1e-3));
    }
    assert.ok(near(map.doors[0].width * map.metersPerUnit, plan.doors[0].width, 1e-3));
    assert.equal(map.doors[0].widthM, plan.doors[0].width);
  });

  test('flips y so the plan is not mirrored on a y-down canvas', () => {
    const y = id => map.rooms.find(r => r.id === id).inside.y;
    assert.ok(y('r_offa') < y('r_corr') && y('r_corr') < y('r_c'), 'north rooms are drawn above south rooms');
    const t = map.transform;
    assert.equal(t.flipY, true);
    const p = plan.rooms[0].inside, q = map.rooms[0].inside;
    assert.ok(near(t.tx + p.x * t.scale, q.x, 1e-3) && near(t.ty - p.y * t.scale, q.y, 1e-3));
  });

  test('honours the margin and leaves a map plan alone', () => {
    const wide = toMapUnits(plan, { margin: 10 });
    assert.deepEqual([wide.bounds.minX, wide.bounds.maxX], [10, 90]);
    assert.equal(toMapUnits(map), map);
  });
});

// ---------- floorplanToWorld ----------

function checkWorldGeometry(world) {
  for (const n of world.nodes) {
    assert.ok(n.x >= 3 && n.x <= 97 && n.y >= 3 && n.y <= 97, `node ${n.id} out of range`);
    const d = Math.min(...world.walls.map(w => pointSegDist(n.x, n.y, w.x1, w.y1, w.x2, w.y2)));
    assert.ok(d >= 0.05, `node ${n.id} is ${d} from a wall`);
  }
  const byId = new Map(world.nodes.map(n => [n.id, n]));
  for (const e of world.edges ?? []) {
    const pts = [byId.get(e.from), ...(e.via ?? []), byId.get(e.to)];
    assert.ok(!polylineTouchesWall(world.walls, pts), `edge ${e.from}>${e.to} touches a wall`);
    assert.equal(polylineCrossesWall(world.walls, pts), null);
    assert.ok((e.via ?? []).length <= 12);
  }
}

describe('floorplanToWorld, route mode', () => {
  const plan = extractFloorplan(fixture());
  const world = floorplanToWorld(plan, { title: 'Sample office', question: 'Where does the morning rush jam?' });
  const node = id => world.nodes.find(n => n.id === id);

  test('exterior doors are origins, one-door rooms destinations, the rest intersections', () => {
    assert.equal(world.mode, 'route');
    assert.equal(world.title, 'Sample office');
    const origins = world.nodes.filter(n => n.kind === 'origin');
    assert.equal(origins.length, 1);
    assert.equal(origins[0].name, 'Entrance 1');
    assert.ok(near(origins[0].x, 3, 1e-9) && near(origins[0].y, 50, 1e-9));
    const kinds = Object.fromEntries(['r_corr', 'r_offa', 'r_offb', 'r_ow', 'r_oe', 'r_meet', 'r_c', 'r_d'].map(id => [id, node(`room_${id}`).kind]));
    assert.deepEqual(kinds, {
      r_corr: 'intersection', r_offa: 'destination', r_offb: 'destination', r_ow: 'intersection',
      r_oe: 'destination', r_meet: 'destination', r_c: 'intersection', r_d: 'intersection'
    });
    assert.equal(node('room_r_store'), undefined, 'Storage has no door');
    assert.ok(world.warnings.some(w => /Storage/.test(w) && /no doorway/.test(w)));
    assert.equal(world.nodes.length, 8 + 9);
    assert.equal(world.edges.length, 17);
  });

  test('every edge polyline is wall-free and the L-shaped room needs a waypoint', () => {
    checkWorldGeometry(world);
    const lEdge = world.edges.find(e => e.from === 'room_r_meet');
    assert.ok(lEdge.via && lEdge.via.length >= 1);
    const n = node('room_r_meet'), d = node(lEdge.to);
    assert.ok(polylineTouchesWall(world.walls, [n, d]), 'the straight line really is blocked');
  });

  test('lengths come from walking distance, capacity from door width', () => {
    const doorWidth = new Map(toMapUnits(plan).doors.map((d, k) => [`door_${k + 1}`, d.widthM]));
    for (const e of world.edges) {
      assert.ok(e.length >= 0.2 && e.length <= 180);
      assert.ok(Number.isInteger(e.capacity) && e.capacity >= 1);
      assert.equal(e.capacity, Math.max(1, Math.round(78 * doorWidth.get(e.to) * e.length)));
      assert.equal(e.twoWay, true);
    }
    assert.equal(world.provenance['edges[*].capacity'], 'assumed');
    assert.equal(world.provenance['edges[*].length'], 'data');
  });

  test('geo, walls and provenance', () => {
    const mpu = 20 / 94;
    assert.ok(near(world.geo.metersPerUnit, mpu, 1e-6));
    assert.equal(world.geo.source, 'matterport-vector');
    assert.equal(world.geo.floor, 'Ground floor');
    assert.ok(world.geo.clearance >= 0.02 && world.geo.clearance <= 1);
    assert.ok(world.geo.clearance <= 0.9 / 4 / mpu + 1e-9, 'at most a quarter of the narrowest door');
    assert.equal(world.walls.length, plan.walls.length);
    assert.ok(world.walls.every(w => w.source === 'matterport-vector'));
    for (const k of ['walls', 'geo.metersPerUnit', 'geo.clearance', 'arrivals', 'archetypes']) assert.ok(world.provenance[k], k);
    assert.equal(world.archetypes.length, 1);
    assert.ok(!('warnings' in JSON.parse(JSON.stringify(world))), 'warnings stay out of the world JSON');
  });

  test('the walls leave no leaks: the doorless storeroom cannot be reached, every other room can', () => {
    const map = toMapUnits(plan);
    const nav = createNav(world.walls, { clearance: world.geo.clearance });
    const entrance = world.nodes.find(n => n.kind === 'origin');
    const store = map.rooms.find(r => r.id === 'r_store').inside;
    assert.equal(nav.path(entrance.x, entrance.y, store.x, store.y), null);
    for (const n of world.nodes) assert.ok(nav.path(entrance.x, entrance.y, n.x, n.y), `${n.id} unreachable`);
  });

  test('passes validateWorld', () => {
    const v = validateWorld(world);
    assert.deepEqual(v.errors, []);
    assert.equal(v.ok, true);
  });
});

describe('floorplanToWorld, visit mode', () => {
  const plan = extractFloorplan(fixture());
  const world = floorplanToWorld(plan, { mode: 'visit' });

  test('entrances at exterior doors and one service place per reachable room', () => {
    assert.equal(world.mode, 'visit');
    const gates = world.nodes.filter(n => n.kind === 'gate');
    assert.equal(gates.length, 1);
    assert.ok(near(gates[0].x, 3, 1e-9));
    const services = world.nodes.filter(n => n.kind === 'service');
    assert.deepEqual(services.map(s => s.id).sort(), ['r_c', 'r_corr', 'r_d', 'r_meet', 'r_oe', 'r_offa', 'r_offb', 'r_ow'].map(id => `room_${id}`).sort());
    for (const s of services) {
      assert.ok(Number.isInteger(s.servers) && s.servers >= 1);
      assert.equal(s.serviceTime, 5);
    }
    assert.equal(world.provenance['nodes[*].servers'], 'assumed');
    assert.equal(world.provenance['nodes[*].serviceTime'], 'assumed');
    // 80 m per minute in map units, no longer capped at 60 (§14d: the maximum is 600).
    assert.ok(Math.abs(world.travelSpeed - Math.round(80 / world.geo.metersPerUnit * 1000) / 1000) < 1e-9, `travelSpeed ${world.travelSpeed}`);
    assert.ok(world.travelSpeed > 0 && world.travelSpeed <= 600);
    checkWorldGeometry(world);
  });

  test('carries the doorway gap segments for door traffic', () => {
    assert.equal(world.doors.length, 9);
    assert.equal(world.doors.filter(d => d.exterior).length, 1);
    for (const d of world.doors) {
      assert.ok(!covered(world.walls, (d.x1 + d.x2) / 2, (d.y1 + d.y2) / 2), `door ${d.id} middle is on a wall`);
    }
  });

  test('passes validateWorld', () => {
    const v = validateWorld(world);
    assert.deepEqual(v.errors, []);
    assert.equal(v.ok, true);
  });
});

describe('floorplanToWorld fallbacks', () => {
  test('no exterior door: the best-connected room becomes the origin', () => {
    const raw = fixture();
    raw.data.model.rooms[0].boundary.edges.find(e => e.id === 'c_w').openings = [];
    const plan = extractFloorplan(raw);
    assert.ok(!plan.doors.some(d => d.outside));
    const world = floorplanToWorld(plan);
    const origins = world.nodes.filter(n => n.kind === 'origin');
    assert.deepEqual(origins.map(n => n.id), ['room_r_corr']);
    assert.ok(world.warnings.some(w => /no exterior door/.test(w) && /Main corridor/.test(w)));
    assert.ok(world.nodes.some(n => n.kind === 'destination'));
    checkWorldGeometry(world);
    assert.deepEqual(validateWorld(world).errors, []);
    const visit = floorplanToWorld(plan, { mode: 'visit' });
    assert.equal(visit.nodes.filter(n => n.kind === 'gate').length, 1);
    assert.deepEqual(validateWorld(visit).errors, []);
  });

  test('the second floor: one room behind one door', () => {
    const world = floorplanToWorld(extractFloorplan(fixture(), { floor: 1 }));
    assert.deepEqual(world.nodes.map(n => n.kind).sort(), ['destination', 'origin']);
    assert.equal(world.geo.floor, 'Second floor');
    checkWorldGeometry(world);
    assert.deepEqual(validateWorld(world).errors, []);
  });

  test('a floor too big for 60 nodes uses room-to-room edges through the doors', () => {
    // 40 offices (2 m wide) along a corridor: 41 rooms + 41 doors would be 82 nodes.
    const v = (x, y) => ({ id: `v${x}_${y}`, position: { x, y } });
    const wall = (id, a, b, openings = []) => ({ id, type: 'wall', thickness: 0.1, openings, vertices: [a, b] });
    const door = { id: '', type: 'doorway', width: 0.9, relativeCenter: 0.5 };
    const n = 40, L = 2 * n;
    const rooms = [{
      id: 'hall', label: 'Hall', floor: { id: 'f' }, boundary: {
        edges: [
          wall('hs', v(0, 0), v(L, 0)), wall('hw', v(0, 0), v(0, 2), [{ ...door, id: 'ext' }]), wall('he', v(L, 0), v(L, 2)),
          ...Array.from({ length: n }, (_, i) => wall(`s${i}`, v(2 * i, 2), v(2 * i + 2, 2), [{ ...door, id: `d${i}` }]))
        ]
      }
    }];
    for (let i = 0; i < n; i++) {
      rooms.push({
        id: `o${i}`, label: '', classifications: [{ label: 'Office' }], floor: { id: 'f' }, boundary: {
          edges: [wall(`s${i}`, v(2 * i, 2), v(2 * i + 2, 2), [{ ...door, id: `d${i}` }]), wall(`n${i}`, v(2 * i, 6), v(2 * i + 2, 6)),
            wall(`w${i}`, v(2 * i, 2), v(2 * i, 6)), wall(`w${i + 1}`, v(2 * i + 2, 2), v(2 * i + 2, 6))]
        }
      });
    }
    const plan = extractFloorplan({ model: { id: 'strip', floors: [{ id: 'f', sequence: 0, label: 'Strip' }], rooms } });
    assert.equal(plan.doors.length, n + 1);
    const world = floorplanToWorld(plan);
    assert.ok(world.nodes.length <= 60);
    assert.equal(world.nodes.length, n + 2);
    assert.equal(world.edges.length, n + 1);
    assert.ok(world.warnings.some(w => /interior doors become waypoints/.test(w)));
    checkWorldGeometry(world);
    assert.deepEqual(validateWorld(world).errors, []);
  });

  test('a floor too big even for room-to-room edges keeps the part nearest the entrance', () => {
    // A 9 x 9 grid of 4 m rooms, each with doors east and north, entered at one corner: 81 rooms.
    const G = 9, S = 4, rooms = [];
    const v = (x, y) => ({ id: `v${x}_${y}`, position: { x: x * S, y: y * S } });
    const wall = (a, b, door) => ({ id: [a.id, b.id].sort().join('-'), type: 'wall', thickness: 0.15, vertices: [a, b],
      openings: door ? [{ id: door, type: 'doorway', width: 0.9, relativeCenter: 0.5 }] : [] });
    for (let i = 0; i < G; i++) {
      for (let j = 0; j < G; j++) {
        const [a, b, c, d] = [v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1)];
        rooms.push({ id: `r${i}_${j}`, floor: { id: 'f' }, boundary: { edges: [
          wall(a, b, j > 0 && `n${i}_${j}`), wall(b, c, i < G - 1 && `e${i}_${j}`),
          wall(c, d, j < G - 1 && `n${i}_${j + 1}`), wall(d, a, i > 0 ? `e${i - 1}_${j}` : j === 0 && 'ext')] } });
      }
    }
    const plan = extractFloorplan({ model: { id: 'grid', floors: [{ id: 'f', sequence: 0 }], rooms } });
    assert.equal(plan.rooms.length, 81);
    const world = floorplanToWorld(plan);
    assert.ok(world.nodes.length <= 60 && world.edges.length <= 150);
    assert.ok(world.warnings.some(w => /nearest the entrances/.test(w)));
    assert.equal(world.nodes.filter(n => n.kind === 'origin').length, 1);
    assert.ok(world.nodes.some(n => n.kind === 'destination'));
    checkWorldGeometry(world);
    assert.deepEqual(validateWorld(world).errors, []);
    const visit = floorplanToWorld(plan, { mode: 'visit' });
    assert.ok(visit.nodes.length <= 60);
    assert.deepEqual(validateWorld(visit).errors, []);
  });
});
