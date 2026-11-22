---
section: Fixed
audience: user
area: config
---

- **`effective_config` now reports the tool switches your session actually uses.** It reads `tools.<name>.enabled` from the repository's own `.pi-lens.json` and your global config, so the answer no longer changes with the `path` argument or picks up a file above the repository or one inside a package. The source list no longer names the `tools.<name>.enabled` keys. (refs #5739)
