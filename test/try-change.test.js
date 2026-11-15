// A change in the owner's own words (docs/PROTOTYPE.md §21h): how a sentence is read. Jev is not called here.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseChange, changeFromText } from '../run/try-change.js';
import { normalizePool } from '../run/days.js';
import { validateWorld } from '../engine/spec.js';
import { OWNER_CHANGES, ownerChange, resultFor } from '../web/scope/lib/owner.js';

describe('a typed change', () => {
  test('words that name a lever become that lever, with the number in the sentence', () => {
    const name = t => parseChange(t).name;
    assert.deepEqual(['three more seats', 'add 4 stools at the counter', 'Two extra chairs'].map(name), ['seats+3', 'seats+4', 'seats+2']);
    assert.deepEqual(['make meals 20% faster', 'faster turnover at the counter'].map(name), ['faster20', 'faster15']);
    assert.deepEqual(['raise prices by $3', 'cut the price by 2 dollars', 'lower prices'].map(name), ['price+3', 'price-2', 'price-2']);
    assert.deepEqual(['10% off on Fridays', 'run a promotion'].map(name), ['promo10', 'promo20']);
    assert.deepEqual(['a stamp card: buy 9 get the next free', 'a loyalty card'].map(name), ['card10', 'card10']);
    assert.equal(name('a sorry card for people we turn away'), 'sorry');
    assert.match(parseChange('three more seats').understood, /^3 more seats at the counter$/);
  });

  test('anything else is something customers are told, and reaches only people who know the place', async () => {
    const parsed = parseChange('Take phone numbers and text people when their seat is ready.');
    assert.equal(parsed.name, undefined);
    assert.equal(parsed.message, 'Take phone numbers and text people when their seat is ready');
    const spec = validateWorld(JSON.parse(await readFile(new URL('../worlds/sushi-restaurant.json', import.meta.url), 'utf8'))).spec;
    const pool = normalizePool(JSON.parse(await readFile(new URL('../pools/sushi-restaurant.json', import.meta.url), 'utf8')));
    const told = changeFromText('free green tea while you wait', spec, pool, 8).change;
    assert.deepEqual([told.from, told.to, told.label], [0, 7, 'Told to customers: free green tea while you wait']);
    assert.deepEqual(told.promo, { text: 'the sushi restaurant: free green tea while you wait.', priceOff: 0, reach: 0, audience: 'customers' });
    const seats = changeFromText('three more seats', spec, pool, 8).change;
    assert.equal(seats.label, '3 more seats (Counter seats)');
  });

  test('a typed change shows its own saved result, and a suggestion shows only its own', () => {
    const saved = { results: [{ label: '3 more seats (Counter seats)' }, { label: 'Price up to $38.00' }, { label: '2 more seats (Counter seats)' }, { label: 'Meals 20% quicker (Counter seats)' }] };
    const typed = { label: 'Price up to $38.00', text: 'Raise prices by $3.', understood: 'every price up by $3' };
    assert.equal(resultFor(saved, typed).label, 'Price up to $38.00');
    assert.deepEqual([ownerChange(typed).id, ownerChange(typed).words, ownerChange(typed).name], ['typed', 'raise prices by $3', '“raise prices by $3”']);
    assert.equal(resultFor(saved, 'seats').label, '2 more seats (Counter seats)', 'not the three-seat run');
    assert.equal(resultFor(saved, 'faster'), null, 'the 20% run is not the suggestion');
    assert.equal(resultFor(saved, { label: 'Never run' }), null);
    assert.equal(OWNER_CHANGES.length, 3);
  });
});
