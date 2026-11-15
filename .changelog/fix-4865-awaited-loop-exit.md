---
section: Changed
audience: internal
---

- **A broader shape-86 governance rule ships disabled.** `awaited-loop-wait` admits an awaited test loop only when a real-clock deadline bounds it or it awaits nothing but `waitFor`, and it reports the 29 of the #5618 review's 35 planted equivalents that the active `turn-count-wait` rule misses. On the tree it reports 669 loops, of which at least 17, among the members read, are real-I/O waits, so it sits in `scripts/governance-rules/rules-disabled/`. Its rule tests run through `sgconfig-disabled.yml`. The active rule and its baseline are unchanged. (refs #4865)
