---
section: Changed
audience: internal
---

- **tmp-hygiene attributes a leaked root to the test file that created it** — the tmp-root interposer records one creator per entry, the serialized owner's failure message names that file beside the prefix owner, and an entry no test-process interposer saw is labelled `created outside the test process (child)` instead of taking a prefix owner's blame. (#2912)
