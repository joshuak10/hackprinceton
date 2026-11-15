// The advisor (docs/PROTOTYPE.md §15c): a Claude agent that reads what a run produced, answers the user's
// question, tests changes in the simulator on the same crowd (same seeds), and says what to try next.
//
//   buildBrief({ world, runs })  → { markdown, data }: the run digest and the levers Claude may change
//   advise({ world, question, ... }) → { answer, findings, recommendations, cautions, nextSteps, experiments, transcript }
//   writeAdvice(dir, result)     → writes advice.json and advice.md
//
// Every number in a recommendation comes from an experiment the code ran; Claude only picks and explains.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { normalizeSpec, validateWorld, cleanSpec, applyPatch, PATCH_FIELDS, specHash } from '../engine/spec.js';
import { clockText } from '../engine/util.js';
import { makeProvider } from '../providers/index.js';
import { hasKey } from '../engine/env.js';
import { normalizePool } from './days.js';
import { shopView } from './morning.js';
import { TIMESCALE_RULE } from './timescale.js';
import { runSeeds, compareRuns, rankedPlaces, KPI_NAMES } from './runner.js';
import { BETTER, HEADLINE, meanSd, changeEffects, placeVisits } from './effects.js';
import { readDecisions } from './recorder.js';
import {
  primaryProbs, TORN_GAP, SEGMENT_NOTE, segmentScore, fallbackRate, fallbackWarning,
  KPI_LABELS, formatKpi, fmtInt, fmtNum, fmtPct, fmtMin, fmtMoney
} from './report.js';

export const DEFAULT_MODEL = 'claude-fable-5-2';
export const DEFAULT_SEEDS = [7, 8, 9];
export const MAX_EXPERIMENTS_LIMIT = 20;
const MAX_TOKENS = 32000;
// Server-side refusal fallback: on a policy decline the API retries on its default fallback model.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const CONFIRM_TOP = 3;
// Cautions that start with this go under "What could not be tested" in advice.md.
export const COULD_NOT_TEST = 'Could not test: ';

export const NO_KEY_MESSAGE =
  'swarm advise needs ANTHROPIC_API_KEY (put ANTHROPIC_API_KEY=... in .env.local). ' +
  'Without a key, let Claude Code be the advisor: open this repo in Claude Code and run ' +
  '/advise <world file or run> [your question]. Claude Code runs the baseline on 3 seeds with rules, reads ' +
  '`node bin/swarm.js report`, tests each change with `node bin/swarm.js compare` on the same seeds, and writes ' +
  'advice.md by the same rules (.claude/commands/advise.md).';

const CONFIDENCE = ['low', 'medium', 'high'];

// ---------- small helpers ----------
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = v => typeof v === 'string' && v.trim().length > 0;
const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const sum = list => list.reduce((s, v) => s + v, 0);

// Rounds every number in a JSON-safe value, so tool results stay short.
function rounded(value, digits = 3) {
  if (isNum(value)) return Number.isInteger(value) ? value : Number(value.toFixed(digits));
  if (Array.isArray(value)) return value.map(v => rounded(v, digits));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, rounded(v, digits)]));
  return value;
}

const pick = (obj, fields) => Object.fromEntries(fields.filter(f => obj?.[f] !== undefined && obj?.[f] !== null).map(f => [f, obj[f]]));

// `spent` is a total, or one entry per place that served the agent (numbers, or objects with a price).
export function spentOf(agent) {
  const s = agent?.spent;
  if (isNum(s)) return s;
  if (Array.isArray(s)) return sum(s.map(x => (isNum(x) ? x : isNum(x?.price) ? x.price : isNum(x?.amount) ? x.amount : 0)));
  return null;
}
const visitsOf = agent => (Array.isArray(agent?.visits) ? agent.visits : null);

function nameLookup(spec) {
  const names = new Map();
  for (const n of spec?.nodes ?? []) names.set(n.id, n.name);
  for (const e of spec?.edges ?? []) {
    names.set(`${e.from}>${e.to}`, e.name);
    names.set(`${e.to}>${e.from}`, e.name);
  }
  return id => (id == null ? '–' : names.get(id) ?? String(id));
}

function readJsonIn(dir, name) {
  const file = join(dir, name);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

// One baseline run, whether it came from runSeeds (metrics and maybe runDir), loadRun, or the advisor's own
// in-memory baseline. Agents, remarks and decisions are read from the run folder on first use.
function runView(run, i) {
  const dir = run.runDir ?? run.dir ?? null;
  const cache = {};
  const fromDisk = (name, read) => {
    if (!(name in cache)) cache[name] = dir ? read(dir) : null;
    return cache[name];
  };
  const meta = run.meta ?? (run.runId && run.seed != null ? null : fromDisk('meta', d => readJsonIn(d, 'meta.json')));
  const seed = run.seed ?? meta?.seed ?? null;
  return {
    seed,
    runId: run.runId ?? meta?.runId ?? `baseline-s${seed ?? i}`,
    runDir: dir,
    metrics: run.metrics ?? fromDisk('metrics', d => readJsonIn(d, 'metrics.json')),
    get agents() { return run.agents ?? fromDisk('agents', d => readJsonIn(d, 'agents.json')); },
    get remarks() { return run.remarks ?? fromDisk('remarks', d => readJsonIn(d, 'remarks.json')) ?? []; },
    get decisions() { return run.decisions ?? fromDisk('decisions', readDecisions) ?? []; }
  };
}

// ---------- the brief ----------

function kpiStats(views, mode) {
  const out = {};
  for (const k of KPI_NAMES[mode]) {
    const bySeed = views.map(v => v.metrics[k]).filter(isNum);
    const { mean, sd } = meanSd(bySeed);
    out[k] = { mean, sd, min: bySeed.length ? Math.min(...bySeed) : null, max: bySeed.length ? Math.max(...bySeed) : null, bySeed };
  }
  return out;
}

function bottlenecksOf(views, mode) {
  const by = new Map();
  for (const v of views) {
    const rows = new Map(((mode === 'route' ? v.metrics.edges : v.metrics.nodes) ?? []).map(r => [r.id, r]));
    rankedPlaces(v.metrics).forEach((p, i) => {
      if (!by.has(p.id)) by.set(p.id, { id: p.id, name: p.name, scores: [], first: 0, top3: 0, rows: [] });
      const e = by.get(p.id);
      e.scores.push(p.score);
      if (i === 0) e.first++;
      if (i < 3) e.top3++;
      if (rows.has(p.id)) e.rows.push(rows.get(p.id));
    });
  }
  const n = Math.max(1, views.length);
  return [...by.values()].map(e => {
    const avg = k => meanSd(e.rows.map(r => r[k]).filter(isNum)).mean;
    const base = { id: e.id, name: e.name, meanScore: sum(e.scores) / n, firstOn: e.first, top3On: e.top3 };
    return mode === 'route'
      ? { ...base, delayRatio: avg('delayRatio'), peakRatio: avg('peakRatio'), traversals: avg('traversals'), capacity: e.rows[0]?.capacity, freeflow: e.rows[0]?.freeflow }
      : { ...base, avgWait: avg('avgWait'), abandoned: avg('abandoned'), utilization: avg('utilization'), maxQueue: avg('maxQueue'), servers: e.rows[0]?.servers, serviceTime: e.rows[0]?.serviceTime };
  }).sort((a, b) => b.meanScore - a.meanScore);
}

function doorsOf(views) {
  const by = new Map();
  for (const v of views) {
    for (const d of v.metrics.doors ?? []) {
      if (!by.has(d.id)) by.set(d.id, { id: d.id, name: d.name ?? d.id, crossings: [], peak: 0 });
      const e = by.get(d.id);
      e.crossings.push(d.crossings ?? 0);
      e.peak = Math.max(e.peak, d.peakPer5Min ?? 0);
    }
  }
  const n = Math.max(1, views.length);
  return [...by.values()].map(e => ({ id: e.id, name: e.name, crossings: sum(e.crossings) / n, peakPer5Min: e.peak }))
    .sort((a, b) => b.crossings - a.crossings).slice(0, 8);
}

// Averages each segment's numbers over the runs that have it. Place visits (visitsByPlace, or topPlaces in older
// runs) are averaged over all runs before the top 3 are picked.
function meanSegments(lists, nameOf) {
  const runs = lists.filter(Array.isArray);
  if (!runs.length) return null;
  const by = new Map();
  for (const list of runs) {
    for (const s of list) {
      if (!by.has(s.id)) by.set(s.id, { id: s.id, name: s.name, group: s.group, values: {}, places: new Map() });
      const e = by.get(s.id);
      for (const [k, v] of Object.entries(s)) if (isNum(v)) (e.values[k] ??= []).push(v);
      const names = new Map((s.topPlaces ?? []).map(p => [p.id, p.name]));
      for (const [id, k] of Object.entries(placeVisits(s))) {
        const q = e.places.get(id) ?? { id, name: names.get(id) ?? nameOf(id), visits: 0 };
        q.visits += k ?? 0;
        e.places.set(id, q);
      }
    }
  }
  return [...by.values()].map(e => {
    const out = { id: e.id, name: e.name, group: e.group };
    for (const [k, vs] of Object.entries(e.values)) out[k] = sum(vs) / vs.length;
    out.topPlaces = [...e.places.values()].map(p => ({ ...p, visits: p.visits / runs.length }))
      .sort((a, b) => b.visits - a.visits).slice(0, 3);
    return out;
  });
}

function segmentsOf(views, mode, nameOf) {
  const byGroup = meanSegments(views.map(v => v.metrics.segments?.byGroup), nameOf);
  const byCast = meanSegments(views.map(v => v.metrics.segments?.byCast), nameOf);
  if (!byGroup && !byCast) return null;
  const pool = byCast?.length ? byCast : byGroup ?? [];
  const worse = mode === 'route' ? (a, b) => (b.avgDelay ?? 0) - (a.avgDelay ?? 0) : (a, b) => segmentScore(b) - segmentScore(a);
  return {
    byGroup: byGroup ?? [],
    byCast: byCast ?? [],
    worstOff: [...pool].sort(worse).slice(0, 8),
    topSpenders: mode === 'route' ? [] : [...pool].filter(s => isNum(s.avgSpent)).sort((a, b) => b.avgSpent - a.avgSpent).slice(0, 8)
  };
}

function remarksOf(views, nameOf) {
  const byKind = {};
  const byPlace = new Map();
  let total = 0;
  for (const v of views) {
    for (const r of v.remarks) {
      total++;
      byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
      const id = r.placeId ?? r.edgeId ?? null;
      if (!byPlace.has(id)) byPlace.set(id, { id, name: nameOf(id), total: 0, kinds: {} });
      const p = byPlace.get(id);
      p.total++;
      p.kinds[r.kind] = (p.kinds[r.kind] ?? 0) + 1;
    }
  }
  return { total, runs: views.length, byKind, byPlace: [...byPlace.values()].sort((a, b) => b.total - a.total).slice(0, 10) };
}

function tornOf(views, nameOf) {
  const list = [];
  let scored = 0;
  for (const v of views) {
    for (const line of v.decisions) {
      const p = primaryProbs(line);
      if (!p || p.probs.length < 2) continue;
      scored++;
      if (p.gap > TORN_GAP) continue;
      const yesNo = p.question === line.asks?.yesNo;
      list.push({
        runId: v.runId, id: line.id, agentId: line.agentId, personaId: line.personaId, kind: line.kind, clock: line.clock,
        situation: clip(line.observation?.now ?? line.observation?.trip ?? '', 200), question: p.question, gap: p.gap,
        probs: p.probs.slice(0, 3).map(([k, q]) => `${yesNo ? k : nameOf(k)} ${Math.round(q * 100)}%`),
        took: line.applied?.summary ?? null
      });
    }
  }
  list.sort((a, b) => a.gap - b.gap);
  return { scored, torn: list.length, top: list.slice(0, 6) };
}

function qualityOf(views) {
  const walls = views.map(v => v.metrics.walls).filter(Boolean);
  return {
    walls: walls.length && walls.some(w => w.count)
      ? { count: walls[0].count ?? 0, checkedMoves: sum(walls.map(w => w.checkedMoves ?? 0)), violations: sum(walls.map(w => w.violations ?? 0)) }
      : null,
    fallback: views.map(v => ({ seed: v.seed, rate: fallbackRate(v.metrics) })),
    warnings: views.map(v => fallbackWarning(v.metrics)).filter(Boolean)
  };
}

function assumptionsOf(raw, spec) {
  const list = Array.isArray(raw?.assumptions) ? raw.assumptions : [];
  const listed = list.slice(0, 20).map(a => (typeof a === 'string' ? a
    : [a?.key, a?.value !== undefined ? `= ${JSON.stringify(a.value)}` : '', a?.why ? `(${a.why})` : ''].filter(Boolean).join(' ')));
  const prov = spec.provenance && Object.keys(spec.provenance).length ? spec.provenance : null;
  let provenance = null;
  if (prov) {
    const counts = {};
    for (const label of Object.values(prov)) counts[String(label)] = (counts[String(label)] ?? 0) + 1;
    const assumed = Object.keys(prov).filter(k => prov[k] === 'assumed');
    provenance = { counts, assumed: assumed.slice(0, 25), assumedTotal: assumed.length };
  }
  return { listed, total: list.length, provenance };
}

function offersOf(raw, spec, views) {
  const defs = (Array.isArray(spec.offers) ? spec.offers : Array.isArray(raw?.offers) ? raw.offers : [])
    .map(o => pick(o, ['id', 'text', 'to', 'place', 'priceOff', 'from', 'until']));
  const by = new Map();
  for (const v of views) {
    for (const o of v.metrics.offers ?? []) {
      if (!by.has(o.id)) by.set(o.id, { id: o.id, reached: [], wentToPlace: [] });
      by.get(o.id).reached.push(o.reached ?? 0);
      by.get(o.id).wentToPlace.push(o.wentToPlace ?? 0);
    }
  }
  const n = Math.max(1, views.length);
  const results = [...by.values()].map(e => ({ id: e.id, reached: sum(e.reached) / n, wentToPlace: sum(e.wentToPlace) / n }));
  return { current: defs, results };
}

// Every field test_change may set, with its current value (PATCH_FIELDS in engine/spec.js), plus the offer op.
function leversOf(spec) {
  const clean = cleanSpec(spec);
  const route = spec.mode === 'route';
  const node = clean.nodes.map(n => ({ id: n.id, name: n.name, kind: n.kind, values: pick(n, PATCH_FIELDS.node) }))
    .filter(n => Object.keys(n.values).length);
  const edge = (clean.edges ?? []).map(e => ({
    id: `${e.from}>${e.to}`, name: e.name,
    values: { ...pick(e, PATCH_FIELDS.edge.filter(f => f !== 'closed')), ...(PATCH_FIELDS.edge.includes('closed') ? { closed: 0 } : {}) }
  }));
  const archetype = clean.archetypes.map(a => ({ id: a.id, name: a.name, values: pick(a, PATCH_FIELDS.archetype) }));
  const global = {};
  for (const f of PATCH_FIELDS.global) {
    const v = f.startsWith('arrivals.') ? clean.arrivals?.[f.slice('arrivals.'.length)] : clean[f];
    if (v !== undefined && v !== null) global[f] = v;
  }
  const offer = {
    groups: clean.archetypes.map(a => a.id),
    cast: clean.minds.map(m => m.id),
    places: route ? [] : clean.nodes.filter(n => n.kind === 'service').map(n => n.id)
  };
  return { node, edge, archetype, global, offer };
}

/**
 * Everything the advisor needs from the baseline runs, compact.
 * @param {{ world: object, runs: object[], question?: string, provider?: string }} args
 *   `world` raw or normalized; `runs` from runSeeds, loadRun or the advisor's own baseline.
 * @returns {{ markdown: string, data: object }}
 */
export function buildBrief({ world, runs, question = null, provider = null }) {
  return briefFromViews(world, (runs ?? []).map(runView), question, provider);
}

function briefFromViews(world, allViews, question, provider) {
  const spec = normalizeSpec(world);
  const nameOf = nameLookup(spec);
  const views = allViews.filter(v => v.metrics);
  const mode = spec.mode;
  const data = {
    title: spec.title,
    question: question ?? spec.question,
    context: spec.context,
    mode,
    provider: provider ?? inferProvider(views),
    seeds: views.map(v => v.seed),
    runs: views.map(v => ({ seed: v.seed, runId: v.runId, runDir: v.runDir })),
    people: meanSd(views.map(v => v.metrics.spawned).filter(isNum)).mean,
    kpis: kpiStats(views, mode),
    bottlenecks: bottlenecksOf(views, mode).slice(0, 10),
    doors: doorsOf(views),
    segments: segmentsOf(views, mode, nameOf),
    remarks: remarksOf(views, nameOf),
    torn: tornOf(views, nameOf),
    quality: qualityOf(views),
    assumptions: assumptionsOf(world, spec),
    offers: offersOf(world, spec, views),
    levers: leversOf(spec)
  };
  return { markdown: briefMarkdown(data, nameOf), data };
}

// The provider that made most of the decisions; inline rules runs make none.
function inferProvider(views) {
  const counts = {};
  for (const v of views) for (const [k, n] of Object.entries(v.metrics.decisions?.byProvider ?? {})) counts[k] = (counts[k] ?? 0) + n;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : views.length ? 'rules' : null;
}

function mdTable(headers, rows) {
  const line = cells => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)];
}

const feeling = v => (isNum(v) ? fmtNum(v, 2) : '–');
const placesText = list => (list ?? []).map(p => `${p.name ?? p.id} ${fmtNum(p.visits)}`).join(', ') || '–';

function briefMarkdown(d, nameOf) {
  const out = [`# Brief: ${d.title}`, '', `**Question:** ${d.question}`];
  if (d.context && d.context !== d.title) out.push(`**Setting:** ${d.context}`);
  out.push(`**Runs:** ${d.mode} world · seeds ${d.seeds.join(', ') || '–'} · decided by ${d.provider ?? 'unknown provider'} · about ${fmtInt(d.people)} people per run`);

  out.push('', `## Headline KPIs (mean ± sd across ${d.seeds.length} seed${d.seeds.length === 1 ? '' : 's'})`, '', ...mdTable(
    ['KPI', 'mean ± sd', 'range', 'by seed'],
    Object.entries(d.kpis).map(([k, s]) => [KPI_LABELS[k] ?? k, `${formatKpi(k, s.mean)} ± ${formatKpi(k, s.sd)}`,
      `${formatKpi(k, s.min)}–${formatKpi(k, s.max)}`, s.bySeed.map(v => formatKpi(k, v)).join(', ')])
  ));

  if (d.mode === 'route') {
    out.push('', '## Bottlenecks (mean score = delay minutes)', '', ...mdTable(
      ['#', 'id', 'Road', 'Mean score', '#1 on', 'Delay ratio', 'Peak load', 'Capacity'],
      d.bottlenecks.map((b, i) => [i + 1, b.id, b.name, fmtInt(b.meanScore), `${b.firstOn}/${d.seeds.length}`,
        `${fmtNum(b.delayRatio, 2)}×`, fmtPct(b.peakRatio, 0), fmtInt(b.capacity)])
    ));
  } else {
    out.push('', '## Bottlenecks (mean score = wait minutes + 30 × walk-aways)', '', ...mdTable(
      ['#', 'id', 'Place', 'Mean score', '#1 on', 'Avg wait', 'Walk-aways', 'Utilization', 'Servers', 'Service min'],
      d.bottlenecks.map((b, i) => [i + 1, b.id, b.name, fmtInt(b.meanScore), `${b.firstOn}/${d.seeds.length}`, fmtMin(b.avgWait),
        fmtNum(b.abandoned), fmtPct(b.utilization, 0), fmtInt(b.servers), fmtNum(b.serviceTime)])
    ));
  }

  if (d.doors.length) {
    out.push('', '## Busiest doorways (mean crossings per run)', '', ...mdTable(['id', 'Doorway', 'Crossings', 'Peak per 5 min'],
      d.doors.map(x => [x.id, x.name, fmtInt(x.crossings), fmtInt(x.peakPer5Min)])));
  }

  out.push('', '## Who (segments)', '', SEGMENT_NOTE);
  const castIds = new Set((d.segments?.byCast ?? []).map(s => s.id));
  const kind = s => (castIds.has(s.id) ? 'cast' : 'group');
  if (!d.segments) {
    out.push('These runs did not record segment outcomes; use list_people to look at individual simulated people.');
  } else if (d.mode === 'route') {
    out.push('', '### Who had the worst time (most delay first)', '', ...mdTable(['kind', 'id', 'Segment', 'People', 'Avg trip', 'Avg delay', 'Frustration'],
      d.segments.worstOff.map(s => [kind(s), s.id, s.name, fmtInt(s.count), fmtMin(s.avgTrip), fmtMin(s.avgDelay), feeling(s.avgFrustration)])));
  } else {
    out.push('', '### By group', '', ...mdTable(['id', 'Group', 'People', 'Avg wait', 'Walk-aways/person', 'Never served', 'Avg spent', 'Frustration'],
      d.segments.byGroup.map(s => [s.id, s.name, fmtInt(s.count), fmtMin(s.avgWait), fmtNum(s.walkAwaysPerPerson, 2), fmtPct(s.shareNeverServed, 0), fmtMoney(s.avgSpent), feeling(s.avgFrustration)])));
    out.push('', '### Who had the worst time (wait minutes + 30 × walk-aways per person)', '', ...mdTable(
      ['kind', 'id', 'Segment', 'Group', 'People', 'Avg wait', 'Walk-aways/person', 'Never served', 'Frustration'],
      d.segments.worstOff.map(s => [kind(s), s.id, s.name, s.group ?? '–', fmtInt(s.count), fmtMin(s.avgWait), fmtNum(s.walkAwaysPerPerson, 2), fmtPct(s.shareNeverServed, 0), feeling(s.avgFrustration)])));
    if (d.segments.topSpenders.length) {
      out.push('', '### Who spent the most', '', ...mdTable(['kind', 'id', 'Segment', 'Group', 'People', 'Avg spent', 'Avg visits', 'Top places'],
        d.segments.topSpenders.map(s => [kind(s), s.id, s.name, s.group ?? '–', fmtInt(s.count), fmtMoney(s.avgSpent), fmtNum(s.avgVisits, 2), placesText(s.topPlaces)])));
    }
  }

  const r = d.remarks;
  out.push('', `## What people said (remarks over ${r.runs} run${r.runs === 1 ? '' : 's'})`, '');
  if (!r.total) out.push('No remarks were posted.');
  else {
    const kinds = Object.keys(r.byKind).sort((a, b) => r.byKind[b] - r.byKind[a]);
    out.push(`${fmtInt(r.total)} remarks: ${kinds.map(k => `${k} ${fmtInt(r.byKind[k])}`).join(' · ')}.`, '',
      ...mdTable(['About', 'Total', ...kinds], r.byPlace.map(p => [p.name, fmtInt(p.total), ...kinds.map(k => fmtInt(p.kinds[k] ?? 0))])));
  }

  out.push('', `## Most torn decisions (top two probabilities within ${TORN_GAP})`, '');
  if (!d.torn.scored) out.push('None: these decisions carry no probabilities (rule-based decisions have none).');
  else {
    out.push(`${fmtInt(d.torn.torn)} of ${fmtInt(d.torn.scored)} decisions with probabilities were torn.`);
    for (const t of d.torn.top) {
      out.push(`- ${t.runId} ${t.id} · agent ${t.agentId} (${t.personaId}) · ${t.clock} · ${t.kind}: ${t.situation} → ${t.question}: ${t.probs.join(' · ')}${t.took ? ` → ${t.took}` : ''}`);
    }
  }

  out.push('', '## Walls and decision quality', '');
  const q = d.quality;
  out.push(q.walls ? `Walls: ${fmtInt(q.walls.count)} walls, ${fmtInt(q.walls.checkedMoves)} moves checked, ${fmtInt(q.walls.violations)} violations.` : 'No walls in this world.');
  const rates = q.fallback.filter(f => f.rate != null);
  out.push(rates.length ? `Fallback to rules: ${rates.map(f => `seed ${f.seed} ${fmtPct(f.rate)}`).join(' · ')}.` : 'No external decisions (inline rules): no fallback.');
  for (const w of q.warnings) out.push(w);

  out.push('', '## Assumptions and provenance', '');
  const a = d.assumptions;
  if (a.provenance) {
    out.push(`Provenance of world numbers: ${Object.entries(a.provenance.counts).map(([k, n]) => `${k} ${n}`).join(' · ')}.`);
    if (a.provenance.assumed.length) out.push(`Assumed (${a.provenance.assumedTotal}): ${a.provenance.assumed.join(', ')}${a.provenance.assumedTotal > a.provenance.assumed.length ? ', …' : ''}.`);
  } else {
    out.push('No provenance recorded: every capacity, time, share, price and arrival number in the world is an assumption.');
  }
  if (a.listed.length) out.push('Listed assumptions:', ...a.listed.map(x => `- ${x}`), ...(a.total > a.listed.length ? [`- … and ${a.total - a.listed.length} more`] : []));

  const o = d.offers;
  if (o.current.length || o.results.length) {
    out.push('', '## Offers in the world', '');
    const res = new Map(o.results.map(x => [x.id, x]));
    for (const x of o.current) {
      const m = res.get(x.id);
      out.push(`- ${x.id}: "${x.text}" · to ${JSON.stringify(x.to ?? {})} · place ${x.place ?? '–'} · price off ${isNum(x.priceOff) ? fmtPct(x.priceOff, 0) : '–'}` +
        (m ? ` · reached ${fmtNum(m.reached)}, went to the place ${fmtNum(m.wentToPlace)} per run` : ''));
    }
  }

  const L = d.levers;
  out.push('', '## Levers test_change can set (current values)', '',
    'A patch is a JSON array of operations. Field operation: `{ "kind": "node" | "edge" | "archetype" | "global", "id": "<id>", "field": "<field>", "value": <number> }` (no id for global). Use ids exactly as listed.');
  if (L.node.length) {
    const fields = PATCH_FIELDS.node.filter(f => L.node.some(n => f in n.values));
    out.push('', '### Places (kind "node")', '', ...mdTable(['id', 'name', 'kind', ...fields],
      L.node.map(n => [n.id, n.name, n.kind, ...fields.map(f => (f in n.values ? fmtNum(n.values[f], 2) : '–'))])));
  }
  if (L.edge.length) {
    const fields = PATCH_FIELDS.edge;
    out.push('', '### Links (kind "edge"; closed 1 closes it)', '', ...mdTable(['id', 'name', ...fields],
      L.edge.map(e => [e.id, e.name, ...fields.map(f => (f in e.values ? fmtNum(e.values[f], 2) : '–'))])));
  }
  if (L.archetype.length) {
    const fields = PATCH_FIELDS.archetype.filter(f => L.archetype.some(x => f in x.values));
    out.push('', '### Groups (kind "archetype")', '', ...mdTable(['id', 'name', ...fields],
      L.archetype.map(x => [x.id, x.name, ...fields.map(f => (f in x.values ? fmtNum(x.values[f], 3) : '–'))])));
  }
  out.push('', `### Global (kind "global"): ${Object.entries(L.global).map(([k, v]) => `${k} = ${fmtNum(v, 2)}`).join(' · ') || 'none'}`);
  out.push('', '### Offer (kind "offer")', '',
    'Adds a simulated message, and optionally a discount, for a kind of simulated person: ' +
    '`{ "kind": "offer", "offer": { "id": "<new id>", "text": "<what they are told, at most 160 characters>", "to": { "groups": [<group ids>], "cast": [<cast ids>] }, "place": "<place id or null>", "priceOff": <0..1>, "from": <minute>, "until": <minute> } }`. ' +
    'An empty `to` means everyone. It informs and may discount; it does not force anyone anywhere.',
    `Group ids: ${L.offer.groups.join(', ') || '–'}`,
    `Cast ids: ${L.offer.cast.join(', ') || '–'}`,
    `Place ids: ${L.offer.places.join(', ') || '–'}`);
  return out.join('\n') + '\n';
}

// ---------- measuring a change ----------

async function measureChange(ctx, patch, provider) {
  const res = await compareRuns({ spec: ctx.spec, patch, seeds: ctx.seeds, provider, simOpts: ctx.simOpts });
  // compareRuns runs the seeds in order on each side, so the per-seed metrics pair up seed by seed.
  const effects = changeEffects({
    mode: ctx.mode, before: res.runs.before.map(r => r.metrics), after: res.runs.after.map(r => r.metrics), offers: res.offers
  });
  const afterScores = new Map(res.after.places.map(p => [p.id, p.meanScore]));
  return {
    testedWith: provider.name,
    seeds: [...ctx.seeds],
    baseSpecHash: ctx.baseHash,
    applied: res.applied,
    skipped: res.skipped,
    kpis: effects.kpis,
    verdict: effects.verdict,
    holdsAcrossSeeds: effects.holdsAcrossSeeds,
    bottlenecks: {
      before: res.before.places.slice(0, 5).map(p => ({ id: p.id, name: p.name, before: p.meanScore, after: afterScores.get(p.id) ?? 0 })),
      topAfter: res.after.places.slice(0, 3).map(p => ({ id: p.id, name: p.name, score: p.meanScore }))
    },
    segments: effects.segments,
    offers: effects.offers
  };
}

// A measure by key: a headline KPI, `group:<id>.<field>`, `cast:<id>.<field>`, `place:<id>.arrivals`,
// `offer:<id>.reached` or `offer:<id>.wentToPlace` (after only).
function lookupMeasure(exp, key) {
  if (!exp || !isText(key)) return null;
  if (exp.kpis?.[key]) return exp.kpis[key];
  const seg = /^(group|cast):(.+)\.(\w+)$/.exec(key);
  if (seg) return exp.segments?.[seg[1] === 'group' ? 'byGroup' : 'byCast']?.find(s => s.id === seg[2])?.fields?.[seg[3]] ?? null;
  const place = /^place:(.+)\.arrivals$/.exec(key);
  if (place) return exp.offers?.find(o => o.place === place[1])?.placeArrivals ?? null;
  const offer = /^offer:(.+)\.(reached|wentToPlace)$/.exec(key);
  if (offer) {
    const v = exp.offers?.find(o => o.id === offer[1])?.[offer[2]];
    return isNum(v) ? { before: null, after: v, change: null, spread: null, beyondSpread: false, holdsAcrossSeeds: false, verdict: 'after only' } : null;
  }
  return null;
}

const effectEntry = m => ({ before: m.before, after: m.after, change: m.change, spread: m.spread });

// ---------- formatting shared by advice.md and the CLI ----------
const fieldOf = key => String(key).split('.').pop();
const PCT_FIELDS = new Set(['abandonRate', 'shareNeverServed']);
const MIN_FIELDS = new Set(['avgWait', 'avgTrip', 'avgDelay']);
const FIELD_LABELS = {
  walkAwaysPerPerson: 'walk-aways per person', shareNeverServed: 'never served', avgSpent: 'avg spent', avgVisits: 'avg visits',
  avgFrustration: 'frustration', arrivals: 'arrivals', reached: 'reached', wentToPlace: 'went to the place'
};

export function fmtValue(key, v) {
  const f = fieldOf(key);
  if (!isNum(v)) return '–';
  if (PCT_FIELDS.has(f)) return fmtPct(v);
  if (MIN_FIELDS.has(f)) return fmtMin(v);
  if (f === 'avgSpent') return fmtMoney(v);
  if (['walkAwaysPerPerson', 'avgVisits', 'avgFrustration'].includes(f)) return fmtNum(v, 2);
  return fmtNum(v);
}

function fmtAmount(key, v) {
  return PCT_FIELDS.has(fieldOf(key)) ? `${(Math.abs(v) * 100).toFixed(1)} pts` : fmtValue(key, Math.abs(v));
}

export function fmtChange(key, d) {
  if (!isNum(d)) return '–';
  return `${d > 0 ? '+' : d < 0 ? '-' : '±'}${fmtAmount(key, d)}`;
}

export function keyLabel(key) {
  if (KPI_LABELS[key]) return KPI_LABELS[key];
  const m = /^(group|cast|place|offer):(.+)\.(\w+)$/.exec(key);
  if (!m) return key;
  return `${m[2]} · ${FIELD_LABELS[m[3]] ?? KPI_LABELS[m[3]] ?? m[3]}`;
}

// "abandon rate 12.0% → 8.1% (-3.9 pts; spread 1.2 pts, 3/3 seeds)"
export function effectText(key, m) {
  if (!m) return `${keyLabel(key)} –`;
  if (m.before == null) return `${keyLabel(key)} ${fmtValue(key, m.after)} (after the change)`;
  const seeds = Array.isArray(m.bySeed) && m.bySeed.length > 1
    ? `, ${m.bySeed.filter(d => Math.sign(d) === Math.sign(m.change) && d !== 0).length}/${m.bySeed.length} seeds same way` : '';
  return `${keyLabel(key)} ${fmtValue(key, m.before)} → ${fmtValue(key, m.after)} (${fmtChange(key, m.change)}; spread ${fmtAmount(key, m.spread ?? 0)}${seeds})`;
}

// ---------- the agent loop ----------

const SYSTEM_PROMPT = `You are the Swarmscope advisor. Swarmscope simulates a crowd: every simulated person decides where to go, whether to wait in a line, when to give up and what to tell others. A baseline has already been simulated; the brief in the first message summarizes it. Your job is to help the user fix what the run found, not only describe it.

How to work:
1. Read the brief and the user's question.
2. Choose changes that could answer it. Use only the levers listed in the brief, with ids and fields exactly as listed. For questions about kinds of people (who waits most, who walks away, who spends the most), use the "Who" tables, list_people and look_at_person, and consider testing an offer aimed at that kind of person.
3. Test each change with test_change. It runs the changed world on the same seeds as the brief (the same simulated crowd) and returns before, after, the change and the spread across seeds. Give every test a short label and say why you are trying it. Tests are limited: spend them on the changes most likely to answer the question; put several operations in one patch to test them together.
4. Call finish once with your advice.

One day or several:
${TIMESCALE_RULE}
- test_change is the one-day test. test_over_days is the test over days. The first message says whether test_over_days can run for this world.
- Decide from the question, before testing. A question about the day gets test_change only. A question about later days needs test_over_days: a one-day result cannot answer it, and you must say so if test_over_days cannot run (under what you could not test, with what is missing).
- A change can deserve both: test_change for what it does on the day, then test_over_days for whether it lasts.
- Cite a test over days in your answer and findings as "test over days W1" (W2, ...). Recommendations still cite one-day experiments by number.

Rules:
- Answer the user's question first, in plain words.
- Report a change as helping only if its effect is larger than the spread across seeds, in the better direction. A smaller effect is "no clear effect", whatever its sign.
- Give rankings under stated assumptions, not forecasts. Do not say "the wait will be 12 minutes"; say "cut the average wait by about a third on these seeds". Name the assumptions your answer depends on.
- Segments are kinds of simulated people (a group, or everyone who copies one cast member), never real individuals. An offer is a simulated message to a kind of simulated person. Never suggest identifying, tracking or targeting real individuals.
- Say what you could not test and why: no lever for it, out of tests, or outside what the simulator models.
- Recommend only changes you tested, each cited by its experiment number. Quote only numbers that appear in the brief or in tool results.
- Keep text between tool calls to a sentence or two.`;

const STRING_LIST = { type: 'array', items: { type: 'string' } };

const PATCH_OP = {
  type: 'object',
  description: 'One operation. Field operation: { kind, id, field, value }. Offer operation: { kind: "offer", offer }.',
  properties: {
    kind: { type: 'string', enum: ['node', 'edge', 'archetype', 'global', 'offer'] },
    id: { type: 'string', description: 'Place, link ("from>to") or group id from the levers table. Omit for global and offer.' },
    field: { type: 'string', description: 'A field listed for that lever, e.g. "servers"; for global, e.g. "arrivals.end".' },
    value: { type: 'number', description: 'The new value.' },
    offer: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'A new offer id.' },
        text: { type: 'string', description: 'What the person is told, at most 160 characters.' },
        to: {
          type: 'object',
          description: 'Who receives it. Empty means everyone.',
          properties: { groups: STRING_LIST, cast: STRING_LIST }
        },
        place: { type: 'string', description: 'The place id the offer is about.' },
        priceOff: { type: 'number', minimum: 0, maximum: 1, description: 'Discount at that place for these people, 0..1.' },
        from: { type: 'number', description: 'Start of the window, minutes from the start.' },
        until: { type: 'number', description: 'End of the window, minutes from the start.' }
      },
      required: ['id', 'text']
    }
  },
  required: ['kind']
};

const TOOLS = [
  {
    name: 'test_change',
    description: 'Run the world with a patch on the same seeds as the brief and return before, after, the change and the spread across seeds ' +
      'for the headline KPIs, the top bottlenecks, segment outcomes and offer results. A patch that applies nothing is not run and uses no test.',
    input_schema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Short name for the change, e.g. "Two more baristas at the coffee kiosk".' },
        why: { type: 'string', description: 'Why this change is worth testing, in one sentence.' },
        patch: { type: 'array', minItems: 1, items: PATCH_OP }
      },
      required: ['label', 'why', 'patch']
    }
  },
  {
    name: 'look_at_person',
    description: "One simulated person in a baseline run: persona, outcome, decisions with probabilities, and trace.",
    input_schema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'A baseline run id from the brief. Default: the first run.' },
        agentId: { type: 'integer', description: 'The agent id, e.g. from list_people.' }
      },
      required: ['agentId']
    }
  },
  {
    name: 'list_people',
    description: 'Find simulated people in the baseline runs, sorted by an outcome, to look at with look_at_person.',
    input_schema: {
      type: 'object',
      properties: {
        segment: { type: 'string', description: 'A group id, a cast id, or "all" (default).' },
        sortBy: { type: 'string', enum: ['wait', 'walkAways', 'neverServed', 'spent', 'visits', 'frustration', 'delay', 'trip'] },
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Default 10.' }
      },
      required: ['sortBy']
    }
  },
  {
    name: 'test_over_days',
    description: 'Play the same people over two weeks, with and without one change at the shop the pool is about, on the same seeds. ' +
      'Returns visits per week, regulars, first-time visitors, first-timers who came back, walk-aways and the average wait: before, after, ' +
      'the range across seeds and whether every seed agrees. For questions about later days only; see "One day or several". Results are unvalidated in size.',
    input_schema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Short name for the change, e.g. "One more barista, over two weeks".' },
        why: { type: 'string', description: 'Why this needs a test over days and not a one-day test, in one sentence.' },
        change: {
          type: 'string', enum: ['staff', 'price', 'promotion', 'stamp_card'],
          description: 'staff: more people serving. price: a new price. promotion: a percentage off for the first week. stamp_card: buy N-1, the Nth is free.'
        },
        value: { type: 'number', description: 'staff: how many more (1). price: the change in dollars, e.g. 0.5 or -0.5. promotion: percent off, e.g. 20. stamp_card: N, e.g. 10.' }
      },
      required: ['label', 'why', 'change', 'value']
    }
  },
  {
    name: 'finish',
    description: 'End with your advice. Recommend only tested changes, cited by experiment number; the measured numbers are attached by the simulator.',
    input_schema: {
      type: 'object',
      properties: {
        answer: { type: 'string', description: "The answer to the user's question, first, in plain words." },
        findings: { ...STRING_LIST, description: 'What the runs and experiments showed, one point each.' },
        recommendations: {
          type: 'array',
          description: 'Ranked best first.',
          items: {
            type: 'object',
            properties: {
              experiment: { type: 'integer', description: 'The experiment number that tested this change.' },
              label: { type: 'string' },
              why: { type: 'string', description: 'Why it helps, citing the measured effect.' },
              kpi: { type: 'string', description: 'The measure you judge it by: a headline KPI (e.g. "abandonRate"), or "group:<id>.<field>", "cast:<id>.<field>", "place:<id>.arrivals".' },
              better: {
                type: 'string', enum: ['lower', 'higher'],
                description: 'Which direction of that measure is better. Needed for measures with no fixed direction (avgSpent, avgVisits, place arrivals); without it such a change is not counted as helping.'
              },
              confidence: { type: 'string', enum: CONFIDENCE },
              costNote: { type: 'string', description: 'What the change costs or takes in the real world, if known.' }
            },
            required: ['experiment', 'label', 'why', 'confidence']
          }
        },
        cautions: { ...STRING_LIST, description: 'Assumptions the answer depends on, and limits.' },
        couldNotTest: { ...STRING_LIST, description: 'What you could not test, and why.' },
        nextSteps: { ...STRING_LIST, description: 'What the user could try or decide next.' }
      },
      required: ['answer', 'findings', 'recommendations', 'cautions', 'couldNotTest', 'nextSteps']
    }
  }
].map(tool => ({ ...tool, eager_input_streaming: true }));

// After a mid-stream fallback, blocks the declined model wrote before the `fallback` block must not be
// echoed back, except text; the `fallback` block itself stays where it appeared.
function echoable(content) {
  const boundary = content.findLastIndex(b => b.type === 'fallback');
  if (boundary < 0) return content;
  return content.filter((b, i) => i >= boundary || b.type === 'text');
}

function redactor(secrets) {
  return text => {
    let s = String(text);
    for (const k of secrets) s = s.split(k).join('[redacted]');
    return s;
  };
}

function redactDeep(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(v => redactDeep(v, redact));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, redact)]));
  return value;
}

function redactError(err, redact) {
  if (err && typeof err === 'object') {
    try {
      if (typeof err.message === 'string') err.message = redact(err.message);
      if (typeof err.stack === 'string') err.stack = redact(err.stack);
    } catch {
      // A frozen error object: rethrow it as it is.
    }
  }
  return err;
}

// What the test over days runs with. A provider object is used as given (tests pass one). Otherwise Jev: the
// experiments' own provider if that is Jev, or the confirming one, or a new one when a key is set.
function daysSetup({ pool, daysProvider, expProvider, confirmProvider, spec, seeds, days, maxDaysTests }) {
  const none = { pool: null, provider: null, tests: [], max: 0, baselines: null };
  if (!pool || spec.mode !== 'visit') return none;
  let normal, shopName;
  try {
    normal = normalizePool(pool);
    shopName = shopView(spec, normal.shop).shop.name;
  } catch { return none; }
  let provider = null;
  if (daysProvider !== undefined) provider = daysProvider;
  else if (expProvider.name === 'jev') provider = expProvider;
  else if (confirmProvider?.name === 'jev') provider = confirmProvider;
  else if (hasKey('TYPESAFE_API_KEY')) { try { provider = makeProvider('jev'); } catch { provider = null; } }
  return {
    pool: normal, shopName, provider, days: Math.max(5, Math.min(20, Math.round(Number(days) || 10))), seeds: seeds.slice(0, 3),
    tests: [], max: Math.max(0, Math.min(3, Math.round(Number(maxDaysTests) || 1))), baselines: null
  };
}

function providerInstance(p, label) {
  if (p && typeof p === 'object' && typeof p.decideMany === 'function') return p;
  if (!isText(p)) throw new Error(`${label} must be a provider name (rules or jev) or a provider object.`);
  return makeProvider(p);
}

// The advisor's own baseline when none is passed in: runs kept in memory, with the per-person records
// look_at_person and list_people need.
async function runBaseline(spec, seeds, provider, simOpts) {
  const kept = new Map();
  const recorderFor = seed => {
    const decisions = [];
    return {
      runId: null,
      dir: null,
      decision(req, decision, applied) {
        decisions.push({
          id: req.id, clock: req.clock, agentId: req.agentId, personaId: req.personaId, kind: req.kind, why: req.why,
          placeId: req.placeId, options: req.options, asks: req.asks,
          observation: { now: req.observation?.now, trip: req.observation?.trip },
          decision: { provider: decision?.provider, choiceProbs: decision?.choiceProbs, yesProb: decision?.yesProb }, applied
        });
      },
      finish({ sim }) {
        if (sim) kept.set(seed, { agents: sim.agentsSummary(), remarks: sim.remarks, decisions });
      }
    };
  };
  const { runs } = await runSeeds({ spec, seeds, provider, recorderFor, simOpts });
  return runs.map(r => ({ ...r, runId: `baseline-s${r.seed}`, ...kept.get(r.seed) }));
}

function checkTestChange(input) {
  if (!isObj(input)) return 'The input must be an object with label, why and patch.';
  if (!isText(input.label)) return 'label is missing: give the change a short name.';
  if (!isText(input.why)) return 'why is missing: every test must say why it is being tried.';
  if (!Array.isArray(input.patch) || !input.patch.length) return 'patch must be a non-empty array of operations.';
  if (!input.patch.every(isObj)) return 'every patch operation must be an object.';
  return null;
}

function checkFinish(input) {
  if (!isObj(input)) return 'The input must be an object.';
  if (!isText(input.answer)) return 'answer is missing: answer the question first, in plain words.';
  if (input.recommendations !== undefined && !Array.isArray(input.recommendations)) return 'recommendations must be an array.';
  for (const k of ['findings', 'cautions', 'couldNotTest', 'nextSteps']) {
    if (input[k] !== undefined && !Array.isArray(input[k])) return `${k} must be an array of strings.`;
  }
  return null;
}

function compactMeasure(m) {
  if (!m) return null;
  return { before: m.before, after: m.after, change: m.change, spread: m.spread, bySeed: m.bySeed, verdict: m.verdict };
}

// A segment's measured fields; for an offer's audience also where they went (visits per run at top places).
function segmentForModel(s, withPlaces) {
  return {
    id: s.id, name: s.name, ...Object.fromEntries(Object.entries(s.fields).map(([f, m]) => [f, compactMeasure(m)])),
    ...(withPlaces && s.places?.length ? { whereTheyWent: s.places.slice(0, 4) } : {})
  };
}

function experimentForModel(e, testsLeft) {
  const targets = new Set((e.offers ?? []).flatMap(o => [...(o.to?.groups ?? []), ...(o.to?.cast ?? [])]));
  return rounded({
    experiment: e.n,
    label: e.label,
    testedWith: e.testedWith,
    seeds: e.seeds,
    applied: e.applied,
    skipped: e.skipped?.length ? e.skipped : undefined,
    kpis: Object.fromEntries(Object.entries(e.kpis).map(([k, m]) => [k, compactMeasure(m)])),
    verdict: e.verdict,
    holdsAcrossSeeds: e.holdsAcrossSeeds,
    bottlenecks: e.bottlenecks,
    segments: e.segments ? {
      byGroup: e.segments.byGroup.map(s => segmentForModel(s, targets.has(s.id))),
      byCast: e.segments.byCast.length ? e.segments.byCast.map(s => segmentForModel(s, true)) : undefined
    } : undefined,
    offers: e.offers?.length ? e.offers.map(o => ({ ...o, placeArrivals: compactMeasure(o.placeArrivals) })) : undefined,
    testsLeft,
    note: 'spread = the larger seed-to-seed standard deviation of before and after. A change counts as helping only when |change| > spread in the better direction.'
  });
}

function earlierBlock(previous) {
  const lines = ['<earlier_advice>', clip(previous.answer ?? '', 1500)];
  for (const r of previous.recommendations ?? []) {
    lines.push(`- Recommended #${r.experiment ?? '?'} ${r.label} (confidence ${r.confidence ?? '–'})`);
  }
  for (const c of (previous.cautions ?? []).slice(0, 8)) lines.push(`- Caution: ${clip(c, 300)}`);
  for (const s of (previous.nextSteps ?? []).slice(0, 8)) lines.push(`- Next step: ${clip(s, 300)}`);
  lines.push('</earlier_advice>', '', '<earlier_experiments>');
  for (const e of previous.experiments ?? []) {
    const kpis = Object.entries(e.kpis ?? {}).filter(([k]) => KPI_LABELS[k] && k !== 'spawned')
      .map(([k, m]) => effectText(k, m)).join(' · ');
    lines.push(`#${e.n} (round ${e.round ?? 1}, ${e.testedWith}${e.confirms ? `, confirms #${e.confirms}` : ''}) ${e.label}. Why: ${clip(e.why, 300)}. ` +
      `Patch: ${clip(JSON.stringify(e.patch), 600)}. ${kpis}. Verdict: ${e.verdict}.`);
  }
  lines.push('</earlier_experiments>');
  return lines.join('\n');
}

function firstMessage({ brief, question, maxExperiments, seeds, providerName, previous, followUp, startN, overDays = null }) {
  const parts = [
    `<brief>\n${brief}</brief>`, '',
    `<question>\n${question}\n</question>`, '',
    `You have ${maxExperiments} test${maxExperiments === 1 ? '' : 's'} in this round. Each test_change runs the changed world on seeds ` +
      `${seeds.join(', ')} with the ${providerName} provider: the same simulated crowd as the brief.`,
    '', overDaysLine(overDays)
  ];
  if (previous) {
    parts.push('', earlierBlock(previous), '', `<user_reply>\n${followUp}\n</user_reply>`, '',
      "This is a follow-up. Answer the user's reply first. Earlier experiments keep their numbers and can be cited without re-running them; " +
      `new tests are numbered from #${startN}. Return the full updated advice with finish.`);
  }
  return parts.join('\n');
}

const SORTS = {
  wait: a => a.waitTotal ?? 0,
  walkAways: a => a.abandons ?? 0,
  neverServed: a => (a.served ? 0 : 1e6) + (a.waitTotal ?? 0),
  spent: a => spentOf(a) ?? -1,
  visits: a => visitsOf(a)?.length ?? a.served ?? 0,
  frustration: a => a.frustration ?? -1,
  delay: a => a.delay ?? 0,
  trip: a => a.trip ?? 0
};

function listPeople(ctx, input) {
  const sortBy = SORTS[input?.sortBy] ? input.sortBy : null;
  if (!sortBy) return { isError: true, content: `sortBy must be one of: ${Object.keys(SORTS).join(', ')}.` };
  const limit = Math.min(25, Math.max(1, Number.isInteger(input.limit) ? input.limit : 10));
  const want = isText(input.segment) ? input.segment.trim() : 'all';
  const group = ctx.spec.archetypes.find(a => a.id === want || a.name === want);
  const persona = group ? null : ctx.spec.minds.find(m => m.id === want || m.name === want);
  if (!group && !persona && !['all', 'everyone'].includes(want.toLowerCase())) {
    return {
      isError: true,
      content: `No segment "${want}". Group ids: ${ctx.spec.archetypes.map(a => a.id).join(', ')}. Cast ids: ${ctx.spec.minds.map(m => m.id).join(', ')}. Or "all".`
    };
  }
  const groupName = new Map(ctx.spec.archetypes.map(a => [a.id, a.name]));
  const nameOf = nameLookup(ctx.spec);
  const people = [];
  for (const v of ctx.views) {
    const agents = v.agents;
    if (!Array.isArray(agents)) continue;
    for (const a of agents) {
      if (group && a.archetypeId !== group.id) continue;
      if (persona && a.personaId !== persona.id) continue;
      people.push({ v, a });
    }
  }
  if (!people.length) {
    const none = ctx.views.every(v => !Array.isArray(v.agents));
    return { isError: true, content: none ? 'These baseline runs kept no per-person records.' : `Nobody in segment "${want}".` };
  }
  people.sort((p, q) => SORTS[sortBy](q.a) - SORTS[sortBy](p.a));
  const noSpending = people.every(p => spentOf(p.a) == null);
  ctx.step({ type: 'list', segment: want, sortBy, count: people.length });
  return {
    content: JSON.stringify(rounded({
      segment: group ? { kind: 'group', id: group.id, name: group.name } : persona ? { kind: 'cast', id: persona.id, name: persona.name } : { kind: 'all' },
      sortBy,
      matched: people.length,
      note: [SEGMENT_NOTE, noSpending ? 'These runs did not record spending or visit lists.' : null].filter(Boolean).join(' '),
      people: people.slice(0, limit).map(({ v, a }) => ({
        runId: v.runId, agentId: a.id, persona: a.personaId, personaName: a.personaName, group: groupName.get(a.archetypeId) ?? a.archetypeId,
        served: a.served, waitTotal: a.waitTotal, walkAways: a.abandons, spent: spentOf(a) ?? undefined,
        visits: visitsOf(a)?.map(nameOf), frustration: a.frustration ?? undefined,
        trip: a.trip ?? undefined, delay: a.delay ?? undefined
      }))
    }))
  };
}

function lookAtPerson(ctx, input) {
  const agentId = Number(input?.agentId);
  if (!Number.isInteger(agentId)) return { isError: true, content: 'agentId must be a whole number (find one with list_people).' };
  const ids = ctx.views.map(v => v.runId);
  const want = input.runId == null || input.runId === '' ? null : String(input.runId);
  const view = want ? ctx.views.find(v => v.runId === want || String(v.seed) === want) : ctx.views[0];
  if (!view) return { isError: true, content: `No baseline run "${want}". Runs: ${ids.join(', ')}.` };
  const agents = view.agents;
  if (!Array.isArray(agents)) return { isError: true, content: `Run ${view.runId} kept no per-person records.` };
  const agent = agents.find(a => a.id === agentId);
  if (!agent) return { isError: true, content: `Agent ${agentId} is not in run ${view.runId} (${agents.length} agents).` };
  const spec = ctx.spec;
  const nameOf = nameLookup(spec);
  const persona = spec.minds.find(m => m.id === agent.personaId);
  const decisions = view.decisions.filter(d => String(d.agentId) === String(agentId)).slice(0, 20).map(d => {
    const p = primaryProbs(d);
    const yesNo = p && p.question === d.asks?.yesNo;
    return {
      id: d.id, clock: d.clock, kind: d.kind, why: d.why ?? undefined,
      situation: clip(d.observation?.now ?? d.observation?.trip ?? '', 200) || undefined,
      probs: p ? `${p.question}: ${p.probs.slice(0, 4).map(([k, q]) => `${yesNo ? k : nameOf(k)} ${Math.round(q * 100)}%`).join(' · ')}` : undefined,
      took: d.applied?.summary ?? undefined,
      provider: d.decision?.provider
    };
  });
  ctx.step({ type: 'look', runId: view.runId, agentId });
  return {
    content: JSON.stringify(rounded({
      runId: view.runId,
      agentId,
      note: 'A simulated person, not a real individual.',
      persona: persona ? pick(persona, ['id', 'name', 'age', 'bio', 'personality', 'goal', 'social', 'informed']) : { id: agent.personaId, name: agent.personaName },
      group: spec.archetypes.find(a => a.id === agent.archetypeId)?.name ?? agent.archetypeId,
      outcome: {
        served: agent.served, waitTotal: agent.waitTotal, walkAways: agent.abandons, frustration: agent.frustration ?? undefined,
        spent: spentOf(agent) ?? undefined, visits: visitsOf(agent)?.map(nameOf), informed: agent.informed,
        arrived: isNum(agent.born) ? clockText(spec, agent.born) : undefined, done: isNum(agent.done) ? clockText(spec, agent.done) : undefined,
        trip: agent.trip ?? undefined, delay: agent.delay ?? undefined
      },
      decisions,
      trace: (agent.trace ?? []).slice(-25).map(s => `${isNum(s.t) ? clockText(spec, s.t) : '–'} ${s.m}`)
    }))
  };
}

// What the first message says about the test over days: whether it can run here, and if not, what is missing.
function overDaysLine(d) {
  if (!d?.pool) return 'test_over_days cannot run for this world: it has no pool (who the regular customers are and how often each kind comes). If the question is about later days, say that this is what is missing.';
  if (!d.provider) return 'test_over_days cannot run now: it needs Jev, and no Jev key is set. The rule model does not read memory, so it cannot answer a question about later days.';
  return `test_over_days can run: a pool of ${d.pool.size} people for ${d.shopName}, ${d.days} mornings on seeds ${d.seeds.join(', ')}, decided by Jev. ` +
    `You have ${d.max} of these in this round; each costs many times a one-day test.`;
}

const DAYS_CHANGE = {
  staff: v => (Number.isInteger(v) && v >= 1 && v <= 5 ? `staff+${v}` : null),
  price: v => (Number.isFinite(v) && v !== 0 && Math.abs(v) <= 20 ? `price${v > 0 ? '+' : ''}${v}` : null),
  promotion: v => (Number.isFinite(v) && v >= 1 && v <= 90 ? `promo${Math.round(v)}` : null),
  stamp_card: v => (Number.isInteger(v) && v >= 2 && v <= 30 ? `card${v}` : null)
};

// The same people over days, with and without one change (run/days.js). The baseline is run once and kept.
async function testOverDays(ctx, input) {
  const d = ctx.days;
  if (!isText(input?.label) || !isText(input?.why)) return { isError: true, content: 'test_over_days needs a label and a why.' };
  if (!d.pool) return { isError: true, content: 'Nothing was run: this world has no pool of regular customers, so the same people cannot be followed over days. Put the question under what you could not test, and say what is missing: how often each kind of customer comes.' };
  if (!d.provider) return { isError: true, content: 'Nothing was run: a test over days needs Jev, and no Jev key is set. The rule model does not read memory. Put this under what you could not test.' };
  if (d.tests.length >= d.max) return { isError: true, content: `Nothing was run: all ${d.max} tests over days in this round are used.` };
  const name = DAYS_CHANGE[input.change]?.(Number(input.value));
  if (!name) return { isError: true, content: 'Nothing was run: change must be staff, price, promotion or stamp_card, with a value in range (see the tool description).' };
  const { compareDays, changeFor } = await import('./days.js');
  const change = changeFor(name, ctx.spec, d.pool.shop, d.days);
  const id = `W${d.tests.length + 1}`;
  ctx.step({ type: 'days', id, label: input.label, why: input.why, change: change.label });
  const res = await compareDays({ pool: d.pool, spec: ctx.spec, days: d.days, seeds: d.seeds, provider: d.provider, changes: [change], baselines: d.baselines });
  d.baselines = res.baselines;
  const effects = Object.fromEntries(Object.entries(res.results[0].effects).map(([k, e]) => [k, rounded({ before: e.before, after: e.after, change: e.mean, least: e.min, most: e.max, everySeedAgrees: e.agrees })]));
  const checks = res.baselines.map(b => b.realism);
  const record = {
    id, label: input.label.trim(), why: input.why.trim(), change: change.label, days: d.days, seeds: d.seeds, effects,
    baselineHoldsSteady: checks.every(c => c.steady.pass !== false), visitsLopsided: checks.every(c => c.lopsided.pass !== false)
  };
  d.tests.push(record);
  ctx.step({ type: 'days-result', id, label: record.label, effects });
  return {
    content: JSON.stringify({
      ...record, testsOverDaysLeft: d.max - d.tests.length,
      read: 'Report a measure as changed only where everySeedAgrees is true. A week is 5 mornings. ' +
        "Sizes are unvalidated: every usual visit rate in the pool is an assumption and Jev's sensitivity to waits is unchecked. Give direction and range, and say so." +
        (record.baselineHoldsSteady ? '' : ' The baseline did not hold steady on every seed, so treat changes in visits with extra caution.')
    })
  };
}

async function testChange(ctx, input) {
  const problem = checkTestChange(input);
  if (problem) return { isError: true, content: problem };
  if (ctx.newCount >= ctx.maxExperiments) {
    return {
      isError: true,
      content: `Experiment limit reached: all ${ctx.maxExperiments} tests in this round are used, so nothing was run. Call finish now with what you have.`
    };
  }
  const { applied, skipped } = applyPatch(ctx.spec, input.patch);
  if (!applied.length) {
    ctx.step({ type: 'rejected', label: input.label, reason: 'the patch applied nothing', skipped });
    return {
      isError: true,
      content: `This patch applied nothing, so nothing was run and no test was used. Skipped operations: ${clip(JSON.stringify(skipped), 800)}. ` +
        'Use only the levers listed in the brief, with ids and fields exactly as listed and a number for value.'
    };
  }
  const n = ctx.nextN++;
  ctx.newCount++;
  ctx.step({ type: 'test', n, label: input.label, why: input.why, patch: input.patch, applied, skipped });
  const measured = await measureChange(ctx, input.patch, ctx.expProvider);
  const record = { n, round: ctx.round, label: input.label.trim(), why: input.why.trim(), patch: input.patch, ...measured };
  ctx.experiments.push(record);
  ctx.step({ type: 'result', n, label: record.label, applied, skipped, kpis: record.kpis, verdict: record.verdict, testedWith: record.testedWith, mode: ctx.mode });
  return { content: JSON.stringify(experimentForModel(record, ctx.maxExperiments - ctx.newCount)) };
}

// Re-runs the top recommended experiments with the confirming provider and compares directions.
async function confirmRecommendations(ctx, recs) {
  const out = [];
  for (const r of (recs ?? []).slice(0, CONFIRM_TOP)) {
    const exp = ctx.experiments.find(e => e.n === Number(r?.experiment) && !e.confirms);
    if (!exp) continue;
    if (!ctx.confirmations.has(exp.n)) {
      const provider = ctx.confirmProvider;
      ctx.step({ type: 'confirm', n: exp.n, label: exp.label, provider: provider.name });
      const measured = await measureChange(ctx, exp.patch, provider);
      const record = {
        n: ctx.nextN++, round: ctx.round, label: `${exp.label} (confirmation with ${provider.name})`,
        why: `Re-run of experiment #${exp.n} with ${provider.name} on the same seeds.`, patch: exp.patch, confirms: exp.n, ...measured
      };
      ctx.experiments.push(record);
      const keys = [...KPI_NAMES[ctx.mode], ...(isText(r.kpi) && !KPI_NAMES[ctx.mode].includes(r.kpi) ? [r.kpi] : [])];
      const disagreeOn = keys.filter(k => {
        const a = lookupMeasure(exp, k), b = lookupMeasure(record, k);
        return a && b && isNum(a.change) && isNum(b.change) && Math.sign(a.change) * Math.sign(b.change) < 0 && (a.beyondSpread || b.beyondSpread);
      });
      ctx.confirmations.set(exp.n, { record, agrees: !disagreeOn.length, disagreeOn });
      ctx.step({ type: 'confirmed', n: exp.n, label: exp.label, provider: provider.name, kpis: record.kpis, agrees: !disagreeOn.length, disagreeOn, mode: ctx.mode });
    }
    out.push({ exp, ...ctx.confirmations.get(exp.n) });
  }
  return out;
}

function confirmationText(ctx, confirmed) {
  if (!confirmed.length) return 'None of the recommendations cites a valid experiment, so nothing was confirmed. Call finish again, citing experiment numbers.';
  return JSON.stringify(rounded({
    confirmations: confirmed.map(c => ({
      experiment: c.exp.n,
      label: c.exp.label,
      [c.exp.testedWith]: Object.fromEntries(HEADLINE[ctx.mode].map(k => [k, compactMeasure(c.exp.kpis[k])])),
      [c.record.testedWith]: Object.fromEntries(HEADLINE[ctx.mode].map(k => [k, compactMeasure(c.record.kpis[k])])),
      agrees: c.agrees,
      disagreeOn: c.disagreeOn
    })),
    instruction: `These are the recommended changes re-run with ${ctx.confirmProvider.name} on the same seeds. Call finish again with your final advice. ` +
      'Where the two providers disagree on direction, say so plainly and lower your confidence.'
  }));
}

function capConfidence(asked, cap) {
  const a = CONFIDENCE.includes(asked) ? asked : 'medium';
  return CONFIDENCE[Math.min(CONFIDENCE.indexOf(a), CONFIDENCE.indexOf(cap))];
}

// Builds one recommendation from the experiment it cites. Returns { rec, cautions } or null when untested.
function recommendationFrom(ctx, r) {
  const exp = ctx.experiments.find(e => e.n === Number(r?.experiment) && !e.confirms);
  if (!exp) return null;
  const headline = HEADLINE[ctx.mode];
  const named = isText(r.kpi) && lookupMeasure(exp, r.kpi) ? r.kpi : null;
  const primaryKey = named ?? headline.find(k => exp.kpis[k]?.verdict === 'better') ?? headline[0];
  const primary = lookupMeasure(exp, primaryKey);
  const better = r.better === 'lower' ? -1 : r.better === 'higher' ? 1 : BETTER[fieldOf(primaryKey)] ?? 0;
  const moved = !!primary?.beyondSpread;
  // A measure with no fixed direction (spending, visits, arrivals at a place) helps only in the direction the
  // recommendation names with `better`.
  const helps = moved && better !== 0 && Math.sign(primary.change) === better;
  // The helpful effect shows up on every seed, not merely a change that keeps one sign.
  const holds = helps && !!primary?.holdsAcrossSeeds;
  const confirmation = ctx.confirmations.get(exp.n) ?? null;
  let cap = !helps ? 'low' : holds && ctx.seeds.length >= 3 ? 'high' : 'medium';
  if (confirmation && !confirmation.agrees) cap = 'low';

  const keys = [...KPI_NAMES[ctx.mode].filter(k => k !== 'spawned'), ...(named && !KPI_NAMES[ctx.mode].includes(named) ? [named] : [])];
  const effect = Object.fromEntries(keys.map(k => [k, lookupMeasure(exp, k)]).filter(([, m]) => m && m.before != null).map(([k, m]) => [k, effectEntry(m)]));
  const cautions = [];
  if (primary && !helps && primary.before != null) {
    cautions.push(moved && better === 0
      ? `${r.label || exp.label}: ${keyLabel(primaryKey)} moved ${fmtChange(primaryKey, primary.change)} (beyond the ${fmtAmount(primaryKey, primary.spread ?? 0)} spread across seeds), ` +
        'but no better direction was given for that measure, so it is not counted as helping.'
      : `${r.label || exp.label}: its effect on ${keyLabel(primaryKey)} (${fmtChange(primaryKey, primary.change)}) is not larger than the spread across seeds ` +
        `(${fmtAmount(primaryKey, primary.spread ?? 0)})${moved ? ' in the better direction' : ''}, so it is not counted as helping.`);
  }
  const rec = {
    label: isText(r.label) ? r.label.trim() : exp.label,
    patch: exp.patch,
    effect,
    testedWith: exp.testedWith,
    holdsAcrossSeeds: holds,
    costNote: isText(r.costNote) ? r.costNote.trim() : '',
    confidence: capConfidence(r.confidence, cap),
    why: isText(r.why) ? r.why.trim() : exp.why,
    experiment: exp.n,
    kpi: primaryKey
  };
  if (confirmation) {
    const c = confirmation.record;
    rec.confirmation = {
      testedWith: c.testedWith,
      experiment: c.n,
      effect: Object.fromEntries(keys.map(k => [k, lookupMeasure(c, k)]).filter(([, m]) => m && m.before != null).map(([k, m]) => [k, effectEntry(m)])),
      holdsAcrossSeeds: c.holdsAcrossSeeds,
      agrees: confirmation.agrees,
      disagreeOn: confirmation.disagreeOn
    };
    if (!confirmation.agrees) {
      const detail = confirmation.disagreeOn.map(k =>
        `${keyLabel(k)}: ${exp.testedWith} ${fmtChange(k, lookupMeasure(exp, k).change)}, ${c.testedWith} ${fmtChange(k, lookupMeasure(c, k).change)}`).join('; ');
      cautions.push(`${rec.label}: ${exp.testedWith} and ${c.testedWith} disagree on the direction of the effect (${detail}). Treat it as unproven.`);
    }
  }
  return { rec, cautions };
}

// When Claude never calls finish: the experiments that helped, best headline improvement first.
function fallbackRecommendations(ctx) {
  const key = HEADLINE[ctx.mode][0];
  // Relative improvement of the first headline KPI: positive when it moved in the better direction.
  const gain = e => {
    const m = e.kpis[key];
    return m && m.before ? (m.change * BETTER[key]) / Math.abs(m.before) : 0;
  };
  return ctx.experiments.filter(e => !e.confirms && e.round === ctx.round && e.verdict === 'helps')
    .sort((a, b) => gain(b) - gain(a)).slice(0, 3)
    .map(e => ({ experiment: e.n, label: e.label, why: e.why, confidence: 'low' }));
}

/**
 * Run the advisor loop (§15c).
 * @param {object} args
 * @param {object} args.world raw or normalized world spec
 * @param {string} [args.question] defaults to the world's question
 * @param {number[]} [args.seeds] default [7, 8, 9], or the seeds of `runs`
 * @param {string|object} [args.provider] 'rules' (default) or 'jev', or a provider object; experiments run with it
 * @param {string|object} [args.confirmWith] re-run the top recommendations with this provider before finishing
 * @param {object[]} [args.runs] baseline runs already made on `seeds` (from runSeeds); otherwise the advisor runs them
 * @param {object} [args.client] an Anthropic client (injected in tests); otherwise `apiKey` is required
 * @param {(event: object) => void} [args.onStep] progress events: baseline, say, test, result, rejected, look, list,
 *   confirm, confirmed, nudge, finish
 * @param {object} [args.previous] earlier advice (advice.json) and [args.followUp] the user's reply to it
 */
export async function advise({
  world, question = null, seeds = null, provider = 'rules', confirmWith = null, maxExperiments = 6,
  model = DEFAULT_MODEL, apiKey = process.env.ANTHROPIC_API_KEY, client = null, onStep = null,
  previous = null, followUp = null, runs = null, simOpts = {},
  // The test over days (§21d): `pool` is the world's pool file as an object, or null. `daysProvider` is the
  // provider it runs with: Jev by default when a key is set, because the rule model does not read memory.
  pool = null, daysProvider = undefined, days = 10, maxDaysTests = 1
} = {}) {
  const secrets = [apiKey, process.env.ANTHROPIC_API_KEY, process.env.TYPESAFE_API_KEY]
    .filter(s => typeof s === 'string' && s.trim().length >= 8);
  const redact = redactor(secrets);
  if (!client) {
    if (!isText(apiKey)) throw Object.assign(new Error(NO_KEY_MESSAGE), { code: 'NO_ANTHROPIC_KEY' });
    client = new Anthropic({ apiKey });
  }
  const checked = validateWorld(world);
  if (!checked.ok) throw new Error(`The world is not valid:\n${checked.errors.map(e => `  - ${e}`).join('\n')}`);
  const spec = checked.spec;
  if (followUp != null && !previous) throw new Error('A follow-up needs the earlier advice (previous).');
  if (previous && !isText(followUp)) throw new Error("A follow-up needs the user's reply (followUp).");
  const limit = Math.min(MAX_EXPERIMENTS_LIMIT, Math.max(1, Math.floor(Number(maxExperiments) || 6)));
  const step = event => onStep?.(redactDeep(event, redact));

  const expProvider = providerInstance(provider, 'provider');
  const confirmProvider = confirmWith ? providerInstance(confirmWith, 'confirmWith') : null;

  let baseline = runs;
  if (baseline?.length) {
    const runSeedList = baseline.map(r => r.seed ?? r.meta?.seed);
    if (seeds && JSON.stringify(seeds) !== JSON.stringify(runSeedList)) {
      throw new Error(`seeds ${seeds.join(', ')} do not match the baseline runs' seeds ${runSeedList.join(', ')}.`);
    }
    seeds = runSeedList;
  } else {
    seeds = seeds?.length ? seeds : DEFAULT_SEEDS;
    // Same provider instance as the experiments: with Jev, its cache then answers the "before" side of each compare.
    baseline = await runBaseline(spec, seeds, expProvider, simOpts);
    step({ type: 'baseline', seeds, kpis: baseline.map(r => r.kpis) });
  }

  const prevStart = previous?.transcript?.find(s => s.kind === 'start') ?? null;
  const ask = isText(question) ? question.trim() : prevStart?.question ?? spec.question;
  // One view per run, shared by the brief and the tools, so each run's files are read once.
  const views = baseline.map(runView);
  const brief = briefFromViews(world, views, ask, expProvider.name);
  const earlier = (previous?.experiments ?? []).map(e => structuredClone(e));
  const round = previous ? Math.max(1, prevStart?.round ?? 1, ...earlier.map(e => e.round ?? 1)) + 1 : 1;
  const ctx = {
    spec, mode: spec.mode, seeds, simOpts, step, expProvider, confirmProvider,
    views, baseHash: specHash(spec),
    maxExperiments: limit, newCount: 0, round,
    experiments: earlier, nextN: Math.max(0, ...earlier.map(e => e.n ?? 0)) + 1,
    confirmations: new Map(),
    days: daysSetup({ pool, daysProvider, expProvider, confirmProvider, spec, seeds, days, maxDaysTests })
  };

  const transcript = [{
    kind: 'start', round, world: spec.title, mode: spec.mode, specHash: ctx.baseHash, question: ask, followUp: previous ? followUp : null,
    seeds, provider: expProvider.name, confirmWith: confirmProvider?.name ?? null, model, maxExperiments: limit,
    runs: ctx.views.map(v => ({ seed: v.seed, runId: v.runId }))
  }];
  const params = {
    model,
    max_tokens: MAX_TOKENS,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    output_config: { effort: 'high' },
    cache_control: { type: 'ephemeral' },
    system: SYSTEM_PROMPT,
    // The test over days is offered only for a world with a pool; without one the request is what it always was.
    tools: ctx.days.pool ? TOOLS : TOOLS.filter(t => t.name !== 'test_over_days'),
    // This model rejects forced tool_choice, so the prompt asks for finish and the loop checks it was called.
    tool_choice: { type: 'auto' }
  };
  const messages = [{
    role: 'user',
    content: firstMessage({
      brief: brief.markdown, question: ask, maxExperiments: limit, seeds, providerName: expProvider.name,
      previous, followUp, startN: ctx.nextN, overDays: ctx.days
    })
  }];

  let finishInput = null;
  let pendingFinish = null;
  let nudged = false;
  let lastText = '';
  let stopNote = null;
  let jsonRetries = 0;
  const maxTurns = limit * 2 + 8;
  let turn = 0;

  const runTool = async call => {
    const input = call.input;
    switch (call.name) {
      case 'test_change': return testChange(ctx, input);
      case 'test_over_days': return testOverDays(ctx, input);
      case 'look_at_person': return lookAtPerson(ctx, input);
      case 'list_people': return listPeople(ctx, input);
      case 'finish': {
        const problem = checkFinish(input);
        if (problem) return { isError: true, content: problem };
        if (confirmProvider && !pendingFinish) {
          pendingFinish = input;
          return { content: confirmationText(ctx, await confirmRecommendations(ctx, input.recommendations)) };
        }
        finishInput = input;
        step({ type: 'finish' });
        return { content: 'Advice recorded.' };
      }
      default: return { isError: true, content: `Unknown tool ${call.name}. Use test_change, test_over_days, look_at_person, list_people or finish.` };
    }
  };

  try {
    for (; turn < maxTurns && !finishInput; turn++) {
      let message;
      try {
        message = await client.beta.messages.stream({ ...params, messages }).finalMessage();
        jsonRetries = 0;
      } catch (err) {
        // With eager input streaming the SDK rejects when a tool input is not parseable JSON; that turn is
        // re-issued twice at most. API errors (auth, rate limits, bad requests) propagate.
        if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
        continue;
      }
      if (message.stop_reason === 'refusal') {
        stopNote = 'Claude declined to continue, so the advice below was built by code from the experiments that ran.';
        transcript.push({ kind: 'stop', reason: 'refusal' });
        break;
      }
      const content = echoable(message.content ?? []);
      messages.push({ role: 'assistant', content });
      const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (text) {
        lastText = text;
        transcript.push({ kind: 'assistant', text: clip(text, 800) });
        step({ type: 'say', text });
      }
      if (message.stop_reason === 'pause_turn') continue;
      const calls = content.filter(b => b.type === 'tool_use');
      if (!calls.length) {
        if (!nudged) {
          nudged = true;
          messages.push({
            role: 'user',
            content: 'Call the finish tool now with your advice. Recommend only changes you tested, cited by experiment number, and say what you could not test.'
          });
          transcript.push({ kind: 'nudge' });
          step({ type: 'nudge' });
          continue;
        }
        stopNote = 'The advisor stopped without calling finish, so the recommendations below were built by code from the measured experiments.';
        transcript.push({ kind: 'stop', reason: 'no finish' });
        break;
      }
      const results = [];
      for (const call of calls) {
        let r;
        if (message.stop_reason === 'max_tokens') {
          r = { isError: true, content: 'Your reply was cut off at the output limit, so this call did not run. Call the tool again with a shorter input.' };
        } else {
          r = await runTool(call);
        }
        transcript.push({
          kind: 'tool', name: call.name, input: clip(JSON.stringify(call.input), 600), result: clip(r.content, 600), ...(r.isError ? { isError: true } : {})
        });
        results.push({ type: 'tool_result', tool_use_id: call.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
    }
  } catch (err) {
    throw redactError(err, redact);
  }
  if (!finishInput && !stopNote && turn >= maxTurns) {
    stopNote = `The advisor reached its turn limit (${maxTurns}) without finishing, so the advice below was built by code from the measured experiments.`;
    transcript.push({ kind: 'stop', reason: 'turn limit' });
  }

  const final = finishInput ?? pendingFinish;
  const recsIn = final ? (final.recommendations ?? []) : fallbackRecommendations(ctx);
  if (confirmProvider) await confirmRecommendations(ctx, recsIn);

  const recommendations = [];
  const codeCautions = [];
  const untested = [];
  for (const r of recsIn) {
    const built = recommendationFrom(ctx, r);
    if (!built) {
      untested.push(isText(r?.label) ? r.label : `experiment #${r?.experiment}`);
      continue;
    }
    recommendations.push(built.rec);
    codeCautions.push(...built.cautions);
  }
  if (untested.length) codeCautions.push(`Left out of the recommendations because no experiment tested them: ${untested.join('; ')}.`);
  if (stopNote) codeCautions.unshift(stopNote);
  if (seeds.length < 3) codeCautions.push(`Only ${seeds.length} seed${seeds.length === 1 ? ' was' : 's were'} run, so the spread across seeds is poorly measured.`);
  if (/^rules/.test(expProvider.name) && !confirmProvider) {
    codeCautions.push('The experiments used the rules provider (rule-based people), not Jev. Confirm the top change with Jev (--confirm-with jev) before acting on it.');
  }
  const stale = earlier.filter(e => e.baseSpecHash && e.baseSpecHash !== ctx.baseHash);
  if (stale.length) codeCautions.push(`Earlier experiments ${stale.map(e => `#${e.n}`).join(', ')} were run on a different version of the world; their numbers may not carry over.`);
  const otherSeeds = earlier.filter(e => Array.isArray(e.seeds) && e.seeds.join(',') !== seeds.join(','));
  if (otherSeeds.length) codeCautions.push(`Earlier experiments ${otherSeeds.map(e => `#${e.n}`).join(', ')} used different seeds.`);
  codeCautions.push('Simulated people are not validated against real people; these are rankings under the world\'s assumptions, not forecasts.');

  const strings = list => (Array.isArray(list) ? list.filter(isText).map(s => s.trim()) : []);
  const cautions = [...new Set([
    ...strings(final?.cautions),
    ...codeCautions,
    ...strings(final?.couldNotTest).map(s => (s.startsWith(COULD_NOT_TEST) ? s : `${COULD_NOT_TEST}${s}`))
  ])];

  const result = {
    answer: isText(final?.answer) ? final.answer.trim()
      : lastText || 'The advisor did not finish. The changes it tested and their measured effects are listed below.',
    findings: strings(final?.findings),
    recommendations,
    cautions,
    nextSteps: strings(final?.nextSteps),
    experiments: ctx.experiments,
    ...(ctx.days.pool ? { testsOverDays: ctx.days.tests } : {}),
    transcript
  };
  return redactDeep(rounded(result, 6), redact);
}

// ---------- saving ----------

function effectCell(rec, mode) {
  const keys = [...HEADLINE[mode], ...(rec.kpi && !HEADLINE[mode].includes(rec.kpi) ? [rec.kpi] : [])];
  return keys.filter(k => rec.effect?.[k]).map(k => effectText(k, rec.effect[k])).join('; ') || '–';
}

// "Offer deal: reached 120 people per run; 40 of them went to Forno Slice; arrivals there 60 → 66 (+6; spread 2, ...)."
function offerLines(exp) {
  const names = new Map([
    ...(exp?.bottlenecks?.before ?? []), ...(exp?.bottlenecks?.topAfter ?? []),
    ...[...(exp?.segments?.byGroup ?? []), ...(exp?.segments?.byCast ?? [])].flatMap(s => s.places ?? [])
  ].map(p => [p.id, p.name]));
  return (exp?.offers ?? []).filter(o => isNum(o.reached)).map(o => {
    const place = o.place ? names.get(o.place) ?? o.place : null;
    return `Offer ${o.id}: reached ${fmtNum(o.reached)} people per run` +
      (place ? `; ${fmtNum(o.wentToPlace)} of them went to ${place}` : '') +
      (o.placeArrivals ? `; arrivals there ${effectText(`place:${o.place}.arrivals`, o.placeArrivals).slice(`${o.place} · arrivals `.length)}` : '') + '.';
  });
}

function modeOf(result) {
  const start = (result.transcript ?? []).find(s => s.kind === 'start');
  if (start?.mode === 'route' || start?.mode === 'visit') return start.mode;
  const kpis = result.experiments?.[0]?.kpis ?? {};
  return 'avgTrip' in kpis || Object.keys(result.recommendations?.[0]?.effect ?? {}).includes('avgTrip') ? 'route' : 'visit';
}

/** advice.md: the answer first, then ranked recommendations with measured effects, cautions, what could not be tested, next steps. */
export function adviceMarkdown(result) {
  const start = (result.transcript ?? []).find(s => s.kind === 'start') ?? {};
  const mode = modeOf(result);
  const out = [`# Advice: ${start.world ?? 'Swarmscope world'}`, ''];
  if (start.question) out.push(`**Question:** ${start.question}`);
  if (start.followUp) out.push(`**Your reply:** ${start.followUp}`);
  const tests = (result.experiments ?? []).filter(e => !e.confirms).length;
  out.push(`Tested on seeds ${(start.seeds ?? []).join(', ') || '–'} with ${start.provider ?? '–'}` +
    `${start.confirmWith ? `, top changes confirmed with ${start.confirmWith}` : ''} · ${tests} experiment${tests === 1 ? '' : 's'}` +
    `${start.model ? ` · advisor ${start.model}` : ''}${start.round > 1 ? ` · round ${start.round}` : ''}`);

  out.push('', '## Answer', '', result.answer ?? '–');

  out.push('', '## Recommended changes (ranked, measured on the same simulated crowd)', '');
  const recs = result.recommendations ?? [];
  if (!recs.length) out.push('No tested change is recommended.');
  else {
    const confirmCol = recs.some(r => r.confirmation);
    out.push(...mdTable(
      ['#', 'Change', 'Measured effect (before → after)', 'Holds across seeds', 'Tested with', ...(confirmCol ? ['Confirmation'] : []), 'Confidence'],
      recs.map((r, i) => [
        i + 1, `${r.label} (experiment #${r.experiment})`, effectCell(r, mode), r.holdsAcrossSeeds ? 'yes' : 'no', r.testedWith,
        ...(confirmCol ? [r.confirmation
          ? `${r.confirmation.testedWith}: ${HEADLINE[mode].filter(k => r.confirmation.effect?.[k]).map(k => effectText(k, r.confirmation.effect[k])).join('; ')}` +
            (r.confirmation.agrees ? ' (agrees)' : ` (disagrees on ${r.confirmation.disagreeOn.map(keyLabel).join(', ')})`)
          : '–'] : []),
        r.confidence
      ]).map(row => row.map(c => String(c).replace(/\|/g, '/')))
    ));
    out.push('');
    recs.forEach((r, i) => {
      const exp = (result.experiments ?? []).find(e => e.n === r.experiment);
      out.push(`${i + 1}. **${r.label}.** ${r.why}`);
      if (exp?.applied?.length) out.push(`   Changes: ${exp.applied.join('; ')}.`);
      for (const line of offerLines(exp)) out.push(`   ${line}`);
      if (r.costNote) out.push(`   Cost: ${r.costNote}`);
    });
  }

  const cautions = result.cautions ?? [];
  const notTested = cautions.filter(c => c.startsWith(COULD_NOT_TEST)).map(c => c.slice(COULD_NOT_TEST.length));
  const plain = cautions.filter(c => !c.startsWith(COULD_NOT_TEST));
  out.push('', '## Cautions', '', ...(plain.length ? plain.map(c => `- ${c}`) : ['- None noted.']));
  out.push('', '## What could not be tested', '', ...(notTested.length ? notTested.map(c => `- ${c}`) : ['- Nothing noted.']));
  out.push('', '## Next steps', '', ...((result.nextSteps ?? []).length ? result.nextSteps.map(s => `- ${s}`) : ['- None noted.']));
  if ((result.findings ?? []).length) out.push('', '## Findings', '', ...result.findings.map(f => `- ${f}`));

  const exps = result.experiments ?? [];
  if (exps.length) {
    const keys = HEADLINE[mode];
    out.push('', '## Every experiment', '', 'Change = after minus before, averaged over the same seeds; spread = the larger seed-to-seed standard deviation.', '',
      ...mdTable(['#', 'Change', 'Why', ...keys.map(k => KPI_LABELS[k]), 'Verdict', 'Tested with'],
        exps.map(e => [
          e.n, e.label, clip(e.why, 140),
          ...keys.map(k => (e.kpis?.[k] ? `${fmtChange(k, e.kpis[k].change)} (spread ${fmtAmount(k, e.kpis[k].spread ?? 0)})` : '–')),
          e.verdict ?? '–', `${e.testedWith}${e.round > 1 ? `, round ${e.round}` : ''}`
        ]).map(row => row.map(c => String(c).replace(/\|/g, '/').replace(/\n/g, ' ')))));
  }
  return out.join('\n') + '\n';
}

/** Saves advice.json and advice.md in `dir` (created if missing). Returns both paths. */
export function writeAdvice(dir, result) {
  mkdirSync(dir, { recursive: true });
  const json = join(dir, 'advice.json');
  const md = join(dir, 'advice.md');
  writeFileSync(json, JSON.stringify(result, null, 2) + '\n');
  writeFileSync(md, adviceMarkdown(result));
  return { json, md };
}
