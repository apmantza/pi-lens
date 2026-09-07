---
section: Fixed
---

- **The sweep-floor meta-sweep now matches floor calls over comment- and string-blanked source (closes #2710)** — the meta-sweep registered a test file as floor-covered whenever `/assertNonEmptyScan\s*\(/` or the `auditRegistry({…minScanned…})` pattern matched its raw source, so a docblock merely quoting the helper name excused a sweep that made no real floor call (AGENTS.md shape 38; the same raw-vs-blanked mismatch #2693 round 2 F1 fixed in the runner-spawn-cwd sweep). Registration now runs through `stripSource`, and fixture tests pin that a prose-only mention is reported uncovered while a real call still registers.
