---
section: Fixed
---

- **Memoize package-manager global bin dirs (closes #1602)** — `findGlobalBinary` no longer re-spawns `npm config get prefix`/`pnpm bin -g`/`yarn global bin` on every miss; the per-manager bin dir is cached alongside the existing availability latch, shares one in-flight probe across concurrent callers, and rejects stale writes from probes that cross a session reset.
