// Swarmscope time-series chart: queue length (visit) or road load (route) over the run,
// with a vertical cursor at the scrubber time. The app renders the legend.
// Contract: docs/PROTOTYPE.md §12b.

const MAX_SERIES = 6;
const MONO = '"IBM Plex Mono", ui-monospace, monospace';
const SANS = '"IBM Plex Sans", system-ui, sans-serif';
// Used for series that arrive without a color, by rank (matches the prototype's chart palette).
const FALLBACK = ['var(--heat2)', 'var(--heat1)', 'var(--a1)', 'var(--a4)', 'var(--a3)', 'var(--a2)'];

/**
 * createChart(canvas) → { setSeries, render(cursorT), resize }
 * setSeries({ t, series: [{ name, color, values }], yLabel, xFormat?, yFormat?, ref? })
 *   keeps the top 6 series by peak and returns them as [{ name, color }] in drawing rank,
 *   so the app's legend matches what is drawn. Optional extras: xFormat(t) → string for the
 *   time axis (e.g. t => clockText(spec, t)), yFormat(v) → string, ref: a value drawn as a
 *   dashed reference line (e.g. 100 for 100% road load).
 */
export function createChart(canvas) {
  let data = null;
  let cursor = null;

  function setSeries({ t = [], series = [], yLabel = '', xFormat = null, yFormat = null, ref = null } = {}) {
    const times = Array.from(t, Number);
    const ranked = (series || [])
      .map((s, i) => ({ name: String(s?.name ?? ''), color: s?.color || null, values: Array.from(s?.values || [], v => (v == null ? NaN : Number(v))), i }))
      .map(s => ({ ...s, peak: peakOf(s.values) }))
      .sort((a, b) => b.peak - a.peak || a.i - b.i)
      .slice(0, MAX_SERIES)
      .map((s, rank) => ({ ...s, color: s.color || FALLBACK[rank] }));
    data = {
      t: times, series: ranked, yLabel: String(yLabel || ''),
      xFormat: typeof xFormat === 'function' ? xFormat : elapsed,
      yFormat: typeof yFormat === 'function' ? yFormat : compact,
      ref: Number.isFinite(Number(ref)) && ref !== null ? Number(ref) : null
    };
    render(cursor);
    return ranked.map(s => ({ name: s.name, color: s.color }));
  }

  function render(cursorT) {
    cursor = Number.isFinite(cursorT) ? cursorT : null;
    const { ctx, W, H } = fitCanvas(canvas);
    ctx.clearRect(0, 0, W, H);
    const th = readTheme();

    if (!data || !data.t.length || !data.series.length) {
      ctx.fillStyle = th.muted; ctx.font = `400 12px ${SANS}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('No data yet', W / 2, H / 2);
      return;
    }

    const { t, series, yLabel, xFormat, yFormat, ref } = data;
    const t0 = t[0], t1 = t[t.length - 1] > t0 ? t[t.length - 1] : t0 + 1;
    const peak = Math.max(4, ref ?? 0, ...series.map(s => s.peak));
    const ymax = peak * 1.08;
    const ticks = niceTicks(ymax, 3);

    ctx.font = `400 10px ${MONO}`;
    const tickW = Math.max(...ticks.map(v => ctx.measureText(yFormat(v)).width));
    const padL = Math.max(28, Math.ceil(tickW) + 9), padR = 8, padB = 18, padT = yLabel ? 18 : 6;
    const X = v => padL + (v - t0) / (t1 - t0) * (W - padL - padR);
    const Y = v => padT + (1 - v / ymax) * (H - padT - padB);

    // Gridlines and y labels.
    ctx.lineWidth = 1; ctx.strokeStyle = th.line; ctx.fillStyle = th.muted;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of ticks) {
      ctx.globalAlpha = v === 0 ? 1 : 0.6;
      ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(W - padR, Y(v)); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(yFormat(v), padL - 5, Y(v));
    }
    if (ref !== null && ref > 0 && ref <= ymax) {
      ctx.save();
      ctx.setLineDash([3, 3]); ctx.strokeStyle = th.muted;
      ctx.beginPath(); ctx.moveTo(padL, Y(ref)); ctx.lineTo(W - padR, Y(ref)); ctx.stroke();
      ctx.restore();
    }
    if (yLabel) {
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.font = `500 10px ${SANS}`;
      ctx.fillText(yLabel, 2, 11);
      ctx.font = `400 10px ${MONO}`;
    }

    // Time axis.
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const nx = W < 300 ? 2 : 4;
    for (let k = 0; k <= nx; k++) {
      const tt = t0 + (t1 - t0) * k / nx;
      const text = xFormat(tt);
      const w = ctx.measureText(text).width;
      ctx.fillText(text, Math.max(padL + w / 2, Math.min(W - padR - w / 2, X(tt))), H - 4);
    }

    // Series, highest peak drawn last so it sits on top.
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const colors = series.map(s => resolveColor(s.color, th.cs));
    for (let r = series.length - 1; r >= 0; r--) {
      const vals = series[r].values;
      ctx.strokeStyle = colors[r]; ctx.lineWidth = r === 0 ? 2.2 : 1.5;
      ctx.beginPath();
      let pen = false;
      const n = Math.min(vals.length, t.length);
      for (let k = 0; k < n; k++) {
        const v = vals[k];
        if (!Number.isFinite(v)) { pen = false; continue; }
        const x = X(t[k]), y = Y(v);
        if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
      }
      ctx.stroke();
    }

    // Cursor with a dot on each series at the cursor time.
    if (cursor !== null) {
      const ct = Math.max(t0, Math.min(t1, cursor)), cx = X(ct);
      ctx.save();
      ctx.strokeStyle = th.ink; ctx.globalAlpha = 0.55; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, H - padB); ctx.stroke();
      ctx.restore();
      for (let r = series.length - 1; r >= 0; r--) {
        const v = valueAt(t, series[r].values, ct);
        if (!Number.isFinite(v)) continue;
        ctx.fillStyle = colors[r]; ctx.strokeStyle = th.panel; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(cx, Y(v), r === 0 ? 3.2 : 2.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
  }

  function resize() { render(cursor); }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
  ro?.observe(canvas);

  return { setSeries, render, resize };
}

// ---------- helpers ----------

function peakOf(values) {
  let m = 0;
  for (const v of values) if (Number.isFinite(v) && v > m) m = v;
  return m;
}

// Linear interpolation of values at time x (t sorted ascending).
function valueAt(t, values, x) {
  const n = Math.min(t.length, values.length);
  if (!n) return NaN;
  if (x <= t[0]) return values[0];
  if (x >= t[n - 1]) return values[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= x) lo = mid; else hi = mid;
  }
  const a = values[lo], b = values[hi], span = t[hi] - t[lo];
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b) || span <= 0) return a;
  return a + (b - a) * (x - t[lo]) / span;
}

function niceTicks(max, n) {
  const raw = max / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(s => s * mag).find(s => s >= raw) || raw;
  const out = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

// Elapsed sim minutes: "45m", "1h05".
function elapsed(min) {
  const m = Math.max(0, Math.round(min));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

function compact(v) {
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
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

function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const g = (k, fb) => cs.getPropertyValue(k).trim() || fb;
  return { cs, ink: g('--ink', '#142029'), muted: g('--muted', '#566572'), line: g('--line', '#D2DBE2'), panel: g('--panel', '#FFFFFF') };
}

function resolveColor(c, cs) {
  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(String(c).trim());
  if (!m) return c;
  return cs.getPropertyValue(m[1]).trim() || (m[2] || '').trim() || '#888888';
}
