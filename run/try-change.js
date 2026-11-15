// A change the owner typed, in their own words (docs/PROTOTYPE.md §21h): which lever it is, and the run that
// tests it over the same days and the same people as the saved baselines.
//
// Words that name a lever the loop has (seats, the speed of a meal, the price, a discount, a stamp card, a card
// for people turned away) become that lever, with the number in the sentence. Anything else is run as something
// the restaurant's customers are told: the sentence reaches the people who already know the place and everyone
// who comes that evening, and Jev weighs it for each of them. Nothing about the room changes in that case.
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { validateWorld } from '../engine/spec.js';
import { makeProvider } from '../providers/index.js';
import { runDays, changeFor, normalizePool, summarize } from './days.js';
import { shopView } from './morning.js';
import { validPool } from './days-saved.js';

export const TEXT_MIN = 3, TEXT_MAX = 160;
const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
const NUM = '(\\d+(?:\\.\\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve)';
const numberOf = s => (s == null ? null : WORDS[String(s).toLowerCase()] ?? Number(s));
const clean = text => (typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '');

/**
 * What a sentence asks for.
 * @returns {{ name: string, understood: string } | { message: string, understood: string }}
 *   name: a change run/days.js knows ("seats+3", "faster20", "price+2", "promo10", "card10", "sorry").
 *   message: the sentence, to be told to customers. understood: how it was read, to show the owner.
 */
export function parseChange(text) {
  const t = clean(text), s = t.toLowerCase();
  const first = re => { const m = re.exec(s); return m ? numberOf(m[1]) : null; };
  if (/\b(sorry|apolog\w*)\b/.test(s) && /\b(card|voucher|note|turned away|could not seat|couldn't seat)\b/.test(s)) {
    return { name: 'sorry', understood: 'a card for anyone turned away, good for a free roll within two weeks' };
  }
  const seats = first(new RegExp(`${NUM}\\s+(?:more|extra|additional|new)\\s+(?:counter\\s+)?(?:seats?|stools?|chairs?|places?)`))
    ?? first(new RegExp(`\\badd(?:ing)?\\s+${NUM}\\s+(?:more\\s+)?(?:counter\\s+)?(?:seats?|stools?|chairs?)`));
  if (seats != null && seats >= 1 && seats <= 12) return { name: `seats+${Math.round(seats)}`, understood: `${Math.round(seats)} more seat${Math.round(seats) === 1 ? '' : 's'} at the counter` };
  if (/\b(faster|quicker|speed(?:ing)? up|shorter (?:meals?|menu|sittings?)|turn (?:tables|seats) (?:faster|quicker))\b/.test(s)) {
    const pct = first(/(\d+)\s*(?:%|percent)/) ?? 15;
    const p = Math.max(1, Math.min(60, Math.round(pct)));
    return { name: `faster${p}`, understood: `each meal at the counter ${p}% quicker` };
  }
  if (/\b(stamp|punch|loyalty)\s*card\b/.test(s) || /\bbuy\s+\S+.*\bfree\b/.test(s)) {
    const buy = first(new RegExp(`\\bbuy\\s+${NUM}`));
    const need = Math.max(2, Math.min(20, Math.round(buy != null ? buy + 1 : 10)));
    return { name: `card${need}`, understood: `a stamp card: buy ${need - 1}, the next is free` };
  }
  if (/\bprices?\b/.test(s) || /\bcharg(?:e|ing)\b/.test(s)) {
    const by = first(/\$\s*(\d+(?:\.\d+)?)/) ?? first(new RegExp(`${NUM}\\s*(?:dollars?|bucks)`));
    const up = /\b(rais\w*|increas\w*|higher|up|more)\b/.test(s), down = /\b(lower\w*|cut\w*|reduc\w*|drop\w*|cheaper|less|down)\b/.test(s);
    if (up !== down) {
      const d = Math.max(0.5, Math.min(30, by ?? 2));
      return { name: `price${up ? '+' : '-'}${d}`, understood: `every price ${up ? 'up' : 'down'} by $${d}` };
    }
  }
  const off = first(/(\d+)\s*(?:%|percent)\s*(?:off|discount)/) ?? (/\b(discount|promotion|promo|happy hour|special offer)\b/.test(s) ? (first(/(\d+)\s*(?:%|percent)/) ?? 20) : null);
  if (off != null) {
    const p = Math.max(1, Math.min(90, Math.round(off)));
    return { name: `promo${p}`, understood: `${p}% off for the first week, heard of by half the street` };
  }
  return { message: t.replace(/[.!?\s]+$/, ''), understood: `customers are told: “${t.replace(/[.!?\s]+$/, '')}”` };
}

// The change as run/days.js takes it. A sentence that names no lever is told to the people who know the place.
export function changeFromText(text, spec, pool, days) {
  const parsed = parseChange(text);
  if (parsed.name) return { parsed, change: changeFor(parsed.name, spec, pool.shopRef, days, pool) };
  const { shop } = shopView(spec, pool.shopRef);
  return {
    parsed,
    change: { from: 0, to: days - 1, label: `Told to customers: ${parsed.message}`, promo: { text: `${shop.name}: ${parsed.message}.`, priceOff: 0, reach: 0, audience: 'customers' } }
  };
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'change';

// The newest saved file for the pool that has baselines: they are reused, so only the change is run.
async function savedBaselines(dir, pool) {
  let names = [];
  try { names = (await readdir(dir)).filter(n => /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.json$/.test(n)); } catch { /* nothing saved */ }
  let best = null;
  for (const name of names) {
    try {
      const file = join(dir, name), info = await stat(file);
      if (!info.isFile() || info.size > 64 * 1024 * 1024) continue;
      const saved = JSON.parse(await readFile(file, 'utf8'));
      if (saved?.pool !== pool || !Array.isArray(saved.baselines) || !saved.baselines.length) continue;
      const at = typeof saved.createdAt === 'string' ? saved.createdAt : info.mtime.toISOString();
      if (!best || saved.baselines.length > best.saved.baselines.length || (saved.baselines.length === best.saved.baselines.length && at > best.at)) best = { saved, at };
    } catch { /* not a result */ }
  }
  return best?.saved || null;
}

/**
 * Run one typed change over the saved baselines' days and seeds, and save it beside them.
 * @param {{ root: string, dir: string, pool: string, text: string, provider?: object, onProgress?: Function }} o
 *   root: the repository; dir: data/days; pool: "pools/<name>.json".
 * @returns {Promise<{ label, understood, ran, file }>} ran: false when this change was already saved.
 */
export async function tryChange({ root, dir, pool, text, provider = null, onProgress = null }) {
  const sentence = clean(text);
  if (sentence.length < TEXT_MIN || sentence.length > TEXT_MAX) throw Object.assign(new Error(`Describe the change in ${TEXT_MIN} to ${TEXT_MAX} characters.`), { code: 'BAD_TEXT' });
  if (!validPool(pool)) throw Object.assign(new Error('Name the pool as pools/<name>.json.'), { code: 'BAD_POOL' });
  const rawPool = JSON.parse(await readFile(join(root, pool), 'utf8'));
  if (typeof rawPool.world !== 'string' || !/^worlds\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.json$/.test(rawPool.world)) throw new Error('The pool names no world.');
  const checked = validateWorld(JSON.parse(await readFile(join(root, rawPool.world), 'utf8')));
  if (!checked.ok) throw new Error('The pool\'s world is not valid.');
  const spec = checked.spec, normal = normalizePool(rawPool);

  const base = await savedBaselines(dir, pool);
  if (!base) throw Object.assign(new Error('No saved baselines for this place on this computer. Run the days command once first.'), { code: 'NO_BASELINES' });
  const days = base.days, baselines = base.baselines.filter(b => b.run?.days?.length === days);
  const { parsed, change } = changeFromText(sentence, spec, normal, days);

  // Already run on these baselines: nothing to do.
  const existing = await findSaved(dir, pool, change.label);
  if (existing) return { label: change.label, understood: parsed.understood, ran: false, file: existing };

  const jev = provider || makeProvider('jev', { maxRequests: 200000 });
  let done = 0;
  // The runs are independent, so they go side by side.
  const arms = await Promise.all(baselines.map(async b => {
    const run = await runDays({ pool: rawPool, spec, days, seed: b.seed, provider: jev, change, centers: b.run.centers, onDay: () => onProgress?.({ done: ++done, total: baselines.length * days }) });
    return { seed: b.seed, run, summary: summarize(run) };
  }));
  const file = `try-${slug(change.label)}.json`;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), JSON.stringify({
    createdAt: new Date().toISOString(), pool, provider: 'jev', providerStats: jev.stats?.() ?? null, typed: sentence,
    days, seeds: baselines.map(b => b.seed), baselines, results: [{ change: { label: change.label, from: change.from, to: change.to }, arms, effects: {} }]
  }));
  return { label: change.label, understood: parsed.understood, ran: true, file };
}

async function findSaved(dir, pool, label) {
  let names = [];
  try { names = (await readdir(dir)).filter(n => n.endsWith('.json')); } catch { return null; }
  for (const name of names) {
    try {
      const info = await stat(join(dir, name));
      if (!info.isFile() || info.size > 64 * 1024 * 1024) continue;
      const saved = JSON.parse(await readFile(join(dir, name), 'utf8'));
      if (saved?.pool === pool && (saved.results || []).some(r => r?.change?.label === label)) return name;
    } catch { /* skip */ }
  }
  return null;
}
