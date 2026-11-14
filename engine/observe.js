// Builds the JSON-safe observation an agent decides from (the Jev `state`). Pure functions: the Sim
// gathers the inputs (docs/PROTOTYPE.md §12a) and this module turns every number into words (§5),
// because Jev compares words far better than numbers.
import {
  waitWords, patienceWords, durationWords, distanceWords, priceWords, timeWords, feelingWords
} from './util.js';

export const SEE_RANGE = 30;          // map units within which a line is visible / a remark overheard
export const HEARD_MAX = 4;
export const HEARD_WINDOW = { visit: 90, route: 30 };   // sim minutes

const REMARK_TEXT = {
  long_line: x => `long line at ${x}`,
  bad_service: x => `bad experience at ${x}`,
  good_experience: x => `${x} was good and quick`,
  heavy_traffic: x => `heavy traffic on ${x}`,
  clear_roads: x => `${x} was clear`
};

const UNSEEN_LINE = "unknown (can't see it from here)";
const NO_LIVE_TRAFFIC = 'unknown (no live traffic)';

// ---------- small helpers ----------

// Names come as Maps per the contract; plain objects are accepted too.
function lookup(m, k) {
  if (k == null || !m) return undefined;
  return m instanceof Map ? m.get(k) : m[k];
}

// Shallow copy without undefined, null, '' and empty arrays, so the state stays small and the
// provider never points Jev at an empty field.
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

const capitalize = s => (s ? s[0].toUpperCase() + s.slice(1) : s);

// "just now" or "about 15 minutes ago" (durationWords says "just arrived" below 2 minutes).
function agoWords(min) {
  return min < 2 ? 'just now' : `${durationWords(min)} ago`;
}

// A trip or route time; durationWords' "just arrived" would read wrong for a very short drive.
function tripWords(min) {
  return Number(min) < 2 ? 'under 2 minutes' : durationWords(min);
}

function walkedAwayWords(n) {
  const k = Math.max(0, Math.round(Number(n) || 0));
  if (k === 0) return undefined;
  if (k === 1) return 'someone just walked away';
  if (k === 2) return 'a couple of people just walked away';
  if (k <= 5) return 'several people just walked away';
  return 'many people just walked away';
}

function personObj(p, appField) {
  const person = p || {};
  return compact({
    name: person.name,
    age: Number.isFinite(Number(person.age)) && person.age !== '' && person.age != null ? Number(person.age) : undefined,
    about: person.bio,
    personality: person.personality,
    wants: person.goal,
    listens_to: person.social,
    group: person.groupName,
    [appField]: Boolean(person.informed)
  });
}

function base(ctx) {
  const spec = ctx.spec || {};
  return {
    setting: spec.context || spec.title || '',
    time: timeWords({ clockStart: Number(spec.clockStart) || 0 }, Number(ctx.t) || 0)
  };
}

function tripText(trip) {
  const from = trip?.fromName || 'the start';
  const to = trip?.toName || 'the destination';
  return `${from} to ${to}`;
}

function heardList(heard) {
  return Array.isArray(heard) ? heard.slice(0, HEARD_MAX).map(String) : [];
}

// ---------- remarks ----------

// Text of one remark by kind: "long line at St. Brigid's ER", "heavy traffic on Kessel Bridge".
export function remarkText(remark, names = {}) {
  const r = remark || {};
  const subject = r.placeId == null && r.edgeId != null
    ? (lookup(names.edge, r.edgeId) ?? String(r.edgeId))
    : (lookup(names.place, r.placeId) ?? (r.placeId != null ? String(r.placeId) : 'somewhere'));
  const text = REMARK_TEXT[r.kind];
  return text ? text(subject) : `${String(r.kind || 'remark').replace(/_/g, ' ')} about ${subject}`;
}

// Where a visit agent heard a remark from, or null if they did not hear it. Distance is straight-line,
// or walking distance when the viewer supplies `distanceTo(placeId)` (worlds with walls).
function visitSource(r, v) {
  if (r.archetypeId != null && r.archetypeId === v.archetypeId) return 'group chat';
  const pos = lookup(v.placePos, r.placeId);
  if (pos && Number.isFinite(v.x) && Number.isFinite(v.y)) {
    const d = typeof v.distanceTo === 'function' ? Number(v.distanceTo(r.placeId)) : Math.hypot(pos.x - v.x, pos.y - v.y);
    if (d <= SEE_RANGE) return 'overheard nearby';
  }
  if (v.informed) return 'app reviews';
  return null;
}

// The remarks this agent has heard: ≤ 4 strings, newest first, never their own.
// Visit: last 90 minutes, from the same group ("group chat"), about a place within 30 units
// ("overheard nearby"; on foot when viewer.distanceTo is given), or anything if they have the app ("app reviews").
// Route: last 30 minutes, everyone hears everything ("traffic radio").
export function selectHeard(remarks, viewer, names = {}) {
  const v = viewer || {};
  const route = v.mode === 'route';
  const windowMin = route ? HEARD_WINDOW.route : HEARD_WINDOW.visit;
  const now = Number(v.t) || 0;
  const list = Array.isArray(remarks) ? remarks : [];
  const picked = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (!r || (v.agentId != null && r.agentId === v.agentId)) continue;
    const ago = now - Number(r.t);
    if (ago > windowMin) break;   // sim.remarks is in nondecreasing t order
    if (!(ago >= 0)) continue;
    const source = route ? 'traffic radio' : visitSource(r, v);
    if (!source) continue;
    picked.push({ r, i, ago, source });
  }
  picked.sort((a, b) => a.ago - b.ago || b.i - a.i);
  return picked.slice(0, HEARD_MAX).map(({ r, ago, source }) =>
    `${r.personaName || r.personName || 'Someone'} (${source}, ${agoWords(ago)}): ${remarkText(r, names)}`);
}

// ---------- visit ----------

function nowText(m) {
  const moment = m || {};
  const place = moment.placeName || 'a place';
  if (moment.kind === 'line') {
    const est = Number(moment.est) || 0;
    if (est < 1) return `Just reached ${place}. There is no line.`;
    return `Just reached ${place}. The line is ${waitWords(est)}: ${patienceWords(est, moment.tolerance)}.`;
  }
  if (moment.kind === 'long') {
    const remaining = Math.max(0, Number(moment.remaining) || 0);
    const more = remaining < 2
      ? 'Almost at the front'
      : capitalize(durationWords(remaining)).replace(/ (minutes|hours)$/, ' more $1') + ' expected';
    return `Has waited ${durationWords(moment.waited)} in line at ${place}. ${more}: ` +
      `${patienceWords(remaining, moment.tolerance)}.`;
  }
  switch (moment.why) {
    case 'start': return 'Just arrived. Choosing where to go first.';
    case 'next': return `Just finished at ${place}. Choosing what to do next.`;
    case 'balked': return `Just walked away from the line at ${place}. Choosing what to do now.`;
    case 'gaveup': return `Just gave up waiting at ${place}. Choosing what to do now.`;
    default: return 'Choosing what to do next.';
  }
}

function peopleWords(n) {
  const k = Math.max(0, Math.round(Number(n) || 0));
  return k === 0 ? 'nobody in line' : k === 1 ? '1 person in line' : `${k} people in line`;
}

function placeObj(p, tolerance) {
  const visible = Boolean(p.visible);
  const est = Math.max(0, Number(p.est) || 0);
  const tags = Array.isArray(p.tags) ? p.tags.filter(Boolean) : [];
  const hasTol = Number(tolerance) > 0;
  return compact({
    option: String(p.id),
    name: p.name || String(p.id),
    known_for: p.about,
    offers: tags.join(', '),
    cost: priceWords(p.price),
    distance: distanceWords(p.dist),
    line: visible ? waitWords(est) : UNSEEN_LINE,
    // People judge a line by the head count they can see (SWARMSCOPE_SPEC.md v0.15/v0.18).
    people_ahead: visible && Number.isFinite(Number(p.ahead)) ? peopleWords(p.ahead) : undefined,
    line_vs_patience: visible && hasTol && est >= 1 ? patienceWords(est, tolerance) : undefined,
    recently: visible ? walkedAwayWords(p.walkedAway30) : undefined
  });
}

// The §5 visit observation.
export function visitObservation(ctx) {
  const c = ctx || {};
  const moment = c.moment || {};
  const placesDone = Array.isArray(c.placesDone) ? c.placesDone.filter(Boolean).map(String) : [];
  const timeInLines = Number(c.timeInLines) || 0;
  return compact({
    ...base(c),
    person: personObj(c.person, 'has_live_wait_app'),
    feeling: c.frustration == null ? undefined : feelingWords(c.frustration),
    so_far: compact({
      time_here: durationWords(c.timeHere),
      time_in_lines: timeInLines < 2 ? 'hardly any' : durationWords(timeInLines),
      places_done: placesDone
    }),
    now: nowText(moment),
    places: (Array.isArray(c.places) ? c.places : []).map(p => placeObj(p || {}, moment.tolerance)),
    heard: heardList(c.heard)
  });
}

// ---------- route ----------

function rightNow(ff, now) {
  if (now == null || !Number.isFinite(Number(now))) return NO_LIVE_TRAFFIC;
  const n = Number(now), usual = Math.max(0.0001, Number(ff) || 0);
  const tag = n > 1.3 * usual ? ' (heavy traffic)' : n <= 1.05 * usual ? ' (light traffic)' : '';
  return tripWords(n) + tag;
}

// The §5 route observation (trip start, choosing among r0..rN).
export function routeObservation(ctx) {
  const c = ctx || {};
  return compact({
    ...base(c),
    person: personObj(c.person, 'has_live_traffic'),
    trip: tripText(c.trip),
    routes: (Array.isArray(c.routes) ? c.routes : []).map(r => ({
      option: String(r.key),
      via: r.label || String(r.key),
      usual_time: tripWords(r.ff),
      right_now: rightNow(r.ff, r.now)
    })),
    heard: heardList(c.heard)
  });
}

// The §5 arrive observation (trip end, for frustration and remarks).
export function arriveObservation(ctx) {
  const c = ctx || {};
  const trip = Number(c.tripMin) || 0;
  const extra = trip - (Number(c.ffMin) || 0);
  const vsEmpty = extra < 2 ? 'about the same as on empty roads' : `${durationWords(extra)} more than on empty roads`;
  return compact({
    ...base(c),
    person: personObj(c.person, 'has_live_traffic'),
    trip: tripText(c.trip),
    took: c.took,
    time_taken: `${tripWords(trip)}, ${vsEmpty}`,
    worst_stretch: c.worstEdgeName
  });
}
