// run/timescale.js: which questions need the same people followed over days (docs/PROTOTYPE.md §21d), and the
// advisor's test over days. The advisor's model is a scripted fake: no network, no key.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { timescaleOf, TIMESCALE_RULE } from '../run/timescale.js';
import { advise } from '../run/advisor.js';
import { RulesProvider } from '../providers/rules.js';

const readJson = rel => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

describe('one day or several: the rule', () => {
  test('questions about the day get a one-day test', () => {
    for (const q of ['Where do people give up at lunch?', 'Should I add a second register at the rush?', 'Which counter has the longest line?',
      'What if I move the pickup shelf to the door?', 'Who walks away, and where do they go?', '']) {
      assert.equal(timescaleOf(q).scale, 'day', q);
    }
    assert.equal(timescaleOf(null).scale, 'day');
  });

  test('questions about later days get a test over days', () => {
    for (const q of ['If I raise the latte by 50 cents, will my regulars come back?', 'Would a stamp card bring more new customers?',
      'Does a promotion keep customers after it ends?', 'How many first-timers return?', 'Will a long line on Monday hurt me next week?',
      'Is loyalty worth a punch card?', 'What does this do to word of mouth?', 'Will I lose customers over time if I cut staff?']) {
      const r = timescaleOf(q);
      assert.equal(r.scale, 'days', q);
      assert.ok(r.matched && q.toLowerCase().includes(r.matched), q);
    }
  });

  test('the rule in words names both kinds, what each is for, and what the long one needs', () => {
    for (const phrase of ['one-day test', 'test over days', 'come back', 'pool', 'Jev', 'unvalidated']) assert.ok(TIMESCALE_RULE.includes(phrase), phrase);
  });
});

// ---------- the advisor ----------

const tool = (name, input, id = `toolu_${name}`) => ({ type: 'tool_use', id, name, input });
const turn = (...blocks) => ({ stop_reason: 'tool_use', content: blocks });
const finish = () => tool('finish', {
  answer: 'One more barista keeps more people.', findings: ['Test over days W1.'], recommendations: [], cautions: ['Unvalidated sizes.'],
  couldNotTest: [], nextSteps: []
});
function fakeClient(replies) {
  const calls = [];
  return {
    calls,
    client: { beta: { messages: { stream(params) {
      calls.push(structuredClone(params));
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
      return { finalMessage: async () => structuredClone(reply) };
    } } } }
  };
}
const resultFor = (params, id) => params.messages.at(-1).content.find(r => r.tool_use_id === id);
const WORLD = readJson('../worlds/alder-pine-cafe.json'), POOL = readJson('../pools/alder-pine-cafe.json');
const overDays = tool('test_over_days', { label: 'One more barista, over two weeks', why: 'The question is whether people come back.', change: 'staff', value: 1 });

describe('the advisor can test over days', () => {
  test('its instructions carry the rule, and it has both tests', async () => {
    const { client, calls } = fakeClient([turn(finish())]);
    await advise({ world: WORLD, client, seeds: [7], provider: 'rules', pool: POOL, daysProvider: new RulesProvider(), days: 5 });
    assert.ok(calls[0].system.includes(TIMESCALE_RULE));
    assert.deepEqual(calls[0].tools.map(t => t.name), ['test_change', 'look_at_person', 'list_people', 'test_over_days', 'finish']);
    const first = calls[0].messages[0].content;
    assert.match(first, /test_over_days can run: a pool of 420 people for Alder & Pine Coffee, 5 mornings on seeds 7/);
  });

  test('with a pool it follows the same people over days and reports each measure with its range', async () => {
    const { client, calls } = fakeClient([turn(overDays), turn(finish())]);
    const advice = await advise({ world: WORLD, client, seeds: [7, 8], provider: 'rules', pool: POOL, daysProvider: new RulesProvider(), days: 5 });
    const res = JSON.parse(resultFor(calls[1], overDays.id).content);
    assert.equal(res.id, 'W1');
    assert.equal(res.change, '+1 staff at Alder & Pine Coffee');
    assert.ok(res.effects.walkAwaysPerWeek.change < 0 && res.effects.walkAwaysPerWeek.everySeedAgrees, 'one more barista: fewer walk-aways');
    assert.deepEqual(Object.keys(res.effects.regulars), ['before', 'after', 'change', 'least', 'most', 'everySeedAgrees']);
    assert.match(res.read, /unvalidated/);
    assert.equal(res.testsOverDaysLeft, 0);
    assert.equal(advice.testsOverDays.length, 1);
    assert.deepEqual(advice.testsOverDays[0].seeds, [7, 8]);
  });

  test('it is limited, and a bad change runs nothing', async () => {
    const bad = tool('test_over_days', { label: 'x', why: 'y', change: 'price', value: 0 }, 'toolu_bad');
    const again = { ...overDays, id: 'toolu_again' };
    const { client, calls } = fakeClient([turn(bad), turn(overDays), turn(again), turn(finish())]);
    const advice = await advise({ world: WORLD, client, seeds: [7], provider: 'rules', pool: POOL, daysProvider: new RulesProvider(), days: 5 });
    assert.match(resultFor(calls[1], 'toolu_bad').content, /Nothing was run: change must be/);
    assert.match(resultFor(calls[3], 'toolu_again').content, /all 1 tests over days in this round are used/);
    assert.equal(advice.testsOverDays.length, 1);
  });

  test('without a pool, or without Jev, it says what is missing and runs nothing', async () => {
    const a = fakeClient([turn(overDays), turn(finish())]);
    const none = await advise({ world: WORLD, client: a.client, seeds: [7], provider: 'rules' });
    assert.match(a.calls[0].messages[0].content, /test_over_days cannot run for this world: it has no pool/);
    assert.deepEqual(a.calls[0].tools.map(t => t.name), ['test_change', 'look_at_person', 'list_people', 'finish'], 'not offered without a pool');
    assert.match(resultFor(a.calls[1], overDays.id).content, /no pool of regular customers/);
    assert.equal(Object.hasOwn(none, 'testsOverDays'), false, 'the advice is what it always was');
    const b = fakeClient([turn(overDays), turn(finish())]);
    await advise({ world: WORLD, client: b.client, seeds: [7], provider: 'rules', pool: POOL, daysProvider: null });
    assert.match(b.calls[0].messages[0].content, /cannot run now: it needs Jev/);
    assert.match(resultFor(b.calls[1], overDays.id).content, /needs Jev/);
  });
});
