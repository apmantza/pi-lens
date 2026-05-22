<p align="center">
  <img src="https://raw.githubusercontent.com/apmantza/pi-lens/master/banner.png" alt="pi-lens" width="1100">
</p>

# pi-lens

pi-lens focuses on real-time inline code feedback for AI agents.

## What It Does

### On Write/Edit

On every `write` and `edit`, pi-lens runs a fast, language-aware pipeline (checks depend on file language, project config, and installed tools):

1. **Secrets scan** — blocking; aborts the write if credentials are detected
2. **Auto-format** — deferred to `agent_end` by default; queued files are formatted once after all agent tool calls complete. Use `--immediate-format` or global config `format.mode: "immediate"` for per-edit formatting
3. **Auto-fix** — safe autofixes from 6 tools (Biome `check --write`, Ruff `check --fix`, ESLint `--fix`, stylelint `--fix`, sqlfluff `fix`, RuboCop `-a`) applied before analysis
4. **LSP file sync** — opens/updates the file in active language servers
5. **Dispatch lint** — parallel runner groups: LSP diagnostics, tree-sitter structural rules, ast-grep security/correctness rules, fact rules, language-specific linters, experimental Semgrep security scans, similarity detection
6. **Cascade diagnostics** — review-graph impact cascade showing which other files were affected and how diagnostics propagated

Results are inline and actionable:

- **Blocking issues** — stop progress until fixed
- **Warnings** — summarized inline, detail in `/lens-booboo`
- **Health/telemetry** — available in `/lens-health`

### Agent End

At `agent_end` (once per user prompt, after all agent tool calls complete):

- **Deferred formatting** — any files queued during the turn are formatted once, synced to LSP, and tracked for read-guard coverage
- **Summary notification** — concise status: how many files were formatted, which changed, and whether any formatter failed

### Session Start

At `session_start`, pi-lens:

- resets runtime state and diagnostic telemetry
- detects project root, language profile, and active tools
- applies language-aware startup defaults for tool preinstall
- warms caches and optional indexes (with overlap/session guardrails)
- emits missing-tool install hints for detected languages when relevant
- prepends session guidance before the user's prompt so provider bridges keep the real prompt active
- opens `warmFiles` (if configured in `.pi-lens/lsp.json`) to seed lazy-indexing language servers like clangd before the first symbol query

For one-shot print sessions (for example `pi --print ...`), pi-lens auto-uses a quick startup path that skips heavy bootstrap work to reduce startup latency. Override with `PI_LENS_STARTUP_MODE=full|minimal|quick`.

### Turn End

At `turn_end`, pi-lens:

- summarizes deferred findings (for example duplicates/circulars)
- persists turn findings for next context injection
- updates debt/diagnostic tracking and cleans transient state
- renders a review-graph impact cascade showing affected files and diagnostic propagation
- fires test runs for all modified files (non-blocking); failures are injected into the next turn's context when ready
- manages LSP server lifecycle with a 240s idle timeout (resets when editing resumes)

## Install

```bash
pi install npm:pi-lens
```

Or from git:

```bash
pi install git:github.com/apmantza/pi-lens
```

## Features

### LSP Support

pi-lens includes **37 language server definitions**. LSP is **enabled by default** (`--lsp` or no flag). Servers are auto-discovered from PATH, project `node_modules`, and managed installs. When a server is not installed, pi-lens offers an interactive install prompt.

**LSP Idle Management:** LSP servers shut down after 240 seconds of inactivity (no files modified) to free resources. The timer resets when you resume editing, preventing cold-start penalties during active development.

**Warm files:** For language servers that index lazily (e.g. clangd), configure `warmFiles` in `.pi-lens/lsp.json` to open entry-point files at session start so the server has AST/index context before the first symbol query:

```json
{ "warmFiles": ["src/main.cpp", "src/lib.cpp"] }
```

**Agent LSP tools:** `lsp_diagnostics` can check one file, a directory, or an explicit `filePaths` batch with bounded concurrency. `lsp_navigation` provides definitions, references, hover, workspace symbols, call hierarchy, rename edits, and `findSymbol` for filtered document-symbol lookup.

LSP servers for: TypeScript, Deno, Python (pyright/basedpyright + jedi), Go, Rust, Ruby (ruby-lsp + solargraph), PHP, C# (omnisharp), F#, Java, Kotlin, Swift, Dart, Lua, C/C++, Zig, Haskell, Elixir, Gleam, OCaml, Clojure, Terraform, Nix, Bash, Docker, YAML, JSON, HTML, TOML, Prisma, Vue, Svelte, ESLint, CSS.

### Formatters

pi-lens auto-detects and runs **32 formatters** based on project config:

biome, prettier, oxfmt, ruff, black, sqlfluff, gofmt, rustfmt, zig fmt, dart format, shfmt, nixfmt, mix format, ocamlformat, clang-format, ktlint, rubocop, standardrb, gleam format, terraform fmt, php-cs-fixer, csharpier, fantomas, swiftformat, stylua, ormolu, taplo, fish_indent, google-java-format, cljfmt, cmake-format, psscriptanalyzer-format

Detection rules:

- **Config-gated**: only runs when project config indicates usage (e.g. `biome.json`, `.prettierrc`, `ruff.toml`)
- **Nearest-wins**: when multiple formatter configs exist at different directory levels, the one closest to the edited file wins
- **Biome-default**: for JS/TS files without Prettier or Biome config, Biome is used as the default formatter
- **Ruff-default**: for Python files without Black config, Ruff format is used when available

### Review Graph - Cascade Diagnostics

pi-lens builds a review graph (`file → symbol → dependency`) during session and uses it at turn end to render an impact cascade: which files were affected by a change and how diagnostics propagated through the dependency graph. Nodes track kind, language, and export status; edges track contains/imports/calls/references.

### Read-Before-Edit Guard

pi-lens enforces a **read-before-edit** policy on all file writes and edits. Before allowing a `write` or `edit` tool call on an existing file, it verifies that the agent has previously read sufficient context:

- **Zero-read block** — blocks any edit to a file not read in the current session
- **File-modified block** — blocks if the file changed on disk since the last read (auto-format, external tool, or a previous edit that was then reformatted)
- **Out-of-range block** — blocks if the edit target lines fall outside the ranges previously read, ensuring the agent cannot modify code it hasn't seen

Coverage is tracked across multiple reads: two reads of lines 1–100 and 101–200 together satisfy a full-file write. Symbol-expanded reads (small reads silently widened to the enclosing symbol via tree-sitter) count toward coverage at the symbol level. Markdown files generate a warning instead of blocking (edits outside the section-expanded read range are warned, not silently passed). Plain-text (`.txt`) and log (`.log`) files remain fully exempt.

Override for a single edit: `/lens-allow-edit <path>`

Configure behavior with `--no-read-guard` to disable entirely, or set mode to `warn` instead of `block`.

### Opportunistic Read Expansion

When the agent reads a small slice of a file (≤ 60 lines), pi-lens transparently expands the read to the full enclosing symbol (function, method, or class) using the tree-sitter AST. The agent receives the full symbol as context, and the read guard records symbol-level coverage so edits anywhere within that symbol pass without requiring the agent to have read every line individually. Expansion runs within a 200 ms budget and falls back silently on unsupported file types or parse failures.

Supported: TypeScript, TSX, JavaScript, JSX, Python, Go, Rust, Ruby.

### Fact Rules Pipeline

Covers JavaScript/TypeScript, Python, Go, Rust, Ruby, Shell, and CMake. A TypeScript AST-based fact-rule engine extracts function-level metrics and evaluates quality and security rules inline. Blocking rules surface immediately at write time; advisory rules are available via `/lens-booboo`.

**Blocking (surface inline at write time):**

- **cors-wildcard** — `Access-Control-Allow-Origin: *` in server-side code
- **error-swallowing** — empty catch block (skips documented local fallbacks and fs-boundary catches)
- **no-commented-credentials** — password/token/secret in commented-out code
- **high-entropy-string** — string literals with suspiciously high Shannon entropy (possible hardcoded secret)

**Advisory (accessible via `/lens-booboo`):**

- **high-complexity** / **no-complex-conditionals** — cyclomatic complexity and deeply nested conditions
- **high-fan-out** — function calls too many distinct functions (coordination smell)
- **unsafe-boundary** — dangerous `any` casts at API boundaries
- **async-noise** / **async-unnecessary-wrapper** — async functions with no await; wrappers that add no value
- **pass-through-wrappers** — trivial wrapper functions
- **dynamic-regexp** — `new RegExp(variable)` (potential ReDoS; complements tree-sitter `unsafe-regex`)
- **jwt-without-verify** — `jwt.sign()` without `jwt.verify()` in the same file
- **missing-error-propagation** — catch blocks that log but don't rethrow
- **error-obscuring** — catch blocks that wrap errors in a different type
- **duplicate-string-literal** / **no-boolean-params** / **high-import-coupling** — code-quality signals

### Tree-sitter Rules

Structural rules organized by language in `rules/tree-sitter-queries/`. Rules marked **🔴** block the agent inline at write time (only for lines in the current edit); others are advisory.

**TypeScript (23 rules):**
🔴 `eval`, `sql-injection`, `ts-command-injection`, `ts-ssrf`, `ts-xss-dom-sink`, `ts-dynamic-require`, `ts-open-redirect`, `ts-nosql-injection`, `ts-weak-hash`, `ts-hallucinated-react-import`, `unsafe-regex`, `debugger`, `default-not-last`, `duplicate-function-arg`, `empty-switch-case`, `infinite-loop`, `self-assignment`, `switch-case-termination`  
⚠️ `console-statement`, `deep-promise-chain`, `mixed-async-styles`, `ts-insecure-random`, `ts-detached-async-call`, `ts-react-antipatterns`, `ts-weak-hash`, `variable-shadowing`

**Python:** 🔴 `python-command-injection`, `python-sql-injection`, `python-insecure-deserialization`, `python-weak-hash`, `python-hallucinated-import` + 20 advisory rules

**Go:** 🔴 `go-command-injection`, `go-sql-injection`, `go-shared-map-write-goroutine`, `go-weak-hash` + 13 advisory rules

**Rust:** 🔴 `rust-lock-held-across-await` + 3 advisory rules (`rust-unsafe-block`, `rust-expect`, `rust-clone-in-loop`)

**Ruby:** 🔴 `ruby-weak-hash` + 14 advisory rules

**Suppressing a finding:** add `// pi-lens-ignore: rule-id` on the flagged line or the line above (JS/TS), or `# pi-lens-ignore: rule-id` for Python/Ruby/Shell. This suppresses that specific rule at that location only.

**Project-wide disabling** is not currently supported through config — there is no `.pi-lens/disabled-rules` file. Use inline suppression for per-occurrence overrides. When editing pi-lens itself, move a rule file to the `<language>-disabled/` directory to prevent it from running.

### Ast-Grep Rules

**180+ rules** in `rules/ast-grep-rules/` across JS, TS, and Python:

- **Security** — no-eval, jwt-no-verify, no-hardcoded-secrets, no-insecure-randomness, no-inner-html, no-javascript-url, weak-rsa-key
- **Correctness** — strict-equality, no-cond-assign, no-constant-condition, no-dupe-keys, no-nan-comparison, array-callback-return, constructor-super
- **Style/smells** — nested-ternary, long-parameter-list, large-class, prefer-optional-chain, redundant-state, require-await
- **Agent stubs** — no-unimplemented-stub, no-raise-not-implemented, no-ellipsis-body

### Semgrep CLI Integration (Experimental)

pi-lens can run the locally installed `semgrep` CLI as an optional dispatch runner for security-focused findings. Semgrep diagnostics are normalized into the same pi-lens `Diagnostic` model as LSP, tree-sitter, ast-grep, and linters: high-signal security findings can become blocking, while other findings remain warnings for `/lens-booboo`/history.

Activation is intentionally gated:

- pi-lens **does not auto-install Semgrep**.
- A local `.semgrep.yml`, `.semgrep.yaml`, `semgrep.yml`, or `semgrep.yaml` enables the runner when the `semgrep` CLI is available.
- Without a local config, Semgrep stays skipped unless explicitly configured with `--lens-semgrep --lens-semgrep-config <auto|p/pack|path>` or `/lens-semgrep enable --config <auto|p/pack|path>`.
- Local `.semgrep.yml` scans do not require a Semgrep token. Semgrep AppSec/Pro/managed configurations may require `semgrep login` or `SEMGREP_APP_TOKEN`.
- pi-lens passes `--metrics=off` for dispatch scans.

Commands:

- `/lens-semgrep status` — show CLI availability, discovered local config, persisted pi-lens config, and effective dispatch state
- `/lens-semgrep init` — create a starter `.semgrep.yml` with a blocking `eval(...)` rule and enable Semgrep dispatch
- `/lens-semgrep enable [--config <auto|p/pack|path>]` — persist Semgrep dispatch activation in `.pi-lens/semgrep.json`
- `/lens-semgrep disable` — persistently disable Semgrep dispatch for this project
- `/lens-semgrep clear` — remove `.pi-lens/semgrep.json` and return to local-config auto-discovery

Local rules can opt into pi-lens blocking semantics with metadata:

```yaml
metadata:
  pi-lens:
    semantic: blocking
    defect_class: injection
    confidence: high
```

## Dependencies

Auto-install behavior depends on gate type:

- **Config-gated**: installs only when project config/deps indicate usage
- **Flow/language-gated**: installs when the runtime path needs it for the current file/session flow
- **Operational prewarm**: installs during session warm scans / turn-end analysis paths
- **GitHub release**: platform-specific binary downloaded from GitHub releases to `~/.pi-lens/bin/`

| Tool                                | Purpose                          | Auto-installed | Gate                               |
| ----------------------------------- | -------------------------------- | -------------- | ---------------------------------- |
| `@biomejs/biome`                    | JS/TS lint/format/autofix        | Yes            | Config-gated                       |
| `prettier`                          | Formatting fallback              | Yes            | Config-gated                       |
| `yamllint`                          | YAML linting                     | Yes            | Config-gated                       |
| `actionlint`                        | GitHub Actions workflow linting  | Yes            | GitHub release                     |
| `sqlfluff`                          | SQL linting/formatting           | Yes            | Config-gated                       |
| `ruff`                              | Python lint/format/autofix       | Yes            | Language-default + flow-gated      |
| `typescript-language-server`        | Unified LSP diagnostics          | Yes            | Language-default                   |
| `typescript`                        | TypeScript compiler              | Yes            | Language-default                   |
| `pyright`                           | Python type diagnostics fallback | Yes            | Flow/language-gated                |
| `@ast-grep/cli` (sg)                | AST scans/search/replace         | Yes            | Operational prewarm                |
| `knip`                              | Dead code analysis               | Yes            | Operational prewarm + config-gated |
| `jscpd`                             | Duplicate code detection         | Yes            | Operational prewarm + config-gated |
| `madge`                             | Circular dependency analysis     | Yes            | Turn-end analysis flow             |
| `mypy`                              | Python type checking             | Yes            | Flow-gated                         |
| `stylelint`                         | CSS/SCSS/Less linting            | Yes            | Config-gated                       |
| `markdownlint-cli2`                 | Markdown linting                 | Yes            | Config-gated                       |
| `shellcheck`                        | Shell script linting             | Yes            | GitHub release                     |
| `shfmt`                             | Shell script formatting          | Yes            | GitHub release                     |
| `rust-analyzer`                     | Rust LSP                         | Yes            | GitHub release                     |
| `golangci-lint`                     | Go linting                       | Yes            | GitHub release                     |
| `hadolint`                          | Dockerfile linting               | Yes            | GitHub release                     |
| `ktlint`                            | Kotlin linting                   | Yes            | GitHub release                     |
| `tflint`                            | Terraform linting                | Yes            | GitHub release                     |
| `taplo`                             | TOML linting/formatting          | Yes            | GitHub release                     |
| `terraform-ls`                      | Terraform LSP                    | Yes            | GitHub release                     |
| `htmlhint`                          | HTML linting                     | Yes            | Config-gated                       |
| `@prisma/language-server`           | Prisma LSP                       | Yes            | Flow-gated                         |
| `dockerfile-language-server-nodejs` | Dockerfile LSP                   | Yes            | Flow-gated                         |
| `intelephense`                      | PHP LSP                          | Yes            | Flow-gated                         |
| `bash-language-server`              | Bash LSP                         | Yes            | Language-default                   |
| `yaml-language-server`              | YAML LSP                         | Yes            | Language-default                   |
| `vscode-langservers-extracted`      | JSON/ESLint/CSS/HTML LSP         | Yes            | Language-default                   |
| `vscode-css-languageserver`         | CSS LSP                          | Yes            | Language-default                   |
| `vscode-html-languageserver-bin`    | HTML LSP                         | Yes            | Language-default                   |
| `svelte-language-server`            | Svelte LSP                       | Yes            | Flow-gated                         |
| `@vue/language-server`              | Vue LSP                          | Yes            | Flow-gated                         |
| `semgrep`                           | Experimental security dispatch   | Manual         | Local config / explicit opt-in     |
| `psscriptanalyzer`                  | PowerShell linting               | Manual         | —                                  |

Additional language servers (gopls, ruby-lsp, solargraph, etc.) are auto-detected from PATH or installed via native package managers (`go install`, `gem install`) when their language is detected.

## Run

```bash
# Standard mode (LSP enabled by default)
pi

# Optional switches
pi --no-lens             # Start pi-lens disabled for this session; /lens-toggle can re-enable
pi --no-lsp              # Disable unified LSP diagnostics
pi --no-autoformat        # Skip auto-formatting entirely
pi --immediate-format      # Format immediately after each edit instead of deferring to agent_end
pi --no-autofix           # Skip auto-fix (Biome, Ruff, ESLint, stylelint, sqlfluff, RuboCop)
pi --no-tests             # Skip test runner
pi --no-delta             # Disable delta mode (show all diagnostics, not just new ones)
pi --lens-guard           # Block git commit/push when unresolved blockers exist (experimental)
pi --lens-semgrep         # Enable Semgrep dispatch when a local/configured Semgrep config exists
pi --lens-semgrep-config p/ci  # Explicit Semgrep config for dispatch (requires --lens-semgrep)
```

## Global Config

pi-lens reads optional user preferences from `~/.pi-lens/config.json` (`%USERPROFILE%\\.pi-lens\\config.json` on Windows). Unknown keys are ignored, and missing or invalid config falls back to defaults.

Hide the diagnostics widget by default and run formatting immediately after write/edit tool calls instead of at `agent_end`:

```json
{
  "widget": {
    "visible": false
  },
  "format": {
    "enabled": true,
    "mode": "immediate"
  }
}
```

`format.mode` can be `"deferred"` (default) or `"immediate"`. Set `format.enabled` to `false` to match `--no-autoformat`. `/lens-widget-toggle` still works as a session-only override.

## Environment Variables

- `PILENS_DATA_DIR` — redirect per-project state (scanner caches,
  turn-state.json) out of the project directory. By default pi-lens writes
  `<cwd>/.pi-lens/`; if set, it writes to
  `<PILENS_DATA_DIR>/<sanitized-cwd-slug>/` instead. Useful for keeping repos
  clean or for mounted/ephemeral setups. Tool binaries always live in
  `~/.pi-lens/bin/` regardless.
- `PI_LENS_STARTUP_MODE` — `full` | `minimal` | `quick`. Override the
  auto-selected startup path. One-shot `pi --print` sessions auto-use `quick`
  to reduce latency.

## Key Commands

- `/lens-toggle` — toggle pi-lens on/off for the current session without restarting
- `/lens-widget-toggle` — show/hide the pi-lens diagnostics widget below the editor
- `/lens-booboo` — full quality report for current project state
- `/lens-health` — runtime health, latency, and diagnostic telemetry
- `/lens-allow-edit <path>` — override the read-before-edit guard for a single edit
- `/lens-tools` — tool installation status: globally installed, auto-installed, or npx fallback
- `/lens-tdi` — Technical Debt Index (TDI) and project health trend
- `/lens-semgrep` — manage experimental Semgrep dispatch (`status`, `init`, `enable`, `disable`, `clear`)

## Language Coverage

pi-lens supports **36+ languages** through dispatch runners and LSP integration.

Formatting uses a single selected formatter per file: explicit project config wins, otherwise pi-lens uses a smart default where supported, and config-first ecosystems do not autoformat without config.

Dispatch is diagnostics-oriented: automatic formatting and safe autofix happen in the post-write pipeline rather than through dispatch format-check runners.

| Language              | LSP | Dispatch Runners                                                                                               | Formatter               |
| --------------------- | --- | -------------------------------------------------------------------------------------------------------------- | ----------------------- |
| JavaScript/TypeScript | ✓   | lsp, ts-lsp, biome-check-json, tree-sitter, ast-grep-napi, type-safety, similarity, fact-rules, eslint, oxlint | biome, prettier         |
| Python                | ✓   | lsp, pyright, ruff-lint, tree-sitter, python-slop                                                              | ruff, black             |
| Go                    | ✓   | lsp, go-vet, golangci-lint, tree-sitter                                                                        | gofmt                   |
| Rust                  | ✓   | lsp, rust-clippy, tree-sitter                                                                                  | rustfmt                 |
| Ruby                  | ✓   | lsp, rubocop, tree-sitter                                                                                      | rubocop, standardrb     |
| C/C++                 | ✓   | lsp, cpp-check, tree-sitter                                                                                    | clang-format            |
| Shell                 | ✓   | lsp, shellcheck                                                                                                | shfmt                   |
| Fish                  | ✓   | lsp, fish-indent                                                                                               | fish_indent             |
| CSS/SCSS/Less         | ✓   | lsp, stylelint                                                                                                 | biome, prettier         |
| HTML                  | ✓   | lsp, htmlhint                                                                                                  | prettier                |
| YAML                  | ✓   | lsp, yamllint, actionlint (GitHub workflows)                                                                   | prettier                |
| JSON                  | ✓   | lsp                                                                                                            | biome, prettier         |
| Svelte                | ✓   | lsp                                                                                                            | —                       |
| Vue                   | ✓   | lsp                                                                                                            | —                       |
| SQL                   | —   | sqlfluff                                                                                                       | sqlfluff                |
| Markdown              | —   | spellcheck, markdownlint, vale                                                                                 | prettier                |
| Docker                | ✓   | lsp, hadolint                                                                                                  | —                       |
| PHP                   | ✓   | lsp, php-lint, phpstan                                                                                         | php-cs-fixer            |
| PowerShell            | ✓   | lsp, psscriptanalyzer                                                                                          | psscriptanalyzer-format |
| Prisma                | ✓   | lsp, prisma-validate                                                                                           | —                       |
| C#                    | ✓   | lsp, dotnet-build                                                                                              | csharpier               |
| F#                    | ✓   | lsp                                                                                                            | fantomas                |
| Java                  | ✓   | lsp, javac                                                                                                     | google-java-format      |
| Kotlin                | ✓   | lsp, ktlint, detekt                                                                                            | ktlint                  |
| Swift                 | ✓   | lsp, swiftlint                                                                                                 | swiftformat             |
| Dart                  | ✓   | lsp, dart-analyze                                                                                              | dart format             |
| Lua                   | ✓   | lsp                                                                                                            | stylua                  |
| Zig                   | ✓   | lsp, zig-check                                                                                                 | zig fmt                 |
| Haskell               | ✓   | lsp                                                                                                            | ormolu                  |
| Elixir                | ✓   | lsp, elixir-check, credo                                                                                       | mix format              |
| Gleam                 | ✓   | lsp, gleam-check                                                                                               | gleam format            |
| OCaml                 | ✓   | lsp                                                                                                            | ocamlformat             |
| Clojure               | ✓   | lsp                                                                                                            | cljfmt                  |
| Terraform             | ✓   | lsp, tflint                                                                                                    | terraform fmt           |
| Nix                   | ✓   | lsp                                                                                                            | nixfmt                  |
| TOML                  | ✓   | lsp, taplo                                                                                                     | taplo                   |
| CMake                 | ✓   | lsp                                                                                                            | cmake-format            |
