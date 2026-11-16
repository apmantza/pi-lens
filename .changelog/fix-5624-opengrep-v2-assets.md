---
section: Fixed
audience: user
area: install
---

- **Opengrep, Hadolint, Vale, shfmt and tflint install again from their current releases.** Opengrep 2.0.0 renamed its release files and ships Windows as a zip with its DLLs, so the managed install found nothing to download. Hadolint's Linux file names and Vale's pinned 3.14.2 had also drifted from the latest releases, and shfmt and tflint looked for Windows arm64 builds that do not exist, so Windows arm64 now gets the x64 build. (refs #5624)
