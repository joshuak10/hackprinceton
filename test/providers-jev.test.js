// JevProvider tests with a mocked fetch (no network). Fixtures are hand-built DecisionRequests
// for every kind, shaped exactly as docs/PROTOTYPE.md §4 and §5 describe.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createHash } from 'node:crypto';
import {
  JevProvider, JevAuthError, buildJevRequest, parseAnswers, parseRetryAfter, FRUSTRATION_LEVELS, PRICE_NOTE
} from '../providers/jev.js';

// ---------- fixtures ----------

const SPEC = {
  title: 'Harbor Lights Park', mode: 'visit',
  nodes: [
    { id: 'gate', name: 'Main Gate', kind: 'gate' },
    { id: 'thunder_spine', name: 'Thunder Spine', kind: 'service' },
    { id: 'sky_wheel', name: 'Sky Wheel', kind: 'service' },
    { id: 'log_flume', name: 'Log Flume', kind: 'service' },
    { id: 'canal', name: 'Canal Junction', kind: 'intersection' },
    { id: 'ferry', name: 'Ferry Landing', kind: 'destination' }
  ],
  edges: [{ from: 'canal', to: 'ferry', name: 'Canal St', length: 4, capacity: 60, twoWay: true }]
};

const PERSON = {
  name: 'Priya Shah', age: 34, about: 'Parent of two on a day trip from Trenton.',
  personality: 'organized, impatient with crowds', wants: 'ride Thunder Spine before lunch',
  listens_to: 'the family group chat', group: 'Families', has_live_wait_app: true
};

const VISIT_PLACES = [
  { option: 'thunder_spine', name: 'Thunder Spine', known_for: 'the tallest coaster in the state', offers: 'coaster, thrill', cost: 'free', distance: 'a short walk', line: 'long, about 45 min', line_vs_patience: 'more than they will put up with' },
  { option: 'sky_wheel', name: 'Sky Wheel', known_for: 'slow views over the harbor', offers: 'views, family', cost: 'free', distance: 'close', line: 'short, about 5 min', line_vs_patience: 'well within what they will put up with' },
  { option: 'log_flume', name: 'Log Flume', known_for: 'getting soaked', offers: 'water, family', cost: 'about $5', distance: 'far', line: "unknown (can't see it from here)" }
];

const VISIT_OPTIONS = [
  { key: 'thunder_spine', label: 'Go to Thunder Spine' },
  { key: 'sky_wheel', label: 'Go to Sky Wheel' },
  { key: 'log_flume', label: 'Go to Log Flume' },
  { key: 'leave', label: 'Leave and go home' }
];

const remarkKindsAt = name => [
  { key: 'long_line', label: `Warn about a long line or wait at ${name}` },
  { key: 'bad_service', label: `Complain about bad service at ${name}` },
  { key: 'good_experience', label: `Say ${name} was good and quick` }
];

const base = {
  personaId: 'priya', personaName: 'Priya Shah', archetypeId: 'family',
  placeId: null, aboutPlace: null, aboutEdge: null, why: null, remarkKinds: null
};

const chooseStart = {
  ...base, id: 'd1', t: 0.5, clock: '09:00', kind: 'choose', why: 'start', agentId: 1, decisionIndex: 0,
  asks: { choice: 'next_place', yesNo: null, frustration: false, tellOthers: false },
  options: VISIT_OPTIONS,
  observation: {
    setting: 'Saturday at Harbor Lights Park.', time: 'around 9:00 am', person: PERSON,
    so_far: { time_here: 'just arrived', time_in_lines: 'just arrived', places_done: [] },
    now: 'Just arrived. Choosing where to go first.',
    places: VISIT_PLACES, heard: []
  },
  auto: { action: 'thunder_spine' }
};

const chooseNext = {
  ...base, id: 'd17', t: 123.5, clock: '11:03', kind: 'choose', why: 'next', agentId: 1, decisionIndex: 3,
  aboutPlace: 'thunder_spine',
  asks: { choice: 'next_place', yesNo: null, frustration: true, tellOthers: true },
  options: VISIT_OPTIONS.filter(o => o.key !== 'thunder_spine'),
  remarkKinds: remarkKindsAt('Thunder Spine'),
  observation: {
    setting: 'Saturday at Harbor Lights Park.', time: 'around 11:00 am', person: PERSON, feeling: 'mildly annoyed',
    so_far: { time_here: 'about 125 minutes', time_in_lines: 'about 50 minutes', places_done: ['Thunder Spine'] },
    now: 'Just finished at Thunder Spine. Choosing what to do next.',
    places: VISIT_PLACES.slice(1),
    heard: ['Marcus Lee (group chat, about 15 minutes ago): long line at Thunder Spine']
  },
  auto: { action: 'sky_wheel' }
};

const lineReq = {
  ...base, id: 'd23', t: 130, clock: '11:10', kind: 'line', agentId: 4, decisionIndex: 1,
  placeId: 'sky_wheel', aboutPlace: 'sky_wheel',
  asks: { choice: 'next_place', yesNo: 'join', frustration: true, tellOthers: true },
  options: [{ key: 'log_flume', label: 'Go to Log Flume' }, { key: 'leave', label: 'Leave and go home' }],
  remarkKinds: remarkKindsAt('Sky Wheel'),
  observation: {
    setting: 'Saturday at Harbor Lights Park.', time: 'around 11:00 am', person: PERSON,
    so_far: { time_here: 'about 60 minutes', time_in_lines: 'about 20 minutes', places_done: ['Thunder Spine'] },
    now: 'Just reached Sky Wheel. The line is long, about 45 min: more than they will put up with.',
    places: VISIT_PLACES.slice(1),
    heard: []
  },
  auto: { action: 'yes' }
};

const longReq = {
  ...base, id: 'd31', t: 170, clock: '11:50', kind: 'long', agentId: 4, decisionIndex: 2,
  placeId: 'sky_wheel', aboutPlace: 'sky_wheel',
  asks: { choice: 'next_place', yesNo: 'keep_waiting', frustration: true, tellOthers: true },
  options: [{ key: 'log_flume', label: 'Go to Log Flume' }, { key: 'leave', label: 'Leave and go home' }],
  remarkKinds: remarkKindsAt('Sky Wheel'),
  observation: {
    setting: 'Saturday at Harbor Lights Park.', time: 'around 11:30 am', person: PERSON, feeling: 'frustrated',
    so_far: { time_here: 'about 100 minutes', time_in_lines: 'about 60 minutes', places_done: ['Thunder Spine'] },
    now: 'Has waited about 30 minutes in line at Sky Wheel. About 10 more minutes expected: about the most they will put up with.',
    places: VISIT_PLACES.slice(1),
    heard: []
  },
  auto: { action: 'leave' }
};

const { has_live_wait_app: _app, ...PERSON_BASE } = PERSON;
const DRIVER = { ...PERSON_BASE, has_live_traffic: false };

const routeReq = {
  ...base, id: 'd5', t: 12.25, clock: '07:12', kind: 'route', agentId: 9, decisionIndex: 0,
  personaId: 'dev', personaName: 'Dev Patel', archetypeId: 'commuter',
  asks: { choice: 'route', yesNo: null, frustration: false, tellOthers: false },
  options: [
    { key: 'r0', label: 'Take the route via I-9 → Kessel Bridge' },
    { key: 'r1', label: 'Take the route via Elm St → Canal St' },
    { key: 'r2', label: 'Take the route via Harbor Blvd' }
  ],
  observation: {
    setting: 'Weekday rush hour in Maple Heights.', time: 'around 7:00 am', person: DRIVER,
    trip: 'Maple Heights to Downtown',
    routes: [
      { option: 'r0', via: 'I-9 → Kessel Bridge', usual_time: 'about 20 minutes', right_now: 'unknown (no live traffic)' },
      { option: 'r1', via: 'Elm St → Canal St', usual_time: 'about 25 minutes', right_now: 'unknown (no live traffic)' },
      { option: 'r2', via: 'Harbor Blvd', usual_time: 'about 30 minutes', right_now: 'unknown (no live traffic)' }
    ],
    heard: ['Traffic radio (about 10 minutes ago): heavy traffic on I-9']
  },
  auto: { action: 'r1' }
};

const arriveReq = {
  ...base, id: 'd88', t: 58.5, clock: '07:58', kind: 'arrive', agentId: 9, decisionIndex: 1,
  personaId: 'dev', personaName: 'Dev Patel', archetypeId: 'commuter', aboutEdge: 'canal>ferry',
  asks: { choice: null, yesNo: null, frustration: true, tellOthers: true },
  options: [],
  remarkKinds: [
    { key: 'heavy_traffic', label: 'Warn about heavy traffic on Canal St' },
    { key: 'clear_roads', label: 'Say Canal St was clear' }
  ],
  observation: {
    setting: 'Weekday rush hour in Maple Heights.', time: 'around 8:00 am', person: DRIVER,
    trip: 'Maple Heights to Downtown', took: 'I-9 → Kessel Bridge',
    time_taken: 'about 40 minutes, about 15 minutes more than on empty roads', worst_stretch: 'Canal St'
  },
  auto: null
};

const ALL = { chooseStart, chooseNext, lineReq, longReq, routeReq, arriveReq };
const CTX = { seed: 7, spec: SPEC };

// ---------- fake Jev ----------

// Answers every question in a body the way the API would: choice probabilities keyed by criteria
// key, noul as a number, score with probabilities '0'..'4' and a legend.
function fakeAnswers(body) {
  const answers = {};
  for (const [name, q] of Object.entries(body.questions)) {
    if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      const rest = keys.length > 1 ? 0.4 / (keys.length - 1) : 0;
      const probabilities = Object.fromEntries(keys.map((k, i) => [k, i === 0 ? (keys.length > 1 ? 0.6 : 1) : rest]));
      answers[name] = { type: 'choice', choice: keys[0], confidence: 0.5, probabilities };
    } else if (q.type === 'noul') {
      answers[name] = { type: 'noul', noul: 0.3 };
    } else if (q.type === 'score') {
      answers[name] = {
        type: 'score', score: 1.5, confidence: 0.4,
        legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])),
        probabilities: { 0: 0.1, 1: 0.4, 2: 0.4, 3: 0.1, 4: 0 }
      };
    }
  }
  return answers;
}

const json = (status, obj, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });

const okFor = body => json(200, { model: 'jev-1.14.0', answers: fakeAnswers(body), usage: { input_tokens: 900, output_tokens: 100 } });

// A recording fetch. `handler(call, n)` returns a Response (or throws); default answers everything.
function mockFetch(handler = call => okFor(call.body)) {
  const calls = [];
  const fn = async (url, init) => {
    const call = { url, init, body: JSON.parse(init.body) };
    calls.push(call);
    return handler(call, calls.length);
  };
  fn.calls = calls;
  return fn;
}

function provider(fetch, opts = {}) {
  const sleeps = [];
  const p = new JevProvider({
    apiKey: 'test-key-not-real', fetch,
    ...opts,
    retry: { sleep: async ms => { sleeps.push(ms); }, random: () => 0.5, ...(opts.retry || {}) }
  });
  p.sleeps = sleeps;
  return p;
}

const clone = x => structuredClone(x);
const backticked = s => [...String(s).matchAll(/`([^`]+)`/g)].map(m => m[1]);

// ---------- tests ----------

describe('request body', () => {
  const expectedQuestions = {
    chooseStart: ['next_place'],
    chooseNext: ['next_place', 'frustration', 'tell_others', 'remark_kind'],
    lineReq: ['join', 'next_place', 'frustration', 'tell_others', 'remark_kind'],
    longReq: ['keep_waiting', 'next_place', 'frustration', 'tell_others', 'remark_kind'],
    routeReq: ['route'],
    arriveReq: ['frustration', 'tell_others', 'remark_kind']
  };

  for (const [name, req] of Object.entries(ALL)) {
    test(`${name}: shape, criteria = options, hash of the exact body`, async () => {
      const fetch = mockFetch();
      const p = provider(fetch);
      const [d] = await p.decideMany([req], CTX);
      assert.equal(fetch.calls.length, 1);
      const { url, init, body } = fetch.calls[0];

      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer test-key-not-real');
      assert.equal(init.headers['Content-Type'], 'application/json');
      assert.ok(init.signal instanceof AbortSignal);

      assert.deepEqual(Object.keys(body), ['model', 'state', 'questions']);
      assert.equal(body.model, 'jev-latest');
      assert.deepEqual(body.state, JSON.parse(JSON.stringify(req.observation)));
      assert.deepEqual(Object.keys(body.questions).sort(), expectedQuestions[name].slice().sort());

      if (req.asks.choice) {
        const q = body.questions[req.asks.choice];
        assert.equal(q.type, 'choice');
        assert.deepEqual(Object.keys(q.criteria).sort(), req.options.map(o => o.key).sort());
        for (const o of req.options) assert.equal(q.criteria[o.key], o.label);
      }
      if (req.asks.yesNo) {
        const q = body.questions[req.asks.yesNo];
        assert.equal(q.type, 'noul');
        assert.deepEqual(Object.keys(q.criteria).sort(), ['false', 'true']);
      }
      if (req.asks.frustration) {
        assert.equal(body.questions.frustration.type, 'score');
        assert.deepEqual(body.questions.frustration.criteria, FRUSTRATION_LEVELS);
      }
      if (req.asks.tellOthers) {
        assert.equal(body.questions.tell_others.type, 'noul');
        const q = body.questions.remark_kind;
        assert.equal(q.type, 'choice');
        assert.deepEqual(Object.keys(q.criteria).sort(), req.remarkKinds.map(k => k.key).sort());
        for (const k of req.remarkKinds) assert.equal(q.criteria[k.key], k.label);
      }
      // Every field an instruction names in backticks exists at the top level of the state.
      for (const q of Object.values(body.questions)) {
        assert.ok(backticked(q.instructions).length > 0, `instructions name a field: ${q.instructions}`);
        for (const field of backticked(q.instructions)) assert.ok(field in body.state, `${field} is in state (${name})`);
      }

      const hash = createHash('sha256').update(init.body).digest('hex');
      assert.equal(d.requestHash, hash);
      assert.equal(buildJevRequest(req, { spec: SPEC }).requestHash, hash);
      assert.equal(buildJevRequest(req, { spec: SPEC }).json, init.body);
      assert.equal(d.provider, 'jev');
      assert.equal(d.action, undefined);
    });
  }

  test('instructions use the contract wording', () => {
    const q = name => buildJevRequest(ALL[name], { spec: SPEC }).body.questions;
    assert.equal(q('chooseNext').next_place.instructions, 'Where does the person in `person` go next, given `now`, `places` and `heard`?');
    assert.equal(q('routeReq').route.instructions, 'Which route in `routes` does the person in `person` take for `trip`?');
    assert.equal(q('lineReq').join.instructions, 'Does the person in `person` join the line described in `now`?');
    assert.deepEqual(q('lineReq').join.criteria, { true: 'They get in line and wait.', false: 'They skip this line and go somewhere else or leave.' });
    assert.equal(q('longReq').keep_waiting.instructions, 'Does the person in `person` keep waiting in the line described in `now`?');
    assert.deepEqual(q('longReq').keep_waiting.criteria, { true: 'They stay in line.', false: 'They give up on this line.' });
    assert.equal(q('chooseNext').frustration.instructions, 'How frustrated is the person in `person` right now, given `so_far` and `now`?');
    assert.equal(q('chooseNext').tell_others.instructions, 'Would the person in `person` tell friends, family or a group chat about their experience at Thunder Spine?');
    assert.equal(q('arriveReq').frustration.instructions, 'How frustrated is the person in `person` right now, given `time_taken` and `worst_stretch`?');
    assert.match(q('arriveReq').tell_others.instructions, /experience on Canal St\?$/);
  });

  test('place names fall back to the observation, then the id, without a spec', () => {
    const lineQs = buildJevRequest(lineReq).body.questions;
    assert.match(lineQs.tell_others.instructions, /at Sky Wheel\?$/);
    const noName = { ...chooseNext, aboutPlace: 'mystery_ride' };
    assert.match(buildJevRequest(noName).body.questions.tell_others.instructions, /at mystery_ride\?$/);
    assert.match(buildJevRequest(arriveReq).body.questions.tell_others.instructions, /on Canal St\?$/);
  });

  test('unbuildable requests become rules-fallback without a fetch', async () => {
    const fetch = mockFetch();
    const p = provider(fetch);
    const empty = { ...chooseStart, options: [] };
    const [d] = await p.decideMany([empty], CTX);
    assert.equal(fetch.calls.length, 0);
    assert.equal(d.provider, 'rules-fallback');
    assert.equal(d.action, 'thunder_spine');
    assert.match(d.error, /no options/);
    assert.equal(p.stats().errors, 1);
  });
});

describe('option order shuffle', () => {
  test('identical states give the same order and hash; different states give different orders', () => {
    const a = buildJevRequest(clone(chooseStart));
    const b = buildJevRequest(clone(chooseStart));
    assert.deepEqual(Object.keys(a.body.questions.next_place.criteria), Object.keys(b.body.questions.next_place.criteria));
    assert.equal(a.requestHash, b.requestHash);

    const orders = new Set();
    for (let i = 0; i < 12; i++) {
      const req = clone(chooseStart);
      req.observation.time = `around ${i + 1}:00 pm`;
      orders.add(Object.keys(buildJevRequest(req).body.questions.next_place.criteria).join(','));
    }
    assert.ok(orders.size >= 3, `expected several orders, got ${orders.size}`);
  });

  test('remark kinds are shuffled per state too; shuffle:false keeps request order', () => {
    const orders = new Set();
    for (let i = 0; i < 12; i++) {
      const req = clone(chooseNext);
      req.observation.time = `around ${i + 1}:30 pm`;
      orders.add(Object.keys(buildJevRequest(req).body.questions.remark_kind.criteria).join(','));
    }
    assert.ok(orders.size >= 2);
    const plain = buildJevRequest(chooseStart, { shuffle: false }).body.questions.next_place.criteria;
    assert.deepEqual(Object.keys(plain), VISIT_OPTIONS.map(o => o.key));
  });
});

describe('cache', () => {
  test('a repeated request is a cache hit: no fetch, provider jev-cache', async () => {
    const fetch = mockFetch();
    const p = provider(fetch);
    const [first] = await p.decideMany([chooseNext], CTX);
    const [second] = await p.decideMany([clone(chooseNext)], CTX);
    assert.equal(fetch.calls.length, 1);
    assert.equal(first.provider, 'jev');
    assert.equal(second.provider, 'jev-cache');
    assert.deepEqual(second.choiceProbs, first.choiceProbs);
    assert.deepEqual(second.answers, first.answers);
    assert.equal(second.requestHash, first.requestHash);
    assert.deepEqual(second.usage, { input_tokens: 0, output_tokens: 0 });
    const s = p.stats();
    assert.equal(s.requests, 1);
    assert.equal(s.cacheHits, 1);
    assert.equal(s.inputTokens, 900);
  });

  test('identical requests in one batch share a single API call', async () => {
    const fetch = mockFetch();
    const p = provider(fetch);
    const twin = { ...clone(chooseStart), id: 'd2', agentId: 2 };
    const ds = await p.decideMany([chooseStart, twin], CTX);
    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(ds.map(d => d.provider), ['jev', 'jev-cache']);
  });

  test('an injected cache is used and filled', async () => {
    const cache = new Map();
    const fetch = mockFetch();
    await provider(fetch, { cache }).decideMany([routeReq], CTX);
    assert.equal(cache.size, 1);
    const [d] = await provider(fetch, { cache }).decideMany([routeReq], CTX);
    assert.equal(d.provider, 'jev-cache');
    assert.equal(fetch.calls.length, 1);
  });
});

describe('HTTP errors and retries', () => {
  test('429 with retry-after, then success', async () => {
    const fetch = mockFetch((call, n) => n === 1 ? json(429, { detail: 'slow down' }, { 'retry-after': '2' }) : okFor(call.body));
    const p = provider(fetch);
    const [d] = await p.decideMany([chooseStart], CTX);
    assert.equal(fetch.calls.length, 2);
    assert.deepEqual(p.sleeps, [2000]);
    assert.equal(d.provider, 'jev');
    assert.equal(p.stats().retries, 1);
    assert.equal(p.stats().errors, 0);
  });

  test('529 is retried with exponential backoff when there is no retry-after', async () => {
    const fetch = mockFetch((call, n) => n <= 2 ? json(529, { detail: 'overloaded' }) : okFor(call.body));
    const p = provider(fetch);
    const [d] = await p.decideMany([chooseStart], CTX);
    assert.equal(d.provider, 'jev');
    assert.deepEqual(p.sleeps, [187.5, 375]);
  });

  test('5 x 500 gives rules-fallback with an error', async () => {
    const fetch = mockFetch(() => json(500, { detail: 'internal error' }));
    const p = provider(fetch);
    const [d] = await p.decideMany([lineReq], CTX);
    assert.equal(fetch.calls.length, 5);
    assert.deepEqual(p.sleeps, [187.5, 375, 750, 1500]);
    assert.equal(d.provider, 'rules-fallback');
    assert.equal(d.action, 'yes');
    assert.match(d.error, /HTTP 500: internal error/);
    assert.match(d.error, /gave up after 5 attempts/);
    const s = p.stats();
    assert.equal(s.fallbacks, 1);
    assert.equal(s.errors, 1);
    assert.equal(s.firstError, d.error);
  });

  test('401 throws JevAuthError and later calls fail fast without fetching', async () => {
    const fetch = mockFetch(() => json(401, { detail: 'invalid key' }));
    const p = provider(fetch);
    await assert.rejects(p.decideMany([chooseStart, routeReq], CTX), err => {
      assert.ok(err instanceof JevAuthError);
      assert.equal(err.status, 401);
      assert.ok(!err.message.includes('test-key-not-real'));
      return true;
    });
    const before = fetch.calls.length;
    await assert.rejects(p.decideMany([arriveReq], CTX), JevAuthError);
    assert.equal(fetch.calls.length, before);
  });

  test('422 gives fallback without retry, and the first error is kept', async () => {
    const detail = [{ loc: ['body', 'questions', 'next_place', 'criteria'], msg: 'Field required', type: 'missing' }];
    const fetch = mockFetch((call, n) => n === 1 ? json(422, { detail }) : json(400, { detail: 'Numbers must be finite' }));
    const p = provider(fetch);
    const [d1] = await p.decideMany([chooseStart], CTX);
    assert.equal(fetch.calls.length, 1);
    assert.equal(d1.provider, 'rules-fallback');
    assert.equal(d1.action, 'thunder_spine');
    assert.equal(d1.error, 'HTTP 422: body.questions.next_place.criteria: Field required');
    const [d2] = await p.decideMany([routeReq], CTX);
    assert.equal(d2.error, 'HTTP 400: Numbers must be finite');
    const s = p.stats();
    assert.equal(s.firstError, d1.error);
    assert.equal(s.errors, 2);
    assert.equal(s.fallbacks, 2);
    assert.equal(s.retries, 0);
  });

  test('a timed-out request is aborted and retried', async () => {
    let n = 0;
    const fetch = async (url, init) => {
      n++;
      if (n === 1) {
        return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      }
      return okFor(JSON.parse(init.body));
    };
    const p = provider(fetch, { timeoutMs: 20 });
    const [d] = await p.decideMany([chooseStart], CTX);
    assert.equal(n, 2);
    assert.equal(d.provider, 'jev');
    assert.equal(p.stats().retries, 1);
  });

  test('timeouts that never recover fall back with a timeout message', async () => {
    const fetch = async (url, init) =>
      new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const p = provider(fetch, { timeoutMs: 10, retry: { attempts: 2 } });
    const [d] = await p.decideMany([chooseStart], CTX);
    assert.equal(d.provider, 'rules-fallback');
    assert.match(d.error, /timed out after 10 ms \(gave up after 2 attempts\)/);
  });

  test('network errors are retried', async () => {
    const fetch = mockFetch((call, n) => {
      if (n === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      return okFor(call.body);
    });
    const p = provider(fetch);
    const [d] = await p.decideMany([chooseStart], CTX);
    assert.equal(d.provider, 'jev');
    assert.equal(fetch.calls.length, 2);
  });

  test('parseRetryAfter reads seconds and HTTP dates', () => {
    assert.equal(parseRetryAfter('2'), 2000);
    assert.equal(parseRetryAfter('0.5'), 500);
    assert.equal(parseRetryAfter(null), null);
    assert.equal(parseRetryAfter('soon'), null);
    const now = Date.parse('2026-11-14T12:00:00Z');
    assert.equal(parseRetryAfter('Sat, 14 Nov 2026 12:00:03 GMT', now), 3000);
  });
});

describe('budget and concurrency', () => {
  test('maxRequests: later decisions fall back in request order; cache hits do not count', async () => {
    const fetch = mockFetch();
    const p = provider(fetch, { maxRequests: 2 });
    const reqs = [chooseStart, chooseNext, lineReq, routeReq];
    const ds = await p.decideMany(reqs, CTX);
    assert.equal(fetch.calls.length, 2);
    assert.deepEqual(ds.map(d => d.provider), ['jev', 'jev', 'rules-fallback', 'rules-fallback']);
    assert.equal(ds[2].error, 'max-requests reached');
    assert.equal(ds[2].action, 'yes');
    assert.equal(ds[3].action, 'r1');
    const [again] = await p.decideMany([clone(chooseStart)], CTX);
    assert.equal(again.provider, 'jev-cache');
    const s = p.stats();
    assert.equal(s.requests, 2);
    assert.equal(s.fallbacks, 2);
    assert.equal(s.errors, 0);
    assert.equal(s.firstError, null);
    assert.equal(s.decisions, 5);
  });

  test('concurrency never exceeds the limit, and results keep request order', async () => {
    let active = 0, peak = 0;
    const fetch = async (url, init) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
      return okFor(JSON.parse(init.body));
    };
    const p = provider(fetch, { concurrency: 3 });
    const reqs = Array.from({ length: 20 }, (_, i) => {
      const r = clone(chooseStart);
      r.id = `d${i + 1}`;
      r.observation.time = `state ${i}`;
      return r;
    });
    const ds = await p.decideMany(reqs, CTX);
    assert.equal(peak, 3);
    assert.equal(ds.length, 20);
    ds.forEach((d, i) => assert.equal(d.requestHash, buildJevRequest(reqs[i], { spec: SPEC }).requestHash));
  });
});

describe('parsing', () => {
  test('every answer type maps onto the Decision shape; extras are ignored', async () => {
    const answers = {
      join: { type: 'noul', noul: 0.31 },
      next_place: { type: 'choice', choice: 'log_flume', confidence: 0.4, probabilities: { log_flume: 0.62, leave: 0.38, not_an_option: 0.9 } },
      frustration: {
        type: 'score', score: 2.4, confidence: 0.3,
        legend: Object.fromEntries(FRUSTRATION_LEVELS.map((l, i) => [String(i), l])),
        probabilities: { 0: 0, 1: 0.1, 2: 0.4, 3: 0.4, 4: 0.1, 9: 0.5 }
      },
      tell_others: { type: 'noul', noul: 0.46 },
      remark_kind: { type: 'choice', choice: 'long_line', confidence: 0.6, probabilities: { long_line: 0.7, bad_service: 0.2, good_experience: 0.1, gossip: 0.3 } }
    };
    const fetch = mockFetch(() => json(200, { model: 'jev-1.14.0', answers, usage: { input_tokens: 914, output_tokens: 139 } }));
    const p = provider(fetch, { now: (() => { let t = 0; return () => (t += 76); })() });
    const [d] = await p.decideMany([lineReq], CTX);
    assert.deepEqual(d, {
      provider: 'jev',
      yesProb: 0.31,
      choiceProbs: { log_flume: 0.62, leave: 0.38 },
      frustration: { expected: 2.4, probs: { 0: 0, 1: 0.1, 2: 0.4, 3: 0.4, 4: 0.1 } },
      tellProb: 0.46,
      remarkProbs: { long_line: 0.7, bad_service: 0.2, good_experience: 0.1 },
      model: 'jev-1.14.0',
      latencyMs: 76,
      usage: { input_tokens: 914, output_tokens: 139 },
      requestHash: d.requestHash,
      answers
    });
    assert.match(d.requestHash, /^[0-9a-f]{64}$/);
  });

  test('route and arrive answers', () => {
    const route = parseAnswers(routeReq, { route: { type: 'choice', choice: 'r1', confidence: 0.5, probabilities: { r0: 0.2, r1: 0.7, r2: 0.1 } } });
    assert.deepEqual(route, { choiceProbs: { r0: 0.2, r1: 0.7, r2: 0.1 } });
    const arrive = parseAnswers(arriveReq, {
      frustration: { type: 'score', score: 0.8, confidence: 0.5, legend: {}, probabilities: { 0: 0.3, 1: 0.6, 2: 0.1, 3: 0, 4: 0 } },
      tell_others: { type: 'noul', noul: 0.12 },
      remark_kind: { type: 'choice', choice: 'heavy_traffic', confidence: 0.8, probabilities: { heavy_traffic: 0.9, clear_roads: 0.1 } }
    });
    assert.deepEqual(arrive, {
      frustration: { expected: 0.8, probs: { 0: 0.3, 1: 0.6, 2: 0.1, 3: 0, 4: 0 } },
      tellProb: 0.12,
      remarkProbs: { heavy_traffic: 0.9, clear_roads: 0.1 }
    });
  });

  test('a missing primary answer is an error; missing follow-ups are omitted', async () => {
    assert.throws(() => parseAnswers(lineReq, { next_place: { probabilities: { leave: 1 } } }), /no usable answer for "join"/);
    assert.throws(() => parseAnswers(chooseStart, { next_place: { probabilities: { elsewhere: 1 } } }), /no usable answer for "next_place"/);
    assert.deepEqual(parseAnswers(chooseNext, { next_place: { probabilities: { sky_wheel: 1 } } }), { choiceProbs: { sky_wheel: 1 } });

    const fetch = mockFetch(() => json(200, { model: 'jev-1.14.0', answers: { tell_others: { type: 'noul', noul: 0.2 } }, usage: { input_tokens: 10, output_tokens: 1 } }));
    const p = provider(fetch);
    const [d] = await p.decideMany([longReq], CTX);
    assert.equal(fetch.calls.length, 1);
    assert.equal(d.provider, 'rules-fallback');
    assert.equal(d.action, 'leave');
    assert.match(d.error, /keep_waiting/);
    assert.equal(p.stats().inputTokens, 10);
  });
});

describe('stats', () => {
  test('latency percentiles, tokens and cost', async () => {
    const latencies = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    let clock = 0;
    const fetch = mockFetch((call, n) => { clock += latencies[n - 1]; return okFor(call.body); });
    const p = provider(fetch, { concurrency: 1, now: () => clock });
    const reqs = latencies.map((_, i) => {
      const r = clone(routeReq);
      r.observation.time = `slot ${i}`;
      return r;
    });
    await p.decideMany(reqs, CTX);
    const s = p.stats();
    assert.deepEqual(s.latency, { p50: 1000, p95: 1900, max: 2000 });
    assert.equal(s.requests, 20);
    assert.equal(s.inputTokens, 18000);
    assert.equal(s.outputTokens, 2000);
    assert.equal(s.estCostUSD, 18000 * 0.042 / 1e6);
    assert.equal(s.priceNote, PRICE_NOTE);
    assert.equal(s.priceNote, '$0.042 per million input tokens (TypeSafe published price, unverified)');
    assert.equal(s.model, 'jev-1.14.0');
    assert.equal(s.requestedModel, 'jev-latest');
    assert.equal(s.provider, 'jev');
  });

  test('empty stats are zeros', () => {
    const s = provider(mockFetch()).stats();
    assert.deepEqual(s.latency, { p50: 0, p95: 0, max: 0 });
    assert.equal(s.estCostUSD, 0);
    assert.equal(s.model, 'jev-latest');
    assert.equal(s.firstError, null);
  });
});

describe('construction and secrets', () => {
  test('requires an API key', () => {
    assert.throws(() => new JevProvider({ fetch: mockFetch() }), /apiKey/);
    assert.throws(() => new JevProvider({ apiKey: '  ', fetch: mockFetch() }), /apiKey/);
  });

  test('the key is not visible on the instance or in stats', () => {
    const p = provider(mockFetch());
    assert.ok(!JSON.stringify(p).includes('test-key-not-real'));
    assert.ok(!inspect(p, { depth: 5 }).includes('test-key-not-real'));
    assert.ok(!JSON.stringify(p.stats()).includes('test-key-not-real'));
    assert.equal(p.name, 'jev');
    assert.equal(p.external, true);
  });

  test('a custom base URL and model are used', async () => {
    const fetch = mockFetch();
    const p = provider(fetch, { baseUrl: 'http://localhost:9999/', model: 'jev-preview' });
    await p.decideMany([routeReq], CTX);
    assert.equal(fetch.calls[0].url, 'http://localhost:9999/v1/systemone');
    assert.equal(fetch.calls[0].body.model, 'jev-preview');
  });
});
