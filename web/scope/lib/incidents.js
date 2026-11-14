// Incidents, key moments and bottleneck series, derived from run files (docs/PROTOTYPE.md §9b).
// Pure functions: given a RunBundle and prepared frames, return plain data.
import { agentPos, clockText } from './frames.js';

export const CATEGORIES = [
  { id: 'decision', label: 'Gave up', long: 'People who walked away, gave up or drove off' },
  { id: 'congestion', label: 'Crowding', long: 'Doorways and spots over capacity, cars backed up' },
  { id: 'complaint', label: 'Complaints', long: 'People who warned others' }
];

export function deriveRun(bundle, F) {
  const geometry = bundle.geometry;
  const mpu = geometry.metersPerUnit || 1;
  const nodes = new Map((bundle.frames.nodes || []).map(n => [n.id, n]));
  const agents = new Map((bundle.agents || []).map(a => [a.id, a]));
  const duration = bundle.meta.duration || (F.times.length ? F.times[F.times.length - 1] : 60);
  const isLot = geometry.kind === 'lot';
  const nameOf = id => nodes.get(id)?.name || id;

  let incidents;
  if (Array.isArray(bundle.incidents)) {
    incidents = bundle.incidents.map((it, i) => ({ id: it.id || 'i' + i, floor: 0, severity: 1, ...it }));
  } else {
    incidents = [
      ...decisionIncidents(bundle, F, nodes, agents, nameOf, isLot),
      ...complaintIncidents(bundle, F, nodes, nameOf, isLot),
      ...(isLot ? lotCongestion(bundle, F, nodes, geometry) : interiorCongestion(bundle, F, nodes, geometry, mpu))
    ];
  }
  incidents.sort((a, b) => a.t - b.t);
  incidents.forEach((it, i) => { it.id = it.id || 'i' + i; it.clock = clockText(bundle.meta.clockStart, it.t); });

  const bins = minuteBins(incidents, duration);
  const moments = keyMoments(incidents, bins, bundle.meta.clockStart);
  const bottlenecks = bottleneckSeries(bundle, F, incidents, nameOf);
  const frustration = frustrationSeries(bundle);
  return { incidents, bins, moments, bottlenecks, frustration, duration, nodes, agents };
}

// ---------- decisions ----------
function decisionIncidents(bundle, F, nodes, agents, nameOf, isLot) {
  const out = [];
  for (const d of bundle.decisions || []) {
    const ap = d.applied || {};
    if (ap.yes !== false || (d.kind !== 'line' && d.kind !== 'long')) continue;
    const place = d.placeId;
    let kind, text, group;
    if (isLot && place === 'entry_drive') { kind = 'drove_past'; text = 'Drove past without turning in'; group = 'Drivers skipping the lot'; }
    else if (isLot && place === 'search') { kind = 'drove_off'; text = 'Drove off without finding a space'; group = 'Drivers giving up on parking'; }
    else if (isLot && place === 'checkout') { kind = 'left_without_buying'; text = 'Left the store without buying'; group = 'Shoppers leaving without buying'; }
    else if (d.why === 'door') { kind = 'turned_away'; text = `Saw the line at ${nameOf(place)} and left`; group = `Turned away at ${nameOf(place)}`; }
    else if (d.kind === 'line') { kind = 'walked_away'; text = `Walked away from the line at ${nameOf(place)}`; group = `Walk-aways at ${nameOf(place)}`; }
    else { kind = 'gave_up'; text = `Gave up waiting at ${nameOf(place)}`; group = `Walk-aways at ${nameOf(place)}`; }
    const pos = agentPos(F, d.agentId, d.t);
    const node = nodes.get(place);
    const at = pos && !(isLot && place === 'checkout') ? pos : (node ? { x: node.x, y: isLot && place === 'checkout' ? 14.2 : node.y, floor: node.floor || 0 } : null);
    if (!at) continue;
    const person = agents.get(d.agentId)?.personaName;
    out.push({ t: d.t, cat: 'decision', kind, group, text, who: person, x: at.x, y: at.y, floor: at.floor || 0, placeId: place, agentId: d.agentId, decisionId: d.id, severity: d.kind === 'long' ? 1.4 : 1 });
  }
  return out;
}

// ---------- complaints ----------
function complaintIncidents(bundle, F, nodes, nameOf, isLot) {
  const out = [];
  (bundle.remarks || []).forEach((r, i) => {
    if (r.kind !== 'long_line' && r.kind !== 'bad_service' && r.kind !== 'heavy_traffic') return;
    const node = nodes.get(r.placeId);
    const pos = agentPos(F, r.agentId, r.t);
    const base = pos || node;
    if (!base) return;
    const what = isLot && r.placeId === 'search' ? 'how hard it is to park'
      : r.kind === 'bad_service' ? `a bad experience at ${nameOf(r.placeId)}` : `the line at ${nameOf(r.placeId)}`;
    const jitter = ((i * 7919) % 11 - 5) * 0.35;
    out.push({
      t: r.t, cat: 'complaint', kind: r.kind, group: `Complaints about ${isLot && r.placeId === 'search' ? 'parking' : nameOf(r.placeId)}`,
      text: `${r.personName || r.personaName || 'Someone'} warned others about ${what}`, who: r.personName,
      x: base.x + (pos ? 0 : jitter), y: base.y + (pos ? 0 : jitter * 0.6), floor: (pos?.floor ?? node?.floor) || 0, placeId: r.placeId, agentId: r.agentId, severity: 0.8
    });
  });
  return out;
}

// ---------- congestion (detected from positions) ----------
function nearestNodeName(nodes, x, y, floor, maxD) {
  let best = null, bd = maxD;
  for (const n of nodes.values()) {
    if ((n.floor || 0) !== floor) continue;
    // Prefer named points (counters, doors) over the centre of a large area.
    const d = Math.hypot(n.x - x, n.y - y) + (n.kind === 'area' ? maxD * 0.35 : 0);
    if (d < bd) { bd = d; best = n; }
  }
  return best?.name || null;
}

function episodes(frames, test, onEpisode, minFrames = 2) {
  const open = new Map();
  frames.forEach((f, fi) => {
    const hits = test(f, fi);
    for (const [key, info] of hits) {
      const ep = open.get(key);
      if (ep && ep.lastFi >= fi - 2) { ep.lastFi = fi; ep.end = f.t; if (info.count > ep.peak) { ep.peak = info.count; ep.info = info; } ep.n++; }
      else {
        if (ep && ep.n >= minFrames) onEpisode(ep);
        open.set(key, { key, start: f.t, end: f.t, lastFi: fi, peak: info.count, info, n: 1 });
      }
    }
  });
  for (const ep of open.values()) if (ep.n >= minFrames) onEpisode(ep);
}

function interiorCongestion(bundle, F, nodes, geometry, mpu) {
  const out = [];
  const m = 1 / mpu;
  const s = F.stride;
  const doors = geometry.floors.flatMap((fl, fi) => (fl.openings || []).filter(o => o.side !== 'none' && (o.widthM ?? 1) >= 0.7).map(o => ({ ...o, floor: fi })));
  const cell = 2 * m;          // 2 m density cells
  const r2 = (1.5 * m) ** 2;
  episodes(F.list, f => {
    const hits = new Map();
    const a = f.a;
    const counts = new Map();
    const doorCount = new Array(doors.length).fill(0);
    for (let k = 0; k < a.length; k += s) {
      const x = a[k + 1] / 10, y = a[k + 2] / 10, fl = s >= 5 ? a[k + 4] : 0;
      const key = fl + ':' + Math.floor(x / cell) + ':' + Math.floor(y / cell);
      counts.set(key, (counts.get(key) || 0) + 1);
      for (let d = 0; d < doors.length; d++) {
        const o = doors[d];
        if (o.floor !== fl) continue;
        if ((o.x - x) ** 2 + (o.y - y) ** 2 <= r2) doorCount[d]++;
      }
    }
    doors.forEach((o, d) => { if (doorCount[d] >= 3 && doorCount[d] > 2.5 * (o.widthM || 1)) hits.set('door:' + d, { count: doorCount[d], door: o }); });
    // 7 people in 4 m² is about 1.75 people/m²: very crowded, close to shuffling pace.
    for (const [key, c] of counts) if (c >= 7) hits.set('cell:' + key, { count: c, cellKey: key });
    return hits;
  }, ep => {
    const dur = Math.max(0.1, ep.end - ep.start);
    if (ep.info.door) {
      if (ep.n < 3) return;
      const o = ep.info.door;
      const near = nearestNodeName(nodes, o.x, o.y, o.floor, 8 * m);
      out.push({
        t: ep.start, cat: 'congestion', kind: 'door_crowding', group: `Crowding at ${near ? `the doorway by ${near}` : 'a doorway'}`,
        text: `${ep.peak} people bunched at a ${(o.widthM || 1).toFixed(1)} m doorway${near ? ` by ${near}` : ''} for ${fmtDur(dur)}`,
        x: o.x, y: o.y, floor: o.floor, placeId: null, severity: 1 + Math.min(1.5, dur / 2), dur, peak: ep.peak
      });
    } else {
      const [fl, cx, cy] = ep.info.cellKey.split(':').map(Number);
      const x = (cx + 0.5) * cell, y = (cy + 0.5) * cell;
      const near = nearestNodeName(nodes, x, y, fl, 10 * m);
      out.push({
        t: ep.start, cat: 'congestion', kind: 'crowd', group: `Crowding near ${near || 'the middle of the floor'}`,
        text: `Crowd of ${ep.peak} in a 2 m square${near ? ` near ${near}` : ''} for ${fmtDur(dur)}`,
        x, y, floor: fl, placeId: null, severity: 1 + Math.min(1.5, dur / 2), dur, peak: ep.peak
      });
    }
  });
  return out;
}

function lotCongestion(bundle, F, nodes, geometry) {
  const out = [];
  const svc = bundle.frames.services || [];
  const qi = id => svc.indexOf(id);
  const rules = [
    { id: 'entry_drive', min: 7, kind: 'entry_backup', group: 'Cars backed up at the entrance', text: p => `${p} cars backed up at the lot entrance` },
    { id: 'search', min: 14, kind: 'aisle_jam', group: 'Cars circling for spaces', text: p => `${p} cars circling the aisles for a space` },
    { id: 'exit_drive', min: 6, kind: 'exit_backup', group: 'Cars stuck at the exit', text: p => `${p} cars waiting to leave at the exit` }
  ].filter(r => qi(r.id) >= 0);
  episodes(F.list, f => {
    const hits = new Map();
    for (const r of rules) { const q = f.q?.[qi(r.id)] ?? 0; if (q >= r.min) hits.set(r.id, { count: q, rule: r }); }
    // Stopped cars bunching in an aisle (behind someone parking or yielding to shoppers).
    const a = f.a, s = F.stride, cell = 8 / (geometry.metersPerUnit || 1);
    const counts = new Map();
    for (let k = 0; k < a.length; k += s) {
      if (a[k + 3] !== 1) continue;
      const key = Math.floor(a[k + 1] / 10 / cell) + ':' + Math.floor(a[k + 2] / 10 / cell);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const [key, c] of counts) if (c >= 4) hits.set('stop:' + key, { count: c, cellKey: key, cell });
    return hits;
  }, ep => {
    const dur = Math.max(0.1, ep.end - ep.start);
    if (ep.info.rule) {
      const r = ep.info.rule, n = nodes.get(r.id);
      out.push({ t: ep.start, cat: 'congestion', kind: r.kind, group: r.group, text: `${r.text(ep.peak)} for ${fmtDur(dur)}`, x: n?.x ?? 50, y: n?.y ?? 50, floor: 0, placeId: r.id, severity: 1 + Math.min(1.5, dur / 3), dur, peak: ep.peak });
    } else {
      const [cx, cy] = ep.info.cellKey.split(':').map(Number);
      const x = (cx + 0.5) * ep.info.cell, y = (cy + 0.5) * ep.info.cell;
      const aisle = (geometry.lot?.aisles || []).reduce((b, ai) => (Math.abs(ai.y - y) < Math.abs((b?.y ?? 1e9) - y) ? ai : b), null);
      out.push({ t: ep.start, cat: 'congestion', kind: 'stopped_cars', group: `Cars stopped in the ${aisle?.name?.toLowerCase() || 'aisles'}`, text: `${ep.peak} cars stopped in the ${aisle?.name?.toLowerCase() || 'aisle'} for ${fmtDur(dur)}`, x, y, floor: 0, placeId: null, severity: 1 + Math.min(1.5, dur / 2), dur, peak: ep.peak });
    }
  });
  return out;
}

function fmtDur(min) {
  if (min < 1) return `${Math.max(5, Math.round(min * 60 / 5) * 5)} seconds`;
  return `${Math.round(min)} minute${Math.round(min) === 1 ? '' : 's'}`;
}

// ---------- time structure ----------
export function minuteBins(incidents, duration) {
  const n = Math.max(1, Math.ceil(duration));
  const bins = Array.from({ length: n }, () => ({ decision: 0, congestion: 0, complaint: 0, total: 0 }));
  for (const it of incidents) {
    const b = bins[Math.min(n - 1, Math.max(0, Math.floor(it.t)))];
    b[it.cat] = (b[it.cat] || 0) + 1;
    b.total++;
  }
  return bins;
}

export function keyMoments(incidents, bins, clockStart, max = 4) {
  const tot = bins.map(b => b.total);
  const smooth = tot.map((_, i) => (tot[i - 1] || 0) * 0.25 + tot[i] * 0.5 + (tot[i + 1] || 0) * 0.25);
  const mean = smooth.reduce((a, b) => a + b, 0) / smooth.length;
  const sd = Math.sqrt(smooth.reduce((a, b) => a + (b - mean) ** 2, 0) / smooth.length);
  const peaks = [];
  smooth.forEach((v, i) => {
    if (v > mean + sd && v >= (smooth[i - 1] ?? -1) && v >= (smooth[i + 1] ?? -1)) peaks.push({ i, v });
  });
  peaks.sort((a, b) => b.v - a.v);
  const chosen = [];
  for (const p of peaks) {
    if (chosen.every(c => Math.abs(c.i - p.i) >= 15)) chosen.push(p);
    if (chosen.length >= max) break;
  }
  return chosen.sort((a, b) => a.i - b.i).map(p => {
    const near = incidents.filter(it => Math.abs(it.t - (p.i + 0.5)) <= 3);
    const groups = new Map();
    for (const it of near) groups.set(it.group, (groups.get(it.group) || 0) + (it.severity || 1));
    const group = [...groups.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'Incidents';
    const top = near.filter(it => it.group === group).sort((a, b) => (b.severity || 1) - (a.severity || 1))[0];
    return { t: p.i + 0.5, label: group, clock: clockText(clockStart, p.i), count: near.length, focus: top || null };
  });
}

function bottleneckSeries(bundle, F, incidents, nameOf) {
  const svc = bundle.frames.services || [];
  const n = F.list.length;
  const wait = svc.map(() => new Float64Array(n));
  for (let i = 1; i < n; i++) {
    const dt = F.list[i].t - F.list[i - 1].t;
    const q = F.list[i - 1].q || [];
    svc.forEach((_, k) => { wait[k][i] = wait[k][i - 1] + (q[k] || 0) * dt; });
  }
  const lostTimes = svc.map(id => incidents.filter(it => it.cat === 'decision' && it.placeId === id).map(it => it.t));
  const count = (arr, t) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= t) lo = m + 1; else hi = m; } return lo; };
  return {
    ids: svc,
    at(fi, t) {
      return svc.map((id, k) => {
        const w = wait[k][Math.max(0, fi)] || 0, lost = count(lostTimes[k], t);
        return { id, name: nameOf(id), waitMin: w, lost, score: w + 30 * lost };
      }).sort((a, b) => b.score - a.score);
    },
    max() {
      return Math.max(1, ...svc.map((_, k) => (wait[k][n - 1] || 0) + 30 * lostTimes[k].length));
    }
  };
}

function frustrationSeries(bundle) {
  const per = new Map();
  for (const d of bundle.decisions || []) {
    const f = d.decision?.frustration?.expected ?? d.applied?.frustration;
    if (f == null) continue;
    if (!per.has(d.agentId)) per.set(d.agentId, []);
    per.get(d.agentId).push([d.t, f]);
  }
  return {
    at(id, t) {
      const arr = per.get(id);
      if (!arr) return null;
      let v = null;
      for (const [tt, f] of arr) { if (tt <= t) v = f; else break; }
      return v;
    }
  };
}
