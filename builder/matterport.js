// Matterport vector data → wall segments, doors and a starter Swarmscope world (docs/PROTOTYPE.md §13a, §13e).
//
// What the Matterport data is (Model API GraphQL schema 2024.11.50 and the Property Intelligence
// vector-data guide, developers.matterport.com/api/property-intelligence/vector-data/):
// - A room has one `boundary` (a BoundedRegion: a list of edges) and `holes` (more BoundedRegions:
//   columns, sub-rooms). Rooms link to their floor through `ModelRoom.floor` ("the primary floor").
// - Edge `type` is the EdgeType enum: `wall` (physical) or `invisible` (non-physical). An edge has two
//   vertices, a `thickness` and a `centerLineBias` (where the line sits inside that thickness).
// - Opening `type` is the OpeningType enum: `doorway` or `opening`. Real models have also returned
//   `window` and `divider`, so any other type is kept solid with a warning. `relativeCenter` is the
//   opening's centre as a fraction of the edge, measured from the edge's first listed vertex.
// - The edges of a region come in no particular order, and an edge's vertices may point either way.
// - Vertices are 2D points in the model's x-y space, relative to the model centre. The GraphQL docs
//   give no unit; it is metres (the official sample has a 0.86 m doorway in a 0.96 m closet with
//   0.19 m walls). extractFloorplan cross-checks against `dimensionEstimates(units: metric).area`.
// - The model space is z-up (the opening docs measure `lowerElevation` along z from the ground plane),
//   so seen from above x points right and y points up the page.
//
// Wall segments follow the edge lines; thickness is not drawn. Requires a Property Intelligence
// (Enterprise) subscription and models processed after November 2023.
import { createNav, polylineCrossesWall } from '../engine/walls.js';
import { slug } from '../engine/util.js';

const MATTERPORT_ENDPOINT = 'https://api.matterport.com/api/models/graph';
const PASSABLE = new Set(['doorway', 'opening']);

const PARALLEL_SIN = 0.01;     // edges within ~0.6 degrees of each other can share a wall line
const COINCIDENT_M = 0.01;     // parallel edges this close are drawn as one line
const CLOSE_GAP_M = 0.3;       // narrower gaps between collinear walls are closed (no person fits)
const QUIET_GAP_M = 0.1;       // ... and only gaps wider than this are worth a warning
const MIN_DOOR_M = 0.3;        // narrower openings stay solid
const SNAP_M = 0.05;           // a wall end this close to another wall is moved onto it
const PROBES_M = [0.1, 0.3, 0.6];  // how far either side of a door we look for a room

const WALK_M_PER_MIN = 80;
const MAX_TRAVEL_SPEED = 600;     // the spec's travelSpeed maximum in map units per minute (§14d)
const DOOR_FLOW_PER_M_MIN = 78;    // 1.3 people per metre of door width per second
const CLEARANCE_CAP_M = 0.3;
const NODE_WALL_MIN = 0.05;        // map units (contract §13a)
const MIN_EDGE_MIN = 0.2, MAX_EDGE_MIN = 180;
const LIMITS = { nodes: 60, edges: 150, via: 12, walls: 4000 };
const GENERIC_CLASSES = new Set(['', 'other', 'void', 'unknown']);

// ---------- small helpers ----------

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = v => (Array.isArray(v) ? v : []);
const fin = v => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));
const idStr = v => ((typeof v === 'string' || typeof v === 'number') && String(v).trim() !== '' ? String(v).trim() : '');
const r4 = v => Math.round(v * 1e4) / 1e4;
const r3 = v => Math.round(v * 1e3) / 1e3;
const show = v => { const s = JSON.stringify(v) ?? String(v); return s.length > 40 ? s.slice(0, 37) + '...' : s; };
const fmtM = v => `${+v.toFixed(2)} m`;

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

function closestOnSeg(px, py, s) {
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1, len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - s.x1) * dx + (py - s.y1) * dy) / len2)) : 0;
  return { x: s.x1 + t * dx, y: s.y1 + t * dy };
}

function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; }
  return a / 2;
}

function centroidOf(pts) {
  const a = signedArea(pts);
  if (Math.abs(a) < 1e-12) {
    const n = pts.length || 1;
    return { x: pts.reduce((s, p) => s + p.x, 0) / n, y: pts.reduce((s, p) => s + p.y, 0) / n, a: 0 };
  }
  let cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length], k = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * k; cy += (p.y + q.y) * k;
  }
  return { x: cx / (6 * a), y: cy / (6 * a), a };
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

// ---------- intervals along a wall line ----------

function unionIv(list, join = 1e-9) {
  const s = list.filter(([a, b]) => b - a > 1e-12).map(([a, b]) => [a, b]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const out = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + join) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function subtractIv(A, B) {
  const out = [];
  for (const [a, b] of A) {
    let cur = a;
    for (const [c, d] of B) {
      if (c >= b) break;
      if (d <= cur) continue;
      if (c > cur) out.push([cur, c]);
      cur = Math.max(cur, d);
      if (cur >= b) break;
    }
    if (cur < b) out.push([cur, b]);
  }
  return out;
}

function intersectIv(A, B) {
  const out = [];
  for (const [a, b] of A) for (const [c, d] of B) { const lo = Math.max(a, c), hi = Math.min(b, d); if (hi > lo) out.push([lo, hi]); }
  return unionIv(out);
}

const overlapLen = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

// ---------- the query and the fetch ----------

export const VECTOR_QUERY = `fragment BoundedRegionData on BoundedRegion {
  edges {
    id
    type
    centerLineBias
    thickness
    openings { id type width height lowerElevation relativeCenter }
    vertices { id position { x y } }
  }
}

query swarmscopeVectorData($modelId: ID!) {
  model(id: $modelId) {
    id
    floors { id sequence label }
    rooms {
      id
      label
      classifications { id label }
      floor { id }
      dimensionEstimates(units: metric) { area units }
      boundary { ...BoundedRegionData }
      holes { ...BoundedRegionData }
    }
  }
}`;

const envVar = name => (typeof process !== 'undefined' && process.env ? process.env[name] : undefined);

async function readBody(res) {
  if (typeof res?.text === 'function') {
    const text = await res.text();
    try { return { json: JSON.parse(text), text }; } catch { return { json: null, text }; }
  }
  if (typeof res?.json === 'function') {
    try { return { json: await res.json(), text: '' }; } catch { return { json: null, text: '' }; }
  }
  return { json: null, text: '' };
}

// POSTs VECTOR_QUERY with HTTP Basic auth and returns the GraphQL `data` ({ model }). GraphQL errors that
// came with usable data are passed along as `data.errors` (messages), so extractFloorplan can warn.
// Credentials are never logged, and are scrubbed from every error message.
export async function fetchModelGeometry({
  modelId, tokenId = envVar('MATTERPORT_API_KEY'), tokenSecret = envVar('MATTERPORT_API_TOKEN'),
  endpoint = MATTERPORT_ENDPOINT, fetch: fetchFn = globalThis.fetch, timeoutMs = 30000
} = {}) {
  if (!idStr(modelId)) throw new Error('fetchModelGeometry: modelId is required');
  if (!tokenId || !tokenSecret) {
    throw new Error('fetchModelGeometry: Matterport credentials are missing; set MATTERPORT_API_KEY (token ID) and MATTERPORT_API_TOKEN (token secret)');
  }
  if (typeof fetchFn !== 'function') throw new Error('fetchModelGeometry: no fetch function is available');
  const basic = Buffer.from(`${tokenId}:${tokenSecret}`, 'utf8').toString('base64');
  const secrets = [basic, String(tokenSecret), String(tokenId)].filter(s => s.length >= 4);
  const scrub = s => secrets.reduce((t, x) => t.split(x).join('[redacted]'), String(s ?? ''));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res, body;
  try {
    res = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Basic ${basic}` },
      body: JSON.stringify({ query: VECTOR_QUERY, variables: { modelId: idStr(modelId) } }),
      signal: ctrl.signal
    });
    body = await readBody(res);
  } catch (err) {
    const why = err?.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : scrub(err?.message ?? err);
    throw new Error(`Matterport request failed: ${why}`);
  } finally {
    clearTimeout(timer);
  }

  const status = Number(res?.status) || 0;
  const ok = typeof res?.ok === 'boolean' ? res.ok : status >= 200 && status < 300;
  const messages = arr(body.json?.errors).map(e => scrub(typeof e === 'string' ? e : e?.message ?? JSON.stringify(e)));
  if (!ok) {
    const hint = status === 401 || status === 403 ? ' (check the token ID and secret, and that the token can read this model)' : '';
    const detail = messages.join('; ') || scrub(body.text).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`Matterport API returned HTTP ${status}${hint}${detail ? `: ${detail}` : ''}`);
  }
  if (!isObj(body.json)) throw new Error('Matterport API returned a response that is not JSON');
  const data = body.json.data;
  if (!isObj(data) || !isObj(data.model)) {
    throw new Error(`Matterport GraphQL error for model ${idStr(modelId)}: ${messages.join('; ') || 'the response has no model'}`);
  }
  return messages.length ? { ...data, errors: messages } : data;
}

// ---------- finding a model ----------

export const SEARCH_QUERY = `query swarmscopeSearchModels($q: String!, $n: Int!) {
  models(query: $q, pageSize: $n) { totalResults results { id name } }
}`;

// Searches the models this token can read by the words in their names; "*" lists them all.
// Returns { total, models: [{ id, name }] }: `total` is how many match, `models` the first `limit` of them.
// The same endpoint and HTTP Basic auth as fetchModelGeometry. Credentials are never logged, and are scrubbed
// from every error message.
export async function searchModels({
  query = '*', limit = 25, tokenId = envVar('MATTERPORT_API_KEY'), tokenSecret = envVar('MATTERPORT_API_TOKEN'),
  endpoint = MATTERPORT_ENDPOINT, fetch: fetchFn = globalThis.fetch, timeoutMs = 30000
} = {}) {
  const q = String(query ?? '').trim() || '*';
  const n = Math.max(1, Math.min(100, Math.round(Number(limit)) || 25));
  if (!tokenId || !tokenSecret) {
    throw new Error('searchModels: Matterport credentials are missing; set MATTERPORT_API_KEY (token ID) and MATTERPORT_API_TOKEN (token secret)');
  }
  if (typeof fetchFn !== 'function') throw new Error('searchModels: no fetch function is available');
  const basic = Buffer.from(`${tokenId}:${tokenSecret}`, 'utf8').toString('base64');
  const secrets = [basic, String(tokenSecret), String(tokenId)].filter(s => s.length >= 4);
  const scrub = s => secrets.reduce((t, x) => t.split(x).join('[redacted]'), String(s ?? ''));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res, body;
  try {
    res = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Basic ${basic}` },
      body: JSON.stringify({ query: SEARCH_QUERY, variables: { q, n } }),
      signal: ctrl.signal
    });
    body = await readBody(res);
  } catch (err) {
    const why = err?.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : scrub(err?.message ?? err);
    throw new Error(`Matterport request failed: ${why}`);
  } finally {
    clearTimeout(timer);
  }
  const status = Number(res?.status) || 0;
  const ok = typeof res?.ok === 'boolean' ? res.ok : status >= 200 && status < 300;
  const messages = arr(body.json?.errors).map(e => scrub(typeof e === 'string' ? e : e?.message ?? JSON.stringify(e)));
  if (!ok) {
    const hint = status === 401 || status === 403 ? ' (check the token ID and secret)' : '';
    const detail = messages.join('; ') || scrub(body.text).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`Matterport API returned HTTP ${status}${hint}${detail ? `: ${detail}` : ''}`);
  }
  const found = body.json?.data?.models;
  if (!isObj(found)) throw new Error(`Matterport GraphQL error for the search "${q}": ${messages.join('; ') || 'the response has no models'}`);
  return {
    total: Number.isFinite(Number(found.totalResults)) ? Number(found.totalResults) : arr(found.results).length,
    models: arr(found.results).filter(m => idStr(m?.id)).map(m => ({ id: idStr(m.id), name: typeof m.name === 'string' ? m.name : '' }))
  };
}

// What each floor of a fetched model offers a simulation: rooms, floor area, walls and doors, in meters.
// `usable` means there is something to walk in: at least four walls and one doorway. Many scans have rooms but no
// wall edges, and those cannot be imported.
export function floorSummaries(raw) {
  const model = raw?.model ?? raw ?? {};
  const rooms = arr(model.rooms);
  return arr(model.floors).filter(f => rooms.some(r => r?.floor?.id === f?.id)).map(f => {
    try {
      const plan = extractFloorplan(raw, { floor: f.sequence });
      const xs = plan.walls.flatMap(w => [w.x1, w.x2]), ys = plan.walls.flatMap(w => [w.y1, w.y2]);
      const span = v => (v.length ? Math.round((Math.max(...v) - Math.min(...v)) * 10) / 10 : 0);
      return {
        floor: f.sequence, label: f.label ?? '', rooms: plan.rooms.length,
        areaM2: Math.round(plan.rooms.reduce((s, r) => s + (Number(r.area) || 0), 0)),
        walls: plan.walls.length, doors: plan.doors.length, exteriorDoors: plan.doors.filter(d => arr(d.roomIds).includes(null)).length,
        widthM: span(xs), depthM: span(ys), warnings: plan.warnings.length,
        usable: plan.walls.length >= 4 && plan.doors.length >= 1
      };
    } catch (err) {
      return { floor: f.sequence, label: f.label ?? '', rooms: 0, areaM2: 0, walls: 0, doors: 0, exteriorDoors: 0, widthM: 0, depthM: 0, warnings: 0, usable: false, error: String(err?.message ?? err).slice(0, 200) };
    }
  });
}

// ---------- reading raw edges ----------

function readPoint(v) {
  const p = isObj(v?.position) ? v.position : v;
  return isObj(p) && fin(p.x) && fin(p.y) ? { x: Number(p.x), y: Number(p.y) } : null;
}

const posKey = p => `p:${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;

// known: vertex id → position, from every edge of the model, for edges that list a vertex without one.
function readEdge(e, roomId, warn, known) {
  if (!isObj(e)) { warn(`room ${roomId}: an edge is not an object; skipped`); return null; }
  const id = idStr(e.id);
  const name = id || '(no id)';
  const vs = arr(e.vertices);
  const a = readPoint(vs[0]) ?? known.get(idStr(vs[0]?.id)) ?? null, b = readPoint(vs[1]) ?? known.get(idStr(vs[1]?.id)) ?? null;
  if (!a || !b) { warn(`edge ${name} in room ${roomId}: needs two vertices with x and y; skipped`); return null; }
  if (vs.length > 2) warn(`edge ${name} in room ${roomId}: has ${vs.length} vertices; using the first two`);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) { warn(`edge ${name} in room ${roomId}: zero length; skipped`); return null; }
  let type = typeof e.type === 'string' ? e.type.toLowerCase().trim() : '';
  if (type !== 'wall' && type !== 'invisible') {
    warn(`edge ${name} in room ${roomId}: ${type ? `unknown type ${show(e.type)}` : 'no type'}; treated as a wall`);
    type = 'wall';
  }
  const openings = [];
  arr(e.openings).forEach((o, k) => {
    if (!isObj(o)) { warn(`edge ${name}: opening ${k} is not an object; ignored`); return; }
    const otype = typeof o.type === 'string' && o.type.trim() ? o.type.toLowerCase().trim() : 'unknown';
    if (!fin(o.width) || Number(o.width) <= 0) { warn(`edge ${name}: ${otype} opening ${idStr(o.id) || k} has no usable width; ignored`); return; }
    let rc = 0.5;
    if (fin(o.relativeCenter)) {
      rc = Number(o.relativeCenter);
      if (rc < 0 || rc > 1) { warn(`edge ${name}: opening ${idStr(o.id) || k} relativeCenter ${rc} is outside 0-1; clamped`); rc = Math.max(0, Math.min(1, rc)); }
    } else warn(`edge ${name}: opening ${idStr(o.id) || k} has no relativeCenter; assuming the middle of the edge`);
    openings.push({ id: idStr(o.id), type: otype, width: Number(o.width), center: { x: a.x + rc * (b.x - a.x), y: a.y + rc * (b.y - a.y) } });
  });
  return {
    id, type, a, b, len,
    ka: idStr(vs[0]?.id) || posKey(a), kb: idStr(vs[1]?.id) || posKey(b),
    thickness: fin(e.thickness) ? Math.max(0, Number(e.thickness)) : 0,
    openings, rooms: new Set([roomId])
  };
}

// Chains unordered edges into closed loops. Returns { loops: [[{x,y}]], open }.
function chainLoops(recs, keyOf) {
  const adj = new Map();
  recs.forEach((s, i) => { for (const k of [keyOf(s, 'a'), keyOf(s, 'b')]) { if (!adj.has(k)) adj.set(k, []); adj.get(k).push(i); } });
  const used = new Array(recs.length).fill(false), loops = [];
  let open = false;
  for (let i0 = 0; i0 < recs.length; i0++) {
    if (used[i0]) continue;
    used[i0] = true;
    const start = keyOf(recs[i0], 'a'), pts = [recs[i0].a];
    let curK = keyOf(recs[i0], 'b'), curP = recs[i0].b;
    while (curK !== start) {
      const next = adj.get(curK).find(j => !used[j]);
      if (next === undefined) { open = true; pts.push(curP); break; }
      used[next] = true;
      pts.push(curP);
      const s = recs[next];
      if (keyOf(s, 'a') === curK) { curK = keyOf(s, 'b'); curP = s.b; } else { curK = keyOf(s, 'a'); curP = s.a; }
    }
    if (pts.length >= 3) loops.push(pts);
  }
  return { loops, open };
}

function regionLoops(recs, what, warn) {
  if (!recs.length) return [];
  let res = chainLoops(recs, (s, end) => (end === 'a' ? s.ka : s.kb));
  if (res.open) {
    const byPos = chainLoops(recs, (s, end) => posKey(s[end]));
    if (!byPos.open) res = byPos;
    else warn(`${what}: its edges do not form a closed outline; using them as best we can`);
  }
  return res.loops
    .map(l => (signedArea(l) < 0 ? l.slice().reverse() : l))
    .sort((p, q) => Math.abs(signedArea(q)) - Math.abs(signedArea(p)));
}

// ---------- floor selection ----------

function matchFloor(floors, want) {
  const w = String(want).trim();
  return floors.find(f => f.id === w)
    ?? (fin(w) ? floors.find(f => f.sequence === Number(w)) : undefined)
    ?? floors.find(f => f.label && f.label.toLowerCase() === w.toLowerCase())
    ?? null;
}

const floorText = f => `${f.label ? `"${f.label}" ` : ''}(sequence ${f.sequence ?? '?'}, id ${f.id})`;

function unwrap(raw) {
  const errors = [];
  const collect = x => { for (const e of arr(x?.errors)) errors.push(typeof e === 'string' ? e : String(e?.message ?? JSON.stringify(e))); };
  if (!isObj(raw)) return { model: null, errors };
  collect(raw);
  if (isObj(raw.data)) {
    collect(raw.data);
    if (isObj(raw.data.model)) return { model: raw.data.model, errors };
  }
  if (isObj(raw.model)) return { model: raw.model, errors };
  if (Array.isArray(raw.rooms) || Array.isArray(raw.floors)) return { model: raw, errors };
  return { model: null, errors };
}

// ---------- extractFloorplan ----------

// raw: the GraphQL response, its `data`, or the model object. floor: id, sequence or label; the default
// is the floor with the most rooms. Never throws on missing or partial data (it warns instead); throws
// only when `floor` names a floor the model does not have.
export function extractFloorplan(raw, { floor } = {}) {
  const warnings = [];
  const warn = m => { if (!warnings.includes(m)) warnings.push(m); };
  const { model, errors } = unwrap(raw);
  for (const e of errors) warn(`Matterport API: ${e}`);
  const modelId = idStr(model?.id) || null;
  const floors = [], floorById = new Map();
  const addFloor = (f, i) => {
    const id = idStr(f?.id) || `floor${i}`;
    if (floorById.has(id)) return floorById.get(id);
    const out = { id, sequence: fin(f?.sequence) ? Number(f.sequence) : null, label: typeof f?.label === 'string' ? f.label.trim() : '' };
    floors.push(out); floorById.set(id, out);
    return out;
  };
  const plan = (chosen, rest = {}) => ({
    units: 'm', modelId,
    floor: chosen ? { id: chosen.id, sequence: chosen.sequence, label: chosen.label } : null,
    floors: floors.map(f => ({ ...f, rooms: counts.get(f.id) || 0 })),
    rooms: [], walls: [], doors: [], bounds: null, ...rest, warnings
  });
  const counts = new Map();
  if (!model) { warn('no model data found (expected { data: { model } }, { model } or the model object)'); return plan(null); }

  arr(model.floors).forEach((f, i) => { if (isObj(f)) addFloor(f, i); else warn(`floors[${i}]: not an object; ignored`); });
  if (!Array.isArray(model.floors)) warn('the model lists no floors');

  // Rooms come from model.rooms, or from floors[].rooms when the query nested them there.
  const entries = [], seenRooms = new Set();
  const addRoom = (r, i, parentFloor) => {
    if (!isObj(r)) { warn(`rooms[${i}]: not an object; ignored`); return; }
    const id = idStr(r.id) || `room${entries.length}`;
    if (seenRooms.has(id)) return;
    seenRooms.add(id);
    const floorId = idStr(r.floor?.id) || idStr(r.floorId) || parentFloor || '';
    if (floorId) addFloor({ id: floorId }, floors.length);
    entries.push({ r, id, floorId });
  };
  arr(model.rooms).forEach((r, i) => addRoom(r, i, ''));
  arr(model.floors).forEach((f, fi) => arr(f?.rooms).forEach((r, i) => addRoom(r, i, idStr(f?.id) || `floor${fi}`)));
  if (!entries.length) warn('the model has no rooms (Property Intelligence data needs an Enterprise subscription and a model processed after November 2023)');
  for (const e of entries) if (e.floorId) counts.set(e.floorId, (counts.get(e.floorId) || 0) + 1);

  let chosen = null;
  if (floor !== undefined && floor !== null && floor !== '') {
    chosen = matchFloor(floors, floor);
    if (!chosen) {
      if (floors.length) throw new Error(`extractFloorplan: floor ${show(floor)} not found; the model has ${floors.map(floorText).join(', ')}`);
      warn(`floor ${show(floor)} was requested but the model lists no floors; using every room`);
    }
  } else if (floors.length) {
    chosen = floors.slice().sort((p, q) => (counts.get(q.id) || 0) - (counts.get(p.id) || 0)
      || (p.sequence ?? Infinity) - (q.sequence ?? Infinity) || floors.indexOf(p) - floors.indexOf(q))[0];
  }

  let selected;
  const linked = entries.filter(e => e.floorId);
  if (!linked.length) {
    if (floors.length > 1 && entries.length) warn('rooms carry no floor link; every room is treated as one floor');
    selected = entries;
  } else if (!chosen) {
    selected = entries;
  } else {
    selected = entries.filter(e => e.floorId === chosen.id);
    const loose = entries.filter(e => !e.floorId);
    if (loose.length) {
      if (floors.length === 1) selected = selected.concat(loose);
      else warn(`${loose.length} room(s) have no floor link and were left out: ${loose.slice(0, 5).map(e => e.id).join(', ')}`);
    }
  }
  if (!selected.length) {
    if (entries.length) warn(`floor ${chosen ? floorText(chosen) : ''} has no rooms`);
    return plan(chosen);
  }

  // ----- rooms: outlines, holes, area -----
  const known = new Map();
  for (const { r } of entries) {
    for (const region of [r.boundary, ...arr(r.holes)]) {
      for (const e of arr(region?.edges)) for (const v of arr(e?.vertices)) { const p = readPoint(v); if (p && idStr(v?.id) && !known.has(idStr(v.id))) known.set(idStr(v.id), p); }
    }
  }
  const rooms = [], records = [];
  for (const { r, id } of selected) {
    const what = `room ${id}`;
    const boundaryRaw = arr(r.boundary?.edges);
    if (!boundaryRaw.length) warn(`${what}: no boundary edges`);
    const outer = boundaryRaw.map(e => readEdge(e, id, warn, known)).filter(Boolean);
    const holeRecs = arr(r.holes).map(h => arr(h?.edges).map(e => readEdge(e, id, warn, known)).filter(Boolean));
    records.push(...outer, ...holeRecs.flat());
    const loops = regionLoops(outer, what, warn);
    if (!loops.length) { warn(`${what}: no usable outline; its walls are kept but it gets no node`); continue; }
    if (loops.length > 1) warn(`${what}: its outline has ${loops.length} separate loops; using the largest as its polygon`);
    const holes = holeRecs.map((h, k) => regionLoops(h, `${what} hole ${k}`, warn)[0]).filter(Boolean);
    const outerArea = loops.reduce((s, l) => s + Math.abs(signedArea(l)), 0);
    const holeArea = holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0);
    const parts = [...loops.map(l => ({ c: centroidOf(l), w: Math.abs(signedArea(l)) })), ...holes.map(h => ({ c: centroidOf(h), w: -Math.abs(signedArea(h)) }))];
    const wsum = parts.reduce((s, p) => s + p.w, 0);
    const centroid = Math.abs(wsum) > 1e-12
      ? { x: parts.reduce((s, p) => s + p.c.x * p.w, 0) / wsum, y: parts.reduce((s, p) => s + p.c.y * p.w, 0) / wsum }
      : centroidOf(loops[0]);
    const cls = arr(r.classifications).map(c => (typeof c?.label === 'string' ? c.label.trim() : '')).find(Boolean) || null;
    const est = r.dimensionEstimates?.area;
    const areaEstimate = fin(est) ? Number(est) : Array.isArray(est) ? (est.find(fin) ?? null) : null;
    rooms.push({
      id, key: `${modelId ?? 'model'}:${id}`, label: typeof r.label === 'string' ? r.label.trim() : '', classification: cls,
      polygon: loops[0], holes, centroid: { x: centroid.x, y: centroid.y }, inside: null,
      area: Math.max(0, outerArea - holeArea), areaEstimate: areaEstimate === null ? null : Number(areaEstimate),
      loops
    });
  }
  const roomIndex = new Map(rooms.map((r, i) => [r.id, i]));
  const inRoom = (room, x, y) => room.loops.some(l => inPolygon(l, x, y)) && !room.holes.some(h => inPolygon(h, x, y));
  const roomAt = (x, y) => rooms.findIndex(room => inRoom(room, x, y));
  const inAnyHole = (x, y) => rooms.some(room => room.holes.some(h => inPolygon(h, x, y)));

  // ----- dedupe edges by id -----
  const roomList = set => [...set].join(', ');
  const edges = [], byKey = new Map();
  for (const rec of records) {
    let key = rec.id || `geom:${[posKey(rec.a), posKey(rec.b)].sort().join('|')}`;
    let prev = byKey.get(key);
    const same = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) < 0.01;
    if (prev && !((same(prev.a, rec.a) && same(prev.b, rec.b)) || (same(prev.a, rec.b) && same(prev.b, rec.a)))) {
      warn(`edge ${key}: listed by rooms ${roomList(prev.rooms)} and ${roomList(rec.rooms)} with different positions; kept both`);
      key = `${key}#${posKey(rec.a)}|${posKey(rec.b)}`;
      prev = byKey.get(key);
    }
    if (!prev) { byKey.set(key, rec); edges.push(rec); continue; }
    for (const rm of rec.rooms) prev.rooms.add(rm);
    if (prev.type !== rec.type) {
      warn(`edge ${key}: rooms ${[...prev.rooms].join(', ')} disagree on whether it is a wall; kept the wall`);
      prev.type = 'wall';
    }
    for (const o of rec.openings) {
      const dup = prev.openings.some(p => (p.id && p.id === o.id) || (p.type === o.type && Math.abs(p.width - o.width) < 1e-3 && Math.hypot(p.center.x - o.center.x, p.center.y - o.center.y) < 1e-3));
      if (!dup) prev.openings.push(o);
    }
  }
  edges.forEach((e, i) => {
    e.idx = i; e.ux = (e.b.x - e.a.x) / e.len; e.uy = (e.b.y - e.a.y) / e.len;
    e.name = e.id || `(unnamed edge ${i})`;
  });

  // ----- group collinear, overlapping or touching edges into wall lines (union-find) -----
  const parent = edges.map((_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const sameLine = (p, q) => {
    if (Math.abs(p.ux * q.uy - p.uy * q.ux) > PARALLEL_SIN) return false;
    const tol = Math.min(0.3, Math.max(0.05, Math.max(p.thickness, q.thickness) + 0.01));
    const perp = pt => Math.abs((pt.x - p.a.x) * -p.uy + (pt.y - p.a.y) * p.ux);
    if (perp(q.a) > tol || perp(q.b) > tol) return false;
    const s1 = (q.a.x - p.a.x) * p.ux + (q.a.y - p.a.y) * p.uy, s2 = (q.b.x - p.a.x) * p.ux + (q.b.y - p.a.y) * p.uy;
    return Math.max(s1, s2) >= -CLOSE_GAP_M && Math.min(s1, s2) <= p.len + CLOSE_GAP_M;
  };
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      if (find(i) !== find(j) && sameLine(edges[i], edges[j])) parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  for (const e of edges) { const g = find(e.idx); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(e); }

  const segments = [], doors = [];
  for (const members of groups.values()) {
    const ref = members.reduce((best, e) => (e.len > best.len ? e : best), members[0]);
    const O = ref.a, ux = ref.ux, uy = ref.uy, nx = -uy, ny = ux;
    const proj = p => (p.x - O.x) * ux + (p.y - O.y) * uy;
    const off = p => (p.x - O.x) * nx + (p.y - O.y) * ny;
    for (const m of members) {
      m.sa = proj(m.a); m.sb = proj(m.b);
      m.s0 = Math.min(m.sa, m.sb); m.s1 = Math.max(m.sa, m.sb);
      m.off = (off(m.a) + off(m.b)) / 2;
    }
    // The point on member m's own line whose position along the group axis is s.
    const along = (m, s) => { const t = (s - m.sa) / (m.sb - m.sa); return { x: m.a.x + t * (m.b.x - m.a.x), y: m.a.y + t * (m.b.y - m.a.y) }; };
    const walls = members.filter(m => m.type === 'wall'), invis = members.filter(m => m.type === 'invisible');
    const wallU = unionIv(walls.map(m => [m.s0, m.s1]));
    const invisU = unionIv(invis.map(m => [m.s0, m.s1]));

    // Openings recorded by any member cut the whole (merged) wall: it is the same physical wall.
    const gaps = [];
    for (const m of walls) {
      for (const o of m.openings) {
        if (!PASSABLE.has(o.type)) {
          warn(`edge ${m.name} (room ${roomList(m.rooms)}): opening type "${o.type}" is not a doorway or opening; the wall stays solid there`);
          continue;
        }
        const c = proj(o.center), lo = Math.max(m.s0, c - o.width / 2), hi = Math.min(m.s1, c + o.width / 2);
        if (hi - lo > 1e-9) gaps.push({ lo, hi, o, m });
      }
    }
    const doorIv = [];
    for (const iv of unionIv(gaps.map(g => [g.lo, g.hi]))) {
      if (iv[1] - iv[0] < MIN_DOOR_M) {
        const g = gaps.find(x => x.hi > iv[0] && x.lo < iv[1]);
        warn(`edge ${g.m.name}: ${g.o.type}${g.o.id ? ` ${g.o.id}` : ''} is only ${fmtM(iv[1] - iv[0])} wide on the wall; kept solid`);
        continue;
      }
      doorIv.push(iv);
    }

    // Wall/invisible disagreements: keep the wall.
    if (intersectIv(wallU, invisU).some(([a, b]) => b - a > 0.05)) {
      for (const w of walls) for (const v of invis) {
        if (overlapLen(w.s0, w.s1, v.s0, v.s1) > 0.05) {
          warn(`edge ${w.name} (room ${roomList(w.rooms)}) is a wall where edge ${v.name} (room ${roomList(v.rooms)}) is invisible; kept the wall`);
        }
      }
    }

    // Solid pieces, drawn per cluster of coincident members so offset faces keep their own corners.
    const clusters = [];
    for (const m of walls.slice().sort((p, q) => p.off - q.off || p.idx - q.idx)) {
      const last = clusters[clusters.length - 1];
      if (last && m.off - last.at(-1).off <= COINCIDENT_M) last.push(m); else clusters.push([m]);
    }
    for (const cl of clusters) {
      const line = cl.reduce((best, e) => (e.len > best.len ? e : best), cl[0]);
      const raw = unionIv(cl.map(m => [m.s0, m.s1]));
      const cover = [];
      for (const iv of raw) {
        const last = cover[cover.length - 1];
        if (last && iv[0] - last[1] < CLOSE_GAP_M) {
          if (iv[0] - last[1] > QUIET_GAP_M) warn(`edge ${line.name}: closed a ${fmtM(iv[0] - last[1])} gap between collinear walls (too narrow to walk through)`);
          last[1] = Math.max(last[1], iv[1]);
        } else cover.push(iv.slice());
      }
      for (const [lo, hi] of subtractIv(cover, doorIv)) {
        if (hi - lo < 1e-3) continue;
        const near = cl.filter(m => overlapLen(m.s0, m.s1, lo, hi) > 1e-6);
        const main = near.reduce((best, e) => (overlapLen(e.s0, e.s1, lo, hi) > overlapLen(best.s0, best.s1, lo, hi) ? e : best), near[0] ?? line);
        const p = along(line, lo), q = along(line, hi);
        segments.push({
          x1: p.x, y1: p.y, x2: q.x, y2: q.y, edgeId: main.id || null,
          edgeIds: [...new Set(near.map(m => m.id).filter(Boolean))],
          roomIds: [...new Set(near.flatMap(m => [...m.rooms]))]
        });
      }
    }

    // Doors: one per merged passable gap, plus one per open (invisible, wall-free) stretch.
    const addDoor = (lo, hi, type, line, edgeId, openingIds, memberRooms) => {
      const c = along(line, (lo + hi) / 2);
      const found = [1, -1].map(sg => {
        for (const d of PROBES_M) { const k = roomAt(c.x + sg * d * nx, c.y + sg * d * ny); if (k >= 0) return k; }
        return null;
      });
      let roomIds, outside = false;
      if (found[0] !== null && found[0] === found[1]) {
        roomIds = [rooms[found[0]].id, rooms[found[0]].id];
        warn(`door on edge ${edgeId}: both sides are in room ${rooms[found[0]].id}; it connects nothing`);
      } else {
        const idx = found.filter(k => k !== null);
        for (const rid of memberRooms) {
          const k = roomIndex.get(rid);
          if (idx.length < 2 && k !== undefined && !idx.includes(k)) idx.push(k);
        }
        idx.sort((p, q) => p - q);
        roomIds = [idx.length ? rooms[idx[0]].id : null, idx.length > 1 ? rooms[idx[1]].id : null];
        if (idx.length === 1) {
          const nullSide = found[0] === null && found[1] !== null ? 1 : found[1] === null && found[0] !== null ? -1 : 0;
          outside = !(nullSide && inAnyHole(c.x + nullSide * PROBES_M[1] * nx, c.y + nullSide * PROBES_M[1] * ny));
          if (!outside) warn(`door on edge ${edgeId}: leads into a hole of a room that is not itself a room; treated as a dead end`);
        } else if (!idx.length) {
          warn(`door on edge ${edgeId}: no room found on either side; ignored by the world builder`);
        }
      }
      const p = along(line, lo), q = along(line, hi);   // the gap itself, jamb to jamb
      doors.push({ id: `door${doors.length + 1}`, x: c.x, y: c.y, x1: p.x, y1: p.y, x2: q.x, y2: q.y, width: hi - lo, type, edgeId, openingIds, roomIds, outside });
    };
    for (const [lo, hi] of doorIv) {
      const parts = gaps.filter(g => g.hi > lo && g.lo < hi);
      const first = parts.reduce((best, g) => (overlapLen(g.lo, g.hi, lo, hi) > overlapLen(best.lo, best.hi, lo, hi) ? g : best), parts[0]);
      const line = clusters.find(cl => cl.includes(first.m)).reduce((best, e) => (e.len > best.len ? e : best));
      addDoor(lo, hi, parts.some(g => g.o.type === 'doorway') ? 'doorway' : 'opening', line, first.m.name,
        [...new Set(parts.map(g => g.o.id).filter(Boolean))], new Set(parts.flatMap(g => [...g.m.rooms])));
    }
    for (const [lo, hi] of subtractIv(invisU, wallU)) {
      if (hi - lo < MIN_DOOR_M) continue;
      const over = invis.filter(m => overlapLen(m.s0, m.s1, lo, hi) > 1e-6);
      const line = over.reduce((best, e) => (overlapLen(e.s0, e.s1, lo, hi) > overlapLen(best.s0, best.s1, lo, hi) ? e : best), over[0]);
      addDoor(lo, hi, 'invisible', line, line.name, [], new Set(over.flatMap(m => [...m.rooms])));
    }
  }

  // ----- heal junctions: move a wall end that stops just short of another wall onto it -----
  for (let i = 0; i < segments.length; i++) {
    for (const end of [1, 2]) {
      const s = segments[i], px = s[`x${end}`], py = s[`y${end}`];
      let best = null, bestD = SNAP_M, joined = false;
      for (let j = 0; j < segments.length && !joined; j++) {
        if (j === i) continue;
        const t = segments[j], d = segDist(px, py, t.x1, t.y1, t.x2, t.y2);
        if (d <= 1e-9) joined = true;          // already meets a wall: moving it could open a gap there
        else if (d < bestD) { bestD = d; best = t; }
      }
      if (best && !joined) { const c = closestOnSeg(px, py, best); s[`x${end}`] = c.x; s[`y${end}`] = c.y; }
    }
  }
  const walls = segments.filter(s => Math.hypot(s.x2 - s.x1, s.y2 - s.y1) >= 1e-3);
  if (!walls.length) warn('no wall segments on this floor');

  // ----- a point inside each room, as far from its outline and every wall as possible -----
  for (const room of rooms) {
    const xs = room.polygon.map(p => p.x), ys = room.polygon.map(p => p.y);
    const box = { minX: Math.min(...xs) - 0.5, maxX: Math.max(...xs) + 0.5, minY: Math.min(...ys) - 0.5, maxY: Math.max(...ys) + 0.5 };
    const obstacles = [...room.loops.flatMap(loopSegs), ...room.holes.flatMap(loopSegs),
      ...walls.filter(w => Math.max(w.x1, w.x2) >= box.minX && Math.min(w.x1, w.x2) <= box.maxX && Math.max(w.y1, w.y2) >= box.minY && Math.min(w.y1, w.y2) <= box.maxY)];
    const best = interiorPoint(room, obstacles, inRoom);
    if (best) room.inside = best;
    else warn(`room ${room.id}: could not find a point inside it`);
  }

  // ----- unit sanity check against Matterport's own area estimates -----
  const est = rooms.filter(r => r.areaEstimate > 0 && r.area > 0);
  if (est.length) {
    const ratio = est.reduce((s, r) => s + r.areaEstimate, 0) / est.reduce((s, r) => s + r.area, 0);
    if (ratio < 0.6 || ratio > 1.6) {
      warn(`room outlines add up to ${ratio.toFixed(2)}x Matterport's metric area estimates; check the coordinate units (metres are assumed)`);
    }
  }

  const pts = [...walls.flatMap(w => [{ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }]), ...rooms.flatMap(r => r.polygon), ...doors];
  const bounds = pts.length ? {
    minX: Math.min(...pts.map(p => p.x)), minY: Math.min(...pts.map(p => p.y)),
    maxX: Math.max(...pts.map(p => p.x)), maxY: Math.max(...pts.map(p => p.y))
  } : null;
  return plan(chosen, {
    rooms: rooms.map(({ loops, ...r }) => r),
    walls, doors, bounds
  });
}

// Pole of inaccessibility by grid search with refinement: deterministic, and inside the room even when
// the centroid is not (L shapes, rooms with columns). Near-ties go to the point nearest the centroid,
// so a long corridor gets its node in the middle rather than at one end.
function interiorPoint(room, obstacles, inRoom) {
  const xs = room.polygon.map(p => p.x), ys = room.polygon.map(p => p.y);
  let x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0, h = Math.max(...ys) - y0;
  const N = 20, tie = 1e-6 * Math.max(w, h, 1);
  const c = room.centroid;
  let best = null, bestD = -Infinity, bestC = Infinity;
  for (let it = 0; it < 7; it++) {
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const x = x0 + ((i + 0.5) * w) / N, y = y0 + ((j + 0.5) * h) / N;
        if (!inRoom(room, x, y)) continue;
        let d = Infinity;
        for (const s of obstacles) { const q = segDist(x, y, s.x1, s.y1, s.x2, s.y2); if (q < d) d = q; }
        const dc = (x - c.x) ** 2 + (y - c.y) ** 2;
        if (d > bestD + tie || (d > bestD - tie && dc < bestC)) { bestD = Math.max(d, bestD); bestC = dc; best = { x, y }; }
      }
    }
    if (!best) return null;
    w = (3 * w) / N; h = (3 * h) / N; x0 = best.x - w / 2; y0 = best.y - h / 2;
  }
  return best;
}

// ---------- toMapUnits ----------

// Fits the floor's bounding box into the 0-100 map with `margin` on every side, keeping the aspect ratio
// and centring the short side. y is flipped (Y = ty - y * scale): the model's y points up the page while
// the canvas's y grows downward, so without the flip the plan would be drawn mirrored.
export function toMapUnits(plan, { margin = 3 } = {}) {
  if (!isObj(plan)) throw new TypeError('toMapUnits: expected a plan from extractFloorplan');
  if (plan.units === 'map') return plan;
  const m = Math.min(45, Math.max(0, fin(margin) ? Number(margin) : 3));
  const warnings = [...arr(plan.warnings)];
  const b = plan.bounds;
  if (!b) {
    warnings.push('nothing to place on the map');
    return { ...plan, units: 'map', rooms: [], walls: [], doors: [], metersPerUnit: 1, transform: { scale: 1, tx: 50, ty: 50, flipY: true, margin: m }, warnings };
  }
  const w = b.maxX - b.minX, h = b.maxY - b.minY, usable = 100 - 2 * m;
  const scale = usable / Math.max(w, h, 1e-6);
  const tx = m + (usable - w * scale) / 2 - b.minX * scale;
  const ty = m + (usable - h * scale) / 2 + b.maxY * scale;
  const X = x => r4(tx + x * scale), Y = y => r4(ty - y * scale);
  const P = p => (p ? { x: X(p.x), y: Y(p.y) } : null);
  return {
    ...plan,
    units: 'map',
    rooms: arr(plan.rooms).map(r => ({
      ...r, polygon: arr(r.polygon).map(P), holes: arr(r.holes).map(hl => hl.map(P)),
      centroid: P(r.centroid), inside: P(r.inside), area: r4(r.area * scale * scale), areaM2: r.area
    })),
    walls: arr(plan.walls).map(wl => ({ ...wl, x1: X(wl.x1), y1: Y(wl.y1), x2: X(wl.x2), y2: Y(wl.y2) })),
    doors: arr(plan.doors).map(d => ({
      ...d, x: X(d.x), y: Y(d.y), ...(fin(d.x1) ? { x1: X(d.x1), y1: Y(d.y1), x2: X(d.x2), y2: Y(d.y2) } : {}),
      width: r4(d.width * scale), widthM: d.width
    })),
    bounds: { minX: X(b.minX), minY: Y(b.maxY), maxX: X(b.maxX), maxY: Y(b.minY) },
    metersPerUnit: 1 / scale,
    transform: { scale, tx, ty, flipY: true, margin: m },
    warnings
  };
}

// ---------- floorplanToWorld ----------

function roomNames(rooms) {
  const base = rooms.map(r => r.label || (r.classification && !GENERIC_CLASSES.has(r.classification.toLowerCase()) ? r.classification : 'Room'));
  const total = new Map(), seen = new Map();
  for (const b of base) total.set(b, (total.get(b) || 0) + 1);
  return base.map(b => {
    if (total.get(b) === 1 && b !== 'Room') return b.slice(0, 40);
    const n = (seen.get(b) || 0) + 1;
    seen.set(b, n);
    return `${b.slice(0, 34)} ${n}`;
  });
}

function minWallDist(walls, p) {
  let d = Infinity;
  for (const w of walls) d = Math.min(d, segDist(p.x, p.y, w.x1, w.y1, w.x2, w.y2));
  return d;
}

// A starter world for one floor: route mode (rooms and doors as a network whose edges follow wall-free
// polylines) or visit mode (entrances at exterior doors, one service place per room). The plan may be
// in metres (it is converted with toMapUnits) or already in map units. Builder warnings are attached as
// a non-enumerable `warnings` array, so they are readable but never written into the world JSON.
export function floorplanToWorld(plan, { mode = 'route', title, question, margin = 3 } = {}) {
  if (!isObj(plan)) throw new TypeError('floorplanToWorld: expected a plan from extractFloorplan');
  const route = mode !== 'visit';
  const mp = plan.units === 'map' ? plan : toMapUnits(plan, { margin: Math.max(3, fin(margin) ? Number(margin) : 3) });
  const warnings = [...arr(mp.warnings)];
  const warn = msg => { if (!warnings.includes(msg)) warnings.push(msg); };
  if (mode !== 'route' && mode !== 'visit') warn(`mode ${show(mode)} is not "route" or "visit"; using "route"`);
  const mpu = Number(mp.metersPerUnit) > 0 ? Number(mp.metersPerUnit) : 1;

  const walls = arr(mp.walls).map(w => ({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, source: 'matterport-vector' }));
  if (walls.length > LIMITS.walls) warn(`${walls.length} wall segments is above the world maximum of ${LIMITS.walls}`);
  const rooms = arr(mp.rooms);
  const names = roomNames(rooms);
  const roomById = new Map(rooms.map((r, i) => [r.id, { room: r, name: names[i], idx: i }]));
  const widthM = d => (fin(d.widthM) ? Number(d.widthM) : Number(d.width) * mpu);

  // Clearance: a quarter of the narrowest door, capped for wide openings, within the spec's 0.02-1.
  const doorWidths = arr(mp.doors).filter(d => d.type !== 'invisible').map(widthM).filter(v => v > 0);
  const quarter = doorWidths.length ? Math.min(...doorWidths) / 4 : Infinity;
  let clearance = Math.min(quarter, CLEARANCE_CAP_M) / mpu;
  if (clearance < 0.02) warn(`the narrowest door is too narrow for the minimum path clearance of 0.02 map units; using 0.02`);
  clearance = Math.max(0.02, Math.min(1, Math.floor(clearance * 1e4) / 1e4));
  const nav = createNav(walls, { clearance });

  const nodeOk = (p, what) => {
    if (!p || !fin(p.x) || !fin(p.y)) { warn(`${what}: has no position; left out`); return false; }
    if (p.x < 3 || p.x > 97 || p.y < 3 || p.y > 97) warn(`${what}: at (${p.x}, ${p.y}), outside the 3-97 node range; the world will move it`);
    if (minWallDist(walls, p) < NODE_WALL_MIN) { warn(`${what}: closer than ${NODE_WALL_MIN} map units to a wall; left out`); return false; }
    return true;
  };

  // Usable doors and the rooms they join.
  const doors = [];
  arr(mp.doors).forEach((d, k) => {
    const sides = arr(d.roomIds).filter(id => id !== null && roomById.has(id));
    if (sides.length === 2 && sides[0] === sides[1]) return;
    const exterior = sides.length === 1 && d.outside !== false && arr(d.roomIds).includes(null);
    if (!sides.length || (sides.length === 1 && !exterior)) return;
    if (!nodeOk(d, `door ${d.id ?? k}`)) return;
    doors.push({ door: d, k, sides, exterior, widthM: widthM(d) });
  });
  const doorsOf = new Map(rooms.map(r => [r.id, doors.filter(x => x.sides.includes(r.id))]));
  const roomOk = new Map();
  for (const r of rooms) {
    const info = roomById.get(r.id);
    if (!doorsOf.get(r.id).length) { warn(`room "${info.name}" (${r.id}) has no doorway or open side; left out of the world`); roomOk.set(r.id, false); continue; }
    roomOk.set(r.id, nodeOk(r.inside, `room "${info.name}" (${r.id})`));
  }

  const usedIds = new Set();
  const nodeId = (base, i) => { let id = slug(base, i); while (usedIds.has(id)) id = slug(`${id}_${i}`, i); usedIds.add(id); return id; };
  const roomNode = new Map();
  for (const r of rooms) if (roomOk.get(r.id)) roomNode.set(r.id, nodeId(`room_${r.id}`, roomById.get(r.id).idx));
  let entranceN = 0;
  const doorName = x => {
    if (x.exterior) return `Entrance ${++entranceN}`;
    const [a, b] = x.sides.map(id => roomById.get(id).name.slice(0, 16));
    return `${a} / ${b} ${x.door.type === 'invisible' ? 'opening' : 'door'}`.slice(0, 40);
  };
  for (const x of doors) { x.name = doorName(x); x.nodeId = nodeId(`door_${x.k + 1}`, x.k); }

  // The wall-free polyline through the given points, or null.
  const legs = pts => {
    const out = [pts[0]];
    let len = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = nav.path(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
      if (!p) return null;
      out.push(...p.points.slice(1));
      len += p.length;
    }
    return { points: out, length: len };
  };

  const provenance = {
    walls: 'data', 'geo.metersPerUnit': 'data', 'geo.clearance': 'assumed',
    'nodes[*].x': 'data', 'nodes[*].y': 'data', 'nodes[*].kind': 'data',
    'nodes[*].name': rooms.some(r => r.label) ? 'data' : 'assumed',
    duration: 'assumed', clockStart: 'assumed', arrivals: 'assumed', archetypes: 'assumed'
  };
  const floorName = mp.floor ? (mp.floor.label || (mp.floor.sequence !== null ? `floor ${mp.floor.sequence}` : `floor ${mp.floor.id}`)) : 'floor';
  const world = {
    title: (typeof title === 'string' && title.trim() ? title.trim() : `${floorName}, Matterport model ${mp.modelId ?? ''}`.trim()).slice(0, 80),
    question: (typeof question === 'string' && question.trim() ? question.trim()
      : route ? 'Where do people get stuck moving through this floor, and which door or corridor change helps most?'
        : 'Which rooms on this floor build up lines, and where do people give up?').slice(0, 400),
    context: '',
    mode: route ? 'route' : 'visit'
  };

  const nodes = [], edges = [];
  let visitDoors = null;
  if (route) {
    const roomPos = id => roomById.get(id).room.inside;
    const compact = roomNode.size + doors.length > LIMITS.nodes;
    if (compact) warn(`${roomNode.size} rooms and ${doors.length} doors exceed ${LIMITS.nodes} nodes; interior doors become waypoints on room-to-room edges`);
    const connected = new Map([...roomNode.keys()].map(id => [id, new Set()]));
    let clampedShort = 0;
    const pair = new Map();
    const addEdge = (from, to, name, poly, width) => {
      if (poly.points.length - 2 > LIMITS.via) { warn(`edge ${name}: needs ${poly.points.length - 2} waypoints (max ${LIMITS.via}); left out`); return false; }
      const raw = Math.min(MAX_EDGE_MIN, (poly.length * mpu) / WALK_M_PER_MIN);
      if (raw < MIN_EDGE_MIN) clampedShort++;
      const length = Math.max(MIN_EDGE_MIN, r3(raw));
      let via = poly.points.slice(1, -1).map(p => ({ x: r4(p.x), y: r4(p.y) }));
      const ends = [poly.points[0], poly.points.at(-1)];
      if (polylineCrossesWall(walls, [ends[0], ...via, ends[1]])) via = poly.points.slice(1, -1).map(p => ({ x: p.x, y: p.y }));
      if (polylineCrossesWall(walls, [ends[0], ...via, ends[1]])) { warn(`edge ${name}: its path touches a wall; left out`); return false; }
      const key = [from, to].sort().join('>');
      const prev = pair.get(key);
      if (prev) {   // a second door between the same two rooms (compact mode): widen the first edge
        prev.width += width;
        prev.edge.capacity = Math.max(1, Math.round(DOOR_FLOW_PER_M_MIN * prev.width * prev.edge.length));
        return true;
      }
      // Capacity = door flow (78 people per metre of width per minute) x door width x minutes on the edge:
      // the number of people on the edge when its door runs at full flow (the BPR curve's ratio 1).
      const edge = { from, to, name: name.slice(0, 40), length, capacity: Math.max(1, Math.round(DOOR_FLOW_PER_M_MIN * width * length)), twoWay: true };
      if (via.length) edge.via = via;
      edges.push(edge);
      pair.set(key, { edge, width });
      return true;
    };
    // A room-to-door edge reads as the walk it is, e.g. "Main corridor to Office 3 door", within 40 chars.
    const sideName = (rid, x) => {
      const from = roomById.get(rid).name.slice(0, 18);
      if (x.exterior) return `${from} to ${x.name}`;
      const other = x.sides.find(id => id !== rid);
      return `${from} to ${roomById.get(other).name.slice(0, 13)} ${x.door.type === 'invisible' ? 'opening' : 'door'}`;
    };
    const doorNodes = [];
    for (const x of doors) {
      const rs = x.sides.filter(id => roomNode.has(id));
      if (!compact || x.exterior) {
        let any = false;
        for (const rid of rs) {
          const poly = legs([roomPos(rid), x.door]);
          if (!poly) { warn(`no wall-free path from room "${roomById.get(rid).name}" to ${x.name}; edge left out`); continue; }
          if (addEdge(roomNode.get(rid), x.nodeId, sideName(rid, x), poly, x.widthM)) { connected.get(rid).add(x.k); any = true; }
        }
        if (any) doorNodes.push(x);
      } else if (rs.length === 2) {
        const poly = legs([roomPos(rs[0]), x.door, roomPos(rs[1])]);
        if (!poly) { warn(`no wall-free path through ${x.name}; edge left out`); continue; }
        if (addEdge(roomNode.get(rs[0]), roomNode.get(rs[1]), x.name, poly, x.widthM)) { connected.get(rs[0]).add(x.k); connected.get(rs[1]).add(x.k); }
      }
    }
    if (clampedShort) warn(`${clampedShort} edge(s) are shorter than ${MIN_EDGE_MIN * WALK_M_PER_MIN} m (${MIN_EDGE_MIN} min at ${WALK_M_PER_MIN} m/min, the spec's minimum edge length); their length is ${MIN_EDGE_MIN}`);

    for (const r of rooms) if (roomNode.has(r.id) && !connected.get(r.id).size) warn(`room "${roomById.get(r.id).name}" (${r.id}) could not be connected; left out`);
    const roomOfNode = new Map(rooms.filter(r => roomNode.has(r.id) && connected.get(r.id).size).map(r => [roomNode.get(r.id), r]));
    const doorOfNode = new Map(doorNodes.map(x => [x.nodeId, x]));
    let kept = new Set([...roomOfNode.keys(), ...doorOfNode.keys()]);
    const degreeIn = set => {
      const d = new Map();
      for (const e of edges) if (set.has(e.from) && set.has(e.to)) for (const id of [e.from, e.to]) d.set(id, (d.get(id) || 0) + 1);
      return d;
    };

    // Too big even with room-to-room edges: keep the connected part of the floor nearest the entrances.
    if (kept.size > LIMITS.nodes || edges.length > LIMITS.edges) {
      const adj = new Map([...kept].map(id => [id, []]));
      for (const e of edges) { adj.get(e.from).push(e.to); adj.get(e.to).push(e.from); }
      let starts = [...doorOfNode.values()].filter(x => x.exterior).map(x => x.nodeId);
      if (!starts.length) {
        const deg = degreeIn(kept);
        starts = [[...roomOfNode.keys()].sort((p, q) => (deg.get(q) || 0) - (deg.get(p) || 0) || roomOfNode.get(q).area - roomOfNode.get(p).area)[0]];
      }
      const order = [], seen = new Set(starts), queue = [...starts];
      while (queue.length) { const id = queue.shift(); order.push(id); for (const o of adj.get(id)) if (!seen.has(o)) { seen.add(o); queue.push(o); } }
      const keep = new Set();
      let count = 0;
      for (const id of order) {
        if (keep.size >= LIMITS.nodes) break;
        const add = adj.get(id).filter(o => keep.has(o)).length;
        if (count + add > LIMITS.edges) continue;
        keep.add(id); count += add;
      }
      const before = roomOfNode.size, after = [...keep].filter(id => roomOfNode.has(id)).length;
      kept = keep;
      warn(`kept the ${after} of ${before} rooms nearest the entrances to stay within ${LIMITS.nodes} nodes and ${LIMITS.edges} edges; the rest of the floor is left out`);
    }
    for (let i = edges.length - 1; i >= 0; i--) if (!kept.has(edges[i].from) || !kept.has(edges[i].to)) edges.splice(i, 1);
    const degree = degreeIn(kept);

    // Kinds: exterior doors are origins, one-door rooms destinations, the rest intersections.
    const roomEntries = [...roomOfNode].filter(([id]) => degree.get(id)).map(([id, r]) => ({ id, r, n: degree.get(id) }));
    const kind = new Map(roomEntries.map(({ id, n }) => [id, n === 1 ? 'destination' : 'intersection']));
    const exteriorKept = [...doorOfNode.values()].filter(x => x.exterior && degree.get(x.nodeId));
    if (!exteriorKept.length && roomEntries.length) {
      const best = roomEntries.slice().sort((p, q) => q.n - p.n || q.r.area - p.r.area || roomById.get(p.r.id).idx - roomById.get(q.r.id).idx)[0];
      kind.set(best.id, 'origin');
      warn(`no exterior door on this floor; using the best-connected room "${roomById.get(best.r.id).name}" as the origin`);
    }
    if (![...kind.values()].includes('destination')) {
      const pick = roomEntries.filter(e => kind.get(e.id) !== 'origin').sort((p, q) => p.n - q.n || q.r.area - p.r.area)[0];
      if (pick) { kind.set(pick.id, 'destination'); warn(`no room has a single door; using "${roomById.get(pick.r.id).name}" as the destination`); }
      else warn('cannot pick a destination: the floor needs at least two connected rooms or an exterior door');
    }
    for (const { id, r } of roomEntries) nodes.push({ id, name: roomById.get(r.id).name, kind: kind.get(id), x: r.inside.x, y: r.inside.y });
    for (const x of doorNodes) {
      if (degree.get(x.nodeId)) nodes.push({ id: x.nodeId, name: x.name, kind: x.exterior ? 'origin' : 'intersection', x: x.door.x, y: x.door.y });
    }
    Object.assign(provenance, { 'edges[*].via': 'data', 'edges[*].length': 'data', 'edges[*].capacity': 'assumed' });
    // Link-by-link moves are a softmax over minutes with sharpness `rationality`. Indoor links are about
    // 0.2 min, so the route default of 0.8 makes a wrong turn nearly as likely as the right one (on the
    // fixture floor 6% of people got lost and most "delay" was wandering); 10 keeps people on course.
    Object.assign(world, {
      duration: 60, clockStart: 510, arrivals: { total: 200, start: 0, end: 30, shape: 'peak' },
      nodes, edges,
      archetypes: [{ id: 'occupants', name: 'Occupants', share: 1, description: 'Placeholder group: replace with the people who use this floor.', info: 0.5, rationality: 10 }]
    });
  } else {
    let gates = doors.filter(x => x.exterior).map(x => ({ id: x.nodeId, name: x.name, kind: 'gate', x: x.door.x, y: x.door.y }));
    let gateRoom = null;
    if (!gates.length) {
      const best = rooms.filter(r => roomOk.get(r.id)).sort((p, q) => doorsOf.get(q.id).length - doorsOf.get(p.id).length || q.area - p.area)[0];
      if (best) {
        gateRoom = best.id;
        gates = [{ id: nodeId(`entrance_${best.id}`, 0), name: `${roomById.get(best.id).name} (entrance)`.slice(0, 40), kind: 'gate', x: best.inside.x, y: best.inside.y }];
        warn(`no exterior door on this floor; people enter and leave at the best-connected room "${roomById.get(best.id).name}"`);
      } else warn('no exterior door and no usable room: the world has no entrance');
    }
    let services = [];
    for (const r of rooms) {
      if (!roomOk.get(r.id) || r.id === gateRoom) continue;
      const info = roomById.get(r.id);
      if (!gates.some(g => nav.path(g.x, g.y, r.inside.x, r.inside.y))) { warn(`room "${info.name}" (${r.id}) cannot be reached on foot from an entrance; left out`); continue; }
      const areaM2 = fin(r.areaM2) ? Number(r.areaM2) : r.area * mpu * mpu;
      const kindName = r.classification && !GENERIC_CLASSES.has(r.classification.toLowerCase()) ? r.classification : 'Room';
      services.push({
        id: roomNode.get(r.id), name: info.name, kind: 'service', x: r.inside.x, y: r.inside.y,
        servers: Math.min(1000, Math.max(1, Math.round(areaM2 / 25))), serviceTime: 5,
        tags: [slug(kindName.toLowerCase(), 0)], about: `${kindName}, about ${Math.round(areaM2)} m² (Matterport)`.slice(0, 160),
        areaM2
      });
    }
    if (gates.length + services.length > LIMITS.nodes) {
      const keep = services.slice().sort((p, q) => q.areaM2 - p.areaM2).slice(0, Math.max(0, LIMITS.nodes - gates.length));
      warn(`kept the ${keep.length} largest of ${services.length} rooms to stay within ${LIMITS.nodes} nodes`);
      services = services.filter(s => keep.includes(s));
    }
    if (!services.length) warn('no room can be a service place: the world needs at least one reachable room');
    nodes.push(...gates, ...services.map(({ areaM2, ...s }) => s));
    // §14d: doorway gap segments, so the sim counts foot traffic through each one.
    visitDoors = doors.filter(x => fin(x.door.x1)).slice(0, 500).map(x => ({
      id: x.nodeId, name: x.name, x1: x.door.x1, y1: x.door.y1, x2: x.door.x2, y2: x.door.y2, exterior: x.exterior
    }));
    Object.assign(provenance, { doors: 'data', travelSpeed: 'assumed', 'nodes[*].servers': 'assumed', 'nodes[*].serviceTime': 'assumed', 'nodes[*].tags': 'data' });
    const speed = WALK_M_PER_MIN / mpu;
    if (speed > MAX_TRAVEL_SPEED) warn(`walking speed ${WALK_M_PER_MIN} m/min is ${speed.toFixed(0)} map units/min, above the spec's maximum of ${MAX_TRAVEL_SPEED}; using ${MAX_TRAVEL_SPEED}`);
    Object.assign(world, {
      duration: 120, clockStart: 540, travelSpeed: r3(Math.min(MAX_TRAVEL_SPEED, Math.max(0.2, speed))),
      arrivals: { total: 150, start: 0, end: 60, shape: 'peak' },
      nodes,
      archetypes: [{ id: 'visitors', name: 'Visitors', share: 1, description: 'Placeholder group: replace with the people who use this floor.', visits: Math.max(1, Math.min(3, services.length)), patience: 30, info: 0.5 }]
    });
  }

  const doorCount = doors.filter(x => x.door.type !== 'invisible').length;
  world.context = `Floor plan from Matterport model ${mp.modelId ?? '(unknown)'}, ${floorName}: ${roomNode.size} rooms and ${doorCount} doorways. People cannot walk through walls.`.slice(0, 300);
  world.walls = walls;
  world.geo = {
    metersPerUnit: +mpu.toPrecision(6), clearance,
    floor: mp.floor ? (mp.floor.label || (mp.floor.sequence ?? mp.floor.id)) : null, source: 'matterport-vector'
  };
  if (visitDoors) world.doors = visitDoors;
  world.provenance = provenance;
  Object.defineProperty(world, 'warnings', { value: warnings, enumerable: false });
  return world;
}
