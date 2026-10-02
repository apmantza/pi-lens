---
section: Fixed
audience: user
---

- The read-before-edit guard now follows the conversation across `/tree`,
  `/fork`, `/clone` and resume. After each move it keeps exactly the reads
  whose tool result is still on the branch; an edit backed only by a read,
  write or own edit on an abandoned branch is refused until the file is read
  again. Each kept read is re-checked line by line against the file on disk.
  A fork or clone now keeps the reads made before its fork point instead of
  losing all of them, so those edits are no longer falsely refused. Work
  that pi-lens finishes after a run ends (the settled drift check and the
  format, autofix and quick-fix drain) no longer counts as authored on a
  branch the user moved to while it ran, including format and autofix work
  that an interrupted run put back for the next one. Known limits: a provider that
  reuses tool-call ids across branches can let a sibling branch's read
  count; a `/tree` round trip back to a branch needs one re-read; a
  subagent running while the main session moves its tree must re-read its
  files; and a file the drain formats after the move still reads as
  authored until #3520 lands (refs #3521).
