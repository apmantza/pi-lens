---
section: Changed
audience: internal
---

- `npm run check:lockfile` compares `package-lock.json` against `HEAD`'s committed copy and refuses a `libc` field that vanished from a package still in the lock, naming `package.json`'s `packageManager` pin and the `npx npm@11.18.0 install --package-lock-only --ignore-scripts` regeneration. npm older than the pin writes no `libc` field, so the pre-commit hook now catches the drop that a PATH npm 9.2 made all 56 of in #5200. (refs #5207)
