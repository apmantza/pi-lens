---
section: Fixed
audience: user
area: blockers
---

- **A fixed ast-grep blocker no longer stays "Still unfixed" while the language server is silent.** When a file's language server did not answer or could not start, pi-lens kept every blocker it had recorded for the file, including ast-grep ones that the ast-grep server had just checked clean. The fix then read as unfixed, stayed in `lens_diagnostics`, was listed again at turn end, and kept the commit gate shut. A recorded blocker is now judged by its own server's answer; blockers of a server that did not answer still stay. (refs #5727)
