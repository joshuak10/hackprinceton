#!/usr/bin/env node
// Live Jev sanity checks (docs/PROTOTYPE.md §11). Opt-in: this makes real API calls, at most
// MAX_HTTP_CALLS of them (retries included).
//   1. Join probability across a ladder of waits for two personas: it should fall as the wait grows.
//   2. Option-order consistency: the same choice asked with its options in two orders.
// Usage: node validation/jev-sanity.js [--model jev-latest]
import { pathToFileURL } from 'node:url';
import { loadEnv } from '../engine/env.js';
import { waitWords, patienceWords } from '../engine/util.js';
import { JevProvider, PRICE_PER_MTOK_USD } from '../providers/jev.js';

export const WAITS = [5, 15, 30, 45, 60, 90];
export const MAX_HTTP_CALLS = 99;
const MAX_RISE = 0.05;    // a step up smaller than this counts as noise, not a violation
const MIN_DROP = 0.2;     // join probability must fall at least this much from 5 to 90 minutes
const MAX_ORDER_DELTA = 0.2;

const SETTING = 'Sunday afternoon at Harbor Lights Park, a seaside amusement park.';
const SPEC = {
  title: 'Harbor Lights Park', mode: 'visit',
  nodes: [
    { id: 'sky_wheel', name: 'Sky Wheel' }, { id: 'carousel', name: 'Carousel' },
    { id: 'thunder_spine', name: 'Thunder Spine' }, { id: 'log_flume', name: 'Log Flume' },
    { id: 'bumper_boats', name: 'Bumper Boats' }, { id: 'teacups', name: 'Teacups' }
  ],
  edges: []
};

export const PERSONAS = [
  {
    id: 'parent', label: 'impatient parent, sick toddler', patience: 15,
    person: {
      name: 'Dana Whitfield', age: 33,
      about: 'Parent whose two-year-old woke up with a fever and has been cranky and coughing all afternoon. Promised her older son one last ride before heading home.',
      personality: 'impatient, stressed, protective', wants: 'one quick ride for her son, then get the toddler home to bed',
      listens_to: 'the parents group chat', group: 'Families', has_live_wait_app: true
    }
  },
  {
    id: 'retiree', label: 'relaxed retiree', patience: 60,
    person: {
      name: 'Walter Hughes', age: 71,
      about: 'Retired schoolteacher spending a slow afternoon at the park with his wife. Nowhere to be until dinner.',
      personality: 'relaxed, unhurried, happy to chat with strangers in line', wants: 'ride the Sky Wheel and enjoy the afternoon',
      listens_to: 'his wife', group: 'Retirees', has_live_wait_app: false
    }
  }
];

const remarkKinds = name => [
  { key: 'long_line', label: `Warn about a long line or wait at ${name}` },
  { key: 'bad_service', label: `Complain about bad service at ${name}` },
  { key: 'good_experience', label: `Say ${name} was good and quick` }
];

// A `line` DecisionRequest exactly as the engine would build it (contract §4 and §5).
export function ladderRequest(persona, wait, index) {
  const line = waitWords(wait);
  const vs = patienceWords(wait, persona.patience);
  return {
    id: `s${index}`, t: 360, clock: '14:00', kind: 'line', why: null, agentId: index, decisionIndex: 0,
    personaId: persona.id, personaName: persona.person.name, archetypeId: persona.id,
    placeId: 'sky_wheel', aboutPlace: 'sky_wheel', aboutEdge: null,
    asks: { choice: 'next_place', yesNo: 'join', frustration: true, tellOthers: true },
    options: [{ key: 'carousel', label: 'Go to Carousel' }, { key: 'leave', label: 'Leave and go home' }],
    remarkKinds: remarkKinds('Sky Wheel'),
    observation: {
      setting: SETTING, time: 'around 2:00 pm', person: persona.person,
      so_far: { time_here: 'about 90 minutes', time_in_lines: 'about 25 minutes', places_done: ['Bumper Boats'] },
      now: `Just reached Sky Wheel. The line is ${line}: ${vs}.`,
      places: [
        { option: 'sky_wheel', name: 'Sky Wheel', known_for: 'a slow, gentle ride with views over the harbor', offers: 'views, family', cost: 'free', distance: 'right here', line, line_vs_patience: vs },
        { option: 'carousel', name: 'Carousel', known_for: 'a classic carousel for all ages', offers: 'family, gentle', cost: 'free', distance: 'close', line: waitWords(5), line_vs_patience: patienceWords(5, persona.patience) }
      ],
      heard: []
    },
    auto: { action: wait < persona.patience ? 'yes' : 'carousel' }
  };
}

const VISITOR = {
  name: 'Maya Torres', age: 28, about: 'Visiting the park for the day with two friends.',
  personality: 'easygoing, likes thrills', wants: 'ride as much as possible today',
  listens_to: 'her friends', group: 'Young adults', has_live_wait_app: true
};

const place = (option, name, known_for, offers, wait) => ({
  option, name, known_for, offers, cost: 'free', distance: 'close', line: waitWords(wait), line_vs_patience: patienceWords(wait, 40)
});

export const ORDER_SCENARIOS = [
  {
    name: 'clear winner',
    places: [
      place('thunder_spine', 'Thunder Spine', 'the tallest coaster in the state', 'coaster, thrill', 70),
      place('sky_wheel', 'Sky Wheel', 'slow views over the harbor', 'views, family', 5),
      place('log_flume', 'Log Flume', 'getting soaked', 'water, thrill', 60)
    ]
  },
  {
    name: 'close call',
    places: [
      place('thunder_spine', 'Thunder Spine', 'the tallest coaster in the state', 'coaster, thrill', 20),
      place('log_flume', 'Log Flume', 'a big splash at the end', 'water, thrill', 20),
      place('sky_wheel', 'Sky Wheel', 'slow views over the harbor', 'views, family', 15)
    ]
  },
  {
    name: 'all similar',
    places: [
      place('carousel', 'Carousel', 'a classic carousel', 'family, gentle', 5),
      place('teacups', 'Teacups', 'spinning cups', 'family, gentle', 5),
      place('bumper_boats', 'Bumper Boats', 'splashy bumper boats', 'family, water', 5)
    ]
  }
];

// A `choose` (why: start) request whose options come in the given order.
export function orderRequest(scenario, reversed, index) {
  const options = [...scenario.places.map(p => ({ key: p.option, label: `Go to ${p.name}` })), { key: 'leave', label: 'Leave and go home' }];
  return {
    id: `o${index}`, t: 30, clock: '12:30', kind: 'choose', why: 'start', agentId: 100 + index, decisionIndex: 0,
    personaId: 'maya', personaName: VISITOR.name, archetypeId: 'young_adults',
    placeId: null, aboutPlace: null, aboutEdge: null,
    asks: { choice: 'next_place', yesNo: null, frustration: false, tellOthers: false },
    options: reversed ? options.slice().reverse() : options,
    remarkKinds: null,
    observation: {
      setting: SETTING, time: 'around 12:30 pm', person: VISITOR,
      so_far: { time_here: 'just arrived', time_in_lines: 'just arrived', places_done: [] },
      now: 'Just arrived. Choosing where to go first.',
      places: scenario.places, heard: []
    },
    auto: { action: scenario.places[0].option }
  };
}

// Hard cap on HTTP calls, retries included: past the cap the call fails without touching the network.
function cappedFetch(fetchFn, cap) {
  let calls = 0;
  const fn = (url, init) => {
    if (calls >= cap) return Promise.reject(new Error(`sanity cap of ${cap} HTTP calls reached`));
    calls++;
    return fetchFn(url, init);
  };
  Object.defineProperty(fn, 'calls', { get: () => calls });
  return fn;
}

const topKey = probs => Object.entries(probs || {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
const f2 = x => (x == null ? '  -  ' : x.toFixed(2));

function judgeLadder(probs) {
  let maxRise = 0;
  for (let i = 1; i < probs.length; i++) maxRise = Math.max(maxRise, probs[i] - probs[i - 1]);
  const drop = probs[0] - probs[probs.length - 1];
  return { maxRise, drop, pass: maxRise <= MAX_RISE && drop >= MIN_DROP };
}

export async function runSanity({ apiKey, model = 'jev-latest', fetch = globalThis.fetch, log = console.log } = {}) {
  const http = cappedFetch(fetch, MAX_HTTP_CALLS);
  const common = { apiKey, model, fetch: http, concurrency: 8, maxRequests: 40, retry: { attempts: 3 } };
  const jev = new JevProvider(common);
  const plain = new JevProvider({ ...common, shuffle: false });   // option order exactly as given
  const ctx = { seed: 7, spec: SPEC };
  const problems = [];

  // 1. Join ladder
  const ladderReqs = PERSONAS.flatMap((p, pi) => WAITS.map((w, wi) => ladderRequest(p, w, pi * WAITS.length + wi + 1)));
  const ladderDs = await jev.decideMany(ladderReqs, ctx);
  ladderDs.filter(d => d.error).forEach(d => problems.push(d.error));
  const ladder = PERSONAS.map((p, pi) => {
    const probs = WAITS.map((_, wi) => ladderDs[pi * WAITS.length + wi].yesProb ?? null);
    const complete = probs.every(x => x != null);
    return { persona: p.id, label: p.label, patience: p.patience, probs, ...(complete ? judgeLadder(probs) : { pass: false }) };
  });

  // 2. Option order
  const orderReqs = ORDER_SCENARIOS.flatMap((s, si) => [orderRequest(s, false, si * 2 + 1), orderRequest(s, true, si * 2 + 2)]);
  const orderDs = await plain.decideMany(orderReqs, ctx);
  orderDs.filter(d => d.error).forEach(d => problems.push(d.error));
  const order = ORDER_SCENARIOS.map((s, si) => {
    const a = orderDs[si * 2].choiceProbs, b = orderDs[si * 2 + 1].choiceProbs;
    if (!a || !b) return { scenario: s.name, pass: false };
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    const maxDelta = Math.max(...keys.map(k => Math.abs((a[k] ?? 0) - (b[k] ?? 0))));
    const first = orderReqs[si * 2].options[0].key;
    return {
      scenario: s.name, topA: topKey(a), topB: topKey(b), maxDelta,
      firstBias: (a[first] ?? 0) - (b[first] ?? 0),   // same option, shown first vs. shown last
      pass: maxDelta <= MAX_ORDER_DELTA
    };
  });

  const stats = [jev.stats(), plain.stats()];
  const resolvedModel = stats.find(s => s.requests)?.model ?? model;
  const pass = problems.length === 0 && ladder.every(r => r.pass) && order.every(r => r.pass);

  log(`Jev sanity check  (model ${resolvedModel})`);
  log('');
  log('1. Join probability vs. wait: should fall as the wait grows');
  log(`   ${'wait (min)'.padEnd(48)}${WAITS.map(w => String(w).padStart(6)).join('')}`);
  for (const r of ladder) log(`   ${`${r.label} (patience ${r.patience})`.padEnd(48)}${r.probs.map(x => f2(x).padStart(6)).join('')}`);
  for (const r of ladder) {
    const detail = r.drop == null ? 'missing answers' : `drop ${r.drop.toFixed(2)} (need >= ${MIN_DROP}), largest rise ${r.maxRise.toFixed(2)} (allowed <= ${MAX_RISE})`;
    log(`   ${r.pass ? 'PASS' : 'FAIL'}  ${r.label}: ${detail}`);
  }
  const avg = r => r.probs.reduce((s, x) => s + (x ?? 0), 0) / r.probs.length;
  log(`   info: mean join probability ${ladder.map(r => `${r.persona} ${avg(r).toFixed(2)}`).join(', ')}`);
  log('');
  log('2. Option-order consistency: same choice, options in two orders');
  log(`   ${'scenario'.padEnd(16)}${'top (order A)'.padEnd(16)}${'top (reversed)'.padEnd(16)}${'max |dp|'.padStart(9)}${'first-slot bias'.padStart(17)}`);
  for (const r of order) {
    log(`   ${r.scenario.padEnd(16)}${String(r.topA ?? '-').padEnd(16)}${String(r.topB ?? '-').padEnd(16)}${f2(r.maxDelta).padStart(9)}${(r.firstBias == null ? '-' : (r.firstBias >= 0 ? '+' : '') + r.firstBias.toFixed(2)).padStart(17)}  ${r.pass ? 'PASS' : 'FAIL'}`);
  }
  log(`   (PASS when max |dp| <= ${MAX_ORDER_DELTA}; first-slot bias = P(option shown first) - P(same option shown last))`);
  log('');
  const requests = stats.reduce((s, x) => s + x.requests, 0);
  const tokens = stats.reduce((s, x) => s + x.inputTokens, 0);
  const lat = stats[0].latency;
  log(`Requests: ${requests} (${http.calls} HTTP calls, cap ${MAX_HTTP_CALLS}), fallbacks ${stats.reduce((s, x) => s + x.fallbacks, 0)}, ` +
      `input tokens ${tokens}, est. cost $${(tokens * PRICE_PER_MTOK_USD / 1e6).toFixed(6)} (unverified), latency p50 ${lat.p50} ms / p95 ${lat.p95} ms`);
  for (const p of [...new Set(problems)]) log(`Error: ${p}`);
  log(`Overall: ${pass ? 'PASS' : 'FAIL'}`);

  return { pass, model: resolvedModel, ladder, order, problems, httpCalls: http.calls, stats };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  const i = process.argv.indexOf('--model');
  const model = i > 0 && process.argv[i + 1] ? process.argv[i + 1] : 'jev-latest';
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    console.error('TYPESAFE_API_KEY is not set. Put it in .env.local (see .env.example) to run the live Jev sanity check.');
    process.exit(2);
  }
  runSanity({ apiKey, model })
    .then(r => process.exit(r.pass ? 0 : 1))
    .catch(err => { console.error(`Sanity check aborted: ${err.message}`); process.exit(2); });
}
