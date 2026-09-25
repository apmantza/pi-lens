# Instance-registry lock model (#3447 spike)

A TLA+ model of `clients/instance-registry-lock.ts`, which guards the
read-modify-write in `clients/instance-registry.ts` (`writeRegistryWithRetry`).
TLC checks the model; `repro-double-takeover.mjs` replays its counterexample
against the real lock code.

## What the model covers

- **Acquire:** `writeFile(lock, …, {flag: "wx"})`, which opens the file
  exclusively and then writes the pid, as two steps.
- **Stale check:** the lock file is older than 5 s (`Expire`), or the pid it
  names is dead (`Crash`). An empty file only goes stale by age.
- **Takeover:** `renameSync(lock, displaced)`, which moves whatever the path
  names at that moment.
- **Critical section:** read the registry, write it, re-read to verify, up to
  three times.
- **Release:** read the owner pid at the path, then unlink the path.

Out of scope:
- The sync variant, which uses the same steps.
- Backoff timing: any retry may give up (`GiveUp`, the 500 ms deadline).
- pid reuse.

## Invariants

- `MutualExclusion`: at most one live process is inside the critical section.
- `NoLostRegistration`: a registration whose verify re-read saw it is still in
  the registry.
- `NoOrphanLock`: a fresh lock at the path belongs to a live owner that still
  holds it, so it will be released.

## Results

TLC 2.19 (release v1.7.4), three writers unless noted.

| Config | Faults | Verdict |
|---|---|---|
| `NoFault.cfg` | none | all invariants hold (74 states) |
| `Crash.cfg` | one writer dies | `MutualExclusion` violated |
| `Expiry.cfg` | a live holder outlives 5 s | `MutualExclusion` violated |
| `CrashFix.cfg` | one writer dies, with an identity-checked takeover | `NoOrphanLock` violated |
| `CrashFix4.cfg` | as `CrashFix.cfg`, four writers | `MutualExclusion` violated |

With `MutualExclusion` removed from the checked set, `Crash.cfg` and
`Expiry.cfg` also violate `NoLostRegistration`. The verify re-read in
`writeRegistryWithRetry` does not catch it, because the other writer's
overwrite lands after the verify. The heartbeat re-registration from #3453 is
what repairs it.

**`NoFault.cfg` confirms #3450.** Without a crash or lease expiry, exclusion
holds, including the window where the lock file exists but its pid is not yet
written. The model is not vacuous: allowing the `wx` create on an occupied
path makes `NoFault.cfg` fail `MutualExclusion` in 33 states.

**`Crash.cfg` is a double takeover.** Its counterexample:

1. p1 takes the lock and dies inside the critical section.
2. p2 and p3 both judge p1's lock stale (dead pid).
3. p2 renames it away, creates its own lock, and enters.
4. p3's rename, based on its earlier judgement, moves p2's live lock away.
5. p3 creates its own lock and enters. p2 and p3 are both inside.

`repro-double-takeover.mjs` runs this against the compiled lock code. It
delays p3's `renameSync` until p2, a real child process, is inside. It changes
no logic:

```text
$ node formal/instance-registry-lock/repro-double-takeover.mjs
p3: p2 is in its critical section; lock now reads "23804 1790370894347" (p2 pid)
p3: in critical section (pid 23796); p2 still inside: true
p3: MUTUAL EXCLUSION VIOLATED
p2: p2 ran
```

**`Expiry.cfg` is the lease by design.** A holder descheduled for more than
5 s loses the lock to a taker while still inside. #3450 measured a 258 ms
worst case under load.

**The obvious fix does not close the crash case.** In the candidate, the
taker reads the displaced file and, if it is not the lock it judged stale,
restores it with `linkSync` (which fails if the path is taken). TLC finds two
problems:
- **Three writers:** the victim releases while its lock is displaced, finds
  the path empty, and skips the unlink. The taker then restores it: a fresh
  lock with a live owner that will never release it, blocking every writer
  until it ages out after 5 s.
- **Four writers:** a fourth writer creates a lock in the window between the
  rename and the restore. The restore fails, and two processes are inside.

The root cause: Node has no atomic "remove this path only if it is still this
file". So any takeover that removes the stale lock by path keeps this race;
checks after the rename only narrow it.

## Running

```sh
curl -sSLO https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
echo "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88  tla2tools.jar" | sha256sum -c
java -cp tla2tools.jar tlc2.TLC -workers auto -config Crash.cfg InstanceRegistryLock
```

Run from this directory. Each config checks in under a second.
