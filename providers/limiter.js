// Concurrency limiting and retry with exponential backoff (docs/PROTOTYPE.md §6).

// Returns limit(fn): runs fn() once fewer than `concurrency` calls are active, and resolves with
// its result. Calls start in the order they were queued. `limit.active` and `limit.pending`
// report the current load.
export function createLimiter(concurrency) {
  const max = Math.max(1, Math.floor(Number(concurrency)) || 1);
  let active = 0;
  const queue = [];

  const next = () => {
    while (active < max && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => { active--; next(); });
    }
  };

  const limit = fn => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
  Object.defineProperties(limit, {
    concurrency: { value: max },
    active: { get: () => active },
    pending: { get: () => queue.length }
  });
  return limit;
}

export const DEFAULT_RETRY = Object.freeze({
  attempts: 5,
  baseMs: 250,
  maxMs: 8000,
  maxRetryAfterMs: 60000
});

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Exponential backoff with "equal jitter": half of the capped exponential delay is fixed and the
// other half is random, so retries spread out but never collapse to zero.
export function backoffDelay(attempt, { baseMs = DEFAULT_RETRY.baseMs, maxMs = DEFAULT_RETRY.maxMs, random = Math.random } = {}) {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return exp / 2 + random() * (exp / 2);
}

// Calls fn(attempt) until it resolves, `shouldRetry(err)` says no, or `attempts` run out.
// A positive `err.retryAfterMs` (e.g. from a retry-after header) replaces the backoff delay.
// The final error is rethrown with `err.attempts` set to the number of attempts made.
export async function withRetry(fn, policy = {}) {
  const {
    attempts = DEFAULT_RETRY.attempts,
    baseMs = DEFAULT_RETRY.baseMs,
    maxMs = DEFAULT_RETRY.maxMs,
    maxRetryAfterMs = DEFAULT_RETRY.maxRetryAfterMs,
    shouldRetry = () => true,
    sleep = defaultSleep,
    random = Math.random,
    onRetry = null
  } = policy;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= attempts || !shouldRetry(err)) {
        if (err && typeof err === 'object') err.attempts = attempt;
        throw err;
      }
      const hinted = Number(err?.retryAfterMs);
      const delay = hinted > 0 ? Math.min(hinted, maxRetryAfterMs) : backoffDelay(attempt, { baseMs, maxMs, random });
      onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
}
