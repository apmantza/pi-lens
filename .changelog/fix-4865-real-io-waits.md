---
section: Changed
audience: internal
---

- **The real-I/O members of the shape-86 census end their waits on the clock.** Fifteen test files and the two test-hook poll loops in `clients/` bounded a wait by an iteration count, so one descheduled sleep shortened the wall clock the wait was giving its producer: the two persist waits in `waitForProjectSnapshotPersistsForTests` and `waitForReviewGraphPersistsForTests`, the rename-echo grace windows, the file-landed and file-removed helpers, the degradation-ledger and session-sidecar pumps, and the two installer negative windows. Each now carries a `Date.now()` ceiling — `waitFor` where the read is synchronous, the same pump under a deadline where it is not — and `warm-attach-socket-error`'s negative case takes the event its 50 turns stood in for: the accepted socket's own `close`. The governance baseline drops the 14 `turn-count-wait` rows these fixes removed, and the flake-shape baseline drops two vanished `raw-timer-wait` rows and tightens two counts. (refs #4865)
