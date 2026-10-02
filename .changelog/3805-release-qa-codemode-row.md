---
section: Changed
audience: internal
---

- **release-qa witnesses pi's codemode tool (refs #3805)** — A new `codemode-nested-guard` row drives a real pi 0.99 with a scripted provider and `defaultTools: ["+codemode"]`: a nested `tools.edit` of an unread file must be blocked by read-guard with the file unchanged on disk, a licensed nested read-then-edit must apply, and the turn_end check for it must reach a later request. The row is SKIPPED on a pi without codemode, and an expired wait reads UNTESTED.
