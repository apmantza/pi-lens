# Pending runner store model

A TLA+ model of the deferred collect-later runner store
(`clients/dispatch/pending-runner-findings.ts`) across a same-process session
replacement. Every config here states its expected verdict on its first line,
and the `TLA+ models` CI job (`node scripts/check-tla-models.mjs`) checks them
all.

Issues: #3758 (the store's session fence) and #3813/#3824 (the turn-end cap's
requeue), #3814 (the commit gate's non-draining peek).

## What the model covers

- **The producer admission** (`deferRunnerFindings`). It fences with the
  generation it captured, so an entry enters only from a live scope or from a
  released writer with no captured handle (shape 57). The model keeps the
  producer's true generation separately from the generation the fence reads off
  the entry, so a requeue that lost `entry.session` is visible.
- **The turn-end drain** (`drainPendingRunnerFindings`). It removes the settled
  answers it admits, drops the settled ones its fence rejects, and keeps
  in-flight work for the store.
- **The commit gate's non-draining read** (`peekSettledRunnerFindings`, #3814).
  It applies the same owned-admission the drain does, without removing the
  entries; a fresh answer it filters out is a no-drop failure, and a retired one
  it returns is a stale admission.
- **The requeue** (`requeueRunnerFindings`, #3813). A drained, settled answer
  re-enters the store when the delivery cap cut it. It carries `entry.session`
  unless the `Requeue = "drop"` mutant loses it.
- **The window the fence defends.** A raw generation bump retires a scope with
  no store clear. `session_start` clears the store before it bumps the scope
  (`clients/runtime-session.ts` `resetPendingRunnerFindings` then
  `runtime.resetForSession`), so the model explores the gap before that clear
  that #3824's drain fence was written for.

## Invariants

- `NoStaleAdmission` (shape 54, safety): no reader admits an answer whose
  producer scope has retired.
- `NoDropFreshAnswer` (shape 54, no-drop): no reader drops an answer whose
  producer scope is live, or a released writer's unfenced answer.

## Configs

| Config | Expect | What it proves |
|---|---|---|
| `Shipped` | pass | Both readers fence, the requeue carries the owner, and a released writer's no-handle deferral is admitted. |
| `UnfencedPeek` | violated `NoStaleAdmission` | The pre-fix #3814 peek admitted a retired answer. |
| `UnfencedDrain` | violated `NoStaleAdmission` | The drain fence is load-bearing. |
| `OverDropPeek` | violated `NoDropFreshAnswer` | A peek that drops the live answer lets the commit through. |
| `OverDropDrain` | violated `NoDropFreshAnswer` | A drain that drops the live answer loses delivery. |
| `NoHandleDropped` | violated `NoDropFreshAnswer` | A released writer's no-handle deferral must not be fenced out. |
| `RequeueDropsOwner` | violated `NoStaleAdmission` | The requeue must carry `entry.session`; losing it makes a later retirement unable to reject the answer. |

## What the model cannot see

- Time. The drain's `maxWaitMs` and the freshness gate's mtime verdict are not
  modelled; a stale answer here means a retired producer scope, not an older
  file edit (`dropStaleRunnerFindings`).
- The store's 50-entry cap and its eviction record.
- The commit gate's own policy verdict (`clients/deferred-runner-blockers.ts`).

## Replay on the real code

`tests/clients/dispatch/runner-collect-later.test.ts` pins the store's own peek
admission and the requeue round-trip on both readers; the stale direction is
reproduced with a raw `GenerationSource` bump as #3824 does.
`tests/clients/deferred-runner-blockers.test.ts` drives the real
`evaluateGitGuard` over the store for the stale-reject and sole-fresh no-drop
directions. `tests/clients/turn-end-cap-consumed-state.test.ts` drives the real
`handleTurnEnd` cap cut, the delivery hold's `onHeld` requeue and the
successor's own turn end (M3c). `tests/clients/session-generation-properties.test.ts`
drives the production enqueue, drain, requeue and peek under a scheduler, with
the safety and no-drop directions and the no-handle arm.
