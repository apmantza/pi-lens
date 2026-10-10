## Why

Pre-push and lane-check now rebuild the bundled LSP dependency before governance suites can import a missing or stale `dist/` file.

## Notes for the reviewer

- The bounded population is the single current production `scripts/` import target: `clients/lsp/server-traits.ts` → `dist/clients/lsp/server-traits.js`.
- The direct fresh-process reproduction on the base checkout was `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/home/akis/.plegma/work/sub-mv0optod-225/dist/clients/lsp/server-traits.js' imported from .../scripts/lib/clean-signal.mjs`.
- `npm run build` remains the in-place compiler; only the guarded `npm run build:dist` path prepares this bundle.

## Change outline

```text
- pre-push-targeted-tests.mjs / lane-check.mjs
  + findStaleDistFiles
    + npm run build:dist before self-scan/governance
```

## Summary

The shared helper defines the bounded imported-file population and checks existence plus source/output mtimes. The pre-push and lane-check entries invoke the rebuild before their existing test stages. A failed rebuild emits one actionable remedy line.

`scripts/pre-push-targeted-tests.mjs:66`

```js
export const DIST_IMPORTS = [
```

`scripts/pre-push-targeted-tests.mjs:74`

```js
export function findStaleDistFiles(root) {
```

`scripts/pre-push-targeted-tests.mjs:772`

```js
const staleDist = findStaleDistFiles(process.cwd());
```

`scripts/lane-check.mjs:161`

```js
const staleDist = findStaleDistFiles(root);
```

`scripts/lane-check.mjs:168`

```js
if (distBuild.status !== 0) {
```

`scripts/pre-push-targeted-tests.mjs:781`

```js
} catch (error) {
```

Closes #4239

## Type of change

- [x] Bug fix
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
- [x] area:config
- [ ] area:security
- [x] area:tests

## Checklist

- [x] I have read [CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md)
- [x] The change has tests (happy path, edge cases, regression test for bugs)
- [x] Targeted test files for the touched seams pass locally after `npm run build`; the full suite is CI's job.
- [x] Every NEW regression test is proven RED on pre-fix code; the red output is quoted in this PR
- [x] New guards/branches/filters/caps/fallbacks have compile-valid hand-mutation proof (AGENTS.md, one PR mutation layer)
- [x] PR title carries the conventional prefix and the issue ref
- [ ] `npm run lint` passes (not run; lane is constrained to the requested gates)
- [x] `npm run build:dist` succeeds
- [x] `package-lock.json` is in sync with `package.json`
- [x] `AGENTS.md` is updated if this PR changes behavior, commands, conventions, or invariants documented there
- [x] `.changelog/fix-4239-dist-prepush.md` has one valid internal entry
- [x] Commit subject includes the issue number: `(closes #NNN)` or `(refs #NNN)`

## Tests

- `tests/scripts/dist-freshness.test.ts`: missing and older bundle cases for the shared mtime seam.
- `tests/scripts/lane-check.test.ts`: real lane-check fixture proves the rebuild line and output.
- `tests/scripts/pre-push-targeted-tests.test.ts`: edited fixture copy list includes the new production helper; the full file remains environment-red because the git guard rejects its synthetic `/tmp` repositories (quoted below).
- `tests/config/*.test.ts`: 103 files, 1,425 passed, 1 skipped.

Red first, with the regression test present and the lane-check guard removed:

```text
× rebuilds a missing dist dependency before governance suites (#4239)
AssertionError: expected ... to contain '[lane-check] dist/ missing or stale ... running npm run build:dist...'
```

Compile-valid mutation of the mtime comparison in `scripts/pre-push-targeted-tests.mjs`:

```text
× reports a bundled dependency older than its source
AssertionError: expected undefined to be 'stale'
```

```js
return statSync(sourcePath).mtimeMs > statSync(outputPath).mtimeMs
```

The restored targeted regression run was `Test Files 2 passed (2); Tests 3 passed (3)` for the filtered cases, and the full touched script run was `Test Files 2 passed (2); Tests 32 passed (32)`. The direct freshness probe measured `real 0m0.076s` for one bounded target.

### Round 2 (cloud review F1-F4, test-only)

- F1: the pre-push rebuild branch is now pinned. Replacing `findStaleDistFiles(process.cwd())` with `[]` in `scripts/pre-push-targeted-tests.mjs` reds two tests: "builds before the self-scan: an unbuilt tree on a docs-only push exits 0" and "reports a dist build failure before the self-scan" (`Tests  2 failed | 71 passed (73)`).
- F2: the lane-check failure branch is now pinned. Short-circuiting the `distBuild` failure check reds "dist build failure: unproven, exit 3, and no test step runs" (`Tests  1 failed | 30 passed (31)`).
- F3: `tests/scripts/dist-freshness.test.ts` scans comment- and string-blanked `scripts/lib` sources and requires every static `dist/` import to be in `DIST_IMPORTS`. Emptying the registry-derived set reds the census (1 failed, 2 passed). The census is registered in `TREE_SCANNING_GOVERNANCE_TESTS` and in the path-mirror literal population, which the tree-scanner census requires.
- F4: the freshness tests name their recurrence (#4239).
- Green after round 2: `tests/config` plus the three touched files gave `Test Files  106 passed (106)` and `Tests  1529 passed | 1 skipped (1530)`.

## Blast radius

The changed callers are the pre-push hook path and the lane-check path; both call `findStaleDistFiles` before their existing self-scan/test stages. The helper has no durable state and reads two filesystem entries for the current target. The three affected governance suites are `tests/config/lsp-clean-behavior-census.test.ts`, `tests/config/lsp-first-publish-census.test.ts`, and `tests/config/lsp-idle-eviction-measurement.test.ts`; `scripts/bench-lsp.mjs` shares the same dist target but is not a governance suite. No `module_report` executable is present in this checkout; the call tree is therefore recorded directly above and covered by the 103-file governance run.

## Observability

No new failure path; no record added.

## Class sweep

Defect shape: a bounded generated-output dependency is missing or older than its source before a suite imports it (AGENTS.md “a test double, ratchet or sweep” and the stale-build rule under “Commands and gates”). The sweep was:

- `scripts/lib/clean-signal.mjs:36` → `../../dist/clients/lsp/server-traits.js` — covered.
- `scripts/lib/lsp-idle-eviction-probe.mjs:12` → `../../dist/clients/lsp/server-traits.js` — covered.
- `scripts/bench-lsp.mjs:54` → `dist/clients/lsp/server-traits.js` — same target, covered by the shared population.
- `tests/scripts/packed-layout.test.ts:32` contains only a fixture string for a different packed-layout case — not a runtime dependency.

The grep was `rg -n --glob 'scripts/**' --glob 'tests/**' "(?:from|import\\s*\\()\\s*['\"]...dist/" scripts tests`; no other runtime target was found. The family folds onto the existing `scripts/pre-push-targeted-tests.mjs` seam; it stays bounded because all current consumers resolve the same generated file.

## Test assessment

- `tests/scripts/dist-freshness.test.ts`: uniquely pins missing and stale target classification; no redundant case.
- `tests/scripts/lane-check.test.ts`: uniquely pins the real lane-check rebuild before governance; no redundant case.
- `tests/scripts/pre-push-targeted-tests.test.ts`: existing real-hook fixture coverage; the only edit supplies the copied helper required by the new import; no test was removed.
- `tests/config/*.test.ts`: full governance census passed; no test was removed.

The pre-push file's 33 failures were caused by the harness git guard rejecting fixture `git init`/`git commit` operations, while its base comparison marked the other fixture failures `RED-ON-BASE`; this environment block is not related to dist freshness.


