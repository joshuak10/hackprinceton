// Segment outcomes (docs/PROTOTYPE.md §15a): what each agent spent and where it was served, and
// metrics().segments by group and by cast member, in visit and route mode. A segment is a kind of
// simulated person, never a real individual. All worlds and people here are fictional and hand-made.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from '../engine/sim.js';

// ---------- fixtures ----------

// A busy street market: four stalls with few servers, so there are lines, walk-aways and people who are
// never served. Locals and tourists differ in patience, visits and the app.
const MARKET = {
  title: 'Fennel Lane market (fictional)',
  question: 'Which visitors have the worst time, and who spends the most?',
  context: 'Sunday late morning at a fictional street market on Fennel Lane.',
  mode: 'visit', duration: 300, clockStart: 600, travelSpeed: 10,
  arrivals: { total: 300, start: 0, end: 120, shape: 'peak' },
  nodes: [
    { id: 'gate', name: 'Market gate', kind: 'gate', x: 50, y: 92 },
    { id: 'cheese', name: 'Cheese stall', kind: 'service', x: 20, y: 30, servers: 2, serviceTime: 3, appeal: 0.9, price: 14, tags: ['food'], about: 'Aged cheeses; the line is famous' },
    { id: 'bread', name: 'Bread stall', kind: 'service', x: 50, y: 20, servers: 3, serviceTime: 2, appeal: 0.6, price: 5, tags: ['food'], about: 'Sourdough by the loaf' },
    { id: 'flowers', name: 'Flower stall', kind: 'service', x: 80, y: 30, servers: 1, serviceTime: 4, appeal: 0.5, price: 20, tags: ['gifts'], about: 'Bunches wrapped to order' },
    { id: 'honey', name: 'Honey stall', kind: 'service', x: 70, y: 60, servers: 1, serviceTime: 2, appeal: 0.4, price: 9, tags: ['food', 'gifts'], about: 'Local honey, tastings' }
  ],
  archetypes: [
    { id: 'locals', name: 'Locals', share: 2, visits: 2, patience: 12, info: 0.6, likes: ['food'] },
    { id: 'tourists', name: 'Tourists', share: 1, visits: 3, patience: 25, info: 0.2, likes: ['gifts'] }
  ],
  minds: [
    { id: 'dora', name: 'Dora Pell', age: 58, archetype: 'locals', bio: 'Shops here every Sunday for the week.', informed: true },
    { id: 'eli', name: 'Eli Marsh', age: 31, archetype: 'locals', bio: 'Picking up bread before a brunch he is hosting.', informed: false },
    { id: 'fay', name: 'Fay Okoro', age: 26, archetype: 'tourists', bio: 'Visiting for the weekend, wants a gift for her host.', informed: false }
  ]
};

// One kiosk with room for everyone and a fixed service time: every person is served once, never waits.
const KIOSK = {
  title: 'Juniper station kiosk (fictional)', question: 'Who spends what?', context: 'A fictional train station at rush hour.',
  mode: 'visit', duration: 90, clockStart: 450, travelSpeed: 20,
  arrivals: { total: 40, start: 0, end: 30, shape: 'uniform' },
  nodes: [
    { id: 'concourse', name: 'Concourse', kind: 'gate', x: 50, y: 90 },
    { id: 'kiosk', name: 'Coffee kiosk', kind: 'service', x: 50, y: 50, servers: 100, serviceTime: 1, serviceDist: 'fixed', appeal: 0.7, price: 12 }
  ],
  archetypes: [
    { id: 'commuters', name: 'Commuters', share: 3, visits: 1, patience: 20, info: 0.5 },
    { id: 'visitors', name: 'Visitors', share: 1, visits: 1, patience: 20, info: 0.5 }
  ],
  minds: [
    { id: 'gus', name: 'Gus Tarn', age: 44, archetype: 'commuters', bio: 'Catches the 7:52 every weekday.' },
    { id: 'ivy', name: 'Ivy Lund', age: 29, archetype: 'visitors', bio: 'In town for a conference.' }
  ]
};

// Two stalls with room for everyone; one group with two cast members, used to steer decisions by person.
const TWO_STALLS = {
  title: 'Sorrel Square stalls (fictional)', question: 'Who goes where?', context: 'A fictional square at lunch.',
  mode: 'visit', duration: 120, clockStart: 720, travelSpeed: 20,
  arrivals: { total: 60, start: 0, end: 60, shape: 'uniform' },
  nodes: [
    { id: 'gate', name: 'Square gate', kind: 'gate', x: 50, y: 90 },
    { id: 'cheese', name: 'Cheese stall', kind: 'service', x: 30, y: 40, servers: 50, serviceTime: 2, price: 14 },
    { id: 'bread', name: 'Bread stall', kind: 'service', x: 70, y: 40, servers: 50, serviceTime: 2, price: 5 }
  ],
  archetypes: [
    { id: 'locals', name: 'Locals', share: 2, visits: 1, patience: 20, info: 0.5 },
    { id: 'tourists', name: 'Tourists', share: 1, visits: 1, patience: 20, info: 0.5 }
  ],
  minds: [
    { id: 'dora', name: 'Dora Pell', archetype: 'locals', bio: 'Always buys cheese.' },
    { id: 'eli', name: 'Eli Marsh', archetype: 'locals', bio: 'Always buys bread.' },
    { id: 'fay', name: 'Fay Okoro', archetype: 'tourists', bio: 'Picks whatever is closest.' }
  ]
};

// A small road network with a choice of two routes and a bottleneck on one.
const ROADS = {
  title: 'Wren Valley commute (fictional)', question: 'Who is delayed most?', context: 'Weekday morning in a fictional valley.',
  mode: 'route', duration: 120, clockStart: 420,
  arrivals: { total: 400, start: 0, end: 60, shape: 'peak' },
  nodes: [
    { id: 'hill', name: 'Hilltop', kind: 'origin', x: 10, y: 50 },
    { id: 'north', name: 'North Fork', kind: 'intersection', x: 50, y: 25 },
    { id: 'south', name: 'South Fork', kind: 'intersection', x: 50, y: 75 },
    { id: 'town', name: 'Town Center', kind: 'destination', x: 90, y: 50 }
  ],
  edges: [
    { from: 'hill', to: 'north', name: 'Ridge Road', length: 8, capacity: 25 },
    { from: 'north', to: 'town', name: 'Mill Bridge', length: 6, capacity: 15 },
    { from: 'hill', to: 'south', name: 'River Road', length: 10, capacity: 60 },
    { from: 'south', to: 'town', name: 'Low Street', length: 7, capacity: 60 }
  ],
  archetypes: [
    { id: 'commuters', name: 'Commuters', share: 3, info: 0.7 },
    { id: 'couriers', name: 'Couriers', share: 1, info: 0.1 }
  ],
  minds: [
    { id: 'gil', name: 'Gil Abbot', archetype: 'commuters', bio: 'Starts work at 8.' },
    { id: 'hana', name: 'Hana Brisk', archetype: 'commuters', bio: 'Drops her son at school first.' },
    { id: 'ivan', name: 'Ivan Crest', archetype: 'couriers', bio: 'Delivers parcels across the valley.' }
  ]
};

const VISIT_KEYS = ['id', 'name', 'group', 'count', 'avgWait', 'avgSpent', 'avgVisits', 'walkAwaysPerPerson', 'shareNeverServed', 'avgFrustration', 'topPlaces', 'visitsByPlace'];
const ROUTE_KEYS = ['id', 'name', 'group', 'count', 'avgTrip', 'avgDelay', 'avgFrustration'];

// agentsSummary rounds waitTotal and trips to 2 decimals, so an average of the rounded values is within 0.005.
const ROUNDING = 0.0051;
const mean = (xs, f) => (xs.length ? xs.reduce((s, x) => s + f(x), 0) / xs.length : null);
const near = (actual, expected, label) => {
  if (expected === null) return assert.equal(actual, null, label);
  assert.ok(Math.abs(actual - expected) <= ROUNDING, `${label}: ${actual} vs hand calculation ${expected}`);
};

// The segment entry computed by hand from the per-agent records.
function handVisitSegment(agents, names) {
  const felt = agents.filter(a => a.frustration != null);
  const visits = new Map();
  for (const a of agents) for (const id of a.visits) visits.set(id, (visits.get(id) || 0) + 1);
  const order = [...names.keys()];
  const topPlaces = [...visits].sort((p, q) => q[1] - p[1] || order.indexOf(p[0]) - order.indexOf(q[0]))
    .slice(0, 3).map(([id, k]) => ({ id, name: names.get(id), visits: k }));
  const visitsByPlace = Object.fromEntries([...visits].sort((p, q) => order.indexOf(p[0]) - order.indexOf(q[0])));
  return {
    count: agents.length,
    avgWait: mean(agents, a => a.waitTotal), avgSpent: mean(agents, a => a.spent), avgVisits: mean(agents, a => a.visits.length),
    walkAwaysPerPerson: mean(agents, a => a.abandons), shareNeverServed: mean(agents, a => (a.served === 0 ? 1 : 0)),
    avgFrustration: mean(felt, a => a.frustration), topPlaces, visitsByPlace
  };
}

function assertMatchesHand(entry, agents, names, label) {
  const hand = handVisitSegment(agents, names);
  assert.equal(entry.count, hand.count, `${label} count`);
  for (const k of ['avgWait', 'avgSpent', 'avgVisits', 'walkAwaysPerPerson', 'shareNeverServed', 'avgFrustration']) near(entry[k], hand[k], `${label} ${k}`);
  assert.deepEqual(entry.topPlaces, hand.topPlaces, `${label} topPlaces`);
  // Same keys in node order, so compare the entries as lists.
  assert.deepEqual(Object.entries(entry.visitsByPlace), Object.entries(hand.visitsByPlace), `${label} visitsByPlace`);
}

const placeNames = sim => new Map(sim.spec.nodes.filter(n => n.kind === 'service').map(n => [n.id, n.name]));
const byKey = (list, key) => { const m = new Map(); for (const a of list) { if (!m.has(a[key])) m.set(a[key], []); m.get(a[key]).push(a); } return m; };

// External-mode run where `answer(req)` gives each Decision.
function runExternal(world, answer, seed = 7) {
  const sim = new Sim(world, { seed, external: true });
  const drain = () => { for (const r of sim.pending()) sim.resolve(r.id, answer(r)); };
  while (!sim.done) { sim.step(); drain(); }
  drain();
  return sim;
}

// ---------- per-agent records ----------

describe('agents record what they spent and where they were served', () => {
  const sim = new Sim(MARKET, { seed: 7 }).runToEnd();
  const agents = sim.agentsSummary();
  const price = new Map(sim.spec.nodes.map(n => [n.id, n.price]));

  test('spent equals the sum of the prices at the places that served the agent', () => {
    assert.ok(agents.length > 250);
    for (const a of agents) {
      assert.equal(a.spent, a.visits.reduce((s, id) => s + price.get(id), 0), `agent ${a.id}`);
      assert.equal(a.visits.length, a.served, `agent ${a.id}`);
      assert.equal(new Set(a.visits).size, a.visits.length, `agent ${a.id} is served at most once per place`);
    }
    assert.ok(agents.some(a => a.visits.length >= 2) && agents.some(a => a.visits.length === 0));
  });

  test('visits are place ids in the order the agent was served', () => {
    for (const a of agents) {
      const finished = a.trace.map(e => /^Finished at (.+)$/.exec(e.m)?.[1]).filter(Boolean);
      assert.deepEqual(a.visits.map(id => sim.spec.nodes.find(n => n.id === id).name), finished, `agent ${a.id}`);
    }
  });

  test('route agents have no spent or visits', () => {
    const route = new Sim(ROADS, { seed: 7 }).runToEnd().agentsSummary();
    assert.ok(route.length > 0 && route.every(a => !('spent' in a) && !('visits' in a)));
  });
});

// ---------- visit segments ----------

describe('metrics().segments in visit mode', () => {
  const sim = new Sim(MARKET, { seed: 7 }).runToEnd();
  const agents = sim.agentsSummary(), seg = sim.metrics().segments, names = placeNames(sim);

  test('one entry per group and per cast member, with exactly the §15a shape', () => {
    assert.deepEqual(Object.keys(seg), ['byGroup', 'byCast']);
    assert.deepEqual(seg.byGroup.map(e => [e.id, e.name, e.group]), [['locals', 'Locals', 'locals'], ['tourists', 'Tourists', 'tourists']]);
    assert.deepEqual(seg.byCast.map(e => [e.id, e.name, e.group]), [['dora', 'Dora Pell', 'locals'], ['eli', 'Eli Marsh', 'locals'], ['fay', 'Fay Okoro', 'tourists']]);
    for (const e of [...seg.byGroup, ...seg.byCast]) {
      assert.deepEqual(Object.keys(e), VISIT_KEYS);
      for (const p of e.topPlaces) assert.deepEqual(Object.keys(p), ['id', 'name', 'visits']);
    }
  });

  test('counts add up to the number of agents', () => {
    const total = list => list.reduce((s, e) => s + e.count, 0);
    assert.equal(total(seg.byGroup), agents.length);
    assert.equal(total(seg.byCast), agents.length);
  });

  test('every average matches a hand calculation from the per-agent records', () => {
    const groups = byKey(agents, 'archetypeId'), cast = byKey(agents, 'personaId');
    for (const e of seg.byGroup) assertMatchesHand(e, groups.get(e.id) ?? [], names, `group ${e.id}`);
    for (const e of seg.byCast) assertMatchesHand(e, cast.get(e.id) ?? [], names, `cast ${e.id}`);
    // The market is busy enough that these are not trivially zero.
    const locals = seg.byGroup[0];
    assert.ok(locals.avgWait > 1 && locals.walkAwaysPerPerson > 0 && locals.shareNeverServed > 0 && locals.avgSpent > 0);
  });

  test('topPlaces lists up to 3 places, busiest first', () => {
    for (const e of [...seg.byGroup, ...seg.byCast]) {
      assert.ok(e.topPlaces.length <= 3);
      for (let i = 1; i < e.topPlaces.length; i++) assert.ok(e.topPlaces[i - 1].visits >= e.topPlaces[i].visits);
      assert.ok(e.topPlaces.every(p => p.visits > 0 && names.get(p.id) === p.name));
    }
    assert.ok(seg.byGroup.some(e => e.topPlaces.length === 3), 'some group was served at more than 3 places, and only 3 are listed');
  });

  test('visitsByPlace covers every place that served the segment and adds up to its visits', () => {
    for (const e of [...seg.byGroup, ...seg.byCast]) {
      const total = Object.values(e.visitsByPlace).reduce((t, k) => t + k, 0);
      assert.ok(Math.abs(total - e.avgVisits * e.count) < 1e-6, `${e.id}: ${total} visits vs avgVisits × count`);
      for (const p of e.topPlaces) assert.equal(e.visitsByPlace[p.id], p.visits);
      const order = [...names.keys()];
      const ids = Object.keys(e.visitsByPlace);
      assert.deepEqual(ids, [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b)), 'node order');
    }
    assert.ok(seg.byGroup.some(e => Object.keys(e.visitsByPlace).length > 3), 'a group served at more than 3 places lists them all');
  });

  test('frustration is null when nobody was asked (inline rules never ask)', () => {
    for (const e of [...seg.byGroup, ...seg.byCast]) assert.equal(e.avgFrustration, null);
  });

  test('archetypes metrics keep their shape', () => {
    const m = sim.metrics();
    assert.deepEqual(Object.keys(m.archetypes[0]), ['id', 'name', 'count', 'avgWaitPerAgent', 'avgServed', 'abandonsPerAgent', 'avgFrustration']);
  });
});

describe('segments on a tiny world, by hand', () => {
  test('one kiosk, room for everyone, price 12: exact values', () => {
    const sim = new Sim(KIOSK, { seed: 7 }).runToEnd();
    const agents = sim.agentsSummary(), { byGroup, byCast } = sim.metrics().segments;
    assert.equal(agents.length, 40);
    const commuters = agents.filter(a => a.archetypeId === 'commuters').length;
    assert.ok(commuters > 0 && commuters < 40);
    const exact = (id, name, group, count) => ({
      id, name, group, count, avgWait: 0, avgSpent: 12, avgVisits: 1, walkAwaysPerPerson: 0, shareNeverServed: 0, avgFrustration: null,
      topPlaces: [{ id: 'kiosk', name: 'Coffee kiosk', visits: count }], visitsByPlace: { kiosk: count }
    });
    assert.deepEqual(byGroup, [exact('commuters', 'Commuters', 'commuters', commuters), exact('visitors', 'Visitors', 'visitors', 40 - commuters)]);
    assert.deepEqual(byCast, [exact('gus', 'Gus Tarn', 'commuters', commuters), exact('ivy', 'Ivy Lund', 'visitors', 40 - commuters)]);
  });

  test('a segment nobody belongs to has count 0 and null averages', () => {
    const w = JSON.parse(JSON.stringify(KIOSK));
    w.minds.push({ id: 'rare', name: 'Rhea Sol', archetype: 'visitors', bio: 'Almost never here.', weight: 0.05 });
    w.arrivals.total = 10;
    const sim = new Sim(w, { seed: 7 }).runToEnd();
    // About 1% of arrivals copy Rhea; with 10 arrivals on seed 7, nobody does.
    const rare = sim.metrics().segments.byCast.find(e => e.id === 'rare');
    assert.deepEqual(rare, {
      id: 'rare', name: 'Rhea Sol', group: 'visitors', count: 0, avgWait: null, avgSpent: null, avgVisits: null,
      walkAwaysPerPerson: null, shareNeverServed: null, avgFrustration: null, topPlaces: [], visitsByPlace: {}
    });
  });
});

describe('byCast separates two cast members of one group', () => {
  // Dora always picks the cheese stall, Eli the bread stall; Dora reports frustration 3 after being served,
  // Eli is never asked how he feels (no answer), so the group's frustration is Dora's alone.
  const answer = r => {
    if (r.asks.choice === 'next_place') {
      const want = r.personaId === 'dora' ? 'cheese' : r.personaId === 'eli' ? 'bread' : r.auto.action;
      return { provider: 'test', action: r.options.some(o => o.key === want) ? want : 'leave' };
    }
    return r.personaId === 'dora' ? { provider: 'test', action: 'leave', frustration: { expected: 3 } } : { provider: 'test', action: r.auto?.action };
  };
  const sim = runExternal(TWO_STALLS, answer);
  const agents = sim.agentsSummary(), { byGroup, byCast } = sim.metrics().segments;
  const dora = byCast.find(e => e.id === 'dora'), eli = byCast.find(e => e.id === 'eli'), locals = byGroup.find(e => e.id === 'locals');

  test('each cast member has its own outcomes', () => {
    assert.ok(dora.count > 0 && eli.count > 0);
    assert.equal(dora.group, 'locals');
    assert.equal(eli.group, 'locals');
    assert.equal(dora.avgSpent, 14);
    assert.equal(eli.avgSpent, 5);
    assert.deepEqual(dora.topPlaces, [{ id: 'cheese', name: 'Cheese stall', visits: dora.count }]);
    assert.deepEqual(eli.topPlaces, [{ id: 'bread', name: 'Bread stall', visits: eli.count }]);
  });

  test('the group combines them', () => {
    assert.equal(locals.count, dora.count + eli.count);
    assert.ok(Math.abs(locals.avgSpent - (14 * dora.count + 5 * eli.count) / locals.count) < 1e-9);
    assert.deepEqual(locals.topPlaces.map(p => p.id).sort(), ['bread', 'cheese']);
  });

  test('frustration averages only the people who were asked; null when nobody was', () => {
    assert.equal(dora.avgFrustration, 3);
    assert.equal(eli.avgFrustration, null);
    assert.equal(locals.avgFrustration, 3);
    const felt = agents.filter(a => a.archetypeId === 'locals' && a.frustration != null);
    assert.equal(felt.length, dora.count);
  });

  test('counts still add up', () => {
    assert.equal(byCast.reduce((s, e) => s + e.count, 0), agents.length);
    assert.equal(byGroup.reduce((s, e) => s + e.count, 0), agents.length);
  });
});

// ---------- route segments ----------

describe('metrics().segments in route mode', () => {
  const sim = new Sim(ROADS, { seed: 7 }).runToEnd();
  const agents = sim.agentsSummary(), seg = sim.metrics().segments;

  test('route entries have exactly the §15a route shape', () => {
    assert.deepEqual(Object.keys(seg), ['byGroup', 'byCast']);
    assert.deepEqual(seg.byGroup.map(e => e.id), ['commuters', 'couriers']);
    assert.deepEqual(seg.byCast.map(e => [e.id, e.group]), [['gil', 'commuters'], ['hana', 'commuters'], ['ivan', 'couriers']]);
    for (const e of [...seg.byGroup, ...seg.byCast]) assert.deepEqual(Object.keys(e), ROUTE_KEYS);
  });

  test('counts add up and trips average over the agents who arrived', () => {
    assert.equal(seg.byGroup.reduce((s, e) => s + e.count, 0), agents.length);
    assert.equal(seg.byCast.reduce((s, e) => s + e.count, 0), agents.length);
    const groups = byKey(agents, 'archetypeId'), cast = byKey(agents, 'personaId');
    const check = (e, list) => {
      const arrived = list.filter(a => a.trip != null);
      assert.equal(e.count, list.length);
      near(e.avgTrip, mean(arrived, a => a.trip), `${e.id} avgTrip`);
      near(e.avgDelay, mean(arrived, a => a.delay), `${e.id} avgDelay`);
      assert.equal(e.avgFrustration, null);
    };
    for (const e of seg.byGroup) check(e, groups.get(e.id));
    for (const e of seg.byCast) check(e, cast.get(e.id));
    assert.ok(seg.byGroup[0].avgDelay > 0, 'the bottleneck delays someone');
  });

  test('frustration from arrive decisions is averaged over the agents asked', () => {
    const ext = runExternal(ROADS, r => (r.kind === 'arrive'
      ? { provider: 'test', frustration: { expected: r.archetypeId === 'couriers' ? 4 : 1 } }
      : { provider: 'test', action: r.auto.action }));
    const { byGroup } = ext.metrics().segments;
    const asked = ext.agentsSummary().filter(a => a.frustration != null);
    assert.ok(asked.length > 0);
    for (const e of byGroup) {
      assert.ok(asked.some(a => a.archetypeId === e.id), `some ${e.id} were delayed enough to be asked`);
      assert.equal(e.avgFrustration, e.id === 'couriers' ? 4 : 1, e.id);
    }
  });
});
