// The verdict: which line is worst, what the one tested change did, and why (docs/PROTOTYPE.md §9b).
// Pure functions over run files. No DOM here; lib/verdict-panel.js draws what these return.
//
// The one change the display tests is a fixed rule, not AI: one more staff at the counter with the worst line.
// The engine's field for staff is `servers`; only the display says "staff". A place whose case asks for it (the
// sushi restaurant) tests a promotion instead (§18): its places have one staff per seat, so one more staff there
// would be a seat with no chair.
import { clockText } from './frames.js';
import { outcome } from './layout.js';

const provider = meta => meta?.providerStats?.provider || meta?.provider;
export const isJev = meta => provider(meta) === 'jev' || provider(meta) === 'replay';

// Who made a run's decisions, in the words the main view uses.
export function providerWords(meta) {
  if (isJev(meta)) return 'Jev';
  return provider(meta) === 'mock' ? 'Sample data' : 'Rule model';
}

// A name people would say for the place, from the world's title. Listing names ("Office/Retail - 45,726SF")
// are not used. "Weekday lunch on the ground floor: food hall and market (proposed fit-out)" → "Food hall and market".
export function placeName(spec) {
  if (typeof spec?.placeName === 'string' && spec.placeName.trim()) return spec.placeName.trim();
  const title = String(spec?.title || '').trim();
  if (!title) return 'This place';
  const part = (title.includes(':') ? title.slice(title.indexOf(':') + 1) : title).replace(/\s*\([^)]*\)/g, '').trim() || title;
  return part.charAt(0).toUpperCase() + part.slice(1);
}

const isPromotion = change => change?.kind === 'promotion';
const percent = change => `${Math.round((change?.off || 0) * 100)}%`;

// The change in two words: "+1 staff", or "The promotion".
export function changeWords(change) {
  if (isPromotion(change)) return 'The promotion';
  const n = (change?.to ?? 0) - (change?.from ?? 0);
  return `${n > 0 ? '+' : '−'}${Math.abs(n)} staff`;
}
// "Baseline", "+1 staff at Lucky Noodle Bar", "Promotion, 20% off", or '' for a run that is not part of a test.
export function runLabel(meta) {
  const link = meta?.link;
  if (!link?.change) return '';
  if (link.role !== 'change') return 'Baseline';
  return isPromotion(link.change) ? `Promotion, ${percent(link.change)} off` : `${changeWords(link.change)} at ${link.change.nodeName}`;
}

// ---------- which run opens, and which test belongs to it ----------

const newestFirst = (a, b) => String(b.meta.createdAt).localeCompare(String(a.meta.createdAt)) || String(b.meta.runId).localeCompare(String(a.meta.runId));

// The run the page opens with: the latest Jev run if there is one, otherwise the latest rule-model run.
// A run that carries a tested change is never the opening run; its baseline is.
export function chooseRun(runs) {
  const list = [...(runs || [])].sort(newestFirst);
  const plain = list.filter(r => r.meta.link?.role !== 'change');
  return plain.find(r => isJev(r.meta)) || plain[0] || list[0] || null;
}

// The newest finished test that belongs to the run on screen: the run is one of its runs, or its baselines ran
// the same world (same spec hash). A test counts once it has `need` seeds with both sides done.
// Returns { id, change, pairs: [{ seed, baseline, change }] } with run ids, pairs in the order they were started.
export function findTest(metas, { runId = null, specHash = null } = {}, need = 3) {
  const tests = new Map();
  for (const m of metas || []) {
    const l = m.link;
    if (!l?.test || !l.change || m.status !== 'done') continue;
    if (!tests.has(l.test)) tests.set(l.test, { id: l.test, change: l.change, sides: new Map(), ids: new Set(), hash: null, at: '' });
    const t = tests.get(l.test);
    const side = t.sides.get(m.seed) || {};
    side[l.role === 'change' ? 'change' : 'baseline'] = m;
    t.sides.set(m.seed, side);
    t.ids.add(m.runId);
    if (l.role !== 'change') t.hash = m.specHash;
    if (String(m.createdAt) > t.at) t.at = String(m.createdAt);
  }
  let best = null;
  for (const t of tests.values()) {
    const pairs = [...t.sides.entries()].filter(([, s]) => s.baseline && s.change)
      .sort((a, b) => String(a[1].baseline.createdAt).localeCompare(String(b[1].baseline.createdAt)))
      .map(([seed, s]) => ({ seed, baseline: s.baseline.runId, change: s.change.runId }));
    if (pairs.length < need) continue;
    if (!(t.ids.has(runId) || (specHash && t.hash === specHash))) continue;
    if (!best || t.at > best.at) best = { id: t.id, change: t.change, pairs, at: t.at };
  }
  return best && { id: best.id, change: best.change, pairs: best.pairs };
}

// ---------- the one change ----------

// Per-place numbers: `metrics.nodes` in engine runs, `metrics.bottlenecks` in the sample data.
const placeRows = metrics => metrics?.nodes || metrics?.bottlenecks || [];

// One more staff at the place with the highest bottleneck score in the run's metrics (wait minutes plus 30 for
// each person who walked away), or the first place with a line when there are no metrics.
export function staffChange(spec, metrics) {
  const places = (spec?.nodes || []).filter(n => n.kind === 'service');
  if (!places.length) return null;
  const scored = placeRows(metrics).filter(m => places.some(p => p.id === m.id)).sort((a, b) => (b.score || 0) - (a.score || 0));
  const node = places.find(p => p.id === scored[0]?.id) || places[0];
  const from = Number(node.servers) || 1;
  return { kind: 'staff', nodeId: node.id, nodeName: node.name || node.id, from, to: from + 1 };
}

// The sushi restaurant's change: a promotion told to everyone who comes in, with `off` taken off every price.
const PROMOTION_OFF = 0.2;
export const promotionChange = (off = PROMOTION_OFF) => ({ kind: 'promotion', off });

// The change a place tests: the promotion where its case asks for one ("suggestion": "promotion" in
// mock/index.json), otherwise one more staff at the worst line. Null when the world has no place with a line.
export function changeFor(caseInfo, spec, metrics) {
  if (caseInfo?.suggestion !== 'promotion') return staffChange(spec, metrics);
  return (spec?.nodes || []).some(n => n.kind === 'service') ? promotionChange() : null;
}

// The promotion as offers (§15b): the message for everyone, and the discount at each place, so the price a person
// is told and pays is the promotion price. A person is shown three offers at most, so two places at most.
function promotionOffers(spec, change) {
  const pct = percent(change);
  const places = (spec?.nodes || []).filter(n => n.kind === 'service').slice(0, 2);
  return [
    { id: 'promotion', text: `Promotion today: ${pct} off everything for everyone who comes in.` },
    ...places.map(p => ({ id: `promotion_${p.id}`, text: `${pct} off at ${p.name || p.id} today`, place: p.id, priceOff: change.off }))
  ];
}

// The world with the change applied. The input is not changed.
export function applyChange(spec, change) {
  const out = JSON.parse(JSON.stringify(spec));
  if (isPromotion(change)) {
    out.offers = [...(out.offers || []).filter(o => !String(o.id).startsWith('promotion')), ...promotionOffers(spec, change)];
    return out;
  }
  const node = (out.nodes || []).find(n => n.id === change.nodeId);
  if (!node) throw new Error(`This world has no place "${change.nodeId}" to change.`);
  node.servers = change.to;
  return out;
}

// ---------- words ----------

const people = n => `${n} ${n === 1 ? 'person' : 'people'}`;
// "9.2 min", "4 min", "12 min".
const minutes = v => `${(Math.round(v * 10) / 10).toFixed(Math.abs(v) >= 10 ? 0 : 1).replace(/\.0$/, '')} min`;

// "over lunch" when the run sits around midday, otherwise its clock times.
export function windowWords(clockStart, duration) {
  if (!Number.isFinite(clockStart) || !Number.isFinite(duration)) return 'in this run';
  const mid = (clockStart + duration / 2) % 1440;
  if (mid >= 660 && mid <= 840 && duration <= 300) return 'over lunch';
  return `from ${clockText(clockStart, 0)} to ${clockText(clockStart, duration)}`;
}
// What a run replays, in one word: "lunch", "evening", "morning" or "afternoon".
export function windowNoun(clockStart, duration) {
  if (!Number.isFinite(clockStart) || !Number.isFinite(duration)) return 'day';
  const mid = (clockStart + duration / 2) % 1440;
  return mid >= 660 && mid <= 840 ? 'lunch' : mid >= 1020 ? 'evening' : mid < 660 ? 'morning' : 'afternoon';
}

// Before a test: the worst line in words, and the reason in one sentence.
// → { nodeId, headline, why } or null when the run has no places with a line.
export function worstLineWords(spec, metrics, { clockStart, duration } = {}) {
  const change = staffChange(spec, metrics);
  if (!change) return null;
  const rows = placeRows(metrics);
  const m = rows.find(r => r.id === change.nodeId);
  const node = (spec.nodes || []).find(n => n.id === change.nodeId);
  const name = change.nodeName, when = windowWords(clockStart, duration);
  if (!m) return { nodeId: change.nodeId, headline: `${name} is the first place with a line.`, why: 'This run has no numbers for it yet.' };
  const lost = Math.round(m.abandoned || 0);
  const most = rows.every(r => (r.abandoned || 0) <= (m.abandoned || 0));
  const headline = lost > 0 && most ? `${name} loses the most people: ${lost} walked away ${when}.`
    : lost > 0 ? `${name} has the worst line: ${lost} walked away ${when}, and the wait averaged ${minutes(m.avgWait || 0)}.`
      : `${name} has the longest waits: ${minutes(m.avgWait || 0)} on average ${when}. Nobody walked away.`;
  const staff = `${change.from} staff at the counter`;
  const pace = node?.serviceTime > 0 ? `, and an order takes about ${minutes(Number(node.serviceTime))}` : '';
  const line = m.maxQueue > 0 ? ` The line reached ${people(Math.round(m.maxQueue))}.` : '';
  return { nodeId: change.nodeId, headline, why: `It has ${staff}${pace}.${line}` };
}

// Before a test of the promotion: how many people ate, the reason more did not, and what the promotion is.
// Meals are counted when they end, so someone still eating at closing time is not counted.
// → { headline, why, offer } or null when the run has no people.
export function promotionWords(spec, metrics, change, { clockStart, duration } = {}) {
  const o = outcome(metrics);
  if (!o.people) return null;
  const when = windowWords(clockStart, duration);
  const seats = (spec?.nodes || []).filter(n => n.kind === 'service').reduce((k, n) => k + (n.seats?.length || Number(n.servers) || 0), 0);
  return {
    headline: o.left > 0 ? `${o.seated} of ${o.people} people finished a meal ${when}.` : `All ${o.people} people finished a meal ${when}.`,
    why: `The room has ${seats} seats, and the wait for one averaged ${minutes(o.wait)}.`,
    offer: `Try a promotion: ${percent(change)} off everything today, told to everyone who comes in. It gives people a reason to wait, but adds no seats.`
  };
}

// Smallest and largest of a list of numbers.
export function range(values) {
  const v = (values || []).filter(Number.isFinite);
  return v.length ? { min: Math.min(...v), max: Math.max(...v) } : null;
}
// "12 to 16", "14", "up to 5".
export function rangeWords(min, max) {
  const a = Math.round(min), b = Math.round(max);
  if (a === b) return String(a);
  return a === 0 ? `up to ${b}` : `${a} to ${b}`;
}

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const at = (metrics, id, key) => (metrics?.nodes || []).find(n => n.id === id)?.[key];

// The numbers of a finished test. `pairs` = [{ before, after }], the metrics of each seed's two runs.
// → { runs, kept: [per seed: customers kept], rows: [{ label, kind, before, after, change, strong }] }
// Customers kept: fewer walk-aways at the counter for +1 staff; more people who finished a meal for the promotion
// (each person sits once, so meals served are people). Rows are averages over the test runs; `strong` marks the
// rows of that measure.
export function testResult(pairs, change) {
  const ok = (pairs || []).filter(p => p?.before && p?.after);
  const avg = (side, read) => mean(ok.map(p => read(p[side])).filter(Number.isFinite));
  const row = (label, kind, read, strong = false) => {
    // Rounded as shown, so the change column always equals after minus before on screen.
    const shown = v => (v == null ? null : kind === 'minutes' ? Math.round(v * 10) / 10 : Math.round(v));
    const before = shown(avg('before', read)), after = shown(avg('after', read));
    return { label, kind, before, after, change: before == null || after == null ? null : after - before, strong };
  };
  if (isPromotion(change)) {
    const ate = m => outcome(m).seated;
    const places = ok[0]?.before?.nodes || [];
    return {
      runs: ok.length,
      kept: ok.map(p => ate(p.after) - ate(p.before)),
      rows: [
        row('Finished a meal', 'count', ate, true),
        row('Walked away', 'count', m => m.abandoned),
        row('Average wait', 'minutes', m => m.avgWait),
        ...places.map(n => row(`Meals at ${n.name || n.id}`, 'count', m => at(m, n.id, 'served'))),
        row('Told about the promotion', 'count', m => (m.offers || []).find(o => o.id === 'promotion')?.reached ?? 0)
      ]
    };
  }
  const id = change.nodeId;
  return {
    runs: ok.length,
    kept: ok.map(p => (at(p.before, id, 'abandoned') || 0) - (at(p.after, id, 'abandoned') || 0)),
    rows: [
      row('Walked away here', 'count', m => at(m, id, 'abandoned'), true),
      row('Longest line here', 'count', m => at(m, id, 'maxQueue')),
      row('Average wait here', 'minutes', m => at(m, id, 'avgWait')),
      row('Walked away, whole floor', 'count', m => m.abandoned, true)
    ]
  };
}

// A table cell. kind: 'count' | 'minutes'. signed: a change column ("−26", "+1.2 min", "no change").
export function cellWords(kind, v, signed = false) {
  if (v == null || !Number.isFinite(v)) return 'n/a';
  const r = kind === 'minutes' ? Math.round(v * 10) / 10 : Math.round(v);
  const text = kind === 'minutes' ? `${Math.abs(r).toFixed(1)} min` : Math.abs(r).toLocaleString('en-US');
  if (!signed) return r < 0 ? `−${text}` : text;
  return r === 0 ? 'no change' : `${r < 0 ? '−' : '+'}${text}`;
}

// After a test: did the change help, in customers kept (testResult). by: who decided the test runs.
// → { tone: 'helped' | 'none' | 'worse' | 'mixed', headline, detail }
export function verdictWords(result, change, { clockStart, duration, by = 'the rule model' } = {}) {
  const r = range(result?.kept);
  const what = changeWords(change), name = change.nodeName, when = windowWords(clockStart, duration);
  const n = result?.runs || 0;
  const tested = `Tested with ${by}, ${n} ${n === 1 ? 'run' : 'runs'} each way.`
    + (isPromotion(change) && by === 'the rule model' ? ' It sees the lower price, not the message.' : '');
  if (!r) return { tone: 'none', headline: 'The test has no numbers.', detail: tested };
  const a = Math.round(r.min), b = Math.round(r.max);
  const say = isPromotion(change)
    ? {
        same: `The same number of people finished a meal ${when}.`,
        more: (x, one) => `${x} more ${one ? 'person' : 'people'} finished a meal ${when}.`,
        less: (x, one) => `${x} fewer ${one ? 'person' : 'people'} finished a meal ${when}.`,
        split: `Between ${-a} fewer and ${b} more people finished a meal ${when}: the runs disagree.`
      }
    : {
        same: `The same number of people walked away from ${name} ${when}.`,
        more: x => `${x} fewer walk-aways at ${name} ${when}.`,
        less: x => `${x} more walk-aways at ${name} ${when}.`,
        split: `Between ${-a} more and ${b} fewer walk-aways at ${name} ${when}: the runs disagree.`
      };
  const up = text => text.replace(/^u/, 'U');
  if (a === 0 && b === 0) return { tone: 'none', headline: `${what} changed nothing.`, detail: `${say.same} ${tested}` };
  if (a >= 0) {
    return {
      tone: 'helped', headline: `${what} kept ${rangeWords(a, b)} more ${b === 1 ? 'customer' : 'customers'}.`,
      detail: up(`${say.more(rangeWords(a, b), b === 1)} ${tested}`)
    };
  }
  if (b <= 0) return { tone: 'worse', headline: `${what} did not help.`, detail: up(`${say.less(rangeWords(-b, -a), a === -1)} ${tested}`) };
  return { tone: 'mixed', headline: `${what} made no clear difference.`, detail: `${say.split} ${tested}` };
}

// The busiest stretch of a line: the `width`-minute window with the most people waiting on average.
// times: minutes since the start, one per frame; counts: people in line at each. → { start, end } or null.
export function busiestWindow(times, counts, width = 30) {
  const n = Math.min(times?.length || 0, counts?.length || 0);
  if (n < 2) return null;
  let best = null, lo = 0, sum = 0;
  for (let hi = 0; hi < n; hi++) {
    sum += counts[hi] || 0;
    while (times[hi] - times[lo] > width) { sum -= counts[lo] || 0; lo++; }
    const avg = sum / (hi - lo + 1);
    if (!best || avg > best.avg) best = { avg, start: times[lo], end: times[hi] };
  }
  if (!best || best.avg <= 0) return null;
  const five = t => Math.round(t / 5) * 5;
  const start = five(best.start);
  return { start, end: Math.max(start + 5, five(best.end)) };
}

// "12:10 to 12:40 pm", or "11:40 am to 12:10 pm" across noon.
function spanWords(clockStart, t0, t1) {
  const a = clockText(clockStart, t0), b = clockText(clockStart, t1);
  return `${a.slice(-2) === b.slice(-2) ? a.slice(0, -3) : a} to ${b}`;
}

// One plain sentence of cause from the two sides of the test, plus when the line is busiest.
// window: busiestWindow of the baseline line, or null.
export function whySentence(result, change, { clockStart = 0, window = null } = {}) {
  const row = label => (result?.rows || []).find(r => r.label === label) || {};
  if (isPromotion(change)) return promotionWhy(row);
  const line = row('Longest line here'), wait = row('Average wait here');
  const name = change.nodeName;
  const kept = range(result?.kept);
  const helped = kept && Math.round(kept.min) >= 0 && Math.round(kept.max) > 0;
  const lb = Math.round(line.before ?? NaN), la = Math.round(line.after ?? NaN);
  let why;
  if (!Number.isFinite(lb) || !Number.isFinite(la)) why = `The test has no line lengths for ${name}.`;
  else if (helped && la < lb) why = `The longest line at ${name} fell from ${people(lb)} to ${la}, so fewer people saw a long line and left.`;
  else if (helped && wait.before != null && wait.after != null && wait.after < wait.before) {
    why = `The line at ${name} moved faster: the average wait fell from ${minutes(wait.before)} to ${minutes(wait.after)}, so fewer people gave up.`;
  } else if (helped) why = `The longest line at ${name} stayed at ${people(lb)}, but fewer people gave up waiting in it.`;
  else if (la < lb) why = `The longest line at ${name} fell from ${people(lb)} to ${la}, but about as many people still walked away.`;
  else why = `The line at ${name} did not get shorter: ${people(lb)} at its longest before, ${la} after.`;
  const busy = window ? ` It is busiest from ${spanWords(clockStart, window.start, window.end)}.` : '';
  return why + busy;
}

// The promotion's cause: what happened to the people who would have left, and the seats it cannot add.
function promotionWhy(row) {
  const walked = row('Walked away'), wait = row('Average wait');
  const wb = walked.before, wa = walked.after;
  if (!Number.isFinite(wb) || !Number.isFinite(wa)) return 'The test has no walk-aways to compare.';
  const seats = ' It adds no seats, so the room cannot seat many more.';
  if (wa < wb && Number.isFinite(wait.before) && Number.isFinite(wait.after) && wait.after > wait.before) {
    return `People waited for a seat instead of leaving: walk-aways fell from ${wb} to ${wa}, and the average wait rose from ${minutes(wait.before)} to ${minutes(wait.after)}.${seats}`;
  }
  if (wa < wb) return `Fewer people gave up: walk-aways fell from ${wb} to ${wa}.${seats}`;
  if (wa > wb) return `More people gave up: walk-aways rose from ${wb} to ${wa}.`;
  return `As many people gave up: ${wb} walk-aways with and without it.`;
}

// The words around a test: its button, the plan, the progress title and steps, the toggle and the retry.
// by: who decides the test runs ('Jev' or 'the rule model'). noun: what is replayed (windowNoun).
export function testWords(change, { by = 'the rule model', seeds = 3, noun = 'lunch' } = {}) {
  const wait = by === 'Jev' ? 'about a minute' : 'a few seconds';
  if (isPromotion(change)) {
    const sees = by === 'Jev' ? '' : ', which sees the lower price but not the message';
    return {
      action: 'Test the promotion', title: 'Testing the promotion', again: 'Test the promotion again',
      plan: `Plays the same ${noun} ${seeds} times as it is and ${seeds} times with the promotion, decided by ${by}${sees}. It takes ${wait}.`,
      step: (k, total, withIt) => `Run ${k} of ${total}: the ${noun} ${withIt ? 'with the promotion' : 'as it is'}.`,
      toggle: ['Baseline', 'Promotion'], done: 'The test of the promotion is done.', loading: 'Loading the test of the promotion…'
    };
  }
  const what = changeWords(change), where = `${what} at ${change.nodeName}`;
  return {
    action: `Test ${what} here`, title: `Testing ${where}`, again: `Test ${what} again`,
    plan: `Plays the same ${noun} ${seeds} times with ${change.from} staff and ${seeds} times with ${change.to}, using ${by}. It takes ${wait}.`,
    step: (k, total, withIt) => `Run ${k} of ${total}: the ${noun} with ${withIt ? change.to : change.from} staff.`,
    toggle: [`Baseline (${change.from} staff)`, what], done: `The test of ${where} is done.`, loading: `Loading the test of ${where}…`
  };
}
