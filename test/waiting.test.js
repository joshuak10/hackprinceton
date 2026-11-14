// The world's `waiting` options (docs/PROTOTYPE.md §16): `tellPatience` (whether a person is told, in words,
// how a line compares with their group's patience number) and `askAgainEvery` (re-ask "keep waiting?" instead
// of asking once and then making the person leave). Defaults must leave specs, hashes, observations and
// decision requests exactly as they were. The world and people here are fictional and hand-made.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { normalizeSpec, validateWorld, cleanSpec, specHash } from '../engine/spec.js';
import { Sim } from '../engine/sim.js';
import { visitObservation } from '../engine/observe.js';
import { buildJevRequest } from '../providers/jev.js';

const readJson = rel => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 16);

// One slow counter and far more people than it can serve, so lines pass everyone's patience.
const CLINIC = {
  title: 'Pine Road walk-in clinic (fictional)',
  question: 'Who gives up on the line?',
  context: 'A weekday afternoon at a fictional walk-in clinic with one nurse.',
  mode: 'visit', duration: 240, clockStart: 780, travelSpeed: 40,
  arrivals: { total: 60, start: 0, end: 60, shape: 'uniform' },
  nodes: [
    { id: 'door', name: 'Front door', kind: 'gate', x: 50, y: 90 },
    { id: 'nurse', name: 'Nurse desk', kind: 'service', x: 50, y: 40, servers: 1, serviceTime: 10, serviceDist: 'fixed', appeal: 0.7, price: 0, tags: ['care'], about: 'One nurse sees everyone in turn.' }
  ],
  archetypes: [
    { id: 'walkins', name: 'Walk-in patients', share: 1, visits: 1, patience: 12, info: 0, weights: { appeal: 1, wait: 1, distance: 1, price: 1 } }
  ],
  minds: [
    { id: 'odile', name: 'Odile Tran', age: 52, archetype: 'walkins', bio: 'Has had a cough for two weeks.', informed: false },
    { id: 'reuben', name: 'Reuben Hale', age: 31, archetype: 'walkins', bio: 'Needs a form signed before a shift.', informed: false }
  ]
};

const copy = w => JSON.parse(JSON.stringify(w));
const withWaiting = waiting => ({ ...copy(CLINIC), waiting });
const RULE = r => ({ provider: 'rules', action: r.auto?.action ?? undefined });
// Joins every line and never gives up; everything else follows the rule policy.
const ALWAYS_STAY = r => (r.kind === 'line' || r.kind === 'long' ? { provider: 'rules', action: 'yes' } : RULE(r));

// Drives an external-mode Sim to the end; `answer(req, nth)` returns the Decision, where `nth` counts that
// person's "keep waiting?" questions so far (1 for the first).
function runExternal(world, { seed = 7, answer = RULE } = {}) {
  const sim = new Sim(world, { seed, external: true });
  const reqs = [], longCount = new Map();
  const drain = () => {
    for (const r of sim.pending()) {
      reqs.push(r);
      let nth = 0;
      if (r.kind === 'long') { nth = (longCount.get(r.agentId) || 0) + 1; longCount.set(r.agentId, nth); }
      sim.resolve(r.id, answer(r, nth));
    }
  };
  while (!sim.done) { sim.step(); drain(); }
  drain();
  return { sim, reqs, longCount };
}

const longsByAgent = reqs => {
  const by = new Map();
  for (const r of reqs) if (r.kind === 'long') by.set(r.agentId, [...(by.get(r.agentId) || []), r]);
  return by;
};

describe('waiting: spec', () => {
  test('a world without waiting normalizes and cleans without the field', () => {
    const spec = normalizeSpec(copy(CLINIC));
    assert.equal(Object.hasOwn(spec, 'waiting'), false);
    assert.equal(JSON.stringify(spec).includes('waiting'), false);
    assert.equal(Object.hasOwn(cleanSpec(spec), 'waiting'), false);
  });

  test('all-default values are the same world: same clean spec and same hash', () => {
    const plain = normalizeSpec(copy(CLINIC));
    const defaults = normalizeSpec(withWaiting({ tellPatience: true, askAgainEvery: 0 }));
    assert.equal(Object.hasOwn(defaults, 'waiting'), false);
    assert.deepEqual(defaults, plain);
    assert.deepEqual(cleanSpec(defaults), cleanSpec(plain));
    assert.equal(specHash(defaults), specHash(plain));
    assert.equal(specHash(normalizeSpec(withWaiting({}))), specHash(plain));
  });

  test('a non-default value is kept, changes the hash and survives a clean round trip', () => {
    const quiet = normalizeSpec(withWaiting({ tellPatience: false }));
    assert.deepEqual(quiet.waiting, { tellPatience: false, askAgainEvery: 0 });
    assert.deepEqual(cleanSpec(quiet).waiting, { tellPatience: false, askAgainEvery: 0 });
    assert.notEqual(specHash(quiet), specHash(normalizeSpec(copy(CLINIC))));
    assert.deepEqual(normalizeSpec(cleanSpec(quiet)).waiting, quiet.waiting);

    const again = normalizeSpec(withWaiting({ askAgainEvery: 30 }));
    assert.deepEqual(again.waiting, { tellPatience: true, askAgainEvery: 30 });
    assert.notEqual(specHash(again), specHash(quiet));
    assert.equal(specHash(normalizeSpec(cleanSpec(again))), specHash(again));
  });

  test('bad values are corrected with a warning, never an error', () => {
    const check = (waiting, expected, pattern) => {
      const res = validateWorld(withWaiting(waiting));
      assert.equal(res.ok, true, res.errors.join('; '));
      assert.deepEqual(res.spec.waiting ?? null, expected);
      assert.ok(res.warnings.some(w => pattern.test(w)), `no warning matching ${pattern} in: ${res.warnings.join(' | ')}`);
    };
    check({ askAgainEvery: 2 }, { tellPatience: true, askAgainEvery: 5 }, /waiting\.askAgainEvery.*under 5 minutes/);
    check({ askAgainEvery: 900 }, { tellPatience: true, askAgainEvery: 240 }, /waiting\.askAgainEvery/);
    check({ tellPatience: 'no', askAgainEvery: 20 }, { tellPatience: true, askAgainEvery: 20 }, /waiting\.tellPatience.*not true or false/);
    check({ tellPatience: false, mood: 'calm' }, { tellPatience: false, askAgainEvery: 0 }, /waiting\.mood.*unknown field/);
    check(5, null, /waiting.*not an object/);
  });

  test('a valid waiting object validates with no warning, and schema.json describes it', () => {
    assert.deepEqual(validateWorld(copy(CLINIC)).warnings, []);
    assert.deepEqual(validateWorld(withWaiting({ tellPatience: false, askAgainEvery: 30 })).warnings, []);
    const schema = readJson('../worlds/schema.json');
    const w = schema.properties.waiting;
    assert.equal(w.type, 'object');
    assert.equal(w.additionalProperties, false);
    assert.equal(w.properties.tellPatience.type, 'boolean');
    assert.equal(w.properties.tellPatience.default, true);
    assert.deepEqual([w.properties.askAgainEvery.minimum, w.properties.askAgainEvery.maximum, w.properties.askAgainEvery.default], [0, 240, 0]);
  });

  test('route worlds ignore it with a warning', () => {
    const road = {
      title: 'Two roads (fictional)', question: 'Which road?', context: 'A fictional town with two roads.', mode: 'route', duration: 60,
      nodes: [{ id: 'a', name: 'A', kind: 'origin', x: 10, y: 50 }, { id: 'b', name: 'B', kind: 'destination', x: 90, y: 50 }],
      edges: [{ from: 'a', to: 'b', name: 'Main road', length: 5, capacity: 30 }],
      archetypes: [{ id: 'drivers', name: 'Drivers', share: 1, origins: ['a'], destinations: ['b'] }],
      minds: [{ id: 'd1', name: 'Driver One', archetype: 'drivers', bio: 'Commutes daily.' }],
      waiting: { tellPatience: false, askAgainEvery: 30 }
    };
    const res = validateWorld(road);
    assert.equal(res.ok, true, res.errors.join('; '));
    assert.equal(Object.hasOwn(res.spec, 'waiting'), false);
    assert.ok(res.warnings.some(w => /waiting.*visit mode only/.test(w)), res.warnings.join(' | '));
    assert.equal(Object.hasOwn(cleanSpec(res.spec), 'waiting'), false);
  });
});

describe('waiting.tellPatience: what a person is told', () => {
  const place = { id: 'nurse', name: 'Nurse desk', about: 'One nurse.', tags: ['care'], price: 0, dist: 0, visible: true, est: 45, ahead: 6, walkedAway30: 2 };
  const ctx = (spec, moment) => ({
    spec, t: 30, person: { name: 'Odile Tran', age: 52, bio: 'Has a cough.', groupName: 'Walk-in patients' }, frustration: 1,
    timeHere: 30, timeInLines: 25, placesDone: [], moment: { tolerance: 12, ...moment }, places: [place]
  });
  const LINE = { kind: 'line', placeName: 'Nurse desk', est: 45 };
  const LONG = { kind: 'long', placeName: 'Nurse desk', est: 10, waited: 30, remaining: 10 };
  const told = normalizeSpec(copy(CLINIC)), untold = normalizeSpec(withWaiting({ tellPatience: false }));

  test('by default the verdict is stated, as before', () => {
    const line = visitObservation(ctx(told, LINE));
    assert.equal(line.now, 'Just reached Nurse desk. The line is long, about 45 min: more than they will put up with.');
    assert.equal(line.places[0].line_vs_patience, 'more than they will put up with');
    const long = visitObservation(ctx(told, LONG));
    assert.equal(long.now, 'Has waited about 30 minutes in line at Nurse desk. About 10 more minutes expected: about the most they will put up with.');
  });

  test('with tellPatience false the verdict is gone and the facts stay', () => {
    const line = visitObservation(ctx(untold, LINE));
    assert.equal(line.now, 'Just reached Nurse desk. The line is long, about 45 min.');
    assert.equal(Object.hasOwn(line.places[0], 'line_vs_patience'), false);
    assert.equal(line.places[0].line, 'long, about 45 min');
    assert.equal(line.places[0].people_ahead, '6 people in line');
    const long = visitObservation(ctx(untold, LONG));
    assert.equal(long.now, 'Has waited about 30 minutes in line at Nurse desk. About 10 more minutes expected.');
    const front = visitObservation(ctx(untold, { ...LONG, remaining: 1 }));
    assert.equal(front.now, 'Has waited about 30 minutes in line at Nurse desk. Almost at the front.');
    assert.equal(JSON.stringify([line, long, front]).includes('put up with'), false);
  });

  test('nothing else in the observation changes', () => {
    for (const moment of [LINE, LONG, { kind: 'choose', why: 'start' }]) {
      const a = visitObservation(ctx(told, moment)), b = visitObservation(ctx(untold, moment));
      const strip = o => ({ ...o, now: null, places: o.places.map(p => ({ ...p, line_vs_patience: undefined })) });
      assert.deepEqual(strip(b), strip(a));
    }
    const a = visitObservation(ctx(told, { kind: 'choose', why: 'start' })), b = visitObservation(ctx(untold, { kind: 'choose', why: 'start' }));
    assert.equal(b.now, a.now);
  });
});

describe('waiting: the engine asks', () => {
  test('default-valued waiting gives byte-identical decision requests to no waiting at all', () => {
    const a = runExternal(copy(CLINIC), { answer: ALWAYS_STAY });
    const b = runExternal(withWaiting({ tellPatience: true, askAgainEvery: 0 }), { answer: ALWAYS_STAY });
    assert.ok(a.reqs.length > 60);
    assert.deepEqual(b.reqs.map(r => buildJevRequest(r).json), a.reqs.map(r => buildJevRequest(r).json));
    assert.deepEqual(b.sim.metrics(), a.sim.metrics());
  });

  test('by default each person is asked once per line and then made to leave', () => {
    const { sim, reqs } = runExternal(copy(CLINIC), { answer: ALWAYS_STAY });
    const longs = longsByAgent(reqs);
    assert.ok(longs.size > 10, `only ${longs.size} people were asked`);
    for (const list of longs.values()) assert.equal(list.length, 1);
    // Everyone said yes, yet people still left: the engine forces them out one patience-length later.
    assert.ok(sim.metrics().abandoned > 0);
    assert.ok(reqs.some(r => r.kind === 'long' && /put up with/.test(r.observation.now)));
  });

  test('askAgainEvery re-asks at that spacing and forces nobody out', () => {
    const { sim, reqs } = runExternal(withWaiting({ askAgainEvery: 15 }), { answer: ALWAYS_STAY });
    const longs = longsByAgent(reqs);
    assert.ok([...longs.values()].some(list => list.length >= 3), 'nobody was asked three times');
    for (const list of longs.values()) {
      for (let i = 1; i < list.length; i++) {
        const gap = list[i].t - list[i - 1].t;
        assert.ok(gap >= 15 - 1e-9 && gap <= 15 + 2, `gap of ${gap} minutes between questions`);
      }
    }
    assert.equal(sim.metrics().abandoned, 0);
    // Whoever was still in line when the clinic day ended is the only one not served.
    assert.equal(sim.agentsSummary().filter(a => a.abandons > 0).length, 0);
  });

  test('a no on the second question makes the person leave then, not earlier', () => {
    const answer = (r, nth) => (r.kind === 'long' ? { provider: 'rules', action: nth >= 2 ? 'leave' : 'yes' } : ALWAYS_STAY(r));
    const { sim, reqs } = runExternal(withWaiting({ askAgainEvery: 15 }), { answer });
    const longs = longsByAgent(reqs);
    const twice = [...longs.entries()].filter(([, list]) => list.length === 2);
    assert.ok(twice.length > 5, `only ${twice.length} people reached a second question`);
    for (const list of longs.values()) assert.ok(list.length <= 2);
    const summary = new Map(sim.agentsSummary().map(a => [a.id, a]));
    let left = 0;
    for (const [id] of twice) {
      const a = summary.get(id);
      if (a.trace.some(e => /gave up on Nurse desk/.test(e.m))) {
        left++;
        assert.equal(a.served, 0);
        assert.equal(a.abandons, 1);
      } else {
        // The answer is applied a moment after the question; by then this person had reached the nurse.
        assert.ok(a.trace.some(e => /already through/.test(e.m)), JSON.stringify(a.trace));
        assert.equal(a.abandons, 0);
      }
    }
    assert.ok(left > twice.length / 2, `${left} of ${twice.length} left at the second question`);
    // People asked only once said yes and were never asked to decide again before being served or the day ending.
    for (const [id, list] of longs) if (list.length === 1) assert.equal(summary.get(id).abandons, 0);
  });

  test('tellPatience false reaches every line and keep-waiting question', () => {
    const { reqs } = runExternal(withWaiting({ tellPatience: false, askAgainEvery: 15 }), { answer: ALWAYS_STAY });
    const asked = reqs.filter(r => r.kind === 'line' || r.kind === 'long');
    assert.ok(asked.length > 20);
    assert.equal(reqs.some(r => JSON.stringify(r.observation).includes('put up with')), false);
    assert.ok(asked.every(r => r.observation.places.every(p => !Object.hasOwn(p, 'line_vs_patience'))));
  });

  test('the same seed gives the same questions at the same times', () => {
    const run = () => runExternal(withWaiting({ tellPatience: false, askAgainEvery: 15 }), { answer: ALWAYS_STAY }).reqs.map(r => [r.id, r.t, r.kind, r.agentId]);
    assert.deepEqual(run(), run());
  });

  test('the inline rule policy is unaffected: it reads no words and asks no questions', () => {
    const run = world => { const sim = new Sim(world, { seed: 7 }); while (!sim.done) sim.step(); return sim.metrics(); };
    assert.deepEqual(run(withWaiting({ tellPatience: false, askAgainEvery: 15 })), run(copy(CLINIC)));
  });
});

// Stored values computed on the engine as it was before `waiting` existed (commit 734bf1c) and confirmed equal
// after the change. If one of these fails, default behavior moved: recorded Jev runs would stop replaying.
describe('waiting: the default path is pinned', () => {
  const fingerprint = (world, answer) => {
    const { sim, reqs } = runExternal(world, { answer });
    const m = sim.metrics();
    return {
      requests: reqs.length,
      byKind: reqs.reduce((k, r) => { k[r.kind] = (k[r.kind] || 0) + 1; return k; }, {}),
      bodies: sha(reqs.map(r => buildJevRequest(r).json).join('\n')),
      timing: sha(JSON.stringify(reqs.map(r => [r.id, r.t, r.kind, r.agentId, r.auto?.action ?? null]))),
      served: m.served, abandoned: m.abandoned
    };
  };

  test('food-hall-lunch, seed 7: every request body, its time and its rule answer', () => {
    assert.deepEqual(fingerprint(readJson('../worlds/food-hall-lunch.json'), ALWAYS_STAY), {
      requests: 2960, byKind: { choose: 2245, line: 496, long: 219 },
      bodies: '43edf0a7e931bbe1', timing: '73f309dfe1914a76', served: 1611, abandoned: 34
    });
  });

  test('the clinic, with stay answers and with rule answers', () => {
    assert.deepEqual(fingerprint(copy(CLINIC), ALWAYS_STAY), {
      requests: 235, byKind: { choose: 120, line: 57, long: 58 },
      bodies: '33520a4b38255ac1', timing: '13095b07cad5b89c', served: 9, abandoned: 51
    });
    assert.deepEqual(fingerprint(copy(CLINIC), RULE), {
      requests: 126, byKind: { choose: 67, line: 57, long: 2 },
      bodies: 'b1bfc11e6f055c8a', timing: '40c6c7bd8c9c3991', served: 7, abandoned: 53
    });
  });

  test('default timing: asked just past the patience, made to leave one patience after the question', () => {
    const { sim, reqs } = runExternal(copy(CLINIC), { answer: ALWAYS_STAY });
    const agents = new Map(sim.agentsSummary().map(a => [a.id, a]));
    let asked = 0, left = 0;
    for (const r of reqs.filter(q => q.kind === 'long')) {
      const a = agents.get(r.agentId);
      const joined = a.trace.find(e => /joined the line at Nurse desk/.test(e.m));
      if (joined) { asked++; assert.equal(r.t - joined.t, 12.5); }       // patience 12, half-minute ticks
      const gaveUp = a.trace.find(e => /^Gave up on Nurse desk/.test(e.m));
      if (gaveUp) { left++; assert.ok(gaveUp.t - r.t >= 13 && gaveUp.t - r.t <= 13.5, `left ${gaveUp.t - r.t} minutes after the question`); }
    }
    assert.equal(asked, 57);
    assert.equal(left, 51);
  });
});

describe('waiting: the two options are independent', () => {
  const key = reqs => reqs.map(r => [r.id, r.t, r.kind, r.agentId, r.auto?.action ?? null, (r.options || []).map(o => o.key)]);

  test('askAgainEvery alone keeps the patience words', () => {
    const { reqs } = runExternal(withWaiting({ askAgainEvery: 15 }), { answer: ALWAYS_STAY });
    const asked = reqs.filter(r => r.kind === 'line' || r.kind === 'long');
    assert.ok(asked.length > 20);
    assert.ok(asked.every(r => /put up with\.$/.test(r.observation.now)), 'a line or keep-waiting question lost the verdict');
    assert.ok(reqs.some(r => r.observation.places.some(p => Object.hasOwn(p, 'line_vs_patience'))));
  });

  test('tellPatience false alone changes the words only: same questions, times, rule answers and results', () => {
    const plain = runExternal(copy(CLINIC), { answer: ALWAYS_STAY });
    const quiet = runExternal(withWaiting({ tellPatience: false }), { answer: ALWAYS_STAY });
    assert.deepEqual(key(quiet.reqs), key(plain.reqs));
    assert.deepEqual(quiet.sim.metrics(), plain.sim.metrics());
    assert.equal(quiet.reqs.some(r => JSON.stringify(r.observation).includes('put up with')), false);
    for (const list of longsByAgent(quiet.reqs).values()) assert.equal(list.length, 1);   // still asked once
  });
});

describe('waiting.askAgainEvery: rule answers and the trace', () => {
  test('the rule answer is yes, then leave once the wait passes the rule limit; the person then goes', () => {
    const { sim, reqs } = runExternal(withWaiting({ askAgainEvery: 5 }), { answer: RULE });
    const longs = [...longsByAgent(reqs).values()];
    assert.equal(longs.length, 2);
    for (const list of longs) {
      assert.deepEqual(list.map(r => r.auto.action), ['yes', 'leave']);
      assert.equal(list[1].t - list[0].t, 6);       // 5 minutes after the yes took effect, one batch window later
    }
    assert.equal(reqs.length, 128);
    assert.deepEqual({ served: sim.metrics().served, abandoned: sim.metrics().abandoned }, { served: 7, abandoned: 53 });
  });

  test('a long wait with many questions leaves one "kept waiting" line per answer text, not one per question', () => {
    const { sim, reqs } = runExternal(withWaiting({ askAgainEvery: 5 }), { answer: ALWAYS_STAY });
    const most = Math.max(...[...longsByAgent(reqs).values()].map(list => list.length));
    assert.ok(most >= 20, `the most-asked person was asked ${most} times`);
    const agents = sim.agentsSummary();
    for (const a of agents) {
      for (let i = 1; i < a.trace.length; i++) assert.notEqual(a.trace[i].m, a.trace[i - 1].m, `agent ${a.id} repeats "${a.trace[i].m}"`);
      assert.ok(a.trace.length < 20, `agent ${a.id} has ${a.trace.length} trace entries`);
    }
    const served = agents.filter(a => a.served > 0);
    assert.ok(served.length > 10);
    assert.ok(served.every(a => a.trace.some(e => /^Finished at Nurse desk/.test(e.m))), 'a served person lost the end of their trace');
  });
});
