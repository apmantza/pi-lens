---
section: Fixed
---

- **Run pytest in uv-managed project environments (closes #2580)** — pytest now honors `UV_PROJECT_ENVIRONMENT` and uv workspace environments, including relative paths resolved from the workspace root. Exit code 4 reports configuration errors, while exit code 2 reports an interrupted or collection-failed run.
