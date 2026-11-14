// Fit-out files (docs/PROTOTYPE.md §14f): a proposed fit-out (gates and places in METERS, in the
// Matterport model's own coordinates) placed inside a real floor plan becomes a visit-mode world with
// the plan's walls and doors. Used for an empty shell, where the places are a design, not data.
//
//   applyFitout(plan, fitout, { margin = 8 }) → { world, report }
//
// - plan: the result of extractFloorplan (meters). It is converted with toMapUnits(plan, { margin }), and
//   every gate and place goes through the very same transform (X = tx + x * scale, Y = ty - y * scale:
//   the model's y points up the page, the map's y points down).
// - Every gate and place is checked: inside the map (and inside the 3-97 range the world keeps nodes
//   in), at least 0.3 m from every wall, and connected on foot. A place must be reachable from at least
//   one gate; a gate must reach at least one place (a gate is trivially reachable from itself, so this is
//   what "reachable on foot" can mean for it). Every failed check is listed in one thrown Error that
//   names the item, its position and the reason.
// - Doors: each plan door becomes a gap segment between the wall pieces on either side, named by what
//   it joins: an exterior door takes the name of the nearest gate within 3 m (else "Exterior door N"), an
//   interior door the nearest place on each side, by walking distance with the door itself closed (else
//   "Interior door N", also when both sides lead to the same place).
// - The world must pass validateWorld with no errors, or applyFitout throws with the errors.
import { toMapUnits } from './matterport.js';
import { createNav, crossesWall } from '../engine/walls.js';
import { validateWorld } from '../engine/spec.js';

const MIN_WALL_M = 0.3;          // every gate and place keeps at least this far from every wall
const GATE_NAME_M = 3;           // an exterior door takes the name of a gate at most this far away
const CLEARANCE_CAP_M = 0.3;     // same cap as floorplanToWorld and the composer
const MIN_CLEARANCE = 0.02, MAX_CLEARANCE = 1;
const MAP_LO = 3, MAP_HI = 97;   // node coordinate range in the world spec
const MIN_TRAVEL = 0.2, MAX_TRAVEL = 600;   // §14d: travelSpeed range in map units per minute
const DEFAULT_WALK_M_PER_MIN = 75;
const MAX_NODES = 60, MAX_DOORS = 500;
const NAME_MAX = 40;

const FITOUT_FIELDS = ['$schema', 'model', 'floor', 'title', 'question', 'context', 'leaveLabel', 'clockStart', 'duration',
  'walkMetersPerMinute', 'arrivals', 'gates', 'places', 'archetypes', 'minds', 'provenance', 'assumptions'];
const GATE_FIELDS = ['id', 'name', 'at', 'weight', 'exit'];
const PLACE_FIELDS = ['id', 'name', 'at', 'servers', 'serviceTime', 'serviceDist', 'appeal', 'price', 'tags', 'about'];
const PASS_THROUGH = ['title', 'question', 'context', 'leaveLabel', 'clockStart', 'duration', 'arrivals'];

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = v => (Array.isArray(v) ? v : []);
const fin = v => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));
const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1e3) / 1e3;
const r4 = v => Math.round(v * 1e4) / 1e4;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const cut = (s, n) => String(s).slice(0, n).trim();
const m2 = v => String(+Number(v).toFixed(2));
const copy = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

function nearestWall(walls, p) {
  let dist = Infinity, index = -1;
  walls.forEach((w, k) => { const d = segDist(p.x, p.y, w.x1, w.y1, w.x2, w.y2); if (d < dist) { dist = d; index = k; } });
  return { dist, index };
}

const unit = (dx, dy) => { const l = Math.hypot(dx, dy) || 1; return { x: dx / l, y: dy / l }; };

// The plan's bounding box, as extractFloorplan computes it, for hand-made plans that leave it out.
function withBounds(plan) {
  if (isObj(plan.bounds) && ['minX', 'minY', 'maxX', 'maxY'].every(k => fin(plan.bounds[k]))) return plan;
  const pts = [
    ...arr(plan.walls).flatMap(w => [{ x: w?.x1, y: w?.y1 }, { x: w?.x2, y: w?.y2 }]),
    ...arr(plan.rooms).flatMap(r => arr(r?.polygon)),
    ...arr(plan.doors)
  ].filter(p => isObj(p) && fin(p.x) && fin(p.y)).map(p => ({ x: Number(p.x), y: Number(p.y) }));
  if (!pts.length) return plan;
  return {
    ...plan,
    bounds: { minX: Math.min(...pts.map(p => p.x)), minY: Math.min(...pts.map(p => p.y)), maxX: Math.max(...pts.map(p => p.x)), maxY: Math.max(...pts.map(p => p.y)) }
  };
}

// ---------- doors (the composer's logic; builder/compose.js does not export it) ----------

// A plan door as a gap segment between the wall pieces on either side of its center. Uses the door's own
// jamb-to-jamb ends when the plan gives them; otherwise the ends of the wall pieces that share its edgeId;
// otherwise the nearest wall's direction and the door width. The ends are pulled in slightly so the
// segment lies in the gap without touching either jamb. Returns { x1, y1, x2, y2, gap: [a, b], width } or null,
// where gap is the unshortened jamb-to-jamb segment.
function doorSegment(d, walls, clearance) {
  let a, b;
  if ([d.x1, d.y1, d.x2, d.y2].every(fin)) {
    a = { x: +d.x1, y: +d.y1 }; b = { x: +d.x2, y: +d.y2 };
  } else {
    if (!fin(d.x) || !fin(d.y)) return null;
    const c = { x: +d.x, y: +d.y };
    const w = fin(d.width) && Number(d.width) > 0 ? Number(d.width) : null;
    const pieces = d.edgeId !== undefined && d.edgeId !== null
      ? walls.filter(s => s.edgeId === d.edgeId || arr(s.edgeIds).includes(d.edgeId)) : [];
    if (pieces.length) {
      const ref = pieces.reduce((m, s) => (Math.hypot(s.x2 - s.x1, s.y2 - s.y1) > Math.hypot(m.x2 - m.x1, m.y2 - m.y1) ? s : m));
      const u = unit(ref.x2 - ref.x1, ref.y2 - ref.y1);
      const t0 = (c.x - ref.x1) * u.x + (c.y - ref.y1) * u.y;
      const o = { x: ref.x1 + u.x * t0, y: ref.y1 + u.y * t0 };   // the center, moved onto the wall line
      let lo = -Infinity, hi = Infinity;
      for (const s of pieces) {
        const ta = (s.x1 - o.x) * u.x + (s.y1 - o.y) * u.y, tb = (s.x2 - o.x) * u.x + (s.y2 - o.y) * u.y;
        if (Math.max(ta, tb) <= 1e-9) lo = Math.max(lo, Math.max(ta, tb));
        else if (Math.min(ta, tb) >= -1e-9) hi = Math.min(hi, Math.min(ta, tb));
      }
      if (lo === -Infinity) lo = w ? -w / 2 : NaN;
      if (hi === Infinity) hi = w ? w / 2 : NaN;
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
      a = { x: o.x + u.x * lo, y: o.y + u.y * lo }; b = { x: o.x + u.x * hi, y: o.y + u.y * hi };
    } else {
      if (!w) return null;
      let best = null, bd = Infinity;
      for (const s of walls) { const dd = segDist(c.x, c.y, s.x1, s.y1, s.x2, s.y2); if (dd < bd) { bd = dd; best = s; } }
      const u = best ? unit(best.x2 - best.x1, best.y2 - best.y1) : { x: 1, y: 0 };
      a = { x: c.x - u.x * w / 2, y: c.y - u.y * w / 2 }; b = { x: c.x + u.x * w / 2, y: c.y + u.y * w / 2 };
    }
  }
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(len > 1e-6)) return null;
  for (const frac of [Math.min(0.25 * clearance, 0.1 * len) / len, 0.1, 0.25, 0.4]) {
    const s = {
      x1: r4(a.x + (b.x - a.x) * frac), y1: r4(a.y + (b.y - a.y) * frac),
      x2: r4(b.x - (b.x - a.x) * frac), y2: r4(b.y - (b.y - a.y) * frac)
    };
    if (crossesWall(walls, s.x1, s.y1, s.x2, s.y2) < 0) return { ...s, gap: [a, b], width: len };
  }
  return null;
}

// Joins two names into a door name of at most 40 characters: "Taquería Sol / Food hall restroom".
// Long names lose a trailing "(...)" first, then are cut.
function joinName(a, b, max = NAME_MAX) {
  if (a.length + b.length + 3 <= max) return `${a} / ${b}`;
  const bare = s => s.replace(/\s*\([^)]*\)\s*$/, '') || s;
  [a, b] = [bare(a), bare(b)];
  if (a.length + b.length + 3 <= max) return `${a} / ${b}`;
  const half = Math.floor((max - 3) / 2);
  if (a.length <= half) return `${a} / ${cut(b, max - 3 - a.length)}`;
  if (b.length <= half) return `${cut(a, max - 3 - b.length)} / ${b}`;
  return `${cut(a, half)} / ${cut(b, max - 3 - half)}`;
}

function uniqueName(base, used, max = NAME_MAX) {
  let n = cut(base, max), k = 2;
  while (used.has(n)) n = `${cut(base, max - 3)} ${k++}`;
  used.add(n);
  return n;
}

// A point a short way off the door's middle on each side (null when no clear spot is found), for
// telling what lies on either side of it.
function sideProbes(seg, walls, mpu, clearance) {
  const [a, b] = seg.gap;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const u = unit(b.x - a.x, b.y - a.y), n = { x: -u.y, y: u.x };
  return [1, -1].map(sg => {
    let off = Math.max(MIN_WALL_M / mpu, 2 * clearance);
    for (let k = 0; k < 8; k++, off /= 2) {
      const q = { x: mx + sg * n.x * off, y: my + sg * n.y * off };
      if (q.x < 0 || q.x > 100 || q.y < 0 || q.y > 100) continue;
      if (crossesWall(walls, mx, my, q.x, q.y) < 0) return q;
    }
    return null;
  });
}

// ---------- reading the fit-out ----------

function readPoint(at) {
  if (Array.isArray(at) && fin(at[0]) && fin(at[1])) return { x: Number(at[0]), y: Number(at[1]) };
  if (isObj(at) && fin(at.x) && fin(at.y)) return { x: Number(at.x), y: Number(at.y) };
  return null;
}

function readItems(fitout, key, fields, problems, warn, usedIds) {
  const list = fitout[key];
  if (!Array.isArray(list) || !list.length) { problems.push(`${key}: the fit-out needs a non-empty list of ${key}`); return []; }
  const out = [];
  list.forEach((item, i) => {
    const path = `${key}[${i}]`;
    if (!isObj(item)) { problems.push(`${path}: not an object`); return; }
    const id = typeof item.id === 'string' || typeof item.id === 'number' ? String(item.id).trim() : '';
    if (!id) { problems.push(`${path}: needs an id`); return; }
    const what = `${key === 'gates' ? 'gate' : 'place'} "${id}"${item.name && item.name !== id ? ` (${item.name})` : ''}`;
    if (usedIds.has(id)) { problems.push(`${what}: the id "${id}" is used more than once among gates and places`); return; }
    usedIds.add(id);
    const at = readPoint(item.at);
    if (!at) { problems.push(`${what}: "at" must be { x, y } in meters`); return; }
    for (const k of Object.keys(item)) if (!fields.includes(k)) warn(`${what}: unknown field "${k}"; ignored`);
    out.push({ src: item, id, name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id, what, at });
  });
  return out;
}

// ---------- applyFitout ----------

export function applyFitout(plan, fitout, { margin = 8 } = {}) {
  if (!isObj(plan)) throw new TypeError('applyFitout: expected a floor plan from extractFloorplan (builder/matterport.js)');
  if (plan.units === 'map') throw new Error('applyFitout: the plan is already in map units; pass the result of extractFloorplan (meters), so the fit-out goes through the same transform');
  if (!isObj(fitout)) throw new TypeError('applyFitout: expected a fit-out object (docs/PROTOTYPE.md §14f)');
  const warnings = [];
  const warn = m => { if (!warnings.includes(m)) warnings.push(m); };
  for (const k of Object.keys(fitout)) if (!FITOUT_FIELDS.includes(k)) warn(`fit-out field "${k}" is not part of a fit-out; ignored`);

  // ----- the plan in map units, and the transform the fit-out goes through -----
  const mp = toMapUnits(withBounds(plan), { margin });
  if (!isObj(mp.bounds)) throw new Error('applyFitout: the floor plan has nothing on it (no walls, rooms or doors)');
  const { scale, tx, ty } = mp.transform;
  const flip = mp.transform.flipY !== false;
  const toMap = p => ({ x: r4(tx + p.x * scale), y: r4(flip ? ty - p.y * scale : ty + p.y * scale) });
  const mpuRaw = Number(mp.metersPerUnit);
  const mpu = +mpuRaw.toPrecision(6);
  const walls = arr(mp.walls).filter(w => [w?.x1, w?.y1, w?.x2, w?.y2].every(fin));
  const planWalls = arr(plan.walls);
  if (!walls.length) warn('the floor plan has no walls; people will walk in straight lines');

  // ----- solid objects (builder/objects.js, meters): their outlines are walls for every check below -----
  const objects = [];
  arr(plan.objects).forEach((ob, k) => {
    const pts = arr(ob?.polygon).filter(p => fin(p?.x) && fin(p?.y));
    if (pts.length < 3) { warn(`object ${ob?.id ?? k + 1}: fewer than 3 outline points; left out`); return; }
    const polygon = pts.map(toMap).map(p => ({ x: r4(clamp(p.x, 0, 100)), y: r4(clamp(p.y, 0, 100)) }));
    objects.push({ id: String(ob.id ?? `obj${k + 1}`), name: cut(ob.name ?? `Object ${k + 1}`, 60), kind: cut(ob.kind ?? 'object', 30),
      source: ob.source ?? 'mesh-slice', polygon, ...(fin(ob.areaM2) ? { areaM2: Number(ob.areaM2) } : {}),
      ...(Array.isArray(ob.sizeM) ? { sizeM: ob.sizeM.slice(0, 2) } : {}) });
  });
  const objectEdges = objects.flatMap(ob => ob.polygon.map((p, i) => {
    const q = ob.polygon[(i + 1) % ob.polygon.length];
    return { x1: p.x, y1: p.y, x2: q.x, y2: q.y, object: ob };
  })).filter(e => Math.hypot(e.x2 - e.x1, e.y2 - e.y1) > 1e-6);
  const solid = [...walls, ...objectEdges];

  const modelId = plan.modelId ?? null;
  if (fitout.model && modelId && String(fitout.model) !== String(modelId)) {
    warn(`the fit-out is for model ${fitout.model}, but the floor plan is from model ${modelId}`);
  }
  const planFloor = isObj(plan.floor) ? plan.floor : null;
  if (fin(fitout.floor) && planFloor && fin(planFloor.sequence) && Number(fitout.floor) !== Number(planFloor.sequence)) {
    warn(`the fit-out is for floor ${fitout.floor}, but the floor plan is floor ${planFloor.sequence}${planFloor.label ? ` ("${planFloor.label}")` : ''}`);
  }

  // ----- clearance: at most a quarter of the narrowest door, capped, within the spec's 0.02-1 -----
  const doorWidthM = d => (fin(d.widthM) ? Number(d.widthM) : fin(d.width) ? Number(d.width) * mpuRaw : null);
  const widths = arr(mp.doors).filter(isObj).map(doorWidthM).filter(v => v > 0);
  let clearance = 0.2;
  if (widths.length) {
    const quarter = Math.min(Math.min(...widths) / 4, CLEARANCE_CAP_M) / mpuRaw;
    if (quarter < MIN_CLEARANCE) warn(`the narrowest door (${m2(Math.min(...widths))} m) is under 4 x the minimum path clearance of ${MIN_CLEARANCE} map units; using ${MIN_CLEARANCE}`);
    clearance = clamp(Math.floor(quarter * 1e4) / 1e4, MIN_CLEARANCE, MAX_CLEARANCE);
  }
  const nav = createNav(solid, { clearance });

  // ----- gates and places: read, convert, check -----
  const problems = [];
  const usedIds = new Set();
  const gates = readItems(fitout, 'gates', GATE_FIELDS, problems, warn, usedIds);
  const places = readItems(fitout, 'places', PLACE_FIELDS, problems, warn, usedIds);
  if (gates.length + places.length > MAX_NODES) problems.push(`the fit-out has ${gates.length + places.length} gates and places; a world holds at most ${MAX_NODES}`);
  if (problems.length) throw fitoutError('the fit-out cannot be read', problems);

  const minWallMap = MIN_WALL_M / mpuRaw;
  const where = it => `at (${m2(it.at.x)}, ${m2(it.at.y)}) m, map (${m2(it.map.x)}, ${m2(it.map.y)})`;
  const placed = it => {
    it.map = toMap(it.at);
    const { x, y } = it.map;
    if (x < 0 || x > 100 || y < 0 || y > 100) {
      problems.push(`${it.what} ${where(it)}: outside the 0-100 map; move it inside the building or use a larger margin`);
      return false;
    }
    if (x < MAP_LO || x > MAP_HI || y < MAP_LO || y > MAP_HI) {
      problems.push(`${it.what} ${where(it)}: outside the ${MAP_LO}-${MAP_HI} range where the world keeps nodes (it would be moved); move it inward or use a larger margin`);
      return false;
    }
    const near = nearestWall(solid, it.map);
    if (near.index >= walls.length && near.dist < minWallMap - 1e-9) {
      const ob = solid[near.index].object;
      problems.push(`${it.what} ${where(it)}: ${m2(near.dist * mpuRaw)} m from ${ob.name} (${ob.id}, from the mesh); every gate and place must be at least ${MIN_WALL_M} m from every wall and object`);
      return false;
    }
    if (near.index >= 0 && near.dist < minWallMap - 1e-9) {
      const w = planWalls[near.index] ?? {};
      const wallAt = [w.x1, w.y1, w.x2, w.y2].every(fin) ? ` (the wall from (${m2(w.x1)}, ${m2(w.y1)}) to (${m2(w.x2)}, ${m2(w.y2)}) m)` : '';
      problems.push(`${it.what} ${where(it)}: ${m2(near.dist * mpuRaw)} m from a wall${wallAt}; every gate and place must be at least ${MIN_WALL_M} m from every wall`);
      return false;
    }
    return true;
  };
  const okGates = gates.filter(placed);
  const okPlaces = places.filter(placed);
  // A place needs a gate it can be reached from. A gate needs a place it reaches, judged only against
  // places some gate reaches, so one sealed-off place is not also blamed on every gate.
  const reach = (a, b) => !!nav.path(a.map.x, a.map.y, b.map.x, b.map.y);
  const reached = [];
  if (okGates.length) {
    for (const p of okPlaces) {
      if (okGates.some(g => reach(g, p))) reached.push(p);
      else problems.push(`${p.what} ${where(p)}: cannot be reached on foot from any gate; walls seal it off (is it in a closed room?)`);
    }
  }
  if (reached.length) {
    for (const g of okGates) {
      if (!reached.some(p => reach(g, p))) problems.push(`${g.what} ${where(g)}: no place can be reached on foot from it; walls seal it off (is it in a closed room?)`);
    }
  }
  if (problems.length) throw fitoutError(`${problems.length} gate(s) or place(s) failed the checks`, problems);

  // ----- nodes -----
  const nodes = [];
  for (const g of gates) {
    const s = g.src;
    if (s.exit !== undefined && typeof s.exit !== 'boolean') warn(`${g.what}: "exit" should be true or false; treated as true (people can leave here)`);
    const node = { id: g.id, name: g.name, kind: s.exit === false ? 'entry' : 'gate', x: g.map.x, y: g.map.y };
    if (s.weight !== undefined) node.weight = s.weight;
    nodes.push(node);
  }
  for (const p of places) {
    const node = { id: p.id, name: p.name, kind: 'service', x: p.map.x, y: p.map.y };
    for (const k of ['servers', 'serviceTime', 'serviceDist', 'appeal', 'price', 'tags', 'about']) if (p.src[k] !== undefined) node[k] = copy(p.src[k]);
    nodes.push(node);
  }

  // ----- doors: gap segments, named by what they join -----
  const doors = [];
  arr(mp.doors).forEach((d, k) => {
    if (!isObj(d)) return;
    const seg = doorSegment(d, walls, clearance);
    const label = d.id ?? `door ${k + 1}`;
    if (!seg) { warn(`plan door ${label}: could not be placed as a gap between walls; it is not counted`); return; }
    const ids = arr(d.roomIds);
    const exterior = typeof d.outside === 'boolean' ? d.outside : ids.filter(x => x !== null && x !== undefined).length === 1 && ids.includes(null);
    doors.push({ src: d, k, seg, exterior, widthM: doorWidthM(d) ?? seg.width * mpuRaw });
  });
  if (doors.length > MAX_DOORS) { warn(`${doors.length} doors is above the world maximum of ${MAX_DOORS}; kept the first ${MAX_DOORS}`); doors.length = MAX_DOORS; }

  // Exterior doors: the nearest gate within 3 m, one door per gate, closest pairs first.
  const gateNodes = gates.map(g => ({ name: g.name, map: g.map }));
  const pairs = [];
  for (const d of doors.filter(x => x.exterior)) {
    for (const g of gateNodes) {
      const dist = segDist(g.map.x, g.map.y, d.seg.x1, d.seg.y1, d.seg.x2, d.seg.y2) * mpuRaw;
      if (dist <= GATE_NAME_M) pairs.push({ d, g, dist });
    }
  }
  pairs.sort((p, q) => p.dist - q.dist || p.d.k - q.d.k);
  const namedDoors = new Set(), namingGates = new Set();
  for (const { d, g } of pairs) {
    if (namedDoors.has(d) || namingGates.has(g)) continue;
    d.name = g.name; namedDoors.add(d); namingGates.add(g);
  }
  let exteriorN = 0, interiorN = 0;
  for (const d of doors) if (d.exterior && !d.name) d.name = `Exterior door ${++exteriorN}`;

  // Interior doors: the nearest place on each side, by walking distance with this door closed.
  const placeNodes = places.map(p => ({ name: p.name, map: p.map }));
  doors.filter(x => !x.exterior).forEach(d => {
    const [a, b] = d.seg.gap, u = unit(b.x - a.x, b.y - a.y), e = 0.05;
    const closed = createNav([...solid, { x1: a.x - u.x * e, y1: a.y - u.y * e, x2: b.x + u.x * e, y2: b.y + u.y * e }], { clearance });
    const sides = sideProbes(d.seg, walls, mpuRaw, clearance).map(q => {
      if (!q) return null;
      let best = null;
      for (const p of placeNodes) {
        const dist = closed.distance(q.x, q.y, p.map.x, p.map.y);
        if (Number.isFinite(dist) && (!best || dist < best.dist - 1e-9)) best = { p, dist };
      }
      return best;
    });
    if (sides[0] && sides[1] && sides[0].p !== sides[1].p) {
      const [near, far] = sides[0].dist <= sides[1].dist ? sides : [sides[1], sides[0]];
      d.name = joinName(near.p.name, far.p.name);
    } else {
      d.name = `Interior door ${++interiorN}`;
    }
  });

  const usedNames = new Set(), usedDoorIds = new Set();
  for (const d of doors) {
    d.name = uniqueName(d.name, usedNames);
    const base = String(d.src.id ?? `door_${d.k + 1}`).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || `door_${d.k + 1}`;
    d.id = uniqueName(base, usedDoorIds);
  }
  const worldDoors = doors.map(d => ({ id: d.id, name: d.name, x1: d.seg.x1, y1: d.seg.y1, x2: d.seg.x2, y2: d.seg.y2, exterior: d.exterior }));

  // ----- archetypes and cast, passed through; references checked for the report -----
  const archetypes = copy(arr(fitout.archetypes));
  const minds = copy(arr(fitout.minds));
  const kindOf = new Map(nodes.map(n => [n.id, n.kind]));
  archetypes.forEach((a, i) => {
    if (!isObj(a)) return;
    const name = `archetypes[${i}]${a.id ? ` (${a.id})` : ''}`;
    for (const key of ['entries', 'exits']) {
      for (const ref of arr(a[key])) {
        const kind = kindOf.get(String(ref));
        if (!kind) warn(`${name}.${key}: "${ref}" is not a gate in the fit-out`);
        else if (kind === 'service') warn(`${name}.${key}: "${ref}" is a place, not a gate`);
        else if (key === 'exits' && kind === 'entry') warn(`${name}.exits: "${ref}" has exit: false, so nobody can leave through it`);
      }
    }
  });

  // ----- world -----
  const walk = fin(fitout.walkMetersPerMinute) && Number(fitout.walkMetersPerMinute) > 0 ? Number(fitout.walkMetersPerMinute) : null;
  if (walk === null) warn(`walkMetersPerMinute is missing or not a positive number; using ${DEFAULT_WALK_M_PER_MIN} m per minute`);
  const speed = (walk ?? DEFAULT_WALK_M_PER_MIN) / mpu;
  const travelSpeed = r3(clamp(speed, MIN_TRAVEL, MAX_TRAVEL));
  if (speed < MIN_TRAVEL || speed > MAX_TRAVEL) warn(`walking speed is ${r2(speed)} map units per minute, outside ${MIN_TRAVEL}-${MAX_TRAVEL}; using ${travelSpeed}`);

  const floorValue = planFloor ? (planFloor.label || (fin(planFloor.sequence) ? Number(planFloor.sequence) : planFloor.id ?? null))
    : fin(fitout.floor) ? Number(fitout.floor) : null;
  const derived = { walls: 'data', doors: 'data', 'geo.metersPerUnit': 'data', 'geo.clearance': 'data', 'geo.floor': 'data', ...(objects.length ? { objects: 'data' } : {}) };
  const provenance = { ...(isObj(fitout.provenance) ? copy(fitout.provenance) : {}), ...derived };
  if (!('travelSpeed' in provenance)) provenance.travelSpeed = typeof provenance.walkMetersPerMinute === 'string' ? provenance.walkMetersPerMinute : 'assumed';

  const world = {};
  for (const k of PASS_THROUGH) if (fitout[k] !== undefined) world[k] = copy(fitout[k]);
  Object.assign(world, {
    mode: 'visit',
    travelSpeed,
    nodes,
    archetypes,
    minds,
    walls: walls.map(w => ({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, source: 'matterport-vector' })),
    ...(objects.length ? { objects: objects.map(ob => ({ ...ob, polygon: ob.polygon.map(p => [p.x, p.y]) })) } : {}),
    geo: { metersPerUnit: mpu, clearance, floor: floorValue, source: 'matterport-vector' },
    doors: worldDoors,
    provenance
  });
  // Field order as in the world schema: text, mode and timing first.
  const ordered = {};
  for (const k of ['title', 'question', 'context', 'leaveLabel', 'mode', 'duration', 'clockStart', 'travelSpeed', 'arrivals',
    'nodes', 'archetypes', 'minds', 'walls', 'objects', 'geo', 'doors', 'provenance']) if (world[k] !== undefined) ordered[k] = world[k];

  const check = validateWorld(ordered);
  if (!check.ok) throw fitoutError('the built world does not pass validateWorld', check.errors);

  const report = {
    model: fitout.model ?? modelId,
    floor: planFloor ? { id: planFloor.id ?? null, sequence: planFloor.sequence ?? null, label: planFloor.label ?? '' } : null,
    gates: gates.length,
    places: places.length,
    walls: ordered.walls.length,
    objects: objects.length,
    objectList: objects.map(ob => ({ id: ob.id, name: ob.name, areaM2: ob.areaM2 ?? null, points: ob.polygon.length })),
    doors: worldDoors.length,
    metersPerUnit: mpu,
    travelSpeed,
    walkMetersPerMinute: walk ?? DEFAULT_WALK_M_PER_MIN,
    clearance,
    doorNames: worldDoors.map(d => d.name),
    doorList: doors.map(d => ({ id: d.id, name: d.name, exterior: d.exterior, widthM: r2(d.widthM) })),
    entries: nodes.filter(n => n.kind === 'entry').map(n => n.id),
    assumptions: copy(arr(fitout.assumptions)),
    warnings,
    planWarnings: [...arr(plan.warnings)],
    validation: { ok: check.ok, errors: check.errors, warnings: check.warnings }
  };
  return { world: ordered, report };
}

function fitoutError(headline, problems) {
  const err = new Error(`applyFitout: ${headline}:\n${problems.map(p => `  - ${p}`).join('\n')}`);
  err.problems = problems;
  return err;
}
