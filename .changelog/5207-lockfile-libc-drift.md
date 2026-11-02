---
section: Changed
audience: internal
---

- `npm run check:lockfile` refuses a `libc` field that vanished from a package that stays in the lock, judging what the commit records: the staged blob from Git’s exported commit index (including temporary indexes for `-a` and path commits), the working copy when the index holds no change for it, and the merge base with `origin/master` when the commit records `HEAD`'s bytes unchanged. The refusal names both sides it compared, `package.json`'s `packageManager` pin and the `npx npm@11.18.0 install --package-lock-only --ignore-scripts` regeneration. npm older than the pin writes no `libc` field, so the pre-commit hook catches the drop that a PATH npm 9.2 made all 56 of in #5200; a `git show` failure the gate cannot classify refuses the run instead of reporting `not checked`. (refs #5207)
