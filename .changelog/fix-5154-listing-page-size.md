---
section: Fixed
audience: internal
---

- The nightly test-history download pages the artifact listing at 30 a page and parses it in node, so a failed listing reports its HTTP status instead of `unexpected end of JSON input` (refs #5154)
