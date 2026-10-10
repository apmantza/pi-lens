---
section: Fixed
audience: user
---

- **Require a BuildKit rule from the official Docker smoke server** (closes #3939) — The nightly smoke now uses the upstream rule-bearing fixture and discloses runners without `docker buildx` instead of accepting an empty diagnostic baseline. Credit: qiyangfan.
