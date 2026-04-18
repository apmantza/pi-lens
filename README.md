# pi-lens

pi-lens focuses on real-time inline code feedback for AI agents.

## What It Does

### On Write/Edit

On every `write` and `edit`, pi-lens runs a fast, language-aware pipeline (checks depend on file language, project config, and installed tools):

1. **Secrets scan** — blocking; aborts the write if credentials are detected
2. **Auto-format** — language-specific formatters (Biome, Prettier, Ruff, gofmt, rustfmt, and 25+ others)
3. **Auto-fix** — safe autofixes (Biome `--write`, Ruff `--fix`, ESLint `--fix`) applied before analysis
4. **LSP file sync** — opens/updates the file in active language servers
5. **Dispatch lint** — parallel runner groups: LSP diagnostics, tree-sitter structural rules, ast-grep security/correctness rules, fact rules, language-specific linters, similarity detection, and architect checks
6. **Test runner** — runs the corresponding test file; reruns known failures first
7. **Cascade diagnostics** — review-graph impact cascade showing which other files were affected and how diagnostics propagated

Results are inline and actionable:
- **Blocking issues** — stop progress until fixed
- **Warnings** — summarized inline, detail in `/lens-booboo`
- **Health/telemetry** — available in `/lens-health`

### Session Start

At `session_start`, pi-lens:

- resets runtime state and diagnostic telemetry
- detects project root, language profile, and active tools
- applies language-aware startup defaults for tool preinstall
- warms caches and optional indexes (with overlap/session guardrails)
- emits missing-tool install hints for detected languages when relevant
- injects session guidance through internal context (non-user channel) to reduce acknowledgement-only first responses

For one-shot print sessions (for example `pi --print ...`), pi-lens auto-uses a quick startup path that skips heavy bootstrap work to reduce startup latency. Override with `PI_LENS_STARTUP_MODE=full|minimal|quick`.

### Turn End

At `turn_end`, pi-lens:

- summarizes deferred findings (for example duplicates/circulars)
- persists turn findings for next context injection
- updates debt/diagnostic tracking and cleans transient state
- renders a review-graph impact cascade showing affected files and diagnostic propagation

## Install

```bash
pi install npm:pi-lens
```

Or from git:

```bash
pi install git:github.com/apmantza/pi-lens
```

## Run

```bash
# Standard mode (LSP enabled by default)
pi

# Optional switches
pi --no-lsp              # Disable unified LSP, use language-specific fallbacks
pi --lens-guard           # Block git commit/push when unresolved blockers exist
pi --no-autoformat        # Skip auto-formatting
pi --no-autofix           # Skip auto-fix (Biome, Ruff, ESLint)
pi --no-autofix-biome   # Skip Biome autofix only
pi --no-autofix-ruff    # Skip Ruff autofix only
pi --no-tests             # Skip test runner
pi --lens-verbose         # Verbose diagnostic output
pi --lens-blocking-only    # Only show blocking issues
pi --no-biome             # Disable Biome runner
pi --no-oxlint            # Disable oxlint runner
pi --no-ast-grep          # Disable ast-grep runner
pi --no-ruff              # Disable Ruff runner
pi --no-shellcheck        # Disable shellcheck runner
pi --no-madge             # Disable circular dependency detection
pi --no-go                # Disable Go-specific runners
pi --no-rust              # Disable Rust-specific runners
pi --auto-install         # Auto-install missing tools without prompting
pi --lens-eslint-core     # Use eslint-core rules only
```

## Key Commands

- `/lens-booboo` — full quality report for current project state
- `/lens-tdi` — technical debt index with 5-factor breakdown
- `/lens-health` — runtime health, latency, and diagnostic telemetry

## Language Coverage

pi-lens supports **35+ languages** through dispatch runners and LSP integration:

| Language | LSP | Dispatch Runners | Formatter |
|---|---|---|---|
| JavaScript/TypeScript | ✓ | lsp, ts-lsp, biome-check-json, tree-sitter, ast-grep-napi, type-safety, similarity, fact-rules, eslint, architect | biome, prettier |
| Python | ✓ | lsp, pyright, ruff-lint, python-slop, architect | ruff, black |
| Go | ✓ | lsp, go-vet, golangci-lint, tree-sitter | gofmt |
| Rust | ✓ | lsp, rust-clippy, tree-sitter | rustfmt |
| Ruby | ✓ | lsp, rubocop, tree-sitter | rubocop, standardrb |
| C/C++ | ✓ | lsp, cpp-check | clang-format |
| Shell | ✓ | lsp, shellcheck | shfmt |
| CSS/SCSS/Less | ✓ | lsp, stylelint, prettier-check | biome, prettier |
| HTML | ✓ | lsp, htmlhint, prettier-check | prettier |
| YAML | ✓ | lsp, yamllint | prettier |
| JSON | ✓ | lsp | biome, prettier |
| SQL | — | sqlfluff | sqlfluff |
| Markdown | — | spellcheck, markdownlint | prettier |
| Docker | ✓ | lsp, hadolint | — |
| PHP | ✓ | lsp, php-lint, phpstan | php-cs-fixer |
| PowerShell | ✓ | lsp, psscriptanalyzer | — |
| Prisma | ✓ | lsp, prisma-validate | — |
| C# | ✓ | lsp, dotnet-build | csharpier |
| F# | ✓ | lsp | fantomas |
| Java | ✓ | lsp, javac | — |
| Kotlin | ✓ | lsp, ktlint | ktlint |
| Swift | ✓ | lsp | swiftformat |
| Dart | ✓ | lsp, dart-analyze | dart format |
| Lua | ✓ | lsp | stylua |
| Zig | ✓ | lsp, zig-check | zig fmt |
| Haskell | ✓ | lsp | ormolu |
| Elixir | ✓ | lsp, elixir-check, credo | mix format |
| Gleam | ✓ | lsp, gleam-check | gleam format |
| OCaml | ✓ | lsp | ocamlformat |
| Clojure | ✓ | lsp | — |
| Terraform | ✓ | lsp, tflint | terraform fmt |
| Nix | ✓ | lsp | nixfmt |
| TOML | ✓ | lsp, taplo | taplo |
| CMake | ✓ | lsp | — |

## Fact Rules Pipeline

Dispatch includes a fact-rule engine that extracts function-level metrics (cyclomatic complexity, nesting depth, outgoing calls) and evaluates quality rules inline:

- **high-complexity** — flags functions exceeding configurable CC thresholds
- **unsafe-boundary** — detects dangerous boundary crossings (unvalidated user input → trusted context)
- **high-fan-out** — flags excessive outgoing call count (default threshold: 20)
- **comment-facts** — classifies comment quality (TODO density, doc coverage)
- **try-catch-facts** — flags empty/obscuring catch blocks
- **import-facts** — detects circular/star/unused imports
- **file-role** — classifies files as source/test/config/vendor and adjusts severity

## Tree-sitter Rules

Structural rules are organized by language in `rules/tree-sitter-queries/`:

- **TypeScript** (18 rules): console-statement, debugger, deep-nesting, eval, sql-injection, ssrf, weak-hash, unsafe-regex, variable-shadowing, and more
- **Python** (26 rules): debug statements, hardcoded secrets, mutable class attrs, unsafe regex, empty except, and more
- **Go** (17 rules): defer-in-loop, hardcoded secrets, unchecked errors, and more
- **Rust** (6 rules): unsafe blocks, unwrap outside tests, and more
- **Ruby** (15 rules): empty rescue, rescue Exception, debugger, hardcoded secrets, and more

Plus **180+ ast-grep rules** in `rules/ast-grep-rules/` covering security (no-eval, jwt-no-verify, no-hardcoded-secrets, no-insecure-randomness), correctness (strict-equality, empty-catch, no-cond-assign), and style patterns across JS/TS/Python.

## Review Graph

pi-lens builds a review graph (`file → symbol → dependency`) during session and uses it at turn end to render an impact cascade: which files were affected by a change and how diagnostics propagated through the dependency graph. Nodes track kind, language, and export status; edges track contains/imports/calls/references.

## LSP Support

pi-lens includes **37 language server definitions**. LSP is **enabled by default** (`--lsp` or no flag). Servers are auto-discovered from PATH, project `node_modules`, and managed installs. When a server is not installed, pi-lens offers an interactive install prompt.

LSP servers for: TypeScript, Deno, Python (pyright + pylsp), Go, Rust, Ruby (ruby-lsp + solargraph), PHP, C# (omnisharp), F#, Java, Kotlin, Swift, Dart, Lua, C/C++, Zig, Haskell, Elixir, Gleam, OCaml, Clojure, Terraform, Nix, Bash, Docker, YAML, JSON, HTML, TOML, Prisma, Vue, Svelte, ESLint, CSS.

## Runners

44 registered dispatch runners:

| Category | Runners |
|---|---|
| LSP | `lsp`, `ts-lsp`, `pyright` |
| JS/TS | `biome-check-json`, `eslint`, `ast-grep-napi`, `type-safety`, `similarity`, `tree-sitter`, `fact-rules` |
| Python | `ruff-lint`, `python-slop`, `mypy` |
| Go | `go-vet`, `golangci-lint` |
| Rust | `rust-clippy` |
| Ruby | `rubocop` |
| PHP | `php-lint`, `phpstan` |
| C# | `dotnet-build` |
| Java | `javac` |
| Kotlin | `ktlint` |
| Dart | `dart-analyze` |
| Elixir | `elixir-check`, `credo` |
| Gleam | `gleam-check` |
| Zig | `zig-check` |
| C/C++ | `cpp-check` |
| Docker | `hadolint` |
| HTML | `htmlhint` |
| CSS | `stylelint`, `prettier-check` |
| Markdown | `markdownlint`, `spellcheck` |
| Shell | `shellcheck`, `shfmt` |
| YAML | `yamllint` |
| SQL | `sqlfluff` |
| TOML | `taplo` |
| Terraform | `tflint` |
| PowerShell | `psscriptanalyzer` |
| Prisma | `prisma-validate` |
| Architecture | `architect`, `fact-rules` |

Runners are language/config-gated and skip when not applicable. `ast-grep-napi` runs in post-write dispatch for JS/TS with blocker-focused filtering; `/lens-booboo` additionally runs full CLI ast-grep scans.

## Formatters

pi-lens auto-detects and runs **26 formatters** based on project config:

biome, prettier, ruff, black, sqlfluff, gofmt, rustfmt, zig fmt, dart format, shfmt, nixfmt, mix format, ocamlformat, clang-format, ktlint, rubocop, standardrb, gleam format, terraform fmt, php-cs-fixer, csharpier, fantomas, swiftformat, stylua, ormolu, taplo

Detection rules:
- **Config-gated**: only runs when project config indicates usage (e.g. `biome.json`, `.prettierrc`, `ruff.toml`)
- **Nearest-wins**: when multiple formatter configs exist at different directory levels, the one closest to the edited file wins
- **Biome-default**: for JS/TS files without Prettier or Biome config, Biome is used as the default formatter
- **Ruff-default**: for Python files without Black config, Ruff format is used when available

## Dependencies

Auto-install behavior depends on gate type:

- **Config-gated**: installs only when project config/deps indicate usage
- **Flow/language-gated**: installs when the runtime path needs it for the current file/session flow
- **Operational prewarm**: installs during session warm scans / turn-end analysis paths
- **GitHub release**: platform-specific binary downloaded from GitHub releases to `~/.pi-lens/bin/`

| Tool | Purpose | Auto-installed | Gate |
|---|---|---|---|
| `@biomejs/biome` | JS/TS lint/format/autofix | Yes | Config-gated |
| `prettier` | Formatting fallback | Yes | Config-gated |
| `yamllint` | YAML linting | Yes | Config-gated |
| `sqlfluff` | SQL linting/formatting | Yes | Config-gated |
| `ruff` | Python lint/format/autofix | Yes | Language-default + flow-gated |
| `typescript-language-server` | Unified LSP diagnostics | Yes | Language-default |
| `typescript` | TypeScript compiler | Yes | Language-default |
| `pyright` | Python type diagnostics fallback | Yes | Flow/language-gated |
| `@ast-grep/cli` (sg) | AST scans/search/replace | Yes | Operational prewarm |
| `knip` | Dead code analysis | Yes | Operational prewarm + config-gated |
| `jscpd` | Duplicate code detection | Yes | Operational prewarm + config-gated |
| `madge` | Circular dependency analysis | Yes | Turn-end analysis flow |
| `mypy` | Python type checking | Yes | Flow-gated |
| `stylelint` | CSS/SCSS/Less linting | Yes | Config-gated |
| `markdownlint-cli2` | Markdown linting | Yes | Config-gated |
| `shellcheck` | Shell script linting | Yes | GitHub release |
| `shfmt` | Shell script formatting | Yes | GitHub release |
| `rust-analyzer` | Rust LSP | Yes | GitHub release |
| `golangci-lint` | Go linting | Yes | GitHub release |
| `hadolint` | Dockerfile linting | Yes | GitHub release |
| `ktlint` | Kotlin linting | Yes | GitHub release |
| `tflint` | Terraform linting | Yes | GitHub release |
| `taplo` | TOML linting/formatting | Yes | GitHub release |
| `terraform-ls` | Terraform LSP | Yes | GitHub release |
| `htmlhint` | HTML linting | Yes | Config-gated |
| `@prisma/language-server` | Prisma LSP | Yes | Flow-gated |
| `dockerfile-language-server-nodejs` | Dockerfile LSP | Yes | Flow-gated |
| `intelephense` | PHP LSP | Yes | Flow-gated |
| `bash-language-server` | Bash LSP | Yes | Language-default |
| `yaml-language-server` | YAML LSP | Yes | Language-default |
| `vscode-langservers-extracted` | JSON/ESLint/CSS/HTML LSP | Yes | Language-default |
| `vscode-css-languageserver` | CSS LSP | Yes | Language-default |
| `vscode-html-languageserver-bin` | HTML LSP | Yes | Language-default |
| `svelte-language-server` | Svelte LSP | Yes | Flow-gated |
| `@vue/language-server` | Vue LSP | Yes | Flow-gated |
| `psscriptanalyzer` | PowerShell linting | Manual | — |

Additional language servers (gopls, ruby-lsp, solargraph, etc.) are auto-detected from PATH or installed via native package managers (`go install`, `gem install`) when their language is detected.

## Notes

- Not every auto-install runs in every project: gate type decides when install is attempted.
- Rule packs are customizable via project-level rule directories.
- Inline suppression: `// pi-lens-ignore` or `# pi-lens-ignore` comments suppress diagnostic output for that line.