// Walkable grid for one floor: where agents can stand, how they get from A to B, and which openings lead
// outside. Built from the floor plan (walls with opening gaps), the mesh slice (obstacles at walking height)
// and scan points (known-inside seeds). Plain JS for Node and the browser (docs/PROTOTYPE.md §9b).
import { decodeObstacles } from './obj-slice.js';
import { pointInRoom } from './matterport.js';

const SQRT2 = Math.SQRT2;

export function cellIndex(g, x, y) {
  const c = Math.floor(x / g.cell), r = Math.floor(y / g.cell);
  if (c < 0 || r < 0 || c >= g.w || r >= g.h) return -1;
  return r * g.w + c;
}

export function cellCenter(g, i) {
  return [((i % g.w) + 0.5) * g.cell, (Math.floor(i / g.w) + 0.5) * g.cell];
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  let t = L > 0 ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function stampSegment(g, arr, ax, ay, bx, by, halfWidth, value) {
  const pad = halfWidth + g.cell;
  const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - pad) / g.cell)), c1 = Math.min(g.w - 1, Math.floor((Math.max(ax, bx) + pad) / g.cell));
  const r0 = Math.max(0, Math.floor((Math.min(ay, by) - pad) / g.cell)), r1 = Math.min(g.h - 1, Math.floor((Math.max(ay, by) + pad) / g.cell));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const x = (c + 0.5) * g.cell, y = (r + 0.5) * g.cell;
    if (distToSegment(x, y, ax, ay, bx, by) <= halfWidth) arr[r * g.w + c] = value;
  }
}

// Mark cells inside a rotated rectangle centred on (cx, cy): half-length `hl` along angle `a`, half-depth `hd` across.
function stampRect(g, arr, cx, cy, a, hl, hd, value) {
  const ux = Math.cos(a), uy = Math.sin(a), nx = -uy, ny = ux;
  const ext = Math.hypot(hl, hd) + g.cell;
  const c0 = Math.max(0, Math.floor((cx - ext) / g.cell)), c1 = Math.min(g.w - 1, Math.floor((cx + ext) / g.cell));
  const r0 = Math.max(0, Math.floor((cy - ext) / g.cell)), r1 = Math.min(g.h - 1, Math.floor((cy + ext) / g.cell));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const dx = (c + 0.5) * g.cell - cx, dy = (r + 0.5) * g.cell - cy;
    if (Math.abs(dx * ux + dy * uy) <= hl && Math.abs(dx * nx + dy * ny) <= hd) arr[r * g.w + c] = value;
  }
}

function flood4(g, passable, seeds) {
  const out = new Uint8Array(g.w * g.h);
  const stack = [];
  for (const i of seeds) if (i >= 0 && passable[i] && !out[i]) { out[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop();
    const c = i % g.w, r = (i - c) / g.w;
    const nb = [c > 0 ? i - 1 : -1, c < g.w - 1 ? i + 1 : -1, r > 0 ? i - g.w : -1, r < g.h - 1 ? i + g.w : -1];
    for (const j of nb) if (j >= 0 && passable[j] && !out[j]) { out[j] = 1; stack.push(j); }
  }
  return out;
}

/**
 * buildWalkGrid(floor, { metersPerUnit, cellM = 0.5, seeds })
 * seeds: [[x, y], ...] map points known to be inside (scan points). Defaults to room centres.
 * Returns { w, h, cell, free, region, openings } where openings carry side: 'exterior' | 'interior' | 'none',
 * an inward normal and, for exterior ones, a spawn point just outside.
 */
export function buildWalkGrid(floor, { metersPerUnit, cellM = 0.5, seeds = null } = {}) {
  const m = 1 / metersPerUnit;                 // map units per metre
  const cell = cellM * m;
  const [, , W, H] = floor.bounds;
  const g = { w: Math.ceil(W / cell), h: Math.ceil(H / cell), cell };
  const N = g.w * g.h;

  // Walls, with a floor of half a cell so thin walls still block.
  const walls = new Uint8Array(N);
  for (const [ax, ay, bx, by, t] of floor.walls) stampSegment(g, walls, ax, ay, bx, by, Math.max(t / 2, cell * 0.5), 1);

  // Region inside the building: flood from seeds with every opening closed, clipped to the rooms.
  const closed = walls.slice();
  for (const o of floor.openings) {
    const hl = o.width / 2 + cell * 0.5;
    stampSegment(g, closed, o.x - Math.cos(o.angle) * hl, o.y - Math.sin(o.angle) * hl, o.x + Math.cos(o.angle) * hl, o.y + Math.sin(o.angle) * hl, Math.max(o.thickness / 2, cell * 0.5), 1);
  }
  const inRooms = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const [x, y] = cellCenter(g, i);
    if (floor.rooms.some(r => pointInRoom(x, y, r))) inRooms[i] = 1;
  }
  // Allow a one-cell rim so cells on a room edge (under the wall line) still count.
  const roomsRim = inRooms.slice();
  for (let i = 0; i < N; i++) if (inRooms[i]) {
    const c = i % g.w, r = (i - c) / g.w;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const cc = c + dc, rr = r + dr;
      if (cc >= 0 && rr >= 0 && cc < g.w && rr < g.h) roomsRim[rr * g.w + cc] = 1;
    }
  }
  const passable = new Uint8Array(N);
  for (let i = 0; i < N; i++) passable[i] = !closed[i] && roomsRim[i] ? 1 : 0;
  const seedPts = seeds && seeds.length ? seeds : floor.rooms.map(r => roomPoint(r)).filter(Boolean);
  const region = flood4(g, passable, seedPts.map(([x, y]) => cellIndex(g, x, y)));

  // Classify openings by which sides are inside the building.
  const inside = (x, y) => {
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const i = cellIndex(g, x + dc * cell * 0.5, y + dr * cell * 0.5);
      if (i >= 0 && region[i]) return true;
    }
    return false;
  };
  const openings = floor.openings.map(o => {
    const nx = -Math.sin(o.angle), ny = Math.cos(o.angle);
    const d = o.thickness / 2 + 0.9 * m;
    const a = inside(o.x + nx * d, o.y + ny * d), b = inside(o.x - nx * d, o.y - ny * d);
    // Openings narrower than 0.6 m are scan artifacts or gaps nobody walks through.
    const tooNarrow = (o.widthM ?? o.width * metersPerUnit) < 0.6;
    const side = tooNarrow ? 'none' : a && b ? 'interior' : (a || b) ? 'exterior' : 'none';
    const inward = a ? [nx, ny] : [-nx, -ny];
    const out = { ...o, side, exterior: side === 'exterior', inward };
    // Just outside the door, inside the plan's 1.5 m margin so it stays on the grid.
    if (side === 'exterior') out.spawn = [o.x - inward[0] * 1.1 * m, o.y - inward[1] * 1.1 * m];
    return out;
  });

  // Free cells: inside, not wall, not mesh.
  const free = new Uint8Array(N);
  for (let i = 0; i < N; i++) free[i] = region[i] && !walls[i] ? 1 : 0;
  const obs = decodeObstacles(floor.obstacles);
  if (obs) {
    const count = new Uint8Array(N), total = new Uint8Array(N);
    for (let r = 0; r < obs.h; r++) for (let c = 0; c < obs.w; c++) {
      const x = obs.origin[0] + (c + 0.5) * obs.cell, y = obs.origin[1] + (r + 0.5) * obs.cell;
      const i = cellIndex(g, x, y);
      if (i < 0) continue;
      total[i]++;
      if (obs.data[r * obs.w + c]) count[i]++;
    }
    for (let i = 0; i < N; i++) if (total[i] && count[i] / total[i] >= 0.4) free[i] = 0;
  }

  // Carve openings last so a door closed during the scan, or a door frame in the mesh, can't seal a room.
  for (const o of openings) {
    if (o.side === 'none') continue;
    const hl = Math.max(cell * 0.6, o.width / 2 - 0.1 * m);
    stampRect(g, free, o.x, o.y, o.angle, hl, o.thickness / 2 + cell * 1.5, 1);
    if (o.side === 'exterior') {
      // An approach strip outside, so people can arrive and leave through it.
      const L = 1.5 * m;
      stampRect(g, free, o.x - o.inward[0] * L / 2, o.y - o.inward[1] * L / 2, o.angle, hl, L / 2, 1);
    }
  }
  // Seeds stay walkable (a scan point is a place someone stood).
  for (const [x, y] of seedPts) { const i = cellIndex(g, x, y); if (i >= 0 && region[i]) free[i] = 1; }

  return { ...g, free, region, openings };
}

function roomPoint(room) {
  const xs = room.poly.map(p => p[0]), ys = room.poly.map(p => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  if (pointInRoom(cx, cy, room)) return [cx, cy];
  for (let k = 0; k < 200; k++) {
    const x = Math.min(...xs) + ((k * 0.618) % 1) * (Math.max(...xs) - Math.min(...xs));
    const y = Math.min(...ys) + ((k * 0.382) % 1) * (Math.max(...ys) - Math.min(...ys));
    if (pointInRoom(x, y, room)) return [x, y];
  }
  return null;
}

// Nearest free cell to a point (breadth-first over all cells). Returns -1 if the grid has none.
export function nearestFree(g, x, y) {
  let start = cellIndex(g, Math.min(Math.max(x, 0), g.w * g.cell - 1e-6), Math.min(Math.max(y, 0), g.h * g.cell - 1e-6));
  if (start < 0) return -1;
  if (g.free[start]) return start;
  const seen = new Uint8Array(g.w * g.h);
  const q = [start];
  seen[start] = 1;
  for (let k = 0; k < q.length; k++) {
    const i = q[k];
    if (g.free[i]) return i;
    const c = i % g.w, r = (i - c) / g.w;
    for (const j of [c > 0 ? i - 1 : -1, c < g.w - 1 ? i + 1 : -1, r > 0 ? i - g.w : -1, r < g.h - 1 ? i + g.w : -1]) {
      if (j >= 0 && !seen[j]) { seen[j] = 1; q.push(j); }
    }
  }
  return -1;
}

// 8-connected neighbours that don't cut a blocked corner.
export function neighbours(g, i) {
  const c = i % g.w, r = (i - c) / g.w;
  const out = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const cc = c + dc, rr = r + dr;
    if (cc < 0 || rr < 0 || cc >= g.w || rr >= g.h) continue;
    const j = rr * g.w + cc;
    if (!g.free[j]) continue;
    if (dr && dc && (!g.free[r * g.w + cc] || !g.free[rr * g.w + c])) continue;
    out.push([j, dr && dc ? SQRT2 : 1]);
  }
  return out;
}

// Walking distance (in cells) from every cell to the nearest target cell. Infinity where unreachable.
export function distanceField(g, targets) {
  const N = g.w * g.h;
  // Float64: a Float32 store makes `d > dist[i]` true after rounding and silently drops cells.
  const dist = new Float64Array(N).fill(Infinity);
  const heap = new MinHeap();
  for (const t of targets) if (t >= 0 && g.free[t]) { dist[t] = 0; heap.push(0, t); }
  while (heap.size) {
    const [d, i] = heap.pop();
    if (d > dist[i]) continue;
    for (const [j, w] of neighbours(g, i)) {
      const nd = d + w;
      if (nd < dist[j]) { dist[j] = nd; heap.push(nd, j); }
    }
  }
  return dist;
}

// The neighbour that is closest to the field's target, or -1 if already there or stuck.
export function nextStep(g, field, i, isOpen = null) {
  let best = -1, bestD = field[i];
  for (const [j] of neighbours(g, i)) {
    if (isOpen && !isOpen(j)) continue;
    if (field[j] < bestD - 1e-6) { bestD = field[j]; best = j; }
  }
  return best;
}

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop() {
    const k = this.k, v = this.v;
    const top = [k[0], v[0]];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}
