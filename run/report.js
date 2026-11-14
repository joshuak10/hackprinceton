// Markdown digests of a recorded run, for Claude to write findings from (docs/PROTOTYPE.md §7, §8),
// plus the number formatting and provider-stats line the CLI shares.
import { clockText, feelingWords } from '../engine/util.js';
import { loadRun } from './recorder.js';
import { headlineKpis } from './runner.js';

export const TORN_GAP = 0.15;
const TORN_SHOWN = 10;
const FALLBACK_LIMIT = 0.2;

// ---------- formatting ----------
const isNum = v => typeof v === 'number' && Number.isFinite(v);
export const fmtInt = v => (isNum(v) ? Math.round(v).toLocaleString('en-US') : '–');
export const fmtNum = (v, digits = 1) => (isNum(v) ? v.toLocaleString('en-US', { maximumFractionDigits: digits }) : '–');
export const fmtPct = (v, digits = 1) => (isNum(v) ? `${(v * 100).toFixed(digits)}%` : '–');
export const fmtMin = v => (isNum(v) ? `${v.toFixed(1)} min` : '–');
const fmtProb = p => `${Math.round(p * 100)}%`;
const fmtUsd = v => (isNum(v) ? `$${v < 0.01 && v > 0 ? v.toFixed(5) : v.toFixed(2)}` : '–');
const fmtMs = v => (isNum(v) ? `${Math.round(v)} ms` : '–');

export const KPI_LABELS = {
  abandonRate: 'abandon rate', avgWait: 'avg wait', served: 'served', abandoned: 'abandoned', spawned: 'spawned',
  avgTrip: 'avg trip', avgDelay: 'avg delay', arrived: 'arrived'
};

export function formatKpi(name, value) {
  if (name === 'abandonRate') return fmtPct(value);
  if (name === 'avgWait' || name === 'avgTrip' || name === 'avgDelay') return fmtMin(value);
  return fmtNum(value);
}

export function kpiLine(kpis) {
  return Object.keys(KPI_LABELS).filter(k => k in kpis).map(k => `${KPI_LABELS[k]} ${formatKpi(k, kpis[k])}`).join(' · ');
}

export const countsText = counts => Object.entries(counts ?? {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${fmtInt(n)}`).join(' · ');

function durationText(min) {
  if (!isNum(min)) return '–';
  return min >= 120 ? `${fmtNum(min / 60)} h` : `${Math.round(min)} min`;
}

function mdTable(headers, rows) {
  const line = cells => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)];
}

// ---------- provider stats ----------

// Share of this run's decisions that fell back to rules; null when the run made no external decisions.
export function fallbackRate(metrics) {
  const d = metrics?.decisions;
  if (!d?.total) return null;
  return (d.byProvider?.['rules-fallback'] ?? 0) / d.total;
}

export function fallbackWarning(metrics) {
  const rate = fallbackRate(metrics);
  if (rate == null || rate <= FALLBACK_LIMIT) return null;
  return `Warning: ${fmtPct(rate)} of decisions fell back to rules, so this run does not count as a Jev run (spec rule 9).`;
}

export function providerStatsLine(stats, metrics) {
  if (!stats) return 'no provider stats recorded';
  const rate = fallbackRate(metrics);
  const fallback = `fallback ${rate == null ? '–' : fmtPct(rate)}`;
  if (stats.provider === 'jev') {
    const lat = stats.latency ?? {};
    return [
      `jev ${stats.model ?? '(model unknown)'}`,
      `${fmtInt(stats.requests)} requests`,
      `${fmtInt(stats.cacheHits)} cache hits`,
      fallback,
      `${fmtInt(stats.inputTokens)} input / ${fmtInt(stats.outputTokens)} output tokens`,
      `est. ${fmtUsd(stats.estCostUSD)} (unverified)`,
      `p50 ${fmtMs(lat.p50)} · p95 ${fmtMs(lat.p95)}`
    ].join(' · ');
  }
  if (stats.provider === 'replay') {
    return [
      `replay${stats.model ? ` of ${stats.model}` : ''}`,
      `${fmtInt(stats.decisions)} decisions`,
      `${fmtInt(stats.hashHits)} matched by request hash`,
      `${fmtInt(stats.idHits)} by id`,
      `${fmtInt(stats.misses)} misses`,
      fallback,
      'no API calls'
    ].join(' · ');
  }
  if (stats.provider === 'rules') {
    return stats.external ? `rules · ${fmtInt(stats.decisions)} decisions answered by the rule policy` : 'rules (inline rule policy, no decision requests)';
  }
  const counts = Object.entries(stats).filter(([, v]) => isNum(v)).map(([k, v]) => `${k} ${fmtInt(v)}`);
  return [stats.provider ?? 'provider', ...counts].join(' · ');
}

// ---------- names and decision helpers ----------
function nameLookup(spec) {
  const names = new Map();
  for (const n of spec?.nodes ?? []) names.set(n.id, n.name);
  for (const e of spec?.edges ?? []) names.set(`${e.to}>${e.from}`, e.name);
  for (const e of spec?.edges ?? []) names.set(`${e.from}>${e.to}`, e.name);
  return id => (id == null ? '–' : names.get(id) ?? String(id));
}

const REMARK_TEXT = {
  long_line: x => `long line at ${x}`,
  bad_service: x => `bad experience at ${x}`,
  good_experience: x => `${x} was good and quick`,
  heavy_traffic: x => `heavy traffic on ${x}`,
  clear_roads: x => `${x} was clear`
};
const remarkText = (kind, place) => (REMARK_TEXT[kind] ? REMARK_TEXT[kind](place) : `${kind} about ${place}`);

const WHY_TEXT = { start: 'just arrived', next: 'finished somewhere', balked: 'walked away from a line', gaveup: 'gave up waiting' };
const kindText = d => (d.why ? `${d.kind} (${WHY_TEXT[d.why] ?? d.why})` : d.kind);

// Short name for an option key: the place name for node ids, otherwise the option's label.
function optionNamer(line, nameOf) {
  const labels = new Map((line.options ?? []).map(o => [o.key, o.label]));
  return key => {
    const place = nameOf(key);
    return place !== String(key) ? place : labels.get(key) ?? String(key);
  };
}

// The probabilities behind a decision's primary question, best first, renormalized over valid options.
export function primaryProbs(line) {
  const d = line.decision ?? {};
  if (line.asks?.yesNo && isNum(d.yesProb)) {
    const probs = [['yes', d.yesProb], ['no', 1 - d.yesProb]].sort((a, b) => b[1] - a[1]);
    return { question: line.asks.yesNo, probs, gap: probs[0][1] - probs[1][1] };
  }
  if (line.asks?.choice && d.choiceProbs) {
    const keys = new Set((line.options ?? []).map(o => o.key));
    const valid = Object.entries(d.choiceProbs).filter(([k, p]) => keys.has(k) && isNum(p) && p > 0);
    const total = valid.reduce((s, [, p]) => s + p, 0);
    if (!total) return null;
    const probs = valid.map(([k, p]) => [k, p / total]).sort((a, b) => b[1] - a[1]);
    return { question: line.asks.choice, probs, gap: probs.length > 1 ? probs[0][1] - probs[1][1] : 1 };
  }
  return null;
}

function choiceProbsText(line, nameOf) {
  const name = optionNamer(line, nameOf);
  const keys = new Set((line.options ?? []).map(o => o.key));
  const probs = Object.entries(line.decision?.choiceProbs ?? {}).filter(([k, p]) => keys.has(k) && isNum(p));
  const total = probs.reduce((s, [, p]) => s + p, 0) || 1;
  return probs.sort((a, b) => b[1] - a[1])
    .map(([k, p]) => `${name(k)} ${fmtProb(p / total)}${k === line.applied?.action ? ' (chosen)' : ''}`).join(' · ');
}

const situation = line => line.observation?.now ?? line.observation?.trip ?? '';

function personaText(personaId, spec) {
  const m = (spec?.minds ?? []).find(p => p.id === personaId);
  if (!m) return personaId ?? 'unknown persona';
  const group = (spec.archetypes ?? []).find(a => a.id === m.archetype)?.name ?? m.archetype;
  const bio = m.bio ? `: ${m.bio.length > 120 ? m.bio.slice(0, 117) + '…' : m.bio}` : '';
  return `${m.name} (${group}${m.age != null ? `, ${m.age}` : ''})${bio}`;
}

// ---------- report sections ----------
function bottleneckSection(metrics) {
  if (metrics.mode === 'route') {
    const edges = [...(metrics.edges ?? [])].sort((a, b) => b.delayMinutes - a.delayMinutes).slice(0, 10);
    const out = ['## Bottlenecks (score = delay minutes)', '', ...mdTable(
      ['#', 'Road', 'Delay min', 'Delay ratio', 'Peak load', 'Traversals', 'Avg time', 'Free-flow', 'Capacity'],
      edges.map((e, i) => [i + 1, e.name, fmtInt(e.delayMinutes), `${fmtNum(e.delayRatio, 2)}×`, fmtPct(e.peakRatio, 0),
        fmtInt(e.traversals), fmtMin(e.avgTime), fmtMin(e.freeflow), fmtInt(e.capacity)])
    )];
    const od = [...(metrics.od ?? [])].sort((a, b) => b.trips - a.trips).slice(0, 10);
    if (od.length) {
      out.push('', '### Trips', '', ...mdTable(['Trip', 'Trips', 'Avg trip', 'Free-flow'],
        od.map(o => [o.route, fmtInt(o.trips), fmtMin(o.avgTrip), fmtMin(o.freeflow)])));
    }
    return out;
  }
  const nodes = [...(metrics.nodes ?? [])].sort((a, b) => b.score - a.score).slice(0, 10);
  return ['## Bottlenecks (score = wait minutes + 30 × abandoned)', '', ...mdTable(
    ['#', 'Place', 'Score', 'Wait min', 'Abandoned', 'Arrivals', 'Served', 'Avg wait', 'Max queue', 'Utilization', 'Capacity/h'],
    nodes.map((n, i) => [i + 1, n.name, fmtInt(n.score), fmtInt(n.waitMinutes), fmtInt(n.abandoned), fmtInt(n.arrivals),
      fmtInt(n.served), fmtMin(n.avgWait), fmtInt(n.maxQueue), fmtPct(n.utilization, 0), fmtInt(n.capacityPerHour)])
  )];
}

function groupSection(metrics) {
  const groups = metrics.archetypes ?? [];
  if (metrics.mode === 'route') {
    return ['## Outcomes by group', '', ...mdTable(['Group', 'Agents', 'Arrived', 'Avg trip', 'Avg delay'],
      groups.map(g => [g.name, fmtInt(g.count), fmtInt(g.arrived), fmtMin(g.avgTrip), fmtMin(g.avgDelay)]))];
  }
  return ['## Outcomes by group', '', ...mdTable(['Group', 'Agents', 'Avg wait per agent', 'Avg places served', 'Abandons per agent'],
    groups.map(g => [g.name, fmtInt(g.count), fmtMin(g.avgWaitPerAgent), fmtNum(g.avgServed, 2), fmtNum(g.abandonsPerAgent, 2)]))];
}

// ---------- segments and offers (§15a, §15b) ----------

export const SEGMENT_NOTE =
  'A segment is a kind of simulated person (a group, or everyone who copies one cast member), not a real individual.';

// A segment's bad-time score uses the place bottleneck weighting per person: wait minutes + 30 × walk-aways.
export const segmentScore = s => (isNum(s.avgWait) ? s.avgWait : 0) + 30 * (isNum(s.walkAwaysPerPerson) ? s.walkAwaysPerPerson : 0);

export const fmtMoney = v => (isNum(v) ? `$${v.toFixed(2)}` : '–');
const feelingText = v => (isNum(v) ? `${fmtNum(v, 2)} (${feelingWords(v)})` : '–');
const topPlacesText = list => (list ?? []).slice(0, 3).map(p => `${p.name ?? p.id} ${fmtInt(p.visits)}`).join(' · ') || '–';

function segmentSection(metrics, spec) {
  const byGroup = metrics.segments?.byGroup ?? [];
  const byCast = metrics.segments?.byCast ?? [];
  if (!byGroup.length && !byCast.length) return [];
  const groupName = id => (spec?.archetypes ?? []).find(a => a.id === id)?.name ?? id ?? '–';
  const out = ['## Who had the worst time', '', SEGMENT_NOTE];
  const parts = [['By group', byGroup, false], ['By cast member (everyone who copies them)', byCast, true]].filter(([, list]) => list.length);

  if (metrics.mode === 'route') {
    for (const [title, list, cast] of parts) {
      const rows = [...list].sort((a, b) => (b.avgDelay ?? 0) - (a.avgDelay ?? 0)).slice(0, 10)
        .map(s => [s.name ?? s.id, ...(cast ? [groupName(s.group)] : []), fmtInt(s.count), fmtMin(s.avgTrip), fmtMin(s.avgDelay), feelingText(s.avgFrustration)]);
      out.push('', `### ${title} (most delay first)`, '', ...mdTable(
        ['Segment', ...(cast ? ['Group'] : []), 'People', 'Avg trip', 'Avg delay', 'Frustration'], rows));
    }
    return out;
  }

  for (const [title, list, cast] of parts) {
    const rows = [...list].sort((a, b) => segmentScore(b) - segmentScore(a)).slice(0, 10)
      .map(s => [s.name ?? s.id, ...(cast ? [groupName(s.group)] : []), fmtInt(s.count), fmtMin(s.avgWait),
        fmtNum(s.walkAwaysPerPerson, 2), fmtPct(s.shareNeverServed, 0), feelingText(s.avgFrustration)]);
    out.push('', `### ${title} (worst first: wait minutes + 30 × walk-aways per person)`, '', ...mdTable(
      ['Segment', ...(cast ? ['Group'] : []), 'People', 'Avg wait', 'Walk-aways per person', 'Never served', 'Frustration'], rows));
  }
  out.push('', '## Who spent the most');
  for (const [title, list, cast] of parts) {
    const rows = [...list].sort((a, b) => (b.avgSpent ?? 0) - (a.avgSpent ?? 0)).slice(0, 10)
      .map(s => [s.name ?? s.id, ...(cast ? [groupName(s.group)] : []), fmtInt(s.count), fmtMoney(s.avgSpent),
        fmtNum(s.avgVisits, 2), topPlacesText(s.topPlaces)]);
    out.push('', `### ${title}`, '', ...mdTable(
      ['Segment', ...(cast ? ['Group'] : []), 'People', 'Avg spent', 'Avg visits', 'Top places'], rows));
  }
  return out;
}

function offerSection(metrics, spec, nameOf) {
  const results = metrics.offers ?? [];
  if (!results.length) return [];
  const defs = new Map((spec?.offers ?? []).map(o => [o.id, o]));
  const groupName = id => (spec?.archetypes ?? []).find(a => a.id === id)?.name ?? id;
  const castName = id => (spec?.minds ?? []).find(m => m.id === id)?.name ?? id;
  const audience = to => {
    const names = [...(to?.groups ?? []).map(groupName), ...(to?.cast ?? []).map(castName)];
    return names.length ? names.join(', ') : 'everyone';
  };
  const rows = results.map(r => {
    const o = defs.get(r.id) ?? {};
    const text = o.text ? (o.text.length > 80 ? `${o.text.slice(0, 77)}…` : o.text) : '–';
    return [r.id, text, audience(o.to), o.place ? nameOf(o.place) : '–', isNum(o.priceOff) ? fmtPct(o.priceOff, 0) : '–',
      fmtInt(r.reached), fmtInt(r.wentToPlace), r.reached ? fmtPct(r.wentToPlace / r.reached, 0) : '–'];
  });
  return ['## Offers', '', 'An offer is a simulated message (and optional discount) shown to a kind of simulated person.', '',
    ...mdTable(['Offer', 'What they are told', 'To', 'Place', 'Price off', 'Reached', 'Went to the place', 'Share'], rows)];
}

function remarkSection(remarks, nameOf) {
  const list = remarks ?? [];
  if (!list.length) return ['## Remarks', '', 'No remarks were posted.'];
  const byKind = {};
  const byPlace = new Map();
  for (const r of list) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    const place = r.placeId ?? r.edgeId;
    if (!byPlace.has(place)) byPlace.set(place, { total: 0 });
    const p = byPlace.get(place);
    p.total++;
    p[r.kind] = (p[r.kind] ?? 0) + 1;
  }
  const kinds = Object.keys(byKind).sort((a, b) => byKind[b] - byKind[a]);
  const places = [...byPlace.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 10);
  return ['## Remarks', '', `${fmtInt(list.length)} remarks: ${countsText(byKind)}.`, '', ...mdTable(
    ['About', 'Total', ...kinds],
    places.map(([place, c]) => [nameOf(place), fmtInt(c.total), ...kinds.map(k => fmtInt(c[k] ?? 0))])
  )];
}

function tornSection(decisions, spec, nameOf) {
  const head = `## Torn decisions (top two probabilities within ${TORN_GAP})`;
  const scored = decisions.map(line => ({ line, p: primaryProbs(line) })).filter(x => x.p && x.p.probs.length > 1);
  if (!scored.length) return [head, '', 'No decisions with probabilities (rule-based decisions carry none).'];
  const torn = scored.filter(x => x.p.gap <= TORN_GAP).sort((a, b) => a.p.gap - b.p.gap);
  const byKind = {};
  for (const { line } of torn) byKind[line.kind] = (byKind[line.kind] ?? 0) + 1;
  const out = [head, '', `${fmtInt(torn.length)} of ${fmtInt(scored.length)} decisions with probabilities were torn${torn.length ? ` (${countsText(byKind)})` : ''}.`];
  for (const { line, p } of torn.slice(0, TORN_SHOWN)) {
    const name = optionNamer(line, nameOf);
    const isYesNo = p.question === line.asks?.yesNo;
    const a = line.applied ?? {};
    const took = !isYesNo ? name(a.action) : a.yes ? 'yes' : a.action != null ? `no, then ${name(a.action)}` : 'no';
    const probs = p.probs.slice(0, 4).map(([k, q]) => `${isYesNo ? k : name(k)} ${fmtProb(q)}`).join(' · ');
    out.push('', `- **${line.id}** ${line.clock} · ${kindText(line)} · ${personaText(line.personaId, spec)}`);
    if (situation(line)) out.push(`  - Situation: ${situation(line)}`);
    out.push(`  - ${p.question}: ${probs} → ${took} (${line.decision?.provider ?? '?'})`);
    if (!isYesNo) out.push(`  - Options (${line.options.length}): ${line.options.map(o => name(o.key)).join(', ')}`);
  }
  return out;
}

function frustrationSection(agents, spec, metrics) {
  const head = '## Frustration by group';
  const answered = (agents ?? []).filter(a => isNum(a.frustration));
  if (!answered.length) return [head, '', 'No frustration answers in this run (rule-based decisions carry none).'];
  const rows = (spec?.archetypes ?? []).map(g => {
    const mine = answered.filter(a => a.archetypeId === g.id);
    const avg = mine.length ? mine.reduce((s, a) => s + a.frustration, 0) / mine.length : null;
    const high = mine.filter(a => a.frustration >= 2.5).length;
    return [g.name, fmtInt(mine.length), avg == null ? '–' : fmtNum(avg, 2), feelingWords(avg) ?? '–', mine.length ? fmtPct(high / mine.length, 0) : '–'];
  });
  const overall = metrics.frustration?.avg;
  return [head, '', `Scale 0 (calm) to 4 (furious). Overall average ${fmtNum(overall, 2)} (${feelingWords(overall) ?? '–'}).`, '',
    ...mdTable(['Group', 'Agents answered', 'Avg', 'Feeling', 'Very frustrated or furious'], rows)];
}

function decisionSection(metrics) {
  const d = metrics.decisions;
  if (!d?.total) return ['## Decisions', '', 'No external decisions: the inline rule policy decided for every agent.'];
  return ['## Decisions', '', `${fmtInt(d.total)} decisions. By kind: ${countsText(d.byKind)}. By provider: ${countsText(d.byProvider)}.`];
}

function providerSection(stats, metrics) {
  const out = ['## Provider', ''];
  if (stats?.provider === 'jev') {
    const lat = stats.latency ?? {};
    out.push(
      `- Model ${stats.model ?? 'unknown'}`,
      `- ${fmtInt(stats.requests)} API requests · ${fmtInt(stats.cacheHits)} cache hits · ${fmtInt(stats.fallbacks)} fallbacks · ${fmtInt(stats.errors)} errors`,
      `- Fallback rate ${fallbackRate(metrics) == null ? '–' : fmtPct(fallbackRate(metrics))} of this run's decisions`,
      `- Tokens: ${fmtInt(stats.inputTokens)} input / ${fmtInt(stats.outputTokens)} output`,
      `- Est. cost ${fmtUsd(stats.estCostUSD)}, unverified (${stats.priceNote ?? '$0.042 per million input tokens, unverified'})`,
      `- Latency p50 ${fmtMs(lat.p50)} · p95 ${fmtMs(lat.p95)} · max ${fmtMs(lat.max)}`
    );
    if (stats.firstError) out.push(`- First error: ${stats.firstError}`);
  } else {
    out.push(`- ${providerStatsLine(stats, metrics)}`);
  }
  const warning = fallbackWarning(metrics);
  if (warning) out.push('', `> **${warning}**`);
  return out;
}

export const BUILDING_LIMITS =
  'Limits of v0.2 building runs: one floor only; doorways count traffic but do not slow it; ' +
  "numbers not read from CoStar or Matterport are assumed and listed in the world's provenance.";

// Busiest doorways and the wall check, for runs whose world has doors or walls.
function doorSection(metrics) {
  const doors = metrics.doors ?? [];
  const walls = metrics.walls;
  if (!doors.length && !walls) return [];
  const out = [];
  if (doors.length) {
    const when = d => (d.peakClock == null || d.peakClock === '' ? '–' : String(d.peakClock));
    out.push('## Busiest doorways', '', ...mdTable(
      ['#', 'Doorway', 'Crossings', 'Peak per 5 min', 'When'],
      doors.slice(0, 10).map((d, i) => [i + 1, d.name ?? d.id, fmtInt(d.crossings), fmtInt(d.peakPer5Min), when(d)])
    ));
  }
  if (walls) {
    const n = walls.count ?? 0;
    const m = walls.checkedMoves ?? walls.movesChecked ?? 0;
    const v = walls.violations ?? 0;
    out.push('', `Walls: ${fmtInt(n)} walls, ${fmtInt(m)} moves checked, ${fmtInt(v)} violations.`);
  }
  out.push('', BUILDING_LIMITS);
  return out;
}

export function reportMarkdown(runDir) {
  const { meta, spec, metrics, agents, remarks, decisions } = loadRun(runDir);
  const nameOf = nameLookup(spec);
  const out = [`# ${meta.title ?? 'Untitled world'}`, '', `**Question:** ${meta.question ?? '–'}`, ''];
  out.push(
    `- Run \`${meta.runId}\` · ${meta.status}${meta.label ? ` · ${meta.label}` : ''} · recorded ${meta.createdAt}`,
    `- Provider ${meta.provider}${meta.model ? ` (model ${meta.model})` : ''} · seed ${meta.seed} · spec hash \`${meta.specHash ?? '–'}\``,
    `- ${meta.mode} world · ${durationText(meta.duration)} from ${clockText({ clockStart: meta.clockStart ?? 0 }, 0)} · ` +
      `${fmtInt(meta.agents)} agents · ${fmtInt(meta.decisions)} recorded decisions`
  );
  if (meta.error) out.push(`- **Error:** ${meta.error}`);
  if (!metrics) return out.join('\n') + '\n';

  const kpis = headlineKpis(metrics);
  out.push('', '## Headline', '', kpiLine(kpis));
  out.push(`Top bottlenecks: ${kpis.top.map((p, i) => `${i + 1}. ${p.name} (${fmtInt(p.score)})`).join(' · ') || '–'}`);
  for (const section of [
    bottleneckSection(metrics),
    groupSection(metrics),
    // Only when present, so reports of runs without segments or offers stay exactly as before.
    ...[segmentSection(metrics, spec), offerSection(metrics, spec, nameOf)].filter(s => s.length),
    doorSection(metrics),
    remarkSection(remarks, nameOf),
    tornSection(decisions, spec, nameOf),
    frustrationSection(agents, spec, metrics),
    decisionSection(metrics),
    providerSection(meta.providerStats, metrics)
  ]) out.push('', ...section);
  return out.join('\n') + '\n';
}

// ---------- one agent ----------

function findAgent(run, agentId) {
  const agent = (run.agents ?? []).find(a => String(a.id) === String(agentId));
  if (!agent) return null;
  return {
    agent,
    persona: (run.spec?.minds ?? []).find(m => m.id === agent.personaId) ?? null,
    decisions: run.decisions.filter(d => String(d.agentId) === String(agentId)),
    remarks: (run.remarks ?? []).filter(r => String(r.agentId) === String(agentId))
  };
}

// The agent's summary, persona, recorded decisions and remarks; null if the run has no such agent.
export function agentRecord(runDir, agentId) {
  return findAgent(loadRun(runDir), agentId);
}

function decisionBlock(line, remark, nameOf) {
  const d = line.decision ?? {};
  const a = line.applied ?? {};
  const name = optionNamer(line, nameOf);
  const via = [d.model, isNum(d.latencyMs) ? `${d.latencyMs} ms` : null].filter(Boolean).join(', ');
  const out = ['', `### ${line.id} · ${line.clock} · ${kindText(line)} · ${d.provider ?? '?'}${via ? ` (${via})` : ''}`];
  if (situation(line)) out.push(`Situation: ${situation(line)}`);
  if (line.asks?.yesNo) {
    const p = isNum(d.yesProb) ? `yes ${fmtProb(d.yesProb)} · ` : '';
    out.push(`- ${line.asks.yesNo}: ${p}→ ${a.yes ? 'yes' : 'no'}`);
  }
  if (a.action != null || d.choiceProbs) {
    const question = line.asks?.choice ?? 'next_place';
    out.push(d.choiceProbs ? `- ${question}: ${choiceProbsText(line, nameOf)}` : `- ${question}: rule policy chose ${name(a.action)}`);
  }
  if (isNum(a.frustration)) out.push(`- frustration: ${fmtNum(a.frustration, 2)} (${feelingWords(a.frustration)})`);
  if (line.asks?.tellOthers) {
    const p = isNum(d.tellProb) ? `${fmtProb(d.tellProb)} → ` : '';
    const told = a.tell ? `told others: ${remark ? remarkText(remark.kind, nameOf(remark.placeId ?? remark.edgeId)) : a.remarkKind}` : 'kept it to themselves';
    out.push(`- tell others: ${p}${told}`);
  }
  if (d.error) out.push(`- fallback reason: ${d.error}`);
  if (a.summary) out.push(`→ ${a.summary}`);
  return out;
}

export function agentLog(runDir, agentId) {
  const run = loadRun(runDir);
  const rec = findAgent(run, agentId);
  if (!rec) throw new Error(`Agent ${agentId} is not in the run at ${runDir}`);
  const { agent, persona, decisions, remarks } = rec;
  const spec = run.spec;
  const nameOf = nameLookup(spec);
  const clock = t => (isNum(t) ? clockText(spec, t) : '–');
  const group = (spec?.archetypes ?? []).find(g => g.id === agent.archetypeId)?.name ?? agent.archetypeId;
  const out = [`# Agent ${agent.id} · ${agent.personaName ?? persona?.name ?? 'unknown'}`, ''];
  out.push(`- Group ${group} · persona \`${agent.personaId}\`${persona?.age != null ? ` · age ${persona.age}` : ''} · ` +
    `${spec?.mode === 'route' ? 'live traffic' : 'live wait app'}: ${agent.informed ? 'yes' : 'no'}`);
  if (persona?.bio) out.push(`- About: ${persona.bio}`);
  const traits = [['Personality', persona?.personality], ['Wants', persona?.goal], ['Listens to', persona?.social]]
    .filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (traits.length) out.push(`- ${traits.join(' · ')}`);
  out.push(`- Outcome: served ${fmtInt(agent.served)} · waited ${fmtMin(agent.waitTotal)} in lines · ` +
    `abandoned ${fmtInt(agent.abandons)} · frustration ${isNum(agent.frustration) ? `${fmtNum(agent.frustration, 2)} (${feelingWords(agent.frustration)})` : '–'} · ` +
    `arrived ${clock(agent.born)} · done ${clock(agent.done)}`);

  // Each `tell` adds exactly one remark, in resolve order, so told decisions and remarks line up.
  let nextRemark = 0;
  out.push('', `## Decisions (${decisions.length})`);
  for (const line of decisions) {
    const remark = line.applied?.tell ? remarks[nextRemark++] : null;
    out.push(...decisionBlock(line, remark, nameOf));
  }
  out.push('', '## Trace', '');
  for (const step of agent.trace ?? []) out.push(`- ${clock(step.t)} ${step.m}`);
  if (!(agent.trace ?? []).length) out.push('No trace entries.');
  return out.join('\n') + '\n';
}

