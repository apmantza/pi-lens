# Session lifecycle: instance-registry model (#3498)

A TLA+ model of one pi process's `instances.json` entry across a session
replacement, against the heartbeat's re-registration (#3447). Every config
states its expected verdict on its first line (see `formal/file-locks/README.md`);
the `TLA+ models` CI job checks them all.

## What the model covers

- **Two sessions in one process.** Session 1 serves root `A`; after its
  `session_shutdown`, session 2 serves root `B`. pi's `switchSession` rebuilds
  the runtime with the resumed session's cwd, and the registry tail and intent
  are process singletons, so they carry over.
- **`session_start`**: `void registerInstance(cwd)` (`index.ts`), queued on the
  process-wide tail (`queueRegistryMutation`). `registerInstanceNow` sets the
  intent before it takes the lock, then merges the root into the entry under
  the async lock.
- **`session_shutdown`**: `deregisterInstance()` (`index.ts`). It clears the
  intent, then removes the entry under a sync lock that bypasses the tail. The
  lock is not re-entrant (`generation-lock.ts` `tryAcquireGeneration`), and the
  sync wait uses `Atomics.wait`, which blocks the event loop. So if this
  process's own async op holds the lock, the holder cannot release it, and
  after 500 ms the sync removal gives up.
- **The heartbeat** (`updateHeartbeat`), fire-and-forget from turn_end and
  from the quiet window. Under the lock it notes whether the entry is missing.
  After the lock it re-registers from the intent with a queued
  `registerInstance`.
- **An LSP spawn** per session: `void recordLspChild(...)`
  (`clients/lsp/client.ts`), queued on the tail. With no entry it synthesizes
  one carrying the session's root as a service cwd.
- **A declined secondary** per session (#2130). Its start queues
  `registerInstanceRoot` on the tail, which adds the secondary's root (`T1`,
  `T2`) to an existing entry and never creates one. Its shutdown queues
  `deregisterInstanceRoot`, which drops that root and, while the entry still
  holds the session's root, re-arms the intent to that root. The root removal
  and its lock are the subject of `RootRemoval` below; with
  `RootRemoval = "off"` only the intent write is modelled, as before.
- **Another pi process** that can hold the machine-wide lock. A contender
  whose wait runs out drops its write (`instance-registry-lock-timeout`).

`deregisterInstance` advances a process-wide registration generation
(`createGenerationSource`, held in a process singleton), and each writer below
captures it when it is called. `FixParts` switches on the parts of the fix,
which the code now has:

1. `generation`: a registration whose generation moved drops itself before it
   sets the intent, and again under the lock before it writes
   (`instance-registry-registration-superseded`).
2. `child`: `recordLspChild` synthesizes no entry once its generation moved
   (review round 1, F2).
3. `rootIntent`: `deregisterInstanceRoot` re-arms the intent only while its
   generation holds (review round 1, F1).
4. `retry`: when the sync removal cannot take the lock, it is queued on the
   tail (`instance-registry-deregister-queued`). It runs after the op holding
   the lock, waits for the lock instead of dropping, and records
   `instance-registry-deregister-landed` when it runs.

Three more constants cover the secondary's root and the test worker's exit
(#3657, #3703):

- `RootRemoval`: how `deregisterInstanceRoot` takes the lock.
  - `off`: the secondary's root is not modelled (every config above).
  - `sync`: a sync attempt that gives up when the lock is busy (the code
    before #3657, #3587).
  - `syncQueued`: the sync attempt, then the lease-waiting async lock in place
    on the tail slot (#3657).
  - `queued`: no sync attempt, one lease-waiting lock (#3703, merged).
  - `syncAlways` (mutant): #3657's fallback also runs after a successful sync
    removal (its `R1i`, "always queue").
  - `asyncBounded` (mutant): one async lock with the ordinary bounded wait,
    dropped on timeout (#3703 without `LOCK_WAIT_THROUGH_LEASE_MS`).
- `Teardown`: the Vitest worker's exit after the last session ends
  (`tests/support/vitest-setup.ts`, `settleRegistryMutationsBeforeTeardown`).
  - `off`: not modelled.
  - `kill`: the fork is killed with no join (before #3703, #3617).
  - `join`: the exit waits for the tail to drain, with no bound (#3703 round
    1, review F3).
  - `bounded`: the same join, abandoned after a real-time bound (6.5 s, one
    lease plus 1 s). The bound fires only while this process does not hold
    the lock: a hold lasts milliseconds against it.
- `PeerStuck`: the other process may hold the lock and never release it, a
  holder the lease cannot clear (a filesystem error, or a stream of writers
  that keeps winning the lock).
- `Reaper`: the reaper's `pruneDeadInstances` may take the lock directly, off
  the tail, in this process.
- `SharedSec`: a second declined secondary per session on the same root as the
  first, which never shuts down inside the model (#3849).

## Invariants

- `NoGhostRoot`: every root in the entry is the live session's root. An ended
  session never re-registers. The fix's own queued removal is the only
  exception, until it lands.
- `LiveRepairable`: while a session is live, one of these holds:
  - its root is in the entry;
  - a registration for its root is still queued;
  - the heartbeat can still repair it from the intent.

  So a live session is never dropped for good.
- `NoGhostRoot` also covers a secondary's own root: a root of a secondary
  whose shutdown ran is in the entry only while its removal is still queued or
  in flight, or a second secondary on the same root still holds it. A removal that gave up leaves the root behind for the rest of the
  session (#3587).
- `NoExitWhileHeld`: the worker never exits while this process holds the
  registry lock. A killed holder leaves a lock generation of a dead pid behind
  (#3617).
- `TeardownProgress`: while the worker has not exited, some step is enabled:
  the join finishes or its bound fires. It is `ENABLED Step`, a state
  invariant, because the runner only reads invariant verdicts; a deadlock
  would need `CHECK_DEADLOCK`, which the terminating model cannot use.
- `RootRemovedOnce`: a secondary's root removal runs under a lock at most
  once. The second run is a no-op on the file (the root is gone), but each
  run records `instance-registry-deregister-landed`.
- `SharedRootHeld`: a root a landed add put in the entry stays in it while a
  secondary that holds it is live. With `SharedSec`, the second secondary
  never shuts down, so its root must be in the entry until the session ends.
  The entry has no holder count, so on the merged behaviour it is violated
  (#3849).

## Results

| Config | Expect | Before the fix (`FixParts = {}`) |
|---|---|---|
| `Replacement` | pass | violated `NoGhostRoot` (own hold) |
| `ReplacementContention` | pass | violated `NoGhostRoot` (late landing) |
| `StaleIntent` | pass | violated `LiveRepairable` (stale intent) |
| `FixNoRetry` (fix mutant) | violated `NoGhostRoot` | |
| `FixNoRegGate` (fix mutant) | violated `NoGhostRoot` | |
| `StaleIntentNoRegGate` (fix mutant) | violated `LiveRepairable` | |
| `FixNoChildGate` (fix mutant) | violated `NoGhostRoot` | |
| `FixNoRootIntentGate` (fix mutant) | violated `NoGhostRoot` | |
| `FixNoClearIntent` (guard mutant) | violated `NoGhostRoot` | |
| `FixNoHbRepair` (guard mutant) | violated `LiveRepairable` | |
| `SecRootQueued` (#3657 and #3703 merged) | pass | |
| `SecRootSyncQueued` (#3657 shape, before #3703) | pass | |
| `SecRootSync` | violated `NoGhostRoot` | the code before #3657 |
| `FixNoRootLease` (fix mutant) | violated `NoGhostRoot` | |
| `SecRootAlwaysQueue` (fix mutant) | violated `RootRemovedOnce` | |
| `TeardownKill` | violated `NoExitWhileHeld` | the worker before #3703 |
| `TeardownUnbounded` | violated `TeardownProgress` | #3703 round 1 |
| `ReaperPruneResidue` (stated residual) | violated `NoExitWhileHeld` | |
| `SecRootSharedTwo` (open defect #3849) | violated `SharedRootHeld` | |

The counterexamples before the fix:

- **Own hold (`Replacement`):** session 1's heartbeat or registration holds
  the lock, and `session_shutdown` runs. The sync removal meets this process's
  own hold and gives up. The entry keeps `A` after the session ended.
- **Late landing (`ReplacementContention`, `FixNoRegGate`):** a queued
  registration is still waiting (a peer holds the lock) when shutdown removes
  the entry. It lands afterwards and re-creates the entry with `A`.
- **LSP child (`FixNoChildGate`):** a child recorded in session 1 is still
  queued at shutdown; it finds no entry and synthesizes one with `A`.
- **Secondary's removal (`FixNoRootIntentGate`):** a peer holds the lock, so
  shutdown's removal queues behind a secondary's removal that session 1
  queued. That removal still finds `A` in the entry and re-arms the intent to
  `A`; the queued removal lands; session 2's heartbeat finds no entry and
  re-registers `A` with the current generation.
- **`StaleIntent`:**
  1. Session 1's registration starts only after session 1 ended, so it sets
     the intent to `A`.
  2. Session 2's heartbeat finds no entry and re-registers from that intent,
     which is `A`.
  3. Session 2's own `B` registration times out.
  4. From then on the entry holds `A`, and heartbeats see an entry, so they
     never repair `B`.

Each has a replay on the real registry in
`tests/clients/instance-registry-session-replacement.test.ts`, red before the
fix.

The secondary root and the worker's exit (`SecRoot*`, `Teardown*`,
`ReaperPruneResidue`):

- **The code before #3657 (`SecRootSync`):** session 1's heartbeat holds the
  lock, and its secondary's shutdown runs. The sync attempt blocks the event
  loop, the heartbeat cannot release, and after 500 ms the removal gives up.
  `T1` stays in the entry.
- **Bounded wait (`FixNoRootLease`):** the same state, reached with the
  async lock's ordinary wait; the removal is dropped when the wait ends.
- **Always queue (`SecRootAlwaysQueue`):** the sync attempt removes the root,
  and the fallback runs as well, so two removals land for one request.
- **Kill (`TeardownKill`):** the worker exits with a heartbeat or a queued
  mutation holding the lock.
- **Unbounded join (`TeardownUnbounded`):** the other process holds the lock
  forever, session 1's queued deregistration waits behind it, and the join
  never ends.
- **Two secondaries on one root (`SecRootSharedTwo`, #3849):** `reg A` lands,
  a secondary's `radd T1` lands, a second secondary's `radx T1` lands (the
  entry is a set, so it is a no-op), the first secondary's removal lands, and
  the entry drops `T1` while the second still serves it, for the rest of the
  session. The config is red on the merged behaviour and flips to `pass` when
  the fix for #3849 adds a holder count.
- **The reaper's hold (`ReaperPruneResidue`):** `pruneDeadInstances` takes the
  lock off the tail and the tail is empty, so the join ends and the worker
  exits holding it. #3703's own body states this: #3617 is only partly
  delivered (4 of 10 `index-wiring` runs still leak a lock generation). The
  config records the residual, it is not a new finding.

## Where the code differs from the model

- **The heartbeat's repair captures the generation at its `registerInstance`
  call**, after the heartbeat's lock, not at heartbeat entry. #3498 proposed
  the entry capture. The model passes without it, because the intent clear in
  `deregisterInstance` already keeps the only stale input away from the
  repair: with the intent kept, `FixNoClearIntent` re-registers the ended root
  (`NoGhostRoot`) instead of only losing the live one.
- **The heartbeat is on the tail in the code since #3602** (#3657), and the
  model keeps it off the tail. That over-approximates: every tail
  interleaving is still a model behaviour, and it is the pre-#3602 state in
  which `SecRootSync`'s own hold arises. On master the own holder a tail op can
  still meet is the reaper's direct `pruneDeadInstances` (`Reaper`).
  `Drained` therefore counts the model's off-tail heartbeat, which the code's
  join covers through the tail.
- **The `syncQueued` and `queued` shapes share their verdicts**: the sync
  attempt of #3657 is atomic in the model, because it blocks the event loop,
  so the collapse of #3703 is behaviour-preserving on every invariant here.
- **The queued removal waits through the lock lease** (`LOCK_WAIT_THROUGH_LEASE_MS`,
  5.5 s), not forever. A generation or an older writer's lock file past the
  5 s lease is taken over, so a single hold cannot outlast it; a filesystem
  error, or a stream of other writers that keeps winning the lock, still can.
  The lock records `instance-registry-lock-timeout` when it does. The model
  lets the removal wait for a stuck holder forever (`PeerStuck`), so
  `NoGhostRoot` holds there only because the removal is pending; on the code
  the removal drops after 5.5 s and the root stays (a review probe on the real
  registry with a live non-self holder refreshing the lock: removal settled
  after 5506 ms, root kept). A lease-drop witness config is not included.
- **`planRootRemoval` re-arms the intent to the entry's first remaining
  root**, and only when the secondary's root was in the entry. The model
  re-arms to the session's root whenever that root is in the entry, which
  over-approximates: it adds intent writes and cannot hide a violation. The
  code's branch for removing the last root (`withoutOwnEntry`) is unreachable
  in the model, since no op removes the primary root.
- A heartbeat's own lock hold is milliseconds, and the model lets it last
  arbitrarily long. The replay forces the overlap by running shutdown while
  the heartbeat's read of the registry is in flight.

## Scope

Not modelled:

- more than two secondaries on one root, and a second secondary that shuts
  down. One extra secondary per session (`SharedSec`) is enough to show the
  missing holder count of #3849 (`SecRootSharedTwo`);
- `removeLspChild`, which never creates an entry or writes the intent;
- the reaper and dead-pid pruning, except as the off-tail lock holder of
  `Reaper`. A process that exits after the ghost write is pruned by readers,
  so the harm needs the process to live on, which is what a replacement
  does;
- `writeRegistryWithRetry`'s re-read loop.
