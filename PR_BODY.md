## Summary

Closes #2888. Extend the spawn-cwd scanner and its population rule to resolve named aliases, namespace imports, default imports, dynamic destructuring, and `require` bindings from `node:child_process`.

The measured population remains 80 files and moves to 148 direct sites after recognizing the sync child-process trio. The existing #2882 helm-lint worklist row remains unchanged. No resolver promotion rules change.

## Type of change

- [x] Bug fix
- [ ] New feature (net-new capability)
- [ ] Enhancement (improvement to existing capability)
- [ ] Documentation

## Area

- [x] area:tests
- [x] area:config

## Tests

- `tests/support/spawn-cwd-scan.test.ts`: `resolves aliased named import`, `resolves namespace import`, `resolves default import`, `resolves dynamic destructuring`, `resolves require namespace`, and `resolves a destructured require alias` pin each newly supported binding spelling.
- `tests/clients/dispatch/runners/runner-spawn-cwd-sweep.test.ts`: `the population rule admits exactly what the scan can see` pins parity across all binding spellings; the live sweep pins the measured population and per-site admissions.
- Red-first proof: with alias resolution mutated from `local || imported` to `imported`, `resolves aliased named import` failed with `expected [] to deeply equal [ 'hasCwd=true resolved=false' ]`.
- Mutation proof: the alias-resolution mutation above reds the named-alias fixture.
- Full required run: 143 test files passed, 1 skipped, 1,818 tests passed, 69 skipped; 3 Git-fixture tests failed because the repository guard rejects test-created `/tmp` `git init` commands, and the AST-grep latch timed out at 5 seconds.
- `npm run fmt:check` passed.
- `npx tsc --noEmit` passed.
- `npm run lint` passed.
- `tests/clients/flake-shape-ratchet.test.ts` passed 57 tests after keeping fixture-only child-process spellings out of its real-process population.
- Sweep timing: 6.45 s idle and 6.57 s with `--maxWorkers=1`, both below the 30 s hook budget.

Preflight table:

| gate | mirrored CI job | pass/fail | first red line |
| --- | --- | --- | --- |
| build | Lint & type-check | pass | |
| lint | Lint & type-check | pass | |
| fmt:check | oxfmt format check | pass | |
| changelog:check | Unit tests | pass | |
| check-changelog-fragments | Changelog fragment (fast-fail) | pass | |
| check:lockfile | Lint & type-check | pass | |
| lockfile:complete | Lint & type-check | pass | |
| tests/config | Unit tests | pass | |
| generation-guard | Unit tests | pass | |
| flake-shape-ratchet | Unit tests | pass | |
| lsp-spawn-heavy-coverage | Unit tests | pass | |
| ci-verdict | Unit tests | pass | |
| knip | knip (advisory) | pass | |

## Test assessment

- `tests/support/spawn-cwd-scan.test.ts` uniquely pins AST binding resolution and mutation-sensitive alias coverage; no redundant tests removed.
- `tests/clients/dispatch/runners/runner-spawn-cwd-sweep.test.ts` uniquely pins population parity, measured reach, and live admissions; no redundant tests removed.

## Blast radius

No production modules changed. Production blast radius is empty. The scanner affects only test-time population and cwd conformance reporting. The new rows admit process cleanup sites with no project cwd and LSP launch sites whose cwd comes from their local launch boundary.

## Observability

No new runtime failure path; no record added. The test sweep output and pinned site keys are the observables for this test-only change.

## Class sweep

The defect class is AST surface-spelling blindness, aligned with AGENTS.md defect shape 34. The whole-tree sweep covers `clients/`, `tools/`, `mcp/`, and `index.ts`; Round 2 measured 80 files and 148 direct sites. Round 3 measures 81 files and 149 direct sites. The population rule covers the scanner's named, aliased, namespace, default, dynamic-import, require, and sync child-process bindings. The existing family stays distributed because the scanner and population predicate remain separate seams with one shared binding vocabulary. No helm-lint migration changes; #2882 remains the sole worklist row.

## Operating rule

Every child-process call through a resolvable binding is a scanned site, regardless of import spelling.

## Kept

Resolver promotion rules and the #2882 helm-lint worklist row remain unchanged.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## Round 2

### Summary

Fix imported-name resolution for aliased child-process calls, follow options wrappers whose spawn options are parameters, recognize the sync child-process trio, and correct the measured hook-budget note.

### Tests

- tests/support/spawn-cwd-scan.test.ts: the two alias-direction cases pin imported-name identity; the options-wrapper case pins caller reach.
- tests/clients/dispatch/runners/runner-spawn-cwd-sweep.test.ts: the live sweep pins 148 direct sites and their reasoned admissions.
- Mutation proof: changing the binding-map key from local || imported to imported makes five fixture cases and five live-sweep checks fail, including the exec-alias case with expected [] to deeply equal [ 'hasCwd=true resolved=false' ].
- The normal-environment required run reaches 1,892 tests: 1,820 passed, 69 skipped, and 3 failed because the repository Git guard rejects intentional `git init` calls in `/tmp`.
- npm run fmt:check passes.
- npx tsc --noEmit passes.
- tests/clients/flake-shape-ratchet.test.ts passes with support/spawn-cwd-scan.test.ts registered as scan infrastructure for literal fixture text.

### Blast radius

Only test scanner, fixture, ratchet, sweep admission, durable guidance, and changelog files change. The scanner changes affect spawn-cwd sweep reach only. The live population was 80 files and 148 direct sites in Round 2; Round 3 measures 81 files and 149 direct sites.

### Class sweep

Named imports preserve the imported API name through local aliases. Namespace and dynamic bindings continue to use their member name. The sync trio uses the same options-position rule. Parameter-shaped options wrappers are checked only within their defining file; the live cross-file caller remains outside this sweep's wrapper reach. The scan remains language-neutral at the TypeScript AST seam and does not change production behavior.

### Observability

No new runtime failure path; no record added. The sweep site keys, population pins, admissions, and mutation-red test output are the bounded observables for this test-only change.

### Test assessment

The two alias-direction cases are regression tests for imported-name identity. The options-wrapper case is a regression test for caller reach. The ratchet registration is a contract update for synthetic fixture text, not a production test double.

## Round 3

### Summary

Make the population predicate derive its child-process names from `NODE_SPAWN_NAMES`, pin all seven names, and admit `clients/metrics-history.ts` with its true hand-derived `spawnDir` reason. Correct the safe-spawn pass-through row, consolidate the #2888 changelog fragments, and replace copied timing claims with a local measurement.

### Tests

- `tests/support/spawn-cwd-scan.test.ts`: `resolves an execSync options object` pins the sync options index; removing `execSync` from `NODE_SPAWN_NAMES` makes its assertion fail with `expected [] to deeply equal [ 'hasCwd=true resolved=false' ]`.
- `tests/clients/dispatch/runners/runner-spawn-cwd-sweep.test.ts`: `the population rule admits exactly what the scan can see` derives and checks all seven names plus the unrecognised `execFileAsync` bound; the live sweep pins 81 files and 149 direct sites.
- Mutation proof: reverting `execSync`'s options index from 1 to 2 makes the fixture fail with `expected [ 'hasCwd=false resolved=false' ] to deeply equal [ 'hasCwd=true resolved=false' ]` and leaves `metrics-history.ts` unadmitted.
- The flake-shape ratchet passes with the literal synthetic child-process fixture kept under the load-bearing `SCAN_INFRASTRUCTURE` entry.
- `npm run fmt:check` and `npx tsc --noEmit` pass. The required broad run reaches 1,892 tests: 1,820 passed, 69 skipped, and 3 failed because the repository Git guard rejects intentional `/tmp` fixture `git init` calls.

### Blast radius

The change touches test scanner population and fixtures, flake-ratchet metadata, AGENTS.md guidance, and one changelog fragment. No production modules change. The scanner affects only the dispatch sweep's child-process reach and cwd admission reporting. The live population changes from 80 files and 148 direct sites to 81 files and 149 direct sites. If #2911 lands first, the merged arithmetic is 78 files, 129 direct sites, and 33 wrapper sites; the second lander must resolve the sweep conflict and remeasure.

### Class sweep

The rule's one source of truth is the exported `NODE_SPAWN_NAMES` tuple in `tests/support/spawn-cwd-scan.ts`; the population regex is projected from it. All named, aliased, namespace, default, dynamic-import, require, and sync bindings remain covered. The fail-safe population assertion admits every recognised name and rejects `execFileAsync`, which remains outside the scanner bound. `clients/metrics-history.ts` is a truthful no-cwd admission because its Git command uses the hand-derived repository-root `spawnDir`, not a dispatch cwd.

### Observability

No new runtime failure path; no record added. The bounded observables are the 81/149 reach pins, site-keyed admission rows, parity assertions, and mutation-red assertion output.

### Test assessment

- `tests/support/spawn-cwd-scan.test.ts` adds `resolves an execSync options object`, uniquely pinning the sync options-position arm and its imported-name recognition.
- `tests/clients/dispatch/runners/runner-spawn-cwd-sweep.test.ts` edits the population parity case and adds the `metrics-history.ts` admission; these uniquely pin scanner/population agreement and live-row truth.
- `tests/support/flake-shape-scan.ts` edits the infrastructure description while retaining a load-bearing exemption for the literal synthetic fixture.

### Merge-order note

The sweep file conflicts with #2911. On the merged state, the measured values are `EXPECTED_FILES = 78`, `EXPECTED_DIRECT_SITES = 129`, and 33 wrapper sites. Whichever PR lands second must resolve the conflict and rerun the sweep on that merged tree.
