import * as nodeCrypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { noteAuthoritativeContentAttachment } from "./agent-nudge.js";
import {
	captureFileStats,
	diffFileStats,
	getOpaqueBaselineStore,
	recoverOpaqueChangesViaGit,
} from "./opaque-mutation-scan.js";
import { normalizeMapKey } from "./path-utils.js";
import {
	extractReadPathsFromCommand,
	extractDeletedPathsFromCommand,
	extractGrepSearchReadsFromOutput,
	extractWrittenPathsFromCommand,
	tokenizeShellCommand,
} from "./bash-file-access.js";
import type { BiomeClient } from "./biome-client.js";
import {
	registerSearchReads,
	type SearchReadLocation,
} from "./search-read-registration.js";
import type { CacheManager } from "./cache-manager.js";
import { createFileTime } from "./file-time.js";
import { publishFormatQueued } from "./format-events-publish.js";
import {
	invalidateProjectIgnoreMatcherForPath,
	isPathIgnoredByProject,
} from "./file-utils.js";
import { invalidateFormatterCacheForPath } from "./formatters.js";
import type { ReadGuard } from "./read-guard.js";
import { getFormatService } from "./format-service.js";
import {
	isExternalOrVendorFile,
	normalizeEphemeralMapKey,
	pathsEqual,
} from "./path-utils.js";
import { PathKeyedMap } from "./path-keyed-map.js";
import { resolveLanguageRootForFile } from "./language-profile.js";
import { logLatency } from "./latency-logger.js";
import { resolveToolCallCorrelationId } from "./tool-event.js";
import {
	boundedIndexesForCount,
	createReadGuardEditBatchSummary,
	getReadGuardCorrelationId,
	logReadGuardEvent,
} from "./read-guard-logger.js";
import type { PiLensFlagSource } from "./lens-config.js";
import type { EditToolDetails } from "@earendil-works/pi-coding-agent";
import type { LSPShutdownOptions } from "./lsp/client.js";
import { notifyExternalFileChange } from "./lsp/index.js";
import type { MetricsClient } from "./metrics-client.js";
import { type PipelineResult, runPipeline } from "./pipeline.js";
import {
	type AuthoritativeAttachmentDecision,
	renderPostAutofixNotice,
} from "./post-autofix-notice.js";
import {
	type ProjectChangeRange,
	type ProjectChangeSource,
} from "./project-changes.js";
import type { RuffClient } from "./ruff-client.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import { syncGitGuardRecord } from "./git-guard.js";
import { scheduleWordIndexPersist } from "./word-index.js";
import { RUNTIME_CONFIG } from "./runtime-config.js";
import { getActiveSessionId } from "./session-lifecycle.js";

const AUTHORITATIVE_CONTENT_MAX_BYTES = RUNTIME_CONFIG.pipeline.lspMaxFileBytes;

/**
 * Git subcommands that import ANOTHER commit's content into the index. The
 * whole family, with a verdict for each (#2060):
 * - merge, rebase, cherry-pick, pull, revert, am: IN. Each stages the other
 *   side's clean files beside the unmerged ones. `pull` is fetch+merge and
 *   `am --3way` reaches the same unmerged state, both probed on git 2.55.
 * - stash pop / stash apply: OUT. A conflicted pop leaves `M ` entries too,
 *   but that content is the agent's OWN stashed work. Excluding it would
 *   destroy exactly what opaque recovery exists to capture.
 * - checkout -m: OUT. Its "incoming" side is the agent's local modifications
 *   carried across the switch, so the same reasoning applies.
 * - apply -3 / --3way: OUT. The patch is normally one the agent wrote, and
 *   `apply` is far more often used without conflicts, so the narrower default
 *   is to keep capturing.
 * Membership only ARMS the filter; it still needs a real unmerged entry to do
 * anything, so a non-integration use of a listed subcommand is inert.
 */
const GIT_INTEGRATION_SUBCOMMANDS = new Set([
	"merge",
	"rebase",
	"cherry-pick",
	"pull",
	"revert",
	"am",
]);
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
	"-C",
	"-c",
	"--config-env",
	"--git-dir",
	"--namespace",
	"--work-tree",
]);

/**
 * Failed integration commands are the one opaque-recovery case where Git's
 * index contains changes made by the other branch rather than the agent.
 * Keep this narrow: ordinary scripts and successful Git operations retain the
 * normal recovery contract.
 */
export function isFailedGitIntegrationCommand(
	command: string,
	isError: boolean | undefined,
): boolean {
	if (isError !== true) return false;
	return tokenizeShellCommand(command).some(({ tokens, unsupported }) => {
		if (unsupported) return false;
		const executable = path.win32
			.basename(tokens[0] ?? "")
			.toLowerCase()
			.replace(/\.(?:cmd|exe)$/, "");
		if (executable !== "git") return false;
		for (let index = 1; index < tokens.length; index += 1) {
			const token = tokens[index] ?? "";
			if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(token)) {
				index += 1;
				continue;
			}
			if (token.startsWith("-")) continue;
			return GIT_INTEGRATION_SUBCOMMANDS.has(token);
		}
		return false;
	});
}

/**
 * The `tool_result` payload pi-lens actually receives.
 *
 * Kept aligned with what pi BUILDS, not with what a payload might plausibly
 * carry. `AgentSession._installAgentToolHooks`'s `afterToolCall` constructs the
 * event literal with exactly eight keys —
 * `type`/`toolName`/`toolCallId`/`input`/`content`/`details`/`isError`/`usage`
 * (`@earendil-works/pi-coding-agent/dist/core/agent-session.js:243-256`, source
 * `src/core/agent-session.ts:502-516`) — and `ExtensionRunner.emitToolResult`
 * forwards that same object to every handler
 * (`dist/core/extensions/runner.js:649-651`, source `runner.ts:877-880`).
 *
 * #1655 item 2 removed seven fields this interface used to declare that pi
 * never sets on the wire: `id`, `callId`, `requestId`, `provider`, `model`,
 * `sessionId`, and `session`. They made a telemetry-identity branch here
 * unreachable against a real host. Identity is read from the runtime instead —
 * see the `telemetry:` block handed to `runPipeline` below, which already
 * sources `model`/`sessionId`/`provider` from `RuntimeCoordinator`.
 *
 * Do not re-add a field here without a pi source line that assigns it.
 */
interface ToolResultEvent {
	toolName: string;
	toolCallId?: string | number;
	/** Host tool_result status; distinct from pi-lens PipelineResult.isError. */
	isError?: boolean;
	input: unknown;
	details?: unknown;
	content: Array<{ type: string; text?: string }>;
}

interface ToolResultDeps {
	event: ToolResultEvent;
	getFlag: (name: string, filePath?: string) => boolean | string | undefined;
	/** Optional: provenance for dbg/skip logs — see `PipelineContext["getFlagSource"]` (#792). */
	getFlagSource?: (name: string, filePath?: string) => PiLensFlagSource;
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
	 * The STABLE pi session id for the ctx this tool_result fired on
	 * (`ctx.sessionManager.getSessionId()`), when the host supplies one.
	 * Threaded onto the resulting `DeferredFormatRecord` as `ownerSessionId`
	 * (#791) so a later `agent_end` can tell "did THIS session queue this
	 * file" apart from a concurrent in-process secondary session's firing.
	 */
	sessionId?: string;
	/**
	 * Internal: set when the debounce timer fires to skip re-scheduling.
	 * Do not pass from external callers.
	 */
	_bypassDebounce?: boolean;
	/** #2000: overrides the change-log source for this synthetic dispatch. */
	_mutationSourceOverride?: ProjectChangeSource;
	/** Internal bounded provenance carried through debounce/coalescing. */
	_telemetryParticipantIds?: string[];
	_telemetryParticipantTotal?: number;
	/** Receipt-time decision preserved across debounce replacement. */
	_autofixMode?: "immediate" | "deferred";
	/**
	 * Internal: authoritative-content bytes still available to this tool result.
	 *
	 * A multi-file bash write drives one synthetic `handleToolResult` call per
	 * written path, and all of those attachments land in ONE tool result. The
	 * outer call therefore hands every synthetic call the same mutable budget
	 * object so the attachment decision below reads the per-file cap and the
	 * shared budget in one expression (#1590). Absent means "no shared budget"
	 * — a direct write, bounded by the per-file cap alone.
	 */
	_attachmentBudget?: { remaining: number };
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
interface InFlightPipeline {
	promise: Promise<unknown>;
	participantIds: string[];
	participantTotal: number;
}

// Keyed by (normalized) filePath, then by the raw stateHash — the path portion
// needs normalizing (divergent Windows spellings must collapse to one entry),
// the stateHash suffix must NOT be folded into the path key (a real content
// change for the same file has to stay a distinct entry). A flat
// `PathKeyedMap<InFlightPipeline>` keyed by a composite `${filePath}:${hash}`
// string can't express that split cleanly (the normalizer only sees the whole
// composite string, so it can't fold the path half without also mangling the
// hash half); nesting keeps each axis normalized/compared with its own rules.
const inFlightPipelines = new PathKeyedMap<Map<string, InFlightPipeline>>(
	normalizeEphemeralMapKey,
);
const lastAnalyzedStateByFile = new PathKeyedMap<{
	turnIndex: number;
	stateHash: string;
}>(normalizeEphemeralMapKey);

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

const debouncedPipelines = new PathKeyedMap<DebouncedEntry>(
	normalizeEphemeralMapKey,
);

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
		const incomingId =
			deps._telemetryParticipantIds?.[0] ??
			getReadGuardCorrelationId(deps.event);
		const priorIds = existing.latestDeps._telemetryParticipantIds ?? [];
		existing.latestDeps = {
			...deps,
			_telemetryParticipantIds: [...priorIds, incomingId].slice(0, 100),
			_telemetryParticipantTotal:
				(existing.latestDeps._telemetryParticipantTotal ?? priorIds.length) + 1,
		};
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
	const initialParticipantIds = deps._telemetryParticipantIds ?? [
		getReadGuardCorrelationId(deps.event),
	];
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
		latestDeps: {
			...deps,
			_telemetryParticipantIds: initialParticipantIds.slice(0, 100),
			_telemetryParticipantTotal:
				deps._telemetryParticipantTotal ?? initialParticipantIds.length,
		},
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

function getRequestedEditCount(event: ToolResultEvent): number {
	if (event.toolName === "write") return 1;
	const edits = (event.input as { edits?: unknown[] } | undefined)?.edits;
	return Array.isArray(edits) && edits.length > 0 ? edits.length : 1;
}

function getRequestedEditIndexes(event: ToolResultEvent): number[] {
	return boundedIndexesForCount(getRequestedEditCount(event));
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
	// One mutation seam (#2000 phase 1): bump + receipt + change-log live in
	// RuntimeCoordinator.recordProjectMutation; this wrapper only carries the
	// legacy dbg shape.
	(args.runtime as Partial<RuntimeCoordinator>).recordProjectMutation?.({
		filePath: args.filePath,
		source: args.source,
		cwd: args.cwd,
		changedRange: args.changedRange,
		onAppendError: (err) =>
			args.dbg(`project change log append failed for ${args.filePath}: ${err}`),
	});
}

export async function handleToolResult(deps: ToolResultDeps): Promise<{
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
} | void> {
	const {
		event,
		getFlag,
		getFlagSource,
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

	// #1642: a gitignored worktree edit got re-attributed onto a
	// same-relative-path file in the parent checkout because this handler
	// used to always resolve a relative path against `workspaceRoot`
	// (`runtime.projectRoot`), with no idea the call actually ran under a
	// different cwd/worktree.
	//
	// Source-level correction (pi host audit, earendil-works/pi): tool_call's
	// own resolved path is NOT authoritative for what executed —
	// `agent-session.ts:914-919`'s extension-handler contract lets a LATER
	// `tool_call` handler mutate `event.input` in place with no
	// re-validation, and edit's `prepareArguments` rewrites args before the
	// event fires at all. `tool_result.input`, by contrast, is populated
	// from the EXECUTED args (`agent-session.ts:502-516`) — it is the
	// authoritative path source. So the correlation record's job is narrower
	// than "the path": it is the RESOLUTION BASIS (the cwd/worktree the call
	// actually ran under). Every tool_result resolves ITS OWN authoritative
	// `rawFilePath` against that basis, rather than trusting a call-time path
	// that a later handler may have superseded.
	const toolCallId = resolveToolCallCorrelationId(event);
	const attribution =
		toolCallId !== undefined
			? runtime.takeToolCallAttribution(toolCallId)
			: undefined;

	let resolutionBasis: string;
	if (attribution) {
		resolutionBasis = attribution.originCwd;
	} else if (
		toolCallId !== undefined &&
		rawFilePath &&
		!path.isAbsolute(rawFilePath)
	) {
		// A real correlation id existed (the host DOES support one) but no
		// attribution was recorded under it — evicted, cleared because the
		// call was blocked before it could execute, or simply never seen by
		// `handleToolCall`. A RELATIVE path here is ambiguous: we have no
		// idea which cwd it is relative to, and guessing `workspaceRoot` is
		// exactly the #1642 collapse. Fail CLOSED instead of guessing — no
		// turn state, no deferred work — and log it so a real incident is
		// countable rather than silently mis-attributed.
		const guessedPath = path.resolve(workspaceRoot, rawFilePath);
		// Existence is not execution evidence: a same-named file can exist in
		// the workspace while the tool ran in another cwd. Without the recorded
		// call target and origin cwd there is no comparison to make, so retain the
		// full record and fail closed.
		dbg(
			`path_attribution_missing: no recorded resolution basis for toolCallId=${toolCallId}, refusing relative path ${rawFilePath} (would have guessed ${guessedPath})`,
		);
		logLatency({
			type: "phase",
			toolName: event.toolName,
			filePath: guessedPath,
			phase: "path_attribution_missing",
			durationMs: 0,
			metadata: { toolCallId, rawFilePath, guessedPath },
		});
		return;
	} else {
		// Either an ABSOLUTE path (bash-synthetic writes always pass one —
		// unambiguous regardless of any basis, see the bash-write dispatch
		// below) or a host that supplies NO correlation id at all under any
		// known field name. The latter cannot be correlated by identity full
		// stop; this is the SAME exposure every host had before this fix,
		// not a regression introduced by it.
		resolutionBasis = workspaceRoot;
	}
	const filePath = rawFilePath
		? path.isAbsolute(rawFilePath)
			? rawFilePath
			: path.resolve(resolutionBasis, rawFilePath)
		: rawFilePath;
	if (filePath) {
		invalidateProjectIgnoreMatcherForPath(filePath);
		invalidateFormatterCacheForPath(filePath);
	}

	// Purely diagnostic: tool_call's call-time verdict (computed on ITS OWN
	// resolved path, which may since have been superseded) disagreed with
	// what actually executed. This does NOT gate anything by itself — the
	// ignore re-check below, running on the freshly & correctly resolved
	// `filePath`, is the real decision — but a divergence is exactly the
	// shape of the reported incident, so it is named legibly.
	if (
		attribution?.skipped &&
		filePath &&
		attribution.resolvedPath &&
		!pathsEqual(filePath, attribution.resolvedPath)
	) {
		const message = `path_attribution_refused: call target ${attribution.resolvedPath} (originCwd=${attribution.originCwd}) vs tool_result resolved ${filePath}`;
		dbg(message);
		logLatency({
			type: "phase",
			toolName: event.toolName,
			filePath,
			phase: "path_attribution_refused",
			durationMs: 0,
			metadata: {
				callTarget: attribution.resolvedPath,
				resolvedPath: filePath,
				originCwd: attribution.originCwd,
			},
		});
	}
	const behaviorWarnings = agentBehaviorRecord(event.toolName, filePath);
	const syntheticWriteContent: Array<{ type: string; text?: string }> = [];
	// #1590: one shared authoritative-content budget for every path this bash
	// command wrote. It is handed DOWN to each synthetic call so the single
	// attachment decision there sees both limits; nothing re-decides out here.
	const syntheticAttachmentBudget = {
		remaining: AUTHORITATIVE_CONTENT_MAX_BYTES,
	};

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
		const recognized = extractWrittenPathsFromCommand(command, workspaceRoot);
		// The SURVIVING recognized set: what will actually dispatch. Failure
		// atomicity (#2000 invariant 5) means opaque recovery must subtract
		// THIS set, not raw recognized - otherwise a redirect target dropped
		// by the isError filter would be subtracted from recovery AND
		// excluded here, attributed nowhere.
		const recognizedWritten =
			event.isError !== true
				? recognized.filter(
						(wp) =>
							!isExternalOrVendorFile(wp, workspaceRoot) &&
							!isPathIgnoredByProject(wp, workspaceRoot, false),
					)
				: [];
		// #2000 phase 2: when the extractor recognizes NOTHING, the command is
		// opaque-candidate — recover its actual changed set by diffing the pre
		// snapshot taken at tool_call. Partial writes that landed before a
		// nonzero exit ARE attributed (the files changed and the agent authored
		// them) — a deliberate divergence from the isError filter above, which
		// exists for restore semantics where attribution would lie.
		let opaquePaths: string[] = [];
		// Recovery runs for EVERY bash command with a pending baseline - not
		// only recognized-empty ones. A mixed command (`python x.py > out.ts`
		// plus script-internal writes) previously skipped observation entirely
		// with zero telemetry; git-first recovery is cheap enough (~60ms) to
		// close that gap, subtracting already-recognized paths so nothing
		// double-dispatches.
		if (workspaceRoot && !getFlag("no-read-guard")) {
			const scanRoot = workspaceRoot;
			const started = Date.now();
			const pending = getOpaqueBaselineStore().take(
				`${normalizeMapKey(path.resolve(scanRoot))}:${runtime.sessionGeneration}`,
			);
			let unknownReason: string | undefined;
			if (!pending && recognized.length > 0) {
				// Partial coverage without observation: the explicit verdict
				// invariant 1 demands (never silently imply no change).
				unknownReason = "partial-recognition-no-baseline";
			} else if (!pending) {
				unknownReason = "no-pending-snapshot";
			} else if (pending.strategy === "git") {
				// Git-first: no universe cap - works on any repo size.
				const recovery = await recoverOpaqueChangesViaGit(
					scanRoot,
					pending.startedAt,
					{
						excludeIndexOnlyWhenUnmerged: isFailedGitIntegrationCommand(
							command,
							event.isError,
						),
					},
				);
				if (recovery.verdict === "recovered") {
					opaquePaths = recovery.paths.filter(
						(p) =>
							!isExternalOrVendorFile(p, scanRoot) &&
							!isPathIgnoredByProject(p, scanRoot, false),
					);
				} else if (recovery.verdict === "unknown") {
					// #2060: deliberately WIDER than the old `recognized.length > 0`
					// guard. A fully opaque command whose probe failed is the shape
					// whose coverage is least knowable, and it used to record
					// nothing at all.
					unknownReason = recovery.unknownReason;
				}
				// #2060: both counts are bounded (one record per tool_result, no
				// per-path logging) and exist because filtering is invisible in
				// production otherwise - the dropped paths simply never appear.
				if ((recovery.excludedIncomingCount ?? 0) > 0) {
					logLatency({
						type: "phase",
						phase: "opaque_mutation_incoming_excluded",
						filePath: command.slice(0, 80),
						durationMs: Date.now() - started,
						result: `excluded:${recovery.excludedIncomingCount}`,
					});
				}
				if ((recovery.unknownStatusCount ?? 0) > 0) {
					logLatency({
						type: "phase",
						phase: "opaque_mutation_status_pair_unknown",
						filePath: command.slice(0, 80),
						durationMs: Date.now() - started,
						result: `kept:${recovery.unknownStatusCount}`,
					});
				}
			} else if (pending.stats) {
				const outcome = await captureFileStats(scanRoot, {
					withHashes: true,
				});
				if (outcome.snapshot && !outcome.unknownReason) {
					opaquePaths = diffFileStats(pending.stats, outcome.snapshot);
				} else {
					unknownReason =
						outcome.unknownReason ??
						pending.statsUnknownReason ??
						"walk-failed";
				}
			} else {
				unknownReason = pending.statsUnknownReason ?? "walk-failed";
			}
			if (opaquePaths.length > 0 && recognizedWritten.length > 0) {
				const survivingKeys = new Set(
					recognizedWritten.map((p) => normalizeMapKey(path.resolve(p))),
				);
				opaquePaths = opaquePaths.filter((p) => !survivingKeys.has(p));
			}
			if (unknownReason) {
				logLatency({
					type: "phase",
					phase: "opaque_mutation_coverage_unknown",
					filePath: command.slice(0, 80),
					durationMs: Date.now() - started,
					result: unknownReason,
				});
			}
			if (opaquePaths.length > 0) {
				logLatency({
					type: "phase",
					phase: "opaque_mutation_recovered",
					filePath: opaquePaths.slice(0, 5).join(","),
					durationMs: Date.now() - started,
					result: `changed:${opaquePaths.length}`,
				});
			}
		}
		// wp iterates opaquePaths VERBATIM (already normalizeMapKey keys), so the
		// set must hold those exact strings - no re-resolution.
		const opaqueSet = new Set(opaquePaths);
		const written = [...recognizedWritten, ...opaquePaths];
		for (const wp of written) {
			if (!getFlag("no-read-guard")) deps.readGuard?.recordWritten(wp);
			const receipt = (runtime as Partial<RuntimeCoordinator>)
				.recordMutationToolReceipt;
			const autofixMode = receipt
				? receipt.call(runtime, wp, "write").autofixMode
				: "immediate";
			// Recovered opaque writes carry their own source so the change log
			// distinguishes them from parsed writes (auditable in production).
			const isOpaque = opaqueSet.has(wp);
			// Failure atomicity: an opaque-recovered file VERIFIABLY exists on
			// disk, so its synthetic event must not inherit isError - the main
			// path early-returns on failed host results before attribution,
			// which would silently drop exactly the partial writes invariant 5
			// says to attribute.
			const syntheticEvent = {
				...event,
				toolName: "write",
				input: { path: wp },
				isError: false,
			};
			const syntheticResult = await handleToolResult({
				...deps,
				event: syntheticEvent,
				_bypassDebounce: true,
				_autofixMode: autofixMode,
				_attachmentBudget: syntheticAttachmentBudget,
				_mutationSourceOverride: isOpaque ? "opaque-script" : undefined,
			});
			if (syntheticResult) {
				// #1590: forward verbatim. The synthetic call already charged the
				// shared budget above and phrased its own notice from the decision
				// it made, so a second verdict out here could only contradict it —
				// which is exactly the defect this shape produced before.
				syntheticWriteContent.push(
					...syntheticResult.content.slice(event.content.length),
				);
			}
		}
		if (event.isError !== true && !getFlag("no-read-guard")) {
			for (const span of extractReadPathsFromCommand(command, workspaceRoot)) {
				if (isExternalOrVendorFile(span.filePath, workspaceRoot)) continue;
				if (isPathIgnoredByProject(span.filePath, workspaceRoot, false))
					continue;
				deps.readGuard?.recordRead({
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
		}

		// #1668: bash-deleted files never go through the edit tool, so nothing
		// else tells an LSP server one of its watched files is gone — the ONLY
		// existing enqueue site fires on first open and can only emit type 1/2.
		// Extract the command's likely delete targets, confirm each by existence
		// (never scan the workspace — only the paths the command named), and only
		// act on paths pi-lens already knows about (a read or a write this
		// session) so an `rm` on something pi-lens never touched is not treated
		// as a signal. Each match is routed to already-active LSP clients as a
		// type-3 watched-files event through the same #271 coalescing queue a
		// burst of deletes still flushes as one notification per server.
		if (
			event.isError !== true &&
			!getFlag("no-lsp") &&
			!getFlag("no-read-guard")
		) {
			for (const dp of extractDeletedPathsFromCommand(command, workspaceRoot)) {
				if (isExternalOrVendorFile(dp, workspaceRoot)) continue;
				if (isPathIgnoredByProject(dp, workspaceRoot, false)) continue;
				if (!deps.readGuard || !deps.readGuard.hasKnownPath(dp)) continue;
				// #1668 review F4: this is the ONLY gate standing between a merely
				// NAMED path and an actual confirmed delete — extractDeletedPathsFromCommand
				// only proposes candidates from parsing the command text, so it can't
				// tell `git rm --cached f` (index-only, file still on disk) from a
				// real delete, can't see a short-circuited `rm f && false` that never
				// ran, and can't resolve a relative path run from a `cd`-ed subdirectory
				// against the wrong cwd. Every one of those is caught here, and only
				// here — do not remove or reorder this check relative to the loop body.
				if (nodeFs.existsSync(dp)) continue; // still there — not a real delete
				deps.readGuard.forgetPath(dp);
				void notifyExternalFileChange(dp, 3).catch((err) => {
					dbg(`tool_result: external-delete notify failed for ${dp}: ${err}`);
				});
			}
		}
	}

	// Search tools reveal specific lines (file:line) the agent then edits — register
	// those shown lines (± context) as reads so the follow-up edit isn't blocked (#169).
	// Our tools attach locations as `details.searchReads`; bash grep is parsed from
	// `grep -n` output. Only shown lines are registered, never the whole file.
	if (deps.readGuard && event.isError !== true && !getFlag("no-read-guard")) {
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
		return syntheticWriteContent.length > 0
			? { content: [...event.content, ...syntheticWriteContent] }
			: undefined;
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
	const readGuardCorrelationId = getReadGuardCorrelationId(event);
	const resultDetails = (event.details ?? {}) as Record<string, unknown>;
	const isPartialApplyResult = resultDetails.piLensPartialApply === true;
	const requestedEditIndexes = getRequestedEditIndexes(event);
	const requestedEditTotal = getRequestedEditCount(event);
	const participantIds = [
		...(deps._telemetryParticipantIds ?? []),
		readGuardCorrelationId,
	].slice(0, 100);
	const participantTotal =
		(deps._telemetryParticipantTotal ?? 0) +
		(deps._telemetryParticipantIds?.includes(readGuardCorrelationId) ? 0 : 1);
	const hostToolResultFailed =
		event.isError === true || resultDetails.isError === true;
	if (hostToolResultFailed) {
		logReadGuardEvent({
			event: "edit_batch_summary",
			correlationId: readGuardCorrelationId,
			filePath,
			metadata: {
				tool: event.toolName,
				source: "host_tool_result",
				editBatchSummary: createReadGuardEditBatchSummary({
					requestedIndexes: requestedEditIndexes,
					requestedTotal: requestedEditTotal,
					rejectedReasons: requestedEditIndexes.map((index) => ({
						index,
						code: "write_failed" as const,
					})),
					rejectedTotal: requestedEditTotal,
					participantIds: [readGuardCorrelationId],
					participantTotal: 1,
					commitStatus: "failed",
					terminalStatus: "failed",
				}),
			},
		});
		return { content: event.content, isError: true };
	}

	// Must happen before debounce admission: latestDeps intentionally retains only
	// the latest event, but write -> edit is a sticky turn transition.
	const receipt = (runtime as Partial<RuntimeCoordinator>)
		.recordMutationToolReceipt;
	const autofixMode = deps._bypassDebounce
		? (deps._autofixMode ??
			(event.toolName === "edit" ? "deferred" : "immediate"))
		: receipt
			? receipt.call(runtime, filePath, event.toolName).autofixMode
			: event.toolName === "edit"
				? "deferred"
				: "immediate";

	// Coalesce sequential edits to the same file into one pipeline run against
	// the final state. Only the debounce-fired call (with _bypassDebounce=true)
	// proceeds to the pipeline body; in-window callers share its promise.
	if (!deps._bypassDebounce) {
		const debounceMs = getDebounceMs();
		if (debounceMs > 0) {
			return scheduleDebounced(filePath, debounceMs, {
				...deps,
				_autofixMode: autofixMode,
				_telemetryParticipantIds: [readGuardCorrelationId],
				_telemetryParticipantTotal: 1,
			});
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

	// Deduplicate concurrent calls for the same final file state (pi can fire one
	// tool_result per edit hunk). Do not dedupe by file alone: a distinct later
	// same-turn edit to this file must still be analyzed.
	const inFlight = inFlightPipelines.get(filePath)?.get(initialStateHash);
	if (inFlight) {
		dbg(`tool_result: skipping duplicate concurrent state for ${filePath}`);
		const duplicateId = readGuardCorrelationId;
		if (inFlight.participantIds.length < 100) {
			inFlight.participantIds.push(duplicateId);
		}
		inFlight.participantTotal += 1;
		await inFlight.promise;
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
	// #1655 item 2: a `setTelemetryIdentity` call used to sit here, gated on
	// `event.model`/`provider`/`sessionId`/`session.id`. pi sets none of those on
	// a `tool_result` — `afterToolCall` builds the event with exactly
	// `type`/`toolName`/`toolCallId`/`input`/`content`/`details`/`isError`/`usage`
	// (`@earendil-works/pi-coding-agent/dist/core/agent-session.js:243-256`,
	// source `src/core/agent-session.ts:502-516`), so the gate was always false
	// against a real host and the branch never ran. Identity for this dispatch
	// comes from the runtime, which `message_start`/`session_start` populate —
	// see the `telemetry:` block handed to `runPipeline` below.
	const writeIndex = runtime.nextWriteIndex();
	let modifiedRanges: Array<{ start: number; end: number }> | undefined;
	try {
		// #1334 S6: the host DECLARES this payload (`EditToolDetails`, a
		// type-only export), so use it instead of re-declaring `{ diff?: string }`
		// here — the ad-hoc shape hid the sibling `patch`/`firstChangedLine`
		// fields. `Partial<>` keeps the defensive posture: the host types mark
		// `diff` required, but this runs against whatever a live host actually
		// sent, and the `details?.diff` truthiness check below is what the code
		// has always relied on.
		const details = event.details as Partial<EditToolDetails> | undefined;
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
		source:
			deps._mutationSourceOverride ??
			sourceForToolName(event.toolName, event.details),
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
			projectRoot: turnStateCwd,
			toolName: event.toolName,
			autofixMode,
			modifiedRanges,
			telemetry: {
				model: runtime.telemetryModel,
				sessionId: runtime.telemetrySessionId,
				turnIndex: runtime.turnIndex,
				writeIndex,
				modelId: runtime.telemetryModelId,
				provider: runtime.telemetryProviderId,
			},
			getFlag,
			getFlagSource,
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
			// The settle clock is live because the deferred cascade may reach its
			// budget derivation before or after turn_end starts waiting.
			turnEndCascadeSettleStart: () => runtime.getTurnEndCascadeSettleStart(),
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
	const pipelineTelemetry: InFlightPipeline = {
		promise: pipelinePromise,
		participantIds: [...new Set(participantIds)].slice(0, 100),
		participantTotal,
	};
	let filePipelines = inFlightPipelines.get(filePath);
	if (!filePipelines) {
		filePipelines = new Map<string, InFlightPipeline>();
		inFlightPipelines.set(filePath, filePipelines);
	}
	filePipelines.set(initialStateHash, pipelineTelemetry);
	try {
		result = await pipelinePromise;
	} catch (pipelineErr) {
		if (getFlag("lens-guard")) {
			runtime.markGitGuardCacheUnknown("pipeline_crash");
		}
		dbg(`runPipeline crashed: ${pipelineErr}`);
		logReadGuardEvent({
			event: "edit_post_edit_pipeline_failed",
			correlationId: readGuardCorrelationId,
			filePath,
			metadata: {
				tool: event.toolName,
				commitStatus: "committed",
				reasonCode: "pipeline_failed",
			},
		});
		logReadGuardEvent({
			event: "edit_batch_summary",
			correlationId: readGuardCorrelationId,
			filePath,
			metadata: {
				tool: event.toolName,
				editBatchSummary: createReadGuardEditBatchSummary({
					requestedIndexes: requestedEditIndexes,
					requestedTotal: requestedEditTotal,
					resolvedIndexes: requestedEditIndexes,
					resolvedTotal: requestedEditTotal,
					appliedIndexes: requestedEditIndexes,
					appliedTotal: requestedEditTotal,
					participantIds: pipelineTelemetry.participantIds,
					participantTotal: pipelineTelemetry.participantTotal,
					commitStatus: "committed",
					postEditStatus: "failed",
					terminalStatus: "failed",
					durationMs: Date.now() - toolResultStart,
				}),
			},
		});
		dbg(`runPipeline crash stack: ${(pipelineErr as Error).stack}`);
		// The LSP fleet is process-wide, but a pipeline crash belongs to one
		// evaluation. A registered primary owns the fleet; a known secondary
		// must not tear it down. Keep the historical reset when no registration
		// exists because synthetic callers and early startup have no role evidence.
		const activePrimarySessionId = getActiveSessionId();
		const crashBelongsToPrimary =
			activePrimarySessionId === undefined ||
			activePrimarySessionId === runtime.telemetrySessionId;
		if (!getFlag("no-lsp") && crashBelongsToPrimary) {
			resetLSPService({ fast: true, reason: "pipeline_crash" });
		}

		logLatency({
			type: "tool_result",
			toolName: event.toolName,
			filePath,
			durationMs: Date.now() - toolResultStart,
			result: "pipeline_crash",
		});

		const notice = runtime.formatPipelineCrashNotice(filePath, pipelineErr);
		return {
			content: notice
				? [...event.content, { type: "text", text: notice }]
				: event.content,
			isError: true,
		};
	} finally {
		// Prune the per-file inner map once it's empty so a file touched once
		// this session doesn't leave a permanent empty entry in the outer map.
		filePipelines.delete(initialStateHash);
		if (filePipelines.size === 0) {
			inFlightPipelines.delete(filePath);
		}
	}

	if (!isPartialApplyResult) {
		const postEditStatus = result.isError ? "failed" : "succeeded";
		if (result.isError) {
			logReadGuardEvent({
				event: "edit_post_edit_pipeline_failed",
				correlationId: readGuardCorrelationId,
				filePath,
				metadata: {
					tool: event.toolName,
					commitStatus: "committed",
					reasonCode: "pipeline_failed",
				},
			});
		}
		logReadGuardEvent({
			event: "edit_batch_summary",
			correlationId: readGuardCorrelationId,
			filePath,
			metadata: {
				tool: event.toolName,
				editBatchSummary: createReadGuardEditBatchSummary({
					requestedIndexes: requestedEditIndexes,
					requestedTotal: requestedEditTotal,
					resolvedIndexes: requestedEditIndexes,
					resolvedTotal: requestedEditTotal,
					appliedIndexes: requestedEditIndexes,
					appliedTotal: requestedEditTotal,
					participantIds: pipelineTelemetry.participantIds,
					participantTotal: pipelineTelemetry.participantTotal,
					commitStatus: "committed",
					postEditStatus,
					terminalStatus: postEditStatus === "failed" ? "failed" : "success",
					durationMs: Date.now() - toolResultStart,
				}),
			},
		});
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

	let autofixNewlyQueued = false;
	if (
		!result.isError &&
		autofixMode === "deferred" &&
		nodeFs.existsSync(filePath)
	) {
		autofixNewlyQueued =
			(runtime as Partial<RuntimeCoordinator>).deferMutation?.call(
				runtime,
				filePath,
				dispatchCwd,
				event.toolName,
				turnStateCwd,
				"autofix",
				deps.sessionId,
				resolutionBasis,
			) ?? false;
		dbg(`tool_result: queued deferred autofix for ${filePath}`);
	}
	let formatQueued = false;

	if (
		!result.isError &&
		!getFlag("no-autoformat", filePath) &&
		(autofixMode === "deferred" || !getFlag("immediate-format")) &&
		nodeFs.existsSync(filePath)
	) {
		const isNewlyQueued = runtime.deferFormat(
			filePath,
			dispatchCwd,
			event.toolName,
			turnStateCwd,
			deps.sessionId,
			resolutionBasis,
		);
		formatQueued = true;
		dbg(`tool_result: queued deferred format for ${filePath}`);
		logLatency({
			type: "phase",
			toolName: event.toolName,
			filePath,
			phase: "deferred_format_queued",
			durationMs: 0,
			metadata: { cwd: dispatchCwd },
		});
		// Publish a file's first queue entry and each newly added kind. A same-kind
		// re-touch before agent_end carries no new information and stays silent.
		if (isNewlyQueued || autofixNewlyQueued) {
			publishFormatQueued({
				filePath,
				cwd: dispatchCwd,
				tool: event.toolName,
				dbg,
				kinds: autofixMode === "deferred" ? ["autofix", "format"] : ["format"],
			});
		}
	}
	if (autofixNewlyQueued && !formatQueued) {
		publishFormatQueued({
			filePath,
			cwd: dispatchCwd,
			tool: event.toolName,
			kinds: ["autofix"],
			dbg,
		});
	}

	for (const changedFile of result.changedFiles ?? []) {
		const resolvedChanged = path.resolve(changedFile);
		invalidateFormatterCacheForPath(resolvedChanged);
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
		// #1561: stamp the verdict with THIS dispatch's write token — the same
		// counter `lsp_diagnostics`' reconciliation seam draws from — so a later
		// confirmed-clean result can be ordered against it instead of racing it.
		runtime.recordInlineBlockers(
			filePath,
			result.inlineBlockerSummary,
			writeIndex,
			result.inlineBlockerSources,
			result.inlineBlockerLines,
		);
	} else {
		runtime.clearInlineBlockers(filePath);
	}

	runtime.updateGitGuardStatus(result.hasBlockers, result.output);
	if (getFlag("lens-guard")) {
		syncGitGuardRecord(runtime, cacheManager, turnStateCwd, filePath);
		if (result.isError && !result.hasBlockers) {
			runtime.markGitGuardCacheUnknown("pipeline_error");
		}
	}

	if (result.isError) {
		return {
			content: [...event.content, { type: "text", text: result.output }],
			isError: true,
		};
	}

	let output = result.output;
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

	// --- The ONE authoritative-attachment decision (#1590) ---
	// Everything downstream — the attached block, the telemetry row, the nudge
	// suppression, and the notice sentence — reads this single verdict. It is
	// the only place that sees both limits: the per-file cap and the shared
	// per-command budget a multi-file bash write threads in.
	const postMutation = result.postMutation;
	const attachmentText = postMutation
		? `pi-lens applied autofix to ${postMutation.filePath}. The following full content is authoritative for subsequent edits:\n\n${postMutation.content}`
		: "";
	const contentBytes = postMutation
		? Buffer.byteLength(postMutation.content, "utf-8")
		: 0;
	const withinPerFileCap = contentBytes <= AUTHORITATIVE_CONTENT_MAX_BYTES;
	const budget = deps._attachmentBudget;
	const withinSharedBudget =
		!budget || Buffer.byteLength(attachmentText, "utf-8") <= budget.remaining;
	const attachAuthoritativeContent =
		postMutation !== undefined && withinPerFileCap && withinSharedBudget;
	const attachmentDecision: AuthoritativeAttachmentDecision = !postMutation
		? "none"
		: attachAuthoritativeContent
			? "attached"
			: withinPerFileCap
				? "aggregate-budget-degraded"
				: "size-capped";
	// #1590: the pipeline hands up the changed-file data and this layer renders
	// the sentence, so a size-capped write can no longer carry both "attached
	// content is authoritative" and "too large to attach". The fallback covers
	// a post-mutation with no notice data, which must still say re-read.
	const notice =
		result.postAutofixNotice ??
		(postMutation
			? { targetPath: postMutation.filePath, changedFiles: [] }
			: undefined);
	if (postMutation && attachAuthoritativeContent && budget) {
		budget.remaining -= Buffer.byteLength(attachmentText, "utf-8");
	}
	// #1590 review F1: every mutation that produced a notice logs a row,
	// INCLUDING the `none` decision a format-only change makes. Gating the row
	// on `postMutation` made a legitimate "nothing was attachable here" verdict
	// indistinguishable from missing instrumentation, which is the same
	// empty-vs-errored confusion the read paths already guard against.
	if (postMutation || notice) {
		logLatency({
			type: "phase",
			phase: "authoritative_content_attachment_decision",
			filePath: postMutation?.filePath ?? filePath,
			durationMs: 0,
			metadata: {
				path: postMutation?.filePath ?? filePath,
				bytes: contentBytes,
				decision: attachmentDecision,
			},
		});
	}
	if (postMutation) {
		// #1464: the nudge suppresses exactly the paths this decision
		// delivered. Same boolean the attachment below reads — the nudge layer
		// never re-derives the cap or the budget for itself.
		noteAuthoritativeContentAttachment(
			postMutation.filePath,
			attachAuthoritativeContent,
		);
	}
	const returnedContent = attachAuthoritativeContent
		? [...event.content, { type: "text", text: attachmentText }]
		: event.content;
	if (notice) {
		output = `${output ? `${output}\n\n` : ""}${renderPostAutofixNotice(notice, attachmentDecision)}`;
	}

	if (!output && !result.postMutation) return;

	return {
		content: output
			? [...returnedContent, { type: "text", text: output }]
			: returnedContent,
	};
}
