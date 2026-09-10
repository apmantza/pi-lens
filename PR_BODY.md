## Summary

Closes #2889. Keep remembered situational activations at module scope, keyed by
session file, so pi factory rebuilds restore the same conversation posture.

The store clears when `/new` switches the session file and on quit. Reload and
resume/fork of the same file preserve it. A process restart cannot recover
in-memory activation state.

## Type of change

- [x] Bug fix

## Area

- [x] area:session

## Checklist

- [x] I have read CONTRIBUTING.md and AGENTS.md
- [x] The change has tests
- [x] Every new regression test is proven RED on pre-fix code
- [x] Every new guard/branch/filter is mutation-proof
- [x] PR title carries the conventional prefix and issue ref
- [x] `npm run lint` passes
- [x] `npm run build:dist` succeeds
- [x] AGENTS.md is updated
- [x] A changelog fragment is included

## Writers by axis

The identity is always the session file, the same key used by the dead-weight
row. It is never the process or an extension instance. Each cell names the
test that pins its required contents.

| Actor | Session file identity | Before factory re-run | After factory re-run | Before session-file switch | After session-file switch |
|---|---|---|---|---|---|
| Activation handler | same file | `it("records activation in the session-file store before a factory re-run")` | `it("restores activation after a factory re-run for the same session file")` | `it("keeps activation isolated by session file")` | `it("clears activation when a conversation switches session file")` |
| Session-start restore per reason | same file | `it("restores the parent's tool posture on %s session_start")` | `it("restores activation after a factory re-run for the same session file")` | `it("keeps activation isolated by session file")` | `it("forgets the previous conversation's activations on a new session")` |
| `/new` | same file | `it("clears activation when a conversation switches session file")` | `it("forgets the previous conversation's activations on a new session")` | `it("clears activation when a conversation switches session file")` | `it("forgets the previous conversation's activations on a new session")` |
| Quit | same file | `it("keeps activation isolated by session file")` | `it("does not create process-restart state without a session-file write")` | `it("clears activation when a conversation switches session file")` | `it("does not create process-restart state without a session-file write")` |
| Process restart | same file | `it("does not create process-restart state without a session-file write")` | `it("does not create process-restart state without a session-file write")` | `it("keeps activation isolated by session file")` | `it("does not create process-restart state without a session-file write")` |

## Tests

New `it("restores activation after a factory re-run for the same session file")`
in `tests/index-wiring.test.ts` drives two real extension factories and proves
the same session file restores one activation while dropping another.

New store contract cases in `tests/clients/tool-set-policy.test.ts` pin
session-file isolation, switching cleanup, and process-restart non-persistence.
`tests/support/pi-mock.ts` now exposes the host's real `getSessionFile()` seam.

Red proof on the pre-fix shape: replacing `getRememberedLazyTools` with an
empty set made `tests/index-wiring.test.ts` fail 4 tests, including all three
rebuild reasons and the factory-re-run regression. The failures reported that
`ast_grep_search` was missing from the restored posture.

Mutation proof: the same empty-set mutation was run after the implementation;
the four failures prove the new session-file restore guard is live.

Verification: the required targeted/config run passed 56 files, 554 tests,
with 1 skipped. `npm run build`, `npm run build:dist`, `npm run fmt:check`,
and `npx tsc --noEmit` are included in the final verification.

## Test assessment

`tests/index-wiring.test.ts` uniquely pins extension registration and lifecycle
dispatch. The existing live-closure restore cases remain valuable for the
host handoff; the new factory-re-run case covers the previously missing seam.
`tests/clients/tool-set-policy.test.ts` uniquely pins the module-level store;
no test is redundant. `tests/support/pi-mock.ts` changes only the context
identity seam and has no standalone behavior test.

## Blast radius

`clients/tool-set-policy.ts` affects `index.ts` activation and session_start
restore callbacks, plus its policy tests. `index.ts` affects the extension
factory, `pi_lens_activate_tools`, `session_start`, and `session_shutdown`.
`tools/activate-tools.ts` affects the loader callback contract and its tests.
The blast-radius map is unavailable as a local CLI report; static inspection
confirmed no other callers. This is not a per-file, per-spawn, or per-render
hot path. Verification covers built output, type-checking, formatting, and the
full requested wiring/config suites.

## Observability

The existing bounded `tool_set_mutation` record proves restore counts. No new
failure path is added.

## Class sweep

Whole-tree pattern sweep (`clients/`, `tools/`, `mcp/`, `scripts/`, and
`index.ts`): the only activation-memory writer is the `onActivated` callback
in `index.ts`, and the only restore consumer is its `session_start` block.
Population sweep: all five situational tools use the shared `LAZY_TOOL_CATALOG`
and the shared store; no per-tool memory implementation exists. The dynamic
tooling defect is class size 1, and the family stays on `tool-set-policy.ts`.

Real pi RPC witness: built `dist/index.js` loaded under pi and a probe observed
three real `session_start` events across startup and `new_session`; each exposed
the expected baseline active set with no extension errors. Probe scripts lived
in `/tmp`, with isolated `HOME` and `PI_LENS_HOME`.

Final `npm run preflight`:

| gate | mirrored CI job | pass/fail |
|---|---|---|
| build | Lint & type-check | pass |
| lint | Lint & type-check | pass |
| fmt:check | oxfmt format check | pass |
| changelog:check | Unit tests | pass |
| check-changelog-fragments | Changelog fragment (fast-fail) | pass |
| check:lockfile | Lint & type-check | pass |
| lockfile:complete | Lint & type-check | pass |
| tests/config | Unit tests | pass |
| generation-guard | Unit tests | pass |
| flake-shape-ratchet | Unit tests | pass |
| lsp-spawn-heavy-coverage | Unit tests | pass |
| ci-verdict | Unit tests | pass |
| knip | knip (advisory) | pass |

Operating rule: remember activations by session file, not by extension factory.

Kept: the dead-weight row logic and the RPC double-session_start and handler
swallow sibling seams remain unchanged.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
