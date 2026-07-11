import * as nodeCrypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import {
	extractGrepSearchReadsFromOutput,
	extractWrittenPathsFromCommand,
} from "./bash-file-access.js";
import type { BiomeClient } from "./biome-client.js";
import {
	registerSearchReads,
	type SearchReadLocation,
} from "./search-read-registration.js";
import type { CacheManager } from "./cache-manager.js";
import { createFileTime } from "./file-time.js";
import { isPathIgnoredByProject } from "./file-utils.js";
import type { ReadGuard } from "./read-guard.js";
import { getFormatService } from "./format-service.js";
import { isExternalOrVendorFile } from "./path-utils.js";
import { resolveLanguageRootForFile } from "./language-profile.js";
import { logLatency } from "./latency-logger.js";
import type { LSPShutdownOptions } from "./lsp/client.js";
import type { MetricsClient } from "./metrics-client.js";
import { runPipeline, type PipelineResult } from "./pipeline.js";
import {
	appendProjectChange,
	type ProjectChangeRange,
	type ProjectChangeSource,
} from "./project-changes.js";
import type { RuffClient } from "./ruff-client.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import { scheduleWordIndexPersist } from "./word-index.js";

interface ToolResultEvent {
	toolName: string;
	input: unknown;
	details?: unknown;
	content: Array<{ type: string; text?: string }>;
	provider?: string;
	model?: string;
	sessionId?: string;
	session?: { id?: string };
}

interface ToolResultDeps {
	event: ToolResultEvent;
	getFlag: (name: string) => boolean | string | undefined;
	dbg: (msg: string) => void;
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
	biomeClient: BiomeClient;
	ruffClient: RuffClient;
	metricsClient: MetricsClient;
	resetLSPService: (options?: LSPShutdownOptions) => void;
	agentBehaviorRecord: (toolName: string, filePath?: string) => unknown[];
	formatBehaviorWarnings: (warnings: unknown[]) => string;
	readGuard?: ReadGuard;
	/**
	 * Internal: set when the debounce timer fires to skip re-scheduling.
	 * Do not pass from external callers.
	 */
	_bypassDebounce?: boolean;
}

function parseDiffRanges(diff: string): { start: number; end: number }[] {
	const changedLines: number[] = [];
	for (const line of diff.split("\n")) {
		const match = line.match(/^[+-]\s*(\d+)\s/);
		if (match) {
			changedLines.push(Number.parseInt(match[1], 10));
		}
	}

	if (changedLines.length === 0) return [];

	const sorted = [...new Set(changedLines)].sort((a, b) => a - b);
	const ranges: { start: number; end: number }[] = [];
	let rangeStart = sorted[0];
	let rangeEnd = sorted[0];

	for (const line of sorted.slice(1)) {
		if (line <= rangeEnd + 1) {
			rangeEnd = line;
		} else {
			ranges.push({ start: rangeStart, end: rangeEnd });
			rangeStart = line;
			rangeEnd = line;
		}
	}
	ranges.push({ start: rangeStart, end: rangeEnd });

	return ranges;
}

// Deduplicates tool_result calls for the same post-write file state.
// The pi framework can emit one tool_result per edit hunk; those events often
// observe the same final file content. Deduping by file alone is unsafe because
// a later same-turn edit to the same file must still run the pipeline.
const inFlightPipelines = new Map<string, Promise<unknown>>();
const lastAnalyzedStateByFile = new Map<
	string,
	{ turnIndex: number; stateHash: string }
>();

// Called at turn_start — entries from the previous turn can never match the new
// turnIndex so they're dead weight. Clearing here keeps the map bounded to the
// files touched in the current turn only (typically < 20).
export function clearLastAnalyzedStateCache(): void {
	lastAnalyzedStateByFile.clear();
}

// ── Coalesce sequential edits via debounce window (#115) ────────────────────

type ToolResultReturn = {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
} | void;

interface DebouncedEntry {
	timer: NodeJS.Timeout;
	promise: Promise<ToolResultReturn>;
	resolve: (value: ToolResultReturn) => void;
	reject: (err: unknown) => void;
	latestDeps: ToolResultDeps;
	scheduledAt: number;
	coalescedCount: number;
}

const debouncedPipelines = new Map<string, DebouncedEntry>();

const DEFAULT_DEBOUNCE_MS = 0;
const MAX_DEBOUNCE_MS = 1000;

function getDebounceMs(): number {
	const raw = Number(process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS);
	if (!Number.isFinite(raw) || raw < 0) return DEFAULT_DEBOUNCE_MS;
	// Cap at 1s so turn_end and agent_end don't block on the timer for
	// pathologically long windows. flushDebouncedToolResults below also
	// short-circuits at boundary events.
	return Math.min(raw, MAX_DEBOUNCE_MS);
}

/**
 * Drain any pending debounced tool_result pipelines immediately, awaiting their
 * completion. Call from turn_end / agent_end before reading anything that depends
 * on the pipeline's bookkeeping (project change log, modified ranges, etc.).
 *
 * Passing a filePath flushes only that entry; omitting it flushes all.
 */
export async function flushDebouncedToolResults(
	filePath?: string,
): Promise<void> {
	const entries = filePath
		? debouncedPipelines.has(filePath)
			? [
					[
						filePath,
						debouncedPipelines.get(filePath) as DebouncedEntry,
					] as const,
				]
			: []
		: [...debouncedPipelines.entries()];
	for (const [key, entry] of entries) {
		clearTimeout(entry.timer);
		debouncedPipelines.delete(key);
		// Re-enter the pipeline synchronously via the bypass flag so the
		// timer body's resolve/reject still fires through the shared promise.
		handleToolResult({ ...entry.latestDeps, _bypassDebounce: true }).then(
			entry.resolve,
			entry.reject,
		);
	}
	if (entries.length > 0) {
		// Allow microtasks to settle so awaiting callers see the latest state.
		await Promise.all(
			entries.map(([, entry]) => entry.promise.catch(() => undefined)),
		);
	}
}

function scheduleDebounced(
	filePath: string,
	debounceMs: number,
	deps: ToolResultDeps,
): Promise<ToolResultReturn> {
	const existing = debouncedPipelines.get(filePath);
	if (existing) {
		clearTimeout(existing.timer);
		existing.latestDeps = deps;
		existing.coalescedCount += 1;
		existing.timer = setTimeout(() => {
			debouncedPipelines.delete(filePath);
			deps.dbg(
				`tool_result: debounce fired after ${
					existing.coalescedCount
				} coalesced calls for ${filePath}`,
			);
			handleToolResult({ ...existing.latestDeps, _bypassDebounce: true }).then(
				existing.resolve,
				existing.reject,
			);
		}, debounceMs);
		deps.dbg(
			`tool_result: coalesced into pending debounce for ${filePath} (count=${existing.coalescedCount})`,
		);
		return existing.promise;
	}

	let resolveFn!: (value: ToolResultReturn) => void;
	let rejectFn!: (err: unknown) => void;
	const promise = new Promise<ToolResultReturn>((res, rej) => {
		resolveFn = res;
		rejectFn = rej;
	});
	const entry: DebouncedEntry = {
		timer: setTimeout(() => {
			debouncedPipelines.delete(filePath);
			handleToolResult({ ...entry.latestDeps, _bypassDebounce: true }).then(
				entry.resolve,
				entry.reject,
			);
		}, debounceMs),
		promise,
		resolve: resolveFn,
		reject: rejectFn,
		latestDeps: deps,
		scheduledAt: Date.now(),
		coalescedCount: 1,
	};
	debouncedPipelines.set(filePath, entry);
	return promise;
}

function getFileStateHash(filePath: string): string {
	try {
		const content = nodeFs.readFileSync(filePath);
		return nodeCrypto.createHash("sha256").update(content).digest("hex");
	} catch (err) {
		const code = (err as { code?: string }).code ?? "unknown";
		return `unreadable:${code}`;
	}
}

function sourceForToolName(
	toolName: string,
	details?: unknown,
): ProjectChangeSource {
	if (
		(details as { piLensPartialApply?: unknown } | undefined)
			?.piLensPartialApply
	) {
		return "partial-apply";
	}
	return toolName === "write" ? "agent-write" : "agent-edit";
}

function singleRange(
	ranges: Array<{ start: number; end: number }> | undefined,
): ProjectChangeRange | undefined {
	return ranges?.length === 1 ? ranges[0] : undefined;
}

function recordProjectChange(args: {
	runtime: RuntimeCoordinator;
	cwd: string;
	filePath: string;
	source: ProjectChangeSource;
	changedRange?: ProjectChangeRange;
	dbg: (msg: string) => void;
}): void {
	const bump = (args.runtime as Partial<RuntimeCoordinator>).bumpFileSeq;
	if (!bump) return;
	const { projectSeq, fileSeq } = bump.call(args.runtime, args.filePath);
	try {
		appendProjectChange(args.cwd, {
			seq: projectSeq,
			timestamp: new Date().toISOString(),
			sessionId: args.runtime.telemetrySessionId,
			turnIndex: args.runtime.turnIndex,
			source: args.source,
			filePath: path.resolve(args.filePath),
			fileSeq,
			changedRange: args.changedRange,
		});
	} catch (err) {
		args.dbg(`project change log append failed for ${args.filePath}: ${err}`);
	}
}

export async function handleToolResult(deps: ToolResultDeps): Promise<{
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
} | void> {
	const {
		event,
		getFlag,
		dbg,
		runtime,
		cacheManager,
		biomeClient,
		ruffClient,
		metricsClient,
		resetLSPService,
		agentBehaviorRecord,
		formatBehaviorWarnings,
	} = deps;

	const rawFilePath = (event.input as { path?: string }).path;
	const workspaceRoot = runtime.projectRoot || process.cwd();
	const filePath = rawFilePath
		? path.isAbsolute(rawFilePath)
			? rawFilePath
			: path.resolve(workspaceRoot, rawFilePath)
		: rawFilePath;
	const behaviorWarnings = agentBehaviorRecord(event.toolName, filePath);

	// Bash writes (redirects, tee, sed -i, cp/mv, touch, git checkout/restore) —
	// these change file content but never go through the edit tool, so bash
	// early-returns before the dispatch pipeline below. For each in-project file
	// the command wrote/restored we therefore: (1) mark it authored-by-agent for
	// the read-guard (like the Write tool), and (2) re-run the pipeline via a
	// synthetic `write` event so its diagnostics, fileSeq, and change-log refresh.
	// Without (2) a `git checkout -- f` restore keeps serving the pre-restore
	// (e.g. broken-state) warnings on every later lens_diagnostics call.
	if (
		event.toolName === "bash" &&
		typeof (event.input as { command?: unknown }).command === "string"
	) {
		const command = (event.input as { command: string }).command;
		const written = extractWrittenPathsFromCommand(
			command,
			workspaceRoot,
		).filter(
			(wp) =>
				!isExternalOrVendorFile(wp, workspaceRoot) &&
				!isPathIgnoredByProject(wp, workspaceRoot, false),
		);
		for (const wp of written) {
			if (!getFlag("no-read-guard")) deps.readGuard?.recordWritten(wp);
			await handleToolResult({
				...deps,
				event: { ...event, toolName: "write", input: { path: wp } },
				_bypassDebounce: true,
			});
		}
	}

	// Search tools reveal specific lines (file:line) the agent then edits — register
	// those shown lines (± context) as reads so the follow-up edit isn't blocked (#169).
	// Our tools attach locations as `details.searchReads`; bash grep is parsed from
	// `grep -n` output. Only shown lines are registered, never the whole file.
	if (deps.readGuard && !getFlag("no-read-guard")) {
		const searchReads: SearchReadLocation[] = [];
		const detailSearchReads = (
			event.details as { searchReads?: SearchReadLocation[] }
		)?.searchReads;
		if (Array.isArray(detailSearchReads))
			searchReads.push(...detailSearchReads);
		if (
			event.toolName === "bash" &&
			typeof (event.input as { command?: unknown }).command === "string"
		) {
			const command = (event.input as { command: string }).command;
			const output = event.content
				.map((part) => (typeof part.text === "string" ? part.text : ""))
				.join("\n");
			searchReads.push(
				...extractGrepSearchReadsFromOutput(command, workspaceRoot, output),
			);
		}
		if (searchReads.length > 0) {
			registerSearchReads(deps.readGuard, searchReads, {
				projectRoot: workspaceRoot,
				turnIndex: runtime.turnIndex,
				writeIndex: runtime.peekWriteIndex(),
			});
		}
	}

	if (event.toolName !== "write" && event.toolName !== "edit") {
		dbg(
			`tool_result: skipped turn tracking - toolName="${event.toolName}" (not write/edit)`,
		);
		return;
	}
	if (!filePath) {
		dbg(
			`tool_result: skipped turn tracking - no filePath for toolName="${event.toolName}"`,
		);
		return;
	}
	if (isExternalOrVendorFile(filePath, workspaceRoot)) {
		dbg(
			`tool_result: skipped pipeline - file outside project root or in node_modules: ${filePath}`,
		);
		return;
	}

	// Coalesce sequential edits to the same file into one pipeline run against
	// the final state. Only the debounce-fired call (with _bypassDebounce=true)
	// proceeds to the pipeline body; in-window callers share its promise.
	if (!deps._bypassDebounce) {
		const debounceMs = getDebounceMs();
		if (debounceMs > 0) {
			return scheduleDebounced(filePath, debounceMs, deps);
		}
	}

	// Refresh the read-guard's FileTime stamp so that the model's own write
	// doesn't trigger a spurious "file_modified" block on the next edit.
	deps.readGuard?.recordWritten(filePath);

	// Keep cachedExports in sync after each write/edit so the pre-write STOP
	// check doesn't fire on names that were removed from this file this session.
	if (runtime.cachedExports.size > 0 && nodeFs.existsSync(filePath)) {
		const exportRe =
			/export\s+(?:async\s+)?(?:function|class|const|let|type|interface)\s+(\w+)/g;
		for (const [name, file] of runtime.cachedExports) {
			if (path.resolve(file) === path.resolve(filePath)) {
				runtime.cachedExports.delete(name);
			}
		}
		try {
			const freshContent = nodeFs.readFileSync(filePath, "utf-8");
			for (const match of freshContent.matchAll(exportRe)) {
				const name = match[1];
				if (!runtime.cachedExports.has(name)) {
					runtime.cachedExports.set(name, filePath);
				}
			}
		} catch {
			// Non-fatal — stale entry is worse than a missing one
		}
	}

	const initialStateHash = getFileStateHash(filePath);
	const pipelineDedupeKey = `${filePath}:${initialStateHash}`;

	// Deduplicate concurrent calls for the same final file state (pi can fire one
	// tool_result per edit hunk). Do not dedupe by file alone: a distinct later
	// same-turn edit to this file must still be analyzed.
	if (inFlightPipelines.has(pipelineDedupeKey)) {
		dbg(`tool_result: skipping duplicate concurrent state for ${filePath}`);
		await inFlightPipelines.get(pipelineDedupeKey);
		return;
	}

	// Deduplicate sequential duplicate events for the same post-write state in the
	// same turn while allowing later same-file edits whose content changed.
	const lastAnalyzed = lastAnalyzedStateByFile.get(filePath);
	if (
		lastAnalyzed?.turnIndex === runtime.turnIndex &&
		lastAnalyzed.stateHash === initialStateHash
	) {
		dbg(
			`tool_result: skipping already-analyzed file state this turn for ${filePath}`,
		);
		return;
	}

	const sessionFileTime = createFileTime("default");
	// tool_result is emitted after write/edit has already been applied.
	// Asserting pre-write stamps here produces false positives on rapid edits.
	sessionFileTime.read(filePath);
	if (!getFlag("no-read-guard")) {
		const readGuard = (
			runtime as {
				readGuard?: { recordWritten?: (writtenPath: string) => void };
			}
		).readGuard;
		readGuard?.recordWritten?.(filePath);
	}

	const toolResultStart = Date.now();
	dbg(`tool_result: tracking turn state for ${event.toolName} on ${filePath}`);

	if (isPathIgnoredByProject(filePath, workspaceRoot, false)) {
		dbg(`tool_result: skipping gitignored file ${filePath}`);
		return;
	}

	const dispatchCwd = resolveLanguageRootForFile(filePath, workspaceRoot);
	const turnStateCwd = path.resolve(workspaceRoot);
	dbg(
		`tool_result: resolved dispatch cwd ${dispatchCwd} for ${filePath} (turnState cwd ${turnStateCwd})`,
	);
	if (event.model || event.provider || event.sessionId || event.session?.id) {
		runtime.setTelemetryIdentity({
			model: event.model,
			provider: event.provider,
			sessionId: event.sessionId ?? event.session?.id,
		});
	}
	const writeIndex = runtime.nextWriteIndex();
	let modifiedRanges: Array<{ start: number; end: number }> | undefined;
	try {
		const details = event.details as { diff?: string } | undefined;
		dbg(
			`tool_result: details.diff=${details?.diff ? "present" : "missing"}, details keys: ${Object.keys(event.details || {}).join(", ")}`,
		);
		if (event.toolName === "edit" && details?.diff) {
			const diff = details.diff;
			dbg(
				`tool_result: diff content (first 500 chars): ${diff.substring(0, 500)}`,
			);
			const ranges = parseDiffRanges(diff);
			modifiedRanges = ranges;
			const importsChanged = /import\s/.test(diff) || /from\s+['"]/.test(diff);
			dbg(
				`tool_result: parsed ${ranges.length} ranges, importsChanged=${importsChanged}`,
			);
			for (const range of ranges) {
				dbg(
					`tool_result: adding range ${range.start}-${range.end} for ${filePath}`,
				);
				cacheManager.addModifiedRange(
					filePath,
					range,
					importsChanged,
					turnStateCwd,
					runtime.telemetrySessionId,
				);
			}
			dbg(
				`tool_result: turn state after add: ${JSON.stringify(cacheManager.readTurnState(turnStateCwd))}`,
			);
		} else if (event.toolName === "write" && nodeFs.existsSync(filePath)) {
			const content = nodeFs.readFileSync(filePath, "utf-8");
			const lineCount = content.split("\n").length;
			const hasImports = /^import\s/m.test(content);
			modifiedRanges = [{ start: 1, end: lineCount }];
			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: lineCount },
				hasImports,
				turnStateCwd,
				runtime.telemetrySessionId,
			);
		}
	} catch (err) {
		dbg(`turn state tracking error: ${err}`);
		dbg(`turn state tracking error stack: ${(err as Error).stack}`);
	}

	recordProjectChange({
		runtime,
		cwd: turnStateCwd,
		filePath,
		source: sourceForToolName(event.toolName, event.details),
		changedRange: singleRange(modifiedRanges),
		dbg,
	});

	const turnStateMs = Date.now() - toolResultStart;
	logLatency({
		type: "phase",
		toolName: event.toolName,
		filePath,
		phase: "turn_state_tracking",
		durationMs: turnStateMs,
	});
	dbg(`tool_result fired for: ${filePath} (turn_state: ${turnStateMs}ms)`);

	let result: PipelineResult;
	const pipelinePromise = runPipeline(
		{
			filePath,
			cwd: dispatchCwd,
			toolName: event.toolName,
			modifiedRanges,
			telemetry: {
				model: runtime.telemetryModel,
				sessionId: runtime.telemetrySessionId,
				turnIndex: runtime.turnIndex,
				writeIndex,
			},
			getFlag,
			dbg,
			// #451: hand the deferred cascade live sequence accessors so the
			// review-graph builder can skip its per-build O(project) sweep when
			// only pi-observed edits happened. projectSeq is a function because the
			// cascade runs after this returns (#450) — read current, not captured.
			seqState: {
				projectSeq: () => runtime.projectSeq,
				getFilesChangedSince: (seq: number) =>
					runtime.getFilesChangedSince(seq),
			},
			// #348 phase 2: live reference so the deferred cascade can update the
			// warm word index in place at the same seam as the graph rebuild.
			// `runtime.wordIndex` is read fresh (not captured) via this closure-free
			// property access being re-evaluated at object-literal construction
			// time here — that's fine because runPipeline reads `ctx.wordIndex`
			// synchronously into computeCascadeForFile's options before returning
			// (the deferred part is the cascade's OWN execution, not this handoff).
			wordIndex: runtime.wordIndex,
			onWordIndexUpdated: (index) => {
				scheduleWordIndexPersist(dispatchCwd, index, dbg);
			},
		},
		{
			biomeClient,
			ruffClient,
			metricsClient,
			getFormatService,
			fixedThisTurn: runtime.fixedThisTurn,
		},
	);
	inFlightPipelines.set(pipelineDedupeKey, pipelinePromise);
	try {
		result = await pipelinePromise;
	} catch (pipelineErr) {
		dbg(`runPipeline crashed: ${pipelineErr}`);
		dbg(`runPipeline crash stack: ${(pipelineErr as Error).stack}`);
		if (!getFlag("no-lsp")) {
			resetLSPService({ fast: true });
		}

		logLatency({
			type: "tool_result",
			toolName: event.toolName,
			filePath,
			durationMs: Date.now() - toolResultStart,
			result: "pipeline_crash",
		});

		const notice = runtime.formatPipelineCrashNotice(filePath, pipelineErr);
		if (!notice) return;

		return {
			content: [...event.content, { type: "text", text: notice }],
		};
	} finally {
		inFlightPipelines.delete(pipelineDedupeKey);
	}

	lastAnalyzedStateByFile.set(filePath, {
		turnIndex: runtime.turnIndex,
		stateHash: getFileStateHash(filePath),
	});

	// The model's write/edit and pi-lens' own immediate format/autofix are now
	// reflected on disk. Refresh read-guard staleness stamps so a follow-up edit
	// is judged by read-range coverage, not by our own previous write.
	if (!getFlag("no-read-guard")) {
		const changedForReadGuard = new Set([
			path.resolve(filePath),
			...(result.changedFiles ?? []).map((changedFile) =>
				path.resolve(changedFile),
			),
		]);
		for (const changedFile of changedForReadGuard) {
			if (nodeFs.existsSync(changedFile)) {
				deps.readGuard?.recordWritten(changedFile);
			}
		}
	}

	if (
		!result.isError &&
		!getFlag("no-autoformat") &&
		!getFlag("immediate-format") &&
		nodeFs.existsSync(filePath)
	) {
		runtime.deferFormat(filePath, dispatchCwd, event.toolName, turnStateCwd);
		dbg(`tool_result: queued deferred format for ${filePath}`);
		logLatency({
			type: "phase",
			toolName: event.toolName,
			filePath,
			phase: "deferred_format_queued",
			durationMs: 0,
			metadata: { cwd: dispatchCwd },
		});
	}

	for (const changedFile of result.changedFiles ?? []) {
		const resolvedChanged = path.resolve(changedFile);
		if (!nodeFs.existsSync(resolvedChanged)) continue;
		recordProjectChange({
			runtime,
			cwd: turnStateCwd,
			filePath: resolvedChanged,
			source: "autofix",
			dbg,
		});
		if (resolvedChanged === path.resolve(filePath)) continue;
		try {
			const content = nodeFs.readFileSync(resolvedChanged, "utf-8");
			const lineCount = content.split("\n").length;
			const hasImports = /^import\s/m.test(content);
			cacheManager.addModifiedRange(
				resolvedChanged,
				{ start: 1, end: lineCount },
				hasImports,
				turnStateCwd,
			);
			dbg(
				`tool_result: tracking pi-lens side-effect change for ${resolvedChanged}`,
			);
		} catch (err) {
			dbg(
				`tool_result: side-effect tracking failed for ${resolvedChanged}: ${err}`,
			);
		}
	}

	if (result.cascadePromise) {
		runtime.appendCascadePromise(result.cascadePromise);
	}

	if (result.actionableWarnings?.length) {
		runtime.recordActionableWarnings(result.actionableWarnings);
	}
	if (result.codeQualityWarnings?.length) {
		runtime.recordCodeQualityWarnings(result.codeQualityWarnings);
	}

	// #484: opt-in per-turn summary collection. Same signals the pipeline
	// already computed above (diagnostics, autofix count/tools, formatters
	// used) — no new collection plumbing, just fed into the collector when
	// the feature is on.
	if (getFlag("lens-turn-summary")) {
		if (result.diagnostics?.length) {
			for (const d of result.diagnostics) {
				runtime.turnSummary.recordDiagnostic(d.filePath || filePath, {
					tool: d.tool,
					ruleId: d.rule ?? d.code,
					severity: d.severity,
					line: d.line,
					description: d.message,
				});
			}
		}
		if (result.fixedCount && result.fixedCount > 0) {
			for (const label of result.autofixTools ?? []) {
				const [tool, countStr] = label.split(":");
				const count = Number.parseInt(countStr ?? "", 10);
				runtime.turnSummary.recordAutofix(filePath, {
					tool: tool || label,
					description:
						Number.isFinite(count) && count > 0
							? `${count} issue(s) fixed`
							: undefined,
				});
			}
		}
		if (result.formattersUsed?.length) {
			for (const tool of result.formattersUsed) {
				runtime.turnSummary.recordFormat(filePath, { tool });
			}
		}
	}

	if (result.inlineBlockerSummary) {
		runtime.recordInlineBlockers(filePath, result.inlineBlockerSummary);
	} else {
		runtime.clearInlineBlockers(filePath);
	}

	if (result.isError) {
		return {
			content: [...event.content, { type: "text", text: result.output }],
			isError: true,
		};
	}

	let output = result.output;
	runtime.updateGitGuardStatus(result.hasBlockers, result.output);
	if (behaviorWarnings.length > 0 && !result.hasBlockers) {
		output += `\n\n${formatBehaviorWarnings(behaviorWarnings)}`;
	}

	const totalMs = Date.now() - toolResultStart;
	logLatency({
		type: "tool_result",
		toolName: event.toolName,
		filePath,
		durationMs: totalMs,
		result: output ? "completed" : "no_output",
	});

	runtime.reportedThisTurn.add(filePath);

	if (!output) return;

	return {
		content: [...event.content, { type: "text", text: output }],
	};
}
