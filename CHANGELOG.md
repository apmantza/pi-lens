# Changelog

All notable changes to pi-lens will be documented in this file.

## [Unreleased]

### Added

- **Cross-file dead-code detection for non-JS/TS languages — Phase 1: Python via vulture (#127)** — Knip gives JS/TS projects project-wide unused exports/files/deps at session-start, but per-file dispatch linters can't catch "this exported symbol is unused anywhere in the project" for other languages. New `DeadCodeClient` interface (`clients/dead-code-client.ts`) parallels Knip's lifecycle (detect → ensureAvailable → analyze, cached at session-start, surfaced as a turn-end advisory), with a Python implementation backed by [`vulture`](https://github.com/jendrikseipp/vulture). Detection gates on a Python marker (`pyproject.toml`/`setup.py`/`requirements.txt`/…) with the same home-dir + VCS-boundary containment as Knip, so a scan launched from a bare cwd can't recurse `$HOME`. **Presence-gated, never auto-installed** — vulture is a pure-Python package with no standalone binary, so auto-installing would mean mutating the user's active Python environment (wrong for uv/poetry/conda/pipx); pi-lens uses it only when already present, probing both the `vulture` script and `python -m vulture` (mirrors `govulncheck`'s no-install gating). Its text output (`path:line: unused <kind> '<name>' (NN% confidence)`) is parsed into the uniform `DeadCodeResult` buckets. The turn-end advisory reads the cached session-start scan (project-wide scans are slow — no per-turn re-scan) and merges across languages for polyglot repos; advisory-only, never a blocker. Telemetry: one NDJSON event per scan to `~/.pi-lens/dead-code.log`. Future phases add Go/Rust/etc. by implementing the interface. Guards: parser unit tests against captured real vulture output + a guarded real-binary integration test.

### Changed

- **Fuller, more correct utilization of knip + madge (tool-utilization audit)** — an audit of our whole-project analyzers (validated by running them on this repo) found gaps and silent-failure modes. (1) **knip** now requests `enumMembers` in `--include` — finer-grained dead code (unused enum members) than file-level exports, advisory-only. *(The audit also caught a bug: knip 6.x has **no `classMembers` issue type** — requesting it makes knip exit 2 with zero output, silently disabling the scan. Verified against knip 6.20.)* (2) **madge** now passes `--ts-config <tsconfig.json>` when one exists, so TypeScript `paths` aliases (`@/foo`) resolve — previously alias-routed imports were silently unresolved and **cycles through an alias were missed**. (3) **madge** `--extensions` gained `mjs,cjs`. (4) **madge** now runs with `--warning` and we parse its stderr for **skipped (unresolvable) files** — previously `--json` mode hid these, so a skipped *local* file could silently drop an internal edge and hide a cycle; local skips are now logged (external package skips are expected and ignored). jscpd was already broad (≈20 languages, unrestricted scan since #126) — no gap there. Guards: knip member-type parse test, `buildMadgeArgs` + `parseMadgeSkips` unit tests.
- **Turn-end injects only this-turn, high-confidence findings — not the full project-wide warning set** — measured on this repo, the whole-project analyzers emit hundreds of findings (knip 390, jscpd 136 clones in `clients/` alone), most pre-existing and noisy. Injecting that wall every turn would drown the genuine blockers and burn context. So the turn-end knip advisory now surfaces only the **delta attributable to the agent's edits** (symbols in files it just touched that became unused) — low-volume and actionable — instead of the whole project. The full picture remains available on demand via `lens_diagnostics`, and the delta still feeds the session-slop record. (madge already operated in this blockers-only mode.)

### Fixed

- **LSP idle reset no longer touches stale pi contexts after session replacement (#338)** — the detached 240s idle timer now captures any footer repaint callback while the `turn_end` event context is still active, skips resets from superseded session generations, and swallows timer-only cleanup errors so `ctx.newSession()` / `ctx.fork()` / `ctx.switchSession()` / `ctx.reload()` cannot crash later when the old `ctx.ui` getter becomes stale.

## [3.8.61] - 2026-06-25

### Added

- **Release notes now come from CHANGELOG.md (single source of truth) + per-language rule catalogs** — the GitHub release body is now the curated `## [VERSION]` CHANGELOG section instead of an auto-generated PR-title list, condensed to a scannable summary (bold titles grouped by Added/Changed/Fixed) by `scripts/changelog-extract.mjs --summary`; `release.yml` posts it via `gh release create --notes-file`. New helpers: `scripts/lib/changelog.mjs` (pure section parser), `changelog-release.mjs` (`npm run changelog:release` promotes `[Unreleased]` → a dated version section at bump time), and `backfill-github-releases.mjs` (retroactively set existing release bodies; all 35 v3.8.x releases were backfilled). Also added two generated docs — `docs/ast-grep_rules_catalog.md` and `docs/tree-sitter_rules_catalog.md` (rules listed per language via `npm run docs:rule-catalogs`, kept in sync by a `--check` test).
- **Trivy security suite — four scan modes (#131)** — integrated [Trivy](https://github.com/aquasecurity/trivy) as the consolidated dependency/secret/IaC scanner that the removed built-in regex scanner and the scattered overlapping paths pointed toward. **Mode 1 — dependency CVEs** (#313): a session-scan client that resolves the project's lockfiles and surfaces known-vulnerable dependencies once per session (not per-edit). **Mode 3 — secret scan** (#314): edit/write-path secret detection with cross-source dedup so a secret already flagged by gitleaks or an ast-grep `*-hardcoded-secret-*` rule isn't reported twice. **Mode 2 — IaC misconfiguration** (#316): a per-edit runner for Terraform/Kubernetes/Dockerfile/etc. misconfigurations. **Mode 4 — dependency license risk** (#318): flags dependencies whose licenses fall outside an allow/deny policy. Trivy auto-installs on demand; each mode is independently gated.
- **typos spell-checker as a cross-cutting auxiliary LSP (#283)** — [`typos-lsp`](https://github.com/tekumara/typos-lsp) (wrapping `crate-ci/typos`) attaches as a `role:"auxiliary"` diagnostic server alongside the file's primary language server, surfacing source-code and Markdown misspellings warm (the Opengrep/ast-grep auxiliary-LSP template). Allow-list based — it only flags *known* misspellings against a compiled-in dictionary, so the false-positive rate on code is low. Default-on when the binary is available (`--no-typos` to disable); a repo-local `typos.toml`/`_typos.toml`/`.typos.toml` opts in to blocking. Validated end-to-end via a tool-smoke fixture.
- **ast-grep project scan via the bundled napi engine (#308)** — the project-wide ast-grep pass now runs in-process through `@ast-grep/napi` (#309) instead of shelling out, and de-dups its findings against the warm `ast-grep` LSP so a rule that fires in both surfaces is reported once (#311).
- **37 SonarCloud Python BLOCKER rules as ast-grep rules (#317)** — ported SonarCloud's Python BLOCKER-severity checks to bundled ast-grep rules, with style-consistency passes and false-positive fixes. The same batch also added a set of Python **security** detectors — Flask/Jinja2 autoescape-off, XXE-vulnerable XML parsers, hardcoded secrets/passwords, AWS S3 public-access / API-Gateway no-auth misconfig, `requests` without timeout / `verify=False`, SQL string concatenation, wildcard server binds — for ~55 new rule files total. **6 more SonarCloud Python BLOCKER rules as tree-sitter queries (#319)** for checks that need structural matching ast-grep patterns can't express.
- **ast-grep flag-argument + Law-of-Demeter rules (#305)** — new detector rules for boolean flag arguments and long message chains (Law of Demeter), with behavioural fixtures (#326). Plus a behavioural-fixture harness covering the rule catalog with 15 accompanying rule fixes (#310).
- **Go concurrency / correctness / GORM ast-grep rules** — a batch of Go idiom detectors: **concurrency** — `loop-var-capture` (loop var captured by a goroutine closure), `mutex-unlock-mismatch` / `unlock-in-loop` (unpaired `Lock`/`Unlock`), `waitgroup-done-scope` (`WaitGroup.Done()` outside the goroutine that called `Add`); **correctness** — `nil-map-assignment` (assignment to a nil map panics), `defer-in-loop` + `go-defer-func-call-antipattern` (defer semantics inside loops / eager arg evaluation); **performance** — `string-concat-in-loop` (prefer `strings.Builder`); **GORM** — `gorm-find-without-where` (unbounded full-table `.Find()`), `gorm-n-plus-one` (DB call inside a loop), plus a `go-test-functions` naming-convention detector. `gorm-unbounded-preload` ships disabled (`rules-disabled/`). Each rule has a positive/negative fixture pair. (Landed alongside a `ruby-detect-path-traversal` security rule in the same batch.)
- **`module_report` cross-file blast-radius (#304)** — `module_report` gained an opt-in `blastRadius` section: transitive dependents of the file, aggregated per-file and ranked, surfaced as read-only `read` args over the cached review graph (cold-omitted). This replaces the standalone `pilens_impact` tool (removed — see below). Plus cold-cache import resolution made language-uniform with member nesting (#301) and C/C++ `#include` support (#302) so the outline is populated even on a cold start.
- **Contributor guide + issue/PR templates** — added `CONTRIBUTING.md` with step-by-step wiring checklists for new dispatch runners, language servers (primary and auxiliary), formatters, ast-grep rules, and tree-sitter rules; added GitHub issue templates for bug reports, feature proposals, and enhancements; added a pull request template. Also added `docs/audit1.md` documenting the centralization gaps and stale docs found during the write-up.
- **License, Code of Conduct, security policy, and all-contributors** — added an MIT `LICENSE` file, `CODE_OF_CONDUCT.md` adapted from the Contributor Covenant 2.1, `SECURITY.md` for private vulnerability reporting, and an `.all-contributorsrc` plus generated contributor table in `README.md` covering code contributors and resolved-issue reporters.
- **Issue/PR automation** — added `stale.yml` workflow to mark and close stale issues/PRs, `greetings.yml` to welcome first-time contributors, `.github/labels.yml` plus a label-sync workflow, and `.github/release.yml` to categorize generated GitHub release notes.
- **GitHub Actions hardening** — pinned workflow actions to full commit SHAs, disabled persisted checkout credentials where push credentials are unnecessary, replaced the release action with `gh release create`, and removed `pull_request_target` from the greetings workflow.
- **README split into a landing page + docs** — trimmed README to install, docs links, contributing/security/license, and contributors; moved detailed sections into `docs/features.md`, `docs/tools.md`, `docs/globalconfig.md`, `docs/env_variables.md`, `docs/language-coverage.md`, `docs/dependencies.md`, and `docs/usage.md`. Fixed the generated contributor table markup so GitHub renders rows instead of showing raw `<tr>` fragments.

### Changed

- **Tool schemas aligned with the pi SDK house style** — compared pi-lens's registered tools against pi's built-ins (`read`/`write`/`edit`/`grep`/`find`/`ls`) and closed two consistency gaps. (1) **`promptSnippet` phrasing**: ours restated the tool name ("Use module_report to…"), which the SDK renders as `- module_report: Use module_report to…` (the name doubled); rewrote the six non-`lens_diagnostics` snippets to bare imperatives matching the built-ins (e.g. "Navigable file outline — a cheap substitute for reading a whole file"). (2) **Input param `filePath` → `path`** (and `filePaths` → `paths`): every pi built-in file tool uses `path`, so `module_report`, `read_symbol`, `lsp_navigation`, and `lsp_diagnostics` now take `path`/`paths` — schema keys, impl, and the user-facing error/hint strings, leaving result-object `filePath` output fields and internal LSP-service args untouched. **Note for hardcoded callers**: agents read the tool schema each session and adapt automatically, but any script/hook that invokes these tools with `filePath:` must switch to `path:`.

- **Session-start guidance now surfaces `module_report` + `read_symbol`, and is leaner** — the session-start orientation advertised `lens_diagnostics`/`lsp_*`/`ast_grep` but never the #245 read-substitute tools, so agents rarely reached for them. Replaced the ~300-token block (which re-documented each tool's args — already in their registered descriptions) with a ~130-token nudge that names the high-value tools, adds `module_report` + `read_symbol`, and keeps only the one non-obvious behaviour (`lens_diagnostics mode=all` resurfaces stale blocking errors dropped from turn context).

### Removed

- **Standalone `pilens_impact` tool — folded into `module_report` (#304)** — the separate transitive-impact MCP tool was removed; the same blast-radius analysis is now an opt-in `blastRadius` section on `module_report` (see Added), so there's one navigable read-substitute surface instead of two. The now-unused `symbolImpact` lens-engine seam was removed as a follow-up (#324).
- **Built-in regex secrets scanner (`clients/secrets-scanner.ts`)** — the hand-rolled, always-on content scanner that regex-matched a handful of secret shapes (Stripe/OpenAI `sk-*`, GitHub tokens, AWS `AKIA*`, Slack `xox*`, private keys, generic api-key/password) on the edit/write path and blocked the pipeline. It's now redundant: the bundled CodeRabbit ast-grep ruleset ships dozens of language-specific `*-hardcoded-secret-*` rules and gitleaks covers repo-level entropy/history scanning, so three overlapping paths produced duplicate, noisy blocks. Removed the scanner, its dedicated pipeline stage + import, and its tests; the `"secrets"` defect class and taxonomy hints remain (now served by the ast-grep rules and gitleaks). Trivy is slated as the consolidated secret/vuln/IaC scanner in a later slice.

### Fixed

- **Full-suite "Worker exited unexpectedly" flake (#283)** — the LSP teardown's Windows tree-kill (`taskkill /F /T /PID`) force-killed a PID's whole process tree, but once a child LSP process had exited its PID can be OS-recycled, so the tree-kill could land on an unrelated process — under `vitest` that was a sibling worker fork (bare worker-exit, no Node crash dump), and in production it was a latent hazard against any recycled PID. Both kill paths (`killWindowsTree` in `launch.ts`, `killProcessTree` in `client.ts`) now early-return when the tracked process has already exited (`exitCode`/`signalCode` set) unless the session itself is tearing down. Also gave the spawn-heavy `lifecycle.test.ts` cases an explicit 20s timeout. (Vitest 4 config note: `execArgv` moved to a direct `test` field — the v3 `poolOptions.forks.execArgv` nesting is silently ignored.)
- **Read-guard no longer false-blocks edits the host would apply** (#257) — the guard gates the host's edit tool but resolved `oldText` → line range with a *weaker* normalizer than the host applies it with, so an edit whose `oldText` carried a smart quote, em-dash, NBSP, BOM, lone `\r`, or any NFKC-equivalent form matched on the host side but not in the guard, surfacing as a spurious `RETRYABLE — edit target not found` for a valid edit. Vendored the host's fuzzy-match normalization ladder (`normalizeForFuzzyMatch` + `normalizeToLF`/`stripBom`, from `@earendil-works/pi-coding-agent` `core/tools/edit-diff`) into a new `clients/host-edit-normalize.ts` and routed all three guard match-space normalizers through it, so the gate and the host now agree by construction. The partial-apply self-write path additionally adopts the host's first-occurrence-wins `detectLineEnding`/`restoreLineEndings` (was "any CRLF present"). A host-pin sync test re-reads the SDK source from devDeps and fails if the host's normalization set drifts. The SDK stays a type-only dependency — the ~50 lines are deliberately vendored, not imported.
- **Edit shapes pinned to the host's `EditToolInput` type** (#257 follow-on) — the read-guard's edit-input parser (`getTouchedLinesForGuard`) and the partial-apply edit element (`PartiallyApplicableEdit`, previously declared twice) now derive their `oldText`/`newText` fields from the SDK's exported `EditToolInput` instead of re-declaring them as bare `string`. A host edit-schema rename is now a compile error at the lint gate rather than a silent fall-through to `unknown_edit_schema`. Type-only (`import type`, fully erased) — no runtime SDK coupling.
- **Cached project diagnostics no longer replay stale findings** (#298) — `lens_diagnostics mode=full refreshRunners=cached` reads a persisted, cross-session snapshot (`project-diagnostics.json`), but `loadProjectDiagnosticsSnapshot` validated only the cache *version* — it never checked whether the underlying files had changed. So a diagnostic recorded for a file the agent later fixed (or deleted) was replayed verbatim on the next `mode=full` call, which is the "the cache needs to be cleaned before running diagnostics because it became stale" symptom in the report (reproduced: a snapshot entry survives an edit that bumps the file's mtime past `scannedAt`, and survives outright deletion). Added `reconcileProjectDiagnosticsSnapshot` — the snapshot analogue of `reconcileStaleWidgetFiles` for the in-memory widget — which drops any diagnostic whose file's `mtimeMs > scannedAt` (+1ms tolerance) or no longer exists, applied at the cached-full-mode consumer so `loadProjectDiagnosticsSnapshot` stays a pure reader. Fail-safe on an unparseable `scannedAt` (keeps everything rather than risk dropping live findings). Guards: 4 reconcile unit tests (edited-after-scan, deleted, unchanged no-op, unparseable-timestamp). Note: the `ignore`/`rules` parts of #298 were already addressed by #279 (mode=full/all cache-ignore filter) and #297 (cascade); this closes the remaining staleness leg.
- **`lsp_diagnostics` directory scans reuse the canonical exclusions and honor project `ignore`** (PR #299, originally by @StartupBros) — the tool's directory walk (`collectFiles` in `tools/lsp-diagnostics.ts`) filtered subdirectories through its own small local `SKIP_DIRS` set (10 build/dep names), so it both diverged from the shared `isExcludedDirName` list (missing agent/runtime + vendored dirs like `.claude`, `.codex`, `.pi`, `.agents`, `.worktrees`, `.pi-lens`, `vendor`, `third_party`) and ignored the project's `.pi-lens.json`/`.gitignore` patterns entirely — the same private-skip-list divergence #243 fixed for the workspace-diagnostics walk. Swapped `SKIP_DIRS` for `isExcludedDirName` (a strict superset, case-insensitive, glob-aware) and additionally threaded a fail-open `getProjectIgnoreMatcher` predicate through the walk so a directory scan now also suppresses user-ignored paths — bringing this surface in line with the workspace walk and `lens_diagnostics` (#243/#297/#298). Explicitly targeting an excluded/ignored path still scans it (exclusion is checked on recursion children, not the root). Guards: the contributor's canonical-exclusion tests on both surfaces, plus a `.pi-lens.json` ignore-honored directory-scan test and `.git`-anchored, global-config-isolated fixtures for determinism.
- **Cascade no longer surfaces diagnostics from ignored files** (#297) — when an edit's blast radius reached a file the project ignores (e.g. a `*.test.ts` glob in `.pi-lens.json`), the cascade neighbour analysis still surfaced that file's LSP errors at turn-end. This produced false positives in exactly the case the reporter hit: editing `reader.ts` to add an export made its `reader.test.ts` importer a cascade neighbour, and the TypeScript server's *partial* view (which hadn't re-indexed the new export the way a full `tsc` does) flagged the import as unresolved — a phantom blocker on a file the user had deliberately excluded. Cascade was the last diagnostic surface that filtered neighbours only by vendor/`node_modules` (`isExternalOrVendorFile`) and not by the project ignore config; both neighbour-collection sites in `computeCascadeForFile` (the primary `sortedNeighbors` walk and the passive `appendFallbackNeighbors` fallback) now also route through the shared `getProjectIgnoreMatcher`, the same matcher the project walk, LSP workspace scan, and `lens_diagnostics` (#279) already use. Fail-open: an ignore-config probe error never drops a neighbour. Guards: 2 cascade-compute regression tests (snapshot + fallback paths). Note: this also closes the remaining ignore-leak called out in #298 — its `mode=full`/`all` cache-leak was already fixed in #279 (which landed after #298 was filed); the cascade path was the one surface #279 didn't cover.

## [3.8.60] - 2026-06-21

### Added

- **ast-grep catalog port + upstream playground cross-validator** — 11 detector-only rules from the [official ast-grep catalog](https://ast-grep.github.io/catalog) were ported into `rules/ast-grep-rules/rules/` (filling real gaps: Go `unmarshal-tag-is-dash` CWE-639, Rust `redundant-unsafe-function` / `avoid-duplicate-export` / `rust-2024-let-chain-candidate`, TS `no-console-except-error` / `missing-component-decorator` / `unnecessary-react-hook` / `find-import-file-without-extension` / `redundant-usestate-type`, plus a Cpp format-string detector that's vendored from CodeRabbit to avoid a duplicate). The 4 rules with a mechanical `fix:` re-export the upstream rewrite (the LSP surfaces it as a codeAction; the napi runner surfaces it as a text `fixSuggestion`); the other 7 are detection-only (manual refactor hints in the `note:`). Validated end-to-end by `tests/clients/dispatch/runners/ast-grep-catalog-rules.test.ts` — each rule gets a positive/negative fixture pair run through the real `ast-grep scan -r` CLI, and the 4 fix-carrying rules additionally get the `ast-grep scan --json=compact` `replacement` field checked end-to-end so a typo in the `fix:` string can't slip through. New `scripts/playground-verify-rule.mjs` cross-validates any rule against the **upstream web playground** (a headless-CDP tool that loads the rule into <https://ast-grep.github.io/playground.html>, scrapes the `Found N match(es)` / `No match found` text, and reports the match count the upstream engine produces — useful as a second opinion against the local CLI test to catch pattern-level drift between the version of `ast-grep` pinned in `package.json` and the version the upstream binary ships; the playground uses a fixed source, so this is a pattern-level smoke test, not a source-level one; see `docs/astplayground.md`). The verifier bundles its own minimal CDP driver + Chrome lifecycle (port 9224, isolated profile at `<tmpdir>/pilens-playground-profile/`, hard-exit after each command to avoid the Windows close-handshake hang) — adapted from [GreedySearch-pi's `bin/cdp.mjs`](https://github.com/apmantza/GreedySearch-pi) and `bin/launch.mjs` with the port/profile changed. Auto-installs Chrome (PATH auto-detect; `PILENS_PLAYGROUND_CHROME` for non-standard installs). First-run ~11s (cold start + page paint), reuse mode ~1.5s. Run `npm run audit:playground -- <rule.yml>` or `node scripts/playground-verify-rule.mjs <rule.yml> --keep-chrome --expected N` for assertions. Test suite auto-skips when Chrome is unavailable.

### Fixed

- **Stale schema/docs said the napi runner didn't support `inside` / `stopBy` / `field` / `constraints`** — the runner has used napi's native engine (#206) since it landed, which supports the full ast-grep rule grammar; the schema and `docs/custom-rules.md` claimed otherwise, which would have scared catalog-port authors off the very features their rules need. Updated the schema descriptions and the docs table to reflect what the engine actually accepts. Same latent bug surfaced in the runner itself: `isOverlyBroadPattern(pattern)` called `.trim()` on the rich-pattern form `{context, selector, ...}` — now guards on `typeof !== "string"` (rich patterns are never single-metavar traps). `isStructuredRule` also recognises the rich form as structure so a rule whose only top-level structure is `{context, selector}` isn't dropped by the runner's safety net. `YamlRuleCondition.pattern` is now typed as `string | YamlRichPattern` (new exported `YamlRichPattern` type). Guards: 2 new unit tests in `tests/clients/dispatch/runners/yaml-rule-parser.test.ts`.

- **Java LSP Lombok support (refs #244)** — JDT LS launches with `JDTLS_JVM_ARGS=-javaagent:<lombok.jar>` when a Java project declares Lombok (`lombok.config`, Maven, or Gradle) and pi-lens can resolve a jar. Resolution order: explicit `PI_LENS_LOMBOK_JAR` / `LOMBOK_JAR`, project-local `lombok.jar` / `.lombok/lombok.jar` / `lib(s)/lombok.jar`, then Maven/Gradle caches. Existing `JDTLS_JVM_ARGS` are preserved, an existing Lombok javaagent is not duplicated, and `PI_LENS_JAVA_LOMBOK=0` disables the integration. Added unit coverage plus a live LSP smoke fixture (`node scripts/smoke-tools.mjs --lsp java-lombok`) that downloads Lombok into the temp workspace and verifies JDT LS no longer reports Lombok-generated getters as unresolved when `jdtls` is available.

- **Project-level `.pi-lens.json` config now honored (`ignore` + `rules`)** — pi-lens already walked up to find a `.pi-lens.json` for LSP server config (`lsp.json` schema), but the `ignore` and `rules` fields on that same file were parsed and discarded. Originally contributed by @greg-hass in #246; this change wires them in: a new `clients/project-lens-config.ts` loader (discovery+parse cached, JSON-parse-fault-tolerant with one-shot warnings, reusing the shared `walkUpDirs` walk-up helper like other project-root probes) is plumbed into two places. (1) **Scanner exclusion** — `getProjectIgnoreMatcher` now takes the loaded `ignore` patterns as `extraPatterns` to the existing `createProjectIgnoreMatcher` extension point, so any matching path is skipped by every diagnostic scan (LSP walk, fact-rules, tree-sitter, jscpd, knip, review graph, source-filter). The cache is invalidated by the actual inherited `.pi-lens.json`/`pi-lens.json` path + mtime as well as `.gitignore` mtime, so editing the file takes effect on the next scan without a session restart. (2) **Rule threshold overrides** — `high-complexity` (cyclomatic complexity) and `high-fan-out` (distinct function calls) had hardcoded `const` thresholds (`15` / `20`); converted to `let` with positive-finite guarded `setHighComplexityThresholds(cc, depth)` / `setHighFanOutThreshold(n)` setters, plus `reset…` helpers for tests. Dispatch contexts now carry the loaded project config, and the two fact rules read thresholds from that per-dispatch context instead of mutating process-global rule state; `applyProjectLensConfig(cwd)` remains as a thin loader integration seam, and `resetDispatchBaselines` can invoke it to warm the cache. The runtime wiring: `runtime-session.ts`'s `handleSessionStart` and the MCP adapter `mcp/session.ts`'s `runSessionStart` both pass `cwd` through, so the config is applied on every session start. The depth sub-threshold of `high-complexity` is intentionally not exposed (keeps the schema tight). Unknown top-level keys and unknown rule ids are ignored for forward-compat; a malformed JSON file is logged once and treated as "no config" so a syntax error in your own file never blocks diagnostics. End-to-end: write `.pi-lens.json` with `ignore: ["fixtures/**"]` and a `fixtures/noise.ts`, then `collectSourceFiles` (and every consumer) skips it; set `rules["high-complexity"].threshold: 5` and a function with `cc=7` that the default `15` would have ignored now triggers a warning. Guards: 5 new test files (loader unit, ignore integration via sync+async `collectSourceFiles`, threshold-setter units, and context-scoped config integration through `createDispatchContext`) plus regression coverage for inherited-config mtime invalidation, gitignore negation, invalid thresholds, config removal, and cross-project bleed; the existing source-filter / file-utils / dispatch-rules suites remain green; full suite 1999/2001 (the 2 pre-existing timing-sensitive failures in `runner-timeout.test.ts` are unrelated to this change). Documented in README under **Project Config** alongside **Global Config**.

### Changed

- **Replaced Semgrep with Opengrep, integrated as an auxiliary diagnostic LSP + introduced the auxiliary-LSP capability (closes #111)** — [Opengrep](https://github.com/opengrep/opengrep) is an open, login-free fork of Semgrep (same rule format, semgrep-compatible CLI) that ships as a **single standalone binary** with **no account, token, or telemetry**, so pi-lens **auto-installs it on demand** via the `github` strategy (Semgrep was never auto-installable). Rather than a per-file CLI runner (~8s/file: the rule set recompiles on every invocation), Opengrep now runs as a **warm LSP server** (`opengrep lsp`) that compiles its rules **once per session** → **~1–2s per file warm** (measured: 1.4–1.7s on edits to a large file).

  This is delivered via a new, reusable **auxiliary-diagnostic-LSP capability**: a `role:"auxiliary"` tag on `LSPServerInfo` marks cross-cutting, diagnostic-only servers that attach *alongside* the file's primary language server (never selected as primary) and are collected on a new `with-auxiliary` `touchFile` scope; the aggregation layer merges/dedups their diagnostics. A profile registry (`clients/dispatch/auxiliary-lsp.ts`) maps each one's LSP `source` → pi-lens `tool` + semantic policy + enablement gate (Opengrep's `source:"Semgrep"` → `tool:"opengrep"`). **Blocking policy:** the LSP diagnostic carries severity + rule id but **not confidence** (the CLI's `metadata.confidence` is stripped), and Opengrep's `auto` Community set is uniformly ERROR/LOW-confidence audit-tier — so a naive "ERROR → blocking" would block ~15 findings on a single normal file. Instead a profile declares `allowBlocking(cwd)`: Opengrep blocks ERROR findings **only when the repo supplies its own curated rules** (`.opengrep.yml`/`.semgrep.yml` — the author's deliberate severity); the `auto` set is **advisory** (warning) regardless. Either way all findings surface in `lens_diagnostics` (via widget-state `recordDiagnostics`). Future cross-cutting scanners (spelling, secrets, …) plug in by registration. Per-server `reopenOnResync` was added because **Opengrep re-scans only on a fresh `didOpen`** (it ignores `didChange`) — auxiliaries with this flag are re-synced via `didClose`+`didOpen` so edits actually trigger a re-scan (without it, warm edits silently returned zero).

  **Default-on** (a registered LSP server) when the binary is available; disable with `--no-opengrep`. Rules: a repo `.opengrep.yml`/`.semgrep.yml` if present, else the login-free `auto` Community ruleset. **Removed** the interim CLI `opengrep` dispatch runner, `withOpengrepGroup`, the `lens-opengrep`/`lens-opengrep-config` flags, and the persisted `.pi-lens/opengrep.json` — superseded by the LSP integration. **Validated end-to-end on the dev box** (cold scan delivers findings; warm edits return correct, content-scaled findings at ~1.4–1.7s) with **no regression across 227 LSP + dispatch tests** on the shared notify/collection hot path. Guards: `auxiliary-lsp.test.ts` (enablement kill-switch + source routing + semantic policy), the auto-deriving `lsp-registry-consistency` guard, and a **generic auxiliary layer in the tool-smoke harness** (`scripts/smoke-tools.mjs --lsp`): a fixture declaring `auxiliaryServerIds` drives the real `with-auxiliary` `touchFile` and asserts the cross-cutting server produced a finding (matched by LSP `source`) — verified end-to-end (opengrep auto-installs, spawns, scans `eval(userInput)`, and its `Semgrep`-sourced diagnostic returns alongside the TypeScript primary). New cross-cutting adopters get harness coverage by adding one fixture entry. *(typos-lsp is the validating second adopter; ast-grep's full-engine LSP a noted strategic migration. FindSecBugs/PMD remain unrelated JVM follow-ups.)*

- **Removed the dormant ESLint language-server definition (37 LSP servers now)** — `ESLintServer` was registered for `.js/.jsx/.svelte/.vue`, but `getClientForFile` is first-match and the TypeScript server claims all of `jsts` ahead of it, so the ESLint LSP only ever activated for `.svelte/.vue` and **never `.js/.jsx`** — the case its own config targeted. ESLint coverage is and remains the config-gated **`eslint` CLI runner**, which works across ESLint v8/v9/**v10**. A latency probe confirmed the warm-LSP path isn't worth reviving today: cold `eslint` v10 is **~400 ms** (not the 1–3 s of the old eslintrc era), and while a warm `vscode-eslint-language-server` validates in **~3–4 ms/edit** on ESLint v9, the current 4.10 server is **incompatible with ESLint v10** — it still calls the removed `FlatESLint` API and silently returns **zero diagnostics**. Removing the dead server (plus its `EslintRoot` helper, the now-orphaned `vscode-langservers-extracted` installer entry, and the `ESLintServer.root` tests) eliminates a misleading, version-fragile half-wiring; the json/css/html members of the same npm package are unaffected (separate tool ids). ESLint-as-auxiliary can be revisited once the language server supports ESLint v10.

### Added

- **ast-grep LSP as a cross-cutting auxiliary diagnostic server (sgconfig-gated) — Phase 1 of #239** — pi-lens now honors a project's OWN `ast-grep` rules: when a repo has an `sgconfig.y[a]ml`, the `ast-grep lsp` server attaches as a `role:"auxiliary"` scanner alongside the file's primary language server (the Opengrep auxiliary-LSP template), surfacing the team's curated structural rules warm, full-engine, with codeAction fixes. Doubly gated so it never over-reaches: (1) the root detector keys on `sgconfig.y[a]ml`, so **no sgconfig ⇒ it never attaches and the existing napi ast-grep runner stays the path** (this is purely additive — the runner is untouched); (2) it only attaches to files whose extension is in ast-grep's supported-language set (`AST_GREP_EXTENSIONS`, ~15 languages). Blocking-eligible by construction (an sgconfig is the team's deliberately-authored ruleset — mirrors Opengrep's curated-config gate); the auxiliary-lsp profile routes `source:"ast-grep"` → `tool:"ast-grep"` with severity→semantic policy. Validated end-to-end via a new `scripts/smoke-tools.mjs --lsp` fixture (sgconfig + a rule + a violating file → install → spawn → compile rules → scan → `ast-grep`-sourced diagnostic alongside the primary). Latency (Gate A, #239): cold ~3.5s (spawn + rule compile), warm **~0.9s/edit and file-size-independent** (a 1 KiB and a 105 KiB file both ~0.9s — the cost is fixed re-sync overhead, not scan), in the same range as the shipped Opengrep auxiliary. *(Phase 2 — consolidating the no-sgconfig baseline onto the LSP via `--config` + shipped rules and retiring the napi runner — remains gated on that warm-latency floor vs napi's in-process ~40ms; tracked in #239.)*

- **LSP server command support — capability/command caching + hardened `workspace/executeCommand`** — pi-lens now captures each server's advertised commands and can run them, closing the "we don't know or use server commands" gap. **Discovery:** at `initialize` we already cached the operation-provider flags but discarded the rest of `ServerCapabilities`; now `detectExecuteCommands` also retains `executeCommandProvider.commands` into a per-client allowlist (`state.advertisedCommands`), and `client/registerCapability` merges any dynamically-registered `registerOptions.commands` (the dynamic path previously kept only `id→method`). Surfaced via `getAdvertisedCommands()` on the client, the `LSPCapabilitySnapshot`, and the `capabilities` nav op (which now lists the advertised commands). **Execution** (`executeCommand` op on `pilens_lsp_navigation` / `lsp_navigation`) is deliberately hardened: (1) **allowlist-by-advertisement** — a command is refused without being sent unless the server itself advertised it (enforced in the client, the authoritative chokepoint, *and* pre-checked in the tool — defense in depth); (2) **dry-run by default** — the op only reports whether a command is advertised; mutation requires explicit `apply:true`; (3) **gated server-initiated edits** — a new `workspace/applyEdit` handler honors server-pushed edits *only* while an opted-in `executeCommand` is in flight (`serverEditsAllowed` counter), so a server cannot push edits to disk unsolicited, and those edits route through the same `applyWorkspaceEdit` path as every other edit. Guards: real-wire integration tests (extended fake LSP server advertises commands, runs one, refuses an unadvertised one, and applies a solicited `workspace/applyEdit` to a temp file end-to-end) + tool-level tests (dry-run default, apply executes, unadvertised refused) + capability-snapshot coverage. *(Origin: the "are we OK on capabilities/commands?" audit — capability negotiation was already solid; command discovery/execution was the real gap.)*

- **`typeDefinition` + `declaration` LSP navigation operations** — `pilens_lsp_navigation` / the `lsp_navigation` tool gained two position operations that round out the LSP "go-to" family: `typeDefinition` (jump to the definition of a symbol's **type** — e.g. the class/interface behind a variable, which `definition` alone never gives you) and `declaration` (jump to a symbol's declaration, distinct from its definition for languages with a decl/def split, e.g. C/C++ externs or ambient TS declarations). Both reuse the existing `navRequest` location pattern (mirroring `implementation`): wired through `client.ts` (method + `LSPOperationSupport.{typeDefinition,declaration}` + static `typeDefinitionProvider`/`declarationProvider` capability detection + dynamic-registration map), `index.ts` service delegation, and the tool's operation list, position handling, empty-result retry, capability table, and per-location `searchReads` registration (so their results feed the read-guard like `definition`/`references` do). Guards: two new `lsp-navigation` tests (typeDefinition resolves + attaches location searchReads; empty declaration reports the no-results reason) plus the existing capability-snapshot tests updated for the two new keys. *(Adopted from the LSP 3.18 feature-gap audit; the heavier `workspace/diagnostic` bulk-pull gap is tracked separately.)*

- **Alternate-primary LSP reachability — static guard + live harness coverage (refs #111)** — the ESLint removal exposed a blind spot: nothing verified that a registered non-auxiliary server is actually *selectable* as primary. `getClientForFile` is first-match by availability, so a server can be permanently shadowed (ESLint), and the live `--lsp` harness only ever exercised the *selected* server — so a shadowed/alternate server was never tested either. Two layers now close this: (1) **`lsp-primary-reachability.test.ts`** (per-PR, deterministic) asserts every non-auxiliary server is either the default first-match winner for ≥1 extension it claims **or** a declared alternate (`deno`↔typescript, `python-jedi`↔pyright, `omnisharp`↔csharp — the registry's actual zero-default-win set), and that each alternate is wired behind its default and becomes the next pick when predecessors drop out; a server that is neither fails with guidance to mark it `role:"auxiliary"` or declare it (the exact ESLint-class catch). (2) A **live alternate layer in the tool-smoke harness** (`scripts/smoke-tools.mjs --lsp`) drives the real selection fallthrough: it writes a `.pi-lens/lsp.json` disabling the default into the temp workspace (the genuine user-facing mechanism) so `getClientForFile` falls through to the alternate, then asserts the alternate spawns + handshakes + diagnoses by fingerprinting the diagnostic `source`. **Validated end-to-end on the dev box** for **deno** (`deno-ts` type error) and **python-jedi** (`compile` syntax error). Alternates are PATH-only (no installer entry — see Fixed), so the layer prechecks the binary and skips cleanly when absent. *(omnisharp left for nightly — heavier toolchain.)*

- **SpotBugs bytecode bug-pattern analyzer for Java + Kotlin (closes #133)** — Java's pipeline was `javac`-only (compile errors, no static analysis); SpotBugs (Apache-2.0) adds 400+ bytecode-level bug patterns (null derefs, resource leaks, thread-safety, performance, bad-practice), and since it analyzes JVM **bytecode**, Kotlin projects get it for free. **Opt-in** behind the `lens-spotbugs` flag (it's heavyweight — JVM cold start + whole-tree analysis), wired via a `withSpotbugsGroup` dispatch group that only activates when the flag is set **and** a Java build descriptor (`pom.xml`/`build.gradle{.kts}`/`settings.gradle{.kts}`) **and** a compiled-classes dir (`target/classes`, `build/classes`, `out/production`, `bin/main`) are present. The runner operates on the compiled tree (not the edited source) and **mtime-caches** — it only re-invokes SpotBugs after a rebuild changes the `.class` files, returning cached findings otherwise. `<BugInstance>` XML (`-xml:withMessages`) is parsed by a bounded, zero-dep, ReDoS-safe reader: priority→severity (1=error/2=warning/3=info), category→defect-class (`CORRECTNESS`/`MT_CORRECTNESS`→correctness, `SECURITY`→safety, `PERFORMANCE`/`BAD_PRACTICE`/`STYLE`/`I18N`/`EXPERIMENTAL`→style), `type`→rule, the primary `<SourceLine>`→location, and the `<LongMessage>` first sentence→`fixSuggestion`; bugs stay advisory (`semantic: warning`). Auto-installs via the archive strategy. **Validated end-to-end on the dev box**: a `NP_ALWAYS_NULL` null-deref in a compiled Maven fixture surfaced as `error`/`correctness` at the right line, through the real dispatch path (coexisting with javac). Guards: `spotbugs-parser.test.ts` (severity×category mapping + primary-line selection + drop-no-source), `spotbugs-runner.test.ts` (scan/cache/rebuild-reinvoke/skip-when-unbuilt), and detection-helper + dispatch-coverage/smoke-coverage exemptions. *(FindSecBugs security plugin + PMD are noted follow-ups.)*

- **Archive-extraction install strategy (refs #133)** — the installer gained an `archive` strategy alongside npm/pip/gem/github/maven, for JVM tools that ship as a **distribution archive** (a `lib/` of many JARs + `bin/` launchers) rather than a single runnable binary or fat JAR. It downloads the `.tgz`/`.zip`, extracts it (top-level dir stripped via `--strip-components=1`) into `~/.pi-lens/tools/<id>/`, and writes a thin launcher shim into the managed bin so the tool resolves like any other via `findGitHubToolPath`. Extraction shells out to `tar` (present on Windows 10+ as bsdtar, which also reads `.zip`); the spawn uses `cwd` + **relative** paths so no argument carries a drive-letter colon — GNU tar (MSYS) otherwise misreads `C:\…` as an rsync `host:path` (avoids the GNU-only `--force-local`, which bsdtar rejects). First consumer registered: **SpotBugs** (`spotbugs-4.10.2.tgz`) — verified end-to-end on the dev box (`ensureTool("spotbugs")` → shim → `spotbugs -version` → `4.10.2`). This is the prerequisite the SpotBugs runner (#133) needs; #133's premise that SpotBugs uses #129's maven fat-JAR path was incorrect — SpotBugs has no runnable standalone JAR on Maven Central, only the distribution archive. Guard: an `archive`-strategy install-contract case in `tool-registry-consistency.test.ts`.

### Fixed

- **Installer security hardening — tighter tool perms + PATH-safe extraction (SonarCloud S2612 + S4036, new code on `master`)** — the installer's executable-perm sites set `0o755` (read/execute for *others*), but managed tools live in user-scoped `~/.pi-lens/` and are only ever run by the installing user. Aligned all six `0o755` binary/launcher/shim modes to **`0o750`** (no "other" access — matching the installer's existing `0o750` chmod sites), clearing the S2612 vulnerability. Also resolved the archive-extraction `tar` spawn to an absolute path on Windows (`%SystemRoot%\System32\tar.exe`, the bundled bsdtar) so it can't be hijacked via a writable `PATH` entry — the same hardening already applied to the `taskkill` spawn; POSIX keeps bare `tar` (a trusted coreutil whose path varies by distro).

- **Windows libuv abort on `pi update` (`Assertion !(handle->flags & UV_HANDLE_CLOSING)`, `src\win\async.c`) (closes #234)** — `pi update` tears the session down (→ `session_shutdown`) to reload the updated extension, and pi-lens's shutdown killed every LSP server by **spawning `taskkill /F /T`** child processes. Spawning a child while the event loop is already closing makes libuv call `uv_async_send` on the closing loop-wakeup handle → hard abort (a native crash, uncatchable in JS). Fixed by adding a `processExiting` shutdown flag (set only on `session_shutdown`): in that state `killProcessTree` kills via the process handle it already holds (`TerminateProcess`, synchronous, no new async handle) instead of spawning. Mid-session teardowns (subagent/turn boundaries, idle shutdown) where the host keeps running still use the `taskkill /T` tree-kill to avoid zombie accumulation. Guard: `kill-process-tree.test.ts` (mocks `child_process`, forces win32 — asserts no spawn when `processExiting`, tree-kill spawn otherwise). *(Also noticed `stopLSP` in `launch.ts` — which carried a second teardown `taskkill` spawn — is dead code with no callers; left untouched.)*

- **Alternate LSP servers `deno` + `python-jedi` now auto-install (refs #111)** — previously both resolved straight off PATH (no installer entry, no `managedToolId`), so unlike `typescript`/`pyright` they never auto-installed and pi-lens couldn't offer them when absent. Added installer entries — **deno** via the `github` strategy (per-platform `.zip` containing the `deno` binary, extracted like rust-analyzer's; added to `GITHUB_TOOLS`) and **jedi-language-server** via `pip` — and rewired `DenoServer`/`PythonJediServer` `spawn` to `resolveAndLaunch({ candidates, managedToolId }, allowInstall)` (the opengrep pattern: try PATH, else install on demand). **Validated end-to-end on the dev box**: with `deno` absent from PATH, `ensureTool("deno")` downloaded it to the managed bin, then the server spawned, handshook, and returned a `deno-ts` diagnostic; jedi resolved + diagnosed (`compile`) via the pip strategy. Guards: github full-matrix + pip install-contract in `tool-registry-consistency.test.ts`; both ids in `managed-tool-ids.test.ts`. *(omnisharp — the C# alternate — still doesn't auto-install: it ships as per-platform archive **trees**, which the single-URL `archive` strategy can't express; needs a per-platform-URL archive extension, tracked separately.)*

- **Jedi LSP returned zero diagnostics on cold start (refs #111)** — surfaced immediately by the new alternate-primary harness layer. `jedi-language-server` is push-only and its first (complete) `publishDiagnostics` lands ~1011 ms after `didOpen` on cold start (Python/parso import), but the `python-jedi` diagnostic strategy capped the aggregate wait at **1000 ms** — so pi-lens stopped listening ~11 ms too early and surfaced nothing, despite the server working (verified via a raw JSON-RPC handshake). Bumped `python-jedi` `aggregateWaitMs` 1000 → **3000** for cold-start headroom (still seeds on the first push; warm path unaffected).

## [3.8.53] - 2026-06-16

### Added

- **ktfmt wired as a config-gated Kotlin formatter + safe autofix (closes #129)** — projects that use [ktfmt](https://github.com/facebook/ktfmt) (Facebook's opinionated, gofmt-style Kotlin formatter) now get real formatting support. ktfmt is a *pure formatter* (no lint rules), so it's wired only where that fits: as a **formatter** (`getFormattersForFile` → `ktfmtFormatter`, in-place) and a **safe pipeline autofix** (`runAutofix` → `tryKtfmtFix`), **not** as a lint runner — a "not formatted" nag would be redundant with the autofix pass (unlike shfmt, which has no autofix). Both are **config-first**: ktfmt activates only when the project opts in (a `.ktfmt`/`.ktfmt.kts` marker or the ktfmt gradle plugin in `build.gradle{.kts}`, via `hasKtfmtConfig`). When opted in, ktfmt **replaces ktlint** for formatting (the lint policy drops ktlint from `preferredRunners` so its style suggestions don't conflict with ktfmt's output); detekt's *semantic* lint is unaffected. Installs via the new maven-JAR strategy. Validated end-to-end on the dev box through the harness `--format` and `--autofix` layers (ktfmt reformats + applies a fix). Guards: `formatters.test.ts` (ktfmt wins over the ktlint default when opted in), `tool-policy.test.ts` (lint suppresses ktlint / autofix selects ktfmt + `hasKtfmtConfig` detection), and the `autofix-policy-consistency` gate-match. *(Follow-up filed: re-evaluate ktlint's default lint runner now that ktlint is itself a safe autofix — the same redundancy question applies to pure-formatter-linters generally.)*

- **Maven-JAR auto-install strategy (refs #129)** — the installer gained a `maven` strategy alongside npm/pip/gem/github: it downloads a runnable fat JAR from Maven Central into the managed bin and writes a `java -jar` launcher next to it, so the tool resolves like any managed binary (gated on a JRE). First consumer registered: **ktfmt** (`com.facebook:ktfmt:0.63:with-dependencies`) — verified end-to-end on the dev box (`ensureTool("ktfmt")` → launcher → `ktfmt --version`). Unblocks JVM-ecosystem tools that ship only as Maven JARs (ktfmt, google-java-format, SpotBugs). Guard: a `maven`-strategy install-contract case in `tool-registry-consistency.test.ts`.

- **Upgrade `vscode-jsonrpc` 8 → 9 (the LSP JSON-RPC transport)** — v9 introduced an `exports` map exposing the Node entry as the `./node` subpath, so the old `vscode-jsonrpc/node.js` file-path import no longer resolves (TS2307). Migrated the one import in `clients/lsp/client.ts` to `vscode-jsonrpc/node`; the API (`createMessageConnection`/`StreamMessageReader`/`StreamMessageWriter`/`MessageConnection`) and the internal `lib/node/ril.js` the error-classifier heuristic checks are unchanged. Verified with a live LSP initialize handshake. Supersedes the lockfile-only dependabot bump, which couldn't carry the required code change (closes #183).

- **Pipeline safe-autofix expanded to golangci-lint, detekt, markdownlint, oxlint (refs #209)** — four more fixable linters now apply their safe `--fix`/`--auto-correct` in the pipeline's autofix phase, each gated to **match its lint-policy strategy**: golangci-lint (Go, config-first — closes the gap where Go had no pipeline autofix), detekt (Kotlin, config-first — an alternative to the Windows-broken ktlint #218), markdownlint (smart-default), and oxlint (JS/TS, config-gated, mirroring the eslint→oxlint→biome lint precedence). Added to `AUTOFIX_CAPABILITIES` + `getAutofixPolicyForFile`. A new guard, `autofix-policy-consistency.test.ts`, locks the three hand-coded policy maps together — every autofix-selectable tool must be capability-declared and reachable, and each language's autofix gate must match its lint gate (catching config-first↔smart-default drift; it already caught an oxlint mismatch).

- **Tool-smoke harness gained an `--autofix` layer covering the pipeline's safe-autofix phase (refs #209)** — the safe-autofix phase (`runAutofix`, what `runPipeline` invokes) applies fixable linters in fix mode gated by the autofix policy. It **mutates files**, yet was exercised by neither the lint layer (lint-only) nor `--format` (formatters) — the highest-stakes path with no live coverage. `node scripts/smoke-tools.mjs --autofix` drives that exact phase per fixture (a safely-autofixable violation) and asserts the expected tool was policy-selected and applied a fix (`fixedCount > 0`, file changed). Validated end-to-end on the dev box for 11 tools: ruff (F401), biome (useConst), rubocop (spacing), sqlfluff (LT01), rust-clippy (needless_return), dart-analyze (prefer_const_declarations), stylelint (color-hex-length), eslint (semi), golangci-lint (gofmt), markdownlint (MD009), oxlint (no-var). ktlint is blocked by the Windows install bug (#218); detekt is wired + consistency-tested but live-validation needs the detekt CLI + formatting plugin (CI-deferred). `runAutofix` is now exported; the harness git-inits each autofix workspace so VCS-gated fixers (cargo fix) run as they would in a real repo.

- **Tool-smoke harness gained a `--format` layer covering the formatter pipeline (refs #209)** — formatters are a wholly separate subsystem (`getFormattersForFile` → `formatFile`, what `runFormatPhase` drives) that the lint-dispatch path the harness exercised never touched, so the formatters had zero live coverage despite mutating files in place (a silently-broken formatter is higher-stakes than a missed lint). `node scripts/smoke-tools.mjs --format` drives that exact entry per fixture: it asserts the expected formatter is **selected** for the file (config-gated formatters ship the config their `detect()` needs — `.prettierrc` / `gleam.toml` / `Gemfile` / `pyproject.toml [tool.black]` / `.cmake-format.yaml`) and that running it actually **reformats** a deliberately mis-formatted-but-valid fixture (`changed === true`). Now covers **28 of the 31 supported formatters** across 32 fixtures, all validated end-to-end on the dev box: biome, prettier, ruff, black, taplo, shfmt, gofmt, rustfmt, dart, zig, mix, gleam, rubocop, standardrb, sqlfluff, csharpier, terraform, fantomas, psscriptanalyzer-format, cmake-format, oxfmt, stylua, ormolu, cljfmt, php-cs-fixer, google-java-format, clang-format (+ ktlint, which the layer caught broken on Windows → #218). Config-gated formatters ship the config their `detect()` requires (stylua.toml / .cljfmt.edn / .php-cs-fixer.php / .editorconfig / Gemfile / pyproject.toml). The remaining 3 — nixfmt, ocamlformat, swiftformat — have no usable Windows toolchain (Nix/opam/Swift) and are left for nightly-CI. Wired into the nightly workflow alongside the tool and `--lsp` layers. (Note: the nightly run exercises whichever formatter tools it can install on the runner; standalone-binary formatters not auto-installed by pi-lens report ⚠ until a setup step is added.)

- **Tool-smoke harness now covers eight more toolchain-gated languages (refs #209)** — added live fixtures + harness entries for `zig` (zig-check), `java` (javac), `dart` (dart-analyze), `php` (php-lint), `ruby` (rubocop), `kotlin` (ktlint), `gleam` (gleam-check), and `elixir` (elixir-check), all **validated end-to-end on the Windows dev box** after installing the toolchains (JDK 21, Dart, Ruby 3.4 + MSYS2 devkit, Gleam, Zig, PHP 8.4, Erlang/OTP 29 + Elixir 1.20.1). Each produced a parseable diagnostic on its fixture's known defect. The gleam fixture is a minimal package (`gleam.toml` + `src/`) since `gleam check` compiles the whole project. This batch surfaced two genuinely-broken runners (see Fixed: #215, #216) — exactly the regression class the harness exists to catch.

- **Tool-smoke harness language expansion + LSP-install gap fix (refs #209)** — the dispatch tool-smoke fixtures now also install each kind's LSP server (not just the linter), so the lsp runner no longer spuriously `server_error`s for want of an uninstalled server. Added fixtures: `terraform` (tflint tool + terraform-ls LSP, both standalone); toolchain-gated `go` (go-vet), `powershell` (PSScriptAnalyzer), `rust` (rust-clippy tool + rust-analyzer LSP), and `csharp` (dotnet-build) — all four verified end-to-end on this box (Go/Rust/.NET/PowerShell toolchains present; rust-clippy → clippy::len_zero, dotnet-build → CS0029); plus LSP-handshake fixtures for `prisma` (@prisma/language-server — 2 diagnostics) and `php` (intelephense). Confirms the fallback→all fix end-to-end: terraform runs `lsp + tflint` together. The go fixture surfaced #214 (go-vet returns 0 diagnostics in dispatch though `go vet` reports them manually). Harness `--verbose` now prints each failed runner's `failureKind`/message so found-errors aren't misread as crashes.

- **LSP handshake layer in the tool-smoke harness (refs #209)** — `scripts/smoke-tools.mjs --lsp` drives the **same production entry the lsp runner uses** (`LSPService.touchFile`, with a generous cold-spawn budget) for each LSP fixture, so a pass means the real server installed, spawned, completed the JSON-RPC initialize handshake, and replied — not a hand-rolled handshake (the trap that false-failed typescript in the dropped smoke-lsp). Verified end-to-end for typescript-language-server, pyright, yaml-language-server, vscode-json-language-server, and bash-language-server (all handshook; yaml/json returned diagnostics). Shares the harness's startup temp-sweep and tears down spawned servers via `LSPService.shutdown()`.

### Fixed

- **CI: `tool-discovery.test.ts` is now hermetic — no real GitHub-API fetch** — the `ensureTool force-reinstall` tests asserted on a post-download spawn, which required `installTool`'s real `node:https` GitHub-release fetch; in restricted CI (notably **dependabot PRs**) that fetch fails → 0 spawns → flaky red. `node:https` is now mocked (records the fetch, fails deterministically) and the test asserts the fetch was *attempted* (proves installTool was reached) rather than a network-dependent spawn.

- **LSP launch no longer logs scary "candidate failed / npm shim failed / Run npm install" lines when a later candidate succeeds** — `resolveAndLaunch` tries candidates in order (local `node_modules/.bin` → global PATH → managed install); each failure was logged immediately, so the common "no local install, fall back to global" path flooded the logs with failure lines that read as an LSP-availability smell even though the server launched fine. Failures are now **deferred** and surfaced only when *all* candidates fail (the all-failed case stays fully diagnosable). Guard: `resolve-and-launch-fallback.test.ts`.

- **ktlint now works on Windows — installer fetches the jar alongside ktlint.bat (closes #218)** — ktlint's Windows asset is `ktlint.bat`, a wrapper that runs `java -jar %~dp0ktlint`; the installer fetched only the `.bat`, so every invocation failed `Unable to access jarfile` (and the lint runner masked it — the error text became a fallback diagnostic that looked like a finding). The github install strategy gained an optional `extraAssets` hook; ktlint declares `["ktlint"]` (the jar) on win32, so both files now land in the managed bin. Verified end-to-end on Windows: ktlint lint emits real diagnostics and ktlint format (`-F`) reformats. Guards in `tool-registry-consistency.test.ts`: any win32 `.bat`/`.cmd` wrapper asset must declare `extraAssets`, plus a ktlint-specific check.

- **shfmt no longer nags on every unformatted shell write (closes #211)** — the shfmt runner reported a "not formatted" warning against shfmt's built-in defaults on every `.sh` write, even when the project never opted into shfmt formatting. The format-diff *warning* is now gated on a `.editorconfig` (shfmt's only config source) — out of the box shfmt reports only genuine **parse errors** (always-on, blocking); the formatting warning appears once a project opts in via `.editorconfig`. Guard: `shfmt.test.ts`.

- **shellcheck now surfaces `info`-level findings like SC2086 (closes #213)** — with no `.shellcheckrc`, the runner forced `--severity warning`, which dropped `info` findings entirely — including SC2086 (double-quote-to-prevent-globbing), a high-value, commonly-relevant check. Default is now `--severity info` (surfaces SC2086-class findings, mapped non-blocking) while still excluding pure `style` rules to limit noise; projects opt into `style` via `.shellcheckrc`. Guard updated in `shellcheck.test.ts`.

- **markdownlint produced 0 diagnostics — parser didn't match modern markdownlint-cli2 output (closes #212)** — `parseMarkdownlintOutput`'s regex expected the rule code immediately after `line[:col]`, but markdownlint-cli2 now emits a **severity token** (`error`/`warning`) in between (`file:1:1 error MD018/… msg`), and some rules carry **multiple** slash-separated names (`MD041/first-line-heading/first-line-h1`). Both made the regex miss every line → silent "succeeded, 0 diagnostics". The severity token is now optional (older/relative output still parses) and multi-segment rule codes are handled. (The issue's original "Windows abs-path glob" diagnosis was wrong — the file lints fine; the parser was the culprit, on every platform with current cli2.) Guard: a markdownlint-cli2-format case in `markdownlint-fixable.test.ts`.

- **ESLint autofix never applied fixes — keyed on `fixableErrorCount` from `--fix-dry-run` (closes #220)** — the pipeline's safe-autofix phase (`tryEslintFix`) ran `eslint --fix-dry-run --format json` and decided whether to apply fixes by summing `fixableErrorCount` + `fixableWarningCount`. But `--fix-dry-run` reports the **post-fix** state: when every problem is auto-fixable (the common case), ESLint clears `messages`, sets `fixableErrorCount: 0`, and puts the fixed source in the **`output`** field — so the count was 0 and eslint fixes were **never applied**. Now also treats a dry-run `output` field as a fix signal (apply `--fix` when `fixableCount > 0` *or* any result carries `output`). Guard: `pipeline-eslint-autofix.test.ts`. Found by the #209 `--autofix` layer (eslint v10.5.0).

- **`zig-check` never ran: availability probe used `zig --version`, which zig rejects (closes #215)** — the shared `createAvailabilityChecker` hard-coded a `--version` probe, but zig's version subcommand is `zig version` (`zig --version` → `error: unknown command: --version`, exit 1). So the probe always failed and zig-check silently skipped on **every** machine with zig installed. `createAvailabilityChecker` now takes an optional `versionArgs` (default `["--version"]`); zig-check passes `["version"]`. Guard: `runner-helpers.test.ts` asserts the override reaches the spawn. Found by the #209 harness (zig 0.16.0 reported `skipped` despite being on PATH).

- **`elixir-check` silently dropped all diagnostics on modern Elixir (closes #216)** — `parseElixirOutput` only understood the legacy diagnostic format, so on Elixir 1.16+ the runner was a no-op. Two bugs: (1) Elixir 1.16+ emits a multi-line "code snippet" format with the location on a trailing `└─ path:line:col` line, several lines after the `error:`/`warning:` header — the parser now forward-scans to that footer while keeping legacy support; (2) `elixirc` reports paths **relative to its cwd**, but the parser resolved them against `process.cwd()` instead of the runner cwd (and compared case-sensitively, breaking on Windows' lowercased drive letter) — `parseElixirOutput` now takes `cwd`, resolves against it, and matches case-insensitively on win32. Guard: `elixir-parser.test.ts` (modern error/warning, cwd-relative paths, legacy format, win32 drive-case). Found by the #209 harness (Elixir 1.20.1/OTP 29 ran clean but produced 0 diagnostics on a known compile error).

- **Windows: tools whose path contains a space now run (closes #214)** — `safeSpawnAsync`'s Windows `shell:true` path built the cmd.exe string by escaping only the **args**, not the command, so a tool resolved under a spaced path — e.g. Go at `C:\Program Files\Go\bin\go.exe` — made cmd.exe parse `C:\Program` as the command and fail with `'C:\Program' is not recognized`. This silently broke **any** such tool on Windows (npm/.pi-lens tool paths have no spaces, so it stayed hidden; the #209 harness exposed it via go-vet returning 0 diagnostics). The command is now escaped like the args (`buildWindowsShellCommand`, extracted + unit-tested); `cmdEscapeArg` is a no-op for space-free commands so the previously-working paths are unchanged. Found by the #209 tool-smoke harness; go-vet now reports diagnostics through dispatch.

- **`smart-default` linters no longer suppressed by the LSP in fallback dispatch groups (refs #209)** — the primary dispatch group for css/yaml/html/docker/toml/ruby/kotlin paired the `lsp` runner with the language's dedicated linter under `mode:"fallback"`, where the first success wins. Once the language server installed and handshook (now reliable), the LSP succeeded and the linter was **silently suppressed** — dropping rules the generic LSP never emits (yamllint style, stylelint, hadolint best-practices, htmlhint, ktlint, rubocop, taplo). Those linters are classified `smart-default` in tool-policy (designed to run with built-in defaults), and `shell`/`fish`/`powershell`/`prisma` already pair LSP+linter via `mode:"all"` — so this was an inconsistency, not intent. All seven groups are now `mode:"all"`; LSP↔linter duplicate diagnostics remain handled by `suppressLintOverlapsWithLsp` + dedup. A new guard (`tests/clients/dispatch/lsp-linter-coverage.test.ts`) fails if any `smart-default` linter ever sits behind the `lsp` in a fallback group again. Type-checker/compiler fallbacks (jsts lsp+ts-lsp, python lsp+pyright, csharp lsp+dotnet-build, …) are intentionally left as fallback. Tool-smoke harness gained css/html/toml/sql/dockerfile fixtures (+ css/html/docker/toml LSP fixtures) confirming each linter now executes alongside its LSP.

- **Wire `markdownlint` and `shfmt` into their dispatch plans — they were registered but never ran (refs #209)** — a new deterministic per-PR guard (`tests/clients/dispatch/dispatch-coverage.test.ts`) cross-checks every registered runner against the static plans (`TOOL_PLANS` ∪ `FULL_LINT_PLANS`) and fails if any runner is wired into no plan (the "markdownlint class": registered + installs + tested, but silently never dispatched) or if a plan references a phantom runner id. It immediately caught `markdownlint` (markdown's write group was only `["spellcheck","vale"]`, though its linter policy already preferred it) and `shfmt` (shell's group omitted it). Both are now in their plans, so `.md` writes get markdownlint structural lint and `.sh` writes get shfmt format-diff + parse-error checks (shfmt is check-only — never auto-applies). The live tool-smoke harness gained a `shell` fixture and confirms all three (markdownlint/shellcheck/shfmt) now execute through the real dispatch path.

## [3.8.52] - 2026-06-14

### Fixed

- **read-guard: canonicalize path map keys — stops false `zero_read` blocks (closes #210)** — `ReadGuard` keyed its `reads`/`edits`/`exemptions` maps on the **raw** file-path string, relying on the read-path and edit-path strings being byte-for-byte identical. `resolveToolCallFilePath` returns absolute paths verbatim, so the key was whatever separator/casing the model emitted — and models freely mix `/` and `\` on Windows. The regression trigger: read-guard started recording reads from new sources that produce a *different* path form than the Edit tool — `ast_grep_search` matches (#169, slash-normalized from ast-grep output) and LSP-expanded synthetic reads (URI → forward slash). On Windows a file read via search/LSP got a `C:/…` key while the follow-up edit arrived `C:\…` → key miss → false `zero_read` ("Edit without read") despite the file having been read, repeatedly, in a real session (`pi-free`: reads logged `C:/…`, the blocking edit `C:\…`). Every map access now keys through `normalizeFilePath` (folds separators + Windows casing), so record and lookup always agree. **Why it slipped:** every read-guard test used the *same* POSIX path on both `recordRead` and `checkEdit`, so the raw keys always matched — no test exercised cross-separator/cross-source agreement. Closed by `tests/clients/read-guard-path-normalization.test.ts` (forward↔back-slash both directions, Windows case-folding, exemption parity, and a negative: a genuinely-unread file still blocks).

### Added

- **Live tool-smoke harness driving the real dispatch path (refs #209, layer 2)** — `scripts/smoke-tools.mjs` installs (via the real `ensureTool` auto-install) and runs each supported tool against a minimal real project per language (`tests/fixtures/tool-smoke/<lang>/`), driving pi-lens's **real** dispatch path so a smoke pass means the actual runner→spawn code worked (not a hand-rolled stand-in). Step 1 (default) asserts each target tool spawns and exits cleanly (no `timeout`/`exception`/`server_error`); Step 2 (`--step2`) additionally asserts a parseable diagnostic on the fixture's known defect. Per-runner truth comes from a new optional `onRunnerResult` sink threaded through `dispatchForFile`→`runGroup` (fires per executed runner with its exact `RunnerResult` incl. `failureKind`) exposed via `dispatchLintDetailed` — no duplication of dispatch's selection/gating. Opt-in/nightly (installs + spawns real tools), never a per-PR gate; not shipped in the npm tarball. Already surfaced a real wiring gap: `markdownlint` is registered (priority 30) and installs, but the markdown write-dispatch group is `["spellcheck","vale"]`, so it never runs on markdown writes.

- **Deterministic auto-install registry-consistency guard (refs #209, layer 1)** — the live install→run net for every supported tool is expensive and environment-dependent (deferred to layer 2); this catches the cheap-to-catch class per-PR. A new `tests/clients/installer/tool-registry-consistency.test.ts` exports the previously-private `TOOLS` array and locks the **install contract** that `installTool` silently depends on: each `npm` entry declares `packageName`+`binaryName`, each `pip`/`gem` entry declares `packageName`, each `github` entry declares an `owner/repo` + `assetMatch` + `binaryName` and no `packageName` — a half-wired entry compiles fine today but just `return false`s at install time, so it "looks registered" while never installing. It also asserts ids are globally unique, `checkCommand`/`binaryName` are clean executable tokens, and every `github` tool's `assetMatch` is total/safe (never throws across the platform×arch matrix incl. unsupported platforms, resolves at least one combo, rejects freebsd/sunos/aix). **Fixed a coverage drift it surfaced:** `GITHUB_TOOLS` (the curated list the asset-matrix value-test iterates) had drifted to 9 of the 14 actual `github`-strategy tools, leaving `hadolint`, `gitleaks`, `taplo`, and `vale` asset selection **completely untested** — they're now in `GITHUB_TOOLS` (so the full matrix test covers them), and a bidirectional sync assertion keeps the list ≡ "github tools with full cross-platform coverage" going forward (`swiftlint` is intentionally excluded — no Windows asset).

## [3.8.51] - 2026-06-14

### Added

- **Interrupting the agent (Esc) now cancels in-flight linter/formatter/type-check child processes (refs #197)** — pi-lens runs its dispatch tools via `safeSpawnAsync`, which already supported an `AbortSignal`, but nothing was feeding pi's per-turn `ctx.signal` into it, so an interrupted turn left its linters running until they hit their own timeout (up to 10–15s of wasted work, and on Windows orphaned process trees). The lifecycle handlers (`tool_result`, `agent_end`, `turn_end`) now publish the turn's `ctx.signal` as an ambient default that every `safeSpawnAsync` falls back to (`setAmbientAbortSignal`, cleared in each handler's `finally`), so Esc/abort tears down the in-flight children — process-tree kill on Windows. Threading the signal through every dispatch→runner→spawn call site would have been invasive; the ambient default captures the signal at spawn time, so clearing it after a handler returns only affects future spawns, never work already in flight. An explicit `options.signal` still takes precedence. Guarded by `tests/clients/safe-spawn-ambient-signal.test.ts`.

- **Resumed sessions rehydrate their diagnostics instead of starting empty (#190 Phase 1)** — quitting and resuming a session (`pi --session <id>`) made `lens_diagnostics` return nothing: pi-lens kept widget/diagnostic state in-memory only and reset on every `session_start`, treating resume as new. Root cause: it took the session id from the `session_start` event (which has none) and fell back to a fresh **per-process random id**, so nothing could be keyed across a resume. Now pi-lens reads pi's **stable** session id via `ctx.sessionManager.getSessionId()` and the `session_start.reason` (`new`/`resume`/`fork`/`reload`/`startup`): it persists the per-file widget diagnostics to disk at each `turn_end` (under `getProjectDataDir(cwd)/sessions/<id>.json`, atomic write, best-effort) and **rehydrates** that session's snapshot when one exists so `lens_diagnostics mode=all` and the widget show the prior findings; `reload` keeps in-memory state; an explicit `new` session starts clean. The rehydrate trigger is *"a persisted snapshot exists for this stable id"*, **not** `reason === "resume"` — a `pi --session <id>` launch fires `reason: "startup"` (only an in-process `switchSession` is `"resume"`), so gating on `"resume"` alone missed the common resume path; the reason→action mapping is now a unit-tested pure function (`sessionStartMode`). A brand-new session at startup has a fresh id with no snapshot → clean. Process-bound `lspServers` are deliberately not persisted (they re-spawn fresh).

  **Phase 2** adds: (a) **fork branching** — `session_before_fork` stashes the source session's diagnostics in-memory and the forked session's `session_start` (reason="fork") adopts them, then persists under the new session id, so a `/fork` starts from the fork point's findings instead of empty (in-memory hand-off avoids deriving the source id from a file path, since pi stores the id in the session-file header, not the filename); (b) **freshness reconciliation (#180)** — on resume, files whose on-disk mtime is newer than the snapshot (edited between sessions) or that no longer exist are dropped before rehydration, so a resume never surfaces stale diagnostics; dropped files re-scan on their next edit. Still deferred on #190: `delta`-mode rehydration (gated by the `projectSeq`-reset freshness check, intertwined with #180's seq semantics) and tree-navigation (`/tree` doesn't change files on disk). Guarded by `tests/clients/session-state-store.test.ts` (export/import, save/load, end-to-end resume, fork hand-off, `dropStaleFiles`) and `tests/clients/runtime-session-lifecycle.test.ts` (stable-id pinning). Investigation closed the other two transitions as no-ops: `delta` mode is current-turn-scoped and its caches already persist per-project (no rehydration belongs there), and `/tree` navigation doesn't change files on disk. As discoverability for the turn-scoped default, `lens_diagnostics mode=delta` now appends a one-line hint when it's empty but the session-wide view has carried-over findings (e.g. just after a resume): "N findings across M files carried over — use mode=all".

- **`/lens-health` surfaces event-loop occupancy (#192)** — pi-lens now monitors event-loop delay in production (Node's native `monitorEventLoopDelay`, enabled at extension load, no per-event overhead) and `/lens-health` reports the worst synchronous block, p99, and mean for the session — flagging a >100ms block that can stutter the TUI. This is the dimension our duration-only logs were blind to (the one that let the ~1.5s scan freeze through, #188/#191). `latency.log` also records a `loop_block` entry for each new worst freeze, attributed to its turn, so blocks are queryable across sessions. Paired with the at-scale occupancy **test** harness (`tests/support/perf-harness.ts` — `measureMaxSyncBlockMs` + `generateSourceTree`) and CI budget guards. A dedicated `/lens-perf` view remains (#192).

- **Extension-wiring test harness + mock consolidation (closes #171)** — a single dependency-free mock of the host `ExtensionAPI` (`tests/support/pi-mock.ts`) that records everything `index.ts` registers (flags/commands/tools/lifecycle hooks) and lets a test drive a hook (`emit`) or command (`runCommand`) through the *real* entry, with `makeCtx()` capturing `ui.notify`/`setStatus`/`setWidget`. New `index-wiring` tests assert the full registration contract and that `context` injection is gated by `--no-lens-context` and flipped by `/lens-context-toggle` — glue that was previously untested and that the dist-packaging breakage showed we need. Consolidated the three parallel pi mocks onto this one: migrated `lens-toggle-command.test.ts` (template) and `index-integration.test.ts`, removed the duplicate `tests/support/mock-pi.ts`, and deleted `extension-hooks.test.ts` (its assertions never invoked the real entry — they registered on the mock and asserted the mock, so they were tautological and used stale flag names; the real registration contract is now covered by `index-wiring`). Dispatch-runner `RunnerContext` tests are a separate harness concern, out of scope here.

- **Startup-time logging (makes the #182 win measurable)** — pi-lens now records how long pi took to load it: `performance.now()` captured as the first statement in the extension entry (after all imports = full jiti transpile paid) gives ms from pi's process start to pi-lens load-complete. Emitted once per load as a human line in `sessionstart.log` (`pi-lens loaded: <ms>ms after process start (from dist|source)`) and a structured `latency.log` entry (`phase: "extension_loaded"`, `metadata.loadedFrom`). The `loadedFrom` tag distinguishes the precompiled `dist/` path from `source`/jiti, so the transpile-on-startup cost is now quantified rather than guessed (`clients/startup-timing.ts`).

- **Runner failures carry a `failureKind`, and the log-smell analyzer tells breakage from found-errors (refs #207)** — the dispatch latency log recorded `status:"failed"` both when a runner genuinely broke *and* when it simply found blocking diagnostics (the LSP runner reports `failed` for a file with type errors), so `scripts/analyze-pi-lens-logs.mjs` counted all of them as crashes — a false "98 runner failures" alarm over 24h where the real infra-failure count was **zero**. `RunnerResult` now carries `failureKind`/`failureMessage`: the LSP runner tags `server_error` (spawn/exit/JSON-RPC) vs `blocking_diagnostics` (found type errors — not a fault), and the central `runRunner` catch tags `timeout` vs `exception` (covering every runner's crash path); the dispatcher logs `metadata.failureKind` on the runner line. The analyzer reclassifies accordingly — only genuine breakage (`timeout`/`exception`/`server_error`) counts as the `runner-failures` smell, found-errors go to a separate per-runner tally, and legacy logs without the field fall back to a "failed + has diagnostics = found-errors" heuristic. It also now reads two live logs it was previously blind to — `actionable-warnings*.log` (advisory inject/suppress pipeline) and `ast-grep-tools*.log` (MCP search/replace telemetry) — with new `ast-grep-tool-errors` / `actionable-warning-errors` smells and per-source report sections. Guarded by `tests/scripts/analyze-pi-lens-logs.test.ts` (fixture-driven subprocess run: source discovery, the infra-vs-found-errors split, advisory aggregation, the ast-grep error smell).

- **ast-grep `search`/`replace` surface a remediation hint to the agent on error (refs #207)** — the tools already classified each failure (`classifyAstGrepError`) for telemetry, but only the two highest-frequency categories (`multiple_ast_nodes`, `cannot_parse_query`, curated by `sg-runner.ts`) reached the agent with guidance; the other four (`timeout`, `tool_not_found`, `json_parse_failed`, `other`) came back as raw stderr, and the rich `getPatternHint()` self-correction only fired on the *zero-matches* path, never on a hard error. `astGrepRemediationHint(kind)` now reuses that same classification to append a one-line fix on the error path (returns `null` for the already-curated categories so it never doubles up) — e.g. an empty `--rewrite` (previously raw clap CLI noise) now gets "verify the pattern is a single valid AST node … or fall back to grep". Guarded by `ast-grep-tool-logger.test.ts` (hint map incl. the real empty-`--rewrite` log case + a wrapped multiple-nodes error → no extra hint) and error-path tests in both tool suites (hint appended for raw errors, *not* for curated ones).

### Fixed

- **Read-guard autopatch recovers Unicode-punctuation drift (Tier C)** — the autopatch ladder (`tryCorrectIndentationMismatchFromContent`) gained a tier that tolerates the punctuation models routinely swap: smart quotes ↔ straight (`“”‘’` ↔ `"'`), em/en-dash ↔ hyphen, and non-breaking / typographic spaces ↔ a regular space (common when `oldText` is pasted from rendered Markdown or the model "tidies" punctuation). Previously such an edit failed the exact + whitespace tiers and was blocked; now the tier matches on a Unicode-folded, whitespace-collapsed signature and — like Tiers A/B — **recovers and returns the verbatim file span** (the file's real characters), so the applied edit stays exact. Same safety contract: the folded signature must match exactly once, anchored on ≥2 non-blank lines. Borrowed from the fuzzy matcher in mitsuhiko/agent-stuff's multi-edit, but kept to pi-lens's verify-don't-guess discipline (no blind "closest match" fallthrough). Guarded by `read-guard-tool-lines.test.ts` (smart-quote / em-dash / NBSP recovery + single-line, ambiguous, and absent-content negatives).

- **Skills now load from the compiled `dist/` build (closes #205, reported by @feoh)** — the `resources_discover` handler resolved the skills directory relative to the module's own location (`path.dirname(import.meta.url) + "/skills"`). Under the `dist/` layout (#182) the module is `dist/index.js`, so that landed on the nonexistent `dist/skills/` and pi logged `skill path does not exist` while silently loading none of pi-lens's skills (ast-grep, lsp-navigation, write-ast-grep-rule, write-tree-sitter-rule). Now it uses `resolvePackagePath(import.meta.url, "skills")`, which walks up to the nearest `package.json` and lands on `<pkg>/skills/` in both the source and dist layouts. (The issue's suggested `path.join(extensionDir, "..", "skills")` would have fixed dist but broken source, where the module already sits at the package root.) Guarded by an `index-wiring` test that invokes the handler and asserts the path exists, ends in `skills`, and is not `dist/skills`.

- **SonarCloud security/reliability fixes (new-code period)** — (1) **`S5850` reliability bug** in `clients/word-index.ts`: the `TEST_VENDOR_RE` regex mixed anchors with a top-level `|`, leaving operator precedence ambiguous; wrapped the two alternatives in explicit non-capturing groups (behaviour verified identical, capture groups unchanged). (2) **`S4790` weak-hash** ×2: `clients/mcp/ipc.ts` (IPC socket/pipe name) and `clients/review-graph/builder.ts` (content fingerprint for change detection) used `sha1` for non-security hashing — switched to `sha256` (functionally equivalent here, silences the flag). (3) **`S7637`**: pinned the third-party `softprops/action-gh-release` GitHub Action to a full commit SHA (`b430933…` # v3) in `release.yml`. The remaining 48 `S5852` (ReDoS) and 4 `S4036` (PATH lookup) hotspots were reviewed and are safe by context — every flagged regex is single-quantifier or polynomial-at-worst over bounded, trusted input (source lines / tool output), with zero nested-quantifier (`(x+)+`) patterns in the codebase; PATH-based tool resolution is core to how pi-lens finds the user's installed linters/LSPs. These are review hotspots to mark *Safe* in SonarCloud, not code defects.

- **`audit:rule-catalog` no longer fails on duplicate rule_ids** — three catalog entries violated the registry's globally-unique-`rule_id` invariant (which the `-java`/`-js`/`-cobol` suffix convention exists to maintain). `infinite-loop` had genuine java *and* typescript rule files sharing one id, so the java variant was renamed to `infinite-loop-java` (id + file, matching the `unnecessary-bit-ops-java` precedent); `no-octal-values` and `short-circuit-logic` had phantom `typescript` catalog entries with no backing rule file (TS octal coverage already exists via the ast-grep `no-octal-literal` rule), so those were removed. The audit now reports 0 errors.

- **ast-grep-napi runner migrated to napi's native rule engine; hand-rolled interpreter deleted (closes #206)** — the runner used a ~240-line hand-rolled rule interpreter (`nodeMatchesCondition`/`findMatchingNodes`/`findByKind`/`legacyRuleMatches`) over a hand-rolled YAML parser (`parseSimpleYaml`). That parser could not faithfully serialize the ast-grep grammar — it flattened nested `any`/`has`, kept quotes inside `kind: "true"`, and dropped the metavariable key from `constraints` — so relational/`field`/`constraints` rules were silently skipped, and the interpreter's `has` both recursed AND matched the node itself (a self-referential `kind: X` has `kind: X` flagged **every** X: `nested-ternary` reported 720 of which ~678 were false). Now: (1) `parseSimpleYaml` is a thin `js-yaml` wrapper — the full grammar survives intact and is fed straight to `root.findAll({rule, constraints})`; one malformed document skips only itself, not its whole file; (2) the runner always uses napi (the `ast-grep-native-rules` flag and the entire legacy interpreter are gone); a rule napi rejects is skipped, never partially evaluated. Corpus changes to land the migration cleanly: quoted three rule `message:` scalars that began with `!!`/contained `:` (js-yaml threw on them, silently dropping the rules); rewrote five rules that used non-existent tree-sitter kinds (`element_access_expression`→`subscript_expression`, `property_access_expression`→`member_expression`, `block`→`statement_block`, `for_of_statement`→pattern) — they had been dead in both engines; added `stopBy: end` to `switch-without-default` and `nested-ternary`(+js) (their `has` targets a non-direct descendant — `switch_default` lives under `switch_body`); left direct-child `has` rules (`no-throw-string`, `no-discarded-error`, `else-return`, `redundant-state`/`follows`) at napi's neighbour default so they don't over-report. Earlier de-risking (this batch): `no-constant-condition`(+js) rewritten to a flat pattern any-list; `constructor-super`(+js)/`no-process-env`/`no-hardcoded-secrets`(+js)/`unchecked-sync-fs`(+js) moved to `rules-disabled/` (constraint/relational rules that were never actually running; secrets entries marked `deprecated` in the catalog). Net on this repo: 233 files, 0 errors, ~632 diagnostics with the `nested-ternary` false-positive bomb gone and previously-dead relational rules now correctly active. Guarded by `ast-grep-sonar-rules.test.ts` (native `has`/`stopBy` semantics: nested vs single ternary, switch with/without default, rewritten relational rules) and `yaml-rule-parser.test.ts` (faithful nested-`any`/`has` + `constraints` survive the parse; malformed doc returns null).

- **LSP registry-consistency guard (follow-up to #208)** — #208 was a server pi-lens wires that never actually came up, so we added a deterministic per-PR guard: `tests/clients/lsp/lsp-registry-consistency.test.ts` validates every `LSP_SERVERS` entry is well-formed — globally-unique ids, required `spawn`/`root`/`extensions`, clean extension tokens, sane optional timeouts — catching half-wired or duplicated entries cheaply. The complementary *live* end-to-end install→launch→`initialize` smoke (across all install strategies) is tracked in #209: a first cut produced false failures on Windows (a hand-rolled handshake that bypassed `vscode-jsonrpc` framing missed the flagship typescript server, which actually responds in ~120 ms), so it's being reworked to drive pi-lens's real LSP client before it lands as a nightly job.

- **LSP auto-install no longer rejects stdio servers that fail `--version` (closes #208, reported by a Fedora Silverblue user)** — `verifyToolBinary` confirmed a freshly-installed binary by running `<bin> --version` and requiring exit 0. Servers built on `vscode-languageserver-node` — the `vscode-langservers-extracted` family (JSON/CSS/HTML/ESLint) — reject a bare `--version`: `createConnection()` throws `Connection input stream is not set … '--node-ipc', '--stdio' or '--socket={number}'` and exits 1. So every install "verified as broken," got cleaned up, and those LSPs were never available (lost diagnostics/hover/format, plus repeated wasted install attempts at startup). Verification now treats that specific transport-required error as success — it is positive proof the binary loaded and is a working LSP server that simply needs `--stdio` to run. A genuinely broken install still fails, because it errors with a *different* message (`ERR_MODULE_NOT_FOUND`, `SyntaxError`, …) that doesn't match the pattern, so the broken-install guard is preserved. **Smoke-tested against the real `vscode-langservers-extracted@4.10.0` binaries**: JSON/CSS/HTML/ESLint all emit the transport error and now verify — these are exactly the four LSP servers pi-lens wires (`clients/lsp/server.ts`, each spawned with `--stdio` and auto-installed via `managedToolId`). pi-lens does **not** configure a Markdown LSP, so the package's Markdown binary is irrelevant here; it additionally fails to load under Node ≥24 (unrelated upstream `vscode-uri` ESM-interop `SyntaxError`, before the transport check), which verification correctly continues to reject — so it is neither used by pi-lens nor force-verified. The check is a small exported predicate (`isLspTransportRequiredError`) guarded by `tests/clients/installer/lsp-transport-verify.test.ts` (the exact vscode transport error → pass; the real Markdown `vscode-uri` crash / module-not-found / syntax-error / unknown-flag → still fail).

- **LSP last-known diagnostics cache is content-hash guarded — no more stale actionable-warnings (refs #207)** — the actionable-warnings turn_end read reused `getLastKnownDiagnostics` (keyed by path only) on the premise that dispatch's `touchFile` primed it that turn — but `touchFile` never wrote `lastKnownDiagnostics` (only the service-level `getDiagnostics` did, called by the *fresh* branch and the agent lsp tools). So once an earlier turn's fresh branch cached diagnostics, later turns on the same file served those **prior-turn** results as `"cache"` with no content guard — genuine staleness, worst when LSP is cold (the entry can't be refreshed that turn). This was the ~40% `lspSource:cache` seen in the log review. Now `touchFile` primes `lastKnownDiagnostics` together with a sha256 of the synced content (gated on `collectDiagnostics`), `getLastKnownDiagnostics(path, expectedContentHash)` returns the entry only on a hash match (the content-less service merge clears the hash, so those entries never pose as current; the unguarded widget read still gets last-known for display), and actionable-warnings hashes the on-disk bytes and passes them: match → verified-current reuse, mismatch/absent → fresh open+wait. `lspSource:"cache"` now means **verified-current reuse**. Guarded by `actionable-warnings-lsp-cache.test.ts` (passes the correct hash; reuses on match with no fresh read; rejects a stale entry on hash mismatch → forces a fresh read).

### Changed

- **Rust/Go/type-coverage availability probes are now async (refs #197)** — `RustClient.findCargoPath`/`isAvailable`, `GoClient.findGoPath`/`isGoAvailable`, and `TypeCoverageClient.isAvailable`/`scan` were sync `safeSpawn` `--version`/path probes that blocked the event loop on first use; they're now `findCargoPathAsync`/`isAvailableAsync` etc. on `safeSpawnAsync`, with their callers (the `rust-clippy`/`go-vet` dispatch runners, the `session_start` active-tools list, and `/lens-booboo`) awaiting them. The unused `GoClient.isGoplsAvailable` was deleted outright. One intentionally-sync probe remains: `TestRunnerClient.detectRunner`'s `which pytest` check — it's cached per (cwd, runner) and only fires once for a Python project with no config-file runner, and converting it would ripple async through five methods into the per-edit turn path for no real gain.

- **Dispatch availability probes are now async-only (refs #197)** — the runner availability layer carried parallel sync/async probes; the sync ones blocked the event loop on first use. `createAvailabilityChecker` now exposes only `isAvailableAsync` (the never-taken sync `isAvailable` fallback is gone, and all ~25 runners + `resolveAvailableOrInstall` use the async path directly), the ast-grep availability chain collapsed to its async form (`AstGrepClient.runTempScanAsync` now `await`s `ensureAvailable()`, retiring the dead sync `AstGrepClient.isAvailable` → `SgRunner.isAvailable` → `isSgAvailable` → `probeAstGrepCommand` cascade), and the unused sync `isCommandAvailable` in `dispatch/runners/utils.ts` was deleted. No remaining sync spawn in the dispatch availability layer; behaviour unchanged (full suite green).

- **Tool installs and formatter probes no longer block the event loop (refs #197)** — converted the last event-loop-reachable synchronous spawns to `safeSpawnAsync`: the LSP runtime-install actions (`tryGoInstallGopls` `go install`, `tryDotnetToolInstall` `dotnet tool install`/`update`, `tryGemInstall` `gem install` — previously raw `spawnSync` that could freeze the TUI for the whole install, and `go install` had *no* timeout at all), and every formatter probe/install in `formatters.ts` (`gem install rubocop`, `rustup component add rustfmt`, `which`, `go env GOROOT`, `dotnet csharpier --version`, the PSScriptAnalyzer check). On Windows this also fixes a latent bug — `gem`/`dotnet` are often `.cmd` shims that bare `spawnSync(…, { shell:false })` can't launch, whereas `safeSpawnAsync` uses shell mode. Installs pass a new `ignoreAmbientSignal` option so they run to completion even if the agent turn is interrupted (matching the old uncancellable sync behaviour — an Esc can't strand a half-finished `gem install`); the quick probes stay cancellable. Equivalence-tested in `tests/clients/install-actions.test.ts` (same command/args, same success-on-exit-0 semantics, the dotnet NuGet-missing and update-fallback branches, the gem PATH update, and the formatter lazy-install dedupe guard) plus a `safeSpawnAsync` `ignoreAmbientSignal` unit test.

### Performance

- **Collapsed the redundant post-edit LSP double-push that discarded in-flight diagnostics (#203)** — on every edit pi-lens pushed the final post-format content to the language server twice: once in the pipeline `lsp_sync` phase (via `resyncLspFile` → `LSPService.openFile`) and again ~80ms later in the `dispatch-lsp-runner`. `openFile` never registered the push in the touch-debounce map (`markTouched`), so the dispatch runner's `shouldSkipNotify` always returned false and its `didChange` **cleared the diagnostics the first push had just set the server computing**, forcing a from-scratch recompute and a multi-second wait. Latency-log evidence (`~/.pi-lens/latency.log`, ~18k events): the notify-skip dedup fired on just 2 of ~465 dispatch touches, and ~280 of ~700 document-diagnostics waits timed out — **136 of 142 on TypeScript** (`typescript-language-server` is push-only, so the timeouts were us throwing away a push that did arrive, not waiting on one that never came). `resyncLspFile` now routes through `touchFile({ diagnostics: "none", source: "lsp_sync", clientScope: "primary" })`, so the sync push registers via `markTouched`; the dispatch touch moments later then hits `shouldSkipNotify=true`, reuses those diagnostics instead of re-clearing, and `waitForDiagnostics` fast-paths. Expected `dispatch_lint` p50 ~3.1s → ~2.2s on every LSP edit, with the `.ts` timeout population largely eliminated. The old `formatChanged`/`preserveDiagnostics` branch is dropped — `didChange` triggers a server recompute regardless, so letting the cache clear yields fresh, correctly-positioned diagnostics rather than stale pre-edit ones. Regression-tested in `tests/clients/pipeline.test.ts` (the sync routes through `touchFile` with the registering options, not `openFile`); the touch→touch dedup itself is already covered by `service-touch-collect.test.ts` (#116).

- **Per-server diagnostics-wait budget on the LSP hot path (#203)** — `touchFile` resolved its diagnostics-wait timeout from a flat default (the dispatch runner's 2500ms / a 1200ms floor), ignoring the per-server budgets already defined in `server-strategies.ts`. On the single-server primary path it now uses that server's `aggregateWaitMs` (TypeScript 1000ms, rust-analyzer 3000ms, python 1500ms, …), bounded by any caller ceiling — so a fast server isn't held to a flat multi-second wait while a slow one still gets the time it needs. Env override (`PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS`) still wins, and the multi-server `full`/cascade path keeps its flat resolution. Covered by `tests/clients/lsp/service-touch-collect.test.ts`.

- **Auto-warm the dominant language's LSP at `session_start` (#203)** — first-edit-of-session cold-spawn stalls (`lsp_client_wait_timeout`, observed up to 5s on TypeScript/Deno) happened because servers only pre-warmed when a project explicitly listed `warmFiles`. When none are configured, pi-lens now uses the language detection it already does to pre-spawn just the **dominant** language's server (highest source-file count) by opening one representative file — backgrounded off the interactive path. Only one server is warmed by design: launching every detected language's server at once (rust-analyzer + gopls + tsserver …) would spike the event loop at startup, working against the latency it protects. The scan is directory-reads-only (`inspectGeneratedHeaders:false`, no per-file opens). Covered by `tests/clients/runtime-session-warm.test.ts`.

- **Document-version-coherent diagnostics freshness (#203)** — `waitForDiagnostics` judged freshness off a monotonic push counter, so a stale `publishDiagnostics` for a superseded document version could satisfy a wait for the current one (a latent correctness gap exposed once the double-push above stops clearing the cache pre-wait). The client now records the LSP document version each push was computed against (`publishDiagnostics.version`) and rejects cached results that lag the latest `didChange`. Servers that omit a version are treated as current, so version-less servers are unaffected and the timeout remains the backstop. Covered by `tests/clients/lsp/client-internals.test.ts`.

### Removed

- **Deleted the dead synchronous linter/formatter methods from `BiomeClient`/`RuffClient` (refs #197)** — both clients carried a full legacy *sync* surface (`checkFile`, `checkFormatting`, `fixFile`, `fixFiles`, `formatFile`, `formatDiagnostics`, biome's `getFormatDiff`/`withValidatedPath`/`spawnBiome`, plus the now-orphaned private `parseDiagnostics`/`computeDiff`) built on the event-loop-blocking sync `safeSpawn`. An audit of the live dispatch path confirmed **none of these had any caller** — every per-edit path already runs async: the dispatch runners (`biome-check.ts`, `ruff.ts`) use `safeSpawnAsync`, autofix-on-write uses `fixFileAsync` (`pipeline.ts`), and format-on-write uses the async `formatService`. The audit that flagged "autofix-on-write blocks the loop" had conflated this dead sync code with the live `fixFileAsync` sitting next to it. Removing it deletes the most alarming sync-spawn call sites outright (-719 lines; biome-client 657→233, ruff-client 511→218) with zero behavior change (full suite green). The remaining sync `safeSpawn` sites are the cached availability probes and one-shot install actions tracked in #197.

- **Deleted the remaining dead legacy-sync methods + an unused module (refs #197)** — continuing the sync-`safeSpawn` cleanup: removed `TestRunnerClient.runTestFile` (sync; the live per-write path uses `runTestFileAsync`), `AstGrepClient.scanFile` → `SgRunner.execSync` → `SgRunner.tempScan`/`scanWithRule` (a fully dead sync ast-grep scan cascade; the ast-grep tools and temp-scans all use the async `exec`/`tempScanAsync` paths), and the entire `clients/subprocess-client.ts` (a 101-line abstract `SubprocessClient` base with **zero** importers). Orphaned helpers/imports went with them (`mapSeverity`, the `AstGrepParser` import, `sg-runner`'s now-unused sync `safeSpawn` import) and the obsolete `execSync` tests were removed (the co-located `formatMatches` tests were re-parented, not lost). ~360 fewer lines, zero behavior change (full suite green). Kept by design: `findCargoPath`/`findGoPath` and the `detectRunner` pytest probe (bounded, cached) and the `booboo` command-path probes (user-invoked).

- **Deleted the dead synchronous check methods from `RustClient`/`GoClient` (refs #197)** — same legacy pattern as the Biome/Ruff cleanup: the per-edit Rust/Go diagnostics already run through the async dispatch runners (`rust-clippy.ts`/`go-vet.ts`, which call `findCargoPath`/`findGoPath` + their own `safeSpawnAsync`), so the clients' sync `checkFile`/`clippyCheck`/`buildCheck`/`formatDiagnostics` methods (built on blocking `safeSpawn`) and their now-orphaned private `parseJsonOutput`/`parseOutput` + `CargoMessage` type had **no callers**. Removed (rust-client 270→107, go-client 242→126). The still-live probes are intentionally kept: `findCargoPath`/`findGoPath` (a bounded, cached, one-time `--version` fallback only hit when the tool isn't at a standard absolute path) and the status-list `isAvailable`/`isGoAvailable` (command/`runtime-session` path) — tracked as the residual in #197.

- **Deleted two more dead sync modules/functions (refs #197)** — the entire `clients/tool-availability.ts` module (a 251-line cached tool-availability layer — `isToolAvailable`/`getToolVersion`/`ToolAvailabilityChecker`/`TOOL_REGISTRY`) had **zero importers** anywhere in source or tests, and the sync `resolveLocalFirst()` in `runner-helpers.ts` was superseded by its live async twin `resolveLocalFirstAsync()` and likewise had no callers. Both built on sync `safeSpawn`; deleting them removes three more event-loop-blocking probe sites at zero risk. The genuinely *live* remaining sync probes — `createAvailabilityChecker`'s sync `isAvailable` fallback and `isSgAvailable()` (reached via the clients' legacy sync `isAvailable()` methods, e.g. `ast-grep-client`/`rust-client`/`type-coverage-client`) — are a cross-client availability-contract change tracked as the remaining (B) work in #197, not a deletion.

### Security

- **Patched a moderate ReDoS-class advisory in a transitive dep and added a CI audit gate** — `brace-expansion` (pulled via our direct `minimatch@^10`) resolved to a version under GHSA-jxxr-4gwj-5jf2 (a large numeric range defeats its documented `max` DoS protection). Bumped to `5.0.6` (lockfile-only; `npm audit` clean for both prod and full trees). It slipped through because Dependabot's weekly *version* updates only bump direct deps, and `minimatch@^10` was already satisfied — nothing was watching the transitive tree. CI now runs `npm audit --omit=dev --audit-level=high` in the lint job, so a known-vulnerable **production** dependency (what ships to users via `--omit=dev`) fails the build at PR time instead of being noticed by chance; the gate is scoped to high/critical to avoid blocking on fix-less moderate advisories, which Dependabot security updates can handle separately.

### Fixed

- **Production install no longer fails to build `dist/` under `npm install --omit=dev` (#193, thanks @feoh; guarded by #194)** — `prepare`/`build:dist` inherited `types: ["node"]` from the base tsconfig, so under pi's `--omit=dev` git install (dev-only `@types/node` absent) `tsc` failed with TS2688 *before* type-checking — `--noCheck` doesn't suppress a program-construction error, contrary to what #182 assumed. `tsconfig.dist.json` now sets `types: []` (the transpile-only dist build needs no ambient node types). A new CI job (`prod-install-build`) installs `--omit=dev` and builds `dist/` from source, so this can't regress — the tarball-based install-test never re-ran the build under `--omit=dev` (#194).

- **Faster startup: ship precompiled JS instead of transpiling on every launch (closes #182)** — pi-lens was distributed as TypeScript source (`main: index.ts`, `pi.extensions: ["./index.ts"]`), so pi's jiti loader transpiled ~215 `.ts` files on every cold start (including `/new`), adding ~3.5s. The package now ships a precompiled `dist/` and points `main` + `pi.extensions` at `./dist/index.js`, which pi loads directly (~1.5s). A `prepare` step (`tsconfig.dist.json` → `dist/`, transpile-only via `--noCheck`) builds it **on install — including `git:` installs, which run `npm install` not `npm pack` — and before publish**, so both install paths get the compiled output with no rebuild script. pi-lens's own asset resolution is unaffected: `rules/`, `config/`, and grammars resolve via `getPackageRoot()` (walks up to `package.json`), not module depth. Guarded by `tests/packaging.test.ts` (entry/`files` contract), an upgraded `scripts/check-extensions.mjs` (validates compiled `.js` imports resolve), and CI install-test steps that verify the tarball ships `dist/index.js` with no `.ts` source and that the compiled entry loads. The dev/test loop still uses the in-place `npm run build`.

- **Skills now actually load under the moved entry (closes #199)** — pi resolves each `pi.skills` entry relative to the extension entry's **file path** (`path.resolve(entryFile, skillEntry)`), not its directory. Once the entry moved to `./dist/index.js` (#182), `pi.skills: ["../skills"]` resolved to `<root>/dist/skills` — the `../` only cancels `index.js` and stays in `dist/` — which doesn't exist, so pi-lens's skills silently stopped loading and pi warned `[Skill conflicts] … skill path does not exist`. Reaching the real root `skills/` from `dist/index.js` needs to climb **two** levels, so `pi.skills` is now `["../../skills"]`. The earlier value was off by one and the CI/tarball check never caught it (it only verifies `skills/` *ships*, not that pi *resolves* it); `tests/packaging.test.ts` now statically replicates `resolve(entryFile, skillEntry)` and asserts it lands on the package's own root `skills/`.

- **`ast_grep_replace` apply no longer falsely reports "no matches" on a successful replacement (closes #178)** — the apply path counted matches *after* writing the fix, so any content-changing replacement reported `[APPLIED] No changes made (no matches found)` despite succeeding, misleading agents into thinking the edit failed. Both replace paths (pattern and rule) now report the **pre-apply** match count, and the apply-zero display message is unambiguous (`[NOT APPLIED] No matches found …`).

- **Reliable alphabetical sort of project-diagnostic sources** — `[...sources].sort()` relied on default UTF-16 ordering, which SonarCloud flags as unreliable (`typescript:S2871`); now uses an explicit `String.localeCompare` comparator.

- **Multi-line diagnostic messages no longer break TUI rendering (closes #189)** — diagnostics with multi-line messages (e.g. TS2769 "no overload matches this call") spilled across several widget rows and broke the layout (and the `L<line>: <message>` inline-blocker format), because `fitLine` clips by visible width but embedded newlines survive. `recordDiagnostics` now collapses whitespace runs to a single space at storage, so the widget, `lens_diagnostics`, and summaries all get single-line messages.

- **`session_start` no longer freezes TUI input on cold boot / `/new` (closes #188)** — the synchronous `session_start` walks (scan-context, language profile, todo / call-graph scheduling) ran O(N) without yielding, starving the stdin macrotask queue for 3–6s on large projects. Fixed with an `ignoreMatcher` path-memo (mtime-invalidated), process-lifetime memos for scan-context and language-profile, async chunked-yield walk variants, background scans deferred past the typing window, a per-file chunked todo scan, and a cold-start forced-quick + delayed-warmup. `session_start` total drops from 3000–6000ms to ~3ms on a 1832-file project. Env knobs: `PI_LENS_COLD_START_QUICK`, `PI_LENS_WARMUP_DELAY_MS`, `PI_LENS_STARTUP_MODE`. Together with #182 this fixes both halves of startup latency (jiti transpile + scan). Thanks @amit-gshe.

- **Source-file enumeration no longer blocks the event loop (perf hardening, follows #188)** — the file walk under the deferred todo / project-diagnostics scans (`collectSourceFiles`) was still a single ~1.5s synchronous burst on a 2k-file project (≈70% of it the per-file 4 KB generated-header read), blocking TUI input even though #188 had made the *callers* yield. Added a chunked-yield `collectSourceFilesAsync` (shares the filter logic with the sync collector via an extracted `classifyEntry`, so results are identical), memoized the generated-header verdict (keyed on path+mtime+size, self-invalidating on edit), and routed the background callers (todo, project-diagnostics) to the async path. Longest synchronous block during enumeration: **~1576ms → ≤38ms cold / 5.9ms warm**; returned file set asserted identical. Guarded by `tests/clients/source-filter-async.test.ts`; remaining (riskier) source-walk hardening tracked in #191.

- **Per-edit cascade graph rebuild no longer freezes the TUI (perf hardening, follows #188/#191)** — `buildOrUpdateGraph` runs on **every** write/edit (via `computeCascadeForFile`), and even on a pure cache hit it re-derived the workspace source-file list (sync tree walk + per-file 4 KB generated-header read) and re-statted every project file just to compute the cache-validity signature — the same sync-FS-over-all-files class #188 fixed for startup, here on the path that runs on every keystroke-triggered edit. Made the walk (`getGraphSourceFiles`) and the signature/stat loop (`sourceSignatureMapAsync`) async + chunked-yield, reusing the existing `collectSourceFilesAsync` (byte-identical file list via the shared `classifyEntry`) and producing the identical `file → "size:mtimeMs"` signature; `_doBuildGraph` already awaited the builder so the call contract is unchanged. Longest synchronous block on a 1,200-file project: **warm cache-hit ~770ms → ~47ms; cold full derivation ~2,215ms → ~46ms** (total FS work unchanged — the loop now yields instead of freezing). Verified behavior-preserving: the async sections touch only local accumulation (no shared cache/fact mutation), and concurrent different-file builds were already interleavable at the existing `await` points, so no new race. Guarded by `tests/clients/cascade-graph-occupancy.test.ts`. The walk still runs each edit (now yielding), but we deliberately stop here: the expensive work (tree-sitter parse + graph construction) is already cached, so this walk is only the cache-*validation* step, and memoizing it would trade always-fresh impact analysis for tens of ms of yielded work on an accuracy-critical path — with no FS watcher to catch out-of-band file changes. Closed #196 won't-do with that rationale.

- **`lens_diagnostics` no longer lists findings the agent already fixed this session (read-your-writes, closes #180)** — `mode=all` reads the widget's per-file diagnostic state, which only refreshes a file when that file is re-dispatched. Because per-edit dispatches are **debounced** (flushed at `turn_end`), an agent that fixed files and then queried `lens_diagnostics` in the same turn saw the **pre-fix** diagnostics still pending in the debounce window. Now the tool **flushes pending dispatches before reporting** (`flushDebouncedToolResults`, injected) so just-fixed files are re-dispatched and reflected, and then **reconciles the live widget against the filesystem** (`reconcileStaleWidgetFiles`): entries whose file changed on disk after their diagnostics were recorded (`mtime > touchedAt`, e.g. an external edit) or that were deleted are dropped — and `mode=all` notes how many were omitted ("N changed files omitted as stale — use mode=full to rescan") so a changed-but-unscanned file reads as *stale*, not falsely clean. Cross-file staleness (a neighbor whose own content is unchanged but whose diagnostic an edit elsewhere invalidated) is a separate follow-up. Guarded by `tests/tools/lens-diagnostics.test.ts` (flush invoked, stale note) and `tests/clients/session-state-store.test.ts` (`reconcileStaleWidgetFiles` drops edited/deleted, keeps unchanged).

- **`rust-analyzer` no longer spawns one process per directory while scaffolding (closes #201 for Rust)** — `RustServer.root` was `RootWithFallback(RustWorkspaceRoot())`, whose default fallback is `FileDirRoot` (the file's own directory). Before a `Cargo.toml` exists, `RustWorkspaceRoot()` returns `undefined`, so every `.rs` file fell back to its own directory as the root — and since LSP clients dedup by `` `${serverId}:${root}` ``, each directory spawned a **separate `rust-analyzer`** (the active-LSP count climbed one-per-file during project creation, and each server was rooted at a manifest-less dir where rust-analyzer can't function). Dropped the fallback for Rust: no `Cargo.toml` ⇒ `undefined` ⇒ the server is skipped (no spawn) until a manifest gives a stable, shared crate root, after which all files share one server. The with-manifest behavior is unchanged. (C# `csharp-ls` has the same fallback trap but a compounding bug — `createRootDetector` matches markers by exact filename, so `.csproj` never matches a real `Foo.csproj` and C# currently depends on the fallback entirely; fixing it needs extension/glob marker support, tracked on #201.)

- **Read-guard autopatch now tolerates mid-block blank-line drift in `oldText` (Tier A of #200)** — when an agent's `Edit` `oldText` differed from the file only by a blank line added/removed *inside* the block, the autopatch's fixed-length window matchers couldn't bridge it (any interior blank-line delta breaks 1:1 line alignment), so the edit failed `oldtext_not_found` and the agent had to re-read/retry. A new blank-line-insensitive matcher (`findBlankLineInsensitiveCandidate`) matches the `oldText`'s non-blank lines (indentation-insensitive) against consecutive content, skipping interior blanks, and — critically — **recovers and returns the real file span verbatim** so the applied `oldText` is actual file bytes. Safety-gated: anchored on ≥2 non-blank lines, requires the signature to match **exactly once** (refuses on 0 or ≥2), and inherits the caller's existing `correctedMatchCount === 1` check — it prefers a no-patch over ever patching the wrong span. Internal-whitespace tolerance (string-literal-sensitive, riskier) remains tracked as Tier B on #200.

- **Tests can no longer silently run against a stale in-place build (closes #198)** — `npm run build` emits compiled `.js` next to each `.ts`, and vitest resolves a test's `.js` import specifier to that literal compiled file. Editing a source `.ts` and running the suite without rebuilding therefore exercised the *previous* build — the change was silently untested while `npm run lint` (which type-checks the `.ts`) stayed green. A vitest `globalSetup` (`tests/support/check-build-freshness.ts`) now fails fast — for any launch, including a direct `npx vitest run` that a `pretest` hook would miss — when a compiled-source `.ts` under `clients/`/`commands/`/`tools/` (or root `index.ts`/`i18n.ts`) is newer than its `.js` or has none, with an actionable `⛔ Stale build … run npm run build` message. The detection logic is unit-tested against a temp fixture (`tests/build-freshness-guard.test.ts`). This is the guard for the gotcha that nearly mis-calibrated the cascade occupancy test.

- **LSP workspace-diagnostics + warm-path FS calls no longer block the event loop (perf hardening, follows #188/#191)** — four synchronous filesystem calls on LSP hot paths were converted to their async equivalents, all behavior-preserving: (1) `collectWorkspaceDiagnosticFiles` (the `lsp_diagnostics` project-wide enumeration) walked the tree with a non-yielding `readdirSync` recursion — **~44.5ms → 0.7ms** longest sync block at ~1,400 files, scaling linearly on monorepos — now an `fs.promises.readdir` yielding walk; (2) its per-file `readFileSync` worker reads → `await readFile`; (3) `handleNotifyOpen`'s document-open existence probe `existsSync` → `await access` (the `didChangeWatchedFiles` Created/Changed type is unchanged); (4) `isOnPath` (the runtime-install gate on the spawn fall-through) `spawnSync("where"/"which")` → the shared `isCommandAvailableAsync` (`safeSpawnAsync`, 5s timeout, same `status === 0` semantics) so a stalled finder can't freeze the loop. The spawn-dedup invariant (one in-flight launch per `serverId:root`) was verified already correct and left untouched. Guarded by `tests/clients/lsp/workspace-diagnostics-occupancy.test.ts`.

- **`lsp_diagnostics` cascade cleanup no longer stats files synchronously (perf hardening, partial #197)** — `LSPService.getAllDiagnostics` (the cascade-checking path) pruned tracked diagnostics with a blocking `existsSync` per file *inside* the prune predicate, holding the event loop across every tracked file. Existence is now resolved in an async pre-pass (`fs.promises.access`, concurrent) and pruning stays a synchronous in-memory map operation — same semantics (a file is pruned iff it's missing **or** older than the cascade TTL), via a new `client.getTrackedDiagnosticPaths()`. Guarded by `tests/clients/lsp/get-all-diagnostics-prune.test.ts`. The remaining sync calls under #197 (the `go`/`dotnet`/`gem` install `spawnSync` and the single-shot `launch.ts`/root-detection stats) are deliberately left: they run once per tool/launch, off the typing window, and the install conversion needs equivalence testing of real install side-effects + reconciling `safeSpawnAsync`'s forced `shell` / timeout against the install commands' `shell:false`.

## [3.8.50] - 2026-06-07

### Added

- **Function-level call graph + impact analysis (closes #154)** — a cross-file call graph is built at session-start (ref→def resolution, bidirectional callers/callees, in-degree centrality, ambiguity-discounted edges); at turn-end the symbols a modified file touches surface a `WillBreak`/`MayBreak`/`Review` impact advisory. Backed by `import-facts` extended to JS/JSX/MJS/CJS with dynamic imports, module-type detection and re-export edges, and a `review-graph` whose `MAIN_KINDS`/language mapping spans every WASM-backed grammar.

- **Internal codebase mental model (closes #155)** — a compact structural summary ranked by call-graph in-degree, cached to `<project-data>/cache/codebase-model.json`. Internal-only (a session-start debug line) until validated across real sessions; agent exposure + hybrid ranking are tracked in #162.

- **`lens_diagnostics` tool (closes #159)** — queries pi-lens's cached diagnostic state with no LSP/dispatch re-run. `mode=delta` = the current turn's fixable + code-quality warnings; `mode=all` = every file edited this session.

- **`ast_grep_search` results register as reads so a follow-up edit isn't blocked (refs #169)** — the search→edit flow (find where something must change, then edit those lines) was blocked by the read-guard because the search didn't count as a read. `ast_grep_search` now attaches the shown match locations to its result (`details.searchReads`), and the tool_result handler registers each as a read **± 2 lines** of context via the new `clients/search-read-registration.ts`. Only the shown lines are registered — never the whole file — so editing an unseen region is still guarded. (`lsp_navigation` and bash `grep` are the remaining parts of #169.)

- **Disable automatic context injection without disabling pi-lens (closes #165)** — a narrow opt-out for the prompt-cache cost of prepending automatic findings. `--no-lens-context` flag, `contextInjection.enabled: false` in `~/.pi-lens/config.json`, `PI_LENS_NO_CONTEXT_INJECTION=1` env, and a runtime `/lens-context-toggle` command. When off, the `context` hook stops prepending session-start guidance / turn-end findings / test findings, but everything else keeps running — tools, LSP, read-guard, formatting, inline tool-result feedback — and findings are still cached so `lens_diagnostics` and `/lens-health` work. Precedence: env → CLI flag → config.

### Fixed

- **Read-guard tracks non-Read file access (closes #168, refs #169)** — bash file views (`cat`/`head`/`tail`/`sed -n`) register as reads with their exact line ranges; bash writes (`>`/`>>`/`tee`/`sed -i`/`cp`/`mv`/`touch`) register as authored-by-agent like the Write tool; search-tool matches register the shown lines ±2 context. So a follow-up edit to something the agent viewed, wrote, or searched is no longer falsely blocked. `grep`/`find`/`ls` are not treated as content reads.

- **Bash-written files are re-analyzed (no more stale diagnostics after `git checkout`/`git restore`)** — a bash command that rewrites working-tree content (redirects, `tee`, `sed -i`, `cp`/`mv`, `touch`, and now `git checkout -- <file>` / `git restore <file>`) never went through the edit-tool pipeline, so its diagnostics, `fileSeq`, and change-log stayed frozen at the pre-write state — e.g. restoring a file would keep reporting the old broken-state warnings on every later `lens_diagnostics` call. Each in-project file a bash command writes/restores is now re-run through the dispatch pipeline (via a synthetic write) so its analysis refreshes. Whole-tree git ops (`reset --hard`, `stash pop`, `revert`, branch switches) don't name files and aren't covered.

- **`LSP Inactive` footer status no longer rendered in red (closes #167)** — having no LSP server running for the current file (or after the idle timer releases them) is a passive state, not a fault, but it was painted in the `error` (red) color, implying something was broken. It now uses the neutral `dim` (grey) color; `LSP Active (n)` stays green. Surfacing genuine LSP *failures* in red is tracked in #170.

- **Extension load no longer requires the host coding-agent package in `node_modules`** — `index.ts` and `clients/read-guard-tool-lines.ts` imported a *runtime* value (`isToolCallEventType`) from `@earendil-works/pi-coding-agent`. pi installs extension deps with `npm install --omit=dev`, so that package isn't present at runtime; and pulling it in drags a huge transitive tree (LLM provider SDKs) whose deeply nested paths exceed Windows' `MAX_PATH`, breaking `git clean -fdx` on `pi update` (→ a half-deleted `node_modules` → `Cannot find module 'vscode-jsonrpc/node.js'`). The one-line discriminant is now inlined in `clients/tool-event.ts`, so every `@earendil-works/pi-coding-agent` import is type-only (erased at runtime) — matching the established pi-extension pattern (e.g. `nicobailon/pi-subagents`).

- **`js-yaml` moved from `devDependencies` to `dependencies`** — `clients/ast-grep-yaml-synth.ts` imports it at runtime, but it was declared dev-only, so a production (`--omit=dev`) install left it missing and the extension failed to load with `Cannot find package 'js-yaml'`. (`@types/js-yaml` stays dev-only.) The CI install-test (production tarball install + `tsx` load) now exercises this path so misplaced runtime deps are caught before release.

- **Lockfile kept committed and guarded against drift** — `package-lock.json` had silently drifted from `package.json` (the exact `web-tree-sitter` pin was recorded as `^0.25.10` in the lock), which makes `npm ci` delete `node_modules` then hard-fail. The lock is now regenerated in sync, and a new `npm run check:lockfile` guard (run in CI) fails the build if any declared dependency spec diverges from the lock — so the drift that started this can't recur. CI/release also switched from `npm ci` to `npm install` so a future desync degrades (self-heals) instead of hard-failing.

### Changed

- **`lens_diagnostics` mode=all now shows the actual diagnostics, not just counts, and is no longer limited by the TUI's display cap** — previously it printed `file.ts  3W` with no indication of *what* the warnings were. It now lists each diagnostic in the same `L<line>: <message> [rule]` shape as the inline blocker output (blockers first, 🔴-marked), honouring the `severity` filter. The widget state keeps a separate **uncapped** per-file diagnostic list for the tool (the TUI still uses its 12-entry render cap), so `getFileDiagnosticSummaries()` exposes the **full** set instead of just the 12 the widget retained for rendering. The tool applies its own generous 50-per-file budget with an accurate `… N more in this file (showing 50 of N)` note (the old note double-counted via `blocking + errors + warnings`).

### Added

- **Six new structural rules covering SonarCloud BLOCKER/CRITICAL TS gaps** — pure-AST checks (no taint analysis required), each with tests run through the production runner. ast-grep: `no-sort-without-comparator` (S2871 — `.sort()`/`.toSorted()` with no compare function), `no-octal-literal` (S1314 — legacy leading-zero octals), `no-mutable-export` (S6861 — exported `let`/`var`), `switch-without-default` (S131 — `switch` with no `default` clause). tree-sitter: `no-equality-in-for-condition` (S888 — `==`/`!=` as a `for`-loop exit test), `no-jump-in-finally` (S1143 — `return`/`break`/`continue`/`throw` written directly in a `finally` block). All `warning` severity.

- **`redos-nested-quantifier` ast-grep rule — flags catastrophic-backtracking (ReDoS) regex literals** — detects an unbounded quantifier nested inside an unbounded-quantified group (`(a+)+`, `(a*)*`, `([a-z]+)*`, `(\d+){2,}`, `(a{2,})+`), the classic CWE-1333 / S5852 exponential case. Fires only when both inner and outer quantifiers are unbounded (`+`, `*`, `{n,}`); bounded quantifiers like `{2,3}` are intentionally not flagged. Runs in the NAPI runner via `kind: regex_pattern` + a linear detector regex (no self-ReDoS). `warning` severity with fix guidance (bounded quantifier, atomic-group emulation, negated character class, or RE2/node-re2 for untrusted input).

- Extended oxfmt formatter to CSS, SCSS, Less, HTML, JSON, YAML, Markdown, MDX, GraphQL, TOML, Vue files. Updated tool-policy entries and added unit tests.

- **`ast_grep_search` / `ast_grep_replace` structural-intent parameters — `insideKind`, `hasKind`, `follows`, `precedes` (closes #125 Phase 3)** — agents can now express cross-context queries without writing YAML. `insideKind: "function_declaration"` restricts matches to nodes inside that ancestor kind (searches all ancestors via `stopBy: end`); `hasKind` restricts to nodes containing a descendant; `follows`/`precedes` restrict by sibling pattern. Parameters synthesize a YAML rule via `clients/ast-grep-yaml-synth.ts` and route through `sg scan --config`. For `ast_grep_replace`, a `fix:` field is added to the synthesized rule so `sg scan --update-all` applies the rewrite. When `rule:` (Phase 4) is also provided, it takes precedence. 22 new tests covering synthesizer output, constraint combinations, language canonicalisation, routing, and YAML content assertions.

- **`ast_grep_search` raw YAML rule passthrough — `rule` parameter (closes #125 Phase 4)** — passing a complete ast-grep YAML rule bypasses `sg run -p` entirely and routes through `sg scan --config`, unlocking `all`/`any`/`not`, `nthChild`, `regex`, field constraints, and multi-pattern rules. Each path is scanned independently and results are merged. Pagination (`skip`) works the same as the pattern path.

- **`ast_grep_search` and `ast_grep_replace` metavariable captures in output (refs #125)** — named captures (`$VAR`, `$$$ARGS`) from `sg --json=compact` appear below each match. Language field (`[TypeScript]`) surfaced per match.
- **SgRunner binary resolution extended with platform package and Homebrew fallback (refs #153)** — probes `@ast-grep/cli-{os}-{arch}` npm packages (walking up 5 directory levels) and Homebrew (`brew --prefix ast-grep`) before falling back to auto-install.

- **Read expansion ancestry chain (refs #153)** — `ExpandedRead` now includes `ancestry?: AncestorSymbol[]` (outermost first) so the full structural path is available (e.g. `ReviewManager → runSynthesis`). The session-start debug log now shows the full path instead of just the immediate enclosing symbol.

### Fixed

- **Windows subprocess encoding (garbled tool output)** — `safeSpawnAsync` prefixes Windows shell commands with `chcp 65001 >nul 2>&1 &&` to force UTF-8 code page, eliminating garbled characters in `sg`/`biome`/`ruff` error messages.

- **Thrashing warning scoped to same tool+file pair** — consecutive counter resets when either the tool name or the file path changes; editing different files no longer triggers the warning.

- **Regex S5852 backtracking eliminated** — replaced `(.*?)` with `([^(]*)` and `/\r?\n/` with `/\r\n|\n/` in ast-grep-client and lsp-navigation.

- **`@earendil-works/pi-coding-agent` declared as optional peer dependency** — `devDependencies` retains the explicit version for local dev; install test updated to exclude host-provided peer from the `ERR_MODULE_NOT_FOUND` gate.

### Performance

- **Read expansion limit raised from 60 to 100 lines** — expansion now fires for reads up to 100 lines, making it useful for the typical 80-100 line agent reads that previously fell outside the threshold.

## [3.8.48] - 2026-06-05

### Added

- **`ast_dump` tool — expose tree-sitter AST structure for pattern debugging (closes #156)** — new `ast_dump` tool parses a source snippet with `sg --debug-query=ast|cst` and returns an indented AST tree with 1-indexed line:col positions and source snippets per node. Named nodes only by default; `includeAnonymous: true` shows all CST nodes including punctuation. Use this when `ast_grep_search` returns zero matches and the correct node kind or field name is unknown. Invalid language returns a clear error; partial/error trees are returned as-is so syntax errors are visible.

- **`lsp_navigation` `rename_file` operation — LSP-aware source file rename (closes #148)** — new `rename_file` operation sends `workspace/willRenameFiles` to all active LSP servers, collects and deduplicates returned workspace edits (primary type-checker server wins on range conflicts), renames the file on disk, sends `workspace/didRenameFiles`, then re-syncs touched files in LSP. Preview mode (`apply: false`) shows the merged workspace edits without touching disk. Overlap detection across server edit sets throws a descriptive error rather than producing corrupted output.

- **`lsp_navigation` `capabilities` operation — cached server feature map (closes #149)** — new operation reads `serverCapabilities` from the post-`initialize` cached state and renders a per-server table of which `lsp_navigation` operations are actually supported (definition, references, hover, rename, codeAction, workspaceSymbol, implementation, signatureHelp, callHierarchy, workspaceDiagnostics, rename_file). No LSP round-trip. Scoped to a specific file or all active servers when `filePath` is omitted.

- **`lsp_navigation` symbol-to-column resolution (closes #147)** — omitting `character` and supplying `symbol` resolves the correct column automatically by scanning the target line. Full fallback chain: word-boundary regex match → same with `#N` occurrence selector (`symbol: "foo#2"` = second occurrence) → case-insensitive match → first non-whitespace character. Eliminates the dominant class of position-mismatch retries where the agent knew the line but guessed the column wrong.

- **`ast_grep_replace` stale-preview detection, `ast_grep_search` pagination, and strictness parameter (closes #151)** — three improvements to the ast-grep tools. (1) Before applying (`apply: true`), a dry-run re-validates that the pattern still matches; if files changed since the preview, returns a `stalePreview` error rather than applying against wrong content. (2) `ast_grep_search` accepts `skip: N` to offset into large result sets; truncated results include a "Use skip=50 for the next page" hint. (3) Both tools accept `strictness: "smart" | "relaxed" | "ast" | "cst" | "signature" | "template"` passed to `sg --strictness`; `"relaxed"` is the most useful for patterns that miss matches due to optional trailing commas or semicolons.

- **`ast_grep_search` and `ast_grep_replace` surface metavariable captures (refs #125)** — named captures (`$VAR`, `$$$ARGS`) from `sg --json=compact` output are now shown below each match: `$VAR=x  $VALUE=foo(a, b, c)` and `$$$ARGS=a,b,c`. Unnamed wildcards (`$$$` without a name) produce no extra line. Both `SgMatch` and `AstGrepMatch` interfaces include the full `metaVariables` payload for downstream consumers.

- **tree-sitter WASM coverage expanded from 13 to 26 languages (refs #152)** — `scripts/download-grammars.ts` now downloads bash, c_sharp, css, html, json, lua, ocaml, php, swift, toml, vue, yaml, zig from `tree-sitter-wasms` at install time. All 13 new grammars registered in `TreeSitterClient.LANG_MAP`.

- **C#, PHP, and CSS tree-sitter dispatch rules now active (refs #152)** — the three languages had existing `.scm` rule files that silently never fired because no WASM was loaded and they were absent from the rules runner's `EXT_TO_LANG` / `appliesTo`. Both gaps closed. PL/SQL (9 rules), ABAP (1 rule), and COBOL (2 rules) moved to `-disabled/` subdirectories — no standard tree-sitter WASM exists for these grammars so the rules could not execute.

- **Read expansion and symbol extraction extended to 9 more languages (refs #152)** — `clients/read-expansion.ts` `EXT_TO_LANG` / `ENCLOSING_TYPES` and `clients/tree-sitter-symbol-extractor.ts` `SYMBOL_QUERIES` wired for Java, Kotlin, Dart, Elixir, C, C++ (read expansion + symbols) and C#, PHP, Swift, Lua, OCaml, Zig, Bash (symbols). All use WASMs already downloaded by the grammar expansion above. Node-type names verified against each language's `node-types.json` before use.

- **Tool registration collision guard (closes #106)** — all four `pi.registerTool()` calls in `index.ts` are now wrapped in try/catch. When another extension (e.g. `@narumitw/pi-lsp`) has already registered the same tool name, the collision is caught silently instead of aborting pi-lens extension load.

- **gitleaks runner for cross-language committed-secret detection (closes #130)** — new `clients/gitleaks-client.ts` runs `gitleaks detect --no-git --source <root> --report-format json` at session_start when the project root has any opt-in signal: `.gitleaks.toml` / `.gitleaks.yaml` / `.gitleaks.yml` / `.gitleaksignore`, a `gitleaks`-substring dependency in `package.json`, or a `.husky/` or `.git/hooks/` pre-commit hook referencing gitleaks. Cross-language by design (operates on bytes via regex + entropy, not AST), so a single binary covers every repo we support. Auto-installs from GitHub releases via the existing installer pattern (same shape as `actionlint` / `hadolint` / `tflint` — registered entry at `clients/installer/index.ts`). At turn_end, the cached findings surface as a **blocker** (not advisory) — committed credentials are real production risk and need rotation before merge; the block lists up to 5 findings as `path:line — RULE-ID: description`. Parser handles gitleaks's standard JSON-array report shape with 19 unit tests covering all six opt-in signals, malformed JSON tolerance, missing-required-field skipping (rather than crashing), and lenient coercion of stringified `StartLine` values. Client lifecycle mirrors `KnipClient` / `JscpdClient` / `GovulncheckClient` (in-flight dedupe, off-main-thread session_start invocation via the existing `runTask(setImmediate)` wrapper). Per-edit re-scan is intentionally NOT wired — secrets either are or aren't in a file; the session_start cache is the authoritative source.

- **govulncheck runner for reachable Go CVE detection (closes #132)** — new `clients/govulncheck-client.ts` runs `govulncheck -mode=source -format=json ./...` at session_start when the analysis root contains a `go.mod`. Caches results by project root via `cacheManager.writeCache("govulncheck", ...)`. The advisory surfaces at turn_end via a single `🛡️ Go CVEs reachable from this code` block listing up to 5 findings with `OSV-ID (file:line) — upgrade to vX.Y.Z`, complementary to (not redundant with) trivy: govulncheck reports only CVEs whose vulnerable function is actually called from the build graph, dramatically lower false-positive rate vs. flat dep-CVE scanning. **Auto-installs via `go install golang.org/x/vuln/cmd/govulncheck@latest`** when missing — the `hasGoModule(analysisRoot)` gate guarantees the Go toolchain is available, so leaning on `go install` is honest (same pattern as how rust-clippy works on cargo projects). Falls back to `$GOBIN` / `$GOPATH/bin` / `~/go/bin` lookup when the installed binary isn't on `PATH`. Parser handles govulncheck's informal JSON stream (newline-delimited dominant case, concatenated multi-object lines, malformed-prefix tolerance) with 7 unit tests; client lifecycle mirrors `KnipClient` / `JscpdClient` (in-flight dedupe, off-main-thread session_start invocation via the existing `runTask(setImmediate)` wrapper).

- **Rolling actionable-warnings history** — every actionable warning surfaced at `turn_end` is now appended to `<project-data>/actionable-warnings.jsonl`, parallel to the existing `code-quality-warnings.jsonl`. Captures the fields `worklog.jsonl` drops: stable `aw:<hash>` ID for cross-turn correlation, suppression state, LSP code-action enrichment counts, and origin (dispatch / lsp / merged). Empty reports skip the write. Closes the symmetry gap where code-quality warnings persisted across turns/sessions but actionable warnings did not.
- **NDJSON telemetry for `ast_grep_search` / `ast_grep_replace`** — every invocation of the two agent-facing ast-grep tools now writes a record to `~/.pi-lens/ast-grep-tools.log` capturing pattern (truncated to 500 chars), `patternLineCount` (so single-line vs multi-line analyses are trivial), lang, outcome (`success` / `no_matches` / `error`), and a classified `errorKind` (`multiple_ast_nodes`, `cannot_parse_query`, `tool_not_found`, `timeout`, `json_parse_failed`, `other`). Rotates at 1 MiB. `classifyAstGrepError` recognises both sg-runner's friendly wrappers and the raw underlying stderr, case-insensitive. The data answers: how often do agents hit multi-statement failures? Which language emits which error most? Do retries succeed after the skill is read?

### Performance

- **Actionable-warnings turn-end report reuses dispatch-primed LSP diagnostics** — `buildActionableWarningsReport` was running its own LSP `openFile` + `getDiagnostics` loop per modified file, even though the dispatch pipeline had already run `touchFile` (open + diagnostics-wait + merge) for every modified file earlier in the same turn. The LSP service caches in `lastKnownDiagnostics`, but `getDiagnostics` ignored the cache and always re-spawned clients. New `LspService.getLastKnownDiagnostics(filePath)` returns the cached value without a re-fetch, distinguishing `[]` (cache-hit empty) from `undefined` (cache miss). actionable-warnings checks the cache first and falls through to the slow path only on a true miss. Latency log analysis showed reports >2 s on zero-warning turns dropping from common (63 of 733 in one rotation) to the sub-100 ms floor. `lsp_file_checked` NDJSON gains a `lspSource: "cache" | "fresh"` field so the cache-hit ratio is observable.

### Fixed

- **`oldtext_not_found` messages distinguish content-drift from indentation mismatch (refs #144)** — when the first line of `oldText` is found in the file but the surrounding block no longer matches, the error now explicitly states this is a content-drift failure (not an indentation issue) and that indentation autopatch already ran. Previously both cases produced a generic re-read message; agents wasted retries changing tabs to spaces when the real problem was a 60-line content drift from earlier edits in the same session.

- **LSP diagnostics version guard prevents stale results (refs #150)** — `waitForDiagnostics` now captures a `diagnosticsVersion` baseline immediately before `refreshFile`. Only accepts results when `diagnosticsVersion > baseline`, ensuring a fresh `publishDiagnostics` arrived after the sync. Eliminates false-clean results after rapid sequential edits where the server was still processing an earlier file state.

- **Lazy `codeAction/resolve` before applying code actions (refs #150)** — many LSP servers (rust-analyzer, typescript-language-server) return lightweight code action objects with no `edit` field, only populating it on an explicit `codeAction/resolve` request. Pi-lens now resolves lightweight actions before applying; falls back silently if the server does not support `resolveSupport`.

- **Workspace symbol deduplication (refs #150)** — workspace symbol results deduplicated by `name:containerName:kind:uri:startLine:startCol` before returning. Prevents duplicate entries when multiple LSP servers are active for the same file.

- **Diagnostic noise stripping (refs #150)** — "for further information visit `<url>`" lines and bare URL-only lines stripped from LSP diagnostic messages before they surface in dispatch output. Reduces noise from rust-analyzer/clippy and other servers that embed documentation URLs inline.

- **Workspace edit ordering and overlap detection (refs #150)** — `applyWorkspaceEdit` now flushes all text edits to disk before processing resource operations (create/rename/delete), preventing a rename from moving a file before its content is updated. Overlapping text edit ranges within a single server's response now throw a descriptive error (`"overlapping LSP edits: X conflicts with Y"`) rather than producing corrupted output.

- **README `PILENS_DATA_DIR` description corrected (closes #142)** — the previous description stated the default write location was `<cwd>/.pi-lens/`, which is only true for legacy projects that already have that directory. New installs have always defaulted to `~/.pi-lens/projects/<slug>/`. Added a callout for local model server users (llama.cpp, Ollama) noting that cache-file churn inside the workspace disrupts model context scoring and `PILENS_DATA_DIR` is the fix.

- **ast-grep SKILL.md documents `Multiple AST nodes are detected` failure modes (refs #125 Phase 1)** — added a new gotcha entry covering the two distinct shapes: (1) sequence-in-block — wrap in `{ }` to make it one AST node; (2) cross-context (module-level + block-level in the same pattern) — wrapping is invalid, use two scoped searches or a YAML `inside:`/`has:` rule instead.

- **Widget stop warning storm churn (PR #146)** — `widget-state.ts` now tracks whether each file has received a final diagnostics snapshot (`hasFinalDiagnosticsSnapshot`). The `✓ clean` header is suppressed while any file is pending, and pending files are excluded from the file row list until diagnostics land. Prevents the transient `✓ clean` flash observed on warning-heavy analysis passes in C++ and other multi-runner languages. Stored diagnostics per file capped at 12 while preserving full warning counts in `diagnosticCounts`.

- **jscpd clone detection now runs on non-JS/TS projects, and excludes compiled `dist/` from TS-project scans (closes #126)** — the source-file gate at `JscpdClient.hasSourceFilesRecursive` accepted only JS/TS extensions (commit 8b5d588), making pi-lens's jscpd integration effectively JS/TS-only even though jscpd's underlying tokenizer covers 15+ languages. Pure-Python, pure-Go, pure-Rust, pure-Java, etc. repos got zero clone detection. The gate now recognises every language jscpd tokenizes well: Python, Java, Go, Rust, Ruby, PHP, Swift, Kotlin, Dart, Lua, Scala, C/C++, C#, plus the existing JS/TS set. Gleam / Zig / Fish stay excluded — jscpd has no tokenizer for them. Separately, the session_start call site now auto-detects `isTsProject` via the presence of `tsconfig.json` and passes it to `scan()`, so TS projects with a `dist/` directory of compiled `.js` artifacts no longer flag them as duplicates of their `.ts` sources. The cache scanner key varies by this flag (`"jscpd"` vs `"jscpd-ts"`) so a stale pre-#126 cache invalidates on first read instead of masking the fix.

  *Behaviour note*: a previously-skipped pure-Python / Go / Rust / Java repo now runs a real jscpd scan at session_start (seconds, scaling with file count). The scan is off the main thread via the existing `setImmediate` runTask wrapper, so the TUI is not blocked, and the result caches for subsequent sessions.

- **Read-guard autopatch now registers a synthetic read for the matched line range** — a successful unique-match indent or trailing-ws autopatch (`oldtext_indent_autopatched` / `oldtext_trailing_ws_autopatched`) proves the agent's `oldText` reflects real content at a unique span. Two systems used to disagree about this: the autopatch successfully matched, and 4–5 ms later the read-guard fired `zero_read` because no Read tool event existed for that file. Now the autopatch path registers a synthetic read covering the matched range via `runtime.readGuard.recordRead`, so the downstream guard check has the evidence it needs. Doesn't bypass `file_modified` (orthogonal) or widen coverage beyond the matched span. Fixes the observed pattern of autopatch-then-block on `model-selector.{ts,test.ts}` and any similar future cases.

### Removed

- **Deleted the regex-based `type-safety` runner** — three regex heuristics on raw source text (switch exhaustiveness without `default`, missing `return` in functions with non-void return type, `: any` / `as any`). All three checks are covered better — with real type information — by tools already in the dispatch pipeline: TypeScript LSP catches missing returns with proper control-flow analysis; Biome `noExplicitAny` and ESLint `@typescript-eslint/no-explicit-any` catch `any` usage; ESLint `@typescript-eslint/switch-exhaustiveness-check` is discriminant-type-aware. The regex `:\s*any\b` also matched identifiers like `anything`, `Many`, `Company`, comments, and strings — producing the dominant `type-safety:no-any-type` rule (244 of 404 entries in pi-drykiss's rolling history) with mostly false positives. Other typed languages need no equivalent: we already run their actual compilers / analyzers (pyright + mypy, go-vet + golangci-lint, rust-clippy, javac, cpp-check, dotnet-build, dart-analyze, phpstan, detekt, swiftlint, etc.). The orphan `clients/type-safety-client.ts` (a separate AST-based implementation with zero callers) was deleted alongside.
- **Deleted the state-matrix similarity infrastructure** — the 57×72 AST-kind transition matrix algorithm (`clients/state-matrix.ts`, `clients/amain-types.ts`, `clients/project-index.ts`) and all three of its consumers: the dispatch `similarity` runner, lens-booboo's "Runner 3: semantic similarity (Amain)" all-pairs comparison, and the `index.ts` Phase 7b pre-write inline check. The algorithm captured AST-kind shape distribution — not identifiers, control-flow ordering, data flow, function size, or imports. Two functions with the same kind distribution (e.g. all test functions, all map/filter chains, all early-return guards) scored ~1.0 cosine similarity despite doing completely different things. At the 0.98 threshold all three consumers produced zero observable output across 567 history entries in three active projects; at lower thresholds (~0.95) the same algorithm produced false-positive floods on idiom-shaped code. Refs #128 for the design intent of the eventual rewrite as AST-subtree fingerprinting with review-graph import-overlap gating. booboo's other similarity flow via `clients.astGrep.findSimilarFunctions` is preserved. Session-start cost drops by ~395 ms run + 212 ms queued (the index build/load task is gone).
- **Session_start `project-index` task** — built or loaded the now-deleted state-matrix index on every session start. Pure dead cost without the algorithm; removed.

## [3.8.47] - 2026-06-01

### Added

- **Actionable-warnings ecosystem expansion (closes #112)** — six dispatch runners now propagate `fixable` + a `fixSuggestion` so the actionable-warnings advisory can surface them instead of dropping them into code-quality. rust-clippy and golangci-lint read the structured replacement metadata each tool already publishes (`suggested_replacement` / `Replacement`); sqlfluff, detekt, swiftlint, and dart-analyze use curated allowlists of rules their respective `--fix` / `--auto-correct` / `dart fix --apply` commands rewrite deterministically. oxlint, stylelint, and markdownlint received the same treatment earlier in the cycle. Each slice ships parser-level unit tests against the runner's real output shape.
- **Framework / convention detector foundation (#118 Phases 1 + 2)** — new `clients/project-conventions.ts` exports `detectProjectConventions(cwd)` returning detected `frameworks` (react / next / vite / vitest in the first cut, each with confidence + signals), `testRunners`, `buildTools`, and `agentDocs`. Detection is purely deterministic — no LLM, no spawn — from `package.json` deps, canonical config files, and directory shape. `ProjectSnapshot` gained an optional `conventions` field with explicit-arg → previously-saved → fresh-detect precedence so a snapshot rewrite without conventions inherits rather than blanks.
- **Per-runner timeoutMs overrides the global 30 s default (#107)** — each `RunnerDefinition` may now declare its own `timeoutMs`; the dispatch harness honours it instead of the shared `RUNNER_TIMEOUT_FLOOR_MS`. The floor is also configurable via `pi-lens.runnerTimeoutFloorMs` config and `PI_LENS_RUNNER_TIMEOUT_FLOOR_MS` env, guarded against NaN, and lazy-resolved so tests can reset it.
- **LSP diagnostics-wait cap with env override (#117)** — dispatch LSP wait is now capped at 2.5 s by default to prevent slow language servers from holding edit feedback; tunable via `PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS`. A new `lsp_diagnostics_timeout` phase event and a `diagnosticsTimedOut` flag in the success log surface when the cap fires.
- **Tool-result debounce window (#115)** — `PI_LENS_TOOL_RESULT_DEBOUNCE_MS` (default 0, max 1 s) coalesces sequential tool_results for the same file so burst edits no longer rerun the full pipeline on every keystroke. Off by default; opt-in via env.
- **Custom rules guide + JSON schemas** — new docs and JSON schemas for tree-sitter and ast-grep custom rule authoring, plus tightened agent skill docs for write-ast-grep-rule, write-tree-sitter-rule, ast-grep, and lsp-navigation.
- **Read-guard `oldtext_duplicate` disambiguation** — the first `oldtext_not_found` and every `oldtext_duplicate` now include surrounding line context so the agent can pick the right occurrence without rereading the whole file.

### Performance

- **In-flight dedupe on RuffClient and BiomeClient (#120)** — concurrent first-time callers to `ensureAvailable()` now share a single probe + auto-install promise via `ensureInFlight`, mirroring the pattern that closed #113 for SgRunner. Previously two parallel session-start tasks (one Python, one JS/TS) could each race the `ensureTool()` auto-install branch and produce partial state in `~/.pi-lens/tools`.
- **SgRunner in-flight dedupe (#113)** — concurrent ast-grep `ensureAvailable()` callers now share one probe; the auto-install branch runs at most once across a session.
- **Centralized `~/.pi-lens` and `walkUpDirs` helpers** — every `~/.pi-lens` computation now routes through `getGlobalPiLensDir()` (#122), and the parent-dir walk is consolidated as a `walkUpDirs` generator + `findNearestContaining` helper in `path-utils.ts`. Same behaviour, fewer ad-hoc walks.

### Fixed

- **Cascade reverse-dependency neighbors now use the in-memory index** — the cascade builder was building a reverse-dep index from the review graph, saving it to the project snapshot, then immediately reloading it from disk to compute affected-file neighbors. The reload almost always returned `null` during active editing because the project sequence had advanced past the snapshot sequence, silently discarding the freshly computed data every time. Affected-file queries now run directly against the in-memory index built from the just-completed graph.
- **Tree-sitter rule cache preserves `has_fix` across the roundtrip** — `has_fix` was set on first load but dropped on the cache rehydration path, so cached runs never marked tree-sitter findings as fixable. Restored — the cache now roundtrips the flag end to end.
- **TypeScript LSP starts for pi-extension files when only `~/.pi/agent/package.json` exists (#123)** — root detection now performs a bounded walk to the extension boundary; if no marker is found inside that scope, it falls back to `FileDirRoot` provided the agent-level `package.json` exists, instead of silently giving up.
- **BiomeClient resolves binaries per project cwd, not `process.cwd()` (#121)** — `getBiomeBinary` now accepts a per-call cwd and caches resolved binaries keyed by cwd, so monorepos with sub-package biome installs reach the right binary even when pi-lens was invoked from a different directory.
- **Skip redundant `notify.open` on `touchFile` when content was already pushed within the debounce window (#116)** — split `shouldSkipTouch` from `shouldSkipNotify`; the latter avoids re-opening but still waits for diagnostics so cache invalidation isn't lost. A `notifySkipped` flag in the latency log records when the optimization fires.
- **dispatch runner `--version` probes flow through `createAvailabilityChecker`** — cpp-check is now cwd-keyed and dedupes concurrent first-time callers, eliminating one of the hottest uncached spawn paths in the audit.
- **PILENS_DATA_DIR compliance in actionable-warnings, review-graph, semgrep-config** — these paths now route through `getProjectDataDir(cwd)` instead of hardcoding `.pi-lens/` under cwd, so the data dir override is respected end to end.
- **Read-guard tracks session writes in an explicit Set** — unreliable mtime checks could let a Write→Edit sequence be blocked by a zero-read violation; an explicit per-session write set is the new authoritative signal.
- **Read-guard partial apply routes through post-edit analysis** — when only some `oldText` edits resolve, partial application performs exact replacements and then invokes the normal `handleToolResult` pipeline so staleness stamps, modified ranges, deferred formatting, dispatch diagnostics, cascade, and warning collection stay in sync with disk.
- **Read-guard staleness escalation fires across inter-turn gaps** — `REPEAT_FAILURE_TTL_MS` raised from 30 s to 300 s so repeated stale `oldText` attempts 2–3 minutes apart are still counted as the same streak; at ≥ 2 failures the preflight error is upgraded from `🔄 RETRYABLE` to `🛑 RE-READ REQUIRED`.
- **dart-analyze / detekt drop the dead sync `isAvailable` fallback** — both runners now use only the async availability check, eliminating a dead code path that masked test-mock mismatches.
- **ReDoS hotspots in oxlint rule extraction and cors-wildcard patterns** — bounded the affected regexes; the oxlint fix also backfills `defectClass` on five runners that had been missing it.
- **5 runners that were missing `defectClass`** — backfilled correctness/style/etc. classifications so downstream taxonomy + advisory routing work consistently.

### Widget

- **Quieter widget glyphs and tighter horizontal layout** — warning glyph swapped from triangle to exclamation mark, dispatch findings pack into a single horizontal row at normal widths, the red dot now reflects blocking semantics (not just severity), and the divider/filename header / non-blocking fillers in horizontal mode were dropped.

## [3.8.46] - 2026-05-27

### Added

- **actionlint runner for GitHub Actions workflows** — actionlint is now a dispatch runner for `.github/workflows/*.yml` and `.yaml` files. It runs as its own independently-gated group alongside the existing YAML pipeline (lsp + yamllint fallback), so non-workflow YAML behaviour is unchanged. Auto-installed from GitHub releases with full platform/arch coverage (linux/darwin/win32, amd64 + arm64). Diagnostics map to `blocking`/`correctness` severity with structured IDs. JSON and NDJSON output formats are both handled, with a plain-text fallback diagnostic on non-zero exit.

- **Inter-extension events for lens findings** — pi-lens now emits structured, versioned payloads on the shared `pi.events` bus so companion extensions can react to diagnostics without scraping rendered text or log files. New events include `pi-lens/analysis-complete` for every file analysis, `pi-lens/findings` when diagnostics/fixes are present, and `pi-lens/turn-findings` for aggregated turn-end blockers/advisories. Payloads include telemetry/session metadata, affected files, blockers/warnings/fixed diagnostics, and bounded/truncated text fields.
- **Actionable warning reports (global-config gated)** — experimental `actionableWarnings` config writes `.pi-lens/cache/actionable-warnings.json` at `turn_end` for fixable warnings introduced by the current turn, using stable `aw:<hash>` warning IDs plus `.pi-lens/cache/actionable-warning-state.json` for suppression state. The report merges dispatch `fixable` warnings with optional LSP warning code actions, records auto-fix eligibility/skip reasons, and injects a concise advisory instead of blocker language. `actionableWarnings.autoFix.enabled` can optionally apply conservative preferred edit-only LSP warning quickfixes at `agent_end`; all options default off except `deltaOnly: true`.
- **LSP rename application** — `lsp_navigation` rename now supports `apply: true`, applying returned workspace edits to disk via a shared LSP edit applier. Preview remains the default; applied edits are coalesced per file, executed bottom-up against one snapshot, and overlapping edits are rejected.
- **Code-quality warning reports** — turn-end now writes `.pi-lens/cache/code-quality-warnings.json` for non-fixable code-quality warnings introduced or touched in modified ranges, separate from actionable/autofixable warnings. A concise advisory points agents at the JSON without treating the findings as blockers, and an append-only project history is preserved in `code-quality-warnings.jsonl`.
- **Project change sequencing foundation** — pi-lens now tracks monotonic project/file sequence numbers for observed mutations and appends them to `<project-data-dir>/change-log.jsonl`. Agent writes/edits, partial applies, deferred formatting, and conservative autofixes record their source, session/turn metadata, file sequence, and optional changed range; actionable and code-quality warning reports now include project/file sequence metadata for future stale-report detection.
- **Project intelligence snapshot foundation** — session start now loads a versioned `.pi-lens/cache/project-snapshot.json` when it matches the current project sequence, hydrating cached exports and project rule scan state before background scans finish. Startup scans refresh the snapshot as project rules, ast-grep exports, and project-index metadata become available, creating a shared seq-stamped cache for future reverse-dependency and hot-file features.
- **Reverse-dependency cache/query foundation** — new internal reverse-dependency helpers build `file -> imports` and `file -> importedBy` indexes from the existing review graph, persist them into the project snapshot, reload fresh snapshot-backed indexes, and answer bounded affected-file queries. Cascade graph builds now refresh the snapshot reverse-dependency section, log refresh/load/merge details to `~/.pi-lens/cascade.log`, and merge fresh cached reverse-dependency neighbors into cascade selection.
- **Session-start snapshot telemetry** — session startup now logs project snapshot probe paths, miss reasons, loaded snapshot contents, seeded file-sequence counts, scan-context/profile cache sources, and split queued/run timings for deferred startup tasks so snapshot and startup-cache behavior can be debugged from `~/.pi-lens/sessionstart.log`.

### Performance

- **Deferred format runs concurrently across files at agent_end** — `handleAgentEnd` now dispatches all formatter subprocesses in parallel via `Promise.all` before sequentially flushing results (sequence bumps, cache mutations, LSP resyncs). Sessions with multiple queued files no longer pay N × ~400 ms; all formatters run simultaneously instead of back-to-back.
- **Session startup avoids repeated cold filesystem walks** — project snapshots now persist `startupScan` and `languageProfile` data keyed by project sequence, so `/new` can reuse the prior scan-context and language-profile results instead of re-running two recursive `readdirSync` walks over the same project tree. Startup background scan bodies are also deferred with `setImmediate`, so synchronous tasks such as TODO scanning cannot inflate the interactive `session_start` path before control returns to the TUI.
- **LSP child handles are unreferenced after launch** — LSP subprocess and stdio handles are unref'd once startup succeeds, complementing fast session shutdown so live language servers do not keep Node/Pi alive during Ctrl+C or session replacement flows.
- **Fast LSP shutdown skips the protocol handshake** — `client.shutdown({ fast: true })` now bypasses the `shutdown` request and `exit` notification entirely, disposing the JSON-RPC connection and moving straight to process-tree termination so background teardown does not spend up to one second per client waiting for unresponsive servers. Session-start LSP resets and pipeline-crash recovery now also use fast teardown because both discard old clients rather than preserving graceful LSP state.
- **Debounced disk-flush timers no longer keep Node alive** — probe-cache and metrics-history debounce timers now call `.unref()` like the LSP idle reset timer, so short-lived/teardown paths are not held open just to flush best-effort background history.

### Fixed

- **Cascade reverse-dependency neighbors now use the in-memory index** — the cascade builder was building a reverse-dependency index from the review graph, saving it to the project snapshot, then immediately reloading it from disk to compute affected-file neighbors. The reload almost always returned `null` during active editing because the project sequence had advanced past the snapshot sequence, silently discarding the freshly computed data every time. Affected-file queries now run directly against the in-memory index built from the just-completed graph.

- **Monorepo turn-state bookkeeping uses the workspace root** — write/edit tool results now keep language-specific dispatch cwd separate from workspace-scoped turn-state/change-log cwd, so nested Go/Rust/etc. modules still generate actionable/code-quality warning reports at turn_end. Deferred-format bookkeeping also records project changes and modified ranges under the workspace root rather than the nested language root.

- **Actionable-warning autofix rejects stale reports** — agent-end conservative LSP quickfix application now requires the cached `.pi-lens/cache/actionable-warnings.json` report to match the current project sequence, and also verifies any recorded per-file sequence before applying edits. Stale or pre-sequence reports are skipped with a debug reason instead of applying cached quickfixes against shifted diagnostics.
- **Project snapshots use a consistent root for load and save** — startup snapshot refreshes from project rules, ast-grep exports, and project-index scans are now written to the same resolved snapshot root used for session-start reads, avoiding silent cache misses when the analysis root differs from the initial cwd.

- **Session shutdown no longer waits on graceful LSP teardown** — `/new`, `/resume`, and Ctrl+C now call `resetLSPService({ fast: true })`, which disposes clients, signals LSP processes, and unreferences kill timers/child handles instead of keeping the TUI alive while graceful shutdown or SIGTERM→SIGKILL escalation completes. This targets the common lifecycle path shared by both `/new` and process exit; deferred agent-end formatting remains parallelized for multi-file turns but is not the primary shutdown path. Relates to #103.

- **TypeScript LSP no longer blocks the edit pipeline on loose Pi extension files** — dispatch LSP diagnostics now use the bounded `touchFile` document path instead of opening the file and then waiting on unbounded aggregate diagnostics, preventing cold TypeScript server startup from holding the TUI until the generic 30s runner timeout. TypeScript LSP root detection also skips loose files under `.pi/agent/extensions` unless a real JS/TS project marker exists inside that extension tree, avoiding tsserver walks through global Pi/npm dependency paths for tiny extension edits. Fixes #104.

- **Read-guard downgrades `out_of_range` to warning when `oldText` resolved** — when the model's `oldText` was found in the current file (content-verified), an edit touching lines outside the recorded read ranges is now warned rather than blocked. Line drift from earlier edits in the same session is the most common cause; the model demonstrably knew the content it was replacing, so a hard block is a false positive. The `oldTextResolved` flag is surfaced in verdict telemetry for observability.

- **Read-guard Pass 1 autopatch now also strips trailing empty lines from `oldText`** — the model sometimes includes the indentation of the next line at the end of `oldText` (e.g. `}) as any,\n\t\t\t\t`). After per-line `trimEnd` that trailing indentation became an empty line, so the joined string still ended with `\n` and failed to match. The fix pops any trailing empty lines from the split array before rejoining. Pass 1 is now guarded by exact raw matching: it only patches when the original raw `oldText` does not match and the stripped raw candidate matches exactly once. When trailing empty lines are removed from `oldText`, the equivalent suffix is removed from `newText` so the replacement span is preserved.

- **Actionable-warnings pipeline now emits structured NDJSON telemetry** — a new `actionable-warnings-logger.ts` writes NDJSON events to `~/.pi-lens/actionable-warnings.log` (rotating at 1 MiB) covering the full advisory pipeline: `report_started` (files/warnings in scope), `lsp_file_checked` per file (diag counts, delta-filter counts, enriched counts), `lsp_file_skipped` for unsupported or erroring files, `report_complete` (final summary), `advisory_injected` / `advisory_skipped` (whether the advisory actually reached model context). Test mode suppresses all writes.

- **Read-guard partial apply now routes through post-edit analysis** — when only some oldText edits resolve, partial application now performs exact replacements only and then invokes the normal `handleToolResult` pipeline/bookkeeping path. This keeps read-guard staleness stamps, modified ranges, deferred formatting, dispatch diagnostics, cascade, and warning collection in sync with the disk mutation.

- **Read-guard stale-oldText escalation now fires across inter-turn gaps** — `REPEAT_FAILURE_TTL_MS` raised from 30 s to 300 s so repeated stale `oldText` attempts made 2–3 minutes apart are still counted as the same failure streak. At ≥ 2 failures the preflight error is upgraded from `🔄 RETRYABLE` to `🛑 RE-READ REQUIRED` with an explicit instruction not to retry from memory.

- **Workspace edit partial-application now surfaces a clear error** — `applyWorkspaceEdit` applies file edits and file-system operations sequentially; if one fails mid-way, previously written files are not rolled back. The error now lists every file already written before the failure so callers can diagnose the inconsistency. When no files had been written yet, the original error is re-thrown unchanged.
- **Actionable-warnings autofix logs when its cache is absent** — `agent_end` now emits a debug message when `actionableAutofixEnabled` is true but the `actionable-warnings` cache entry is missing or expired, instead of silently skipping fixes.

- **Read-guard no longer blocks edits to files the agent just created** — when a `write` tool creates a new file, pi-lens now registers a synthetic read covering the full written content, so an immediately following `edit` on the same file is not blocked by a zero-read violation. The agent authored the content, so the guard invariant holds. The pre-write `isNewFile` check gates the synthetic read to genuinely new files only.
- **Trailing whitespace in `oldText` is auto-patched before the edit lands** — editors and formatters strip trailing whitespace on save; if the model copies content that had it, the edit tool can fail to match. pi-lens now strips trailing whitespace from each line of `oldText` (and updates `event.input` in-place) when the stripped version matches exactly one location. Runs as a first pass before indentation correction so both normalizations compose cleanly.
- **Read snapshot hash coverage raised from 1 000 to 3 000 lines** — reads larger than the old cap produced `unavailable` snapshot status, downgrading validation to range-only. The FNV-1a hash cost for 3 000 lines is sub-millisecond; the limit remains overridable via `PI_LENS_READ_GUARD_HASH_MAX_LINES`.

- **Indentation autopatch no longer produces mixed indentation in nested `newText`** — `retargetReplacementIndentation` now extends the indentation map to cover deeper nesting levels not present in `oldText` by resolving any indent as `n × baseUnit → n × correctedUnit`. Previously, lines at depths beyond what appeared in `oldText` were left with the agent's original (wrong) style while shallower lines were remapped, producing mixed indentation in replaced blocks that introduced new conditional or loop nesting. If any non-blank line's indentation cannot be resolved as a multiple of the base unit, retargeting is now aborted entirely rather than applied partially.
- **Indentation correction reads the file once instead of three times** — the autopatch path previously called `readFileSync` three times per `oldText` entry (once in `tryCorrectIndentationMismatch`, twice in `countOldTextMatches`). A single read now derives both the CRLF-normalised form (used by the correction logic) and the trailing-whitespace-trimmed form (used by occurrence counting). `resolveOldTextEdits` in `read-guard-tool-lines.ts` also no longer re-reads a file it already holds.

- **Read-guard snapshot validation now blocks stale covered ranges** — touched edit ranges with hash-checkable prior reads are rejected when the current file lines no longer match what the agent saw. Hash-unavailable cases still fall back to existing range coverage to avoid false blocks, while unrelated line changes outside the edited range no longer cause file-modified false positives.
- **Read-guard preflight blocks now emit structured telemetry** — unresolved native `edit` targets now log `edit_preflight_blocked` with `reasonKind`, failed edit indexes, resolution counts, and oldText previews, making exact-text failures distinguishable from later read-range verdicts.
- **Safe indentation-only edit retries preserve replacement indentation** — when pi-lens auto-patches an `edit` call's tab/space-only `oldText` mismatch, it now also retargets leading whitespace in the paired `newText` using the same indentation mapping. Successful tab-vs-space retries no longer introduce mixed indentation in the edited block.
- **Read-guard snapshot telemetry no longer mixes candidate states** — snapshot-validation events now clear stale `missingLines` when a later candidate produces a real mismatch, so `mismatch` telemetry no longer reports lines as both missing and mismatched.
- **Safe indentation-only edit retries are auto-patched** — when an `edit` call's `oldText` differs only by leading tabs/spaces and the corrected text matches exactly one location, pi-lens now mutates the tool input before execution instead of blocking with a visually lossy retry instruction. Ambiguous or non-indentation-only corrections still block and require a re-read.
- **Read-guard snapshot validation and retry guidance** — edit preflight now validates captured `oldText` snapshots against current file content, reports structured snapshot-validation events, and gives clearer retryable indentation-mismatch guidance with corrected `oldText` candidates. This reduces false blocks from stale reads while steering agents to retry exact tab/space corrections instead of improvising.
- **Path normalization avoids regex hotspots** — slash normalization in ignore/path matching no longer relies on regex replacement patterns that static analyzers flagged as potential hotspots.
- **Project scans now respect `.gitignore` and generated artifacts** — centralized project ignore matching now supports rooted patterns (`/profiles/`), globbed trees (`profiles/**`), nested `.gitignore` files, and negations, and is shared by source collection, startup counting, jscpd, tree-sitter collection, review-graph workspace module scans, autofix snapshots, ast-grep temp scans, `/lens-booboo` ast-grep scan globs, and write/read hook paths. pi-lens now skips gitignored files before LSP warming or dispatching the pipeline, and generated/artifact detection is centralized for common codegen dirs, protobuf/sqlc/OpenAPI outputs, minified/bundled files, declaration stubs, and generated-file headers. Also avoids source-scanning `$HOME` during session start when startup gating has already classified the cwd as `home-dir`. Refs #91.
- **Review graph has hard safety caps for large projects** — review-graph construction now goes through the shared project scan policy, skips files above the configured size limit, and bails out with a logged `too_many_files` skip instead of parsing thousands of files on the hook path. Defaults are 1,000 source files and 1 MiB per file, with `PI_LENS_REVIEW_GRAPH_MAX_FILES` / `PI_LENS_REVIEW_GRAPH_MAX_FILE_BYTES` overrides for exceptional projects.

## [3.8.45] - 2026-05-21

### Added

- **Markdown section read expansion** — `tryExpandRead` now expands partial reads in `.md` and `.mdx` files to the full enclosing heading section (from the `## Heading` at or before the read anchor to the next heading of same or higher level). No tree-sitter is needed; expansion is synchronous and stays within the existing `EXPANDED_SIZE_CAP_LINES` (300) and `EXPANSION_LIMIT_LINES` (60) guards. Populates `enclosingSymbol` with `kind: "markdown_section"` and the heading text as the symbol name, giving the read guard precise section-level coverage instead of the previous blanket `.md` exemption.

- **pi-lens log smell analyzer** — new `npm run logs:smells` script scans pi-lens telemetry across all projects where the extension was active (`latency.log`, `sessionstart.log`, `cascade.log`, `read-guard.log`, `tree-sitter.log`, and daily diagnostic JSONL logs), grouping operational smells such as slow hook paths, runner failures, LSP availability noise, cascade fallback/slowness, and read-guard friction.
- **LSP batch diagnostics and document symbol search** — `lsp_diagnostics` now accepts explicit `filePaths` batches with bounded concurrency (`concurrency`, default 8/max 16) and optional `waitMs`, so agents can validate exactly the files they touched without scanning a directory. `lsp_navigation` adds `operation: "findSymbol"` for filtered document-symbol lookup by `query`, `kinds`, `exactMatch`, `topLevelOnly`, and `maxResults`.
- **Review-graph feature hints and source grouping helpers** — review graph file/symbol metadata now includes deterministic `featureKind` and `trustBoundaries` hints derived from names/paths, and `source-groups.ts` can partition large source sets into stable labeled groups for context planning.
- **Global user config at `~/.pi-lens/config.json`** — pi-lens now reads persistent user preferences from the same global directory used for logs/probe state. Initial settings cover `widget.visible` (hide the diagnostics widget by default; fixes #84) and `format.enabled` / `format.mode` (`"immediate"` to format after each write/edit instead of waiting for `agent_end`; fixes #61). CLI flags still override global config.
- **10 new C blocker tree-sitter rules** — implements SonarCloud C blocker rules via AST queries:
  - `memset-sensitive-data` (S5798) — `memset` on passwords/secrets (optimized away by compilers)
  - `noreturn-returns` (S5267) — `return` inside `__attribute__((noreturn))` functions
  - `no-octal-literals` (S1314) — octal literals like `010`
  - `no-reserved-identifiers` (S978) — `_Upper` or `__` identifiers
  - `no-stdlib-name-as-id` (S6936) — shadowing `malloc`, `printf`, etc.
  - `no-bit-fields` (S2806) — `int x : 4;` bit-field declarations
  - `no-redundant-pointer-ops` (S3491) — `*&x` and `&*p` no-ops
  - `no-pointer-arithmetic-array-access` (S3729) — `*(arr + i)` instead of `arr[i]`
  - `c-hardcoded-secrets` (S6418) — hard-coded API keys/passwords in strings
  - `non-case-label-in-switch` (S1219) — regular labels inside `switch` bodies
- **5 new C post-filters** — `c_memset_sensitive_arg`, `c_stdlib_name`, `c_octal_literal`, `c_noreturn_attr`, `c_label_in_switch` added to `applyPostFilter` in `tree-sitter-client.ts`.
- **C tree-sitter tests** — `tests/clients/tree-sitter-c-rules.test.ts` with 10 passing tests.
- **C/C++ tree-sitter runner and cascade support** ([#83](https://github.com/apmantza/pi-lens/pull/83)) — `cxx` files (`.c`, `.h`, `.cpp`, `.cc`, `.hpp`, etc.) are now fully wired through the dispatch pipeline: tree-sitter structural analysis, review-graph construction with `#include` edge extraction, blast-radius entity snapshots, and cascade neighbor propagation. `cpp-check` runner enhanced with `clang-tidy` support. `language-profile.ts` adds C/C++-specific complexity baselines.
- **Vale prose linter runner** — new `vale` dispatch runner for Markdown files. Config-gated (requires `.vale.ini`); auto-install disabled (uses PATH). Parses `--output=JSON` into pi-lens diagnostics with severity mapping. Covers prose/style quality alongside `spellcheck` and `markdownlint`.
- **SwiftLint runner** — new `swiftlint` dispatch runner for Swift files. Runs out of the box with built-in defaults (no config required). Auto-installs via GitHub release (macOS portable zip, Linux amd64/arm64). Uses `--reporter json` output. Swift dispatch now has LSP + SwiftLint + swiftformat.

### Changed

- **`.md` / `.mdx` no longer auto-format with prettier defaults when the project has no prettier config.** Closes [#89](https://github.com/apmantza/pi-lens/issues/89) via [#90](https://github.com/apmantza/pi-lens/pull/90). Prettier's defaults reflow lines, normalize emphasis markers (`*` → `_`), and restyle lists, producing noisy diffs on doc-only writes. The smart-default gate still runs prettier when an explicit project config (`.prettierrc`, `prettier` field in `package.json`, etc.) is present — flip is on the no-config path only. To restore prior behaviour, add an empty `.prettierrc` (or any explicit prettier config) to the project root.
- **README accuracy fixes** — corrected Python LSP label (pyright/basedpyright + jedi), bumped formatter count 26→27→32 (added oxfmt, fish_indent, google-java-format, cljfmt, cmake-format, psscriptanalyzer-format), fixed read-guard markdown exemption text, added `/lens-allow-edit` to key commands, bumped language coverage 35→36+ (added Fish, Svelte, Vue rows), added `tree-sitter` to C/C++ dispatch, added `detekt` to Kotlin dispatch, added formatters to Java/Clojure/CMake/PowerShell rows, added `vale` to Markdown row, added `swiftlint` to Swift row.

- **`.md` read-guard exemption tightened from `allow` to `warn`** — markdown files are no longer silently exempt from the read-before-edit guard. With the new markdown-section expansion providing precise heading-level coverage, edits outside the expanded read range trigger a warning instead of passing unchecked. Plain-text (`.txt`) and log (`.log`) files remain exempt.

- **Module-level dependency graph for monorepo cascade** — `buildModuleGraph` (new `clients/review-graph/workspace-modules.ts`) scans workspace manifests (`pnpm-workspace.yaml`, `package.json` workspaces, `Cargo.toml` `[workspace]`, `go.work`) and builds a module dependency graph with transitive downstream BFS. `computeImpactCascade` now expands the blast radius to include source files from downstream dependent packages when an edited file belongs to a workspace module. Cache cleared on `resetDispatchBaselines`.

- **LSP `references` for symbol-level blast radius** — when `changedSymbols` are detected in a file, `computeCascadeForFile` now calls LSP `references` for up to 3 changed symbols (with a 750ms timeout per symbol, 1200ms hard ceiling) to find the true call-site blast radius. Reference files are merged into `impact.neighborFiles`, giving cascade precision beyond coarse file-level import edges. Falls back silently to import-graph neighbors on timeout or LSP error.

- **Test suggestions for cascade neighbors** — `TestRunnerClient` gained `suggestTestFiles()` and `handleTurnEnd` now appends a "Likely tests for affected neighbors" section to the cascade output when cascade neighbors have diagnostics. Extends the existing test-discovery patterns (basename, `__tests__`, `tests/`, import-scan fallback) to affected neighbor files, capped at 5 suggestions.

- **Content-hash staleness detection for ReadGuard** — read records now capture per-line content hashes for the effective read range (capped by `PI_LENS_READ_GUARD_HASH_MAX_LINES`, default 1000). When file mtime changes but the relevant read lines still hash-match, ReadGuard treats the context as fresh and avoids false `file_modified` blocks from no-op formatting/touching. Semantic line changes still block and require a re-read.

### Fixed

- **ESLint LSP activation is config-gated for JS packages** — ESLint language-server startup now requires a real ESLint signal (config file, `eslintConfig`, or an `eslint` package dependency) instead of treating any `package.json` as enough. Plain JS packages without ESLint no longer spend the LSP timeout trying to start `vscode-eslint-language-server`, and nested packages without ESLint no longer inherit a parent repo ESLint config by accident. Closes #86.

- **SonarCloud regex hotspot in workspace scanner** — replaced `workspace-modules.ts` multi-line manifest regexes with linear line scanners for `pnpm-workspace.yaml` and Cargo TOML sections/arrays, avoiding super-linear regex hotspot reports while preserving monorepo module detection.

- **Agent guidance now promotes active LSP diagnostics and ast-grep retries** — session-start guidance and shipped skills now direct agents to use `lsp_diagnostics` for proactive file/folder/batch validation, keep `lsp_navigation` for code intelligence, and retry `ast_grep_search` once with a simpler valid AST pattern before falling back to grep. `ast_grep_search` tool docs now describe `selector` correctly as a node-kind filter rather than an extraction mechanism.
- **Startup language detection avoids fixture/tooling false positives** — plain Git repositories no longer count as configured C/C++ projects just because `.git` exists, and Ruby startup tooling now requires real Ruby project markers (`Gemfile`/`Rakefile`) before preinstalling RuboCop. This avoids noisy C++/RuboCop probes in JS/TS projects and fixture-only repos.
- **Missing direct LSP commands are negatively cached** — direct language-server commands such as `clangd` are now skipped for a short TTL after a clear command-missing failure, preventing repeated spawn attempts across multiple roots/files while still allowing later installs to be picked up.
- **Review graph cache supports incremental changed-file updates** — cascade graph construction now persists per-file signatures and updates the cached graph when only the edited file changed, instead of rebuilding the entire project graph on every write. Cascade remains synchronous in the existing lifecycle; the fix reduces hot-path cost without moving work to `turn_end`.
- **Generated files are skipped by dispatch** — dispatch context now classifies file roles from path/content prefixes and bypasses runners for generated files, avoiding noisy lint/security findings on protobuf/sqlc/generated artifacts. Generated-file detection covers common Go/Python outputs such as `.pb.go`, `_sqlc.go`, `_pb2.py`, and `_pb2_grpc.py`.
- **Disabled tree-sitter rules leaked into production dispatch/cache** — disabled query directories are now keyed under their base language for test access but filtered from production dispatch with cross-platform path-segment checks. Rule-cache entries now preserve `filePath`, cached disabled rules are defensively filtered, and the tree-sitter rule-cache version was bumped to invalidate stale `ts-path-traversal` cache entries from `typescript-disabled/`.
- **Knip scans bounded to real project roots** ([#81](https://github.com/apmantza/pi-lens/pull/81)) — Knip was running against arbitrary working directories (including `/tmp` or parent dirs without `package.json`), producing nonsensical unused-export reports or crashing on missing configs. `KnipClient` now validates the project root with `findProjectRoot()` before scanning, and `turn_end` Knip delta analysis bails early when the root lacks a recognizable package manifest. Prevents false-positive unused-export noise and config-not-found errors.
- **ReDoS in C/C++ include parsing** — `review-graph/builder.ts` used a regex with `[^>]*` to parse `#include <...>` directives, which SonarCloud flagged as S5852 (polynomial backtracking on malicious input). Replaced with a linear manual parser that scans character-by-character.
- **3 existing C rule post-filters were broken** — `case-range-multiple-values`, `goto-into-block`, and `goto-label-order` referenced post-filters (`case_range_single_value`, `goto_targets_inner_block`, `goto_jumps_backward`) that didn't exist in `applyPostFilter`, causing them to silently pass all matches. All three are now implemented. The `case-range-multiple-values` rule was moved to `c-disabled/` because the C grammar lacks `range_expression`.

- **LSP unavailable states are now explicit instead of false-clean** — `lsp_diagnostics` reports when no language-server client is ready (including candidate server IDs and stale-diagnostic state) rather than returning "No diagnostics found". C/C++ startup failures now point users at `clangd`/LLVM instead of the bogus `cpp-language-server` npm hint. Repeatedly failing server/root pairs are truly session-disabled after the permanent-failure threshold, client wait timeouts only log on real timeouts, and read-warm logs distinguish successful warms from no-client unavailability.

- **Entity snapshot extended for Rust and Ruby** — Rust now tracks `trait_item` (critical: changing a trait breaks all implementors and should always trigger blast-radius) and `type_item` (type aliases). Ruby now tracks `singleton_method` (`def self.foo` class-level methods were silently missed). Go and Python had no critical gaps. Inspired by repomix tree-sitter query coverage.

- **Entity snapshot now tracks arrow functions, interfaces, type aliases, and enums for blast-radius triggering** — `ENTITY_QUERIES` previously only detected `function_declaration`, `class_declaration`, and `method_definition`. In modern TypeScript/JavaScript codebases most "functions" are arrow functions (`const foo = () => {}`), so edits to them never triggered blast-radius analysis. Added `entity-jsts-arrow` (covers both arrow functions and function expressions), `entity-ts-interface`, `entity-ts-type`, and `entity-ts-enum` to complete the picture. Shared TS/JS queries factored into `JSTS_SHARED_ENTITY_QUERIES` and TypeScript-only structural types into `TS_STRUCTURAL_ENTITY_QUERIES` — class declaration remains the only language-specific entry (TS uses `type_identifier`, JS uses `identifier`). Blast-radius mechanism unchanged; it operates on language-agnostic `kind:name` keys. Inspired by repomix tree-sitter query coverage.

- **Runner diagnostics now captured in latency log** — each `type: "runner"` entry now includes a `diagnostics` array (rule, message truncated to 120 chars, line, semantic) when the runner produces findings. Previously only `diagnosticCount` was logged, making it impossible to trace which runner+rule produced a specific diagnostic (e.g. a false-positive blocker) without a live debugger. Relates to #78.

- **`isSgAvailableAsync()` replaces sync `isSgAvailable()` in dispatch hot path** — `python-slop` runner was calling `isSgAvailable()` on every invocation, which on first call runs multiple `safeSpawn` probes (local bins, PATH, npx) blocking the event loop. Added `probeAstGrepCommandAsync` and `isSgAvailableAsync` with an in-flight deduplication guard; `python-slop` now awaits the async version. Shared module-level cache (`sgAvailable`, `sgCmd`, `sgCmdArgs`) means subsequent calls return immediately regardless of which path ran first. Sync `isSgAvailable` retained for `SgRunner.isAvailable()` legacy compat.

- **`SgRunner.tempScan` is now async (`tempScanAsync`)** — the live production path `scanExports` → `runTempScan` → `tempScan` was blocking the Node event loop during background session startup scans. Added `tempScanAsync` using `safeSpawnAsync` and wired it through `AstGrepClient.runTempScanAsync` and `scanExports`/`findSimilarFunctions`. Sync `tempScan` retained for test compatibility per AGENTS.md legacy-cleanup contract.

- **`rust-clippy` and `go-vet` runners now use platform-aware binary resolution** — both runners were calling `"cargo"` / `"go"` as bare command names, relying on PATH. On Windows, `cargo` lives in `~/.cargo/bin/cargo.exe` and `go` in `C:\Program Files\Go\bin\go.exe` — locations not always on the shell PATH when pi-lens launches from an IDE. The runners now use `RustClient.findCargoPath()` and `GoClient.findGoPath()` respectively, which probe known install locations before falling back to PATH. Both path-finder methods are made public. `GoClient` and `RustClient` module-level singletons are shared across runner invocations so the path is resolved and cached once per session.

### Changed

- **Pyright / basedpyright reinstated as default Python LSP** — `PythonServer` re-added to `LSP_SERVERS` before `PythonJediServer` (jedi remains as fallback). The 5–14 s cold-start that caused the original removal is fixed by passing `openFilesOnly: true` in LSP initialization options, switching pyright to lazy per-file analysis rather than full workspace analysis on startup. `basedpyright-langserver` added as a candidate alongside `pyright-langserver` — same `--stdio` protocol, drop-in compatible. Deep type checking via standalone pyright CLI and mypy runners is unchanged. Strategy key renamed from orphaned `"pyright"` to `"python"` to match `PythonServer.id`. Closes #80; shipped via [#82](https://github.com/apmantza/pi-lens/pull/82).

## [3.8.44] - 2026-05-13

### Added

- **`fish` FileKind with `fish_indent` formatter runner** — `.fish` files are now a first-class `"fish"` kind rather than being bucketed under `"shell"`. A new `fish-indent` runner wraps `fish_indent --check` (fish ≥ 3.6), reporting a formatting warning with a `fish_indent -w` fix hint on exit 1 and a blocking parse-error diagnostic when stderr is non-empty. Formatter and linter policy entries added for `.fish` in `tool-policy.ts`; fish dispatch group `[lsp, fish-indent]` wired in `language-policy.ts`. Closes #74.

### Fixed

- **Linux `sg` command no longer breaks `ast_grep_search` / `ast_grep_replace`** — ast-grep resolution now prefers the canonical `ast-grep` binary and only accepts `sg` when `--version` proves it is ast-grep, avoiding the util-linux `/usr/bin/sg` group-switch command. The installer, probe cache, tool availability, sync runner helpers, and Python slop scan now share the corrected command shape and `npx --no -- ast-grep` fallback. Closes #75.
- **`return-in-generator` no longer flags normal `async def` coroutine returns** — added a Python tree-sitter post-filter that keeps only synchronous functions containing `yield`, skips `async def`, and rejects non-generator functions. Added regression tests for valued generator returns, coroutine returns, and normal functions. Closes #76.
- **`python-sql-injection` no longer flags safe SQLAlchemy expression execution** — the rule now captures the call receiver and the post-filter skips likely SQLAlchemy ORM session receivers (`session.execute(stmt)`) plus expression-builder calls such as `conn.execute(select(...).where(...))`, while still flagging raw `cursor.execute(sql)` and composed SQL strings. Closes #77.
- **Formatter tests no longer depend on a real global Ruff install** — the Ruff global fallback test now uses an isolated PATH shim, making it deterministic on machines without Ruff installed.

- **`psscriptanalyzer` runner could hang indefinitely** — `spawnPs` had no timeout; if `pwsh` or `Invoke-ScriptAnalyzer` stalled on a large file the turn would block forever. Added a 30s timeout with SIGTERM → 1s → SIGKILL escalation. `shell: false` means `child.pid` is the actual `pwsh` process so `child.kill()` hits the right target directly (no `taskkill` needed).

- **`turn_end` hangs ~40–50s on Windows when knip times out** — `safeSpawnAsync` used `child.kill("SIGTERM/SIGKILL")` to terminate timed-out processes. On Windows with `shell: true`, `child.pid` is the `cmd.exe` wrapper; killing it orphans the actual subprocess (e.g. knip/npx node process) which then runs unsupervised until it naturally exits. Replaced with `taskkill /F /T /PID` on Windows, which kills the full process tree rooted at `cmd.exe`, matching the approach already used in `lsp/client.ts`.

- **`fish` missing from `LANGUAGE_CAPABILITY_MATRIX` and `LintRunnerName`** — adding the `"fish"` FileKind required two exhaustiveness fixes: a `fish` entry in `plan.ts`'s `Record<FileKind, CapabilityMatrixEntry>` and `"fish-indent"` in the `LintRunnerName` union in `tool-policy.ts`; both caused build/type-check failures on CI.
- **shellcheck and shfmt no longer fire on `.fish` files** — `.fish` was classified as `"shell"`, causing both runners (which use `appliesTo: ["shell"]`) to process fish scripts with `--shell bash`, producing false-positive SC1073/SC1064 parse errors. Moving `.fish` to the new `"fish"` kind fixes the routing with no special-case logic in either runner. Closes #74.

- **`lsp_diagnostics` tool** — proactive LSP error checking for files and directories. The agent can now run `lsp_diagnostics({ filePath: "src/" })` before builds to catch issues without making edits. Directory mode walks the tree (skipping node_modules/.git/target), auto-detects the language extension, opens each file in the LSP client, and aggregates diagnostics. Supports severity filtering (`error`/`warning`/`information`/`hint`/`all`), caps at 50 files and 200 diagnostics. Returns structured details with `totalDiagnostics`, `truncated`, and per-diagnostic `file`/`line`/`severity`/`message`/`source`/`code`. Adapted from `code-yeongyu/pi-lsp-client`.
- **LSP process stderr capture and health check** — the LSP client now maintains a rolling 100-line stderr buffer from server startup through shutdown. Three new client methods exposed: `processExited()` (true if the server process died), `recentStderr(n)` (last N lines for diagnostics), and `checkAlive()` (pre-request health check returning error string with exit code + stderr tail if dead). Previously, stderr was only captured during initialization and discarded afterward.
- **SIGTERM → 1.5s → SIGKILL escalation in `killProcessTree`** — on Unix, process cleanup now sends SIGTERM first, waits 1.5 seconds, then sends SIGKILL if the process is still alive. Prevents zombie server processes that survive a standard kill. Windows already uses `taskkill /F /T` (force kill tree).
- **LSP force-reinstall when PATH-resolved tool is broken** — when an LSP server's PATH candidate fails to launch (e.g. broken symlink, missing runtime, corrupted binary) AND the managed install returns the same broken PATH entry, pi-lens now clears the probe cache, downloads a managed copy from the registry (npm/GitHub/pip), and retries the launch. Previously, broken PATH tools triggered exponential backoff and were permanently disabled after 5 failures. The retry only fires when the `ensureTool` path is a bare command name (no `/` or `\` separators) — absolute paths from prior managed installs are not force-reinstalled to avoid redundant download loops. `ensureTool` gained an optional `forceReinstall` flag that bypasses both the in-memory `resolvedPathCache` and the persistent probe cache.
- **`getToolPath` prefers managed installs over PATH for github-strategy tools** — github-strategy tools (`rust-analyzer`, `shellcheck`, `shfmt`, `golangci-lint`) now check `~/.pi-lens/bin/` before falling through to PATH lookup. This ensures force-reinstall flows find the newly downloaded binary, and pi-lens-managed copies take priority over potentially stale or broken PATH entries. Non-github tools (npm, pip) are unaffected.
- **Pattern hints for `ast_grep_search` zero-match results** — when a search returns no matches, the tool now appends a hint suggesting likely pattern mistakes: regex misuse (`\w`, `\d`, `[a-z]`, `.*`, `.+`, `|` alternation), language-specific mistakes (Python trailing colons, incomplete JS/Go/Rust function patterns). Adapted from `code-yeongyu/pi-ast-grep`.
- **Truncation metadata in ast-grep tool results** — `SgResult` now carries `totalMatches` and `truncated` fields, threaded through `SgRunner` → `AstGrepClient` → both `ast_grep_search` and `ast_grep_replace` tool `details`. The agent can now distinguish "50 shown of 500 total" from "50 total".

### Changed

- **Runner process execution is async/non-blocking across hook paths** — jscpd scans, Madge dependency checks, formatter execution, and dispatch runners that previously used sync `safeSpawn()` now use `safeSpawnAsync()` in write/session/turn hooks. Added in-flight guards for jscpd and Madge project/file scans, async availability checks in runner helpers, and Knip availability dedupe + project-root bail before install/probe.
- **`isCommandAvailable` replaced `which`/`where` spawn with PATH walk + `statSync` size validation** — instead of spawning `which`/`where` (~50 ms + timeout risk), the installer now walks `$PATH` entries synchronously and checks `statSync(path).isFile() && stat.size > 0` for each candidate. This catches broken symlinks (stat throws `ENOENT` or returns size 0) at ~μs per candidate with zero process spawns. On Windows, `.exe`, `.cmd`, and `.bat` extensions are probed.

### Fixed

- **SonarCloud security hotspots resolved** — replaced the .NET build diagnostic regex with a linear manual parser to avoid ReDoS risk (S5852), and switched jscpd temporary directory creation from a `Math.random()` suffix to `fs.mkdtempSync()` to avoid weak PRNG use (S2245).
- **ast-grep tool language list aligned with ast-grep CLI** — dropped phantom `dart` and `sql` (not supported by ast-grep binary), added missing `bash`, `nix`, `solidity`. The `LANGUAGES` constant in `tools/shared.ts` now matches ast-grep v0.41's official 25-language list.
- **Graph-cache test: disk cache leaked across test runs** — `buildOrUpdateGraph` persists to `cwd/.pi-lens/cache/review-graph.json`. All tests used hardcoded `"/cwd"`, causing the first test run's disk cache to contaminate subsequent runs. Switched to `fs.mkdtempSync` temp directories with `afterEach` cleanup.
- **Disabled tree-sitter rules leaked into production** — `parseQueryFile` uses the YAML's `language:` field over the directory name, so rules in `typescript-disabled/` with `language: typescript` were loaded as active TypeScript rules and appeared in the diagnostics widget. Added `!d.name.endsWith("-disabled")` filter to `loadQueries` directory enumeration.

## [3.8.43] - 2026-05-10

### Added

- **Unresolved inline blocker re-surfacing at turn_end** — when the agent ignores a blocking diagnostic shown during a write/edit and moves to the next turn without fixing it, the blocker now reappears in the turn_end injection framed as `"Unresolved from this turn — <file>: 🔴 STOP…"`. Previously, unresolved inline blockers were silently lost until cascade happened to re-touch the same file via an importer. `RuntimeCoordinator` tracks the last-seen blocking output per file (`_pendingInlineBlockers`); a subsequent write that produces no blockers clears the entry, so only genuinely unresolved issues resurface. The map is cleared at `beginTurn` to prevent cross-turn contamination.
- **S1219 (switch non-case labels) and S2970 (incomplete assertions) blocking tree-sitter rules** — S1219 detects labeled statements inside switch cases in TypeScript (SonarCloud S1219); S2970 detects Jest/Vitest `expect()` chains that are never called (e.g. `expect(x).toBe(y)` without `await`), with Chai property assertion exclusion. S2083 (path traversal) moved to disabled — regex heuristics on tree-sitter syntax are the wrong layer; needs taint/data-flow analysis. Adds `parent?` field to `TreeSitterNode` interface.
- **Inline code snippets in blocker output** — each 🔴 STOP diagnostic now includes the exact source line the agent wrote that caused the violation, so the agent can identify and fix the issue without re-reading the file. `fixSuggestion` is also surfaced inline when present. Snippet capped at 120 chars.
- **AST node type and matched text in blocker output** — tree-sitter diagnostics now carry `matchedText` (the exact matched node, more precise than the full source line) and `astNodeType` (e.g. `call_expression`, `template_string`). The agent sees: `L12: SQL query built with string interpolation (template_string) → db.query(...)`.
- **Persist review graph to disk** — `_workspaceGraphCache` is now backed by `.pi-lens/cache/review-graph.json`. On cold start, if source file signatures match the stored cache, the full 2–4 s tree-sitter + import-fact build is skipped (~20 ms JSON parse + `rebuildIndexes` instead). Write is fire-and-forget, never blocks dispatch.
- **Preserve last known LSP diagnostics when LSP goes inactive** — when no live clients are available (dead client respawning, circuit-breaker cooldown), `getDiagnostics` now returns the last non-empty result for that file instead of `[]`. The widget keeps showing the last known issues rather than going blank mid-session. Live clients returning `[]` clears the stale entry. Stale hits are logged as `failureKind: "no_clients_stale"`.

### Fixed

- **Read-guard false-positive block on files outside the project root** — edits to files outside `projectRoot` (e.g. `C:/llama/*.bat`, scripts in arbitrary directories) were always blocked with `zero_read` because reads for external files are intentionally not recorded (`isExternalOrVendor` gate in the read handler), but the `checkEdit` call had no matching guard. Added `!isExternalOrVendor` to the `checkEdit` condition so external files bypass the read-guard entirely, consistent with how reads are handled.

### Changed

- **Replace pyright-langserver and pylsp with jedi-language-server for Python LSP** — `PythonServer` (pyright-langserver) and `PythonPylspServer` (pylsp) removed from `LSP_SERVERS`; replaced by `PythonJediServer` which spawns `jedi-language-server`. pyright-langserver was causing 5–14 s cold-start delays on large Python projects (e.g. tinygrad) because it performs full workspace analysis on startup; jedi starts in ~200–500 ms via lazy per-file analysis. pylsp was removed because it consistently returned 0 diagnostics (no venv → jedi can't resolve imports; 1500 ms aggregate timeout hit on warm runs). Deep type checking is unaffected — the standalone `pyright` CLI runner and `mypy` runner continue to run in parallel. Added `"python-jedi"` strategy entry (`seedFirstPush: true`, `aggregateWaitMs: 1000`). Wall-clock gate for Python dispatch shifts from LSP (~5–14 s) to mypy (~3.5 s).

## [3.8.42] - 2026-05-08

### Added

- **Fact-rules wired into all language dispatch plans** — the `fact-rules` runner was registered but never listed in any `RunnerGroup`; 20 TypeScript FactRule instances (`corsWildcardRule`, `jwtWithoutVerifyRule`, `dynamicRegexpRule`, `errorObscuringRule`, `highComplexityRule`, etc.) were never executing. Added `mode:all fact-rules` group to jsts, python, go, rust, ruby, cmake, and shell write plans.
- **3 fact-rules promoted to blocking (inline at write time):** `cors-wildcard` (CORS `*` origin — no ast-grep/tree-sitter equivalent), `error-swallowing` (empty catch — smarter than the disabled tree-sitter `empty-catch`, skips fs-boundary and documented fallbacks), `no-commented-credentials` (credentials in commented code — complementary to ast-grep which covers live code). `high-entropy-string` was already blocking.
- **Fact-rule false-positive reductions:** `no-boolean-params` now exempts names with `*Only`/`*Enabled`/`*Disabled` suffixes, `allow*`/`skip*`/`needs*`/`auto*` prefixes, and `_`-prefixed params. `duplicate-string-literal` SKIP_STRINGS expanded with DSL discriminators (`types`, `fallback`, `direct`, `all`, `mode`, `source`) and infrastructure strings (`github`, `rubocop`, `arm64`). `high-import-coupling` threshold raised 10→15 and exempts `index.ts`/`integration.ts` registry/hub files. `no-commented-credentials` exempts scanner/fixture files.
- **Severity alignment for 3 existing TS tree-sitter blocking rules** — `ts-command-injection`, `ts-ssrf`, `unsafe-regex` had `inline_tier: blocking` but `severity: warning`, producing `semantic: "warning"` which is never shown inline. Fixed to `severity: error` → `semantic: "blocking"` → actually surfaces to the agent.
- **Fixed `inline_tier: error` typo** on `ts-hallucinated-react-import` and `python-hallucinated-import` (→ `blocking`).
- **13 new high-confidence blocking promotions across 5 languages** (all `severity: error`, `inline_tier: blocking`):
  - *TypeScript:* `ts-weak-hash` (`createHash("md5"/"sha1")` — confidence: high)
  - *Python:* `python-command-injection`, `python-sql-injection`, `python-insecure-deserialization`, `python-weak-hash`
  - *Go:* `go-command-injection`, `go-sql-injection`, `go-shared-map-write-goroutine`, `go-weak-hash`
  - *Ruby:* `ruby-weak-hash`
  - *Rust:* `rust-lock-held-across-await`
- **4 new blocking tree-sitter rules (SonarCloud BLOCKER equivalents)**:
  - `ts-xss-dom-sink` (S5696) — flags dynamic values assigned to `innerHTML`/`outerHTML` or passed to `document.write()` / `document.writeln()`
  - `ts-dynamic-require` (S5335) — flags `require()` called with a non-string-literal argument (arbitrary module loading)
  - `ts-open-redirect` (S6105) — flags `res.redirect(variable)` / `response.redirect` / `ctx.redirect` with dynamic URL, and `window.location.href = variable`
  - `ts-nosql-injection` (S5147) — flags any MongoDB `$where` key (JS-execution sink, dangerous regardless of value)
- **2 existing security rules promoted to `inline_tier: blocking`** — `ts-command-injection` (maps to SonarCloud S2076) and `ts-ssrf` (maps to S5146) were previously `warning`; now block the agent turn on detection.

### Fixed

- **`fact-rules` `RuleCache` blind to built-in rule changes** — the cache hash only covered project-local rule files; for any project with no local `rules/` directory the hash was a constant, so new pi-lens built-in rules were silently ignored after the first run. Fixed by including both project-local files and `resolvePackagePath()`-resolved built-in files in the hash, with a `Set` to deduplicate when pi-lens analyzes itself.

### Changed

- **`max-switch-cases` threshold raised 30→40** — `applyPostFilter` dispatch table now has 31 cases and is expected to grow; the old threshold triggered a false positive on pi-lens itself.
- **Package scope migration** — all `@mariozechner/*` import references updated to `@earendil-works/*` following the repo move to `earendil-works/pi-mono`. `@earendil-works/pi-tui` dependency bumped to `^0.74.0`.
- **Startup: `lsp-config` phase is now fully fire-and-forget** — `loadLSPConfig` and `igniteWarmFiles` no longer block the interactive path, removing ~1s from session start on Windows (previously dominated by sequential ENOENT `readFile` calls walking the directory tree to find a config file).
- **Startup: persistent tool probe cache** — `ensureTool` now checks `~/.pi-lens/probe-cache.json` before falling back to the full `verifyToolBinary` process spawn. Cache entries are validated with `fs.access` + mtime check and expire after 24 h; stale or missing entries fall through to the full probe and update the cache on success.

### Added

- **Startup observability** — `checkProbeCache` now logs the reason for each cache miss (`ttl expired`, `gone`, `mtime changed`); the lsp-config fire-and-forget callback logs how many warm files were configured once the config resolves asynchronously.

### Added

- **Test runner: import-based fallback discovery** — when basename pattern lookup finds no test file for a modified source file (e.g. `cline.test.ts` for `cline-auth.ts`), the runner now scans `tests/`, `__tests__/`, and the source file's own directory for any `*.test.*` file whose content references the source basename in an import path. Fixes the silent `no test file found` for files whose test is named after a module rather than the source file.
- **Test runner: prefer local `node_modules/.bin` binary over `npx`** — `vitest` and `jest` now resolve the project-local binary (`node_modules/.bin/vitest.cmd` on Windows, `node_modules/.bin/vitest` on Unix) before falling back to `npx`, saving ~150ms of startup overhead per test run.
- **Turn-end test runner logging** — `turn_end` now logs the outcome of every test run: `turn_end: test vitest util.test.ts → PASS 8p/0f (412ms)` or `FAIL 2p/8f (930ms)`. Stale results (turn advanced while tests ran) are logged with a `[stale]` prefix instead of being silently discarded. All-pass turns are no longer silent.
- **Per-file test target logging** — `turn_end` now logs which test file was resolved for each modified source file, or `no test file found` when none matched. Previously silent; impossible to distinguish "runner disabled" from "no test found".
- **Session-scoped turn-end dedup** — `turn-end-findings-last` now stores the current session ID alongside the content signature. Identical findings from a previous session are no longer suppressed — each new session sees its blockers fresh. Same-session dedup continues to work as before.
- **Cross-session turn state eviction** — turn state (modified file ranges) now carries the session ID set at first edit. If `turn_end` reads a turn state written by a different session, it evicts it immediately and logs `turn_end: evicting stale turn state (session X ≠ current Y)`, preventing stale cross-session file lists from triggering jscpd, madge, or test runs.

### Changed

- **Context injections framed as automated checks** — all three `consume*` injections (`turn-end findings`, `test findings`, `session guidance`) now prefix their content with `[pi-lens automated check — not a user request]` so the agent cannot mistake a hook-injected message for a direct user command. Advisory sections additionally carry `ℹ️ Advisory — no action required this turn:` before their content; blockers (🔴) continue to require action.

- **`/lens-widget-toggle` command** — toggles the pi-lens diagnostics widget below the editor on/off for the current session, so users can reclaim footer/editor space without disabling pi-lens analysis.

### Changed

- **Removed per-turn jscpd scans** — jscpd remains in the session-start project scan, but no longer runs unconditionally at `turn_end`; inline structural-similarity checks cover the high-value duplicate-code signal during active edits without the repeated multi-second clone scan.
- **Cascade avoids low-value work** — unsupported graph kinds now skip review-graph construction and go straight to passive LSP fallback diagnostics, and neighbor files that recently returned clean can skip repeated active LSP touches for a few turns unless the passive snapshot already contains fresh errors.
- **Knip now surfaces unused-export regressions** — newly unused exports in modified files are shown as advisory end-of-turn findings when they were absent from the previous Knip cache.

### Fixed

- **Knip latency log now includes result metadata** — the `turn_end` Knip phase previously logged only duration with empty `metadata: {}`, making it impossible to distinguish a clean run from a silent failure. It now logs `success`, `totalIssues`, `newIssues`, `blockerIssues`, and `skipped` when the startup scan is still in flight.

- **LSP timeout log now includes `serverIds`** — `lsp_client_wait_timeout` previously only recorded `maxWaitMs`, making it impossible to identify which server consistently failed to respond within the budget. The event now includes the array of server IDs that were being waited on.

- **Vendor/third-party files excluded from cascade neighbor analysis** — `isExternalOrVendorFile()` previously only checked `node_modules`; it now checks every path segment against `vendor`, `vendors`, `third_party`, and `third-party` as well. Cascade neighbor discovery and fallback neighbor injection both skip files inside these directories, preventing vendored dependency diagnostics from surfacing in cascade output.

- **`lens-booboo` hangs on repos with large vendored trees (fixes #57)** — `collectSourceFiles` and the `sg scan` runner in `lens-booboo` now exclude `vendor/`, `third_party/`, `third-party/`, and `vendors/` by default (added to `EXCLUDED_DIRS`). Additionally, `readGitignoreDirs()` reads the root `.gitignore` and extracts simple directory-name entries (bare names and `name/` patterns — no wildcards, negations, or internal slashes), merging them into the exclusion list for `collectSourceFiles` and the `sg scan` glob arguments. This covers project-specific large dirs (e.g. `my-upstream/`) without requiring full gitignore-spec compliance.

## [3.8.41] - 2026-05-05

### Fixed

- **tree-sitter wasm abort loop and memory leak (fixes #56)** — when the emscripten wasm runtime aborts (OOM or assertion failure on large workspaces), the module-level heap is permanently corrupted. pi-lens was re-invoking the dead runtime on every subsequent file write, printing `Aborted()` to stderr on each query and leaking memory on each retry. Added a module-level `_wasmAborted` flag: the first abort detected in the query catch loop poisons the singleton and prevents any further tree-sitter calls for the session. The runner skips cleanly with `reason: wasm_aborted_fatal` logged to `tree-sitter.log`.
- **`turn_end` phases now instrumented in latency log** — `handleTurnEnd` previously had no `logLatency` calls; all timing data was buried in plain-text `dbg()` lines in `sessionstart.log`. Added per-phase latency entries for `cascade_merge`, `jscpd`, `knip`, and `madge`, plus a `tool_result` total with `fileCount` and `blockerSections`. This gives a baseline for measuring the cost of future turn_end additions (e.g. LSP re-query).
- **Cascade ran graph build on non-code files** — markdown, YAML, JSON, and other files without a dispatchable kind were reaching `buildOrUpdateGraph`, causing cold graph builds that took up to 3–4 seconds per write with zero useful output. `computeCascadeForFile` now exits immediately with `cascade_skip / non_code_file` when `detectFileKind` returns `undefined`, consistent with the existing `shouldDispatch` gate used by the lint pipeline.

### Added

- **Per-server LSP diagnostic strategies** — new `clients/lsp/server-strategies.ts` codifies known server behavior (TypeScript, rust-analyzer, pyright, ESLint) so timing decisions are automatic rather than one-size-fits-all. Strategies control first-push seeding, debounce window, pull retry budget, aggregate wait timeout, and whether a server benefits from a semantic second pull pass. Env var overrides (`PI_LENS_LSP_*`) take precedence. Unknown servers get a conservative default.
- **Result-aware diagnostic racing (`raceToCompletion`)** — new `clients/lsp/aggregation.ts` replaces the simple `Promise.race` + grace window pattern with a result-quality-aware aggregator. The grace window only triggers when at least one client has returned non-empty diagnostics, preventing premature resolution when the fastest client returns empty (e.g., TypeScript's syntactic pass). Document mode uses 0ms grace; full mode keeps the 400ms default.
- **`seedFirstPush` early-exit for clean files** — `raceToCompletion`'s completion predicate now also fires when a `seedFirstPush` server (TypeScript, ESLint) returns any result, even an empty one. These servers' first push is authoritative — waiting further yields nothing. Cuts clean-file diagnostic latency from ~1000ms to ~450ms in full mode and to near-zero in document mode (cascade neighbor touches).

- **`/lens-toggle` session switch** — added a single command to toggle pi-lens on/off at runtime without restarting pi. When off, write/edit analysis, read-guard, formatting, cascade, turn-end checks, and context injection are paused; running `/lens-toggle` again resumes them. `--no-lens` starts a session in the disabled state. Closes #49.
- **Experimental Semgrep CLI dispatch integration** — added a config-gated `semgrep` dispatch runner that normalizes Semgrep JSON findings into pi-lens diagnostics. The runner never auto-installs Semgrep and only runs when a local `.semgrep.yml`/`.semgrep.yaml`/`semgrep.yml`/`semgrep.yaml` is discovered or when explicitly configured with `--lens-semgrep --lens-semgrep-config <auto|p/pack|path>` / `/lens-semgrep enable --config <...>`. Dispatch scans pass `--metrics=off`; local rule scans do not require a Semgrep token, while Semgrep AppSec/Pro/managed configs may require `semgrep login` or `SEMGREP_APP_TOKEN`.
- **`/lens-semgrep` command** — new project command for managing Semgrep dispatch: `status` shows CLI/config/effective state, `init` writes a starter `.semgrep.yml` and enables dispatch, `enable [--config <auto|p/pack|path>]` persists activation in `.pi-lens/semgrep.json`, `disable` persists opt-out, and `clear` removes the pi-lens Semgrep config to return to local-config auto-discovery.
- **Semgrep severity policy metadata** — Semgrep rules can opt into pi-lens blocking semantics with metadata such as `metadata.pi-lens.semantic: blocking` and `metadata.pi-lens.defect_class: injection`. Otherwise, pi-lens promotes only high-signal Semgrep `ERROR` findings in security defect classes (`injection`, `secrets`, `safety`) to blockers and leaves other findings as warnings.
- **Experimental terminal dashboard** — `--lens-dashboard` / `PI_LENS_DASHBOARD=1` streams redacted session telemetry to a per-session JSONL file (`~/.pi-lens/dashboard-events/{sessionId}.jsonl`) and opens a live terminal dashboard. The dashboard shows the working folder, detected languages, formatter/linter activity, LSP servers spawned, diagnostics grouped by file with OSC-8 clickable links, and a session-start summary of languages, tools, configs, and autoinstalls. Each session gets its own event file; old files are pruned after 7 days (configurable via `PI_LENS_DASHBOARD_RETENTION_DAYS`). Use `PI_LENS_DASHBOARD_LOG_ONLY=1` to emit JSONL without opening a terminal. The viewer auto-scrolls to the latest content on each render.

### Changed

- **LSP diagnostic pipeline latency optimization** — six targeted refactors reduce per-file diagnostic wait times by 50–900ms depending on the language server: first-push seeding skips the debounce timer for TypeScript and ESLint (~150–200ms saved); adaptive debounce computes remaining wait from `pushDiagnosticTimestamps` (50–140ms saved); per-server aggregate wait times (1000ms for TypeScript, 3000ms for rust-analyzer, 1500ms default); semantic settle pass gated to rust-analyzer only; pull retry budget zeroed for TypeScript/ESLint. Global constants `DIAGNOSTICS_DEBOUNCE_MS`, `PULL_DIAGNOSTICS_RETRY_BUDGET_MS`, and `DIAGNOSTICS_AGGREGATE_WAIT_MS` replaced by per-server strategy values from the new `server-strategies.ts`.

### Fixed

- **Cascade neighbor touch cache ignores `writeSeq` on hit** — the A5 neighbor touch cache checked only `turnSeq` on cache hits, so a neighbor diagnosed at writeSeq=1 was served stale results when a second file write (writeSeq=2) cascaded to the same neighbor in the same turn. Fixed by requiring both `turnSeq` and `writeSeq` to match before using the cached entry.
- **Cascade fallback neighbors include other primary files** — `appendFallbackNeighbors` (the degraded-LSP path) excluded only the current primary file from the passive diagnostic snapshot sweep, but not other files edited as primary this turn. Those files could appear as cascade neighbors even though their own pipeline run is the authoritative diagnostic source. Fixed by adding a `primaryFilesThisTurn` check consistent with the B10 filter in the main neighbor path.

- **Semgrep dispatch plan regression** — kept the experimental Semgrep runner out of static `TOOL_PLANS` exposure and appends it only at runtime when Semgrep is actually configured. Fixes CI regressions in plan-shape tests while preserving config-gated Semgrep dispatch.
- **Widget theme method binding crash** — `renderWidget` now calls `theme.fg(...)` directly instead of destructuring `fg`, preserving the `this` binding required by pi's `Theme` class. Fixes the `Cannot read properties of undefined (reading 'fgColors')` widget render crash. Closes #53.
- **Read-guard follow-up edits after own writes** — tuned `file_modified` handling so a file changed by the agent's own prior allowed edit, immediate format, autofix, or deferred `agent_end` formatting does not force a redundant re-read when the next edit is still within already-read ranges. The guard still blocks zero-read and out-of-range edits, and external/stale changes outside the own-edit grace window remain protected. `PI_LENS_READ_GUARD_OWN_EDIT_GRACE_MS` controls the default 120s grace window.
- **Read-guard log noise and growth** — `~/.pi-lens/read-guard.log` now defaults to block/warn/anomaly events instead of logging every read and allowed edit. Verbose logging is available with `PI_LENS_READ_GUARD_VERBOSE=1` or `PI_LENS_READ_GUARD_LOG=verbose`; allowed-edit logging can be restored with `PI_LENS_READ_GUARD_LOG_ALLOWS=1`. The log now rotates at 1MB by default (`PI_LENS_READ_GUARD_MAX_BYTES`).
- **Pipelines skipped for external and vendor files** — agents reading dependency source (global npm packages, project-local `node_modules`) previously triggered LSP server spawns, tree-sitter read-range expansion, read-guard recording, and complexity baseline capture on those files — all noise with no diagnostic value. Added `isExternalOrVendorFile()` (built on the existing `isUnderDir` helper for correct Windows case handling) and gated all five pipeline paths: LSP auto-touch, tree-sitter expansion, read-guard recording, complexity baseline, and the full dispatch pipeline on write/edit.
- **Security: absolute paths for `cmd.exe` and `osascript` spawn calls** — dashboard terminal launch now resolves both executables via `process.env.SystemRoot` / absolute macOS path instead of relying on `PATH`, eliminating the SonarCloud S4036 PATH-injection finding.
- **Security: installed binary permissions tightened** — `chmod` calls on downloaded tool binaries changed from `0o755` to `0o750`, removing world-execute permission (SonarCloud S2612). GitHub Actions `contents: write` permission moved from workflow level to the `release` job only (S8233).
- **Agent messages: full-file-read options removed** — read-guard block messages no longer offer "read the full file" as an alternative. The out-of-range block now presents only the pre-computed targeted `offset`/`limit`; the zero-read block gives a single imperative directive. "Re-read the file" fallback text in ambiguous-edit messages replaced with "Re-read the relevant section" throughout.
- **Agent messages: indentation-mismatch RETRYABLE made explicitly directive** — the block now opens with "Retry the same edit call immediately with the corrected oldText shown below — copy it exactly as-is" and labels each corrected entry with "do not shorten, do not change newText", preventing agents from improvising instead of copying the corrected text verbatim.
- **SonarCloud reliability fixes** — five `.sort()` calls on string arrays given explicit `localeCompare` comparators (S2871); three identical-branch conditionals collapsed (S3923 in `knip-client.ts`, `shellcheck.ts`, `production-readiness.ts`); emoji character class converted to alternation to handle multi-codepoint variation-selector emojis (S5868); regex alternation precedence made explicit with non-capturing groups (S5850); `| 0` in hash function annotated as intentional 32-bit truncation (S7767).
- **CI: build step added before tests** — Vitest's native ESM resolver requires compiled `.js` output when `vi.resetModules()` is used; without a prior `tsc` build, imports of newly-added exports resolved as `undefined` in CI.
- **Widget: diagnostic rows exceeded terminal width** — the custom `truncate()` helper stripped ANSI sequences to measure length but sliced the raw string, losing OSC-8 hyperlinks and SGR sequences from the count. Replaced with pi-tui's `truncateToWidth()` / `visibleWidth()` which correctly account for all escape sequences. All widget lines (header, file rows, separators, diagnostic detail, LSP status) are now clamped. Closes #54.
- **Widget: file list capped at 5 entries, basename deduplication** — reduced max file rows from 6 to 5 to keep the widget compact. Added basename deduplication (last write wins) so that different files with the same name (e.g. `pi-lens/index.ts` and `pi-webaio/index.ts`) show as a single merged entry instead of flooding the widget with near-identical labels.

## [3.8.40] - 2026-05-04

### Added

- **60+ SonarCloud BLOCKER tree-sitter rules** — comprehensive BLOCKER severity rules across 13 languages:
  - **Java (11 rules)**: no-exit-methods, no-threads-in-constructors, switch-fall-through, no-wait-notify-on-thread, no-double-checked-locking, no-future-keywords, no-field-shadowing, junit-call-super, no-octal-values, short-circuit-logic, infinite-loop, infinite-recursion, name-capitalization-conflict, mockito-initialized, resources-closed, unnecessary-bit-ops-java
  - **TypeScript (5 rules)**: infinite-loop, self-assignment, duplicate-function-arg, empty-switch-case, default-not-last, switch-case-termination
  - **JavaScript (1 rule)**: switch-case-termination-js (replaces switch-fall-through-js)
  - **PL/SQL (7 rules)**: forallsave-exceptions, not-null-initialization, end-loop-semicolon, raise-application-error-codes, no-synchronize, lock-table, nchar-nvarchar2-bytes, delete-update-where, fetch-bulk-collect-limit
  - **Python (8 rules)**: send-file-mimetype, no-super-torchscript, return-in-init, yield-return-outside-function, notimplemented-boolean-context, exit-signature-check, return-in-generator, iter-return-iterator, in-operator-unsupported
  - **C++ (5 rules)**: unnecessary-bit-ops, noexcept-functions, no-auto-ptr, no-memset-sensitive-data, no-scoped-lock-without-args, no-confused-move-forward
  - **PHP (2 rules)**: this-in-static-context, no-exit-die
  - **C (3 rules)**: case-range-multiple-values, goto-label-order, goto-into-block
  - **C# (5 rules)**: is-with-this, no-operator-eq-reference, no-dangerous-get-handle, no-thread-resume-suspend, async-await-identifiers
  - **Kotlin (1 rule)**: prepared-statement-indices
  - **ABAP (1 rule)**: delete-where
  - **COBOL (2 rules)**: alter-statement, lock-table-cobol
  - **CSS (1 rule)**: calc-spacing
- **rule-catalog.json** updated with all 60+ new rule registrations

### Fixed

- **Read-guard: false `file_modified` blocks after own edits** — `ReadGuard` was blocking the second edit to a file because the model's first write changed the file's mtime, making `FileTime.hasChanged()` return `true` on the next `checkEdit`. Added `recordWritten(filePath)` to `ReadGuard` and wired it into the `tool_result` handler (post-write, file already on disk), so the FileTime stamp stays in sync with the model's own writes. Eliminates the spurious `file_modified` blocks that appeared on every multi-edit file in a session.

- **LSP: parallel-turn root-resolution timeouts** — `NearestRoot` performed a fresh `fs.stat` directory walk on every call with no caching. When Claude Code edited multiple files simultaneously (e.g. a 4-file turn), all pipelines raced `NearestRoot` concurrently, saturating Windows filesystem I/O and triggering the 750ms `lsp_client_wait_timeout` on all but the first. `NearestRoot` now maintains per-instance result and in-flight caches keyed by resolved directory: successful roots are cached for the session lifetime; concurrent calls for the same directory share one walk promise. Only successful roots are cached so a `package.json` created mid-session is still detected on the next call.

- **Memory: `lastAnalyzedStateByFile` cleared each turn** — module-level Map in `runtime-tool-result.ts` accumulated dead entries across turns (entries from previous turns can never match the new `turnIndex`). Now cleared at `turn_start` alongside `runtime.beginTurn()`, keeping the map bounded to files touched in the current turn only. (refs #50)
- **Memory: `recentTouches` stale entry eviction** — `LSPService.recentTouches` grew unboundedly across a session with one entry per unique file path. Entries older than `TOUCH_DEBOUNCE_MS` are already ignored by `shouldSkipTouch`; a threshold-based sweep (triggered when size > 200) now removes them. (refs #50)
- **Memory: orphaned LSP child processes on Windows** — `clientShutdown` only called `process.kill()` which on Windows terminates the direct child but leaves grandchildren (e.g. `tsserver.js`) as orphaned OS processes each holding 300–600MB. Both the normal shutdown and crash paths now go through a shared `killProcessTree` helper: on Windows it runs `taskkill /F /T` via absolute `SystemRoot` path and awaits completion before returning; on other platforms it sends `SIGTERM`. The SIGKILL fallback timer is also skipped on Windows since `taskkill /F` already force-terminates. (refs #50)
- **Memory: file-time session state not cleared on session reset** — `clearAllSessions()` from `file-time.ts` is now called during `handleSessionStart`, clearing stale file timestamp state that previously accumulated across session switches. (refs #50)
- **Memory: pending ast-grep warn timers not cancelled on session reset** — `resetDispatchBaselines()` left active `astGrepWarnDebounceTimers` running into a cleared session context. Now explicitly cancelled and cleared on reset. (refs #50)
- **Security: `taskkill` spawned via absolute path** — both the normal shutdown and crash paths now resolve `taskkill.exe` through `process.env.SystemRoot` instead of relying on PATH, eliminating the SonarCloud PATH-injection hotspot.
- **LSP: shutdown cannot hang indefinitely** — `client.shutdown()` now bounds the graceful `shutdown` request and proceeds to `exit`/process-tree kill if a server stops responding.
- **LSP: test cleanup stop helper hardened on Windows** — `stopLSP()` now uses the absolute `taskkill.exe` path, handles already-exited processes, and avoids orphaning grandchildren by killing the process tree before the direct child on Windows.

- **booboo project root detection** — `resolveProjectRoot` now walks up to the nearest ancestor with a root marker (`package.json`, `tsconfig.json`, `.git`, etc.), then falls back to walking down one level if exactly one immediate subdirectory has a root marker. Fixes scans running against the wrong directory in nested-project layouts (e.g. `pi-models/pi-models/`).

- **Switch-case false positives eliminated** — replaced naive `switch-fall-through` rules with `switch-case-termination` rules that properly recognize `return`, `throw`, and `continue` as valid case terminators. Reduced false positive hits from 174 to 0.
- **Self-assignment false positives fixed** — changed from `post_filter: same_identifier` to inline `#eq?` predicate so `wave = nextWave` is no longer flagged as self-assignment

## [3.8.39] - 2026-05-02

### Fixed

- **Context injection now prepends guidance before the user prompt** — pi-lens previously appended session guidance after the user's message; provider bridges that treat the last message as the active user action would demote the real request. Guidance is now prepended so the user's prompt stays last. (PR #48 by @tifandotme)
- **jscpd no longer runs on YAML/JSON/Markdown files** — `getFilesForJscpd` now filters to source code extensions only, preventing multi-second delays at `turn_end` when editing rule YAMLs or config files.
- **ReDoS S5852 final (gleam/zig parsers)** — rewrote `gleamRe` and `zigRe` as line-by-line parsers, eliminating the multiline flag that SonarCloud continued to flag despite `[ \t]*` substitution.
- **SonarCloud MAJOR code smells (batch 1 & 2)** — `readonly` members, `void` operator removals, nested ternaries, nested template literals, optional chains, duplicate branches, and redundant type alias across 15+ files.
- **Type-narrow `severityMap` for `Diagnostic.severity` union** — properly satisfies the union type for diagnostic severity mapping.
- **9 tree-sitter query bugs in new rule files** — predicate outside outermost parens (`cpp/no-auto-ptr`); false-positive `post_filter` gate added (`cpp/no-confused-move-forward`); leaf-node child match removed (`php/this-in-static-context`); invalid node name `class_hereditary` replaced (`java/no-field-shadowing`); field order corrected (`java/no-wait-notify-on-thread`); duplicate `modifiers` blocks merged (`java/spring-session-attributes-setcomplete`); invalid anonymous-node field label removed (`csharp/is-with-this`); inline alternation replaced with two patterns (`python/in-operator-unsupported`); adjacent sibling requirement removed, delegated to `post_filter` (`python/return-in-generator`).

## [3.8.38] - 2026-05-02

### Added

- **`RuleCache` respects `PILENS_DATA_DIR`** — tree-sitter rule cache files are now stored under `getProjectDataDir(rootDir)` instead of `<cwd>/.pi-lens/cache`, consistent with all other pi-lens data files. Projects using `PILENS_DATA_DIR` no longer get a stray `.pi-lens` directory created in the project root. (PR #47 by @tifandotme)

### Fixed

- **ReDoS: `gleamRe` and `zigRe` compiler parsers** — residual `\s*` quantifiers (which match `\n` in JS) replaced with `[ \t]*` to eliminate cross-line backtracking. Completes the SonarCloud S5852 remediation started in 3.8.37.
- **Test env leak in `file-utils.test.ts`** — `PILENS_DATA_DIR` is now saved and restored in a `finally` block so it doesn't bleed into subsequent tests in the suite.

## [3.8.37] - 2026-05-02

### Fixed

- **ReDoS: 3 compiler output parsers in `/lens-booboo`** — `csRe` trailing optional group `(?:\s+\[[^\]]+\])?` dropped (message capture already stops at `[`); `gleamRe` narrowed `[^:]+` → `[^:\n]+` to prevent cross-line backtracking; `zigRe` replaced `(.+)$` with `([^\n]+)` and dropped the redundant end anchor. All three flagged by SonarCloud S5852.

## [3.8.36] - 2026-05-02

### Changed

- **`agent_end` deferred format notification now lists filenames** — the notification now reads `pi-lens deferred format applied to N file(s): foo.ts, bar.ts` instead of just the count, making it immediately clear which files were reformatted without needing to check logs.

### Added

- **Deferred formatting by default** — files touched by `write` and `edit` are now queued and formatted once at `agent_end` instead of immediately after each edit. This prevents mid-task formatting mutations from invalidating read-guard context and interrupting multi-edit flows. Formatting still runs in real time when `--immediate-format` is passed.
- **`agent_end` lifecycle handler** — new `clients/runtime-agent-end.ts` drains the deferred format queue at the end of each agent turn, runs the formatter once per file, syncs formatted content to LSP, and emits a concise notification.
- **`--immediate-format` flag** — opt-in flag to restore the legacy per-edit formatting behavior.
- **`/lens-health` session timestamp** — output now opens with `Session started: HH:MM (Xh Ym ago)` so all session-scoped counters have clear time context.
- **`/lens-health` LSP status section** — shows each currently running language server with a `✓`/`✗` connected indicator and workspace root. Makes dead servers immediately visible to the agent without needing to check logs. Also fixes `LSPService.getStatus()` which previously hardcoded `connected: true` instead of calling `isAlive()`.
- **`/lens-health` cascade summary** — shows session-total cascade runs, diagnostics surfaced, and cold-snapshot touches (the new active-touch fallback for TypeScript neighbors with no snapshot).
- **`/lens-health` i18n** — localizes status labels with English fallback; es, fr, and pt-BR strings included (PR #45 by @jerryfan).
- **`/lens-booboo` language gates** — Knip (dead code), Madge (circular deps), and type coverage now skip on non-JS/TS projects. Compiler checks extended with Java (mvn/gradle), C# (dotnet build), Dart, Gleam, Zig, and Elixir alongside the existing TypeScript, Go, Rust, Ruby, and Python checks.
- **`project-metadata` detects 8 new languages** — Java, Kotlin, C#, Dart, Gleam, Zig, Elixir, and C++ are now detected from their project markers (pom.xml, build.gradle.kts, \*.sln, pubspec.yaml, gleam.toml, build.zig, mix.exs, CMakeLists.txt). All runners and booboo language gates now work correctly for these languages.
- **4 new formatters** — `google-java-format` (config-gated via `.editorconfig` or `.google-java-format`), `cljfmt` (config-gated via `.cljfmt.edn`), `cmake-format` (config-gated via `.cmake-format`), and `PSScriptAnalyzer` formatter for PowerShell (smart-default when PSScriptAnalyzer module is available).
- **Startup pre-install defaults for shell, Ruby, Kotlin, TOML** — `shellcheck`, `rubocop`, `ktlint`, and `taplo` are now pre-installed fire-and-forget at session start for matching projects, consistent with the existing pattern for `typescript-language-server`, `biome`, `pyright`, `ruff`, `yamllint`, and `sqlfluff`. No latency impact — all installs are fire-and-forget and no-ops when already cached.

### Fixed

- **Installer race condition** — coalesced the entire `ensureTool()` operation (not just the install phase) to prevent duplicate concurrent "auto-install ensure X: start" probes when multiple tools race to resolve the same binary.
- **Read-expansion union bug** — tree-sitter read expansion now returns the union of the requested range and the enclosing symbol range, instead of silently dropping originally requested prefix/suffix lines. Fixes false "Edit outside read range" blocks when an agent reads a partial range inside a large symbol.
- **Startup probe deduplication** — removed broad eager probes for biome, ast-grep, ruff, knip, jscpd, and madge at session start. Replaced with `scheduleDeferredToolProbes()` which only probes tools not already covered by preinstall or startup scans, scoped to the project's actual language profile.
- **ReDoS-safe compiler output parsers in `/lens-booboo`** — five regex patterns in the compiler checks (Maven, Gradle, .NET, Gleam, Elixir) flagged by SonarCloud as vulnerable to super-linear backtracking (S5852). Fixed: `mvnRe` and `gradleRe` replaced greedy `(.+)$` with `([^\n]+)` and dropped the end anchor; `csRe` replaced lazy `([^[]+?)` with greedy `([^[]+)`; `gleamRe` replaced `(.+?)` with `([^:]+)`; `elixirRe` replaced the multiline regex entirely with a line-by-line parser to eliminate the flagged pattern.
- **Cascade diagnostics now surface for TypeScript neighbors on cold sessions** — previously cascade silently returned zero diagnostics for TypeScript/Deno neighbors when no passive snapshot existed (i.e. the agent had not yet opened the file). Cold-snapshot neighbors now fall through into the parallel `touchFile` pool with a 1000ms budget (tighter than the 2000ms used for non-jsts neighbors, since the TypeScript server is expected to be warm). Valid snapshots still use the fast read path with no touch. New `coldSnapshot: true` field on `neighbor_touch` log entries tracks these in `cascade.log`.

### Improved

- **`ast-grep` skill clarifies string literal behaviour** — exact string literals in patterns (e.g. `from "./utils"`) work correctly; only metavariables inside string literals (e.g. `from "$PATH"`) are not supported and should use grep instead. Previously the skill incorrectly implied import path matching was unsupported entirely, causing unnecessary grep fallbacks.

## [3.8.35] - 2026-05-02

### Fixed

- **Startup hang for all users fixed (issue #46)** — `igniteWarmFiles` was previously `await`ed unconditionally on the session-start path, causing every session to pay the cost of a full directory walk looking for `lsp.json` (checking 3 config paths at every ancestor up to the filesystem root) before returning. This caused the 20–30s startup delay reported in 3.8.34 regardless of whether `warmFiles` was configured. The `loadLSPConfig` call now runs with `await` at the call site; if `warmFiles` is absent or empty, `igniteWarmFiles` is skipped entirely. When warm files are configured, the per-file LSP `touchFile` loop runs fire-and-forget so it never blocks session completion.

## [3.8.34] - 2026-05-01

### Added

- **LSP config `warmFiles` option** — added `warmFiles` to the LSP config schema. Accepts an array of relative or absolute file paths that pi-lens opens at full session startup to seed language servers that perform lazy translation-unit indexing (e.g. clangd). Without this, a short-lived `workspaceSymbol` query may return empty results for symbols in TUs clangd has not yet built an AST for, and background indexing timing is unreliable at LLVM scale. Specify entry-point files that transitively cover most of the project. The feature is general — any LSP that indexes lazily benefits.
- **TypeScript tsconfig split into build and lint configs** — `tsconfig.build.json` now drives `npm run build` (emits, excludes tests), while `tsconfig.json` drives `npm run lint` (no-emit, includes tests, `allowImportingTsExtensions`, `noUnusedLocals`, `noUnusedParameters`). CI lint step consolidated to `npm run lint`. Surfaced and fixed several latent type errors: unused imports removed, `error: null → undefined` alignment, `_ctx` unused-param rename, `void resolveSlowWait` for intentional float.
- **`GITHUB_TOOLS` const array and `GitHubToolId` type exported from installer** — the set of tools resolved via GitHub releases is now an exported `as const` array with a derived type, eliminating the duplicate definition that previously lived only in the test file.
- **`startupFailureWindowMs` option on `launchLSP`** — callers can now override the startup-failure detection window per-launch instead of relying solely on the Windows/non-Windows heuristic. Used by the LSP lifecycle test to avoid the full `WINDOWS_NAV_STARTUP_FAILURE_WINDOW_MS` delay in CI.
- **Test log pollution fix for read-guard** — `read-guard.test.ts` now mocks `read-guard-logger` unconditionally, so test events never reach `~/.pi-lens/read-guard.log` regardless of how the test suite is invoked.
- **Tab/space indentation mismatch correction in the edit hook** — some models output spaces in `oldText` when the file uses tabs (or vice versa), causing edits to fail with a cryptic "not found" error. The `tool_call` hook now detects this before execution by trying tabs↔2-spaces and tabs↔4-spaces conversions against the actual file. On mismatch it blocks with a `🔄 RETRYABLE` message containing the corrected `oldText` verbatim, so the model retries successfully on the next attempt at zero cost when `oldText` already matches.
- **Global project-data storage is now the default for new projects** — project-scoped pi-lens artifacts (turn state, worklog, metrics history, index, install choices, runner scratch data) now default to `~/.pi-lens/projects/<project-slug>/` instead of creating `<project>/.pi-lens/`. Existing projects that already have `<project>/.pi-lens/` continue to reuse it unless `PILENS_DATA_DIR` is explicitly set. This closes issue #40 while preserving backward compatibility.
- **`PILENS_DATA_DIR` and `PI_LENS_STARTUP_MODE` documented in README** — both env vars are now listed under a dedicated *Environment Variables* section between `## Run` and `## Key Commands`.
- **Tree-sitter read expansion for the read-before-edit guard** — partial reads (requested `limit ≤ 60` lines) are now automatically expanded to cover the full enclosing function, method, or class using the tree-sitter AST. The agent receives the full symbol as context, and the read guard records symbol-level coverage so edits anywhere within the symbol pass without requiring the agent to have read every line. Supports TypeScript, TSX, JavaScript, JSX, Python, Go, Rust, and Ruby. Runs within a 200 ms budget; falls back silently on parse failure or unsupported extension. Replaces the dead LSP-based expansion (which required `limit = 1` and a warm server — zero production hits).
- **`read_pattern` structured log on every read** — `~/.pi-lens/read-guard.log` now records a `read_pattern` JSONL event for each read tool call: `offset`, `limit`, `totalLines`, `fractionRead`, `isPartial`, `fileKind`, and `expandedByTs`. Enables analysis of actual agent read behaviour across sessions.
- **`prettier.config.ts` and `eslint.config.ts` added to config detection arrays** — both config filenames are now recognised by `hasPrettierConfig` and `hasEslintConfig` respectively. Previously only `.js`/`.cjs`/`.mjs` variants were listed, so TypeScript-based configs were silently ignored.
- **Walk-up boundary stops at nearest `package.json`** — all 8 config-detection walk-up functions (`hasEslintConfig`, `getBiomeConfigPath`, `hasOxlintConfig`, `hasMypyConfig`, `hasDetektConfig`, `hasBlackConfig`, `hasRuffConfig`, `hasPrettierConfig`) now stop ascending once they reach the directory containing the nearest `package.json` instead of walking all the way to the filesystem root. This prevents cross-project config bleed in monorepos where an unrelated project higher up the tree happens to have a config file. A shared `walkUpDirsUntilPackageJson` helper encapsulates the boundary logic.
- **Formatter and linter selection logged to `latency.log`** — `getFormattersForFile` now emits a `formatter_selected` phase entry recording the chosen formatter name, selection reason (`explicit-config`, `smart-default`, `detect`, or `none`), and `cwd`. `getLinterPolicyForCwd` emits a `linter_selected` phase entry recording the chosen runner, gate, `cwd`, and the full detection-context flags. Both events are skipped in test mode.

### Fixed

- **Config detection walks up the directory tree for all competing tools** — `hasEslintConfig`, `hasBiomeConfig` / `getBiomeConfigPath`, `hasOxlintConfig`, `hasMypyConfig`, `hasDetektConfig`, `hasBlackConfig`, and `hasRuffConfig` now all walk up to the filesystem root (matching the `findNearestPackageJsonPath` pattern) instead of only checking `cwd`. In monorepos where pi-lens passes a subdirectory as `cwd`, configs at the project root are now found correctly. Prevents wrong smart-default selection (e.g. oxlint firing instead of eslint, ruff firing instead of black) and restores optional runners (mypy, detekt) that were silently dropped when their configs lived above `cwd`. Functions with no competing smart-default (stylelint, sqlfluff, rubocop, golangci-lint, etc.) are unchanged.
- **Biome smart-default no longer overrides explicit Prettier config** — `getFormattersForFile` now only activates the Biome smart-default when no candidate formatter has explicit project config. Previously, a project with `.prettierrc` but no `biome.json` would still have Biome auto-installed and selected. `hasPrettierConfig` also now walks up the directory tree (matching the `findUp` pattern used elsewhere) so a Prettier config in a parent directory is detected even when pi-lens passes a subdirectory as `cwd`. The inline `package.json#prettier` field check uses `Object.prototype.hasOwnProperty` instead of truthiness, correctly handling `"prettier": false` and `"prettier": null`.
- **Duplicate `oldText` in edit calls now blocked early** — the read guard pre-flight check (`resolveOldTextEdits`) returns a `🔴 BLOCKED` error before the edit tool executes when `oldText` matches more than one location in the file, with per-match line numbers so the model can tighten its context.
- **Read-guard `oldText` inference hardened** — unresolved `oldText` targets no longer degrade into permissive `no_line_info` allows. Missing matches now return a blocking preflight error, partial multi-edit resolution blocks the whole edit, and indentation-correctable `oldText` is recognized during touched-line derivation as well as in the retryable pipeline guard.
- **Cascade diagnostics unified through review graph + LSP touch flow** — cascade results now accumulate as structured `CascadeResult` values across the turn, merge/deduplicate by dependent file at turn end, use review-graph references for broader neighbor discovery, respect TypeScript/Deno auto-propagation capabilities, and fall back to passive LSP snapshots when no trustworthy neighbor LSP data is produced.
- **Cascade LSP diagnostics now use shared conversion/tracking** — cascade diagnostics are converted through the shared LSP→dispatch diagnostic utility, participate in `DiagnosticTracker`, use separate cascade delta baselines (`session.baseline.cascade.*`), and share centralized cascade formatting.
- **`touchFile({ collectDiagnostics: true })`** — LSP touch can now return merged diagnostics from the clients it opened/synced, allowing cascade to collect diagnostics from the same silently touched clients without a second aggregate `getDiagnostics()` call.
- **Review graph workspace cache** — cascade graph builds now reuse the parsed review graph across pipeline invocations when source file mtimes/sizes are unchanged, while still applying per-write changed-symbol state. Cascade logs now record whether the graph was reused and the build mode.
- **`PILENS_DATA_DIR` env var for external project data storage** — when set, all project-generated data (caches, index, worklog, LSP install choices, elixir outputs, metrics history) is written to `$PILENS_DATA_DIR/<project-slug>/`. Slug is derived from the project's absolute path using the existing cross-platform `normalizeFilePath` utility.

### Fixed

- **Cascade silent LSP opens no longer broadcast file-watch changes** — cascade neighbor reads now open documents with `silent: true`, suppressing `workspace/didChangeWatchedFiles` so TypeScript/Python servers do not schedule project-wide rechecks for every dependent file touched.
- **Cascade cache/fallback correctness** — per-turn cascade caches are scoped by turn/write sequence, empty cascade results are suppressed, no-LSP neighbors are treated as no signal, and degraded fallback now triggers when no neighbor produced LSP data rather than only when the graph returned zero neighbors.
- **LSP touch `no_clients` latency diagnostics** — `lsp_touch_file` no-client records now include attempted server count, source, and wait budget so slow no-client outcomes can be distinguished from unsupported-file fast paths.
- **Misleading LSP error when `filePath` is a directory** — `lsp_navigation` now stat-checks the resolved path before server lookup. Passing a directory (e.g. `.`) to `workspaceDiagnostics` falls through to workspace-scoped mode; file-scoped operations return a clear `filepath_is_directory` error instead of the previous "No LSP server available … Check that the language server is installed" message, which incorrectly implied an install problem.
- **LSP `didChangeWatchedFiles` sends correct change type** — `handleNotifyOpen` now uses `type: 2` (Changed) for existing files instead of unconditionally sending `type: 1` (Created). File-watching LSPs no longer treat every open as a newly created file, which could invalidate caches differently than intended.
- **`getAllDiagnostics()` deduplicates across multiple LSP clients** — when TypeScript + ESLint both report an error on the same line, the fallback/snapshot path now merges and deduplicates instead of showing both. Prevents duplicates from pushing out unique diagnostics under the `MAX_PER_FILE` cap.
- **`formatImpactCascade` respects configurable `cascadeMaxFiles`** — removed hardcoded `MAX_FILES = 4` in `format.ts`; the display cap now matches `RUNTIME_CONFIG.pipeline.cascadeMaxFiles` (default 8), so the impact header and truncation hint are consistent with actual analysis.
- **Turn-end cascade merge preserves impact context** — previously `runtime-turn.ts` rebuilt output from raw `neighbors`, discarding impact headers, changed symbols, risk flags, and truncation hints. It now uses the pre-built `CascadeResult.formatted` field (deduplicated by primary file), so the agent sees causal context ("Changed symbols: X", "Direct importers: Y", "Risk: Z") alongside diagnostics.
- **Neighbor touch cache is turn-scoped** — `neighborTouchCache` previously invalidated on every `writeIndex` bump, so reading a file then editing it would re-touch the same neighbor. The cache now keys on `turnSeq` only, so neighbors are touched once per turn regardless of how many files are edited.
- **Dead opportunistic LSP read expansion removed** — the `findSymbolAtLine` / `withTimeout` / `LSP_READ_EXPANSION_BUDGET_MS` code path was never triggered in production (zero `lsp_range_expanded` events outside tests) and added complexity/latency to every read tool call. Removed entirely. Read guard records now use `peekWriteIndex()` instead of `nextWriteIndex()`, fixing the cascade cache invalidation bug where reads incremented the write counter.
- **Test-mode guards for all loggers** — every logger that writes to `~/.pi-lens/` now skips disk I/O when `PI_LENS_TEST_MODE === "1"` or when running under `VITEST` (unless explicitly opted out with `PI_LENS_TEST_MODE=0`). Eliminates test pollution in `cascade.log`, `read-guard.log`, `latency.log`, `sessionstart.log`, `tree-sitter.log`, and diagnostic JSONL. The `dbg()` function already had this guard; it is now applied consistently across `logCascade`, `logReadGuardEvent`, `logLatency`, `logTreeSitter`, `logSessionStart`, and `DiagnosticLogger.log`.
- **`read-guard.log` included in automatic cleanup** — `runLogCleanup()` now covers `read-guard.log` alongside the existing `sessionstart.log`, `tree-sitter.log`, and `cascade.log`.

- **oxfmt `.oxfmtrc.json` detection** — `hasOxfmtConfig` now treats `.oxfmtrc.json` as an activation signal alongside `oxfmt.toml` and `@oxc-project/oxfmt` in package.json.

## [3.8.33] - 2026-04-27

### Fixed

- **JSON/JSONC autofix skipped without biome config** — `getAutofixPolicyForFile` now returns `undefined` for `.json`/`.jsonc` files when no `biome.json`/`biome.jsonc` is present, matching the format policy's `defaultWhenUnconfigured: false` gate. Previously biome was always invoked for JSON edits (~688ms) even when it had no config and fixed nothing. `hasBiomeConfig` added to `AutofixPolicyContext` and wired into the autofix context in `runAutofix`.

### Added

- **Early-unblock diagnostic aggregation** — `getDiagnostics()` now races `Promise.all` against a first-client-done + grace window (`PI_LENS_LSP_EARLY_UNBLOCK_GRACE_MS`, default 400ms). Once the fastest client delivers results, remaining clients have the grace window before the call returns with whatever is ready. Eliminates the previous worst case where a slow push-only server forced the full 1500ms aggregate wait even when a faster server already had errors. `earlyUnblockedCount` is logged in `lsp_diagnostics_aggregate` latency records.
- **Dynamic LSP capability registration tracking** — `client/registerCapability` and `client/unregisterCapability` handlers now record live registrations (`id → method`) in `dynamicRegistrations`. `applyDynamicCapabilities()` upgrades `workspaceDiagnosticsSupport` to pull mode when `textDocument/diagnostic` or `workspace/diagnostic` is dynamically registered, and reverts when the last such registration is removed (unless statically advertised). Operation support flags are also upgraded for dynamically-registered nav methods. Servers that defer capability advertisement past `initialize` are now treated correctly.
- **Deno/TypeScript server disambiguation** — `TypeScriptServer.root` now returns `undefined` for any file with a `deno.json` or `deno.jsonc` ancestor, preventing TypeScript LSP from being spawned alongside Deno LSP for the same file. Eliminates false diagnostics for Deno-specific APIs and removes the wasted parallel spawn.
- **`CONDA_PREFIX` support in Python venv detection** — conda environments do not set `VIRTUAL_ENV`; venv detection now checks `CONDA_PREFIX` as a fallback between `VIRTUAL_ENV` and the local `.venv`/`venv` directories.
- **pylsp venv initialization** — `PythonPylspServer.spawn` now passes `{ pylsp: { plugins: { jedi: { environment: pythonPath } } } }` when a virtual environment is detected. Previously pylsp always used the system Python, so completions and diagnostics resolved against the wrong package set in virtualenv projects.

### Changed

- **Push/pull LSP diagnostic caches split** — `LSPClientState` now maintains separate `pushDiagnostics` and `documentPullDiagnostics` maps with independent timestamps. Public API (`getDiagnostics`, `getAllDiagnostics`, `pruneDiagnostics`) operates on a merged, deduplicated view. Clears and prunes invalidate both sources independently. Makes diagnostic freshness and source attribution inspectable without changing caller behavior.
- **Explicit LSP touch diagnostics modes** — `touchFile()` now takes `{ diagnostics: "none" | "document" | "full", clientScope: "primary" | "all", source, maxClientWaitMs }` instead of a boolean `waitForDiagnostics` flag. Read/tool-call warming uses `"none"`; write validation uses `"document"`. Latency records include `diagnosticsMode`, `clientScope`, and `source`.
- **Pipeline reordered around final content** — format → refresh → autofix → refresh → LSP sync once with final content → dispatch. LSP diagnostics and dispatch runners now always operate on the final post-format/post-fix on-disk state. Removed previously-dead `supportsAutofix` / deferred sync logic.
- **Python venv detection deduplicated** — `PythonServer.spawn` previously ran identical 20-line venv detection blocks in both the direct and managed code paths. Both now call the shared `detectPythonVenv(root)` helper.

### Fixed

- **Formatter failures now visible in output** — formatter crashes (missing binary, timeout, I/O error) now append `⚠️ Auto-format failed: <reason>` to pipeline output instead of silently writing to debug logs. Prevents misleading all-clear output when a required format phase failed.
- **Same-file same-turn pipeline dedupe keyed on content hash** — previously any later pipeline for a file already reported in the same turn was skipped by file path alone, suppressing legitimate second edits. Dedupe is now keyed on post-write content hash: concurrent duplicate events for the same final content are collapsed, but a later edit with changed content runs the full pipeline again.
- **Autofix side-effect files tracked in turn state** — `runAutofix()` now returns `changedFiles[]`. File-scoped fixers (ruff, biome, eslint, stylelint, sqlfluff, rubocop, ktlint) record the target file on a successful fix; project-wide fixers (cargo clippy --fix, dart fix --apply) snapshot the project tree before and after to detect side-effect changes. Non-target changed files are added to turn state via `cacheManager.addModifiedRange()` so cascade and read-guard see the full mutation set.

### Changed

- **Linter dispatch runners promoted to always-on for 11 languages** — runners that previously fired only when LSP failed (`mode: "fallback"`) now run alongside LSP unconditionally (`mode: "all"`): `pyright` (Python), `rust-clippy` (Rust), `go-vet` (Go), `shellcheck` (Shell), `tflint` (Terraform), `elixir-check` + `credo` (Elixir), `cpp-check` (C/C++), `dart-analyze` (Dart), `gleam-check` (Gleam), `psscriptanalyzer` (PowerShell), `prisma-validate` (Prisma). These tools provide orthogonal signal to the LSP that was previously invisible on healthy sessions.

### Added

- **Linter policy entries for 9 languages** — `getLinterPolicyForFile` now covers Rust (rust-clippy, smart-default), Shell (shellcheck, smart-default), Terraform (tflint, smart-default), Elixir (credo, smart-default), C/C++ (cpp-check, smart-default), Dart (dart-analyze, smart-default), Gleam (gleam-check, smart-default), PowerShell (psscriptanalyzer, smart-default), and Prisma (prisma-validate, smart-default). These linters now participate in the full policy layer rather than being dispatch-only.
- **`cargo clippy --fix` autofix for Rust** — `rust-clippy` is now a safe pipeline autofix tool for `.rs` files. After each edit, `cargo clippy --fix --allow-dirty --allow-staged` runs in the nearest `Cargo.toml` directory before dispatch lint, applying machine-fixable clippy suggestions. Gated `smart-default`; skips silently if `cargo` is unavailable or no `Cargo.toml` is found.
- **`dart fix --apply` autofix for Dart** — `dart-analyze` is now a safe pipeline autofix tool for `.dart` files. After each edit, `dart fix --apply` runs in the nearest `pubspec.yaml` directory before dispatch lint. Gated `smart-default`; skips silently if `dart` is unavailable or no `pubspec.yaml` is found.

### Fixed

- **Unknown/support files no longer trigger opportunistic LSP auto-touch** — `tool_call` LSP warming now defaults unknown file kinds to non-LSP-capable and explicitly skips internal/support artifacts such as `.pi-lens/*`, `.harness/*`, `stdout.jsonl`, `stderr.txt`, `prompt.txt`, and harness `case.json` files. This removes pointless `lsp_touch_file` `no_clients` waits on logs, prompts, and turn-state sidecars.
- **Spawn-heavy LSP capability checks removed from hot paths** — added a pure `supportsLSP(filePath)` check and a lightweight `hasWarmLSP(filePath)` helper so hot write/read paths no longer use `hasLSP()` merely to ask whether a file type is supported. `pipeline` sync/resync, the unified LSP runner, and `lsp_navigation` unsupported-file messaging now avoid accidental client spawns during simple capability checks.
- **`ktlint` autofix case missing `continue`** — the `ktlint` branch in `runAutofix` lacked a `continue` guard, causing fall-through into the next tool match on every ktlint run.

## [Unreleased — mypy + detekt]

### Added

- **`mypy` wired into Python dispatch** — runner already existed but was never included in the dispatch plan or linter policy. Added to Python `writeGroups` in `plan.ts` and to `getLinterPolicyForFile` for `.py`/`.pyi`. When `mypy.ini` or `[tool.mypy]` is present, mypy is appended to `preferredRunners` alongside ruff-lint (gate: `mixed`); unconfigured projects are unaffected.
- **`detekt` runner for Kotlin** — new runner (`detekt.ts`) that runs `detekt --input <file> --config <config>` for static analysis of `.kt`/`.kts` files. Config-first: activates only when `detekt.yml`, `.detekt.yml`, `config/detekt/detekt.yml`, or `detekt/detekt.yml` is found. Added `hasDetektConfig` helper, `"detekt"` to `LintRunnerName`, `hasDetektConfig` to `LinterPolicyContext`, and detekt to Kotlin's linter policy (appended to `preferredRunners` alongside ktlint when configured). Kotlin `plan.ts` `writeGroups` updated to include detekt.

## [3.8.32] - 2026-04-26

### Fixed

- **`lspExpansionsHelped` counter undercounted in `/lens-health`** — `getSummary` used `reads.find(r => r.timestamp <= record.precedingReads[0]?.timestamp)` which always selected the first ever read for the file, so only sessions where the very first read used LSP expansion were counted. Fixed to `record.precedingReads.some(r => r.expandedByLsp)`, correctly checking all reads that preceded the specific edit.
- **`preserveDiagnostics` incorrectly set when autofix also ran** — when a formatter and an autofix tool both modified a file, the LSP resync was still called with `preserveDiagnostics: true` because `formatChanged` was set, even though autofix changes can affect code semantics. Fixed by gating on `formatChanged && fixedCount === 0`, ensuring semantics-changing autofix always triggers a fresh diagnostics cycle.
- **Empty-result message for `workspaceSymbol` had dangling "at"** — `"No results for workspaceSymbol at "` was produced when no `filePath` was given (workspace-scoped query with no file). Fixed by guarding the `" at <filename>"` segment on `filePath` being non-empty.

### Fixed

- **TypeScript LSP 5-second pipeline stall on every edit to clean files** — after biome or another formatter rewrote a file, `resyncLspFile` called `lsp.openFile` which deleted the diagnostics cache and sent `textDocument/didChange`. `waitForDiagnostics` then waited the full 5000ms timeout for TypeScript to re-publish what it already knew (formatting doesn't change semantics, so the error set is identical). Added `preserveDiagnostics` option to `openFile`/`handleNotifyOpen`: format-only resyncs no longer clear the cache, so `waitForDiagnostics` fast-paths immediately. For pi-free provider files this cuts per-edit pipeline time from ~12s to ~3-4s.
- **`ktlint` formatter silently inactive when installed by the linter runner** — `ktlint` is both a smart-default formatter (`.kt`/`.kts`) and a smart-default linter with a managed GitHub-release install. The formatter's `detect()` used only `which("ktlint")`, never `getToolPath("ktlint")`, and the formatter was absent from `AUTO_INSTALLABLE_DEFAULT_FORMATTERS`. When the linter runner auto-installed `ktlint` to `~/.pi-lens/bin/`, the formatter was blind to it — Kotlin files got linted but never formatted. Fixed by adding `ktlint` to `AUTO_INSTALLABLE_DEFAULT_FORMATTERS`, adding `resolveCommand` that calls `ensureTool`, and making `detect` check `getToolPath` as fallback.
- **Subagent process hangs indefinitely after completing work (issue #22)** — `scheduleLSPIdleReset` created a 240-second `setTimeout` without `.unref()`. Every `turn_end` with no file edits scheduled this timer, keeping the Node.js event loop alive for 4 full minutes. pi-subagents killed the child at the 5-second drain deadline and reported `exit code 1` / SIGTERM even though all work completed successfully. Confirmed: `--no-lsp` exited cleanly because the timer is gated on LSP being enabled. Fixed by calling `.unref()` on the timer (lets the process exit naturally if there is no other pending work) and by registering a `session_shutdown` handler that cancels the timer explicitly and calls `resetLSPService()`.
- **Read-guard false-blocks multi-chunk reads** — `checkCoverage` checked each `ReadRecord` independently, so reading a 200-line file as two 100-line chunks and then Writing it was falsely blocked because neither chunk alone covered `[1, 200]`. Fixed by adding a second-pass union-merge of all read intervals: overlapping/adjacent ranges are merged in sorted order, and coverage is satisfied if any merged interval contains the edit range.
- **`requestedLimit` field recorded as `effectiveReadLimit` instead of the agent's actual requested limit** — `ReadRecord.requestedLimit` was always the computed effective limit, not what the agent asked for. Fixed to record the raw requested limit (falling back to effective when not provided).
- **Read-guard blocks legitimate full-file writes** — `write` tool calls were assigned the range `[1, Number.MAX_SAFE_INTEGER]`, which can never be covered by any prior read, so every full-file write on an existing file was incorrectly blocked with "Edit outside read range … lines 1–9007199254740991". Fixed by passing the file path into `getTouchedLinesForGuard` and using the actual on-disk line count (`countFileLines`) as the end of the write range. An agent that read all N lines of a file can now rewrite it without a false block.
- **Read-guard false-blocks text replacement edits without explicit line ranges** — `edit` calls using `oldText` / `newText` matching but no `range` metadata were previously inferred as touching line `1`, producing bogus `"🔴 BLOCKED — Edit outside read range"` failures even when the agent had read the correct target region. Fixed touched-line inference so range-less replacement edits return `undefined` instead of defaulting to `1-1`, avoiding fabricated line-1 violations.
- **`NEEDS_POSTINSTALL` broken for scoped npm packages** — `@biomejs/biome`, `@ast-grep/cli`, and `@ast-grep/napi` were incorrectly checked with `packageName.split("@")[0]` which always yields `""` for scoped packages; the nullish-coalescing fallback never fired. These packages always received `--ignore-scripts`, preventing native binary postinstall scripts from running and silently breaking their auto-installation. Fixed by checking the full package name directly.
- **Silent formatter failures in pipeline** — when a formatter crashed (binary missing, timeout, or I/O error) the post-write pipeline never emitted a debug log; only `anyChanged` triggered output. Formatter errors are now surfaced via `dbg()` so they appear in debug/latency logs.
- **`tryLazyInstallFormatterTool` failures logged** — lazy `gem install rubocop` and `rustup component add rustfmt` failures were silently swallowed with no log output anywhere. Both now emit a `[format] lazy-install <tool> failed: <reason>` message to stderr.
- **`getFormattersByName` broken for hyphenated formatter names** — constructing the export key as `` `${name}Formatter` `` produced `"php-cs-fixerFormatter"` and `"clang-formatFormatter"` instead of the real camelCase exports (`phpCsFixerFormatter`, `clangFormatFormatter`). These formatters were silently filtered out when selected by name via the explicit `options.formatters` API. Fixed by converting hyphenated names to camelCase before appending `Formatter`.
- **Read-before-edit guard correctness** — fixed `read.path` vs `read.filePath` mismatch, full-file read coverage tracking, read-guard range math, session reset leakage, and guard messaging so edit enforcement now correctly reflects actual reads
- **First-read LSP warmup behavior** — first `read` now triggers non-blocking async LSP warmup once per file/session window, with retry-safe state tracking and reset handling
- **Formatter selection bugs and drift** — formatter chooser now reliably selects exactly one formatter, no longer lets registry order accidentally block smart defaults, and keeps explicit config precedence over defaults
- **Ruby auto-install policy mismatch** — `rubocop` policy and installer behavior are now aligned through managed gem install support
- **Prettier dispatch redundancy** — removed `prettier-check` from the active dispatch path to avoid re-checking formatting after the authoritative autoformat pipeline has already run
- **LSP race condition in `initLSPConfig`** — `configInFlight` Map deduplicates concurrent initialization calls for the same workspace; parallel session starts no longer double-initialize and race on `workspaceConfigs`
- **`lsp_navigation` rejected accidentally quoted `operation` values at schema-validation time** — the tool previously declared `operation` as a `Type.Union` of string literals, so model outputs like `"workspaceDiagnostics"` were rejected before `execute()` ran, causing confusing retry loops with no recovery path. The tool now accepts a string, normalizes accidental surrounding quotes, validates against the allowed operation set inside `execute()`, and returns a clear error listing valid operations when the value is still invalid.
- **`LSPService` use-after-shutdown** — `isDestroyed` flag added; all public methods (`getClientForFile`, `openFile`, `updateFile`, `waitForDiagnostics`, `getDiagnostics`, `shutdown`) return early once the service has been shut down
- **`theme.fg` crash during session start** — `updateLspStatus` wraps theme calls in try/catch; theme may not be fully initialized during early session startup events
- **`isCommandAvailable` hangs on slow tools** — added 5s timeout with `proc.kill()` and a double-resolve guard; probe commands that stall no longer block session startup indefinitely
- **Tree-sitter `client_unavailable` log spam** — `TreeSitterClient.isAvailable()` now re-evaluates `grammarsDir` when the cached path goes missing, instead of caching an empty string forever. Added `resolveWebTreeSitterAsset()` helper with three strategies: (1) `createRequire` module resolution (hoisted installs — issue #20), (2) `resolvePackagePath(import.meta.url)` fallback (on-the-fly TS compilation by pi), (3) `process.cwd()` fallback. Fixes 108 skipped-runner log lines when the initial grammar probe failed transiently.
- **Pipeline test assertion drift** — updated `tests/clients/pipeline.test.ts` to match the current auto-format warning text (`File was modified by auto-format/fix...`)

### Added

- **Autofix decision/attempt logging** — the post-write pipeline now logs autofix policy selection, preferred tools, attempted tools, explicit skip reasons, and the important distinction between “autofix skipped” vs “autofix ran but applied 0 fixes.” This makes it much easier to understand whether TypeScript files chose Biome or ESLint autofix and why.
- **Dedicated read-guard trace log** — added `~/.pi-lens/read-guard.log` with structured events for read recording, LSP range expansion, touched-line derivation, edit checks, verdicts, and exemptions. This separates guard-policy debugging from the noisier general `latency.log` stream.
- **Centralized formatter policy layer** — added normalized per-extension formatter policy with explicit config detection, smart-default selection, and managed-vs-toolchain default handling
- **Centralized command spec / execution policy layer** — added shared tool command specs, execution policy, and resolver helpers used by dispatch runners and autofix paths
- **Centralized linter policy layer** — added policy selectors for dispatch lint runner choice so config-first and smart-default lint behavior is now encoded centrally instead of only in individual runners
- **Centralized autofix policy and capability metadata** — added policy selectors for safe pipeline autofix plus explicit capability metadata separating tool-level fix support from safe automatic post-write autofix
- **Expanded smart-default formatter coverage** — added smart defaults across web/content formats and additional language ecosystems, including managed smart-default support for `prettier`, `shfmt`, and `taplo`
- **LSP footer status indicator** — session start and turn end now show `LSP Active (N)` in green or `LSP Inactive` in red; count reflects alive (connected + initialized) clients via `getAliveClientCount()`
- **Rust monorepo workspace root detection** — `RustServer` walks up from the detected crate root checking parent `Cargo.toml` files for a `[workspace]` section; rust-analyzer now resolves correctly in Cargo workspaces
- **Opportunistic LSP read range expansion** — single-line `read` tool calls are silently expanded to the full enclosing symbol when a warm LSP client is available; best-effort, no-op if LSP is cold or the lookup doesn't resolve in time
- **`workspaceSymbol` result filtering and cap** — `lsp_navigation` now filters and caps workspace symbol results at 15 entries to avoid overwhelming the context window

### Performance

- **LSP pre-edit touch bounded and file-kind gated** — `edit` / `write` tool calls now skip opportunistic LSP pre-touch for non-LSP-capable files (for example Markdown) and cap the warm-client wait with `PI_LENS_TOOLCALL_TOUCH_MS` (default `750ms`). This avoids pointless `no_clients` touch attempts and reduces edit-path stalls.
- **Empty aggregate diagnostic waits shortened** — aggregate LSP diagnostics no longer wait the old hardcoded multi-second timeout just to confirm an empty result set. New settle/wait budgets (`PI_LENS_LSP_DIAGNOSTICS_AGGREGATE_WAIT_MS`, `PI_LENS_LSP_DIAGNOSTICS_SEMANTIC_THRESHOLD_MS`, `PI_LENS_LSP_DIAGNOSTICS_SEMANTIC_SETTLE_MS`) make clean-edit loops return faster.
- **Tool path resolution fast path** — `getToolPath` checks the local managed install (`~/.pi-lens/tools/node_modules/.bin/`) before global PATH probes, npm/pip/GitHub lookups; eliminates 2–5s overhead per tool on session start
- **`jscpd` availability fast path** — `ensureAvailable()` probes the local install with `fs.existsSync` before spawning a process, and deduplicates concurrent calls via `ensureInFlight`
- **Concurrent project indexing** — `buildProjectIndex` processes files in batches of 8 with `Promise.all` instead of sequentially; large projects index significantly faster
- **`buildFunctionMatrixFromNode` avoids re-parse** — walks the existing TypeScript AST directly instead of extracting function source text and creating a new `SourceFile`; removes per-function re-parse overhead from similarity indexing

### Removed

- **`prettier-check` runner fully removed** — the dead `clients/dispatch/runners/prettier-check.ts` file is now deleted entirely after its earlier removal from active dispatch plans; formatting remains owned by the autoformat pipeline instead of dispatch re-checks
- **Worthless `diagnostic-logger` tests** — deleted `tests/clients/diagnostic-logger.test.ts` (5 tests that only asserted mock objects equaled what was just assigned; zero behavior coverage)
- **Redundant circular-dependency regression tests** — removed 3 no-op import tests from `tests/clients/circular-deps-regression.test.ts` (`expect(module).toBeDefined()` after `await import(...)` adds no value; import failure throws before the assertion)

### Changed

- **Normal dispatch no longer runs `similarity` by default** — removed `similarity` from standard JS/TS write and full lint dispatch plans so targeted edits no longer pay its hot-path cost; similarity analysis remains available in explicit workflows like `/lens-booboo` and inline advisory logic.
- **Cascade diagnostics prune stale cache entries earlier** — LSP diagnostic merging now drops TTL-expired and non-existent file entries before cascade aggregation, reducing stale-path noise and improving cache hygiene during long sessions.
- **Autoformat policy normalized across supported languages** — formatter behavior is now: exactly one formatter runs, explicit config wins, otherwise smart default applies, and config-first file types do nothing when unconfigured
- **JS/TS lint fallback normalized** — no-config JavaScript/TypeScript dispatch now consistently prefers `oxlint` with `biome-check-json` fallback, while explicit ESLint/Oxlint/Biome config still wins
- **Safe autofix remains pipeline-owned** — autofix selection now flows through centralized policy and remains in the post-write pipeline, while dispatch runners stay diagnostics-only
- **Dispatch runner gating centralized** — major runners (`stylelint`, `yamllint`, `markdownlint`, `htmlhint`, `hadolint`, `sqlfluff`, `rubocop`, `ktlint`, `taplo`, `golangci-lint`, `phpstan`, `ruff`) now consult centralized lint policy before running
- **Kotlin safe autofix added** — `ktlint -F` is now treated as a safe pipeline autofix path for Kotlin files
- **Fixability semantics clarified** — dispatch diagnostics now distinguish generic fixability from safe pipeline autofix availability and expected fix mode (`pipeline`, `manual`, `suggestion`), including suggestion/manual-fix runners like LSP, TS-LSP, shellcheck, shfmt, spellcheck, tree-sitter, architect, and ast-grep-napi
- **Test runner moved to turn_end (non-blocking)** — previously fired inline on every write, blocking the pipeline for up to 60s mid-refactor and producing false failures while the codebase was in an inconsistent state. Tests now run once per turn after all edits complete: unique test targets are collected from modified files, fired concurrently as a fire-and-forget `Promise.allSettled`, and failures are written to cache for injection into the next turn's context. Results are discarded if the agent starts a new turn before tests finish, preventing stale failures from clobbering newer results.
- **Similarity runner skips small edits** — when `modifiedRanges` total lines is below `MIN_FUNCTION_LINES` (8), the similarity runner exits early; a new function can't fit in fewer lines than that, so the ~1100ms scan is wasted on targeted fixes
- **Stronger auto-format/fix re-read warning** — message now explicitly tells the agent it MUST re-read the file before any further edits, listing what may have changed (whitespace, indentation, quotes, code)
- **Turn-end findings cap tightened** — reduced `maxLines` from 24 → 20 and `maxChars` from 1600 → 1000 to stay conservative with context budget

### Tests

- **Read-guard touched-line regression tests** — added `tests/clients/read-guard-tool-lines.test.ts` covering full-file writes and range-less text replacement edits so read-guard line inference no longer regresses to bogus `1-1` edits.
- **Policy normalization regression coverage** — added and updated tests for read-guard fixes, runtime coordinator warm/reset behavior, formatter policy selection, command resolution, linter/autofix policy metadata, dispatch plan exposure, and runner status semantics across the formatter/linter/autofix normalization work
- **LSP integration tests** — added `tests/clients/lsp/integration.test.ts` with a fake JSON-RPC server (`tests/fixtures/fake-lsp-server.mjs`) covering LSP client lifecycle: initialize handshake, file open/change notifications, diagnostics, and graceful shutdown
- **Tree-sitter resolution regression tests** — added 3 tests to `tests/clients/tree-sitter-client-init.test.ts`:
  - `TreeSitterClient.isAvailable returns true when grammars are installed` (smoke test)
  - `falls back to resolvePackagePath when require.resolve fails` (on-the-fly compilation scenario)
  - `re-evaluates grammarsDir when isAvailable is called after initial miss` (prevents cached-empty-string bug)

## [3.8.31] - 2026-04-23

### Fixed

- **Duplicate inline feedback on edit arrays** — `tool_result` calls for the same file are now deduplicated within a turn using a `reportedThisTurn` set on `RuntimeCoordinator`, cleared on each `turn_start`; previously pi's sequential per-hunk `tool_result` firing caused the pipeline to re-run and feedback to repeat N times per edit array
- **Double latency logging on pipeline completion** — removed redundant `logLatency` call in `pipeline.ts`; `runtime-tool-result.ts` already logs the outer `tool_result completed` with full duration including format, autofix, and cascade phases
- **Modified range tracking broken for 3-digit+ line numbers** — `parseDiffRanges` regex changed from `\s+` to `\s*` to handle unpadded line numbers; the diff format right-pads to the file's max digit width so e.g. line 613 in a <1000-line file has no leading space and was silently dropped
- **Stale gleam grammar entries** — removed dead `LANGUAGE_TO_GRAMMAR` and `getExtensionsForLanguage` entries for gleam; `tree-sitter-gleam.wasm` was never published in `tree-sitter-wasms@0.1.13`

### Changed

- **TypeBox 0.34.x → 1.x migration** — updated `package.json` dependency from `@sinclair/typebox` to `typebox ^1.0.0` and updated imports in `tools/lsp-navigation.ts`, `tools/ast-grep-search.ts`, and `tools/ast-grep-replace.ts` to match pi-mono 0.69.0

## [3.8.30] - 2026-04-22

### Fixed

- **lsp_navigation permanently disabled** — removed stale `lens-lsp` flag check (flag was removed in 3.8.29) that caused every `lsp_navigation` call to short-circuit with `lsp_disabled`; tool now only gates on `--no-lsp`
- **ast_grep_search / ast_grep_replace auto-install** — switched availability check from sync `isAvailable()` to async `ensureAvailable()` so the auto-installer triggers when `sg` is missing
- **@ast-grep/cli postinstall skipped** — added `@ast-grep/cli` to `NEEDS_POSTINSTALL`; without it `--ignore-scripts` left ASCII stubs in place of `sg.exe` / `ast-grep.exe` on Windows
- **Windows .exe binary lookup** — `getToolPath` now also probes the `.exe` extension on Windows, covering packages (like `@ast-grep/cli`) that place a `.exe` directly without a `.cmd` wrapper
- **jscpd broken on Node 24** — pinned `jscpd` to `3.5.10`; v4 introduced a `reprism` dependency whose `lib/languages/` directory is absent from the published package
- **TypeScript LSP using home dir as workspace root** — wrapped `TypeScriptServer` and `ESLintServer` roots with `IgnoreHomeRoot` so a `package.json` / eslint config in `~` can no longer hijacks the workspace root; fallback is the file's own directory
- **CI npm publish runs without token** — gated `publish-npm` job and dry-run step on `NPM_TOKEN` secret being set
- **Stale compiled .js triggered test failures** — rebuilt project; `secrets-scanner.js` and `project-index.js` were from before the env-var-name false-positive fix and line-number capture fix respectively
- **ast_grep_search test mock** — updated test mock from `isAvailable` to `ensureAvailable` to match the new async availability check
- **Stale LSP diagnostics in cascade** — cascade diagnostics now skip entries older than 240s, preventing false positives from earlier test injections bleeding across turns
- **Biome check on Vue/Svelte** — biome-check-json was briefly skipped on `.vue`/`.svelte` but restored after confirming Biome 2.x has native support; the 3 blocking diagnostics were real lint findings, not parse errors
- **Vue/Svelte TypeScript SDK** — extracted `findTsserverPath` helper and wired it into `VueServer` and `SvelteServer` `initializationOptions` so Vue/Svelte LSP servers find the correct `typescript.tsdk`
- **Broken npm .cmd shims on Windows** — `launch.ts` now validates npm `.cmd` shims before spawning; if the target JS file doesn't exist the shim exits with code 1 after a 500ms startup window, pre-checking avoids the delay for all LSP servers on Windows
- **Tree-sitter WASM path in hoisted installs** — `tree-sitter-client.ts` now resolves `web-tree-sitter/tree-sitter.wasm` via `createRequire` so Node walks `node_modules` ancestors correctly; fixes `ENOENT` crash in pnpm/monorepo layouts where the wasm is not nested under pi-lens's own `node_modules`
- **Grammar directory lookups in hoisted installs** — `findGrammarsDir` uses the same `createRequire` fix to anchor `web-tree-sitter/grammars` and `tree-sitter-wasms/out` paths correctly in pnpm/monorepo layouts
- **tree-sitter-gleam download 404** — removed `tree-sitter-gleam.wasm` from grammar downloads; the file was never published in `tree-sitter-wasms@0.1.13`
- **Pipeline deduplication** — `handleToolResult` now deduplicates concurrent pipeline calls for the same file; the pi framework fires `tool_result` once per hunk in an Edit array, causing duplicate pipeline runs and doubled agent output

### Changed

- **Tuned false-positive thresholds across all runners** — reduced noise in `lens-booboo` and dispatch for all users:
  - Added `FACT_SEVERITY_FILTER` (`error`/`warning` only) and `MIN_TREE_SITTER_HITS_PER_RULE = 3`
  - Filtered entropy/AI-style warnings from complexity metrics
  - Aligned complexity markdown headers with actual thresholds (`MI < 20`, `cognitive > 80`, `nesting > 8`)
  - Raised `SEMANTIC_SIMILARITY_THRESHOLD` from `0.96` → `0.98` (aligned with dispatch similarity runner)
  - Raised duplicate-string-literal `MIN_DUPLICATES` from `4` → `10`
  - Unregistered `no-magic-numbers` and `high-entropy-string` fact rules globally

### Removed

- **Dead code across 32 files** — removed 51 sites of unused imports, locals, and parameters flagged by `tsc --noUnusedLocals --noUnusedParameters`:
  - `clients/architect-client.ts`, `ast-grep-client.ts`, `biome-client.ts`, `complexity-client.ts`, `go-client.ts`, `rust-client.ts`, `scan-utils.ts`, `secrets-scanner.ts`, `subprocess-client.ts`, `test-runner-client.ts`, `tool-availability.ts`, `tree-sitter-cache.ts`, `tree-sitter-client.ts`, `type-coverage-client.ts`, `type-safety-client.ts`
  - `clients/dispatch/dispatcher.ts`, `runners/ast-grep-napi.ts`, `runners/golangci-lint.ts`, `runners/index.ts`, `runners/python-slop.ts`, `runners/ts-lsp.ts`, `runners/utils/diagnostic-parsers.ts`
  - `clients/lsp/client.ts`, `config.ts`, `interactive-install.ts`, `launch.ts`, `server.ts`
  - `clients/pipeline.ts`, `review-graph/builder.ts`, `runner-tracker.ts`
  - `commands/booboo.ts`, `index.ts`

### Tests

- **Pipeline regression tests** — `tests/clients/pipeline.test.ts` (11 tests): secrets blocking, format modification, LSP sync, dispatch blockers, autofix output, test runner skip, all-clear output
- **Autofix helper tests** — `tests/clients/autofix-helpers.test.ts` (12 tests): config detection (eslint, stylelint, sqlfluff), malformed JSON handling, file change detection after command
- **LSP lifecycle tests** — `tests/clients/lsp/lifecycle.test.ts` (4 tests): missing binary error, process spawn, immediate exit detection, process kill
- **FormatService tests** — `tests/clients/format-service.test.ts` (11 tests): disabled/skip mode, no matching formatters, successful run with change detection, formatter failure, external modification detection, singleton behavior, state clearing, file tracking
- **Dispatch integration tests** — `tests/clients/dispatch/integration.test.ts` (11 tests): `dispatchLintWithResult` empty results, result propagation, warnings-only; `shouldDispatch` for supported/unsupported; `getAvailableRunners` for supported/unsupported
- **LSP client internals tests** — `tests/clients/lsp/client-internals.test.ts` (13 tests): `handleNotifyOpen` (first open, re-open, pending opens, clear diagnostics, skip when not alive), `handleNotifyChange` (didChange when open, fallback to didOpen, clear stale diagnostics, skip when not alive), `clientWaitForDiagnostics` (immediate resolve if cached, resolve via emitter, timeout, ignore other files)
- **Runtime event flow test fix** — added missing `gatherCascadeDiagnostics` mock export to `tests/clients/runtime-event-flow.test.ts`
- **LSP launch tests** — `tests/clients/lsp/launch.test.ts` (8 new tests): `isCmdShimValid` unit tests (target exists/missing, non-npm shim, unreadable file, `.mjs` extension), early `.cmd` shim rejection without spawning, `.ps1` bypass to `.cmd` sibling, `.ps1` fallback to direct `node <js>` execution
- **Tree-sitter hoisted-install tests** — `tests/clients/tree-sitter-client-init.test.ts` (3 tests): wasm resolution via `require.resolve`, `locateFile` directory derivation, `findGrammarsDir` external package resolution

### Refactored

- **Extract `detectFileChangedAfterCommand`** — moved from `clients/pipeline.ts` to `clients/file-utils.ts` and exported for reuse/testing; imported back into `pipeline.ts`; `tests/clients/autofix-helpers.test.ts` now imports the real function instead of reimplementing a copy
- **Export testable pipeline helpers** — exported `hasEslintConfig`, `hasStylelintConfig`, `hasSqlfluffConfig` from `clients/pipeline.ts` so config detection is testable
- **Export LSP client internals** — exported `clientWaitForDiagnostics`, `handleNotifyOpen`, `handleNotifyChange`, and `LSPClientState` from `clients/lsp/client.ts` for direct testing with mocks
- **Export `isCmdShimValid`** — exported from `clients/lsp/launch.ts` so the npm `.cmd` shim validator is unit-testable

### CI

- **Dead-code gate** — `lint-and-typecheck` job now runs `tsc --noUnusedLocals --noUnusedParameters --noEmit` alongside `--noEmit` so dead code regressions fail CI immediately

## [3.8.29] - 2026-04-21

### Added

- **New diagnostic commands** — added `/lens-tools` and `/lens-health` for system visibility:
  - `/lens-tools` — shows tool installation status: globally installed, pi-lens auto-installed, or npx fallback
  - `/lens-health` — shows runtime health: pipeline crashes, slow runners, diagnostic stats
  - Both provide actionable visibility into the pi-lens toolchain
- **Streamlined ast-grep skill** — reduced skill from 7,759 bytes to 2,313 bytes (~70% reduction):
  - Removed verbose CLI tips and YAML rule authoring sections (agent uses tools, not CLI)
  - Removed redundant testing documentation
  - Kept essential: Golden Rules, Quick Reference, Common Gotchas
- **Configurable log cleanup** — automatic retention and rotation for `~/.pi-lens/*.log` files:
  - Environment variable `PI_LENS_LOG_RETENTION_DAYS` (default: 7) — days to keep log files
  - Environment variable `PI_LENS_MAX_LOG_SIZE_MB` (default: 10) — max size before rotation
  - Runs automatically on session start, notifies when cleanup occurs
  - Rotated backups (`.log.*`) cleaned after retention period
  - Project-level logs (`{cwd}/.pi-lens/*`) intentionally excluded from cleanup

### Changed

- **`/lens-tools` output improved** — added explanatory note when GitHub-release tools are shown as missing: "GitHub-release tools auto-install when you open files of those languages"
- **Simplified agent prompts** — removed verbose prompt sections to reduce token burn:
  - Removed startup notes about project rules count (now just logged, not shown)
  - Removed tooling hints for missing language tools (Go/Rust/Ruby install suggestions)
  - Removed project rules section from system prompt (no longer injects `## Project Rules` block)
  - Updated core guidance to clarify: automated checks run on edits/writes, blocking errors shown inline must be fixed
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

- **Biome VCS/ignore file errors eliminated** — disabled VCS integration in biome config to prevent "ignore file not found" errors:
  - Changed `vcs.enabled: true` → `vcs.enabled: false` in `config/biome/core.jsonc`
  - Biome was searching for `.gitignore` files that don't exist when running on arbitrary projects via pi-lens
  - Eliminates biome:parse-error spam in logs when biome runs outside its config directory
- **LSP server thrashing eliminated** — added 240s idle timeout to prevent repeated LSP shutdown/startup cycles:
  - New `scheduleLSPIdleReset()` in `runtime-turn.ts` defers server reset when no files modified
  - Cancel pending reset when active editing resumes (avoids interrupting workflows)
  - Eliminates ~1-2s cold-start penalty during active development sessions
  - Debug logging added for scheduling and cancellation events
- **Biome check runner JSON parsing** — fixed error where biome's stderr warnings broke JSON parsing:
  - Changed from parsing `stdout || stderr` to parsing `stdout` only
  - Biome outputs text warnings (e.g., "couldn't find ignore file") to stderr which broke the JSON parser
  - Fixes biome-check-json runner failing with parse errors instead of providing lint diagnostics
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
- **Secrets scanner false positives** — fixed incorrect flagging of environment variable name references (e.g., `"FIREWORKS_API_KEY"`, `"AWS_ACCESS_KEY_ID"`) as hardcoded secrets:
  - Added word boundaries to `hardcoded-secret` regex pattern
  - Added `looksLikeEnvVarName()` filter to skip UPPERCASE_SNAKE_CASE values
  - Prevents false positives when env var names are used as placeholder strings

### Changed

- **Biome check performance** — reduced lint latency from ~1.4s to ~100ms per file (92% improvement):
  - Removed redundant `--version` pre-check spawn (~200ms saved)
  - Switched from `biome check` to `biome lint` command (skip format validation)
  - Added binary path caching per cwd to avoid repeated fs checks
  - Benchmark: 107ms average vs 1400ms baseline
- **Tree-sitter performance** — reduced structural analysis latency by 30-50%:
  - Execute queries in parallel with concurrency limit of 6 (was sequential)
  - Skip entity snapshot extraction for changes under 5 lines (~500-800ms saved for trivial edits)
  - Reduces tree-sitter latency from ~3s to ~1-2s for typical files

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
