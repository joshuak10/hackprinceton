// `swarm building` (docs/PROTOTYPE.md §14e): Matterport floor plan + CoStar profile → a walled, doored world.
// The builder modules are imported lazily so the rest of the CLI works while they are being written.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, sep, join } from 'node:path';
import { loadEnv } from '../engine/env.js';
import { slug } from '../engine/util.js';
import { validateWorld } from '../engine/spec.js';

const DEFAULT_SCENARIO = 'weekday-lunch';

class BuildingError extends Error {}

async function defaultModules() {
  const load = async file => {
    try { return await import(file); } catch (err) {
      if (err?.code === 'ERR_MODULE_NOT_FOUND') throw new BuildingError(`${file.replace('./', 'builder/')} is not available yet (still being written).`);
      throw err;
    }
  };
  const [matterport, profile, compose] = await Promise.all([load('./matterport.js'), load('./profile.js'), load('./compose.js')]);
  return { matterport, profile, compose };
}

function readJson(file, what) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new BuildingError(`Could not read ${what} ${file}: ${err.message}`);
  }
}

// Raw model dumps are hackathon data: they may only be saved under data/ (gitignored).
function checkedSavePath(file, cwd) {
  const full = resolve(cwd, file);
  const rel = relative(join(cwd, 'data'), full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new BuildingError(`--save-raw only writes under data/ (it is gitignored); "${file}" is outside it.`);
  }
  return full;
}

async function loadRawPlan(flags, mods, cwd, env) {
  if (flags['plan-raw']) return readJson(resolve(cwd, flags['plan-raw']), 'floor plan');
  const modelId = String(flags.model);
  if (!/^[A-Za-z0-9]{6,32}$/.test(modelId)) throw new BuildingError(`"${modelId}" does not look like a Matterport model id.`);
  const tokenId = env.MATTERPORT_API_KEY?.trim();
  const tokenSecret = env.MATTERPORT_API_TOKEN?.trim();
  if (!tokenId || !tokenSecret) {
    const missing = ['MATTERPORT_API_KEY', 'MATTERPORT_API_TOKEN'].filter(k => !env[k]?.trim());
    throw new BuildingError(
      `Fetching a model needs both MATTERPORT_API_KEY and MATTERPORT_API_TOKEN in .env.local (missing: ${missing.join(', ')}).\n` +
      'Or save the model JSON under data/ and pass --plan-raw <file.json> (no API call).'
    );
  }
  const raw = await mods.matterport.fetchModelGeometry({ modelId, tokenId, tokenSecret });
  if (flags['save-raw']) {
    const file = checkedSavePath(flags['save-raw'], cwd);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(raw));
  }
  return raw;
}

// A valid building profile is used as is; anything else is treated as a raw CoStar record.
function loadProfile(file, mods, cwd, say) {
  const raw = readJson(resolve(cwd, file), 'profile');
  const direct = mods.profile.validateProfile(raw);
  if (direct.ok) {
    say(`Profile: ${direct.profile.name ?? file} (building profile, used as is)`);
    for (const w of direct.warnings ?? []) say(`  warning: ${w}`);
    return direct.profile;
  }
  const mapped = mods.profile.costarToProfile(raw);
  say(`Profile: ${file} is not a building profile; read as a CoStar record`);
  say(`  mapped: ${mapped.mapped?.join(', ') || 'nothing'}`);
  say(`  not mapped: ${mapped.unmapped?.join(', ') || 'nothing'}`);
  for (const w of mapped.warnings ?? []) say(`  warning: ${w}`);
  const checked = mods.profile.validateProfile(mapped.profile);
  if (!checked.ok) {
    throw new BuildingError(`The CoStar record did not give a usable profile:\n${checked.errors.map(e => `  - ${e}`).join('\n')}\n` +
      'Fix the record, or write the profile by hand (docs/PROTOTYPE.md §14a).');
  }
  return checked.profile;
}

const count = x => (Array.isArray(x) ? x.length : (x ?? 0));

function printReport(report, say) {
  say('');
  say(`Floor: ${report.floor?.label ?? report.floor?.id ?? report.floor ?? '–'}`);
  say(`Rooms: ${count(report.rooms)}   Tenants: ${count(report.tenants)}   Doors: ${count(report.doors)}`);
  const assignments = report.assignments ?? [];
  if (assignments.length) {
    say('Tenants matched:');
    for (const a of assignments) say(`  ${a.roomId} -> ${a.tenantName ?? '(no tenant)'} [${a.use ?? '–'}, ${a.how}]`);
  }
  const warnings = report.warnings ?? [];
  say(`Warnings: ${warnings.length || 'none'}`);
  for (const w of warnings) say(`  - ${w}`);
  const assumed = report.assumptionsUsed ?? [];
  say(`Assumptions used: ${assumed.length || 'none'}`);
  for (const a of assumed) say(`  - ${a.key} = ${JSON.stringify(a.value)}${a.why ? ` (${a.why})` : ''}`);
}

// Returns an exit code. `io` and `modules` exist for tests.
export async function cmdBuilding(_positional, flags, { modules, cwd = process.cwd(), out = s => process.stdout.write(s + '\n'), err = s => process.stderr.write(s + '\n'), env } = {}) {
  try {
    if (!flags.model && !flags['plan-raw']) throw new BuildingError('building needs --model <matterportId> or --plan-raw <file.json>.');
    if (flags.model && flags['plan-raw']) throw new BuildingError('Use either --model or --plan-raw, not both.');
    if (!flags.profile) throw new BuildingError('building needs --profile <file.json> (a building profile or a raw CoStar record).');
    if (flags['save-raw']) checkedSavePath(flags['save-raw'], cwd);
    const scenario = flags.scenario ?? DEFAULT_SCENARIO;

    if (!modules) loadEnv({ cwd });
    const mods = modules ?? await defaultModules();
    const theEnv = env ?? process.env;

    const raw = await loadRawPlan(flags, mods, cwd, theEnv);
    const floor = flags.floor === undefined ? undefined : (/^\d+$/.test(flags.floor) ? Number(flags.floor) : flags.floor);
    const extracted = mods.matterport.extractFloorplan(raw, { floor });
    const plan = mods.matterport.toMapUnits(extracted);
    for (const w of extracted.warnings ?? []) out(`floor plan warning: ${w}`);

    const profile = loadProfile(flags.profile, mods, cwd, out);
    const overrides = flags.overrides ? readJson(resolve(cwd, flags.overrides), 'overrides') : undefined;

    const { world, report } = mods.compose.composeBuildingWorld({ plan, profile, scenario, overrides });
    const checked = validateWorld(world);
    if (!checked.ok) throw new BuildingError(`The composed world is not valid:\n${checked.errors.map(e => `  - ${e}`).join('\n')}`);

    const file = resolve(cwd, flags.out ?? join('worlds', `${slug(profile.name ?? world.title, 0).replace(/_/g, '-')}-${scenario}.json`));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(world, null, 2) + '\n');

    printReport(report ?? {}, out);
    for (const w of checked.warnings) out(`validation warning: ${w}`);
    out('');
    out(`Wrote ${relative(cwd, file) || file}`);
    out(`Next: node bin/swarm.js estimate ${relative(cwd, file) || file}, then run it with --provider jev`);
    return 0;
  } catch (e) {
    err(`swarm building: ${e instanceof BuildingError ? e.message : (process.env.SWARM_DEBUG ? e.stack : e.message)}`);
    return 1;
  }
}
