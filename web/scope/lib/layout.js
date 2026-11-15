// Edit the room: move, add and remove seats on a world spec, and compare runs before and after
// (docs/PROTOTYPE.md §18). Pure functions, no page: the scope display draws and runs what these return.
//
// A place with seats always has one server per seat, so adding a seat adds capacity and removing one takes it away.
// Every rule here matches the engine's own (engine/spec.js checkSeats): a seat the engine would drop or refuse is
// refused here first, with a reason in plain words.

export const SEAT_STEP = 0.1;        // seat coordinates snap to the precision of recorded positions
export const SEAT_GAP_M = 0.55;      // two seats closer than this would be drawn on top of each other
export const WALL_GAP_M = 0.25;      // a seat keeps this far from walls and solid objects
export const SEATS_MAX = 12;         // seats per place in the editor
const DEFAULT_SPACING_M = 1.3;       // between a new seat and its neighbour, when the place has only one seat

const snap = v => Math.round(v / SEAT_STEP) * SEAT_STEP;
const tidy = v => +snap(v).toFixed(1);
const mpuOf = spec => Number(spec.geo?.metersPerUnit) || 1;
const pointOf = p => (Array.isArray(p) ? { x: p[0], y: p[1] } : { x: p.x, y: p.y });

// Every edge nobody can pass: the walls and the outline of each solid object, as [x1, y1, x2, y2].
// A recorded spec already lists object outlines among its walls; the duplicates do no harm.
export function barriers(spec) {
  const out = (spec.walls || []).map(w => (Array.isArray(w) ? w.slice(0, 4) : [w.x1, w.y1, w.x2, w.y2]));
  for (const o of spec.objects || []) {
    const P = (o.polygon || []).map(pointOf);
    for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; out.push([a.x, a.y, b.x, b.y]); }
  }
  return out;
}

const cross = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
function segmentsTouch(a, b) {
  const [x1, y1, x2, y2] = a, [x3, y3, x4, y4] = b;
  const d1 = cross(x3, y3, x4, y4, x1, y1), d2 = cross(x3, y3, x4, y4, x2, y2);
  const d3 = cross(x1, y1, x2, y2, x3, y3), d4 = cross(x1, y1, x2, y2, x4, y4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (px, py, qx, qy, rx, ry) => Math.min(px, qx) - 1e-9 <= rx && rx <= Math.max(px, qx) + 1e-9 && Math.min(py, qy) - 1e-9 <= ry && ry <= Math.max(py, qy) + 1e-9;
  return (Math.abs(d1) < 1e-9 && on(x3, y3, x4, y4, x1, y1)) || (Math.abs(d2) < 1e-9 && on(x3, y3, x4, y4, x2, y2))
    || (Math.abs(d3) < 1e-9 && on(x1, y1, x2, y2, x3, y3)) || (Math.abs(d4) < 1e-9 && on(x1, y1, x2, y2, x4, y4));
}
function distToSegment(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// The places that have seats, in the order of the spec.
export function seatedPlaces(spec) {
  return (spec.nodes || []).filter(n => n.kind === 'service' && Array.isArray(n.seats) && n.seats.length)
    .map(n => ({ id: n.id, name: n.name, x: n.x, y: n.y, servers: n.servers, seats: n.seats.map(pointOf) }));
}

// A copy that can be edited without touching the original: nodes and their seats are new objects.
export function cloneLayout(spec) {
  return { ...spec, nodes: (spec.nodes || []).map(n => (Array.isArray(n.seats) ? { ...n, seats: n.seats.map(pointOf) } : { ...n })) };
}

// Null when a seat may stand at (x, y) for this place, otherwise why not. `ignore` is the index of the seat being
// moved, so it is not compared with itself.
export function seatProblem(spec, placeId, x, y, { ignore = -1 } = {}) {
  const place = (spec.nodes || []).find(n => n.id === placeId);
  if (!place) return 'That place does not exist.';
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) return 'That is off the map.';
  const mpu = mpuOf(spec), edges = barriers(spec);
  if (edges.length) {
    if (edges.some(e => distToSegment(x, y, e) < WALL_GAP_M / mpu)) return 'Too close to a wall or the kitchen.';
    // The engine draws a person moving straight from the place to the seat, and drops a seat with a wall in between.
    if (edges.some(e => segmentsTouch([place.x, place.y, x, y], e))) return `A wall or the kitchen is between this spot and where people wait for ${place.name}.`;
  }
  for (const n of spec.nodes || []) {
    if (!Array.isArray(n.seats)) continue;
    for (let i = 0; i < n.seats.length; i++) {
      if (n.id === placeId && i === ignore) continue;
      const s = pointOf(n.seats[i]);
      if (Math.hypot(s.x - x, s.y - y) < SEAT_GAP_M / mpu) return 'Too close to another seat.';
    }
  }
  return null;
}

const withPlace = (spec, placeId, change) => {
  const next = cloneLayout(spec), place = next.nodes.find(n => n.id === placeId);
  if (!place || place.kind !== 'service') return { spec, problem: 'That place does not exist.' };
  if (!Array.isArray(place.seats)) place.seats = [];
  const problem = change(place, next);
  if (problem) return { spec, problem };
  place.servers = place.seats.length;            // one server per seat, always
  return { spec: next, problem: null };
};

export function moveSeat(spec, placeId, index, x, y) {
  const tx = tidy(x), ty = tidy(y);
  return withPlace(spec, placeId, place => {
    if (!place.seats[index]) return 'That seat does not exist.';
    const problem = seatProblem(spec, placeId, tx, ty, { ignore: index });
    if (problem) return problem;
    place.seats[index] = { x: tx, y: ty };
    return null;
  });
}

export function removeSeat(spec, placeId, index) {
  return withPlace(spec, placeId, place => {
    if (!place.seats[index]) return 'That seat does not exist.';
    if (place.seats.length <= 1) return `${place.name} needs at least one seat.`;
    place.seats.splice(index, 1);
    return null;
  });
}

// Where a new seat goes when the owner has not picked a spot: beside an existing seat, continuing the row or
// the grid, as near the middle of the place's seats as the room allows. Null when there is no room.
export function freeSpot(spec, placeId) {
  const place = (spec.nodes || []).find(n => n.id === placeId);
  if (!place) return null;
  const seats = (place.seats || []).map(pointOf), mpu = mpuOf(spec);
  if (!seats.length) {
    for (const [dx, dy] of [[0, -1], [1, 0], [-1, 0], [0, 1]]) {
      const x = tidy(place.x + dx * DEFAULT_SPACING_M / mpu), y = tidy(place.y + dy * DEFAULT_SPACING_M / mpu);
      if (!seatProblem(spec, placeId, x, y)) return { x, y };
    }
    return null;
  }
  // The spacing the place already uses: the smallest gap between two of its seats along each axis.
  const gaps = axis => seats.flatMap((a, i) => seats.slice(i + 1).map(b => Math.abs(a[axis] - b[axis]))).filter(d => d > 0.3 / mpu);
  const fallback = DEFAULT_SPACING_M / mpu;
  const stepX = gaps('x').length ? Math.min(...gaps('x')) : fallback, stepY = gaps('y').length ? Math.min(...gaps('y')) : fallback;
  const cx = seats.reduce((s, p) => s + p.x, 0) / seats.length, cy = seats.reduce((s, p) => s + p.y, 0) / seats.length;
  const options = [];
  for (const s of seats) for (const [dx, dy] of [[0, stepY], [0, -stepY], [stepX, 0], [-stepX, 0]]) {
    const x = tidy(s.x + dx), y = tidy(s.y + dy);
    if (!seatProblem(spec, placeId, x, y)) options.push({ x, y, d: Math.hypot(x - cx, y - cy) });
  }
  options.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
  return options.length ? { x: options[0].x, y: options[0].y } : null;
}

// Add a seat at (x, y), or at the next free spot when no position is given.
export function addSeat(spec, placeId, x = null, y = null) {
  let index = -1;
  const out = withPlace(spec, placeId, place => {
    if (place.seats.length >= SEATS_MAX) return `${place.name} already has ${SEATS_MAX} seats, the most this editor allows.`;
    const spot = x == null || y == null ? freeSpot(spec, placeId) : { x: tidy(x), y: tidy(y) };
    if (!spot) return `There is no room for another seat at ${place.name}. Move a seat to make space.`;
    const problem = seatProblem(spec, placeId, spot.x, spot.y);
    if (problem) return problem;
    index = place.seats.push(spot) - 1;
    return null;
  });
  return { ...out, index: out.problem ? -1 : index };
}

// The seat nearest a point, within `reach` map units: { placeId, index, x, y } or null. For clicks and drags.
export function seatAt(spec, x, y, reach) {
  let best = null;
  for (const place of seatedPlaces(spec)) {
    place.seats.forEach((s, index) => {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d <= reach && (!best || d < best.d)) best = { placeId: place.id, index, x: s.x, y: s.y, d };
    });
  }
  return best && { placeId: best.placeId, index: best.index, x: best.x, y: best.y };
}

// Two specs have the same room when every seated place has the same seats in the same spots.
export function layoutKey(spec) {
  return JSON.stringify(seatedPlaces(spec).map(p => [p.id, p.seats.map(s => [tidy(s.x), tidy(s.y)])]));
}
export const sameLayout = (a, b) => layoutKey(a) === layoutKey(b);
// The same room with the same offers running: a run with a promotion is not a run of the room as it stands.
export const offerKey = spec => JSON.stringify((spec.offers || []).map(o => [o.text, o.place ?? null, o.priceOff ?? 0]));
export const sameWorld = (a, b) => sameLayout(a, b) && offerKey(a) === offerKey(b);

// What changed against the base, in plain words, one entry per place that changed.
export function describeChanges(base, edited) {
  const before = new Map(seatedPlaces(base).map(p => [p.id, p]));
  const out = [];
  for (const p of seatedPlaces(edited)) {
    const b = before.get(p.id);
    if (!b) { out.push(`${p.name}: ${p.seats.length} seats (new)`); continue; }
    if (b.seats.length !== p.seats.length) { out.push(`${p.name}: ${b.seats.length} to ${p.seats.length} seats`); continue; }
    const key = s => `${tidy(s.x)},${tidy(s.y)}`, had = new Set(b.seats.map(key));
    const moved = p.seats.filter(s => !had.has(key(s))).length;
    if (moved) out.push(`${p.name}: ${moved} ${moved === 1 ? 'seat' : 'seats'} moved`);
  }
  return out;
}

// ---------- before and after ----------

// People who got a seat: at each place, everyone who came to it and neither walked away nor is still waiting.
// The engine's `served` counts only those who had finished by the end, so it leaves out people still eating.
export const seatedAt = n => (n?.arrivals || 0) - (n?.abandoned || 0) - (n?.queueNow || 0);
export const everSeated = metrics => (metrics?.nodes || []).reduce((sum, n) => sum + seatedAt(n), 0);

// One run's outcome in the terms an owner uses: the people who got a seat, and everyone else, who left without eating.
export function outcome(metrics) {
  const people = Number(metrics?.spawned) || 0, seated = Math.min(people, everSeated(metrics) || Number(metrics?.served) || 0);
  return { people, seated, left: people - seated, wait: Number(metrics?.avgWait) || 0 };
}

// Pair runs of the edited room with runs of the base room: same provider, same seed, newest of each.
// runs: [{ meta: { runId, provider, seed, createdAt }, spec, metrics }].
export function pairRuns(baseSpec, editedSpec, runs) {
  const newest = new Map();
  for (const r of runs) {
    // The "before" run has the base room under the same offers as the edited room, so only the seats differ.
    const side = sameWorld(r.spec, editedSpec) ? 'after' : sameLayout(r.spec, baseSpec) && offerKey(r.spec) === offerKey(editedSpec) ? 'before' : null;
    if (!side || !r.metrics) continue;
    const provider = r.meta.provider === 'replay' ? 'jev' : r.meta.provider;
    const k = `${side}|${provider}|${r.meta.seed}`;
    if (!newest.has(k) || String(r.meta.createdAt) > String(newest.get(k).meta.createdAt)) newest.set(k, r);
  }
  const pairs = [];
  for (const [k, after] of newest) {
    const [side, provider, seed] = k.split('|');
    if (side !== 'after') continue;
    const before = newest.get(`before|${provider}|${seed}`);
    if (before) pairs.push({ provider, seed: Number(seed), before, after });
  }
  return pairs.sort((a, b) => a.provider.localeCompare(b.provider) || a.seed - b.seed);
}
