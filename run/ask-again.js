// Ask Jev one recorded choice again (docs/PROTOTYPE.md §9c): once exactly as it was recorded, and once with one
// more sentence about what has just happened to the person. The difference between the two is what the sentence
// did, because both are asked now, with the options in the same order. The recorded answer is given for reference.
// The sentence goes into `now`, what the person is told is happening: a probe on Nov 15 found Jev answers a
// sentence there more clearly than the same sentence added to who the person is (§9c).
import { JevProvider } from '../providers/index.js';

export const TODAY_MIN = 3, TODAY_MAX = 240;

// What the viewer typed, as one plain sentence.
export function cleanToday(text) {
  return typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

// What the person is told is happening, with the sentence added as something that has just happened.
export function withToday(now, today) {
  const sentence = cleanToday(today).replace(/[.!?\s]+$/, '');
  return `${String(now || '').trim()} Just now: ${sentence}.`.trim();
}

const view = d => ({
  yesProb: Number.isFinite(d?.yesProb) ? d.yesProb : null,
  choiceProbs: d?.choiceProbs && typeof d.choiceProbs === 'object' ? d.choiceProbs : null,
  frustration: Number.isFinite(d?.frustration?.expected) ? d.frustration.expected : null
});
const answered = v => v.yesProb != null || v.choiceProbs != null;

/**
 * @param {object} recorded  one line of a run's decisions.jsonl (with its observation)
 * @param {string} today     the sentence to add
 * @param {{ spec?: object, fetch?: Function, apiKey?: string, model?: string }} opts
 * @returns {Promise<{ decision, today, now, recorded, again, changed, model }>} each of recorded / again / changed
 *   is { yesProb, choiceProbs, frustration }; `again` and `changed` were asked now.
 */
export async function askAgain(recorded, today, { spec = null, fetch, apiKey = process.env.TYPESAFE_API_KEY, model } = {}) {
  const sentence = cleanToday(today);
  if (sentence.length < TODAY_MIN || sentence.length > TODAY_MAX) throw Object.assign(new Error(`Write what happened in ${TODAY_MIN} to ${TODAY_MAX} characters.`), { code: 'BAD_TODAY' });
  if (!recorded?.observation?.person) throw Object.assign(new Error('This choice was recorded without what the person was told.'), { code: 'NO_OBSERVATION' });
  const { decision: was, applied, ...req } = recorded;
  const changed = structuredClone(req);
  changed.id = `${req.id}-changed`;
  changed.observation.now = withToday(req.observation.now, sentence);
  // The same option order for both, so the order cannot be what moves the answer.
  const provider = new JevProvider({ apiKey, shuffle: false, ...(fetch ? { fetch } : {}), ...(model ? { model } : {}) });
  const [a, b] = await provider.decideMany([{ ...req, id: `${req.id}-again` }, changed], { spec });
  const again = view(a), after = view(b);
  if (!answered(again) || !answered(after)) throw Object.assign(new Error(a?.error || b?.error || 'Jev did not answer.'), { code: 'NO_ANSWER' });
  return {
    decision: recorded.id, today: sentence, now: changed.observation.now,
    recorded: view(was), again, changed: after, model: b?.model || a?.model || null
  };
}
