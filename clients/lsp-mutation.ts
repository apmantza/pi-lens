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
import type { AppliedWorkspaceEdit } from "./lsp/edits.js";
import { normalizeMapKey } from "./path-utils.js";
import { getMutationBridge } from "./mutation-bridge.js";
import { noteMutationHandled } from "./observed-mutation.js";
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
	correlationId: string;
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
	readGuard?: { recordWritten: (filePath: string) => void };
	cacheManager?: LspMutationCacheManager;
	/** Existing autonomous-write publishers. Agent-owned navigation edits do not set these. */
	publishFilesTouched?: (paths: string[]) => void;
	recordAutofix?: (filePath: string) => void;
	dbg?: (message: string) => void;
	/** Batch callers can defer the single terminal log until all edits are attempted. */
	emitSummary?: boolean;
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
	// same path (~200 microseconds per call on Windows; POSIX short-circuits, so
	// CI cannot see it). The memo lives for one call, so it has no staleness
	// window at all and needs no freshness design.
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
			byPath.set(key, detail);
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
				importsChanged: true,
			},
	);
}

function bookkeepLspMutation(
	context: LspMutationContext,
	files: string[],
	fileDetails: AppliedWorkspaceEdit["fileDetails"],
): void {
	const details = uniqueDetails(files, fileDetails);
	// The direct path below needs `context.runtime` (the receipt) and
	// `context.cacheManager` (the turn-state entry) threaded in by the caller.
	// One caller structurally cannot: `workspace/applyEdit`'s server-initiated-edit
	// handler (clients/lsp/client.ts) builds its own fallback `LspMutationContext`
	// with neither, because there is no live reference to the runtime/cache-manager
	// singletons at that call site. Rather than silently drop bookkeeping for that
	// write, fall back to the mutation bridge (#2423) — mounted once at extension
	// activation with live getters closing over the SAME singletons — which is
	// exactly the seam built for "a producer that cannot reach the bookkeeping
	// surfaces directly". This keeps `recordLspMutation` the ONE call site every
	// LSP-applied edit bookkeeps through; the bridge is this function's OWN
	// fallback, not a second seam other code reaches for on its behalf (#2450).
	// Only the receipt (recordProjectMutation) and the turn-state entry
	// (cacheManager.addModifiedRange) need the bridge fallback: the read-guard
	// stamp is independent of them and already tolerates either being absent.
	const useBridgeFallback = !context.runtime || !context.cacheManager;
	for (const detail of details) {
		const filePath = path.resolve(detail.filePath);
		// #2450 review round 2 (F4): the SAME recordability gate the bridge
		// fallback below already applies internally (`isRecordable`, mounted in
		// index.ts). Applied here too so the direct (deps-threaded) branch
		// cannot record a write the fallback branch would have silently
		// dropped for the exact same reason (`no-read-guard` / ignored /
		// vendor) — the two branches must agree on which files count as
		// project source, not just on how they bookkeep the ones that do.
		if (context.isRecordable && !context.isRecordable(filePath)) {
			context.dbg?.(`lsp mutation not recordable, skipping ${filePath}`);
			continue;
		}
		if (context.readGuard) {
			try {
				context.readGuard.recordWritten(filePath);
			} catch (err) {
				context.dbg?.(
					`lsp mutation read-guard stamp failed for ${filePath}: ${err}`,
				);
			}
		}
		if (useBridgeFallback) {
			const bridge = getMutationBridge();
			if (!bridge) {
				// #2450 review round 2 (F4)/round 3 (minor): the MCP server process
				// (`mcp/server.ts`) builds `lsp_navigation` with no
				// `mutationDeps` AND never mounts the bridge (that only happens
				// inside pi's own in-process extension activation, `index.ts`) —
				// every LSP-applied edit in that process is unrecorded. Once per
				// session (not once per file — a rename can touch many files in
				// one call, and a session can issue many renames), not once per
				// process lifetime silently. `subject` is a fixed, one-word
				// degradation-ledger key (round 3: was `context.tool`, which
				// varies per LSP operation — "lsp_navigation:rename" vs
				// "...executeCommand" — so the SAME session could log this
				// degradation once per operation kind instead of truly once).
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
			} else {
				try {
					const recorded = bridge.recordMutation({
						filePath,
						kind: "edit",
						editRanges: detail.range
							? [[detail.range.start, detail.range.end]]
							: undefined,
						consumer: context.tool,
						// Real value threaded through, not the bridge's own
						// historical `false` default (#2450 review round 2, F1) —
						// the tsserver organize-imports/add-import case is exactly
						// the import-changing one.
						importsChanged: detail.importsChanged ?? true,
						// Equivalence with the direct branch below, which never
						// enqueues a deferred autofix/format pass for an LSP-applied
						// edit (#2450 review round 2, F3).
						deferAutofix: false,
					});
					if (!recorded) {
						context.dbg?.(
							`lsp mutation bridge dropped ${filePath} (recordMutation() ` +
								"returned false — see the mutation_bridge debug output " +
								"for the reason: malformed entry, out-of-scope path, or " +
								"a bookkeeping error)",
						);
					}
				} catch (err) {
					context.dbg?.(
						`lsp mutation bridge fallback failed for ${filePath}: ${err}`,
					);
				}
			}
		} else {
			const runtime = context.runtime;
			// One mutation seam (#2000 phase 1): bump + receipt + change-log live in
			// RuntimeCoordinator.recordProjectMutation.
			runtime?.recordProjectMutation?.({
				filePath,
				source: context.source as ProjectChangeSource,
				cwd: context.cwd,
				changedRange: detail.range,
				onAppendError: (err) =>
					context.dbg?.(
						`lsp mutation project change append failed for ${filePath}: ${err}`,
					),
			});
			if (context.cacheManager) {
				try {
					context.cacheManager.addModifiedRange(
						filePath,
						detail.range ?? { start: 1, end: 1 },
						detail.importsChanged ?? true,
						context.cwd,
						runtime?.telemetrySessionId,
						undefined,
						// #2504 review round 2 (F1). #2504 added a containment
						// filter to `addModifiedRange` and gave it `cwd` as the
						// project root. On THIS path `cwd` is the calling
						// directory, which `tools/lsp-navigation.ts` scopes to a
						// sub-package while the LSP client's root spans the whole
						// monorepo — so a server-initiated edit on a sibling
						// package (#2450) and every edit whose context carries a
						// separate bookkeeping cwd (#2479) were silently dropped
						// from the worklist. Same root the `isRecordable` gate a
						// few frames up already uses: `runtime.projectRoot`,
						// falling back to `cwd` when no runtime is threaded.
						runtime?.projectRoot ?? context.cwd,
					);
				} catch (err) {
					context.dbg?.(
						`lsp mutation modified-range tracking failed for ${filePath}: ${err}`,
					);
				}
			}
			// #2465: the bridge-fallback branch above gets this for free —
			// `recordMutationThroughSeam` calls `noteMutationHandled` for every
			// entry it takes. The DIRECT branch bypasses the bridge entirely, so
			// it has to say so itself, or the #2430 `agent_settled` sweep finds
			// bytes on disk it has no baseline for and reports every
			// `lsp_navigation` rename as drift no tool call explains. Placed
			// after `addModifiedRange` and OUTSIDE its `try`: the mark is about
			// "pi-lens wrote this file", which is true whether or not the
			// turn-state insert threw.
			noteMutationHandled(filePath);
		}
		// #2450 review round 2 (Partial-deps): its own surface, independent of
		// whether the receipt/turn-state used the direct path or the bridge
		// fallback above — a half-threaded caller (one that provides
		// `recordAutofix` but not `runtime`/`cacheManager`) must not lose its
		// turn-summary publisher just because SOME other surface fell back.
		if (context.recordAutofix && context.source === "autofix") {
			const key = normalizeMapKey(filePath);
			const seen =
				context.autofixRecordedPaths ?? new BoundedSet<string>(MAX_SAMPLES);
			context.autofixRecordedPaths = seen;
			if (!seen.has(key)) {
				seen.add(key);
				context.recordAutofix(filePath);
			}
		}
	}
	if (context.publishFilesTouched && files.length > 0) {
		context.publishFilesTouched(files);
	}
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
