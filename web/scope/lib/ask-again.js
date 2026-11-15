// "Tell Jev what just happened, and ask again" in the person view (docs/PROTOTYPE.md §9c): the words and numbers.
// The viewer writes one sentence about what has just happened to the person; the server asks Jev the person's
// recorded choice twice, as recorded and with the sentence, and this file says what moved. ask-panel.js builds the DOM.

// Sentences that fit anyone, for one click.
export const ASK_PRESETS = [
  'In no hurry tonight and happy to wait',
  'Had an awful day and has no patience left',
  'Has to be home in half an hour'
];

// Two asks of the same question differ by a few points; for one person a change under 15 can still be chance.
export const POINTS_NONE = 5, POINTS_SMALL = 15;
const FEELING = ['calm', 'mildly annoyed', 'frustrated', 'very frustrated', 'furious'];
const pts = p => Math.round(100 * p);
const pct = p => (Number.isFinite(p) ? `${pts(p)}%` : 'n/a');

// The choice to ask again: the person's last choice at or before the time on the slider, else their first.
// Only a choice recorded with what the person was told can be asked again.
export function targetChoice(decisions, agentId, t) {
  const own = (decisions || []).filter(d => d.agentId === agentId && d.observation?.person);
  if (!own.length) return null;
  const past = own.filter(d => d.t <= t);
  return past.length ? past[past.length - 1] : own[0];
}

// One row per answer: "Yes" for a yes/no question, or each option of a choice.
// Each row: { key, label, recorded, again, changed } as probabilities (null when missing).
export function askRows(decision, result) {
  const of = (v, k) => (k === 'yes' ? v?.yesProb : v?.choiceProbs?.[k]);
  const num = x => (Number.isFinite(x) ? x : null);
  // A yes/no question can carry a follow-up choice (where to go if not); the yes/no answer is the one that counts.
  const yesNo = Boolean(decision?.asks?.yesNo) && Number.isFinite(result?.again?.yesProb);
  const keys = yesNo || !result?.again?.choiceProbs
    ? [['yes', 'Yes']]
    : (decision.options || []).map(o => [String(o.key), o.label || String(o.key)]);
  return keys.map(([key, label]) => ({
    key, label, recorded: num(of(result?.recorded, key)), again: num(of(result?.again, key)), changed: num(of(result?.changed, key))
  }));
}

// What the sentence did, in words. question: "Keep waiting at Table?" (panels.js). Returns { size, headline, feeling, note }.
//   size: 'clear' (15 points or more), 'small' (5 to 14) or 'none'.
export function askWords(decision, result, { question = 'the question' } = {}) {
  const rows = askRows(decision, result).filter(r => r.again != null && r.changed != null);
  if (!rows.length) return null;
  // A yes/no question has one row. A choice follows the option that moved most.
  const row = rows.reduce((best, r) => (Math.abs(r.changed - r.again) > Math.abs(best.changed - best.again) ? r : best), rows[0]);
  const d = pts(row.changed) - pts(row.again), n = Math.abs(d);
  const size = n >= POINTS_SMALL ? 'clear' : n >= POINTS_NONE ? 'small' : 'none';
  const what = row.key === 'yes' ? `“${question}” Yes` : row.label;
  const pair = `${pct(row.again)} without your sentence, ${pct(row.changed)} with it`;
  const headline = size === 'clear' ? `${what}: ${pair}. ${d > 0 ? 'More' : 'Less'} likely by ${n} points.`
    : size === 'small' ? `${what}: ${pair}. A change this small can be chance.`
      : `${what}: ${pair}. No real change.`;
  const fa = result?.again?.frustration, fb = result?.changed?.frustration;
  const word = x => FEELING[Math.max(0, Math.min(4, Math.round(x)))];
  const feeling = Number.isFinite(fa) && Number.isFinite(fb)
    ? (word(fa) === word(fb) ? `Feeling ${word(fb)} either way.` : `Feeling ${word(fa)} without it, ${word(fb)} with it.`) : '';
  const was = Number.isFinite(row.recorded) ? ` That evening the recorded answer was ${pct(row.recorded)}.` : '';
  return {
    size, headline, feeling,
    note: `Both were asked just now, with nothing else changed.${was} Jev does not answer the same question the same way twice, so a few points either way is noise.`
  };
}

export const rowWords = r => ({ label: r.label, recorded: pct(r.recorded), again: pct(r.again), changed: pct(r.changed) });
