// Mesh-slice wall builder (docs/PROTOTYPE.md §13e): the fallback source of walls for Matterport
// models that have no vector room data. The model's OBJ mesh is cut with horizontal planes a little
// above the floor; walls are vertical and continuous, so they show up at every cut height, while
// most furniture does not. The surviving cuts become 2D wall segments in meters.
//
// meshToWalls pipeline: parse -> find the up axis and the floor -> cut at each height -> keep the
// first height's cuts that lie within mergeTolerance of a cut at every other height -> chain and
// straighten them -> merge collinear pieces -> drop pieces under minLength that close no outline ->
// close cracks at wall ends up to snapTolerance -> round to the millimeter.
//
// meshToWorld turns that result into a starter visit world in map units: the walls, plus placeholder
// places at the most open spots that can be reached on foot (the mesh has no rooms or doors).
//
// parseObj, meshToWalls and meshToWorld are pure (no Node imports), so the browser could load them too.
// fetchMeshObj talks to the Matterport Model API and only loads node:zlib when it has to unzip.
import { createNav } from '../engine/walls.js';

const COS_10 = Math.cos(10 * Math.PI / 180);   // "horizontal" = normal within 10 degrees of up
const UP_MARGIN = 1.5;                         // one up-axis score must beat the other by this factor
const FLOOR_BIN = 0.05;                        // meters per height bin when looking for the floor
const KEY_SCALE = 1e4;                         // cut points are joined when equal to 0.1 mm
const SNAP_TOLERANCE_FACTOR = 2;               // default snapTolerance = 2 x mergeTolerance
const MAX_SLICES = 16;                         // each slice after the first takes one bit of the mask

// ---------- OBJ parsing ----------

function toBytes(input) {
  if (typeof input === 'string') return new TextEncoder().encode(input);
  if (input instanceof Uint8Array) return input;          // includes Node Buffers
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError('parseObj: expected OBJ text as a string or bytes');
}

function grow(arr, need) {
  let size = arr.length * 2;
  while (size < need) size *= 2;
  const next = new arr.constructor(size);
  next.set(arr);
  return next;
}

/**
 * Parse the geometry of a Wavefront OBJ file in one pass over its bytes.
 * Reads `v` and `f` lines only. Face references may be `v`, `v/vt`, `v//vn` or `v/vt/vn`, and
 * negative (relative) indices are resolved against the vertices read so far. Polygons are fan
 * triangulated. Faces that reference missing or non-finite vertices are dropped with a warning.
 * @param {string|Uint8Array|ArrayBuffer} input
 * @returns {{ vertices: Float64Array, faces: Uint32Array, warnings: string[] }}
 *   vertices is flat [x, y, z, ...]; faces is flat [a, b, c, ...] of 0-based vertex indices.
 */
export function parseObj(input) {
  const bytes = toBytes(input);
  const n = bytes.length;
  let p = 0;
  let verts = new Float64Array(3 * 4096);
  let vLen = 0;
  let tris = new Int32Array(3 * 8192);
  let tLen = 0;
  let poly = new Int32Array(16);
  let badFaces = 0;

  // Fast decimal parser for the common "-12.345e-6" shapes; anything unusual falls back to Number().
  const readFloat = () => {
    let c = bytes[p];
    while (c === 32 || c === 9) c = bytes[++p];
    const start = p;
    let neg = false;
    if (c === 45) { neg = true; c = bytes[++p]; } else if (c === 43) c = bytes[++p];
    let mant = 0, exp10 = 0, any = false;
    while (c >= 48 && c <= 57) {
      if (mant < 9e14) mant = mant * 10 + (c - 48); else exp10++;
      any = true;
      c = bytes[++p];
    }
    if (c === 46) {
      c = bytes[++p];
      while (c >= 48 && c <= 57) {
        if (mant < 9e14) { mant = mant * 10 + (c - 48); exp10--; }
        any = true;
        c = bytes[++p];
      }
    }
    if (any && (c === 101 || c === 69)) {
      let q = p + 1, ec = bytes[q], eneg = false, e = 0, eany = false;
      if (ec === 45) { eneg = true; ec = bytes[++q]; } else if (ec === 43) ec = bytes[++q];
      while (ec >= 48 && ec <= 57) { e = e * 10 + (ec - 48); eany = true; ec = bytes[++q]; }
      if (eany) { exp10 += eneg ? -e : e; p = q; c = ec; }
    }
    if (any && (p >= n || c === 32 || c === 9 || c === 10 || c === 13)) {
      const v = exp10 === 0 ? mant : exp10 > 0 ? mant * 10 ** exp10 : mant / 10 ** -exp10;
      return neg ? -v : v;
    }
    if (start >= n || c === 10 || c === 13) return NaN;   // missing coordinate
    while (p < n && c !== 32 && c !== 9 && c !== 10 && c !== 13) c = bytes[++p];
    if (p - start > 64) return NaN;   // not a number any OBJ writer produces
    return Number(String.fromCharCode.apply(null, bytes.subarray(start, p)));
  };

  while (p < n) {
    let c = bytes[p];
    while (c === 32 || c === 9) c = bytes[++p];
    const next = bytes[p + 1];
    if (c === 118 && (next === 32 || next === 9)) {                       // "v x y z"
      p += 2;
      if (vLen + 3 > verts.length) verts = grow(verts, vLen + 3);
      verts[vLen++] = readFloat();
      verts[vLen++] = readFloat();
      verts[vLen++] = readFloat();
    } else if (c === 102 && (next === 32 || next === 9)) {                // "f a b c ..."
      p += 2;
      const vCount = vLen / 3;
      let k = 0, bad = false;
      for (;;) {
        c = bytes[p];
        while (c === 32 || c === 9) c = bytes[++p];
        if (p >= n || c === 10 || c === 13 || c === 35) break;
        let neg = false;
        if (c === 45) { neg = true; c = bytes[++p]; } else if (c === 43) c = bytes[++p];
        let v = 0, any = false;
        while (c >= 48 && c <= 57) { v = v * 10 + (c - 48); any = true; c = bytes[++p]; }
        while (p < n && c !== 32 && c !== 9 && c !== 10 && c !== 13) c = bytes[++p];  // skip /vt/vn
        const idx = neg ? vCount - v : v - 1;
        if (!any || v === 0 || idx < 0) { bad = true; continue; }
        if (k === poly.length) poly = grow(poly, k + 1);
        poly[k++] = idx;
      }
      if (bad || k < 3) badFaces++;
      else {
        const need = tLen + 3 * (k - 2);
        if (need > tris.length) tris = grow(tris, need);
        for (let j = 1; j < k - 1; j++) {
          tris[tLen++] = poly[0];
          tris[tLen++] = poly[j];
          tris[tLen++] = poly[j + 1];
        }
      }
    }
    while (p < n && bytes[p] !== 10) p++;
    p++;
  }

  // Positive indices may point past the end of the file, and vertices may be non-finite: drop those
  // triangles in one compaction pass.
  const vCount = vLen / 3;
  const vertices = verts.slice(0, vLen);
  const finite = new Uint8Array(vCount);
  for (let i = 0; i < vCount; i++) {
    finite[i] = Number.isFinite(vertices[3 * i]) && Number.isFinite(vertices[3 * i + 1]) &&
      Number.isFinite(vertices[3 * i + 2]) ? 1 : 0;
  }
  let out = 0, dropped = 0;
  for (let t = 0; t < tLen; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    if (a < vCount && b < vCount && c < vCount && finite[a] && finite[b] && finite[c]) {
      tris[out++] = a; tris[out++] = b; tris[out++] = c;
    } else dropped++;
  }
  const warnings = [];
  if (badFaces) warnings.push(`skipped ${badFaces} face line(s) with fewer than 3 vertices or a bad index`);
  if (dropped) warnings.push(`dropped ${dropped} triangle(s) that use missing or non-finite vertices`);
  return { vertices, faces: Uint32Array.from(tris.subarray(0, out)), warnings };
}

// ---------- up axis and floor ----------

// Spread of a coordinate between its 1st and 99th percentile (stray scan triangles are ignored).
function robustRange(values) {
  const step = Math.max(1, Math.floor(values.length / 100000));
  const sample = [];
  for (let i = 0; i < values.length; i += step) if (Number.isFinite(values[i])) sample.push(values[i]);
  if (!sample.length) return { lo: 0, hi: 0 };
  const s = Float64Array.from(sample).sort();
  return { lo: s[Math.floor(0.01 * (s.length - 1))], hi: s[Math.ceil(0.99 * (s.length - 1))] };
}

function axisValues(V, axis) {
  const out = new Float64Array(V.length / 3);
  for (let i = 0; i < out.length; i++) out[i] = V[3 * i + axis];
  return out;
}

// Heuristic: x is horizontal in both common conventions, so up is y or z. Up is the candidate with
// the most "aligned" triangle area (normal within 10 degrees of the axis) per meter of the mesh's
// extent along that axis. Floors and ceilings pack a lot of horizontal area into a short height
// range, while walls facing a horizontal axis are spread across the whole plan. (Plain aligned area
// alone is not enough: long rooms have more wall area facing one way than floor area.) Small
// enclosures with no ceiling can still fool it, so y must score UP_MARGIN times z to win.
function detectUp(V, F) {
  let ay = 0, az = 0;
  for (let t = 0; t < F.length; t += 3) {
    const a = 3 * F[t], b = 3 * F[t + 1], c = 3 * F[t + 2];
    const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
    const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(len > 0)) continue;
    if (Math.abs(ny) >= COS_10 * len) ay += len / 2;
    else if (Math.abs(nz) >= COS_10 * len) az += len / 2;
  }
  const ry = robustRange(axisValues(V, 1)), rz = robustRange(axisValues(V, 2));
  const sy = ay / Math.max(ry.hi - ry.lo, 0.5), sz = az / Math.max(rz.hi - rz.lo, 0.5);
  if (sy === 0 && sz === 0) {
    return { up: 'z', warning: 'could not tell the up axis (no horizontal surfaces); assumed z, as Matterport documents' };
  }
  // Matterport documents z-up, so y has to win clearly; a close call stays z and says so.
  if (sy >= UP_MARGIN * sz) return { up: 'y', warning: null };
  if (sz >= UP_MARGIN * sy) return { up: 'z', warning: null };
  return {
    up: 'z',
    warning: `could not tell the up axis for sure (y score ${sy.toFixed(1)}, z score ${sz.toFixed(1)}); assumed z, as Matterport documents; pass up to be sure`
  };
}

// The floor is the lowest large horizontal surface: bin horizontal triangle area by height and take
// the lowest bin holding at least a quarter of the biggest bin (and at least 1 m² on real models).
function detectFloor(PX, PY, H, F) {
  const bins = new Map();
  for (let t = 0; t < F.length; t += 3) {
    const a = F[t], b = F[t + 1], c = F[t + 2];
    const ux = PX[b] - PX[a], uy = PY[b] - PY[a], uh = H[b] - H[a];
    const vx = PX[c] - PX[a], vy = PY[c] - PY[a], vh = H[c] - H[a];
    const nx = uy * vh - uh * vy, ny = uh * vx - ux * vh, nh = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nh * nh);
    if (!(len > 0) || Math.abs(nh) < COS_10 * len) continue;
    const h = (H[a] + H[b] + H[c]) / 3, area = len / 2;
    const key = Math.floor(h / FLOOR_BIN);
    const bin = bins.get(key);
    if (bin) { bin.area += area; bin.sum += area * h; } else bins.set(key, { area, sum: area * h });
  }
  if (!bins.size) return null;
  let max = 0;
  for (const bin of bins.values()) max = Math.max(max, bin.area);
  const threshold = max >= 4 ? Math.max(0.25 * max, 1) : 0.25 * max;
  let lowest = Infinity;
  for (const [key, bin] of bins) if (bin.area >= threshold && key < lowest) lowest = key;
  let area = 0, sum = 0;
  for (let key = lowest - 1; key <= lowest + 1; key++) {
    const bin = bins.get(key);
    if (bin) { area += bin.area; sum += bin.sum; }
  }
  return sum / area;
}

// ---------- slicing ----------

// Cut every triangle with the plane height = level. Returns flat [x1, y1, x2, y2, ...] in plan
// coordinates. A vertex exactly on the plane counts as above it, so each crossing is cut once, and
// each edge point is computed from the edge's vertices in index order, so neighbouring triangles
// produce bit-identical points (which is what lets the cuts be chained afterwards).
function sliceAt(PX, PY, H, F, level) {
  let segs = new Float64Array(4096);
  let len = 0;
  let ex = 0, ey = 0;
  const edgePoint = (i, j) => {
    const lo = i < j ? i : j, hi = i < j ? j : i;
    const dl = H[lo] - level, dh = H[hi] - level;
    const t = dl / (dl - dh);
    ex = PX[lo] + t * (PX[hi] - PX[lo]);
    ey = PY[lo] + t * (PY[hi] - PY[lo]);
  };
  for (let t = 0; t < F.length; t += 3) {
    const a = F[t], b = F[t + 1], c = F[t + 2];
    const sa = H[a] >= level, sb = H[b] >= level, sc = H[c] >= level;
    if (sa === sb && sb === sc) continue;
    let lone, o1, o2;
    if (sa !== sb && sa !== sc) { lone = a; o1 = b; o2 = c; }
    else if (sb !== sa && sb !== sc) { lone = b; o1 = a; o2 = c; }
    else { lone = c; o1 = a; o2 = b; }
    edgePoint(lone, o1);
    const x1 = ex, y1 = ey;
    edgePoint(lone, o2);
    if (x1 === ex && y1 === ey) continue;
    if (len + 4 > segs.length) segs = grow(segs, len + 4);
    segs[len++] = x1; segs[len++] = y1; segs[len++] = ex; segs[len++] = ey;
  }
  return segs.subarray(0, len);
}

function pointKey(x, y) {
  const qx = Math.round(x * KEY_SCALE), qy = Math.round(y * KEY_SCALE);
  if (Math.abs(qx) < 2 ** 25 && Math.abs(qy) < 2 ** 25) return (qx + 2 ** 25) * 2 ** 26 + (qy + 2 ** 25);
  return `${qx},${qy}`;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return Math.sqrt(qx * qx + qy * qy);
}

// Douglas-Peucker on one chain (iterative). A closed chain starts and ends at the same point, and
// the distance-to-segment test handles that degenerate first span by splitting at the far point.
// The closed chain is first rotated to start at its lowest-x point, which is always a true corner,
// so no corner is lost to an arbitrary mid-edge starting point.
function simplifyChain(xs, ys, eps, out) {
  const m = xs.length;
  if (m > 3 && xs[0] === xs[m - 1] && ys[0] === ys[m - 1]) {
    let e = 0;
    for (let k = 1; k < m - 1; k++) if (xs[k] < xs[e] || (xs[k] === xs[e] && ys[k] < ys[e])) e = k;
    if (e > 0) {
      xs = [...xs.slice(e, m - 1), ...xs.slice(0, e + 1)];
      ys = [...ys.slice(e, m - 1), ...ys.slice(0, e + 1)];
    }
  }
  const keep = new Uint8Array(m);
  keep[0] = 1; keep[m - 1] = 1;
  const stack = [0, m - 1];
  while (stack.length) {
    const j = stack.pop(), i = stack.pop();
    let best = -1, bestD = eps;
    for (let k = i + 1; k < j; k++) {
      const d = distToSegment(xs[k], ys[k], xs[i], ys[i], xs[j], ys[j]);
      if (d > bestD) { bestD = d; best = k; }
    }
    if (best >= 0) { keep[best] = 1; stack.push(i, best, best, j); }
  }
  let prev = 0;
  for (let k = 1; k < m; k++) {
    if (!keep[k]) continue;
    if (xs[k] !== xs[prev] || ys[k] !== ys[prev]) out.push([xs[prev], ys[prev], xs[k], ys[k]]);
    prev = k;
  }
}

// Join cuts into chains through shared points, then straighten each chain into pieces.
function slicePieces(segs, eps) {
  const ids = new Map();
  const nx = [], ny = [];
  const nodeOf = (x, y) => {
    const key = pointKey(x, y);
    let id = ids.get(key);
    if (id === undefined) { id = nx.length; ids.set(key, id); nx.push(x); ny.push(y); }
    return id;
  };
  const count = segs.length / 4;
  const sa = new Int32Array(count), sb = new Int32Array(count);
  let ns = 0;
  for (let s = 0; s < count; s++) {
    const a = nodeOf(segs[4 * s], segs[4 * s + 1]), b = nodeOf(segs[4 * s + 2], segs[4 * s + 3]);
    if (a !== b) { sa[ns] = a; sb[ns] = b; ns++; }
  }
  const nn = nx.length;
  const deg = new Int32Array(nn);
  for (let s = 0; s < ns; s++) { deg[sa[s]]++; deg[sb[s]]++; }
  const off = new Int32Array(nn + 1);
  for (let i = 0; i < nn; i++) off[i + 1] = off[i] + deg[i];
  const fill = off.slice(0, nn);
  const adj = new Int32Array(off[nn]);
  for (let s = 0; s < ns; s++) { adj[fill[sa[s]]++] = s; adj[fill[sb[s]]++] = s; }

  const used = new Uint8Array(ns);
  const pieces = [];
  const walk = (start, first) => {
    const xs = [nx[start]], ys = [ny[start]];
    let node = start, s = first;
    for (;;) {
      used[s] = 1;
      node = sa[s] === node ? sb[s] : sa[s];
      xs.push(nx[node]); ys.push(ny[node]);
      if (deg[node] !== 2) break;
      let nextSeg = -1;
      for (let k = off[node]; k < off[node + 1]; k++) if (!used[adj[k]]) { nextSeg = adj[k]; break; }
      if (nextSeg < 0) break;
      s = nextSeg;
    }
    simplifyChain(xs, ys, eps, pieces);
  };
  for (let i = 0; i < nn; i++) {
    if (deg[i] === 2) continue;
    for (let k = off[i]; k < off[i + 1]; k++) if (!used[adj[k]]) walk(i, adj[k]);
  }
  for (let s = 0; s < ns; s++) if (!used[s]) walk(sa[s], s);   // remaining closed loops
  return pieces;
}

// ---------- spatial helpers ----------

function buildGrid(pieces, cell, pad) {
  const map = new Map();
  for (let i = 0; i < pieces.length; i++) {
    const [x1, y1, x2, y2] = pieces[i];
    const cx0 = Math.floor((Math.min(x1, x2) - pad) / cell), cx1 = Math.floor((Math.max(x1, x2) + pad) / cell);
    const cy0 = Math.floor((Math.min(y1, y2) - pad) / cell), cy1 = Math.floor((Math.max(y1, y2) + pad) / cell);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const key = `${cx},${cy}`;
        const list = map.get(key);
        if (list) list.push(i); else map.set(key, [i]);
      }
    }
  }
  return { map, cell, stamp: new Uint32Array(pieces.length), tick: 0 };
}

function nearbyPieces(grid, x1, y1, x2, y2, pad) {
  const { map, cell } = grid;
  const tick = ++grid.tick;
  const out = [];
  const cx0 = Math.floor((Math.min(x1, x2) - pad) / cell), cx1 = Math.floor((Math.max(x1, x2) + pad) / cell);
  const cy0 = Math.floor((Math.min(y1, y2) - pad) / cell), cy1 = Math.floor((Math.max(y1, y2) + pad) / cell);
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cy = cy0; cy <= cy1; cy++) {
      const list = map.get(`${cx},${cy}`);
      if (!list) continue;
      for (const i of list) if (grid.stamp[i] !== tick) { grid.stamp[i] = tick; out.push(i); }
    }
  }
  return out;
}

// Sort intervals and merge those that overlap or are separated by at most `gap`.
function unionIntervals(list, gap) {
  if (!list.length) return list;
  list.sort((a, b) => a[0] - b[0]);
  const out = [list[0].slice()];
  for (let i = 1; i < list.length; i++) {
    const last = out[out.length - 1];
    if (list[i][0] <= last[1] + gap) last[1] = Math.max(last[1], list[i][1]);
    else out.push(list[i].slice());
  }
  return out;
}

// ---------- keeping only cuts found at every height ----------

// A raster over the plan with cells of tol / 2 (coarser for huge plans, so it stays under
// MAX_MASK_CELLS). Each slice after the first stamps a disc of radius tol around every point of
// its raw cuts into its own bit.
const MAX_MASK_CELLS = 40e6;

function planRaster(slices, tol) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const segs of slices) {
    for (let i = 0; i < segs.length; i += 2) {
      if (segs[i] < minX) minX = segs[i];
      if (segs[i] > maxX) maxX = segs[i];
      if (segs[i + 1] < minY) minY = segs[i + 1];
      if (segs[i + 1] > maxY) maxY = segs[i + 1];
    }
  }
  let cell = tol / 2;
  const area = (maxX - minX + 4 * tol) * (maxY - minY + 4 * tol);
  if (area / (cell * cell) > MAX_MASK_CELLS) cell = Math.sqrt(area / MAX_MASK_CELLS);
  const radius = Math.max(1, Math.ceil(tol / cell));
  const pad = (radius + 2) * cell;
  const x0 = minX - pad, y0 = minY - pad;
  const w = Math.ceil((maxX - minX + 2 * pad) / cell) + 1, h = Math.ceil((maxY - minY + 2 * pad) / cell) + 1;
  const disc = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) if (dx * dx + dy * dy <= (radius + 0.5) ** 2) disc.push(dy * w + dx);
  }
  return { x0, y0, cell, w, h, disc };
}

function stampSlice(mask, bit, segs, r) {
  const { x0, y0, cell, w, disc } = r;
  const step = cell / 2;
  let last = -1;
  for (let s = 0; s < segs.length; s += 4) {
    const x1 = segs[s], y1 = segs[s + 1], x2 = segs[s + 2], y2 = segs[s + 3];
    const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / step));
    for (let i = 0; i <= n; i++) {
      const idx = Math.floor((y1 + (y2 - y1) * i / n - y0) / cell) * w + Math.floor((x1 + (x2 - x1) * i / n - x0) / cell);
      if (idx === last) continue;
      last = idx;
      for (const d of disc) mask[idx + d] |= bit;
    }
  }
}

// Keep the parts of the first slice's raw cuts that lie within about tol of a cut in every other
// slice. Working on raw cuts (before straightening) keeps this independent of how noisy each
// slice's chain is. Run ends that reach a cut's end reuse its exact coordinates, so the kept cuts
// still chain together.
function consistentCuts(slices, tol) {
  const [base, ...others] = slices;
  if (!others.length || !base.length) return base;
  const r = planRaster(slices, tol);
  const mask = others.length <= 8 ? new Uint8Array(r.w * r.h) : new Uint32Array(r.w * r.h);
  others.forEach((segs, k) => stampSlice(mask, 2 ** k, segs, r));
  const full = 2 ** others.length - 1;
  const { x0, y0, cell, w } = r;
  const step = cell / 2;
  let out = new Float64Array(base.length);
  let len = 0;
  const emit = (x1, y1, x2, y2) => {
    if (x1 === x2 && y1 === y2) return;
    if (len + 4 > out.length) out = grow(out, len + 4);
    out[len++] = x1; out[len++] = y1; out[len++] = x2; out[len++] = y2;
  };
  for (let s = 0; s < base.length; s += 4) {
    const x1 = base[s], y1 = base[s + 1], x2 = base[s + 2], y2 = base[s + 3];
    const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / step));
    const at = i => (i === 0 ? [x1, y1] : i === n ? [x2, y2] : [x1 + (x2 - x1) * i / n, y1 + (y2 - y1) * i / n]);
    let run = -1;
    for (let i = 0; i <= n; i++) {
      const [x, y] = at(i);
      const inside = (mask[Math.floor((y - y0) / cell) * w + Math.floor((x - x0) / cell)] & full) === full;
      if (inside && run < 0) run = i;
      if (!inside && run >= 0) { emit(...at(run), ...at(i - 1)); run = -1; }
    }
    if (run >= 0) emit(...at(run), x2, y2);
  }
  return out.subarray(0, len);
}

// ---------- merging, filtering, snapping ----------

// Length-weighted line through a group of pieces: unit direction (ux, uy) aligned with (dx, dy),
// and offset along the normal (-uy, ux).
function fitLine(members, dx, dy) {
  let wx = 0, wy = 0;
  for (const s of members) {
    const sx = s.x2 - s.x1, sy = s.y2 - s.y1;
    const sign = sx * dx + sy * dy >= 0 ? 1 : -1;
    wx += sign * sx; wy += sign * sy;
  }
  const wl = Math.hypot(wx, wy);
  const ux = wl > 0 ? wx / wl : dx, uy = wl > 0 ? wy / wl : dy;
  let off = 0, total = 0;
  for (const s of members) {
    off += s.len * (-uy * (s.x1 + s.x2) / 2 + ux * (s.y1 + s.y2) / 2);
    total += s.len;
  }
  return { ux, uy, off: off / total };
}

function splitByLine(rest, line, tol) {
  const { ux, uy, off } = line;
  const members = [], others = [];
  for (const s of rest) {
    const o1 = -uy * s.x1 + ux * s.y1 - off, o2 = -uy * s.x2 + ux * s.y2 - off;
    (Math.abs(o1) <= tol && Math.abs(o2) <= tol ? members : others).push(s);
  }
  return { members, others };
}

// Group pieces that lie on one line (both ends within tol of it), and join pieces along that line
// that overlap or touch (gap <= tol). The line starts as the longest remaining piece's and is refit
// to its members a few times, so one slightly tilted piece does not set the line for the whole wall.
function mergeCollinear(pieces, tol) {
  const items = pieces
    .map(([x1, y1, x2, y2]) => ({ x1, y1, x2, y2, len: Math.hypot(x2 - x1, y2 - y1) }))
    .filter(s => s.len > 0)
    .sort((a, b) => b.len - a.len);
  let rest = items;
  const out = [];
  while (rest.length) {
    const R = rest[0];
    const dx = (R.x2 - R.x1) / R.len, dy = (R.y2 - R.y1) / R.len;
    let split = splitByLine(rest, { ux: dx, uy: dy, off: -dy * R.x1 + dx * R.y1 }, tol);
    for (let iter = 0; iter < 3; iter++) {
      const next = splitByLine(rest, fitLine(split.members, dx, dy), tol);
      if (!next.members.includes(R)) break;   // R must stay in its group, or the loop could stall
      const settled = next.members.length === split.members.length;
      split = next;
      if (settled) break;
    }
    const { members, others } = split;
    rest = others;
    const { ux, uy, off } = fitLine(members, dx, dy);
    const spans = members.map(s => {
      const t1 = ux * s.x1 + uy * s.y1, t2 = ux * s.x2 + uy * s.y2;
      return [Math.min(t1, t2), Math.max(t1, t2)];
    });
    for (const [t0, t1] of unionIntervals(spans, tol)) {
      out.push({ x1: ux * t0 - uy * off, y1: uy * t0 + ux * off, x2: ux * t1 - uy * off, y2: uy * t1 + ux * off });
    }
  }
  return out;
}

// Drop walls shorter than minLength, except those that close an outline. A short piece whose two ends
// join two different kept walls is a door jamb across a thick wall, a column face or the side of a
// solid object: dropping it would open the inside of that wall or object to walkers (the cavity
// between a thick wall's two faces would lead out of every doorway in it). A short piece with a free
// end, or one lying along a single other wall (both ends within tol of it), closes nothing and goes.
// Removal repeats until stable, since a short piece may hang only on other short pieces. A kept short
// piece's end within tol of another wall's endpoint moves onto it exactly: a shared endpoint is a
// closed corner that snapEnds leaves alone, so a jamb does not poke into its doorway.
function dropShort(walls, minLength, tol) {
  const short = walls.map(w => Math.hypot(w.x2 - w.x1, w.y2 - w.y1) < minLength);
  if (!short.includes(true)) return walls;
  const grid = buildGrid(walls.map(w => [w.x1, w.y1, w.x2, w.y2]), 1, tol);
  const alive = walls.map(() => true);
  const joined = (x, y, i) => nearbyPieces(grid, x, y, x, y, tol).filter(j =>
    j !== i && alive[j] && distToSegment(x, y, walls[j].x1, walls[j].y1, walls[j].x2, walls[j].y2) <= tol);
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < walls.length; i++) {
      if (!short[i] || !alive[i]) continue;
      const a = joined(walls[i].x1, walls[i].y1, i), b = joined(walls[i].x2, walls[i].y2, i);
      if (!a.length || !b.length || a.some(j => b.includes(j))) { alive[i] = false; changed = true; }
    }
  }
  for (let i = 0; i < walls.length; i++) {
    if (!short[i] || !alive[i]) continue;
    const w = walls[i];
    for (const end of [1, 2]) {
      const x = end === 1 ? w.x1 : w.x2, y = end === 1 ? w.y1 : w.y2;
      let best = null, bestD = tol;
      for (const j of joined(x, y, i)) {
        if (short[j]) continue;
        for (const [ex, ey] of [[walls[j].x1, walls[j].y1], [walls[j].x2, walls[j].y2]]) {
          const d = Math.hypot(ex - x, ey - y);
          if (d <= bestD) { bestD = d; best = [ex, ey]; }
        }
      }
      if (!best) continue;
      if (end === 1) { w.x1 = best[0]; w.y1 = best[1]; } else { w.x2 = best[0]; w.y2 = best[1]; }
    }
  }
  return walls.filter((_, i) => alive[i]);
}

// Ray from (px, py) along unit (ux, uy): distance to segment w, or Infinity.
function rayHit(px, py, ux, uy, w) {
  const ex = w.x2 - w.x1, ey = w.y2 - w.y1;
  const den = ux * ey - uy * ex;
  if (Math.abs(den) < 1e-12) return Infinity;
  const fx = w.x1 - px, fy = w.y1 - py;
  const s = (fx * ey - fy * ex) / den;
  const r = (fx * uy - fy * ux) / den;
  return s >= -1e-9 && r >= -1e-9 && r <= 1 + 1e-9 ? Math.max(0, s) : Infinity;
}

function nearestOnSegment(px, py, w) {
  const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - w.x1) * dx + (py - w.y1) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return [w.x1 + t * dx, w.y1 + t * dy];
}

// Close small gaps where a wall stops just short of another (noisy corners and T-junctions), so
// the plan never leaks through a crack narrower than snapTol. A wall end that already shares an
// endpoint with another wall is left alone. Otherwise it is extended along its own direction to
// the first wall within snapTol (a hit at distance 0 means it ends exactly on that wall's side),
// or, failing that, moved to the nearest wall within snapTol. When it lands on another wall's side
// it goes `overshoot` further, through that wall: an end resting exactly on a line can drift off it
// when coordinates are rounded or rescaled later, and that would open a hairline crack. When it
// lands on another wall's endpoint it takes those exact coordinates. Real doorways are far wider
// than snapTol, so none is closed.
function snapEnds(walls, snapTol, overshoot) {
  if (!(snapTol > 0) || walls.length < 2) return walls;
  const grid = buildGrid(walls.map(w => [w.x1, w.y1, w.x2, w.y2]), 1, snapTol);
  const isEndOf = (x, y, o) => (x === o.x1 && y === o.y1) || (x === o.x2 && y === o.y2);
  for (let i = 0; i < walls.length; i++) {
    for (const end of [1, 2]) {
      const w = walls[i];
      const px = end === 1 ? w.x1 : w.x2, py = end === 1 ? w.y1 : w.y2;
      const qx = end === 1 ? w.x2 : w.x1, qy = end === 1 ? w.y2 : w.y1;
      const len = Math.hypot(px - qx, py - qy);
      if (!(len > 0)) continue;
      const ux = (px - qx) / len, uy = (py - qy) / len;
      const near = nearbyPieces(grid, px, py, px, py, snapTol + overshoot).filter(j => j !== i);
      if (near.some(j => isEndOf(px, py, walls[j]))) continue;
      let hit = Infinity, nearest = null, nearestD = Infinity, nearestWall = null;
      for (const j of near) {
        const [nx, ny] = nearestOnSegment(px, py, walls[j]);
        const d = Math.hypot(nx - px, ny - py);
        if (d < nearestD) { nearestD = d; nearest = [nx, ny]; nearestWall = walls[j]; }
        hit = Math.min(hit, rayHit(px, py, ux, uy, walls[j]));
      }
      let target = null;
      if (hit <= snapTol) {
        target = [px + ux * (hit + overshoot), py + uy * (hit + overshoot)];
      } else if (nearestD <= 1e-9) {
        continue;   // touching a wall it runs along (collinear overlap): nothing to close
      } else if (nearestD <= snapTol) {
        if (isEndOf(nearest[0], nearest[1], nearestWall)) target = nearest;
        else {
          const k = (nearestD + overshoot) / nearestD;
          target = [px + (nearest[0] - px) * k, py + (nearest[1] - py) * k];
        }
      }
      if (!target) continue;
      if (end === 1) { w.x1 = target[0]; w.y1 = target[1]; } else { w.x2 = target[0]; w.y2 = target[1]; }
    }
  }
  return walls;
}

const round3 = v => Math.round(v * 1000) / 1000 + 0;   // + 0 turns -0 into 0

function isParsedMesh(m) {
  return m && typeof m === 'object' && !(m instanceof Uint8Array) && !(m instanceof ArrayBuffer) &&
    m.vertices && m.faces;
}

/**
 * Turn an OBJ mesh into 2D wall segments by slicing it at several heights above the floor.
 * @param {string|Uint8Array|{vertices, faces}} objText  OBJ text, its bytes, or parseObj output
 * @param {object} [options]
 * @param {'z'|'y'} [options.up]          up axis; auto-detected when omitted
 * @param {number} [options.floorHeight]  floor height along up (mesh units); auto-detected when omitted
 * @param {number[]} [options.sliceHeights=[1.0, 1.5]]  cut heights in meters above the floor
 * @param {number} [options.minLength=0.3]      drop merged walls shorter than this
 * @param {number} [options.mergeTolerance=0.05] how far apart two cuts may be and still match
 * @param {number} [options.snapTolerance]      close wall-end gaps up to this size (2 x mergeTolerance)
 * @returns {{ walls: {x1, y1, x2, y2, source}[], bounds: {minX, minY, maxX, maxY}|null,
 *   warnings: string[], up: 'z'|'y', floorHeight: number|null, levels: number[], units: 'm',
 *   source: 'mesh-slice' }}
 *   Plan coordinates are the mesh's own: (x, y) for z-up, (x, -z) for y-up (the plan seen from
 *   above, not mirrored; the same mapping as Matterport's documented SDK-to-API conversion).
 */
export function meshToWalls(objText, options = {}) {
  const {
    up: upOption,
    floorHeight: floorOption,
    sliceHeights = [1.0, 1.5],
    minLength = 0.3,
    mergeTolerance = 0.05
  } = options;
  const snapTolerance = options.snapTolerance ?? SNAP_TOLERANCE_FACTOR * mergeTolerance;
  if (upOption != null && upOption !== 'y' && upOption !== 'z') {
    throw new RangeError(`meshToWalls: up must be "z" or "y", got ${JSON.stringify(upOption)}`);
  }
  if (!Array.isArray(sliceHeights) || !sliceHeights.length || sliceHeights.length > MAX_SLICES ||
    !sliceHeights.every(Number.isFinite)) {
    throw new RangeError(`meshToWalls: sliceHeights must be an array of 1 to ${MAX_SLICES} numbers`);
  }
  if (!(mergeTolerance > 0)) throw new RangeError('meshToWalls: mergeTolerance must be > 0');
  if (!(minLength >= 0)) throw new RangeError('meshToWalls: minLength must be >= 0');
  if (floorOption != null && !Number.isFinite(floorOption)) {
    throw new RangeError('meshToWalls: floorHeight must be a number');
  }

  const mesh = isParsedMesh(objText) ? objText : parseObj(objText);
  const V = mesh.vertices, F = mesh.faces;
  const warnings = [...(mesh.warnings || [])];
  const result = (walls, bounds, up, floorHeight, levels) =>
    ({ walls, bounds, warnings, up, floorHeight, levels, units: 'm', source: 'mesh-slice' });
  if (!F.length) {
    warnings.push('the mesh has no faces, so no walls were found');
    return result([], null, upOption ?? 'z', floorOption ?? null, []);
  }

  let up = upOption;
  if (up == null) {
    const guess = detectUp(V, F);
    up = guess.up;
    if (guess.warning) warnings.push(guess.warning);
  }

  const nv = V.length / 3;
  const PX = new Float64Array(nv), PY = new Float64Array(nv), H = new Float64Array(nv);
  for (let i = 0; i < nv; i++) {
    PX[i] = V[3 * i];
    if (up === 'z') { PY[i] = V[3 * i + 1]; H[i] = V[3 * i + 2]; }
    else { PY[i] = -V[3 * i + 2]; H[i] = V[3 * i + 1]; }
  }

  const range = robustRange(H);
  let floorHeight = floorOption;
  if (floorHeight == null) {
    floorHeight = detectFloor(PX, PY, H, F);
    if (floorHeight == null) {
      floorHeight = range.lo;
      warnings.push('found no horizontal surface for the floor; used the bottom of the mesh');
    }
  }
  if (range.hi - floorHeight > 4.5) {
    warnings.push(`the mesh rises ${(range.hi - floorHeight).toFixed(1)} m above the floor and may hold more than one storey; only the storey at floorHeight was sliced`);
  }

  const levels = sliceHeights.map(h => floorHeight + h);
  const slices = levels.map((level, k) => {
    if (level > range.hi) warnings.push(`slice ${sliceHeights[k]} m above the floor is above most of the mesh`);
    return sliceAt(PX, PY, H, F, level);
  });

  const pieces = slicePieces(consistentCuts(slices, mergeTolerance), mergeTolerance);
  const merged = dropShort(mergeCollinear(pieces, mergeTolerance), minLength, mergeTolerance);
  const walls = snapEnds(merged, snapTolerance, mergeTolerance / 5)
    .map(w => {
      const a = [round3(w.x1), round3(w.y1)], b = [round3(w.x2), round3(w.y2)];
      const [p, q] = a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]) ? [a, b] : [b, a];
      return { x1: p[0], y1: p[1], x2: q[0], y2: q[1], source: 'mesh-slice' };
    })
    .filter(w => w.x1 !== w.x2 || w.y1 !== w.y2)
    .sort((a, b) => a.x1 - b.x1 || a.y1 - b.y1 || a.x2 - b.x2 || a.y2 - b.y2);

  let bounds = null;
  if (walls.length) {
    bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const w of walls) {
      bounds.minX = Math.min(bounds.minX, w.x1, w.x2); bounds.maxX = Math.max(bounds.maxX, w.x1, w.x2);
      bounds.minY = Math.min(bounds.minY, w.y1, w.y2); bounds.maxY = Math.max(bounds.maxY, w.y1, w.y2);
    }
    warnings.push('mesh-slice walls need a human check: tall furniture (cabinets, shelves, open door leaves) can survive as false walls, and glass or windows open across every slice height leave gaps');
  } else {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < nv; i++) {
      if (!Number.isFinite(PX[i]) || !Number.isFinite(PY[i])) continue;
      minX = Math.min(minX, PX[i]); maxX = Math.max(maxX, PX[i]);
      minY = Math.min(minY, PY[i]); maxY = Math.max(maxY, PY[i]);
    }
    bounds = { minX: round3(minX), minY: round3(minY), maxX: round3(maxX), maxY: round3(maxY) };
    warnings.push('no wall survived at every slice height; bounds are the whole mesh');
  }
  return result(walls, bounds, up, round3(floorHeight), levels.map(round3));
}

// ---------- starter world ----------

const WORLD_MARGIN = 8;          // map units around the walls, so there is room to stand outside
const WALK_M_PER_MIN = 80;
const MAX_TRAVEL_SPEED = 600;    // the spec's travelSpeed maximum (§14d)
const CLEARANCE_M = 0.15;        // a quarter of a narrow 0.6 m door: the mesh has no door widths
const SPOT_FREE_M = 0.45;        // a placeholder place needs this much room around it
const SPOT_APART_M = 2.5;        // ... and this far from the next one
const MAX_SPOTS = 9;             // one entrance plus up to eight places
const SAMPLE_STEP = 0.5;         // map units between samples when looking for open spots
const r4 = v => Math.round(v * 1e4) / 1e4 + 0;

// Distance from (x, y) to the nearest wall, capped at `cap`, using buckets of size cap.
function distanceField(walls, cap) {
  const buckets = new Map();
  walls.forEach((w, i) => {
    for (let cx = Math.floor(Math.min(w.x1, w.x2) / cap); cx <= Math.floor(Math.max(w.x1, w.x2) / cap); cx++) {
      for (let cy = Math.floor(Math.min(w.y1, w.y2) / cap); cy <= Math.floor(Math.max(w.y1, w.y2) / cap); cy++) {
        const k = `${cx},${cy}`;
        (buckets.get(k) || buckets.set(k, []).get(k)).push(i);
      }
    }
  });
  return (x, y) => {
    let d = cap;
    const cx = Math.floor(x / cap), cy = Math.floor(y / cap);
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cy - 1; j <= cy + 1; j++) {
        for (const k of buckets.get(`${i},${j}`) || []) {
          const w = walls[k];
          d = Math.min(d, distToSegment(x, y, w.x1, w.y1, w.x2, w.y2));
        }
      }
    }
    return d;
  };
}

/**
 * A starter visit world from meshToWalls output. The plan is fitted into the 0-100 map (aspect kept,
 * y flipped so it is not mirrored on the canvas, WORLD_MARGIN units of open ground around it).
 * The mesh says nothing about rooms or doors, so the places are placeholders at the most open spots
 * that can be reached on foot from the entrance. The entrance stands outside the building when the
 * mesh shows a way in, otherwise at the most open spot inside. Warnings are attached as a
 * non-enumerable `warnings` array, as floorplanToWorld does.
 * @param {ReturnType<typeof meshToWalls>} result
 * @param {{ title?: string, question?: string, file?: string }} [opts]
 */
export function meshToWorld(result, { title, question, file } = {}) {
  if (!result || !Array.isArray(result.walls)) throw new TypeError('meshToWorld: expected the result of meshToWalls');
  if (!result.walls.length || !result.bounds) throw new RangeError('meshToWorld: the mesh gave no walls, so there is no floor plan to build a world on');
  const warnings = [...(result.warnings || [])];
  const b = result.bounds, usable = 100 - 2 * WORLD_MARGIN;
  const scale = usable / Math.max(b.maxX - b.minX, b.maxY - b.minY, 1e-6);
  const tx = WORLD_MARGIN + (usable - (b.maxX - b.minX) * scale) / 2 - b.minX * scale;
  const ty = WORLD_MARGIN + (usable - (b.maxY - b.minY) * scale) / 2 + b.maxY * scale;
  const mpu = 1 / scale;
  // One affine map for every point, so walls that share an end still share it afterwards.
  const walls = result.walls.map(w => ({ x1: r4(tx + w.x1 * scale), y1: r4(ty - w.y1 * scale), x2: r4(tx + w.x2 * scale), y2: r4(ty - w.y2 * scale), source: 'mesh-slice' }))
    .filter(w => w.x1 !== w.x2 || w.y1 !== w.y2);
  if (walls.length > 4000) warnings.push(`${walls.length} wall segments is above the world maximum of 4000; raise minLength or slice one storey`);
  const clearance = Math.max(0.02, Math.min(1, Math.floor((CLEARANCE_M / mpu) * 1e4) / 1e4));
  const nav = createNav(walls, { clearance });

  // Open spots: local maxima of the distance to the nearest wall, most open first, kept apart.
  const free = Math.max(SPOT_FREE_M / mpu, clearance + 0.05);
  const dist = distanceField(walls, Math.max(2, Math.min(25, 6 / mpu)));
  const n = Math.floor(94 / SAMPLE_STEP) + 1;
  const at = (i, j) => [3 + i * SAMPLE_STEP, 3 + j * SAMPLE_STEP];
  const D = new Float64Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) D[j * n + i] = dist(...at(i, j));
  const peaks = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const d = D[j * n + i];
      if (d < free) continue;
      let top = true;
      for (let dj = -1; dj <= 1 && top; dj++) {
        for (let di = -1; di <= 1; di++) {
          const a = i + di, c = j + dj;
          if ((di || dj) && a >= 0 && c >= 0 && a < n && c < n && D[c * n + a] > d) { top = false; break; }
        }
      }
      if (top) { const [x, y] = at(i, j); peaks.push({ x, y, d }); }
    }
  }
  peaks.sort((p, q) => q.d - p.d || p.y - q.y || p.x - q.x);
  const apart = SPOT_APART_M / mpu;
  const wx = walls.flatMap(w => [w.x1, w.x2]), wy = walls.flatMap(w => [w.y1, w.y2]);
  const box = { x0: Math.min(...wx), x1: Math.max(...wx), y0: Math.min(...wy), y1: Math.max(...wy) };
  const inside = p => p.x > box.x0 && p.x < box.x1 && p.y > box.y0 && p.y < box.y1;
  const spots = [];
  for (const p of peaks.filter(inside)) {
    if (spots.every(s => Math.hypot(s.x - p.x, s.y - p.y) >= Math.max(apart, s.d, p.d))) spots.push(p);
  }
  if (!spots.length) throw new RangeError(`meshToWorld: no open spot inside the walls has ${SPOT_FREE_M} m of room around it`);

  // The entrance: outside when a point in the margin around the building reaches the most open spot.
  const seed = spots[0];
  const lo = WORLD_MARGIN / 2;
  const outsideCandidates = [[50, lo], [50, 100 - lo], [lo, 50], [100 - lo, 50], [lo, lo], [100 - lo, lo], [lo, 100 - lo], [100 - lo, 100 - lo]]
    .map(([x, y]) => ({ x: Math.max(3, Math.min(97, x)), y: Math.max(3, Math.min(97, y)) }))
    .filter(p => dist(p.x, p.y) >= free)
    .map(p => ({ ...p, walk: nav.distance(p.x, p.y, seed.x, seed.y) }))
    .filter(p => Number.isFinite(p.walk))
    .sort((p, q) => p.walk - q.walk);
  let gate, places;
  if (outsideCandidates.length) {
    gate = { id: 'outside', name: 'Outside (placeholder entrance)', kind: 'gate', x: r4(outsideCandidates[0].x), y: r4(outsideCandidates[0].y) };
    places = spots;
  } else {
    gate = { id: 'entrance', name: 'Entrance (placeholder)', kind: 'gate', x: r4(seed.x), y: r4(seed.y) };
    places = spots.slice(1);
    warnings.push('no way in from outside the walls was found (a closed shell, or the doors are missing from the scan); the placeholder entrance is inside, at the most open spot');
  }
  const reachable = places.filter(p => nav.path(gate.x, gate.y, p.x, p.y));
  if (reachable.length < places.length) {
    warnings.push(`${places.length - reachable.length} open spot(s) cannot be reached on foot from the entrance (closed rooms, shafts or scan holes) and were left out`);
  }
  let services = reachable.slice(0, MAX_SPOTS - 1);
  if (!services.length) {
    // A single open area: put one place a little way from the entrance, where there is room.
    const alt = peaks.find(p => Math.hypot(p.x - gate.x, p.y - gate.y) >= 2 * free && nav.path(gate.x, gate.y, p.x, p.y));
    if (!alt) throw new RangeError('meshToWorld: found no second open spot reachable from the entrance');
    services = [alt];
  }
  const nodes = [gate, ...services.map((p, k) => ({
    id: `area_${k + 1}`, name: `Open area ${k + 1}`, kind: 'service', x: r4(p.x), y: r4(p.y),
    servers: 2, serviceTime: 5, tags: ['area'],
    about: `Open floor area about ${(2 * p.d * mpu).toFixed(1)} m across, found in the mesh (placeholder: replace with a real place)`.slice(0, 160)
  }))];

  const name = typeof file === 'string' && file.trim() ? file.trim().split(/[\\/]/).pop() : 'mesh';
  const world = {
    title: (typeof title === 'string' && title.trim() ? title.trim() : `Floor plan sliced from ${name}`).slice(0, 80),
    question: (typeof question === 'string' && question.trim() ? question.trim() : 'Which parts of this floor build up lines, and where do people give up?').slice(0, 400),
    context: `A floor whose walls were sliced from a 3D scan at ${(result.levels || []).length || 2} heights. People cannot walk through walls.`.slice(0, 300),
    mode: 'visit',
    duration: 90,
    clockStart: 540,
    travelSpeed: r4(Math.min(MAX_TRAVEL_SPEED, Math.max(0.2, WALK_M_PER_MIN / mpu))),
    arrivals: { total: 100, start: 0, end: 45, shape: 'peak' },
    nodes,
    archetypes: [{
      id: 'visitors', name: 'Visitors', share: 1, description: 'Placeholder group: replace with the people who use this floor.',
      visits: Math.min(3, services.length), patience: 30, info: 0.5
    }],
    walls,
    geo: { metersPerUnit: +mpu.toPrecision(6), clearance, floor: null, source: 'mesh-slice' },
    provenance: {
      walls: 'data', 'geo.metersPerUnit': 'data', 'geo.clearance': 'assumed', travelSpeed: 'assumed',
      'nodes[*].x': 'assumed', 'nodes[*].y': 'assumed', 'nodes[*].servers': 'assumed', 'nodes[*].serviceTime': 'assumed',
      arrivals: 'assumed', archetypes: 'assumed', duration: 'assumed', clockStart: 'assumed'
    }
  };
  if (WALK_M_PER_MIN / mpu > MAX_TRAVEL_SPEED) warnings.push(`walking speed ${WALK_M_PER_MIN} m/min is ${(WALK_M_PER_MIN / mpu).toFixed(0)} map units/min, above the spec's maximum of ${MAX_TRAVEL_SPEED}; using ${MAX_TRAVEL_SPEED}`);
  Object.defineProperty(world, 'warnings', { value: warnings, enumerable: false });
  return world;
}

// ---------- Matterport Model API ----------

export const MATTERPORT_GRAPH_ENDPOINT = 'https://api.matterport.com/api/models/graph';

// Fields from the Model API GraphQL reference: Query.model(id: ID!): Model, Model.assets:
// ModelAssets, ModelAssets.meshes(formats, resolutions): [Mesh!]!, and the Mesh/Asset fields below.
// The accepted format strings are not documented, so all meshes are requested and filtered here.
export const MESH_QUERY = `query swarmscopeMesh($modelId: ID!) {
  model(id: $modelId) {
    id
    assets {
      meshes {
        id
        format
        resolution
        status
        filename
        url
        validUntil
      }
    }
  }
}`;

const MATTERPAK_HINT = 'Matterport sells the high-resolution OBJ/MTL as part of the MatterPak bundle ' +
  '(bundle id "mp:matterpak", unlocked with the unlockModelBundle mutation; allow up to 15 minutes ' +
  'after unlocking). Or download the OBJ yourself and run swarm import-mesh on it.';

function basicAuth(id, secret) {
  try {
    return 'Basic ' + btoa(`${id}:${secret}`);
  } catch {
    throw new Error('fetchMeshObj: the Matterport token ID and secret must be plain ASCII');
  }
}

async function unzipObj(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('the mesh download looks like a zip file but has no central directory');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const zip64 = 'the mesh download is a zip64 archive, which is not supported: unzip it and run swarm import-mesh on the .obj';
  if (count === 0xffff || off === 0xffffffff) throw new Error(zip64);
  const decoder = new TextDecoder();
  for (let e = 0; e < count; e++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('the mesh download is a damaged zip file');
    const method = dv.getUint16(off + 10, true);
    const size = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const local = dv.getUint32(off + 42, true);
    const name = decoder.decode(bytes.subarray(off + 46, off + 46 + nameLen));
    off += 46 + nameLen + dv.getUint16(off + 30, true) + dv.getUint16(off + 32, true);
    if (!/\.obj$/i.test(name)) continue;
    if (size === 0xffffffff || local === 0xffffffff) throw new Error(zip64);
    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error('the mesh download is a damaged zip file');
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + size);
    if (method === 0) return { bytes: raw, name };
    if (method === 8) {
      const { inflateRawSync } = await import('node:zlib');
      return { bytes: new Uint8Array(inflateRawSync(raw)), name };
    }
    throw new Error(`zip entry ${name} uses compression method ${method}, which is not supported`);
  }
  throw new Error('the mesh download is a zip file with no .obj inside');
}

/**
 * Fetch a model's OBJ mesh through the Matterport Model API (HTTP Basic auth: token ID as the
 * username, token secret as the password). The signed download URL is fetched without credentials.
 * Credentials are never logged or put in error messages.
 * @returns {Promise<{ obj: Uint8Array, asset: { id, format, resolution, filename, validUntil, entry? },
 *   warnings: string[] }>}  obj is the .obj file's bytes (parseObj and meshToWalls accept bytes).
 */
export async function fetchMeshObj({
  modelId, tokenId, tokenSecret, endpoint = MATTERPORT_GRAPH_ENDPOINT, fetch: fetchFn = globalThis.fetch
} = {}) {
  if (!modelId) throw new Error('fetchMeshObj: modelId is required');
  if (!tokenId || !tokenSecret) {
    throw new Error('fetchMeshObj: Matterport token ID and secret are required (MATTERPORT_API_KEY, MATTERPORT_API_TOKEN)');
  }
  if (typeof fetchFn !== 'function') throw new Error('fetchMeshObj: no fetch function available');

  const res = await fetchFn(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: basicAuth(tokenId, tokenSecret) },
    body: JSON.stringify({ query: MESH_QUERY, variables: { modelId } })
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Matterport rejected the API credentials (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(`Matterport Model API returned HTTP ${res.status}`);
  const body = await res.json();
  const errors = Array.isArray(body?.errors) ? body.errors.map(e => e?.message || String(e)) : [];
  const model = body?.data?.model;
  if (!model) {
    throw new Error(`Matterport Model API returned no model ${modelId}${errors.length ? ': ' + errors.join('; ') : ''}`);
  }
  const meshes = Array.isArray(model.assets?.meshes) ? model.assets.meshes : [];
  const isObj = m => /obj/i.test(m?.format || '') || /\.obj$/i.test(m?.filename || '');
  const candidates = meshes.filter(isObj);
  const mesh = candidates.find(m => m.status === 'available' && m.url);
  if (!mesh) {
    const listed = meshes.map(m => `${m?.format ?? '?'}/${m?.resolution ?? '?'} (${m?.status ?? 'unknown'})`).join(', ');
    if (candidates.length) {
      throw new Error(`model ${modelId} has an OBJ mesh but it is not available (${listed}). ${MATTERPAK_HINT}`);
    }
    throw new Error(`model ${modelId} has no OBJ mesh${listed ? ` (meshes: ${listed})` : ''}. ${MATTERPAK_HINT}`);
  }

  const download = await fetchFn(mesh.url, { method: 'GET' });
  if (!download.ok) {
    throw new Error(`downloading the OBJ mesh failed with HTTP ${download.status}${mesh.validUntil ? ` (the link was valid until ${mesh.validUntil})` : ''}`);
  }
  let bytes = new Uint8Array(await download.arrayBuffer());
  const asset = {
    id: mesh.id ?? null, format: mesh.format, resolution: mesh.resolution ?? null,
    filename: mesh.filename ?? null, validUntil: mesh.validUntil ?? null
  };
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    const entry = await unzipObj(bytes);
    bytes = entry.bytes;
    asset.entry = entry.name;
  }
  const warnings = errors.length ? [`Matterport reported: ${errors.join('; ')}`] : [];
  return { obj: bytes, asset, warnings };
}
