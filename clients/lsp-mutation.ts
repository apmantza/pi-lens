import * as path from "node:path";
import { BoundedSet } from "./bounded-cache.js";
import {
	createReadGuardEditBatchSummary,
	getReadGuardCorrelationId,
	logReadGuardEvent,
	type ReadGuardEditBatchSummary,
} from "./read-guard-logger.js";
import {
	type ProjectChangeRange,
	type ProjectChangeSource,
} from "./project-changes.js";
import type { LineageHandle } from "./session-scope.js";
import type { AppliedWorkspaceEdit } from "./lsp/edits.js";
import { normalizeMapKey } from "./path-utils.js";
import {
	getMutationBridge,
	type MutationBridgeDeps,
	type MutationBridgeEntry,
	recordMutationOutcome,
} from "./mutation-bridge.js";
import { recordDegradationOnce } from "./degradation-ledger.js";

// #2450 fix round 3 (minor): gates the "bridge unavailable" dbg line to fire
// once per session, not once per FILE — a rename that touches many files in
// a bridge-less process (e.g. the MCP server) would otherwise spam the same
// line once per touched file. `recordDegradationOnce` itself has no
// first-occurrence return value (unlike `incrementDegradationCount`), so this
// tiny local latch is the minimal way to mirror that "once" intent onto the
// dbg line without changing the ledger's own once-per-(kind,subject) record.
//
// Catalog shape 17 (a process-lifetime latch must re-arm at session_start):
// wired into `handleSessionStart` (`clients/runtime-session.ts`) directly,
// NOT into `resetDegradationLedger()` — that lives in `degradation-ledger.ts`,
// which this module already imports, and reaching back from there to here
// would be a cycle.
let noBridgeDbgLogged = false;
export function resetLspMutationNoBridgeDbgLatch(): void {
	noBridgeDbgLogged = false;
}
/**
 * Test-only peek at the latch's current value (#2450 fix round 5, F2) — lets
 * the session-state registry probe the actual internal state instead of
 * inferring it from captured dbg messages, the same pattern every other
 * process-private-scalar probe in `tests/support/session-state-registry.ts`
 * uses (e.g. `_observedMutationStateForTests`).
 */
export function _lspMutationNoBridgeDbgLoggedForTests(): boolean {
	return noBridgeDbgLogged;
}

interface LspMutationRuntime {
	bumpFileSeq?: (filePath: string) => { projectSeq: number; fileSeq: number };
	/** One mutation seam (#2000 phase 1) — bump + receipt + change-log. */
	recordProjectMutation?: (args: {
		filePath: string;
		source: ProjectChangeSource;
		cwd?: string;
		changedRange?: ProjectChangeRange;
		sessionId?: string | undefined;
		onAppendError?: (err: unknown) => void;
	}) => { projectSeq: number; fileSeq: number };
	telemetrySessionId?: string;
	turnIndex?: number;
	/**
	 * #2450 fix round 3 (F4): the recordability gate the bridge fallback
	 * applies (`index.ts`'s `registerMutationBridge`/`registerReadBridge`)
	 * judges a path against `runtime.projectRoot`, not the request's `cwd` —
	 * a rename issued from a sub-package `cwd` that touches a sibling
	 * package must not be judged "external" just because the sub-package
	 * isn't the request root. Optional so callers that never threaded a
	 * runtime (or whose runtime has no notion of a project root) keep prior
	 * behavior of falling back to `cwd`.
	 */
	projectRoot?: string;
	/**
	 * #3763: the session a tool call runs in, captured at its `execute` entry
	 * into `LspMutationContext.session`.
	 */
	captureSessionGeneration?: () => LineageHandle;
}

interface LspMutationCacheManager {
	addModifiedRange: (
		filePath: string,
		range: { start: number; end: number },
		importsChanged: boolean,
		cwd: string,
		sessionId?: string,
		ownerKind?: "pi",
		/**
		 * #2504 review round 2 (F1): the root the worklist's containment filter
		 * judges against. `cwd` still selects which `turn-state.json` the entry
		 * lands in; this says which paths BELONG to that project. They differ
		 * for exactly the caller below — a `cwd`-scoped context for a call
		 * issued from a sub-package of a monorepo-wide server's root.
		 */
		projectRoot?: string,
	) => unknown;
}

export interface LspMutationContext {
	cwd: string;
	/** Stable session id for the activation issuing the edit. */
	sessionId?: string;
	correlationId: string;
	/**
	 * #4187 R4-1: the pi tool call this mutation belongs to, when one issued
	 * it (`tools/lsp-navigation.ts` passes its `_toolCallId`). The read guard
	 * licenses an authorship advance per call, and an LSP edit writes a set
	 * wider than the one the call named (a rename's importers), so only a
	 * licensed path may advance. A caller with no call of its own — a
	 * server-initiated `workspace/applyEdit` (`clients/lsp/client.ts`) or the
	 * agent_end quickfix drain — names none, and its write can only end an
	 * authorship whose bytes it changed.
	 */
	toolCallId?: string;
	tool: string;
	/**
	 * `"lsp-edit"` is the generic/legacy value; `"lsp-rename"` and
	 * `"lsp-execute-command"` name the specific LSP operation that produced the
	 * write, so the change-log receipt tells a rename apart from an
	 * executeCommand-solicited edit instead of collapsing both onto one generic
	 * tag (#2450).
	 */
	source: "lsp-edit" | "lsp-rename" | "lsp-execute-command" | "autofix";
	runtime?: LspMutationRuntime;
	/** The stamp `recordMutationOutcome` drives for the direct branch. */
	readGuard?: {
		recordWritten: NonNullable<
			ReturnType<MutationBridgeDeps["getRuntime"]>["readGuard"]["recordWritten"]
		>;
	};
	cacheManager?: LspMutationCacheManager;
	/** Existing autonomous-write publishers. Agent-owned navigation edits do not set these. */
	publishFilesTouched?: (paths: string[]) => void;
	recordAutofix?: (filePath: string) => void;
	dbg?: (message: string) => void;
	/** Batch callers can defer the single terminal log until all edits are attempted. */
	emitSummary?: boolean;
	/**
	 * #3576: the session a deferred caller (the agent_settled drain's quickfix
	 * pass) belongs to. Its bookkeeping, which follows the edit's file-write
	 * awaits, drops once that session is replaced; the bytes still land.
	 */
	session?: LineageHandle;
	/** True once at least one bounded mutation summary has been emitted. */
	summaryEmitted?: boolean;
	/** Number of per-request summaries emitted for this outer mutation (max 100). */
	summaryCount?: number;
	/** True once the bounded per-request summary limit has been exceeded. */
	summaryOverflowed?: boolean;
	/** Bounded per-batch dedupe for the existing turn-summary autofix publisher. */
	autofixRecordedPaths?: BoundedSet<string>;
	/**
	 * Same recordability gate `clients/mutation-bridge.ts` applies internally
	 * (`no-read-guard` / ignored / vendor) — optional so every existing caller
	 * that never threaded one keeps its exact prior behavior (always
	 * recordable). `tools/lsp-navigation.ts` sets this on the contexts it
	 * builds for `rename`/`rename_file`/`executeCommand` so the direct
	 * (deps-threaded) path applies the SAME gate the bridge fallback already
	 * enforces internally — before #2450 review round 2 (F4) the direct path
	 * had no such gate at all, so an LSP-issued write to an ignored/vendor
	 * path (or with `no-read-guard` set) was recorded on the direct path but
	 * silently dropped on the fallback path, an inequivalence between the two
	 * branches for the exact same kind of write.
	 */
	isRecordable?: (filePath: string) => boolean;
	/**
	 * #5248: the files this context's mutation recorded, once each: the paths
	 * that passed `isRecordable` and, on the bridge fallback, the bridge
	 * accepted. A caller that wants them (`lsp_navigation`, which reports them
	 * as `details.appliedFiles`) passes `[]`; every other context leaves it
	 * unset and collects nothing.
	 */
	acceptedFiles?: string[];
}

export interface LspMutationSummaryOptions {
	requestedTotal?: number;
	considered?: number;
	completed?: number;
	failedCount?: number;
	results?: AppliedWorkspaceEdit[];
	bookkeep?: boolean;
	status?: "success" | "failed" | "skipped";
}

export interface LspMutationTelemetry {
	editBatchSummary: ReadGuardEditBatchSummary;
	operationCounts: {
		requested: number;
		applied: number;
		textEdits: number;
		create: number;
		rename: number;
		delete: number;
	};
	sampledPaths: string[];
	sampledPathsTotal: number;
	sampledPathsTruncated: boolean;
	considered?: number;
	completed?: number;
	failedCount?: number;
}

const MAX_SAMPLES = 100;
const MAX_SUMMARIES_PER_CONTEXT = 100;

export function newLspMutationCorrelationId(toolCallId?: string): string {
	return getReadGuardCorrelationId(toolCallId ? { toolCallId } : {});
}

function allResults(
	options: LspMutationSummaryOptions,
): AppliedWorkspaceEdit[] {
	return options.results ?? [];
}

function combineResults(results: AppliedWorkspaceEdit[]): {
	requestedTotal: number;
	appliedTotal: number;
	appliedIndexes: number[];
	files: string[];
	fileDetails: AppliedWorkspaceEdit["fileDetails"];
	textEdits: number;
	create: number;
	rename: number;
	delete: number;
	paths: string[];
} {
	const files = new Set<string>();
	const fileDetails: AppliedWorkspaceEdit["fileDetails"] = [];
	const appliedIndexes: number[] = [];
	const paths: string[] = [];
	let requestedTotal = 0;
	let appliedTotal = 0;
	let textEdits = 0;
	let create = 0;
	let rename = 0;
	let deleteCount = 0;
	for (const result of results) {
		requestedTotal += result.operationTotal;
		appliedTotal += result.appliedOperationTotal;
		textEdits += result.operationCounts.textEdits;
		create += result.operationCounts.create;
		rename += result.operationCounts.rename;
		deleteCount += result.operationCounts.delete;
		for (const index of result.appliedOperationIndexes)
			appliedIndexes.push(index);
		for (const file of result.files) {
			if (!files.has(file)) {
				files.add(file);
				paths.push(file);
			}
		}
		fileDetails.push(...result.fileDetails);
	}
	return {
		requestedTotal,
		appliedTotal,
		appliedIndexes,
		files: [...files],
		fileDetails,
		textEdits,
		create,
		rename,
		delete: deleteCount,
		paths,
	};
}

function uniqueDetails(
	files: string[],
	fileDetails: AppliedWorkspaceEdit["fileDetails"],
): AppliedWorkspaceEdit["fileDetails"] {
	const byPath = new Map<string, AppliedWorkspaceEdit["fileDetails"][number]>();
	// #2016: `files` and `fileDetails` name the same paths, so without this the
	// map-build loop and the lookup below each pay `realpathSync.native` for the
	// same path (~200 microseconds per call on Windows; since #3098 POSIX pays it
	// too, measured at 1.8 microseconds for an existing path — still under any CI
	// timing gate, so the waste stays invisible either way). The memo lives for
	// one call, so it has no staleness window at all and needs no freshness
	// design.
	const keyMemo = new Map<string, string>();
	const keyFor = (filePath: string): string => {
		let key = keyMemo.get(filePath);
		if (key === undefined) {
			key = normalizeMapKey(path.resolve(filePath));
			keyMemo.set(filePath, key);
		}
		return key;
	};
	for (const detail of fileDetails) {
		const key = keyFor(detail.filePath);
		const previous = byPath.get(key);
		if (!previous) {
			byPath.set(key, {
				...detail,
				ranges: detail.ranges ?? (detail.range ? [detail.range] : undefined),
			});
			continue;
		}
		byPath.set(key, {
			filePath: previous.filePath,
			range:
				previous.range && detail.range
					? {
							start: Math.min(previous.range.start, detail.range.start),
							end: Math.max(previous.range.end, detail.range.end),
						}
					: (previous.range ?? detail.range),
			ranges: [
				...(previous.ranges ?? (previous.range ? [previous.range] : [])),
				...(detail.ranges ?? (detail.range ? [detail.range] : [])),
			],
			authorshipUnknown:
				previous.authorshipUnknown === true ||
				detail.authorshipUnknown === true,
			importsChanged: previous.importsChanged || detail.importsChanged,
		});
	}
	return files.map(
		(filePath) =>
			byPath.get(keyFor(filePath)) ?? {
				filePath,
				// Resource operations have no already-computed text range. A small
				// range is still enough to invalidate the touched-file turn state;
				// never synchronously re-read the whole file here.
				range: { start: 1, end: 1 },
				authorshipUnknown: true,
				importsChanged: true,
			},
	);
}

/**
 * The one entry both branches record for a file: the shape the bridge's v1
 * producers send, so the direct branch and the fallback cannot drift (#2450).
 */
function lspMutationEntry(
	context: LspMutationContext,
	filePath: string,
	detail: AppliedWorkspaceEdit["fileDetails"][number],
): MutationBridgeEntry {
	const known = detail.authorshipUnknown !== true;
	const editRanges =
		detail.ranges && known
			? detail.ranges.map(({ start, end }) => [start, end] as [number, number])
			: detail.range && known
				? [[detail.range.start, detail.range.end] as [number, number]]
				: undefined;
	return {
		filePath,
		kind: "edit",
		...(detail.range !== undefined && {
			touchedLines: [detail.range.start, detail.range.end] as [number, number],
		}),
		...(!known && { authorshipUnknown: true }),
		...(editRanges !== undefined ? { editRanges } : {}),
		...(context.sessionId !== undefined && { sessionId: context.sessionId }),
		consumer: context.tool,
		// The server computed the bytes and the call's own `tool_call` retire
		// licenses the advance (#3525, #4187 R4-1): an observed write.
		provenance: "observed",
		// The tsserver organize-imports or add-import case is exactly the
		// import-changing one (#2450 review round 2, F1).
		importsChanged: detail.importsChanged ?? true,
		// An LSP-applied edit queues no deferred autofix or format pass (#2450
		// review round 2, F3).
		deferAutofix: false,
		...(context.session && { lineage: context.session }),
		...(context.toolCallId !== undefined && {
			toolCallId: context.toolCallId,
		}),
	};
}

/**
 * #5551: the direct branch records through the bridge's own body,
 * `recordMutationOutcome`, over the surfaces its caller threaded. Three
 * answers stay the direct branch's: the change-log row names the LSP
 * operation (`context.source`, not `agent-tool:<tool>`), the turn-state entry
 * judges containment against the project root (#2504 review round 2, F1),
 * and the write does not reach `noteAgentMutation` (the writer table's G6
 * cell, a maintainer decision).
 */
function directBookkeepingDeps(
	context: LspMutationContext,
	runtime: LspMutationRuntime,
	cacheManager: LspMutationCacheManager,
): MutationBridgeDeps {
	const readGuard = context.readGuard;
	return {
		getRuntime: () => ({
			turnIndex: runtime.turnIndex ?? 0,
			telemetrySessionId: runtime.telemetrySessionId,
			readGuard: {
				// An LSP entry names no `readGuardBranchEpoch`, so the seam never
				// compares against this.
				currentBranchEpoch: 0,
				...(readGuard !== undefined && {
					recordWritten: (filePath, opts) =>
						readGuard.recordWritten(filePath, opts),
				}),
			},
			...(runtime.recordProjectMutation !== undefined && {
				recordProjectMutation: (args) =>
					runtime.recordProjectMutation?.({
						...args,
						source: context.source as ProjectChangeSource,
					}),
			}),
		}),
		getCacheManager: () => ({
			addModifiedRange: (filePath, range, importsChanged, cwd, sessionId) =>
				cacheManager.addModifiedRange(
					filePath,
					range,
					importsChanged,
					cwd,
					sessionId ?? undefined,
					undefined,
					runtime.projectRoot ?? context.cwd,
				),
		}),
		getProjectRoot: () => context.cwd,
		getDispatchCwd: () => context.cwd,
		// Every detail carries a range (`uniqueDetails`), so the seam never
		// counts lines; a resource operation must not re-read the file.
		countFileLines: () => 1,
		// `bookkeepLspMutation` applied `context.isRecordable` already.
		isRecordable: () => true,
		shouldStampReadGuard: () => readGuard !== undefined,
		noteAgentMutation: () => undefined,
		...(context.dbg !== undefined && { dbg: context.dbg }),
	};
}

function bookkeepLspMutation(
	context: LspMutationContext,
	files: string[],
	fileDetails: AppliedWorkspaceEdit["fileDetails"],
): void {
	const details = uniqueDetails(files, fileDetails);
	// Both branches record through `recordMutationOutcome`. The direct branch
	// reaches it over the `runtime` and `cacheManager` its caller threaded. One
	// caller structurally cannot thread them: `workspace/applyEdit`'s
	// server-initiated-edit handler (clients/lsp/client.ts) has no live
	// reference to those singletons, so its context falls back to the mutation
	// bridge (#2423), mounted at activation with live getters over the SAME
	// singletons. The bridge is this function's own fallback, not a second seam
	// (#2450).
	const runtime = context.runtime;
	const cacheManager = context.cacheManager;
	const deps =
		runtime && cacheManager
			? directBookkeepingDeps(context, runtime, cacheManager)
			: undefined;
	for (const detail of details) {
		const filePath = path.resolve(detail.filePath);
		// #2450 review round 2 (F4): the SAME recordability gate the bridge
		// fallback applies internally, so the two branches agree on which files
		// count as project source (`no-read-guard` / ignored / vendor).
		if (context.isRecordable && !context.isRecordable(filePath)) {
			context.dbg?.(`lsp mutation not recordable, skipping ${filePath}`);
			continue;
		}
		// #3576, narrowed by #3763 r2: once the caller's session is replaced its
		// turn summary is dropped; the seam drops the read-guard stamp and the
		// turn-state entry the same way and keeps the receipt, the file's seq and
		// the handled mark, which are facts about the bytes.
		let sessionLive: boolean;
		// #5248: true once the seam took the record.
		let accepted: boolean;
		if (deps) {
			accepted = recordMutationOutcome(
				lspMutationEntry(context, filePath, detail),
				deps,
			).recorded;
			// The seam's `guardedWrite` already counted a dead session's dropped
			// write, so this asks `isCurrent()`, the same question without the
			// count (#5592 review r1 F4). It asks the session, not the record's
			// outcome: a record that failed says nothing about liveness (verify
			// r1 V1).
			sessionLive = !context.session || context.session.isCurrent();
		} else {
			sessionLive =
				!context.session ||
				context.session.guardedWrite(filePath, () => true) !== undefined;
			// The fallback records into the bridge's own runtime, so a guard the
			// caller threaded without one is stamped here, as before #5551.
			if (sessionLive) stampFallbackReadGuard(context, filePath, detail);
			accepted = recordThroughBridge(context, filePath, detail);
		}
		// #2450 review round 2 (Partial-deps): its own surface, independent of
		// which branch recorded the receipt and the turn state above.
		if (sessionLive && context.recordAutofix && context.source === "autofix") {
			const key = normalizeMapKey(filePath);
			const seen =
				context.autofixRecordedPaths ?? new BoundedSet<string>(MAX_SAMPLES);
			context.autofixRecordedPaths = seen;
			if (!seen.has(key)) {
				seen.add(key);
				context.recordAutofix(filePath);
			}
		}
		if (
			accepted &&
			context.acceptedFiles &&
			!context.acceptedFiles.includes(filePath)
		)
			context.acceptedFiles.push(filePath);
	}
	if (context.publishFilesTouched && files.length > 0) {
		context.publishFilesTouched(files);
	}
}

/**
 * A context with a `readGuard` and no `runtime` or `cacheManager`: the
 * fallback's bridge stamps its own runtime's guard, not this one. #3525: the
 * server computed these bytes, so authorship, not FileTime; the call's own
 * `tool_call` retire licenses the advance (#4187 R4-1).
 */
function stampFallbackReadGuard(
	context: LspMutationContext,
	filePath: string,
	detail: AppliedWorkspaceEdit["fileDetails"][number],
): void {
	if (!context.readGuard) return;
	try {
		context.readGuard.recordWritten(filePath, {
			stampFileTime: false,
			advanceAuthorship: true,
			...(detail.authorshipUnknown !== true &&
				detail.ranges !== undefined && {
					authorship: "partial",
					authoredRanges: detail.ranges.map(
						({ start, end }) => [start, end] as [number, number],
					),
				}),
			...(detail.authorshipUnknown === true && { authorship: "unknown" }),
			...(context.toolCallId !== undefined && {
				toolCallId: context.toolCallId,
			}),
		});
	} catch (err) {
		context.dbg?.(
			`lsp mutation read-guard stamp failed for ${filePath}: ${err}`,
		);
	}
}

/**
 * The fallback for a context with no `runtime` or `cacheManager`. The entry is
 * built inside the `recordMutation` call, so the lineage sweep
 * (`tests/clients/mutation-bridge-lineage-epoch-sweep.test.ts`) reads
 * `lspMutationEntry`'s literal at this site.
 */
function recordThroughBridge(
	context: LspMutationContext,
	filePath: string,
	detail: AppliedWorkspaceEdit["fileDetails"][number],
): boolean {
	const bridge = getMutationBridge();
	if (!bridge) {
		// #2450 review round 2 (F4)/round 3 (minor): the MCP server process
		// (`mcp/server.ts`) builds `lsp_navigation` with no `mutationDeps` AND
		// never mounts the bridge (that only happens inside pi's own in-process
		// extension activation, `index.ts`), so every LSP-applied edit in that
		// process is unrecorded. Recorded once per session under one fixed
		// subject, not once per file or per LSP operation kind.
		recordDegradationOnce({
			kind: "lsp-mutation-bridge-unmounted",
			subject: "lsp-mutation:no-bridge",
			reason:
				"workspace/applyEdit bookkeeping fell back to the mutation " +
				"bridge, but no bridge is mounted in this process (e.g. the " +
				"MCP server, which never runs pi's extension activation) — " +
				"the write is unrecorded (no read-guard stamp, no turn-state " +
				"entry, no change-log receipt).",
		});
		if (!noBridgeDbgLogged) {
			noBridgeDbgLogged = true;
			context.dbg?.(
				`lsp mutation bridge unavailable, dropping bookkeeping for ${filePath}`,
			);
		}
		return false;
	}
	try {
		if (bridge.recordMutation(lspMutationEntry(context, filePath, detail)))
			return true;
		context.dbg?.(
			`lsp mutation bridge dropped ${filePath} (recordMutation() ` +
				"returned false — see the mutation_bridge debug output for the " +
				"reason: malformed entry, out-of-scope path, or a bookkeeping error)",
		);
	} catch (err) {
		context.dbg?.(
			`lsp mutation bridge fallback failed for ${filePath}: ${err}`,
		);
	}
	return false;
}

function telemetryFor(
	context: LspMutationContext,
	options: LspMutationSummaryOptions,
): LspMutationTelemetry {
	const combined = combineResults(allResults(options));
	const requestedTotal = options.requestedTotal ?? combined.requestedTotal;
	const appliedTotal = combined.appliedTotal;
	const requestedIndexes = Array.from(
		{ length: Math.min(requestedTotal, MAX_SAMPLES) },
		(_, index) => index,
	);
	const rejectedTotal = Math.max(0, requestedTotal - appliedTotal);
	const rejectedReasons = Array.from(
		{ length: Math.min(rejectedTotal, MAX_SAMPLES) },
		(_, index) => ({ index, code: "write_failed" as const }),
	);
	const status = options.status ?? (appliedTotal > 0 ? "success" : "skipped");
	const editBatchSummary = createReadGuardEditBatchSummary({
		requestedIndexes,
		requestedTotal,
		resolvedIndexes: requestedIndexes,
		resolvedTotal: requestedTotal,
		rejectedReasons,
		rejectedTotal,
		appliedIndexes: combined.appliedIndexes,
		appliedTotal,
		participantIds: [context.correlationId],
		participantTotal: 1,
		commitStatus:
			status === "failed"
				? "failed"
				: appliedTotal > 0
					? "committed"
					: "no_changes",
		terminalStatus: status,
	});
	return {
		editBatchSummary,
		operationCounts: {
			requested: requestedTotal,
			applied: appliedTotal,
			textEdits: combined.textEdits,
			create: combined.create,
			rename: combined.rename,
			delete: combined.delete,
		},
		sampledPaths: combined.paths.slice(0, MAX_SAMPLES),
		sampledPathsTotal: combined.paths.length,
		sampledPathsTruncated: combined.paths.length > MAX_SAMPLES,
		considered: options.considered,
		completed: options.completed,
		failedCount: options.failedCount,
	};
}

export function recordLspMutation(
	context: LspMutationContext,
	options: LspMutationSummaryOptions = {},
): LspMutationTelemetry {
	const results = allResults(options);
	const combined = combineResults(results);
	if (options.bookkeep !== false && combined.files.length > 0) {
		bookkeepLspMutation(context, combined.files, combined.fileDetails);
	}
	const telemetry = telemetryFor(context, options);
	if (context.emitSummary !== false) {
		const summaryCount = context.summaryCount ?? 0;
		context.summaryEmitted = true;
		if (summaryCount < MAX_SUMMARIES_PER_CONTEXT) {
			context.summaryCount = summaryCount + 1;
			logReadGuardEvent({
				event: "edit_batch_summary",
				correlationId: context.correlationId,
				filePath: combined.files[0] ?? context.cwd,
				metadata: {
					tool: context.tool,
					source: context.source,
					outcome: telemetry.editBatchSummary.terminalStatus,
					// The outer correlation identifies the soliciting tool call; the
					// bounded sequence distinguishes multiple applyEdit requests within it.
					summaryIndex: summaryCount,
					editBatchSummary: telemetry.editBatchSummary,
					operationCounts: telemetry.operationCounts,
					sampledPaths: telemetry.sampledPaths,
					sampledPathsTotal: telemetry.sampledPathsTotal,
					sampledPathsTruncated: telemetry.sampledPathsTruncated,
					considered: telemetry.considered,
					completed: telemetry.completed,
					failedCount: telemetry.failedCount,
				},
			});
		} else if (!context.summaryOverflowed) {
			context.summaryOverflowed = true;
			logReadGuardEvent({
				event: "edit_batch_summary_overflow",
				correlationId: context.correlationId,
				filePath: combined.files[0] ?? context.cwd,
				metadata: {
					tool: context.tool,
					source: context.source,
					summaryLimit: MAX_SUMMARIES_PER_CONTEXT,
					suppressedSummaries: "one or more",
				},
			});
		}
	}
	return telemetry;
}

export function recordLspMutationBatch(
	context: LspMutationContext,
	options: LspMutationSummaryOptions,
): LspMutationTelemetry {
	const previous = context.emitSummary;
	context.emitSummary = true;
	try {
		return recordLspMutation(context, options);
	} finally {
		context.emitSummary = previous;
	}
}

export function recordLspMutationOutcome(
	context: LspMutationContext,
	status: "success" | "failed" | "skipped",
): LspMutationTelemetry {
	return recordLspMutation(context, { status, requestedTotal: 0 });
}
