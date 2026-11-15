#!/usr/bin/env node
// Jev return probe (docs/PROTOTYPE.md §20c): does Jev read a customer's memory, and does it answer "do you go
// back today?" the way real customers were measured to?
//
// It asks the morning question (run/morning.js) for the cast of the Alder & Pine café and changes one remembered
// fact at a time: the last wait, whether they were served, how the wait ended, the price, a stamp card, a
// friend's remark, the star rating, a promotion. Every question is asked several times, because Jev does not
// answer the same question the same way twice. Each test compares two conditions person by person and is scored
// against a published field result (REPEAT_CUSTOMERS_SPEC.md §4 and §9).
//
// Usage: node validation/jev-return-probe.js [--repeats 5] [--only <family>] [--out data/validation/jev-return-probe.json]
//        node validation/jev-return-probe.js --from data/validation/jev-return-probe.json   (score saved answers again)
// Needs JEV_API_KEY or TYPESAFE_API_KEY in .env.local. About 2,400 Jev requests at 5 repeats, about 10 cents at
// TypeSafe's published price (unverified). Writes the JSON and a readable .md beside it; both stay out of git.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../engine/env.js';
import { normalizeSpec } from '../engine/spec.js';
import { seedRng } from '../engine/util.js';
import { JevProvider } from '../providers/jev.js';
import { morningRequest, friendRemark, shopView } from '../run/morning.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WORLD = 'worlds/alder-pine-cafe.json';
export const SHOP = 'cafe';
export const SAME_TOLERANCE = 0.05;   // "within 5 points": the room's bar for an average over the cast (§17)
export const READS_MEMORY_MIN = 0.10; // a very good against a very bad last visit must move the cast by this much

// Which states each cast member can be put in without contradicting their written bio, and a visit count for
// the last 4 weeks that fits it. Greta is in town for one day, so she is never a returning customer. The five
// with a standing habit at this café (or a stated liking for it) are never newcomers.
export const CAST = {
  june: { visits: 28 }, marcus: { visits: 40 }, priyanka: { visits: 8 }, tomas: { visits: 3 }, bill: { visits: 20 },
  ellie: { visits: 10, newcomer: true }, dev: { visits: 6, newcomer: true }, karen: { visits: 8, newcomer: true },
  shanice: { visits: 6, newcomer: true }, omar: { visits: 4, newcomer: true }, lucy: { visits: 4, newcomer: true },
  greta: { newcomer: true }
};

// ---------- conditions: what one person remembers this morning ----------

const visit = (wait, outcome = 'served', extra = {}) => ({ daysAgo: 1, wait, outcome, ...extra });
const REF_MEMORY = [visit(5)];
const CARD = { need: 10, reward: 'a free coffee' };

// A returning customer: their visit count, the reference memory (served after 5 minutes yesterday), and `over`.
const back = (over = () => ({})) => (p, S) => ({ history: { visits: p.visits, weeks: 4 }, memory: REF_MEMORY, ...over(S) });
// Someone who has never been inside.
const fresh = (over = () => ({})) => (p, S) => ({ history: { visits: 0, via: 'has walked past it' }, ...over(S) });
// Someone whose only visit was 4 days ago.
const once = first => () => ({ history: { visits: 1 }, memory: [{ daysAgo: 4, first: true, wait: 5, outcome: 'served', ...first }] });

const mem = records => () => ({ memory: records });
const said = text => S => ({ memory: [{ daysAgo: 1, text: text(S) }] });
const days = waits => waits.map((w, i) => ({ daysAgo: i + 1, wait: w, outcome: 'served' }));

export const CONDITIONS = [
  // The last wait, served (the dose).
  { id: 'wait0', who: 'returning', family: 'wait', label: 'No line yesterday, served right away', state: back(mem([visit(0)])) },
  { id: 'wait5', who: 'returning', family: 'wait', label: 'Waited 5 minutes yesterday, served (the reference)', state: back() },
  { id: 'wait10', who: 'returning', family: 'wait', label: 'Waited 10 minutes yesterday, served', state: back(mem([visit(10)])) },
  { id: 'wait20', who: 'returning', family: 'wait', label: 'Waited 20 minutes yesterday, served', state: back(mem([visit(20)])) },
  { id: 'wait30', who: 'returning', family: 'wait', label: 'Waited 30 minutes yesterday, served', state: back(mem([visit(30)])) },
  // Walked away after the same wait.
  { id: 'left10', who: 'returning', family: 'left', label: 'Waited 10 minutes yesterday, left without ordering', state: back(mem([visit(10, 'left')])) },
  { id: 'left20', who: 'returning', family: 'left', label: 'Waited 20 minutes yesterday, left without ordering', state: back(mem([visit(20, 'left')])) },
  // Turned away at the door on seeing the line: the sentence the multi-day loop writes (§21b).
  { id: 'balk9', who: 'returning', family: 'left', label: 'Found 9 people in line yesterday and left', state: back(mem([{ daysAgo: 1, wait: 0, outcome: 'left', ahead: 9 }])) },
  { id: 'balk3', who: 'returning', family: 'left', label: 'Found 3 people in line yesterday and left', state: back(mem([{ daysAgo: 1, wait: 0, outcome: 'left', ahead: 3 }])) },
  // The same 15 minutes, ending fast or slow (peak-end).
  { id: 'end_plain15', who: 'returning', family: 'ending', label: 'Waited 15 minutes yesterday, served', state: back(mem([visit(15)])) },
  { id: 'end_fast15', who: 'returning', family: 'ending', label: '15 minutes: slow at first, quick at the end', state: back(mem([visit(15, 'served', { ending: 'fast' })])) },
  { id: 'end_slow15', who: 'returning', family: 'ending', label: '15 minutes: quick at first, stalled at the end', state: back(mem([visit(15, 'served', { ending: 'slow' })])) },
  // Does it read a memory at all, and does a sentence about nothing move it?
  { id: 'good', who: 'returning', family: 'reads', label: 'A very good last visit', state: back(said(S => `no line at ${S}, the barista remembered the usual order, and the coffee was excellent`)) },
  { id: 'bad', who: 'returning', family: 'reads', label: 'A very bad last visit', state: back(said(S => `waited about 30 minutes in line at ${S}, the order came out wrong, and nobody apologized`)) },
  { id: 'weather', who: 'returning', family: 'reads', label: 'A sentence about the weather', state: back(said(() => 'it rained on Maple Street in the morning and cleared up by noon')) },
  { id: 'nomemory', who: 'returning', family: 'reads', label: 'No memory, visit count only', state: back(mem([])) },
  { id: 'para20', who: 'returning', family: 'reads', label: 'The 20-minute wait in other words', state: back(said(S => `stood in line for around twenty minutes at ${S} before being served`)) },
  // How fast a bad memory fades.
  { id: 'bad_d1', who: 'returning', family: 'fade', label: 'Waited 30 minutes and left, yesterday', state: back(mem([{ daysAgo: 1, wait: 30, outcome: 'left' }])) },
  { id: 'bad_d7', who: 'returning', family: 'fade', label: 'Waited 30 minutes and left, 1 week ago', state: back(mem([{ daysAgo: 7, wait: 30, outcome: 'left' }])) },
  { id: 'bad_d28', who: 'returning', family: 'fade', label: 'Waited 30 minutes and left, 4 weeks ago', state: back(mem([{ daysAgo: 28, wait: 30, outcome: 'left' }])) },
  // Whether bad visits add up: the last three visits.
  { id: 'acc0', who: 'returning', family: 'adds', label: 'Last 3 visits: 5, 5, 5 minutes', state: back(mem(days([5, 5, 5]))) },
  { id: 'acc1_new', who: 'returning', family: 'adds', label: 'Last 3 visits: 20 (yesterday), 5, 5', state: back(mem(days([20, 5, 5]))) },
  { id: 'acc1_old', who: 'returning', family: 'adds', label: 'Last 3 visits: 5, 5, 20 (3 days ago)', state: back(mem(days([5, 5, 20]))) },
  { id: 'acc3', who: 'returning', family: 'adds', label: 'Last 3 visits: 20, 20, 20 minutes', state: back(mem(days([20, 20, 20]))) },
  // The price against the remembered price.
  { id: 'price_same', who: 'returning', family: 'price', label: '$5.00, the same as last week', state: back(() => ({ price: 5, wasPrice: 5 })) },
  { id: 'price_up', who: 'returning', family: 'price', label: '$5.50, up 50 cents', state: back(() => ({ price: 5.5, wasPrice: 5 })) },
  { id: 'price_down', who: 'returning', family: 'price', label: '$4.50, down 50 cents', state: back(() => ({ price: 4.5, wasPrice: 5 })) },
  { id: 'price_up1', who: 'returning', family: 'price', label: '$6.00, up 1 dollar', state: back(() => ({ price: 6, wasPrice: 5 })) },
  { id: 'price_down1', who: 'returning', family: 'price', label: '$4.00, down 1 dollar', state: back(() => ({ price: 4, wasPrice: 5 })) },
  // A stamp card.
  { id: 'card_2of10', who: 'returning', family: 'card', label: 'Stamp card: 2 of 10', state: back(() => ({ card: { ...CARD, have: 2 } })) },
  { id: 'card_8of10', who: 'returning', family: 'card', label: 'Stamp card: 8 of 10', state: back(() => ({ card: { ...CARD, have: 8 } })) },
  { id: 'card_0of8', who: 'returning', family: 'card', label: 'Stamp card: 0 of 8 (8 to go)', state: back(() => ({ card: { ...CARD, need: 8, have: 0 } })) },
  { id: 'card_2of10_free', who: 'returning', family: 'card', label: 'Stamp card: 2 of 10, both given free (8 to go)', state: back(() => ({ card: { ...CARD, have: 2, free: 2 } })) },
  // A message from the shop, with and without a deal.
  { id: 'msg_plain', who: 'returning', family: 'promo', label: 'Message: open as usual', state: back(S => ({ offers: [`${S}: open 7 am to 3 pm today, as usual.`] })) },
  { id: 'promo20', who: 'returning', family: 'promo', label: 'Message: 20% off today', state: back(S => ({ offers: [`${S}: 20% off everything today.`], offerPrice: 4 })) },
  // A friend's remark.
  { id: 'heard_good', who: 'returning', family: 'heard', label: 'A friend: it was good and quick', state: back(S => ({ heard: [friendRemark('good_experience', S)] })) },
  { id: 'heard_bad', who: 'returning', family: 'heard', label: 'A friend: long line there', state: back(S => ({ heard: [friendRemark('long_line', S)] })) },
  { id: 'heard_other', who: 'returning', family: 'heard', label: 'A friend: about something else', state: back(() => ({ heard: [friendRemark('the farmers market on Oak Street was busy')] })) },

  // People who have never been inside.
  { id: 'new_ref', who: 'newcomer', family: 'new', label: 'Never been; has walked past (the reference)', state: fresh() },
  { id: 'new_rating35', who: 'newcomer', family: 'rating', label: 'Rated 3.5 stars', state: fresh(() => ({ rating: 3.5 })) },
  { id: 'new_rating40', who: 'newcomer', family: 'rating', label: 'Rated 4.0 stars', state: fresh(() => ({ rating: 4 })) },
  { id: 'new_rating45', who: 'newcomer', family: 'rating', label: 'Rated 4.5 stars', state: fresh(() => ({ rating: 4.5 })) },
  { id: 'new_heard_good', who: 'newcomer', family: 'heard', label: 'A friend: it was good and quick', state: fresh(S => ({ heard: [friendRemark('good_experience', S)] })) },
  { id: 'new_heard_bad', who: 'newcomer', family: 'heard', label: 'A friend: long line there', state: fresh(S => ({ heard: [friendRemark('long_line', S)] })) },
  { id: 'new_heard_other', who: 'newcomer', family: 'heard', label: 'A friend: about something else', state: fresh(() => ({ heard: [friendRemark('the farmers market on Oak Street was busy')] })) },
  { id: 'new_msg_plain', who: 'newcomer', family: 'promo', label: 'Message: open as usual', state: fresh(S => ({ offers: [`${S}: open 7 am to 3 pm today, as usual.`] })) },
  { id: 'new_promo20', who: 'newcomer', family: 'promo', label: 'Message: 20% off today', state: fresh(S => ({ offers: [`${S}: 20% off everything today.`], offerPrice: 4 })) },
  // After a first visit 4 days ago, at full price today.
  { id: 'once_full', who: 'newcomer', family: 'deal', label: 'First visit at full price ($5.00)', state: once({ paid: 5 }) },
  { id: 'once_deal', who: 'newcomer', family: 'deal', label: 'First visit on a 20%-off deal ($4.00)', state: once({ paid: 4, promo: '20%-off promotion' }) }
];

// ---------- tests: what must be true ----------
// type 'diff': a against b, person by person. 'slope': change per unit of `dose` across `conds`.
// 'asym': (ref - up) - (down - ref), the extra hurt of a rise over the help of an equal cut.
// expect: 'higher' | 'lower' | 'same' | 'not_higher' | 'not_lower'. kind: 'check' (sanity), 'gate' (a published
// effect), 'explore' (measured, no pass rule).
export const TESTS = [
  { id: 'reads', kind: 'check', title: 'Reads a memory at all', type: 'diff', a: 'good', b: 'bad', expect: 'higher', min: READS_MEMORY_MIN, from: 'sanity' },
  { id: 'reads_good', kind: 'check', title: 'A good visit against a neutral sentence', type: 'diff', a: 'good', b: 'weather', expect: 'not_lower', from: 'sanity' },
  { id: 'reads_bad', kind: 'check', title: 'A bad visit against a neutral sentence', type: 'diff', a: 'bad', b: 'weather', expect: 'lower', from: 'sanity' },
  { id: 'neutral', kind: 'check', title: 'A neutral sentence does nothing', type: 'diff', a: 'weather', b: 'nomemory', expect: 'same', from: 'PROTOTYPE §17' },
  { id: 'paraphrase', kind: 'check', title: 'Same fact, other words', type: 'diff', a: 'para20', b: 'wait20', expect: 'same', from: 'sanity' },
  { id: 'turned_away', kind: 'check', title: 'Turned away at the door by a 9-person line, against an ordinary visit', type: 'diff', a: 'balk9', b: 'wait5', expect: 'lower', from: 'the loop\'s wording (§21b)' },

  { id: 'wait_slope', kind: 'gate', title: 'Longer last wait, less likely to return', type: 'slope', conds: ['wait0', 'wait5', 'wait10', 'wait20', 'wait30'], dose: [0, 5, 10, 20, 30], per: 10, unit: 'per 10 minutes', expect: 'lower', from: 'de Vries et al. 2018' },
  { id: 'wait_ends', kind: 'gate', title: 'A 30-minute wait against no line', type: 'diff', a: 'wait30', b: 'wait0', expect: 'lower', from: 'de Vries et al. 2018' },
  { id: 'left20', kind: 'gate', title: 'Walked away after 20 minutes against served', type: 'diff', a: 'left20', b: 'wait20', expect: 'lower', from: 'de Vries et al. 2018' },
  { id: 'left10', kind: 'gate', title: 'Walked away after 10 minutes against served', type: 'diff', a: 'left10', b: 'wait10', expect: 'lower', from: 'de Vries et al. 2018' },
  { id: 'peak_end', kind: 'gate', title: 'The same 15 minutes, ending fast against ending slow', type: 'diff', a: 'end_fast15', b: 'end_slow15', expect: 'higher', from: 'peak-end rule (Kahneman et al. 1993)' },
  { id: 'price_up', kind: 'gate', title: 'A 50-cent rise', type: 'diff', a: 'price_up', b: 'price_same', expect: 'lower', from: 'Hardie et al. 1993' },
  { id: 'price_down', kind: 'gate', title: 'A 50-cent cut', type: 'diff', a: 'price_down', b: 'price_same', expect: 'not_lower', from: 'Hardie et al. 1993' },
  { id: 'loss_aversion', kind: 'gate', title: 'A 50-cent rise hurts more than a 50-cent cut helps', type: 'asym', ref: 'price_same', up: 'price_up', down: 'price_down', expect: 'higher', from: 'Hardie et al. 1993' },
  { id: 'loss_aversion1', kind: 'gate', title: 'A 1-dollar rise hurts more than a 1-dollar cut helps', type: 'asym', ref: 'price_same', up: 'price_up1', down: 'price_down1', expect: 'higher', from: 'Hardie et al. 1993' },
  { id: 'near_reward', kind: 'gate', title: 'Near the reward: 8 of 10 stamps against 2 of 10', type: 'diff', a: 'card_8of10', b: 'card_2of10', expect: 'higher', size: { type: 'gap', band: [0.10, 0.30], study: 'about 20% closer together' }, from: 'Kivetz et al. 2006' },
  { id: 'head_start', kind: 'gate', title: 'Head start: 2 free stamps of 10 against 0 of 8', type: 'diff', a: 'card_2of10_free', b: 'card_0of8', expect: 'higher', from: 'Nunes & Drèze 2006' },
  { id: 'deal_new', kind: 'gate', title: 'A 20%-off deal brings newcomers', type: 'diff', a: 'new_promo20', b: 'new_msg_plain', expect: 'higher', from: 'Dholakia 2011' },
  { id: 'deal_loyalty', kind: 'gate', title: 'A deal buys no loyalty: first visit on a deal against at full price', type: 'diff', a: 'once_deal', b: 'once_full', expect: 'not_higher', from: 'REPEAT_CUSTOMERS_SPEC §9' },
  { id: 'rating', kind: 'gate', title: 'A higher rating brings newcomers', type: 'slope', conds: ['new_rating35', 'new_rating40', 'new_rating45'], dose: [3.5, 4, 4.5], per: 1, unit: 'per star', expect: 'higher', size: { type: 'lift', band: [0.02, 0.20], study: '5 to 9% more revenue per star' }, from: 'Luca 2016' },
  { id: 'friend_good', kind: 'gate', title: "A friend's good remark, newcomers", type: 'diff', a: 'new_heard_good', b: 'new_heard_other', expect: 'higher', from: 'Trusov et al. 2009' },
  { id: 'friend_bad', kind: 'gate', title: "A friend's bad remark, newcomers", type: 'diff', a: 'new_heard_bad', b: 'new_heard_other', expect: 'lower', from: 'Trusov et al. 2009' },

  { id: 'fade', kind: 'explore', title: 'A bad visit 4 weeks ago against yesterday', type: 'diff', a: 'bad_d28', b: 'bad_d1', expect: 'higher', from: 'open: how fast a memory fades' },
  { id: 'fade_week', kind: 'explore', title: 'A bad visit 1 week ago against yesterday', type: 'diff', a: 'bad_d7', b: 'bad_d1', expect: 'higher', from: 'open: how fast a memory fades' },
  { id: 'turned_long', kind: 'explore', title: 'Turned away by 9 people against by 3', type: 'diff', a: 'balk9', b: 'balk3', expect: 'lower', from: 'does the line seen matter' },
  { id: 'turned_vs_waited', kind: 'explore', title: 'Turned away at the door against waiting 20 minutes and leaving', type: 'diff', a: 'balk9', b: 'left20', expect: 'higher', from: 'which is the worse memory' },
  { id: 'adds_one', kind: 'explore', title: 'One 20-minute wait in the last three visits', type: 'diff', a: 'acc1_new', b: 'acc0', expect: 'lower', from: 'do bad visits add up' },
  { id: 'adds_three', kind: 'explore', title: 'Three 20-minute waits against one', type: 'diff', a: 'acc3', b: 'acc1_new', expect: 'lower', from: 'do bad visits add up' },
  { id: 'adds_recent', kind: 'explore', title: 'The 20-minute wait yesterday against 3 days ago', type: 'diff', a: 'acc1_new', b: 'acc1_old', expect: 'lower', from: 'recency within a list' },
  { id: 'deal_regular', kind: 'explore', title: 'A 20%-off deal, regulars', type: 'diff', a: 'promo20', b: 'msg_plain', expect: 'higher', from: 'Dholakia 2011: most deal buyers are new' },
  { id: 'message', kind: 'explore', title: 'Any message from the shop, regulars', type: 'diff', a: 'msg_plain', b: 'wait5', expect: 'same', from: 'the reminder effect' },
  { id: 'message_new', kind: 'explore', title: 'Any message from the shop, newcomers', type: 'diff', a: 'new_msg_plain', b: 'new_ref', expect: 'same', from: 'the reminder effect' },
  { id: 'card_there', kind: 'explore', title: 'Holding a stamp card at all (2 of 10)', type: 'diff', a: 'card_2of10', b: 'wait5', expect: 'higher', from: 'the card by being there' },
  { id: 'friend_good_regular', kind: 'explore', title: "A friend's good remark, regulars", type: 'diff', a: 'heard_good', b: 'heard_other', expect: 'higher', from: 'word of mouth against own experience' },
  { id: 'friend_bad_regular', kind: 'explore', title: "A friend's bad remark, regulars", type: 'diff', a: 'heard_bad', b: 'heard_other', expect: 'lower', from: 'word of mouth against own experience' },
  { id: 'price_up1', kind: 'explore', title: 'A 1-dollar rise', type: 'diff', a: 'price_up1', b: 'price_same', expect: 'lower', from: 'Hardie et al. 1993' },
  { id: 'rating_any', kind: 'explore', title: 'A 4.0-star rating against none shown', type: 'diff', a: 'new_rating40', b: 'new_ref', expect: 'same', from: 'what showing a rating does' }
];

// ---------- requests ----------

export function castFor(spec) {
  const people = [];
  for (const m of spec.minds) {
    const role = CAST[m.id];
    if (!role) continue;
    people.push({ mind: m, visits: role.visits ?? null, returning: role.visits != null, newcomer: role.newcomer === true });
  }
  return people;
}

export const eligible = (cond, person) => (cond.who === 'newcomer' ? person.newcomer : person.returning);

// One DecisionRequest per condition and eligible person. `only` keeps the conditions of some families.
export function buildRequests(spec, { only = null } = {}) {
  const shopName = shopView(spec, SHOP).shop.name;
  const wanted = only ? new Set(only) : null;
  const out = [];
  for (const cond of CONDITIONS) {
    if (wanted && !wanted.has(cond.family)) continue;
    for (const person of castFor(spec)) {
      if (!eligible(cond, person)) continue;
      const req = morningRequest({ spec, shopId: SHOP, mind: person.mind, state: cond.state(person, shopName), id: `${cond.id}-${person.mind.id}` });
      out.push({ ...req, meta: { cond: cond.id, mind: person.mind.id } });
    }
  }
  return out;
}

// ---------- statistics ----------

const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

// 95% interval for the mean of per-person values, by resampling people. With one person there is no interval.
export function bootstrap(values, seed = 'return-probe', draws = 4000) {
  const n = values.length;
  if (n < 2) return { lo: null, hi: null };
  const rng = seedRng(seed, n);
  const means = new Array(draws);
  for (let d = 0; d < draws; d++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[Math.floor(rng() * n)];
    means[d] = s / n;
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(0.025 * draws)], hi: means[Math.min(draws - 1, Math.ceil(0.975 * draws) - 1)] };
}

// Least-squares slope of y on x.
function slopeOf(xs, ys) {
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den > 0 ? num / den : 0;
}

// Log-odds of a chance, kept away from 0 and 1. A person near 0% cannot fall by 10 points and one near 100%
// cannot rise by 10, so differences are also reported as odds, where neither is squeezed.
const logit = p => { const q = Math.min(0.995, Math.max(0.005, p)); return Math.log(q / (1 - q)); };
const oddsOf = (values, seed) => {
  const ci = bootstrap(values, `${seed}-odds`);
  return { times: Math.exp(mean(values)), lo: ci.lo == null ? null : Math.exp(ci.lo), hi: ci.hi == null ? null : Math.exp(ci.hi) };
};

// Spearman rank correlation, ties given their average rank.
function rankCorrelation(xs, ys) {
  const ranks = v => {
    const order = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(v.length);
    for (let i = 0; i < order.length;) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      for (let k = i; k <= j; k++) out[order[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return out;
  };
  const a = ranks(xs), b = ranks(ys), ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

// Does Jev's chance of going follow the visit count a person is told? `people` is { mind: chance } for the
// condition that gives the count and no memory. A count over 4 weeks is compared with the share of the 20
// weekdays it implies (the question is asked on a weekday morning).
export function baseRateOf(people) {
  const rows = Object.entries(people).filter(([m]) => CAST[m]?.visits != null)
    .map(([m, jev]) => ({ mind: m, visits: CAST[m].visits, implied: Math.min(1, CAST[m].visits / 20), jev }))
    .sort((x, y) => y.visits - x.visits);
  if (rows.length < 3) return null;
  const ratio = sel => { const r = rows.filter(sel); return r.length ? mean(r.map(x => x.jev)) / mean(r.map(x => x.implied)) : null; };
  return {
    rows, rank: rankCorrelation(rows.map(r => r.visits), rows.map(r => r.jev)),
    // Jev's average chance over the average implied one: 1 means the level is right.
    occasional: ratio(r => r.implied <= 0.5), frequent: ratio(r => r.implied > 0.5)
  };
}

export function verdictOf(expect, effect, ci, { min = 0 } = {}) {
  if (effect == null) return 'no data';
  if (expect === 'same') return Math.abs(effect) < SAME_TOLERANCE ? 'pass' : 'fail';
  const clear = ci.lo != null && ci.hi != null;
  const above = clear && ci.lo > 0, below = clear && ci.hi < 0;
  if (expect === 'not_higher') return above ? 'fail' : 'pass';
  if (expect === 'not_lower') return below ? 'fail' : 'pass';
  const right = expect === 'higher' ? above : below, wrong = expect === 'higher' ? below : above;
  if (wrong) return 'fail';
  if (!right) return 'unclear';
  return Math.abs(effect) >= min ? 'pass' : 'weak';
}

// rows: [{ cond, mind, rep, p }] with p the chance of going (null when Jev did not answer).
export function analyze(rows) {
  const cells = new Map();   // "cond|mind" -> [p per repeat]
  for (const r of rows) {
    if (r.p == null) continue;
    const k = `${r.cond}|${r.mind}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(r.p);
  }
  const cell = (cond, mind) => { const v = cells.get(`${cond}|${mind}`); return v && v.length ? mean(v) : null; };
  const mindsOf = cond => [...new Set(rows.filter(r => r.cond === cond && r.p != null).map(r => r.mind))];
  const both = (...conds) => mindsOf(conds[0]).filter(m => conds.every(c => cell(c, m) != null));

  // Rerun noise: how far two asks of the same question differ, and the spread of one cell's average.
  const gaps = [];
  for (const v of cells.values()) for (let i = 1; i < v.length; i++) gaps.push(Math.abs(v[i] - v[i - 1]));
  gaps.sort((a, b) => a - b);
  const noise = {
    pairs: gaps.length, meanGap: mean(gaps), p90Gap: gaps.length ? gaps[Math.floor(0.9 * (gaps.length - 1))] : null,
    maxGap: gaps.length ? gaps[gaps.length - 1] : null
  };

  const byCond = {};
  for (const c of CONDITIONS) {
    const minds = mindsOf(c.id);
    if (minds.length) byCond[c.id] = { n: minds.length, mean: mean(minds.map(m => cell(c.id, m))), people: Object.fromEntries(minds.map(m => [m, cell(c.id, m)])) };
  }

  const tests = [];
  for (const t of TESTS) {
    let people = [], values = [], extra = {}, odds = null;
    if (t.type === 'diff') {
      people = both(t.a, t.b);
      values = people.map(m => cell(t.a, m) - cell(t.b, m));
      // Both averages over the same people, so they differ by exactly the effect.
      if (people.length) {
        extra = { a: mean(people.map(m => cell(t.a, m))), b: mean(people.map(m => cell(t.b, m))) };
        odds = oddsOf(people.map(m => logit(cell(t.a, m)) - logit(cell(t.b, m))), t.id);
      }
    } else if (t.type === 'slope') {
      people = both(...t.conds);
      values = people.map(m => slopeOf(t.dose, t.conds.map(c => cell(c, m))) * t.per);
      extra = { curve: t.conds.map(c => (people.length ? mean(people.map(m => cell(c, m))) : null)), dose: t.dose, unit: t.unit };
    } else if (t.type === 'asym') {
      people = both(t.ref, t.up, t.down);
      values = people.map(m => (cell(t.ref, m) - cell(t.up, m)) - (cell(t.down, m) - cell(t.ref, m)));
      if (people.length) {
        extra = { drop: mean(people.map(m => cell(t.ref, m) - cell(t.up, m))), gain: mean(people.map(m => cell(t.down, m) - cell(t.ref, m))) };
        // Above 1 means the rise moves the odds further than the equal cut does.
        odds = oddsOf(people.map(m => (logit(cell(t.ref, m)) - logit(cell(t.up, m))) - (logit(cell(t.down, m)) - logit(cell(t.ref, m)))), t.id);
      }
    }
    if (!people.length) continue;   // its conditions were not asked (--only)
    const effect = mean(values);
    const ci = bootstrap(values, t.id);
    const verdict = t.kind === 'explore' && t.expect !== 'same' ? null : verdictOf(t.expect, effect, ci, { min: t.min });
    let size = null;
    if (t.size?.type === 'gap' && extra.a > 0) {
      // Visits come 1/p days apart, so the gap between visits shrinks by 1 - p(b)/p(a) from b to a.
      const closer = 1 - extra.b / extra.a;
      size = { value: closer, band: t.size.band, inBand: closer >= t.size.band[0] && closer <= t.size.band[1], study: t.size.study, words: `visits ${Math.round(closer * 100)}% closer together` };
    }
    if (t.size?.type === 'lift' && extra.curve?.[0] > 0) {
      const lift = effect / extra.curve[0];
      size = { value: lift, band: t.size.band, inBand: lift >= t.size.band[0] && lift <= t.size.band[1], study: t.size.study, words: `${Math.round(lift * 100)}% more likely to come per star` };
    }
    tests.push({
      id: t.id, kind: t.kind, title: t.title, from: t.from, expect: t.expect, n: people.length, effect, ci, verdict, size, odds, ...extra,
      people: Object.fromEntries(people.map((m, i) => [m, values[i]]))
    });
  }
  const tally = kind => {
    const mine = tests.filter(t => t.kind === kind && t.verdict);
    return { total: mine.length, pass: mine.filter(t => t.verdict === 'pass').length, fail: mine.filter(t => t.verdict === 'fail').length, other: mine.filter(t => !['pass', 'fail'].includes(t.verdict)).length };
  };
  const baseRate = byCond.nomemory ? baseRateOf(byCond.nomemory.people) : null;
  return { noise, byCond, tests, baseRate, tally: { check: tally('check'), gate: tally('gate') } };
}

// ---------- report ----------

const pts = x => (x == null ? '-' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}`);
const pct = x => (x == null ? '-' : `${(x * 100).toFixed(0)}%`);
const EXPECT_WORDS = { higher: 'higher', lower: 'lower', same: 'within 5 points', not_higher: 'not higher', not_lower: 'not lower' };
const KIND_TITLES = { check: 'Does it read memory? (sanity checks)', gate: 'Does it answer like real customers? (published effects)', explore: 'Measured, with no pass rule' };

export function renderReport(result) {
  const { summary, stats, createdAt, repeats } = result;
  const L = [];
  L.push('# Jev return probe: results', '');
  L.push(`Run ${createdAt}. Model ${stats.model}. ${stats.requests} Jev requests (${repeats} asks of each question), ${stats.fallbacks} unanswered, about $${stats.estCostUSD.toFixed(2)} (unverified price).`, '');
  L.push(summary.noise.pairs
    ? `**Rerun noise.** Two asks of the same question differed by ${(summary.noise.meanGap * 100).toFixed(1)} points on average, ${(summary.noise.p90Gap * 100).toFixed(1)} at the 90th percentile, ${(summary.noise.maxGap * 100).toFixed(1)} at most (${summary.noise.pairs} pairs).`
    : '**Rerun noise.** Not measured: each question was asked once.', '');
  L.push(`**Tally.** Sanity checks: ${summary.tally.check.pass} of ${summary.tally.check.total} pass. Published effects: ${summary.tally.gate.pass} of ${summary.tally.gate.total} pass, ${summary.tally.gate.fail} fail, ${summary.tally.gate.other} unclear or weak.`, '');
  L.push('Effects are differences in the chance of going today, in points (hundredths), averaged over people, with a 95% interval from resampling people. "Odds" is the same difference as a multiple of the odds of going (1.00 is no change), which does not squeeze people who are already near 0% or 100%.', '');
  for (const kind of ['check', 'gate', 'explore']) {
    const mine = summary.tests.filter(t => t.kind === kind);
    if (!mine.length) continue;
    L.push(`## ${KIND_TITLES[kind]}`, '');
    L.push('| Test | Expected | Effect | 95% interval | Odds | People | Verdict | From |', '|---|---|---|---|---|---|---|---|');
    for (const t of mine) {
      const size = t.size ? ` (${t.size.words}; study: ${t.size.study}${t.size.inBand ? '' : '; outside the band'})` : '';
      const unit = t.unit ? ` ${t.unit}` : '';
      const odds = t.odds ? `×${t.odds.times.toFixed(2)}${t.odds.lo == null ? '' : ` (${t.odds.lo.toFixed(2)} to ${t.odds.hi.toFixed(2)})`}` : '-';
      L.push(`| ${t.title} | ${EXPECT_WORDS[t.expect]} | ${pts(t.effect)}${unit}${size} | ${t.ci.lo == null ? '-' : `${pts(t.ci.lo)} to ${pts(t.ci.hi)}`} | ${odds} | ${t.n} | ${t.verdict ? t.verdict.toUpperCase() : '-'} | ${t.from} |`);
    }
    L.push('');
  }
  const base = summary.baseRate;
  if (base) {
    L.push('## Does the chance follow the visit count?', '');
    L.push(`Each returning customer is told how many times they came in the last 4 weeks, and nothing else. The order is right: the rank correlation between the count and Jev's chance is ${base.rank.toFixed(2)}. The level is not: people who come on half of weekdays or fewer are given ${base.occasional == null ? '-' : base.occasional.toFixed(1)} times the chance their count implies, and people who come on most weekdays ${base.frequent == null ? '-' : base.frequent.toFixed(1)} times.`, '');
    L.push('| Person | Visits told (4 weeks) | Share of weekdays that implies | Jev\'s chance today |', '|---|---|---|---|');
    for (const r of base.rows) L.push(`| ${result.cast[r.mind]?.name || r.mind} | ${r.visits} | ${pct(r.implied)} | ${pct(r.jev)} |`);
    L.push('');
  }
  L.push('## Chance of going today, by condition', '', '| Condition | Who | People | Average |', '|---|---|---|---|');
  for (const c of CONDITIONS) {
    const b = summary.byCond[c.id];
    if (b) L.push(`| ${c.label} | ${c.who} | ${b.n} | ${pct(b.mean)} |`);
  }
  L.push('', '## Person by person', '');
  const names = result.cast;
  for (const id of ['reads', 'wait_ends', 'left20', 'price_up', 'near_reward', 'deal_new', 'deal_loyalty']) {
    const t = summary.tests.find(x => x.id === id);
    if (!t) continue;
    const people = Object.entries(t.people).sort((x, y) => x[1] - y[1]);
    L.push(`- **${t.title}:** ${people.map(([m, v]) => `${names[m]?.name?.split(' ')[0] || m} ${pts(v)}`).join(', ')}.`);
  }
  if (result.told) {
    L.push('', '## What a person was told (one example per condition)', '');
    for (const c of CONDITIONS) {
      const t = result.told[c.id];
      if (!t) continue;
      const bits = [t.history, ...(t.memory || []), t.card, ...(t.heard || []), ...(t.offers || []), t.cost && `Cost: ${t.cost}`, t.rating && `Rating: ${t.rating}`].filter(Boolean);
      L.push(`- \`${c.id}\` (${t.name}): ${bits.join(' / ')}`);
    }
  }
  return L.join('\n') + '\n';
}

// ---------- run ----------

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
  const out = resolve(ROOT, flag('out', 'data/validation/jev-return-probe.json'));
  const repeats = Math.max(1, Math.min(20, Math.round(Number(flag('repeats', 5))) || 5));
  const only = flag('only', null)?.split(',').map(s => s.trim()).filter(Boolean) || null;
  // --from <results.json>: score saved answers again without asking Jev (after a change to the tests).
  const from = flag('from', null);
  if (from) {
    const saved = JSON.parse(readFileSync(resolve(ROOT, from), 'utf8'));
    console.log(`Scoring the ${saved.rows.length} saved answers in ${from} again (no Jev requests).`);
    return finish({ ...saved, summary: analyze(saved.rows) }, out);
  }
  loadEnv({ cwd: ROOT });
  const apiKey = process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY;
  if (!apiKey) { console.error('No Jev key: set JEV_API_KEY or TYPESAFE_API_KEY in .env.local.'); process.exit(1); }
  const spec = normalizeSpec(JSON.parse(readFileSync(resolve(ROOT, WORLD), 'utf8')));
  const reqs = buildRequests(spec, { only });
  if (!reqs.length) { console.error(`No conditions in ${only?.join(', ')}. Families: ${[...new Set(CONDITIONS.map(c => c.family))].join(', ')}.`); process.exit(1); }
  console.log(`Asking Jev ${reqs.length} questions ${repeats} times each (${reqs.length * repeats} requests)...`);

  const t0 = Date.now();
  const rows = [];
  const total = { requests: 0, fallbacks: 0, errors: 0, inputTokens: 0, outputTokens: 0, estCostUSD: 0, model: null, firstError: null };
  for (let rep = 0; rep < repeats; rep++) {
    // A fresh provider each pass: its cache is empty, so every answer is a new ask.
    const jev = new JevProvider({ apiKey, maxRequests: reqs.length + 50, concurrency: 24 });
    const decisions = await jev.decideMany(reqs, { spec });
    reqs.forEach((q, i) => rows.push({ ...q.meta, rep, p: ['jev', 'jev-cache'].includes(decisions[i].provider) ? decisions[i].yesProb : null }));
    const s = jev.stats();
    for (const k of ['requests', 'fallbacks', 'errors', 'inputTokens', 'outputTokens', 'estCostUSD']) total[k] += s[k];
    total.model = s.model; total.firstError ??= s.firstError;
    console.log(`  pass ${rep + 1} of ${repeats}: ${s.requests} requests, ${s.fallbacks} unanswered`);
  }

  const cast = Object.fromEntries(castFor(spec).map(p => [p.mind.id, { name: p.mind.name, group: p.mind.archetype, visits: p.visits, returning: p.returning, newcomer: p.newcomer }]));
  const told = {};
  for (const c of CONDITIONS) {
    const q = reqs.find(r => r.meta.cond === c.id);
    if (!q) continue;
    const o = q.observation;
    told[c.id] = { name: o.person.name, history: o.history, memory: o.memory, card: o.card, heard: o.heard, offers: o.offers, cost: o.shop.cost, rating: o.shop.rating };
  }
  const result = {
    createdAt: new Date().toISOString(), seconds: (Date.now() - t0) / 1000, world: WORLD, shop: SHOP, repeats, only,
    stats: total, cast, summary: analyze(rows), told, question: reqs[0] ? { asks: reqs[0].asks, example: reqs[0].observation } : null, rows
  };
  console.log(`Done in ${result.seconds.toFixed(0)} s. ${total.requests} requests, ${total.fallbacks} unanswered, model ${total.model}, about $${total.estCostUSD.toFixed(3)}.`);
  if (total.firstError) console.log(`First error: ${total.firstError}`);
  finish(result, out);
}

// Writes the JSON and the readable report, and prints the scorecard.
function finish(result, out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 1));
  const md = out.replace(/\.json$/, '') + '.md';
  writeFileSync(md, renderReport(result));
  const n = result.summary.noise;
  console.log(n.pairs
    ? `Rerun noise: ${(n.meanGap * 100).toFixed(1)} points on average between two asks, ${(n.maxGap * 100).toFixed(1)} at most.`
    : 'Rerun noise: not measured (each question was asked once).');
  for (const kind of ['check', 'gate', 'explore']) {
    console.log(`\n${KIND_TITLES[kind]}`);
    for (const t of result.summary.tests.filter(x => x.kind === kind)) {
      const ci = t.ci.lo == null ? '' : ` [${pts(t.ci.lo)}, ${pts(t.ci.hi)}]`;
      const size = t.size ? `  ${t.size.words}${t.size.inBand ? '' : ' (outside the band)'}` : '';
      const odds = t.odds ? `, odds ×${t.odds.times.toFixed(2)}` : '';
      console.log(`  ${(t.verdict || '').toUpperCase().padEnd(8)} ${t.title}: ${pts(t.effect)}${t.unit ? ' ' + t.unit : ''}${ci}${odds} (expected ${EXPECT_WORDS[t.expect]}, ${t.n} people)${size}`);
    }
  }
  const base = result.summary.baseRate;
  if (base) {
    console.log(`\nDoes the chance follow the visit count? Rank correlation ${base.rank.toFixed(2)}. Level: occasional customers get ${base.occasional?.toFixed(1) ?? '-'} times the chance their count implies, frequent ones ${base.frequent?.toFixed(1) ?? '-'} times.`);
  }
  console.log(`\nWrote ${out}\n      ${md}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(err => { console.error(err.message); process.exit(1); });
