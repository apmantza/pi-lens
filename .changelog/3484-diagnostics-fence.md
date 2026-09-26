---
section: Fixed
---

- **Diagnostics from the YAML and PHP servers no longer answer for the edit before (closes #3484)** — these servers publish without a version, so a publish for the previous content that arrived just after pi-lens sent an edit could settle the edit's diagnostics wait on the old results. For servers measured to answer a request before they publish for the new content (yaml-language-server and intelephense), pi-lens now sends a `textDocument/documentSymbol` request together with each edit and ignores that file's version-less publishes until the reply arrives; the number ignored is logged. Other servers are not fenced: docker-langserver publishes the new results before it would answer, so fencing it would throw its only answer away, and the rest are unmeasured. A fence that is never answered is cancelled after the normal diagnostics wait, and a server that answers and only then publishes an older analysis can still get through.
