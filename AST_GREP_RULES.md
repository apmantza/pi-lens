# Creating ast-grep Rules for pi-lens

pi-lens uses ast-grep for structural code analysis. You can extend it with custom YAML rules.

## Quick Start

Create a rule file in your project:

```yaml
# .pi-lens/rules/no-eval.yml
id: no-eval
language: javascript
rule:
  pattern: eval($$$ARGS)
message: "eval() is dangerous - use safer alternatives"
severity: error
```

pi-lens will auto-discover rules in `.pi-lens/rules/`.

## Rule Structure

```yaml
id: unique-rule-name           # Required: unique identifier
language: typescript           # Required: typescript, javascript, python, go, rust
rule:                          # Required: the matching logic
  # ... see Rule Types below
message: "What to show user"   # Optional: diagnostic message
severity: warning              # Optional: error | warning | info | hint (default: warning)
```

## Rule Types

### 1. Simple Pattern

Match specific code patterns:

```yaml
rule:
  pattern: console.$METHOD($$$ARGS)
```

### 2. Kind + Relational

Match by AST node type with relationships:

```yaml
rule:
  kind: function_declaration
  has:
    pattern: await $EXPR
    stopBy: end  # Required: search entire function body
```

### 3. Inside Context

Match code inside specific contexts:

```yaml
rule:
  pattern: console.log($$$ARGS)
  inside:
    kind: method_definition  # Only match inside class methods
    stopBy: end
```

### 4. Composite (all/any/not)

Combine multiple conditions:

```yaml
# Match async functions WITHOUT try-catch
rule:
  all:
    - kind: function_declaration
    - has:
        pattern: await $EXPR
        stopBy: end
    - not:
        has:
          pattern: try { $$$ } catch ($E) { $$$ }
          stopBy: end
```

## pi-lens Specific Examples

### Detect Missing Error Handling

```yaml
# .pi-lens/rules/async-no-catch.yml
id: async-no-catch
language: typescript
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
message: "Async function lacks try-catch error handling"
severity: warning
```

### Detect Hardcoded Secrets Pattern

```yaml
# .pi-lens/rules/hardcoded-secret.yml
id: hardcoded-secret
language: typescript
rule:
  pattern: const $VAR = "api_key_$SUFFIX"
message: "Possible hardcoded secret - use environment variables"
severity: error
```

### Detect Console in Production Code

```yaml
# .pi-lens/rules/no-console-prod.yml
id: no-console-prod
language: javascript
rule:
  pattern: console.$METHOD($$$ARGS)
  not:
    inside:
      kind: call_expression  # Exclude console in tests
      has:
        pattern: describe($$$) or it($$$)
      stopBy: end
message: "Remove console statements before production"
severity: warning
```

### Python Type Hints Check

```yaml
# .pi-lens/rules/missing-type-hints.yml
id: missing-type-hints
language: python
rule:
  kind: function_definition
  not:
    has:
      field: return_type
      stopBy: end
message: "Function lacks return type hint"
severity: info
```

## Metavariables Reference

| Pattern | Matches |
|---------|---------|
| `$VAR` | Single AST node (identifier, literal, etc.) |
| `$$$VAR` | Multiple nodes (variadic) |
| `_` | Anonymous match (don't capture) |

Examples:
- `console.log($MSG)` - Match any single argument
- `console.log($$$ARGS)` - Match any number of arguments
- `function $NAME($$$PARAMS) { $$$BODY }` - Full function capture

## Testing Rules

### 1. Online Playground

Test patterns at: https://ast-grep.github.io/playground.html

Paste your code on the left, rule on the right, see matches instantly.

### 2. CLI Test

```bash
# Test rule file
ast-grep scan --rule .pi-lens/rules/my-rule.yml src/

# Test inline (quick iteration)
ast-grep scan --inline-rules "rule: {pattern: 'console.log(\$MSG)'}" --stdin

# Debug AST structure
ast-grep run --pattern 'async function ex() {}' --lang javascript --debug-query=cst
```

**Escape `$` in bash:** Use `\$` or single quotes `'pattern: "$MSG"'`

## Key Principles

1. **Always use `stopBy: end`** for `has`/`inside` rules
2. **Pattern must be valid code** - incomplete patterns fail
3. **Use metavariables** for whitespace-agnostic matching
4. **Test in playground first** before saving to file

## Resources

- [ast-grep Rule Reference](https://ast-grep.github.io/guide/rule-config.html)
- [Pattern Syntax Guide](https://ast-grep.github.io/guide/pattern-syntax.html)
- [Online Playground](https://ast-grep.github.io/playground.html)
