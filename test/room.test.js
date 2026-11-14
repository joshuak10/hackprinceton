// Ask the room (docs/PROTOTYPE.md §17): the request it builds is the engine's own arrival request, scenarios
// are clamped, a sign is judged against the neutral sign, a person can be rewritten for one ask, the recorded
// answers committed with the page still answer the example world, and the server routes behave.
// The cafe world and its people are fictional.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeSpec } from '../engine/spec.js';
import { Sim } from '../engine/sim.js';
import { buildJevRequest } from '../providers/jev.js';
import { roomView, defaultScenario, normalizeScenario, roomRequest, askRoom, recordProvider, NEUTRAL_SIGN, ROOM_LIMITS, ROOM_NOISE } from '../run/room.js';
import { startServer } from '../server/server.js';

const here = rel => fileURLToPath(new URL(rel, import.meta.url));
const readJson = rel => JSON.parse(readFileSync(here(rel), 'utf8'));
const CAFE = readJson('../worlds/alder-pine-cafe.json');
const SEED = new Map(Object.entries(readJson('../web/room/seed-record.json')));
const spec = normalizeSpec(CAFE);

// A provider that remembers what it was asked and answers from a function of the request.
function fakeProvider(answer = () => ({ cafe: 0.5, chain: 0.4, leave: 0.1 })) {
  const seen = [];
  return { seen, async decideMany(reqs) { return reqs.map(r => { seen.push(r); const p = answer(r); return p ? { provider: 'jev', choiceProbs: p } : { provider: 'rules-fallback', action: 'leave' }; }); } };
}

describe('room: the request', () => {
  test('for the same person and moment it is the engine\'s own arrival request, byte for byte', () => {
    const sim = new Sim(CAFE, { seed: 7, external: true });
    let first = null;
    while (!sim.done && !first) {
      sim.step();
      for (const r of sim.pending()) { if (!first && r.kind === 'choose' && r.why === 'start') first = r; sim.resolve(r.id, { provider: 'rules', action: r.auto?.action }); }
    }
    assert.ok(first, 'the engine never asked an arrival question');
    const mind = spec.minds.find(m => m.id === first.personaId);
    const mine = roomRequest(spec, mind, { shop: 'cafe', ahead: { cafe: 0, chain: 0 }, price: 5, priorPrice: null, sign: '', minute: first.t });
    assert.deepEqual(mine.observation, first.observation);
    assert.deepEqual(mine.options, first.options);
    assert.deepEqual(mine.asks, first.asks);
    assert.equal(buildJevRequest(mine, { spec }).json, buildJevRequest(first, { spec }).json);
  });

  test('lines and the price reach the person in the engine\'s words', () => {
    const june = spec.minds.find(m => m.id === 'june');
    const obs = roomRequest(spec, june, normalizeScenario(spec, { ahead: { cafe: 9, chain: 0 }, price: 7 })).observation;
    const cafe = obs.places.find(p => p.option === 'cafe'), chain = obs.places.find(p => p.option === 'chain');
    assert.deepEqual([cafe.cost, cafe.line, cafe.people_ahead], ['about $7', 'moderate, about 15 min', '9 people in line']);
    assert.deepEqual([chain.cost, chain.line, chain.people_ahead], ['about $5', 'no line', 'nobody in line']);
    assert.equal(Object.hasOwn(obs, 'offers'), false);
  });

  test('a remembered price is said in words, only when it reads differently', () => {
    const june = spec.minds.find(m => m.id === 'june');
    const cost = raw => roomRequest(spec, june, normalizeScenario(spec, raw)).observation.places.find(p => p.option === 'cafe').cost;
    assert.equal(cost({ price: 7, priorPrice: 5 }), 'about $7 (it was about $5 last week)');
    assert.equal(cost({ price: 5, priorPrice: 5 }), 'about $5');
    assert.equal(cost({ price: 5.2, priorPrice: 4.9 }), 'about $5');     // both read "about $5": nothing to remember
  });

  test('it never states a patience verdict, even for a world that would', () => {
    const hall = normalizeSpec(readJson('../worlds/food-hall-lunch.json'));
    assert.equal(hall.waiting, undefined);
    const scenario = defaultScenario(hall);
    for (const place of Object.keys(scenario.ahead)) scenario.ahead[place] = 30;
    for (const mind of hall.minds) assert.equal(JSON.stringify(roomRequest(hall, mind, scenario).observation).includes('put up with'), false);
  });
});

describe('room: scenarios', () => {
  test('defaults: the first service place is the shop, about two in line per person serving', () => {
    assert.deepEqual(defaultScenario(spec), { shop: 'cafe', ahead: { cafe: 4, chain: 6 }, price: 5, priorPrice: null, sign: '', minute: 60 });
    assert.equal(defaultScenario(spec, 'chain').shop, 'chain');
    assert.equal(defaultScenario(spec, 'nowhere').shop, 'cafe');
  });

  test('whatever the page sends is clamped, and unknown places are ignored', () => {
    const s = normalizeScenario(spec, { shop: 'nowhere', ahead: { cafe: 999, chain: -3, moon: 4 }, price: -4, priorPrice: 'abc', sign: `  ${'x'.repeat(400)}  `, minute: 9999 });
    assert.deepEqual(s.ahead, { cafe: ROOM_LIMITS.ahead, chain: 0 });
    assert.equal(s.shop, 'cafe');
    assert.equal(s.price, 0);
    assert.equal(s.priorPrice, null);
    assert.equal(s.sign.length, ROOM_LIMITS.sign);
    assert.equal(s.minute, spec.duration);
    assert.deepEqual(normalizeScenario(spec, null), defaultScenario(spec));
    assert.deepEqual(normalizeScenario(spec, 'junk'), defaultScenario(spec));
  });

  test('the view lists the places, the cast and the limits the page needs', () => {
    const v = roomView(CAFE);
    assert.deepEqual(v.places.map(p => p.id), ['cafe', 'chain']);
    assert.equal(v.cast.length, 12);
    assert.deepEqual(Object.keys(v.cast[0]).sort(), ['age', 'bio', 'goal', 'group', 'id', 'name', 'personality', 'social']);
    assert.equal(v.cast.find(c => c.id === 'karen').group, 'Commuters');
    assert.equal(v.noise, ROOM_NOISE);
    assert.equal(v.neutralSign, NEUTRAL_SIGN);
    assert.throws(() => roomView(readJson('../worlds/rush-hour-roads.json')), /visit world/);
  });
});

describe('room: asking', () => {
  test('without a sign each person is asked twice; with one, a third time with the neutral sign', async () => {
    const plain = fakeProvider();
    const a = await askRoom({ spec: CAFE, scenario: { price: 7 }, provider: plain });
    assert.equal(a.asked, 24);
    assert.equal(a.neutralSign, null);
    assert.ok(a.people.every(p => p.neutral === null));
    const signed = fakeProvider();
    const b = await askRoom({ spec: CAFE, scenario: { sign: 'Sign on the door: Two registers today.' }, provider: signed });
    assert.equal(b.asked, 36);
    assert.equal(b.neutralSign, NEUTRAL_SIGN);
    const by = tag => signed.seen.filter(r => r.id.startsWith(`room-${tag}-`));
    assert.ok(by('before').every(r => r.observation.offers === undefined));
    assert.ok(by('now').every(r => r.observation.offers[0] === 'Sign on the door: Two registers today.'));
    assert.ok(by('neutral').every(r => r.observation.offers[0] === NEUTRAL_SIGN));
    // The neutral question differs from the real one in the sign and nothing else.
    const strip = r => JSON.stringify({ ...r.observation, offers: null });
    assert.deepEqual(by('neutral').map(strip), by('now').map(strip));
  });

  test('"before" is the default moment with the person as written; "now" carries the scenario and the rewrite', async () => {
    const p = fakeProvider();
    const out = await askRoom({ spec: CAFE, scenario: { price: 7, priorPrice: 5 }, edits: { karen: { bio: 'Has the day off and nowhere to be.', goal: '   ' } }, provider: p });
    const before = p.seen.find(r => r.id === 'room-before-karen'), now = p.seen.find(r => r.id === 'room-now-karen');
    assert.match(before.observation.person.about, /twelve minutes/);
    assert.equal(before.observation.places[0].cost, 'about $5');
    assert.equal(now.observation.person.about, 'Has the day off and nowhere to be.');
    assert.equal(now.observation.person.wants, 'Coffee in hand without missing the train');   // a blank edit keeps the original
    assert.equal(now.observation.places[0].cost, 'about $7 (it was about $5 last week)');
    const karen = out.people.find(x => x.id === 'karen');
    assert.equal(karen.edited, true);
    assert.equal(out.people.filter(x => x.edited).length, 1);
    assert.equal(karen.told.places[0].cost, 'about $7 (it was about $5 last week)');
  });

  test('"only" asks the named people, and option order is the same in every question', async () => {
    const p = fakeProvider();
    const out = await askRoom({ spec: CAFE, scenario: {}, only: ['june', 'omar', 'nobody'], provider: p });
    assert.deepEqual(out.people.map(x => x.id), ['june', 'omar']);
    assert.equal(out.asked, 4);
    assert.ok(p.seen.every(r => JSON.stringify(r.options.map(o => o.key)) === '["cafe","chain","leave"]'));
  });

  test('shares are the mean chance of choosing the shop; an unanswered person is marked failed', async () => {
    const p = fakeProvider(r => (r.personaId === 'june' ? null : r.id.startsWith('room-now-') ? { cafe: 0.2, chain: 0.7, leave: 0.1 } : { cafe: 0.6, chain: 0.3, leave: 0.1 }));
    const out = await askRoom({ spec: CAFE, scenario: { price: 9 }, provider: p });
    assert.equal(out.failed, 1);
    assert.equal(out.people.find(x => x.id === 'june').source, 'failed');
    assert.equal(out.people.find(x => x.id === 'june').now, null);
    assert.ok(Math.abs(out.share.before - 0.6) < 1e-9 && Math.abs(out.share.now - 0.2) < 1e-9);
    assert.equal(out.share.neutral, null);
    assert.equal(out.people.find(x => x.id === 'omar').source, 'live');
  });

  test('a route world is refused', async () => {
    await assert.rejects(askRoom({ spec: readJson('../worlds/rush-hour-roads.json'), scenario: {}, provider: fakeProvider() }), /visit world/);
  });
});

describe('room: recorded answers', () => {
  test('a question never asked live comes back unanswered; a recorded one comes back with its probabilities', async () => {
    const june = spec.minds.find(m => m.id === 'june');
    const req = roomRequest(spec, june, defaultScenario(spec));
    const record = new Map();
    const provider = recordProvider(record);
    const [miss] = await provider.decideMany([req], { spec });
    assert.equal(miss.provider, 'missing');
    record.set(miss.requestHash, { answers: { next_place: { type: 'choice', choice: 'cafe', confidence: 0.6, probabilities: { cafe: 0.6, chain: 0.3, leave: 0.1 } } }, model: 'jev-1.14.0' });
    const [hit] = await provider.decideMany([req], { spec });
    assert.equal(hit.provider, 'recorded');
    assert.deepEqual(hit.choiceProbs, { cafe: 0.6, chain: 0.3, leave: 0.1 });
  });

  // If this fails after the cafe world or the observation wording changed, record the scenarios again
  // (ask them once with a Jev key, then copy data/room/record.json to web/room/seed-record.json).
  test('the answers committed with the page still cover the example world: default, prices, lines and the preset signs', async () => {
    const provider = recordProvider(SEED);
    const presets = readFileSync(here('../web/room/app.js'), 'utf8').match(/'Sign on the door: [^']+'/g).map(s => s.slice(1, -1));
    assert.equal(presets.length, 4);
    const scenarios = [{}, { price: 7 }, { price: 7, priorPrice: 5 }, { price: 4 }, { ahead: { cafe: 0, chain: 6 } }, { ahead: { cafe: 12, chain: 6 } }, { ahead: { cafe: 4, chain: 0 } }, ...presets.map(sign => ({ sign }))];
    for (const scenario of scenarios) {
      const out = await askRoom({ spec: CAFE, scenario, provider });
      assert.equal(out.failed, 0, `not recorded: ${JSON.stringify(scenario)}`);
      assert.ok(out.people.every(p => p.source === 'recorded'));
      for (const p of out.people) assert.ok(Math.abs(p.now.cafe + p.now.chain + p.now.leave - 1) < 0.05, `${p.name}: probabilities sum to ${p.now.cafe + p.now.chain + p.now.leave}`);
    }
  });

  test('the recorded answers hold nothing but answers and a model name', () => {
    assert.ok(SEED.size >= 600);
    for (const value of SEED.values()) assert.deepEqual(Object.keys(value).sort(), ['answers', 'model']);
    assert.equal(/bearer|api[_-]?key|authorization/i.test(JSON.stringify([...SEED.values()])), false);
  });
});

describe('room: server routes and the page', () => {
  let root, srv, hadKey;
  before(async () => {
    hadKey = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;            // these tests must never call Jev
    root = await mkdtemp(join(tmpdir(), 'swarm-room-'));
    await mkdir(join(root, 'worlds'), { recursive: true });
    await copyFile(here('../worlds/alder-pine-cafe.json'), join(root, 'worlds', 'alder-pine-cafe.json'));
    await copyFile(here('../worlds/rush-hour-roads.json'), join(root, 'worlds', 'rush-hour-roads.json'));
    srv = await startServer({ port: 0, root });
  });
  after(async () => {
    await srv.close();
    await rm(root, { recursive: true, force: true });
    if (hadKey !== undefined) process.env.TYPESAFE_API_KEY = hadKey;
  });
  const post = body => fetch(`${srv.url}/api/room/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  test('GET /api/room describes the example world and says the page is running on recorded answers', async () => {
    const res = await fetch(`${srv.url}/api/room`);
    assert.equal(res.status, 200);
    const v = await res.json();
    assert.equal(v.world, 'alder-pine-cafe.json');
    assert.equal(v.cast.length, 12);
    assert.equal(v.live, false);
    assert.equal(v.recorded, SEED.size);
  });

  test('POST /api/room/ask answers a recorded scenario with no key and no network', async () => {
    const res = await post({ scenario: { price: 7, priorPrice: 5 } });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.live, false);
    assert.equal(out.failed, 0);
    assert.equal(out.people.length, 12);
    assert.ok(out.share.now < out.share.before, 'the recorded price rise should lower the cafe\'s share');
    const tomas = out.people.find(p => p.id === 'tomas');
    assert.ok(tomas.before.cafe - tomas.now.cafe > 0.2, 'the student on financial aid should move most');
  });

  test('a sign nobody recorded is reported as unanswered, not invented', async () => {
    const res = await post({ scenario: { sign: 'Sign on the door: Free puppies with every latte.' } });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.failed, 12);
    assert.ok(out.people.every(p => p.source === 'failed' && p.now === null && p.before !== null));
  });

  test('bad requests are refused with a reason', async () => {
    assert.equal((await post({ world: '../secrets.json' })).status, 400);
    assert.equal((await post({ world: 'missing.json' })).status, 404);
    assert.equal((await post({ world: 'rush-hour-roads.json' })).status, 400);
    assert.equal((await fetch(`${srv.url}/api/room?world=rush-hour-roads.json`)).status, 400);
    const form = await fetch(`${srv.url}/api/room/ask`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(form.status, 415);
  });

  test('the page is served with its script and stylesheet, and the script parses', async () => {
    for (const path of ['/room/', '/room/app.js', '/room/style.css']) assert.equal((await fetch(`${srv.url}${path}`)).status, 200, path);
    const html = await (await fetch(`${srv.url}/room/`)).text();
    assert.equal(/<script(?![^>]*\bsrc=)/.test(html) || /\sstyle="/.test(html), false, 'inline script or style would be blocked by the page\'s content policy');
    assert.equal(spawnSync(process.execPath, ['--check', here('../web/room/app.js')]).status, 0);
  });
});
