// waiting.lineShows (docs/PROTOTYPE.md §16b): with "people", a person without a live wait app is told the head
// count and the staff serving instead of a wait in minutes. Lu, Musalem, Olivares & Schilkrut (Management
// Science, 2013) found deli customers respond to the number of people in line, not to how many staff are
// serving. Only the words change: when questions come and the rule answers stay as they were. The default,
// "wait", must leave everything as it was.
// The world and people here are fictional and hand-made.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeSpec, validateWorld, cleanSpec, specHash } from '../engine/spec.js';
import { Sim } from '../engine/sim.js';
import { visitObservation } from '../engine/observe.js';

const readJson = rel => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const copy = w => JSON.parse(JSON.stringify(w));

// One counter with `servers` staff and more customers than it can serve, so lines form.
const counterWorld = (servers, waiting) => ({
  title: 'Birch Lane coffee bar (fictional)',
  question: 'Who walks away from the line?',
  context: 'A weekday lunch at a fictional coffee bar.',
  mode: 'visit', duration: 180, clockStart: 720, travelSpeed: 40,
  arrivals: { total: 90, start: 0, end: 45, shape: 'uniform' },
  nodes: [
    { id: 'door', name: 'Front door', kind: 'gate', x: 50, y: 90 },
    { id: 'bar', name: 'Birch Bar', kind: 'service', x: 50, y: 40, servers, serviceTime: 2, serviceDist: 'fixed', appeal: 0.7, price: 5, tags: ['coffee'], about: 'Espresso drinks made to order.' }
  ],
  archetypes: [
    { id: 'lunch', name: 'Lunch-break workers', share: 1, visits: 1, patience: 10, info: 0, weights: { appeal: 1, wait: 1, distance: 1, price: 1 } }
  ],
  minds: [
    { id: 'lena', name: 'Lena Ortiz', age: 34, archetype: 'lunch', bio: 'Has twenty minutes before a call.', informed: false },
    { id: 'tomas', name: 'Tomas Reed', age: 27, archetype: 'lunch', bio: 'Checks the line on his phone first.', informed: true }
  ],
  ...(waiting ? { waiting } : {})
});

const RULE = r => ({ provider: 'rules', action: r.auto?.action ?? undefined });

function runExternal(world, seed = 7) {
  const sim = new Sim(world, { seed, external: true });
  const reqs = [];
  const drain = () => { for (const r of sim.pending()) { reqs.push(r); sim.resolve(r.id, RULE(r)); } };
  while (!sim.done) { sim.step(); drain(); }
  drain();
  return { sim, reqs };
}

describe('waiting.lineShows: spec', () => {
  test('"wait" is the default and leaves the world, its clean form and its hash unchanged', () => {
    const plain = normalizeSpec(counterWorld(2));
    const wait = normalizeSpec(counterWorld(2, { lineShows: 'wait' }));
    assert.equal(Object.hasOwn(wait, 'waiting'), false);
    assert.equal(specHash(wait), specHash(plain));
    const quiet = normalizeSpec(counterWorld(2, { tellPatience: false, lineShows: 'wait' }));
    assert.deepEqual(quiet.waiting, { tellPatience: false, askAgainEvery: 0 });
  });

  test('"people" is kept, changes the hash and survives a clean round trip', () => {
    const people = normalizeSpec(counterWorld(2, { lineShows: 'people' }));
    assert.deepEqual(people.waiting, { tellPatience: true, askAgainEvery: 0, lineShows: 'people' });
    assert.deepEqual(cleanSpec(people).waiting, people.waiting);
    assert.deepEqual(normalizeSpec(cleanSpec(people)).waiting, people.waiting);
    assert.notEqual(specHash(people), specHash(normalizeSpec(counterWorld(2))));
  });

  test('a bad value warns and falls back to "wait"; schema.json describes the field', () => {
    const res = validateWorld(counterWorld(2, { lineShows: 'minutes' }));
    assert.equal(res.ok, true, res.errors.join('; '));
    assert.equal(Object.hasOwn(res.spec, 'waiting'), false);
    assert.ok(res.warnings.some(w => /waiting\.lineShows/.test(w)), res.warnings.join(' | '));
    assert.deepEqual(validateWorld(counterWorld(2, { lineShows: 'people' })).warnings, []);
    const f = readJson('../worlds/schema.json').properties.waiting.properties.lineShows;
    assert.deepEqual([f.type, f.enum, f.default], ['string', ['wait', 'people'], 'wait']);
  });
});

describe('waiting.lineShows "people": what a person is told', () => {
  const people = normalizeSpec(counterWorld(2, { lineShows: 'people' }));
  const wait = normalizeSpec(counterWorld(2));
  const here = { id: 'bar', name: 'Birch Bar', about: 'Espresso.', tags: ['coffee'], price: 5, dist: 2, visible: true, est: 14, ahead: 6, staff: 2, walkedAway30: 0 };
  const far = { id: 'cart', name: 'Juice cart', about: 'Juice.', tags: ['juice'], price: 6, dist: 60, visible: false, est: 0, ahead: 0, staff: 1, walkedAway30: 0 };
  const ctx = (spec, moment, informed = false, places = [here, far]) => ({
    spec, t: 30, person: { name: 'Lena Ortiz', age: 34, bio: 'Has twenty minutes.', groupName: 'Lunch-break workers', informed },
    frustration: 0, timeHere: 2, timeInLines: 0, placesDone: [], moment: { tolerance: 10, ...moment }, places
  });
  const LINE = { kind: 'line', placeName: 'Birch Bar', est: 14, ahead: 6, staff: 2 };

  test('the join question gives the head count and the staff, with no minutes and no verdict', () => {
    const o = visitObservation(ctx(people, LINE));
    assert.equal(o.now, 'Just reached Birch Bar. 6 people in line, 2 staff serving.');
    assert.deepEqual(o.places[0], {
      option: 'bar', name: 'Birch Bar', known_for: 'Espresso.', offers: 'coffee', cost: o.places[0].cost,
      distance: o.places[0].distance, people_ahead: '6 people in line', staff: '2 staff serving'
    });
    assert.equal(o.places[1].line, "unknown (can't see it from here)");
    const text = JSON.stringify(o);
    assert.equal(/min\b|put up with/.test(text), false, text);
    assert.equal(visitObservation(ctx(people, { ...LINE, ahead: 1 })).now, 'Just reached Birch Bar. 1 person in line, 2 staff serving.');
    assert.equal(visitObservation(ctx(people, { ...LINE, ahead: 0, est: 0 })).now, 'Just reached Birch Bar. There is no line; 2 staff serving.');
  });

  test('the same head count reads the same whatever the wait estimate', () => {
    const slow = visitObservation(ctx(people, { ...LINE, est: 28, staff: 1 }, false, [{ ...here, est: 28, staff: 1 }]));
    const fast = visitObservation(ctx(people, { ...LINE, est: 9, staff: 3 }, false, [{ ...here, est: 9, staff: 3 }]));
    assert.equal(slow.now.replace('1 staff', 'N staff'), fast.now.replace('3 staff', 'N staff'));
    assert.deepEqual({ ...slow.places[0], staff: null }, { ...fast.places[0], staff: null });
  });

  test('the keep-waiting question gives time waited and people still ahead', () => {
    const LONG = { kind: 'long', placeName: 'Birch Bar', est: 6, waited: 15, remaining: 6, ahead: 3, staff: 2 };
    assert.equal(visitObservation(ctx(people, LONG)).now, 'Has waited about 15 minutes in line at Birch Bar. 3 people still ahead, 2 staff serving.');
    assert.equal(visitObservation(ctx(people, { ...LONG, ahead: 1 })).now, 'Has waited about 15 minutes in line at Birch Bar. 1 person still ahead, 2 staff serving.');
    assert.equal(visitObservation(ctx(people, { ...LONG, ahead: 0 })).now, 'Has waited about 15 minutes in line at Birch Bar. Next to be served, 2 staff serving.');
  });

  test('choosing where to go shows head counts too', () => {
    const o = visitObservation(ctx(people, { kind: 'choose', why: 'start' }));
    assert.equal(o.now, 'Just arrived. Choosing where to go first.');
    assert.equal(o.places[0].people_ahead, '6 people in line');
    assert.equal(Object.hasOwn(o.places[0], 'line'), false);
  });

  test('a person with a live wait app still sees minutes, exactly as in "wait" mode', () => {
    for (const moment of [LINE, { kind: 'choose', why: 'start' }]) {
      assert.deepEqual(visitObservation(ctx(people, moment, true)), visitObservation(ctx(wait, moment, true)));
    }
    assert.match(visitObservation(ctx(people, LINE, true)).now, /about \d+ min/);
  });

  test('"wait" mode ignores the new moment fields: same text as before', () => {
    assert.equal(visitObservation(ctx(wait, LINE)).now, visitObservation(ctx(wait, { kind: 'line', placeName: 'Birch Bar', est: 14 })).now);
  });
});

describe('waiting.lineShows "people": the engine', () => {
  test('the questions, their times and the rule answers are those of "wait" mode; only the words change', () => {
    for (const servers of [1, 2]) {
      const a = runExternal(counterWorld(servers)), b = runExternal(counterWorld(servers, { lineShows: 'people' }));
      const shape = reqs => reqs.map(r => [r.id, r.t, r.kind, r.placeId, r.auto?.action]);
      assert.deepEqual(shape(b.reqs), shape(a.reqs));
      assert.ok(a.reqs.some(r => r.kind === 'line'), 'the world should produce line questions');
      assert.equal(b.sim.abandonedTotal, a.sim.abandonedTotal);
    }
  });

  test('a person without the app is told the head count and the staff (any with the app still get minutes)', () => {
    const { reqs } = runExternal(counterWorld(2, { lineShows: 'people' }));
    const lines = reqs.filter(r => r.kind === 'line');
    const blind = lines.filter(r => !r.observation.person.has_live_wait_app);
    const app = lines.filter(r => r.observation.person.has_live_wait_app);
    assert.ok(blind.length > 0, 'people without the app should be asked');
    for (const r of blind) {
      assert.match(r.observation.now, /^Just reached Birch Bar\. \d+ people in line, 2 staff serving\.$/);
      assert.equal(/\bmin\b|put up with/.test(JSON.stringify({ now: r.observation.now, places: r.observation.places })), false);
    }
    for (const r of app) assert.match(r.observation.now, /The line is .*about \d+ min/);
  });

  test('the inline rule policy is unaffected', () => {
    const run = w => { const sim = new Sim(w, { seed: 5 }); while (!sim.done) sim.step(); return sim.abandonedTotal; };
    assert.equal(run(counterWorld(2, { lineShows: 'people' })), run(counterWorld(2)));
  });
});
