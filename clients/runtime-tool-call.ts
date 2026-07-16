import * as nodeFs from "node:fs";
import * as path from "node:path";
import {
	extractReadPathsFromCommand,
	extractWrittenPathsFromCommand,
} from "./bash-file-access.js";
import { loadBootstrapClients } from "./bootstrap.js";
import type { CacheManager } from "./cache-manager.js";
import { detectFileKind } from "./file-kinds.js";
import { isPathIgnoredByProject } from "./file-utils.js";
import {
	evaluateGitGuard,
	isGitCommitOrPushAttempt,
} from "./git-guard.js";
import { normalizeForGuardMatch } from "./host-edit-normalize.js";
import { retargetReplacementIndentation } from "./indent-retarget.js";
import { LANGUAGE_POLICY } from "./language-policy.js";
import type { LSPShutdownOptions } from "./lsp/client.js";
import { getLSPService } from "./lsp/index.js";
import {
	computeTrailingWhitespaceOldTextPatch,
	findUniqueMatchLineRange,
} from "./oldtext-autopatch.js";
import { applyPartiallyApplicableEdits } from "./partial-edit-apply.js";
import { isExternalOrVendorFile } from "./path-utils.js";
import {
	EXPANSION_BUDGET_MS,
	EXPANSION_LIMIT_LINES,
	tryExpandRead,
} from "./read-expansion.js";
import { logReadGuardEvent } from "./read-guard-logger.js";
import {
	countFileLines,
	getTouchedLinesForGuard,
	relocateEditRange,
	tryCorrectIndentationMismatch,
	tryCorrectIndentationMismatchFromContent,
} from "./read-guard-tool-lines.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import { handleToolResult } from "./runtime-tool-result.js";
import { isToolCallEventType } from "./tool-event.js";
import { TreeSitterClient } from "./tree-sitter-client.js";

// The read-expansion tree-sitter client is only ever consulted from the
// tool_call path (opportunistic partial-read expansion below), so it lives
// here as a module-level singleton rather than being threaded through deps.
const _readExpansionClient = new TreeSitterClient();

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

function resolveToolCallFilePath(
	rawFilePath: string | undefined,
	cwd: string | undefined,
	projectRoot: string,
): string | undefined {
	if (!rawFilePath) return undefined;
	if (path.isAbsolute(rawFilePath)) return rawFilePath;
	return path.resolve(cwd ?? projectRoot, rawFilePath);
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
}

export type ToolCallResult = { block: true; reason?: string } | void;

export async function handleToolCall(
	deps: ToolCallDeps,
): Promise<ToolCallResult> {
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
	} = deps;

	const toolName = (event as { toolName?: string }).toolName ?? "";
	if (!lensEnabled) return;
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
	const filePath = resolveToolCallFilePath(
		rawFilePath,
		ctx.cwd,
		runtime.projectRoot,
	);

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
	if (!nodeFs.existsSync(filePath)) return;
	if (isPathIgnoredByProject(filePath, runtime.projectRoot, false)) {
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
						ctx.ui && updateLspStatus(ctx.ui.setStatus, ctx.ui.theme);
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

	if (
		toolName === "read" &&
		!getFlag("no-lsp") &&
		!isExternalOrVendor &&
		filePath &&
		readInput &&
		requestedReadLimit != null &&
		requestedReadLimit <= EXPANSION_LIMIT_LINES
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
				_readExpansionClient,
			);
			if (expansion) {
				readInput.offset = expansion.newOffset;
				readInput.limit = expansion.newLimit;
				effectiveReadOffset = expansion.newOffset;
				effectiveReadLimit = expansion.newLimit;
				expandedByLsp = true;
				enclosingSymbol = expansion.enclosingSymbol;
				logReadGuardEvent({
					event: "ts_range_expanded",
					sessionId: runtime.telemetrySessionId,
					filePath,
					requestedOffset: requestedReadOffset,
					requestedLimit: requestedReadLimit,
					effectiveOffset: expansion.newOffset,
					effectiveLimit: expansion.newLimit,
					symbol: expansion.enclosingSymbol.name,
					symbolKind: expansion.enclosingSymbol.kind,
					symbolStartLine: expansion.enclosingSymbol.startLine,
					symbolEndLine: expansion.enclosingSymbol.endLine,
					metadata: {
						durationMs: expansion.durationMs,
						budgetMs: EXPANSION_BUDGET_MS,
					},
				});
				const symbolPath = [
					...(expansion.ancestry ?? []).map((a) => a.name),
					expansion.enclosingSymbol.name,
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
		logReadGuardEvent({
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

	// --- Read-Before-Edit Guard: register file access done via `bash` ---
	// Mirrors how the Read/Write tools are tracked. Only the bash tool —
	// grep/find tools (and their patterns) are not contiguous file access.
	//   reads  (cat/head/tail/sed -n) → recordRead with the exact range shown
	//   writes (>, >>, tee, sed -i, cp/mv dest, touch) → noteCreatedFile, so the
	//          agent "owns" the file (recordWritten fires at tool_result), same
	//          as the Write tool.
	if (toolName === "bash" && !getFlag("no-read-guard")) {
		const cmd = (event.input as Record<string, unknown>)?.command;
		if (typeof cmd === "string" && cmd) {
			const effectiveCwd = ctx.cwd ?? runtime.projectRoot ?? process.cwd();
			const inScope = (fp: string) =>
				!isPathIgnoredByProject(fp, runtime.projectRoot, false) &&
				!isExternalOrVendorFile(fp, runtime.projectRoot);

			for (const span of extractReadPathsFromCommand(cmd, effectiveCwd)) {
				if (!inScope(span.filePath)) continue;
				runtime.readGuard.recordRead({
					filePath: span.filePath,
					requestedOffset: span.offset,
					requestedLimit: span.limit,
					effectiveOffset: span.offset,
					effectiveLimit: span.limit,
					expandedByLsp: false,
					turnIndex: runtime.turnIndex,
					writeIndex: runtime.peekWriteIndex(),
					timestamp: Date.now(),
				});
			}

			for (const wp of extractWrittenPathsFromCommand(cmd, effectiveCwd)) {
				if (!inScope(wp)) continue;
				runtime.readGuard.noteCreatedFile(
					wp,
					runtime.turnIndex,
					runtime.peekWriteIndex(),
				);
			}
		}
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
				logReadGuardEvent({
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
				logReadGuardEvent({
					event: "oldtext_trailing_ws_autopatched",
					sessionId: runtime.telemetrySessionId,
					filePath,
					metadata: {
						tool: "edit",
						label: entry.label,
						removedLineTrailingWhitespace:
							patch.removedLineTrailingWhitespace,
						removedTrailingEmptyLineCount:
							patch.removedTrailingEmptyLineCount,
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
				logReadGuardEvent({
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
			} = getTouchedLinesForGuard(event, filePath, runtime.telemetrySessionId);
			if (preflightError) {
				if (partiallyApplicable && partiallyApplicable.length > 0) {
					try {
						const partial = await applyPartiallyApplicableEdits({
							filePath,
							edits: partiallyApplicable,
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
										details: { piLensPartialApply: true },
										content: [],
										provider: (event as { provider?: string }).provider,
										model: (event as { model?: string }).model,
										sessionId: (event as { sessionId?: string }).sessionId,
										session: (event as { session?: { id?: string } }).session,
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
								return result?.content
									?.map((item) => item.text)
									.filter((text): text is string => !!text)
									.join("\n\n");
							},
						});
						if (partial.appliedCount > 0) {
							logReadGuardEvent({
								event: "edit_partial_apply",
								sessionId: runtime.telemetrySessionId,
								filePath,
								metadata: {
									appliedCount: partial.appliedCount,
									appliedIndices: partial.appliedIndices,
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
				return { block: true, reason: preflightError };
			}
			logReadGuardEvent({
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
					logReadGuardEvent({
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
					return { block: true, reason: verdict.reason };
				}
			} else if (verdict.action === "block") {
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
