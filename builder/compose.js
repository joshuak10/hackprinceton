// Composer (docs/PROTOTYPE.md §14c): a map-unit floor plan (§13e) plus a building profile (§14a) and a
// scenario's demand (§14b) become a visit-mode world with walls and doors. People enter at the real
// exterior doors, walk wall-free paths to tenant spaces, wait where there are lines, and leave.
//
// v0.2 limits: one floor per world; doors count traffic but do not slow it; tenants are matched to rooms
// by area unless overridden; every number not read from CoStar or Matterport is tagged `assumed`.
import { validateProfile, costarToProfile, normalizeFloor, sameFloor, PUBLIC_USES } from './profile.js';
import { profileToDemand, SCENARIOS, mergeAssumptions, assumptionEntry, OTHER_FLOORS_TAG } from './demand.js';
import { createNav, crossesWall } from '../engine/walls.js';
import { validateWorld } from '../engine/spec.js';

export const LIMITS = Object.freeze([
  'One floor per world: other floors are reached through the stairs or elevator rooms and are not simulated.',
  "Doors count traffic but don't yet slow it (no door capacity).",
  'Tenants are matched to rooms by area (largest tenant to largest room) unless overridden.',
  'Every number not read from CoStar or Matterport is tagged "assumed".'
]);

const NODE_GAP = 0.05;          // §13a: every node at least this far from every wall
const NODE_GAP_GOOD = 0.1;      // what the composer aims for, when the room allows it
const MAP_LO = 3, MAP_HI = 97;  // node coordinate range in the world spec
const SQFT_PER_M2 = 10.7639;
const CLEARANCE_CAP_M = 0.3;    // same cap as builder/matterport.js floorplanToWorld
const MAX_NODES = 60;
const MIN_SPEED = 0.2, MAX_SPEED = 600;   // travelSpeed range in map units per minute (§14d)
const MAX_PROVENANCE = 300;

const VERTICAL_RE = /\b(stair(s|way|well|case|wells|cases)?|elevators?|lifts?|escalators?)\b/i;
// Circulation and back-of-house rooms: never matched to a tenant by area (they become common space).
const COMMON_RE = /\b(hall(way)?s?|corridors?|lobby|lobbies|entry|entrance|entryway|foyer|vestibule|rest ?rooms?|bath(room)?s?|toilets?|wc|washrooms?|lavator(y|ies)|closets?|storage|utility|mechanical|electrical|janitor(ial)?|laundry|garage|outdoor|patio|balcony|porch|terrace|loading|shaft|server room|telecom|mail ?room|copy room)\b/i;
const GENERIC_CLASS = /^(|other|void|unknown|room)$/i;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = v => (Array.isArray(v) ? v : []);
const fin = v => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));
const r2 = v => Math.round(v * 100) / 100;
const r4 = v => Math.round(v * 1e4) / 1e4;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmtInt = n => Math.round(n).toLocaleString('en-US');
const cut = (s, n) => String(s).slice(0, n).trim();

// ---------- geometry ----------

const toPt = p => {
  if (Array.isArray(p) && fin(p[0]) && fin(p[1])) return { x: +p[0], y: +p[1] };
  if (isObj(p) && fin(p.x) && fin(p.y)) return { x: +p.x, y: +p.y };
  return null;
};

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

const minDist = (segs, p) => segs.reduce((m, s) => Math.min(m, segDist(p.x, p.y, s.x1, s.y1, s.x2, s.y2)), Infinity);

function signedArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a.x * b.y - b.x * a.y; }
  return s / 2;
}

function centroidOf(pts) {
  const a = signedArea(pts);
  if (Math.abs(a) < 1e-12) return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
  let cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length], f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f; cy += (p.y + q.y) * f;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

function inPolygon(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

const loopSegs = pts => pts.map((p, i) => { const q = pts[(i + 1) % pts.length]; return { x1: p.x, y1: p.y, x2: q.x, y2: q.y }; });
const inRoom = (room, p) => room.polygon.length >= 3 && inPolygon(room.polygon, p.x, p.y) && !room.holes.some(h => inPolygon(h, p.x, p.y));

// ---------- reading the plan ----------

const roomText = r => `${r.label} ${r.classification ?? ''}`;

function readRooms(plan, mpu) {
  return arr(plan.rooms).filter(isObj).map((r, i) => {
    const polygon = arr(r.polygon).map(toPt).filter(Boolean);
    const holes = arr(r.holes).map(h => arr(h).map(toPt).filter(Boolean)).filter(h => h.length >= 3);
    let areaMap = polygon.length >= 3 ? Math.abs(signedArea(polygon)) - holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0) : 0;
    if (!(areaMap > 0) && fin(r.area)) areaMap = Number(r.area);
    const areaM2 = fin(r.areaM2) ? Number(r.areaM2) : mpu ? areaMap * mpu * mpu : null;
    const classification = typeof r.classification === 'string' ? r.classification.trim()
      : arr(r.classifications).map(c => c?.label).find(Boolean) ?? null;
    return {
      id: String(r.id ?? `room${i}`), idx: i, label: typeof r.label === 'string' ? r.label.trim() : '', classification,
      polygon, holes, inside: toPt(r.inside), centroid: toPt(r.centroid) ?? (polygon.length >= 3 ? centroidOf(polygon) : null),
      areaMap, areaSF: areaM2 === null ? null : areaM2 * SQFT_PER_M2
    };
  });
}

function readWalls(plan) {
  return arr(plan.walls).map(w => {
    const s = Array.isArray(w) ? { x1: w[0], y1: w[1], x2: w[2], y2: w[3] } : isObj(w) ? w : null;
    if (!s || ![s.x1, s.y1, s.x2, s.y2].every(fin)) return null;
    return { x1: +s.x1, y1: +s.y1, x2: +s.x2, y2: +s.y2, edgeId: s.edgeId ?? null, edgeIds: arr(s.edgeIds), source: s.source };
  }).filter(Boolean);
}

const mpuOf = plan => (fin(plan.metersPerUnit) && Number(plan.metersPerUnit) > 0 ? Number(plan.metersPerUnit) : null);

// The plan's floor as { id, label, sequence, number }; number is null when it cannot be read.
function planFloor(plan) {
  const f = plan.floor;
  if (isObj(f)) {
    const fromLabel = normalizeFloor(f.label || f.name);
    const number = typeof fromLabel === 'number' ? fromLabel : fin(f.sequence) ? Number(f.sequence) + 1 : null;
    return { id: f.id ?? null, label: f.label || f.name || (number !== null ? `Floor ${number}` : 'this floor'), sequence: f.sequence ?? null, number };
  }
  if (f === undefined || f === null || f === '') return { id: null, label: 'this floor', sequence: null, number: null };
  const n = normalizeFloor(f);
  return { id: null, label: typeof f === 'string' ? f : `Floor ${n}`, sequence: null, number: typeof n === 'number' ? n : null };
}

const verticalKind = r => (/elevator|lift/i.test(roomText(r)) ? 'Elevator' : /escalator/i.test(roomText(r)) ? 'Escalator' : 'Stairs');

// ---------- assignTenantsToRooms ----------

// Overrides first; then stairs and elevator rooms become "vertical"; then tenants on this floor are matched
// to the remaining rooms by area, largest tenant to largest room (corridors, restrooms and other
// back-of-house rooms are never matched); tenants on other floors are reached through the vertical rooms;
// rooms left over are "common".
export function assignTenantsToRooms(plan, profile, { overrides } = {}) {
  const warnings = [];
  const mpu = mpuOf(plan ?? {});
  const rooms = readRooms(plan ?? {}, mpu);
  const floor = planFloor(plan ?? {});
  const tenants = arr(profile?.tenants).filter(t => t && t.name);
  const byRoom = new Map(), taken = new Set();
  const set = (room, a) => byRoom.set(room.id, {
    roomId: room.id, roomLabel: room.label || room.classification || '', tenantName: null, ...a,
    roomSF: room.areaSF === null ? null : Math.round(room.areaSF)
  });
  const findTenant = name => {
    const s = String(name).trim().toLowerCase();
    const exact = tenants.find(t => t.name.toLowerCase() === s);
    if (exact) return exact;
    const partial = tenants.filter(t => t.name.toLowerCase().includes(s));
    return partial.length === 1 ? partial[0] : null;
  };

  const ov = isObj(overrides) ? overrides : {};
  if (overrides !== undefined && overrides !== null && !isObj(overrides)) warnings.push('overrides: not an object; ignored');
  for (const [roomId, v] of Object.entries(isObj(ov.rooms) ? ov.rooms : {})) {
    const room = rooms.find(r => r.id === roomId);
    if (!room) { warnings.push(`overrides.rooms.${roomId}: no such room on this floor; ignored`); continue; }
    if (v === 'common' || v === 'vertical') { set(room, { use: v, how: 'override' }); continue; }
    const t = findTenant(v);
    if (!t) { warnings.push(`overrides.rooms.${roomId}: "${v}" is not a tenant in the profile; ignored`); continue; }
    if (taken.has(t.name)) { warnings.push(`overrides.rooms.${roomId}: "${t.name}" already has a room; ignored`); continue; }
    taken.add(t.name);
    set(room, { tenantName: t.name, use: t.use, how: 'override', tenantSF: t.sf ?? null });
  }
  for (const roomId of arr(ov.verticalRooms)) {
    const room = rooms.find(r => r.id === String(roomId));
    if (!room) { warnings.push(`overrides.verticalRooms: "${roomId}" is not a room on this floor; ignored`); continue; }
    const prev = byRoom.get(room.id);
    if (prev && prev.use !== 'vertical') { warnings.push(`overrides.verticalRooms: "${roomId}" is already set to ${prev.tenantName ?? prev.use}; kept that`); continue; }
    set(room, { use: 'vertical', how: 'override' });
  }

  for (const r of rooms) if (!byRoom.has(r.id) && VERTICAL_RE.test(roomText(r))) set(r, { use: 'vertical', how: 'vertical' });

  // Which tenants are on this floor. Without a floor number for the plan, every tenant is.
  const known = tenants.filter(t => t.floor !== null && t.floor !== undefined);
  if (floor.number === null && known.length) warnings.push('the plan does not say which floor it is; every tenant is matched on this floor');
  const onThis = t => floor.number === null || t.floor === null || t.floor === undefined || sameFloor(t.floor, floor.number);
  const noFloor = tenants.filter(t => (t.floor === null || t.floor === undefined) && !taken.has(t.name));
  if (noFloor.length && floor.number !== null && known.length) {
    warnings.push(`${noFloor.length} tenant(s) have no floor in the profile and were matched on this floor: ${noFloor.map(t => t.name).join(', ')}`);
  }

  const queue = tenants.filter(t => !taken.has(t.name) && onThis(t))
    .sort((a, b) => (b.sf ?? -1) - (a.sf ?? -1) || a.name.localeCompare(b.name));
  const free = rooms.filter(r => !byRoom.has(r.id) && !COMMON_RE.test(roomText(r)) && r.polygon.length >= 3)
    .sort((a, b) => b.areaMap - a.areaMap || a.idx - b.idx);
  const unplaced = [];
  queue.forEach((t, i) => {
    const room = free[i];
    if (!room) { unplaced.push(t.name); return; }
    taken.add(t.name);
    set(room, { tenantName: t.name, use: t.use, how: 'area-match', tenantSF: t.sf ?? null });
  });
  for (const name of unplaced) {
    const t = tenants.find(x => x.name === name);
    warnings.push(`"${name}"${t.sf ? ` (${fmtInt(t.sf)} SF)` : ''} got no room: this floor has more tenants than rooms left to match`);
  }
  for (const r of rooms) if (!byRoom.has(r.id)) set(r, { use: 'common', how: 'common' });

  const assignments = rooms.map(r => byRoom.get(r.id));
  const mismatched = assignments.filter(a => a.how === 'area-match' && a.roomSF && a.tenantSF && Math.max(a.roomSF / a.tenantSF, a.tenantSF / a.roomSF) > 3);
  if (mismatched.length) {
    warnings.push(`${mismatched.length} area match(es) differ from the tenant's CoStar square feet by more than 3x ` +
      `(${mismatched.slice(0, 3).map(a => `${a.tenantName}: ${fmtInt(a.tenantSF)} SF in ${a.roomId}, ${fmtInt(a.roomSF)} SF`).join('; ')}); ` +
      'check them and set overrides.rooms where the match is wrong');
  }

  const vertical = assignments.filter(a => a.use === 'vertical').map(a => a.roomId);
  const offFloor = tenants.filter(t => !taken.has(t.name) && !onThis(t)).map(t => ({ tenantName: t.name, floor: t.floor, via: vertical }));
  if (!vertical.length && (offFloor.length || (profile?.floors ?? 1) > 1)) {
    warnings.push(`${floor.label} has no stairs or elevator room` +
      (offFloor.length ? `, so tenants on other floors cannot be reached: ${offFloor.map(o => o.tenantName).join(', ')}` : '') +
      '; mark one with overrides.verticalRooms if the plan labels it differently');
  }
  return { assignments, warnings, offFloor, unplaced, floor };
}

// ---------- doors ----------

const unit = (dx, dy) => { const l = Math.hypot(dx, dy) || 1; return { x: dx / l, y: dy / l }; };

// A plan door as a gap segment between the wall pieces on either side of its center. Uses the door's own
// jamb-to-jamb ends when the plan gives them; otherwise the ends of the wall pieces that share its edgeId;
// otherwise the nearest wall's direction and the door width. The ends are pulled in slightly so the
// segment lies in the gap without touching either jamb. Returns { x1, y1, x2, y2, width } or null.
function doorSegment(d, walls, clearance) {
  let a, b;
  if ([d.x1, d.y1, d.x2, d.y2].every(fin)) {
    a = { x: +d.x1, y: +d.y1 }; b = { x: +d.x2, y: +d.y2 };
  } else {
    if (!fin(d.x) || !fin(d.y)) return null;
    const c = { x: +d.x, y: +d.y };
    const w = fin(d.width) && Number(d.width) > 0 ? Number(d.width) : null;
    const pieces = d.edgeId !== undefined && d.edgeId !== null
      ? walls.filter(s => s.edgeId === d.edgeId || s.edgeIds.includes(d.edgeId)) : [];
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
    if (crossesWall(walls, s.x1, s.y1, s.x2, s.y2) < 0) return { ...s, width: len };
  }
  return null;
}

// Path clearance: a quarter of the narrowest door, capped for wide openings, within the spec's 0.02-1.
function computeClearance(doors, mpu) {
  const widths = doors.filter(d => d.type !== 'invisible').map(d => (fin(d.widthM) ? Number(d.widthM) : fin(d.width) ? Number(d.width) * (mpu ?? 1) : null)).filter(v => v > 0);
  if (!widths.length) return 0.2;
  const c = Math.min(Math.min(...widths) / 4, CLEARANCE_CAP_M) / (mpu ?? 1);
  return clamp(Math.floor(c * 1e4) / 1e4, 0.02, 1);
}

// Joins two room names into a door name of at most 40 characters: "Corridor / Suite 110". Long names
// lose a trailing "(...)" first, then are cut.
function joinName(a, b, max = 40) {
  if (a.length + b.length + 3 <= max) return `${a} / ${b}`;
  const bare = s => s.replace(/\s*\([^)]*\)\s*$/, '') || s;
  [a, b] = [bare(a), bare(b)];
  if (a.length + b.length + 3 <= max) return `${a} / ${b}`;
  const half = Math.floor((max - 3) / 2);
  if (a.length <= half) return `${a} / ${cut(b, max - 3 - a.length)}`;
  if (b.length <= half) return `${cut(a, max - 3 - b.length)} / ${b}`;
  return `${cut(a, half)} / ${cut(b, max - 3 - half)}`;
}

// ---------- node placement ----------

// Candidate points inside a room, best first: far from every wall and from the room's own outline.
function interiorCandidates(room, walls) {
  if (room.polygon.length < 3) return [];
  const xs = room.polygon.map(p => p.x), ys = room.polygon.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const near = walls.filter(w => Math.max(w.x1, w.x2) >= x0 - 1 && Math.min(w.x1, w.x2) <= x1 + 1 && Math.max(w.y1, w.y2) >= y0 - 1 && Math.min(w.y1, w.y2) <= y1 + 1);
  const outline = [...loopSegs(room.polygon), ...room.holes.flatMap(loopSegs)];
  const c = room.centroid ?? centroidOf(room.polygon);
  const N = 24, out = [];
  const consider = p => {
    if (!p || p.x < MAP_LO || p.x > MAP_HI || p.y < MAP_LO || p.y > MAP_HI || !inRoom(room, p)) return;
    const wall = minDist(near, p);
    out.push({ x: r4(p.x), y: r4(p.y), wall, score: Math.min(wall, minDist(outline, p)), dc: Math.hypot(p.x - c.x, p.y - c.y) });
  };
  consider(room.inside);
  consider(c);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) consider({ x: x0 + ((i + 0.5) * (x1 - x0)) / N, y: y0 + ((j + 0.5) * (y1 - y0)) / N });
  return out.filter(p => p.wall >= NODE_GAP).sort((a, b) => b.score - a.score || a.dc - b.dc);
}

// The best candidate at least `sep` from every point in `avoid` (relaxing the separation if needed).
function pickPoint(cands, avoid = []) {
  if (!cands.length) return null;
  const xs = cands.map(p => p.x), ys = cands.map(p => p.y);
  const span = Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys);
  const good = cands.filter(p => p.wall >= NODE_GAP_GOOD);
  const pool = good.length ? good : cands;
  for (const sep of [Math.min(4, span / 6), 1, 0.3, 0]) {
    const ok = pool.find(p => avoid.every(q => Math.hypot(p.x - q.x, p.y - q.y) >= sep));
    if (ok) return { x: ok.x, y: ok.y };
  }
  return null;
}

// A gate in a doorway: the gap's middle, or a little inside the room when that is too close to a wall.
function doorwayPoint(seg, room, walls) {
  const m = { x: (seg.x1 + seg.x2) / 2, y: (seg.y1 + seg.y2) / 2 };
  const u = unit(seg.x2 - seg.x1, seg.y2 - seg.y1);
  let n = { x: -u.y, y: u.x };
  const probe = s => ({ x: m.x + n.x * s, y: m.y + n.y * s });
  const inside = p => (room ? inRoom(room, p) : Math.hypot(p.x - 50, p.y - 50) < Math.hypot(m.x - 50, m.y - 50));
  if (!inside(probe(0.5)) && inside({ x: m.x - n.x * 0.5, y: m.y - n.y * 0.5 })) n = { x: -n.x, y: -n.y };
  for (const gap of [NODE_GAP_GOOD, NODE_GAP]) {
    for (const s of [0, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3]) {
      const p = probe(s), q = { x: r4(clamp(p.x, MAP_LO, MAP_HI)), y: r4(clamp(p.y, MAP_LO, MAP_HI)) };
      if (minDist(walls, q) >= gap && (s === 0 || inside(q))) return q;
    }
  }
  return null;
}

// ---------- the profile ----------

function readProfile(profile, warnings) {
  const direct = validateProfile(profile);
  if (direct.ok) return direct.profile;
  const mapped = costarToProfile(profile);
  if (!mapped.profile) throw new Error(`composeBuildingWorld: the profile is not usable (${[...direct.errors, ...mapped.warnings].join('; ')})`);
  warnings.push(`the profile was read as a raw CoStar record (mapped ${mapped.mapped.length} fields, ${mapped.unmapped.length} not mapped)`);
  return mapped.profile;
}

// ---------- text ----------

const clock12 = m => {
  const h = Math.floor(m / 60) % 24, mm = m % 60;
  return `${h % 12 === 0 ? 12 : h % 12}${mm ? `:${String(mm).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`;
};

const SCENARIO_TEXT = {
  'weekday-morning': {
    when: 'A weekday morning', leave: 'Leave the building',
    what: 'Office staff are arriving for work, some stopping for coffee first, and early customers are coming in.'
  },
  'weekday-lunch': {
    when: 'A weekday lunch hour', leave: 'Head back to the office or leave the building',
    what: 'Office workers are leaving their suites for food, a shop or an errand inside, and lunch customers are coming in from the street.'
  },
  'saturday-afternoon': {
    when: 'A Saturday afternoon', leave: 'Leave the building',
    what: 'Most offices are closed; diners, shoppers and people with appointments are coming in from the street.'
  }
};

function goalFor(g, sc) {
  if (g.role === 'workers' || g.role === 'workers-elsewhere') {
    return sc.id === 'weekday-morning' ? 'Get to the office and settle in, maybe with a coffee'
      : 'Get lunch or run an errand and be back at their desk on time';
  }
  if (g.use === 'office') return 'Reach the right office reception quickly';
  return sc.id === 'saturday-afternoon' ? 'Get what they came for without wasting the afternoon' : 'Get what they came for and get on with the day';
}

// How the scenario is modeled, for the report (these are choices, not warnings).
function modelNotes(sc, tenantGates) {
  const notes = [];
  if (sc.id === 'weekday-morning') {
    notes.push('Arriving staff stay at their desks for the rest of the window (service time = the window length), ' +
      'so they do not walk back out and are not counted as "served"; count them by place arrivals instead.');
  }
  if (tenantGates) {
    notes.push('Staff start at a gate inside their own suite. Gates are exits for everyone, so a person who finishes ' +
      'near an office may leave through that office\'s gate instead of an exterior door (the engine picks the nearest exit).');
  }
  notes.push('Stairs and elevators stand for the other floors: people bound for another floor line up there and leave the map.');
  return notes;
}

// ---------- composeBuildingWorld ----------

export function composeBuildingWorld({ plan, profile, scenario = 'weekday-lunch', assumptions, overrides, title, question } = {}) {
  if (!isObj(plan)) throw new TypeError('composeBuildingWorld: expected a map-unit plan from toMapUnits (docs/PROTOTYPE.md §13e)');
  if (plan.units && plan.units !== 'map') throw new Error('composeBuildingWorld: the plan is in meters; convert it with toMapUnits first');
  const sc = SCENARIOS[scenario];
  if (!sc) throw new Error(`composeBuildingWorld: unknown scenario "${scenario}"; use one of ${Object.keys(SCENARIOS).join(', ')}`);
  const warnings = [];
  const warn = m => { if (!warnings.includes(m)) warnings.push(m); };
  const prof = readProfile(profile, warnings);
  const merged = mergeAssumptions(assumptions);
  merged.warnings.forEach(warn);
  const A = merged.assumptions;
  const usedHere = new Map();
  const useA = key => { const e = assumptionEntry(key, A); usedHere.set(key, e); return e.value; };

  const mpu = mpuOf(plan);
  if (!mpu) warn('the plan has no metersPerUnit; walking speed and room areas assume 1 m per map unit');
  const rooms = readRooms(plan, mpu);
  const roomById = new Map(rooms.map(r => [r.id, r]));
  const walls = readWalls(plan);
  const wallSource = ['mesh-slice', 'drawn'].includes(plan.source) ? plan.source : 'matterport-vector';
  const worldWalls = walls.map(w => ({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, source: ['matterport-vector', 'mesh-slice', 'drawn'].includes(w.source) ? w.source : wallSource }));
  if (!walls.length) warn('the plan has no walls; people will walk in straight lines');

  const assign = assignTenantsToRooms(plan, prof, { overrides });
  assign.warnings.forEach(warn);
  const floor = assign.floor;
  const asg = new Map(assign.assignments.map(a => [a.roomId, a]));
  const tenantByName = new Map(prof.tenants.map(t => [t.name, t]));
  const roomOfTenant = new Map(assign.assignments.filter(a => a.tenantName).map(a => [a.tenantName, a.roomId]));

  const roomName = id => {
    const a = asg.get(id), r = roomById.get(id);
    if (a?.tenantName) return a.tenantName;
    if (a?.use === 'vertical') return r.label || verticalKind(r);
    return r.label || (r.classification && !GENERIC_CLASS.test(r.classification) ? r.classification : `Room ${id}`);
  };

  // ----- doors: gap segments, named by the rooms they join -----
  const clearance = computeClearance(arr(plan.doors).filter(isObj), mpu);
  const doors = [];
  arr(plan.doors).forEach((d, k) => {
    if (!isObj(d)) return;
    const ids = arr(d.roomIds);
    const sides = [...new Set(ids.filter(x => x !== null && x !== undefined && roomById.has(String(x))).map(String))];
    if (!sides.length) return;
    const exterior = sides.length === 1 && ids.filter(x => x !== null && x !== undefined).length <= 1 && d.outside !== false &&
      (ids.includes(null) || ids.length < 2 || d.outside === true);
    if (sides.length === 1 && !exterior) return;   // a dead end, or both sides in the same room
    const seg = doorSegment(d, walls, clearance);
    if (!seg) { warn(`door ${d.id ?? k + 1}: could not be placed as a gap between walls; it is not counted`); return; }
    const widthM = fin(d.widthM) ? Number(d.widthM) : fin(d.width) ? Number(d.width) * (mpu ?? 1) : seg.width * (mpu ?? 1);
    doors.push({ src: d, k, sides, exterior, seg, widthMap: seg.width, widthM });
  });
  const isCommonRoom = id => ['common', 'vertical'].includes(asg.get(id)?.use);
  const exteriorDoors = doors.filter(d => d.exterior)
    .sort((a, b) => b.widthMap - a.widthMap || Number(isCommonRoom(b.sides[0])) - Number(isCommonRoom(a.sides[0])) || a.k - b.k);
  const usedDoorNames = new Set(), usedDoorIds = new Set();
  const uniqueName = (base, used, max = 40) => { let n = cut(base, max), k = 2; while (used.has(n)) n = `${cut(base, max - 3)} ${k++}`; used.add(n); return n; };
  for (const d of doors) {
    if (d.exterior) {
      d.name = d === exteriorDoors[0] ? 'Main entrance' : `Side entrance (${cut(roomName(d.sides[0]), 23)})`;
    } else {
      const [p, q] = d.sides.slice().sort((x, y) => Number(isCommonRoom(y)) - Number(isCommonRoom(x)) || roomById.get(x).idx - roomById.get(y).idx);
      d.name = joinName(roomName(p), roomName(q));
    }
    d.name = uniqueName(d.name, usedDoorNames);
    const base = String(d.src.id ?? `door_${d.k + 1}`).toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 40) || `door_${d.k + 1}`;
    d.id = uniqueName(base, usedDoorIds);
  }

  // ----- nodes -----
  const nodes = [], nodeIds = new Set();
  const nodeId = base => {
    const b = String(base).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'node';
    let id = b, k = 2;
    while (nodeIds.has(id)) id = `${b.slice(0, 36)}_${k++}`;
    nodeIds.add(id);
    return id;
  };
  const usedNodeNames = new Set();
  const addNode = n => { n.name = uniqueName(n.name, usedNodeNames); nodes.push(n); return n; };

  // Exterior doors become gates (people enter and leave there), in the doorway gap or just inside it.
  const exteriorGates = [];
  for (const d of exteriorDoors) {
    const p = doorwayPoint(d.seg, roomById.get(d.sides[0]), walls);
    if (!p) { warn(`${d.name}: no spot in or just inside the doorway is clear of the walls; not used as an entrance`); continue; }
    exteriorGates.push(addNode({ id: nodeId(`gate_${d.id}`), name: d.name, kind: 'gate', x: p.x, y: p.y, weight: r2(Math.max(0.01, d.widthM)), door: d.id }));
  }
  if (!exteriorGates.length) {
    // No exterior door: the best-connected room's widest door stands in for the entrance.
    const degree = id => doors.filter(d => d.sides.includes(id)).length;
    const best = rooms.filter(r => degree(r.id)).sort((a, b) => degree(b.id) - degree(a.id) || b.areaMap - a.areaMap || a.idx - b.idx)[0];
    if (best) {
      const d = doors.filter(x => x.sides.includes(best.id)).sort((a, b) => b.widthMap - a.widthMap || a.k - b.k)[0];
      const p = doorwayPoint(d.seg, best, walls) ?? pickPoint(interiorCandidates(best, walls));
      if (p) exteriorGates.push(addNode({ id: nodeId('gate_entrance'), name: 'Main entrance (assumed)', kind: 'gate', x: p.x, y: p.y, weight: 1, door: d.id }));
      warn(`the plan has no exterior door; people enter and leave at the door "${d.name}" of the best-connected room "${roomName(best.id)}"`);
    } else {
      const big = rooms.slice().sort((a, b) => b.areaMap - a.areaMap)[0];
      const p = big && pickPoint(interiorCandidates(big, walls));
      if (p) exteriorGates.push(addNode({ id: nodeId('gate_entrance'), name: 'Main entrance (assumed)', kind: 'gate', x: p.x, y: p.y, weight: 1 }));
      warn('the plan has no doors; people enter and leave in the largest room');
    }
  }
  if (!exteriorGates.length) throw new Error('composeBuildingWorld: the plan gives no place for an entrance (no doors and no rooms)');
  if (exteriorDoors.length) useA('entranceWeightBy');

  const nav = createNav(worldWalls, { clearance });
  const reachable = p => exteriorGates.some(g => nav.path(g.x, g.y, p.x, p.y));

  // A point inside each tenant room on this floor and each stairs or elevator room, reachable on foot.
  const spots = new Map();   // roomId → { cands, place }
  const tenantStatus = new Map();
  for (const a of assign.assignments) {
    if (!(a.tenantName || a.use === 'vertical')) continue;
    const room = roomById.get(a.roomId);
    const cands = interiorCandidates(room, walls);
    const place = pickPoint(cands);
    if (!place) { warn(`room ${room.id} (${roomName(room.id)}): no point inside it is clear of the walls; left out`); if (a.tenantName) tenantStatus.set(a.tenantName, 'no clear point in its room'); continue; }
    if (!reachable(place)) {
      warn(`room ${room.id} (${roomName(room.id)}) cannot be reached on foot from any entrance; left out`);
      if (a.tenantName) tenantStatus.set(a.tenantName, 'room cannot be reached on foot');
      continue;
    }
    spots.set(a.roomId, { cands, place });
  }
  const verticalRooms = assign.assignments.filter(a => a.use === 'vertical' && spots.has(a.roomId)).map(a => roomById.get(a.roomId));
  const here = [...roomOfTenant].filter(([name, roomId]) => spots.has(roomId) && tenantByName.get(name).use !== 'vacant').map(([name]) => name);
  const elsewhere = verticalRooms.length ? assign.offFloor.map(o => o.tenantName).filter(n => tenantByName.get(n).use !== 'vacant') : [];

  const demand = profileToDemand(prof, { scenario, assumptions: A, layout: { here, elsewhere } });
  demand.warnings.forEach(warn);

  // Places: a tenant space becomes a service place when it is open and some group can go there.
  const groupNeeds = demand.groups.map(g => g.needs);
  const wanted = tags => groupNeeds.some(needs => needs.some(t => tags.includes(t)));
  const placeOf = new Map();  // tenant name → node
  const provenanceOf = new Map();  // node → { field: tag }
  for (const name of here) {
    const p = demand.places[name];
    if (!p) continue;
    if (!p.open) { tenantStatus.set(name, `closed on a ${sc.label}`); continue; }
    if (!wanted(p.tags)) { tenantStatus.set(name, `no demand on a ${sc.label}`); continue; }
    const spot = spots.get(roomOfTenant.get(name));
    const node = addNode({
      id: nodeId(`place_${name}`), name: cut(name, 40), kind: 'service', x: spot.place.x, y: spot.place.y,
      servers: p.servers, serviceTime: p.serviceTime, ...(p.serviceDist ? { serviceDist: p.serviceDist } : {}),
      appeal: p.appeal, price: p.price, tags: p.tags, about: p.about
    });
    provenanceOf.set(node, Object.fromEntries(['servers', 'serviceTime', 'appeal', 'price', 'about'].map(f => [f, demand.provenance[`places.${name}.${f}`] ?? 'assumed'])));
    placeOf.set(name, node);
    tenantStatus.set(name, 'placed');
  }

  // Stairs and elevators: a gate that stands for the other floors, and (when some group heads upstairs)
  // a place in front of it whose line is the stairs or elevator.
  const awayOpen = elsewhere.filter(n => demand.places[n]?.open);
  const awayTags = [...new Set([OTHER_FLOORS_TAG, ...awayOpen.map(n => demand.places[n].use),
    ...(awayOpen.some(n => PUBLIC_USES.includes(demand.places[n].use)) ? ['public'] : [])])].slice(0, 12);
  const verticalGates = [];
  const verticalPlaces = [];
  for (const room of verticalRooms) {
    const spot = spots.get(room.id), kind = verticalKind(room);
    const gatePt = spot.place;
    verticalGates.push(addNode({ id: nodeId(`gate_${kind}_${room.id}`), name: `${kind} landing`, kind: 'gate', x: gatePt.x, y: gatePt.y, weight: 1 }));
    if (!awayOpen.length || !wanted(awayTags)) continue;
    const pt = pickPoint(spot.cands, [gatePt]);
    if (!pt) { warn(`room ${room.id}: no second clear point for the ${kind.toLowerCase()} line; nobody can head upstairs from here`); continue; }
    const v = kind === 'Elevator' ? 'elevator' : 'stairs';
    const node = addNode({
      id: nodeId(`place_${kind}_${room.id}`), name: `${kind} to other floors`, kind: 'service', x: pt.x, y: pt.y,
      servers: useA(`vertical.${v}.servers`), serviceTime: useA(`vertical.${v}.minutes`), appeal: useA('appeal.place'), price: 0,
      tags: awayTags, about: cut(`To the other floors: ${awayOpen.join(', ')}`, 160)
    });
    provenanceOf.set(node, { servers: 'assumed', serviceTime: 'assumed', appeal: 'assumed', price: 'assumed', about: 'data' });
    verticalPlaces.push(node);
  }
  for (const n of elsewhere) tenantStatus.set(n, verticalPlaces.length || verticalGates.length ? 'other floor, reached by stairs or elevator' : 'other floor');
  if (assign.offFloor.length && !verticalRooms.length) for (const o of assign.offFloor) tenantStatus.set(o.tenantName, 'other floor, cannot be reached');

  // Gates inside the spaces of tenants whose staff start there in this scenario.
  const tenantGate = new Map();
  for (const g of demand.groups.filter(x => x.origin === 'tenant')) {
    for (const name of g.tenantNames.filter(n => here.includes(n))) {
      if (tenantGate.has(name)) { tenantGate.get(name).weight = r2(tenantGate.get(name).weight + (g.tenantCounts[name] ?? 0)); continue; }
      const spot = spots.get(roomOfTenant.get(name));
      const avoid = placeOf.has(name) ? [placeOf.get(name)] : [];
      const pt = pickPoint(spot.cands, avoid) ?? spot.place;
      tenantGate.set(name, addNode({ id: nodeId(`desks_${name}`), name: `${cut(name, 34)} desks`, kind: 'gate', x: pt.x, y: pt.y, weight: r2(Math.max(0.01, g.tenantCounts[name] ?? 1)) }));
    }
  }

  // ----- archetypes, one per demand group -----
  const services = nodes.filter(n => n.kind === 'service');
  const archetypes = [], groupsUsed = [];
  for (const g of demand.groups) {
    const entries = g.origin === 'outside' ? exteriorGates.map(n => n.id)
      : [...new Set(g.tenantNames.flatMap(n => (tenantGate.has(n) ? [tenantGate.get(n).id] : elsewhere.includes(n) ? verticalGates.map(v => v.id) : [])))];
    if (!entries.length) { warn(`group "${g.name}" has nowhere to start on this floor; left out`); continue; }
    if (!services.some(s => s.tags.some(t => g.needs.includes(t)))) { warn(`group "${g.name}" has nowhere to go on this floor (needs ${g.needs.join(', ')}); left out`); continue; }
    archetypes.push({
      id: g.id, name: cut(g.name, 40), description: cut(g.description, 200), share: g.count,
      weights: g.weights, visits: g.visits, patience: g.patience, info: g.info, likes: g.likes, needs: g.needs, entries
    });
    groupsUsed.push({ ...g, entries });
  }
  if (!services.length || !archetypes.length) {
    throw new Error(`composeBuildingWorld: nothing to simulate on ${floor.label} for a ${sc.label}: ` +
      (services.length ? 'no group can reach a place' : 'no open tenant space with demand is reachable') +
      (warnings.length ? ` (${warnings.slice(-3).join('; ')})` : ''));
  }
  if (nodes.length > MAX_NODES) warn(`${nodes.length} nodes is above the world maximum of ${MAX_NODES}; the world will drop the last ones`);

  // Placeholder cast: one generic person per group. Claude replaces it with real people for these tenants.
  const minds = groupsUsed.map(g => ({
    id: cut(`${g.id}_placeholder`, 40), name: cut(g.name, 40), age: null, archetype: g.id,
    bio: cut(`${g.description} Placeholder person: Claude writes the real cast for these tenants.`, 240),
    personality: '', goal: goalFor(g, sc), social: '', informed: g.info >= 0.5
  }));

  // ----- world -----
  const name = prof.name || 'Unnamed building';
  const floorLabel = floor.label || 'this floor';
  const speed = (useA('walkingSpeedMps') * 60) / (mpu ?? 1);
  const travelSpeed = r2(clamp(speed, MIN_SPEED, MAX_SPEED));
  if (speed > MAX_SPEED) warn(`walking at ${A.walkingSpeedMps} m/s is ${fmtInt(speed)} map units per minute, above the world maximum of ${MAX_SPEED}; walking times on this map run ${r2(speed / MAX_SPEED)}x slow`);
  const total = archetypes.reduce((s, a) => s + a.share, 0);
  const win = demand.arrivals;
  if (total < 10) warn(`only ${total} people in this scenario; the world minimum is 10 arrivals`);
  if (total > 5000) warn(`${fmtInt(total)} people in this scenario; the world maximum is 5,000 arrivals (shares keep the mix)`);
  const text = SCENARIO_TEXT[sc.id];
  const size = prof.rbaSF ? `, a ${fmtInt(prof.rbaSF)} SF ${(prof.buildingType || 'office and retail').toLowerCase()} building` : '';
  const place = [prof.city, prof.state].filter(Boolean).join(', ');
  const context = cut(`${text.when}, ${clock12(sc.clockStart)} to ${clock12(sc.clockStart + sc.duration)}, at ${name}${size}${place ? ` in ${place}` : ''} ` +
    `(${floorLabel.toLowerCase()}). ${text.what}`, 300);
  const doorsOut = doors.map(d => ({ id: d.id, name: d.name, x1: d.seg.x1, y1: d.seg.y1, x2: d.seg.x2, y2: d.seg.y2, exterior: d.exterior }));

  const world = {
    title: cut(title || `${name}: ${sc.label}`, 80),
    question: cut(question || `Where does foot traffic concentrate on the ${floorLabel.toLowerCase()} of ${name} on a ${sc.label}, ` +
      'where do people end up waiting, and which change helps most?', 400),
    context,
    leaveLabel: text.leave,
    mode: 'visit',
    duration: sc.duration,
    clockStart: sc.clockStart,
    travelSpeed,
    arrivals: { total: clamp(Math.round(total), 10, 5000), start: win.start, end: win.end, shape: win.shape },
    nodes: nodes.map(({ door, ...n }) => n),
    archetypes,
    minds,
    walls: worldWalls,
    geo: { metersPerUnit: mpu ?? 1, clearance, floor: typeof floor.number === 'number' ? floor.number : floorLabel, source: wallSource },
    doors: doorsOut,
    provenance: {}
  };

  // Provenance: geometry is Matterport data; place descriptions are CoStar data; the rest is assumed.
  const pv = { walls: 'data', doors: 'data', 'geo.metersPerUnit': mpu ? 'data' : 'assumed', 'geo.clearance': 'data', clockStart: 'assumed', duration: 'assumed',
    travelSpeed: 'assumed', 'arrivals.total': 'assumed', 'arrivals.start': 'assumed', 'arrivals.end': 'assumed' };
  world.nodes.forEach((n, i) => {
    if (n.kind === 'gate') pv[`nodes[${i}].weight`] = 'assumed';
    const src = provenanceOf.get(nodes[i]);
    if (src) for (const [f, tag] of Object.entries(src)) pv[`nodes[${i}].${f}`] = tag;
  });
  archetypes.forEach((a, i) => {
    for (const f of ['share', 'visits', 'patience', 'info', 'weights.appeal', 'weights.wait', 'weights.distance', 'weights.price']) pv[`archetypes[${i}].${f}`] = 'assumed';
  });
  world.nodes.forEach((n, i) => { if (Object.keys(pv).length + 2 <= MAX_PROVENANCE) { pv[`nodes[${i}].x`] = 'data'; pv[`nodes[${i}].y`] = 'data'; } });
  world.provenance = pv;

  // ----- report -----
  const assumptionsUsed = [...demand.assumptionsUsed];
  for (const [key, e] of usedHere) if (!assumptionsUsed.some(x => x.key === key)) assumptionsUsed.push(e);
  const nodeOfRoom = new Map();
  for (const [tname, node] of placeOf) nodeOfRoom.set(roomOfTenant.get(tname), node.id);
  const report = {
    floor,
    scenario: { id: sc.id, label: sc.label, clockStart: sc.clockStart, duration: sc.duration },
    rooms: rooms.map(r => {
      const a = asg.get(r.id);
      return { id: r.id, label: r.label, classification: r.classification, areaSF: r.areaSF === null ? null : Math.round(r.areaSF),
        assignedTo: a.tenantName, use: a.use, how: a.how, node: nodeOfRoom.get(r.id) ?? null };
    }),
    tenants: prof.tenants.map(t => ({
      name: t.name, use: t.use, sf: t.sf, floor: t.floor, employees: t.employees,
      roomId: roomOfTenant.get(t.name) ?? null, node: placeOf.get(t.name)?.id ?? null,
      status: t.use === 'vacant' ? 'vacant' : tenantStatus.get(t.name) ?? (assign.unplaced.includes(t.name) ? 'no room on this floor' : 'not simulated')
    })),
    assignments: assign.assignments,
    doors: doors.map(d => ({ id: d.id, name: d.name, exterior: d.exterior, widthM: r2(d.widthM), rooms: d.sides })),
    groups: groupsUsed.map(g => ({ id: g.id, name: g.name, count: g.count, origin: g.origin, entries: g.entries, needs: g.needs, basis: g.basis })),
    nodes: world.nodes.map(n => ({ id: n.id, name: n.name, kind: n.kind })),
    warnings,
    notes: modelNotes(sc, tenantGate.size > 0),
    assumptionsUsed,
    limits: LIMITS
  };
  const check = validateWorld(world);
  report.validation = { ok: check.ok, errors: check.errors, warnings: check.warnings };
  return { world, report };
}
