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

- `claude-code` (default): uses the installed `claude` executable and its normal authentication.
  `SWARM_CLAUDE_BIN` can point to an executable; `SWARM_BUILDER_MODEL` selects a model. Without a
  model override Claude Code chooses its default. Explicitly configured provider credentials must
  be supplied through the environment, because user/project settings are disabled for this job.
- `anthropic`: uses `ANTHROPIC_API_KEY` and the repository's existing compiler model default,
  overridable by `model` or `SWARM_BUILDER_MODEL`.

The Claude Code command uses `--print --output-format json --json-schema …`, with safe mode,
an empty tool list, disabled slash commands, no loaded settings, an empty strict MCP config,
`dontAsk` permission mode, and no session persistence or Chrome connection. It starts in a fresh
temporary directory and receives the brief through stdin. No shell interpolation, generated
program execution, permission bypass, user-provided executable, or user-provided CLI flags are
accepted through the application API. These flags were verified with the installed CLI's help;
older Claude Code versions without them must be upgraded.

Each attempt has a three-minute timeout (programmatic maximum five minutes). The CLI output is
capped at 2 MB, diagnostics at 64 KB. Cancellation or limits terminate the process group; temporary
directories are removed on success and failure. Raw stderr is never returned, because it can contain
credentials or machine-specific details. SDK requests use the same deadline and cancellation signal.

`onProgress` receives real `building`, `repairing`, `validating` and `ready` stages. Generator, SDK
client and process-spawn injections support offline tests; those are internal seams, not API inputs.
Builder metadata records backend, requested model and elapsed time; the brief and normalized spec
remain reviewable. This is a model of bounded workflows, not an arbitrary-code environment builder
or a claim that every natural-language constraint is automatically verified.
