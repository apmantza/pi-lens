# Environment Variables

The complete pi-lens environment-variable reference. Every variable here is read
at process start; set it in the shell that launches pi (`export …` in bash,
`$env:VAR = "…"` / `setx …` in PowerShell), your process manager, or CI config.

Boolean-style variables are compared literally against `"1"` or `"0"` — only the
exact string flips the switch.

**Precedence** varies by variable and is noted in each section, because the env
tier sits in a different place depending on what the variable controls:

- **Path / directory overrides** (`PILENS_DATA_DIR`, `PI_LENS_HOME`,
  `PI_LENS_CONFIG_PATH`) have no CLI or config-key equivalent, so the env var is
  the only surface.
- **The registry-bound toggle** (`PI_LENS_NO_CONTEXT_INJECTION`) resolves through
  the flag registry, where **env is the highest tier** — it outranks both the
  `--no-lens-context` CLI flag and the `contextInjection.enabled` config key
  (`clients/lens-config.ts` resolution order: `env → cli → project → global →
  default`).
- **Scale / limit knobs** (`PI_LENS_MAX_PROJECT_FILES` and friends) sit *between*
  the matching `config.json` value and the built-in default — the config value
  wins when present, else the env var, else the default. A few are outright
  overrides that win over everything; each says so below.

For the readable overview of all three configuration surfaces (env, CLI flags,
config JSON) and how they interact, see [Settings](settings.md).

## Config location

### `PI_LENS_CONFIG_PATH`

Override the path of the global config file. **Default:** `~/.pi-lens/config.json`
(`%USERPROFILE%\.pi-lens\config.json` on Windows). When set, the value is
resolved to an absolute path and used verbatim.

**When to set it:** keeping the config under version control or a dotfiles
manager at a non-default location, or pointing CI at a fixture config.

## Data directory

### `PILENS_DATA_DIR`

Override the base directory for **per-project** persistent state
(scanner caches, project snapshot, change-log, code-quality-warnings,
review-graph, install-choices, etc.).

**Default resolution order:**

1. `$PILENS_DATA_DIR/<sanitized-cwd-slug>-<8-hex-hash>/` (if `PILENS_DATA_DIR` is set)
2. `<cwd>/.pi-lens/` (legacy — only if it already exists in the project)
3. `~/.pi-lens/projects/<sanitized-cwd-slug>-<8-hex-hash>/` (current default)

**When to set it:** running pi with a local model server (llama.cpp,
Ollama, etc.) that monitors the project directory — cache-file churn
inside the workspace can disrupt the model's context scoring. Point
`PILENS_DATA_DIR` at e.g. `~/.cache/pi-lens` to keep all per-project state
out of the workspace.

**What is NOT moved by this variable:** tool binaries always live in
`~/.pi-lens/bin/` regardless (and are reused across projects); the
machine-global logs at `~/.pi-lens/{latency,cascade,tree-sitter,
read-guard,…}.log` likewise stay put.

## Machine-global directory

### `PI_LENS_HOME`

Override the machine-global pi-lens directory. This relocates global logs,
managed tools, install caches, and the cross-process instance registry from the
default `~/.pi-lens/` root to the supplied path. This is separate from
`PILENS_DATA_DIR`, which controls per-project state; the two are independent.

## Startup mode

### `PI_LENS_STARTUP_MODE`

`full` | `minimal` | `quick`. Override the auto-selected session-startup
path. One-shot `pi --print` sessions auto-use `quick` to reduce latency
without changing the steady-state behaviour of an interactive session.

### `PI_LENS_STARTUP_SCAN_VERDICT_TTL_MS`

How long (ms) a persisted `too-many-source-files` startup-scan verdict is
trusted before the source-file count is re-walked (default 24h). The verdict
is cached in the project snapshot so repeated `pi -p` runs in a very large
repo skip the counting walk entirely; a repo that shrinks below the threshold
recovers when the TTL expires. Other verdicts use content-based freshness and
ignore this setting.

## Scale and limits

### `PI_LENS_MAX_PROJECT_FILES`

Base project-size scale knob (default `2000`). It derives five subsystem size
budgets together. In precedence it sits **below** a project's `maxProjectFiles`
config value and **above** the built-in default: a `.pi-lens.json`
`maxProjectFiles` wins when present, otherwise this env var, otherwise `2000`.

### `PI_LENS_REVIEW_GRAPH_MAX_FILES`

Override the review graph's own file budget. This wins **outright** over both the
config `reviewGraph.maxFiles` value and the adaptive taper derived from
`maxProjectFiles` — it is checked at the call site before any derivation.

### `PI_LENS_STARTUP_SCAN_MAX_ENTRIES`

Directory-entry ceiling for the startup source-count walk (default `50000`). This
bounds directory entries *visited* — a raw tree-walk safety valve — and is
deliberately **not** derived from `maxProjectFiles`, since the healthy ratio of
entries-visited to source-files-kept varies wildly by project shape.

### `PI_LENS_GRAPH_PERSIST_MAX_ELEMENTS`

Element-count ceiling (default `500000`) above which the review graph persists
only a ranked partial snapshot instead of the whole graph.

### `PI_LENS_RUNNER_TIMEOUT_FLOOR_MS`

Minimum wall-clock budget (ms) for every dispatch runner; the effective timeout
is `max(runner budget, floor)`. **Default:** `0` (no floor). Also settable via
the `dispatch.runnerTimeoutFloorMs` config key, which wins when both are set.

## Install control

### `PI_LENS_DISABLE_LSP_INSTALL`

Set to `1` to skip auto-installing language servers. Off by default.

### `PI_LENS_DISABLE_TOOL_INSTALL`

Set to `1` to skip auto-installing managed tools (formatters, linters,
scanners). Off by default.

## Context injection

### `PI_LENS_NO_CONTEXT_INJECTION`

Set to `1` to disable automatic context injection (equivalent to
`--no-lens-context` or `contextInjection.enabled: false` in
`~/.pi-lens/config.json`). Tools, LSP, read-guard, and formatting stay
active; findings are still cached for `lens_diagnostics` and
`/lens-health`. Useful when prompt-cache invalidation from injected
messages is hurting throughput in long, cache-sensitive sessions.

This variable is bound into the flag registry, where **the env tier is highest**:
`PI_LENS_NO_CONTEXT_INJECTION=1` outranks the `--no-lens-context` CLI flag and the
`contextInjection.enabled` config key when they disagree.

## Concurrent-session guard

### `PI_LENS_CONCURRENT_SESSION_GUARD`

Set to `0` to disable the concurrent-session guard. The guard is **on** by
default; it prevents a newly starting same-workspace session from resetting the
warm LSP of a live incumbent session.

## LSP warm attach

### `PI_LENS_WARM_ATTACH`

Set to `1` to opt into the same-workspace warm-attach soak (#822). A second
session reuses a live incumbent session's LSP diagnostics over local IPC.
Unset or `0` preserves the prior local-LSP behavior exactly. Any transport,
schema, freshness, deadline, or incumbent-liveness failure permanently falls
back to a local LSP fleet for that session.

## Language-specific

### `PI_LENS_VULTURE_MIN_CONFIDENCE`

Minimum confidence for the Python dead-code (Vulture) scanner. **Default:** `60`.
Accepts `0`–`100`; out-of-range values are clamped into that range.

### `PI_LENS_JAVA_LOMBOK`

Set to `0` to disable auto-attaching the Lombok javaagent to the Java language
server. Lombok support is on by default when a Lombok jar is resolved.

### `PI_LENS_LOMBOK_JAR`

Explicit path to a Lombok jar for the Java language server, used when
auto-resolution does not find one. The legacy `LOMBOK_JAR` variable is also
honored.

## Project map

### `PI_LENS_MAP_MAX_NODES`

Node cap for `/lens-map` (default 500). Graphs with more files keep only the
highest-degree ones and render a visible truncation note.

## Memory / idle eviction

Several in-memory caches release their contents after a period of inactivity so a
long-running session does not retain hydrated state indefinitely. Each has an
env-tunable window; all default to 20 minutes (`1200000` ms).

### `PI_LENS_TS_IDLE_EVICT_MS`

Idle window (ms) after which TypeScript language-service clients release their
hydrated program and shut down, rebuilding transparently on the next request.
**Default:** 20 minutes (`1200000`).

### `PI_LENS_WORD_INDEX_IDLE_EVICT_MS`

Idle window (ms) after which the persisted word index (`symbol_search`'s BM25
index) is released from memory. **Default:** 20 minutes (`1200000`).

### `PI_LENS_PROJECT_SNAPSHOT_IDLE_EVICT_MS`

Idle window (ms) after which the cached project snapshot is released from
memory. **Default:** 20 minutes (`1200000`).

### `PI_LENS_REVIEW_GRAPH_IDLE_EVICT_MS`

Idle window (ms) after which the in-memory review graph (`file → symbol →
dependency`) is released. **Default:** 20 minutes (`1200000`).

## Bus events

### `PI_LENS_BUS_PUBLISH`

Set to `0` to disable publishing the `pilens:files:touched` event on pi's
shared `pi.events` bus (see `docs/features.md` — "Bus Events" — for the full
payload contract). Enabled by default. Publishing is fire-and-forget and
never affects the write path's own success or latency, so this switch exists
purely to opt out of the broadcast, e.g. if another extension's bus listener
misbehaves.

## Diagnostics and logging

### `PI_LENS_DEBUG`

Set to `1` for verbose installer/debug logging (same as `--debug`). Off by
default.

### `PI_LENS_DEBUG_HANDLES`

Set to `1` **before starting pi** to enable the handle-origin tracer
(institutionalized from the #1097 hand-rolled `async_hooks` investigation
that root-caused a leaked `setTimeout` keeping a `--print --no-session`
process alive). Read once at extension load — toggling it mid-session has no
effect. When set, pi-lens dumps `process.getActiveResourcesInfo()` counts by
resource type (plus per-type creation-site stack attribution, since the
`async_hooks` tracker only installs when the flag was already on at startup)
to `~/.pi-lens/debug-handles.log` at two points: `agent_settled` (after
quiet-window work is scheduled) and `session_shutdown` (after teardown —
whatever is still alive at that point is the leak). Off by default, and a
true no-op when unset — no writer, no `async_hooks` hook, zero overhead. Use
it to diagnose a pi process that won't exit: run once with the flag set,
reproduce the hang, then check `debug-handles.log`'s `session_shutdown`
entry for what's still holding the loop open.

### `PI_LENS_LOG_RETENTION_DAYS`

Days to keep rotated logs before cleanup. **Default:** `7`.

### `PI_LENS_MAX_LOG_SIZE_MB`

Maximum log size (MB) before rotation. **Default:** `10`.

## Advanced tuning knobs

pi-lens also has many advanced/internal tuning variables — LSP timeouts and
memory budgets, debounce intervals (`PI_LENS_LSP_*`, and others). These are for
edge-case tuning, are not part of the supported surface above, and are documented
in the source; enumerate them with `grep PI_LENS_ clients/`.

## Related

- [Settings](settings.md) — the configuration overview hub (env, CLI, config).
- `~/.pi-lens/config.json` schema — [Global and project config](globalconfig.md)
- CLI flags — [Runtime flags](usage.md#runtime-flags)
