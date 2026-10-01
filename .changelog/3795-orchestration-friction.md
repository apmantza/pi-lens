---
section: Changed
---

- **Orchestration friction: PR-body garble guard and one changelog fragment per PR (refs #3795)** — `check-pr-body` rejects emptied inline code spans and pasted npm-script or `oxlint` output outside a fence, so a shell-expanded worker body fails before it is pushed; the `Changelog fragment (fast-fail)` job and `pr-preflight` fail any PR diff that adds more than one direct `.changelog/*.md` fragment, naming each one it adds; CI diffs its depth-1 merge ref from the base directly (`--merge-ref`), and `pr-preflight` diffs from the merge-base with `origin/master`.
