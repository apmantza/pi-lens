---
section: Fixed
audience: user
---

- **Stale-build advisories no longer break `-json` payloads (closes #5159)** — when the warm build went stale, the `warmCodeStale` advisory was appended to the last text block, so every JSON cell (`module_report` `*-json`, `project_report` `view:"json"`, `lsp_navigation`) stopped parsing exactly when an agent most needs to read it. JSON cells now carry the advisory (and any ignored-arguments note) in their own trailing annotation blocks, leaving block 0 parseable. Text cells are byte-identical.
