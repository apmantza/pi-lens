# Configuration

pi-lens reads optional user preferences from the global file selected by the
[winning-location table](configuration.md#global-config-location) (`~/.pi-lens/config.json`
by default; `%USERPROFILE%\\.pi-lens\\config.json` on Windows). An unrecognized
top-level key is logged once (to surface a typo like `lps` for `lsp`) and then
ignored; `$schema` is always allowed for editor JSON-schema association. Missing
or invalid config falls back to defaults.

## Every toggle, both ways

Each runtime toggle is settable from the CLI *and* from `config.json`. The two are driven by one declarative registry (`clients/lens-flag-registry.ts`), so neither surface can gain a toggle the other lacks.

| CLI flag | `config.json` key | Default |
| --- | --- | --- |
| `--no-lens` | `lens.enabled` | `true` |
| `--no-lsp` | `lsp.enabled` | `true` |
| `--no-tests` | `tests.enabled` | `true` |
| `--no-delta` | `delta.enabled` | `true` |
| `--no-opengrep` | `opengrep.enabled` | `true` |
| `--no-ast-grep` | `astGrep.enabled` | `true` |
| `--no-zizmor` | `zizmor.enabled` | `true` |
| `--no-typos` | `typos.enabled` | `true` |
| `--lens-spotbugs` | `spotbugs.enabled` | `false` |
| `--no-read-guard` | `readGuard.enabled` | `true` |
| `--no-read-expansion` | `readGuard.expandReads` | `true` |
| `--no-autoformat` | `format.enabled` | `true` |
| `--no-autofix` | `autofix.enabled` | `true` |
| `--no-lens-context` | `contextInjection.enabled` | `true` |
| `--lens-guard` | `guard.enabled` | `false` |
| `--lens-checkout-guard` | `guard.sharedCheckout` | `false` |
| `--immediate-format` | `format.mode` (`"immediate"`) | `"deferred"` |
| `--lens-retain-injections` | `contextInjection.retain` | `false` |
| `--lens-turn-summary` | `turnSummary.enabled` | `false` |
| `--lens-actionable-warnings` | `actionableWarnings.enabled` | `false` |
| `--lens-actionable-warning-actions` | `actionableWarnings.includeLspCodeActions` | `false` |
| `--lens-actionable-warning-autofix` | `actionableWarnings.autoFix.enabled` | `false` |
| `--lens-actionable-warning-all` | `actionableWarnings.deltaOnly` (`false`) | `true` |
| `--lens-compact-tool-line` | `ui.compactToolLine` | `false` |
| `--lens-compact-lsp-status` | `ui.compactLspStatus` | `false` |
| `--lens-hide-lsp-status` | `ui.hideLspStatus` | `false` |
| `--lens-compact-widget` | `ui.compactWidget` | `false` |
| `--no-lazy-tools` | `tools.lazy` | `true` |
| `--lens-turn-end-madge` | `turnEnd.madge.enabled` | `false` |
| `--lens-fallow` | `fallow.enabled` | `false` |
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

pi-lens registers five situational tools (the `ast_grep_*` family,
`lsp_navigation`, `lens_diagnostic_mark`) and a small loader,
`pi_lens_activate_tools`, that the model calls to activate the ones it needs.
`tools.lazy` decides whether the situational tools start inactive:

| `tools.lazy` | Situational tools |
| --- | --- |
| `true` (default) | Start inactive on every model. |
| `"auto"` | Start inactive only when the session's model keeps mid-conversation system messages (`compat.supportsMidConvoSystemMessages` is `true`). On any other model, including one that does not state the fact, every tool is active from the first turn. Before a model is known, the tools start inactive. |
| `false`, or `--no-lazy-tools` | Every tool is active for the whole session and pi-lens never changes the tool list. |

Why `true` is the default: a model without that fact gets every system message
folded into one prompt head, so each tool-list change rewrites the whole cached
prompt. Activations are rare, though. Over the window measured for #4687 the
loader ran about once per 3,329 requests, while carrying every situational
schema on every request costs more than the rewrites once activations are
rarer than about one per 1,000 requests. `"auto"` is there for a workload that
activates often on a folding model.

Under `"auto"`, pi-lens decides at session start and again only when you
switch models, never between turns of one model. A switch to a folding model
activates every enabled situational tool. A switch back deactivates only the
ones the conversation never activated or called. Any other value is reported
once as an ignored setting, and the default applies.

Precedence: `tools.<name>.enabled` (in either config file, or `--no-tool`)
filters first. A disabled tool is never registered, so it is absent under every
`tools.lazy` value and the loader refuses to activate it. `tools.lazy` then
applies only to the enabled situational tools. It is user-level only: a project
`.pi-lens.json` that sets it, `"auto"` included, is reported and ignored. The
CLI flag outranks the key.

The loader tool stays registered under every value and keeps describing itself
as activating inactive tools; when the tools it names are already active,
calling it does nothing.

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

While a 🔴 blocker the model was told about stays unresolved, the first request of each later prompt repeats it once, headed "Still unresolved (already reported on an earlier turn, not new)" and ending with a `lens_diagnostics` call that lists every blocker, because pi rebuilds that request from its transcript and a blocker from a nested write (a codemode script that drops the STOP note) is not in it. Requests inside one prompt, blockers the session has fixed or marked (whatever another session still holds), and the MCP host repeat nothing; `contextInjection.enabled: false` repeats nothing either.

`contextInjection.retain` (default `false`, or `--lens-retain-injections`) keeps injection on and makes it cache-stable instead. An injection normally rides one provider request: pi rebuilds the next request from its own transcript, so that request no longer carries it, and an engine that caches by exact prefix (a local llama.cpp or Qwen server) re-processes everything after the point where it sat. With `retain` on, pi-lens re-sends each injection's bytes unchanged, at the same place, in every later request of the session, so each request is the previous one plus new content. Findings are still delivered once, and a repeat of a blocker a retained block already carries is skipped, so it spends none of the cap; each retained block ends with a snapshot label naming `lens_diagnostics` for the current state. A compaction, a `/tree` move, or a new, resumed, forked or reloaded session drops what was retained. A session holds at most 64 retained injections and 256 KiB; past either, a new injection reaches its one request only and one `context-injection-retain-declined` degradation row is recorded.

`contextInjection.requirePreExistingFixes` (default `true`) controls whether the session-start orientation tells the agent to fix pre-existing blocking errors; set `false` to scope that demand to errors its own edits introduce.

`actionableWarnings.enabled` gates the turn_end report. `includeLspCodeActions` fetches LSP code actions for each warning (requires an active language server). `deltaOnly` (default `true`) limits the report to lines touched in the current turn. `autoFix.enabled` applies conservative LSP quickfixes at `agent_end`; `autoFix.maxFixes` caps the number applied per turn (default `5`, must be a non-negative whole number). `maxFixes: 0` keeps the report and applies nothing, which is a useful halfway step before enabling `autoFix` for real. Unlike the toggles in the table above there is no CLI counterpart, since it takes a number rather than being on or off.

### Explicit diagnostics query line limit

`lsp.queryMaxFileLines` (default `5000`, a whole number from `5000` to `40000`) sets the line limit of the explicit single-file `lens_diagnostics source=lsp` query, and of nothing else. Per-edit sync, the dispatch LSP runner, and batch (`paths`) and directory queries keep the shared bound of 5000 lines and 2 MiB, which this key does not move (measured cost is the language server's: clangd needs ~2.3 s and ~+270 MB resident per 5000-line file, and an opened document stays resident). A batch's 20 s pre-sweep warm-up still opens a file past that bound, and the session-start, cascade, head-move and workspace-sweep writers never check it; the key changes neither, and both are named residuals (#5306). The 2 MiB byte bound is not configurable.

The key is read from the user-level config only. A project `.pi-lens.json` that sets it is ignored and reported once per session as global-only, and no tool argument can raise it, so a repository or an agent cannot lift your resource policy on that query. A value that is not a whole number in range is ignored with a warning, never clamped to a nearby value.

Suggested value `20000`, which covers files of about 10,000 lines with 2x headroom. Measured on one host with synthetic C++ (investigation #5306): clangd publishes after ~11 s and holds ~+0.95 GB at 20,000 lines; 40,000 lines is 28 to 50 s and ~+1.9 GB, which is why `40000` is the ceiling. Pair it with an explicit `waitMs` on the query: the wait is the larger of `waitMs` and the server's usual wait, up to a hard 30000 ms cap, so a shorter `waitMs` never shortens it (batch and directory queries keep their own per-server budgets). A file over the limit answers `file too large for LSP diagnostics`, and a wait that runs out answers `check timed out`; neither is a clean result.

```json
{ "lsp": { "queryMaxFileLines": 20000 } }
```

`turnEnd.madge.enabled` (default `false`) runs the per-turn-end madge circular-dependency check on import-changed files. It is off by default because that pass only writes debug output — user-facing madge diagnostics come from the session-start scan cache and the `lens_diagnostics` extractor — and its subprocess spawns dominated the turn-end latency tail (#766). Enable it with `--lens-turn-end-madge` or `turnEnd.madge.enabled: true` if you want the per-edit circular-dependency note.

`fallow.enabled` (default `false`, or `--lens-fallow`) runs [fallow](https://github.com/fallow-rs/fallow)'s `fallow-lsp` beside the TypeScript server on JS/TS files (`.ts .tsx .js .jsx .mjs .cjs .mts .cts`; no other file ever attaches it). It reports unused files, exports and dependencies, duplication and cycles as advisory warnings and never blocks. It overlaps knip, jscpd and madge, which keep running either way. Only the exact value `true` turns it on: an absent, misspelled or non-boolean value leaves it off, and pi-lens installs and launches nothing. On first use pi-lens downloads the pinned fallow release into `~/.pi-lens/tools/fallow-lsp` (a `fallow-lsp` already on `PATH` wins); the install is refused on a checksum mismatch. The per-edit diagnostics path runs it; the aggregate all-server checks (`lens_diagnostics source=lsp`, workspace sweeps) do not start it.

`ignore` is an array of gitignore-style glob patterns excluded from pi-lens scans across **every** project — the global counterpart to the per-project `.pi-lens.json` `ignore` below. Precedence is lowest: a project `.gitignore` or `.pi-lens.json` (including a `!negation`) overrides it, so you can globally hide e.g. `scratch/**` and still re-include it in one repo.

Turn subsystems off globally instead of retyping flags every session:

```json
{
  "lsp": { "enabled": false },
  "tests": { "enabled": false },
  "opengrep": { "enabled": false },
  "astGrep": { "enabled": false },
  "zizmor": { "enabled": false },
  "typos": { "enabled": false },
  "spotbugs": { "enabled": true },
  "readGuard": { "enabled": false },
  "guard": { "enabled": true }
}
```

`lens.enabled: false` starts every session with pi-lens off (the `--no-lens` equivalent); `/lens-toggle` still re-enables it for one session. `lsp.enabled: false` falls back to language-specific checkers such as pyright. `tests.enabled: false` skips the on-write test runner. `delta.enabled: false` reports every diagnostic rather than only ones introduced this turn. `opengrep.enabled: false` detaches the Opengrep security scanner. `astGrep.enabled: false` detaches the ast-grep auxiliary server. `zizmor.enabled: false` and `typos.enabled: false` detach the zizmor and typos auxiliary servers. `spotbugs.enabled: true` opts into SpotBugs on Java and Kotlin files (it also needs a Java build descriptor and a compiled `.class` directory). `readGuard.enabled: false` turns off the read-before-edit monitor. `guard.enabled: true` opts into the experimental commit/push blocker.

The `tools.<name>.enabled` setting controls each model-facing tool. Valid names
include `ast_grep_search`, `ast_grep_replace`, `ast_grep_outline`,
`lsp_navigation`, `lens_diagnostics`,
`lens_diagnostic_mark`, `symbol_search`, `module_report`, `project_report`,
`read_symbol`, `read_enclosing`, `effective_config`, `analyze`, `health`,
`latency`, `project_scan`, and `rebuild`. The activation loader and MCP
lifecycle tools `session_start`, `turn_end`, and `session_end` cannot be
disabled.

## Project Config

In addition to the user-level `~/.pi-lens/config.json` above, pi-lens reads a per-project `.pi-lens.json` (or `pi-lens.json`) at the project root. Walked upward from the cwd, so a monorepo can keep the config at the repo root and have every subdir pick it up. The schema is intentionally small — only fields pi-lens actually honors:

Note that most toggles from the table above are **user-level only**. Of them, a project config honors the three [mutation controls](#mutation-controls) (`format.enabled`, `autofix.enabled`, `actionableWarnings.autoFix.enabled`) and the per-tool switches `tools.<name>.enabled` — but not `tools.lazy`, which stays user-level and is reported as such when a project file sets it. Putting a user-level toggle such as `"lsp": { "enabled": false }` in a `.pi-lens.json` is **not** honored at project scope; pi-lens now logs a one-time warning saying so rather than dropping it silently, so you get a signal instead of a setting that quietly does nothing. Set it in `~/.pi-lens/config.json` or pass `--no-lsp` instead. A genuinely unrecognized key (a typo) is likewise logged once. Foreign namespaces that a shared `.pi-lens.json` legitimately carries for the LSP loader (`servers`, `serverOverrides`, `disabledServers`, `warmFiles`) and `$schema` are tolerated without warning.

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
  selecting one also disables or selects the other. The list is a denial: the
  union of the global, project and nested files' lists, so a nearer file adds
  rules and never re-enables one.
- `<id>.select` — allowlist of rule ids; only the listed rule ids survive
  filtering. Disable wins over select project-wide, even when the two lists
  are configured under different keys. Unlike `disable`, the nearest file that
  sets `select` supplies the whole list per grouping key; a global `select`
  applies to a key no nearer file sets. Lists under different keys are unioned,
  so a global `k.select: [x]` and a nearer `k2.select: [y]` keep both `x` and
  `y`.

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

Single scale knob (default `2000`) that a large-but-healthy repo can raise to scale five independent size budgets together instead of tripping each one separately: the project-diagnostics scanner (0.25×, default 500 files), the review graph (0.5× up to a point, default 1,000 files — see below), the startup scan (1.25×, default 2,500 source files), jscpd (3×, default 6,000 directory entries), and the word index (3×, default 6,000 files). Raising it (e.g. to `5000`) scales all five proportionally. Each subsystem's own environment-variable override (e.g. `PI_LENS_REVIEW_GRAPH_MAX_FILES`, `PI_LENS_STARTUP_SCAN_MAX_ENTRIES`) still takes precedence over this knob when set, and a separate `PI_LENS_MAX_PROJECT_FILES` environment variable sits below `maxProjectFiles` but above the built-in default. See `clients/project-scale.ts` for the full ratio table and precedence order.

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
