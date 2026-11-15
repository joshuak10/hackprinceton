// Ask Jev about one person again (docs/PROTOTYPE.md §9c), with one more sentence about what has just happened
// to them. Two things are asked, each twice, all four right now:
//   tonight: at the moment of one of their recorded choices, do they stay to eat here?
//   back:    a week later, remembering this evening, do they come again? (when the place has a pool of diners)
// The pair differs only in the last sentence: the viewer's, or a neutral one. A neutral sentence in the unchanged
// version matters, because adding any sentence at all moved the answer by about 5 points (judged Nov 15).
// "Stay to eat here" is asked in place of the recorded "join the line?", so that good news about a seat ("your
// table is ready") cannot read as a no. The options go in the same order in both.
import { JevProvider } from '../providers/index.js';
import { morningRequest } from './morning.js';
import { normalizePool, rememberedWait } from './days.js';

export const TODAY_MIN = 3, TODAY_MAX = 240;
// Each version of tonight's question is asked this many times: the answer is their mean, and the feeling is the
// word most of them gave. One ask of the feeling flipped between words for the same unchanged question (judged Nov 15).
export const REPEATS = 3;
const NEUTRAL_NOW = 'Nothing else has happened';
const NEUTRAL_EVENING = 'Nothing else happened that evening';

// What the viewer typed, as one plain sentence.
export function cleanToday(text) {
  return typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
}
const bare = text => cleanToday(text).replace(/[.!?\s]+$/, '');

// What the person is told is happening, with the sentence added as something that has just happened.
export function withToday(now, today) {
  return `${String(now || '').trim()} Just now: ${bare(today)}.`.trim();
}

// The person's evening in the words a memory uses (engine/observe.js): seated or not, and after how long.
// agent: the run's record of them ({ served, waitTotal }). shopName: "the sushi restaurant".
export function eveningWords(agent, shopName) {
  const wait = rememberedWait(Number(agent?.waitTotal) || 0), served = Number(agent?.served) > 0;
  if (served) return wait < 1 ? `no wait at ${shopName}, seated right away` : `waited about ${wait} minutes for a seat at ${shopName}, then was seated`;
  return wait < 1 ? `found people waiting for a seat at ${shopName} and left without eating` : `waited about ${wait} minutes for a seat at ${shopName}, then left without eating`;
}

const top = probs => (probs && typeof probs === 'object' ? Object.entries(probs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null : null);
const view = d => ({
  yes: Number.isFinite(d?.yesProb) ? d.yesProb : null,
  feeling: top(d?.feelingProbs),
  frustration: Number.isFinite(d?.frustration?.expected) ? d.frustration.expected : null
});

/**
 * @param {object} recorded  one line of a run's decisions.jsonl (with its observation): the moment asked about
 * @param {string} today     the sentence to add
 * @param {{ spec?: object, agent?: object, pool?: object, fetch?: Function, apiKey?: string, model?: string }} opts
 *   agent: the run's record of the person; pool: the place's pool of diners (raw), for the come-back question.
 * @returns {Promise<{ decision, today, now, tonight: { again, changed }, back: { again, changed, memory } | null, model }>}
 *   again / changed: { yes, asks, spread, feeling, frustration }, from REPEATS asks; `back` has yes only, asked once.
 */
export async function askAgain(recorded, today, { spec = null, agent = null, pool = null, fetch, apiKey = process.env.TYPESAFE_API_KEY, model } = {}) {
  const sentence = cleanToday(today);
  if (sentence.length < TODAY_MIN || sentence.length > TODAY_MAX) throw Object.assign(new Error(`Write what happened in ${TODAY_MIN} to ${TODAY_MAX} characters.`), { code: 'BAD_TODAY' });
  if (!recorded?.observation?.person) throw Object.assign(new Error('This choice was recorded without what the person was told.'), { code: 'NO_OBSERVATION' });
  const { decision: was, applied, auto, ...req } = recorded;
  const tonight = text => {
    const r = structuredClone(req);
    r.asks = { yesNo: 'stay_tonight', choice: null, frustration: true, feeling: true, tellOthers: false };
    r.options = [];
    r.observation.now = withToday(req.observation.now, text);
    return r;
  };
  const tonightPair = [{ ...tonight(NEUTRAL_NOW), id: `${req.id}-again` }, { ...tonight(sentence), id: `${req.id}-changed` }];
  const backPair = [];

  // A week later: the same person, remembering this evening as it went, with and without the sentence.
  let memory = null;
  const mind = spec?.minds?.find(m => m.id === recorded.personaId);
  if (pool && mind && agent && spec?.mode === 'visit') {
    const shopRef = normalizePool(pool).shopRef;
    const base = eveningWords(agent, shopRef?.name || 'this place');
    const back = text => morningRequest({
      spec, shopId: shopRef, mind, id: `${req.id}-back`,
      state: { history: { visits: Math.max(1, Number(agent.served) || 0), weeks: 4 }, memory: [{ daysAgo: 7, text: `${base}. ${bare(text)}` }] }
    });
    memory = base;
    backPair.push({ ...back(NEUTRAL_EVENING), id: `${req.id}-back-again` }, { ...back(sentence), id: `${req.id}-back-changed` });
  }

  // A provider answers an identical request once and reuses it, so each repeat has a provider of its own.
  const provider = () => new JevProvider({ apiKey, shuffle: false, ...(fetch ? { fetch } : {}), ...(model ? { model } : {}) });
  const rounds = await Promise.all(Array.from({ length: REPEATS }, (_, k) => provider().decideMany(k === 0 ? [...tonightPair, ...backPair] : tonightPair, { spec })));
  const column = i => rounds.map(r => r[i]).filter(Boolean).map(view);
  const a = together(column(0)), b = together(column(1));
  if (a.yes == null || b.yes == null) throw Object.assign(new Error(rounds[0][0]?.error || rounds[0][1]?.error || 'Jev did not answer.'), { code: 'NO_ANSWER' });
  const c = backPair.length ? view(rounds[0][2]) : null, d = backPair.length ? view(rounds[0][3]) : null;
  return {
    decision: recorded.id, today: sentence, now: tonightPair[1].observation.now,
    tonight: { again: a, changed: b },
    back: memory && c?.yes != null && d?.yes != null ? { again: { yes: c.yes }, changed: { yes: d.yes }, memory } : null,
    model: rounds[0][1]?.model || rounds[0][0]?.model || null
  };
}

// Several asks of one version as one answer: the mean chance, how far the asks were apart, and the feeling most of
// them gave (null when no word was given twice).
export function together(views) {
  const ys = views.map(v => v.yes).filter(Number.isFinite), fr = views.map(v => v.frustration).filter(Number.isFinite);
  const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const counts = new Map();
  for (const v of views) if (v.feeling) counts.set(v.feeling, (counts.get(v.feeling) || 0) + 1);
  const [word, n] = [...counts].sort((x, y) => y[1] - x[1])[0] || [null, 0];
  return {
    yes: mean(ys), asks: ys.length, spread: ys.length ? Math.max(...ys) - Math.min(...ys) : null,
    feeling: n >= 2 || views.length === 1 ? word : null, frustration: mean(fr)
  };
}
