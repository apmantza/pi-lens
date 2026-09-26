# Late auxiliary drain model

A TLA+ model of one (file, server) pair on the collect-later path for slow
auxiliary scanners (#2001/#2002): the aux-grace wait in `clients/lsp/index.ts`
marks the pair, the scanner publishes late, and the `turn_end` drain in
`clients/runtime-turn.ts` delivers what it finds. The `TLA+ models` CI job
(`node scripts/check-tla-models.mjs`) checks every config here against its
`\* expect:` line.

Issue: #3482.

## What the model covers

- **Agent touches** (`touchFile`, with-auxiliary). The agent writes version
  v. The aux client clears its cached entry (`clearDiagnosticsForPath`) and
  sends v, unless the #1459 gate defers the write. The aux-grace wait then
  looks for publication evidence: any publish for the path since the
  pre-notify baseline counts as "answered". With no evidence it marks the pair
  with `markedAtMs = Date.now()` (index.ts ~6025), which is after the wait.
  If the pair is already marked, the producer re-mark moves the baseline
  forward (#2027).
- **External edits** (another session, a shell write). The disk changes;
  nothing is sent and nothing is marked.
- **The scanner** (opengrep). It scans what it was sent, in order. Its
  publish carries no version, so `isSupersededPush` cannot drop it. The
  client stores it with `ts` set to the receipt time. The scanner may skip a
  superseded scan.
- **The drain**, in three steps split at its awaits:
  1. `drainPendingAuxiliaryCoverage`.
  2. `await readCachedDiagnosticsForServers`, then the synchronous check
     `publishedAt <= markedAtMs`, which re-arms the pair.
  3. After `await bounded(observeLateAuxiliaryAnswer)`: `readFileSync`, the
     mtime gate (`gateFindingsByPathFreshness`: stale when
     `mtime > markedAtMs + tolerance`), and delivery. A stale verdict re-arms
     with a **refreshed** baseline (`rearmPendingAuxiliaryCoverage(pair,
     now, true)`).

Timestamps are a logical clock. Agent touches do not overlap the drain,
because `turn_end` runs after the turn's tools. External edits and publishes
can land between any two steps.

## Invariant

`NoStaleFindings`: every finding the drain delivers was computed on the
content that was on disk when the drain checked the file. This is what
runtime-turn.ts promises at ~4070 ("a changed file cannot resurrect stale
data") and at ~4131. The model does not check delivery time: the advisory
is assembled after further awaits, so an edit after the gate is an
unavoidable TOCTOU window.

## Results

| Config | Verdict |
|---|---|
| `PublishAroundMark`, `EditDuringDrain`, `ExternalEditRearm` | pass |
| `EditDuringDrainNoMtimeGate` (mutant: no mtime gate) | violated |
| `ExternalEditRearmNoPublishedAt` (mutant: no `publishedAt` wait) | violated |
| `ReTouchRemark` | pass (fixed code; bug 1 before #3482) |
| `EditDuringGrace` | pass (fixed code; bug 2 before #3482) |
| `ToleranceWindow` | violated (admitted: the 50 ms tolerance, #1710) |
| `Fix`, `FixWide` | pass (candidate fix) |
| `FixNoCountBind`, `FixLateMark`, `FixRefreshOnStale` | violated (each fix part is needed) |

- **Bug 1, `ReTouchRemark`.** A second agent touch lands while the v1 scan is
  still outstanding: it clears, sends v2, finds no evidence, and re-marks,
  which moves the baseline to `tm2`. The v1 publish then arrives with no
  version and `publishedAt > tm2`. v2's mtime is earlier than `tm2`, so both
  gates pass and v1's findings are delivered against v2.
- **Bug 2, `EditDuringGrace`.** An external edit lands inside the ~2 s grace
  wait. `markedAtMs` is stamped after the wait, so the edit's mtime is
  earlier than the baseline, and the v1 findings pass the gate.
- **A latent third shape** shows up only once bug 1 is fixed
  (`FixRefreshOnStale`). A stale verdict refreshes the baseline to "now",
  which absorbs an external edit. A still-queued older scan that publishes
  later then passes both gates.

Both bugs reproduce on the real code (#3482 has the output). The replay drives
the real publish handler, `clearDiagnosticsForPath`, the pending store and
`handleTurnEnd`. The run delivered `src/scanned.ts:12:1 ... V1-ONLY finding`
against a one-line file. The control, an edit after the mark, is gated
stale.

**The candidate fix** has three parts:
- **Mark at notify time** (`MarkAtNotify`): pass the touch's notify instant
  to `markPendingAuxiliaryCoverage`, not `Date.now()` after the wait.
- **Backlog binding** (`CountBind`): at mark, record how many sends to the
  scanner are unpublished and the per-path publish count. Deliver only after
  that many further publishes. This assumes a scanner publishes once per
  scan, in order. A scanner that skips superseded scans only makes the
  drain wait (safe). A scanner that publishes extra times, such as an empty
  publish on close, would break the assumption; the model does not cover it.
- **No refresh on stale** (`RefreshOnStale = FALSE`): a stale re-arm keeps
  the baseline. Only a producer re-mark moves it.

Mutating any one part turns `Fix` red.

## Scope

Not modelled:
- the TTL clock (it is subsumed by the rearm ceiling; dropping is always
  safe);
- notify-stall demotion;
- the policy stack;
- several servers or files;
- the cap eviction;
- a scanner that reads the disk at scan time instead of the sent text.

The aux-grace touch path itself also accepts a late v1 publish as v2's
"answer" (`FixRefreshOnStale` step 7). That is the touch's own result, not
this drain, and is left unchecked here.
