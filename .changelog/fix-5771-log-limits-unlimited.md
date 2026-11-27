---
section: Fixed
audience: user
area: config
---

- **Log retention and size limits can now be turned off.** `0`, `off` or `unlimited` in `PI_LENS_LOG_RETENTION_DAYS`, `PI_LENS_MAX_LOG_SIZE_MB`, `PI_LENS_READ_GUARD_MAX_BYTES`, `PI_LENS_AW_LOG_MAX_BYTES`, `PI_LENS_AST_GREP_LOG_MAX_BYTES`, `PI_LENS_DISPOSITION_LOG_MAX_BYTES` and `PI_LENS_DEAD_CODE_LOG_MAX_BYTES` no longer fall back to the default, and an unusable value is named in the session-start report. (refs #5771)
