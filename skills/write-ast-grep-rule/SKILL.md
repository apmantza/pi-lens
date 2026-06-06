---
name: write-ast-grep-rule
description: Use when writing a new pi-lens ast-grep rule YAML file — covers schema, drop path, gotchas, and NAPI runner constraints
---

# Writing a pi-lens ast-grep Rule

Drop path: `rules/ast-grep-rules/rules/<id>.yml`  
Same `id` as a built-in overrides it. Multiple rules per file: separate with `---`.

## Minimal template

```yaml
id: no-foo-bar
language: TypeScript        # PascalCase — see languages below
severity: warning           # error | warning | info
message: "Avoid foo.bar() — use baz() instead"
note: |
  Longer explanation / fix guidance here.
rule:
  pattern: foo.bar($ARG)
```

## Language values

`TypeScript` `JavaScript` `Python` `Go` `Rust` `Java` `C` `Cpp` `CSharp` `Kotlin` `Ruby` `Php`

## Rule conditions

```yaml
rule:
  pattern: foo($X)          # ast-grep pattern — $X single, $$$ARGS multi
  kind: call_expression     # AST node kind (alternative to pattern)
  regex: "secret|token"     # regex on node text
  has:                      # descendant must match
    pattern: await $$$
  not:
    kind: comment
  any:
    - pattern: foo($X)
    - pattern: bar($X)
  all:
    - pattern: $OBJ.send($$$)
    - not: { kind: await_expression }
```

## NAPI runner limits — rules using these are silently skipped

`inside` `follows` `precedes` `stopBy` `field` `nthChild` `constraints`

Use tree-sitter rules instead when you need relational context (inside function, follows import).

## Gotchas

```
❌ Overly broad patterns — filtered out automatically
   $VAR  $NAME  $_  $X  $EXPR  (single bare metavar)

❌ PascalCase language is required
   language: typescript  →  language: TypeScript

❌ $VAR inside strings — matches literal "$VAR", not a metavar
   "from $PATH"  →  use tree-sitter or grep instead

✅ Test in playground: https://ast-grep.github.io/playground.html
✅ Schema + autocomplete: rules/ast-grep-rules/rule-schema.json
✅ Docs: docs/custom-rules.md
```

## Hard-won gotchas (NAPI runner specifics — verified)

```
⚠ The NAPI runner's `has`/`not` semantics DIFFER from the `ast-grep` CLI:
   - NAPI runner (production): `has` searches ALL descendants (recursive).
   - CLI (`ast-grep scan`): `has` is IMMEDIATE children only, unless `stopBy: end`.
   So `kind: switch_statement` + `not: {has: {kind: switch_default}}` works in the
   runner but UNDER-reports via the CLI. To reproduce in the CLI add `stopBy: end`
   — but NEVER ship `stopBy` (the runner SKIPS rules that use it; see limits above).

✅ Prefer `regex` on the matched node's OWN text over `has` when you only need to
   inspect the node — avoids recursive-descendant false positives:
     kind: export_statement
     regex: '^export\s+(let|var)\b'      # precise; no has-recursion FP
   (NAPI evaluates `regex` with JS RegExp on node.text() — keep it LINEAR so the
   detector can't itself ReDoS.)

✅ One `language: TypeScript` rule runs on .ts/.tsx/.js/.jsx in the NAPI runner
   (no per-file language gate). A `-js` twin DOUBLE-FIRES (the dedup key includes
   the rule id). Add a `-js` variant ONLY if you need the CLI/.sgconfig path, which
   DOES gate strictly by language.

✅ Node-kind facts:
   - let / const  → `lexical_declaration`     (var is NOT here)
   - var          → `variable_declaration`
   - a regex literal's pattern text  → `regex_pattern`

✅ Test through the REAL runner from the repo root — it loads the actual shipped
   rules from rules/ast-grep-rules/rules. Assert on diagnostic `rule` ids:
     const res = await runner.run(ctx);  // ctx.filePath = temp .ts, cwd = repo
   For pattern/kind/regex-only rules (CLI-identical semantics) `ast-grep scan` is fine.

✅ Before shipping any text/regex detector, FP-scan the codebase:
     ast-grep scan -r <rule>.yml clients tools
   Real safe variants bite (e.g. ReDoS: (ba+)+ is safe — a mandatory prefix makes
   the partition unique; flag only a single quantified atom inside the group).
```
