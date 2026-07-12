---
name: pi-lens-ast-grep
description: Use when searching or replacing code patterns - use ast-grep instead of text search for semantic accuracy
---

# AST-Grep Code Search

Use `ast_grep_search` and `ast_grep_replace` for semantic code search/replace. ast-grep understands code structure, not just text.

These tools (plus `ast_grep_outline`, `ast_grep_dump`, `lsp_navigation`) are registered but inactive by default on hosts that support pi's dynamic tooling. If a call to one of them isn't recognized, activate it first: `pi_lens_activate_tools tools=["ast_grep_search", "ast_grep_replace"]`.

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

### Structural-intent parameters (preferred for cross-context queries)

Use these instead of writing raw YAML:

| Parameter | What it does |
|---|---|
| `insideKind` | Only match inside an ancestor of this node kind |
| `hasKind` | Only match nodes that contain a descendant of this kind |
| `follows` | Only match nodes preceded by a sibling matching this pattern |
| `precedes` | Only match nodes followed by a sibling matching this pattern |

```
# console.log only inside functions
ast_grep_search pattern="console.log($MSG)" lang="typescript" insideKind="function_declaration"

# replace var with let, scoped to functions only
ast_grep_replace pattern="var $X" rewrite="let $X" lang="javascript" insideKind="function_declaration"
```

These synthesize a YAML rule automatically. Use `rule:` for the full DSL when you need `all`/`any`/`not`, `nthChild`, `regex`, or other advanced constraints.

### Raw YAML rule (`rule:` parameter)

Pass a complete ast-grep YAML rule to unlock the full DSL:

```
ast_grep_search rule="id: my-rule
language: TypeScript
rule:
  pattern: console.log($MSG)
  inside:
    kind: function_declaration
    stopBy: end" lang="typescript"
```

### Debugging unknown node kinds — `ast_grep_dump`

When a pattern returns zero matches and you don't know the correct node kind or field name, use `ast_grep_dump` to inspect a SMALL representative snippet:

```
ast_grep_dump source="function foo() { return 1; }" lang="typescript"
```

Returns the full indented AST with node kinds and positions. Then use the correct kind in your pattern or `insideKind`. `ast_grep_dump` is registered but inactive by default — call `pi_lens_activate_tools` with `tools: ["ast_grep_dump"]` first if it isn't already active.

### Composite (has/inside) in raw YAML

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

❌ Multiple top-level statements — triggers "Multiple AST nodes are detected"
   Two shapes, two fixes:

   1. Sequence inside a block — wrap in braces:
      foo(); bar();  →  { foo(); bar(); }

   2. Cross-context (module-level + block-level together, e.g. an import AND a call) —
      wrapping in {} makes the pattern invalid (imports can't live inside a block).
      Use two searches: find files containing the import, then scope the call search
      to those paths. Or use a YAML `inside:`/`has:` rule (see Composite section above).
```

**No matches?**

1. Try `strictness: relaxed` — ignores unnamed punctuation (trailing commas, semicolons) that `smart` mode requires
2. Use `ast_grep_dump` on a sample snippet to verify the correct node kind
3. Simplify the pattern and retry once
4. Fall back to `grep` or `lsp_navigation`

## Agent task recipes

Use these as starting points, then scope `paths` tightly.

| Task | Pattern / params |
|---|---|
| Find pi lifecycle handlers | `pattern: pi.on($EVENT, $HANDLER)` |
| Find timers | `pattern: setTimeout($CALLBACK, $$$REST)` or `setInterval($CALLBACK, $$$REST)` |
| Find immediate/deferred work | `pattern: setImmediate($CALLBACK)` |
| Find promise callbacks | `pattern: $PROMISE.then($CALLBACK)` / `.catch($CALLBACK)` / `.finally($CALLBACK)` |
| Find object-literal function dependency by name | `pattern: { resetLSPService: $FN, $$$REST }` |
| Find fire-and-forget async calls | `pattern: void $CALL` |
| Find empty catches | `pattern: try { $$$BODY } catch ($ERR) { }` |

For lifecycle bugs, search first, then use the returned `details.matchLocations[].readSlice` handle for bounded context.

**Metavar captures** appear automatically below each match line:

```
src/foo.ts:1:1: const x = foo(a, b)
  $VAR=x  $$$ARGS=a,b
```

Named captures (`$X`, `$$$NAME`) are shown; unnamed wildcards (`$$$`) are not.

**Pagination** — use `skip: N` when results are truncated (next-page hint appears in output).

Debug: <https://ast-grep.github.io/playground.html>
