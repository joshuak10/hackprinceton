// The loyalty buttons on the sushi page (docs/PROTOTYPE.md §21f): three changes an owner can try, and for each the
// saved result of two months of the same diners (the multi-day loop, §21). This file holds the words and the
// numbers; verdict-panel.js builds the DOM and app.js wires them.
//
// A saved result comes from GET /api/days: { label, days, runs, provider, effects: { <metric>: { before, after,
// mean, min, max, agrees } } }. `agrees` is true when every run moved the same way. A change is stated only then.
import { outcome } from './layout.js';

// The buttons, the saved result each one shows (matched by its label), and the days command's name for the change.
export const LOYALTY = [
  { id: 'seats', button: 'Two more seats', match: /more seat/i, flag: 'seats+2' },
  { id: 'faster', button: 'Faster turnover at the counter', match: /quicker|faster/i, flag: 'faster15' },
  { id: 'card', button: 'A card for people you turn away', match: /turned away/i, flag: 'sorry' }
];
export const loyaltyChange = id => LOYALTY.find(c => c.id === id) || null;

// The opening state, from the run on screen: who did not get a seat, and what that means for bringing diners back.
export function suggestionWords(metrics) {
  const o = outcome(metrics);
  if (!o.people) return null;
  return {
    headline: o.left > 0 ? `${o.left} of ${o.people} people did not get a seat.` : `All ${o.people} people got a seat.`,
    advice: `Being turned away is what stops diners coming back, far more than a wait or the price. ${o.left > 0 ? 'Try seating more of them before discounting.' : 'Keep seating everyone before discounting.'}`
  };
}

export function savedResult(saved, id) {
  const c = loyaltyChange(id);
  return (c && (saved?.results || []).find(r => c.match.test(r?.label || ''))) || null;
}

// "Friday evening" -> "Friday"; a place open every day has no day name, and its numbers are per week.
const dayWord = meta => (meta?.daysPerWeek === 1 && meta.dayName ? String(meta.dayName).split(/\s+/)[0] : null);
export const perWords = meta => (dayWord(meta) ? `every ${dayWord(meta)}` : 'a week');

const ROWS = [
  ['servedPerWeek', 'People seated', 'count'],
  ['walkAwaysPerWeek', 'Turned away or gave up', 'count'],
  ['avgWait', 'Average wait for a seat', 'minutes'],
  ['firstTimersPerWeek', 'First-time visitors', 'count'],
  ['regulars', 'Regulars', 'count']
];
const round = (kind, v) => (kind === 'minutes' ? Math.round(v * 10) / 10 : Math.round(v));
const unsigned = (kind, v) => (kind === 'minutes' ? `${Math.abs(v).toFixed(1)} min` : Math.abs(v).toLocaleString('en-US'));
const signed = (kind, v) => `${v < 0 ? '−' : '+'}${unsigned(kind, v)}`;
export const valueWords = (kind, v) => (Number.isFinite(v) ? `${round(kind, v) < 0 ? '−' : ''}${unsigned(kind, round(kind, v))}` : 'n/a');

// How one number moved, for the last column. A change is given only where every run agrees, with its range.
//   'none'    nothing moved on any run
//   'clear'   every run moved the same way: "+4", or "+4 to +6"
//   'unclear' the runs disagree: "no clear change"
export function changeOf(kind, e) {
  if (!e || !Number.isFinite(e.min) || !Number.isFinite(e.max)) return { state: 'unclear', words: 'n/a' };
  const lo = round(kind, e.min), hi = round(kind, e.max);
  if (e.min === 0 && e.max === 0) return { state: 'none', words: 'no change' };
  if (!e.agrees) return { state: 'unclear', words: 'no clear change' };
  if (lo === 0 && hi === 0) return { state: 'none', words: 'no change' };            // agrees, but smaller than the rounding
  return { state: 'clear', words: lo === hi ? signed(kind, lo) : `${signed(kind, lo)} to ${signed(kind, hi)}` };
}

// The table: before, after and the change with its range, per Friday.
export function loyaltyRows(result) {
  return ROWS.map(([key, label, kind]) => {
    const e = result?.effects?.[key];
    return { key, label, kind, before: valueWords(kind, e?.before), after: valueWords(kind, e?.after), change: changeOf(kind, e) };
  });
}

// The headline says a change only where every run agrees, most telling first; the second line is always the regulars.
export function loyaltyWords(id, result, meta) {
  const c = loyaltyChange(id);
  if (!c || !result) return null;
  const per = perWords(meta), e = result.effects || {};
  const clear = (key, kind) => (changeOf(kind, e[key]).state === 'clear' ? round(kind, e[key].mean) : 0);
  const seated = clear('servedPerWeek', 'count'), away = clear('walkAwaysPerWeek', 'count'), wait = clear('avgWait', 'minutes');
  const first = clear('firstTimersPerWeek', 'count');
  const said = [];
  if (seated) said.push(`about ${Math.abs(seated)} ${seated > 0 ? 'more' : 'fewer'} ${Math.abs(seated) === 1 ? 'person' : 'people'} seated ${per}`);
  if (away) said.push(`about ${Math.abs(away)} ${away > 0 ? 'more' : 'fewer'} turned away or giving up`);
  if (!seated && !away && wait) said.push(`the wait for a seat about ${unsigned('minutes', wait)} ${wait > 0 ? 'longer' : 'shorter'}`);
  if (!seated && !away && !wait && first) said.push(`about ${Math.abs(first)} ${first > 0 ? 'more' : 'fewer'} first-time visitors ${per}`);
  const headline = said.length ? `${c.button}: ${said.join(', ')}.` : `${c.button}: no clear change in who gets a seat.`;

  const r = e.regulars, rc = changeOf('count', r);
  const span = r && Number.isFinite(r.before) && Number.isFinite(r.after) ? `${valueWords('count', r.before)} before, ${valueWords('count', r.after)} after` : '';
  const regulars = rc.state === 'clear' ? `Regulars: ${rc.words} (${span}).`
    : rc.state === 'none' ? `Regulars: no change${span ? ` (${valueWords('count', r.before)})` : ''}.`
      : `Regulars: no clear change${span ? ` (${span}; the runs disagree)` : ''}.`;
  return { headline, regulars };
}

// "A regular came on at least 2 of the last 4 Fridays."
export function regularWords(meta) {
  const g = meta?.regular;
  if (!g || !Number.isFinite(g.visits) || !Number.isFinite(g.days)) return '';
  const day = dayWord(meta);
  return `A regular came on at least ${g.visits} of the last ${g.days} ${day ? `${day}s` : 'days'}.`;
}

// Under the table: what the numbers are an average of.
export function captionWords(result, meta) {
  const day = dayWord(meta), n = result?.days, k = result?.runs;
  const span = Number.isFinite(n) ? `${n} ${day ? `${day}s` : 'days'}` : 'the run';
  return `${day ? `Per ${day}` : 'Per week'}, averaged over ${span}${Number.isFinite(k) && k > 1 ? ` and ${k} runs each way` : ''}; the change is the range across runs.`;
}

export function cautionWords(result) {
  const by = result?.provider === 'jev' ? 'Jev decides for each diner' : 'A rule model decides for each diner, which does not read how they feel';
  return `Simulated diners with assumed visit rates. ${by}. The sizes are not validated: read the direction and the range.`;
}

// A result that was never run on this computer: say so, and how to make it.
export function missingWords(id, pool) {
  const c = loyaltyChange(id);
  if (!c) return null;
  return {
    headline: `${c.button}: no saved result on this computer.`,
    why: 'This button shows two months of the same diners, run ahead of time. Run it once (a few minutes, about 10 cents with Jev) and reload.',
    command: `node bin/swarm.js days ${pool} --days 8 --seeds 3 --provider jev --change ${c.flag} --out data/days/${c.id}.json`
  };
}
