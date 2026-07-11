---
name: pi-lens-lsp-navigation
description: Navigate code with IDE features and run proactive LSP diagnostics on files/folders/batches. Use as PRIMARY for code intelligence and type/error checks.
---

# LSP Navigation and Diagnostics

Use `lsp_navigation` as **PRIMARY** for code intelligence. Use `lsp_diagnostics` as **PRIMARY** for proactive type/error checks. Do NOT use grep/glob/ast-grep first for code intelligence.

## Diagnostics

Use `lsp_diagnostics` before builds/tests or after touching several files:

| Need | Tool call |
|---|---|
| Check one file | `lsp_diagnostics({ filePath: "src/file.ts" })` |
| Check a folder | `lsp_diagnostics({ filePath: "src/", severity: "error" })` |
| Check exact touched files | `lsp_diagnostics({ filePaths: ["src/a.ts", "src/b.ts"], concurrency: 8 })` |
| Slow server (Rust, Java) | `lsp_diagnostics({ filePaths: files, waitMs: 2000 })` |
| Include warnings | `lsp_diagnostics({ filePaths: files, severity: "all" })` |

Prefer explicit `filePaths` batches after multi-file edits — bounded concurrency, no unrelated directory noise.

## Navigation (Code Intelligence)

| Question | Operation | Parameters |
|---|---|---|
| Where is this defined? | `definition` | filePath, line, character |
| Where is this symbol's *type* defined? | `typeDefinition` | filePath, line, character |
| Where is this declared (vs defined)? | `declaration` | filePath, line, character |
| Find all usages | `references` | filePath, line, character |
| What type is this? | `hover` | filePath, line, character |
| Call signature | `signatureHelp` | filePath, line, character (at arg position) |
| Symbols in this file | `documentSymbol` | filePath |
| Find symbol across project | `workspaceSymbol` | query + filePath (strongly recommended) |
| Quick fixes available | `codeAction` | filePath, line, character, endLine, endCharacter |
| Rename symbol safely | `rename` | filePath, line, character, newName |
| Who implements this? | `implementation` | filePath, line, character |
| Who calls this function? | `prepareCallHierarchy` → `incomingCalls` | filePath, line, character |
| What does this call? | `prepareCallHierarchy` → `outgoingCalls` | filePath, line, character |
| What commands does the server offer? | `capabilities` | (optional filePath) — lists advertised commands |
| Run a server command (e.g. organize imports) | `executeCommand` | command (+ commandArguments); dry-run unless `apply:true` |

## Call Hierarchy Pattern

```
// Step 1
lsp_navigation(operation="prepareCallHierarchy", filePath="src/api.ts", line=42, character=10)
// → returns callHierarchyItem

// Step 2
lsp_navigation(operation="incomingCalls", callHierarchyItem=<item from step 1>)
lsp_navigation(operation="outgoingCalls", callHierarchyItem=<item from step 1>)
```

## Operational Notes

- **`definition` returns nothing?** The file may not be open/indexed yet. Read it first, then retry.
- **`workspaceSymbol` empty?** Always pass `filePath`. Unscoped queries are best-effort and frequently return nothing. If TypeScript returns "No Project", open the scoped file first.
- **`references`** — query from the *definition site* for full cross-file coverage; usage-site queries can be partial.
- **`signatureHelp`** — only valid at call-site argument positions; declaration positions return empty.
- **`workspaceDiagnostics`** — tracked push snapshot only, not an active check. Use `lsp_diagnostics` when you need fresh results.
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

**Code intelligence → `lsp_navigation` first. Type/error validation → `lsp_diagnostics` first. Text/pattern search → grep/ast-grep.**
