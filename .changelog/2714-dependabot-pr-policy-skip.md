---
section: Changed
---

- **Skip the PR title, body and close-keyword checks for dependabot PRs (refs #2714)** — the `pr-title-lint` and `pr-body-lint` jobs in lint.yml and the lint job in close-keywords.yml now carry a `dependabot[bot]` skip condition. A bump can never carry an issue ref or the PR-body template, so these checks no longer go red on every bump and no merge-train pass has to ignore them by hand. Lint, Unit tests, the install tests and the advisory lanes still run on bumps.
