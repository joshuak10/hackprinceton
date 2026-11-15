#!/usr/bin/env node
// Jev line probe: do simulated customers decide to join a line the way real customers were measured to?
//
// Lu, Musalem, Olivares & Schilkrut, "Measuring the Effect of Queues on Customer Purchases" (Management Science
// 59(8), 2013) studied a supermarket deli for seven months and found that purchases depend on the number of people
// in line, not on how many staff are serving (the line's speed), and that the effect is non-linear: flat for short
// lines, falling faster above about 7 people.
//
// This script asks Jev the question the simulation asks when a person reaches a counter ("does this person join the
// line?"), varying only the number of people ahead (0 to 15) and the staff serving (1 to 3), for 8 people from the
// real building's cast. It records Jev's probability of joining. Each version is built by the engine's own
// observation code (engine/observe.js) with a different world setting:
//   wait       the default (waiting.lineShows "wait"): the head count, a wait estimate in words (which depends on
//              the staff), and the engine's verdict on the person's patience. Before Nov 14 the building used this.
//   person     the same, without the patience verdict (waiting.tellPatience: false), so Jev judges from the person
//   people     waiting.lineShows "people": only what a customer can see, the head count and the staff serving, no
//              wait estimate. The building uses this since Nov 14 (docs/PROTOTYPE.md §16b).
//
// Usage: node validation/jev-line-probe.js [--out data/validation/jev-line-probe.json] [--personas 8]
// Needs JEV_API_KEY or TYPESAFE_API_KEY in .env.local. About 1,150 Jev requests (a few cents at TypeSafe's
// published price, unverified).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../engine/env.js';
import { visitObservation } from '../engine/observe.js';
import { JevProvider } from '../providers/jev.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const AHEAD = Array.from({ length: 16 }, (_, i) => i);
export const STAFF = [1, 2, 3];
export const VARIANTS = ['wait', 'person', 'people'];
export const CAST = ['dana', 'marcus', 'rosa', 'james', 'aisha', 'gloria', 'dev', 'andre'];
const COUNTER = 'coffee';
const ALTERNATIVE = 'bakery';
const T = 30;                 // minutes after the world's start: noon

// The engine's wait estimate for a full counter (engine/sim.js estWait): nobody waits when nobody is ahead.
export const estWait = (ahead, staff, serviceTime) => (ahead > 0 ? ((ahead + 1) * serviceTime) / staff : 0);

export function buildRequest({ fitout, mind, ahead, staff, variant }) {
  const arch = fitout.archetypes.find(a => a.id === mind.archetype);
  const counter = fitout.places.find(p => p.id === COUNTER);
  const alt = fitout.places.find(p => p.id === ALTERNATIVE);
  const est = estWait(ahead, staff, counter.serviceTime);
  const waiting = { wait: undefined, person: { tellPatience: false }, people: { lineShows: 'people' } }[variant];
  const spec = { title: fitout.title, context: fitout.context, clockStart: fitout.clockStart, ...(waiting ? { waiting } : {}) };
  const obs = visitObservation({
    spec, t: T, frustration: 0, timeHere: 2, timeInLines: 0, placesDone: [],
    person: { name: mind.name, age: mind.age, bio: mind.bio, personality: mind.personality, goal: mind.goal, social: mind.social, groupName: arch.name, informed: false },
    moment: { kind: 'line', placeName: counter.name, est, tolerance: arch.patience, ahead, staff },
    places: [
      { id: counter.id, name: counter.name, about: counter.about, tags: counter.tags, price: counter.price, dist: 2, est, visible: true, ahead, staff, walkedAway30: 0 },
      { id: alt.id, name: alt.name, about: alt.about, tags: alt.tags, price: alt.price, dist: 25, est: 0, visible: false, ahead: null, staff: alt.servers, walkedAway30: 0 }
    ],
    offers: [], heard: []
  });
  return {
    id: `${variant}-${mind.id}-a${ahead}-s${staff}`, kind: 'line', t: T,
    asks: { choice: 'next_place', yesNo: 'join', frustration: false, tellOthers: false },
    options: [{ key: alt.id, label: `Go to ${alt.name}` }, { key: 'leave', label: fitout.leaveLabel || 'Leave and go home' }],
    observation: obs, auto: { action: 'yes' }, meta: { variant, mind: mind.id, ahead, staff, est }
  };
}

const mean = xs => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);

export function summarize(rows) {
  const out = {};
  for (const v of VARIANTS) {
    const r = rows.filter(x => x.variant === v && x.yesProb != null);
    const curve = {};
    for (const s of STAFF) curve[s] = AHEAD.map(a => mean(r.filter(x => x.staff === s && x.ahead === a).map(x => x.yesProb)));
    // Same wait, different line lengths (serviceTime 2): est 6 min = 2 ahead with 1 staff, 5 with 2, 8 with 3;
    // est 8 min = 3/1, 7/2, 11/3; est 12 min = 5/1, 11/2 (and 17/3, out of range).
    const sameWait = [[[2, 1], [5, 2], [8, 3]], [[3, 1], [7, 2], [11, 3]], [[5, 1], [11, 2]]].map(group => group.map(([a, s]) => ({
      ahead: a, staff: s, est: estWait(a, s, 2), join: mean(r.filter(x => x.ahead === a && x.staff === s).map(x => x.yesProb))
    })));
    // Same line length, more staff: how much does the join probability move?
    const staffEffect = AHEAD.filter(a => a > 0).map(a => curve[3][a] - curve[1][a]);
    const lengthEffect = STAFF.map(s => curve[s][0] - curve[s][15]);
    const perPerson = Object.fromEntries(CAST.map(id => [id, AHEAD.map(a => mean(r.filter(x => x.mind === id && x.staff === 2 && x.ahead === a).map(x => x.yesProb)))]));
    out[v] = { curve, sameWait, avgStaffEffect: mean(staffEffect), lengthEffect, perPerson };
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
  const out = resolve(ROOT, flag('out', 'data/validation/jev-line-probe.json'));
  const nPersonas = Math.max(1, Math.min(CAST.length, Number(flag('personas', CAST.length))));
  loadEnv({ cwd: ROOT });
  const apiKey = process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY;
  if (!apiKey) { console.error('No Jev key: set JEV_API_KEY or TYPESAFE_API_KEY in .env.local.'); process.exit(1); }
  const fitout = JSON.parse(readFileSync(resolve(ROOT, 'buildings/6FNMVoyPrL1/fitout-floor1-lunch.json'), 'utf8'));
  const minds = CAST.slice(0, nPersonas).map(id => fitout.minds.find(m => m.id === id));
  const reqs = [];
  for (const variant of VARIANTS) for (const mind of minds) for (const staff of STAFF) for (const ahead of AHEAD) reqs.push(buildRequest({ fitout, mind, ahead, staff, variant }));
  const jev = new JevProvider({ apiKey, maxRequests: reqs.length + 50, concurrency: 24 });
  console.log(`Asking Jev ${reqs.length} questions (${VARIANTS.length} versions x ${minds.length} people x ${STAFF.length} staff levels x ${AHEAD.length} line lengths)...`);
  const t0 = Date.now();
  const decisions = await jev.decideMany(reqs, { spec: { title: fitout.title } });
  const rows = reqs.map((q, i) => ({ ...q.meta, yesProb: decisions[i].provider === 'jev' || decisions[i].provider === 'jev-cache' ? decisions[i].yesProb : null, provider: decisions[i].provider }));
  const stats = jev.stats();
  const result = { createdAt: new Date().toISOString(), seconds: (Date.now() - t0) / 1000, counter: COUNTER, cast: minds.map(m => m.id), stats, summary: summarize(rows), rows };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 1));
  console.log(`Done in ${result.seconds.toFixed(0)} s. Requests ${stats.requests}, fallbacks ${stats.fallbacks}, errors ${stats.errors}, model ${stats.model}, about $${stats.estCostUSD.toFixed(3)}. Wrote ${out}`);
  for (const v of VARIANTS) {
    const s = result.summary[v];
    console.log(`\n${v}: join probability by people ahead (0..15)`);
    for (const st of STAFF) console.log(`  ${st} staff: ${s.curve[st].map(p => p.toFixed(2)).join(' ')}`);
    console.log(`  same wait, longer line: ${s.sameWait.map(g => g.map(x => `${x.ahead}/${x.staff}=${x.join.toFixed(2)}`).join(' ')).join(' | ')}`);
    console.log(`  average change from 1 to 3 staff at the same line length: ${s.avgStaffEffect >= 0 ? '+' : ''}${s.avgStaffEffect.toFixed(3)}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(err => { console.error(err.message); process.exit(1); });
