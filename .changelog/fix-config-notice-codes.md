---
section: Fixed
audience: user
---

- **An unknown or wrong-typed config key now prints its own code, not `PILENS_CFG_0001`.** A misspelled key such as `lps` prints `PILENS_CFG_0004`, and a value the schema rejects such as `format.mode: "nonsense"` prints `PILENS_CFG_0005`. `PILENS_CFG_0001` now means only that a config file is unreadable, unparsable, or not a JSON object. If you filter on `PILENS_CFG_0001` to hide these notices, filter on `PILENS_CFG_0004` and `PILENS_CFG_0005` as well, because the typo notices move to those codes. (refs #5140)
