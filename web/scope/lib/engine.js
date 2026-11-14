// Adapter: a run recorded by the engine (engine/sim.js, docs/PROTOTYPE.md §7, §13, §14) → the RunBundle the
// scope display draws (§9b). The engine keeps walls, doors and scale in its own fields and drops unknown spec
// fields, so the display builds its geometry from those instead of `spec.geometry`.

const FILL_CELL = 0.5;            // map units per fill cell
const WALL_M = 0.15;              // drawn wall thickness in metres (the engine's walls are lines)
const OUTLINE_M = 0.02;           // drawn object outline thickness in metres (the renderer's minimum line wins)
const OBJECT_CELL_M = 0.05;       // object fill raster cell in metres

export function isEngineRun(raw) {
  return !raw.spec?.geometry && !raw.geometry && Array.isArray(raw.frames?.walls) && raw.frames.walls.length > 0;
}

export function adaptEngineRun(raw, { modelId = null } = {}) {
  const spec = raw.spec || {};
  const frames = raw.frames || {};
  const mpu = Number(spec.geo?.metersPerUnit) || 1;
  const walls = frames.walls.map(w => (Array.isArray(w) ? w : [w.x1, w.y1, w.x2, w.y2]));
  const doors = frames.doors || [];
  // Objects (§13f): the engine adds each outline to the walls. Draw them as solid, hatched shapes with a thin
  // outline, not as thick walls. Frames round walls to 0.01, so outlines are matched at that precision.
  const objects = (spec.objects || []).map(o => ({
    id: o.id, name: o.name, kind: o.kind,
    polygon: (o.polygon || []).map(p => (Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y]))
  })).filter(o => o.polygon.length >= 3);
  const key = (x1, y1, x2, y2) => {
    const a = `${x1.toFixed(2)},${y1.toFixed(2)}`, b = `${x2.toFixed(2)},${y2.toFixed(2)}`;
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  };
  const objectEdges = new Set(objects.flatMap(o => o.polygon.map((p, i) => {
    const q = o.polygon[(i + 1) % o.polygon.length];
    return key(p[0], p[1], q[0], q[1]);
  })));
  const isObjectEdge = w => objectEdges.has(key(w[0], w[1], w[2], w[3]));
  const nodes = (frames.nodes || []).map(n => ({ ...n, kind: n.kind === 'gate' ? 'entry' : n.kind, floor: 0 }));

  // Fit the drawn area to the walls and places, wherever they sit in the 0–100 map.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x1, y1, x2, y2] of walls) {
    minX = Math.min(minX, x1, x2); minY = Math.min(minY, y1, y2); maxX = Math.max(maxX, x1, x2); maxY = Math.max(maxY, y1, y2);
  }
  for (const n of nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
  const bounds = [Math.max(0, minX - 3), Math.max(0, minY - 3), Math.min(100, maxX + 3), Math.min(100, maxY + 3)];

  const thickness = WALL_M / mpu;
  const openings = doors.map(d => {
    const dx = d.x2 - d.x1, dy = d.y2 - d.y1, len = Math.hypot(dx, dy);
    return {
      id: d.id, name: d.name, x: (d.x1 + d.x2) / 2, y: (d.y1 + d.y2) / 2, angle: Math.atan2(dy, dx),
      width: len, widthM: len * mpu, type: 'doorway', exterior: !!d.exterior, side: d.exterior ? 'exterior' : 'interior', thickness
    };
  });

  const floor = {
    id: 'floor', label: spec.geo?.floor || 'Floor', sequence: 0, bounds,
    rooms: [], walls: walls.map(w => [...w, isObjectEdge(w) ? OUTLINE_M / mpu : thickness]), openings,
    obstacles: objects.length ? objectGrid(objects, bounds, OBJECT_CELL_M / mpu) : null,
    objects,
    fill: floorFill(walls, doors, nodes, bounds),
    pois: []
  };
  const geometry = {
    kind: 'interior',
    source: { provider: spec.geo?.source?.startsWith('matterport') ? 'matterport' : 'engine', modelId, name: spec.title },
    metersPerUnit: mpu, bounds, floors: [floor],
    provenance: spec.provenance || {}
  };

  // The engine's cast uses bio / goal / social; the inspector reads about / wants / listens_to.
  const minds = (spec.minds || []).map(m => ({
    ...m, about: m.about ?? m.bio, wants: m.wants ?? m.goal, listens_to: m.listens_to ?? m.social, app: m.app ?? m.informed
  }));

  return {
    ...raw,
    rawSpec: spec,      // the recorded world exactly as the engine wrote it: what "Edit the room" changes and posts back
    spec: { ...spec, minds, archetypes: spec.archetypes || [] },
    frames: { ...frames, stride: frames.stride || 4, nodes },
    geometry,
    decisions: raw.decisions || [],
    remarks: raw.remarks || [],
    agents: raw.agents || []
  };
}

// Objects as the display's obstacle raster (§9b: { cell, w, h, origin, rle } in map units), cell centres inside.
export function objectGrid(objects, bounds, cell) {
  const [x0, y0, x1, y1] = bounds;
  const w = Math.max(1, Math.ceil((x1 - x0) / cell)), h = Math.max(1, Math.ceil((y1 - y0) / cell));
  const data = new Uint8Array(w * h);
  for (const o of objects) {
    const P = o.polygon;
    const xs = P.map(p => p[0]), ys = P.map(p => p[1]);
    const c0 = Math.max(0, Math.floor((Math.min(...xs) - x0) / cell)), c1 = Math.min(w - 1, Math.floor((Math.max(...xs) - x0) / cell));
    const r0 = Math.max(0, Math.floor((Math.min(...ys) - y0) / cell)), r1 = Math.min(h - 1, Math.floor((Math.max(...ys) - y0) / cell));
    for (let r = r0; r <= r1; r++) {
      const y = y0 + (r + 0.5) * cell;
      for (let c = c0; c <= c1; c++) {
        const x = x0 + (c + 0.5) * cell;
        let inside = false;
        for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
          if ((P[i][1] > y) !== (P[j][1] > y) && x < (P[j][0] - P[i][0]) * (y - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0]) inside = !inside;
        }
        if (inside) data[r * w + c] = 1;
      }
    }
  }
  const runs = [];
  let cur = 0, n = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v === cur) n++;
    else { runs.push(n); cur = v; n = 1; }
  }
  runs.push(n);
  return { cell, w, h, origin: [x0, y0], rle: runs.join(',') };
}

// Floor fill: flood from the service points across cells not blocked by walls, with exterior doors closed so
// the fill stays inside. If it leaks to the edge (a gap in the walls), there is no fill rather than a wrong one.
export function floorFill(walls, doors, nodes, bounds) {
  const [, , W, H] = bounds;
  const w = Math.ceil(W / FILL_CELL), h = Math.ceil(H / FILL_CELL);
  const blocked = new Uint8Array(w * h);
  // Mark the cell under each sample along the wall. A diagonal wall becomes a staircase of cells that touch
  // at corners, which a 4-neighbour flood cannot slip through.
  const stamp = (x1, y1, x2, y2) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (FILL_CELL * 0.25)));
    for (let s = 0; s <= steps; s++) {
      const c = Math.floor((x1 + (x2 - x1) * s / steps) / FILL_CELL), r = Math.floor((y1 + (y2 - y1) * s / steps) / FILL_CELL);
      if (c >= 0 && r >= 0 && c < w && r < h) blocked[r * w + c] = 1;
    }
  };
  for (const [x1, y1, x2, y2] of walls) stamp(x1, y1, x2, y2);
  for (const d of doors) if (d.exterior) stamp(d.x1, d.y1, d.x2, d.y2);
  const data = new Uint8Array(w * h);
  const stack = [];
  for (const n of nodes) {
    if (n.kind !== 'service') continue;
    const i = Math.floor(n.y / FILL_CELL) * w + Math.floor(n.x / FILL_CELL);
    if (i >= 0 && i < data.length && !blocked[i] && !data[i]) { data[i] = 1; stack.push(i); }
  }
  let leaked = false;
  while (stack.length) {
    const i = stack.pop();
    const c = i % w, r = (i - c) / w;
    if (c === 0 || r === 0 || c === w - 1 || r === h - 1) { leaked = true; break; }
    for (const j of [i - 1, i + 1, i - w, i + w]) if (!blocked[j] && !data[j]) { data[j] = 1; stack.push(j); }
  }
  if (leaked || !data.some(Boolean)) return null;
  // Walls themselves count as floor under the wall line, so the fill meets the walls without a gap.
  for (let i = 0; i < data.length; i++) if (blocked[i]) {
    const c = i % w, r = (i - c) / w;
    if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dc, dr]) => data[(r + dr) * w + c + dc])) data[i] = 1;
  }
  return { cell: FILL_CELL, w, h, origin: [0, 0], data };
}

// Walk-aways from agent traces, for runs with no decision records (the engine's inline rules provider).
const TRACE_RULES = [
  { re: /^Saw (\d+) people in line at (.+?) \(~\d+ min\) and walked away$/, kind: 'line', place: 2 },
  { re: /^Gave up on (.+?) after \d+ min in line$/, kind: 'long', place: 1 }
];
export function decisionsFromTraces(agents, nodes) {
  const byName = new Map(nodes.map(n => [n.name, n.id]));
  const out = [];
  for (const a of agents) {
    for (const tr of a.trace || []) {
      for (const rule of TRACE_RULES) {
        const m = tr.m.match(rule.re);
        if (!m) continue;
        const placeId = byName.get(m[rule.place]);
        if (!placeId) continue;
        out.push({
          id: `trace-${a.id}-${tr.t}`, t: tr.t, agentId: a.id, personaId: a.personaId, kind: rule.kind, why: null, placeId,
          fromTrace: true, decision: { provider: 'rules' }, applied: { yes: false, action: 'leave', summary: tr.m }
        });
      }
    }
  }
  return out.sort((p, q) => p.t - q.t);
}
