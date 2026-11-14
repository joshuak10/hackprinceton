#!/usr/bin/env node
// Swarmscope MCP server over stdio (docs/PROTOTYPE.md §10). Registered in .mcp.json as "swarmscope".
// stdout carries the MCP protocol only: every log line goes to stderr.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadEnv } from '../engine/env.js';
import { validateWorld, specHash } from '../engine/spec.js';
import { makeProvider } from '../providers/index.js';
import { runSwarm, runSeeds, compareRuns, headlineKpis } from '../run/runner.js';
import { createRecorder, listRuns } from '../run/recorder.js';
import {
  reportMarkdown, agentLog, kpiLine, formatKpi, countsText, KPI_LABELS,
  fmtInt, fmtNum, fmtPct, fmtMin, providerStatsLine, fallbackWarning
} from '../run/report.js';

// Anything an imported module prints with console.log would corrupt the protocol stream.
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORLDS = join(REPO, 'worlds');
const RUNS = join(REPO, 'runs');
const TOKENS_PER_REQUEST = 900;
const PRICE_PER_MTOK = 0.042;
const PRICE_NOTE = `$${PRICE_PER_MTOK} per million input tokens (TypeSafe published price, unverified)`;
const DEFAULT_COMPARE_SEEDS = 3;
const MAX_SEEDS = 50;

loadEnv({ cwd: REPO });
if (process.cwd() !== REPO) loadEnv();

class ToolError extends Error {}

// ---------- small helpers ----------
const log = message => process.stderr.write(`swarmscope-mcp: ${message}\n`);
const text = value => ({ content: [{ type: 'text', text: value }] });
const failure = message => ({ content: [{ type: 'text', text: message }], isError: true });
const seedRange = (seed, n) => Array.from({ length: n }, (_, i) => seed + i);
const defined = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

// Columns whose cells all start with a number are right-aligned.
function table(headers, rows) {
  const cells = [headers, ...rows].map(r => r.map(c => String(c ?? '')));
  const widths = headers.map((_, i) => Math.max(...cells.map(r => r[i].length)));
  const numeric = headers.map((_, i) => rows.length > 0 && rows.every(r => /^[-+]?[\d$]/.test(String(r[i] ?? ''))));
  return cells
    .map(r => r.map((c, i) => (numeric[i] ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ').trimEnd())
    .join('\n');
}

function parseJsonArg(value, what) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new ToolError(`${what} is not valid JSON: ${err.message}`);
  }
}

// ---------- worlds ----------
function exampleNames() {
  try {
    return readdirSync(WORLDS).filter(f => f.endsWith('.json') && f !== 'schema.json').map(f => f.slice(0, -5)).sort();
  } catch {
    return [];
  }
}

function readJsonFile(file, what) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ToolError(`Could not read ${what} ${file}: ${err.message}`);
  }
}

// Same resolution as the CLI: a path to JSON (from the working directory or the repo) or an example name in worlds/.
function readWorld(ref) {
  const candidates = [
    resolve(ref), resolve(`${ref}.json`), resolve(REPO, ref), resolve(REPO, `${ref}.json`),
    join(WORLDS, ref), join(WORLDS, `${ref}.json`)
  ];
  const file = candidates.find(f => existsSync(f) && statSync(f).isFile());
  if (!file) throw new ToolError(`World "${ref}" not found. Pass a path to a JSON file or an example name: ${exampleNames().join(', ')}`);
  return { where: file, raw: readJsonFile(file, 'world') };
}

// The raw world from `spec` (object or JSON text) or `world` (a name or path).
function rawWorld({ world, spec }) {
  if (spec !== undefined && spec !== null && spec !== '') return { where: 'the spec', raw: parseJsonArg(spec, 'spec') };
  if (world) return readWorld(world);
  throw new ToolError('Pass either world (an example name or a path to a world JSON file) or spec (a world object).');
}

// Validated, normalized spec; validation errors stop the tool.
function checkedSpec(args) {
  const { where, raw } = rawWorld(args);
  const result = validateWorld(raw);
  if (!result.ok) throw new ToolError(`${where} is not a valid world:\n${result.errors.map(e => `- ${e}`).join('\n')}`);
  return { spec: result.spec, warnings: result.warnings };
}

function worldSummary(spec) {
  const span = `${fmtInt(spec.arrivals.total)} arrivals over minutes ${fmtNum(spec.arrivals.start)}–${fmtNum(spec.arrivals.end)} of ${spec.duration}`;
  const cast = `${spec.archetypes.length} groups · ${spec.minds.length} people in the cast`;
  if (spec.mode === 'route') return `route world "${spec.title}" · ${spec.nodes.length} nodes · ${spec.edges.length} roads · ${cast} · ${span}`;
  const services = spec.nodes.filter(n => n.kind === 'service').length;
  return `visit world "${spec.title}" · ${spec.nodes.length} places (${services} services) · ${cast} · ${span}`;
}

function readPatch(patch) {
  const raw = parseJsonArg(patch, 'patch');
  const ops = Array.isArray(raw) ? raw : raw?.patch;
  if (!Array.isArray(ops)) throw new ToolError('patch must be an array of operations ({ kind, id, field, value }) or { "patch": [...] }');
  return ops;
}

// ---------- runs and providers ----------
function resolveRunDir(ref) {
  const id = String(ref ?? '').trim();
  if (!id) throw new ToolError('Pass runId (a run id from list_runs, a run folder, or "latest").');
  if (id === 'latest') {
    const [newest] = listRuns(RUNS);
    if (!newest) throw new ToolError(`No recorded runs in ${RUNS}`);
    return join(RUNS, newest.runId);
  }
  for (const dir of [join(RUNS, id), resolve(id), resolve(REPO, id)]) {
    if (existsSync(join(dir, 'meta.json'))) return dir;
  }
  throw new ToolError(`No recorded run "${id}". list_runs shows the recorded runs.`);
}

let jevBusy = false;

function providerFor(name, opts, runDir = null) {
  if (name === 'rules') return makeProvider('rules');
  if (name === 'jev') return makeProvider('jev', defined(opts));
  if (name === 'replay') return makeProvider('replay', { runDir });
  throw new ToolError(`Unknown provider "${name}" (use rules, jev or replay)`);
}

// One Jev run at a time, so two tool calls never spend in parallel.
async function exclusive(providerName, fn) {
  if (providerName !== 'jev') return fn();
  if (jevBusy) throw new ToolError('A Jev run is already in progress in this server; wait for it to finish.');
  jevBusy = true;
  try {
    return await fn();
  } finally {
    jevBusy = false;
  }
}

// Seeds as a count (seed..seed+N-1) or an explicit list.
function seedList(seed, seeds, fallbackCount) {
  if (Array.isArray(seeds)) {
    if (!seeds.length) throw new ToolError('seeds must not be an empty list');
    if (seeds.length > MAX_SEEDS) throw new ToolError(`At most ${MAX_SEEDS} seeds per call`);
    return seeds;
  }
  const n = seeds ?? fallbackCount;
  if (n > MAX_SEEDS) throw new ToolError(`At most ${MAX_SEEDS} seeds per call`);
  return seedRange(seed, n);
}

// MCP progress notifications when the client asked for them (a progressToken in the request).
function progressReporter(extra) {
  const token = extra?._meta?.progressToken;
  if (token === undefined) return null;
  return p => {
    const seed = p.seed != null ? `seed ${p.seed} · ` : '';
    extra.sendNotification({
      method: 'notifications/progress',
      params: {
        progressToken: token,
        progress: Math.round(p.t),
        total: p.duration,
        message: `${seed}${Math.round(p.t)}/${p.duration} sim min · ${fmtInt(p.decisions)} decisions`
      }
    }).catch(() => {});
  };
}

// ---------- result text ----------
function bottleneckTable(metrics, limit = 5) {
  if (metrics.mode === 'route') {
    const edges = [...(metrics.edges ?? [])].sort((a, b) => b.delayMinutes - a.delayMinutes).slice(0, limit);
    return table(['#', 'Road', 'Delay min', 'Delay ratio', 'Peak load', 'Traversals'],
      edges.map((e, i) => [i + 1, e.name, fmtInt(e.delayMinutes), `${fmtNum(e.delayRatio, 2)}×`, fmtPct(e.peakRatio, 0), fmtInt(e.traversals)]));
  }
  const nodes = [...(metrics.nodes ?? [])].sort((a, b) => b.score - a.score).slice(0, limit);
  return table(['#', 'Place', 'Score', 'Avg wait', 'Abandoned', 'Max queue', 'Utilization'],
    nodes.map((n, i) => [i + 1, n.name, fmtInt(n.score), fmtMin(n.avgWait), fmtInt(n.abandoned), fmtInt(n.maxQueue), fmtPct(n.utilization, 0)]));
}

function decisionsLine(decisions) {
  if (!decisions?.total) return 'Decisions: inline rule policy (no decision requests)';
  return `Decisions: ${fmtInt(decisions.total)} (${countsText(decisions.byKind)}) · by provider: ${countsText(decisions.byProvider)}`;
}

function meanSdLine(summary) {
  return Object.entries(summary.kpis)
    .map(([k, { mean, sd }]) => `${KPI_LABELS[k]} ${formatKpi(k, mean)} ± ${formatKpi(k, sd)}`).join(' · ');
}

function frequencyLine(summary) {
  const n = summary.seeds.length;
  return summary.bottleneckFrequency.filter(f => f.first).map(f => `${f.name} ${f.first}/${n}`).join(' · ') || '–';
}

function patchLines({ applied, skipped }) {
  return [...applied.map(a => `patch: ${a}`), ...skipped.map(s => `patch skipped: ${JSON.stringify(s)}`)];
}

function formatDelta(k, d, base) {
  const sign = d > 0 ? '+' : d < 0 ? '-' : '';
  const abs = Math.abs(d);
  const amount = k === 'abandonRate' ? `${(abs * 100).toFixed(1)} pts` : formatKpi(k, abs);
  const rel = base ? ` (${sign}${fmtPct(abs / Math.abs(base), 0)})` : '';
  return `${sign}${amount}${rel}`;
}

function mergeDecisions(a, b) {
  const byProvider = { ...a.byProvider };
  for (const [k, n] of Object.entries(b.byProvider)) byProvider[k] = (byProvider[k] ?? 0) + n;
  return { total: a.total + b.total, byProvider };
}

const warningsNote = warnings => (warnings.length ? `note: ${warnings.length} validation warning(s); validate_world lists them` : null);

function singleRunText(spec, providerName, seed, res, seconds, warnings) {
  const { metrics, providerStats } = res;
  return [
    `${spec.title} · ${providerName} · seed ${seed} · spec ${specHash(spec)}`,
    warningsNote(warnings),
    kpiLine(headlineKpis(metrics)),
    '',
    bottleneckTable(metrics),
    '',
    decisionsLine(metrics.decisions),
    `Provider: ${providerStatsLine(providerStats, metrics)}`,
    fallbackWarning(metrics),
    res.runId ? `Run ${res.runId} (report { runId: "${res.runId}" } for the digest)` : null,
    `Finished in ${seconds.toFixed(1)} s`
  ].filter(line => line !== null).join('\n');
}

function seedRunsText(spec, providerName, res, seconds, providerStats, warnings) {
  const { runs, summary } = res;
  const kpiNames = Object.keys(summary.kpis);
  const lines = [
    `${spec.title} · ${providerName} · seeds ${summary.seeds.join(', ')} · spec ${specHash(spec)}`,
    warningsNote(warnings),
    '',
    table(
      ['seed', ...kpiNames.map(k => KPI_LABELS[k]), '#1 bottleneck', 'run'],
      runs.map(r => [r.seed, ...kpiNames.map(k => formatKpi(k, r.kpis[k])), r.kpis.top[0]?.name ?? '–', r.runId ?? '–'])
    ),
    '',
    `Mean ± sd over ${runs.length} seeds: ${meanSdLine(summary)}`,
    `#1 bottleneck: ${frequencyLine(summary)}`,
    decisionsLine(summary.decisions),
    `Provider (all seeds): ${providerStatsLine(providerStats, { decisions: summary.decisions })}`
  ];
  for (const r of runs) {
    const warning = fallbackWarning(r.metrics);
    if (warning) lines.push(`seed ${r.seed}: ${warning}`);
  }
  lines.push(`Finished in ${seconds.toFixed(1)} s`);
  return lines.filter(line => line !== null).join('\n');
}

// ---------- tools ----------
async function listWorldsTool() {
  const rows = [];
  for (const name of exampleNames()) {
    try {
      const w = JSON.parse(readFileSync(join(WORLDS, `${name}.json`), 'utf8'));
      rows.push([name, w.mode ?? 'visit', fmtInt(w.arrivals?.total), fmtInt(w.minds?.length ?? 0), w.title ?? '–']);
      if (w.question) rows.push(['', '', '', '', `Q: ${w.question}`]);
    } catch (err) {
      rows.push([name, '?', '–', '–', `unreadable: ${err.message}`]);
    }
  }
  if (!rows.length) return text(`No worlds in ${WORLDS}.`);
  return text(`Worlds in worlds/ (pass the name as world):\n\n${table(['world', 'mode', 'agents', 'cast', 'title'], rows)}`);
}

async function validateWorldTool(args) {
  const { where, raw } = rawWorld(args);
  const result = validateWorld(raw);
  const lines = [`${where}: ${result.ok ? 'OK' : 'INVALID'}`];
  if (result.spec) lines.push(`${worldSummary(result.spec)} · spec ${specHash(result.spec)}`);
  for (const [label, list] of [['Errors', result.errors], ['Warnings', result.warnings]]) {
    if (!list.length) continue;
    lines.push(`${label} (${list.length}):`, ...list.map(m => `- ${m}`));
  }
  return result.ok ? text(lines.join('\n')) : failure(lines.join('\n'));
}

async function estimateTool(args, extra) {
  const { spec, warnings } = checkedSpec(args);
  const seed = args.seed ?? 7;
  const { metrics } = await runSwarm({
    spec, seed, provider: makeProvider('rules-external'), onProgress: progressReporter(extra), signal: extra?.signal
  });
  const requests = metrics.decisions?.total ?? 0;
  const tokens = requests * TOKENS_PER_REQUEST;
  const cost = (tokens * PRICE_PER_MTOK) / 1e6;
  return text([
    `${spec.title} · seed ${seed} · rules dry run with ${fmtInt(metrics.spawned)} agents`,
    warningsNote(warnings),
    `Decision requests: ${fmtInt(requests)}${requests ? ` (${countsText(metrics.decisions.byKind)})` : ''}`,
    `Est. Jev requests per seed: ${fmtInt(requests)} (every request; no cache hits assumed)`,
    `Est. input tokens per seed: ${fmtInt(tokens)} (~${TOKENS_PER_REQUEST} per request)`,
    `Est. cost per seed: $${cost.toFixed(cost < 1 ? 4 : 2)} at ${PRICE_NOTE}`
  ].filter(line => line !== null).join('\n'));
}

async function runSwarmTool(args, extra) {
  const providerName = args.provider ?? (args.from ? 'replay' : 'rules');
  const fromDir = args.from ? resolveRunDir(args.from) : null;
  if (providerName === 'replay' && !fromDir) throw new ToolError('provider "replay" needs from (the run id to replay)');
  if (fromDir && providerName !== 'replay') throw new ToolError('from replays a recorded run; use provider "replay" or leave provider out');

  const recordedMeta = fromDir ? readJsonFile(join(fromDir, 'meta.json'), 'run meta') : null;
  const worldArgs = fromDir && !args.world && !args.spec ? { spec: readJsonFile(join(fromDir, 'spec.json'), 'recorded spec') } : args;
  const { spec, warnings } = checkedSpec(worldArgs);
  const seed = args.seed ?? recordedMeta?.seed ?? 7;
  const seeds = seedList(seed, args.seeds, 1);
  const record = args.record ?? true;
  const label = fromDir ? `replay of ${recordedMeta.runId}` : null;
  const recorderFor = record ? s => createRecorder({ root: RUNS, spec, seed: s, providerName, label }) : null;
  const simOpts = args.batchWindow !== undefined ? { batchWindow: args.batchWindow } : {};
  const onProgress = progressReporter(extra);

  return exclusive(providerName, async () => {
    const provider = providerFor(providerName, { model: args.model, concurrency: args.concurrency, maxRequests: args.maxRequests }, fromDir);
    const started = Date.now();
    if (seeds.length === 1) {
      const res = await runSwarm({
        spec, seed: seeds[0], provider, recorder: recorderFor?.(seeds[0]) ?? null, simOpts, onProgress, signal: extra?.signal
      });
      return text(singleRunText(spec, providerName, seeds[0], res, (Date.now() - started) / 1000, warnings));
    }
    const res = await runSeeds({ spec, seeds, provider, recorderFor, simOpts, onProgress, signal: extra?.signal });
    return text(seedRunsText(spec, providerName, res, (Date.now() - started) / 1000, provider.stats(), warnings));
  });
}

async function compareTool(args, extra) {
  const providerName = args.provider ?? 'rules';
  const { spec, warnings } = checkedSpec(args);
  const patch = readPatch(args.patch);
  const seeds = seedList(args.seed ?? 7, args.seeds, DEFAULT_COMPARE_SEEDS);
  const record = args.record ?? providerName === 'jev';
  const recorderFor = record
    ? (s, side) => createRecorder({ root: RUNS, spec, seed: s, providerName, label: `compare ${side}` })
    : null;
  const simOpts = args.batchWindow !== undefined ? { batchWindow: args.batchWindow } : {};

  return exclusive(providerName, async () => {
    const provider = providerFor(providerName, { model: args.model, concurrency: args.concurrency, maxRequests: args.maxRequests });
    const res = await compareRuns({
      spec, patch, seeds, provider, recorderFor, simOpts, onProgress: progressReporter(extra), signal: extra?.signal
    });
    const providerStats = provider.stats();
    const lines = [`${spec.title} · compare · ${providerName} · seeds ${seeds.join(', ')}`, warningsNote(warnings), ...patchLines(res)];
    if (!res.applied.length) lines.push('(no patch operation applied; before and after are the same world)');
    lines.push('', table(['KPI', 'before', 'after', 'change'], Object.keys(res.delta).map(k => {
      const b = res.before.kpis[k], a = res.after.kpis[k];
      return [KPI_LABELS[k], `${formatKpi(k, b.mean)} ± ${formatKpi(k, b.sd)}`, `${formatKpi(k, a.mean)} ± ${formatKpi(k, a.sd)}`, formatDelta(k, res.delta[k], b.mean)];
    })));
    lines.push('', `#1 bottleneck before: ${frequencyLine(res.before)}`, `#1 bottleneck after:  ${frequencyLine(res.after)}`);
    const after = new Map(res.after.places.map(p => [p.id, p.meanScore]));
    lines.push('Mean bottleneck score, before → after:', table(['Place', 'before', 'after', 'change'], res.before.places.slice(0, 5).map(p => {
      const a = after.get(p.id) ?? 0;
      return [p.name, fmtInt(p.meanScore), fmtInt(a), formatDelta('score', a - p.meanScore, p.meanScore)];
    })));
    lines.push('', `Provider: ${providerStatsLine(providerStats, { decisions: mergeDecisions(res.before.decisions, res.after.decisions) })}`);
    for (const [side, summary] of [['before', res.before], ['after', res.after]]) {
      const warning = fallbackWarning({ decisions: summary.decisions });
      if (warning) lines.push(`${side}: ${warning}`);
    }
    return text(lines.filter(line => line !== null).join('\n'));
  });
}

async function reportTool({ runId }) {
  return text(reportMarkdown(resolveRunDir(runId)));
}

async function agentLogTool({ runId, agentId }) {
  return text(agentLog(resolveRunDir(runId), String(agentId)));
}

async function listRunsTool({ limit }) {
  const metas = listRuns(RUNS);
  if (!metas.length) return text(`No recorded runs in ${RUNS}.`);
  const shown = metas.slice(0, limit ?? 20);
  const rows = shown.map(m => [
    m.runId, String(m.createdAt ?? '').replace('T', ' ').slice(0, 16), m.provider, m.model ?? '–', m.seed,
    fmtInt(m.agents), fmtInt(m.decisions), m.status
  ]);
  const more = metas.length > shown.length ? `\n(${metas.length - shown.length} older runs not shown)` : '';
  return text(table(['run', 'created', 'provider', 'model', 'seed', 'agents', 'decisions', 'status'], rows) + more);
}

// Turns thrown errors into tool errors (isError: true) with a readable message.
function guarded(name, fn) {
  return async (args, extra) => {
    try {
      return await fn(args ?? {}, extra);
    } catch (err) {
      if (err?.name === 'JevAuthError' || err?.constructor?.name === 'JevAuthError') {
        return failure('Jev rejected the API key (HTTP 401). Check TYPESAFE_API_KEY in .env.local.');
      }
      if (err?.name === 'AbortError') return failure(`${name} was cancelled. A run being recorded is kept with status "error".`);
      if (!(err instanceof ToolError)) log(`${name} failed: ${err?.stack ?? err}`);
      return failure(`${name}: ${err?.message ?? err}`);
    }
  };
}

// ---------- schemas ----------
const worldArg = z.string().optional()
  .describe('An example world name from list_worlds (e.g. "theme-park") or a path to a world JSON file. Use this or spec.');
const specArg = z.union([z.record(z.string(), z.any()), z.string()]).optional()
  .describe('A world spec object (see worlds/SCHEMA.md), or its JSON text. Use this or world.');
const seedArg = z.number().int().min(0).optional().describe('Seed (default 7).');
const seedsArg = z.union([z.number().int().min(1).max(MAX_SEEDS), z.array(z.number().int().min(0)).min(1).max(MAX_SEEDS)]).optional();
const jevArgs = {
  model: z.string().optional().describe('Jev model id (default jev-latest).'),
  concurrency: z.number().int().min(1).max(256).optional().describe('Parallel Jev requests (default 32).'),
  maxRequests: z.number().int().min(0).optional().describe('Jev API request budget for this call (default 20000); beyond it decisions fall back to rules.'),
  batchWindow: z.number().min(0).optional().describe('Sim minutes decision requests are held before release.')
};

const server = new McpServer(
  { name: 'swarmscope', version: '0.2.0' },
  {
    instructions:
      'Swarmscope simulates crowds (visit worlds with places and lines, or route worlds with roads) where every agent ' +
      'decides through Jev. Typical flow: list_worlds or write a world (worlds/SCHEMA.md) → validate_world → estimate ' +
      '(ask the user before a Jev run over $1) → run_swarm → report → compare patches on the same seeds. ' +
      'Treat results as rankings, not forecasts.'
  }
);

server.registerTool('list_worlds', {
  title: 'List worlds',
  description: 'List the example worlds in worlds/ with mode, agent count, cast size, title and question.',
  inputSchema: {}
}, guarded('list_worlds', listWorldsTool));

server.registerTool('validate_world', {
  title: 'Validate a world',
  description: 'Check a world spec: errors (fatal) and warnings (silent fixes), each naming the field path, plus a one-line summary and spec hash.',
  inputSchema: { spec: specArg, world: worldArg }
}, guarded('validate_world', validateWorldTool));

server.registerTool('estimate', {
  title: 'Estimate Jev cost',
  description: 'Rules dry run that counts decision requests, then estimates Jev requests, input tokens (~900 per request) and cost for one seed. No API calls.',
  inputSchema: { world: worldArg, spec: specArg, seed: seedArg }
}, guarded('estimate', estimateTool));

server.registerTool('run_swarm', {
  title: 'Run a simulation',
  description:
    'Simulate a world and record it under runs/. provider "rules" is free and fast; "jev" makes live Jev API calls ' +
    '(run estimate first); "replay" re-answers from a recorded run (from) with no API calls. ' +
    'seeds runs several seeds and reports mean ± sd and how often each place is the #1 bottleneck. Returns headline KPIs, ' +
    'the bottleneck table, provider stats and run ids for report and agent_log.',
  inputSchema: {
    world: worldArg,
    spec: specArg,
    provider: z.enum(['rules', 'jev', 'replay']).optional().describe('Who decides (default rules, or replay when from is set).'),
    seed: seedArg,
    seeds: seedsArg.describe('Number of seeds (seed..seed+N-1) or an explicit list of seeds (default 1).'),
    from: z.string().optional().describe('Run id to replay (provider replay). world/spec are optional then; the recorded spec is used.'),
    record: z.boolean().optional().describe('Record the run(s) under runs/ (default true).'),
    ...jevArgs
  }
}, guarded('run_swarm', runSwarmTool));

server.registerTool('compare', {
  title: 'Compare a what-if patch',
  description:
    'Before/after on the same seeds: applies a patch (array of { kind, id, field, value }, e.g. ' +
    '{ "kind": "node", "id": "rides", "field": "servers", "value": 4 }) and reports the KPI changes and bottleneck shifts. ' +
    'Records the runs by default only with provider jev.',
  inputSchema: {
    world: worldArg,
    spec: specArg,
    patch: z.union([z.array(z.record(z.string(), z.any())), z.record(z.string(), z.any()), z.string()])
      .describe('Patch operations: an array of { kind, id, field, value }, { "patch": [...] }, or its JSON text.'),
    provider: z.enum(['rules', 'jev']).optional().describe('Who decides (default rules).'),
    seed: seedArg,
    seeds: seedsArg.describe(`Number of seeds (seed..seed+N-1) or an explicit list of seeds (default ${DEFAULT_COMPARE_SEEDS}).`),
    record: z.boolean().optional().describe('Record every run under runs/ (default: only with provider jev).'),
    ...jevArgs
  }
}, guarded('compare', compareTool));

server.registerTool('report', {
  title: 'Run report',
  description: 'Markdown digest of a recorded run: KPIs, bottlenecks, remarks, per-group outcomes, torn decisions, frustration, provider stats.',
  inputSchema: { runId: z.string().describe('Run id from run_swarm or list_runs, a run folder, or "latest".') }
}, guarded('report', reportTool));

server.registerTool('agent_log', {
  title: 'Agent log',
  description: "One agent's persona, every decision with its probabilities and sampled action, remarks, and trace.",
  inputSchema: {
    runId: z.string().describe('Run id from run_swarm or list_runs, a run folder, or "latest".'),
    agentId: z.union([z.string(), z.number()]).describe('Agent id as recorded in the run (see the report or agents.json).')
  }
}, guarded('agent_log', agentLogTool));

server.registerTool('list_runs', {
  title: 'List runs',
  description: 'Recorded runs under runs/, newest first: run id, created time, provider, model, seed, agents, decisions, status.',
  inputSchema: { limit: z.number().int().min(1).max(500).optional().describe('How many runs to show (default 20).') }
}, guarded('list_runs', listRunsTool));

await server.connect(new StdioServerTransport());
log(`ready (repo ${REPO})`);
