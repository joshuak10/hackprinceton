// The owner's view (docs/PROTOTYPE.md §21g): one period for the whole screen, and the business as it is next to
// the business with one change, in four numbers. The numbers come from the saved runs of the multi-day loop
// (GET /api/days): for each change, per run and per day, { seated, fresh, away, revenue, waited } before and after.
// This file holds the arithmetic and the words; owner-panel.js builds the DOM.

// The changes an owner can try, the saved result each one shows (matched by its label), and the days command's name.
export const OWNER_CHANGES = [
  { id: 'seats', short: 'More seats', name: 'two more seats', match: /more seat/i, flag: 'seats+2' },
  { id: 'faster', short: 'Faster meals', name: 'meals 15% quicker', match: /quicker|faster/i, flag: 'faster15' },
  { id: 'card', short: 'Sorry card', name: 'a card for people turned away', match: /turned away/i, flag: 'sorry' }
];
export const ownerChange = id => OWNER_CHANGES.find(c => c.id === id) || OWNER_CHANGES[0];
export const resultFor = (saved, id) => (saved?.results || []).find(r => ownerChange(id).match.test(r?.label || '')) || null;

// "Friday evening" -> "Friday"; a place open every day has no day name.
const dayWord = meta => (meta?.daysPerWeek === 1 && meta.dayName ? String(meta.dayName).split(/\s+/)[0] : null);

// The periods the whole screen can be set to, shortest first, as far as the saved runs go: [{ n (days), label }].
export function periodsFor(meta, days) {
  const day = dayWord(meta), k = Math.max(1, Number(meta?.daysPerWeek) || 5);
  const all = day
    ? [[1, `1 ${day}`], [2, `2 ${day}s`], [4, '1 month'], [8, '2 months']]
    : [[1, '1 day'], [k, '1 week'], [2 * k, '2 weeks'], [4 * k, '1 month'], [8 * k, '2 months']];
  return all.filter(([n]) => n <= (Number(days) || 0)).map(([n, label]) => ({ n, label }));
}

const sum = (xs, f) => xs.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

// One run over its first n days: money, people seated, how long a customer stays (wait plus meal), and the share
// of the people seated who had been before.
function runTotals(days, n, meal) {
  const part = (days || []).slice(0, n);
  const seated = sum(part, d => d.seated), fresh = sum(part, d => d.fresh);
  return {
    revenue: sum(part, d => d.revenue), seated, away: sum(part, d => d.away),
    stay: seated ? sum(part, d => d.waited) / seated + (Number(meal) || 0) : null,
    returning: seated ? (seated - fresh) / seated : null
  };
}

const KEYS = ['revenue', 'seated', 'stay', 'returning'];

// Before and after over the first n days: the mean of the runs, and for each number whether every run moved the
// same way (a change is only stated then).
export function compareFor(result, n) {
  const base = (result?.series?.base || []).map(r => runTotals(r, n, result.meal?.base));
  const after = (result?.series?.after || []).map(r => runTotals(r, n, result.meal?.after));
  if (!base.length || base.length !== after.length) return null;
  const out = { base: {}, after: {}, change: {}, agrees: {}, runs: base.length };
  for (const k of [...KEYS, 'away']) {
    const b = base.map(r => r[k]).filter(Number.isFinite), a = after.map(r => r[k]).filter(Number.isFinite);
    out.base[k] = mean(b);
    out.after[k] = mean(a);
    const diffs = base.map((r, i) => after[i][k] - r[k]).filter(Number.isFinite);
    out.change[k] = diffs.length ? mean(diffs) : null;
    out.agrees[k] = diffs.length > 0 && (diffs.every(d => d > 0) || diffs.every(d => d < 0));
  }
  return out;
}

const money = v => `$${Math.round(v).toLocaleString('en-US')}`;
const FORMAT = {
  revenue: { label: 'Revenue', value: money, change: d => `${d < 0 ? '−' : '+'}${money(Math.abs(d))}`, tiny: 1 },
  seated: { label: 'Customers seated', value: v => Math.round(v).toLocaleString('en-US'), change: d => `${d < 0 ? '−' : '+'}${Math.abs(Math.round(d))}`, tiny: 0.5 },
  stay: { label: 'Average stay', value: v => `${Math.round(v)} min`, change: d => `${d < 0 ? '−' : '+'}${Math.abs(Math.round(d))} min`, tiny: 0.5 },
  returning: { label: 'Returning customers', value: v => `${Math.round(100 * v)}%`, change: d => `${d < 0 ? '−' : '+'}${Math.abs(Math.round(100 * d))} points`, tiny: 0.005 }
};

// The four numbers, before and after: [{ key, label, base, after, change }]. `change` is words: the difference when
// every run agrees and it is large enough to show, otherwise "about the same".
export function figureRows(cmp) {
  if (!cmp) return [];
  return KEYS.map(k => {
    const f = FORMAT[k], b = cmp.base[k], a = cmp.after[k], d = cmp.change[k];
    const show = v => (Number.isFinite(v) ? f.value(v) : 'n/a');
    const moved = cmp.agrees[k] && Number.isFinite(d) && Math.abs(d) >= f.tiny && show(b) !== show(a);
    return { key: k, label: f.label, base: show(b), after: show(a), change: moved ? f.change(d) : 'about the same', moved };
  });
}

// For the chart of a period longer than one day: per day, the mean over the runs of people seated who had been
// before, people seated for the first time, and people turned away, before and after.
export function dayBars(result, n) {
  const side = runs => Array.from({ length: n }, (_, d) => {
    const days = (runs || []).map(r => r[d]).filter(Boolean);
    const m = f => mean(days.map(f)) || 0;
    return { returning: m(x => x.seated - x.fresh), fresh: m(x => x.fresh), away: m(x => x.away) };
  });
  return { base: side(result?.series?.base), after: side(result?.series?.after) };
}

// "Over 2 months, with two more seats: $1,120 more revenue and 32 more customers seated." Only what every run agrees on.
export function ownerHeadline(cmp, change, period) {
  if (!cmp) return '';
  const said = [];
  if (cmp.agrees.revenue && Math.abs(cmp.change.revenue) >= 1) said.push(`${money(Math.abs(cmp.change.revenue))} ${cmp.change.revenue > 0 ? 'more' : 'less'} revenue`);
  if (cmp.agrees.seated && Math.abs(Math.round(cmp.change.seated)) >= 1) said.push(`${Math.abs(Math.round(cmp.change.seated))} ${cmp.change.seated > 0 ? 'more' : 'fewer'} customers seated`);
  return said.length ? `Over ${period}, ${change.name} means ${said.join(' and ')}.` : `Over ${period}, ${change.name} makes no clear difference.`;
}

export const cautionWords = result => `Simulated customers with assumed visit rates, ${result?.runs > 1 ? `averaged over ${result.runs} runs` : 'one run'}. Trust the direction more than the size.`;
