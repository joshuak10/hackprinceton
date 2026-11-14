// Report tests (docs/PROTOTYPE.md §7, §8): reportMarkdown and agentLog over synthetic run directories
// written by the test itself. No engine, no network.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reportMarkdown, agentLog, agentRecord, fallbackRate, fallbackWarning, providerStatsLine, kpiLine, formatKpi
} from '../run/report.js';

// ---------- a synthetic run ----------

const SPEC = {
  title: 'Harbor Lights Park', question: 'Where do lines form?', mode: 'visit', duration: 120, clockStart: 480,
  nodes: [
    { id: 'gate', name: 'Main Gate', kind: 'entry' },
    { id: 'thunder', name: 'Thunder Spine', kind: 'service' },
    { id: 'wheel', name: 'Sky Wheel', kind: 'service' }
  ],
  edges: [],
  archetypes: [{ id: 'fam', name: 'Families' }, { id: 'teen', name: 'Teens' }],
  minds: [
    { id: 'priya', name: 'Priya Shah', age: 34, archetype: 'fam', bio: 'Parent of two on a day trip.', personality: 'organized', goal: 'ride Thunder Spine', social: 'the family chat' },
    { id: 'kai', name: 'Kai Lee', age: 16, archetype: 'teen', bio: 'Here with friends.', personality: 'restless', goal: 'ride everything', social: 'friends' }
  ]
};

const METRICS = {
  mode: 'visit', abandonRate: 0.125, avgWait: 14.3, served: 70, abandoned: 10, spawned: 80,
  nodes: [
    { id: 'wheel', name: 'Sky Wheel', score: 40, waitMinutes: 40, abandoned: 0, arrivals: 30, served: 30, avgWait: 1.3, maxQueue: 3, utilization: 0.5, capacityPerHour: 60 },
    { id: 'thunder', name: 'Thunder Spine', score: 900, waitMinutes: 600, abandoned: 10, arrivals: 50, served: 40, avgWait: 12, maxQueue: 25, utilization: 0.97, capacityPerHour: 40 }
  ],
  archetypes: [
    { id: 'fam', name: 'Families', count: 40, avgWaitPerAgent: 9.5, avgServed: 1.5, abandonsPerAgent: 0.1 },
    { id: 'teen', name: 'Teens', count: 40, avgWaitPerAgent: 12, avgServed: 1.2, abandonsPerAgent: 0.2 }
  ],
  frustration: { avg: 1.6, byArchetype: { fam: 1.2, teen: 2 } },
  remarks: { total: 5, byKind: { long_line: 3, good_experience: 2 } },
  decisions: { total: 100, byProvider: { jev: 80, 'jev-cache': 10, 'rules-fallback': 10 }, byKind: { choose: 70, line: 30 } }
};

const REMARKS = [
  { t: 10, agentId: 0, personaName: 'Priya Shah', archetypeId: 'fam', kind: 'long_line', placeId: 'thunder', edgeId: null, informed: true },
  { t: 20, agentId: 1, personaName: 'Kai Lee', archetypeId: 'teen', kind: 'long_line', placeId: 'thunder', edgeId: null, informed: false },
  { t: 30, agentId: 0, personaName: 'Priya Shah', archetypeId: 'fam', kind: 'long_line', placeId: 'thunder', edgeId: null, informed: true },
  { t: 40, agentId: 1, personaName: 'Kai Lee', archetypeId: 'teen', kind: 'good_experience', placeId: 'wheel', edgeId: null, informed: false },
  { t: 50, agentId: 1, personaName: 'Kai Lee', archetypeId: 'teen', kind: 'good_experience', placeId: 'wheel', edgeId: null, informed: false }
];

const AGENTS = [
  { id: 0, personaId: 'priya', personaName: 'Priya Shah', archetypeId: 'fam', informed: true, served: 2, waitTotal: 18.5, abandons: 1, frustration: 2.6, born: 5, done: 100,
    trace: [{ t: 5, m: 'arrived at the gate' }, { t: 30, m: 'skipped Thunder Spine' }] },
  { id: 1, personaId: 'kai', personaName: 'Kai Lee', archetypeId: 'teen', informed: false, served: 1, waitTotal: 4, abandons: 0, frustration: 0.4, born: 8, done: 90, trace: [] }
];

const OPTIONS = [
  { key: 'thunder', label: 'Go to Thunder Spine' },
  { key: 'wheel', label: 'Go to Sky Wheel' },
  { key: 'leave', label: 'Leave and go home' }
];
const ASKS_CHOICE = { choice: 'next_place', yesNo: null, frustration: true, tellOthers: true };
const ASKS_JOIN = { choice: 'next_place', yesNo: 'join', frustration: false, tellOthers: false };

const line = (id, agentId, over = {}) => ({
  id, t: 30, clock: '08:30', agentId, personaId: agentId === 0 ? 'priya' : 'kai', kind: 'choose', why: 'start', placeId: null,
  options: OPTIONS, asks: ASKS_CHOICE, observation: { now: 'Just arrived. Choosing where to go first.' }, auto: { action: 'thunder' },
  decision: { provider: 'jev', choiceProbs: { thunder: 0.45, wheel: 0.4, leave: 0.15 }, model: 'jev-1.14.0', latencyMs: 150 },
  applied: { id, agentId, kind: 'choose', yes: null, action: 'thunder', tell: false, remarkKind: null, frustration: null, summary: 'went to Thunder Spine', provider: 'jev' },
  ...over
});

const DECISIONS = [
  // torn: 0.45 vs 0.40 (gap 0.05)
  line('d1', 0),
  // clear: 0.8 vs 0.1
  line('d2', 1, { decision: { provider: 'jev', choiceProbs: { thunder: 0.1, wheel: 0.8, leave: 0.1 } }, applied: { id: 'd2', agentId: 1, kind: 'choose', yes: null, action: 'wheel', tell: false, remarkKind: null, frustration: null, summary: 'went to Sky Wheel', provider: 'jev' } }),
  // torn yes/no: 0.55 vs 0.45 (gap 0.10)
  line('d3', 0, {
    kind: 'line', why: null, placeId: 'thunder', asks: ASKS_JOIN, observation: { now: 'Just reached Thunder Spine. The line is long, about 45 min: more than they will put up with.' },
    decision: { provider: 'jev', yesProb: 0.55, choiceProbs: { wheel: 0.7, leave: 0.3 } },
    applied: { id: 'd3', agentId: 0, kind: 'line', yes: false, action: 'wheel', tell: false, remarkKind: null, frustration: null, summary: 'skipped Thunder Spine for Sky Wheel', provider: 'jev' }
  }),
  // not torn yes/no: 0.9 vs 0.1
  line('d4', 1, {
    kind: 'line', why: null, placeId: 'wheel', asks: ASKS_JOIN, decision: { provider: 'jev', yesProb: 0.9 },
    applied: { id: 'd4', agentId: 1, kind: 'line', yes: true, action: null, tell: false, remarkKind: null, frustration: null, summary: 'joined', provider: 'jev' }
  }),
  // gap 0.16: just outside the torn window
  line('d5', 1, { decision: { provider: 'jev', choiceProbs: { thunder: 0.58, wheel: 0.42, leave: 0 } } }),
  // a fallback decision without probabilities
  line('d6', 0, {
    why: 'next', decision: { provider: 'rules-fallback', action: 'wheel', error: 'HTTP 500 after retries' },
    applied: { id: 'd6', agentId: 0, kind: 'choose', yes: null, action: 'wheel', tell: true, remarkKind: 'long_line', frustration: 2.6, summary: 'went to Sky Wheel', provider: 'rules-fallback' },
    asks: ASKS_CHOICE
  })
];

const JEV_STATS = {
  provider: 'jev', model: 'jev-1.14.0', requests: 80, cacheHits: 10, fallbacks: 10, errors: 10, firstError: 'HTTP 500 after retries',
  inputTokens: 72000, outputTokens: 11000, latency: { p50: 140, p95: 420, max: 900 }, estCostUSD: 0.003024,
  priceNote: '$0.042 per million input tokens (TypeSafe published price, unverified)'
};

let root;
let runDir;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'swarm-report-'));
  runDir = writeRun('main', { metrics: METRICS });
});
after(() => { rmSync(root, { recursive: true, force: true }); });

function writeRun(name, { metrics, meta = {}, decisions = DECISIONS, remarks = REMARKS, agents = AGENTS, spec = SPEC } = {}) {
  const dir = join(root, name);
  mkdirSync(dir);
  const put = (file, value) => writeFileSync(join(dir, file), JSON.stringify(value));
  put('meta.json', {
    runId: name, createdAt: '2026-11-14T09:00:00.000Z', status: 'done', error: null, title: spec.title, question: spec.question, mode: spec.mode,
    duration: spec.duration, clockStart: spec.clockStart, seed: 7, specHash: 'abc123def456', provider: 'jev', model: 'jev-1.14.0',
    decisions: decisions.length, agents: 80, providerStats: JEV_STATS, simOpts: {}, label: null, ...meta
  });
  put('spec.json', spec);
  if (metrics) put('metrics.json', metrics);
  put('agents.json', agents);
  put('remarks.json', remarks);
  writeFileSync(join(dir, 'decisions.jsonl'), decisions.map(d => JSON.stringify(d)).join('\n') + '\n');
  return dir;
}

const section = (md, heading) => {
  const start = md.indexOf(`## ${heading}`);
  assert.ok(start >= 0, `report has no "${heading}" section`);
  const next = md.indexOf('\n## ', start + 3);
  return md.slice(start, next < 0 ? undefined : next);
};

// ---------- reportMarkdown ----------

describe('reportMarkdown', () => {
  test('starts with the title, the question and a run summary', () => {
    const md = reportMarkdown(runDir);
    assert.ok(md.startsWith('# Harbor Lights Park\n'));
    assert.match(md, /\*\*Question:\*\* Where do lines form\?/);
    assert.match(md, /Run `main` · done/);
    assert.match(md, /Provider jev \(model jev-1\.14\.0\) · seed 7 · spec hash `abc123def456`/);
    assert.match(md, /visit world · 2 h from 08:00 · 80 agents · 6 recorded decisions/);
    assert.ok(md.endsWith('\n'));
  });

  test('headline has the KPIs and the top bottlenecks ranked by score', () => {
    const head = section(reportMarkdown(runDir), 'Headline');
    assert.match(head, /abandon rate 12\.5%/);
    assert.match(head, /avg wait 14\.3 min/);
    assert.match(head, /served 70/);
    assert.match(head, /abandoned 10/);
    assert.match(head, /spawned 80/);
    assert.match(head, /Top bottlenecks: 1\. Thunder Spine \(900\) · 2\. Sky Wheel \(40\)/);
  });

  test('ranks bottlenecks in a table, highest score first, whatever order metrics lists them in', () => {
    const sec = section(reportMarkdown(runDir), 'Bottlenecks (score = wait minutes + 30 × abandoned)');
    const thunder = sec.indexOf('| 1 | Thunder Spine | 900 |');
    const wheel = sec.indexOf('| 2 | Sky Wheel | 40 |');
    assert.ok(thunder > 0 && wheel > thunder, sec);
    assert.match(sec, /97%/);
    assert.match(sec, /Utilization/);
  });

  test('route runs rank roads by delay minutes', () => {
    const spec = { ...SPEC, mode: 'route', edges: [{ from: 'a', to: 'b', name: 'Kessel Bridge' }, { from: 'b', to: 'c', name: 'Canal Road' }] };
    const metrics = {
      mode: 'route', avgTrip: 31.2, avgDelay: 8.4, arrived: 500,
      edges: [
        { id: 'b>c', name: 'Canal Road', delayMinutes: 120, delayRatio: 1.2, peakRatio: 0.9, traversals: 400, avgTime: 6, freeflow: 5, capacity: 50 },
        { id: 'a>b', name: 'Kessel Bridge', delayMinutes: 2400, delayRatio: 2.4, peakRatio: 1.6, traversals: 500, avgTime: 12, freeflow: 5, capacity: 30 }
      ],
      od: [{ route: 'North to Downtown', trips: 300, avgTrip: 30, freeflow: 20 }],
      archetypes: [{ name: 'Commuters', count: 500, arrived: 500, avgTrip: 31.2, avgDelay: 8.4 }],
      decisions: { total: 0, byProvider: {}, byKind: {} }
    };
    const dir = writeRun('route', { metrics, spec, decisions: [], remarks: [], agents: [], meta: { provider: 'rules', providerStats: { provider: 'rules', external: false } } });
    const md = reportMarkdown(dir);
    assert.match(section(md, 'Headline'), /avg trip 31\.2 min · avg delay 8\.4 min · arrived 500/);
    assert.match(section(md, 'Headline'), /Top bottlenecks: 1\. Kessel Bridge \(2,400\) · 2\. Canal Road \(120\)/);
    const sec = section(md, 'Bottlenecks (score = delay minutes)');
    assert.ok(sec.indexOf('Kessel Bridge') < sec.indexOf('Canal Road'));
    assert.match(sec, /North to Downtown/);
    assert.match(md, /No external decisions: the inline rule policy decided/);
  });

  test('outcomes by group lists each archetype', () => {
    const sec = section(reportMarkdown(runDir), 'Outcomes by group');
    assert.match(sec, /Families \| 40 \| 9\.5 min \| 1\.5 \| 0\.1 \|/);
    assert.match(sec, /Teens \| 40 \| 12\.0 min \| 1\.2 \| 0\.2 \|/);
  });

  test('remarks section has total, counts by kind and a table by place', () => {
    const sec = section(reportMarkdown(runDir), 'Remarks');
    assert.match(sec, /5 remarks: long_line 3 · good_experience 2\./);
    assert.match(sec, /\| About \| Total \| long_line \| good_experience \|/);
    assert.match(sec, /\| Thunder Spine \| 3 \| 3 \| 0 \|/);
    assert.match(sec, /\| Sky Wheel \| 2 \| 0 \| 2 \|/);
  });

  test('says so when there are no remarks', () => {
    const dir = writeRun('no-remarks', { metrics: METRICS, remarks: [] });
    assert.match(section(reportMarkdown(dir), 'Remarks'), /No remarks were posted\./);
  });

  test('torn decisions are those whose top two probabilities are within 0.15', () => {
    const sec = section(reportMarkdown(runDir), 'Torn decisions (top two probabilities within 0.15)');
    assert.match(sec, /2 of 5 decisions with probabilities were torn \(choose 1 · line 1\)\./);
    assert.ok(sec.includes('**d1**'), 'd1 (45% vs 40%) is torn');
    assert.ok(sec.includes('**d3**'), 'd3 (yes 55% vs no 45%) is torn');
    for (const id of ['d2', 'd4', 'd5', 'd6']) assert.ok(!sec.includes(`**${id}**`), `${id} is not torn`);
  });

  test('torn decisions show the situation, probabilities and what happened, closest call first', () => {
    const sec = section(reportMarkdown(runDir), 'Torn decisions (top two probabilities within 0.15)');
    assert.ok(sec.indexOf('**d1**') < sec.indexOf('**d3**'), 'sorted by gap, smallest first');
    assert.match(sec, /Situation: Just arrived\. Choosing where to go first\./);
    assert.match(sec, /next_place: Thunder Spine 45% · Sky Wheel 40% · Leave and go home 15% → Thunder Spine \(jev\)/);
    assert.match(sec, /join: yes 55% · no 45% → no, then Sky Wheel \(jev\)/);
    assert.match(sec, /Priya Shah \(Families, 34\): Parent of two on a day trip\./);
    assert.match(sec, /Options \(3\): Thunder Spine, Sky Wheel, Leave and go home/);
  });

  test('torn decisions renormalize over valid option keys and ignore unknown ones', () => {
    const odd = line('d9', 0, { decision: { provider: 'jev', choiceProbs: { thunder: 0.3, wheel: 0.3, ghost: 0.4 } } });
    const dir = writeRun('torn-ghost', { metrics: METRICS, decisions: [odd] });
    const sec = section(reportMarkdown(dir), 'Torn decisions (top two probabilities within 0.15)');
    assert.match(sec, /1 of 1 decisions with probabilities were torn/);
    assert.doesNotMatch(sec, /ghost/);
    assert.match(sec, /50%/);
  });

  test('a run with no probabilities says rule-based decisions carry none', () => {
    const rules = [line('d1', 0, { decision: { provider: 'rules', action: 'thunder' } })];
    const dir = writeRun('torn-none', { metrics: { ...METRICS, decisions: { total: 1, byProvider: { rules: 1 }, byKind: { choose: 1 } } }, decisions: rules });
    assert.match(section(reportMarkdown(dir), 'Torn decisions (top two probabilities within 0.15)'), /No decisions with probabilities/);
  });

  test('lists at most ten torn decisions', () => {
    const many = Array.from({ length: 14 }, (_, i) => line(`d${i + 1}`, 0));
    const dir = writeRun('torn-many', { metrics: METRICS, decisions: many });
    const sec = section(reportMarkdown(dir), 'Torn decisions (top two probabilities within 0.15)');
    assert.match(sec, /14 of 14 decisions with probabilities were torn/);
    assert.equal((sec.match(/^- \*\*d\d+\*\*/gm) ?? []).length, 10);
  });

  test('frustration by group uses agents that answered', () => {
    const sec = section(reportMarkdown(runDir), 'Frustration by group');
    assert.match(sec, /Overall average 1\.6 \(frustrated\)/);
    assert.match(sec, /Families \| 1 \| 2\.6 \| very frustrated \| 100%/);
    assert.match(sec, /Teens \| 1 \| 0\.4 \| calm \| 0%/);
  });

  test('decisions section counts by kind and provider', () => {
    const sec = section(reportMarkdown(runDir), 'Decisions');
    assert.match(sec, /100 decisions\. By kind: choose 70 · line 30\. By provider: jev 80 · jev-cache 10 · rules-fallback 10\./);
  });

  test('provider section has the stats, the unverified cost and the first error', () => {
    const sec = section(reportMarkdown(runDir), 'Provider');
    assert.match(sec, /Model jev-1\.14\.0/);
    assert.match(sec, /80 API requests · 10 cache hits · 10 fallbacks · 10 errors/);
    assert.match(sec, /Tokens: 72,000 input \/ 11,000 output/);
    assert.match(sec, /Est\. cost \$0\.00302, unverified/);
    assert.match(sec, /Latency p50 140 ms · p95 420 ms · max 900 ms/);
    assert.match(sec, /First error: HTTP 500 after retries/);
  });

  test('warns when the fallback rate is above 20%', () => {
    const bad = { ...METRICS, decisions: { total: 100, byProvider: { jev: 60, 'rules-fallback': 40 }, byKind: { choose: 100 } } };
    const md = reportMarkdown(writeRun('fallback-high', { metrics: bad }));
    assert.match(section(md, 'Provider'), /Fallback rate 40\.0% of this run's decisions/);
    assert.match(md, /> \*\*Warning: 40\.0% of decisions fell back to rules, so this run does not count as a Jev run/);
  });

  test('no warning at a 10% fallback rate, or at exactly 20%', () => {
    assert.doesNotMatch(reportMarkdown(runDir), /Warning:/);
    const edge = { ...METRICS, decisions: { total: 100, byProvider: { jev: 80, 'rules-fallback': 20 }, byKind: { choose: 100 } } };
    assert.doesNotMatch(reportMarkdown(writeRun('fallback-edge', { metrics: edge })), /Warning:/);
  });

  test('a run that failed before producing metrics reports the error and stops', () => {
    const dir = writeRun('failed', { metrics: null, meta: { status: 'error', error: 'Jev auth failed (401)' }, decisions: [] });
    const md = reportMarkdown(dir);
    assert.match(md, /- Run `failed` · error/);
    assert.match(md, /\*\*Error:\*\* Jev auth failed \(401\)/);
    assert.doesNotMatch(md, /## Headline/);
  });

  test('a label is shown when the run has one', () => {
    const md = reportMarkdown(writeRun('labelled', { metrics: METRICS, meta: { label: 'after: +2 servers' } }));
    assert.match(md, /done · after: \+2 servers/);
  });

  test('throws a clear error for a directory that is not a run', () => {
    assert.throws(() => reportMarkdown(join(root, 'nowhere')), /No recorded run/);
  });
});

// ---------- helpers ----------

describe('fallbackRate and providerStatsLine', () => {
  test('fallbackRate is the share of decisions that fell back, or null with none', () => {
    assert.equal(fallbackRate(METRICS), 0.1);
    assert.equal(fallbackRate({ decisions: { total: 0, byProvider: {} } }), null);
    assert.equal(fallbackRate({}), null);
    assert.equal(fallbackRate(null), null);
  });

  test('fallbackWarning is null at or below 20%', () => {
    assert.equal(fallbackWarning(METRICS), null);
    assert.match(fallbackWarning({ decisions: { total: 10, byProvider: { 'rules-fallback': 3 } } }), /30\.0% .* does not count as a Jev run/);
  });

  test('providerStatsLine for jev, replay, inline rules and external rules', () => {
    const jev = providerStatsLine(JEV_STATS, METRICS);
    for (const part of ['jev jev-1.14.0', '80 requests', '10 cache hits', 'fallback 10.0%', '72,000 input / 11,000 output tokens', 'est. $0.00302 (unverified)', 'p50 140 ms · p95 420 ms']) {
      assert.ok(jev.includes(part), `jev line is missing "${part}": ${jev}`);
    }
    assert.match(providerStatsLine({ provider: 'replay', model: 'jev-1.14.0', decisions: 6, hashHits: 5, idHits: 1, misses: 0 }, METRICS), /replay of jev-1\.14\.0 · 6 decisions · 5 matched by request hash · 1 by id · 0 misses .* no API calls/);
    assert.match(providerStatsLine({ provider: 'rules', external: false }, {}), /inline rule policy/);
    assert.match(providerStatsLine({ provider: 'rules', external: true, decisions: 12 }, {}), /12 decisions answered by the rule policy/);
    assert.equal(providerStatsLine(null, {}), 'no provider stats recorded');
  });

  test('kpiLine and formatKpi', () => {
    assert.equal(formatKpi('abandonRate', 0.125), '12.5%');
    assert.equal(formatKpi('avgWait', 3.25), '3.3 min');
    assert.equal(formatKpi('served', 1234), '1,234');
    assert.equal(kpiLine({ abandonRate: 0.1, avgWait: 2, served: 5, abandoned: 1, spawned: 6, top: [] }),
      'abandon rate 10.0% · avg wait 2.0 min · served 5 · abandoned 1 · spawned 6');
  });
});

// ---------- agentLog ----------

describe('agentLog', () => {
  test('shows the persona, outcome, and only that agent\'s decisions', () => {
    const md = agentLog(runDir, 0);
    assert.ok(md.startsWith('# Agent 0 · Priya Shah\n'));
    assert.match(md, /Group Families · persona `priya` · age 34 · live wait app: yes/);
    assert.match(md, /About: Parent of two on a day trip\./);
    assert.match(md, /Personality: organized · Wants: ride Thunder Spine · Listens to: the family chat/);
    assert.match(md, /Outcome: served 2 · waited 18\.5 min in lines · abandoned 1 · frustration 2\.6 \(very frustrated\) · arrived 08:05 · done 09:40/);
    assert.match(md, /## Decisions \(3\)/);
    for (const id of ['d1', 'd3', 'd6']) assert.ok(md.includes(`### ${id} ·`), `${id} belongs to agent 0`);
    for (const id of ['d2', 'd4', 'd5']) assert.ok(!md.includes(`### ${id} ·`), `${id} belongs to agent 1`);
  });

  test('decisions show probabilities with the chosen option, yes/no answers, fallback reasons and told remarks', () => {
    const md = agentLog(runDir, 0);
    assert.match(md, /### d1 · 08:30 · choose \(just arrived\) · jev \(jev-1\.14\.0, 150 ms\)/);
    assert.match(md, /- next_place: Thunder Spine 45% \(chosen\) · Sky Wheel 40% · Leave and go home 15%/);
    assert.match(md, /→ went to Thunder Spine/);
    assert.match(md, /- join: yes 55% · → no/);
    assert.match(md, /### d6 · 08:30 · choose \(finished somewhere\) · rules-fallback/);
    assert.match(md, /- next_place: rule policy chose Sky Wheel/);
    assert.match(md, /- fallback reason: HTTP 500 after retries/);
    assert.match(md, /- frustration: 2\.6 \(very frustrated\)/);
    // d6 told others; it is agent 0's second remark in order of telling, so it lines up with the first remark about agent 0
    assert.match(md, /- tell others: told others: long line at Thunder Spine/);
  });

  test('ends with the trace using clock times', () => {
    const md = agentLog(runDir, 0);
    const trace = md.slice(md.indexOf('## Trace'));
    assert.match(trace, /- 08:05 arrived at the gate/);
    assert.match(trace, /- 08:30 skipped Thunder Spine/);
  });

  test('an agent with no trace says so', () => {
    assert.match(agentLog(runDir, 1), /No trace entries\./);
  });

  test('accepts the agent id as a string', () => {
    assert.ok(agentLog(runDir, '1').startsWith('# Agent 1 · Kai Lee'));
    assert.match(agentLog(runDir, '1'), /live wait app: no/);
  });

  test('throws for an agent that is not in the run', () => {
    assert.throws(() => agentLog(runDir, 99), /Agent 99 is not in the run/);
  });

  test('agentRecord returns the agent, persona, decisions and remarks; null when missing', () => {
    const rec = agentRecord(runDir, 0);
    assert.equal(rec.agent.personaName, 'Priya Shah');
    assert.equal(rec.persona.id, 'priya');
    assert.deepEqual(rec.decisions.map(d => d.id), ['d1', 'd3', 'd6']);
    assert.equal(rec.remarks.length, 2);
    assert.ok(rec.remarks.every(r => r.agentId === 0));
    assert.equal(agentRecord(runDir, 99), null);
  });
});

// ---------- segments and offers (§15a, §15b) ----------

describe('reportMarkdown segments and offers', () => {
  const seg = (id, name, group, over) => ({
    id, name, group, count: 20, avgWait: 10, avgSpent: 12, avgVisits: 1.5, walkAwaysPerPerson: 0.1, shareNeverServed: 0.05, avgFrustration: 1,
    topPlaces: [{ id: 'thunder', name: 'Thunder Spine', visits: 15 }, { id: 'wheel', name: 'Sky Wheel', visits: 9 }], ...over
  });
  const SEGMENTS = {
    byGroup: [
      seg('fam', 'Families', 'fam', { count: 40, avgWait: 9.5, walkAwaysPerPerson: 0.1, avgSpent: 31.5 }),
      seg('teen', 'Teens', 'teen', { count: 40, avgWait: 6, walkAwaysPerPerson: 0.5, avgSpent: 8.25, avgFrustration: 2.6 })
    ],
    byCast: [
      seg('priya', 'Priya Shah', 'fam', { avgWait: 12, walkAwaysPerPerson: 0, avgSpent: 40 }),
      seg('kai', 'Kai Lee', 'teen', { avgWait: 5, walkAwaysPerPerson: 0.6, avgSpent: 6, shareNeverServed: 0.25 })
    ]
  };
  const SPEC_OFFERS = {
    ...SPEC,
    offers: [{ id: 'wheel_deal', text: 'Sky Wheel: no line right now, half price for teens', to: { groups: ['teen'], cast: [] }, place: 'wheel', priceOff: 0.5 }]
  };

  test('adds who had the worst time, by group and by cast member, worst first', () => {
    const md = reportMarkdown(writeRun('segments', { metrics: { ...METRICS, segments: SEGMENTS } }));
    const sec = section(md, 'Who had the worst time');
    assert.ok(sec.includes('A segment is a kind of simulated person (a group, or everyone who copies one cast member), not a real individual.'));
    // Teens: 6 + 30 × 0.5 = 21 beats Families: 9.5 + 3 = 12.5
    assert.ok(sec.indexOf('| Teens | 40 | 6.0 min | 0.5 | 5% | 2.6 (very frustrated) |') < sec.indexOf('| Families | 40 | 9.5 min |'), sec);
    assert.match(sec, /### By cast member \(everyone who copies them\)/);
    assert.match(sec, /\| Kai Lee \| Teens \| 20 \| 5\.0 min \| 0\.6 \| 25% \|/);
    assert.ok(sec.indexOf('Kai Lee') < sec.indexOf('Priya Shah'));
  });

  test('adds who spent the most, highest average first, with top places', () => {
    const md = reportMarkdown(writeRun('spending', { metrics: { ...METRICS, segments: SEGMENTS } }));
    const sec = section(md, 'Who spent the most');
    assert.match(sec, /\| Segment \| People \| Avg spent \| Avg visits \| Top places \|/);
    assert.ok(sec.indexOf('| Families | 40 | $31.50 |') < sec.indexOf('| Teens | 40 | $8.25 |'), sec);
    assert.match(sec, /\| Priya Shah \| Families \| 20 \| \$40\.00 \| 1\.5 \| Thunder Spine 15 · Sky Wheel 9 \|/);
  });

  test('adds an offers table when metrics.offers is not empty', () => {
    const metrics = { ...METRICS, offers: [{ id: 'wheel_deal', reached: 30, wentToPlace: 12 }] };
    const md = reportMarkdown(writeRun('offers', { metrics, spec: SPEC_OFFERS }));
    const sec = section(md, 'Offers');
    assert.match(sec, /\| Offer \| What they are told \| To \| Place \| Price off \| Reached \| Went to the place \| Share \|/);
    assert.match(sec, /\| wheel_deal \| Sky Wheel: no line right now, half price for teens \| Teens \| Sky Wheel \| 50% \| 30 \| 12 \| 40% \|/);
    assert.doesNotMatch(reportMarkdown(writeRun('offers-empty', { metrics: { ...METRICS, offers: [] } })), /## Offers/);
  });

  test('runs without segments or offers report exactly as before', () => {
    const md = reportMarkdown(runDir);
    assert.doesNotMatch(md, /Who had the worst time|Who spent the most|## Offers/);
    const groups = md.indexOf('## Outcomes by group');
    assert.ok(groups > 0 && md.indexOf('## Remarks') > groups);
    assert.ok(!md.slice(groups, md.indexOf('## Remarks')).includes('A segment is'));
  });

  test('route segments show trip and delay, most delay first, and no spending table', () => {
    const spec = { ...SPEC, mode: 'route', edges: [{ from: 'a', to: 'b', name: 'Kessel Bridge' }] };
    const metrics = {
      mode: 'route', avgTrip: 30, avgDelay: 8, arrived: 100, edges: [], archetypes: [], decisions: { total: 0, byProvider: {}, byKind: {} },
      segments: {
        byGroup: [
          { id: 'fam', name: 'Families', group: 'fam', count: 50, avgTrip: 25, avgDelay: 4, avgFrustration: null },
          { id: 'teen', name: 'Teens', group: 'teen', count: 50, avgTrip: 35, avgDelay: 12, avgFrustration: 1.2 }
        ],
        byCast: []
      }
    };
    const md = reportMarkdown(writeRun('route-segments', { metrics, spec, decisions: [], remarks: [], agents: [] }));
    const sec = section(md, 'Who had the worst time');
    assert.match(sec, /\| Segment \| People \| Avg trip \| Avg delay \| Frustration \|/);
    assert.ok(sec.indexOf('| Teens | 50 | 35.0 min | 12.0 min |') < sec.indexOf('| Families | 50 | 25.0 min | 4.0 min | – |'), sec);
    assert.doesNotMatch(md, /Who spent the most/);
  });
});
