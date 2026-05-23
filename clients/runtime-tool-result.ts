import * as nodeCrypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import type { BiomeClient } from "./biome-client.js";
import type { CacheManager } from "./cache-manager.js";
import { createFileTime } from "./file-time.js";
import { isPathIgnoredByProject } from "./file-utils.js";
import type { ReadGuard } from "./read-guard.js";
import { getFormatService } from "./format-service.js";
import { isExternalOrVendorFile } from "./path-utils.js";
import { resolveLanguageRootForFile } from "./language-profile.js";
import { logLatency } from "./latency-logger.js";
import type { MetricsClient } from "./metrics-client.js";
import { runPipeline, type PipelineResult } from "./pipeline.js";
import type { RuffClient } from "./ruff-client.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";

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
	resetLSPService: () => void;
	agentBehaviorRecord: (toolName: string, filePath?: string) => unknown[];
	formatBehaviorWarnings: (warnings: unknown[]) => string;
	readGuard?: ReadGuard;
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

function getFileStateHash(filePath: string): string {
	try {
		const content = nodeFs.readFileSync(filePath);
		return nodeCrypto.createHash("sha256").update(content).digest("hex");
	} catch (err) {
		const code = (err as { code?: string }).code ?? "unknown";
		return `unreadable:${code}`;
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

	const cwd = resolveLanguageRootForFile(filePath, workspaceRoot);
	dbg(`tool_result: resolved dispatch cwd ${cwd} for ${filePath}`);
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
					cwd,
					runtime.telemetrySessionId,
				);
			}
			dbg(
				`tool_result: turn state after add: ${JSON.stringify(cacheManager.readTurnState(cwd))}`,
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
				cwd,
				runtime.telemetrySessionId,
			);
		}
	} catch (err) {
		dbg(`turn state tracking error: ${err}`);
		dbg(`turn state tracking error stack: ${(err as Error).stack}`);
	}

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
			cwd,
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
			resetLSPService();
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
		runtime.deferFormat(filePath, cwd, event.toolName);
		dbg(`tool_result: queued deferred format for ${filePath}`);
		logLatency({
			type: "phase",
			toolName: event.toolName,
			filePath,
			phase: "deferred_format_queued",
			durationMs: 0,
			metadata: { cwd },
		});
	}

	for (const changedFile of result.changedFiles ?? []) {
		const resolvedChanged = path.resolve(changedFile);
		if (resolvedChanged === path.resolve(filePath)) continue;
		if (!nodeFs.existsSync(resolvedChanged)) continue;
		try {
			const content = nodeFs.readFileSync(resolvedChanged, "utf-8");
			const lineCount = content.split("\n").length;
			const hasImports = /^import\s/m.test(content);
			cacheManager.addModifiedRange(
				resolvedChanged,
				{ start: 1, end: lineCount },
				hasImports,
				cwd,
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

	if (result.cascadeResult) {
		runtime.appendCascadeResult(result.cascadeResult);
	}

	if (result.actionableWarnings?.length) {
		runtime.recordActionableWarnings(result.actionableWarnings);
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
