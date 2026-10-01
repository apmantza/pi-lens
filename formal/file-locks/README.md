# Pid-file lock models (#3447)

TLA+ models of the path-based pid-file locks and of the generation lock that
replaced them. The `TLA+ models` CI job model-checks every config here with
TLC and compares the verdict with the config's first line, so a config that
documents a known bug expects the violation:

```text
\* expect: violated MutualExclusion
\* module: FileLock
```

When a fix lands, its config changes to `\* expect: pass` in the same PR. Run
the check locally with `node scripts/check-tla-models.mjs`: it downloads the
pinned `tla2tools.jar` to `.cache/` and verifies its sha256. It needs Java.

## Models

**`FileLock.tla`** covers both locks that create a pid file with `wx`:
- `clients/instance-registry-lock.ts` before #3476 (`Registry*.cfg` other
  than `RegistryCrash.cfg`), guarding the registry read-modify-write in
  `clients/instance-registry.ts`;
- `acquireBoundedPidFileLock` in `clients/bounded-pid-file-lock.ts` before
  #3476 (`Bounded*.cfg`), guarding `commitDurableStore`.

Each acquisition creates a new file. The exclusive create and the pid write
are separate steps unless `AtomicCreate`. Stale takeover and release act on
whatever file the path names at that moment.

**`GenerationLock.tla`** is the generation lock shipped by #3476 and used by
the registry, bounded, quarantine and installer locks since then. The lock is
a series of files `lock.1`, `lock.2`, … Every acquisition, including a stale
takeover, is an exclusive create of the next generation, so nothing is removed
by path. `clients/generation-lock.ts` implements it. The four locks differ in their
lease and their #3515 defenses: the installer lock has the heartbeat and the
`assertOwnsLock` re-check, the quarantine lock has the heartbeat but no
re-check, the bounded lock is synchronous with a 5 s lease and neither, and
the registry lock has neither. The model does not distinguish the lease, so
`RegistryCrash.cfg` and `RegistryCrash4.cfg` cover the plain generation
behaviour. A `BoundedCrash.cfg` that ran the same module with the same
constants was dropped for that reason; before #3476 it ran `FileLock` and
violated `MutualExclusion`, as `RegistryCrash.cfg` did. `ListedMarker = TRUE` judges as
that code does: the released marker is read from the listing, and a generation
file that is gone reads as held. The code creates a generation with `wx`
rather than linking a written temp file (hard links fail on FAT/exFAT); a
judge that reads it before its pid is written holds it live until it ages out,
which only makes `Free` false in more states than the model's atomic create.

**`GenerationHeartbeat*.cfg`, `GenerationHeartbeatStall*.cfg` and
`GenerationExpiry.cfg`** model #3515's install-lock lease. The installer lease
is the install timeout plus 60 s slack (180 s by default), shorter than
`installNpmTool`'s two 120 s attempts inside one hold, so #3553 added two
independent defenses in `clients/generation-lock.ts`:
`startGenerationHeartbeat` (an unref'd `setInterval` touching the held
generation's mtime every `heartbeatIntervalMs(lease) = lease/4`), and
`ownsTopGeneration` (true only while the hold is still the live top
generation), read as `assertOwnsLock` in `clients/installer/index.ts` before
each `runInstallAttempt` spawn. The quarantine lock's async holder gets the
same heartbeat but no ownership re-check
(`clients/bounded-pid-file-lock.ts`), so it has the
`GenerationHeartbeatStallNoCheck` shape once its own lease lapses. In the
model `Heartbeat` rides the renewal, `HeartbeatStall` is the stall in which
the renewal fails to land long enough for the lease to lapse (the interval is
`lease/4`, so a single miss is not enough; TLC has no clock and collapses the
consecutive misses into the flag), and `OwnsTop` gates the re-check before
`CsWrite`. A renewal that lands keeps a live holder fresh, so without a stall
`Expire` never fires.

The re-check gates only `CsWrite`, so under a stall it protects
`NoLostRegistration`, not `MutualExclusion`: a superseded holder can still be
in `cs_read` when the taker enters. `GenerationHeartbeatStall.cfg` records the
`NoLiveTakeover` residual, `GenerationHeartbeatStallReadOverlap.cfg` surfaces
the `MutualExclusion` overlap, and `GenerationHeartbeatStallNoCheck.cfg` is
the no-drop witness that `OwnsTop = FALSE` loses a committed registration. The
re-check is a point in time before the spawn; the spawn then runs for up to
120 s, so a taker landing during the spawn is not detected. That read-side
takeover is real code behaviour: `tryAcquireGeneration` judges a live holder
stale on its `mtime`, and `assertOwnsLock` runs only before a spawn, so a
superseded holder already inside `runInstallAttempt` overlaps the taker
(residual on #3553, review round 1 F5). `GenerationHeartbeatNoStall.cfg` is
the heartbeat-landing pass, and `GenerationExpiry.cfg` is the pre-#3515 shape
with neither defense. `GenerationHeartbeatStallFullSize.cfg` runs the Stall
shape with the re-check on at MaxGen = 5, Rounds = 2 with the two processes
the F1 counterexample needs; three processes at that size exceed the
model-check budget, which is why the three-process Stall family runs at
MaxGen = 4, Rounds = 1.

While the pre-#3476 lock files are also taken (#3489), the bounded lock's
generation carries a 5 s lease and no heartbeat, so a live bounded holder's
generation IS superseded past 5 s; the contender then finds the same live pid
holding the pre-#3476 bridge file and backs off there, so the holder is not
displaced while the bridge exists. The model's `AllowExpiry` applies to it
fully only once that bridge is removed.

## Invariants

- `MutualExclusion`: at most one live process is inside the critical section.
- `NoLostRegistration`: an update the writer saw committed is still there.
- `NoOrphanLock`: a fresh lock belongs to a live owner that will release it.
- `NoLiveTakeover`: a live owner's unreleased generation is never judged
  stale, so a contender can never supersede a live holder. The lease
  (`AllowExpiry`) is the only way that judgement can be reached, so the
  heartbeat that keeps the lease from lapsing is what makes this hold; a
  stalled interval breaks it, and the ownership re-check then protects
  `NoLostRegistration` instead.

## Results

| Config | Faults | Verdict |
|---|---|---|
| `RegistryNoFault.cfg` | none | pass |
| `RegistryCrash.cfg` | one writer dies | pass on the generation lock (#3476); `MutualExclusion` violated on the path lock before |
| `RegistryCrash4.cfg` | the generation lock, four writers, two die | pass |
| `RegistryCrashNoRecheck.cfg` | the generation lock, no second listing | `MutualExclusion` violated |
| `RegistryExpiry.cfg` | a holder outlives 5 s | `MutualExclusion` violated (the lease) |
| `RegistryCrashFix.cfg` | crash, identity-checked takeover | `NoOrphanLock` violated |
| `RegistryCrashFix4.cfg` | the same, four writers | `MutualExclusion` violated |
| `BoundedNoFault.cfg` | none | pass (fixed in #3475; `MutualExclusion` violated before) |
| `BoundedLinkedNoFault.cfg` | none, lock linked from a written temp file | pass (the alternative #3475 considered) |
| `GenerationNoFault.cfg` | none | pass |
| `GenerationCrash.cfg` | one writer dies, two rounds each | pass |
| `GenerationCrash4.cfg` | four writers, two die | pass |
| `GenerationNoRecheck.cfg` | crash, no second listing | `MutualExclusion` violated |
| `GenerationExpiry.cfg` | no heartbeat, no re-check, lease shorter than the hold | `NoLiveTakeover` violated |
| `GenerationHeartbeat.cfg` | heartbeat wired through a stall, re-check on | pass (reaches `Expire` and `HeartbeatTick`) |
| `GenerationHeartbeatNoStall.cfg` | every heartbeat interval lands | pass |
| `GenerationHeartbeatStall.cfg` | stalled heartbeat, re-check on | `NoLiveTakeover` violated |
| `GenerationHeartbeatStallReadOverlap.cfg` | stalled heartbeat, re-check on, `MutualExclusion` only | `MutualExclusion` violated |
| `GenerationHeartbeatStallFullSize.cfg` | stalled heartbeat, re-check on, full size (2 processes) | pass |
| `GenerationHeartbeatStallFullSizeNoCheck.cfg` | the same, re-check off | `NoLostRegistration` violated |
| `GenerationHeartbeatStallNoCheck.cfg` | stalled heartbeat, re-check off | `NoLostRegistration` violated |

Four results matter most:

- **The registry lock** holds without faults, including the window where its
  file exists but has no pid yet (#3450). With a crash, two takers of the dead
  owner's lock can each remove what the path names, and both enter.
- **The bounded lock** failed with no crash at all: an empty file parsed to
  `NaN`, which read as a dead owner, so a contender unlinked a live lock.
  #3475 fixed it: a lock with no parseable pid is live until its mtime is
  5 s old, as the registry lock already read it. Linking a fully written
  temp file into place also passes, but hard links fail on FAT/exFAT and
  some network shares.
- **The identity-checked takeover** (restore the displaced file if it was not
  the judged one) only narrows the crash race, and it was the quarantine
  lock's shape before #3476. The generation lock closes it in the model.
  The post-create listing is required: without it, a stale listing
  re-creates a name cleanup removed.
- **The install heartbeat** is two independent defenses, and the re-check
  protects a narrower property than the original claim. A stalled heartbeat
  lets the lease lapse under a live holder, so
  `GenerationHeartbeatStall.cfg` violates `NoLiveTakeover` and a contender
  takes over. The ownership re-check then keeps the superseded holder out of
  its critical write: `GenerationHeartbeat.cfg` reaches `Expire` and
  `HeartbeatTick` and still passes `NoLostRegistration`, while
  `GenerationHeartbeatStallNoCheck.cfg` drops a committed registration. The
  full-size pass holds the same property at MaxGen = 5, Rounds = 2
  (`GenerationHeartbeatStallFullSize.cfg`), and its no-check twin drops the
  registration (`GenerationHeartbeatStallFullSizeNoCheck.cfg`). The re-check
  does not restore `MutualExclusion`, because it gates only `CsWrite`; a
  superseded reader still overlaps the taker, and
  `GenerationHeartbeatStallReadOverlap.cfg` surfaces that (review round 1,
  F1). The check is a point in time, and the spawn it guards runs for up to
  120 s afterwards, so a taker landing during the spawn is not covered
  (review round 1, F5; residual on #3553).

The model is not passing vacuously: letting the `wx` create succeed on an
occupied path makes `RegistryNoFault.cfg` violate `MutualExclusion`.

## Repros on the real code

Run from the repository root after `npm run build`. Each script delays one
step to force the interleaving TLC found; neither changes the lock's logic.

```text
$ node formal/file-locks/repro-registry-double-takeover.mjs   # before #3476
p3: p2 is in its critical section; lock now reads "23804 1790370894347" (p2 pid)
p3: in critical section (pid 23796); p2 still inside: true
p3: MUTUAL EXCLUSION VIOLATED

$ node formal/file-locks/repro-bounded-empty-window.mjs   # before #3475
B: A's lock exists, content: ""
B: acquired
B: A entered while B held the lock: MUTUAL EXCLUSION VIOLATED

$ node formal/file-locks/repro-bounded-empty-window.mjs   # after #3475
B: A's lock exists, content: ""
B: acquired
B: exclusive
```

Since #3476 the registry lock has no rename for the first script to hold, so
it no longer reaches the race. `tests/clients/instance-registry-lock.test.ts`
replays the same interleaving on any lock layout by holding the stale
judgement's liveness probe (`admits one of two takers of a dead owner's lock`).

## Scope

Not modelled:
- backoff timing (any retry may give up, as the wait deadline does);
- pid reuse;
- the quarantine lock before #3476, whose restore had the shape of
  `RegistryCrashFix.cfg`;
- writers from before #3476 running beside current ones. A registry,
  bounded or quarantine generation holder also holds the old `.lock` file
  (a directory for the quarantine lock) so they block each other, and a
  stale one keeps the old path takeover race against an older writer.
