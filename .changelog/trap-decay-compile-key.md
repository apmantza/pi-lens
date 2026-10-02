---
section: Fixed
audience: user
---

- Decay a tree-sitter input's wasm trap count when the parse, query compile or consumer that trapped later succeeds, so a one-off trap no longer disables an unchanged file for the rest of the process. A healthy caller of the same content cannot re-arm another caller's trap, a poisoned file still spends one trap-budget unit however many callers parse it, and the symbol extractor's query compile is keyed per query source (refs #3678).
