// The multi-day loop (docs/PROTOTYPE.md §21): the pool, the morning step, the engine's listed arrivals and the
// evening update. No network: the providers here are the rule model and small made-up ones. The shop and the
// people are fictional.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeSpec } from '../engine/spec.js';
import { Sim } from '../engine/sim.js';
import { memoryWords } from '../engine/observe.js';
import { RulesProvider } from '../providers/rules.js';
import {
  WEEK, calendarDay, rememberedWait, normalizePool, buildPeople, changeFor, recordsFor, usualToday, movedChance,
  runDays, summarize, realism, compareDays, renderDays
} from '../run/days.js';

const WORLD = {
  title: 'Fern Street bakery (fictional)',
  question: 'Who comes back?',
  context: 'A weekday morning on Fern Street. Crumb & Co is an independent bakery. A supermarket bakery is around the corner.',
  mode: 'visit', duration: 150, clockStart: 450, travelSpeed: 40,
  arrivals: { total: 60, start: 0, end: 120, shape: 'peak' },
  nodes: [
    { id: 'street', name: 'Fern Street', kind: 'gate', x: 50, y: 90 },
    { id: 'bakery', name: 'Crumb & Co', kind: 'service', x: 50, y: 40, servers: 1, serviceTime: 2.5, serviceDist: 'fixed', appeal: 0.7, price: 4, tags: ['bread'], about: 'Small bakery. One person serving.' },
    { id: 'market', name: 'Fern Market bakery', kind: 'service', x: 80, y: 40, servers: 3, serviceTime: 1, appeal: 0.4, price: 3.5, tags: ['bread'], about: 'Supermarket counter.' }
  ],
  archetypes: [
    { id: 'locals', name: 'Locals', share: 0.7, visits: 1, patience: 8, info: 0, needs: ['bread'] },
    { id: 'passing', name: 'Passing through', share: 0.3, visits: 1, patience: 5, info: 0, needs: ['bread'] }
  ],
  minds: [
    { id: 'ines', name: 'Ines Carvalho', age: 44, archetype: 'locals', bio: 'Buys bread on the way to work most days.' },
    { id: 'theo', name: 'Theo Marsh', age: 61, archetype: 'locals', bio: 'Comes on Fridays.' },
    { id: 'noor', name: 'Noor Haddad', age: 23, archetype: 'passing', bio: 'New to the street.' },
    { id: 'visitor', name: 'A day visitor', age: 30, archetype: 'passing', bio: 'In town for one day.' }
  ]
};
const POOL = {
  title: 'Fern Street (fictional)', world: 'n/a', shop: 'bakery', size: 100,
  people: {
    ines: { usualPerWeek: 4, knows: 1 }, theo: { usualPerWeek: 1, knows: 1 },
    noor: { usualPerWeek: 2, knows: 0.2, newcomer: true }, visitor: { usualPerWeek: 0, knows: 0, dayVisitor: true }
  },
  ordinaryWait: 5, trialPerWeek: 1, walkPast: 0.1, tellReach: 2
};
const spec = normalizeSpec(JSON.parse(JSON.stringify(WORLD)));
const pool = normalizePool(POOL);
const rules = () => new RulesProvider();

describe('days: small pieces', () => {
  test('a week is 5 mornings, and Monday is 3 calendar days after Friday', () => {
    assert.equal(WEEK, 5);
    assert.deepEqual([0, 4, 5, 9, 10].map(calendarDay), [0, 4, 7, 11, 14]);
  });

  test('a wait is remembered to the minute when short and to 5 minutes from 10 up', () => {
    assert.deepEqual([0.4, 1.2, 6.6, 9.4, 11, 13, 22.6].map(rememberedWait), [0, 1, 7, 9, 10, 15, 25]);
  });

  test('someone who turned away on seeing the line remembers the line', () => {
    assert.equal(memoryWords({ daysAgo: 1, wait: 0, outcome: 'left', ahead: 9 }, 'Crumb & Co'), 'Yesterday: found 9 people in line at Crumb & Co and left without ordering.');
    assert.equal(memoryWords({ daysAgo: 3, wait: 0, outcome: 'left', ahead: 1 }, 'Crumb & Co'), '3 days ago: found 1 person in line at Crumb & Co and left without ordering.');
    assert.equal(memoryWords({ daysAgo: 1, wait: 12, outcome: 'left', ahead: null }, 'Crumb & Co'), 'Yesterday: waited about 12 minutes in line at Crumb & Co, then left without ordering.');
  });

  test('the chance is the usual rate moved by the odds between two Jev answers', () => {
    assert.equal(movedChance({ usual: 0.3 }), 0.3);
    assert.equal(movedChance({ usual: 0.3, now: 0.5, reference: null }), 0.3, 'no answer: the usual rate');
    assert.ok(Math.abs(movedChance({ usual: 0.3, now: 0.6, reference: 0.6 }) - 0.3) < 1e-9, 'the same answer moves nothing');
    const down = movedChance({ usual: 0.3, now: 0.4, reference: 0.6 });
    assert.ok(down < 0.3 && down > 0.1);
    // The level comes from the person: the same pair of answers moves a daily customer and an occasional one
    // by the same odds, not to the same chance.
    const daily = movedChance({ usual: 0.95, now: 0.4, reference: 0.6 }), rare = movedChance({ usual: 0.1, now: 0.4, reference: 0.6 });
    assert.ok(daily > 0.85 && rare < 0.06);
    const odds = p => p / (1 - p);
    assert.ok(Math.abs(odds(daily) / odds(0.95) - odds(rare) / odds(0.1)) < 1e-9);
  });

  test('loss aversion multiplies only the part of the move the price rise caused', () => {
    const logit = p => Math.log(p / (1 - p));
    const base = { usual: 0.5, reference: 0.6 };
    const plain = movedChance({ ...base, now: 0.5 });
    const noRule = movedChance({ ...base, now: 0.5, unpriced: 0.6, lossAversion: 1 });
    const doubled = movedChance({ ...base, now: 0.5, unpriced: 0.6, lossAversion: 2 });
    assert.ok(Math.abs(plain - noRule) < 1e-9);
    assert.ok(Math.abs(logit(doubled) - 2 * logit(plain)) < 1e-9, 'all of the move was the price: doubled');
    // Half of the move came from something else (a bad visit): only the price half is doubled.
    const mixed = movedChance({ ...base, now: 0.4, unpriced: 0.5, lossAversion: 2 });
    assert.ok(Math.abs(logit(mixed) - ((logit(0.5) - logit(0.6)) + 2 * (logit(0.4) - logit(0.5)))) < 1e-9);
  });
});

describe('days: the pool', () => {
  test('defaults fill in, values are clamped, and a pool with no people cannot run', () => {
    const p = normalizePool({ people: { ines: { usualPerWeek: 9, knows: 2 } } });
    assert.deepEqual(p.people.ines, { usualPerWeek: 5, knows: 1, weight: 1, newcomer: false, dayVisitor: false });
    assert.deepEqual([p.size, p.ordinaryWait, p.rules.lossAversion, p.habit.length], [200, 5, 2, 5]);
    assert.throws(() => normalizePool({}), /people/);
  });

  test('people are copies of the cast in the world\'s shares, and a day visitor is left out', () => {
    const people = buildPeople(pool, spec, 7);
    assert.equal(people.length, 100);
    const count = id => people.filter(p => p.persona === id).length;
    assert.deepEqual([count('ines'), count('theo'), count('noor'), count('visitor')], [35, 35, 30, 0]);
    assert.equal(people.filter(p => p.persona === 'noor' && p.knows).length, 6);
    assert.ok(people.filter(p => p.persona === 'ines').every(p => p.knows && p.established && p.usual === 0.8 && p.lastPaid === 4));
    assert.ok(people.every(p => p.time >= 0 && p.time <= 120));
  });

  test('the make-up is the same for every seed; usual times are not', () => {
    const a = buildPeople(pool, spec, 7), b = buildPeople(pool, spec, 8);
    assert.deepEqual(a.map(p => [p.id, p.knows]), b.map(p => [p.id, p.knows]));
    assert.notDeepEqual(a.map(p => p.time), b.map(p => p.time));
    assert.deepEqual(buildPeople(pool, spec, 7), a);
  });

  test('a weight changes how many of a kind of person there are', () => {
    const heavy = buildPeople(normalizePool({ ...POOL, people: { ...POOL.people, noor: { ...POOL.people.noor, weight: 3 } } }), spec, 7);
    assert.ok(heavy.filter(p => p.persona === 'noor').length > 50);
    assert.equal(heavy.length, 100);
  });

  test('the named changes', () => {
    assert.deepEqual(changeFor('staff+1', spec, 'bakery', 10).patch, [{ kind: 'node', id: 'bakery', field: 'servers', value: 2 }]);
    assert.deepEqual(changeFor('price+0.5', spec, 'bakery', 10).patch, [{ kind: 'node', id: 'bakery', field: 'price', value: 4.5 }]);
    const promo = changeFor('promo20', spec, 'bakery', 10);
    assert.deepEqual([promo.from, promo.to, promo.promo.priceOff, promo.promo.text], [0, 4, 0.2, 'Crumb & Co: 20% off everything today.']);
    assert.deepEqual(changeFor('card10', spec, 'bakery', 10).card, { need: 10, reward: 'a free coffee' });
    assert.equal(changeFor('none', spec, 'bakery', 10), null);
    assert.throws(() => changeFor('magic', spec, 'bakery', 10), /Unknown change/);
  });
});

describe('days: a person\'s record each morning', () => {
  const ctx = over => ({ shopId: 'bakery', shopName: 'Crumb & Co', price: 4, refPrice: 4, ordinaryWait: 5, promo: null, card: null, ...over });
  const person = over => ({ id: 'ines-1', persona: 'ines', group: 'locals', usual: 0.8, knows: true, established: true, went: [], visits: [], served: 0, lastPaid: 4, card: null, heard: [], ...over });

  test('with nothing to remember, today is the reference: Jev need not be asked', () => {
    const r = recordsFor(person(), 3, ctx());
    assert.deepEqual(r.today, r.reference);
    assert.deepEqual(r.today.history, { visits: 14, weeks: 4 }, 'before day 0 they came at their usual rate');
    assert.equal(r.unpriced, null);
  });

  test('a visit is remembered with its date; the reference has the same visit as an ordinary one', () => {
    const p = person({ went: [1], visits: [{ day: 1, wait: 20, outcome: 'left', ahead: null }] });
    const r = recordsFor(p, 5, ctx());   // day 1 is Tuesday; day 5 the next Monday
    assert.deepEqual(r.today.memory, [{ daysAgo: 6, wait: 20, outcome: 'left', ahead: null }]);
    assert.deepEqual(r.reference.memory, [{ daysAgo: 6, wait: 5, outcome: 'served' }]);
    assert.deepEqual(r.today.history, r.reference.history);
  });

  test('up to three visits from the last 28 days, newest first', () => {
    const visits = [0, 2, 3, 4, 11].map(day => ({ day, wait: day, outcome: 'served', ahead: null }));
    const r = recordsFor(person({ went: [0, 2, 3, 4, 11], visits }), 12, ctx());
    assert.deepEqual(r.today.memory.map(m => m.wait), [11, 4, 3]);
    assert.deepEqual(r.today.memory.map(m => m.daysAgo), [1, 12, 13], 'calendar days, across a weekend');
    const old = recordsFor(person({ went: [0], visits: [visits[0]] }), 25, ctx());
    assert.deepEqual(old.today.memory, [], 'day 0 is 35 calendar days before day 25');
  });

  test('a price rise is shown against last week until they have paid the new price', () => {
    const before = recordsFor(person(), 2, ctx({ price: 4.5 }));
    assert.deepEqual([before.today.price, before.today.wasPrice, before.reference.price], [4.5, 4, 4]);
    assert.deepEqual([before.unpriced.price, before.unpriced.wasPrice], [4, undefined]);
    const after = recordsFor(person({ lastPaid: 4.5 }), 2, ctx({ price: 4.5 }));
    assert.equal(after.today.wasPrice, undefined);
    assert.equal(after.today.price, 4.5, 'the level still differs from the reference price');
    assert.equal(recordsFor(person(), 2, ctx({ price: 3.5 })).unpriced, null, 'a cut needs no loss-aversion ask');
  });

  test('a card, remarks and a promotion appear when the person has them', () => {
    const p = person({ card: { have: 8 }, heard: [{ day: 0, kind: 'good_experience' }, { day: 4, kind: 'long_line' }], reached: true });
    const r = recordsFor(p, 5, ctx({ card: { need: 10, reward: 'a free loaf' }, promo: { text: 'Crumb & Co: 20% off everything today.', priceOff: 0.2 } }));
    assert.deepEqual(r.today.card, { have: 8, need: 10, reward: 'a free loaf' });
    assert.deepEqual(r.today.heard, ['A friend (3 days ago): long line at Crumb & Co', 'A friend (1 week ago): Crumb & Co was good and quick']);
    assert.deepEqual([r.today.offers, r.today.offerPrice], [['Crumb & Co: 20% off everything today.'], 3.2]);
    assert.deepEqual(Object.keys(r.reference).sort(), ['history', 'memory', 'price']);
    assert.equal(recordsFor(person({ reached: false }), 5, ctx({ promo: { text: 'x', priceOff: 0.2 } })).today.offers, undefined);
  });

  test('someone who has never been is told how they know the shop', () => {
    const r = recordsFor(person({ established: false, lastPaid: null, via: 'a friend mentioned it' }), 2, ctx());
    assert.deepEqual(r.today.history, { visits: 0, via: 'a friend mentioned it' });
  });

  test('the usual chance: a trial rate, then the habit ladder, then their kind\'s rate', () => {
    assert.equal(usualToday(person(), pool), 0.8);
    assert.equal(usualToday(person({ established: false, served: 0 }), pool), pool.trialPerWeek / 5);
    assert.ok(Math.abs(usualToday(person({ established: false, served: 1 }), pool) - 0.8 * 0.25) < 1e-9);
    assert.ok(Math.abs(usualToday(person({ established: false, served: 3 }), pool) - 0.8 * 0.83) < 1e-9);
    assert.equal(usualToday(person({ established: false, served: 12 }), pool), 0.8);
  });
});

describe('days: the engine takes a list of arrivals', () => {
  const run = arrivals => { const sim = new Sim(spec, { seed: 3, arrivals }); while (!sim.done) sim.step(); return sim; };

  test('each listed person arrives at their time, as their cast member, and walks to their first place', () => {
    const sim = run([{ t: 30, persona: 'theo', first: 'bakery', tag: 'theo-2' }, { t: 10, persona: 'ines', first: 'bakery', tag: 'ines-1' }]);
    const agents = sim.agentsSummary();
    assert.deepEqual(agents.map(a => [a.tag, a.personaId, a.born]), [['ines-1', 'ines', 10], ['theo-2', 'theo', 30]]);
    assert.deepEqual(agents.map(a => a.visits), [['bakery'], ['bakery']]);
    assert.deepEqual(agents[0].lines, [{ place: 'bakery', wait: 0, ahead: null, outcome: 'served' }]);
  });

  test('a crowd at one time makes a line; the log says who waited and who turned away', () => {
    const crowd = Array.from({ length: 12 }, (_, i) => ({ t: 20 + i * 0.1, persona: 'noor', first: 'bakery', tag: `noor-${i}` }));
    const agents = run(crowd).agentsSummary();
    const atBakery = agents.map(a => a.lines.find(l => l.place === 'bakery'));
    assert.ok(atBakery.every(Boolean));
    assert.ok(atBakery.some(l => l.outcome === 'served' && l.wait >= 2), 'someone waited');
    const turned = atBakery.filter(l => l.outcome === 'left');
    assert.ok(turned.length > 0, 'someone turned away');
    assert.ok(turned.every(l => l.wait === 0 && l.ahead >= 1), 'they saw a line and did not wait');
  });

  test('without the option nothing changes: no tags, no line log, the usual schedule', () => {
    const sim = new Sim(spec, { seed: 3 });
    while (!sim.done) sim.step();
    const agents = sim.agentsSummary();
    assert.equal(agents.length, 60);
    assert.ok(agents.every(a => !Object.hasOwn(a, 'tag') && !Object.hasOwn(a, 'lines')));
    const again = new Sim(spec, { seed: 3, arrivals: undefined });
    while (!again.done) again.step();
    assert.deepEqual(again.agentsSummary(), agents);
  });

  test('an unknown cast member or place falls back to the engine\'s own choice', () => {
    const agents = run([{ t: 5, persona: 'nobody', first: 'nowhere', tag: 'x' }]).agentsSummary();
    assert.equal(agents.length, 1);
    assert.equal(agents[0].tag, 'x');
  });
});

describe('days: a run', () => {
  test('with the rule model everyone comes at their usual rate, and the run repeats exactly', async () => {
    const a = await runDays({ pool: POOL, spec: WORLD, days: 6, seed: 7, provider: rules() });
    const b = await runDays({ pool: POOL, spec: WORLD, days: 6, seed: 7, provider: rules() });
    assert.deepEqual(a, b);
    assert.equal(a.days.length, 6);
    const expected = 35 * 0.8 + 35 * 0.2 + 6 * 0.4;
    for (const d of a.days) assert.ok(Math.abs(d.went - expected) < 15, `day ${d.day}: ${d.went} came, about ${expected} expected`);
    assert.ok(a.days.every(d => d.served + d.left <= d.went));
    assert.notDeepEqual((await runDays({ pool: POOL, spec: WORLD, days: 6, seed: 8, provider: rules() })).days, a.days);
  });

  test('each evening writes what happened into the person\'s record', async () => {
    const run = await runDays({ pool: POOL, spec: WORLD, days: 4, seed: 7, provider: rules() });
    const regular = run.people.find(p => p.persona === 'ines' && p.went.length >= 2);
    assert.equal(regular.visits.length, regular.went.length);
    assert.ok(regular.visits.every(v => ['served', 'left'].includes(v.outcome) && Number.isInteger(v.wait)));
    assert.equal(regular.served, regular.visits.filter(v => v.outcome === 'served').length);
    const left = run.people.flatMap(p => p.visits).filter(v => v.outcome === 'left');
    assert.ok(left.length > 0, 'one person serving: some people turn away');
    assert.equal(run.days.reduce((s, d) => s + d.left, 0), left.length);
  });

  test('people who do not know the shop find it over time, and first visits are counted once', async () => {
    const run = await runDays({ pool: POOL, spec: WORLD, days: 10, seed: 7, provider: rules() });
    assert.ok(run.days.at(-1).known > run.days[0].known);
    const firsts = run.people.filter(p => p.firstDay != null);
    assert.ok(firsts.length > 0);
    assert.ok(firsts.every(p => !p.established && p.went[0] === p.firstDay));
    assert.equal(run.days.reduce((s, d) => s + d.firstTime, 0), firsts.length);
  });

  // A stand-in for Jev that reads the memory: each bad memory lowers the chance, a card near its reward
  // and an offer raise it, a higher price lowers it.
  const reader = () => ({
    name: 'reader', external: false, asked: 0,
    async decideMany(reqs) {
      return reqs.map(r => {
        this.asked++;
        const o = r.observation;
        const bad = (o.memory || []).filter(m => /left without ordering|about (1[5-9]|[2-9]\d) minutes/.test(m)).length;
        const price = Number(/\$(\d+\.\d\d)/.exec(o.shop.cost)[1]);
        return { provider: 'jev', yesProb: Math.min(0.95, Math.max(0.05, 0.6 - 0.2 * bad - 0.2 * (price - 4) + (o.offers ? 0.15 : 0) + (o.card ? 0.1 : 0))) };
      });
    },
    stats() { return { provider: 'reader', requests: this.asked }; }
  });

  test('a provider that reads memory keeps people away after bad visits; one more person serving brings them back', async () => {
    const plain = await runDays({ pool: POOL, spec: WORLD, days: 10, seed: 7, provider: rules() });
    const read = await runDays({ pool: POOL, spec: WORLD, days: 10, seed: 7, provider: reader() });
    const visits = r => r.days.reduce((s, d) => s + d.went, 0);
    assert.equal(read.days[0].went, plain.days[0].went, 'day 0: nothing to remember yet');
    assert.ok(visits(read) < visits(plain), `${visits(read)} against ${visits(plain)}`);
    assert.ok(read.asked > 0);
    const staffed = await runDays({ pool: POOL, spec: WORLD, days: 10, seed: 7, provider: reader(), change: changeFor('staff+1', spec, 'bakery', 10) });
    assert.ok(visits(staffed) > visits(read), 'shorter lines, better memories, more visits');
  });

  test('a price rise costs visits only when the provider reads the price; a promotion brings first-timers', async () => {
    const days = 10;
    const base = await runDays({ pool: POOL, spec: WORLD, days, seed: 7, provider: reader() });
    const dearer = await runDays({ pool: POOL, spec: WORLD, days, seed: 7, provider: reader(), change: changeFor('price+0.5', spec, 'bakery', days) });
    const visits = r => r.days.reduce((s, d) => s + d.went, 0);
    assert.ok(visits(dearer) < visits(base));
    const sameUnderRules = await runDays({ pool: POOL, spec: WORLD, days, seed: 7, provider: rules(), change: changeFor('price+0.5', spec, 'bakery', days) });
    assert.equal(visits(sameUnderRules), visits(await runDays({ pool: POOL, spec: WORLD, days, seed: 7, provider: rules() })));
    const promo = await runDays({ pool: POOL, spec: WORLD, days, seed: 7, provider: reader(), change: changeFor('promo20', spec, 'bakery', days) });
    const firsts = r => r.days.reduce((s, d) => s + d.firstTime, 0);
    assert.ok(firsts(promo) > firsts(base));
    assert.ok(promo.people.flatMap(p => p.visits).some(v => v.paid === 3.2), 'the discount is paid at the counter');
  });

  test('a stamp card fills one stamp per served visit and starts again when full', async () => {
    const days = 10;
    const seen = [];
    const watch = { ...reader(), async decideMany(reqs) { for (const r of reqs) if (r.observation.card) seen.push(r.observation.card); return reader().decideMany(reqs); } };
    await runDays({ pool: POOL, spec: WORLD, days, seed: 7, provider: watch, change: { from: 0, to: days - 1, label: 'card', card: { need: 3, reward: 'a free loaf' } } });
    const stamps = new Set(seen.map(c => Number(/(\d+) of 3 stamps/.exec(c)[1])));
    assert.deepEqual([...stamps].sort(), [0, 1, 2], 'a full card starts again at 0');
  });
});

describe('days: comparing a change with its baseline', () => {
  test('the baseline runs once per seed and effects are seed by seed', async () => {
    const changes = [changeFor('staff+1', spec, 'bakery', 6), changeFor('price+0.5', spec, 'bakery', 6)];
    const res = await compareDays({ pool: POOL, spec: WORLD, days: 6, seeds: [7, 8], provider: rules(), changes });
    assert.deepEqual([res.baselines.length, res.results.length, res.results[0].arms.length], [2, 2, 2]);
    const staff = res.results[0].effects, price = res.results[1].effects;
    assert.ok(staff.walkAwaysPerWeek.mean < 0 && staff.walkAwaysPerWeek.agrees);
    assert.ok(staff.servedPerWeek.mean > 0);
    assert.deepEqual([price.visitsPerWeek.min, price.visitsPerWeek.max, price.visitsPerWeek.agrees], [0, 0, false], 'the rule model does not read a price');
    assert.ok(Math.abs(staff.walkAwaysPerWeek.after - staff.walkAwaysPerWeek.before - staff.walkAwaysPerWeek.mean) < 1e-9);
  });

  test('the summary and the realism checks describe one run', async () => {
    const run = await runDays({ pool: POOL, spec: WORLD, days: 10, seed: 7, provider: rules() });
    const s = summarize(run), r = realism(run);
    assert.equal(s.visitsPerWeek, run.days.reduce((x, d) => x + d.went, 0) / 2);
    assert.ok(s.regulars > 0 && s.avgWait >= 0);
    assert.ok(r.lopsided.topFifthShare > 0.2 && r.lopsided.topFifthShare <= 1);
    assert.equal(typeof r.steady.pass, 'boolean');
    assert.ok(r.newcomersReturnLess.established > 0.5);
  });

  test('the report says it is unvalidated, shows each change, and marks what did not move', async () => {
    const changes = [changeFor('staff+1', spec, 'bakery', 6), changeFor('price+0.5', spec, 'bakery', 6)];
    const res = await compareDays({ pool: POOL, spec: WORLD, days: 6, seeds: [7, 8], provider: rules(), changes });
    const text = renderDays(res, { title: 'Fern Street', provider: 'rules' }).join('\n');
    assert.match(text, /Unvalidated/);
    assert.match(text, /Rule model: nobody reads memory/);
    assert.match(text, /\+1 staff at Crumb & Co \(days 1 to 6\)/);
    assert.match(text, /Walk-aways per week .* every seed agrees/);
    assert.match(text, /Price up to \$4\.50[\s\S]*Visits per week .* no change/);
    assert.match(text, /Realism checks on the baseline/);
  });

  test('the shipped café pool matches its world and passes the realism checks on the rule model', async () => {
    const cafe = JSON.parse(readFileSync(new URL('../pools/alder-pine-cafe.json', import.meta.url), 'utf8'));
    const world = JSON.parse(readFileSync(new URL(`../${cafe.world}`, import.meta.url), 'utf8'));
    assert.deepEqual(Object.keys(cafe.people).sort(), world.minds.map(m => m.id).sort());
    const run = await runDays({ pool: cafe, spec: world, days: 10, seed: 7, provider: rules() });
    const r = realism(run);
    assert.equal(r.lopsided.pass, true);
    assert.equal(r.steady.pass, true);
    assert.equal(r.newcomersReturnLess.pass, true);
  });
});
