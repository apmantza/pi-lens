# pi-lens

Real-time code quality feedback for [pi](https://github.com/mariozechner/pi-coding-agent). Injects diagnostics directly into every tool result so the agent always knows the state of the code it just wrote.

---

## What it does

### On every write/edit
- **TypeScript LSP** — type errors, using the project's own `tsconfig.json` (walks up from the file to find it; falls back to sensible defaults with `dom` + `es2020` libs)
- **ast-grep** — 60+ structural rules: `no-var`, `no-eval`, `no-debugger`, `no-as-any`, `prefer-template`, `no-throw-string`, `no-hardcoded-secrets`, `no-return-await`, nested ternaries, and more
- **Biome** — lint + format check for JS/TS/JSX/TSX/CSS/JSON; auto-fixes on every write by default (`--autofix-biome`)
- **Ruff** — lint + format for Python; auto-fixes on every write by default (`--autofix-ruff`)
- **Pre-write hint** — before modifying a file that already has violations, the agent sees a warning at the top of the tool result so it doesn't pile errors on top of errors

### At session start (injected into first tool result)
- **TODO/FIXME/HACK/BUG scanner** — regex scan of the whole project, grouped by severity, so the agent knows what's already flagged as broken or incomplete
- **Knip** — unused exports, types, and unlisted dependencies
- **jscpd** — duplicate code blocks (copy-paste detection across the whole project)
- **type-coverage** — percentage of identifiers properly typed; lists exact locations of implicit/explicit `any`

### On-demand commands
| Command | Description |
|---|---|
| `/find-todos [path]` | Scan for TODO/FIXME/HACK annotations |
| `/dead-code` | Find unused exports/files/dependencies (requires knip) |
| `/check-deps` | Circular dependency scan (requires madge) |
| `/format [file\|--all]` | Apply Biome formatting |

---

## Installation

```bash
# Required
npm install -D @biomejs/biome @ast-grep/cli knip

# Optional
npm install -D madge          # circular dependency detection
pip install ruff              # Python linting
```

---

## Flags

| Flag | Default | Description |
|---|---|---|
| `--autofix-biome` | `true` | Auto-fix Biome lint/format issues on every write |
| `--autofix-ruff` | `true` | Auto-fix Ruff issues on every write |
| `--no-biome` | `false` | Disable Biome |
| `--no-ast-grep` | `false` | Disable ast-grep |
| `--no-ruff` | `false` | Disable Ruff |
| `--no-lsp` | `false` | Disable TypeScript LSP |
| `--lens-verbose` | `false` | Enable verbose logging |

---

## What the agent sees

**On first write of a session:**
```
[Session Start]
[TODOs] 3 annotation(s) found (2 FIXME, 1 TODO):
  🔴 src/auth.ts:42 — FIXME: token refresh not implemented
  ...

[Knip] 2 issue(s) — 2 unused export(s):
  Unused exports:
    - legacyFormat (utils.ts)
    - oldParser (parser.ts)
```

**On every subsequent write/edit:**
```
⚠ Pre-write: file already has 3 TypeScript error(s) — fix before adding more
⚠ Pre-write: file already has 5 structural violations

[TypeScript] 2 issue(s):
  [Error] L8: Type 'string' is not assignable to type 'number'.

[ast-grep] 4 structural issue(s) — 1 error(s) — 3 warning(s):
  [no-eval] L12 Avoid eval() — security risk
  [no-var] L17 Use 'const' or 'let' instead of 'var'
  ...

[Biome] Auto-fixed 2 issue(s) — file updated on disk
[Biome] ✓ All issues resolved
```

---

## ast-grep rules

Rules live in `rules/ast-grep-rules/rules/`. Categories:

- **Security** — `no-eval`, `no-implied-eval`, `no-hardcoded-secrets`, `no-insecure-randomness`, `no-open-redirect`, `no-sql-in-code`, `no-inner-html`, `no-dangerously-set-inner-html`, `no-javascript-url`
- **TypeScript** — `no-any-type`, `no-as-any`, `no-non-null-assertion`
- **Style** — `no-var`, `prefer-const`, `prefer-template`, `no-useless-concat`, `prefer-nullish-coalescing`, `prefer-optional-chain`, `nested-ternary`, `no-lonely-if`
- **Correctness** — `no-debugger`, `no-throw-string`, `no-return-await`, `no-await-in-loop`, `no-await-in-promise-all`, `require-await`, `empty-catch`, `strict-equality`, `strict-inequality`
- **Patterns** — `no-console-log`, `no-alert`, `no-delete-operator`, `no-shadow`, `no-star-imports`, `switch-needs-default`

---

## External dependencies summary

| Tool | Install | Used for |
|---|---|---|
| `@biomejs/biome` | `npm i -D @biomejs/biome` | JS/TS lint + format |
| `@ast-grep/cli` | `npm i -D @ast-grep/cli` | Structural rules |
| `knip` | `npm i -D knip` | Dead code detection |
| `madge` | `npm i -D madge` | Circular deps |
| `ruff` | `pip install ruff` | Python lint + format |
| `jscpd` | `npm i -D jscpd` | Duplicate code detection |
| `type-coverage` | `npm i -D type-coverage` | TypeScript type coverage |
