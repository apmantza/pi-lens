---
section: Fixed
---

- A file with no project marker (no `package.json`, `Cargo.toml` and the like
  above it) no longer re-walks every ancestor directory on each lookup whenever
  any of them changes. A cached miss now stays fresh while its own start
  directory is unchanged and for up to 2 seconds, so a marker created higher up
  is picked up within that window (refs #2560).
