/** Bounded, process-local telemetry for behavior degraded during one session. */

import { logExtension } from "./extension-log.js";
import { LEDGER_FIELD_MAX, truncateForLedger } from "./ledger-bounds.js";
import { logLatency } from "./latency-logger.js";
import {
	getSinkWriteFailures,
	resetSinkWriteFailures,
} from "./ndjson-logger.js";

// Re-exported so existing importers keep one name for the ledger's bound.
export { LEDGER_FIELD_MAX, truncateForLedger };

export type DegradationKind =
	| "trust-refusal"
	| "mode-suppression"
	| "ts-idle-eviction"
	| "spawn-failure"
	| "formatter-skip"
	| "grammar-blocked"
	| "lsp-breaker"
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
	 * A warm-only client lookup (`getWarmClientForFile`) found no live client
	 * for a file that HAS a language server with a resolvable root (#1934).
	 * Subject is the candidate `serverId:root` set, so the ledger still answers
	 * which server and root the pool is cold for after the detailed records
	 * stop. Not every miss is a fault — the first touch of a project is always
	 * one — but the COUNT is the pool-miss signal that `lsp_client_selected`
	 * cannot carry, since the warm-only callers never reach selection.
	 */
	| "lsp-warm-client-missing"
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
	 * The project-snapshot persist seam detected durable meta/body evidence
	 * failing the #2008 integrity gate — the meta's recorded gz size no longer
	 * matches the on-disk body (torn/truncated gzip under an intact meta), or a
	 * legacy meta carries no gzBytes yet — and withheld dedupe so the pending
	 * save republishes the body. Subject is the snapshot body path; the count
	 * is the exact number of detections this session.
	 */
	| "snapshot-integrity"
	| "formatter-failure"
	| "wasm-abort"
	| "lsp-diagnostics-timeout"
	| "lsp-scanner-coverage-gap"
	| "lsp-notify-inflight-stall"
	| "bus-stale"
	| "query-predicates-invalid"
	| "install-retry-exhausted"
	| "ast-grep-napi-unavailable"
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
	| "log-sink-write-failure";

export interface DegradationRecord {
	kind: unknown;
	subject: unknown;
	reason: unknown;
}

export interface DegradationGroup {
	kind: string;
	/** Exact number recorded, including events no longer retained. */
	count: number;
	/** Number omitted from latestReasons by the per-kind bound. */
	droppedCount: number;
	latestReasons: Array<{ subject: string; reason: string }>;
}

const ENTRIES_PER_KIND = 20;
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
			logDurableDegradation(kind, subject, 1);
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
			logDurableDegradation(kind, subject, count);
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
): void {
	logLatency({
		type: "phase",
		phase: "degradation_ledger",
		filePath: subject,
		durationMs: 0,
		metadata: { kind, subject, count, ledgerGeneration },
	});
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

export function renderDegradationLines(
	summary: unknown = getDegradationSummary(),
): string[] {
	if (!isRenderableSummary(summary)) return [];
	if (summary.length === 0) return [];
	return [
		"Degradations:",
		...summary.map((group) => {
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
}

export const DEGRADATION_ENTRIES_PER_KIND = ENTRIES_PER_KIND;
export const DEGRADATION_MAX_DISTINCT_KINDS = MAX_DISTINCT_KINDS;
