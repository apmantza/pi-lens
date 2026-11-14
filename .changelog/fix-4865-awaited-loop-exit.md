---
section: Changed
audience: internal
---

- **The shape-86 governance rule now admits only known-good exits.** A test loop that awaits passes only when a real-clock deadline bounds it or it awaits nothing but `waitFor`. Every other awaited loop is reported, whatever it awaits and however it counts. The rule replaces the #4983 rule, which looked for a count-bounded poll and let 29 of the 35 planted equivalents from the #5618 review through. The 669 live members sit in the baseline, each with its own reason. (refs #4865)
