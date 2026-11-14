// World spec: normalize (lenient: clamps and fills defaults), validate (reports every fix and problem),
// clean (mode-relevant fields only), patch (what-if changes) and hash. Contract: docs/PROTOTYPE.md §2,
// walls and building fields §13a and §14d; field reference: worlds/SCHEMA.md.
import { clamp, truthy, slug, sha256Hex } from './util.js';
import { normalizeWalls, createNav, crossesWall, polylineCrossesWall, polylineLength } from './walls.js';

const KINDS_VISIT = ['gate', 'entry', 'exit', 'service'];
const KINDS_ROUTE = ['origin', 'destination', 'intersection'];
const SHAPES = ['uniform', 'peak', 'early', 'late', 'poisson'];
const SERVICE_DISTS = ['uniform', 'exp', 'fixed'];
const COST_MODELS = ['bpr', 'linear'];
const PROVENANCE_LABELS = ['data', 'vision', 'assumed', 'owner-reported'];
const DEFAULT_TITLE = 'Untitled world';
const DEFAULT_QUESTION = 'Where are the bottlenecks?';
const DEFAULT_LEAVE = 'Leave and go home';
const MAX = { nodes: 60, edges: 150, archetypes: 6, minds: 40, tags: 12, walls: 4000, doors: 500, via: 12, provenance: 300 };
const DEFAULT_CLEARANCE = 0.2;
const SPEED = { def: 4, min: 0.2, max: 600 }; // travelSpeed, map units per minute (§14d raised the maximum from 60)
const MIN_WALL_GAP = 0.05;   // every node keeps at least this distance from every wall (§13a)
const DOOR_END_SLACK = 0.02; // a door may touch walls within this distance of its own ends (its jambs)
const DOOR_NEAR_WALL = 0.5;  // a door with no wall this close to either end is not in a wall gap

const KNOWN = {
  top: ['$schema', 'title', 'question', 'context', 'leaveLabel', 'mode', 'duration', 'clockStart', 'travelSpeed', 'walkSpeed',
    'arrivals', 'nodes', 'edges', 'archetypes', 'minds', 'walls', 'geo', 'doors', 'provenance'],
  arrivals: ['total', 'start', 'end', 'shape'],
  node: ['id', 'name', 'kind', 'x', 'y', 'servers', 'serviceTime', 'serviceDist', 'appeal', 'price', 'tags', 'about', 'weight'],
  edge: ['from', 'to', 'name', 'length', 'capacity', 'twoWay', 'costModel', 'via'],
  archetype: ['id', 'name', 'description', 'share', 'weights', 'visits', 'patience', 'info', 'rationality', 'likes', 'needs',
    'origins', 'destinations', 'entries', 'exits'],
  weights: ['appeal', 'wait', 'distance', 'price'],
  mind: ['id', 'name', 'age', 'archetype', 'bio', 'personality', 'goal', 'social', 'informed', 'weight', 'entry', 'origin', 'destination'],
  geo: ['metersPerUnit', 'clearance', 'floor', 'source'],
  door: ['id', 'name', 'x1', 'y1', 'x2', 'y2', 'exterior'],
  point: ['x', 'y']
};

// ---------- reporting ----------
// Collects messages while a spec is built. `fail` marks a fatal problem (normalizeSpec throws it);
// `error` is fatal for validateWorld only (an unknown reference that normalizeSpec silently drops).
class Report {
  constructor(silent = false) { this.silent = silent; this.errors = []; this.warnings = []; this.fatal = []; }
  warn(path, msg) { if (!this.silent) this.warnings.push(`${path}: ${msg}`); }
  note(line) { if (!this.silent) this.warnings.push(line); } // a warning that already names its path
  error(path, msg) { if (!this.silent) this.errors.push(`${path}: ${msg}`); }
  fail(path, msg) { this.fatal.push(msg); this.errors.push(`${path}: ${msg}`); }
}
const SILENT = new Report(true);

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const missing = v => v === undefined || v === null || v === '';
const fmt = x => String(+Number(x).toFixed(4));
const show = v => { const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v); return s.length > 48 ? s.slice(0, 45) + '...' : s; };
const article = w => (/^[aeiou]/i.test(w) ? 'an ' : 'a ') + w;
const subPath = (path, key) => (path ? `${path}.${key}` : key);

function unknownFields(rep, path, obj, known) {
  for (const k of Object.keys(obj)) if (!known.includes(k)) rep.warn(subPath(path, k), 'unknown field; ignored');
}

// A number in [lo, hi]. Missing values take the default silently; anything else that had to change is a warning.
function number(rep, path, v, def, lo, hi, int = false) {
  const fallback = int ? Math.round(clamp(def, lo, hi)) : clamp(def, lo, hi);
  if (missing(v)) return fallback;
  const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) { rep.warn(path, `${show(v)} is not a number; using ${fmt(fallback)}`); return fallback; }
  let out = n;
  if (n < lo) { out = int ? Math.ceil(lo) : lo; rep.warn(path, `${fmt(n)} is below the minimum ${fmt(lo)}; using ${fmt(out)}`); }
  else if (n > hi) { out = int ? Math.floor(hi) : hi; rep.warn(path, `${fmt(n)} is above the maximum ${fmt(hi)}; using ${fmt(out)}`); }
  else if (int && !Number.isInteger(n)) { out = Math.round(n); rep.warn(path, `${fmt(n)} is not a whole number; using ${out}`); }
  return out;
}

// Whitespace-collapsed text cut to `max` characters ('' when missing).
function text(rep, path, v, max) {
  if (missing(v)) return '';
  if (typeof v !== 'string' && typeof v !== 'number') { rep.warn(path, `${show(v)} is not text; ignored`); return ''; }
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (s.length > max) rep.warn(path, `longer than ${max} characters; cut to ${max}`);
  return s.slice(0, max);
}

// Lowercase tag list, at most 12 entries.
function tags(rep, path, v) {
  if (missing(v)) return [];
  if (!Array.isArray(v)) { rep.warn(path, `${show(v)} is not a list; ignored`); return []; }
  const all = v.map(x => String(x).toLowerCase().trim()).filter(Boolean);
  if (all.length > MAX.tags) rep.warn(path, `${all.length} entries; only the first ${MAX.tags} are used`);
  return all.slice(0, MAX.tags);
}

function choice(rep, path, v, allowed, def) {
  if (missing(v)) return def;
  const s = String(v).toLowerCase().trim();
  if (allowed.includes(s)) return s;
  rep.warn(path, `${show(v)} is not one of ${allowed.join(', ')}; using "${def}"`);
  return def;
}

function list(rep, path, v, max) {
  if (missing(v)) return [];
  if (!Array.isArray(v)) { rep.warn(path, `${show(v)} is not a list; ignored`); return []; }
  if (v.length > max) rep.warn(path, `${v.length} entries; only the first ${max} are used`);
  return v.slice(0, max);
}

// Slugged, unique id for entry `i`; warns when the given id had to change.
function uniqueId(rep, path, obj, i, used) {
  const given = obj.id ?? obj.name;
  let id = slug(given, i);
  if (obj.id != null && String(obj.id) !== id) rep.warn(`${path}.id`, `${show(obj.id)} is not a valid id; using "${id}"`);
  if (missing(given)) rep.warn(path, `no id or name; using "${id}"`);
  const base = id;
  while (used.has(id)) id += '_' + i;
  if (id !== base) rep.warn(`${path}.id`, `"${base}" is already used; using "${id}"`);
  used.add(id);
  return id;
}

// ---------- geometry fields ----------
const toNum = v => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const isNum = v => Number.isFinite(toNum(v));

function jsonCopy(v) {
  try { const s = JSON.stringify(v); return s === undefined ? undefined : JSON.parse(s); } catch { return undefined; }
}

// Route edge waypoints, [{ x, y }] or [[x, y]], clamped to the 0-100 map; unusable points are dropped.
function viaPoints(rep, path, v) {
  const out = [];
  list(rep, path, v, MAX.via).forEach((pt, j) => {
    const p = `${path}[${j}]`;
    let x, y;
    if (Array.isArray(pt)) [x, y] = pt;
    else if (isObj(pt)) { unknownFields(rep, p, pt, KNOWN.point); ({ x, y } = pt); }
    else { rep.warn(p, `${show(pt)} is not a point { x, y }; dropped`); return; }
    if (!isNum(x) || !isNum(y)) {
      const [k, bad] = isNum(x) ? ['y', y] : ['x', x];
      rep.warn(`${p}.${k}`, `${missing(bad) ? 'missing' : `${show(bad)} is not a number`}; point dropped`);
      return;
    }
    out.push({ x: number(rep, `${p}.x`, x, 50, 0, 100), y: number(rep, `${p}.y`, y, 50, 0, 100) });
  });
  return out;
}

// Input index of every wall normalizeWalls kept. It keeps walls in input order with coordinates clamped
// to the map, so each kept wall is the next input segment with the same clamped ends.
function inputIndexes(raw, kept) {
  if (!Array.isArray(raw)) return kept.map((_, k) => k);
  const ends = w => (Array.isArray(w) ? w.slice(0, 4) : isObj(w) ? [w.x1, w.y1, w.x2, w.y2] : []).map(v => clamp(toNum(v), 0, 100));
  const at = [];
  let j = 0;
  for (const w of kept) {
    for (; j < raw.length; j++) {
      const e = ends(raw[j]);
      if (e[0] === w.x1 && e[1] === w.y1 && e[2] === w.x2 && e[3] === w.y2) break;
    }
    if (j >= raw.length) return kept.map((_, k) => k);
    at.push(j++);
  }
  return at;
}

function pointSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

// { dist, wall } for the wall nearest to (x, y); wall is -1 when there are none.
function nearestWall(walls, x, y) {
  let dist = Infinity, wall = -1;
  walls.forEach((w, k) => {
    const d = pointSegDist(x, y, w.x1, w.y1, w.x2, w.y2);
    if (d < dist) { dist = d; wall = k; }
  });
  return { dist, wall };
}

// ---------- build: the one normalizer behind normalizeSpec and validateWorld ----------
function build(raw, rep) {
  if (!isObj(raw)) { rep.fail('spec', 'The world spec must be a JSON object.'); return null; }
  unknownFields(rep, '', raw, KNOWN.top);

  let mode = 'visit';
  if (raw.mode === 'route') mode = 'route';
  else if (!missing(raw.mode) && raw.mode !== 'visit') rep.warn('mode', `${show(raw.mode)} is not "visit" or "route"; using "visit"`);
  const route = mode === 'route';
  const visitOnly = route ? SILENT : rep;

  const title = text(rep, 'title', raw.title, 80) || DEFAULT_TITLE;
  if (missing(raw.title)) rep.warn('title', `missing; using "${DEFAULT_TITLE}"`);
  const question = text(rep, 'question', raw.question, 400) || DEFAULT_QUESTION;
  if (missing(raw.question)) rep.warn('question', `missing; using "${DEFAULT_QUESTION}"`);
  const context = text(rep, 'context', raw.context, 300) || title;
  if (missing(raw.context)) rep.warn('context', 'missing; agents are told only the title');
  const leaveLabel = text(visitOnly, 'leaveLabel', raw.leaveLabel, 60) || DEFAULT_LEAVE;

  const duration = number(rep, 'duration', raw.duration, route ? 180 : 600, 30, 1440, true);
  let ar = raw.arrivals;
  if (missing(ar)) ar = {};
  else if (!isObj(ar)) { rep.warn('arrivals', `${show(ar)} is not an object; using defaults`); ar = {}; }
  unknownFields(rep, 'arrivals', ar, KNOWN.arrivals);
  const start = number(rep, 'arrivals.start', ar.start, 0, 0, duration - 1);
  const end = number(rep, 'arrivals.end', ar.end, duration * 0.6, start + 1, duration);
  const speedKey = missing(raw.travelSpeed) && !missing(raw.walkSpeed) ? 'walkSpeed' : 'travelSpeed';

  const spec = {
    title, question, context, leaveLabel, mode, duration,
    clockStart: number(rep, 'clockStart', raw.clockStart, 480, 0, 1439, true),
    travelSpeed: number(visitOnly, speedKey, raw[speedKey], SPEED.def, SPEED.min, SPEED.max),
    arrivals: {
      total: number(rep, 'arrivals.total', ar.total, 800, 10, 5000, true), start, end,
      shape: choice(rep, 'arrivals.shape', ar.shape, SHAPES, 'peak')
    },
    nodes: [], edges: [], archetypes: [], minds: [],
    walls: [], geo: null, doors: [], provenance: null
  };

  // ----- nodes -----
  const ids = new Set(), ref = new Map(), names = new Map(), nodePath = new Map(), edgePaths = [];
  const allowed = route ? KINDS_ROUTE : KINDS_VISIT;
  const defaultKind = route ? 'intersection' : 'service';
  list(rep, 'nodes', raw.nodes, MAX.nodes).forEach((n, i) => {
    const p = `nodes[${i}]`;
    if (!isObj(n)) { rep.warn(p, 'not an object; ignored'); return; }
    unknownFields(rep, p, n, KNOWN.node);
    const id = uniqueId(rep, p, n, i, ids);
    ref.set(id, id);
    if (n.id != null && !ref.has(String(n.id))) ref.set(String(n.id), id);
    let kind = String(n.kind ?? '').toLowerCase().trim();
    if (!allowed.includes(kind)) {
      if (!missing(n.kind)) rep.warn(`${p}.kind`, `${show(n.kind)} is not a ${mode}-mode kind (${allowed.join(', ')}); using "${defaultKind}"`);
      kind = defaultKind;
    }
    const sr = kind === 'service' ? rep : SILENT;
    const wr = kind === 'gate' || kind === 'entry' ? rep : SILENT;
    const name = text(rep, `${p}.name`, n.name, 40) || id;
    if (!names.has(name)) names.set(name, id);
    nodePath.set(id, p);
    spec.nodes.push({
      id, name, kind,
      x: number(rep, `${p}.x`, n.x, 50, 3, 97), y: number(rep, `${p}.y`, n.y, 50, 3, 97),
      servers: number(sr, `${p}.servers`, n.servers, 10, 1, 1000, true),
      serviceTime: number(sr, `${p}.serviceTime`, n.serviceTime, 5, 0.2, 720),
      serviceDist: choice(sr, `${p}.serviceDist`, n.serviceDist, SERVICE_DISTS, 'uniform'),
      appeal: number(sr, `${p}.appeal`, n.appeal, 0.5, 0, 1),
      price: number(sr, `${p}.price`, n.price, 0, 0, Infinity),
      tags: tags(sr, `${p}.tags`, n.tags), about: text(sr, `${p}.about`, n.about, 160),
      weight: number(wr, `${p}.weight`, n.weight, 1, 0.01, Infinity)
    });
  });
  const byId = new Map(spec.nodes.map(n => [n.id, n]));
  const resolveNode = r => {
    if (missing(r) || typeof r === 'object') return undefined;
    const s = String(r);
    return ref.get(s) ?? names.get(s) ?? ref.get(slug(s, 0));
  };
  // A node reference that must exist: unknown names are errors (validateWorld) and are dropped (normalizeSpec).
  const refNode = (path, r) => {
    if (missing(r)) { rep.error(path, 'missing'); return null; }
    const id = resolveNode(r);
    if (!id) { rep.error(path, `${show(r)} is not a node id or name`); return null; }
    return id;
  };

  if (!route) {
    if (!spec.nodes.some(n => n.kind === 'service')) {
      rep.fail('nodes', 'A visit world needs at least one service location (a ride, hospital, stall, desk…).');
    }
    if (!spec.nodes.some(n => n.kind === 'gate' || n.kind === 'entry')) {
      let id = 'gate';
      while (ids.has(id)) id += '_auto';
      ids.add(id);
      const gate = { id, name: 'Entrance', kind: 'gate', x: 50, y: 95, servers: 1, serviceTime: 1, serviceDist: 'uniform', appeal: 0, price: 0, tags: [], about: '', weight: 1 };
      spec.nodes.push(gate);
      byId.set(id, gate);
      if (!ref.has(id)) ref.set(id, id);
      rep.warn('nodes', `no gate or entry; added an "Entrance" gate "${id}" at (50, 95)`);
    }
    if (Array.isArray(raw.edges) && raw.edges.length) rep.warn('edges', 'ignored in visit mode');
  } else {
    const links = new Map();
    list(rep, 'edges', raw.edges, MAX.edges).forEach((e, i) => {
      const p = `edges[${i}]`;
      if (!isObj(e)) { rep.warn(p, 'not an object; ignored'); return; }
      unknownFields(rep, p, e, KNOWN.edge);
      const from = refNode(`${p}.from`, e.from), to = refNode(`${p}.to`, e.to);
      if (!from || !to) return;
      if (from === to) { rep.warn(p, `links "${from}" to itself; dropped`); return; }
      const a = byId.get(from), b = byId.get(to);
      let twoWay = true;
      if (typeof e.twoWay === 'boolean') twoWay = e.twoWay;
      else if (!missing(e.twoWay)) {
        twoWay = !(e.twoWay === 0 || ['false', 'no', '0'].includes(String(e.twoWay).toLowerCase().trim()));
        rep.warn(`${p}.twoWay`, `${show(e.twoWay)} is not true or false; using ${twoWay}`);
      }
      const key = `${from}>${to}`, rev = `${to}>${from}`;
      const clash = links.get(key) ?? ((twoWay || links.get(rev)?.twoWay) ? links.get(rev) : undefined);
      if (clash) rep.warn(p, `connects the same nodes as ${clash.path}; links are identified as from>to, so add an intermediate node`);
      else links.set(key, { path: p, twoWay });
      const via = viaPoints(rep, `${p}.via`, e.via);
      const shapeLength = via.length ? polylineLength([a, ...via, b]) : Math.hypot(a.x - b.x, a.y - b.y);
      edgePaths.push(p);
      spec.edges.push({
        from, to,
        name: text(rep, `${p}.name`, e.name, 40) || `${a.name} – ${b.name}`,
        length: number(rep, `${p}.length`, e.length, shapeLength / 2, 0.2, 180),
        capacity: number(rep, `${p}.capacity`, e.capacity, 100, 1, 10000, true),
        twoWay,
        costModel: choice(rep, `${p}.costModel`, e.costModel, COST_MODELS, 'bpr'),
        via
      });
    });
    if (!spec.edges.length) rep.fail('edges', 'A route world needs edges (roads or paths) connecting its nodes.');
    if (!spec.nodes.some(n => n.kind === 'origin')) rep.fail('nodes', 'A route world needs at least one origin node.');
    if (!spec.nodes.some(n => n.kind === 'destination')) rep.fail('nodes', 'A route world needs at least one destination node.');
  }

  // ----- archetypes -----
  let rawA = raw.archetypes;
  if (!missing(rawA) && !Array.isArray(rawA)) rep.warn('archetypes', `${show(rawA)} is not a list; ignored`);
  if (!Array.isArray(rawA) || !rawA.length) {
    rep.warn('archetypes', 'missing; using one group "Everyone"');
    rawA = [{ id: 'everyone', name: 'Everyone', share: 1 }];
  }
  const origins = spec.nodes.filter(n => n.kind === 'origin').map(n => n.id);
  const dests = spec.nodes.filter(n => n.kind === 'destination').map(n => n.id);
  const pickNodes = (path, v, kind, fallback) => {
    if (!route) {
      if (Array.isArray(v) ? v.length : !missing(v)) rep.warn(path, 'ignored in visit mode');
      return [];
    }
    if (missing(v)) return fallback;
    if (!Array.isArray(v)) { rep.warn(path, `${show(v)} is not a list; using every ${kind}`); return fallback; }
    const out = [];
    v.forEach((r, j) => {
      const id = refNode(`${path}[${j}]`, r);
      if (!id) return;
      const node = byId.get(id);
      if (node.kind !== kind) { rep.warn(`${path}[${j}]`, `"${id}" is ${article(node.kind)}, not ${article(kind)}; ignored`); return; }
      if (!out.includes(id)) out.push(id);
    });
    if (!out.length && v.length) rep.warn(path, `no usable ${kind} listed; using every ${kind}`);
    return out.length ? out : fallback;
  };
  // Visit mode: the gates or entries where this group appears (`entries`, [] means every entry, by weight)
  // and the gates or exits it leaves through (`exits`, [] means every exit). Unlike other references,
  // an unknown one is only a warning.
  const pickGates = (path, v, side) => {
    const [kind, every] = side === 'entry' ? ['gate or entry', 'every entry'] : ['gate or exit', 'every exit'];
    if (route) {
      if (Array.isArray(v) ? v.length : !missing(v)) rep.warn(path, 'ignored in route mode');
      return [];
    }
    if (missing(v)) return [];
    if (!Array.isArray(v)) { rep.warn(path, `${show(v)} is not a list; using ${every}`); return []; }
    const out = [];
    v.forEach((r, j) => {
      const id = resolveNode(r);
      if (!id) { rep.warn(`${path}[${j}]`, `${show(r)} is not a node id or name; ignored`); return; }
      const node = byId.get(id);
      if (node.kind !== 'gate' && node.kind !== side) { rep.warn(`${path}[${j}]`, `"${id}" is ${article(node.kind)}, not a ${kind}; ignored`); return; }
      if (!out.includes(id)) out.push(id);
    });
    if (!out.length && v.length) rep.warn(path, `no usable ${kind} listed; using ${every}`);
    return out;
  };
  const aids = new Set(), archPath = new Map();
  list(rep, 'archetypes', rawA, MAX.archetypes).forEach((a, i) => {
    const p = `archetypes[${i}]`;
    if (!isObj(a)) { rep.warn(p, 'not an object; ignored'); return; }
    unknownFields(rep, p, a, KNOWN.archetype);
    let w = a.weights;
    if (missing(w)) w = {};
    else if (!isObj(w)) { visitOnly.warn(`${p}.weights`, `${show(w)} is not an object; using defaults`); w = {}; }
    unknownFields(visitOnly, `${p}.weights`, w, KNOWN.weights);
    const id = uniqueId(rep, p, a, i, aids);
    archPath.set(id, p);
    spec.archetypes.push({
      id, name: text(rep, `${p}.name`, a.name, 40) || 'Group ' + (i + 1),
      description: text(rep, `${p}.description`, a.description, 200),
      share: number(rep, `${p}.share`, a.share, 1, 0.001, Infinity),
      weights: {
        appeal: number(visitOnly, `${p}.weights.appeal`, w.appeal, 1, 0, 5),
        wait: number(visitOnly, `${p}.weights.wait`, w.wait, 1, 0, 5),
        distance: number(visitOnly, `${p}.weights.distance`, w.distance, 1, 0, 5),
        price: number(visitOnly, `${p}.weights.price`, w.price, 0.5, 0, 5)
      },
      visits: number(visitOnly, `${p}.visits`, a.visits, 3, 1, 30, true),
      patience: number(visitOnly, `${p}.patience`, a.patience, 45, 1, 1440),
      info: number(rep, `${p}.info`, a.info, 0.5, 0, 1),
      rationality: number(rep, `${p}.rationality`, a.rationality, route ? 0.8 : 2.5, 0.05, 10),
      likes: tags(visitOnly, `${p}.likes`, a.likes), needs: tags(visitOnly, `${p}.needs`, a.needs),
      origins: pickNodes(`${p}.origins`, a.origins, 'origin', origins),
      destinations: pickNodes(`${p}.destinations`, a.destinations, 'destination', dests),
      entries: pickGates(`${p}.entries`, a.entries, 'entry'),
      exits: pickGates(`${p}.exits`, a.exits, 'exit')
    });
  });
  if (!spec.archetypes.length) { rep.fail('archetypes', 'The world needs at least one archetype.'); return null; }
  const tot = spec.archetypes.reduce((s, a) => s + a.share, 0);
  spec.archetypes.forEach(a => { a.share = a.share / tot; });

  // ----- minds: the cast. Each agent gets one persona and keeps its own state. -----
  const archRef = new Map();
  for (const a of spec.archetypes) archRef.set(a.id, a);
  for (const a of spec.archetypes) for (const k of [a.name, slug(a.name, 0)]) if (!archRef.has(k)) archRef.set(k, a);
  const mindNode = (path, v, kinds, active) => {
    if (missing(v)) return '';
    if (!active) { rep.warn(path, `ignored in ${mode} mode`); return ''; }
    const id = refNode(path, v);
    if (!id) return '';
    const node = byId.get(id);
    if (!kinds.includes(node.kind)) { rep.warn(path, `"${id}" is ${article(node.kind)}, not ${kinds.map(article).join(' or ')}; ignored`); return ''; }
    return id;
  };
  const mids = new Set();
  const rawMinds = list(rep, 'minds', raw.minds, MAX.minds);
  rawMinds.forEach((m, i) => {
    const p = `minds[${i}]`;
    if (!isObj(m)) { rep.warn(p, 'not an object; ignored'); return; }
    unknownFields(rep, p, m, KNOWN.mind);
    const roundRobin = spec.archetypes[i % spec.archetypes.length];
    let arch;
    if (missing(m.archetype)) {
      arch = roundRobin;
      if (spec.archetypes.length > 1) rep.warn(`${p}.archetype`, `missing; assigned to "${arch.id}"`);
    } else {
      arch = archRef.get(String(m.archetype)) || archRef.get(slug(m.archetype, 0));
      if (!arch) { arch = roundRobin; rep.warn(`${p}.archetype`, `${show(m.archetype)} is not an archetype id or name; using "${arch.id}"`); }
    }
    const id = uniqueId(rep, p, m, i, mids);
    spec.minds.push({
      id, name: text(rep, `${p}.name`, m.name, 40) || 'Person ' + (i + 1),
      age: missing(m.age) ? null : number(rep, `${p}.age`, m.age, 30, 0, 110, true),
      archetype: arch.id,
      bio: text(rep, `${p}.bio`, m.bio, 240), personality: text(rep, `${p}.personality`, m.personality, 160),
      goal: text(rep, `${p}.goal`, m.goal, 160), social: text(rep, `${p}.social`, m.social, 160),
      informed: missing(m.informed) ? arch.info >= 0.5 : truthy(m.informed),
      weight: number(rep, `${p}.weight`, m.weight, 1, 0.05, 20),
      entry: mindNode(`${p}.entry`, m.entry, ['gate', 'entry'], !route),
      origin: mindNode(`${p}.origin`, m.origin, ['origin'], route),
      destination: mindNode(`${p}.destination`, m.destination, ['destination'], route)
    });
  });
  if (!spec.minds.length) {
    rep.warn('minds', 'no cast; using one generic persona per archetype (write 10–20 people for real decisions)');
    spec.archetypes.forEach(a => spec.minds.push({
      id: a.id, name: a.name, age: null, archetype: a.id, bio: a.description, personality: '', goal: '', social: '',
      informed: a.info >= 0.5, weight: 1, entry: '', origin: '', destination: ''
    }));
  } else {
    for (const a of spec.archetypes) {
      if (!spec.minds.some(m => m.archetype === a.id)) rep.warn(archPath.get(a.id), `no cast member belongs to "${a.id}"; this group gets no agents`);
    }
  }

  checkReach(spec, rep, nodePath, archPath);
  const { wallIndex, doorPaths } = buildingFields(raw, spec, rep);
  const wallName = k => `walls[${wallIndex[k] ?? k}]`;
  checkWalls(spec, rep, { nodePath, edgePaths, wallName });
  checkDoors(spec, rep, { doorPaths, wallName });
  return spec;
}

// walls, geo, doors and provenance (§13a, §14d). Returns the input index of every kept wall and the
// input path of every kept door, for messages.
function buildingFields(raw, spec, rep) {
  let rawWalls = missing(raw.walls) ? null : raw.walls;
  if (Array.isArray(rawWalls) && rawWalls.length > MAX.walls) {
    rep.fail('walls', `The world has ${rawWalls.length} walls, above the maximum ${MAX.walls}; simplify the walls or model one floor at a time.`);
    rawWalls = rawWalls.slice(0, MAX.walls);
  }
  const { walls, warnings } = normalizeWalls(rawWalls);
  for (const w of warnings) rep.note(w);
  spec.walls = walls;
  const wallIndex = inputIndexes(rawWalls, walls);

  if (!missing(raw.geo)) {
    const g = raw.geo;
    if (!isObj(g)) rep.warn('geo', `${show(g)} is not an object; ignored`);
    else {
      unknownFields(rep, 'geo', g, KNOWN.geo);
      let metersPerUnit = null, floor = null;
      if (isNum(g.metersPerUnit)) metersPerUnit = number(rep, 'geo.metersPerUnit', g.metersPerUnit, 1, 0.001, 10000);
      else if (!missing(g.metersPerUnit)) rep.warn('geo.metersPerUnit', `${show(g.metersPerUnit)} is not a number; ignored`);
      if (typeof g.floor === 'number' && Number.isFinite(g.floor)) floor = g.floor;
      else if (typeof g.floor === 'string' && g.floor.trim()) floor = text(rep, 'geo.floor', g.floor, 40);
      else if (!missing(g.floor)) rep.warn('geo.floor', `${show(g.floor)} is not a floor number or label; ignored`);
      spec.geo = {
        metersPerUnit,
        clearance: number(rep, 'geo.clearance', g.clearance, DEFAULT_CLEARANCE, 0.02, 1),
        floor,
        source: text(rep, 'geo.source', g.source, 80)
      };
    }
  }

  const dids = new Set(), doorPaths = [], XY = ['x1', 'y1', 'x2', 'y2'];
  list(rep, 'doors', raw.doors, MAX.doors).forEach((d, i) => {
    const p = `doors[${i}]`;
    if (!isObj(d)) { rep.warn(p, 'not an object; ignored'); return; }
    unknownFields(rep, p, d, KNOWN.door);
    const bad = XY.find(k => !isNum(d[k]));
    if (bad) { rep.warn(`${p}.${bad}`, `${missing(d[bad]) ? 'missing' : `${show(d[bad])} is not a number`}; door dropped`); return; }
    const [x1, y1, x2, y2] = XY.map(k => number(rep, `${p}.${k}`, d[k], 50, 0, 100));
    if (Math.hypot(x2 - x1, y2 - y1) <= 1e-9) { rep.warn(p, 'zero length; dropped'); return; }
    const id = uniqueId(rep, p, d, i, dids);
    let exterior = false;
    if (typeof d.exterior === 'boolean') exterior = d.exterior;
    else if (!missing(d.exterior)) {
      exterior = truthy(d.exterior);
      rep.warn(`${p}.exterior`, `${show(d.exterior)} is not true or false; using ${exterior}`);
    }
    doorPaths.push(p);
    spec.doors.push({ id, name: text(rep, `${p}.name`, d.name, 40) || id, x1, y1, x2, y2, exterior });
  });

  if (!missing(raw.provenance)) {
    const pv = raw.provenance;
    if (!isObj(pv)) rep.warn('provenance', `${show(pv)} is not an object; ignored`);
    else {
      const keys = Object.keys(pv);
      if (keys.length > MAX.provenance) rep.warn('provenance', `${keys.length} keys; only the first ${MAX.provenance} are kept`);
      const kept = {}, odd = [];
      for (const k of keys.slice(0, MAX.provenance)) {
        const value = jsonCopy(pv[k]);
        if (value === undefined) { rep.warn(`provenance.${k}`, 'not JSON; dropped'); continue; }
        // defineProperty keeps a "__proto__" key as plain data.
        Object.defineProperty(kept, k, { value, enumerable: true, writable: true, configurable: true });
        if (!PROVENANCE_LABELS.includes(value)) odd.push(k);
      }
      if (odd.length) {
        const n = odd.length;
        rep.warn('provenance', `${n} value${n === 1 ? ' is' : 's are'} not one of ${PROVENANCE_LABELS.join(', ')} ` +
          `(first: ${show(odd[0])} is ${show(kept[odd[0]])}); kept as-is`);
      }
      if (Object.keys(kept).length) spec.provenance = kept;
    }
  }
  return { wallIndex, doorPaths };
}

// §13a: nobody may be placed on, or routed through, a wall, and every place must be reachable on foot.
// All of these are fatal: the engine guarantees that no movement crosses a wall. Path searches on a big
// floor take a while and every Sim normalizes its spec, so results are cached by the geometry they read.
const wallChecks = new Map();
const WALL_CHECK_CACHE = 16;

function checkWalls(spec, rep, { nodePath, edgePaths, wallName }) {
  if (!spec.walls.length) return;
  const nodeAt = n => nodePath.get(n.id) ?? `nodes.${n.id}`;
  const key = sha256Hex(JSON.stringify([
    spec.mode, spec.geo?.clearance ?? DEFAULT_CLEARANCE,
    spec.walls.map((w, k) => [w.x1, w.y1, w.x2, w.y2, wallName(k)]),
    spec.nodes.map(n => [n.id, n.name, n.kind, n.x, n.y, nodeAt(n)]),
    spec.mode === 'route' ? spec.edges.map((e, i) => [e.from, e.to, e.name, e.via, edgePaths[i]]) : []
  ]));
  let problems = wallChecks.get(key);
  if (!problems) {
    problems = wallProblems(spec, nodeAt, edgePaths, wallName);
    if (wallChecks.size >= WALL_CHECK_CACHE) wallChecks.delete(wallChecks.keys().next().value);
    wallChecks.set(key, problems);
  }
  for (const [path, msg] of problems) rep.fail(path, msg);
}

// → [[path, message]] for every §13a wall rule the spec breaks.
function wallProblems(spec, nodeAt, edgePaths, wallName) {
  const walls = spec.walls, out = [];
  const onWall = new Set();
  for (const n of spec.nodes) {
    const near = nearestWall(walls, n.x, n.y);
    if (near.dist >= MIN_WALL_GAP - 1e-9) continue; // tolerance: 50.05 - 50 is 0.04999999999999716
    onWall.add(n.id);
    out.push([nodeAt(n), `"${n.name}" at (${fmt(n.x)}, ${fmt(n.y)}) is ${fmt(near.dist)} units from ${wallName(near.wall)}; ` +
      `every node must be at least ${MIN_WALL_GAP} from every wall`]);
  }

  if (spec.mode === 'route') {
    const byId = new Map(spec.nodes.map(n => [n.id, n]));
    spec.edges.forEach((e, i) => {
      const a = byId.get(e.from), b = byId.get(e.to);
      const points = [{ x: a.x, y: a.y }, ...e.via, { x: b.x, y: b.y }];
      const hit = polylineCrossesWall(walls, points);
      if (!hit) return;
      const piece = points.length > 2 ? ` on piece ${hit.piece + 1} of ${points.length - 1}` : '';
      out.push([edgePaths[i], `edge "${e.name}" (${e.from} > ${e.to}) touches ${wallName(hit.wall)}${piece}; ` +
        'add via points that pass through a gap in the walls']);
    });
    return out;
  }

  // Visit mode. Nodes already reported as on a wall are left out, so one bad node gives one error.
  // Walking reachability is symmetric and transitive, so nodes are grouped into connected components:
  // each place only needs a path to the nearest node of a component that holds an entry (or an exit),
  // and a component that failed once for a place is not searched again for it.
  const nav = createNav(walls, { clearance: spec.geo?.clearance ?? DEFAULT_CLEARANCE });
  const usable = spec.nodes.filter(n => !onWall.has(n.id));
  const isEntry = n => n.kind === 'gate' || n.kind === 'entry';
  const isExit = n => n.kind === 'gate' || n.kind === 'exit';
  const anyEntry = usable.some(isEntry), anyExit = usable.some(isExit);
  const parent = new Map(), entryIn = new Map(), exitIn = new Map();
  const find = id => { while (parent.get(id) !== id) id = parent.get(id); return id; };
  const join = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    parent.set(rb, ra);
    entryIn.set(ra, entryIn.get(ra) || entryIn.get(rb));
    exitIn.set(ra, exitIn.get(ra) || exitIn.get(rb));
  };
  const placed = [];
  for (const n of usable) {
    if (n.kind === 'service') continue;
    parent.set(n.id, n.id); entryIn.set(n.id, isEntry(n)); exitIn.set(n.id, isExit(n));
    placed.push(n);
  }
  for (const s of usable) {
    if (s.kind !== 'service') continue;
    parent.set(s.id, s.id); entryIn.set(s.id, false); exitIn.set(s.id, false);
    const failed = [];
    const needs = () => (anyEntry && !entryIn.get(find(s.id))) || (anyExit && !exitIn.get(find(s.id)));
    const helps = t => {
      const r = find(t.id);
      if (r === find(s.id) || failed.some(f => find(f) === r)) return false;
      return (anyEntry && !entryIn.get(find(s.id)) && entryIn.get(r)) || (anyExit && !exitIn.get(find(s.id)) && exitIn.get(r));
    };
    const byDistance = placed.slice().sort((a, b) => Math.hypot(a.x - s.x, a.y - s.y) - Math.hypot(b.x - s.x, b.y - s.y));
    for (const t of byDistance) {
      if (!needs()) break;
      if (!helps(t)) continue;
      // Searching from the place proves a sealed room unreachable after exploring just that room.
      if (nav.path(s.x, s.y, t.x, t.y)) join(t.id, s.id);
      else failed.push(t.id);
    }
    if (anyEntry && !entryIn.get(find(s.id))) {
      out.push([nodeAt(s), `"${s.name}" cannot be reached on foot from any gate or entry; leave a doorway in the walls between them`]);
    }
    // A world without any gate or exit lets people vanish when done, so there is no exit to reach.
    if (anyExit && !exitIn.get(find(s.id))) {
      out.push([nodeAt(s), `"${s.name}" has no walking path to any gate or exit; leave a doorway in the walls between them`]);
    }
    placed.push(s);
  }
  return out;
}

// Doors are warnings only: a door should sit in a gap between walls, with walls touching at most its ends.
function checkDoors(spec, rep, { doorPaths, wallName }) {
  const walls = spec.walls;
  if (!walls.length) return;
  spec.doors.forEach((d, i) => {
    const dx = d.x2 - d.x1, dy = d.y2 - d.y1;
    const t = Math.min(DOOR_END_SLACK, Math.hypot(dx, dy) / 4) / Math.hypot(dx, dy);
    const hit = crossesWall(walls, d.x1 + dx * t, d.y1 + dy * t, d.x2 - dx * t, d.y2 - dy * t);
    if (hit >= 0) {
      rep.warn(doorPaths[i], `door "${d.name}" touches ${wallName(hit)}; a door should sit in a gap between walls`);
      return;
    }
    const near = Math.min(nearestWall(walls, d.x1, d.y1).dist, nearestWall(walls, d.x2, d.y2).dist);
    if (near > DOOR_NEAR_WALL) {
      rep.warn(doorPaths[i], `door "${d.name}" is not in a gap between walls (nearest wall ${fmt(near)} units from its ends); ` +
        'it still counts people who walk across it');
    }
  });
}

// Warnings for places nobody can choose (visit) and trips that cannot be made (route).
function checkReach(spec, rep, nodePath, archPath) {
  if (spec.mode === 'visit') {
    const services = spec.nodes.filter(n => n.kind === 'service');
    const canUse = (a, n) => !a.needs.length || n.tags.some(t => a.needs.includes(t));
    for (const a of spec.archetypes) {
      if (a.needs.length && services.length && !services.some(n => canUse(a, n))) {
        rep.warn(`${archPath.get(a.id)}.needs`, `no service node has any of the tags ${a.needs.join(', ')}; this group can go nowhere`);
      }
    }
    for (const n of services) {
      if (!spec.archetypes.some(a => canUse(a, n))) {
        rep.warn(nodePath.get(n.id) ?? `nodes.${n.id}`, `"${n.name}" matches no archetype's needs (tags: ${n.tags.join(', ') || 'none'}); nobody can choose it`);
      }
    }
    return;
  }
  const adj = new Map(spec.nodes.map(n => [n.id, []]));
  for (const e of spec.edges) { adj.get(e.from).push(e.to); if (e.twoWay) adj.get(e.to).push(e.from); }
  const reachable = from => {
    const seen = new Set([from]), stack = [from];
    while (stack.length) for (const next of adj.get(stack.pop()) ?? []) if (!seen.has(next)) { seen.add(next); stack.push(next); }
    return seen;
  };
  const cache = new Map();
  const reach = from => { if (!cache.has(from)) cache.set(from, reachable(from)); return cache.get(from); };
  for (const a of spec.archetypes) {
    const broken = [];
    for (const o of a.origins) for (const d of a.destinations) if (!reach(o).has(d)) broken.push(`${o} → ${d}`);
    if (broken.length) {
      const shown = broken.slice(0, 4).join(', ') + (broken.length > 4 ? `, and ${broken.length - 4} more` : '');
      rep.warn(archPath.get(a.id), `no path for ${shown}; those trips cannot be made`);
    }
  }
}

// ---------- public API ----------

// Lenient: clamps and fills defaults, drops unknown references, throws only on fatal problems.
export function normalizeSpec(raw) {
  const rep = new Report();
  const spec = build(raw, rep);
  if (rep.fatal.length) throw new Error(rep.fatal[0]);
  return spec;
}

// { ok, errors, warnings, spec }. Errors are fatal; warnings are fixes normalizeSpec makes silently.
export function validateWorld(raw) {
  const rep = new Report();
  let spec = null;
  try {
    spec = build(raw, rep);
  } catch (err) {
    rep.errors.push(`spec: could not be read (${err.message})`);
  }
  const ok = rep.errors.length === 0 && !!spec;
  return { ok, errors: rep.errors, warnings: rep.warnings, spec: ok ? spec : null };
}

// Strip fields that do not apply to the world's mode, for display, hashing and Claude. Takes a normalized spec.
// Building fields (walls, geo, doors, provenance, edges[].via, archetypes[].entries and .exits) appear only when set,
// so a world without them cleans, and hashes, exactly as before they existed.
export function cleanSpec(spec) {
  const route = spec.mode === 'route';
  const walls = spec.walls ?? [], doors = spec.doors ?? [];
  // With walls, positions stay exact: rounding could move a node onto or past a wall.
  const xy = walls.length ? v => v : v => +v.toFixed(1);
  return {
    title: spec.title, question: spec.question, context: spec.context, ...(route ? {} : { leaveLabel: spec.leaveLabel }),
    mode: spec.mode, duration: spec.duration,
    clockStart: spec.clockStart, ...(route ? {} : { travelSpeed: spec.travelSpeed }), arrivals: spec.arrivals,
    nodes: spec.nodes.map(n => route
      ? { id: n.id, name: n.name, kind: n.kind, x: xy(n.x), y: xy(n.y) }
      : n.kind === 'service'
        ? {
          id: n.id, name: n.name, kind: n.kind, x: xy(n.x), y: xy(n.y), servers: n.servers, serviceTime: n.serviceTime,
          serviceDist: n.serviceDist, appeal: n.appeal, price: n.price, tags: n.tags, about: n.about
        }
        : { id: n.id, name: n.name, kind: n.kind, x: xy(n.x), y: xy(n.y), weight: n.weight }),
    ...(route ? {
      edges: spec.edges.map(e => ({
        from: e.from, to: e.to, name: e.name, length: e.length, capacity: e.capacity, twoWay: e.twoWay, costModel: e.costModel,
        ...(e.via?.length ? { via: e.via.map(p => ({ x: p.x, y: p.y })) } : {})
      }))
    } : {}),
    archetypes: spec.archetypes.map(a => {
      const o = { id: a.id, name: a.name, share: +a.share.toFixed(3), description: a.description, info: a.info, rationality: a.rationality };
      if (route) { o.origins = a.origins; o.destinations = a.destinations; }
      else {
        Object.assign(o, { weights: a.weights, visits: a.visits, patience: a.patience, likes: a.likes, needs: a.needs });
        if (a.entries?.length) o.entries = a.entries;
        if (a.exits?.length) o.exits = a.exits;
      }
      return o;
    }),
    minds: spec.minds.map(m => {
      const o = { id: m.id, name: m.name, age: m.age, archetype: m.archetype, bio: m.bio, personality: m.personality, goal: m.goal, social: m.social, informed: m.informed };
      if (m.weight !== 1) o.weight = m.weight;
      if (route) { if (m.origin) o.origin = m.origin; if (m.destination) o.destination = m.destination; }
      else if (m.entry) o.entry = m.entry;
      return o;
    }),
    ...(walls.length ? {
      walls: walls.map(w => {
        const o = { x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 };
        if (w.source) o.source = w.source;
        return o;
      })
    } : {}),
    ...(spec.geo ? {
      geo: { metersPerUnit: spec.geo.metersPerUnit, clearance: spec.geo.clearance, floor: spec.geo.floor, source: spec.geo.source }
    } : {}),
    ...(doors.length ? {
      doors: doors.map(d => ({ id: d.id, name: d.name, x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2, exterior: d.exterior }))
    } : {}),
    ...(spec.provenance && Object.keys(spec.provenance).length ? { provenance: spec.provenance } : {})
  };
}

// What-if levers. serviceDist and costModel are deliberately not patchable. A node's weight applies
// to visit gates and entries only.
export const PATCH_FIELDS = {
  node: ['servers', 'serviceTime', 'appeal', 'price', 'weight'],
  edge: ['capacity', 'length', 'closed'],
  archetype: ['info', 'patience', 'rationality', 'visits', 'share'],
  global: ['arrivals.total', 'arrivals.start', 'arrivals.end', 'travelSpeed']
};

// Applies [{ kind, id, field, value }] to a normalized spec. Returns { spec, applied: string[], skipped: op[] }.
export function applyPatch(spec, patch) {
  const s = JSON.parse(JSON.stringify(cleanSpec(spec)));
  const applied = [], skipped = [];
  for (const op of (Array.isArray(patch) ? patch : [])) {
    const kind = String(op?.kind || ''), field = String(op?.field || ''), id = String(op?.id ?? '');
    const value = typeof op?.value === 'number' || typeof op?.value === 'string' ? Number(op.value) : NaN;
    if (!PATCH_FIELDS[kind]?.includes(field) || !Number.isFinite(value)) { skipped.push(op); continue; }
    if (kind === 'node') {
      const n = s.nodes.find(n => n.id === id || n.name === id);
      if (!n || (field === 'weight' && !('weight' in n))) { skipped.push(op); continue; }
      applied.push(`${n.name} · ${field} ${n[field]} → ${value}`); n[field] = value;
    } else if (kind === 'edge') {
      const i = (s.edges || []).findIndex(e => `${e.from}>${e.to}` === id || `${e.to}>${e.from}` === id || e.name === id);
      if (i < 0) { skipped.push(op); continue; }
      const e = s.edges[i];
      if (field === 'closed') {
        if (value >= 1) { s.edges.splice(i, 1); applied.push(`${e.name} · closed`); }
        else skipped.push(op);
      } else { applied.push(`${e.name} · ${field} ${e[field]} → ${value}`); e[field] = value; }
    } else if (kind === 'archetype') {
      const a = s.archetypes.find(a => a.id === id || a.name === id);
      if (!a) { skipped.push(op); continue; }
      applied.push(`${a.name} · ${field} ${a[field]} → ${value}`); a[field] = value;
    } else if (field.startsWith('arrivals.')) {
      const k = field.split('.')[1];
      applied.push(`Arrivals · ${k} ${s.arrivals[k]} → ${value}`); s.arrivals[k] = value;
    } else {
      applied.push(`${field} ${s[field]} → ${value}`); s[field] = value;
    }
  }
  return { spec: normalizeSpec(s), applied, skipped };
}

// First 12 hex characters of sha256 over the cleaned spec. Takes a normalized spec.
export function specHash(spec) {
  return sha256Hex(JSON.stringify(cleanSpec(spec))).slice(0, 12);
}
