# Collect-later flight model

A TLA+ model of the collect-later run in flight for one (project, runner) key
(`clients/dispatch/collect-later-tier.ts` `runCollectLater`, #5413). Every
config states its expected verdict on its first line, and the `TLA+ models` CI
job (`node scripts/check-tla-models.mjs`) checks them all.

## What the model covers

- **A write** (`runGroup`'s collect-later branch). With no flight it starts a
  run and claims the key; with a flight it owes one rerun for its file, and a
  later write to the same file replaces the owed version.
- **A settle** (`drainQueue`). Success, failure, timeout and abort are one
  transition: the run's answer covers its version, and the continuation starts
  the next owed rerun or releases the key, only while its flight still owns
  the key.
- **A session reset** (`resetObservedRunnerLatency`). It drops the claim and
  the owed reruns; runs already started keep running and settle into nothing.

## Invariants

- `AtMostOneInFlight`: at most one current-session run of the key is in
  flight.
- `NoLostWrite` (shape 70): once the current session's flight is idle, every
  file's latest write is covered by a run that started after it.

## Configs

| Config | Expect | What it proves |
|---|---|---|
| `Shipped` | pass | One run in flight, one rerun owed per file, an identity-checked continuation. |
| `Parallel` | violated `AtMostOneInFlight` | Pre-#5413: a run per write. |
| `JoinRunning` | violated `NoLostWrite` | The rival join: a write that shares the running run never has its bytes covered. |
| `NoIdentity` | violated `AtMostOneInFlight` | A pre-reset run that releases the new session's claim lets a second run start. |

## What the model cannot see

- Time, the runner budget, and the child that outlives a budget lapse (#5097).
- The pending store's delivery and freshness gate
  (`formal/pending-runner-store/`).
- The spawn-timeout cooldown, which skips a cooled runner before it runs.
