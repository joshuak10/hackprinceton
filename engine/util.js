// Shared helpers: seeded randomness, hashing, value coercion, and the "words" helpers that
// turn numbers into the semantic descriptions Jev reads well (see docs/PROTOTYPE.md §3 and §5).
import { createHash } from 'node:crypto';

// ---------- randomness ----------
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a 32-bit over parts joined with '|'.
export function hash32(...parts) {
  const s = parts.map(p => String(p)).join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function seedRng(...parts) { return mulberry32(hash32(...parts)); }

export function sha256Hex(s) { return createHash('sha256').update(String(s)).digest('hex'); }

// Sample an index from non-negative weights with a uniform u in [0,1). Returns -1 if all weights are 0.
export function sampleIndex(weights, u) {
  let tot = 0;
  for (const w of weights) tot += w > 0 ? w : 0;
  if (!(tot > 0)) return -1;
  let r = u * tot;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i] > 0 ? weights[i] : 0;
    if (w <= 0) continue;
    r -= w;
    if (r < 0) return i;
  }
  for (let i = weights.length - 1; i >= 0; i--) if (weights[i] > 0) return i;
  return -1;
}

// Deterministic Fisher-Yates shuffle (returns a new array).
export function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- coercion (same behavior as the prototype) ----------
export function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
export function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
export function str(v, n) { return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n); }
export function strArr(v) { return Array.isArray(v) ? v.map(x => String(x).toLowerCase().trim()).filter(Boolean).slice(0, 12) : []; }
export function truthy(v) { return v === true || v === 1 || String(v).toLowerCase() === 'true' || String(v).toLowerCase() === 'yes'; }
export function slug(v, i) {
  const s = String(v ?? '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return s || ('n' + i);
}
export function clockText(spec, t) {
  const m = Math.floor(((spec.clockStart + t) % 1440 + 1440) % 1440);
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

// ---------- words (numbers → semantic descriptions) ----------
const round5 = x => Math.max(5, Math.round(x / 5) * 5);

export function waitWords(min) {
  const m = Math.max(0, Number(min) || 0);
  if (m < 1) return 'no line';
  const n = m >= 10 ? round5(m) : Math.max(1, Math.round(m));
  if (m < 10) return `short, about ${n} min`;
  if (m < 25) return `moderate, about ${n} min`;
  if (m < 50) return `long, about ${n} min`;
  return `very long, about ${n} min`;
}

export function patienceWords(est, tolerance) {
  const tol = Math.max(0.0001, Number(tolerance) || 0);
  const e = Math.max(0, Number(est) || 0);
  if (e < 0.6 * tol) return 'well within what they will put up with';
  if (e < 1.1 * tol) return 'about the most they will put up with';
  return 'more than they will put up with';
}

export function durationWords(min) {
  const m = Math.max(0, Number(min) || 0);
  if (m < 2) return 'just arrived';
  if (m < 90) return `about ${round5(m)} minutes`;
  const h = Math.round((m / 60) * 2) / 2;
  return `about ${h % 1 === 0 ? h.toFixed(0) : h.toFixed(1)} hours`;
}

export function distanceWords(d) {
  const x = Math.max(0, Number(d) || 0);
  if (x < 3) return 'right here';
  if (x < 15) return 'close';
  if (x < 35) return 'a short walk';
  return 'far';
}

export function priceWords(p) {
  const x = Number(p) || 0;
  return x <= 0 ? 'free' : `about $${Math.round(x)}`;
}

export function timeWords(spec, t) {
  const m = Math.floor(((spec.clockStart + t) % 1440 + 1440) % 1440);
  const h24 = Math.floor(m / 60), mm = m % 60 < 30 ? '00' : '30';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `around ${h12}:${mm} ${h24 < 12 ? 'am' : 'pm'}`;
}

export const FEELINGS = ['calm', 'mildly annoyed', 'frustrated', 'very frustrated', 'furious'];
export function feelingWords(expected) {
  if (expected == null || !Number.isFinite(Number(expected))) return undefined;
  return FEELINGS[clamp(Math.round(Number(expected)), 0, FEELINGS.length - 1)];
}
