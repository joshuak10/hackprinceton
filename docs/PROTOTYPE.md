# Swarmscope prototype v0.2: build contract

This file is the interface contract for the first Jev prototype. [SWARMSCOPE_SPEC.md](../SWARMSCOPE_SPEC.md) says what and why; this file says exactly how the modules fit together. Every module must match the shapes here. If a shape must change, change this file in the same edit.

**Goal:** a general simulator. Any environment that can be written as a world spec (places with lines, or a network of routes) runs with every agent deciding through Jev (`jev-latest`), or through rules for speed or outages. Runs are recorded and replay in a local viewer.

**Runtime:** Node 22+, ES modules, no build step, no TypeScript. Only three dependencies: `@anthropic-ai/sdk` (optional compile step), `@modelcontextprotocol/sdk` and `zod` (MCP server). Engine, providers, runner, recorder and server use only Node built-ins (`node:http`, `node:fs`, `node:crypto`, global `fetch`). Tests use `node:test` and `node:assert/strict`.

**Secrets:** `TYPESAFE_API_KEY` (required for Jev) and `ANTHROPIC_API_KEY` (optional, only for `swarm compile`). Read from `process.env` after `loadEnv()` (below). Never log, record, or send a key to the browser.

---

## 1. File layout and ownership

```
engine/util.js        mulberry32, hash32, seedRng, clamp, num, str, strArr, truthy, slug, clockText, words helpers
engine/env.js         loadEnv(): parse .env.local then .env in cwd if present; never overrides existing process.env
engine/spec.js        normalizeSpec, validateWorld, cleanSpec, applyPatch, PATCH_FIELDS, specHash
engine/observe.js     builds the JSON-safe observation for a decision (what the agent can see and has heard)
engine/sample.js      sampleDecision(req, decision, rng): turns probabilities into one sampled action
engine/sim.js         class Sim: seeded tick simulation, decision protocol, remarks, frames, metrics
providers/rules.js    RulesProvider
providers/jev.js      JevProvider: builds Jev requests, calls the API, parses answers
providers/limiter.js  createLimiter(concurrency), withRetry(fn, policy)
providers/replay.js   ReplayProvider: answers from a recorded run, no API calls
providers/index.js    makeProvider(name, opts)
run/runner.js         runSwarm(...), runSeeds(...), compareRuns(...)
run/recorder.js       createRecorder(...), loadRun(dir), listRuns(root)
run/report.js         reportMarkdown(runDir), agentLog(runDir, agentId)
run/effects.js        measure(...), changeEffects(...), effectLines(...): what a change did, seed by seed (§15d)
run/advisor.js        buildBrief(...), advise(...), writeAdvice(...) (§15c)
bin/swarm.js          CLI
server/server.js      startServer({ port, root }) local HTTP API + static viewer
web/index.html, web/app.js, web/style.css   viewer
web/scope/            scope display for the two CoStar cases (§9b): index.html, style.css, app.js, lib/*.js, mock/ (synthetic runs, committed), data/ (gitignored, built from hackathon data)
geometry/*.js         shared plain JS (no DOM, no Node built-ins): matterport.js (Model API → floor plan), obj-slice.js (mesh → obstacle grid), walkgrid.js (walkable grid, distance fields)
mockgen/*.js          mock run generators for the two cases (building, parking), same RunBundle shape as recorded runs
scripts/extract_building.js, scripts/mock_runs.js, scripts/serve_web.js   geometry extraction, mock runs, dev static server
compile/compile.js    compileWorld(description, opts) via Claude API (optional)
worlds/*.json         example worlds; worlds/SCHEMA.md and worlds/schema.json describe the format
mcp/server.js         MCP server over stdio
.claude/commands/swarm.md   Claude Code slash command: describe → world → validate → run → report → compare
validation/*.js       validation scripts that print results (Erlang C, Braess, Jev sanity)
test/*.test.js        unit and integration tests
```

The prototype's original engine (extracted verbatim from the Swarmscope artifact, rule-based plus Claude cohort "minds") is the starting point for `engine/`. Claude cohort minds are removed: Claude no longer decides for agents.

---

## 2. World spec

Same as the prototype (spec section 6), with these additions. `normalizeSpec` stays lenient (clamps and fills defaults); `validateWorld` reports problems.

| Field | Where | Meaning |
|---|---|---|
| `context` | top level, optional string ≤ 300 chars | One or two sentences agents are told about the setting, e.g. "Friday night in Larkfield. People are deciding where to get emergency care." Defaults to the title. |
| `leaveLabel` | top level, optional string ≤ 60 | Label for the visit-mode leave option. Default `"Leave and go home"`. |
| `arrivals.shape` | add `"poisson"` | Constant-rate Poisson arrivals between `start` and `end` (exponential gaps). Used by validation tests. |
| `nodes[].serviceDist` | visit service nodes, optional | `"uniform"` (default, 0.6–1.4 × serviceTime), `"exp"` (exponential, mean serviceTime), `"fixed"`. |
| `edges[].costModel` | route edges, optional | `"bpr"` (default, the prototype's curve) or `"linear"`: travel time = `length + load / capacity`. |
| `archetypes[].patience` | existing | Minutes of waiting this group puts up with. |
| `minds[]` | existing, now "the cast" | Personas Claude wrote. Each agent is assigned one persona (weighted by archetype share and persona `weight`) and keeps its own state. |

`validateWorld(raw)` returns `{ ok: boolean, errors: string[], warnings: string[], spec: normalizedSpec | null }`. Errors are fatal problems (the messages `normalizeSpec` would throw, plus unknown node references in edges, archetype origins/destinations, or minds). Warnings are silent fixes: clamped values, unknown fields, missing cast, a service node unreachable by every archetype's `needs`, etc. Each message names the field path, e.g. `nodes[3].servers: 0 is below the minimum 1; using 1`.

`specHash(spec)` = first 12 hex chars of sha256 of `JSON.stringify(cleanSpec(spec))`.

`applyPatch(spec, patch)` keeps the prototype's behavior and returns `{ spec, applied, skipped }`. Add `serviceDist` and `costModel` nowhere in `PATCH_FIELDS` (not patchable).

---

## 3. Randomness and time (determinism rules)

- `hash32(...parts)`: FNV-1a 32-bit over `parts.join('|')`. `seedRng(...parts)` = `mulberry32(hash32(...parts))`.
- The **arrival schedule** comes from `seedRng(seed, 'arrivals')`.
- Each **agent** has its own stream `seedRng(seed, 'agent', agentId)`, used in this order at spawn: persona pick, entry pick, `informed`, `jit`; later for its service times, rule-based picks and route-link logits.
- Each **decision** samples with `seedRng(seed, 'decide', agentId, decisionIndex)`, where `decisionIndex` counts that agent's external decisions from 0.
- Result: the same seed gives the same people arriving at the same times with the same personas under every provider and every patch (common random numbers). Given the same decisions, a run is bit-for-bit reproducible.
- **Ticks:** `dt` = 0.5 min (visit) or 0.25 min (route), overridable with `opts.dt` (validation uses small values). `step()` advances one tick. All decision requests created during ticks are held, and agents with a held request are frozen in state `think`. Exception: a `long` decision keeps the agent in its line position. `pending()` releases the held requests once the oldest is at least `batchWindow` sim minutes old, or when the sim is done. `batchWindow` defaults to 1 (visit) or 0.5 (route) and can be set with `opts.batchWindow`, where 0 means release every tick. The runner resolves all released requests before the next `step()`, applying them **in request-id order**. This makes runs independent of API response order.

---

## 4. Decision protocol

`new Sim(spec, opts)` with `opts = { seed = 7, external = false, dt, batchWindow, frameEvery, maxTrace = 60 }`. `spec` may be raw or normalized; the constructor normalizes it.

- `external: false`: the prototype's inline rule behavior. No requests are created, and `runToEnd()` works synchronously. This is the fast rules provider.
- `external: true`: every decision moment creates a `DecisionRequest`. `runToEnd()` throws in external mode.

**Sim public surface** (everything else is internal):

| Member | Meaning |
|---|---|
| `step()`, `get done`, `t`, `spec` | Advance one tick; finished flag; current time; normalized spec |
| `pending()`, `resolve(id, decision)` | Decision protocol (below) |
| `runToEnd()` | Synchronous run, inline mode only |
| `metrics()` | §7 |
| `frames` | §7 |
| `remarks` | Array of structured remarks |
| `agentsSummary()` | The `agents.json` array (§7) |
| `opts` | Resolved options: `{ seed, external, dt, batchWindow, frameEvery }` |

### Decision moments (external mode)

| kind | When | Primary question | Speculative follow-ups |
|---|---|---|---|
| `choose` | visit: arrives (`why:"start"`), finished somewhere (`"next"`), walked away from a line (`"balked"`), gave up waiting (`"gaveup"`) | `next_place` Choice over candidate places + `leave` | `frustration` and `tell_others` + `remark_kind` only when `why !== "start"`, about `aboutPlace` (the place just left) |
| `line` | visit: reaches a place whose estimated wait > 8 min and > 0.5 × tolerance (otherwise joins without asking) | `join` Noul | `next_place` Choice (used if not joining), `frustration`, `tell_others` + `remark_kind` about this place |
| `long` | visit: has waited > tolerance and > 10 min, once per line visit (again every `waiting.askAgainEvery` minutes when the world sets it, §16) | `keep_waiting` Noul | `next_place`, `frustration`, `tell_others` + `remark_kind` about this place |
| `route` | route: trip start, when there are ≥ 2 route options | `route` Choice over `r0..rN` | none |
| `arrive` | route: trip end, when trip time > 1.25 × free-flow time | none | `frustration`, `tell_others` + `remark_kind` about `aboutEdge` (the worst stretch: largest extra minutes) |

Frozen agents do nothing until resolved. A trip with an `arrive` request is already finished; resolving it only records feelings and remarks.

When an after-experience `choose` has nothing left to choose (visits used up, the decision cap reached, or no candidates), the Sim still creates it with `asks.choice: null`, `options: []`, `frustration` and `tellOthers` true, and `auto: { action: 'leave' }`; it always resolves to leaving. This keeps frustration and remarks for single-visit worlds. For `line` and `long`, `asks.choice` is `'next_place'` (speculative), so `auto.action` is `'yes'` when the rule policy would stay, or the place key / `'leave'` it would pick instead.

### `DecisionRequest` (engine → provider), JSON-safe, no object references

```js
{
  id: 'd17',                    // 'd' + global sequence, starting at 1; order of creation
  t: 123.5, clock: '20:03',
  kind: 'choose' | 'line' | 'long' | 'route' | 'arrive',
  why: 'start' | 'next' | 'balked' | 'gaveup' | null,   // choose only
  agentId: 42, decisionIndex: 3,
  personaId: 'samuel', personaName: 'Samuel Reyes', archetypeId: 'senior',
  placeId: 'st_brigid' | null,  // line/long: the line's node
  aboutPlace: 'st_brigid' | null,  // place a remark would be about (choose after an experience, line, long)
  aboutEdge: 'canal>ferry' | null, // arrive: worst stretch
  asks: {                       // which questions the provider must ask
    choice: 'next_place' | 'route' | null,
    yesNo: 'join' | 'keep_waiting' | null,
    frustration: boolean,
    tellOthers: boolean
  },
  options: [ { key: 'st_brigid', label: "Go to St. Brigid's ER" }, ..., { key: 'leave', label: 'Leave and go home' } ],
                                // choices for asks.choice; keys are node ids, 'leave', or 'r0'..'rN'; ≤ 255; never empty when asks.choice is set
  remarkKinds: [ { key: 'long_line', label: "Warn about a long line or wait at St. Brigid's ER" }, ... ] | null,
                                // visit: long_line, bad_service, good_experience; route: heavy_traffic, clear_roads
  observation: { ... },         // §5; becomes the Jev `state`
  auto: { action: 'st_brigid' } // what the rule policy would do: a key from options, or 'yes'/'no' for yesNo-only kinds; null for 'arrive'
}
```

### `Decision` (provider → engine)

```js
{
  provider: 'jev' | 'jev-cache' | 'rules' | 'rules-fallback' | 'replay',
  action: undefined | string,     // set by rules providers: final key (options key, or 'yes'/'no'); engine uses it as-is
  choiceProbs: { st_brigid: 0.62, leave: 0.05, ... },   // distribution over options keys (Jev)
  yesProb: 0.31,                  // probability of yes for asks.yesNo (Jev)
  frustration: { expected: 2.4, probs: { '0': 0, '1': 0.1, '2': 0.4, '3': 0.4, '4': 0.1 } },  // optional
  tellProb: 0.46,                 // optional
  remarkProbs: { long_line: 0.7, bad_service: 0.2, good_experience: 0.1 },  // optional
  model: 'jev-1.14.0', latencyMs: 152, usage: { input_tokens: 914, output_tokens: 139 },
  requestHash: 'ab12…', answers: { ...raw Jev answers... },   // Jev and replay only
  error: undefined | 'message'    // set on rules-fallback
}
```

### Sampling: `sampleDecision(req, decision, rng)` in `engine/sample.js`

This is a pure function. It draws from `rng` in this fixed order: yes/no → choice → tell → remark kind. It always draws the same number of values (4), even when a step is unused, so later draws don't shift.

1. If `asks.yesNo`: `yes = decision.action ? decision.action === 'yes' : u1 < yesProb`.
2. Choice (`asks.choice`, or the speculative `next_place` when yes/no came out "no"): use `decision.action` if it's a valid option key. Otherwise drop keys not in `options`, renormalize, and sample with `u2`. If nothing valid remains, use `req.auto.action`.
3. `tell = tellProb != null && u3 < tellProb`.
4. If tell: sample the remark kind from `remarkProbs` with `u4`. Defaults: visit `long_line` if the agent waited or balked, otherwise `good_experience`; route `heavy_traffic`.

It returns `{ yes: boolean|null, action: string|null, tell: boolean, remarkKind: string|null, frustration: number|null }`.

### `sim.resolve(id, decision)` returns `applied`

It applies the sampled outcome with the prototype's apply semantics, minus cohort policies:

- `choose`: go to the place, or leave.
- `line`: yes means enqueue; no means walk away, then go to the sampled place or leave.
- `long`: yes means keep waiting, and the line limit is extended by one tolerance (with `waiting.askAgainEvery`, a yes instead schedules the next question and sets no limit, §16). No means give up (if still in line), then go to the sampled place or leave.
- `route`: follow the sampled route's links.
- `arrive`: nothing to move.

Then:
- **Frustration** (if present): `agent.frustration = expected`, and `agent.patienceMult = clamp(1 - 0.1 * expected, 0.55, 1)`. Tolerance = `arch.patience * agent.patienceMult`.
- **Remark** (if `tell`): push `{ t, agentId, personaName, archetypeId, kind, placeId|null, edgeId|null, informed }` onto `sim.remarks`.

`resolve` returns `{ id, agentId, kind, yes, action, tell, remarkKind, frustration, summary, provider }`, where `summary` is a human sentence like "skipped St. Brigid's ER's line for QuickCare". The sim also logs `summary` to the agent's trace.

`sim.pending()` returns released requests and marks them in-flight (a second call doesn't return them again). `sim.resolve` on an unknown or already-resolved id throws.

---

## 5. Observation (the Jev `state`)

Built by `engine/observe.js`. Jev is weak with numbers and dates, so **all comparisons happen in code and appear as words**, with a rounded number for flavor. Keep it small: only what the decision needs.

Helpers (export from `engine/util.js`):
- `waitWords(min)`: `"no line"` (< 1), `"short, about N min"` (< 10), `"moderate, about N min"` (< 25), `"long, about N min"` (< 50), `"very long, about N min"`. Round N to the nearest 5 when ≥ 10.
- `patienceWords(est, tolerance)`: `"well within what they will put up with"` (est < 0.6 tol), `"about the most they will put up with"` (< 1.1 tol), `"more than they will put up with"`.
- `durationWords(min)`: `"just arrived"` (< 2), `"about N minutes"` (N rounded to 5), `"about H hours"` (≥ 90, rounded to 0.5 h).
- `distanceWords(d)` on map units: `"right here"` (< 3), `"close"` (< 15), `"a short walk"` (< 35), `"far"`.
- `priceWords(p)`: `"free"` or `"about $N"`.
- `timeWords(spec, t)`: time rounded down to 30 minutes in 12-hour form, e.g. `"around 9:30 pm"`.
- `feelingWords(expected)`: index of `["calm", "mildly annoyed", "frustrated", "very frustrated", "furious"]`, rounded.

Visit observation:
```js
{
  setting: spec.context || spec.title,
  time: 'around 9:30 pm',
  person: { name, age, about: bio, personality, wants: goal, listens_to: social, group: archetype.name,
            has_live_wait_app: informed },
  feeling: 'frustrated' | undefined,           // only after a frustration answer exists
  so_far: { time_here: 'about 35 minutes', time_in_lines: 'about 20 minutes', places_done: ['Thunder Spine'] },
  now: 'Just arrived. Choosing where to go first.'
     | 'Just finished at Thunder Spine. Choosing what to do next.'
     | 'Just walked away from the line at X. Choosing what to do now.'
     | 'Just gave up waiting at X. Choosing what to do now.'
     | 'Just reached X. The line is long, about 45 min: more than they will put up with.'
     | 'Has waited about 30 minutes in line at X. About 10 more minutes expected: about the most they will put up with.',
  places: [ { option: 'st_brigid', name, known_for: about, offers: 'er, trauma', cost: 'free',
              distance: 'a short walk',
              line: 'long, about 45 min' | "unknown (can't see it from here)",
              people_ahead: '12 people in line' | 'nobody in line' | undefined,   // only when the line is visible
              line_vs_patience: 'more than they will put up with' | undefined,
              recently: 'several people just walked away' | undefined } ],
             // only valid candidates (unvisited, matching needs), plus the current place for line/long
  heard: [ "Priya Shah (group chat, about 15 minutes ago): long line at St. Brigid's ER" ]   // ≤ 4, newest first
}
```

- **Visibility:** the agent sees a place's line if it has the app (`informed`), or if the place is within 30 map units of where the agent is now, or if it's the current place.
- **Heard remarks:** remarks from the last 90 sim minutes, ≤ 4, newest first. A remark is heard if it comes from the same archetype (source label `"group chat"`), or is about a place within 30 units of the agent (`"overheard nearby"`), or the agent is informed (`"app reviews"`). The agent never hears its own remarks.
- **Remark text by kind:** `long_line` → "long line at X", `bad_service` → "bad experience at X", `good_experience` → "X was good and quick", `heavy_traffic` → "heavy traffic on X", `clear_roads` → "X was clear".

Route observation:
```js
{
  setting, time, person: { ...same, has_live_traffic: informed },
  trip: 'Maple Heights to Downtown',
  routes: [ { option: 'r0', via: 'I-9 → Kessel Bridge', usual_time: 'about 20 minutes',
              right_now: 'about 35 minutes (heavy traffic)' | 'unknown (no live traffic)' } ],
  heard: [ ... ]      // route remarks from the last 30 sim minutes, ≤ 4, everyone hears them (source "traffic radio")
}
```
`right_now` adds `(heavy traffic)` when now > 1.3 × usual, or `(light traffic)` when ≤ 1.05 ×.

Arrive observation: `{ setting, time, person, trip, took: route label, time_taken: 'about 40 minutes, about 15 minutes more than on empty roads', worst_stretch: edge name }`.

---

## 6. Providers

Every provider implements:
```js
{
  name: 'jev' | 'rules' | 'replay',
  external: boolean,                     // false only for the inline rules provider
  async decideMany(requests, ctx) => Decision[],   // same length and order as requests; ctx = { seed, spec }
  stats() => ProviderStats
}
```

**RulesProvider** (`external: false` by default). With `{ external: true }` it answers `{ provider: 'rules', action: req.auto.action }` and is used to test the protocol and to count requests (`swarm estimate`).

**JevProvider** `new JevProvider({ apiKey, model = 'jev-latest', concurrency = 32, maxRequests = 20000, fetch = globalThis.fetch, baseUrl = 'https://api.typesafe.ai', timeoutMs = 15000, cache = new Map() })`:

- Builds one request per `DecisionRequest`: `{ model, state: req.observation, questions }`. Each question's `instructions` names the state field it uses, with backticks, as the docs recommend.
  - `next_place` (choice): "Where does the person in `person` go next, given `now`, `places` and `heard`?" Criteria: each option key → its label. Visit options are place ids plus `leave`.
  - `route` (choice): "Which route in `routes` does the person in `person` take for `trip`?" Criteria: `r0..rN` → "Take the route via …".
  - `join` (noul): "Does the person in `person` join the line described in `now`?" Criteria `{ true: 'They get in line and wait.', false: 'They skip this line and go somewhere else or leave.' }`.
  - `keep_waiting` (noul): "Does the person in `person` keep waiting in the line described in `now`?" Criteria `{ true: 'They stay in line.', false: 'They give up on this line.' }`.
  - `frustration` (score): "How frustrated is the person in `person` right now, given `so_far` and `now`?" Five levels: "Calm and content", "Mildly annoyed", "Frustrated", "Very frustrated", "Furious".
  - `tell_others` (noul): "Would the person in `person` tell friends, family or a group chat about their experience at {place or stretch name}?"
  - `remark_kind` (choice): `req.remarkKinds` key → label.
- **Option order:** Jev leans toward whichever option comes first. Shuffle the criteria key order of every choice with `seedRng(hash of JSON.stringify(req.observation), questionName)`. The order is deterministic per state, so the cache still works.
- `requestHash` = sha256 hex of the exact JSON body. **Cache:** a hit on `requestHash` returns the cached answers with `provider: 'jev-cache'`. It makes no API call and still samples independently per agent.
- **HTTP:** `POST {baseUrl}/v1/systemone` with headers `Authorization: Bearer <key>` and `Content-Type: application/json`, and an AbortController timeout.
  - **Retry** on 429, 529, 5xx, network errors and timeouts: up to 5 attempts, exponential backoff from 250 ms with jitter, capped at 8 s, honoring `retry-after` in seconds.
  - **401** throws `JevAuthError`, which aborts the run.
  - **400/422** and exhausted retries: return `rules-fallback` with `action: req.auto.action` and `error` set. The first such error message is kept in stats.
- **Parsing:** `choiceProbs` from `answers.<choice>.probabilities` (keys must be option keys; ignore extras); `yesProb` from `answers.<yesNo>.noul`; `frustration.expected` from `answers.frustration.score` and `probs` from `.probabilities`; `tellProb` from `answers.tell_others.noul`; `remarkProbs` from `answers.remark_kind.probabilities`. `model` comes from the response.
- **Budget:** once `maxRequests` API calls have been made (cache hits don't count), the remaining decisions get `rules-fallback` with `error: 'max-requests reached'`.
- `stats()`:
  ```js
  { provider: 'jev', model, requests, cacheHits, fallbacks, errors, firstError, inputTokens, outputTokens,
    latency: { p50, p95, max }, estCostUSD, priceNote: '$0.042 per million input tokens (TypeSafe published price, unverified)' }
  ```
  `estCostUSD = inputTokens * 0.042 / 1e6`.

**ReplayProvider** `new ReplayProvider({ runDir })` loads `decisions.jsonl`. It answers each request by `requestHash` if the provider can compute the same body (reuse JevProvider's request builder), otherwise by request `id`. It returns the recorded Decision with `provider: 'replay'`. If neither matches, it falls back to rules and counts a miss.

`makeProvider(name, opts)`: `'rules'` → inline RulesProvider; `'rules-external'`; `'jev'` → JevProvider (throws a clear error if `TYPESAFE_API_KEY` is missing); `'replay'` → ReplayProvider (needs `opts.runDir`).

---

## 7. Runner, recorder, run files

```js
runSwarm({ spec, seed = 7, provider, recorder = null, simOpts = {}, onProgress = null, signal = null })
  → Promise<{ metrics, providerStats, runDir | null, runId | null, sim }>
```
Loop: `while (!sim.done) { sim.step(); const reqs = sim.pending(); if (reqs.length) { const ds = await provider.decideMany(reqs, ctx); for (i) { const applied = sim.resolve(reqs[i].id, ds[i]); recorder?.decision(reqs[i], ds[i], applied); } } }`. After the loop, resolve any remaining pending requests the same way. `onProgress({ t, duration, decisions, providerStats })` is called at most every 250 ms wall time.

For an inline provider (`external: false`), `runSwarm` just steps to the end with no requests.

`runSeeds({ spec, seeds: [..], provider, ... })` → `{ runs: [...], summary }`. The summary gives the mean and standard deviation of the headline KPIs and the bottleneck ranking frequency (how often each place is #1). `compareRuns({ spec, patch, seeds, provider })` → `{ applied, skipped, before, after, delta, runs: { before, after }, offers }`, where each side's KPIs are averaged over the same seeds. `runs` keeps each seed's run entry (with its metrics) on both sides, in seed order, so effects can be paired seed by seed; `offers` are the offers the patch added, as the engine normalized them (§15d).

**Headline KPIs:**
- visit: `abandonRate`, `avgWait`, `served`, `abandoned`, `spawned`, top-3 bottlenecks by score.
- route: `avgTrip`, `avgDelay`, `arrived`, top-3 edges by delay minutes.

**Recorder:** `createRecorder({ root = 'runs', spec, seed, providerName, label, link })` (`link` is written to `meta.json` as given, `null` when absent; §9b) creates `runs/<runId>/` with `runId = <slug(title)>-<provider>-s<seed>-<YYYYMMDD-HHMMSS>`.
- `rec.decision(req, decision, applied)` appends one JSON line to `decisions.jsonl`: `{ id, t, clock, agentId, personaId, kind, why, placeId, options, asks, observation, auto, decision, applied }`. The `decision` field omits nothing except `answers` when `provider === 'rules'`.
- `rec.finish({ sim, metrics, providerStats, status: 'done' | 'error', error })` writes:
  - `meta.json`: `{ runId, createdAt, status, error, title, question, mode, duration, clockStart, seed, specHash, provider, model, decisions, agents, providerStats, simOpts }`
  - `spec.json`: the normalized spec
  - `metrics.json`: `sim.metrics()`
  - `frames.json`: see below
  - `agents.json`: `[{ id, personaId, personaName, archetypeId, informed, served, waitTotal, abandons, frustration, born, done, trace: [{t, m}] }]`. Visit agents also carry `spent` (total dollars paid, after offers, rounded to cents) and `visits` (ids of the places that served them, in order), after `trace` (§15a).
  - `remarks.json`: `sim.remarks`

`loadRun(dir)` reads them back. `listRuns(root)` returns metas, newest first.

**Frames** (`sim.frames`, captured every `frameEvery` sim minutes; default 3 s (`0.05`) in a world with walls, otherwise `max(0.5, duration / 360)`; CLI `--frame-seconds S`). When `frameEvery` is shorter than the tick, frames are also captured between ticks: walkers are placed along their wall-free path at that moment, everyone else keeps their state from the tick, and door counts include the crossings already reached. The simulation itself does not depend on `frameEvery`. Reason: a display that draws dots in straight lines between frames 30 s apart sends them through walls; at 3 s none of the straight steps crosses a wall (checked on the real building).
```js
{
  mode: 'visit' | 'route',
  nodes: [ { id, name, kind, x, y } ],          // all nodes, in spec order
  edges: [ { id: 'from>to', name, from, to } ], // route only
  services: [ 'nodeId', ... ],                  // visit: order of the q arrays
  list: [ { t, a: [id, x10, y10, s, ...], q: [queueLen per service] | null, load: [round(ratio*100) per edge] | null,
            c: { active, served, abandoned, arrived } } ]
}
```
- `x10`/`y10` = `Math.round(x * 10)` in map units 0–100. Route agents are interpolated along their current link.
- State codes `s`: 0 walk, 1 queue, 2 serve, 3 think, 4 leave, 5 drive. Done agents are omitted. Queued and serving agents are recorded at their service node's position; the map lays out the queue itself.
- Counters `c`: `arrived` is agents spawned (visit) or trips completed (route); `abandoned` is walk-aways (visit) or lost agents (route).
- `sim.remarks` is in nondecreasing `t` order (a remark's `t` is its request's `t`); the viewer and `selectHeard` rely on this.
- **Extensions for spatial worlds (§9b), all optional:** `frames.stride` is the length of each agent record in `a` (default 4; 5 for multi-floor worlds, where the record is `[id, x10, y10, s, floor]`). `list[].h` is the array of occupied stall indices for held parking. Interior and lot worlds capture frames at least every 5 s of simulated time (`frameEvery` ≤ 1/12 min), because dots interpolated over longer gaps cut through walls; the engine defaults to 3 s for any world with walls (see **Frames** above).

`sim.metrics()` keeps the prototype's shape, and adds:
- `remarks: { total, byKind }`
- `decisions: { total, byProvider: {...}, byKind: {...} }`
- `frustration: { avg, byArchetype }`
- `segments: { byGroup, byCast }` and `offers: [{ id, reached, wentToPlace }]` (§15a, §15b)

`minds` is removed.

---

## 8. CLI (`bin/swarm.js`)

Calls `loadEnv()` first. The world argument is a path to JSON or an example name (`theme-park`, `er-network`, `rush-hour-roads`, resolved from `worlds/`). Commands print compact human-readable text by default and JSON with `--json`.

```
swarm validate <world>
swarm estimate <world> [--seed 7]                    # rules-external run: counts decision requests → est. Jev requests, tokens (~900/request), cost
swarm run <world> [--provider jev|rules|replay] [--seed 7] [--seeds N] [--model jev-latest] [--concurrency 32]
                  [--max-requests 20000] [--batch-window M] [--patch patch.json] [--from <runDir>] [--out runs] [--no-record]
swarm compare <world> --patch patch.json [--provider rules|jev] [--seeds N]   # also: offer reach, who it helped, where the audience went (§15d)
swarm report <runDir|runId>                          # markdown digest for Claude: KPIs, bottlenecks, remarks, per-archetype outcomes,
                                                     #   torn decisions (top-2 choice probs within 0.15), provider stats
swarm agent <runDir|runId> <agentId>                 # one agent's persona, decisions with probabilities, trace
swarm runs                                           # list recorded runs
swarm compile "<description>" [--out worlds/<slug>.json]   # needs ANTHROPIC_API_KEY; without it, prints how to use /swarm in Claude Code
swarm advise <world> [--question "…"] [--seeds 3] [--seed 7] [--provider rules|jev] [--confirm-with jev] [--max-experiments 6]
                     [--model claude-fable-5-2] [--follow-up "…" --from advice.json] [--out runs] [--json]
                                                     # §15c; needs ANTHROPIC_API_KEY, otherwise exits 1 and explains /advise
swarm serve [--port 4173]
swarm sanity [--model jev-latest]                    # live Jev checks (validation/jev-sanity.js)
```

`--seeds N` runs seeds `seed .. seed+N-1` and prints the mean ± standard deviation and the bottleneck frequency. A `jev` run prints the provider stats line: requests, cache hits, fallback rate, tokens, est. cost (unverified), p50/p95 latency, and model id. **A run whose fallback rate is over 20% prints a warning that it does not count as a Jev run** (spec rule 9).

---

## 9. Server and viewer

`startServer({ port = 4173, host = '127.0.0.1', root = process.cwd() })` uses `node:http`. Static files come from `web/`. JSON API:

```
GET  /api/worlds                      → [{ file, title, mode, question, agents: arrivals.total, cast: minds.length }]
GET  /api/worlds/:file                → raw world JSON
POST /api/validate     { spec }       → validateWorld result
POST /api/runs         { world?: file, spec?: object, seed?, provider: 'rules'|'jev', model?, maxRequests?, batchWindow?, link? }
                                      → { runId }   (starts in background; one jev run at a time → 409 if busy)
                                      `link` (optional, §9b) marks the run as one side of a test; a bad link → 400
GET  /api/runs                        → listRuns
GET  /api/runs/:id/status             → { state: 'running'|'done'|'error', t, duration, decisions, providerStats, error }
GET  /api/runs/:id/meta|spec|metrics|frames|agents|remarks
GET  /api/runs/:id/decisions           → decisions.jsonl as one JSON array (for the scope display)
GET  /api/runs/:id/incidents           → incidents.json if the run has one, else 404
GET  /api/runs/:id/agents/:agentId    → { agent, decisions: [...] }   (decisions filtered from decisions.jsonl)
GET  /api/runs/:id/advice             → { advice: <advice.json>, markdown: <advice.md or ''> }; 404 without advice.json, 500 if not JSON (§15c)
POST /api/compile      { description } → validated spec, or 501 { error } when ANTHROPIC_API_KEY is missing
GET  /api/health                      → { ok, jev: hasTypesafeKey, claude: hasAnthropicKey }
```

Reject path traversal in `:file` and `:id` (only `[A-Za-z0-9._-]`). JSON bodies are limited to 2 MB.

**Viewer** (`web/`), plain HTML + canvas + one ES module, no framework:
- **Run bar:** world picker (from `/api/worlds`), "paste world JSON" box with validate, provider toggle (Jev / Rules), seed, Run. Picker of past runs.
- **Progress** for a live run, from polling `status`.
- **Map canvas:**
  - visit: service nodes as circles sized by servers, filled by queue heat; entries/exits as squares; labels.
  - route: edges as lines colored by load.
  - Agents as dots colored by archetype.
  - **Time scrubber** with play/pause, speed (1×, 4×, 16×), and a clock. Positions interpolate between frames.
- **Side panel:** KPI tiles, bottleneck ranking with bars, queue-length (visit) or road-load (route) chart over time with a cursor at the scrubber time.
- **Agent inspector:** click a dot to load `/api/runs/:id/agents/:agentId`. Shows the persona card and each decision with probability bars per option, the sampled action highlighted, a provider badge, the remark if any, and the trace.
- **Remarks stream** in readable sentences, filtered up to the scrubber time.
- **Run stats:** provider, model, requests, cache hits, fallback %, tokens, est. cost (marked unverified), p50/p95 latency.
- Light and dark themes via CSS variables. Styling follows the prototype's look: IBM Plex Sans/Mono and Bricolage Grotesque from Google Fonts, teal accent. Works at 1280 px and down to 390 px.

---

## 9b. Scope display (`web/scope/`)

The owner's view: try one change on simulated customers and see whether it helped. It sits next to the generic viewer and reads the same run files, plus the additions below. It opens on the building. The sushi restaurant (§18) is the one other place: `?case=sushi`, or "Other places" in Run details. The parking-lot mock still exists (`mockgen/`), but the display does not offer it (v0.27).

**What opens.** No case picker. The page opens the latest Jev run if one exists, otherwise the latest rule-model run, paused at the start (`chooseRun` in `web/scope/lib/verdict.js`). A run that carries a tested change never opens first; its baseline does. Without the engine server, the page shows the building sample data and says a change cannot be tested on it. URL parameters: `case=sushi`, `run=<run id>`, `t`, `floor`, `theme=dark`, `autoplay=1`, and `test=new` (ignore earlier tests, so the "before a test" state shows again). At the sushi restaurant only runs of the room as sketched with no offers can open first, and its packed Jev run (`web/scope/mock/sushi-restaurant.json`) counts as a recorded Jev run (§18).

**RunBundle.** The display loads `{ meta, spec, geometry, frames, metrics, agents, remarks, decisions }`. Mock runs (`web/scope/mock/*.json`, `web/scope/data/*.json`) are written in this shape by `scripts/mock_runs.js`. For a recorded run, `geometry` comes from `spec.geometry` and `decisions` from the endpoint below.

**Engine runs** (`web/scope/lib/engine.js`). The engine keeps walls, doors and scale in `frames.walls`, `frames.doors` and `spec.geo`, and drops unknown spec fields, so the display builds the geometry from those: one floor, walls as drawn, doors as openings (exterior or interior), the view fitted to the walls and places, and a floor fill flooded from the service points with exterior doors closed (no fill if the walls leak). Gates become entries. Objects (`spec.objects`, §13f) are drawn as hatched shapes with a thin outline, not as thick walls: their edges are matched in `frames.walls` at the frames' 0.01 precision and the shapes are rasterized into the floor's `obstacles` grid. The cast's `bio`, `goal` and `social` are read as `about`, `wants` and `listens_to`. A run with no decision records (the inline rules provider) gets its walk-aways from agent traces ("Saw N people in line at X … and walked away", "Gave up on X after M min in line").

**The verdict (v0.27).** The top of the side panel answers "did the change help?". Pure functions are in `web/scope/lib/verdict.js`; `verdict-panel.js` draws them. There is no dialog.
- **The one change** is a fixed rule, not AI: `staffChange(spec, metrics)` picks the service node with the highest `metrics.nodes[].score` and proposes `servers + 1` there. The display calls this "+1 staff". The engine's field is still `servers`. At the sushi restaurant the one change is a promotion instead (§18).
- **Before a test:** `worstLineWords` names the worst line ("Lucky Noodle Bar loses the most people: 56 walked away over lunch.") and the reason (staff at the counter, minutes per order, longest line). One button: "Test +1 staff here". The counter is ringed on the map.
- **The test:** the display posts 6 runs to `POST /api/runs`, one after another: the baseline world and the changed world (`applyChange`), each on 3 seeds (the seed of the run on screen, +1 and +2), always with `provider: 'rules'`. A progress line and a Cancel button show while it runs.
- **After:** `testResult` takes the 6 runs' metrics. `verdictWords` gives the verdict in customers kept, which is fewer walk-aways at that counter, as a range across seeds ("+1 staff kept 20 to 22 more customers."), and says "Tested with the rule model". A table shows before, after and change for walk-aways, longest line and average wait at the counter and walk-aways on the whole floor (averages of the 3 runs; the change is taken from the rounded numbers shown). `whySentence` gives one sentence of cause from the two sides, and `busiestWindow` adds when the line is busiest.
- **The toggle** "Baseline / +1 staff" switches the map between the two runs of one seed and keeps the slider time. If the run on screen is a Jev run, it stays on screen until a side is picked, and a note says so.
- **Run link.** Each test run carries `link` in its `meta.json`, set through `POST /api/runs`:
  ```js
  { test: '<id shared by the 6 runs>', role: 'baseline' | 'change',
    base: '<run id of the baseline with the same seed>' | null,        // only on the change
    change: { kind: 'staff', nodeId, nodeName, from, to }              // +1 staff at the worst line
          | { kind: 'promotion', off } }                               // the sushi restaurant's promotion (§18)
  ```
  The server checks it: `test` is 1 to 64 letters, digits, dashes or underscores; `base` names an existing run. For staff, `nodeId` is a service node of the posted world; `from` and `to` are different whole numbers; the world's `servers` at that node equals `from` for a baseline and `to` for a change (a link with no `kind` is a staff link). For a promotion, `off` is a share between 0 and 1, and the posted world has the offer with id `promotion` for a change and no such offer for a baseline. It reads `nodeName` from the world. A bad link is refused with 400 and no run starts. `findTest(metas, { runId, specHash })` finds the newest test with 3 finished pairs that belongs to the run on screen: the run is one of its runs, or the test's baselines have the same `specHash`. So every browser shows "Baseline" and "+1 staff at <counter>". Nothing about tests is kept in `localStorage`.
- The display does not call `GET /api/runs/:id/advice` or `POST /api/insights`; both endpoints remain.

**Layout and wording (v0.27).**
- **Top bar:** brand, prompt box, theme toggle. There is no language button (it was removed from this display on Nov 14; §19). The prompt does not change the simulation yet. Its card says so, shows the typed question above the map, and offers a new run of the same world (rule model, or Jev when the server has a key).
- **Map strip:** a name people would say for the place (`placeName`: the part of the world's title after the colon, without brackets; not the listing name), the question, the run's side of a test and who decided ("Baseline · Rule model", "Jev"), and Run details.
- **Side panel, top to bottom:** verdict, four live counters ("Visits served" counts counter visits, so it can be higher than the number of people), bottleneck ranking (top 3), incident feed. Ranking rows and feed rows are buttons. A ranking bar has two parts: minutes waited, and in red the people who walked away (30 minutes each); the longest bar is the current worst place. The feed merges repeats (`groupFeed` in `incidents.js`: "Walked away at Lucky Noodle Bar ×14"); a row opens its most recent incident.
- **A selected person** opens in place of the ranking and feed, with "Back to bottlenecks". The verdict and counters stay.
- **Map:** one "View" menu (color people by; show trouble, people, counter names). "Reset view" shows only after zooming or panning. Counter names are drawn above the people; doors and stairs are faint dots that show a name on hover; rooms have no labels. Coloring by frustration is disabled, with the reason, when the run has no frustration data.
- **Keyboard:** every control is reachable with Tab. On the map, Enter picks the person nearest the middle, the arrow keys move to the nearest person in that direction, Enter opens them and Escape lets go.
- **Timeline:** the incident histogram has clock ticks every 15, 30 or 60 minutes (`timeTicks`).
- **Run details:** the drawer holds everything technical (run id, seed, Jev requests, cost), where the data came from, the legend, the keys, the other places the display opens ("Other places": the sushi restaurant from the building, and the building from the restaurant), and the list of other recorded runs, which can be opened from there. A run of a changed room is listed as "Changed room, N seats".
- **Words:** "staff", "rule model", "Jev". No "server", "seed" or "Jev requests", and no shell commands, outside Run details.
- **Color and type:** red means people lost and nothing else (walk-away glyphs, the lost part of a ranking bar). IBM Plex Sans on five sizes (12, 13, 15, 18, 22 px); Bricolage Grotesque only for the wordmark.

**Serving.** `node bin/swarm.js serve` serves the display at `/scope/`. When it answers `/api/health`, the display lists the server's recorded building runs (visit mode with walls). An optional run file that is missing (a run's `incidents`) answers 404; the display drops the unread body so the network goes idle.

**Geometry** (`spec.geometry`, written by the world builder or `scripts/extract_building.js`). Coordinates are map units: the longer side of the plan spans 0–100, so the distance words in §5 still apply. `metersPerUnit` gives real scale.
```js
{ kind: 'interior' | 'lot', source: { provider: 'matterport' | 'synthetic', modelId? }, metersPerUnit,
  floors: [{ id, label, sequence, bounds: [x0, y0, x1, y1], transform: { scale, ox, oy } /* map → Matterport metres */,
    rooms: [{ id, kind, poly: [[x, y], ...], holes: [[[x, y], ...]], area }],
    walls: [[x1, y1, x2, y2, thickness]],
    openings: [{ id, x, y, angle, width, type, exterior, rooms }],
    obstacles: { cell, w, h, origin: [x, y], rle } | null,   // mesh sliced at walking height; agents cannot enter
    pois: [{ id, name, kind: 'entry' | 'exit' | 'service' | 'stairs', x, y, provenance }] }],
  lot: { stalls: [{ id, x, y, w, h, angle }], aisles, driveways, storefront, crosswalks, image: null } | undefined,
  sweeps: [{ id, floor, x, y }] | undefined,                  // Matterport scan points, for the 3D tour
  provenance: { [field]: 'data' | 'vision' | 'assumed' | 'owner-reported' } }
```

**Server additions needed for recorded runs:**
- `GET /api/runs/:id/decisions` → `decisions.jsonl` as a JSON array. The display derives incidents from it.
- `GET /api/runs/:id/incidents` (optional) → `incidents.json` if the recorder writes one. When present, the display uses it instead of deriving incidents.
- The CSP on HTML pages must allow the Matterport tour for `web/scope/`: `frame-src https://my.matterport.com; script-src 'self' https://static.matterport.com`.

**Incidents** `{ id, t, cat: 'decision' | 'congestion' | 'complaint', kind, x, y, floor, placeId, agentId, severity, text }`, derived in `web/scope/lib/incidents.js`:
- Decisions: a `line` answered no ("walked away from the line"), a `long` answered no ("gave up waiting"), leaving after either ("left without being served"), and in the lot giving up the search ("drove off without parking").
- Turned away: a `line` decision with `why: 'door'` answered no ("saw the line and left"). The person judged the line from the entrance. Observations for these decisions list `people_ahead` for each place.
- Complaints: remarks of kind `long_line`, `bad_service` and `heavy_traffic`.
- Congestion, from frames: more people within 1.5 m of an opening than 2.5 × its width in metres; more than 2 people/m² in a room; more than 6 cars queued at a driveway. A condition must hold for 2 frames, and each episode is one incident.

**Keys.** The Matterport SDK key is the one key the browser sees. It is a public key locked to the registered domain by design, written to the gitignored `web/scope/data/config.json`. No other key reaches the browser.

**Screens.** A 13-inch laptop, Chrome full screen, about 1280×832 and up. Light theme by default; dark is a toggle. No mobile layout. This overrides the 390 px target in §9 for this display only.

## 10. Compile, schema, slash command, MCP

- `worlds/SCHEMA.md`: the world format for humans and Claude. Every field with type, range and default, both modes, how to write a good cast (10–20 people with concrete situations, constraints, loyalties, who they listen to, app or not), how to set patience and `needs`/`tags`, and one compact example per mode. `worlds/schema.json`: the same as JSON Schema (draft 2020-12), used as the Claude tool input schema.
- `compile/compile.js` `compileWorld(description, { apiKey, model, maxAttempts = 3 })` uses `@anthropic-ai/sdk`. It forces a `submit_world` tool call whose `input_schema` is `worlds/schema.json`, then runs `validateWorld` and feeds errors back until it's valid or out of attempts. It returns `{ spec, attempts, warnings }`. Without a key it throws an error whose message explains the `/swarm` path.
- `compile/headless.js` `compileWorldHeadless(description, { model = 'sonnet', maxAttempts = 3 })` writes the world with a headless Claude Code agent and needs no API key, only a Claude Code login.
  - **How.** `claude -p` is given `/goal` with the world file as the goal. The agent has one tool (Write) in an empty temporary folder, with the description, the rules below and `worlds/SCHEMA.md` as its instructions. What it wrote is checked with `validateWorld`; errors go back to a fresh agent with the last world, up to three times. It returns `{ spec, attempts, warnings, builder }`.
  - **It draws a floor plan.** The world must be in visit mode with outer walls, a gap and a `doors` entry for each way in, a gate just outside each gap, rooms and fixtures as `objects`, `geo` with a real scale, seats where people sit, 60 to 200 arrivals, and a cast of 8 to 12 people whose situation and feelings today are written out. A world without walls or doors is sent back.
  - **Where it is used.** `POST /api/compile` uses it when there is no `ANTHROPIC_API_KEY`, or when the body has `plan: true`. `/api/health` reports `compiler` (`"anthropic"`, `"claude-code"` or `null`), and `claude` is true for either. `swarm compile` falls back to it the same way.
  - **The dashboard's prompt box.** Typing at least 12 characters and pressing Simulate offers **Build this place** first. It posts the words with `plan: true`, runs the world that comes back (Jev when the server has a key, otherwise the rule model, seed 7), and opens it at `?place=<title>`. Running the place on screen again is still offered beside it.
  - **Checked once, live (Nov 14):** a laundromat described in three sentences came back valid on the first attempt in 53 seconds (about $0.19): outer walls, a street door, washer and dryer banks, a folding table, a coffee counter and a back room. Jev then made 560 decisions on it in 20 seconds (about 2 cents). Through the dashboard in a browser, a pharmacy typed into the prompt box opened as a place 70 seconds after "Build this place" was pressed (56 seconds of drawing, then the Jev run): a stock room, a prescription counter, a pickup window, a flu shot room with its chair, and a front till. Two builds, not a measure of quality.
- `.claude/commands/swarm.md`: the Claude Code slash command. Given `$ARGUMENTS` (a place and a question), Claude Code:
  1. reads `worlds/SCHEMA.md`;
  2. writes `worlds/<slug>.json`;
  3. runs `swarm validate` and fixes errors;
  4. runs `swarm estimate` and asks before spending if est. cost > $1;
  5. runs `swarm run --provider jev`;
  6. reads `swarm report`;
  7. writes findings (rankings, not forecasts);
  8. proposes 1–3 patches and tests them with `swarm compare` on the same seeds.

  This is the keyless "any environment" path.
- `mcp/server.js` uses `@modelcontextprotocol/sdk` over stdio. Tools: `list_worlds`, `validate_world { spec }`, `estimate { world|spec }`, `run_swarm { world|spec, provider, seed, seeds }`, `compare { world|spec, patch, provider, seeds }`, `report { runId }`, `agent_log { runId, agentId }`, `list_runs`. Plus `.mcp.json` at the repo root registering it as `swarmscope`.

---

## 11. Validation and tests (added back after the base build; new modules ship with tests)

- **Unit tests per module** run with `npm test` (no network): util, spec/validate, sample, sim determinism (same seed → identical metrics; external mode with `rules-external` gives the same people and arrival times as inline), providers with a mocked `fetch` (body shape, criteria = options, shuffle determinism, cache, retry on 429 then success, fallback after 5×500, 401 aborts, budget), recorder round trip, replay (identical metrics with zero fetch calls), CLI smoke (`validate`, `run --provider rules`, `report`), server smoke (random port: worlds, start rules run, poll to done, frames).
- `validation/erlang.js`: M/M/1 (λ = 0.5/min, μ = 1/min → Wq = 1 min) and M/M/3 Erlang C, with Poisson arrivals, `serviceDist: 'exp'`, one visit, huge patience, small `dt`, averaged over seeds. Prints simulated vs formula, and passes within 15%. Also run as a test with fewer seeds and a 25% tolerance.
- `validation/braess.js`: route world with linear-cost legs, informed drivers, with vs without a zero-length shortcut. Prints average trips. The sim is dynamic, not a static equilibrium, so report honestly whether the paradox appears. No hard assertion.
- `validation/jev-sanity.js` (live, opt-in) runs two checks:
  - Join probability across a ladder of waits (5, 15, 30, 45, 60, 90 min) for two personas. It should fall as the wait grows.
  - Option-order consistency: the same choice with options reversed.

  Prints a table plus pass/fail.

---

## 12. Internal interfaces for the parallel build (Nov 14)

**Decision (Nov 14):** no new tests in the v0.2 build. The existing provider tests stay. Section 11 is deferred. The engine and viewer are split across parallel builders, so these internal interfaces are binding.

### 12a. `engine/observe.js` (pure functions; the Sim gathers the inputs)

```js
remarkText(remark, names)            // names = { place: Map id→name, edge: Map id→name }; text by kind per §5
selectHeard(remarks, viewer, names)  // → string[] (≤ 4, newest first), per the §5 rules
  // viewer = { mode, t, agentId, archetypeId, informed, x, y, placePos: Map nodeId→{x,y} }
  // each string: "<personName> (<source>, <durationWords(minutes ago)> ago): <remarkText>"
visitObservation(ctx)  // → the §5 visit object
  // ctx = { spec, t,
  //   person: { name, age, bio, personality, goal, social, groupName, informed },
  //   frustration: number|null, timeHere: min, timeInLines: min, placesDone: string[],
  //   moment: { kind: 'choose'|'line'|'long', why, placeName, est, tolerance, waited, remaining },
  //   places: [{ id, name, about, tags: string[], price, dist, est, visible: boolean, walkedAway30: number }],
  //   heard: string[] }
routeObservation(ctx)   // ctx = { spec, t, person, trip: { fromName, toName }, routes: [{ key, label, ff, now|null }], heard }
arriveObservation(ctx)  // ctx = { spec, t, person, trip: { fromName, toName }, took, tripMin, ffMin, worstEdgeName }
```
`places` is passed in node order. Observe turns every number into words (§5), and omits `line_vs_patience` and `recently` when they don't apply. `visible: false` gives `line: "unknown (can't see it from here)"`.

### 12b. Viewer modules

- `web/map.js`:
  - `createMap(canvas, { onAgentClick })` → `{ setRun(run), render(t), resize(), destroy() }`
    - `run = { spec, frames, archetypeOf: Map agentId→archetypeId, colors: Map archetypeId→cssColor }`.
    - `render(t)` binary-searches `frames.list`, interpolates agent positions between the two frames around `t` (agents present in only one frame are drawn at that frame's position), then draws edges (route: color by load) or service nodes (visit: radius by servers, fill by queue heat, label), entries/exits as squares, then agents.
    - Handles `devicePixelRatio`, and reads theme colors from CSS variables (`--heat0..2`, `--a1..a6`, `--ink`, `--muted`, `--line`, `--panel-2`) via `getComputedStyle(document.documentElement)` on each render.
    - A click picks the nearest agent dot within 8 CSS px at the last rendered `t` and calls `onAgentClick(agentId)`.
  - Also exports `archetypeColors(spec)` → `Map` (cycles `--a1..--a6`).
- `web/chart.js`: `createChart(canvas)` → `{ setSeries({ t: number[], series: [{ name, color, values: number[] }], yLabel }), render(cursorT), resize() }`. Line chart with axes, the top 6 series by peak, and a vertical cursor at `cursorT`. Handles `devicePixelRatio` and theme variables.
- `web/app.js`: everything else in §9. It imports both modules and owns `web/index.html` and `web/style.css`. It builds chart series from `frames.list[].q` (visit, per `frames.services`) or `frames.list[].load` (route, per `frames.edges`).

---

## 13. Walls (hard rule: nobody passes through a wall)

**Decision (Nov 14):** interior walls are part of the world, and the engine guarantees that no agent's movement crosses one. Jev never gets the chance to break this: it only picks among options the engine offers, and the engine moves agents along wall-free paths.

**Where walls come from.** The engine takes plain segments and doesn't care about the source. Two builders produce them from Matterport data:
- **Vector data** (preferred): Matterport Property Intelligence room boundaries. Each boundary edge has `type: wall` (physical) or `invisible` (not a wall), two vertices, and `openings` (`doorway` or `opening`, with `width` and `relativeCenter` along the edge).
- **Mesh slice** (fallback when a model has no vector data): the model's OBJ mesh cut by horizontal planes at about chest height.

### 13a. Spec fields

| Field | Meaning |
|---|---|
| `walls` | Optional array, ≤ 4000 segments. Each is `{ x1, y1, x2, y2 }` in map units (0–100, the same space as nodes); `[x1, y1, x2, y2]` is also accepted as input. A doorway or opening is a gap: the wall is given as the pieces on either side. Optional per-wall `source`: `"matterport-vector"`, `"mesh-slice"` or `"drawn"`. |
| `geo` | Optional `{ metersPerUnit, clearance, floor, source }`. `clearance` (map units, 0.02–1, default 0.2) is how far paths stay from wall ends. Builders set it to at most a quarter of the narrowest door. The rest is informational in v0.2: `travelSpeed` stays in map units per minute, and builders derive it from `metersPerUnit`. |
| `objects` | Optional array, ≤ 400. Solid things inside the building: `{ id, name, kind, source, polygon, areaM2?, sizeM?, about? }`, with `polygon` 3–64 points as `[x, y]` or `{ x, y }` in map units (it closes by itself). The engine adds every outline edge to `walls`, so walls plus outline edges count toward the 4000 limit. See §13f. |
| `edges[].via` | Route mode, optional array of ≤ 12 `{ x, y }` waypoints. The edge's shape is the polyline from → via… → to. |
| `provenance` | Optional object (≤ 300 keys) mapping a field path to `data`, `vision`, `assumed` or `owner-reported`. Kept as-is. |

Rules checked by `validateWorld` (all are errors unless noted):
- Every node is at least 0.05 units from every wall.
- Route mode: no edge polyline touches a wall. The message names the edge and the wall index.
- Visit mode: every service node is reachable on foot from at least one entry, and at least one exit is reachable from every service node.
- More than 4000 walls is an error. Zero-length walls are dropped and out-of-range coordinates are clamped, each with a warning.
- No node may sit inside an object; the message names the object. An object outline with fewer than 3 points or no area is dropped with a warning. Messages about an object edge name the object (`objects[i] ("name")`), not a wall index.

### 13b. `engine/walls.js`

A pure ES module with no Node imports, so the browser viewer loads the same file.

```js
normalizeWalls(raw)                    // → { walls: [{ x1, y1, x2, y2, source? }], warnings: string[] }
crossesWall(walls, x1, y1, x2, y2)     // → index of the first wall the segment touches, or -1
polylineCrossesWall(walls, points)     // → { wall, piece } | null
polylineLength(points)                 // points = [{ x, y }, …]
pointAlong(points, d)                  // → { x, y } at distance d along the polyline (d clamped to [0, length])
createNav(walls, { clearance = 0.2 })  // → nav
nav.blocked(x1, y1, x2, y2)            // → boolean: the straight segment touches a wall
nav.path(x1, y1, x2, y2)               // → { length, points } | null when unreachable; points[0] is the start, the last is the end
nav.distance(x1, y1, x2, y2)           // → walking distance, or Infinity
```

- **Touching counts as crossing.** A segment that shares any point with a wall is blocked (epsilon 1e-9), including wall endpoints and corners where two walls meet.
- **Guarantee.** `nav.path` checks its own result with `polylineCrossesWall` before returning and throws if a piece touches a wall. A through-wall path is an engine bug and is never returned.
- **Resolution independent.** It finds the way through any gap at least 2.5 × clearance wide. A visibility graph over points offset around wall ends does this; a fixed grid does not.
- **Shortest.** A straight line when clear; otherwise within 2% of the shortest wall-free path.
- **Deterministic**, with results cached by endpoints rounded to 1e-3.
- **Performance budget** with 500 walls: `createNav` under 500 ms, and 1,000 uncached `path` calls under 2 s.

### 13c. Engine behavior

- **Visit mode.** Walking follows `nav.path`. Travel time is path length ÷ `travelSpeed` + 0.5, and the agent's position at any time is `pointAlong` its path. Walking distance replaces straight-line distance everywhere: rule utilities, the observation's `distance` words, the 30-unit line-visibility radius and the 30-unit overheard-remark radius. A place with no path from where the agent stands is not a candidate, so it is never offered to any provider.
- **Route mode.** An edge's shape is its polyline. Its default `length` (when the world gives none) is polyline length ÷ 2. Agents on a link are positioned along the polyline.
- **Fail loudly.** The Sim checks every movement piece it creates with `crossesWall` and throws `WallViolation` if one touches a wall. `metrics().walls = { count, checkedMoves, violations }`, and `violations` is always 0 in a completed run.
- **Frames.** `frames.walls = [[x1, y1, x2, y2], …]` (2 decimals) and, in route mode, `frames.edges[].via`.
- With no `walls`, behavior is unchanged from §3–§7.

### 13d. Viewer and server

- The server serves `engine/walls.js` at `/walls.js`.
- The map draws walls as solid lines and route edges as their polylines.
- Between two frames, an agent whose straight-line interpolation would touch a wall is moved along `nav.path` between the two positions instead. If there is no path, it holds the earlier position until the later frame.

### 13e. Builders

`builder/matterport.js`:
```js
VECTOR_QUERY                                   // GraphQL query for floors, rooms, boundary edges, openings, holes
fetchModelGeometry({ modelId, tokenId, tokenSecret, endpoint, fetch })   // → raw GraphQL data
extractFloorplan(raw, { floor })               // floor: id, sequence or label; default is the floor with the most rooms
  // → { units: 'm', floor, rooms: [{ id, label, classification, polygon, centroid, area }],
  //     walls: [{ x1, y1, x2, y2, edgeId, roomIds }],                  // model coordinates, openings cut out, shared edges deduped
  //     doors: [{ x, y, width, type, edgeId, roomIds: [a, b | null] }], // passable openings; null means it leads outside
  //     warnings: string[] }
toMapUnits(plan, { margin = 3 })               // → the same shape in map units, plus { metersPerUnit, transform }
floorplanToWorld(plan, { mode = 'route', title, question })   // → a starter world: nodes, edges (with via) or places, walls, geo, provenance
```
- A `wall` edge becomes wall segments with gaps cut at its `doorway` and `opening` openings. An `invisible` edge becomes no wall. Any other opening type stays solid, with a warning. Walls in `holes` (columns, sub-rooms) are kept.
- Keys: `MATTERPORT_API_KEY` (token ID) and `MATTERPORT_API_TOKEN` (token secret), HTTP Basic auth, endpoint `https://api.matterport.com/api/models/graph`.
- Raw model dumps are hackathon data: they go in `data/` (gitignored) and are never committed. The test fixture is hand-made.

`builder/mesh.js`:
```js
parseObj(text)                                 // → { vertices, faces } (triangulated)
meshToWalls(objText, { up, floorHeight, sliceHeights = [1.0, 1.5], minLength = 0.3, mergeTolerance = 0.05 })
  // → { walls: [{ x1, y1, x2, y2 }], bounds, warnings }   // meters, model coordinates
```
- A segment is kept only if it appears at every slice height, which drops most furniture. Collinear pieces are merged and pieces shorter than `minLength` are dropped. Tall furniture can survive as a false wall, which blocks rather than leaks, so the result is labeled `mesh-slice` and should be checked by a person.

CLI: `swarm import-matterport <modelId> [--floor N] [--mode route|visit] [--out worlds/<slug>.json] [--save-raw data/<id>.json]`, `swarm import-matterport --from-raw <file.json> …` (no API call) and `swarm import-mesh <file.obj> [--out …]`.

### 13f. Objects inside the building (from the mesh)

The vector floor plan traces walls, columns and other holes in rooms. The mesh also shows everything else that stands in the way at walking height: stairs, fixtures, counters, stacked material, equipment. Those become the world's `objects` (§13a).

`builder/objects.js` (pure, no Node imports):
```js
meshObjects(mesh, plan, { zMin = 0.3, zMax = 1.5, cell = 0.1, nearWall = 0.5, doorClear = 0.8, minArea = 0.03,
                          simplify = 0.08, maxPoints = 48, up, floorHeight, floorIndex })
  // mesh: OBJ text, bytes or parseObj output; plan: extractFloorplan output (meters)
  // → { objects: [{ id: 'obj1', name: 'Object 1 (3.6 x 2.4 m)', kind: 'object', source: 'mesh-slice',
  //                 polygon: [{ x, y }], areaM2, sizeM, room }],     // largest first, meters, counterclockwise
  //     floorHeight, levels, up, dropped: { specks, areaM2 }, meshCells, warnings }
floorLevels(mesh, { up, inside })   // → [{ height, areaM2 }] lowest first: clusters of upward-facing surface
```
- **Floor height.** Upward-facing horizontal surface under the plan's rooms, binned by height. Only bins with real floor in them are joined (within 0.4 m), so small surfaces at every height cannot chain two floors together. A cluster counts as a floor if it holds at least a quarter of the largest. The plan floor's `sequence` picks the level, lowest first; `floorHeight` overrides it. On 6FNMVoyPrL1 this gives −3.05 m and 2.75 m, matching the scan positions (−3.06 m and 2.71 m).
- **The cut.** Each triangle's part between 0.3 m and 1.5 m above the floor is marked on a 0.1 m grid, from above: edges for upright surfaces, fill for flat ones such as tabletops and stair treads.
- **Dropped:** cells outside every room or inside a void (Matterport's non-area regions) or a hole (already walls); cells within 0.5 m of a floor-plan wall (the wall's own surface, trim, glazing); cells within 0.8 m of a doorway, across its width, because a closed door or a door leaf shows in the scan but people pass there; patches under 0.03 m² (scan noise).
- **Outlines.** Each 8-connected patch of cells is traced along cell edges (holes inside a patch are filled), then simplified (Douglas–Peucker, 0.08 m, loosened until it has at most 48 points). Ids are by size, then position, so the same mesh gives the same ids.
- **In the engine.** `normalizeSpec` adds each outline edge to `walls` with the object's `source`, and keeps `spec.objects` for display and reports. A given wall that is already an object edge is dropped first, so a normalized spec normalizes to the same walls again. Paths, reachability, the run-time crossing check and recorded frames all see the objects as walls.
- **Names.** The mesh does not say what an object is, so objects are named by size. Write a better `name` and `kind` in the world when you know (e.g. `Stair to Floor 2`, `stairs`).

`swarm fitout <fitout.json> … --mesh <file.obj | auto> [--floor-height H]` runs `meshObjects` on the plan before `applyFitout`. `auto` downloads the model's OBJ with the same keys as `--model` (`fetchMeshObj` prefers a whole-model OBJ over a file named `*chunk*`, which is only one piece of a split mesh). The command lists the objects it found.

---

## 14. Building traffic for one real building (focus, Nov 14)

**Target:** Matterport model `6FNMVoyPrL1`, "Office/Retail - 45,726SF". **Question:** where does foot traffic concentrate in this building, where do people end up waiting, and which change helps most?

**Decision:** simulate it in visit mode with walls (§13). People enter through the real exterior doors, walk wall-free paths through the real doorways to tenant spaces, wait in lines where there are lines, and leave. Jev decides where each person goes next, whether they join a line, whether they keep waiting, and whether they tell others. Traffic through the building is measured at the doorways.

```
Matterport vector data ─ extractFloorplan ─ toMapUnits ─► plan (rooms, walls, doors)        builder/matterport.js
CoStar property record ─ costarToProfile ───────────────► profile (tenants, SF, use, …)     builder/profile.js
profile + scenario ───── profileToDemand ───────────────► who comes, how many, when         builder/demand.js
plan + profile ───────── composeBuildingWorld ──────────► world (visit mode, walls, doors)   builder/compose.js
Claude ───────────────── writes the cast for these tenants
world ────────────────── swarm run --provider jev ──────► recorded run ─► viewer
```

Limits of v0.2, stated in every report: one floor per world; doors count traffic but don't yet slow it (no door capacity); tenant-to-room matching is by area unless overridden; every number not read from CoStar or Matterport is tagged `assumed`.

### 14a. Building profile (`builder/profile.js`)

A neutral shape, so the rest of the pipeline doesn't depend on CoStar's field names:

```js
{
  source: 'costar' | 'manual', propertyId, name, address, city, state,
  buildingType, rbaSF, floors, yearBuilt, percentLeased,
  parking: { spaces, ratioPer1000SF } | null,
  trafficCounts: [{ street, vehiclesPerDay }],
  hours: { open: 'HH:MM', close: 'HH:MM' } | null,
  tenants: [{ name, industry, use, sf, floor, suite, employees, hours }],   // use is one of USE_TYPES
  provenance: { '<field path>': 'data' | 'assumed' | 'owner-reported' }
}
```

```js
USE_TYPES = ['office', 'retail', 'restaurant', 'medical', 'service', 'fitness', 'other', 'vacant']
validateProfile(raw)     // → { ok, errors, warnings, profile } (normalized; unknown uses become 'other' with a warning)
costarToProfile(raw)     // → { profile, mapped: string[], unmapped: string[], warnings }
                         //   best-effort: matches common field names case-insensitively and reports what it could not map;
                         //   to be finalized against a real CoStar response
classifyUse(industryOrName)   // → a USE_TYPES value, by keyword
```

### 14b. Demand (`builder/demand.js`)

```js
SCENARIOS            // 'weekday-morning' (07:30, 150 min), 'weekday-lunch' (11:30, 120 min), 'saturday-afternoon' (12:00, 180 min)
DEFAULT_ASSUMPTIONS  // every made-up number in one object, e.g. sfPerOfficeWorker, officeAttendance,
                     //   visitsPer1000SFPerHour by use, share of workers who go out at lunch, dwell minutes by use, patience by group
profileToDemand(profile, { scenario, assumptions })
  // → { clockStart, duration, arrivals,
  //     groups: [{ id, name, description, count, origin: 'outside' | 'tenant', tenantNames, use, visits, patience, info, weights, likes, needs }],
  //     places: { [tenantName]: { servers, serviceTime, appeal, price, tags, about } },
  //     provenance, assumptionsUsed: [{ key, value, why }] }
```
A number read from the profile is tagged `data`; a number from `DEFAULT_ASSUMPTIONS` is tagged `assumed` and listed in `assumptionsUsed`, so the robustness check can nudge it.

### 14c. Composer (`builder/compose.js`)

```js
assignTenantsToRooms(plan, profile, { overrides })
  // → { assignments: [{ roomId, tenantName | null, use, how: 'override' | 'area-match' | 'vertical' | 'common' }], warnings }
composeBuildingWorld({ plan, profile, scenario = 'weekday-lunch', assumptions, overrides, title, question })
  // → { world, report: { floor, rooms, tenants, assignments, doors, warnings, assumptionsUsed } }
```
- `plan` is the map-unit plan from `toMapUnits` (§13e). `overrides` is `{ rooms: { [roomId]: tenantName | 'common' | 'vertical' }, verticalRooms: [roomId] }`.
- Exterior doors become `gate` nodes (people enter and leave there). A tenant space becomes a service place at a point inside its room. A tenant whose workers go out during the scenario also gets a `gate` node in its room, so workers start there. Stairs and elevators (`vertical` rooms) are `gate` nodes that stand for the other floors.
- Tags tie people to places: each tenant place has a tag for that tenant plus its use; public-facing places also have `public`.
- The world carries `walls`, `geo`, `doors` and `provenance`, and a placeholder cast that Claude replaces.
- The result passes `validateWorld`, including the §13a wall rules.

### 14d. Engine additions for buildings

| Addition | Meaning |
|---|---|
| `archetypes[].entries` | Optional list of entry or gate node ids where this group appears. Default: all entries, by weight. A cast member's own `entry` still wins half the time, as before. |
| `doors` (world field) | Optional array, ≤ 500: `{ id, name, x1, y1, x2, y2, exterior }`. Each is the gap segment of a doorway, in map units. Doors are not walls. |
| Door traffic | In visit mode, every walking path is checked against each door's gap when it is created. Each crossing is counted at the time the agent reaches that door. A door's gap is its segment with each end that stops short of a wall (within 0.3 units, or the clearance if larger) carried on to that wall and 0.02 past it, so a path that rounds a jamb inside the builder's pull-in still counts (§14g). |
| `metrics().doors` | `[{ id, name, exterior, crossings, peakPer5Min, peakClock }]`, busiest first. |
| Frames | `frames.doors = [{ id, name, x1, y1, x2, y2, exterior }]`, and each frame gets `d: [cumulative crossings per door]`. |
| Leaving | The exit an agent leaves through is the nearest by walking distance, not straight-line distance. |
| Patchable `weight` | `PATCH_FIELDS.node` gains `weight`, so a what-if can shift how much each entrance is used. |
| `archetypes[].exits` | Optional list of gate or exit node ids this group leaves through. When an agent leaves, it takes the nearest of these by walking distance. Default: every exit. Without it, a lunch customer could leave up the office stairs, which miscounts door traffic. If walls leave none of the group's exits reachable from where the agent stands, it takes the nearest reachable exit of any kind, and its trace says so. |
| `travelSpeed` range | The maximum rises from 60 to 600 map units per minute. A building map is about 0.5 m per unit, so a normal walk of 75 m per minute is about 135 units per minute. |

The viewer draws doors on the map, shaded by traffic up to the scrubber time, and adds a "Busiest doorways" ranking. `swarm report` lists the busiest doorways.

### 14e. CLI

```
swarm building --model <matterportId> | --plan-raw <file.json>     # where the floor plan comes from
               --profile <file.json>                               # a building profile (§14a) or a raw CoStar record
               [--scenario weekday-lunch] [--floor N] [--overrides file.json] [--out worlds/<slug>.json]
```
It prints the composer's report: rooms, tenants matched, doors, warnings and every assumption used.

### 14f. Fit-out files (for an empty building)

Model `6FNMVoyPrL1` is an empty shell, so the places in it are a **proposed fit-out** that Claude designs inside the real walls. A fit-out file is our own design (no Matterport geometry in it), so it is committed under `buildings/<modelId>/`.

```js
{
  model, floor,                       // Matterport model id; floor sequence (0 = Floor 1)
  title, question, context, leaveLabel,
  clockStart, duration, walkMetersPerMinute,      // walking speed in real units; the builder converts to travelSpeed
  arrivals: { total, start, end, shape },
  gates:  [{ id, name, at: { x, y }, weight, exit }],   // positions in METERS, in the model's own coordinates
  places: [{ id, name, at: { x, y }, servers, serviceTime, appeal, price, tags, about }],
  archetypes: [ … world-spec archetypes, with `entries` naming gate ids … ],
  minds: [ … the cast … ],
  provenance: { … }                   // every placed item and every count is 'assumed' unless read from data
}
```

`builder/fitout.js`:
```js
applyFitout(plan, fitout, { margin = 8 })
  // plan: the result of extractFloorplan (meters). Converts it with toMapUnits(plan, { margin }) and returns
  // { world, report: { gates, places, walls, doors, metersPerUnit, warnings } }
```
- The wider margin leaves room to walk outside along the building between exterior doors.
- Every gate and place is converted to map units and checked: at least 0.3 m from every wall and every object, and reachable on foot from at least one gate. A failed check is an error that names the item (and the object, when one is too close).
- With `plan.objects` (from `--mesh`, §13f), the objects are converted with the same transform, count as walls in every check, and are written to the world's `objects` with `provenance.objects: "data"`.
- The world gets `walls`, `geo`, `doors` (gap segments from the plan's doors, named by what they join) and `provenance`, and passes `validateWorld`.
- Real-building worlds contain the floor plan, so the CLI writes them under `data/worlds/` by default.

CLI: `swarm fitout <fitout.json> [--plan-raw data/<id>.json | --model <id>] [--out data/worlds/<slug>.json]`.

### 14g. Decisions recorded after the building-track build (Nov 14)

- The normalized spec always carries `walls: []`, `geo: null`, `doors: []`, `provenance: null`, `edges[].via: []`, `archetypes[].entries: []` and `archetypes[].exits: []` when the world gives none.
- Every §13a error is also fatal in `normalizeSpec`, so the Sim refuses to start on an invalid walled world.
- In worlds with walls, `cleanSpec` keeps exact node coordinates instead of rounding to 0.1.
- A door may touch a wall within 0.02 units of the door's own ends (its jambs). A door with no wall within 0.5 units of either end gets a warning.
- `metrics().walls` is always present (`{ count: 0, checkedMoves: 0, violations: 0 }` without walls). Each cached path or link polyline is checked once, when first used.
- Doors count traffic only in visit mode.
- `selectHeard`'s viewer may carry `distanceTo(placeId)`, giving walking distance, so the overheard-remark radius follows walls.
- Viewer map API additions: `createMap` option `wallsModule`; `highlightDoor(id | null)`; exports `wallsLibLoaded`, `wallGeometry(walls, lib, { clearance })` and `interpolatePosition(geo, xa, ya, xb, yb, u, cache, key)`. A run with walls is drawn at a uniform scale fitted to its bounds, so the building is not stretched.
- Composer details: a stairs or elevator room gets a service place ("to other floors") beside its gate; in the morning scenario an office place has as many servers as its headcount and a fixed service time equal to the window, so staff stay at their desks.
- **Cracks are sealed** (`engine/walls.js`, after the stress test). Any gap narrower than 2 × clearance between a wall end and another wall, or between a wall end and the map edge, is closed by a seal segment. `nav.blocked`, `nav.path` and `nav.distance` treat seals as walls, and `nav.seals` lists them. Before this, a straight line could pass through a hairline gap between wall pieces, a near-miss corner, or the cavity inside a thick wall. Builders keep clearance at or below a quarter of the narrowest door, so real doors (at least 4 × clearance) stay open.
- `[open]` Route mode checks edge polylines against the walls only, not the seals, so an edge drawn through a crack would pass validation. Building worlds use visit mode, which is covered.
- `[open]` `builder/mesh.js` drops the short jamb pieces at openings in thick walls, which leaves the wall's cavity open into each doorway. The seals close it for walking, but the wall drawing is incomplete.
- Known gap in `engine/walls.js`: a path can pass a wall end closer than `clearance`. It never touches the wall, so the hard rule holds; it only affects how tightly dots hug corners.
- **Door gaps (integration, Nov 14).** Builders pull each door's ends in from the jambs (by up to a quarter of the clearance) so a door never touches a wall, and nav may round a jamb closer than that (the known gap above). On the real building, walks between the food hall and the market rounded the pier between the two front doors inside that pull-in, and the market main entrance counted 97 of about 430 crossings. The Sim now counts each door on its gap (§14d, "Door traffic"): the drawn segment, with each end that stops short of a wall (within max(0.3, clearance) units) carried on to that wall plus 0.02. Paths never touch walls, so the part along a jamb is never crossed. A door end already on a wall, or with no wall in reach, is used as drawn; `frames.doors` and the viewer still show the drawn segment. Worlds without walls or doors are unchanged.
- **Real-building check (Nov 14).** `6FNMVoyPrL1` Floor 1 with `buildings/6FNMVoyPrL1/fitout-floor1-lunch.json`: the independent no-through-wall check (own segment intersection, frames every 0.01 min) found 0 crossings and nobody inside the sealed 32.6 m² void in the food hall. Door counts on the gaps match an independent count from those frames door for door.

---

## 15. The advisor: from "where is the problem" to "what to do about it" (Nov 14)

**Decision (user):** finding a bottleneck is not enough. The last step of every run is an advisor: a general-purpose Claude agent that reads everything the run produced, answers the user's question, proposes changes, **tests them in the simulator on the same crowd**, and tells the user what to try next. The user can then push back and iterate.

The advisor never just suggests. Every recommendation carries the measured effect of that change on the same seeds.

```
question + world ─► swarm run ─► recorded run(s)
                                     │
        ┌────────────────────────────┘
        ▼
   brief (KPIs, bottlenecks, doorways, who had the worst time, who spent the most,
          what people said, torn decisions, assumptions, levers available)
        │
        ▼
   advisor (Claude) ──► test_change(patch) ──► swarm compare on the same seeds ──┐
        ▲                                                                        │
        └────────────────────────── measured effect ◄────────────────────────────┘
        │
        ▼
   advice: the answer, ranked changes with measured effects, cautions, what to try next
```

### 15a. Segment outcomes (who, not only where)

Questions like "which people overspend the most?" need results by kind of person.

- Each visit agent records `spent` (one number: the total it paid at the places that served it, after any offer, rounded to cents) and `visits` (the ids of the places that served it, in order; its length equals `served`). Both go into `agents.json`, after `trace`. Route agents have neither.
- `metrics().segments = { byGroup: [...], byCast: [...] }`. Each entry: `{ id, name, group, count, avgWait, avgSpent, avgVisits, walkAwaysPerPerson, shareNeverServed, avgFrustration, topPlaces: [{ id, name, visits }], visitsByPlace: { placeId: visits } }`. `topPlaces` holds at most 3, busiest first; `visitsByPlace` holds every place that served the segment, in node order (§15d). In route mode: `{ id, name, group, count, avgTrip, avgDelay, avgFrustration }`.
- A segment is a kind of simulated person (a group, or everyone who copies one cast member). It is never a real individual. Reports say so.
- `swarm report` adds two tables: who had the worst time, and who spent the most.

### 15b. Targeted offers (a new kind of change to test)

A way to simulate reaching one kind of person with a message or a deal.

World field `offers`, optional, ≤ 50:
```js
{ id, text,                          // what the person is told, ≤ 160 chars: "Eastgate Urgent Care: seen in 20 minutes, half the ER price"
  to: { groups: [archetypeId], cast: [castId] },   // who receives it; an empty `to` means everyone
  place: nodeId | null,              // the place it is about
  priceOff: 0..1,                    // optional discount at that place for these people
  from, until }                      // optional window, in minutes from the start
```
- A person who matches, inside the window, sees `offers: [text, …]` in their observation, so Jev can react to it. Their cost at that place is the discounted price, both in what they see and in what they spend. The rules provider uses the discounted price.
- The offer is information plus an optional price change. It does not force anyone anywhere.
- Patch op: `{ kind: 'offer', offer: { … } }` adds an offer, so `swarm compare` can test one. `validateWorld` checks references.
- `metrics().offers = [{ id, reached, wentToPlace }]`: how many people received it, and how many of them then went to its place.

### 15c. The advisor

`run/advisor.js`:
```js
buildBrief({ world, runs })          // → { markdown, data }: everything above, compact, with the levers that can be changed and their current values
advise({ world, question, seeds = [7, 8, 9], provider = 'rules', confirmWith = null, maxExperiments = 6,
         model = 'claude-fable-5-2', apiKey, client, onStep })
  // → { answer, findings, recommendations, cautions, nextSteps, experiments, transcript }
```
- **Loop.** Claude gets the brief and four tools:
  - `test_change({ label, why, patch })` runs the patched world on the same seeds and returns before, after and the difference, with the spread across seeds.
  - `look_at_person({ runId, agentId })` returns one agent's decisions and trace.
  - `list_people({ segment, sortBy })` finds agents to look at.
  - `finish({ … })` ends the loop.
- **Bounded.** At most `maxExperiments` tests. Each test must say why it is being tried.
- **Two-stage testing.** Experiments run on `provider` (rules by default: instant and free). With `confirmWith: 'jev'`, the top recommendations are re-run with Jev before `finish`, and the advice reports both results. If they disagree, it says so.
- **Recommendation shape:** `{ label, patch, effect: { kpi: { before, after, change, spread } }, testedWith, holdsAcrossSeeds, costNote, confidence: 'high' | 'medium' | 'low', why }`.
- **Rules the advisor is given:**
  - Answer the user's question first, in plain words.
  - Report a change as helping only if its effect is larger than the spread across seeds.
  - Rankings under stated assumptions, not forecasts. Name the assumptions the answer depends on.
  - Segments are kinds of simulated people, never real individuals.
  - Say what it could not test.
- Output is saved as `advice.md` and `advice.json` beside the runs.

CLI: `swarm advise <world> [--question "…"] [--seeds 3] [--provider rules|jev] [--confirm-with jev] [--max-experiments 6] [--model claude-fable-5-2]`. It needs `ANTHROPIC_API_KEY`. Without one it explains the Claude Code path.

**Claude Code path (no API key):** `.claude/commands/advise.md`, a slash command. Given a world or a run, Claude Code itself is the advisor: it reads `swarm report`, writes patch files, runs `swarm compare` on the same seeds, and writes `advice.md` by the same rules.

**Iterating.** `advise` accepts `--follow-up "…"` with `--from <advice.json>`: the user's reply plus the earlier experiments go back to the advisor, which tests further and updates the advice.

Server and viewer: `GET /api/runs/:id/advice` returns the saved advice, and the viewer shows it in an "Advice" panel beside a "Who" panel for the segment tables.

### 15d. Decisions recorded after the advisor build (Nov 14)

**Segments (§15a).**
- `group` is the archetype id. byGroup is in archetype order; byCast is in persona order, including the Sim's stand-in persona for a group without a cast.
- An average is `null` when nobody in the segment counts toward it (for example a cast member nobody copied in this run). `avgFrustration` averages only agents with a frustration answer. Route `avgTrip` and `avgDelay` average agents who arrived.
- `visitsByPlace` was added at integration. `topPlaces` alone cannot say how a place outside a run's top 3 changed: averaging top-3 lists over seeds counted a place that dropped out of a run's top 3 as 0, so an offer test could show a counter's visits collapsing when they had in fact stayed level. Readers use `visitsByPlace` and fall back to `topPlaces` for older runs.
- `archetypes` metrics are unchanged.

**Offers (§15b).**
- An agent pays the price it was quoted when it chose the place (at the request's `t`), even if the window closes before it is served. A line or long-wait observation shows that quoted price for the current place.
- Discounts do not stack: the largest matching `priceOff` at a place applies.
- The window is inclusive at both ends. `from` defaults to 0 and `until` to the duration.
- Route-mode offers are messages only (`place` is always null) and show in route observations.
- Jev names `offers` in next_place, join, keep_waiting and route, never in frustration or tell_others. Requests and Jev bodies without offers are byte-identical to before, and recorded Jev runs replay with 0 misses.
- `reached` counts distinct agents who matched the offer at any decision moment: choosing on arrival, reaching a place, after service or a walk-away, a long wait, a route choice, including leave-only moments. `wentToPlace` counts those of them whose later move was to the offer's place, including people who would have gone there anyway.
- `PATCH_FIELDS.offer` lists the fields of an offer; it is not a field op. `applyPatch` fills a missing id (offer1, offer2, …), suffixes a repeated one (deal → deal_1), resolves audience and place names to ids, and skips an offer that names nobody who exists, has no text and no discount to describe, or would pass 50 offers.
- Rule-based people react to an offer only through its price, weighted by their group's price weight. The text matters only with Jev. A group with price weight 0 ignores a discount under rules (in `er-network` those are the critical and parent groups, the two biggest spenders per person), and a group whose `needs` rule out the offer's place cannot go there at all.

**Measuring a change (`run/effects.js`, shared by `compare` and the advisor).**
- Effects pair before and after seed by seed. `spread` is the larger of the before and after sample standard deviations across seeds. A change counts only when |change| > spread; `holdsAcrossSeeds` means every seed moved the same way.
- Added offers are taken from the patched spec (`compareRuns(...).offers`), never from the raw patch, so a model that writes names or leaves out the id still gets its offer's reach.
- `swarm compare` (CLI and MCP) prints the KPI and bottleneck tables as before, then: offers added by the patch (audience, place, discount, reached, went to the place, arrivals there before → after), "Who, before → after" for every group and each cast member an offer names (`*` marks a change beyond the spread), and where the offer's audience went (visits per run at their busiest places and the offer's place). `--json` replaces the per-seed runs with `effects: { kpis, verdict, holdsAcrossSeeds, segments, offers }`.

**The advisor (§15c).**
- Untested items go in `cautions` with the prefix `Could not test: `, so the result keeps exactly the 15c fields. advice.md and the viewer list them under "What could not be tested".
- A recommendation also carries `experiment`, `kpi` and, after confirmation, `confirmation: { testedWith, experiment, effect, holdsAcrossSeeds, agrees, disagreeOn }`. Effect keys are a headline KPI, `group:<id>.<field>`, `cast:<id>.<field>` or `place:<id>.arrivals`.
- Confidence cap: high only when the effect beats the spread in the better direction, holds on every seed, and at least 3 seeds ran. Low when it does not help, or when the confirming provider disagrees on direction. A measure with no fixed direction (spending, visits, arrivals at a place) helps only when the recommendation names `better: 'lower' | 'higher'`; without it the change is capped at low with a caution.
- `test_change` results include each group's measured fields; for an offer's audience they add `whereTheyWent`, and each added offer reports `reached`, `wentToPlace` and `placeArrivals`. advice.md and the viewer print the offer's reach under the recommendation that tested it.
- Confirmation re-runs the top 3 recommendations, then Claude is asked to finish again. `maxExperiments` is at most 20. A follow-up always runs a fresh baseline.
- `advise` also takes `runs` (baseline runs already made) and `simOpts`; `provider` and `confirmWith` accept a name or a provider object.
- Requests: streaming with `finalMessage`, server-side refusal fallback (beta `server-side-fallback-2026-07-01`, `fallbacks: 'default'`), `output_config.effort: 'high'`, `tool_choice: auto` (the model rejects forced tool use; the loop nudges once if finish is never called), `eager_input_streaming` on every tool, inputs validated in code. No key value appears in errors, results, the transcript or progress events.
- The CLI writes advice.json and advice.md into every baseline run folder; `--out` is the runs folder. Without `ANTHROPIC_API_KEY` it exits 1 and explains the `/advise` path.
- `[open]` Not run against the live Claude API (no key on the build machine). The loop, the runner, compare and the files were exercised with a scripted fake client, and the CLI through the real SDK against a local fake endpoint.
- `[open]` "Who spent the most" can rank first a cast member copied by only 1 or 2 people per run; read the People column before targeting one.
- `[open]` The viewer's Who rows do not yet highlight that segment's dots on the map (needs a `highlightAgents` hook in `web/map.js`).

---

## 16. Waiting: what people are told and how often they are asked (Nov 14)

**Why.** By default the engine turns each group's patience number into words and hands them to Jev: "more than they will put up with". Jev reads literally, so that sentence mostly decides the answer, and the person's own situation hardly matters. A direct test on Nov 14 (five emergency-room patients in the identical situation, 450 Jev calls) found the spread between people in "keep waiting" was 15 to 16 points with the sentence and 30 to 37 points without it. The engine also asked "keep waiting?" only once per line and then made the person leave one patience-length later, whatever they had answered.

Both behaviors stay the default. A visit world can switch them off with an optional top-level `waiting` object:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `waiting.tellPatience` | boolean | `true` | `false` leaves the patience verdict out of what a person is told: the `now` sentence ends after the facts ("The line is long, about 45 min." and "About 10 more minutes expected."), and places carry no `line_vs_patience`. Line length, people ahead, time waited and everything else stay. |
| `waiting.askAgainEvery` | minutes, 5 to 240 | `0` | `0` asks `keep_waiting` once per line visit, then the person leaves when their wait reaches the time of the question plus their tolerance. A value above 0 asks again that many minutes after each yes, and nobody is made to leave: a person stays until they say no, are served, or the run ends. |

- **When the questions come is unchanged.** `line` is still asked when the estimated wait is over 8 minutes and over half the tolerance, and the first `long` when the wait passes the tolerance and 10 minutes. The group's patience number still decides when to ask; with `tellPatience: false` it no longer tells Jev what to answer.
- **Rules are unaffected.** The inline rule policy reads no words and asks no questions, so a rules run of the same world and seed is identical with or without `waiting`. Under `rules-external` with `askAgainEvery`, the rule answer at each question is yes until the wait passes 1.3 × tolerance × (0.8 + 0.4 × jitter), then leave.
- **Recorded runs are safe.** The normalized spec has a `waiting` key only when a value differs from the defaults, so worlds without it normalize, record, clean and hash as before. A Jev run recorded before this change replays on the changed engine with 0 misses and identical spec, metrics, agents, frames and remarks.
- **Cost.** `askAgainEvery` adds one Jev request per person per interval spent in a line past their patience. `swarm estimate` counts requests from a rules dry run, which leaves lines sooner, so it understates this.
- **Visit mode only.** A route world with `waiting` gets a warning and ignores it.
- **A question Jev cannot answer gets the rule answer,** as everywhere else (API failure, request budget). For `keep_waiting` that answer is leave once the wait passes about 1.3 × tolerance, so with `askAgainEvery` a failed request can still send a waiting person away. The decision is recorded as `rules-fallback`.
- **People still in line when the run ends** count as neither served nor walked away, and their wait is in no per-person or per-group wait number. That was always so; with `askAgainEvery` it is common at a place that cannot clear its line. Compare such runs on each place's wait minutes and on `shareNeverServed`, and make `duration` long enough for lines to clear.
- **Remarks and the trace.** Each `keep_waiting` question also asks whether the person tells others, so one person in one long wait can post several remarks about the same line. A repeated "kept waiting" entry is written to the person's trace once.
- **Fit-outs** pass `waiting` through to the built world (`builder/fitout.js`).
- Validation: a non-boolean `tellPatience` becomes `true`; `askAgainEvery` between 0 and 5 becomes 5 and above 240 becomes 240; each with a warning.
- `[open]` `feeling` is still handed to Jev as the engine's word for the person's last frustration score. In the same test, frustration answers separated by person only when it was left out.
- `[open]` There is no "speak up" action: a message such as "tell the nurse now and you go first" can only be answered by staying in line or leaving it.

### 16b. What a customer sees of a line: `waiting.lineShows` (Nov 14)

**Why.** A customer at a counter sees how many people are in line and how many staff are serving. They do not see a wait in minutes. Lu, Musalem, Olivares & Schilkrut ("Measuring the Effect of Queues on Customer Purchases", Management Science 59(8), 2013) measured a supermarket deli for seven months and found that whether a customer buys depends on the number of people in line, not on how many staff are serving. The engine used to tell every person a wait estimate in words ("short, about 7 min"). That estimate is (people ahead + 1) × serviceTime ÷ staff, so it tells Jev how many staff are serving, and Jev's answers followed it.

**The probe.** `validation/jev-line-probe.js` asks Jev the join-the-line question for 8 people from the building's cast at Bridge Coffee, with 0 to 15 people ahead and 1 to 3 staff serving: 1,112 requests, about $0.04. Each version is built by `visitObservation` (results under `data/validation/`, not committed). Run on Nov 14 with jev-1.14.0:

| What the person is told | Join probability, 1 → 3 staff at the same line length (average change) | Same wait, longer line (6 min: 2 ahead with 1 staff, 5 with 2, 8 with 3) |
|---|---|---|
| Wait in minutes and the patience verdict (the default) | +0.30 | 0.62 / 0.59 / 0.62 |
| Wait in minutes, no verdict (`tellPatience: false`) | +0.12 | 0.45 / 0.44 / 0.44 |
| People in line and staff serving (`lineShows: "people"`) | +0.03 | 0.39 / 0.32 / 0.28 |

With minutes, Jev reacts to the wait and hardly at all to the line length. With the head count, it reacts to the line length and hardly at all to the staff. That is the deli's finding. Repeat asks of one question differ by about 2 points on average (§17), so +0.03 is close to noise.

**The setting.** `waiting.lineShows`, `"wait"` (default) or `"people"`. With `"people"`, a person without a live wait app is told:
- at the join question: "Just reached Bridge Coffee. 6 people in line, 2 staff serving." ("There is no line; 2 staff serving." when nobody is ahead);
- at the keep-waiting question: "Has waited about 15 minutes in line at Bridge Coffee. 3 people still ahead, 2 staff serving." ("Next to be served" when nobody is ahead);
- for every place they can see, in every visit observation: `people_ahead` and `staff` in place of `line` and `line_vs_patience`. Places they cannot see still read "unknown (can't see it from here)".

There is no patience verdict in this mode, because the verdict compares a wait in minutes. A person with a live wait app (`informed`) is told exactly what `"wait"` mode tells them: the app shows minutes.

- **Only the words change.** When the questions come (the join question when the estimated wait is over 8 minutes and over half the tolerance), the rule answers and the inline rule policy all still use the engine's wait estimate. A rules run is identical in both modes, and so are the times and order of Jev's questions (tested).
- **Recorded runs are safe.** `"wait"` adds nothing to the normalized spec, so worlds without the field hash and replay as before. Ask the room (§17) builds its own arrival observation from its own world (`alder-pine-cafe.json`, unchanged), so its recorded answers still match.
- **Where it is on.** `buildings/6FNMVoyPrL1/fitout-floor1-lunch.json` (the building's food hall and market) sets `"people"`. Worlds with posted waits, such as the theme park, keep `"wait"`. The café and sushi worlds are unchanged.
- `[open]` **The rule model still credits extra staff with a faster line.** Its walk-away rule compares the wait estimate with patience, so in a rules run, +1 staff helps both by shortening the line and by lowering the estimate each arriving person compares. Basing the rule on the head count needs each counter's usual staffing, which the engine does not know once a test has changed the staff. A first try, one service time per person whatever the staff, raised the building's rules baseline from 193 to 351 walk-aways (seed 1) and was dropped. The display's "+1 staff" test runs with rules, so it may overstate the gain until this is settled.
- `[open]` **Jev turns away from lines more than the deli's customers did.** With the head count, Jev's join probability falls from about 0.42 with 1 person ahead to about 0.22 with 15. In the deli, 15 or more in line cut purchases by about a tenth (30% to 27%). The probe asks only people who reached the counter and are deciding, so the two numbers are not directly comparable, but the gap is large. With nobody ahead, Jev joins only about a third of the time, which the engine never asks (the question needs a wait over 8 minutes). A count of real customers at a counter (`validation/livestream/`) is the planned check.

---

## 17. Ask the room: one moment, every customer, live (Nov 14)

**Why.** A run answers "what happens over a morning" in tens of seconds. An owner, or a judge, also wants to try a change and see who reacts while they are still looking at the page. Asking Jev one moment for every cast member takes about a quarter of a second, so that is what this does.

**What it is.** `run/room.js` builds, for each cast member, the arrival question the engine itself asks ("Just arrived. Choosing where to go first.") through `visitObservation`, with the line, price and sign taken from the page. For the same person and moment the request is byte-identical to the engine's (tested). It never states a patience verdict, whatever the world's `waiting` says.

- `roomView(spec)`: the service places, the cast, the default scenario, limits.
- `normalizeScenario(spec, raw)`: `{ shop, ahead: { placeId: people in line }, price, priorPrice, sign, minute }`, all clamped; a value left out or empty takes the default. The shop is the first service place unless named. A line of n people reads as a wait of (n + 1) × serviceTime ÷ servers, and as no wait when nobody is in line. `sign` holds the words only: a typed "Sign on the door:" is dropped, and the person is told `Sign on the door of <shop name>: <words>`, because a sign with no shop named left Jev to guess whose door it was on (the same cash-only sign read 22 points below the plain sign unnamed, 28 below with the café named, and 10 above with the chain named).
- `askRoom({ spec, scenario, compareTo, edits, only, provider })` asks each person up to four questions:
  - **before:** the default moment (or `compareTo`), with the person as written in the world;
  - **now:** the page's scenario, with the page's rewrite of that person (`edits[id]` may replace `bio`, `personality`, `goal` for this ask only);
  - **neutral:** as now, with a fixed plain sign about restrooms, only when the scenario has a sign;
  - **written:** as now, with the person as written, only for a rewritten person.
- `recordProvider(record)`: answers only from recorded Jev answers.

**Rules the page follows, each from a measured finding (§16, the Nov 14 café tests and the Nov 14 review of this page).**
- A sign is judged against the plain sign, never against no sign: any added sentence moves Jev's answers, by 5 points for the room and by up to 12 for one person.
- There are two bars. The room's share counts as changed at 5 points (`ROOM_NOISE`). One person counts as moved at 15 points (`ROOM_NOISE_PERSON`). Asking the same question twice differs by about 2 points on average, by 5 or more one time in eight, and by 14 at most (840 repeats). With the 5-point bar applied to single people, eight checks where nothing real changed (signs that say nothing, rewrites that keep the meaning) named 22 movers in 96 comparisons, at least one in every check; a 10-point bar still named one person in half of them. Changes between 5 and 14 points are drawn in grey and labelled "too small to tell". Whole points are compared, so a change that reads as 5 is always treated as 5.
- A rewritten person is compared with the same moment as they were written, so the number beside them is the rewrite's own effect.
- When a sign sits on top of a price or line change, the bars show the sign's own effect and the page also states the share before any change.
- The opening view reports no comparison, because nothing has been changed.
- Prices are whole dollars, because `priceWords` rounds to dollars. A new price is taken to be remembered: `(it was about $5 last week)` is appended to the price the person is told unless the box is cleared. That wording lives here, not in the engine: it is a stand-in for the planned memory of past visits.
- Option order is fixed (`shuffle: false`) in every question, so adding a sign cannot reorder the choices.

**Server.** `GET /api/room[?world=file]` returns the view plus `live` (a Jev key is set) and `recorded` (answers on record). `POST /api/room/ask` takes `{ world?, scenario, compareTo?, edits?, only?, offline? }` and returns each person's `before`, `now`, `neutral`, `written`, what they were `told`, and `source` (`live`, `recorded` or `failed`), with the shop's shares, `askedLive` (questions sent to Jev just now) and `error` (Jev's first error, when someone could not answer). Asks run one at a time and up to three more wait their turn (429 beyond that); at most 4 questions per cast member and 120 per ask. The live provider waits 4 seconds and tries twice, so a stalled network costs the page about 8 seconds at worst and not minutes (the run defaults of 15 seconds and 5 attempts held the page for 78 to 156 seconds in a test with a silent network).

**Recorded answers.** Every live answer is kept by request hash in `data/room/record.json` (never committed). `web/room/seed-record.json` holds 925 recorded answers for the example world: prices $1 to $10 with and without the remembered price, lines of 0 to 20 at each place, the four preset signs and one typed sign at $5, $6 and $7, and one rewrite. `node run/room-seed.js` rebuilds it: it asks Jev only what is not on record yet and keeps exactly the answers its scenario list needs (`--check` asks nothing and reports what is missing). With no key the page answers from the record, and a question that was never asked live is not invented: the page keeps the last answers on screen and says why. A test fails if the example world and the seed drift apart.

**Page.** `web/room/` (served at `/room/`): controls on the left (sign, price, lines), every cast member on the right with what they are like, a bar for the chance of choosing the shop, a tick for the comparison, and the change. Price buttons, the remembered-price box, the sliders and the preset signs ask at once; a typed sign asks on Enter. A click made while an ask is running is kept and runs next. A pill above the headline says whether the answers were asked just now, with the count and the time, or asked before and saved. When the room's share is flat but people moved, the headline names the people. Opening a person shows exactly what they were told and lets you rewrite them; what is typed is kept as it is typed, so either Ask button carries it. One person is asked about the moment everyone last answered, whatever the controls say now. The arithmetic is in `web/room/maths.js` and is tested. `?world=file` loads another visit world from `worlds/`.

**Feelings (Nov 14, after three judges used the page).** `web/room/feelings.js` lists five one-click feelings. Each adds one sentence about today to a person's situation and nothing else: "Treated kindly here", "Brushed off here", "Feeling lonely", "Worried about money", "Awful morning". The sentences use the person's first name and the shop's name.
- "How everyone feels today" on the left gives the whole room one feeling. A person's own panel has the same five, for that person only. A typed rewrite takes a feeling's place.
- The headline says the feeling and both numbers: "Shanice, still touched by a kindness here: 83%, was 50%", or "Everyone worried about money: Alder & Pine Coffee gets 34% of these 12 people, down from 56%". A person with a feeling is compared with themselves without it, at the same price and line.
- Recorded for the example cafe at the opening moment, with 10 in line, and at $7 (180 answers), so they work with no key. At the opening moment "Brushed off here" takes the cafe from 63% to 23% (the regulars drop most: Marcus 92% to 22%), and "Treated kindly here" takes it to 77%. "Worried about money" does little at $5 and a lot at $7 (56% to 34%; June, on a fixed pension, 99% to 57%). 19 to 26 of the 60 one-click results at each moment pass the 15-point bar. The first set of four general moods passed it 5 times in 48, so two of them were replaced by feelings about the shop.
- A person who is already sure (95% or more, or 5% or less) says so in their panel when a feeling changes nothing, and what to try.
- Before anything is changed, the people nearest 50% are listed first: they are the ones a feeling can move.
- Three judges (a hackathon judge with two minutes, an engineer trying to prove a lookup table, a cafe owner) each used the earlier version in a browser with live Jev. All three scored it 7 of 10 and were convinced that a model reads the person and that typed feelings drive the choice: 10 of 13 unprepared feelings moved the right person the expected way and none went the wrong way, five no-meaning controls stayed under the bar, and the same feeling typed in Chinese gave nearly the same move. Their shared complaint was that the one-click path undersold it; the changes above are their fixes. The page has not been judged again since.

**Example world.** `worlds/alder-pine-cafe.json`: a fictional independent café with a chain across the street, 12 cast members, `waiting.tellPatience: false`.

**What it does not show.** One moment, not a morning: no line dynamics, no word of mouth, no repeat visits. The people are unvalidated. Jev reacts weakly to price unless a person's description mentions money, so price answers show direction only, and only for those people (in the example world Tomas, Omar and Priyanka; Bill reacts to the price having changed). The plain-sign answer is one recorded answer per person and moment, so a person whose plain-sign answer happens to sit high or low leans the same way under every sign; the 15-point bar is what keeps that from being named. A warm or sad sign can lower the share, because five of the twelve start near 100% and have no room to rise.

## 18. Seats, and the sushi restaurant as a third place in the scope display (Nov 14)

**Why.** The scope display had two places: a building and a parking lot. The team's audience is now independent local businesses (`INDEPENDENT_BUSINESS_SPEC.md`), so the third place is one of those: a small sushi restaurant, drawn by hand as one room with a kitchen, four counter seats and four seats at a table. In a room this small the picture an owner reads is who is in which seat and who is standing by the door. The engine had no notion of a seat: people being served were drawn as a cluster on the place.

**Seats (`nodes[i].seats`, visit-mode service places).** Up to 64 points `{ x, y }` (or `[x, y]`).
- A person takes the first free seat when their service starts and keeps it until they finish. In frames they are recorded exactly at the seat.
- Seats are for drawing only. The walk still ends at the place's own point, lines form there, and waits, choices and decision requests are the same with and without seats.
- With more servers than seats, the people left over are drawn around the place as before.
- With walls, a seat that has a wall or an object between it and the place is dropped with a warning, because the dot moves from the place to the seat in a straight line.
- `frames.nodes[i]` carries `seats: [[x, y], ...]` only for places that have them.
- A world without seats normalizes, hashes, runs and replays exactly as before: the key exists only when seats are given.

**The world (`worlds/sushi-restaurant.json`).** What comes from the sketch and what is assumed:

| From the sketch | Assumed |
|---|---|
| One tall rectangular room. | Scale: one square of the sketch's grid is 1 m, so the room is 7.8 m by 12 m. |
| The kitchen fills the upper left: 60% of the width and 57% of the height. | The street door: the sketch has none. It is a 1 m gap in the bottom wall, right of centre. |
| Four seats in one column on the right, beside the kitchen. | Seat times: about 30 minutes at the counter and 40 at the table. Prices: $38 and $32. |
| Four seats in a 2 by 2 block in the lower left. | 36 people arriving between 6:00 and 7:50 pm on a Friday; four groups and ten cast members, all fictional. |

- The kitchen is one object of kind `room`: solid, so nobody walks in, and drawn hatched with its name.
- The two places ("Counter seats", "Table") have 4 servers each, one per seat. Each place's own point is in the open floor by the door: that is where people wait. The seats are where they sit.
- The room is small on the engine's map on purpose. The engine words distance and sight in map units: `distanceWords` says "far" from 35 units, and a line is visible within 30. The first version drew the room 52 by 80 units, and a person at the door was told the counter was "far" and its line "unknown (can't see it from here)", which is false in one room. At 19.5 by 30 units (0.4 m per unit) both places read "close" and every line is in view.
- `waiting` is `{ tellPatience: false, askAgainEvery: 10 }` (§16): the person decides whether to keep waiting, and is asked again every ten minutes.

**Recorded run.** One Jev run (seed 7, `jev-1.14.0`, 103 decisions, under half a cent): of 36 people, 24 got a seat (22 had finished eating by 8:30 pm and 2 were still at the counter) and 12 left without eating. The engine's `served` counts finished meals only, so the display counts a person as seated from the moment they sit down. Both places had people waiting about 10 minutes on average, with up to 5 waiting at once. It is one seed and has not been checked against a real restaurant.
- `scripts/pack_run.js <run folder> <out file>` packs a recorded run folder into one file: `{ meta, spec, frames, metrics, agents, remarks, decisions }`, the same parts `GET /api/runs/<id>/<part>` serves. `web/scope/mock/sushi-restaurant.json` is that Jev run, so the display can replay it with no key and no engine server.
- To record it again after changing the world: `node bin/swarm.js run worlds/sushi-restaurant.json --provider jev --seed 7`, then pack the new run folder to the same file.

**Display.** "Sushi restaurant" is the second place of the scope display (`?case=sushi`, or "Other places" in Run details; there is no case picker, §9b), listed in `web/scope/mock/index.json` with a `runTitle` and a `placeName`. The counter for people served reads "Got a seat" there: each person sits once, and is counted from the moment they sit down.
- A case file may be a packed engine run: `loadBundle` passes it through `adaptEngineRun`.
- Served by the engine, a case with a `runTitle` takes every recorded run with that title (up to 200) and the building takes the rest, so the restaurant's runs never appear under the building and none of its own drop off its list.
- Every seat is drawn as a small chair whether or not someone sits on it. An object of kind `room` is labelled with its name. A place with seats is named at its seats, not where people wait.

**Edit the room.** "Edit the room" sits beside View in the map's corner on a world that has seats, and works when the engine serves the page (`web/scope/lib/edit.js`, rules in `lib/layout.js`). While editing, the edit panel takes the side column and the map shows only the room and its seats.
- Drag a seat to move it, click one and remove it (or use Delete and the arrow keys), or add a seat to a place. A place always has one server per seat.
- A spot is refused, with the reason shown, when it is within 0.25 m of a wall or the kitchen, within 0.55 m of another seat, or has a wall between it and where people wait. Those are the engine's own rules, so every room the editor allows validates with no warning.
- "Run it with the rule model" or "Run it with Jev" posts the changed world to `POST /api/runs` once per seed, on the seeds the room as sketched already has runs of with that provider (three at most), then opens the first new run.
- For a run of a changed room, the verdict panel (§9b) compares the two rooms on the same seeds and decision-maker (`compareParts` in `lib/layout.js`), for example "24 of 36 people got a seat. Before your change: 21.3." and "Averaged over 3 runs each." When the change is no larger than the spread between the sketched room's own runs, it says the difference could be chance. An "As sketched / Your room" toggle switches the map between the two runs of the seed on screen. Run details marks runs of a changed room.
- Only seats can be changed. Walls, the kitchen and the door cannot.

**The promotion (the restaurant's one change).** It was first a suggestion in the Suggestions dialog (`web/scope/lib/feedback.js`). Since the merge with the v0.27 redesign it lives in the verdict panel at the top of the side panel (§9b), in place of "+1 staff": a place with one staff per seat has no use for one more staff without a chair. The case asks for it with `"suggestion": "promotion"` in `mock/index.json` (`changeFor` in `web/scope/lib/verdict.js`).
- It is a fixed rule, not written by AI. `applyChange` adds three offers (§15b) for everyone: the message "Promotion today: 20% off everything for everyone who comes in.", and 20% off at each of the two places, so the price a person is told and pays is the promotion price.
- Before a test the panel says how many people did not get a seat and why (the seats and the wait), what the promotion is, and "Test the promotion". The test runs the room as it is and with the promotion on 3 seeds each, like +1 staff, with the same decision-maker as the run on screen when it can: Jev for a Jev run when the server has a Jev key, otherwise the rule model. The rule model prices each place at what the person pays, but it does not read the message, so the panel says so.
- After the test: the verdict in customers kept (more people who got a seat), a table (got a seat, walked away, average wait, got a seat at each place, people told about the promotion), one sentence of why, and a "Baseline / Promotion" toggle. Under a Jev verdict a line says that two Jev runs of the same world and seed already differ by a few people. The runs carry the server-stored `link` with `change: { kind: 'promotion', off: 0.2 }` (§9b); nothing is kept in the browser.
- The promotion can be tested as often as you like: "Test again" under the verdict starts a new test of the baseline's world on the same seeds, with Jev asked again, and the panel then shows the newest test.
- A promotion run is also known by the offers in its world (`hasPromotion`), so runs from before the run link still pair up: `findOfferTest` pairs such a run with its twin (same seats, seed and decision-maker, the other side of the promotion; the newest baseline started before it, or for a baseline the newest promotion run) and the panel shows that one pair. Run details labels them "Promotion".
- **Seated means got a seat**, counted when the person sits down: at each place, everyone who came to it and neither walked away nor was still waiting at the end (`everSeated` and `outcome` in `lib/layout.js`). The engine's `served` counts finished meals only. The counter on the map reads "Got a seat" and adds the people sitting now to the meals finished.
- A promotion adds a reason to come in and to wait. It does not add seats or bring more people to the door. Two pairs of Jev runs on seed 7 were recorded before the merge. First pair: finished meals 22 to 24, walk-aways 18 to 12, average wait 9.6 to 12.3 minutes. Second pair: finished meals 24 to 23, walk-aways 14 to 14, wait 9.2 to 11.0. Jev does not answer the same question the same way twice, so the two baselines alone differ by that much. Only the longer wait appeared both times. No effect on people seated is shown. With the rule model (3 seeds each way, Nov 14) the promotion changed nothing, as expected of a model that does not read the message.
- A run with a promotion is not a baseline. "Edit the room" opened from a promotion run starts from that room without the promotion, and a changed room is compared only with runs of the room as sketched under the same offers (`pairRuns` in `lib/layout.js`).

**What it does not show.**
- Parties. Each simulated person is one diner who takes one seat and decides alone. A couple is two arrivals, and nothing keeps them together.
- Reservations, takeout, a waiting list, or waiting outside.
- The real door, the real seat times and the real number of people on a Friday: all assumed.
- More than one seed, or any check against real customers.

## 19. The language button: English and Simplified Chinese (Nov 14)

**Removed everywhere (Nov 14, late evening; Josh's decision).** No page has a language button any more: not the dashboard, not Ask the room, not the step-diagram page. `web/scope/lib/i18n.js` and `web/scope/lib/zh.js` are deleted, and `?lang=zh` does nothing. Everything below describes what was there.

**Removed from the scope display (Nov 14, owner's decision).** The scope display (`/scope/`) has no language button and no Chinese: it does not load `i18n.js`, and its map labels are drawn in English only. Ask the room (`/room/`) keeps its button. Its page imports `web/scope/lib/i18n.js`, which reads `web/scope/lib/zh.js`, so both files stay where they are; the strings in `zh.js` for the scope display are no longer used. The rest of this section describes Ask the room.

**Why.** An owner should be able to read the page in their own language. Ask the room (`/room/`) has a button in the header that switches everything on screen between English and Simplified Chinese.

**How.** The pages are written in English and are not changed. `web/scope/lib/i18n.js` translates what is on screen, one piece at a time: the text of a DOM text node, a placeholder, a title, an aria-label, or a string drawn on a canvas (through `tr()`; the scope display's map no longer calls it).
- `web/scope/lib/zh.js` holds the Chinese: `EXACT` for whole pieces of text, and `PATTERNS` (a regular expression and a Chinese sentence with `$1`, `$2`) for text with changing parts such as numbers, names and places. Each captured part is translated on its own, so a place name inside a sentence gets its Chinese too.
- In Chinese mode a `MutationObserver` translates text as the app writes it. In English mode nothing runs: no observer and no change to the page.
- Switching back restores the English that was there. The choice is remembered in the browser; `?lang=zh` opens a page in Chinese.
- An element with `data-i18n-skip` is left alone (the button itself). Typed text (the sign box, the rewrite boxes) is never translated.

**Limits.**
- Text that is not in `zh.js` stays in English. That includes anything typed, and wording nobody listed.
- People were asked in English and Jev answered in English. The Chinese shown for what a person was told is a translation for the reader, not what Jev read. A sign typed in Chinese is sent to Jev as typed.
- The translations were produced by machine on Nov 14 and have not been read by a native speaker. `zh.js` holds about 940 phrases and 590 patterns; a line the app joins from several sentences is translated sentence by sentence.
- A feeling's sentence in a person's box and what a person was told stay in English, because that is what Jev read.
- The older run viewer at `/` has no language button.

---

## 20. The morning question and the return probe (Nov 14)

**Why.** [REPEAT_CUSTOMERS_SPEC.md](../REPEAT_CUSTOMERS_SPEC.md) simulates the same people over days. Each morning every person is asked whether they go to the shop today, and what they are told includes their memory of earlier visits. Before any of that is built, one thing has to be known: does Jev read a memory and answer the way real customers were measured to? This section defines the question, the words, and a probe that checks them. Nothing here changes a run: the Sim never asks this question.

### 20a. What a person is told

`morningObservation(ctx)` in `engine/observe.js` builds the state. Every fact is written by code as a fact in words, never as a verdict (§16).

| Field | Content | Example |
|---|---|---|
| `setting`, `time`, `person` | As in every observation (§5). `person` has no app field. | |
| `now` | Fixed sentence naming the shop. | "Deciding whether to go to Alder & Pine Coffee today." |
| `shop` | `name`, `known_for`, `offers` (tags), `cost`, `rating`. | `cost`: "$5.50 (it was $5.00 last week)"; "$4.00 with the offer (usually $5.00)". `rating`: "4.5 out of 5 stars from online reviews". |
| `other_places` | The world's other service places: `name`, `known_for`, `cost`. No lines: nobody can see a line from home. | |
| `history` | How well they know the shop. | "Has been to Alder & Pine Coffee 8 times in the last 4 weeks." "Has never been to Alder & Pine Coffee; has walked past it." |
| `memory` | Up to 5 remembered events, newest first, from `memoryWords`. | "Yesterday: waited about 20 minutes in line at Alder & Pine Coffee, then left without ordering." |
| `card` | Stamp-card progress. | "Stamp card for Alder & Pine Coffee: 8 of 10 stamps filled. A full card earns a free coffee." |
| `heard` | Remarks from people they listen to, as strings. | "A friend (yesterday): long line at Alder & Pine Coffee" |
| `offers` | Messages from the shop (§15b's field). | "Alder & Pine Coffee: 20% off everything today." |

- **Prices are exact here** ("$5.50"), unlike the "about $5" used inside a visit, because a 50-cent change is the fact being remembered.
- **A memory record** is `{ daysAgo, wait, outcome: "served" | "left", ending: "fast" | "slow", paid, promo, first }` for a visit to the shop, or `{ daysAgo, text }` for anything else. `wait` is the worst wait of that visit in minutes; `ending` says how the line moved at the end (the peak-end rule: people remember the worst and the last moment). The evening update of the multi-day loop will write these records from `agents.json`; today only the probe writes them.
- A field with nothing in it is left out, and the question names only the fields that are present.

### 20b. The question

A new yes/no question in `providers/jev.js`, `visit_today`, asked alone:

> Does the person in `person` go to the shop in `shop` today, given `history`, `memory`, …?
> true: "They go to this shop today." false: "They do not: they go somewhere else or go without."

- **Yes/no, not a choice between places.** Jev leans toward the first option of a choice (§6), and the option order is shuffled by a seed taken from the state. Two versions of a memory would then be asked with different orders, and the order effect would be mixed into the difference being measured. A yes/no question has no order.
- `run/morning.js` builds the DecisionRequest: `morningRequest({ spec, shopId, mind, state })`, kind `morning`, `asks: { yesNo: "visit_today" }`, rule answer yes. `state` is one person's record: `{ history, memory, card, heard, offers, price, wasPrice, offerPrice, rating }`.
- Adding the question changes no existing request body or hash.

### 20c. The return probe

`validation/jev-return-probe.js`, built like the line probe (§16b). World: `worlds/alder-pine-cafe.json`, shop Alder & Pine Coffee, with Brewline across the street. It asks the morning question for the café's cast and changes one fact at a time.

- **Who is asked what.** A person's written bio decides which states they can be put in without contradicting it. 11 of the 12 can be a returning customer (everyone but Greta, who is in town for one day). 7 can be a newcomer (Ellie, Dev, Karen, Shanice, Greta, Omar, Lucy). A returning customer's `history` gives a visit count that fits their bio (June 28 times in 4 weeks, Tomas 3).
- **Repeats.** Jev does not answer the same question the same way twice (§17), so every question is asked 5 times and the answers averaged. Each pass uses a fresh provider, so nothing comes from a cache.
- **Reference.** A returning customer's reference memory is "Yesterday: waited about 5 minutes in line at Alder & Pine Coffee, then was served." A newcomer's reference is no memory. Each condition differs from its reference, or from the condition it is compared with, by one fact.
- **Neutral controls.** Any added sentence moves Jev's answers by about 5 points (§17). A message from the shop is compared with a message that carries no offer ("open 7 am to 3 pm today, as usual"), a friend's remark with a remark about something else, and a memory with a sentence about the weather.

**Tests.** Each compares two conditions person by person. The effect is the average difference in the chance of going, with a 95% interval from resampling people.

| Test | Compares | Passes when | From |
|---|---|---|---|
| Reads a memory at all | A very good last visit against a very bad one | Good is clearly higher | sanity |
| A neutral sentence does nothing | A sentence about the weather against no memory | Within 5 points | §17 |
| Same fact, other words | "waited about 20 minutes" against a paraphrase | Within 5 points | sanity |
| Turned away at the door | "found 9 people in line … and left without ordering" against an ordinary visit | Lower | the loop's wording (§21b) |
| Longer last wait | Last wait 0, 5, 10, 20, 30 minutes, served | The chance falls as the wait grows | de Vries et al. 2018 |
| Walked away | Left without ordering against served, same wait | Left is lower | de Vries et al. 2018 |
| How it ended | 15 minutes ending fast against ending slow | Fast is higher | peak-end rule |
| Price rise | $5.50 against $5.00 | Lower | Hardie et al. 1993 |
| Loss aversion | The drop from +50¢ against the gain from −50¢ | The drop is larger | Hardie et al. 1993 |
| Near the reward | 8 of 10 stamps against 2 of 10 | Higher, and visits 10 to 30% closer together | Kivetz et al. 2006 |
| Head start | 2 of 10 stamps given free against 0 of 8 | Higher | Nunes & Drèze 2006 |
| A deal brings newcomers | 20% off today against the plain message, newcomers | Higher | Dholakia 2011 |
| A deal buys no loyalty | First visit on a deal against first visit at full price, both at full price today | Not higher | REPEAT_CUSTOMERS_SPEC §9 |
| Rating | 4.5 stars against 3.5, newcomers | Higher; the study saw 5 to 9% more revenue per star | Luca 2016 |
| A friend's remark | Good against neutral against bad, newcomers | Good above neutral above bad | Trusov et al. 2009 |

Also measured, with no pass rule: how fast a bad memory fades (yesterday, 1 week, 4 weeks), whether bad visits add up (0, 1 or 3 of the last 3), what a deal does for regulars, and what a stamp card does by being there.

- **Verdicts.** Pass: the interval is wholly on the expected side. Fail: wholly on the wrong side. Unclear: the interval includes zero. "Within 5 points" tests pass when the average difference is under 5 points.
- **Run it.** `node validation/jev-return-probe.js [--repeats 5] [--only <family>]`. About 2,400 Jev requests and about 10 cents. Results go to `data/validation/jev-return-probe.json` and `.md` (not committed).
- **What a pass means.** That signal may be given to Jev in the multi-day loop. A fail or a flat response means the loop uses the measured effect as a rule for that signal instead (REPEAT_CUSTOMERS_SPEC §3).

### 20d. What the probe found (Nov 14, jev-1.14.0)

One run: 473 questions asked 5 times each, 2,365 requests, 11 seconds, about 7 cents, none unanswered. Two asks of the same question differed by 1.2 points on average and 8.0 at most. All numbers below are the chance of going today, averaged over 11 returning customers or 7 newcomers; intervals are 95%, from resampling people. Full results: `data/validation/jev-return-probe.md` (not committed; `--from` rescores saved answers without asking Jev again).

**Jev reads memory. All 5 sanity checks pass.**
- A very good last visit against a very bad one: +34.9 points (29.2 to 40.7), odds ×5.7. Every one of the 11 people moved, by 19 to 53 points.
- It reads the number: after a last wait of 0, 5, 10, 20 and 30 minutes the chance is 69, 58, 51, 43 and 40%.
- It reads the outcome: leaving without ordering costs a further 10.0 points after 20 minutes and 13.8 after 10.
- It reads the date: a 30-minute wait that ended in leaving gives 32% if it was yesterday, 37% a week ago, 44% four weeks ago.
- It adds visits up: with none, one or three 20-minute waits among the last three visits the chance is 60, 50 and 42%; the same single wait counts for more yesterday (50%) than three days ago (56%).
- It reads the visit count: people told a higher count get a higher chance (rank correlation 0.91).
- It ignores what does not matter: a sentence about the weather moves the chance by 0.9 points, and the 20-minute wait in other words by 1.2.
- It reads the sentence the multi-day loop writes for someone who turned away at the door (a sixth check, added and run afterwards, 495 requests): "found 9 people in line … and left without ordering" costs 24.5 points against an ordinary visit (−32.6 to −16.9), the same as waiting 20 minutes and then leaving. Whether the line was 9 people or 3 moves it by 2.4 points.

**It answers like measured customers on 12 of 16 published effects. None goes the wrong way.**

| Effect | Result | Verdict |
|---|---|---|
| Longer last wait | −9.2 points per 10 minutes (−11.2 to −7.2); 30 minutes against no line −28.9 | pass |
| Walked away against served | −10.0 at 20 minutes, −13.8 at 10 | pass |
| A 50-cent rise; a 50-cent cut | −4.3 (odds ×0.77); +5.4 (odds ×1.27) | pass |
| 8 of 10 stamps against 2 of 10 | +10.3; visits 15% closer together (study: about 20%) | pass |
| 20% off today, newcomers | +11.0 against a message with no offer (regulars: +7.9) | pass |
| First visit on a deal against at full price | +0.7 (−0.7 to +2.4): a deal buys a first visit, not loyalty | pass |
| Star rating, newcomers | +4.5 points per star, 13% more likely to come (study: 5 to 9% more revenue per star) | pass |
| A friend's remark, newcomers | good +20.3 (odds ×2.5), bad −4.9 (odds ×0.76) | pass |
| The same 15 minutes, ending fast against slow | +0.7 (−0.1 to +1.8) | no response |
| A rise hurts more than an equal cut helps | 50 cents: 4.3 down, 5.4 up. 1 dollar: 6.0 down, 7.8 up | no response |
| 2 free stamps of 10 against 0 of 8 | +0.1 (−0.3 to +0.6) | no response |

- **The four it misses are the three human biases in the list:** the peak-end rule, loss aversion (two tests) and the head start. Jev answers them as a calculator would: the same 15 minutes is the same, 50 cents up mirrors 50 cents down, and 8 purchases to go is 8 to go. On the odds scale they are still flat (×1.04, ×1.02, ×1.01).
- **Who reacts is sensible.** A 30-minute wait costs the most for the people in a hurry (Shanice −46, Karen −44, Lucy −39, Omar −38) and the least for Ellie, Priyanka and Tomas (−13 to −14). A 50-cent rise costs Bill 21 points ("dislikes change and notices it") and June 8, and nobody else more than 5. Stamps near the reward pull Tomas (+28) and Omar (+24), who look for deals, and do nothing for June, Marcus and Bill, who come anyway. The deal brings Omar (+40) and not Greta (+1), who prefers local places whatever the price.
- **Loss aversion shows in some people and is reversed in others.** Bill and June lose more from a rise than they gain from an equal cut. Omar, Tomas and Dev, who look for the cheapest option, gain more from the cut. Over the cast they cancel.

**Two cautions about size.**
- **The level is squeezed toward the middle.** Told only their visit count, people who come on half of weekdays or fewer are given 1.5 times the chance the count implies (Tomas: told 3 visits in 4 weeks, given 34%). People who come every weekday are given 0.9 times (85 to 90%). Used as it is, Jev's answer would make occasional customers come about half as often again as they do.
- **Waits may count for too much.** A 5-minute wait against no line already costs 11 points (odds ×0.61). No published figure gives a size per minute, so this is unchecked, and §16b found Jev turns away from lines more readily than real customers.

**It repeats.** A second full run gave the same verdict on all 21 scored tests, and no effect moved by more than 0.9 points.

**Limits.** One café, 12 written people, one wording per fact (one paraphrase checked), one model version. The intervals rest on 7 to 11 people. A pass means the direction is right and clear of noise; only the stamp and rating tests check a size, loosely.

**Decisions for the multi-day loop (made from these results; not yet reviewed by the team).**
1. **Jev is given these as words:** the last wait and how it ended (served or left), the date of each memory, up to three recent visits, the price against last week's, stamp-card progress, a message or deal from the shop, the star rating, a friend's remark, and the visit count.
2. **Three effects are rules in the runner, not Jev's:** how a wait ended (the evening update writes one remembered wait, weighted toward the worst and the last moment, and the "quick at the end" words are dropped), loss aversion (a price rise's shift is scaled up against an equal cut's), and the head start (a card that starts with free stamps gets the study's lift). Sizes come from the studies and are `[open]`.
3. **The level comes from the person, the change from Jev.** A person's chance today is their own usual rate (from the owner's data, or their group's), moved by the odds between Jev's answer for today's record and Jev's answer for their reference record: `logit(p) = logit(usual) + logit(jev today) − logit(jev reference)`. This keeps what Jev is good at, direction and who reacts, and removes the squeezed level. The reference answer is asked again only when the person's record changes.
4. **One ask per person per day.** At 1.2 points of noise an ask, averaging is not needed for a pool; results are still reported as ranges over seeds.
5. `[open]` The size of the wait effect needs a real number: the per-minute figures in de Vries et al., or an owner's data.

---

## 21. The multi-day loop: the same people over days (Nov 14)

**Why.** One run is one morning. Whether a change keeps customers or wins new ones shows only when the same people decide again the next day, with what happened to them in mind. §20 showed Jev reads that memory. This section runs it: a pool of people who persist, the morning question each day, the existing engine for the day, and memory written each evening. [REPEAT_CUSTOMERS_SPEC.md](../REPEAT_CUSTOMERS_SPEC.md) is the product spec.

**Everything here is unvalidated.** The size of the wait effect is unchecked (§20d), and every person's usual rate is an assumption until an owner's data replaces it. Results are reported only as the difference between a baseline and a change on the same seeds, as ranges, and under REPEAT_CUSTOMERS_SPEC §9b's bars.

### 21a. The pool file

`pools/<name>.json` holds what the engine cannot: who the people are between days.

| Field | Meaning |
|---|---|
| `world`, `shop` | The world file and the service place being studied. |
| `size` | People in the pool. Each is a copy of a cast member, drawn by the world's group shares, with their own record. |
| `people.<castId>.usualPerWeek` | How often this kind of person comes, in visits per 5-day week. An assumption until owner data replaces it. |
| `people.<castId>.knows` | Share of this kind of person who already come. The rest have never been inside. |
| `people.<castId>.weight` | How many of this kind of person the pool holds, against the world's group shares (default 1). A street has far more people who rarely or never come than one morning's arrivals show. |
| `people.<castId>.newcomer` | This person's bio allows putting them in the "has never been" state. |
| `people.<castId>.dayVisitor` | In town for one day: left out of the pool. |
| `ordinaryWait` | Minutes of an ordinary wait at the shop: what a person's usual rate already allows for. |
| `trialPerWeek` | How often someone who knows of the shop but has never been tries it, before Jev moves it. |
| `walkPast` | Chance per day that someone who does not know the shop notices it. |
| `tellReach` | People in the same group who hear one remark; may be a fraction (0.3: three remarks in ten reach one person). Jev has about 85% of visitors tell others, so a whole number floods the street. |
| `habit` | A new customer's rate as a share of their kind's usual rate after 1, 2, 3, 4 and 5 or more visits. The default follows the shape of the vendor visit ladder (REPEAT_CUSTOMERS_SPEC §2b). |
| `rules.lossAversion` | How many times further a price rise moves the odds than Jev says (§20d found none; 1 turns the rule off). |

### 21b. One day

`run/days.js`, `runDays({ pool, spec, days, seed, provider, change, centers })`. A day is a weekday morning; day 5 is the Monday after day 4, so "3 days ago" is counted on the calendar.

1. **Who hears of the shop.** Someone who does not know it may notice it walking past, hear of it from a remark, or be reached by a promotion.
2. **The morning question** (§20), for everyone who knows the shop. The person's chance of coming today is their own usual rate, moved on the odds scale:

   `logit(chance) = logit(usual) + (env − center) + factor × delta`

   - **`usual`** is `usualPerWeek ÷ 5`, at most 95% (nobody comes every single morning, and at 100% nothing could move them), times `habit` for a customer with fewer than 5 visits, or `trialPerWeek ÷ 5` for someone who has never been.
   - **Three records** are built for the person. *Today*: the visit count over the last 4 weeks, up to 3 visits remembered from the last 28 days, up to 2 remarks heard in the last 7 days, the price (with last week's while they have not yet paid the new one), stamp-card progress, and today's message from the shop. *Plain*: today without what the change adds (the changed price, the card, the message), which is what they would know this morning had nothing been changed. *Reference*: the same person on an ordinary day, with the same visits each replaced by an ordinary one (`ordinaryWait`, served) and no remarks.
   - **`env`** is how this morning's memories and remarks compare with an ordinary day: Jev's answer for the plain record against the reference record, as a difference in log-odds. When the two records are the same, Jev is not asked.
   - **`center` is the baseline's zero point.** A person's usual rate already allows for ordinary mornings, so an average morning must leave the number of visits where it is. Each morning `center` is the value at which the people who have an `env` are expected to make as many visits as at their usual rates. The baseline works it out; a change on the same seed reuses the baseline's. Without it the baseline drifted: a first live run gained 26% in three mornings, because most real waits are shorter than the reference wait and every such memory nudged people upward.
   - **There are two zero points each morning:** one for people who have been to the shop and one for people who have not. A friend's remark moves a newcomer far more than a regular (§20d: odds ×2.5 against ×1.3). With one zero point for both, the newcomers' remarks pulled every regular down to pay for them, and one seed's baseline grew 16%.
   - **`delta`** is what the change adds: Jev's answer for today's record against the plain one. It is not centred.
   - **`factor` is the loss-aversion rule:** `rules.lossAversion` when today's price is above the reference price, otherwise 1.
   - Jev's answers are cached by request, within a run and across the arms of a comparison, so the same person with the same record gets the same answer in the baseline and in the change. The draw that decides whether a person goes is also the same in both arms.
3. **The day runs on the engine.** The people who go are the day's arrivals, each at their own usual time, give or take 10 minutes. They walk to the shop first (they decided to go there); on seeing the line they may still walk away, to another place or home, as in any run. People who do not go are not simulated, so the other places hold only the people who turned away from the shop.
4. **The evening update.** Each visitor's record gets one remembered visit: the wait at the shop (to the minute when short, to 5 minutes from 10 up) and how it ended. A person who turned away on seeing the line remembers the line: "found 9 people in line at … and left without ordering". The probe checked that sentence (§20c): it costs 24.5 points against an ordinary visit, the same as waiting 20 minutes and then leaving. A served visit adds a stamp and sets the price they last paid. A remark made about the shop reaches `tellReach` people of the same group, and makes the shop known to any of them who did not know it.

- **Peak-end (rule).** A visit is remembered by its worst wait and its ending, served or left. Nothing else of the visit is kept.
- **The conservative run** (`rules.remember: "outcome"`, or `--remember outcome`). A served visit is remembered as an ordinary one whatever the wait, so only leaving without ordering is remembered. Leaving has a published direction (de Vries et al. 2018) and Jev's answer to it does not hinge on a number of minutes; the size of the wait effect is the unchecked part (§20d). Run both: the conservative run is a floor under the full one.
- **The head start is not modeled.** Jev gave no response to it (§20d) and no published size per day exists. A stamp card can be tested; a head start on it cannot yet.
- **The engine changes by one option.** `new Sim(spec, { arrivals: [{ t, persona, first, tag }] })` replaces the random schedule with a list: when each person arrives, which cast member they are, the place they walk to first, and a tag that comes back in `agentsSummary()` with their line log (`lines: [{ place, wait, ahead, outcome }]`). Without the option nothing changes (tested: the same agents, no new fields).
- **With the rule model** nobody reads memory: the chance is the usual rate, and the loop is a dry run of the plumbing.
- `[open]` **Nobody lapses except through Jev.** A customer stops coming only when their memories move them. People who discover the shop are added and nothing takes people away, so a long baseline grows slowly; `walkPast` is set low to keep that inside the steadiness check.

### 21c. Changes and results

A change is `{ from, to, patch, card, promo }`: a what-if patch (§15: staff, price), a stamp card (`{ need, reward }`), or a promotion (`{ text, priceOff, reach }`), in force on days `from` to `to`. `compareDays` runs the baseline and the change on the same seeds.

Per arm and seed: visits, first-time visitors, people served, walk-aways and the average wait per day; and over the run, visits per week, first-time visitors per week, first-timers who came back, regulars (3 or more visits in the last 10 days), and good and bad remarks. The effect of a change is the difference from the baseline seed by seed, given as a range, with whether every seed agrees in direction.

**Realism checks on the baseline** (level 2 of REPEAT_CUSTOMERS_SPEC §9), printed with every run:
- Visits are lopsided: the busiest fifth of customers make at least 40% of the visits.
- The baseline holds steady: visits in the second half of the run are within 15% of the first half. A drift means the loop loses or gains customers by itself, which is a calibration error, not a finding.
- New customers come back less often than established ones.

Run it: `node bin/swarm.js days pools/alder-pine-cafe.json --days 10 --seeds 3 --provider jev --change staff+1 --out data/days/cafe.json`. Changes: `staff+1`, `price+0.5`, `promo20`, `card10`, several at once separated by commas. `--baseline-from <earlier --out file>` reuses saved baselines so only the changes are run; `--remember outcome` is the conservative run. Results go to `data/days/` (not committed). One simulated morning of this café costs about 1 cent and takes about 8 seconds with Jev.

### 21d. One day or several: how the AI knows which to run

**Why.** The two kinds of run start their people differently. In a one-day run every arrival is a new copy of a cast member with no past, drawn at random from the world's arrivals. In a multi-day run the same people persist in a pool, each with a usual rate and a record, and are asked a different question (`visit_today`) before each day. So a one-day run cannot answer "will they come back", and a question about one rush does not need a pool. Whoever chooses the test has to choose by the question.

- **The rule is written once,** in `run/timescale.js`. `TIMESCALE_RULE` is the rule in words: one day for what happens on the day (lines, waits, walk-aways, where people go, staffing at a rush, layout, an offer made that day); over days for anything about later days (coming back, regulars and loyalty, new customers, word of mouth, a remembered price change, what a promotion leaves behind, a stamp card). `timescaleOf(question)` is the same rule as a keyword check, `{ scale: "day" | "days", matched }`, for a page that has no model.
- **The advisor** (§15, `run/advisor.js`) has the rule in its instructions and a second test, `test_over_days({ label, why, change: staff | price | promotion | stamp_card, value })`, beside `test_change`. Its first message says whether the test over days can run for this world, and if not, what is missing. The tool is offered, and `testsOverDays` returned, only for a world with a pool; for every other world the request and the advice are what they were.
  - It needs a pool: `advise({ pool })`. `swarm advise <world>` passes the file in `pools/` whose `world` is that world.
  - It needs Jev. It uses the experiments' provider if that is Jev, else the confirming one, else a new one when a key is set. The rule model does not read memory, so with no Jev the tool refuses and the model must say so under what it could not test.
  - It is limited to 1 per round by default (`maxDaysTests`, at most 3), on the first 3 seeds for 10 mornings. The baseline is run once and reused.
  - It returns each measure's before, after, range across seeds and whether every seed agrees, with the instruction to report direction and range only and to say the sizes are unvalidated. Results are in the advice as `testsOverDays`, cited "test over days W1".
- **The Claude Code advisor** (`.claude/commands/advise.md`) has the same rule and the `swarm days` command.
- **The dashboard** does not use the rule yet: a typed question there does not change what is simulated.

### 21e. The sushi restaurant is the real case (Nov 14)

**Decision (Josh).** The café was a stand-in. The business the team interviewed is the sushi restaurant, so loyalty is studied there. The café's pool and results stay as the first check of the method.

**What changed to fit a restaurant.**
- **One business, several places.** A pool may give `places` (here the counter and the table), with a `name`, in place of `shop`. The morning question names the business once, at the average of its prices. People are not sent to one place: on arriving they choose the counter or the table as in any run. A visit is remembered from whichever place they waited at.
- **Seats, not a line.** `seated: true` words a memory as "waited about 20 minutes for a seat at the sushi restaurant, then was seated", "…then left without eating", "found 5 people waiting for a seat … and left without eating", "no wait …, seated right away".
- **A day is a Friday evening.** `daysPerWeek: 1`, `dayName: "Friday evening"`: one simulated day is one Friday, memories are a week apart, and "per week" numbers are per Friday. `regular: { visits: 2, days: 4 }`: a regular came on at least 2 of the last 4 Fridays.
- **The pool** (`pools/sushi-restaurant.json`, 752 people) is written to fill the room as the one-evening world does: about 36 people a Friday in its group shares. Each kind of person's weight is 1 ÷ (share who already come × how often they come), so the many people who come rarely are in it. Sam and Tom are in town for one night and are left out. Every rate is an assumption.
- **Changes:** `promo20`, `price+2`, `card10`, and `seats+2` (two more seats at the first place; `staff+N` is the same lever at a counter). A promotion lowers the price for everyone who comes and is told once as a message.

**The memory check in dinner words** (`node validation/jev-return-probe.js --place sushi`; 359 questions asked 5 times, 1,795 requests, about 5 cents; 8 returning diners, 5 who have never been). 13 of 16 published effects pass, none goes the wrong way.

| | The sushi restaurant | The café (§20d) |
|---|---|---|
| A very good against a very bad last visit | +31.4 points | +34.9 |
| Last wait of 0, 5, 10, 20, 30 minutes | 67, 70, 68, 63, 59% | 69, 58, 51, 43, 40% |
| A 30-minute wait against none | −8.4 | −28.9 |
| Waited 20 minutes and left, against served | −27.6 | −10.0 |
| Turned away at the door, against an ordinary visit | −42.3 | −24.5 |
| A price rise of one step ($2; 50¢) | −1.2 | −4.3 |
| 20% off today: people who have never been; regulars | +1.2 (unclear); 0.0 | +11.0; +7.9 |
| A friend's good remark, people who have never been | +13.0 | +20.3 |
| Stamps at 8 of 10 against 2 of 10 | +3.7 | +10.3 |

- **Here, waiting for a seat is forgiven and going home unfed is not.** Thirty minutes for a seat costs 8 points; being turned away at the door costs 42.
- **Price and the promotion do almost nothing,** which agrees with the dashboard's own test of the promotion (§18: no clear difference in people seated).
- **The same fact in other words moved the answer by 9.7 points** ("stood waiting for a seat for around twenty minutes … before sitting down"). At the café it moved 1.2. So Jev is more sensitive to wording here, and differences under about 10 points between differently worded memories should not be read.
- The head start on a stamp card and a friend's bad remark gave no clear response.

**Two more changes for the loop (Nov 14, late evening).**
- `faster15`: each meal at the first place (the counter) takes 15% less time, so more diners get through the same seats in an evening. For an owner this is a shorter set menu at the rush. It is the `serviceTime` lever.
- `sorry`: a card for anyone turned away: "the sushi restaurant: sorry we could not serve you last time. Come back within two weeks for a free roll." It is told, as a message from the shop, to each person whose last visit ended without a seat, for two weeks after it. Only a run over days can test it, because only the loop knows who was turned away last Friday. Jev's answer to the card is not given a size rule; it is used as it comes, through the zero points of §21b.
- **The card's words were checked first** (`--place sushi --only left,wait`, 440 requests, about 1 cent). The chance of coming the next Friday, averaged over 8 returning diners: an ordinary last visit 70%; turned away 28%; turned away and sent a plain message 26%; turned away and sent the card 48%. The card against the plain message: +22.0 points (19.3 to 24.8), and every one of the 8 diners moved up, by 16 to 28 points.

**Two months at the sushi restaurant** (`node bin/swarm.js days pools/sushi-restaurant.json --days 8 --seeds 3 --provider jev --change promo20,seats+2`; 8 Fridays, 3 seeds, 7,996 Jev requests, about 31 cents). Numbers are per Friday, averaged over the 8, as baseline → change, with the range of the difference across seeds. Unvalidated, as everything in §21.

| | Baseline | 20% off on the first Friday, heard of by half the street | Two more counter seats |
|---|---|---|---|
| People who came | 37 | 42 (+4 to +6) | 38 (no clear change) |
| People seated | 24 | 24 (+0 to +1) | 28 (+4 on every seed) |
| People turned away or who gave up | 9 | 12 (+3 on every seed) | 7 (−2 to −1) |
| First-time visitors | 1 | 5 (+4 to +5) | 1 (no change) |
| Average wait for a seat | 8.0 min | 8.9 min (+0.2 to +1.4) | 6.6 min (−2.1 to −0.9) |
| Regulars (2 of the last 4 Fridays) | 24 | 21 (−5 to 0: no clear change) | 24 (−3 to +4: no clear change) |
| Bad remarks | 22 | 25 (+2 to +4) | 17 (−7 to −1) |

- **The promotion fills the doorway, not the room.** It brought about four more people per Friday on average, nearly all first-timers on the night itself, and the eight seats were already full: one more person was seated and three more were turned away. It made no more regulars; on two of three seeds it made fewer.
- **Two more seats seat four more people every Friday** and turn fewer away, on every seed. Over eight Fridays the number of regulars did not clearly change.
- **One seed's baseline grew 27%** and fails the steadiness check, so changes in how many people came are the weakest numbers here. Seated, turned away and the wait come from the evening itself and do not depend on it.

**Two months, all four changes** (`--change promo20,seats+2,faster15,sorry`, 8 Fridays, 3 seeds, 11,206 Jev requests, about 43 cents; results in `data/days/sushi-all.json`). Per Friday, baseline → change; "unclear" where the seeds disagree.

| | Baseline | 20% off, first Friday | Two more seats | Meals 15% quicker | Card for people turned away |
|---|---|---|---|---|---|
| People seated | 23 | 24 | 28 (+4) | 25 (+2) | unclear |
| Turned away or gave up | 9 | 12 (+2 to +3) | 7 (−2 to −3) | 8 (−1 to −2) | unclear |
| Average wait for a seat | 8.1 min | 9.2 | 6.2 | 7.6 | 8.3 |
| First-time visitors | 1 | 6 (+4 to +5) | 1 | 1 | 1 |
| Regulars (2 of the last 4 Fridays) | 24 | unclear | unclear | unclear | 26 (+0 to +5, unclear) |
| Bad remarks | 23 | 27 | 15 (−6 to −9) | 21 | 25 |

- **No change clearly made more regulars over eight Fridays.** The card comes closest (+2 on average, 0 to +5), but not on every seed. The pool's regulars come every week anyway; the turned-away diners the card reaches are mostly occasional diners, and the room is still full when they come back.
- **Seats beat speed.** Two more seats seat about 4 more diners every Friday and cut bad word of mouth by a third; meals 15% quicker seat about 2.
- **The promotion stays the worst:** it brings first-timers on one Friday, mostly to be turned away.
- One seed's baseline grew 22% and fails the steadiness check; seated, turned away and the wait come from each evening and are the firmer numbers.


### 21f. The loyalty buttons on the sushi page (Nov 14)

**What the owner sees.** At the sushi restaurant (`/scope/?case=sushi`) the panel at the top of the side panel opens on one sentence and three buttons.

- **The sentence** comes from the run on screen: "12 of 36 people did not get a seat. Being turned away is what stops diners coming back, far more than a wait or the price. Try seating more of them before discounting." The reason is the memory check of §21e: being turned away costs 42 points, a 30-minute wait 8, a $2 price rise 1.
- **The buttons:** Two more seats, Faster turnover at the counter, A card for people you turn away. Each shows the saved result of two months of the same diners with that change (§21, §21e), in the same panel, with "Back to the changes".
- **The promotion test stays, one step down.** Under the buttons is "Test the promotion", or "See the promotion test" when one was run. A promotion test's result still opens first when the run on screen belongs to one, with "Other changes to try" under it. The building page, a changed room and Run details are as before.

**One result.**
- **The headline** names the change and states only what every run agrees on, in this order: people seated, people turned away or giving up; if neither, the wait for a seat; if not that, first-time visitors. When nothing agrees it reads "no clear change in who gets a seat".
- **The second line is always the regulars:** the change with its range when every run agrees, "no change", or "no clear change (24 before, 24 after; the runs disagree)".
- **The table** has people seated, turned away or gave up, average wait for a seat, first-time visitors and regulars: before, after, and the change as a range across runs. Where the runs disagree the change reads "no clear change".
- **Under it:** what a regular is ("A regular came on at least 2 of the last 4 Fridays", from the pool), and one caution line: simulated diners, assumed visit rates, who decided, sizes not validated, read the direction and the range.
- The main view never says "seed", "requests" or "pool".

**Where the results come from.** `GET /api/days?pool=pools/<name>.json` returns the saved results for that pool: `{ pool, found, meta, results }`.
- It reads every file in `data/days/` (not committed) that was made from the pool and keeps one result per change label, the newest file's. Each result has `label`, `days`, `runs`, `provider`, `createdAt`, `file` and `effects` (per metric: `before`, `after`, `mean`, `min`, `max`, `agrees`). `meta` is the day name, days per week, the pool's definition of a regular and the shop's name.
- The runs themselves stay on the server; the files are megabytes.
- It only reads. The pool must be named `pools/<name>.json`; anything else is a 400, and no file outside `data/days/` is opened.
- The page asks once, when a button is first pressed. The case names its pool in `web/scope/mock/index.json` (`"pool": "pools/sushi-restaurant.json"`); a case without one has no buttons.

**Matching a button to a result** is by the label the days command writes: `/more seat/i`, `/quicker|faster/i`, `/turned away/i`.

**A result that is not saved on this computer** says so and shows the command, for example `node bin/swarm.js days pools/sushi-restaurant.json --days 8 --seeds 3 --provider jev --change seats+2 --out data/days/seats.json`. All four at once: `--change promo20,seats+2,faster15,sorry --out data/days/sushi-all.json` (about 43 cents and 11,000 Jev requests). Results are saved per computer, so a teammate's numbers differ a little: Jev does not answer the same question the same way twice.

**Code.** `run/days-saved.js` (reading and merging), `server/server.js` (`getDays`), `web/scope/lib/loyalty.js` (the words and the table, no DOM), `web/scope/lib/verdict-panel.js` (`choices`, `saved`), `web/scope/app.js` (`showChoices`, `showSaved`). Tests: `test/server-days.test.js`, `test/loyalty.test.js`.
