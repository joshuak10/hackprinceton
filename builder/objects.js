// Solid objects inside a building, from the Matterport mesh (docs/PROTOTYPE.md §13f; SWARMSCOPE_SPEC.md §10b).
//
// The vector floor plan (builder/matterport.js) traces walls, columns and other holes in rooms. The 3D mesh also
// holds everything else that stands in the way at walking height: stairs, fixtures, counters, stacked material,
// equipment. meshObjects finds those: it cuts the mesh between 0.3 m and 1.5 m above the floor, drops what the
// floor plan already explains (cells near a wall, inside a column or void, outside every room) and door leaves in
// doorways (people pass there), and outlines each
// remaining solid patch as a polygon in the plan's meters. A world carries them as `objects`, and the engine turns
// each outline into walls (engine/spec.js), so nobody walks through them.
//
// Pure (no Node imports). The mesh is the OBJ text, its bytes, or parseObj output from builder/mesh.js; plan
// coordinates follow builder/mesh.js: (x, y) for a z-up mesh, (x, -z) for y-up, which is Matterport's own frame.
import { parseObj } from './mesh.js';

export const OBJECT_DEFAULTS = {
  zMin: 0.3,          // meters above the floor: lower things (cables, floor noise) are stepped over
  zMax: 1.5,          // meters above the floor: higher things (signs, shelves overhead) are walked under
  cell: 0.1,          // grid cell, meters
  nearWall: 0.5,      // mesh within this distance of a floor-plan wall is that wall's surface, trim or glazing
  doorClear: 0.8,     // mesh within this distance of a doorway, across its width, is a door leaf: doors open
  minArea: 0.03,      // patches smaller than this (m²) are scan noise
  simplify: 0.08,     // outline simplification tolerance, meters
  maxPoints: 48       // most outline points per object
};
const COS_10 = Math.cos(10 * Math.PI / 180);
const LEVEL_BIN = 0.05;   // meters per height bin when finding floors
const LEVEL_JOIN = 0.4;   // floor bins this close in height belong to one floor

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = v => (Array.isArray(v) ? v : []);
const r3 = v => Math.round(v * 1000) / 1000 + 0;
const r2 = v => Math.round(v * 100) / 100 + 0;

function inPolygon(pts, x, y) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

function segDist(px, py, s) {
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1, len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - s.x1) * dx + (py - s.y1) * dy) / len2)) : 0;
  return Math.hypot(s.x1 + t * dx - px, s.y1 + t * dy - py);
}

function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; }
  return a / 2;
}

// Plan coordinates and heights for every vertex, for a z-up or y-up mesh.
function planFrame(mesh, up) {
  const V = mesh.vertices, n = V.length / 3;
  const X = new Float64Array(n), Y = new Float64Array(n), H = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    X[i] = V[3 * i];
    if (up === 'z') { Y[i] = V[3 * i + 1]; H[i] = V[3 * i + 2]; } else { Y[i] = -V[3 * i + 2]; H[i] = V[3 * i + 1]; }
  }
  return { X, Y, H };
}

// z unless horizontal surfaces clearly say y (Matterport documents z-up).
export function meshUpAxis(mesh) {
  const V = mesh.vertices, F = mesh.faces;
  let ay = 0, az = 0;
  for (let t = 0; t < F.length; t += 3) {
    const a = 3 * F[t], b = 3 * F[t + 1], c = 3 * F[t + 2];
    const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
    const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0)) continue;
    if (Math.abs(ny) >= COS_10 * len) ay += len / 2;
    else if (Math.abs(nz) >= COS_10 * len) az += len / 2;
  }
  return ay > 1.5 * az ? 'y' : 'z';
}

// Heights of the building's floors, lowest first: clusters of upward-facing horizontal surface holding at least a
// quarter of the largest cluster. `inside(x, y)` limits the count to a footprint.
export function floorLevels(mesh, { up = meshUpAxis(mesh), inside = null } = {}) {
  const { X, Y, H } = planFrame(mesh, up);
  const F = mesh.faces, bins = new Map();
  for (let t = 0; t < F.length; t += 3) {
    const a = F[t], b = F[t + 1], c = F[t + 2];
    const ux = X[b] - X[a], uy = Y[b] - Y[a], uh = H[b] - H[a];
    const vx = X[c] - X[a], vy = Y[c] - Y[a], vh = H[c] - H[a];
    const nh = ux * vy - uy * vx;
    const len = Math.hypot(uy * vh - uh * vy, uh * vx - ux * vh, nh);
    if (!(len > 0) || nh < COS_10 * len) continue;   // upward-facing only: floors, not ceilings
    if (inside && !inside((X[a] + X[b] + X[c]) / 3, (Y[a] + Y[b] + Y[c]) / 3)) continue;
    const h = (H[a] + H[b] + H[c]) / 3, key = Math.floor(h / LEVEL_BIN), bin = bins.get(key);
    if (bin) { bin.area += len / 2; bin.sum += h * len / 2; } else bins.set(key, { area: len / 2, sum: h * len / 2 });
  }
  // Only bins with real floor in them are joined, so scattered small surfaces cannot chain two floors together.
  const peak = Math.max(0, ...[...bins.values()].map(b => b.area));
  const sorted = [...bins.entries()].filter(([, b]) => b.area >= Math.max(0.02 * peak, 0.5)).sort((p, q) => p[0] - q[0]);
  const clusters = [];
  for (const [key, bin] of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && (key - last.key) * LEVEL_BIN <= LEVEL_JOIN) { last.area += bin.area; last.sum += bin.sum; last.key = key; }
    else clusters.push({ key, area: bin.area, sum: bin.sum });
  }
  const max = Math.max(0, ...clusters.map(c => c.area));
  return clusters.filter(c => c.area >= Math.max(0.25 * max, 1)).map(c => ({ height: c.sum / c.area, areaM2: c.area }));
}

// Mark grid cells that a triangle's part between heights lo and hi covers, seen from above.
function clipAt(poly, level, keepAbove) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const pin = keepAbove ? p[2] >= level : p[2] <= level, qin = keepAbove ? q[2] >= level : q[2] <= level;
    if (pin) out.push(p);
    if (pin !== qin) {
      const t = (level - p[2]) / (q[2] - p[2]);
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), level]);
    }
  }
  return out;
}

function rasterize(mesh, frame, { lo, hi, x0, y1, w, h, cell }) {
  const { X, Y, H } = frame, F = mesh.faces, data = new Uint8Array(w * h);
  const mark = (x, y) => {
    const c = Math.floor((x - x0) / cell), r = Math.floor((y1 - y) / cell);
    if (c >= 0 && c < w && r >= 0 && r < h) data[r * w + c] = 1;
  };
  const line = (ax, ay, bx, by) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (cell * 0.5)));
    for (let s = 0; s <= steps; s++) mark(ax + (bx - ax) * s / steps, ay + (by - ay) * s / steps);
  };
  const x1 = x0 + w * cell, y0 = y1 - h * cell;
  for (let t = 0; t < F.length; t += 3) {
    const a = F[t], b = F[t + 1], c = F[t + 2];
    if (Math.max(H[a], H[b], H[c]) < lo || Math.min(H[a], H[b], H[c]) > hi) continue;
    if (Math.max(X[a], X[b], X[c]) < x0 || Math.min(X[a], X[b], X[c]) > x1) continue;
    if (Math.max(Y[a], Y[b], Y[c]) < y0 || Math.min(Y[a], Y[b], Y[c]) > y1) continue;
    const poly = clipAt(clipAt([[X[a], Y[a], H[a]], [X[b], Y[b], H[b]], [X[c], Y[c], H[c]]], lo, true), hi, false);
    if (poly.length < 2) continue;
    // Edges catch thin upright surfaces; the fill catches flat ones (tabletops, counters, stair treads).
    for (let k = 0; k < poly.length; k++) line(poly[k][0], poly[k][1], poly[(k + 1) % poly.length][0], poly[(k + 1) % poly.length][1]);
    if (poly.length < 3) continue;
    let mx0 = Infinity, my0 = Infinity, mx1 = -Infinity, my1 = -Infinity;
    for (const p of poly) { mx0 = Math.min(mx0, p[0]); mx1 = Math.max(mx1, p[0]); my0 = Math.min(my0, p[1]); my1 = Math.max(my1, p[1]); }
    if (mx1 - mx0 <= cell && my1 - my0 <= cell) continue;
    const pts = poly.map(p => ({ x: p[0], y: p[1] }));
    for (let y = y1 - (Math.floor((y1 - my1) / cell) + 0.5) * cell; y >= my0; y -= cell) {
      for (let x = x0 + (Math.floor((mx0 - x0) / cell) + 0.5) * cell; x <= mx1; x += cell) if (inPolygon(pts, x, y)) mark(x, y);
    }
  }
  return data;
}

// Outer outline of one 4-connected patch of cells, as a closed loop of cell corners (counterclockwise in plan).
function traceOutline(cells, w, x0, y1, cell) {
  const filled = new Set(cells);
  const at = (r, c) => r >= 0 && c >= 0 && c < w && filled.has(r * w + c);
  // Directed boundary edges with the patch on the left, keyed by their start corner.
  const next = new Map();
  const add = (ar, ac, br, bc) => {
    const k = `${ar},${ac}`;
    if (!next.has(k)) next.set(k, []);
    next.get(k).push([br, bc]);
  };
  for (const i of cells) {
    const r = Math.floor(i / w), c = i % w;   // corners: (row, col) at the cell's top-left
    if (!at(r - 1, c)) add(r, c + 1, r, c);       // top edge, right to left
    if (!at(r + 1, c)) add(r + 1, c, r + 1, c + 1); // bottom edge, left to right
    if (!at(r, c - 1)) add(r, c, r + 1, c);       // left edge, downward
    if (!at(r, c + 1)) add(r + 1, c + 1, r, c + 1); // right edge, upward
  }
  const loops = [];
  while (next.size) {
    const [startKey] = next.keys();
    let [r, c] = startKey.split(',').map(Number);
    const loop = [];
    for (let guard = 0; guard < 4 * cells.length + 8; guard++) {
      const k = `${r},${c}`, outs = next.get(k);
      if (!outs) break;
      const [nr, nc] = outs.pop();
      if (!outs.length) next.delete(k);
      loop.push({ x: x0 + c * cell, y: y1 - r * cell });
      r = nr; c = nc;
      if (`${r},${c}` === startKey && !next.has(startKey)) break;
    }
    if (loop.length >= 4) loops.push(loop);
  }
  // The outer outline encloses the most area; holes inside a patch are filled.
  loops.sort((p, q) => Math.abs(polygonArea(q)) - Math.abs(polygonArea(p)));
  return loops[0] ? dropCollinear(loops[0]) : [];
}

function dropCollinear(loop) {
  const out = [];
  for (let i = 0; i < loop.length; i++) {
    const p = loop[(i + loop.length - 1) % loop.length], q = loop[i], s = loop[(i + 1) % loop.length];
    if (Math.abs((q.x - p.x) * (s.y - p.y) - (q.y - p.y) * (s.x - p.x)) > 1e-12) out.push(q);
  }
  return out;
}

// Douglas-Peucker on a closed loop, split at its two farthest-apart points.
function simplifyLoop(loop, tol) {
  if (loop.length <= 4) return loop;
  const dp = (pts) => {
    if (pts.length <= 2) return pts;
    const a = pts[0], b = pts[pts.length - 1];
    let best = -1, bestD = tol;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = segDist(pts[i].x, pts[i].y, { x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best < 0) return [a, b];
    return [...dp(pts.slice(0, best + 1)).slice(0, -1), ...dp(pts.slice(best))];
  };
  let far = 0, fd = -1;
  for (let i = 1; i < loop.length; i++) { const d = Math.hypot(loop[i].x - loop[0].x, loop[i].y - loop[0].y); if (d > fd) { fd = d; far = i; } }
  const first = dp(loop.slice(0, far + 1)), second = dp([...loop.slice(far), loop[0]]);
  const out = [...first.slice(0, -1), ...second.slice(0, -1)];
  return out.length >= 3 ? out : loop;
}

/**
 * Find the solid objects on one floor of a building.
 * @param {string|Uint8Array|{vertices, faces}} meshInput  OBJ text, bytes, or parseObj output
 * @param {object} plan  extractFloorplan output (meters): walls, doors, rooms (polygon, holes, classification), floor
 * @param {object} [options]  OBJECT_DEFAULTS fields, plus `up` ('z'|'y'), `floorHeight` (mesh units along up)
 *   and `floorIndex` (which floor level, lowest = 0; default: the plan floor's sequence)
 * @returns {{ objects: {id, name, kind, source, polygon: {x, y}[], areaM2, sizeM: [number, number], room}[],
 *   floorHeight: number|null, levels: number[], up: 'z'|'y', dropped: { specks: number, areaM2: number },
 *   meshCells: number, warnings: string[] }}
 */
export function meshObjects(meshInput, plan, options = {}) {
  const o = { ...OBJECT_DEFAULTS, ...options };
  const warnings = [];
  if (!isObj(plan) || plan.units === 'map') throw new TypeError('meshObjects: expected a floor plan in meters from extractFloorplan');
  const mesh = meshInput && meshInput.vertices && meshInput.faces ? meshInput : parseObj(meshInput);
  const up = o.up ?? meshUpAxis(mesh);
  const empty = extra => ({ objects: [], floorHeight: null, levels: [], up, dropped: { specks: 0, areaM2: 0 }, meshCells: 0, warnings, ...extra });
  if (!mesh.faces.length) { warnings.push('the mesh has no faces, so no objects were found'); return empty(); }

  // Rooms people walk in: not voids (Matterport's nonArea regions), and never inside a column or other hole.
  const rooms = arr(plan.rooms).filter(r => arr(r.polygon).length >= 3 && !/^void$/i.test(String(r.classification ?? '')));
  const roomAt = (x, y) => rooms.find(r => inPolygon(r.polygon, x, y) && !arr(r.holes).some(hl => inPolygon(hl, x, y)));
  if (!rooms.length) { warnings.push('the floor plan has no rooms to look for objects in'); return empty(); }

  const levels = floorLevels(mesh, { up, inside: (x, y) => rooms.some(r => inPolygon(r.polygon, x, y)) }).map(l => l.height);
  let floorHeight = Number.isFinite(o.floorHeight) ? o.floorHeight : null;
  if (floorHeight === null) {
    const want = Number.isInteger(o.floorIndex) ? o.floorIndex : Number.isFinite(plan.floor?.sequence) ? plan.floor.sequence : 0;
    if (!levels.length) { warnings.push('found no floor in the mesh under this floor plan; pass floorHeight'); return empty({ levels }); }
    if (want >= levels.length) {
      warnings.push(`the mesh shows ${levels.length} floor level(s) under this plan but floor ${want} was asked for; pass floorHeight`);
      return empty({ levels });
    }
    floorHeight = levels[want];
  }

  // A grid over the rooms, in plan meters, rows counted down from the top.
  const xs = rooms.flatMap(r => r.polygon.map(p => p.x)), ys = rooms.flatMap(r => r.polygon.map(p => p.y));
  const cell = o.cell, x0 = Math.min(...xs) - cell, y1 = Math.max(...ys) + cell;
  const w = Math.ceil((Math.max(...xs) + cell - x0) / cell), h = Math.ceil((y1 - Math.min(...ys) + cell) / cell);
  if (w * h > 25e6) throw new RangeError(`meshObjects: a ${w} x ${h} grid is too large; use a larger cell`);
  const frame = planFrame(mesh, up);
  const raw = rasterize(mesh, frame, { lo: floorHeight + o.zMin, hi: floorHeight + o.zMax, x0, y1, w, h, cell });

  const walls = arr(plan.walls);
  // Doorways: a closed door, a glass storefront door or an open leaf shows in the scan, but people pass there.
  const doors = arr(plan.doors).filter(d => [d?.x1, d?.y1, d?.x2, d?.y2].every(Number.isFinite)).map(d => {
    const len = Math.hypot(d.x2 - d.x1, d.y2 - d.y1) || 1;
    return { ...d, len, ux: (d.x2 - d.x1) / len, uy: (d.y2 - d.y1) / len };
  });
  const inDoorway = (x, y) => doors.some(d => {
    const t = (x - d.x1) * d.ux + (y - d.y1) * d.uy, n = Math.abs((x - d.x1) * -d.uy + (y - d.y1) * d.ux);
    return n <= o.doorClear && t >= -0.2 && t <= d.len + 0.2;
  });
  const keep = new Uint8Array(w * h);
  let meshCells = 0;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const i = r * w + c;
    if (!raw[i]) continue;
    meshCells++;
    const x = x0 + (c + 0.5) * cell, y = y1 - (r + 0.5) * cell;
    if (!roomAt(x, y)) continue;
    if (walls.some(s => segDist(x, y, s) < o.nearWall)) continue;
    if (inDoorway(x, y)) continue;
    keep[i] = 1;
  }

  // Patches of touching cells (8-connected); each one big enough is an object.
  const seen = new Uint8Array(w * h), found = [];
  let specks = 0, speckArea = 0;
  for (let i = 0; i < keep.length; i++) {
    if (!keep[i] || seen[i]) continue;
    const stack = [i], cells = [];
    seen[i] = 1;
    while (stack.length) {
      const k = stack.pop(), r = Math.floor(k / w), c = k % w;
      cells.push(k);
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
        const j = rr * w + cc;
        if (keep[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    const area = cells.length * cell * cell;
    if (area < o.minArea) { specks++; speckArea += area; continue; }
    // Diagonal-only contacts would trace as separate loops; fill each cell's 4-neighbour gaps first.
    const solid = new Set(cells);
    for (const k of cells) {
      const r = Math.floor(k / w), c = k % w;
      for (const [dr, dc] of [[1, 1], [1, -1]]) {
        const rr = r + dr, cc = c + dc;
        if (rr < h && cc >= 0 && cc < w && solid.has(rr * w + cc) && !solid.has(r * w + cc) && !solid.has(rr * w + c)) solid.add(r * w + cc);
      }
    }
    let outline = traceOutline([...solid], w, x0, y1, cell);
    let tol = o.simplify;
    let simple = simplifyLoop(outline, tol);
    while (simple.length > o.maxPoints && tol < 1) { tol *= 1.5; simple = simplifyLoop(outline, tol); }
    if (polygonArea(simple) < 0) simple.reverse();
    const px = simple.map(p => p.x), py = simple.map(p => p.y);
    const cx = (Math.min(...px) + Math.max(...px)) / 2, cy = (Math.min(...py) + Math.max(...py)) / 2;
    found.push({
      polygon: simple.map(p => ({ x: r3(p.x), y: r3(p.y) })),
      areaM2: r2(area), sizeM: [r2(Math.max(...px) - Math.min(...px)), r2(Math.max(...py) - Math.min(...py))],
      room: roomAt(cx, cy)?.id ?? null, cx, cy
    });
  }
  // Largest first, then by position, so ids stay the same for the same mesh and options.
  found.sort((p, q) => q.areaM2 - p.areaM2 || p.cx - q.cx || p.cy - q.cy);
  const objects = found.map(({ cx, cy, ...f }, k) => ({
    id: `obj${k + 1}`, name: `Object ${k + 1} (${f.sizeM[0]} x ${f.sizeM[1]} m)`, kind: 'object', source: 'mesh-slice', ...f
  }));
  if (!objects.length) warnings.push('no solid objects found between the walls at walking height');
  return { objects, floorHeight, levels, up, dropped: { specks, areaM2: r2(speckArea) }, meshCells, warnings };
}
