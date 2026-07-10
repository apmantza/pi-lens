# Environment Variables

All pi-lens environment variables. Read at process start; set them in the
shell that launches pi (`export …` in bash, `setx …` in PowerShell, or in
your process manager / CI config). The `--flag` form on the pi command
line takes precedence over the env var when both are set; the
`config.json` form below takes precedence over both.

## Data directory

### `PILENS_DATA_DIR`

Override the base directory for **per-project** persistent state
(scanner caches, project snapshot, change-log, code-quality-warnings,
review-graph, install-choices, etc.).

**Default resolution order:**

1. `$PILENS_DATA_DIR/<sanitized-cwd-slug>/` (if `PILENS_DATA_DIR` is set)
2. `<cwd>/.pi-lens/` (legacy — only if it already exists in the project)
3. `~/.pi-lens/projects/<sanitized-cwd-slug>/` (current default)

**When to set it:** running pi with a local model server (llama.cpp,
Ollama, etc.) that monitors the project directory — cache-file churn
inside the workspace can disrupt the model's context scoring. Point
`PILENS_DATA_DIR` at e.g. `~/.cache/pi-lens` to keep all per-project state
out of the workspace.

**What is NOT moved by this variable:** tool binaries always live in
`~/.pi-lens/bin/` regardless (and are reused across projects); the
machine-global logs at `~/.pi-lens/{latency,cascade,tree-sitter,
read-guard,…}.log` likewise stay put.

## Startup mode

### `PI_LENS_STARTUP_MODE`

`full` | `minimal` | `quick`. Override the auto-selected session-startup
path. One-shot `pi --print` sessions auto-use `quick` to reduce latency
without changing the steady-state behaviour of an interactive session.

## Context injection

### `PI_LENS_NO_CONTEXT_INJECTION`

Set to `1` to disable automatic context injection (equivalent to
`--no-lens-context` or `contextInjection.enabled: false` in
`~/.pi-lens/config.json`). Tools, LSP, read-guard, and formatting stay
active; findings are still cached for `lens_diagnostics` and
`/lens-health`. Useful when prompt-cache invalidation from injected
messages is hurting throughput in long, cache-sensitive sessions.

## Bus events

### `PI_LENS_BUS_PUBLISH`

Set to `0` to disable publishing the `pilens:files:touched` event on pi's
shared `pi.events` bus (see `docs/features.md` — "Bus Events" — for the full
payload contract). Enabled by default. Publishing is fire-and-forget and
never affects the write path's own success or latency, so this switch exists
purely to opt out of the broadcast, e.g. if another extension's bus listener
misbehaves.

## Related

- `~/.pi-lens/config.json` schema — `## Global Config` in [README.md](../README.md#global-config)
- CLI flags — `## Run` in [README.md](../README.md#run)
