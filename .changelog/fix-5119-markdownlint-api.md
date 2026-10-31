---
section: Fixed
audience: user
---

- **A markdownlint diagnostics pass no longer rewrites your file under `"fix": true`**: pi-lens now lints through `markdownlint-cli2`'s exported `main` with `fix` forced off, found beside the resolved command (project `node_modules/.bin`, the managed tool dir, or a PATH install), so a project `.markdownlint-cli2.jsonc` with `"fix": true` no longer deletes trailing spaces on save even with autofix off; config discovery, `extends`, `ignores` and `overrides` stay cli2's own, the autofix stage still fixes, and when the module cannot be loaded the CLI is spawned as before and one `markdownlint-api-unavailable` row is recorded (a project `"fix": true` can still write on that path) (#5119).
