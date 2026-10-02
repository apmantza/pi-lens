---
section: Fixed
audience: user
---

- **A read pi-lens widened now says so, and the read guard's switch turns the widening off (closes #3555)** — a `read` of 100 lines or fewer is widened to its enclosing function, method or class, or to its Markdown heading section, so the read guard can record symbol-level coverage. Nothing in the result showed it: an agent that asked for line 140 got the whole section from line 11 and could not tell. The result now starts with a separate note, for example `[pi-lens: read widened to the Markdown section under the heading "Tareas" (heading boundary): you asked for lines 140-149, this shows lines 11-160. Re-request with limit > 100 for the exact range.]`, followed by the file text unchanged. The widening also no longer runs when the read guard is off (`--no-read-guard` or `readGuard.enabled=false`), since it exists to serve the guard. `docs/agent-guide.md` and `docs/features.md` gave the threshold as 60 lines; it is 100.
