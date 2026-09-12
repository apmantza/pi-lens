Closes #2992

## Summary

Consolidate both bridge activations onto one captured flag getter and add a real lifecycle regression for stale-context reads. The read bridge now records during a stale host context, so a later edit remains authorized.

## Tests

- `tests/index-2992-integration.test.ts`: drives real extension activation, session start, factory reactivation, real read and mutation bridges, real `ReadGuard`, bounded degradation rows, and the production edit seam.
- `tests/index-integration.test.ts`, `tests/clients/read-bridge.test.ts`, `tests/clients/mutation-bridge.test.ts`, and the `getLensFlag`/bridge/`no-read-guard` population: 9 files, 280 passed.
- Configuration population: 53 files, 470 passed, 1 skipped.
- `tests/config/hook-await-bounds.test.ts` and `tests/config/strictness-ratchet.test.ts`: 2 files, 14 passed.
- `npx tsc --noEmit`: passed.
- npm run fmt:check: passed.
- `npm run preflight`: all 13 local gates passed.
- Full 1,095-file population: skipped by instruction.
- CI: the orchestrator must confirm required checks ran and passed on the final head SHA.

## Blast radius

The activation seam in `index.ts` is the only production change. Both bridge registrations read `_bridgeGetFlag`; `getBridgeFlag` still receives `read` or `mutation` identity for bounded records. The read bridge, mutation bridge, runtime coordinator, and `runtime-tool-result.ts` contracts remain unchanged.

Call-tree diff:

```text
activateExtension
- _readBridgeGetFlag
- _mutationBridgeGetFlag
+ _bridgeGetFlag
  -> getBridgeFlag(getter, "read") -> recordDegradationOnce
  -> getBridgeFlag(getter, "mutation") -> recordDegradationOnce
```

## Class sweep

The captured-getter siblings were searched with rg for `_readBridgeGetFlag`, `_mutationBridgeGetFlag`, and `getBridgeFlag` in index.ts and tests. The two sibling-specific members and assignments are gone; one activation-scoped getter remains. The shared seam is the smallest consolidation shape because deleting either old sibling-specific member is now impossible without deleting the sole getter used by both bridges.

## Observability

The stale fallback emits bounded records with kind extension-ctx-stale and subjects read-bridge and mutation-bridge. The real-bridge stress case calls each bridge 100 times and observes exactly one retained subject row per bridge. A ledger reset permits one fresh read-bridge row in the replacement lifecycle.

## Test assessment

The new test uses the real `ReadGuard`, durable degradation ledger, bridge registrations, session-start lifecycle, and production `tool_call` edit path. It injects staleness only by replacing the host API's `getFlag`; it does not mock an in-process guard or assert a setup-owned counter.

## Round 2

### F1: helper net-count

Remedy: retain one `_bridgeGetFlag` captured getter, pass `"read"` or `"mutation"` to `getBridgeFlag`, and delete both sibling-specific members and assignments. Source verification:

```text
index.ts:582:let _bridgeGetFlag:
index.ts:978:	_bridgeGetFlag = getLensFlag;
index.ts:989:	if (getBridgeFlag(_bridgeGetFlag, "read")) return false;
index.ts:1023:	return !getBridgeFlag(_bridgeGetFlag, "mutation");
```

The old `_readBridgeGetFlag` and `_mutationBridgeGetFlag` names have no matches. `npm run build` and `npx tsc --noEmit` pass after the deletion.

### F2: real production path and recovery

Remedy: `tests/index-2992-integration.test.ts` starts a real extension session, injects the stale context at the host `getFlag` boundary, records reads through the mounted bridge, and sends a later edit through the real `tool_call` handler. The edit result is unblocked, proving the real guard path allows the read-before-edit authorization.

The same test registers a second factory activation and starts a replacement session with `no-read-guard` set. The bridge drops the read while the flag is set, then records a fresh stale read after the flag is made stale. This pins recovery from the unset fallback.

### F3: call-site bounded records

Remedy: the real stress loop calls both bridges 100 times. The assertion observes two ledger rows, one for each distinct subject, with no per-call record storm. After reset, one stale read produces one fresh row.

Mutation red for the call-site proof, after compiling the mutation into `index.js`:

```text
AssertionError: expected undefined to be 2
at tests/index-2992-integration.test.ts:64:28
Tests: 1 failed
```

The mutation neutered the built recordDegradationOnce call. Rebuilding restored the production output, and the real test passed: Test Files 1 passed; Tests 1 passed.

Round-1 mutation reds remain part of the prior proof: base replay, direct-getter mutation, catch neutering, and fallback inversion each turned red; the consolidation preserves both bridge call sites and the exact stale-error predicate.
