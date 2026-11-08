---
section: Changed
audience: user
area: config
---

- **Numeric knobs now treat 0 as a value and blank as unset.** A blank `PI_LENS_*` number now falls back to its default, and an explicit `0` disables the knobs documented as "0 disables", such as `PI_LENS_LSP_TOUCH_DEBOUNCE_MS`. A non-numeric or negative value also falls back to the default. The four switches `PI_LENS_REVERSE_DEPS_REUSE`, `PI_LENS_GRAPH_SEQ_FASTPATH`, `PI_LENS_SNAPSHOT_PERSIST_SYNC` and `PI_LENS_READ_GUARD_LOG_SNAPSHOTS` accept only `0` or `1`, so `false` and `off` no longer switch them. (refs #5419)
