// The morning question (docs/PROTOTYPE.md §20): before a day starts, does this person go to the shop today?
//
// A multi-day run (REPEAT_CUSTOMERS_SPEC.md) keeps one record per person between days and asks this once per
// person per day. This module turns a world, a shop, a cast member and that person's record into the
// DecisionRequest. The words come from engine/observe.js, so the return probe (validation/jev-return-probe.js)
// and the loop send Jev exactly the same thing.
import { morningObservation, remarkText } from '../engine/observe.js';

const services = spec => spec.nodes.filter(n => n.kind === 'service');

// The shop being asked about and the world's other service places.
// `shopId` is a place id, or { places: [ids], name, about, seated } for one business made of several places
// (a restaurant's counter and its table): then `shop` stands for all of them, under one name and one price
// (their average), and `shop.ids` lists them.
export function shopView(spec, shopId = null) {
  const places = services(spec);
  if (!places.length) throw new Error('The morning question needs a world with at least one service place.');
  if (shopId && typeof shopId === 'object') {
    const ids = Array.isArray(shopId.places) ? shopId.places.map(String) : [];
    const mine = ids.map(id => places.find(n => n.id === id));
    if (!mine.length || mine.some(n => !n)) throw new Error(`No service places "${ids.join(', ')}" in this world.`);
    const price = Math.round(mine.reduce((s, n) => s + n.price, 0) / mine.length * 100) / 100;
    const shop = {
      id: mine[0].id, ids: mine.map(n => n.id), name: shopId.name || mine[0].name, about: shopId.about ?? mine[0].about,
      tags: [...new Set(mine.flatMap(n => n.tags || []))], price, servers: mine[0].servers, seated: shopId.seated === true
    };
    return { shop, others: places.filter(n => !shop.ids.includes(n.id)) };
  }
  const found = places.find(n => n.id === shopId) || (shopId == null ? places[0] : null);
  if (!found) throw new Error(`No service place "${shopId}" in this world.`);
  return { shop: { ...found, ids: [found.id], seated: false }, others: places.filter(n => n !== found) };
}

// "A friend (yesterday): long line at Alder & Pine Coffee". `kind` is a visit remark kind (long_line,
// bad_service, good_experience); any other string is used as the remark itself.
export function friendRemark(kind, shopName, { who = 'A friend', when = 'yesterday' } = {}) {
  const known = ['long_line', 'bad_service', 'good_experience'].includes(kind);
  const text = known ? remarkText({ kind, placeId: 'shop' }, { place: { shop: shopName } }) : String(kind);
  return `${who} (${when}): ${text}`;
}

// One person's record between days, all optional:
//   history  { visits, weeks, via }           how well they know the shop
//   memory   [{ daysAgo, wait, outcome, ending, paid, promo, first } | { daysAgo, text }]   newest first
//   card     { have, need, free, reward }     stamp-card progress
//   heard    [string]                         remarks from people they listen to
//   offers   [string]                         messages from the shop today
//   price, wasPrice, offerPrice, rating       today's price (default: the world's), what they paid last week,
//                                             today's price with an offer, the shop's star rating
// `spec` is a normalized world (normalizeSpec); `mind` is one of its cast members.
export function morningRequest({ spec, shopId = null, mind, state = {}, t = 0, id = null }) {
  if (spec?.mode !== 'visit') throw new Error('The morning question needs a normalized visit world.');
  if (!mind) throw new Error('The morning question needs a cast member.');
  const { shop, others } = shopView(spec, shopId);
  const group = spec.archetypes.find(a => a.id === mind.archetype);
  const s = state || {};
  const observation = morningObservation({
    spec, t,
    person: { name: mind.name, age: mind.age, bio: mind.bio, personality: mind.personality, goal: mind.goal, social: mind.social, groupName: group?.name },
    shop: {
      name: shop.name, about: shop.about, tags: shop.tags,
      price: s.price ?? shop.price, wasPrice: s.wasPrice, offerPrice: s.offerPrice, rating: s.rating
    },
    others: others.map(n => ({ name: n.name, about: n.about, price: n.price })),
    history: s.history, memory: s.memory, card: s.card, heard: s.heard, offers: s.offers, seated: shop.seated
  });
  return {
    id: id ?? `morning-${mind.id}`, kind: 'morning', why: null, t, agentId: 0, personaId: mind.id,
    placeId: shop.id, aboutPlace: shop.id, remarkKinds: null, options: [],
    asks: { yesNo: 'visit_today', choice: null, frustration: false, tellOthers: false },
    observation,
    // The rule answer: go. A rules run has no memory to read, so it cannot say no.
    auto: { action: 'yes' }
  };
}
