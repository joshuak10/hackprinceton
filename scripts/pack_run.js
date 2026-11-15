#!/usr/bin/env node
// Pack one recorded run folder into a single file the scope display can open without the engine server
// (docs/PROTOTYPE.md §18).
//
//   node scripts/pack_run.js <run folder> <out file>
//   node scripts/pack_run.js runs/friday_dinner_...-jev-s7-... web/scope/mock/sushi-restaurant.json
//
// The file holds what GET /api/runs/<id>/<part> serves, part by part: meta, spec, frames, metrics, agents,
// remarks and decisions (decisions.jsonl as one array). Only pack runs of fictional or published places:
// the result is meant to be committed.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function packRun(runDir) {
  const json = name => JSON.parse(readFileSync(join(runDir, `${name}.json`), 'utf8'));
  const out = {};
  for (const part of ['meta', 'spec', 'frames', 'metrics', 'agents', 'remarks']) out[part] = json(part);
  const lines = existsSync(join(runDir, 'decisions.jsonl')) ? readFileSync(join(runDir, 'decisions.jsonl'), 'utf8').split('\n') : [];
  out.decisions = lines.filter(line => line.trim()).map(line => JSON.parse(line));
  if (existsSync(join(runDir, 'incidents.json'))) out.incidents = json('incidents');
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [runDir, outFile] = process.argv.slice(2);
  if (!runDir || !outFile) {
    console.error('Usage: node scripts/pack_run.js <run folder> <out file>');
    process.exit(1);
  }
  const run = packRun(runDir);
  const text = JSON.stringify(run);
  writeFileSync(outFile, text);
  console.log(`${outFile}: ${(text.length / 1e6).toFixed(2)} MB, ${run.agents.length} agents, ${run.decisions.length} decisions, provider ${run.meta.provider}, spec ${run.meta.specHash}`);
}
