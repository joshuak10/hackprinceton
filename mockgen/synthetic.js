// Synthetic geometry, committed so a fresh clone runs without hackathon data:
// - syntheticBuilding(): a made-up two-floor office/retail building, written as a fake Matterport Model API
//   response and passed through the same normalizer as real scans, with the same point-of-interest ids
//   the building mock expects.
// - syntheticLot(): a retail parking lot (store, one-way aisles, stalls, walkway, driveways) for the
//   parking mock, until a real property and Vexcel imagery are chosen.
import { normalizeMatterport } from '../geometry/matterport.js';
import { rle } from '../geometry/obj-slice.js';

// ---------- building ----------

function fakeModel() {
  const floors = [], rooms = [], locations = [];
  let vid = 0, eid = 0, oid = 0;
  const mkFloor = (seq) => {
    const f = { id: `sf${seq}`, sequence: seq, label: `Floor ${seq + 1}`, vertices: [], edges: [] };
    floors.push(f);
    return f;
  };
  // A rectangular room with its own four walls; `doors` = [{ side: 'n'|'s'|'e'|'w', at: 0..1, width }]
  const addRoom = (f, id, x0, y0, x1, y1, tag, doors = []) => {
    const v = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => {
      const vv = { id: `v${++vid}`, position: { x, y } };
      f.vertices.push(vv);
      return vv;
    });
    const sides = { s: [0, 1], e: [1, 2], n: [2, 3], w: [3, 0] };
    const edges = [];
    for (const [side, [a, b]] of Object.entries(sides)) {
      const e = {
        id: `e${++eid}`, type: 'wall', thickness: 0.15, vertices: [{ id: v[a].id }, { id: v[b].id }],
        openings: doors.filter(d => d.side === side).map(d => ({ id: `o${++oid}`, type: 'opening', width: d.width, height: 2.1, relativeCenter: d.at, lowerElevation: 0 }))
      };
      f.edges.push(e);
      edges.push({ id: e.id, vertices: e.vertices });
    }
    rooms.push({ id, label: null, tags: [tag], keywords: ['indoor'], floor: { id: f.id }, classifications: [], dimensionEstimates: { area: (x1 - x0) * (y1 - y0) }, boundary: { edges }, holes: [] });
  };
  const f0 = mkFloor(0), f1 = mkFloor(1);
  // Ground floor: market (south) and café (north) as separate units with east storefronts.
  addRoom(f0, 'syn_market', 0, 0, 46, 12.8, 'other', [
    { side: 'e', at: 0.62, width: 5 }, { side: 'e', at: 0.2, width: 3.2 }, { side: 'w', at: 0.3, width: 1.3 }
  ]);
  addRoom(f0, 'syn_cafe', 0, 13.2, 46, 26, 'other', [{ side: 'e', at: 0.5, width: 4.5 }]);
  addRoom(f0, 'syn_restroom', 0.3, 8.6, 5, 12.5, 'bathroom', [{ side: 'e', at: 0.45, width: 0.9 }]);
  // Upper floor: open-plan offices with a west stair door.
  addRoom(f1, 'syn_offices', 0, 0, 46, 26, 'other', [{ side: 'w', at: 0.18, width: 1.1 }]);
  for (let i = 0; i < 6; i++) {
    locations.push({ id: `s0_${i}`, floor: { id: 'sf0' }, room: null, position: { x: 6 + i * 7, y: i % 2 ? 4 : 20, z: 0 } });
    locations.push({ id: `s1_${i}`, floor: { id: 'sf1' }, room: null, position: { x: 6 + i * 7, y: 13, z: 4.2 } });
  }
  return { id: 'synthetic', name: 'Synthetic office and retail building', floors, rooms, locations };
}

// Rectangles (metres, Matterport frame) that block walking: shelves, counters, tables, desks.
const OBSTACLES = {
  0: [
    ...[3, 5.6, 8.2].map(y => [12, y, 33, y + 0.9]),          // market shelves
    [38, 7.2, 40, 9.8],                                          // checkout counter
    [27, 20.5, 35, 22.3], [33.2, 22.3, 35, 24.5],                // café counter
    ...[[5, 16], [8, 16], [11, 16], [5, 19.5], [8, 19.5], [11, 19.5], [14, 22], [17, 22], [5, 23], [8, 23]].map(([x, y]) => [x, y, x + 1, y + 1])
  ],
  1: [
    ...[6, 14, 22, 30, 38].flatMap(x => [[x, 4, x + 4, 5.4], [x, 8.5, x + 4, 9.9], [x, 17, x + 4, 18.4], [x, 21, x + 4, 22.4]]),
    [30, 11.5, 38, 14.5]                                          // meeting room table
  ]
};

function obstacleGrid(rects, boundsMeters, transform, cell = 0.25) {
  const [x0, y0, x1, y1] = boundsMeters;
  const w = Math.ceil((x1 - x0) / cell), h = Math.ceil((y1 - y0) / cell);
  const data = new Uint8Array(w * h);
  for (const [ax, ay, bx, by] of rects) {
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const x = x0 + (c + 0.5) * cell, y = y1 - (r + 0.5) * cell;
      if (x >= ax && x <= bx && y >= ay && y <= by) data[r * w + c] = 1;
    }
  }
  const { scale } = transform;
  return { cell: cell * scale, w, h, origin: [(x0 - transform.x0) * scale, (transform.y1 - y1) * scale], rle: rle(data) };
}

export function syntheticBuilding() {
  const g = normalizeMatterport(fakeModel());
  g.source = { provider: 'synthetic', name: 'Synthetic office and retail building' };
  const toMap = (floor, x, y) => [(x - floor.transform.x0) * floor.transform.scale, (floor.transform.y1 - y) * floor.transform.scale];
  g.floors.forEach((floor, fi) => {
    floor.obstacles = obstacleGrid(OBSTACLES[fi] || [], floor.metersBounds, floor.transform);
  });
  const P = (fi, x, y) => toMap(g.floors[fi], x, y);
  const box = (fi, ax, ay, bx, by) => { const [x0, y1] = P(fi, ax, ay), [x1, y0] = P(fi, bx, by); return [x0, y0, x1, y1]; };
  const entry = (fi, id, name, x, y) => { const [mx, my] = P(fi, x, y); return { id, name, kind: 'entry', x: mx, y: my, provenance: 'assumed' }; };
  const service = (fi, id, name, x, y, extra) => { const [mx, my] = P(fi, x, y); return { id, name, kind: 'service', x: mx, y: my, provenance: 'assumed', ...extra }; };
  g.floors[0].pois = [
    entry(0, 'cafe_front', 'Café storefront', 46, 19.6),
    entry(0, 'market_front', 'Market front doors', 46, 7.9),
    entry(0, 'market_side', 'Market south doors', 46, 2.6),
    entry(0, 'west_door', 'West side door', 0, 3.8),
    service(0, 'cafe_counter', 'Café counter', 31, 19.6, { servers: 3, serviceTime: 1.1, queueDir: [-1, 0] }),
    service(0, 'market_checkout', 'Market checkout', 37, 8.5, { servers: 3, serviceTime: 1.35, queueDir: [-1, 0] }),
    service(0, 'restroom', 'Restrooms', 6.4, 10.4, { servers: 2, serviceTime: 3, queueDir: [1, 0], serveAt: P(0, 2.6, 10.5) }),
    { id: 'cafe_seating', name: 'Café seating', kind: 'area', box: box(0, 3, 15, 22, 25), provenance: 'assumed' },
    { id: 'market_aisles', name: 'Market aisles', kind: 'area', box: box(0, 10, 1, 35, 12), provenance: 'assumed' }
  ];
  g.floors[1].pois = [
    entry(1, 'stair_door', 'West stair door', 0, 4.7),
    service(1, 'reception', 'Office reception', 3.6, 4.7, { servers: 1, serviceTime: 1.1, queueDir: [1, 0] }),
    { id: 'offices', name: 'Offices', kind: 'area', box: box(1, 6, 2, 44, 24), provenance: 'assumed' }
  ];
  g.links = [
    { from: 'stair_door', to: 'cafe_front', seconds: 70 },
    { from: 'stair_door', to: 'market_front', seconds: 65 },
    { from: 'stair_door', to: 'west_door', seconds: 35 }
  ];
  g.provenance = { rooms: 'synthetic', walls: 'synthetic', openings: 'synthetic', obstacles: 'synthetic', pois: 'assumed' };
  delete g.sweeps;
  return g;
}

// ---------- parking lot ----------

export function syntheticLot() {
  const mpu = 1.25;                          // metres per map unit
  const D = 4.4, A = 5.6, SW = 2.08;         // stall depth, aisle width, stall width (map units)
  const yRow1 = 22.5;
  const aisles = [
    { id: 'aisle1', name: 'Front aisle', y: yRow1 + D + A / 2, dir: 1 },
    { id: 'aisle2', name: 'Middle aisle', y: yRow1 + 3 * D + 1.5 * A, dir: -1 },
    { id: 'aisle3', name: 'Back aisle', y: yRow1 + 5 * D + 2.5 * A, dir: 1 }
  ];
  const perimeterY = aisles[2].y + A / 2 + D + A / 2 + 0.4;
  const streetY = perimeterY + 11;
  // Stall rows: [top y, which aisle serves it, facing]
  const rows = [
    [yRow1, 0], [yRow1 + D + A, 0], [yRow1 + 2 * D + A, 1], [yRow1 + 2 * D + 2 * A, 1], [yRow1 + 3 * D + 2 * A, 2], [yRow1 + 4 * D + 3 * A, 2]
  ];
  const stalls = [];
  const blocks = [[13, 47], [53, 87]];
  rows.forEach(([top, ai], ri) => {
    for (const [bx0, bx1] of blocks) {
      const n = Math.floor((bx1 - bx0) / SW);
      for (let k = 0; k < n; k++) {
        const x = bx0 + (k + 0.5) * SW;
        stalls.push({ id: stalls.length, row: ri, aisle: ai, x: +x.toFixed(2), y: +(top + D / 2).toFixed(2), w: SW, h: D });
      }
    }
  });
  const left = 7.6, leftB = 10.4, right = 91.2;
  const entryX = 24, exitX = 78;
  const store = { x0: 20, y0: 2, x1: 80, y1: 14, door: [50, 14.2], name: 'Store' };
  return {
    kind: 'lot',
    source: { provider: 'synthetic', name: 'Synthetic retail center' },
    metersPerUnit: mpu,
    bounds: [0, 0, 100, streetY + 6],
    floors: [{
      id: 'lot', label: 'Parking lot', sequence: 0, bounds: [0, 0, 100, streetY + 6],
      rooms: [], walls: [], openings: [], obstacles: null,
      pois: [
        { id: 'entry_drive', name: 'Lot entrance', kind: 'entry', x: entryX, y: perimeterY + 5, provenance: 'assumed' },
        { id: 'exit_drive', name: 'Lot exit', kind: 'exit', x: exitX, y: perimeterY + 5, provenance: 'assumed' },
        { id: 'search', name: 'Front aisle', kind: 'service', x: 50, y: aisles[0].y, provenance: 'assumed' },
        { id: 'checkout', name: 'Store checkout', kind: 'service', x: 50, y: 8, provenance: 'assumed' }
      ]
    }],
    lot: {
      store, stalls, aisles,
      lanes: { left, leftB, right, perimeterY, streetY, entryX, exitX, lotTop: yRow1, lotBottom: perimeterY + A / 2 },
      walkway: { x0: 47, x1: 53, y0: 17, y1: rows[5][0] + D },
      crosswalk: { x0: 47, x1: 53, y0: 14.5, y1: 22 },
      driveways: [{ id: 'entry_drive', x: entryX, y: perimeterY, kind: 'in' }, { id: 'exit_drive', x: exitX, y: perimeterY, kind: 'out' }],
      image: null
    },
    provenance: { stalls: 'synthetic', lanes: 'synthetic', store: 'synthetic', image: 'none (waiting for Vexcel access)' }
  };
}
