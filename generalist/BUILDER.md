# Environment builder

`buildEnvironment(brief, options)` turns a user brief into the declarative contract in
[`schema.json`](schema.json). It validates references and mechanics with `validateEnvironment`
and gives the generator up to three attempts, including validation feedback after a failed attempt.
It returns `{ spec, brief, attempts, warnings, builder }`. The builder never runs the simulation.

The brief is `{ description, guidelines, objectives, constraints }`. Only `description` is required.
Guidelines can be an array or one rule per line. Original guidelines are retained in the resulting
spec and supplied to each agent. Objectives guide metric selection; constraints must be represented
by state conditions, resource claims and transitions to be enforced. Text alone is advisory.
Generated assumptions explain missing inputs and mechanisms that cannot be represented.

Three backends are available:

- `claude-code` (default): uses the installed `claude` executable and its normal authentication.
  `SWARM_CLAUDE_BIN` can point to an executable; `SWARM_BUILDER_MODEL` selects a model. Without a
  model override Claude Code chooses its default. Explicitly configured provider credentials must
  be supplied through the environment, because user/project settings are disabled for this job.
  Check login with `claude auth status`; use `claude auth login` if it reports no authentication.
  A Claude Code subscription login works without a separate `ANTHROPIC_API_KEY`.
- `codex`: uses the installed `codex` executable and its normal authentication. Use `codex login`
  if needed. `SWARM_CODEX_BIN` can point to an executable; `model` or `SWARM_CODEX_MODEL` selects
  its model. Without an override Codex chooses its default. `SWARM_BUILDER_MODEL` does not affect
  Codex. User configuration is disabled for this isolated job.
- `anthropic`: uses `ANTHROPIC_API_KEY` and the repository's existing compiler model default,
  overridable by `model` or `SWARM_BUILDER_MODEL`.

The Claude Code command uses `claude -p --output-format json --json-schema …`, with safe mode,
an empty tool list, disabled slash commands, no loaded settings, an empty strict MCP config,
`dontAsk` permission mode, and no session persistence or Chrome connection. It starts in a fresh
temporary directory and receives the brief through stdin. No shell interpolation, generated
program execution, permission bypass, user-provided executable, or user-provided CLI flags are
accepted through the application API. These flags were verified with the installed CLI's help;
older Claude Code versions without them must be upgraded.

The Codex command uses `codex exec --json --output-schema <temporary envelope schema> -`, with
the brief on stdin. Its strict transport schema requires one `environment_json` string containing
the complete definition; this preserves user-defined state keys that do not fit a strict object
schema. The builder unwraps that string and validates the canonical environment schema and
mechanics, with the same repair loop as Claude. The envelope is never the saved environment format.

Codex runs with `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, `--strict-config`,
`--sandbox read-only` and `--skip-git-repo-check`. Command execution, apps, plugins, hooks, subagents,
browser/computer use, image generation, memories, goals and tool suggestions are disabled. Config
overrides disable web search, project instructions, skills and MCP, and set noninteractive
`approval_policy=never` with `approvals_reviewer=user`. Built-in planning, image viewing or patch
tools may remain available; the read-only sandbox blocks filesystem changes. This is restricted
tool access, not a blanket no-tools guarantee.

Both CLI integrations spawn the installed executable directly in a fresh temporary directory.
They do not use the Claude Code bridge, invoke another builder or silently substitute an API call.
The HTTP API accepts backend and model selection, never executable paths, environment overrides
or arbitrary CLI flags.

The canonical schema uses JSON Schema draft-07 with `definitions` and local references. Claude
Code 2.1.286 rejected the former draft-2020-12 declaration during `--json-schema` preflight,
before contacting a model. This compatibility failure is reported as `BUILDER_SCHEMA_INVALID`;
it does not ask the user to sign in. Confirmed missing-authentication failures retain the separate
`BUILDER_AUTH_REQUIRED` error. Raw diagnostics are never returned in either case.

On Nov 14, 2026, an authenticated subscription login and a plain safe-mode `claude -p` request
were confirmed. After the draft-07 correction, the exact `buildEnvironment` headless path above
also produced a valid two-worker, three-tick task environment on its first attempt using Claude
Code 2.1.286 and its default model. Offline tests separately compile the actual emitted schema
with a draft-07 validator and cover repair, schema/login diagnostics, cancellation and process
limits. The generated definition was also saved and run through the local HTTP API with the
rules provider: two completed tasks and four recorded frames. These checks do not establish
live Jev behavior or simulation accuracy.

Codex transport, isolation arguments, repair and failure handling are covered with offline process
doubles. On Nov 14, 2026, the exact live `buildEnvironment` Codex path produced a valid two-worker,
three-tick environment on its first attempt in about ten seconds using Codex CLI
0.169.0-alpha.11.1 and `gpt-6-astra`. This exercised the documented isolation flags, strict output
envelope and canonical validation.

A separate Safari check selected Codex in the existing Scope drawer, built a two-worker definition,
then completed a three-tick rules run with two finished tasks. Replay, agent inspection, theme
switching and restored Codex/model selection after reloading the saved run all passed. This verifies
the build-to-simulation integration; it is not a live Jev accuracy test.

The older local Codex CLI 0.142.1 selected a default model unavailable to the tested account;
explicitly selecting `gpt-6-astra` then required a newer CLI. `BUILDER_MODEL_UNAVAILABLE` tells the
user to select an available model through the Model field, `--model` or `SWARM_CODEX_MODEL`.
`BUILDER_CLI_OUTDATED` tells the user to update Codex or point `SWARM_CODEX_BIN` to a current
executable. These failures are distinct from authentication and do not trigger a provider switch.
Executable/model overrides can be set in gitignored `.env.local` without changing the global CLI;
restart the server after changing them.

Each attempt has a three-minute timeout (programmatic maximum five minutes). The CLI output is
capped at 2 MB, diagnostics at 64 KB. Cancellation or limits terminate the process group; temporary
directories are removed on success and failure. Raw stderr is never returned, because it can contain
credentials or machine-specific details. SDK requests use the same deadline and cancellation signal.

`onProgress` receives real `building`, `repairing`, `validating` and `ready` stages. Generator, SDK
client and process-spawn injections support offline tests; those are internal seams, not API inputs.
Builder metadata records backend, requested model and elapsed time; a null requested model means
the CLI selected its default. The brief and normalized spec remain reviewable. This is a model of
bounded workflows, not an arbitrary-code environment builder
or a claim that every natural-language constraint is automatically verified.
