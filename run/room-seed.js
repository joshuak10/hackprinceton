// Rebuilds web/room/seed-record.json: the recorded Jev answers the Ask-the-room page ships with, so the page
// works with no key and no network (docs/PROTOTYPE.md §17).
//
//   node run/room-seed.js            ask Jev whatever is not on record yet, then write the seed
//   node run/room-seed.js --check    ask nothing; say how many answers are missing
//
// It asks every scenario below through askRoom, the same code the page's route uses, and keeps exactly the
// answers those scenarios need. Answers already in the old seed or in data/room/record.json are reused, so a
// second run costs nothing. Run it again after the cafe world, the cast or the engine's wording changes.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnv, hasKey } from '../engine/env.js';
import { normalizeSpec } from '../engine/spec.js';
import { buildJevRequest } from '../providers/jev.js';
import { makeProvider } from '../providers/index.js';
import { askRoom, recordProvider, defaultScenario } from './room.js';
import { FEELINGS, withFeeling } from '../web/room/feelings.js';

const here = rel => fileURLToPath(new URL(rel, import.meta.url));
const WORLD = here('../worlds/alder-pine-cafe.json');
const SEED = here('../web/room/seed-record.json');
const LOCAL = here('../data/room/record.json');
const APP = here('../web/room/app.js');

// The preset signs are read from the page, so the two cannot drift apart.
export function presetSigns(appSource = readFileSync(APP, 'utf8')) {
  const block = appSource.match(/const PRESETS = \[([\s\S]*?)\];/);
  return block ? [...block[1].matchAll(/'((?:[^'\\]|\\.)+)'/g)].map(m => m[1]) : [];
}

// Every moment the page can reach without typing, plus the typed lines of the demo script.
export function seedScenarios(rawSpec, presets = presetSigns()) {
  const spec = normalizeSpec(rawSpec), base = defaultScenario(spec), list = [{}];
  for (let price = 1; price <= 10; price++) {
    if (price === Math.round(base.price)) continue;
    list.push({ scenario: { price } }, { scenario: { price, priorPrice: base.price } });
  }
  for (const id of Object.keys(base.ahead)) {
    for (let n = 0; n <= 20; n++) if (n !== base.ahead[id]) list.push({ scenario: { ahead: { ...base.ahead, [id]: n } } });
  }
  const raised = [{ price: base.price + 1, priorPrice: base.price }, { price: base.price + 2, priorPrice: base.price }];
  for (const sign of [...presets, 'No laptops before 9 am.']) {
    list.push({ scenario: { sign } });
    for (const moment of raised) list.push({ scenario: { ...moment, sign } });
  }
  const tomas = spec.minds.find(m => m.id === 'tomas');
  if (tomas) list.push({ scenario: raised[1], edits: { tomas: { bio: `${tomas.bio} Today is his birthday and he promised himself one good thing.` } } });
  // Every one-click feeling for every cast member: at the opening moment, with a long line at the shop, and at a
  // higher price. A feeling decides most when there is something to weigh.
  const shopName = spec.nodes.find(n => n.id === base.shop)?.name;
  const strained = [{}, { ahead: { ...base.ahead, [base.shop]: 10 } }, raised[1]];
  for (const scenario of strained) {
    for (const m of spec.minds) for (const f of FEELINGS) list.push({ scenario, edits: { [m.id]: { bio: withFeeling(m.bio, m.name, f, shopName) } }, only: [m.id] });
  }
  return list;
}

function readRecord(file) {
  try { return Object.entries(JSON.parse(readFileSync(file, 'utf8'))).filter(([, v]) => v && v.answers); } catch { return []; }
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  loadEnv();
  const raw = JSON.parse(readFileSync(WORLD, 'utf8'));
  const record = new Map([...readRecord(SEED), ...readRecord(LOCAL)]);
  const live = !checkOnly && hasKey('TYPESAFE_API_KEY');
  const inner = live ? makeProvider('jev', { shuffle: false, cache: record, concurrency: 16, maxRequests: 4000 }) : recordProvider(record);
  const needed = new Set();
  const provider = {
    name: 'seed', external: true,
    async decideMany(requests, ctx = {}) {
      for (const req of requests) needed.add(buildJevRequest(req, { model: 'jev-latest', spec: ctx?.spec ?? null, shuffle: false }).requestHash);
      return inner.decideMany(requests, ctx);
    }
  };
  const scenarios = seedScenarios(raw);
  let failed = 0, asked = 0;
  for (const { scenario = {}, edits = {}, only = null } of scenarios) {
    const out = await askRoom({ spec: raw, scenario, edits, only, provider });
    failed += out.failed;
    asked += out.askedLive;
  }
  const missing = [...needed].filter(h => !record.has(h)).length;
  console.log(`${scenarios.length} scenarios need ${needed.size} answers; ${asked} asked just now, ${missing} missing.`);
  if (live) {
    const s = inner.stats();
    console.log(`Jev: ${s.requests} requests, ${s.inputTokens} input tokens, about $${s.estCostUSD.toFixed(4)}${s.firstError ? `; first error: ${s.firstError}` : ''}`);
  }
  if (checkOnly) { process.exitCode = missing ? 1 : 0; return; }
  if (missing || failed) {
    console.error(`Not writing the seed: ${missing} answers are missing${live ? '' : ' and TYPESAFE_API_KEY is not set'}.`);
    process.exitCode = 1;
    return;
  }
  const out = {};
  for (const hash of [...needed].sort()) out[hash] = { answers: record.get(hash).answers, model: record.get(hash).model };
  writeFileSync(SEED, JSON.stringify(out));
  console.log(`Wrote ${needed.size} answers to web/room/seed-record.json.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(err => { console.error(err.message); process.exitCode = 1; });
