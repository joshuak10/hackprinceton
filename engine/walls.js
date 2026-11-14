// Interior walls: segment normalization, crossing tests and wall-free walking paths
// (docs/PROTOTYPE.md §13). A pure module with no imports, so the browser viewer loads the same file.
//
// Navigation is a visibility graph. Every wall end or junction gets waypoints in each reflex gap
// (an angular gap wider than 180 degrees between the walls that meet there), placed `clearance`
// away from the corner. Paths are straight when clear; otherwise A* over start, goal and the
// waypoints, after which each bend slides along its corner's clearance circle to shorten the path.
// Waypoint visibility is computed lazily and cached, and every crossing test goes through a
// uniform grid over the walls. Touching a wall counts as crossing it.
//
// Cracks: a gap narrower than 2 x clearance between a wall end and another wall, or between a wall
// end and the map edge, is sealed with a segment across it, and nav treats seals as walls (blocked,
// path, distance). No disk of radius `clearance` fits through such a gap, so a path there would brush
// the wall end; without seals, hairline cracks between wall pieces (common in mesh slices) and the
// cavity between the two faces of a thick wall could be walked through. Every point of a seal is
// closer than `clearance` to a wall or the map edge, so a path keeping 1.25 x clearance from both
// never meets one and gaps of 2.5 x clearance stay open. crossesWall and polylineCrossesWall test
// the given walls only; nav.seals lists the seals.

const EPS = 1e-9;                 // touching distance: a segment this close to a wall crosses it
const EPS2 = EPS * EPS;
const MARGIN = 1e-7;              // grid cells are filled and searched this much wider than a segment
const JOIN = 1e-7;                // a wall passing this close to an endpoint is joined to it
const JOIN2 = JOIN * JOIN;
const ANGLE_EPS = 1e-9;
const MAP_MIN = 0, MAP_MAX = 100;
const MAX_WALLS = 4000;
const SOURCES = ['matterport-vector', 'mesh-slice', 'drawn'];
const DEFAULT_CLEARANCE = 0.2, MIN_CLEARANCE = 0.02, MAX_CLEARANCE = 1;
const GRID_DENSITY = 1.5;         // grid cells per side, per square root of the wall count
const GRID_MAX_SIDE = 256;
const CACHE_LIMIT = 20000;        // path cache entries before the cache is cleared
const TAU = Math.PI * 2;

// ---------- geometry ----------

function pointSegDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

// True when segment a-b comes within EPS of segment c-d (crossing, touching, or collinear overlap).
// The first segment is put in a canonical order so the answer is identical in both directions.
function segTouch(ax, ay, bx, by, cx, cy, dx, dy) {
  if (ax > bx || (ax === bx && ay > by)) { let t = ax; ax = bx; bx = t; t = ay; ay = by; by = t; }
  if (bx < (cx < dx ? cx : dx) - EPS || ax > (cx > dx ? cx : dx) + EPS ||
      (ay > by ? ay : by) < (cy < dy ? cy : dy) - EPS || (ay < by ? ay : by) > (cy > dy ? cy : dy) + EPS) return false;
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  // Segments that do not properly cross are closest at one of the four endpoints.
  return pointSegDist2(ax, ay, cx, cy, dx, dy) <= EPS2 || pointSegDist2(bx, by, cx, cy, dx, dy) <= EPS2 ||
    pointSegDist2(cx, cy, ax, ay, bx, by) <= EPS2 || pointSegDist2(dx, dy, ax, ay, bx, by) <= EPS2;
}

// ---------- public helpers ----------

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

function shown(v) {
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}

// Lenient: clamps to the 0-100 map, drops what can't be a segment, and says what it changed.
export function normalizeWalls(raw) {
  const walls = [], warnings = [];
  if (raw === undefined || raw === null) return { walls, warnings };
  if (!Array.isArray(raw)) {
    warnings.push('walls: expected an array of segments; ignoring it');
    return { walls, warnings };
  }
  if (raw.length > MAX_WALLS) {
    warnings.push(`walls: ${raw.length} segments is above the maximum ${MAX_WALLS}; keeping the first ${MAX_WALLS}`);
  }
  const names = ['x1', 'y1', 'x2', 'y2'];
  const unknown = new Map();
  for (let i = 0; i < Math.min(raw.length, MAX_WALLS); i++) {
    const w = raw[i], at = `walls[${i}]`;
    let given, source;
    if (Array.isArray(w)) {
      if (w.length < 4) { warnings.push(`${at}: expected [x1, y1, x2, y2] but got ${w.length} values; dropped`); continue; }
      if (w.length > 4) warnings.push(`${at}: expected 4 values but got ${w.length}; using the first 4`);
      given = w.slice(0, 4);
    } else if (w && typeof w === 'object') {
      given = names.map(k => w[k]);
      source = w.source;
      for (const k of Object.keys(w)) if (!names.includes(k) && k !== 'source') unknown.set(k, (unknown.get(k) || 0) + 1);
    } else {
      warnings.push(`${at}: not a segment (use { x1, y1, x2, y2 } or [x1, y1, x2, y2]); dropped`);
      continue;
    }
    const coords = given.map(toNumber);
    const bad = coords.findIndex(v => !Number.isFinite(v));
    if (bad >= 0) { warnings.push(`${at}.${names[bad]}: ${shown(given[bad])} is not a number; dropped`); continue; }
    for (let k = 0; k < 4; k++) {
      if (coords[k] < MAP_MIN) { warnings.push(`${at}.${names[k]}: ${coords[k]} is below the minimum ${MAP_MIN}; using ${MAP_MIN}`); coords[k] = MAP_MIN; }
      else if (coords[k] > MAP_MAX) { warnings.push(`${at}.${names[k]}: ${coords[k]} is above the maximum ${MAP_MAX}; using ${MAP_MAX}`); coords[k] = MAP_MAX; }
    }
    const [x1, y1, x2, y2] = coords;
    if (Math.hypot(x2 - x1, y2 - y1) <= EPS) { warnings.push(`${at}: zero length; dropped`); continue; }
    const out = { x1, y1, x2, y2 };
    if (source !== undefined) {
      if (SOURCES.includes(source)) out.source = source;
      else warnings.push(`${at}.source: ${shown(source)} is not one of ${SOURCES.join(', ')}; dropped`);
    }
    walls.push(out);
  }
  for (const [k, count] of unknown) warnings.push(`walls: unknown field "${k}" ignored (in ${count} segment${count === 1 ? '' : 's'})`);
  return { walls, warnings };
}

// Index of the first wall the segment touches, or -1. Walls are { x1, y1, x2, y2 } or [x1, y1, x2, y2].
export function crossesWall(walls, x1, y1, x2, y2) {
  if (!Array.isArray(walls)) return -1;
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    if (!w) continue;
    const touch = Array.isArray(w)
      ? segTouch(x1, y1, x2, y2, +w[0], +w[1], +w[2], +w[3])
      : segTouch(x1, y1, x2, y2, +w.x1, +w.y1, +w.x2, +w.y2);
    if (touch) return i;
  }
  return -1;
}

export function polylineCrossesWall(walls, points) {
  if (!Array.isArray(points)) return null;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    const wall = crossesWall(walls, a.x, a.y, b.x, b.y);
    if (wall >= 0) return { wall, piece: i };
  }
  return null;
}

export function polylineLength(points) {
  let total = 0;
  if (!Array.isArray(points)) return total;
  for (let i = 0; i + 1 < points.length; i++) total += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  return total;
}

// Point at distance d along the polyline, with d clamped to [0, length]. Null for an empty polyline.
export function pointAlong(points, d) {
  if (!Array.isArray(points) || !points.length) return null;
  let left = d > 0 ? d : 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= len) {
      const t = len > 0 ? left / len : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    left -= len;
  }
  const last = points[points.length - 1];
  return { x: last.x, y: last.y };
}

// ---------- spatial grid ----------

// Columns [spanC0, spanC1] of grid row j that segment a-b, widened by m, passes through.
// Written to module scratch to keep the hot loop allocation-free.
let spanC0 = 0, spanC1 = 0;
function rowSpan(g, j, ax, ay, bx, by, m) {
  const yLo = g.minY + j * g.size - m, yHi = yLo + g.size + 2 * m;
  const dy = by - ay;
  let xa, xb;
  if (Math.abs(dy) < 1e-12) {
    xa = ax < bx ? ax : bx; xb = ax < bx ? bx : ax;
  } else {
    let t1 = (yLo - ay) / dy, t2 = (yHi - ay) / dy;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 < 0) t1 = 0;
    if (t2 > 1) t2 = 1;
    if (t1 > t2) return false;
    xa = ax + (bx - ax) * t1; xb = ax + (bx - ax) * t2;
    if (xa > xb) { const t = xa; xa = xb; xb = t; }
  }
  let c0 = Math.floor((xa - m - g.minX) / g.size), c1 = Math.floor((xb + m - g.minX) / g.size);
  if (c0 < 0) c0 = 0;
  if (c1 > g.nx - 1) c1 = g.nx - 1;
  if (c0 > c1) return false;
  spanC0 = c0; spanC1 = c1;
  return true;
}

function rowRange(g, ylo, yhi) {
  let j0 = Math.floor((ylo - g.minY) / g.size), j1 = Math.floor((yhi - g.minY) / g.size);
  if (j0 < 0) j0 = 0;
  if (j1 > g.ny - 1) j1 = g.ny - 1;
  return [j0, j1];
}

// Uniform grid over the walls' bounding box. Each wall is listed in every cell it passes within
// MARGIN of, and queries visit every cell within MARGIN of the query, so two segments within EPS
// of each other always share a cell.
function makeGrid(X1, Y1, X2, Y2) {
  const n = X1.length;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, X1[i], X2[i]); maxX = Math.max(maxX, X1[i], X2[i]);
    minY = Math.min(minY, Y1[i], Y2[i]); maxY = Math.max(maxY, Y1[i], Y2[i]);
  }
  minX -= 1e-6; minY -= 1e-6; maxX += 1e-6; maxY += 1e-6;
  const side = Math.min(GRID_MAX_SIDE, Math.max(1, Math.ceil(Math.sqrt(n) * GRID_DENSITY)));
  const size = Math.max(maxX - minX, maxY - minY) / side;
  const g = {
    minX, minY, size,
    nx: Math.max(1, Math.ceil((maxX - minX) / size)),
    ny: Math.max(1, Math.ceil((maxY - minY) / size)),
    start: null, items: null,
    stamp: new Uint32Array(n), stampId: 0
  };
  const cellsOf = (i, visit) => {
    const ax = X1[i], ay = Y1[i], bx = X2[i], by = Y2[i];
    const [j0, j1] = rowRange(g, Math.min(ay, by) - MARGIN, Math.max(ay, by) + MARGIN);
    for (let j = j0; j <= j1; j++) {
      if (!rowSpan(g, j, ax, ay, bx, by, MARGIN)) continue;
      for (let c = spanC0; c <= spanC1; c++) visit(j * g.nx + c);
    }
  };
  const start = new Int32Array(g.nx * g.ny + 1);
  for (let i = 0; i < n; i++) cellsOf(i, cell => { start[cell + 1]++; });
  for (let k = 1; k < start.length; k++) start[k] += start[k - 1];
  const fill = start.slice(0, -1), items = new Int32Array(start[start.length - 1]);
  for (let i = 0; i < n; i++) cellsOf(i, cell => { items[fill[cell]++] = i; });
  g.start = start; g.items = items;
  return g;
}

function nextStamp(g) {
  if (++g.stampId >= 0xffffffff) { g.stamp.fill(0); g.stampId = 1; }
  return g.stampId;
}

// Calls visit(segment) once for every segment listed in a cell overlapping the square of radius r around (x, y).
function forNearIn(g, x, y, r, visit) {
  if (!g) return;
  const id = nextStamp(g);
  const [j0, j1] = rowRange(g, y - r - MARGIN, y + r + MARGIN);
  let c0 = Math.floor((x - r - MARGIN - g.minX) / g.size), c1 = Math.floor((x + r + MARGIN - g.minX) / g.size);
  if (c0 < 0) c0 = 0;
  if (c1 > g.nx - 1) c1 = g.nx - 1;
  for (let j = j0; j <= j1; j++) {
    for (let col = c0; col <= c1; col++) {
      const cell = j * g.nx + col;
      for (let k = g.start[cell]; k < g.start[cell + 1]; k++) {
        const w = g.items[k];
        if (g.stamp[w] === id) continue;
        g.stamp[w] = id;
        visit(w);
      }
    }
  }
}

// Seals for the gaps narrower than `gap` between a wall end and another wall, or between a wall end
// and the map edge: a segment from the end to the nearest point across the gap. Returns flat arrays.
function crackSeals(X1, Y1, X2, Y2, gap) {
  const out = { x1: [], y1: [], x2: [], y2: [] };
  if (!X1.length) return out;
  const g = makeGrid(X1, Y1, X2, Y2), gap2 = gap * gap, keys = new Set(), done = new Set();
  // A seal whose two ends both touch one wall lies along that wall (distance to a segment is convex
  // along a line), so it closes nothing: for example, from a door jamb along its own wall to a T.
  const covered = (ax, ay, bx, by) => {
    let on = false;
    forNearIn(g, ax, ay, EPS, w => {
      if (!on && pointSegDist2(ax, ay, X1[w], Y1[w], X2[w], Y2[w]) <= EPS2 && pointSegDist2(bx, by, X1[w], Y1[w], X2[w], Y2[w]) <= EPS2) on = true;
    });
    return on;
  };
  const add = (ax, ay, bx, by) => {
    const key = ax < bx || (ax === bx && ay <= by) ? `${ax},${ay},${bx},${by}` : `${bx},${by},${ax},${ay}`;
    if (keys.has(key)) return;
    keys.add(key);
    if (covered(ax, ay, bx, by)) return;
    out.x1.push(ax); out.y1.push(ay); out.x2.push(bx); out.y2.push(by);
  };
  const cand = [];
  for (let i = 0; i < X1.length; i++) {
    for (const [px, py] of [[X1[i], Y1[i]], [X2[i], Y2[i]]]) {
      const key = `${px},${py}`;
      if (done.has(key)) continue;
      done.add(key);
      cand.length = 0;
      forNearIn(g, px, py, gap, w => {
        const ax = X1[w], ay = Y1[w], dx = X2[w] - ax, dy = Y2[w] - ay;
        const d2 = pointSegDist2(px, py, ax, ay, X2[w], Y2[w]);
        if (d2 <= EPS2 || d2 >= gap2) return;   // touching (already closed) or wide enough
        const len2 = dx * dx + dy * dy;
        let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        cand.push({ d2, w, qx: ax + t * dx, qy: ay + t * dy });
      });
      // Nearest first. A seal crossed by a nearer sealed-to wall V (one not joined at its far end) is
      // redundant: the seal to V closes the part from this end to V, and the part from V on is closed
      // by the strictly shorter seals at V's or the far wall's own ends. This keeps dense clutter from
      // producing a seal for every pair of nearby walls.
      cand.sort((a, b) => a.d2 - b.d2 || a.w - b.w);
      const targets = [];
      for (const { w, qx, qy } of cand) {
        const crossed = targets.some(v => segTouch(px, py, qx, qy, X1[v], Y1[v], X2[v], Y2[v]) &&
          pointSegDist2(qx, qy, X1[v], Y1[v], X2[v], Y2[v]) > EPS2);
        if (crossed) continue;
        targets.push(w);
        add(px, py, qx, qy);
      }
      if (px < MAP_MIN || px > MAP_MAX || py < MAP_MIN || py > MAP_MAX) continue;
      if (px - MAP_MIN > EPS && px - MAP_MIN < gap) add(px, py, MAP_MIN, py);
      if (MAP_MAX - px > EPS && MAP_MAX - px < gap) add(px, py, MAP_MAX, py);
      if (py - MAP_MIN > EPS && py - MAP_MIN < gap) add(px, py, px, MAP_MIN);
      if (MAP_MAX - py > EPS && MAP_MAX - py < gap) add(px, py, px, MAP_MAX);
    }
  }
  return out;
}

// ---------- navigation ----------

function cleanClearance(v) {
  const c = Number(v);
  if (!Number.isFinite(c) || c <= 0) return DEFAULT_CLEARANCE;
  return Math.min(MAX_CLEARANCE, Math.max(MIN_CLEARANCE, c));
}

function requireFinite(name, x1, y1, x2, y2) {
  if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) {
    throw new TypeError(`walls: nav.${name} needs four finite numbers`);
  }
}

// options = { clearance = 0.2 }: map units, clamped to 0.02-1 (docs/PROTOTYPE.md §13a).
export function createNav(walls, options) {
  const c = cleanClearance(options?.clearance ?? DEFAULT_CLEARANCE);

  // Own copy of the geometry: every finite wall for the self-check, exact duplicates removed for the grid.
  const all = [];
  const seen = new Set();
  const ux1 = [], uy1 = [], ux2 = [], uy2 = [];
  for (const w of Array.isArray(walls) ? walls : []) {
    if (!w) continue;
    const s = Array.isArray(w) ? [+w[0], +w[1], +w[2], +w[3]] : [+w.x1, +w.y1, +w.x2, +w.y2];
    if (!s.every(Number.isFinite)) continue;
    all.push({ x1: s[0], y1: s[1], x2: s[2], y2: s[3] });
    const key = s[0] < s[2] || (s[0] === s[2] && s[1] <= s[3]) ? s.join(',') : [s[2], s[3], s[0], s[1]].join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    ux1.push(s[0]); uy1.push(s[1]); ux2.push(s[2]); uy2.push(s[3]);
  }
  // Cracks narrower than 2 x clearance are sealed (see the header); seals follow the walls in X1..Y2.
  // The relative tolerance keeps a gap of exactly 2 x clearance open despite rounding.
  const seals = crackSeals(ux1, uy1, ux2, uy2, 2 * c * (1 - 1e-9));
  const realCount = ux1.length;
  const X1 = Float64Array.from([...ux1, ...seals.x1]), Y1 = Float64Array.from([...uy1, ...seals.y1]);
  const X2 = Float64Array.from([...ux2, ...seals.x2]), Y2 = Float64Array.from([...uy2, ...seals.y2]);
  const sealList = seals.x1.map((x1, k) => ({ x1, y1: seals.y1[k], x2: seals.x2[k], y2: seals.y2[k] }));
  const grid = X1.length ? makeGrid(X1, Y1, X2, Y2) : null;

  function segBlocked(ax, ay, bx, by) {
    if (!grid) return false;
    const g = grid, stamp = g.stamp, id = nextStamp(g), start = g.start, items = g.items, nx = g.nx;
    let j0 = Math.floor(((ay < by ? ay : by) - MARGIN - g.minY) / g.size);
    let j1 = Math.floor(((ay < by ? by : ay) + MARGIN - g.minY) / g.size);
    if (j0 < 0) j0 = 0;
    if (j1 > g.ny - 1) j1 = g.ny - 1;
    // Scan cells outward from the segment's start: a blocking wall is often near it.
    const up = by >= ay, right = bx >= ax;
    for (let r = j0; r <= j1; r++) {
      const j = up ? r : j0 + j1 - r;
      if (!rowSpan(g, j, ax, ay, bx, by, MARGIN)) continue;
      const c0 = spanC0, c1 = spanC1;
      for (let s = c0; s <= c1; s++) {
        const cell = j * nx + (right ? s : c0 + c1 - s);
        for (let k = start[cell], end = start[cell + 1]; k < end; k++) {
          const w = items[k];
          if (stamp[w] === id) continue;
          stamp[w] = id;
          if (segTouch(ax, ay, bx, by, X1[w], Y1[w], X2[w], Y2[w])) return true;
        }
      }
    }
    return false;
  }

  const forNear = (x, y, r, visit) => forNearIn(grid, x, y, r, visit);

  function clearOf(x, y, r) {
    const r2 = r * r;
    let clear = true;
    forNear(x, y, r, w => { if (clear && pointSegDist2(x, y, X1[w], Y1[w], X2[w], Y2[w]) < r2) clear = false; });
    return clear;
  }

  // ----- waypoints around each wall end or junction -----
  // Each waypoint sits on the clearance circle of its corner (wcx, wcy) at angle wang; wlo..whi is
  // the range of angles at least 90 degrees from the corner's walls, used when refining a path.
  const wpx = [], wpy = [], wcx = [], wcy = [], wang = [], wlo = [], whi = [];
  const wpKeys = new Set(), ends = new Set();
  // A waypoint must be inside the map and at least `clearance` from every wall.
  const usableAt = (x, y) => x >= MAP_MIN && x <= MAP_MAX && y >= MAP_MIN && y <= MAP_MAX && clearOf(x, y, c * (1 - 1e-9));
  const usable = (px, py, angle) => usableAt(px + c * Math.cos(angle), py + c * Math.sin(angle));
  const addWaypoint = (px, py, angle, lo, hi) => {
    const x = px + c * Math.cos(angle), y = py + c * Math.sin(angle);
    const key = `${Math.round(x * 1e6)},${Math.round(y * 1e6)}`;
    if (wpKeys.has(key)) return;
    wpKeys.add(key);
    wpx.push(x); wpy.push(y); wcx.push(px); wcy.push(py); wang.push(angle); wlo.push(lo); whi.push(hi);
  };
  // Waypoints for the reflex gap from direction a0 to a1 (counterclockwise, wider than 180 degrees).
  // Directions at least 90 degrees from both walls keep a waypoint exactly `clearance` from them.
  // Two waypoints a quarter of that arc either side of its middle (45 degrees either side of
  // straight behind a free end) let a path turn back around the corner and also run alongside a
  // wall past its end. If another wall or the map edge rules one out, the arc is sampled finely
  // and the ends of each usable stretch are used instead, at most 90 degrees apart.
  const addGap = (px, py, a0, a1) => {
    const arc = a1 - a0 - Math.PI, mid = (a0 + a1) / 2, lo = a0 + Math.PI / 2, hi = a1 - Math.PI / 2;
    const standard = arc < 0.05 ? [mid] : [mid - arc / 4, mid + arc / 4];
    const fits = standard.map(a => usable(px, py, a));
    if (fits.every(Boolean) || arc < 0.05) {
      standard.forEach((a, k) => { if (fits[k]) addWaypoint(px, py, a, lo, hi); });
      return;
    }
    const steps = Math.max(2, Math.ceil(arc / (Math.PI / 32)));
    const maxRun = Math.max(1, Math.floor(Math.PI / 2 / (arc / steps)));   // sample steps per 90 degrees
    let runStart = -1;
    for (let s = 0; s <= steps + 1; s++) {
      const ok = s <= steps && usable(px, py, lo + (arc * s) / steps);
      if (ok && runStart < 0) runStart = s;
      if (!ok && runStart >= 0) {
        const runEnd = s - 1, pieces = Math.max(1, Math.ceil((runEnd - runStart) / maxRun));
        for (let k = 0; k <= pieces; k++) addWaypoint(px, py, lo + (arc * (runStart + ((runEnd - runStart) * k) / pieces)) / steps, lo, hi);
        runStart = -1;
      }
    }
  };
  // Waypoints go around wall ends only; seals add directions there (a sealed crack is a joint), not ends.
  const dirs = [];
  for (let i = 0; i < realCount; i++) {
    for (const [px, py] of [[X1[i], Y1[i]], [X2[i], Y2[i]]]) {
      const key = `${px},${py}`;
      if (ends.has(key)) continue;
      ends.add(key);
      // Directions of every wall leaving this point: walls ending here contribute one, walls
      // passing through it (a T-junction or a collinear overlap) contribute both of theirs.
      dirs.length = 0;
      forNear(px, py, JOIN, w => {
        const ax = X1[w], ay = Y1[w], bx = X2[w], by = Y2[w];
        if (pointSegDist2(px, py, ax, ay, bx, by) > JOIN2) return;
        const nearA = (px - ax) ** 2 + (py - ay) ** 2 <= JOIN2, nearB = (px - bx) ** 2 + (py - by) ** 2 <= JOIN2;
        if (nearA && nearB) return;
        if (nearA) dirs.push(Math.atan2(by - py, bx - px));
        else if (nearB) dirs.push(Math.atan2(ay - py, ax - px));
        else { dirs.push(Math.atan2(by - ay, bx - ax)); dirs.push(Math.atan2(ay - by, ax - bx)); }
      });
      if (!dirs.length) {
        // Only walls shorter than JOIN meet here: treat it as a post and ring it with waypoints.
        for (let k = 0; k < 4; k++) {
          const a = (k * Math.PI) / 2;
          if (usable(px, py, a)) addWaypoint(px, py, a, a - Math.PI, a + Math.PI);
        }
        continue;
      }
      dirs.sort((a, b) => a - b);
      for (let k = 0; k < dirs.length; k++) {
        const a0 = dirs[k], a1 = k + 1 < dirs.length ? dirs[k + 1] : dirs[0] + TAU;
        if (a1 - a0 > Math.PI + ANGLE_EPS) addGap(px, py, a0, a1);
      }
    }
  }
  const W = wpx.length;
  const WX = Float64Array.from(wpx), WY = Float64Array.from(wpy);
  const WCX = Float64Array.from(wcx), WCY = Float64Array.from(wcy);
  const WA = Float64Array.from(wang), WLO = Float64Array.from(wlo), WHI = Float64Array.from(whi);
  const words = (W + 31) >>> 5;

  // Visible waypoints of waypoint v, computed once and reused by every later search.
  const neighborCache = new Array(W);
  function neighbors(v) {
    const cached = neighborCache[v];
    if (cached) return cached;
    const vx = WX[v], vy = WY[v];
    const idx = [], dist = [], bits = new Uint32Array(words);
    for (let u = 0; u < W; u++) {
      if (u === v) continue;
      const other = neighborCache[u];
      const visible = other ? (other.bits[v >>> 5] >>> (v & 31)) & 1 : !segBlocked(vx, vy, WX[u], WY[u]);
      if (!visible) continue;
      idx.push(u);
      dist.push(Math.hypot(WX[u] - vx, WY[u] - vy));
      bits[u >>> 5] |= 1 << (u & 31);
    }
    const out = { idx: Int32Array.from(idx), dist: Float64Array.from(dist), bits };
    neighborCache[v] = out;
    return out;
  }

  // A* from (sx, sy) to (gx, gy). Returns the waypoint indices of a shortest path in the visibility
  // graph ([] when the straight segment is clear), or null when the goal is unreachable.
  // Edges from the start are checked lazily, when popped, so a search costs no up-front scan.
  function search(sx, sy, gx, gy) {
    if (!segBlocked(sx, sy, gx, gy)) return [];
    if (!W || segBlocked(sx, sy, sx, sy) || segBlocked(gx, gy, gx, gy)) return null;
    const START = W, GOAL = W + 1;
    const closed = new Uint8Array(W + 2), parent = new Int32Array(W + 2);
    const bestG = new Float64Array(W + 2).fill(Infinity);
    const eF = [], eG = [], eV = [], eFrom = [], eLazy = [], heap = [];
    const less = (a, b) => eF[a] < eF[b] || (eF[a] === eF[b] && a < b);
    const push = (v, from, g, lazy) => {
      const id = eF.length;
      eF.push(g + (v === GOAL ? 0 : Math.hypot(WX[v] - gx, WY[v] - gy)));
      eG.push(g); eV.push(v); eFrom.push(from); eLazy.push(lazy);
      let i = heap.length;
      heap.push(id);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!less(id, heap[p])) break;
        heap[i] = heap[p]; i = p;
      }
      heap[i] = id;
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        let i = 0;
        const n = heap.length;
        for (;;) {
          let m = 2 * i + 1;
          if (m >= n) break;
          if (m + 1 < n && less(heap[m + 1], heap[m])) m++;
          if (!less(heap[m], last)) break;
          heap[i] = heap[m]; i = m;
        }
        heap[i] = last;
      }
      return top;
    };

    closed[START] = 1;
    for (let v = 0; v < W; v++) push(v, START, Math.hypot(WX[v] - sx, WY[v] - sy), true);
    while (heap.length) {
      const id = pop(), v = eV[id];
      if (closed[v]) continue;
      if (eLazy[id] && segBlocked(sx, sy, WX[v], WY[v])) continue;
      closed[v] = 1;
      parent[v] = eFrom[id];
      if (v === GOAL) {
        const ids = [];
        for (let u = parent[GOAL]; u !== START; u = parent[u]) ids.push(u);
        return ids.reverse();
      }
      const g = eG[id], vx = WX[v], vy = WY[v];
      const toGoal = g + Math.hypot(gx - vx, gy - vy);
      if (toGoal < bestG[GOAL] && !segBlocked(vx, vy, gx, gy)) { bestG[GOAL] = toGoal; push(GOAL, v, toGoal, false); }
      const nb = neighbors(v), idx = nb.idx, dist = nb.dist;
      for (let k = 0; k < idx.length; k++) {
        const u = idx[k];
        if (closed[u]) continue;
        const ng = g + dist[k];
        if (ng < bestG[u]) { bestG[u] = ng; push(u, v, ng, false); }
      }
    }
    return null;
  }

  // Slides each bend along its corner's clearance circle, within the corner's open arc, while that
  // shortens the path; every bend stays usable and every piece clear. This recovers most of the
  // length lost to having only a couple of waypoints per corner. A moved piece also keeps at least
  // a tenth of the clearance from the corners of the bends at its ends (or as much as it had), so
  // turning back around a wall end can't shrink to grazing it.
  const pass2 = c * c * 0.01 * (1 - 1e-9);
  function refine(sx, sy, ids, gx, gy) {
    const n = ids.length;
    const xs = new Float64Array(n + 2), ys = new Float64Array(n + 2), as = new Float64Array(n + 2);
    const corner = new Int32Array(n + 2).fill(-1);
    xs[0] = sx; ys[0] = sy; xs[n + 1] = gx; ys[n + 1] = gy;
    for (let i = 0; i < n; i++) { xs[i + 1] = WX[ids[i]]; ys[i + 1] = WY[ids[i]]; as[i + 1] = WA[ids[i]]; corner[i + 1] = ids[i]; }
    const gap2 = (k, ax, ay, bx, by) => (k < 0 ? Infinity : pointSegDist2(WCX[k], WCY[k], ax, ay, bx, by));
    for (let round = 0; round < 2; round++) {
      for (let i = 1; i <= n; i++) {
        const k = ids[i - 1], px = WCX[k], py = WCY[k], lo = WLO[k], hi = WHI[k];
        const ax = xs[i - 1], ay = ys[i - 1], bx = xs[i + 1], by = ys[i + 1], ka = corner[i - 1], kb = corner[i + 1];
        const floorA = Math.min(pass2, gap2(ka, ax, ay, xs[i], ys[i])), floorAk = Math.min(pass2, gap2(k, ax, ay, xs[i], ys[i]));
        const floorB = Math.min(pass2, gap2(kb, xs[i], ys[i], bx, by)), floorBk = Math.min(pass2, gap2(k, xs[i], ys[i], bx, by));
        let best = Math.hypot(xs[i] - ax, ys[i] - ay) + Math.hypot(bx - xs[i], by - ys[i]);
        let cur = as[i];
        for (let step = Math.min(Math.PI / 4, hi - lo); step > 1e-4; step /= 4) {
          let pick = cur;
          for (let t = -4; t <= 4; t++) {
            if (t === 0) continue;
            const a = Math.min(hi, Math.max(lo, cur + (step * t) / 4));
            const qx = px + c * Math.cos(a), qy = py + c * Math.sin(a);
            const cost = Math.hypot(qx - ax, qy - ay) + Math.hypot(bx - qx, by - qy);
            if (cost >= best - 1e-12) continue;
            if (gap2(ka, ax, ay, qx, qy) < floorA || gap2(k, ax, ay, qx, qy) < floorAk ||
                gap2(kb, qx, qy, bx, by) < floorB || gap2(k, qx, qy, bx, by) < floorBk) continue;
            if (!usableAt(qx, qy) || segBlocked(ax, ay, qx, qy) || segBlocked(qx, qy, bx, by)) continue;
            best = cost; pick = a;
          }
          if (pick !== cur) { cur = pick; xs[i] = px + c * Math.cos(cur); ys[i] = py + c * Math.sin(cur); }
        }
        as[i] = cur;
      }
    }
    const via = [];
    for (let i = 1; i <= n; i++) via.push({ x: xs[i], y: ys[i] });
    return via;
  }

  // Interior points of a wall-free path, or null when the goal is unreachable.
  function route(sx, sy, gx, gy) {
    const ids = search(sx, sy, gx, gy);
    return ids && refine(sx, sy, ids, gx, gy);
  }

  // Joins the exact endpoints to waypoints found for nearby (rounded) endpoints. Drops a first or
  // last waypoint the exact endpoint can see past, and returns null unless every piece is clear.
  function fit(points) {
    while (points.length > 2 && !segBlocked(points[0].x, points[0].y, points[2].x, points[2].y)) points.splice(1, 1);
    while (points.length > 2) {
      const n = points.length;
      if (segBlocked(points[n - 3].x, points[n - 3].y, points[n - 1].x, points[n - 1].y)) break;
      points.splice(n - 2, 1);
    }
    for (let i = 0; i + 1 < points.length; i++) {
      if (segBlocked(points[i].x, points[i].y, points[i + 1].x, points[i + 1].y)) return null;
    }
    return points;
  }

  const rounded = new Map(), exact = new Map();
  const remember = (cache, key, value) => {
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, value);
  };
  const copy = p => ({ x: p.x, y: p.y });

  function path(x1, y1, x2, y2) {
    requireFinite('path', x1, y1, x2, y2);
    const start = { x: x1, y: y1 }, end = { x: x2, y: y2 };
    let points = null;
    if (!segBlocked(x1, y1, x2, y2)) {
      points = [start, end];
    } else {
      // Searches run on endpoints rounded to 1e-3 and are cached by them; the exact endpoints are
      // then joined on. Rounding moves a point less than 1e-3, so the join almost always holds.
      const q1 = Math.round(x1 * 1000), r1 = Math.round(y1 * 1000), q2 = Math.round(x2 * 1000), r2 = Math.round(y2 * 1000);
      const key = `${q1},${r1},${q2},${r2}`;
      const rs = { x: q1 / 1000, y: r1 / 1000 }, re = { x: q2 / 1000, y: r2 / 1000 };
      let via = rounded.get(key);
      if (via === undefined) { via = route(rs.x, rs.y, re.x, re.y); remember(rounded, key, via); }
      const hopsClear = !segBlocked(x1, y1, rs.x, rs.y) && !segBlocked(re.x, re.y, x2, y2);
      if (via) {
        points = fit([start, ...via.map(copy), end]);
        if (!points && hopsClear) points = fit([start, copy(rs), ...via.map(copy), copy(re), end]);
      }
      // The rounded result can't be used (or says unreachable while rounding crossed a wall): search exactly.
      if (!points && (via || !hopsClear)) {
        const ekey = `${x1},${y1},${x2},${y2}`;
        let exactVia = exact.get(ekey);
        if (exactVia === undefined) { exactVia = route(x1, y1, x2, y2); remember(exact, ekey, exactVia); }
        if (exactVia) points = [start, ...exactVia.map(copy), end];
      }
    }
    if (!points) return null;
    const bad = polylineCrossesWall(all, points);
    if (bad) throw new Error(`walls: nav.path built a path whose piece ${bad.piece} touches wall ${bad.wall}; this is an engine bug`);
    const leak = polylineCrossesWall(sealList, points);
    if (leak) throw new Error(`walls: nav.path built a path whose piece ${leak.piece} goes through sealed crack ${leak.wall}; this is an engine bug`);
    return { length: polylineLength(points), points };
  }

  return {
    // The sealed cracks, as { x1, y1, x2, y2 } segments (copies), for display and diagnostics.
    get seals() { return sealList.map(s => ({ ...s })); },
    blocked(x1, y1, x2, y2) {
      requireFinite('blocked', x1, y1, x2, y2);
      return segBlocked(x1, y1, x2, y2);
    },
    path,
    distance(x1, y1, x2, y2) {
      const p = path(x1, y1, x2, y2);
      return p ? p.length : Infinity;
    }
  };
}
