---
section: Fixed
---
- **Nightly tool smoke: the six `--install` steps share one tool tree again (refs #2762, refs #2687)** — #2755 dropped the job-level `PI_LENS_HOME`/`PILENS_DATA_DIR` pin from `tool-smoke.yml` and `parser-smoke.yml`, so the Format layer started from an empty scratch home and seven managed formatters ran against nothing; the pin and its workflow test are restored, per-run scratch isolation stays the local default.
