---
section: Fixed
audience: internal
---

- The `forgetTurnSession` FileTime test now passes on macOS. It looked up FileTime
  under the temp directory's linked spelling, while the read guard stamps a
  file's resolved path, so it failed whenever `TMPDIR` was a link. (refs #5716)
