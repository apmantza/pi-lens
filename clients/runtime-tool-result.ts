import * as nodeCrypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { noteAuthoritativeContentAttachment } from "./agent-nudge.js";
import {
	captureFileStats,
	type CaptureOptions,
	diffFileContent,
	getOpaqueBaselineStore,
	recoverOpaqueChangesViaGit,
} from "./opaque-mutation-scan.js";
import { normalizeMapKey } from "./path-utils.js";
import { detectFileKind } from "./file-kinds.js";
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
import {
	classifyMutatingTool,
	PI_LENS_SYNTHETIC_MUTATION_FIELD,
	type MutatingToolClassification,
	type MutationKind,
} from "./mutating-tool.js";
import {
	hasPendingObservation,
	noteMutationHandled,
	settleObservedMutation,
} from "./observed-mutation.js";
import {
	replayThroughMutationBridge,
	storedLineHashesFor,
} from "./observed-mutation-sources.js";
import { getAmbientAbortSignal } from "./safe-spawn.js";
import { resolveToolCallCorrelationId } from "./tool-event.js";
import {
	boundedIndexesForCount,
	createReadGuardEditBatchSummary,
	getReadGuardCorrelationId,
	logReadGuardEvent,
} from "./read-guard-logger.js";
import { countFileLines } from "./read-guard-tool-lines.js";
import type { PiLensFlagSource } from "./lens-config.js";
import type { EditToolDetails } from "@earendil-works/pi-coding-agent";
import type { LSPShutdownOptions } from "./lsp/client.js";
import {
	notifyExternalFileChange,
	resyncGitChangedFiles,
} from "./lsp/index.js";
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
import { requestBootstrapClients } from "./bootstrap.js";
import { bounded } from "./deadline-utils.js";
import { HOOK_WALL_BUDGET_MS } from "./hook-budgets.js";
import { recordDegradationOnce } from "./degradation-ledger.js";

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
	/** Abort signal owned by the tool_result hook. */
	signal?: AbortSignal;
	event: ToolResultEvent;
	getFlag: (name: string, filePath?: string) => boolean | string | undefined;
	/** Optional: provenance for dbg/skip logs — see `PipelineContext["getFlagSource"]` (#792). */
	getFlagSource?: (name: string, filePath?: string) => PiLensFlagSource;
	dbg: (msg: string) => void;
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
	biomeClient?: BiomeClient;
	ruffClient?: RuffClient;
	metricsClient?: MetricsClient;
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
	/** Internal test seam for making missing observation evidence reachable. */
	_opaqueCaptureOptions?: Pick<CaptureOptions, "forcedUnknownReason">;
	/** Internal: synthetic dispatch inherits the parent's read-guard evidence. */
	_readGuardAuthorship?: boolean;
}

function ensureToolResultClients(
	deps: ToolResultDeps,
): boolean | Promise<boolean> {
	if (deps.biomeClient && deps.ruffClient && deps.metricsClient) return true;
	const request = {
		reason: "tool-result-analysis",
		hook: "tool_result_edit" as const,
		timeoutMs: HOOK_WALL_BUDGET_MS.tool_result_edit,
		...(deps.signal === undefined ? {} : { signal: deps.signal }),
	};
	return bounded(requestBootstrapClients(request), {
		ms: HOOK_WALL_BUDGET_MS.tool_result_edit,
		signal: deps.signal,
		hook: "tool_result_edit",
		label: "tool-result-bootstrap-demand",
	}).then((clients) => {
		if (!clients) return false;
		deps.biomeClient = clients.biomeClient;
		deps.ruffClient = clients.ruffClient;
		deps.metricsClient = clients.metricsClient;
		return true;
	});
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

/**
 * Register one in-flight pipeline and hand back the inner map it landed in.
 *
 * Paired with {@link releaseInFlightPipeline}; split out of
 * `dispatchPipelineAnalysis` so registration and deregistration are one seam
 * with one owner (#2464 review round 3, F1) rather than two open-coded blocks
 * ~80 lines apart whose invariants only line up if a reader checks both.
 *
 * Exported for the isolation red in
 * `tests/clients/observed-mutation-integration.test.ts`: with
 * `claimPipelineDispatch` below now consulted by BOTH dispatch call sites, the
 * identity guard in the release has no reachable production trigger left, so
 * the only honest way to prove it is to drive the seam directly.
 */
export function registerInFlightPipeline(
	filePath: string,
	stateHash: string,
	pipeline: InFlightPipeline,
): Map<string, InFlightPipeline> {
	let filePipelines = inFlightPipelines.get(filePath);
	if (!filePipelines) {
		filePipelines = new Map<string, InFlightPipeline>();
		inFlightPipelines.set(filePath, filePipelines);
	}
	filePipelines.set(stateHash, pipeline);
	return filePipelines;
}

/**
 * Release one in-flight pipeline, pruning the per-file inner map once it is
 * empty so a file touched once this session doesn't leave a permanent empty
 * entry in the outer map.
 *
 * The IDENTITY check on the outer delete is load-bearing (#2464 review round 3,
 * F1). `registered` is a reference captured BEFORE the pipeline await. Deleting
 * by path alone assumes the outer entry still IS that map, and when it is not —
 * anything that replaced it while this pipeline ran — the delete evicts a LIVE,
 * unrelated pipeline's registration: its concurrent duplicates then stop
 * deduping and its `participantIds`/`participantTotal` under-count. Delete only
 * when the outer map still points at the very map this registration went into.
 */
export function releaseInFlightPipeline(
	filePath: string,
	stateHash: string,
	registered: Map<string, InFlightPipeline>,
): void {
	registered.delete(stateHash);
	if (registered.size === 0 && inFlightPipelines.get(filePath) === registered) {
		inFlightPipelines.delete(filePath);
	}
}

export type PipelineDispatchClaim =
	| { proceed: true }
	| {
			proceed: false;
			/**
			 * The live pipeline this call joined, when it deduped against one.
			 * `undefined` when the already-analysed latch was what stopped it —
			 * there is nothing still running to wait for.
			 */
			joined: Promise<unknown> | undefined;
	  };

/**
 * The two pre-conditions EVERY pipeline dispatch shares (#2464 review round 3,
 * F1): the in-flight dedup for a concurrent call on the same post-write state,
 * and the already-analysed latch for a sequential duplicate in the same turn.
 *
 * Both call sites of {@link dispatchPipelineAnalysis} consult this, so the
 * PRE-conditions are as by-construction as the post-conditions that helper
 * already owns. The observed-mutation path shipped without either check in
 * round 2: two concurrent observed `tool_result`s for one file+hash both
 * registered, the second overwrote the first's entry in the per-file map, and
 * the first's release then evicted the whole outer entry — taking a live,
 * unrelated classified pipeline's registration with it.
 *
 * ## Why this is SYNCHRONOUS and hands the join promise back
 *
 * Check-then-act here has to be atomic against the microtask queue.
 * `dispatchPipelineAnalysis` registers synchronously before its own first
 * await, so a caller that claims and then dispatches with no `await` in between
 * cannot be interleaved. An `async` pre-check would reintroduce exactly that
 * interleave — both racers see an empty registry, both resume, both dispatch —
 * so the join's `await` is deliberately left to the caller.
 *
 * ## Why this is NOT folded into `dispatchPipelineAnalysis`
 *
 * On the classified chain the latch check sits ABOVE `addModifiedRange` and
 * `recordProjectChange`. Moving it down into the helper would write
 * `turn-state.json` ranges and an attributed change-log receipt for a state
 * already analysed this turn — the duplicate-recording inversion #2464 exists
 * to remove.
 */
export function claimPipelineDispatch(args: {
	filePath: string;
	stateHash: string;
	turnIndex: number;
	participantId: string;
	dbg: (message: string) => void;
}): PipelineDispatchClaim {
	const { filePath, stateHash, turnIndex, participantId, dbg } = args;
	// Deduplicate concurrent calls for the same final file state (pi can fire one
	// tool_result per edit hunk). Do not dedupe by file alone: a distinct later
	// same-turn edit to this file must still be analyzed.
	const inFlight = inFlightPipelines.get(filePath)?.get(stateHash);
	if (inFlight) {
		dbg(`tool_result: skipping duplicate concurrent state for ${filePath}`);
		if (inFlight.participantIds.length < 100) {
			inFlight.participantIds.push(participantId);
		}
		inFlight.participantTotal += 1;
		return { proceed: false, joined: inFlight.promise };
	}

	// Deduplicate sequential duplicate events for the same post-write state in
	// the same turn while allowing later same-file edits whose content changed.
	const lastAnalyzed = lastAnalyzedStateByFile.get(filePath);
	if (
		lastAnalyzed?.turnIndex === turnIndex &&
		lastAnalyzed.stateHash === stateHash
	) {
		dbg(
			`tool_result: skipping already-analyzed file state this turn for ${filePath}`,
		);
		return { proceed: false, joined: undefined };
	}

	return { proceed: true };
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

function getRequestedEditCount(
	event: ToolResultEvent,
	kind: MutationKind,
): number {
	if (kind === "write") return 1;
	const edits = (event.input as { edits?: unknown[] } | undefined)?.edits;
	return Array.isArray(edits) && edits.length > 0 ? edits.length : 1;
}

function getRequestedEditIndexes(
	event: ToolResultEvent,
	kind: MutationKind,
): number[] {
	return boundedIndexesForCount(getRequestedEditCount(event, kind));
}

/**
 * Change-log attribution for one classified mutation (#2423).
 *
 * A third-party tool gets its OWN source (`agent-tool:<name>`) rather than
 * being folded into `agent-edit`: a report that attributes a change to "the
 * model's edit tool" must not silently absorb an extension's rewrite.
 */
function sourceForMutation(
	classification: MutatingToolClassification,
	details?: unknown,
): ProjectChangeSource {
	if (
		(details as { piLensPartialApply?: unknown } | undefined)
			?.piLensPartialApply
	) {
		return "partial-apply";
	}
	if (
		classification.provenance === "builtin" ||
		classification.provenance === "bash-derived"
	) {
		return classification.kind === "write" ? "agent-write" : "agent-edit";
	}
	return `agent-tool:${classification.toolName}`;
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

/**
 * #2402 applied-edit records for a native edit tool, so an identical retry is
 * recognized as already-applied instead of escalating through the
 * oldText-not-found ladder. `input` carries the EXECUTED args (post-autopatch),
 * the same text the preflight resolves against.
 *
 * Extracted (#2449 review round 4, S4) because the observational-settle skip
 * path needs the IDENTICAL records: the mutation bridge does not write them, so
 * an early return that skipped this block left every retry of an observed
 * tool's edit looking unapplied. One body, two call sites — a second copy on the
 * skip path is the drift this repo keeps catching.
 */
function recordNativeAppliedPairs(args: {
	runtime: RuntimeCoordinator;
	input: unknown;
	kind: MutationKind;
	filePath: string;
	stateHash: string;
}): Array<{ oldText: string; newText: string | undefined }> {
	const pairs: Array<{ oldText: string; newText: string | undefined }> = [];
	if (args.kind !== "edit") return pairs;
	const appliedInput = args.input as {
		oldText?: string;
		newText?: string;
		edits?: Array<{ oldText?: string; newText?: string }>;
	};
	const record = (oldText?: string, newText?: string): void => {
		if (typeof oldText === "string" && oldText.length > 0) {
			args.runtime.partialApplyRecords.record(
				args.filePath,
				oldText,
				newText,
				args.stateHash,
			);
			pairs.push({ oldText, newText });
		}
	};
	if (Array.isArray(appliedInput.edits)) {
		for (const edit of appliedInput.edits) record(edit.oldText, edit.newText);
	} else {
		record(appliedInput.oldText, appliedInput.newText);
	}
	return pairs;
}

/**
 * Keep `cachedExports` in sync after each write/edit so the pre-write STOP check
 * does not fire on names that were removed from this file this session.
 *
 * Extracted for the same reason as {@link recordNativeAppliedPairs} (#2449
 * review round 4, S4): the mutation bridge does not touch this cache, so the
 * observational-settle skip path left it holding names an observed tool had
 * just deleted.
 */
function refreshCachedExports(
	runtime: RuntimeCoordinator,
	filePath: string,
): void {
	if (runtime.cachedExports.size === 0 || !nodeFs.existsSync(filePath)) return;
	const exportRe = new RegExp(
		"export\\s+(?:async\\s+)?(?:function|class|const|let|type|interface)\\s+(\\w+)",
		"g",
	);
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

/**
 * #2464: the pipeline's own lint/diagnostics dispatch, factored out of the
 * block below that ALSO writes `turn-state.json` modified ranges and the
 * attributed change-log receipt (`cacheManager.addModifiedRange` /
 * `recordProjectChange`). The classified chain in `handleToolResult` still
 * does both, in the same order as before this split — see the call site
 * right after `recordProjectChange` below, which is byte-identical to what
 * used to be inlined there.
 *
 * The observed-mutation early return (#2430/#2449 round 4, S4) is the SECOND
 * caller: the mutation bridge already recorded the turn-state range and the
 * change-log receipt for that edit, so it calls this helper for analysis
 * WITHOUT asking for the recording a second time — which a shared "run the
 * pipeline AND record" block could not express.
 */
async function dispatchPipelineAnalysis(args: {
	deps: ToolResultDeps;
	runtime: RuntimeCoordinator;
	filePath: string;
	dispatchCwd: string;
	turnStateCwd: string;
	autofixMode: "immediate" | "deferred";
	modifiedRanges: Array<{ start: number; end: number }> | undefined;
	writeIndex: number;
	initialStateHash: string;
	readGuardCorrelationId: string;
	requestedEditIndexes: number[];
	requestedEditTotal: number;
	isPartialApplyResult: boolean;
	participantIds: string[];
	participantTotal: number;
	toolResultStart: number;
	/**
	 * The #2402 applied-edit pairs this invocation recorded against
	 * `initialStateHash`. Re-stamped with the POST-pipeline hash below when
	 * pi-lens' own immediate format/autofix rewrote the bytes (#2464 review
	 * round 2, S1) — a call site cannot be trusted to remember to do it.
	 */
	nativeAppliedPairs: Array<{ oldText: string; newText: string | undefined }>;
	// The original bash result can reach this helper without authorship
	// evidence; synthetic write results deliberately set this true.
	allowReadGuardWrites: boolean;
}): Promise<
	| { crashed: false; result: PipelineResult }
	| {
			crashed: true;
			response: {
				content: Array<{ type: string; text?: string }>;
				isError: true;
			};
	  }
> {
	const {
		deps,
		runtime,
		filePath,
		dispatchCwd,
		turnStateCwd,
		autofixMode,
		modifiedRanges,
		writeIndex,
		initialStateHash,
		readGuardCorrelationId,
		requestedEditIndexes,
		requestedEditTotal,
		isPartialApplyResult,
		toolResultStart,
		nativeAppliedPairs,
		allowReadGuardWrites,
	} = args;
	const {
		event,
		getFlag,
		getFlagSource,
		dbg,
		biomeClient,
		ruffClient,
		metricsClient,
		resetLSPService,
	} = deps;

	const pipelinePromise = runPipeline(
		{
			signal: deps.signal,
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
			biomeClient: biomeClient!,
			ruffClient: ruffClient!,
			metricsClient: metricsClient!,
			getFormatService,
			fixedThisTurn: runtime.fixedThisTurn,
		},
	);
	const pipelineTelemetry: InFlightPipeline = {
		promise: pipelinePromise,
		participantIds: [...new Set(args.participantIds)].slice(0, 100),
		participantTotal: args.participantTotal,
	};
	// Synchronous, and the FIRST thing after `runPipeline` handed back its
	// promise: `claimPipelineDispatch` at each call site is only atomic because
	// nothing awaits between the claim and this registration.
	const registeredPipelines = registerInFlightPipeline(
		filePath,
		initialStateHash,
		pipelineTelemetry,
	);
	let result: PipelineResult;
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
			crashed: true,
			response: {
				content: notice
					? [...event.content, { type: "text", text: notice }]
					: event.content,
				isError: true,
			},
		};
	} finally {
		releaseInFlightPipeline(filePath, initialStateHash, registeredPipelines);
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

	// ── Post-pipeline post-conditions (#2464 review round 2, S1) ───────────────
	// These live INSIDE the helper rather than at its call sites so EVERY
	// provenance gets them by construction. The observed path used to discard
	// `result` entirely, so under `--immediate-format` the pipeline rewrote the
	// file and none of the three below ran: the next edit was then blocked with
	// a spurious `file_modified` (the read-guard staleness stamp was never
	// re-taken), an identical retry escalated through the oldText-not-found
	// ladder (the #2402 after-write hash was never stamped), and a duplicate
	// tool_result for the same bytes analysed the file a second time (the
	// already-analysed latch was never set).
	const finalStateHash = getFileStateHash(filePath);
	lastAnalyzedStateByFile.set(filePath, {
		turnIndex: runtime.turnIndex,
		stateHash: finalStateHash,
	});

	// #2402: pi-lens' own immediate format/autofix may have rewritten the file
	// after the native edit was recorded by the caller. Stamp the post-pipeline
	// state so an identical retry against the formatted bytes is still
	// recognized as already-applied. Only the pairs recorded this invocation are
	// stamped, and only when the pipeline actually changed the bytes.
	// `initialStateHash` IS the post-write hash at both call sites — the
	// classified chain passes `postWriteStateHash` verbatim, the observed path
	// passes the same pre-settle digest.
	if (finalStateHash !== initialStateHash) {
		for (const pair of nativeAppliedPairs) {
			runtime.partialApplyRecords.noteAfterWriteHash(
				filePath,
				pair.oldText,
				pair.newText,
				finalStateHash,
			);
		}
	}

	// The model's write/edit and pi-lens' own immediate format/autofix are now
	// reflected on disk. Refresh read-guard staleness stamps so a follow-up edit
	// is judged by read-range coverage, not by our own previous write.
	if (!getFlag("no-read-guard") && allowReadGuardWrites) {
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

	return { crashed: false, result };
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
		agentBehaviorRecord,
		formatBehaviorWarnings,
	} = deps;

	const rawFilePath = (event.input as { path?: string }).path;
	const workspaceRoot = runtime.projectRoot || process.cwd();
	let bashAuthorshipConfirmed =
		deps._readGuardAuthorship ?? event.toolName !== "bash";

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
		let recognizedWritten =
			event.isError !== true
				? recognized.filter(
						(wp) =>
							!isExternalOrVendorFile(wp, workspaceRoot) &&
							!isPathIgnoredByProject(wp, workspaceRoot, false),
					)
				: [];
		// Fence the mtime-based session-authored fallback before any async
		// observation. Only later content evidence may clear this fence.
		if (!getFlag("no-read-guard")) {
			for (const recognizedPath of recognizedWritten)
				deps.readGuard?.recordUnchanged?.(recognizedPath);
		}
		// #2000 phase 2: when the extractor recognizes NOTHING, the command is
		// opaque-candidate — recover its actual changed set by diffing the pre
		// snapshot taken at tool_call. Partial writes that landed before a
		// nonzero exit ARE attributed (the files changed and the agent authored
		// them) — a deliberate divergence from the isError filter above, which
		// exists for restore semantics where attribution would lie.
		let opaquePaths: string[] = [];
		let observedChangedKeys: Set<string> | undefined;
		let recognizedAuthored: string[] = [];
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
					observedChangedKeys = new Set(opaquePaths);
				} else if (recovery.verdict === "unknown") {
					// #2060: deliberately WIDER than the old `recognized.length > 0`
					// guard. A fully opaque command whose probe failed is the shape
					// whose coverage is least knowable, and it used to record
					// nothing at all.
					unknownReason = recovery.unknownReason;
				} else {
					// A clean git verdict is complete evidence that no path
					// changed; it is not missing evidence. Keep recognized writes
					// out of authorship because git found no changed bytes.
					observedChangedKeys = new Set();
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
					...deps._opaqueCaptureOptions,
				});
				if (outcome.snapshot && !outcome.unknownReason) {
					opaquePaths = diffFileContent(pending.stats, outcome.snapshot);
					observedChangedKeys = new Set(opaquePaths);
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
			if (observedChangedKeys) {
				recognizedAuthored = recognizedWritten.filter((file) =>
					observedChangedKeys!.has(normalizeMapKey(path.resolve(file))),
				);
				if (recognizedAuthored.length === 0) recognizedWritten = [];
			} else if (unknownReason) {
				recognizedAuthored = [];
				// The bounded opaque_mutation_coverage_unknown record below remains
				// the production proof that authorship evidence was unavailable.
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
				void resyncGitChangedFiles(opaquePaths).catch((err) => {
					dbg(`git-change LSP resync failed: ${err}`);
				});
			}
		}
		// wp iterates opaquePaths VERBATIM (already normalizeMapKey keys), so the
		// set must hold those exact strings - no re-resolution.
		const opaqueSet = new Set(opaquePaths);
		const written = [...recognizedWritten, ...opaquePaths];
		const recognizedAuthoredSet = new Set(recognizedAuthored);
		bashAuthorshipConfirmed =
			recognizedAuthored.length > 0 || opaquePaths.length > 0;
		for (const wp of written) {
			if (
				!getFlag("no-read-guard") &&
				(opaqueSet.has(wp) || recognizedAuthoredSet.has(wp))
			)
				deps.readGuard?.recordWritten(wp);
			else if (!getFlag("no-read-guard") && recognizedWritten.includes(wp))
				deps.readGuard?.recordUnchanged?.(wp);
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
				// #2423: pi-lens SYNTHESIZED this write from a bash command, so the
				// seam reports `provenance: "bash-derived"` and a consumer can tell
				// it apart from the host's own write tool.
				[PI_LENS_SYNTHETIC_MUTATION_FIELD]: "bash",
			};
			const syntheticResult = await handleToolResult({
				...deps,
				event: syntheticEvent,
				_bypassDebounce: true,
				_autofixMode: autofixMode,
				_attachmentBudget: syntheticAttachmentBudget,
				_mutationSourceOverride: isOpaque ? "opaque-script" : undefined,
				_readGuardAuthorship:
					opaqueSet.has(wp) || recognizedAuthoredSet.has(wp),
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
			const truncation = (
				event.details as {
					truncation?: {
						truncated?: boolean;
						totalLines?: number;
						outputLines?: number;
					};
				}
			)?.truncation;
			const parsedSpans = extractReadPathsFromCommand(command, workspaceRoot);
			let spans = parsedSpans;
			if (
				truncation?.truncated === true &&
				typeof truncation.outputLines === "number"
			) {
				if (parsedSpans.length === 1) {
					const span = parsedSpans[0];
					if (span) {
						// countFileLines intentionally preserves the split-based guard
						// convention, where a trailing newline contributes an empty final
						// element. The host's output line count does not include that
						// element, so remove it from the span basis before taking the tail.
						const hasTrailingNewline = nodeFs
							.readFileSync(span.filePath, "utf8")
							.endsWith("\n");
						const spanLineCount = hasTrailingNewline
							? Math.max(1, span.limit - 1)
							: span.limit;
						const shown = Math.min(truncation.outputLines, spanLineCount);
						spans =
							shown > 0
								? [
										{
											...span,
											offset: span.offset + spanLineCount - shown,
											limit: shown,
										},
									]
								: [];
					}
				} else if (parsedSpans.length > 1) {
					recordDegradationOnce({
						kind: "bash-view-clipped",
						subject: "multi-span",
						reason: "truncated bash view contained multiple spans",
					});
					spans = [];
				}
				if (
					parsedSpans.length === 1 &&
					spans.length === 1 &&
					(spans[0]?.offset !== parsedSpans[0]?.offset ||
						spans[0]?.limit !== parsedSpans[0]?.limit)
				) {
					recordDegradationOnce({
						kind: "bash-view-clipped",
						subject: parsedSpans[0]?.filePath ?? "unknown",
						reason: "truncated bash view narrowed a single span",
					});
				}
			}
			for (const span of spans) {
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

	// Native read results are the authoritative read boundary. The tool_call
	// input can request past EOF, and the host can cap bytes or lines before the
	// result reaches the model. Register only the delivered range (#2802).
	if (
		deps.readGuard &&
		event.toolName === "read" &&
		event.isError !== true &&
		filePath &&
		!getFlag("no-read-guard") &&
		!isExternalOrVendorFile(filePath, workspaceRoot)
	) {
		const deliveredFilePath =
			attribution?.resolvedPath && nodeFs.existsSync(attribution.resolvedPath)
				? attribution.resolvedPath
				: filePath;
		if (nodeFs.existsSync(deliveredFilePath)) {
			const nativeReadToolCallId = resolveToolCallCorrelationId(event);
			const input = event.input as { offset?: number; limit?: number };
			const requestedOffset = input.offset ?? 1;
			const requestedLimit = input.limit;
			const truncation = (
				event.details as
					| {
							truncation?: { outputLines?: number; truncated?: boolean };
					  }
					| undefined
			)?.truncation;
			const available = Math.max(
				0,
				countFileLines(deliveredFilePath) - requestedOffset + 1,
			);
			const deliveredLimit = Math.min(
				available,
				truncation?.outputLines ?? requestedLimit ?? available,
			);
			if (deliveredLimit > 0) {
				if (truncation?.truncated === true && deliveredLimit < available) {
					recordDegradationOnce({
						kind: "native-read-clipped",
						subject: deliveredFilePath,
						reason: "native read result was clipped before delivery",
					});
				}
				logReadGuardEvent({
					event: "read_pattern",
					sessionId: runtime.telemetrySessionId,
					filePath: deliveredFilePath,
					requestedOffset,
					requestedLimit: requestedLimit ?? deliveredLimit,
					effectiveOffset: requestedOffset,
					effectiveLimit: deliveredLimit,
					metadata: {
						totalLines: countFileLines(deliveredFilePath),
						isPartial: deliveredLimit < available,
						fileKind: detectFileKind(deliveredFilePath) ?? "unknown",
						fractionRead:
							available > 0
								? Math.round((deliveredLimit / available) * 100) / 100
								: 1,
						expandedByTs: false,
					},
				});
				const deliveredRecord = {
					filePath: deliveredFilePath,
					requestedOffset,
					requestedLimit: requestedLimit ?? deliveredLimit,
					effectiveOffset: requestedOffset,
					effectiveLimit: deliveredLimit,
					expandedByLsp: false,
					turnIndex: runtime.turnIndex,
					writeIndex: runtime.peekWriteIndex(),
					timestamp: Date.now(),
				};
				if (nativeReadToolCallId) {
					deps.readGuard.recordRead(deliveredRecord, {
						supersedes: { toolCallId: nativeReadToolCallId },
					});
				} else {
					deps.readGuard.recordRead(deliveredRecord);
				}
			}
		}
	}

	// #2423: THE inbound gate. Everything below this line is the mutation
	// bookkeeping chain — read-guard staleness stamp, turn state, change-log
	// receipt, deferred autofix and format. Before the seam this compared
	// `event.toolName` to two literals, so a host or extension edit tool under
	// any other name was dropped here with the path already resolved.
	// `recognizeOnly` (#2423 review round 1, finding F5): the tool_call side
	// already ran the adapters against the PRE-edit file and logged what they
	// resolved. Re-running them here logged a second `touched_lines_detected`
	// for every edit and an `edit_preflight_blocked` for edits that were never
	// blocked, and any anchor it re-resolved would be resolved against content
	// the edit has already rewritten. The seam carries the tool_call ranges
	// forward by `toolCallId` instead.
	const mutation = classifyMutatingTool(event, {
		filePath: filePath || undefined,
		sessionId: deps.sessionId,
		recognizeOnly: true,
	});
	// #2430: settle the observational baseline BEFORE the classification gate
	// returns. On the FIRST call of an unknown tool nothing below this line will
	// run — that is the bug — so the disk diff is the only thing that can put
	// the file in `turn-state.json`, and it replays through the mutation bridge
	// to get the identical bookkeeping a `write` gets.
	//
	// The PROBE is synchronous and is the first thing asked, so the
	// overwhelmingly common call — no baseline armed — pays one map lookup and
	// nothing else (#2449 round 2, F1).
	//
	// The SETTLE is async (#2449 round 3, T4: no synchronous filesystem work on
	// this path), so it yields. `handleToolResult` has no other `await` before
	// it registers with `debouncedPipelines`/`inFlightPipelines`, and
	// `tests/clients/runtime-tool-result-debounce.test.ts` asserts that a
	// racing second tool_result for the same path cannot miss the first's
	// entry — so everything the chain below derives from the file's POST-RESULT
	// bytes is read HERE, before the yield. Otherwise the racing call rewrites
	// the file while this one is awaiting and this one registers under the
	// OTHER call's state hash, collapsing two distinct pipelines into one.
	const observationPending =
		!getFlag("no-read-guard") &&
		hasPendingObservation(resolveToolCallCorrelationId(event));
	// #2464 review round 2 (S2): NOT gated on `mutation !== undefined` any more.
	// The observed path now dispatches on call ONE of an unknown tool too, and
	// that call is by definition unclassified — gating the pre-yield digest on a
	// classification that does not exist yet would have left exactly the racing
	// re-read this hoist exists to prevent.
	const preSettleStateHash =
		observationPending && filePath ? getFileStateHash(filePath) : undefined;
	let observedReplayed = 0;
	let observedChangedPaths: string[] = [];
	if (observationPending) {
		const observed = await settleObservedMutation({
			toolCallId: resolveToolCallCorrelationId(event),
			toolName: event.toolName,
			sessionGeneration: runtime.sessionGeneration,
			turnIndex: runtime.turnIndex,
			signal: getAmbientAbortSignal(),
			record: replayThroughMutationBridge,
			getStoredLineHashes: (candidate) =>
				storedLineHashesFor(deps.readGuard, candidate),
			isRecordable: (candidate) =>
				!isExternalOrVendorFile(candidate, workspaceRoot) &&
				!isPathIgnoredByProject(candidate, workspaceRoot, false),
			dbg,
		});
		observedReplayed = observed.replayed;
		observedChangedPaths = observed.changedPaths;
		if (observed.replayed > 0) {
			dbg(
				`tool_result: observed ${observed.replayed} mutation(s) from tool "${event.toolName}"`,
			);
		} else if (observed.reason) {
			dbg(
				`tool_result: observation for "${event.toolName}" did not settle: ${observed.reason}`,
			);
		}
	}
	// #2464 review round 2 (S5): ONE clock, started above BOTH exits, so
	// `edit_batch_summary.durationMs` and the `tool_result` latency row measure
	// the same span whichever provenance a tool takes. The observed path used to
	// start its clock at the dispatch call itself, so its durations were
	// pipeline-only and silently incomparable with the classified path's.
	// Deliberately below the settle: neither path should be charged for the
	// observational disk diff, which is arm-time work, not tool_result work.
	const toolResultStart = Date.now();

	// #2449 review round 3 (S2), narrowed in round 4 (S4). A tool learned from
	// ONE observation is classified by NAME from here on AND is still armed —
	// that second property is what makes a second observation, and therefore
	// persistence, reachable at all (round 2, F2). Both halves then recorded the
	// same physical edit: the settle above replayed it through the mutation
	// bridge with measured ranges, and the chain below recorded it AGAIN as a
	// whole-file change, so a three-edit session produced four change-log
	// receipts.
	//
	// The settle wins, deliberately. It ran the disk diff, so it knows which
	// LINES moved; the chain, reached through `recognizeOnly`, has no ranges for
	// an unknown tool and over-approximates to the file. Skipping the arm
	// instead would be the other way to fix this, and it is the wrong one — it
	// makes PERSIST_AFTER_OBSERVATIONS unreachable again.
	//
	// ## What this return skips, stated in full (round 4, S4; #2464)
	//
	// The first cut called this "skipping turn tracking" and returned. It skipped
	// considerably more than turn tracking, and THREE of those steps have no
	// counterpart in `recordMutationThroughSeam`, so nothing else ran them. Those
	// three run here, before the return:
	//
	//   - the #2402 applied-edit records — without them an identical retry of
	//     the observed tool's edit escalates through the oldText-not-found ladder
	//     instead of being recognized as already applied;
	//   - `recordMutationToolReceipt`, the write→edit sticky turn transition,
	//     which is pure ordering state the bridge never touches;
	//   - the `cachedExports` refresh — without it the pre-write STOP check keeps
	//     firing on names this very edit removed.
	//
	// What stays skipped is skipped because the BRIDGE already did it: the
	// read-guard staleness stamp, the `turn-state.json` modified ranges, the
	// attributed change-log receipt, and the deferred autofix/format pair —
	// `recordMutationThroughSeam` steps 1-4. #2464 pulled the pipeline's own
	// lint/diagnostics dispatch (`dispatchPipelineAnalysis`, defined above) out
	// of the block below that also writes those same turn-state ranges and the
	// change-log receipt, so it can be called HERE too — analysis without asking
	// for the recording a second time.
	//
	// ## Why this sits ABOVE the classification gates (#2464 review round 2, S2)
	//
	// It used to sit BELOW `mutation === undefined`, which meant CALL ONE of every
	// unknown tool — the call the observational net exists for — was recorded by
	// the bridge and then returned unanalysed: `runPipeline` was never reached, so
	// the file was fixed and formatted by the `agent_settled` drain but never
	// linted, and AC2 ("an observed mutation gets its pipeline analysis in the
	// same turn") was met on the second call only. `observedReplayed > 0` is the
	// whole condition now: the bridge recorded this edit, whoever the tool is.
	if (observedReplayed > 0) {
		// ## The `hostToolResultFailed` asymmetry, stated rather than hidden
		//
		// The classified chain returns below on `event.isError === true` with a
		// `commitStatus: "failed"` receipt; this block does not consult it, so an
		// unknown tool that reports failure and STILL moved bytes is recorded,
		// analysed, and receipted as `committed`. That is deliberate: the
		// observation is disk evidence, not a claim — the bytes changed whatever
		// the tool says about itself — and the classified early return is safe
		// only because a failed host edit did not write. Reading a third-party
		// tool's self-reported status as authority over what is on disk is the
		// exact gap the observational net exists to close.
		//
		// The gates below (`mutation === undefined` / `!filePath` /
		// `isExternalOrVendorFile`) are deliberately NOT consulted for the SKIP:
		// once the bridge has recorded the edit, re-running the classified chain
		// double-records it regardless of how the tool classifies. They are
		// consulted for what this block can still usefully DO.
		if (filePath && !isExternalOrVendorFile(filePath, workspaceRoot)) {
			// On call ONE the tool is not classified at all, so there is no
			// `mutation.kind` to read. The observation itself is the authority and
			// it only ever records "edit" (`settleObservedMutation` hard-codes
			// `kind: "edit"`, and #2430 tier 4 only ever classifies a learned tool
			// as "edit"), so the two agree wherever both exist.
			const observedKind: MutationKind = mutation?.kind ?? "edit";
			const observedStateHash =
				preSettleStateHash ?? getFileStateHash(filePath);
			const observedAppliedPairs = recordNativeAppliedPairs({
				runtime,
				input: event.input,
				kind: observedKind,
				filePath,
				stateHash: observedStateHash,
			});
			const receiptOutcome = (
				runtime as Partial<RuntimeCoordinator>
			).recordMutationToolReceipt?.call(runtime, filePath, observedKind);
			refreshCachedExports(runtime, filePath);
			// Same fallback formula the classified chain uses below, minus its
			// `_bypassDebounce` branch (#2464 review round 2, S3): that branch was
			// unreachable here. Both callers that set `_bypassDebounce` arrive with
			// no pending baseline — `scheduleDebounced`'s re-entry because THIS
			// call already consumed it at the settle above, and the bash-derived
			// synthetic write because `runtime-tool-call.ts` excludes `bash` from
			// arming outright (`toolName !== "bash"`). `observedKind` is always
			// "edit", so the un-receipted default is "deferred" either way.
			const observedAutofixMode: "immediate" | "deferred" =
				receiptOutcome?.autofixMode ??
				(observedKind === "edit" ? "deferred" : "immediate");
			// Analyse the file the observation actually RECORDED, not merely the
			// one the tool named: a directory-target tool names a path that is not
			// a file at all, and `runPipeline` on it is meaningless. `changedPaths`
			// is already filtered by the `isRecordable` predicate handed to the
			// settle above, so membership here also implies not-vendored and
			// not-gitignored — the same two gates the classified chain applies
			// before its own dispatch.
			if (
				observedChangedPaths.some((candidate) =>
					pathsEqual(candidate, filePath),
				)
			) {
				const observedClients = ensureToolResultClients(deps);
				if (
					observedClients !== true &&
					!(await bounded(Promise.resolve(observedClients), {
						ms: HOOK_WALL_BUDGET_MS.tool_result_edit,
						signal: deps.signal ?? undefined,
						hook: "tool_result_edit",
						label: "observed-tool-result-analysis",
					}))
				)
					return;
				const observedReadGuardCorrelationId = getReadGuardCorrelationId(event);
				// #2464 review round 3 (F1): the SAME two pre-conditions the
				// classified site consults, through the same shared claim. Round 2
				// dispatched here with neither, so two concurrent observed
				// `tool_result`s for one file+hash both registered and both ran
				// `runPipeline` — two autofix/format writers racing on one file — the
				// second overwrote the first's registry entry, and the first's
				// release then evicted the outer entry a live, unrelated classified
				// pipeline had since re-created under it.
				const observedClaim = claimPipelineDispatch({
					filePath,
					stateHash: observedStateHash,
					turnIndex: runtime.turnIndex,
					participantId: observedReadGuardCorrelationId,
					dbg,
				});
				if (!observedClaim.proceed) {
					if (observedClaim.joined) {
						await observedClaim.joined;
					}
					// Same terminal value as the block's own exit below: the bridge
					// already recorded this edit, and the analysis it would have asked
					// for is either running or already done.
					return syntheticWriteContent.length > 0
						? { content: [...event.content, ...syntheticWriteContent] }
						: undefined;
				}
				const observedDispatchOutcome = await dispatchPipelineAnalysis({
					deps,
					runtime,
					filePath,
					dispatchCwd: resolveLanguageRootForFile(filePath, workspaceRoot),
					turnStateCwd: path.resolve(workspaceRoot),
					autofixMode: observedAutofixMode,
					// #2423: no adapter/diff ranges exist for a "learned" (unnamed)
					// tool — the classified chain below hits the same gap for this
					// provenance and also leaves `modifiedRanges` undefined, so the
					// dispatch runs unscoped (whole-file) exactly as it would there.
					modifiedRanges: undefined,
					writeIndex: runtime.nextWriteIndex(),
					initialStateHash: observedStateHash,
					readGuardCorrelationId: observedReadGuardCorrelationId,
					requestedEditIndexes: getRequestedEditIndexes(event, observedKind),
					requestedEditTotal: getRequestedEditCount(event, observedKind),
					isPartialApplyResult:
						((event.details ?? {}) as Record<string, unknown>)
							.piLensPartialApply === true,
					participantIds: [observedReadGuardCorrelationId],
					participantTotal: 1,
					toolResultStart,
					nativeAppliedPairs: observedAppliedPairs,
					allowReadGuardWrites: true,
				});
				if (observedDispatchOutcome.crashed) {
					// #2464 review round 2, S6: parity with the classified chain — a
					// pipeline crash surfaces its notice to the agent instead of being
					// swallowed into a dbg line the model never sees. The recorded
					// edit stands either way; only the analysis was lost.
					dbg(
						`tool_result: pipeline analysis crashed for the observed mutation on ${filePath}; the recorded edit stands, analysis did not run this turn`,
					);
					return observedDispatchOutcome.response;
				}
				dbg(
					`tool_result: the observational settle already recorded ${observedReplayed} mutation(s) for "${event.toolName}"; kept the applied-edit records, mutation receipt, cachedExports refresh, and ran the pipeline dispatch (#2464); skipped the bridge-covered staleness stamp / turn-state ranges / change-log receipt / deferred autofix+format`,
				);
			} else {
				dbg(
					`tool_result: the observational settle recorded ${observedReplayed} mutation(s) for "${event.toolName}", none of them ${filePath} — nothing to analyse under the named path`,
				);
			}
		}
		return syntheticWriteContent.length > 0
			? { content: [...event.content, ...syntheticWriteContent] }
			: undefined;
	}
	if (mutation === undefined) {
		dbg(
			`tool_result: skipped turn tracking - toolName="${event.toolName}" is not a classified mutation`,
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
	// #2430: a classified mutation is accounted for by the chain below, so the
	// `agent_settled` sweep must re-baseline this file rather than report the
	// same bytes as unexplained drift.
	noteMutationHandled(filePath);
	const readGuardCorrelationId = getReadGuardCorrelationId(event);
	const resultDetails = (event.details ?? {}) as Record<string, unknown>;
	const isPartialApplyResult = resultDetails.piLensPartialApply === true;
	const requestedEditIndexes = getRequestedEditIndexes(event, mutation.kind);
	const requestedEditTotal = getRequestedEditCount(event, mutation.kind);
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

	// One post-result raw-byte hash, reused for the applied-edit records below and
	// for the pipeline dedup key (`initialStateHash`) further down (finding 3):
	// nothing between here and that point rewrites the file, so a second read
	// would only re-derive the same digest.
	//
	// `preSettleStateHash` is that same digest taken BEFORE the observational
	// settle's yield, on the only path that has one (#2449 round 3, T4). Reusing
	// it is not an optimization: re-reading here would read whatever a racing
	// tool_result wrote while this call was awaiting.
	const postWriteStateHash = preSettleStateHash ?? getFileStateHash(filePath);

	// #2402: a fully-applied native edit is also an applied record, so an
	// identical retry is recognized as already-applied instead of escalating
	// through the oldText-not-found ladder. `event.input` carries the EXECUTED
	// args (post-autopatch), the same text the preflight resolves against.
	const nativeAppliedPairs = recordNativeAppliedPairs({
		runtime,
		input: event.input,
		kind: mutation.kind,
		filePath,
		stateHash: postWriteStateHash,
	});

	// Must happen before debounce admission: latestDeps intentionally retains only
	// the latest event, but write -> edit is a sticky turn transition.
	const receipt = (runtime as Partial<RuntimeCoordinator>)
		.recordMutationToolReceipt;
	const autofixMode = deps._bypassDebounce
		? (deps._autofixMode ??
			(mutation.kind === "edit" ? "deferred" : "immediate"))
		: receipt
			? receipt.call(runtime, filePath, mutation.kind).autofixMode
			: mutation.kind === "edit"
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
	if (bashAuthorshipConfirmed) deps.readGuard?.recordWritten(filePath);

	// Keep cachedExports in sync after each write/edit so the pre-write STOP
	// check doesn't fire on names that were removed from this file this session.
	refreshCachedExports(runtime, filePath);

	// Reuse the hash taken right after the write landed (finding 3): the file is
	// unchanged between that read and here, so this is byte-identical.
	const initialStateHash = postWriteStateHash;

	// #2464 review round 3 (F1): the in-flight dedup and the already-analysed
	// latch moved into `claimPipelineDispatch`, shared verbatim with the observed
	// call site, which shipped round 2 with NEITHER check. The position is
	// unchanged — still ABOVE `addModifiedRange`/`recordProjectChange`, so a
	// duplicate state still writes no turn-state range and no change-log
	// receipt. Nothing may await between this claim and the dispatch below: the
	// claim is only atomic because `dispatchPipelineAnalysis` registers before
	// its own first await.
	const classifiedClaim = claimPipelineDispatch({
		filePath,
		stateHash: initialStateHash,
		turnIndex: runtime.turnIndex,
		participantId: readGuardCorrelationId,
		dbg,
	});
	if (!classifiedClaim.proceed) {
		if (classifiedClaim.joined) {
			await classifiedClaim.joined;
		}
		return;
	}

	const sessionFileTime = createFileTime("default");
	// tool_result is emitted after write/edit has already been applied.
	// Asserting pre-write stamps here produces false positives on rapid edits.
	sessionFileTime.read(filePath);
	if (!getFlag("no-read-guard") && bashAuthorshipConfirmed) {
		const readGuard = (
			runtime as {
				readGuard?: { recordWritten?: (writtenPath: string) => void };
			}
		).readGuard;
		readGuard?.recordWritten?.(filePath);
	}

	// `toolResultStart` is hoisted above both provenance exits (#2464 review
	// round 2, S5) so the two paths' durations are comparable — see its
	// declaration right after the observational settle.
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
	// #2423: ranges a shape adapter resolved from the tool's own input. Only a
	// classified non-native edit shape sets these — a plain host `edit` carries
	// its ranges in `details.diff` and is handled by the branch below.
	const adapterRanges: Array<{ start: number; end: number }> | undefined =
		mutation.editRanges && mutation.editRanges.length > 0
			? mutation.editRanges.map(([start, end]) => ({ start, end }))
			: mutation.touchedLines
				? [{ start: mutation.touchedLines[0], end: mutation.touchedLines[1] }]
				: undefined;
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
		if (mutation.kind === "edit" && details?.diff) {
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
		} else if (
			mutation.kind === "edit" &&
			adapterRanges &&
			nodeFs.existsSync(filePath)
		) {
			// #2423: a third-party edit tool ships no host `details.diff`, so the
			// diff branch above never fires and the file used to leave `files: {}`
			// empty in turn-state.json. The shape adapter already resolved which
			// lines the call touched — use those.
			const content = nodeFs.readFileSync(filePath, "utf-8");
			const importsChanged = /^import\s/m.test(content);
			modifiedRanges = adapterRanges;
			for (const range of adapterRanges) {
				cacheManager.addModifiedRange(
					filePath,
					range,
					importsChanged,
					turnStateCwd,
					runtime.telemetrySessionId,
				);
			}
		} else if (
			mutation.kind === "edit" &&
			mutation.provenance === "declared" &&
			nodeFs.existsSync(filePath)
		) {
			// #2423 review round 1 (F1): a third-party edit whose anchors did not
			// resolve — a stale anchor, or the read-guard preflight never ran to
			// resolve them — still CHANGED the file. Recording the whole file is a
			// deliberate superset: turn state exists to say "this file changed,
			// format and attribute it", and an empty `files` map is the exact
			// symptom the issue reports. A host `edit` keeps its old behavior,
			// because its ranges come from `details.diff` above.
			const content = nodeFs.readFileSync(filePath, "utf-8");
			const lineCount = content.split("\n").length;
			const importsChanged = /^import\s/m.test(content);
			modifiedRanges = [{ start: 1, end: lineCount }];
			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: lineCount },
				importsChanged,
				turnStateCwd,
				runtime.telemetrySessionId,
			);
		} else if (mutation.kind === "write" && nodeFs.existsSync(filePath)) {
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
			sourceForMutation(mutation, event.details),
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

	// #2464: the pipeline dispatch itself now lives in `dispatchPipelineAnalysis`
	// (defined above `handleToolResult`), shared with the observed-mutation
	// early return. This call site is otherwise unchanged — same arguments, same
	// crash-then-return / success-then-continue shape as before the split.
	const classifiedClients = ensureToolResultClients(deps);
	if (
		classifiedClients !== true &&
		!(await bounded(Promise.resolve(classifiedClients), {
			ms: HOOK_WALL_BUDGET_MS.tool_result_edit,
			signal: deps.signal,
			hook: "tool_result_edit",
			label: "classified-tool-result-analysis",
		}))
	)
		return;
	const dispatchOutcome = await bounded(
		dispatchPipelineAnalysis({
			deps,
			runtime,
			filePath,
			dispatchCwd,
			turnStateCwd,
			autofixMode,
			modifiedRanges,
			writeIndex,
			initialStateHash,
			readGuardCorrelationId,
			requestedEditIndexes,
			requestedEditTotal,
			isPartialApplyResult,
			participantIds,
			participantTotal,
			toolResultStart,
			nativeAppliedPairs,
			allowReadGuardWrites: bashAuthorshipConfirmed,
		}),
		{
			ms: HOOK_WALL_BUDGET_MS.tool_result_edit,
			signal: deps.signal || undefined,
			hook: "tool_result_edit",
			label: "pipeline-analysis",
		},
	);
	if (!dispatchOutcome) return;
	if (dispatchOutcome.crashed) {
		return dispatchOutcome.response;
	}
	// #2464 review round 2 (S1): the three post-pipeline post-conditions that
	// used to be written out here — the already-analysed latch, the #2402
	// after-write hash stamp, and the read-guard staleness re-stamp over
	// `result.changedFiles` — now live INSIDE `dispatchPipelineAnalysis`, so the
	// observed path gets them by construction rather than by a second author
	// remembering to copy them.
	const result = dispatchOutcome.result;

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
				// The v1 `pilens:format:queued` payload declares
				// `tool: "write" | "edit"`, so a third-party tool publishes under
				// its KIND rather than its name. Widening the published field is a
				// public-API decision tracked in #2421; until then the kind is the
				// honest projection.
				tool: mutation.kind,
				dbg,
				kinds: autofixMode === "deferred" ? ["autofix", "format"] : ["format"],
			});
		}
	}
	if (autofixNewlyQueued && !formatQueued) {
		publishFormatQueued({
			filePath,
			cwd: dispatchCwd,
			// Same #2421 projection as the queued-with-format publish above.
			tool: mutation.kind,
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
