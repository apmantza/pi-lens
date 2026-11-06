---
section: Fixed
audience: user
---

- **An explicit `~/.pi/agent/tsconfig.json` now roots extensions that have no project of their own.** A TypeScript extension under `~/.pi/agent/extensions/` with neither a `package.json` nor a `tsconfig.json` used to get its own directory as the language-server root even when the agent directory carried a `tsconfig.json`; the server now roots at the agent directory so that config's `types` and `paths` apply. An extension-local project still wins, an agent `package.json` alone keeps the per-file root, and only the agent directory itself is read (fixes #5335).
