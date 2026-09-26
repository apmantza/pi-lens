---
section: Fixed
---

- On Linux and macOS, a language server orphaned by a crashed session is
  reaped even after its registry record is lost. The registry-independent
  backstop judged ownership by the parent pid, which on POSIX becomes init
  and stays alive, so it never reaped anything there and the server ran until
  reboot. Every LSP child now carries its owner's identity in
  `PI_LENS_OWNER=<pid>:<start>`, and the backstop reaps it once that owner is
  gone; a process without the variable is never touched. On Windows the
  backstop also treats a parent that started after the child as a reused pid.
  The health read no longer drops a dead session's record while it still
  lists children, and a sweep whose process query failed keeps the records it
  could not judge (refs #3539).
