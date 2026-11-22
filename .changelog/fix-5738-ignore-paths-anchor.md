---
section: Fixed
audience: user
area: rules
---

- **A rule's `ignorePaths` now match from the folder of the config file that declares them.** Starting pi in `repo/pkg` with `/gen/**` in `repo/.pi-lens.json` now skips `repo/gen`, as the `ignore` field does, instead of `repo/pkg/gen`. Entries in the global config stay relative to your working directory. (refs #5738)
