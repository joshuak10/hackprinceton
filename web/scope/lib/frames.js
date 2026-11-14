// Frame lookup and interpolation (docs/PROTOTYPE.md §7 frames, §9b extensions). Pure functions.

export function prepareFrames(frames) {
  const stride = frames.stride || 4;
  const list = frames.list || [];
  const times = Float64Array.from(list.map(f => f.t));
  return { ...frames, stride, list, times, cache: new Map() };
}

// Index of the last frame at or before t.
export function frameIndex(F, t) {
  const ts = F.times;
  if (!ts.length) return -1;
  if (t <= ts[0]) return 0;
  if (t >= ts[ts.length - 1]) return ts.length - 1;
  let lo = 0, hi = ts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid; else hi = mid;
  }
  return lo;
}

function byId(F, i) {
  if (F.cache.has(i)) return F.cache.get(i);
  const a = F.list[i].a, s = F.stride;
  const m = new Map();
  for (let k = 0; k < a.length; k += s) m.set(a[k], k);
  if (F.cache.size > 8) F.cache.delete(F.cache.keys().next().value);
  F.cache.set(i, m);
  return m;
}

/**
 * Agents at time t, positions interpolated between the two surrounding frames.
 * Returns [{ id, x, y, s, floor, dx, dy }] in map units. dx/dy is the motion direction (for drawing cars).
 */
export function agentsAt(F, t) {
  const i = frameIndex(F, t);
  if (i < 0) return [];
  const f0 = F.list[i], f1 = F.list[Math.min(i + 1, F.list.length - 1)];
  const span = f1.t - f0.t;
  const u = span > 0 ? Math.min(1, Math.max(0, (t - f0.t) / span)) : 0;
  const next = byId(F, Math.min(i + 1, F.list.length - 1));
  const s = F.stride;
  const a = f0.a, b = f1.a;
  const out = [];
  for (let k = 0; k < a.length; k += s) {
    const id = a[k];
    let x = a[k + 1] / 10, y = a[k + 2] / 10, dx = 0, dy = 0;
    const floor = s >= 5 ? a[k + 4] : 0;
    const j = next.get(id);
    if (j !== undefined && (s < 5 || b[j + 4] === floor)) {
      const x1 = b[j + 1] / 10, y1 = b[j + 2] / 10;
      dx = x1 - x; dy = y1 - y;
      // Don't interpolate across a teleport (entering, leaving, changing floors).
      if (Math.hypot(dx, dy) < 25) { x += dx * u; y += dy * u; }
    }
    out.push({ id, x, y, s: a[k + 3], floor, dx, dy });
  }
  return out;
}

export function frameAt(F, t) {
  const i = frameIndex(F, t);
  return i < 0 ? null : F.list[i];
}

// Position of one agent at time t, or null if they're not on the map then.
export function agentPos(F, id, t) {
  const i = frameIndex(F, t);
  if (i < 0) return null;
  for (const k of [i, i + 1, i - 1]) {
    if (k < 0 || k >= F.list.length) continue;
    const j = byId(F, k).get(id);
    if (j !== undefined) {
      const a = F.list[k].a;
      return { x: a[j + 1] / 10, y: a[j + 2] / 10, s: a[j + 3], floor: F.stride >= 5 ? a[j + 4] : 0, t: F.list[k].t };
    }
  }
  return null;
}

// Recent path of one agent (for the selected-agent trail).
export function agentTrail(F, id, t, minutes = 2) {
  const i = frameIndex(F, t);
  const pts = [];
  for (let k = i; k >= 0 && F.list[k].t >= t - minutes; k--) {
    const j = byId(F, k).get(id);
    if (j === undefined) break;
    const a = F.list[k].a;
    pts.push({ x: a[j + 1] / 10, y: a[j + 2] / 10, floor: F.stride >= 5 ? a[j + 4] : 0 });
  }
  return pts.reverse();
}

// Held stalls: `h` is either an array of indices or a hex bitmask (4 stalls per hex digit).
export function heldAt(F, t, n) {
  const f = frameAt(F, t);
  const out = new Uint8Array(n);
  if (!f || f.h == null) return out;
  if (Array.isArray(f.h)) { for (const i of f.h) if (i < n) out[i] = 1; return out; }
  for (let d = 0; d < f.h.length; d++) {
    const nib = parseInt(f.h[d], 16);
    for (let b = 0; b < 4; b++) if (nib & (1 << b)) { const i = d * 4 + b; if (i < n) out[i] = 1; }
  }
  return out;
}

export function clockText(clockStart, t) {
  const m = Math.floor((((clockStart || 0) + t) % 1440 + 1440) % 1440);
  const h24 = Math.floor(m / 60), mm = String(m % 60).padStart(2, '0');
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${mm} ${h24 < 12 ? 'am' : 'pm'}`;
}
