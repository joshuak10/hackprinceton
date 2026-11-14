#!/usr/bin/env node
// Write mock runs for the scope display (docs/PROTOTYPE.md §9b).
//
//   node scripts/mock_runs.js [--seed 7]
//
// Always writes the synthetic runs (committed): web/scope/mock/{building,parking}-synthetic.json + index.json.
// The sushi restaurant is not generated here. Its file is a recorded engine run, packed with scripts/pack_run.js
// (docs/PROTOTYPE.md §18); this script only lists it in index.json when the file is there.
// If real Matterport geometry was extracted (scripts/extract_building.js), also writes a building run on it
// to web/scope/data/ (gitignored), and web/scope/data/index.json, which the display prefers.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { syntheticBuilding, syntheticLot } from '../mockgen/synthetic.js';
import { runBuilding } from '../mockgen/building.js';
import { runParking } from '../mockgen/parking.js';

const args = process.argv.slice(2);
const seedArg = args.indexOf('--seed');
const seed = seedArg >= 0 ? Number(args[seedArg + 1]) : 7;

const WEB = join('web', 'scope');
const MOCK = join(WEB, 'mock');
const DATA = join(WEB, 'data');
mkdirSync(MOCK, { recursive: true });

const hash = obj => createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 12);

function write(dir, name, run) {
  const text = JSON.stringify(run);
  writeFileSync(join(dir, name), text);
  const m = run.metrics;
  console.log(`${join(dir, name)}: ${(text.length / 1e6).toFixed(2)} MB, ${run.agents.length} agents, ${run.decisions.length} decisions, ` +
    `abandon rate ${(m.abandonRate * 100).toFixed(0)}%, top bottleneck ${m.bottlenecks[0]?.name}, hash ${hash(run)}`);
}

const CASES = {
  building: {
    label: 'Building congestion',
    question: 'Where do people get stuck moving through this building at lunchtime, and which change helps most?'
  },
  parking: {
    label: 'Retail parking lot',
    question: 'Where does this center lose shoppers on a busy Saturday, and what is the cheapest fix?'
  }
};

const building = runBuilding(syntheticBuilding(), { seed });
write(MOCK, 'building-synthetic.json', building);
const parking = runParking(syntheticLot(), { seed });
write(MOCK, 'parking-synthetic.json', parking);
const SUSHI = join(MOCK, 'sushi-restaurant.json');
const sushiMeta = existsSync(SUSHI) ? JSON.parse(readFileSync(SUSHI, 'utf8')).meta : null;
writeFileSync(join(MOCK, 'index.json'), JSON.stringify({
  cases: {
    building: { ...CASES.building, file: 'mock/building-synthetic.json', place: 'Synthetic office and retail building', source: 'synthetic' },
    parking: { ...CASES.parking, file: 'mock/parking-synthetic.json', place: 'Synthetic retail center', source: 'synthetic' },
    ...(sushiMeta ? { sushi: { label: 'Sushi restaurant', question: sushiMeta.question, file: 'mock/sushi-restaurant.json', place: 'Sushi restaurant', source: 'drawn', runTitle: sushiMeta.title, suggestion: 'promotion' } } : {})
  }
}, null, 2) + '\n');

// Real geometry, if extracted.
if (existsSync(DATA)) {
  const geos = readdirSync(DATA).filter(f => /^building-.+\.geometry\.json$/.test(f));
  if (geos.length) {
    const file = geos[0];
    const modelId = file.replace(/^building-/, '').replace(/\.geometry\.json$/, '');
    const geometry = JSON.parse(readFileSync(join(DATA, file), 'utf8'));
    const run = runBuilding(geometry, { seed });
    write(DATA, `mock-building-${modelId}.json`, run);
    writeFileSync(join(DATA, 'index.json'), JSON.stringify({
      cases: {
        building: { ...CASES.building, file: `data/mock-building-${modelId}.json`, place: geometry.source?.name?.trim() || modelId, source: 'matterport', modelId }
      }
    }, null, 2) + '\n');
    console.log(`Display will use the Matterport building (${modelId}) and the synthetic lot.`);
  }
}
