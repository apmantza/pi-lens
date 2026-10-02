---
section: Fixed
audience: user
---

- **Node tool agreement now reads pnpm and yarn lockfiles (refs #3655)** — Projects that declare a Node formatter or linter in `package.json` and resolve it through `pnpm-lock.yaml` (v9 workspaces and v6, including versions with peer-context suffixes such as `16.4.0(less@4.2.0)`) or `yarn.lock` (v1, including CRLF files, and Berry) now establish tool agreement exactly as npm projects do, so autofix and formatting run instead of declining with no visible change. A `pnpm-lock.yaml` or `yarn.lock` over 16 MiB is declined with `evidence-too-large` instead of being read in full.
