// Frame cadence for walled worlds, head counts in observations, and the run endpoints the scope display
// reads (docs/PROTOTYPE.md §7, §9b; SWARMSCOPE_SPEC.md v0.18).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Sim } from '../engine/sim.js';
import { startServer } from '../server/server.js';

const BIN = fileURLToPath(new URL('../bin/swarm.js', import.meta.url));

// Same layout as the two-room world in sim-walls.test.js: a front door on the left, a middle door low in
// the dividing wall, a help desk in the right room.
const OUTER_TWO = [[10, 10, 90, 10], [90, 10, 90, 50], [90, 50, 10, 50], [10, 10, 10, 28], [10, 32, 10, 50]];
const TWO_ROOMS = {
  title: 'Two-room test office (fictional)', question: 'Does the middle door carry everyone?',
  context: 'A made-up two-room office used by the engine tests.', mode: 'visit',
  duration: 240, clockStart: 600, travelSpeed: 8,
  arrivals: { total: 30, start: 0, end: 60, shape: 'uniform' },
  nodes: [
    { id: 'front', name: 'Front door', kind: 'gate', x: 10, y: 30 },
    { id: 'desk', name: 'Help desk', kind: 'service', x: 80, y: 40, servers: 1, serviceTime: 6, tags: ['help'] }
  ],
  archetypes: [{ id: 'visitor', name: 'Visitors', share: 1, visits: 1, patience: 240, info: 1 }],
  walls: [...OUTER_TWO, [50, 10, 50, 14], [50, 18, 50, 50]],
  doors: [
    { id: 'front_door', name: 'Front door', x1: 10, y1: 28, x2: 10, y2: 32, exterior: true },
    { id: 'mid', name: 'Middle door', x1: 50, y1: 14, x2: 50, y2: 18, exterior: false }
  ],
  geo: { clearance: 0.2 }
};
const { walls: _w, doors: _d, geo: _g, ...NO_WALLS } = TWO_ROOMS;

const run = (spec, opts) => { const sim = new Sim(spec, { seed: 3, ...opts }); sim.runToEnd(); return sim; };

// Independent of engine/walls.js: does segment p→q cross wall w away from the wall's ends?
const orient = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
function crossesMidWall(p, q, [x1, y1, x2, y2], endSlack) {
  const d1 = orient(x1, y1, x2, y2, p[0], p[1]), d2 = orient(x1, y1, x2, y2, q[0], q[1]);
  const d3 = orient(p[0], p[1], q[0], q[1], x1, y1), d4 = orient(p[0], p[1], q[0], q[1], x2, y2);
  if (!(d1 * d2 < 0 && d3 * d4 < 0)) return false;
  const den = (q[0] - p[0]) * (y2 - y1) - (q[1] - p[1]) * (x2 - x1);
  const t = ((x1 - p[0]) * (y2 - y1) - (y1 - p[1]) * (x2 - x1)) / den;
  const cx = p[0] + t * (q[0] - p[0]), cy = p[1] + t * (q[1] - p[1]);
  return Math.min(Math.hypot(cx - x1, cy - y1), Math.hypot(cx - x2, cy - y2)) > endSlack;
}

describe('frame cadence', () => {
  test('walled worlds record a frame every 3 s by default; worlds without walls keep the old default', () => {
    assert.equal(new Sim(TWO_ROOMS, { seed: 3 }).frameEvery, 3 / 60);
    assert.equal(new Sim(NO_WALLS, { seed: 3 }).frameEvery, Math.max(0.5, 240 / 360));
    assert.equal(new Sim(TWO_ROOMS, { seed: 3, frameEvery: 0.1 }).frameEvery, 0.1);
  });

  test('frames finer than the tick do not change the simulation', () => {
    const coarse = run(TWO_ROOMS, { frameEvery: 0.5 });
    const fine = run(TWO_ROOMS);
    assert.deepEqual(fine.metrics(), coarse.metrics());
    assert.deepEqual(fine.remarks, coarse.remarks);
    assert.ok(fine.frames.list.length >= 9 * coarse.frames.list.length, `${fine.frames.list.length} vs ${coarse.frames.list.length}`);
    // Frames at tick times hold the same people in the same states at the same places. Positions may
    // differ by one 0.1-unit rounding step: rounding is chosen so a dot can see its previous frame.
    const byT = new Map(fine.frames.list.map(f => [f.t, f]));
    for (const f of coarse.frames.list) {
      const g = byT.get(f.t);
      assert.ok(g, `fine run has a frame at t ${f.t}`);
      assert.equal(g.a.length, f.a.length, `frame at t ${f.t}`);
      for (let k = 0; k < f.a.length; k += 4) {
        assert.equal(g.a[k], f.a[k]);
        assert.equal(g.a[k + 3], f.a[k + 3]);
        assert.ok(Math.abs(g.a[k + 1] - f.a[k + 1]) <= 1 && Math.abs(g.a[k + 2] - f.a[k + 2]) <= 1, `agent ${f.a[k]} at t ${f.t}`);
      }
    }
  });

  test('frames are evenly spaced 3 s apart', () => {
    const { list } = run(TWO_ROOMS).frames;
    for (let i = 1; i < list.length; i++) assert.ok(Math.abs(list[i].t - list[i - 1].t - 0.05) < 1e-3, `gap at ${list[i].t}`);
  });

  test('a dot drawn straight between consecutive frames never passes through a wall', () => {
    for (const fe of [3 / 60, 5 / 60]) {
      const sim = run(TWO_ROOMS, { frameEvery: fe });
      const walls = sim.spec.walls.map(w => (Array.isArray(w) ? w : [w.x1, w.y1, w.x2, w.y2]));
      let steps = 0, crossings = 0, longestWalk = 0;
      const list = sim.frames.list;
      const walking = s => s === 0 || s === 4;
      for (let i = 1; i < list.length; i++) {
        const prev = new Map();
        for (let k = 0; k < list[i - 1].a.length; k += 4) prev.set(list[i - 1].a[k], [list[i - 1].a[k + 1] / 10, list[i - 1].a[k + 2] / 10, list[i - 1].a[k + 3]]);
        const a = list[i].a;
        for (let k = 0; k < a.length; k += 4) {
          const p = prev.get(a[k]);
          if (!p) continue;
          const q = [a[k + 1] / 10, a[k + 2] / 10];
          steps++;
          if (walking(p[2]) && walking(a[k + 3])) longestWalk = Math.max(longestWalk, Math.hypot(q[0] - p[0], q[1] - p[1]));
          for (const w of walls) if (crossesMidWall(p, q, w, 0.6)) crossings++;
        }
      }
      assert.ok(steps > 500, `${steps} steps`);
      assert.equal(crossings, 0, `frameEvery ${fe}: ${crossings} straight-line steps cross a wall`);
      // Walking at 8 units a minute moves at most 8 × frameEvery between frames, plus rounding.
      assert.ok(longestWalk <= 8 * fe + 0.25, `longest walking step ${longestWalk}`);
    }
  });

  test('door counts in frames between ticks include crossings already reached', () => {
    const sim = run(TWO_ROOMS);
    const total = sim.metrics().doors.find(d => d.id === 'mid').crossings;
    const last = sim.frames.list[sim.frames.list.length - 1];
    assert.equal(last.d[1], total);
    let prev = 0;
    for (const f of sim.frames.list) { assert.ok(f.d[1] >= prev); prev = f.d[1]; }
  });
});

describe('observations', () => {
  test('a visible line comes with its head count in words', () => {
    const sim = new Sim(TWO_ROOMS, { seed: 3, external: true });
    let req = null;
    for (let guard = 0; !req && guard < 2000; guard++) {
      sim.step();
      req = sim.pending().find(r => r.observation?.places?.length);
    }
    assert.ok(req, 'a decision with places was requested');
    const desk = req.observation.places.find(p => p.option === 'desk');
    assert.equal(desk.people_ahead, 'nobody in line');
  });
});

describe('CLI --frame-seconds', () => {
  let dir;
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'swarm-frames-')); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  test('records frames at the requested spacing', async () => {
    const world = join(dir, 'two-rooms.json');
    await writeFile(world, JSON.stringify(TWO_ROOMS));
    const out = join(dir, 'runs');
    const r = spawnSync(process.execPath, [BIN, 'run', world, '--provider', 'rules', '--frame-seconds', '2', '--out', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const [runId] = await readdir(out);
    const frames = JSON.parse(await readFile(join(out, runId, 'frames.json'), 'utf8'));
    assert.ok(Math.abs(frames.list[1].t - frames.list[0].t - 2 / 60) < 1e-3);
  });

  test('rejects a spacing out of range', () => {
    const r = spawnSync(process.execPath, [BIN, 'run', 'er-network', '--frame-seconds', '0'], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /--frame-seconds/);
  });
});

describe('server: run files for the scope display', () => {
  let root, srv;
  const ID = 'two-rooms-rules-s3-20261114-120000';
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarm-scope-srv-'));
    const dir = join(root, 'runs', ID);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ runId: ID, status: 'done' }));
    await writeFile(join(dir, 'decisions.jsonl'), [{ id: 'd1', agentId: 1 }, { id: 'd2', agentId: 2 }].map(d => JSON.stringify(d)).join('\n') + '\n');
    srv = await startServer({ port: 0, root });
  });
  after(async () => { await srv?.close(); await rm(root, { recursive: true, force: true }); });

  test('GET /api/runs/:id/decisions returns decisions.jsonl as an array', async () => {
    const res = await fetch(`${srv.url}/api/runs/${ID}/decisions`);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).map(d => d.id), ['d1', 'd2']);
  });

  test('GET /api/runs/:id/incidents is 404 when the run has none', async () => {
    const res = await fetch(`${srv.url}/api/runs/${ID}/incidents`);
    assert.equal(res.status, 404);
  });

  test('pages allow the Matterport tour and nothing else new', async () => {
    const res = await fetch(`${srv.url}/`);
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /frame-src https:\/\/my\.matterport\.com/);
    assert.match(csp, /script-src 'self' https:\/\/api\.matterport\.com/);
    assert.match(csp, /frame-ancestors 'none'/);
  });
});
