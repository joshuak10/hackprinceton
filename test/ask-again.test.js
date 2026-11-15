// "Tell Jev what just happened, and ask again" (docs/PROTOTYPE.md §9c): which choice is asked, what is sent, and
// the words for what moved. Jev itself is not called here.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { targetChoice, askRows, askWords } from '../web/scope/lib/ask-again.js';
import { askAgain, cleanToday, withToday } from '../run/ask-again.js';

const person = { name: 'Julian Reyes', about: 'Tenth anniversary tonight. The babysitter leaves at nine.' };
const LINE = {
  id: 'd56', t: 63, agentId: 26, kind: 'line', placeId: 'table',
  asks: { yesNo: 'join', choice: 'next_place', frustration: true },
  options: [{ key: 'leave', label: 'Eat somewhere else' }],
  observation: { person, now: 'Just reached Table. The line is long, about 40 min.' },
  decision: { yesProb: 0.38, choiceProbs: { leave: 1 }, frustration: { expected: 1.2 } }, applied: { yes: false }
};
const answer = (yes, feel) => ({ yesProb: yes, choiceProbs: { leave: 1 }, frustration: feel });

describe('ask again', () => {
  test('the choice asked is the last one at or before the time on the slider', () => {
    const ds = [{ id: 'd1', t: 60, agentId: 26, observation: { person } }, LINE, { id: 'd9', t: 70, agentId: 26, observation: { person } },
      { id: 'd3', t: 61, agentId: 4, observation: { person } }, { id: 'd0', t: 10, agentId: 26 }];
    assert.equal(targetChoice(ds, 26, 65).id, 'd56');
    assert.equal(targetChoice(ds, 26, 200).id, 'd9');
    assert.equal(targetChoice(ds, 26, 5).id, 'd1', 'before their first choice, the first one');
    assert.equal(targetChoice(ds, 99, 65), null);
  });

  test('a yes/no question with a follow-up choice is read by its yes/no answer', () => {
    const result = { recorded: answer(0.38, 1.2), again: answer(0.36, 1.2), changed: answer(0.57, 1.1) };
    assert.deepEqual(askRows(LINE, result), [{ key: 'yes', label: 'Yes', recorded: 0.38, again: 0.36, changed: 0.57 }]);
    const w = askWords(LINE, result, { question: 'Join the line at Table?' });
    assert.equal(w.size, 'clear');
    assert.equal(w.headline, '“Join the line at Table?” Yes: 36% without your sentence, 57% with it. More likely by 21 points.');
    assert.equal(w.feeling, 'Feeling mildly annoyed either way.');
    assert.match(w.note, /recorded answer was 38%/);
  });

  test('a small change is called small, no change is called none, and the feeling is said', () => {
    const small = askWords(LINE, { recorded: answer(0.38, 1.2), again: answer(0.41, 1.2), changed: answer(0.36, 2.1) }, { question: 'Join?' });
    assert.equal(small.size, 'small');
    assert.match(small.headline, /A change this small can be chance\./);
    assert.equal(small.feeling, 'Feeling mildly annoyed without it, frustrated with it.');
    assert.equal(askWords(LINE, { again: answer(0.40, 1.2), changed: answer(0.41, 1.3) }).size, 'none');
    const choice = { options: [{ key: 'a', label: 'Go to Table' }, { key: 'b', label: 'Go to Counter seats' }, { key: 'leave', label: 'Eat somewhere else' }], asks: { choice: 'next_place' } };
    const moved = askWords(choice, { again: { choiceProbs: { a: 0.7, b: 0.2, leave: 0.1 } }, changed: { choiceProbs: { a: 0.4, b: 0.3, leave: 0.3 } } });
    assert.match(moved.headline, /^Go to Table: 70% without your sentence, 40% with it\. Less likely by 30 points\.$/);
  });

  test('the sentence is added to what is happening now, and the two questions differ in nothing else', async () => {
    assert.equal(cleanToday('  the babysitter\n can stay\tlate.  '), 'the babysitter can stay late.');
    assert.equal(withToday(LINE.observation.now, 'The babysitter can stay late!'), 'Just reached Table. The line is long, about 40 min. Just now: The babysitter can stay late.');
    const sent = [];
    const fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      sent.push(body);
      const yes = JSON.stringify(body).includes('Just now:') ? 0.6 : 0.4;
      return new Response(JSON.stringify({ model: 'jev-test', usage: { input_tokens: 1, output_tokens: 1 }, answers: {
        join: { type: 'noul', noul: yes }, next_place: { type: 'choice', choice: 'leave', probabilities: { leave: 1 } }, frustration: { type: 'score', score: 1 }
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const out = await askAgain(LINE, 'The babysitter can stay late', { apiKey: 'test-key', fetch });
    assert.equal(sent.length, 2);
    assert.equal(out.now, 'Just reached Table. The line is long, about 40 min. Just now: The babysitter can stay late.');
    assert.equal(out.recorded.yesProb, 0.38);
    assert.ok(out.changed.yesProb > out.again.yesProb);
    const a = JSON.stringify(sent[0]), b = JSON.stringify(sent[1]);
    assert.equal(b.replace(' Just now: The babysitter can stay late.', ''), a, 'only the sentence differs');
    await assert.rejects(askAgain(LINE, 'x', { apiKey: 'test-key', fetch }), /3 to 240 characters/);
    await assert.rejects(askAgain({ id: 'd1' }, 'something happened', { apiKey: 'test-key', fetch }), /without what the person was told/);
  });
});
