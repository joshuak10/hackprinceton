// Tests for engine/util.js: seeded randomness, coercion, and the "words" helpers.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mulberry32, hash32, seedRng, sha256Hex, sampleIndex, shuffled,
  clamp, num, str, strArr, truthy, slug, clockText,
  waitWords, patienceWords, durationWords, distanceWords, priceWords, timeWords,
  feelingWords, FEELINGS
} from '../engine/util.js';

const draw = (rng, n) => Array.from({ length: n }, () => rng());

describe('randomness', () => {
  test('mulberry32 is deterministic and within [0,1)', () => {
    const a = draw(mulberry32(42), 200), b = draw(mulberry32(42), 200);
    assert.deepEqual(a, b);
    assert.ok(a.every(x => x >= 0 && x < 1));
    assert.notDeepEqual(a, draw(mulberry32(43), 200));
  });

  test('mulberry32 is roughly uniform', () => {
    const xs = draw(mulberry32(7), 20000);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    assert.ok(Math.abs(mean - 0.5) < 0.02, `mean ${mean}`);
  });

  test('hash32 is stable on known FNV-1a inputs', () => {
    assert.equal(hash32(''), 0x811c9dc5);
    assert.equal(hash32('a'), 0xe40c292c);
    assert.equal(hash32('foobar'), 0xbf9cf968);
  });

  test('hash32 joins parts with | and stringifies them', () => {
    assert.equal(hash32('a', 'b'), hash32('a|b'));
    assert.equal(hash32(1, 2), hash32('1|2'));
    assert.notEqual(hash32('ab', 'c'), hash32('a', 'bc'));
    assert.ok(Number.isInteger(hash32('x')) && hash32('x') >= 0 && hash32('x') < 2 ** 32);
  });

  test('seedRng is reproducible and streams are independent', () => {
    assert.deepEqual(draw(seedRng('run', 1, 'arrivals'), 50), draw(seedRng('run', 1, 'arrivals'), 50));
    const a = seedRng('run', 1, 'arrivals'), b = seedRng('run', 1, 'choices');
    const da = draw(a, 50), db = draw(b, 50);
    assert.notDeepEqual(da, db);
    // Consuming one stream does not shift another.
    const c = seedRng('run', 1, 'choices');
    draw(a, 100);
    assert.deepEqual(draw(c, 50), db);
  });

  test('sha256Hex matches known digests', () => {
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(sha256Hex(123), sha256Hex('123'));
  });
});

describe('sampleIndex', () => {
  test('returns -1 when no weight is positive', () => {
    assert.equal(sampleIndex([], 0.5), -1);
    assert.equal(sampleIndex([0, 0, 0], 0.5), -1);
    assert.equal(sampleIndex([-1, -5, 0], 0.5), -1);
  });

  test('ignores zero and negative weights', () => {
    for (const u of [0, 0.25, 0.5, 0.99]) assert.equal(sampleIndex([0, 3, -2, 0], u), 1);
    for (let i = 0; i < 100; i++) assert.equal(sampleIndex([-10, 0, 1], i / 100), 2);
  });

  test('edge u values', () => {
    const w = [1, 1, 2];
    assert.equal(sampleIndex(w, 0), 0);
    assert.equal(sampleIndex(w, 0.2499), 0);
    assert.equal(sampleIndex(w, 0.25), 1);
    assert.equal(sampleIndex(w, 0.4999), 1);
    assert.equal(sampleIndex(w, 0.5), 2);
    assert.equal(sampleIndex(w, 0.999999), 2);
    // u at or past 1 falls back to the last positive weight.
    assert.equal(sampleIndex(w, 1), 2);
    assert.equal(sampleIndex([1, 2, 0], 1), 1);
    assert.equal(sampleIndex([5], 0.7), 0);
  });

  test('distribution matches the weights over many seeded draws', () => {
    const w = [1, 0, 3, 6], rng = seedRng('sample-dist');
    const counts = [0, 0, 0, 0], N = 50000;
    for (let i = 0; i < N; i++) counts[sampleIndex(w, rng())]++;
    assert.equal(counts[1], 0);
    const tot = 10;
    w.forEach((wi, i) => assert.ok(Math.abs(counts[i] / N - wi / tot) < 0.01, `idx ${i}: ${counts[i] / N}`));
  });
});

describe('shuffled', () => {
  const src = Array.from({ length: 30 }, (_, i) => i);

  test('is a permutation and does not mutate its input', () => {
    const copy = src.slice();
    const out = shuffled(src, seedRng('s'));
    assert.deepEqual(src, copy);
    assert.notEqual(out, src);
    assert.deepEqual(out.slice().sort((a, b) => a - b), src);
    assert.notDeepEqual(out, src);
  });

  test('is deterministic for a given seed and varies across seeds', () => {
    assert.deepEqual(shuffled(src, seedRng('s')), shuffled(src, seedRng('s')));
    assert.notDeepEqual(shuffled(src, seedRng('s')), shuffled(src, seedRng('t')));
  });

  test('handles empty and single-element arrays', () => {
    assert.deepEqual(shuffled([], seedRng('s')), []);
    assert.deepEqual(shuffled(['x'], seedRng('s')), ['x']);
  });
});

describe('coercion', () => {
  test('clamp', () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-1, 0, 10), 0);
    assert.equal(clamp(11, 0, 10), 10);
    assert.equal(clamp(0, 0, 10), 0);
    assert.equal(clamp(10, 0, 10), 10);
  });

  test('num falls back for non-finite values', () => {
    assert.equal(num('3.5', 0), 3.5);
    assert.equal(num(7, 0), 7);
    assert.equal(num('abc', 9), 9);
    assert.equal(num(undefined, 9), 9);
    assert.equal(num(NaN, 9), 9);
    assert.equal(num(Infinity, 9), 9);
    assert.equal(num(null, 9), 0); // Number(null) is 0, which is finite
    assert.equal(num('', 9), 0);
  });

  test('str collapses whitespace, trims, truncates, and tolerates null', () => {
    assert.equal(str('  a \n\t b  ', 50), 'a b');
    assert.equal(str('abcdef', 3), 'abc');
    assert.equal(str(null, 5), '');
    assert.equal(str(undefined, 5), '');
    assert.equal(str(42, 5), '42');
  });

  test('strArr lowercases, trims, drops empties, caps at 12', () => {
    assert.deepEqual(strArr([' Food ', 'QUIET', '', '  ']), ['food', 'quiet']);
    assert.deepEqual(strArr('nope'), []);
    assert.deepEqual(strArr(undefined), []);
    assert.deepEqual(strArr([1, 2]), ['1', '2']);
    assert.equal(strArr(Array.from({ length: 30 }, (_, i) => 'x' + i)).length, 12);
  });

  test('truthy', () => {
    for (const v of [true, 1, 'true', 'TRUE', 'yes', 'Yes']) assert.equal(truthy(v), true, String(v));
    for (const v of [false, 0, 'false', 'no', '', null, undefined, 2, 'y']) assert.equal(truthy(v), false, String(v));
  });

  test('slug normalizes, trims underscores, truncates, falls back', () => {
    assert.equal(slug('Main Gate!', 0), 'main_gate');
    assert.equal(slug('  --Hello, World--  ', 0), 'hello_world');
    assert.equal(slug('keep_under_score', 0), 'keep_under_score');
    assert.equal(slug('x'.repeat(100), 0).length, 40);
    assert.equal(slug('!!!', 3), 'n3');
    assert.equal(slug(null, 7), 'n7');
    assert.equal(slug('', 0), 'n0');
  });

  test('clockText formats and wraps past midnight', () => {
    const spec = { clockStart: 9 * 60 };
    assert.equal(clockText(spec, 0), '09:00');
    assert.equal(clockText(spec, 75), '10:15');
    assert.equal(clockText(spec, 15 * 60), '00:00');
    assert.equal(clockText(spec, 15 * 60 + 5), '00:05');
    assert.equal(clockText(spec, 24 * 60), '09:00');
    assert.equal(clockText({ clockStart: 23 * 60 + 30 }, 45), '00:15');
    assert.equal(clockText(spec, 0.9), '09:00');
    assert.equal(clockText(spec, -10), '08:50');
    assert.equal(clockText({ clockStart: 5 }, -10), '23:55');
  });
});

describe('words helpers', () => {
  test('waitWords', () => {
    assert.equal(waitWords(0), 'no line');
    assert.equal(waitWords(0.99), 'no line');
    assert.equal(waitWords(-5), 'no line');
    assert.equal(waitWords(undefined), 'no line');
    assert.equal(waitWords('abc'), 'no line');
    assert.equal(waitWords(1), 'short, about 1 min');
    assert.equal(waitWords(4.4), 'short, about 4 min');
    assert.equal(waitWords(9.4), 'short, about 9 min');
    assert.equal(waitWords(9.9), 'short, about 10 min');
    assert.equal(waitWords(10), 'moderate, about 10 min');
    assert.equal(waitWords(12), 'moderate, about 10 min');
    assert.equal(waitWords(24.9), 'moderate, about 25 min');
    assert.equal(waitWords(25), 'long, about 25 min');
    assert.equal(waitWords(49.9), 'long, about 50 min');
    assert.equal(waitWords(50), 'very long, about 50 min');
    assert.equal(waitWords(120), 'very long, about 120 min');
  });

  test('patienceWords', () => {
    const tol = 20;
    assert.equal(patienceWords(0, tol), 'well within what they will put up with');
    assert.equal(patienceWords(11.9, tol), 'well within what they will put up with');
    assert.equal(patienceWords(12, tol), 'about the most they will put up with');
    assert.equal(patienceWords(21.9, tol), 'about the most they will put up with');
    assert.equal(patienceWords(22, tol), 'more than they will put up with');
    assert.equal(patienceWords(100, tol), 'more than they will put up with');
    // Zero or missing tolerance never divides by zero.
    assert.equal(patienceWords(5, 0), 'more than they will put up with');
    assert.equal(patienceWords(0, 0), 'well within what they will put up with');
    assert.equal(patienceWords(undefined, undefined), 'well within what they will put up with');
  });

  test('durationWords', () => {
    assert.equal(durationWords(0), 'just arrived');
    assert.equal(durationWords(1.9), 'just arrived');
    assert.equal(durationWords(2), 'about 5 minutes');
    assert.equal(durationWords(7), 'about 5 minutes');
    assert.equal(durationWords(8), 'about 10 minutes');
    assert.equal(durationWords(45), 'about 45 minutes');
    assert.equal(durationWords(89), 'about 90 minutes');
    assert.equal(durationWords(90), 'about 1.5 hours');
    assert.equal(durationWords(100), 'about 1.5 hours');
    assert.equal(durationWords(120), 'about 2 hours');
    assert.equal(durationWords(150), 'about 2.5 hours');
    assert.equal(durationWords(-4), 'just arrived');
    assert.equal(durationWords(null), 'just arrived');
  });

  test('distanceWords', () => {
    assert.equal(distanceWords(0), 'right here');
    assert.equal(distanceWords(2.99), 'right here');
    assert.equal(distanceWords(3), 'close');
    assert.equal(distanceWords(14.9), 'close');
    assert.equal(distanceWords(15), 'a short walk');
    assert.equal(distanceWords(34.9), 'a short walk');
    assert.equal(distanceWords(35), 'far');
    assert.equal(distanceWords(500), 'far');
    assert.equal(distanceWords(-1), 'right here');
    assert.equal(distanceWords('x'), 'right here');
  });

  test('priceWords', () => {
    assert.equal(priceWords(0), 'free');
    assert.equal(priceWords(-3), 'free');
    assert.equal(priceWords(undefined), 'free');
    assert.equal(priceWords(0.4), 'about $0');
    assert.equal(priceWords(12.4), 'about $12');
    assert.equal(priceWords(12.5), 'about $13');
    assert.equal(priceWords('25'), 'about $25');
  });

  test('timeWords rounds down to the half hour and wraps', () => {
    const at = (clockStart, t) => timeWords({ clockStart }, t);
    assert.equal(at(0, 0), 'around 12:00 am');
    assert.equal(at(0, 29), 'around 12:00 am');
    assert.equal(at(0, 30), 'around 12:30 am');
    assert.equal(at(9 * 60, 0), 'around 9:00 am');
    assert.equal(at(11 * 60 + 45, 0), 'around 11:30 am');
    assert.equal(at(12 * 60, 0), 'around 12:00 pm');
    assert.equal(at(13 * 60 + 30, 0), 'around 1:30 pm');
    assert.equal(at(23 * 60 + 59, 0), 'around 11:30 pm');
    assert.equal(at(23 * 60, 90), 'around 12:30 am');
    assert.equal(at(9 * 60, -600), 'around 11:00 pm');
  });

  test('feelingWords maps and clamps expected frustration', () => {
    assert.deepEqual(FEELINGS, ['calm', 'mildly annoyed', 'frustrated', 'very frustrated', 'furious']);
    assert.equal(feelingWords(0), 'calm');
    assert.equal(feelingWords(0.4), 'calm');
    assert.equal(feelingWords(0.6), 'mildly annoyed');
    assert.equal(feelingWords(2), 'frustrated');
    assert.equal(feelingWords('3'), 'very frustrated');
    assert.equal(feelingWords(4), 'furious');
    assert.equal(feelingWords(99), 'furious');
    assert.equal(feelingWords(-3), 'calm');
    assert.equal(feelingWords(null), undefined);
    assert.equal(feelingWords(undefined), undefined);
    assert.equal(feelingWords(NaN), undefined);
    assert.equal(feelingWords('abc'), undefined);
  });
});
