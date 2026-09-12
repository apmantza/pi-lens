---
section: Changed
---

- **Verify PR-body code citations (refs #2904)** — Check cited source lines, offered evidence, lexer-derived test identifiers, and master-red transcripts against the head tree. Reject backwards citation ranges before source resolution, keep valid-table master claims outside transcript checks, shield regex literals at every expression-start boundary, reuse only immutable HEAD-tree corpora within a bounded cache, and rebuild working-tree corpora so mutable trees cannot launder removed or fabricated titles.
