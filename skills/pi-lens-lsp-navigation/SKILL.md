---
name: pi-lens-lsp-navigation
description: Navigate code with IDE features and run proactive LSP diagnostics on files/folders/batches. Use as PRIMARY for code intelligence and type/error checks.
---

# LSP Navigation and Diagnostics

Use `lsp_navigation` as **PRIMARY** for code intelligence. Use `lens_diagnostics` with `source=lsp` as **PRIMARY** for proactive type/error checks. Do NOT use grep/glob/ast-grep first for code intelligence.

## Diagnostics

Use `lens_diagnostics` with `source=lsp` before builds/tests or after touching several files:

| Need | Tool call |
|---|---|
| Check one file | `lens_diagnostics({ source: "lsp", scope: "paths", paths: ["src/file.ts"] })` |
| Check a folder | `lens_diagnostics({ source: "lsp", scope: "workspace", path: "src/", severity: "error" })` |
| Check exact touched files | `lens_diagnostics({ source: "lsp", scope: "paths", paths: ["src/a.ts", "src/b.ts"] })` |
| Slow server (Rust, Java) | `lens_diagnostics({ source: "lsp", scope: "paths", paths: files, waitMs: 2000 })` |
| Include warnings | `lens_diagnostics({ source: "lsp", scope: "paths", paths: files, severity: "all" })` |

Prefer explicit `paths` batches after multi-file edits — bounded concurrency, no unrelated directory noise.

## Navigation (Code Intelligence)

| Question | Operation | Parameters |
|---|---|---|
| Where is this defined? | `definition` | path, line, character |
| Where is this symbol's *type* defined? | `typeDefinition` | path, line, character |
| Where is this declared (vs defined)? | `declaration` | path, line, character |
| Find all usages | `references` | path, line, character |
| What type is this? | `hover` | path, line, character |
| Call signature | `signatureHelp` | path, line, character (at arg position) |
| Symbols in this file | `documentSymbol` | path |
| Find symbol across project | `workspaceSymbol` | query + path (strongly recommended) |
| Quick fixes available | `codeAction` | path, line, character, endLine, endCharacter |
| Rename symbol safely | `rename` | path, line, character, newName |
| Who implements this? | `implementation` | path, line, character |
| Who calls this function? | `prepareCallHierarchy` → `incomingCalls` | path, line, character |
| What does this call? | `prepareCallHierarchy` → `outgoingCalls` | path, line, character |
| What commands does the server offer? | `capabilities` | (optional path) — lists advertised commands |
| Run a server command (e.g. organize imports) | `executeCommand` | command (+ commandArguments); dry-run unless `apply:true` |

## Call Hierarchy Pattern

```
// Step 1
lsp_navigation(operation="prepareCallHierarchy", path="src/api.ts", line=42, character=10)
// → returns callHierarchyItem

// Step 2
lsp_navigation(operation="incomingCalls", callHierarchyItem=<item from step 1>)
lsp_navigation(operation="outgoingCalls", callHierarchyItem=<item from step 1>)
```

## Operational Notes

- **`definition` returns nothing?** The file may not be open/indexed yet. Read it first, then retry.
- **`workspaceSymbol` empty?** Always pass `path`. Unscoped queries are best-effort and frequently return nothing. If TypeScript returns "No Project", open the scoped file first.
- **`references`** — query from the *definition site* for full cross-file coverage; usage-site queries can be partial.
- **`signatureHelp`** — only valid at call-site argument positions; declaration positions return empty.
- **`workspaceDiagnostics`** — tracked push snapshot only, not an active check. Use `lens_diagnostics` with `source=lsp` when you need fresh results.
- **`codeAction`** — distinguish `quickfix` from generic refactors ("Move to new file"). Generic refactors are not error fixes.
- **`prepareCallHierarchy`** — server-capability dependent; if unsupported, skip incoming/outgoing calls.

## When NOT to Use LSP Navigation

| Task | Use Instead |
|---|---|
| Find patterns (`console.log`) | `ast_grep_search` |
| Find text / TODOs | `grep` |
| Find files by name | `glob` |
| Read file content | `read` |

## Golden Rule

**Code intelligence → `lsp_navigation` first. Type/error validation → `lens_diagnostics source=lsp` first. Text/pattern search → grep/ast-grep.**
