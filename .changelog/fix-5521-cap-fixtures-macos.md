---
section: Fixed
audience: internal
---

- Reach the workspace-glob memo cap from a 119-character member path instead of a 1,415-character one (the server-policy Cargo cell and the uv consumer cell no longer hit macOS `PATH_MAX`), and pass the generated pre-push probe's paths and argv through environment variables instead of interpolating them into its source (resolves CodeQL alerts 83 and 84). (refs #5521)
