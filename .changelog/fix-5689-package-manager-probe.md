---
section: Security
audience: user
area: lsp
---

- **Package-manager probes respect project trust.** Global-bin discovery for language servers and Biome or Prettier ignores PATH entries inside a root that has not been admitted to run project code. (refs #5689)
