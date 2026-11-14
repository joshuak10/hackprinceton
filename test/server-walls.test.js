// Walls in the viewer (docs/PROTOTYPE.md §13d, §14d): the server serves engine/walls.js at /walls.js,
// and web/map.js draws walls and doors and never moves a dot through a wall. The map runs against
// a stub canvas and hand-made frames; the floor plan below is fictional.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/server.js';
import * as wallsLib from '../engine/walls.js';

// ---------- browser stand-ins for map.js ----------

const THEME = {
  '--ink': '#142029', '--muted': '#566572', '--line': '#D2DBE2', '--panel': '#FFFFFF', '--panel-2': '#F4F7F9',
  '--accent': '#0B7A75', '--heat0': '#9AAEBC', '--heat1': '#E09F35', '--heat2': '#CF4038',
  '--a1': '#3567D6', '--a2': '#C23F7E', '--a3': '#1F9A7A', '--a4': '#7A55C8', '--a5': '#B7791F', '--a6': '#4B5563'
};
globalThis.window = { devicePixelRatio: 1 };
globalThis.document = { documentElement: {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: k => THEME[k] ?? '' });

const { createMap, interpolatePosition, wallGeometry } = await import('../web/map.js');

const HEAT0 = 'rgb(154,174,188)', HEAT2 = 'rgb(207,64,56)';
const WALL_PX = 1.6, DOOR_PX = 4, DOT = 2.8;

// A 2d context that records strokes (with their path), filled rects and text.
function stubCanvas(W = 800, H = 550) {
  const ops = [];
  let path = [];
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, lineCap: 'butt', lineJoin: 'miter',
    font: '', textAlign: 'start', textBaseline: 'alphabetic',
    save() {}, restore() {}, setTransform() {}, clearRect() {}, closePath() {}, fill() {}, strokeText() {},
    beginPath() { path = []; },
    moveTo(x, y) { path.push(['M', x, y]); },
    lineTo(x, y) { path.push(['L', x, y]); },
    arc(x, y, r) { path.push(['A', x, y, r]); },
    rect(x, y, w, h) { path.push(['R', x, y, w, h]); },
    stroke() { ops.push({ op: 'stroke', style: this.strokeStyle, width: this.lineWidth, path: path.slice() }); },
    fillRect(x, y, w, h) { ops.push({ op: 'fillRect', style: this.fillStyle, x, y, w, h }); },
    fillText(text, x, y) { ops.push({ op: 'text', text, x, y }); },
    measureText: s => ({ width: String(s).length * 6 })
  };
  const canvas = {
    width: 0, height: 0, ops,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }),
    getContext: () => ctx,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, removeEventListener() {}
  };
  return canvas;
}

// ---------- a fictional floor plan ----------
// Box 10..90. A dividing wall at x = 50 with an interior doorway at y 45..55, and an
// exterior doorway in the west wall at y 45..55.

const WALLS = [
  [10, 10, 90, 10], [90, 10, 90, 90], [90, 90, 10, 90],
  [10, 10, 10, 45], [10, 55, 10, 90],
  [50, 10, 50, 45], [50, 55, 50, 90]
];
const DOORS = [
  { id: 'd_mid', name: 'Hall door', x1: 50, y1: 45, x2: 50, y2: 55, exterior: false },
  { id: 'd_main', name: 'Main entrance', x1: 10, y1: 45, x2: 10, y2: 55, exterior: true }
];
const SPEC = {
  title: 'Test Arcade', mode: 'visit',
  nodes: [
    { id: 'gate', name: 'Entrance', kind: 'gate', x: 12, y: 50 },
    { id: 'cafe', name: 'Cafe', kind: 'service', x: 30, y: 30, servers: 2 },
    { id: 'shop', name: 'Shop', kind: 'service', x: 70, y: 30, servers: 1 }
  ],
  archetypes: [{ id: 'shoppers', name: 'Shoppers' }, { id: 'staff', name: 'Staff' }],
  geo: { metersPerUnit: 0.8, clearance: 0.4 },
  walls: WALLS, doors: DOORS
};
// Agent 1 walks from the cafe room (30, 20) to the shop room (70, 20): the straight line hits the
// x = 50 wall, so the map must route it through the doorway. Agent 2 stays in the west room.
const FRAMES = {
  mode: 'visit',
  nodes: SPEC.nodes.map(({ id, name, kind, x, y }) => ({ id, name, kind, x, y })),
  services: ['cafe', 'shop'],
  walls: WALLS,
  doors: DOORS,
  list: [
    { t: 0, a: [1, 300, 200, 0, 2, 200, 700, 0], q: [0, 0], load: null, c: { active: 2, served: 0, abandoned: 0, arrived: 2 }, d: [0, 0] },
    { t: 1, a: [1, 700, 200, 0, 2, 250, 700, 0], q: [0, 0], load: null, c: { active: 2, served: 0, abandoned: 0, arrived: 2 }, d: [1, 2] },
    { t: 2, a: [1, 700, 250, 0, 2, 300, 700, 0], q: [0, 0], load: null, c: { active: 2, served: 0, abandoned: 0, arrived: 2 }, d: [3, 2] },
    { t: 3, a: [1, 700, 300, 0], q: [0, 0], load: null, c: { active: 1, served: 0, abandoned: 0, arrived: 2 }, d: [6, 4] }
  ]
};
const RUN = {
  spec: SPEC, frames: FRAMES,
  archetypeOf: new Map([[1, 'shoppers'], [2, 'staff']]),
  colors: new Map([['shoppers', 'var(--a1)'], ['staff', 'var(--a2)']])
};

const touchesWall = (x, y) => wallsLib.crossesWall(WALLS, x, y, x, y) >= 0;
const strokes = ops => ops.filter(o => o.op === 'stroke');
const lineStroke = o => o.path.length === 2 && o.path[0][0] === 'M' && o.path[1][0] === 'L';

// ---------- server ----------

describe('server serves engine/walls.js at /walls.js', () => {
  const STAND_IN = '// stand-in for engine/walls.js\nexport const standIn = true;\n';
  let root, bare, srv, bareSrv;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarm-walls-'));
    await mkdir(join(root, 'engine'));
    await writeFile(join(root, 'engine', 'walls.js'), STAND_IN);
    bare = await mkdtemp(join(tmpdir(), 'swarm-walls-bare-'));
    srv = await startServer({ port: 0, root });
    bareSrv = await startServer({ port: 0, root: bare });
  });
  after(async () => {
    await srv?.close();
    await bareSrv?.close();
    await rm(root, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  });

  test("GET /walls.js returns the root's engine/walls.js as JavaScript", async () => {
    const res = await fetch(`${srv.url}/walls.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/javascript\b/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await res.text(), STAND_IN);
  });

  test('HEAD answers with the headers only; other methods are refused', async () => {
    const head = await fetch(`${srv.url}/walls.js`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.match(head.headers.get('content-type'), /javascript/);
    assert.equal(await head.text(), '');
    const post = await fetch(`${srv.url}/walls.js`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(post.status, 405);
  });

  test("a root without engine/walls.js gets the server's own copy", async () => {
    const own = fileURLToPath(new URL('../engine/walls.js', import.meta.url));
    const res = await fetch(`${bareSrv.url}/walls.js`);
    if (existsSync(own)) {
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /^text\/javascript\b/);
      assert.equal(await res.text(), await readFile(own, 'utf8'));
    } else {
      assert.equal(res.status, 404);
    }
  });

  test('the rest of the static viewer is unchanged', async () => {
    const res = await fetch(`${srv.url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    const missing = await fetch(`${srv.url}/nope.js`);
    assert.equal(missing.status, 404);
  });
});

// ---------- interpolation helper ----------

describe('interpolatePosition keeps dots off walls', () => {
  const geo = wallGeometry(WALLS, wallsLib, { clearance: 0.4 });

  test('no walls: plain straight-line interpolation', () => {
    assert.equal(wallGeometry([], wallsLib), null);
    assert.equal(wallGeometry(undefined, wallsLib), null);
    assert.deepEqual(interpolatePosition(null, 0, 0, 10, 20, 0.25), { x: 2.5, y: 5 });
  });

  test('a clear move stays straight', () => {
    assert.equal(geo.fast, true);
    const p = interpolatePosition(geo, 20, 20, 40, 30, 0.5);
    assert.deepEqual(p, { x: 30, y: 25 });
  });

  test('positions on opposite sides of a wall go through the doorway, never through the wall', () => {
    const [xa, ya, xb, yb] = [30, 20, 70, 20];
    assert.ok(wallsLib.crossesWall(WALLS, xa, ya, xb, yb) >= 0, 'fixture: the straight line must hit a wall');
    const cache = new Map();
    const pts = [];
    for (let i = 0; i <= 200; i++) pts.push(interpolatePosition(geo, xa, ya, xb, yb, i / 200, cache, 1));
    assert.deepEqual(pts[0], { x: xa, y: ya });
    assert.ok(Math.hypot(pts[200].x - xb, pts[200].y - yb) < 1e-9, 'ends at the later position');
    for (let i = 0; i < pts.length; i++) {
      assert.ok(!touchesWall(pts[i].x, pts[i].y), `position ${i} (${pts[i].x}, ${pts[i].y}) is on a wall`);
      if (i) {
        const hit = wallsLib.crossesWall(WALLS, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y);
        assert.equal(hit, -1, `step ${i - 1} → ${i} crosses wall ${hit}`);
      }
    }
    const i = pts.findIndex((p, k) => k > 0 && pts[k - 1].x < 50 && p.x >= 50);
    assert.ok(i > 0, 'reaches the east room');
    const a = pts[i - 1], b = pts[i];
    const yAt50 = a.y + (b.y - a.y) * (50 - a.x) / (b.x - a.x);
    assert.ok(yAt50 > 45 && yAt50 < 55, `crosses x = 50 at y = ${yAt50}, inside the doorway gap`);
  });

  test('the path is found once per agent per frame pair', () => {
    let calls = 0;
    const counted = { ...geo, path: (...a) => { calls++; return geo.path(...a); } };
    const cache = new Map();
    for (let i = 0; i <= 20; i++) interpolatePosition(counted, 30, 20, 70, 20, i / 20, cache, 7);
    assert.equal(calls, 1);
    interpolatePosition(counted, 30, 20, 70, 20, 0.5, cache, 8);
    assert.equal(calls, 2, 'another agent gets its own path');
  });

  test('no wall-free path: hold the earlier position until the later frame', () => {
    const sealed = [...WALLS, [50, 45, 50, 55]];
    const g = wallGeometry(sealed, wallsLib, { clearance: 0.4 });
    for (const u of [0, 0.3, 0.5, 0.99]) assert.deepEqual(interpolatePosition(g, 30, 20, 70, 20, u), { x: 30, y: 20 });
  });

  test('without walls.js the map still never draws a move through a wall', () => {
    const g = wallGeometry(WALLS, null);
    assert.equal(g.fast, false);
    assert.deepEqual(interpolatePosition(g, 30, 20, 70, 20, 0.6), { x: 30, y: 20 });
    assert.deepEqual(interpolatePosition(g, 20, 20, 40, 30, 0.5), { x: 30, y: 25 });
    // Touching a wall's end counts as crossing, as in engine/walls.js.
    assert.deepEqual(interpolatePosition(g, 40, 45, 60, 45, 0.5), { x: 40, y: 45 });
  });
});

// ---------- rendering ----------

describe('map.js renders walls, doors and agents', () => {
  test('renders at many times without throwing, walls in the ink color', () => {
    const canvas = stubCanvas();
    const map = createMap(canvas, { wallsModule: wallsLib });
    map.setRun(RUN);
    for (const t of [0, 0.25, 0.5, 1, 1.5, 2.2, 3, 4, -1]) map.render(t);
    const wallStrokes = strokes(canvas.ops).filter(o => o.width === WALL_PX);
    assert.ok(wallStrokes.length > 0);
    for (const o of wallStrokes) {
      assert.equal(o.style, THEME['--ink']);
      assert.equal(o.path.length, WALLS.length * 2, 'every wall segment drawn');
    }
    map.destroy();
  });

  test('doors are shaded calm → hot by crossings so far, and entrances get an ink outline', () => {
    const doorStrokes = t => {
      const canvas = stubCanvas();
      const map = createMap(canvas, { wallsModule: wallsLib });
      map.setRun(RUN);
      canvas.ops.length = 0;
      map.render(t);
      return strokes(canvas.ops).filter(lineStroke);
    };
    const start = doorStrokes(0).filter(o => o.width === DOOR_PX);
    assert.deepEqual(start.map(o => o.style), [HEAT0, HEAT0], 'nobody has crossed yet');
    const end = doorStrokes(3);
    const heatEnd = end.filter(o => o.width === DOOR_PX);
    assert.equal(heatEnd[0].style, HEAT2, 'the busiest door (6 crossings) is hot');
    assert.notEqual(heatEnd[1].style, HEAT0);
    assert.notEqual(heatEnd[1].style, HEAT2);
    const outlines = end.filter(o => o.width > DOOR_PX);
    assert.equal(outlines.length, 1, 'only the exterior door has an outline');
    assert.equal(outlines[0].style, THEME['--ink']);
    // Interpolated between frames: halfway from t = 1 (1 crossing) to t = 2 (3) is 2 of 6.
    const mid = doorStrokes(1.5).filter(o => o.width === DOOR_PX)[0].style;
    const third = doorStrokes(2).filter(o => o.width === DOOR_PX)[0].style;
    assert.notEqual(mid, HEAT0);
    assert.notEqual(mid, third);
  });

  test('highlightDoor rings the door and labels its crossings', () => {
    const canvas = stubCanvas();
    const map = createMap(canvas, { wallsModule: wallsLib });
    map.setRun(RUN);
    map.render(3);
    canvas.ops.length = 0;
    map.highlightDoor('d_main');
    const ring = strokes(canvas.ops).find(o => o.style === THEME['--accent'] && o.path[0]?.[0] === 'A');
    assert.ok(ring, 'an accent ring around the door');
    assert.ok(canvas.ops.some(o => o.op === 'text' && o.text === 'Main entrance: 4 through so far'));
    // A theme change re-sends the same frames: the highlight survives. A new run clears it.
    map.setRun({ ...RUN });
    canvas.ops.length = 0;
    map.render(3);
    assert.ok(canvas.ops.some(o => o.op === 'text' && o.text.startsWith('Main entrance:')));
    map.setRun({ ...RUN, frames: { ...FRAMES } });
    canvas.ops.length = 0;
    map.render(3);
    assert.ok(!canvas.ops.some(o => o.op === 'text' && o.text.startsWith('Main entrance:')));
    map.highlightDoor(null);
  });

  test('a dot crossing between rooms is never drawn across a wall', () => {
    const canvas = stubCanvas();
    const map = createMap(canvas, { wallsModule: wallsLib });
    map.setRun(RUN);
    map.render(0);
    // Recover the map's uniform px transform from the drawn wall endpoints.
    const wallPath = strokes(canvas.ops).find(o => o.width === WALL_PX).path;
    const pxX = wallPath.map(p => p[1]), pxY = wallPath.map(p => p[2]);
    const s = (Math.max(...pxX) - Math.min(...pxX)) / 80;
    assert.ok(Math.abs((Math.max(...pxY) - Math.min(...pxY)) / 80 - s) < 1e-9, 'a floor plan keeps its proportions');
    const ox = Math.min(...pxX) - 10 * s, oy = Math.min(...pxY) - 10 * s;

    const geo = wallGeometry(WALLS, wallsLib, { clearance: 0.4 });
    const agentColor = THEME['--a1'];
    let checked = 0;
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;   // agent 1 moves from (30, 20) to (70, 20) between t = 0 and t = 1
      canvas.ops.length = 0;
      map.render(t);
      const dots = canvas.ops.filter(o => o.op === 'fillRect' && o.w === DOT && o.style === agentColor);
      assert.equal(dots.length, 1);
      const dx = (dots[0].x + DOT / 2 - ox) / s, dy = (dots[0].y + DOT / 2 - oy) / s;
      assert.ok(!touchesWall(dx, dy), `t=${t}: dot (${dx}, ${dy}) is on a wall`);
      const expected = interpolatePosition(geo, 30, 20, 70, 20, t);
      assert.ok(Math.hypot(dx - expected.x, dy - expected.y) < 0.6, `t=${t}: dot is near the helper's position`);
      assert.equal(wallsLib.crossesWall(WALLS, expected.x, expected.y, dx, dy), -1, `t=${t}: jitter put the dot across a wall`);
      checked++;
    }
    assert.equal(checked, 41);
  });

  test('a run without walls or doors draws neither, and interpolates straight', () => {
    const canvas = stubCanvas();
    const map = createMap(canvas, { wallsModule: wallsLib });
    const { walls, doors, geo, ...spec } = SPEC;
    const frames = { ...FRAMES, walls: undefined, doors: undefined, list: FRAMES.list.map(({ d, ...f }) => f) };
    map.setRun({ ...RUN, spec, frames });
    for (const t of [0, 0.5, 1.5, 3]) map.render(t);
    assert.ok(!strokes(canvas.ops).some(o => o.width === WALL_PX || o.width === DOOR_PX + 2.5));
    assert.ok(!strokes(canvas.ops).some(o => lineStroke(o) && o.width === DOOR_PX));
    // Halfway from (30, 20) to (70, 20) is (50, 20) in the stretched 0–100 layout: x = 34 + 50 × 7.32.
    canvas.ops.length = 0;
    map.render(0.5);
    const dot = canvas.ops.find(o => o.op === 'fillRect' && o.w === DOT && o.style === THEME['--a1']);
    assert.ok(Math.abs(dot.x + DOT / 2 - (34 + 50 * 7.32)) <= 3.01, 'straight through, plus at most 3 px of jitter');
  });

  test('route edges with via are drawn as polylines', () => {
    const canvas = stubCanvas();
    const map = createMap(canvas, { wallsModule: wallsLib });
    const spec = {
      title: 'Bent road', mode: 'route',
      nodes: [{ id: 'a', name: 'A', kind: 'origin', x: 10, y: 50 }, { id: 'b', name: 'B', kind: 'destination', x: 90, y: 50 }],
      edges: [{ from: 'a', to: 'b', name: 'Bent Rd', capacity: 100, twoWay: false }]
    };
    const frames = {
      mode: 'route', nodes: spec.nodes,
      edges: [{ id: 'a>b', name: 'Bent Rd', from: 'a', to: 'b', via: [{ x: 50, y: 20 }] }],
      list: [{ t: 0, a: [], q: null, load: [40], c: { active: 0, served: 0, abandoned: 0, arrived: 0 } }]
    };
    map.setRun({ spec, frames, archetypeOf: new Map(), colors: new Map() });
    map.render(0);
    const road = strokes(canvas.ops).find(o => o.path.length === 3 && o.path[0][0] === 'M');
    assert.ok(road, 'one stroke through three points');
    const [, vx, vy] = road.path[1];
    assert.ok(Math.abs(vx - (34 + 50 * 7.32)) < 1e-9 && Math.abs(vy - (26 + 20 * 4.98)) < 1e-9, 'bends at the via point');
    assert.ok(canvas.ops.some(o => o.op === 'text' && o.text === 'Bent Rd'));
  });
});
