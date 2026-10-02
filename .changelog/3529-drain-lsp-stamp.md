---
section: Fixed
audience: user
---

- **The language server no longer keeps an older copy of a file after pi-lens' end-of-run formatting (closes #3529)** — After formatting a file at the end of the agent's run, pi-lens sent the formatted bytes to the language server without saying when it had read them. If the next run had edited the file in the meantime, the older formatted bytes could arrive after the edit and the server kept them until the next touch. And when pi-lens stopped waiting for a slow formatter, the formatter's later write was never sent at all. The end-of-run sync now carries the time of its read, so an older read is dropped, and once a formatter pi-lens stopped waiting for has exited, pi-lens reads the file again and sends it; once a new session has started, only to a language server that already has the file open.
