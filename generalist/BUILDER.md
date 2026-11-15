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

Two backends are available:

- `claude-code` (default): a headless Claude Code agent, started with `claude -p`. It uses the installed
  `claude` executable and its normal sign-in; a Claude Code subscription login works without a separate
  `ANTHROPIC_API_KEY`. `SWARM_CLAUDE_BIN` can point to an executable. `model` or `SWARM_BUILDER_MODEL`
  selects a model; without one the agent runs on `sonnet`. Check login with `claude auth status`; use
  `claude auth login` if it reports no authentication.
- `anthropic`: uses `ANTHROPIC_API_KEY` and the repository's existing compiler model default,
  overridable by `model` or `SWARM_BUILDER_MODEL`.

There is no Codex backend. It was added and then removed on Nov 14, 2026 at the user's request.

**How the headless agent is run.** The agent is given a goal, not a single request. The prompt on stdin is
one line:

```
/goal The file <temporary folder>/environment.json holds one complete Swarmscope environment for the brief
in your instructions: a single JSON object that follows the environment schema and every modeling rule given there.
```

`/goal` makes Claude Code keep working until the condition holds. The modeling rules, the brief (marked as
scenario data, not instructions), the schema and, on a repair attempt, the validator's errors with the last
submission are in `instructions.md` in the same temporary folder, passed with `--append-system-prompt-file`.
Nothing the user wrote is on the command line.

The command is `claude -p --output-format json --tools Write --allowed-tools Write --permission-mode
acceptEdits --safe-mode --setting-sources "" --strict-mcp-config --mcp-config '{"mcpServers":{}}'
--no-session-persistence --no-chrome --max-turns 16 --model <model> --append-system-prompt-file <file>`.
The agent has one tool, Write, and starts in a fresh temporary folder with none of the user's settings,
plugins, skills, hooks or MCP servers. It cannot run commands or read files. When it exits, the builder reads
`environment.json`, parses it and validates it with `validateEnvironment`; a missing file, invalid JSON or
validation errors go back to the agent on the next attempt (three at most). Nothing the agent writes is
executed, and the temporary folder is removed on success and failure. The HTTP API accepts backend and model
selection, never executable paths, environment overrides or arbitrary CLI flags.

On Nov 14, 2026 this path was run live with Claude Code 2.1.286: the brief "A small theme park on a busy
Saturday. Examine where the bottlenecks are and which rides make the most money." gave a valid environment on
the first attempt in 64 seconds (2 turns, about $0.17 on `sonnet`): two kinds of visiting party (36 parties),
five rides, a gate and a food court as capacity-limited resources, and revenue and waiting metrics per ride.
Running it with Jev made 1,143 decisions with no fallbacks (about $0.14 at TypeSafe's published price,
unverified). `/goal` was also checked in headless mode on Claude Code 2.1.325. One build and one Jev run are
a check that the path works, not a measure of how good the environments are.

Offline tests use a stand-in process that writes `environment.json` the way the agent does. They cover the
command's flags, the goal line, repair after invalid JSON, login diagnostics, cancellation and process limits.
Missing-authentication failures are reported as `BUILDER_AUTH_REQUIRED`; raw diagnostics are never returned.

Each attempt has a four-minute timeout (programmatic maximum five minutes). The CLI output is
capped at 2 MB, diagnostics at 64 KB. Cancellation or limits terminate the process group; temporary
directories are removed on success and failure. Raw stderr is never returned, because it can contain
credentials or machine-specific details. SDK requests use the same deadline and cancellation signal.

`onProgress` receives real `building`, `repairing`, `validating` and `ready` stages. Generator, SDK
client and process-spawn injections support offline tests; those are internal seams, not API inputs.
Builder metadata records backend, model, elapsed time and, for the headless agent, its turns and cost. The brief and normalized spec remain reviewable. This is a model of
bounded workflows, not an arbitrary-code environment builder
or a claim that every natural-language constraint is automatically verified.
