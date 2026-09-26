# Pid-file lock models (#3447)

TLA+ models of the path-based pid-file locks, and one candidate redesign. The
`TLA+ models` CI job model-checks every config here with TLC and compares the
verdict with the config's first line, so a config that documents a known bug
expects the violation:

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
  #3476 (`Bounded*.cfg` other than `BoundedCrash.cfg`), guarding
  `commitDurableStore`.

Each acquisition creates a new file. The exclusive create and the pid write
are separate steps unless `AtomicCreate`. Stale takeover and release act on
whatever file the path names at that moment.

**`GenerationLock.tla`** is the redesign from #3476. The lock is a series of
files `lock.1`, `lock.2`, … Every acquisition, including a stale takeover, is
an exclusive create of the next generation, so nothing is removed by path.
`clients/generation-lock.ts` implements it, and the registry lock
(`RegistryCrash.cfg`) and the bounded lock (`BoundedCrash.cfg`) use it since
#3476. `ListedMarker = TRUE` judges as that code does:
the released marker is read from the listing, and a generation file that is
gone reads as held. The code creates a generation with `wx` rather than
linking a written temp file (hard links fail on FAT/exFAT); a judge that reads
it before its pid is written holds it live until it ages out, which only
makes `Free` false in more states than the model's atomic create.

## Invariants

- `MutualExclusion`: at most one live process is inside the critical section.
- `NoLostRegistration`: an update the writer saw committed is still there.
- `NoOrphanLock`: a fresh lock belongs to a live owner that will release it.

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
| `BoundedCrash.cfg` | one writer dies | pass on the generation lock (#3476); `MutualExclusion` violated on the path lock before |
| `GenerationNoFault.cfg` | none | pass |
| `GenerationCrash.cfg` | one writer dies, two rounds each | pass |
| `GenerationCrash4.cfg` | four writers, two die | pass |
| `GenerationNoRecheck.cfg` | crash, no second listing | `MutualExclusion` violated |
| `GenerationExpiry.cfg` | a holder outlives the threshold | `MutualExclusion` violated (the lease) |

Three results matter most:

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
  the judged one) only narrows the crash race, and it is the quarantine lock's
  current shape. The generation lock closes it in the model. The post-create
  listing is required: without it, a stale listing re-creates a name cleanup
  removed.

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
- the quarantine lock itself, whose restore has the shape of
  `RegistryCrashFix.cfg`;
- writers from before #3476 running beside current ones. A registry or
  bounded generation holder also holds the old `.lock` file so they block
  each other, and a stale one keeps the old path takeover race against an
  older writer.
