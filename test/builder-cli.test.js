// builder/cli.js: `swarm import-matterport` and `swarm import-mesh` (docs/PROTOTYPE.md §13e).
// No network: every call passes `env` explicitly (so .env.local is never read) and a fetch that is
// either a mock or throws if called. Files go to fresh temporary directories.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cmdImportMatterport, cmdImportMesh, parseCliArgs } from '../builder/cli.js';
import { validateWorld } from '../engine/spec.js';
import { roomObj } from './fixtures/mesh/room.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/matterport/sample-model.json', import.meta.url));
const CLI = fileURLToPath(new URL('../builder/cli.js', import.meta.url));
const TOKEN_ID = 'cli-test-token-id';
const TOKEN_SECRET = 'cli-test-token-secret-never-print';

const dirs = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'swarm-cli-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// Captures what a command prints; `fetch` throws unless a mock is given.
function harness(cwd, { env = {}, fetch } = {}) {
  const lines = { out: [], err: [] };
  const calls = [];
  const fetchFn = fetch ?? (async () => { throw new Error('fetch must not be called in this test'); });
  return {
    lines, calls,
    opts: {
      cwd, env,
      fetch: async (url, init) => { calls.push({ url, init }); return fetchFn(url, init); },
      out: s => lines.out.push(s), err: s => lines.err.push(s)
    },
    text: () => [...lines.out, ...lines.err].join('\n')
  };
}

const fixtureResponse = () => new Response(readFileSync(FIXTURE, 'utf8'), { status: 200, headers: { 'content-type': 'application/json' } });
const readWorld = file => JSON.parse(readFileSync(file, 'utf8'));

describe('import-matterport --from-raw (no API call)', () => {
  test('writes a valid route world with the walls, via points, geo and provenance into the given file', async () => {
    const cwd = tempDir();
    const h = harness(cwd);
    const code = await cmdImportMatterport([], { 'from-raw': FIXTURE, out: 'worlds/floor.json' }, h.opts);
    assert.equal(code, 0, h.text());
    assert.equal(h.calls.length, 0);
    const file = join(cwd, 'worlds', 'floor.json');
    assert.ok(existsSync(file));
    const world = readWorld(file);
    assert.equal(world.mode, 'route');
    assert.equal(world.walls.length, 24);
    assert.ok(world.edges.some(e => e.via?.length), 'an edge routed around a wall');
    assert.equal(world.geo.source, 'matterport-vector');
    assert.equal(world.provenance.walls, 'data');
    assert.equal('warnings' in world, false, 'builder warnings are not written into the world');
    const v = validateWorld(world);
    assert.equal(v.ok, true, v.errors.join('; '));
    // The summary names rooms, walls, doors, warnings and the output path.
    const out = h.lines.out.join('\n');
    assert.match(out, /Rooms: 9 {3}Walls: 24 {3}Doors: 8 \(1 exterior\)/);
    assert.match(out, /Warnings: \d+/);
    assert.match(out, /window/);
    assert.match(out, /Wrote worlds\/floor\.json/);
    assert.equal(h.lines.err.length, 0);
  });

  test('visit mode, floor selection, and the default output under data/worlds/', async () => {
    const cwd = tempDir();
    const h = harness(cwd);
    assert.equal(await cmdImportMatterport([], { 'from-raw': FIXTURE, mode: 'visit' }, h.opts), 0, h.text());
    const written = readdirSync(join(cwd, 'data', 'worlds'));
    assert.equal(written.length, 1);
    const world = readWorld(join(cwd, 'data', 'worlds', written[0]));
    assert.equal(world.mode, 'visit');
    assert.ok(world.nodes.some(n => n.kind === 'gate') && world.nodes.filter(n => n.kind === 'service').length === 8);
    assert.ok(world.doors.length >= 8);
    assert.equal(validateWorld(world).ok, true);
    assert.doesNotMatch(h.lines.out.join('\n'), /outside data\//, 'no warning when the world is under data/');

    const h2 = harness(cwd);
    assert.equal(await cmdImportMatterport([], { 'from-raw': FIXTURE, floor: '1', out: 'second.json' }, h2.opts), 0, h2.text());
    assert.match(h2.lines.out.join('\n'), /Floor: Second floor \(sequence 1\)/);
    assert.match(h2.lines.out.join('\n'), /outside data\//);
    const h3 = harness(cwd);
    assert.equal(await cmdImportMatterport([], { 'from-raw': FIXTURE, floor: 'Penthouse', out: 'x.json' }, h3.opts), 1);
    assert.match(h3.lines.err.join('\n'), /Penthouse/);
  });

  test('explains bad input without writing anything', async () => {
    const cwd = tempDir();
    const bad = join(cwd, 'bad.json');
    writeFileSync(bad, '{ not json');
    const cases = [
      [[], {}, /needs a model id .* or --from-raw/],
      [['abc123XYZ'], { 'from-raw': FIXTURE }, /either a model id or --from-raw/],
      [[], { 'from-raw': FIXTURE, mode: 'drive' }, /--mode must be route or visit/],
      [[], { 'from-raw': FIXTURE, 'save-raw': 'data/x.json' }, /already exists/],
      [[], { 'from-raw': join(cwd, 'missing.json') }, /no such file/],
      [[], { 'from-raw': bad }, /not valid JSON/],
      [['not a model!'], {}, /does not look like a Matterport model id/]
    ];
    for (const [pos, flags, re] of cases) {
      const h = harness(cwd);
      assert.equal(await cmdImportMatterport(pos, flags, h.opts), 1, JSON.stringify(flags));
      assert.match(h.lines.err.join('\n'), re);
      assert.match(h.lines.err[0], /^swarm import-matterport: /);
      assert.equal(h.calls.length, 0);
    }
    assert.deepEqual(readdirSync(cwd), ['bad.json']);
  });
});

describe('import-matterport <modelId> (keys and raw dumps)', () => {
  test('missing keys give a clear message naming what is missing, with no API call', async () => {
    const cwd = tempDir();
    const none = harness(cwd, { env: {} });
    assert.equal(await cmdImportMatterport(['abc123XYZ'], {}, none.opts), 1);
    const msg = none.lines.err.join('\n');
    assert.match(msg, /MATTERPORT_API_KEY \(token ID\) and MATTERPORT_API_TOKEN \(token secret\); missing: MATTERPORT_API_KEY, MATTERPORT_API_TOKEN/);
    assert.match(msg, /\.env\.local/);
    assert.match(msg, /--from-raw data\/abc123XYZ\.json/);
    assert.equal(none.calls.length, 0);

    const half = harness(cwd, { env: { MATTERPORT_API_KEY: TOKEN_ID, MATTERPORT_API_TOKEN: '  ' } });
    assert.equal(await cmdImportMatterport(['abc123XYZ'], {}, half.opts), 1);
    assert.match(half.lines.err.join('\n'), /missing: MATTERPORT_API_TOKEN\./);
    assert.ok(!half.text().includes(TOKEN_ID), 'a key value was printed');
    assert.equal(half.calls.length, 0);
    assert.deepEqual(readdirSync(cwd), []);
  });

  test('raw dumps are refused anywhere but under data/, before any API call', async () => {
    const cwd = tempDir();
    const outside = tempDir();
    mkdirSync(join(cwd, 'data'));
    symlinkSync(outside, join(cwd, 'data', 'escape'));
    const env = { MATTERPORT_API_KEY: TOKEN_ID, MATTERPORT_API_TOKEN: TOKEN_SECRET };
    for (const target of ['raw.json', 'worlds/raw.json', '../raw.json', 'data/../raw.json', 'data', join(outside, 'raw.json'), 'data/escape/raw.json', 'data/raw.txt']) {
      const h = harness(cwd, { env, fetch: async () => fixtureResponse() });
      assert.equal(await cmdImportMatterport(['abc123XYZ'], { 'save-raw': target, out: 'data/worlds/w.json' }, h.opts), 1, target);
      assert.match(h.lines.err.join('\n'), /--save-raw (only writes under data\/|needs a \.json file name)/, target);
      assert.equal(h.calls.length, 0, `fetched before refusing ${target}`);
    }
    assert.deepEqual(readdirSync(outside), []);
    assert.deepEqual(readdirSync(join(cwd, 'data')), ['escape']);
  });

  test('with keys, fetches through the given fetch, saves the raw dump under data/ and writes the world', async () => {
    const cwd = tempDir();
    const env = { MATTERPORT_API_KEY: TOKEN_ID, MATTERPORT_API_TOKEN: TOKEN_SECRET };
    const h = harness(cwd, { env, fetch: async () => fixtureResponse() });
    const code = await cmdImportMatterport(['abc123XYZ'], { 'save-raw': 'data/abc123XYZ.json', mode: 'visit' }, h.opts);
    assert.equal(code, 0, h.text());
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].init.headers.Authorization, `Basic ${Buffer.from(`${TOKEN_ID}:${TOKEN_SECRET}`).toString('base64')}`);
    assert.equal(JSON.parse(h.calls[0].init.body).variables.modelId, 'abc123XYZ');
    const raw = JSON.parse(readFileSync(join(cwd, 'data', 'abc123XYZ.json'), 'utf8'));
    assert.ok(raw.model.rooms.length >= 9);
    assert.equal(readdirSync(join(cwd, 'data', 'worlds')).length, 1);
    assert.ok(!h.text().includes(TOKEN_SECRET) && !h.text().includes(TOKEN_ID), 'a key value was printed');
    assert.match(h.lines.out.join('\n'), /Saved the raw model to data\/abc123XYZ\.json/);
  });

  test('an API failure is reported without the credentials', async () => {
    const cwd = tempDir();
    const env = { MATTERPORT_API_KEY: TOKEN_ID, MATTERPORT_API_TOKEN: TOKEN_SECRET };
    const h = harness(cwd, { env, fetch: async () => new Response(`denied for ${TOKEN_SECRET}`, { status: 401 }) });
    assert.equal(await cmdImportMatterport(['abc123XYZ'], {}, h.opts), 1);
    assert.match(h.lines.err.join('\n'), /HTTP 401/);
    assert.ok(!h.text().includes(TOKEN_SECRET));
    assert.equal(existsSync(join(cwd, 'data')), false);
  });
});

describe('import-mesh', () => {
  test('writes a valid visit world with the sliced walls into the given file', async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, 'room.obj'), roomObj());
    const h = harness(cwd);
    assert.equal(await cmdImportMesh(['room.obj'], { out: 'w.json' }, h.opts), 0, h.text());
    const world = readWorld(join(cwd, 'w.json'));
    assert.equal(world.mode, 'visit');
    assert.equal(world.walls.length, 18);
    assert.ok(world.walls.every(w => w.source === 'mesh-slice'));
    assert.equal(world.geo.source, 'mesh-slice');
    assert.equal(validateWorld(world).ok, true);
    const out = h.lines.out.join('\n');
    assert.match(out, /up axis z, detected/);
    assert.match(out, /Walls: 18/);
    assert.match(out, /human check/);
    assert.match(out, /Wrote w\.json/);
  });

  test('--up y reads a Y-up file to the same walls; bad input is explained', async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, 'z.obj'), roomObj({ up: 'z' }));
    writeFileSync(join(cwd, 'y.obj'), roomObj({ up: 'y' }));
    assert.equal(await cmdImportMesh(['z.obj'], { out: 'z.json' }, harness(cwd).opts), 0);
    const hy = harness(cwd);
    assert.equal(await cmdImportMesh(['y.obj'], { out: 'y.json', up: 'y' }, hy.opts), 0, hy.text());
    assert.match(hy.lines.out.join('\n'), /up axis y, as given/);
    assert.deepEqual(readWorld(join(cwd, 'y.json')).walls, readWorld(join(cwd, 'z.json')).walls);

    for (const [pos, flags, re] of [
      [['z.obj'], { up: 'x' }, /--up must be z or y/],
      [[], {}, /exactly one \.obj file/],
      [['nope.obj'], {}, /no such file/]
    ]) {
      const h = harness(cwd);
      assert.equal(await cmdImportMesh(pos, flags, h.opts), 1);
      assert.match(h.lines.err.join('\n'), re);
    }
    writeFileSync(join(cwd, 'empty.obj'), '# nothing\nv 0 0 0\n');
    const he = harness(cwd);
    assert.equal(await cmdImportMesh(['empty.obj'], {}, he.opts), 1);
    assert.match(he.lines.err.join('\n'), /No walls survived/);
  });
});

describe('running builder/cli.js directly', () => {
  test('parses flags in both forms', () => {
    assert.deepEqual(parseCliArgs(['import-matterport', '--from-raw', 'a.json', '--mode=visit']),
      { positional: ['import-matterport'], flags: { 'from-raw': 'a.json', mode: 'visit' } });
    assert.throws(() => parseCliArgs(['import-mesh', 'x.obj', '--out']), /--out needs a value/);
  });

  test('node builder/cli.js import-matterport --from-raw ... writes the world (temp cwd, so no .env.local)', () => {
    const cwd = tempDir();
    const r = spawnSync(process.execPath, [CLI, 'import-matterport', '--from-raw', FIXTURE, '--out', 'w.json'], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Wrote w\.json/);
    assert.equal(validateWorld(readWorld(join(cwd, 'w.json'))).ok, true);

    const bad = spawnSync(process.execPath, [CLI, 'import-mesh', 'x.obj', '--floor', '2'], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /import-mesh does not take --floor/);
    const none = spawnSync(process.execPath, [CLI], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(none.status, 1);
    assert.match(none.stderr, /Usage:/);
  });
});
