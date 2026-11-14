#!/usr/bin/env node
// Pull a Matterport model's floor plan, scan points and mesh, and turn them into the scope display's
// geometry file (docs/PROTOTYPE.md §9b).
//
//   node scripts/extract_building.js 6FNMVoyPrL1 [--refresh]
//
// Raw downloads go to data/matterport/<id>/ and outputs to web/scope/data/. Hand-placed points of interest
// come from mockgen/pois/building-<id>.json. Both folders are gitignored:
// the spec forbids committing raw hackathon data. Keys come from .env.local (never printed).
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, hasKey } from '../engine/env.js';

const ENDPOINT = 'https://api.matterport.com/api/models/graph';
const QUERY = `query($id: ID!) { model(id: $id) {
  id name
  floors { id sequence label
    vertices { id position { x y } }
    edges { id type thickness vertices { id } openings { id type width height relativeCenter lowerElevation } } }
  rooms { id label tags keywords floor { id } classifications { label confidence }
    dimensionEstimates(units: metric) { area }
    boundary { edges { id vertices { id } } } holes { edges { id vertices { id } } } }
  locations { id floor { id } room { id } position { x y z } }
  assets { meshes { format resolution filename url validUntil status } }
} }`;

async function gql(auth, query, variables) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) throw new Error(`Matterport API answered ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error('Matterport API error: ' + body.errors.map(e => e.message).join('; '));
  return body.data;
}

async function main() {
  const args = process.argv.slice(2);
  const modelId = args.find(a => !a.startsWith('--'));
  const refresh = args.includes('--refresh');
  if (!modelId || !/^[A-Za-z0-9]{6,20}$/.test(modelId)) {
    console.error('Usage: node scripts/extract_building.js <modelId> [--refresh]');
    process.exit(1);
  }
  loadEnv();
  if (!hasKey('MATTERPORT_API_KEY') || !hasKey('MATTERPORT_API_TOKEN')) {
    console.error('Set MATTERPORT_API_KEY (token ID) and MATTERPORT_API_TOKEN (token secret) in .env.local.');
    process.exit(1);
  }
  const auth = Buffer.from(`${process.env.MATTERPORT_API_KEY}:${process.env.MATTERPORT_API_TOKEN}`).toString('base64');

  const rawDir = join('data', 'matterport', modelId);
  const outDir = join('web', 'scope', 'data');
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const modelFile = join(rawDir, 'model.json');
  let model;
  if (!refresh && existsSync(modelFile)) {
    model = JSON.parse(readFileSync(modelFile, 'utf8'));
  } else {
    model = (await gql(auth, QUERY, { id: modelId })).model;
    if (!model) throw new Error(`Model ${modelId} not found or not accessible with this token.`);
    writeFileSync(modelFile, JSON.stringify(model));
  }
  console.log(`${model.name}: ${model.floors.length} floors, ${model.rooms.length} rooms, ${model.locations?.length ?? 0} scan points`);

  // Mesh: the 50k OBJ is enough to find shelves, counters and walls at walking height.
  const meshFile = join(rawDir, 'mesh-50k.obj');
  if (refresh || !existsSync(meshFile)) {
    const mesh = (model.assets?.meshes || []).find(m => m.format === 'obj' && m.resolution === '50k')
      || (model.assets?.meshes || []).find(m => m.format === 'obj');
    if (!mesh?.url) {
      console.warn('No OBJ mesh available; obstacles will come from room holes only.');
    } else {
      // Signed URLs expire, so always ask for a fresh one before downloading.
      const fresh = (await gql(auth, `query($id: ID!) { model(id: $id) { assets { meshes { format resolution url } } } }`, { id: modelId }))
        .model.assets.meshes.find(m => m.format === mesh.format && m.resolution === mesh.resolution);
      const res = await fetch(fresh.url);
      if (!res.ok) throw new Error(`Mesh download answered ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(meshFile, buf);
      console.log(`Downloaded mesh (${(buf.length / 1e6).toFixed(1)} MB) to ${meshFile}`);
    }
  }

  if (args.includes('--fetch-only')) return;

  const { normalizeMatterport } = await import('../geometry/matterport.js');
  const { parseObj, detectUpAxis, sliceToGrid, encodeGrid } = await import('../geometry/obj-slice.js');
  const geometry = normalizeMatterport(model);
  if (existsSync(meshFile)) {
    const mesh = parseObj(readFileSync(meshFile, 'utf8'));
    const up = detectUpAxis(mesh, model);
    console.log(`Mesh: ${mesh.vertices.length / 3} vertices, ${mesh.faces.length / 3} triangles, up axis ${up.axis} (${up.reason})`);
    for (const floor of geometry.floors) {
      const grid = sliceToGrid(mesh, {
        up, floorZ: floor.elevation, zMin: 0.3, zMax: 1.5, cell: 0.25,
        boundsMeters: floor.metersBounds
      });
      floor.obstacles = encodeGrid(grid, floor.transform);
      const blocked = grid.data.reduce((a, b) => a + b, 0);
      console.log(`  ${floor.label}: floor at ${floor.elevation.toFixed(2)} m, ${blocked} of ${grid.w * grid.h} cells blocked by mesh`);
    }
    geometry.provenance.obstacles = 'data (mesh sliced at 0.3-1.5 m)';
  }

  // Classify openings (exterior, interior, or leading nowhere) from which sides are inside the building.
  const { buildWalkGrid } = await import('../geometry/walkgrid.js');
  geometry.floors.forEach((floor, fi) => {
    const seeds = geometry.sweeps.filter(s => s.floor === fi).map(s => [s.x, s.y]);
    const grid = buildWalkGrid(floor, { metersPerUnit: geometry.metersPerUnit, seeds });
    floor.openings = grid.openings;
    const free = grid.free.reduce((a, b) => a + b, 0);
    console.log(`  ${floor.label}: ${free} walkable cells of ${grid.w * grid.h} (0.5 m cells)`);
  });

  // Points of interest are hand-placed assumptions, committed in mockgen/pois/ (they are ours, not scan data).
  const poisFile = join('mockgen', 'pois', `building-${modelId}.json`);
  if (existsSync(poisFile)) {
    const pois = JSON.parse(readFileSync(poisFile, 'utf8'));
    for (const floor of geometry.floors) {
      floor.pois = (pois[String(floor.sequence)] || []).map(p => ({ ...p, provenance: 'assumed' }));
    }
    geometry.links = pois.links || [];
    geometry.provenance.pois = 'assumed (placed by hand)';
  } else {
    console.warn(`No points of interest at ${poisFile}; the mock needs them to run this building.`);
  }

  const geoFile = join(outDir, `building-${modelId}.geometry.json`);
  writeFileSync(geoFile, JSON.stringify(geometry));
  for (const f of geometry.floors) {
    const ext = f.openings.filter(o => o.exterior).length;
    console.log(`  ${f.label}: ${f.rooms.length} rooms, ${f.walls.length} walls, ${f.openings.length} openings (${ext} exterior), ${f.pois?.length || 0} points of interest`);
  }
  console.log(`Wrote ${geoFile} (metersPerUnit ${geometry.metersPerUnit.toFixed(3)})`);

  // The SDK key is public and domain-locked by design (docs/PROTOTYPE.md §9b). No other key is written.
  const config = { modelId, matterportSdkKey: process.env.MATTERPORT_SDK_KEY || null };
  writeFileSync(join(outDir, 'config.json'), JSON.stringify(config));
}

main().catch(err => { console.error(err.message); process.exit(1); });
