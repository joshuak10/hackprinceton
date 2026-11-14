// What a change did, measured seed by seed on the same simulated crowd (docs/PROTOTYPE.md §15c):
// headline KPIs, who it helped (segments, §15a) and what an added offer reached (§15b).
// Shared by `swarm compare` (CLI and MCP) and the advisor's test_change. Pure: no I/O, no SDK.
import { KPI_NAMES } from './runner.js';
import { SEGMENT_NOTE, fmtNum, fmtPct, fmtMin, fmtMoney } from './report.js';

// +1: higher is better, -1: lower is better, 0: neither (spawned follows arrivals, spending depends on the question).
export const BETTER = {
  abandonRate: -1, avgWait: -1, served: 1, abandoned: -1, spawned: 0, avgTrip: -1, avgDelay: -1, arrived: 1,
  walkAwaysPerPerson: -1, shareNeverServed: -1, avgFrustration: -1, avgSpent: 0, avgVisits: 0, arrivals: 0, reached: 0, wentToPlace: 0
};
export const HEADLINE = { visit: ['abandonRate', 'avgWait'], route: ['avgTrip', 'avgDelay'] };
export const SEGMENT_FIELDS = {
  visit: ['avgWait', 'walkAwaysPerPerson', 'shareNeverServed', 'avgSpent', 'avgVisits', 'avgFrustration'],
  route: ['avgTrip', 'avgDelay', 'avgFrustration']
};

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const sum = list => list.reduce((s, v) => s + v, 0);

export function meanSd(values) {
  const n = values.length;
  if (!n) return { mean: null, sd: null };
  const mean = sum(values) / n;
  const sd = n > 1 ? Math.sqrt(sum(values.map(v => (v - mean) ** 2)) / (n - 1)) : 0;
  return { mean, sd };
}

// Pairs before and after values seed by seed (common random numbers), skipping seeds where either is missing.
// spread = the larger seed-to-seed standard deviation of the two sides; a change counts only beyond it.
export function measure(before, after, better = 0) {
  const pairs = before.map((b, i) => [b, after[i]]).filter(([b, a]) => isNum(b) && isNum(a));
  if (!pairs.length) return null;
  const b = meanSd(pairs.map(p => p[0]));
  const a = meanSd(pairs.map(p => p[1]));
  const bySeed = pairs.map(([x, y]) => y - x);
  const change = a.mean - b.mean;
  const spread = Math.max(b.sd, a.sd);
  const beyondSpread = Math.abs(change) > spread + 1e-9;
  const sign = Math.abs(change) > 1e-12 ? Math.sign(change) : 0;
  const holdsAcrossSeeds = sign !== 0 && bySeed.every(d => Math.sign(d) === sign);
  const verdict = !beyondSpread ? 'no clear effect' : better === 0 ? (sign > 0 ? 'up' : 'down') : sign === better ? 'better' : 'worse';
  return { before: b.mean, after: a.mean, change, spread, bySeed, beyondSpread, holdsAcrossSeeds, verdict };
}

export function overallVerdict(kpis, mode) {
  const verdicts = HEADLINE[mode].map(k => kpis[k]?.verdict);
  const better = verdicts.includes('better');
  const worse = verdicts.includes('worse');
  return better && worse ? 'mixed' : better ? 'helps' : worse ? 'hurts' : 'no clear effect';
}

// The offers a patch added, as the engine normalized them: ids filled in or made unique, audience and place
// names resolved to ids, skipped offers absent. applyPatch appends added offers in patch order.
export function addedOffers(base, patched) {
  return (patched?.offers ?? []).slice((base?.offers ?? []).length);
}

// Mean visits per run to each place in a segment's top places (metrics keep the top 3 per run).
function topPlacesMean(list) {
  const by = new Map();
  for (const s of list) {
    for (const p of s?.topPlaces ?? []) {
      const e = by.get(p.id) ?? { id: p.id, name: p.name, visits: 0 };
      e.visits += p.visits ?? 0;
      by.set(p.id, e);
    }
  }
  const n = Math.max(1, list.length);
  return new Map([...by.values()].map(e => [e.id, { ...e, visits: e.visits / n }]));
}

// Every group, plus each cast member in `cast`, with each segment field measured before → after, and where the
// segment went (top places, mean visits per run on each side). `before` and `after` are per-seed metrics.
export function segmentChanges(mode, before, after, cast = []) {
  const fields = SEGMENT_FIELDS[mode] ?? [];
  const side = (list, which, id) => list.map(m => m?.segments?.[which]?.find(s => s.id === id));
  const changes = (which, ids) => ids.map(id => {
    const b = side(before, which, id), a = side(after, which, id);
    const any = b.find(Boolean) ?? a.find(Boolean);
    const out = { id, name: any?.name ?? id, group: any?.group, count: meanSd(b.concat(a).map(s => s?.count).filter(isNum)).mean, fields: {} };
    for (const f of fields) {
      const m = measure(b.map(s => s?.[f]), a.map(s => s?.[f]), BETTER[f] ?? 0);
      if (m) out.fields[f] = m;
    }
    if (mode !== 'route') {
      const pb = topPlacesMean(b), pa = topPlacesMean(a);
      out.places = [...new Set([...pb.keys(), ...pa.keys()])]
        .map(pid => ({ id: pid, name: (pa.get(pid) ?? pb.get(pid)).name, before: pb.get(pid)?.visits ?? 0, after: pa.get(pid)?.visits ?? 0 }))
        .sort((x, y) => Math.max(y.before, y.after) - Math.max(x.before, x.after));
    }
    return out;
  }).filter(s => Object.keys(s.fields).length);
  const groupIds = [...new Set(before.concat(after).flatMap(m => (m?.segments?.byGroup ?? []).map(s => s.id)))];
  if (!groupIds.length) return null;
  return { byGroup: changes('byGroup', groupIds), byCast: changes('byCast', [...new Set(cast)]) };
}

// Each added offer: mean reached and went-to-place per run (after side), and arrivals at its place before → after.
export function offerChanges(before, after, offers) {
  return offers.map(o => {
    const results = after.map(m => (m?.offers ?? []).find(x => x.id === o.id));
    const mean = k => meanSd(results.map(r => r?.[k]).filter(isNum)).mean;
    const arrivals = list => list.map(m => (m?.nodes ?? []).find(n => n.id === o.place)?.arrivals);
    return {
      id: o.id, to: o.to ?? { groups: [], cast: [] }, place: o.place ?? null, priceOff: o.priceOff ?? 0,
      reached: mean('reached'), wentToPlace: mean('wentToPlace'),
      placeArrivals: o.place ? measure(arrivals(before), arrivals(after), 0) : null
    };
  });
}

/**
 * The measured effects of one compare: headline KPIs, segments and offers.
 * @param {{ mode: 'visit'|'route', before: object[], after: object[], offers?: object[] }} args
 *   per-seed metrics on each side, in the same seed order, and the offers the patch added (addedOffers).
 */
export function changeEffects({ mode, before, after, offers = [] }) {
  const kpis = {};
  for (const k of KPI_NAMES[mode]) kpis[k] = measure(before.map(m => m?.[k]), after.map(m => m?.[k]), BETTER[k]);
  const headline = HEADLINE[mode].map(k => kpis[k]).filter(Boolean);
  const moved = headline.filter(m => m.beyondSpread);
  return {
    kpis,
    verdict: overallVerdict(kpis, mode),
    holdsAcrossSeeds: moved.length > 0 && moved.every(m => m.holdsAcrossSeeds),
    segments: segmentChanges(mode, before, after, offers.flatMap(o => o.to?.cast ?? [])),
    offers: offerChanges(before, after, offers)
  };
}

// ---------- text for `swarm compare` ----------

const VALUE_FORMAT = {
  avgWait: fmtMin, avgTrip: fmtMin, avgDelay: fmtMin, avgSpent: fmtMoney, shareNeverServed: v => fmtPct(v, 0),
  walkAwaysPerPerson: v => fmtNum(v, 2), avgVisits: v => fmtNum(v, 2), avgFrustration: v => fmtNum(v, 2)
};
const SEGMENT_COLUMNS = {
  visit: [['avgSpent', 'Avg spent'], ['avgWait', 'Avg wait'], ['walkAwaysPerPerson', 'Walk-aways/person'], ['shareNeverServed', 'Never served']],
  route: [['avgTrip', 'Avg trip'], ['avgDelay', 'Avg delay']]
};

// "$141.09 → $99.20*": * marks a change larger than the spread across seeds.
function fromTo(field, m) {
  if (!m) return '–';
  const f = VALUE_FORMAT[field] ?? (v => fmtNum(v));
  return `${f(m.before)} → ${f(m.after)}${m.beyondSpread ? '*' : ''}`;
}

/**
 * Lines `swarm compare` prints after the KPI and bottleneck tables: added offers, then who the change helped.
 * @param {{ spec: object, effects: object, table: (headers: string[], rows: any[][]) => string }} args
 *   `spec` the normalized world before the patch (for names), `effects` from changeEffects.
 */
export function effectLines({ spec, effects, table }) {
  const out = [];
  const groupName = id => (spec?.archetypes ?? []).find(a => a.id === id)?.name ?? id;
  const castName = id => (spec?.minds ?? []).find(m => m.id === id)?.name ?? id;
  const placeName = id => (spec?.nodes ?? []).find(n => n.id === id)?.name ?? id;
  const offers = effects.offers ?? [];
  if (offers.length) {
    out.push('', 'Offers added by the patch (mean per run over the seeds):');
    out.push(table(['Offer', 'To', 'Place', 'Off', 'Reached', 'Went to the place', 'Arrivals at the place'], offers.map(o => {
      const to = [...(o.to?.groups ?? []).map(groupName), ...(o.to?.cast ?? []).map(castName)].join(', ') || 'everyone';
      return [o.id, to, o.place ? placeName(o.place) : '–', o.priceOff ? fmtPct(o.priceOff, 0) : '–', fmtNum(o.reached), fmtNum(o.wentToPlace),
        o.placeArrivals ? fromTo('arrivals', o.placeArrivals) : '–'];
    })));
  }
  const seg = effects.segments;
  if (!seg) return out;
  const mode = spec?.mode === 'route' ? 'route' : 'visit';
  const cols = SEGMENT_COLUMNS[mode];
  const targeted = new Set(offers.flatMap(o => [...(o.to?.groups ?? []), ...(o.to?.cast ?? [])]));
  const everyone = offers.some(o => !(o.to?.groups?.length || o.to?.cast?.length));
  const rows = [...seg.byGroup.map(s => ['', s]), ...seg.byCast.map(s => ['cast: ', s])];
  out.push('', 'Who, before → after (mean over the seeds; * = change larger than the spread across seeds):', SEGMENT_NOTE);
  out.push(table(['Segment', 'People', ...cols.map(c => c[1])], rows.map(([prefix, s]) => [
    `${prefix}${s.name}${targeted.has(s.id) ? ' (offer)' : ''}`, fmtNum(s.count), ...cols.map(([f]) => fromTo(f, s.fields[f]))
  ])));
  if (mode === 'visit' && offers.length) {
    const shown = rows.filter(([, s]) => everyone || targeted.has(s.id));
    if (shown.length) {
      out.push('', 'Where the offer\'s audience went (visits per run at their top places, before → after):');
      for (const [prefix, s] of shown) {
        const places = (s.places ?? []).slice(0, 4).map(p => `${p.name} ${fmtNum(p.before)} → ${fmtNum(p.after)}`).join(' · ') || '–';
        out.push(`  ${prefix}${s.name}: ${places}`);
      }
    }
  }
  return out;
}
