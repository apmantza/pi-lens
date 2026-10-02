---
section: Fixed
audience: user
---

- **The post-exit LSP resync no longer waits forever on an abandoned formatter (closes #3599)** — after the deferred drain's own bound gave up on the format phase, the detached resync awaited the abandoned formatter's `abandoned` promise with no limit, so a formatter whose command resolution auto-installed (an install has no leaf bound) parked the resync indefinitely. The wait now runs under the drain's own formatter budget, and a wait that expires records one `hook-await-exceeded` degradation (`off_hook:deferred-format-post-exit-resync`) and abandons the resync rather than publishing bytes the formatter is about to replace.
