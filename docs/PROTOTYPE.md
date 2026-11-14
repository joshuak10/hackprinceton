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
bin/swarm.js          CLI
server/server.js      startServer({ port, root }) local HTTP API + static viewer
web/index.html, web/app.js, web/style.css   viewer
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
| `long` | visit: has waited > tolerance and > 10 min, once per line visit | `keep_waiting` Noul | `next_place`, `frustration`, `tell_others` + `remark_kind` about this place |
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
- `long`: yes means keep waiting, and the line limit is extended by one tolerance. No means give up (if still in line), then go to the sampled place or leave.
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

`runSeeds({ spec, seeds: [..], provider, ... })` → `{ runs: [...], summary }`. The summary gives the mean and standard deviation of the headline KPIs and the bottleneck ranking frequency (how often each place is #1). `compareRuns({ spec, patch, seeds, provider })` → `{ applied, skipped, before, after, delta }`, where each side's KPIs are averaged over the same seeds.

**Headline KPIs:**
- visit: `abandonRate`, `avgWait`, `served`, `abandoned`, `spawned`, top-3 bottlenecks by score.
- route: `avgTrip`, `avgDelay`, `arrived`, top-3 edges by delay minutes.

**Recorder:** `createRecorder({ root = 'runs', spec, seed, providerName, label })` creates `runs/<runId>/` with `runId = <slug(title)>-<provider>-s<seed>-<YYYYMMDD-HHMMSS>`.
- `rec.decision(req, decision, applied)` appends one JSON line to `decisions.jsonl`: `{ id, t, clock, agentId, personaId, kind, why, placeId, options, asks, observation, auto, decision, applied }`. The `decision` field omits nothing except `answers` when `provider === 'rules'`.
- `rec.finish({ sim, metrics, providerStats, status: 'done' | 'error', error })` writes:
  - `meta.json`: `{ runId, createdAt, status, error, title, question, mode, duration, clockStart, seed, specHash, provider, model, decisions, agents, providerStats, simOpts }`
  - `spec.json`: the normalized spec
  - `metrics.json`: `sim.metrics()`
  - `frames.json`: see below
  - `agents.json`: `[{ id, personaId, personaName, archetypeId, informed, served, waitTotal, abandons, frustration, born, done, trace: [{t, m}] }]`
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

`sim.metrics()` keeps the prototype's shape, and adds:
- `remarks: { total, byKind }`
- `decisions: { total, byProvider: {...}, byKind: {...} }`
- `frustration: { avg, byArchetype }`

`minds` is removed.

---

## 8. CLI (`bin/swarm.js`)

Calls `loadEnv()` first. The world argument is a path to JSON or an example name (`theme-park`, `er-network`, `rush-hour-roads`, resolved from `worlds/`). Commands print compact human-readable text by default and JSON with `--json`.

```
swarm validate <world>
swarm estimate <world> [--seed 7]                    # rules-external run: counts decision requests → est. Jev requests, tokens (~900/request), cost
swarm run <world> [--provider jev|rules|replay] [--seed 7] [--seeds N] [--model jev-latest] [--concurrency 32]
                  [--max-requests 20000] [--batch-window M] [--patch patch.json] [--from <runDir>] [--out runs] [--no-record]
swarm compare <world> --patch patch.json [--provider rules|jev] [--seeds N]
swarm report <runDir|runId>                          # markdown digest for Claude: KPIs, bottlenecks, remarks, per-archetype outcomes,
                                                     #   torn decisions (top-2 choice probs within 0.15), provider stats
swarm agent <runDir|runId> <agentId>                 # one agent's persona, decisions with probabilities, trace
swarm runs                                           # list recorded runs
swarm compile "<description>" [--out worlds/<slug>.json]   # needs ANTHROPIC_API_KEY; without it, prints how to use /swarm in Claude Code
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
POST /api/runs         { world?: file, spec?: object, seed?, provider: 'rules'|'jev', model?, maxRequests?, batchWindow? }
                                      → { runId }   (starts in background; one jev run at a time → 409 if busy)
GET  /api/runs                        → listRuns
GET  /api/runs/:id/status             → { state: 'running'|'done'|'error', t, duration, decisions, providerStats, error }
GET  /api/runs/:id/meta|spec|metrics|frames|agents|remarks
GET  /api/runs/:id/decisions           → decisions.jsonl as one JSON array (for the scope display)
GET  /api/runs/:id/incidents           → incidents.json if the run has one, else 404
GET  /api/runs/:id/agents/:agentId    → { agent, decisions: [...] }   (decisions filtered from decisions.jsonl)
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

## 10. Compile, schema, slash command, MCP

- `worlds/SCHEMA.md`: the world format for humans and Claude. Every field with type, range and default, both modes, how to write a good cast (10–20 people with concrete situations, constraints, loyalties, who they listen to, app or not), how to set patience and `needs`/`tags`, and one compact example per mode. `worlds/schema.json`: the same as JSON Schema (draft 2020-12), used as the Claude tool input schema.
- `compile/compile.js` `compileWorld(description, { apiKey, model, maxAttempts = 3 })` uses `@anthropic-ai/sdk`. It forces a `submit_world` tool call whose `input_schema` is `worlds/schema.json`, then runs `validateWorld` and feeds errors back until it's valid or out of attempts. It returns `{ spec, attempts, warnings }`. Without a key it throws an error whose message explains the `/swarm` path.
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
| `edges[].via` | Route mode, optional array of ≤ 12 `{ x, y }` waypoints. The edge's shape is the polyline from → via… → to. |
| `provenance` | Optional object (≤ 300 keys) mapping a field path to `data`, `vision`, `assumed` or `owner-reported`. Kept as-is. |

Rules checked by `validateWorld` (all are errors unless noted):
- Every node is at least 0.05 units from every wall.
- Route mode: no edge polyline touches a wall. The message names the edge and the wall index.
- Visit mode: every service node is reachable on foot from at least one entry, and at least one exit is reachable from every service node.
- More than 4000 walls is an error. Zero-length walls are dropped and out-of-range coordinates are clamped, each with a warning.

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
- Every gate and place is converted to map units and checked: at least 0.3 m from every wall, and reachable on foot from at least one gate. A failed check is an error that names the item.
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
- Known gap in `engine/walls.js`: a path can pass a wall end closer than `clearance`. It never touches the wall, so the hard rule holds; it only affects how tightly dots hug corners.
- **Door gaps (integration, Nov 14).** Builders pull each door's ends in from the jambs (by up to a quarter of the clearance) so a door never touches a wall, and nav may round a jamb closer than that (the known gap above). On the real building, walks between the food hall and the market rounded the pier between the two front doors inside that pull-in, and the market main entrance counted 97 of about 430 crossings. The Sim now counts each door on its gap (§14d, "Door traffic"): the drawn segment, with each end that stops short of a wall (within max(0.3, clearance) units) carried on to that wall plus 0.02. Paths never touch walls, so the part along a jamb is never crossed. A door end already on a wall, or with no wall in reach, is used as drawn; `frames.doors` and the viewer still show the drawn segment. Worlds without walls or doors are unchanged.
- **Real-building check (Nov 14).** `6FNMVoyPrL1` Floor 1 with `buildings/6FNMVoyPrL1/fitout-floor1-lunch.json`: the independent no-through-wall check (own segment intersection, frames every 0.01 min) found 0 crossings and nobody inside the sealed 32.6 m² void in the food hall. Door counts on the gaps match an independent count from those frames door for door.
