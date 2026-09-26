---
section: Fixed
---

- The orphan reaper no longer kills a process that merely reuses a dead
  session's recorded pid. It used to match a recorded LSP child by the base
  name of its command, so a live session's language server, a live pi-lens
  host (when the recorded command was `node`) or a user's own process on that
  pid could be killed, and a pid that changed hands between the sweep's check
  and its kill was killed too. Registry records now carry each child's and
  host's OS start time; a kill needs the same start as recorded, a record
  without one is never killed by pid, and the identity is checked again right
  before each signal. On Linux the start includes the boot id, so a record
  that survived a reboot never matches. A new session on a crashed
  session's pid no longer takes over its children. `instances.json` only gains fields, so older
  versions still read it (refs #3538).
