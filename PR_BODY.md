Operating rule: every scanned child spawn must receive a cwd whose binding resolves to the shared tool-cwd seam.

Kept: existing non-project probes and cross-file parameter routing remain unchanged and require exact, reasoned exemptions.

## Summary

Extend the existing AST spawn-cwd sweep from dispatch runners to the runner, formatter, LSP, and test-runner child-spawn population. The sweep recognizes `safeSpawnAsync`, `safeSpawn`, `safeSpawnSync`, `spawnSupervised`, and `execa`.

The detector resolves direct values, locals, shorthand properties, object literals, and spreads. It rejects `ctx.cwd`, `process.cwd()`, and parameter shorthand as resolver origins. The old raw `ctx.cwd || process.cwd()` regex is removed.

`clients/test-runner-client.ts:1354` is admitted with `#2871` until that spawn migrates to the seam. Every other current non-local probe or parameter-routed site has an exact exemption key and reason. Stale exemption keys fail.

Closes #2872
Refs #2777

## Tests

- `npm run build` — pass.
- `tests/support/spawn-cwd-scan.test.ts` — 62 passing tests, including resolver-local/spread green and `ctx.cwd`/`process.cwd()`/parameter red fixtures.
- `tests/clients/dispatch/runners/runner-spawn-cwd-sweep.test.ts` — 6 passing tests.
- Required population first run on master, verbatim worklist: `91 spawn(s) do not pass cwd from resolveToolCwd`; it included `clients/test-runner-client.ts:1354 (safeSpawnAsync)` and the existing probe/parameter-routed sites. The final keyed worklist contains 48 pre-existing admissions; #2871 is the named test-runner admission.
- Mutation: changing `clients/dispatch/runners/yamllint.ts:79` to `cwd: ctx.cwd` produced `1 spawn(s) do not pass cwd from resolveToolCwd` and reported `clients/dispatch/runners/yamllint.ts:79 (safeSpawnAsync)`.
- Mutation: removing the exemption row produced `1 spawn(s) do not pass cwd from resolveToolCwd` and reported `clients/test-runner-client.ts:1354 (safeSpawnAsync)`.
- Fixture: `const dir = resolveToolCwd(...); spawn(bin, args, { ...{ cwd: dir } })` passed.
- `tests/config` and `tests/support/*.test.ts` — 63 files passed, 642 tests passed. Three Git-fixture tests were blocked because the repository guard rejected their temporary `git init` commands.
- `npm run fmt:check` — pass.
- `node scripts/check-pr-body.mjs --lint-local PR_BODY.md` — pass.

## Blast radius

Production code is unchanged. The change affects the test support AST scanner, the existing runner spawn-cwd integration sweep, AGENTS.md guidance, and one changelog fragment. The sweep scans 54 files and 91 initial sites, then enforces resolver origin on the live population. No runtime callback or entry point changes.

## Class sweep

The existing availability, finding-delivery, and other registered sweeps commonly prove that a property or marker is present. This detector specifically guards the related origin weakness: a property can be supplied by `ctx.cwd`, `process.cwd()`, a parameter, or an unrelated spread while still appearing present. The old runner sweep had exactly this property-present weakness, and its raw fallback regex was shape 34.

## Observability

No new failure path; no record added.

## Test assessment

Added resolver-origin and object-spread cases to `tests/support/spawn-cwd-scan.test.ts`. Edited the existing integration sweep to widen its population, enforce per-file seam occupancy, key exemptions by exact site, and reject stale rows. These tests are regression proofs for #2872 and mutation-sensitive guards for future spawn bypasses.

## Preflight

| gate | pass/fail |
| --- | --- |
| build | pass |
| lint | pass |
| fmt:check | pass |
| changelog:check | pass |
| check-changelog-fragments | pass |
| check:lockfile | pass |
| lockfile:complete | pass |
| tests/config | pass |
| generation-guard | pass |
| flake-shape-ratchet | pass |
| lsp-spawn-heavy-coverage | pass |
| ci-verdict | pass |
| knip | pass |
