// Slice a Matterport OBJ mesh at walking height into a 2D grid of blocked cells.
// Rule (SWARMSCOPE_SPEC.md §10b): mesh surfaces between about 0.3 m and 1.5 m above the floor are walls;
// agents must never walk through them. Plain JS, usable from Node and the browser.

export function parseObj(text) {
  const verts = [];
  const faces = [];
  let start = 0;
  const len = text.length;
  while (start < len) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = len;
    const c0 = text.charCodeAt(start), c1 = text.charCodeAt(start + 1);
    if (c0 === 118 /* v */ && c1 === 32) {
      const p = text.slice(start + 2, end).trim().split(/\s+/);
      verts.push(+p[0], +p[1], +p[2]);
    } else if (c0 === 102 /* f */ && c1 === 32) {
      const p = text.slice(start + 2, end).trim().split(/\s+/);
      const nv = verts.length / 3;
      const idx = p.map(tok => {
        const i = parseInt(tok, 10);   // "a", "a/b" and "a/b/c" all start with the vertex index
        return i < 0 ? nv + i : i - 1;
      });
      for (let k = 1; k + 1 < idx.length; k++) faces.push(idx[0], idx[k], idx[k + 1]);
    }
    start = end + 1;
  }
  return { vertices: Float64Array.from(verts), faces: Uint32Array.from(faces) };
}

function bbox(mesh) {
  const v = mesh.vertices;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) for (let a = 0; a < 3; a++) {
    if (v[i + a] < lo[a]) lo[a] = v[i + a];
    if (v[i + a] > hi[a]) hi[a] = v[i + a];
  }
  return { lo, hi };
}

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / Math.max(1e-9, b1 - b0);

// Matterport OBJs have been Z-up in the plan's x/y frame. Check that against the floor plan instead of
// assuming it, and fail loudly if neither Z-up nor Y-up lines up.
export function detectUpAxis(mesh, model) {
  let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;
  for (const f of model.floors || []) for (const v of f.vertices || []) {
    px0 = Math.min(px0, v.position.x); px1 = Math.max(px1, v.position.x);
    py0 = Math.min(py0, v.position.y); py1 = Math.max(py1, v.position.y);
  }
  const { lo, hi } = bbox(mesh);
  const zUp = overlap(lo[0], hi[0], px0, px1) * overlap(lo[1], hi[1], py0, py1);
  const yUp = overlap(lo[0], hi[0], px0, px1) * overlap(-hi[2], -lo[2], py0, py1);
  if (zUp >= 0.8 && zUp >= yUp) return { axis: 'z', reason: `plan overlap ${(zUp * 100).toFixed(0)}%` };
  if (yUp >= 0.8) return { axis: 'y', reason: `plan overlap ${(yUp * 100).toFixed(0)}%` };
  throw new Error(`Mesh does not line up with the floor plan (Z-up ${(zUp * 100).toFixed(0)}%, Y-up ${(yUp * 100).toFixed(0)}%). Check the mesh units and axes before using it.`);
}

// Plan coordinates (x, y) and height h of vertex i for the detected axis.
function vtx(mesh, i, up) {
  const v = mesh.vertices, k = i * 3;
  return up.axis === 'z' ? [v[k], v[k + 1], v[k + 2]] : [v[k], -v[k + 2], v[k + 1]];
}

// Clip a polygon (array of [x, y, h]) to h >= lo (keepAbove) or h <= hi.
function clipH(poly, level, keepAbove) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ina = keepAbove ? a[2] >= level : a[2] <= level;
    const inb = keepAbove ? b[2] >= level : b[2] <= level;
    if (ina) out.push(a);
    if (ina !== inb) {
      const t = (level - a[2]) / (b[2] - a[2]);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, level]);
    }
  }
  return out;
}

// Grid in map orientation: column from x, row from (y1 - y), so row 0 is the top of the drawn plan.
export function sliceToGrid(mesh, { up = { axis: 'z' }, floorZ = 0, zMin = 0.3, zMax = 1.5, cell = 0.25, boundsMeters }) {
  const [x0, y0, x1, y1] = boundsMeters;
  const w = Math.ceil((x1 - x0) / cell), h = Math.ceil((y1 - y0) / cell);
  const data = new Uint8Array(w * h);
  const lo = floorZ + zMin, hi = floorZ + zMax;
  const mark = (x, y) => {
    const c = Math.floor((x - x0) / cell), r = Math.floor((y1 - y) / cell);
    if (c >= 0 && c < w && r >= 0 && r < h) data[r * w + c] = 1;
  };
  const line = (ax, ay, bx, by) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (cell * 0.5)));
    for (let s = 0; s <= steps; s++) mark(ax + (bx - ax) * s / steps, ay + (by - ay) * s / steps);
  };
  const f = mesh.faces;
  for (let i = 0; i < f.length; i += 3) {
    const a = vtx(mesh, f[i], up), b = vtx(mesh, f[i + 1], up), c = vtx(mesh, f[i + 2], up);
    const hMin = Math.min(a[2], b[2], c[2]), hMax = Math.max(a[2], b[2], c[2]);
    if (hMax < lo || hMin > hi) continue;
    if (Math.max(a[0], b[0], c[0]) < x0 || Math.min(a[0], b[0], c[0]) > x1) continue;
    if (Math.max(a[1], b[1], c[1]) < y0 || Math.min(a[1], b[1], c[1]) > y1) continue;
    const poly = clipH(clipH([a, b, c], lo, true), hi, false);
    if (poly.length < 2) continue;
    // Edges catch thin vertical surfaces (walls, shelf sides); the fill catches horizontal ones (tables, counters).
    for (let k = 0; k < poly.length; k++) line(poly[k][0], poly[k][1], poly[(k + 1) % poly.length][0], poly[(k + 1) % poly.length][1]);
    if (poly.length >= 3) {
      let mx0 = Infinity, my0 = Infinity, mx1 = -Infinity, my1 = -Infinity;
      for (const p of poly) { mx0 = Math.min(mx0, p[0]); mx1 = Math.max(mx1, p[0]); my0 = Math.min(my0, p[1]); my1 = Math.max(my1, p[1]); }
      if ((mx1 - mx0) > cell || (my1 - my0) > cell) {
        for (let y = Math.floor((my0 - y0) / cell) * cell + y0 + cell / 2; y <= my1; y += cell) {
          for (let x = Math.floor((mx0 - x0) / cell) * cell + x0 + cell / 2; x <= mx1; x += cell) {
            if (inPoly2(x, y, poly)) mark(x, y);
          }
        }
      }
    }
  }
  return { w, h, cell, data, boundsMeters };
}

function inPoly2(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Run-length encode a 0/1 grid: comma-separated run lengths, starting with a run of zeros.
export function rle(data) {
  const runs = [];
  let cur = 0, n = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] ? 1 : 0;
    if (v === cur) n++;
    else { runs.push(n); cur = v; n = 1; }
  }
  runs.push(n);
  return runs.join(',');
}

export function unrle(text, size) {
  const data = new Uint8Array(size);
  let at = 0, v = 0;
  for (const tok of String(text).split(',')) {
    const n = parseInt(tok, 10) || 0;
    if (v) data.fill(1, at, Math.min(size, at + n));
    at += n; v ^= 1;
  }
  return data;
}

// Grid in metres → the geometry file's obstacles block in map units (docs/PROTOTYPE.md §9b).
export function encodeGrid(grid, transform) {
  const { scale, x0, y1 } = transform;
  const [gx0, , , gy1] = grid.boundsMeters;
  return {
    cell: grid.cell * scale, w: grid.w, h: grid.h,
    origin: [(gx0 - x0) * scale, (y1 - gy1) * scale],
    rle: rle(grid.data)
  };
}

export function decodeObstacles(obs) {
  if (!obs) return null;
  return { ...obs, data: unrle(obs.rle, obs.w * obs.h) };
}
