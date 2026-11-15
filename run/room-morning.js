// Ask the room, next morning (docs/PROTOTYPE.md §17b): one morning, every cast member, asked through the
// decision provider.
//
// run/room.js asks one moment inside a visit: a person has just arrived and sees a line, a price and a sign.
// This asks the morning after: given what this person remembers of the shop and what they are told today, do
// they go back? It is the morning question of §20 (run/morning.js, `visit_today`), and every record it builds
// has the shape and the words the return probe checked against Jev (validation/jev-return-probe.js), so the
// page asks what was validated. Each person is asked twice: the record set by the page, and the record it is
// compared with.
import { normalizeSpec } from '../engine/spec.js';
import { morningRequest, friendRemark, shopView } from './morning.js';
import { ROOM_LIMITS, ROOM_NOISE } from './room.js';

// Noise for the morning question, measured by the return probe (docs/PROTOTYPE.md §20d, Nov 14, jev-1.14.0):
// two asks of the same question differed by 1.2 points on average, by 3.0 at the 90th percentile and by 8.0 at
// most (1,892 pairs). The average over the cast keeps the 5-point bar Ask the room already uses (§17). One
// person counts as moved at 10 points, which sits above the largest difference seen when nothing changed. The
// arrival question needs 15 points for one person because its largest difference was 14.
export const MORNING_NOISE = ROOM_NOISE;
export const MORNING_NOISE_PERSON = 0.10;

// The probe's wordings. Change one and the page no longer asks what the probe checked (there is a test).
export const MORNING_WEEKS = 4;                       // a returning customer is told their visits in the last 4 weeks
export const NEVER_VIA = 'has walked past it';        // how someone who has never been inside knows of the shop
export const CARD = { need: 10, reward: 'a free coffee' };
export const DEAL_OFF = 0.2;
export const DEAL_TEXT = '20% off everything today.';
export const PLAIN_MESSAGE = 'open 7 am to 3 pm today, as usual.';
export const OTHER_REMARK = 'the farmers market on Oak Street was busy';
const REMARK_KINDS = { good: 'good_experience', bad: 'long_line' };

// What each control may be set to. Only facts the probe found Jev responds to (§20d): how the wait ended
// ("quick at the end"), a free head start on the card, and a rise against an equal cut are left out, because
// Jev answers those as a calculator would.
export const MORNING_OPTIONS = {
  wait: [0, 5, 10, 20, 30],                // minutes in line on the last visit
  outcome: ['served', 'left'],             // served, or left without ordering
  daysAgo: [1, 7, 28],                     // yesterday, 1 week ago, 4 weeks ago
  priceChange: [-1, -0.5, 0, 0.5, 1],      // today's price against last week's, in dollars
  card: [2, 8],                            // stamps filled of 10 (or no card)
  remark: ['good', 'bad'],                 // a friend's remark (or none)
  rating: [3.5, 4, 4.5],                   // stars shown (or none)
  message: ['deal']                        // a message from the shop today (or none)
};
// A sentence added to a record is never compared with no sentence, because any added sentence moves Jev's
// answers (§17). A deal is compared with PLAIN_MESSAGE and a friend's remark with OTHER_REMARK, as in the
// probe. A changed price is compared with the price stated as "the same as last week". A card and a rating
// are compared with the lowest one on offer, which are the probe's own comparisons (8 of 10 stamps against 2
// of 10; 4.5 stars against 3.5).
export const CARD_BASE = MORNING_OPTIONS.card[0];
export const RATING_BASE = MORNING_OPTIONS.rating[0];

// A number, or text that reads as one. Anything else (nothing, true, a list) is not a number.
const numberOf = v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);
// The allowed value nearest to what the page sent; the default when nothing usable was sent.
const nearest = (v, allowed, def) => {
  const n = numberOf(v);
  if (!Number.isFinite(n) || !allowed.length) return def;
  return allowed.reduce((best, a) => (Math.abs(a - n) < Math.abs(best - n) ? a : best), allowed[0]);
};
const cents = x => Math.round(100 * x) / 100;

// Minutes of an ordinary wait at the shop: what a person's usual rate already allows for (§21a).
const ordinaryWait = pool => { const n = Math.round(numberOf(pool?.ordinaryWait)); return Number.isFinite(n) ? Math.min(60, Math.max(0, n)) : 5; };
const waitOptions = pool => [...new Set([...MORNING_OPTIONS.wait, ordinaryWait(pool)])].sort((a, b) => a - b);
// A price change that would make the shop free or pay people to come is not offered.
const priceOptions = price => MORNING_OPTIONS.priceChange.filter(d => price + d > 0);

// The ordinary morning: the last visit was yesterday, with an ordinary wait, and nothing else was said.
export function defaultMorning(pool) {
  return { wait: ordinaryWait(pool), outcome: 'served', daysAgo: 1, priceChange: 0, card: null, remark: '', rating: null, message: '' };
}

// Clamp and complete a morning from the page. Every value is one of the options above: a number takes the
// nearest allowed value, anything else takes the default. `price` is the shop's price in the world.
export function normalizeMorning(pool, raw, price = Infinity) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const base = defaultMorning(pool);
  const wait = nearest(r.wait, waitOptions(pool), base.wait);
  const positive = v => numberOf(v) > 0;
  return {
    wait,
    outcome: wait >= 1 && r.outcome === 'left' ? 'left' : 'served',      // nobody leaves a line that was not there
    daysAgo: nearest(r.daysAgo, MORNING_OPTIONS.daysAgo, base.daysAgo),
    priceChange: nearest(r.priceChange, priceOptions(price), 0),
    card: positive(r.card) ? nearest(r.card, MORNING_OPTIONS.card, null) : null,
    remark: MORNING_OPTIONS.remark.includes(r.remark) ? r.remark : '',
    rating: positive(r.rating) ? nearest(r.rating, MORNING_OPTIONS.rating, null) : null,
    message: MORNING_OPTIONS.message.includes(r.message) ? r.message : ''
  };
}

const MEMORY_KEYS = ['wait', 'outcome', 'daysAgo'], PRICE_KEYS = ['priceChange'], CARD_KEYS = ['card'];
const TODAY_KEYS = ['remark', 'rating', 'message'];
const differs = (a, b, keys) => keys.some(k => a[k] !== b[k]);

// Who is asked as what. A person the pool gives a usual rate is a returning customer, told a visit count for
// the last 4 weeks that fits it. A day visitor, or anyone the pool does not list, has never been inside.
export function morningPeople(spec, pool) {
  return spec.minds.slice(0, ROOM_LIMITS.people).map(mind => {
    const p = pool?.people?.[mind.id] || {};
    const perWeek = Number(p.usualPerWeek);
    const visits = p.dayVisitor || !(perWeek > 0) ? 0 : Math.max(1, Math.round(perWeek * MORNING_WEEKS));
    return { mind, visits, returning: visits > 0 };
  });
}

// One person's two records: `now`, set by the page, and `before`, what it is compared with. The words Jev is
// told are written from these by engine/observe.js (morningObservation).
//   A returning customer: the visit count, one remembered visit, and what the page adds.
//   Someone who has never been: no memory, no last week's price and no card. `applies` is false when the page
//   changed only those, so there is nothing to compare; `partly` when it changed those and something else.
export function morningRecords(scenario, person, { shopName, price, pool }) {
  const s = scenario, base = defaultMorning(pool);
  const deal = s.message === 'deal';
  // What anyone is told today. `plain` gives the sentence that says nothing in each place the page filled.
  const today = (toPay, plain) => ({
    ...(s.remark ? { heard: [plain ? friendRemark(OTHER_REMARK) : friendRemark(REMARK_KINDS[s.remark], shopName)] } : {}),
    ...(s.rating != null ? { rating: plain ? RATING_BASE : s.rating } : {}),
    ...(deal ? (plain ? { offers: [`${shopName}: ${PLAIN_MESSAGE}`] } : { offers: [`${shopName}: ${DEAL_TEXT}`], offerPrice: cents(toPay * (1 - DEAL_OFF)) }) : {})
  });
  if (!person.returning) {
    const history = { visits: 0, via: NEVER_VIA };
    const reaches = differs(s, base, TODAY_KEYS), skipped = differs(s, base, [...MEMORY_KEYS, ...PRICE_KEYS, ...CARD_KEYS]);
    return { now: { history, ...today(price, false) }, before: { history, ...today(price, true) }, applies: reaches || !skipped, partly: reaches && skipped };
  }
  const history = { visits: person.visits, weeks: MORNING_WEEKS };
  const toPay = cents(price + s.priceChange), repriced = s.priceChange !== 0;
  return {
    now: {
      history, memory: [{ daysAgo: s.daysAgo, wait: s.wait, outcome: s.outcome }],
      ...(repriced ? { price: toPay, wasPrice: price } : {}),
      ...(s.card != null ? { card: { ...CARD, have: s.card } } : {}),
      ...today(toPay, false)
    },
    before: {
      history, memory: [{ daysAgo: base.daysAgo, wait: base.wait, outcome: base.outcome }],
      // Under a deal the person is told the offer price against today's usual price, and last week's price is
      // not mentioned, so there is no "last week" clause to match.
      ...(repriced && !deal ? { price, wasPrice: price } : {}),
      ...(s.card != null ? { card: { ...CARD, have: CARD_BASE } } : {}),
      ...today(price, true)
    },
    applies: true, partly: false
  };
}

// The DecisionRequest for one person and one record.
export function morningRoomRequest(spec, shopId, mind, state, tag = 'now') {
  return morningRequest({ spec, shopId, mind, state, id: `room-morning-${tag}-${mind.id}` });
}

// What a person was told, for the page: the lines of the record, then the prices.
const toldOf = obs => ({
  time: obs.time, now: obs.now, history: obs.history || '', memory: obs.memory || [], card: obs.card || '',
  heard: obs.heard || [], offers: obs.offers || [], cost: obs.shop?.cost || '', rating: obs.shop?.rating || '',
  others: (obs.other_places || []).map(o => ({ name: o.name, cost: o.cost }))
});

const world = rawSpec => {
  const spec = normalizeSpec(rawSpec);
  if (spec.mode !== 'visit') throw new Error('Ask the room needs a visit world.');
  return spec;
};

// What the page needs to draw the controls: the shop, who is asked as what, the options and the bars.
export function morningView(rawSpec, pool) {
  const spec = world(rawSpec);
  if (!pool || typeof pool !== 'object') throw new Error('The next-morning question needs a pool file for this world.');
  const { shop } = shopView(spec, pool.shop ?? null);
  const people = morningPeople(spec, pool);
  return {
    shop: shop.id, price: shop.price, weeks: MORNING_WEEKS, cardNeed: CARD.need,
    people: Object.fromEntries(people.map(p => [p.mind.id, { visits: p.visits, returning: p.returning }])),
    defaults: defaultMorning(pool),
    options: { ...MORNING_OPTIONS, wait: waitOptions(pool), priceChange: priceOptions(shop.price) },
    compare: { card: CARD_BASE, rating: RATING_BASE, message: `${shop.name}: ${PLAIN_MESSAGE}`, remark: friendRemark(OTHER_REMARK) },
    deal: `${shop.name}: ${DEAL_TEXT}`, dealOff: DEAL_OFF,
    remarks: Object.fromEntries(MORNING_OPTIONS.remark.map(k => [k, friendRemark(REMARK_KINDS[k], shop.name)])),
    noise: MORNING_NOISE, noisePerson: MORNING_NOISE_PERSON
  };
}

// Ask every (or the chosen) cast member twice: the record set by the page and the record it is compared with.
// `provider` is any decision provider (Jev, or recordProvider from run/room.js). Each answer is the chance of
// going to the shop today. The shares are over the returning customers only, as the probe reports them: a
// person who has never been is a different question and is reported on their own row.
export async function askMorning({ spec: rawSpec, pool, scenario, only = null, provider }) {
  const spec = world(rawSpec);
  if (!pool || typeof pool !== 'object') throw new Error('The next-morning question needs a pool file for this world.');
  const { shop } = shopView(spec, pool.shop ?? null);
  const now = normalizeMorning(pool, scenario, shop.price), base = defaultMorning(pool);
  const wanted = Array.isArray(only) && only.length ? new Set(only.map(String)) : null;
  const people = morningPeople(spec, pool).filter(p => !wanted || wanted.has(p.mind.id));
  const ctx = { shopName: shop.name, price: shop.price, pool };

  const jobs = [];
  for (const person of people) {
    const records = morningRecords(now, person, ctx);
    jobs.push({ person, records, arm: 'before', req: morningRoomRequest(spec, shop.id, person.mind, records.before, 'before') });
    jobs.push({ person, records, arm: 'now', req: morningRoomRequest(spec, shop.id, person.mind, records.now, 'now') });
  }
  const decisions = await provider.decideMany(jobs.map(j => j.req), { spec });
  if (!Array.isArray(decisions) || decisions.length !== jobs.length) throw new Error('The provider did not answer every question.');

  const answered = d => ['jev', 'jev-cache', 'recorded'].includes(d?.provider) && Number.isFinite(d.yesProb);
  const groupName = id => spec.archetypes.find(a => a.id === id)?.name || id;
  const out = people.map(person => {
    const mine = jobs.map((j, i) => ({ ...j, d: decisions[i] })).filter(j => j.person === person);
    const arm = name => mine.find(j => j.arm === name);
    const m = person.mind, chance = j => (answered(j.d) ? j.d.yesProb : null);
    return {
      id: m.id, name: m.name, age: m.age, group: groupName(m.archetype), bio: m.bio, personality: m.personality, goal: m.goal,
      returning: person.returning, visits: person.visits, applies: mine[0].records.applies, partly: mine[0].records.partly,
      before: chance(arm('before')), now: chance(arm('now')),
      told: { before: toldOf(arm('before').req.observation), now: toldOf(arm('now').req.observation) },
      source: mine.every(j => answered(j.d)) ? (mine.some(j => j.d.provider === 'jev') ? 'live' : 'recorded') : 'failed'
    };
  });

  // The sentences that say nothing, as one returning customer was told them (they are the same for everyone).
  const sample = jobs.find(j => j.arm === 'before' && j.person.returning) || jobs.find(j => j.arm === 'before');
  const told = sample ? toldOf(sample.req.observation) : null;
  const compare = {};
  if (told) {
    if (now.priceChange !== 0 && now.message !== 'deal' && sample.person.returning) compare.price = told.cost;
    if (now.card != null && told.card) compare.card = told.card;
    if (told.heard.length) compare.remark = told.heard[0];
    if (told.rating) compare.rating = told.rating;
    if (told.offers.length) compare.message = told.offers[0];
  }
  const regulars = out.filter(p => p.returning && p.before != null && p.now != null);
  const mean = f => (regulars.length ? regulars.reduce((s, p) => s + f(p), 0) / regulars.length : null);
  return {
    mode: 'morning', shop: shop.id, scenario: now, changed: differs(now, base, Object.keys(base)), compare,
    noise: MORNING_NOISE, noisePerson: MORNING_NOISE_PERSON,
    share: { before: mean(p => p.before), now: mean(p => p.now) }, returning: out.filter(p => p.returning).length,
    asked: jobs.length, askedLive: decisions.filter(d => d?.provider === 'jev').length,
    failed: out.filter(p => p.source === 'failed').length, people: out
  };
}
