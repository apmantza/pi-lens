# Late auxiliary drain model

A TLA+ model of one (file, server) pair on the collect-later path for slow
auxiliary scanners (#2001/#2002): the aux-grace wait in `clients/lsp/index.ts`
marks the pair, the scanner publishes late, and the `turn_end` drain in
`clients/runtime-turn.ts` delivers what it finds. The `TLA+ models` CI job
(`node scripts/check-tla-models.mjs`) checks every config here against its
`\* expect:` line.

Issues: #3482 (with its save-rescan and close-and-reopen surpluses), #3490
(the rules-refresh surplus publish), #3548 (typos' unconditional
close-triggered publish).

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
- **opengrep's save rescan** (#3482, `AllowSave`). opengrep@1a5fd9d
  `Notification_handler.on_notification` runs `Scan_helpers.scan_file` on
  `DidSaveTextDocument`, so a touch that is a save (#3405, the
  `lsp_diagnostics` tool's `saved: true`) makes opengrep scan and publish
  twice. `SaveExpect` is how many publications the client expects per save
  beyond the send: 0 before the fix, 1 the fix (`rescansOnSave`), 2 a
  mutant.
- **A close and a fresh reopen** (#3482, `Closes`). A #3477 rename closes
  the path. Scans still queued publish anyway: while the path is closed
  the client drops them (the `closedDocuments` return), and after a reopen
  it stores them. `Carry = "none"` is the code before the fix: the counts
  restart at the reopen. `"span"` is the fix: the counts span the close,
  and a publish dropped while closed is counted. `"spanNoDrop"` is a
  mutant that does not count the dropped publish.
- **A server's own close-triggered publish** (#3548, `AllowClosePublish` /
  `ClosePublishCounted`). opengrep publishes nothing on close, but
  tekumara/typos-lsp `crates/typos-lsp/src/lsp.rs` `did_close` publishes an
  empty, version-less set UNCONDITIONALLY, on every close, answering no
  send. `AllowClosePublish` arms one such publish (`ClosePublish`, only
  while still closed — see its own comment for why) — distinct from any
  real scan still queued in `sent`, and NOT ordered ahead of one: both
  compete for the SAME credit (below), whichever reaches
  `DroppedWhileClosed` first. Whether the credit mechanism is engaged at
  all is `ClosePublishCounted`: `TRUE` reproduces #3548 (client.ts's
  `Counted` charged against `bound` unconditionally in the closedDocuments
  branch, no credit concept); `FALSE` is the fix (the `publishesOnClose`
  strategy marker). It never affects a server `AllowClosePublish` is left
  `FALSE` for: that server's own close-time publish (from a real queued
  scan) still goes through `DroppedWhileClosed` exactly as before, gated
  only by `Carry` — the required inverse direction.
- **The close-publish credit, and its reopen reset** (#3548 review r1 B1,
  `closePublishCredit` / `ResetClosePublishCredit`). `closePublishCredit`
  is `closePublishSkipsRemaining`: a counter, not a one-shot flag,
  incremented once per close (when the credit mechanism is engaged) and
  SHARED — `DroppedWhileClosed` (called by `Publish`/`SurplusPublish` for a
  real scan, or by `ClosePublish` for the close's own trigger) spends it on
  whichever reaches it first while closed, matching client.ts's single
  `if (remaining > 0)` check exactly. `ResetClosePublishCredit` is whether
  `AgentTouch`'s reopen branch clears it (client.ts `handleNotifyOpenOnce`'s
  `closePublishSkipsRemaining.delete`, the same point `closedDocuments` is
  cleared): `FALSE` is the leak a credit spent by nothing before a reopen
  survives into, and stacks with, the NEXT close's own; `TRUE` is the fix.
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

## Invariants

`NoStaleFindings`: every finding the drain delivers was computed on the
content that was on disk when the drain checked the file. This is what
runtime-turn.ts promises at ~4070 ("a changed file cannot resurrect stale
data") and at ~4131. The model does not check delivery time: the advisory
is assembled after further awaits, so an edit after the gate is an
unavoidable TOCTOU window.

`NoFreshWithheld` (the no-drop direction, AGENTS.md shape 54): when the
drain reads a stored answer for the content on disk, published after the
mark, and no scan of that content is still to publish, the backlog binding
does not make it wait. Such a wait either lasts until the rearm ceiling
drops the pair, or ends on an older publish that lands later, so it drops
the current answer. A wait while a scan of the current content is still
due (the save rescan of the same version) is allowed. The invariant is a
state predicate, so the `\* expect:` checker can read its verdict.

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
| `FixNoDrop`, `RulesRefreshRebaselineNoDrop` | pass, both invariants (no cancel, as opengrep) |
| `CancelWithholds` | violated `NoFreshWithheld` (admitted: a scanner that skips a superseded scan) |
| `RulesRefreshOvertakeWithheld` | violated `NoFreshWithheld` (the #3490 r1 F2 trade, no-drop side) |
| `RulesRefreshOvertakeNoRebaseline` | pass `NoFreshWithheld` (the trade's other side) |
| `SaveRescanUncounted` | violated `NoStaleFindings` (the save rescan before the fix) |
| `SaveRescanExpected` | pass, both invariants (the fix) |
| `SaveRescanOverExpected` | violated `NoFreshWithheld` (mutant: two per save) |
| `ReopenUncarried` | violated `NoStaleFindings` (the reopen before the fix) |
| `ReopenSpan`, `ReopenRulesRefresh` | pass, both invariants (the fix) |
| `ReopenSpanNoDropCount` | violated `NoFreshWithheld` (mutant: a publish dropped while closed not counted) |
| `ClosePublishUncounted` | violated `NoStaleFindings` (#3548 before the fix: typos' close-triggered publish counted) |
| `ClosePublishExempt` | pass `NoStaleFindings` (#3548 fix: `publishesOnClose` skip; `NoFreshWithheld` not checked — see the credit paragraph above) |
| `ClosePublishCreditLeak` | violated `NoExcessCloseCredit` (review r1 B1 before the fix: the credit survives a reopen and stacks across a second close) |
| `ClosePublishCreditReset` | pass `NoStaleFindings` and `NoExcessCloseCredit` (review r1 B1 fix: the credit is cleared at every reopen) |

The existing configs keep `NoStaleFindings` alone and keep their verdicts.
Adding `NoFreshWithheld` to them violates it in every config with
`AllowCancel = TRUE` (`Fix`, `FixWide`, `ReTouchRemark`,
`RulesRefreshRebaseline`, ...): a cancelled scan never publishes, so the
binding waits for it. That is #3482's admitted "a scanner that skips
superseded scans only makes the drain wait", which the no-drop invariant
shows is a drop until the rearm ceiling. `CancelWithholds` pins it.
opengrep does not cancel: each notification's reply runs to completion
(opengrep@1a5fd9d `RPC_server.ml`, `Lwt.dont_wait`), so the `NoDrop`
configs set `AllowCancel = FALSE`.

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
  scan, in order. A scanner that skips superseded scans makes the drain
  wait until the rearm ceiling (`CancelWithholds`). The extra publishes
  pi-lens triggers in opengrep are modelled below; opengrep publishes
  nothing on close, but typos does (#3548, modelled separately by
  `AllowClosePublish`/`ClosePublishCounted`).
- **No refresh on stale** (`RefreshOnStale = FALSE`): a stale re-arm keeps
  the baseline. Only a producer re-mark moves it.

Mutating any one part turns `Fix` red.

**The rules-refresh surplus (#3490).** Without the rebaseline
(`RulesRefreshInFlight`), the refresh republish counts as the answer to a
send that is still outstanding, and that send's own publish is later
delivered against the next revision. TLC's shortest trace is a touch sent
after the notification: the republish carries the older version and is
counted as that touch's answer. With the rebaseline, both the #3490 order
and this one pass. `RulesRefreshFirstAnswerOutstanding` is an accepted
limit: the notification arrives before the path's first answer, so the
path has no count to take back, and its republish can still count toward
a later send. It cannot be observed: opengrep republishes a path only if
a scan is recorded for it, and the client cannot see whether the first
scan was recorded before the refresh read the list. Taking one back
anyway would, when the refresh misses the path, hold every later
delivery for it until the rearm ceiling. `RulesRefreshOvertake` is the other admitted residual: the
answer to a touch made after the notification lands before the republish.
The rebaseline then waits for the republish and delivers its older
content. Without the rebaseline, the current answer is delivered only if
the drain runs before the republish is stored. `NoFreshWithheld` checks
this trade from both sides: `RulesRefreshOvertakeWithheld` (the rebaseline
withholds the stored current answer) and
`RulesRefreshOvertakeNoRebaseline` (without it nothing is withheld, and
`RulesRefreshInFlight` shows the stale delivery that costs).

**The save rescan and the reopen (#3482).** Without the save expectation
(`SaveRescanUncounted`), the rescan of v1 lands after a re-touch sends v2
and is counted as v2's answer, so v1 is delivered against v2. Without the
spanning counts (`ReopenUncarried`), a scan queued before the close lands
after the reopen and is counted as the reopened send's answer. Each fix
passes both invariants (`SaveRescanExpected`, `ReopenSpan`), and each
over-correction withholds the current answer (`SaveRescanOverExpected`,
`ReopenSpanNoDropCount`). `ReopenRulesRefresh` runs the refresh before,
during and after a close and reopen: the take-back stays in the spanning
count, and the republish restores it whether it is dropped while closed
or stored after the reopen.

**A server's own close-triggered publish (#3548).** `ReopenSpan` above
already fixes #3482's "a QUEUED scan lands after the close" surplus; it
never modelled a publish the close ITSELF produces, because opengrep
produces none. typos does, unconditionally, on every close. Without the
`publishesOnClose` skip (`ClosePublishUncounted`), that publish is
credited toward the closed lifetime's owed scans — the same class of bug
`ReopenUncarried` shows, but caused by the close's own side effect rather
than by resetting the carry — so a genuinely in-flight scan's later (stale)
answer is free to be taken as the reopened file's fresh answer instead.
With the skip (`ClosePublishExempt`), that publish is dropped like any
other publish while closed but never credited, so the in-flight scan's own
answer is still required before the reopened send is satisfied. A server
this marker is not set for keeps counting its own close-time publish
exactly as before: `AllowClosePublish = FALSE` never grants
`closePublishPending`, so `ClosePublish` never fires for it, and its
close-time publish (a real, if late, backlog answer) still goes through
`Publish`/`SurplusPublish`'s own `DroppedWhileClosed` call untouched. This
inverse is `NoStaleFindings`-only in every config (`ClosePublishExempt`
included; see the credit paragraph below for why `NoFreshWithheld` is
deliberately not one of them).

**The close-publish credit does not survive a reopen (#3548 review r1
B1).** `closePublishSkipsRemaining` (`closePublishCredit` here) is a
SHARED resource: `DroppedWhileClosed` — called by `Publish`/`SurplusPublish`
for a real queued scan's own answer AND by `ClosePublish` for the close's
own trigger — spends it on whichever of the two reaches the closedDocuments
branch first while closed, matching client.ts exactly (one `if (remaining >
0)` check, no distinction between the two). Two consequences follow from
sharing ONE resource this way:

- *An accepted, reviewed residual, independent of this fix.* Even within a
  SINGLE close, if the real scan happens to arrive before `ClosePublish`,
  it spends the close's OWN legitimate credit — `ClosePublish`'s own
  contribution to `bound` is then left pending until it fires. Neither
  event ever touches `cache` (`DroppedWhileClosed` only ever drops), so
  this is a transient wait, never a stale delivery — `NoStaleFindings`
  still holds (`ClosePublishExempt`) — cleared by the reviewer as
  cancelling out numerically once both arrivals resolve. Because this
  model does not represent a close-publish's resolution once reopened
  (see `ClosePublish`'s own comment: modelling that would need a `ver` for
  a stored, content-less publish, a `NoStaleFindings` question out of
  scope here), a trace where the real scan wins and the reopen happens
  before `ClosePublish` gets a turn leaves it "pending forever" in THIS
  model — a scope limitation, not a defect — which is why
  `ClosePublishExempt` checks `NoStaleFindings` only, never
  `NoFreshWithheld`.
- *The leak itself.* Without a reopen reset (`ResetClosePublishCredit =
  FALSE`), a credit granted by one close that the ordering residual above
  (or simple bad luck) leaves unspent survives into the NEXT close and
  stacks with its own fresh credit — `NoExcessCloseCredit`
  (`closePublishCredit <= 1`) is the leak's own, uncontaminated signature,
  independent of the ordering residual's `NoFreshWithheld` noise: the
  residual never creates a SECOND credit (`ClosePublishCreditLeak`
  violates `NoExcessCloseCredit` only; `ClosePublishCreditReset`, WITH the
  reset, passes `NoStaleFindings` and `NoExcessCloseCredit`).

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
  safety one), and likewise a save rescan or a queued scan that fails;
- the order of a save's two scans: opengrep runs them on separate threads,
  and both carry the saved version in the model;
- a receipt still inside the debounce at the close (the code counts it
  when the close's `clearDiagnosticsForPath` drops it);
- opengrep's other publish triggers: `ChangeWorkspaceFolders`
  (`scan_workspace`), `DidDeleteFiles`, `semgrep/scanWorkspace` and
  `semgrep/refreshRules`. pi-lens sends none of them.

The aux-grace touch path itself also accepts a late v1 publish as v2's
"answer" (`FixRefreshOnStale` step 7). That is the touch's own result, not
this drain, and is left unchecked here.
