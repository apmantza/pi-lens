---
name: lsp-navigation
description: Navigate code with IDE features and run proactive LSP diagnostics on files/folders/batches. Use as PRIMARY for code intelligence and type/error checks.
---

# LSP Navigation and Diagnostics

Use `lsp_navigation` as **PRIMARY** for code intelligence. Use `lsp_diagnostics` as **PRIMARY** for proactive type/error checks on files, folders, or explicit batches. Do NOT use grep/glob/ast-grep first for code intelligence or diagnostics.

**Requires:** `--lens-lsp` flag

## When to Use Diagnostics

Use `lsp_diagnostics` before builds/tests or after touching several files:

| Need                        | Tool call                                                                  |
| --------------------------- | -------------------------------------------------------------------------- |
| Check one file              | `lsp_diagnostics({ filePath: "src/file.ts" })`                             |
| Check a folder              | `lsp_diagnostics({ filePath: "src/", severity: "error" })`                 |
| Check exact touched files   | `lsp_diagnostics({ filePaths: ["src/a.ts", "src/b.ts"], concurrency: 8 })` |
| Give slow servers more time | `lsp_diagnostics({ filePaths: files, waitMs: 2000 })`                      |
| Show warnings too           | `lsp_diagnostics({ filePaths: files, severity: "all" })`                   |

Prefer explicit `filePaths` batches after multi-file edits: they are bounded-concurrency and avoid unrelated directory noise.

## When to Use Navigation (Code Intelligence)

| Question                                | Operation                                | Parameters                                                                    |
| --------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------- |
| "Where is this defined?"                | `definition`                             | filePath, line, character                                                     |
| "Find all usages"                       | `references`                             | filePath, line, character                                                     |
| "What type is this?"                    | `hover`                                  | filePath, line, character                                                     |
| "Show call signature here"              | `signatureHelp`                          | filePath, line, character (at call-site args)                                 |
| "What symbols in this file?"            | `documentSymbol`                         | filePath                                                                      |
| "Find symbol across project"            | `workspaceSymbol`                        | query + **filePath strongly recommended**                                     |
| "What quick fixes are available?"       | `codeAction`                             | filePath, line, character, endLine, endCharacter                              |
| "Rename symbol safely"                  | `rename`                                 | filePath, line, character, newName                                            |
| "Who implements this interface?"        | `implementation`                         | filePath, line, character                                                     |
| "Who calls this function?"              | `prepareCallHierarchy` → `incomingCalls` | filePath, line, character                                                     |
| "What does this function call?"         | `prepareCallHierarchy` → `outgoingCalls` | filePath, line, character                                                     |
| "Show tracked LSP diagnostics snapshot" | `workspaceDiagnostics`                   | optional filePath (snapshot only; prefer `lsp_diagnostics` for active checks) |

## Operational Guidance (From Field Tests)

- Always pass `filePath` for `workspaceSymbol` when possible. Unscoped queries are best-effort and often empty.
- For `references`, prefer querying from the definition site for broader cross-file coverage; usage-site queries can be partial.
- Use `signatureHelp` only at call-site argument positions; declaration positions often return empty.
- Treat `workspaceDiagnostics` as tracked push snapshot (`publishDiagnostics`), not protocol pull `workspace/diagnostic` coverage. Prefer `lsp_diagnostics` when you need an active file/folder/batch check.
- For `codeAction`, separate `quickfix` from generic refactors (for example "Move to new file"). Do not treat generic refactors as error fixes.
- `prepareCallHierarchy` is server-capability dependent; if unsupported, skip incoming/outgoing calls.
- If TypeScript returns `No Project` on `workspaceSymbol`, retry after opening the scoped file context.

## Call Hierarchy Pattern

```typescript
// Step 1: Prepare (get the callable item)
const items = await lsp_navigation({
  operation: "prepareCallHierarchy",
  filePath: "src/api.ts",
  line: 42,
  character: 10,
});

// Step 2: Get callers (who calls this function)
const callers = await lsp_navigation({
  operation: "incomingCalls",
  callHierarchyItem: items[0],
});

// Step 2: Get callees (what this function calls)
const callees = await lsp_navigation({
  operation: "outgoingCalls",
  callHierarchyItem: items[0],
});
```

## When NOT to Use LSP

| Task                        | Use Instead       | Why                         |
| --------------------------- | ----------------- | --------------------------- |
| Active type/error checks    | `lsp_diagnostics` | Diagnostics, not navigation |
| Find patterns (console.log) | `ast_grep_search` | Pattern matching            |
| Find text/TODOs             | `grep`            | Text search                 |
| Find files by name          | `glob`            | File discovery              |
| Read file content           | `read`            | Direct access               |

## Golden Rule

**Code intelligence → `lsp_navigation` first. Type/error validation → `lsp_diagnostics` first. Text/pattern search → grep/ast-grep.**
