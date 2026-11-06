# Runner availability latch model

A TLA+ model of one availability latch and the probe flights that write it
(#5333): `createAvailabilityLatch` in
`clients/dispatch/runners/utils/availability-policy.ts`, and the flights in
`clients/dispatch/runners/utils/runner-helpers.ts`. Three generations meet
there: the dispatch availability generation, the install-retry generation and
the project trust generation. The `TLA+ models` CI job
(`node scripts/check-tla-models.mjs`) checks every config here against its
`\* expect:` line.

Issues: #5333 (this model), #4530 and #4776 (the trust stamp), #1497 (the
install ladder and its session scope), #1674 (the in-flight release by
identity). The B1 reproduction is the 2026-11-04 probe; #5332 and the #5333
comment name the ast-grep sweep helpers as its site. Those helpers have no
production caller (Findings 1).

## The invariant

`OnlyStarterRecords`: only the generation that started a probe may record its
verdict. Once the owner has cleared for the current availability generation,
every verdict its latch holds was written by a probe that started in that
generation. `NoStaleServed` is the same fact from the reader: a read never
answers with a verdict an older generation's probe wrote.

The other invariants are the trust and install halves:

- `StampNotNewer` (#4776): a note never stamps a verdict with a trust
  generation newer than the one its probe started under.
- `ServedUnderTrust` (#4530): a read never answers with a verdict computed
  under another trust generation than the current one.
- `InstallOwned` (#1497): the install-class attempts, and the exhausted
  verdict, belong to the install generation the latch is synced to.

## Action to code

| Model | Code |
|---|---|
| `SessionStart` | `resetDispatchAvailabilityState()` bumps `availabilityGeneration` (`runner-helpers.ts`), and `resetInstallRetryLatches()` bumps `installRetryGeneration` (`availability-policy.ts`); both are called from the `session_start` reset block in `clients/runtime-session.ts`. Nothing else is cleared there: each owner clears lazily |
| `TrustAdopt` | `setProjectTrustState` / `adoptProjectTrustFromPorts` bump `trustGeneration` (`clients/project-trust.ts`); `getProjectTrustGeneration()` reads it |
| `Ensured` (the first part of `Call`) | `ensureCurrentGeneration()` in `createCwdCachedProbe` and `createAvailabilityChecker` (clears the latch map or cache and the in-flight map; the next `latchFor` builds a new object), and `ensureCurrentSgGeneration()` for the sweep (`sgLatch.reset()` in place, `sgAvailableInFlight = null`). `NewLatchPerGen` is that difference |
| `SettleTrust` | `settleTrustGeneration()`: a verdict from another trust generation is cleared (#4530) |
| `SyncInst` | `syncInstallGeneration()`: a new install generation drops the attempts and the install cooldown, or the whole exhausted verdict |
| `Answer` | `read()`: `true` for `available`, a provisional `true` until its cooldown ends, `null` for no verdict or an expired transient, `false` for a durable or exhausted one |
| `Owe` | `owe()` in `read()`: `owedTrustGeneration ??= verdictTrustGeneration` on a `null` answer |
| `Call`, joined | a `null` read finds the flight slot occupied (`sgAvailableInFlight`, `inFlightByCwd`, `checkerProbeFlights`/`cwdProbeFlights`) and shares the probe: no new probe, the read's `owe()` still ran |
| `Call`, start | a `null` read with an empty slot starts the async flight and captures what the probe runs under |
| `Settle(p, r)` | the flight's note after its `await`: `noteAvailable`, `noteProvisionallyAvailable`, `noteUnavailable` (probe class `trans`, durable `dur`, install class `inst`); `Note` is `settleNote()` (the stamp) followed by the note's own fields |
| `Settle`, release | the `.finally` release of the flight slot by identity (`sgAvailableInFlight === flight`) |
| `ExpireCooldown` | `Date.now()` passing `retryAtMs` / `installRetryAtMs` |

`Results` is the set of verdicts a flight may settle with: the sweep and the
cwd probe never settle install-class, a client latch never settles
provisional.

## Knobs

| Knob | Values |
|---|---|
| `NewLatchPerGen` | TRUE: the owner replaces the latch (`createCwdCachedProbe`; the checker replaces its cache, not a latch), so an older probe holds a retired object. FALSE: one object, reset in place (the sweep, a client's own latch) |
| `Clear` | `"touch"`: the owner clears at its next touch. `"none"`: a process-lived client latch (govulncheck, security scan): only `SettleTrust` and `SyncInst` ever reset it |
| `SettleGuard` | `"none"`: as built, no flight re-checks a generation after its await. `"gen"`: a settle whose captured generation is not the current one is dropped (the candidate fix) |
| `TrustStamp` | `"owed"`: #4776. `"lastRead"`: the stamp comes from the latest null read, which a joiner overwrites. `"current"`: the stamp is the trust at the note, the code before #4776 |
| `ReadChecksTrust` | TRUE: #4530. FALSE: the code before it |

## Results

| Config | Verdict |
|---|---|
| `CwdProbe` | pass, all invariants (`createCwdCachedProbe` only, trust adoption included; the checker has no latch and no trust stamp) |
| `SgSweep` | violated `OnlyStarterRecords` (**B1**: the sg sweep helpers, which have no production caller) |
| `SgSweepServed` | violated `NoStaleServed` (B1 as a caller sees it) |
| `SgSweepTrustStamp` | violated `StampNotNewer` (B1 reopens the #4776 hole) |
| `SgSweepGenGuard` | pass, all invariants (the candidate fix; the model's claim for that guard, not proof the fix suffices: Scope) |
| `Pre4776TrustStamp` | violated `StampNotNewer` (stamp at the note) |
| `Pre4776JoinedRead` | violated `StampNotNewer` (the joiner overwrites the stamp; an illustrative pre-fix shape, not historical code: Scope) |
| `Pre4530ReadNoTrust` | violated `ServedUnderTrust` (no trust generation in the latch) |
| `ClientInstallStale` | violated `InstallOwned` (hypothesis: a client latch's install settle after a session start) |
| `ClientInstallGenGuard` | pass (the same latch with the guard; the ladder up to the exhausted verdict is reachable) |

`CwdProbe` passes because `Settle` writes the object the probe captured, and
the first touch after a session start replaced it. Neutering that
(`target == curLatch` in `Settle`) turns `CwdProbe` into `SgSweep`'s B1.

## Findings

1. **B1 is reproduced by the model (`SgSweep.cfg`) and at module level in the
   sg sweep helpers, which have no production caller.** `isSgAvailableAsync`
   resets one module latch in place and, after its probe `await`, writes `sgCmd`, `sgCmdArgs`
   and calls `noteSgAvailable`/`noteSgUnavailable` without re-checking
   `sgAvailabilityGeneration`. `SgSweep` has the trace: touch (probe 1
   starts), session start, touch (the latch clears, probe 2 starts), probe 1
   settles `ok` into the cleared latch. Replayed at module level
   (`resetDispatchAvailabilityState()` between two `isSgAvailableAsync()`
   calls, the first sweep's spawn held open): after the old sweep settles, a
   third call answers `true` while the new session's own sweep is still in
   flight, and `getSgCommand()` returns the old session's command.
   `createCwdCachedProbe`, held the same way, shows no verdict.
   No production path reaches these helpers. Dropping `SgRunner`'s own
   `getSgCommand` calls and definition, the combined grep
   `grep -rnE "isSgAvailableAsync|getSgCommand|\bsg\.(isAvailableAsync|getCommand)\b|^\s+sg,?\s*$|import \{[^}]*\bsg\b[^}]*\} from" clients tools mcp index.ts --include=*.ts`
   leaves one match outside `runner-helpers.ts`: a doc comment in
   `sg-runner.ts`. The production ast-grep path is `SgRunner`, which has its
   own latch (`clients/sg-runner.ts:216`). So B1 is a latent defect in unused
   code.
2. **Hypothesis, not reproduced: a client latch's install settle.**
   `govulncheck-client.ts` settles a 60 s `go install` with
   `markTransientlyUnavailable(cause, { operationClass: "install" })` and no
   generation check. A session start inside that window syncs the latch's
   install generation first, then counts the stale failure as attempt 1 of
   the new session and arms a 5 minute cooldown. `ClientInstallStale` is the
   shape; whether any production client reaches it was not driven.
3. **Not modelled, same shape, not driven:** the sweep's module accumulators
   (`sgSweepSawTransient`, `sgSweepTransientCause`, `sgSweepHostStallMs`,
   `sgSweepUnreachable`, `sgSweepDurablyMissing`) are written by a stale
   sweep's candidate probes while the new sweep reads them; and
   `noteLatchedUnavailable` / `clearLatchedUnavailable` write
   `latchedUnavailableByCwd` after an `await` in the checker and the cwd
   probe (the log-correction bookkeeping memo, telemetry only).

## Not modelled / hypothesis

- **Eager reset of a process-lived latch (hypothesis; no config carries it).**
  The production-reachable shape of B1 is an eager in-place reset at
  `session_start` of a process-lived latch, plus a post-await settle with no
  generation check. `resetZizmorTokenAvailability()` (`clients/zizmor-config.ts:108`)
  calls `ghTokenLatch.reset()` (`clients/zizmor-config.ts:92`), and
  `clients/runtime-session.ts:2297` calls it at session start. In a throwaway
  probe from review round 1 (spawn mocked at the process boundary, not
  committed), a `resolveGitHubToken` call parked at `gh auth token` (caller
  `clients/lsp/server.ts:5164`), then the session reset, then the `gh` answer:
  session 2's first call returned `undefined` after one `gh` spawn, and the
  latch outcome was non-installable. Only zizmor was driven of the 17
  `createAvailabilityLatch` call sites. The 5 s probe window
  (`clients/zizmor-config.ts:97`) was not driven in a real pi session, so its
  reachability is not shown. The model's `Clear` takes `"touch"` or `"none"`
  only and cannot express an eager reset.

## Scope

Not modelled:
- the cooldown lengths and the escalation ladder of the probe class (a
  boolean: cooling or not), the host-stall shortcut, the probe
  classification and the message split;
- several cwds, several latches, several keys: one latch and one flight
  slot;
- the shared spawn flight under the owner's flight (`checkerProbeFlights`,
  `cwdProbeFlights`, whose generation hook already refuses a join across a
  bump), the managed-shim verdict flights (`guardedWrite`);
- the release-by-identity check as an invariant: `Settle` releases the slot
  by identity, and a mutation of it is not checked here (#1674's shape, the
  single-flight primitive's own tests);
- `createAvailabilityChecker`'s cache, which carries no trust stamp: the
  model covers it for the generation axis only;
- the installer-backed resolvers (`ensureTool`, `getInstallAttempt`).
- joined in-flight callers (`Call`, joined) are judged on the trust axis only.
  The reviewer's mutation M6, which keeps `flight` in `Ensured`, passes every
  config: `NoStaleServed` covers only the reads the latch serves, and no
  invariant judges a caller that joins a flight from an older generation.
- `Pre4776JoinedRead` (`TrustStamp = "lastRead"`) is an illustrative pre-fix
  shape, not historical code: before #4776 the stamp was taken at the note,
  which is `Pre4776TrustStamp`.
- `SgSweepGenGuard` passing is the model's claim for that candidate guard, not
  proof that the fix suffices. `sgCmd` is written before the note, and the
  `sgSweep*` accumulators are not state, so the model cannot show the guard
  sufficient for them.

The model bumps `avGen` and `instGen` in one step because the reset block
calls both back to back; a probe that straddles only one is not explored.
