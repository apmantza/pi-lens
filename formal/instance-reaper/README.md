# Instance reaper: kill-decision model (#3538, #3539)

A TLA+ model of the pi-lens code that decides to kill processes it judges
orphaned. Every config states its expected verdict on its first line (see
`formal/file-locks/README.md`); the `TLA+ models` CI job checks them all.

## What the model covers

- **Registry sweep** `sweepOrphans` (`clients/instance-reaper.ts`). It runs
  fire-and-forget at every `session_start` (`index.ts`), with no lock:
  1. read `instances.json`;
  2. query the identity of every recorded child and host (`queryIdentities`);
  3. decide (`decideOrphanReaping`);
  4. kill each chosen pid in turn (`killPidTree` plus a verify poll);
  5. prune dead and stale entries (`pruneDeadInstances`,
     `clients/instance-registry.ts`).
- **Backstop** `sweepUntrackedOrphans`. It keeps processes that meet all of
  these (`partitionBackstopCandidates`):
  - the command line names a managed binary;
  - no entry tracks the process;
  - its owner is dead (`isOwnerDead`);
  - the process is older than the grace.

  It then kills each one in turn, serialized by the backstop lock.
- **Health prune.** `pilens_health` (`mcp/server.ts`) reaches
  `getResourceFootprint` (`clients/instance-registry.ts`), which prunes
  dead-pid entries and kills nothing.
- **Registry writers**: `registerInstance`, `recordLspChild` (fire-and-forget
  at LSP spawn, `clients/lsp/client.ts`; it synthesizes the host entry if none
  exists), `removeLspChild`, `deregisterInstance`.
- **The OS:**
  - pids are reused, and a process's identity is (pid, start time);
  - POSIX reparents an orphan to init, so its ppid stays alive;
  - Windows keeps the dead parent's pid as the orphan's ppid;
  - a command line is a set of tokens, matched as `buildIdentityMatcher`
    matches a basename.

`FixParts` switches on the three parts of the fix, which the code now has:

- `birth`: each child's and host's OS start time is recorded, a kill needs
  the recorded start, and entries, prunes, registration and the backstop's
  tracked test compare (pid, start) (#3538);
- `recheck`: identity is queried again immediately before each signal
  (#3538);
- `tag`: every LSP child carries its owner's incarnation (`PI_LENS_OWNER`),
  and the backstop reaps by whether that incarnation is dead (#3539).

`retain` (keep records until verified gone) is an alternative the model
rejects: `FixRetainNoTag` still leaks.

## Invariants

- `NoWrongKill`: every kill lands on an orphan, meaning an LSP child whose
  instance is dead. It never lands on a live instance's host, a live
  instance's child, or an unrelated process.
- `OrphanReachable` (the leak bound): every orphan still has a path to a kill.
  Either an entry lists it under its identity, or the backstop's own test
  accepts it.

## Where the code differs from the model

Each difference removes behaviours, so the model covers a superset of the
code:

- a start that cannot be read never authorises a kill or a "dead" verdict;
  the model always knows every start;
- `getResourceFootprint` no longer prunes an entry that still lists
  children, and a sweep whose identity query failed keeps the dead entries.
  The configs keep both faults on (`FootprintPrune`, `ScanFail`), and the fix
  passes with them;
- Windows has no owner tag: another process's environment cannot be read
  there. Its backstop judges the owner dead when the ppid is dead, or when a
  live process on the ppid started after the child (the ppid was reused). The
  model's `tag` on Windows stands for that test;
- the re-check is atomic in the model. In the code a gap remains between the
  query and the signal, which only a pidfd or a Windows process handle
  closes.

Not modelled: the Windows marker search, the `.cmd` shim, and registry
corruption read as empty.

Not modelled either: pid namespaces. The model has one pid space, which is
what a reaper sees within its own namespace. Across namespaces a pid names
different processes, so the code declines to judge there: a process in
another pid namespace reads as untagged, and a registry entry from another
namespace is neither judged dead nor pruned (#3539 review round 1, F1).
Both only remove kills and prunes, so the model still covers a superset of
the code within one namespace. The two-read race between the owner tag and
the start (F2) is closed by re-reading the tag in the re-check, which the
model's atomic `recheck` already assumes.

## Results

The flipped configs (`ReuseToctou`, `RecheckOnly`, `RecheckOnlyNodeCmd`,
`PosixFootprint`, `PosixScanFail`, `PosixLateRecord`, `PosixStaleMcp`,
`PosixSamePid`, `WindowsPpidReuse`) model the fixed code. Each one's comment
says what it violated before the fix, when it ran with `FixParts = {}` (or
`{"recheck"}` for the two `RecheckOnly` configs).

`node scripts/check-tla-models.mjs`, TLC 1.7.4, on a shared 4-core box at
load 20-26. The 27 configs took 479 s of wall time there; the whole
`formal/` set (111 configs) took 23 min 34 s.

| Config | Expect | Verdict | Wall time |
|---|---|---|---|
| `BirthOnly` | violated NoWrongKill | violated NoWrongKill | 3.2 s |
| `FixLeak` | pass | pass | 45.2 s |
| `FixLeakWindows` | pass | pass | 60.0 s |
| `FixNoBirth` | violated NoWrongKill | violated NoWrongKill | 14.4 s |
| `FixNoIdentity` | violated NoWrongKill | violated NoWrongKill | 17.7 s |
| `FixNoLock` | pass | pass | 56.3 s |
| `FixNoParentDead` | violated NoWrongKill | violated NoWrongKill | 5.3 s |
| `FixNoRecheck` | violated NoWrongKill | violated NoWrongKill | 13.7 s |
| `FixNoTag` | violated OrphanReachable | violated OrphanReachable | 2.8 s |
| `FixRetainNoTag` | violated OrphanReachable | violated OrphanReachable | 3.5 s |
| `FixSafety` | pass | pass | 46.0 s |
| `NoReuse` | pass | pass | 49.3 s |
| `NoReuseNoLock` | pass | pass | 21.8 s |
| `NoReuseNoParentDead` | violated NoWrongKill | violated NoWrongKill | 5.6 s |
| `NoReuseNoPpid` | violated NoWrongKill | violated NoWrongKill | 3.7 s |
| `PosixFootprint` | pass | pass | 4.4 s |
| `PosixLateRecord` | pass | pass | 4.1 s |
| `PosixNoFault` | pass | pass | 4.5 s |
| `PosixSamePid` | pass | pass | 6.2 s |
| `PosixScanFail` | pass | pass | 4.5 s |
| `PosixStaleMcp` | pass | pass | 7.3 s |
| `RecheckOnly` | pass | pass | 9.5 s |
| `RecheckOnlyNodeCmd` | pass | pass | 4.7 s |
| `ReuseToctou` | pass | pass | 7.1 s |
| `WindowsFootprint` | pass | pass | 5.1 s |
| `WindowsLateRecord` | pass | pass | 5.9 s |
| `WindowsPpidReuse` | pass | pass | 66.9 s |
