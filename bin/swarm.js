#!/usr/bin/env node
// Swarmscope CLI (docs/PROTOTYPE.md §8). `swarm --help` lists the commands.
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname, relative, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadEnv, hasKey } from '../engine/env.js';
import { slug } from '../engine/util.js';
import { validateWorld, applyPatch, specHash } from '../engine/spec.js';
import { makeProvider } from '../providers/index.js';
import { runSwarm, runSeeds, compareRuns, headlineKpis } from '../run/runner.js';
import { createRecorder, listRuns } from '../run/recorder.js';
import {
  reportMarkdown, agentLog, agentRecord, formatKpi, kpiLine, countsText, KPI_LABELS,
  fmtInt, fmtNum, fmtPct, fmtMin, providerStatsLine, fallbackRate, fallbackWarning
} from '../run/report.js';

loadEnv();

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORLDS = join(REPO, 'worlds');
const TOKENS_PER_REQUEST = 900;
const PRICE_PER_MTOK = 0.042;
const DEFAULT_COMPARE_SEEDS = 3;

const USAGE = `Swarmscope: a crowd simulator where every agent decides through Jev.

Usage: swarm <command> [options]

  validate <world>                  Check a world and list errors and warnings
  estimate <world> [--seed 7]       Count decision requests with a rules dry run;
                                    estimate Jev requests, input tokens and cost
  run <world> [options]             Simulate a world and record it under runs/
      --provider jev|rules|replay   Who decides (default rules)
      --seed N                      Seed (default 7, or the recorded seed with --from)
      --seeds N                     Run seeds seed..seed+N-1 and print mean ± sd
      --model ID                    Jev model (default jev-latest)
      --concurrency N               Parallel Jev requests (default 32)
      --max-requests N              Jev request budget for the whole command (default 20000)
      --batch-window M              Sim minutes decision requests are held before release
      --patch FILE                  Apply a what-if patch (JSON array of {kind, id, field, value})
      --from RUN                    Replay a recorded run's decisions, no API calls (world optional)
      --out DIR                     Runs folder (default runs)
      --no-record                   Don't record the run
  compare <world> --patch FILE [--provider rules|jev] [--seeds N] [--seed 7] [--record | --no-record]
                                    Before/after on the same seeds (default ${DEFAULT_COMPARE_SEEDS} seeds;
                                    records by default only with --provider jev)
  report <run>                      Markdown digest of a recorded run
  agent <run> <agentId>             One agent's persona, decisions with probabilities, and trace
  runs                              List recorded runs
  building --model <matterportId> | --plan-raw <file.json>
           --profile <file.json> [--scenario weekday-lunch] [--floor N]
           [--overrides file.json] [--out worlds/<slug>.json] [--save-raw data/<id>.json]
                                    Compose a walled, doored building world from a Matterport floor
                                    plan and a CoStar profile (§14e); prints rooms, tenants, doors,
                                    warnings and every assumption used
  fitout <fitout.json> [--plan-raw data/<id>.json | --model <id>] [--floor N] [--margin 8]
         [--out data/worlds/<slug>.json]
                                    Place a proposed fit-out (gates and places in meters) inside a
                                    real Matterport floor plan; writes a walled, doored world (§14f)
  import-matterport <modelId> [--floor N] [--mode route|visit] [--out worlds/<slug>.json] [--save-raw data/<id>.json]
  import-matterport --from-raw <file.json> [...]
                                    Starter world with walls from a Matterport model (no API call
                                    with --from-raw)
  import-mesh <file.obj> [--out FILE] [--up z|y]
                                    Starter world with walls sliced from a 3D mesh (check by eye)
  compile "<description>" [--out FILE] [--force]
                                    Write a world with Claude (needs ANTHROPIC_API_KEY)
  serve [--port 4173]               Start the local viewer
  sanity [--model jev-latest]       Live Jev checks (makes a few hundred API calls)

<world> is a path to a world JSON file or an example name (${exampleNames().join(', ')}).
<run> is a run folder, a run id under the runs folder, or "latest".
--json prints machine-readable output. --out also sets where report, agent, runs and --from look.
Keys come from .env.local: TYPESAFE_API_KEY (Jev) and ANTHROPIC_API_KEY (compile only).
Set SWARM_DEBUG=1 to print stack traces.
`;

const COMPILE_WITHOUT_KEY = `swarm compile needs ANTHROPIC_API_KEY in .env.local.

Without a key, let Claude Code write the world instead: open this repo in Claude Code and run
  /swarm <the place and the question>
Claude reads worlds/SCHEMA.md, writes worlds/<slug>.json, validates and estimates it, runs it
with Jev, and reports findings.`;

class CliError extends Error {}

// ---------- argument parsing ----------
const BOOL_FLAGS = new Set(['json', 'help', 'no-record', 'record', 'force']);
const JEV_FLAGS = ['model', 'concurrency', 'max-requests'];
const COMMANDS = {
  validate: { min: 1, max: 1, flags: ['json'], run: cmdValidate },
  estimate: { min: 1, max: 1, flags: ['seed', 'batch-window', 'json'], run: cmdEstimate },
  run: {
    min: 0, max: 1, run: cmdRun,
    flags: ['provider', 'seed', 'seeds', ...JEV_FLAGS, 'batch-window', 'patch', 'from', 'out', 'no-record', 'json']
  },
  compare: {
    min: 1, max: 1, run: cmdCompare,
    flags: ['patch', 'provider', 'seed', 'seeds', ...JEV_FLAGS, 'batch-window', 'out', 'record', 'no-record', 'json']
  },
  report: { min: 1, max: 1, flags: ['out', 'json'], run: cmdReport },
  agent: { min: 2, max: 2, flags: ['out', 'json'], run: cmdAgent },
  runs: { min: 0, max: 0, flags: ['out', 'json'], run: cmdRuns },
  compile: { min: 1, max: Infinity, flags: ['out', 'force', 'json'], run: cmdCompile },
  building: {
    min: 0, max: 0, run: cmdBuildingLazy,
    flags: ['model', 'plan-raw', 'profile', 'scenario', 'floor', 'overrides', 'out', 'save-raw']
  },
  fitout: { min: 1, max: 1, flags: ['plan-raw', 'model', 'floor', 'margin', 'out'], run: cmdFitoutLazy },
  'import-matterport': {
    min: 0, max: 1, run: (a, f) => cmdImportLazy('cmdImportMatterport', a, f),
    flags: ['floor', 'mode', 'out', 'save-raw', 'from-raw']
  },
  'import-mesh': { min: 1, max: 1, flags: ['out', 'up'], run: (a, f) => cmdImportLazy('cmdImportMesh', a, f) },
  serve: { min: 0, max: 0, flags: ['port'], run: cmdServe },
  sanity: { min: 0, max: 0, flags: ['model'], run: cmdSanity }
};

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') { flags.help = true; continue; }
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    if (BOOL_FLAGS.has(name)) {
      if (eq >= 0) throw new CliError(`--${name} takes no value`);
      flags[name] = true;
      continue;
    }
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined) throw new CliError(`--${name} needs a value`);
    flags[name] = value;
  }
  return { positional, flags };
}

function intFlag(flags, name, fallback, min = 0) {
  if (flags[name] === undefined) return fallback;
  const n = Number(flags[name]);
  if (!Number.isInteger(n) || n < min) throw new CliError(`--${name} must be a whole number, at least ${min}`);
  return n;
}

function simOptsFrom(flags) {
  if (flags['batch-window'] === undefined) return {};
  const m = Number(flags['batch-window']);
  if (!Number.isFinite(m) || m < 0) throw new CliError('--batch-window must be a number of sim minutes, 0 or more');
  return { batchWindow: m };
}

const seedRange = (seed, n) => Array.from({ length: n }, (_, i) => seed + i);

// ---------- output ----------
const print = (text = '') => process.stdout.write(text + '\n');
const printJson = value => print(JSON.stringify(value, null, 2));

function shortPath(p) {
  const rel = relative(process.cwd(), p);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : p;
}

// Columns whose cells all start with a number are right-aligned.
function table(headers, rows) {
  const cells = [headers, ...rows].map(r => r.map(c => String(c ?? '')));
  const widths = headers.map((_, i) => Math.max(...cells.map(r => r[i].length)));
  const numeric = headers.map((_, i) => rows.length > 0 && rows.every(r => /^[-+]?[\d$]/.test(String(r[i] ?? ''))));
  return cells
    .map(r => r.map((c, i) => (numeric[i] ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ').trimEnd())
    .join('\n');
}

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

function worldSummary(spec) {
  const span = `${fmtInt(spec.arrivals.total)} arrivals over minutes ${fmtNum(spec.arrivals.start)}–${fmtNum(spec.arrivals.end)} of ${spec.duration}`;
  const cast = `${spec.archetypes.length} groups · ${spec.minds.length} people in the cast`;
  if (spec.mode === 'route') return `route world "${spec.title}" · ${spec.nodes.length} nodes · ${spec.edges.length} roads · ${cast} · ${span}`;
  const services = spec.nodes.filter(n => n.kind === 'service').length;
  return `visit world "${spec.title}" · ${spec.nodes.length} places (${services} services) · ${cast} · ${span}`;
}

function progressPrinter() {
  if (!process.stderr.isTTY) return { onProgress: null, clear() {} };
  let shown = false;
  return {
    onProgress(p) {
      const seed = p.seed != null ? `seed ${p.seed} · ` : '';
      process.stderr.write(`\r\x1b[K  ${seed}${Math.round(p.t)}/${p.duration} sim min · ${fmtInt(p.decisions)} decisions`);
      shown = true;
    },
    clear() { if (shown) process.stderr.write('\r\x1b[K'); shown = false; }
  };
}

// ---------- worlds, runs, providers ----------
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
    throw new CliError(`Could not read ${what} ${file}: ${err.message}`);
  }
}

function readWorld(ref) {
  const candidates = [resolve(ref), resolve(`${ref}.json`), join(WORLDS, ref), join(WORLDS, `${ref}.json`)];
  const file = candidates.find(f => existsSync(f) && statSync(f).isFile());
  if (!file) throw new CliError(`World "${ref}" not found. Pass a path to a JSON file or an example name: ${exampleNames().join(', ')}`);
  return { file, raw: readJsonFile(file, 'world') };
}

// Validated, normalized spec; validation errors stop the command.
function checkedSpec(raw, where) {
  const result = validateWorld(raw);
  if (!result.ok) {
    throw new CliError(`${where} is not a valid world:\n${result.errors.map(e => `  - ${e}`).join('\n')}`);
  }
  if (result.warnings.length) {
    process.stderr.write(`note: ${result.warnings.length} validation warning(s); see swarm validate for details\n`);
  }
  return result.spec;
}

function readPatch(file) {
  const raw = readJsonFile(resolve(file), 'patch');
  const ops = Array.isArray(raw) ? raw : raw?.patch;
  if (!Array.isArray(ops)) throw new CliError(`${file} must hold a JSON array of patch operations ({ kind, id, field, value }) or { "patch": [...] }`);
  return ops;
}

function resolveRunDir(ref, root) {
  if (ref === 'latest') {
    const [newest] = listRuns(root);
    if (!newest) throw new CliError(`No recorded runs in ${root}`);
    return resolve(root, newest.runId);
  }
  for (const dir of [resolve(ref), resolve(root, ref)]) {
    if (existsSync(join(dir, 'meta.json'))) return dir;
  }
  throw new CliError(`No recorded run "${ref}" (looked for ${ref}/meta.json and ${join(root, ref)}/meta.json). List runs with: swarm runs`);
}

const defined = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

function providerFor(name, flags, runDir = null) {
  if (name === 'rules') return makeProvider('rules');
  if (name === 'jev') {
    return makeProvider('jev', defined({
      model: flags.model,
      concurrency: intFlag(flags, 'concurrency', undefined, 1),
      maxRequests: intFlag(flags, 'max-requests', undefined, 0)
    }));
  }
  if (name === 'replay') return makeProvider('replay', { runDir });
  throw new CliError(`Unknown provider "${name}" (use jev, rules or replay)`);
}

const isJevAuthError = err => err?.name === 'JevAuthError' || err?.constructor?.name === 'JevAuthError';

// Runs `fn(signal)` with Ctrl-C wired to abort it and the progress line cleared afterwards.
async function withAbort(progress, fn) {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);
  try {
    return await fn(controller.signal);
  } finally {
    process.off('SIGINT', onSigint);
    progress.clear();
  }
}

// ---------- commands ----------
function cmdValidate([ref], flags) {
  const { file, raw } = readWorld(ref);
  const result = validateWorld(raw);
  const hash = result.spec ? specHash(result.spec) : null;
  if (flags.json) {
    printJson({ file, ok: result.ok, errors: result.errors, warnings: result.warnings, specHash: hash });
    return result.ok ? 0 : 1;
  }
  print(`${shortPath(file)}: ${result.ok ? 'OK' : 'INVALID'}`);
  if (result.spec) print(`  ${worldSummary(result.spec)} · spec ${hash}`);
  for (const [label, list] of [['Errors', result.errors], ['Warnings', result.warnings]]) {
    if (!list.length) continue;
    print(`${label} (${list.length}):`);
    for (const message of list) print(`  - ${message}`);
  }
  return result.ok ? 0 : 1;
}

async function cmdEstimate([ref], flags) {
  const { file, raw } = readWorld(ref);
  const spec = checkedSpec(raw, shortPath(file));
  const seed = intFlag(flags, 'seed', 7);
  const { metrics } = await runSwarm({ spec, seed, provider: makeProvider('rules-external'), simOpts: simOptsFrom(flags) });
  const requests = metrics.decisions?.total ?? 0;
  const tokens = requests * TOKENS_PER_REQUEST;
  const cost = (tokens * PRICE_PER_MTOK) / 1e6;
  const priceNote = `$${PRICE_PER_MTOK} per million input tokens (TypeSafe published price, unverified)`;
  if (flags.json) {
    printJson({
      world: spec.title, seed, agents: metrics.spawned, decisionRequests: requests, byKind: metrics.decisions?.byKind ?? {},
      estJevRequests: requests, estInputTokens: tokens, estCostUSD: cost, priceNote
    });
    return 0;
  }
  print(`${spec.title} · seed ${seed} · rules dry run with ${fmtInt(metrics.spawned)} agents`);
  print(`Decision requests: ${fmtInt(requests)}${requests ? ` (${countsText(metrics.decisions.byKind)})` : ''}`);
  print(`Est. Jev requests: ${fmtInt(requests)} (every request; no cache hits assumed)`);
  print(`Est. input tokens: ${fmtInt(tokens)} (~${TOKENS_PER_REQUEST} per request)`);
  print(`Est. cost: $${cost.toFixed(cost < 1 ? 4 : 2)} at ${priceNote}`);
  return 0;
}

function printSingleRun(spec, providerName, seed, res, seconds, patchResult) {
  const { metrics, providerStats } = res;
  print(`${spec.title} · ${providerName} · seed ${seed} · spec ${specHash(spec)}`);
  if (patchResult) printPatch(patchResult);
  print(kpiLine(headlineKpis(metrics)));
  print();
  print(bottleneckTable(metrics));
  print();
  if (metrics.doors?.length) {
    print('Busiest doorways: ' + metrics.doors.slice(0, 3)
      .map(d => `${d.name ?? d.id} ${fmtInt(d.crossings)} crossings (peak ${fmtInt(d.peakPer5Min)}/5 min)`).join(' · '));
  }
  print(decisionsLine(metrics.decisions));
  print(`Provider: ${providerStatsLine(providerStats, metrics)}`);
  const warning = fallbackWarning(metrics);
  if (warning) print(warning);
  if (res.runDir) print(`Recorded ${shortPath(res.runDir)}  (swarm report ${shortPath(res.runDir)})`);
  print(`Finished in ${seconds.toFixed(1)} s`);
}

function meanSdLine(summary) {
  return Object.entries(summary.kpis)
    .map(([k, { mean, sd }]) => `${KPI_LABELS[k]} ${formatKpi(k, mean)} ± ${formatKpi(k, sd)}`).join(' · ');
}

function frequencyLine(summary) {
  const n = summary.seeds.length;
  return summary.bottleneckFrequency.filter(f => f.first).map(f => `${f.name} ${f.first}/${n}`).join(' · ') || '–';
}

function printSeedRuns(spec, providerName, res, seconds, patchResult, providerStats) {
  const { runs, summary } = res;
  const kpiNames = Object.keys(summary.kpis);
  print(`${spec.title} · ${providerName} · seeds ${summary.seeds[0]}..${summary.seeds.at(-1)} · spec ${specHash(spec)}`);
  if (patchResult) printPatch(patchResult);
  print();
  print(table(
    ['seed', ...kpiNames.map(k => KPI_LABELS[k]), '#1 bottleneck', 'run'],
    runs.map(r => [r.seed, ...kpiNames.map(k => formatKpi(k, r.kpis[k])), r.kpis.top[0]?.name ?? '–', r.runDir ? shortPath(r.runDir) : '–'])
  ));
  print();
  print(`Mean ± sd over ${runs.length} seeds: ${meanSdLine(summary)}`);
  print(`#1 bottleneck: ${frequencyLine(summary)}`);
  print(decisionsLine(summary.decisions));
  print(`Provider (all seeds): ${providerStatsLine(providerStats, { decisions: summary.decisions })}`);
  for (const r of runs) {
    const warning = fallbackWarning(r.metrics);
    if (warning) print(`seed ${r.seed}: ${warning}`);
  }
  print(`Finished in ${seconds.toFixed(1)} s`);
}

function printPatch({ applied, skipped }) {
  for (const a of applied) print(`  patch: ${a}`);
  for (const s of skipped) print(`  patch skipped: ${JSON.stringify(s)}`);
}

async function cmdRun([ref], flags) {
  const root = flags.out ?? 'runs';
  const fromDir = flags.from ? resolveRunDir(flags.from, root) : null;
  const providerName = flags.provider ?? (fromDir ? 'replay' : 'rules');
  if (fromDir && providerName !== 'replay') throw new CliError('--from replays a recorded run; drop --provider or use --provider replay');
  if (providerName === 'replay' && !fromDir) throw new CliError('--provider replay needs --from <run>');
  if (!ref && !fromDir) throw new CliError('run needs a world (a path or an example name) or --from <run>');

  const recordedMeta = fromDir ? readJsonFile(join(fromDir, 'meta.json'), 'run meta') : null;
  const world = ref ? readWorld(ref) : { file: join(fromDir, 'spec.json'), raw: readJsonFile(join(fromDir, 'spec.json'), 'recorded spec') };
  let spec = checkedSpec(world.raw, shortPath(world.file));
  let patchResult = null;
  if (flags.patch) {
    patchResult = applyPatch(spec, readPatch(flags.patch));
    spec = patchResult.spec;
  }
  const seed = intFlag(flags, 'seed', recordedMeta?.seed ?? 7);
  const seedCount = intFlag(flags, 'seeds', 1, 1);
  const provider = providerFor(providerName, flags, fromDir);
  const label = [flags.patch && `patch ${basename(flags.patch)}`, fromDir && `replay of ${basename(fromDir)}`].filter(Boolean).join(' · ') || null;
  const recorderFor = flags['no-record'] ? null : s => createRecorder({ root, spec, seed: s, providerName, label });
  const progress = progressPrinter();
  const simOpts = simOptsFrom(flags);
  const started = Date.now();

  if (seedCount === 1) {
    const res = await withAbort(progress, signal => runSwarm({
      spec, seed, provider, recorder: recorderFor?.(seed) ?? null, simOpts, onProgress: progress.onProgress, signal
    }));
    if (flags.json) {
      printJson({
        runId: res.runId, runDir: res.runDir, seed, provider: providerName, specHash: specHash(spec),
        patch: patchResult && { applied: patchResult.applied, skipped: patchResult.skipped },
        kpis: headlineKpis(res.metrics), decisions: res.metrics.decisions, providerStats: res.providerStats,
        fallbackRate: fallbackRate(res.metrics), warning: fallbackWarning(res.metrics)
      });
    } else {
      printSingleRun(spec, providerName, seed, res, (Date.now() - started) / 1000, patchResult);
    }
    return 0;
  }

  const res = await withAbort(progress, signal => runSeeds({
    spec, seeds: seedRange(seed, seedCount), provider, recorderFor, simOpts, onProgress: progress.onProgress, signal
  }));
  if (flags.json) {
    printJson({
      provider: providerName, specHash: specHash(spec),
      patch: patchResult && { applied: patchResult.applied, skipped: patchResult.skipped },
      runs: res.runs.map(r => ({
        seed: r.seed, runId: r.runId, runDir: r.runDir, kpis: r.kpis, providerStats: r.providerStats, fallbackRate: fallbackRate(r.metrics)
      })),
      summary: res.summary, providerStats: provider.stats()
    });
  } else {
    printSeedRuns(spec, providerName, res, (Date.now() - started) / 1000, patchResult, provider.stats());
  }
  return 0;
}

function formatDelta(k, d, base) {
  const sign = d > 0 ? '+' : d < 0 ? '-' : '';
  const abs = Math.abs(d);
  const amount = k === 'abandonRate' ? `${(abs * 100).toFixed(1)} pts` : formatKpi(k, abs);
  const rel = base ? ` (${sign}${fmtPct(abs / Math.abs(base), 0)})` : '';
  return `${sign}${amount}${rel}`;
}

async function cmdCompare([ref], flags) {
  if (!flags.patch) throw new CliError('compare needs --patch <file>');
  const providerName = flags.provider ?? 'rules';
  if (!['rules', 'jev'].includes(providerName)) throw new CliError('compare runs with --provider rules or --provider jev');
  const { file, raw } = readWorld(ref);
  const spec = checkedSpec(raw, shortPath(file));
  const patch = readPatch(flags.patch);
  const seeds = seedRange(intFlag(flags, 'seed', 7), intFlag(flags, 'seeds', DEFAULT_COMPARE_SEEDS, 1));
  const record = flags.record ? true : flags['no-record'] ? false : providerName === 'jev';
  const root = flags.out ?? 'runs';
  const recorderFor = record
    ? (s, side) => createRecorder({ root, spec, seed: s, providerName, label: `compare ${side}: ${basename(flags.patch)}` })
    : null;
  const provider = providerFor(providerName, flags);
  const progress = progressPrinter();
  const res = await withAbort(progress, signal => compareRuns({
    spec, patch, seeds, provider, recorderFor, simOpts: simOptsFrom(flags), onProgress: progress.onProgress, signal
  }));
  const providerStats = provider.stats();
  if (flags.json) {
    printJson({ ...res, seeds, provider: providerName, providerStats });
    return 0;
  }
  print(`${spec.title} · compare · ${providerName} · seeds ${seeds[0]}..${seeds.at(-1)}`);
  printPatch(res);
  if (!res.applied.length) print('  (no patch operation applied; before and after are the same world)');
  print();
  print(table(['KPI', 'before', 'after', 'change'], Object.keys(res.delta).map(k => {
    const b = res.before.kpis[k], a = res.after.kpis[k];
    return [KPI_LABELS[k], `${formatKpi(k, b.mean)} ± ${formatKpi(k, b.sd)}`, `${formatKpi(k, a.mean)} ± ${formatKpi(k, a.sd)}`, formatDelta(k, res.delta[k], b.mean)];
  })));
  print();
  print(`#1 bottleneck before: ${frequencyLine(res.before)}`);
  print(`#1 bottleneck after:  ${frequencyLine(res.after)}`);
  const after = new Map(res.after.places.map(p => [p.id, p.meanScore]));
  print('Mean bottleneck score, before → after:');
  print(table(['Place', 'before', 'after', 'change'], res.before.places.slice(0, 5).map(p => {
    const a = after.get(p.id) ?? 0;
    return [p.name, fmtInt(p.meanScore), fmtInt(a), formatDelta('score', a - p.meanScore, p.meanScore)];
  })));
  print();
  print(`Provider: ${providerStatsLine(providerStats, { decisions: mergeDecisions(res.before.decisions, res.after.decisions) })}`);
  for (const [side, summary] of [['before', res.before], ['after', res.after]]) {
    const warning = fallbackWarning({ decisions: summary.decisions });
    if (warning) print(`${side}: ${warning}`);
  }
  return 0;
}

function mergeDecisions(a, b) {
  const byProvider = { ...a.byProvider };
  for (const [k, n] of Object.entries(b.byProvider)) byProvider[k] = (byProvider[k] ?? 0) + n;
  return { total: a.total + b.total, byProvider };
}

function cmdReport([ref], flags) {
  const dir = resolveRunDir(ref, flags.out ?? 'runs');
  const markdown = reportMarkdown(dir);
  if (flags.json) printJson({ runDir: dir, markdown });
  else process.stdout.write(markdown);
  return 0;
}

function cmdAgent([ref, agentId], flags) {
  const dir = resolveRunDir(ref, flags.out ?? 'runs');
  if (!flags.json) {
    process.stdout.write(agentLog(dir, agentId));
    return 0;
  }
  const record = agentRecord(dir, agentId);
  if (!record) throw new CliError(`Agent ${agentId} is not in ${shortPath(dir)}`);
  printJson(record);
  return 0;
}

function cmdRuns(_args, flags) {
  const root = flags.out ?? 'runs';
  const metas = listRuns(root);
  if (flags.json) { printJson(metas); return 0; }
  if (!metas.length) { print(`No recorded runs in ${root}.`); return 0; }
  print(table(['run', 'created', 'provider', 'model', 'seed', 'agents', 'decisions', 'status'], metas.map(m => [
    m.runId, String(m.createdAt ?? '').replace('T', ' ').slice(0, 16), m.provider, m.model ?? '–', m.seed,
    fmtInt(m.agents), fmtInt(m.decisions), m.status
  ])));
  return 0;
}

async function cmdCompile(words, flags) {
  if (!hasKey('ANTHROPIC_API_KEY')) {
    process.stderr.write(COMPILE_WITHOUT_KEY + '\n');
    return 1;
  }
  const { compileWorld } = await import('../compile/compile.js');
  const { spec, attempts, warnings } = await compileWorld(words.join(' '), { apiKey: process.env.ANTHROPIC_API_KEY });
  const out = resolve(flags.out ?? join('worlds', `${slug(spec.title, 0).replace(/_/g, '-')}.json`));
  if (existsSync(out) && !flags.force) throw new CliError(`${shortPath(out)} already exists; pass --force to overwrite or --out to choose another file`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(spec, null, 2) + '\n');
  if (flags.json) {
    printJson({ file: out, attempts, warnings });
    return 0;
  }
  print(`Wrote ${shortPath(out)} (${attempts} attempt(s), ${warnings.length} warning(s))`);
  for (const w of warnings) print(`  - ${w}`);
  print(`Next: swarm validate ${shortPath(out)}  then  swarm estimate ${shortPath(out)}`);
  return 0;
}

async function cmdBuildingLazy(args, flags) {
  let mod;
  try { mod = await import('../builder/building-cli.js'); } catch (err) { throw missingModule('builder/building-cli.js', err); }
  return mod.cmdBuilding(args, flags);
}

async function cmdFitoutLazy(args, flags) {
  let mod;
  try { mod = await import('../builder/fitout-cli.js'); } catch (err) { throw missingModule('builder/fitout-cli.js', err); }
  return mod.cmdFitout(args, flags);
}

async function cmdImportLazy(fn, args, flags) {
  let mod;
  try { mod = await import('../builder/cli.js'); } catch (err) { throw missingModule('builder/cli.js', err); }
  if (typeof mod[fn] !== 'function') throw new CliError(`builder/cli.js does not export ${fn} yet.`);
  return mod[fn](args, flags);
}

function missingModule(file, err) {
  if (err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(file)) {
    return new CliError(`${file} is not available yet (still being written). Try again once the walls track has landed.`);
  }
  return err;
}

async function cmdServe(_args, flags) {
  const port = intFlag(flags, 'port', 4173, 0);
  const { startServer } = await import('../server/server.js');
  const server = await startServer({ port, root: process.cwd() });
  print(`Swarmscope viewer at ${server?.url ?? `http://127.0.0.1:${port}`}  (Ctrl-C to stop)`);
  return null;
}

function cmdSanity(_args, flags) {
  const script = join(REPO, 'validation', 'jev-sanity.js');
  if (!existsSync(script)) throw new CliError('validation/jev-sanity.js is missing');
  if (!hasKey('TYPESAFE_API_KEY')) throw new CliError('swarm sanity makes live Jev calls and needs TYPESAFE_API_KEY in .env.local');
  const args = flags.model ? [script, '--model', flags.model] : [script];
  const child = spawnSync(process.execPath, args, { stdio: 'inherit' });
  return child.status ?? 1;
}

// ---------- main ----------
async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const [name, ...args] = positional;
  if (!name || flags.help) {
    print(USAGE);
    return name || flags.help ? 0 : 1;
  }
  const command = COMMANDS[name];
  if (!command) throw new CliError(`Unknown command "${name}". Run swarm --help for the list.`);
  const allowed = new Set([...command.flags, 'help']);
  const unknown = Object.keys(flags).filter(f => !allowed.has(f));
  if (unknown.length) throw new CliError(`swarm ${name} does not take ${unknown.map(f => `--${f}`).join(', ')}`);
  if (args.length < command.min || args.length > command.max) {
    throw new CliError(`swarm ${name}: wrong number of arguments. Run swarm --help for usage.`);
  }
  return command.run(args, flags);
}

main(process.argv.slice(2)).then(
  code => { if (code != null) process.exitCode = code; },
  err => {
    if (isJevAuthError(err)) {
      process.stderr.write('swarm: Jev rejected the API key (HTTP 401). Check TYPESAFE_API_KEY in .env.local.\n');
    } else if (err?.name === 'AbortError') {
      process.stderr.write('swarm: stopped. A run being recorded is kept with status "error".\n');
      process.exitCode = 130;
      return;
    } else {
      process.stderr.write(`swarm: ${err?.message ?? err}\n`);
      if (process.env.SWARM_DEBUG && !(err instanceof CliError)) process.stderr.write(`${err?.stack ?? ''}\n`);
    }
    process.exitCode = 1;
  }
);
