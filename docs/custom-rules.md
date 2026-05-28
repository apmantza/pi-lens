# Custom Rules

pi-lens picks up project-local rules automatically alongside its built-ins.
Drop YAML files in the right directory and they are active on the next file dispatch — no config required.

## Quick start

```
your-project/
  rules/
    tree-sitter-queries/
      typescript/
        my-rule.yml        ← tree-sitter rule, loaded alongside built-ins
    ast-grep-rules/
      rules/
        my-rule.yml        ← ast-grep rule, overrides built-in with same id
```

Both loaders cache by directory mtime, so edits take effect within one tool call.

---

## Tree-sitter queries

### Drop path

```
<project-root>/rules/tree-sitter-queries/<language>/<rule-id>.yml
```

Valid `<language>` directory names: `typescript` `javascript` `tsx` `python` `go` `rust` `java` `csharp` `kotlin` `ruby` `cpp` `c` `css` `php` `plsql` `abap` `cobol`

Project rules and built-in rules are **merged** — both run on every matching file.

### Disabling a built-in

Rename the language directory with a `-disabled` suffix to exclude all rules in it from dispatch (they still load for tests):

```
rules/tree-sitter-queries/typescript-disabled/
```

There is currently no per-rule disable mechanism; if you need to suppress one built-in rule, copy the directory, remove the file, and rename appropriately.

### YAML schema

See [`rules/tree-sitter-queries/rule-schema.json`](../rules/tree-sitter-queries/rule-schema.json) for a machine-readable schema (works with the VS Code YAML extension).

| Field | Required | Type | Notes |
|---|---|---|---|
| `id` | ✅ | string | Unique across all rules for this language |
| `query` | ✅ | string (block `\|`) | Tree-sitter S-expression; capture names use `@UPPER_SNAKE` |
| `name` | — | string | Human-readable; defaults to `id` |
| `severity` | — | `error` \| `warning` \| `info` | Defaults to `warning` |
| `category` | — | string | Defaults to `"general"` |
| `language` | — | string | Inferred from directory name; override only if the file lives in a shared dir |
| `message` | — | string | Shown inline; defaults to `"Pattern: <id>"` |
| `description` | — | string (block `\|`) | Extended explanation shown in the detail view |
| `metavars` | — | string[] | Capture names to surface as evidence; auto-extracted from `@VAR` patterns if omitted |
| `predicates` | — | Predicate[] | Native tree-sitter predicates (run in WASM, faster than post-filters) |
| `inline_tier` | — | `blocking` \| `warning` \| `review` | Override dispatch tier for this rule |
| `defect_class` | — | string | e.g. `injection`, `xss`, `logic` |
| `confidence` | — | `low` \| `medium` \| `high` | |
| `tags` | — | string[] | e.g. `[security, owasp-top-10]` |
| `cwe` | — | string[] | e.g. `[CWE-89]` |
| `owasp` | — | string[] | |
| `has_fix` | — | boolean | Defaults to `false` |
| `fix_action` | — | string | Short label for the fix suggestion |
| `examples` | — | `{bad?, good?}` | Code strings shown in docs |

**Predicate shape:**
```yaml
predicates:
  - type: eq          # or: match, any-of
    var: "@FUNC_NAME"
    value: "dangerousMethod"
```

### Example

```yaml
id: no-sync-fs-in-request
name: Synchronous fs call inside request handler
severity: warning
category: performance
language: typescript
message: "Synchronous fs call blocks the event loop — use the async variant"

query: |
  (call_expression
    function: (member_expression
      object: (identifier) @FS
      property: (property_identifier) @METHOD)
    (#eq? @FS "fs")
    (#match? @METHOD "^(readFileSync|writeFileSync|existsSync|statSync)$"))

metavars:
  - FS
  - METHOD

has_fix: false
tags:
  - performance
  - nodejs
examples:
  bad: |
    const data = fs.readFileSync(path, "utf-8");
  good: |
    const data = await fs.promises.readFile(path, "utf-8");
```

---

## Ast-grep rules

### Drop path

```
<project-root>/rules/ast-grep-rules/rules/<rule-id>.yml
```

If a project rule has the same `id` as a built-in, the **project rule wins** (first-match-wins by id during deduplication).

### YAML schema

See [`rules/ast-grep-rules/rule-schema.json`](../rules/ast-grep-rules/rule-schema.json) for a machine-readable schema.

| Field | Required | Type | Notes |
|---|---|---|---|
| `id` | ✅ | string | |
| `rule` | ✅ | RuleCondition | At least one of `pattern`, `kind`, `regex`, `has`, `any`, `all`, `not` |
| `language` | — | string | See valid values below |
| `severity` | — | `error` \| `warning` \| `info` | |
| `message` | — | string | |
| `note` | — | string (block `\|`) | Extended guidance shown in the detail view |
| `fix` | — | string | Suggested replacement |
| `metadata.weight` | — | number | Priority weight |
| `metadata.category` | — | string | |
| `constraints` | — | Record\<string, {regex}\> | ⚠️ **Not supported by the NAPI runner** — rules using `constraints` are silently skipped |

Valid `language` values: `TypeScript` `JavaScript` `Python` `Go` `Rust` `Java` `C` `Cpp` `CSharp` `Kotlin` `Ruby` `Php`
(Note: PascalCase, unlike tree-sitter directory names which are lowercase.)

**RuleCondition fields:**

| Field | Notes |
|---|---|
| `pattern` | Ast-grep pattern syntax; avoid single-metavariable patterns like `$VAR` (too broad) |
| `kind` | AST node kind name |
| `regex` | Regex match against node text |
| `has` | Nested condition — node must have a descendant matching |
| `any` | Array — node matches if any item matches (OR) |
| `all` | Array — node matches if all items match (AND) |
| `not` | Negation condition |

**Unsupported by the NAPI runner** (rules using these are silently skipped to avoid false positives):
`inside` `follows` `precedes` `stopBy` `field` `nthChild` `constraints`

### Example

```yaml
id: no-process-exit-in-library
language: TypeScript
severity: warning
message: "process.exit() in library code terminates the host process"
note: |
  Library code should throw an error or return a result code instead of
  calling process.exit(). The caller decides whether to exit.

  BAD:  process.exit(1)
  GOOD: throw new Error("fatal condition")
rule:
  pattern: process.exit($CODE)
```

---

## Multiple rules per file

Ast-grep rule files support multiple YAML documents separated by `---`:

```yaml
id: rule-one
language: TypeScript
severity: warning
message: "First rule"
rule:
  pattern: somePattern($A)
---
id: rule-two
language: TypeScript
severity: error
message: "Second rule"
rule:
  pattern: otherPattern($B)
```

Tree-sitter query files are one rule per file.

---

## Validation

Run the built-in type-check against your rules to surface YAML parse errors before committing:

```sh
# type-check only (no emit) — errors in rule files show up via the loader path
npx tsc --noEmit
```

For richer editor feedback (autocomplete, hover docs), point the VS Code YAML extension at the bundled schemas:

```json
// .vscode/settings.json
{
  "yaml.schemas": {
    "./rules/tree-sitter-queries/rule-schema.json": "rules/tree-sitter-queries/**/*.yml",
    "./rules/ast-grep-rules/rule-schema.json": "rules/ast-grep-rules/rules/*.yml"
  }
}
```
