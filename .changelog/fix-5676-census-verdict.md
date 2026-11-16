---
section: Fixed
audience: internal
---

- The nightly LSP census tracker files its drift issue only when a census output is not success. A job failure outside the census no longer files an issue with an empty census section (refs #5676).
