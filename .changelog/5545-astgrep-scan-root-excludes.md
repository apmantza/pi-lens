---
section: Fixed
audience: user
area: runners
---

- **`ast_grep_search` and `ast_grep_replace` stop answering "no matches" in some checkouts.** A rule-mode scan now runs inside the tree it scans, so the project's own ignore globs match paths relative to the scan root instead of an ancestor that happens to be named `.claude` or `build`; reported match paths stay absolute. The `npx` fallback keeps its isolated child cwd, while repository trees use native ignore handling and marker-less trees retain the project's own exclude globs. A glob or path you passed the tool yourself is still matched unchanged. (refs #5545)
