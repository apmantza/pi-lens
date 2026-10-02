---
section: Changed
audience: internal
---

- `ci-verdict --watch-open` gains `--stream` (one line per event per head until the window ends, with `MERGED` listing the closing issues' states and `DIRTY` and `CANCELLED-NOT-REPLACED` events), `--rerun-cancelled` (re-runs a cancelled unreplaced run, retrying a refusal up to three times per head with a backoff; requires `--state-file`), `--sync-main <path>` (fast-forwards the main checkout on a merge, refuses when it is off master, dirty or cannot fast-forward, and flags a moved `package-lock.json` without ever running `npm ci`) and a new `--approve-fork <PR>` mode, keeps the no-suite absence clock in `--state-file`, no longer re-reports a conflicted head across an UNKNOWN mergeability flap, and reads `FAIL` lines for `.spec.ts`/`.test.mjs` files and `AssertionError [ERR_ASSERTION]`.
