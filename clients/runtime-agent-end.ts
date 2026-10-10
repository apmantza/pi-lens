import * as nodeFs from "node:fs";
import * as path from "node:path";
import {
	type ActionableWarningsReport,
	applyConservativeActionableWarningFixes,
	checkActionableWarningsReportFresh,
	quickFixCreditEpoch,
} from "./actionable-warnings.js";
import { publishFilesTouched } from "./bus-publish.js";
import type { CacheManager } from "./cache-manager.js";
import type { BiomeClient } from "./biome-client.js";
import type { RuffClient } from "./ruff-client.js";
import {
	publishAutofixStart,
	publishFormatDone,
	publishFormatStart,
} from "./format-events-publish.js";
import type { FormatService } from "./format-service.js";
import { logLatency } from "./latency-logger.js";
import { isPathIgnoredByProject } from "./file-utils.js";
import { admitBounded, emitBounded } from "./bounded-telemetry.js";
import { bounded } from "./deadline-utils.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { HOOK_WALL_BUDGET_MS } from "./hook-budgets.js";
import {
	newLspMutationCorrelationId,
	type LspMutationContext,
} from "./lsp-mutation.js";
import {
	getGlobalActionableWarningMaxFixes,
	type PiLensFlagSource,
} from "./lens-config.js";
import { captureLspServiceGeneration } from "./lsp/server.js";
import {
	type LspResyncOutcome,
	chainLateFormatResync,
	resyncHeldLspDocument,
	resyncLspFile,
	runAutofix,
	runFormatPhase,
} from "./pipeline.js";
import { queueAgentAdvisory } from "./agent-nudge.js";
import { holdFileMutationQueue } from "./file-mutation-queue.js";
import { renderFixRunLoss } from "./fix-run-restore.js";
import { getAmbientAbortSignal } from "./safe-spawn.js";
import { type ProjectChangeSource } from "./project-changes.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import {
	type LineageHandle,
	recordDroppedRead,
	sessionFencedFixedThisTurn,
} from "./session-scope.js";
import {
	getAutofixPolicyForFile,
	hasBiomeConfig,
	hasDetektConfig,
	hasEslintConfig,
	hasGolangciConfig,
	hasKtfmtConfig,
	hasKtlintConfig,
	hasOxlintConfig,
	hasRubocopConfig,
	hasSqlfluffConfig,
	hasStylelintConfig,
} from "./tool-policy.js";

/**
 * A queued file is claimed by any flush once it has sat unclaimed by its own
 * owning session for this long — recovery for an orphaned record whose
 * owner (e.g. a primary session that crashed mid-run) will never flush it
 * itself. Generous on purpose: normal same-session flushes never hit this
 * path at all (they match on `ownerSessionId`), so this only trades a little
 * extra staleness for guaranteed eventual formatting. (#791)
 */
const DEFERRED_FORMAT_STALE_AFTER_MS = 10 * 60_000;
const DEFERRED_FORMAT_CONCURRENCY = 3;
/**
 * The formatter aggregate budget the deferred drain hands each file. The
 * post-exit resync waits for the formatter the hook bound gave up on under
 * this same budget, so a command resolution that outlives it (an auto-install
 * has no leaf bound) settles as an abandoned resync instead of parking the
 * detached task forever (#3599). The formatter's later write is then synced by
 * a continuation chained onto its settlement (#3828).
 */
const DEFERRED_FORMAT_BUDGET_MS = 30_000;

interface AgentEndDeps {
	/** Abort signal owned by the agent_end/agent_settled hook. */
	signal?: AbortSignal;
	ctxCwd?: string;
	getFlag: (name: string, filePath?: string) => boolean | string | undefined;
	/** Optional: provenance for dbg/skip logs — see `PipelineContext["getFlagSource"]` (#792). */
	getFlagSource?: (name: string, filePath?: string) => PiLensFlagSource;
	notify: (msg: string, level: "info" | "warning" | "error") => void;
	dbg: (msg: string) => void;
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
	getFormatService: () => FormatService;
	biomeClient?: BiomeClient;
	ruffClient?: RuffClient;
	getAutofixClients?: () => Promise<{
		biomeClient: BiomeClient;
		ruffClient: RuffClient;
	}>;
	/**
	 * The STABLE pi session id for the ctx this `agent_end` fired on. Used to
	 * scope the deferred-format drain to records this session actually
	 * queued (#791) — omit (or leave `undefined`, e.g. in existing tests) to
	 * fall back to today's "claim everything" behavior.
	 */
	currentSessionId?: string;
	/** Test/override hook for {@link DEFERRED_FORMAT_STALE_AFTER_MS}. */
	staleAfterMs?: number;
}

export interface AgentEndFormatSummary {
	queued: number;
	formatted: number;
	changed: string[];
	failed: Array<{ filePath: string; errors: string[] }>;
	skipped: Array<{ filePath: string; reason: string }>;
	/**
	 * Files whose selected formatter had no executable (#2413). Held apart from
	 * `failed`: these are NOT requeued (durable unavailability is not transient)
	 * and NOT surfaced to the user as code errors — the drain records them once
	 * and drops them so the same files never re-fail on every subsequent
	 * agent_end.
	 */
	unavailable: Array<{ filePath: string; formatter: string; reason: string }>;
}

function recordProjectChange(args: {
	runtime: RuntimeCoordinator;
	cwd: string;
	filePath: string;
	source: ProjectChangeSource;
	dbg: (msg: string) => void;
}): void {
	// One mutation seam (#2000 phase 1): bump + receipt + change-log live in
	// RuntimeCoordinator.recordProjectMutation; this wrapper only carries the
	// legacy dbg shape.
	(args.runtime as Partial<RuntimeCoordinator>).recordProjectMutation?.({
		filePath: args.filePath,
		source: args.source,
		cwd: args.cwd,
		onAppendError: (err) =>
			args.dbg(`project change log append failed for ${args.filePath}: ${err}`),
	});
}

/**
 * #4131: the drain's `recordWritten` credits authorship over bytes the agent
 * never saw, so it may only carry forward an authorship whose bytes still
 * hold. One another writer broke since the agent's write ends before the
 * drain rewrites the file, and the drain cannot resume it. The live
 * session's guard only (#3528).
 */
function retireChangedAuthorshipBeforeDrain(
	runtime: RuntimeCoordinator,
	session: LineageHandle,
	filePath: string,
	getFlag: (name: string, filePath?: string) => boolean | string | undefined,
): void {
	if (getFlag("no-read-guard")) return;
	// Optional, as the guard's other per-write members are to a host double.
	session.guardedWrite(filePath, () =>
		runtime.readGuard.retireChangedAuthorship?.(filePath),
	);
}

export async function handleAgentEnd({
	signal,
	ctxCwd,
	getFlag,
	getFlagSource,
	notify,
	dbg,
	runtime,
	cacheManager,
	getFormatService,
	biomeClient,
	ruffClient,
	getAutofixClients,
	currentSessionId,
	staleAfterMs = DEFERRED_FORMAT_STALE_AFTER_MS,
}: AgentEndDeps): Promise<AgentEndFormatSummary | undefined> {
	// Backstop for read captures (#4185 R2-3, round 4). A call's capture is
	// released when the call ends (`handleToolExecutionEnd`); only a run that
	// dies between a read's tool_call and its tool_execution_end (a throw in
	// pi's agent loop takes `handleRunFailure`, which emits agent_end and no
	// tool_execution_end) leaves one, and it must not license an edit in the
	// next run.
	runtime.readGuard.dropProvisionalReads();
	// #791: ownership-filtered drain — records queued by a DIFFERENT known
	// session (e.g. a concurrent in-process secondary/subagent) stay queued
	// for their owner's own agent_end, unless they've been stale long enough
	// to fall back to "claim as orphaned" (see claimDeferredFormatFiles).
	// #3528: the session these records are claimed in. `/new`, fork and resume
	// run while the drain awaits its formatter, and nothing aborts the drain
	// then, so every write into session state below goes through this handle.
	const session = runtime.captureSessionGeneration();
	// #3576: the LSP service the drain started against. session_shutdown and
	// the idle reset retire it without bumping the session above.
	const lspService = captureLspServiceGeneration();
	/**
	 * #3576: the drain's resync of a file it wrote. While its session and its
	 * LSP service are current, a stamped `resyncLspFile` of `read()`. Once
	 * either was replaced, `getLSPService()` would build a fresh service and a
	 * touch would spawn its server, so (R1) the resync goes only to a live
	 * client that already holds the file; undefined then.
	 */
	const syncDrainWrite = async (
		filePath: string,
		read: () => { content: string; readStamp: number },
	): Promise<LspResyncOutcome | undefined> => {
		if (
			session.guardedWrite(filePath, () =>
				lspService.guardedWrite(filePath, () => true),
			)
		) {
			const { content, readStamp } = read();
			return resyncLspFile(
				filePath,
				content,
				true,
				false,
				getFlag,
				dbg,
				readStamp,
			);
		}
		await resyncHeldLspDocument(filePath);
		return undefined;
	};
	const { claimed, staleClaimed, deferredToOwner, droppedOrphans } =
		runtime.claimDeferredMutations(
			currentSessionId,
			Date.now(),
			staleAfterMs,
			ctxCwd ?? runtime.projectRoot,
		);
	const records = [...claimed, ...staleClaimed];
	const scheduledTurnId = records[0]?.queuedTurnId;
	const requeuedKinds = new Set<"autofix" | "format">();
	// S2d (gap 4, #1432 review): the aggregate `agent_end_deferred_mutation_drain`
	// row only carried a coalesced `requeuedKinds` set with no reason, per-call
	// file count, or tool provenance — every requeue (abort mid-drain, missing
	// autofix clients, an autofix/format failure) collapsed into one
	// indistinguishable bucket. Log one bounded record PER requeue call instead,
	// so a real incident can tell "aborted with N files still queued" apart
	// from "M files failed to format".
	const requeue = (
		pending: Parameters<RuntimeCoordinator["requeueDeferredMutations"]>[0],
		reason:
			| "abort"
			| "autofix-failed"
			| "format-failed"
			| "clients-unavailable",
	): void => {
		if (pending.length === 0) return;
		// #3528: a drain that outlived its session requeues nothing into the
		// next session's cleared queue; the drop is one ledger row.
		session.guardedWrite(
			pending.map((queued) => queued.filePath).join(", "),
			() => {
				const kinds = new Set<"autofix" | "format">();
				const toolNames = new Set<string>();
				for (const record of pending) {
					for (const kind of record.kinds) {
						requeuedKinds.add(kind);
						kinds.add(kind);
					}
					for (const toolName of record.toolNames) toolNames.add(toolName);
				}
				logLatency({
					type: "phase",
					toolName: "agent_end",
					filePath: ctxCwd ?? runtime.projectRoot,
					phase: "agent_end_deferred_mutation_requeue",
					turnId: pending[0]?.queuedTurnId,
					durationMs: 0,
					metadata: {
						reason,
						kinds: [...kinds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
						fileCount: pending.length,
						toolNames: [...toolNames].sort((a, b) =>
							a < b ? -1 : a > b ? 1 : 0,
						),
					},
				});
				runtime.requeueDeferredMutations(pending);
			},
		);
	};
	const rootActionableAutofixEnabled = !!getFlag(
		"lens-actionable-warning-autofix",
	);
	// The actionable-warnings cache is only ever written when the
	// "lens-actionable-warnings" writer flag is on (clients/runtime-turn.ts).
	// A reader that ignores this gate always misses in a host where the
	// writer is off and logs "cache missing or expired" at every agent_end,
	// misdirecting the debug log toward a bogus cache problem instead of the
	// real cause: the feature that populates the cache is disabled (#1607).
	const actionableWarningsWriterEnabled = !!getFlag("lens-actionable-warnings");
	// A path-aware source resolver signals that nested configs may re-enable
	// actionable autofix even when the root default is off. Legacy/test hosts
	// without that resolver keep the old fast exit and avoid a cache read.
	const inspectActionableReport =
		actionableWarningsWriterEnabled &&
		typeof cacheManager.readCache === "function" &&
		(rootActionableAutofixEnabled || getFlagSource !== undefined);
	if (droppedOrphans.length > 0) {
		// #1642 F3: a stale/foreign record whose origin (the cwd/worktree it
		// was actually queued under) does NOT match this flush's own
		// workspace/worktree is left queued and NEVER formatted by this
		// flush — claiming it would be the same worktree→parent
		// re-attribution the reported incident hit, just via the orphan
		// fallback instead of tool_result's path resolution. It stays in
		// `_pendingDeferredMutations` (not deleted) so a flush whose origin
		// actually matches can still claim it later; a genuinely abandoned
		// origin will keep surfacing this record on every subsequent
		// agent_end, which is the deliberately safer trade-off over silently
		// losing it forever.
		dbg(
			`agent_end deferred_format: left ${droppedOrphans.length} orphaned file(s) queued due to a mismatched origin (unclaimed >${staleAfterMs}ms, not formatted by this flush): ${droppedOrphans
				.map((r) => `${r.filePath} origin=${r.originCwd}`)
				.join(", ")}`,
		);
		// #1678 item 1: a genuinely abandoned origin re-surfaces the SAME
		// record on every subsequent agent_end for as long as the queued
		// entry lives — by design (see the comment above), but the repo
		// invariant is that a repeated degradation goes through the ledger's
		// counting path instead of accumulating as unbounded raw log lines.
		// The ledger is the single source of truth for whether THIS is a
		// record's first appearance (its return value): the detailed forensic
		// record below names only the orphans on that rising edge, with file
		// identity/origin/age. Every later repeat of
		// the same record is counted ONLY by the ledger's running count —
		// no second raw event, no parallel "already logged" latch to
		// maintain here.
		// #1743: `admitBounded` IS that ledger call, plus the registry
		// membership the bounded-telemetry sweep checks. This site admits PER
		// ORPHAN and then writes ONE batched record naming the admitted ones,
		// which is why it uses `admitBounded` directly instead of a per-record
		// `emitBounded` — the per-call form would turn one log line into N.
		const firstSeenOrphans: typeof droppedOrphans = [];
		for (const record of droppedOrphans) {
			const isFirstOccurrence = admitBounded(
				"agent_end_deferred_format_orphan_origin_mismatch",
				record.filePath,
				{
					ledgerKind: "path-attribution-orphan-unresolved",
					risingEdgePer: "identity",
					reason: `origin=${record.originCwd} unclaimed >${staleAfterMs}ms`,
				},
			);
			if (isFirstOccurrence) firstSeenOrphans.push(record);
		}
		if (firstSeenOrphans.length > 0) {
			// Already admitted above, one orphan at a time — hence no bounding
			// options here. The batch's own identity is the origin this flush ran
			// under; per-file identity rides in `metadata.files`.
			emitBounded(
				"agent_end_deferred_format_orphan_origin_mismatch",
				ctxCwd ?? runtime.projectRoot,
				{
					type: "phase",
					toolName: "agent_end",
					durationMs: 0,
					metadata: {
						fileCount: firstSeenOrphans.length,
						staleAfterMs,
						currentOriginCwd: ctxCwd ?? runtime.projectRoot,
						files: firstSeenOrphans.map((r) => ({
							filePath: r.filePath,
							originCwd: r.originCwd,
							ownerSessionId: r.ownerSessionId,
							queuedTurnIndex: r.queuedTurnIndex,
							ageMs: Date.now() - r.lastTouchedAt,
						})),
					},
				},
			);
		}
	}
	if (records.length === 0 && !inspectActionableReport) return undefined;
	if (deferredToOwner.length > 0) {
		dbg(
			`agent_end deferred_format: leaving ${deferredToOwner.length} file(s) queued for their owning session (${deferredToOwner
				.map((r) => `${r.filePath} owner=${r.ownerSessionId}`)
				.join(", ")})`,
		);
	}
	if (staleClaimed.length > 0) {
		dbg(
			`agent_end deferred_format: staleness fallback claimed ${staleClaimed.length} orphaned file(s) (unclaimed >${staleAfterMs}ms): ${staleClaimed
				.map((r) => r.filePath)
				.join(", ")}`,
		);
		logLatency({
			type: "phase",
			toolName: "agent_end",
			filePath: ctxCwd ?? runtime.projectRoot,
			phase: "agent_end_deferred_format_stale_claim",
			turnId: scheduledTurnId,
			durationMs: 0,
			metadata: {
				fileCount: staleClaimed.length,
				staleAfterMs,
				files: staleClaimed.map((r) => ({
					filePath: r.filePath,
					ownerSessionId: r.ownerSessionId,
					queuedTurnIndex: r.queuedTurnIndex,
					ageMs: Date.now() - r.lastTouchedAt,
				})),
			},
		});
	}
	const startedAt = Date.now();
	const summary: AgentEndFormatSummary = {
		queued: records.length,
		formatted: 0,
		changed: [],
		failed: [],
		skipped: [],
		unavailable: [],
	};
	// #502 fix provenance: per-path {tool, kind} entries accumulated across the
	// deferred-format loop below, passed as `fixes` on the batch
	// publishFilesTouched call so consumers can tell "pi-lens formatted this"
	// from an agent edit.
	const deferredFormatFixes: Array<{
		path: string;
		tool: string;
		kind: "format";
	}> = [];
	const deferredAutofixFixes: Array<{
		path: string;
		tool: string;
		kind: "autofix";
	}> = [];
	const deferredAutofixChanged = new Set<string>();
	// A formatter that outlives the hook budget owns a later disk write. The
	// terminal format event waits for these contained continuations, so a
	// listener never treats pre-late-write bytes as settled (#4213).
	const lateFormatCompletions: Promise<void>[] = [];
	// #3576: runAutofix marks a file fixed after its fixer awaits; a replaced
	// session's mark would skip the next session's own autofix of that file.
	const fixedThisTurn = sessionFencedFixedThisTurn(
		runtime.fixedThisTurn,
		session,
	);
	// #3528 r2: every claimed file a replaced session's drain does not start is
	// named once, not only the first one each loop meets.
	const skipReplaced = (filePath: string): void => {
		if (
			!summary.skipped.some(
				(entry) =>
					entry.filePath === filePath && entry.reason === "session-replaced",
			)
		)
			summary.skipped.push({ filePath, reason: "session-replaced" });
	};

	// Mutation ordering is intentional: lint --write may disturb wrapping, so
	// autofix reaches the final edited state first and formatting stabilizes it.
	const ambientSignal = signal ?? getAmbientAbortSignal();
	const executedAutofixScopes = new Set<string>();
	const autofixRecords = records.filter((candidate) =>
		candidate.kinds.has("autofix"),
	);
	if (
		autofixRecords.length > 0 &&
		(!biomeClient || !ruffClient) &&
		getAutofixClients
	) {
		({ biomeClient, ruffClient } = await getAutofixClients());
	}
	for (
		let autofixIndex = 0;
		autofixIndex < autofixRecords.length;
		autofixIndex++
	) {
		const record = autofixRecords[autofixIndex];
		if (ambientSignal?.aborted) {
			requeue(
				autofixRecords.slice(autofixIndex).map((pending) => ({
					...pending,
					kinds: new Set(["autofix" as const]),
					toolNames: new Set(pending.toolNames),
				})),
				"abort",
			);
			break;
		}
		// #3528 r1 F1: a replaced session's drain starts no new in-place write.
		// Its resync of that write is skipped, and the next session may already
		// have the file open in its LSP (FormatDrain FixNoStartGen).
		const filePath = path.resolve(record.filePath);
		if (session.guardedWrite(filePath, () => true) === undefined) {
			skipReplaced(filePath);
			continue;
		}
		if (!nodeFs.existsSync(filePath)) {
			summary.skipped.push({ filePath, reason: "missing" });
			continue;
		}
		if (!biomeClient || !ruffClient) {
			dbg(`agent_end deferred_autofix: clients unavailable for ${filePath}`);
			requeue(
				[
					{
						...record,
						kinds: new Set(["autofix"]),
						toolNames: new Set(record.toolNames),
					},
				],
				"clients-unavailable",
			);
			continue;
		}
		const policy = getAutofixPolicyForFile(filePath, {
			hasEslintConfig: hasEslintConfig(record.cwd),
			hasStylelintConfig: hasStylelintConfig(record.cwd),
			hasSqlfluffConfig: hasSqlfluffConfig(record.cwd),
			hasRubocopConfig: hasRubocopConfig(record.cwd),
			hasBiomeConfig: hasBiomeConfig(record.cwd),
			hasGolangciConfig: hasGolangciConfig(record.cwd),
			hasDetektConfig: hasDetektConfig(record.cwd),
			hasOxlintConfig: hasOxlintConfig(record.cwd),
			hasKtfmtConfig: hasKtfmtConfig(record.cwd),
			hasKtlintConfig: hasKtlintConfig(record.cwd),
		});
		const scopeKey =
			policy?.scope && policy.scope !== "file"
				? `${policy.defaultTool ?? "unknown"}:${path.resolve(record.cwd)}`
				: `${policy?.defaultTool ?? "unknown"}:${filePath}`;
		if (executedAutofixScopes.has(scopeKey)) continue;
		executedAutofixScopes.add(scopeKey);
		// #4131: the fixer's recordWritten below credits authorship without
		// bytes the agent saw, so it may only advance one whose bytes still hold.
		retireChangedAuthorshipBeforeDrain(runtime, session, filePath, getFlag);
		// #3506: the fixer rewrites the file in place, inside pi's queue, which
		// runAutofix enters only once the fixer is resolved.
		const fixHold = holdFileMutationQueue(filePath);
		let restoring: Awaited<ReturnType<typeof runAutofix>>["restoring"];
		try {
			const result = await runAutofix(
				filePath,
				record.cwd,
				getFlag,
				dbg,
				{ biomeClient, ruffClient, fixedThisTurn },
				getFlagSource,
				fixHold,
			);
			restoring = result.restoring;
			const tools = result.autofixTools.map((label) => label.split(":")[0]);
			for (const changed of result.changedFiles) {
				const changedPath = path.resolve(changed);
				deferredAutofixChanged.add(changedPath);
				for (const tool of tools)
					deferredAutofixFixes.push({
						path: changedPath,
						tool,
						kind: "autofix",
					});
				if (!nodeFs.existsSync(changedPath)) continue;
				// The loop index is in range; `!` keeps the strict-indexed spike
				// count flat (tests/config/strictness-baseline.json).
				const queuedBranchEpoch = record!.readGuardBranchEpoch;
				// #3528: this session's change log, read guard and turn state only.
				const landed = session.guardedWrite(changedPath, () => {
					recordProjectChange({
						runtime,
						cwd: record.turnStateCwd,
						filePath: changedPath,
						source: "autofix",
						dbg,
					});
					// #3525: bytes the agent never saw; authorship, not FileTime.
					if (!getFlag("no-read-guard"))
						runtime.readGuard.recordWritten(changedPath, {
							authorship: "whole-file",
							branchEpoch: queuedBranchEpoch,
							stampFileTime: false,
						});
					const content = nodeFs.readFileSync(changedPath, "utf-8");
					cacheManager.addModifiedRange(
						changedPath,
						{ start: 1, end: content.split("\n").length },
						/^import\s/m.test(content),
						record.turnStateCwd,
						currentSessionId ?? runtime.telemetrySessionId,
						"pi",
					);
					return true;
				});
				// #3611 F1: the read guard lost this authorship; count it by reason.
				if (landed === undefined && !getFlag("no-read-guard"))
					recordDroppedRead(session, "deferred-autofix", queuedBranchEpoch);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			summary.failed.push({ filePath, errors: [message] });
			requeue(
				[
					{
						...record,
						kinds: new Set(["autofix"]),
						toolNames: new Set(record.toolNames),
					},
				],
				"autofix-failed",
			);
		} finally {
			fixHold?.release();
		}
		// The restore of agent edits the fixer overwrote waits for pi's queue
		// entries (#3830), so it is awaited here, after the hold is released,
		// never inside it.
		const loss = await restoring;
		if (loss && (loss.lost.length > 0 || loss.possiblyLost.length > 0)) {
			// The agent's turn is over, so a UI notify alone reaches nobody it
			// could act through (and print/json modes drop it): queue the same
			// text for the model's next `context` call as well.
			const text = renderFixRunLoss(loss);
			queueAgentAdvisory(text, session);
			notify(`pi-lens: ${text}`, "warning");
		}
	}
	if (deferredAutofixFixes.length > 0) {
		publishFilesTouched({
			reason: "autofix",
			paths: [...new Set(deferredAutofixFixes.map((fix) => fix.path))],
			cwd: ctxCwd ?? runtime.projectRoot,
			dbg,
			fixes: deferredAutofixFixes,
		});
	}

	dbg(`agent_end deferred_format: ${records.length} file(s)`);
	logLatency({
		type: "phase",
		toolName: "agent_end",
		filePath: ctxCwd ?? runtime.projectRoot,
		phase: "agent_end_deferred_format_start",
		turnId: scheduledTurnId,
		durationMs: 0,
		metadata: {
			fileCount: records.length,
			currentSessionId,
			// #791: per-record provenance so a future incident can be diagnosed
			// straight from latency.log — which session/turn queued each file,
			// and whether it was claimed via the staleness fallback.
			records: records.map((r) => ({
				filePath: r.filePath,
				queuedTurnIndex: r.queuedTurnIndex,
				ownerSessionId: r.ownerSessionId,
				staleClaim: staleClaimed.includes(r),
			})),
			deferredToOwnerCount: deferredToOwner.length,
		},
	});
	// #673: same moment as the latency phase above — a same-process listener
	// (e.g. a review/snapshot controller) can use this to know the deferred-
	// format phase is starting and these specific paths may still be mutated.
	if (records.length > 0) {
		const batch = records[0]!;
		publishFormatStart({
			cwd: ctxCwd ?? runtime.projectRoot,
			paths: records.map((r) => r.filePath),
			dbg,
			kinds: [...new Set(records.flatMap((record) => [...record.kinds]))],
			...(batch.ownerSessionId === undefined
				? {}
				: { ownerSessionId: batch.ownerSessionId }),
			turnIndex: batch.queuedTurnIndex,
			batchId: batch.queuedTurnId,
		});
	}

	const formatRecords = records
		.filter((record) => record.kinds.has("format"))
		.filter((record) => {
			const disabled = !!getFlag("no-autoformat", record.filePath);
			if (disabled) {
				const source = getFlagSource?.("no-autoformat", record.filePath);
				dbg(
					`agent_end deferred_format: skipping ${record.filePath} (--no-autoformat${source ? `, source=${source}` : ""})`,
				);
				summary.skipped.push({
					filePath: record.filePath,
					reason: "no-autoformat",
				});
			}
			return !disabled;
		});

	if (formatRecords.length > 0) {
		// Formatter subprocesses are independent across files, so retain bounded
		// overlap here. Result application stays admission-ordered below because
		// its synchronous file reads/bookkeeping are observable shared state.
		type FormatWork = {
			record: (typeof formatRecords)[number];
			filePath: string;
			fileStart: number;
			result: Awaited<ReturnType<typeof runFormatPhase>> | undefined;
			error?: string;
			missing?: boolean;
		};
		const work: (FormatWork | undefined)[] = [];
		work.length = formatRecords.length;
		const started = new Set<number>();
		const unsettledFormatPaths = new Set<string>();
		let terminalFormatEventPublished = false;
		const batchIdentity = records[0]!;
		const publishUnsettled = () => {
			if (terminalFormatEventPublished || unsettledFormatPaths.size === 0)
				return;
			terminalFormatEventPublished = true;
			recordDegradationOnce({
				kind: "deferred-format-unsettled",
				subject: batchIdentity.queuedTurnId,
				reason:
					"a deferred formatter remained unsettled after the bounded drain; the done event names the pending files and settled=false",
			});
			publishFormatDone({
				cwd: ctxCwd ?? runtime.projectRoot,
				paths: [...unsettledFormatPaths],
				kinds: ["format"],
				...(batchIdentity.ownerSessionId === undefined
					? {}
					: { ownerSessionId: batchIdentity.ownerSessionId }),
				turnIndex: batchIdentity.queuedTurnIndex,
				batchId: batchIdentity.queuedTurnId,
				settled: false,
				dbg,
			});
		};
		let nextIndex = 0;
		const worker = async (): Promise<void> => {
			while (nextIndex < formatRecords.length) {
				const index = nextIndex++;
				if (ambientSignal?.aborted) return;
				const record = formatRecords[index];
				const fileStart = Date.now();
				const filePath = path.resolve(record.filePath);
				// #3528 r1 F1: as in the autofix loop, no new format after /new.
				if (session.guardedWrite(filePath, () => true) === undefined) {
					skipReplaced(filePath);
					continue;
				}
				started.add(index);
				if (!nodeFs.existsSync(filePath)) {
					work[index] = {
						record,
						filePath,
						fileStart,
						result: undefined,
						missing: true,
					};
					continue;
				}
				// #4131: as in the autofix loop, before the formatter rewrites it.
				retireChangedAuthorshipBeforeDrain(runtime, session, filePath, getFlag);
				// #3506: the formatter rewrites the file in place, and its read-back
				// belongs to the same hold. The release follows the phase itself,
				// not this bound, and an abandoned formatter keeps it until its
				// child settles.
				const formatHold = holdFileMutationQueue(filePath);
				try {
					const phase = runFormatPhase(
						filePath,
						getFormatService,
						dbg,
						ambientSignal,
						DEFERRED_FORMAT_BUDGET_MS,
						"agent_settled",
						formatHold,
					).finally(() => formatHold?.release());
					work[index] = {
						record,
						filePath,
						fileStart,
						result: await bounded(phase, {
							ms: HOOK_WALL_BUDGET_MS.agent_settled,
							signal: ambientSignal,
							hook: "agent_settled",
							label: "deferred-format",
						}),
					};
					const abandoned = work[index]?.result?.abandoned;
					if (abandoned) {
						lateFormatCompletions.push(
							chainLateFormatResync(
								abandoned,
								"deferred",
								{ toolName: "agent_end", filePath, startedAt: fileStart },
								dbg,
							),
						);
					}
					// #3529: the bound gave up on the phase, not on its formatter
					// child, which writes F later. Once the phase and every formatter
					// it gave up on have settled, sync a fresh stamped read of F, or
					// the LSP keeps the bytes from before the format.
					if (!work[index]?.result) {
						if (!ambientSignal?.aborted) {
							unsettledFormatPaths.add(filePath);
							publishUnsettled();
						}
						void (async () => {
							let outcome: LspResyncOutcome | "stale-session" | "read-failed" =
								"stale-session";
							try {
								// #3599: the abandoned formatter's command resolution can outlive
								// every leaf bound (an auto-install has none), so wait for the
								// formatter under the drain's own budget instead of forever. A
								// wait that expires is a degradation, recorded once by
								// `bounded()` as `off_hook:deferred-format-post-exit-resync`.
								const formatterSettling = phase
									.then((summary) => summary.abandoned)
									.then(() => true as const);
								const formatterSettled = await bounded(formatterSettling, {
									ms: DEFERRED_FORMAT_BUDGET_MS,
									signal: ambientSignal,
									hook: "off_hook",
									label: "deferred-format-post-exit-resync",
								});
								if (formatterSettled === undefined) {
									// The formatter is still running, so a read now could publish
									// bytes it is about to replace. Report this resync as abandoned
									// and chain the same resync onto the formatter's settlement
									// instead (#3828): it parks no awaiting task and holds no
									// resource, it is one more reaction on a promise the formatter
									// already owns.
									outcome = "abandoned";
									// Held-only in every case (#3828): the install can outlive
									// the client (idle eviction), and this must never open a
									// file or spawn for it.
									lateFormatCompletions.push(
										chainLateFormatResync(
											formatterSettling,
											"deferred",
											{ toolName: "agent_end", filePath, startedAt: fileStart },
											dbg,
										),
									);
								} else {
									// #3528 r1 F1, #3576: a replaced session or a retired LSP
									// service gets no touch that would spawn a server.
									outcome =
										(await syncDrainWrite(filePath, () => {
											const readStamp = performance.now();
											return {
												readStamp,
												content: nodeFs.readFileSync(filePath, "utf-8"),
											};
										})) ?? "stale-session";
								}
							} catch (err) {
								outcome = "read-failed";
								dbg(
									`agent_end deferred_format post-exit resync failed for ${filePath}: ${err}`,
								);
							}
							logLatency({
								type: "phase",
								toolName: "agent_end",
								filePath,
								phase: "deferred_format_post_exit_resync",
								durationMs: Date.now() - fileStart,
								metadata: { outcome },
							});
						})();
					}
				} catch (err) {
					work[index] = {
						record,
						filePath,
						fileStart,
						result: undefined,
						error: err instanceof Error ? err.message : String(err),
					};
				}
			}
		};
		await Promise.all(
			Array.from(
				{ length: Math.min(DEFERRED_FORMAT_CONCURRENCY, formatRecords.length) },
				() => worker(),
			),
		);
		if (ambientSignal?.aborted) {
			requeue(
				formatRecords
					.filter((_, index) => !started.has(index))
					.map((record) => ({
						...record,
						kinds: new Set(["format" as const]),
						toolNames: new Set(record.toolNames),
					})),
				"abort",
			);
		}

		for (const entry of work) {
			if (!entry) continue;
			await new Promise<void>((resolve) => setImmediate(resolve));
			const { record, filePath, fileStart } = entry;
			if (entry.missing) {
				dbg(`agent_end deferred_format skipped missing file: ${filePath}`);
				if (
					!summary.skipped.some(
						(item) => item.filePath === filePath && item.reason === "missing",
					)
				) {
					summary.skipped.push({ filePath, reason: "missing" });
				}
				continue;
			}
			if (entry.error) {
				dbg(`agent_end deferred_format failed for ${filePath}: ${entry.error}`);
				summary.failed.push({ filePath, errors: [entry.error] });
				requeue(
					[
						{
							...record,
							kinds: new Set(["format"]),
							toolNames: new Set(record.toolNames),
						},
					],
					"format-failed",
				);
				continue;
			}
			const result = entry.result;
			if (!result) {
				// The abort branch above already requeues work that never started;
				// preserve its established ownership for an in-flight caller abort.
				if (ambientSignal?.aborted) continue;
				const reason =
					entry.error ?? "deferred formatter exceeded agent_settled budget";
				summary.failed.push({ filePath, errors: [reason] });
				requeue(
					[
						{
							...record,
							kinds: new Set(["format"]),
							toolNames: new Set(record.toolNames),
						},
					],
					"format-failed",
				);
				continue;
			}

			summary.formatted++;

			if (result.formatFailures.length > 0) {
				summary.failed.push({ filePath, errors: result.formatFailures });
				requeue(
					[
						{
							...record,
							kinds: new Set(["format"]),
							toolNames: new Set(record.toolNames),
						},
					],
					"format-failed",
				);
			}

			// #2413: an unavailable formatter is durable, not transient — record it
			// once and DO NOT requeue. Requeuing here is exactly what made
			// `spawn oxfmt ENOENT` re-fire on every agent_end for the same files.
			if (result.formatUnavailable.length > 0) {
				for (const u of result.formatUnavailable) {
					summary.unavailable.push({
						filePath,
						formatter: u.formatter,
						reason: u.reason,
					});
				}
			}

			if (result.formatChanged) {
				summary.changed.push(filePath);
				for (const tool of result.formattersUsed) {
					deferredFormatFixes.push({ path: filePath, tool, kind: "format" });
				}
				// turnStateCwd is required on DeferredFormatRecord (PR #114) — the
				// previous fallback chain through ctxCwd / projectRoot / record.cwd
				// could silently regress the monorepo cwd-mismatch fix from PR #105.
				const bookkeepingCwd = record.turnStateCwd;
				const queuedBranchEpoch = record.readGuardBranchEpoch;
				// #3528: this session's change log, read guard, turn state and turn
				// summary only.
				const landed = session.guardedWrite(filePath, () => {
					recordProjectChange({
						runtime,
						cwd: bookkeepingCwd,
						filePath,
						source: "format",
						dbg,
					});
					// #3525: bytes the agent never saw; authorship, not FileTime.
					if (!getFlag("no-read-guard")) {
						runtime.readGuard.recordWritten(filePath, {
							authorship: "whole-file",
							branchEpoch: queuedBranchEpoch,
							stampFileTime: false,
						});
					}
					try {
						const content = nodeFs.readFileSync(filePath, "utf-8");
						const lineCount = content.split("\n").length;
						const hasImports = /^import\s/m.test(content);
						cacheManager.addModifiedRange(
							filePath,
							{ start: 1, end: lineCount },
							hasImports,
							bookkeepingCwd,
							currentSessionId ?? runtime.telemetrySessionId,
							"pi",
						);
					} catch (err) {
						dbg(
							`agent_end deferred_format modified-range tracking failed for ${filePath}: ${err}`,
						);
					}

					// #484: opt-in per-turn summary — deferred format is the OTHER
					// half of the format signal (immediate-mode is recorded at the
					// runtime-tool-result.ts seam); same result.formattersUsed the
					// latency phase below already logs, no new plumbing.
					if (getFlag("lens-turn-summary")) {
						for (const tool of result.formattersUsed) {
							runtime.turnSummary.recordFormat(filePath, { tool });
						}
					}
					return true;
				});
				// #3611 F1: the read guard lost this authorship; count it by reason.
				if (landed === undefined && !getFlag("no-read-guard"))
					recordDroppedRead(session, "deferred-format", queuedBranchEpoch);
			}

			if (result.fileContent) {
				const fileContent = result.fileContent;
				// #3528 r1 F1, #3576: not into a replaced session's or a retired
				// LSP service.
				await syncDrainWrite(filePath, () => ({
					content: fileContent,
					// #3529: the next run's edit can land once the hold is released,
					// and its own stamped sync must not be replaced by this older read.
					readStamp: result.fileReadStamp,
				}));
			}

			dbg(
				`agent_end deferred_format file ${filePath}: changed=${result.formatChanged} duration=${Date.now() - fileStart}ms`,
			);
			logLatency({
				type: "phase",
				toolName: "agent_end",
				filePath,
				phase: "deferred_format_file",
				turnId: record.queuedTurnId,
				durationMs: Date.now() - fileStart,
				metadata: {
					changed: result.formatChanged,
					formattersUsed: result.formattersUsed,
					failureCount: result.formatFailures.length,
				},
			});
		}

		if (summary.changed.length > 0) {
			publishFilesTouched({
				reason: "format",
				paths: summary.changed,
				cwd: ctxCwd ?? runtime.projectRoot,
				dbg,
				fixes: deferredFormatFixes,
			});
		}
		const publishDone = () =>
			publishFormatDone({
				cwd: ctxCwd ?? runtime.projectRoot,
				paths: summary.changed,
				kinds: ["format"],
				...(records[0]!.ownerSessionId === undefined
					? {}
					: { ownerSessionId: records[0]!.ownerSessionId }),
				turnIndex: records[0]!.queuedTurnIndex,
				batchId: records[0]!.queuedTurnId,
				settled: true,
				dbg,
			});
		if (!terminalFormatEventPublished) {
			if (lateFormatCompletions.length === 0) publishDone();
			else
				void Promise.all(lateFormatCompletions).then(() => {
					if (!terminalFormatEventPublished) publishDone();
				});
		}
	}

	// LSP sees only authoritative content after both mutation phases. In
	// particular, never publish the autofix intermediate state before format.
	for (const changedPath of deferredAutofixChanged) {
		if (!nodeFs.existsSync(changedPath)) continue;
		// #3528 r1 F1, #3576: not into a replaced session's or a retired LSP
		// service.
		await syncDrainWrite(changedPath, () => {
			// #3529: stamped, like the format resync above.
			const readStamp = performance.now();
			return {
				readStamp,
				content: nodeFs.readFileSync(changedPath, "utf-8"),
			};
		});
	}

	// #3576: a replaced session's drain applies no quickfix. Its edits and
	// their bookkeeping would land in the next session, and the pass's
	// getLSPService() would build a fresh service after resetLSPService.
	const actionCwd = ctxCwd ?? runtime.projectRoot;
	if (
		inspectActionableReport &&
		session.guardedWrite(`actionable-warnings:${actionCwd}`, () =>
			lspService.guardedWrite(`actionable-warnings:${actionCwd}`, () => true),
		)
	) {
		const actionableWarningsMaxAgeMs = 10 * 60_000;
		const actionReport = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			actionCwd,
			actionableWarningsMaxAgeMs,
		);
		if (!actionReport?.data) {
			// Distinguish "no cache file was ever written" from "a cache file
			// exists but its TTL elapsed" (#1607) — both used to collapse into
			// one "cache missing or expired" line, which doesn't tell a reader
			// whether the writer ran and produced a stale file, or never ran.
			const inspection =
				typeof cacheManager.inspectCache === "function"
					? cacheManager.inspectCache(
							"actionable-warnings",
							actionCwd,
							actionableWarningsMaxAgeMs,
						)
					: undefined;
			if (inspection === "missing") {
				dbg(
					"agent_end actionable_warnings_autofix: cache absent, skipping fixes",
				);
			} else if (inspection === "stale") {
				dbg(
					"agent_end actionable_warnings_autofix: cache expired, skipping fixes",
				);
			} else {
				dbg(
					`agent_end actionable_warnings_autofix: cache missing or expired${inspection ? ` (${inspection})` : ""}, skipping fixes`,
				);
			}
		} else {
			const enabledFiles = actionReport.data.files.filter((file) => {
				// #1247: the per-edit dispatch surface gates ignored files before
				// running; the turn-end autofix must apply the same filter or a
				// `.pi-lens.json` `ignore` entry cannot protect a prose file
				// (CHANGELOG.md / AGENTS.md) from being rewritten here.
				if (
					isPathIgnoredByProject(file.filePath, ctxCwd ?? runtime.projectRoot)
				) {
					dbg(
						`agent_end actionable_warnings_autofix: skipped ${file.filePath} (ignored by project)`,
					);
					return false;
				}
				const enabled = !!getFlag(
					"lens-actionable-warning-autofix",
					file.filePath,
				);
				if (!enabled) {
					const source = getFlagSource?.(
						"lens-actionable-warning-autofix",
						file.filePath,
					);
					dbg(
						`agent_end actionable_warnings_autofix: skipped ${file.filePath} (disabled${source ? `, source=${source}` : ""})`,
					);
				}
				return enabled;
			});
			const eligibleCount = enabledFiles.reduce(
				(total, file) =>
					total +
					file.warnings.reduce(
						(count, warning) =>
							count +
							(warning.suppressed
								? 0
								: warning.actions.filter((action) => action.autoFixEligible)
										.length),
						0,
					),
				0,
			);
			const eligibleReport: ActionableWarningsReport = {
				...actionReport.data,
				files: enabledFiles,
				summary: {
					...actionReport.data.summary,
					files: enabledFiles.length,
					autoFixEligible: eligibleCount,
				},
			};
			const freshness = checkActionableWarningsReportFresh({
				report: eligibleReport,
				currentProjectSeq: runtime.projectSeq,
				getFileSeq: (filePath) => runtime.getFileSeq(filePath),
			});
			if (!freshness.fresh) {
				dbg(
					`agent_end actionable_warnings_autofix: stale report (${freshness.reason}; reportProjectSeqEnd=${freshness.reportProjectSeqEnd ?? "missing"}; currentProjectSeq=${freshness.currentProjectSeq}${freshness.filePath ? `; file=${freshness.filePath}; reportFileSeq=${freshness.reportFileSeq}; currentFileSeq=${freshness.currentFileSeq}` : ""}), skipping fixes`,
				);
			} else if (eligibleReport.summary.autoFixEligible > 0) {
				// #684: same "genuine work about to happen" gate as
				// publishFormatStart — only fires when the report is fresh AND
				// has at least one autofix-eligible warning, right before
				// applyConservativeActionableWarningFixes actually starts.
				const fixableFiles = eligibleReport.files.filter((file) =>
					file.warnings.some(
						(warning) =>
							!warning.suppressed &&
							warning.actions.some((action) => action.autoFixEligible),
					),
				);
				publishAutofixStart({
					cwd: ctxCwd ?? runtime.projectRoot,
					paths: fixableFiles.map((file) => file.filePath),
					eligibleCount: eligibleReport.summary.autoFixEligible,
					dbg,
				});
				const fixStart = Date.now();
				const fixCwd = ctxCwd ?? runtime.projectRoot;
				// #3676: the fix acts on report entries, and they are its evidence:
				// it is credited with the oldest branch epoch among the entries it
				// can fix (`ReadGuard.recordWritten` refuses it once a /tree moved
				// the branch since), never with this settle's own epoch. An entry
				// built under another read guard (a /fork, /new or resume restarts
				// the epoch at 0), or with no valid stamp, has no branch to vouch
				// for; the fix is applied and credited to none.
				const credit = quickFixCreditEpoch(
					fixableFiles,
					runtime.readGuard.lineageKey,
				);
				if (credit === undefined && !getFlag("no-read-guard")) {
					recordDegradationOnce({
						kind: "actionable-warnings-quickfix-uncredited",
						subject: fixCwd,
						reason:
							"an actionable-warnings entry the quick fix acts on was built under another read guard, or carries no valid branch stamp; its fixes are applied and credited to no branch",
					});
				}
				// #4131, #4187 R4-4: the quickfix's `recordWritten` below credits
				// authorship over bytes the agent never saw, so it may only carry
				// forward an authorship whose bytes still hold. One other writer
				// broke since the agent's write ends here, before the fix rewrites
				// around it — the pre-write check the format and autofix drains
				// already run, and the third drain writer it was missing on.
				for (const file of fixableFiles)
					retireChangedAuthorshipBeforeDrain(
						runtime,
						session,
						file.filePath,
						getFlag,
					);
				const mutationContext: LspMutationContext = {
					cwd: fixCwd,
					correlationId: newLspMutationCorrelationId(),
					// #4187 R4-1: no `toolCallId` — a drain has no tool call, so
					// `bookkeepLspMutation`'s `advanceAuthorship: true` reaches the
					// guard unlicensed and cannot re-baseline an authorship. The
					// retire below is this drain's pre-write check instead, the one
					// the format and autofix drains already run.
					tool: "lsp-quickfix",
					source: "autofix",
					runtime,
					cacheManager,
					readGuard:
						getFlag("no-read-guard") || credit === undefined
							? undefined
							: {
									// #3525: bytes the agent never saw; authorship, not FileTime.
									// #4187 R4-4: the wrapper deliberately records a DRAIN write,
									// not the LSP bookkeeping's licensed tool write: it drops
									// `advanceAuthorship: true`, so the credit is the drain's own
									// (retire before, advance over its rewrite) and not an
									// unlicensed advance over a byte nothing checked.
									recordWritten: (filePath: string) =>
										runtime.readGuard.recordWritten(filePath, {
											authorship: "whole-file",
											branchEpoch: credit,
											stampFileTime: false,
										}),
								},
					// #3576: a /new during the pass stops it and its bookkeeping.
					session,
					recordAutofix: getFlag("lens-turn-summary")
						? (filePath) =>
								runtime.turnSummary.recordAutofix(filePath, {
									tool: "lsp-quickfix",
								})
						: undefined,
					dbg,
				};
				const fixSummary = await applyConservativeActionableWarningFixes({
					cwd: fixCwd,
					report: eligibleReport,
					maxFixes: getGlobalActionableWarningMaxFixes(),
					dbg,
					mutationContext,
				});
				if (fixSummary.changedFiles.length > 0) {
					publishFilesTouched({
						reason: "autofix",
						paths: fixSummary.changedFiles,
						cwd: ctxCwd ?? runtime.projectRoot,
						dbg,
						fixes: fixSummary.changedFiles.map((changedFile) => ({
							path: changedFile,
							tool: "lsp-quickfix",
							kind: "autofix" as const,
						})),
					});
				}
				logLatency({
					type: "phase",
					toolName: "agent_end",
					filePath: ctxCwd ?? runtime.projectRoot,
					phase: "actionable_warnings_autofix",
					turnId: scheduledTurnId,
					durationMs: Date.now() - fixStart,
					metadata: {
						considered: fixSummary.considered,
						applied: fixSummary.applied,
						changedFiles: fixSummary.changedFiles.length,
						skipped: fixSummary.skipped.length,
					},
				});
				if (fixSummary.applied > 0) {
					notify(
						`pi-lens applied ${fixSummary.applied} conservative LSP warning quickfix(es)`,
						"info",
					);
				}
			} else {
				dbg(
					"agent_end actionable_warnings_autofix: fresh report, 0 autofix-eligible warnings, skipping",
				);
			}
		}
	}

	logLatency({
		type: "phase",
		toolName: "agent_end",
		filePath: ctxCwd ?? runtime.projectRoot,
		phase: "agent_end_deferred_mutation_drain",
		turnId: scheduledTurnId,
		durationMs: Date.now() - startedAt,
		metadata: {
			autofixRecords: autofixRecords.length,
			formatRecords: formatRecords.length,
			coalescedPaths: records.length,
			requeuedKinds: [...requeuedKinds].sort((a, b) =>
				a < b ? -1 : a > b ? 1 : 0,
			),
		},
	});
	logLatency({
		type: "tool_result",
		toolName: "agent_end",
		filePath: ctxCwd ?? runtime.projectRoot,
		durationMs: Date.now() - startedAt,
		result: "deferred_format_complete",
		turnId: scheduledTurnId,
		metadata: {
			queued: summary.queued,
			formatted: summary.formatted,
			changed: summary.changed.length,
			failed: summary.failed.length,
			skipped: summary.skipped.length,
			unavailable: summary.unavailable.length,
		},
	});
	logLatency({
		type: "phase",
		toolName: "agent_end",
		filePath: ctxCwd ?? runtime.projectRoot,
		phase: "agent_end_deferred_format_done",
		turnId: scheduledTurnId,
		durationMs: Date.now() - startedAt,
		metadata: {
			formatted: summary.formatted,
			changed: summary.changed.length,
			failed: summary.failed.length,
			skipped: summary.skipped.length,
			unavailable: summary.unavailable.length,
		},
	});
	dbg(
		`agent_end deferred_format complete: formatted=${summary.formatted} changed=${summary.changed.length} failed=${summary.failed.length} skipped=${summary.skipped.length} unavailable=${summary.unavailable.length}`,
	);

	if (summary.failed.length > 0) {
		notify(
			`pi-lens deferred format: ${summary.changed.length} changed, ${summary.failed.length} failed`,
			"warning",
		);
	} else if (summary.changed.length > 0 && !getFlag("lens-turn-summary")) {
		// The info-level success toast is redundant once the turn-summary entry
		// (#484) is opted in — it would repeat the same "N reformatted" fact the
		// transcript entry already carries. Failures above stay untouched either way.
		const names = summary.changed.map((f) => path.basename(f)).join(", ");
		notify(
			`pi-lens deferred format applied to ${summary.changed.length} file(s): ${names}`,
			"info",
		);
	}

	return summary;
}
