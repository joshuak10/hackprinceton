// Ask the room (docs/PROTOTYPE.md §17): the request it builds is the engine's own arrival request, scenarios
// are clamped, a sign is judged against the plain sign, a person can be rewritten for one ask, the page's
// arithmetic names a person as moved only past the one-person bar, the recorded answers committed with the
// page still answer the example world, and the server routes behave with and without Jev.
// The cafe world and its people are fictional.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, copyFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeSpec } from '../engine/spec.js';
import { Sim } from '../engine/sim.js';
import { buildJevRequest } from '../providers/jev.js';
import { roomView, defaultScenario, normalizeScenario, roomRequest, askRoom, recordProvider, signSentence, NEUTRAL_SIGN_TEXT, ROOM_LIMITS, ROOM_NOISE, ROOM_NOISE_PERSON } from '../run/room.js';
import { presetSigns, seedScenarios } from '../run/room-seed.js';
import { points, refOf, changeOf, grade, sameMoment, recomputeShare, summarize, byChange } from '../web/room/maths.js';
import { startServer } from '../server/server.js';

const here = rel => fileURLToPath(new URL(rel, import.meta.url));
const readJson = rel => JSON.parse(readFileSync(here(rel), 'utf8'));
const CAFE = readJson('../worlds/alder-pine-cafe.json');
const SEED = new Map(Object.entries(readJson('../web/room/seed-record.json')));
const spec = normalizeSpec(CAFE);
const NEUTRAL = signSentence('Alder & Pine Coffee', NEUTRAL_SIGN_TEXT);

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

  test('a value left out or empty takes the default, not zero', () => {
    const s = normalizeScenario(spec, { price: null, ahead: { cafe: null, chain: '' }, minute: null });
    assert.deepEqual(s, defaultScenario(spec));
  });

  test('a sign is kept as its words only: a typed "Sign on the door:" is dropped, and the person is told whose door it is', () => {
    for (const typed of ['Two registers today.', 'Sign on the door: Two registers today.', '  sign on the door of the cafe:   Two registers today. ']) {
      const s = normalizeScenario(spec, { sign: typed });
      assert.equal(s.sign, 'Two registers today.');
      assert.deepEqual(normalizeScenario(spec, s), s);          // asking again with the answer's own scenario changes nothing
      const june = spec.minds.find(m => m.id === 'june');
      assert.deepEqual(roomRequest(spec, june, s).observation.offers, ['Sign on the door of Alder & Pine Coffee: Two registers today.']);
    }
    const june = spec.minds.find(m => m.id === 'june');
    assert.deepEqual(roomRequest(spec, june, normalizeScenario(spec, { shop: 'chain', sign: 'Closed at noon.' })).observation.offers, ['Sign on the door of Brewline (chain): Closed at noon.']);
  });

  test('the view lists the places, the cast and the limits the page needs', () => {
    const v = roomView(CAFE);
    assert.deepEqual(v.places.map(p => p.id), ['cafe', 'chain']);
    assert.equal(v.cast.length, 12);
    assert.deepEqual(Object.keys(v.cast[0]).sort(), ['age', 'bio', 'goal', 'group', 'id', 'name', 'personality', 'social']);
    assert.equal(v.cast.find(c => c.id === 'karen').group, 'Commuters');
    assert.equal(v.noise, ROOM_NOISE);
    assert.equal(v.noisePerson, ROOM_NOISE_PERSON);
    assert.ok(ROOM_NOISE_PERSON > ROOM_NOISE);
    assert.equal(v.neutralSign, NEUTRAL);
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
    assert.equal(b.askedLive, 36);
    assert.equal(b.neutralSign, NEUTRAL);
    const by = tag => signed.seen.filter(r => r.id.startsWith(`room-${tag}-`));
    assert.ok(by('before').every(r => r.observation.offers === undefined));
    assert.ok(by('now').every(r => r.observation.offers[0] === 'Sign on the door of Alder & Pine Coffee: Two registers today.'));
    assert.ok(by('neutral').every(r => r.observation.offers[0] === NEUTRAL));
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
    // A rewritten person is also asked as written at the same moment, so the rewrite's own effect can be shown.
    const written = p.seen.filter(r => r.id.startsWith('room-written-'));
    assert.deepEqual(written.map(r => r.id), ['room-written-karen']);
    assert.match(written[0].observation.person.about, /twelve minutes/);
    assert.equal(written[0].observation.places[0].cost, 'about $7 (it was about $5 last week)');
    assert.equal(out.asked, 25);
    assert.deepEqual(karen.written, { cafe: 0.5, chain: 0.4, leave: 0.1 });
    assert.ok(out.people.filter(x => x.id !== 'karen').every(x => x.written === null));
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
    assert.equal(out.askedLive, 22);
  });

  test('under a sign, a person with no plain-sign answer is left out of every share', async () => {
    const p = fakeProvider(r => (r.id === 'room-neutral-june' ? null : r.id.startsWith('room-now-') ? { cafe: 0.9, chain: 0.05, leave: 0.05 } : { cafe: 0.5, chain: 0.4, leave: 0.1 }));
    const out = await askRoom({ spec: CAFE, scenario: { sign: 'Two registers today.' }, provider: p });
    assert.equal(out.people.find(x => x.id === 'june').source, 'failed');
    assert.ok(Math.abs(out.share.now - 0.9) < 1e-9 && Math.abs(out.share.neutral - 0.5) < 1e-9 && Math.abs(out.share.before - 0.5) < 1e-9);
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

  // If this fails after the cafe world, the cast, a preset sign or the observation wording changed, rebuild the
  // seed with a Jev key: node run/room-seed.js
  test('the answers committed with the page cover every moment the page reaches without typing', async () => {
    const provider = recordProvider(SEED);
    const presets = presetSigns();
    assert.equal(presets.length, 4);
    assert.ok(presets.every(sign => !/^sign on the door/i.test(sign)), 'presets are the words only');
    const scenarios = seedScenarios(CAFE);
    assert.ok(scenarios.length >= 70);
    for (const { scenario = {}, edits = {} } of scenarios) {
      const out = await askRoom({ spec: CAFE, scenario, edits, provider });
      assert.equal(out.failed, 0, `not recorded: ${JSON.stringify(scenario)}`);
      assert.equal(out.askedLive, 0);
      assert.ok(out.people.every(p => p.source === 'recorded'));
      for (const p of out.people) assert.ok(Math.abs(p.now.cafe + p.now.chain + p.now.leave - 1) < 0.05, `${p.name}: probabilities sum to ${p.now.cafe + p.now.chain + p.now.leave}`);
    }
  });

  test('the recorded answers hold nothing but answers and a model name', () => {
    assert.ok(SEED.size >= 900);
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
    assert.equal(out.askedLive, 0);
    assert.equal(out.error, null);
    assert.ok(out.people.every(p => p.source === 'failed' && p.now === null && p.before !== null));
  });

  test('bad requests are refused with a reason', async () => {
    assert.equal((await post({ world: '../secrets.json' })).status, 400);
    assert.equal((await post({ world: 'missing.json' })).status, 404);
    assert.equal((await post({ world: 'rush-hour-roads.json' })).status, 400);
    assert.equal((await post({ world: ['alder-pine-cafe.json'] })).status, 400);
    assert.equal((await fetch(`${srv.url}/api/room?world=rush-hour-roads.json`)).status, 400);
    const form = await fetch(`${srv.url}/api/room/ask`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(form.status, 415);
  });

  test('the page is served with its script and stylesheet, and the script parses', async () => {
    for (const path of ['/room/', '/room/app.js', '/room/maths.js', '/room/style.css']) assert.equal((await fetch(`${srv.url}${path}`)).status, 200, path);
    const html = await (await fetch(`${srv.url}/room/`)).text();
    assert.equal(/<script(?![^>]*\bsrc=)/.test(html) || /\sstyle="/.test(html), false, 'inline script or style would be blocked by the page\'s content policy');
    assert.equal(spawnSync(process.execPath, ['--check', here('../web/room/app.js')]).status, 0);
    assert.equal(/<link[^>]+rel="stylesheet"[^>]+fonts\.googleapis/.test(html), false, 'a font stylesheet in the head holds the page back when the font server is slow');
  });
});

describe('room: the page\'s arithmetic', () => {
  const ask = (scenario, edits = {}) => askRoom({ spec: CAFE, scenario, edits, provider: recordProvider(SEED) });

  test('whole points are compared: 5 is always 5, and one person needs 15 to count as moved', () => {
    assert.equal(points(0.25 - 0.20), 5);                       // 0.04999… in floating point
    assert.equal(grade(0.25 - 0.20, ROOM_NOISE, ROOM_NOISE_PERSON), 'small');
    assert.equal(grade(0.56 - 0.51, ROOM_NOISE, ROOM_NOISE_PERSON), 'small');
    assert.equal(grade(0.04, ROOM_NOISE, ROOM_NOISE_PERSON), 'none');
    assert.equal(grade(-0.14, ROOM_NOISE, ROOM_NOISE_PERSON), 'small');
    assert.equal(grade(0.15, ROOM_NOISE, ROOM_NOISE_PERSON), 'up');
    assert.equal(grade(-0.37, ROOM_NOISE, ROOM_NOISE_PERSON), 'down');
  });

  test('each person is compared with the right thing: before, the plain sign, or themselves as written', () => {
    const a = { cafe: 0.2 }, b = { cafe: 0.5 }, c = { cafe: 0.7 }, d = { cafe: 0.9 };
    const p = { now: d, before: a, neutral: b, written: c, edited: false };
    assert.equal(refOf(p, false).kind, 'before');
    assert.equal(refOf(p, true).kind, 'neutral');
    assert.equal(refOf({ ...p, edited: true }, true).kind, 'written');
    assert.equal(refOf({ ...p, neutral: null }, true), null);    // a sign is never judged against no sign
    assert.ok(Math.abs(changeOf(p, 'cafe', true) - 0.4) < 1e-9);
    assert.ok(Math.abs(changeOf({ ...p, edited: true }, 'cafe', false) - 0.2) < 1e-9);
    assert.equal(changeOf({ ...p, now: null }, 'cafe', false), null);
  });

  test('the opening view reports no comparison, because nothing was changed', async () => {
    const sum = summarize(await ask({}));
    assert.equal(sum.unchanged, true);
    assert.equal(sum.movers.length, 0);
    assert.equal(sum.asked, 12);
  });

  test('a remembered price rise: the student on financial aid is named, and nobody is named as more likely', async () => {
    const out = await ask({ price: 7, priorPrice: 5 });
    const sum = summarize(out);
    assert.equal(sum.unchanged, false);
    assert.equal(sum.withSign, false);
    assert.equal(sum.movers[0].p.id, 'tomas');
    assert.ok(sum.movers.every(m => m.d < 0), `named as more likely after a price rise: ${sum.movers.filter(m => m.d > 0).map(m => m.p.id)}`);
    assert.ok(sum.to < sum.from);
    assert.equal(byChange(out.people, 'cafe', false)[0].id, 'tomas');
  });

  test('a sign is measured against the plain sign, and the page knows when a price change sits under it', async () => {
    const plain = summarize(await ask({ sign: NEUTRAL_SIGN_TEXT }));
    assert.equal(plain.withSign, true);
    assert.equal(plain.movers.length, 0);                       // the plain sign against itself
    assert.equal(plain.flat, true);
    assert.equal(plain.alsoChanged, false);
    const both = summarize(await ask({ price: 7, priorPrice: 5, sign: presetSigns()[0] }));
    assert.equal(both.alsoChanged, true);
    assert.ok(both.before != null && both.from != null && both.to != null);
    assert.equal(sameMoment({ shop: 'cafe', price: 5, priorPrice: null, minute: 60, ahead: { cafe: 4 } }, { shop: 'cafe', price: 5.2, priorPrice: null, minute: 60, ahead: { cafe: 4 } }), true);
    assert.equal(sameMoment({ shop: 'cafe', price: 5, priorPrice: null, minute: 60, ahead: { cafe: 4 } }, { shop: 'cafe', price: 5, priorPrice: null, minute: 60, ahead: { cafe: 5 } }), false);
  });

  test('a rewritten person is compared with themselves as written; merging one person keeps the shares over the same people', async () => {
    const tomas = spec.minds.find(m => m.id === 'tomas');
    const edits = { tomas: { bio: `${tomas.bio} Today is his birthday and he promised himself one good thing.` } };
    const all = await ask({ price: 7, priorPrice: 5 });
    const one = await askRoom({ spec: CAFE, scenario: { price: 7, priorPrice: 5 }, edits, only: ['tomas'], provider: recordProvider(SEED) });
    const fresh = one.people[0];
    assert.equal(fresh.edited, true);
    assert.deepEqual(fresh.written, all.people.find(p => p.id === 'tomas').now);     // as written, at the same moment
    assert.equal(refOf(fresh, false).kind, 'written');
    all.people = all.people.map(p => (p.id === 'tomas' ? fresh : p));
    recomputeShare(all);
    const mean = all.people.reduce((sum, p) => sum + p.now.cafe, 0) / 12;
    assert.ok(Math.abs(all.share.now - mean) < 1e-9);
    assert.equal(summarize(all).rewritten, true);
  });
});

describe('room: the live route, with a stand-in for Jev', () => {
  let root, srv, hadKey, calls, mode;
  const reply = () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ model: 'jev-test', answers: { next_place: { type: 'choice', choice: 'cafe', confidence: 0.7, probabilities: { cafe: 0.7, chain: 0.2, leave: 0.1 } } } }) });
  const roomFetch = async () => {
    calls++;
    if (mode === 'down') throw new Error('socket hang up');
    if (mode === 'slow') await new Promise(done => setTimeout(done, 40));
    return reply();
  };
  before(async () => {
    hadKey = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = 'not-a-real-key';     // never sent anywhere: roomFetch replaces the network
    root = await mkdtemp(join(tmpdir(), 'swarm-room-live-'));
    await mkdir(join(root, 'worlds'), { recursive: true });
    await copyFile(here('../worlds/alder-pine-cafe.json'), join(root, 'worlds', 'alder-pine-cafe.json'));
    srv = await startServer({ port: 0, root, roomFetch });
  });
  after(async () => {
    await srv.close();
    await rm(root, { recursive: true, force: true });
    if (hadKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = hadKey;
  });
  const post = body => fetch(`${srv.url}/api/room/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  test('a new sign is asked live, saved on this machine, and answered from the record the second time', async () => {
    calls = 0; mode = 'ok';
    const first = await (await post({ scenario: { sign: 'Dogs welcome inside today.' } })).json();
    assert.equal(first.live, true);
    assert.equal(first.failed, 0);
    assert.equal(first.askedLive, 12);                    // "before" and the plain sign are already on record
    assert.equal(calls, 12);
    assert.ok(first.people.every(p => p.source === 'live' && p.now.cafe === 0.7));
    const saved = JSON.parse(await readFile(join(root, 'data', 'room', 'record.json'), 'utf8'));
    assert.equal(Object.keys(saved).length, SEED.size + 12);
    assert.equal(/not-a-real-key/.test(JSON.stringify(saved)), false);
    const again = await (await post({ scenario: { sign: 'Dogs welcome inside today.' } })).json();
    assert.equal(again.askedLive, 0);
    assert.equal(calls, 12);
    assert.ok(again.people.every(p => p.source === 'recorded'));
  });

  test('one rewritten person: only that person is asked, and the rewrite reaches Jev', async () => {
    calls = 0; mode = 'ok';
    const out = await (await post({ scenario: {}, only: ['karen'], edits: { karen: { bio: 'Has the day off and nowhere to be.' } } })).json();
    assert.deepEqual(out.people.map(p => p.id), ['karen']);
    assert.equal(out.people[0].edited, true);
    assert.equal(out.people[0].bio, 'Has the day off and nowhere to be.');
    assert.equal(calls, 1);                               // as written is on record; only the rewrite is new
    assert.equal(out.people[0].now.cafe, 0.7);
  });

  test('when Jev cannot be reached the answer comes back within seconds, with the reason and nothing invented', async () => {
    calls = 0; mode = 'down';
    const started = Date.now();
    const out = await (await post({ scenario: { sign: 'Closed for a private party.' } })).json();
    assert.ok(Date.now() - started < 8000, 'a stalled Jev must not hold the page for long');
    assert.equal(out.failed, 12);
    assert.match(out.error, /network error/);
    assert.ok(out.people.every(p => p.now === null && p.before !== null));
    assert.ok(calls <= 24, `2 attempts per question at most, saw ${calls} calls`);
  });

  test('a second ask sent during a slow one waits its turn and is answered', async () => {
    calls = 0; mode = 'slow';
    const [a, b] = await Promise.all([post({ scenario: { sign: 'Live music from 8.' } }), post({ scenario: {} })]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal((await b.json()).failed, 0);
  });
});
