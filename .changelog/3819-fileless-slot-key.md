---
section: Fixed
audience: user
---

- **A subagent's own /reload or /fork no longer takes the primary's session hand-off (closes #3819)** — In a file-less session, such as `pi --no-session` or an in-memory subagent, the hand-off slot matched on the start reason alone. A subagent that started while the primary was between its `/reload` or `/fork` shutdown and its successor's start, and then reloaded or forked itself, received the primary's lazy-tool activations, queued advisories and authored files. A file-less slot is now keyed by the ticket of the scope that left it. The real successor finds that ticket through the session manager pi hands it, and a subagent's start does not. When the subagent's start displaces the real successor, that successor now discards the slot left for it, recorded once as `session-scope-handoff-discarded`, so the displaced session cannot take the stale slot on a later reload.
