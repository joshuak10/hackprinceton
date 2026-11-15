# General environment engine

Swarmscope can model operational workflows without coding a new simulator for each domain.
Users supply the environment, guidelines, objectives and constraints. Claude or Codex builds a
declarative definition; Jev chooses actions for each actor; the runtime owns every state mutation and resource
reservation. The existing spatial crowd engine remains separate and compatible.

## Start in Scope

Run `npm install`, then `npm run serve` and open `http://127.0.0.1:4173/scope/?mode=environment`.
Custom environments reuse the original Scope layout and theme: prompt bar, canvas, right-hand
metrics and incidents, and playback timeline. Definition editing and guidelines live in the
Environment drawer, alongside the builder selector. `/studio/` opens the same interface. Workflow
states are drawn as a logical layout, not as an inferred floor plan; physical cases still use their
existing geometry.
Build from a brief, use a bundled example, or import a definition. Inspect the roles, resources,
action graph and assumptions before running. Choose Jev for language-driven decisions or rules
for an offline baseline. Jobs report real progress and can be cancelled. Saved runs provide
state playback and individual decision inspection without further model calls.

The health endpoint advertises `capabilities.environments: 1`. If the frontend detects an older
server, it asks you to restart `npm run serve` and reload. Both `npm run serve` (4173) and
`npm run web` (4174) provide the full API. Reloading a page cannot update a Node process that was
started before its routes changed.

The included environments demonstrate two unrelated domains:

- [`incident-response.json`](../environments/incident-response.json): investigations, customer
  updates, reviewed fixes, escalation and a shared production change window.
- [`warehouse-fulfillment.json`](../environments/warehouse-fulfillment.json): picking, limited
  stock, packing capacity, standard/express shipping and order cancellation.

## Build from your own brief

A brief is JSON with four fields; only `description` is required:

```json
{
  "description": "An equipment repair team processes urgent and routine tickets.",
  "guidelines": ["Investigate before replacing equipment.", "Escalate ambiguous failures."],
  "objectives": "Measure completed repairs, escalation count and remaining workload.",
  "constraints": "Two diagnostic benches and one specialist. Each actor represents one ticket owner."
}
```

```sh
node bin/swarm.js env-build --brief data/repair-brief.json --out data/repair-team.json
node bin/swarm.js env-validate data/repair-team.json
node bin/swarm.js env-run data/repair-team.json --provider rules --seed 7
node bin/swarm.js env-run data/repair-team.json --provider jev --seed 7 --max-requests 2000
node bin/swarm.js env-runs --json
```

Alternatively pass a description directly. `--guidelines FILE` adds one guideline per line;
`--objectives TEXT` and `--constraints TEXT` set those brief fields. `--out` exports a plain
definition; the original brief and builder metadata are also saved in the local library.
Existing output files require `--force`. `--json` keeps stdout machine-readable and progress
on stderr. `env-run` accepts either a plain definition or a saved library artifact.

`env-examples` lists bundled IDs. For example:

```sh
node bin/swarm.js env-examples warehouse-fulfillment --out data/my-warehouse.json
node bin/swarm.js env-run data/my-warehouse.json --provider rules
```

### Builder backends

The default `--backend claude-code` uses an installed, authenticated Claude Code CLI. It runs
headlessly in a temporary directory, with tools, MCP servers, skills, hooks and project settings
disabled. The model can write only structured output; it never edits this repository or executes
generated code. `SWARM_CLAUDE_BIN` selects the executable, and `--model` or `SWARM_BUILDER_MODEL`
selects a model. Without an override the CLI chooses its default. Provider credentials configured
only inside user settings must instead be supplied through the environment for this isolated job.

`--backend codex` uses the installed, authenticated Codex CLI via `codex exec`. Use `codex login`
if needed. It runs noninteractively in a temporary directory with a read-only sandbox; command
execution, integrations, rules and user configuration are disabled. Some built-in tools may remain
available within the sandbox. `SWARM_CODEX_BIN` selects its executable;
`--model` or `SWARM_CODEX_MODEL` selects its model. Without an override the CLI chooses its default.
`SWARM_BUILDER_MODEL` does not affect Codex.

If Codex reports that the model needs a newer CLI, update the executable or point `SWARM_CODEX_BIN`
to a current installation. If its default model is unavailable for your account, choose an
available model in the drawer's Model field, pass `--model`, or set `SWARM_CODEX_MODEL`. These
failures are reported separately from authentication problems. Restart the server after changing
`.env.local` so it loads the new settings.

Codex's strict output schema uses an `environment_json` string envelope around the generated
definition. The builder unwraps it and validates the same canonical environment contract used by
Claude, including references and mechanics. This transport does not change saved definitions,
simulation behavior or the repair loop. The CLI and Studio record the selected backend in saved
builder metadata; a null requested model means the CLI chose its default.

`--backend anthropic` uses `ANTHROPIC_API_KEY` and the existing compiler model default. The same
Claude model override applies. `TYPESAFE_API_KEY` is needed only for Jev simulation, not for
building or offline rules runs. No builder is called when loading an existing definition.

Builds validate the generated definition and feed errors back for up to three attempts. Each
attempt has a three-minute deadline. Cancellation terminates the child process or aborts the
SDK request. A missing CLI, unavailable model or missing credentials produces an explicit error;
there is no silent switch to a different builder. See [the builder contract](../generalist/BUILDER.md).
Known `--json-schema` preflight failures are reported as schema compatibility errors, separately
from authentication failures. The canonical draft-07 schema is accepted by the verified Claude
Code 2.1.286 path; the former draft-2020-12 declaration was rejected before generation began.

## Definition and execution contract

[`generalist/schema.json`](../generalist/schema.json) describes the JSON structure using JSON
Schema draft-07, `definitions` and local references for Claude CLI compatibility.
[`generalist/spec.js`](../generalist/spec.js) additionally checks references, compatible state
types, declared workflow-state references and resource claims. Unknown fields and executable extensions
are rejected rather than silently interpreted.

| Field | Meaning |
|---|---|
| `version`, `title`, `description`, `ticks` | Contract version 1, scenario and finite duration; describe the real-world meaning of a tick explicitly |
| `guidelines`, `assumptions` | Agent-facing guidance and declared modeling assumptions |
| `world` | Shared scalar state visible to all agents |
| `roles` | Actor counts, names, goals, starting workflow state and initial scalar attributes |
| `resources` | Shared resources with enforced capacity |
| `actions` | Role/state eligibility, conditions, duration, resource claims, destination state and effects |
| `metrics` | Numeric world/agent attributes aggregated with sum, mean, minimum or maximum |

Each tick, available actors observe the same pre-decision state. Jev receives the actor's role,
goal and attributes; the guidelines; shared state; population counts; resource availability;
and only the actions currently eligible. The runtime samples Jev's probabilities with a seed.
Actors reserve resources in seeded priority order, so simultaneous choices cannot overbook a
resource. An actor whose choice loses contention waits for the next tick.

An action holds its resources for its duration. At completion, requirements are checked again,
effects commit atomically, the workflow state changes, and resources are released. This prevents
two concurrent stock-consuming actions from both succeeding when only one unit remains, provided
the definition includes the stock requirement. Without any eligible action an actor waits; without
any applicable transition it is terminal. To allow deliberate waiting when other choices exist,
define an explicit one-tick action that returns to the same state.

Hard rules need executable representation: required review becomes a workflow state or attribute
condition; simultaneous work uses resource claims; spending requires a balance condition before
subtracting a cost. Prose such as “never overspend” alone is guidance, not a guarantee. Rules runs
use declared action weights and do not understand textual guidelines or goals. Jev failures and
request-budget exhaustion fall back to rules and remain labeled in decisions and run metadata.

The seed fixes sampling and priority. A rules run with the same definition and seed is repeatable;
fresh model responses may differ across live Jev runs. Saved playback uses recorded state rather
than requesting decisions again. The existing crowd engine's replay CLI is not a general-engine
decision replay API.

## Local HTTP API

All routes are under `/api/` and served by `npm run serve`. JSON POST bodies use the existing
same-origin and localhost protections. The server permits one active environment build and one
active environment run; additional jobs receive a conflict response.

| Method and path | Request/result |
|---|---|
| `GET environment-examples` | `{ examples: [{ id, title, spec }] }` |
| `GET environments` | `{ environments: [...] }` |
| `GET environments/:id` | Full saved artifact, including spec, brief and builder metadata |
| `POST environments` | `{ spec, brief? }` → saved artifact |
| `POST environment-builds` | `{ brief, backend?, model? }` → async job; backend is `claude-code` (default), `codex` or `anthropic` |
| `GET environment-jobs/:id` | Job status: queued, running, done, error or cancelled; progress and result IDs |
| `POST environment-jobs/:id/cancel` | `{}` → cancellation requested |
| `GET environment-runs` | `{ runs: [...] }` |
| `POST environment-runs` | `{ environmentId, provider, seed?, maxRequests? }` → async job |
| `GET environment-runs/:id` | Run metadata, captured definition and recorded result |

Run defaults are `provider: "rules"`, `seed: 7`, `maxRequests: 2000`; the request budget permits
0–20,000. A completed build supplies `environmentId`; a completed run supplies `runId`. Jobs
interrupted by a process restart are reported as errors rather than left apparently running.
Studio can browse active runs owned by a separate CLI process; cancellation must be requested
from the process that started the job.

## Audit artifacts and limits

Everything user-specific is stored under gitignored `data/`:

- `environments/<id>.json`: normalized spec, content hash, original brief, assumptions, warnings
  and builder metadata.
- `environment-jobs/<id>.json`: build/run status, timestamps, progress and result references.
- `environment-runs/<id>/meta.json`: captured environment, seed, provider, request budget,
  provenance and fallback rate.
- `environment-runs/<id>/result.json`: final state, metrics, agents, sampled frames, events,
  observations and complete decisions. Failed/cancelled runs preserve partial results when available.

Definitions are bounded to 512 KiB, 20 roles, 500 total actors, 100 actions, 50 resources, 1,000 ticks and
20,000 decisions. The decision trace has a 64 MiB budget; exceeding it stops the run and retains its
partial results. Playback stores at most 121 regular frames; cancelled runs may include a final
partial frame. These bounds control memory, runtime and model-call exposure. They are not evidence
that a generated model accurately represents a real organization.

This first general engine has public shared state and role-based actors. It does not support
arbitrary code, external side effects, private agent-to-agent messaging, continuous physics,
automatic model calibration or automatic proof that prose constraints were represented faithfully.
Spatial simulation still belongs to the visit/route engine. Inspect assumptions and transitions,
compare multiple seeds and check meaningful conclusions against real observations.

Automated checks use offline provider and process doubles for builder repair, CLI isolation,
timeouts, cancellation, Unicode output, state invariants, resource contention, persistence and
HTTP behavior. They also compile the actual CLI schema with a draft-07 validator. Those tests
make no live model calls. Separately, on Nov 14, 2026, the full authenticated Claude Code 2.1.286
builder generated and validated a tiny two-worker environment on its first attempt after the
schema correction. Saving that definition and running it through the HTTP API with rules produced
two completed tasks across three ticks and four recorded frames. The exact Codex builder path
also generated and validated a two-worker, three-tick environment on its first attempt using
Codex CLI 0.169.0-alpha.11.1 and `gpt-6-astra`, including the documented isolation flags and strict
output envelope. A separate browser check built through Scope with Codex, ran the definition with
rules, and verified two completed tasks, replay, agent inspection and restored builder/model
selection after reloading the saved run. These checks do not verify Jev predictions.
