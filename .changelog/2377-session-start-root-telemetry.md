---
section: Fixed
---

- **Preserve unknown root identity in `session_start_total` (refs #2129).** Quick and full startup records now write `sameRoot: "unknown"` when the root comparison has no usable input, so durable telemetry distinguishes unknown identity from a legacy omitted field.
