# Disk-change publisher model

A TLA+ model of the disk-change publisher: the out-of-band look that finds a
dependency install or a declaration file changed outside pi-lens
(`clients/out-of-band-changes.ts`, #4476, #4532), the process-wide publisher
that allocates the project sequence and fans one `DiskChange` out
(`clients/disk-changes.ts`, #4535), and its subscribers
(`clients/disk-change-subscribers.ts`). The `TLA+ models` CI job
(`node scripts/check-tla-models.mjs`) checks every config here against its
`\* expect:` line.

Issue: #5334. The module is `DiskChangePublisher.tla`.

## What the model covers

One abstract disk per root: `dInst`, the install stamp (lockfiles, install
markers, venv `site-packages`, server config files: a change nobody can
enumerate), and `dDecl`, the declaration set (a change the walk enumerates).
An external change bumps one of them. `vInst`/`vDecl` are what the root's
servers have been told: the baseline of the root's first-ever look, moved on by
every publish.

| Model action | Code |
|---|---|
| `LookCall` mode `call`: a tool_call look, walk by interval only | `clients/runtime-tool-call.ts:638` `resyncHeadMove` -> `clients/runtime-tool-result.ts:328` |
| mode `result`: a bash result owes a walk | `clients/runtime-tool-result.ts:2943` `resyncHeadMove`; `oweDeclarationWalk` (`clients/out-of-band-changes.ts:181`), `demandsWalk` (`:195`) |
| mode `client`: a live client root's look names `since`, walk `"interval"`, no runtime | `clients/runtime-tool-result.ts:2979` (`since`, `walk: "interval"` at `:2993`) |
| mode `diag`: the `lsp_diagnostics` body, walk `"always"` | `tools/lsp-diagnostics.ts:631` |
| mode `head` + `HeadLook`: the HEAD look owes its walk at the call, then looks after the per-key queue | `clients/runtime-tool-result.ts:313` `resyncHeadMove` (`oweDeclarationWalk` at `:325`, the look at `:328`) |
| `Dispatch`: join the running flight (one trailing pass, the first caller's closure) or start one | `looks = createSingleFlight({ coalesceTrailing: true })` (`clients/out-of-band-changes.ts:155`), `looks.run` (`:709`) |
| `Begin`: take the owed walk, read the record, decide `walkDue` (sync) | `lookOnce` `owedWalks.delete` (`:783`), `records.get` (`:785`), `walkDue` (`:786`) |
| `Read`: the install stamp and the declaration walk (the await) | `lookOnce` `Promise.all([readInstallStamp, walkDeclarations])` |
| `Commit`: commit the record, diff, decide to publish; a first look compares the install to the epoch the caller named (`ep`, captured at the call) | `records.set` (`:814`), `installed` (`:853`), `firstLookSawInstall(install, options.since)` (`:855`), the first-look return (`:857`) |
| `Alloc`: the project sequence, only for an enumerable population and only with a runtime | `clients/disk-changes.ts:443` `allocateSequence` (called at `:275`) |
| `FanOk`/`FanThrow`: each registered subscriber in order, isolated | `clients/disk-changes.ts:463` `fanOut`; `clients/disk-change-subscribers.ts:520` registers `diagnostics-cache`, then `lsp` |
| `PubDone`/`Next`: `lookOnce` awaits the publish; the chain loop runs the trailing pass | `await publishDiskChange` (`clients/out-of-band-changes.ts:872`); `clients/single-flight.ts` `chain` |
| FIFO eviction of `records` and `owedWalks` | `BoundedFifoMap(MAX_ROOTS)` (`clients/out-of-band-changes.ts:147`, `:171`; `MAX_ROOTS = 64` at `:130`) |
| Two sessions on one root | two callers of `Dispatch`: the records, the owed set and the flights are module-level, so they share all three |

`RecCap` and `OwedCap` stand in for `MAX_ROOTS = 64`; an eviction needs more
roots than the cap, so two roots and a cap of one is the whole B2a space.

## Invariants

I1 to I5 are the prose in `clients/disk-changes.ts` (the module comment,
"Invariants (audit section 3.3)") and `clients/out-of-band-changes.ts:870`
(`// I1: the per-root record is committed above, before any consumer runs.`):

| Prose | TLA+ invariant |
|---|---|
| I1: the detector commits its own per-root record BEFORE publishing | `I1CommitBeforePublish`: while a publish is allocated or fanned out, the root's record is the pass's own, or evicted |
| I2: the sequence is allocated BEFORE the fan-out, so one `seq` and one `at` describe the same event for every consumer | `I2SeqBeforeFanOut`: every delivery saw the sequence its publish allocated, and none came first |
| I3: the caller owns the await: the publisher awaits its subscribers | `I3AwaitedFanOut`: a settled flight has no fan-out still running |
| I4: the publisher writes the sequence and the change log only; an incoming change never credits authorship (#4131) and moves no FileTime (#3865) | `I4NoAuthorship`: the authorship credit equals the agent's edits |
| I5: a throwing subscriber is isolated and recorded once per consumer per root per session | `I5Isolated` (every consumer of a finished fan-out ran) and `I5RecordedOnce` |

Three more invariants:

- `OneRestartPerInstall`: "two sessions' looks after one install restart
  once" (the `looks` comment, `clients/out-of-band-changes.ts:151`). It holds
  while the record survives; `EvictedInstallTrailing` is the schedule where an
  eviction breaks it (B2b). `OneFreshRestartPerInstall` is the same count for
  passes that started as a fresh flight (not a trailing pass): the eviction
  config `EvictedInstallSince` checks it, so the first-look epoch filter is
  still proven never to republish an install the client already read.
- `DemandServed`: #4532 gap 6, "a joined look gets the walk it demands"
  (the `owedWalks` comment).
- `NoLostChange` is the model's own property, not a promise a comment makes.
  Once the servers have been told a view (`vInst`, `vDecl`) that differs from
  the disk, the root's record must still show the difference, or the record is
  gone and the next look names the live server's epoch (`NextLookNamesEpoch`).
  The module comment at `clients/out-of-band-changes.ts:36` ("They describe the
  disk, not a session, so a session boundary keeps them") is about session
  boundaries, which the model does not have, so it is not the source of this
  property. Eviction is the cost: `MAX_ROOTS` (`clients/out-of-band-changes.ts:129-130`)
  drops the oldest root's record, and that root's next look is a first look
  that changes nothing (`:857`). This is the invariant B2a violates.

I1 to I4 are structural: the as-built model satisfies them by the order of its
steps, and each has a mutant config that reorders the step and goes red. They
check the model against the comment; the code-side enforcement is the existing
tests named in `formal/switch-pins.json`.

## Results

| Config | Verdict |
|---|---|
| `AsBuilt`, `AsBuiltWide`, `TwoSessions`, `ThrowingSubscriber`, `ThreeRoots` | pass, all invariants (no eviction pressure: the record cap is at least the number of roots) |
| `OwedEvictionKeepsChanges` | pass: an evicted owed walk loses no change |
| `EvictedInstallSince` | pass (`OneFreshRestartPerInstall` in place of `OneRestartPerInstall`, which `EvictedInstallTrailing` owns): an install after a record eviction is published when the first look names the live client's spawn epoch |
| `EvictedInstallTrailing` | violated `OneRestartPerInstall` (**B2b**, a real defect, reproduced on the code: see below) |
| `B2aEvictedInstall` | violated `NoLostChange` (**B2a**, install: the accepted p3 residual) |
| `B2aEvictedDeclaration` | violated `NoLostChange` (**B2a**, declaration: the epoch does not rescue it) |
| `OwedEvictedDeferred` | violated `DemandServed` (admitted: an evicted owed walk defers the change to the next walk) |
| `MutCommitAfterPublish` | violated `I1CommitBeforePublish` |
| `MutFanOutBeforeAlloc` | violated `I2SeqBeforeFanOut` |
| `MutFanOutDetached` | violated `I3AwaitedFanOut` |
| `MutPublishCreditsAuthorship` | violated `I4NoAuthorship` |
| `MutThrowAborts` | violated `I5Isolated` |
| `MutRecordEveryThrow` | violated `I5RecordedOnce` |
| `MutTrailingFromStartRecord` | violated `OneRestartPerInstall` |
| `MutJoinWritesNoDemand` | violated `DemandServed` (#4532 gap 6 before its fix) |

### B2a (expected fail, accepted p3)

`B2aEvictedInstall` and `B2aEvictedDeclaration` are expected-fail configs, not
a bug the model found. The 2026-11-04 probe reproduced a change lost after the
64-entry FIFO evicts a root record. The model shows the shape, the trace
below, and the real code reproduces it (`lookForOutOfBandChanges` over 65
temp roots: the 65th first look evicts root 0, an install there is recorded as
a baseline and never published; with 64 roots it is published).

```
 2 LookCall   a: first look starts (Read)
 3 LookCall   b: first look starts (Read)
 4 Read       a reads the disk
 5 ExtInst    an install lands on a            dInst = [a=1, b=0]
 6 Commit     a records (i0,d0), told (0,0)    fifo = <<"a">>
 7 Read       b reads the disk
 8 Commit     b records; the FIFO (RecCap 1) evicts a   recs[a] = none, fifo = <<"b">>
```

State 8 violates `NoLostChange`: the servers hold install version 0, the disk
holds 1, and the record that would show the difference is gone. a's next look
is a first look, which records version 1 as the baseline and publishes nothing
(`clients/out-of-band-changes.ts:857`, the first look "records and changes
nothing unless the caller names the epoch"). A client-root look that names
`since` publishes the install (`EvictedInstallSince` passes), but a first look
has no previous declaration map to diff, so a declaration change is lost
whoever calls (`B2aEvictedDeclaration`).

The trigger is one process touching more than `MAX_ROOTS` (64) roots between
two looks of one root. Nobody has shown it, so it stays an accepted p3: the
configs document it and the runtime is unchanged.

### B2b (expected fail, a real defect, not fixed here)

Greptile r1 (PRRT_kwDORt8rec60hc_X) found that the first model compared a
first look's install with `vInst`, which moves on after a publish, while the
code compares it with the caller's fixed `options.since`. They differ on a
trailing pass: `createSingleFlight` re-runs the first caller's own closure
(`clients/single-flight.ts:212`, `result = await fn()`), and that closure
passes the original `options` (`clients/out-of-band-changes.ts:709-710`,
`lookOnce(root, key, trigger, runtime, options, homeRoot)`). So the trailing
pass names the epoch the live client had BEFORE the first pass restarted it.
If the record is gone by then, the trailing pass is a first look
(`prior === undefined`, `:854`) and `firstLookSawInstall(install,
options.since)` (`:855`) says the install is fresher than that old epoch, so
the same install publishes twice and restarts the clients twice. The model now
keeps `ep`, the epoch captured at the call, apart from `vInst`;
`EvictedInstallTrailing` then violates `OneRestartPerInstall`:

```
 1 Init
 2 ExtInst    an install lands on a                         dInst = [a=1, b=0]
 3-5 LookCall a: client look, ep = 0 (the epoch it names)
             a: a second caller joins the flight (earns one trailing pass)
             b: client look                                RecCap = 1
 6 Read       a reads install 1
 7 Commit     a: first look, 1 > ep 0, so it publishes     restarts[a][1] = 1
              a: recs[a] = (1,0), fifo = <<"a">>
 8-11 Alloc, FanOk, FanOk, PubDone   the publish completes
12 Read       b reads the disk
13 Commit     b records; the FIFO evicts a                 recs[a] = none
14 Next       a: the trailing pass starts, prior = none, ep is still 0
15 Read       a reads install 1
16 Commit     a: first look again, 1 > ep 0, publishes     restarts[a][1] = 2
```

State 16 violates `OneRestartPerInstall`. The real code reproduces it
(throwaway probe, not in the repo, built `clients/`): a subscriber of the real
publisher joins root A's flight with a second `lookForOutOfBandChanges` call,
then awaits first looks of N other temp roots while A's publish is held open (A recorded first, in a fresh process);
A names `since` 60 s old and has a `package-lock.json`. Publishes of A's
install, counted by the subscriber: N = 1 gives 1, N = 63 gives 1, N = 64
gives 2. A fresh look after the restart names the new spawn epoch
(`entry.spawnedAt`, `clients/runtime-tool-result.ts:2992`) and does not
republish (`EvictedInstallSince` passes, with a third call that is a fresh
look).

The precondition is B2a's: a saturated FIFO, that is a process that has
recorded 64 roots with this root the oldest. Then ONE new root's first look
inside the window of the root's publish (the restart can take seconds) evicts
it. A probe in one process (A recorded first, then F other roots, then an
install at A, a held publish, a joined call, M new first looks in the window)
gave: F = 62, M = 1 gives 1 publish; F = 63, M = 0 gives 1; F = 63, M = 1
gives 2. So it is not "64 roots inside the window": every new root evicts the
head once the FIFO is full. Nobody has shown a process that records 64 roots.
The runtime is unchanged here; the defect is an accepted p3 residual (live 0
observed), not filed, and the config documents it. A fix is outside this PR: the trailing
pass would have to carry the epoch the first pass left (the spawn epoch of the
restarted client), or skip the first-look branch when the flight published.

## Scope

Not modelled:

- the content of a change: a root's disk is two counters, so the diff of a
  stamp or of the declaration map is "differs";
- the walk's caps (`DECLARATION_WALK_MAX_DIRS`, `_MAX_FILES`), unreadable
  directories and files (#4596, #4603), the home-root skip (#4905): all of them
  keep the previous record or skip a walk, none moves a record past a change;
- `config` file changes and a Python venv's `site-packages` stamp: they fold
  into `dInst` (an unenumerable population, `paths: "unknown"`);
- time: the walk interval is a free choice on a pass with a record and no owed
  walk, and the `walkedAt` bookkeeping is not kept;
- the abort signal (`untilAborted` ends a caller's wait, never the flight);
- the HEAD baseline (`observeGitHead`, per session key) and the head-move
  publish itself: only its look is modelled, as a caller of the out-of-band
  look. The other four origins (`bash-recovery`, `settled-sweep`,
  `drift-heartbeat`, `head-move`) publish through the same `publishDiskChange`
  that `Alloc` and `FanOk` model, but the model keeps no per-origin policy;
- the subscribers' effects (the cache clock, the client restart, the
  watched-files events): a delivery is a record of what the subscriber saw;
- session boundaries: the records, the owed set and the degradation ledger are
  kept across a session (the module comment), and the model has one session
  lifetime, so "once per consumer per root per session" is "once per run";
- a publish that throws: `publishDiskChange` never throws for a subscriber
  or an append failure, and nothing else in the path is known to;
- a subscriber added or removed while a publish runs: `fanOut` iterates a
  snapshot taken at publish start (`clients/disk-changes.ts:468-470`), so one
  publish reaches the subscribers it started with. The model fixes `Subs` for
  the whole run and never changes it mid-fan-out;
- hypothesis H1, not built: the model's `Next` step is atomic, but the real
  single-flight loop (`clients/single-flight.ts:210`, `while
  (flight.rerunRequested)`) exits, and the key is released (`:227`), a
  microtask later. A joiner that sets the rerun bit in that gap sets it on a
  flight that will not run again, so its trailing pass is dropped. The
  joiner's owed walk stays in `owedWalks`, so the next pass serves it: the
  walk is deferred, not lost. No production caller is shown to land in the
  gap. A hand-shaped microtask probe on the real `createSingleFlight` drops the
  pass at one hop (review r1, not in the repo). The cost to model is one more
  flight state and a timing-free arm that may drop the bit. The default is no
  mechanism; the maintainer decides whether to record it as a residual.

## Known abstractions

These differ from the code. The runtime and installs items do not change what
an invariant checks: I2 relates each delivery to the sequence its own publish
allocated, and the restart invariants count restarts. The epoch item is the
one B2b leans on, which is why B2b is also reproduced on the real code.

- Epoch. `ep` is the install version a `client` look finds the servers
  holding when it is called (`vInst[r]`); the code names the client's spawn
  time (`entry.spawnedAt`) and compares it with the install's newest mtime
  (`firstLookSawInstall`, `>=` with a one-second slack). The model reads
  `install fresher than the epoch` as `oi > ep`. The slack is not modelled.
- Runtime. The model gives `diag` a runtime (`rt` is `mode /= "client"`), but
  `tools/lsp-diagnostics.ts:631` passes none, so that look allocates no
  sequence. The model gives `client` no runtime, but
  `clients/runtime-tool-result.ts:2988-2990` passes one to a session
  bookkeeping root (`isSessionBookkeepingRoot`).
- Installs. `Commit` sets `enum |-> ~installed` (`formal/disk-change-publisher/DiskChangePublisher.tla:288`),
  so `Alloc` treats any pass with an install as unenumerable.
  The code's `paths` (`clients/out-of-band-changes.ts:759-765`) lists the
  declaration changes whenever there are any and no config change, so a pass
  with an install and a declaration change allocates a sequence
  (`clients/disk-changes.ts:275`). An install alone is `"unknown"`, which
  allocates none (`clients/disk-changes.ts:272`), as modelled.
