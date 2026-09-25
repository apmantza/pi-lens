# Push-diagnostics freshness model

A TLA+ model of whether the diagnostics a touch's wait settles on were
computed for the content that touch sent. It covers one open document, the
LSP client (`clients/lsp/client.ts`) and a push-only server. Every config
starts with an `\* expect:` line (see `formal/file-locks/README.md`), and
the `TLA+ models` CI job checks each one against it.

Issue: #3484.

## What the model covers

- **Touch A** (`LSPService.touchFile`, the pipeline's `lsp_sync` touch):
  - it reads the per-path baseline (`getDiagnosticsVersionForPath`,
    `clients/lsp/index.ts` ~4870);
  - then `notify.open` → `handleNotifyOpenOnce` (`client.ts` ~4029). The
    document is open, so in one tick it bumps `documentVersions`, calls
    `clearDiagnosticsForPath` (unless `preserveDiagnostics`) and sends
    `didChange`;
  - `markTouched` runs after the send resolves (`index.ts` ~5173).
- **The waiter**, in one of two forms:
  - `SkippedWait = FALSE`: A itself waits, with `minVersion` set to its
    baseline (`index.ts` ~5713);
  - `SkippedWait = TRUE`: the dispatch runner's touch B, with the same
    content. `shouldSkipNotify` (~1952) finds A's `markTouched` entry, so B
    sends nothing and waits with no baseline (~5727).
- **`clientWaitForDiagnostics`** (`client.ts` ~3797):
  - the early return: fresh, not `isVersionStale`, and a non-empty cache;
  - otherwise it registers a listener. `onDiagnostics` re-checks those
    conditions and (re)arms a quiet-window timer, which resolves the wait
    without checking again;
  - a timeout also resolves the wait;
  - `touchFile` reads `getDiagnostics` later, after more awaits (~6583).
- **The `publishDiagnostics` handler** (`client.ts` ~2322–2578):
  - seed-first-push stores the first push at once, with an `isSupersededPush`
    check;
  - otherwise it uses a per-path debounce timer, which checks
    `isSupersededPush` when it fires. A clear cancels that timer (~1825).
- **The server** reads client messages in order. It publishes for the content
  it last read, stamped with the version if `VersionedServer`. With
  `AsyncServer` it may also publish for the content before that (an analysis
  started before the latest change). Server-to-client messages are FIFO and
  interleave freely with client steps.

A check and the send in the same tick are one step, and each `await` starts
a new one. The content sent as version *k* is called content *k*. Each
publish carries a ghost `cv`, the content it was computed for, whether or not
the version goes on the wire.

## Invariants

- `FreshResult`: when a wait settles on diagnostics (the early return or the
  quiet window), the diagnostics `touchFile` then reads were computed for
  content 1 (this touch's) or newer. An empty cache is not a result.
- `FreshRead`: the same check, but also for a wait that timed out.
- `NoKnownStaleCached`: after the send, no cached entry has a known version
  older than the document's.

## Results

`node scripts/check-tla-models.mjs`, TLC 2.19, `-workers auto`, `MaxPubs = 3`. For a violated
config, the state count is how far TLC got before the counterexample.

| Config | Expect | Verdict | Distinct states | s |
|---|---|---|---|---|
| `VersionedBaseline` | pass | pass | 3872 | 2.1 |
| `VersionedSkipped` | pass | pass | 3872 | 2.5 |
| `VersionedSeedSkipped` | pass | pass | 2744 | 2.5 |
| `VersionedPreserve` | pass | pass | 3640 | 2.2 |
| `VersionlessBaseline` | violated FreshResult | violated FreshResult | 1011 | 1.8 |
| `VersionlessSkipped` | violated FreshResult | violated FreshResult | 833 | 1.8 |
| `VersionlessSeedSkipped` | violated FreshResult | violated FreshResult | 535 | 1.9 |
| `PreserveTimeoutRead` | violated FreshRead | violated FreshRead | 1735 | 2.1 |
| `MutantNoGuards` | violated FreshResult | violated FreshResult | 921 | 1.7 |
| `MutantNoSuperseded` | violated FreshResult | violated FreshResult | 3617 | 2.2 |
| `MutantPreserveNoVersionStale` | violated FreshResult | violated FreshResult | 1689 | 2.1 |
| `FenceSkipped` | pass | pass | 3696 | 2.1 |
| `FenceBaseline` | pass | pass | 3408 | 1.9 |
| `FenceAsyncServer` | violated FreshResult | violated FreshResult | 4345 | 2.0 |
| `FenceNoClear` | violated FreshResult | violated FreshResult | 1987 | 2.1 |
| `FenceLate` | violated FreshResult | violated FreshResult | 1893 | 1.6 |

The versioned passes allow `AsyncServer`: late publishes for older content
are in scope. In the exploration grid, every combination of `SeedFirstPush`
× `SkippedWait` × `AsyncServer` passed for a versioned server and failed for
a version-less one.

## The traces

**`VersionlessSkipped` / `VersionlessBaseline`** (9 states; the admitted
limitation):
1. A reads baseline 0. Its runner bumps the version to 1, clears the path,
   and sends `didChange(1)`.
2. The server, still on content 0 (a slow analysis of the previous edit),
   publishes for it with no version.
3. The client receives the publish after the clear. `isSupersededPush`
   returns false because `docVersion === undefined` (~2479), so the debounce
   timer is armed and fires. The handler caches the content-0 diagnostics,
   bumps the per-path stamp to 1, and leaves `diagnosticDocVersions` unset.
4. The wait starts. With no baseline, `hasFreshDiagnostics` is trivially
   true. With baseline 0, stamp 1 > 0, because the clear deleted the old
   stamp and any later store beats the baseline. `isVersionStale` is false
   (no cached version), and the cache is non-empty, so the early return
   fires.
5. `touchFile` reads content-0 diagnostics as this touch's answer.

The baseline adds no protection: it proves that *a* publication landed after
the clear, not that it is *about* the new content. `SeedFirstPush` gives the
same result, with the publish stored at receipt (8 states).

**`MutantNoSuperseded`**: `isVersionStale` alone does not protect the
result.
1. A fresh v1 publish is stored.
2. A late v0 publish arrives and arms the handler's timer.
3. The wait early-returns on v1.
4. The v0 timer then fires and overwrites the cache (it is no longer
   dropped).
5. `touchFile` reads v0.

`isVersionStale` gates only the wait, never the later read. With FIFO and no
`AsyncServer`, removing just one of the guards (`noSuperseded`,
`noVersionStale`, `noClear`) still passes: the clear, `isSupersededPush` and
`isVersionStale` each cover for the others when the server is versioned.
Removing both version guards (`MutantNoGuards`) fails in 10 states.

**`PreserveTimeoutRead`**: a `preserveDiagnostics` resync keeps v0's cached
diagnostics.
- `isVersionStale` stops them from *settling* the wait (`VersionedPreserve`
  passes).
- A wait that times out still reads them. This is the "#1095 note" at
  `client.ts` ~4052: the binding then reads `boundToCurrentDisk: false`.
- `touchFile`'s own notify never passes `preserveDiagnostics`. The only
  caller that passes `true` is the rename path (`index.ts` ~8274).

## Replay on the real client

A throwaway vitest file (deleted from `tests/` after the run) drives the real client:
- `handleNotifyOpen` runs the open-document branch;
- the `didChange` send is held with `gatedPromise` while a content-0 publish
  is delivered through the real `publishDiagnostics` handler;
- then the send is released, the quiet window passes, and
  `clientWaitForDiagnostics` runs with and without `minVersion`.

```text
[replay] versioned=false skipped=false baseline=0 docVersion=1 waitedMs=0 result=["error computed for content 0 (pre-touch)"]
[replay] versioned=false skipped=true baseline=0 docVersion=1 waitedMs=0 result=["error computed for content 0 (pre-touch)"]
[replay] versioned=true skipped=false baseline=0 docVersion=1 waitedMs=601 result=[]
[replay] versioned=true skipped=true baseline=0 docVersion=1 waitedMs=600 result=[]
      Tests  4 passed (4)
```

A version-less server's stale publish settles both waits at once. The same
publish with `version: 0` is dropped, and the wait runs to its budget.

## Candidate fix and its mutations

**Fence** (`Fence = TRUE`):
- in the same tick as the `didChange` send, the client also sends a request
  the server must answer in order;
- until the reply arrives, the handler drops version-less publishes for the
  path.

The reply comes after every publish the server sent before reading the
`didChange`.

- It passes (`FenceSkipped`, `FenceBaseline`) when the server publishes only
  for content it has read.
- `FenceNoClear`: the existing clear is still needed. A stale publish
  received *before* the send has already armed the handler's debounce timer;
  without the clear, that timer stores it.
- `FenceLate`: sending and arming the fence after the `didChange` send
  resolves lets a stale publish in between.
- `FenceAsyncServer`: a server that answers the fence and *then* publishes a
  finished analysis of the older content defeats it. The client cannot rule
  that out without a version, so no client-side ordering fix is sound for
  every version-less server.

LSP has no generic no-op request for the fence. It would have to borrow a
cheap request the server answers in order (for example `documentSymbol`),
at one extra round trip per touch.

## Scope

Not modelled:
- the pull path;
- the `reopenOnResync` close + reopen branch (opengrep): there, a `didClose`
  send is awaited between the clear and the `didOpen`, so a post-close
  publish lands in that window too;
- the not-yet-open branch (a `pendingOpens` add, then `await access()`
  between the clear and the `didOpen`);
- the #3310 empty-first-publish hold;
- the auxiliary carry-over;
- notify-queue coalescing (A's waiters resolve on a superseding entry's send,
  but `markTouched` records A's content).

Only one content change is sent, and publishes are bounded at 3.

The dispatch touch is only skipped when its `clientScope` key matches the
`lsp_sync` touch (`"primary"`). With auxiliaries it is `"with-auxiliary"`,
so it notifies and takes the baseline path. That path violates the same way.
