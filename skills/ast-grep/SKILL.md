---
name: ast-grep
description: Use when searching or replacing code patterns - use ast-grep instead of text search for semantic accuracy
---

# AST-Grep Code Search

Use `ast_grep_search` and `ast_grep_replace` for semantic code search/replace. ast-grep understands code structure, not just text.

## When to Use

- Finding function calls, imports, class methods (structured code)
- Replacing patterns safely across files
- Finding "X inside Y" (e.g., console.log inside classes)
- **Use grep instead for:** comments/strings, URLs, or when ast-grep fails twice

## Golden Rules

1. **Be specific** - Use `fetchMetrics($ARGS)` not `fetchMetrics`
2. **Scope it** - Always specify `paths` to relevant files
3. **Dry-run first** - Always use `apply: false` (or `ast_grep_search`) before `apply: true`
4. **Pattern must be valid code** - `function $NAME(` ❌, `function $NAME($$$PARAMS) { $$$BODY }` ✅
5. **Use metavariables** - `$VAR` for single node, `$$$` for multiple; handles whitespace automatically

## Quick Reference

### TypeScript/JavaScript

```typescript
// Function call
fetchMetrics($ARGS)

// Function definition
function $NAME($$$PARAMS) { $$$BODY }

// Import
import { $NAMES } from "$PATH"

// Nested pattern (async function with await)
all:
  - kind: function_declaration
  - has:
      pattern: await $EXPR
      stopBy: end

// Inside relationship
pattern: console.log($$$)
inside:
  kind: method_definition
  stopBy: end
```

### Python

```python
# Function
def $FUNC($$$ARGS):
    $$$BODY

# Class
class $CLASS($$$BASE):
    $$$BODY
```

## Testing Tips

**Workflow: Search → Dry-run → Apply**

```typescript
// Step 1: Verify pattern matches what you expect
ast_grep_search
  pattern: "console.log($MSG)"
  lang: typescript
  paths: ["src/"]
// → Check the matches are correct

// Step 2: Then do dry-run replace
ast_grep_replace
  pattern: "console.log($MSG)"
  rewrite: "logger.debug($MSG)"
  lang: typescript
  paths: ["src/"]
  apply: false

// Step 3: Finally apply
// apply: true
```

**Metavariable selection guide:**
| Use | Pattern | Matches |
|-----|---------|---------|
| Single arg | `console.log($MSG)` | `console.log("hi")` |
| Multiple args | `console.log($$$ARGS)` | `console.log("hi", obj, 42)` |
| Single node | `const $X = $Y` | `const x = 1` |
| Many nodes | `const $X = $$$REST` | `const x = 1 + 2 + 3` |

**Indentation doesn't matter:** ast-grep normalizes whitespace, so tabs vs spaces work the same.

## Examples

```typescript
// Step 1: Dry-run (preview changes)
ast_grep_replace
  pattern: "fetchMetrics($ARGS)"
  rewrite: "collectMetrics($ARGS)"
  lang: typescript
  paths: ["src/"]
  apply: false

// Step 2: Apply if preview looks correct
// apply: true

// Find all usages
ast_grep_search
  pattern: "fetchMetrics($ARGS)"
  lang: typescript
  paths: ["src/"]
```

## Common Failures

```typescript
// ❌ INVALID: Multiple AST nodes (missing parentheses)
pattern: "it\"test name\""
// ✅ VALID: Single AST node with metavariable
pattern: "it($TEST)"

// ❌ INVALID: Incomplete code
pattern: "function $NAME("
// ✅ VALID: Complete code
pattern: "function $NAME($$$PARAMS) { $$$BODY }"

// ❌ Won't match spaced variants
pattern: "const x=1"
// ✅ Matches any whitespace
pattern: "const $NAME = $VALUE"

// ❌ Regex syntax
pattern: "console.log(.*)"
// ✅ Metavariables
pattern: "console.log($$$ARGS)"
```

**Error: "Multiple AST nodes detected"** → Your pattern has multiple code fragments. Use metavariables like `$TEST` instead of literal text in quotes.

## Object Literal Patterns

Matching objects has two specific gotchas:

**1. Trailing commas cause Exit code 1 / no matches**
```typescript
// ❌ Trailing comma breaks the pattern
pattern: "logLatency({ type: $T, status: $S, })"
//                                           ^
// ✅ No trailing comma
pattern: "logLatency({ type: $T, status: $S })"
```

**2. ES6 shorthand properties must stay shorthand — can't use `key: $VAR`**
```typescript
// ❌ Won't match { runnerId } (shorthand property)
pattern: "logLatency({ runnerId: $RID })"

// ✅ Match shorthand as shorthand
pattern: "logLatency({ runnerId })"

// ✅ Or use $$$ARGS to skip the specific property
pattern: "logLatency({ runnerId, $$$REST })"
```

**3. Start wide, then narrow — especially for object calls**

When matching a function call with a complex object argument, don't start
with the full object shape. You'll likely get no matches due to property
ordering or shorthand issues. Instead:

```typescript
// Step 1: confirm the call exists at all
ast_grep_search({ pattern: "logLatency($$$ARGS)", ... })
// → see all calls, pick which properties uniquely identify your target

// Step 2: add ONE distinguishing literal property
ast_grep_search({ pattern: "logLatency({ type: \"runner\", $$$REST })", ... })
// → narrows to just runner calls

// Step 3: add more properties to hit the exact subset you want
ast_grep_search({ pattern: "logLatency({ type: \"runner\", filePath: $FP, runnerId, durationMs: 0, status: $S, diagnosticCount: $C, semantic: $SEM })", ... })
// → exactly the two not_registered / when_skipped calls
```

This progressive approach — wide → narrow — avoids wasted attempts.

**No matches found?** → Simplify on 2nd try:

```typescript
// 1st try: Be specific
ast_grep_search({ pattern: "console.log($$$ARGS)", ... })
// → No matches? (could be console.error, console.warn, etc.)

// 2nd try: Simplify to base identifier
ast_grep_search({ pattern: "console", ... })
// → Catches ALL console.* usage, then narrow down
```

**Debug steps:**
1. Use `ast_grep_search` with same pattern to preview matches
2. **2nd try: Simplify pattern** — remove constraints, test base match
3. Check metavariables capture what you expect
4. Ensure quotes/parentheses balance in pattern
5. **No trailing commas** in object patterns
6. **Shorthand properties** (`{ key }`) must stay shorthand in pattern — don't use `key: $VAR`

**Fallback:** If pattern fails twice → `grep -rn "pattern" src/`

**Debug:** https://ast-grep.github.io/playground.html

## CLI Tips

```bash
# Test inline rule
ast-grep scan --inline-rules "rule: {pattern: 'await \$EXPR'}" --stdin

# Debug AST (find correct 'kind' values)
ast-grep run --pattern 'async function ex() {}' --lang javascript --debug-query=cst

# Composite: async without try-catch
ast-grep scan --inline-rules 'rule: {all: [{kind: function_declaration, has: {pattern: await $EXPR, stopBy: end}}, {not: {has: {pattern: try { $$$ } catch, stopBy: end}}}]}' .
```

**Escape `$` in bash:** `\$` or single quotes `'pattern: "$ARG"'`

**Key principle:** For `inside`/`has` rules, always add `stopBy: end`

## Creating YAML Rules

For reusable rules, create `.yml` files:

```yaml
# rules/no-console-in-src.yml
id: no-console-in-src
language: javascript
rule:
  pattern: console.$METHOD($$$ARGS)
  inside:
    kind: class_declaration
    stopBy: end
message: "Avoid console in classes"
severity: warning
```

Run: `ast-grep scan --rule rules/no-console-in-src.yml src/`

### Rule Structure

| Field | Purpose |
|-------|---------|
| `id` | Unique rule name |
| `language` | typescript, javascript, python, etc. |
| `rule` | Pattern or composite logic |
| `message` | Diagnostic message |
| `severity` | error, warning, info, hint |

### Rule Types

```yaml
# Simple pattern
rule:
  pattern: eval($$$ARGS)

# Match by AST node kind
rule:
  kind: function_declaration
  has:
    pattern: await $EXPR
    stopBy: end

# Composite (all/any/not)
rule:
  all:
    - kind: function_declaration
    - has:
        pattern: await $EXPR
        stopBy: end
    - not:
        has:
          pattern: try { $$$ } catch
          stopBy: end
```

**Tip:** Test rules in playground before saving to file.
