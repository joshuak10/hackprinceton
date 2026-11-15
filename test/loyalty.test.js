// The loyalty buttons on the sushi page (docs/PROTOTYPE.md §21f): the words and numbers in web/scope/lib/loyalty.js.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOYALTY, suggestionWords, savedResult, changeOf, loyaltyRows, loyaltyWords, regularWords, captionWords, missingWords
} from '../web/scope/lib/loyalty.js';

const effect = (before, after, min, max, agrees) => ({ before, after, mean: after - before, min, max, agrees });
const META = { daysPerWeek: 1, dayName: 'Friday evening', regular: { visits: 2, days: 4 }, shopName: 'the sushi restaurant' };
const SEATS = {
  label: '2 more seats (Counter seats)', days: 8, runs: 3, provider: 'jev',
  effects: {
    servedPerWeek: effect(23.6, 27.8, 4, 4.4, true), walkAwaysPerWeek: effect(9.1, 6.9, -2.6, -1.9, true),
    avgWait: effect(8.1, 6.2, -2.4, -1.2, true), firstTimersPerWeek: effect(1, 1, 0, 0, false),
    regulars: effect(24, 24.3, -3, 4, false)
  }
};

describe('the loyalty buttons', () => {
  test('each button finds its saved result by the label the days command writes', () => {
    // The labels `swarm days pools/sushi-restaurant.json --change promo20,seats+2,faster15,sorry` saves.
    const saved = { results: [
      { label: '20% off for the first week, heard of by half the street' },
      { label: 'A card for people turned away: a free roll within two weeks' },
      { label: 'Meals 15% quicker (Counter seats)' },
      { label: '2 more seats (Counter seats)' }
    ] };
    for (const c of LOYALTY) assert.match(savedResult(saved, c.id).label, c.match, c.id);
    assert.equal(new Set(LOYALTY.map(c => savedResult(saved, c.id).label)).size, 3);
    assert.equal(savedResult({ results: [{ label: '20% off for the first week' }] }, 'seats'), null);
    assert.equal(savedResult(null, 'card'), null);
  });

  test('a change is stated only where every run agrees', () => {
    assert.deepEqual(changeOf('count', effect(23.6, 27.8, 4, 4.4, true)), { state: 'clear', words: '+4' });
    assert.deepEqual(changeOf('count', effect(9, 7, -2.6, -1.4, true)), { state: 'clear', words: '−3 to −1' });
    assert.deepEqual(changeOf('minutes', effect(8.1, 6.2, -2.44, -1.21, true)), { state: 'clear', words: '−2.4 min to −1.2 min' });
    assert.deepEqual(changeOf('count', effect(24, 24.3, -3, 4, false)), { state: 'unclear', words: 'no clear change' });
    assert.deepEqual(changeOf('count', effect(1, 1, 0, 0, false)), { state: 'none', words: 'no change' });
    assert.equal(changeOf('count', effect(1, 1.2, 0.1, 0.3, true)).state, 'none');
    assert.equal(changeOf('count', undefined).words, 'n/a');
  });

  test('the headline and the line about regulars', () => {
    const w = loyaltyWords('seats', SEATS, META);
    assert.equal(w.headline, 'Two more seats: about 4 more people seated every Friday, about 2 fewer turned away or giving up.');
    assert.equal(w.regulars, 'Regulars: no clear change (24 before, 24 after; the runs disagree).');
    const none = loyaltyWords('card', { effects: { regulars: effect(24, 26, 1, 3, true) } }, META);
    assert.equal(none.headline, 'A card for people you turn away: no clear change in who gets a seat.');
    assert.equal(none.regulars, 'Regulars: +1 to +3 (24 before, 26 after).');
    assert.equal(loyaltyWords('seats', null, META), null);
  });

  test('the table, the caption and what a regular is', () => {
    const rows = loyaltyRows(SEATS);
    assert.deepEqual(rows.map(r => r.label), ['People seated', 'Turned away or gave up', 'Average wait for a seat', 'First-time visitors', 'Regulars']);
    assert.deepEqual([rows[0].before, rows[0].after, rows[0].change.words], ['24', '28', '+4']);
    assert.equal(rows[2].before, '8.1 min');
    assert.equal(captionWords(SEATS, META), 'Per Friday, averaged over 8 Fridays and 3 runs each way; the change is the range across runs.');
    assert.equal(regularWords(META), 'A regular came on at least 2 of the last 4 Fridays.');
    assert.equal(regularWords(null), '');
  });

  test('the opening sentence, and a result that is not saved', () => {
    const s = suggestionWords({ spawned: 36, served: 24 });
    assert.equal(s.headline, '12 of 36 people did not get a seat.');
    assert.match(s.advice, /Being turned away is what stops diners coming back/);
    assert.equal(suggestionWords({ spawned: 0 }), null);
    const m = missingWords('faster', 'pools/sushi-restaurant.json');
    assert.match(m.headline, /no saved result on this computer/);
    assert.equal(m.command, 'node bin/swarm.js days pools/sushi-restaurant.json --days 8 --seeds 3 --provider jev --change faster15 --out data/days/faster.json');
  });
});
