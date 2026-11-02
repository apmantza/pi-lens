---
section: Changed
audience: internal
---

- The read guard's three oldText autopatch span matchers (blank-line, interior-whitespace and Unicode-punctuation tiers) are one `findSignatureInsensitiveCandidate` called with a per-tier line signature, so a safety edit to the unique-match or two-anchor rule reaches every tier; recovered spans are unchanged (refs #4907).
