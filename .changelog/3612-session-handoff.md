---
section: Fixed
audience: user
---

- **Session state follows `/reload`, `/fork`, `/clone`, resume and `pi --fork` (closes #3612, #3653, #3604, #3589)** — a `/reload` keeps every read whose tool result is on the branch, and the files the session wrote, instead of asking for a re-read of each. A fork or clone keeps the parent's widget diagnostics and lazy-tool activations. Lazy-tool activations are now saved with the session, so a resume, a relaunch and `pi --fork` restore them, in-memory sessions included. A second session in the same process (a pi-web chat, a subagent) starts with its situational tools inactive, like the first. An agent advisory queued before a `/reload` still reaches the model. The session sidecar moves to a version-2 file that still reads version 1, and a `/fork` or `/reload` that finds no hand-off is counted as `session-scope-handoff-missed`.
