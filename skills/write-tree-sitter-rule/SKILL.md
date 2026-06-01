---
name: write-tree-sitter-rule
description: Use when writing a new pi-lens tree-sitter query rule YAML file — covers schema, S-expression syntax, capture names, predicates, and gotchas
---

# Writing a pi-lens tree-sitter Rule

Drop path: `rules/tree-sitter-queries/<language>/<id>.yml`  
Language dir is **lowercase**: `typescript` `javascript` `tsx` `python` `go` `rust` `java` `csharp` `kotlin` `ruby` `cpp` `c` `css`

Project rules merge with built-ins (both run). To disable a language's built-ins: rename dir to `<lang>-disabled/`.

## Minimal template

```yaml
id: no-eval
severity: error
inline_tier: blocking       # blocking | warning | review
language: typescript        # lowercase, inferred from dir if omitted
message: "eval() is dangerous — use a safer alternative"
query: |
  (call_expression
    function: (identifier) @FN
    (#eq? @FN "eval"))
metavars: [FN]
has_fix: false
```

## S-expression query syntax

```scheme
; Node with field
(call_expression
  function: (identifier) @NAME
  arguments: (arguments) @ARGS)

; Alternatives — ALL branches must use the SAME capture names
[
  (function_declaration name: (identifier) @FN)
  (arrow_function) @FN
]

; Predicates (inline)
(#eq? @NAME "fetch")        ; exact match
(#match? @NAME "^on[A-Z]")  ; regex match
```

## Predicates via YAML (faster — runs in WASM)

```yaml
predicates:
  - type: eq       # eq | match | any-of
    var: "@FN"
    value: "dangerousMethod"
  - type: match
    var: "@NAME"
    value: "^(get|set)[A-Z]"
```

## inline_tier

| Value | Effect |
|---|---|
| `blocking` | Blocks agent turn — 🔴 injected immediately |
| `warning` | Advisory only |
| `review` | Low-priority suggestion |

## Gotchas

```
❌ Mixed capture names in [...] alternatives — zero matches, no error
   [ (fn_decl name: (id) @NAME) (method body: (block) @BODY) ]
   → split into two separate [...] blocks

❌ Field value as alternative
   right: [(identifier) (call_expression)]   ← INVALID
   → use separate query blocks instead

❌ @lowercase captures — convention is @UPPER_SNAKE
   @fn  →  @FN

✅ Find node kinds: use --debug-query CST in ast-grep playground
   or https://tree-sitter.github.io/tree-sitter/playground
✅ Schema + autocomplete: rules/tree-sitter-queries/rule-schema.json
✅ Docs: docs/custom-rules.md
```
