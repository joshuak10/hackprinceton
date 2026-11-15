// The multi-day loop (docs/PROTOTYPE.md §21): the same people over days.
//
// Each morning everyone who knows the shop is asked the morning question (run/morning.js) with their own
// record. The people who go are that day's arrivals on the engine. Each evening what happened to them is
// written back into their record. A person's chance of coming is their own usual rate moved by Jev's answer,
// not Jev's answer itself (§20d: Jev gets the direction and who reacts right, and squeezes the level).
//
// Everything here is unvalidated: the size of the wait effect is unchecked and every usual rate is an
// assumption until an owner's data replaces it. Compare a change with its baseline on the same seeds.
import { normalizeSpec, applyPatch } from '../engine/spec.js';
import { seedRng, hash32 } from '../engine/util.js';
import { runSwarm } from './runner.js';
import { morningRequest, friendRemark, shopView } from './morning.js';

export const WEEK = 5;               // a week is 5 weekday mornings
export const MEMORY_DAYS = 28;       // a visit is remembered for this many calendar days (Jev was checked up to 4 weeks)
export const MEMORY_VISITS = 3;      // visits one record shows (§20d: Jev adds up to three)
export const HEARD_DAYS = 7;         // a remark is remembered for this many calendar days
export const HEARD_SHOWN = 2;
export const TIME_JITTER = 10;       // minutes either side of a person's usual time
const HISTORY_DAYS = 4 * WEEK;       // "N times in the last 4 weeks"

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const logit = p => { const q = clamp(p, 0.002, 0.998); return Math.log(q / (1 - q)); };
const sigmoid = x => 1 / (1 + Math.exp(-x));
const round2 = x => Math.round(x * 100) / 100;
// A wait as a person remembers it: to the minute when short, to the nearest 5 minutes from 10 up.
export const rememberedWait = m => { const x = Math.max(0, Number(m) || 0); return x < 1 ? 0 : x < 10 ? Math.round(x) : Math.round(x / 5) * 5; };
// Day 5 is the Monday after day 4: three calendar days later.
export const calendarDay = d => Math.floor(d / WEEK) * 7 + (d % WEEK);
const daysBetween = (from, to) => calendarDay(to) - calendarDay(from);

// ---------- the pool ----------

const num = (v, def, lo, hi) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? clamp(Number(v), lo, hi) : def);

// Fills in defaults and drops what cannot be used. Throws only when the pool cannot run at all.
export function normalizePool(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  if (!r.people || typeof r.people !== 'object') throw new Error('A pool needs "people": how often each cast member usually comes.');
  const people = {};
  for (const [id, p] of Object.entries(r.people)) {
    people[id] = {
      usualPerWeek: num(p?.usualPerWeek, 0, 0, WEEK), knows: num(p?.knows, 0, 0, 1), weight: num(p?.weight, 1, 0, 100),
      newcomer: p?.newcomer === true, dayVisitor: p?.dayVisitor === true
    };
  }
  const habit = Array.isArray(r.habit) && r.habit.length ? r.habit.map(h => num(h, 1, 0.01, 1)) : [0.25, 0.62, 0.83, 0.93, 1];
  return {
    title: String(r.title || ''), world: r.world || null, shop: r.shop || null,
    size: Math.round(num(r.size, 200, 1, 5000)), people,
    ordinaryWait: num(r.ordinaryWait, 5, 0, 120), trialPerWeek: num(r.trialPerWeek, 0.5, 0.01, WEEK),
    walkPast: num(r.walkPast, 0.03, 0, 1), tellReach: Math.round(num(r.tellReach, 2, 0, 20)), habit,
    rules: { lossAversion: num(r.rules?.lossAversion, 2, 1, 5) }
  };
}

// One usual arrival time, drawn from the world's arrival shape.
function usualTime(arrivals, rng) {
  const x = rng();
  const u = arrivals.shape === 'uniform' || arrivals.shape === 'poisson' ? x
    : arrivals.shape === 'early' ? 1 - Math.sqrt(1 - x) : arrivals.shape === 'late' ? Math.sqrt(x) : (x + rng()) / 2;
  return arrivals.start + u * (arrivals.end - arrivals.start);
}

// The people of the pool on day 0. Each is a copy of a cast member, in the world's group shares, with their
// own record. The make-up is the same for every seed; the seed sets who already comes and each usual time.
export function buildPeople(pool, spec, seed = 7) {
  const cast = spec.minds.filter(m => pool.people[m.id] && !pool.people[m.id].dayVisitor && pool.people[m.id].weight > 0);
  if (!cast.length) throw new Error('None of the pool\'s people are in this world\'s cast.');
  const perGroup = new Map();
  for (const m of cast) perGroup.set(m.archetype, (perGroup.get(m.archetype) || 0) + (m.weight ?? 1));
  // The world's group shares, then the pool's own weight for each kind of person (a street has far more
  // people who rarely or never come than a morning's arrivals show).
  const share = m => (spec.archetypes.find(a => a.id === m.archetype)?.share ?? 0) * (m.weight ?? 1) / perGroup.get(m.archetype) * pool.people[m.id].weight;
  const total = cast.reduce((s, m) => s + share(m), 0) || 1;
  // Largest-remainder rounding, so the counts add up to the pool's size.
  const exact = cast.map(m => pool.size * share(m) / total);
  const counts = exact.map(Math.floor);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0, left = pool.size - counts.reduce((s, c) => s + c, 0); k < left; k++) counts[order[k % order.length][1]]++;

  const refPrice = shopView(spec, pool.shop).shop.price;
  const people = [];
  cast.forEach((m, i) => {
    const role = pool.people[m.id];
    const knowing = Math.round(counts[i] * role.knows);
    for (let k = 0; k < counts[i]; k++) {
      const id = `${m.id}-${k + 1}`;
      const rng = seedRng(seed, 'person', id);
      const knows = k < knowing;
      people.push({
        id, persona: m.id, group: m.archetype, usual: role.usualPerWeek / WEEK, time: usualTime(spec.arrivals, rng),
        knows, via: null, established: knows,   // established: came before day 0, at their usual rate
        went: [],        // days they came
        visits: [],      // { day, wait, outcome, ahead, paid } at the shop
        served: 0, lastPaid: knows ? refPrice : null, card: null, heard: []
      });
    }
  });
  return people;
}

// ---------- changes ----------

// { from, to, patch, card, promo, label }. `patch` is a what-if patch (§15), `card` { need, reward },
// `promo` { text, priceOff, reach }. Days outside from..to run as the baseline.
export function changeFor(name, spec, shopId, days) {
  const { shop } = shopView(spec, shopId);
  const whole = { from: 0, to: days - 1 };
  if (name == null || name === '' || name === 'none') return null;
  if (name === 'staff+1') return { ...whole, label: `+1 staff at ${shop.name}`, patch: [{ kind: 'node', id: shop.id, field: 'servers', value: shop.servers + 1 }] };
  const price = /^price([+-]\d+(?:\.\d+)?)$/.exec(name);
  if (price) {
    const to = round2(shop.price + Number(price[1]));
    return { ...whole, label: `Price ${Number(price[1]) > 0 ? 'up' : 'down'} to $${to.toFixed(2)}`, patch: [{ kind: 'node', id: shop.id, field: 'price', value: to }] };
  }
  const promo = /^promo(\d+)$/.exec(name);
  if (promo) {
    const off = clamp(Number(promo[1]) / 100, 0.01, 0.9);
    return { from: 0, to: Math.min(days, WEEK) - 1, label: `${promo[1]}% off for the first week, heard of by half the street`, promo: { text: `${shop.name}: ${promo[1]}% off everything today.`, priceOff: off, reach: 0.5 } };
  }
  const card = /^card(\d+)$/.exec(name);
  if (card) return { ...whole, label: `Stamp card: buy ${Number(card[1]) - 1}, the next is free`, card: { need: Math.max(2, Number(card[1])), reward: 'a free coffee' } };
  throw new Error(`Unknown change "${name}". Use staff+1, price+0.5, promo20 or card10.`);
}

const activeOn = (change, d) => Boolean(change) && d >= change.from && d <= change.to;

// ---------- one morning ----------

const agoWords = n => (n <= 1 ? 'yesterday' : n % 7 === 0 ? (n === 7 ? '1 week ago' : `${n / 7} weeks ago`) : `${n} days ago`);

// How many times they came in the last 4 weeks. Before day 0 an established customer came at their usual rate.
function visitCount(person, d) {
  const before = person.established ? person.usual * Math.max(0, HISTORY_DAYS - d) : 0;
  return Math.round(before) + person.went.filter(x => d - x <= HISTORY_DAYS).length;
}

// Today's record for the morning question, and the same person on an ordinary day (§21b).
export function recordsFor(person, d, ctx) {
  const been = person.established || person.went.length > 0;
  const history = been ? { visits: Math.max(1, visitCount(person, d)), weeks: 4 } : { visits: 0, via: person.via || 'has walked past it' };
  const remembered = person.visits.filter(v => daysBetween(v.day, d) <= MEMORY_DAYS).slice(-MEMORY_VISITS).reverse();
  const memory = remembered.map(v => ({ daysAgo: daysBetween(v.day, d), wait: v.wait, outcome: v.outcome, ahead: v.ahead }));
  const heard = person.heard.filter(h => daysBetween(h.day, d) <= HEARD_DAYS).slice(-HEARD_SHOWN).reverse()
    .map(h => friendRemark(h.kind, ctx.shopName, { when: agoWords(daysBetween(h.day, d)) }));
  const today = { history, memory, price: ctx.price };
  // "It was $5.00 last week" until they have paid the new price.
  if (person.lastPaid != null && round2(person.lastPaid) !== round2(ctx.price)) today.wasPrice = person.lastPaid;
  if (ctx.card && person.card) today.card = { have: person.card.have, need: ctx.card.need, reward: ctx.card.reward };
  if (heard.length) today.heard = heard;
  if (ctx.promo && person.reached) { today.offers = [ctx.promo.text]; today.offerPrice = round2(ctx.price * (1 - ctx.promo.priceOff)); }
  const reference = {
    history, price: ctx.refPrice,
    memory: remembered.map(v => ({ daysAgo: daysBetween(v.day, d), wait: ctx.ordinaryWait, outcome: 'served' }))
  };
  // The loss-aversion rule needs Jev's answer with everything as today except the price.
  const priceRise = round2(ctx.price) > round2(ctx.refPrice);
  const unpriced = priceRise ? { ...today, price: ctx.refPrice, wasPrice: undefined, offerPrice: today.offers ? round2(ctx.refPrice * (1 - ctx.promo.priceOff)) : undefined } : null;
  return { today, reference, unpriced };
}

// A person's usual chance today, before Jev moves it.
export function usualToday(person, pool) {
  if (!person.established && person.served === 0) return pool.trialPerWeek / WEEK;
  const habit = person.established ? 1 : pool.habit[Math.min(person.served, pool.habit.length) - 1];
  return person.usual * habit;
}

// A person's chance today: their usual rate, moved by the odds between Jev's answer for today's record (`now`)
// and for their reference record. With no answer (or the rule model) it is the usual rate. `unpriced` is Jev's
// answer with everything as today except the price: when given, the part of the move that the price rise
// caused is multiplied by `lossAversion` (rule; §20d found Jev shows none).
export function movedChance({ usual, now = null, reference = null, unpriced = null, lossAversion = 1 }) {
  if (now == null || reference == null) return clamp(usual, 0, 1);
  let shift = logit(now) - logit(reference);
  if (unpriced != null) {
    const other = logit(unpriced) - logit(reference);
    shift = other + lossAversion * (shift - other);
  }
  return sigmoid(logit(usual) + shift);
}

// Asks Jev for everyone whose record differs from their reference, and returns each person's chance today.
async function morning({ people, d, ctx, pool, spec, provider }) {
  const mindOf = id => spec.minds.find(m => m.id === id);
  const jobs = [], asks = [];
  for (const person of people) {
    if (!person.knows) continue;
    const { today, reference, unpriced } = recordsFor(person, d, ctx);
    const mind = mindOf(person.persona);
    const req = state => morningRequest({ spec, shopId: ctx.shopId, mind, state, id: `d${d}-${person.id}` });
    const job = { person, usual: usualToday(person, pool), today: null, reference: null, unpriced: null };
    const a = req(today), b = req(reference);
    // Nothing differs from an ordinary day: the chance is the usual rate and Jev is not asked.
    if (JSON.stringify(a.observation) !== JSON.stringify(b.observation)) {
      job.today = asks.push(a) - 1; job.reference = asks.push(b) - 1;
      if (unpriced && pool.rules.lossAversion !== 1) job.unpriced = asks.push(req(unpriced)) - 1;
    }
    jobs.push(job);
  }
  const answers = asks.length ? await provider.decideMany(asks, { spec }) : [];
  const p = i => (i == null ? null : Number.isFinite(answers[i]?.yesProb) ? answers[i].yesProb : null);
  for (const job of jobs) {
    job.chance = movedChance({ usual: job.usual, now: p(job.today), reference: p(job.reference), unpriced: p(job.unpriced), lossAversion: pool.rules.lossAversion });
  }
  return { jobs, asked: asks.length };
}

// ---------- one run ----------

// runDays({ pool, spec, days, seed, provider, change }) -> { days: [per-day numbers], people, asked, cost }.
// `pool` and `spec` are raw or normalized. `provider` is any decision provider; with the rule model nobody
// reads memory and everyone comes at their usual rate.
export async function runDays({ pool: rawPool, spec: rawSpec, days = 10, seed = 7, provider, change = null, onDay = null }) {
  const pool = normalizePool(rawPool);
  const base = normalizeSpec(rawSpec);
  if (base.mode !== 'visit') throw new Error('The multi-day loop needs a visit world.');
  const { shop } = shopView(base, pool.shop);
  const people = buildPeople(pool, base, seed);
  const byId = new Map(people.map(p => [p.id, p]));
  const refPrice = shop.price;
  const out = [];
  let asked = 0;

  for (let d = 0; d < days; d++) {
    const on = activeOn(change, d);
    const spec = on && change.patch ? applyPatch(base, change.patch).spec : base;
    const promo = on && change.promo ? change.promo : null;
    const card = on ? change.card ?? null : null;
    const price = shopView(spec, shop.id).shop.price;
    const ctx = { shopId: shop.id, shopName: shop.name, price, refPrice, ordinaryWait: pool.ordinaryWait, promo, card };

    // 1. Who hears of the shop, and who a promotion reaches.
    for (const person of people) {
      const rng = seedRng(seed, 'hear', person.id, d);
      const sees = rng(), reach = rng();
      person.reached = Boolean(promo) && reach < promo.reach;
      if (person.knows) continue;
      if (person.reached) { person.knows = true; person.via = 'saw its promotion'; person.knewOn = d; }
      else if (sees < pool.walkPast) { person.knows = true; person.via = 'has walked past it'; person.knewOn = d; }
    }

    // 2. The morning question.
    const { jobs, asked: n } = await morning({ people, d, ctx, pool, spec, provider });
    asked += n;
    const arrivals = [];
    for (const job of jobs) {
      const rng = seedRng(seed, 'go', job.person.id, d);
      const u = rng(), jitter = (rng() * 2 - 1) * TIME_JITTER;
      if (u >= job.chance) continue;
      const t = clamp(job.person.time + jitter, spec.arrivals.start, Math.max(spec.arrivals.start, spec.arrivals.end - 1));
      arrivals.push({ t: round2(t), persona: job.person.persona, first: shop.id, tag: job.person.id });
    }

    // 3. The day, on the engine. A promotion is an offer to everyone who comes: the discount is at the
    // counter, whoever heard of it beforehand.
    const daySpec = promo
      ? applyPatch(spec, [{ kind: 'offer', offer: { id: 'promotion', text: promo.text, place: shop.id, priceOff: promo.priceOff } }]).spec
      : spec;
    const run = arrivals.length
      ? await runSwarm({ spec: daySpec, seed: hash32(seed, 'day', d), provider, simOpts: { arrivals } })
      : null;
    const agents = run ? run.sim.agentsSummary() : [];
    const remarks = run ? run.sim.remarks : [];

    // 4. The evening update.
    const day = { day: d, known: people.filter(p => p.knows).length, went: arrivals.length, firstTime: 0, served: 0, left: 0, waitSum: 0, good: 0, bad: 0, asked: n, meanChance: jobs.length ? jobs.reduce((s, j) => s + j.chance, 0) / jobs.length : 0 };
    const tagOf = new Map();
    for (const a of agents) {
      const person = byId.get(a.tag);
      if (!person) continue;
      tagOf.set(a.id, person);
      if (!person.established && person.went.length === 0) { day.firstTime++; person.firstDay = d; }
      person.went.push(d);
      const mine = (a.lines || []).filter(l => l.place === shop.id);
      const servedLine = mine.find(l => l.outcome === 'served'), leftLine = mine.find(l => l.outcome === 'left');
      if (servedLine) {
        // Peak-end (rule): the visit is remembered by its worst wait and that it ended in being served.
        const paid = round2(promo ? price * (1 - promo.priceOff) : price);
        person.visits.push({ day: d, wait: rememberedWait(Math.max(...mine.map(l => l.wait))), outcome: 'served', ahead: null, paid });
        person.served++; person.lastPaid = price;
        day.served++; day.waitSum += servedLine.wait;
        if (card) { person.card = person.card || { have: 0 }; person.card.have = person.card.have + 1 >= card.need ? 0 : person.card.have + 1; }
      } else if (leftLine) {
        person.visits.push({ day: d, wait: rememberedWait(leftLine.wait), outcome: 'left', ahead: leftLine.ahead, paid: null });
        day.left++;
      }
    }
    for (const r of remarks) {
      if (r.placeId !== shop.id) continue;
      const speaker = tagOf.get(r.agentId);
      if (!speaker) continue;
      if (r.kind === 'good_experience') day.good++; else day.bad++;
      const group = people.filter(p => p.group === speaker.group && p !== speaker);
      const rng = seedRng(seed, 'tell', speaker.id, d, r.t);
      for (let k = 0; k < pool.tellReach && group.length; k++) {
        const listener = group[Math.floor(rng() * group.length)];
        listener.heard.push({ day: d, kind: r.kind });
        if (!listener.knows) { listener.knows = true; listener.via = 'a friend mentioned it'; listener.knewOn = d + 1; }
      }
    }
    day.avgWait = day.served ? round2(day.waitSum / day.served) : 0;
    delete day.waitSum;
    out.push(day);
    onDay?.(day);
  }
  return {
    days: out, asked,
    people: people.map(p => ({ id: p.id, persona: p.persona, group: p.group, established: p.established, knows: p.knows, went: p.went, served: p.served, firstDay: p.firstDay ?? null, visits: p.visits }))
  };
}

// ---------- results ----------

const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

// One arm of one seed, as the numbers an owner asks about.
export function summarize(run) {
  const n = run.days.length, weeks = n / WEEK;
  const total = k => run.days.reduce((s, d) => s + d[k], 0);
  const half = Math.floor(n / 2);
  const firsts = run.people.filter(p => p.firstDay != null && p.firstDay < half);
  const lastTen = p => p.went.filter(d => d >= n - 2 * WEEK).length;
  return {
    visitsPerWeek: total('went') / weeks, servedPerWeek: total('served') / weeks, walkAwaysPerWeek: total('left') / weeks,
    firstTimersPerWeek: total('firstTime') / weeks,
    avgWait: total('served') ? run.days.reduce((s, d) => s + d.avgWait * d.served, 0) / total('served') : 0,
    cameBack: firsts.length ? firsts.filter(p => p.went.length > 1).length / firsts.length : null,
    firstTimers: firsts.length,
    regulars: run.people.filter(p => lastTen(p) >= 3).length,
    goodRemarksPerWeek: total('good') / weeks, badRemarksPerWeek: total('bad') / weeks
  };
}

// Level 2 of the benchmark (REPEAT_CUSTOMERS_SPEC §9), on one baseline run.
export function realism(run) {
  const n = run.days.length, half = Math.floor(n / 2);
  const counts = run.people.map(p => p.went.length).filter(c => c > 0).sort((a, b) => b - a);
  const visits = counts.reduce((s, c) => s + c, 0);
  const top = counts.slice(0, Math.max(1, Math.round(counts.length / 5))).reduce((s, c) => s + c, 0);
  const first = run.days.slice(0, half).reduce((s, d) => s + d.went, 0) / Math.max(1, half);
  const second = run.days.slice(half).reduce((s, d) => s + d.went, 0) / Math.max(1, n - half);
  // Of visits made with at least 5 days left to run: the share followed by another visit within 5 days.
  const again = sel => {
    let made = 0, back = 0;
    for (const p of run.people.filter(sel)) {
      const days = p.established ? p.went : p.went.slice(0, 1);
      for (const d of days) { if (d > n - 1 - WEEK) continue; made++; if (p.went.some(x => x > d && x <= d + WEEK)) back++; }
    }
    return made ? back / made : null;
  };
  const established = again(p => p.established), newcomers = again(p => !p.established && p.went.length > 0);
  return {
    lopsided: { topFifthShare: visits ? top / visits : null, pass: visits ? top / visits >= 0.4 : null },
    steady: { firstHalfPerDay: first, secondHalfPerDay: second, change: first ? second / first - 1 : null, pass: first ? Math.abs(second / first - 1) <= 0.15 : null },
    newcomersReturnLess: { established, newcomers, pass: established != null && newcomers != null ? newcomers < established : null }
  };
}

const METRICS = ['visitsPerWeek', 'servedPerWeek', 'walkAwaysPerWeek', 'firstTimersPerWeek', 'avgWait', 'cameBack', 'regulars', 'goodRemarksPerWeek', 'badRemarksPerWeek'];

// The baseline and each change on the same seeds. Effects are seed by seed, so what the arms share cancels.
// `changes` is a list of change objects (changeFor); the baseline is run once per seed.
export async function compareDays({ pool, spec, days = 10, seeds = [7, 8, 9], provider, changes = [], onProgress = null }) {
  const baselines = [];
  for (const seed of seeds) {
    const run = await runDays({ pool, spec, days, seed, provider, onDay: d => onProgress?.({ seed, arm: 'baseline', day: d }) });
    baselines.push({ seed, run, summary: summarize(run), realism: realism(run) });
  }
  const results = [];
  for (const change of changes) {
    const arms = [];
    for (const b of baselines) {
      const run = await runDays({ pool, spec, days, seed: b.seed, provider, change, onDay: d => onProgress?.({ seed: b.seed, arm: change.label, day: d }) });
      arms.push({ seed: b.seed, run, summary: summarize(run) });
    }
    const effects = {};
    for (const k of METRICS) {
      const pairs = baselines.map((b, i) => [b.summary[k], arms[i].summary[k]]).filter(([x, y]) => x != null && y != null);
      if (!pairs.length) continue;
      const diffs = pairs.map(([x, y]) => y - x);
      effects[k] = {
        before: mean(pairs.map(p => p[0])), after: mean(pairs.map(p => p[1])),
        mean: mean(diffs), min: Math.min(...diffs), max: Math.max(...diffs),
        // Every seed agrees in direction (REPEAT_CUSTOMERS_SPEC §9b).
        agrees: diffs.every(x => x > 0) || diffs.every(x => x < 0)
      };
    }
    results.push({ change: { label: change.label, from: change.from, to: change.to }, arms, effects });
  }
  return { days, seeds, baselines, results };
}

// ---------- report ----------

const LABELS = {
  visitsPerWeek: 'Visits per week', servedPerWeek: 'Served per week', walkAwaysPerWeek: 'Walk-aways per week',
  firstTimersPerWeek: 'First-time visitors per week', avgWait: 'Average wait (min)', cameBack: 'First-timers who came back',
  regulars: 'Regulars (3+ visits in the last 10 days)', goodRemarksPerWeek: 'Good remarks per week', badRemarksPerWeek: 'Bad remarks per week'
};
const fmt = (k, x) => (x == null ? '-' : k === 'cameBack' ? `${Math.round(x * 100)}%` : k === 'avgWait' ? x.toFixed(1) : String(Math.round(x)));
const signed = (k, x) => (k === 'cameBack' ? `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 100))} pts` : `${x >= 0 ? '+' : '−'}${k === 'avgWait' ? Math.abs(x).toFixed(1) : Math.abs(Math.round(x))}`);
const pass = v => (v == null ? 'not enough data' : v ? 'pass' : 'FAIL');

// Plain-text lines for one compareDays result.
export function renderDays(result, { title = '', provider = '' } = {}) {
  const L = [];
  const seeds = result.seeds;
  L.push(`${title} · ${result.days} weekday mornings · seeds ${seeds[0]}..${seeds.at(-1)} · ${provider}`);
  L.push('Unvalidated: every usual rate in the pool is an assumption, and the size of the wait effect is unchecked');
  L.push('(docs/PROTOTYPE.md §20d, §21). Read a change against its baseline on the same seeds, not the levels.');
  if (provider !== 'jev') L.push('Rule model: nobody reads memory, so everyone comes at their usual rate. This is a dry run.');
  L.push('', `Baseline, average of ${seeds.length} seed${seeds.length === 1 ? '' : 's'}:`);
  for (const k of METRICS) {
    const xs = result.baselines.map(b => b.summary[k]).filter(x => x != null);
    if (xs.length) L.push(`  ${LABELS[k].padEnd(42)} ${fmt(k, mean(xs)).padStart(6)}   (${fmt(k, Math.min(...xs))} to ${fmt(k, Math.max(...xs))})`);
  }
  L.push('', 'Realism checks on the baseline (level 2), seed by seed:');
  const r = result.baselines.map(b => b.realism);
  L.push(`  Visits are lopsided (busiest fifth make 40% or more): ${r.map(x => `${x.lopsided.topFifthShare == null ? '-' : Math.round(x.lopsided.topFifthShare * 100) + '%'} ${pass(x.lopsided.pass)}`).join(', ')}`);
  L.push(`  The baseline holds steady (second half within 15% of the first): ${r.map(x => `${x.steady.change == null ? '-' : (x.steady.change >= 0 ? '+' : '−') + Math.abs(Math.round(x.steady.change * 100)) + '%'} ${pass(x.steady.pass)}`).join(', ')}`);
  L.push(`  New customers come back less than established ones: ${r.map(x => `${x.newcomersReturnLess.newcomers == null ? '-' : Math.round(x.newcomersReturnLess.newcomers * 100) + '%'} against ${x.newcomersReturnLess.established == null ? '-' : Math.round(x.newcomersReturnLess.established * 100) + '%'} ${pass(x.newcomersReturnLess.pass)}`).join(', ')}`);
  for (const res of result.results) {
    L.push('', `${res.change.label} (days ${res.change.from + 1} to ${res.change.to + 1}), against the baseline on the same seeds:`);
    for (const k of METRICS) {
      const e = res.effects[k];
      if (!e) continue;
      const range = seeds.length > 1 ? `  (${signed(k, e.min)} to ${signed(k, e.max)})` : '';
      const verdict = seeds.length < 2 ? '' : e.min === 0 && e.max === 0 ? '  no change' : e.agrees ? '  every seed agrees' : '  seeds disagree: no clear effect';
      L.push(`  ${LABELS[k].padEnd(42)} ${fmt(k, e.before).padStart(6)} → ${fmt(k, e.after).padStart(6)}   ${signed(k, e.mean).padStart(8)}${range}${verdict}`);
    }
  }
  return L;
}
