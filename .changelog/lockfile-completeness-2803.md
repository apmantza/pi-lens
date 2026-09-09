---
section: Added
---

- **Check lockfile completeness under CI's npm (refs #2803, #2784)** — preflight and `check:lockfile --complete` reject optional dependency drift before merge; **Pin the clean production install to npm@11.18.0 (refs #2803, #2784)** — use
  the repository's exact npm pin so a different npm version cannot rewrite the
  committed lockfile.
