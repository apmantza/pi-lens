---
section: Changed
---

- **Merge-train and reviewer contracts gain five rules from the 2026-09-12 train (refs #2996)** — catalog numbers are reserved at dispatch instead of discovered at write time; `action_required` on a fork PR is distinguished from an absent check; advisory rows are read before merge even though they never gate; a verify probes the inverted direction whenever a round retunes a threshold or tier; and a clean local run is recorded as "did not reproduce", not "fixed", when a deferred producer or another worker is involved.
