// Targeted offers (docs/PROTOTYPE.md §15b): normalization and validation, cleanSpec round trip, what a
// matching agent sees and pays, the window, the effect under the rules provider on the same seed,
// metrics().offers, the patch op, and Jev request bodies with and without offers. All worlds and
// people here are fictional and hand-made.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpec, validateWorld, cleanSpec, specHash, applyPatch, PATCH_FIELDS } from '../engine/spec.js';
import { Sim } from '../engine/sim.js';
import { visitObservation, routeObservation, OFFERS_MAX } from '../engine/observe.js';
import { buildJevRequest } from '../providers/jev.js';
import { RulesProvider } from '../providers/rules.js';

// ---------- fixtures ----------

// Two bakeries the same walk from the street: a cheap one and a dearer, more appealing one. Nobody has
// the app (info 0) and both have room for everyone, so the rules policy weighs only appeal and price.
const BAKERIES = {
  title: 'Alder Street bakeries (fictional)',
  question: 'Which bakery do students pick on a Saturday morning?',
  context: 'Saturday morning on Alder Street in a fictional town. People pick a bakery for breakfast.',
  mode: 'visit', duration: 240, clockStart: 480, travelSpeed: 20,
  arrivals: { total: 400, start: 0, end: 150, shape: 'uniform' },
  nodes: [
    { id: 'street', name: 'Street corner', kind: 'gate', x: 50, y: 90 },
    { id: 'corner_loaf', name: 'Corner Loaf', kind: 'service', x: 30, y: 40, servers: 60, serviceTime: 2, serviceDist: 'fixed', appeal: 0.5, price: 6, tags: ['bread'], about: 'Plain loaves, cheap and quick' },
    { id: 'maison_crumb', name: 'Maison Crumb', kind: 'service', x: 70, y: 40, servers: 60, serviceTime: 2, serviceDist: 'fixed', appeal: 0.8, price: 30, tags: ['bread'], about: 'Fancy pastries at fancy prices' }
  ],
  archetypes: [
    { id: 'students', name: 'Students', share: 1, visits: 1, patience: 30, info: 0, weights: { appeal: 1, wait: 1, distance: 1, price: 1 } },
    { id: 'parents', name: 'Parents', share: 1, visits: 1, patience: 30, info: 0, weights: { appeal: 1, wait: 1, distance: 1, price: 1 } }
  ],
  minds: [
    { id: 'ana', name: 'Ana Quill', age: 20, archetype: 'students', bio: 'Second-year student on a tight budget.', informed: false },
    { id: 'ben', name: 'Ben Ortolan', age: 23, archetype: 'students', bio: 'Grad student who treats himself on Saturdays.', informed: false },
    { id: 'carla', name: 'Carla Vint', age: 41, archetype: 'parents', bio: 'Buying breakfast for three kids before soccer.', informed: false }
  ]
};

const STUDENT_HALF = {
  id: 'student_half', text: 'Student deal: half price at Maison Crumb this morning',
  to: { groups: ['students'] }, place: 'maison_crumb', priceOff: 0.5
};

const copy = w => JSON.parse(JSON.stringify(w));
const withOffers = (...offers) => ({ ...copy(BAKERIES), offers: copy(offers) });
const PRICE = { corner_loaf: 6, maison_crumb: 30 };

// Drives an external-mode Sim to the end; `answer(req)` returns the Decision (default: the rule policy).
function runExternal(world, { seed = 7, answer = r => ({ provider: 'rules', action: r.auto?.action ?? undefined }) } = {}) {
  const sim = new Sim(world, { seed, external: true });
  const reqs = [];
  const drain = () => { for (const r of sim.pending()) { reqs.push(r); sim.resolve(r.id, answer(r)); } };
  while (!sim.done) { sim.step(); drain(); }
  drain();
  return { sim, reqs };
}

const placeOf = (obs, id) => obs.places.find(p => p.option === id);
const wentTo = (sim, group, place) => sim.agentsSummary().filter(a => a.archetypeId === group && a.visits[0] === place).length;

// ---------- normalization and validation ----------

describe('offers: normalization and validation', () => {
  const warningsFor = offers => validateWorld({ ...copy(BAKERIES), offers }).warnings.filter(w => w.startsWith('offers'));

  test('a complete offer is kept as written, with names resolved to ids', () => {
    const spec = normalizeSpec(withOffers({
      id: 'deal', text: '  Half   price  ', to: { groups: ['Students'], cast: ['Carla Vint'] }, place: 'Maison Crumb', priceOff: 0.5, from: 30, until: 90
    }));
    assert.deepEqual(spec.offers, [{
      id: 'deal', text: 'Half price', to: { groups: ['students'], cast: ['carla'] }, place: 'maison_crumb', priceOff: 0.5, from: 30, until: 90
    }]);
  });

  test('defaults: no `to` or an empty one means everyone; the window is the whole run; no discount', () => {
    for (const to of [undefined, null, {}, { groups: [], cast: [] }]) {
      const spec = normalizeSpec(withOffers({ text: 'Fresh bread at noon', ...(to === undefined ? {} : { to }) }));
      assert.deepEqual(spec.offers, [{ id: 'offer1', text: 'Fresh bread at noon', to: { groups: [], cast: [] }, place: null, priceOff: 0, from: 0, until: 240 }]);
    }
    assert.deepEqual(warningsFor([{ text: 'Fresh bread at noon' }]), []);
  });

  test('a world without offers carries offers: []', () => {
    assert.deepEqual(normalizeSpec(BAKERIES).offers, []);
  });

  test('text is cut to 160 characters', () => {
    const long = 'x'.repeat(200);
    const spec = normalizeSpec(withOffers({ text: long }));
    assert.equal(spec.offers[0].text, 'x'.repeat(160));
    assert.deepEqual(warningsFor([{ text: long }]), ['offers[0].text: longer than 160 characters; cut to 160']);
  });

  test('unknown group and cast ids are warnings and are dropped; the rest of the audience stays', () => {
    const offer = { id: 'o', text: 'Deal', to: { groups: ['students', 'ghosts'], cast: ['nobody', 'carla'] } };
    assert.deepEqual(normalizeSpec(withOffers(offer)).offers[0].to, { groups: ['students'], cast: ['carla'] });
    assert.deepEqual(warningsFor([offer]), [
      'offers[0].to.groups[1]: "ghosts" is not an archetype id or name; dropped',
      'offers[0].to.cast[0]: "nobody" is not a cast member id or name; dropped'
    ]);
  });

  test('an offer whose whole audience is unknown is dropped, never sent to everyone', () => {
    const offer = { id: 'o', text: 'Deal', to: { groups: ['ghosts'], cast: ['nobody'] } };
    assert.deepEqual(normalizeSpec(withOffers(offer)).offers, []);
    assert.deepEqual(warningsFor([offer]), [
      'offers[0].to.groups[0]: "ghosts" is not an archetype id or name; dropped',
      'offers[0].to.cast[0]: "nobody" is not a cast member id or name; dropped',
      'offers[0].to: none of the people it names exist; offer dropped'
    ]);
    assert.ok(validateWorld({ ...copy(BAKERIES), offers: [offer] }).ok, 'unknown audience ids are warnings, not errors');
  });

  test('an unreadable audience drops the offer', () => {
    assert.deepEqual(normalizeSpec(withOffers({ text: 'Deal', to: 'students' })).offers, []);
    assert.deepEqual(warningsFor([{ text: 'Deal', to: 'students' }]), ['offers[0].to: "students" is not an object { groups, cast }; offer dropped']);
    assert.deepEqual(warningsFor([{ text: 'Deal', to: { groups: 'students' } }]), [
      'offers[0].to.groups: "students" is not a list; ignored',
      'offers[0].to: none of the people it names exist; offer dropped'
    ]);
  });

  test('place resolves to a service node id, or null with a warning', () => {
    const at = place => normalizeSpec(withOffers({ text: 'Deal', place })).offers[0].place;
    assert.equal(at('maison_crumb'), 'maison_crumb');
    assert.equal(at('Corner Loaf'), 'corner_loaf');
    assert.equal(at('street'), null);
    assert.equal(at('moon'), null);
    assert.equal(at(null), null);
    assert.deepEqual(warningsFor([{ text: 'Deal', place: 'street' }]), ['offers[0].place: "street" is a gate, not a service place; the offer is about no place']);
    assert.deepEqual(warningsFor([{ text: 'Deal', place: 'moon' }]), ['offers[0].place: "moon" is not a node id or name; the offer is about no place']);
  });

  test('priceOff is clamped to 0-1 and needs a place', () => {
    const off = o => normalizeSpec(withOffers({ text: 'Deal', place: 'maison_crumb', ...o })).offers[0].priceOff;
    assert.equal(off({ priceOff: 1.5 }), 1);
    assert.equal(off({ priceOff: -0.2 }), 0);
    assert.equal(off({ priceOff: '0.25' }), 0.25);
    assert.deepEqual(warningsFor([{ text: 'Deal', place: 'maison_crumb', priceOff: 1.5 }]), ['offers[0].priceOff: 1.5 is above the maximum 1; using 1']);
    assert.deepEqual(warningsFor([{ text: 'Deal', place: 'maison_crumb', priceOff: -0.2 }]), ['offers[0].priceOff: -0.2 is below the minimum 0; using 0']);
    assert.equal(normalizeSpec(withOffers({ text: 'Deal', priceOff: 0.5 })).offers[0].priceOff, 0);
    assert.deepEqual(warningsFor([{ text: 'Deal', priceOff: 0.5 }]), ['offers[0].priceOff: a discount needs a service place; ignored']);
  });

  test('from and until are minutes inside the run, until never before from', () => {
    const win = o => { const x = normalizeSpec(withOffers({ text: 'Deal', ...o })).offers[0]; return [x.from, x.until]; };
    assert.deepEqual(win({ from: 30, until: 90 }), [30, 90]);
    assert.deepEqual(win({ from: 60 }), [60, 240]);
    assert.deepEqual(win({ until: 500 }), [0, 240]);
    assert.deepEqual(win({ from: 100, until: 50 }), [100, 100]);
    assert.deepEqual(win({ from: -5 }), [0, 240]);
    assert.deepEqual(warningsFor([{ text: 'Deal', from: 100, until: 50 }]), ['offers[0].until: 50 is below the minimum 100; using 100']);
    assert.deepEqual(warningsFor([{ text: 'Deal', until: 500 }]), ['offers[0].until: 500 is above the maximum 240; using 240']);
  });

  test('missing text: filled from the discount when there is one, otherwise the offer is dropped', () => {
    const spec = normalizeSpec(withOffers({ place: 'maison_crumb', priceOff: 0.25 }));
    assert.equal(spec.offers[0].text, '25% off at Maison Crumb');
    assert.deepEqual(warningsFor([{ place: 'maison_crumb', priceOff: 0.25 }]), ['offers[0].text: missing; using "25% off at Maison Crumb"']);
    assert.deepEqual(normalizeSpec(withOffers({ place: 'maison_crumb' })).offers, []);
    assert.deepEqual(warningsFor([{ place: 'maison_crumb' }]), ['offers[0].text: missing; offer dropped']);
  });

  test('ids: slugged, unique, filled when missing; unknown fields and non-objects are warnings', () => {
    const spec = normalizeSpec(withOffers({ id: 'Deal!', text: 'a' }, { id: 'deal', text: 'b' }, { text: 'c' }));
    assert.deepEqual(spec.offers.map(o => o.id), ['deal', 'deal_1', 'offer3']);
    assert.deepEqual(warningsFor([{ text: 'a', colour: 'red' }, 'nope']), ['offers[0].colour: unknown field; ignored', 'offers[1]: not an object; ignored']);
    assert.deepEqual(warningsFor([{ text: 'a', to: { groups: ['students'], ages: [20] } }]), ['offers[0].to.ages: unknown field; ignored']);
  });

  test('at most 50 offers', () => {
    const many = Array.from({ length: 53 }, (_, i) => ({ text: `Deal ${i}` }));
    assert.equal(normalizeSpec(withOffers(...many)).offers.length, 50);
    assert.deepEqual(warningsFor(many), ['offers: 53 entries; only the first 50 are used']);
  });

  test('route mode: offers are messages only (no service places)', () => {
    const roads = {
      title: 'Ferry or bridge (fictional)', mode: 'route', duration: 60,
      nodes: [{ id: 'a', name: 'Avon', kind: 'origin', x: 10, y: 50 }, { id: 'b', name: 'Bree', kind: 'destination', x: 90, y: 50 }],
      edges: [{ from: 'a', to: 'b', name: 'Long Road' }],
      offers: [{ id: 'radio', text: 'Ferry fares are waived today', place: 'b', priceOff: 0.5 }]
    };
    const v = validateWorld(roads);
    assert.ok(v.ok);
    assert.deepEqual(v.spec.offers, [{ id: 'radio', text: 'Ferry fares are waived today', to: { groups: [], cast: [] }, place: null, priceOff: 0, from: 0, until: 60 }]);
    assert.ok(v.warnings.includes('offers[0].place: "b" is a destination, not a service place; the offer is about no place'));
  });
});

// ---------- cleanSpec ----------

describe('offers: cleanSpec round trip', () => {
  test('normalize → clean → normalize keeps every offer exactly', () => {
    const spec = normalizeSpec(withOffers(STUDENT_HALF, { text: 'Open late tonight', from: 120 }));
    const clean = cleanSpec(spec);
    assert.deepEqual(clean.offers, spec.offers);
    const again = normalizeSpec(JSON.parse(JSON.stringify(clean)));
    assert.deepEqual(again.offers, spec.offers);
    assert.deepEqual(cleanSpec(again), clean);
    assert.equal(specHash(again), specHash(spec));
    assert.deepEqual(validateWorld(clean).warnings, []);
  });

  test('without offers, cleanSpec and the hash are exactly as before (no offers key)', () => {
    const plain = normalizeSpec(BAKERIES), empty = normalizeSpec({ ...copy(BAKERIES), offers: [] });
    assert.ok(!('offers' in cleanSpec(plain)));
    assert.deepEqual(cleanSpec(empty), cleanSpec(plain));
    assert.equal(specHash(empty), specHash(plain));
    assert.notEqual(specHash(normalizeSpec(withOffers(STUDENT_HALF))), specHash(plain));
  });
});

// ---------- what agents see ----------

describe('offers: what a matching agent sees', () => {
  test('a student sees the text and the discounted cost words; a parent sees neither', () => {
    const { reqs } = runExternal(withOffers(STUDENT_HALF));
    const starts = reqs.filter(r => r.kind === 'choose' && r.why === 'start');
    const student = starts.find(r => r.archetypeId === 'students'), parent = starts.find(r => r.archetypeId === 'parents');
    assert.ok(student && parent);
    assert.deepEqual(student.observation.offers, ['Student deal: half price at Maison Crumb this morning']);
    assert.equal(placeOf(student.observation, 'maison_crumb').cost, 'about $15 with the offer (usually about $30)');
    assert.equal(placeOf(student.observation, 'corner_loaf').cost, 'about $6');
    assert.ok(!('offers' in parent.observation));
    assert.equal(placeOf(parent.observation, 'maison_crumb').cost, 'about $30');
    // Every student decision carries the offer, and no parent decision does.
    for (const r of reqs.filter(r => r.observation.places)) {
      assert.equal('offers' in r.observation, r.archetypeId === 'students', r.id);
    }
  });

  test('a cast member can be targeted alone', () => {
    const { reqs } = runExternal(withOffers({ ...STUDENT_HALF, to: { cast: ['ana'] } }));
    const starts = reqs.filter(r => r.why === 'start');
    assert.ok(starts.some(r => r.personaId === 'ana') && starts.some(r => r.personaId === 'ben'));
    for (const r of starts) assert.equal('offers' in r.observation, r.personaId === 'ana', r.id);
  });

  test('the offer only shows inside its window', () => {
    const { reqs } = runExternal(withOffers({ ...STUDENT_HALF, from: 40, until: 90 }));
    const starts = reqs.filter(r => r.why === 'start' && r.archetypeId === 'students');
    const inside = starts.filter(r => r.t >= 40 && r.t <= 90), outside = starts.filter(r => r.t < 40 || r.t > 90);
    assert.ok(inside.length > 10 && outside.length > 10);
    for (const r of inside) {
      assert.deepEqual(r.observation.offers, [STUDENT_HALF.text]);
      assert.match(placeOf(r.observation, 'maison_crumb').cost, /with the offer/);
    }
    for (const r of outside) {
      assert.ok(!('offers' in r.observation), r.id);
      assert.equal(placeOf(r.observation, 'maison_crumb').cost, 'about $30');
    }
  });

  test('an observation shows at most 3 offer texts, in world order', () => {
    const offers = ['one', 'two', 'three', 'four'].map(text => ({ text, to: { groups: ['students'] } }));
    const { reqs } = runExternal(withOffers(...offers));
    const r = reqs.find(x => x.archetypeId === 'students');
    assert.equal(OFFERS_MAX, 3);
    assert.deepEqual(r.observation.offers, ['one', 'two', 'three']);
  });

  test('observe: cost words, the cap, and nothing added without offers', () => {
    const ctx = {
      spec: { context: 'A fictional square', clockStart: 600 }, t: 0, person: { name: 'Ana Quill', informed: false },
      moment: { kind: 'choose', why: 'start' },
      places: [
        { id: 'a', name: 'A', price: 15, listPrice: 30, dist: 10, est: 0, visible: true },
        { id: 'b', name: 'B', price: 9.9, listPrice: 10, dist: 10, est: 0, visible: true },
        { id: 'c', name: 'C', price: 0, listPrice: 8, dist: 10, est: 0, visible: true },
        { id: 'd', name: 'D', price: 8, dist: 10, est: 0, visible: true }
      ]
    };
    const plain = visitObservation(ctx);
    assert.deepEqual(plain.places.map(p => p.cost), ['about $15 with the offer (usually about $30)', 'about $10', 'free with the offer (usually about $8)', 'about $8']);
    assert.ok(!('offers' in plain));
    assert.ok(!('offers' in visitObservation({ ...ctx, offers: [] })));
    assert.deepEqual(visitObservation({ ...ctx, offers: ['w', 'x', 'y', 'z'] }).offers, ['w', 'x', 'y']);
    const routeCtx = { spec: {}, t: 0, person: {}, trip: { fromName: 'Avon', toName: 'Bree' }, routes: [{ key: 'r0', label: 'Long Road', ff: 20, now: null }] };
    assert.ok(!('offers' in routeObservation(routeCtx)));
    assert.deepEqual(routeObservation({ ...routeCtx, offers: ['Ferry fares are waived today'] }).offers, ['Ferry fares are waived today']);
  });
});

// ---------- effect and spending ----------

describe('offers: effect under the rules provider, and what people spend', () => {
  test('more students go to the dearer bakery with half price there, on the same seed; parents are unaffected', () => {
    const base = new Sim(BAKERIES, { seed: 7 }).runToEnd();
    const offered = new Sim(withOffers(STUDENT_HALF), { seed: 7 }).runToEnd();
    const before = wentTo(base, 'students', 'maison_crumb'), after = wentTo(offered, 'students', 'maison_crumb');
    assert.ok(after > before * 2 && after - before >= 30, `students at Maison Crumb: ${before} without the offer, ${after} with it`);
    // Same people (common random numbers), and nobody is forced: every student who chose it anyway still does.
    const A = base.agentsSummary(), B = offered.agentsSummary();
    assert.deepEqual(B.map(a => [a.id, a.personaId, a.born]), A.map(a => [a.id, a.personaId, a.born]));
    A.forEach((a, i) => {
      if (a.archetypeId === 'parents') assert.deepEqual(B[i].visits, a.visits);
      else if (a.visits[0] === 'maison_crumb') assert.deepEqual(B[i].visits, ['maison_crumb']);
    });
    assert.ok(B.some(a => a.archetypeId === 'students' && a.visits[0] === 'corner_loaf'), 'the offer does not force anyone');
  });

  test('the rules provider through the decision protocol sees the same effect', async () => {
    const run = async world => {
      const sim = new Sim(world, { seed: 7, external: true }), provider = new RulesProvider({ external: true });
      const drain = async () => {
        const reqs = sim.pending();
        if (!reqs.length) return;
        const ds = await provider.decideMany(reqs);
        reqs.forEach((r, i) => sim.resolve(r.id, ds[i]));
      };
      while (!sim.done) { sim.step(); await drain(); }
      await drain();
      return wentTo(sim, 'students', 'maison_crumb');
    };
    const before = await run(BAKERIES), after = await run(withOffers(STUDENT_HALF));
    assert.ok(after > before * 2, `${before} → ${after}`);
  });

  test('what each agent spends reflects the discount', () => {
    const sim = new Sim(withOffers(STUDENT_HALF), { seed: 7 }).runToEnd();
    const agents = sim.agentsSummary();
    assert.ok(agents.every(a => a.served === 1 && a.visits.length === 1));
    for (const a of agents) {
      const full = PRICE[a.visits[0]];
      const paid = a.archetypeId === 'students' && a.visits[0] === 'maison_crumb' ? full / 2 : full;
      assert.equal(a.spent, paid, `agent ${a.id}`);
    }
    assert.ok(agents.some(a => a.spent === 15) && agents.some(a => a.spent === 30) && agents.some(a => a.spent === 6));
  });

  test('discounts do not stack: the largest matching discount applies', () => {
    const sim = new Sim(withOffers({ ...STUDENT_HALF, priceOff: 0.3 }, { ...STUDENT_HALF, id: 'bigger', priceOff: 0.5 }), { seed: 7 }).runToEnd();
    const paid = sim.agentsSummary().filter(a => a.archetypeId === 'students' && a.visits[0] === 'maison_crumb').map(a => a.spent);
    assert.ok(paid.length > 0);
    assert.ok(paid.every(p => p === 15), JSON.stringify(paid));
  });

  test('people pay the price they were shown when they chose, even if the window closes before they are served', () => {
    const w = withOffers({ ...STUDENT_HALF, until: 20 });
    const sim = new Sim(w, { seed: 7 }).runToEnd();
    const atMaison = sim.agentsSummary().filter(a => a.archetypeId === 'students' && a.visits[0] === 'maison_crumb');
    const early = atMaison.filter(a => a.born <= 20), late = atMaison.filter(a => a.born > 20);
    assert.ok(early.length > 0 && late.length > 0);
    for (const a of early) assert.equal(a.spent, 15, `agent ${a.id} chose at ${a.born}`);
    for (const a of late) assert.equal(a.spent, 30, `agent ${a.id} chose at ${a.born}`);
    // Someone who chose at minute 19.5 is served after minute 20 (a 3-minute walk, then 2 minutes of service).
    assert.ok(early.some(a => a.born > 15));
  });

  test('a line question after the window closed still shows the price the agent was quoted', () => {
    // One slow counter at Maison Crumb, so people who walk there meet a line and are asked whether to join.
    const w = withOffers({ ...STUDENT_HALF, until: 30 });
    Object.assign(w.nodes[2], { servers: 1, serviceTime: 10 });
    const { reqs } = runExternal(w);
    const quoted = new Set(reqs.filter(r => r.why === 'start' && r.archetypeId === 'students' && r.t <= 30).map(r => r.agentId));
    const lines = reqs.filter(r => r.kind === 'line' && r.placeId === 'maison_crumb' && r.t > 30);
    const theirs = lines.filter(r => quoted.has(r.agentId)), others = lines.filter(r => !quoted.has(r.agentId));
    assert.ok(theirs.length > 0 && others.length > 0, `${theirs.length} quoted, ${others.length} not`);
    for (const r of theirs) {
      assert.ok(!('offers' in r.observation), 'the window has closed');
      assert.equal(placeOf(r.observation, 'maison_crumb').cost, 'about $15 with the offer (usually about $30)', r.id);
    }
    for (const r of others) assert.equal(placeOf(r.observation, 'maison_crumb').cost, 'about $30', r.id);
  });
});

// ---------- metrics().offers ----------

describe('metrics().offers', () => {
  test('[] when the world has no offers', () => {
    assert.deepEqual(new Sim(BAKERIES, { seed: 7 }).runToEnd().metrics().offers, []);
  });

  test('reached counts distinct people in the audience at a decision moment; wentToPlace those who then went there', () => {
    const sim = new Sim(withOffers(STUDENT_HALF, { id: 'all', text: 'Fresh bread at noon' }, { id: 'ana_only', text: 'Hi Ana', to: { cast: ['ana'] }, place: 'corner_loaf' }), { seed: 7 }).runToEnd();
    const agents = sim.agentsSummary(), m = sim.metrics();
    const students = agents.filter(a => a.archetypeId === 'students');
    const anas = agents.filter(a => a.personaId === 'ana');
    assert.deepEqual(m.offers, [
      { id: 'student_half', reached: students.length, wentToPlace: students.filter(a => a.visits[0] === 'maison_crumb').length },
      { id: 'all', reached: agents.length, wentToPlace: 0 },
      { id: 'ana_only', reached: anas.length, wentToPlace: anas.filter(a => a.visits[0] === 'corner_loaf').length }
    ]);
    assert.ok(m.offers[0].wentToPlace > 0 && m.offers[2].wentToPlace > 0);
  });

  test('only people who decide inside the window are reached', () => {
    const sim = new Sim(withOffers({ ...STUDENT_HALF, from: 40, until: 90 }), { seed: 7 }).runToEnd();
    // Each agent decides on arrival, on reaching the bakery (a walk of about 3.2 minutes, counted at the next
    // half-minute tick) and after being served (2 minutes later), so someone born up to about 5.7 minutes
    // before the window opens can still be reached.
    const students = sim.agentsSummary().filter(a => a.archetypeId === 'students');
    const sure = students.filter(a => a.born >= 40 && a.born <= 90).length;
    const possible = students.filter(a => a.born >= 40 - 6 && a.born <= 90).length;
    const { reached, wentToPlace } = sim.metrics().offers[0];
    assert.ok(reached >= sure && reached <= possible, `${sure} <= ${reached} <= ${possible}`);
    assert.ok(wentToPlace > 0 && wentToPlace <= reached);
  });

  test('external mode counts the same way', () => {
    const { sim, reqs } = runExternal(withOffers(STUDENT_HALF));
    const sawIt = new Set(reqs.filter(r => r.observation.offers).map(r => r.agentId));
    const { reached, wentToPlace } = sim.metrics().offers[0];
    assert.equal(reached, sawIt.size);
    assert.equal(wentToPlace, sim.agentsSummary().filter(a => sawIt.has(a.id) && a.visits[0] === 'maison_crumb').length);
  });
});

// ---------- the patch op ----------

describe('applyPatch: { kind: "offer" }', () => {
  test('adds an offer and reports it in applied', () => {
    const base = normalizeSpec(BAKERIES);
    const { spec, applied, skipped } = applyPatch(base, [{ kind: 'offer', offer: STUDENT_HALF }]);
    assert.deepEqual(skipped, []);
    assert.deepEqual(applied, ['Offer student_half · 50% off at Maison Crumb · to Students']);
    assert.deepEqual(spec.offers, normalizeSpec(withOffers(STUDENT_HALF)).offers);
    assert.equal(specHash(spec), specHash(normalizeSpec(withOffers(STUDENT_HALF))));
    assert.deepEqual(base.offers, [], 'the input spec is not changed');
  });

  test('labels: message only, a place without discount, a window and several audiences', () => {
    const { applied } = applyPatch(normalizeSpec(BAKERIES), [
      { kind: 'offer', offer: { text: 'Fresh bread at noon' } },
      { kind: 'offer', offer: { text: 'Try the rye', place: 'corner_loaf', to: { groups: ['parents'], cast: ['ana'] }, from: 30, until: 60.5 } }
    ]);
    assert.deepEqual(applied, [
      'Offer offer1 · a message · to everyone',
      'Offer offer2 · about Corner Loaf · to Parents, Ana Quill, minutes 30–60.5'
    ]);
  });

  test('works with field ops; ids stay unique; bad offers are skipped', () => {
    const start = normalizeSpec(withOffers(STUDENT_HALF));
    const bad = [
      { kind: 'offer' },
      { kind: 'offer', offer: 'half price' },
      { kind: 'offer', offer: { text: 'Deal', to: { groups: ['ghosts'] } } },
      { kind: 'offer', offer: { place: 'maison_crumb' } }
    ];
    const { spec, applied, skipped } = applyPatch(start, [
      { kind: 'node', id: 'maison_crumb', field: 'servers', value: 80 },
      { kind: 'offer', offer: { ...STUDENT_HALF, priceOff: 0.2 } },
      ...bad
    ]);
    assert.deepEqual(skipped, bad);
    assert.equal(applied.length, 2);
    assert.deepEqual(spec.offers.map(o => [o.id, o.priceOff]), [['student_half', 0.5], ['student_half_1', 0.2]]);
    assert.equal(spec.nodes.find(n => n.id === 'maison_crumb').servers, 80);
  });

  test('no more than 50 offers', () => {
    const full = normalizeSpec(withOffers(...Array.from({ length: 50 }, (_, i) => ({ text: `Deal ${i}` }))));
    const op = { kind: 'offer', offer: STUDENT_HALF };
    const { spec, applied, skipped } = applyPatch(full, [op]);
    assert.deepEqual(applied, []);
    assert.deepEqual(skipped, [op]);
    assert.equal(spec.offers.length, 50);
  });

  test('PATCH_FIELDS documents the offer op', () => {
    assert.deepEqual(PATCH_FIELDS.offer, ['id', 'text', 'to', 'place', 'priceOff', 'from', 'until']);
    assert.deepEqual(PATCH_FIELDS.node, ['servers', 'serviceTime', 'appeal', 'price', 'weight']);
  });

  test('the patched world shows the effect in the simulator on the same seed', () => {
    const base = normalizeSpec(BAKERIES);
    const { spec } = applyPatch(base, [{ kind: 'offer', offer: STUDENT_HALF }]);
    const before = wentTo(new Sim(base, { seed: 7 }).runToEnd(), 'students', 'maison_crumb');
    const after = wentTo(new Sim(spec, { seed: 7 }).runToEnd(), 'students', 'maison_crumb');
    assert.ok(after > before * 2, `${before} → ${after}`);
  });
});

// ---------- Jev request bodies ----------

// <jev-fixtures>
const JEV_PERSON = { name: 'Ana Quill', age: 20, about: 'Second-year student on a tight budget.', group: 'Students', has_live_wait_app: false };
const JEV_PLACES = [
  { option: 'corner_loaf', name: 'Corner Loaf', known_for: 'Plain loaves, cheap and quick', offers: 'bread', cost: 'about $6', distance: 'a short walk', line: 'no line' },
  { option: 'maison_crumb', name: 'Maison Crumb', known_for: 'Fancy pastries at fancy prices', offers: 'bread', cost: 'about $30', distance: 'a short walk', line: 'short, about 5 min' }
];
const JEV_OPTIONS = [{ key: 'corner_loaf', label: 'Go to Corner Loaf' }, { key: 'maison_crumb', label: 'Go to Maison Crumb' }, { key: 'leave', label: 'Leave and go home' }];
const JEV_REMARKS = [
  { key: 'long_line', label: 'Warn about a long line or wait at Maison Crumb' },
  { key: 'bad_service', label: 'Complain about a bad experience at Maison Crumb' },
  { key: 'good_experience', label: 'Say Maison Crumb was good and quick' }
];
const JEV_BASE = {
  personaId: 'ana', personaName: 'Ana Quill', archetypeId: 'students', agentId: 3, placeId: null, aboutPlace: null, aboutEdge: null, why: null, remarkKinds: null
};
const JEV_SO_FAR = { time_here: 'about 15 minutes', time_in_lines: 'hardly any', places_done: ['Corner Loaf'] };
const JEV_FIXTURES = {
  chooseStart: {
    ...JEV_BASE, id: 'd1', t: 1, clock: '08:01', kind: 'choose', why: 'start', decisionIndex: 0,
    asks: { choice: 'next_place', yesNo: null, frustration: false, tellOthers: false }, options: JEV_OPTIONS,
    observation: { setting: 'Saturday morning on Alder Street.', time: 'around 8:00 am', person: JEV_PERSON, so_far: { time_here: 'just arrived', time_in_lines: 'hardly any' }, now: 'Just arrived. Choosing where to go first.', places: JEV_PLACES },
    auto: { action: 'corner_loaf' }
  },
  chooseNext: {
    ...JEV_BASE, id: 'd9', t: 15, clock: '08:15', kind: 'choose', why: 'next', decisionIndex: 1, aboutPlace: 'corner_loaf',
    asks: { choice: 'next_place', yesNo: null, frustration: true, tellOthers: true }, options: JEV_OPTIONS.slice(1), remarkKinds: JEV_REMARKS,
    observation: { setting: 'Saturday morning on Alder Street.', time: 'around 8:00 am', person: JEV_PERSON, so_far: JEV_SO_FAR, now: 'Just finished at Corner Loaf. Choosing what to do next.', places: JEV_PLACES.slice(1), heard: ['Ben Ortolan (group chat, just now): Maison Crumb was good and quick'] },
    auto: { action: 'maison_crumb' }
  },
  line: {
    ...JEV_BASE, id: 'd12', t: 18, clock: '08:18', kind: 'line', decisionIndex: 2, placeId: 'maison_crumb', aboutPlace: 'maison_crumb',
    asks: { choice: 'next_place', yesNo: 'join', frustration: true, tellOthers: true }, options: [{ key: 'leave', label: 'Leave and go home' }], remarkKinds: JEV_REMARKS,
    observation: { setting: 'Saturday morning on Alder Street.', time: 'around 8:00 am', person: JEV_PERSON, so_far: JEV_SO_FAR, now: 'Just reached Maison Crumb. The line is moderate, about 15 min: about the most they will put up with.', places: JEV_PLACES.slice(1) },
    auto: { action: 'yes' }
  },
  long: {
    ...JEV_BASE, id: 'd20', t: 40, clock: '08:40', kind: 'long', decisionIndex: 3, placeId: 'maison_crumb', aboutPlace: 'maison_crumb',
    asks: { choice: 'next_place', yesNo: 'keep_waiting', frustration: true, tellOthers: true }, options: [{ key: 'leave', label: 'Leave and go home' }], remarkKinds: JEV_REMARKS,
    observation: { setting: 'Saturday morning on Alder Street.', time: 'around 8:30 am', person: JEV_PERSON, feeling: 'frustrated', so_far: JEV_SO_FAR, now: 'Has waited about 20 minutes in line at Maison Crumb. About 10 more minutes expected: about the most they will put up with.', places: JEV_PLACES.slice(1) },
    auto: { action: 'leave' }
  },
  route: {
    ...JEV_BASE, id: 'd2', t: 2, clock: '08:02', kind: 'route', decisionIndex: 0,
    asks: { choice: 'route', yesNo: null, frustration: false, tellOthers: false },
    options: [{ key: 'r0', label: 'Take the route via Long Road' }, { key: 'r1', label: 'Take the route via Ferry Lane' }],
    observation: { setting: 'Weekday morning in Avon.', time: 'around 8:00 am', person: { name: 'Ana Quill', group: 'Students', has_live_traffic: false }, trip: 'Avon to Bree', routes: [{ option: 'r0', via: 'Long Road', usual_time: 'about 20 minutes', right_now: 'unknown (no live traffic)' }, { option: 'r1', via: 'Ferry Lane', usual_time: 'about 25 minutes', right_now: 'unknown (no live traffic)' }] },
    auto: { action: 'r0' }
  }
};
// </jev-fixtures>

// sha256 of the exact request body for each fixture, computed with the request builder as it was before
// offers existed (git HEAD before this change). Recorded runs replay by these hashes.
const HASH_BEFORE_OFFERS = {
  chooseStart: '2b7664dd766131d1cffa227bd66cc627a8851d970e5a7bb3748b5ea908814f0e',
  chooseNext: '0105e4b8e133aa1e0bf42839f9dd409ecd4173a13cf557642905e857704a8da3',
  line: '2d359b5e6abe9b758777aa201a2b6d815785ceebf639641461901308ce70bb74',
  long: '5645b8c583a91a86591d5cf4641c53b24cb21c77f8baf990304621374329b84a',
  route: '797b1b1e4ed11fbfd04e4cbbd70b34e0c35f267e6c4e76f67e8be750aa0a31a5'
};

describe('Jev request bodies', () => {
  test('without offers, bodies are byte-identical to before offers existed', () => {
    for (const [name, req] of Object.entries(JEV_FIXTURES)) {
      assert.equal(buildJevRequest(req).requestHash, HASH_BEFORE_OFFERS[name], name);
    }
    const q = name => buildJevRequest(JEV_FIXTURES[name]).body.questions;
    assert.equal(q('chooseStart').next_place.instructions, 'Where does the person in `person` go next, given `now` and `places`?');
    assert.equal(q('chooseNext').next_place.instructions, 'Where does the person in `person` go next, given `now`, `places` and `heard`?');
    assert.equal(q('line').join.instructions, 'Does the person in `person` join the line described in `now`?');
    assert.equal(q('long').keep_waiting.instructions, 'Does the person in `person` keep waiting in the line described in `now`?');
    assert.equal(q('route').route.instructions, 'Which route in `routes` does the person in `person` take for `trip`?');
  });

  test('with offers, the questions about where to go name `offers`, and the state carries them', () => {
    const offered = name => {
      const req = copy(JEV_FIXTURES[name]);
      req.observation.offers = ['Student deal: half price at Maison Crumb this morning'];
      return buildJevRequest(req).body;
    };
    assert.equal(offered('chooseStart').questions.next_place.instructions, 'Where does the person in `person` go next, given `now`, `places` and `offers`?');
    assert.equal(offered('chooseNext').questions.next_place.instructions, 'Where does the person in `person` go next, given `now`, `places`, `heard` and `offers`?');
    assert.equal(offered('line').questions.join.instructions, 'Does the person in `person` join the line described in `now`, given `offers`?');
    assert.equal(offered('long').questions.keep_waiting.instructions, 'Does the person in `person` keep waiting in the line described in `now`, given `offers`?');
    assert.equal(offered('route').questions.route.instructions, 'Which route in `routes` does the person in `person` take for `trip`, given `offers`?');
    // Feelings and remarks are about the experience, not the offer.
    const next = offered('chooseNext');
    assert.equal(next.questions.frustration.instructions, 'How frustrated is the person in `person` right now, given `so_far` and `now`?');
    assert.doesNotMatch(next.questions.tell_others.instructions, /offers/);
    assert.deepEqual(next.state.offers, ['Student deal: half price at Maison Crumb this morning']);
  });

  test('a simulated request without offers builds the same body as the same request from a world with an empty offers list', () => {
    const a = runExternal(BAKERIES).reqs.slice(0, 40), b = runExternal({ ...copy(BAKERIES), offers: [] }).reqs.slice(0, 40);
    assert.deepEqual(b.map(r => buildJevRequest(r).requestHash), a.map(r => buildJevRequest(r).requestHash));
    assert.ok(a.every(r => !('offers' in r.observation)));
  });
});
