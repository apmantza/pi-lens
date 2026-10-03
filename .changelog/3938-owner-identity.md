---
section: Fixed
audience: internal
---

- **Governance occurrence identity no longer drifts at the 400-line owner bound (refs #3938)** — `findEnclosingSymbol` derives the nearest enclosing declaration from a request-local per-file pass instead of a 400-line window, and matches that declaration against comment/string-blanked source (the shared `stripSource` seam), so a declaration-shaped line inside a multi-line block comment or template literal is never read as an owner while the flagged line's own hash stays raw. Inserting harmless lines above a flagged await no longer drops or fabricates the symbol component of its exemption key. The hook-await registries were re-keyed with same-file, same-own-hash, same-context proof.
