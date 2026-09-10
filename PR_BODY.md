Operating rule: every registered hook returns within its total wall budget, while unfinished work keeps its existing off-hook delivery path.

## Summary

Round 4 fixes the remaining per-hook tool-result budget defects on head `45641df13`.

## State-space table

Each row is one cell of tool class × resident-client state × applied budget. The named test IDs are grep-able after this round.

| Tool class | Resident state | Budget | Test and expected outcome |
| --- | --- | --- | --- |
| read-only | null through first quick-mode session | 500 ms read-only | `it("does not await analyzer bootstrap for a read-only tool result")`; agent-behaviour, read registration, ambient signal, and debounce remain live. |
| read-only | resident | 500 ms read-only | `tests/clients/runtime-tool-result.test.ts`; the resident fast path remains synchronous. |
| read-only | null through first quick-mode session | 10,000 ms dispatch | `tests/clients/runtime-tool-result-debounce.test.ts`; read-only work does not widen its budget. |
| read-only | resident | 10,000 ms dispatch | `tests/clients/runtime-tool-result-debounce.test.ts`; debounce coalesces one pipeline. |
| read-only | null through first quick-mode session | agent_settled bound | `tests/clients/runtime-event-flow.test.ts`; deferred side effects remain attached to the next lifecycle boundary. |
| read-only | resident | agent_settled bound | `tests/clients/runtime-event-flow.test.ts`; settled delivery preserves the ambient signal lifetime. |
| bash-read | null through first quick-mode session | 500 ms read-only | `tests/clients/runtime-tool-result.test.ts`; bash reads register spans without bootstrap demand. |
| bash-read | resident | 500 ms read-only | `tests/clients/runtime-tool-result.test.ts`; resident bash reads preserve registration. |
| bash-read | null through first quick-mode session | 10,000 ms dispatch | `tests/clients/mutating-tool-classification.test.ts`; read commands do not become edits. |
| bash-read | resident | 10,000 ms dispatch | `tests/clients/runtime-tool-result-debounce.test.ts`; no duplicate pipeline is admitted. |
| bash-read | null through first quick-mode session | agent_settled bound | `tests/clients/runtime-event-flow.test.ts`; read-side delivery survives settlement. |
| bash-read | resident | agent_settled bound | `tests/clients/runtime-event-flow.test.ts`; ambient lifetime is restored. |
| bash-write | null through first quick-mode session | 500 ms read-only | `tests/clients/runtime-tool-result.test.ts`; this combination is rejected by classifying the bash effect as edit work. |
| bash-write | resident | 500 ms read-only | `tests/clients/runtime-tool-result.test.ts`; the edit budget is selected even with resident clients. |
| bash-write | null through first quick-mode session | 10,000 ms dispatch | `tests/clients/mutating-tool-classification.test.ts`; synthetic writes receive formatter and queue delivery. |
| bash-write | resident | 10,000 ms dispatch | `tests/clients/runtime-tool-result.test.ts`; synthetic writes retain agent-behaviour and debounce effects. |
| bash-write | null through first quick-mode session | agent_settled bound | `tests/clients/runtime-agent-end.test.ts`; deferred work requeues rather than disappearing. |
| bash-write | resident | agent_settled bound | `tests/clients/runtime-agent-end.test.ts`; the same requeue contract holds after bootstrap. |
| edit | null through first quick-mode session | 500 ms read-only | `tests/clients/mutating-tool-classification.test.ts`; edit classification excludes the read-only budget. |
| edit | resident | 500 ms read-only | `tests/clients/mutating-tool-classification.test.ts`; resident clients do not change class. |
| edit | null through first quick-mode session | 10,000 ms dispatch | `it("returns the edit path within the aggregate formatter budget")`; formatter work is bounded and observable. |
| edit | resident | 10,000 ms dispatch | `it('forwards the executing hook to the formatter aggregate ledger')`; the ledger carries the executing hook. |
| edit | null through first quick-mode session | agent_settled bound | `tests/clients/runtime-agent-end.test.ts`; deferred formatting delivers or requeues. |
| edit | resident | agent_settled bound | `tests/clients/runtime-agent-end.test.ts`; resident formatters use the same delivery contract. |
| unknown | null through first quick-mode session | 500 ms read-only | `tests/clients/observed-mutation-integration.test.ts`; unknown tools remain observational until evidence exists. |
| unknown | resident | 500 ms read-only | `tests/clients/observed-mutation-net.test.ts`; the settled sweep remains bounded. |
| unknown | null through first quick-mode session | 10,000 ms dispatch | `tests/clients/observed-mutation-integration.test.ts`; observed edits enter the edit pipeline only after evidence. |
| unknown | resident | 10,000 ms dispatch | `tests/clients/observed-mutation-integration.test.ts`; resident analysis preserves the queue seam. |
| unknown | null through first quick-mode session | agent_settled bound | `tests/clients/observed-mutation-net.test.ts`; late observations deliver through settlement. |
| unknown | resident | agent_settled bound | `tests/index-observed-sweep-no-read-guard.test.ts`; the ambient signal and debounce contracts remain intact. |

Read-only uses 500 ms, dispatch uses 10,000 ms, and deferred work uses the `agent_settled` bound. The tests assert independent side effects through the real dispatcher, `AgentBehaviorClient`, formatter queue, ambient signal, or debounce seam.

## Tests

Round 4 edits `tests/clients/hook-budget-slice-2.test.ts` for formatter-hook attribution and reruns the named runtime, formatter, agent-behaviour, MCP, tools, configuration, and integration populations.

| gate | result |
| --- | --- |
| `npm run build` | pass |
| `npm run fmt:check` | pass, 1,809 files |
| `npx tsc --noEmit` | pass |
| `npm run astgrep:self-scan` | pass, 0 findings across 1,651 files |
| required population | 156 files, 1,991 passed, 6 skipped; `tests/mcp/analyze-cli.test.ts` has the environment-sensitive warning-count failure |
| `npm run preflight` | all 13 gates pass |
| `node scripts/check-pr-body.mjs --lint-local PR_BODY.md` | pass |

## Blast radius

The hot path adds one conservative bash-command parse for bash results. Existing mutating-tool classification, bootstrap access, formatter aggregation, and deferred-format requeue callers remain the dependents.

## Class sweep

The sweep keeps `hook-await` at 170, `hand-rolled-race` at 8, and `BOUNDED_CALL_SITES` at 22. M11 and M13 are covered by the dispatcher and ambient-signal regression cases; M4, M5, M7, M8, M9, M10, and M12 are recorded as mutation checks in Round 4.

## Observability

Formatter aggregate deadline records use the runtime literal `formatter-aggregate`; cascade admission uses `cascade-pending-cap`.

## Test assessment

The new formatter attribution assertion observes the degradation ledger. The deferred-format expiry path records `format-failed` and requeues the original row; caller aborts retain their established silent path.

## Round 4

V1–V4, M1/M2/M14/M15/M16, and cascade cap M6 remain green after the round. V5, AE, P3, and P4 are covered by the formatter, deferred-drain, bash-classification, and process-wide behaviour seams. `analyze-cli` is 21 passed on master and head in this environment; its earlier warning-count difference is environmental.
