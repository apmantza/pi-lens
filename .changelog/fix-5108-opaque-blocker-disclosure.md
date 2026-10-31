---
section: Fixed
audience: user
---

- **A blocker on a file a script wrote is no longer reported as clean**: when a bash heredoc (python, node) writes a file pi-lens cannot prove you authored, the tool result now names the file and the number of blocking findings it withheld instead of `✓ clean`, and when the host's 500 ms read-only bound abandons the check, the same disclosure reaches you at the next context call with the abandonment stated. The STOP block, autofix and the commit gate stay off for those bytes (#5108).
