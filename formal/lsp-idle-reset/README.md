# LSP idle-reset model

A TLA+ model of the detached LSP idle-reset timer
(`scheduleLSPIdleReset`, `clients/runtime-turn.ts:516-589`) against LSP work
that is still in flight when it fires. Every config here states its expected
verdict on its first line (see `formal/file-locks/README.md`), and the
`TLA+ models` CI job checks them all.

Issue: #3483.

## What the model covers

- **The idle timer.** When it fires it calls `isWorkspaceSweepActive()`
  (`runtime-turn.ts:560`). If a hold is live, it parks a fresh re-arm on
  `runWhenWorkspaceSweepIdle`. Otherwise it calls `resetFn()` (`:577`) in the
  same tick.
- **What a reset does.** `resetLSPService` marks the service destroyed:
  `shutdown()` sets `isDestroyed` before its first await (`clients/lsp/index.ts:10020`).
  It also nulls the singleton (`:10378`), so the next `getLSPService()`
  builds a new generation. The clients are torn down in a later step.
- **The workspace sweep** (`runWorkspaceDiagnostics`). It holds the sweep hold
  for its whole run (`index.ts:8871`). Before each file it calls
  `checkDestroyed()`. Every file it has not reached yet is marked
  `service_destroyed` (`:9212-9227`, `:9620-9626`).
- **Hold reaping** (`reapStaleHolds`, `workspace-sweep-hold.ts:101-122`).
  Only a sweep that overran its own wall-clock ceiling (`SweepOverrun`) can
  own a hold that is past its max age.
- **A cascade compute** (`computeCascadeForFile`,
  `clients/dispatch/integration.ts`). It reads `getLSPService()` once
  (`:1671`), then touches each neighbour (`:2099`). It takes no hold.
- **A warm-attach touch** (`clients/warm-attach.ts:131-141`). It calls
  `getLSPService()` and `touchFile` in the same tick for each request. It
  takes no hold.
- **`touchFile`**, as three steps separated by awaits:
  - Entry: `checkDestroyed()` → `undefined`, logged `failureKind: destroyed` (`:4619`).
  - Acquire: `getClientForFile` on a destroyed service → `undefined` (`:2941`),
    so `touchFile` returns `undefined`, logged `no_clients_none_spawning`.
  - Answer: an answer that arrives after the teardown is `inconclusive`.
    Before the teardown, the real answer comes back.

Each caller handles an `undefined` touch result differently:

| Caller | Handling of `undefined` | Recorded? |
|---|---|---|
| sweep | `timedOut`, `unconfirmedReason: "budget"` (`index.ts:9356`) | yes (label is wrong) |
| warm attach | `fresh: false` on the IPC answer (`warm-attach.ts:171`) | yes |
| cascade | `if (!rawDiags) return undefined` (`integration.ts:2107`), then `if (result.value) neighbors.push` (`:2233`): the neighbour is dropped | **no** (latency.log row only) |

## Invariants

- `NoResetUnderHold`: the service is never destroyed while a hold token is live.
- `NoResetDuringSweep`: the service a running sweep captured is never
  destroyed while that sweep runs.
- `NoSilentLoss`: a finished cascade run never drops, with no marker, a
  neighbour lost to a reset while another neighbour produced LSP data.
  - "Recorded" means one of these reaches the caller: a marker on the result
    (`inconclusive`, `unconfirmedServerIds`, `indeterminate`, the
    `"fallback"` neighbour reason), `unconfirmedReason`, or `fresh: false`.
  - A latency.log row alone does not count.
  - If every neighbour is dropped, `!producedLspData` takes the passive
    fallback, which is marked.
- `HonestSweepLabel`: a sweep file lost to a reset is never labelled
  `budget`. The model has no real budget timeout, so any `budget` label is a
  mislabelled reset.

## Results

| Config | Expect | Verdict | States | s |
|---|---|---|---|---|
| `SweepHeld` | pass | pass | 44 | 1.1 |
| `SweepReapInRange` | pass | pass | 44 | 1.1 |
| `SweepReapOverrun` | violated `NoResetDuringSweep` | violated | 42 | 1.1 |
| `SweepReapOverrunLabel` | violated `HonestSweepLabel` | violated | 75 | 1.1 |
| `SweepNoHoldCheck` (mutant) | violated `NoResetUnderHold` | violated | 25 | 1.1 |
| `WarmAttachOnly` | pass | pass | 21 | 1.1 |
| `CascadeUncovered` (fixed code, #3483) | pass | pass | 128 | 1.7 |
| `AllActors` (fixed code, #3483) | pass | pass | 12756 | 2.3 |
| `CascadeFix` | pass | pass | 128 | 1.4 |
| `AllActorsFix` | pass | pass | 12756 | 2.3 |
| `CascadeFixEntryOnly` (fix mutant) | violated `NoSilentLoss` | violated | 151 | 1.2 |
| `CascadeFixAcquireOnly` (fix mutant) | violated `NoSilentLoss` | violated | 133 | 1.2 |

- **`CascadeUncovered`:**
  1. The cascade compute captures generation 0.
  2. Neighbour n1 enters `touchFile`, acquires a client and is waiting.
  3. The timer fires. There is no hold, so the service is destroyed.
  4. n2's `touchFile` entry sees `checkDestroyed()` and returns `undefined`.
  5. n1's answer lands, confirmed.
  6. The run finishes with n1 only.
- **`SweepReapOverrun*`:** a sweep that hung past `getWorkspaceSweepMaxHoldAgeMs`
  is reaped, and the parked re-arm fires. The timer then resets under the
  running sweep. The unreached files are still recorded as
  `service_destroyed`. A reset that lands between the per-file check and the
  touch labels that one file `budget`: the #1618 mislabel, in the window the
  reaper reopens.

## Replay on the real code

A throwaway vitest file (since deleted from `tests/clients/lsp/`) used the real `LSPService`, the real
`resetLSPService({reason:"idle"})`, and the real `computeCascadeForFile`.
It mocked the config, client and review-graph seams the same way as
`workspace-diagnostics-service-destroyed.test.ts` and
`inlane-cascade-finding-policy.test.ts`. The output:

```text
(a) in-flight at reset -> {"diags":0,"confirmation":"confirmed"}
(b) acquiring at reset -> undefined          (latency row: no_clients_none_spawning)
(c) entry after reset  -> undefined          (latency row: destroyed)
cascade, n1 has an error: neighbours [n1 only]; cascade_result selectedNeighborCount 2,
  neighborCount 1, selectedOutcomeGap 0, touchFailures 0;
  formatted "... and 1 more dependent file(s): n2.ts"   (rendered as display truncation)
cascade, n1 clean:        run.skipReason "clean", no indeterminate, nothing rendered
```

The reset is called directly, not through the timer. That is what the timer's
`resetFn` calls (`index.ts:3306-3308`), and the #1618 test does the same.

## Candidate fix

`FixParts = {"entry","acquire"}`: a cascade touch that comes back
`undefined` from a destroyed service is kept as an unconfirmed neighbour
(`inconclusive`, `lspTouched: true`, reason `service_destroyed`), not
dropped. The simplest form is one change at `integration.ts:2107`. Another form
is `touchFile` returning an explicit
`{diags:[], inconclusive:true, inconclusiveReason:"service-destroyed"}` from
both destroyed returns.

Each of the two returns is needed. `CascadeFixEntryOnly` and
`CascadeFixAcquireOnly` each go red. Taking a sweep hold in the cascade
compute alone would not be enough: the reaper can still release it.

## Scope

Not modelled:
- time (the timer may fire at any step; delays are over-approximated);
- `isCurrentSession` / `isPrimarySession` (they only suppress resets);
- `clearWorkspaceSweepHoldForSessionStart`;
- `abortDeferredLspWork` (deferred work is aborted by the reset, not held);
- the write's own pipeline touch;
- the lease-failure `inconclusive` return;
- the positional naming in the truncation line.

The in-flight-at-reset answer (a) comes from a fake client whose wait
resolves normally. How a real client's pending wait behaves while its
connection is being disposed was not replayed.
