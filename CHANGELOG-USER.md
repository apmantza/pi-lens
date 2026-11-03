# User changelog

## [4.4.8] - 2026-11-01

### Added

- **`dispatch.disabledRunners` turns a dispatch runner off**

### Changed

- **`rules.<id>.ignorePaths` now matches like the `ignore` field**
- **`ast_grep_outline` returns a compact text tree instead of JSON**
- **Reducer copy and filter-map warnings change.**
- **`symbol_search` and `pilens_symbol_search` emit one table, not a table plus the same hits as JSON (refs #5104).**
- **Twelve hand-rolled containment tests now share one `relativeInside` seam.**
- **A gitleaks or trivy scan that failed is no longer read as a clean scan.**

### Fixed

- **A bash-only turn no longer labels its fresh turn-end findings historical (refs #4617).**
- **A blocker retires when the language server confirms the fix, even if a scanner stayed silent.**
- **A blocker stays recorded when the language server answers for older bytes.**
- **An attached session no longer reads another session's stale answer as current.**
- **A helm chart beside a denied `helm-lint` no longer reads as a failed tool**
- **The bundled `minimatch` is updated to 11.x for GHSA-g3hv-75wg-m249.**
- **The cascade no longer reports neighbour errors computed for other file bytes**
- **A `pi-lens-ignore` comment or a disposition mark now applies to the file a finding names**
- **A directory whose name starts with `..` is no longer read as outside its project.**
- **A `pip install` into a project `.venv` that keeps no lockfile now counts as an install**
- **LSP sees outside disk changes before `lsp_diagnostics` answers; a new subdirectory marker roots it (refs #4532)**
- **A subagent's deferred format runs in its own settle:**
- **Upward walks start from the file's real path.**
- **A demoted blocker now honours your marks and stops re-serving dead coordinates:**
- **A fallback language server no longer confirms a file clean for a primary that never answered.**
- **A blocker row naming another file retires with that file (refs #5020)**
- **`ast_grep_replace` refuses a defaulted working directory at or above `$HOME`**
- **A Java edit now cascades to the files that import it.**
- **A cascade dependent whose only answer predates the edit no longer reads as clean**
- **An edit whose dependents the graph cannot place no longer reads as a leaf.**
- **A blocker on a file a script wrote is no longer reported as clean**
- **A diagnostics pass no longer rewrites your file under a project fix setting**
- **A markdownlint diagnostics pass no longer rewrites your file under `"fix": true`**
- **`lsp.servers.<id>.command` accepts the argv array the docs show**
- **A custom server that recompiles on pi-lens's own file notice can no longer wipe a real error**
- **A second session's commit no longer writes the first session's blockers into its own record**
- **A custom language server that publishes late is no longer stuck as unsupported**
- **`path` is the one single-file parameter, and `paths` behaves the same on every tool**

Plus 32 internal changes: tests, CI, tooling, and refactors.

Full notes: https://github.com/apmantza/pi-lens/releases/tag/v4.4.8

## [4.4.7] - 2026-10-29

### Added

- **Projects with `@effect/tsgo` get Effect's TypeScript-Go language server (refs #4914)**
- **Opt-in fallow-lsp: unused-export and dead-code findings for JS/TS files (refs #4929)**

### Fixed

- **A Python config or stub changed outside pi now reaches the running server (#4532)**
- **Stop labelling a late runner's current findings as historical on a turn that wrote no file.**
- **Stop labelling current turn-end findings as historical on turns that wrote no file.**
- **The home-folder ceiling holds when HOME or the project is reached through a link (#4911)**
- **`--no-lens` and three sibling command-line flags now take effect (#4913)**
- **Python docstrings now show in the module outline and `read_symbol` (#4948)**
- **A slow runner that could not read its tool's output is reported once, as a failure, and never blocks (refs #4130)**
- **A held file changed outside pi now reads fresh on the first diagnostics call (refs #4532)**
- **A module changed outside pi no longer leaves its importer's diagnostics stale (refs #4532)**
- **A bash result that joins a running look still gets its declaration walk (refs #4532)**
- **An unresolved blocker reaches the agent once per set, not on every turn that writes another file (refs #4921)**
- **A subagent no longer receives the parent session's blockers:**
- **A pi-lens status read no longer leaves `.git/index.lock` behind, so `git add` keeps working (#4930)**
- **A subagent's commit is no longer refused for a blocker in another repository:**
- **A subagent's read no longer licenses the parent's edit, nor the reverse:**
- **The MCP server no longer takes a pi session's staged findings:**
- **A subagent's edits are logged under its own session:**
- **Turn-end findings reach only the session that produced them:**
- **`--no-ast-grep` and `astGrep.enabled=false` now switch the ast-grep server off.**
- **`--no-zizmor`, `--no-typos` and `--lens-spotbugs` now exist, with `*.enabled` config keys.**
- **read_symbol and module_report warn when a file has syntax errors (#4949)**

Plus 12 internal changes: tests, CI, tooling, and refactors.

Full notes: https://github.com/apmantza/pi-lens/releases/tag/v4.4.7

## [4.4.6] - 2026-10-27

### Changed

- **Termux install fallback**

### Fixed

- **`lsp_navigation` results count as reads again (refs #1884)**
- **Writes and LSP edits share one lock and one containment root per file.**
- **A file reached through a link spelling gets its own project's verdicts (refs #4689)**
- **The bundled Biome config loads under Biome 2.6 again (refs #4886)**
- **Tool calls no longer wait on two walks of a non-git home folder (#4905)**
- **Deferred Biome fixes cover every edited JS/TS file (#4862)**

### Security

- **Workspace edits no longer write outside the workspace through a dangling symlink (closes #4877).**

Plus 3 internal changes: tests, CI, tooling, and refactors.

Full notes: https://github.com/apmantza/pi-lens/releases/tag/v4.4.6

## [4.4.5] - 2026-10-25

### Added

- **Tag a post-idle `memory_sample` in latency.log.**
- **Opt-in: repeat injected findings in later requests so exact-prefix prompt caches keep hitting.**
- **`no-sql-in-code-execute` reports `.execute()` SQL as advisory (closes #1828)**

### Changed

- **A document sync no longer measures bytes the edit path just measured.**
- **Idle eviction enabled for measured servers (refs #3989)**
- **TypeScript files confirm clean on their first touch.**
- **New opt-in `tools.lazy: "auto"` keeps every tool active on folding models; four tool schemas shrink.**
- **pi 1.4 is supported (refs #4741)**

### Removed

- **pi 0.86.1 is the oldest supported pi host; older hosts receive no findings (#4688).**

### Fixed

- **Normalize every test-run duration through the shared measurement contract.**
- **Bash writes in a linked worktree of the session repo are analysed again.**
- **An edit in a sibling git worktree of your repository is no longer analysed silently (#2050).**
- **Record bundled query-root checks:**
- **`rename_file` no longer overwrites a file written while the rename was computed.**
- **Restore the registry identity the idle-eviction probe arms, so measured servers can be promoted.**
- **Run shipped checks through symlinked script paths.**
- **A grammar load that never settles no longer strands its language (closes #4224).**
- **Keep an adopted project's files out of the session word index.**
- **Restore ast-grep warning history.**
- **detekt exit 1 no longer reads as a clean file.**
- **Environment gaps stop blocking, worktree installs restart servers, adopted shims stay refused.**
- **A HEAD move, a bash rewrite or a swept change now refuses cached diagnostics that depend on it.**
- **Open documents resync after `git stash`, `git checkout .` or `git restore`.**
- **Keep confirmed-clean turn-end resolutions current on no-write turns.**
- **A Python error is listed once, not twice, when Pyright finds it (closes #4629)**
- **Prompt-cache reuse survives injected findings on pi 0.87+**
- **JSONC-by-convention config files stop reporting comments as blocking errors (closes #4636)**
- **Name project-only settings in global config warnings.**
- **Python 3.14 projects no longer see spurious syntax errors, and ruff fixes agree (closes #4638)**
- **A dead-code scan that finishes late no longer crashes pi-lens or stalls on a disk error (closes #4661).**
- **Name the prompt-cache misses pi-lens causes, and stop losing real expiry to a long tool result.**
- **A symlinked file is one file to the read guard and to bash write attribution.**
- **A directory link no longer selects a sibling package's Cargo workspace, git repo or package root**
- **Config and package lookups follow a symlink to the real directory.**
- **`--lens-guard` now opens for a blocker you marked false-positive on a turn that wrote no file**
- **An in-process subagent keeps its project root and language servers when its parent ends first**
- **Share fallback LSP roots across project directories.**
- **A module changed on disk that no language server had open now reaches the live servers.**
- **pyright's interpreter now reaches the server; rust-analyzer's settings pull is answered truthfully**
- **A loose file now roots the auxiliary scanners at its own directory, not at the session `$HOME`.**
- **An offline opengrep no longer reads as a clean scan.**
- **Opengrep stops downloading its rules at every start once it has them.**
- **A bash rewrite of a module and its importer no longer STOPs on the importer's stale error.**
- **A bash edit's dependent is no longer checked against its dependency's old bytes (refs #4782)**
- **An opengrep finding is no longer erased by a late empty publication (#4786)**
- **Opengrep now reports findings on a file's first edit after the file is created.**
- **Two Python ast-grep false positives.**
- **csharp-ls no longer crashes with SIGABRT in C# folders that have no solution or project**
- **Bound deferred restore waits (refs #3915)**
- **A stray `.git` directory no longer becomes the checkout root (closes #4508)**
- **Keep inferred-project diagnostics non-blocking under warm attach (closes #4645).**
- **Agent-facing guidance names the tools the agent's host can call.**
- **The session-start orientation no longer tells the model to activate tools that are already active.**
- **A gitignored file is skipped whichever way its path is spelled**
- **`lens_diagnostics` mode=full no longer keeps a stale blocker beside a clean sweep through a symlink**
- **A file reached through a symlink now gets its own project's language server**
- **A whole-package autofix of a file reached through a link is now recognised as pi-lens's own change**
- **A file reached through a symlink now runs its tools in its own project and keeps one footer row**
- **`--lens-guard` no longer refuses every commit over a record an earlier session left (#4725)**
- **Files written by tools other than bash now get diagnostics (#4732)**
- **A second session's blocker no longer erases another session's commit-gate blocker.**
- **The commit gate guards `$'git' push` and every other quoting of git commit and git push (#4739)**
- **Terraform diagnostics no longer wait out a hold on the first publish (#4746)**
- **A second session no longer erases another session's CVE or secret blocker.**
- **A session started with `/new`, `/fork` or a resume now gets its own turn-end findings (#4751)**
- **Managed tool installs refuse a bin directory that links out of a pinned `PI_LENS_HOME`**
- **A reload during session start no longer raises an unhandled rejection from the startup scans**
- **A `serverOverrides.<id>.command` no longer runs under measurements of the catalog binary**
- **Swift roots at buildServer.json for Xcode projects (closes #4854)**
- **detekt findings reach the agent again: its text report has no severity token (#4522)**
- **Session diagnostics disclose incomplete evidence (closes #4620)**
- **A symlinked file is formatted through its real path instead of failing every turn**
- **A timed-out read-only LSP probe no longer keeps its server busy**
- **LSP root follows a marker added or removed right after a lookup (#4756)**
- **Opengrep findings now reach the first check of a session (#4763)**
- **`.tfvars` no longer reported as "Unexpected attribute" under terraform-ls**

### Security

- **A command lookup no longer starts the project's own files before you trust the project in pi.**

Plus 58 internal changes: tests, CI, tooling, and refactors.

Full notes: https://github.com/apmantza/pi-lens/releases/tag/v4.4.5

## [4.4.4] - 2026-10-19

### Changed

- **Preserve unchanged findings across file touches.**
- **pi 1.2 and 1.3 are supported (refs #4513)**
- **Read-guard accounting reads a file once per tool call hook (#1649)**
- **Review-graph builds read each function body once (#1740)**
- **The source walk answers compiled-twin lookups from the directory listing it already read (#1979)**
- **Sending a document to a language server counts its lines natively (#2066)**
- **Per-file complexity baselines no longer stay in memory for the whole session**
- **Project scans skip ast-grep rules that cannot match a file (#4496)**

### Fixed

- **Stop re-pushing byte-identical LSP content, and stop losing a save or a revert to the same gate.**
- **`~/` paths now resolve where the shell, the disk, and the tool argument really point (closes #4576)**
- **`symbol_search` answers as soon as a cold word-index build finishes (closes #4583)**
- **Count a multi-file bash command once in agent-behavior tracking.**
- **Marked findings stay hidden on every diagnostics route, and hidden ones are counted (#1634)**
- **Keep the host responsive between files during project scans.**
- **A language-server leader dropped from the held-pid set is now recorded (#3096)**
- **Save-triggered language servers now hear a save from MCP hosts and from cold queries (refs #3405)**
- **A dead export an edit introduced is no longer missed when turn end joins an older knip scan (closes #4166)**
- **A module created mid-session now clears the importer's missing-import (closes #4320)**
- **Tab-indented files keep the formatter's own width (closes #4321)**
- **A file whose language server cannot start is no longer reported clean (closes #4322)**
- **An explicit LSP check no longer starts Opengrep when it is switched off (closes #4323)**
- **A module created outside pi-lens now clears its importer's missing import (refs #4346)**
- **A new file now refuses only the cached diagnostics that depend on it (refs #4346)**
- **The ast-grep export scan waits out its startup defer again**
- **MCP warm socket restarts after a kill on a long TMPDIR; a second pi session keeps its own endpoint.**
- **The read guard no longer refuses edits of a file the agent wrote itself (#4387)**
- **pi no longer exits when a persist worker reports a result without a staged-file path (closes #4400)**
- **A file no language server answered for no longer reads as clean on any diagnostics route (#4403)**
- **TypeScript language server starts for a compiler found only on PATH.**
- **A stalled grammar download now fails after 15 s, not 300 s**
- **Blockers and the cascade now see Go peers, ambient files and dynamic imports (#4438)**
- **A Go type error or a Dart compile error is no longer reported as clean (#4451, #1937)**
- **helm-lint, fish-indent and golangci-lint now read their tools' real output (#4453, #4454, #4455, #1937)**
- **A fish syntax error now reaches the agent as a blocking finding (#4454)**
- **Language servers see installs, codegen and outside edits before the next check (closes #4476, closes #4507)**
- **Refresh diagnostics across JSDoc imports and module augmentations.**
- **ast-grep no longer stops on old findings away from an edit (refs #4481)**
- **Linters no longer stop the first edit on errors the file already had (refs #4483)**
- **A second write no longer clears an unfixed blocker (closes #4484)**
- **Cascade checks report broken importers on every turn, not once or never (refs #4485, #4486, #4487)**
- **Language servers see a branch switch made with git (refs #4493)**
- **A subagent session in a linked worktree now recovers its own opaque bash writes**
- **A fixed ast-grep error no longer stays blocking after the ast-grep server starts (closes #4509)**
- **Language servers start from the managed install when project trust is unknown (closes #4515)**
- **Tool crashes and timeouts no longer read as clean files; ktlint findings are preserved (refs #4522)**
- **Opaque bash rewrites remain analyzed with `--no-read-guard`**
- **Nested Python projects keep their own language server (closes #4547)**
- **A process serving several live sessions releases its registry entry and stale primary registration**
- **`rename_file` sends a `~/…` destination to your home directory, not a `~` folder in the project (#4578)**
- **A held document keeps its drift record at the record cap, so an untracked edit still heals**
- **A malformed persist worker message no longer ends pi (#4402)**
- **LSP status shows the whole project root (refs #4449)**

Plus 66 internal changes: tests, CI, tooling, and refactors.

Full notes: https://github.com/apmantza/pi-lens/releases/tag/v4.4.4
