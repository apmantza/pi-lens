# pi-lens contribution audit — audit1.md

This document records structural inconsistencies and centralization gaps found while preparing `CONTRIBUTING.md`. Each finding notes the files involved, the impact on contributors, and a recommended fix.

## Findings

### 1. Markdown dispatch group is inconsistent between `language-policy.ts` and `plan.ts` (and AGENTS.md is stale)

**Files:**
- `clients/language-policy.ts` — `PRIMARY_DISPATCH_GROUPS.markdown` = `["lsp", "spellcheck", "vale"]`
- `clients/dispatch/plan.ts` — `LANGUAGE_CAPABILITY_MATRIX.markdown.writeGroups` also includes `{ mode: "all", runnerIds: ["markdownlint"], filterKinds: ["markdown"] }`
- `AGENTS.md` — "Known finding (open): `markdownlint` is registered but absent from the markdown write-dispatch group"

**Impact:** Contributors reading `AGENTS.md` are told `markdownlint` does not run on writes, but the actual dispatch path (`getDispatchGroupsForKind` → `TOOL_PLANS`) does include it. The primary group used for coverage notices does not know about `markdownlint`, so a missing-tools notice may fire even when `markdownlint` is available.

**Recommended fix:**
- Decide whether `markdownlint` belongs in the markdown write path. If yes, add it to `PRIMARY_DISPATCH_GROUPS.markdown` and remove the stale note from `AGENTS.md`. If no, remove it from `plan.ts` and keep/rewrite the `AGENTS.md` note.

---

### 2. Ast-grep rule discovery is duplicated and diverges from the LSP baseline

**Files:**
- `clients/sgconfig.ts` — resolves shipped baseline to `rules/ast-grep-rules/rules` + `rules/ast-grep-rules/coderabbit/rules`
- `clients/dispatch/runners/ast-grep-napi.ts` — hardcodes its own list:
  ```ts
  const ruleDirs = [
    path.join(process.cwd(), "rules", "ast-grep-rules", "rules"),
    path.join(process.cwd(), "rules", "ast-grep-rules"),
    resolvePackagePath(import.meta.url, "rules", "ast-grep-rules", "rules"),
    resolvePackagePath(import.meta.url, "rules", "ast-grep-rules"),
  ];
  ```

**Impact:** The napi runner does not load the CodeRabbit vendor rules, and it resolves rules relative to `process.cwd()` rather than the project root. A contributor adding a new rule directory must remember two loaders. The two paths can silently drift.

**Recommended fix:** Refactor the napi runner to consume `resolveBaselineSgconfig()` / `findLocalSgconfig()` from `clients/sgconfig.ts`, or extract a shared `getAstGrepRuleDirs(cwd)` helper used by both.

---

### 3. Tree-sitter query loader uses a hand-rolled YAML parser

**Files:**
- `clients/tree-sitter-query-loader.ts` — `parseYaml()` and `extractMultilineValue()` are custom
- `clients/dispatch/runners/yaml-rule-parser.ts` — uses `js-yaml` for ast-grep rules
- `scripts/validate-rule-catalog.mjs` — uses regex to scrape YAML scalars

**Impact:** The tree-sitter loader does not support multiple YAML documents per file, complex nested objects, or arrays the way `js-yaml` does. A contributor writing a tree-sitter rule with richer metadata may hit silent parse failures. The three rule loaders do not share code, so fixes and behavior diverge.

**Recommended fix:** Replace the hand-rolled parser in `tree-sitter-query-loader.ts` with `js-yaml` (already a runtime dependency), or reuse `parseSimpleYaml` from `yaml-rule-parser.ts`.

---

### 4. Rule catalog validation only tracks a hardcoded subset of ast-grep rules

**Files:**
- `scripts/validate-rule-catalog.mjs` — `TRACKED_AST_GREP_IDS` is a hardcoded allowlist
- `rules/rule-catalog.json` — catalog entries
- `rules/ast-grep-rules/rules/` — ~180+ rules

**Impact:** A new ast-grep rule will pass `ast-grep test` and the napi validity test, but the catalog validator will not notice if it should be catalogued. The catalog drifts from the actual rule set.

**Recommended fix:** Derive `TRACKED_AST_GREP_IDS` from the rule directory (or from a required field in each rule), or make the catalog validator walk all ast-grep rules and report any active rule that lacks a catalog entry.

---

### 5. LSP runner `appliesTo` must be manually kept in sync with `LSP_SERVERS`

**Files:**
- `clients/dispatch/runners/lsp.ts` — `appliesTo` array lists ~35 file kinds
- `clients/lsp/server.ts` — `LSP_SERVERS` currently has 40 entries

**Impact:** Adding a new language server for a new file kind requires updating both `LSP_SERVERS` and the lsp runner's `appliesTo`. If they drift, the runner may skip files that have a configured server, or vice versa.

**Recommended fix:** Generate the lsp runner's `appliesTo` from the union of extensions handled by registered primary LSP servers (minus any intentionally excluded kinds), or add a test that asserts every `LSP_SERVERS` extension maps to a kind covered by the lsp runner.

---

### 6. Tree-sitter runner duplicates file-extension → language mapping

**Files:**
- `clients/file-kinds.ts` — `KIND_EXTENSIONS` and language IDs
- `clients/dispatch/runners/tree-sitter.ts` — `resolveTreeSitterLanguage()` has its own `EXT_TO_LANG`

**Impact:** A new file extension or language needs updates in two places. The tree-sitter mapping already diverges: it maps `.cs` to `"csharp"` while the query loader uses `"csharp"` as a language key, but the file kind is `"csharp"` — subtle naming mismatches are easy to introduce.

**Recommended fix:** Derive the tree-sitter language key from `KIND_EXTENSIONS` + a small mapping table, or add a test that fails when an extension covered by the tree-sitter runner lacks a mapping.

---

### 7. `runners/index.ts` comment claims `ast-grep-napi` is post-write disabled, but it is wired into write dispatch

**Files:**
- `clients/dispatch/runners/index.ts` — comment says `// DISABLED in post-write dispatch - ast-grep-napi can crash. Enabled via /lens-booboo plan only.`
- `clients/dispatch/plan.ts` — `jsts.writeGroups` and `jsts.fullOnlyGroups` include `{ mode: "all", runnerIds: ["ast-grep-napi"], filterKinds: ["jsts"] }`

**Impact:** New contributors are misled about whether the runner is active. The runner also has its own skip logic when the ast-grep LSP is enabled, making the effective behavior hard to reason about.

**Recommended fix:** Update or remove the misleading comment. Document the precedence: ast-grep LSP (if enabled and available) → napi runner skipped; otherwise napi runner runs on jsts writes.

---

### 8. README server count is inconsistent with `LSP_SERVERS`

**Files:**
- `README.md` — claims "37 language server definitions (including two cross-cutting auxiliary scanners)"
- `clients/lsp/server.ts` — `LSP_SERVERS` has 40 entries: 37 non-auxiliary + 3 auxiliary (`opengrep`, `ast-grep`, `zizmor`)

**Impact:** A contributor adding a server cannot tell what number to update, and users may be confused about which auxiliary scanners exist (the README names only Opengrep and ast-grep, omitting zizmor).

**Recommended fix:** Update the README to say "40 language server definitions (37 primary + 3 auxiliary: opengrep, ast-grep, zizmor)" or similar. Consider generating the count in a nightly doc script.

---

### 9. Several runners inline policy/availability checks instead of using the `when` precondition field

**Files:**
- `clients/dispatch/runners/markdownlint.ts` — checks `getLinterPolicyForCwd` inline
- `clients/dispatch/runners/ruff.ts` — checks policy inline
- `clients/dispatch/types.ts` — defines `RunnerDefinition.when`
- Other runners (e.g. `eslint`, `stylelint`) use `when`

**Impact:** Contributors see two patterns for the same concern. Precondition logic is harder to discover and test when it's inside `run()`.

**Recommended fix:** Migrate inline policy/availability gating into `when` where possible, and document the convention in `CONTRIBUTING.md`.

---

### 10. LSP server extensions and `FileKind` extensions must be manually kept in sync

**Files:**
- `clients/file-kinds.ts` — `KIND_EXTENSIONS`
- `clients/lsp/server.ts` — each server's `extensions` array

**Impact:** Adding support for a new extension (e.g. a new web framework file type) requires updating both `KIND_EXTENSIONS` and every relevant LSP server. It is easy to add a file kind without a server, or a server extension without a file kind.

**Recommended fix:** Add a unit test that asserts every extension in `LSP_SERVERS` is present in `KIND_EXTENSIONS` (or explicitly exempted), and that every `FileKind` with `lspCapable: true` has at least one server covering its extensions.

---

### 11. `TyposServer` is defined but not registered in `LSP_SERVERS`

**Files:**
- `clients/lsp/server.ts` — defines `export const TyposServer` (id `"typos"`, role `"auxiliary"`)
- `clients/lsp/server.ts` — `LSP_SERVERS` array does not include `TyposServer`
- `clients/dispatch/auxiliary-lsp.ts` — no profile for `"typos"`
- `clients/installer/index.ts` — no `TOOLS` entry for `typos-lsp`

**Impact:** `tests/clients/lsp/lsp-registry-consistency.test.ts` fails because every exported server-shaped object must be registered. The server is half-wired: it has a spawn implementation and an `autoInstall` hook, but no auxiliary profile, no diagnostic strategy, and no installer registry entry, so enabling it now would produce untagged diagnostics or install failures.

**Recommended fix:** Either complete the feature (register in `LSP_SERVERS`, add an `AuxiliaryLspProfile`, add a `SERVER_DIAGNOSTIC_STRATEGY`, and add `typos-lsp` to `TOOLS`) or make `TyposServer` non-exported until it is ready.

---

### 12. Orphaned Go ast-grep fixture files reference non-existent rules

**Files:**
- `rules/ast-grep-rules/rule-tests/go-*-test.yml` (11 files)
- `rules/ast-grep-rules/rules/` — no corresponding `go-*.yml` rules

**Impact:** `tests/clients/dispatch/runners/ast-grep-rule-tests.test.ts` fails because it asserts every test fixture's `id:` resolves to a real rule in `rules/`. The fixtures were added without their rule implementations.

**Recommended fix:** Add the missing rule YAML files, or remove the orphaned fixtures if the rules are no longer planned. The test guard is correct; the fixture set should stay in sync with the rule set.

---

## Summary

The highest-value centralization work is:

1. Unify ast-grep rule directory resolution between `sgconfig.ts` and `ast-grep-napi.ts`.
2. Replace the tree-sitter query loader's hand-rolled YAML parser with `js-yaml`.
3. Make the rule catalog validator walk all ast-grep rules instead of a hardcoded list.
4. Add mechanical sync tests for LSP runner `appliesTo`, server extensions, and file-kind coverage.
5. Reconcile the markdown dispatch group inconsistency and update stale documentation.

These changes reduce the number of places a contributor must touch and prevent silent drift between parallel code paths.
