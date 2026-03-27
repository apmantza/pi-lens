# Changelog

All notable changes to pi-lens will be documented in this file.

## [2.0.39] - 2026-03-27

### Added
- **Historical metrics tracking**: New `clients/metrics-history.ts` module captures complexity snapshots per commit. Tracks MI, cognitive complexity, and nesting depth across sessions.
- **Trend analysis in `/lens-metrics`**: New "Trend" column shows 📈/📉/➡️ with MI delta. "Trend Summary" section aggregates improving/stable/regressing counts with worst regressions.
- **Passive capture**: Snapshots captured on session start cache + every `/lens-metrics` run. Max 20 snapshots per file (sliding window).

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
