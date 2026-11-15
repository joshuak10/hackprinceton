// validation/jev-return-probe.js: the probe's conditions, tests, statistics and verdicts, checked on made-up
// answers. No network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeSpec } from '../engine/spec.js';
import { seedRng } from '../engine/util.js';
import { buildJevRequest } from '../providers/jev.js';
import {
  CONDITIONS, TESTS, CAST, WORLD, SHOP, SAME_TOLERANCE, castFor, eligible, buildRequests, bootstrap, verdictOf, analyze, baseRateOf, renderReport
} from '../validation/jev-return-probe.js';

const spec = normalizeSpec(JSON.parse(readFileSync(new URL(`../${WORLD}`, import.meta.url), 'utf8')));
const reqs = buildRequests(spec);
const byId = Object.fromEntries(CONDITIONS.map(c => [c.id, c]));

describe('return probe: conditions', () => {
  test('ids are unique and every test names conditions that exist, asked of the same kind of person', () => {
    assert.equal(new Set(CONDITIONS.map(c => c.id)).size, CONDITIONS.length);
    assert.equal(new Set(TESTS.map(t => t.id)).size, TESTS.length);
    for (const t of TESTS) {
      const conds = t.type === 'diff' ? [t.a, t.b] : t.type === 'slope' ? t.conds : [t.ref, t.up, t.down];
      for (const c of conds) assert.ok(byId[c], `${t.id} names "${c}"`);
      assert.equal(new Set(conds.map(c => byId[c].who)).size, 1, `${t.id} mixes returning customers and newcomers`);
      if (t.type === 'slope') assert.equal(t.dose.length, t.conds.length);
    }
  });

  test('the cast matches the world, and nobody is put in a state their bio rules out', () => {
    assert.deepEqual(Object.keys(CAST).sort(), spec.minds.map(m => m.id).sort());
    const people = castFor(spec);
    assert.equal(people.filter(p => p.returning).length, 11);
    assert.equal(people.filter(p => p.newcomer).length, 7);
    const greta = people.find(p => p.mind.id === 'greta'), june = people.find(p => p.mind.id === 'june');
    assert.equal(greta.returning, false, 'Greta is in town for one day');
    assert.equal(june.newcomer, false, 'June has come every day for six years');
    assert.equal(eligible(byId.wait20, greta), false);
    assert.equal(eligible(byId.new_ref, june), false);
  });

  test('one request per condition and eligible person, all different', () => {
    const expected = CONDITIONS.reduce((n, c) => n + castFor(spec).filter(p => eligible(c, p)).length, 0);
    assert.equal(reqs.length, expected);
    const hashes = new Set(reqs.map(r => buildJevRequest(r, { spec }).requestHash));
    assert.equal(hashes.size, reqs.length, 'two conditions would send the same question');
    assert.ok(reqs.every(r => r.asks.yesNo === 'visit_today' && r.placeId === SHOP));
    assert.equal(buildRequests(spec, { only: ['price'] }).length, 5 * 11);
  });

  test('compared conditions differ in one place only', () => {
    const obs = (cond, mind) => reqs.find(r => r.meta.cond === cond && r.meta.mind === mind).observation;
    const differing = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    const pairs = { left20: ['memory'], peak_end: ['memory'], paraphrase: ['memory'], price_up: ['shop'], near_reward: ['card'], head_start: ['card'], deal_new: ['offers', 'shop'], deal_loyalty: ['memory'], friend_bad: ['heard'], reads: ['memory'] };
    for (const [id, fields] of Object.entries(pairs)) {
      const t = TESTS.find(x => x.id === id);
      const mind = byId[t.a].who === 'newcomer' ? 'karen' : 'priyanka';
      assert.deepEqual(differing(obs(t.a, mind), obs(t.b, mind)).sort(), fields.slice().sort(), id);
    }
    // The head start leaves the same 8 purchases to go.
    assert.match(obs('card_0of8', 'priyanka').card, /0 of 8 stamps/);
    assert.match(obs('card_2of10_free', 'priyanka').card, /2 of 10 stamps filled \(the first 2 were given free/);
    // After a deal the price today is the full price in both arms.
    assert.equal(obs('once_deal', 'karen').shop.cost, '$5.00');
    assert.equal(obs('once_full', 'karen').shop.cost, '$5.00');
  });

  test('a returning customer is told a visit count that fits their bio; a newcomer that they have never been', () => {
    const o = (cond, mind) => reqs.find(r => r.meta.cond === cond && r.meta.mind === mind).observation;
    assert.equal(o('wait5', 'june').history, 'Has been to Alder & Pine Coffee 28 times in the last 4 weeks.');
    assert.deepEqual(o('wait5', 'june').memory, ['Yesterday: waited about 5 minutes in line at Alder & Pine Coffee, then was served.']);
    assert.equal(o('new_ref', 'greta').history, 'Has never been to Alder & Pine Coffee; has walked past it.');
    assert.equal(o('new_ref', 'greta').memory, undefined);
    assert.equal(o('nomemory', 'june').memory, undefined);
  });
});

describe('return probe: statistics', () => {
  test('the interval is repeatable, contains the mean, and needs two people', () => {
    const v = [0.1, 0.2, 0.05, 0.15, 0.12, 0.3];
    const a = bootstrap(v, 'x'), b = bootstrap(v, 'x');
    assert.deepEqual(a, b);
    const m = v.reduce((s, x) => s + x, 0) / v.length;
    assert.ok(a.lo < m && m < a.hi && a.lo > 0);
    assert.deepEqual(bootstrap([0.2]), { lo: null, hi: null });
  });

  test('verdicts follow the interval, not the average alone', () => {
    assert.equal(verdictOf('higher', 0.1, { lo: 0.04, hi: 0.16 }), 'pass');
    assert.equal(verdictOf('higher', 0.03, { lo: -0.02, hi: 0.08 }), 'unclear');
    assert.equal(verdictOf('higher', -0.1, { lo: -0.16, hi: -0.04 }), 'fail');
    assert.equal(verdictOf('lower', -0.1, { lo: -0.16, hi: -0.04 }), 'pass');
    assert.equal(verdictOf('higher', 0.06, { lo: 0.02, hi: 0.1 }, { min: 0.1 }), 'weak');
    assert.equal(verdictOf('not_higher', 0.02, { lo: -0.03, hi: 0.07 }), 'pass');
    assert.equal(verdictOf('not_higher', 0.1, { lo: 0.04, hi: 0.16 }), 'fail');
    assert.equal(verdictOf('not_lower', -0.1, { lo: -0.16, hi: -0.04 }), 'fail');
    assert.equal(verdictOf('same', SAME_TOLERANCE - 0.01, { lo: 0.02, hi: 0.06 }), 'pass');
    assert.equal(verdictOf('same', -0.08, { lo: -0.1, hi: -0.06 }), 'fail');
    assert.equal(verdictOf('higher', null, { lo: null, hi: null }), 'no data');
  });
});

// Made-up answers: a base chance per person, plus what each condition does, plus a little rerun noise.
function fakeRows(effects, { repeats = 3, noise = 0.01 } = {}) {
  const rows = [];
  for (const r of reqs) {
    const base = 0.4 + 0.03 * (spec.minds.findIndex(m => m.id === r.meta.mind) % 5);
    const rng = seedRng('made-up', r.meta.cond, r.meta.mind);
    for (let rep = 0; rep < repeats; rep++) {
      const wobble = noise * (2 * rng() - 1);
      rows.push({ ...r.meta, rep, p: Math.min(1, Math.max(0, base + (effects[r.meta.cond] ?? 0) + wobble)) });
    }
  }
  return rows;
}

describe('return probe: analysis on made-up answers', () => {
  const HUMAN = {
    good: 0.2, bad: -0.25, weather: 0, nomemory: 0, para20: -0.1,
    wait0: 0.03, wait10: -0.05, wait20: -0.1, wait30: -0.16, left10: -0.12, left20: -0.2, balk9: -0.15, balk3: -0.08,
    end_plain15: -0.07, end_fast15: -0.04, end_slow15: -0.11,
    price_up: -0.08, price_down: 0.03, price_up1: -0.15, price_down1: 0.06,
    card_2of10: 0.02, card_8of10: 0.12, card_0of8: 0.01, card_2of10_free: 0.05,
    msg_plain: 0.01, promo20: 0.05, heard_good: 0.04, heard_bad: -0.06, heard_other: 0,
    new_rating35: -0.02, new_rating40: 0.0, new_rating45: 0.02, new_heard_good: 0.1, new_heard_bad: -0.1, new_heard_other: 0,
    new_msg_plain: 0, new_promo20: 0.12, once_full: 0.05, once_deal: 0.03,
    bad_d1: -0.25, bad_d7: -0.15, bad_d28: -0.05, acc0: 0, acc1_new: -0.08, acc1_old: -0.04, acc3: -0.2
  };

  test('answers shaped like the published effects pass every check and gate', () => {
    const s = analyze(fakeRows(HUMAN));
    const verdicts = Object.fromEntries(s.tests.filter(t => t.kind !== 'explore').map(t => [t.id, t.verdict]));
    for (const [id, v] of Object.entries(verdicts)) assert.equal(v, 'pass', `${id}: ${v}`);
    assert.deepEqual(s.tally.check, { total: 6, pass: 6, fail: 0, other: 0 });
    assert.equal(s.tally.gate.total, TESTS.filter(t => t.kind === 'gate').length);
    assert.equal(s.tally.gate.pass, s.tally.gate.total);
    const wait = s.tests.find(t => t.id === 'wait_slope');
    assert.ok(wait.effect < -0.04 && wait.effect > -0.08, `slope per 10 minutes ${wait.effect}`);
    assert.equal(wait.curve.length, 5);
    const near = s.tests.find(t => t.id === 'near_reward');
    assert.ok(Math.abs(near.effect - 0.1) < 0.01);
    assert.equal(near.size.inBand, true, near.size.words);
    const loss = s.tests.find(t => t.id === 'loss_aversion');
    assert.ok(Math.abs(loss.drop - 0.08) < 0.01 && Math.abs(loss.gain - 0.03) < 0.01);
    assert.ok(s.noise.meanGap > 0 && s.noise.meanGap < 0.03);
    assert.equal(s.byCond.wait5.n, 11);
    assert.equal(s.byCond.new_ref.n, 7);
  });

  test('a model that ignores memory fails the reading check and leaves the gates unclear', () => {
    const s = analyze(fakeRows({}));
    const v = id => s.tests.find(t => t.id === id).verdict;
    assert.equal(v('reads'), 'unclear');
    assert.equal(v('neutral'), 'pass');
    assert.equal(v('wait_slope'), 'unclear');
    assert.equal(v('deal_loyalty'), 'pass', 'not higher is true of a model that ignores the deal');
    assert.equal(s.tally.gate.fail, 0);
  });

  test('a model that reads memory backwards fails', () => {
    const s = analyze(fakeRows({ good: -0.2, bad: 0.2, wait30: 0.2, wait20: 0.12, wait10: 0.05, left20: 0.3, price_up: 0.1, once_deal: 0.2, para20: 0.25 }));
    const v = id => s.tests.find(t => t.id === id).verdict;
    for (const id of ['reads', 'wait_slope', 'wait_ends', 'left20', 'price_up', 'deal_loyalty', 'paraphrase']) assert.equal(v(id), 'fail', id);
  });

  test('differences are also given as odds, which a person near 0% or 100% does not squeeze', () => {
    const s = analyze(fakeRows(HUMAN));
    const up = s.tests.find(t => t.id === 'price_up'), reads = s.tests.find(t => t.id === 'reads');
    assert.ok(up.odds.times < 1 && up.odds.hi < 1, 'a rise lowers the odds');
    assert.ok(reads.odds.times > 3);
    assert.equal(s.tests.find(t => t.id === 'wait_slope').odds, null, 'a slope has no single odds multiple');
    // The same 10-point drop is a larger change in odds for someone at 15% than for someone at 50%.
    const rows = [];
    for (const [mind, base] of [['tomas', 0.15], ['june', 0.5]]) {
      for (const [cond, p] of [['price_same', base], ['price_up', base - 0.1]]) rows.push({ cond, mind, rep: 0, p });
    }
    const t = analyze(rows).tests.find(x => x.id === 'price_up');
    assert.ok(Math.abs(t.effect + 0.1) < 1e-9);
    assert.ok(t.odds.times < 0.5, `odds x${t.odds.times}`);
  });

  test('the base rate check compares the chance with the visit count told', () => {
    const right = baseRateOf(Object.fromEntries(Object.entries(CAST).filter(([, c]) => c.visits != null).map(([m, c]) => [m, Math.min(1, c.visits / 20)])));
    assert.equal(right.rows.length, 11);
    assert.ok(right.rank > 0.99);
    assert.ok(Math.abs(right.occasional - 1) < 1e-9 && Math.abs(right.frequent - 1) < 1e-9);
    const flat = baseRateOf(Object.fromEntries(Object.keys(CAST).filter(m => CAST[m].visits != null).map(m => [m, 0.5])));
    assert.equal(flat.rank, 0);
    assert.ok(flat.occasional > 1.3 && flat.frequent < 0.6, 'a flat 50% is too high for occasional customers and too low for daily ones');
    assert.equal(baseRateOf({ june: 0.9 }), null);
    assert.ok(analyze(fakeRows(HUMAN)).baseRate.rows.every(r => r.jev > 0));
  });

  test('unanswered questions are left out, and a family that was not asked gives no test', () => {
    const rows = fakeRows(HUMAN).map(r => (r.mind === 'bill' && r.cond === 'good' ? { ...r, p: null } : r));
    const s = analyze(rows);
    assert.equal(s.tests.find(t => t.id === 'reads').n, 10);
    const only = analyze(fakeRows(HUMAN).filter(r => byId[r.cond].family === 'price'));
    assert.deepEqual(only.tests.map(t => t.id).sort(), ['loss_aversion', 'loss_aversion1', 'price_down', 'price_up', 'price_up1']);
  });

  test('the report names every test, with its verdict', () => {
    const summary = analyze(fakeRows(HUMAN));
    const cast = Object.fromEntries(spec.minds.map(m => [m.id, { name: m.name }]));
    const md = renderReport({ createdAt: '2026-11-14T00:00:00Z', repeats: 3, stats: { model: 'jev-test', requests: 10, fallbacks: 0, estCostUSD: 0.1 }, summary, cast, told: null });
    for (const t of summary.tests) assert.ok(md.includes(t.title), t.title);
    assert.match(md, /Published effects: \d+ of \d+ pass/);
    assert.match(md, /\| Longer last wait, less likely to return \| lower \| −\d+\.\d per 10 minutes/);
    assert.match(md, /## Does the chance follow the visit count\?/);
    assert.match(md, /\| A 50-cent rise \| lower \| −\d+\.\d \| .* \| ×0\.\d\d/);
  });
});
