---
section: Fixed
audience: user
---

- Deliver a queued agent advisory (such as the fix-run lost-edit notice) only to the `context` call of the session that queued it, instead of to whichever session called first. An advisory whose session ended, or that overflows the queue of 8, is now dropped with a counted `agent-advisory-dropped` record (refs #3748).
