// Matterport Model API (GraphQL) → floor-plan geometry for the scope display and the world builder
// (docs/PROTOTYPE.md §9b). Plain JS: no DOM, no Node built-ins, so browsers and Node can both import it.
//
// Map units: the longer side of the plan (all floors together, plus a margin) spans 0–100, y grows down.
// Each floor keeps the transform back to Matterport metres so scan points and the 3D tour line up.

const MARGIN_M = 1.5;

const isVoid = r => (r.keywords || []).includes('nonArea') || (r.keywords || []).includes('hide');

// Outline of a room from its boundary edges. Matterport boundaries are not simple loops: they include
// dangling wall stubs (degree-1 vertices) and junctions (degree 3+). Prune the stubs, trace every face of
// the remaining planar graph, and return the face with the largest area (the outer outline).
// `pos(id)` returns [x, y]. Returns an array of vertex ids, or [] if no closed face exists.
export function outerLoop(edgePairs, pos) {
  const adj = new Map();
  const add = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
  for (const [a, b] of edgePairs) if (a !== b && pos(a) && pos(b)) { add(a, b); add(b, a); }
  // Prune dangling stubs.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [v, ns] of adj) {
      if (ns.size <= 1) {
        for (const n of ns) adj.get(n)?.delete(v);
        adj.delete(v);
        changed = true;
      }
    }
  }
  if (adj.size < 3) return [];
  // Neighbours sorted by angle, for "next half-edge" lookups.
  const sorted = new Map();
  for (const [v, ns] of adj) {
    const [vx, vy] = pos(v);
    sorted.set(v, [...ns].sort((a, b) => Math.atan2(pos(a)[1] - vy, pos(a)[0] - vx) - Math.atan2(pos(b)[1] - vy, pos(b)[0] - vx)));
  }
  const used = new Set();
  let best = [], bestArea = 0;
  for (const [u, ns] of adj) for (const v of ns) {
    if (used.has(u + '>' + v)) continue;
    const face = [];
    let a = u, b = v;
    for (let guard = 0; guard < 4 * edgePairs.length + 8; guard++) {
      const key = a + '>' + b;
      if (used.has(key)) break;
      used.add(key);
      face.push(a);
      // At b, take the neighbour just before a in angular order (keeps the face on one side).
      const list = sorted.get(b);
      const i = list.indexOf(a);
      const c = list[(i - 1 + list.length) % list.length];
      a = b; b = c;
    }
    if (face.length >= 3) {
      const area = Math.abs(polygonArea(face.map(pos)));
      if (area > bestArea) { bestArea = area; best = face; }
    }
  }
  return best;
}

export function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInRoom(x, y, room) {
  if (!pointInPolygon(x, y, room.poly)) return false;
  return !(room.holes || []).some(h => pointInPolygon(x, y, h));
}

const median = xs => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// Opening span along its edge, as fractions [r0, r1] of the edge length.
export function openingSpan(op, edgeLen) {
  const half = edgeLen > 0 ? op.width / 2 / edgeLen : 0;
  return [Math.max(0, op.relativeCenter - half), Math.min(1, op.relativeCenter + half)];
}

// Split an edge into solid wall pieces around its openings. Returns [[r0, r1], ...] fractions.
export function solidSpans(spans) {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out = [];
  let at = 0;
  for (const [r0, r1] of sorted) {
    if (r0 > at + 1e-6) out.push([at, r0]);
    at = Math.max(at, r1);
  }
  if (at < 1 - 1e-6) out.push([at, 1]);
  return out;
}

export function normalizeMatterport(model) {
  const floors = [...(model.floors || [])].sort((a, b) => a.sequence - b.sequence);
  // Global bounds over all floors so floors stay aligned with each other.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of floors) for (const v of f.vertices || []) {
    x0 = Math.min(x0, v.position.x); x1 = Math.max(x1, v.position.x);
    y0 = Math.min(y0, v.position.y); y1 = Math.max(y1, v.position.y);
  }
  if (!Number.isFinite(x0)) throw new Error('The model has no floor-plan vertices.');
  x0 -= MARGIN_M; y0 -= MARGIN_M; x1 += MARGIN_M; y1 += MARGIN_M;
  const scale = 100 / Math.max(x1 - x0, y1 - y0);   // map units per metre
  const toMap = (x, y) => [(x - x0) * scale, (y1 - y) * scale];
  const W = (x1 - x0) * scale, H = (y1 - y0) * scale;

  const roomsByFloor = new Map();
  for (const r of model.rooms || []) {
    const fid = r.floor?.id;
    if (!fid) continue;
    if (!roomsByFloor.has(fid)) roomsByFloor.set(fid, []);
    roomsByFloor.get(fid).push(r);
  }

  const outFloors = floors.map(f => {
    const verts = new Map((f.vertices || []).map(v => [v.id, v.position]));
    const edges = new Map((f.edges || []).map(e => [e.id, e]));
    const rawRooms = (roomsByFloor.get(f.id) || []).filter(r => !isVoid(r) && r.boundary?.edges?.length);

    // How many real rooms use each edge: 1 means the edge faces the outside (or unscanned space).
    const edgeUse = new Map();
    for (const r of rawRooms) for (const e of r.boundary.edges) edgeUse.set(e.id, (edgeUse.get(e.id) || 0) + 1);

    const vpos = id => { const p = verts.get(id); return p ? [p.x, p.y] : null; };
    const loopPoly = edgeList => {
      const loop = outerLoop(edgeList.map(e => (e.vertices || []).map(v => v.id)).filter(p => p.length === 2), vpos);
      return loop.map(id => verts.get(id)).map(p => toMap(p.x, p.y));
    };

    const rooms = rawRooms.map(r => {
      const poly = loopPoly(r.boundary.edges);
      const holes = (r.holes || []).map(h => loopPoly(h.edges || [])).filter(h => h.length >= 3);
      const tag = (r.tags || [])[0];
      return {
        id: r.id, kind: tag || 'room', label: r.label || null,
        poly, holes,
        area: r.dimensionEstimates?.area ?? null,
        edges: r.boundary.edges.map(e => e.id)
      };
    }).filter(r => r.poly.length >= 3);

    const walls = [];
    const openings = [];
    for (const e of edges.values()) {
      const [va, vb] = (e.vertices || []).map(v => verts.get(v.id));
      if (!va || !vb) continue;
      const [ax, ay] = toMap(va.x, va.y), [bx, by] = toMap(vb.x, vb.y);
      const lenM = Math.hypot(vb.x - va.x, vb.y - va.y);
      const ops = (e.openings || []).filter(o => o && o.width > 0.05);
      const spans = ops.map(o => openingSpan(o, lenM));
      if (e.type === 'wall') {
        for (const [r0, r1] of solidSpans(spans)) {
          walls.push([ax + (bx - ax) * r0, ay + (by - ay) * r0, ax + (bx - ax) * r1, ay + (by - ay) * r1, (e.thickness || 0.15) * scale]);
        }
      }
      const exterior = (edgeUse.get(e.id) || 0) <= 1;
      const angle = Math.atan2(by - ay, bx - ax);
      for (const o of ops) {
        const x = ax + (bx - ax) * o.relativeCenter, y = ay + (by - ay) * o.relativeCenter;
        const inRooms = rooms.filter(r => r.edges.includes(e.id)).map(r => r.id);
        openings.push({
          id: o.id, x, y, angle, width: o.width * scale, widthM: o.width, height: o.height ?? null,
          type: o.type, exterior, rooms: inRooms, thickness: (e.thickness || 0.15) * scale
        });
      }
    }

    const scans = (model.locations || []).filter(l => l.floor?.id === f.id && l.position);
    return {
      id: f.id, label: f.label || `Floor ${f.sequence + 1}`, sequence: f.sequence,
      bounds: [0, 0, W, H],
      metersBounds: [x0, y0, x1, y1],
      elevation: median(scans.map(l => l.position.z)),
      transform: { scale, x0, y1 },
      rooms: rooms.map(({ edges: _e, ...r }) => r),
      walls, openings, obstacles: null, pois: []
    };
  });

  const floorIndex = new Map(floors.map((f, i) => [f.id, i]));
  const sweeps = (model.locations || []).filter(l => l.position && floorIndex.has(l.floor?.id)).map(l => {
    const [x, y] = toMap(l.position.x, l.position.y);
    return { id: l.id, floor: floorIndex.get(l.floor.id), x, y };
  });

  return {
    kind: 'interior',
    source: { provider: 'matterport', modelId: model.id, name: model.name },
    metersPerUnit: 1 / scale,
    bounds: [0, 0, W, H],
    floors: outFloors,
    sweeps,
    provenance: { rooms: 'data', walls: 'data', openings: 'data', obstacles: 'none', pois: 'none' }
  };
}

// Map units → Matterport metres for one floor (inverse of the transform above).
export function mapToMeters(floor, x, y) {
  const { scale, x0, y1 } = floor.transform;
  return [x / scale + x0, y1 - y / scale];
}
