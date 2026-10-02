---
section: Changed
audience: internal
---

- `scripts/ci-verdict.mjs` now reads CI checks over the GitHub REST API directly when the `gh` CLI is not on PATH but `GH_TOKEN`/`GITHUB_TOKEN` is set — the Claude Code cloud container's own shape. It reads the same PR head/mergeable, check-runs, and required-check-name data `gh api` would, and the printed verdict now names which transport produced it (`Transport: gh` or `Transport: rest`). Node's global `fetch` ignores `HTTPS_PROXY`, so when this REST transport is needed and a proxy is configured the script re-execs itself once with `NODE_USE_ENV_PROXY=1` (Node >=22.21 only — on an older Node it fails closed with an explicit message instead of a silent misread). With neither `gh` nor a token it still exits 70, unchanged (closes #3497).
