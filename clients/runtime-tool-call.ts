import * as nodeFs from "node:fs";
import * as path from "node:path";
import { loadBootstrapClients } from "./bootstrap.js";
import type { CacheManager } from "./cache-manager.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { detectFileKind } from "./file-kinds.js";
import { isPathIgnoredByProject } from "./file-utils.js";
import { evaluateGitGuard, isGitCommitOrPushAttempt } from "./git-guard.js";
import { logLatency } from "./latency-logger.js";
import { normalizeMapKey } from "./path-utils.js";
import {
	captureFileStats,
	getOpaqueBaselineStore,
	isGitWorktree,
	type PendingOpaqueBaseline,
} from "./opaque-mutation-scan.js";
import { normalizeForGuardMatch } from "./host-edit-normalize.js";
import { retargetReplacementIndentation } from "./indent-retarget.js";
import { LANGUAGE_POLICY } from "./language-policy.js";
import type { LSPShutdownOptions } from "./lsp/client.js";
import { getLSPService } from "./lsp/index.js";
import {
	findDocumentSymbolAtLine,
	getOpenDocumentSymbols,
	lspSymbolKindName,
	qualifiedLspSymbolName,
} from "./lsp-document-symbols.js";
import {
	computeTrailingWhitespaceOldTextPatch,
	findUniqueMatchLineRange,
} from "./oldtext-autopatch.js";
import { applyPartiallyApplicableEdits } from "./partial-edit-apply.js";
import {
	type HostPathVariantResolution,
	isExternalOrVendorFile,
	resolveHostPathVariants,
	resolveHostToolPath,
} from "./path-utils.js";
import {
	EXPANSION_BUDGET_MS,
	EXPANSION_LIMIT_LINES,
	tryExpandRead,
} from "./read-expansion.js";
import {
	boundedIndexesForCount,
	createReadGuardEditBatchSummary,
	getReadGuardCorrelationId,
	logReadGuardEvent,
} from "./read-guard-logger.js";
import {
	countFileLines,
	getTouchedLinesForGuard,
	relocateEditRange,
	tryCorrectIndentationMismatch,
	tryCorrectIndentationMismatchFromContent,
} from "./read-guard-tool-lines.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import { handleToolResult } from "./runtime-tool-result.js";
import {
	isToolCallEventType,
	resolveToolCallCorrelationId,
} from "./tool-event.js";
import { getSharedTreeSitterClient } from "./tree-sitter-shared.js";

const LSP_TOOLCALL_NAV_TOUCH_BUDGET_MS = Math.max(
	0,
	Number.parseInt(
		process.env.PI_LENS_TOOLCALL_NAV_TOUCH_MS ??
			process.env.PI_LENS_LSP_NAV_CLIENT_WAIT_MS ??
			"1500",
		10,
	) || 1500,
);
const LSP_TOOLCALL_TOUCH_BUDGET_MS = Math.max(
	0,
	Number.parseInt(process.env.PI_LENS_TOOLCALL_TOUCH_MS ?? "750", 10) || 750,
);

function getToolCallRawFilePath(
	toolName: string,
	event: { input?: unknown },
): string | undefined {
	const inputObj = (event.input ?? {}) as Record<string, unknown>;

	if (
		isToolCallEventType("write", event as any) ||
		isToolCallEventType("edit", event as any)
	) {
		const filePath = (event.input as { path?: unknown }).path;
		return typeof filePath === "string" ? filePath : undefined;
	}

	if (toolName === "read") {
		if (typeof inputObj.path === "string") return inputObj.path;
		if (typeof inputObj.filePath === "string") return inputObj.filePath;
		return undefined;
	}

	if (toolName === "lsp_navigation") {
		return typeof inputObj.filePath === "string"
			? inputObj.filePath
			: undefined;
	}

	return undefined;
}

/**
 * Resolve a tool_call's raw path to the file pi will actually touch.
 *
 * The `cwd` basis is the host `ctx.cwd`, which for the pinned host IS the same
 * value the tools were constructed with — `AgentSession` passes its one `_cwd`
 * to both `createAllToolDefinitions`
 * (`@earendil-works/pi-coding-agent/dist/core/agent-session.js:2026`, source
 * `src/core/tools/index.ts:99-124`) and the `ExtensionRunner` behind `ctx.cwd`
 * (`dist/core/agent-session.js:2037`; `runner.js:154`, `:476-479`). Neither is
 * reassigned after construction, so there is no drift TODAY (#1655 item 4).
 * `tests/clients/pi-host-contract.test.ts` pins that, because the day a host
 * lets one move independently, every path here silently retargets.
 *
 * The path is produced the way pi produces it, in pi's two stages (#1655 item
 * 5, plus review F1):
 *
 *   1. `resolveHostToolPath` mirrors pi's BASE resolution, `resolveToCwd`
 *      (`dist/core/tools/path-utils.js:42-44`, source
 *      `src/core/tools/path-utils.ts:~44-46`) — unicode-space folding, `@`
 *      prefix stripping, `~` expansion, `file://` conversion, and Git-Bash
 *      drive paths, all BEFORE anything is probed.
 *   2. `resolveHostPathVariants` mirrors pi's fallback LADDER
 *      (`dist/core/tools/path-utils.js:45-70`, source
 *      `src/core/tools/path-utils.ts:52-83`).
 *
 * Stage 1 was missing in the first cut of this fix, and the ladder cannot
 * stand in for it: an `@`-prefixed path, a `file://` URL, or a non-breaking
 * space are all resolved by pi at stage 1 and are untouched by any of the four
 * stage-2 candidates. A plain `path.resolve` therefore produced a path pi
 * never opens, and the miss looked identical to "file genuinely absent".
 */
function resolveToolCallFilePath(
	rawFilePath: string | undefined,
	cwd: string | undefined,
	projectRoot: string,
): HostPathVariantResolution | undefined {
	if (!rawFilePath) return undefined;
	return resolveHostPathVariants(
		resolveHostToolPath(rawFilePath, cwd ?? projectRoot),
	);
}

type ReadToolInput = {
	path?: string;
	filePath?: string;
	offset?: number;
	limit?: number;
};

function getReadToolInput(
	toolName: string,
	input: unknown,
): ReadToolInput | undefined {
	if (toolName !== "read") return undefined;
	return input as ReadToolInput;
}

function getEffectiveReadLimit(
	filePath: string | undefined,
	readInput: ReadToolInput | undefined,
): number | undefined {
	if (!filePath || !readInput) return undefined;
	const requestedOffset = readInput.offset ?? 1;
	const requestedLimit = readInput.limit;
	return (
		requestedLimit ??
		Math.max(1, countFileLines(filePath) - requestedOffset + 1)
	);
}

function isLspCapableFile(filePath: string): boolean {
	const kind = detectFileKind(filePath);
	if (!kind) return false;
	return LANGUAGE_POLICY[kind]?.lspCapable !== false;
}

function shouldSkipLspAutoTouch(
	filePath: string,
	projectRoot: string,
): boolean {
	const normalized = path.resolve(filePath).replace(/\\/g, "/").toLowerCase();
	const base = path.basename(filePath).toLowerCase();

	if (normalized.includes("/.pi-lens/")) return true;
	if (normalized.includes("/.harness/")) return true;
	if (isExternalOrVendorFile(filePath, projectRoot)) return true;
	if (
		base === "stdout.jsonl" ||
		base === "stderr.txt" ||
		base === "prompt.txt"
	) {
		return true;
	}
	if (base === "case.json" && normalized.includes("/cases/")) {
		return true;
	}
	return false;
}

// Kept in lockstep with the gate's normalizeContent + oldtext-autopatch's
// normalizeOldTextForMatch: the host edit tool's full fuzzy-match space, so the
// autopatch passes count/locate oldText exactly where the host applies it (#257).
function normalizeOldTextForMatch(text: string): string {
	return normalizeForGuardMatch(text);
}

function countTextOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let pos = 0;
	while (pos < haystack.length) {
		const idx = haystack.indexOf(needle, pos);
		if (idx === -1) break;
		count += 1;
		pos = idx + needle.length;
	}
	return count;
}

function countOldTextMatches(
	filePath: string,
	oldText: string,
	cachedNormalizedContent?: string,
): number {
	try {
		const content =
			cachedNormalizedContent ??
			normalizeOldTextForMatch(nodeFs.readFileSync(filePath, "utf-8"));
		return countTextOccurrences(content, normalizeOldTextForMatch(oldText));
	} catch {
		return 0;
	}
}

function isIndentationOnlyChange(before: string, after: string): boolean {
	const beforeLines = before.replace(/\r\n/g, "\n").split("\n");
	const afterLines = after.replace(/\r\n/g, "\n").split("\n");
	if (beforeLines.length !== afterLines.length) return false;
	// Strip both leading and trailing whitespace: consistent with
	// findIndentationInsensitiveCandidate which matches via .trimEnd(), so a
	// candidate that differs only in trailing whitespace is still indentation-only.
	return beforeLines.every(
		(line, index) => line.trim() === afterLines[index].trim(),
	);
}

function getNewContentFromToolCall(event: unknown): string | undefined {
	if (isToolCallEventType("write", event as any)) {
		return ((event as { input?: unknown }).input as { content?: string })
			.content;
	}
	if (isToolCallEventType("edit", event as any)) {
		const edits = (
			(event as { input?: unknown }).input as {
				edits?: Array<{ newText?: string }>;
			}
		).edits;
		return edits?.map((edit) => edit.newText ?? "").join("\n");
	}
	return undefined;
}

interface ToolCallEvent {
	toolName?: string;
	/**
	 * Host-assigned identity for this call, shared with the paired
	 * `tool_result` event (SDK's `ToolCallEventBase.toolCallId`). Carried
	 * through so the canonical resolved path can be correlated by identity
	 * instead of the paired tool_result re-deriving it from its own metadata
	 * (#1642).
	 */
	toolCallId?: string;
	input?: unknown;
	details?: unknown;
	provider?: string;
	model?: string;
	sessionId?: string;
	session?: { id?: string };
}

interface ToolCallCtx {
	cwd?: string;
	ui?: {
		setStatus: (id: string, text: string | undefined) => void;
		theme: {
			fg: (
				color: "accent" | "success" | "error" | "warning" | "dim",
				text: string,
			) => string;
		};
	};
}

interface ToolCallDeps {
	event: ToolCallEvent;
	ctx: ToolCallCtx;
	lensEnabled: boolean;
	getFlag: (name: string) => boolean | string | undefined;
	dbg: (msg: string) => void;
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
	ensureLSPConfigInitialized: (cwd: string) => Promise<void>;
	updateLspStatus: (
		setStatus: (id: string, text: string | undefined) => void,
		theme: {
			fg: (
				color: "accent" | "success" | "error" | "warning" | "dim",
				text: string,
			) => string;
		},
	) => void;
	resetLSPService: (options?: LSPShutdownOptions) => void;
	getTreeSitterClient?: typeof getSharedTreeSitterClient;
}

export type ToolCallResult = { block: true; reason?: string } | void;

/**
 * Total guard around the `tool_call` handler body (#1655 item 1).
 *
 * `tool_call` is the ONE pi emit path with no per-handler `try`/`catch`. Every
 * sibling wraps each handler and routes a throw to `emitError`
 * (`emitToolResult` at
 * `@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:649-707`,
 * source `src/core/extensions/runner.ts:877-930`; the generic `emit` at
 * source `runner.ts:801-832`). `emitToolCall`
 * (`dist/core/extensions/runner.js:701-717`, source `runner.ts:932-953`) calls
 * `await handler(event, ctx)` bare, and its caller
 * `AgentSession._installAgentToolHooks`'s `beforeToolCall`
 * (`dist/core/agent-session.js:229-241`, source `agent-session.ts:~228-242`)
 * rethrows: `throw new Error("Extension failed, blocking execution: ...")`.
 *
 * So an unguarded throw anywhere in pi-lens's `tool_call` handler does not
 * degrade pi-lens — it BLOCKS the user's tool call outright. Advisory
 * instrumentation must never be able to do that. Every failure degrades to
 * "pi-lens did nothing for this call" (`undefined`, which pi reads as
 * "no extension opinion") and lands one ledger entry per tool name.
 *
 * Returning `undefined` on a throw is deliberate: a partially-executed handler
 * cannot have earned a `{ block: true }` verdict, and inventing one would turn
 * a pi-lens bug into a refused user tool call — the exact outcome this guard
 * exists to prevent.
 *
 * #1642 F2 (inside the guard): a BLOCKED call (git-guard, read-guard
 * preflight, the duplicate-export check) never gets a paired `tool_result` —
 * the host never lets the tool execute. Any path attribution recorded for it
 * below would otherwise sit in the correlation cache forever (bounded by its
 * LRU cap, but pure garbage that can crowd out a live in-flight record under
 * enough blocked-edit volume — a reviewer-reproduced leak). Clear it eagerly
 * on the way out whenever the call was blocked; a no-op if nothing was
 * recorded (a gitignored SKIP is not a block, so it is unaffected). This
 * cleanup runs INSIDE the try, so a throw out of it is absorbed too.
 */
export async function handleToolCall(
	deps: ToolCallDeps,
): Promise<ToolCallResult> {
	try {
		const result = await handleToolCallImpl(deps);
		if (result && (result as { block?: boolean }).block) {
			// Review F2 — this cleanup gets its OWN catch, and it is not optional
			// tidiness. By the time it runs, `result` is a FINAL `{ block: true }`
			// verdict: the read guard has already refused an edit-without-read, or
			// the git guard has already refused a commit. Letting a throw out of
			// bookkeeping reach the outer catch would convert that verdict into
			// `undefined` — "pi-lens has no opinion" — and the refused edit would
			// execute. A guard that fails OPEN because its telemetry broke is
			// worse than no guard, so the verdict is returned regardless of what
			// the cleanup does.
			try {
				const toolCallId = resolveToolCallCorrelationId(deps.event);
				if (toolCallId !== undefined) {
					deps.runtime.takeToolCallAttribution(toolCallId);
				}
			} catch (cleanupError) {
				const reason =
					cleanupError instanceof Error
						? cleanupError.message
						: String(cleanupError);
				recordDegradationOnce({
					kind: "tool-call-handler-throw",
					subject: `attribution-cleanup:${(deps.event as { toolName?: string } | undefined)?.toolName ?? "unknown"}`,
					reason,
				});
				try {
					deps.dbg?.(
						`tool_call blocked-attribution cleanup threw (block verdict preserved): ${reason}`,
					);
				} catch {
					// A broken `dbg` must not resurrect the throw just absorbed.
				}
			}
		}
		return result;
	} catch (error) {
		const toolName =
			(deps.event as { toolName?: string } | undefined)?.toolName ?? "unknown";
		const reason = error instanceof Error ? error.message : String(error);
		// Once per tool name per session: a wedged handler fires on every call of
		// that tool, and the ledger is a health surface, not a log.
		recordDegradationOnce({
			kind: "tool-call-handler-throw",
			subject: toolName,
			reason,
		});
		try {
			deps.dbg?.(
				`tool_call handler threw for ${toolName} (degraded, not blocking): ${reason}`,
			);
			if (error instanceof Error && error.stack) {
				deps.dbg?.(`tool_call handler stack: ${error.stack}`);
			}
		} catch {
			// A broken `dbg` must not resurrect the throw this guard just absorbed.
		}
		// Any attribution already recorded is deliberately LEFT in place: the
		// tool now executes (this returns "no opinion"), so its paired
		// `tool_result` still arrives and claims the record exactly once.
		return undefined;
	}
}

async function handleToolCallImpl(deps: ToolCallDeps): Promise<ToolCallResult> {
	const {
		event,
		ctx,
		lensEnabled,
		getFlag,
		dbg,
		runtime,
		cacheManager,
		ensureLSPConfigInitialized,
		updateLspStatus,
		resetLSPService,
		getTreeSitterClient = getSharedTreeSitterClient,
	} = deps;

	const readGuardCorrelationId = getReadGuardCorrelationId(event);
	let filePath: string | undefined;
	const logToolReadGuardEvent = (
		entry: Parameters<typeof logReadGuardEvent>[0],
	): void =>
		logReadGuardEvent({ ...entry, correlationId: readGuardCorrelationId });
	const toolName = (event as { toolName?: string }).toolName ?? "";
	const editInputForTelemetry = (event as { input?: unknown }).input as
		| { edits?: unknown[] }
		| undefined;
	// #1655 item 3: SNAPSHOT the requested batch width here, at handler entry.
	// `input` is a live, mutable, extension-ordered object — pi types it
	// `Record<string, unknown>` and hands the SAME reference to every handler in
	// turn (`@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:701-716`
	// passes `event` unchanged through the loop; source
	// `src/core/extensions/types.ts:914-919`), and pi-lens itself rewrites it in
	// place further down (indent correction, hashline resolution, range
	// relocation). `requestedEditIndexes` was already a snapshot; the totals
	// below used to RE-READ `editInputForTelemetry.edits.length` from the live
	// object hundreds of lines and several `await`s later, so a batch that
	// changed width in between produced an internally inconsistent summary —
	// indexes from the call-time array, totals from the mutated one.
	const requestedEditIndexes =
		toolName === "write"
			? [0]
			: Array.isArray(editInputForTelemetry?.edits)
				? boundedIndexesForCount(editInputForTelemetry.edits.length)
				: [0];
	const requestedEditTotal =
		toolName === "write"
			? 1
			: Array.isArray(editInputForTelemetry?.edits)
				? editInputForTelemetry.edits.length
				: 1;
	const logBlockedEditSummary = (source: string): void =>
		logToolReadGuardEvent({
			event: "edit_batch_summary",
			filePath: filePath ?? "",
			metadata: {
				tool: toolName,
				source,
				editBatchSummary: createReadGuardEditBatchSummary({
					requestedIndexes: requestedEditIndexes,
					requestedTotal: requestedEditTotal,
					rejectedReasons: requestedEditIndexes.map((index) => ({
						index,
						code: "preflight_blocked" as const,
					})),
					rejectedTotal: requestedEditTotal,
					terminalStatus: "blocked",
				}),
			},
		});
	if (!lensEnabled) return;
	// #2000 phase 2: opaque-command pre-snapshot. A bash command whose writes
	// the extractor will not recognize gets a bounded stat snapshot of the
	// project source universe BEFORE it runs; the tool_result side diffs it.
	// Fire-and-forget capture is WRONG here (the child may finish first), but
	// the capture is stat-only and budgeted, so awaiting it is bounded work on
	// an already-second-scale bash path.
	if (toolName === "bash") {
		const commandInput = (event as { input?: { command?: unknown } }).input;
		if (typeof commandInput?.command === "string" && commandInput.command) {
			const scanRoot = ctx.cwd ?? runtime.projectRoot;
			if (scanRoot) {
				const started = Date.now();
				const rootKey = `${normalizeMapKey(path.resolve(scanRoot))}:${runtime.sessionGeneration}`;
				let baseline: PendingOpaqueBaseline;
				let resultNote: string;
				if (await isGitWorktree(scanRoot)) {
					// Git-first: the timestamp IS the baseline; git answers what
					// changed, at any repo size, with no file-universe cap.
					baseline = { startedAt: started, strategy: "git" };
					resultNote = "git";
				} else {
					const outcome = await captureFileStats(scanRoot, {
						withHashes: true,
					});
					baseline = outcome.snapshot
						? {
								startedAt: started,
								strategy: "stat-diff",
								stats: outcome.snapshot,
							}
						: {
								startedAt: started,
								strategy: "stat-diff",
								statsUnknownReason: outcome.unknownReason ?? "walk-failed",
							};
					resultNote =
						outcome.unknownReason ?? `scanned:${outcome.scannedCount}`;
				}
				// Session-stamped key: a concurrent-secondary session (#473)
				// replacing this slot must yield a no-pending-snapshot UNKNOWN
				// for us - never a diff against another session's baseline.
				getOpaqueBaselineStore().record(rootKey, baseline);
				logLatency({
					type: "phase",
					phase: "opaque_mutation_prescan",
					filePath: commandInput.command.slice(0, 80),
					durationMs: Date.now() - started,
					result: resultNote,
				});
			}
		}
	}
	if (
		getFlag("lens-guard") &&
		isGitCommitOrPushAttempt(toolName, event.input)
	) {
		const guard = evaluateGitGuard(
			runtime,
			cacheManager,
			ctx.cwd ?? runtime.projectRoot,
		);
		if (guard.block) {
			return {
				block: true,
				reason: guard.reason,
			};
		}
	}

	const rawFilePath = getToolCallRawFilePath(toolName, event);
	const pathResolution = resolveToolCallFilePath(
		rawFilePath,
		ctx.cwd,
		runtime.projectRoot,
	);
	filePath = pathResolution?.path;
	if (pathResolution?.variant) {
		dbg(
			`tool_call: path resolved via host ${pathResolution.variant} variant → ${filePath}`,
		);
	}

	if (!getFlag("no-lsp")) {
		try {
			const configCwd = filePath
				? path.dirname(filePath)
				: (ctx.cwd ?? runtime.projectRoot ?? process.cwd());
			await ensureLSPConfigInitialized(configCwd);
		} catch (cfgErr) {
			dbg(`lsp config init failed during tool_call: ${cfgErr}`);
		}
	}

	if (!filePath) return;

	dbg(
		`tool_call fired for: ${filePath} (exists: ${nodeFs.existsSync(filePath)})`,
	);
	const toolCallId = resolveToolCallCorrelationId(event);
	const attributesMutationTarget =
		toolCallId !== undefined && (toolName === "write" || toolName === "edit");
	const targetMissing = !nodeFs.existsSync(filePath);
	// #1642 F1: a brand-new file's WRITE is never a "skip" — `tool_call`
	// fires PRE-execution, so `existsSync` is false for every path a write
	// is about to CREATE. Gitignore is a pure pattern match (no existence
	// requirement), so it is checked regardless of `targetMissing`; only an
	// actual ignore verdict is a real "refuse". Folding `targetMissing` into
	// `skipped` (the pre-fix-round-2 shape of this file) made EVERY new-file
	// write's paired tool_result refuse to run diagnostics/autofix/format at
	// all — a full pipeline regression worse than the bug #1642 fixes.
	const targetIgnored = isPathIgnoredByProject(
		filePath,
		runtime.projectRoot,
		false,
	);
	if (attributesMutationTarget) {
		// #1642: record the canonical target BY TOOL-CALL IDENTITY — including
		// (especially) when it is being skipped here. The paired tool_result
		// must take this exact verdict rather than re-deriving its own path
		// from relative diff metadata, which is how a gitignored worktree
		// edit got re-attributed onto a same-relative-path parent file.
		runtime.recordToolCallAttribution(toolCallId, {
			resolvedPath: filePath,
			skipped: targetIgnored,
			originCwd: ctx.cwd ?? runtime.projectRoot,
		});
	}
	if (targetMissing) {
		// #1655 item 5: this early return used to be the whole story — pi-lens
		// did nothing, said nothing, and the file pi went on to read stayed
		// invisible to the read guard, the LSP warm, and the dispatch. The
		// variant ladder above now finds the macOS-shaped cases; when it probed
		// variants and STILL found nothing, say so rather than returning an
		// indistinguishable silence (defect shape 10). `write` is exempt for the
		// same reason #1642 F1 gives just above: a write's target legitimately
		// does not exist yet.
		//
		// Review F1: this used to also require `triedVariants.length > 0`, which
		// silenced exactly the misses the base-normalization gap produced —
		// those paths have no quote and no AM/PM, so every stage-2 candidate
		// collapses onto the base path and nothing is "tried". `unresolved` is
		// the whole condition; the tried list is detail for the reason string.
		if (toolName !== "write" && pathResolution?.unresolved) {
			const tried =
				pathResolution.triedVariants.length > 0
					? `tried ${pathResolution.triedVariants.join(", ")}`
					: "no variant differed from the resolved path";
			recordDegradationOnce({
				kind: "path-variant-unresolved",
				subject: filePath,
				reason: `${toolName}: no file at the resolved path, and none of pi's variants matched (${tried})`,
			});
		}
		return;
	}
	if (targetIgnored) {
		dbg(`tool_call: skipping gitignored file ${filePath}`);
		return;
	}

	const isExternalOrVendor = isExternalOrVendorFile(
		filePath,
		runtime.projectRoot,
	);

	const lspCapableFile = isLspCapableFile(filePath);
	const lspAutoTouchSkipped = shouldSkipLspAutoTouch(
		filePath,
		runtime.projectRoot,
	);
	const lspAutoTouchEligible = lspCapableFile && !lspAutoTouchSkipped;
	const shouldWarmReadLsp =
		toolName === "read" &&
		lspAutoTouchEligible &&
		runtime.shouldWarmLspOnRead(filePath);
	const shouldAutoTouch =
		(toolName === "write" ||
			toolName === "edit" ||
			toolName === "lsp_navigation" ||
			shouldWarmReadLsp) &&
		!getFlag("no-lsp") &&
		lspAutoTouchEligible;
	if (!lspCapableFile && !getFlag("no-lsp")) {
		dbg(
			`lsp auto-touch skipped: ${path.basename(filePath)} (file kind not LSP-capable)`,
		);
	} else if (lspAutoTouchSkipped && !getFlag("no-lsp")) {
		dbg(
			`lsp auto-touch skipped: ${path.basename(filePath)} (internal/support artifact)`,
		);
	}
	if (toolName === "read" && !getFlag("no-lsp") && !shouldWarmReadLsp) {
		const readSkipReason = !lspAutoTouchEligible
			? "file not eligible for LSP warm"
			: "already warming or warmed recently";
		dbg(
			`lsp read warm skipped: ${path.basename(filePath)} (${readSkipReason})`,
		);
	}
	if (shouldAutoTouch) {
		try {
			const fileContent = nodeFs.readFileSync(filePath, "utf-8");
			const maxClientWaitMs =
				toolName === "lsp_navigation"
					? LSP_TOOLCALL_NAV_TOUCH_BUDGET_MS
					: LSP_TOOLCALL_TOUCH_BUDGET_MS;
			if (toolName === "read") {
				runtime.markLspReadWarmStarted(filePath);
				dbg(`lsp read warm started: ${path.basename(filePath)}`);
			}
			void getLSPService()
				.touchFile(filePath, fileContent, {
					diagnostics: "none",
					source: `tool_call:${toolName}`,
					clientScope: "primary",
					maxClientWaitMs,
				})
				.then((result) => {
					if (toolName === "read") {
						if (result === undefined) {
							runtime.clearLspReadWarmState(filePath);
							dbg(
								`lsp read warm unavailable: ${path.basename(filePath)} (no LSP client ready)`,
							);
						} else {
							runtime.markLspReadWarmCompleted(filePath);
							dbg(`lsp read warm completed: ${path.basename(filePath)}`);
						}
					}
					if (ctx.ui) {
						updateLspStatus(ctx.ui.setStatus, ctx.ui.theme);
					}
				})
				.catch((err) => {
					if (toolName === "read") {
						runtime.clearLspReadWarmState(filePath);
					}
					dbg(`lsp auto-touch failed for ${filePath}: ${err}`);
				});
		} catch {
			if (toolName === "read") {
				runtime.clearLspReadWarmState(filePath);
			}
			// Best effort only; never block tool calls.
		}
	}

	const readInput = getReadToolInput(toolName, event.input);
	const requestedReadOffset = readInput?.offset ?? 1;
	const requestedReadLimit = readInput?.limit;
	let effectiveReadOffset = requestedReadOffset;
	let effectiveReadLimit = getEffectiveReadLimit(filePath, readInput);

	// --- Opportunistic read expansion via tree-sitter ---
	// For partial reads (small limit, not from line 1), find the enclosing
	// symbol and expand the read range to cover it. This gives the read guard
	// accurate symbol-level coverage without requiring an LSP server.
	let expandedByLsp = false;
	let enclosingSymbol:
		| {
				name: string;
				kind: string;
				startLine: number;
				endLine: number;
		  }
		| undefined;

	const readExpansionClient =
		toolName === "read" &&
		!getFlag("no-lsp") &&
		!isExternalOrVendor &&
		filePath &&
		readInput &&
		requestedReadLimit != null &&
		requestedReadLimit <= EXPANSION_LIMIT_LINES
			? getTreeSitterClient()
			: null;
	if (
		readExpansionClient &&
		filePath &&
		readInput &&
		requestedReadLimit != null
	) {
		const totalLines =
			effectiveReadLimit != null && requestedReadLimit == null
				? effectiveReadLimit
				: countFileLines(filePath);
		try {
			const expansion = await tryExpandRead(
				filePath,
				requestedReadOffset,
				requestedReadLimit,
				totalLines,
				readExpansionClient,
			);
			if (expansion) {
				readInput.offset = expansion.newOffset;
				readInput.limit = expansion.newLimit;
				effectiveReadOffset = expansion.newOffset;
				effectiveReadLimit = expansion.newLimit;
				expandedByLsp = true;
				let enriched = false;
				let enrichedAncestry = expansion.ancestry;
				const lspSymbols = await getOpenDocumentSymbols(filePath);
				const located = lspSymbols
					? findDocumentSymbolAtLine(
							lspSymbols,
							expansion.enclosingSymbol.startLine,
						)
					: undefined;
				if (located) {
					enclosingSymbol = {
						...expansion.enclosingSymbol,
						name: qualifiedLspSymbolName(located, lspSymbols),
						kind: lspSymbolKindName(located.symbol.kind),
					};
					// Flat SymbolInformation results (native-ts7's real shape) carry
					// no hierarchy — an empty LSP ancestry must NOT wipe the real
					// tree-sitter chain (#951 review finding 1). Enrich only when
					// the LSP actually provided one.
					if (located.ancestry.length > 0) {
						enrichedAncestry = located.ancestry.map((entry) => ({
							name: entry.name,
							kind: lspSymbolKindName(entry.kind),
							startLine:
								((entry.range ?? entry.location?.range)?.start.line ?? 0) + 1,
							endLine:
								((entry.range ?? entry.location?.range)?.end.line ?? 0) + 1,
						}));
					}
					enriched = true;
				} else {
					enclosingSymbol = expansion.enclosingSymbol;
				}
				logToolReadGuardEvent({
					event: "ts_range_expanded",
					sessionId: runtime.telemetrySessionId,
					filePath,
					requestedOffset: requestedReadOffset,
					requestedLimit: requestedReadLimit,
					effectiveOffset: expansion.newOffset,
					effectiveLimit: expansion.newLimit,
					symbol: enclosingSymbol.name,
					symbolKind: enclosingSymbol.kind,
					symbolStartLine: expansion.enclosingSymbol.startLine,
					symbolEndLine: expansion.enclosingSymbol.endLine,
					metadata: {
						enriched,
						durationMs: expansion.durationMs,
						budgetMs: EXPANSION_BUDGET_MS,
					},
				});
				const symbolPath = [
					...(enrichedAncestry ?? []).map((a) => a.name),
					enclosingSymbol.name,
				].join(" → ");
				dbg(
					`ts expanded read: ${path.basename(filePath)} ` +
						`lines ${requestedReadOffset}–${requestedReadOffset + requestedReadLimit - 1} ` +
						`→ ${symbolPath} ` +
						`(${expansion.newOffset}–${expansion.newOffset + expansion.newLimit - 1})`,
				);
			}
		} catch {
			// Best-effort only.
		}
	}

	// --- Read-Before-Edit Guard: record reads ---
	if (toolName === "read" && filePath && !isExternalOrVendor) {
		const totalLines = countFileLines(filePath);
		const deliveredLimit = effectiveReadLimit ?? 1;
		logToolReadGuardEvent({
			event: "read_pattern",
			sessionId: runtime.telemetrySessionId,
			filePath,
			requestedOffset: requestedReadOffset,
			requestedLimit: requestedReadLimit ?? deliveredLimit,
			effectiveOffset: effectiveReadOffset,
			effectiveLimit: deliveredLimit,
			metadata: {
				totalLines,
				isPartial:
					requestedReadLimit != null && requestedReadLimit < totalLines,
				fileKind: detectFileKind(filePath) ?? "unknown",
				fractionRead:
					totalLines > 0
						? Math.round((deliveredLimit / totalLines) * 100) / 100
						: 1,
				expandedByTs: expandedByLsp,
			},
		});
		runtime.readGuard.recordRead({
			filePath,
			requestedOffset: requestedReadOffset,
			requestedLimit: requestedReadLimit ?? deliveredLimit,
			effectiveOffset: effectiveReadOffset,
			effectiveLimit: deliveredLimit,
			expandedByLsp,
			enclosingSymbol,
			turnIndex: runtime.turnIndex,
			writeIndex: runtime.peekWriteIndex(),
			timestamp: Date.now(),
		});
	}

	const { complexityClient } = await loadBootstrapClients();
	// Record complexity baseline for historical tracking (booboo/tdi).
	// Not shown inline - just captured for delta analysis.
	if (
		!isExternalOrVendor &&
		complexityClient.isSupportedFile(filePath) &&
		!runtime.complexityBaselines.has(filePath)
	) {
		const baseline = await complexityClient.analyzeFile(filePath);
		if (baseline) {
			runtime.complexityBaselines.set(filePath, baseline);
			const { captureSnapshot } = await import("./metrics-history.js");
			captureSnapshot(filePath, {
				maintainabilityIndex: baseline.maintainabilityIndex,
				cognitiveComplexity: baseline.cognitiveComplexity,
				maxNestingDepth: baseline.maxNestingDepth,
				linesOfCode: baseline.linesOfCode,
				maxCyclomatic: baseline.maxCyclomaticComplexity,
				entropy: baseline.codeEntropy,
			});
		}
	}

	// --- Read-Before-Edit Guard: check edits ---
	// write = full replacement; no prior read needed (you're starting fresh).
	// edit = partial modification; guard enforced to prevent blind overwrites.
	const isEditOnly = isToolCallEventType("edit", event);
	const isWriteOrEdit = isToolCallEventType("write", event) || isEditOnly;

	// Track any Write so recordWritten can inject a synthetic read afterward.
	// The agent authored the content (new or overwritten), so it trivially "knows" the file.
	if (!isEditOnly && isWriteOrEdit && filePath && !getFlag("no-read-guard")) {
		runtime.readGuard.noteCreatedFile(
			filePath,
			runtime.turnIndex,
			runtime.peekWriteIndex(),
		);
	}

	// --- Indentation mismatch correction ---
	// Some models output spaces in oldText when the file uses tabs (or vice versa).
	// Detect this before the read guard runs so a recoverable mismatch does not
	// degrade into a no-line-info allow path.
	if (isEditOnly && filePath) {
		const editInput = (event as { input?: unknown }).input as {
			oldText?: string;
			newText?: string;
			edits?: Array<{ oldText?: string; newText?: string }>;
		};
		type EditIndentTarget = {
			label: string;
			value: string;
			newText: string | undefined;
			apply: (corrected: string) => void;
			applyNewText: (corrected: string) => void;
		};
		const oldTexts: EditIndentTarget[] = editInput.oldText
			? [
					{
						label: "oldText",
						value: editInput.oldText,
						newText: editInput.newText,
						apply: (corrected: string) => {
							editInput.oldText = corrected;
						},
						applyNewText: (corrected: string) => {
							editInput.newText = corrected;
						},
					},
				]
			: (editInput.edits ?? [])
					.map((e, i) =>
						e.oldText
							? {
									label: `edits[${i}].oldText`,
									value: e.oldText,
									newText: e.newText,
									apply: (corrected: string) => {
										e.oldText = corrected;
									},
									applyNewText: (corrected: string) => {
										e.newText = corrected;
									},
								}
							: null,
					)
					.filter((entry): entry is EditIndentTarget => entry !== null);
		// Read the file once; derive the two normalized forms needed by
		// tryCorrectIndentationMismatchFromContent (CRLF->LF only) and
		// countOldTextMatches / the autopatch bridge (host fuzzy-match space).
		let crlfContent: string | undefined;
		let matchNormalizedContent: string | undefined;
		try {
			const raw = nodeFs.readFileSync(filePath, "utf-8");
			crlfContent = raw.replace(/\r\n/g, "\n");
			matchNormalizedContent = normalizeOldTextForMatch(raw);
		} catch {
			// File unreadable — corrections will be skipped gracefully below.
		}

		// --- Pass 0: escaped control-char correction ---
		// Models may write literal \n or \t in oldText (JSON interprets them as actual
		// newline/tab) when the file has the two-character escape sequences (e.g. inside
		// a regex or string literal). Safety gates: original must not match at all;
		// escaped version must match exactly once.
		if (matchNormalizedContent !== undefined) {
			for (const entry of oldTexts) {
				const v = entry.value;
				if (!v.includes("\t") && !v.includes("\n")) continue;
				if (countOldTextMatches(filePath, v, matchNormalizedContent) !== 0)
					continue;
				const escaped = v.replace(/\t/g, "\\t").replace(/\n/g, "\\n");
				if (escaped === v) continue;
				if (
					countOldTextMatches(filePath, escaped, matchNormalizedContent) !== 1
				)
					continue;
				entry.apply(escaped);
				entry.value = escaped;
				logToolReadGuardEvent({
					event: "oldtext_escape_autopatched",
					sessionId: runtime.telemetrySessionId,
					filePath,
					metadata: { tool: "edit", label: entry.label },
				});
			}
		}

		// --- Pass 1: trailing whitespace correction ---
		// Editors strip trailing whitespace on save; the model may copy content
		// that had it. Safety gates: the original raw oldText must not already
		// match, and the stripped raw candidate must match exactly once. When
		// trailing empty lines are stripped from oldText, strip the equivalent
		// suffix from newText so the replacement span is not accidentally widened.
		if (crlfContent !== undefined) {
			for (const entry of oldTexts) {
				const patch = computeTrailingWhitespaceOldTextPatch({
					oldText: entry.value,
					newText: entry.newText,
					fileContent: crlfContent,
				});
				if (!patch) continue;
				entry.apply(patch.oldText);
				entry.value = patch.oldText;
				const newTextPatched =
					patch.newText !== undefined && patch.newText !== entry.newText;
				if (newTextPatched) {
					entry.applyNewText(patch.newText!);
					entry.newText = patch.newText;
				}
				logToolReadGuardEvent({
					event: "oldtext_trailing_ws_autopatched",
					sessionId: runtime.telemetrySessionId,
					filePath,
					metadata: {
						tool: "edit",
						label: entry.label,
						removedLineTrailingWhitespace: patch.removedLineTrailingWhitespace,
						removedTrailingEmptyLineCount: patch.removedTrailingEmptyLineCount,
						newTextTrailingEmptyLinesPatched: newTextPatched,
					},
				});
				// Bridge: same rationale as the indent autopatch — the
				// trailing-ws patcher only applies when the stripped oldText
				// matches exactly once against the file, so the agent's text
				// reflects real content at the matched span. Register a
				// synthetic read covering it so the read-guard downstream
				// doesn't fire a zero_read block after the verification.
				if (matchNormalizedContent !== undefined && runtime.readGuard) {
					const range = findUniqueMatchLineRange(
						matchNormalizedContent,
						patch.oldText,
					);
					if (range) {
						runtime.readGuard.recordRead({
							filePath,
							requestedOffset: range.startLine,
							requestedLimit: range.endLine - range.startLine + 1,
							effectiveOffset: range.startLine,
							effectiveLimit: range.endLine - range.startLine + 1,
							expandedByLsp: false,
							turnIndex: runtime.turnIndex,
							writeIndex: 0,
							timestamp: Date.now(),
						});
					}
				}
			}
		}

		const correctedOldTexts = oldTexts
			.map(({ label, value, newText, apply, applyNewText }) => {
				const corrected =
					crlfContent !== undefined
						? tryCorrectIndentationMismatchFromContent(value, crlfContent)
						: tryCorrectIndentationMismatch(value, filePath);
				return corrected === undefined
					? undefined
					: {
							label,
							value,
							newText,
							corrected,
							apply,
							applyNewText,
							currentMatchCount: countOldTextMatches(
								filePath,
								value,
								matchNormalizedContent,
							),
							correctedMatchCount: countOldTextMatches(
								filePath,
								corrected,
								matchNormalizedContent,
							),
							indentationOnly: isIndentationOnlyChange(value, corrected),
						};
			})
			.filter(
				(
					entry,
				): entry is EditIndentTarget & {
					corrected: string;
					currentMatchCount: number;
					correctedMatchCount: number;
					indentationOnly: boolean;
				} => entry !== undefined,
			);
		// Apply safe corrections individually — each edit stands alone.
		// Unsafe corrections (non-indentation-only or ambiguous) fall through
		// to resolveOldTextEdits, which handles them per-edit with proper
		// oldtext_duplicate / oldtext_not_found reporting and partial apply.
		for (const entry of correctedOldTexts) {
			if (
				entry.indentationOnly &&
				entry.currentMatchCount === 0 &&
				entry.correctedMatchCount === 1
			) {
				entry.apply(entry.corrected);
				const correctedNewText = entry.newText
					? retargetReplacementIndentation(
							entry.newText,
							entry.value,
							entry.corrected,
						)
					: undefined;
				if (correctedNewText !== undefined) {
					entry.applyNewText(correctedNewText);
				}
				logToolReadGuardEvent({
					event: "oldtext_indent_autopatched",
					sessionId: runtime.telemetrySessionId,
					filePath,
					metadata: {
						tool: "edit",
						label: entry.label,
						correctedMatchCount: entry.correctedMatchCount,
						newTextIndentationPatched: correctedNewText !== undefined,
					},
				});
				// Bridge: a unique-match autopatch proves the agent's oldText
				// reflects real content at this span. Register a synthetic read
				// for the matched range so a zero_read block downstream isn't
				// thrown after the autopatch already verified the content.
				if (matchNormalizedContent !== undefined && runtime.readGuard) {
					const range = findUniqueMatchLineRange(
						matchNormalizedContent,
						entry.corrected,
					);
					if (range) {
						runtime.readGuard.recordRead({
							filePath,
							requestedOffset: range.startLine,
							requestedLimit: range.endLine - range.startLine + 1,
							effectiveOffset: range.startLine,
							effectiveLimit: range.endLine - range.startLine + 1,
							expandedByLsp: false,
							turnIndex: runtime.turnIndex,
							writeIndex: 0,
							timestamp: Date.now(),
						});
					}
				}
			}
		}
	}
	if (isEditOnly && filePath && !getFlag("no-read-guard")) {
		const readGuard = runtime.readGuard;
		const isExistingFile =
			typeof readGuard?.isNewFile !== "function" ||
			!readGuard.isNewFile(filePath);
		if (readGuard && isExistingFile && !isExternalOrVendor) {
			const {
				touchedLines,
				editRanges,
				preflightError,
				partiallyApplicable,
				contentMatchValidated,
				editBatchSummary,
			} = getTouchedLinesForGuard(
				event,
				filePath,
				runtime.telemetrySessionId,
				readGuardCorrelationId,
			);
			if (preflightError) {
				if (partiallyApplicable && partiallyApplicable.length > 0) {
					try {
						const partial = await applyPartiallyApplicableEdits({
							filePath,
							edits: partiallyApplicable,
							summary: editBatchSummary,
							correlationId: readGuardCorrelationId,
							afterWrite: async () => {
								const {
									biomeClient,
									ruffClient,
									metricsClient,
									agentBehaviorClient,
								} = await loadBootstrapClients();
								const result = await handleToolResult({
									event: {
										toolName: "write",
										input: { path: filePath },
										details: {
											piLensPartialApply: true,
											readGuardCorrelationId,
										},
										content: [],
										// #1655 item 2: `provider`/`model`/`sessionId`/`session`
										// used to be forwarded here from the tool_call event.
										// pi builds a `tool_call` with exactly
										// `type`/`toolName`/`toolCallId`/`input`
										// (`@earendil-works/pi-coding-agent/dist/core/agent-session.js:230-234`,
										// source `src/core/agent-session.ts:~228-236`), so all
										// four were always `undefined` and the tool_result
										// branch they fed was unreachable.
									},
									getFlag: (name: string) => getFlag(name),
									dbg,
									runtime,
									cacheManager,
									biomeClient,
									ruffClient,
									metricsClient,
									resetLSPService,
									readGuard: runtime.readGuard,
									agentBehaviorRecord: (toolName, analyzedPath) =>
										agentBehaviorClient.recordToolCall(toolName, analyzedPath),
									formatBehaviorWarnings: (warnings) =>
										agentBehaviorClient.formatWarnings(warnings as any),
								});
								if (result?.isError) {
									throw new Error(
										"post-edit pipeline rejected synthetic partial apply",
									);
								}
								return result?.content
									?.map((item) => item.text)
									.filter((text): text is string => !!text)
									.join("\n\n");
							},
						});
						if (partial.postEditStatus === "failed") {
							return {
								block: true,
								reason: `${preflightError}\n\nPartial apply pipeline failed after ${partial.appliedCount} edit${partial.appliedCount === 1 ? "" : "s"} committed.`,
							};
						}
						if (partial.appliedCount > 0) {
							logToolReadGuardEvent({
								event: "edit_partial_apply",
								sessionId: runtime.telemetrySessionId,
								filePath,
								metadata: {
									appliedCount: partial.appliedCount,
									appliedTotal: partial.appliedTotal,
									appliedIndices: partial.appliedIndices,
									skippedCount: partial.skippedCount ?? 0,
									skippedTotal: partial.skippedTotal ?? 0,
									skippedIndices: partial.skippedIndices ?? "",
									indexesTruncated: partial.indexesTruncated ?? false,
									editBatchSummary: partial.summary,
									routedThroughPostEditPipeline: true,
								},
							});
							let reason = preflightError.replace(
								"🔄 RETRYABLE — Edit target not found",
								`⚠️ PARTIAL APPLY — ${partial.appliedCount} edit${partial.appliedCount !== 1 ? "s" : ""} applied (${partial.appliedIndices})`,
							);
							if (partial.postEditOutput) {
								reason += `\n\nPost-apply analysis:\n${partial.postEditOutput}`;
							}
							return { block: true, reason };
						}
					} catch {
						// fall through to full block
					}
				}
				if (!editBatchSummary) logBlockedEditSummary("preflight");
				return { block: true, reason: preflightError };
			}
			logToolReadGuardEvent({
				event: "edit_check_started",
				sessionId: runtime.telemetrySessionId,
				filePath,
				metadata: {
					tool: isToolCallEventType("write", event) ? "write" : "edit",
					touchedLines: touchedLines ?? null,
					isExistingFile,
				},
			});
			const verdict =
				typeof readGuard.checkEdit === "function"
					? readGuard.checkEdit(filePath, touchedLines, editRanges, {
							skipSnapshotCheck: !!contentMatchValidated,
							oldTextResolved: !!contentMatchValidated,
						})
					: { action: "allow" as const };
			// Content-verified range-stale relocation: the lines the agent meant
			// to edit moved (read-time line hashes uniquely match the new spot),
			// so re-target the positional edit to where the content now lives
			// instead of dead-ending. Safe because the hashes prove the new span
			// IS the intended content — the same guarantee that lets
			// pi-hashline-readmap auto-apply. Single-range only (set by the guard).
			if (verdict.relocation) {
				const relocated = relocateEditRange(
					(event as { input?: unknown }).input,
					verdict.relocation.from,
					verdict.relocation.to,
				);
				if (relocated) {
					const [toStart, toEnd] = verdict.relocation.to;
					runtime.readGuard?.recordRead({
						filePath,
						requestedOffset: toStart,
						requestedLimit: toEnd - toStart + 1,
						effectiveOffset: toStart,
						effectiveLimit: toEnd - toStart + 1,
						expandedByLsp: false,
						turnIndex: runtime.turnIndex,
						writeIndex: 0,
						timestamp: Date.now(),
					});
					logToolReadGuardEvent({
						event: "edit_range_relocated",
						sessionId: runtime.telemetrySessionId,
						filePath,
						metadata: {
							tool: "edit",
							from: verdict.relocation.from,
							to: verdict.relocation.to,
						},
					});
					// Relocation applied — let the re-targeted edit proceed.
				} else if (verdict.action === "block") {
					logBlockedEditSummary("range_relocated_blocked");
					return { block: true, reason: verdict.reason };
				}
			} else if (verdict.action === "block") {
				logBlockedEditSummary("read_guard_blocked");
				return {
					block: true,
					reason: verdict.reason,
				};
			}
		}
	}

	// --- Pre-write duplicate detection ---
	// Check if new content redefines functions that already exist elsewhere.
	// Uses cachedExports (populated at session_start via ast-grep scan).
	if (isWriteOrEdit && runtime.cachedExports.size > 0) {
		const newContent = getNewContentFromToolCall(event);
		if (newContent) {
			const dupeWarnings: string[] = [];
			const exportRe =
				/export\s+(?:async\s+)?(?:function|class|const|let|type|interface)\s+(\w+)/g;
			// Read current on-disk content once so we can check whether the file
			// being written already owns a given export (e.g. it IS the source and
			// another file merely re-exports from it). cachedExports only tracks one
			// file per name — whichever was scanned first — so a re-exporter can
			// win the slot and incorrectly shadow the original definition.
			let currentFileExports: Set<string> | undefined;
			if (filePath && nodeFs.existsSync(filePath)) {
				try {
					const currentContent = nodeFs.readFileSync(filePath, "utf-8");
					currentFileExports = new Set<string>();
					for (const m of currentContent.matchAll(exportRe)) {
						currentFileExports.add(m[1]);
					}
				} catch {
					// non-fatal — fall back to no current-export knowledge
				}
			}
			for (const match of newContent.matchAll(exportRe)) {
				const name = match[1];
				const existingFile = runtime.cachedExports.get(name);
				if (
					existingFile &&
					path.resolve(existingFile) !== path.resolve(filePath) &&
					!currentFileExports?.has(name)
				) {
					dupeWarnings.push(
						`\`${name}\` already exists in ${path.relative(runtime.projectRoot, existingFile)}`,
					);
				}
			}
			if (dupeWarnings.length > 0) {
				return {
					block: true,
					reason:
						"🔴 STOP - Redefining existing export(s). Import instead:\n" +
						dupeWarnings.map((w) => "  • " + w).join("\n"),
				};
			}
		}
	}
}
