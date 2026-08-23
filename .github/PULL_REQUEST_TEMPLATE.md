## Summary

Briefly describe what this PR does and which issue it resolves.

Closes #(issue)

## Type of change

- [ ] Bug fix
- [ ] New feature (net-new capability)
- [ ] Enhancement (improvement to existing capability)
- [ ] Documentation

## Area

- [ ] area:lsp
- [ ] area:dispatch
- [ ] area:installer
- [ ] area:diagnostics
- [ ] area:read-guard
- [ ] area:project-intelligence
- [ ] area:perf
- [ ] area:observability
- [ ] area:session
- [ ] area:config
- [ ] area:security
- [ ] area:tests

## Checklist

- [ ] I have read [CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md)
- [ ] The change has tests (happy path, edge cases, regression test for bugs)
- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] `npm run build:dist` succeeds if I changed code under `clients/`, `commands/`, `tools/`, or `index.ts`
- [ ] `package-lock.json` is in sync with `package.json` (run `npm install` after dep changes)
- [ ] `AGENTS.md` is updated if this PR changes behavior, commands, conventions, or invariants documented there
- [ ] `.changelog/<branch-or-slug>-<short-desc>.md` has one valid entry **in this PR** for any user-facing change (Added/Changed/Deprecated/Removed/Fixed/Security) — see [.changelog/README.md](../.changelog/README.md); internal-only test/refactor PRs may skip it
- [ ] Commit subject includes the issue number: `(closes #NNN)` or `(refs #NNN)`

## What changed and why

Use this section for any non-obvious design decisions or gotchas the reviewer should know about.

## Tests

Name each NEW test file/case and each EDIT of an existing test, with one line on what it pins and why it exists (regression proof / contract seam / occupancy budget). If no tests changed, say so explicitly.

## Blast radius

State affected dependents for each touched production module (from `module_report` with `blastRadius: true`), callbacks/entry points, and the verification plan. If a hot path is touched (per-spawn / per-file / per-render), state the measured cost delta. Record "empty/unavailable" explicitly with why.

## Class sweep

If this PR fixes or files a defect: name the defect class/shape and record which sibling sites were swept (grep + what was found OK). "Class of size 1" requires the grep that proves it.
