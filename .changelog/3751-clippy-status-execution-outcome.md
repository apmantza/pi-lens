---
section: Fixed
audience: user
---

- **rust-clippy reports the execution outcome in `status` (closes #3751)** — a
  run that succeeded and found a deny-level lint now returns
  `status: "succeeded"` with `semantic: "blocking"`, instead of overloading
  `status: "failed"` for both a broken runner and found blocking diagnostics.
  `status: "failed"` now means only that clippy produced no usable result, and
  the lint still blocks.
