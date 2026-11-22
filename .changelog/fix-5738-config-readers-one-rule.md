---
section: Fixed
audience: user
area: config
---

- **Config readers now agree on `ignorePaths`, `effective_config` tools and legacy files.** A rule's `ignorePaths` match from the folder of the config file that declares them, so `/gen/**` in `repo/.pi-lens.json` skips `repo/gen` wherever you start pi. `effective_config` reports the tool switches your session uses, from the repository's own `.pi-lens.json` and your global config. Once a `.pi-lens.json` exists, a legacy `pi-lens.json` is ignored everywhere except the language-server settings. (refs #5738, #5739, #5740)
