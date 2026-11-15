---
section: Fixed
audience: user
area: install
---

- **Global bin lookups no longer write into your project.** For a trusted project, pi-lens asked pnpm, npm and yarn for their global bin folder from the project itself. A relative `PNPM_HOME` then created a `${HOME}` folder in the repository, and a project `.npmrc` could change the answer. The lookup now runs from your home folder whatever the trust. (refs #5632)
