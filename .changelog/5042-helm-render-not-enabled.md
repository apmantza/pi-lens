---
section: Fixed
audience: user
---

- **A helm chart beside a denied `helm-lint` no longer reads as a failed tool** — with `helm.renderValidation` off, `helm-render` reports a stated `not-enabled` skip, so the coverage notice for a chart file says the runner is disabled in config instead of "a language tool is missing, timed out, or failed to run". The file is still reported unconfirmed (#5042).
