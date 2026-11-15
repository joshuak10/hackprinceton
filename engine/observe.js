// Builds the JSON-safe observation an agent decides from (the Jev `state`). Pure functions: the Sim
// gathers the inputs (docs/PROTOTYPE.md §12a) and this module turns every number into words (§5),
// because Jev compares words far better than numbers.
import {
  waitWords, patienceWords, durationWords, distanceWords, priceWords, timeWords, feelingWords
} from './util.js';

export const SEE_RANGE = 30;          // map units within which a line is visible / a remark overheard
export const HEARD_MAX = 4;
export const OFFERS_MAX = 3;          // offer texts one observation shows (§15b)
export const HEARD_WINDOW = { visit: 90, route: 30 };   // sim minutes
export const MEMORY_MAX = 5;          // remembered events one morning observation shows (§20a)

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
    ...(appField ? { [appField]: Boolean(person.informed) } : {})
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

// Offer texts the agent has received, in world order; omitted from the state when there are none.
function offerList(offers) {
  return Array.isArray(offers) ? offers.filter(Boolean).slice(0, OFFERS_MAX).map(String) : [];
}

// "about $20", or with an offer that changes the words: "about $10 with the offer (usually about $20)".
function costWords(price, listPrice) {
  const now = priceWords(price);
  if (listPrice == null || !(Number(price) < Number(listPrice))) return now;
  const usual = priceWords(listPrice);
  return now === usual ? now : `${now} with the offer (usually ${usual})`;
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

// `tellPatience` false (the world's waiting.tellPatience, §16) leaves out the engine's verdict on how the
// line compares with the group's patience number, so the decision model judges that from the person.
// `seesPeople` (waiting.lineShows 'people', §16b, for a person without a live wait app) replaces the wait in
// minutes with what anyone at the counter can see: the people in line and the staff serving. There is no
// patience verdict then, because that verdict compares a wait in minutes.
function nowText(m, tellPatience = true, seesPeople = false) {
  const moment = m || {};
  const place = moment.placeName || 'a place';
  if (seesPeople && moment.kind === 'line') {
    const ahead = Math.max(0, Math.round(Number(moment.ahead) || 0));
    const staff = staffWords(moment.staff);
    if (ahead === 0) return `Just reached ${place}. There is no line${staff ? `; ${staff}` : ''}.`;
    return `Just reached ${place}. ${capitalize(peopleWords(ahead))}${staff ? `, ${staff}` : ''}.`;
  }
  if (seesPeople && moment.kind === 'long') {
    const ahead = Math.max(0, Math.round(Number(moment.ahead) || 0));
    const staff = staffWords(moment.staff);
    const more = ahead === 0 ? 'Next to be served' : `${ahead === 1 ? '1 person' : `${ahead} people`} still ahead`;
    return `Has waited ${durationWords(moment.waited)} in line at ${place}. ${more}${staff ? `, ${staff}` : ''}.`;
  }
  if (moment.kind === 'line') {
    const est = Number(moment.est) || 0;
    if (est < 1) return `Just reached ${place}. There is no line.`;
    if (!tellPatience) return `Just reached ${place}. The line is ${waitWords(est)}.`;
    return `Just reached ${place}. The line is ${waitWords(est)}: ${patienceWords(est, moment.tolerance)}.`;
  }
  if (moment.kind === 'long') {
    const remaining = Math.max(0, Number(moment.remaining) || 0);
    const more = remaining < 2
      ? 'Almost at the front'
      : capitalize(durationWords(remaining)).replace(/ (minutes|hours)$/, ' more $1') + ' expected';
    if (!tellPatience) return `Has waited ${durationWords(moment.waited)} in line at ${place}. ${more}.`;
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

// "2 staff serving"; undefined when the count is unknown.
function staffWords(n) {
  const k = Math.round(Number(n));
  return Number.isFinite(k) && k > 0 ? `${k} staff serving` : undefined;
}

function placeObj(p, tolerance, seesPeople = false) {
  const visible = Boolean(p.visible);
  if (seesPeople && visible) {
    // waiting.lineShows 'people' (§16b): the head count and the staff serving, no wait in minutes.
    return compact({
      option: String(p.id),
      name: p.name || String(p.id),
      known_for: p.about,
      offers: (Array.isArray(p.tags) ? p.tags.filter(Boolean) : []).join(', '),
      cost: costWords(p.price, p.listPrice),
      distance: distanceWords(p.dist),
      people_ahead: peopleWords(p.ahead),
      staff: staffWords(p.staff),
      recently: walkedAwayWords(p.walkedAway30)
    });
  }
  const est = Math.max(0, Number(p.est) || 0);
  const tags = Array.isArray(p.tags) ? p.tags.filter(Boolean) : [];
  const hasTol = Number(tolerance) > 0;
  return compact({
    option: String(p.id),
    name: p.name || String(p.id),
    known_for: p.about,
    offers: tags.join(', '),
    cost: costWords(p.price, p.listPrice),
    distance: distanceWords(p.dist),
    line: visible ? waitWords(est) : UNSEEN_LINE,
    // People judge a line by the head count they can see (SWARMSCOPE_SPEC.md v0.15/v0.18).
    people_ahead: visible && Number.isFinite(Number(p.ahead)) ? peopleWords(p.ahead) : undefined,
    line_vs_patience: visible && hasTol && est >= 1 ? patienceWords(est, tolerance) : undefined,
    recently: visible ? walkedAwayWords(p.walkedAway30) : undefined
  });
}

// The §5 visit observation. ctx.places[].listPrice (optional) is the price before any offer, and
// ctx.offers (optional) the texts of the offers this agent receives (§15b).
export function visitObservation(ctx) {
  const c = ctx || {};
  const moment = c.moment || {};
  const placesDone = Array.isArray(c.placesDone) ? c.placesDone.filter(Boolean).map(String) : [];
  const timeInLines = Number(c.timeInLines) || 0;
  const tellPatience = c.spec?.waiting?.tellPatience !== false;
  // A person with a live wait app still sees minutes: the app shows them.
  const seesPeople = c.spec?.waiting?.lineShows === 'people' && !c.person?.informed;
  return compact({
    ...base(c),
    person: personObj(c.person, 'has_live_wait_app'),
    feeling: c.frustration == null ? undefined : feelingWords(c.frustration),
    so_far: compact({
      time_here: durationWords(c.timeHere),
      time_in_lines: timeInLines < 2 ? 'hardly any' : durationWords(timeInLines),
      places_done: placesDone
    }),
    now: nowText(moment, tellPatience, seesPeople),
    places: (Array.isArray(c.places) ? c.places : []).map(p => placeObj(p || {}, tellPatience ? moment.tolerance : null, seesPeople)),
    offers: offerList(c.offers),
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

// The §5 route observation (trip start, choosing among r0..rN). ctx.offers as in visitObservation.
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
    offers: offerList(c.offers),
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

// ---------- morning (repeat visits, §20) ----------

// "$5.50": the morning question gives exact prices, because a 50-cent change is the fact being remembered.
export function moneyWords(p) {
  const x = Number(p);
  return Number.isFinite(x) && x > 0 ? `$${x.toFixed(2)}` : 'free';
}

// "Yesterday", "3 days ago", "1 week ago", "4 weeks ago".
function whenWords(daysAgo) {
  const d = Math.max(0, Math.round(Number(daysAgo) || 0));
  if (d === 0) return 'Earlier today';
  if (d === 1) return 'Yesterday';
  if (d % 7 === 0) return d === 7 ? '1 week ago' : `${d / 7} weeks ago`;
  return `${d} days ago`;
}

function minutesWords(m) {
  const n = Math.max(1, Math.round(Number(m) || 0));
  return `about ${n} minute${n === 1 ? '' : 's'}`;
}

// One remembered event as a fact in words, never a verdict (§16, §20a). A visit to the shop is
// { daysAgo, wait, outcome: 'served' | 'left', ending: 'fast' | 'slow', paid, promo, first }; anything else is
// { daysAgo, text }. `wait` is the worst wait of the visit in minutes, and `ending` how the line moved at the
// end, because people remember the worst and the last moment of a wait (the peak-end rule).
export function memoryWords(m, shopName = 'the shop') {
  const r = m || {};
  const when = whenWords(r.daysAgo) + (r.first ? ' (first visit)' : '');
  if (typeof r.text === 'string' && r.text.trim()) return `${when}: ${r.text.trim().replace(/[.\s]+$/, '')}.`;
  const wait = Math.max(0, Number(r.wait) || 0);
  const left = r.outcome === 'left';
  const parts = [];
  if (wait < 1) parts.push(left ? `no line at ${shopName}` : `no line at ${shopName}, served right away`);
  else {
    const moved = r.ending === 'fast' ? ', slow at first and quick at the end'
      : r.ending === 'slow' ? ', quick at first and stalled just before the counter' : '';
    parts.push(`waited ${minutesWords(wait)} in line at ${shopName}${moved}`);
  }
  if (left) parts.push('then left without ordering');
  else if (wait >= 1) parts.push('then was served');
  let text = parts.join(', ');
  if (!left && r.paid != null) text += `, and paid ${moneyWords(r.paid)}${r.promo ? ` with a ${r.promo}` : ''}`;
  return `${when}: ${text}.`;
}

// The shop's price today, with the offer price or what the person paid last week when either is given.
function morningCost(shop) {
  const now = moneyWords(shop.price);
  if (shop.offerPrice != null && Number(shop.offerPrice) < Number(shop.price)) {
    return `${moneyWords(shop.offerPrice)} with the offer (usually ${now})`;
  }
  if (shop.wasPrice == null) return now;
  return moneyWords(shop.wasPrice) === now ? `${now} (the same as last week)` : `${now} (it was ${moneyWords(shop.wasPrice)} last week)`;
}

function ratingWords(r) {
  const x = Number(r);
  return r != null && r !== '' && Number.isFinite(x) ? `${x.toFixed(1)} out of 5 stars from online reviews` : undefined;
}

// { visits, weeks, via }: how well the person knows the shop. `via` says how someone who has never been knows of it.
function historyWords(h, shopName) {
  if (!h || h.visits == null || !Number.isFinite(Number(h.visits))) return undefined;
  const n = Math.max(0, Math.round(Number(h.visits)));
  if (n === 0) return `Has never been to ${shopName}${h.via ? `; ${String(h.via)}` : ''}.`;
  const weeks = Math.round(Number(h.weeks));
  const span = weeks > 0 ? ` in the last ${weeks === 1 ? 'week' : `${weeks} weeks`}` : '';
  return `Has been to ${shopName} ${n === 1 ? 'once' : `${n} times`}${span}.`;
}

// { have, need, free, reward }: stamp-card progress. `free` stamps were given at sign-up (the head start).
function cardWords(card, shopName) {
  if (!card || !Number.isFinite(Number(card.need)) || Number(card.need) < 1) return undefined;
  const have = Math.max(0, Math.round(Number(card.have) || 0)), need = Math.round(Number(card.need));
  const free = Math.max(0, Math.round(Number(card.free) || 0));
  const given = free > 0 ? ` (the first ${free} ${free === 1 ? 'was' : 'were'} given free at sign-up)` : '';
  return `Stamp card for ${shopName}: ${have} of ${need} stamps filled${given}. A full card earns ${card.reward || 'a free one'}.`;
}

// The §20a morning observation: does this person go to the shop today? Nothing is seen from inside a visit,
// so there are no lines. ctx: { spec, t, person, shop: { name, about, tags, price, wasPrice, offerPrice, rating },
// others: [{ name, about, price }], history, memory: [records], card, heard: [strings], offers: [strings] }.
export function morningObservation(ctx) {
  const c = ctx || {};
  const shop = c.shop || {};
  const name = shop.name || 'the shop';
  const tags = Array.isArray(shop.tags) ? shop.tags.filter(Boolean) : [];
  return compact({
    ...base(c),
    person: personObj(c.person),
    now: `Deciding whether to go to ${name} today.`,
    shop: compact({ name, known_for: shop.about, offers: tags.join(', '), cost: morningCost(shop), rating: ratingWords(shop.rating) }),
    other_places: (Array.isArray(c.others) ? c.others : []).map(o => compact({ name: o.name, known_for: o.about, cost: moneyWords(o.price) })),
    history: historyWords(c.history, name),
    memory: (Array.isArray(c.memory) ? c.memory : []).slice(0, MEMORY_MAX).map(m => memoryWords(m, name)),
    card: cardWords(c.card, name),
    heard: heardList(c.heard),
    offers: offerList(c.offers)
  });
}
