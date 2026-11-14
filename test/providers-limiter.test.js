import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, withRetry, backoffDelay, DEFAULT_RETRY } from '../providers/limiter.js';

const wait = ms => new Promise(r => setTimeout(r, ms));

describe('createLimiter', () => {
  test('never runs more than `concurrency` tasks at once and starts them in order', async () => {
    const limit = createLimiter(4);
    let active = 0, peak = 0;
    const started = [];
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => limit(async () => {
      started.push(i);
      active++;
      peak = Math.max(peak, active);
      await wait(1 + (i % 3));
      active--;
      return i * 2;
    })));
    assert.equal(peak, 4);
    assert.deepEqual(started, Array.from({ length: 25 }, (_, i) => i));
    assert.deepEqual(results, Array.from({ length: 25 }, (_, i) => i * 2));
    assert.equal(limit.active, 0);
    assert.equal(limit.pending, 0);
  });

  test('a rejected task frees its slot and rejects only its own promise', async () => {
    const limit = createLimiter(1);
    const a = limit(async () => { throw new Error('boom'); });
    const b = limit(async () => 'ok');
    await assert.rejects(a, /boom/);
    assert.equal(await b, 'ok');
  });

  test('synchronous throws are caught too', async () => {
    const limit = createLimiter(2);
    await assert.rejects(limit(() => { throw new Error('sync'); }), /sync/);
    assert.equal(limit.active, 0);
  });

  test('bad concurrency values become 1', () => {
    assert.equal(createLimiter(0).concurrency, 1);
    assert.equal(createLimiter('abc').concurrency, 1);
    assert.equal(createLimiter(7.9).concurrency, 7);
  });
});

describe('withRetry', () => {
  const quiet = (extra = {}) => {
    const sleeps = [];
    return { sleeps, policy: { sleep: async ms => { sleeps.push(ms); }, random: () => 0, ...extra } };
  };

  test('retries until success with growing backoff', async () => {
    const { sleeps, policy } = quiet();
    let calls = 0;
    const out = await withRetry(async attempt => {
      calls++;
      if (attempt < 4) throw new Error('flaky');
      return 'done';
    }, policy);
    assert.equal(out, 'done');
    assert.equal(calls, 4);
    assert.deepEqual(sleeps, [125, 250, 500]);   // random = 0 → half of 250, 500, 1000
  });

  test('stops at `attempts` and reports the count on the error', async () => {
    const { sleeps, policy } = quiet();
    let calls = 0;
    await assert.rejects(withRetry(async () => { calls++; throw new Error('down'); }, policy), err => {
      assert.equal(err.message, 'down');
      assert.equal(err.attempts, DEFAULT_RETRY.attempts);
      return true;
    });
    assert.equal(calls, 5);
    assert.equal(sleeps.length, 4);
  });

  test('does not retry when shouldRetry says no', async () => {
    const { sleeps, policy } = quiet({ shouldRetry: err => err.code !== 'FATAL' });
    let calls = 0;
    await assert.rejects(withRetry(async () => { calls++; throw Object.assign(new Error('x'), { code: 'FATAL' }); }, policy));
    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);
  });

  test('honors retryAfterMs, capped at maxRetryAfterMs', async () => {
    const { sleeps, policy } = quiet({ maxRetryAfterMs: 5000 });
    let n = 0;
    await withRetry(async () => {
      n++;
      if (n === 1) throw Object.assign(new Error('429'), { retryAfterMs: 3000 });
      if (n === 2) throw Object.assign(new Error('429'), { retryAfterMs: 120000 });
      return 'ok';
    }, policy);
    assert.deepEqual(sleeps, [3000, 5000]);
  });

  test('onRetry sees each retry', async () => {
    const seen = [];
    const { policy } = quiet({ onRetry: (err, attempt, delay) => seen.push([err.message, attempt, delay]) });
    let n = 0;
    await withRetry(async () => { if (++n < 3) throw new Error('e' + n); return 1; }, policy);
    assert.deepEqual(seen, [['e1', 1, 125], ['e2', 2, 250]]);
  });
});

describe('backoffDelay', () => {
  test('exponential from 250 ms with jitter, capped at 8 s', () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      const exp = Math.min(8000, 250 * 2 ** (attempt - 1));
      assert.equal(backoffDelay(attempt, { random: () => 0 }), exp / 2);
      assert.equal(backoffDelay(attempt, { random: () => 0.999999 }) <= exp, true);
    }
    assert.equal(backoffDelay(12, { random: () => 1 }), 8000);
  });
});
