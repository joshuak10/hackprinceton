// Advisor tests (docs/PROTOTYPE.md §15c) with a scripted fake Anthropic client: no network, no API key.
// Experiments run for real on worlds/food-hall-lunch.json with the rules provider (instant and free).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  advise, buildBrief, writeAdvice, adviceMarkdown, NO_KEY_MESSAGE, COULD_NOT_TEST, DEFAULT_MODEL, spentOf
} from '../run/advisor.js';
import { SEGMENT_NOTE } from '../run/report.js';
import { runSeeds } from '../run/runner.js';
import { makeProvider } from '../providers/index.js';
import { normalizeSpec } from '../engine/spec.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = p => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const FOOD_HALL = readJson('../worlds/food-hall-lunch.json');
const COFFEE = [{ kind: 'node', id: 'coffee', field: 'servers', value: 4 }];
const RESULT_FIELDS = ['answer', 'findings', 'recommendations', 'cautions', 'nextSteps', 'experiments', 'transcript'];

// ---------- the scripted fake client ----------

const tool = (name, input, id = `toolu_${name}`) => ({ type: 'tool_use', id, name, input });
const turn = (...blocks) => ({ stop_reason: 'tool_use', content: blocks });
const say = text => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const finish = (over = {}) => tool('finish', {
  answer: 'The coffee kiosk loses the most diners; two more baristas is the cheapest fix that clearly helps.',
  findings: ['Ember Coffee kiosk ranks first on every seed.'],
  recommendations: [{ experiment: 1, label: 'Two more baristas', why: 'Walk-aways fall by more than the spread.', confidence: 'high', costNote: 'Two part-time staff at lunch.' }],
  cautions: ['Arrival numbers are assumed.'],
  couldNotTest: ['Moving the kiosk: there is no lever for position.'],
  nextSteps: ['Confirm with Jev.'],
  ...over
});

// Each stream() call snapshots its params (the loop keeps appending to messages) and answers with the next
// scripted reply; a reply may be a function of (params, callIndex).
function fakeClient(replies) {
  const calls = [];
  const client = {
    beta: {
      messages: {
        stream(params) {
          calls.push(structuredClone(params));
          const i = calls.length - 1;
          const reply = replies[Math.min(i, replies.length - 1)];
          return { finalMessage: async () => structuredClone(typeof reply === 'function' ? reply(params, i) : reply) };
        }
      }
    }
  };
  return { client, calls };
}

// The tool results the loop sent back in the last user message of a call.
const toolResults = params => params.messages.at(-1).content;
const resultFor = (params, id) => toolResults(params).find(r => r.tool_use_id === id);

// Follows the rule policy, except in a world whose coffee kiosk has more than 2 servers, where it skips every line.
// Rules and this provider then disagree on the direction of "served" for the COFFEE patch.
function contrarianProvider() {
  return {
    name: 'contrarian',
    external: true,
    async decideMany(reqs, ctx) {
      const patched = ctx.spec.nodes.find(n => n.id === 'coffee').servers > 2;
      return reqs.map(r => ({ provider: 'contrarian', action: patched && r.asks.yesNo ? 'no' : r.auto.action }));
    },
    stats() { return { provider: 'contrarian' }; }
  };
}

// ---------- the loop ----------

describe('advise', () => {
  let first;
  let firstCalls;
  let steps;
  before(async () => {
    steps = [];
    const { client, calls } = fakeClient([
      turn({ type: 'text', text: 'The coffee kiosk ranks first; testing more baristas.' },
        tool('test_change', { label: 'Two more baristas', why: 'The coffee kiosk is the #1 bottleneck on every seed.', patch: COFFEE }, 'toolu_t1')),
      turn(finish())
    ]);
    first = await advise({ world: FOOD_HALL, client, onStep: e => steps.push(e) });
    firstCalls = calls;
  });

  test('test_change then finish returns exactly the 15c fields', () => {
    assert.deepEqual(Object.keys(first), RESULT_FIELDS);
    assert.match(first.answer, /coffee kiosk/);
    assert.deepEqual(first.findings, ['Ember Coffee kiosk ranks first on every seed.']);
    assert.deepEqual(first.nextSteps, ['Confirm with Jev.']);
    assert.equal(firstCalls.length, 2);
  });

  test('the experiment carries measured numbers on the same seeds', () => {
    assert.equal(first.experiments.length, 1);
    const e = first.experiments[0];
    assert.equal(e.n, 1);
    assert.equal(e.round, 1);
    assert.equal(e.label, 'Two more baristas');
    assert.match(e.why, /#1 bottleneck/);
    assert.deepEqual(e.seeds, [7, 8, 9]);
    assert.equal(e.testedWith, 'rules');
    assert.deepEqual(e.applied, ['Ember Coffee kiosk · servers 2 → 4']);
    const ab = e.kpis.abandonRate;
    for (const k of ['before', 'after', 'change', 'spread']) assert.equal(typeof ab[k], 'number', k);
    assert.equal(ab.bySeed.length, 3);
    assert.ok(Math.abs(ab.after - ab.before - ab.change) < 1e-5);
    assert.ok(ab.change < 0, 'more baristas lowers the abandon rate');
    assert.equal(e.verdict, 'helps');
    assert.equal(e.bottlenecks.before[0].id, 'coffee');
  });

  test('a recommendation gets the effect, provider and seed check from its experiment', () => {
    assert.equal(first.recommendations.length, 1);
    const r = first.recommendations[0];
    for (const k of ['label', 'patch', 'effect', 'testedWith', 'holdsAcrossSeeds', 'costNote', 'confidence', 'why']) assert.ok(k in r, k);
    assert.deepEqual(r.patch, COFFEE);
    assert.equal(r.testedWith, 'rules');
    assert.equal(r.experiment, 1);
    assert.equal(r.costNote, 'Two part-time staff at lunch.');
    assert.deepEqual(r.effect.abandonRate, {
      before: first.experiments[0].kpis.abandonRate.before, after: first.experiments[0].kpis.abandonRate.after,
      change: first.experiments[0].kpis.abandonRate.change, spread: first.experiments[0].kpis.abandonRate.spread
    });
    assert.ok(r.effect.avgWait);
    assert.equal(r.holdsAcrossSeeds, true);
    assert.equal(r.confidence, 'high');
  });

  test('the tool result goes back to Claude with before, after, change and spread', () => {
    const r = resultFor(firstCalls[1], 'toolu_t1');
    assert.ok(r, 'the test_change call got a tool_result');
    assert.notEqual(r.is_error, true);
    const body = JSON.parse(r.content);
    assert.equal(body.experiment, 1);
    for (const k of ['before', 'after', 'change', 'spread', 'bySeed', 'verdict']) assert.ok(k in body.kpis.abandonRate, k);
    assert.equal(body.testsLeft, 5);
    assert.ok(Array.isArray(body.bottlenecks.before));
  });

  test('the request uses the default model, four JSON Schema tools and the brief', () => {
    const p = firstCalls[0];
    assert.equal(p.model, DEFAULT_MODEL);
    assert.equal(p.model, 'claude-fable-5-2');
    assert.deepEqual(p.tools.map(t => t.name), ['test_change', 'look_at_person', 'list_people', 'finish']);
    for (const t of p.tools) assert.equal(t.input_schema.type, 'object');
    assert.deepEqual(p.tools[0].input_schema.required, ['label', 'why', 'patch']);
    assert.equal(p.tool_choice.type, 'auto');
    const first = p.messages[0].content;
    assert.match(first, /<brief>/);
    assert.match(first, /Levers test_change can set/);
    assert.match(first, /You have 6 tests in this round/);
    assert.ok(first.includes(FOOD_HALL.question));
  });

  test('the system prompt gives the advisor the 15c rules in plain words', () => {
    const s = firstCalls[0].system;
    assert.match(s, /Answer the user's question first, in plain words/);
    assert.match(s, /helping only if its effect is larger than the spread across seeds/);
    assert.match(s, /rankings under stated assumptions, not forecasts/i);
    assert.match(s, /Name the assumptions/);
    assert.match(s, /kinds of simulated people.*never real individuals/);
    assert.match(s, /Say what you could not test/);
  });

  test('cautions keep the model\'s, add the code\'s, and mark what could not be tested', () => {
    assert.ok(first.cautions.includes('Arrival numbers are assumed.'));
    assert.ok(first.cautions.some(c => /rules provider/.test(c)));
    assert.ok(first.cautions.includes(`${COULD_NOT_TEST}Moving the kiosk: there is no lever for position.`));
  });

  test('onStep reports each test and its measured effect as it happens', () => {
    const types = steps.map(s => s.type);
    assert.deepEqual(types.filter(t => ['test', 'result', 'finish'].includes(t)), ['test', 'result', 'finish']);
    const result = steps.find(s => s.type === 'result');
    assert.equal(result.label, 'Two more baristas');
    assert.equal(result.verdict, 'helps');
    assert.ok(result.kpis.abandonRate.change < 0);
    assert.ok(types.includes('baseline'));
  });

  test('the transcript is a compact record of the steps', () => {
    const [start, ...rest] = first.transcript;
    assert.equal(start.kind, 'start');
    assert.equal(start.question, FOOD_HALL.question);
    assert.deepEqual(start.seeds, [7, 8, 9]);
    assert.equal(start.provider, 'rules');
    assert.equal(start.model, 'claude-fable-5-2');
    assert.equal(start.runs.length, 3);
    assert.ok(rest.some(s => s.kind === 'assistant'));
    assert.deepEqual(rest.filter(s => s.kind === 'tool').map(s => s.name), ['test_change', 'finish']);
    assert.ok(JSON.stringify(first.transcript).length < 8000);
  });

  test('the experiment limit: after it, test_change tells Claude to finish and runs nothing', async () => {
    const t = (n, value) => tool('test_change', { label: `Coffee servers ${value}`, why: 'More capacity at the #1 bottleneck.', patch: [{ kind: 'node', id: 'coffee', field: 'servers', value }] }, `toolu_${n}`);
    const { client, calls } = fakeClient([turn(t(1, 3), t(2, 4), t(3, 5)), turn(finish())]);
    const res = await advise({ world: FOOD_HALL, client, maxExperiments: 2 });
    assert.equal(res.experiments.length, 2);
    const results = toolResults(calls[1]);
    assert.equal(results.length, 3, 'all three results go back in one user message');
    assert.notEqual(results[0].is_error, true);
    assert.notEqual(results[1].is_error, true);
    assert.equal(results[2].is_error, true);
    assert.match(results[2].content, /limit reached/i);
    assert.match(results[2].content, /finish/);
    assert.match(calls[0].messages[0].content, /You have 2 tests in this round/);
  });

  test('a patch that applies nothing returns a clear error and uses no test', async () => {
    const bad = tool('test_change', { label: 'Ghost stall', why: 'Testing.', patch: [{ kind: 'node', id: 'nowhere', field: 'servers', value: 3 }] }, 'toolu_bad');
    const good = tool('test_change', { label: 'Two more baristas', why: 'The #1 bottleneck.', patch: COFFEE }, 'toolu_good');
    const steps = [];
    const { client, calls } = fakeClient([turn(bad), turn(good), turn(finish())]);
    const res = await advise({ world: FOOD_HALL, client, maxExperiments: 1, onStep: e => steps.push(e) });
    const err = resultFor(calls[1], 'toolu_bad');
    assert.equal(err.is_error, true);
    assert.match(err.content, /applied nothing, so nothing was run/);
    assert.match(err.content, /nowhere/);
    assert.equal(res.experiments.length, 1, 'only the good patch ran');
    assert.equal(res.experiments[0].n, 1);
    assert.notEqual(resultFor(calls[2], 'toolu_good').is_error, true, 'the failed patch did not use up the one test');
    assert.ok(steps.some(s => s.type === 'rejected'));
  });

  test('a test without a reason is rejected', async () => {
    const { client, calls } = fakeClient([turn(tool('test_change', { label: 'More baristas', why: ' ', patch: COFFEE }, 'toolu_x')), turn(finish({ recommendations: [] }))]);
    const res = await advise({ world: FOOD_HALL, client });
    const r = resultFor(calls[1], 'toolu_x');
    assert.equal(r.is_error, true);
    assert.match(r.content, /why is missing/);
    assert.equal(res.experiments.length, 0);
  });

  test('a model that never calls finish is asked once, then the result is built from what exists', async () => {
    const { client, calls } = fakeClient([
      turn(tool('test_change', { label: 'Two more baristas', why: 'The #1 bottleneck.', patch: COFFEE }, 'toolu_t1')),
      say('More baristas helps.'),
      say('That is my advice.')
    ]);
    const steps = [];
    const res = await advise({ world: FOOD_HALL, client, onStep: e => steps.push(e) });
    assert.equal(calls.length, 3, 'one nudge, then stop');
    const nudge = calls[2].messages.at(-1);
    assert.equal(nudge.role, 'user');
    assert.match(nudge.content, /Call the finish tool now/);
    assert.ok(steps.some(s => s.type === 'nudge'));
    assert.deepEqual(Object.keys(res), RESULT_FIELDS);
    assert.equal(res.answer, 'That is my advice.');
    assert.match(res.cautions[0], /without calling finish/);
    assert.equal(res.recommendations.length, 1, 'the experiment that helped');
    assert.equal(res.recommendations[0].experiment, 1);
    assert.equal(res.recommendations[0].confidence, 'low');
    assert.ok(res.transcript.some(s => s.kind === 'nudge'));
  });

  test('confirmWith re-runs the recommendation, attaches both results and flags a disagreement', async () => {
    const { client, calls } = fakeClient([
      turn(tool('test_change', { label: 'Two more baristas', why: 'The #1 bottleneck.', patch: COFFEE }, 'toolu_t1')),
      turn(finish()),
      turn(finish({ answer: 'More baristas helps with rules but not with the second provider.' }, 'toolu_finish2'))
    ]);
    const steps = [];
    const res = await advise({ world: FOOD_HALL, client, confirmWith: contrarianProvider(), onStep: e => steps.push(e) });
    assert.equal(calls.length, 3, 'finish, confirmation results, final finish');
    const conf = JSON.parse(toolResults(calls[2])[0].content);
    assert.equal(conf.confirmations[0].experiment, 1);
    assert.equal(conf.confirmations[0].agrees, false);
    assert.ok(conf.confirmations[0].rules && conf.confirmations[0].contrarian);
    assert.match(conf.instruction, /Call finish again/);

    const r = res.recommendations[0];
    assert.equal(r.testedWith, 'rules');
    assert.ok(r.effect.served);
    assert.equal(r.confirmation.testedWith, 'contrarian');
    assert.ok(r.confirmation.effect.served);
    assert.equal(r.confirmation.agrees, false);
    assert.ok(r.confirmation.disagreeOn.includes('served'));
    assert.ok(r.effect.served.change > 0 && r.confirmation.effect.served.change < 0);
    assert.equal(r.confidence, 'low', 'a disagreement caps the confidence');
    assert.ok(res.cautions.some(c => /rules and contrarian disagree on the direction/.test(c)));
    assert.equal(res.answer, 'More baristas helps with rules but not with the second provider.');
    const record = res.experiments.find(e => e.confirms === 1);
    assert.equal(record.testedWith, 'contrarian');
    assert.ok(steps.some(s => s.type === 'confirm') && steps.some(s => s.type === 'confirmed' && s.agrees === false));
    assert.ok(!res.cautions.some(c => /Confirm the top change with Jev/.test(c)));
  });

  test('confirmWith that agrees adds no disagreement caution', async () => {
    const { client } = fakeClient([
      turn(tool('test_change', { label: 'Two more baristas', why: 'The #1 bottleneck.', patch: COFFEE }, 'toolu_t1')),
      turn(finish()),
      turn(finish())
    ]);
    const res = await advise({ world: FOOD_HALL, client, confirmWith: 'rules' });
    assert.equal(res.recommendations[0].confirmation.agrees, true);
    assert.ok(!res.cautions.some(c => /disagree/.test(c)));
  });

  test('a follow-up gives the earlier advice, experiments and the reply back, then updates the advice', async () => {
    const ramen = [{ kind: 'node', id: 'ramen', field: 'servers', value: 4 }];
    const { client, calls } = fakeClient([
      turn(tool('test_change', { label: 'One more ramen cook', why: 'The user asked about the ramen counter.', patch: ramen }, 'toolu_r')),
      turn(finish({
        answer: 'The ramen counter matters less than coffee.',
        recommendations: [
          { experiment: 1, label: 'Two more baristas', why: 'Still the biggest gain.', confidence: 'high' },
          { experiment: 2, label: 'One more ramen cook', why: 'Smaller gain.', confidence: 'medium' }
        ]
      }))
    ]);
    const reply = 'What about adding a cook at the ramen counter instead?';
    const res = await advise({ world: FOOD_HALL, client, previous: first, followUp: reply });
    const msg = calls[0].messages[0].content;
    assert.match(msg, /<earlier_advice>/);
    assert.match(msg, /<earlier_experiments>/);
    assert.match(msg, /#1 \(round 1, rules\) Two more baristas/);
    assert.match(msg, /abandon rate .* → /);
    assert.ok(msg.includes(reply));
    assert.match(msg, /new tests are numbered from #2/);
    assert.deepEqual(res.experiments.map(e => [e.n, e.round]), [[1, 1], [2, 2]]);
    assert.deepEqual(res.recommendations.map(r => r.experiment), [1, 2]);
    assert.ok(res.recommendations.every(r => r.effect.abandonRate));
    const start = res.transcript[0];
    assert.equal(start.round, 2);
    assert.equal(start.followUp, reply);
    assert.equal(start.question, FOOD_HALL.question);
  });

  test('a follow-up needs both the earlier advice and a reply', async () => {
    const { client } = fakeClient([turn(finish())]);
    await assert.rejects(advise({ world: FOOD_HALL, client, followUp: 'more?' }), /needs the earlier advice/);
    await assert.rejects(advise({ world: FOOD_HALL, client, previous: first }), /needs the user's reply/);
  });

  test('list_people and look_at_person answer from the baseline runs', async () => {
    let listed;
    const { client, calls } = fakeClient([
      turn(tool('list_people', { segment: 'takeout', sortBy: 'wait', limit: 3 }, 'toolu_list')),
      params => {
        listed = JSON.parse(resultFor(params, 'toolu_list').content);
        const p = listed.people[0];
        return turn(tool('look_at_person', { runId: p.runId, agentId: p.agentId }, 'toolu_look'));
      },
      turn(tool('list_people', { segment: 'nobody-here', sortBy: 'wait' }, 'toolu_bad')),
      turn(finish({ recommendations: [] }))
    ]);
    await advise({ world: FOOD_HALL, client });
    assert.equal(listed.segment.kind, 'group');
    assert.equal(listed.people.length, 3);
    assert.ok(listed.people.every(p => p.group === 'Takeout grabbers'));
    assert.ok(listed.people[0].waitTotal >= listed.people[1].waitTotal && listed.people[1].waitTotal >= listed.people[2].waitTotal);
    assert.match(listed.note, /not a real individual/);
    const look = JSON.parse(resultFor(calls[2], 'toolu_look').content);
    assert.equal(look.agentId, listed.people[0].agentId);
    assert.equal(look.persona.id, listed.people[0].persona);
    assert.ok(Array.isArray(look.trace) && look.trace.length > 0);
    assert.match(look.note, /simulated person/);
    const bad = resultFor(calls[3], 'toolu_bad');
    assert.equal(bad.is_error, true);
    assert.match(bad.content, /Group ids: workers, takeout, leisure/);
  });

  test('recommendations that cite no experiment are left out and noted', async () => {
    const { client } = fakeClient([turn(finish({ recommendations: [{ experiment: 99, label: 'Free coffee', why: 'Guess.', confidence: 'high' }] }))]);
    const res = await advise({ world: FOOD_HALL, client });
    assert.deepEqual(res.recommendations, []);
    assert.ok(res.cautions.some(c => /no experiment tested them: Free coffee/.test(c)));
  });

  test('an experiment number sent as a string still finds its experiment', async () => {
    const { client } = fakeClient([
      turn(tool('test_change', { label: 'Two more baristas', why: 'The #1 bottleneck.', patch: COFFEE })),
      turn(finish({ recommendations: [{ experiment: '1', label: 'Two more baristas', why: 'Helps.', confidence: 'medium' }] }))
    ]);
    const res = await advise({ world: FOOD_HALL, client });
    assert.equal(res.recommendations.length, 1);
    assert.equal(res.recommendations[0].experiment, 1);
    assert.equal(res.recommendations[0].confidence, 'medium', 'the model asked for medium, below the cap');
  });

  test('a change within the spread across seeds is not counted as helping', async () => {
    // Tables never queue, so one more seat changes nothing.
    const seat = [{ kind: 'node', id: 'tables', field: 'servers', value: 71 }];
    const { client } = fakeClient([
      turn(tool('test_change', { label: 'One more seat', why: 'Check the tables.', patch: seat })),
      turn(finish({ recommendations: [{ experiment: 1, label: 'One more seat', why: 'Cheap.', confidence: 'high' }] }))
    ]);
    const res = await advise({ world: FOOD_HALL, client });
    assert.equal(res.experiments[0].verdict, 'no clear effect');
    assert.equal(res.recommendations[0].confidence, 'low');
    assert.equal(res.recommendations[0].holdsAcrossSeeds, false);
    assert.ok(res.cautions.some(c => /One more seat: its effect on abandon rate .* is not larger than the spread across seeds/.test(c)));
  });

  // Written with names and no id, the way a model might: the engine fills the id and resolves the names.
  const PIZZA_OFFER = [{ kind: 'offer', offer: { text: 'Forno Slice: 30% off, ready in 2 minutes', to: { groups: ['Takeout grabbers'] }, place: 'Forno Slice', priceOff: 0.3 } }];

  test('an offer test reports the offer as the engine normalized it: reach, the place, and where its audience went', async () => {
    const { client, calls } = fakeClient([
      turn(tool('test_change', { label: 'Pizza deal for takeout', why: 'Takeout grabbers spend the most.', patch: PIZZA_OFFER })),
      turn(finish({ recommendations: [{ experiment: 1, label: 'Pizza deal for takeout', why: 'Their spend falls.', kpi: 'group:takeout.avgSpent', better: 'lower', confidence: 'high' }] }))
    ]);
    const res = await advise({ world: FOOD_HALL, client });
    const offer = res.experiments[0].offers[0];
    assert.equal(offer.id, 'offer1');
    assert.equal(offer.place, 'pizza');
    assert.deepEqual(offer.to, { groups: ['takeout'], cast: [] });
    assert.ok(offer.reached > 100 && offer.wentToPlace > 0 && offer.wentToPlace <= offer.reached, JSON.stringify(offer));
    assert.ok(offer.placeArrivals && offer.placeArrivals.before > 0, 'arrivals at the offer place are measured');
    const takeout = res.experiments[0].segments.byGroup.find(s => s.id === 'takeout');
    assert.ok(takeout.places.some(p => p.id === 'pizza' && p.after > p.before), JSON.stringify(takeout.places));
    // The tool result tells the model where the audience went; groups the offer did not target carry no place list.
    const sent = JSON.parse(resultFor(calls[1], 'toolu_test_change').content);
    assert.equal(sent.offers[0].id, 'offer1');
    assert.ok(sent.segments.byGroup.find(s => s.id === 'takeout').whereTheyWent.some(p => p.id === 'pizza'));
    assert.equal(sent.segments.byGroup.find(s => s.id === 'workers').whereTheyWent, undefined);
    const rec = res.recommendations[0];
    assert.equal(rec.kpi, 'group:takeout.avgSpent');
    assert.ok(rec.effect['group:takeout.avgSpent'].change < 0);
    assert.equal(rec.confidence, 'high');
    assert.equal(rec.holdsAcrossSeeds, true);
    assert.match(adviceMarkdown(res), /\n {3}Offer offer1: reached [\d.]+ people per run; [\d.]+ of them went to Forno Slice; arrivals there [\d.]+ → [\d.]+ \(/);
  });

  test('a measure with no fixed direction counts as helping only when the recommendation names the better direction', async () => {
    const { client } = fakeClient([
      turn(tool('test_change', { label: 'Pizza deal for takeout', why: 'Takeout grabbers spend the most.', patch: PIZZA_OFFER })),
      turn(finish({ recommendations: [{ experiment: 1, label: 'Pizza deal for takeout', why: 'Their spend moves.', kpi: 'group:takeout.avgSpent', confidence: 'high' }] }))
    ]);
    const res = await advise({ world: FOOD_HALL, client });
    assert.equal(res.experiments[0].segments.byGroup.find(s => s.id === 'takeout').fields.avgSpent.beyondSpread, true);
    assert.equal(res.recommendations[0].confidence, 'low');
    assert.equal(res.recommendations[0].holdsAcrossSeeds, false);
    assert.ok(res.cautions.some(c => /Pizza deal for takeout: takeout · avg spent moved .* but no better direction was given/.test(c)), res.cautions.join('\n'));
  });

  test('baseline runs passed in are used as they are, and their seeds become the test seeds', async () => {
    const spec = normalizeSpec(FOOD_HALL);
    const { runs } = await runSeeds({ spec, seeds: [7, 8], provider: makeProvider('rules') });
    const { client, calls } = fakeClient([turn(tool('test_change', { label: 'Two more baristas', why: 'The #1 bottleneck.', patch: COFFEE })), turn(finish())]);
    const steps = [];
    const res = await advise({ world: FOOD_HALL, client, runs, onStep: e => steps.push(e) });
    assert.ok(!steps.some(s => s.type === 'baseline'), 'no second baseline');
    assert.deepEqual(res.experiments[0].seeds, [7, 8]);
    assert.match(calls[0].messages[0].content, /seeds 7, 8 with the rules provider/);
    assert.ok(res.cautions.some(c => /Only 2 seeds were run/.test(c)));
    await assert.rejects(advise({ world: FOOD_HALL, client, runs, seeds: [1, 2] }), /do not match/);
  });

  test('with no key and no client it throws an error that explains the Claude Code path', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await assert.rejects(advise({ world: FOOD_HALL }), err => {
        assert.equal(err.code, 'NO_ANTHROPIC_KEY');
        assert.equal(err.message, NO_KEY_MESSAGE);
        assert.match(err.message, /\/advise/);
        assert.match(err.message, /Claude Code/);
        return true;
      });
      await assert.rejects(advise({ world: FOOD_HALL, apiKey: '   ' }), /\/advise/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  test('no key value appears in the transcript, the result, the steps or errors', async () => {
    const SECRET = 'sk-ant-test-0000-fictional-key-9f8e7d';
    const failing = { beta: { messages: { stream() { return { finalMessage: async () => { throw new Error(`401 invalid x-api-key: ${SECRET}`); } }; } } } };
    await assert.rejects(advise({ world: FOOD_HALL, client: failing, apiKey: SECRET }), err => {
      assert.ok(!err.message.includes(SECRET), err.message);
      assert.ok(!String(err.stack).includes(SECRET));
      assert.match(err.message, /\[redacted\]/);
      return true;
    });

    const steps = [];
    const { client, calls } = fakeClient([
      turn({ type: 'text', text: `Echoing a key by mistake: ${SECRET}` }, tool('test_change', { label: 'Two more baristas', why: 'The #1 bottleneck.', patch: COFFEE })),
      turn(finish({ answer: `Done. ${SECRET}` }))
    ]);
    const res = await advise({ world: FOOD_HALL, client, apiKey: SECRET, onStep: e => steps.push(e) });
    assert.ok(!JSON.stringify(res).includes(SECRET));
    assert.ok(!JSON.stringify(res.transcript).includes(SECRET));
    assert.ok(!JSON.stringify(steps).includes(SECRET));
    assert.ok(!JSON.stringify(calls.map(c => c.system)).includes(SECRET), 'the key is never sent as content');
  });
});

// ---------- the brief ----------

// A small hand-made world: fictional names and numbers only.
const CLINICS = {
  title: 'Pinecrest Clinic Row', question: 'Which clinic loses the most patients, and who overspends?', context: 'A weekday morning on Pinecrest Avenue.',
  mode: 'visit', duration: 240, clockStart: 480,
  arrivals: { total: 120, start: 0, end: 150, shape: 'peak' },
  nodes: [
    { id: 'door', name: 'Avenue entrance', kind: 'gate', x: 5, y: 50 },
    { id: 'er', name: 'Pinecrest ER', kind: 'service', x: 40, y: 30, servers: 2, serviceTime: 20, price: 900, tags: ['care'], about: 'Big hospital ER.' },
    { id: 'urgent', name: 'Maple Urgent Care', kind: 'service', x: 70, y: 70, servers: 2, serviceTime: 15, price: 150, tags: ['care'], about: 'Walk-in clinic.' }
  ],
  archetypes: [
    { id: 'parents', name: 'Parents with sick kids', share: 0.5, patience: 60, needs: ['care'], visits: 1 },
    { id: 'workers', name: 'Hourly workers', share: 0.5, patience: 40, needs: ['care'], visits: 1 }
  ],
  minds: [
    { id: 'ines', name: 'Ines Okafor', age: 38, archetype: 'parents', bio: 'Daughter has a fever.' },
    { id: 'walt', name: 'Walt Brennan', age: 52, archetype: 'workers', bio: 'Cut his hand at the shop.' }
  ],
  offers: [{ id: 'maple', text: 'Maple Urgent Care: seen in 20 minutes', to: { groups: ['workers'] }, place: 'urgent', priceOff: 0.2 }],
  provenance: { 'nodes.er.servers': 'assumed', 'nodes.er.price': 'data', 'arrivals.total': 'assumed' },
  assumptions: [{ key: 'erPrice', value: 900, why: 'typical self-pay visit in this fictional town' }, 'Patients pick one place per visit']
};

const segment = (id, name, group, over) => ({
  id, name, group, count: 30, avgWait: 20, avgSpent: 400, avgVisits: 1, walkAwaysPerPerson: 0.1, shareNeverServed: 0.1, avgFrustration: 1.5,
  topPlaces: [{ id: 'er', name: 'Pinecrest ER', visits: 20 }, { id: 'urgent', name: 'Maple Urgent Care', visits: 10 }], ...over
});

function clinicMetrics(seed, over = {}) {
  const lift = seed === 7 ? 0 : 0.02;
  return {
    mode: 'visit', spawned: 120, served: 100 - seed, abandoned: 20 + seed, abandonRate: 0.15 + lift, avgWait: 30 + seed,
    nodes: [
      { id: 'urgent', name: 'Maple Urgent Care', score: 300, waitMinutes: 300, abandoned: 2, arrivals: 50, served: 48, avgWait: 6, maxQueue: 4, utilization: 0.7, servers: 2, serviceTime: 15 },
      { id: 'er', name: 'Pinecrest ER', score: 2400, waitMinutes: 1800, abandoned: 20, arrivals: 70, served: 50, avgWait: 26, maxQueue: 18, utilization: 0.98, servers: 2, serviceTime: 20 }
    ],
    archetypes: [],
    segments: {
      byGroup: [segment('parents', 'Parents with sick kids', 'parents', { avgSpent: 700 }), segment('workers', 'Hourly workers', 'workers', { avgWait: 35, walkAwaysPerPerson: 0.4 })],
      byCast: [segment('ines', 'Ines Okafor', 'parents', { avgSpent: 820 }), segment('walt', 'Walt Brennan', 'workers', { avgWait: 41, walkAwaysPerPerson: 0.5, avgSpent: 120 })]
    },
    offers: [{ id: 'maple', reached: 40, wentToPlace: 25 }],
    doors: [{ id: 'front', name: 'Front doors', crossings: 240 + seed, peakPer5Min: 12, peakClock: '09:10' }],
    walls: { count: 14, checkedMoves: 5000, violations: 0 },
    remarks: { total: 3, byKind: { long_line: 3 } },
    decisions: { total: 4, byProvider: { jev: 4 }, byKind: { choose: 4 } },
    frustration: { avg: 1.6, byArchetype: {} },
    ...over
  };
}

const OPTIONS = [{ key: 'er', label: 'Go to Pinecrest ER' }, { key: 'urgent', label: 'Go to Maple Urgent Care' }, { key: 'leave', label: 'Leave and go home' }];
const decisionLine = (id, agentId, probs) => ({
  id, t: 10, clock: '08:10', agentId, personaId: agentId ? 'walt' : 'ines', kind: 'choose', why: 'start', placeId: null, options: OPTIONS,
  asks: { choice: 'next_place', yesNo: null, frustration: false, tellOthers: false },
  observation: { now: 'Just arrived. Choosing where to go first.' }, auto: { action: 'er' },
  decision: { provider: 'jev', choiceProbs: probs }, applied: { action: 'er', summary: 'went to Pinecrest ER' }
});
const CLINIC_REMARKS = [
  { t: 30, agentId: 1, kind: 'long_line', placeId: 'er' },
  { t: 40, agentId: 0, kind: 'long_line', placeId: 'er' },
  { t: 50, agentId: 1, kind: 'good_experience', placeId: 'urgent' }
];
const CLINIC_AGENTS = [
  { id: 0, personaId: 'ines', personaName: 'Ines Okafor', archetypeId: 'parents', informed: true, served: 1, waitTotal: 30, abandons: 0, frustration: 1, born: 5, done: 60, spent: [900], visits: ['er'], trace: [{ t: 5, m: 'arrived' }] },
  { id: 1, personaId: 'walt', personaName: 'Walt Brennan', archetypeId: 'workers', informed: false, served: 0, waitTotal: 45, abandons: 1, frustration: 3, born: 8, done: 70, spent: 0, visits: [], trace: [] }
];

describe('buildBrief', () => {
  let root;
  let brief;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'swarm-advisor-'));
    // Seed 8 is a recorded run on disk; seed 7 is kept in memory. The brief reads both.
    const dir = join(root, 'clinic-s8');
    mkdirSync(dir);
    const put = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value));
    put('meta.json', { runId: 'clinic-s8', seed: 8, status: 'done' });
    put('metrics.json', clinicMetrics(8));
    put('agents.json', CLINIC_AGENTS);
    put('remarks.json', CLINIC_REMARKS);
    writeFileSync(join(dir, 'decisions.jsonl'), [decisionLine('d1', 1, { er: 0.48, urgent: 0.44, leave: 0.08 })].map(d => JSON.stringify(d)).join('\n') + '\n');
    const runs = [
      { seed: 7, runId: 'clinic-s7', metrics: clinicMetrics(7), agents: CLINIC_AGENTS, remarks: CLINIC_REMARKS,
        decisions: [decisionLine('d1', 0, { er: 0.5, urgent: 0.45, leave: 0.05 }), decisionLine('d2', 1, { er: 0.9, urgent: 0.05, leave: 0.05 })] },
      { runDir: dir }
    ];
    brief = buildBrief({ world: CLINICS, runs, provider: 'jev' });
  });
  after(() => { rmSync(root, { recursive: true, force: true }); });

  test('includes every section', () => {
    const md = brief.markdown;
    for (const heading of [
      '# Brief: Pinecrest Clinic Row', '## Headline KPIs (mean ± sd across 2 seeds)', '## Bottlenecks', '## Busiest doorways',
      '## Who (segments)', '### Who had the worst time', '### Who spent the most', '## What people said', '## Most torn decisions',
      '## Walls and decision quality', '## Assumptions and provenance', '## Offers in the world', '## Levers test_change can set'
    ]) assert.ok(md.includes(heading), `missing ${heading}`);
    assert.ok(md.includes(SEGMENT_NOTE));
    assert.match(md, /\*\*Question:\*\* Which clinic loses the most patients, and who overspends\?/);
    assert.match(md, /\*\*Setting:\*\* A weekday morning on Pinecrest Avenue\./);
  });

  test('KPIs are the mean and spread across the runs\' seeds', () => {
    const ab = brief.data.kpis.abandonRate;
    assert.equal(ab.bySeed.length, 2);
    assert.ok(Math.abs(ab.bySeed[0] - 0.15) < 1e-12 && Math.abs(ab.bySeed[1] - 0.17) < 1e-12);
    assert.ok(Math.abs(ab.mean - 0.16) < 1e-12);
    assert.ok(Math.abs(ab.sd - Math.sqrt(0.0002)) < 1e-12);
    assert.match(brief.markdown, /\| abandon rate \| 16\.0% ± 1\.4% \| 15\.0%–17\.0% \| 15\.0%, 17\.0% \|/);
  });

  test('bottlenecks are ranked, with how often each was #1', () => {
    assert.equal(brief.data.bottlenecks[0].id, 'er');
    assert.equal(brief.data.bottlenecks[0].firstOn, 2);
    assert.match(brief.markdown, /\| 1 \| er \| Pinecrest ER \| 2,400 \| 2\/2 \|/);
  });

  test('segments: worst off and top spenders, with ids', () => {
    const s = brief.data.segments;
    assert.equal(s.worstOff[0].id, 'walt');
    assert.equal(s.topSpenders[0].id, 'ines');
    assert.match(brief.markdown, /\| cast \| ines \| Ines Okafor \| parents \| 30 \| \$820\.00 \|/);
  });

  test('remarks by place and kind come from memory and from the run folder', () => {
    assert.equal(brief.data.remarks.total, 6);
    assert.equal(brief.data.remarks.byPlace[0].id, 'er');
    assert.match(brief.markdown, /6 remarks: long_line 4 · good_experience 2\./);
  });

  test('torn decisions come from both runs, closest call first', () => {
    assert.equal(brief.data.torn.scored, 3);
    assert.equal(brief.data.torn.torn, 2);
    // The recorded run's call (48% vs 44%) is closer than the in-memory one (50% vs 45%); its id comes from meta.json.
    assert.deepEqual(brief.data.torn.top.map(t => t.runId), ['clinic-s8', 'clinic-s7']);
    assert.match(brief.markdown, /Pinecrest ER 48% · Maple Urgent Care 44%/);
    assert.match(brief.markdown, /Pinecrest ER 50% · Maple Urgent Care 45%/);
    assert.deepEqual(brief.data.runs.map(r => [r.seed, r.runId]), [[7, 'clinic-s7'], [8, 'clinic-s8']]);
  });

  test('doorways, walls, assumptions, provenance and offers', () => {
    assert.match(brief.markdown, /\| front \| Front doors \| 248 \| 12 \|/);
    assert.match(brief.markdown, /Walls: 14 walls, 10,000 moves checked, 0 violations\./);
    assert.match(brief.markdown, /Provenance of world numbers: assumed 2 · data 1\./);
    assert.match(brief.markdown, /Assumed \(2\): nodes\.er\.servers, arrivals\.total\./);
    assert.match(brief.markdown, /erPrice = 900 \(typical self-pay visit/);
    assert.match(brief.markdown, /Patients pick one place per visit/);
    assert.match(brief.markdown, /- maple: "Maple Urgent Care: seen in 20 minutes" .* reached 40, went to the place 25 per run/);
  });

  test('levers list every patchable field with its current value, and the offer op with ids', () => {
    const L = brief.data.levers;
    assert.deepEqual(L.node.find(n => n.id === 'er').values, { servers: 2, serviceTime: 20, appeal: 0.5, price: 900 });
    assert.deepEqual(Object.keys(L.node.find(n => n.id === 'door').values), ['weight']);
    assert.deepEqual(L.archetype.find(a => a.id === 'workers').values, { info: 0.5, patience: 40, rationality: 2.5, visits: 1, share: 0.5 });
    assert.deepEqual(Object.keys(L.global), ['arrivals.total', 'arrivals.start', 'arrivals.end', 'travelSpeed']);
    assert.deepEqual(L.offer, { groups: ['parents', 'workers'], cast: ['ines', 'walt'], places: ['er', 'urgent'] });
    const md = brief.markdown;
    assert.match(md, /\| er \| Pinecrest ER \| service \| 2 \| 20 \| 0\.5 \| 900 \| – \|/);
    assert.match(md, /Global \(kind "global"\): arrivals\.total = 120/);
    assert.match(md, /"kind": "offer"/);
    assert.match(md, /Group ids: parents, workers/);
    assert.match(md, /Cast ids: ines, walt/);
  });

  test('stays compact', () => {
    assert.ok(brief.markdown.length < 24000, `${brief.markdown.length} characters`);
  });

  test('tolerates older runs without segments, offers or per-person files', () => {
    const old = clinicMetrics(7);
    delete old.segments;
    delete old.offers;
    delete old.doors;
    delete old.walls;
    const b = buildBrief({ world: CLINICS, runs: [{ seed: 7, metrics: old }] });
    assert.match(b.markdown, /did not record segment outcomes/);
    assert.match(b.markdown, /No remarks were posted/);
    assert.match(b.markdown, /None: these decisions carry no probabilities/);
    assert.equal(b.data.segments, null);
    assert.equal(b.data.provider, 'jev');
  });

  test('route worlds list links as levers, with closed', async () => {
    const roads = readJson('../worlds/rush-hour-roads.json');
    const { runs } = await runSeeds({ spec: normalizeSpec(roads), seeds: [7], provider: makeProvider('rules') });
    const b = buildBrief({ world: roads, runs });
    assert.match(b.markdown, /## Bottlenecks \(mean score = delay minutes\)/);
    assert.match(b.markdown, /### Links \(kind "edge"; closed 1 closes it\)/);
    assert.ok(b.data.levers.edge.length > 0 && b.data.levers.edge.every(e => e.values.closed === 0 && 'capacity' in e.values));
    assert.equal(b.data.levers.node.length, 0);
  });

  test('spentOf reads a total or a list of prices', () => {
    assert.equal(spentOf({ spent: 12.5 }), 12.5);
    assert.equal(spentOf({ spent: [6, 13] }), 19);
    assert.equal(spentOf({ spent: [{ price: 6 }, { place: 'x', price: 4 }] }), 10);
    assert.equal(spentOf({}), null);
  });
});

// ---------- saving ----------

describe('writeAdvice', () => {
  let root;
  let result;
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'swarm-advice-'));
    const { client } = fakeClient([
      turn(tool('test_change', { label: 'Two more baristas', why: 'The #1 bottleneck.', patch: COFFEE })),
      turn(finish())
    ]);
    result = await advise({ world: FOOD_HALL, client });
  });
  after(() => { rmSync(root, { recursive: true, force: true }); });

  test('writes advice.json and advice.md', () => {
    const dir = join(root, 'run-a');
    const { json, md } = writeAdvice(dir, result);
    assert.equal(json, join(dir, 'advice.json'));
    assert.equal(md, join(dir, 'advice.md'));
    assert.deepEqual(JSON.parse(readFileSync(json, 'utf8')), result);
    assert.equal(readFileSync(md, 'utf8'), adviceMarkdown(result));
  });

  test('advice.md puts the answer first, then ranked changes with measured effects, cautions, untested, next steps', () => {
    const md = adviceMarkdown(result);
    assert.ok(md.startsWith('# Advice: Lunch rush at Foundry Hall\n'));
    const order = ['## Answer', '## Recommended changes', '## Cautions', '## What could not be tested', '## Next steps'].map(h => md.indexOf(h));
    assert.ok(order.every(i => i > 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(md, /\| # \| Change \| Measured effect \(before → after\) \| Holds across seeds \| Tested with \| Confidence \|/);
    const e = result.experiments[0].kpis.abandonRate;
    const pct = v => `${(v * 100).toFixed(1)}%`;
    assert.ok(md.includes(`abandon rate ${pct(e.before)} → ${pct(e.after)} (-${(Math.abs(e.change) * 100).toFixed(1)} pts; spread ${(e.spread * 100).toFixed(1)} pts)`), md);
    assert.match(md, /\| 1 \| Two more baristas \(experiment #1\) \|/);
    assert.match(md, /Changes: Ember Coffee kiosk · servers 2 → 4\./);
    assert.match(md, /Cost: Two part-time staff at lunch\./);
    const untested = md.slice(md.indexOf('## What could not be tested'), md.indexOf('## Next steps'));
    assert.match(untested, /- Moving the kiosk: there is no lever for position\./);
    assert.doesNotMatch(untested, /Could not test:/);
    const cautions = md.slice(md.indexOf('## Cautions'), md.indexOf('## What could not be tested'));
    assert.match(cautions, /Arrival numbers are assumed\./);
    assert.doesNotMatch(cautions, /Moving the kiosk/);
    assert.match(md, /## Every experiment/);
  });

  test('advice with no recommendations says so', () => {
    const md = adviceMarkdown({ ...result, recommendations: [] });
    assert.match(md, /No tested change is recommended\./);
  });
});

// ---------- the CLI ----------

describe('swarm advise', () => {
  const CLI = join(REPO, 'bin', 'swarm.js');
  let cwd;
  before(() => { cwd = mkdtempSync(join(tmpdir(), 'swarm-advise-cli-')); });
  after(() => { rmSync(cwd, { recursive: true, force: true }); });

  // Runs from an empty folder, so no .env.local supplies a key, with ANTHROPIC_API_KEY removed.
  const runCli = args => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    return spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
  };

  test('with no key it prints the Claude Code path and exits non-zero', () => {
    const r = runCli(['advise', 'food-hall-lunch', '--question', 'Who walks away most?']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /swarm advise needs ANTHROPIC_API_KEY/);
    assert.match(r.stderr, /\/advise food-hall-lunch "Who walks away most\?"/);
    assert.match(r.stderr, /Claude Code/);
    assert.equal(r.stdout, '');
    assert.ok(!existsSync(join(cwd, 'runs')), 'nothing ran');
  });

  test('--help lists advise and its flags', () => {
    const r = runCli(['--help']);
    assert.equal(r.status, 0);
    for (const s of ['advise <world>', '--confirm-with jev', '--max-experiments N', '--follow-up', 'claude-fable-5-2']) {
      assert.ok(r.stdout.includes(s), `help is missing ${s}`);
    }
  });

  test('rejects flags it does not take', () => {
    const r = runCli(['advise', 'food-hall-lunch', '--patch', 'x.json']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /does not take --patch/);
  });
});
