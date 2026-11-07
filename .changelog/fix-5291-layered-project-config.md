---
section: Fixed
audience: user
area: config
---

- **A session started in a package directory keeps the repo root's project settings.**
  `.pi-lens.json` layers upward field by field now: a package config that sets
  one key no longer drops the root's `autofix.enabled`, `maxProjectFiles`,
  `tools.*.enabled`, `trivy.enabled` or any other field, and the nearest file
  still wins each key it sets. The turn-off lists (`rules.<id>.disable`,
  `lsp.disabledServers`, `dispatch.disabledRunners`) merge as the union of
  every file, so a nested config can add a denial but never re-enable one.
  (refs #5291)
