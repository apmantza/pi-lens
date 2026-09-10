# Configuration

pi-lens reads optional user preferences from `~/.pi-lens/config.json` (`%USERPROFILE%\\.pi-lens\\config.json` on Windows). An unrecognized top-level key is logged once (to surface a typo like `lps` for `lsp`) and then ignored; `$schema` is always allowed for editor JSON-schema association. Missing or invalid config falls back to defaults.

## Every toggle, both ways

Each runtime toggle is settable from the CLI *and* from `config.json`. The two are driven by one declarative registry (`clients/lens-flag-registry.ts`), so neither surface can gain a toggle the other lacks.

| CLI flag | `config.json` key | Default |
| --- | --- | --- |
| `--no-lens` | `lens.enabled` | `true` |
| `--no-lsp` | `lsp.enabled` | `true` |
| `--no-tests` | `tests.enabled` | `true` |
| `--no-delta` | `delta.enabled` | `true` |
| `--no-opengrep` | `opengrep.enabled` | `true` |
| `--no-read-guard` | `readGuard.enabled` | `true` |
| `--no-autoformat` | `format.enabled` | `true` |
| `--no-autofix` | `autofix.enabled` | `true` |
| `--no-lens-context` | `contextInjection.enabled` | `true` |
| `--lens-guard` | `guard.enabled` | `false` |
| `--immediate-format` | `format.mode` (`"immediate"`) | `"deferred"` |
| `--lens-turn-summary` | `turnSummary.enabled` | `false` |
| `--lens-actionable-warnings` | `actionableWarnings.enabled` | `false` |
| `--lens-actionable-warning-actions` | `actionableWarnings.includeLspCodeActions` | `false` |
| `--lens-actionable-warning-autofix` | `actionableWarnings.autoFix.enabled` | `false` |
| `--lens-actionable-warning-all` | `actionableWarnings.deltaOnly` (`false`) | `true` |
| `--lens-compact-tool-line` | `ui.compactToolLine` | `false` |
| `--no-lazy-tools` | `tools.lazy` | `true` |
| `--lens-turn-end-madge` | `turnEnd.madge.enabled` | `false` |
| `--no-knip` | `knip.enabled` | `true` |
| `--no-jscpd` | `jscpd.enabled` | `true` |
| `--no-madge` | `madge.enabled` | `true` |
| `--no-gitleaks` | `gitleaks.enabled` | `true` |
| `--no-govulncheck` | `govulncheck.enabled` | `true` |
| `--no-dead-code` | `deadCode.enabled` | `true` |
| `--no-complexity` | `complexity.enabled` | `true` |

## Startup controls

| Configuration key | Default | Accepted values |
| --- | --- | --- |
| `startup.mode` | `full` | `quick`, `full`, or `minimal`; `PI_LENS_STARTUP_MODE` wins |
| `startup.scans.enabled` | `true` | `true` or `false` |

By default pi-lens registers six situational tools (the `ast_grep_*` family,
`lsp_navigation`, `lens_diagnostic_mark`) inactive and exposes a small loader,
`pi_lens_activate_tools`, that the model calls to activate the ones it needs.
`--no-lazy-tools` turns that off: every pi-lens tool is active from the first
turn and pi-lens never changes the tool list. Use it if you would rather spend
the tokens of a longer tool list than have the list change mid-session. The
loader tool is still registered and still describes itself as activating
inactive tools; under this flag those tools are already active, so calling it
does nothing.

Keys are positive (`"enabled": true` means the feature runs), so a `--no-*` flag corresponds to setting its key `false`. A `no-*` flag on the command line is a one-way switch: it can disable, never re-enable, so `--no-lsp` wins over `lsp.enabled: true` but nothing on the CLI overrides `lsp.enabled: false`. Set the key back to `true` to re-enable.

Resolution order for a single toggle, highest first:

1. Environment variable, where one is bound (`PI_LENS_NO_CONTEXT_INJECTION=1`).
2. The CLI flag.
3. The nearest `.pi-lens.json` that defines the key, for the three mutation controls only (see [Mutation controls](#mutation-controls)).
4. `~/.pi-lens/config.json`.
5. The built-in default.

## Examples

Hide the diagnostics widget by default, run formatting immediately after write/edit tool calls instead of at `agent_end`, and enable actionable warnings with conservative autofix:

```json
{
  "ignore": [
    "**/*.snapshot",
    "scratch/**"
  ],
  "widget": {
    "visible": false
  },
  "format": {
    "enabled": true,
    "mode": "immediate"
  },
  "autofix": {
    "enabled": true
  },
  "actionableWarnings": {
    "enabled": true,
    "includeLspCodeActions": true,
    "deltaOnly": true,
    "autoFix": {
      "enabled": false,
      "maxFixes": 5
    }
  },
  "contextInjection": {
    "enabled": false
  }
}
```

`format.mode` can be `"deferred"` (default) or `"immediate"`. Set `format.enabled` to `false` to match `--no-autoformat`. `/lens-widget-toggle` still works as a session-only override.

`autofix.enabled` (default `true`) is the global-config counterpart to the project `.pi-lens.json` `autofix.enabled` below — set it to `false` to match `--no-autofix` for every project that doesn't set its own `autofix.enabled`. As with `format.enabled` and `actionableWarnings.autoFix.enabled`, a project's own `.pi-lens.json` value overrides this global default in either direction (see "Mutation controls" below).

`contextInjection.enabled` (default `true`) controls whether pi-lens prepends automatic findings — session-start guidance, turn-end findings, and test findings — into the next model turn. Set it to `false` (or use `--no-lens-context` / `PI_LENS_NO_CONTEXT_INJECTION=1` / `/lens-context-toggle`) to keep tools, LSP, read-guard, and formatting running while avoiding the prompt-cache invalidation that injected messages cause in long, cache-sensitive sessions. Findings are still cached, so `lens_diagnostics` and `/lens-health` keep working.

`actionableWarnings.enabled` gates the turn_end report. `includeLspCodeActions` fetches LSP code actions for each warning (requires an active language server). `deltaOnly` (default `true`) limits the report to lines touched in the current turn. `autoFix.enabled` applies conservative LSP quickfixes at `agent_end`; `autoFix.maxFixes` caps the number applied per turn (default `5`, must be a non-negative whole number). `maxFixes: 0` keeps the report and applies nothing, which is a useful halfway step before enabling `autoFix` for real. Unlike the toggles in the table above there is no CLI counterpart, since it takes a number rather than being on or off.

`turnEnd.madge.enabled` (default `false`) runs the per-turn-end madge circular-dependency check on import-changed files. It is off by default because that pass only writes debug output — user-facing madge diagnostics come from the session-start scan cache and the `lens_diagnostics` extractor — and its subprocess spawns dominated the turn-end latency tail (#766). Enable it with `--lens-turn-end-madge` or `turnEnd.madge.enabled: true` if you want the per-edit circular-dependency note.

`ignore` is an array of gitignore-style glob patterns excluded from pi-lens scans across **every** project — the global counterpart to the per-project `.pi-lens.json` `ignore` below. Precedence is lowest: a project `.gitignore` or `.pi-lens.json` (including a `!negation`) overrides it, so you can globally hide e.g. `scratch/**` and still re-include it in one repo.

Turn subsystems off globally instead of retyping flags every session:

```json
{
  "lsp": { "enabled": false },
  "tests": { "enabled": false },
  "opengrep": { "enabled": false },
  "readGuard": { "enabled": false },
  "guard": { "enabled": true }
}
```

`lens.enabled: false` starts every session with pi-lens off (the `--no-lens` equivalent); `/lens-toggle` still re-enables it for one session. `lsp.enabled: false` falls back to language-specific checkers such as pyright. `tests.enabled: false` skips the on-write test runner. `delta.enabled: false` reports every diagnostic rather than only ones introduced this turn. `opengrep.enabled: false` detaches the Opengrep security scanner. `readGuard.enabled: false` turns off the read-before-edit monitor. `guard.enabled: true` opts into the experimental commit/push blocker.

The `tools.<name>.enabled` setting controls each model-facing tool. Valid names
include `ast_grep_search`, `ast_grep_replace`, `ast_grep_outline`,
`lsp_navigation`, `lsp_diagnostics`, `lens_diagnostics`,
`lens_diagnostic_mark`, `symbol_search`, `module_report`, `project_report`,
`read_symbol`, `read_enclosing`, `effective_config`, `analyze`, `health`,
`latency`, `project_scan`, and `rebuild`. The activation loader and MCP
lifecycle tools `session_start`, `turn_end`, and `session_end` cannot be
disabled.

## Project Config

In addition to the user-level `~/.pi-lens/config.json` above, pi-lens reads a per-project `.pi-lens.json` (or `pi-lens.json`) at the project root. Walked upward from the cwd, so a monorepo can keep the config at the repo root and have every subdir pick it up. The schema is intentionally small — only fields pi-lens actually honors:

Note that most toggles from the table above are **user-level only**. Of them, a project config honors just the three [mutation controls](#mutation-controls) (`format.enabled`, `autofix.enabled`, `actionableWarnings.autoFix.enabled`). Putting a user-level toggle such as `"lsp": { "enabled": false }` in a `.pi-lens.json` is **not** honored at project scope; pi-lens now logs a one-time warning saying so rather than dropping it silently, so you get a signal instead of a setting that quietly does nothing. Set it in `~/.pi-lens/config.json` or pass `--no-lsp` instead. A genuinely unrecognized key (a typo) is likewise logged once. Foreign namespaces that a shared `.pi-lens.json` legitimately carries for the LSP loader (`servers`, `serverOverrides`, `disabledServers`, `warmFiles`) and `$schema` are tolerated without warning.

```json
{
  "ignore": [
    "**/__tests__/**",
    "**/*.test.ts",
    "fixtures/**",
    "vendor/**"
  ],
  "rules": {
    "high-complexity": { "threshold": 25 },
    "high-fan-out": { "threshold": 30 }
  },
  "maxProjectFiles": 5000,
  "reviewGraph": {
    "maxFiles": 12000
  }
}
```

### Mutation controls

`format.enabled`, `autofix.enabled`, and `actionableWarnings.autoFix.enabled`
control the three pi-lens paths that can mutate files outside the agent's
original write/edit:

- `format.enabled: false` disables immediate and deferred auto-formatting.
- `autofix.enabled: false` disables deterministic pipeline fixes from Biome,
  Ruff, ESLint, and other fix-capable runners.
- `actionableWarnings.autoFix.enabled: false` disables conservative LSP
  quickfixes at `agent_end`.

All three are supported at **both** tiers — the user-level
`~/.pi-lens/config.json` above (applies to every project) and the per-project
`.pi-lens.json` below (applies to one repo). These settings do not disable LSP
synchronization, lint dispatch, actionable warning reports, or diagnostics.

Precedence, highest to lowest:

1. Explicit disabling CLI flags (`--no-autoformat`, `--no-autofix`) — always win.
2. Nearest defining project `.pi-lens.json` — wins over the global default in **either**
   direction, including re-enabling a mutation path the user's global config
   disabled (maintainer decision: a repo's own contract for its own files
   takes precedence over a user's blanket preference; there is currently no
   "hard off" global setting that outranks a project's `enabled: true` — see
   #792). `actionableWarnings.autoFix.enabled` follows the same rule: project
   wins outright when set, whether that means turning it on or off.
3. Global `~/.pi-lens/config.json` — the user-level default when a project
   doesn't say.
4. Built-in default (`format`/`autofix` on, `actionableWarnings.autoFix` off).

In a monorepo, mutation controls use **closest-wins per flag**. For each edited
file, pi-lens walks from its directory to the project root. The nearest config
that explicitly defines a flag wins; omitted flags continue inheriting from
ancestors. For example, `packages/generated/.pi-lens.json` may set only
`"format": { "enabled": false }`: files in that package skip formatting while
still inheriting the repo root's `autofix.enabled`.

### `ignore`

Array of gitignore-style glob patterns. Any path matching is excluded from every diagnostic scan (LSP walk, fact-rules, tree-sitter, jscpd, knip, review graph, source-filter). Useful for vendored code, generated files, or per-project noise you want to silence without editing `.gitignore` (which would also affect git itself). These patterns take precedence over the global `~/.pi-lens/config.json` `ignore`, so a `!negation` here can re-include a globally-ignored path.

In a monorepo, `ignore` **layers** across nested `.pi-lens.json` files the same way nested `.gitignore`s do: a `.pi-lens.json` inside a package directory (e.g. `packages/a/.pi-lens.json`) contributes its own `ignore` patterns for files under that package, in addition to the repo-root config's patterns — each anchored relative to its own directory, and a nested package's patterns winning over the root's for files inside that package. A package-local config's `ignore` patterns never affect files outside its own directory.

Note: `maxProjectFiles` (below) is discovered differently — via an upward walk from whatever directory a subsystem is invoked with — so it can resolve to a package-local override even where `ignore` does not, if the two configs disagree. See `clients/project-lens-config.ts` for the discovery details.

### `rules`

Per-rule threshold overrides and policy filters. Currently honored:

- `high-complexity.threshold` — cyclomatic complexity (default `15`)
- `high-fan-out.threshold` — distinct function calls (default `20`)
- `<id>.disable` — disable diagnostics for the listed rule ids (output-only
  filter). Same rule-id normalization as `pi-lens-ignore`: a user lists
  `no-eval` once and the filter covers `no-eval`, `ast-grep:no-eval`, and
  `no-eval-js`. Side effect: a rule whose real name genuinely ends in `-js`
  (e.g. `prefer-js`) is conflated with its stem (`prefer`) — disabling or
  selecting one also disables or selects the other.
- `<id>.select` — allowlist of rule ids; only the listed rule ids survive
  filtering. Disable wins over select project-wide, even when the two lists
  are configured under different keys.

The `<id>` key is a grouping label only — it does not scope which rules the
`disable`/`select` list underneath it can match. Matching is **project-wide**:
every `disable` list across every key is unioned into one drop list, and
every `select` list across every key is unioned into one allowlist. So
`"security": { "disable": ["no-eval"] }` disables `no-eval` regardless of
`security` being the rule's own id, and two keys can each contribute to the
same select union.

```json
{
  "rules": {
    "high-complexity": { "threshold": 25 },
    "high-fan-out": { "threshold": 30 },
    "no-eval": { "disable": ["no-eval", "no-eval-js", "ast-grep:no-eval"] },
    "my-rule-set": { "select": ["rule-a", "rule-b"] }
  }
}
```

**Warning:** because select is project-wide, a non-empty `select` list
*anywhere* in `rules` silences every rule not in that list, across the whole
project — including tsc/eslint findings, not just the rule types you're
thinking about when you write it. It's a big hammer; reach for `disable`
instead unless you actually want an allowlist over everything. Findings that
carry no rule id at all (an eslint parse error, for example) are exempt from
select, so an allowlist can never hide them.

Disable and select are output-only filters applied AFTER inline suppression,
disposition, and dedup — the project-level policy never widens the trusted
surface area (widget state, baseline, dedup cache stay authoritative). The
baseline still records the full unfiltered set so a project-config edit does
not corrupt delta baselines.

### `maxProjectFiles`

Single scale knob (default `2000`) that a large-but-healthy repo can raise to scale five independent size budgets together instead of tripping each one separately: the project-diagnostics scanner (0.25×, default 500 files), the review graph (0.5× up to a point, default 1,000 files — see below), the startup scan (1×, default 2,000 source files), jscpd (3×, default 6,000 directory entries), and the word index (3×, default 6,000 files). Raising it (e.g. to `5000`) scales all five proportionally. Each subsystem's own environment-variable override (e.g. `PI_LENS_REVIEW_GRAPH_MAX_FILES`, `PI_LENS_STARTUP_SCAN_MAX_ENTRIES`) still takes precedence over this knob when set, and a separate `PI_LENS_MAX_PROJECT_FILES` environment variable sits below `maxProjectFiles` but above the built-in default. See `clients/project-scale.ts` for the full ratio table and precedence order.

Unlike the other four, the review graph's budget stops scaling flatly at 0.5× once `maxProjectFiles` climbs past 4,000 — it tapers toward a 5,000-file ceiling instead of growing unbounded (#775). Its higher per-file cold-build cost bounds this default file budget independently of the graph's disk-persist circuit-breaker, whose measured default is now 500,000 elements (#936; override with `PI_LENS_GRAPH_PERSIST_MAX_ELEMENTS`). An over-cap graph persists a centrality-ranked partial snapshot with explicit total-versus-persisted coverage; read-only orientation may use it, but incremental builds never reuse it as a complete base. Below the 4,000 threshold (which covers every typical/default-sized project) it's the same flat 0.5× ratio as before. See `reviewGraph.maxFiles` below for an explicit opt-in past the taper.

### `reviewGraph.maxFiles`

Explicit override for the review graph's own file budget (#775), for monorepos that want a bigger graph than raising `maxProjectFiles` alone would derive. Since the graph's default 0.5× ratio no longer scales linearly forever above a threshold (it tapers toward a hard ceiling — see below), a repo that legitimately needs a larger graph than the taper gives can opt in explicitly here instead:

```json
{ "reviewGraph": { "maxFiles": 12000 } }
```

- Tolerantly parsed like `maxProjectFiles` (numeric strings coerce), clamped to `[100, 20000]` — an out-of-range value is silently clamped to the nearest bound rather than rejected (it's still a deliberate opt-in); a non-numeric or non-positive value is logged once and ignored.
- Takes precedence over the adaptive taper described under `maxProjectFiles` above, but the pre-existing `PI_LENS_REVIEW_GRAPH_MAX_FILES` environment variable still wins outright over both when set.
- Why the review graph tapers instead of scaling flatly like the other four budgets: its per-file cost (tree-sitter parse + import-fact extraction) is measurably higher than a directory-entry count or file-existence check, so an unbounded linear budget on a huge `maxProjectFiles` would risk a very slow cold build on the synchronous edit-hook path. See `clients/project-scale.ts`'s `taperedReviewGraphMaxFiles` doc comment for the exact shape and the measured per-file cost it's grounded in.

### Schema rules

Session-start analyzer keys default to `true` and work in both the global
config and `.pi-lens.json`. Set one to `false` to skip that analyzer; pi-lens
records the disabled skip. `startup.mode` accepts `quick`, `full`, or
`minimal`, and `startup.scans.enabled: false` disables background startup scans
while leaving diagnostics and LSP active. `PI_LENS_STARTUP_MODE` still wins.

- Unknown rule ids are ignored (forward-compat). Unrecognized **top-level** keys are logged once and then ignored — never fatal to the parse. The LSP namespaces a shared file legitimately carries (`servers`, `serverOverrides`, `disabledServers`, `warmFiles`) and `$schema` are tolerated silently; a user-level-only lens key placed here (e.g. `lsp`, `tests`, `delta`) is logged as "not honored at project scope"; anything else is logged as a likely typo. The raw parsed JSON is still exposed for forward-compat consumers regardless.
- Every toggle key in the table above must be a boolean, and its containing section must be an object. A wrong type is logged once and the key is treated as absent, so the flag falls through to its default rather than the whole file being rejected.
- A malformed JSON file is logged once and treated as "no config" — your diagnostics never get blocked by a syntax error in your own config.
- Rule thresholds must be positive finite numbers; invalid, zero, or negative values are logged once and ignored.
- Mutation-control `enabled` values must be booleans; invalid values are logged once and ignored.
- `rules.<id>.disable` and `rules.<id>.select` must each be a non-empty array of non-empty strings; a non-array value, an empty array, or an all-whitespace array is logged once and the entry is dropped. A policy-only entry (no `threshold`) is honored. A policy entry with an invalid value still keeps any valid `threshold` alongside it.
- The depth sub-threshold of `high-complexity` (default `6`) is intentionally not exposed; only the cyclomatic-complexity knob ships today to keep the schema tight.
- The file is mtime-cached, so editing it takes effect on the next scan without restarting the agent.
