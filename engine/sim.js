// Seeded tick simulation with the Jev decision protocol (docs/PROTOTYPE.md §3, §4, §7).
//
// Two modes share one class:
//   visit: agents arrive, choose places, queue, get served, maybe visit more places, then leave.
//   route: agents drive from an origin to a destination over a road network.
//
// With `external: false` every decision is made inline by the rule policy (the fast rules provider).
// With `external: true` each decision moment creates a JSON-safe DecisionRequest; the agent is frozen
// until the runner answers it through pending() / resolve(id, decision).
//
// Walls and doors (§13c, §14d): with `spec.walls`, visit agents walk wall-free paths from nav.path and
// route agents follow each edge's polyline; every movement polyline is checked and a touch throws
// WallViolation. With `spec.doors`, visit walking paths count crossings at each doorway.
// archetypes[].entries and .exits narrow where each group appears and which exits it leaves through.
//
// Offers and segments (§15a, §15b): an agent in an offer's audience, inside its window, sees the offer's
// text and pays the discounted price at its place (in what it is shown, in the rules utility and in what
// it spends). Every visit agent records what it spent and where it was served; metrics().segments
// reports outcomes per group and per cast member, and metrics().offers how far each offer reached.
import { seedRng, clamp, clockText, feelingWords } from './util.js';
import { normalizeSpec } from './spec.js';
import { sampleDecision } from './sample.js';
import { visitObservation, routeObservation, arriveObservation, selectHeard, remarkText } from './observe.js';
import { createNav, polylineCrossesWall, polylineLength, pointAlong } from './walls.js';

const STATE_CODE = { walk: 0, queue: 1, serve: 2, think: 3, leave: 4, drive: 5 };
const HEARD_WINDOW = 90;      // sim minutes of remarks an observation can draw on (observe filters further)
const SEE_RADIUS = 30;        // map units within which a line is visible without the app
const DEFAULT_LEAVE = 'Leave and go home';

const VISIT_REMARKS = name => [
  { key: 'long_line', label: `Warn about a long line or wait at ${name}` },
  { key: 'bad_service', label: `Complain about a bad experience at ${name}` },
  { key: 'good_experience', label: `Say ${name} was good and quick` }
];
const ROUTE_REMARKS = name => [
  { key: 'heavy_traffic', label: `Warn about heavy traffic on ${name}` },
  { key: 'clear_roads', label: `Say ${name} was clear` }
];

const edgeKey = e => `${e.from}>${e.to}`;
const round2 = x => Math.round(x * 100) / 100;
const positive = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const nonNegative = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
const DOOR_WINDOW = 5;        // minutes for a door's peak traffic
const SAME_HIT = 1e-6;        // two door hits this close along a path are one crossing (a path vertex on the door)
const DOOR_REACH = 0.3;       // a door end stopping this short of a wall (or the clearance, if larger) is carried on to it
const DOOR_OVERLAP = 0.02;    // ... and this far past it, the jamb tolerance of §14g
const NO_OFFERS = Object.freeze([]);
const TOP_PLACES = 3;         // places listed per segment

const wallObj = w => (Array.isArray(w) ? { x1: +w[0], y1: +w[1], x2: +w[2], y2: +w[3] } : w);
const childMap = (m, k) => { let c = m.get(k); if (!c) m.set(k, c = new Map()); return c; };
const xy = p => `(${p.x.toFixed(2)}, ${p.y.toFixed(2)})`;

function pointSegDist(px, py, w) {
  const dx = w.x2 - w.x1, dy = w.y2 - w.y1, len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((px - w.x1) * dx + (py - w.y1) * dy) / len2, 0, 1) : 0;
  return Math.hypot(w.x1 + t * dx - px, w.y1 + t * dy - py);
}

// Parameter in [0, 1] along A→B where the piece first meets door segment d (touching counts), or -1.
function doorHit(A, B, d) {
  const rx = B.x - A.x, ry = B.y - A.y, sx = d.x2 - d.x1, sy = d.y2 - d.y1;
  const qx = d.x1 - A.x, qy = d.y1 - A.y;
  const rl = Math.hypot(rx, ry), sl = Math.hypot(sx, sy);
  if (rl === 0 || sl === 0) return -1;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) > 1e-12 * rl * sl) {
    const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den, e = 1e-9;
    return t >= -e && t <= 1 + e && u >= -e && u <= 1 + e ? clamp(t, 0, 1) : -1;
  }
  if (Math.abs(qx * ry - qy * rx) > 1e-9 * rl) return -1;        // parallel, not on the same line
  const rr = rl * rl;
  const t0 = (qx * rx + qy * ry) / rr, t1 = ((d.x2 - A.x) * rx + (d.y2 - A.y) * ry) / rr;
  const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(1, Math.max(t0, t1));
  return lo <= hi + 1e-9 ? lo : -1;
}

// The segment a door counts crossings on: the door's own segment, with each end that stops short of a
// nearby wall carried on along the door's line to that distance plus DOOR_OVERLAP. Builders pull door
// ends in from the jambs so a door never touches a wall, but a walking path may round a jamb closer than
// that (nav keeps clear of wall ends only approximately), and such a walk still goes through the doorway.
// Walking paths never touch a wall, so the part of the segment that lies along a jamb is never crossed.
// An end already touching a wall, or with no wall within `reach`, is kept. Without walls nothing changes.
function doorGap(d, walls, reach) {
  const len = Math.hypot(d.x2 - d.x1, d.y2 - d.y1);
  const gap = { x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2 };
  if (!(len > 0) || !walls.length) return gap;
  const ux = (d.x2 - d.x1) / len, uy = (d.y2 - d.y1) / len;
  const carry = (x, y) => {
    let g = Infinity;
    for (const w of walls) g = Math.min(g, pointSegDist(x, y, w));
    return g > 1e-9 && g <= reach ? g + DOOR_OVERLAP : 0;
  };
  const e1 = carry(d.x1, d.y1), e2 = carry(d.x2, d.y2);
  gap.x1 -= ux * e1; gap.y1 -= uy * e1; gap.x2 += ux * e2; gap.y2 += uy * e2;
  return gap;
}

// Point and unit direction at distance d along a polyline (for the lane offset of route agents).
function alongWithDir(points, d) {
  let left = Math.max(0, d);
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1], len = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= len || i + 2 === points.length) {
      const t = len > 0 ? Math.min(1, left / len) : 0, k = len || 1;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, dx: (b.x - a.x) / k, dy: (b.y - a.y) / k };
    }
    left -= len;
  }
  const p = points[0];
  return { x: p.x, y: p.y, dx: 1, dy: 0 };
}

// Thrown when a movement the Sim creates would touch a wall. A completed run never has one.
export class WallViolation extends Error {
  constructor({ agentId, from, to, wall, piece, edgeId = null }) {
    super(`agent ${agentId} would move from ${xy(from)} to ${xy(to)}${edgeId ? ` along ${edgeId}` : ''} ` +
      `through wall ${wall} (piece ${piece} of its path)`);
    this.name = 'WallViolation';
    Object.assign(this, { agentId, from, to, wall, piece, edgeId });
  }
}

export class Sim {
  // new Sim(spec, opts). The prototype's new Sim(spec, seed, opts) form is also accepted.
  constructor(spec, opts = {}, legacyOpts = undefined) {
    if (typeof opts === 'number') opts = { ...(legacyOpts || {}), seed: opts };
    opts = opts || {};
    this.spec = normalizeSpec(spec);
    this.mode = this.spec.mode;
    const route = this.mode === 'route';
    const seed = opts.seed ?? 7;
    this.external = Boolean(opts.external);
    this.dt = positive(opts.dt, route ? 0.25 : 0.5);
    this.batchWindow = nonNegative(opts.batchWindow, route ? 0.5 : 1);
    this.frameEvery = positive(opts.frameEvery, Math.max(0.5, this.spec.duration / 360));
    this.maxTrace = Math.max(1, Math.round(positive(opts.maxTrace, 60)));
    this.opts = { seed, external: this.external, dt: this.dt, batchWindow: this.batchWindow, frameEvery: this.frameEvery };

    this.t = 0; this.tick = 0;
    this.nodes = this.spec.nodes.map((n, i) => ({
      ...n, idx: i, queue: [], busy: [], arrivals: 0, served: 0, abandoned: 0,
      waitSum: 0, waitN: 0, maxQueue: 0, busyTime: 0, walkLog: []
    }));
    this.byId = new Map(this.nodes.map(n => [n.id, n]));
    this.arch = this.spec.archetypes.map((a, i) => ({ ...a, idx: i, count: 0 }));
    this.agents = []; this.active = []; this.finished = 0;
    this.servedTotal = 0; this.abandonedTotal = 0; this.arrivedTotal = 0; this.lostTotal = 0;

    // decision protocol
    this.reqSeq = 0;
    this.held = [];                 // created, not yet released by pending()
    this.inflight = new Map();      // released, awaiting resolve(); id → { req, a, node, routes }
    this.decisionStats = { total: 0, byProvider: {}, byKind: {} };
    this.remarks = [];

    this.buildPersonas();
    this.schedule = this.buildSchedule(seedRng(seed, 'arrivals')); this.si = 0;

    // Walls: one navigator for the whole run. Without walls nothing below changes the prototype's behavior.
    this.walls = (Array.isArray(this.spec.walls) ? this.spec.walls : []).map(wallObj);
    this.nav = this.walls.length ? createNav(this.walls, { clearance: this.spec.geo?.clearance }) : null;
    this.wallStats = { checkedMoves: 0, violations: 0 };
    this.freeCache = new Map();
    // Doors count traffic in visit mode only (§14d).
    const doors = !route && Array.isArray(this.spec.doors) ? this.spec.doors : [];
    const doorReach = Math.max(DOOR_REACH, Number(this.spec.geo?.clearance) || 0);
    this.doorList = doors.map((d, i) => {
      const door = {
        id: d.id ?? `door${i + 1}`, name: d.name ?? d.id ?? `Door ${i + 1}`, exterior: Boolean(d.exterior),
        x1: +d.x1, y1: +d.y1, x2: +d.x2, y2: +d.y2, idx: i, crossings: 0, times: []
      };
      door.gap = doorGap(door, this.walls, doorReach);
      return door;
    });
    this.doorPending = [];          // { t, door } crossings scheduled for a time not yet reached
    // Targeted offers (§15b). `reached` and `went` hold agent ids. Without offers nothing changes.
    this.offers = (Array.isArray(this.spec.offers) ? this.spec.offers : []).map(o => ({
      ...o, groups: new Set(o.to.groups), cast: new Set(o.to.cast), everyone: !o.to.groups.length && !o.to.cast.length,
      reached: new Set(), went: new Set()
    }));
    // Walks follow cached polylines when walls or doors exist; otherwise the prototype's straight lines.
    this.pathMode = !route && Boolean(this.nav || this.doorList.length);
    this.paths = new Map();

    this.names = { place: new Map(this.nodes.map(n => [n.id, n.name])), edge: new Map() };
    this.placePos = new Map(this.nodes.map(n => [n.id, { x: n.x, y: n.y }]));
    if (route) {
      this.buildNetwork();
      for (const e of this.edges) this.names.edge.set(e.id, e.name);
    } else {
      this.services = this.nodes.filter(n => n.kind === 'service');
      this.entries = this.nodes.filter(n => n.kind === 'gate' || n.kind === 'entry');
      this.exits = this.nodes.filter(n => n.kind === 'gate' || n.kind === 'exit');
      this.entryW = this.entries.reduce((s, n) => s + n.weight, 0);
      // archetypes[].entries: where this group appears; default every entry, by weight.
      // archetypes[].exits: where this group leaves; default every exit (the same list object, so
      // leave() knows there is no narrower list to fall back from).
      for (const ar of this.arch) {
        const own = (Array.isArray(ar.entries) ? ar.entries : [])
          .map(id => this.byId.get(id)).filter(n => n && (n.kind === 'gate' || n.kind === 'entry'));
        ar.entryList = own.length ? own : this.entries;
        ar.entryW = own.length ? own.reduce((s, n) => s + n.weight, 0) : this.entryW;
        const out = (Array.isArray(ar.exits) ? ar.exits : [])
          .map(id => this.byId.get(id)).filter(n => n && (n.kind === 'gate' || n.kind === 'exit'));
        ar.exitList = out.length ? out : this.exits;
      }
    }

    this.frames = {
      mode: this.mode,
      nodes: this.nodes.map(n => ({ id: n.id, name: n.name, kind: n.kind, x: n.x, y: n.y })),
      edges: route ? this.edges.map(e => {
        const out = { id: e.id, name: e.name, from: e.from, to: e.to };
        if (e.via?.length) out.via = e.via.map(p => ({ x: round2(p.x), y: round2(p.y) }));
        return out;
      }) : [],
      services: route ? [] : this.services.map(n => n.id),
      walls: this.walls.map(w => [round2(w.x1), round2(w.y1), round2(w.x2), round2(w.y2)]),
      doors: this.doorList.map(d => ({
        id: d.id, name: d.name, x1: round2(d.x1), y1: round2(d.y1), x2: round2(d.x2), y2: round2(d.y2), exterior: d.exterior
      })),
      list: []
    };
    this.nextFrame = 0;
  }

  // ---------------- setup ----------------

  // Each cast member is weighted within its archetype; an archetype without cast members gets a
  // stand-in persona so its share of arrivals is not lost.
  buildPersonas() {
    const archMap = new Map(this.arch.map(a => [a.id, a]));
    this.personas = this.spec.minds.map((m, i) => ({ ...m, idx: i, arch: archMap.get(m.archetype) || this.arch[0] }));
    const ids = new Set(this.personas.map(p => p.id));
    for (const ar of this.arch) {
      if (this.personas.some(p => p.arch === ar)) continue;
      let id = ar.id;
      while (ids.has(id)) id += '_group';
      ids.add(id);
      this.personas.push({
        id, name: ar.name, age: null, archetype: ar.id, bio: ar.description, personality: '', goal: '', social: '',
        informed: ar.info >= 0.5, weight: 1, entry: '', origin: '', destination: '', idx: this.personas.length, arch: ar
      });
    }
    const perArch = new Map();
    for (const p of this.personas) perArch.set(p.arch, (perArch.get(p.arch) || 0) + p.weight);
    let c = 0;
    this.personaCum = this.personas.map(p => { c += p.arch.share * p.weight / perArch.get(p.arch); return c; });
    this.personaTot = c;
  }

  buildSchedule(rng) {
    const A = this.spec.arrivals, out = [];
    if (A.shape === 'poisson') {
      const span = Math.max(1e-6, A.end - A.start), rate = A.total / span;
      let t = A.start;
      for (let guard = 0; guard < A.total * 5 + 100; guard++) {
        t += -Math.log(1 - rng()) / rate;
        if (t >= A.end) break;
        out.push(t);
      }
      return out;
    }
    for (let i = 0; i < A.total; i++) {
      const x = rng();
      let u;
      if (A.shape === 'uniform') u = x;
      else if (A.shape === 'early') u = 1 - Math.sqrt(1 - x);
      else if (A.shape === 'late') u = Math.sqrt(x);
      else u = (x + rng()) / 2;
      out.push(A.start + u * (A.end - A.start));
    }
    return out.sort((a, b) => a - b);
  }

  clock(t) { return clockText(this.spec, t); }
  log(a, m) { if (a.trace.length < this.maxTrace) a.trace.push({ t: round2(this.t), m }); }
  tolerance(a) { return a.arch.patience * a.patienceMult; }

  // ---------------- network ----------------
  buildNetwork() {
    this.out = this.nodes.map(() => []); this.inc = this.nodes.map(() => []);
    this.edges = this.spec.edges.map((e, i) => ({
      ...e, id: edgeKey(e), idx: i, a: this.byId.get(e.from), b: this.byId.get(e.to),
      linear: e.costModel === 'linear', trav: 0, ttSum: 0, ffSum: 0, peak: 0, links: []
    }));
    // A link's shape is its polyline: from → via… → to (reversed for the back direction of a two-way edge).
    const add = (e, a, b) => {
      const via = (Array.isArray(e.via) ? e.via : []).map(p => ({ x: +p.x, y: +p.y }));
      const points = [{ x: a.x, y: a.y }, ...(a === e.a ? via : via.reverse()), { x: b.x, y: b.y }];
      const L = {
        edge: e, from: a.idx, to: b.idx, length: e.length, capacity: e.capacity, load: 0,
        points, shapeLen: polylineLength(points), wallCheck: undefined
      };
      this.out[a.idx].push(L); this.inc[b.idx].push(L); e.links.push(L);
    };
    for (const e of this.edges) { add(e, e.a, e.b); if (e.twoWay) add(e, e.b, e.a); }
    this.h = new Map(); this.optCache = new Map();
    for (const dn of this.nodes.filter(n => n.kind === 'destination')) {
      const d = dn.idx, n = this.nodes.length;
      const dist = new Array(n).fill(Infinity), seen = new Array(n).fill(false);
      dist[d] = 0;
      for (let k = 0; k < n; k++) {
        let u = -1;
        for (let i = 0; i < n; i++) if (!seen[i] && (u < 0 || dist[i] < dist[u])) u = i;
        if (u < 0 || dist[u] === Infinity) break;
        seen[u] = true;
        for (const L of this.inc[u]) if (dist[u] + L.length < dist[L.from]) dist[L.from] = dist[u] + L.length;
      }
      this.h.set(d, dist);
    }
  }

  dijkstraPath(o, d, w) {
    const n = this.nodes.length, dist = new Array(n).fill(Infinity), prev = new Array(n).fill(null), seen = new Array(n).fill(false);
    dist[o] = 0;
    for (let k = 0; k < n; k++) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!seen[i] && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0 || dist[u] === Infinity) break;
      if (u === d) break;
      seen[u] = true;
      for (const L of this.out[u]) { const v = dist[u] + w(L); if (v < dist[L.to]) { dist[L.to] = v; prev[L.to] = L; } }
    }
    if (dist[d] === Infinity) return null;
    const path = [];
    let cur = d, guard = 0;
    while (cur !== o && guard++ < n + 2) { const L = prev[cur]; if (!L) return null; path.unshift(L); cur = L.from; }
    return path;
  }

  // Up to 3 distinct sensible paths: free-flow time within 1.6 × the best + 2 minutes.
  routeOptions(o, d) {
    const key = o + '>' + d;
    if (this.optCache.has(key)) return this.optCache.get(key);
    const pen = new Map(), out = [], seen = new Set();
    for (let it = 0; it < 7 && out.length < 3; it++) {
      const path = this.dijkstraPath(o, d, L => L.length * (pen.get(L.edge) || 1));
      if (!path) break;
      path.forEach(L => pen.set(L.edge, (pen.get(L.edge) || 1) * 1.8));
      const sig = path.map(L => L.edge.idx + ':' + L.from).join(',');
      if (seen.has(sig)) continue;
      seen.add(sig);
      const names = [];
      path.forEach(L => { if (names[names.length - 1] !== L.edge.name) names.push(L.edge.name); });
      out.push({ sig, links: path, label: names.join(' → '), ff: path.reduce((s, L) => s + L.length, 0) });
    }
    const best = Math.min(...out.map(x => x.ff));
    const res = out.filter(x => x.ff <= best * 1.6 + 2);
    this.optCache.set(key, res);
    return res;
  }

  // Travel time of a link at its current load: the BPR curve, or linear (length + load / capacity).
  tt(L) {
    if (L.edge.linear) return L.length + L.load / L.capacity;
    const r = Math.min(3, L.load / L.capacity);
    return L.length * (1 + 0.15 * r * r * r * r);
  }
  pathNow(links) { return links.reduce((s, L) => s + this.tt(L), 0); }
  edgeRatio(e) { return Math.max(0, ...e.links.map(L => L.load / L.capacity)); }

  // ---------------- spawning ----------------
  // Agent stream order at spawn: persona pick, entry (or origin/destination) pick, informed, jit.
  spawn(id) {
    const rng = seedRng(this.opts.seed, 'agent', id);
    const r = rng() * this.personaTot;
    let pi = this.personaCum.findIndex(c => r <= c);
    if (pi < 0) pi = this.personas.length - 1;
    const P = this.personas[pi], arch = P.arch;
    const a = {
      id, persona: P, arch, rng, state: 'new', born: this.t, trace: [], waitTotal: 0, served: 0, abandons: 0,
      decisions: 0, decisionCount: 0, frustration: null, patienceMult: 1, req: null, tDone: null
    };
    if (this.mode === 'visit') {
      const u1 = rng(), u2 = rng();
      let entry = P.entry && u1 < 0.5 ? this.byId.get(P.entry) : null;
      if (!entry) {
        const list = arch.entryList;
        let w = u2 * arch.entryW; entry = list[0];
        for (const n of list) { w -= n.weight; if (w <= 0) { entry = n; break; } }
      }
      a.informed = rng() < arch.info; a.jit = rng();
      Object.assign(a, {
        x: entry.x, y: entry.y, visited: new Set(), visitsLeft: arch.visits, lastPlace: entry.name, placesDone: [],
        spent: 0, servedAt: [], quote: null
      });
      arch.count++; this.agents.push(a); this.active.push(a);
      this.log(a, `Arrived at ${entry.name}`);
      this.decide(a, 'start', null);
      return;
    }
    const u1 = rng(), u2 = rng();
    const reach = d => d && d !== o && Number.isFinite(this.h.get(d.idx)?.[o.idx]);
    const o = P.origin ? this.byId.get(P.origin) : this.byId.get(arch.origins[Math.floor(u1 * arch.origins.length)]);
    a.informed = rng() < arch.info; a.jit = rng();
    if (!o) return;
    let dl = (P.destination ? [P.destination] : arch.destinations).map(x => this.byId.get(x)).filter(reach);
    if (!dl.length) dl = arch.destinations.map(x => this.byId.get(x)).filter(reach);
    if (!dl.length) return;
    const d = dl[Math.floor(u2 * dl.length)];
    Object.assign(a, {
      node: o.idx, dest: d.idx, origin: o.idx, seen: new Set([o.idx]), hops: 0, ff: this.h.get(d.idx)[o.idx],
      x: o.x, y: o.y, plan: null, planI: 0, path: [], worst: null, tripStart: null
    });
    arch.count++; this.agents.push(a); this.active.push(a);
    this.noteOffers(a);
    this.log(a, `Left ${o.name} for ${d.name}`);
    const opts = this.routeOptions(o.idx, d.idx);
    if (this.external && opts.length > 1) return this.requestRoute(a, opts);
    this.depart(a);
  }

  // ---------------- visit mode ----------------
  estWait(n) { return n.busy.length < n.servers ? 0 : (n.queue.length + 1) * n.serviceTime / n.servers; }
  walkedAway30(n) {
    let k = 0;
    for (let i = n.walkLog.length - 1; i >= 0 && this.t - n.walkLog[i] <= 30; i--) k++;
    return k;
  }
  // A place with no wall-free path from where the agent stands is never a candidate.
  isCandidate(a, n) {
    if (!n || n.kind !== 'service' || a.visited.has(n.idx)) return false;
    const needs = a.arch.needs;
    if (needs.length && !n.tags.some(t => needs.includes(t))) return false;
    return !this.nav || this.walkDist(a.x, a.y, n.x, n.y) < Infinity;
  }
  candidates(a) { return this.services.filter(n => this.isCandidate(a, n)); }

  // ---------------- walking (walls and doors) ----------------
  // The walking path between two points, cached by endpoints: { length, points, doors: [{ door, s }] },
  // or null when walls leave no way through. Without walls the path is the straight segment.
  walkPath(x1, y1, x2, y2) {
    // Nested maps keyed by the coordinates themselves: no string keys on this hot path.
    const row = childMap(childMap(childMap(this.paths, x1), y1), x2);
    let p = row.get(y2);
    if (p !== undefined) return p;
    const found = this.nav ? this.nav.path(x1, y1, x2, y2) : { length: Math.hypot(x2 - x1, y2 - y1), points: [{ x: x1, y: y1 }, { x: x2, y: y2 }] };
    p = found ? { length: found.length, points: found.points, doors: this.doorHits(found.points), checked: false } : null;
    row.set(y2, p);
    return p;
  }

  // Walking distance (Infinity when unreachable). Without walls it is the prototype's straight-line distance.
  walkDist(x1, y1, x2, y2) {
    if (!this.nav) return Math.hypot(x2 - x1, y2 - y1);
    const p = this.walkPath(x1, y1, x2, y2);
    return p ? p.length : Infinity;
  }

  // Where a path meets each door, as distances along it, sorted. A path vertex that sits on a door
  // touches it from both pieces; those hits are merged into one crossing.
  doorHits(points) {
    const out = [];
    if (!this.doorList.length) return out;
    const per = this.doorList.map(() => []);
    let along = 0;
    for (let i = 0; i + 1 < points.length; i++) {
      const A = points[i], B = points[i + 1], len = Math.hypot(B.x - A.x, B.y - A.y);
      for (const d of this.doorList) {
        const u = doorHit(A, B, d.gap);
        if (u >= 0) per[d.idx].push(along + u * len);
      }
      along += len;
    }
    per.forEach((list, door) => {
      list.sort((p, q) => p - q);
      let last = -Infinity;
      for (const s of list) { if (s - last > SAME_HIT) out.push({ door, s }); last = s; }
    });
    return out.sort((p, q) => p.s - q.s || p.door - q.door);
  }

  // Every movement polyline is checked against the walls; a cached path is checked once, when first walked.
  checkPath(a, p) {
    if (!this.walls.length) return;
    this.wallStats.checkedMoves++;
    if (p.checked) return;
    const bad = polylineCrossesWall(this.walls, p.points);
    if (bad) this.violation(a, p.points[0], p.points[p.points.length - 1], bad);
    p.checked = true;
  }

  checkLink(a, L) {
    if (!this.walls.length) return;
    this.wallStats.checkedMoves++;
    if (L.wallCheck === undefined) L.wallCheck = polylineCrossesWall(this.walls, L.points);
    if (L.wallCheck) this.violation(a, L.points[0], L.points[L.points.length - 1], L.wallCheck, L.edge.id);
  }

  violation(a, from, to, bad, edgeId = null) {
    this.wallStats.violations++;
    throw new WallViolation({ agentId: a.id, from, to, wall: bad.wall, piece: bad.piece, edgeId });
  }

  // Starts a walk (state 'walk' or 'leave') from the agent's position to (x, y). Returns false when
  // walls leave no way there. Door crossings are scheduled for the moment the agent reaches each door.
  startWalk(a, x, y, state) {
    let p = null;
    if (this.pathMode) {
      p = this.walkPath(a.x, a.y, x, y);
      if (!p) return false;
      this.checkPath(a, p);
    }
    a.state = state; a.fx = a.x; a.fy = a.y; a.tx = x; a.ty = y; a.t0 = this.t; a.walk = p;
    a.t1 = this.t + (p ? p.length : Math.hypot(x - a.x, y - a.y)) / this.spec.travelSpeed + 0.5;
    if (p) {
      for (const h of p.doors) {
        const at = p.length > 0 ? a.t0 + (h.s / p.length) * (a.t1 - a.t0) : a.t0;
        this.doorPending.push({ t: at, door: h.door });
      }
    }
    return true;
  }

  // Counts every scheduled door crossing whose time has come.
  flushDoors() {
    if (!this.doorPending.length) return;
    const due = [], keep = [];
    for (const e of this.doorPending) (e.t <= this.t + 1e-9 ? due : keep).push(e);
    if (!due.length) return;
    this.doorPending = keep;
    due.sort((p, q) => p.t - q.t || p.door - q.door);
    for (const e of due) { const d = this.doorList[e.door]; d.crossings++; d.times.push(e.t); }
  }

  // ---------------- offers ----------------
  // The offers this agent receives at time t: it is in the audience (everyone when `to` is empty, else
  // its group or its cast member is named) and t is inside [from, until].
  offersFor(a, t = this.t) {
    if (!this.offers.length) return NO_OFFERS;
    return this.offers.filter(o => t >= o.from - 1e-9 && t <= o.until + 1e-9 &&
      (o.everyone || o.groups.has(a.arch.id) || o.cast.has(a.persona.id)));
  }

  // Marks the offers this agent matches now as having reached it. Called at every decision moment.
  noteOffers(a, t = this.t) {
    for (const o of this.offersFor(a, t)) o.reached.add(a.id);
  }

  // What this agent pays at n at time t: the list price less the largest discount among its matching
  // offers for n (discounts do not stack). Exactly n.price when no offer applies.
  priceFor(a, n, t = this.t) {
    if (!this.offers.length) return n.price;
    let off = 0;
    for (const o of this.offersFor(a, t)) if (o.place === n.id && o.priceOff > off) off = o.priceOff;
    return off > 0 ? n.price * (1 - off) : n.price;
  }

  // Rule-policy pick: softmax over utilities with sharpness `rationality`, drawn from the agent stream.
  autoPick(a) {
    const w = a.arch.weights, c = [], u = [];
    for (const n of this.services) {
      if (!this.isCandidate(a, n)) continue;
      const match = n.tags.reduce((s, t) => s + (a.arch.likes.includes(t) ? 1 : 0), 0);
      const est = a.informed ? this.estWait(n) : 0;
      const dist = this.walkDist(a.x, a.y, n.x, n.y);
      c.push(n);
      u.push(w.appeal * n.appeal * (1 + 0.6 * match) - w.wait * est / 20 - w.distance * dist / 40 - w.price * this.priceFor(a, n) / 20);
    }
    if (!c.length) return null;
    const mx = Math.max(...u);
    const p = u.map(v => Math.exp(a.arch.rationality * (v - mx)));
    let r = a.rng() * p.reduce((s, v) => s + v, 0), k = 0;
    for (; k < p.length - 1; k++) { r -= p[k]; if (r <= 0) break; }
    return c[k];
  }

  serviceTime(n, a) {
    const st = n.serviceTime;
    if (n.serviceDist === 'fixed') return st;
    if (n.serviceDist === 'exp') return -st * Math.log(1 - a.rng());
    return st * (0.6 + 0.8 * a.rng());
  }

  // A choose moment: start (arrived), next (finished somewhere), balked, gaveup. `place` is the place just left.
  decide(a, why, place) {
    a.decisions++;
    this.noteOffers(a);
    const exhausted = a.visitsLeft <= 0 || a.decisions > a.arch.visits * 2 + 3;
    if (!this.external) {
      const n = exhausted ? null : this.autoPick(a);
      return n ? this.goTo(a, n) : this.leave(a);
    }
    const cands = exhausted ? [] : this.candidates(a);
    if (!cands.length && why === 'start') return this.leave(a);
    this.requestChoose(a, why, place, cands);
  }

  // Only called for candidates, which are reachable, so the walk always starts. The price quoted is the
  // one the agent saw when it chose (time `t`), and it is what the agent pays if served there.
  goTo(a, n, quiet = false, t = this.t) {
    a.visited.add(n.idx); a.target = n;
    a.quote = { id: n.id, price: this.priceFor(a, n, t) };
    for (const o of this.offers) if (o.place === n.id && o.reached.has(a.id)) o.went.add(a.id);
    if (!this.startWalk(a, n.x, n.y, 'walk')) throw new Error(`Sim: no walking path from (${a.x}, ${a.y}) to ${n.id}`);
    if (!quiet) this.log(a, `Headed to ${n.name}` + (a.informed ? ` (~${Math.round(this.estWait(n))} min wait showing)` : ''));
  }

  arriveAt(a) {
    const n = a.target; n.arrivals++;
    this.noteOffers(a);
    a.x = n.x; a.y = n.y; a.lastPlace = n.name;
    const est = this.estWait(n), tol = this.tolerance(a);
    if (this.external) {
      if (est > 8 && est > tol * 0.5) return this.requestLine(a, n, est);
      return this.enqueue(a, n);
    }
    if (est > tol * (0.8 + 0.4 * a.jit)) {
      this.walkAway(a, n);
      this.log(a, `Saw ${n.queue.length} people in line at ${n.name} (~${Math.round(est)} min) and walked away`);
      return this.decide(a, 'balked', n);
    }
    this.enqueue(a, n);
  }

  enqueue(a, n) {
    a.state = 'queue'; a.enq = this.t; a.askedLong = false; a.longLimit = null;
    n.queue.push(a);
    if (n.queue.length > n.maxQueue) n.maxQueue = n.queue.length;
  }

  walkAway(a, n) {
    n.abandoned++; n.walkLog.push(this.t); if (n.walkLog.length > 400) n.walkLog.splice(0, 200);
    a.abandons++; this.abandonedTotal++;
  }

  // The nearest of `list` by walking distance, or null when none can be reached on foot.
  nearestExit(a, list) {
    let best = null, bd = Infinity;
    for (const e of list) { const d = this.walkDist(a.x, a.y, e.x, e.y); if (d < bd) { bd = d; best = e; } }
    return best;
  }

  // Leaves through the nearest of its group's exits by walking distance (archetypes[].exits, default
  // every exit). When walls cut the agent off from all of them, it takes the nearest reachable exit of any kind.
  // Uses no random draws, so every agent stream keeps its order.
  leave(a) {
    const own = a.arch.exitList ?? this.exits;
    let best = this.nearestExit(a, own), note = '';
    if (!best && own !== this.exits) {
      best = this.nearestExit(a, this.exits);
      if (best) note = ' (none of this group\'s exits can be reached on foot from here)';
    }
    if (best && this.startWalk(a, best.x, best.y, 'leave')) {
      this.log(a, `Done (${a.served} served, ${Math.round(a.waitTotal)} min in lines), heading to ${best.name}${note}`);
    } else if (this.exits.length) {
      this.log(a, `Done (${a.served} served, ${Math.round(a.waitTotal)} min in lines); no exit can be reached on foot from here`);
      this.finish(a);
    } else {
      this.log(a, `Done (${a.served} served, ${Math.round(a.waitTotal)} min in lines) and went home`);
      this.finish(a);
    }
  }

  finish(a) { a.state = 'done'; a.tDone = this.t; this.finished++; }

  giveUp(a, n, waited) {
    a.waitTotal += waited; this.walkAway(a, n);
    this.log(a, `Gave up on ${n.name} after ${Math.round(waited)} min in line`);
    this.decide(a, 'gaveup', n);
  }

  stepVisit() {
    const t = this.t, dt = this.dt;
    for (const a of this.active) {
      if (a.state === 'walk' && a.t1 <= t) this.arriveAt(a);
      else if (a.state === 'leave' && a.t1 <= t) { a.x = a.tx; a.y = a.ty; this.finish(a); }
    }
    for (const n of this.services) {
      if (n.busy.length) {
        const still = [];
        for (const a of n.busy) {
          // An agent served while a `long` request is still open finishes once it is resolved.
          if (a.tf <= t && !a.req) {
            n.served++; a.served++; a.visitsLeft--; this.servedTotal++;
            a.placesDone.push(n.name);
            a.servedAt.push(n.id);
            a.spent += a.quote?.id === n.id ? a.quote.price : n.price;
            this.log(a, `Finished at ${n.name}`);
            this.decide(a, 'next', n);
          } else still.push(a);
        }
        n.busy = still;
      }
      if (n.queue.length) {
        const keep = [];
        for (const a of n.queue) {
          if (a.req) { keep.push(a); continue; }
          const waited = t - a.enq, tol = this.tolerance(a);
          if (this.external) {
            if (!a.askedLong && waited > tol && waited > 10) {
              a.askedLong = true;
              this.requestLong(a, n, waited);
              keep.push(a);
            } else if (a.longLimit != null && waited > a.longLimit) this.giveUp(a, n, waited);
            else keep.push(a);
            continue;
          }
          const lim = a.longLimit ?? tol * 1.3 * (0.8 + 0.4 * a.jit);
          if (waited > lim) this.giveUp(a, n, waited);
          else keep.push(a);
        }
        n.queue = keep;
      }
      while (n.busy.length < n.servers && n.queue.length) {
        const a = n.queue.shift(), wt = t - a.enq;
        n.waitSum += wt; n.waitN++; a.waitTotal += wt; a.state = 'serve';
        a.tf = t + this.serviceTime(n, a);
        if (wt >= 1) this.log(a, `Waited ${Math.round(wt)} min at ${n.name}`);
        n.busy.push(a);
      }
      n.busyTime += n.busy.length * dt;
    }
  }

  // ---------------- route mode ----------------
  depart(a) {
    a.tripStart = this.t;
    this.chooseLink(a, this.t);
  }

  // Enters the next link at time `start` (the exact end of the previous link, so short links don't lose time to ticks).
  chooseLink(a, start) {
    if (a.hops > 40) { this.log(a, 'Got lost and gave up'); this.lostTotal++; return this.finish(a); }
    let L = null;
    if (a.plan && a.planI < a.plan.length && a.plan[a.planI].from === a.node) L = a.plan[a.planI++];
    else {
      a.plan = null;
      const h = this.h.get(a.dest);
      let opts = this.out[a.node].filter(x => Number.isFinite(h[x.to]));
      const fresh = opts.filter(x => !a.seen.has(x.to));
      if (fresh.length) opts = fresh;
      if (!opts.length) { this.log(a, 'Got stuck with no road onward'); this.lostTotal++; return this.finish(a); }
      const cost = opts.map(x => (a.informed ? this.tt(x) : x.length) + h[x.to]);
      const mn = Math.min(...cost), beta = a.arch.rationality;
      const p = cost.map(v => Math.exp(-beta * (v - mn)));
      let r = a.rng() * p.reduce((s, v) => s + v, 0), k = 0;
      for (; k < p.length - 1; k++) { r -= p[k]; if (r <= 0) break; }
      L = opts[k];
    }
    this.checkLink(a, L);
    L.load++;
    const tt = this.tt(L), e = L.edge;
    e.trav++; e.ttSum += tt; e.ffSum += L.length;
    e.peak = Math.max(e.peak, L.load / L.capacity);
    a.link = L; a.t0 = start; a.t1 = start + tt; a.state = 'drive'; a.hops++;
    a.seen.add(L.to);
    if (a.path[a.path.length - 1] !== e.name) a.path.push(e.name);
    if (tt > L.length * 1.3) this.log(a, `Took ${e.name}: ${tt.toFixed(1)} min instead of ${L.length.toFixed(1)} (${L.load} on it)`);
    else this.log(a, `Took ${e.name} (${tt.toFixed(1)} min)`);
  }

  stepRoute() {
    const t = this.t;
    for (const a of this.active) {
      let guard = 0;
      while (a.state === 'drive' && a.t1 <= t && guard++ < 60) {
        const L = a.link; L.load--;
        const extra = (a.t1 - a.t0) - L.length;
        if (!a.worst || extra > a.worst.extra) a.worst = { id: L.edge.id, name: L.edge.name, extra };
        a.node = L.to;
        const n = this.nodes[L.to];
        a.x = n.x; a.y = n.y;
        if (a.node === a.dest) {
          a.trip = a.t1 - a.tripStart; a.delay = a.trip - a.ff;
          this.arrivedTotal++;
          this.log(a, `Arrived at ${n.name} after ${a.trip.toFixed(0)} min (${a.ff.toFixed(0)} min with empty roads)`);
          this.finish(a);
          if (this.external && a.trip > 1.25 * a.ff) this.requestArrive(a);
        } else this.chooseLink(a, a.t1);
      }
    }
  }

  // ---------------- observations ----------------
  personCtx(a) {
    const P = a.persona;
    return {
      name: P.name, age: P.age, bio: P.bio, personality: P.personality, goal: P.goal, social: P.social,
      groupName: a.arch.name, informed: a.informed
    };
  }

  recentRemarks() {
    const from = this.t - HEARD_WINDOW, R = this.remarks;
    let lo = 0, hi = R.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (R[mid].t < from) lo = mid + 1; else hi = mid; }
    return lo ? R.slice(lo) : R;
  }

  heardFor(a, x, y) {
    const viewer = {
      mode: this.mode, t: this.t, agentId: a.id, archetypeId: a.arch.id, informed: a.informed, x, y, placePos: this.placePos
    };
    // With walls, "overheard nearby" means within 30 units on foot.
    if (this.nav && this.mode === 'visit') {
      viewer.distanceTo = id => { const p = this.placePos.get(id); return p ? this.walkDist(x, y, p.x, p.y) : Infinity; };
    }
    return selectHeard(this.recentRemarks(), viewer, this.names);
  }

  // Valid candidates in node order, plus the current place for line/long. The current place shows the
  // price the agent was quoted when it chose it, which is what it will pay.
  placesCtx(a, current, x, y) {
    const out = [];
    for (const n of this.services) {
      if (n !== current && !this.isCandidate(a, n)) continue;
      const dist = this.walkDist(x, y, n.x, n.y);
      const price = n === current && a.quote?.id === n.id ? a.quote.price : this.priceFor(a, n);
      out.push({
        id: n.id, name: n.name, about: n.about, tags: n.tags, price, listPrice: n.price, dist, est: this.estWait(n),
        visible: a.informed || n === current || dist <= SEE_RADIUS, walkedAway30: this.walkedAway30(n)
      });
    }
    return out;
  }

  visitObs(a, moment, current, places = true) {
    const x = current ? current.x : a.x, y = current ? current.y : a.y;
    const inLine = a.state === 'queue' && a.enq != null ? this.t - a.enq : 0;
    return visitObservation({
      spec: this.spec, t: this.t, person: this.personCtx(a), frustration: a.frustration,
      timeHere: this.t - a.born, timeInLines: a.waitTotal + inLine, placesDone: a.placesDone.slice(),
      moment: { why: null, placeName: null, est: null, tolerance: this.tolerance(a), waited: null, remaining: null, ...moment },
      places: places ? this.placesCtx(a, current, x, y) : [],
      offers: this.offersFor(a).map(o => o.text),
      heard: this.heardFor(a, x, y)
    });
  }

  placeOptions(cands) {
    return [
      ...cands.map(n => ({ key: n.id, label: `Go to ${n.name}` })),
      { key: 'leave', label: this.spec.leaveLabel || DEFAULT_LEAVE }
    ];
  }

  // ---------------- decision requests ----------------
  request(a, kind, f) {
    const id = 'd' + (++this.reqSeq);
    const req = {
      id, t: this.t, clock: this.clock(this.t), kind, why: kind === 'choose' ? f.why : null,
      agentId: a.id, decisionIndex: a.decisionCount++,
      personaId: a.persona.id, personaName: a.persona.name, archetypeId: a.arch.id,
      placeId: f.placeId ?? null, aboutPlace: f.aboutPlace ?? null, aboutEdge: f.aboutEdge ?? null,
      asks: f.asks, options: f.options, remarkKinds: f.remarkKinds ?? null,
      observation: f.observation, auto: f.auto
    };
    this.held.push({ req, a, node: f.node ?? null, routes: f.routes ?? null });
    if (kind !== 'arrive') {
      this.noteOffers(a);
      a.req = id;
      if (kind !== 'long') a.state = 'think';
    }
    return req;
  }

  // When nothing is left to choose (visits used up, no candidates), an after-experience choose still asks
  // frustration and tell_others, with no choice question; it always resolves to leaving.
  requestChoose(a, why, place, cands) {
    const after = why !== 'start' && place != null;
    const leaveOnly = !cands.length;
    const pick = leaveOnly ? null : this.autoPick(a);
    this.request(a, 'choose', {
      why, aboutPlace: after ? place.id : null,
      asks: { choice: leaveOnly ? null : 'next_place', yesNo: null, frustration: after, tellOthers: after },
      options: leaveOnly ? [] : this.placeOptions(cands),
      remarkKinds: after ? VISIT_REMARKS(place.name) : null,
      observation: this.visitObs(a, { kind: 'choose', why, placeName: place?.name ?? null }, null, !leaveOnly),
      auto: { action: pick ? pick.id : 'leave' }
    });
  }

  requestLine(a, n, est) {
    const tol = this.tolerance(a);
    let action = 'yes';
    if (est > tol * (0.8 + 0.4 * a.jit)) { const m = this.autoPick(a); action = m ? m.id : 'leave'; }
    this.request(a, 'line', {
      placeId: n.id, aboutPlace: n.id, node: n,
      asks: { choice: 'next_place', yesNo: 'join', frustration: true, tellOthers: true },
      options: this.placeOptions(this.candidates(a)),
      remarkKinds: VISIT_REMARKS(n.name),
      observation: this.visitObs(a, { kind: 'line', placeName: n.name, est }, n),
      auto: { action }
    });
  }

  requestLong(a, n, waited) {
    const tol = this.tolerance(a);
    const ahead = Math.max(0, n.queue.indexOf(a));
    const remaining = ahead * n.serviceTime / n.servers;
    let action = 'yes';
    if (waited > tol * 1.3 * (0.8 + 0.4 * a.jit)) { const m = this.autoPick(a); action = m ? m.id : 'leave'; }
    this.request(a, 'long', {
      placeId: n.id, aboutPlace: n.id, node: n,
      asks: { choice: 'next_place', yesNo: 'keep_waiting', frustration: true, tellOthers: true },
      options: this.placeOptions(this.candidates(a)),
      remarkKinds: VISIT_REMARKS(n.name),
      observation: this.visitObs(a, { kind: 'long', placeName: n.name, est: remaining, waited, remaining }, n),
      auto: { action }
    });
  }

  tripCtx(a) { return { fromName: this.nodes[a.origin].name, toName: this.nodes[a.dest].name }; }

  requestRoute(a, routes) {
    let best = 0, bv = Infinity;
    routes.forEach((o, i) => { const v = a.informed ? this.pathNow(o.links) : o.ff; if (v < bv) { bv = v; best = i; } });
    const o = this.nodes[a.origin];
    this.request(a, 'route', {
      routes,
      asks: { choice: 'route', yesNo: null, frustration: false, tellOthers: false },
      options: routes.map((r, i) => ({ key: 'r' + i, label: `Take the route via ${r.label}` })),
      observation: routeObservation({
        spec: this.spec, t: this.t, person: this.personCtx(a), trip: this.tripCtx(a),
        routes: routes.map((r, i) => ({ key: 'r' + i, label: r.label, ff: r.ff, now: a.informed ? this.pathNow(r.links) : null })),
        offers: this.offersFor(a).map(x => x.text),
        heard: this.heardFor(a, o.x, o.y)
      }),
      auto: { action: 'r' + best }
    });
  }

  requestArrive(a) {
    const worst = a.worst;
    this.request(a, 'arrive', {
      aboutEdge: worst ? worst.id : null,
      asks: { choice: null, yesNo: null, frustration: true, tellOthers: true },
      options: [],
      remarkKinds: worst ? ROUTE_REMARKS(worst.name) : null,
      observation: arriveObservation({
        spec: this.spec, t: this.t, person: this.personCtx(a), trip: this.tripCtx(a),
        took: a.path.join(' → '), tripMin: a.trip, ffMin: a.ff, worstEdgeName: worst ? worst.name : null
      }),
      auto: null
    });
  }

  // Releases held requests once the oldest is at least batchWindow sim minutes old, or the sim is done.
  pending() {
    if (!this.held.length) return [];
    if (!this.done && this.t - this.held[0].req.t < this.batchWindow - 1e-9) return [];
    const out = this.held;
    this.held = [];
    for (const e of out) this.inflight.set(e.req.id, e);
    return out.map(e => e.req);
  }

  // ---------------- resolve ----------------
  resolve(id, decision) {
    let entry = this.inflight.get(id);
    if (entry) this.inflight.delete(id);
    else {
      const i = this.held.findIndex(e => e.req.id === id);
      if (i < 0) throw new Error(`resolve: unknown or already resolved decision request "${id}"`);
      entry = this.held.splice(i, 1)[0];
    }
    const { req, a } = entry;
    const d = decision && typeof decision === 'object' ? decision : {};
    const s = sampleDecision(req, d, seedRng(this.opts.seed, 'decide', req.agentId, req.decisionIndex));
    if (a.req === req.id) a.req = null;

    let summary;
    if (req.kind === 'choose') summary = this.applyChoose(a, s.action, req.t);
    else if (req.kind === 'line') summary = this.applyLine(a, entry.node, s, req.t);
    else if (req.kind === 'long') summary = this.applyLong(a, entry.node, s, req.t);
    else if (req.kind === 'route') summary = this.applyRoute(a, entry.routes, s.action, req);
    else summary = s.frustration != null ? `felt ${feelingWords(s.frustration)} about the trip` : 'reflected on the trip';

    if (s.frustration != null && Number.isFinite(Number(s.frustration))) {
      a.frustration = Number(s.frustration);
      a.patienceMult = clamp(1 - 0.1 * a.frustration, 0.55, 1);
    }

    let remarkKind = null;
    if (s.tell) {
      remarkKind = s.remarkKind || this.defaultRemarkKind(req);
      const remark = {
        t: req.t, agentId: a.id, personaName: a.persona.name, archetypeId: a.arch.id, kind: remarkKind,
        placeId: req.aboutPlace ?? null, edgeId: req.aboutEdge ?? null, informed: a.informed
      };
      this.remarks.push(remark);
      summary += `; told others: ${remarkText(remark, this.names)}`;
    }

    const provider = d.provider || 'unknown';
    const st = this.decisionStats;
    st.total++;
    st.byProvider[provider] = (st.byProvider[provider] || 0) + 1;
    st.byKind[req.kind] = (st.byKind[req.kind] || 0) + 1;
    this.log(a, `Decided (${provider}): ${summary}`);

    return {
      id: req.id, agentId: a.id, kind: req.kind, yes: s.yes ?? null, action: s.action ?? null,
      tell: Boolean(s.tell), remarkKind, frustration: s.frustration ?? null, summary, provider
    };
  }

  defaultRemarkKind(req) {
    if (this.mode === 'route') return 'heavy_traffic';
    return req.kind === 'line' || req.kind === 'long' || req.why === 'balked' || req.why === 'gaveup' ? 'long_line' : 'good_experience';
  }

  placeFor(a, action) {
    const n = action && action !== 'leave' && action !== 'yes' && action !== 'no' ? this.byId.get(action) : null;
    return this.isCandidate(a, n) ? n : null;
  }

  // `t` is the request's time: the prices the agent saw are the prices it is quoted.
  applyChoose(a, action, t) {
    const n = this.placeFor(a, action);
    if (n) { this.goTo(a, n, true, t); return `headed to ${n.name}`; }
    this.leave(a);
    return 'decided to leave';
  }

  applyLine(a, n, s, t) {
    const yes = s.yes ?? s.action === 'yes';
    if (yes) { this.enqueue(a, n); return `joined the line at ${n.name}`; }
    this.walkAway(a, n);
    const m = this.placeFor(a, s.action);
    if (m) { this.goTo(a, m, true, t); return `skipped ${n.name}'s line for ${m.name}`; }
    this.leave(a);
    return `skipped ${n.name}'s line and left`;
  }

  applyLong(a, n, s, t) {
    const yes = s.yes ?? s.action === 'yes';
    const i = n.queue.indexOf(a);
    if (i < 0) return yes ? `kept waiting at ${n.name}` : `wanted to leave ${n.name}'s line but was already through`;
    const waited = this.t - a.enq;
    if (yes) { a.longLimit = waited + this.tolerance(a); return `kept waiting at ${n.name}`; }
    n.queue.splice(i, 1); a.waitTotal += waited; this.walkAway(a, n);
    const m = this.placeFor(a, s.action);
    if (m) { this.goTo(a, m, true, t); return `gave up on ${n.name} after ${Math.round(waited)} min for ${m.name}`; }
    this.leave(a);
    return `gave up on ${n.name} after ${Math.round(waited)} min and left`;
  }

  applyRoute(a, routes, action, req) {
    const idx = v => (typeof v === 'string' && /^r\d+$/.test(v) ? Number(v.slice(1)) : -1);
    let k = idx(action);
    if (!(k >= 0 && k < routes.length)) k = idx(req.auto?.action);
    if (!(k >= 0 && k < routes.length)) k = 0;
    a.plan = routes[k].links; a.planI = 0;
    this.depart(a);
    return `took ${routes[k].label}`;
  }

  // ---------------- stepping ----------------
  step() {
    if (this.done) return;
    while (this.si < this.schedule.length && this.schedule[this.si] <= this.t) { this.spawn(this.si); this.si++; }
    if (this.mode === 'visit') this.stepVisit(); else this.stepRoute();
    this.flushDoors();
    if (this.t + 1e-9 >= this.nextFrame) {
      this.captureFrame();
      while (this.nextFrame <= this.t + 1e-9) this.nextFrame += this.frameEvery;
    }
    this.tick++;
    this.t = this.tick * this.dt;
    if (this.tick % 40 === 0) this.active = this.active.filter(a => a.state !== 'done');
  }

  get done() { return this.t >= this.spec.duration - 1e-9; }

  runToEnd() {
    if (this.external) throw new Error('runToEnd() is for inline mode only; in external mode drive the sim with step(), pending() and resolve().');
    let guard = 0;
    while (!this.done && guard++ < 5e6) this.step();
    return this;
  }

  // ---------------- frames ----------------
  // Distance from (x, y) to the nearest wall; the open disk of that radius holds no wall.
  freeAt(x, y) {
    const row = childMap(this.freeCache, x);
    let r = row.get(y);
    if (r === undefined) {
      r = Infinity;
      for (const w of this.walls) r = Math.min(r, pointSegDist(x, y, w));
      row.set(y, r);
    }
    return r;
  }

  // A display spot offset from a node. With walls the offset is shortened to stay inside the node's
  // wall-free disk, so a queued or thinking dot is never drawn behind a wall.
  spot(x, y, ox, oy) {
    if (!this.nav) return [x + ox, y + oy];
    const r = Math.hypot(ox, oy), max = 0.9 * this.freeAt(x, y);
    const k = r > max ? max / r : 1;
    return [x + ox * k, y + oy * k];
  }

  // Frame coordinates are stored ×10 as integers. With walls, pick a rounding the true position can
  // see, so rounding never moves a dot across a wall; when possible also one the agent's previous
  // stored position can see, so a path grazing a wall end does not make the chord between two
  // frames clip it.
  frameXY(x, y, prev = null) {
    x = clamp(x, 0, 100); y = clamp(y, 0, 100);
    const qx = Math.round(x * 10), qy = Math.round(y * 10);
    if (!this.nav) return [qx, qy];
    const seen = ([cx, cy]) => !this.nav.blocked(x, y, cx / 10, cy / 10);
    const chained = q => seen(q) && (!prev || !this.nav.blocked(prev[0] / 10, prev[1] / 10, q[0] / 10, q[1] / 10));
    if (chained([qx, qy])) return [qx, qy];
    const xs = [Math.floor(x * 10), Math.ceil(x * 10)], ys = [Math.floor(y * 10), Math.ceil(y * 10)];
    const options = xs.flatMap(cx => ys.map(cy => [cx, cy]))
      .sort((p, q) => Math.hypot(p[0] / 10 - x, p[1] / 10 - y) - Math.hypot(q[0] / 10 - x, q[1] / 10 - y));
    return options.find(chained) || (seen([qx, qy]) ? [qx, qy] : options.find(seen)) || [qx, qy];
  }

  captureFrame() {
    const t = this.t, list = [];
    const put = (a, x, y, s) => {
      const q = this.frameXY(x, y, a.lastFrameXY);
      if (this.nav) a.lastFrameXY = q;
      list.push(a.id, q[0], q[1], s);
    };
    const putNear = (a, x, y, ox, oy, s) => { const [px, py] = this.spot(x, y, ox, oy); put(a, px, py, s); };
    const progress = a => clamp((t - a.t0) / Math.max(0.01, a.t1 - a.t0), 0, 1);
    if (this.mode === 'visit') {
      for (const n of this.services) {
        n.queue.forEach((a, i) => {
          const ang = i * 2.39996 + n.idx, rad = 2.6 + 0.42 * Math.sqrt(i);
          putNear(a, n.x, n.y, Math.cos(ang) * rad, Math.sin(ang) * rad, a.req ? STATE_CODE.think : STATE_CODE.queue);
        });
        for (const a of n.busy) {
          const ang = a.jit * 6.2832, rad = 0.3 + 1.5 * ((a.jit * 7.3) % 1);
          putNear(a, n.x, n.y, Math.cos(ang) * rad, Math.sin(ang) * rad, a.req ? STATE_CODE.think : STATE_CODE.serve);
        }
      }
      for (const a of this.active) {
        if (a.state === 'walk' || a.state === 'leave') {
          const p = progress(a);
          if (this.nav) {
            // Exactly on the wall-free path; no sideways jitter that could cross a wall.
            const at = pointAlong(a.walk.points, p * a.walk.length);
            put(a, at.x, at.y, STATE_CODE[a.state]);
          } else {
            const bend = Math.sin(p * Math.PI);
            const jx = (a.jit - 0.5) * 1.2, jy = ((a.jit * 7.3) % 1 - 0.5) * 1.2;
            put(a, a.fx + (a.tx - a.fx) * p + jx * bend, a.fy + (a.ty - a.fy) * p + jy * bend, STATE_CODE[a.state]);
          }
        } else if (a.state === 'think') {
          if (this.nav) putNear(a, a.x, a.y, (a.jit - 0.5) * 2.4, -1.6 - a.jit, STATE_CODE.think);
          else put(a, a.x + (a.jit - 0.5) * 2.4, a.y - 1.6 - a.jit, STATE_CODE.think);
        }
      }
    } else {
      for (const a of this.active) {
        if (a.state === 'drive') {
          const L = a.link, p = progress(a), off = 0.4 + a.jit * 0.6;
          if (this.nav) {
            const at = pointAlong(L.points, p * L.shapeLen);   // on the polyline, no lane offset near walls
            put(a, at.x, at.y, STATE_CODE.drive);
          } else if (L.points.length > 2) {
            const at = alongWithDir(L.points, p * L.shapeLen);
            put(a, at.x - at.dy * off, at.y + at.dx * off, STATE_CODE.drive);
          } else {
            const A = this.nodes[L.from], B = this.nodes[L.to];
            const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
            put(a, A.x + dx * p - dy / len * off, A.y + dy * p + dx / len * off, STATE_CODE.drive);
          }
        } else if (a.state === 'think') {
          if (this.nav) putNear(a, a.x, a.y, (a.jit - 0.5) * 2, -1.5, STATE_CODE.think);
          else put(a, a.x + (a.jit - 0.5) * 2, a.y - 1.5, STATE_CODE.think);
        }
      }
    }
    this.frames.list.push({
      t: round2(t), a: list,
      q: this.mode === 'visit' ? this.services.map(n => n.queue.length) : null,
      load: this.mode === 'route' ? this.edges.map(e => Math.round(this.edgeRatio(e) * 100)) : null,
      d: this.doorList.length ? this.doorList.map(d => d.crossings) : null,
      c: {
        active: this.agents.length - this.finished,
        served: this.servedTotal,
        abandoned: this.mode === 'visit' ? this.abandonedTotal : this.lostTotal,
        arrived: this.mode === 'visit' ? this.agents.length : this.arrivedTotal
      }
    });
  }

  // ---------------- results ----------------
  agentsSummary() {
    return this.agents.map(a => {
      const o = {
        id: a.id, personaId: a.persona.id, personaName: a.persona.name, archetypeId: a.arch.id, informed: a.informed,
        served: a.served, waitTotal: round2(a.waitTotal), abandons: a.abandons, frustration: a.frustration,
        born: round2(a.born), done: a.tDone == null ? null : round2(a.tDone), trace: a.trace
      };
      if (this.mode === 'route' && a.trip != null) { o.trip = round2(a.trip); o.delay = round2(a.delay); }
      if (this.mode === 'visit') { o.spent = round2(a.spent); o.visits = a.servedAt.slice(); }
      return o;
    });
  }

  // Door traffic, busiest first. Crossings already reached by the current time but not yet flushed
  // by a step (the last tick of a run) are included.
  doorMetrics() {
    if (!this.doorList.length) return [];
    const late = this.doorPending.filter(e => e.t <= this.t + 1e-9).sort((p, q) => p.t - q.t);
    const out = this.doorList.map(d => {
      const times = d.times.concat(late.filter(e => e.door === d.idx).map(e => e.t));
      let peak = 0, peakAt = null;
      for (let i = 0, j = 0; i < times.length; i++) {
        while (times[i] - times[j] >= DOOR_WINDOW) j++;
        if (i - j + 1 > peak) { peak = i - j + 1; peakAt = times[j]; }
      }
      return {
        id: d.id, name: d.name, exterior: d.exterior, crossings: times.length,
        peakPer5Min: peak, peakClock: peakAt == null ? null : this.clock(peakAt)
      };
    });
    return out.sort((p, q) => q.crossings - p.crossings);
  }

  // Outcomes per kind of simulated person (§15a): byGroup (archetypes) and byCast (everyone who copies
  // one cast member). An average is null when nobody in the segment counts toward it; frustration counts
  // only agents who were asked.
  segments() {
    const route = this.mode === 'route';
    const byArch = new Map(this.arch.map(ar => [ar, []])), byPersona = new Map(this.personas.map(P => [P, []]));
    for (const a of this.agents) { byArch.get(a.arch).push(a); byPersona.get(a.persona).push(a); }
    const mean = (list, f) => (list.length ? list.reduce((s, a) => s + f(a), 0) / list.length : null);
    const entry = (id, name, group, ag) => {
      const avgFrustration = mean(ag.filter(a => a.frustration != null), a => a.frustration);
      if (route) {
        const arrived = ag.filter(a => a.trip != null);
        return { id, name, group, count: ag.length, avgTrip: mean(arrived, a => a.trip), avgDelay: mean(arrived, a => a.delay), avgFrustration };
      }
      const visits = new Map();
      for (const a of ag) for (const pid of a.servedAt) visits.set(pid, (visits.get(pid) || 0) + 1);
      const served = [...visits].map(([pid, k]) => ({ node: this.byId.get(pid), visits: k }));
      const topPlaces = served
        .sort((p, q) => q.visits - p.visits || p.node.idx - q.node.idx)
        .slice(0, TOP_PLACES)
        .map(({ node, visits: k }) => ({ id: node.id, name: node.name, visits: k }));
      // Every place that served the segment, in node order: topPlaces alone can't say how a place outside
      // the top 3 changed between two runs.
      const visitsByPlace = Object.fromEntries([...visits]
        .map(([pid, k]) => [this.byId.get(pid), k])
        .sort((p, q) => p[0].idx - q[0].idx)
        .map(([node, k]) => [node.id, k]));
      return {
        id, name, group, count: ag.length,
        avgWait: mean(ag, a => a.waitTotal), avgSpent: mean(ag, a => a.spent), avgVisits: mean(ag, a => a.servedAt.length),
        walkAwaysPerPerson: mean(ag, a => a.abandons), shareNeverServed: mean(ag, a => (a.served === 0 ? 1 : 0)),
        avgFrustration, topPlaces, visitsByPlace
      };
    };
    return {
      byGroup: this.arch.map(ar => entry(ar.id, ar.name, ar.id, byArch.get(ar))),
      byCast: this.personas.map(P => entry(P.id, P.name, P.arch.id, byPersona.get(P)))
    };
  }

  metrics() {
    const el = Math.max(this.t, this.dt);
    const byKind = {};
    for (const r of this.remarks) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    const felt = this.agents.filter(a => a.frustration != null);
    const avgF = list => (list.length ? list.reduce((s, a) => s + a.frustration, 0) / list.length : null);
    const common = {
      remarks: { total: this.remarks.length, byKind },
      decisions: {
        total: this.decisionStats.total,
        byProvider: { ...this.decisionStats.byProvider },
        byKind: { ...this.decisionStats.byKind }
      },
      frustration: {
        avg: avgF(felt),
        byArchetype: Object.fromEntries(this.arch.map(ar => [ar.id, avgF(felt.filter(a => a.arch === ar))]))
      },
      walls: { count: this.walls.length, checkedMoves: this.wallStats.checkedMoves, violations: this.wallStats.violations },
      doors: this.doorMetrics(),
      offers: this.offers.map(o => ({ id: o.id, reached: o.reached.size, wentToPlace: o.went.size }))
    };

    if (this.mode === 'visit') {
      const nodes = this.services.map(n => ({
        id: n.id, name: n.name, arrivals: n.arrivals, served: n.served, abandoned: n.abandoned,
        avgWait: n.waitN ? n.waitSum / n.waitN : 0, waitMinutes: n.waitSum + n.queue.reduce((s, a) => s + (this.t - a.enq), 0),
        maxQueue: n.maxQueue, queueNow: n.queue.length, utilization: n.busyTime / (n.servers * el),
        throughputPerHour: n.served / (el / 60), servers: n.servers, serviceTime: n.serviceTime,
        capacityPerHour: n.servers / n.serviceTime * 60, price: n.price, appeal: n.appeal
      }));
      nodes.forEach(n => { n.score = n.waitMinutes + 30 * n.abandoned; });
      nodes.sort((a, b) => b.score - a.score);
      const spawned = this.agents.length;
      const arrivals = nodes.reduce((s, n) => s + n.arrivals, 0);
      const abandoned = nodes.reduce((s, n) => s + n.abandoned, 0);
      const served = nodes.reduce((s, n) => s + n.served, 0);
      const waitN = this.nodes.reduce((s, n) => s + n.waitN, 0);
      const waitSum = this.nodes.reduce((s, n) => s + n.waitSum, 0);
      const archetypes = this.arch.map(ar => {
        const ag = this.agents.filter(a => a.arch === ar), k = Math.max(1, ag.length);
        return {
          id: ar.id, name: ar.name, count: ag.length,
          avgWaitPerAgent: ag.reduce((s, a) => s + a.waitTotal, 0) / k,
          avgServed: ag.reduce((s, a) => s + a.served, 0) / k,
          abandonsPerAgent: ag.reduce((s, a) => s + a.abandons, 0) / k,
          avgFrustration: common.frustration.byArchetype[ar.id]
        };
      });
      return {
        mode: 'visit', minutes: el, spawned, active: spawned - this.finished, finished: this.finished,
        served, arrivals, abandoned, abandonRate: arrivals ? abandoned / arrivals : 0,
        avgWait: waitN ? waitSum / waitN : 0, nodes, archetypes, segments: this.segments(), ...common
      };
    }

    const edges = this.edges.map(e => ({
      id: e.id, name: e.name, traversals: e.trav, freeflow: e.length, capacity: e.capacity,
      costModel: e.linear ? 'linear' : 'bpr',
      avgTime: e.trav ? e.ttSum / e.trav : e.length, delayRatio: e.ffSum ? e.ttSum / e.ffSum : 1,
      delayMinutes: e.ttSum - e.ffSum, peakRatio: e.peak, loadNow: this.edgeRatio(e)
    }));
    edges.forEach(e => { e.score = e.delayMinutes; });
    edges.sort((a, b) => b.score - a.score);
    const done = this.agents.filter(a => a.trip != null), k = Math.max(1, done.length);
    const archetypes = this.arch.map(ar => {
      const ag = done.filter(a => a.arch === ar), m = Math.max(1, ag.length);
      return {
        id: ar.id, name: ar.name, count: ar.count, arrived: ag.length,
        avgTrip: ag.reduce((s, a) => s + a.trip, 0) / m, avgDelay: ag.reduce((s, a) => s + a.delay, 0) / m,
        avgFrustration: common.frustration.byArchetype[ar.id]
      };
    });
    const od = {};
    for (const a of done) {
      const key = this.nodes[a.origin].name + ' → ' + this.nodes[a.dest].name;
      (od[key] ||= { route: key, trips: 0, tripSum: 0, ff: a.ff });
      od[key].trips++; od[key].tripSum += a.trip;
    }
    return {
      mode: 'route', minutes: el, spawned: this.agents.length, active: this.agents.length - this.finished,
      finished: this.finished, arrived: done.length, lost: this.lostTotal,
      avgTrip: done.reduce((s, a) => s + a.trip, 0) / k, avgFreeflow: done.reduce((s, a) => s + a.ff, 0) / k,
      avgDelay: done.reduce((s, a) => s + a.delay, 0) / k, edges, archetypes,
      od: Object.values(od).map(o => ({ route: o.route, trips: o.trips, avgTrip: o.tripSum / o.trips, freeflow: o.ff })),
      segments: this.segments(),
      ...common
    };
  }
}
