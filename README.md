# pi-lens

**pi extension for real-time code quality.** 31 LSP servers, tree-sitter structural analysis, AST pattern matching, auto-install for TypeScript/Python tooling, duplicate detection, complexity metrics, and inline blockers with comprehensive `/lens-booboo` reports.

## What pi-lens Does

**For every file you edit:**
1. **Auto-formats** — Detects and runs formatters (Biome, Prettier, Ruff, gofmt, rustfmt, etc.)
2. **Type-checks** — TypeScript, Python, Go, Rust (31 languages with `--lens-lsp`)
3. **Scans for secrets** — Blocks on hardcoded API keys, tokens, passwords
4. **Runs linters** — Biome (TS/JS), Ruff (Python), plus structural analysis
5. **Tree-sitter analysis** — Deep structural patterns (empty catch, eval, deep nesting, mixed async styles)
6. **Auto-installs** — TypeScript, Python, Biome, Ruff, and analysis tools auto-install on first use
7. **Only shows NEW issues** — Delta-mode tracks baselines and filters pre-existing problems

**Blockers** (type errors, secrets, empty catches) appear inline and stop the agent until fixed.  
**Warnings** (complexity, code smells) go to `/lens-booboo` — run it to see them all.

## Quick Start

```bash
# Install
pi install npm:pi-lens

# Standard mode (auto-formatting, type-checking, linting enabled by default)
pi

# Disable auto-formatting if needed
pi --no-autoformat

# Full LSP mode (31 language servers) — recommended for large/multi-language projects
pi --lens-lsp
```

## Install

```bash
pi install npm:pi-lens
```

Or directly from git:

```bash
pi install git:github.com/apmantza/pi-lens
```

---

## Features

### Auto-Formatting (Default Enabled)

pi-lens **automatically formats** every file you write or edit. Formatters are auto-detected based on your project configuration.

**Priority:** **Biome** is the default. **Prettier** runs only if Biome is not configured. This prevents race conditions and ensures consistent formatting.

| Formatter | Languages | Detection | Installation | Role |
|-----------|-----------|-----------|--------------|------|
| **Biome** | TS/JS/JSON/CSS | `biome.json` or `@biomejs/biome` in devDependencies | Automatic | **Default** |
| **Prettier** | TS/JS/JSON/CSS/Markdown | `.prettierrc` or `prettier` in devDependencies | Manual (`npm install -g prettier`) | Fallback |
| **Ruff** | Python | `[tool.ruff]` in `pyproject.toml` | Automatic | **Default** |
| **Black** | Python | `[tool.black]` in `pyproject.toml` | Manual (`pip install black`) | Fallback |
| **gofmt** | Go | `go` binary available | Manual (included with Go SDK) | Default |
| **rustfmt** | Rust | `rustfmt` binary available | Manual (included with Rust toolchain) | Default |
| **zig fmt** | Zig | `zig` binary available | Manual (included with Zig SDK) | Default |
| **dart format** | Dart | `dart` binary available | Manual (included with Dart SDK) | Default |
| **shfmt** | Shell | `shfmt` binary available | Manual (download binary) | Default |
| **mix format** | Elixir | `mix` binary available | Manual (included with Elixir) | Default |

(*) = Auto-installed (no manual setup required)

**How it works:**
1. Agent writes a file
2. pi-lens detects formatters based on config files/dependencies
3. Biome takes priority; Prettier runs only if Biome is not configured
4. FileTime tracking ensures safety (agents re-read if file changes externally)

**Safety:** If a formatter changes the file, the agent is notified and must re-read before next edit — preventing stale content overwrites.

**Disable:**
```bash
pi --no-autoformat    # Skip automatic formatting
```

---

### Auto-Linting (Default Enabled)

pi-lens **automatically lints** every file you write or edit. Linters are auto-detected based on your project configuration.

| Linter | Languages | Installation | Role | Priority |
|--------|-----------|--------------|------|----------|
| **Biome** | TS/JS/JSON/CSS | Automatic | **Default** | 10 |
| **Ruff** | Python | Automatic | **Default** | 10 |
| **oxlint** | TS/JS | Manual (`npm i -g oxlint`) | Fast alternative | 12 |
| **ESLint** | JS/Vue/Svelte | `npx` via `--lens-lsp` | LSP only | - |
| **shellcheck** | Bash/sh/zsh/fish | Manual (`apt install shellcheck`) | Shell scripts | 20 |

(*) = Auto-installed (no manual setup required)

**Priority:** Lower numbers = run earlier. Biome/Ruff run first, followed by specialized linters.

**How it works:**
1. Agent writes a file
2. pi-lens detects linters based on config files and file type
3. Biome takes priority for TS/JS; Ruff takes priority for Python
4. Multiple linters can run on the same file (e.g., Biome + oxlint)
5. Issues are delta-tracked (only new issues shown after first write)

**Notes:**
- Biome and Ruff are **dual-purpose** (lint + format)
- oxlint is a faster Rust-based alternative to ESLint
- ESLint only runs when `--lens-lsp` is enabled
- shellcheck requires manual installation on most systems

---

### LSP Support (NEW) — 31 Language Servers

Enable full Language Server Protocol support with `--lens-lsp`:

| Category | Languages |
|----------|-----------|
| **Core** | TypeScript, Python, Go, Rust, Ruby, PHP, C#, F#, Java, Kotlin |
| **Native** | C/C++, Zig, Swift, Haskell, OCaml, Lua, Dart |
| **Functional** | Elixir, Gleam, Clojure, Haskell |
| **DevOps** | Terraform, Nix, Docker, Bash |
| **Config** | YAML, JSON, Prisma |
| **Web** | Vue, Svelte, CSS/SCSS/Sass/Less |

**Auto-installation (8 tools):** TypeScript, Python, Biome, Ruff, and analysis tools (Madge, jscpd, ast-grep, Knip) auto-install on first use to `.pi-lens/tools/`. Other LSP servers are launched via `npx` when available or require manual installation.

**Usage:**
```bash
pi --lens-lsp                    # Enable LSP
```

### `pi` vs `pi --lens-lsp`

| Feature | `pi` (Default) | `pi --lens-lsp` |
|---------|----------------|-----------------|
| **Type Checking** | Built-in TypeScriptClient | Full LSP (31 language servers) |
| **Auto-format** | Biome, Prettier, Ruff, etc. | Same |
| **Auto-fix** | Enabled by default | Same |
| **Secrets scan** | Blocks on hardcoded secrets | Same |
| **Languages** | TypeScript, Python (built-in) | 31 languages via LSP |
| **Python** | Ruff/pyright (built-in) | Pyright LSP |
| **Go, Rust, etc.** | Basic linting | Full LSP support |

**Recommendation:** Use `pi` for TypeScript/Python projects. Use `pi --lens-lsp` for multi-language projects or when you need full language server features.

See [docs/LSP_CONFIG.md](docs/LSP_CONFIG.md) for configuration options.

---

### On every write / edit

Every file write/edit triggers multiple analysis phases:

**Execution flow:**
1. **Secrets scan** (pre-flight) — Hardcoded secrets block immediately (non-runner check)
2. **LSP integration** (Phase 3, with `--lens-lsp`) — Real-time type errors from language servers
3. **Dispatch system** — Routes file to appropriate runners by `FileKind`
4. **Runners execute** by priority (lower = earlier). See [Runners](#runners) section for full list.
5. **Test runner detection** (post-write) — Detects Jest/Vitest/Pytest and runs relevant tests

**Delta mode behavior:**
- **First write:** All issues tracked and stored in baseline
- **Subsequent edits:** Only **NEW** issues shown (pre-existing issues filtered out)
- **Goal:** Don't spam agent with issues they didn't cause

**Output shown inline:**
```
STOP — 1 issue(s) must be fixed:
  L23: var total = sum(items); — use 'let' or 'const'
```

> **Note:** Only **blocking** issues (`ts-lsp`, `pyright` errors, `type-safety` switch errors, secrets) appear inline. Warnings are tracked but not shown inline (noise reduction) — run `/lens-booboo` to see all warnings.

---

### Runners

pi-lens uses a **dispatcher-runner architecture** for extensible multi-language support. Runners are executed by priority (lower = earlier).

| Runner | Language | Priority | Output | Description |
|--------|----------|----------|--------|-------------|
| **ts-lsp** | TypeScript | 5 | Blocking | TypeScript errors (hard stops) |
| **pyright** | Python | 5 | Blocking | Python type errors (hard stops) |
| **biome** | TS/JS | 10 | Warning | Linting issues (delta-tracked) |
| **ruff** | Python | 10 | Warning | Python linting (delta-tracked) |
| **oxlint** | TS/JS | 12 | Warning | Fast Rust-based JS/TS linter |
| **tree-sitter** | TS/JS, Python | 14 | Mixed | AST-based structural analysis (21 patterns) — **singleton WASM client** |
| **ast-grep-napi** | TS/JS | 15 | Blocking | Security rules inline (no-eval, jwt-no-verify, no-hardcoded-secrets, etc.) |
| **type-safety** | TS | 20 | Mixed | Switch exhaustiveness (blocking), other (warning) |
| **shellcheck** | Shell | 20 | Warning | Bash/sh/zsh/fish linting |
| **python-slop** | Python | 25 | Warning | AI slop detection (~40 patterns) |
| **spellcheck** | Markdown | 30 | Warning | Typo detection in docs |
| **similarity** | TS | 35 | Warning | Semantic duplicate detection (structural similarity) |
| **architect** | All | 40 | Warning | Architectural rule violations |
| **go-vet** | Go | 50 | Warning | Go static analysis |
| **rust-clippy** | Rust | 50 | Warning | Rust linting |

**Priority legend:**
- **5** — Type checkers (blocking errors)
- **10-15** — Linters and structural analysis
- **20-30** — Specialized checks (safety, slop, spellcheck)
- **35** — Metrics only (silent)
- **40-50** — Language-specific and architectural

**Output semantics:**
- **Blocking** — Hard stop, must fix (type errors, secrets)
- **Warning** — Shown in `/lens-booboo`, not inline (noise reduction)
- **Silent** — Tracked in metrics only, never shown

**Consolidated runners:** `ts-slop` merged into `ast-grep-napi` — CLI ast-grep used for full linter via `/lens-booboo`

**Tree-sitter runner patterns** (priority 14, AST-based structural analysis):

TypeScript/JavaScript (13 patterns):
- **Error**: empty-catch, hardcoded-secrets, eval
- **Warning**: debugger, await-in-loop, console-statement, long-parameter-list, nested-ternary, deep-promise-chain, mixed-async-styles, deep-nesting, constructor-super, no-dupe-class-members

TSX (2 patterns):
- **Error**: dangerously-set-inner-html
- **Warning**: no-nested-links

Python (6 patterns):
- **Error**: bare-except, mutable-default-arg, eval-exec, unreachable-except  
- **Warning**: wildcard-import, is-vs-equals

**Custom tree-sitter queries:** Add `.yml` files to `.pi-lens/rules/tree-sitter-queries/{typescript,python}/`

**AI Slop Detection:** 
- `python-slop` runner (priority 25): ~40 patterns for Python code quality
- `ast-grep-napi` runner (priority 15): Security rules fire inline (blocking); slop/architecture warnings via `/lens-booboo` only. Skips 5 rules already covered by tree-sitter.

---

### Additional Safeguards

Safeguards that run **before** the dispatch system:

#### Secrets Scanning (Pre-flight)

Runs on every file write/edit **before** any other checks. Scans for:
- Stripe/OpenAI keys (`sk-*`)
- GitHub tokens (`ghp_*`, `github_pat_*`)
- AWS keys (`AKIA*`)
- Slack tokens (`xoxb-*`, `xoxp-*`)
- Private keys (`BEGIN PRIVATE KEY`)
- Hardcoded passwords and API keys

**Behavior:** Always blocking, always runs on all file types. Cannot be disabled — security takes precedence.

#### Agent Behavior Warnings

Inline heuristics to catch anti-patterns in real-time:

**Blind Write Detection**
- **Triggers:** Agent edits a file without reading it in the last 5 tool calls
- **Warning:** `BLIND WRITE — editing 'file.ts' without reading in the last 5 tool calls.`
- **Why:** Prevents edits based on stale assumptions

**Thrashing Detection**
- **Triggers:** 3+ consecutive identical tool calls within 30 seconds
- **Warning:** `[!] THRASHING — 3 consecutive 'edit' calls with no other action.`
- **Why:** Catches stuck loops where the agent repeats failed actions

**Behavior:** Warnings appear inline but do **not** block execution.

#### Custom ast-grep Rules

Create your own structural rules in `.pi-lens/rules/`:

```yaml
# .pi-lens/rules/no-console-prod.yml
id: no-console-prod
language: javascript
rule:
  pattern: console.$METHOD($$$ARGS)
message: "Remove console statements before production"
severity: warning
```

See [AST_GREP_RULES.md](AST_GREP_RULES.md) for full guide.

---

### At Session Start

When pi starts a new session, pi-lens performs initialization scans to establish baselines and surface existing technical debt:

**Initialization sequence:**
1. **Reset session state** — Clear metrics and complexity baselines
2. **Initialize LSP** (with `--lens-lsp`) — Detect and auto-install language servers
3. **Pre-install TypeScript LSP** (with `--lens-lsp`) — Warm up cache for instant response
4. **Detect available tools** — Biome, ast-grep, Ruff, Knip, jscpd, Madge, type-coverage, Go, Rust
5. **Load architect rules** — If `architect.yml` or `.architect.yml` present
6. **Detect test runner** — Jest, Vitest, Pytest, etc.

**Cached scans** (with 5-min TTL):
| Scan | Tool | Cached | Purpose |
|------|------|--------|---------|
| **TODOs** | Internal | No | Tech debt markers |
| **Dead code** | Knip | Yes | Unused exports/files/deps |
| **Duplicates** | jscpd | Yes | Copy-paste detection |
| **Exports** | ast-grep | No | Function index for similarity |

**Error debt tracking** (with `--error-debt` flag):
- If tests passed at end of previous session but fail now → **regression detected**
- Blocks agent until tests pass again

**Output:** Scan results appear in session startup notification

---

### Code Review

```
/lens-booboo [path]
```

Full codebase analysis with **10 tracked runners** producing a comprehensive report:

| # | Runner | What it finds |
|---|--------|---------------|
| 1 | **ast-grep (design smells)** | Structural issues (empty catch, no-debugger, etc.) |
| 2 | **ast-grep (similar functions)** | Duplicate function patterns across files |
| 3 | **semantic similarity (Amain)** | 57×72 matrix semantic clones (>75% similarity) |
| 4 | **complexity metrics** | Low MI, high cognitive complexity, AI slop indicators |
| 5 | **TODO scanner** | TODO/FIXME annotations and tech debt markers |
| 6 | **dead code (Knip)** | Unused exports, files, dependencies |
| 7 | **duplicate code (jscpd)** | Copy-paste blocks with line/token counts |
| 8 | **type coverage** | Percentage typed vs `any`, low-coverage files |
| 9 | **circular deps (Madge)** | Import cycles and dependency chains |
| 10 | **architectural rules** | Layer violations, file size limits, path rules |

**Output:**
- **Terminal:** Progress `[1/10] runner...` with timing, summary with findings per runner
- **JSON:** `.pi-lens/reviews/booboo-{timestamp}.json` (structured data for AI processing)
- **Markdown:** `.pi-lens/reviews/booboo-{timestamp}.md` (human-readable report)

**Usage:**
```bash
/lens-booboo              # Scan current directory
/lens-booboo ./src        # Scan specific path
```

---

### Test Runner

**Auto-detected test runners:**
| Runner | Config Files | Languages |
|--------|--------------|-----------|
| **Vitest** | `vitest.config.ts`, `vitest.config.js` | TypeScript, JavaScript |
| **Jest** | `jest.config.js`, `jest.config.ts`, `package.json` (jest field) | TypeScript, JavaScript |
| **Pytest** | `pytest.ini`, `setup.cfg`, `pyproject.toml` | Python |

**Behavior:**
- **On file write:** Detects corresponding test file and runs it
- **Pattern matching:** `file.ts` → `file.test.ts` or `__tests__/file.test.ts`
- **Output:** Inline pass/fail with failure details (shown with lint results)
- **Flag:** Use `--no-tests` to disable automatic test running

**Execution flow:**
1. Agent writes `src/utils.ts`
2. pi-lens finds `src/utils.test.ts` (or `__tests__/utils.test.ts`)
3. Runs only that test file (not full suite)
4. Results appear inline:
```
[tests] 3 passed, 1 failed (42ms)
  ✓ should calculate total
  ✗ should handle empty array (expected 0, got undefined)
```

**Why only corresponding tests?**
Running the full suite on every edit would be too slow. Targeted testing gives immediate feedback for the code being edited.

---

### Complexity Metrics

pi-lens tracks code quality metrics for every file:

| Metric | Description | Threshold |
|--------|-------------|-----------|
| **Maintainability Index** | 0-100 composite score | >60 good <20 bad |
| **Cognitive Complexity** | Mental effort to understand | >20 warn >50 bad |
| **Cyclomatic Complexity** | Independent code paths | >10 warn >20 bad |
| **Code Entropy** | Shannon entropy in bits | >4.0 warn >7.0 bad |

**Commands:**
- `/lens-tdi` — Technical Debt Index (0-100) with grades A-F
- `/lens-booboo` — Full complexity table for all files

See [docs/COMPLEXITY_METRICS.md](docs/COMPLEXITY_METRICS.md) for formulas and detailed calculations.

---

## Dependent Tools

pi-lens works out of the box for TypeScript/JavaScript. For full language support, install these tools — **all are optional and gracefully skip if not installed**:

### JavaScript / TypeScript

| Tool | Install | What it does |
|------|---------|--------------|
| `@biomejs/biome` | `npm i -D @biomejs/biome` | Linting + formatting |
| `oxlint` | `npm i -D oxlint` | Fast Rust-based JS/TS linting |
| `knip` | `npm i -D knip` | Dead code / unused exports |
| `jscpd` | `npm i -D jscpd` | Copy-paste detection |
| `type-coverage` | `npm i -D type-coverage` | TypeScript `any` coverage % |
| `@ast-grep/napi` | `npm i -D @ast-grep/napi` | Fast structural analysis (TS/JS) — security rules inline, slop in booboo |
| `@ast-grep/cli` | `npm i -D @ast-grep/cli` | Structural pattern matching (all languages) |
| `typos-cli` | `cargo install typos-cli` | Spellcheck for Markdown |

### Python

| Tool | Install | What it does |
|------|---------|--------------|
| `ruff` | `pip install ruff` | Linting + formatting |
| `pyright` | `pip install pyright` | Type-checking (catches type errors) |

### Go

| Tool | Install | What it does |
|------|---------|--------------|
| `go` | [golang.org](https://golang.org) | Built-in `go vet` for static analysis |

### Rust

| Tool | Install | What it does |
|------|---------|--------------|
| `rust` + `clippy` | [rustup.rs](https://rustup.rs) | Linting via `cargo clippy` |

### Shell

| Tool | Install | What it does |
|------|---------|--------------|
| `shellcheck` | `apt install shellcheck` / `brew install shellcheck` | Shell script linting (bash/sh/zsh/fish) |

---

## Commands

| Command | Description |
|---------|-------------|
| `/lens-booboo` | Full codebase review (10 analysis runners) |
| `/lens-tdi` | Technical Debt Index and trends |

---

## Execution Modes

| Mode | Command | What happens |
|------|---------|--------------|
| **Standard** (default) | `pi` | Auto-formatting, TS/Python type-checking, sequential execution |
| **Full LSP** | `pi --lens-lsp` | Real LSP servers (31 languages), sequential execution |


### Flag Reference

| Flag | Description |
|------|-------------|
| `--lens-lsp` | Use real Language Server Protocol servers instead of built-in type-checking |
| `--lens-verbose` | Enable detailed console logging |
| `--no-autoformat` | Disable automatic formatting (formatting is **enabled by default**) |
| `--no-autofix` | Disable all auto-fixing (Biome safe fixes + Ruff autofix **enabled by default**). Unsafe fixes (e.g. removing unused vars) are never applied automatically — use `/lens-booboo` with explicit confirmation. |
| `--no-autofix-biome` | Disable Biome auto-fix only |
| `--no-autofix-ruff` | Disable Ruff auto-fix only |
| `--no-oxlint` | Skip Oxlint linting |
| `--no-shellcheck` | Skip shellcheck for shell scripts |
| `--no-tests` | Disable automatic test running on file write |
| `--no-madge` | Skip circular dependency checks |
| `--no-ast-grep` | Skip ast-grep structural analysis |
| `--no-biome` | Skip Biome linting |
| `--no-lsp` | Skip TypeScript/Python type checking |
| `--error-debt` | Track test regressions across sessions |

**Recommended combinations:**
```bash
pi                               # Default: auto-format, auto-fix, built-in type-checking
pi --lens-lsp                    # LSP type-checking (31 languages)
```

---

## TypeScript LSP — tsconfig detection

The LSP walks up from edited files to find `tsconfig.json`, using its `compilerOptions` (paths, strict settings, etc.). Falls back to sensible defaults if not found.

---

## Project Structure

```
pi-lens/
├── clients/          # Lint tools, LSP clients, formatters
├── commands/         # /lens-booboo, /lens-format commands
├── docs/             # Documentation
├── rules/            # AST-grep rules
├── skills/           # Built-in pi skills
├── index.ts          # Main extension entry point
└── package.json
```

See source for detailed structure.

---

## Skills

pi-lens includes two built-in skills that guide the LLM on when to use specific tools:

### ast-grep

**Purpose:** Guide AST-aware pattern matching for semantic code search/replace.

**When to load:** Use `/skill:ast-grep` when performing structural code searches (finding function calls, class methods, imports) or replacements across files.

**Key guidance:**
- Use `$VAR` for single nodes, `$$$` for multiple
- Patterns must be **complete valid code** (not fragments)
- **Workflow:** Search → Dry-run (`apply: false`) → Apply (`apply: true`)
- **Error "Multiple AST nodes":** Use metavariables like `it($TEST)` not raw text like `it"test"`

```typescript
// GOOD: Complete code with metavariables
ast_grep_search
  pattern: "console.log($MSG)"
  lang: typescript
  paths: ["src/"]

// BAD: BAD: Incomplete pattern
pattern: "console.log("  // Missing args/body
```

### lsp-navigation

**Purpose:** Guide code intelligence via Language Server Protocol.

**When to load:** Use `/skill:lsp-navigation` for understanding code structure — definitions, references, types, call hierarchy.

**Key guidance:**
- **LSP is PRIMARY** for code intelligence — NOT grep/glob/ast-grep
- Requires `--lens-lsp` flag
- Call hierarchy: `prepareCallHierarchy` → `incomingCalls`/`outgoingCalls`

| Task | Use LSP | Use Other |
|------|---------|-----------|
| "Where is this defined?" | `definition` | — |
| "Find all usages" | `references` | — |
| "What type is this?" | `hover` | — |
| "Who calls this function?" | `prepareCallHierarchy` → `incomingCalls` | — |
| Find patterns (console.log) | — | `ast_grep_search` |
| Find TODO comments | — | `grep` |

```typescript
// Code intelligence → LSP
lsp_navigation
  operation: "references"
  filePath: "src/utils.ts"
  line: 42
  character: 10

// BAD: Don't use LSP for text patterns
pattern: "TODO"  // Use grep instead
```

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for full history.

---

## License

MIT
