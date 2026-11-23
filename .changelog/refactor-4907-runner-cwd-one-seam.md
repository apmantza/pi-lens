---
section: Changed
audience: internal
---

- Route the yamllint, ruff, biome-check and spellcheck runners' spawn cwd through `resolveRunnerCwd` in `clients/tool-cwd.ts`, delete the second copy in `runner-helpers.ts`, and stop `spawn-cwd-scan` admitting a resolver imported from any module but `tool-cwd.js` (refs #4907).
