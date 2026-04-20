# Changelog

All notable changes to pi-lens will be documented in this file.

## [Unreleased]

### Added
- **Configurable log cleanup** — automatic retention and rotation for `~/.pi-lens/*.log` files:
  - Environment variable `PI_LENS_LOG_RETENTION_DAYS` (default: 7) — days to keep log files
  - Environment variable `PI_LENS_MAX_LOG_SIZE_MB` (default: 10) — max size before rotation
  - Runs automatically on session start, notifies when cleanup occurs
  - Rotated backups (`.log.*`) cleaned after retention period
  - Project-level logs (`{cwd}/.pi-lens/*`) intentionally excluded from cleanup

### Changed (Breaking)
- **Simplified CLI flags** — removed 16 flags to reduce surface area and cognitive load:
  - Removed per-tool disable flags: `--no-biome`, `--no-ast-grep`, `--no-shellcheck`, `--no-madge`, `--no-oxlint`, `--no-ruff`, `--no-go`, `--no-rust`
  - Removed per-tool autofix flags: `--no-autofix-biome`, `--no-autofix-ruff`
  - Removed feature flags: `--lens-verbose`, `--error-debt`, `--auto-install`, `--lens-eslint-core`
  - Removed redundant `--lens-lsp` flag (LSP is default-on; use `--no-lsp` to disable)
  - Removed internal dead flag: `--lens-blocking-only`
  - **Removed `--no-lsp-install` flag** — LSP servers now always auto-install when needed (no manual opt-out)
  - New minimal flag set: `--no-lsp`, `--no-autoformat`, `--no-autofix`, `--no-tests`, `--no-delta`, `--lens-guard`
- **Cross-platform line ending handling** — all `.split("\n")` changed to `.split(/\r?\n/)` for Windows CRLF compatibility (11 files updated)

### Fixed
- **Auto-install verification gap** — `getToolPath()` now verifies tool binaries actually work before using them:
  - Runs `--version` check on local npm tools (not just file existence)
  - Detects broken/corrupted installations (e.g., wrapper exists but package missing)
  - Triggers automatic reinstall when binary verification fails
  - Fixes case where `@biomejs/biome` package deleted but `.cmd` wrapper remained
- **Error swallowing in tool availability checks** — `runtime-session.ts` now logs errors when biome/ast-grep/ruff/knip/dep/jscpd availability checks fail (was silently returning `false`)
- **Biome check runner reliability** — fixed path resolution and configuration issues causing "skipped" status and parse errors:
  - Fixed biome flag: `--output-format=json` → `--reporter=json`
  - Fixed `findBiome()` to check `~/.pi-lens/tools/` directory (was falling back to bare "biome" not in PATH)
  - Fixed `findBiome()` to return `{cmd, argsPrefix}` object for proper npx fallback with `@biomejs/biome` prefix
  - Added `vcs.root: "."` to `config/biome/core.jsonc` to respect project `.gitignore`
- **LSP error messaging** — improved error messages for Windows .cmd shim failures to distinguish "npm .cmd shim failed (underlying binary not installed)" from "may be missing or corrupted"
- **Windows installer improvements** — multiple fixes for Windows tool discovery and LSP stability:
  - Prefer `.cmd` over extensionless in local TOOLS_DIR path lookup on Windows
  - Bypass PS1 hangs in LSP initialization with hard-kill on timeout
  - Remove `.ps1` from pyright managed candidates and ast-grep discovery on Windows
  - Use `SYSTEMDRIVE` env var instead of hardcoded `C:` for cargo fallback path
- **Rust LSP** — exponential backoff circuit breaker for failing LSP connections
- **Installer reliability** — remove `console.error` verbosity, route all events to `sessionstart.log`
- **Circular dependencies** — fixed circular dependencies identified in code review
- **Knip race condition** — fixed race condition in knip tool discovery
- **Non-blocking tool availability checks** — changed all `ensureAvailable()` methods to use async `safeSpawnAsync` instead of sync `safeSpawn`, completing the startup unblocking work:
  - `ruff-client.ts`, `biome-client.ts`, `sg-runner.ts` (first batch)
  - `knip-client.ts`, `dependency-checker.ts`, `jscpd-client.ts` (second batch)
  - `sg-runner.ts` — added missing `safeSpawnAsync` import

## [3.8.28] - 2026-04-19

### Fixed
- **Session startup no longer blocks the Node event loop** — tool availability probes (biome, ast-grep, ruff, knip, jscpd, madge) now run via async `ensureAvailable()` in a fire-and-forget IIFE instead of `setImmediate` + `spawnSync`, eliminating ~8–10 s of main-thread freeze on startup.
- **Biome binary lookup extended** — `getBiomeBinary()` now checks `~/.pi-lens/tools/node_modules/.bin/biome` so the async probe finds the pre-installed binary without falling back to `npx`.
- **CSS roots and Windows LSP shims tightened** — improved root resolution for CSS language server on Windows.
- **Zig compile coverage kept active** — LSP availability check no longer incorrectly disables Zig compile diagnostics.
- **Ruby LSP startup budgets relaxed** — reduced false-negative LSP attach failures on slower machines.
- **Kotlin and Zig LSP availability improved** — more reliable server detection across platforms.
- **Standalone Python and Ruby LSP roots fixed** — correct workspace root used when opening files outside a project directory.

## [3.8.27] - 2026-04-19

### Added
- **Review graph impact cascade** — turn-end cascade now renders a review-graph impact view showing which files were affected and how diagnostics propagated.
- **Fact-rule pipeline in dispatch** — new `fact-rules` dispatch runner computes function-level facts (depth, cyclomatic complexity, call counts) and evaluates quality rules inline, replacing the bespoke tree-sitter booboo runner.
- **Function facts: depth / CC / calls** — tree-sitter extracts per-function cyclomatic complexity, nesting depth, and outgoing call count for fact-rule evaluation.
- **File role classification** — dispatch classifies files as `source`, `test`, `config`, or `vendor` and adjusts rule severity accordingly.
- **Inline suppression directives** — sources can suppress diagnostics with `// pi-lens-ignore` or `# pi-lens-ignore` comments; suppressed items are omitted from inline output.
- **High-complexity fact rule** — flags functions exceeding configurable cyclomatic complexity thresholds.
- **Unsafe-boundary fact rule** — detects dangerous boundary crossings (unvalidated user input → trusted context).
- **High-fan-out fact rule** — flags functions with excessive outgoing call count (default threshold 20).
- **`async-unnecessary-wrapper` ast-grep rule** — detects trivial async wrappers that just await and return.
- **`missing-error-propagation` ast-grep rule** — detects catch blocks that swallow errors without re-throwing or logging.
- **36 new ast-grep rules** — expanded coverage for security, correctness, and style across TypeScript, JavaScript, and Python.
- **5 quality fact rules** — structured quality checks driven by function-level metrics.
- **8 SonarJS-aligned rules** — try-catch enrichment and 8 rules ported from SonarJS patterns.
- **Slop-detection rules** — identifies low-signal / boilerplate-heavy code regions with observability log entries.
- **Dart-analyze dispatch runner** — runs `dart analyze` on `.dart` files.
- **Ktlint dispatch runner** — runs `ktlint` on `.kt` / `.kts` files.
- **TFLint dispatch runner** — runs `tflint` on `.tf` / `.tfvars` files.
- **Taplo dispatch runner + formatter** — runs `taplo` for TOML lint and format.
- **Credo dispatch runner** — runs `mix credo` on Elixir files (falls back to LSP).
- **Phpstan dispatch runner** — runs `phpstan` on PHP files (falls back to LSP).
- **Prettier-check dispatch runner** — runs `prettier --check` as a lint runner (not auto-fix, purely diagnostic).
- **PSScriptAnalyzer runner** — PowerShell linting via `Invoke-ScriptAnalyzer`, using temp `-File` instead of `-Command` to avoid cmd.exe mangling.
- **Hadolint dispatch runner** — Dockerfile lint with always-run dispatch gating.
- **Htmlhint dispatch runner** — HTML lint with tag-pair detection.
- **Docker / PHP / PowerShell / Prisma FileKind** — new language kind mappings enable LSP and dispatch for Dockerfile, `.php`, `.ps1`/`.psm1`, and `.prisma` files.
- **GitHub release downloader for installer** — `shellcheck`, `shfmt`, `rust-analyzer`, and `golangci-lint` are now auto-installed from GitHub releases with asset selection across platforms.
- **Auto-install gopls and ruby-lsp** — `gopls` installed via `go install`; `ruby-lsp` installed via `gem install` when not found.
- **Biome as default JS/TS linter** — when no ESLint or oxlint config exists, Biome runs as the default linter for write-path dispatch instead of silently skipping.
- **Bundled ruff config fallback** — Python projects without a `ruff.toml` / `pyproject.toml` ruff section now use a bundled safe-default config so ruff still produces useful findings.
- **Ruff autofix after diagnostics** — the ruff dispatch runner now applies safe autofixes after capturing diagnostics, mirroring Biome's write-path behavior.
- **Diagnostic history logging** — tree-sitter warnings and debounced ast-grep findings are now logged to session history for observability and `/lens-booboo` review.
- **Tree-sitter grammar downloads expanded** — additional grammars downloaded at install time for broader language coverage.
- **Java and C# fallback analysis** — dispatch includes fallback analysis paths for Java (`.java`) and C# (`.cs`) when LSP is unavailable.
- **CI: tsc type-check + vitest + install gate** — CI now runs `tsc --noEmit` and `vitest` as separate jobs; install-test is gated on both passing.
- **CI: tsx extension load check** — CI verifies that required extensions load correctly to catch missing dependency errors early.

### Changed
- **Promote LSP-backed languages into dispatch** — languages with active LSP servers now route through dispatch's standard pipeline instead of ad-hoc paths.
- **Dispatch language fallbacks aligned** — LSP-backed and fallback runner selection now uses consistent language-to-capability mapping.
- **CSS / HTML / TOML / Elixir fallback wiring** — dispatch fallbacks now include CSS (stylelint), HTML (htmlhint), TOML (taplo), and Elixir (credo).
- **Prettier-check and stylelint cwd handling** — both runners now resolve project root correctly instead of skipping when the working directory overshoots.
- **OS portability: vendor/bin and sg resolution** — `vendor/bin` tools resolve with multi-extension support (`.bat`/`.cmd`/no-ext); `sg` candidate list works across platforms.
- **LSP: live Windows registry PATH** — LSP spawn reads the live `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment\Path` at launch time so newly installed tools are immediately discoverable.
- **LSP: unified resolveAndLaunch** — four separate resolution mechanisms (local binary, global, npx, package manager) collapsed into a single `resolveAndLaunch` flow with clear fallback ordering.
- **LSP: telemetry and logging tightened** — init failures logged to `sessionstart.log`; terminal noise reduced; basename matching improved.
- **YAML LSP root fallback** — YAML language server uses `RootWithFallback` for seamless multi-root project support.
- **Dart / Terraform / TOML LSP: RootWithFallback** — same root-fallback pattern applied across these servers for reliable workspace detection.
- **Terraform-ls HashiCorp install fallback** — improved install path resolution for terraform-ls.
- **`empty-catch` and `unchecked-sync-fs` downgraded to warning** — too many false positives as errors; now `warning` severity.
- **High-fan-out threshold raised to 20** — reduced noise from earlier threshold of 10.
- **High-complexity and unsafe-boundary thresholds tightened** — reduced false positives at the default severity boundaries.
- **False-positive reduction: 8 rules + 3 error rules** — tuned OAuth/constants-related patterns, removed 3 error-level rules that flagged too broadly, and fixed `ts-ssrf` identifier argument matching.
- **Removed unused/noisy ast-grep rules** — culled rules that overlapped with tree-sitter coverage or produced excessive noise.
- **Moved duplicate TS tree-sitter rules** — overlapping rules relocated to `typescript-disabled/` to avoid double-reporting.
- **LSP crash diagnostics** — startup stderr captured and logged for faster root-cause analysis.
- **Tool PATH normalization** — cross-platform PATH resolution unified for LSP and dispatch tool spawning.
- **Cleaned up runtime dependencies** — moved `@ast-grep/napi` and `js-yaml` to `dependencies` (were `devDependencies`); removed unused deps.
- **Complexity reduction** — decomposed four highest-complexity functions (CC 75–153 → <20 each) for maintainability.

### Fixed
- **Windows LSP startup fallback** — hardened spawn logic for `.cmd` wrappers, PATH resolution, and process creation on Windows.
- **C# launch and secondary language fallbacks** — C# LSP and secondary language servers start reliably in more project layouts.
- **Prettier-check / stylelint cwd overshoot** — both runners now find the project root correctly instead of silently skipping.
- **Hadolint asset name case** — GitHub release downloader resolves case-sensitive asset names.
- **Htmlhint / hadolint always-run dispatch** — both runners fire correctly regardless of file presence heuristics.
- **Bash LSP re-spawn** — bash-language-server restarts cleanly after unexpected exit.
- **HTML dispatch + htmlhint tag-pair detection** — HTML file kind wired into dispatch; htmlhint catches missing closing tags.
- **Intelephense needs `scripts`** — PHP LSP installed with `--scripts` flag so its postinstall binary is available.
- **Rust-analyzer: RootWithFallback + Windows .zip asset** — both root detection and Windows asset extraction fixed.
- **Managed Pyright launch path** — pyright LSP binary resolves correctly when installed as a managed tool.
- **Terraform / Kotlin / coverage fallback handling** — all three dispatch paths handle missing tools or configs gracefully.
- **Shellcheck auto-install** — auto-installer works across platforms with GitHub release asset selection.
- **Ktlint asset names** — ktlint release assets resolved with correct URL patterns.
- **Coverage notice for mode:all linters** — mode:all linters that can't generate coverage now emit a notice instead of crashing.
- **npm install 120s timeout** — `ensureTool` npm installs have a hard 120s timeout to prevent indefinite hangs.
- **npm install ERESOLVE retry** — installer retries npm installs on ERESOLVE dependency conflicts.
- **Remove spawnSync from `unchecked-throwing-call` rule** — rule no longer flags `spawnSync` calls as unhandled throwing calls.
- **`flush()` drain before write-complete** — diagnostic history flush now drains pending entries before awaiting write completion, preventing data loss on session end.
- **Runner checks diagnostics-only** — dispatch runner checks are now diagnostics-only, avoiding stale LSP state mutations.
- **Biome-lsp server removed** — duplicate `biome-lsp` server entry removed; Biome LSP is accessed through the standard biome binary.
- **Size guards + path caching for ensureTool** — tool availability checks are cached and sized to avoid re-probing on every call.
- **Test assertions after runner wiring** — test expectations updated for new runner ordering and diagnostics pipeline.
- **OS path separator normalization** — path separators and map keys normalized for cross-platform compatibility in diagnostics and LSP.
- **Drop unnecessary async from `ensureAvailable`** — removed spurious `async` that added nothing and complicated error handling.
- **Tree-sitter rule false positives** — fixed query syntax, scan scripts, and architect glob patterns that produced incorrect findings.

### Performance
- **Startup: defer npm tool availability probes** — tool availability checks (Biome, ESLint, etc.) now run lazily out of the critical path, reducing session start latency.
- **Defer TypeScript loading in similarity runner** — similarity detection lazily imports the TypeScript parser, eliminating cold-start cost on first call.

### Refactored
- **LSP: collapse resolution into `resolveAndLaunch`** — unified four spawn mechanisms into one function with clear platform-aware fallbacks.
- **Booboo: replace bespoke tree-sitter runner** — `/lens-booboo` tree-sitter checks now use the same fact-rule pipeline as dispatch, eliminating code duplication.
- **Drop redundant async from LSP spawn** — removed unnecessary `async`/`await` from functions that already return Promises.

### Tests
- **GitHub release asset selection and PATH tests** — installer asset URL construction and PATH resolution covered by unit tests.
- **Rust-analyzer Windows .zip asset expectation** — test fixture updated for `.zip` extension on Windows.
- **Async-noise test multi-statement function** — test rule updated to match multi-statement function bodies.

## [3.8.26] - 2026-04-15

### Fixed
- **Silent crash on unhandled promise rejection** — the LSP crash guard's `unhandledRejection` handler was swallowing all non-ignorable rejections without rethrowing, causing silent process exits. The handler now rethrows so non-ignorable rejections surface as `uncaughtException` and are properly reported. Triggered most visibly when editing JSON files while Biome or another LSP server was active.

## [3.8.25] - 2026-04-13

### Changed
- **Go LSP PATH augmentation on Windows** — LSP subprocess PATH now includes common Go install directories (`C:\Program Files\Go\bin`, `C:\Go\bin`) to prevent `gopls` startup/runtime failures when `go` is not in inherited shell PATH.
- **Similarity runner cold-start behavior** — similarity now skips fast when no cached project index exists and for tiny/trivial files, reducing write/edit pipeline tail latency and eliminating frequent 30s timeout noise in scratch-file workflows.

### Fixed
- **Non-git workspace commit lookup noise** — metrics snapshot commit detection now pre-checks repository context before invoking Git, preventing `fatal: not a git repository` terminal noise in non-repo folders.

## [3.8.24] - 2026-04-12

### Changed
- **Lazy bootstrap client loading** — startup now defers heavy client initialization behind a shared bootstrap promise, reducing first-turn startup overhead while preserving tool behavior.
- **LSP config discovery scope** — `.pi-lens/lsp.json` (and related config paths) are now resolved from the current directory up through parent directories, improving nested-workspace support.
- **Ruby server fallback chain** — Ruby LSP startup now tries `ruby-lsp`, then `solargraph`, then `rubocop --lsp` for broader environment compatibility.

### Fixed
- **LSP config activation timing** — LSP server config initialization now runs reliably at `session_start` and before LSP-backed `tool_call` operations, so server enable/disable overrides apply in one-shot and interactive sessions.

## [3.8.23] - 2026-04-12

### Added
- **LSP auto-touch warm-up** — tool-call flow now proactively opens/syncs supported files (`read`/`write`/`edit`/`lsp_navigation`) so LSP clients warm up earlier and first semantic requests are less likely to return cold-start empties.

### Changed
- **Ruby LSP spawn resilience on Windows** — Ruby command discovery now tries `ruby-lsp`/`solargraph` from PATH plus common Ruby install locations before marking servers unavailable.
- **LSP diagnostics dedupe strategy** — multi-server diagnostics aggregation now dedupes using a simpler key (`line`, `character`, `message`) to better collapse equivalent findings across servers.
- **Windows LSP PATH fallback** — language-server spawns now augment PATH with common user-level tool locations (`.cargo\bin`, `go\bin`, common Ruby bin dirs) to improve server discovery on Windows shells.

### Fixed
- **LSP diagnostics key normalization** — publish diagnostics now store/update using normalized file-path keys, fixing Windows path mismatches that could hide diagnostics in some languages.
- **Pull diagnostics fallback path** — when a server advertises pull diagnostics, `textDocument/diagnostic` is now attempted before push-wait fallback.
- **Navigation diagnostics/health observability** — `lsp_navigation` and diagnostics aggregation now emit explicit `failureKind`/health metadata to latency logs and tool details for faster root-cause triage (`no_server`, `unsupported`, `empty_result`, `lsp_error`, etc.).
- **Scoped workspaceDiagnostics collection** — `workspaceDiagnostics` with `filePath` now forces file-level diagnostics collection (instead of only returning tracked snapshots), including pull-mode aggregation metadata.
- **Rust pull diagnostics cold-start handling** — pull diagnostics now retry briefly and then fall back to push-wait if pull responses remain empty, improving first-hit Rust diagnostic reliability.
- **Context injection message role validity** — session-start guidance is now injected as `user` context (valid `AgentMessage` role), preventing dropped context on providers that reject/ignore `system` in this path.

## [3.8.22] - 2026-04-09

### Changed
- **Quick startup path for one-shot print sessions** — `--print`/`-p` now auto-selects quick startup mode to skip heavy bootstrap work and reduce startup latency. Added `PI_LENS_STARTUP_MODE=full|minimal|quick` override for explicit control.

### Fixed
- **Cascade diagnostics formatting clarity** — turn-end cascade entries now render source location as `line <n>, col <m> code=<id>:` so diagnostic codes (for example `TS2322`) are no longer formatted in a way that can be mistaken for file line numbers.

## [3.8.21] - 2026-04-08

### Changed
- **Session guidance channeling** — session-start guidance is now injected as `system` context instead of synthetic `user` context, reducing acknowledgement-only first replies before task execution.
- **Coverage warning dedupe** — "Pi-lens analysis unavailable" warnings are now shown once per file per session and reset on session baseline reset.

### Fixed
- **Turn-end read-loop pressure** — turn-end findings now suppress duplicate persisted blocker prompts and avoid imperative "read this file" phrasing that could trigger repeated read loops.

## [3.8.20] - 2026-04-08

### Changed
- **Session startup hardening** — background startup tasks now run with session-generation safety guards and startup in-flight tracking, preventing stale task writes across session boundaries.
- **Turn-end overlap guardrails** — turn-end `knip`/`jscpd` checks now skip when the corresponding startup scan is still in-flight.
- **Language-profile centralization** — startup and dispatch now share a centralized project language profile for supported language detection and LSP-capable kind policy.
- **No-config startup defaults** — startup preinstall now applies language defaults (for example JS/TS -> `typescript-language-server`, Python -> `pyright`/`ruff`) while keeping heavy JS/TS scans config-gated.
- **Language setup hints** — `session_start` now emits actionable install hints for detected Go/Rust/Ruby projects when key tools are missing.

### Fixed
- **TODO baseline scan resilience** — unreadable files are now skipped safely instead of crashing TODO scanning in cloud-synced projects.
- **Startup scan gating consistency** — TODO warmup now respects startup warm-cache gating and avoids unnecessary scan work in restricted startup contexts.
- **Path exclusion coverage** — shared exclusion list now includes common agent/tooling directories (`.claude`, `.codex`, `.worktrees`, `.vscode`, and related dirs).
- **Ruff auto-install on Windows** — pip-based installation now supports fallback chains (`pip`, `py -m pip`, `python -m pip`) and process PATH normalization for user-level scripts.
- **Installer race duplication** — concurrent `ensureTool(...)` calls are now deduplicated per tool to avoid duplicate install attempts/noisy logs.
- **Python LSP root fallback** — Python LSP root detection now supports `.git` projects without Python config files.

## [3.8.19] - 2026-04-07

### Fixed
- **Biome autofix gating** — Biome autofix/auto-install now runs only when the project has Biome configuration (`biome.json`/`biome.jsonc`) or `@biomejs/biome` in `devDependencies`, preventing unwanted Biome installs in non-Biome JS/TS projects.

## [3.8.18] - 2026-04-07

### Changed
- **Similarity calibration tightened** — raised semantic similarity threshold to `0.96`, raised minimum transition signal to `40`, and added transition-ratio filtering to reduce boilerplate-wrapper false positives.
- **Dispatch + booboo alignment** — similarity guardrails are now aligned between `/lens-booboo` reporting and the dispatch `similarity` runner.
- **Tree-sitter structural dedupe in booboo** — advanced structural findings now dedupe repeated line-level matches by normalized matched scope so deep nesting/promise chain reports collapse to one representative issue.

### Tests
- Added similarity runner guardrail assertions in `tests/clients/similarity-runner.test.ts`.

## [3.8.17] - 2026-04-07

### Changed
- **Delta-only unused variable blocking** — diagnostics matching unused-value patterns are now promoted to blocking only when they are newly introduced in delta mode.
- **Unused diagnostic heuristics** — improved detection covers TypeScript unused codes/messages and `no-unused*` rule identifiers, while preserving non-blocking behavior for pre-existing baseline debt.

### Tests
- Added dispatch flow coverage for delta-mode unused-value promotion in `tests/clients/dispatch/dispatcher-flow.test.ts`.

## [3.8.16] - 2026-04-07

### Changed
- **Ast-grep fix guidance upgraded** — ast-grep diagnostics now prefer explicit rule-level guidance from YAML (`fix` first, then `note`) before falling back to generic defect-class suggestions.
- **Rule parser metadata support** — YAML rule parsing now supports top-level `note` and `fix` fields (including multiline values) for agent-facing remediation text.

### Tests
- Added parser coverage for `note`/`fix` extraction in `tests/clients/dispatch/runners/yaml-rule-parser.test.ts`.

## [3.8.15] - 2026-04-07

### Added
- **Security rule: no global eval** — added ast-grep rule to block `eval(...)`, `Function(...)`, and string-based `setTimeout`/`setInterval` execution.
- **Security rule: no blank target** — added ast-grep rule to warn on `<a target="_blank">` without `rel=...`.
- **Performance rule: no accumulating spread** — added ast-grep rule to warn on reduce patterns that repeatedly spread accumulators.

## [3.8.14] - 2026-04-07

### Added
- **YAML lint runner** — added `yamllint` dispatch support for `.yaml`/`.yml` files, with LSP prepended when enabled.
- **SQL lint + format support** — added `sqlfluff` dispatch support for `.sql` files and `sqlfluff` formatter integration.
- **SQL file kind support** — introduced `sql` file kind detection and language-id mapping.

### Changed
- **Capability matrix coverage expanded** — YAML and SQL now map to dedicated lint runners in the centralized capability matrix.
- **Lazy auto-install expansion** — added lazy-install support for `yamllint` and `sqlfluff` via installer-managed pip tools.
- **Runner inventory docs updated** — README runner list now includes `yamllint` and `sqlfluff`.

### Tests
- Added YAML/SQL runner parsing/semantics coverage in `tests/clients/dispatch/runners/yaml-sql-runners.test.ts`.
- Updated dispatch plan/integration tests for YAML+SQL capability mapping and group ordering.

## [3.8.13] - 2026-04-07

### Changed
- **Centralized capability matrix** — dispatch planning now derives from `LANGUAGE_CAPABILITY_MATRIX`, which defines per-language capability dimensions and write/full runner groups in one place.
- **Plan generation simplified** — `TOOL_PLANS` (write path) and `FULL_LINT_PLANS` (full scans) are generated from matrix entries instead of duplicated hand-maintained plan objects.

### Tests
- Extended dispatch plan exposure coverage to assert capability dimensions for main languages (`jsts`, `python`, `go`, `rust`, `ruby`) in `tests/clients/dispatch/plan-exposure.test.ts`.

## [3.8.12] - 2026-04-07

### Changed
- **Excluded-dir policy consolidated** — scanners now share `isExcludedDirName(...)` matching logic from `file-utils` instead of ad-hoc `EXCLUDED_DIRS.includes(...)` checks.
- **Pattern-aware exclusions** — exclusion matching now supports case-insensitive exact matches and lightweight glob patterns (for example `*.dSYM`).
- **Cross-scanner consistency** — startup scan, source filter, jscpd precheck, tree-sitter file collection, slop scan, production-readiness scan, and legacy scan-utils path checks now use the same exclusion semantics.

### Tests
- Added exclusion matcher coverage in `tests/clients/file-utils.test.ts`.
- Expanded source-filter coverage for glob exclusions (`*.dSYM`) and case-insensitive directory exclusion in `tests/source-filter.test.ts`.

## [3.8.11] - 2026-04-07

### Added
- **Experimental git guard flag** — added `--lens-guard` to gate commit/push attempts behind a blocker preflight check.
- **Git guard commit preflight** — when enabled, `bash` calls containing `git commit` or `git push` are blocked if unresolved inline blockers or pending turn-end blockers exist.

### Changed
- **Guard status tracking** — runtime now tracks blocker state/summary from post-write pipeline output so commit blocking messages stay concise and actionable.

### Tests
- Added focused coverage for git guard command detection and block/allow behavior in `tests/clients/git-guard.test.ts`.
- Updated runtime tool-result tests for guard status updates in `tests/clients/runtime-tool-result.test.ts`.

## [3.8.10] - 2026-04-07

### Changed
- **LSP default-on** — `--lens-lsp` is now enabled by default to provide unified LSP diagnostics across supported file kinds.
- **Capability-driven LSP dispatch** — dispatch now prepends LSP dynamically by file kind/flag state, while still using runtime `hasLSP(file)` checks for safe activation.
- **Fallback safety switch clarified** — `--no-lsp` is documented and wired as the explicit opt-out path to language-specific fallbacks.

### Fixed
- **`--no-lsp` consistency** — LSP sync/reset/navigation and runner gating now respect `--no-lsp` consistently, so fallback behavior is predictable.
- **LSP/lint overlap noise** — non-blocking lint diagnostics overlapping with LSP on the same file/line are suppressed to keep inline output focused.
- **turn_end actionability** — blocker summaries for jscpd/knip now include direct file hints to reduce path-guessing loops.
- **Architect invalid regex resilience** — malformed `must_not.pattern` expressions in `architect.yaml` are now logged and skipped instead of throwing during checks.
- **Architect runner path/cache stability** — cwd cache keys are now normalized and relative paths use `path.relative(...)`, preventing stale cache misses and Windows path edge cases.
- **`/lens-booboo` target-root consistency** — architectural checks now always reload config for the requested target path so scans don’t drift to a previous working directory.

## [3.8.9] - 2026-04-07

### Changed
- **README restructured** — Expanded the "What It Does" section with write/edit, session_start, and turn_end behavior; added a complete runner list and a dependency table with auto-installed vs manual tools.
- **Test runner strategy improved** — Added hybrid test targeting: rerun known failures first, otherwise run related tests for the edited file.

### Fixed
- **Non-JSON test runner parsing** — Go/Cargo/Dotnet/Gradle/Maven/RSpec/Minitest now use generic parsing instead of returning "Unknown runner".
- **Dispatch delta baseline compatibility** — Baseline lookups now support both normalized absolute and cwd-relative keys to prevent stale/new misclassification in mixed-key scenarios.

## [3.8.8] - 2026-04-07

### Changed
- **README massively simplified** — Reduced the README to core purpose, install/run, key commands, and concise usage notes.
- **Docs trimmed** — Removed deep internal documentation files from `docs/` to keep project docs minimal and focused.
- **Positioning text clarified** — Updated wording to describe pi-lens as real-time inline feedback for AI agents.

## [3.8.7] - 2026-04-06

### Fixed
- **Baseline duplication in dispatch delta mode** — `ctx.baselines.set()` was called with `[...allDiagnostics, ...diagnostics]`, but `allDiagnostics` already contained `diagnostics` from the push below. Baseline inflated by N items per dispatch, causing `filterDelta` to misidentify issues on subsequent writes.
- **No delta on warnings** — `DispatchResult.warnings` was cumulative (total warning count across all runs), so the `N warning(s) -> /lens-booboo` message never decreased even when the agent fixed warnings. Added `baselineWarningCount` to track the baseline separately. Message now shows `3 new (15 total) warning(s)` so the agent sees progress.
- **LSP sync fire-and-forget** — Phase 3 (LSP file sync) was attached via `.then()` without being awaited, so dispatch lint (phase 5) and cascade diagnostics (phase 7) ran against stale LSP state. Now properly `await`ed before subsequent phases.

## [3.8.6] - 2026-04-06

### Changed
- **Remove new-TODO reporting from turn_end** — The agent writes TODOs intentionally;
  reporting them back at turn-end is noise. Removed the diff-against-baseline TODO
  injection from turn-end findings.

## [3.8.5] - 2026-04-06

### Fixed
- **Pyright CLI duplicates LSP under `--lens-lsp`** — The Pyright CLI runner now skips
  itself when `--lens-lsp` is active, mirroring the existing `ts-lsp` behaviour. The
  `lsp` runner (priority 4, Pyright language server) already covers Python type-checking
  in that mode; running the CLI in parallel was redundant.


## [3.8.2] - 2026-04-06

### Fixed
- **npm publish bump** — 3.8.1 was already published with the broken postinstall; 3.8.2 contains the actual fix.

## [3.8.1] - 2026-04-06

### Fixed
- **`console-statement` hijacking `no-console-in-tests`** — The keyword match for
  `console-statement` (`pattern.includes("console")`) was catching `no-console-in-tests`
  because both contain "console". The simpler rule always won, so both fired on every
  console call. Fixed by excluding test-related patterns: `!pattern.includes("test")`.
- **`hardcoded-secrets` malformed tree-sitter query** — Had two top-level S-expression
  patterns instead of a single union pattern `[...]`. Replaced with valid union syntax
  and added `post_filter: check_secret_pattern` so variable names are actually filtered
  against credential patterns. Reduced false positives from 58 → 0 on the codebase.
- **`postinstall` failing on Windows** — `scripts/` was accidentally in `.gitignore` so
  `scripts/download-grammars.ts` was never committed. Added the script, which downloads
  the 10 tree-sitter WASM grammars from unpkg at install time. Also fixed `|| true`
  which is not valid on Windows cmd.exe — replaced with native Node TS execution via
  `node --experimental-strip-types` (Node 22+, no extra deps).

## [3.8.0] - 2026-04-05

### Added — Tree-sitter Expansion

- **Go, Rust, Ruby grammar support** — WASM grammars for 3 new languages downloaded at
  install time via `scripts/download-grammars.ts`. Grammar download script added with
  npm `download-grammars` script and postinstall hook. Tree-sitter structural analysis
  now covers all 7 dispatch languages: TypeScript, TSX, JavaScript, Python, Go, Rust, Ruby.

- **Tree-sitter dispatch for Go/Rust/Ruby** — Dispatch runner `appliesTo` extended;
  extension→language map replaces the brittle `endsWith` chain. Tree-sitter runner
  added to Go, Rust, and Ruby dispatch plans.

- **Incremental parse cache (`TreeCache`)** — AST trees are cached by SHA-256 content
  hash and mtime. Subsequent queries on the same file (same turn) skip re-parsing.
  Cache stores up to 50 files with LRU eviction. `calculateEdit()` + `incrementalUpdate()`
  infrastructure ready for full incremental parsing when old content is tracked.

- **AST navigator (`TreeSitterNavigator`)** — Scope-aware traversal utilities: `findParent()`,
  `isInTryCatch()`, `isInTestBlock()`, `isInLoop()`, `getScopeChain()`, `isShadowed()`,
  `getSiblings()`. Used by post-filters for context-aware rule evaluation.

- **Native predicate support in queries** — Query YAML files now support a `predicates:`
  array field. Rules with inline `#eq?` / `#match?` / `#not-eq?` predicates run filtering
  inside WASM rather than in JavaScript post-filters.

- **Inline fix hints** — Tree-sitter diagnostics now carry `fixable: true` and
  `fixSuggestion: "remove this statement"` when `has_fix: true` in the rule. Displayed
  as `💡 Fix: remove this statement` inline in the diagnostic output. Tree-sitter runner
  is read-only — linters (Biome/Ruff/ESLint) own the autofix phase.

- **New post-filters** — `not_in_try_catch`, `in_try_catch`, `not_in_test_block`,
  `not_in_function`, `check_secret_pattern`, `python_empty_except`, `ruby_empty_rescue`,
  `name_matches_param`.

### Added — New Rules (50+)

**Structural safety (ast-grep, TypeScript + JavaScript):**
- `unchecked-sync-fs` — `fs.statSync/readFileSync/writeFileSync/...` outside try/catch (error)
- `unchecked-throwing-call` — `JSON.parse`, `new URL()`, `execSync` outside try/catch (error)
- `no-nan-comparison` — `x === NaN` always false, use `Number.isNaN()` (error)
- `no-discarded-error` — `new Error()` as standalone statement without throw (error)

**Structural safety (ast-grep, Python):**
- `unchecked-throwing-call-python` — `open()`, `json.loads()`, `os.stat()` etc. outside
  try/except (error)

**Structural safety (ast-grep, Ruby):**
- `unchecked-throwing-call-ruby` — `File.read`, `JSON.parse`, `Integer()` etc. outside
  begin/rescue (error)

**Tree-sitter Python rules (new):**
- `python-mutable-class-attr` — class-level `list`/`dict`/`set` shared across all instances (error)
- `python-debugger` — `breakpoint()`, `pdb.set_trace()` left in code (error)
- `python-print-statement` — `print()` debug output in production code (warning)
- `python-hardcoded-secrets` — hardcoded credential assignments (error)
- `python-empty-except` — except block that only does `pass` (error)
- `python-unsafe-regex` — `re.compile(variable)` ReDoS risk (error)
- `python-raise-string` — `raise "string"` is TypeError in Python 3 (error)

**Tree-sitter Ruby rules (new):**
- `ruby-rescue-exception` — `rescue Exception` catches SystemExit and signals (error)
- `ruby-empty-rescue` — rescue with no body silently swallows errors (error)
- `ruby-debugger` — `binding.pry` / `binding.irb` left in code (error)
- `ruby-puts-statement` — `puts`/`p`/`pp` debug output in production (warning)
- `ruby-hardcoded-secrets` — hardcoded credential assignments (error)
- `ruby-unsafe-regex` — `Regexp.new(variable)` ReDoS risk (error)

**Tree-sitter Go rules (new):**
- `go-hardcoded-secrets` — hardcoded credentials in short/var/const declarations (error)

**JavaScript coverage (38 new rules):**
  All runtime-applicable TypeScript ast-grep rules now have JavaScript equivalents:
  `strict-equality`, `empty-catch`, `no-throw-string`, `no-cond-assign`,
  `no-async-promise-executor`, `toctou`, `no-hardcoded-secrets`, `no-inner-html`,
  `no-insecure-randomness`, `no-sql-in-code`, `jwt-no-verify`, `weak-rsa-key`, and 26 more.

### Changed — Severity Upgrades

**17 ast-grep rules upgraded from `warning` to `error`** (will crash / produce wrong output):
`empty-catch`, `array-callback-return`, `getter-return`, `jsx-boolean-short-circuit`,
`no-async-promise-executor`, `no-await-in-promise-all`, `no-bare-except`,
`no-compare-neg-zero`, `no-cond-assign`, `no-constant-condition`,
`no-constructor-return`, `no-insecure-randomness`, `no-prototype-builtins`,
`no-sql-in-code`, `no-throw-string`, `toctou`, `no-comparison-to-none`.

**4 tree-sitter rules upgraded from `warning` to `error`**:
`go-defer-in-loop`, `is-vs-equals`, `rust-unwrap`, `unsafe-regex`.

### Fixed

- **`console-statement` duplicating `no-console-in-tests`** — `console-statement` now
  uses `post_filter: not_in_test_block` so production and test console detection are
  mutually exclusive.

- **`variable-shadowing` never detecting actual shadowing** — Rule now captures both
  `@PARAM` and `@NAME`; `name_matches_param` post-filter only flags when names are
  identical. Previously the rule fired on any variable in a nested function.

- **`isInLoop()` false positives** — `call_expression` removed from loop node type list.
  Previously `isInLoop()` returned `true` inside any function call.

- **`injectPredicates()` inserting at wrong AST position** — Broken predicate injection
  machinery removed. Predicates already work inline in query S-expressions.

- **`sql-injection` rule not matching `db.query()`** — Query now uses union
  `[identifier | member_expression]` to catch both bare `query()` and `db.query()`.

- **`contains_sql_keywords` post-filter inverted logic** — Rule was skipping `sql`
  tagged templates (the primary SQL injection vector). Post-filter removed entirely;
  rule relies on inline `#match?` predicate.

- **`no-discarded-error` ast-grep `not: inside:` not traversing ancestors** — Required
  `stopBy: end` in ast-grep's `inside` predicate to check all ancestors, not just the
  direct parent. Applied to all `not: inside:` rules.

- **Go/Rust/Ruby rules silently skipped** — Runner `appliesTo` was `["jsts", "python"]`
  only. Extended to include `go`, `rust`, `ruby`.

### Fixed (from PR #1 — alexx-ftw)

- **`process.cwd()` wrong for global npm installs** — All asset resolution (WASM grammars,
  tree-sitter query YAMLs, ast-grep rule directories, `default-architect.yaml`) now uses
  `resolvePackagePath(import.meta.url, ...)` which walks up from the module file to the
  package root. Previously, running pi-lens as a globally installed extension would fail
  to find built-in rules and grammars.

- **Session start scanning `$HOME` or generic directories** — `resolveStartupScanContext()`
  gates all heavy startup scans (knip, jscpd, exports index, project index) behind project
  root detection (`.git`, `package.json`, `go.mod`, etc.) and a 2000-source-file budget.
  Pi-lens stays responsive when opened outside a real project.

- **`cachedExports` not cleared on session reset** — Export cache from the previous
  session persisted into new sessions, causing false duplicate-export warnings.

- **`biomeClient.ensureAvailable()` at session start** — Changed to `isAvailable()` so
  session start no longer blocks on a Biome auto-install. Installs happen lazily on
  first file write.

- **Project index not persisted across sessions** — Index now saved to disk after build
  via `saveIndex()`, and `isIndexFresh()` check skips rebuild when the saved index is
  still current.

- **`tree-sitter-query-loader` only loading from `process.cwd()`** — Now loads from
  both the user's project rules directory AND the package's built-in rules, merging
  both sets. Project-specific rules coexist with built-in rules.

---

## [3.7.2] - 2026-04-05

### Added
- **All-clear signal** — When the pipeline runs clean (no blockers, no test failures),
  the agent now receives a confirmation one-liner instead of silence:
  `✓ TypeScript clean · 12/12 tests · 847ms`
  When non-blocking warnings exist: `✓ no blockers · 3 warning(s) -> /lens-booboo · 847ms`
  Agents can now distinguish "checks ran clean" from "checks didn't run".

### Fixed
- **Auto-fix message now names the tool** — `✅ Auto-fixed 3 issue(s) (eslint:2, biome:1)`
  instead of the vague `Auto-fixed 3 issue(s)`. Agents know exactly what was corrected.

### Security
- **Remove `effect` dependency** — Used for 5 trivial `tryPromise` wrappers in one file,
  never consumed via Effect's runtime. Dead dependency removed.
- **`--ignore-scripts` in auto-installer** — `npm install` for auto-installed tools now
  passes `--ignore-scripts` by default. Only packages that legitimately need postinstall
  scripts to download native binaries (`@biomejs/biome`, `@ast-grep/napi`, `esbuild`) are
  allowlisted.
- **`npx -y` replaced with `npx --no`** — LSP server launch via npx no longer silently
  downloads uncached packages. `--no` fails fast if the package isn't cached; the
  interactive-install flow is the correct path for first-time installs.
- **Local-first `sg` (ast-grep) resolution** — All `sg` callers now check
  `node_modules/.bin/sg` → global `sg` → `npx --no sg` (cache-only). No silent
  network downloads of the ast-grep CLI.

---

## [3.7.2] - 2026-04-05 (previous)

### Added
- **ESLint `--fix` in autofix phase** — Projects with an ESLint config now have fixable
  issues auto-corrected (import ordering, jsx style, etc.) before dispatch runs, using
  `--fix-dry-run` to get the accurate fixed count then `--fix` to apply. Availability
  is cached per session. Only fires on JS/TS files with an ESLint config present.

### Fixed
- **Misleading infinite-loop comment in biome/ruff runners** — The comment incorrectly
  stated that writing files from runners would trigger infinite loops (formatters already
  prove this isn't true). Updated to explain the real reason: dispatch runners report
  issues for agent understanding; silently rewriting would leave the agent's context
  window stale.

---

## [3.7.1] - 2026-04-05

### Added
- **ESLint dispatch runner** — Projects with `.eslintrc` / `eslint.config.js` (any variant)
  now run ESLint automatically on every JS/TS file write. Prefers local
  `node_modules/.bin/eslint` over global. Skips silently on projects using Biome/OxLint
  (no ESLint config). ESLint errors (severity 2) are blocking; warnings are non-blocking.

- **golangci-lint dispatch runner** — Go projects with `.golangci.yml` / `.golangci.yaml`
  now run golangci-lint on every `.go` file write (in addition to `go-vet`). Parses JSON
  output. Skips when no config is present (avoids default-rule noise on non-opted-in
  projects). 60s timeout.

- **RuboCop dispatch runner** — Ruby files (`.rb`, `.rake`, `.gemspec`, `.ru`) now run
  RuboCop in lint-only mode on every write. Prefers `bundle exec rubocop` when a Gemfile
  references rubocop. Fatal/error offenses are blocking; convention/refactor are warnings.

- **`ruby` file kind** — `.rb`, `.rake`, `.gemspec`, `.ru` files are now recognised as
  `ruby` kind, enabling file-kind-gated runners and formatter detection.

---

## [3.7.0] - 2026-04-05

### Added
- **Test runner in pipeline** — After every file write/edit, pi-lens now automatically detects and
  runs the corresponding test file (vitest, jest, pytest). Results surface inline so the agent sees
  failures immediately without a separate test step. Supports TypeScript/JS/Python; file-level
  targeted — only the test for the edited file runs, not the full suite.

- **Parallel dispatch groups** — Lint runners now execute in parallel across independent groups
  (e.g. `lsp`, `tree-sitter`, `ast-grep-napi`, `type-safety`, `similarity` all fire at once).
  Typical wall-clock savings: 500–1500ms per file write (`parallelGainMs` logged in latency log).

### Fixed
- **`semantic: "none"` when 0 diagnostics** — LSP, Pyright, and type-safety runners were returning
  `semantic: "warning"` even when `diagnosticCount` was 0 (clean file). Now correctly returns
  `"none"` when no diagnostics are present, `"warning"` when warnings exist, `"blocking"` on errors.

- **`ast_grep_replace` with `apply=true` not writing files** — Replaced tool was silently
  discarding the rewritten content instead of persisting it to disk.

- **Pipeline event loop blocked during test execution** — `spawnSync` in the test runner was
  blocking the Node.js event loop for the duration of the test run. Switched to async spawn.

- **Formatters: venv/vendor/node_modules awareness** — Formatters now skip files inside virtual
  environments, vendor directories, and `node_modules` instead of attempting to format them.
  CSharpier detection also improved.

- **Formatter nearest-wins resolution** — When multiple formatter configs exist at different
  directory levels, the one closest to the edited file is now used (was previously using the
  root-level config regardless of nesting).

- **Prettier auto-install** — Prettier is now auto-installed when detected as the project
  formatter but not present, consistent with the Biome/Ruff auto-install behaviour.

- **6 missing formatters added** — `clang-format` (C/C++/ObjC), `ktlint` (Kotlin), `scalafmt`
  (Scala), `mix format` (Elixir), `dart format` (Dart), `terraform fmt` (HCL) now detected
  and invoked automatically.

- **LSP tier-4 install prompts** — Corrected missing interactive-install prompts for tier-4
  language servers (less common languages). Users now see the install suggestion instead of a
  silent skip.

### Changed
- **`startedAt` added to latency log runner entries** — Every runner entry now records when it
  started, making wall-clock vs. sequential comparisons accurate. `dispatch_complete` also logs
  `parallelGainMs = sumMs - wallClockMs` to quantify parallelism benefit.

- **Dynamic imports removed from hot path** — Dispatch module no longer uses `await import()`
  for runner loading; all imports are static, eliminating ~50ms warm-up latency on first dispatch.

### Tests
- Added formatter venv/vendor resolution and interactive-install coverage
- Added LSP lifecycle test suite with mock LSP server (process spawn, open/change/close, shutdown)

---

## [3.6.7] - 2026-04-04

### Fixed
- **LSP `ERR_STREAM_DESTROYED` crash** — When an LSP process (e.g. rust-analyzer) exits, Node.js emits
  `'error'` events on the destroyed stdio streams. Without listeners these became uncaught exceptions
  that crashed the extension. Added persistent `error` listeners to `stdin`, `stdout`, and `stderr`
  before handing them to `vscode-jsonrpc`, covering the post-`connection.dispose()` window.
  Same guard added to `NativeRustCoreClient` stdin writes.

### Added
- **Rust performance core (`pi-lens-core`)** — Optional Rust binary for CPU-intensive operations.
  All features fall back to TypeScript automatically if the binary is not available (it is **not**
  built automatically on `npm install` — run `npm run rust:build` once if you have Rust installed).
  - **File scanning** — ripgrep’s `ignore` crate for `.gitignore`-aware project scanning
  - **Similarity detection** — parallel 57×72 state-matrix index, persisted to
    `.pi-lens/rust-index.json` between invocations (fixes in-memory cache that reset on every
    process spawn)
  - **Tree-sitter queries** — TypeScript and Rust AST queries via the binary
  - **`NativeRustCoreClient`** — TypeScript wrapper with `isBinaryStale()` freshness detection,
    JSON-IPC over stdin/stdout
  - **Integration tests** — `npm run rust:test:integration` (37 assertions across all commands)

- **Rust similarity fast-path in dispatch runner** — `similarity.ts` now tries the Rust binary
  first (scan → build index → query), falls through to the TypeScript implementation on any
  failure. Feature flag `USE_RUST = true` at top of file.

### Changed
- **Similarity threshold raised from 0.75 → 0.90** — Empirical evaluation showed that below 0.90
  false positives (structurally similar but semantically unrelated functions) outnumber true
  positives with the current 57×72 matrix resolution. Applies to both the dispatch runner and
  `/lens-booboo`.

- **Rust `kind_id` mapping improved** — Replaced `kind % dim` modulo (caused up to 4 unrelated
  node types to share one matrix slot) with even-distribution across named slots plus a dedicated
  last slot for anonymous punctuation tokens. Max named-slot collisions reduced from 4 to 3;
  unnamed tokens no longer pollute named slots.

### Fixed (Rust)
- `tree_sitter_rust::language_rust()` → `language()` (correct API for tree-sitter-rust 0.21)
- `FunctionInfo` missing `#[derive(Clone)]` — caused compile error in `find_similar_to`
- `export function foo()` was missed by the index builder — TypeScript wraps exported functions
  in `export_statement`; replaced flat top-level walk with recursive `collect_functions()`
- `find_similar_to` returned only the first function in a file — changed `find` to `filter`
- `tempfile` moved from `[dependencies]` to `[dev-dependencies]`
- Deleted orphan `test_lsp.rs` (intentional type errors caused rust-analyzer to crash the LSP stream)

### Repository
- Rust source (`rust/src/`, `rust/Cargo.toml`) added to npm `files` whitelist so users can build
  the binary from an npm-installed package
- Removed stale `src/main.rs` rule from root `.gitignore` (no such file at repo root)
- Untracked `docs/plans/2025-04-03-auto-install-logging.md` (committed before `*.md` exclusion rule)

---

## [3.6.3] - 2026-04-03

### Removed (Dead Code Cleanup)
- **Deleted unused interviewer tool** — Browser-based interview with diff confirmation was never used:
  - Removed `clients/interviewer.ts` (290 lines)
  - Removed `clients/interviewer-templates.ts` (240 lines)
  - Removed initialization from `index.ts`
  
- **Deleted deprecated commands** — All were superseded by `/lens-booboo`:
  - `/lens-booboo-fix` command (fix-from-booboo.ts, 430 lines) — showed warning to use `/lens-booboo`
  - `/lens-fix-simplified` command (fix-simplified.ts, 770 lines) — never registered, unused
  - `/lens-rate` command (rate.ts, 340 lines) — showed warning to use `/lens-booboo`
  - `/lens-booboo-refactor` command (refactor.ts, 207 lines) — depended on removed interviewer tool

- **Deleted duplicate safe-spawn module**:
  - Removed `clients/safe-spawn-async.ts` (220 lines) — 100% duplicate of functions in `safe-spawn.ts`
  - All imports already used `safe-spawn.ts`, making `safe-spawn-async.ts` pure dead code

### Test Suite Overhaul
- **Removed ~85 wasteful/broken test files**:
  - "Is tool available" tests (8 files) — just checked if external CLIs installed
  - Heavy integration tests (2 files) — 5s timeouts, full codebase scans
  - Broken LSP tests (7 files) — import path errors
  - Broken runner tests (7 files) — thin CLI wrappers with wrong imports
  - Trivial utility tests (5 files) — file extension parsing, string sanitization
  
- **Added meaningful integration tests**:
  - `tests/clients/dispatch/dispatcher-flow.test.ts` — Runner registration, execution, delta mode, conditional runners
  - `tests/extension-hooks.test.ts` — pi API: tool/command/flag registration, event handlers
  - `tests/mocks/runner-factory.ts` — Mock runners for testing without real CLI tools

- **Results:** 22 tests passing in 1.2s (was 104 tests in ~18s with 48 failures)

## [3.6.2] - 2026-04-02

### Added
- **Condensed skill auto-loading** — Injects ~70-token tool selection guidance at session start (vs 1,355 for full skills):
  - Quick reference for when to use lsp_navigation vs ast_grep_search vs grep
  - References full skills for lazy loading (ast-grep, lsp-navigation)
  - Prevents common tool selection errors without loading full skill content

### Changed
- **Streamlined session start injection** — Removed TODO/Knip/jscpd reports from initial context:
  - Scans still run and cache for on-demand access via `/lens-booboo`
  - Reduces session start noise (only active tools list, error reminder, skill guidance remain)
  - Caching preserved for duplicate detection on file writes

## [3.6.1] - 2026-04-02

### Changed
- **Updated package description** — More concise: "Real-time code feedback for pi — LSP, linters, formatters, type-checking, structural analysis & booboo"

### Repository
- **AGENTS.md is now local-only** — Removed from git repo and added to `.gitignore` so it stays local to each developer's environment
- **Cleaned up debug files** — Removed old test files (`_debug-*.ts`, `_trigger-test.ts`, `_test-*.ts`) from repo

## [3.6.0] - 2026-04-02

### Added
- **LSP Call Hierarchy Support** — Added 3 new operations to `lsp_navigation` tool:
  - `prepareCallHierarchy` — Get callable item at position
  - `incomingCalls` — Find all functions/methods that CALL this function
  - `outgoingCalls` — Find all functions/methods CALLED by this function
  - Use case: "Who calls this function?" and "What does this function depend on?"
- **LSP Navigation Skill** — New built-in skill (`skills/lsp-navigation/SKILL.md`) that guides LLM on when to use LSP for code intelligence vs other tools
- **AST-Grep Skill Improvements** — Enhanced `skills/ast-grep/SKILL.md` with:
  - Testing Tips section (Search → Dry-run → Apply workflow)
  - Metavariable selection guide ($ vs $$$)
  - Specific guidance for "Multiple AST nodes" error
- **Skills Registration** — Extension now registers `skills/` directory via `resources_discover` event, exposing both `ast-grep` and `lsp-navigation` skills to pi
- **Enhanced TDI (Technical Debt Index) with 5-factor formula** — Now captures "worst offender" functions and code unpredictability:
  - **Max Cyclomatic (10%)**: Catches worst function complexity (avg hides bad apples)
  - **Entropy (5%)**: Measures code unpredictability/vocabulary richness in bits
  - Rebalanced weights: MI (45%), Cognitive (30%), Nesting (10%), MaxCyc (10%), Entropy (5%)
  - New thresholds: MaxCyc >10 bad, >30 critical; Entropy >4.0 bits risky, >7.0 critical

### Removed
- **TDR (Technical Debt Ratio)** — Removed orphaned metric tracking system:
  - Deleted `TDREntry`, `TDRCategory` types, `tdrFindings` Map, `updateTDR()` method
  - Removed `convertDiagnosticsToTDREntries()` helper and all `tdrCategory` assignments
  - Deleted TDR test file
  - TDI is sufficient for code health tracking; inline diagnostics provide immediate feedback

### Changed
- **Updated `/lens-tdi` display** — Shows 5 category breakdown with descriptions:
  ```
  Debt breakdown:
    Maintainability: 45% (MI-based)
    Cognitive: 30%
    Nesting: 10%
    Max Cyclomatic: 10% (worst function)
    Entropy: 5% (code unpredictability)
  ```
- **Extended MetricSnapshot** — Added `maxCyclomatic` and `entropy` fields for historical tracking

---

## [3.5.0] - 2026-04-02

### Added
- **Tree-sitter query compilation cache** — 10× performance improvement for structural analysis. Query files (`.yml`) are compiled to binary `.wasm-cache` format once and cached to disk. Subsequent loads use the compiled cache directly, reducing tree-sitter startup from ~50ms to ~5ms per query. Cache uses mtime-based invalidation — automatically recompiles when source `.yml` changes.
- **Rule cache infrastructure** (`clients/cache/`) — New disk-backed cache system with:
  - `RuleCache` class for storing compiled artifacts
  - mtime-based invalidation (auto-refresh when source files change)
  - JSON metadata tracking for cache entries
  - TTL and integrity validation

### Fixed
- **YAML parser colon truncation** — Fixed regex-based parser that incorrectly truncated values containing colons. Changed from `split(':', 2)` to `indexOf(':')` for proper value extraction.
- **Tree-sitter rules directory resolution** — Fixed path resolution to use `ctx.cwd` instead of hardcoded `.pi-lens/rules/` path. Rules now load correctly from the actual project root regardless of where pi is invoked.
- **Tree-sitter post_filter support** — Implemented missing `post_filter` functionality for tree-sitter queries. Rules with post-filters (e.g., semantic validation for `bare-except` vs specific exception handlers) now work correctly instead of being silently skipped.
- **Event handler silent crashes** — Wrapped all event handlers in try/catch to prevent unhandled exceptions from crashing the extension silently. Errors are now logged to stderr instead of terminating the process.
- **Latency logging restored** — Fixed missing latency logging in `tool_result` handler. Runner timing data now correctly flows to `~/.pi-lens/latency.log` again.

### Removed
- **Broken ast-grep rules** — Removed overlapping rules that were causing false positives or conflicts with tree-sitter coverage.

---

## [3.4.0] - 2026-04-02

### Fixed
- **Delta mode was broken** — `dispatchLint()` created a fresh empty baseline store on every call, making delta filtering a complete no-op. Every issue looked "new" every time. Now uses a persistent session-level baseline store. First write captures baseline, subsequent writes only show NEW issues.
- **Duplicate type-checking with `--lens-lsp`** — Both the `lsp` runner (priority 4) and `ts-lsp` runner (priority 5) were calling the same LSP service for TypeScript files. `ts-lsp` now skips when `--lens-lsp` is active.

### Added
- **Inline security rules via ast-grep-napi** — Re-enabled the ast-grep-napi runner for real-time blocking on security violations (`no-eval`, `jwt-no-verify`, `no-hardcoded-secrets`, `weak-rsa-key`, `no-open-redirect`, etc.). Only error-severity rules fire inline; warnings remain in `/lens-booboo`. Skips 5 rules already covered by tree-sitter to avoid duplicates. ~9ms execution time.
- **Pre-write duplicate detection (two layers):**
  - **Exact name match** — Checks exported names in new content against the session’s cached export index. If a function/class/type already exists in another file, blocks the write: `🔴 STOP — function X already exists in utils.ts. Import instead.`
  - **Structural similarity** — Parses new functions, builds AST state matrices, compares against the project index (built at session start). Functions with ≥80% structural similarity trigger a warning with the match location. Non-blocking.
- **Project similarity index at session start** — Builds 57×72 state matrices for all TS functions at session start (cached to `.pi-lens/index.json`). Makes pre-write similarity checks ~50ms instead of seconds.

### Changed
- **Extracted post-write pipeline** — Moved the entire post-write pipeline (secrets, format, autofix, dispatch, tests, cascade diagnostics) from `index.ts` into `clients/pipeline.ts`. `index.ts` reduced from 1764 to 1439 lines.
- **Removed inline complexity warnings** — `⚠️ Complexity increased: +4 cognitive` no longer shown on every write. No agent acts on this mid-task. Complexity data still captured for `/lens-booboo` and `/lens-tdi`.
- **Simplified pre-write handler** — Removed pre-write TypeScript and LSP diagnostics checks (checked old content before write landed — post-write catches everything). Kept only complexity baseline capture and duplicate detection.

---

## [3.3.1] - 2026-04-02

### Fixed
- **LSP spawn `EINVAL` on Windows** — `.cmd` files (e.g. `vscode-json-language-server.cmd`) found via npm global lookup were spawned without `shell: true`, causing `EINVAL` from `CreateProcess`. The `needsShell` recomputation for npm global paths incorrectly treated `.cmd` the same as `.exe`. Fixed in both primary and fallback spawn paths.
- **Unhandled `EINVAL` rejection** — LSP error handlers only caught `ENOENT` (binary not found). `EINVAL` (binary found but can't execute directly) now caught alongside `ENOENT` in both `launchLSP` and `launchViaPackageManager`.

---

## [3.3.0] - 2026-04-02

### Removed
- **`--lens-bus`**: Removed the experimental event bus system (Phase 1). The sequential dispatcher has richer features (delta mode, per-runner latency, baseline tracking) that the bus system never had.
- **`--lens-bus-debug`**: Removed alongside `--lens-bus`.
- **`--lens-effect`**: Removed the Effect-TS concurrent runner execution system (Phase 2). The sequential `dispatchForFile` is the authoritative implementation — it has delta mode, async `when()` handling, and latency tracking that the effect system lacked.

### Changed
- **LSP client**: `waitForDiagnostics` in `clients/lsp/client.ts` now uses a local `EventEmitter` scoped to the client instance instead of the global bus for internal diagnostic signalling.

---

## [3.2.0] - 2026-04-02

### Fixed
- **LSP server initialization errors** — Fixed `workspaceFolders` capability format that caused gopls and rust-analyzer to crash with JSON RPC parse errors. Changed from object `{supported: true, changeNotifications: true}` to simple boolean `true` for broader compatibility.
- **Formatter cwd not passed** — `formatFile` now passes `cwd` to `safeSpawn`, fixing Biome's "nested root configuration" error when formatting files in subdirectories.
- **LSP runner error handling** — Added try-catch around LSP operations to properly detect and report server spawn/connection failures instead of silently returning empty success.

### Changed
- **Go/Rust LSP initialization** — Added server-specific initialization options for better compatibility.

---

## [3.1.3] - 2026-04-02

### Fixed
- **Biome autofix: removed `--unsafe` flag** — `--unsafe` silently deleted unused variables
  and interfaces, removing code the agent was mid-way through writing (e.g. a new interface
  not yet wired up). Only safe fixes (`--write`) are now applied automatically on every write.
  Unsafe fixes require explicit opt-in.
- **Tree-sitter WASM crash on concurrent writes** — The tree-sitter runner was creating a
  `new TreeSitterClient()` on every post-write event. Each construction re-invoked
  `Parser.init()` → `C._ts_init()`, which resets the module-level `TRANSFER_BUFFER` pointer
  used by all active WASM operations. Concurrent writes (fast multi-file edits) raced on
  `_ts_init()` and corrupted shared WASM state → process crash. Fixed with a module-level
  singleton (`getSharedClient()`). Also fixes the secondary bug where each fresh client had
  an empty internal `queryLoader`, making the tree-sitter runner a silent no-op.
- **`blockingOnly` missing in bus/effect dispatchers** — `dispatchLintWithBus` and
  `dispatchLintWithEffect` were not passing `blockingOnly: true` to `createDispatchContext`,
  causing warning-level runners to execute on every write when `--lens-bus` or `--lens-effect`
  was active. Now consistent with the standard `dispatchLint` behaviour.
- **Async `when` condition silently ignored in bus dispatcher** — `dispatchConcurrent` was
  filtering runners with `.filter(r => r.when ? r.when(ctx) : true)`. Since `r.when(ctx)`
  returns `Promise<boolean>`, a truthy promise object was always passing the filter regardless
  of the actual condition. The check is now awaited properly inside `runRunner()`.

### Performance
- **Biome: local binary instead of npx** — `BiomeClient` now resolves
  `node_modules/.bin/biome.cmd` (Windows) or `node_modules/.bin/biome` before falling back
  to `npx @biomejs/biome`. Eliminates ~1 s npx startup overhead per invocation.
  Result: `checkFile` 1029 ms → **176 ms**, `fixFile` 2012 ms → **158 ms**.
- **Biome: eliminated redundant pre-flight `checkFile` in `fixFile`** — `fixFile` was calling
  `checkFile` (a full `biome check --reporter=json`) solely to count fixable issues for
  logging, then running `biome check --write` anyway. The count is now derived from the
  content diff (`changed ? 1 : 0`), saving one full biome invocation per write.
  Combined with the format phase, biome now runs at most **2×** per write (format + fix)
  instead of 3×.
- **TypeScript pre-write check: halved `getSemanticDiagnostics` calls** — `getAllCodeFixes()`
  was calling `getDiagnostics()` internally, but `index.ts` also called `getDiagnostics()`
  immediately before it — running the full TypeScript semantic analysis twice per pre-write
  event (~1.2 s each on a 1700-line file). `getAllCodeFixes` now accepts an optional
  `precomputedDiags` parameter; `index.ts` passes the already-computed result.
  `ts_pre_check` latency: ~2400 ms → **~1200 ms**.

---

## [3.1.1] - 2026-04-01

### Added
- **File-based latency logging** — Performance analysis via `~/.pi-lens/latency.log`
  - New `latency-logger.ts` module for centralized logging
  - Logs every runner's timing (ts-lsp, ast-grep-napi, biome, test-runner, etc.)
  - Logs tool_result overall timing with result status (completed/blocked/no_output)
  - JSON Lines format for easy analysis with `jq`
  - Read with: `cat ~/.pi-lens/latency.log | jq -s '.[] | select(.type=="runner")'`

---

## [3.1.0] - 2026-04-01

### Changed
- **Consolidated ast-grep runners** — Unified CLI and NAPI runners with shared rule set
  - NAPI runner now primary for dispatch (100x faster than CLI spawn)
  - Merged ts-slop-rules (21 files) into ast-grep-rules/slop-patterns.yml (33 patterns)
  - Removed 20 duplicate rule files with conflicting IDs (e.g., `ts-jwt-no-verify` vs `jwt-no-verify`)
  - Total: 104 unified rules (71 security/architecture + 33 slop patterns)
  - CLI ast-grep kept only for `ast_grep_search` / `ast_grep_replace` tools

### Fixed
- **ast-grep-napi stability** — Fixed stack overflow crashes in AST traversal
  - Added `_MAX_AST_DEPTH = 50` depth limit to `findByKind()` and `getAllNodes()`
  - Added `_MAX_RULE_DEPTH = 5` recursion limit for structured rules
  - Added `MAX_MATCHES_PER_RULE = 10` to prevent false positive explosions
  - Added `MAX_TOTAL_DIAGNOSTICS = 50` to prevent output spam
  - NAPI runner now safely handles deeply nested TypeScript files

---

## [3.0.1] - 2026-03-31

### Changed
- **Documentation refresh**: Updated npm and README descriptions for v3.0.0 features
  - New tagline: "pi extension for real-time code quality"
  - Highlights 31 LSP servers, tree-sitter analysis, auto-install capability
  - Clarified blockers vs warnings split (inline vs `/lens-booboo`)

### Fixed
- **Entropy threshold**: Increased from 3.5 → 5.5 bits to reduce false positives
  - Previous threshold was too sensitive for tooling codebases
  - Eliminates ~70-80% of "High entropy" warnings on legitimate complex code

---

## [3.0.0] - 2026-03-31

### Breaking Changes

#### Removed - Deprecated Commands
The following deprecated commands have been removed:
- `/lens-booboo-fix` → Use `/lens-booboo` with autofix capability
- `/lens-booboo-delta` → Delta mode now automatic
- `/lens-booboo-refactor` → Use `/lens-booboo` findings
- `/lens-metrics` → Metrics now in `/lens-booboo` report
- `/lens-rate` → Use `/lens-booboo` quality scoring

#### Changed - Blockers vs Warnings Architecture
- **🔴 Blockers** (type errors, secrets, empty catch blocks) → Appear **inline** and stop the agent
- **🟡 Warnings** (complexity, code smells) → Go to **`/lens-booboo`** only (not inline)
- Tree-sitter rules with `severity: error` now properly block inline
- Dispatcher checks individual diagnostic semantic, not just group default

### Added - Tree-Sitter Runner
New structural analysis runner at priority 14:
- **18 YAML query files** for TypeScript and Python patterns
- TypeScript: empty-catch, eval, debugger, console-statement, hardcoded-secrets, deep-nesting, deep-promise-chain, mixed-async-styles, nested-ternary, long-parameter-list, await-in-loop, dangerously-set-inner-html
- Python: bare-except, eval-exec, wildcard-import, is-vs-equals, mutable-default-arg, unreachable-except
- Blockers appear inline (severity: error), warnings go to `/lens-booboo` (severity: warning)

### Added - Auto-Install for Core Tools
Four tools now auto-install on first use (no manual setup required):
1. **TypeScript Language Server** (`typescript-language-server`) — TS/JS type checking
2. **Pyright** — Python type checking (`pip install pyright`)
3. **Ruff** — Python linting (`pip install ruff`)
4. **Biome** — JS/TS/JSON linting and formatting

Installs to `.pi-lens/tools/` with verification step (`--version` check).

### Added - NAPI Security Rules
Migrated 20 critical security rules to NAPI (fast native execution):
- Rules with `weight >= 4` are **blocking** (stop the agent)
- Includes: no-eval, no-hardcoded-secrets, no-implied-eval, no-inner-html, no-dangerously-set-inner-html, no-debugger, no-javascript-url, no-open-redirect, no-mutable-default, weak-rsa-key, jwt-no-verify, and more
- NAPI runs at priority 15 (after tree-sitter, before slop rules)

### Fixed
- **Tree-sitter query loading**: Added missing `loadQueries()` call before `getAllQueries()`
- **Windows path handling**: Changed from `lastIndexOf("/")` to `path.dirname()` for cross-platform compatibility
- **Dispatcher blocker detection**: Now checks if any individual diagnostic has `semantic === "blocking"`
- **Biome runner npx fallback**: Uses `npx biome` when `biome` not in PATH directly
- **LSP ENOENT crashes**: Added `_attachErrorHandler()` to all 23 manual-install LSP servers
- **LSP initialization timeout**: Increased to 120s (was 45s)
- **ESLint scope reduction**: Removed `.ts/.tsx` from ESLint LSP (now JS/framework files only)
- **Biome/Prettier race**: Biome is now default (priority 10), Prettier is fallback only

### Changed
- **README reorganization**: Removed redundant sections (Architecture, Language Support, Rules, Delta-mode, Slop Detection)
- **Consolidated Additional Safeguards** into Features section with Runners table
- **Updated .gitignore**: Local tracking files stay out of repo
- **Tuned thresholds**: 70-80% false positive reduction in booboo reports

---

## [2.7.0] - 2026-03-31

### Added - New Lint Runners

Three new lint runners with full test coverage:

- **Spellcheck runner** (`clients/dispatch/runners/spellcheck.ts`): Markdown spellchecking
  - Uses `typos-cli` (Rust-based, fast, low false positives)
  - Checks `.md` and `.mdx` files
  - Priority 30, runs after code quality checks
  - Zero-config by default
  - Install: `cargo install typos-cli`

- **Oxlint runner** (`clients/dispatch/runners/oxlint.ts`): Fast JS/TS linting
  - Uses `oxlint` from Oxc project (Rust-based, ~100x faster than ESLint)
  - Zero-config by default
  - JSON output with fix suggestions
  - Priority 12 (between biome=10 and slop=25)
  - Fallback mode after biome
  - Install: `npm install -D oxlint` or `cargo install oxlint`
  - Flag: `--no-oxlint` to disable

- **Shellcheck runner** (`clients/dispatch/runners/shellcheck.ts`): Shell script linting
  - Industry-standard linter for bash/sh/zsh/fish
  - Detects syntax errors, undefined variables, quoting issues
  - Priority 20 (same as type-safety)
  - JSON output parsing
  - Install: `apt install shellcheck`, `brew install shellcheck`, or `cargo install shellcheck`
  - Flag: `--no-shellcheck` to disable

### Changed
- Updated README.md with new runners in dispatcher diagram and available runners table
- Added installation instructions for new tools in Dependent Tools section
- Added new flags to Flag Reference

---

## [2.6.0] - 2026-03-30

### Added - Phase 1: Event Bus Architecture
- **Event Bus System** (`clients/bus/`): Decoupled pub/sub for diagnostic events
  - `bus.ts` — Core publish/subscribe with `once()`, `waitFor()`, middleware support
  - `events.ts` — 12 typed event definitions (DiagnosticFound, RunnerStarted, LspDiagnostic, etc.)
  - `integration.ts` — Integration hooks for pi-lens index.ts with aggregator state
- **Bus-integrated dispatcher** (`clients/dispatch/bus-dispatcher.ts`): Concurrent runner execution with event publishing
- **New flags**: `--lens-bus`, `--lens-bus-debug` for event system control

### Added - Phase 2: Effect-TS Service Layer
- **Effect-TS infrastructure** (`clients/services/`): Composable async operations
  - `runner-service.ts` — Concurrent runner execution with timeout handling
  - `effect-integration.ts` — Bus-integrated Effect dispatch
- **Structured concurrency**: `Effect.all()` with `{ concurrency: "unbounded" }`
- **Graceful error recovery**: Individual runner failures don't stop other runners
- **New flag**: `--lens-effect` for concurrent execution

### Added - Phase 3: Multi-LSP Client (31 Language Servers)
- **LSP Core** (`clients/lsp/`): Full Language Server Protocol support
  - `client.ts` — JSON-RPC client with debounced diagnostics (150ms)
  - `server.ts` — 31 LSP server definitions with root detection
  - `language.ts` — File extension to LSP language ID mappings
  - `launch.ts` — LSP process spawning utilities
  - `index.ts` — Service layer with Effect integration
  - `config.ts` — Custom LSP configuration support (`.pi-lens/lsp.json`)
- **Built-in servers** (31 total):
  - Core: TypeScript, Python, Go, Rust, Ruby, PHP, C#, F#, Java, Kotlin
  - Native: C/C++, Zig, Swift, Dart, Haskell, OCaml, Lua
  - Functional: Elixir, Gleam, Clojure
  - DevOps: Terraform, Nix, Docker, Bash
  - Config: YAML, JSON, Prisma
  - Web (NEW): Vue, Svelte, ESLint, CSS/SCSS/Sass/Less
- **Smart root detection**: `createRootDetector()` walks up tree looking for lockfiles/config
- **Multi-server support**: Multiple LSP servers can handle same file type
- **Debounced diagnostics**: 150ms debounce for cascading diagnostics (syntax → semantic)
- **New flag**: `--lens-lsp` to enable LSP system
- **Deprecated**: Old `ts-lsp` runner falls back to built-in TypeScriptClient when `--lens-lsp` not set

### Added - Phase 4: Auto-Installation System
- **Auto-installer** (`clients/installer/`): Automatic tool installation
  - `index.ts` — Core installation logic for npm/pip packages
  - `isToolInstalled()` — Check global PATH or local `.pi-lens/tools/`
  - `installTool()` — Auto-install via npm or pip
  - `ensureTool()` — Check first, install if missing
- **Auto-installation for**: typescript-language-server, pyright, ruff, biome, ast-grep
- **Local tools directory**: `.pi-lens/tools/node_modules/.bin/`
- **PATH integration**: Local tools automatically added to PATH
- **LSP integration**: TypeScript and Python servers now use `ensureTool()` before spawning

### Changed - Commands
- **Disabled**: `/lens-booboo-fix` — Now shows warning "currently disabled. Use /lens-booboo"
- **Disabled**: `/lens-booboo-delta` — Now shows warning "currently disabled. Use /lens-booboo"
- **Disabled**: `/lens-booboo-refactor` — Now shows warning "currently disabled. Use /lens-booboo"
- **Active**: `/lens-booboo` — Full codebase review (only booboo command now)

### Changed - Architecture
- **Three-phase system**: Bus → Effect → LSP can be enabled independently
- **Dispatcher priority**: `lens-effect` > `lens-bus` > default (sequential)
- **LSP deprecation**: Old built-in TypeScriptClient deprecated, LSP client preferred

### Documentation
- **LSP configuration guide**: `docs/LSP_CONFIG.md` — How to add custom LSP servers
- **README updated**: Added LSP section, three-phase architecture, 31 language matrix
- **CHANGELOG restructured**: Now organized by Phase 1/2/3/4

### Technical Details
- **New dependencies**: `effect` (Phase 2), `vscode-jsonrpc` (Phase 3)
- **Lines added**: ~6,000 across 4 phases
- **Test status**: 617 passing (3 flaky unrelated tests)
- **Backward compatibility**: All new features opt-in via flags

## [2.5.0] - 2026-03-30

### Added
- **Python tree-sitter support**: 6 structural patterns for Python code analysis
  - `bare-except` — Detects `except:` that catches SystemExit/KeyboardInterrupt
  - `mutable-default-arg` — Detects mutable defaults like `def f(x=[])`
  - `wildcard-import` — Detects `from module import *`
  - `eval-exec` — Detects `eval()` and `exec()` security risks
  - `is-vs-equals` — Detects `is "literal"` that should use `==`
  - `unreachable-except` — Detects unreachable exception handlers
- **Multi-language tree-sitter architecture**: Query files in `rules/tree-sitter-queries/{language}/`
  - TypeScript/TSX: 10 patterns
  - Python: 6 patterns
- **Tree-sitter query loader**: YAML-based query definitions with multi-line array support
- **Query file extraction**: Moved TypeScript patterns from embedded code to `rules/tree-sitter-queries/typescript/*.yml`

### Changed
- **README updated**: Added Python patterns to structural analysis section
- **Architect client**: Fixed TypeScript errors (`configPath` property declaration)

### Technical Details
- Downloaded `tree-sitter-python.wasm` (458KB) for Python AST parsing
- Post-filters for semantic validation (e.g., distinguishing bare except from specific handlers)
- ~50ms analysis time per file for Python

## [2.4.0] - 2026-03-30

### Added
- **`safeSpawn` utility**: Cross-platform spawn wrapper that eliminates `DEP0190` deprecation warnings on Windows. Uses command string construction instead of shell+args array.
- **Runner tracking for `/lens-booboo`**: Each runner now reports execution time and findings count. Summary shows `[1/10] runner name...` progress and final table with `| Runner | Status | Findings | Time |`.
- **Shared runner utilities**: Extracted `runner-helpers.ts` with:
  - `createAvailabilityChecker()` - cached tool availability checks
  - `createConfigFinder()` - rule directory resolution
  - `createVenvFinder()` - venv-aware command lookup
  - Shared `isSgAvailable()` for ast-grep
- **Shared diagnostic parsers**: Extracted `diagnostic-parsers.ts` with:
  - `createLineParser()` - factory for line-based tool output
  - `parseRuffOutput`, `parseGoVetOutput`, `createBiomeParser()` - pre-built parsers
  - `createSimpleParser()` - simplified factory for standard formats
- **Architect test coverage**: 5 new tests for the architect runner (config loading, size limits, pattern detection, test file exclusion).
- **Type extraction**: Created `clients/ast-grep-types.ts` to break circular dependencies between `ast-grep-client`, `ast-grep-parser`, and `ast-grep-rule-manager`.

### Changed
- **26 files refactored to use `safeSpawn`**: Eliminated `shell: process.platform === "win32"` deprecation pattern across all clients and runners.
- **Updated runners to use shared utilities**:
  - `ruff.ts`, `pyright.ts` → use `createAvailabilityChecker()`
  - `python-slop.ts`, `ts-slop.ts` → use `createConfigFinder()` and shared `isSgAvailable()`
  - `ruff.ts`, `go-vet.ts`, `biome.ts` → use shared diagnostic parsers
- **Architect runner improvements**:
  - Added `skipTestFiles: true` to reduce noise from test files
  - Updated `default-architect.yaml` with per-file-type limits (500 services, 1000 clients, 5000 tests)
  - Removed `no process.env` rule (too strict for CLI tools)
  - Relaxed `console.log` rule to only apply to `src/` and `lib/` directories
- **Test cleanup safety**: Fixed all test files to use `fs.existsSync()` before `fs.unlinkSync()` to prevent ENOENT errors.

### Fixed
- **Circular dependencies**: Eliminated 2 cycles (`ast-grep-client` ↔ `ast-grep-parser`, `ast-grep-client` ↔ `ast-grep-rule-manager`) by extracting shared types.
- **Test flakiness**: All 70 test files now pass consistently (666 tests total).

### Code Quality
- **Lines saved**: ~350 lines of duplicated code removed across utilities and parsers.
- **Architect violations**: Reduced from 404 to ~50-80 (after test file exclusion + relaxed rules).

## [2.3.0] - 2026-03-30

### Added
- **NAPI-based runner (`ast-grep-napi`)**: 100x faster TypeScript/JavaScript analysis (~9ms vs ~1200ms). Uses `@ast-grep/napi` for native-speed structural pattern matching. Priority 15, applies to TS/JS files only.
- **Python slop detection (`python-slop`)**: New CLI runner with ~40 AI slop patterns from slop-code-bench research. Detects chained comparisons, manual min/max, redundant if/else, list comprehension opportunities, etc.
- **TypeScript slop detection (`ts-slop-rules`)**: ~30 patterns for TS/JS slop detection including `for-index-length`, `empty-array-check`, `redundant-filter-map`, `double-negation`, `unnecessary-array-from`.
- **`fix-simplified.ts` command**: New streamlined `/lens-booboo-fix` implementation with file-level exclusions (test files, excluded dirs) and anti-slop guidance. Uses `pi.sendUserMessage()` for actionable AI prompts.
- **Comprehensive test coverage**: 25+ tests added across all runners (NAPI, Python slop, TS slop, YAML loading).
- **Codebase self-scan**: `scan_codebase.test.ts` for testing the NAPI runner against the pi-lens codebase itself.

### Changed
- **Architecture documentation**: Updated README with complete architecture overview, runner system diagram, and language support matrix.
- **Disabled problematic slop rules**: `ts-for-index-length` and `ts-unnecessary-array-isarray` disabled due to false positives on legitimate index-based operations.
- **Runner registration**: Updated `clients/dispatch/runners/index.ts` with new runner priorities (ts-lsp/pyright at 5, ast-grep-napi at 15, python-slop at 25).
- **TS slop runner disabled**: CLI runner `ts-slop.ts` disabled in favor of NAPI-based detection (faster, same rules).

### Deprecated
- **`/lens-rate` command**: Now shows deprecation warning. Needs re-structuring. Users should use `/lens-booboo` instead.
- **`/lens-metrics` command**: Now shows deprecation warning. Temporarily disabled, will be restructured. Users should use `/lens-booboo` instead.

### Removed
- **Old implementations removed**: 259 lines of deprecated command code removed from `index.ts`.

### Repository Cleanup
- **Local-only files removed from GitHub**: `.pisessionsummaries/` and `refactor.md` removed from repo (still in local `.gitignore`).

## [2.1.1] - 2026-03-29

### Added
- **Content-level secret scanning**: Catches secrets in ANY file type on write/edit (`.env`, `.yaml`, `.json`, not just TypeScript). Blocks before save with patterns for `sk-*`, `ghp_*`, `AKIA*`, private keys, hardcoded passwords.
- **Project rules integration**: Scans for `.claude/rules/`, `.agents/rules/`, `CLAUDE.md`, `AGENTS.md` at session start and surfaces in system prompt.
- **Grep-ability rules**: New ast-grep rules for `no-default-export` and `no-relative-cross-package-import` to improve agent searchability.

### Changed
- **Inline feedback stripped to blocking only**: Warnings no longer shown inline (noise). Only blocking violations and test failures interrupt the agent.
- **booboo-fix output compacted**: Summary in terminal, full plan in `.pi-lens/reports/fix-plan.tsv`.
- **booboo-refactor output compacted**: Top 5 worst offenders in terminal, full ranked list in `.pi-lens/reports/refactor-ranked.tsv`.
- **`ast_grep_search` new params**: Added `selector` (extract specific AST node) and `context` (show surrounding lines).
- **`ast_grep_replace` mode indicator**: Shows `[DRY-RUN]` or `[APPLIED]` prefix.
- **no-hardcoded-secrets**: Fixed to only flag actual hardcoded strings (not `process.env` assignments).
- **no-process-env**: Now only flags secret-related env vars (not PORT, NODE_ENV, etc.).
- **Removed Factory AI article reference** from architect.yaml.

## [2.0.40] - 2026-03-27

### Changed
- **Passive capture on every file edit**: `captureSnapshot()` now called from `tool_call` hook with 5s debounce. Zero latency — reuses complexity metrics already computed for real-time feedback.
- **Skip duplicate snapshots**: Same commit + same MI = no write (reduces noise).

## [2.0.39] - 2026-03-27

### Added
- **Historical metrics tracking**: New `clients/metrics-history.ts` module captures complexity snapshots per commit. Tracks MI, cognitive complexity, and nesting depth across sessions.
- **Trend analysis in `/lens-metrics`**: New "Trend" column shows 📈/📉/➡️ with MI delta. "Trend Summary" section aggregates improving/stable/regressing counts with worst regressions.
- **Passive capture**: Snapshots captured on every file edit (tool_call hook) + `/lens-metrics` run. Max 20 snapshots per file (sliding window).

## [2.0.38] - 2026-03-27

### Changed
- **Refactored 4 client files** via `/lens-booboo-refactor` loop:
  - `biome-client.ts`: Extracted `withValidatedPath()` guard pattern (4 methods consolidated)
  - `complexity-client.ts`: Extracted `analyzeFile()` pipeline into `readAndParse()`, `computeMetrics()`, `aggregateFunctionStats()`
  - `dependency-checker.ts`: Simplified `importsChanged()` — replaced 3 for-loops with `setsEqual()` helper
  - `ast-grep-client.ts`: Simplified `groupSimilarFunctions()` with `filter().map()` pattern + `extractFunctionName()` helper

## [2.0.29] - 2026-03-26

### Added
- **`clients/ts-service.ts`**: Shared TypeScript service that creates one `ts.Program` per session. Both `complexity-client` and `type-safety-client` now share the same program instead of creating a new one per file. Significant performance improvement on large codebases.

### Removed
- **3 redundant ast-grep rules** that overlap with Biome: `no-var`, `prefer-template`, `no-useless-concat`. Biome handles these natively with auto-fix. ast-grep no longer duplicates this coverage.
- **`prefer-const` from RULE_ACTIONS** — no longer needed (Biome handles directly).

### Changed
- **Consolidated rule overlap**: Biome is now the single source of truth for style/format rules. ast-grep focuses on structural patterns Biome doesn't cover (security, design smells, AI slop).

## [2.0.27] - 2026-03-26

### Added
- **`switch-exhaustiveness` check**: New type safety rule detects missing cases in union type switches. Uses TypeScript compiler API for type-aware analysis. Reports as inline blocker: `🔴 STOP — Switch on 'X' is not exhaustive. Missing cases: 'Y'`.
- **`clients/type-safety-client.ts`**: New client for type safety checks. Extensible for future checks (null safety, exhaustive type guards).

### Changed
- **Type safety violations added to inline feedback**: Missing switch cases now block the agent mid-task, same as TypeScript errors.
- **Type safety violations in `/lens-booboo-fix`**: Marked as agent-fixable (add missing case or default clause).

## [2.0.26] - 2026-03-26

### Added
- **5 new ast-grep rules** for AI slop detection:
  - `no-process-env`: Block direct `process.env` access (use DI or config module) — error level
  - `no-param-reassign`: Detect function parameter reassignment — warning level
  - `no-single-char-var`: Flag single-character variable names — info level
  - `switch-without-default`: Ensure switch statements have default case — warning level
  - `no-architecture-violation`: Block cross-layer imports (models/db) — error level

### Changed
- **RULE_ACTIONS updated** for new rules:
  - `agent` type (inline + booboo-fix): `no-param-reassign`, `switch-without-default`, `switch-exhaustiveness`
  - `skip` type (booboo-refactor only): `no-process-env`, `no-single-char-var`, `no-architecture-violation`

## [2.0.24] - 2026-03-26

### Changed
- **Simplified `/lens-booboo-refactor` confirmation flow**: Post-change report instead of pre-change gate. Agent implements first, then shows what was changed (git diff + metrics delta). User reviews and can request refinements via chat. No more temp files or dry-run diffs.
- **Confirmation screen**: "✅ Looks good — move to next offender" / "💬 Request changes" (chat textarea). Diff display is optional.

## [2.0.23] - 2026-03-26

### Changed
- **Extracted interviewer and scan modules from `index.ts`**: `index.ts` reduced by 460 lines.
  - `clients/interviewer.ts` — all browser interview infrastructure (HTML generation, HTTP server, browser launch, option selection, diff confirmation screen)
  - `clients/scan-architectural-debt.ts` — shared scanning utilities (`scanSkipViolations`, `scanComplexityMetrics`, `scoreFiles`, `extractCodeSnippet`)
- **`/lens-booboo-refactor`** now uses imported scan functions instead of duplicated inline code.

## [2.0.22] - 2026-03-26

### Added
- **Impact metrics in interview options**: Each option now supports an `impact` object (`linesReduced`, `miProjection`, `cognitiveProjection`) rendered as colored badges in the browser form. Agent estimates impact when presenting refactoring options.
- **Iterative confirmation loop**: Confirmation screen now includes "🔄 Describe a different approach" option with free-text textarea. Agent regenerates plan+diff based on feedback, re-opens confirmation. Repeat until user confirms or cancels.
- **Auto-close on confirm**: Browser tab closes automatically after user submits.

## [2.0.21] - 2026-03-26

### Added
- **Two-step confirmation for `/lens-booboo-refactor`**: Agent implements changes, then calls `interviewer` with `confirmationMode=true` to show plan (markdown) + unified diff (green/red line coloring) + line counts at the top. User can Confirm, Cancel, or describe a different approach.
- **Plan + diff confirmation screen**: Plan rendered as styled markdown, diff rendered with syntax-colored `+`/`-` lines. Line counts (`+N / −N`) shown in diff header.

## [2.0.20] - 2026-03-26

### Added
- **Impact metrics in interview options**: Structured `impact` field per option with `linesReduced`, `miProjection`, `cognitiveProjection`. Rendered as colored badges (green for lines reduced, blue for metric projections) inside each option card.

## [2.0.19] - 2026-03-26

### Changed
- **`/lens-booboo-fix` jscpd filter**: Only within-file duplicates shown in actionable section. Cross-file duplicates are architectural — shown in skip section only.
- **AI slop filter tightened**: Require 2+ signals per file (was 1+). Single-issue flags on small files are noise — skip them.

## [2.0.18] - 2026-03-26

### Fixed
- **`/lens-booboo-fix` max iterations**: Session file auto-deletes when hitting max iterations. Previously blocked with a manual "delete .pi-lens/fix-session.json" message.

## [2.0.17] - 2026-03-26

### Changed
- **Agent-driven option generation**: `/lens-booboo-refactor` no longer hardcodes refactoring options per violation type. The command scans and presents the problem + code to the agent; the agent analyzes the actual code and generates 3-5 contextual options with rationale and impact estimates. Calls the `interviewer` tool to present them.
- **`interviewer` tool**: Generic, reusable browser-based interview mechanism. Accepts `question`, `options` (with `value`, `label`, `context`, `recommended`, `impact`), and `confirmationMode`. Zero dependencies — Node's built-in `http` module + platform CLI `open`/`start`/`xdg-open`.

## [2.0.16] - 2026-03-26

### Added
- **`/lens-booboo-refactor`**: Interactive architectural refactor session. Scans for worst offender by combined debt score (ast-grep skip violations + complexity metrics). Opens a browser interview with the problem, code context, and AI-generated options. Steers the agent to propose a plan and wait for user confirmation before making changes.

### Changed
- **Inline tool_result suppresses skip-category rules**: `long-method`, `large-class`, `long-parameter-list`, `no-shadow`, `no-as-any`, `no-non-null-assertion`, `no-star-imports` no longer show as hard stops in real-time feedback. They are architectural — handled by `/lens-booboo-refactor` instead.

## [2.0.15] - 2026-03-26

### Removed
- **Complexity metrics from real-time feedback**: MI, cognitive complexity, nesting depth, try/catch counts, and entropy scores removed from tool_result output. These were always noise — the agent never acted on "MI dropped to 5.6" mid-task. Metrics still available via `/lens-metrics` and `/lens-booboo`.
- **Session summary injection**: The `[Session Start]` block (TODOs, dead code, jscpd, type-coverage) is no longer injected into the first tool result. Scans still run for caching purposes (exports, clones, baselines). Data surfaced on-demand via explicit commands.
- **`/lens-todos`**: Removed (covered by `/lens-booboo`).
- **`/lens-dead-code`**: Removed (covered by `/lens-booboo`).
- **`/lens-deps`**: Removed — circular dep scan added to `/lens-booboo` as Part 8.

### Changed
- **Hardened stop signals**: New violations (ast-grep, Biome, jscpd, duplicate exports) now all use `🔴 STOP` framing. The agent is instructed to fix these before continuing.
- **`/lens-booboo` now includes circular dependencies**: Added as Part 8 (after type coverage) using `depChecker.scanProject`.

## [2.0.14] - 2026-03-26

### Fixed
- **`/lens-booboo-fix` excludes `.js` compiled output**: Detects `tsconfig.json` and excludes `*.js` from jscpd, ast-grep, and complexity scans. Prevents double-counting of the same code in `.ts` and `.js` forms.
- **`raw-strings` rule added to skip list**: 230 false positives in CLI/tooling codebases.
- **`typescript-client.ts` duplication**: Extracted `resolvePosition()`, `resolveTree()`, and `toLocations()` helpers, deduplicating 6+ LSP methods.
- **All clients**: `console.log` → `console.error` in verbose loggers (stderr for debug, stdout for data).

## [2.0.13] - 2026-03-26

### Removed
- **`raw-strings` ast-grep rule**: Not an AI-specific pattern. Humans write magic strings too. Biome handles style. Generated 230 false positives on first real run.

## [2.0.12] - 2026-03-26

### Fixed
- **`/lens-booboo-fix` sequential scan order**: Reordered to Biome/Ruff → jscpd (duplicates) → knip (dead code) → ast-grep → AI slop → remaining Biome. Duplicates should be fixed before violations (fixing one fixes both). Dead code should be deleted before fixing violations in it.

### Changed
- **Remaining Biome section rephrased**: "These couldn't be auto-fixed even with `--unsafe` — fix each manually."

## [2.0.11] - 2026-03-26

### Added
- **Circular dependency scan to `/lens-booboo`**: Added as Part 8, using `depChecker.scanProject()` to detect circular chains across the codebase.

### Removed
- **`/lens-todos`**, **`/lens-dead-code`**, **`/lens-deps`**: Removed standalone commands — all covered by `/lens-booboo`.

## [2.0.10] - 2026-03-26

### Changed
- **Session summary injection removed**: The `[Session Start]` block is no longer injected into the first tool result. Scans still run silently for caching (exports for duplicate detection, clones for jscpd, complexity baselines for deltas).

## [2.0.1] - 2026-03-25

### Fixed
- **ast-grep in `/lens-booboo` was silently dropping all results** — newer ast-grep versions exit `0` with `--json` even when issues are found; fixed the exit code check.
- **Renamed "Design Smells" to "ast-grep"** in booboo report — the scan runs all 65 rules (security, correctness, style, design), not just design smells.

### Changed
- **Stronger real-time feedback messages** — all messages now use severity emoji and imperative language:
  - `🔴 Fix N TypeScript error(s) — these must be resolved`
  - `🧹 Remove N unused import(s) — they are dead code`
  - `🔴 You introduced N new structural violation(s) — fix before moving on`
  - `🟠 You introduced N new Biome violation(s) — fix before moving on`
  - `🟡 Complexity issues — refactor when you get a chance`
  - `🟠 This file has N duplicate block(s) — extract to shared utilities`
  - `🔴 Do not redefine — N function(s) already exist elsewhere`
- **Biome fix command is now a real bash command** — `npx @biomejs/biome check --write <file>` instead of `/lens-format` (which is a pi UI command, not runnable from agent tools).
- **Complexity warnings skip test files in real-time** — same exclusion as lens-booboo.

## [2.0.0] - 2026-03-25

### Added
- **`/lens-metrics` command**: Measure complexity metrics for all files. Exports a full `report.md` with A-F grades, summary stats, AI slop aggregate table, and top 10 worst files with actionable warnings.
- **`/lens-booboo` saves full report**: Results saved to `.pi-lens/reviews/booboo-<timestamp>.md` — no truncation, all issues, agent-readable.
- **AI slop indicators**: Four new real-time and report-based detectors:
  - `AI-style comments` — emoji and boilerplate comment phrases
  - `Many try/catch blocks` — lazy error handling pattern
  - `Over-abstraction` — single-use helper functions
  - `Long parameter list` — functions with > 6 params
- **`SubprocessClient` base class**: Shared foundation for CLI tool clients (availability check, logging, command execution).
- **Shared test utilities**: `createTempFile` and `setupTestEnvironment` extracted to `clients/test-utils.ts`, eliminating copy-paste across 13 test files.

### Changed
- **Delta mode for real-time feedback**: ast-grep and Biome now only show *new* violations introduced by the current edit — not all pre-existing ones. Fixed violations shown as `✓ Fixed: rule-name (-N)`. No change = silent.
- **Removed redundant pre-write hints**: ast-grep and Biome pre-write counts removed (delta mode makes them obsolete). TypeScript pre-write warning kept (blocking errors).
- **Test files excluded from AI slop warnings**: MI/complexity thresholds are inherently low in test files — warnings suppressed for `*.test.ts` / `*.spec.ts`.
- **Test files excluded from TODO scanner**: Test fixture annotations (`FIXME`, `BUG`, etc.) no longer appear in TODO reports.
- **ast-grep excludes test files and `.pi-lens/`**: Design smell scan in `/lens-booboo` skips test files (no magic-numbers noise) and internal review reports.
- **jscpd excludes non-code files**: `.md`, `.json`, `.yaml`, `.yml`, `.toml`, `.lock`, and `.pi-lens/` excluded from duplicate detection — no more false positives from report files.
- **Removed unused dependencies**: `vscode-languageserver-protocol` and `vscode-languageserver-types` removed; `@sinclair/typebox` added (was unlisted).

### Fixed
- Removed 3 unconditional `console.log` calls leaking `[scan_exports]` to terminal.
- Duplicate Biome scan in `tool_call` hook eliminated (was scanning twice for pre-write hint + baseline).

## [1.3.14] - 2026-03-25

### Added
- **Actionable feedback messages**: All real-time warnings now include specific guidance on what to do.
- **Code entropy metric**: Shannon entropy in bits (threshold: >3.5 indicates risky AI-induced complexity).
- **Advanced pattern matching**: `/lens-booboo` now finds structurally similar functions (e.g., `formatDate` and `formatTimestamp`).
- **Duplicate export detection**: Warns when redefining a function that already exists in the codebase.
- **Biome formatting noise removed**: Only lint issues shown in real-time; use `/lens-format` for formatting.

## [1.3.10] - 2026-03-25

### Added
- **Actionable complexity warnings**: Real-time feedback when metrics break limits with specific fix guidance.

## [1.3.9] - 2026-03-25

### Fixed
- **Entropy calculation**: Corrected to use bits with 3.5-bit threshold for AI-induced complexity.

## [1.3.8] - 2026-03-25

### Added
- **Code entropy metric**: Shannon entropy to detect repetitive or unpredictable code patterns.

## [1.3.7] - 2026-03-25

### Added
- **Advanced pattern matching in `/lens-booboo`**: Finds structurally similar functions across the codebase.

## [1.3.6] - 2026-03-25

### Added
- **Duplicate export detection on write**: Warns when defining a function that already exists elsewhere.

## [1.3.5] - 2026-03-25

### Changed
- **Consistent command prefix**: All commands now start with `lens-`.
  - `/find-todos` → `/lens-todos`
  - `/dead-code` → `/lens-dead-code`
  - `/check-deps` → `/lens-deps`
  - `/format` → `/lens-format`
  - `/design-review` + `/lens-metrics` → `/lens-booboo`

## [1.5.0] - 2026-03-23

### Added
- **Real-time jscpd duplicate detection**: Code duplication is now detected on every write. Duplicates involving the edited file are shown to the agent in real-time.
- **`/lens-review` command**: Combined code review: design smells + complexity metrics in one command.

### Changed
- **Consistent command prefix**: All commands now start with `lens-`.
  - `/find-todos` → `/lens-todos`
  - `/dead-code` → `/lens-dead-code`
  - `/check-deps` → `/lens-deps`
  - `/format` → `/lens-format`
  - `/design-review` + `/lens-metrics` → `/lens-review`

## [1.4.0] - 2026-03-23

### Added
- **Test runner feedback**: Runs corresponding test file on every write (vitest, jest, pytest). Silent if no test file exists. Disable with `--no-tests`.
- **Complexity metrics**: AST-based analysis: Maintainability Index, Cyclomatic/Cognitive Complexity, Halstead Volume, nesting depth, function length.
- **`/lens-metrics` command**: Full project complexity scan.
- **Design smell rules**: New `long-method`, `long-parameter-list`, and `large-class` rules for structural quality checks.
- **`/design-review` command**: Analyze files for design smells. Usage: `/design-review [path]`
- **Go language support**: New Go client for Go projects.
- **Rust language support**: New Rust client for Rust projects.

### Changed
- **Improved ast-grep tool descriptions**: Better pattern guidance to prevent overly broad searches.

## [2.2.1] - 2026-03-29

### Fixed
- **No auto-install**: Runners (biome, pyright) now use direct CLI commands instead of `npx`. If not installed, gracefully skip instead of attempting to download.

## [2.2.0] - 2026-03-29

### Added
- **`/lens-rate` command**: Visual code quality scoring across 6 dimensions (Type Safety, Complexity, Security, Architecture, Dead Code, Tests). Shows grade A-F and colored progress bars.
- **Pyright runner**: Real Python type-checking via pyright. Catches type errors like `result: str = add(1, 2)` that ruff misses. Runs alongside ruff (pyright for types, ruff for linting).
- **Vitest config**: Increased test timeout to 15s for CLI spawn tests. Fixes flaky test failures when npx downloads packages.

### Fixed
- **Test flakiness**: Availability tests (biome, knip, jscpd) no longer timeout when npx is downloading packages.

## [1.3.0] - 2026-03-23

### Changed
- **Biome auto-fix disabled by default**: Biome still provides linting feedback, but no longer auto-fixes on write. Use `/format` to apply fixes or enable with `--autofix-biome`.

### Added
- **ast-grep search/replace tools**: New `ast_grep_search` and `ast_grep_replace` tools for AST-aware code pattern matching. Supports meta-variables and 24 languages.
- **Rule descriptions in diagnostics**: ast-grep violations now include the rule's message and note, making feedback more actionable for the agent.

### Changed
- **Reduced console noise**: Extension no longer prints to console by default. Enable with `--lens-verbose`.

## [1.2.0] - 2026-03-23

### Added
- GitHub repository link in npm package

## [1.1.2] - Previous

- See git history for earlier releases
