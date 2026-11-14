// Ask the room (docs/PROTOTYPE.md §17): one moment, every cast member, asked through the decision provider.
//
// A run answers "what happens over a morning". This answers a smaller question fast enough to try things
// live: "this person has just arrived and sees this line, this price and this sign: where do they go?" It
// builds the same observation the engine builds at an arrival (engine/observe.js), so nothing here is a
// separate model of the customer. It never states a patience verdict, whatever the world says.
import { normalizeSpec } from '../engine/spec.js';
import { visitObservation } from '../engine/observe.js';
import { priceWords } from '../engine/util.js';
import { buildJevRequest, parseAnswers } from '../providers/jev.js';

export const ROOM_LIMITS = { sign: 160, text: 300, ahead: 40, people: 24, price: 500 };
// Any added sentence nudges Jev's answers (docs/PROTOTYPE.md §16 findings), so a sign is always compared
// with this one, never with no sign.
export const NEUTRAL_SIGN = 'Sign on the door: Restrooms are at the back, past the counter. Please keep the doorway clear.';
// Changes smaller than this count as no change: asking Jev the same question twice differs by about 2 points
// on average and occasionally by more (measured Nov 14 on 840 decisions).
export const ROOM_NOISE = 0.05;

const clampInt = (v, lo, hi, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
const clampNum = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

const services = spec => spec.nodes.filter(n => n.kind === 'service');

// The world as the page needs it: the places a person can choose between, and the cast.
export function roomView(rawSpec) {
  const spec = normalizeSpec(rawSpec);
  if (spec.mode !== 'visit') throw new Error('Ask the room needs a visit world.');
  const places = services(spec);
  if (!places.length) throw new Error('Ask the room needs a world with at least one service place.');
  const groupName = id => spec.archetypes.find(a => a.id === id)?.name || id;
  return {
    title: spec.title, context: spec.context, leaveLabel: spec.leaveLabel,
    places: places.map(n => ({ id: n.id, name: n.name, about: n.about, price: n.price, servers: n.servers, serviceTime: n.serviceTime })),
    cast: spec.minds.map(m => ({ id: m.id, name: m.name, age: m.age, group: groupName(m.archetype), bio: m.bio, personality: m.personality, goal: m.goal, social: m.social })),
    defaults: defaultScenario(spec),
    limits: ROOM_LIMITS, neutralSign: NEUTRAL_SIGN, noise: ROOM_NOISE
  };
}

// An ordinary busy moment: each place has about two customers in line per person serving.
export function defaultScenario(spec, shop = null) {
  const places = services(spec);
  const home = places.find(n => n.id === shop) || places[0];
  const ahead = {};
  for (const n of places) ahead[n.id] = Math.min(ROOM_LIMITS.ahead, n.servers * 2);
  return { shop: home.id, ahead, price: home.price, priorPrice: null, sign: '', minute: 60 };
}

// Clamp and complete a scenario from the page. Unknown places are ignored; missing values take the defaults.
export function normalizeScenario(spec, raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const places = services(spec);
  const base = defaultScenario(spec, typeof r.shop === 'string' ? r.shop : null);
  const ahead = {};
  for (const n of places) ahead[n.id] = clampInt(r.ahead?.[n.id], 0, ROOM_LIMITS.ahead, base.ahead[n.id]);
  const price = clampNum(r.price, 0, ROOM_LIMITS.price, base.price);
  const prior = r.priorPrice == null || r.priorPrice === '' ? null : clampNum(r.priorPrice, 0, ROOM_LIMITS.price, null);
  return {
    shop: base.shop, ahead, price,
    priorPrice: prior != null && priceWords(prior) !== priceWords(price) ? prior : null,
    sign: text(r.sign, ROOM_LIMITS.sign),
    minute: clampInt(r.minute, 0, spec.duration, base.minute)
  };
}

// A cast member with the page's edits applied (one ask only; the world file is never changed).
function personWith(mind, edit) {
  const e = edit && typeof edit === 'object' ? edit : {};
  const pick = k => (typeof e[k] === 'string' && e[k].trim() ? text(e[k], ROOM_LIMITS.text) : mind[k]);
  return { ...mind, bio: pick('bio'), personality: pick('personality'), goal: pick('goal') };
}

// The DecisionRequest for one person at this moment: an arrival choice between the service places and leaving,
// built by the engine's own observation code.
export function roomRequest(spec, mind, scenario, tag = 'now') {
  const places = services(spec);
  const gate = spec.nodes.find(n => n.kind !== 'service') || { x: 50, y: 50 };
  const group = spec.archetypes.find(a => a.id === mind.archetype);
  const observation = visitObservation({
    spec, t: scenario.minute,
    person: { name: mind.name, age: mind.age, bio: mind.bio, personality: mind.personality, goal: mind.goal, social: mind.social, groupName: group?.name, informed: false },
    frustration: null, timeHere: 0, timeInLines: 0, placesDone: [],
    moment: { kind: 'choose', why: 'start', placeName: null },
    places: places.map(n => {
      const ahead = scenario.ahead[n.id] ?? 0;
      const price = n.id === scenario.shop ? scenario.price : n.price;
      return {
        id: n.id, name: n.name, about: n.about, tags: n.tags, price, listPrice: price,
        dist: Math.hypot(n.x - gate.x, n.y - gate.y), visible: true,
        est: ahead > 0 ? (ahead + 1) * n.serviceTime / n.servers : 0, ahead, walkedAway30: 0
      };
    }),
    offers: scenario.sign ? [scenario.sign] : undefined
  });
  if (scenario.priorPrice != null) {
    const p = observation.places.find(x => x.option === scenario.shop);
    if (p) p.cost = `${p.cost} (it was ${priceWords(scenario.priorPrice)} last week)`;
  }
  return {
    id: `room-${tag}-${mind.id}`, kind: 'choose', why: 'start', agentId: 0, personaId: mind.id,
    placeId: null, aboutPlace: null, remarkKinds: null,
    options: [...places.map(n => ({ key: n.id, label: `Go to ${n.name}` })), { key: 'leave', label: spec.leaveLabel }],
    asks: { choice: 'next_place', yesNo: null, frustration: false, tellOthers: false },
    observation
  };
}

const probsOf = (decision, keys) => {
  const p = decision?.choiceProbs;
  if (!p || typeof p !== 'object') return null;
  const out = {};
  for (const k of keys) out[k] = Number(p[k]) || 0;
  return out;
};

// Ask every (or the chosen) cast member three things at most:
//   before: the comparison scenario, with the person as written in the world;
//   now: the scenario on the page, with the page's edits to that person;
//   neutral: as `now` but with the neutral sign, only when `now` has a sign.
// `provider` is any decision provider (Jev with option order fixed, or recordProvider below).
export async function askRoom({ spec: rawSpec, scenario, compareTo = null, edits = {}, only = null, provider }) {
  const spec = normalizeSpec(rawSpec);
  if (spec.mode !== 'visit') throw new Error('Ask the room needs a visit world.');
  const now = normalizeScenario(spec, scenario);
  const before = normalizeScenario(spec, compareTo || { shop: now.shop });
  const wanted = Array.isArray(only) && only.length ? new Set(only.map(String)) : null;
  const minds = spec.minds.filter(m => !wanted || wanted.has(m.id)).slice(0, ROOM_LIMITS.people);
  const keys = [...services(spec).map(n => n.id), 'leave'];

  const jobs = [];
  for (const m of minds) {
    const edited = personWith(m, edits?.[m.id]);
    jobs.push({ m, arm: 'before', req: roomRequest(spec, m, before, 'before') });
    jobs.push({ m, arm: 'now', req: roomRequest(spec, edited, now, 'now') });
    if (now.sign) jobs.push({ m, arm: 'neutral', req: roomRequest(spec, edited, { ...now, sign: NEUTRAL_SIGN }, 'neutral') });
  }
  const decisions = await provider.decideMany(jobs.map(j => j.req), { spec });
  if (!Array.isArray(decisions) || decisions.length !== jobs.length) throw new Error('The provider did not answer every question.');

  const groupName = id => spec.archetypes.find(a => a.id === id)?.name || id;
  const people = minds.map(m => {
    const mine = jobs.map((j, i) => ({ ...j, d: decisions[i] })).filter(j => j.m === m);
    const arm = name => mine.find(j => j.arm === name);
    const nowJob = arm('now');
    const edited = personWith(m, edits?.[m.id]);
    const sources = mine.map(j => j.d?.provider || 'missing');
    const obs = nowJob.req.observation;
    return {
      id: m.id, name: m.name, age: m.age, group: groupName(m.archetype),
      bio: edited.bio, personality: edited.personality, goal: edited.goal,
      edited: edited.bio !== m.bio || edited.personality !== m.personality || edited.goal !== m.goal,
      before: probsOf(arm('before')?.d, keys), now: probsOf(nowJob.d, keys), neutral: arm('neutral') ? probsOf(arm('neutral').d, keys) : null,
      told: { time: obs.time, now: obs.now, places: obs.places.map(p => ({ id: p.option, name: p.name, cost: p.cost, line: p.line, people: p.people_ahead })), sign: obs.offers?.[0] || '' },
      source: sources.every(s => s === 'jev' || s === 'jev-cache' || s === 'recorded')
        ? (sources.some(s => s === 'jev') ? 'live' : 'recorded')
        : 'failed'
    };
  });

  const answered = people.filter(p => p.before && p.now);
  const mean = f => (answered.length ? answered.reduce((s, p) => s + f(p), 0) / answered.length : null);
  return {
    shop: now.shop, scenario: now, compareTo: before, neutralSign: now.sign ? NEUTRAL_SIGN : null, noise: ROOM_NOISE,
    share: { before: mean(p => p.before[now.shop]), now: mean(p => p.now[now.shop]), neutral: now.sign ? mean(p => (p.neutral ? p.neutral[now.shop] : p.now[now.shop])) : null },
    asked: jobs.length, failed: people.filter(p => p.source === 'failed').length, people
  };
}

// Answers only from recorded Jev answers (a Map of requestHash → { answers, model }), for showing the page
// without a network. A question that was never asked live comes back unanswered.
export function recordProvider(record, { model = 'jev-latest' } = {}) {
  return {
    name: 'recorded', external: true,
    async decideMany(requests, ctx = {}) {
      return requests.map(req => {
        const { requestHash } = buildJevRequest(req, { model, spec: ctx?.spec ?? null, shuffle: false });
        const hit = record.get(requestHash);
        if (!hit || !hit.answers) return { provider: 'missing', requestHash };
        return { provider: 'recorded', ...parseAnswers(req, hit.answers), model: hit.model, requestHash };
      });
    }
  };
}
