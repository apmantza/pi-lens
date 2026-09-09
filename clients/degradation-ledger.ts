/** Bounded, process-local telemetry for behavior degraded during one session. */

import type { ConfigDiagnosticCode } from "./config-diagnostic-codes.js";
import { logExtension } from "./extension-log.js";
import {
	DEGRADATION_ENTRIES_PER_KIND,
	LEDGER_FIELD_MAX,
	truncateForLedger,
} from "./ledger-bounds.js";
import { logLatency } from "./latency-logger.js";
import {
	getSinkRotations,
	getSinkWriteFailures,
	resetSinkRotations,
	resetSinkWriteFailures,
} from "./ndjson-logger.js";
// #2146: pulled at READ time, never pushed. `process-singletons.ts` is a
// dependency leaf on purpose — it cannot import this module without closing a
// no-client-cycles cycle through instance-registry/instance-reaper — so the
// ledger reaches IN for its reset log, the same inversion `getSinkWriteFailures`
// above uses.
import {
	getProcessSingletonResets,
	PROCESS_SINGLETON_RESET_KIND,
} from "./process-singletons.js";
// #2506: same inversion, same reason — the log-dir resolver cannot import this
// module (directly OR dynamically). THIS module is on a no-client-cycles cycle
// via extension-log.ts; the resolver's whole correctness argument is that it
// sits off every cycle, so an edge in that direction would put it back on one.
// `getGlobalPiLensLogDir()`'s probe-home-redirect event is therefore written
// into `probe-home-state.ts` and read back here instead. See that module's doc
// comment for the full account.
import { getProbeHomeRedirectEvent } from "./probe-home-state.js";

// Re-exported so existing importers keep one name for the ledger's bound.
export { LEDGER_FIELD_MAX, truncateForLedger };

export type DegradationKind =
	/** A configured analyzer was deliberately skipped for this session. */
	| "startup-analyzer-disabled"
	/**
	 * #2430: a tool mutated a tracked file but matched no built-in name and no
	 * mutation shape adapter, so pi-lens could only find the change by diffing
	 * the disk around the call. Subject is the tool name, recorded ONCE per
	 * tool, so a session report names every gap in the classification registry
	 * instead of leaving the observational net's work invisible.
	 */
	| "unclassified-mutating-tool"
	/**
	 * #2430: an observational capture — the pre-snapshot, the post-diff, or the
	 * `agent_settled` sweep — hit its per-turn wall-clock budget, timed out, or
	 * was aborted. The net then has NO opinion about that call, which must be
	 * visible rather than read as "nothing changed" (catalog shape 10).
	 */
	| "observed-mutation-budget"
	/**
	 * #2430: an armed observation's universe was TRUNCATED — the tool named a
	 * directory with more entries than {@link
	 * clients/observed-mutation.ts#OBSERVED_TARGET_DIR_MAX_ENTRIES}, so the
	 * entries past the cap were never watched. Subject is the tool name. This
	 * is deliberately NOT `observed-mutation-budget`: no clock and no byte
	 * budget was exceeded, and a reader tuning a timeout would be chasing a
	 * structural cap that no amount of time changes (#2449 review round 3).
	 */
	| "observed-mutation-dir-cap"
	| "trust-refusal"
	| "mode-suppression"
	| "ts-idle-eviction"
	| "spawn-failure"
	/** A managed-tool verification probe exceeded its retained output bound. */
	| "installer-verification-output-truncated"
	/**
	 * #2722: a managed-tool verification probe returned a NON-VERDICT — the
	 * #208 transport-required matcher was armed, never matched, and the kept
	 * output is a truncated prefix, so the probe could not decide whether the
	 * binary is a healthy stdio LSP server or a broken install. Subject is the
	 * binary path. Deliberately NOT `installer-verification-output-truncated`
	 * (which also fires on a probe that went on to VERIFY): a reader acting on
	 * this row is looking for an install kept without proof, not for a noisy
	 * one. The installer keeps such an installation rather than deleting it.
	 */
	| "installer-verification-inconclusive"
	/** A git ls-files collection was truncated before parsing completed (#2075). */
	| "git-tracked-ignore-truncated"
	/**
	 * #2523: an `await` on a hook path exceeded its per-hook wall BUDGET, so
	 * `bounded()` (`clients/deadline-utils.ts`) abandoned it and the hook
	 * returned WITHOUT that await's answer. Subject is `<hook>:<label>`,
	 * recorded ONCE per pair so a hook that blows its budget every turn writes
	 * one row, not one per turn. Deliberately NOT informational: the hook
	 * shipped a partial answer, which is a degradation the reader has to act
	 * on (raise the budget, move the work off-hook, or fix what wedged), not a
	 * designed-for tally like a log rotation.
	 *
	 * The DEADLINE cause only. A caller's own abort (Escape, turn cancel) is a
	 * deliberate user action and records nothing at all; a shutdown abort
	 * records `hook-await-abandoned` below. Recording all three here inverted
	 * the reader's signal exactly as `clients/bootstrap.ts` documents at its
	 * `unavailableReason !== "aborted"` guard (#2530 review F1).
	 */
	| "hook-await-exceeded"
	/**
	 * #2523: a bounded hook await was abandoned because the SESSION is tearing
	 * down, not because it was slow. A tally, not a call to action — teardown
	 * abandoning in-flight work is the design — so it is in
	 * `INFORMATIONAL_DEGRADATION_KINDS` and renders without the `⚠` a real
	 * degradation gets. Subject is `<hook>:<label>`, same as above, so the two
	 * causes stay separable in `pilens_health`.
	 */
	| "hook-await-abandoned"
	| "formatter-skip"
	| "grammar-blocked"
	| "lsp-breaker"
	| "lsp-diagnostics-unsupported"
	/**
	 * A per-file touch skipped a language server because that server is in the
	 * breaker cooldown or is latched permanently broken (#1743). During an
	 * outage this fires once per file per touch, so the count here is the exact
	 * total and only the FIRST skip per (server, file) also writes an
	 * `lsp_client_skipped_broken` latency.log record.
	 */
	| "lsp-client-skipped-broken"
	/**
	 * A per-file touch skipped a language server because its direct spawn
	 * command is temporarily marked unavailable (#1743). Same shape and same
	 * bounding as `lsp-client-skipped-broken`, but keyed on the command, since
	 * that is what the availability latch is about.
	 */
	| "lsp-client-skipped-unavailable-command"
	/**
	 * #2518: the session-root registry hit its cap and dropped a root this
	 * process was serving, together with that root's loaded LSP config — so the
	 * operator's `lsp.disabledServers` denial for it stops applying until the
	 * next session start or tool call NAMING that root loads it again
	 * (`shouldInitializeSessionRoot` guarantees those two entry points do,
	 * which is why this is a degradation and not a fault; the readers of the
	 * denial trigger no load). Subject is the cap itself, so a process cycling
	 * through hundreds of roots keys ONE tally rather than one per dropped root
	 * — and it is a TALLY (`incrementDegradationCount`), because the number of
	 * roots this process has had to drop is exactly what an operator tunes the
	 * cap against. The reason names the first root dropped.
	 */
	| "lsp-session-root-evicted"
	/**
	 * A warm-only client lookup (`getWarmClientForFile`) found no live client
	 * for a file that HAS a language server with a resolvable root (#1934).
	 * Subject is the candidate `serverId:root` set, so the ledger still answers
	 * which server and root the pool is cold for after the detailed records
	 * stop. Not every miss is a fault — the first touch of a project is always
	 * one — but the COUNT is the pool-miss signal that `lsp_client_selected`
	 * cannot carry, since the warm-only callers never reach selection.
	 */
	| "lsp-warm-client-missing"
	| "lsp-capability-skip"
	/**
	 * A server-initiated `workspace/applyEdit` fell back to the mutation
	 * bridge (`clients/lsp-mutation.ts`, #2450) because its `LspMutationContext`
	 * carried no `runtime`/`cacheManager`, and no bridge is mounted in this
	 * process (`registerMutationBridge` only runs inside pi's own in-process
	 * extension activation — the standalone MCP server, `mcp/server.ts`,
	 * never calls it). The write still lands on disk; only its bookkeeping
	 * (read-guard stamp, turn-state entry, change-log receipt) is lost.
	 * Subject is the soliciting tool name.
	 */
	| "lsp-mutation-bridge-unmounted"
	/**
	 * #2007: a worktree-mutating git command was declined because a live peer
	 * session shares this dirty checkout. The subject is the checkout root, so
	 * the ledger says WHICH shared directory is contended.
	 */
	| "shared-checkout-wip"
	/** #2007: `git status` could not answer for that same decision. */
	| "shared-checkout-probe"
	/**
	 * The blind review-graph read (`getCachedReviewGraph`) either DROPPED a
	 * persisted snapshot because its git stamp names a different worktree, or
	 * SERVED one whose stamp names a different HEAD (#1961). Subject is
	 * `<verdict>:<cwd>`, so the ledger still answers which workspace and which
	 * verdict after the detailed `review-graph.log` records stop. Every caller of
	 * that accessor (module_report, lens-engine, project_report) can reach it on
	 * every call, so only the FIRST occurrence per (verdict, cwd) also writes a
	 * record; the count here is the exact total.
	 */
	| "review-graph-snapshot-read"
	/**
	 * #2477 round 2: `recordEntitySnapshotDiff` (`clients/review-graph/service.ts`)
	 * received a non-absolute `filePath`. Every production writer
	 * (`clients/dispatch/runners/tree-sitter.ts`) passes `ctx.filePath`, which
	 * `createDispatchContext` guarantees is always absolute (the #2016
	 * invariant) — this is a caller regression, not a runtime condition, so it
	 * fires at most once per subject (the offending path) and the diff is
	 * skipped rather than computed under a key the builder's reader could
	 * never reach. Subject is the raw (unnormalized) `filePath` received.
	 */
	| "review-graph-non-absolute-entity-path"
	/**
	 * #2489 round 2: `dispatchForFile`'s (`clients/dispatch/dispatcher.ts`)
	 * delta-baseline key is `session.baseline.<ctx.filePath>`. Every production
	 * caller reaches `ctx.filePath` through `createDispatchContext`, which
	 * guarantees it is always absolute (the #2016 invariant) — the same
	 * guarantee `review-graph-non-absolute-entity-path` enforces for the
	 * sibling entity-snapshot seam. A relative `ctx.filePath` here can only
	 * happen through a caller regression (a hand-built `DispatchContext`
	 * bypassing the constructor), so this fires at most once per subject (the
	 * offending path) and the baseline read/write is skipped for that
	 * dispatch rather than keyed under a value the constructor would never
	 * produce. Subject is the raw `ctx.filePath` received.
	 */
	| "dispatch-non-absolute-baseline-path"
	/**
	 * The project-snapshot persist seam detected durable meta/body evidence
	 * failing the #2008 integrity gate — the meta's recorded gz size no longer
	 * matches the on-disk body (torn/truncated gzip under an intact meta), or a
	 * legacy meta carries no gzBytes yet — and withheld dedupe so the pending
	 * save republishes the body. Subject is the snapshot body path; the count
	 * is the exact number of detections this session.
	 */
	| "snapshot-integrity"
	/**
	 * Failed-first test state was retired only after ENOENT/ENOTDIR evidence,
	 * retained when the filesystem probe was indeterminate, or evicted at the
	 * state cap (#2044). Subject is outcome + runner + bounded path, so repeated
	 * checks stay attributable.
	 */
	| "test-runner-failed-target-state"
	/** Automatic test-result delivery could not reach the host entry surface. */
	| "test-runner-delivery"
	| "formatter-failure"
	/**
	 * A selected formatter's executable was proven absent (#2413): its
	 * `resolveCommand` probed every install location and PATH and found nothing,
	 * or the static fallback spawn returned a typed `tool-not-found`. Distinct
	 * from `formatter-failure` (a tool that ran and failed) precisely so durable
	 * unavailability is never counted, requeued, or surfaced as a code error.
	 * Subject is `<formatter>:<basename>`.
	 */
	| "formatter-unavailable"
	| "wasm-abort"
	| "lsp-diagnostics-timeout"
	| "lsp-scanner-coverage-gap"
	| "lsp-notify-inflight-stall"
	/** A busy notify-stall discriminator was deferred; detail is rising-edge bounded. */
	| "lsp-notify-stall-cpu-busy"
	/** A didChange content mirror was recorded behind a newer document version. */
	| "lsp-document-send-order"
	| "bus-stale"
	| "query-predicates-invalid"
	| "install-retry-exhausted"
	| "ast-grep-napi-unavailable"
	/**
	 * The napi fallback ADMITTED a file — its extension is in the in-process
	 * language matrix (`clients/dispatch/runners/ast-grep-napi.ts`) — and the
	 * addon that actually loaded then exposed no grammar for it, so every rule
	 * for that language is skipped in-process for the rest of the session
	 * (#2215). Before this kind that skip was the invisible half of the defect:
	 * `getLang` returned undefined and each caller read it as an ordinary
	 * "nothing to do", the AGENTS.md shape-10 clean-versus-unavailable
	 * collapse. Unreachable while the matrix and the addon agree (the coverage
	 * test pins that), so a record here means a napi upgrade dropped a grammar
	 * or the matrix claims one the package never shipped. Subject is the rule
	 * language rather than the file, because the gap is per-language: recorded
	 * once, not once per file.
	 */
	| "ast-grep-napi-language-unavailable"
	/** An availability probe exceeded its advertised wall-clock budget (#2131). */
	| "availability-probe-overrun"
	/**
	 * `loadWebTreeSitter()` (clients/deps/web-tree-sitter.js) rejected during
	 * MODULE EVALUATION, not resolution (#1592). Node's ESM loader permanently
	 * memoizes a module record that threw while evaluating, so re-importing
	 * the same resolved URL replays the cached rejection rather than
	 * re-attempting the load — a same-process retry is dead. TreeSitterClient
	 * latches this permanently instead of retrying on every parse call.
	 */
	| "web-tree-sitter-load-failed"
	| "instance-registry-corrupt"
	| "cascade-budget-override-disarmed"
	| "lsp-pull-unconfirmed"
	/**
	 * A pi-lens `tool_call` handler threw. pi's `emitToolCall` has no
	 * per-handler catch, so an escaped throw blocks the user's tool call —
	 * this kind means the total guard absorbed one (#1655 item 1).
	 */
	| "tool-call-handler-throw"
	/**
	 * A session event reached a pi-lens handler on a ctx the SDK had already
	 * invalidated by a session replacement or reload, so the handler was
	 * skipped (#1925). Subject is the EVENT NAME, so the ledger still answers
	 * which handler is being skipped after the detailed records stop.
	 * `clients/session-event-guard.ts` is the only writer.
	 */
	| "extension-ctx-stale"
	/**
	 * A `message_end` event reached its handler on a ctx the SDK had already
	 * invalidated, so the `cache_usage` row wrote with an UNATTRIBUTED stable
	 * session id (#1956). Distinct from `extension-ctx-stale` on purpose: that
	 * kind means the handler was SKIPPED, while here the row KEEPS WRITING —
	 * the `message` payload is valid provider token/cost data, and dropping it
	 * would lose real usage numbers. Only the attribution degraded. Subject is
	 * the event name (`message_end`), so aggregation still answers WHICH
	 * handler keeps losing its id after the record count stops. Written only on
	 * a CONFIRMED stale probe; a live ctx that merely lacks a session id
	 * (older host, unexpected shape) never reaches this kind.
	 */
	| "cache-usage-attribution-stale"
	/** A workspace diagnostics cache was rejected during the v3 provenance migration (#2776). */
	| "lsp-workspace-cache-migration"
	/**
	 * A tool-event path did not resolve to an existing file, and pi's own
	 * unicode/spacing variant ladder did not find it either (#1655 item 5).
	 * The issue names this `path_variant_unresolved`; the ledger's kind
	 * vocabulary is kebab-case, so it is spelled that way here.
	 */
	| "path-variant-unresolved"
	/**
	 * A deferred-format record's origin (the cwd/worktree it was queued
	 * under) does not match the flush attempting to claim it as an orphan,
	 * so it stays queued and re-surfaces on every subsequent `agent_end`
	 * until a flush from its actual origin claims it (#1642 F3, #1678
	 * item 1).
	 */
	| "path-attribution-orphan-unresolved"
	/**
	 * A `textDocument/diagnostic` or `workspace/diagnostic` pull's per-request
	 * `withTimeout` abandoned the request, and the request later settled anyway
	 * (#1713). The answer arrived too late to serve the caller that timed out,
	 * so it is discarded — this kind is the only trace that it ever landed.
	 */
	| "lsp-pull-late-answer"
	/**
	 * A managed npm tool's periodic version refresh did not complete, or the
	 * refresh state file could not be read (#1730). The tool keeps serving on
	 * the version already installed — this kind means pi-lens cannot prove that
	 * version is the newest the tool's declared range permits.
	 */
	| "managed-tool-refresh"
	/**
	 * `navRequest`'s (`clients/lsp/client.ts`) per-request `withTimeout`
	 * abandoned a hover/definition/references/etc. request (#1716). Every
	 * timeout is counted here; only the FIRST occurrence per (method, file)
	 * this session also writes a detailed `lsp_nav_request_timeout`
	 * latency.log record — navRequest is the highest-volume LSP call site, so
	 * a stuck server storming timeouts must not storm log writes too.
	 */
	| "lsp-nav-request-timeout"
	/**
	 * The abandoned request behind an `lsp-nav-request-timeout` settled anyway
	 * after the caller gave up (#1716) — the nav-request sibling of
	 * `lsp-pull-late-answer`. Nav answers are read-once (no persistent cache
	 * to poison), but the count still tells a dogfood session whether a
	 * "hung" server is truly hung or just answering late.
	 */
	| "lsp-nav-late-answer"
	/**
	 * The abandoned request behind an `lsp-pull-late-answer` timeout REJECTED
	 * instead of answering (#1774) — e.g. a permanent server error such as
	 * `RequestFailed` (-32803) surfacing after the caller gave up.
	 * `ContentModified` (-32801) does NOT reach here: `safeSendRequest`
	 * retries it once internally and resolves `undefined` rather than
	 * rejecting. Without this kind, "timeout then silence" and "timeout then
	 * rejection" both read as the same nothing in latency.log, which is
	 * exactly the discrimination #1549's requests-die-or-arrive-late verdict
	 * needs. The rejection handler still swallows the error; this only
	 * observes it.
	 */
	| "lsp-pull-late-rejection"
	/**
	 * A `textDocument/diagnostic` or `workspace/diagnostic` pull's per-request
	 * `withTimeout` abandoned a GENUINELY dispatched request (#1771). Every
	 * pull timeout emits a detailed `lsp_pull_diagnostic_timeout` latency.log
	 * record already, but until now that record counted nothing in the
	 * ledger — the bounded-telemetry rule (`clients/bounded-telemetry.ts`)
	 * says a failure path omits `ledgerKind` only when it is not a
	 * degradation, and an abandoned pull is one. Subject carries server and
	 * file so a storming server is visible in aggregate, not just per-event.
	 */
	| "lsp-pull-diagnostic-timeout"
	/**
	 * A `textDocument/diagnostic` or `workspace/diagnostic` pull was SKIPPED
	 * outright because the caller's budget was already exhausted (#1773,
	 * review round). Not dispatched, so it is not an LSP-side degradation the
	 * way `lsp-pull-diagnostic-timeout` is — the server never saw the
	 * request — but a caller that repeatedly hands out exhausted budgets to
	 * this call site is itself a shape worth seeing in aggregate (e.g. a
	 * sweep whose own upstream deadline math is too tight). Subject carries
	 * server and file for the same reason every other pull kind does.
	 */
	| "lsp-pull-skipped-budget-exhausted"
	/**
	 * A language-server child process CLOSED without pi-lens having asked it to
	 * (#1969). `clientShutdown()` sets `state.shutdownRequested`, so evictions
	 * and ordinary teardown never reach this kind — only a mid-session death.
	 *
	 * The record exists because the fallout of such a death is highly visible
	 * (`lsp_client_skipped_broken` cooldowns, `lsp-scanner-coverage-gap`) while
	 * the CAUSE was not: an ast-grep child exited with `code=1` and EMPTY
	 * stderr 14 times in one day and left no cause record anywhere. Subject is
	 * the `serverId`, so the ledger answers WHICH server keeps dying; the
	 * reason carries the exit code, the signal, and whether stderr carried
	 * anything, which is the discrimination between "the server told us why"
	 * and "it went dark".
	 *
	 * Written on the process `close` event rather than `exit`: `close` fires
	 * only after the child's stdio streams have drained, so "stderr was empty"
	 * is a fact about the server rather than a race with the pipe.
	 */
	| "lsp-server-unexpected-close"
	/**
	 * A liveness probe (`clientPingLiveness`, `clients/lsp/client.ts`) found no
	 * request method the server advertises that it could safely probe with, so
	 * it reported liveness from process and connection state alone (#1969).
	 *
	 * This matters because the probe exists precisely to catch what those two
	 * checks miss: a server still running, connection still open, that will
	 * never reply again. For a server in this state the probe is weaker than it
	 * looks, and that must be visible rather than assumed. Subject is the
	 * `serverId`, so the ledger names which servers are trusted on the weaker
	 * check.
	 */
	| "lsp-liveness-probe-unsupported"
	/**
	 * A `GenerationHandle.guardedWrite` (`clients/generation-guard.ts`) dropped
	 * a post-await write because the generation it captured is no longer
	 * current (#1754) — a session reset, a cache refresh, or a newer request
	 * for the same key landed while the write's producer was in flight. The
	 * drop is correct: the write belongs to a world that no longer exists.
	 * It is recorded because a silently dropped write is indistinguishable
	 * from a guard that never fires, which is how two hand-rolled versions of
	 * this guard reached review vacuous. Subject carries the source name and
	 * the identity of the dropped write.
	 */
	| "generation-guard-stale-write"
	/**
	 * A shell-out linter/analyzer runner (knip, vulture, jscpd, trivy-config, …)
	 * produced no usable output — empty stdout, unparseable stdout (e.g. a
	 * rejected CLI flag that prints usage text instead of the expected report;
	 * #1757), or (for report-file runners) no report file — on a NONZERO exit
	 * (#1736). The empty-result branches these runners fall back to for "no
	 * findings" must never fire here: a broken shim, crash, rejected flag, or
	 * config-load error must read as errored/skipped, not clean. Reason names
	 * the binary and exit status so a stuck/corrupted runner is diagnosable
	 * from the ledger alone.
	 */
	| "runner-empty-result"
	/**
	 * A shell-out runner's tool DID produce output, exited nonzero, and the
	 * runner's parser extracted ZERO diagnostics from it (#1948). The adjacent
	 * `runner-empty-result` covers "the tool produced nothing"; this covers
	 * "the tool produced something the runner could not read", which is how
	 * five parser bugs (vale #1933; taplo, stylelint, phpstan #1946; sqlfluff)
	 * reported clean files for months while their CLIs were reporting errors.
	 * Subject is the tool id; the reason names the exit status, the output
	 * length, and the first output line, so the ledger alone answers "is this
	 * file clean, or did the parser fail to read it?".
	 */
	| "runner-parsed-nothing"
	/** A runner exceeded the observed inline budget and moved to collect-later. */
	| "runner-collect-later"
	/** A pending runner entry was evicted at the bounded handoff cap (#2122). */
	| "runner-findings-evicted"
	/** A completed runner answer was stale and dropped instead of being replayed. */
	| "runner-findings-stale"
	/** A process-table resource sample failed or timed out; it is unknown. */
	| "resource-sampler-query-failed"
	/**
	 * The registry-independent orphan backstop could not enumerate the OS
	 * process table (spawn error or scan timeout). Its empty result therefore
	 * means "did not look", not "found nothing" (#1857 item 2) — the same
	 * clean-vs-errored discrimination `runner-empty-result` makes for
	 * shell-out runners.
	 */
	| "orphan-backstop-scan-failed"
	/**
	 * A backstop kill was attempted and the process was still alive
	 * afterwards. Subject carries `<binary>#<pid>` so a permanently unkillable
	 * process is identifiable, instead of counting as a successful reap and
	 * paying the full sweep again every session (#1857 items 1 and 3).
	 */
	| "orphan-backstop-kill-unverified"
	/**
	 * A backstop candidate passed every other eligibility test, but the OS
	 * snapshot reported no usable process creation time. The spawn-grace guard
	 * could not rule out "spawned seconds ago, not yet registered", so the
	 * process was spared (#1857 item 4). Without this record the guard would
	 * be indistinguishable from finding nothing.
	 */
	| "orphan-backstop-age-unknown"
	/**
	 * Same as `orphan-backstop-kill-unverified`, for the registry-driven
	 * reaper path, which spelled the identical attempt-counted-as-kill defect
	 * (#1857 class sweep).
	 */
	| "orphan-reap-kill-unverified"
	/**
	 * The orphan backstop's OWN process-table scanner blew the scan timeout and
	 * had to be tree-killed (#1864 review F3). Reason carries the kill verdict,
	 * so a scanner that survived its own sweep's escalation — an orphan sweep
	 * leaking an orphan — is visible rather than silent.
	 */
	| "orphan-backstop-scanner-escalated"
	/**
	 * #2524: the resource sampler's OWN process-table scanner (heartbeat CPU/RSS
	 * sampling, `RESOURCE_SAMPLE_QUERY_TIMEOUT_MS` 2000ms — a much tighter and
	 * far more frequent budget than the orphan backstop's one-per-cooldown
	 * 5000ms scan) blew its timeout and was tree-killed, the sampler-path
	 * sibling of `orphan-backstop-scanner-escalated`. Before this kind existed,
	 * `terminateScannerChild` hardcoded the backstop's kind for BOTH callers, so
	 * every sampler escalation was misattributed to a backstop sweep that had
	 * provably not run (defect shape: a record's subject must be its producer).
	 * Informational, not a `⚠`: `terminateScannerChild` fires the instant its
	 * caller's timer elapses, strictly before `spawnCollectStdoutResult` knows
	 * which of "close" or the timeout handler's own settle will win — so this
	 * kind can and does fire on a query that goes on to settle `status: "ok"`
	 * (no matching `resource-sampler-query-failed` row), i.e. a kill attempt
	 * against a scanner that was already about to finish successfully. The
	 * sampler already treats a lost tick as ordinary best-effort data loss
	 * (self-healing on the next heartbeat), so this rising/falling noise
	 * doesn't warrant the same attention as the backstop's rare, single-sweep
	 * escalation.
	 */
	| "resource-sampler-scanner-escalated"
	/**
	 * `session_start`'s bounded change-log sequence read (#1162) blew its
	 * budget and a project snapshot existed on disk, but the freshness gate
	 * could not tell whether that snapshot was current (#1785). Hydration was
	 * skipped for the synchronous startup path; the deferred read (still
	 * running in the background) retroactively hydrates the runtime once it
	 * lands, unless the session had already advanced by then. Subject carries
	 * the project root so a project that repeatedly starves this read is
	 * visible in aggregate, not just per-session.
	 */
	| "snapshot-sequence-read-timeout"
	/**
	 * `biome-check.ts`'s `resolveBiomeFixKinds` (#1810) couldn't get a real
	 * fix-tier verdict for a rule from `biome explain <rule>` — either the
	 * spawn itself failed/exited nonzero, or it succeeded but the output
	 * matched neither the `- Fix: safe|unsafe` nor `- No fix available.`
	 * shape (e.g. a biome 1.x install, whose `explain` text differs). Both
	 * cases resolve the rule to "not fixable" for that one call WITHOUT
	 * caching the verdict — a poisoned cache entry would make a genuinely
	 * fixable rule permanently unfixable for the rest of the process. Subject
	 * carries the rule name so a specific stuck rule (vs. a whole-binary
	 * mismatch) is diagnosable from the ledger alone.
	 */
	| "biome-explain-unavailable"
	/**
	 * The tier-3 cascade's outstanding-touch registry
	 * (`clients/lsp/cascade-tier.ts`) reached its cap before a quiet-window
	 * reconcile drained it, so the oldest touch was dropped unanswered (#1899).
	 * The registry is drained in full by every sweep, but the sweep runs on
	 * pi's `agent_settled` window and dogfood logs show gaps up to 52 minutes;
	 * this kind means a session out-touched that cadence.
	 */
	| "cascade-tier3-backlog-evicted"
	/**
	 * `read-guard.ts`'s per-file record cap (`READ_GUARD_MAX_RECORDS_PER_FILE`)
	 * trimmed a file's read history (#1913). A hot file trimmed on every push
	 * once it's past the cap, so this kind's rising edge gates the matching
	 * `read_cap_trimmed` read-guard.log line to the first trim and
	 * power-of-two milestones after it — the ledger's own dedupe, not a
	 * hand-rolled per-file Set (#1913 review F1).
	 */
	| "read-guard-record-cap-trim"
	/**
	 * `read-guard.ts`'s whole-file evictor (`evictFile`) dropped a file's
	 * tracked read/edit state (#1918, the #1913 class sibling). Fires from
	 * three call sites — the consumed-file cap, the unconsumed-file cap, and
	 * the idle-eviction timer — the `reason` text in the matching
	 * `read_file_evicted` read-guard.log line says which. Rising edge gates
	 * that log line per file per session, same as `read-guard-record-cap-trim`.
	 */
	| "read-guard-file-evicted"
	/**
	 * `read-guard.ts`'s per-file edits-cap splice (`READ_GUARD_MAX_EDITS_PER_FILE`)
	 * trimmed a file's edit history (#1918). The in-repo doc comment on that
	 * cap argues the trim is inert in practice, but this kind gives it a
	 * record instead of resting only on that argument. Rising edge gates the
	 * matching `edits_cap_trimmed` read-guard.log line, same shape as
	 * `read-guard-record-cap-trim`.
	 */
	| "read-guard-edits-cap-trim"
	/**
	 * A demoted finding was RETIRED from a delivery store instead of being
	 * re-served (#1944). Raised when the cited file shrank past the
	 * coordinates the finding is pinned to, so no re-run can ever confirm it.
	 * The subject carries the discriminating identity — `<store>:<file>` — so
	 * aggregation still answers "which file stopped being served, and from
	 * which store". Counted rather than once-per-session: a session can retire
	 * many findings, and the count is the number the observability question
	 * actually asks.
	 */
	| "demoted-finding-retired"
	/**
	 * `ndjson-logger.ts`'s shared file-sink lost a write even after its one
	 * reopen-and-retry (#1970) — the pi-analyze #15 shape, catching the
	 * `ERR_STREAM_DESTROYED` writes that were vanishing silently after a sink
	 * died mid-session. Subject is the sink's absolute path, so a specific
	 * dying log (latency.log vs tree-sitter.log vs extension.log, …) is
	 * diagnosable instead of one anonymous "logging broke" signal. This kind
	 * is never written via `recordDegradation`/`recordDegradationOnce`/
	 * `incrementDegradationCount` like every other kind above: it is folded
	 * into `getDegradationSummary()` at READ time from
	 * `ndjson-logger.ts`'s own in-memory tally, deliberately bypassing this
	 * module's usual durable-row emission (`logDurableDegradation`, which
	 * writes through `logLatency`/latency.log). Recording a lost write by
	 * writing ANOTHER line through the very sink that just lost a write is
	 * the recursion this design avoids — see `ndjson-logger.ts`'s
	 * `writeFailures` doc comment.
	 */
	| "log-sink-write-failure"
	/**
	 * `ndjson-logger.ts` rotated a shared file-sink at its configured
	 * `maxBytes` bound mid-session (#2505) — the write path itself caught the
	 * crossing, not the once-per-process `runLogCleanup` session-start sweep
	 * (which a long-lived process, e.g. the warm MCP server, may never run
	 * again). Subject is the sink's absolute path, count is the number of
	 * rotations this session. Same "pulled at READ time" shape as
	 * `log-sink-write-failure` above and for the same reason:
	 * `degradation-ledger.ts` already imports `ndjson-logger.ts`
	 * (`getSinkWriteFailures`), so a reverse import to call
	 * `recordDegradation`/`recordDegradationOnce` directly from there would
	 * close a cycle — see `NdjsonWriterState.rotationCount`'s doc comment.
	 */
	| "log-sink-rotated"
	/**
	 * A rotation that `ndjson-logger.ts` attempted and could NOT complete
	 * (#2505 review F2) — an unwritable backup path, or the Windows sharing
	 * violation another process holding the file open produces. This is the
	 * one that matters: the sink cannot bound itself, so the file keeps
	 * growing past `maxBytes` until something outside the writer moves it.
	 * Its sibling above is informational; this one renders as a warning.
	 * Same read-time pull, same cycle reason.
	 */
	| "log-sink-rotate-failed"
	/**
	 * A word-index posting named a file id the file table could not resolve to
	 * a path, so the posting was dropped from a search result or a decoded hit
	 * list (#2069). Since #2069 a posting carries an integer id rather than a
	 * shared string, and an id is only released once the forward index has
	 * enumerated and removed every posting naming it — so this is unreachable
	 * by construction and means that invariant broke. Without this kind the
	 * drop is invisible: the query returns a SHORTER result list and nothing
	 * distinguishes it from a genuinely smaller match set (AGENTS.md shape 10,
	 * an empty or reduced result that cannot tell clean from errored). Subject
	 * is the orphaned id, so aggregation still answers WHICH id leaked after
	 * the per-kind entry bound is reached.
	 */
	| "word-index-orphan-file-id"
	/** Incremental word-index churn required an arena re-compaction. */
	| "word-index-arena-recompact"
	/**
	 * The dispatch `FactStore` (`clients/dispatch/fact-store.ts`) evicted a
	 * least-recently-used file fact because the record count passed its cap
	 * (#2243 item 4). The eviction is otherwise silent, yet a fact a live
	 * dispatch still needs can be the victim — `dispatcher.ts` reads
	 * `file.content` back with `?? ""`, so an evicted content fact turns into
	 * empty content and inline suppressions stop applying. Recorded once per
	 * session, stamped with the first evicted path, so the drop is visible in
	 * the ledger rather than inferred from a downstream symptom. Subject
	 * carries `<store>:<axis>` (#2247 review F1) so a count-axis and a
	 * byte-axis eviction on the SAME store each get their own once-per-session
	 * record instead of one collapsing into the other.
	 */
	| "fact-store-capacity-eviction"
	/**
	 * The dispatch `FactStore`'s pinned content bytes alone exceed the
	 * 64 MiB retained-content budget (#2247 review F2). A pin exempts an
	 * in-flight dispatch's file from eviction, so a leaked pin on a large
	 * file — or several overlapping ones — can put pinned bytes over budget
	 * on their own; evicting the remaining unpinned records can never bring
	 * total bytes back under budget in that state, so `FactStore` stops
	 * evicting and admits unpinned inserts without eviction until a pin
	 * releases. Without this kind that admission-without-enforcement state
	 * is invisible: the store just silently stops honoring its budget.
	 * Recorded once per session, subject is the store label.
	 */
	| "fact-store-pinned-over-budget"
	/**
	 * Gate B (`clients/dispatch/runners/ast-grep-napi.ts`) skipped the napi
	 * fallback because the ast-grep LSP client has published for this file
	 * BEFORE, and a pending late-auxiliary pair for the same (file, "ast-grep")
	 * still sits in `clients/lsp/pending-aux-coverage.ts` (#2324 F2). Ordering
	 * makes this pair provably a LEFTOVER from an earlier touch, never this
	 * one: the aux-grace wait that marks a pair for THIS touch only runs to
	 * completion, and only decides to mark, after napi's Gate B check has
	 * already returned (napi's check is a synchronous map lookup; the wait's
	 * own budget is up to ~1800 ms) — so a pair visible here was marked by a
	 * PRIOR touch's wait and never got delivered. Subject is the server id, so
	 * the ledger still answers which server's earlier finding never resurfaced
	 * after the count-bound stops naming files.
	 */
	| "aux-runner-findings-lost"
	/**
	 * The napi HTML embedded-`<script>` evaluation (#2347) hit its evaluation
	 * budget (body-count and/or cumulative body-bytes cap) and dropped the
	 * remainder without parsing them. Subject is the file path, so the ledger
	 * says WHICH generated/pathological page keeps losing embedded coverage.
	 * Counted per file: the exact dropped total matters more than one retained
	 * reason, and the recorded counts (`scriptElementCount`, `bodiesEvaluated`,
	 * `truncatedBodies`) make the truncation reconstructable.
	 */
	| "ast-grep-napi-html-script-budget"
	/**
	 * A `<script>` body of an HTML file the napi runner was evaluating (#2347)
	 * refused to parse as JavaScript, so that body contributed no embedded
	 * findings. Subject is the file path; counted so the totals survive the
	 * ledger's retained-entry window. A parse refusal on a whole file degrades
	 * that file to "no embedded coverage" like an unparseable `.js` file and is
	 * recorded as such, never as a clean empty result.
	 */
	| "ast-grep-napi-html-script-parse-failed"
	/**
	 * The loaded addon exposed no `js` grammar while an HTML file's embedded
	 * `language: JavaScript` evaluation asked for one (#2347). The embedded
	 * coverage degrades to nothing for the whole file, silently prior to this
	 * kind. Once per file per session; subject is the file path.
	 */
	| "ast-grep-napi-html-js-grammar-missing"
	/**
	 * The `script_element` scan of an HTML root threw while napi prepared the
	 * embedded-`<script>` evaluation (#2347). The embedded coverage degrades to
	 * nothing for the file, silently prior to this kind. Once per file per
	 * session; subject is the file path.
	 */
	| "ast-grep-napi-html-script-scan-failed"
	/**
	 * A demand for the analyzer bootstrap clients (`clients/bootstrap.ts`)
	 * could not be served, so the caller PROCEEDED WITHOUT them (#2467). The
	 * subject is the demand reason — `session-start-scans`,
	 * `tool-call-complexity-baseline`, … — so the ledger still answers WHICH
	 * consumer degraded after the bounded records stop; `unavailableReason` in
	 * the record says which of four SEAM causes fired (the primary session was
	 * shutting down, the caller's wall-clock ceiling elapsed, the load itself
	 * rejected, or the strike latch had already closed). A fifth possible
	 * reason, `aborted` — the caller's OWN signal firing (Escape, a turn
	 * ending) — is deliberately never written here: that is the caller
	 * choosing to stop waiting, not the seam degrading, and counting it would
	 * make a user's cancel read as an unhealthy analyzer graph. Counted rather
	 * than once-per-session: the load is retried on the next demand, so the
	 * number of failed demands is the observability question. Fail-open is the
	 * whole point — without this kind, an analyzer silently not running and an
	 * analyzer finding nothing read identically (AGENTS.md shape 10).
	 */
	| "analyzer-bootstrap-unavailable"
	/**
	 * The analyzer bootstrap stopped rebuilding after
	 * `BOOTSTRAP_FAILURE_STRIKE_LIMIT` consecutive failed loads (#2467 review).
	 * Recorded ONCE per session, because that is exactly what it reports: a
	 * state change, not a rate. The per-demand degradations that follow keep
	 * arriving under `analyzer-bootstrap-unavailable` with
	 * `unavailableReason: "latched"`, so the ledger still answers both "how
	 * often did a consumer degrade" and "why did it stop even trying".
	 */
	| "analyzer-bootstrap-latched"
	/**
	 * A config file the user wrote — or one key inside it — was rejected and
	 * IGNORED, so pi-lens ran on defaults instead of on what the user asked for
	 * (#2418). Written only through `warnIgnoredConfigOnce`
	 * (`clients/config-warn.ts`), the single seam behind all three config
	 * loaders. Before this kind the rejection existed only as a log line and a
	 * one-shot notification: nothing counted it, so a session could silently run
	 * the whole time on defaults with no durable trace. Subject is
	 * `<file>\0<key>` (empty key = the whole file was unreadable), so a per-key
	 * rejection and a whole-file rejection stay distinct rows for the same path;
	 * `metadata.subsystem` says which loader. Once per subject per session — a
	 * config is re-read on many paths and the count of re-reads is not the
	 * observability question, the fact of the ignore is. This is the only kind
	 * that carries a `code` (`PILENS_CFG_0001`) into the durable row.
	 */
	| "config-ignored"
	/**
	 * A config file location or root key the user wrote is DEPRECATED and was
	 * still honored (#2426). The deliberate opposite of `config-ignored`: the
	 * setting applied exactly as written, and the location it was written in is
	 * on the removal schedule in `DEPRECATED_CONFIG_SURFACES`. Kept as its own
	 * kind so "how many sessions ran on defaults because a config was rejected"
	 * stays answerable from the ledger without subtracting deprecations out of
	 * it. Same producer and same `<file>\0<key>` subject as `config-ignored`,
	 * one row per `(file, key)` per session, carrying `PILENS_CFG_0002`
	 * (deprecated key) or `PILENS_CFG_0003` (deprecated file location).
	 */
	| "config-deprecated"
	/**
	 * A config file's NOTICE LIST was truncated by the per-resolution bound, and
	 * this row carries how many notices were summarised away (#2426 review round
	 * 6). Written through `warnIgnoredConfigOnce` like the two kinds above,
	 * under `PILENS_CFG_0007`, with the same `<file>` subject.
	 *
	 * Its own kind because it is a fact about the OUTPUT, not about the config:
	 * a legacy file whose every setting was applied still overflows the bound,
	 * and recording that under `config-ignored` — which it did before this kind
	 * existed — both told the user their valid file was being ignored and made
	 * "how many sessions ran on defaults because a config was rejected"
	 * unanswerable, since the ledger could no longer tell a rejection from a
	 * long list. One row per file per session.
	 */
	| "config-notice-suppressed"
	/**
	 * `getGlobalPiLensLogDir()` (`clients/probe-home-state.ts`, #2506) redirected
	 * the LOG/ledger root away from the real `~/.pi-lens` because `PI_LENS_HOME`
	 * was unset and the process's `cwd` looked like a probe context (inside a
	 * specific `.claude/worktrees/<worktree>/` or under `os.tmpdir()`), or
	 * `PILENS_PROBE=1` forced the redirect — this fires in test mode too, not
	 * only outside it: `tests/support/vitest-setup.ts` pins `PI_LENS_HOME` for
	 * the workers it covers, but globalSetup and children spawned without that
	 * pin still redirect. Without this kind
	 * a probe run outside vitest that forgot to pin `PI_LENS_HOME` would
	 * silently write into the maintainer's real telemetry with no durable trace
	 * — the exact gap that let two review probes leave 42 fixture rows in real
	 * `~/.pi-lens` files on 2026-09-02. Subject is the redirected probe-home
	 * path.
	 *
	 * Scope note (#2506 round 3): only the log family moves.
	 * `getGlobalPiLensDir()` — installed tools, `bin/`, `instances.json`, the
	 * orphan-backstop lease, the probe cache, the global `config.json`, LSP
	 * server storage — stays cwd-independent, so a pi session running from a
	 * worktree keeps its tools and stays visible to the machine-wide registry.
	 * This row therefore means "telemetry was diverted", never "this session
	 * lost its tools".
	 *
	 * Never written via `recordDegradation`/`recordDegradationOnce` like every
	 * other kind above — the same `log-sink-write-failure`/
	 * `process-singleton-reset` shape: it is folded into
	 * `getDegradationSummary()` at READ time from `probe-home-state.ts`'s own
	 * process-scoped event, because the resolver cannot import this module
	 * (directly OR dynamically) without landing back on a `no-client-cycles`
	 * cycle — this one is on the `extension-log.ts` cycle, and staying off
	 * every cycle is the resolver's whole correctness argument. See
	 * `probe-home-state.ts`'s doc comment.
	 */
	| "global-dir-probe-redirect"
	/**
	 * #2504 review round 8 (S1): a carried-forward deferred file entry was
	 * dropped from an IN-BAND `turn_end` publish (`clients/actionable-warnings.ts`)
	 * because its file changed, or the publish crossed a session boundary,
	 * before this turn's own publish could keep it. Informational, not a
	 * fault: the entry's findings are re-discoverable on the ordinary re-edit
	 * cadence (a later turn's own analysis, or a later deferral, sees the
	 * file again), so the loss self-heals and does not warrant a `⚠` in a
	 * dogfood summary. See `INFORMATIONAL_DEGRADATION_KINDS` below.
	 */
	| "actionable-warnings-inband-superseded"
	/**
	 * #2504 review round 7 (F5): the DEFERRED sibling of
	 * `actionable-warnings-inband-superseded` — a file changed while the
	 * off-hook deferred LSP pull was reading it, so its carried entry is
	 * dropped rather than published against content that has since moved.
	 * Same informational treatment: the next deferral or in-band analysis
	 * re-observes the file.
	 */
	| "actionable-warnings-deferred-superseded"
	/**
	 * #2626: `resources_discover` (#205) resolved `<packageRoot>/skills` to a
	 * directory that is absent, unreadable, or holds no `SKILL.md` — pi then
	 * registers zero skills with no extension error and no stderr. Fires on
	 * an installed copy missing `skills/`, or on the entry file having been
	 * copied out of the package tree by a managed extension cache (so the
	 * nearest `package.json` is the cache's own). Subject is the resolved
	 * `skills/` path; see `clients/skills-resolver.ts`.
	 */
	| "skills-dir-missing"
	/**
	 * #2636 (the #2626 class sweep's ast-grep leg): `AstGrepClient`'s
	 * `ruleDir` fell back to `resolvePackagePath(import.meta.url, "rules")`
	 * with no existence check when the project has no `rules/` of its own —
	 * same managed-cache-relocation gap as `skills-dir-missing`. Fires only
	 * when NEITHER the project `rules/` nor the resolved bundled `rules/`
	 * yields a loadable `.yml` rule description. Subject is the resolved
	 * bundled `rules/` path; see `clients/bundled-resource-health.ts` and
	 * `clients/ast-grep-rule-manager.ts`'s `checkAstGrepRulesHealth`.
	 */
	| "ast-grep-rules-dir-missing"
	/**
	 * #2636: the bundled `rules/tree-sitter-queries` root — read identically
	 * by `clients/cache/rule-cache.ts` (`BUNDLED_RULES_ROOT`, to classify a
	 * rule file as bundled-vs-project for cache fingerprinting) and
	 * `clients/tree-sitter-query-loader.ts` (`ruleFilesForLanguage`, to
	 * enumerate the effective rule set) — is absent, unreadable, or
	 * (uncommonly) present but empty. Fires ONCE regardless of how many
	 * languages/call sites hit it, because the subject is the shared ROOT
	 * path, not a per-language one: a language with no bundled queries
	 * AUTHORED for it (cobol, plsql — disabled by design, see
	 * `tree-sitter-shared.ts`) resolves zero files from a HEALTHY root and
	 * must never be confused with the root itself being gone.
	 */
	| "tree-sitter-queries-dir-missing";

export interface DegradationRecord {
	kind: unknown;
	subject: unknown;
	reason: unknown;
	metadata?: Record<string, unknown>;
	/**
	 * Optional STABLE config diagnostic code (#2418). Reserved row field: it is
	 * written into the durable row AFTER the bounded caller metadata, so the
	 * `MAX_METADATA_KEYS` cap can never evict the one field a user greps on.
	 */
	code?: ConfigDiagnosticCode;
}

export interface DegradationGroup {
	kind: string;
	/** Exact number recorded, including events no longer retained. */
	count: number;
	/** Number omitted from latestReasons by the per-kind bound. */
	droppedCount: number;
	latestReasons: Array<{ subject: string; reason: string }>;
}

const ENTRIES_PER_KIND = DEGRADATION_ENTRIES_PER_KIND;
const MAX_DISTINCT_KINDS = 32;
const OVERFLOW_KIND = "other";
const groups = new Map<
	string,
	{ count: number; entries: Array<{ subject: string; reason: string }> }
>();
const onceKeys = new Set<string>();
const tallies = new Map<string, number>();
// Monotonic session-boundary counter (#1536 review F5): callers that keep
// their OWN once-per-session latch outside the ledger (a per-instance Set
// the ledger itself doesn't own) can compare this lazily at use time and
// clear their latch on a mismatch — the same clear-on-transition shape as
// project-trust.ts's trustGeneration, but keyed to the ledger's own reset
// (resetDegradationLedger, wired into handleSessionStart) rather than a
// trust change.
let ledgerGeneration = 0;

/** Current session generation. Bump on every `resetDegradationLedger()`. */
export function getDegradationLedgerGeneration(): number {
	return ledgerGeneration;
}

export function recordDegradation(record: DegradationRecord): boolean {
	try {
		const kind = boundedKind(record.kind);
		const subject = truncateForLedger(record.subject);
		const reason = truncateForLedger(record.reason);
		let group = groups.get(kind);
		if (!group) {
			group = { count: 0, entries: [] };
			groups.set(kind, group);
		}
		const admitted = group.entries.length < ENTRIES_PER_KIND;
		group.count += 1;
		// Bounded at RECORD time (#1366 review): reasons carry arbitrary error
		// text; a 10KB message must never become a 10KB health line or a 10KB
		// retained string.
		group.entries.push({ subject, reason });
		if (group.entries.length > ENTRIES_PER_KIND) group.entries.shift();
		return admitted;
	} catch (error) {
		debugLedgerFailure("record", error);
		// Telemetry must never break the observed path.
		return false;
	}
}

/** Record at most once per kind/subject during the current session. */
export function recordDegradationOnce(record: DegradationRecord): void {
	try {
		const kind = boundedKind(record.kind);
		const subject = truncateForLedger(record.subject);
		const key = `${kind}\0${subject}`;
		if (onceKeys.has(key)) return;
		onceKeys.add(key);
		if (recordDegradation({ kind, subject, reason: record.reason })) {
			logDurableDegradation(kind, subject, 1, record.metadata, record.code);
		}
	} catch (error) {
		debugLedgerFailure("record-once", error);
		// Telemetry must never break the observed path.
	}
}

/**
 * Count a repeated degradation while retaining one latest-reason entry per
 * kind/subject. The group count remains the exact event total.
 *
 * Returns `true` when this call is the FIRST occurrence recorded for this
 * kind/subject pair (the ledger is the single source of truth for that
 * tally already — via `tallies` — so callers that need a once-per-subject
 * "rising edge" signal, e.g. to gate a verbose one-time log line before
 * falling back to the bounded count, read it off this return value instead
 * of hand-rolling their own parallel `Set`/latch). #1716 reuses this same
 * signal to gate `navRequest`'s detailed timeout/late-answer log writes.
 */
export function incrementDegradationCount(record: DegradationRecord): boolean {
	try {
		const kind = boundedKind(record.kind);
		const subject = truncateForLedger(record.subject);
		const reason = truncateForLedger(record.reason);
		const key = `${kind}\0${subject}`;
		const count = (tallies.get(key) ?? 0) + 1;
		tallies.set(key, count);
		let group = groups.get(kind);
		if (!group) {
			group = { count: 0, entries: [] };
			groups.set(kind, group);
		}
		const existing = group.entries.findIndex(
			(candidate) => candidate.subject === subject,
		);
		const admitted = existing >= 0 || group.entries.length < ENTRIES_PER_KIND;
		group.count += 1;
		// #1816: append the count AFTER truncation, never before. `reason` is
		// already bounded above, so re-truncating the concatenation pushed the
		// suffix past LEDGER_FIELD_MAX and silently ate it — a 200-char reason
		// lost the one field that says how often the degradation fired.
		const entry = { subject, reason: `${reason} (count: ${count})` };
		if (existing >= 0) group.entries.splice(existing, 1);
		group.entries.push(entry);
		if (group.entries.length > ENTRIES_PER_KIND) group.entries.shift();
		// Durable rows use the summary's admission and emit the first event and
		// power-of-two milestones only, keeping the sink bounded.
		if (admitted && isPowerOfTwo(count)) {
			logDurableDegradation(kind, subject, count, record.metadata, record.code);
		}
		return count === 1;
	} catch (error) {
		debugLedgerFailure("increment", error);
		// Telemetry must never break the observed path.
		return false;
	}
}

/**
 * Persist the accepted ledger mutation through the existing rotated NDJSON
 * latency stream. `logLatency` owns the timestamp, PID, serialization, secret
 * redaction, and write queue. The subject and kind were already bounded by the
 * ledger before reaching this seam.
 */
function logDurableDegradation(
	kind: string,
	subject: string,
	count: number,
	metadata?: Record<string, unknown>,
	code?: ConfigDiagnosticCode,
): void {
	const boundedMetadata = boundLedgerMetadata(metadata);
	logLatency({
		type: "phase",
		phase: "degradation_ledger",
		filePath: subject,
		durationMs: 0,
		metadata: {
			...boundedMetadata,
			kind,
			subject,
			count,
			ledgerGeneration,
			// Reserved row field, written AFTER the bounded caller metadata so the
			// `MAX_METADATA_KEYS` cap cannot evict the stable code (#2418).
			...(code ? { code } : {}),
		},
	});
}

const MAX_METADATA_KEYS = 8;

function boundLedgerMetadata(
	metadata: Record<string, unknown> | undefined,
): Record<string, string | number> {
	if (!metadata) return {};
	const entries = Object.entries(metadata);
	const kept = entries.slice(0, MAX_METADATA_KEYS);
	const bounded = Object.fromEntries(
		kept.map(([key, value]) => [key, truncateForLedger(value)]),
	) as Record<string, string | number>;
	const dropped = entries.length - kept.length;
	if (dropped > 0) bounded.metadataDropped = dropped;
	return bounded;
}

function isPowerOfTwo(value: number): boolean {
	return value > 0 && (value & (value - 1)) === 0;
}

function boundedKind(value: unknown): string {
	const kind = truncateForLedger(value);
	if (groups.has(kind) || kind === OVERFLOW_KIND) return kind;
	// Keep one slot available for all kinds beyond the cardinality bound.
	return groups.size < MAX_DISTINCT_KINDS - 1 ? kind : OVERFLOW_KIND;
}

export function getDegradationSummary(): DegradationGroup[] {
	const summary = [...groups.entries()].map(([kind, group]) => ({
		kind,
		count: group.count,
		droppedCount: group.count - group.entries.length,
		latestReasons: group.entries.map((entry) => ({ ...entry })),
	}));
	// Folded in at read time, not written into `groups` (#1970) — see the
	// `log-sink-write-failure` doc comment on `DegradationKind` for why this
	// kind never goes through `recordDegradation`.
	const sinkFailures = getSinkWriteFailures();
	if (sinkFailures.length > 0) {
		summary.push({
			kind: "log-sink-write-failure",
			count: sinkFailures.reduce((total, sink) => total + sink.droppedCount, 0),
			droppedCount: 0,
			latestReasons: sinkFailures.map((sink) => ({
				subject: truncateForLedger(sink.file),
				reason: truncateForLedger(
					`${sink.droppedCount} dropped write(s) after reopen-retry failed`,
				),
			})),
		});
	}
	// #2505, same read-time fold: a mid-session rotation is visible without
	// this module writing about it through the very sink family it is
	// reporting on — see the `log-sink-rotated` doc comment on
	// `DegradationKind`.
	const sinkRotations = getSinkRotations();
	const rotated = sinkRotations.filter((sink) => sink.rotationCount > 0);
	if (rotated.length > 0) {
		summary.push({
			kind: "log-sink-rotated",
			count: rotated.reduce((total, sink) => total + sink.rotationCount, 0),
			droppedCount: 0,
			latestReasons: rotated.map((sink) => ({
				subject: truncateForLedger(sink.file),
				reason: truncateForLedger(
					`${sink.rotationCount} rotation(s) at the configured byte bound`,
				),
			})),
		});
	}
	// A rotation the writer ATTEMPTED and could not complete is a different
	// fact from a rotation that happened, and the only signal that a sink is
	// growing past its bound right now (#2505 review F2).
	const rotateFailed = sinkRotations.filter((sink) => sink.failureCount > 0);
	if (rotateFailed.length > 0) {
		summary.push({
			kind: "log-sink-rotate-failed",
			count: rotateFailed.reduce((total, sink) => total + sink.failureCount, 0),
			droppedCount: 0,
			latestReasons: rotateFailed.map((sink) => ({
				subject: truncateForLedger(sink.file),
				reason: truncateForLedger(
					`${sink.failureCount} failed rotation attempt(s); this sink is growing past its byte bound`,
				),
			})),
		});
	}
	// #2146, same read-time fold: process-singleton resets live in the leaf
	// module's own bounded log. One entry per family, so this group's count is
	// the number of families this build could not adopt, never an event tally.
	const singletonResets = getProcessSingletonResets();
	if (singletonResets.length > 0) {
		summary.push({
			kind: PROCESS_SINGLETON_RESET_KIND,
			count: singletonResets.length,
			droppedCount: 0,
			latestReasons: singletonResets.map((reset) => ({
				subject: truncateForLedger(reset.family),
				reason: truncateForLedger(reset.reason),
			})),
		});
	}
	// #2506, same read-time fold: `getGlobalPiLensLogDir()`'s probe-home redirect
	// fires at most once per process (see `probe-home-state.ts`), so this is a
	// presence check, not a tally.
	const probeHomeRedirect = getProbeHomeRedirectEvent();
	if (probeHomeRedirect) {
		summary.push({
			kind: "global-dir-probe-redirect",
			count: 1,
			droppedCount: 0,
			latestReasons: [
				{
					subject: truncateForLedger(probeHomeRedirect.probeHome),
					reason: truncateForLedger(
						`PI_LENS_HOME unset with cwd in an agent worktree/tmp probe context (${probeHomeRedirect.cwd}), or PILENS_PROBE=1 forced it; LOGS redirected away from the real home directory (tools, bin and instances.json are unaffected)`,
					),
				},
			],
		});
	}
	return summary;
}

function isRenderableSummary(value: unknown): value is DegradationGroup[] {
	if (!Array.isArray(value)) return false;
	return value.every((group) => {
		if (group === null || typeof group !== "object") return false;
		const candidate = group as Partial<DegradationGroup>;
		return (
			typeof candidate.kind === "string" &&
			typeof candidate.count === "number" &&
			Array.isArray(candidate.latestReasons) &&
			candidate.latestReasons.every(
				(entry) =>
					entry !== null &&
					typeof entry === "object" &&
					typeof (entry as { subject?: unknown }).subject === "string" &&
					typeof (entry as { reason?: unknown }).reason === "string",
			)
		);
	});
}

/**
 * Kinds that record something the system did ON PURPOSE, correctly, and
 * that a reader only needs a tally of — never a call to action (#2505
 * review). A routine log rotation at the configured bound is the writer
 * working as designed; giving it the same warning marker a real
 * degradation gets trains the reader to ignore the marker. The FAILED
 * rotation is the line that has to stand out, so it is deliberately NOT
 * in this set.
 */
const INFORMATIONAL_DEGRADATION_KINDS: ReadonlySet<string> = new Set([
	"log-sink-rotated",
	// #2504 review round 8 (S1): both fire on the ordinary re-edit cadence
	// (a carry-forward window closing, or a session boundary) and are
	// self-healing -- the next turn's analysis or deferral re-observes the
	// file -- so a `⚠` overstates them the same way a routine log rotation
	// would.
	"actionable-warnings-inband-superseded",
	"actionable-warnings-deferred-superseded",
	// #2523: a hook await abandoned because the session is tearing down. The
	// teardown signal firing is the design working, so it is a tally; the
	// BUDGET blow-out (`hook-await-exceeded`) is the line that has to stand
	// out, and a caller's own Escape records nothing at all.
	"hook-await-abandoned",
	// #2524: can fire on a query that ultimately settles `ok` (see the kind's
	// doc comment above) and is frequent/self-healing by design — a `⚠` would
	// cry wolf on the sampler's ordinary best-effort data loss.
	"resource-sampler-scanner-escalated",
]);

export function renderDegradationLines(
	summary: unknown = getDegradationSummary(),
): string[] {
	if (!isRenderableSummary(summary)) return [];
	if (summary.length === 0) return [];
	return [
		"Degradations:",
		...summary.map((group) => {
			if (INFORMATIONAL_DEGRADATION_KINDS.has(group.kind)) {
				return `  ${group.kind}: ${group.count}`;
			}
			const latest = group.latestReasons.at(-1);
			return `  ⚠ ${group.kind}: ${group.count}${latest ? ` — ${latest.subject}: ${latest.reason}` : ""}`;
		}),
	];
}

function debugLedgerFailure(operation: string, error: unknown): void {
	try {
		logExtension({
			subsystem: "degradation-ledger",
			level: "debug",
			message: `${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
		});
	} catch {
		// Debug logging must not compromise the non-fatal telemetry contract.
	}
}

/** Session-boundary/test reset. */
export function resetDegradationLedger(): void {
	groups.clear();
	onceKeys.clear();
	tallies.clear();
	ledgerGeneration++;
	// #1970, catalog shape 17: the sink write-failure tally is a
	// process-lifetime latch too — it re-arms alongside the rest of the
	// ledger rather than surviving past the session that observed it.
	resetSinkWriteFailures();
	// #2505, same catalog shape 17 re-arm: a rotation tally recurs (new writes
	// keep crossing the bound), so clearing it costs nothing and a later
	// session re-observes the fact fresh.
	resetSinkRotations();
	// #2146 review F3: the OTHER pulled source, `getProcessSingletonResets()`,
	// deliberately does NOT re-arm here, and the difference from its neighbour
	// above is the point. A sink write failure recurs — new writes fail, so
	// clearing the tally costs nothing and a later session re-observes the
	// problem. A process-singleton reset happens once, at module-evaluation
	// time, and cannot recur: after it, the container holds only compatible
	// cells. Clearing it would show the fact in the first session's
	// `pilens_health` and hide it from every session after, which is exactly
	// when someone reads that line. The row is bounded independently of the
	// session (one entry per family, capped at 16), so leaving it costs a fixed
	// handful of lines and keeps a process-scope fact visible for the process's
	// life. Deliberate exception to catalog shape 17, not an oversight.
	//
	// `getProbeHomeRedirectEvent()` (#2506) is the same shape as the
	// process-singleton case above and for the same reason: the redirect is
	// resolved at most once per PROCESS (memoized in the `globalThis` slot
	// `probe-home-state.ts` owns, not a session-scoped one), so it cannot
	// recur within this process's life either — clearing it here would hide
	// the fact from every session after the first in the same probe process.
}

// Re-exported so every existing importer keeps its specifier. The value now
// lives in the `ledger-bounds.js` leaf (#2426), so a producer that only needs
// the BOUND does not have to import the ledger — and cannot be broken by a test
// that mocks it wholesale.
export { DEGRADATION_ENTRIES_PER_KIND };
export const DEGRADATION_MAX_DISTINCT_KINDS = MAX_DISTINCT_KINDS;
