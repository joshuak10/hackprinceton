// run/effects.js: what a change did, paired seed by seed, and the lines `swarm compare` prints for it.
// Hand-made fictional metrics, plus real rules runs of worlds/food-hall-lunch.json for compare.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  measure, segmentChanges, offerChanges, changeEffects, effectLines, addedOffers, placeVisits
} from '../run/effects.js';
import { compareRuns } from '../run/runner.js';
import { makeProvider } from '../providers/index.js';
import { normalizeSpec, applyPatch } from '../engine/spec.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const FOOD_HALL = JSON.parse(readFileSync(join(REPO, 'worlds', 'food-hall-lunch.json'), 'utf8'));

// The plain table helper the CLI uses, enough for line checks.
const table = (headers, rows) => [headers, ...rows].map(r => r.join(' | ')).join('\n');

describe('measure', () => {
  test('pairs seeds, takes the larger sd as the spread, and judges direction', () => {
    const m = measure([10, 12, 14], [6, 9, 9], -1);
    assert.equal(m.before, 12);
    assert.equal(m.after, 8);
    assert.equal(m.change, -4);
    assert.equal(m.spread, 2);          // sd of before (2) > sd of after (1.73)
    assert.deepEqual(m.bySeed, [-4, -3, -5]);
    assert.equal(m.beyondSpread, true);
    assert.equal(m.holdsAcrossSeeds, true);
    assert.equal(m.verdict, 'better');
  });

  test('a change within the spread is no clear effect; a neutral measure says up or down', () => {
    assert.equal(measure([10, 14], [11, 14], -1).verdict, 'no clear effect');
    assert.equal(measure([10, 10, 10], [7, 7, 7], 0).verdict, 'down');
    assert.equal(measure([10, 10, 10], [13, 13, 13], 1).verdict, 'better');
    assert.equal(measure([null, 3], [2, null]), null);
  });
});

// Two seeds of a fictional bakery street: the patch sends students to Maison Crumb.
const seg = (id, group, over) => ({
  id, name: id === 'students' ? 'Students' : id === 'parents' ? 'Parents' : 'Nora Vale', group, count: 20,
  avgWait: 3, avgSpent: 10, avgVisits: 1, walkAwaysPerPerson: 0.1, shareNeverServed: 0.05, avgFrustration: null, ...over
});
const nodes = arrivals => [
  { id: 'corner', name: 'Corner Loaf', arrivals: arrivals[0] },
  { id: 'crumb', name: 'Maison Crumb', arrivals: arrivals[1] },
  { id: 'kiosk', name: 'Tea kiosk', arrivals: arrivals[2] },
  { id: 'cart', name: 'Bagel cart', arrivals: arrivals[3] }
];
// Students' visits: Maison Crumb is their 4th place before the offer, so it is outside topPlaces.
const beforeRun = k => ({
  mode: 'visit', abandonRate: 0.2 + k / 100, avgWait: 4 + k, served: 40, abandoned: 5, spawned: 50, nodes: nodes([30, 4, 12, 9]),
  segments: {
    byGroup: [
      seg('students', 'students', {
        avgSpent: 6 + k, topPlaces: [{ id: 'corner', name: 'Corner Loaf', visits: 12 }, { id: 'kiosk', name: 'Tea kiosk', visits: 5 }, { id: 'cart', name: 'Bagel cart', visits: 4 }],
        visitsByPlace: { corner: 12, crumb: 2, kiosk: 5, cart: 4 }
      }),
      seg('parents', 'parents', { avgSpent: 30, topPlaces: [{ id: 'crumb', name: 'Maison Crumb', visits: 2 }], visitsByPlace: { crumb: 2 } })
    ],
    byCast: [seg('nora', 'students', { avgSpent: 6, topPlaces: [], visitsByPlace: {} })]
  },
  offers: []
});
const afterRun = k => ({
  ...beforeRun(k), abandonRate: 0.1 + k / 100, avgWait: 3 + k, nodes: nodes([18, 16, 12, 9]),
  segments: {
    byGroup: [
      seg('students', 'students', {
        avgSpent: 9 + k, topPlaces: [{ id: 'crumb', name: 'Maison Crumb', visits: 14 }, { id: 'kiosk', name: 'Tea kiosk', visits: 5 }, { id: 'cart', name: 'Bagel cart', visits: 4 }],
        visitsByPlace: { corner: 0, crumb: 14, kiosk: 5, cart: 4 }
      }),
      seg('parents', 'parents', { avgSpent: 30, topPlaces: [{ id: 'crumb', name: 'Maison Crumb', visits: 2 }], visitsByPlace: { crumb: 2 } })
    ],
    byCast: [seg('nora', 'students', { avgSpent: 3, topPlaces: [{ id: 'crumb', name: 'Maison Crumb', visits: 1 }], visitsByPlace: { crumb: 1 } })]
  },
  offers: [{ id: 'crumb_deal', reached: 20 + k, wentToPlace: 12 + k }]
});
const BEFORE = [beforeRun(0), beforeRun(1)];
const AFTER = [afterRun(0), afterRun(1)];
const OFFER = { id: 'crumb_deal', text: 'Maison Crumb: half price for students', to: { groups: ['students'], cast: ['nora'] }, place: 'crumb', priceOff: 0.5 };

describe('segmentChanges and offerChanges', () => {
  test('where a segment went counts every place, including one outside the top 3', () => {
    const s = segmentChanges('visit', BEFORE, AFTER, ['nora']);
    const students = s.byGroup.find(x => x.id === 'students');
    assert.deepEqual(students.places.find(p => p.id === 'crumb'), { id: 'crumb', name: 'Maison Crumb', before: 2, after: 14 });
    assert.deepEqual(students.places.find(p => p.id === 'corner'), { id: 'corner', name: 'Corner Loaf', before: 12, after: 0 });
    assert.equal(students.fields.avgSpent.change, 3);
    assert.deepEqual(s.byCast.map(x => x.id), ['nora']);
    assert.deepEqual(s.byGroup.map(x => x.id), ['students', 'parents']);
  });

  test('older runs without visitsByPlace fall back to topPlaces', () => {
    assert.deepEqual(placeVisits({ topPlaces: [{ id: 'a', visits: 3 }] }), { a: 3 });
    assert.deepEqual(placeVisits({ topPlaces: [{ id: 'a', visits: 3 }], visitsByPlace: { a: 3, b: 1 } }), { a: 3, b: 1 });
    assert.deepEqual(placeVisits(undefined), {});
  });

  test('route segments have no place list', () => {
    const r = m => ({ mode: 'route', segments: { byGroup: [{ id: 'g', name: 'G', group: 'g', count: 5, avgTrip: m, avgDelay: m / 2, avgFrustration: null }], byCast: [] } });
    const s = segmentChanges('route', [r(10), r(12)], [r(8), r(9)]);
    assert.equal(s.byGroup[0].places, undefined);
    assert.equal(s.byGroup[0].fields.avgTrip.change, -2.5);
  });

  test('offers are matched by the normalized id and place, and report reach and arrivals', () => {
    const [o] = offerChanges(BEFORE, AFTER, [OFFER]);
    assert.equal(o.reached, 20.5);
    assert.equal(o.wentToPlace, 12.5);
    assert.equal(o.placeArrivals.before, 4);
    assert.equal(o.placeArrivals.after, 16);
    assert.deepEqual(o.to, OFFER.to);
  });

  test('changeEffects adds the KPIs, the verdict and the offer audience', () => {
    const e = changeEffects({ mode: 'visit', before: BEFORE, after: AFTER, offers: [OFFER] });
    assert.equal(e.kpis.avgWait.change, -1);
    assert.equal(e.verdict, 'helps');
    assert.equal(e.holdsAcrossSeeds, true);
    assert.deepEqual(e.segments.byCast.map(x => x.id), ['nora']);
    const none = changeEffects({ mode: 'visit', before: BEFORE, after: BEFORE });
    assert.deepEqual(none.offers, []);
    assert.deepEqual(none.segments.byCast, []);
  });

  test('addedOffers takes the offers after the base world\'s own', () => {
    const base = normalizeSpec(FOOD_HALL);
    const { spec } = applyPatch(base, [{ kind: 'offer', offer: { id: 'deal', text: 'Hi', place: 'pizza', priceOff: 0.1 } }, { kind: 'offer', offer: { id: 'deal', text: 'Again' } }]);
    assert.deepEqual(addedOffers(base, spec).map(o => o.id), ['deal', 'deal_1']);
  });
});

describe('effectLines', () => {
  const spec = {
    mode: 'visit',
    archetypes: [{ id: 'students', name: 'Students' }, { id: 'parents', name: 'Parents' }],
    minds: [{ id: 'nora', name: 'Nora Vale' }],
    nodes: nodes([0, 0, 0, 0])
  };

  test('offers, who it helped (with * beyond the spread) and where the audience went, offer place included', () => {
    const effects = changeEffects({ mode: 'visit', before: BEFORE, after: AFTER, offers: [OFFER] });
    const text = effectLines({ spec, effects, table }).join('\n');
    assert.match(text, /Offers added by the patch/);
    assert.match(text, /crumb_deal \| Students, Nora Vale \| Maison Crumb \| 50% \| 20\.5 \| 12\.5 \| 4 → 16\*/);
    assert.match(text, /A segment is a kind of simulated person/);
    assert.match(text, /Students \(offer\) \| 20 \| \$6\.50 → \$9\.50\*/);
    assert.match(text, /Parents \| 20 \| \$30\.00 → \$30\.00 \|/);
    assert.match(text, /cast: Nora Vale \(offer\)/);
    assert.match(text, /Students: .*Maison Crumb 2 → 14/);
    assert.doesNotMatch(text, /  Parents:/, 'groups the offer did not target are not listed under where they went');
  });

  test('a capacity patch prints the who table but no offer lines; route worlds use trip and delay', () => {
    const effects = changeEffects({ mode: 'visit', before: BEFORE, after: AFTER });
    const text = effectLines({ spec, effects, table }).join('\n');
    assert.doesNotMatch(text, /Offers added|Where the offer/);
    assert.match(text, /Who, before → after/);
    assert.deepEqual(effectLines({ spec, effects: { offers: [], segments: null }, table }), []);
  });
});

describe('compareRuns keeps each seed and the added offers', () => {
  test('per-seed metrics on both sides, in seed order, and the normalized offers', async () => {
    const patch = [{ kind: 'offer', offer: { text: 'Forno Slice: 30% off', to: { groups: ['Takeout grabbers'] }, place: 'Forno Slice', priceOff: 0.3 } }];
    const res = await compareRuns({ spec: FOOD_HALL, patch, seeds: [7, 8], provider: makeProvider('rules') });
    assert.deepEqual(res.runs.before.map(r => r.seed), [7, 8]);
    assert.deepEqual(res.runs.after.map(r => r.seed), [7, 8]);
    assert.ok(res.runs.after.every(r => r.metrics.offers.length === 1 && r.metrics.segments));
    assert.deepEqual(res.offers.map(o => [o.id, o.place, o.to.groups]), [['offer1', 'pizza', ['takeout']]]);
    assert.equal(res.before.kpis.avgWait.mean, (res.runs.before[0].metrics.avgWait + res.runs.before[1].metrics.avgWait) / 2);
  });
});

describe('swarm compare', () => {
  const CLI = join(REPO, 'bin', 'swarm.js');
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'swarm-compare-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });
  const run = args => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' });

  test('an offer patch prints the offer, who it helped and where its audience went', () => {
    const file = join(dir, 'offer.json');
    writeFileSync(file, JSON.stringify([{ kind: 'offer', offer: { id: 'pizza_deal', text: 'Forno Slice: 30% off', to: { groups: ['takeout'] }, place: 'pizza', priceOff: 0.3 } }]));
    const r = run(['compare', 'food-hall-lunch', '--patch', file, '--seeds', '2']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Offers added by the patch/);
    assert.match(r.stdout, /pizza_deal\s+Takeout grabbers\s+Forno Slice\s+30%/);
    assert.match(r.stdout, /Takeout grabbers \(offer\)/);
    assert.match(r.stdout, /Where the offer's audience went/);
    assert.match(r.stdout, /Takeout grabbers: .*Forno Slice/);
  });

  test('--json carries the effects and leaves out the raw per-seed runs', () => {
    const file = join(dir, 'servers.json');
    writeFileSync(file, JSON.stringify([{ kind: 'node', id: 'coffee', field: 'servers', value: 4 }]));
    const r = run(['compare', 'food-hall-lunch', '--patch', file, '--seeds', '2', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.runs, undefined);
    assert.ok(out.effects.kpis.abandonRate && out.effects.segments.byGroup.length === 3);
    assert.deepEqual(out.offers, []);
  });
});
