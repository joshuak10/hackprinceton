// `swarm building` tests (docs/PROTOTYPE.md §14e) with stand-in builder modules; no network, no real floor plan.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdBuilding } from '../builder/building-cli.js';
import { reportMarkdown, BUILDING_LIMITS } from '../run/report.js';

const WORLD = {
  title: 'Fictional Block', question: 'Where is the traffic?', mode: 'visit', duration: 60, clockStart: 690,
  nodes: [
    { id: 'cafe', name: 'Cafe', kind: 'service', x: 10, y: 10, servers: 1, serviceTime: 2 },
    { id: 'door', name: 'Front Door', kind: 'gate', x: 20, y: 20 }
  ],
  edges: [],
  archetypes: [{ id: 'p', name: 'People' }],
  minds: [{ id: 'm', name: 'Mo', age: 30, archetype: 'p', bio: 'b', personality: 'p', goal: 'g', social: 's' }]
};

function standIns(calls = {}) {
  return {
    matterport: {
      fetchModelGeometry: async args => { calls.fetch = args; return { raw: true }; },
      extractFloorplan: (raw, opts) => { calls.extract = { raw, opts }; return { units: 'm', warnings: ['one opening stays solid'] }; },
      toMapUnits: plan => ({ ...plan, units: 'map' })
    },
    profile: {
      validateProfile: raw => (raw.source ? { ok: true, errors: [], warnings: [], profile: raw } : { ok: false, errors: ['no source'], warnings: [] }),
      costarToProfile: raw => {
        calls.costar = raw;
        return { profile: { source: 'costar', name: raw.PropertyName, tenants: [] }, mapped: ['PropertyName'], unmapped: ['Weird'], warnings: [] };
      }
    },
    compose: {
      composeBuildingWorld: args => {
        calls.compose = args;
        return {
          world: WORLD,
          report: {
            floor: { label: 'Level 1' }, rooms: [1, 2, 3], tenants: [1], doors: [1, 2],
            assignments: [{ roomId: 'r1', tenantName: 'Cafe', use: 'restaurant', how: 'area-match' }],
            warnings: ['room r3 has no tenant'],
            assumptionsUsed: [{ key: 'sfPerOfficeWorker', value: 200, why: 'rule of thumb' }]
          }
        };
      }
    }
  };
}

describe('swarm building', () => {
  let dir; let lines; let errs; let calls;
  const io = () => ({ cwd: dir, out: s => lines.push(s), err: s => errs.push(s) });
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bcli-')); lines = []; errs = []; calls = {}; });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (name, value) => { writeFileSync(join(dir, name), JSON.stringify(value)); return name; };

  test('--plan-raw and a building profile write a world and print the report', async () => {
    const plan = write('plan.json', { rooms: [] });
    const profile = write('profile.json', { source: 'manual', name: 'Fictional Block' });
    const code = await cmdBuilding([], { 'plan-raw': plan, profile, floor: '2' }, { ...io(), modules: standIns(calls) });
    assert.equal(code, 0, errs.join('\n'));
    const file = join(dir, 'worlds', 'fictional-block-weekday-lunch.json');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).title, 'Fictional Block');
    assert.equal(calls.fetch, undefined);
    assert.equal(calls.extract.opts.floor, 2);
    assert.equal(calls.compose.scenario, 'weekday-lunch');
    assert.equal(calls.compose.plan.units, 'map');
    const text = lines.join('\n');
    for (const piece of ['Level 1', 'Rooms: 3', 'Doors: 2', 'r1 -> Cafe', 'area-match', 'room r3 has no tenant', 'sfPerOfficeWorker = 200', 'one opening stays solid']) {
      assert.ok(text.includes(piece), `report mentions ${piece}`);
    }
  });

  test('a raw CoStar record goes through costarToProfile and says what was mapped', async () => {
    const plan = write('plan.json', {});
    const profile = write('costar.json', { PropertyName: 'Fictional Block' });
    const code = await cmdBuilding([], { 'plan-raw': plan, profile, out: 'w.json', scenario: 'saturday-afternoon' }, { ...io(), modules: standIns(calls) });
    assert.equal(code, 0, errs.join('\n'));
    assert.deepEqual(calls.costar, { PropertyName: 'Fictional Block' });
    assert.equal(calls.compose.scenario, 'saturday-afternoon');
    assert.ok(existsSync(join(dir, 'w.json')));
    const text = lines.join('\n');
    assert.match(text, /mapped: PropertyName/);
    assert.match(text, /not mapped: Weird/);
  });

  test('--model without both Matterport variables gives a clear message and no call', async () => {
    const profile = write('profile.json', { source: 'manual' });
    const code = await cmdBuilding([], { model: '6FNMVoyPrL1', profile }, { ...io(), modules: standIns(calls), env: { MATTERPORT_API_KEY: 'k' } });
    assert.equal(code, 1);
    const msg = errs.join('\n');
    assert.match(msg, /MATTERPORT_API_KEY and MATTERPORT_API_TOKEN/);
    assert.match(msg, /missing: MATTERPORT_API_TOKEN/);
    assert.equal(calls.fetch, undefined);
  });

  test('with both variables the model is fetched and saved under data/', async () => {
    const profile = write('profile.json', { source: 'manual', name: 'X' });
    const env = { MATTERPORT_API_KEY: 'id-value', MATTERPORT_API_TOKEN: 'secret-value' };
    const code = await cmdBuilding([], { model: '6FNMVoyPrL1', profile, 'save-raw': 'data/m.json' }, { ...io(), modules: standIns(calls), env });
    assert.equal(code, 0, errs.join('\n'));
    assert.deepEqual(calls.fetch, { modelId: '6FNMVoyPrL1', tokenId: 'id-value', tokenSecret: 'secret-value' });
    assert.ok(existsSync(join(dir, 'data', 'm.json')));
    assert.ok(!lines.concat(errs).join('\n').includes('secret-value'));
  });

  test('--save-raw outside data/ is refused before any fetch', async () => {
    const profile = write('profile.json', { source: 'manual' });
    const env = { MATTERPORT_API_KEY: 'a', MATTERPORT_API_TOKEN: 'b' };
    for (const target of ['raw.json', '../data/x.json', 'data/../x.json', '/tmp/x.json']) {
      const code = await cmdBuilding([], { model: '6FNMVoyPrL1', profile, 'save-raw': target }, { ...io(), modules: standIns(calls), env });
      assert.equal(code, 1, target);
      assert.match(errs.at(-1), /only writes under data\//);
    }
    assert.equal(calls.fetch, undefined);
  });

  test('missing inputs and an unusable profile fail with a message', async () => {
    assert.equal(await cmdBuilding([], {}, { ...io(), modules: standIns() }), 1);
    assert.match(errs.at(-1), /--model .* or --plan-raw/);
    assert.equal(await cmdBuilding([], { 'plan-raw': 'p.json' }, { ...io(), modules: standIns() }), 1);
    assert.match(errs.at(-1), /--profile/);
    const mods = standIns();
    mods.profile.costarToProfile = () => ({ profile: {}, mapped: [], unmapped: [], warnings: [] });
    write('p.json', {});
    write('bad.json', { nothing: 1 });
    assert.equal(await cmdBuilding([], { 'plan-raw': 'p.json', profile: 'bad.json' }, { ...io(), modules: mods }), 1);
    assert.match(errs.at(-1), /usable profile/);
  });

  test('an invalid composed world is not written', async () => {
    const mods = standIns();
    mods.compose.composeBuildingWorld = () => ({ world: { title: 'x' }, report: {} });
    write('p.json', {});
    write('pr.json', { source: 'manual', name: 'X' });
    const code = await cmdBuilding([], { 'plan-raw': 'p.json', profile: 'pr.json', out: 'o.json' }, { ...io(), modules: mods });
    assert.equal(code, 1);
    assert.match(errs.at(-1), /not valid/);
    assert.ok(!existsSync(join(dir, 'o.json')));
  });
});

describe('reportMarkdown for building runs', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'brep-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function runWith(metrics) {
    const runDir = join(dir, 'run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'meta.json'), JSON.stringify({ runId: 'r1', status: 'done', provider: 'rules', seed: 7, mode: 'visit', duration: 60, clockStart: 690, agents: 3, decisions: 0, title: 'Fictional Block' }));
    writeFileSync(join(runDir, 'spec.json'), JSON.stringify({ ...WORLD, minds: [] }));
    writeFileSync(join(runDir, 'metrics.json'), JSON.stringify(metrics));
    for (const f of ['agents.json', 'remarks.json']) writeFileSync(join(runDir, f), '[]');
    writeFileSync(join(runDir, 'decisions.jsonl'), '');
    return runDir;
  }
  const base = { mode: 'visit', nodes: [], archetypes: [], spawned: 3, served: 0, abandoned: 0, avgWait: 0, abandonRate: 0 };

  test('shows the doorways table, the wall line and the limits', () => {
    const md = reportMarkdown(runWith({
      ...base,
      doors: [
        { id: 'd1', name: 'Front Door', exterior: true, crossings: 412, peakPer5Min: 38, peakClock: '12:05' },
        { id: 'd2', name: 'Cafe Door', exterior: false, crossings: 120, peakPer5Min: 14, peakClock: '12:20' }
      ],
      walls: { count: 52, checkedMoves: 1840, violations: 0 }
    }));
    assert.match(md, /## Busiest doorways/);
    assert.match(md, /\| 1 \| Front Door \| 412 \| 38 \| 12:05 \|/);
    assert.match(md, /52 walls, 1,?840 moves checked, 0 violations/);
    assert.ok(md.includes(BUILDING_LIMITS));
  });

  test('worlds without doors or walls are unchanged', () => {
    const md = reportMarkdown(runWith(base));
    assert.ok(!md.includes('Busiest doorways'));
    assert.ok(!md.includes('Limits of v0.2'));
  });
});
