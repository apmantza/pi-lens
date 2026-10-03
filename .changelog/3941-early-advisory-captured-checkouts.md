---
section: Fixed
audience: internal
---

- **Early-start advisory checkouts no longer fetch the deleted merge ref (refs #3941)** — `targeted-tests-advisory`, `mise-repro`, `vale`, `oxlint-advisory`, `jscpd`, `complexity`, `strictness`, `yamllint`, `typos`, `taplo`, and `pr-body-lint` run on `pull_request` without waiting behind `heavy-gate`, so a runner-queue delay can start their checkout after auto-merge deletes `refs/pull/<n>/merge`. Each pinned `ref: ${{ github.ref }}` and fetched that dead ref. They now rely on the pinned `actions/checkout` default captured commit (`github.sha`), exactly as `unit-tests-windows` (#3926) and the sibling gated jobs do. The existing checkout census in `tests/config/heavy-advisory-gate-workflow.test.ts` classifies every checkout site by stage from the parsed YAML, derives pull-request eligibility from the shared event-only projection (`tests/support/workflow-pull-request-reachability.ts`), and fails if any early-start advisory site does not use the captured commit, apart from the one named read-only OSV head scan.
