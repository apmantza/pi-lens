# pi-lens

Real-time code quality feedback for [pi](https://github.com/mariozechner/pi-coding-agent). Every write and edit is automatically analysed — diagnostics are injected directly into the tool result so the agent sees them without any extra steps.

---

## Features

### On every write / edit

| Tool | What it checks |
|---|---|
| **TypeScript LSP** | Type errors and warnings, using the project's `tsconfig.json` (walks up from the file to find it; falls back to `ES2020 + DOM` defaults) |
| **ast-grep** | 60+ structural rules: `no-var`, `no-eval`, `no-debugger`, `no-as-any`, `prefer-template`, `no-throw-string`, `no-hardcoded-secrets`, `no-return-await`, nested ternaries, strict equality, and more |
| **Biome** | Lint + format for JS/TS/JSX/TSX/CSS/JSON. Auto-fix disabled by default, use `/lens-format` to apply |
| **Ruff** | Lint + format for Python. Auto-fixes on every write by default |
| **Test Runner** | Runs corresponding test file when you edit source code (vitest, jest, pytest). Silent if no test file exists. |
| **Complexity Metrics** | AST-based analysis: Maintainability Index, Cyclomatic/Cognitive Complexity, Halstead Volume, nesting depth, function length, code entropy. |
| **jscpd** | Code duplication detection. Warns when editing a file that has duplicates with other files in the project. |
| **Duplicate Exports** | Detects when you redefine a function that already exists elsewhere in the codebase. |

### Actionable feedback

All warnings include actionable guidance — the agent sees what to do, not just what's wrong:

```
[TypeScript] 2 issue(s):
  [error] L10: Type 'string' is not assignable to type 'number'

[ast-grep] 1 structural issue(s) — 1 warning(s):
  no-console-log: console.log found (L15)
    → Use a proper logging framework or remove before committing.

[jscpd] 1 duplicate block(s) involving utils.ts:
  15 lines — helpers.ts:20
  → Extract duplicated code to a shared utility function

[Duplicate Exports] 1 function(s) already exist:
  formatDate (already in helpers.ts)
  → Import the existing function instead of redefining it

[Complexity Warnings]
  ⚠ Maintainability dropped to 55 — extract logic into helper functions
  ⚠ High entropy (4.2 bits) — follow project conventions

[Tests] ✗ 1/3 failed, 2 passed
  ✗ should format date
  → Fix failing tests before proceeding
```

### Pre-write hints

Before every write or edit to an existing file, the agent sees a summary of what's already broken:

```
⚠ Pre-write: file already has 5 TypeScript error(s) — fix before adding more
⚠ Pre-write: file already has 9 Biome issue(s)
⚠ Pre-write: file already has 8 structural violations
```

Prevents piling new errors on top of existing ones.

### Session start summary (injected into first tool result)

On every new session, the following scans run against the whole project and are delivered once into the first tool result:

| Tool | What it reports |
|---|---|
| **TODO scanner** | All TODO / FIXME / HACK / BUG / DEPRECATED annotations, sorted by severity |
| **Knip** | Unused exports, types, and unlisted dependencies |
| **jscpd** | Duplicate code blocks — file, line, size, percentage of codebase |
| **type-coverage** | Percentage of identifiers properly typed; lists exact locations of `any` |

Example:

```
[Session Start]
[TODOs] 3 annotation(s) found (2 FIXME, 1 TODO):
  🔴 src/auth.ts:42 — FIXME: token refresh not implemented
  🟠 src/parser.ts:17 — HACK: bypassing validation
  📝 src/api.ts:88 — TODO: add rate limiting

[Knip] 2 issue(s) — 2 unused export(s):
  Unused exports:
    - legacyFormat (utils.ts)
    - oldParser (parser.ts)

[jscpd] 2 duplicate block(s) — 1.2% of codebase (47/3920 lines):
  16 lines — openrouter.ts:183 ↔ openrouter.ts:135
  11 lines — cline-auth.ts:51 ↔ kilo-auth.ts:9

[type-coverage] ⚠ 94.3% typed (3870/4107 identifiers):
  auth.ts:138:44 — undefined as any
  config.ts:52:12 — err
  ... and 12 more
```

### On-demand commands

| Command | Description |
|---|---|
| `/lens-todos [path]` | Scan for TODO/FIXME/HACK annotations |
| `/lens-dead-code` | Find unused exports/files/dependencies (requires knip) |
| `/lens-deps` | Circular dependency scan (requires madge) |
| `/lens-format [file\|--all]` | Apply Biome formatting |
| `/lens-booboo [path]` | Full code review: design smells, complexity, AI slop, TODOs, dead code, duplicates, type coverage. Saves full report to `.pi-lens/reviews/` |
| `/lens-metrics [path]` | Measure complexity metrics for all files. Exports `report.md` with grades (A-F), summary stats, and top 10 worst files |

### On-demand tools

| Tool | Description |
|---|---|
| **`ast_grep_search`** | Search code patterns using AST-aware matching. Supports meta-variables: `$VAR` (single node), `$$$` (multiple). Example: `console.log($MSG)` |
| **`ast_grep_replace`** | Replace code patterns with AST-aware rewriting. Dry-run by default, use `apply=true` to apply changes. Example: `pattern='console.log($MSG)' rewrite='logger.info($MSG)'` |

Supported languages: c, cpp, csharp, css, dart, elixir, go, haskell, html, java, javascript, json, kotlin, lua, php, python, ruby, rust, scala, sql, swift, tsx, typescript, yaml

---

## Installation

```bash
# Core (required for JS/TS feedback)
npm install -D @biomejs/biome @ast-grep/cli

# Dead code + duplicate detection + type coverage (highly recommended)
npm install -D knip jscpd type-coverage

# Circular dependency detection
npm install -D madge

# Python support
pip install ruff
```

---

## Flags

| Flag | Default | Description |
|---|---|---|
| `--autofix-biome` | `false` | Auto-fix Biome lint/format issues on every write |
| `--autofix-ruff` | **`true`** | Auto-fix Ruff issues on every write |
| `--no-biome` | `false` | Disable Biome |
| `--no-ast-grep` | `false` | Disable ast-grep |
| `--no-ruff` | `false` | Disable Ruff |
| `--no-lsp` | `false` | Disable TypeScript LSP |
| `--no-madge` | `false` | Disable circular dependency checking |
| `--no-tests` | `false` | Disable test runner on write |
| `--no-go` | `false` | Disable Go linting |
| `--no-rust` | `false` | Disable Rust linting |
| `--lens-verbose` | `false` | Enable verbose logging |

---

## ast-grep rules

Rules live in `rules/ast-grep-rules/rules/`. All rules are YAML files you can edit or extend.

Each rule includes a `message` and `note` that are shown in diagnostics, so the agent understands why something violated a rule and how to fix it.

**Security**
`no-eval`, `no-implied-eval`, `no-hardcoded-secrets`, `no-insecure-randomness`, `no-open-redirect`, `no-sql-in-code`, `no-inner-html`, `no-dangerously-set-inner-html`, `no-javascript-url`

**TypeScript**
`no-any-type`, `no-as-any`, `no-non-null-assertion`

**Style**
`no-var`, `prefer-const`, `prefer-template`, `no-useless-concat`, `prefer-nullish-coalescing`, `prefer-optional-chain`, `nested-ternary`, `no-lonely-if`

**Correctness**
`no-debugger`, `no-throw-string`, `no-return-await`, `no-await-in-loop`, `no-await-in-promise-all`, `require-await`, `empty-catch`, `strict-equality`, `strict-inequality`

**Patterns**
`no-console-log`, `no-alert`, `no-delete-operator`, `no-shadow`, `no-star-imports`, `switch-needs-default`

**Design Smells**
`long-method`, `long-parameter-list`, `large-class`

---

## External dependencies summary

| Package | Install | Purpose |
|---|---|---|
| `@biomejs/biome` | `npm i -D @biomejs/biome` | JS/TS/CSS/JSON lint + format + autofix |
| `@ast-grep/cli` | `npm i -D @ast-grep/cli` | 60+ structural pattern rules |
| `knip` | `npm i -D knip` | Unused exports, types, unlisted deps |
| `jscpd` | `npm i -D jscpd` | Copy-paste / duplicate code detection |
| `type-coverage` | `npm i -D type-coverage` | TypeScript `any` coverage percentage |
| `madge` | `npm i -D madge` | Circular dependency detection |
| `ruff` | `pip install ruff` | Python lint + format + autofix |

---

## TypeScript LSP — tsconfig detection

The LSP walks up from the edited file's directory until it finds a `tsconfig.json`. If found, it uses that project's exact `compilerOptions` (paths, strict settings, lib, etc.). If not found, it falls back to sensible defaults:

- `target: ES2020`
- `lib: ["es2020", "dom", "dom.iterable"]`
- `moduleResolution: bundler`
- `strict: true`

The compiler options are refreshed automatically when you switch between projects within a session.
