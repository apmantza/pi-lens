---
section: Fixed
audience: user
---

- An MCP call with `cwdPath`, `maxFiles`, `outFile` or `includeFiles` is no
  longer refused as a mistyped `path` or `file`. These keys name a different
  parameter, so the call runs with the unknown-argument warning, and the
  warning hints `cwd` for `cwdPath` and nothing for the other three (refs #3809).
