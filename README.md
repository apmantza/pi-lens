<p align="center">
  <img src="https://raw.githubusercontent.com/apmantza/pi-lens/master/banner.png" alt="pi-lens" width="1100">
</p>

# pi-lens

pi-lens focuses on real-time inline code feedback for AI agents.

## What It Does

### At Session Start

At `session_start`, pi-lens:

- resets runtime state and diagnostic telemetry
- detects project root, language profile, and active tools
- applies language-aware startup defaults for tool preinstall
- warms caches and optional indexes (with overlap/session guardrails)
- emits missing-tool install hints for detected languages when relevant
- prepends session guidance before the user's prompt so provider bridges keep the real prompt active
- opens `warmFiles` (if configured in `.pi-lens/lsp.json`) to seed lazy-indexing language servers like clangd before the first symbol query

Startup scan context and language profile are cached in the project snapshot and reused on subsequent `/new` invocations when the project has not changed, avoiding repeated full filesystem walks (~2.5 s saved on medium-to-large projects). Background startup scans are deferred past the interactive session-start path so they do not inflate visible `/new` latency.

For one-shot print sessions (for example `pi --print ...`), pi-lens auto-uses a quick startup path that skips heavy bootstrap work to reduce startup latency. Override with `PI_LENS_STARTUP_MODE=full|minimal|quick`.

### On Write/Edit

On every `write` and `edit`, pi-lens runs a fast, language-aware pipeline (checks depend on file language, project config, and installed tools):

1. **Secrets scan** — blocking; aborts the write if credentials are detected
2. **Auto-format** — deferred to `agent_end` by default; queued files are formatted once after all agent tool calls complete. Use `--immediate-format` or global config `format.mode: "immediate"` for per-edit formatting
3. **Auto-fix** — safe autofixes from 6 tools (Biome `check --write`, Ruff `check --fix`, ESLint `--fix`, stylelint `--fix`, sqlfluff `fix`, RuboCop `-a`) applied before analysis
4. **Edit autopatch** — before an `edit` tool call lands, pi-lens silently corrects two classes of `oldText` mismatch: leading tab/space indentation (when the corrected text matches exactly one location) and trailing whitespace stripped by formatters. Both corrections also retarget `newText` so the replacement matches the file's whitespace style
5. **LSP file sync** — opens/updates the file in active language servers
5. **Dispatch lint** — parallel runner groups: LSP diagnostics (incl. the Opengrep auxiliary security scanner), tree-sitter structural rules, ast-grep security/correctness rules, fact rules, language-specific linters, similarity detection
6. **Cascade diagnostics** — review-graph impact cascade showing which other files were affected and how diagnostics propagated

Results are inline and actionable:

- **Blocking issues** — stop progress until fixed
- **Warnings** — summarized inline, detail in `/lens-booboo`
- **Health/telemetry** — available in `/lens-health`

### Agent End

At `agent_end` (once per user prompt, after all agent tool calls complete):

- **Deferred formatting** — any files queued during the turn are formatted once, synced to LSP, and tracked for read-guard coverage
- **Conservative LSP warning autofix** — when `actionableWarnings.autoFix.enabled` is set, applies up to 5 preferred LSP quickfixes for warnings flagged in the turn's actionable warnings report. Each fix is re-validated against the live LSP server at apply time, checked for ambiguity (skipped if multiple eligible actions exist), and gated by a safety check before any write occurs. Changed files are registered with the read-guard and cache manager
- **Summary notification** — concise status: how many files were formatted, which changed, and whether any formatter failed

### Turn End

At `turn_end`, pi-lens:

- summarizes deferred findings (for example duplicates/circulars)
- persists turn findings for next context injection
- updates debt/diagnostic tracking and cleans transient state
- renders a review-graph impact cascade showing affected files and diagnostic propagation
- fires test runs for all modified files (non-blocking); failures are injected into the next turn's context when ready
- manages LSP server lifecycle with a 240s idle timeout (resets when editing resumes)
- **Actionable warnings report** — writes `.pi-lens/cache/actionable-warnings.json` with fixable warnings introduced by the current turn (delta-only by default). Merges pipeline `fixable` diagnostics with optional LSP code-action warnings. Uses stable `aw:<hash>` IDs so warnings can be tracked and suppressed across turns. When warnings are present, injects a concise advisory into the agent context instead of blocker language

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

pi-lens includes **38 language server definitions** (including two cross-cutting *auxiliary* scanners that attach alongside the file's language server — Opengrep for security, and ast-grep for structural rules in projects with an `sgconfig.y[a]ml` — see below). LSP is **enabled by default** (`--lsp` or no flag). Servers are auto-discovered from PATH, project `node_modules`, and managed installs. When a server is not installed, pi-lens offers an interactive install prompt.

**LSP Idle Management:** LSP servers shut down after 240 seconds of inactivity (no files modified) to free resources. The timer resets when you resume editing, preventing cold-start penalties during active development.

**Warm files:** For language servers that index lazily (e.g. clangd), configure `warmFiles` in `.pi-lens/lsp.json` to open entry-point files at session start so the server has AST/index context before the first symbol query:

```json
{ "warmFiles": ["src/main.cpp", "src/lib.cpp"] }
```

**Agent LSP tools:** `lsp_diagnostics` can check one file, a directory, or an explicit `filePaths` batch with bounded concurrency. `lsp_navigation` provides definitions, references, hover, workspace symbols, call hierarchy, rename edits, and `findSymbol` for filtered document-symbol lookup. Key operations:

- **`rename`** — renames a symbol across all references; `apply: true` writes workspace edits to disk with per-file LSP re-sync.
- **`rename_file`** — LSP-aware file rename: sends `workspace/willRenameFiles` to collect import-path rewrites, applies them, renames the file on disk, and notifies servers via `workspace/didRenameFiles`. `apply: false` previews the workspace edits without touching the filesystem.
- **`capabilities`** — shows which operations are supported by the active LSP server(s) for a file, read directly from the cached `initialize` response (no round-trip).
- **Symbol column resolution** — passing `symbol: "myFunc"` instead of an exact `character` position resolves the correct column automatically. Use `symbol: "foo#2"` for the second occurrence of `foo` on the line.

LSP servers for: TypeScript, Deno, Python (pyright/basedpyright + jedi), Go, Rust, Ruby (ruby-lsp + solargraph), PHP, C# (omnisharp), F#, Java, Kotlin, Swift, Dart, Lua, C/C++, Zig, Haskell, Elixir, Gleam, OCaml, Clojure, Terraform, Nix, Bash, Docker, YAML, JSON, HTML, TOML, Prisma, Vue, Svelte, CSS.

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

- **Zero-read block** — blocks any edit to a file not read in the current session. Agent-created files are exempt: when a `write` tool creates a new file, pi-lens registers the written content as a synthetic read, so an immediate follow-up `edit` is not blocked
- **File-modified block** — blocks if the file changed on disk since the last read (auto-format, external tool, or a previous edit that was then reformatted)
- **Out-of-range block** — blocks if the edit target lines fall outside the ranges previously read, ensuring the agent cannot modify code it hasn't seen
- **Snapshot validation** — covered edit ranges are hash-checked against the lines the agent actually saw at read time; stale-range edits are rejected even when range coverage exists. Hash capture covers reads up to 3 000 lines

Coverage is tracked across multiple reads: two reads of lines 1–100 and 101–200 together satisfy a full-file write. Symbol-expanded reads (small reads silently widened to the enclosing symbol via tree-sitter) count toward coverage at the symbol level. Markdown files generate a warning instead of blocking (edits outside the section-expanded read range are warned, not silently passed). Plain-text (`.txt`) and log (`.log`) files remain fully exempt.

Override for a single edit: `/lens-allow-edit <path>`

Configure behavior with `--no-read-guard` to disable entirely, or set mode to `warn` instead of `block`.

### Actionable Warnings

At `turn_end`, pi-lens writes `.pi-lens/cache/actionable-warnings.json` summarizing fixable warnings introduced by the current turn. This powers the optional conservative autofix at `agent_end`.

**Report contents:**
- Warnings are delta-only by default: only diagnostics in lines touched during the current turn are included. Pass `--lens-actionable-warning-all` to report all warnings regardless of location
- Each warning carries a stable `aw:<hash>` ID derived from file, rule, and message, so suppression state persists across turns in `.pi-lens/cache/actionable-warning-state.json`
- Sources: pipeline `fixable` diagnostics (always included) and LSP code-action warnings when `--lens-actionable-warning-actions` is set
- When warnings are present, a concise advisory is injected into the agent context (no blocker language)

**Conservative autofix (`agent_end`):**

When `actionableWarnings.autoFix.enabled` is set in global config (or `--lens-actionable-warning-autofix`), pi-lens applies LSP quickfixes from the report at `agent_end`. Safety gates:
- Re-fetches code actions from the live LSP server at fix time (stale actions are skipped)
- Skips any warning with zero or multiple eligible actions (ambiguity is not resolved)
- Applies only `edit`-kind actions (no command-only or create/delete operations)
- Hard cap of 5 fixes per `agent_end`
- Suppressed warnings are never autofixed

**Flags:**
- `--lens-actionable-warnings` — enable the turn_end report
- `--lens-actionable-warning-actions` — include LSP code-action warnings in the report
- `--lens-actionable-warning-autofix` — apply conservative fixes at agent_end
- `--lens-actionable-warning-all` — report all warnings, not just delta

### Opportunistic Read Expansion

When the agent reads a small slice of a file (≤ 60 lines), pi-lens transparently expands the read to the full enclosing symbol (function, method, or class) using the tree-sitter AST. The agent receives the full symbol as context, and the read guard records symbol-level coverage so edits anywhere within that symbol pass without requiring the agent to have read every line individually. Expansion runs within a 200 ms budget and falls back silently on unsupported file types or parse failures.

Supported: TypeScript, TSX, JavaScript, JSX, Python, Go, Rust, Ruby, Java, Kotlin, Dart, Elixir, C, C++, C#, PHP, Swift, Lua, OCaml, Zig, Bash.

### Fact Rules Pipeline

Covers JavaScript/TypeScript, Python, Go, Rust, Ruby, Shell, and CMake. A TypeScript AST-based fact-rule engine extracts function-level metrics and evaluates quality and security rules inline. Blocking rules surface immediately at write time; advisory rules are available via `/lens-booboo`.

### AST Search and Replace

`ast_grep_search` and `ast_grep_replace` provide AST-aware pattern matching across 40+ languages via the `sg` CLI. Key capabilities:

- **Metavariable captures** — named captures (`$VAR`, `$$$ARGS`) appear below each match: `$VAR=x  $$$ARGS=a,b,c`.
- **Strictness modes** — `strictness: "relaxed"` ignores optional punctuation (trailing commas, semicolons) that causes zero matches in `smart` mode. Also supports `ast`, `cst`, `signature`, `template`.
- **Pagination** — `skip: N` offsets into large result sets; truncated results include a next-page hint.
- **Stale-preview detection** — `ast_grep_replace` re-validates the pattern before writing; returns a clear error if files changed since the preview instead of applying against wrong content.
- **`ast_dump`** — dumps the full tree-sitter AST for a source snippet. Use this when a pattern returns zero matches and the correct node kind or field name is unknown.

### Tree-sitter Rules

Structural rules organized by language in `rules/tree-sitter-queries/<language>/`. Rules marked **🔴** block the agent inline at write time (only for lines in the current edit); others are advisory.

**Suppressing a finding:** add `// pi-lens-ignore: rule-id` on the flagged line or the line above (JS/TS), or `# pi-lens-ignore: rule-id` for Python/Ruby/Shell. This suppresses that specific rule at that location only.

**Bring your own rules:** drop YAML query files into `rules/tree-sitter-queries/<language>/` in your project — pi-lens merges them with the built-ins on session start. The schema, predicates (`eq`, `match`, `any-of`), and `inline_tier` (`blocking` | `warning` | `review`) are documented in [`docs/custom-rules.md`](docs/custom-rules.md). A `rules/tree-sitter-queries/rule-schema.json` JSON Schema is bundled for editor autocomplete via `.vscode/settings.json`.

### Ast-Grep Rules

Pattern-based structural rules in `rules/ast-grep-rules/` across JS, TS, and Python — covers security (eval, hardcoded secrets, insecure randomness, dangerous DOM sinks), correctness (strict equality, constant conditions, duplicate keys), code smells (nested ternaries, long parameter lists, redundant state), and agent stubs (unimplemented bodies, raise NotImplementedError).

**Bring your own rules:** drop YAML rule files into `rules/ast-grep-rules/rules/<id>.yml` in your project — pi-lens merges them with the built-ins; same `id` as a built-in overrides it. The supported subset of ast-grep's rule schema (the NAPI runner does not support `inside` / `follows` / `precedes` / `stopBy` / `field` / `nthChild` / `constraints` — use a tree-sitter rule when you need relational context) is documented in [`docs/custom-rules.md`](docs/custom-rules.md), with a `rules/ast-grep-rules/rule-schema.json` JSON Schema for editor autocomplete.

### Opengrep Security Scanner (Auxiliary LSP, Experimental)

[Opengrep](https://github.com/opengrep/opengrep) (an open, login-free fork of Semgrep) runs as a pi-lens **auxiliary diagnostic LSP** — a cross-cutting, diagnostic-only language server that attaches *alongside* the file's normal language server (TypeScript, Python, …) and contributes findings on the same on-write diagnostics path. Running it as a warm LSP server compiles its ruleset **once per session** rather than on every file, so per-file scans cost ~1–2s (vs ~8s for a cold CLI invocation per file). High-signal security findings become blocking; the rest are advisory.

- **On by default** (it's a registered LSP server) when the `opengrep` binary is available; pi-lens **auto-installs it on demand** — a single GitHub-release binary, **no login, token, or telemetry**. Disable with `--no-opengrep`.
- **Rules:** a repo `.opengrep.yml`/`.opengrep.yaml` (or a legacy `.semgrep.yml`/`.semgrep.yaml`, whose format Opengrep consumes natively) is used if present; otherwise it falls back to Opengrep's login-free `auto` Community ruleset.

This is the first adopter of pi-lens's **auxiliary-LSP capability** (`role:"auxiliary"` servers + `clients/dispatch/auxiliary-lsp.ts`) — the same path future cross-cutting scanners (spelling, secrets, …) plug into by registration.

Local rules can opt into pi-lens blocking semantics with metadata:

```yaml
metadata:
  pi-lens:
    semantic: blocking
    defect_class: injection
    confidence: high
```

## Run

```bash
# Standard mode (LSP enabled by default)
pi

# Optional switches
pi --no-lens             # Start pi-lens disabled for this session; /lens-toggle can re-enable
pi --no-lens-context     # Disable automatic context injection only (tools/LSP/read-guard/format stay on); /lens-context-toggle
pi --no-lsp              # Disable unified LSP diagnostics
pi --no-autoformat        # Skip auto-formatting entirely
pi --immediate-format      # Format immediately after each edit instead of deferring to agent_end
pi --no-autofix           # Skip auto-fix (Biome, Ruff, ESLint, stylelint, sqlfluff, RuboCop)
pi --no-tests             # Skip test runner
pi --no-delta             # Disable delta mode (show all diagnostics, not just new ones)
pi --lens-guard           # Block git commit/push when unresolved blockers exist (experimental)
pi --no-opengrep          # Disable the Opengrep security scanner (default-on auxiliary LSP)
```

## Global Config

pi-lens reads optional user preferences from `~/.pi-lens/config.json` (`%USERPROFILE%\\.pi-lens\\config.json` on Windows). Unknown keys are ignored, and missing or invalid config falls back to defaults.

Hide the diagnostics widget by default, run formatting immediately after write/edit tool calls instead of at `agent_end`, and enable actionable warnings with conservative autofix:

```json
{
  "widget": {
    "visible": false
  },
  "format": {
    "enabled": true,
    "mode": "immediate"
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

`contextInjection.enabled` (default `true`) controls whether pi-lens prepends automatic findings — session-start guidance, turn-end findings, and test findings — into the next model turn. Set it to `false` (or use `--no-lens-context` / `PI_LENS_NO_CONTEXT_INJECTION=1` / `/lens-context-toggle`) to keep tools, LSP, read-guard, and formatting running while avoiding the prompt-cache invalidation that injected messages cause in long, cache-sensitive sessions. Findings are still cached, so `lens_diagnostics` and `/lens-health` keep working.

`actionableWarnings.enabled` gates the turn_end report. `includeLspCodeActions` fetches LSP code actions for each warning (requires an active language server). `deltaOnly` (default `true`) limits the report to lines touched in the current turn. `autoFix.enabled` applies conservative LSP quickfixes at `agent_end`; `autoFix.maxFixes` caps the number applied per turn (default `5`).

## Environment Variables

- `PILENS_DATA_DIR` — redirect per-project state (scanner caches,
  turn-state.json) to a base directory outside the project. By default
  pi-lens writes to `~/.pi-lens/projects/<sanitized-cwd-slug>/`. The one
  exception is a legacy `<cwd>/.pi-lens/` directory: if that already exists
  in the project, pi-lens continues to use it. Set `PILENS_DATA_DIR` to
  permanently override both cases and write to
  `<PILENS_DATA_DIR>/<sanitized-cwd-slug>/` instead. Particularly useful
  when running pi with a local model server (llama.cpp, Ollama, etc.) that
  monitors the project directory — cache-file churn inside the workspace can
  disrupt the model's context scoring. Tool binaries always live in
  `~/.pi-lens/bin/` regardless.
- `PI_LENS_STARTUP_MODE` — `full` | `minimal` | `quick`. Override the
  auto-selected startup path. One-shot `pi --print` sessions auto-use `quick`
  to reduce latency.
- `PI_LENS_NO_CONTEXT_INJECTION` — set to `1` to disable automatic context
  injection (equivalent to `--no-lens-context` / `contextInjection.enabled:
  false`). Tools, LSP, read-guard, and formatting stay active; findings are
  still cached for `lens_diagnostics` and `/lens-health`.

## Key Commands

- `/lens-toggle` — toggle pi-lens on/off for the current session without restarting
- `/lens-context-toggle` — toggle automatic context injection on/off for the session (tools/LSP/read-guard/formatting stay active)
- `/lens-widget-toggle` — show/hide the pi-lens diagnostics widget below the editor
- `/lens-booboo` — full quality report for current project state
- `/lens-health` — runtime health, latency, and diagnostic telemetry
- `/lens-allow-edit <path>` — override the read-before-edit guard for a single edit
- `/lens-tools` — tool installation status: globally installed, auto-installed, or npx fallback
- `/lens-tdi` — Technical Debt Index (TDI) and project health trend

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
| `opengrep`                          | Experimental security dispatch   | Auto-install   | Local config / explicit opt-in     |
| `psscriptanalyzer`                  | PowerShell linting               | Manual         | —                                  |

Additional language servers (gopls, ruby-lsp, solargraph, etc.) are auto-detected from PATH or installed via native package managers (`go install`, `gem install`) when their language is detected.
