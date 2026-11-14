// Adapter: a run recorded by the engine (engine/sim.js, docs/PROTOTYPE.md §7, §13, §14) → the RunBundle the
// scope display draws (§9b). The engine keeps walls, doors and scale in its own fields and drops unknown spec
// fields, so the display builds its geometry from those instead of `spec.geometry`.

const FILL_CELL = 0.5;            // map units per fill cell
const WALL_M = 0.15;              // drawn wall thickness in metres (the engine's walls are lines)

export function isEngineRun(raw) {
  return !raw.spec?.geometry && !raw.geometry && Array.isArray(raw.frames?.walls) && raw.frames.walls.length > 0;
}

export function adaptEngineRun(raw, { modelId = null } = {}) {
  const spec = raw.spec || {};
  const frames = raw.frames || {};
  const mpu = Number(spec.geo?.metersPerUnit) || 1;
  const walls = frames.walls.map(w => (Array.isArray(w) ? w : [w.x1, w.y1, w.x2, w.y2]));
  const doors = frames.doors || [];
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
    rooms: [], walls: walls.map(w => [...w, thickness]), openings, obstacles: null,
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
    spec: { ...spec, minds, archetypes: spec.archetypes || [] },
    frames: { ...frames, stride: frames.stride || 4, nodes },
    geometry,
    decisions: raw.decisions || [],
    remarks: raw.remarks || [],
    agents: raw.agents || []
  };
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
