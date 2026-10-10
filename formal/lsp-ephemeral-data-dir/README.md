# Ephemeral LSP data directory model (#3803, M7)

This model covers the merged #4127 implementation in `clients/file-utils.ts`
and `clients/runtime-session.ts`: temporary checkout roots are classified and
memoized per process, one random token is settled per process, and
`session_start` removes only entries whose pid is dead. The process token is
modeled as a unique per-process serial; the random suffix is not otherwise
observable, so its 32-bit collision probability is outside this finite model.

## Invariants

- `NoSharedEphemeralDir`: a live process never selects an ephemeral
  data-directory identity still held by another process, including a dead
  process's leftover after pid reuse; this implies two live processes never
  share one.
- `SweepOnlyDead`: a sweep never removes a directory owned by a live process.
- `NoCrossRootShare`: two roots used by one process have distinct physical
  directories. This is the headline #4127 pre-fix witness.
- `ClassificationConsistent`: every root assigned a directory was classified
  ephemeral in that process's memo.

## Configs

`PreFixShared` is the old pid-only naming rule and violates
`NoCrossRootShare` for two temporary roots in one process. `PreFixSweep` is a
mutation of the merged cleanup guard and violates `SweepOnlyDead`. `Merged`
enables the process token, root-specific directories, and the dead-pid guard,
and passes all invariants. The `memo` variable represents the per-process
classification memo: a root's policy is settled once and is required before a
directory is assigned.

Run with `node scripts/check-tla-models.mjs`; the repository checker includes
every config under `formal/`.
