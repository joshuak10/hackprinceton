// "Tell Jev what just happened, and ask again" (docs/PROTOTYPE.md §9c): which moment is asked about, what is sent,
// and the words for what moved. Jev itself is not called here.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { targetChoice, askRows, askWords, rowWords, everyoneRows, elsewhereWords, brief, sizeOf } from '../web/scope/lib/ask-again.js';
import { askAgain, together, cleanToday, withToday, eveningWords, REPEATS } from '../run/ask-again.js';

const person = { name: 'Julian Reyes', about: 'Tenth anniversary tonight. The babysitter leaves at nine.' };
const LINE = {
  id: 'd56', t: 63, agentId: 26, personaId: 'julian', kind: 'line', placeId: 'table',
  asks: { yesNo: 'join', choice: 'next_place', frustration: true },
  options: [{ key: 'leave', label: 'Eat somewhere else' }],
  observation: { person, now: 'Just reached Table. The line is long, about 40 min.' },
  decision: { yesProb: 0.38 }, applied: { yes: false }
};
const pair = (a, b, fa = 'impatient', fb = fa) => ({ again: { yes: a, feeling: fa }, changed: { yes: b, feeling: fb } });

describe('ask again', () => {
  test('the moment asked about is the last choice at or before the time on the slider', () => {
    const ds = [{ id: 'd1', t: 60, agentId: 26, observation: { person } }, LINE, { id: 'd9', t: 70, agentId: 26, observation: { person } },
      { id: 'd3', t: 61, agentId: 4, observation: { person } }, { id: 'd0', t: 10, agentId: 26 }];
    assert.equal(targetChoice(ds, 26, 65).id, 'd56');
    assert.equal(targetChoice(ds, 26, 200).id, 'd9');
    assert.equal(targetChoice(ds, 26, 5).id, 'd1', 'before their first choice, the first one');
    assert.equal(targetChoice(ds, 99, 65), null);
  });

  test('what moved, in words: stated at 10 points, small from 5, nothing under that', () => {
    assert.deepEqual([sizeOf(10), sizeOf(-9), sizeOf(5), sizeOf(4), sizeOf(0)], ['clear', 'small', 'small', 'none', 'none']);
    const result = { tonight: pair(0.56, 0.68, 'impatient', 'touched'), back: pair(0.29, 0.45) };
    assert.deepEqual(askRows(result).map(rowWords), [
      { label: 'Stays to eat here tonight', again: '56%', changed: '68%', change: '+12', size: 'clear' },
      { label: 'Comes back next week', again: '29%', changed: '45%', change: '+16', size: 'clear' }
    ]);
    const w = askWords(result, { backLabel: 'Comes back next Friday' });
    assert.equal(w.headline, 'Stays to eat here tonight: 56% without your sentence, 68% with it. More likely by 12 points.', 'the headline is tonight');
    assert.equal(w.feeling, 'Feels impatient without it, touched with it.');
    const small = askWords({ tonight: pair(0.57, 0.50), back: null });
    assert.equal(small.headline, 'Stays to eat here tonight: 57% without your sentence, 50% with it. A small change, and it can be chance.');
    assert.equal(small.feeling, 'Feels impatient either way.');
    assert.match(askWords({ tonight: pair(0.55, 0.57) }).headline, /^No real change\. Stays to eat here tonight: 55% without your sentence, 57% with it\.$/);
    assert.equal(askWords({ tonight: { again: {}, changed: {} } }), null);
  });

  test('the same sentence for several people: the largest change first', () => {
    const rows = everyoneRows([
      { name: 'Dana', about: 'Student', result: { tonight: pair(0.69, 0.72) } },
      { name: 'Priya', about: 'Film at 7:30', result: { tonight: pair(0.63, 0.41, 'impatient', 'worried') } },
      { name: 'Nobody', result: { tonight: { again: {}, changed: {} } } }
    ]);
    assert.deepEqual(rows.map(r => [r.name, r.again, r.changed, r.change, r.size, r.feeling]), [
      ['Priya', '63%', '41%', '−22', 'clear', 'impatient to worried'], ['Dana', '69%', '72%', '+3', 'none', 'impatient']
    ]);
    assert.equal(elsewhereWords(rows, 'Dana', 'none'), 'It mattered most to Priya (film at 7:30): 63% without it, 41% with it.');
    assert.equal(elsewhereWords(rows, 'Dana', 'clear'), '', 'not said when the person who is open moved');
    assert.equal(elsewhereWords(rows, 'Priya', 'none'), '', 'nobody else moved');
    assert.equal(brief('Brought her two children after a swim meet. The younger one is hungry.'), 'Brought her two children after a swim meet');
    assert.equal(brief('Has a film starting at 7:30 a few blocks away and has not eaten since breakfast.', 40), 'Has a film starting at 7:30 a few…');
  });

  test('the two versions differ only in the last sentence, and the evening becomes a memory', async () => {
    assert.equal(cleanToday('  the babysitter\n can stay\tlate.  '), 'the babysitter can stay late.');
    assert.equal(withToday(LINE.observation.now, 'The babysitter can stay late!'), 'Just reached Table. The line is long, about 40 min. Just now: The babysitter can stay late.');
    assert.equal(eveningWords({ served: 0, waitTotal: 0 }, 'the sushi restaurant'), 'found people waiting for a seat at the sushi restaurant and left without eating');
    assert.equal(eveningWords({ served: 1, waitTotal: 21 }, 'the sushi restaurant'), 'waited about 20 minutes for a seat at the sushi restaurant, then was seated');

    const spec = JSON.parse(await readFile(new URL('../worlds/sushi-restaurant.json', import.meta.url), 'utf8'));
    const pool = JSON.parse(await readFile(new URL('../pools/sushi-restaurant.json', import.meta.url), 'utf8'));
    const sent = [];
    const fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      sent.push(body);
      const text = JSON.stringify(body), warm = text.includes('sparkling wine');
      return new Response(JSON.stringify({ model: 'jev-test', usage: { input_tokens: 1, output_tokens: 1 }, answers: {
        stay_tonight: { noul: warm ? 0.7 : 0.55 }, visit_today: { noul: warm ? 0.45 : 0.3 }, frustration: { score: 1 },
        feeling_now: { probabilities: warm ? { touched: 0.6, impatient: 0.4 } : { impatient: 0.8, content: 0.2 } }
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const out = await askAgain(LINE, 'The host brings sparkling wine', { apiKey: 'test-key', fetch, spec, pool, agent: { served: 0, waitTotal: 0 } });
    assert.equal(sent.length, 2 * REPEATS + 2, 'tonight three times each way, next week once each way');
    assert.deepEqual([out.tonight.again.yes, out.tonight.again.feeling, out.tonight.again.asks], [0.55, 'impatient', REPEATS]);
    assert.deepEqual([out.tonight.changed.yes.toFixed(2), out.tonight.changed.feeling, out.tonight.changed.spread], ['0.70', 'touched', 0]);
    assert.deepEqual([out.back.again.yes, out.back.changed.yes], [0.3, 0.45]);
    assert.equal(out.back.memory, 'found people waiting for a seat at the sushi restaurant and left without eating');
    const texts = sent.map(b => JSON.stringify(b));
    const tonight = texts.filter(t => t.includes('stay to eat here tonight')), back = texts.filter(t => !t.includes('stay to eat here tonight'));
    const plain = tonight.find(t => t.includes('Just now: Nothing else has happened.')), wine = tonight.find(t => t.includes('sparkling wine'));
    assert.equal(wine.replace('Just now: The host brings sparkling wine.', 'Just now: Nothing else has happened.'), plain, 'tonight: only the last sentence differs');
    const usual = back.find(t => t.includes('Nothing else happened that evening.')), warm = back.find(t => t.includes('sparkling wine'));
    assert.equal(warm.replace('The host brings sparkling wine.', 'Nothing else happened that evening.'), usual, 'next week: only the last sentence differs');
    assert.deepEqual(together([{ yes: 0.5, feeling: 'sad' }, { yes: 0.6, feeling: 'hurt' }, { yes: 0.7, feeling: 'calm' }]).feeling, null, 'three different words is no answer');
    assert.equal(together([{ yes: 0.5, feeling: 'sad' }, { yes: 0.6, feeling: 'sad' }, { yes: 0.7, feeling: 'hurt' }]).feeling, 'sad');

    const alone = await askAgain(LINE, 'The host brings sparkling wine', { apiKey: 'test-key', fetch });
    assert.equal(alone.back, null, 'without a pool of diners only tonight is asked');
    await assert.rejects(askAgain(LINE, 'x', { apiKey: 'test-key', fetch }), /3 to 240 characters/);
    await assert.rejects(askAgain({ id: 'd1' }, 'something happened', { apiKey: 'test-key', fetch }), /without what the person was told/);
  });
});
