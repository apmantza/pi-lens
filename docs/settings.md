# Settings

How pi-lens is configured, and what you can change. This page is the overview
hub. For the full per-field docs of the config JSON, see the
[Configuration reference](./globalconfig.md); for the complete environment-variable
reference, see [Environment variables](./environment-variables.md); for the CLI
flags in context, see [Usage](./usage.md).

pi-lens ships with sensible defaults, so **zero configuration is needed** — it
works out of the box. Everything below is optional tuning.

## The three ways to configure pi-lens

1. **Environment variables** (`PI_LENS_*`) — read at process start; set them in
   the shell that launches pi, your process manager, or CI. Best for machine- or
   CI-scoped switches and for the handful of tuning knobs that have no config key.
2. **CLI flags** (`--no-lsp`, `--immediate-format`, …) — per-session, passed on
   the pi command line.
3. **Config JSON** — a per-user global file (`~/.pi-lens/config.json`) and an
   optional per-project file (`.pi-lens.json` at the repo root).

Every runtime toggle is settable **both** from the CLI and from `config.json`;
the two surfaces are driven by one declarative registry
(`clients/lens-flag-registry.ts`), so neither can gain a toggle the other lacks.

## Precedence

For a single toggle, highest priority first:

1. **Environment variable**, for the toggles that have one bound (only
   `PI_LENS_NO_CONTEXT_INJECTION` today).
2. **CLI flag**.
3. **Nearest project `.pi-lens.json`** that defines the key — for the three
   project-scoped mutation controls only (`format.enabled`, `autofix.enabled`,
   `actionableWarnings.autoFix.enabled`). In a monorepo the closest config to the
   edited file wins.
4. **Global `~/.pi-lens/config.json`**.
5. **Built-in default**.

**The `--no-*` one-way rule.** Config keys are positive (`"enabled": true` means
the feature runs), so a `--no-*` flag corresponds to setting its key `false`. A
`--no-*` flag on the command line is a *one-way switch*: it can disable but never
re-enable. `--no-lsp` overrides `lsp.enabled: true`, but nothing on the CLI
overrides `lsp.enabled: false`. To re-enable, set the config key back to `true`.

## Defaults at a glance

### Runtime toggles (flags)

Each is settable via the CLI flag *or* the `config.json` key. The **Default**
column is the effective behavior when nothing is set.

| CLI flag | `config.json` key | Scope | Default |
| --- | --- | --- | --- |
| `--no-lens` | `lens.enabled` | global | pi-lens **on** |
| `--no-lsp` | `lsp.enabled` | global | LSP diagnostics **on** |
| `--no-autoformat` | `format.enabled` | project | autoformat **on** (deferred) |
| `--immediate-format` | `format.mode` (`"immediate"`) | global | `"deferred"` |
| `--no-autofix` | `autofix.enabled` | project | autofix **on** |
| `--no-tests` | `tests.enabled` | global | test runner **on** |
| `--no-delta` | `delta.enabled` | global | delta mode **on** (new diagnostics only) |
| `--lens-guard` | `guard.enabled` | global | **off** |

| `--no-opengrep` | `opengrep.enabled` | global | Opengrep scanner **on** |
| `--no-read-guard` | `readGuard.enabled` | global | read-before-edit monitor **on** |
| `--no-lens-context` | `contextInjection.enabled` | global | context injection **on** |
| `--lens-turn-summary` | `turnSummary.enabled` | global | **off** |
| `--lens-actionable-warnings` | `actionableWarnings.enabled` | global | **off** |
| `--lens-actionable-warning-actions` | `actionableWarnings.includeLspCodeActions` | global | **off** |
| `--lens-actionable-warning-autofix` | `actionableWarnings.autoFix.enabled` | project | **off** |
| `--lens-actionable-warning-all` | `actionableWarnings.deltaOnly` (`false`) | global | `deltaOnly` **on** (report this turn only) |

`--lens-guard` is **EXPERIMENTAL and strictly opt-in**. When enabled, actual
`git commit`/`git push` commands are blocked only for current, structured
blocking findings (including blocking test failures); advisory/no-action-required
findings do not block. Stale, malformed, or ambiguous persisted state blocks
conservatively until checks run again.

`--immediate-format` and `--lens-actionable-warning-all` are not `--no-*` flags,
so they set a value rather than flipping a boolean off.

### Non-flag config knobs

These take values (numbers, arrays, strings) rather than being on/off, so they
have no CLI flag. See the [Configuration reference](./globalconfig.md) for full
field docs.

| Key | Where | Default | What it does |
| --- | --- | --- | --- |
| `ignore` | global + project | `[]` | Gitignore-style globs excluded from every scan |
| `widget.visible` | global | `true` | Whether the diagnostics widget shows at session start |
| `dispatch.runnerTimeoutFloorMs` | global | none (no floor) | Minimum wall-clock budget per dispatch runner |
| `format.mode` | global | `"deferred"` | `"deferred"` (at `agent_end`) or `"immediate"` |
| `actionableWarnings.autoFix.maxFixes` | global | `5` | Cap on quickfixes applied per turn (`0` = report only) |
| `rules.high-complexity.threshold` | project | `15` | Cyclomatic-complexity threshold |
| `rules.high-fan-out.threshold` | project | `20` | Distinct-function-call threshold |
| `rules.<id>.disable` | project | absent | Disable diagnostics for a rule (output-only filter, project-wide; same normalization as `pi-lens-ignore`) |
| `rules.<id>.select` | project | absent | Allowlist of rule ids (output-only filter, project-wide across every key; disable wins over select) |
| `maxProjectFiles` | project | `2000` | Base scale knob; derives five subsystem size budgets |
| `reviewGraph.maxFiles` | project | derived (clamped `100`–`20000`) | Explicit review-graph file budget |
| `trivy.enabled` / `trivy.minSeverity` | project | off | Opt-in Trivy vulnerability scanning |

## Global vs project config

### Global — `~/.pi-lens/config.json`

User-level. Applies to **every** project. Honors **all** flag keys from the
table above plus the non-flag global knobs (`ignore`, `widget.visible`,
`dispatch.runnerTimeoutFloorMs`, `format.mode`,
`actionableWarnings.autoFix.maxFixes`). On Windows the path is
`%USERPROFILE%\.pi-lens\config.json`.

```json
{
  "lsp": { "enabled": true },
  "tests": { "enabled": false },
  "widget": { "visible": false },
  "format": { "enabled": true, "mode": "immediate" },
  "actionableWarnings": {
    "enabled": true,
    "autoFix": { "enabled": false, "maxFixes": 5 }
  }
}
```

### Project — `.pi-lens.json`

Per-repo. Discovered by walking **upward** from the current directory, so a
monorepo can keep one config at the repo root and every subdirectory picks it up
(closest config wins per edited file). `pi-lens.json` (no leading dot) is also
accepted.

A project file honors **only**:

- the three mutation controls — `format.enabled`, `autofix.enabled`,
  `actionableWarnings.autoFix.enabled`;
- `ignore`, `rules`, `maxProjectFiles`, `reviewGraph`, and `trivy`.

Most toggles are **global-only**. Putting a global-only key such as
`"lsp": { "enabled": false }` in a `.pi-lens.json` is **not** honored at project
scope — pi-lens logs a one-time warning saying so (rather than silently doing
nothing) and you should set it in `~/.pi-lens/config.json` or pass the CLI flag
instead. Foreign LSP-loader namespaces that a shared file legitimately carries
(`servers`, `serverOverrides`, `disabledServers`, `warmFiles`) and `$schema` are
tolerated without warning; anything else is logged once as a likely typo.

```json
{
  "ignore": ["**/*.test.ts", "vendor/**"],
  "rules": {
    "high-complexity": { "threshold": 25 },
    "high-fan-out": { "threshold": 30 },
    "no-eval": { "disable": ["no-eval", "ast-grep:no-eval", "no-eval-js"] }
  },
  "maxProjectFiles": 5000,
  "format": { "enabled": false }
}
```

A project's own mutation-control value wins over the global default in **either**
direction (a repo can re-enable a mutation path the user disabled globally, and
vice versa); only an explicit disabling CLI flag (`--no-autoformat`,
`--no-autofix`) outranks it. See
[Mutation controls](./globalconfig.md#mutation-controls) for the full precedence.

## Environment variables

Environment variables are read once at process start; set them in the launching
shell (`export VAR=…` in bash, `$env:VAR = "…"` in PowerShell), your process
manager, or CI config. The handful you are most likely to reach for:

- `PI_LENS_NO_CONTEXT_INJECTION=1` — disable automatic context injection while
  keeping tools, LSP, read-guard, and formatting active.
- `PILENS_DATA_DIR` — relocate per-project persistent state (caches, snapshot,
  review graph) out of the workspace.
- `PI_LENS_HOME` — relocate the machine-global root (logs, tool binaries, install
  caches, instance registry).
- `PI_LENS_MAX_PROJECT_FILES` — base project-size scale knob (default `2000`).
- `PI_LENS_STARTUP_MODE` — force the startup path: `full`, `minimal`, or `quick`.

**Full environment-variable reference:** [environment-variables.md](./environment-variables.md)
— every supported variable with its default, behavior, and precedence (install
control, scale/limit knobs, logging, language-specific, and more).

## See also

- [Configuration reference](./globalconfig.md) — full field-by-field docs for
  `~/.pi-lens/config.json` and `.pi-lens.json`.
- [Usage](./usage.md) — the CLI flags in context.
- [Environment variables](./environment-variables.md) — the complete
  environment-variable reference.
