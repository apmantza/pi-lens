---
section: Fixed
audience: user
---

- **An unresolved 🔴 blocker now names itself again at the start of each later prompt (refs #5240)** — the turn-end check reached the model in one request only, and a blocker from a nested write (a codemode script that drops the STOP note) never entered the transcript, so the model saw it once. A duplicate turn end now stages the blockers alone, headed "Still unresolved from an earlier turn", and pi takes it at the first request of the next prompt. Requests inside one prompt, resolved blockers, `--no-lens-context` and blockers already retained under `--lens-retain-injections` repeat nothing.
