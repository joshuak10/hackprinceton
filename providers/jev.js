// JevProvider: turns DecisionRequests into TypeSafe System One requests, calls the API, and parses
// the typed answers into Decisions (docs/PROTOTYPE.md §6). The API key is held in a private field
// and only ever written into the Authorization header.
import { hash32, seedRng, shuffled, sha256Hex, clamp } from '../engine/util.js';
import { createLimiter, withRetry, DEFAULT_RETRY } from './limiter.js';
import { fallbackDecision } from './rules.js';

export const PRICE_PER_MTOK_USD = 0.042;
export const PRICE_NOTE = '$0.042 per million input tokens (TypeSafe published price, unverified)';
export const FRUSTRATION_LEVELS = ['Calm and content', 'Mildly annoyed', 'Frustrated', 'Very frustrated', 'Furious'];

export class JevAuthError extends Error {
  constructor(message = 'Jev rejected the API key (HTTP 401). Check TYPESAFE_API_KEY.') {
    super(message);
    this.name = 'JevAuthError';
    this.status = 401;
  }
}

// A failed request. `retryable` decides whether withRetry tries again.
export class JevRequestError extends Error {
  constructor(message, { status = null, retryable = false, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'JevRequestError';
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

// ---------- request building ----------

const YES_NO_QUESTIONS = {
  join: {
    instructions: 'Does the person in `person` join the line described in `now`?',
    criteria: { true: 'They get in line and wait.', false: 'They skip this line and go somewhere else or leave.' }
  },
  keep_waiting: {
    instructions: 'Does the person in `person` keep waiting in the line described in `now`?',
    criteria: { true: 'They stay in line.', false: 'They give up on this line.' }
  }
};

// "`a`", "`a` and `b`", "`a`, `b` and `c`" for the state fields that exist in this observation, so
// instructions never point Jev at a field that is not there.
function fieldList(obs, candidates) {
  const names = candidates.filter(k => obs[k] !== undefined).map(k => '`' + k + '`');
  if (names.length <= 1) return names.join('');
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

function given(obs, candidates) {
  const list = fieldList(obs, candidates);
  return list ? `, given ${list}` : '';
}

// Questions about where to go also name `offers` (§15b) when the observation has it. Without offers the
// text is unchanged, so request bodies, request hashes and recorded runs stay the same.
const CHOICE_INSTRUCTIONS = {
  next_place: obs => `Where does the person in \`person\` go next${given(obs, ['now', 'places', 'heard', 'offers'])}?`,
  route: obs => `Which route in \`routes\` does the person in \`person\` take for \`trip\`${given(obs, ['offers'])}?`
};

// A yes/no line question, with ", given `offers`" before the question mark when the observation has offers.
const yesNoInstructions = (q, obs) => q.instructions.replace(/\?$/, `${given(obs, ['offers'])}?`);

// Where a remark would be about: "at <place name>" or "on <stretch name>". Names come from the
// spec when available, otherwise from the observation, otherwise the raw id.
function subjectPhrase(req, spec) {
  const obs = req.observation || {};
  if (req.aboutEdge) {
    const id = String(req.aboutEdge);
    const [from, to] = id.split('>');
    const edge = (spec?.edges || []).find(e =>
      e.id === id || (e.from === from && e.to === to) || (e.twoWay !== false && e.from === to && e.to === from));
    return `on ${edge?.name || obs.worst_stretch || id}`;
  }
  if (req.aboutPlace) {
    const node = (spec?.nodes || []).find(n => n.id === req.aboutPlace);
    const seen = Array.isArray(obs.places) ? obs.places.find(p => p?.option === req.aboutPlace) : null;
    return `at ${node?.name || seen?.name || req.aboutPlace}`;
  }
  return 'here';
}

// Criteria object in the given option order. Labels are the descriptions Jev reads.
function choiceCriteria(options, questionName) {
  if (!Array.isArray(options) || options.length === 0) throw new Error(`"${questionName}" has no options`);
  if (options.length > 255) throw new Error(`"${questionName}" has ${options.length} options; Jev accepts at most 255`);
  const criteria = {};
  for (const o of options) {
    const key = String(o?.key ?? '');
    if (!key) throw new Error(`"${questionName}" has an option without a key`);
    if (Object.hasOwn(criteria, key)) throw new Error(`"${questionName}" has duplicate option "${key}"`);
    criteria[key] = o.label ?? null;
  }
  return criteria;
}

// Builds the exact System One body for one DecisionRequest. Choice criteria are shuffled with a
// seed derived from the observation, because Jev leans toward the first option; the same state
// always gives the same order, so identical states share a requestHash and hit the cache.
// `json` is the exact string to send; `requestHash` is its sha256.
export function buildJevRequest(req, { model = 'jev-latest', spec = null, shuffle = true } = {}) {
  const obs = req.observation ?? {};
  const asks = req.asks ?? {};
  const stateSeed = hash32(JSON.stringify(obs));
  const ordered = (items, name) => (shuffle ? shuffled(items, seedRng(stateSeed, name)) : items.slice());
  const questions = {};

  if (asks.yesNo) {
    const q = YES_NO_QUESTIONS[asks.yesNo];
    if (!q) throw new Error(`unknown yes/no question "${asks.yesNo}"`);
    questions[asks.yesNo] = { type: 'noul', instructions: yesNoInstructions(q, obs), criteria: { ...q.criteria } };
  }
  if (asks.choice) {
    const text = CHOICE_INSTRUCTIONS[asks.choice];
    if (!text) throw new Error(`unknown choice question "${asks.choice}"`);
    questions[asks.choice] = {
      type: 'choice',
      instructions: text(obs),
      criteria: choiceCriteria(ordered(req.options ?? [], asks.choice), asks.choice)
    };
  }
  if (asks.frustration) {
    questions.frustration = {
      type: 'score',
      instructions: `How frustrated is the person in \`person\` right now${given(obs, ['so_far', 'now', 'time_taken', 'worst_stretch'])}?`,
      criteria: FRUSTRATION_LEVELS.slice()
    };
  }
  if (asks.tellOthers) {
    const where = subjectPhrase(req, spec);
    questions.tell_others = {
      type: 'noul',
      instructions: `Would the person in \`person\` tell friends, family or a group chat about their experience ${where}?`
    };
    if (Array.isArray(req.remarkKinds) && req.remarkKinds.length) {
      questions.remark_kind = {
        type: 'choice',
        instructions: `What would the person in \`person\` tell others about their experience ${where}?`,
        criteria: choiceCriteria(ordered(req.remarkKinds, 'remark_kind'), 'remark_kind')
      };
    }
  }
  if (!Object.keys(questions).length) throw new Error('the request asks no questions');

  const body = { model, state: obs, questions };
  const json = JSON.stringify(body);
  return { body, json, requestHash: sha256Hex(json) };
}

// ---------- response parsing ----------

function noulOf(answer) {
  const p = Number(answer?.noul);
  return answer && Number.isFinite(p) ? clamp(p, 0, 1) : null;
}

// Keeps only the allowed keys with finite non-negative probabilities; null if none survive.
function pickProbs(probabilities, allowedKeys) {
  if (!probabilities || typeof probabilities !== 'object') return null;
  const out = {};
  let total = 0;
  for (const k of allowedKeys) {
    const p = Number(probabilities[k]);
    if (Object.hasOwn(probabilities, k) && Number.isFinite(p) && p >= 0) { out[k] = p; total += p; }
  }
  return total > 0 ? out : null;
}

const FRUSTRATION_KEYS = FRUSTRATION_LEVELS.map((_, i) => String(i));

// Raw Jev answers → the probability fields of a Decision. Throws when the primary question
// (asks.yesNo or asks.choice) has no usable answer; follow-ups are simply omitted.
export function parseAnswers(req, answers) {
  const asks = req.asks ?? {};
  const a = answers && typeof answers === 'object' ? answers : {};
  const out = {};
  if (asks.yesNo) {
    const p = noulOf(a[asks.yesNo]);
    if (p == null) throw new JevRequestError(`response has no usable answer for "${asks.yesNo}"`);
    out.yesProb = p;
  }
  if (asks.choice) {
    const probs = pickProbs(a[asks.choice]?.probabilities, (req.options ?? []).map(o => String(o.key)));
    if (!probs) throw new JevRequestError(`response has no usable answer for "${asks.choice}"`);
    out.choiceProbs = probs;
  }
  if (asks.frustration && Number.isFinite(Number(a.frustration?.score))) {
    out.frustration = {
      expected: clamp(Number(a.frustration.score), 0, FRUSTRATION_LEVELS.length - 1),
      probs: pickProbs(a.frustration.probabilities, FRUSTRATION_KEYS) ?? {}
    };
  }
  if (asks.tellOthers) {
    const tell = noulOf(a.tell_others);
    if (tell != null) out.tellProb = tell;
    if (Array.isArray(req.remarkKinds) && req.remarkKinds.length) {
      const kinds = pickProbs(a.remark_kind?.probabilities, req.remarkKinds.map(k => String(k.key)));
      if (kinds) out.remarkProbs = kinds;
    }
  }
  return out;
}

// ---------- HTTP helpers ----------

// retry-after is seconds, or an HTTP date. Returns milliseconds or null.
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value == null || String(value).trim() === '') return null;
  const s = Number(value);
  if (Number.isFinite(s)) return s >= 0 ? s * 1000 : null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

// A short, readable reason from an error body: 400 has { detail: string|object }, 422 has
// { detail: [{ loc, msg }] }.
function errorDetail(text) {
  let detail = String(text ?? '').trim();
  try {
    const d = JSON.parse(text)?.detail;
    if (typeof d === 'string') detail = d;
    else if (Array.isArray(d)) detail = d.map(e => `${(e?.loc ?? []).join('.')}: ${e?.msg ?? ''}`).join('; ');
    else if (d && typeof d === 'object') detail = d.message ? String(d.message) : JSON.stringify(d);
  } catch { /* not JSON: keep the raw text */ }
  return detail.length > 300 ? detail.slice(0, 299) + '…' : detail;
}

function usageOf(u) {
  const n = v => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : 0);
  return { input_tokens: n(u?.input_tokens), output_tokens: n(u?.output_tokens) };
}

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  return sorted[clamp(Math.ceil(q * sorted.length) - 1, 0, sorted.length - 1)];
}

// ---------- provider ----------

export class JevProvider {
  #apiKey;
  #fetch;

  // Beyond the contract's options: `shuffle` (false sends options in request order, used by the
  // option-order sanity check), `retry` (overrides for withRetry: attempts, baseMs, maxMs, sleep,
  // random), and `now` (clock for latency, injectable for tests).
  constructor({
    apiKey,
    model = 'jev-latest',
    concurrency = 32,
    maxRequests = 20000,
    fetch = globalThis.fetch,
    baseUrl = 'https://api.typesafe.ai',
    timeoutMs = 15000,
    cache = new Map(),
    shuffle = true,
    retry = {},
    now = () => performance.now()
  } = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('JevProvider needs an apiKey (set TYPESAFE_API_KEY).');
    if (typeof fetch !== 'function') throw new Error('JevProvider needs a fetch function.');
    this.#apiKey = apiKey.trim();
    this.#fetch = fetch;
    this.name = 'jev';
    this.external = true;
    this.model = model || 'jev-latest';
    this.maxRequests = Math.max(0, Math.floor(Number(maxRequests)) || 0);
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 15000);
    this.cache = cache;
    this.shuffle = shuffle !== false;
    this.retryPolicy = { ...DEFAULT_RETRY, ...retry };
    this.now = now;
    this.limit = createLimiter(concurrency);
    this.inflight = new Map();
    this.authError = null;

    this.resolvedModel = null;
    this.decisions = 0;
    this.requests = 0;
    this.cacheHits = 0;
    this.fallbacks = 0;
    this.errors = 0;
    this.retries = 0;
    this.firstError = null;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.latencies = [];
  }

  // Same length and order as `requests`. Each #decide call runs synchronously up to its first
  // await, so cache lookups and the request budget are applied in request order.
  async decideMany(requests, ctx = {}) {
    if (this.authError) throw this.authError;
    return Promise.all(requests.map(req => this.#decide(req, ctx)));
  }

  async #decide(req, ctx) {
    this.decisions++;
    let built;
    try {
      built = buildJevRequest(req, { model: this.model, spec: ctx?.spec ?? null, shuffle: this.shuffle });
    } catch (err) {
      return this.#fail(req, `could not build the Jev request: ${err.message}`, null);
    }
    const { json, requestHash } = built;

    const cached = this.cache.get(requestHash);
    if (cached && cached.answers && typeof cached.answers === 'object') {
      return this.#fromCache(req, cached, requestHash);
    }

    // An identical request already on the wire: wait for it instead of paying twice.
    const pending = this.inflight.get(requestHash);
    if (pending) {
      try {
        return this.#fromCache(req, await pending, requestHash);
      } catch (err) {
        if (err instanceof JevAuthError) throw err;
        return this.#fallback(req, err.message, requestHash);
      }
    }

    if (this.requests >= this.maxRequests) return this.#fallback(req, 'max-requests reached', requestHash);
    this.requests++;

    const call = this.limit(() => this.#send(json));
    this.inflight.set(requestHash, call);
    try {
      const res = await call;
      this.resolvedModel = res.model;
      this.inputTokens += res.usage.input_tokens;
      this.outputTokens += res.usage.output_tokens;
      this.latencies.push(res.latencyMs);
      const fields = parseAnswers(req, res.answers);
      this.cache.set(requestHash, { answers: res.answers, model: res.model });
      return { provider: 'jev', ...fields, model: res.model, latencyMs: res.latencyMs, usage: res.usage, requestHash, answers: res.answers };
    } catch (err) {
      if (err instanceof JevAuthError) throw err;
      const msg = err.retryable && err.attempts > 1 ? `${err.message} (gave up after ${err.attempts} attempts)` : err.message;
      return this.#fail(req, msg, requestHash);
    } finally {
      this.inflight.delete(requestHash);
    }
  }

  #fromCache(req, entry, requestHash) {
    let fields;
    try {
      fields = parseAnswers(req, entry.answers);
    } catch (err) {
      return this.#fallback(req, err.message, requestHash);
    }
    this.cacheHits++;
    return {
      provider: 'jev-cache', ...fields, model: entry.model ?? this.model, latencyMs: 0,
      usage: { input_tokens: 0, output_tokens: 0 }, requestHash, answers: entry.answers
    };
  }

  // A failed API request: counted as an error, and the first message is kept for stats.
  #fail(req, message, requestHash) {
    this.errors++;
    if (this.firstError == null) this.firstError = message;
    return this.#fallback(req, message, requestHash);
  }

  #fallback(req, message, requestHash) {
    this.fallbacks++;
    return fallbackDecision(req, message, requestHash ? { requestHash } : {});
  }

  #send(json) {
    return withRetry(async attempt => {
      if (this.authError) throw this.authError;
      if (attempt > 1) this.retries++;
      return this.#attempt(json);
    }, { ...this.retryPolicy, shouldRetry: err => err?.retryable === true });
  }

  async #attempt(json) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const t0 = this.now();
    let res, text;
    try {
      res = await this.#fetch(`${this.baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json' },
        body: json,
        signal: controller.signal
      });
      text = await res.text();
    } catch (err) {
      if (controller.signal.aborted) throw new JevRequestError(`timed out after ${this.timeoutMs} ms`, { retryable: true });
      const code = err?.cause?.code ? ` (${err.cause.code})` : '';
      throw new JevRequestError(`network error: ${err?.message ?? err}${code}`, { retryable: true });
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = Math.round(this.now() - t0);

    if (res.status === 401) {
      this.authError ??= new JevAuthError();
      throw this.authError;
    }
    if (!res.ok) {
      const status = res.status;
      const detail = errorDetail(text);
      throw new JevRequestError(`HTTP ${status}${detail ? ': ' + detail : ''}`, {
        status,
        retryable: status === 408 || status === 429 || status >= 500,
        retryAfterMs: parseRetryAfter(res.headers?.get?.('retry-after'))
      });
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new JevRequestError('response was not valid JSON', { status: res.status, retryable: true });
    }
    if (!data || typeof data.answers !== 'object' || data.answers === null) {
      throw new JevRequestError('response has no answers', { status: res.status, retryable: true });
    }
    return {
      answers: data.answers,
      model: typeof data.model === 'string' && data.model ? data.model : this.model,
      usage: usageOf(data.usage),
      latencyMs
    };
  }

  // Beyond the contract's fields: requestedModel (the alias sent), decisions (all answered,
  // including cache hits and fallbacks; fallback rate = fallbacks / decisions) and retries.
  stats() {
    const sorted = this.latencies.slice().sort((x, y) => x - y);
    return {
      provider: 'jev',
      model: this.resolvedModel ?? this.model,
      requestedModel: this.model,
      requests: this.requests,
      decisions: this.decisions,
      cacheHits: this.cacheHits,
      fallbacks: this.fallbacks,
      errors: this.errors,
      retries: this.retries,
      firstError: this.firstError,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      latency: { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted.length ? sorted[sorted.length - 1] : 0 },
      estCostUSD: (this.inputTokens * PRICE_PER_MTOK_USD) / 1e6,
      priceNote: PRICE_NOTE
    };
  }
}
