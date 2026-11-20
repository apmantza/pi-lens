---
section: Fixed
audience: user
area: host
---

- **pi-lens now reaps its leftover logs, state and sockets at session start.** Oversized tool-result spill logs, saved session state, endpoint sockets whose owner process is gone, and project data directories whose project no longer exists used to accumulate forever; a disk audit measured 431 MB of project directories, 16 spill files from September, and 36 stale sockets on one machine. The session-start sweep now reaps each of these past its retention window. A project data directory goes only after 30 days, only when no path on disk can still be the project it was named for, and never on Windows; anything the sweep cannot judge stays. (refs #5702)
