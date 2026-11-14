// `swarm fitout` (docs/PROTOTYPE.md §14f): a fit-out file + a real Matterport floor plan → a walled, doored
// visit-mode world. Real-building worlds contain the floor plan, so they go under data/worlds/ by default.
//
//   swarm fitout <fitout.json> [--plan-raw data/<id>.json | --model <id>] [--floor N] [--margin 8] [--out data/worlds/<slug>.json]
//                [--mesh <file.obj> | --mesh auto] [--floor-height H]
//
// --mesh adds the solid objects the model's 3D mesh shows at walking height (builder/objects.js, §13f): a saved OBJ
// file, or `auto` to download the model's OBJ from Matterport (same keys as --model). --floor-height sets the
// floor's height in the mesh when the floors cannot be told apart.
//
// The floor plan comes from --plan-raw (a saved model dump, no API call), from --model (a live Matterport
// fetch with MATTERPORT_API_KEY and MATTERPORT_API_TOKEN), or, with neither, from data/<model>.json.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, sep, join, basename, extname } from 'node:path';
import { loadEnv } from '../engine/env.js';
import { validateWorld } from '../engine/spec.js';

class FitoutError extends Error {}

const MODEL_ID = /^[A-Za-z0-9]{6,32}$/;

async function defaultModules() {
  const [matterport, fitout] = await Promise.all([import('./matterport.js'), import('./fitout.js')]);
  return { matterport, fitout };
}

function readJson(file, what) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new FitoutError(`Could not read ${what} ${file}: ${err.message}`);
  }
}

const shown = (file, cwd) => {
  const rel = relative(cwd, file);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : file;
};

const underData = (file, cwd) => {
  const rel = relative(join(cwd, 'data'), file);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..');
};

function parseFloor(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number') return v;
  return /^\d+$/.test(String(v).trim()) ? Number(v) : String(v);
}

async function loadRawPlan(flags, fitout, mods, cwd, env) {
  if (flags['plan-raw']) {
    const file = resolve(cwd, flags['plan-raw']);
    return { raw: readJson(file, 'floor plan'), source: shown(file, cwd) };
  }
  if (flags.model) {
    const modelId = String(flags.model).trim();
    if (!MODEL_ID.test(modelId)) throw new FitoutError(`"${modelId}" does not look like a Matterport model id.`);
    const tokenId = env.MATTERPORT_API_KEY?.trim();
    const tokenSecret = env.MATTERPORT_API_TOKEN?.trim();
    if (!tokenId || !tokenSecret) {
      const missing = ['MATTERPORT_API_KEY', 'MATTERPORT_API_TOKEN'].filter(k => !env[k]?.trim());
      throw new FitoutError(
        `--model fetches the floor plan from Matterport and needs both MATTERPORT_API_KEY (token ID) and MATTERPORT_API_TOKEN (token secret) in .env.local (missing: ${missing.join(', ')}).\n` +
        `Or save the model's raw JSON as data/${modelId}.json and pass --plan-raw data/${modelId}.json (no API call).`
      );
    }
    const raw = await mods.matterport.fetchModelGeometry({ modelId, tokenId, tokenSecret });
    return { raw, source: `Matterport model ${modelId} (fetched)` };
  }
  const modelId = typeof fitout.model === 'string' ? fitout.model.trim() : '';
  if (!modelId) throw new FitoutError('The fit-out names no "model", so there is no default floor plan; pass --plan-raw <file.json> or --model <id>.');
  if (!MODEL_ID.test(modelId)) throw new FitoutError(`The fit-out's model "${modelId}" does not look like a Matterport model id; pass --plan-raw <file.json>.`);
  const file = resolve(cwd, 'data', `${modelId}.json`);
  if (!existsSync(file)) {
    throw new FitoutError(`No floor plan given and ${shown(file, cwd)} does not exist.\n` +
      `Pass --plan-raw <saved model JSON> or --model ${modelId} (needs MATTERPORT_API_KEY and MATTERPORT_API_TOKEN).`);
  }
  return { raw: readJson(file, 'floor plan'), source: shown(file, cwd) };
}

// Solid objects from the mesh: a saved OBJ, or the model's OBJ fetched from Matterport.
async function findObjects(flags, fitout, plan, mods, cwd, env) {
  const objects = mods.objects ?? await import('./objects.js');
  let bytes, source;
  if (flags.mesh === true || flags.mesh === '') throw new FitoutError('--mesh needs an OBJ file or "auto".');
  if (String(flags.mesh).trim().toLowerCase() === 'auto') {
    const modelId = String(flags.model ?? fitout.model ?? '').trim();
    if (!MODEL_ID.test(modelId)) throw new FitoutError('--mesh auto needs a Matterport model id (--model, or "model" in the fit-out).');
    const tokenId = env.MATTERPORT_API_KEY?.trim(), tokenSecret = env.MATTERPORT_API_TOKEN?.trim();
    if (!tokenId || !tokenSecret) throw new FitoutError('--mesh auto downloads the mesh from Matterport and needs MATTERPORT_API_KEY and MATTERPORT_API_TOKEN in .env.local; or pass --mesh <saved file.obj>.');
    const mesh = mods.mesh ?? await import('./mesh.js');
    try {
      ({ obj: bytes } = await mesh.fetchMeshObj({ modelId, tokenId, tokenSecret }));
    } catch (e) {
      throw new FitoutError(`Could not download the mesh of ${modelId}: ${e.message}`);
    }
    source = `the ${modelId} mesh (fetched)`;
  } else {
    const file = resolve(cwd, String(flags.mesh));
    try { bytes = readFileSync(file); } catch (e) { throw new FitoutError(`Could not read the mesh ${shown(file, cwd)}: ${e.message}`); }
    source = shown(file, cwd);
  }
  let floorHeight;
  if (flags['floor-height'] !== undefined) {
    floorHeight = Number(flags['floor-height']);
    if (!Number.isFinite(floorHeight)) throw new FitoutError('--floor-height must be a number (the floor\'s height in the mesh, in meters).');
  }
  let found;
  try {
    found = objects.meshObjects(bytes, plan, floorHeight === undefined ? {} : { floorHeight });
  } catch (e) {
    throw new FitoutError(`Could not find objects in ${source}: ${e.message}`);
  }
  if (found.floorHeight === null) throw new FitoutError(`Could not find objects in ${source}: ${found.warnings.join('; ')}`);
  return { ...found, source };
}

function defaultOut(fitoutFile, fitout, cwd) {
  const stem = basename(fitoutFile, extname(fitoutFile)).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'fitout';
  const model = typeof fitout.model === 'string' && MODEL_ID.test(fitout.model.trim()) ? fitout.model.trim() : '';
  const name = model && !stem.includes(model.toLowerCase()) ? `${model}-${stem}` : stem;
  return resolve(cwd, 'data', 'worlds', `${name}.json`);
}

function printReport(report, { fitoutFile, planSource, outFile, check }, say) {
  const floor = report.floor ? `${report.floor.label || `sequence ${report.floor.sequence}`}` : 'floor ?';
  say(`Fit-out: ${fitoutFile} · model ${report.model ?? '?'} · ${floor}`);
  say(`Floor plan: ${planSource}${report.planWarnings?.length ? ` · ${report.planWarnings.length} floor plan warning(s)` : ''}`);
  say(`World: ${report.gates} gates · ${report.places} places · ${report.walls} walls · ${report.doors} doors`);
  say(`Scale: ${report.metersPerUnit} m per map unit · walking ${report.walkMetersPerMinute} m/min = travelSpeed ${report.travelSpeed} units/min · ` +
    `path clearance ${report.clearance} units (${+(report.clearance * report.metersPerUnit).toFixed(2)} m)`);
  if (report.entries?.length) say(`Entry-only gates (exit: false): ${report.entries.join(', ')}`);
  if (report.meshObjects) {
    const m = report.meshObjects, total = m.objects.reduce((s, o) => s + (o.areaM2 || 0), 0);
    say(`Objects: ${m.objects.length} from ${m.source} (floor at ${m.floorHeight.toFixed(2)} m, cut ${0.3}-${1.5} m above it), ${+total.toFixed(1)} m² in all; ` +
      `${m.dropped.specks} specks under 0.03 m² left out as scan noise`);
    for (const o of m.objects.slice(0, 12)) say(`  ${o.id.padEnd(6)} ${String(o.areaM2).padStart(6)} m²  ${o.name}`);
    if (m.objects.length > 12) say(`  ... and ${m.objects.length - 12} smaller`);
    for (const w of m.warnings) say(`  objects warning: ${w}`);
  }
  say('Doors:');
  for (const d of report.doorList ?? []) say(`  ${d.id.padEnd(8)} ${d.exterior ? 'exterior' : 'interior'}  ${String(d.widthM).padStart(5)} m  ${d.name}`);
  for (const w of report.planWarnings ?? []) say(`floor plan warning: ${w}`);
  say(`Fit-out warnings: ${report.warnings?.length || 'none'}`);
  for (const w of report.warnings ?? []) say(`  - ${w}`);
  if (report.assumptions?.length) {
    say(`Assumptions in the fit-out: ${report.assumptions.length}`);
    for (const a of report.assumptions) say(`  - ${a.key} = ${JSON.stringify(a.value)}`);
  }
  say(`Validation: ${check.ok ? 'OK' : 'INVALID'} · ${check.errors.length} error(s) · ${check.warnings.length} warning(s)`);
  for (const w of check.warnings) say(`  - ${w}`);
  say(`Wrote ${outFile}`);
  say(`Next: node bin/swarm.js run ${outFile} --provider jev`);
}

// Returns an exit code. `modules`, `cwd`, `out`, `err` and `env` exist for tests.
export async function cmdFitout(positional, flags = {}, {
  modules, cwd = process.cwd(), out = s => process.stdout.write(s + '\n'), err = s => process.stderr.write(s + '\n'), env
} = {}) {
  try {
    const [fitoutArg, ...extra] = Array.isArray(positional) ? positional : [];
    if (!fitoutArg) throw new FitoutError('fitout needs a fit-out file: swarm fitout <fitout.json> [--plan-raw data/<id>.json | --model <id>]');
    if (extra.length) throw new FitoutError(`fitout takes one fit-out file; got ${positional.length}.`);
    if (flags.model && flags['plan-raw']) throw new FitoutError('Use either --model or --plan-raw, not both.');
    let margin = 8;
    if (flags.margin !== undefined) {
      margin = Number(flags.margin);
      if (!Number.isFinite(margin) || margin < 0 || margin > 45) throw new FitoutError('--margin must be a number of map units from 0 to 45 (default 8).');
    }

    if (!env) loadEnv({ cwd });
    const theEnv = env ?? process.env;
    const mods = modules ?? await defaultModules();

    const fitoutPath = resolve(cwd, fitoutArg);
    const fitout = readJson(fitoutPath, 'fit-out');
    if (!fitout || typeof fitout !== 'object' || Array.isArray(fitout)) throw new FitoutError(`${fitoutArg} is not a fit-out object (docs/PROTOTYPE.md §14f).`);

    const { raw, source } = await loadRawPlan(flags, fitout, mods, cwd, theEnv);
    const floor = parseFloor(flags.floor ?? fitout.floor);
    let plan;
    try {
      plan = mods.matterport.extractFloorplan(raw, { floor });
    } catch (e) {
      throw new FitoutError(`Could not read floor ${floor ?? '(default)'} of ${source}: ${e.message}`);
    }

    let objectsFound = null;
    if (flags.mesh !== undefined) {
      objectsFound = await findObjects(flags, fitout, plan, mods, cwd, theEnv);
      plan = { ...plan, objects: objectsFound.objects };
    }

    let result;
    try {
      result = mods.fitout.applyFitout(plan, fitout, { margin });
    } catch (e) {
      throw new FitoutError(String(e.message).replace(/^applyFitout: /, ''));
    }
    const { world, report } = result;
    if (objectsFound) Object.assign(report, { meshObjects: objectsFound });

    const outPath = flags.out ? resolve(cwd, flags.out) : defaultOut(fitoutPath, fitout, cwd);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(world, null, 2) + '\n');
    const check = validateWorld(JSON.parse(readFileSync(outPath, 'utf8')));
    if (!underData(outPath, cwd)) err(`note: ${shown(outPath, cwd)} holds the real floor plan; keep it out of git (data/ is gitignored).`);

    printReport(report, { fitoutFile: shown(fitoutPath, cwd), planSource: source, outFile: shown(outPath, cwd), check }, out);
    if (!check.ok) {
      err(`swarm fitout: the written world does not validate:\n${check.errors.map(e => `  - ${e}`).join('\n')}`);
      return 1;
    }
    return 0;
  } catch (e) {
    err(`swarm fitout: ${e instanceof FitoutError ? e.message : (process.env.SWARM_DEBUG ? e.stack : e.message)}`);
    return 1;
  }
}
