---
section: Fixed
audience: user
area: runners
---

- **`ast_grep_search` and `ast_grep_replace` stop answering "no matches" in some checkouts.** A rule-mode scan now runs inside the tree it scans, so the project's own ignore globs match paths relative to the scan root instead of an ancestor that happens to be named `.claude` or `build`; reported match paths stay absolute. On the `npx` fallback tier, where the child cannot run inside the tree, the scan carries no ignore globs and notes the gap in its own records rather than matching them against the wrong base. A glob or path you passed the tool yourself is still matched unchanged. (refs #5545)
