---
section: Fixed
---

- **The read guard no longer credits bytes the agent never saw (refs #3525, refs #3524)** — On a file too large for line hashes (over 3,000 lines), FileTime is the guard's only staleness check, and several paths moved it over another writer's bytes: the 120-second own-edit grace, an own edit or a partial apply of an edit batch that had passed a stale FileTime on other evidence (for example a resolved `oldText`), the deferred `agent_end` format (the format service shared the guard's FileTime), autofix and LSP quick fix, the settled sweep's replay of unexplained drift, a recognized bash write such as `sed -i`, and an applied LSP rename or code action. None of them re-stamps FileTime now, so the next positional edit of a changed line asks for a re-read. They all still count as authorship. A `write` that overwrites a file records the lines it wrote from its `content` rather than from the disk. `PI_LENS_READ_GUARD_OWN_EDIT_GRACE_MS` has no effect any more.
