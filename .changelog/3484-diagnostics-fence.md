---
section: Fixed
---

- **Diagnostics from a server that publishes without a version no longer answer for the edit before (closes #3484)** — such a server can publish results for the previous content just after pi-lens sends an edit, and nothing in the publish says which content it describes, so the edit's diagnostics wait could settle on the old results. For a server seen publishing without a version, pi-lens now sends a `textDocument/documentSymbol` request together with each edit and ignores that file's version-less publishes until the reply arrives. Servers that report versions pay nothing extra. A server that advertises no such request keeps the old behaviour (recorded once per session), a fence that is never answered lifts after the normal diagnostics wait, and a server that answers and only then publishes an older analysis can still get through.
