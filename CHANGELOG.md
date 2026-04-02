# Changelog

All notable changes to pi-lens will be documented in this file.

## [3.6.0] - 2026-04-02

### Added
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
