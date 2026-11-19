---
section: Fixed
audience: user
area: lsp
---

- **Python servers reach global fallbacks, and PATH never runs unadmitted project files.** Python servers now reach global fallbacks for adopted projects: absent project candidates are reported as missing before trust is considered, while existing refused candidates no longer end a launch stage when installation is disabled. For an adopted project, or one pi has not trusted, a PATH entry inside the project (relative entries such as `bin` or `.` included) is skipped when a language server is looked up, and a PATH link into the project is refused. When PATH reaches such a project, managed lookups read only the pi-lens tool store, so the TypeScript and Jedi fallbacks and the Go, Ruby and .NET runtime installs no longer probe or run its `tsc`, `python` or `go`. (refs #5674)
