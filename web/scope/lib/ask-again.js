// "Tell Jev what just happened, and ask again" in the person view (docs/PROTOTYPE.md §9c): the words and numbers.
// The viewer writes one sentence about what has just happened to the person. The server asks Jev, twice each:
// do they stay to eat here tonight, and (where the place has a pool of diners) do they come back next week. The two
// versions differ only in the last sentence, the viewer's or a neutral one. This file says what moved.
// ask-panel.js builds the DOM.

// Sentences that fit anyone, for one click: a kindness, a slight, and a pull from elsewhere.
export const ASK_PRESETS = [
  'The host apologises warmly and brings something on the house',
  'The host snaps that anyone who cannot wait should eat elsewhere',
  'A text arrives: they are needed at home in half an hour'
];

// Two asks of the same version differ by a few points: on Nov 15, some 20 repeats of unchanged versions stayed
// within 4 points of each other. Under 5 is called no change, 5 to 9 small, and 10 or more is stated.
export const POINTS_NONE = 5, POINTS_SMALL = 10;
const pts = p => Math.round(100 * p);
const pct = p => (Number.isFinite(p) ? `${pts(p)}%` : 'n/a');
export const sizeOf = change => (Math.abs(change) >= POINTS_SMALL ? 'clear' : Math.abs(change) >= POINTS_NONE ? 'small' : 'none');

// The moment to ask about: the person's last choice at or before the time on the slider, else their first.
// Only a choice recorded with what the person was told can be asked again.
export function targetChoice(decisions, agentId, t) {
  const own = (decisions || []).filter(d => d.agentId === agentId && d.observation?.person);
  if (!own.length) return null;
  const past = own.filter(d => d.t <= t);
  return past.length ? past[past.length - 1] : own[0];
}

// One row per question that was answered both ways: { key, label, again, changed, change (points), size }.
export function askRows(result, { backLabel = 'Comes back next week' } = {}) {
  const row = (key, label, pair) => {
    const a = pair?.again?.yes, b = pair?.changed?.yes;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const change = pts(b) - pts(a);
    return { key, label, again: a, changed: b, change, size: sizeOf(change) };
  };
  return [row('tonight', 'Stays to eat here tonight', result?.tonight), row('back', backLabel, result?.back)].filter(Boolean);
}

// What the sentence did, in words: { size, headline, feeling, note }. The headline follows the answer that moved most.
export function askWords(result, opts = {}) {
  const rows = askRows(result, opts);
  if (!rows.length) return null;
  const lead = rows.reduce((best, r) => (Math.abs(r.change) > Math.abs(best.change) ? r : best), rows[0]);
  const pair = `${pct(lead.again)} without your sentence, ${pct(lead.changed)} with it`, n = Math.abs(lead.change);
  const headline = lead.size === 'clear' ? `${lead.label}: ${pair}. ${lead.change > 0 ? 'More' : 'Less'} likely by ${n} points.`
    : lead.size === 'small' ? `${lead.label}: ${pair}. A small change, and it can be chance.`
      : `No real change. ${lead.label}: ${pair}.`;
  const fa = result?.tonight?.again?.feeling, fb = result?.tonight?.changed?.feeling;
  const feeling = fa && fb ? (fa === fb ? `Feels ${fb} either way.` : `Feels ${fa} without it, ${fb} with it.`) : '';
  return {
    size: lead.size, headline, feeling,
    note: 'All of it was asked just now. The two versions differ only in their last sentence: yours, or “nothing else has happened”. A few points either way is noise.'
  };
}

const signed = n => (n === 0 ? 'no change' : `${n > 0 ? '+' : '−'}${Math.abs(n)}`);
export const rowWords = r => ({ label: r.label, again: pct(r.again), changed: pct(r.changed), change: signed(r.change), size: r.size });

// The same sentence asked of several people: one line each, the largest change first.
// list: [{ name, about, result }] -> [{ name, about, again, changed, change, points, size, feeling }]
export function everyoneRows(list) {
  return (list || []).map(({ name, about, result }) => {
    const r = askRows(result)[0];
    if (!r) return null;
    const fa = result.tonight.again.feeling, fb = result.tonight.changed.feeling;
    return {
      name, about: about || '', again: pct(r.again), changed: pct(r.changed), change: signed(r.change), points: r.change, size: r.size,
      feeling: fa && fb && fa !== fb ? `${fa} to ${fb}` : fb || ''
    };
  }).filter(Boolean).sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
}
