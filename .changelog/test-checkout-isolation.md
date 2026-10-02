---
section: Fixed
audience: user
---

- Automatic tests no longer select files from a separate Git checkout, including through filesystem aliases. Such failures cannot enter the parent's failed-first cache, cached failures are retired when a boundary appears, and discovery continues to an eligible parent companion rather than stopping at a foreign first match. Unreadable Git markers retain indeterminate ownership rather than deleting a checkout's own failures; aliased dispatch roots preserve integration/e2e exclusions, and bounded records disclose capped ownership walks and final foreign-target rejections. Explicit test execution and ordinary nested packages keep their existing behaviour. Internal clean-ups preserve checkout metadata and discovery filtering order.
