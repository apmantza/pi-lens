## Summary

Closes #2888. Extend the spawn-cwd scanner and its population rule to resolve named aliases, namespace imports, default imports, dynamic destructuring, and `require` bindings from `node:child_process`.

The measured population moves from 76 files / 136 direct sites / 34 wrapper entries to 80 files / 142 direct sites / 36 wrapper entries. The existing #2882 helm-lint worklist row remains unchanged. No resolver promotion rules change.

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
- Full required run: 143 test files passed, 1 skipped, 1,759 tests passed, 69 skipped; 3 Git-fixture tests failed because the repository guard rejects test-created `/tmp` `git init` commands.
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

The defect class is AST surface-spelling blindness, aligned with AGENTS.md defect shape 34. The whole-tree sweep covers `clients/`, `tools/`, `mcp/`, and `index.ts`; it measures 80 files and 142 direct sites. The population rule covers named, aliased, namespace, default, dynamic-import, and require bindings. The existing family stays distributed because the scanner and population predicate must remain separate seams with one shared binding vocabulary. No helm-lint migration changes; #2882 remains the sole worklist row.

## Operating rule

Every child-process call through a resolvable binding is a scanned site, regardless of import spelling.

## Kept

Resolver promotion rules and the #2882 helm-lint worklist row remain unchanged.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
