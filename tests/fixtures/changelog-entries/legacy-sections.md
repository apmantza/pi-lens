# Changelog

## [4.4.9] - 2026-11-05

### Added

- **Built-in Groovy language server row.** `.groovy`, `.gvy`, `.gy` and `.gsh` files get a `groovy` LSP row for `lens_diagnostics` (`source: "lsp"`) and `lsp_navigation`. groovy-language-server publishes no release, so nothing is downloaded: pi-lens runs a `groovy-language-server` launcher from `PATH`, else `java -jar` on the jar named by `GROOVY_LANGUAGE_SERVER_JAR` (build it with `./gradlew build`), on a JDK 17 or newer found the way the Java server finds one. The server publishes only for files with errors, so a file it stays silent for reads `inconclusive`, never clean; a held empty publish no longer erases an error it just reported. `.gradle` and `Jenkinsfile` stay out unless configured under `lsp.servers`. (#5123)

- **Shorter extension update notes** — pi's Extension Updates view now reads the latest five GitHub release summaries, each with a full-notes link.

- **Groovy is a file kind (refs #5235)** — `.groovy`, `.gvy`, `.gy` and `.gsh` files, plus `Jenkinsfile`, `build.gradle` and `settings.gradle`, now classify as `groovy`, and the four extensions are selected by `lang:groovy` in `symbol_search`. The `symbol_search` `lang:` filters also accept named files (the three Groovy names, `Dockerfile`, `Makefile`), and the index collects them (#5273). The four extensions announce `groovy` to the language server; the three names have no built-in server, so writing them prints no "analysis unavailable" warning (the language-server lane reports not applicable for any file no server selects). On an adopted analysis root, a write to a file whose every planned runner the root refuses now reads "not analyzed" instead of "clean" (every kind, not only Groovy). Linting, formatting and structure for Groovy are separate slices of #5235.

### Changed

- **`lsp_navigation` returns Neovim-style text by default (refs #1449)** — the tool and its MCP mirror `pilens_lsp_navigation` now answer with the text a Neovim LSP user sees: a `path:line:col` location list for definitions, references and call hierarchy, `hover` markdown, an indented `start-end kind name` symbol tree, `path:line:col: severity: message` diagnostic rows, and the rename summary. Pass `view: "json"` for the structured envelope from #261, unchanged; any other value falls through to text.

- **`high-complexity` now checks JavaScript files.** `.js`, `.jsx`, `.mjs`,
  and `.cjs` functions, and the `.mts` and `.cts` TypeScript modules, get the
  same cyclomatic and nesting warning as `.ts` and `.tsx`. One per-function
  metrics table per language now feeds the rule, the review graph, and the
  complexity report. Cognitive and nesting scores in `/lens-tdi` and the
  complexity report drop, because a `case` or `match` arm no longer scores on
  its own and a function no longer counts as a nesting level. Stored history
  keeps the old scale until each file is re-measured. A Python lambda now
  counts once, and a Python `except` counts as a decision. A code file with no
  metrics table (Java, Kotlin, C, and others) records one
  `function-metrics-language-unsupported` degradation per language per
  session.
  (closes #5086)

- **`module_report` view is now a preset** — `view` names projection ×
  format: `summary-text` (default, metrics off, text), `summary-json`,
  `full-text`, `full-json` (every field, JSON). Applies to `module_report`
  and `pilens_module_report`. The text cell mirrors its JSON payload field by
  field (metrics as `cx:`/`fan:` suffixes, flags per bracket, `used-by:`
  lines, `IMPORTS:` / `CALL GRAPH:` / `BLAST RADIUS:` blocks, `PROVENANCE:`
  footer), with one declared exception: a member's own `exported` flag rides
  on its container's section and has no member-level marker. The stale
  `summary` / `default` / `compact` names fall through to the default, and a
  `maxRefsPerSymbol` argument promotes the projection to `full`. MCP no
  longer wraps the payload in a fenced JSON block.
  (refs #5137)

- **`project_report` returns a line-oriented text report by default (refs #5150)** — the tool and its MCP mirror `pilens_project_report` now answer with the compact text cell on every path, warm or cold, so the first tool an agent calls no longer spends a full JSON document on an orientation read. Pass `view: "json"` to get the same engine document as before, byte-for-byte; any other value falls through to text. The MCP warm path also stops appending a fenced JSON copy and reports staleness in its own trailing block.

- **Pi 1.5 is supported:** the tested pi range now runs from 0.86.1 up to, but not including, 1.6.0.

- **Codemode scripts receive pi-lens notes in the tool text (corrects #3832)** — A codemode script gets each pi-lens tool's joined text, including the notes pi-lens appends to it, such as a blocker note. The #3832 entry said scripts get raw output without those notes. That holds only for a tool that declares an `outputSchema`, and no pi-lens tool declares one, so a script gets text and never `details`.

- **Extension update notes show counts, not headlines** — pi's Extension Updates view now lists each new release as its heading, one line counting its features, fixes and other changes, and a full-notes link. (refs #5264)

### Fixed

- **A turn worklist owned by a process pi-lens may not signal is no longer handed to the next writer (refs #4907)** — the turn-state owner check read a permission error from `process.kill(pid, 0)` as "owner gone", so a live foreign worklist was reported `available`. It now shares the one pid-liveness check (`clients/pid-liveness.ts`) with the instance registry, the install lock, the bounded pid-file lock and the generation lock, which read that error as alive.

- **A partial edit apply now reaches other extensions' pre-write guards (closes #5120)** — When some edits of a batch matched and others did not, pi-lens wrote the matched edits itself from its `tool_call` handler, so an extension loaded after pi-lens never saw those bytes and could not refuse them. pi-lens now narrows the call's `edits` to the matched ones and lets pi's own edit tool write them, so every later `tool_call` handler sees exactly what will be written. The agent still gets the `⚠️ PARTIAL APPLY` message, now on the edit's own result. What changes for sessions with several extensions: a guard loaded after pi-lens is shown the narrowed batch, not the agent's full one, and can refuse it. A guard loaded before pi-lens still sees only the agent's batch, because pi does not re-run earlier handlers. The narrowed batch also goes through pi-lens's own read checks, so an edit to a file the agent never read is refused before anything is written. If the file changed after the check, pi's edit refuses the whole batch and the agent is told nothing was written.

- **An unknown id in `lsp.disabledServers` is reported and dropped.** A misspelled server id used to stay in the deny list with no notice and match no server, so a server you meant to turn off kept running. pi-lens now prints one `PILENS_CFG_0005` notice per unknown id, as `dispatch.disabledRunners` already does. Built-in server ids and servers declared under `lsp.servers` stay valid. (refs #5141)

- **PowerShell scripts with a UTF-8 BOM no longer get false syntax errors.** PowerShell Editor Services reported them because pi-lens sent the file's leading U+FEFF to the server as document text, which the server parses as a token. It now sends one space in its place, so every column and line ending stays where it is, and the file on disk is not touched. Other language servers receive the text as before. (refs #5151)

- **Headless sessions exit after an LSP server stops mid-message.** Disable the unused vscode-jsonrpc partial-message timeout before listening so no pending tick delays teardown. Thanks to SlanyCukr for the analysis. (#5169)

- **LSP timeouts now remain visible to navigation consumers instead of appearing as empty results.** Distinguish silent push deadlines from genuine empty answers, disclose partial diagnostics, and persist symbol lookup failures and outer deadlines.

- **`PI_LENS_DISABLE_TOOL_INSTALL=1` now stops the lazy installer, govulncheck and `npx` downloads too (#5231)** — with the switch set, `gem install rubocop`, `rustup component add clippy|rustfmt`, govulncheck's `go install` and the `npx @biomejs/biome` probe were still spawned or still downloaded, because only the managed installer read it. The first three now answer "unavailable" without spawning and record one `install-disabled` degradation row per tool per session; `npx` runs offline (`npm_config_offline=true`), so it uses npm's cache or fails. `PI_LENS_DISABLE_LSP_INSTALL` is read through one shared helper as well, with no behaviour change.

- **Keep unsupported shell dialects out of the Bash LSP.** Files named `.sh` or `.bash` now use the same shebang and `shellcheck shell=` dialect decision as the CLI runner, so zsh files no longer reach the Bash language server (follow-up to #3969).

- **A fixed or deleted file's blocker leaves the session listing and the footer (refs #5020)** — a chart-wide or import-following runner (helm-lint, helm-render, mypy, phpstan, cue-vet) reports a row for a file it was not dispatched for, and the widget store lists it under the file you wrote. The commit gate already retired its copy of that row (#5033); the widget's copy stayed until the written file was next edited. The row now records the file it cites and leaves with the gate's, at the same point. Rows persisted by an older build have no cite and are kept.

- **A blocker withheld from a script-written file now reaches the agent when its check runs long (closes #5108)** — when a file the agent wrote through a script was checked by a slow first-run analyzer (a cold Pyright, say), pi-lens stopped waiting after 10 seconds and the finding it had withheld reached nobody. The check now tells the agent at its next turn that it finished late, which file holds blockers, and where to list them, once per file.

- **`symbol_search` `ext:` filters now match compound suffixes (closes #5136)** — an `ext:` value matches by path suffix, so `ext:test.ts`, `ext:.ts` and `-ext:test.ts` behave as a reader expects for `.test.ts`, `.spec.ts` and `.d.ts` files.

- **Unknown `severity` or `read_symbol` `kind` now fails loudly instead of returning a wrong answer (refs #5138)** — `lens_diagnostics` and `lsp_diagnostics` reject a severity outside `error`, `warning`, `information`, `hint` and `all`, naming the accepted tiers, instead of silently disabling the filter and returning every finding. `read_symbol` rejects a `kind` that matches no candidate, including on a callback handle such as `run.resetLSPService@3`, rather than falling back to a symbol of another kind. An unreadable file or a kind mismatch now answers `Could not inspect <file>: <condition>` on the pi tool and on `pilens_read_symbol`, so neither reads as `Symbol ... not found`.

- **Stale-build advisories no longer break `-json` payloads (closes #5159)** — when the warm build went stale, the `warmCodeStale` advisory was appended to the last text block, so every JSON cell (`module_report` `*-json`, `project_report` `view:"json"`, `lsp_navigation`) stopped parsing exactly when an agent most needs to read it. JSON cells now carry the advisory (and any ignored-arguments note) in their own trailing annotation blocks, leaving block 0 parseable. Text cells are byte-identical.

- **Cursor's replayed edit cards are no longer refused "Edit without read" (refs #5160)** — pi-cursor-sdk replays Cursor's native work as display-only tool calls (ids prefixed `cursor-replay-`) after the files are already written. pi-lens learned the neutral `cursor` replay tool as a mutating tool and then refused every later one, turning each Cursor edit card red. Calls with that id prefix are now never armed for learning, never classified from a learned name (a `cursor` entry already saved in `observed-mutating-tools.json` is ignored for them) and never checked by the read guard, including replays shown as built-in `edit`. They take no before/after diff of the project either, and a replayed `edit`, `write` or `bash` no longer re-records another writer's change as the agent's own write. Real `edit` and `write` calls, Cursor's real bridged executions (`cursor-pi-bridge-*`) and tools that really mutate are checked as before.

- **Late authored findings still block commits.** Checks that finish after the tool-result wait expires now record their blockers and disclose them through the writing session's advisory queue; their findings rows no longer claim inline delivery when either the host's wait or the inner analysis wait discarded the result. (#5165)

- **A nearer config no longer re-enables rules you disabled.** `rules.<id>.disable` is now the union of the global, project and nested `.pi-lens.json` lists, so a project or `pkg/.pi-lens.json` that lists one rule keeps the rules the global or root config disabled. A non-string entry in the list is dropped instead of throwing in the rule filter. A global config always reports it with a config notice (#5232).

- **Applied `ast_grep_replace` and LSP rename or command edits are now checked like an `edit`.** This covers an `lsp_navigation` rename, `rename_file` and `executeCommand`. The files they write go through dispatch, so a blocker the write introduces reaches the turn-end check and `git commit` under `--lens-guard` refuses it, and a multi-file apply is no longer cut short by the read-only tool-result wall (#5239, #5248).

- **An unresolved 🔴 blocker now names itself again at the start of each later prompt (refs #5240)** — the turn-end check reached the model in one request only, and a blocker from a nested write (a codemode script that drops the STOP note) never entered the transcript, so the model saw it once. A duplicate turn end now stages the blockers alone, headed "Still unresolved (already reported on an earlier turn, not new)" and ending with the `lens_diagnostics` call that lists every blocker, and pi takes it at the first request of the next prompt. Requests inside one prompt, resolved blockers, `--no-lens-context` and blockers already retained under `--lens-retain-injections` repeat nothing.

- **Structural `ast_grep_replace` rules now work when your project has no `@ast-grep/cli` (closes #5247)** — a replace using `insideKind`, `hasKind`, `hasDescendantKind`, `follows` or `precedes` failed with `npm ERR! canceled` or `unexpected argument '--no'` because its rule scan ignored the ast-grep binary pi-lens had already found or installed. The scan now runs that binary.

- **A non-string entry in `rules.<id>.select` no longer throws in the rule filter.** `select` now drops a non-string member, or a value that is not an array, the same way `disable` does, and the valid entries keep their effect. A global config reports each one with a `PILENS_CFG_0005` notice. A project or nested file reports a value that is not an array, or a list whose members are all dropped, with the same notice, and drops a non-string member beside a valid string without one. A blank entry is dropped from `select` and `disable`, so a blank-only `select` no longer hides every rule, and a padded entry such as `" ra "` names its rule (#5250).

- **A failing vitest 5 test no longer reads as passing or clears the `--lens-guard` blocker (closes #5257)** — vitest 5 writes its JSON report to a file instead of stdout, so every per-edit test run came back unreadable and was counted as "all tests passed". pi-lens now asks vitest for the report file, treats output it cannot read as a runner error, and clears a test-failure blocker only for a test file that ran and passed at least one test.

- **A write no check covered no longer reads `✓ … clean`.** The per-edit line and the footer said clean for a TypeScript file under `--no-lsp`, a `build.gradle`, a generated file and a file whose kind has no analyzer, because the clean line was the default of a missing field. Every producer of a dispatch result now states a required `verdict`, `checked` only from the runners that completed a full read, and an unchecked write names its reason (`⚠ … unconfirmed — <reason>`); a collect-later primary still running reads unconfirmed too, once per file per session. The footer counts only files a check could have covered: a kindless or generated file says so on its write line and never adds to `⚠ N unchecked` (refs #5258).

- **A failing test result reaches the model at the next prompt**: a run that finished after the agent did, or a newer run that was still going or finished before the next prompt, used to hold the failure back until the run after (#5259). A run that finishes while the agent is working still waits for that run to end.

- **The tree-sitter rule batch is no longer compiled again on the second dispatch.** The first dispatch in a project and every later one gave the batch two identities for the same rules, so each project paid the batch compile twice. On the hot-path sample's large input, the second dispatch drops from about 590-640 ms to 280-330 ms (refs #5260).

- **A pytest run with errors beside passes no longer reads as passed (#5270)** — `1 passed, 1 error` (a fixture or collection error) was counted as a clean pass and cleared the `--lens-guard` test-failure blocker. pi-lens now treats pytest's `error` count, and exit 3 (an internal error or `pytest.exit`), as a runner error, and no longer falls back to vitest's stdout when the report file is missing. A passing run that exits 1 for its own threshold (`--cov-fail-under`) still reads as passed.

- **`symbol_search` now indexes named files.** A `Jenkinsfile`, `build.gradle`, `settings.gradle`, `Dockerfile`, `Makefile`, `CMakeLists.txt` or `terragrunt.hcl` was never in the word index, because the source walk admitted files by extension only, so `lang:groovy` had nothing to return for a `Jenkinsfile`. The index build and its incremental refresh now keep these names after the usual ignore and generated-file checks. Review graph, project diagnostics, the language profile and the TODO baseline keep their extension-only walk. (#5273)

- **An unknown or wrong-typed config key now prints its own code, not `PILENS_CFG_0001`.** A misspelled key such as `lps` prints `PILENS_CFG_0004`, and a value the schema rejects such as `format.mode: "nonsense"` prints `PILENS_CFG_0005`. `PILENS_CFG_0001` now means only that a config file is unreadable, unparsable, or not a JSON object. If you filter on `PILENS_CFG_0001` to hide these notices, filter on `PILENS_CFG_0004` and `PILENS_CFG_0005` as well, because the typo notices move to those codes. (refs #5140)

- **LSP navigation now reports request timeouts as errors instead of empty results.** Preserve timeout details when tools reuse a service across module evaluations. A definition timeout still tries the local documentSymbol fallback and discloses the timeout when recovery succeeds.

- **Vulture failures show the exception.** Python dead-code scan summaries and degradation reasons retain the last stderr line instead of the traceback header.

### Security

- **An untrusted project can no longer set `args` or other launch fields of your LSP servers (#5147)** — a `.pi-lens.json` from a project pi has not marked trusted could set `lsp.servers.<id>.args` for a server declared in your global config, and the flags reached the server's argv. Without trust a project may now set only `name`; if it sets any other field (`args`, `rootMarkers`, `covers`, `extensions`, `env`, `initializationOptions`, `command`, `enabled`, `role`, or a field pi-lens does not recognise) on a server, that server is not started for the project, so a repo cannot start your server on flags it chose or with your own flags stripped. A refused field under `lsp.serverOverrides` drops only the project's fields: your own global override for that built-in still applies, wrapper `command` included, and the built-in stays on. A server entry with no `extensions` list (such as `{"name":"x"}`) is no longer registered, so it cannot make server selection throw `server.extensions is not iterable`. One `lsp-registry-decision` record per field says so. A trusted project and a global-only config behave as before.

### Internal

<details>
<summary>29 internal changes: tests, CI, tooling, and refactors</summary>

- The slowest test files run faster: the route-matrix, MCP smoke, pre-push, lane-check and head-move files are split by describe over shared `tests/support` kits, the 4320, 4322 and s7 diagnostics cases wait less, the stryker-diff case spends its budget with a clock offset instead of sleeping, and the guard-bash corpus case spawns its hooks four at a time. No test was dropped; the shard weights for split files are apportioned from local ratios until CI regenerates them. (refs #3801)

- Sixty-five scripts decided "am I the entry module?" with a private copy of the gate that compared the module URL with the symlink-preserving `process.argv[1]`, so a script started through a linked path exited 0 without running: `check-changelog-fragments`, `check-pr-body` and `ci-verdict` passed without checking, and the `guard-bash` hook allowed `git stash`. They now call `isMainModule` (the `guard-bash` hook keeps a standalone realpath gate, because the probe loads it from a git ref), and `tests/config/script-entry-portability.test.ts` refuses any new private gate. (refs #4096)

- The Stryker nightly no longer launches a sampled range whose verified count alone exceeds the affordable mutant allowance. A retry or a first sample now takes the next-ranked range that fits, and when none fits it reports a zero-mutant outcome without launching Stryker. A failed count pass still launches its range unverified (refs #4171).

- PR-time CodeQL runs again on pull requests that leave `formal/` alone. `heavy-gate` reached the skipped `tla-shards` job through `tla-models`, so implicit `success()` skipped the gate and CodeQL. The gate now reads `TLA+ models` from check-runs and needs `Unit tests Windows`. The ten required contexts live in one list, `BRANCH_PROTECTION_CONTEXTS`, and the stale docs and pins that said eight now match. (refs #5002)

- A pushed pull request posts four fewer CI check rows with the same coverage: the skipped `Classify failed Unit tests` and `Finalize CI rerun classification` rows are gone, `actionlint` and `markdownlint` are steps of one gating `actionlint & markdownlint` job, and the boundary check moved into the required `Lint & type-check`. Required check names are unchanged. (refs #5002)

- A pull request posts fewer CI check rows with the same coverage: vale, jscpd, complexity, strictness, yamllint, typos and taplo are steps of one `Lint (advisory)` job, `PR title` and `Close-keyword syntax` are steps of one gating `PR metadata` job, and OSV scan starts from a `paths:` filter instead of a detect job. Required check names are unchanged. (refs #5002)

- The nightly LSP-docs refresh PR and the idle-eviction promotion PR opened with bodies that had none of the PR template's sections (and a flips fence over the 20-line cap), so `PR body (advisory)` was red on every bot push; both composers now write the template sections with docs-only answers, and `tests/scripts/bot-refresh-pr-body-lint.test.ts` runs them through the real body lint. (refs #5062)

- Count fake-LSP support routes and AstGrepClient constructions in the interim real-process-spawn census, with explicit non-spawning exemptions and serialized admissions (refs #5100).

- The cascade's changed-symbol references calls stay serial (refs #5174). Overlapping them was measured on tsserver and dropped answers under one shared 750 ms window, so the loop keeps one call at a time and a test pins that all three symbols come back.

- The read guard's three oldText autopatch span matchers (blank-line, interior-whitespace and Unicode-punctuation tiers) are one `findSignatureInsensitiveCandidate` called with a per-tier line signature, so a safety edit to the unique-match or two-anchor rule reaches every tier; recovered spans are unchanged (refs #4907).

- Route Stryker to the root minimatch 11.0.4 dependency, removing its vulnerable nested 10.x copy (#5204).

- `npm run check:lockfile` refuses a `libc` field that vanished from a package that stays in the lock, judging what the commit records: the staged blob from Git’s exported commit index (including temporary indexes for `-a` and path commits), the working copy when the index holds no change for it, and the merge base with `origin/master` when the commit records `HEAD`'s bytes unchanged. The refusal names both sides it compared, `package.json`'s `packageManager` pin and the `npx npm@11.18.0 install --package-lock-only --ignore-scripts` regeneration. npm older than the pin writes no `libc` field, so the pre-commit hook catches the drop that a PATH npm 9.2 made all 56 of in #5200; a `git show` failure the gate cannot classify refuses the run instead of reporting `not checked`. (refs #5207)

- The PR body lint's `## Summary` refusal now states the counted sentences and which line each one sits on, such as `4 counted sentences (3 in the summary, 1 in the Remaining line)`, and `.github/PULL_REQUEST_TEMPLATE.md`, `docs/pi-lens-fixer.md` and `docs/pi-lens-merge-policy.md` say that counted sentences in the `Refs #NNN`, `Remaining #NNN:` and `Closes #NNN` lines count toward the three-sentence cap. (refs #5208)

- The `Lint (advisory)` prose step runs Vale on the Markdown a pull request adds or changes under the prose paths, not on the whole docs tree every PR inherited. A PR with no such change skips the step with a notice. An unreadable diff, a change to a lint config file (`.vale.ini`, `.vale/styles`, the workflow or the selection script) and push or merge-queue runs lint the whole list. Google.DateFormat is off in `.vale.ini`, since pi-lens docs write ISO dates on purpose. (refs #5249)

- CI runs less often and opens fewer PRs. CodeQL scans once a day (and on dispatch) instead of on every master push and every pull request, so a new alert surfaces on master up to a day after its change; Dependabot groups minor and patch bumps per dependency type, security updates, and GitHub Actions bumps. (refs #5275)

- **Dead exports removed for the knip 6.44.1 bump (refs #5289)** — `summarizeWorklog` and its `WorklogStats` type (`clients/fix-worklog.ts`), `safeSpawnBatch` and the deprecated sync `isCommandAvailable` (`clients/safe-spawn.ts`) had no caller and are deleted with their sweep rows; `clients/lens-engine.ts` drops its unused re-exports of `projectModuleReport`, `renderCompactModuleReport` and four `ModuleReport*` types, which tests import from `clients/module-report.ts` directly. `resetUtf8ConsoleCodePageStateForTests` stays as the review-kept test seam (#1201), marked `@public`.

- The #3748 advisory witness ends the sessions each case starts, so the `ast-grep lsp` child its adopted-project `tool_result` spawns no longer outlives the test worker. A per-case census reds any such child the worker still owns (refs #5146).

- The #3748 advisory witness census polls, for at most 2 s, for the `ast-grep lsp` children its sessions own to leave, because the fast POSIX shutdown sends SIGTERM and returns before the child exits. A child that never leaves still reds, with the same pid list (refs #5146).

- The test files that start sessions on the pi double now end them through one shared `endMockSessions` teardown, so no `ast-grep lsp` child outlives its file and reaches the orphan sweep of a later file. The double reports every session its handlers saw, and a case that ends with one still open reds, whichever route started it (refs #5146).

- The nightly test-history download pages the artifact listing at 30 a page and parses it in node. CI printed only `unexpected end of JSON input`, with no status; an orchestrator probe on #5154 (comment 6559081169) saw HTTP 500 on the 100-a-page listing, intermittently, so a listing error now reports gh's HTTP status when gh prints one (refs #5154)

- The macOS APFS anchor fixtures now compare kernel-resolved temporary roots, and the advisory floor reds when its JSON report records failed tests (refs #5217).

- Keep Vitest's filesystem module cache separate for each worktree.

- oxfmt moves from 0.74.0 to 0.75.0, and the seven files it now wraps differently are reformatted in the same change. Formatting only; no code meaning changes. (replaces dependabot #5189)

- **Remove the frozen pre-#5150 `project_report` compact renderer (refs #5168)** — `renderCompactProjectReport`, `ProjectReportOptions.view`, `ProjectReport.view` and the engine `view` plumbing are production-dead after #5150 made the default text cell; the pi tool and the MCP mirror never passed `view` to the engine (their `view:"json"` hatch is tool-local). No observable change.

- The eight `pi.events` publish functions (`publishFilesTouched`, `publishDiagnostics`, `publishDisposition`, the four format and autofix events, and the lens events) now run one `createBusPublisher` path in `clients/live-bus-emitter.ts` instead of eight hand-copied bodies; the rows, latches and `dbg` lines they write are unchanged, and the bus-row writer is private to that seam (refs #4907). The read-only facade is named `bus-event-rollup.ts`, keeping it outside the NDJSON writer naming population.

- SpotBugs' `-output` file, PSScriptAnalyzer's `-File` script and the ast-grep baseline scratch directory now take their parent from `scannerReportParentDir()` instead of a bare `os.tmpdir()`, so a harness-owned scanner root also catches what a killed run strands; production still writes to `os.tmpdir()` (refs #4907).

- Five hand-rolled "race a promise against a timer" waits (the runner budget in `runRunner`, `getOpenDocumentSymbols`, the quiet-window heartbeat sample, the session-start sequence read and the analyze CLI's stdin read) now call `withBudget`, and the `hand-rolled-race` scan reads `Promise.race<T>(`, aliased, destructured and computed references instead of only the bare call, which registers the client-wait race in `clients/lsp/index.ts` that it could not see (refs #4907).

- The generated-header memo test in `source-filter-async.test.ts` now proves the memo through the verdict a re-read would flip, not a cold/warm wall-clock ratio that a loaded shard could invert (refs #5148, #4909).

- Five test cases that could not fail for the defect they name are rewritten or removed (git-fixture-env wrappers and TypeScript twin, a MIN_GH_TIMEOUT_MS constant check, a drift-issue constant check, a PowerShell BOM diagnostics echo); each has a mutation red or a named sibling that reds under the same mutation (refs #4907).

</details>

## [4.4.8] - 2026-11-01

### Added

- **`dispatch.disabledRunners` turns a dispatch runner off** — list runner ids such as `["dotnet-build"]` in `~/.pi-lens/config.json` or a project `.pi-lens.json` and pi-lens never runs them, so no `dotnet build` (or other tool) is spawned while the language server and every other runner in the group keep working. The list is a denial, resolved like `lsp.disabledServers`: the union of every tier, so a project can add a runner but never re-enable one you denied. A disabled runner is recorded as skipped with the reason `disabled-by-config`, not as a failure, and a fallback group moves on to its next runner. A nested `.pi-lens.json` governs the files under it. When config denied every checker that could not answer, the coverage notice and status line name `dispatch.disabledRunners` once per session; when a sibling also failed, they name the failure and the denial together. An id that names no runner is dropped with a `PILENS_CFG_0005` warning that quotes it (bounded like every config notice) and counted in `effective_config`'s `recordCounts`. `effective_config` shows the runner as `disabled-by-config` with the tier and file that denied it. `dispatch.runnerTimeoutFloorMs` stays global-only and a project file that sets it is now told so. `rules.<id>.disable`, `select` and `ignorePaths` now follow the same owner: each file reads them from the nearest `.pi-lens.json` at or above it, on every surface that filters by them (dispatch, `lens_diagnostics`, `lsp_diagnostics`, the turn-end advisories), and the root's policy still reaches nested files. A nested `ignorePaths` glob is relative to its own file's directory (refs #5010).

### Changed

- **`rules.<id>.ignorePaths` now matches like the `ignore` field** — entries follow gitignore rules, relative to the `.pi-lens.json` that declares them: the last matching entry wins, `!` re-includes a path an earlier entry carved out, a leading `/` roots the entry at that file's directory, and a trailing `/` names a directory. Before, every entry was a plain glob, so a `!legacy/keep.ts` entry hid every path its glob did not name, and `/legacy/**` and `legacy/` matched nothing. Entries with a slash keep their meaning; a slashless entry such as `*.gen.ts` now also matches below the root, and a line starting with `#` is a comment. Each config file stays its own scope, so a `!` re-includes only against its own file's entries and never lifts a carve-out another file (or the global config) declared (refs #5029).

- **`ast_grep_outline` returns a compact text tree instead of JSON** — one `77-81 export function name` line per symbol, range first like `module_report` compact, with project-relative file headers; the read handles, byte offsets, node kinds and empty signatures are gone, so a file outline is about 5x to 10x smaller. The measured default case, a 60-file directory outline, now fits the delivery bound instead of arriving cut in the middle; the default call is not promised to fit every directory, and `items: "all"` or `view: "expanded"` on a large directory still hit the cut, which keeps a visible marker. Files are sorted by project-relative path before the 50-file cap, and a `... N more files not shown` line says what was left out. Read a listed range with `offset=start`, `limit=end-start+1` (#5071, refs #1449).

- **Reducer copy and filter-map warnings change.** `no-accumulating-spread-js` now flags a reduce callback that copies its accumulator through `Object.assign`, `Array.from`, `concat` or `slice`, not only through a spread, and its message names the object case. `ts-redundant-filter-map` now warns only on identity filters (`filter(x => x)`, `filter((x: T) => x)`, `filter(Boolean)`), so a TypeScript `filter().map()` chain that warned before no longer warns. The new `filter-then-map` hint ships disabled. (refs #5093, refs #5094)

- **`symbol_search` and `pilens_symbol_search` emit one table, not a table plus the same hits as JSON (refs #5104).** The pi tool appended a compact `JSON.stringify` payload that repeated every hit, and the MCP mirror appended the same hits again as a fenced JSON block; neither carried anything the rows and footer cannot. `renderCompactSymbolSearch` in `clients/lens-engine.ts` now owns the text on both surfaces: a header, one row per hit — `  1. <path> <line> (score 0.82, 3 hit(s), fanIn 4)` — and a footer with index coverage, the MCP-only staleness note, and one next-step line naming the top-ranked hit (`module_report <path>` on pi, `pilens_module_report <path>` on MCP). Annotations print whenever the cached review graph supplies them, so `fanIn 0` ("no known importers") shows instead of vanishing. Measured on four `clients/` files, one query each, through `finalizeToolResultWithDelivery`: `bytes=3395` before, `bytes=1109` after. `details` keeps `{ available, query, count, coverage }`.

- **Twelve hand-rolled containment tests now share one `relativeInside` seam.** A runner diagnostic for the project's parent directory shows its absolute path instead of `..`, and a home directory named `..cfg` under a project directory ends the home-ceiling walk like any other (refs #2556).

- **A gitleaks or trivy scan that failed is no longer read as a clean scan.** A CLI that failed to spawn, whose run threw, or that exited non-zero without writing its report now leaves a `security-scan-report-failed` health row and a failed (not cached-clean) result, as opengrep and jscpd already did. Both scanners now share one report-scan body (`SecurityScanClient.runReportScan`), so their outcomes cannot drift apart (refs #4907).

### Fixed

- **A bash-only turn no longer labels its fresh turn-end findings historical (refs #4617).** The provenance stamp now speaks for every part the message carries: each file-bound producer registers the files its text reports (the stale-secrets tier, knip, dead-code, trivy's scanned dependency declarations, call-graph impact, the actionable and code-quality warning advisories, the demoted inline blocker, the cascade test suggestions), and a part with no file it could be stale against — a runner crash note, a suppressed-count notice — is stamped current for the turn that produced it. A part carried from an earlier turn, or one that declares neither, still reads "Historical finding; workspace changed since capture", and `tests/config/turn-end-part-provenance-census.test.ts` fails when a new turn-end producer declares nothing.

- **A blocker retires when the language server confirms the fix, even if a scanner stayed silent.** A partial language-server run now answers for the servers that answered: the primary's recorded blockers clear, while the unconfirmed auxiliary's own blockers stay pending and still hold the commit gate shut, and the coverage notice still names it. Every edit after the once-only notice keeps naming it too, instead of reading clean. The `🔴 Still unfixed` line also lists a short rule id per line (`L64 ts:6133`) and says how many counted blockers it cannot place — one whose line could not be re-placed in the new bytes, and one with no line in this file — instead of counting lines it no longer lists. (refs #5008)

- **A blocker stays recorded when the language server answers for older bytes.** When the server's findings were computed for an earlier version of the file, the edit no longer treats them as a verdict on the new bytes: they are not delivered, a blocker recorded earlier stays pending and keeps the commit gate shut, and the next edit checks again. Before, such findings retired that blocker even though it was still in the file. The turn-end re-check of carried warnings likewise keeps a warning, marked as not re-verified, when the server's answer was for older bytes. (refs #5017)

- **An attached session no longer reads another session's stale answer as current.** When a pi-lens session shares a running language server through another session (warm attach), that session's answer now says whether its findings describe the bytes on disk, and the attached session treats findings about older bytes the way a local one does: they are not a verdict, a recorded blocker stays pending, and the tool and sweep results show them as unconfirmed. An answer from a session on an older pi-lens build carries no such statement and is treated as not current until both sessions run this build. (refs #5030)

- **A helm chart beside a denied `helm-lint` no longer reads as a failed tool** — with `helm.renderValidation` off, `helm-render` reports a stated `not-enabled` skip, so the coverage notice for a chart file says the runner is disabled in config instead of "a language tool is missing, timed out, or failed to run". The file is still reported unconfirmed (#5042).

- **The bundled `minimatch` is updated to 11.x for GHSA-g3hv-75wg-m249.** The published package inlines `minimatch`, so scanners flagged the 10.2.6 copy for a crafted glob that amplifies `globParts` when `optimizationLevel` is 2 or higher. pi-lens never sets `optimizationLevel` (the default is 1), so no pi-lens glob reached the vulnerable path; the dependency is now `^11.0.1`, and the lockfile resolves 11.0.3. One gitignore-style entry changes: a final extglob that can match nothing, such as `dir/!(x)` or `dir/*(x)`, no longer hides the whole `dir/` directory from the walk. 10.2.6 pruned that directory, so this is a fix; 11 hides only the children the extglob matches. (closes #5129)

- **The cascade no longer reports neighbour errors computed for other file bytes**: the in-turn cascade showed "Cascade errors in N neighbor file(s)" for findings the language server computed against an earlier version of the file, while the diagnostics check already withheld them; the cascade now withholds those rows too, names the file as unconfirmed instead, and never reads the run as clean (#5051).

- **A `pi-lens-ignore` comment or a disposition mark now applies to the file a finding names**: a comment in the edited Helm template no longer hides the blocking `helm-lint` error reported on `Chart.yaml`, on the edit path, in a slow runner's late answer or in the turn-end blocker; a mark on one file's finding no longer hides the same finding on another file; a finding whose file cannot be read or lies outside the project is never suppressed; and a mark made earlier against the template path for a `Chart.yaml` finding stops applying, so that finding shows once until it is marked on `Chart.yaml` (#5044).

- **A directory whose name starts with `..` is no longer read as outside its project.** Ten containment tests compared `path.relative` text with `startsWith("..")`, so a file under `<root>/..pkg/` was classed outside the root: its nested `.pi-lens.json` was not read, a hosted LSP client was not reused, a Cargo workspace member kept its own root, a rendered Helm file fell back to Chart.yaml, a mirrored test was not found, a Knip or madge shim was labelled `global`, a stale finding was not retired, and the MCP turn-end route refused the cwd. They now share `isUnderDir`, `isWithinForm`, `isWithinPathForm` and `toProjectRelativePath` from `path-utils.ts` and `file-utils.ts` (refs #2556).

- **A `pip install` into a project `.venv` that keeps no lockfile now counts as an install**, so pyright's cached `Import "x" could not be resolved` clears on the next `lsp_diagnostics` call instead of lasting for the server's life. The look stamps each `.venv/<lib|Lib>/…/site-packages` directory beside the lockfile and `node_modules` markers (#4532).

- **LSP sees outside disk changes before `lsp_diagnostics` answers; a new subdirectory marker roots it (refs #4532)** — the look that reports a declaration, config or install change walked at most once every `PI_LENS_DECLARATION_LOOK_MS` (2 s), so a `.d.ts`/`.pyi`, a server config or an install made inside that window reached no server before the answer; the diagnostics answer now runs that look itself, with a forced walk (16 ms on a 688-directory repository, 0.12 ms on a small one). Separately, the project-boundary verdict was cached for the client registry's life, negatives included, so a marker created in a subdirectory after the parent's client answered never rooted it (real pyright 1.1.414: stale through 40 calls over 20.25 s); the verdict is now read from the disk on every resolution, and a deleted marker un-roots the directory again.

- **A subagent's deferred format runs in its own settle:** with an in-process subagent, a file it wrote through a tool pi-lens observes, `ast_grep_replace`, `lens_diagnostic_mark` or a background change found at settle is now queued under the subagent, and the subagent's own `agent_settled` formats it and its native edits. Before, the parent session formatted such a write as its own, and the subagent's native edits waited for the parent's 10-minute orphan claim. A subagent still never takes the parent's records or runs the actionable-warning quick fixes (refs #4943).

- **Upward walks start from the file's real path.** A file reached through a file link now reads its target's Cargo edition, package root, `node_modules` and metrics-history commit, not the link's neighbours; every hand-rolled climb in `clients/` now runs on `walkUpDirs`, and a test runs each walker from a symlink twin (refs #4966).

- **A demoted blocker now honours your marks and stops re-serving dead coordinates:** a `[stale — re-run to confirm]` advisory runs the same disposition policy as the live blocker channel, so a `false-positive` or `suppress` mark silences it, and a `self-drift` record the agent fixed by rewriting the file retires after `SELF_DRIFT_MAX_DELIVERIES` deliveries with a "re-run can still confirm" reason. A confirmed-clean verdict that covers only some of a record's sources now retires the source rows it spoke for instead of leaving the whole record, dead coordinates included, to re-serve for the rest of the session (refs #4990).

- **A fallback language server no longer confirms a file clean for a primary that never answered.** When the Python checker was refused (an adopted project's local binary), failed to start or was not installed, python-jedi answering with nothing read as "Primary LSP (python): confirmed clean". The file now reads unavailable and names the missing primary, for both server scopes, and says no primary language server answered; the fallback's own findings are still shown, on cascade neighbours too, except an answer computed for older bytes or published before the edit, which is withheld instead of blocking the edit. A neighbour's earlier errors stay listed as not re-checked while only the fallback answers for it (refs #5014).

- **A blocker row naming another file retires with that file (refs #5020)** — a helm-lint, helm-render or mypy row recorded against the written file now leaves once the file it names is written clean or deleted, so the commit gate no longer stays shut on a finding nothing can fix.

- **`ast_grep_replace` refuses a defaulted working directory at or above `$HOME`** — the mutating tool had the ceiling `ast_grep_search` already enforced, so a dry run from your home directory previewed, and an apply rewrote, files anywhere under it. Both tools now decide through one guard in `tools/shared.ts`, and `#5039`'s refusal names the offending cwd and asks for explicit `paths`. An explicit `paths` entry such as `.` is still honoured, as in search.

- **A Java edit now cascades to the files that import it.** The cascade used to skip Java files, so an importer broken by the edit was never reported. It now asks jdtls about each importer, delivers the errors it finds, and names an importer jdtls has not re-checked since the edit as unconfirmed instead of clean (#5040).

- **A cascade dependent whose only answer predates the edit no longer reads as clean**: a push-only language server that does not republish a dependent after the file it depends on changed could leave a broken dependent reported as a clean cascade; the run now names it unconfirmed instead.

- **An edit whose dependents the graph cannot place no longer reads as a leaf.** When a caller references a changed symbol by name alone and another definition shares the name, the cascade dropped the caller and reported no neighbours, the same verdict as a file nothing uses. It now reports the run as indeterminate and says a clean cascade result does not cover those files (#5055).

- **A blocker on a file a script wrote is no longer reported as clean**: when a bash heredoc (python, node) writes a file pi-lens cannot prove you authored, the tool result now names the file and the number of blocking findings it withheld instead of `✓ clean`, and when the host's 500 ms read-only bound abandons the check, the same disclosure reaches you at the next context call with the abandonment stated. The STOP block, autofix and the commit gate stay off for those bytes (#5108).

- **A diagnostics pass no longer rewrites your file under a project fix setting**: `ruff check` now runs with `--no-fix --no-fix-only` (a project `fix = true` or `fix-only = true` used to delete unused imports on save, even with pi-lens format and autofix off) and `golangci-lint run` with `--fix=false` (`issues.fix: true`) (#5119).

- **A markdownlint diagnostics pass no longer rewrites your file under `"fix": true`**: pi-lens now lints through `markdownlint-cli2`'s exported `main` with `fix` forced off, run in a small child process under the same 15 s budget, found beside the resolved command (project `node_modules/.bin`, the managed tool dir, or a PATH install), so a project `.markdownlint-cli2.jsonc` with `"fix": true` no longer deletes trailing spaces on save even with autofix off; config discovery, `extends`, `ignores` and `overrides` stay cli2's own, an edited `.cjs` config is read fresh, the autofix stage still fixes, and when no package sits beside the command the CLI is spawned as before and one `markdownlint-api-unavailable` row is recorded (a project `"fix": true` can still write on that path) (#5119).

- **`lsp.servers.<id>.command` accepts the argv array the docs show**: `"command": ["my-lsp-server", "--stdio"]` now launches (the first element is the program, the rest come before `args`, and no default `--stdio` is added) instead of failing with `The "path" argument must be of type string`, and `effective_config` shows such a server's command and argument count (#5127).

- **A custom server that recompiles on pi-lens's own file notice can no longer wipe a real error**: when a version-less `lsp.servers` server (groovy-language-server) published an error for a freshly opened file and then an empty set right after the `workspace/didChangeWatchedFiles` pi-lens sends for that file, the file read clean; that one empty publish is now held and the error stays, and a later edit still earns its own clean. Built-in servers are unchanged (#5131).

- **A second session's commit no longer writes the first session's blockers into its own record**: with `--lens-guard`, a commit by a concurrent session in another repository that picked up the first session's settled collect-later blocker recorded it in its own tree's commit-gate record under the first session's id, so every later commit there was refused `session_mismatch` for a file it did not own. The gate now persists only the committing session's own blockers in the committed repository, and a commit in one repository is no longer refused for a blocker in another, whoever wrote it. The other session's blocker still gates its own tree (#5048).

- **A custom language server that publishes late is no longer stuck as unsupported**: a custom push-only server that had not published by the end of the first-contact wait was latched diagnostics-unsupported for the whole session, so it never reported findings and one report could list a finding beside `unsupported=1`. A publish at any time now clears the mark, and a server that has not published reads as unconfirmed (`inconclusive`), not unsupported (#5128, #5123).

- **`path` is the one single-file parameter, and `paths` behaves the same on every tool**: `pilens_module_report {path}`, `pilens_diagnostics {file}` and `pilens_analyze {path}` now run instead of being refused or silently answering for the whole default scope, `effective_config` and `lens_diagnostic_mark` accept `path` while keeping their older `file`/`filePath` spellings, a non-string, blank or empty (`[]`) `paths` list, or one over 100 entries (`ast_grep_search` took 200 before), is refused with one message on every tool instead of being dropped, and `symbol_search` now scopes `src`, `./src` and the absolute directory to the same hits and clamps `limit` to `max(1, floor)` (#5041, #5038).

### Internal

<details>
<summary>32 internal changes: tests, CI, tooling, and refactors</summary>

- `node scripts/probe-save-verdict.mjs` measures, per server, whether a language server publishes its findings without a `textDocument/didSave` or only after one, through the real client on the tool-smoke fixtures. The nightly `tool-smoke` workflow runs it with `--install` and it regenerates the three measurement columns of `docs/lsp-capability-matrix.md`'s save-verdict table, merge-guarded so a runner that cannot install a server keeps that row, and an unmeasured row names the installer's own cause beside the reason no arm could measure it, while a tool the installer does not manage (its binary on the runner's PATH) is still measured. `tests/config/lsp-save-verdict-census.test.ts` pins the population, the verdict vocabulary and the rule that a verdict without provenance is refused. (refs #3405)

- A governance ast-grep suite (`scripts/governance-rules/`, `npm run astgrep:governance`, also run by `npm run astgrep:self-scan`) flags a test loop that waits by counting turns or polls and then checks a condition (defect shape 86), and a `*ForTests` hook in `clients/` that does the same. A real-clock deadline (`waitFor`) is the admitted form; 46 existing members sit in a reasoned, content-keyed baseline, and eight one-line members moved to `waitFor`. An `ast-grep-ignore` must name its rule and a reason. The LSP facade import sweep moved to oxlint's `no-restricted-imports`. (refs #4865)

- The tree-walk timeout census (`tests/config/tree-census-timeout.test.ts`) now scans every test under `tests/`, not only `tests/config`, so a tree walk without a timeout budget reds wherever it sits. The 87 refused members that predate the widening are admitted by name in `tests/config/tree-census-timeout.baseline.json`, each with a reason. (refs #4967)

- The session-state owner-key check now covers the file-level exemptions, the declared session stores, reset-less module containers, class fields bound to a container and containers held as members of a module-level object, so state the #4965 bugs sat in is no longer outside it. (refs #5027)

- `tests/clients/installer/managed-tool-refresh-strategies.test.ts` clears `GH_TOKEN`, `GITHUB_TOKEN`, `ZIZMOR_GITHUB_TOKEN` and `ZIZMOR_OFFLINE` for every case through `withEnv` and restores the caller's values afterwards, so a token exported in the environment no longer reds nine github cells. (#5073)

- `Targeted tests (advisory)` is gone from PR CI: its selection caught the failing file on 26.7% of real Unit reds (#3215), so the full Unit suite stays the only test gate. The changed-test shuffle (#4397) is now its own advisory job, `Changed tests shuffled (advisory)`, with only the setup it needs (refs #3215).

- `Hot-path latency (advisory)` now starts on every pull request and passes with "no hot-path files changed" when the diff touches none of `HOT_PATH_PATHS` (`scripts/ci-changed-files.mjs`), so it can become a required check without leaving docs-only pull requests at "Expected"; a hot-path diff still runs the full timing job, and a master push keeps its `paths:` filter (#4363).

- **Nightly refresh PRs start the required CI**: the job that opens the LSP-docs refresh and idle-eviction promotion PRs now dispatches `ci.yml` and `lint.yml` on the bot branch, because a PR opened with `GITHUB_TOKEN` starts no `pull_request` run and sat BLOCKED with every check absent, and `ci-verdict` now gates the non-advisory checks of a dispatch run on a bot-opened PR like a `pull_request` run (#5062).

- **CI frees runner slots, rebalances the Unit shards and keeps one npm cache**: the four `TLA+ models` shard jobs no longer start on a pull request that leaves `formal/` and its checker alone (the required `TLA+ models` aggregate still reports), the Unit shard weights are regenerated from five master runs (215 test files had no recorded duration), the Unit shards restore `~/.npm` once instead of twice, and `cache-prune.yml` also prunes when the CodeQL workflow completes on master so the overlay databases stay bounded (#5082).

- The PR-body lint prints sentence-length and filler findings as warnings and no longer fails on them. Structural rules and title-case headings still fail (#5110).

- The three required `Install test (<os>)` legs now install only when a pull request touches `INSTALL_PATHS` (`scripts/ci-changed-files.mjs`: the manifests, the lifecycle scripts, the scripts the job runs, `bin/`, the two install workflows) and otherwise pass in seconds with "no install files changed"; `Strict install (cold npm cache)`, the lint `strictness` job and the install-smoke `smoke` job (outside install paths) no longer start on a pull request, the `greeting` job starts only for a first-time author, and master pushes and dispatches keep every step (#5112).

- The nightly live cascade lane gains a typescript-go rename phase: it restores the exporter, moves it through `LSPService.renameFile` and requires each importer to reach the verdict its file calls for (refs #1712).

- The local PR-body lint sends every git read through the injected git, and the Observability record scan skips the family token of a `TLA+ unaffected:` line, so the TLA+ coverage lint cases no longer spawn real git or lex the runtime tree and stop timing out at 5 s on a loaded runner (closes #3902, refs #4909).

- **Stryker nightly bounds its range sample by mutants, not ranges (refs #4171)** — the sampler kept `ranges x allowance / mutants` ranges, which assumes every range holds the same number of mutants; run 40847865852 kept 3 ranges holding 55 mutants against ~24 affordable and exited 1 at the budget. The sample is now counted with a no-test Stryker pass and shrunk, deterministically, until it fits the allowance.

- **LSP sweeps, warm-ups, batches and project scans no longer leave an abort listener per file (refs #4907).** Five private races of a promise against the caller's `AbortSignal` added a listener and never removed it (the warm-up and its retry backoff, the per-file pre-open of a sweep, the analyzer race of a project scan, and each file of an `lsp_diagnostics` batch), so a signal that outlives one call kept a dead closure for every file it served. All seven races now go through one `untilAborted` in `clients/deadline-utils.ts`, which releases its listener when the race settles, and `tests/clients/abort-listener-release-sweep.test.ts` refuses any abort listener site it does not admit, including a computed method name or a non-literal event (an aliased import and a method fetched by `Reflect.get` stay an accepted gap).

- The lockfile-completeness npm-9 rewrite case runs real npm on rolldown's closure from the repo lock instead of all ~450 packages, and its budgets follow the lane's test-timeout scale with the gate's kill below the case budget, so a slow cold-cache runner no longer times it out (closes #4936).

- A lockfile-completeness gate that hits its npm timeout now stays inconclusive with the reason `timed out after <budget>ms` instead of `npm pin unavailable`, and the CLI line prints that reason; an acquisition outage still reads `npm pin unavailable` (#4995).

- **PR body lint: a re-spelled failure token is not a new failure path (#5019)** — the Observability failure-path scan credits a hunk's removed `catch`, `throw`, `return null` or `recordDegradationOnce` against that hunk's additions of the same kind, compares per token kind and per hunk (never per file), and lexes the reconstructed pre-image so a token inside a removed comment or string credits nothing. A body that only re-spells the condition in front of an existing `return null` now passes `pr-body.sh`, and an addition with no removed counterpart still refuses.

- The nightly save-verdict refresh keeps a settled `no`/`yes` and its evidence when a night measures `inconclusive` or `cannot measure`, and logs the held night instead of overwriting the row (#5060).

- `guard-bash` now admits the read-only `git stash list` and `git stash show` (every writing stash form and any spelling it cannot classify stays denied), and every worktree-remove refusal names the new `scripts/worktree-remove.mjs <path>`, which unlinks a `node_modules` symlink, refuses a real `node_modules` directory, then runs `git worktree remove` (#5111).

- PR bodies now have four sections (`Summary`, `Notes for the reviewer`, `Change outline`, and `Proof and checks`), and the body lint counts the parsed markdown: visible text is capped at 5000 characters, each code block at 20 lines and 400 columns (100 lines in all), the summary at three sentences and 600 characters, and reviewer notes at one list of five bullets. `Class sweep` carries an `Alignment:` line naming the families of `docs/alignment-families.md` it touches. `Why` folds into `Summary`, `Test assessment`, `Type of change`, `Area`, and `Checklist` are gone, and `Blast radius` is conditional (#5003). A table row whose cell count differs from its header (an unescaped `|` in a backticked cell splits it on GitHub) is refused.

- The ast-grep snippet directories of `dumpAst`, `validatePattern` and `validateRule`, and the helm render scratch directory, now take their parent from `scannerReportParentDir()` like every other `mkdtempSync` scanner directory, so a harness-owned scanner root also catches a directory a killed child strands (refs #4907).

- Every spawn of a System32 executable (`taskkill`, `cmd`, `chcp`, `tar`, `powershell`) in `safe-spawn`, the LSP teardowns and the installer now takes its path from `windowsExe` instead of a hand-built `%SystemRoot%` string, and `windowsExe` builds a Windows path whatever host runs it (refs #4907).

- 38 production sites that hand-rolled the backslash-to-slash fold (`.replace(/\\/g, "/")`, `.replaceAll("\\", "/")` and `.split("\\").join("/")`) now call `toPosix` from `clients/path-utils.ts`, and one fold that was a no-op (`detectFileRole`'s second fold) is deleted. Behaviour is unchanged; `tests/clients/to-posix-fold-sites.test.ts` drives 12 of the former sites through their exported callers. (refs #4907)

- Adds a nightly live cascade lane to the tool-smoke workflow: for typescript-go, rust-analyzer, gopls and jdtls it edits an exporter, calls the production cascade, and reds when an importer does not reach a conclusive verdict with the server's own finding (refs #1712). The first measured time-to-conclusive per server is committed in `tests/fixtures/lsp-cascade/measurements.json`.

- **The tmp-fixture census asserts on the Windows lane again, and a red names its producer**: the `win32` quarantine around the four census assertions is removed, each sweep now persists what it found at every registered root, and the census failure message states per leaked entry whether the registry held it at sweep time, how its birth, modification and change times sit against the last sweep, and its first-level children (#4591).

- Moves the stale-context stub out of the pi double and five pi-mock cases onto the real pi session, and retires two admit rows (refs #4937).

- Moves both NDJSON shutdown-drain cases off the pi double onto the real pi session (inline-factory mode), drops the file's census row and relabels the `handler-verdict-helper` row (refs #4937).

- Joins the loaded extension copy's deferred snapshot and probe-cache writes (and its NDJSON rows) before the tier-2 test helper removes its fixture root, so a late write no longer re-creates the root and reds the tmp-fixture hygiene census (refs #4937).

- Plants the yamllint shim of the smoke-tools cwd case outside the checkout, so it passes on a host with its own yamllint (closes #4996).

- `tests/index-lsp-config-root-eviction.test.ts` now joins the background-write drain registry before it removes its `PI_LENS_HOME` fixture, so a late project-snapshot worker write no longer re-creates the directory after a settled teardown and reds the tmp-fixture hygiene owner. The instance-registry mutation tail is left to the environment restore and the worker's own teardown (refs #5024).

- `tests/support/pi-session-commit-gate.ts` now owns one `warmGuardedSession` warm-up that pays a guarded session's cold first-session cost in a `beforeAll`, so `tests/index-4689-path-identity-witness.test.ts` no longer times out on its first case under `--sequence.seed=424`; `tests/index-4632-s4-tool-call-verdict.test.ts` calls it instead of carrying its own copy (closes #5061, refs #5023 #4909).

</details>

## [4.4.7] - 2026-10-29

### Added

- **Projects with `@effect/tsgo` get Effect's TypeScript-Go language server (refs #4914)** — when a project installs `@effect/tsgo` beside TypeScript 7 or newer, pi-lens launches the project's own `effect-tsgo tsc --lsp --stdio` for TypeScript files, so the Effect language service's diagnostics reach pi-lens. Installing the package is the opt-in; there is no pi-lens setting. Projects without it keep the native TypeScript 7 or classic launch, a malformed `@effect/tsgo` install falls back to the native launch, and the binary follows the same project-trust gate as the project's compiler. pi-lens never installs `@effect/tsgo` or runs its setup. Requested by @forge18.

- **Opt-in fallow-lsp: unused-export and dead-code findings for JS/TS files (refs #4929)** — set `fallow.enabled: true` in `~/.pi-lens/config.json` (or pass `--lens-fallow`) and pi-lens downloads the pinned fallow-lsp 3.37.0 release, checks its sha256, and runs it beside the TypeScript server on `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and `.cjs` files only. Findings arrive as advisory warnings tagged `fallow:<rule>` and never block. It is off by default; any value other than a literal `true` leaves it off, nothing is downloaded or launched while it is off, and the install and launch follow the same project-trust gate as the other language servers. knip, jscpd and madge are unchanged.

### Fixed

- **A Python config or stub changed outside pi now reaches the running server (#4532)** — a `pyrightconfig.json` or `pyproject.toml` created, edited or deleted after pyright answered is forwarded to it as a watched-files event at the next look, so an `extraPaths` finding clears on the next read instead of staying stale for the server's life. Python `.pyi` stubs changed outside pi are forwarded like `.d.ts` files. A dependency install into a virtualenv with no lockfile is still not detected.

- **Stop labelling a late runner's current findings as historical on a turn that wrote no file.** The turn-end stamp now covers the file a delivered late-runner or replayed-blocker section cites, and a message on such a turn that also carries a section citing no file is labelled historical. (refs #4617)

- **Stop labelling current turn-end findings as historical on turns that wrote no file.** The turn-end stamp now covers the files a resolution retired and the files its cascade, pending-error and late-auxiliary sections cite, with `--lens-guard` on or off. (refs #4617)

- **The home-folder ceiling holds when HOME or the project is reached through a link (#4911)** — The startup scan, the session snapshot root, the cheap project scan, the heavyweight analyzers, jscpd, the word index, the review graph, the LSP workspace sweep, the TypeScript server lookup, project-local binary lookup, `ast_grep_search` and `lens_diagnostics` compare the home folder and the root by real path. A symlinked or junctioned `HOME` (for example `/home` linked to `/var/home`), or a root spelled through such a link, no longer lets a scan walk the whole home tree.

- **`--no-lens` and three sibling command-line flags now take effect (#4913)** — `--no-lens`, `--no-lens-context`, `--lens-compact-tool-line` and `--no-tool <name>` were ignored because pi applies an extension flag's command-line value after the extension has loaded, so pi-lens read the registered default and ignored it. `pi --no-lens` still started language servers and ran the write-time runners; `--no-tool` only worked in the `--no-tool=<name>` spelling. pi-lens now reads these four at `session_start`, so `/lens-toggle` and `/lens-context-toggle` still win for the rest of the session. A tool named by `--no-tool` is dropped from the active set, and `pi_lens_activate_tools` refuses it.

- **Python docstrings now show in the module outline and `read_symbol` (#4948)** — a Python def or class documented by a docstring carried no description, because only a `#` comment above it was read. The first sentence of the docstring (`"""`, `'''`, `r"""`, `u"""` or a one-line string) is now its description, capped at 120 characters. A `#` comment above the def still works, and the docstring wins when both exist. `read_symbol` still starts at the `def` line.

- **A slow runner that could not read its tool's output is reported once, as a failure, and never blocks (refs #4130)** — a collect-later runner fault reached the agent twice at turn end (the failure note and its own synthetic diagnostic), and the cue and gleam faults carried blocking severity, so a tool that could not parse its output entered the blocker map and stopped `git commit`. Runner faults are now built at one seam as non-blocking warnings, and the deferred verdict drops them because the failure note already says it.

- **A held file changed outside pi now reads fresh on the first diagnostics call (refs #4532)** — `lsp_diagnostics`, `lens_diagnostics source=lsp` and `lsp_navigation workspaceDiagnostics` run the forced document-drift sweep before they answer, so a file the language server already holds and that was copied or written outside pi (a `cp`, a shell redirect) is re-pushed first, and an importer's finding clears on the first call instead of the second. The pre-answer pass checks every held document and re-pushes every one that changed; the turn-settle sweep keeps its 64-document and 4-resync pacing. A held file that grew past the LSP sync limit is no longer pushed by a drift resync; its record stays and the next pass retries.

- **A module changed outside pi no longer leaves its importer's diagnostics stale (refs #4532)** — when a file the diagnosed file imports directly was changed outside pi and no language server held it open, the server kept the old bytes it had read, so `lsp_diagnostics` reported (or missed) errors against the old module on the first call and every call after it. Each direct import no server holds is now compared with the bytes last seen, and a changed one is sent to its servers before the read, so the first call already answers against the new bytes. Each call that sends writes one `lsp_unheld_dependency_changed` row.

- **A bash result that joins a running look still gets its declaration walk (refs #4532)** — when a tool call's look was in flight, a bash result that joined it got only the tool call's throttled look, so a `.d.ts` its command generated reached no language server until a later walk. The joined bash result's walk demand now rides the flight, in both the out-of-band look and the HEAD look, and the `lsp_out_of_band_change` row says `joinedWalk: true` when the walk was a joiner's.

- **An unresolved blocker reaches the agent once per set, not on every turn that writes another file (refs #4921)** — the turn-end duplicate check keyed the turn's written-file set, so an unfixed blocker was sent again on each turn that touched a different file, and under `--lens-guard` on each repeated turn too; it now keys the delivered content, a changed or reintroduced blocker still arrives, and the commit gate keeps refusing while the blocker stands.

- **A subagent no longer receives the parent session's blockers:** with two sessions in one pi process (an in-process subagent), each turn end now delivers, sweeps and re-judges only the inline blockers its own session's writes recorded, and the commit-gate record files each session's blocker section under that session's id. A subagent's turn end no longer saves the parent's session state into the subagent's project data dir or stamps that project's duplicate-findings record with the parent's id (refs #4921).

- **A pi-lens status read no longer leaves `.git/index.lock` behind, so `git add` keeps working (#4930)** — the spawn seam now defaults `GIT_OPTIONAL_LOCKS=0` for every child, so the background `git status` reads skip the opportunistic index refresh whose lock a timeout or host exit could orphan; an exported `GIT_OPTIONAL_LOCKS` in your shell does not undo it for pi-lens's own git status reads, while a runner that passes its own environment keeps your value. On a checkout whose index is stat-dirty, each status read now re-hashes the dirty files until your own git command refreshes the index.

- **A subagent's commit is no longer refused for a blocker in another repository:** with `--lens-guard` and two sessions in one pi process, the commit gate now judges the blockers inside the repository being committed instead of every blocker the process holds, and its refusal names only that repository's blocker. A commit where the blocker lives, by any session, is still refused, and a command the gate cannot place in a repository (`cd` first, `--git-dir`, an environment prefix, a wrapper) is still judged by every blocker (refs #4941).

- **A subagent's read no longer licenses the parent's edit, nor the reverse:** with two sessions in one pi process (an in-process subagent), the read guard now keeps each session's read records and write authorship apart, so an edit is refused unless the editing session has its own authorization for the file: its own read, its own write authorship, or an exemption it armed. Another session's read or exemption no longer counts, nor does another session's write that names its own session. A session's own read still licenses its own edit (refs #4942).

- **The MCP server no longer takes a pi session's staged findings:** when pi and an MCP client (the Stop hook or `lens_turn_end`) work in the same project, the MCP side now reads only the turn-end message an MCP server staged, so a pi session's blocker is no longer shown to the MCP client as a historical finding and marked delivered before the pi session sees it; a restarted MCP server still delivers what the previous one staged, except a message a commit-gate rewrite has replaced since (refs #4943).

- **A subagent's edits are logged under its own session:** with two sessions in one pi process (an in-process subagent), the change log, the diagnostics log and the read-guard log now name the session that made the write, and a runner answer that finished after the subagent's edit (a collect-later run) is drained by that subagent's turn end, with its blocker recorded as the subagent's own instead of the parent session's (refs #4943).

- **Turn-end findings reach only the session that produced them:** with two sessions in one pi process (an in-process subagent), the blockers and advisories a session's turn end staged for its next request are no longer taken by the other session's request first, so a subagent no longer loses its own blocker to the parent session, and the parent no longer reads the subagent's. A subagent's own test-runner results now reach the subagent instead of no one. A new session that replaces the one that staged a message (`/new`, a fork, or a fresh process) no longer receives that unconsumed message (refs #4943).

- **`--no-ast-grep` and `astGrep.enabled=false` now switch the ast-grep server off.** The kill switch the server already read was never registered, so neither spelling existed; `lens_diagnostics mode=full` also now leaves a switched-off auxiliary server unstarted and names it, and a peer pi-lens session's findings from a switched-off server (`--no-opengrep` included) are no longer shown (refs #4944).

- **`--no-zizmor`, `--no-typos` and `--lens-spotbugs` now exist, with `*.enabled` config keys.** The zizmor and typos servers read kill switches the registry never registered, so neither could be switched off. SpotBugs was documented as opt-in behind a flag that did not exist, so it never ran; it stays off unless you set the flag or `spotbugs.enabled=true` (refs #4946).

- **read_symbol and module_report warn when a file has syntax errors (#4949)** — Tree-sitter recovers from syntax it cannot parse and drops declarations, so a `read_symbol` or `read_enclosing` miss in such a file read as "not there". A miss, and every `module_report`, now carries "tree-sitter could not parse part of this file; the symbol list may be incomplete." A `read_symbol` hit and a clean file are unchanged.

### Internal

<details>
<summary>12 internal changes: tests, CI, tooling, and refactors</summary>

- Tool-smoke now fails a runner whose tool was killed, timed out or rejected its invocation, instead of rendering it as a skipped tool. The skip carries the fault kind, and an absent tool still skips. A run cut short after it printed (cue-vet, gleam-check, prisma-validate, terragrunt) keeps its findings but no longer counts as a completed check, and trivy-config names a failed launch as did-not-run. (refs #4130)

- The Bash guard hook now follows `cd -P` physically, resolves a not-yet-existing destination below a symlinked parent through its nearest existing ancestor, and no longer loses a command after a `case` pattern or `$'\''` inside `$( )` (refs #4060).

- The LSP capability nightly records each matrix row's server `version` and `install` source, keeps a missed probe's last known value marked `stale` with its date instead of rewriting it to `unknown`, raises a cell that missed two consecutive nights on one tracking issue, and composes the refresh PR body with its capability flips; with the refresh GitHub App configured the PR starts CI on its own and a flip-free refresh can be armed for auto-merge (refs #4512).

- The owning root is registered by its path identity when a file link from outside reaches no registrable ancestor, and `deferred_format_queued` is logged only for a deferral the coordinator accepts; the symlink fixture family gains the other-worktree and unrelated-repository members (refs #4689).

- **Raw realpath calls feeding a config root, a write target and the data-dir probe move onto the identity seam (refs #4689)** — `clients/sgconfig.ts` and `clients/partial-edit-apply.ts` resolve through `realpathOrResolve`, and `dataDirCanonicalRoot` answers `fallback` with an existence check instead of a discarded `realpathSync`; the foreign-checkout lookup in `clients/test-runner-client.ts` keeps its raw realpaths and the sweep pin now says why.

- The review-graph ignore-gated node test follows the lane's test-timeout scale instead of the 5 s default, so a slow Windows runner no longer times it out (closes #4910).

- The stale-ctx session-start scan test drains its background snapshot writes before it removes its fixture root, so a late write no longer recreates the root for the tmp-fixture hygiene census (#4958).

- The `## Detection` PR-body check is owed by any PR that closes, or whose `Refs` line or title names, an issue labelled `bug` or `nightly-drift`, not only by one that closes a `bug` issue; CI refuses a label it cannot read and, unless the body already closes a bug, a `owner/repo#N` or URL reference, and the local preflight warns and skips an unreadable label (refs #4968).

- Quick and full session start share one sequence-read and snapshot-hydrate step instead of two 60-line copies and the shared step's sequence read is capped at the session_start wall budget even under a widened `PI_LENS_SEQUENCE_READ_BUDGET_MS` (refs #4907).

- Five fast-check properties pin pure identity and freshness seams in their existing test files: the `dd:` and `ddw:` anchors, the rows the disposition filters read, `lineContentHash`, `freshnessFromMtime` and the workspace id (refs #4928).

- Tier 2 (`tests/support/pi-session.ts`) gains an opt-in inline-factory mode, and six test files leave the pi double for it: the three lazy-liveness files, `bootstrap-lazy-liveness`, `index-cascade-resolved-clean-wiring` and `index-observed-sweep-no-read-guard`. The `--no-delta` case of `index-4483` moves to a tier-2 file with pi's real flag (refs #4937).

- Every session-state registry entry now names its owner key (`session`, `repository`, `project` or `process-wide: <reason>`), the coordinator's per-turn warnings, the cache observability's per-session state and the memory sampler's pending turn end moved onto scope cells that end with their session's scope (reached by session id through `sessionCell`), and the conformance test refuses a `session` owner that states no reason a scope cell cannot hold it (defect shape 72, refs #4965).

</details>

