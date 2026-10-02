---
section: Fixed
audience: user
---

- **The first logged edit after a slow session start no longer holds the change-log lock while it reads the whole log (closes #3577)** — when the `session_start` sequence read ran past its 250 ms budget, the first logged edit had no read position in the change log, so it read the whole log while holding the change-log lock: 0.83-1.17 s on a 151-158 MB log in the PR's probe. A sibling process editing in that window waited out its 500 ms and logged its edit unlocked. The edit now reads the log up to its current size before it takes the lock, and under the lock reads only the lines appended in between: the hold was 2.2-2.9 ms on the same logs. The read itself still runs on the main thread once per session. A fast-check scheduler property now checks the seq allocator over interleavings of edits, session starts, late session reads and a sibling holding the lock: seqs stay unique and rising, each edit's seq is the one it logged, and an entry is tagged `unlocked` exactly when the lock was held.
