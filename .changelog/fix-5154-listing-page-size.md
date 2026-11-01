---
section: Fixed
audience: internal
---

- The nightly test-history download pages the artifact listing at 30 a page and parses it in node. CI printed only `unexpected end of JSON input`, with no status; an orchestrator probe on #5154 (comment 6559081169) saw HTTP 500 on the 100-a-page listing, intermittently, so a listing error now reports gh's HTTP status when gh prints one (refs #5154)
