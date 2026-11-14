// Shared pieces for the mock run generators. Mock runs use the same RunBundle shape as recorded Jev runs
// (docs/PROTOTYPE.md §7 and §9b), with decisions marked provider 'mock' so nobody mistakes them for Jev output.
import { seedRng, clamp, clockText, feelingWords, waitWords, durationWords, timeWords, FEELINGS } from '../engine/util.js';

export { seedRng, clamp, clockText, feelingWords, waitWords, durationWords, timeWords };

export const sigmoid = x => 1 / (1 + Math.exp(-x));

export function normal(rng) {
  const u = Math.max(1e-9, rng()), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Arrival times (minutes) from a mix of Gaussian peaks plus a flat base, clipped to [start, end].
export function arrivalTimes(rng, n, { start, end, peaks = [], base = 0.2 }) {
  const out = [];
  const totalW = base + peaks.reduce((a, p) => a + p.w, 0);
  for (let i = 0; i < n; i++) {
    let t;
    for (let guard = 0; guard < 50; guard++) {
      let r = rng() * totalW;
      if (r < base) t = start + rng() * (end - start);
      else {
        r -= base;
        const p = peaks.find(pk => (r -= pk.w) < 0) || peaks[peaks.length - 1];
        t = p.t + normal(rng) * p.sd;
      }
      if (t >= start && t <= end) break;
    }
    out.push(clamp(t, start, end));
  }
  return out.sort((a, b) => a - b);
}

export function pick(rng, arr) { return arr[Math.floor(rng() * arr.length) % arr.length]; }

export function pickWeighted(rng, items, weight) {
  const ws = items.map(weight);
  const tot = ws.reduce((a, b) => a + b, 0);
  let r = rng() * tot;
  for (let i = 0; i < items.length; i++) if ((r -= ws[i]) < 0) return items[i];
  return items[items.length - 1];
}

export function normalize(probs) {
  const tot = Object.values(probs).reduce((a, b) => a + Math.max(0, b), 0) || 1;
  const out = {};
  for (const [k, v] of Object.entries(probs)) out[k] = Math.max(0, v) / tot;
  return out;
}

export function sampleKey(probs, u) {
  let r = u;
  const keys = Object.keys(probs);
  for (const k of keys) if ((r -= probs[k]) < 0) return k;
  return keys[keys.length - 1];
}

// Jitter weights the way a model's answers vary between similar people.
export function noisyProbs(rng, weights, spread = 0.35) {
  const out = {};
  for (const [k, w] of Object.entries(weights)) out[k] = Math.max(0.001, w * Math.exp(normal(rng) * spread));
  return normalize(out);
}

export function frustrationAnswer(rng, expected) {
  const e = clamp(expected, 0, 4);
  const probs = {};
  let tot = 0;
  for (let k = 0; k <= 4; k++) { probs[k] = Math.exp(-((k - e) ** 2) / 0.8); tot += probs[k]; }
  for (let k = 0; k <= 4; k++) probs[k] = +(probs[k] / tot).toFixed(3);
  const mean = Object.entries(probs).reduce((a, [k, p]) => a + k * p, 0);
  return { expected: +mean.toFixed(2), probs };
}

export const REMARK_TEXT = {
  long_line: name => `Warn about a long line or wait at ${name}`,
  bad_service: name => `Warn about a bad experience at ${name}`,
  good_experience: name => `Say ${name} was good and quick`
};

// Collects decisions and remarks in the recorder's shapes.
export class DecisionLog {
  constructor({ seed, spec }) {
    this.seed = seed;
    this.spec = spec;
    this.decisions = [];
    this.remarks = [];
    this.seq = 0;
  }

  // `agent` needs: id, personaId, persona (cast entry), archetypeId, informed, decisionIndex.
  record({ t, agent, kind, why = null, placeId = null, aboutPlace = null, options = null, asks, now, places = [], heard = [], auto, decision, applied }) {
    const id = 'd' + (++this.seq);
    const p = agent.persona;
    const observation = {
      setting: this.spec.context || this.spec.title,
      time: timeWords(this.spec, t),
      person: { name: p.name, age: p.age, about: p.about, wants: p.wants, listens_to: p.listens_to, group: agent.groupName, has_live_wait_app: agent.informed },
      ...(agent.frustration != null ? { feeling: feelingWords(agent.frustration) } : {}),
      so_far: { time_here: durationWords(t - agent.born), time_in_lines: durationWords(agent.waitTotal), places_done: agent.placesDone.slice(-3) },
      now,
      places,
      heard
    };
    const rec = {
      id, t: +t.toFixed(3), clock: clockText(this.spec, t), agentId: agent.id, personaId: agent.personaId, kind, why, placeId, aboutPlace,
      options, asks, observation, auto,
      decision: { provider: 'mock', model: 'mock-1', ...decision },
      applied: { id, agentId: agent.id, kind, provider: 'mock', ...applied }
    };
    this.decisions.push(rec);
    agent.decisionIndex++;
    return rec;
  }

  remark({ t, agent, kind, placeId }) {
    this.remarks.push({ t: +t.toFixed(3), agentId: agent.id, personName: agent.persona.name, personaName: agent.persona.name, archetypeId: agent.archetypeId, kind, placeId, edgeId: null, informed: agent.informed });
  }

  heardBy(agent, t, nameOf) {
    return this.remarks
      .filter(r => r.agentId !== agent.id && t - r.t <= 30 && t >= r.t && (r.archetypeId === agent.archetypeId || agent.informed))
      .slice(-4).reverse()
      .map(r => `${r.personName} (${r.archetypeId === agent.archetypeId ? 'group chat' : 'app reviews'}, ${durationWords(t - r.t).replace('just arrived', 'just now')} ago): ${r.kind === 'long_line' ? 'long line at' : r.kind === 'bad_service' ? 'bad experience at' : 'good and quick at'} ${nameOf(r.placeId)}`);
  }
}

export function agentSummary(a) {
  return {
    id: a.id, personaId: a.personaId, personaName: a.persona.name, archetypeId: a.archetypeId, informed: a.informed,
    served: a.servedCount, waitTotal: +a.waitTotal.toFixed(2), abandons: a.abandons, frustration: a.frustration,
    born: +a.born.toFixed(3), done: a.doneAt != null ? +a.doneAt.toFixed(3) : null,
    trace: a.trace.slice(-60)
  };
}

export { FEELINGS };
