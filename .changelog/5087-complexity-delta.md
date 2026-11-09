---
section: Added
audience: user
area: rules
---

- **Edits now name functions they made more complex than main.**
  An edit's result gains one short line, such as
  `⚠ complexity vs main: Store.get cc 12→19 (≥15)`, for each named function the
  edit itself made worse than the default branch has it, at or past the
  `high-complexity` thresholds (15 and 6 for every language until per-language
  ones exist). A function the edit did not change, or improved, is never
  named; neither is an anonymous callback, and the line waits while the edit
  has blockers. Outside a repository the file as the session first read it
  stands in for main. `--no-complexity` or disabling `high-complexity` turns it
  off, and a file over 256 KiB is not judged. Owner matching is linear,
  and reads skip it above that size. (refs #5087)
