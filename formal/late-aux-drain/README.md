# Late auxiliary drain model

A TLA+ model of one (file, server) pair on the collect-later path for slow
auxiliary scanners (#2001/#2002): the aux-grace wait in `clients/lsp/index.ts`
marks the pair, the scanner publishes late, and the `turn_end` drain in
`clients/runtime-turn.ts` delivers what it finds. The `TLA+ models` CI job
(`node scripts/check-tla-models.mjs`) checks every config here against its
`\* expect:` line.

Issues: #3482, #3490 (the rules-refresh surplus publish).

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
- **The client's publication count** (`publicationCountsForPath`). v0 is
  open when the model starts. `need` at mark is the lifetime's sends minus
  the counted publications, and each publication is counted up to the sends
  (the cap).
- **opengrep's rule refresh** (#3490, `Refresh`). opengrep@1a5fd9d
  `Scan_helpers.refresh_rules` sends `semgrep/rulesRefreshed` once its rules
  load, then republishes every file it has a scan recorded for. The model
  sends one such surplus publish. It may overtake scans sent before the
  notification. A scan sent after the notification publishes first only
  with `RefreshOvertake`. The republish carries the newest version sent
  before the notification. `RefreshRebaseline` is the #3490 fix: the
  notification takes one publication back from a path that already had
  one.
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
| `RulesRefreshInFlight` | violated (#3490 before the fix) |
| `RulesRefreshRebaseline`, `RulesRefreshRebaselineWide` | pass (#3490 fix) |
| `RulesRefreshFirstAnswerOutstanding` | violated (admitted #3490 residual) |
| `RulesRefreshOvertake` | violated (admitted #3490 residual: a later answer lands first) |

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

**The rules-refresh surplus (#3490).** Without the rebaseline
(`RulesRefreshInFlight`), the refresh republish counts as the answer to a
send that is still outstanding, and that send's own publish is later
delivered against the next revision. TLC's shortest trace is a touch sent
after the notification: the republish carries the older version and is
counted as that touch's answer. With the rebaseline, both the #3490 order
and this one pass. `RulesRefreshFirstAnswerOutstanding` is the admitted
residual: the notification arrives before the path's first answer, so the
path has no count to take back, and its republish can still count toward
a later send. `RulesRefreshOvertake` is the other admitted residual: the
answer to a touch made after the notification lands before the republish.
The rebaseline then waits for the republish and delivers its older
content. Without the rebaseline, the current answer is delivered only if
the drain runs before the republish is stored.

## Scope

Not modelled:
- the TTL clock (it is subsumed by the rearm ceiling; dropping is always
  safe);
- notify-stall demotion;
- the policy stack;
- several servers or files;
- the cap eviction;
- a scanner that reads the disk at scan time instead of the sent text;
- a second rules refresh;
- the client's 250 ms debounce: `Publish` stores and counts in one step,
  so a first answer received but not yet counted at the notification
  (#3490 r1 F1, handled in the code and pinned by
  `REPLAY-RULES-REFRESHED-DURING-DEBOUNCE`) is not in the model;
- a refresh scan that fails and never republishes (a liveness cost, not a
  safety one).

The aux-grace touch path itself also accepts a late v1 publish as v2's
"answer" (`FixRefreshOnStale` step 7). That is the touch's own result, not
this drain, and is left unchecked here.
