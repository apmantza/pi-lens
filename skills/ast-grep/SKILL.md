---
name: ast-grep
description: Use when searching or replacing code patterns - use ast-grep instead of text search for semantic accuracy
---

# AST-Grep Code Search

Use `ast_grep_search` and `ast_grep_replace` for semantic code search/replace. ast-grep understands code structure, not just text.

## When to Use

- Function calls, imports, class methods (structured code)
- Safe replacements across files
- **Use LSP first for:** definitions/references/types — then scope ast-grep to files discovered by LSP
- **Use grep for:** partial string patterns, comments, URLs, or after one simplified ast-grep retry still returns zero matches

## Golden Rules

1. **Be specific** — `fetchMetrics($ARGS)` not `fetchMetrics`
2. **Scope it** — always specify `paths` to relevant files
3. **Retry once on zero matches** — simplify the pattern, same `paths`, then fall back to grep
4. **Dry-run first** — `apply: false` before `apply: true`
5. **Valid code only** — `function $NAME($$$) { $$$ }` not `function $NAME(`
6. **Avoid `selector` unless expert** — narrows to AST node kind; does not extract metavariables
7. **Metavariables don't work inside strings** — `from "$PATH"` matches literal `"$PATH"`, not a wildcard

## Metavariables

| Syntax | Matches | Named? |
|---|---|---|
| `$X` | single node | yes — captures the node |
| `$$$` | zero or more nodes | no — unnamed wildcard |
| `$$$ARGS` | zero or more nodes | yes — captures the list |

Use `$$$` when you don't need the captured value; `$$$NAME` when you do.

## Quick Reference

### Patterns

| Pattern | Matches |
|---|---|
| `fetchMetrics($ARGS)` | call with any single arg |
| `fetchMetrics($$$ARGS)` | call with any number of args |
| `function $NAME($$$) { $$$ }` | function declaration |
| `import { $NAMES } from $PATH` | named import (no quotes on path) |
| `const $X = $Y` | variable declaration |

### Composite (has/inside)

```yaml
# console.log inside a class method
pattern: console.log($$$)
inside:
  kind: method_definition
  stopBy: end
```

Use `kind:` directly when you want to match a node type without a pattern:
```yaml
# any arrow function
kind: arrow_function
```

## Common Gotchas

```
❌ $VAR inside quotes — matches literal "$VAR", not a metavar
   from "$PATH"  →  use grep for wildcard path matching
   from "./utils"  →  ✅ exact string literal works fine

❌ Trailing comma in objects
   { type: $T, }  →  use { type: $T }

❌ Shorthand property mismatch
   { runnerId: $RID }  →  won't match { runnerId }
   use { runnerId } or { runnerId, $$$REST }

❌ Unnamed $$$ when you need the value
   foo($$$)  →  captures nothing; use foo($$$ARGS) to inspect matches
```

**No matches?** Simplify and retry once. Still nothing? Fall back to `grep` or `lsp_navigation`.

Debug: https://ast-grep.github.io/playground.html
