## Why

Compile the public LSP configuration once so pi's project-trust answer gates every project-sourced executable field while preserving trusted global configuration (refs #2372, refs #836).

## Notes for the reviewer

- TLA+ unaffected: session-lifecycle — this round gates the final LSP launch resolution and does not change session, format-drain, or idle-reset transitions.
- TLA+ unaffected: instance-reaper — the launch guard refuses before child creation and does not change child ownership, teardown, or reaping transitions.
- The exact resolution seam is `clients/lsp/launch.ts:374` (`findBinaryOnPath` and the final `spawnCommand` selection). `isProjectLocalLspBinary` at `clients/lsp/launch.ts:381` reuses `isUnderDir` and `isVendorPath` to identify project-local `node_modules`, `vendor`, and venv binaries.

The admission boundary is `clients/lsp/config.ts:949`. Global values and built-ins are admitted; project `command`, command overrides, `env`, and `initializationOptions` require pi trust. Unknown trust now also refuses a built-in whose final resolved binary is inside the project, with one bounded notice per ledger generation. Managed or global binaries retain master's unknown-trust behavior.

## Change outline

- Add `compileLspRegistry` and route registration through it.
- Carry loader provenance into the non-enumerable registry input.
- Gate custom servers and built-in command/env/initialization-options overrides monotonically.
- Gate project-local built-in binaries at the final LSP resolver seam.
- Document the experimental schema and user-facing trust behavior.

## Summary

The compiler returns admitted custom servers, built-ins, overrides, and disabled ids. `LSPService` retains a raw-entry backstop for uncompiled host/test entries. The launch resolver refuses unknown-trust project-local binaries and records the refusal.

## Type of change

- [x] Feature
- [x] Security/trust behavior

## Area

- LSP configuration and service
- LSP launch resolution
- Project trust and degradation ledger

## Checklist

- [x] Reused pi's existing project-trust accessor.
- [x] Reused the shared `isVendorPath` classifier.
- [x] No pi-lens trust setting was added.
- [x] Unknown project trust fails closed for project-local binaries.
- [x] Global and managed configuration remains trusted.
- [x] Changelog fragment added.

## Tests

Unknown-trust executable matrix:

| source / resolved executable | unknown trust |
| --- | --- |
| project config command | refuse |
| project env | refuse |
| project initialization options | refuse |
| project override command/env/initialization options | refuse |
| project-local built-in binary (`node_modules/.bin`, `venv`, `.venv`) | refuse, one notice and one provenance record |
| managed or global built-in binary | preserve master's behavior |

- Red-first real-resolver/LSPService witness: removing the launch guard made `service-project-trust.test.ts` fail because the refusal notice was absent; the sole log was unrelated `tool-cwd` output.
- Focused trust run: `service-project-trust.test.ts` and `lsp-registry-trust.test.ts`, 11 passed.
- `npm run build`: passed.
- `npm run build:dist`: passed.
- 220-file LSP-named population on head: 215 passed, 4 skipped; 2 pre-existing `empty-first-publish` reds; 2,472 passed, 17 skipped. The clean base archive has 219 files (the head-only witness is absent): 215 passed, 4 skipped; 2,467 passed, 17 skipped; the same two reds are not caused by this change.
  ```text
  origin/master archive: Test Files 215 passed | 4 skipped (219); Tests 2467 passed | 17 skipped (2484)
  ```
- Governance and touched tests: 105 files, 1,436 passed, 1 skipped.
- `npm run astgrep:self-scan`: 0 raw findings, 27 advisory hits not reported without a diff base.
- All nine hand mutations are recorded in the round handback.

## Blast radius

`LSPService.spawnClient` -> registered/raw server `spawn` -> `launchLSP` -> PATH/global fallback resolution -> child spawn. The new guard is downstream of final command resolution and upstream of `trySpawn`; managed/global fallback paths remain outside the project-local predicate.

## Observability

Unknown-trust project-local binary refusals record `lsp-registry-decision` through `clients/degradation-ledger.ts` and emit one bounded extension notice per degradation-ledger generation from `clients/lsp/launch.ts`.

## Class sweep

The changed population is the LSP config loader, registry, service spawn seam, launch resolver, project-trust policy, and direct trust tests. The new launch latch is admitted in `tests/clients/generation-guard-sweep.test.ts` because it re-arms from the degradation ledger’s session generation rather than owning a second lifecycle identity. The same 220-file LSP-named population is run on head and base for this round.

## Test assessment

The new witness uses the real LSP resolver and `LSPService`; only the temporary project, PATH binary, and host-boundary config/client seams are controlled. The eight prior guards and the new project-local binary guard are hand-mutated in built output with rebuilds between runs.

Refs #2372, refs #836.

