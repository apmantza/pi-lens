---
section: Changed
audience: user
area: config
---

- **Numeric knobs now treat 0 as a value and blank as unset.** A blank `PI_LENS_*` number now falls back to its default, and an explicit `0` disables the knobs documented as "0 disables", such as `PI_LENS_LSP_TOUCH_DEBOUNCE_MS` and `PI_LENS_LSP_EARLY_UNBLOCK_GRACE_MS`; `PI_LENS_LSP_NAV_CLIENT_WAIT_MS` keeps 0 as its default. A non-numeric or negative value also falls back to the default. The switches `PI_LENS_REVERSE_DEPS_REUSE`, `PI_LENS_GRAPH_SEQ_FASTPATH` and `PI_LENS_READ_GUARD_LOG_SNAPSHOTS` now read only the exact `0` or `1`, so `false` and `off` stop switching them off. `PI_LENS_SNAPSHOT_PERSIST_SYNC` accepted `1` and `true` before and now accepts only `1`, so `true` stops switching it to sync persistence. (refs #5419)
