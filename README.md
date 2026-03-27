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
| **jscpd** | Code duplication detection. Warns when editing a file that has duplicates with other files in the project. |
| **Duplicate Exports** | Detects when you redefine a function that already exists elsewhere in the codebase. |

### Delta-mode feedback

ast-grep and Biome run in **delta mode** — only violations *introduced by the current edit* are shown. Pre-existing issues are silent. Fixed violations are acknowledged. Skipped rules (`long-method`, `large-class`, etc.) are suppressed — they're architectural and handled by `/lens-booboo-refactor`.

```
🔴 Fix 2 TypeScript error(s) — these must be resolved:
  L10: Type 'string' is not assignable to type 'number'

🔴 STOP — you introduced 1 new structural violation(s). Fix before continuing:
  no-var: Use 'const' or 'let' instead of 'var' (L23)
    → var has function scope and can lead to unexpected hoisting behavior.
  → Auto-fixable: check the hints above

✅ ast-grep: fixed no-console-log (-1)

🔴 STOP — you introduced 1 new Biome violation(s). Fix before continuing:
  L23:5 [style/useConst] This let declares a variable that is only assigned once.
  → Auto-fixable: `npx @biomejs/biome check --write utils.ts`

🔴 STOP — this file has 1 duplicate block(s). Extract to a shared utility before adding more code:
  15 lines duplicated with helpers.ts:20

🔴 Do not redefine — 1 function(s) already exist elsewhere:
  formatDate (already in helpers.ts)
  → Import the existing function instead

[Tests] ✗ 1/3 failed, 2 passed
  ✗ should format date
  → Fix failing tests before proceeding
```

### Pre-write hints

Before every write or edit, the agent is warned about blocking TypeScript errors already in the file:

```
⚠ Pre-write: file already has 5 TypeScript error(s) — fix before adding more
```

### Session start (silent caching)

On every new session, scans run silently in the background. Data is cached for real-time feedback during the session and surfaced on-demand via explicit commands:

| Scanner | Cached for |
|---|---|
| **TODO scanner** | `/lens-booboo` reports |
| **Knip** | Dead code detection in `/lens-booboo` and `/lens-booboo-fix` |
| **jscpd** | Duplicate detection on write; `/lens-booboo` reports |
| **type-coverage** | `/lens-booboo` reports |
| **Complexity baselines** | Regressed/improved delta tracking via `/lens-metrics` |

### On-demand commands

| Command | Description |
|---|---|
| `/lens-booboo [path]` | Full code review: TODOs, dead code, duplicates, type coverage, circular dependencies. Saves full report to `.pi-lens/reviews/` |
| `/lens-booboo-fix [path]` | Iterative automated fix loop. Runs Biome/Ruff autofix, then scans for fixable issues (ast-grep agent rules, dead code). Generates a fix plan for the agent to execute. Re-run for up to 3 iterations, then reset. |
| `/lens-booboo-refactor [path]` | Interactive architectural refactor. Scans for worst offender by combined debt score (ast-grep skip rules + complexity metrics). Opens a browser interview with impact metrics — agent proposes refactoring options with rationale, user picks one, agent implements and shows a post-change report. |
| `/lens-format [file\|--all]` | Apply Biome formatting |
| `/lens-metrics [path]` | Measure complexity metrics for all files. Exports `report.md` with grades (A-F), summary stats, top 10 worst files, and **historical trends** (📈📉 per file) |

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

## Fix loop commands

### `/lens-booboo-fix` — automated mechanical fixes

Iterative loop that auto-fixes what it can, then generates a fix plan for the agent. Scan order:

1. **Biome + Ruff** — auto-fix lint/format issues silently
2. **jscpd** — within-file duplicate blocks (extract to shared utilities)
3. **Knip** — dead code (delete unused exports/files)
4. **ast-grep** — structural violations on surviving code (agent fixes)
5. **AI slop** — files with 2+ complexity signals
6. **Remaining Biome** — issues that couldn't be auto-fixed even with `--unsafe`

Run up to 3 iterations per session. Session auto-resets after hitting max — just run again.

```
📋 BOOBOO FIX PLAN — Iteration 1/3 (44 fixable items remaining)
✅ Fixed 249 issues since last iteration.

⚡ Auto-fixed: Biome --write --unsafe, Ruff --fix + format already ran.

## 🔨 Fix these [12 items]

### no-console-log (14)
→ Remove or replace with class logger method
  - `clients/ruff-client.ts:47`
  - `clients/biome-client.ts:48`
  ...

## ⏭️ Skip [109 items — architectural]
  - **long-method** (79): Extraction requires understanding the function's purpose.
  - **large-class** (16): Splitting a class requires architectural decisions.
```

### `/lens-booboo-refactor` — interactive architectural refactoring

Surfaces the worst offender in the codebase by combined debt score (ast-grep skip rules + complexity metrics). The agent analyzes the code, generates refactoring options with impact estimates, and presents them in a browser interview.

**Two-step flow:**
1. **Option selection** — browser opens with numbered radio cards, each showing rationale + impact metrics (`linesReduced`, `miProjection`, `cognitiveProjection`). One option is recommended.
2. **Post-change report** — after implementing, agent shows what changed (git diff + line counts) and how metrics evolved. User can say "looks good" or request changes via chat.

```
🏗️ BOOBOO REFACTOR — worst offender identified

File: index.ts (debt score: 35)
Complexity: MI: 2.7, Cognitive: 1590, Nesting: 10

Violations:
  - long-method (×18)
  - long-parameter-list (×6)
```

The agent then calls the built-in `interviewer` tool, which opens a browser form with the generated options. Zero dependencies — Node's built-in `http` module + platform CLI (`start`/`open`/`xdg-open`).

---

## ast-grep rules

Rules live in `rules/ast-grep-rules/rules/`. All rules are YAML files you can edit or extend.

Each rule includes a `message` and `note` that are shown in diagnostics, so the agent understands why something violated a rule and how to fix it.

**Security**
`no-eval`, `no-implied-eval`, `no-hardcoded-secrets`, `no-insecure-randomness`, `no-open-redirect`, `no-sql-in-code`, `no-inner-html`, `no-dangerously-set-inner-html`, `no-javascript-url`

**TypeScript**
`no-any-type`, `no-as-any`, `no-non-null-assertion`

**Style** (Biome handles `no-var`, `prefer-const`, `prefer-template`, `no-useless-concat` natively)
`prefer-nullish-coalescing`, `prefer-optional-chain`, `nested-ternary`, `no-lonely-if`

**Correctness**
`no-debugger`, `no-throw-string`, `no-return-await`, `no-await-in-loop`, `no-await-in-promise-all`, `require-await`, `empty-catch`, `strict-equality`, `strict-inequality`

**Patterns**
`no-console-log`, `no-alert`, `no-delete-operator`, `no-shadow`, `no-star-imports`, `switch-needs-default`, `switch-without-default`

**Type Safety** (type-aware checks via `type-safety-client.ts`)
`switch-exhaustiveness` — detects missing cases in union type switches (inline blocker)

**Design Smells**
`long-method`, `long-parameter-list`, `large-class`

**AI Slop Detection**
`no-param-reassign`, `no-single-char-var`, `no-process-env`, `no-architecture-violation`

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
