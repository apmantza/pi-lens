---
name: pi-lens-write-tree-sitter-rule
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

## Hard-won gotchas (verified, not theoretical)

```
❌ `_` matches NAMED nodes only — never anonymous tokens (operators, punctuation)
   To match/capture an operator, use the literal token string:
     (binary_expression operator: _ @OP)        ← captures NOTHING for `==`
     (binary_expression ["==" "!="] @OP)         ← correct (anonymous tokens)
   Anonymous-token alternation `["==" "!="]` works as a CHILD; as a FIELD value
   it may not compile under the WASM grammar — prefer the child form.

❌ The bundled WASM grammar ≠ the playground / @ast-grep/napi grammar (version skew)
   Real example: WASM tree-sitter-typescript wraps the for-loop condition in an
   `expression_statement` and exposes NO `condition:` field:
     (for_statement condition: (binary_expression ...))   ← 0 matches (no such field)
     (for_statement (expression_statement (binary_expression ...)))  ← correct
   Always verify field names / nesting against the WASM grammar, not the playground.

❌ A query that fails to compile returns 0 matches SILENTLY (no error thrown).
   So "0 matches" can mean "wrong query", not "nothing to find".
   → Probe incrementally: start `(target_kind) @X`, confirm >0, then add one
     layer (field, child, predicate) at a time until it narrows correctly.

✅ Verify with the production path, not just the playground:
     client.runQueryOnFile(queryDef, filePath, "typescript")
   (TreeSitterClient compiles via the same WASM the runner uses.)

✅ JS files also run typescript/ rules (shared grammar) — one rule in
   rules/tree-sitter-queries/typescript/ covers BOTH .ts and .js. No -js copy needed.

✅ Match a header-field child precisely without a field name by relying on direct
   children: for_statement's children are lexical_declaration (init),
   expression_statement (condition), update_expression (increment), statement_block
   (body) — so a binary_expression nested in the condition's expression_statement is
   unambiguous, and the body's nodes are inside statement_block (not matched).
```
