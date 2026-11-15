// Ask the room (docs/PROTOTYPE.md §17): the page's arithmetic, kept apart from the page so it can be tested
// (test/room.test.js). Everything here works on the answer of POST /api/room/ask.

export const points = d => Math.round(100 * d);

// What one person's answer is compared with:
//   a rewritten person: the same moment with the person as written, which is the rewrite's own effect;
//   under a sign: the same moment with a plain sign, which is the sign's own effect;
//   otherwise: the moment before any change.
// Null when that answer is missing; a sign is never judged against no sign.
export function refOf(p, withSign) {
  if (p.edited && p.written) return { probs: p.written, kind: 'written' };
  if (withSign) return p.neutral ? { probs: p.neutral, kind: 'neutral' } : null;
  return p.before ? { probs: p.before, kind: 'before' } : null;
}

export function changeOf(p, id, withSign) {
  const ref = refOf(p, withSign);
  return p.now && ref ? p.now[id] - ref.probs[id] : null;
}

// 'none' below the room's bar, 'small' below the bar for one person, otherwise 'up' or 'down'.
// Whole points are compared, so a change that reads as 5 is always treated as 5.
export function grade(d, noise, noisePerson) {
  const n = Math.abs(points(d));
  if (n < points(noise)) return 'none';
  if (n < points(noisePerson)) return 'small';
  return d > 0 ? 'up' : 'down';
}

export function sameMoment(a, b) {
  if (!a || !b) return false;
  const places = new Set([...Object.keys(a.ahead || {}), ...Object.keys(b.ahead || {})]);
  for (const k of places) if ((a.ahead?.[k] ?? 0) !== (b.ahead?.[k] ?? 0)) return false;
  return a.shop === b.shop && Math.round(a.price) === Math.round(b.price) && (a.priorPrice ?? null) === (b.priorPrice ?? null) && a.minute === b.minute;
}

// The three shares over the same people: anyone with an answer missing is left out of all of them.
// Used after one person is asked again and merged into the last full answer.
export function recomputeShare(r) {
  const id = r.shop, withSign = Boolean(r.scenario.sign);
  const ok = r.people.filter(p => p.before && p.now && (!withSign || p.neutral));
  const mean = f => (ok.length ? ok.reduce((s, p) => s + f(p), 0) / ok.length : null);
  r.share = { before: mean(p => p.before[id]), now: mean(p => p.now[id]), neutral: withSign ? mean(p => p.neutral[id]) : null };
  return r;
}

// What the headline needs. `movers` are the people past the one-person bar, largest change first.
export function summarize(r) {
  const id = r.shop, withSign = Boolean(r.scenario.sign), noise = r.noise ?? 0.05, noisePerson = r.noisePerson ?? 0.15;
  const moves = [];
  for (const p of r.people) {
    const d = changeOf(p, id, withSign);
    if (d != null) moves.push({ p, d, grade: grade(d, noise, noisePerson) });
  }
  const movers = moves.filter(m => m.grade === 'up' || m.grade === 'down').sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  const from = withSign ? r.share.neutral : r.share.before, to = r.share.now;
  const answered = from != null && to != null;
  const rewritten = r.people.some(p => p.edited);
  const moved = !sameMoment(r.scenario, r.compareTo);
  return {
    id, withSign, noise, noisePerson, from, to, answered, rewritten,
    flat: answered ? Math.abs(points(to - from)) < points(noise) : null,
    movers, still: moves.length - movers.length, asked: moves.length,
    unchanged: !withSign && !rewritten && !moved,      // nothing was changed, so there is no comparison to report
    alsoChanged: withSign && moved,                    // a sign on top of a price or line change
    before: r.share.before
  };
}

// Largest change first; people with the same change keep the order of the cast.
export function byChange(people, id, withSign) {
  const size = p => Math.abs(changeOf(p, id, withSign) ?? 0);
  return people.map((p, i) => ({ p, i })).sort((a, b) => size(b.p) - size(a.p) || a.i - b.i).map(x => x.p);
}

// ---------- next morning (docs/PROTOTYPE.md §17b) ----------
// Everything below works on the answer of POST /api/room/morning. A person's `before` and `now` are the chance
// of going to the shop today: for the record it is compared with, and for the record the page set.

// One person's change. Null when an answer is missing, or when the page changed only things that are not in
// this person's record (someone who has never been inside has no last visit, no last week's price, no card).
export function morningChange(p) {
  return p.applies !== false && p.now != null && p.before != null ? p.now - p.before : null;
}

// What the headline needs. The shares are over the returning customers; `movers` are the people past the
// one-person bar, largest change first, whoever they are.
export function morningSummary(r) {
  const noise = r.noise ?? 0.05, noisePerson = r.noisePerson ?? 0.10;
  const moves = [];
  for (const p of r.people) {
    const d = morningChange(p);
    if (d != null) moves.push({ p, d, grade: grade(d, noise, noisePerson) });
  }
  const movers = moves.filter(m => m.grade === 'up' || m.grade === 'down').sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  const from = r.share.before, to = r.share.now;
  const answered = from != null && to != null;
  return {
    noise, noisePerson, from, to, answered,
    flat: answered ? Math.abs(points(to - from)) < points(noise) : null,
    movers, still: moves.length - movers.length, asked: moves.length,
    regulars: r.people.filter(p => p.returning && p.before != null && p.now != null).length,
    unchanged: !r.changed,                             // the ordinary morning: there is no comparison to report
    compare: r.compare || {}                           // the plain sentences the comparison carries
  };
}

// Largest change first; people with the same change, or with none to show, keep the order of the cast.
export function byMorningChange(people) {
  const size = p => Math.abs(morningChange(p) ?? 0);
  return people.map((p, i) => ({ p, i })).sort((a, b) => size(b.p) - size(a.p) || a.i - b.i).map(x => x.p);
}
