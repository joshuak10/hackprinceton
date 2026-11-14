// `swarm import-matterport` and `swarm import-mesh` (docs/PROTOTYPE.md §13e): starter worlds whose walls
// come from a Matterport model's vector floor plan or from a 3D mesh. Agents can never walk through them.
//
//   import-matterport <modelId> [--floor N] [--mode route|visit] [--out FILE] [--save-raw data/<id>.json]
//   import-matterport --from-raw <file.json> [--floor N] [--mode route|visit] [--out FILE]   (no API call)
//   import-mesh <file.obj> [--up z|y] [--out FILE]
//
// Worlds built from a real model contain its floor plan, so by default they are written under
// data/worlds/ (gitignored); pass --out worlds/<slug>.json only for hand-made or synthetic plans.
// Raw model dumps (--save-raw) may only be written under data/.
//
// Both commands return an exit code. bin/swarm.js calls them as cmd(positional, flags); the third
// argument exists for tests: { cwd, env, fetch, out, err }. Run directly as
//   node builder/cli.js import-matterport --from-raw test/fixtures/matterport/sample-model.json
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, sep, join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../engine/env.js';
import { slug } from '../engine/util.js';
import { validateWorld } from '../engine/spec.js';
import { fetchModelGeometry, extractFloorplan, toMapUnits, floorplanToWorld } from './matterport.js';
import { meshToWalls, meshToWorld } from './mesh.js';

class ImportError extends Error {}

const MODEL_ID = /^[A-Za-z0-9]{6,32}$/;
const KEY_NAMES = ['MATTERPORT_API_KEY', 'MATTERPORT_API_TOKEN'];

const shown = (file, cwd) => {
  const rel = relative(cwd, file);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : file;
};

const within = (parent, file) => {
  const rel = relative(parent, file);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..');
};

// The real path of `file`, or of its nearest existing ancestor joined with the rest.
function realish(file) {
  let head = file;
  const tail = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) return file;
    tail.unshift(basename(head));
    head = up;
  }
  return join(realpathSync(head), ...tail);
}

// Raw model dumps are hackathon data: only under data/ (gitignored), also after resolving symlinks.
function rawDumpPath(file, cwd) {
  const full = resolve(cwd, String(file));
  const data = join(cwd, 'data');
  const ok = within(data, full) && (!existsSync(data) || within(realpathSync(data), realish(full)));
  if (!ok) throw new ImportError(`--save-raw only writes under data/ (gitignored, so raw model data is never committed); "${file}" is outside it.`);
  if (extname(full).toLowerCase() !== '.json') throw new ImportError(`--save-raw needs a .json file name, e.g. data/<modelId>.json; got "${file}".`);
  return full;
}

function readJson(file, what) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { throw new ImportError(`Could not read ${what} ${file}: ${e.code === 'ENOENT' ? 'no such file' : e.message}`); }
  try { return JSON.parse(text); } catch (e) { throw new ImportError(`${what} ${file} is not valid JSON: ${e.message}`); }
}

function writeWorld(file, world) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(world, null, 2) + '\n');
}

function outPath(flags, cwd, title) {
  if (flags.out !== undefined) {
    if (typeof flags.out !== 'string' || !flags.out.trim()) throw new ImportError('--out needs a file name.');
    return resolve(cwd, flags.out);
  }
  return resolve(cwd, 'data', 'worlds', `${slug(title, 0).replace(/_/g, '-')}.json`);
}

function parseFloor(v) {
  if (v === undefined || v === null || v === true) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  return /^\d+$/.test(s) ? Number(s) : s;
}

function checked(world) {
  const v = validateWorld(world);
  if (!v.ok) throw new ImportError(`The starter world is not valid, so nothing was written:\n${v.errors.map(e => `  - ${e}`).join('\n')}`);
  return v;
}

function printWarnings(say, builder, validation) {
  const all = [...builder, ...validation.map(w => `validation: ${w}`)];
  say(`Warnings: ${all.length || 'none'}`);
  for (const w of all) say(`  - ${w}`);
}

function io(opts) {
  return {
    cwd: opts.cwd ?? process.cwd(),
    out: opts.out ?? (s => process.stdout.write(s + '\n')),
    err: opts.err ?? (s => process.stderr.write(s + '\n'))
  };
}

const failed = (err, name, e) => {
  err(`swarm ${name}: ${e instanceof ImportError || e instanceof RangeError ? e.message : (process.env.SWARM_DEBUG ? e.stack : e.message)}`);
  return 1;
};

/**
 * swarm import-matterport: a starter world (route or visit mode) with walls, doors and via points
 * from a Matterport model's vector floor plan.
 */
export async function cmdImportMatterport(positional = [], flags = {}, opts = {}) {
  const { cwd, out: say, err } = io(opts);
  try {
    const modelId = positional[0] === undefined ? undefined : String(positional[0]).trim();
    const fromRaw = flags['from-raw'];
    if (positional.length > 1) throw new ImportError('import-matterport takes one model id.');
    if (modelId && fromRaw) throw new ImportError('Give either a model id or --from-raw <file.json>, not both.');
    if (!modelId && !fromRaw) {
      throw new ImportError('import-matterport needs a model id (fetched with MATTERPORT_API_KEY and MATTERPORT_API_TOKEN) or --from-raw <file.json> (a saved model dump, no API call).');
    }
    if (fromRaw && flags['save-raw'] !== undefined) throw new ImportError('--save-raw saves a fetched model; with --from-raw the raw file already exists.');
    const mode = flags.mode === undefined ? 'route' : String(flags.mode);
    if (mode !== 'route' && mode !== 'visit') throw new ImportError(`--mode must be route or visit, not "${mode}".`);
    const savePath = flags['save-raw'] === undefined ? null : rawDumpPath(flags['save-raw'], cwd);

    let raw, source;
    if (fromRaw) {
      const file = resolve(cwd, String(fromRaw));
      raw = readJson(file, 'model dump');
      source = shown(file, cwd);
    } else {
      if (!MODEL_ID.test(modelId)) throw new ImportError(`"${modelId}" does not look like a Matterport model id (6-32 letters and digits).`);
      if (!opts.env) loadEnv({ cwd });
      const env = opts.env ?? process.env;
      const missing = KEY_NAMES.filter(k => typeof env[k] !== 'string' || !env[k].trim());
      if (missing.length) {
        throw new ImportError(
          `Fetching model ${modelId} needs both MATTERPORT_API_KEY (token ID) and MATTERPORT_API_TOKEN (token secret); missing: ${missing.join(', ')}.\n` +
          'Add them to .env.local in the repo root, or save the model JSON under data/ and run\n' +
          `  swarm import-matterport --from-raw data/${modelId}.json  (no API call).`
        );
      }
      raw = await fetchModelGeometry({ modelId, tokenId: env.MATTERPORT_API_KEY.trim(), tokenSecret: env.MATTERPORT_API_TOKEN.trim(), fetch: opts.fetch });
      source = `Matterport model ${modelId} (fetched)`;
      if (savePath) {
        mkdirSync(dirname(savePath), { recursive: true });
        writeFileSync(savePath, JSON.stringify(raw));
        say(`Saved the raw model to ${shown(savePath, cwd)} (gitignored; never commit it)`);
      }
    }

    let plan;
    try { plan = extractFloorplan(raw, { floor: parseFloor(flags.floor) }); } catch (e) { throw new ImportError(e.message); }
    if (!plan.rooms.length || !plan.walls.length) {
      throw new ImportError(`${source} has no rooms or walls on this floor. Is it a Property Intelligence model (vector data)? For a model without it, export the mesh and use import-mesh.\n${plan.warnings.map(w => `  - ${w}`).join('\n')}`);
    }
    const world = floorplanToWorld(toMapUnits(plan), { mode });
    const validation = checked(world);
    const file = outPath(flags, cwd, world.title);
    writeWorld(file, world);

    const doors = plan.doors.filter(d => d.type !== 'invisible');
    const floors = plan.floors?.length ?? 0;
    const floorName = plan.floor ? `${plan.floor.label || plan.floor.id} (sequence ${plan.floor.sequence ?? '?'})` : 'the whole model';
    say(`Source: ${source}`);
    say(`Floor: ${floorName}${floors > 1 ? `, 1 of ${floors} floors (choose with --floor)` : ''}`);
    say(`Rooms: ${plan.rooms.length}   Walls: ${world.walls.length}   Doors: ${doors.length} (${doors.filter(d => d.outside).length} exterior)   Open sides: ${plan.doors.length - doors.length}`);
    say(`World: ${world.mode} mode, ${world.nodes.length} nodes${world.mode === 'route' ? `, ${world.edges.length} edges (${world.edges.filter(e => e.via?.length).length} routed around walls with via points)` : `, ${world.doors?.length ?? 0} doorways counted`}`);
    say(`Scale: ${(+world.geo.metersPerUnit).toFixed(3)} m per map unit; paths keep ${world.geo.clearance} units from wall ends`);
    printWarnings(say, world.warnings ?? [], validation.warnings);
    say('');
    say(`Wrote ${shown(file, cwd)}`);
    if (!within(join(cwd, 'data'), file)) {
      say('Note: this file is outside data/ and holds the floor plan; commit it only if the plan is synthetic or yours to share.');
    }
    say(`Next: replace the placeholder group with real archetypes and a cast (worlds/SCHEMA.md), then swarm validate ${shown(file, cwd)}`);
    return 0;
  } catch (e) {
    return failed(err, 'import-matterport', e);
  }
}

/**
 * swarm import-mesh: a starter visit world with walls sliced from an OBJ mesh, placeholder places at
 * the most open reachable spots. Mesh walls need a human check (tall furniture, glass, scan holes).
 */
export async function cmdImportMesh(positional = [], flags = {}, opts = {}) {
  const { cwd, out: say, err } = io(opts);
  try {
    if (positional.length !== 1) throw new ImportError('import-mesh needs exactly one .obj file.');
    const up = flags.up === undefined ? undefined : String(flags.up);
    if (up !== undefined && up !== 'z' && up !== 'y') throw new ImportError(`--up must be z or y, not "${up}".`);
    const file = resolve(cwd, String(positional[0]));
    let bytes;
    try { bytes = readFileSync(file); } catch (e) { throw new ImportError(`Could not read mesh ${file}: ${e.code === 'ENOENT' ? 'no such file' : e.message}`); }

    const result = meshToWalls(bytes, up ? { up } : {});
    if (!result.walls.length) throw new ImportError(`No walls survived at every slice height in ${shown(file, cwd)}.\n${result.warnings.map(w => `  - ${w}`).join('\n')}`);
    const world = meshToWorld(result, { file });
    const validation = checked(world);
    const outFile = outPath(flags, cwd, world.title);
    writeWorld(outFile, world);

    const b = result.bounds;
    say(`Source: ${shown(file, cwd)} (up axis ${result.up}${up ? ', as given' : ', detected'}; floor at ${result.floorHeight} m; cut at ${result.levels.join(' and ')} m)`);
    say(`Plan: ${(b.maxX - b.minX).toFixed(1)} x ${(b.maxY - b.minY).toFixed(1)} m`);
    say(`Rooms: not in a mesh   Walls: ${world.walls.length}   Doors: not in a mesh (doorways are gaps in the walls)`);
    say(`World: visit mode, 1 entrance (${world.nodes[0].name}) and ${world.nodes.length - 1} placeholder places at open spots`);
    say(`Scale: ${(+world.geo.metersPerUnit).toFixed(3)} m per map unit; paths keep ${world.geo.clearance} units from wall ends`);
    printWarnings(say, world.warnings ?? [], validation.warnings);
    say('');
    say(`Wrote ${shown(outFile, cwd)}`);
    say('Check the walls by eye in the viewer before relying on them, then replace the placeholder places, group and cast (worlds/SCHEMA.md).');
    return 0;
  } catch (e) {
    return failed(err, 'import-mesh', e);
  }
}

// ---------- running directly: node builder/cli.js <command> ... ----------

const COMMANDS = {
  'import-matterport': { run: cmdImportMatterport, flags: ['floor', 'mode', 'out', 'save-raw', 'from-raw'] },
  'import-mesh': { run: cmdImportMesh, flags: ['out', 'up'] }
};

const USAGE = `Usage:
  node builder/cli.js import-matterport <modelId> [--floor N] [--mode route|visit] [--out FILE] [--save-raw data/<id>.json]
  node builder/cli.js import-matterport --from-raw <file.json> [--floor N] [--mode route|visit] [--out FILE]
  node builder/cli.js import-mesh <file.obj> [--up z|y] [--out FILE]
Worlds are written under data/worlds/ unless --out says otherwise.`;

export function parseCliArgs(argv) {
  const positional = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { flags.help = true; continue; }
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
    const value = eq < 0 ? argv[++i] : a.slice(eq + 1);
    if (value === undefined) throw new ImportError(`--${name} needs a value`);
    flags[name] = value;
  }
  return { positional, flags };
}

async function main(argv) {
  let parsed;
  try { parsed = parseCliArgs(argv); } catch (e) { process.stderr.write(`${e.message}\n${USAGE}\n`); return 1; }
  const [name, ...rest] = parsed.positional;
  const command = COMMANDS[name];
  if (!command || parsed.flags.help) { (command ? process.stdout : process.stderr).write(USAGE + '\n'); return parsed.flags.help ? 0 : 1; }
  const unknown = Object.keys(parsed.flags).filter(f => !command.flags.includes(f));
  if (unknown.length) { process.stderr.write(`${name} does not take ${unknown.map(f => `--${f}`).join(', ')}\n${USAGE}\n`); return 1; }
  return command.run(rest, parsed.flags);
}

const self = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? (() => { try { return realpathSync(process.argv[1]); } catch { return resolve(process.argv[1]); } })() : '';
if (invoked === self) main(process.argv.slice(2)).then(code => { process.exitCode = code; });
