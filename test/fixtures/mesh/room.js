// Generated OBJ fixtures for test/builder-mesh.test.js. Nothing here comes from a real scan.
//
// The room: 8 m x 6 m outside, 0.2 m thick outer walls 2.7 m high, an interior wall (0.12 m thick)
// at x = 3.94..4.06 with a door gap from y = 2.5 to 3.4 that is open from the floor to 2.1 m (a
// lintel fills 2.1..2.7 m), a table 0.75 m high, a counter 1.2 m high (cut at 1.0 m but not at
// 1.5 m), a tall cabinet 1.9 m high, a floor, a ceiling, and a tiny stray triangle below the floor.
// Local coordinates have the room's south-west outer corner at (0, 0) and the floor at height 0;
// the file places that corner at ORIGIN so nothing relies on the mesh starting at zero.

export const ORIGIN = { x: 10, y: 20, z: 0.35 };

// Boxes as [x0, y0, z0, x1, y1, z1] in local meters.
export const BOXES = {
  southWall: [0, 0, 0, 8, 0.2, 2.7],
  northWall: [0, 5.8, 0, 8, 6, 2.7],
  westWall: [0, 0.2, 0, 0.2, 5.8, 2.7],
  eastWall: [7.8, 0.2, 0, 8, 5.8, 2.7],
  interiorSouth: [3.94, 0.2, 0, 4.06, 2.5, 2.7],
  interiorNorth: [3.94, 3.4, 0, 4.06, 5.8, 2.7],
  lintel: [3.94, 2.5, 2.1, 4.06, 3.4, 2.7],
  tableTop: [1.5, 1.0, 0.72, 3.0, 2.0, 0.75],
  tableLeg1: [1.5, 1.0, 0, 1.55, 1.05, 0.72],
  tableLeg2: [2.95, 1.0, 0, 3.0, 1.05, 0.72],
  tableLeg3: [1.5, 1.95, 0, 1.55, 2.0, 0.72],
  tableLeg4: [2.95, 1.95, 0, 3.0, 2.0, 0.72],
  counter: [5.0, 1.0, 0, 7.0, 1.6, 1.2],
  cabinet: [6.0, 5.1, 0, 7.2, 5.7, 1.9]
};

// Each box is written with a different face-reference form so the parser sees all of them.
const FORMS = ['v', 'v/vt', 'v//vn', 'v/vt/vn', 'neg'];

/**
 * Build the room as OBJ text.
 * @param {{ up?: 'z'|'y', crlf?: boolean }} [opts]  up 'y' writes (x, y, z) as (x, z, -y)
 */
export function roomObj({ up = 'z', crlf = false } = {}) {
  const lines = ['# generated test room for builder/mesh.js', 'mtllib room.mtl', 'o room'];
  let vCount = 0;
  const vertex = (lx, ly, lz) => {
    const x = lx + ORIGIN.x, y = ly + ORIGIN.y, z = lz + ORIGIN.z;
    const [a, b, c] = up === 'z' ? [x, y, z] : [x, z, -y];
    lines.push(`v ${a.toFixed(4)} ${b.toFixed(4)} ${c.toFixed(4)}`);
    vCount++;
  };
  lines.push('vt 0 0', 'vt 1 0', 'vt 1 1', 'vt 0 1', 'vn 0 0 1');
  const ref = (form, i, local) => {
    switch (form) {
      case 'v': return `${i}`;
      case 'v/vt': return `${i}/${(local % 4) + 1}`;
      case 'v//vn': return `${i}//1`;
      case 'v/vt/vn': return `${i}/${(local % 4) + 1}/1`;
      default: return `${i - vCount - 1}`;   // negative, relative to the vertices written so far
    }
  };
  const quad = (form, ids) => `f ${ids.map((i, k) => ref(form, i, k)).join(' ')}`;

  let b = 0;
  for (const [name, [x0, y0, z0, x1, y1, z1]] of Object.entries(BOXES)) {
    const form = FORMS[b++ % FORMS.length];
    lines.push(`g ${name}`, 'usemtl wall', 's off');
    const base = vCount + 1;
    for (const [x, y, z] of [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]) vertex(x, y, z);
    const v = k => base + k;
    for (const face of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) {
      lines.push(quad(form, face.map(v)));
    }
  }

  lines.push('g floor');
  const floor = vCount + 1;
  for (const [x, y] of [[0, 0], [8, 0], [8, 6], [0, 6]]) vertex(x, y, 0);
  lines.push(`f ${floor} ${floor + 1} ${floor + 2} ${floor + 3}`);

  lines.push('g ceiling');
  const ceiling = vCount + 1;
  for (const [x, y] of [[0.2, 0.2], [7.8, 0.2], [7.8, 5.8], [0.2, 5.8]]) vertex(x, y, 2.7);
  lines.push(`f ${ceiling + 3} ${ceiling + 2} ${ceiling + 1} ${ceiling}`);

  lines.push('g stray', '# scan noise below the floor');
  const stray = vCount + 1;
  vertex(2, 2, -0.3); vertex(2.2, 2, -0.3); vertex(2, 2.2, -0.3);
  lines.push(`f ${stray} ${stray + 1} ${stray + 2}`);

  return lines.join(crlf ? '\r\n' : '\n') + (crlf ? '\r\n' : '\n');
}

/**
 * The same room written the way a scan looks: every box face is a fine grid of triangles
 * (about `cell` meters) whose vertices are pushed in and out along the face normal by up to
 * `noise` meters (seeded, so the file is the same every time). Faces do not share vertices, so
 * the cuts arrive as many separate pieces with small cracks at the box corners.
 */
export function noisyRoomObj({ cell = 0.25, noise = 0.01, seed = 7 } = {}) {
  let state = seed >>> 0;
  const rand = () => {   // LCG in [-1, 1)
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 31 - 1;
  };
  const lines = ['# generated noisy test room for builder/mesh.js'];
  let vCount = 0;
  const patch = (corner, ea, eb, normal) => {
    const la = Math.hypot(...ea), lb = Math.hypot(...eb);
    const na = Math.max(1, Math.round(la / cell)), nb = Math.max(1, Math.round(lb / cell));
    const base = vCount + 1;
    for (let j = 0; j <= nb; j++) {
      for (let i = 0; i <= na; i++) {
        const k = rand() * noise;
        const p = [0, 1, 2].map(d => corner[d] + ea[d] * i / na + eb[d] * j / nb + normal[d] * k);
        lines.push(`v ${(p[0] + ORIGIN.x).toFixed(5)} ${(p[1] + ORIGIN.y).toFixed(5)} ${(p[2] + ORIGIN.z).toFixed(5)}`);
        vCount++;
      }
    }
    for (let j = 0; j < nb; j++) {
      for (let i = 0; i < na; i++) {
        const a = base + j * (na + 1) + i;
        lines.push(`f ${a} ${a + 1} ${a + na + 2}`, `f ${a} ${a + na + 2} ${a + na + 1}`);
      }
    }
  };
  for (const [x0, y0, z0, x1, y1, z1] of Object.values(BOXES)) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    patch([x0, y0, z0], [dx, 0, 0], [0, 0, dz], [0, 1, 0]);    // south face
    patch([x0, y1, z0], [dx, 0, 0], [0, 0, dz], [0, 1, 0]);    // north face
    patch([x0, y0, z0], [0, dy, 0], [0, 0, dz], [1, 0, 0]);    // west face
    patch([x1, y0, z0], [0, dy, 0], [0, 0, dz], [1, 0, 0]);    // east face
    patch([x0, y0, z1], [dx, 0, 0], [0, dy, 0], [0, 0, 1]);    // top
  }
  patch([0, 0, 0], [8, 0, 0], [0, 6, 0], [0, 0, 1]);             // floor
  patch([0.2, 0.2, 2.7], [7.6, 0, 0], [0, 5.6, 0], [0, 0, 1]);   // ceiling
  return lines.join('\n') + '\n';
}

/**
 * Plain closed boxes plus a floor quad under them, written as OBJ (z up, local coordinates as given).
 * @param {number[][]} boxes  [x0, y0, z0, x1, y1, z1] each
 */
export function boxesObj(boxes) {
  const lines = [];
  let v = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    for (const [x, y, z] of [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]) lines.push(`v ${x} ${y} ${z}`);
    for (const f of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) {
      lines.push(`f ${f.map(k => v + k + 1).join(' ')}`);
    }
    v += 8;
    minX = Math.min(minX, x0); minY = Math.min(minY, y0); maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1);
  }
  lines.push(`v ${minX} ${minY} 0`, `v ${maxX} ${minY} 0`, `v ${maxX} ${maxY} 0`, `v ${minX} ${maxY} 0`);
  lines.push(`f ${v + 1} ${v + 2} ${v + 3} ${v + 4}`);
  return lines.join('\n') + '\n';
}

/** Number of vertices and triangles roomObj writes. */
export function roomCounts() {
  const boxes = Object.keys(BOXES).length;
  return { vertices: boxes * 8 + 4 + 4 + 3, triangles: boxes * 12 + 2 + 2 + 1 };
}

/**
 * A large flat grid of quads (for parser speed checks): n x n quads, two triangles each.
 */
export function gridObj(n) {
  const parts = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) parts.push(`v ${(i * 0.01).toFixed(4)} ${(j * 0.01).toFixed(4)} ${(Math.sin(i + j) * 0.001).toExponential(3)}\n`);
  }
  const row = n + 1;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * row + i + 1;
      parts.push(`f ${a}/${a}/1 ${a + 1}/${a + 1}/1 ${a + row + 1}/${a + row + 1}/1 ${a + row}/${a + row}/1\n`);
    }
  }
  return parts.join('');
}
