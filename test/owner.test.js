// The owner's view (docs/PROTOTYPE.md §21g): one period for the whole screen, and today next to one change in four numbers.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER_CHANGES, resultFor, periodsFor, compareFor, figureRows, dayBars, ownerHeadline } from '../web/scope/lib/owner.js';
import { daySeries, mealMinutes } from '../run/days-saved.js';

const day = (seated, fresh, away, waited) => ({ seated, fresh, away, revenue: seated * 35, waited });
// Two runs of four Fridays: the change seats four more every Friday on both runs, and one more new customer on one of them.
const RESULT = {
  label: '2 more seats (Counter seats)', days: 4, runs: 2, meal: { base: 35, after: 34 },
  series: {
    base: [[day(20, 8, 6, 160), day(22, 9, 5, 176), day(21, 9, 6, 168), day(23, 10, 5, 184)], [day(24, 10, 4, 192), day(22, 9, 6, 176), day(23, 10, 5, 184), day(21, 8, 6, 168)]],
    after: [[day(24, 9, 2, 120), day(26, 10, 1, 130), day(25, 10, 2, 125), day(27, 11, 1, 135)], [day(28, 10, 0, 140), day(26, 9, 2, 130), day(27, 10, 1, 135), day(25, 8, 2, 125)]]
  }
};
const META = { daysPerWeek: 1, dayName: 'Friday evening' };

describe("the owner's view", () => {
  test('the periods go as far as the saved runs do, in the place\'s own days', () => {
    assert.deepEqual(periodsFor(META, 8).map(p => [p.n, p.label]), [[1, '1 Friday'], [2, '2 Fridays'], [4, '1 month'], [8, '2 months']]);
    assert.deepEqual(periodsFor(META, 4).map(p => p.label), ['1 Friday', '2 Fridays', '1 month']);
    assert.deepEqual(periodsFor({ daysPerWeek: 5 }, 10).map(p => [p.n, p.label]), [[1, '1 day'], [5, '1 week'], [10, '2 weeks']]);
    assert.deepEqual(periodsFor(null, 0), []);
  });

  test('today next to the change, over the first n days', () => {
    const one = compareFor(RESULT, 1), month = compareFor(RESULT, 4);
    assert.deepEqual([one.base.seated, one.after.seated, one.base.revenue, one.after.revenue], [22, 26, 770, 910]);
    assert.equal(Math.round(one.base.stay), 43, 'eight minutes waiting and a 35-minute meal');
    assert.deepEqual([month.base.seated, month.after.seated], [88, 104]);
    assert.deepEqual(figureRows(month).map(r => [r.label, r.base, r.after, r.change]), [
      ['Revenue', '$3,080', '$3,640', '+$560'], ['Customers seated', '88', '104', '+16'],
      ['Average stay', '43 min', '39 min', '−4 min'], ['Returning customers', '59%', '63%', '+4 points']
    ]);
    assert.equal(ownerHeadline(month, OWNER_CHANGES[0], '1 month'), 'Over 1 month, two more seats means $560 more revenue and 16 more customers seated.');
    assert.equal(compareFor({ series: { base: [], after: [] } }, 1), null);
  });

  test('a change is stated only where every run agrees', () => {
    const mixed = structuredClone(RESULT);
    mixed.series.after[1] = mixed.series.base[1].map(d => ({ ...d, seated: d.seated - 1, revenue: d.revenue - 35 }));
    const rows = figureRows(compareFor(mixed, 4));
    assert.deepEqual(rows.slice(0, 2).map(r => [r.change, r.moved]), [['about the same', false], ['about the same', false]]);
    assert.match(ownerHeadline(compareFor(mixed, 4), OWNER_CHANGES[0], '1 month'), /makes no clear difference/);
  });

  test('the chart, and which saved result a change shows', () => {
    const bars = dayBars(RESULT, 2);
    assert.deepEqual(bars.base[0], { returning: 13, fresh: 9, away: 5 });
    assert.deepEqual(bars.after[1], { returning: 16.5, fresh: 9.5, away: 1.5 });
    const saved = { results: [{ label: 'Meals 15% quicker (Counter seats)' }, RESULT, { label: 'A card for people turned away: a free roll within two weeks' }] };
    assert.deepEqual(OWNER_CHANGES.map(c => resultFor(saved, c.id).label), [RESULT.label, 'Meals 15% quicker (Counter seats)', 'A card for people turned away: a free roll within two weeks']);
    assert.equal(resultFor({ results: [] }, 'seats'), null);
  });

  test('a run of the loop as numbers per day, and the length of a meal', () => {
    const run = { days: [{ left: 2 }, { left: 1 }], people: [
      { persona: 'hiro', visits: [{ day: 0, wait: 10, outcome: 'served', paid: 35 }, { day: 1, wait: 0, outcome: 'left', paid: null }] },
      { persona: 'maya', visits: [{ day: 0, wait: 20, outcome: 'served', paid: 35 }, { day: 1, wait: 5, outcome: 'served', paid: 28 }] }
    ] };
    assert.deepEqual(daySeries(run, new Set(['maya'])), [{ seated: 2, fresh: 1, away: 2, revenue: 70, waited: 30 }, { seated: 1, fresh: 1, away: 1, revenue: 28, waited: 5 }]);
    const world = { nodes: [{ id: 'counter', servers: 4, serviceTime: 30 }, { id: 'table', servers: 4, serviceTime: 40 }] };
    assert.equal(mealMinutes(world, ['counter', 'table']), 35);
    assert.equal(mealMinutes(world, ['counter', 'table'], '2 more seats (Counter seats)'), 34);
    assert.equal(mealMinutes(world, ['counter', 'table'], 'Meals 15% quicker (Counter seats)'), 32.75);
    assert.equal(mealMinutes(world, []), null);
  });
});
