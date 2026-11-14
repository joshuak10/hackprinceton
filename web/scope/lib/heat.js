// Incident heat that builds up from the start of the run to the slider time.
// Accumulates Gaussian stamps on a coarse grid per floor; moves forward incrementally and rebuilds when the
// slider goes back. The colour scale is fixed to the whole run's peak, so heat visibly grows over time.

// The grid extends `pad` map units past the plan so glows at entrances (just outside) aren't clipped.
export function createHeat(bounds, floors, { cell = 0.6, sigma = 2.6, pad = 8 } = {}) {
  const [, , W, H] = bounds;
  const x0 = -pad, y0 = -pad;
  const w = Math.ceil((W + 2 * pad) / cell), h = Math.ceil((H + 2 * pad) / cell);
  const grids = Array.from({ length: floors }, () => new Float32Array(w * h));
  const r = Math.ceil(sigma * 2.6 / cell);
  const kernel = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const d2 = (dx * cell) ** 2 + (dy * cell) ** 2;
    kernel.push([dx, dy, Math.exp(-d2 / (2 * sigma * sigma))]);
  }
  return { x0, y0, w, h, cell, grids, kernel, upto: 0, t: -1, peak: 1, canvases: [], version: 0 };
}

function stamp(heat, it) {
  const g = heat.grids[it.floor || 0];
  if (!g) return;
  const cx = Math.floor((it.x - heat.x0) / heat.cell), cy = Math.floor((it.y - heat.y0) / heat.cell);
  const wgt = it.severity || 1;
  for (const [dx, dy, k] of heat.kernel) {
    const x = cx + dx, y = cy + dy;
    if (x < 0 || y < 0 || x >= heat.w || y >= heat.h) continue;
    g[y * heat.w + x] += k * wgt;
  }
}

// Peak value if every incident were stamped: fixes the colour scale for the whole run.
export function calibrate(heat, incidents) {
  for (const it of incidents) stamp(heat, it);
  let peak = 0;
  for (const g of heat.grids) for (let i = 0; i < g.length; i++) if (g[i] > peak) peak = g[i];
  heat.peak = Math.max(1, peak);
  for (const g of heat.grids) g.fill(0);
  heat.upto = 0;
  heat.t = -1;
}

// Bring the grids to time t. Returns true if anything changed.
export function advance(heat, incidents, t) {
  if (t < heat.t) {
    for (const g of heat.grids) g.fill(0);
    heat.upto = 0;
  }
  let changed = t !== heat.t;
  while (heat.upto < incidents.length && incidents[heat.upto].t <= t) {
    stamp(heat, incidents[heat.upto]);
    heat.upto++;
    changed = true;
  }
  heat.t = t;
  if (changed) heat.version++;
  return changed;
}

function hexRgb(hex) {
  const h = hex.replace('#', '').trim();
  const v = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

// 256-entry colour ramp: transparent → amber → orange → red.
export function makeRamp(c1, c2, c3) {
  const [a, b, c] = [hexRgb(c1), hexRgb(c2), hexRgb(c3)];
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const u = i / 255;
    let col;
    if (u < 0.5) { const f = u / 0.5; col = a.map((v, k) => v + (b[k] - v) * f); }
    else { const f = (u - 0.5) / 0.5; col = b.map((v, k) => v + (c[k] - v) * f); }
    lut.set([col[0], col[1], col[2], Math.round(255 * Math.min(1, Math.pow(u, 0.75) * 1.25))], i * 4);
  }
  return lut;
}

// Paint one floor's grid into an offscreen canvas (one pixel per heat cell).
export function heatCanvas(heat, floor, ramp) {
  if (!heat.canvases[floor]) {
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(heat.w, heat.h) : Object.assign(document.createElement('canvas'), { width: heat.w, height: heat.h });
    heat.canvases[floor] = { canvas: c, ctx: c.getContext('2d'), version: -1 };
  }
  const entry = heat.canvases[floor];
  if (entry.version === heat.version) return entry.canvas;
  const g = heat.grids[floor];
  const img = entry.ctx.createImageData(heat.w, heat.h);
  const d = img.data;
  for (let i = 0; i < g.length; i++) {
    if (g[i] <= 0.001) continue;
    const u = Math.min(1, Math.sqrt(g[i] / heat.peak));
    const k = Math.round(u * 255) * 4;
    d[i * 4] = ramp[k]; d[i * 4 + 1] = ramp[k + 1]; d[i * 4 + 2] = ramp[k + 2]; d[i * 4 + 3] = ramp[k + 3];
  }
  entry.ctx.putImageData(img, 0, 0);
  entry.version = heat.version;
  return entry.canvas;
}
