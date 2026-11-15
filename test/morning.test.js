// The morning question (docs/PROTOTYPE.md §20): what a person is told about their own past visits, and the
// yes/no question Jev is asked. The shop and people here are fictional and hand-made.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpec } from '../engine/spec.js';
import { memoryWords, moneyWords, morningObservation, visitObservation, MEMORY_MAX } from '../engine/observe.js';
import { buildJevRequest, parseAnswers } from '../providers/jev.js';
import { fallbackDecision } from '../providers/rules.js';
import { morningRequest, friendRemark, shopView } from '../run/morning.js';

const WORLD = {
  title: 'Fern Street bakery (fictional)',
  question: 'Who comes back?',
  context: 'A weekday morning on Fern Street. Crumb & Co is an independent bakery. A supermarket bakery is around the corner.',
  mode: 'visit', duration: 180, clockStart: 450, travelSpeed: 40,
  arrivals: { total: 40, start: 0, end: 120, shape: 'uniform' },
  nodes: [
    { id: 'door', name: 'Fern Street', kind: 'gate', x: 50, y: 90 },
    { id: 'bakery', name: 'Crumb & Co', kind: 'service', x: 50, y: 40, servers: 1, serviceTime: 2, appeal: 0.7, price: 4, tags: ['bread', 'pastry'], about: 'Small bakery. Bread baked that morning.' },
    { id: 'market', name: 'Fern Market bakery', kind: 'service', x: 80, y: 40, servers: 2, serviceTime: 1, appeal: 0.4, price: 3.5, tags: ['bread'], about: 'Supermarket counter. Cheap and quick.' }
  ],
  archetypes: [{ id: 'locals', name: 'Locals', share: 1, visits: 1, patience: 8, info: 0 }],
  minds: [
    { id: 'ines', name: 'Ines Carvalho', age: 44, archetype: 'locals', bio: 'Buys bread on the way to work most days.', personality: 'brisk, loyal to small shops', goal: 'A loaf before the 8:10 bus', social: 'talks to her neighbours' },
    { id: 'noor', name: 'Noor Haddad', age: 23, archetype: 'locals', bio: 'New to the street.', informed: true }
  ]
};
const spec = normalizeSpec(JSON.parse(JSON.stringify(WORLD)));
const ines = spec.minds.find(m => m.id === 'ines');
const S = 'Crumb & Co';

describe('memoryWords: one remembered event as a fact', () => {
  test('a visit gives the wait and how it ended, with no verdict', () => {
    assert.equal(memoryWords({ daysAgo: 1, wait: 20, outcome: 'served' }, S), 'Yesterday: waited about 20 minutes in line at Crumb & Co, then was served.');
    assert.equal(memoryWords({ daysAgo: 3, wait: 20, outcome: 'left' }, S), '3 days ago: waited about 20 minutes in line at Crumb & Co, then left without ordering.');
    assert.equal(memoryWords({ daysAgo: 1, wait: 0, outcome: 'served' }, S), 'Yesterday: no line at Crumb & Co, served right away.');
    assert.equal(memoryWords({ daysAgo: 2, wait: 1, outcome: 'served' }, S), '2 days ago: waited about 1 minute in line at Crumb & Co, then was served.');
    for (const r of [{ daysAgo: 1, wait: 45, outcome: 'left' }, { daysAgo: 1, wait: 2, outcome: 'served' }]) {
      assert.equal(/long|short|put up with|too/.test(memoryWords(r, S)), false);
    }
  });

  test('dates read as people say them', () => {
    const when = d => memoryWords({ daysAgo: d, wait: 5, outcome: 'served' }, S).split(':')[0];
    assert.deepEqual([0, 1, 2, 6, 7, 14, 28, 30].map(when), ['Earlier today', 'Yesterday', '2 days ago', '6 days ago', '1 week ago', '2 weeks ago', '4 weeks ago', '30 days ago']);
  });

  test('how the line ended, what was paid and a first visit are stated when given', () => {
    assert.equal(memoryWords({ daysAgo: 1, wait: 15, outcome: 'served', ending: 'fast' }, S), 'Yesterday: waited about 15 minutes in line at Crumb & Co, slow at first and quick at the end, then was served.');
    assert.equal(memoryWords({ daysAgo: 1, wait: 15, outcome: 'served', ending: 'slow' }, S), 'Yesterday: waited about 15 minutes in line at Crumb & Co, quick at first and stalled just before the counter, then was served.');
    assert.equal(memoryWords({ daysAgo: 4, first: true, wait: 5, outcome: 'served', paid: 3.2, promo: '20%-off promotion' }, S),
      '4 days ago (first visit): waited about 5 minutes in line at Crumb & Co, then was served, and paid $3.20 with a 20%-off promotion.');
    assert.equal(memoryWords({ daysAgo: 4, wait: 5, outcome: 'left', paid: 4 }, S).includes('paid'), false, 'nobody pays after leaving');
  });

  test('any other event is its text, with one full stop', () => {
    assert.equal(memoryWords({ daysAgo: 1, text: 'it rained all morning. ' }, S), 'Yesterday: it rained all morning.');
  });

  test('money is exact to the cent', () => {
    assert.deepEqual([4, 4.5, 0.75, 0].map(moneyWords), ['$4.00', '$4.50', '$0.75', 'free']);
  });
});

describe('morningObservation: what a person is told before the day starts', () => {
  const ctx = over => ({
    spec, t: 0, person: { name: ines.name, age: ines.age, bio: ines.bio, personality: ines.personality, goal: ines.goal, social: ines.social, groupName: 'Locals' },
    shop: { name: S, about: 'Small bakery.', tags: ['bread', 'pastry'], price: 4 }, others: [{ name: 'Fern Market bakery', about: 'Cheap and quick.', price: 3.5 }], ...over
  });

  test('with no record it holds the setting, the person, the shop and the other places', () => {
    const o = morningObservation(ctx({}));
    assert.deepEqual(Object.keys(o), ['setting', 'time', 'person', 'now', 'shop', 'other_places']);
    assert.equal(o.now, 'Deciding whether to go to Crumb & Co today.');
    assert.equal(o.time, 'around 7:30 am');
    assert.deepEqual(o.shop, { name: S, known_for: 'Small bakery.', offers: 'bread, pastry', cost: '$4.00' });
    assert.deepEqual(o.other_places, [{ name: 'Fern Market bakery', known_for: 'Cheap and quick.', cost: '$3.50' }]);
    assert.equal(Object.hasOwn(o.person, 'has_live_wait_app'), false, 'nobody sees a line from home');
    assert.equal(JSON.stringify(o).includes('line'), false);
  });

  test('history, memory, card, remarks and offers appear only when given', () => {
    const o = morningObservation(ctx({
      history: { visits: 8, weeks: 4 }, memory: [{ daysAgo: 1, wait: 20, outcome: 'left' }], card: { have: 8, need: 10, reward: 'a free loaf' },
      heard: ['A friend (yesterday): long line at Crumb & Co'], offers: ['Crumb & Co: 20% off everything today.']
    }));
    assert.equal(o.history, 'Has been to Crumb & Co 8 times in the last 4 weeks.');
    assert.deepEqual(o.memory, ['Yesterday: waited about 20 minutes in line at Crumb & Co, then left without ordering.']);
    assert.equal(o.card, 'Stamp card for Crumb & Co: 8 of 10 stamps filled. A full card earns a free loaf.');
    assert.deepEqual(o.heard, ['A friend (yesterday): long line at Crumb & Co']);
    assert.deepEqual(o.offers, ['Crumb & Co: 20% off everything today.']);
  });

  test('history words: never, once, and a count', () => {
    const h = history => morningObservation(ctx({ history })).history;
    assert.equal(h({ visits: 0, via: 'has walked past it' }), 'Has never been to Crumb & Co; has walked past it.');
    assert.equal(h({ visits: 0 }), 'Has never been to Crumb & Co.');
    assert.equal(h({ visits: 1 }), 'Has been to Crumb & Co once.');
    assert.equal(h({ visits: 3, weeks: 1 }), 'Has been to Crumb & Co 3 times in the last week.');
    assert.equal(h(undefined), undefined);
  });

  test('the price shows a change, an offer, or nothing extra', () => {
    const cost = shop => morningObservation(ctx({ shop: { name: S, price: 4, ...shop } })).shop.cost;
    assert.equal(cost({}), '$4.00');
    assert.equal(cost({ wasPrice: 4 }), '$4.00 (the same as last week)');
    assert.equal(cost({ price: 4.5, wasPrice: 4 }), '$4.50 (it was $4.00 last week)');
    assert.equal(cost({ offerPrice: 3.2 }), '$3.20 with the offer (usually $4.00)');
    assert.equal(morningObservation(ctx({ shop: { name: S, price: 4, rating: 4.5 } })).shop.rating, '4.5 out of 5 stars from online reviews');
  });

  test('a head start on the stamp card is said as a fact', () => {
    const card = c => morningObservation(ctx({ card: c })).card;
    assert.equal(card({ have: 2, need: 10, free: 2, reward: 'a free loaf' }), 'Stamp card for Crumb & Co: 2 of 10 stamps filled (the first 2 were given free at sign-up). A full card earns a free loaf.');
    assert.equal(card({ have: 0, need: 8 }), 'Stamp card for Crumb & Co: 0 of 8 stamps filled. A full card earns a free one.');
    assert.equal(card({ have: 3 }), undefined);
  });

  test(`at most ${MEMORY_MAX} memories are shown, in the order given`, () => {
    const memory = Array.from({ length: 8 }, (_, i) => ({ daysAgo: i + 1, wait: 5, outcome: 'served' }));
    const o = morningObservation(ctx({ memory }));
    assert.equal(o.memory.length, MEMORY_MAX);
    assert.match(o.memory[0], /^Yesterday/);
  });

  test('the visit observation still carries the app field, as before', () => {
    const o = visitObservation({ spec, t: 5, person: { name: 'Noor Haddad', informed: true }, moment: { kind: 'choose', why: 'start' }, places: [] });
    assert.equal(o.person.has_live_wait_app, true);
  });
});

describe('the visit_today question', () => {
  const req = state => morningRequest({ spec, shopId: 'bakery', mind: ines, state });

  test('the request is a yes/no question asked alone, with a rule answer', () => {
    const r = req({ history: { visits: 8, weeks: 4 } });
    assert.equal(r.kind, 'morning');
    assert.deepEqual(r.asks, { yesNo: 'visit_today', choice: null, frustration: false, tellOthers: false });
    assert.equal(r.placeId, 'bakery');
    assert.equal(r.observation.person.group, 'Locals');
    assert.deepEqual(r.observation.other_places.map(p => p.name), ['Fern Market bakery']);
    assert.equal(fallbackDecision(r, 'no key').action, 'yes');
  });

  test('the instructions name only the fields this person has', () => {
    const q = state => buildJevRequest(req(state), { spec }).body.questions;
    assert.deepEqual(Object.keys(q({})), ['visit_today']);
    assert.equal(q({}).visit_today.type, 'noul');
    assert.equal(q({}).visit_today.instructions, 'Does the person in `person` go to the shop in `shop` today?');
    assert.equal(q({ history: { visits: 0 } }).visit_today.instructions, 'Does the person in `person` go to the shop in `shop` today, given `history`?');
    assert.equal(q({ history: { visits: 2 }, memory: [{ daysAgo: 1, wait: 5, outcome: 'served' }], card: { have: 1, need: 10 }, heard: ['x'], offers: ['y'] }).visit_today.instructions,
      'Does the person in `person` go to the shop in `shop` today, given `history`, `memory`, `card`, `heard` and `offers`?');
    assert.deepEqual(q({}).visit_today.criteria, { true: 'They go to this shop today.', false: 'They do not: they go somewhere else or go without.' });
  });

  test('the answer parses to a chance of going', () => {
    assert.deepEqual(parseAnswers(req({}), { visit_today: { noul: 0.62 } }), { yesProb: 0.62 });
    assert.throws(() => parseAnswers(req({}), {}), /visit_today/);
  });

  test('the same person and record always give the same request; one changed fact gives another', () => {
    const a = buildJevRequest(req({ memory: [{ daysAgo: 1, wait: 20, outcome: 'served' }] }), { spec });
    const b = buildJevRequest(req({ memory: [{ daysAgo: 1, wait: 20, outcome: 'served' }] }), { spec });
    const c = buildJevRequest(req({ memory: [{ daysAgo: 1, wait: 20, outcome: 'left' }] }), { spec });
    assert.equal(a.requestHash, b.requestHash);
    assert.notEqual(a.requestHash, c.requestHash);
  });

  test("today's price, last week's price, the offer price and the rating reach the shop", () => {
    assert.equal(req({ price: 4.5, wasPrice: 4 }).observation.shop.cost, '$4.50 (it was $4.00 last week)');
    assert.equal(req({ offerPrice: 3.2 }).observation.shop.cost, '$3.20 with the offer (usually $4.00)');
    assert.equal(req({ rating: 4 }).observation.shop.rating, '4.0 out of 5 stars from online reviews');
    assert.equal(req({}).observation.shop.cost, '$4.00');
  });

  test('it needs a visit world, a cast member and a real shop', () => {
    assert.throws(() => morningRequest({ spec: { mode: 'route' }, mind: ines }), /visit world/);
    assert.throws(() => morningRequest({ spec, mind: null }), /cast member/);
    assert.throws(() => morningRequest({ spec, shopId: 'nowhere', mind: ines }), /No service place/);
    assert.equal(shopView(spec).shop.id, 'bakery', 'the first service place by default');
  });

  test("a friend's remark uses the engine's remark words", () => {
    assert.equal(friendRemark('long_line', S), 'A friend (yesterday): long line at Crumb & Co');
    assert.equal(friendRemark('good_experience', S), 'A friend (yesterday): Crumb & Co was good and quick');
    assert.equal(friendRemark('the market was busy', S, { who: 'A neighbour', when: '2 days ago' }), 'A neighbour (2 days ago): the market was busy');
  });
});

describe('adding the morning question changes no other request', () => {
  test('join and keep_waiting keep their instructions, with and without offers', () => {
    const line = (obs, yesNo = 'join') => buildJevRequest({ asks: { yesNo }, observation: obs }, { spec }).body.questions[yesNo].instructions;
    assert.equal(line({ now: 'x' }), 'Does the person in `person` join the line described in `now`?');
    assert.equal(line({ now: 'x', offers: ['y'] }), 'Does the person in `person` join the line described in `now`, given `offers`?');
    assert.equal(line({ now: 'x' }, 'keep_waiting'), 'Does the person in `person` keep waiting in the line described in `now`?');
  });
});
