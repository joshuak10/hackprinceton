// Swarmscope map canvas. Draws a recorded run at any time t: the world's nodes and edges,
// queue heat or road load, interior walls and doorways, and every agent as a dot colored by
// archetype, interpolated between the two recorded frames around t without crossing a wall.
// Contract: docs/PROTOTYPE.md §7 (frames), §12b, §13d (walls) and §14d (doors).

// The engine's own wall geometry, served as /walls.js. Optional: without it the map still draws
// walls and doors, and an agent whose straight move would cross a wall holds until the next frame.
let wallsLib = null;
try { wallsLib = await import('./walls.js'); } catch { wallsLib = null; }
export const wallsLibLoaded = !!wallsLib;

const ARCH_VARS = ['--a1', '--a2', '--a3', '--a4', '--a5', '--a6'];
const S_WALK = 0, S_QUEUE = 1, S_SERVE = 2, S_THINK = 3, S_LEAVE = 4, S_DRIVE = 5;
const STRIDE = 4;            // frames.list[].a = [id, x10, y10, s, ...]
const HIT_PX = 8;            // click radius in CSS px
const PAD_X = 34, PAD_Y = 26;
const DOT = 2.8;             // agent dot size in CSS px
const SNAP_UNITS = 8;        // queued/serving agents within this many map units belong to a service
const MAX_SPIRAL = 400;      // queued dots drawn per service
const SANS = '"IBM Plex Sans", system-ui, sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, monospace';
const FIT_PAD = 24;          // CSS px kept around a floor plan fitted to the canvas
const WALL_PX = 1.6;
const DOOR_PX = 4;
const DOOR_INSET = 0.14;     // a door mark stops this fraction of the gap short of each jamb
const PAIR_CACHE = 4;        // frame pairs whose per-agent wall paths are kept
const STRAIGHT = 1;          // path cache entry: the straight move between the frames is clear

/** Map archetypeId → CSS color, cycling --a1..--a6 in spec order. Values are `var(--aN)`
 *  strings, so they work in inline HTML styles and follow theme changes; the map and the
 *  chart resolve them to concrete colors when drawing. */
export function archetypeColors(spec) {
  const out = new Map();
  (spec?.archetypes || []).forEach((a, i) => out.set(a.id, `var(${ARCH_VARS[i % ARCH_VARS.length]})`));
  return out;
}

/** What the map needs to keep agents off walls, or null when there are no walls.
 *  `walls` is [[x1, y1, x2, y2], …]; `lib` is the walls.js module (null when it didn't load).
 *  → { fast, blocked(x1, y1, x2, y2), path(x1, y1, x2, y2) → { length, points } | null, pointAlong } */
export function wallGeometry(walls, lib = wallsLib, { clearance = 0.2 } = {}) {
  if (!Array.isArray(walls) || !walls.length) return null;
  if (typeof lib?.createNav === 'function' && typeof lib.pointAlong === 'function') {
    try {
      const nav = lib.createNav(walls, { clearance });
      return {
        fast: true,
        blocked: (x1, y1, x2, y2) => nav.blocked(x1, y1, x2, y2),
        // nav.path throws rather than return a path through a wall; the dot then holds instead.
        path: (x1, y1, x2, y2) => { try { return nav.path(x1, y1, x2, y2); } catch { return null; } },
        pointAlong: lib.pointAlong
      };
    } catch { /* fall through to the hold-only geometry */ }
  }
  const cross = typeof lib?.crossesWall === 'function' ? lib.crossesWall : crossesLocal;
  return { fast: false, blocked: (x1, y1, x2, y2) => cross(walls, x1, y1, x2, y2) >= 0, path: () => null, pointAlong: null };
}

/** An agent's position at fraction u between its positions in two frames (map units). Straight when
 *  that line touches no wall; otherwise along the wall-free path between the two positions; and when
 *  there is no such path, held at the earlier position until the later frame. `cache` (a Map for this
 *  frame pair) and `key` (the agent id) keep the path, so it is found once per agent per frame pair. */
export function interpolatePosition(geo, xa, ya, xb, yb, u, cache = null, key = null) {
  const sx = xa + (xb - xa) * u, sy = ya + (yb - ya) * u;
  if (!geo || (xa === xb && ya === yb)) return { x: sx, y: sy };
  const keep = cache && key != null;
  let route = keep ? cache.get(key) : undefined;
  if (route === undefined) {
    route = geo.blocked(xa, ya, xb, yb) ? geo.path(xa, ya, xb, yb) : STRAIGHT;
    if (keep) cache.set(key, route);
  }
  if (route === STRAIGHT) return { x: sx, y: sy };
  if (!route) return { x: xa, y: ya };
  return geo.pointAlong(route.points, u * route.length);
}

export function createMap(canvas, { onAgentClick, wallsModule } = {}) {
  const lib = wallsModule === undefined ? wallsLib : wallsModule;
  let run = null;            // prepared run (see prepare)
  let lastT = 0;
  let theme = null;
  let highlight = null;      // highlighted door id
  const frameCache = new Map();   // frame index → Map(agentId → offset in .a)
  const pairCache = new Map();    // earlier frame index → Map(agentId → STRAIGHT | path | null)
  const hitXY = [];               // [x, y, x, y, ...] CSS px of drawn agents at lastT
  const hitIds = [];

  // ---------- run preparation ----------
  function setRun(next) {
    // Same frames (a theme change re-sends the run): keep the nav, the cached paths and the highlight.
    const same = !!(run && next && next.frames && next.frames === run.rawFrames);
    const geo = same ? run.geo : null;
    frameCache.clear();
    hitXY.length = 0; hitIds.length = 0;
    if (!same) { pairCache.clear(); highlight = null; }
    run = next ? prepare(next) : null;
    if (run) run.geo = same ? geo : wallGeometry(run.walls, lib, { clearance: run.clearance });
    lastT = run?.list.length ? run.list[0].t : 0;
    canvas.classList.remove('hot');
  }

  function frameIndex(i) {
    let m = frameCache.get(i);
    if (!m) {
      const a = run.list[i].a || [];
      m = new Map();
      for (let k = 0; k < a.length; k += STRIDE) m.set(a[k], k);
      frameCache.set(i, m);
      if (frameCache.size > 6) frameCache.delete(frameCache.keys().next().value);
    }
    return m;
  }

  function pairPaths(i) {
    let m = pairCache.get(i);
    if (!m) {
      m = new Map();
      pairCache.set(i, m);
      if (pairCache.size > PAIR_CACHE) pairCache.delete(pairCache.keys().next().value);
    }
    return m;
  }

  // ---------- render ----------
  function render(t) {
    if (Number.isFinite(t)) lastT = t;
    const { ctx, W, H } = fitCanvas(canvas);
    ctx.clearRect(0, 0, W, H);
    hitXY.length = 0; hitIds.length = 0;
    if (!run) return;
    theme = readTheme();
    // A floor plan keeps its proportions; a schematic world stretches to the canvas as before.
    const view = run.bounds ? fitView(run.bounds, W, H) : null;
    const X = view ? x => view.ox + x * view.s : x => PAD_X + x / 100 * (W - 2 * PAD_X);
    const Y = view ? y => view.oy + y * view.s : y => PAD_Y + y / 100 * (H - 2 * PAD_Y);
    const small = W < 520;
    const labels = [];

    drawGrid(ctx, X, Y);

    const list = run.list;
    const [i0, i1, u] = list.length ? bracket(list, lastT) : [-1, -1, 0];
    const A = i0 >= 0 ? list[i0] : null, B = i1 >= 0 ? list[i1] : null;

    // Agents first (positions only), so service fill can use who is queued and served.
    const placed = A ? placeAgents(A, B, i0, i1, u) : { free: [], perService: run.services.map(() => ({ queue: [], serving: 0 })) };

    if (run.mode === 'route') drawRoute(ctx, X, Y, A, B, u, small, labels);
    else drawVisit(ctx, X, Y, A, placed.perService, small, labels);

    if (run.walls.length) drawWalls(ctx, X, Y);
    if (run.doors.length) drawDoors(ctx, X, Y, A, B, u, labels);
    if (view && run.metersPerUnit) drawScale(ctx, view, H);

    drawAgents(ctx, X, Y, placed, view);
    for (const l of labels) label(ctx, l, W, theme.panel2);
  }

  function drawGrid(ctx, X, Y) {
    ctx.save();
    ctx.strokeStyle = theme.line; ctx.globalAlpha = 0.45; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let g = 0; g <= 100; g += 10) {
      ctx.moveTo(X(g), Y(0)); ctx.lineTo(X(g), Y(100));
      ctx.moveTo(X(0), Y(g)); ctx.lineTo(X(100), Y(g));
    }
    ctx.stroke();
    ctx.restore();
  }

  // Interpolates agent positions between frames A and B. Queued and serving agents that sit
  // at a service are handed to that service (spiral layout, utilization), the rest are free dots.
  function placeAgents(A, B, i0, i1, u) {
    const free = [];                                   // [id, x, y, s, dx, dy]
    const perService = run.services.map(() => ({ queue: [], serving: 0 }));
    const aArr = A.a || [];
    const same = i0 === i1;
    const bArr = same ? aArr : (B.a || []);
    const bIdx = same ? null : frameIndex(i1);
    const used = same ? null : new Uint8Array(Math.ceil(bArr.length / STRIDE));
    const geo = run.geo;
    const paths = geo && !same ? pairPaths(i0) : null;

    const put = (id, x, y, s, dx, dy, sx, sy) => {
      if (s === S_QUEUE || s === S_SERVE) {
        const si = nearestService(sx, sy);
        if (si >= 0) {
          if (s === S_QUEUE) perService[si].queue.push(id); else perService[si].serving++;
          return;
        }
      }
      free.push(id, x, y, s, dx, dy);
    };

    for (let k = 0; k < aArr.length; k += STRIDE) {
      const id = aArr[k];
      const xa = aArr[k + 1] / 10, ya = aArr[k + 2] / 10, sa = aArr[k + 3];
      const kb = bIdx ? bIdx.get(id) : undefined;
      if (kb === undefined) { put(id, xa, ya, sa, 0, 0, xa, ya); continue; }
      used[kb / STRIDE] = 1;
      const xb = bArr[kb + 1] / 10, yb = bArr[kb + 2] / 10, sb = bArr[kb + 3];
      const dx = xb - xa, dy = yb - ya;
      const late = u >= 0.5;
      let x, y;
      if (geo) ({ x, y } = interpolatePosition(geo, xa, ya, xb, yb, u, paths, id));
      else { x = xa + dx * u; y = ya + dy * u; }
      put(id, x, y, late ? sb : sa, dx, dy, late ? xb : xa, late ? yb : ya);
    }
    if (bIdx) {
      for (let k = 0; k < bArr.length; k += STRIDE) {
        if (used[k / STRIDE]) continue;
        const xb = bArr[k + 1] / 10, yb = bArr[k + 2] / 10;
        put(bArr[k], xb, yb, bArr[k + 3], 0, 0, xb, yb);
      }
    }
    return { free, perService };
  }

  function nearestService(x, y) {
    let best = -1, bd = SNAP_UNITS * SNAP_UNITS;
    const sv = run.services;
    for (let i = 0; i < sv.length; i++) {
      const n = sv[i].node, d = (n.x - x) ** 2 + (n.y - y) ** 2;
      if (d <= bd) { bd = d; best = i; }
    }
    return best;
  }

  // ---------- visit mode ----------
  function drawVisit(ctx, X, Y, A, perService, small, labels) {
    const svcIndex = run.serviceIndexById;
    const walled = run.walls.length > 0;      // a floor plan: smaller markers so rooms stay readable
    const gate = walled ? 4.5 : 6, rScale = walled ? 0.65 : 1;
    for (const n of run.nodes) {
      if (svcIndex.has(n.id)) continue;
      const nx = X(n.x), ny = Y(n.y);
      ctx.fillStyle = theme.ink;
      ctx.fillRect(nx - gate, ny - gate, 2 * gate, 2 * gate);
      labels.push({ text: n.name, x: nx, y: ny + (walled ? 17 : 20), weight: 600, color: theme.ink, size: small ? 10.5 : 11.5 });
    }
    run.services.forEach((s, si) => {
      const n = s.node, nx = X(n.x), ny = Y(n.y);
      const r = (7 + 9 * Math.sqrt(s.servers / run.maxServers)) * rScale;
      const qFrame = A?.q ? num(A.q[s.qi], 0) : 0;
      const qDots = perService[si].queue.length;
      const q = Math.max(qFrame, qDots);
      // Utilization: everyone serving here, and every server is busy while a line exists.
      const util = q > 0 ? 1 : Math.min(1, perService[si].serving / s.servers);
      const qPart = Math.min(1, q / (s.servers * 1.5 + 5));
      const press = Math.min(1, util * 0.6 + qPart * 0.6);
      const col = heat(press);

      ctx.fillStyle = theme.panel; ctx.strokeStyle = col; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(nx, ny, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (util > 0) {
        ctx.save();
        ctx.fillStyle = col; ctx.globalAlpha = 0.28;
        ctx.beginPath(); ctx.moveTo(nx, ny);
        ctx.arc(nx, ny, Math.max(1, r - 3), -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * util);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      s.r = r;   // spiral radius base for this render
      const drop = Math.min(18, Math.sqrt(Math.min(qDots, MAX_SPIRAL)) * 2.1);
      labels.push({ text: n.name, x: nx, y: ny + r + 14 + drop, weight: 600, color: theme.ink, size: small ? 10.5 : 11.5 });
      if (q > 0) labels.push({ text: `${Math.round(q)} in line`, x: nx, y: ny + r + 27 + drop, weight: 400, color: theme.muted, size: 10, mono: true });
    });
  }

  // ---------- route mode ----------
  function drawRoute(ctx, X, Y, A, B, u, small, labels) {
    ctx.save();
    ctx.lineCap = 'round';
    for (const e of run.edges) {
      const la = A?.load ? num(A.load[e.li], 0) : 0;
      const lb = B?.load ? num(B.load[e.li], la) : la;
      const load = la + (lb - la) * u;                       // percent of capacity
      const ratio = load / 100;
      ctx.strokeStyle = heat(ratio / 1.6);
      ctx.lineWidth = 2 + 5 * Math.sqrt(e.capacity / run.maxCap) + 3 * Math.min(1, ratio / 1.6);
      let mx, my;
      if (e.pts) {
        // The edge's shape is its polyline from → via… → to (§13a).
        const P = e.pts.map(p => [X(p.x), Y(p.y)]);
        ctx.beginPath(); ctx.moveTo(P[0][0], P[0][1]);
        for (let k = 1; k < P.length; k++) ctx.lineTo(P[k][0], P[k][1]);
        ctx.stroke();
        const mid = alongPx(P, 0.5);
        mx = mid.x; my = mid.y;
        if (e.oneWay && mid.total >= 30) { const c = alongPx(P, 0.62); chevronAt(ctx, c.x, c.y, c.ux, c.uy); }
      } else {
        const ax = X(e.a.x), ay = Y(e.a.y), bx = X(e.b.x), by = Y(e.b.y);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        if (e.oneWay) drawChevron(ctx, ax, ay, bx, by);
        mx = (ax + bx) / 2; my = (ay + by) / 2;
      }

      const pct = Math.round(load);
      if (!small && e.name) labels.push({ text: e.name, x: mx, y: my - 6, weight: 500, color: theme.muted, size: 10 });
      if (pct > 0 && (!small || pct >= 90)) {
        labels.push({ text: `${pct}%`, x: mx, y: my + (small || !e.name ? 4 : 8), weight: 500, color: ratio >= 0.9 ? heat(ratio / 1.6) : theme.muted, size: 9.5, mono: true });
      }
    }
    ctx.restore();

    for (const n of run.nodes) {
      const big = n.kind !== 'intersection', r = big ? 7 : 4;
      const nx = X(n.x), ny = Y(n.y);
      ctx.fillStyle = big ? theme.ink : theme.panel; ctx.strokeStyle = theme.ink; ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (n.kind === 'destination') ctx.rect(nx - r, ny - r, 2 * r, 2 * r);
      else ctx.arc(nx, ny, r, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      if (big || !small) labels.push({ text: n.name, x: nx, y: ny + r + 12, weight: big ? 600 : 400, color: big ? theme.ink : theme.muted, size: big ? 12 : 10.5 });
    }
  }

  function drawChevron(ctx, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    if (len < 30) return;
    chevronAt(ctx, ax + dx * 0.62, ay + dy * 0.62, dx / len, dy / len);
  }

  function chevronAt(ctx, cx, cy, ux, uy) {
    const s = 4.5;
    ctx.save();
    ctx.strokeStyle = theme.panel2; ctx.lineWidth = 1.8; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - ux * s - uy * s, cy - uy * s + ux * s);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx - ux * s + uy * s, cy - uy * s - ux * s);
    ctx.stroke();
    ctx.restore();
  }

  // ---------- walls and doors ----------
  function drawWalls(ctx, X, Y) {
    ctx.save();
    ctx.strokeStyle = theme.ink; ctx.lineWidth = WALL_PX; ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of run.walls) { ctx.moveTo(X(x1), Y(y1)); ctx.lineTo(X(x2), Y(y2)); }
    ctx.stroke();
    ctx.restore();
  }

  // Each doorway is a short thick mark across its gap, shaded calm → hot by the people who have
  // crossed it by time t, relative to the busiest door's total for the run.
  function drawDoors(ctx, X, Y, A, B, u, labels) {
    ctx.save();
    ctx.lineCap = 'butt';
    for (const door of run.doors) {
      const crossed = doorCount(A, B, u, door.di);
      const ax = X(door.x1), ay = Y(door.y1), bx = X(door.x2), by = Y(door.y2);
      const ix = (bx - ax) * DOOR_INSET, iy = (by - ay) * DOOR_INSET;
      const x1 = ax + ix, y1 = ay + iy, x2 = bx - ix, y2 = by - iy;
      const on = door.id === highlight;
      const width = on ? DOOR_PX + 2 : DOOR_PX;
      if (door.exterior) stroke(ctx, x1, y1, x2, y2, theme.ink, width + 2.5);
      stroke(ctx, x1, y1, x2, y2, heat(crossed / run.maxDoor), width);
      if (on) {
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        ctx.strokeStyle = theme.accent; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(mx, my, Math.max(9, Math.hypot(bx - ax, by - ay) / 2 + 5), 0, Math.PI * 2); ctx.stroke();
        labels.push({ text: `${door.name}: ${Math.round(crossed)} through so far`, x: mx, y: my - 14, weight: 600, color: theme.ink, size: 11 });
      }
    }
    ctx.restore();
  }

  function drawScale(ctx, view, H) {
    const pxPerM = view.s / run.metersPerUnit;
    const m = [1, 2, 5, 10, 20, 50, 100, 200, 500].find(v => v * pxPerM >= 48);
    if (!m) return;
    const len = m * pxPerM, x0 = 12, y0 = H - 9;
    ctx.save();
    ctx.strokeStyle = theme.muted; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x0, y0 - 4); ctx.lineTo(x0, y0); ctx.lineTo(x0 + len, y0); ctx.lineTo(x0 + len, y0 - 4);
    ctx.stroke();
    ctx.font = `500 10px ${MONO}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = theme.muted; ctx.fillText(`${m} m`, x0 + len + 6, y0 + 1);
    ctx.restore();
  }

  // ---------- agents ----------
  function drawAgents(ctx, X, Y, { free, perService }, view) {
    const buckets = new Map();      // resolved color → [x, y, ...]
    const rings = [];               // think state outlines
    const cs = theme.cs;
    const colorCache = new Map();
    const colorOf = id => {
      const arch = lookup(run.archOf, id);
      let c = colorCache.get(arch);
      if (c === undefined) {
        const raw = arch === undefined ? null : (run.colors.get(arch) ?? fallbackArchColor(arch));
        c = raw ? resolveColor(raw, cs) : theme.muted;
        colorCache.set(arch, c);
      }
      return c;
    };
    const emit = (id, px, py, ring) => {
      const c = colorOf(id);
      let b = buckets.get(c);
      if (!b) { b = []; buckets.set(c, b); }
      b.push(px, py);
      hitXY.push(px, py); hitIds.push(id);
      if (ring) rings.push(px, py);
    };
    // With walls, a drawing offset (jitter, thought bubble, queue slot) is kept only when the line
    // from the true position to the offset one touches no wall. Without the nav, offsets are dropped.
    const geo = run.geo;
    const walled = !!geo;
    const offsetClear = (x0, y0, x1, y1) => !!(geo?.fast && view) &&
      !geo.blocked((x0 - view.ox) / view.s, (y0 - view.oy) / view.s, (x1 - view.ox) / view.s, (y1 - view.oy) / view.s);

    for (let k = 0; k < free.length; k += 6) {
      const id = free[k], s = free[k + 3];
      const x0 = X(free[k + 1]), y0 = Y(free[k + 2]);
      let px = x0, py = y0;
      const [j1, j2] = jitter(id);
      if (s === S_THINK) {
        px += (j1 - 0.5) * 14; py -= 10 + j2 * 6;
      } else if (s === S_DRIVE) {
        // Keep to the right of the direction of travel so two-way traffic separates.
        const dxp = X(free[k + 1] + free[k + 4]) - X(free[k + 1]), dyp = Y(free[k + 2] + free[k + 5]) - Y(free[k + 2]);
        const len = Math.hypot(dxp, dyp);
        if (len > 0.5) { const off = 2.5 + j1 * 3; px -= dyp / len * off; py += dxp / len * off; }
        else { px += (j1 - 0.5) * 4; py += (j2 - 0.5) * 4; }
      } else {
        px += (j1 - 0.5) * 6; py += (j2 - 0.5) * 6;
      }
      if (walled && (px !== x0 || py !== y0) && !offsetClear(x0, y0, px, py)) { px = x0; py = y0; }
      emit(id, px, py, s === S_THINK);
    }

    run.services.forEach((s, si) => {
      const q = perService[si].queue, lim = Math.min(q.length, MAX_SPIRAL);
      if (!lim) return;
      const nx = X(s.node.x), ny = Y(s.node.y), r = s.r || 10;
      if (!walled) {
        for (let i = 0; i < lim; i++) {
          const ang = i * 2.39996 + si, rad = r + 5 + 2.1 * Math.sqrt(i);
          emit(q[i], nx + Math.cos(ang) * rad, ny + Math.sin(ang) * rad, false);
        }
        return;
      }
      // Skip spiral slots on the far side of a wall; whoever doesn't fit stands at the node.
      let i = 0;
      for (let slot = 0; i < lim && slot < lim * 3 + 24; slot++) {
        const ang = slot * 2.39996 + si, rad = r + 5 + 2.1 * Math.sqrt(slot);
        const px = nx + Math.cos(ang) * rad, py = ny + Math.sin(ang) * rad;
        if (offsetClear(nx, ny, px, py)) emit(q[i++], px, py, false);
      }
      for (; i < lim; i++) emit(q[i], nx, ny, false);
    });

    const h = DOT / 2;
    for (const [c, b] of buckets) {
      ctx.fillStyle = c;
      for (let k = 0; k < b.length; k += 2) ctx.fillRect(b[k] - h, b[k + 1] - h, DOT, DOT);
    }
    if (rings.length) {
      ctx.save();
      ctx.strokeStyle = theme.accent; ctx.lineWidth = 1.6; ctx.globalAlpha = 0.9;
      ctx.beginPath();
      for (let k = 0; k < rings.length; k += 2) { ctx.moveTo(rings[k] + 5, rings[k + 1]); ctx.arc(rings[k], rings[k + 1], 5, 0, Math.PI * 2); }
      ctx.stroke();
      ctx.restore();
    }
  }

  function fallbackArchColor(arch) {
    const i = run.archIndex.get(arch);
    return i === undefined ? null : `var(${ARCH_VARS[i % ARCH_VARS.length]})`;
  }

  // ---------- hit testing ----------
  function pick(ev) {
    const r = canvas.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    let best = -1, bd = HIT_PX * HIT_PX;
    for (let i = 0, k = 0; k < hitXY.length; i++, k += 2) {
      const d = (hitXY[k] - x) ** 2 + (hitXY[k + 1] - y) ** 2;
      if (d <= bd) { bd = d; best = i; }
    }
    return best >= 0 ? hitIds[best] : null;
  }
  function onClick(ev) {
    const id = pick(ev);
    if (id !== null && typeof onAgentClick === 'function') onAgentClick(id);
  }
  function onMove(ev) {
    canvas.classList.toggle('hot', pick(ev) !== null);
  }
  function onLeave() { canvas.classList.remove('hot'); }

  canvas.addEventListener('click', onClick);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);

  function resize() { render(lastT); }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
  ro?.observe(canvas);

  /** Rings one door (by id) and labels it with its crossings so far; null clears it. */
  function highlightDoor(id) {
    highlight = id ?? null;
    render(lastT);
  }

  function destroy() {
    canvas.removeEventListener('click', onClick);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerleave', onLeave);
    ro?.disconnect();
    canvas.classList.remove('hot');
    run = null; frameCache.clear(); pairCache.clear(); hitXY.length = 0; hitIds.length = 0;
    const { ctx, W, H } = fitCanvas(canvas);
    ctx.clearRect(0, 0, W, H);
  }

  return { setRun, render, resize, destroy, highlightDoor };
}

// ---------- helpers ----------

function prepare(run) {
  const spec = run.spec || {};
  const frames = run.frames || null;
  const mode = frames?.mode || spec.mode || 'visit';
  const rawNodes = frames?.nodes?.length ? frames.nodes : (spec.nodes || []);
  const nodes = rawNodes.map(n => ({ id: n.id, name: String(n.name ?? n.id ?? ''), kind: n.kind, x: num(n.x, 50), y: num(n.y, 50) }));
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const specNode = new Map((spec.nodes || []).map(n => [n.id, n]));

  const serviceIds = frames?.services?.length ? frames.services
    : (mode === 'visit' ? nodes.filter(n => n.kind === 'service').map(n => n.id) : []);
  const services = [];
  serviceIds.forEach((id, qi) => {
    const node = nodeById.get(id);
    if (node) services.push({ id, qi, node, servers: Math.max(1, num(specNode.get(id)?.servers, 1)), r: 0 });
  });

  const specEdge = new Map((spec.edges || []).map(e => [e.id || `${e.from}>${e.to}`, e]));
  const rawEdges = frames?.edges?.length ? frames.edges
    : (spec.edges || []).map(e => ({ id: `${e.from}>${e.to}`, name: e.name, from: e.from, to: e.to, via: e.via }));
  const edges = [];
  rawEdges.forEach((e, li) => {
    const a = nodeById.get(e.from), b = nodeById.get(e.to);
    if (!a || !b) return;
    const se = specEdge.get(e.id) || specEdge.get(`${e.from}>${e.to}`);
    const via = readVia(e.via ?? se?.via);
    edges.push({
      id: e.id, name: e.name || se?.name || '', li, a, b, capacity: Math.max(1, num(se?.capacity, 100)), oneWay: se?.twoWay === false,
      pts: via ? [a, ...via, b] : null
    });
  });

  const list = Array.isArray(frames?.list) ? frames.list : [];
  const walls = readWalls(frames?.walls ?? spec.walls);
  const doors = readDoors(frames?.doors ?? spec.doors);

  return {
    spec, mode, nodes, services, edges, list, walls, doors,
    rawFrames: frames,
    serviceIndexById: new Map(services.map((s, i) => [s.id, i])),
    maxServers: Math.max(1, ...services.map(s => s.servers)),
    maxCap: Math.max(1, ...edges.map(e => e.capacity)),
    maxDoor: doors.length ? busiestDoor(list) : 1,
    bounds: walls.length ? planBounds(walls, doors, nodes) : null,
    clearance: num(spec.geo?.clearance, 0.2),
    metersPerUnit: num(spec.geo?.metersPerUnit, 0) > 0 ? num(spec.geo.metersPerUnit, 0) : null,
    archOf: run.archetypeOf instanceof Map ? run.archetypeOf : new Map(Object.entries(run.archetypeOf || {})),
    colors: run.colors instanceof Map ? run.colors : archetypeColors(spec),
    archIndex: new Map((spec.archetypes || []).map((a, i) => [a.id, i]))
  };
}

// frames.walls is [[x1, y1, x2, y2], …]; a spec's walls may also be { x1, y1, x2, y2 } objects.
function readWalls(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const w of raw) {
    const s = Array.isArray(w) ? w.slice(0, 4).map(Number) : w && typeof w === 'object' ? [+w.x1, +w.y1, +w.x2, +w.y2] : null;
    if (s && s.length === 4 && s.every(Number.isFinite)) out.push(s);
  }
  return out;
}

// `di` is the door's index in frames.doors, which is the order of each frame's `d` array.
function readDoors(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  raw.forEach((d, di) => {
    if (!d || typeof d !== 'object') return;
    const x1 = Number(d.x1), y1 = Number(d.y1), x2 = Number(d.x2), y2 = Number(d.y2);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return;
    const id = d.id ?? `door${di}`;
    out.push({ id, name: String(d.name ?? id), x1, y1, x2, y2, exterior: !!d.exterior, di });
  });
  return out;
}

function readVia(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const pts = raw.map(p => ({ x: Number(p?.x), y: Number(p?.y) })).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  return pts.length ? pts : null;
}

// Door counts are cumulative, so the busiest door's total is the largest value in the last `d`.
function busiestDoor(list) {
  for (let i = list.length - 1; i >= 0; i--) {
    const d = list[i]?.d;
    if (Array.isArray(d)) return Math.max(1, ...d.map(v => num(v, 0)));
  }
  return 1;
}

function doorCount(A, B, u, di) {
  const a = num(A?.d?.[di], 0);
  const b = B?.d ? num(B.d[di], a) : a;
  return a + (b - a) * u;
}

function planBounds(walls, doors, nodes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x, y) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const [x1, y1, x2, y2] of walls) { add(x1, y1); add(x2, y2); }
  for (const d of doors) { add(d.x1, d.y1); add(d.x2, d.y2); }
  for (const n of nodes) add(n.x, n.y);
  return { minX, minY, maxX, maxY };
}

// Uniform scale that fits the plan's bounds inside the canvas, centered.
function fitView(b, W, H) {
  const w = Math.max(1e-6, b.maxX - b.minX), h = Math.max(1e-6, b.maxY - b.minY);
  const s = Math.max(1e-6, Math.min((W - 2 * FIT_PAD) / w, (H - 2 * FIT_PAD) / h));
  return { s, ox: (W - w * s) / 2 - b.minX * s, oy: (H - h * s) / 2 - b.minY * s };
}

// Point at fraction f of a pixel polyline [[x, y], …], with the unit direction of its piece.
function alongPx(P, f) {
  let total = 0;
  for (let k = 1; k < P.length; k++) total += Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]);
  let left = total * f;
  for (let k = 1; k < P.length; k++) {
    const dx = P[k][0] - P[k - 1][0], dy = P[k][1] - P[k - 1][1], len = Math.hypot(dx, dy);
    if (len > 0 && (left <= len || k === P.length - 1)) {
      const t = Math.min(1, left / len);
      return { x: P[k - 1][0] + dx * t, y: P[k - 1][1] + dy * t, ux: dx / len, uy: dy / len, total };
    }
    left -= len;
  }
  return { x: P[0][0], y: P[0][1], ux: 1, uy: 0, total };
}

function stroke(ctx, x1, y1, x2, y2, color, width) {
  ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
}

// Used only when /walls.js didn't load: index of the first wall the segment touches, or -1.
// Touching counts, as in engine/walls.js.
function crossesLocal(walls, ax, ay, bx, by) {
  const orient = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const near = (px, py, qx, qy, rx, ry) => {
    const dx = rx - qx, dy = ry - qy, len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - qx) * dx + (py - qy) * dy) / len2)) : 0;
    return (qx + t * dx - px) ** 2 + (qy + t * dy - py) ** 2 <= 1e-18;
  };
  for (let i = 0; i < walls.length; i++) {
    const [cx, cy, dx, dy] = walls[i];
    const o1 = orient(cx, cy, dx, dy, ax, ay), o2 = orient(cx, cy, dx, dy, bx, by);
    const o3 = orient(ax, ay, bx, by, cx, cy), o4 = orient(ax, ay, bx, by, dx, dy);
    if ((o1 > 0 ? o2 < 0 : o1 < 0 && o2 > 0) && (o3 > 0 ? o4 < 0 : o3 < 0 && o4 > 0)) return i;
    if (near(ax, ay, cx, cy, dx, dy) || near(bx, by, cx, cy, dx, dy) || near(cx, cy, ax, ay, bx, by) || near(dx, dy, ax, ay, bx, by)) return i;
  }
  return -1;
}

// Frames index around t: [i0, i1, u] with list[i0].t <= t <= list[i1].t and u in [0, 1].
function bracket(list, t) {
  const last = list.length - 1;
  if (!(t > list[0].t)) return [0, 0, 0];
  if (t >= list[last].t) return [last, last, 0];
  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t <= t) lo = mid; else hi = mid;
  }
  const span = list[hi].t - list[lo].t;
  return [lo, hi, span > 0 ? (t - list[lo].t) / span : 0];
}

function lookup(map, id) {
  let v = map.get(id);
  if (v === undefined) v = map.get(typeof id === 'number' ? String(id) : Number(id));
  return v;
}

// Deterministic per-agent jitter in [0, 1) x2, so dots on the same path spread out.
function jitter(id) {
  let h = 2166136261;
  const s = String(id);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return [((h >>> 0) % 1000) / 1000, ((h >>> 10) % 997) / 997];
}

function num(v, fb) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

function fitCanvas(canvas) {
  const r = canvas.getBoundingClientRect();
  const d = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(d, 0, 0, d, 0, 0);
  return { ctx, W: r.width, H: r.height };
}

let heatStops = [[154, 174, 188], [224, 159, 53], [207, 64, 56]];

function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const g = (k, fb) => cs.getPropertyValue(k).trim() || fb;
  heatStops = [parseColor(g('--heat0', '#9AAEBC')), parseColor(g('--heat1', '#E09F35')), parseColor(g('--heat2', '#CF4038'))];
  return {
    cs,
    ink: g('--ink', '#142029'), muted: g('--muted', '#566572'), line: g('--line', '#D2DBE2'),
    panel: g('--panel', '#FFFFFF'), panel2: g('--panel-2', '#F4F7F9'), accent: g('--accent', '#0B7A75')
  };
}

// heat0 → heat1 over [0, 0.55], heat1 → heat2 over [0.55, 1] (the prototype's ramp).
function heat(x) {
  x = Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
  const [a, b, c] = heatStops;
  const [p, q, t] = x < 0.55 ? [a, b, x / 0.55] : [b, c, (x - 0.55) / 0.45];
  return `rgb(${Math.round(p[0] + (q[0] - p[0]) * t)},${Math.round(p[1] + (q[1] - p[1]) * t)},${Math.round(p[2] + (q[2] - p[2]) * t)})`;
}

function parseColor(c) {
  const s = String(c).trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map(ch => ch + ch).join('');
    const n = parseInt(h.slice(0, 6), 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (m) return [+m[1], +m[2], +m[3]];
  return [136, 136, 136];
}

function resolveColor(c, cs) {
  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(String(c).trim());
  if (!m) return c;
  return cs.getPropertyValue(m[1]).trim() || (m[2] || '').trim() || '#888888';
}

function label(ctx, { text, x, y, weight, color, size, mono }, W, halo) {
  if (!text) return;
  ctx.font = `${weight} ${size}px ${mono ? MONO : SANS}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  const w = ctx.measureText(text).width;
  x = Math.max(w / 2 + 3, Math.min(W - w / 2 - 3, x));
  ctx.lineWidth = 3; ctx.lineJoin = 'round';
  ctx.strokeStyle = halo; ctx.strokeText(text, x, y);
  ctx.fillStyle = color; ctx.fillText(text, x, y);
}
