// The scope display's verdict (docs/PROTOTYPE.md §9b): which run opens, which test belongs to it, the one
// change, and the words on screen: the worst line, the verdict, the range across seeds, the "why" sentence,
// the grouped feed and the timeline ticks. All pure functions; the data is fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseRun, findTest, staffChange, applyChange, worstLineWords, range, rangeWords, testResult, cellWords,
  verdictWords, whySentence, busiestWindow, providerWords, placeName, runLabel, changeWords, windowWords,
  changeFor, promotionChange, promotionWords, testWords, windowNoun, findOfferTest, hasPromotion
} from '../web/scope/lib/verdict.js';
import { groupFeed } from '../web/scope/lib/incidents.js';
import { timeTicks } from '../web/scope/lib/timeline.js';

const STAFF = { kind: 'staff', nodeId: 'cafe', nodeName: 'Cafe', from: 1, to: 2 };
const meta = (runId, createdAt, extra = {}) => ({ runId, createdAt, status: 'done', provider: 'rules', seed: 7, specHash: 'aaa', ...extra });
const linked = (runId, createdAt, test, role, seed, extra = {}) =>
  meta(runId, createdAt, { seed, specHash: role === 'change' ? 'bbb' : 'aaa', link: { test, role, base: role === 'change' ? `${test}-b${seed}` : null, change: STAFF }, ...extra });
// One finished test: baseline and change on seeds 7, 8, 9, started in that order.
const testRuns = (id, minute) => [7, 8, 9].flatMap((seed, k) => [
  linked(`${id}-b${seed}`, `2026-11-14T10:${minute}:${10 + k * 2}Z`, id, 'baseline', seed),
  linked(`${id}-c${seed}`, `2026-11-14T10:${minute}:${11 + k * 2}Z`, id, 'change', seed)
]);

// ---------- which run opens ----------

test('the page opens the latest Jev run if there is one, otherwise the latest rule-model run', () => {
  const rules = [{ meta: meta('r-old', '2026-11-14T08:00:00Z') }, { meta: meta('r-new', '2026-11-14T09:00:00Z') }];
  assert.equal(chooseRun(rules).meta.runId, 'r-new');
  const jevOld = { meta: meta('j-old', '2026-11-14T06:00:00Z', { provider: 'jev' }) };
  const jevNew = { meta: meta('j-new', '2026-11-14T07:00:00Z', { provider: 'rules', providerStats: { provider: 'jev' } }) };
  assert.equal(chooseRun([...rules, jevOld, jevNew]).meta.runId, 'j-new', 'a Jev run wins even when a rules run is newer');
  assert.equal(chooseRun([{ meta: meta('rp', '2026-11-14T05:00:00Z', { provider: 'replay' }) }, ...rules]).meta.runId, 'rp', 'a replay of a Jev run counts as Jev');
  assert.equal(chooseRun([]), null);
  assert.equal(chooseRun(undefined), null);
});

test('a run that carries the tested change is never the opening run; its baseline is', () => {
  const runs = testRuns('t1', '00').map(m => ({ meta: m }));
  assert.equal(chooseRun(runs).meta.runId, 't1-b9', 'the newest run is t1-c9, but it carries the change');
  // Only change runs left (the baselines were deleted): still open something.
  assert.equal(chooseRun(runs.filter(r => r.meta.link.role === 'change')).meta.runId, 't1-c9');
});

// ---------- which test belongs to the run on screen ----------

test('a test belongs to its own runs and to any run of the same world', () => {
  const metas = [meta('plain', '2026-11-14T09:00:00Z'), ...testRuns('t1', '00')];
  const expected = { id: 't1', change: STAFF, pairs: [7, 8, 9].map(seed => ({ seed, baseline: `t1-b${seed}`, change: `t1-c${seed}` })) };
  assert.deepEqual(findTest(metas, { runId: 't1-c8', specHash: 'bbb' }), expected, 'the change run finds its test by run id');
  assert.deepEqual(findTest(metas, { runId: 'plain', specHash: 'aaa' }), expected, 'another run of the same world finds it by spec hash');
  assert.equal(findTest(metas, { runId: 'other', specHash: 'zzz' }), null, 'a run of another world has no test');
  assert.equal(findTest([], { runId: 'plain', specHash: 'aaa' }), null);
});

test('a test counts only when every seed has both sides done; the newest finished test wins', () => {
  const half = testRuns('t2', '30').filter(m => m.runId !== 't2-c9');
  assert.equal(findTest(half, { runId: 't2-b7', specHash: 'aaa' }), null, 'two finished pairs out of three is not a test');
  assert.equal(findTest(half, { runId: 't2-b7', specHash: 'aaa' }, 2).pairs.length, 2);
  const failed = testRuns('t3', '40').map(m => (m.runId === 't3-c8' ? { ...m, status: 'error' } : m));
  assert.equal(findTest(failed, { runId: 't3-b7', specHash: 'aaa' }), null, 'a failed run is not a side');
  const both = [...testRuns('t1', '00'), ...testRuns('t4', '50'), ...half];
  assert.equal(findTest(both, { runId: 'plain', specHash: 'aaa' }).id, 't4');
  assert.equal(findTest(both, { runId: 't1-b7', specHash: 'aaa' }).id, 't4', 'same world: the newest test, even from an older test\'s run');
});

// ---------- the one change ----------

const SPEC = { title: 'Weekday lunch on the ground floor: food hall and market (proposed fit-out)', nodes: [
  { id: 'door', name: 'Door', kind: 'gate' },
  { id: 'deli', name: 'Deli', kind: 'service', servers: 2, serviceTime: 3 },
  { id: 'cafe', name: 'Cafe', kind: 'service', servers: 1, serviceTime: 4 }
] };
const METRICS = { abandoned: 30, abandonRate: 0.25, avgWait: 6, served: 90, nodes: [
  { id: 'deli', score: 100, abandoned: 5, avgWait: 3, maxQueue: 4 }, { id: 'cafe', score: 900, abandoned: 25, avgWait: 9.46, maxQueue: 12 }
] };

test('the change is one more staff at the place with the worst bottleneck score', () => {
  assert.deepEqual(staffChange(SPEC, METRICS), { kind: 'staff', nodeId: 'cafe', nodeName: 'Cafe', from: 1, to: 2 });
  // No metrics: the first place with a line. No places: no change to test.
  assert.equal(staffChange(SPEC, null).nodeId, 'deli');
  assert.equal(staffChange({ nodes: [SPEC.nodes[0]] }, METRICS), null);
  // The sample data keeps its per-place numbers under `bottlenecks`.
  assert.equal(staffChange(SPEC, { bottlenecks: METRICS.nodes }).nodeId, 'cafe');
});

test('applying the change sets the engine\'s `servers` on that place only, on a copy', () => {
  const out = applyChange(SPEC, staffChange(SPEC, METRICS));
  assert.equal(out.nodes[2].servers, 2);
  assert.equal(SPEC.nodes[2].servers, 1);
  assert.deepEqual(out.nodes.slice(0, 2), SPEC.nodes.slice(0, 2));
  assert.throws(() => applyChange({ nodes: [] }, STAFF), /no place "cafe"/);
});

// ---------- words ----------

test('the place gets a name people would say, not the listing name', () => {
  assert.equal(placeName(SPEC), 'Food hall and market');
  assert.equal(placeName({ title: 'Harbor Lights Park' }), 'Harbor Lights Park');
  assert.equal(placeName({ title: 'Lunch: (draft)' }), 'Lunch: (draft)', 'nothing left after the colon: keep the title');
  assert.equal(placeName({ placeName: ' Lucky Noodle Bar ', title: 'x: y' }), 'Lucky Noodle Bar');
  assert.equal(placeName({}), 'This place');
});

test('runs are named by who decided and by their side of a test, with no "server" or "seed"', () => {
  assert.equal(providerWords({ provider: 'rules' }), 'Rule model');
  assert.equal(providerWords({ provider: 'jev', model: 'jev-1.14.0' }), 'Jev');
  assert.equal(providerWords({ provider: 'rules', providerStats: { provider: 'replay' } }), 'Jev');
  assert.equal(providerWords({ provider: 'mock' }), 'Sample data');
  assert.equal(changeWords(STAFF), '+1 staff');
  assert.equal(runLabel({ link: { role: 'baseline', change: STAFF } }), 'Baseline');
  assert.equal(runLabel({ link: { role: 'change', change: STAFF } }), '+1 staff at Cafe');
  assert.equal(runLabel({ link: null }), '');
  assert.equal(runLabel({}), '');
});

test('the worst line is said in words, with the reason', () => {
  const lunch = { clockStart: 690, duration: 135 };
  assert.deepEqual(worstLineWords(SPEC, METRICS, lunch), {
    nodeId: 'cafe',
    headline: 'Cafe loses the most people: 25 walked away over lunch.',
    why: 'It has 1 staff at the counter, and an order takes about 4 min. The line reached 12 people.'
  });
  // The worst score is not always the place that loses the most people; the sentence must stay true.
  const other = { nodes: [{ id: 'deli', score: 100, abandoned: 30, avgWait: 3 }, { id: 'cafe', score: 900, abandoned: 25, avgWait: 9.46, maxQueue: 1 }] };
  const w = worstLineWords(SPEC, other, lunch);
  assert.equal(w.headline, 'Cafe has the worst line: 25 walked away over lunch, and the wait averaged 9.5 min.');
  assert.match(w.why, /The line reached 1 person\.$/);
  const calm = { nodes: [{ id: 'cafe', score: 40, abandoned: 0, avgWait: 2.25, maxQueue: 0 }] };
  assert.equal(worstLineWords(SPEC, calm, { clockStart: 480, duration: 60 }).headline,
    'Cafe has the longest waits: 2.3 min on average from 8:00 am to 9:00 am. Nobody walked away.');
  assert.equal(worstLineWords({ nodes: [] }, METRICS, lunch), null);
  assert.equal(windowWords(690, 135), 'over lunch');
  assert.equal(windowWords(undefined, undefined), 'in this run');
});

test('a range across seeds reads as "12 to 16", one number, or "up to 5"', () => {
  assert.deepEqual(range([14, 12, 16]), { min: 12, max: 16 });
  assert.deepEqual(range([3]), { min: 3, max: 3 });
  assert.equal(range([]), null);
  assert.equal(range([NaN, undefined]), null);
  assert.equal(rangeWords(12, 16), '12 to 16');
  assert.equal(rangeWords(14, 14), '14');
  assert.equal(rangeWords(13.6, 14.4), '14', 'rounded before comparing');
  assert.equal(rangeWords(0, 5), 'up to 5');
});

// Each seed's two runs. Walk-aways at the cafe: 25 → 11, 30 → 14, 22 → 10 (14, 16 and 12 fewer).
const side = (lost, line, wait, floor) => ({ abandoned: floor, nodes: [{ id: 'cafe', abandoned: lost, maxQueue: line, avgWait: wait }, { id: 'deli', abandoned: 5, maxQueue: 4, avgWait: 3 }] });
const PAIRS = [
  { before: side(25, 12, 9.4, 60), after: side(11, 7, 5.1, 50) },
  { before: side(30, 13, 9.9, 66), after: side(14, 8, 5.6, 52) },
  { before: side(22, 11, 8.9, 54), after: side(10, 6, 4.9, 45) }
];

test('the test result is the fewer walk-aways per seed and a table of averages', () => {
  const r = testResult(PAIRS, STAFF);
  assert.equal(r.runs, 3);
  assert.deepEqual(r.kept, [14, 16, 12]);
  assert.deepEqual(r.rows.map(x => [x.label, cellWords(x.kind, x.before), cellWords(x.kind, x.after), cellWords(x.kind, x.change, true)]), [
    ['Walked away here', '26', '12', '−14'],
    ['Longest line here', '12', '7', '−5'],
    ['Average wait here', '9.4 min', '5.2 min', '−4.2 min'],
    ['Walked away, whole floor', '60', '49', '−11']
  ]);
  // The change is taken from the rounded numbers on screen: 11.3 → 14.7 reads 11, 15 and +4, never +3.
  const odd = testResult([{ before: side(1, 11, 1, 1), after: side(1, 15, 1, 1) }, { before: side(1, 11, 1, 1), after: side(1, 15, 1, 1) }, { before: side(1, 12, 1, 1), after: side(1, 14, 1, 1) }], STAFF).rows[1];
  assert.deepEqual([odd.before, odd.after, odd.change], [11, 15, 4]);
  // A pair with a missing side is left out, not counted as zero.
  assert.equal(testResult([...PAIRS, { before: side(1, 1, 1, 1), after: null }], STAFF).runs, 3);
  assert.equal(cellWords('count', 0, true), 'no change');
  assert.equal(cellWords('minutes', 1.24, true), '+1.2 min');
  assert.equal(cellWords('count', null), 'n/a');
  assert.equal(cellWords('count', 1234.4), '1,234');
});

test('the verdict says whether the change helped, in customers kept, with the range across seeds', () => {
  const lunch = { clockStart: 690, duration: 135 };
  assert.deepEqual(verdictWords(testResult(PAIRS, STAFF), STAFF, lunch), {
    tone: 'helped', headline: '+1 staff kept 12 to 16 more customers.',
    detail: '12 to 16 fewer walk-aways at Cafe over lunch. Tested with the rule model, 3 runs each way.'
  });
  const v = kept => verdictWords({ runs: kept.length, kept }, STAFF, lunch);
  assert.equal(v([1, 1, 1]).headline, '+1 staff kept 1 more customer.');
  assert.deepEqual([v([0, 3, 5]).tone, v([0, 3, 5]).headline], ['helped', '+1 staff kept up to 5 more customers.']);
  assert.match(v([0, 3, 5]).detail, /^Up to 5 fewer walk-aways at Cafe over lunch\./);
  assert.deepEqual([v([0, 0, 0]).tone, v([0, 0, 0]).headline], ['none', '+1 staff changed nothing.']);
  assert.deepEqual([v([-2, -4, -3]).tone, v([-2, -4, -3]).headline], ['worse', '+1 staff did not help.']);
  assert.match(v([-2, -4, -3]).detail, /^2 to 4 more walk-aways at Cafe over lunch\./);
  assert.deepEqual([v([-3, 2, 5]).tone, v([-3, 2, 5]).headline], ['mixed', '+1 staff made no clear difference.']);
  assert.match(v([-3, 2, 5]).detail, /^Between 3 more and 5 fewer walk-aways at Cafe over lunch: the runs disagree\./);
  assert.match(v([4]).detail, /1 run each way\.$/);
  assert.equal(v([]).tone, 'none');
});

test('the "why" sentence gives the cause from the two sides, and when the line is busiest', () => {
  const r = testResult(PAIRS, STAFF);
  assert.equal(whySentence(r, STAFF, { clockStart: 690, window: { start: 40, end: 70 } }),
    'The longest line at Cafe fell from 12 people to 7, so fewer people saw a long line and left. It is busiest from 12:10 to 12:40 pm.');
  assert.match(whySentence(r, STAFF, { clockStart: 690, window: { start: 10, end: 40 } }), /It is busiest from 11:40 am to 12:10 pm\.$/);
  assert.equal(whySentence(r, STAFF), 'The longest line at Cafe fell from 12 people to 7, so fewer people saw a long line and left.');
  // Helped, but the longest line did not get shorter: the wait did.
  const faster = testResult([{ before: side(20, 9, 8, 40), after: side(12, 9, 5, 33) }], STAFF);
  assert.equal(whySentence(faster, STAFF), 'The line at Cafe moved faster: the average wait fell from 8 min to 5 min, so fewer people gave up.');
  // Did not help: say what the line did, and claim no cause.
  const same = testResult([{ before: side(20, 9, 8, 40), after: side(20, 9, 8, 40) }], STAFF);
  assert.equal(whySentence(same, STAFF), 'The line at Cafe did not get shorter: 9 people at its longest before, 9 after.');
  const shorter = testResult([{ before: side(20, 9, 8, 40), after: side(21, 6, 8, 41) }], STAFF);
  assert.equal(whySentence(shorter, STAFF), 'The longest line at Cafe fell from 9 people to 6, but about as many people still walked away.');
  assert.equal(whySentence({ kept: [], rows: [] }, STAFF), 'The test has no line lengths for Cafe.');
});

test('the busiest window is the half hour with the longest line on average, on round five minutes', () => {
  const times = Array.from({ length: 121 }, (_, i) => i);            // one frame a minute for two hours
  const counts = times.map(t => (t >= 41 && t <= 69 ? 10 : 1));
  assert.deepEqual(busiestWindow(times, counts), { start: 40, end: 70 });
  assert.equal(busiestWindow(times, times.map(() => 0)), null, 'no line, no busiest window');
  assert.equal(busiestWindow([], []), null);
  assert.deepEqual(busiestWindow([0, 1, 2], [0, 4, 0], 30), { start: 0, end: 5 }, 'a window is never empty');
});

// ---------- the feed ----------

test('the feed merges repeats into one row with a count, newest first', () => {
  const walk = (t, id) => ({ id, t, cat: 'decision', kind: 'walked_away', short: 'Walked away at Cafe', text: 'Walked away from the line at Cafe', clock: `c${t}` });
  const incidents = [
    walk(1, 'a'), { id: 'b', t: 2, cat: 'congestion', kind: 'crowd', group: 'Crowding near Deli', text: 'Crowd of 8 in a 2 m square near Deli for 2 minutes' },
    walk(3, 'c'), { id: 'd', t: 4, cat: 'decision', kind: 'gave_up', short: 'Gave up waiting at Cafe', text: 'Gave up waiting at Cafe' },
    { id: 'e', t: 5, cat: 'complaint', kind: 'long_line', short: 'Warned others about the line at Cafe', text: 'Maya warned others about the line at Cafe' },
    walk(6, 'f'), walk(50, 'later')
  ];
  const rows = groupFeed(incidents, 10);
  assert.deepEqual(rows.map(r => [r.text, r.count, r.latest.id]), [
    ['Walked away at Cafe', 3, 'f'],
    ['Maya warned others about the line at Cafe', 1, 'e'],          // a single incident keeps its own words
    ['Gave up waiting at Cafe', 1, 'd'],
    ['Crowd of 8 in a 2 m square near Deli for 2 minutes', 1, 'b']
  ]);
  assert.equal(groupFeed(incidents, 0.5).length, 0, 'nothing has happened yet');
  assert.deepEqual(groupFeed(incidents, 10, { decision: false, congestion: true, complaint: true }).map(r => r.latest.id), ['e', 'b']);
  assert.equal(groupFeed(incidents, 10, null, 2).length, 2);
  assert.equal(groupFeed(incidents, 60)[0].count, 4);
});

// ---------- the timeline ----------

test('time ticks sit on round clock minutes and thin out when there is no room', () => {
  // 11:30 am for 135 minutes.
  assert.deepEqual(timeTicks(690, 135, 10).map(t => `${t.t}=${t.label}`),
    ['0=11:30', '15=11:45', '30=12:00', '45=12:15', '60=12:30', '75=12:45', '90=1:00', '105=1:15', '120=1:30', '135=1:45']);
  assert.deepEqual(timeTicks(690, 135, 5).map(t => t.label), ['11:30', '12:00', '12:30', '1:00', '1:30']);
  assert.deepEqual(timeTicks(705, 90, 8).map(t => t.t), [0, 15, 30, 45, 60, 75, 90]);
  assert.deepEqual(timeTicks(700, 30, 8).map(t => `${t.t}=${t.label}`), ['5=11:45', '20=12:00']);
  assert.deepEqual(timeTicks(0, 0), []);
});

// ---------- the sushi restaurant's change: a promotion (§18) ----------

const SUSHI = { title: 'Friday dinner', nodes: [
  { id: 'door', name: 'Street door', kind: 'gate' },
  { id: 'counter', name: 'Counter seats', kind: 'service', servers: 4, seats: [[1, 1], [1, 2], [1, 3], [1, 4]] },
  { id: 'table', name: 'Table', kind: 'service', servers: 4, seats: [[5, 1], [6, 1], [5, 2], [6, 2]] }
], offers: [{ id: 'other', text: 'Free tea' }] };
const PROMO = promotionChange();
const dinner = { clockStart: 1080, duration: 150 };

test('a place that asks for it tests a promotion, not +1 staff; its seats are one staff each', () => {
  assert.deepEqual(changeFor({ suggestion: 'promotion' }, SUSHI, null), { kind: 'promotion', off: 0.2 });
  assert.equal(changeFor({}, SUSHI, null).kind, 'staff');
  assert.equal(changeFor(null, SPEC, METRICS).nodeId, 'cafe');
  assert.equal(changeFor({ suggestion: 'promotion' }, { nodes: [SUSHI.nodes[0]] }, null), null);
  // The promotion is three offers: the message for everyone and the discount at each place. Other offers stay.
  const out = applyChange(SUSHI, PROMO);
  assert.deepEqual(out.offers.map(o => [o.id, o.place ?? null, o.priceOff ?? 0]),
    [['other', null, 0], ['promotion', null, 0], ['promotion_counter', 'counter', 0.2], ['promotion_table', 'table', 0.2]]);
  assert.equal(out.offers[1].text, 'Promotion today: 20% off everything for everyone who comes in.');
  assert.equal(SUSHI.offers.length, 1, 'the input is not changed');
  assert.equal(applyChange(out, PROMO).offers.length, 4, 'applying it twice does not add it twice');
  assert.equal(changeWords(PROMO), 'The promotion');
  assert.equal(runLabel({ link: { role: 'change', change: PROMO } }), 'Promotion, 20% off');
  assert.equal(runLabel({ link: { role: 'baseline', change: PROMO } }), 'Baseline');
});

// The recorded Jev run: 22 meals finished by 8:30 pm, but 24 people got a seat (two were still eating).
const RECORDED = { spawned: 36, served: 22, avgWait: 9.625, nodes: [
  { id: 'table', arrivals: 20, abandoned: 10, queueNow: 0, served: 10 }, { id: 'counter', arrivals: 22, abandoned: 8, queueNow: 0, served: 12 }
] };

test('before the promotion test: who did not get a seat, and why', () => {
  assert.deepEqual(promotionWords(SUSHI, RECORDED, PROMO, dinner), {
    headline: '12 of 36 people did not get a seat from 6:00 pm to 8:30 pm.',
    why: 'The room has 8 seats, and the wait for one averaged 9.6 min.',
    offer: 'Try a promotion: 20% off everything today, told to everyone who comes in. It gives people a reason to wait, but adds no seats.'
  });
  assert.equal(promotionWords(SUSHI, { spawned: 10, served: 10, avgWait: 1 }, PROMO, dinner).headline, 'All 10 people got a seat from 6:00 pm to 8:30 pm.');
  assert.equal(promotionWords(SUSHI, {}, PROMO, dinner), null);
  assert.equal(windowNoun(1080, 150), 'evening');
  assert.equal(windowNoun(690, 135), 'lunch');
});

// Seed by seed, people who got a seat: 22 → 24, 24 → 24, 22 → 25; walk-aways 18 → 12 on average and the wait
// rises. Ten sit at the table every time; the rest at the counter, where every walk-away happens.
const night = (seated, lost, wait, told) => ({ spawned: 36, served: seated - 2, abandoned: lost, avgWait: wait,
  nodes: [{ id: 'counter', name: 'Counter seats', arrivals: seated - 10 + lost, abandoned: lost, queueNow: 0 }, { id: 'table', name: 'Table', arrivals: 10, abandoned: 0, queueNow: 0 }],
  offers: told == null ? [] : [{ id: 'promotion', reached: told }] });
const NIGHTS = [
  { before: night(22, 18, 9.6), after: night(24, 12, 12.3, 36) },
  { before: night(24, 16, 9.0), after: night(24, 13, 11.0, 36) },
  { before: night(22, 20, 10.1), after: night(25, 11, 12.9, 36) }
];

test('the promotion\'s result counts customers kept as more people who got a seat, and says who decided', () => {
  const r = testResult(NIGHTS, PROMO);
  assert.deepEqual(r.kept, [2, 0, 3]);
  assert.deepEqual(r.rows.map(x => [x.label, cellWords(x.kind, x.before), cellWords(x.kind, x.after), cellWords(x.kind, x.change, true), x.strong]), [
    ['Got a seat', '23', '24', '+1', true],
    ['Walked away', '18', '12', '−6', false],
    ['Average wait', '9.6 min', '12.1 min', '+2.5 min', false],
    ['Got a seat at Counter seats', '13', '14', '+1', false],
    ['Got a seat at Table', '10', '10', 'no change', false],
    ['Told about the promotion', '0', '36', '+36', false]
  ]);
  assert.deepEqual(verdictWords(r, PROMO, { ...dinner, by: 'Jev' }), {
    tone: 'helped', headline: 'The promotion kept up to 3 more customers.',
    detail: 'Up to 3 more people got a seat from 6:00 pm to 8:30 pm. Tested with Jev, 3 runs each way.'
  });
  // With the rule model, the verdict says what that model cannot see.
  assert.match(verdictWords(r, PROMO, dinner).detail, /Tested with the rule model, 3 runs each way\. It sees the lower price, not the message\.$/);
  assert.equal(verdictWords({ runs: 3, kept: [0, 0, 0] }, PROMO, dinner).headline, 'The promotion changed nothing.');
  assert.match(verdictWords({ runs: 3, kept: [-1, -1, -1] }, PROMO, dinner).detail, /^1 fewer person got a seat/);
  assert.equal(whySentence(r, PROMO),
    'People waited for a seat instead of leaving: walk-aways fell from 18 to 12, and the average wait rose from 9.6 min to 12 min. It adds no seats, so the room cannot seat many more.');
  const same = testResult([{ before: night(22, 18, 9.6), after: night(22, 18, 9.6, 36) }], PROMO);
  assert.equal(whySentence(same, PROMO), 'As many people gave up: 18 walk-aways with and without it.');
});

test('the words around a test name the change, the decision-maker and the time it takes', () => {
  const staff = testWords(STAFF, { noun: 'lunch' });
  assert.equal(staff.action, 'Test +1 staff here');
  assert.equal(staff.plan, 'Plays the same lunch 3 times with 1 staff and 3 times with 2, using the rule model. It takes a few seconds.');
  assert.equal(staff.step(2, 6, true), 'Run 2 of 6: the lunch with 2 staff.');
  assert.deepEqual(staff.toggle, ['Baseline (1 staff)', '+1 staff']);
  const promo = testWords(PROMO, { by: 'Jev', noun: 'evening' });
  assert.equal(promo.plan, 'Plays the same evening 3 times as it is and 3 times with the promotion, decided by Jev. It takes about a minute.');
  assert.equal(promo.step(1, 6, false), 'Run 1 of 6: the evening as it is.');
  assert.match(testWords(PROMO).plan, /decided by the rule model, which sees the lower price but not the message\./);
  // Under a Jev verdict: two Jev runs of the same world and seed already differ.
  assert.match(promo.caution, /two Jev runs of the same world and seed already differ by a few people/);
  assert.equal(testWords(PROMO).caution, '');
});

test('a promotion run from before the run link is known by its offers and paired with its twin', () => {
  const world = applyChange(SUSHI, PROMO);
  const run = (runId, createdAt, spec, extra = {}) => ({ meta: { runId, createdAt, seed: 7, provider: 'jev', ...extra }, spec });
  const runs = [
    run('base-old', '2026-11-14T15:00:00Z', SUSHI),
    run('promo-1', '2026-11-14T15:10:00Z', world),
    run('base-new', '2026-11-14T15:20:00Z', SUSHI),
    run('promo-2', '2026-11-14T15:30:00Z', world),
    run('promo-rules', '2026-11-14T15:40:00Z', world, { provider: 'rules' }),
    run('promo-s8', '2026-11-14T15:50:00Z', world, { seed: 8 }),
    run('linked', '2026-11-14T16:00:00Z', world, { link: { test: 't', role: 'change', change: PROMO } })
  ];
  assert.equal(hasPromotion(world), true);
  assert.equal(hasPromotion(SUSHI), false);
  // A promotion run pairs with the newest baseline started before it; a baseline with the newest promotion run.
  assert.deepEqual(findOfferTest(runs, 'promo-1'), { id: 'offers-promo-1', change: { kind: 'promotion', off: 0.2 }, pairs: [{ seed: 7, baseline: 'base-old', change: 'promo-1' }] });
  assert.deepEqual(findOfferTest(runs, 'promo-2').pairs[0], { seed: 7, baseline: 'base-new', change: 'promo-2' });
  assert.deepEqual(findOfferTest(runs, 'base-old').pairs[0], { seed: 7, baseline: 'base-old', change: 'promo-2' }, 'same seed and decision-maker only; linked runs belong to their test');
  assert.equal(findOfferTest(runs, 'promo-rules'), null, 'no rule-model baseline');
  assert.equal(findOfferTest(runs, 'linked'), null);
  assert.equal(findOfferTest(runs, 'nope'), null);
});

