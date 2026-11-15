// Ask the room, next morning (docs/PROTOTYPE.md §17b): the page's controls are clamped to the facts the return
// probe checked, every record it builds is the probe's own record for the same person and condition, a sentence
// added to a record is always compared with a sentence that says nothing, someone who has never been inside is
// not asked about a visit she never made, the page's arithmetic names a person as moved only past the bar for
// this question, the recorded answers committed with the page still answer the mode's opening, and the server
// route behaves with and without Jev.
// The cafe world, its pool and its people are fictional.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, copyFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSpec } from '../engine/spec.js';
import { buildJevRequest } from '../providers/jev.js';
import { recordProvider, ROOM_NOISE, ROOM_NOISE_PERSON } from '../run/room.js';
import {
  MORNING_NOISE, MORNING_NOISE_PERSON, MORNING_OPTIONS, CARD_BASE, RATING_BASE, PLAIN_MESSAGE, OTHER_REMARK,
  defaultMorning, normalizeMorning, morningPeople, morningRecords, morningRoomRequest, morningView, askMorning
} from '../run/room-morning.js';
import { seedMornings } from '../run/room-seed.js';
import { CAST as PROBE_CAST, buildRequests as probeRequests } from '../validation/jev-return-probe.js';
import { grade, morningChange, morningSummary, byMorningChange } from '../web/room/maths.js';
import { startServer } from '../server/server.js';

const here = rel => fileURLToPath(new URL(rel, import.meta.url));
const readJson = rel => JSON.parse(readFileSync(here(rel), 'utf8'));
const CAFE = readJson('../worlds/alder-pine-cafe.json');
const POOL = readJson('../pools/alder-pine-cafe.json');
const SEED = new Map(Object.entries(readJson('../web/room/seed-record.json')));
const spec = normalizeSpec(CAFE);
const S = 'Alder & Pine Coffee';
const ORDINARY = { wait: 5, outcome: 'served', daysAgo: 1, priceChange: 0, card: null, remark: '', rating: null, message: '' };
const ctx = { shopName: S, price: 5, pool: POOL };
const person = id => morningPeople(spec, POOL).find(p => p.mind.id === id);
const records = (id, scenario) => morningRecords(normalizeMorning(POOL, scenario, 5), person(id), ctx);
const told = (id, scenario, arm = 'now') => morningRoomRequest(spec, 'cafe', person(id).mind, records(id, scenario)[arm], arm).observation;
const jsonOf = req => buildJevRequest(req, { spec, shuffle: false }).json;

// A provider that remembers what it was asked and answers with a chance of going from a function of the request.
function fakeProvider(answer = () => 0.5) {
  const seen = [];
  return { seen, async decideMany(reqs) { return reqs.map(r => { seen.push(r); const p = answer(r); return p == null ? { provider: 'rules-fallback', action: 'yes', yesProb: 1 } : { provider: 'jev', yesProb: p }; }); } };
}

describe('room, next morning: scenarios', () => {
  test('the ordinary morning: yesterday, the pool\'s ordinary wait, served, and nothing else said', () => {
    assert.deepEqual(defaultMorning(POOL), ORDINARY);
    assert.equal(defaultMorning({ ordinaryWait: 12 }).wait, 12);
    assert.equal(defaultMorning({}).wait, 5);
    assert.deepEqual(normalizeMorning(POOL, null), ORDINARY);
    assert.deepEqual(normalizeMorning(POOL, 'junk'), ORDINARY);
  });

  test('whatever the page sends becomes one of the options: a number takes the nearest, anything else the default', () => {
    const s = normalizeMorning(POOL, { wait: 999, outcome: 'ran away', daysAgo: -3, priceChange: 40, card: 7, remark: 'rude', rating: 99, message: 'free puppies', extra: 1 }, 5);
    assert.deepEqual(s, { wait: 30, outcome: 'served', daysAgo: 1, priceChange: 1, card: 8, remark: '', rating: 4.5, message: '' });
    assert.deepEqual(normalizeMorning(POOL, { wait: '12', outcome: 'left', daysAgo: 9, priceChange: -0.4, card: '2', remark: 'bad', rating: '3.8', message: 'deal' }, 5),
      { wait: 10, outcome: 'left', daysAgo: 7, priceChange: -0.5, card: 2, remark: 'bad', rating: 4, message: 'deal' });
    for (const s of seedMornings(POOL).map(raw => normalizeMorning(POOL, raw, 5))) assert.deepEqual(normalizeMorning(POOL, s, 5), s);   // asking again with the answer's own scenario changes nothing
  });

  test('a value left out, empty or of the wrong kind takes the default, not zero', () => {
    assert.deepEqual(normalizeMorning(POOL, { wait: '', daysAgo: null, priceChange: '', card: null, rating: '' }, 5), ORDINARY);
    assert.deepEqual(normalizeMorning(POOL, { wait: true, daysAgo: [7], priceChange: {}, card: false, rating: [4.5], remark: 3, message: ['deal'] }, 5), ORDINARY);
    assert.equal(normalizeMorning(POOL, { card: 0 }).card, null);
    assert.equal(normalizeMorning(POOL, { rating: -2 }).rating, null);
  });

  test('nobody leaves a line that was not there, and no price change makes the shop free', () => {
    assert.equal(normalizeMorning(POOL, { wait: 0, outcome: 'left' }).outcome, 'served');
    assert.equal(normalizeMorning(POOL, { wait: 10, outcome: 'left' }).outcome, 'left');
    assert.equal(normalizeMorning(POOL, { priceChange: -1 }, 1).priceChange, -0.5);
    assert.deepEqual(morningView({ ...CAFE, nodes: CAFE.nodes.map(n => (n.id === 'cafe' ? { ...n, price: 1 } : n)) }, POOL).options.priceChange, [-0.5, 0, 0.5, 1]);
  });

  test('only what the probe found Jev responds to is on offer', () => {
    assert.deepEqual(MORNING_OPTIONS, { wait: [0, 5, 10, 20, 30], outcome: ['served', 'left'], daysAgo: [1, 7, 28], priceChange: [-1, -0.5, 0, 0.5, 1], card: [2, 8], remark: ['good', 'bad'], rating: [3.5, 4, 4.5], message: ['deal'] });
    // How the wait ended, a free head start on the card: Jev does not respond to these (§20d), so no record says them.
    for (const raw of [...seedMornings(POOL), { wait: 20, outcome: 'left', daysAgo: 7, priceChange: 1, card: 8, remark: 'good', rating: 4, message: 'deal', ending: 'fast', free: 2 }]) {
      for (const id of ['tomas', 'greta']) for (const arm of ['now', 'before']) assert.equal(/quick at the end|stalled|given free/.test(JSON.stringify(told(id, raw, arm))), false);
    }
  });

  test('who is asked as what: a visit count from the pool\'s usual rate, and a day visitor has never been', () => {
    const people = morningPeople(spec, POOL);
    assert.equal(people.length, 12);
    assert.deepEqual(people.filter(p => !p.returning).map(p => p.mind.id), ['greta']);
    for (const p of people.filter(x => x.returning)) assert.equal(p.visits, Math.round(POOL.people[p.mind.id].usualPerWeek * 4), p.mind.id);
    assert.deepEqual(['june', 'tomas', 'ellie'].map(id => person(id).visits), [20, 3, 10]);
    // Someone the pool does not list is not given a habit they may not have.
    assert.deepEqual(morningPeople(spec, { people: { june: { usualPerWeek: 0.1 } } }).map(p => p.visits).slice(0, 3), [1, 0, 0]);
  });

  test('the view gives the page its options, the people and the bars for this question', () => {
    const v = morningView(CAFE, POOL);
    assert.equal(v.shop, 'cafe');
    assert.equal(v.price, 5);
    assert.deepEqual(v.defaults, ORDINARY);
    assert.deepEqual(v.people.tomas, { visits: 3, returning: true });
    assert.deepEqual(v.people.greta, { visits: 0, returning: false });
    assert.deepEqual(v.compare, { card: 2, rating: 3.5, message: `${S}: open 7 am to 3 pm today, as usual.`, remark: 'A friend (yesterday): the farmers market on Oak Street was busy' });
    assert.equal(v.deal, `${S}: 20% off everything today.`);
    assert.deepEqual(v.remarks, { good: `A friend (yesterday): ${S} was good and quick`, bad: `A friend (yesterday): long line at ${S}` });
    assert.throws(() => morningView(readJson('../worlds/rush-hour-roads.json'), POOL), /visit world/);
    assert.throws(() => morningView(CAFE, null), /pool file/);
    assert.throws(() => morningView(CAFE, { ...POOL, shop: 'bakery' }), /No service place/);
  });

  test('the bars: 5 points for the room as at the counter, 10 for one person, from the probe\'s repeats', () => {
    assert.equal(MORNING_NOISE, ROOM_NOISE);
    assert.equal(MORNING_NOISE_PERSON, 0.10);
    assert.ok(MORNING_NOISE_PERSON > 0.08, 'the bar for one person must sit above the largest difference between two asks (8.0 points, §20d)');
    assert.ok(MORNING_NOISE_PERSON < ROOM_NOISE_PERSON);
  });
});

describe('room, next morning: what a person is told', () => {
  test('the ordinary morning is the probe\'s reference: the visit count and yesterday\'s ordinary visit', () => {
    const r = records('priyanka', {});
    assert.deepEqual(r.now, { history: { visits: 8, weeks: 4 }, memory: [{ daysAgo: 1, wait: 5, outcome: 'served' }] });
    assert.deepEqual(r.before, r.now);
    const o = told('priyanka', {});
    assert.equal(o.history, `Has been to ${S} 8 times in the last 4 weeks.`);
    assert.deepEqual(o.memory, [`Yesterday: waited about 5 minutes in line at ${S}, then was served.`]);
    assert.equal(o.shop.cost, '$5.00');
    assert.deepEqual(Object.keys(o), ['setting', 'time', 'person', 'now', 'shop', 'other_places', 'history', 'memory']);
  });

  // The page must ask what was validated: for the same person and condition, the request is the probe's, byte for
  // byte. June and Marcus are told a different visit count here (the pool's), so they are left out.
  test('every control builds the record the return probe checked, byte for byte', () => {
    const probe = probeRequests(spec);
    const same = ['priyanka', 'tomas', 'bill', 'ellie', 'dev', 'karen', 'shanice', 'omar', 'lucy'];
    for (const id of same) assert.equal(person(id).visits, PROBE_CAST[id].visits, id);
    const conditions = {
      wait0: [{ wait: 0 }, 'now'], wait5: [{}, 'now'], wait10: [{ wait: 10 }, 'now'], wait20: [{ wait: 20 }, 'now'], wait30: [{ wait: 30 }, 'now'],
      left10: [{ wait: 10, outcome: 'left' }, 'now'], left20: [{ wait: 20, outcome: 'left' }, 'now'],
      bad_d1: [{ wait: 30, outcome: 'left' }, 'now'], bad_d7: [{ wait: 30, outcome: 'left', daysAgo: 7 }, 'now'], bad_d28: [{ wait: 30, outcome: 'left', daysAgo: 28 }, 'now'],
      price_up: [{ priceChange: 0.5 }, 'now'], price_down: [{ priceChange: -0.5 }, 'now'], price_up1: [{ priceChange: 1 }, 'now'], price_down1: [{ priceChange: -1 }, 'now'],
      price_same: [{ priceChange: 0.5 }, 'before'],
      card_8of10: [{ card: 8 }, 'now'], card_2of10: [{ card: 8 }, 'before'],
      promo20: [{ message: 'deal' }, 'now'], msg_plain: [{ message: 'deal' }, 'before'],
      heard_good: [{ remark: 'good' }, 'now'], heard_bad: [{ remark: 'bad' }, 'now'], heard_other: [{ remark: 'bad' }, 'before'],
      new_ref: [{}, 'now'], new_rating35: [{ rating: 4.5 }, 'before'], new_rating40: [{ rating: 4 }, 'now'], new_rating45: [{ rating: 4.5 }, 'now'],
      new_heard_good: [{ remark: 'good' }, 'now'], new_heard_bad: [{ remark: 'bad' }, 'now'], new_heard_other: [{ remark: 'good' }, 'before'],
      new_promo20: [{ message: 'deal' }, 'now'], new_msg_plain: [{ message: 'deal' }, 'before']
    };
    let checked = 0;
    for (const [cond, [scenario, arm]] of Object.entries(conditions)) {
      for (const id of cond.startsWith('new_') ? ['greta'] : same) {
        const theirs = probe.find(r => r.meta.cond === cond && r.meta.mind === id);
        assert.ok(theirs, `the probe has no ${cond} for ${id}`);
        const mine = morningRoomRequest(spec, 'cafe', person(id).mind, records(id, scenario)[arm], arm);
        assert.equal(jsonOf(mine), jsonOf(theirs), `${cond} for ${id}`);
        checked++;
      }
    }
    assert.equal(checked, 22 * 9 + 9);
  });

  test('a sentence added to a record is never compared with no sentence', () => {
    const combos = [...seedMornings(POOL), { wait: 30, outcome: 'left', priceChange: 1, card: 8, remark: 'bad', rating: 4.5, message: 'deal' }, { priceChange: -1, message: 'deal' }, { card: 2, rating: 3.5 }];
    for (const raw of combos) {
      for (const id of ['june', 'tomas', 'greta']) {
        const now = told(id, raw, 'now'), was = told(id, raw, 'before'), what = `${id} ${JSON.stringify(raw)}`;
        assert.deepEqual(Object.keys(was), Object.keys(now), what);                       // the same fields are filled
        assert.deepEqual(Object.keys(was.shop), Object.keys(now.shop), what);             // a rating against a rating
        for (const k of ['memory', 'heard', 'offers']) assert.equal((was[k] || []).length, (now[k] || []).length, what);
        assert.equal(/last week/.test(was.shop.cost), /last week/.test(now.shop.cost), what);   // "it was" against "the same as"
      }
    }
  });

  test('each added sentence has its plain version: the opening hours, another remark, the same price, 2 of 10 stamps, 3.5 stars', () => {
    const was = told('tomas', { priceChange: 0.5, card: 8, remark: 'bad', rating: 4.5 }, 'before'), now = told('tomas', { priceChange: 0.5, card: 8, remark: 'bad', rating: 4.5 });
    assert.equal(now.shop.cost, '$5.50 (it was $5.00 last week)');
    assert.equal(was.shop.cost, '$5.00 (the same as last week)');
    assert.equal(now.card, `Stamp card for ${S}: 8 of 10 stamps filled. A full card earns a free coffee.`);
    assert.equal(was.card, `Stamp card for ${S}: ${CARD_BASE} of 10 stamps filled. A full card earns a free coffee.`);
    assert.deepEqual(now.heard, [`A friend (yesterday): long line at ${S}`]);
    assert.deepEqual(was.heard, [`A friend (yesterday): ${OTHER_REMARK}`]);
    assert.equal(now.shop.rating, '4.5 out of 5 stars from online reviews');
    assert.equal(was.shop.rating, `${RATING_BASE.toFixed(1)} out of 5 stars from online reviews`);
    assert.deepEqual(told('tomas', { message: 'deal' }).offers, [`${S}: 20% off everything today.`]);
    assert.deepEqual(told('tomas', { message: 'deal' }, 'before').offers, [`${S}: ${PLAIN_MESSAGE}`]);
    // The memory is replaced, not added: its comparison is always yesterday's ordinary visit.
    assert.deepEqual(told('tomas', { wait: 30, outcome: 'left', daysAgo: 28 }).memory, [`4 weeks ago: waited about 30 minutes in line at ${S}, then left without ordering.`]);
    assert.deepEqual(told('tomas', { wait: 30, outcome: 'left', daysAgo: 28 }, 'before').memory, [`Yesterday: waited about 5 minutes in line at ${S}, then was served.`]);
    assert.deepEqual(told('tomas', { wait: 0 }).memory, [`Yesterday: no line at ${S}, served right away.`]);
  });

  test('under a deal the person is told the offer price against today\'s price, so the comparison has no "last week" either', () => {
    assert.equal(told('bill', { message: 'deal' }).shop.cost, '$4.00 with the offer (usually $5.00)');
    assert.equal(told('bill', { message: 'deal', priceChange: 0.5 }).shop.cost, '$4.40 with the offer (usually $5.50)');
    assert.equal(told('bill', { message: 'deal', priceChange: 0.5 }, 'before').shop.cost, '$5.00');
  });

  test('someone who has never been inside has no last visit, no last week\'s price and no card', () => {
    const plain = told('greta', {});
    assert.equal(plain.history, `Has never been to ${S}; has walked past it.`);
    assert.equal(Object.hasOwn(plain, 'memory') || Object.hasOwn(plain, 'card'), false);
    const r = records('greta', { wait: 30, outcome: 'left', daysAgo: 7, priceChange: 1, card: 8 });
    assert.deepEqual([r.applies, r.partly], [false, false]);
    assert.deepEqual(told('greta', { wait: 30, outcome: 'left', daysAgo: 7, priceChange: 1, card: 8 }), plain);
    assert.deepEqual(r.before, r.now);
    // What she is told today does reach her, at the usual price.
    const both = records('greta', { wait: 30, priceChange: 1, message: 'deal', remark: 'good', rating: 4 });
    assert.deepEqual([both.applies, both.partly], [true, true]);
    const o = told('greta', { wait: 30, priceChange: 1, message: 'deal', remark: 'good', rating: 4 });
    assert.equal(o.shop.cost, '$4.00 with the offer (usually $5.00)');
    assert.equal(o.shop.rating, '4.0 out of 5 stars from online reviews');
    assert.deepEqual(o.heard, [`A friend (yesterday): ${S} was good and quick`]);
    assert.equal(Object.hasOwn(o, 'memory') || Object.hasOwn(o, 'card'), false);
    assert.deepEqual([records('greta', {}).applies, records('greta', { remark: 'bad' }).applies, records('greta', { remark: 'bad' }).partly], [true, true, false]);
    assert.deepEqual([records('june', { wait: 30 }).applies, records('june', { wait: 30 }).partly], [true, false]);
  });
});

describe('room, next morning: asking', () => {
  test('each person is asked the morning question twice: the comparison and the page\'s record', async () => {
    const p = fakeProvider();
    const out = await askMorning({ spec: CAFE, pool: POOL, scenario: { wait: 30, outcome: 'left' }, provider: p });
    assert.equal(out.mode, 'morning');
    assert.equal(out.asked, 24);
    assert.equal(out.askedLive, 24);
    assert.equal(out.people.length, 12);
    assert.equal(out.returning, 11);
    assert.deepEqual(p.seen.slice(0, 2).map(r => r.id), ['room-morning-before-june', 'room-morning-now-june']);
    assert.ok(p.seen.every(r => r.kind === 'morning' && r.asks.yesNo === 'visit_today' && r.asks.choice === null && r.placeId === 'cafe'));
    assert.deepEqual(out.scenario, { ...ORDINARY, wait: 30, outcome: 'left' });
    assert.equal(out.changed, true);
    assert.deepEqual(out.compare, {});
    const june = out.people.find(x => x.id === 'june');
    assert.deepEqual([june.returning, june.visits, june.applies, june.source], [true, 20, true, 'live']);
    assert.deepEqual(june.told.now.memory, [`Yesterday: waited about 30 minutes in line at ${S}, then left without ordering.`]);
    assert.deepEqual(june.told.before.memory, [`Yesterday: waited about 5 minutes in line at ${S}, then was served.`]);
    assert.deepEqual(june.told.now.others, [{ name: 'Brewline (chain)', cost: '$5.00' }]);
    assert.equal(out.people.find(x => x.id === 'greta').applies, false);
  });

  test('the ordinary morning is not a change; the plain sentences in play are reported in the words people were told', async () => {
    const plain = await askMorning({ spec: CAFE, pool: POOL, scenario: {}, provider: fakeProvider() });
    assert.equal(plain.changed, false);
    assert.deepEqual(plain.compare, {});
    const all = await askMorning({ spec: CAFE, pool: POOL, scenario: { priceChange: 0.5, card: 8, remark: 'good', rating: 4, message: 'deal' }, provider: fakeProvider() });
    assert.deepEqual(all.compare, {
      card: `Stamp card for ${S}: 2 of 10 stamps filled. A full card earns a free coffee.`, remark: `A friend (yesterday): ${OTHER_REMARK}`,
      rating: '3.5 out of 5 stars from online reviews', message: `${S}: ${PLAIN_MESSAGE}`
    });
    const price = await askMorning({ spec: CAFE, pool: POOL, scenario: { priceChange: -1 }, provider: fakeProvider() });
    assert.deepEqual(price.compare, { price: '$5.00 (the same as last week)' });
  });

  test('the shares are the mean chance of going over the returning customers; an unanswered person is left out', async () => {
    const p = fakeProvider(r => (r.personaId === 'june' ? null : r.personaId === 'greta' ? 0.9 : r.id.startsWith('room-morning-now-') ? 0.2 : 0.6));
    const out = await askMorning({ spec: CAFE, pool: POOL, scenario: { remark: 'bad' }, provider: p });
    assert.equal(out.failed, 1);
    const june = out.people.find(x => x.id === 'june');
    assert.deepEqual([june.source, june.now, june.before], ['failed', null, null], 'a rule answer is never shown as Jev\'s');
    assert.ok(Math.abs(out.share.before - 0.6) < 1e-9 && Math.abs(out.share.now - 0.2) < 1e-9, 'Greta has never been, so she is not in the share');
    assert.equal(out.people.find(x => x.id === 'greta').now, 0.9);
    assert.equal(out.askedLive, 22);
  });

  test('"only" asks the named people; a route world, a missing pool and a pool for another shop are refused', async () => {
    const p = fakeProvider();
    const out = await askMorning({ spec: CAFE, pool: POOL, scenario: {}, only: ['june', 'greta', 'nobody'], provider: p });
    assert.deepEqual(out.people.map(x => x.id), ['june', 'greta']);
    assert.equal(out.asked, 4);
    await assert.rejects(askMorning({ spec: readJson('../worlds/rush-hour-roads.json'), pool: POOL, scenario: {}, provider: fakeProvider() }), /visit world/);
    await assert.rejects(askMorning({ spec: CAFE, pool: null, scenario: {}, provider: fakeProvider() }), /pool file/);
    await assert.rejects(askMorning({ spec: CAFE, pool: { ...POOL, shop: 'bakery' }, scenario: {}, provider: fakeProvider() }), /No service place/);
  });
});

describe('room, next morning: the page\'s arithmetic', () => {
  const ask = scenario => askMorning({ spec: CAFE, pool: POOL, scenario, provider: recordProvider(SEED) });
  const moved = (out, id) => morningChange(out.people.find(p => p.id === id));

  test('one person needs 10 points to count as moved; a person the change does not reach has no change', () => {
    assert.equal(grade(0.09, MORNING_NOISE, MORNING_NOISE_PERSON), 'small');
    assert.equal(grade(0.60 - 0.50, MORNING_NOISE, MORNING_NOISE_PERSON), 'up');
    assert.equal(grade(-0.10, MORNING_NOISE, MORNING_NOISE_PERSON), 'down');
    assert.equal(grade(0.04, MORNING_NOISE, MORNING_NOISE_PERSON), 'none');
    assert.ok(Math.abs(morningChange({ applies: true, before: 0.5, now: 0.2 }) + 0.3) < 1e-9);
    assert.equal(morningChange({ applies: false, before: 0.5, now: 0.5 }), null);
    assert.equal(morningChange({ applies: true, before: null, now: 0.5 }), null);
  });

  test('the opening view reports no comparison, because nothing was changed', async () => {
    const sum = morningSummary(await ask({}));
    assert.equal(sum.unchanged, true);
    assert.equal(sum.movers.length, 0);
    assert.equal(sum.regulars, 11);
    assert.equal(sum.asked, 12);
    assert.ok(sum.to > 0.4 && sum.to < 0.8, `the ordinary morning reads ${sum.to}`);
    assert.deepEqual(sum.compare, {});
  });

  test('the summary names the movers, largest first, and counts the returning customers', () => {
    const person = (id, before, now, extra = {}) => ({ id, name: id, returning: true, applies: true, before, now, ...extra });
    const r = {
      changed: true, noise: 0.05, noisePerson: 0.10, share: { before: 0.5, now: 0.42 }, compare: { message: 'm' },
      people: [person('a', 0.5, 0.45), person('b', 0.5, 0.2), person('c', 0.5, 0.61), person('d', 0.5, null), person('e', 0.3, 0.3, { returning: false, applies: false })]
    };
    const sum = morningSummary(r);
    assert.deepEqual(sum.movers.map(m => m.p.id), ['b', 'c']);
    assert.deepEqual([sum.asked, sum.still, sum.regulars, sum.flat, sum.unchanged], [3, 1, 3, false, false]);
    assert.deepEqual(sum.compare, { message: 'm' });
    assert.deepEqual(byMorningChange(r.people).map(p => p.id), ['b', 'c', 'a', 'd', 'e']);
    assert.equal(morningSummary({ ...r, share: { before: null, now: null } }).answered, false);
  });

  // The recorded answers are single asks of Jev (Nov 14, jev-1.14.0). These are the findings of §20d that the
  // page exists to show; if a rebuilt seed breaks one, look at the numbers before changing the test.
  test('a 30-minute wait: the people in a hurry fall far more than Ellie, and the share falls', async () => {
    const out = await ask({ wait: 30 }), sum = morningSummary(out);
    assert.ok(sum.to < sum.from - 0.10);
    assert.ok(moved(out, 'shanice') < moved(out, 'ellie') - 0.10 && moved(out, 'karen') < moved(out, 'ellie') - 0.10);
    assert.ok(sum.movers.every(m => m.d < 0));
    assert.equal(moved(out, 'greta'), null);
    const left = morningSummary(await ask({ wait: 30, outcome: 'left' }));
    assert.ok(left.to < sum.to, 'leaving without ordering costs more than being served');
  });

  test('a 50-cent rise hits Bill hardest; stamps near the reward pull Tomas and Omar and not the daily regulars', async () => {
    const rise = await ask({ priceChange: 0.5 });
    assert.equal(byMorningChange(rise.people)[0].id, 'bill');
    assert.deepEqual(morningSummary(rise).movers.map(m => m.p.id), ['bill']);
    const card = await ask({ card: 8 }), movers = morningSummary(card).movers.map(m => m.p.id);
    assert.deepEqual(movers.slice(0, 2).sort(), ['omar', 'tomas']);
    for (const id of ['june', 'marcus', 'bill']) assert.equal(movers.includes(id), false, id);
    // A card at 2 of 10 is the comparison itself.
    assert.ok((await ask({ card: 2 })).people.every(p => p.before === p.now));
  });

  test('a deal and a friend\'s remark are measured against their plain versions, and reach someone who has never been', async () => {
    const deal = await ask({ message: 'deal' }), sum = morningSummary(deal);
    assert.ok(sum.to > sum.from);
    assert.deepEqual(Object.keys(sum.compare), ['message']);
    assert.notEqual(moved(deal, 'greta'), null);
    const bad = morningSummary(await ask({ remark: 'bad' })), good = morningSummary(await ask({ remark: 'good' }));
    assert.ok(bad.to < bad.from && good.to > good.from);
    assert.equal(bad.from, good.from);                         // both against the same remark about something else
  });
});

describe('room, next morning: recorded answers', () => {
  // If this fails after the cafe world, its pool, the cast or the morning wording changed, rebuild the seed with a
  // Jev key: node run/room-seed.js
  test('the answers committed with the page cover the ordinary morning and every morning one click from it', async () => {
    const provider = recordProvider(SEED), mornings = seedMornings(POOL);
    assert.ok(mornings.length >= 20);
    assert.deepEqual(mornings[0], {});
    for (const key of ['wait', 'daysAgo', 'priceChange', 'card', 'remark', 'rating', 'message']) {
      for (const value of MORNING_OPTIONS[key]) {
        if (value === ORDINARY[key]) continue;
        assert.ok(mornings.some(m => JSON.stringify(m) === JSON.stringify({ [key]: value })), `${key} ${value}`);
      }
    }
    assert.ok(mornings.some(m => JSON.stringify(m) === JSON.stringify({ wait: 5, outcome: 'left' })));
    for (const scenario of mornings) {
      const out = await askMorning({ spec: CAFE, pool: POOL, scenario, provider });
      assert.equal(out.failed, 0, `not recorded: ${JSON.stringify(scenario)}`);
      assert.equal(out.askedLive, 0);
      assert.ok(out.people.every(p => p.source === 'recorded' && p.now >= 0 && p.now <= 1 && p.before >= 0 && p.before <= 1));
    }
  });
});

describe('room, next morning: server routes and the page', () => {
  let root, srv, hadKey;
  before(async () => {
    hadKey = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;            // these tests must never call Jev
    root = await mkdtemp(join(tmpdir(), 'swarm-room-morning-'));
    await mkdir(join(root, 'worlds'), { recursive: true });
    await mkdir(join(root, 'pools'), { recursive: true });
    for (const world of ['alder-pine-cafe.json', 'food-hall-lunch.json', 'rush-hour-roads.json']) await copyFile(here(`../worlds/${world}`), join(root, 'worlds', world));
    await copyFile(here('../pools/alder-pine-cafe.json'), join(root, 'pools', 'alder-pine-cafe.json'));
    srv = await startServer({ port: 0, root });
  });
  after(async () => {
    await srv.close();
    await rm(root, { recursive: true, force: true });
    if (hadKey !== undefined) process.env.TYPESAFE_API_KEY = hadKey;
  });
  const post = body => fetch(`${srv.url}/api/room/morning`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  test('GET /api/room offers the next morning for a world with a pool file, and not for one without', async () => {
    const v = await (await fetch(`${srv.url}/api/room`)).json();
    assert.deepEqual(v.morning, JSON.parse(JSON.stringify(morningView(CAFE, POOL))));
    assert.equal(v.cast.length, 12);
    assert.equal(v.noisePerson, ROOM_NOISE_PERSON, 'the at-the-counter bars are unchanged');
    const hall = await (await fetch(`${srv.url}/api/room?world=food-hall-lunch.json`)).json();
    assert.equal(hall.morning, null);
    assert.ok(hall.cast.length > 0, 'the at-the-counter mode still works without a pool');
  });

  test('POST /api/room/morning answers the ordinary morning and a recorded change with no key and no network', async () => {
    const res = await post({});
    assert.equal(res.status, 200);
    const plain = await res.json();
    assert.deepEqual([plain.world, plain.mode, plain.live, plain.failed, plain.askedLive, plain.changed], ['alder-pine-cafe.json', 'morning', false, 0, 0, false]);
    assert.equal(plain.people.length, 12);
    assert.ok(plain.people.every(p => p.source === 'recorded' && p.before === p.now));
    const out = await (await post({ scenario: { wait: 30, outcome: 'left' } })).json();
    assert.equal(out.failed, 0);
    assert.ok(out.share.now < out.share.before - 0.15, 'a 30-minute wait that ended in leaving should lower the share');
  });

  test('whatever is posted is clamped, and a morning nobody recorded is reported as unanswered, not invented', async () => {
    const junk = await (await post({ scenario: { wait: 'abc', card: -4, remark: { $ne: null }, rating: '99', message: 'DROP TABLE' } })).json();
    assert.deepEqual(junk.scenario, { ...ORDINARY, rating: 4.5 });
    const out = await (await post({ scenario: { wait: 20, card: 8, priceChange: 0.5 } })).json();
    assert.equal(out.failed, 11);
    assert.equal(out.askedLive, 0);
    assert.equal(out.error, null);
    assert.ok(out.people.filter(p => p.returning).every(p => p.source === 'failed' && p.now === null));
    assert.equal(out.people.find(p => p.id === 'greta').source, 'recorded');     // none of it is in her record
    assert.equal(out.share.now, null);
  });

  test('bad requests are refused with a reason', async () => {
    assert.equal((await post({ world: '../secrets.json' })).status, 400);
    assert.equal((await post({ world: 'missing.json' })).status, 404);
    const noPool = await post({ world: 'food-hall-lunch.json' });
    assert.equal(noPool.status, 404);
    assert.match((await noPool.json()).error, /No pool file/);
    assert.equal((await post({ world: ['alder-pine-cafe.json'] })).status, 400);
    const form = await fetch(`${srv.url}/api/room/morning`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(form.status, 415);
    assert.equal((await fetch(`${srv.url}/api/room/morning`)).status, 405);
  });

  test('the page has the two modes, with "At the counter" first and pressed', async () => {
    const html = await (await fetch(`${srv.url}/room/`)).text();
    assert.match(html, /id="modeCounter" aria-pressed="true"[^>]*>At the counter</);
    assert.match(html, /id="modeMorning" aria-pressed="false"[^>]*>Next morning</);
    assert.ok(html.indexOf('id="modeCounter"') < html.indexOf('id="modeMorning"'));
    assert.match(html, /id="morningControls" hidden/);
    assert.equal(/<script(?![^>]*\bsrc=)/.test(html) || /\sstyle="/.test(html), false, 'inline script or style would be blocked by the page\'s content policy');
  });
});

describe('room, next morning: the live route, with a stand-in for Jev', () => {
  let root, srv, hadKey, calls, bodies;
  const roomFetch = async (_url, init) => {
    calls++;
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ model: 'jev-test', answers: { visit_today: { type: 'noul', noul: 0.7 } } }) };
  };
  before(async () => {
    hadKey = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = 'not-a-real-key';     // never sent anywhere: roomFetch replaces the network
    root = await mkdtemp(join(tmpdir(), 'swarm-room-morning-live-'));
    await mkdir(join(root, 'worlds'), { recursive: true });
    await mkdir(join(root, 'pools'), { recursive: true });
    await copyFile(here('../worlds/alder-pine-cafe.json'), join(root, 'worlds', 'alder-pine-cafe.json'));
    await copyFile(here('../pools/alder-pine-cafe.json'), join(root, 'pools', 'alder-pine-cafe.json'));
    srv = await startServer({ port: 0, root, roomFetch });
  });
  after(async () => {
    await srv.close();
    await rm(root, { recursive: true, force: true });
    if (hadKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = hadKey;
  });
  const post = body => fetch(`${srv.url}/api/room/morning`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  test('the ordinary morning costs nothing; two controls together are asked live, saved, and on record the second time', async () => {
    calls = 0; bodies = [];
    const plain = await (await post({})).json();
    assert.deepEqual([plain.live, plain.askedLive, calls], [true, 0, 0]);
    const first = await (await post({ scenario: { wait: 20, card: 8 } })).json();
    assert.equal(first.failed, 0);
    assert.equal(first.askedLive, 11);                    // the comparison (a card at 2 of 10) and Greta are already on record
    assert.equal(calls, 11);
    assert.ok(bodies.every(b => Object.keys(b.questions).join() === 'visit_today' && b.state.card.includes('8 of 10') && b.state.memory[0].includes('20 minutes')));
    assert.ok(first.people.filter(p => p.returning).every(p => p.source === 'live' && p.now === 0.7));
    const saved = JSON.parse(await readFile(join(root, 'data', 'room', 'record.json'), 'utf8'));
    assert.equal(Object.keys(saved).length, SEED.size + 11);
    assert.equal(/not-a-real-key/.test(JSON.stringify(saved)), false);
    const again = await (await post({ scenario: { wait: 20, card: 8 } })).json();
    assert.equal(again.askedLive, 0);
    assert.equal(calls, 11);
    assert.ok(again.people.every(p => p.source === 'recorded'));
  });
});
