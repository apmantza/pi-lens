---
section: Fixed
audience: user
area: install
---

- **CMake language-server installs now refuse unsupported Python versions visibly.** The package floor prevents Python 3.14 from silently selecting 0.1.5, and nightly tool-smoke uses a pinned Ubuntu image. (refs #5561)
