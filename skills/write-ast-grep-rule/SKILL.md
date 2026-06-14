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

## Relational & constraint conditions — all supported (native napi, #206)

The runner matches every rule through napi's native engine (`root.findAll({rule,
constraints})`), fed by a faithful `js-yaml` parse. The **full ast-grep grammar works** —
nest freely; nothing is silently skipped:

```yaml
rule:
  kind: call_expression
  inside:                     # ancestor must match
    kind: function_declaration
    stopBy: end               # ↑ search ALL ancestors (default is direct parent)
  has:                        # descendant must match (default: DIRECT child)
    field: arguments          # field constraints work
  follows:                    # immediately-preceding sibling
    pattern: const $X = $V
constraints:                  # metavariable regex constraints work
  X:
    regex: "Error$"
```

⚠ **`has`/`inside` default to the immediate child/parent (`stopBy: neighbor`).** For a
recursive descendant/ancestor search add `stopBy: end`. This is the #1 migration
gotcha — see the `has` note below.

## YAML quoting — REQUIRED (js-yaml will reject the rule otherwise)

The parser is a real YAML parser, so unquoted special chars throw and the rule is
**silently dropped**:

```
❌ message: !!value to coerce boolean    # `!!` is a YAML tag → js-yaml THROWS, rule dropped
✅ message: "!!value to coerce boolean"
❌ message: foo: bar baz                  # bare `:` → parsed as a nested mapping
✅ message: "foo: bar baz"
   Quote any scalar starting with  ! & * ? | > % @ `  or containing  : #
   Quote keyword-like kinds:  kind: "true"   (bare `true` becomes a boolean → invalid kind)
```

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
⚠ `has`/`inside` default to DIRECT child/parent — add `stopBy: end` for a recursive search.
   This cuts BOTH ways, so think about where the target node actually lives:
   - Target is a grandchild+ → you MUST add `stopBy: end` or the `has` never matches.
     `switch-without-default` = `switch_statement` not has `switch_default`: the default
     lives under `switch_body`, so without `stopBy: end` it matches nothing and every
     switch (even ones WITH a default) is flagged. Same for `nested-ternary` catching a
     parenthesized `a ? (b ? c : d) : e`.
   - Target is the direct child → leave it at `neighbor` (default). Adding `stopBy: end`
     OVER-reports: `throw_statement` has `string` + `stopBy: end` flags `throw new
     Error("x")` (the string is nested), and `expression_statement` has `new_expression`
     + `stopBy: end` flags `fn(new Error())` as a discarded error. Keep these direct.
   napi's `has` never matches the node itself, so a self-referential `kind: X` has
   `kind: X` (with `stopBy: end`) correctly flags only genuinely-nested X.

✅ Prefer `regex` on the matched node's OWN text over `has` when you only need to
   inspect the node — avoids recursive-descendant false positives:
     kind: export_statement
     regex: '^export\s+(let|var)\b'      # precise; no has-recursion FP
   (NAPI evaluates `regex` with JS RegExp on node.text() — keep it LINEAR so the
   detector can't itself ReDoS.)

✅ One `language: TypeScript` rule runs on .ts/.tsx/.js/.jsx in the runner (no per-file
   language gate). Do NOT ship a `-js` twin: both fire on the same node (dedup is by rule
   id, not finding) → duplicate diagnostics. Several shipped pairs (`prefer-at` +
   `prefer-at-js`, `strict-equality` + `-js`, …) still double-report — consolidate them.

✅ Node-kind facts (tree-sitter-typescript grammar — NOT the TS compiler / Roslyn):
   - let / const  → `lexical_declaration`     (var is NOT here)
   - var          → `variable_declaration`
   - a regex literal's pattern text  → `regex_pattern`
   - x[i] index access  → `subscript_expression`   (NOT element_access_expression)
   - obj.prop access    → `member_expression`      (NOT property_access_expression)
   - !x / -x / typeof x → `unary_expression`
   - a ? b : c          → `ternary_expression`

❌ Wrong-grammar kind names = silent dead rule. `element_access_expression`,
   `property_access_expression`, `binary_operator`, etc. are TS-compiler/Roslyn names, not
   tree-sitter's. napi REJECTS the whole rule ("invalid kind matcher") so it never runs.
   Verify a kind exists before shipping:
     node -e 'import("@ast-grep/napi").then(s=>{const r=s.ts.parse("x[i]").root();
       const f=(n,k)=>{let c=n.kind()===k?1:0;for(const x of n.children())c+=f(x,k);return c};
       console.log(f(r,"subscript_expression"))})'   # >0 means the kind is real

✅ Test through the REAL runner from the repo root — it loads the actual shipped
   rules from rules/ast-grep-rules/rules. Assert on diagnostic `rule` ids:
     const res = await runner.run(ctx);  // ctx.filePath = temp .ts, cwd = repo
   For pattern/kind/regex-only rules (CLI-identical semantics) `ast-grep scan` is fine.

✅ Before shipping any text/regex detector, FP-scan the codebase:
     ast-grep scan -r <rule>.yml clients tools
   Real safe variants bite (e.g. ReDoS: (ba+)+ is safe — a mandatory prefix makes
   the partition unique; flag only a single quantified atom inside the group).
```
