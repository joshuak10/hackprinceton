// sampleDecision: turns a provider's Decision (probabilities from Jev, or a fixed action from the
// rules providers) into one sampled outcome. Pure: everything random comes from `rng`.
// See docs/PROTOTYPE.md §4 "Sampling".
//
// Draw order is fixed: yes/no (u1), choice (u2), tell (u3), remark kind (u4). All four values are
// always drawn, even when a step is unused, so one step never shifts the draws of another.
import { sampleIndex } from './util.js';

const ROUTE_KINDS = new Set(['route', 'arrive']);

// A probability in [0, 1], or null when the value is missing or not a number.
function prob(p) {
  if (p == null) return null;
  const x = Number(p);
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : null;
}

// Sample a key from `probs` restricted to `validKeys` (in that order, so the result never depends on
// the provider's key order), renormalizing over what is left. With validKeys null, every key in
// probs counts. Returns null when no key has positive weight.
function sampleKey(probs, validKeys, u) {
  if (!probs || typeof probs !== 'object') return null;
  const keys = validKeys ? validKeys.filter(k => Object.hasOwn(probs, k)) : Object.keys(probs);
  const weights = keys.map(k => {
    const w = Number(probs[k]);
    return Number.isFinite(w) && w > 0 ? w : 0;
  });
  const i = sampleIndex(weights, u);
  return i < 0 ? null : keys[i];
}

// The remark an agent makes when the provider said "tell" but gave no usable remark distribution:
// route: heavy_traffic; visit: long_line if the agent waited in or walked away from a line,
// otherwise good_experience. `req.waited` (minutes waited at aboutPlace) is optional; line and
// long moments, balking and giving up count as waiting without it.
function defaultRemarkKind(req, validKeys) {
  let kind;
  if (ROUTE_KINDS.has(req.kind)) kind = 'heavy_traffic';
  else {
    const waited = req.kind === 'line' || req.kind === 'long' || req.why === 'balked' ||
      req.why === 'gaveup' || Number(req.waited) >= 1;
    kind = waited ? 'long_line' : 'good_experience';
  }
  if (validKeys && validKeys.length && !validKeys.includes(kind)) return validKeys[0];
  return kind;
}

export function sampleDecision(req, decision, rng) {
  const r = req || {};
  const d = decision || {};
  const asks = r.asks || {};
  const u1 = rng(), u2 = rng(), u3 = rng(), u4 = rng();

  const action = typeof d.action === 'string' && d.action !== '' ? d.action : undefined;
  const autoAction = r.auto?.action ?? undefined;

  // 1. yes/no
  let yes = null;
  if (asks.yesNo) {
    if (action !== undefined) yes = action === 'yes';
    else {
      const p = prob(d.yesProb);
      yes = p != null ? u1 < p : autoAction === 'yes';
    }
  }

  // 2. choice: the primary choice, or the speculative next_place after a "no"
  let chosen = null;
  if (asks.choice && yes !== true) {
    const keys = (Array.isArray(r.options) ? r.options : []).map(o => String(o?.key ?? '')).filter(Boolean);
    if (action !== undefined && keys.includes(action)) chosen = action;
    else {
      chosen = sampleKey(d.choiceProbs, keys, u2);
      if (chosen == null && autoAction !== undefined && keys.includes(autoAction)) chosen = autoAction;
    }
  }

  // 3. tell others
  const tellP = prob(d.tellProb);
  const tell = tellP != null && u3 < tellP;

  // 4. remark kind
  let remarkKind = null;
  if (tell) {
    const validKeys = Array.isArray(r.remarkKinds) && r.remarkKinds.length
      ? r.remarkKinds.map(k => String(k?.key ?? '')).filter(Boolean)
      : null;
    remarkKind = sampleKey(d.remarkProbs, validKeys, u4) ?? defaultRemarkKind(r, validKeys);
  }

  const expected = d.frustration?.expected == null ? NaN : Number(d.frustration.expected);
  const frustration = Number.isFinite(expected) ? Math.min(4, Math.max(0, expected)) : null;

  return { yes, action: chosen, tell, remarkKind, frustration };
}
