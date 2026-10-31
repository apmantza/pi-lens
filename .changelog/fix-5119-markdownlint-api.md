---
section: Fixed
audience: user
---

- **A markdownlint diagnostics pass no longer rewrites your file under `"fix": true`**: pi-lens now lints through `markdownlint-cli2`'s exported `main` with `fix` forced off, run in a small child process under the same 15 s budget, found beside the resolved command (project `node_modules/.bin`, the managed tool dir, or a PATH install), so a project `.markdownlint-cli2.jsonc` with `"fix": true` no longer deletes trailing spaces on save even with autofix off; config discovery, `extends`, `ignores` and `overrides` stay cli2's own, an edited `.cjs` config is read fresh, the autofix stage still fixes, and when no package sits beside the command the CLI is spawned as before and one `markdownlint-api-unavailable` row is recorded (a project `"fix": true` can still write on that path) (#5119).
