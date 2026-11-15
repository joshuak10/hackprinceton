// Map canvas: plan base layer (cached per floor and view), heat, people, incidents, selection.
import { agentsAt, agentTrail, heldAt } from './frames.js';
import { heatCanvas } from './heat.js';
import { readPalette } from './palette.js';
export { readPalette } from './palette.js';

const STATE_VAR = ['--a-walk', '--a-queue', '--a-serve', '--a-think', '--a-leave', '--a-car'];
// Calm to furious. No red: red means people lost, and nothing else (§9b).
export const FRUSTRATION = ['#5b9bd5', '#8f7be0', '#d9a514', '#e07b2a', '#a8430a'];

function unrle(text, size) {
  const data = new Uint8Array(size);
  let at = 0, v = 0;
  for (const tok of String(text).split(',')) {
    const n = parseInt(tok, 10) || 0;
    if (v) data.fill(1, at, Math.min(size, at + n));
    at += n; v ^= 1;
  }
  return data;
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const R = {
    canvas, ctx, dpr: 1, cw: 0, ch: 0,
    view: { x: 50, y: 30, z: 1 }, fit: 1,
    base: null, baseKey: '', obstacleCache: new Map(), lastAgents: [], pal: null
  };

  R.resize = () => {
    const r = canvas.getBoundingClientRect();
    R.dpr = Math.min(2, window.devicePixelRatio || 1);
    R.cw = Math.max(1, Math.round(r.width));
    R.ch = Math.max(1, Math.round(r.height));
    canvas.width = Math.round(R.cw * R.dpr);
    canvas.height = Math.round(R.ch * R.dpr);
    R.baseKey = '';
  };

  // Padding keeps the plan clear of the View button (top) and the legend (bottom).
  R.pad = { top: 44, bottom: 40, side: 20 };
  // bounds = [x0, y0, x1, y1] in map units; the view fits that box, wherever it starts.
  R.setBounds = (bounds) => {
    const [x0, y0, x1, y1] = bounds;
    R.W = x1 - x0; R.H = y1 - y0;
    R.home = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    R.refit();
    R.view = { ...R.home, z: 1 };
    R.baseKey = '';
  };
  R.refit = () => {
    if (R.W) R.fit = Math.min((R.cw - 2 * R.pad.side) / R.W, (R.ch - R.pad.top - R.pad.bottom) / R.H);
    R.baseKey = '';
  };

  const S = () => R.fit * R.view.z;
  const cy = () => (R.pad.top + R.ch - R.pad.bottom) / 2;
  R.toScreen = (x, y) => [R.cw / 2 + (x - R.view.x) * S(), cy() + (y - R.view.y) * S()];
  R.toMap = (sx, sy) => [(sx - R.cw / 2) / S() + R.view.x, (sy - cy()) / S() + R.view.y];
  R.scale = S;

  // ---------- base layer ----------
  function obstacleMask(floor, fi) {
    const key = fi + ':' + (floor.obstacles?.rle?.length || 0);
    if (R.obstacleCache.has(key)) return R.obstacleCache.get(key);
    const o = floor.obstacles;
    if (!o) { R.obstacleCache.set(key, null); return null; }
    const data = unrle(o.rle, o.w * o.h);
    const c = document.createElement('canvas');
    c.width = o.w; c.height = o.h;
    const cx = c.getContext('2d');
    const img = cx.createImageData(o.w, o.h);
    for (let i = 0; i < data.length; i++) if (data[i]) img.data[i * 4 + 3] = 255;
    cx.putImageData(img, 0, 0);
    const out = { canvas: c, o };
    R.obstacleCache.set(key, out);
    return out;
  }

  const fillCache = new WeakMap();
  function fillMask(fill) {
    if (fillCache.has(fill)) return fillCache.get(fill);
    const c = document.createElement('canvas');
    c.width = fill.w; c.height = fill.h;
    const cx = c.getContext('2d');
    const img = cx.createImageData(fill.w, fill.h);
    for (let i = 0; i < fill.data.length; i++) if (fill.data[i]) img.data[i * 4 + 3] = 255;
    cx.putImageData(img, 0, 0);
    fillCache.set(fill, c);
    return c;
  }

  function hatchPattern(target, color) {
    const p = document.createElement('canvas');
    p.width = p.height = Math.round(7 * R.dpr);
    const c = p.getContext('2d');
    c.strokeStyle = color;
    c.lineWidth = 1 * R.dpr;
    c.beginPath();
    c.moveTo(0, p.height); c.lineTo(p.width, 0);
    c.stroke();
    return target.createPattern(p, 'repeat');
  }

  function buildBase(st) {
    const pal = R.pal;
    const c = document.createElement('canvas');
    c.width = canvas.width; c.height = canvas.height;
    const g = c.getContext('2d');
    g.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
    g.fillStyle = pal.ground;
    g.fillRect(0, 0, R.cw, R.ch);
    const geo = st.geometry;
    if (geo.kind === 'lot') drawLotBase(g, geo, st, pal);
    else drawInteriorBase(g, geo, st, pal);
    return c;
  }

  function drawInteriorBase(g, geo, st, pal) {
    const floor = geo.floors[st.floor];
    const s = S();
    // Rooms
    g.fillStyle = pal.room;
    for (const r of floor.rooms) {
      g.beginPath();
      for (const ring of [r.poly, ...(r.holes || [])]) {
        ring.forEach(([x, y], i) => { const [sx, sy] = R.toScreen(x, y); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); });
        g.closePath();
      }
      g.fill('evenodd');
    }
    // Floor fill for runs without room outlines (engine runs): a raster flooded from the counters.
    if (floor.fill) {
      const fm = fillMask(floor.fill);
      const tmp = document.createElement('canvas');
      tmp.width = canvas.width; tmp.height = canvas.height;
      const t = tmp.getContext('2d');
      t.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
      t.imageSmoothingEnabled = false;
      const [fx, fy] = R.toScreen(floor.fill.origin[0], floor.fill.origin[1]);
      t.drawImage(fm, fx, fy, floor.fill.w * floor.fill.cell * s, floor.fill.h * floor.fill.cell * s);
      t.globalCompositeOperation = 'source-in';
      t.fillStyle = pal.room;
      t.fillRect(0, 0, R.cw, R.ch);
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(tmp, 0, 0);
      g.restore();
    }
    // Mesh obstacles: raster mask in the mesh colour, hatched.
    const om = obstacleMask(floor, st.floor);
    if (om) {
      const tmp = document.createElement('canvas');
      tmp.width = canvas.width; tmp.height = canvas.height;
      const t = tmp.getContext('2d');
      t.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
      t.imageSmoothingEnabled = false;
      const [sx, sy] = R.toScreen(om.o.origin[0], om.o.origin[1]);
      t.drawImage(om.canvas, sx, sy, om.o.w * om.o.cell * s, om.o.h * om.o.cell * s);
      t.globalCompositeOperation = 'source-in';
      t.fillStyle = pal.mesh;
      t.fillRect(0, 0, R.cw, R.ch);
      t.globalCompositeOperation = 'source-atop';
      t.setTransform(1, 0, 0, 1, 0, 0);
      t.fillStyle = hatchPattern(t, pal.hatch);
      t.fillRect(0, 0, tmp.width, tmp.height);
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(tmp, 0, 0);
      g.restore();
    }
    // Walls
    g.strokeStyle = pal.wall;
    g.lineCap = 'square';
    for (const [x1, y1, x2, y2, th] of floor.walls) {
      const [a, b] = R.toScreen(x1, y1), [c, d] = R.toScreen(x2, y2);
      g.lineWidth = Math.max(1.6, th * s);
      g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.stroke();
    }
    // Openings: door jambs, entries marked outside.
    for (const o of floor.openings || []) {
      if (o.side === 'none') continue;
      const ux = Math.cos(o.angle), uy = Math.sin(o.angle), nx = -uy, ny = ux;
      const half = o.width / 2, jamb = (o.thickness || 0.3) / 2 + 3 / s;
      g.lineWidth = 1.4;
      g.strokeStyle = pal.wall;
      for (const sgn of [-1, 1]) {
        const ex = o.x + ux * half * sgn, ey = o.y + uy * half * sgn;
        const [a, b] = R.toScreen(ex - nx * jamb, ey - ny * jamb), [c, d] = R.toScreen(ex + nx * jamb, ey + ny * jamb);
        g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.stroke();
      }
    }
    // Doors and stairs: a faint dot only. Their names show on hover (drawPlaces). Rooms are not labelled.
    g.fillStyle = pal.faint;
    for (const n of st.nodes) {
      if ((n.floor || 0) !== st.floor || n.kind !== 'entry') continue;
      const [sx, sy] = R.toScreen(n.x, n.y);
      g.beginPath(); g.arc(sx, sy, 2.5, 0, Math.PI * 2); g.fill();
    }
    // Seats (§18): a small chair at every seat, drawn whether or not someone is sitting on it. In edit mode the
    // seats are drawn each frame instead, so they can be dragged.
    if (!st.edit) drawSeats(g, st.nodes.filter(n => (n.floor || 0) === st.floor).flatMap(n => (n.seats || []).map(seatXY)), pal, geo.metersPerUnit || 1, false);
  }

  // Counters, drawn above the people so their names stay readable: a diamond and the name. The counter under
  // test (st.ringNode) gets a ring and a heavier name. The door or stairs under the pointer shows its name.
  // A place with seats (§18) is named at its seats, with no diamond; a solid room nobody enters (a kitchen) is
  // named in its middle, first, so the other names keep clear of it.
  function drawPlaces(st, pal) {
    placed.length = 0;
    const floor = st.geometry.floors[st.floor];
    const ring = st.nodes.find(n => n.id === st.ringNode && (n.floor || 0) === st.floor);
    const spots = (sx, sy, d) => [[sx, sy + d, 'center'], [sx, sy - d, 'center'], [sx + d - 4, sy, 'left'], [sx - d + 4, sy, 'right']];
    if (st.layers.labels) {
      for (const o of floor.objects || []) {
        if (o.kind !== 'room' || !o.name || !o.polygon?.length) continue;
        const xs = o.polygon.map(q => q[0]), ys = o.polygon.map(q => q[1]);
        const [sx, sy] = R.toScreen((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2);
        labelFree(ctx, o.name, [[sx, sy, 'center']], pal, 15, { weight: 500, color: pal.muted, halo: pal.room });
      }
    }
    if (ring) {
      const [sx, sy] = R.toScreen(ring.x, ring.y);
      ctx.strokeStyle = pal.room;
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(sx, sy, 17, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = pal.text;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, 17, 0, Math.PI * 2); ctx.stroke();
      // The ringed counter's name is placed first, so it always gets a spot.
      if (st.layers.labels) labelFree(ctx, ring.name, spots(sx, sy, 30), pal, 13, { weight: 600, color: pal.text, halo: pal.room });
    }
    for (const n of st.nodes) {
      if ((n.floor || 0) !== st.floor || n.kind !== 'service') continue;
      const [sx, sy] = R.toScreen(n.x, n.y);
      if (n.seats?.length) {
        // Seats move while editing; the seat tags and the edit panel name the place then.
        if (!st.layers.labels || st.edit) continue;
        const [ax, ay] = R.toScreen(...seatLabelSpot(n));
        labelFree(ctx, n.name, [[ax, ay, 'center'], [ax, ay + 16, 'center'], [ax, ay - 16, 'center'], [sx, sy + 15, 'center']], pal, 13, { weight: 500, color: pal.label, halo: pal.room });
        continue;
      }
      ctx.fillStyle = n === ring ? pal.text : pal.label;
      ctx.beginPath(); ctx.moveTo(sx, sy - 5); ctx.lineTo(sx + 5, sy); ctx.lineTo(sx, sy + 5); ctx.lineTo(sx - 5, sy); ctx.closePath(); ctx.fill();
      // Below, above, right, left; skipped if all would overlap (the side panel names every place).
      if (st.layers.labels && n !== ring) labelFree(ctx, n.name, spots(sx, sy, 16), pal, 13, { weight: 500, color: pal.label, halo: pal.room });
    }
    const hover = st.nodes.find(n => n.id === st.hoverNode && (n.floor || 0) === st.floor && n.kind === 'entry');
    if (hover) {
      const [sx, sy] = R.toScreen(hover.x, hover.y);
      const left = sx > R.cw / 2;
      ctx.fillStyle = pal.text;
      ctx.beginPath(); ctx.arc(sx, sy, 3.5, 0, Math.PI * 2); ctx.fill();
      label(ctx, hover.name, sx + (left ? -9 : 9), sy, pal, 13, left ? 'right' : 'left', { weight: 500, color: pal.text, halo: pal.ground });
    }
  }

  function drawLotBase(g, geo, st, pal) {
    const L = geo.lot, s = S();
    const rect = (x0, y0, x1, y1, fill, stroke, lw = 1) => {
      const [a, b] = R.toScreen(x0, y0), [c, d] = R.toScreen(x1, y1);
      if (fill) { g.fillStyle = fill; g.fillRect(a, b, c - a, d - b); }
      if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.strokeRect(a, b, c - a, d - b); }
    };
    const { left, right, perimeterY, streetY, entryX, exitX, lotTop } = L.lanes;
    if (L.image?.href && st.images?.lot) {
      const [x0, y0, x1, y1] = L.image.bounds || geo.bounds;
      const [a, b] = R.toScreen(x0, y0), [c, d] = R.toScreen(x1, y1);
      g.globalAlpha = 0.55; g.drawImage(st.images.lot, a, b, c - a, d - b); g.globalAlpha = 1;
    }
    // Street, driveways, lot surface
    rect(-4, streetY - 2, 104, streetY + 6, pal.asphalt);
    rect(entryX - 3, perimeterY, entryX + 3, streetY - 2, pal.asphalt);
    rect(exitX - 3, perimeterY, exitX + 3, streetY - 2, pal.asphalt);
    rect(left - 3.2, lotTop - 0.5, right + 3.2, perimeterY + 3, pal.asphalt);
    // Fire lane and sidewalk in front of the store
    rect(L.store.x0 - 6, L.store.y1, L.store.x1 + 6, lotTop - 0.5, pal.asphalt);
    rect(L.store.x0 - 6, L.store.y1, L.store.x1 + 6, L.store.y1 + 2.6, pal.room);
    // Store
    rect(L.store.x0, L.store.y0, L.store.x1, L.store.y1, pal.store, pal.wall, 1.8);
    // Crosswalk zebra and walkway
    const cw = L.crosswalk;
    g.fillStyle = pal.light ? 'rgba(255,255,255,0.9)' : 'rgba(232,238,244,0.22)';
    for (let y = cw.y0 + 2.6; y < cw.y1; y += 1.2) { const [a, b] = R.toScreen(cw.x0, y), [c] = R.toScreen(cw.x1, y); g.fillRect(a, b, c - a, Math.max(1, 0.55 * s)); }
    const wk = L.walkway;
    rect(wk.x0, lotTop - 0.5, wk.x1, wk.y1, pal.room);
    g.setLineDash([4, 4]);
    rect(wk.x0, lotTop - 0.5, wk.x1, wk.y1, null, pal.stall, 1);
    g.setLineDash([]);
    // Stalls: separators and back lines
    g.strokeStyle = pal.stall;
    g.lineWidth = 1;
    for (const stl of L.stalls) {
      const x0 = stl.x - stl.w / 2, x1 = stl.x + stl.w / 2, y0 = stl.y - stl.h / 2, y1 = stl.y + stl.h / 2;
      const [a, b] = R.toScreen(x0, y0), [c, d] = R.toScreen(x1, y1);
      g.beginPath(); g.moveTo(a, b); g.lineTo(a, d); g.moveTo(c, b); g.lineTo(c, d); g.stroke();
    }
    // Aisle direction chevrons
    g.strokeStyle = pal.faint;
    g.lineWidth = 1.4;
    for (const ai of L.aisles) {
      for (let x = 18; x < 84; x += 12) {
        if (x > 44 && x < 56) continue;
        const [sx, sy] = R.toScreen(x, ai.y);
        const k = 4 * ai.dir;
        g.beginPath(); g.moveTo(sx - k, sy - 4); g.lineTo(sx + k, sy); g.lineTo(sx - k, sy + 4); g.stroke();
      }
    }
    if (!st.layers.labels) return;
    const [scx, scy] = R.toScreen((L.store.x0 + L.store.x1) / 2, (L.store.y0 + L.store.y1) / 2 - 1);
    g.font = `600 ${Math.round(Math.max(16, s * 3.6))}px "IBM Plex Sans", sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = pal.label;
    g.fillText(L.store.name || 'Store', scx, scy);
    for (const ai of L.aisles) { const [sx, sy] = R.toScreen(left - 3.6, ai.y); label(g, ai.name, sx, sy, pal, 12, 'right', { color: pal.muted }); }
    const [ex, ey] = R.toScreen(entryX, streetY + 3.2); label(g, 'Entrance', ex, ey, pal, 13, 'center', { color: pal.muted });
    const [xx, xy] = R.toScreen(exitX, streetY + 3.2); label(g, 'Exit', xx, xy, pal, 13, 'center', { color: pal.muted });
  }

  const seatXY = p => (Array.isArray(p) ? { x: p[0], y: p[1] } : { x: p.x, y: p.y });

  // Where a seated place's name goes: in the middle of a block of seats (it reads as the table), or just past
  // the end of a single row, on the side where people wait.
  function seatLabelSpot(n) {
    const seats = n.seats.map(seatXY), xs = seats.map(p => p.x), ys = seats.map(p => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const w = x1 - x0, h = y1 - y0, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    // The middle of a block, unless a seat is there (two rows side by side have no gap in the middle).
    if (Math.min(w, h) > 1.5 && !seats.some(p => Math.hypot(p.x - cx, p.y - cy) < 1.7)) return [cx, cy];
    const gap = Math.min(2.6, (Math.max(w, h) / Math.max(1, seats.length - 1)) * 0.62 || 2);
    if (h >= w) { const end = Math.abs(n.y - y1) <= Math.abs(n.y - y0) ? y1 : y0; return [cx, end + (n.y >= end ? gap : -gap)]; }
    const end = Math.abs(n.x - x1) <= Math.abs(n.x - x0) ? x1 : x0;
    return [end + (n.x >= end ? gap : -gap), cy];
  }

  // A chair seen from above: a rounded seat with its back along the top edge. seats: [{ x, y, tag?, bad?, selected? }].
  function drawSeats(g, seats, pal, mpu, editing) {
    const s = S(), size = Math.max(10, ((editing ? 0.62 : 0.5) / mpu) * s);
    for (const seat of seats) {
      const [sx, sy] = R.toScreen(seat.x, seat.y), half = size / 2, r = Math.min(5, size * 0.22);
      const line = seat.bad ? pal['i-congestion'] : editing ? pal.accent : pal.muted;
      g.lineWidth = editing ? 2 : 1.5;
      g.fillStyle = pal.panel;
      g.strokeStyle = line;
      roundRect(g, sx - half, sy - half, size, size, r); g.fill(); g.stroke();
      g.fillStyle = line;
      roundRect(g, sx - half, sy - half - Math.max(2, size * 0.1), size, Math.max(3, size * 0.2), Math.min(2, r)); g.fill();
      if (editing && seat.tag) {
        g.font = `600 ${Math.round(Math.max(10, size * 0.42))}px "IBM Plex Sans", sans-serif`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(seat.tag, sx, sy + 2);
      }
      if (seat.selected) {
        g.strokeStyle = pal.text; g.lineWidth = 2;
        g.beginPath(); g.arc(sx, sy, size * 0.85, 0, Math.PI * 2); g.stroke();
      }
    }
  }

  // Labels placed in this frame, as screen rectangles, so later labels can avoid them.
  const placed = [];
  function labelFree(g, text, spots, pal, size, style = {}) {
    g.font = `${style.weight || 500} ${size}px "IBM Plex Sans", sans-serif`;
    const w = g.measureText(text).width + 6, h = size + 4;
    for (const [x, y, align] of spots) {
      const x0 = align === 'left' ? x - 3 : align === 'right' ? x - w + 3 : x - w / 2;
      const r = [x0, y - h / 2, x0 + w, y + h / 2];
      if (r[0] < 4 || r[2] > R.cw - 4 || r[1] < 4 || r[3] > R.ch - 4) continue;   // keep labels inside the map
      if (placed.some(p => r[0] < p[2] && r[2] > p[0] && r[1] < p[3] && r[3] > p[1])) continue;
      placed.push(r);
      label(g, text, x, y, pal, size, align, style);
      return true;
    }
    return false;
  }

  function label(g, text, x, y, pal, size = 13, align = 'center', { weight = 500, color = pal.label, halo = pal.ground } = {}) {
    g.font = `${weight} ${size}px "IBM Plex Sans", sans-serif`;
    g.textAlign = align;
    g.textBaseline = 'middle';
    g.lineWidth = 4;
    g.lineJoin = 'round';
    g.strokeStyle = halo;
    g.strokeText(text, x, y);
    g.fillStyle = color;
    g.fillText(text, x, y);
  }

  // ---------- frame ----------
  R.draw = (st) => {
    if (!R.pal) R.pal = readPalette();
    const pal = R.pal;
    const key = [st.caseId, st.floor, st.theme, R.cw, R.ch, R.view.x.toFixed(3), R.view.y.toFixed(3), R.view.z.toFixed(4), st.layers.labels, st.edit ? 'edit' : 'play'].join('|');
    if (key !== R.baseKey) { R.base = buildBase(st); R.baseKey = key; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(R.base, 0, 0);
    ctx.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
    // Edit the room (§18): only the room, its seats and the names, no people, heat or incidents.
    if (st.edit) { drawSeats(ctx, st.edit.seats, pal, st.geometry.metersPerUnit || 1, true); drawPlaces(st, pal); return; }
    const s = S();
    const geo = st.geometry;
    const mpu = geo.metersPerUnit || 1;

    // Parked cars
    if (geo.kind === 'lot') {
      const held = heldAt(st.F, st.t, geo.lot.stalls.length);
      ctx.fillStyle = pal.parked;
      for (const stl of geo.lot.stalls) {
        if (!held[stl.id]) continue;
        const [a, b] = R.toScreen(stl.x - stl.w * 0.34, stl.y - stl.h * 0.38);
        roundRect(ctx, a, b, stl.w * 0.68 * s, stl.h * 0.76 * s, Math.min(3, s * 0.4));
        ctx.fill();
      }
    }

    // Heat
    if (st.layers.heat && st.heat) {
      const hc = heatCanvas(st.heat, st.floor, pal.ramp);
      const [a, b] = R.toScreen(st.heat.x0, st.heat.y0);
      ctx.save();
      ctx.globalCompositeOperation = pal['heat-blend'] || 'screen';
      ctx.globalAlpha = pal.light ? 0.75 : 0.9;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(hc, a, b, st.heat.w * st.heat.cell * s, st.heat.h * st.heat.cell * s);
      ctx.restore();
    }

    // People and cars
    const now = performance.now();
    const agents = agentsAt(st.F, st.t).filter(a => a.floor === st.floor);
    R.lastAgents = agents;
    if (st.layers.agents) {
      const rPx = Math.max(2.6, Math.min(6.5, 0.32 / mpu * s));
      for (const a of agents) {
        const isCar = geo.kind === 'lot' && a.s !== 0 && a.s !== 4;
        ctx.fillStyle = colorFor(st, a, pal);
        if (isCar) {
          const len = 4.4 / mpu * s, wid = 1.9 / mpu * s;
          let ang = Math.atan2(a.dy, a.dx);
          if (Math.abs(a.dx) + Math.abs(a.dy) < 0.05) ang = a._ang ?? 0;
          ctx.save();
          ctx.translate(...R.toScreen(a.x, a.y));
          ctx.rotate(ang);
          roundRect(ctx, -len / 2, -wid / 2, len, wid, Math.min(3, wid / 3));
          ctx.fill();
          ctx.restore();
        } else {
          const [sx, sy] = R.toScreen(a.x, a.y);
          ctx.beginPath(); ctx.arc(sx, sy, rPx, 0, Math.PI * 2); ctx.fill();
        }
        if (a.s === 3 && !st.reducedMotion) {
          const [sx, sy] = R.toScreen(a.x, a.y);
          const ph = (now % 1200) / 1200;
          ctx.strokeStyle = pal['a-think'];
          ctx.globalAlpha = 1 - ph;
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(sx, sy, rPx + 2 + ph * 8, 0, Math.PI * 2); ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }

    // In-store count (lot): shoppers inside are not drawn individually.
    if (geo.kind === 'lot' && st.layers.labels) {
      const f = st.frame;
      if (f?.c?.inside != null) {
        const [sx, sy] = R.toScreen(geo.lot.store.door[0], geo.lot.store.door[1] - 4);
        pill(ctx, `${f.c.inside} shopping inside`, sx, sy, pal);
      }
    }

    // Incidents: new ones pulse, then fade into the heat.
    const win = 4;
    for (const it of st.incidents) {
      if (it.t > st.t) break;
      if (it.t < st.t - win || (it.floor || 0) !== st.floor || !st.filters[it.cat]) continue;
      const age = (st.t - it.t) / win;
      const [sx, sy] = R.toScreen(it.x, it.y);
      const col = pal['i-' + it.cat];
      ctx.globalAlpha = Math.max(0, 1 - age);
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, 6 + age * 22, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(sx, sy, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Selected incident
    const si = st.selectedIncident;
    if (si && (si.floor || 0) === st.floor) {
      const [sx, sy] = R.toScreen(si.x, si.y);
      ctx.strokeStyle = pal['i-' + si.cat];
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(sx, sy, 15, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(sx + dx * 19, sy + dy * 19); ctx.lineTo(sx + dx * 26, sy + dy * 26); }
      ctx.stroke();
    }

    // Selected agent: trail and ring
    if (st.selectedAgent != null) {
      const trail = agentTrail(st.F, st.selectedAgent, st.t, 3).filter(p => p.floor === st.floor);
      if (trail.length > 1) {
        ctx.strokeStyle = pal.accent;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        trail.forEach((p, i) => { const [sx, sy] = R.toScreen(p.x, p.y); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      const me = agents.find(a => a.id === st.selectedAgent);
      if (me) {
        const [sx, sy] = R.toScreen(me.x, me.y);
        ctx.strokeStyle = pal.accent;
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(sx, sy, 11, 0, Math.PI * 2); ctx.stroke();
      }
    }

    if (geo.kind !== 'lot') drawPlaces(st, pal);

    // Keyboard cursor: the person the arrow keys are on, before Enter opens them.
    if (st.cursorAgent != null) {
      const me = agents.find(a => a.id === st.cursorAgent);
      if (me) {
        const [sx, sy] = R.toScreen(me.x, me.y);
        ctx.strokeStyle = pal.room;
        ctx.lineWidth = 5;
        ctx.beginPath(); ctx.arc(sx, sy, 12, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = pal.text;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.arc(sx, sy, 12, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  };

  // The door or stairs within 12 px of a screen point, for its name on hover.
  R.hitNode = (st, sx, sy) => {
    let best = null, bd = 12;
    for (const n of st.nodes) {
      if ((n.floor || 0) !== st.floor || n.kind !== 'entry') continue;
      const [x, y] = R.toScreen(n.x, n.y);
      const d = Math.hypot(x - sx, y - sy);
      if (d < bd) { bd = d; best = n.id; }
    }
    return best;
  };

  function colorFor(st, a, pal) {
    if (st.colorBy === 'frustration') {
      const f = st.frustration(a.id, st.t);
      return f == null ? pal.faint : FRUSTRATION[Math.max(0, Math.min(4, Math.round(f)))];
    }
    if (st.colorBy === 'archetype') {
      const k = st.archIndex.get(st.agentArch.get(a.id)) ?? 0;
      return pal['g-' + ((k % 5) + 1)];
    }
    if (st.geometry.kind === 'lot' && a.s !== 0 && a.s !== 4) return a.s === 3 ? pal['a-think'] : a.s === 1 ? pal['a-queue'] : pal['a-car'];
    return pal[STATE_VAR[a.s] ? STATE_VAR[a.s].slice(2) : 'a-walk'] || pal['a-walk'];
  }

  function pill(g, text, x, y, pal) {
    g.font = '600 13px "IBM Plex Sans", sans-serif';
    const w = g.measureText(text).width + 18;
    g.fillStyle = pal.panel;
    roundRect(g, x - w / 2, y - 12, w, 24, 12);
    g.fill();
    g.strokeStyle = pal['line-2'];
    g.lineWidth = 1;
    g.stroke();
    g.fillStyle = pal.text;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, x, y + 0.5);
  }

  // Nearest agent (within 10 px) or recent incident (within 12 px) under a screen point.
  R.hit = (st, sx, sy) => {
    let best = null, bd = 10;
    for (const a of R.lastAgents) {
      const [x, y] = R.toScreen(a.x, a.y);
      const d = Math.hypot(x - sx, y - sy);
      if (d < bd) { bd = d; best = { type: 'agent', id: a.id }; }
    }
    if (best) return best;
    bd = 12;
    for (const it of st.incidents) {
      if (it.t > st.t) break;
      if (it.t < st.t - 4 || (it.floor || 0) !== st.floor) continue;
      const [x, y] = R.toScreen(it.x, it.y);
      const d = Math.hypot(x - sx, y - sy);
      if (d < bd) { bd = d; best = { type: 'incident', incident: it }; }
    }
    return best;
  };

  return R;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
