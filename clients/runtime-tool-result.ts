import * as nodeFs from "node:fs";
import * as path from "node:path";
import {
	noteAuthoritativeContentAttachment,
	queueAgentAdvisory,
} from "./agent-nudge.js";
import {
	addHeadDiscards,
	captureFileStats,
	type CaptureOptions,
	diffFileContent,
	getOpaqueBaselineStore,
	headRecordKey,
	isGitWorktree,
	listGitHeadDelta,
	observeGitHead,
	opaqueBaselineSlot,
	opaquePrescanRoot,
	readGitHead,
	readSameHeadDiscards,
	recordOpaqueCaptureRefused,
	recoverOpaqueChangesViaGit,
	resolveOpaqueRecoveryRoots,
	serializeHeadLook,
	shouldRunOpaqueRecovery,
	takeHeadDiscards,
} from "./opaque-mutation-scan.js";
import {
	isUnderDir,
	normalizeMapKey,
	realpathOrResolve,
	resolveToolCallFilePath,
} from "./path-utils.js";
import { detectFileKind } from "./file-kinds.js";
import { isSessionBookkeepingRoot } from "./analysis-root.js";
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
import { publishFormatQueued } from "./format-events-publish.js";
import {
	invalidateProjectIgnoreMatcherForPath,
	isPiLensInternalPath,
	isPathIgnoredByProject,
	isRecordableProjectPath,
} from "./file-utils.js";
import { invalidateFormatterCacheForPath } from "./formatters.js";
import { judgeConfirmedDelete } from "./confirmed-delete.js";
import {
	deliveredLineEvidence,
	type ReadGuard,
	scanFileLines,
} from "./read-guard.js";
import {
	expectationFromToolInput,
	noteAgentCallEnd,
	noteAgentMutation,
} from "./fix-run-restore.js";
import { getFormatService } from "./format-service.js";
import {
	isExternalOrVendorFile,
	isVendorPath,
	isOutsideProjectRoot,
	normalizeEphemeralMapKey,
	pathsEqual,
} from "./path-utils.js";
import { PathKeyedMap } from "./path-keyed-map.js";
import { resolveLanguageRootForFile } from "./language-profile.js";
import { logLatency } from "./latency-logger.js";
import {
	classifyMutatingTool,
	isBashDerivedReplay,
	readToolResultPathField,
	PI_LENS_SYNTHETIC_MUTATION_FIELD,
	type MutatingToolClassification,
	type MutationKind,
} from "./mutating-tool.js";
import {
	hasPendingObservation,
	noteMutationHandled,
	pendingObservationPaths,
	settleObservedMutation,
} from "./observed-mutation.js";
import {
	replayThroughMutationBridge,
	storedLineHashesFor,
} from "./observed-mutation-sources.js";
import { getAmbientAbortSignal } from "./safe-spawn.js";
import {
	resolveReadEvidenceCorrelationId,
	resolveToolCallCorrelationId,
} from "./tool-event.js";
import {
	boundedEditIndexes,
	boundedIndexesForCount,
	createReadGuardEditBatchSummary,
	formatBoundedEditIndexes,
	getReadGuardCorrelationId,
	logReadGuardEvent,
} from "./read-guard-logger.js";
import { formatAlreadyAppliedNotes } from "./read-guard-tool-lines.js";
import type { PartialApplyPending } from "./partial-edit-apply.js";
import type { PiLensFlagSource } from "./lens-config.js";
import type { EditToolDetails } from "@earendil-works/pi-coding-agent";
import type { LSPShutdownOptions } from "./lsp/client.js";
import {
	notifyExternalFileChange,
	peekLSPService,
} from "./lsp/capabilities.js";
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
import type {
	ReadWidening,
	RuntimeCoordinator,
} from "./runtime-coordinator.js";
import { EXPANSION_LIMIT_LINES } from "./read-expansion.js";
import { resyncGitGuardAfterRetire, syncGitGuardRecord } from "./git-guard.js";
import { isCrossFileBlocker } from "./inline-blocker-fields.js";
import { writeOrderToken } from "./write-ordering-guard.js";
import { hashFileBytes } from "./content-stamp.js";
import { scheduleWordIndexPersist } from "./word-index.js";
import { RUNTIME_CONFIG } from "./runtime-config.js";
import { getActiveSessionId } from "./session-lifecycle.js";
import {
	type LineageHandle,
	recordDroppedRead,
	sessionFencedFixedThisTurn,
} from "./session-scope.js";
import { requestBootstrapClients } from "./bootstrap.js";
import { bounded } from "./deadline-utils.js";
import type { DiskChangeRuntime } from "./disk-changes.js";
import {
	type ChunkableDiskChangeInput,
	DISK_CHANGE_MAX_RECORDED_PATHS,
	publishDiskChangeChunked,
} from "./disk-changes.js";
import {
	BASH_RECOVERY_DRIFT_SOURCE,
	BASH_WRITE_SOURCE,
	ensureDiskChangeSubscribers,
	readHeldDocumentsAnswer,
	SAME_HEAD_DISCARD_SOURCE,
} from "./disk-change-subscribers.js";
import {
	lookForOutOfBandChanges,
	oweDeclarationWalk,
} from "./out-of-band-changes.js";
import { HOOK_WALL_BUDGET_MS } from "./hook-budgets.js";
import {
	incrementDegradationCount,
	recordDegradationOnce,
} from "./degradation-ledger.js";
import {
	canWriteAnalysisRoot,
	classifyAnalysisRoot,
	resolveAnalysisRoot,
	type AnalysisRootMode,
} from "./analysis-root.js";

const AUTHORITATIVE_CONTENT_MAX_BYTES = RUNTIME_CONFIG.pipeline.lspMaxFileBytes;

// Keep same-turn analysis below the observed-directory capture bound so one
// opaque codemod cannot monopolize the hook or analyzer fleet.
const OBSERVED_DISPATCH_MAX_PATHS = 32;

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
 * #4532: client roots one bash `tool_result` looks at for an install, besides
 * the session's own root. A process serving more roots than this looks at the
 * first ones and records the cap (a bound that is not disclosed is a silenced
 * answer). Four covers the shapes the issue measured: a main checkout, a linked
 * worktree, an adopted sibling root, and one spare.
 */
const CLIENT_ROOT_LOOK_CAP = 4;

/**
 * #4532: the live primary client roots the install look has NOT already
 * covered — everything except the session's own root, which the head look at
 * `sessionRoot` just looked at. Read-only: `peekLSPService` spawns nothing, and
 * a service without the accessor answers no extra roots (today's behaviour).
 * Roots are de-duplicated by path key, and the cap is enforced here with one
 * bounded record per session so a many-root process is never silently unbounded.
 */
function liveClientRootsApartFrom(
	sessionRoot: string,
): Array<{ root: string; spawnedAt: number }> {
	const service = peekLSPService();
	const roots = service?.livePrimaryClientRoots?.() ?? [];
	if (roots.length === 0) return [];
	const sessionKey = normalizeMapKey(sessionRoot);
	const seen = new Set<string>([sessionKey]);
	const out: Array<{ root: string; spawnedAt: number }> = [];
	for (const entry of roots) {
		const key = normalizeMapKey(entry.root);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(entry);
	}
	if (out.length > CLIENT_ROOT_LOOK_CAP) {
		recordDegradationOnce({
			kind: "lsp-client-root-look-capped",
			subject: "cap",
			reason: `${out.length} live primary client root(s) outside the session root; the first ${CLIENT_ROOT_LOOK_CAP} got the install look, so an install in the rest is not seen until a tool call names one of their files`,
		});
		return out.slice(0, CLIENT_ROOT_LOOK_CAP);
	}
	return out;
}

/**
 * #4493: when HEAD moved since this session last looked, resync the held
 * documents in `git diff <old> <new>`.
 *
 * A clean-tree move (checkout, reset --hard, a completed rebase or
 * cherry-pick, or the same outside pi) leaves `git status` empty, so opaque
 * recovery finds nothing and the server kept the pre-move bytes. The delta is
 * incoming content, not the agent's: it reaches the LSP resync only, never
 * mutation bookkeeping, authorship or dispatch. One `opaque_mutation_head_moved`
 * row per move, none when HEAD did not move.
 *
 * The returned promise settles once the PRIMARY servers hold the new bytes;
 * the auxiliaries catch up after it (see {@link lookAtHead}).
 *
 * #4476: the same look first checks the root for a dependency install or a
 * declaration file changed outside pi-lens (`out-of-band-changes.ts`), in a
 * git checkout or not, so a restart lands before the resync and both before
 * the next check.
 */
export function resyncHeadMove(args: HeadLook): Promise<void> {
	// #4612 r4: this call's discard set is handed to the look key BEFORE the
	// join, because a look that arrives while another of its key is in flight
	// never runs its own closure (`serializeHeadLook` coalesces it into one
	// trailing pass of the FIRST caller's closure, which captured that caller's
	// `discarded`). Synchronous, so a joining caller's paths are in the
	// accumulator before any drain that could owe them.
	addHeadDiscards(args.key, args.discarded);
	// #4532 gap 6: the same holds for this call's declaration walk. A bash
	// result that joins a tool_call look runs the tool_call's closure, whose
	// out-of-band look would not walk; the demand is owed to the root first, in
	// the same synchronous step, and the out-of-band pass that runs next takes it.
	oweDeclarationWalk(args.root, args.trigger);
	return serializeHeadLook(args.key, async () => {
		try {
			await lookForOutOfBandChanges(args.root, args.trigger, args.runtime);
		} finally {
			await lookAtHead(args);
		}
	});
}

interface HeadLook {
	root: string;
	key: string;
	trigger: "tool_call" | "tool_result";
	label: string;
	/**
	 * Paths a same-HEAD discard reverted in this call (#4502): the working-tree
	 * paths that were dirty before the command and clean after it. A discard
	 * (`git stash`, `git checkout .`, `git restore`) moves no HEAD and leaves no
	 * dirty set, so neither the delta nor the dirty status names these files;
	 * the bash `tool_result` reads them from the call's own baseline and hands
	 * them to this look, which publishes them with the move's delta.
	 *
	 * {@link resyncHeadMove} adds the set to the look key before it joins, so a
	 * look that only JOINED another flight's still publishes its own set (#4612
	 * r4: the closure that runs is the first caller's, and it captured the first
	 * caller's array).
	 */
	discarded?: readonly string[];
	/**
	 * The bulk mutation seam the out-of-band look's publish allocates the
	 * existing project sequence through (#4535). Optional: a look driven
	 * without a runtime still publishes, it just allocates no sequence.
	 */
	runtime?: DiskChangeRuntime;
}

/**
 * One look, the only one of its key in flight. A look that joined a flight is
 * answered by the flight's trailing look, which carries the first caller's
 * `trigger` and `label` in its row.
 *
 * Two phases (review r1 F1). Inside the look, the changed held documents go to
 * the primary servers only: that is the view the next read or edit's dispatch
 * reads, and primaries are not paced. After the look, detached, the drift
 * resync sends them to every holding server (the paced auxiliaries), adds held
 * importers and stamps the drift records; its end writes the row. The hooks and
 * every joined look wait for the first phase only, so an auxiliary's pacing
 * barrier no longer holds back the primary or the next tool call.
 *
 * #4535 slice 2: both phases are the disk-change publisher's LSP consumer now.
 * The look publishes the delta and reads the two answers back out of the
 * publish, so it names no service and no resync helper.
 *
 * #4535 slice 2 round 3: the publish is chunked at
 * `DISK_CHANGE_MAX_RECORDED_PATHS`, so an over-cap delta keeps its listing (a
 * single over-cap publish would be reported as `"unknown"`, and the consumer's
 * only honest reading of that is every held document: the awaited primary send
 * then leaves the change, probe E's `changedSent 0/65`), and a same-HEAD
 * discard's population rides the same look (a real discard is a `head-move`
 * publish whose HEAD never moved, so `sources` names it and `from`/`to` match).
 */
async function lookAtHead(args: HeadLook): Promise<void> {
	// The discards owed to this key: this pass's caller, plus any look that
	// joined the flight and could not run its own closure (#4612 r4). Drained
	// before the first await, so a joiner's add lands either before this drain
	// (taken here) or after it (taken by the trailing pass its join earned).
	const discarded = takeHeadDiscards(args.key);
	if (!(await isGitWorktree(args.root))) return;
	const head = await readGitHead(args.root);
	if (!head) return;
	const from = observeGitHead(args.key, head);
	const moved = from !== undefined;
	// A look that saw neither a move nor a discard has nothing to publish, and
	// its row would be a row about no event (the same early return the delta had).
	if (!moved && discarded.length === 0) return;
	const started = Date.now();
	const delta = moved ? await listGitHeadDelta(args.root, from, head) : [];
	const population: readonly string[] | "unknown" =
		delta === undefined ? "unknown" : [...new Set([...delta, ...discarded])];
	ensureDiskChangeSubscribers();
	const published = await publishDiskChangeChunked(
		{
			root: args.root,
			origin: "head-move",
			kind: "inferred",
			...(discarded.length > 0
				? { sources: ["head-move", SAME_HEAD_DISCARD_SOURCE] }
				: {}),
			// An unknown delta (git failed, or the listing was cut) is published
			// as unenumerable: the consumer then considers every held document,
			// because the stale views are the harm (shape 48, review r1 F6).
			paths: population,
		},
		// No runtime: a HEAD move's delta records no mutation (#4493). The
		// publisher's sequence is the consumer path's, and the delta read by
		// every consumer comes from the record, not from a bump.
	);
	const answers = published.map(({ results, failedSubscribers }) =>
		readHeldDocumentsAnswer(results, args.root, failedSubscribers),
	);
	const targets = answers.flatMap((answer) => answer.targets);
	const primary = answers.reduce((count, answer) => count + answer.primary, 0);
	const unheld = answers.reduce((count, answer) => count + answer.unheld, 0);
	const resyncFailed = answers.some((answer) => answer.failed);
	const drained = answers.every((answer) => answer.drained);
	const held = answers.reduce((count, answer) => count + answer.held, 0);
	const drifts = answers.flatMap((answer) =>
		answer.drift === undefined ? [] : [answer.drift],
	);
	const unlistable = published[0]?.change.paths === "unknown";
	const primaryMs = Date.now() - started;
	const report = (
		dispositions: ReadonlyMap<string, string> | undefined,
		failed: boolean,
	): void => {
		const outcomes = [...(dispositions?.values() ?? [])];
		const count = (kind: string) =>
			outcomes.filter((outcome) => outcome === kind).length;
		logLatency({
			type: "phase",
			phase: "opaque_mutation_head_moved",
			filePath: args.label.slice(0, 80),
			durationMs: Date.now() - started,
			result: failed
				? "resync-failed"
				: delta === undefined
					? "delta-unknown"
					: moved
						? `changed:${population.length}`
						: `discarded:${population.length}`,
			metadata: {
				trigger: args.trigger,
				from: from?.slice(0, 12) ?? "",
				to: head.slice(0, 12),
				changed: delta?.length ?? -1,
				// #4502: the paths a discard reverted, counted separately from the
				// move's delta so a discard is visible as one.
				discarded: discarded.length,
				held,
				// On an unlistable delta `held` counts every held document, not the
				// delta's held subset: the row says which population it counted so
				// the two are never read as the same number (F5).
				heldPopulation: unlistable ? "all-held" : "delta-held",
				current: held - targets.length,
				primary,
				// #4742: delta paths no client holds, sent as watched-files events.
				unheld,
				primaryMs,
				drained,
				resynced: count("resynced"),
				deferred: count("deferred"),
				failed: count("failed"),
			},
		});
	};
	if (targets.length === 0 || resyncFailed || drifts.length === 0) {
		report(undefined, resyncFailed);
		return;
	}
	void Promise.all(drifts).then(
		(maps) => report(mergeDispositions(maps), false),
		() => report(undefined, true),
	);
}

/**
 * #4535 slice 2: the recovered set's detached follow-up, one publish per
 * `DISK_CHANGE_MAX_RECORDED_PATHS` chunk of the recovered population. Slice 3's
 * settled sweep runs the same pass over its own origin ({@link
 * publishSettledSweepDrift}): the chunking, the per-chunk drift await and the
 * failure record are one chain, not one per detector.
 *
 * The spacing matters. A single publish over a longer population is reported
 * as `paths: "unknown"`, and the consumer's only honest reading of that is
 * "cannot be enumerated" — which for a detached drift pass means there is
 * nothing to resync. A code-mod over 65 files then resynced nothing at all
 * while a 64-file one resynced everything, and only a record about sequence
 * allocation said so (review round 2, F2). Chunking keeps every publish inside
 * the cap, so the cap never decides whether the pass runs.
 *
 * Each chunk's drift pass is awaited INSIDE this detached chain: the caller
 * `void`s the whole thing, so the hook still never waits, and the caller needs
 * exactly one rejection handler for the chain rather than one per chunk. The
 * chunk loop itself is `publishDiskChangeChunked`'s (#4612 r4): a second loop
 * over one cap was the same-shape sibling that helper exists to delete.
 *
 * A chunk whose drift pass rejects is recorded and the chain goes on to the
 * next chunk (#4612 r4, CodeRabbit): one failed pass must not leave every later
 * chunk's documents stale. The record is counted per root, so a service that
 * rejects every chunk costs one ledger entry whose count says how many, never
 * one row per chunk (review round 3, p3-3: the base branch dropped the whole
 * set with a `dbg` line, which for a detached chain is no record at all).
 */
async function publishDriftPass(
	root: string,
	paths: readonly string[],
	detector: Pick<ChunkableDiskChangeInput, "origin" | "sources" | "kind"> & {
		/** What the record calls this chunk's paths. */
		noun: string;
	},
): Promise<void> {
	const { noun, ...origin } = detector;
	await publishDiskChangeChunked(
		{ root, ...origin, paths },
		undefined,
		undefined,
		async ({ results, failedSubscribers }, { index, total }) => {
			try {
				await readHeldDocumentsAnswer(results, root, failedSubscribers).drift;
			} catch (cause) {
				// Every chunk before this one was full, so this chunk holds the cap
				// or the remainder, whichever is smaller.
				const dropped = Math.min(
					DISK_CHANGE_MAX_RECORDED_PATHS,
					paths.length - index * DISK_CHANGE_MAX_RECORDED_PATHS,
				);
				incrementDegradationCount({
					kind: "disk-change-recovered-drift-failed",
					subject: root,
					reason: `chunk ${index + 1} of ${total} rejected, so its ${dropped} ${noun} path(s) were never republished to a server: ${cause instanceof Error ? cause.message : String(cause)}`,
				});
			}
		},
	);
}

/**
 * The recovered set's drift pass. `inferred`, the conservative label: the
 * stat-diff strategy hashed the bytes, but the git strategy reported a status
 * pair and an mtime window without reading them. A marker that wants to confirm
 * "not reproduced" reads the bytes itself; the drift pass does exactly that.
 */
const RECOVERED_DRIFT_PASS = {
	origin: "bash-recovery",
	sources: [BASH_RECOVERY_DRIFT_SOURCE],
	kind: "inferred",
	noun: "recovered",
} as const;

/**
 * #4535 slice 3: the settled sweep's drift (D4). The sweep finds a tracked file
 * whose bytes moved with no tool call to explain it and replays it through the
 * mutation bridge, which allocates the project sequence per path. The bridge
 * never reached the language servers or the diagnostics cache, so the sweep now
 * publishes what it found. No runtime is passed: the bridge already allocated
 * the sequence, and a second allocation would bump every path twice.
 *
 * `observed` only when every path was hash-proven. An `unverifiable` file (its
 * stat moved, no hashed baseline could confirm a change) is published too,
 * labelled `inferred`: the LSP consumer compares the bytes itself and pays a
 * read, while the diagnostics cache refuses the path's entries without reading
 * one, so an unproven path costs one recompute; leaving it out serves stale views.
 *
 * The caller `void`s this: `agent_settled` never waits on a server, and the
 * chain records its own failures (see {@link publishDriftPass}).
 */
export function publishSettledSweepDrift(
	root: string,
	found: { drifted: readonly string[]; unverifiable: readonly string[] },
): Promise<void> {
	const paths = [...new Set([...found.drifted, ...found.unverifiable])];
	if (paths.length === 0) return Promise.resolve();
	ensureDiskChangeSubscribers();
	return publishDriftPass(root, paths, {
		origin: "settled-sweep",
		kind: found.unverifiable.length > 0 ? "inferred" : "observed",
		noun: "settled-sweep",
	});
}

/**
 * The drift answers of a chunked publish, as one map. Two chunks never report
 * the same target (the populations are disjoint), so a plain merge keeps every
 * disposition.
 */
function mergeDispositions(
	maps: ReadonlyArray<ReadonlyMap<string, string>>,
): ReadonlyMap<string, string> {
	const merged = new Map<string, string>();
	for (const map of maps)
		for (const [filePath, kind] of map) merged.set(filePath, kind);
	return merged;
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
	/** Parent codemode call whose transcript result contains nested calls. */
	parentToolCallId?: string | number;
	/** Host tool_result status; distinct from pi-lens PipelineResult.isError. */
	isError?: boolean;
	input: unknown;
	details?: unknown;
	content: Array<{ type: string; text?: string }>;
	structuredContent?: unknown;
	/** Internal bash-replay marker, set below rather than by the host. */
	[PI_LENS_SYNTHETIC_MUTATION_FIELD]?: unknown;
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
	/** Role of the activation that owns this write. */
	sessionRole?: "primary" | "secondary";
	/**
	 * #5108: the lines a run without authorship ended with for blockers it
	 * withheld (`PipelineResult.withheldBlockerLine`), pushed as each dispatch
	 * of this tool result finishes. The caller owns the array and reads it after
	 * the handler settles: `index.ts`' tool_result bound abandons a slow handler
	 * without cancelling it, and the tool result it then returns is never shown,
	 * so these lines are the only copy of the disclosure the agent can still be
	 * given. Absent when the caller has no such bound.
	 */
	withheldNotices?: string[];
	/**
	 * #5108 F1: the session an agent advisory from this tool result is for,
	 * captured by the caller at handler entry. The coordinator's own scope
	 * (`writeSession`) is the primary's, while a concurrent secondary's
	 * `context` drains its own member scope, so the caller resolves it the way
	 * that drain does. Guarded writes keep `writeSession`. Absent: `writeSession`.
	 */
	advisoryScope?: LineageHandle;
	/**
	 * The host ctx's `cwd` for THIS tool_result — the same per-session field the
	 * `tool_call` hook reads. The opaque prescan resolves its root through
	 * `opaquePrescanRoot(deps.cwd, …)` (#4504): a session whose cwd is not the
	 * coordinator's `projectRoot` (a concurrent secondary in a linked worktree,
	 * #473/#2129) otherwise wrote its baseline under one root and looked it up
	 * under another. Absent means the host offered none, and the prescan falls
	 * back to the same `projectRoot` the `tool_call` side falls back to.
	 */
	cwd?: string;
	/**
	 * Internal: set when the debounce timer fires to skip re-scheduling.
	 * Do not pass from external callers.
	 */
	_bypassDebounce?: boolean;
	/** #2000: overrides the change-log source for this synthetic dispatch. */
	_mutationSourceOverride?: ProjectChangeSource;
	/** Internal (#5120): this call's partial apply, taken by the wrapper. */
	_partialApply?: PartialApplyPending;
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
	/** Internal: synthetic dispatch inherits the parent's ownership decision. */
	_allowAutonomousWriters?: boolean;
	/** Internal (#3568): synthetic dispatch inherits the parent's session. */
	_sessionGeneration?: LineageHandle;
	/** Internal (#3525): the debounce re-entry keeps its call's stamp decision. */
	_ownWriteStamp?: OwnWriteStamp;
	/**
	 * Internal (#4577): this event's path is ALREADY the file's identity — a
	 * bash-derived or opaque-recovered absolute path read back from disk — so
	 * it must not go through the host-tool resolver again. The resolver applies
	 * host-argument rules (unicode-space fold, `@` strip, the variant ladder) to
	 * a spelling the model typed; re-running a name that came FROM the
	 * filesystem rewrites its bytes (`a\u202Fb.ts` folded to `a b.ts`) and
	 * dispatches a path that does not exist. The recovery caller knows the
	 * provenance, so it states it here instead of the handler re-detecting it.
	 */
	_pathAlreadyResolved?: boolean;
	/**
	 * Internal (#4713 F2): the checkout a synthetic bash-write dispatch belongs
	 * to. The ignore gate asks THAT checkout's rules, not the session root's: a
	 * linked worktree nested inside the session root is admitted by its own
	 * checkout, while the parent's rule for the directory it sits in says
	 * nothing about the nested tree's files. Absent means the session root.
	 */
	_ownerRoot?: string;
}

/** How the agent's own write/edit moves the read guard (#3524, #3525). */
type OwnWriteStamp = {
	stampFileTime: boolean;
	writtenContent?: string;
	authoredRanges?: Array<[number, number]>;
	authorship?: "partial" | "whole-file" | "unknown";
	/** The write's transcript entry: its authorship survives a move to a branch that shows it (#3603). */
	toolCallId?: string;
	/** sha256 of the bytes this handler already read after the write (#2499). */
	contentHash?: string;
};

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
	/** The analysis ran with authorship (autonomous writers allowed). */
	authored: boolean;
}>(normalizeEphemeralMapKey);

/**
 * The in-flight registry's inner key: one run per content hash and authority
 * (#4137). An authored claim must not join a run without authorship, and two
 * runs of one state must not share an entry (its release would evict the
 * other's registration, #2464).
 */
function inFlightKey(stateHash: string, authored: boolean): string {
	return authored ? stateHash : `${stateHash}#unauthored`;
}

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
 * Kept private because both dispatch call sites now use the shared claim before
 * registration; publishing this seam without the claim obligation would make
 * the identity guard's precondition easy to violate again.
 */
function registerInFlightPipeline(
	filePath: string,
	registryKey: string,
	pipeline: InFlightPipeline,
): Map<string, InFlightPipeline> {
	let filePipelines = inFlightPipelines.get(filePath);
	if (!filePipelines) {
		filePipelines = new Map<string, InFlightPipeline>();
		inFlightPipelines.set(filePath, filePipelines);
	}
	filePipelines.set(registryKey, pipeline);
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
function releaseInFlightPipeline(
	filePath: string,
	registryKey: string,
	registered: Map<string, InFlightPipeline>,
): void {
	registered.delete(registryKey);
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
 *
 * ## Why authority ranks the dedupe (#4137)
 *
 * `authored` is the `allowAutonomousWriters` the caller dispatches with. An
 * analysis with authorship satisfies every claim on its state. One without it
 * (an opaque recovery) satisfies only another claim without it: it withholds
 * the blocker channel (#3226), so an authored claim skipped there would lose
 * the blockers of a write the agent authored. A parallel bash call's recovery
 * window holds its siblings' writes, so that opaque claim often lands first.
 *
 * The rank saves a duplicate run; it does not guard the inline blocker record.
 * `lastAnalyzedStateByFile` is cleared at every session's turn start (#3613),
 * so an unauthored run of authored bytes can still proceed, and
 * `clearInlineBlockers` refuses its clear of a record about those bytes
 * (#4137 round 3).
 */
function claimPipelineDispatch(args: {
	filePath: string;
	stateHash: string;
	turnIndex: number;
	authored: boolean;
	participantId: string;
	dbg: (message: string) => void;
}): PipelineDispatchClaim {
	const { filePath, stateHash, turnIndex, authored, participantId, dbg } = args;
	// Deduplicate concurrent calls for the same final file state (pi can fire one
	// tool_result per edit hunk). Do not dedupe by file alone: a distinct later
	// same-turn edit to this file must still be analyzed.
	const filePipelines = inFlightPipelines.get(filePath);
	const inFlight =
		filePipelines?.get(inFlightKey(stateHash, true)) ??
		(authored ? undefined : filePipelines?.get(inFlightKey(stateHash, false)));
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
		lastAnalyzed.stateHash === stateHash &&
		(lastAnalyzed.authored || !authored)
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
	structuredContent?: unknown;
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

/**
 * #1649: whether the file's last byte is `\n`, read alone (not the whole file),
 * so a clipped bash view of a large file pays one byte for it. A file that
 * cannot be read throws, as the whole-file read it replaced did.
 */
function lastByteIsNewline(filePath: string): boolean {
	const fd = nodeFs.openSync(filePath, "r");
	try {
		const size = nodeFs.fstatSync(fd).size;
		// An empty file reads at position -1, the current one, and gets 0 bytes.
		const last = Buffer.alloc(1);
		return nodeFs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] === 0x0a;
	} finally {
		nodeFs.closeSync(fd);
	}
}

function getFileStateHash(filePath: string): string {
	try {
		return hashFileBytes(filePath);
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
): ProjectChangeSource {
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

export function recordProjectChange(args: {
	runtime: RuntimeCoordinator;
	cwd: string;
	filePath: string;
	source: ProjectChangeSource;
	changedRange?: ProjectChangeRange;
	dbg: (msg: string) => void;
	analysisRootMode: AnalysisRootMode;
	/** #4943: the writing session, which the change-log row names. */
	sessionId?: string | undefined;
}): void {
	if (!canWriteAnalysisRoot(args.analysisRootMode)) return;
	// One mutation seam (#2000 phase 1): bump + receipt + change-log live in
	// RuntimeCoordinator.recordProjectMutation; this wrapper only carries the
	// legacy dbg shape.
	(args.runtime as Partial<RuntimeCoordinator>).recordProjectMutation?.({
		filePath: args.filePath,
		source: args.source,
		cwd: args.cwd,
		changedRange: args.changedRange,
		sessionId: args.sessionId,
		onAppendError: (err) =>
			args.dbg(`project change log append failed for ${args.filePath}: ${err}`),
	});
}

export function recordTurnSummary(args: {
	runtime: RuntimeCoordinator;
	filePath: string;
	result: PipelineResult;
	getFlag: (name: string) => boolean | string | undefined;
	resultLive: boolean;
	analysisRootMode: AnalysisRootMode;
}): void {
	if (!args.resultLive) return;
	if (!canWriteAnalysisRoot(args.analysisRootMode)) return;
	if (!args.getFlag("lens-turn-summary")) return;
	if (args.result.diagnostics?.length) {
		for (const d of args.result.diagnostics) {
			args.runtime.turnSummary.recordDiagnostic(d.filePath || args.filePath, {
				tool: d.tool,
				ruleId: d.rule ?? d.code,
				severity: d.severity,
				line: d.line,
				description: d.message,
			});
		}
	}
	if (args.result.fixedCount && args.result.fixedCount > 0) {
		for (const label of args.result.autofixTools ?? []) {
			const [tool, countStr] = label.split(":");
			const count = Number.parseInt(countStr ?? "", 10);
			args.runtime.turnSummary.recordAutofix(args.filePath, {
				tool: tool || label,
				description:
					Number.isFinite(count) && count > 0
						? `${count} issue(s) fixed`
						: undefined,
			});
		}
	}
	if (args.result.formattersUsed?.length) {
		for (const tool of args.result.formattersUsed) {
			args.runtime.turnSummary.recordFormat(args.filePath, { tool });
		}
	}
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
 * #4737 r2: publish one returned dispatch's inline verdict for `filePath` to the
 * commit gate's state: the inline-blocker map (record or clear, ordered by the
 * dispatch's token), the analysis anchor, the `--lens-guard` status and the
 * `turn-end-findings` record. Both callers of `dispatchPipelineAnalysis` run it
 * on a result that did not crash: the classified chain, and the observed path,
 * whose blocker otherwise gated a commit only from turn_end (#4732 sends every
 * tool that is not known read-only there). Every write goes through the
 * handler's captured `writeSession`.
 */
function publishInlineVerdict(args: {
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
	filePath: string;
	result: PipelineResult;
	writeSession: LineageHandle;
	writeIndex: number;
	writeOrderTurn: number;
	/** #4137: whether this run may retire a record about the bytes it read. */
	authored: boolean;
	getFlag: ToolResultDeps["getFlag"];
	turnStateCwd: string;
	analysisRootMode: AnalysisRootMode;
	/** #4921: the write's turn session, which owns the blocker it records. */
	sessionId: string | undefined;
}): void {
	const {
		runtime,
		cacheManager,
		filePath,
		result,
		writeSession,
		writeIndex,
		writeOrderTurn,
		authored,
		getFlag,
		turnStateCwd,
		analysisRootMode,
		sessionId,
	} = args;
	// #3596: a replaced session's handler latches nothing in the live session.
	const resultLive = writeSession.guardedWrite(filePath, () => true) === true;
	// #3507: both verbs are ordered by this dispatch's token, so an older
	// pipeline that settles after a newer one of the same file changes nothing.
	let inlineVerdictApplied: boolean;
	// #4733 r3 F15: this write's clear removed the file's own blocker entry.
	let ownBlockerRetired = false;
	const { inlineBlockerSummary } = result;
	if (inlineBlockerSummary) {
		// #1561: stamp the verdict with THIS dispatch's write token — the same
		// counter `lsp_diagnostics`' reconciliation seam draws from — so a later
		// confirmed-clean result can be ordered against it instead of racing it.
		inlineVerdictApplied =
			writeSession.guardedWrite(filePath, () =>
				runtime.recordInlineBlockers(
					filePath,
					inlineBlockerSummary,
					// #3506: the token of the bytes the pipeline analysed.
					result.writeIndex ?? writeIndex,
					result.inlineBlockerSources,
					result.inlineBlockerLines,
					result.inlineBlockerFileContent,
					// #3246: the structured blockers the summary was rendered from, so a
					// later `lens_diagnostic_mark` can be applied to this record at turn
					// end instead of replaying pre-mark text.
					result.inlineBlockerDiagnostics,
					// #3559: a re-token's own turn.
					result.orderTurn ?? writeOrderTurn,
					// #3503: the freshness baseline is the analysis read.
					result.analysisReadAtMs,
					sessionId,
				),
			) !== undefined;
	} else {
		// `clearInlineBlockers` applies with no entry too, so the entry is read
		// before it.
		// Optional: a runtime double without the accessor never retires.
		const hadOwnBlocker = runtime.hasInlineBlocker?.(filePath) ?? false;
		inlineVerdictApplied =
			writeSession.guardedWrite(filePath, () =>
				runtime.clearInlineBlockers(
					filePath,
					result.writeIndex ?? writeIndex,
					result.orderTurn ?? writeOrderTurn,
					// #4137 round 3: a run without authorship does not retire a
					// record about the very bytes it read. The already-analysed latch
					// is a cost rule, not the record's guard.
					// #4484: and no run retires a record while its own observation
					// still holds a blocker.
					{
						authored,
						sha256: result.inlineBlockerFileContent?.sha256,
						blocking: result.currentBlockerCount ?? 0,
					},
				),
			) ?? false;
		// An errored run reached no observation, whatever it cleared.
		ownBlockerRetired =
			hadOwnBlocker && inlineVerdictApplied && !result.isError;
	}
	// #4484 round 3: the anchor follows the record, so it moves only with a
	// verdict that applied.
	if (inlineVerdictApplied)
		runtime.setAnalysisAnchor(filePath, result.analysisAnchor);

	// A superseded verdict must not latch the commit gate either (#3507).
	if (resultLive) {
		// #5020: this write's clean verdict on `filePath` also speaks for the rows
		// OTHER files' records hold against it. A chart-wide runner reports
		// `other-b.yaml` while `deploy-a.yaml` is written, so the row sits in
		// `deploy-a.yaml`'s record, which no dispatch of `other-b.yaml` ever
		// clears. Only an authored, applied run whose raising runner answered and
		// holds no blocker of its own on this file may say so. There is no
		// `isError` term: `PipelineResult.isError` is `false` from
		// `analysePipeline`'s only return, so the branch could never be taken.
		if (inlineVerdictApplied && authored) {
			const verdict = new Set(result.verdictRunnerIds);
			const stillReported = new Set(
				(result.inlineBlockerDiagnostics ?? []).flatMap((d) =>
					d.runnerId !== undefined && !isCrossFileBlocker(d, filePath)
						? [d.runnerId]
						: [],
				),
			);
			for (const retired of runtime.retireForeignRows(
				"cited-file-clean",
				(row) =>
					!isCrossFileBlocker(row, filePath) &&
					row.runnerId !== undefined &&
					verdict.has(row.runnerId) &&
					!stillReported.has(row.runnerId),
				writeOrderToken(
					result.orderTurn ?? writeOrderTurn,
					result.writeIndex ?? writeIndex,
				),
			)) {
				resyncGitGuardAfterRetire({
					runtime,
					cacheManager,
					cwd: turnStateCwd,
					filePath: retired.filePath,
					owner: retired.owner,
					lensGuardEnabled: !!getFlag("lens-guard"),
					analysisRootMode,
				});
			}
		}
		runtime.updateGitGuardStatus(
			inlineVerdictApplied && result.hasBlockers,
			result.output,
			filePath,
		);
		if (getFlag("lens-guard")) {
			// #4733 r1 F2: a clean verdict over the whole file, applied, with no
			// blocker left in the observation; anything less observes nothing.
			// #4733 r5 G3: a blocking finding the seed called pre-existing is still
			// reported, so it is not a clean verdict for another session's section.
			const wholeFileClean =
				inlineVerdictApplied &&
				!result.isError &&
				!result.hasBlockers &&
				result.currentBlockerCount === 0 &&
				(result.preExistingBlockerCount ?? 0) === 0 &&
				result.fileVerdictComplete === true;
			syncGitGuardRecord(
				runtime,
				cacheManager,
				turnStateCwd,
				// #4733 r2 F11: a write speaks for its file's recorded sections only
				// with that verdict, whichever session wrote them. #4733 r3 F15: or,
				// for this session's own record, when it retired the file's own
				// blocker entry (the rule the sibling callers use); without
				// `wholeFileClean` another session's section stays.
				wholeFileClean || ownBlockerRetired ? filePath : undefined,
				analysisRootMode,
				wholeFileClean,
				sessionId,
			);
		}
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
	analysisRootMode: AnalysisRootMode;
	autofixMode: "immediate" | "deferred";
	modifiedRanges: Array<{ start: number; end: number }> | undefined;
	writeIndex: number;
	/** #3540 r2: the order turn `writeIndex` was drawn in. */
	writeOrderTurn: number;
	initialStateHash: string;
	readGuardCorrelationId: string;
	requestedEditIndexes: number[];
	requestedEditTotal: number;
	/** #5120: the call's partial apply, whose commit summary names its own edits. */
	partialApply?: PartialApplyPending;
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
	// evidence; synthetic opaque writes deliberately set this false. This same
	// identity gates read-guard credit and all autonomous writer/instruction
	// surfaces (#3226).
	allowAutonomousWriters: boolean;
	/**
	 * #3512: the session this dispatch belongs to, captured by the caller
	 * at handler entry (#3568), before its first await. The deferred cascade's tier-3
	 * touch and the caller's later admission of that cascade both drop
	 * through it once the session is replaced.
	 */
	sessionGeneration: LineageHandle;
	/**
	 * #3525: false when the agent's own edit passed a moved FileTime, so the
	 * post-pipeline re-stamp of `filePath` must not credit those bytes.
	 * Omitted: stamp, as before.
	 */
	ownFileTimeStamp?: boolean;
	preserveNativeAuthorship?: boolean;
}): Promise<
	| { crashed: false; result: PipelineResult }
	| {
			crashed: true;
			response: {
				content: Array<{ type: string; text?: string }>;
				isError: true;
				structuredContent?: unknown;
			};
	  }
> {
	const {
		deps,
		runtime,
		filePath,
		dispatchCwd,
		turnStateCwd,
		analysisRootMode,
		autofixMode,
		modifiedRanges,
		writeIndex,
		writeOrderTurn,
		initialStateHash,
		readGuardCorrelationId,
		requestedEditIndexes,
		requestedEditTotal,
		partialApply,
		toolResultStart,
		nativeAppliedPairs,
		allowAutonomousWriters,
		sessionGeneration,
		ownFileTimeStamp = true,
		preserveNativeAuthorship = false,
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

	// #3763 r2: `runAutofix` marks the file fixed after its fixer awaits; a
	// replaced session's mark would skip the next session's own autofix of
	// that file (the #3576 facade of the agent_end drain, for this caller).
	const fixedThisTurn = sessionFencedFixedThisTurn(
		runtime.fixedThisTurn,
		sessionGeneration,
	);
	const pipelinePromise = runPipeline(
		{
			signal: deps.signal,
			filePath,
			cwd: dispatchCwd,
			projectRoot: turnStateCwd,
			analysisRootMode,
			toolName: event.toolName,
			autofixMode,
			allowAutonomousWriters,
			modifiedRanges,
			// #4484 r2: read when the dispatch returns, so a collect-later answer
			// absorbed meanwhile is part of what the run carries forward.
			priorInlineBlockers: () => runtime.getInlineBlockerDiagnostics(filePath),
			// #4484 round 3: what those blockers' lines refer to.
			priorAnalysisAnchor: () => runtime.getAnalysisAnchor(filePath),
			telemetry: {
				model: runtime.telemetryModel,
				// #4943: the writing session, which the log rows and a collect-later
				// answer (`PendingRunnerFindings.sessionId`) are keyed by.
				sessionId: deps.sessionId ?? runtime.telemetrySessionId,
				turnIndex: runtime.turnIndex,
				writeIndex,
				orderTurn: writeOrderTurn,
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
			sessionGeneration,
			// #3830: a whole-package fixer's restore ends after this result, so its
			// loss notice is queued for the session this dispatch belongs to.
			onFixRunLoss: (notice) =>
				queueAgentAdvisory(notice, deps.advisoryScope ?? sessionGeneration),
			// #3559: the re-token's turn, read when it is drawn.
			nextWriteIndex: () => ({
				turnIndex: runtime.turnIndex,
				orderTurn: runtime.writeOrderTurn,
				writeIndex: runtime.nextWriteIndex(),
			}),
		},
		{
			biomeClient: biomeClient!,
			ruffClient: ruffClient!,
			metricsClient: metricsClient!,
			getFormatService,
			fixedThisTurn,
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
	const registryKey = inFlightKey(initialStateHash, allowAutonomousWriters);
	const registeredPipelines = registerInFlightPipeline(
		filePath,
		registryKey,
		pipelineTelemetry,
	);
	let result: PipelineResult;
	try {
		result = await pipelinePromise;
	} catch (pipelineErr) {
		if (getFlag("lens-guard")) {
			// #4733 r2 F12: about this file, so only its own next dispatch answers it.
			// #4733 r5 G2: in the session that dispatched it, so a replaced
			// session's late rejection cannot latch the live one.
			sessionGeneration.guardedWrite(filePath, () =>
				runtime.markGitGuardDispatchUnanswered(filePath, "pipeline_crash"),
			);
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
				structuredContent: event.structuredContent,
			},
		};
	} finally {
		releaseInFlightPipeline(filePath, registryKey, registeredPipelines);
	}
	// #4733 r2 F12, r5 G1: the dispatch latch is this file's, and both callers
	// return here, so an errored run sets it and any other returned run answers
	// it. Fenced like the crash mark above (r5 G2).
	if (getFlag("lens-guard")) {
		sessionGeneration.guardedWrite(filePath, () =>
			result.isError && !result.hasBlockers
				? runtime.markGitGuardDispatchUnanswered(filePath, "pipeline_error")
				: runtime.answerGitGuardDispatch(filePath),
		);
	}

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
	// #5120: a partial apply's executed batch is renumbered; its summary is
	// the preflight's, over the original batch, with the edits it applied.
	const appliedIndexes = partialApply
		? boundedEditIndexes(partialApply.applied.map((edit) => edit.originalIndex))
		: requestedEditIndexes;
	logReadGuardEvent({
		event: "edit_batch_summary",
		correlationId: readGuardCorrelationId,
		filePath,
		metadata: {
			tool: event.toolName,
			editBatchSummary: createReadGuardEditBatchSummary({
				...(partialApply?.summary ?? {
					requestedIndexes: requestedEditIndexes,
					requestedTotal: requestedEditTotal,
					resolvedIndexes: requestedEditIndexes,
					resolvedTotal: requestedEditTotal,
				}),
				appliedIndexes,
				// The executed batch is exactly the applied edits.
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
	// The latch identifies the bytes this pipeline actually analysed. A pipeline
	// that reports no write analysed its input state, even if another writer
	// changed disk while the await was parked. A pipeline-reported write selects
	// only the identity captured by runPipeline before analysis awaits (#2499).
	const pipelineOwnedWriteHash = result.fileModified
		? result.postWriteStateHash
		: undefined;
	const finalStateHash = pipelineOwnedWriteHash ?? initialStateHash;
	if (!result.fileModified || pipelineOwnedWriteHash !== undefined) {
		// #3763: keyed by the LIVE turn index, so a replaced session's pipeline
		// would mark the new session's same bytes as already analysed.
		sessionGeneration.guardedWrite(filePath, () =>
			lastAnalyzedStateByFile.set(filePath, {
				turnIndex: runtime.turnIndex,
				stateHash: finalStateHash,
				authored: allowAutonomousWriters,
			}),
		);
	}

	// #2402: pi-lens' own immediate format/autofix may have rewritten the file
	// after the native edit was recorded by the caller. Stamp the post-pipeline
	// state so an identical retry against the formatted bytes is still
	// recognized as already-applied. Only the pairs recorded this invocation are
	// stamped, and only when the pipeline actually changed the bytes.
	// `initialStateHash` IS the post-write hash at both call sites — the
	// classified chain passes `postWriteStateHash` verbatim, the observed path
	// passes the same pre-settle digest.
	if (pipelineOwnedWriteHash !== undefined) {
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
	if (!getFlag("no-read-guard") && allowAutonomousWriters) {
		const ownPath = path.resolve(filePath);
		const changedForReadGuard = new Set([
			ownPath,
			...(result.changedFiles ?? []).map((changedFile) =>
				path.resolve(changedFile),
			),
		]);
		for (const changedFile of changedForReadGuard) {
			// A native edit already credited its own bytes above (a positional
			// edit with its produced lines, any other with UNKNOWN ones). The
			// pipeline may re-credit ownPath only when it actually rewrote those
			// bytes; otherwise a whole-file stamp would erase the native scope or
			// make a first authorship the edit's credit refused (#4387).
			if (
				changedFile === ownPath &&
				pipelineOwnedWriteHash === undefined &&
				preserveNativeAuthorship
			)
				continue;
			if (nodeFs.existsSync(changedFile)) {
				deps.readGuard?.recordWritten(changedFile, {
					authorship: "whole-file",
					stampFileTime: ownFileTimeStamp || changedFile !== ownPath,
					// The identity of the bytes this pipeline analysed or wrote
					// (#2499), when it knows them: no re-read.
					...(changedFile === ownPath &&
						(!result.fileModified || pipelineOwnedWriteHash !== undefined) && {
							contentHash: finalStateHash,
						}),
				});
			}
		}
	}

	return { crashed: false, result };
}

/**
 * #3523: the one `edits[].range` replacement of a positional edit call, as
 * executed. Its `newText` then occupies the lines from `range.start.line`.
 *
 * #3760: the only shape recorded. A multi-range batch is not: no host
 * pi-lens adapts pins whether its ranges are in original or sequential line
 * numbers, and a guessed shift would put `newText` on lines the host did not
 * write. `oldRange` carries no replacement text. A hashline edit's lines come
 * from anchors pi-lens recomputes, not from the tool's own store
 * (`hashline-anchor.ts`), so where they landed is unverified. Each keeps its
 * re-edit refused as range-stale: a re-read, never a stale allow.
 */
function singlePositionalEdit(
	input: unknown,
): { start: number; newText: string } | undefined {
	const edits = (input as { edits?: unknown } | undefined)?.edits;
	if (!Array.isArray(edits) || edits.length !== 1) return undefined;
	const edit = edits[0] as {
		range?: { start?: { line?: unknown } };
		newText?: unknown;
	};
	const start = edit?.range?.start?.line;
	return typeof start === "number" && typeof edit.newText === "string"
		? { start, newText: edit.newText }
		: undefined;
}

/**
 * The evidence for an own edit's `newText`. `deliveredLineEvidence("a\n", n)`
 * counts a trailing empty line, but a host may take that "\n" as line n's
 * terminator and write none; a record that claims it would shadow the agent's
 * read of the real next line (#3739 F1). Keep the empty line only when the
 * file holds one right after the lines the edit certainly wrote.
 */
function ownEditEvidence(
	filePath: string,
	edit: { start: number; newText: string },
): ReturnType<typeof deliveredLineEvidence> {
	const full = deliveredLineEvidence(edit.newText, edit.start);
	if (!edit.newText.endsWith("\n")) return full;
	const certain = deliveredLineEvidence(edit.newText.slice(0, -1), edit.start);
	try {
		const next = nodeFs.readFileSync(filePath, "utf-8").split(/\r?\n/)[
			edit.start + certain.lineCount - 1
		];
		return next !== undefined && next.trim() === "" ? full : certain;
	} catch {
		return certain;
	}
}

/**
 * pi's `read` output less the continuation notice pi appends after the
 * delivered lines (`@earendil-works/pi-coding-agent` `dist/core/tools/read.js`:
 * `[Showing lines A-B of T. …]`, `[Showing lines A-B of T (50.0KB limit). …]`,
 * `[N more lines in file. …]`, each after a blank line).
 */
const PI_READ_NOTICE =
	/\n\n\[(?:Showing lines \d+-\d+ of \d+(?: \([^)\]]+ limit\))?|\d+ more lines in file)\. Use offset=\d+ to continue\.\]$/;

function piReadBody(text: string): string {
	return text.replace(PI_READ_NOTICE, "");
}

/**
 * #3519/#3523: the pushed record that the read guard took a read from text
 * the conversation showed the agent (`read_recorded` is verbose-only).
 */
function logConversationRead(
	source: "autofix-attachment" | "own-edit",
	filePath: string,
	offset: number,
	evidence: {
		lineCount: number;
		lineHashes: Record<number, string> | undefined;
	},
): void {
	logLatency({
		type: "phase",
		phase: "read_guard_conversation_read",
		filePath,
		durationMs: 0,
		metadata: {
			source,
			offset,
			lineCount: evidence.lineCount,
			hashed: evidence.lineHashes !== undefined,
		},
	});
}

/** #3555: the leading note on a read the tool_call widened. */
function readWideningNote(widening: ReadWidening): string {
	const { requested, shown, boundary } = widening;
	const reason =
		"heading" in boundary
			? `the Markdown section under the heading "${boundary.heading}" (heading boundary)`
			: `the enclosing ${boundary.symbol.kind} "${boundary.symbol.name}" (symbol boundary)`;
	return `[pi-lens: read widened to ${reason}: you asked for lines ${requested.offset}-${requested.offset + requested.limit - 1}, this shows lines ${shown.offset}-${shown.offset + shown.limit - 1}. Re-request with limit > ${EXPANSION_LIMIT_LINES} for the exact range.]`;
}

/**
 * `tool_execution_end`: the call is over (#4185 round 4). pi emits it once
 * for every call that reached `tool_call`, top-level and nested
 * (`parentToolCallId`), and for an executed call only after every extension's
 * `tool_result` handler returned. A call that ended in error showed the agent
 * no bytes: a read the host failed, or one a later extension blocked after
 * pi-lens recorded its capture (pi then emits no `tool_result` at all). Its
 * capture is released here, by the call identity that keyed it, so it cannot
 * license an edit later in the same run. A delivered read is left alone: its
 * `tool_result` already superseded the capture, or is still writing the
 * record that will. Returns whether a capture was released.
 */
export function handleToolExecutionEnd(
	event: unknown,
	readGuard: Pick<ReadGuard, "dropProvisionalReadByCall">,
): boolean {
	if ((event as { isError?: unknown } | undefined)?.isError !== true)
		return false;
	const toolCallId = resolveToolCallCorrelationId(event);
	return toolCallId !== undefined
		? readGuard.dropProvisionalReadByCall(toolCallId)
		: false;
}

/**
 * #5120: the agent-facing result of a partial apply. The host edit wrote the
 * matched subset, so the edits that applied lead the message and the
 * preflight's per-edit bodies follow unchanged: they describe exactly the
 * edits that did not apply. The preflight header (🔄/🛑) is never reused for
 * committed bytes; that relabelling is the #2402 retry loop. When the host
 * refused the subset, nothing was written and the preflight verdict stands.
 * Either way the call reports `isError`: the batch as submitted did not land.
 */
function composePartialApplyResult(
	pending: PartialApplyPending,
	event: ToolResultDeps["event"],
	result: ToolResultReturn,
): ToolResultReturn {
	// pi's edit tool reports a refusal by throwing, which pi turns into an
	// error result.
	const hostRefused = event.isError === true;
	const content = result ? result.content : event.content;
	const structuredContent = result
		? result.structuredContent
		: event.structuredContent;
	const readGuardCorrelationId = getReadGuardCorrelationId(event);
	const filePath = readToolResultPathField(event) ?? "";
	if (hostRefused) {
		logReadGuardEvent({
			event: "edit_partial_apply_rejected",
			correlationId: readGuardCorrelationId,
			filePath,
			metadata: {
				tool: event.toolName,
				rejectionReason: "host_refused",
				editCount: pending.applied.length,
			},
		});
		return {
			content: [
				{
					type: "text",
					text: `${pending.preflightError}\n\n🛑 Batch not applied: the host edit refused the matched edits as well, so nothing was written. Rebuild the edit from a fresh read.`,
				},
				...content,
			],
			isError: true,
			structuredContent,
		};
	}
	const count = pending.applied.length;
	const indices = formatBoundedEditIndexes(
		boundedEditIndexes(pending.applied.map((edit) => edit.originalIndex)),
	);
	const committed = `⚠️ PARTIAL APPLY — ${count} edit${count === 1 ? "" : "s"} committed (${indices}).`;
	const parts = [
		result?.isError === true
			? `${committed} Post-edit analysis failed after the commit; the committed bytes stand and were not reverted. Do NOT resubmit the applied edits.`
			: `${committed} Do NOT resubmit the applied edits.`,
	];
	if (pending.preflightDetails && pending.preflightDetails.length > 0)
		parts.push(pending.preflightDetails.join("\n\n"));
	const alreadyNotes = formatAlreadyAppliedNotes(pending.alreadyAppliedEdits);
	if (alreadyNotes) parts.push(alreadyNotes.trimStart());
	return {
		content: [{ type: "text", text: parts.join("\n\n") }, ...content],
		isError: true,
		structuredContent,
	};
}

export async function handleToolResult(
	deps: ToolResultDeps,
): Promise<ToolResultReturn> {
	// #5120: a call whose tool_call rewrote a partly matching batch to its
	// matched subset is taken here, before the attribution take below. The
	// handler runs it as the edit it is, and the partial-apply message wraps
	// its result. A re-entry (the debounce) already carries it.
	if (deps._partialApply === undefined) {
		const callId = resolveToolCallCorrelationId(deps.event);
		const partialApply =
			callId !== undefined
				? (
						deps.runtime as Partial<RuntimeCoordinator>
					).toolCallPartialApply?.call(deps.runtime, callId)
				: undefined;
		if (partialApply)
			return composePartialApplyResult(
				partialApply,
				deps.event,
				await handleToolResult({
					...deps,
					_partialApply: partialApply,
					_mutationSourceOverride: "partial-apply",
				}),
			);
	}
	const {
		event,
		getFlag,
		dbg,
		runtime,
		cacheManager,
		agentBehaviorRecord,
		formatBehaviorWarnings,
	} = deps;

	// #3506 r1 F8, #3568: the session this handler belongs to, captured before
	// its first await. index.ts' bound abandons a handler without cancelling
	// it, so any await below can resume after a session_start that restarted
	// the turn and write counters; a capture taken there would name session 2.
	const writeSession =
		deps._sessionGeneration ?? runtime.captureSessionGeneration();
	const advisoryScope = deps.advisoryScope ?? writeSession;
	// #3650: the tool_result path question has one owner
	// (`readToolResultPathField`); no fallback cascade is open-coded here.
	const rawFilePath = readToolResultPathField(event);
	const workspaceRoot = runtime.projectRoot || process.cwd();
	let bashAuthorshipConfirmed =
		deps._allowAutonomousWriters ??
		deps._readGuardAuthorship ??
		event.toolName !== "bash";

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
	// The transcript identity every read-evidence record below carries: the
	// `toolResult` that shows the agent the bytes, which for a nested call is
	// its parent's (#3831, #4138). `toolCallId` stays the call's own identity
	// for everything that pairs this result with its tool_call.
	const readEvidenceToolCallId = resolveReadEvidenceCorrelationId(event);
	// #3598: the host tool for this call has finished, whatever it did. Before
	// any return below, so a call that exits early is still no longer in flight.
	noteAgentCallEnd(toolCallId);
	// #4185 R4-1: this event's own isError is what pi-lens saw fail; the
	// `tool_execution_end` release reads pi's final value, which a later
	// extension's `tool_result` hook can rewrite to success. Before any return.
	if (event.isError === true && toolCallId !== undefined)
		deps.readGuard?.dropProvisionalReadByCall(toolCallId);
	// #4732: the command text bash's recovery reads its roots and recognized
	// writes from, and whether this is a call of another tool whose own
	// `tool_call` recorded an opaque baseline. That record is the decision (the
	// gate, the structured classifier and the id rule all ran there); this side
	// follows it instead of re-deriving it (shape 19).
	const bashCommand =
		event.toolName === "bash" &&
		typeof (event.input as { command?: unknown }).command === "string"
			? (event.input as { command: string }).command
			: undefined;
	const opaqueNonBash =
		event.toolName !== "bash" &&
		toolCallId !== undefined &&
		shouldRunOpaqueRecovery(event.toolName, workspaceRoot) &&
		getOpaqueBaselineStore().has(
			opaqueBaselineSlot(
				opaquePrescanRoot(deps.cwd, workspaceRoot),
				runtime.sessionGeneration,
			),
			toolCallId,
		);
	// #4732: a captured tool's relative path field that has no attribution
	// (none is recorded for a tool the classifier does not know) is still
	// refused as a PATH, but the handler goes on: the diff below recovers the
	// call's writes, and an observation the #2430 net armed for the call (from
	// the cwd the call ran in) settles as for an absolute path.
	let unattributedOpaque = false;
	const attribution =
		toolCallId !== undefined
			? runtime.takeToolCallAttribution(toolCallId)
			: undefined;
	// #3555: claimed here, before any return, so it never outlives its call.
	// A read reaches only the two returns that prepend it (the unattributed
	// relative path below, and the not-a-mutation exit). The note is its own
	// leading block, never spliced into the file text.
	const readWidening =
		event.toolName === "read" && toolCallId !== undefined
			? runtime.takeReadWidening(toolCallId)
			: undefined;
	// Only for the range that executed: a later handler may have re-targeted
	// the read, or the id may belong to a different call.
	// A read tool_call that returned early never dropped a stale entry for its
	// id, so the file has to match too.
	const executedRead = event.input as {
		filePath?: unknown;
		offset?: unknown;
		limit?: unknown;
	};
	const notedWidening =
		readWidening &&
		event.isError !== true &&
		(rawFilePath ?? executedRead.filePath) === readWidening.inputPath &&
		executedRead.offset === readWidening.shown.offset &&
		executedRead.limit === readWidening.shown.limit
			? readWidening
			: undefined;
	const readNote = notedWidening
		? [{ type: "text", text: readWideningNote(notedWidening) }]
		: [];
	if (notedWidening) {
		// #3555: the pushed record that a widening was disclosed.
		logLatency({
			type: "phase",
			phase: "read_widening_note",
			toolName: event.toolName,
			filePath: notedWidening.filePath,
			durationMs: 0,
			metadata: {
				requested: notedWidening.requested,
				shown: notedWidening.shown,
				boundary: "heading" in notedWidening.boundary ? "heading" : "symbol",
			},
		});
	}

	// Search tools reveal specific lines (file:line) the agent then edits — register
	// those shown lines (± context) as reads so the follow-up edit isn't blocked (#169).
	// Our tools attach locations as `details.searchReads`; bash grep is parsed from
	// `grep -n` output. Only shown lines are registered, never the whole file.
	//
	// #1884: this runs BEFORE the `path_attribution_missing` refusal below, because
	// the two answer different questions. The refusal answers for the call's NAMED
	// path, which no attribution can resolve, and keeps every path-keyed step
	// closed; a `searchReads` entry carries its own path, so the lines a
	// relative-path `lsp_navigation` result showed are delivered evidence either
	// way. Registered after the refusal, they were dropped, and the agent's
	// follow-up edit to a line it had just been shown was blocked.
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
				...(readEvidenceToolCallId !== undefined && {
					toolCallId: readEvidenceToolCallId,
				}),
			});
		}
	}

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
		if (!opaqueNonBash)
			return readNote.length > 0
				? {
						content: [...readNote, ...event.content],
						structuredContent: event.structuredContent,
					}
				: undefined;
		unattributedOpaque = true;
		resolutionBasis = workspaceRoot;
	} else {
		// Either an ABSOLUTE path (bash-synthetic writes always pass one —
		// unambiguous regardless of any basis, see the bash-write dispatch
		// below) or a host that supplies NO correlation id at all under any
		// known field name. The latter cannot be correlated by identity full
		// stop; this is the SAME exposure every host had before this fix,
		// not a regression introduced by it.
		resolutionBasis = workspaceRoot;
	}
	// #4576: one host-path resolver for both sides of a call. The `tool_call`
	// seam already expanded `~`, `file://`, an `@` prefix and the variant
	// ladder through this exact function; resolving the result's authoritative
	// path with a bare `path.resolve` turned `~/x` into `<root>/~/x`, a path
	// that cannot exist, and dispatched runners and analyzers against it.
	// #4577: a path recovered from disk is already an identity, not a spelling
	// the model typed — `_pathAlreadyResolved` carries that provenance from the
	// recovery caller instead of this handler guessing it from the string.
	const filePath = unattributedOpaque
		? undefined
		: rawFilePath && deps._pathAlreadyResolved
			? rawFilePath
			: resolveToolCallFilePath(rawFilePath, resolutionBasis, workspaceRoot)
					?.path;
	// The class and its root, answered once: the rows below name the root the
	// class served, never a second rule's answer (#4734 Sourcery thread 3).
	const analysisRoot = classifyAnalysisRoot(filePath ?? "", workspaceRoot);
	const analysisRootMode = analysisRoot.mode;
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
	// The parent bash call is already recorded. Its per-file diagnostic replays
	// must not push that real call out of the BLIND WRITE knowledge window.
	const behaviorWarnings = isBashDerivedReplay(event)
		? []
		: agentBehaviorRecord(event.toolName, filePath);
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
	// #4732: the same recovery, publish and dispatch serve every other tool
	// whose `tool_call` recorded a baseline. It has no command text, so it
	// recognizes nothing, recovers from the session root only, and every path
	// it wrote is opaque evidence (unauthored, no blockers).
	if (bashCommand !== undefined || opaqueNonBash) {
		const command = bashCommand ?? "";
		/** What the rows below name the call by: its command, or its tool. */
		const opaqueLabel = bashCommand ?? event.toolName;
		const recognized = extractWrittenPathsFromCommand(command, workspaceRoot);
		// #2050: the trees this command's writes are recovered from. The session
		// root is where the host ran it; every further root is a checkout the
		// command ITSELF named and that is a linked worktree of this repository,
		// so its writes are recovered from that root's own `git status`.
		// #4504: one derivation from the command text and the session root, which
		// is the same input the `tool_call` side took its baselines from.
		const scanRoot = opaquePrescanRoot(deps.cwd, workspaceRoot);
		const recoveryScopes = resolveOpaqueRecoveryRoots(command, scanRoot);
		/**
		 * The most specific recovery root holding `file`, so two roots that
		 * overlap (a worktree nested under the session root) never both claim it.
		 * The file is compared by its REAL path (#4713 F3): a `cd` into a symlink
		 * that points at a linked worktree names that checkout under a different
		 * spelling, and a lexical match put the file under the session root — the
		 * root whose observation never saw it.
		 */
		const ownerRootOf = (file: string): string | undefined => {
			const abs = realpathOrResolve(file);
			let owner: string | undefined;
			for (const root of recoveryScopes.roots) {
				if (!isUnderDir(abs, root)) continue;
				if (owner === undefined || root.length > owner.length) owner = root;
			}
			return owner;
		};
		// The SURVIVING recognized set: what will actually dispatch. Failure
		// atomicity (#2000 invariant 5) means opaque recovery must subtract
		// THIS set, not raw recognized - otherwise a redirect target dropped
		// by the isError filter would be subtracted from recovery AND
		// excluded here, attributed nowhere.
		// #2050 AC4: a recognised operand now resolves against the command's own
		// `cd`, so a write in a linked worktree is named by ITS path. It is
		// outside the session ROOT yet inside the session's analysis family
		// (`canWriteAnalysisRoot("linked-worktree")`), so it is admitted by the
		// checkout it belongs to and judged against THAT checkout's ignores.
		const isRecordableBashWrite = (wp: string): boolean => {
			// #4713 F3: whether a checkout may be written is `analysis-root.ts`'s
			// rule, not a second derivation here. It resolves the file's real path,
			// so a worktree reached through a symlinked spelling is admitted exactly
			// like the real one; the OWNER root still answers which ignores apply.
			if (!canWriteAnalysisRoot(resolveAnalysisRoot(wp, workspaceRoot)))
				return false;
			if (isRecordableProjectPath(wp, workspaceRoot)) return true;
			const owner = ownerRootOf(wp);
			return (
				owner !== undefined &&
				owner !== scanRoot &&
				isRecordableProjectPath(wp, owner)
			);
		};
		let recognizedWritten =
			event.isError !== true ? recognized.filter(isRecordableBashWrite) : [];
		// #2000 phase 2: when the extractor recognizes NOTHING, the command is
		// opaque-candidate — recover its actual changed set by diffing the pre
		// snapshot taken at tool_call. Partial writes that landed before a
		// nonzero exit ARE attributed (the files changed and the agent authored
		// them) — a deliberate divergence from the isError filter above, which
		// exists for restore semantics where attribution would lie.
		let opaquePaths: string[] = [];
		// #4737 r3: the recovered paths the observation answers for: sent with
		// the call's population, never recorded or dispatched by this half.
		let observedOpaquePaths: string[] = [];
		let hadOpaqueRecovery = false;
		/** Each root's own surviving recovery: what git reported AND we claim. */
		const recoveredByRoot = new Map<string, Set<string>>();
		let recognizedAuthored: string[] = [];
		// #4502: the pre-command dirty set, taken from this call's own baseline
		// and compared with the post-command status below. Held here (not inside
		// the recovery block) because the head look after it is what publishes it.
		let dirtyBefore: readonly string[] | undefined;
		// Recovery runs for EVERY bash command with a pending baseline - not
		// only recognized-empty ones. A mixed command (`python x.py > out.ts`
		// plus script-internal writes) previously skipped observation entirely
		// with zero telemetry; git-first recovery is cheap enough (~60ms) to
		// close that gap, subtracting already-recognized paths so nothing
		// double-dispatches.
		// #4504: one root for the record and the take. The coordinator's
		// `projectRoot` is the LIVE PRIMARY's for a concurrent secondary (#473),
		// so this side has to ask the host's own cwd, exactly as the `tool_call`
		// side does — never the root it happens to be dispatching against.
		type RootRecovery =
			| {
					root: string;
					verdict: "observed";
					keys: string[];
					excluded: number;
					unknownPairs: number;
			  }
			| { root: string; verdict: "unknown"; reason: string };
		if (shouldRunOpaqueRecovery(event.toolName, workspaceRoot)) {
			const started = Date.now();
			const unknownRoots = new Set<string>();
			let unknownReason: string | undefined;
			// Every root's baseline is taken BEFORE the first await, so which root
			// finished first can never decide which baseline a later take finds.
			const baselines = recoveryScopes.roots.map((root) => ({
				root,
				pending: getOpaqueBaselineStore().take(
					opaqueBaselineSlot(root, runtime.sessionGeneration),
					toolCallId,
				),
			}));
			// #4502: `undefined` means git could not answer before the command, an
			// empty array that the tree was clean. Only the second says "no discard".
			dirtyBefore = baselines.find((entry) => entry.root === scanRoot)?.pending
				?.dirtyPaths;
			// The roots recover in PARALLEL. Each is an independent `git status`
			// (or stat capture), and a bash result the host classed READ-ONLY has a
			// 500 ms bound, so summing two spawns would spend the budget the
			// delivery below needs (#2050).
			const outcomes = await Promise.all(
				baselines.map(async ({ root, pending }): Promise<RootRecovery> => {
					if (!pending)
						// Partial coverage without observation: the explicit verdict
						// invariant 1 demands (never silently imply no change).
						return {
							root,
							verdict: "unknown",
							reason:
								recognized.length > 0
									? "partial-recognition-no-baseline"
									: "no-pending-snapshot",
						};
					if (pending.strategy === "git") {
						// Git-first: no universe cap - works on any repo size.
						const recovery = await recoverOpaqueChangesViaGit(
							root,
							pending.startedAt,
							{
								excludeIndexOnlyWhenUnmerged: isFailedGitIntegrationCommand(
									command,
									event.isError,
								),
							},
						);
						if (recovery.verdict === "unknown")
							return {
								root,
								verdict: "unknown",
								reason: recovery.unknownReason ?? "git-failed",
							};
						return {
							root,
							verdict: "observed",
							// A clean git verdict is complete evidence that no path changed
							// IN THIS CHECKOUT; it is not missing evidence. Both branches
							// therefore record the root as observed, and only the recovered
							// paths earn authorship.
							keys:
								recovery.verdict === "recovered"
									? recovery.paths.filter((p) =>
											isRecordableProjectPath(p, root),
										)
									: [],
							excluded: recovery.excludedIncomingCount ?? 0,
							unknownPairs: recovery.unknownStatusCount ?? 0,
						};
					}
					if (pending.stats) {
						const outcome = await captureFileStats(root, {
							withHashes: true,
							...deps._opaqueCaptureOptions,
						});
						if (!outcome.snapshot || outcome.unknownReason)
							return {
								root,
								verdict: "unknown",
								reason:
									outcome.unknownReason ??
									pending.statsUnknownReason ??
									"walk-failed",
							};
						return {
							root,
							verdict: "observed",
							keys: diffFileContent(pending.stats, outcome.snapshot),
							excluded: 0,
							unknownPairs: 0,
						};
					}
					return {
						root,
						verdict: "unknown",
						reason: pending.statsUnknownReason ?? "walk-failed",
					};
				}),
			);
			for (const outcome of outcomes) {
				if (outcome.verdict === "unknown") {
					// #4732: bash already says this through its coverage row and its
					// withheld blockers; another tool's writes simply go unseen.
					if (bashCommand === undefined)
						recordOpaqueCaptureRefused(outcome.reason, event.toolName);
					// #2060: deliberately WIDER than the old `recognized.length > 0`
					// guard. A fully opaque command whose probe failed is the shape
					// whose coverage is least knowable, and it used to record
					// nothing at all.
					unknownRoots.add(outcome.root);
					unknownReason ??= outcome.reason;
					continue;
				}
				recoveredByRoot.set(outcome.root, new Set(outcome.keys));
				// #2060: both counts are bounded (one record per tool_result, no
				// per-path logging) and exist because filtering is invisible in
				// production otherwise - the dropped paths simply never appear.
				if (outcome.excluded > 0)
					logLatency({
						type: "phase",
						phase: "opaque_mutation_incoming_excluded",
						filePath: opaqueLabel.slice(0, 80),
						durationMs: Date.now() - started,
						result: `excluded:${outcome.excluded}`,
						metadata: { root: outcome.root },
					});
				if (outcome.unknownPairs > 0)
					logLatency({
						type: "phase",
						phase: "opaque_mutation_status_pair_unknown",
						filePath: opaqueLabel.slice(0, 80),
						durationMs: Date.now() - started,
						result: `kept:${outcome.unknownPairs}`,
						metadata: { root: outcome.root },
					});
			}
			opaquePaths = recoveryScopes.roots.flatMap((root) => [
				...(recoveredByRoot.get(root) ?? []),
			]);
			// A file the extractor already recognized must not be dispatched twice
			// through the opaque half: recovery's `git status` names it too. The
			// OBSERVATION keeps it (`recoveredByRoot`), because that is the evidence
			// its authorship is judged on below.
			if (opaquePaths.length > 0 && recognizedWritten.length > 0) {
				// #4713 F3: the recovered keys are git's own identities, so the
				// recognized side is compared by its real path too. A symlinked
				// spelling of a worktree file is the same file, and subtracting it
				// keeps one dispatch and one authorship rather than an authored
				// write plus an opaque copy of its own bytes.
				const survivingKeys = new Set(
					recognizedWritten.map((p) => normalizeMapKey(realpathOrResolve(p))),
				);
				opaquePaths = opaquePaths.filter((p) => !survivingKeys.has(p));
			}
			// #4732: a path the #2430 net armed an observation of for this same
			// call is the settle's to answer, with the tool's own attribution.
			// #4737 r3: it still goes out in the awaited primary send below, so a
			// sibling dispatched first never reads its old bytes (#4507).
			if (opaquePaths.length > 0 && opaqueNonBash) {
				const observed = new Set(
					pendingObservationPaths(toolCallId, runtime.sessionGeneration).map(
						(p) => normalizeMapKey(realpathOrResolve(p)),
					),
				);
				if (observed.size > 0) {
					for (const p of opaquePaths)
						if (observed.has(p)) observedOpaquePaths.push(p);
					opaquePaths = opaquePaths.filter((p) => !observed.has(p));
				}
			}
			hadOpaqueRecovery = opaquePaths.length > 0;
			if (recoveredByRoot.size > 0 || unknownRoots.size > 0) {
				// The scan speaks only for the checkout it ran in (#4504 r1, #2050):
				// a recognized write is judged by ITS OWN root's verdict, so a clean
				// `git status` in the session root can no longer clear a write in a
				// linked worktree (shape 54: a scan may not drop the only fresh answer
				// it cannot see) and a recovered path earns authorship only from the
				// root that saw it (shape 65).
				const scanned: string[] = [];
				const unscanned: string[] = [];
				for (const file of recognizedWritten) {
					const owner = ownerRootOf(file);
					const observed =
						owner === undefined ? undefined : recoveredByRoot.get(owner);
					if (owner === undefined || observed === undefined)
						unscanned.push(file);
					// #4713 F3: the observation is keyed by the identity git reported, so
					// the LOOKUP takes the file's real path too. A symlinked spelling of a
					// worktree path matched nothing, so a recognised write that WAS
					// observed read as unscanned and lost its authorship.
					else if (observed.has(normalizeMapKey(realpathOrResolve(file))))
						scanned.push(file);
				}
				recognizedAuthored = scanned;
				if (recognizedAuthored.length === 0 && unscanned.length === 0)
					recognizedWritten = [];
			}
			if (unknownReason) {
				logLatency({
					type: "phase",
					phase: "opaque_mutation_coverage_unknown",
					filePath: opaqueLabel.slice(0, 80),
					durationMs: Date.now() - started,
					result: unknownReason,
					metadata: {
						root: scanRoot,
						unknownRoots: unknownRoots.size,
					},
				});
			}
			// One row per recovering root that found something (bounded by
			// `OPAQUE_RECOVERY_ROOT_CAP`), each naming its own root: a reader must be
			// able to tell WHICH checkout a population came from, and the roots of
			// one call are not interchangeable (#2050).
			for (const root of recoveryScopes.roots) {
				const keys = recoveredByRoot.get(root);
				if (keys === undefined || keys.size === 0) continue;
				// The row's path field names at most five of them.
				const listed = [...keys];
				listed.length = Math.min(listed.length, 5);
				logLatency({
					type: "phase",
					phase: "opaque_mutation_recovered",
					filePath: listed.join(","),
					durationMs: Date.now() - started,
					result: `changed:${keys.size}`,
					metadata: { root, roots: recoveryScopes.roots.length },
				});
			}
		}
		// #4493: a command that moved HEAD resyncs the held documents it
		// rewrote before this result returns, ahead of the synthetic dispatches
		// below, so their diagnostics read the new dependencies. It has the edit
		// budget, as the bash-write primary phase does: a move is a write, and
		// the 500 ms read-only bound cut a slow primary mid-send (#4528 r4).
		// #4504 r1: the head-move record and take resolve their root through the
		// same owner as the baseline slot, so a concurrent secondary (#473) joins
		// the look its own `tool_call` recorded, not the live primary's.
		// #4502: the same look carries a same-HEAD discard. The paths are read
		// from this call's own baseline (dirty before) against the status now
		// (clean after), which is the only evidence those commands leave, and
		// they ride the one awaited look so the resync still lands before this
		// result returns.
		const headScanRoot = opaquePrescanRoot(deps.cwd, workspaceRoot);
		if (headScanRoot) {
			const headMoveSignal = deps.signal ?? undefined;
			const discarded =
				dirtyBefore === undefined
					? undefined
					: await readSameHeadDiscards(headScanRoot, dirtyBefore);
			await bounded(
				resyncHeadMove({
					root: headScanRoot,
					key: headRecordKey(
						opaqueBaselineSlot(headScanRoot, runtime.sessionGeneration),
						deps.sessionId,
					),
					trigger: "tool_result",
					label: opaqueLabel,
					...(discarded ? { discarded } : {}),
					runtime,
				}),
				{
					ms: HOOK_WALL_BUDGET_MS.tool_result_edit,
					signal: headMoveSignal,
					hook: "tool_result_edit",
					label: "head-move-resync",
				},
			);
		}
		// #4532 gap 7: the install look also runs at the roots of the LIVE primary
		// clients, not only at the session's cwd. A session whose cwd is a main
		// checkout can drive a server rooted in a LINKED WORKTREE, and a
		// `node_modules` symlinked into that worktree was invisible to a look that
		// only ever read the session root's install stamp: tsserver republished the
		// same seven `@types/node` gaps for 14 minutes after `tsc` was clean. Keyed
		// on the live ROOTS, not on the files this command wrote (a `ln -s` writes
		// no project file), and each root is looked at with its own client's spawn
		// epoch, so a FIRST look at that root publishes an install the client never
		// read instead of recording it as the baseline. It runs before the primary
		// resync below, so a restart lands before the resend.
		const clientRoots = liveClientRootsApartFrom(headScanRoot);
		if (clientRoots.length > 0) {
			const lookSignal = deps.signal ?? undefined;
			await bounded(
				Promise.all(
					clientRoots.map((entry) =>
						lookForOutOfBandChanges(
							entry.root,
							"tool_result",
							// AGENTS.md "What it is" (analysis-root invariant): the look may run at
							// an adopted root (its client must restart when its install
							// appears), but an adopted root never receives session
							// bookkeeping — no sequence, no receipt, no change-log entry
							// (#4532 round 3, Greptile). The session root and its
							// repository's linked worktrees are bookkeeping roots.
							isSessionBookkeepingRoot(entry.root, headScanRoot)
								? runtime
								: undefined,
							{
								since: entry.spawnedAt,
								walk: "interval",
							},
						).catch((cause: unknown) => {
							// One bounded record per root: a look that threw tells nothing
							// about the root's install, so it must not read as "no install".
							recordDegradationOnce({
								kind: "lsp-client-root-look-failed",
								subject: normalizeMapKey(entry.root),
								reason: `the install look at a live client root failed: ${cause instanceof Error ? cause.message : String(cause)}`,
							});
						}),
					),
				),
				{
					ms: HOOK_WALL_BUDGET_MS.tool_result_edit,
					signal: lookSignal,
					hook: "tool_result_edit",
					label: "client-root-install-look",
				},
			);
		}
		// wp iterates opaquePaths VERBATIM (already normalizeMapKey keys), so the
		// set must hold those exact strings - no re-resolution.
		const opaqueSet = new Set(opaquePaths);
		const written = [...recognizedWritten, ...opaquePaths];
		// #2050: one bounded record when a single command's written population
		// spans more than one checkout. Without it the recovered/primary rows read
		// like any other multi-file write and nothing says the session reached
		// outside its own root.
		const writtenRoots = new Set<string>();
		for (const file of written) writtenRoots.add(ownerRootOf(file) ?? scanRoot);
		if (writtenRoots.size > 1)
			logLatency({
				type: "phase",
				phase: "opaque_mutation_multi_root",
				filePath: [...writtenRoots].join(",").slice(0, 300),
				durationMs: 0,
				result: `roots:${writtenRoots.size}`,
				metadata: { written: written.length },
			});
		// #4507: every file the command wrote reaches the primary servers that
		// hold it before the synthetic dispatches below. They run one file at a
		// time, so without this a dependent dispatched ahead of its dependency
		// was checked against the dependency's old bytes (a phantom STOP). The
		// full resync of the opaque paths (auxiliaries, held importers, drift
		// records) follows the primary phase, detached.
		//
		// #4528 r1 F1: the dispatch loop waits for the phase itself, under the
		// edit budget its dispatches already run under, not the 500 ms read-only
		// bound: under load the phase outlasted 500 ms, the cut let a.ts be
		// checked while z.ts was still unsent, and the phantom STOP came back.
		// A live primary takes the capped sends far inside the budget; one that
		// does not answers the dispatches after it no better (no verdict).
		const sentPopulation = [...written, ...observedOpaquePaths];
		if (workspaceRoot && sentPopulation.length > 0) {
			const primaryStarted = Date.now();
			// The servers must also have READ the sends before a dispatch reads a
			// check (#4528 r1 F1): the held-primary pass's drain barrier.
			//
			// #4504 r1: a server answers for the checkout that roots it, so the
			// phase runs one publish per root `written` spans. A concurrent
			// secondary's recovered files belong to its own checkout; looking them
			// up under the coordinator's root found no holder, so the awaited send
			// skipped every document and a dispatch could read the stale bytes.
			//
			// #4535 slice 2: both phases are the publisher's LSP consumer. This
			// detector names no service: `bash-write` is the population every
			// written path feeds (the awaited primary phase), and `recovered-drift`
			// is the recovered subset's detached follow-up.
			ensureDiskChangeSubscribers();
			const sendsByRoot = new Map<string, string[]>();
			for (const file of sentPopulation) {
				// #2050: the root that OWNS the file. A recovered path from a linked
				// worktree belongs to that worktree's clients, not to the session
				// root's (which hold no document for it); the fallback keeps the
				// pre-existing answer for a path no recovery root covers.
				const owner =
					ownerRootOf(file) ??
					(isUnderDir(path.resolve(file), scanRoot) ? scanRoot : workspaceRoot);
				const bucket = sendsByRoot.get(owner);
				if (bucket) bucket.push(file);
				else sendsByRoot.set(owner, [file]);
			}
			const publishes = Promise.all(
				[...sendsByRoot].map(async ([root, files]) => ({
					root,
					published: await publishDiskChangeChunked({
						root,
						origin: "bash-recovery",
						sources: [BASH_WRITE_SOURCE],
						// The population is what the command wrote; recovery only
						// read stat evidence for its opaque half. Chunked: a code-mod
						// that writes more than the publisher's cap otherwise degrades
						// to `"unknown"`, and this branch's consumer then takes every
						// held document for the awaited send (review round 3, HIGH:
						// `changedSent 0/65`, probe F) with no drift pass to heal it.
						kind: "inferred",
						paths: files,
					}),
				})),
			);
			const primaryPhase = publishes.then((groups) => {
				const answers = groups.flatMap(({ root, published }) =>
					published.map(({ results, failedSubscribers }) =>
						readHeldDocumentsAnswer(results, root, failedSubscribers),
					),
				);
				return {
					targets: answers.flatMap((answer) => answer.targets),
					primary: answers.reduce((count, answer) => count + answer.primary, 0),
					failed: answers.some((answer) => answer.failed),
					drained: answers.every((answer) => answer.drained),
				};
			});
			// The drift pass carries the OPAQUE half only. `recoveredByRoot` is the
			// OBSERVATION (it also holds a recognized file, which the authorship
			// judgement above reads), while `opaquePaths` is the population that
			// still needs the follow-up: a recognized write already went to the
			// primaries in the awaited phase and is dispatched on its own, so
			// publishing it here ran a second LSP drift pass over the same bytes
			// (#2050 r2, `disk-change-detectors-4535` "a parser-recognized write").
			const driftByRoot = new Map<string, string[]>();
			for (const file of opaquePaths) {
				const root = ownerRootOf(file) ?? scanRoot;
				const bucket = driftByRoot.get(root);
				if (bucket) bucket.push(file);
				else driftByRoot.set(root, [file]);
			}
			if (driftByRoot.size > 0)
				void primaryPhase
					.then(() =>
						Promise.all(
							[...driftByRoot].map(([root, paths]) =>
								publishDriftPass(root, paths, RECOVERED_DRIFT_PASS),
							),
						),
					)
					.catch((err) => {
						// The one handler the base branch had for this detached chain.
						// The publisher never rejects (see `publishDiskChange`'s contract)
						// and a drift rejection is recorded by `publishDriftPass`
						// chunk by chunk (review round 3, p3-3; #4612 r4 lets the chain
						// go on), so only a programming error reaches here.
						// none: the two failure paths this chain owns record themselves, so
						// a record here would duplicate one and mislabel the other.
						dbg(`git-change LSP resync failed: ${err}`);
					});
			// A name of its own: the HEAD look above bounds with the same signal.
			const primarySignal = deps.signal ?? undefined;
			const sent = await bounded(primaryPhase, {
				ms: HOOK_WALL_BUDGET_MS.tool_result_edit,
				signal: primarySignal,
				hook: "tool_result_edit",
				label: "bash-write-primary-resync",
			});
			// One row per bash result that had held documents to resend, or whose
			// phase failed or was cut ("cut": the bound ended the wait, and its
			// hook-await-exceeded row names it; "undrained": a server did not
			// answer the drain barrier in time, so a check may predate the sends).
			if (sent === undefined || sent.failed || sent.targets.length > 0)
				logLatency({
					type: "phase",
					phase: "bash_write_primary_resync",
					filePath: written.slice(0, 5).join(","),
					durationMs: Date.now() - primaryStarted,
					result:
						sent === undefined
							? "cut"
							: sent.failed
								? "failed"
								: sent.drained
									? "sent"
									: "undrained",
					metadata: {
						written: written.length,
						opaque: opaquePaths.length,
						targets: sent?.targets.length ?? -1,
						primary: sent?.primary ?? 0,
					},
				});
		}
		const recognizedAuthoredSet = new Set(recognizedAuthored);
		bashAuthorshipConfirmed = recognizedAuthored.length > 0;
		for (const wp of written) {
			// #3525: a parser-recognized bash write is whole-file authorship only
			// after the tool_call preflight proved no foreign writer intervened.
			// Opaque recovery is observed bridge evidence, not bytes the parser
			// accounted for, so it remains UNKNOWN for F-4210-2. No pre-write
			// check covered those bytes, so it may only end an existing
			// authorship, never advance it (#4387).
			const opaqueEvidence = hadOpaqueRecovery || opaqueSet.has(wp);
			if (!getFlag("no-read-guard") && recognizedAuthoredSet.has(wp))
				deps.readGuard?.recordWritten(wp, {
					authorship: opaqueEvidence ? "unknown" : "whole-file",
					...(opaqueEvidence && { advanceAuthorship: false }),
					stampFileTime: false,
					...(toolCallId !== undefined && { toolCallId }),
				});
			const receipt = (runtime as Partial<RuntimeCoordinator>)
				.recordMutationToolReceipt;
			// #3763: after the recovery and earlier synthetic awaits, a replaced
			// session's receipt stays out of the live session's turn.
			const autofixMode =
				(receipt &&
					writeSession.guardedWrite(wp, () =>
						receipt.call(runtime, wp, "write"),
					)?.autofixMode) ??
				"immediate";
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
				// #4713 F2: the checkout that owns this written path, so the ignore
				// gate below asks the root that admitted the write.
				_ownerRoot: ownerRootOf(wp),
				_autofixMode: autofixMode,
				_attachmentBudget: syntheticAttachmentBudget,
				_mutationSourceOverride: isOpaque ? "opaque-script" : undefined,
				_readGuardAuthorship: recognizedAuthoredSet.has(wp),
				_pathAlreadyResolved: true,
				_ownWriteStamp: {
					stampFileTime: false,
					...(toolCallId !== undefined && { toolCallId }),
				},
				// Opaque recovery is mutation evidence only. The synthetic call still
				// records freshness and runs diagnostics, but it cannot format/autofix
				// or issue an edit-directed blocker/actionable instruction.
				_allowAutonomousWriters: recognizedAuthoredSet.has(wp),
				_sessionGeneration: writeSession,
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
			const clippedLines =
				truncation?.truncated === true &&
				typeof truncation.outputLines === "number"
					? truncation.outputLines
					: undefined;
			const clipped = clippedLines !== undefined;
			// #1649: an unclipped view drops vendor and ignored files before their
			// lines are counted. A clipped one keeps every span: the multi-span
			// check below must still see a file the loop then skips, or
			// `cat a.ts vendor.js` would credit lines of a.ts pi never showed.
			const parsedSpans = extractReadPathsFromCommand(
				command,
				workspaceRoot,
				clipped
					? undefined
					: (candidate) => isRecordableProjectPath(candidate, workspaceRoot),
			);
			let spans = parsedSpans;
			if (clipped) {
				if (parsedSpans.length === 1) {
					const span = parsedSpans[0];
					if (span) {
						// countFileLines intentionally preserves the split-based guard
						// convention, where a trailing newline contributes an empty final
						// element. The host's output line count does not include that
						// element, so remove it from the span basis before taking the tail.
						const hasTrailingNewline = lastByteIsNewline(span.filePath);
						const spanLineCount = hasTrailingNewline
							? Math.max(1, span.limit - 1)
							: span.limit;
						const shown = Math.min(clippedLines, spanLineCount);
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
				if (!isRecordableProjectPath(span.filePath, workspaceRoot)) continue;
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
					...(readEvidenceToolCallId !== undefined && {
						toolCallId: readEvidenceToolCallId,
					}),
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
		const readGuard = deps.readGuard;
		if (
			event.isError !== true &&
			readGuard !== undefined &&
			!getFlag("no-lsp") &&
			!getFlag("no-read-guard")
		) {
			for (const dp of extractDeletedPathsFromCommand(command, workspaceRoot)) {
				// The four gates (and the #1668 F4 confirm) are shared with the v2
				// bridge's delete facet; every verdict but `confirmed` is skipped.
				const verdict = judgeConfirmedDelete(dp, {
					isExternalOrVendorFile: (p) =>
						isExternalOrVendorFile(p, workspaceRoot),
					isPathIgnoredByProject: (p) =>
						isPathIgnoredByProject(p, workspaceRoot, false),
					hasKnownPath: (p) => readGuard.hasKnownPath(p),
					existsSync: (p) => nodeFs.existsSync(p),
				});
				if (verdict !== "confirmed") continue;
				readGuard.forgetPath(dp);
				void notifyExternalFileChange(dp, 3).catch((err) => {
					dbg(`tool_result: external-delete notify failed for ${dp}: ${err}`);
				});
			}
		}
	}

	// A read whose host call errored delivered nothing: its tool_call capture
	// is released by `handleToolExecutionEnd`, which pi emits right after this
	// handler, keyed by the call (#4185 round 4).

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
			const input = event.input as { offset?: number; limit?: number };
			const requestedOffset = Math.max(1, input.offset ?? 1);
			const requestedLimit = input.limit;
			const truncation = (
				event.details as
					| {
							truncation?: { outputLines?: number; truncated?: boolean };
					  }
					| undefined
			)?.truncation;
			// #1649: one bounded pass gives the count and the delivered range's
			// line hashes, read at the same moment the capture always was. The
			// delivered limit waits on the count, so the range is open-ended: the
			// scan keeps at most READ_HASH_MAX_LINES lines from the offset.
			const deliveredScan = scanFileLines(
				deliveredFilePath,
				[{ offset: requestedOffset, limit: Number.POSITIVE_INFINITY }],
				{ count: true },
			);
			// An unreadable file counts one line, as countFileLines always answered.
			const totalLines = deliveredScan?.totalLines ?? 1;
			const available = Math.max(0, totalLines - requestedOffset + 1);
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
					sessionId: deps.sessionId ?? runtime.telemetrySessionId,
					filePath: deliveredFilePath,
					requestedOffset,
					requestedLimit: requestedLimit ?? deliveredLimit,
					effectiveOffset: requestedOffset,
					effectiveLimit: deliveredLimit,
					metadata: {
						totalLines,
						isPartial: deliveredLimit < available,
						fileKind: detectFileKind(deliveredFilePath) ?? "unknown",
						fractionRead:
							available > 0
								? Math.round((deliveredLimit / available) * 100) / 100
								: 1,
						expandedByTs: false,
					},
				});
				// #3524: another writer moved the file after the tool_call's stamp,
				// so the disk may not be what pi delivered, and by now it holds the
				// racer's bytes. The stamp stays where it was. The evidence is the
				// delivered text (less pi's continuation notice) when pi's own count
				// vouches for it: no more lines than pi's truncation count, or, for
				// an untruncated limited read, exactly as many lines as the
				// tool_call's capture hashed. Other text is not pi's raw output (a
				// producer upstream decorated it), and a read with no count (no
				// limit, no truncation) has nothing to vouch for it. The evidence
				// is then the tool_call's own capture: the provisional record this
				// result supersedes, the newest one, since an id can be reused,
				// its range clipped to the lines pi showed. Where the capture
				// equals the text, the two are the same evidence; where a write
				// landed before pi's read, the capture refuses lines the agent was
				// shown until it re-reads. With no hashed capture there is no
				// evidence, and nothing is recorded.
				const raced = deps.readGuard.diskMovedSinceStamp(deliveredFilePath);
				const deliveredText = raced
					? deliveredLineEvidence(
							piReadBody(
								event.content
									.map((part) =>
										part.type === "text" ? (part.text ?? "") : "",
									)
									.join("\n"),
							),
							requestedOffset,
						)
					: undefined;
				const capture = raced
					? deps.readGuard
							.getReadHistory(deliveredFilePath)
							.slice()
							.reverse()
							.find(
								(candidate) =>
									candidate.source === `native-read:${toolCallId}:provisional`,
							)
					: undefined;
				const capturedLines = capture?.lineHashes
					? Object.keys(capture.lineHashes).length
					: 0;
				const delivered =
					deliveredText &&
					(truncation?.outputLines !== undefined
						? deliveredText.lineCount <= truncation.outputLines
						: requestedLimit !== undefined &&
							deliveredText.lineCount === capturedLines)
						? deliveredText
						: undefined;
				// The capture's limit can exceed the lines it hashed (a limit past
				// the end of the file); hashes past the clip would still be a
				// relocation target for lines pi never showed.
				const shownLimit = capture
					? Math.min(
							capture.effectiveLimit,
							truncation?.outputLines ?? Number.POSITIVE_INFINITY,
							capturedLines,
						)
					: 0;
				const captureEvidence = capture?.lineHashes && {
					effectiveOffset: capture.effectiveOffset,
					effectiveLimit: shownLimit,
					// Integer keys enumerate in ascending order, from the offset.
					lineHashes: Object.fromEntries(
						Object.entries(capture.lineHashes).slice(0, shownLimit),
					),
				};
				if (raced) {
					incrementDegradationCount({
						kind: "native-read-raced-writer",
						subject: deliveredFilePath,
						reason: delivered
							? "the file changed between pi's read and its tool_result; the read is recorded from the delivered text"
							: captureEvidence
								? "the file changed between pi's read and its tool_result; pi's line count does not vouch for the delivered text, so the tool_call's capture is the evidence"
								: "the file changed between pi's read and its tool_result; pi's line count does not vouch for the delivered text and there is no hashed tool_call capture, so the read is not recorded",
					});
				}
				const evidence =
					raced && !delivered
						? captureEvidence
						: {
								effectiveOffset: requestedOffset,
								effectiveLimit: delivered?.lineCount ?? deliveredLimit,
								// Unraced, the disk is what pi delivered: the scan above is
								// the capture recordRead would otherwise take again.
								lineHashes: raced
									? delivered?.lineHashes
									: deliveredScan?.hashes(requestedOffset, deliveredLimit),
							};
				if (evidence) {
					const deliveredRecord = {
						filePath: deliveredFilePath,
						requestedOffset,
						requestedLimit: requestedLimit ?? deliveredLimit,
						effectiveOffset: evidence.effectiveOffset,
						effectiveLimit: evidence.effectiveLimit,
						expandedByLsp: false,
						...(evidence.lineHashes && { lineHashes: evidence.lineHashes }),
						turnIndex: runtime.turnIndex,
						writeIndex: runtime.peekWriteIndex(),
						timestamp: Date.now(),
						...(readEvidenceToolCallId !== undefined && {
							toolCallId: readEvidenceToolCallId,
						}),
					};
					deps.readGuard.recordRead(deliveredRecord, {
						// The capture is keyed by this call's own identity.
						...(toolCallId && { supersedes: { toolCallId } }),
						stampFileTime: !raced,
					});
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
	// #3598: a whole-package fixer (clippy --fix, dart fix) may be running over
	// this file. Read its bytes NOW, before any await, so the fixer's later
	// write cannot pass for the agent's content.
	if (mutation && filePath && event.isError !== true) {
		noteAgentMutation(
			filePath,
			expectationFromToolInput(event.input, mutation.kind),
		);
	}
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
	// #4732: a write pi-lens replays from an opaque diff carries its call's id,
	// and that call's observation is the call's own to settle, never a replay's.
	const observationPending =
		!getFlag("no-read-guard") &&
		!isBashDerivedReplay(event) &&
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
			// #4737 r2: the session captured at entry. After the opaque recovery's
			// await the live one can be a replacement that reused this call id.
			sessionGeneration: writeSession.scopeId,
			// #3613 F2: the budget of this session's own turn.
			turnIndex: runtime.turnKey(deps.sessionId),
			signal: getAmbientAbortSignal(),
			// #3596: the replay lands after the settle's own awaits.
			// #4943: and names this turn's session, which owns its deferred pass.
			record: (entry) =>
				replayThroughMutationBridge({
					...entry,
					lineage: writeSession,
					...(deps.sessionId !== undefined && { sessionId: deps.sessionId }),
				}),
			getStoredLineHashes: (candidate) =>
				storedLineHashesFor(deps.readGuard, candidate),
			isRecordable: (candidate) =>
				isRecordableProjectPath(candidate, workspaceRoot),
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
		// #4737 r3: an unset `filePath` (the result refused a relative path no
		// attribution backs) still dispatches what the settle recorded; only the
		// steps keyed on the tool's named path need it.
		if (!filePath || !isExternalOrVendorFile(filePath, workspaceRoot)) {
			// On call ONE the tool is not classified at all, so there is no
			// `mutation.kind` to read. The observation itself is the authority and
			// it only ever records "edit" (`settleObservedMutation` hard-codes
			// `kind: "edit"`, and #2430 tier 4 only ever classifies a learned tool
			// as "edit"), so the two agree wherever both exist.
			const observedKind: MutationKind = mutation?.kind ?? "edit";
			const observedAppliedPairs = filePath
				? recordNativeAppliedPairs({
						runtime,
						input: event.input,
						kind: observedKind,
						filePath,
						stateHash: preSettleStateHash ?? getFileStateHash(filePath),
					})
				: [];
			// Analyse the files the observation actually RECORDED, not merely the
			// path the tool named. A directory is never a pipeline target.
			const observedDispatchPaths = observedChangedPaths
				.filter((candidate) => {
					try {
						return !nodeFs.statSync(candidate).isDirectory();
					} catch {
						return false;
					}
				})
				.slice(0, OBSERVED_DISPATCH_MAX_PATHS);
			const observedDispatchDropped =
				observedChangedPaths.length - observedDispatchPaths.length;
			if (observedDispatchDropped > 0) {
				incrementDegradationCount({
					kind: "observed-mutation-dispatch-cap",
					subject: event.toolName,
					reason: `observed mutation dispatch capped at ${OBSERVED_DISPATCH_MAX_PATHS}; ${observedDispatchDropped} path(s) not dispatched`,
				});
			}
			// #4737 r3 F1, r4: each recorded file's own receipt and exports, before
			// the client wait below can return. The receipt is the write->edit
			// turn transition (it releases a file an earlier write's autofix
			// marked fixed, so the deferred pass fixes these bytes too), and a
			// removed export left cached blocks the next write of that name.
			// #3763: the settle awaited; a replaced session's receipt stays out of
			// the live session's turn. The fallback is the classified chain's,
			// minus its `_bypassDebounce` branch (#2464 review round 2, S3), which
			// no caller reaching this block sets.
			const observedAutofixModes = new Map<string, "immediate" | "deferred">();
			for (const observedPath of observedChangedPaths)
				writeSession.guardedWrite(observedPath, () => {
					refreshCachedExports(runtime, observedPath);
					const receipt = (
						runtime as Partial<RuntimeCoordinator>
					).recordMutationToolReceipt?.call(
						runtime,
						observedPath,
						observedKind,
					);
					if (receipt)
						observedAutofixModes.set(observedPath, receipt.autofixMode);
				});
			if (observedDispatchPaths.length > 0) {
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
				for (const observedPath of observedDispatchPaths) {
					// #3596: a replaced session dispatches no further path; each
					// one's writes would be dropped, so its run is wasted work.
					if (writeSession.guardedWrite(observedPath, () => true) !== true)
						continue;
					// #4737 r4: the file's own class, never the named path's: a refused
					// relative path leaves `filePath` unset, and a sibling is not the
					// file the tool named.
					const observedRootMode = classifyAnalysisRoot(
						observedPath,
						workspaceRoot,
					).mode;
					const observedDispatchSignal = deps.signal;
					const observedJoinSignal = deps.signal;
					const observedStateHashForPath = getFileStateHash(observedPath);
					const observedClaim = claimPipelineDispatch({
						filePath: observedPath,
						stateHash: observedStateHashForPath,
						turnIndex: runtime.turnIndex,
						// #4137: the authority its dispatch below runs with.
						authored: true,
						participantId: observedReadGuardCorrelationId,
						dbg,
					});
					if (!observedClaim.proceed) {
						if (observedClaim.joined) {
							await bounded(observedClaim.joined, {
								ms: HOOK_WALL_BUDGET_MS.tool_result_edit,
								signal: observedJoinSignal,
								hook: "tool_result_edit",
								label: "observed-tool-result-join",
							});
						}
						continue;
					}
					// #4737 r2: one token and one root for the dispatch and the verdict
					// it publishes.
					const observedWriteIndex = runtime.nextWriteIndex();
					const observedWriteOrderTurn = runtime.writeOrderTurn;
					const observedTurnStateCwd = path.resolve(workspaceRoot);
					const observedDispatchOutcome = await bounded(
						dispatchPipelineAnalysis({
							deps,
							runtime,
							filePath: observedPath,
							dispatchCwd: resolveLanguageRootForFile(
								observedPath,
								workspaceRoot,
							),
							turnStateCwd: observedTurnStateCwd,
							analysisRootMode: observedRootMode,
							autofixMode:
								observedAutofixModes.get(observedPath) ??
								(observedKind === "edit" ? "deferred" : "immediate"),
							modifiedRanges: undefined,
							writeIndex: observedWriteIndex,
							writeOrderTurn: observedWriteOrderTurn,
							initialStateHash: observedStateHashForPath,
							readGuardCorrelationId: observedReadGuardCorrelationId,
							requestedEditIndexes: getRequestedEditIndexes(
								event,
								observedKind,
							),
							requestedEditTotal: getRequestedEditCount(event, observedKind),
							participantIds: [observedReadGuardCorrelationId],
							participantTotal: 1,
							toolResultStart,
							nativeAppliedPairs: observedAppliedPairs,
							// #2802 authorship rule (master): the observational
							// settle already recorded this edit through the
							// bridge, so the dispatch's read-guard write refresh
							// carries evidence and stays enabled on every
							// per-path dispatch.
							allowAutonomousWriters: true,
							// #3512: this path admits no cascade, so the capture
							// only guards the cascade's tier-3 touch. #3568: the
							// handler's, not one taken after path 1's await.
							sessionGeneration: writeSession,
							// #3865: pi-lens does not know the bytes an
							// unclassified tool wrote, so its refresh credits
							// authorship and leaves FileTime where it was.
							ownFileTimeStamp: false,
						}),
						{
							ms: HOOK_WALL_BUDGET_MS.tool_result_edit,
							signal: observedDispatchSignal,
							hook: "tool_result_edit",
							label: "observed-tool-result-analysis",
						},
					);
					if (observedDispatchOutcome?.crashed) {
						// #2464 review round 2, S6: parity with the classified chain — a
						// pipeline crash surfaces its notice to the agent instead of being
						// swallowed into a dbg line the model never sees. The recorded
						// edit stands either way; only the analysis was lost.
						dbg(
							`tool_result: pipeline analysis crashed for the observed mutation on ${observedPath}; the recorded edit stands, analysis did not run this turn`,
						);
						return observedDispatchOutcome.response;
					}
					// #4737 r2: the verdict gates the commit now, as the classified
					// chain's does, not from turn_end. The observation is the
					// authorship evidence (the claim above runs with `authored: true`).
					if (observedDispatchOutcome) {
						publishInlineVerdict({
							runtime,
							cacheManager,
							filePath: observedPath,
							result: observedDispatchOutcome.result,
							writeSession,
							writeIndex: observedWriteIndex,
							writeOrderTurn: observedWriteOrderTurn,
							authored: true,
							getFlag,
							turnStateCwd: observedTurnStateCwd,
							analysisRootMode: observedRootMode,
							sessionId: deps.sessionId,
						});
					}
				}
				dbg(
					`tool_result: the observational settle already recorded ${observedReplayed} mutation(s) for "${event.toolName}"; kept the applied-edit records, mutation receipt, cachedExports refresh, and ran the pipeline dispatch (#2464); skipped the bridge-covered staleness stamp / turn-state ranges / change-log receipt / deferred autofix+format`,
				);
			} else {
				dbg(
					`tool_result: the observational settle recorded ${observedReplayed} mutation(s) for "${event.toolName}", but no dispatchable changed paths remained`,
				);
			}
		}
		return syntheticWriteContent.length > 0
			? {
					content: [...event.content, ...syntheticWriteContent],
					structuredContent: event.structuredContent,
				}
			: undefined;
	}
	if (mutation === undefined) {
		dbg(
			`tool_result: skipped turn tracking - toolName="${event.toolName}" is not a classified mutation`,
		);
		return syntheticWriteContent.length > 0 || readNote.length > 0
			? {
					content: [...readNote, ...event.content, ...syntheticWriteContent],
					structuredContent: event.structuredContent,
				}
			: undefined;
	}
	if (!filePath) {
		dbg(
			`tool_result: skipped turn tracking - no filePath for toolName="${event.toolName}"`,
		);
		return;
	}
	if (analysisRootMode === "none") {
		if (
			isOutsideProjectRoot(filePath, workspaceRoot) &&
			!isVendorPath(filePath) &&
			!isPiLensInternalPath(filePath, workspaceRoot)
		) {
			const firstOutsideRootEdit = recordDegradationOnce({
				kind: "tool-result-outside-project-root",
				subject: workspaceRoot,
				reason: `edit outside session root: ${filePath}`,
			});
			if (firstOutsideRootEdit) {
				queueAgentAdvisory(
					`pi-lens skipped analysis for the edit at ${filePath} because it is outside the session root. Start pi in that directory or add it to the workspace to get analysis.`,
					advisoryScope,
				);
			}
		}
		dbg(
			`tool_result: skipped pipeline - file outside project root or in node_modules: ${filePath}`,
		);
		return;
	}
	if (analysisRootMode === "adopted") {
		const adoptedRoot = analysisRoot.root;
		if (adoptedRoot) {
			const firstAdoptedRoot = recordDegradationOnce({
				kind: "tool-result-adopted-project",
				subject: adoptedRoot,
				reason: `analysing ${adoptedRoot} as a separate project`,
			});
			if (firstAdoptedRoot) {
				queueAgentAdvisory(
					`pi-lens is analysing ${adoptedRoot} as a separate project (LSP + global or managed php-lint/fish-indent; formatting, autofix, other dispatch runners, and automatic tests are off).`,
					advisoryScope,
				);
			}
		}
	}
	// #2430: a classified mutation is accounted for by the chain below, so the
	// `agent_settled` sweep must re-baseline this file rather than report the
	// same bytes as unexplained drift.
	noteMutationHandled(filePath);
	const readGuardCorrelationId = getReadGuardCorrelationId(event);
	const resultDetails = (event.details ?? {}) as Record<string, unknown>;
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
		return {
			content: event.content,
			isError: true,
			structuredContent: event.structuredContent,
		};
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
		// #5120: a partial apply's host edit ran on the exact span text; an
		// identical resubmission carries the agent's own pairs.
		input: deps._partialApply
			? { edits: deps._partialApply.applied }
			: event.input,
		kind: mutation.kind,
		filePath,
		stateHash: postWriteStateHash,
	});

	// #3523: an edit the guard allowed at the agent's own line numbers is the
	// agent's view of the lines it wrote, so its next edit of them is judged
	// against its `newText`, not the read that predates it. One positional
	// edit only: in a batch, each range's lines shift by the others' growth.
	// Per event, so before the debounce keeps only the latest. The mark is
	// only ever set by the guard's own check, so `--no-read-guard` never
	// reaches here. FileTime is recordWritten's to move (#3525): after an
	// edit that passed a moved FileTime, it must stay moved.
	const ownEdit = attribution?.editInPlace
		? singlePositionalEdit(event.input)
		: undefined;
	const nativeAuthoredRanges =
		mutation.kind === "edit" && ownEdit
			? (() => {
					const evidence = ownEditEvidence(filePath, ownEdit);
					return [
						[ownEdit.start, ownEdit.start + evidence.lineCount - 1] as [
							number,
							number,
						],
					];
				})()
			: undefined;
	if (ownEdit) {
		const evidence = ownEditEvidence(filePath, ownEdit);
		deps.readGuard?.recordRead(
			{
				filePath,
				requestedOffset: ownEdit.start,
				requestedLimit: evidence.lineCount,
				effectiveOffset: ownEdit.start,
				effectiveLimit: evidence.lineCount,
				expandedByLsp: false,
				...(evidence.lineHashes && { lineHashes: evidence.lineHashes }),
				turnIndex: runtime.turnIndex,
				writeIndex: runtime.peekWriteIndex(),
				timestamp: Date.now(),
				source: "own-edit",
				...(readEvidenceToolCallId !== undefined && {
					toolCallId: readEvidenceToolCallId,
				}),
			},
			{ stampFileTime: false },
		);
		logConversationRead("own-edit", filePath, ownEdit.start, evidence);
	}

	// #3525: an edit the guard passed over a moved FileTime leaves it moved;
	// #3524: a write's creation read is the `content` it executed. Taken here,
	// before the debounce, which the attribution does not survive.
	// Only a write's tool_call notes a pending creation, so only a write's
	// `content` is ever read.
	const executedContent = (event.input as { content?: unknown }).content;
	const ownWriteStamp: OwnWriteStamp = deps._ownWriteStamp ?? {
		stampFileTime: attribution?.fileTimeStale !== true,
		...(typeof executedContent === "string" && {
			writtenContent: executedContent,
		}),
		...(toolCallId !== undefined && { toolCallId }),
	};

	// Must happen before debounce admission: latestDeps intentionally retains only
	// the latest event, but write -> edit is a sticky turn transition.
	const receipt = (runtime as Partial<RuntimeCoordinator>)
		.recordMutationToolReceipt;
	// #3763: an armed call awaited the settle above; a replaced session's
	// receipt stays out of the live session's turn.
	const autofixMode = deps._bypassDebounce
		? (deps._autofixMode ??
			(mutation.kind === "edit" ? "deferred" : "immediate"))
		: ((receipt &&
				writeSession.guardedWrite(filePath, () =>
					receipt.call(runtime, filePath, mutation.kind),
				)?.autofixMode) ??
			(mutation.kind === "edit" ? "deferred" : "immediate"));

	// Coalesce sequential edits to the same file into one pipeline run against
	// the final state. Only the debounce-fired call (with _bypassDebounce=true)
	// proceeds to the pipeline body; in-window callers share its promise.
	if (!deps._bypassDebounce) {
		const debounceMs = getDebounceMs();
		if (debounceMs > 0) {
			return scheduleDebounced(filePath, debounceMs, {
				...deps,
				// #3596 G: the re-entry keeps the session this handler entered in.
				_sessionGeneration: writeSession,
				_autofixMode: autofixMode,
				_ownWriteStamp: ownWriteStamp,
				_telemetryParticipantIds: [readGuardCorrelationId],
				_telemetryParticipantTotal: 1,
			});
		}
	}

	// Refresh the read-guard's FileTime stamp so that the model's own write
	// doesn't trigger a spurious "file_modified" block on the next edit.
	if (bashAuthorshipConfirmed)
		deps.readGuard?.recordWritten(filePath, {
			authorship:
				mutation.kind === "write"
					? "whole-file"
					: nativeAuthoredRanges !== undefined
						? "partial"
						: "unknown",
			...(nativeAuthoredRanges !== undefined && {
				authoredRanges: nativeAuthoredRanges,
			}),
			...ownWriteStamp,
			contentHash: postWriteStateHash,
		});

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
	// #3508: so the bootstrap clients are awaited ABOVE the claim, as the
	// observed path does. A failed demand still records the edit below; it
	// only skips the dispatch.
	const classifiedClients = ensureToolResultClients(deps);
	const classifiedClientsReady =
		classifiedClients === true ||
		!!(await bounded(Promise.resolve(classifiedClients), {
			ms: HOOK_WALL_BUDGET_MS.tool_result_edit,
			signal: deps.signal,
			hook: "tool_result_edit",
			label: "classified-tool-result-analysis",
		}));
	const classifiedClaim = claimPipelineDispatch({
		filePath,
		stateHash: initialStateHash,
		turnIndex: runtime.turnIndex,
		// #4137: the authority the dispatch below runs with.
		authored: bashAuthorshipConfirmed,
		participantId: readGuardCorrelationId,
		dbg,
	});
	if (!classifiedClaim.proceed) {
		if (classifiedClaim.joined) {
			await classifiedClaim.joined;
		}
		return;
	}

	// #3596: the analysers and the join above awaited. A replaced session's
	// handler writes nothing more into the live session's read guard or
	// turn-state worklist, and dispatches nothing; the change-log receipt below
	// stays, because the edit did land on disk.
	const entryLive = writeSession.guardedWrite(filePath, () => true) === true;
	if (!getFlag("no-read-guard") && bashAuthorshipConfirmed) {
		// #4942: the session's own guard (`deps.readGuard`), the one the write's
		// other stamps above use; the coordinator's is another session's.
		const readGuard = deps.readGuard;
		if (entryLive)
			readGuard?.recordWritten?.(filePath, {
				authorship:
					mutation.kind === "write"
						? "whole-file"
						: nativeAuthoredRanges !== undefined
							? "partial"
							: "unknown",
				...(nativeAuthoredRanges !== undefined && {
					authoredRanges: nativeAuthoredRanges,
				}),
				...ownWriteStamp,
				contentHash: postWriteStateHash,
			});
		else
			recordDroppedRead(writeSession, "tool-result", writeSession.branchEpoch);
	}

	// `toolResultStart` is hoisted above both provenance exits (#2464 review
	// round 2, S5) so the two paths' durations are comparable — see its
	// declaration right after the observational settle.
	dbg(`tool_result: tracking turn state for ${event.toolName} on ${filePath}`);

	if (
		isPathIgnoredByProject(filePath, deps._ownerRoot ?? workspaceRoot, false)
	) {
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
	// #3507: the turn this token was drawn in orders it across turns (#3540
	// r2: the order turn, which a session reset never restarts).
	const writeOrderTurn = runtime.writeOrderTurn;
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
	// #3596: turn-state.json is the live session's worklist (#2504).
	const addTurnRange = (
		range: { start: number; end: number },
		importsChanged: boolean,
	): void => {
		if (entryLive)
			cacheManager.addModifiedRange(
				filePath,
				range,
				importsChanged,
				turnStateCwd,
				deps.sessionId ?? runtime.telemetrySessionId,
				"pi",
				undefined,
				analysisRootMode,
			);
	};
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
				addTurnRange(range, importsChanged);
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
			for (const range of adapterRanges) addTurnRange(range, importsChanged);
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
			addTurnRange({ start: 1, end: lineCount }, importsChanged);
		} else if (mutation.kind === "write" && nodeFs.existsSync(filePath)) {
			const content = nodeFs.readFileSync(filePath, "utf-8");
			const lineCount = content.split("\n").length;
			const hasImports = /^import\s/m.test(content);
			modifiedRanges = [{ start: 1, end: lineCount }];
			addTurnRange({ start: 1, end: lineCount }, hasImports);
		}
	} catch (err) {
		dbg(`turn state tracking error: ${err}`);
		dbg(`turn state tracking error stack: ${(err as Error).stack}`);
	}

	recordProjectChange({
		runtime,
		cwd: turnStateCwd,
		analysisRootMode,
		filePath,
		source: deps._mutationSourceOverride ?? sourceForMutation(mutation),
		changedRange: singleRange(modifiedRanges),
		dbg,
		sessionId: deps.sessionId,
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
	if (!classifiedClientsReady || !entryLive) return;
	const dispatchOutcome = await bounded(
		dispatchPipelineAnalysis({
			deps,
			runtime,
			filePath,
			dispatchCwd,
			turnStateCwd,
			analysisRootMode,
			autofixMode,
			modifiedRanges,
			writeIndex,
			writeOrderTurn,
			initialStateHash,
			readGuardCorrelationId,
			requestedEditIndexes,
			requestedEditTotal,
			partialApply: deps._partialApply,
			participantIds,
			participantTotal,
			toolResultStart,
			nativeAppliedPairs,
			preserveNativeAuthorship: mutation.kind !== "write",
			allowAutonomousWriters: bashAuthorshipConfirmed,
			// #3512: one capture for the whole dispatch, the same one the
			// inline verdict below writes through.
			sessionGeneration: writeSession,
			ownFileTimeStamp: ownWriteStamp.stampFileTime,
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
	// #3596: the pipeline awaited. A replaced session's handler queues,
	// summarises and latches nothing in the live session; pi-lens' own writes
	// still reach the change log below, because they landed on disk.
	const resultLive = writeSession.guardedWrite(filePath, () => true) === true;

	// #4689 item 9: `deferMutation` refuses a root the session may not write
	// (an adopted project) and queues nothing, so no queue claim (the phase
	// row, the debug lines, `formatQueued`) is made for a root it refuses. One
	// predicate serves both blocks.
	const mayDefer = canWriteAnalysisRoot(analysisRootMode);
	let autofixNewlyQueued = false;
	if (
		resultLive &&
		!result.isError &&
		bashAuthorshipConfirmed &&
		mayDefer &&
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
				undefined,
				analysisRootMode,
			) ?? false;
		dbg(`tool_result: queued deferred autofix for ${filePath}`);
	}
	let formatQueued = false;

	if (
		resultLive &&
		!result.isError &&
		bashAuthorshipConfirmed &&
		mayDefer &&
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
			analysisRootMode,
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
			const identity = runtime.deferredFormatIdentity?.(filePath);
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
				...(identity === undefined
					? {}
					: {
							...(identity.ownerSessionId === undefined
								? {}
								: { ownerSessionId: identity.ownerSessionId }),
							turnIndex: identity.turnIndex,
							batchId: identity.batchId,
						}),
			});
		}
	}
	if (autofixNewlyQueued && !formatQueued) {
		const identity = runtime.deferredFormatIdentity?.(filePath);
		publishFormatQueued({
			filePath,
			cwd: dispatchCwd,
			// Same #2421 projection as the queued-with-format publish above.
			tool: mutation.kind,
			kinds: ["autofix"],
			...(identity === undefined
				? {}
				: {
						...(identity.ownerSessionId === undefined
							? {}
							: { ownerSessionId: identity.ownerSessionId }),
						turnIndex: identity.turnIndex,
						batchId: identity.batchId,
					}),
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
			analysisRootMode,
			filePath: resolvedChanged,
			source: "autofix",
			dbg,
			sessionId: deps.sessionId,
		});
		if (!resultLive) continue;
		// Workspace-edit paths come from fileURLToPath and are normally absolute,
		// so the turn-state cwd is inert for those values. Keep it in the resolve
		// call because the producer's contract is cwd-relative URI resolution, and
		// let pathsEqual ask the filesystem-aware path identity question (#3294).
		if (
			pathsEqual(
				path.resolve(turnStateCwd, changedFile),
				path.resolve(filePath),
			)
		)
			continue;
		try {
			const content = nodeFs.readFileSync(resolvedChanged, "utf-8");
			const lineCount = content.split("\n").length;
			const hasImports = /^import\s/m.test(content);
			cacheManager.addModifiedRange(
				resolvedChanged,
				{ start: 1, end: lineCount },
				hasImports,
				turnStateCwd,
				deps.sessionId ?? runtime.telemetrySessionId,
				"pi",
				undefined,
				analysisRootMode,
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
		runtime.appendCascadePromise(
			result.cascadePromise,
			writeSession,
			filePath,
			analysisRootMode,
		);
	}

	// #3568: per-turn maps the replacement's reset cleared.
	const { actionableWarnings, codeQualityWarnings } = result;
	if (actionableWarnings?.length) {
		// #3613: in the partition of the session whose turn this result is.
		writeSession.guardedWrite(filePath, () =>
			runtime.recordActionableWarnings(actionableWarnings, deps.sessionId),
		);
	}
	if (codeQualityWarnings?.length) {
		writeSession.guardedWrite(filePath, () =>
			runtime.recordCodeQualityWarnings(codeQualityWarnings, deps.sessionId),
		);
	}

	// #484: opt-in per-turn summary collection. Same signals the pipeline
	// already computed above (diagnostics, autofix count/tools, formatters
	// used) — no new collection plumbing, just fed into the collector when
	// the feature is on.
	recordTurnSummary({
		runtime,
		filePath,
		result,
		getFlag,
		resultLive,
		analysisRootMode,
	});

	publishInlineVerdict({
		runtime,
		cacheManager,
		filePath,
		result,
		writeSession,
		writeIndex,
		writeOrderTurn,
		authored: bashAuthorshipConfirmed,
		getFlag,
		turnStateCwd,
		analysisRootMode,
		sessionId: deps.sessionId,
	});
	if (result.withheldBlockerLine) {
		deps.withheldNotices?.push(result.withheldBlockerLine);
	}

	// #2050 AC3 / #2657: `linked-worktree` is a WRITABLE class
	// (`canWriteAnalysisRoot`), so the pipeline above ran the full set — format,
	// autofix, LSP touch/sync and dispatch. That makes it the one class whose
	// silence is ambiguous: the agent saw a real analysis and heard nothing,
	// which it cannot tell apart from "analysis never ran". Record one bounded
	// row per (mode, root) per session, and state it when the primary checked
	// the file and found nothing. Any delivery is its own statement. The
	// pipeline answers that (`checkedClean`, required); `output` cannot, because
	// the all-clear line also ends a run with only warnings or one no language
	// server answered, and an empty one is a format-only change (#4734 F1).
	// #3596: after the pipeline await, so a replaced session's handler records
	// nothing; its once-key would otherwise latch in the live session's ledger.
	if (resultLive && analysisRootMode === "linked-worktree") {
		const worktreeRoot = analysisRoot.root;
		if (worktreeRoot) {
			recordDegradationOnce({
				kind: "tool-result-linked-worktree",
				subject: worktreeRoot,
				reason: `analysed a linked worktree of this repository: ${worktreeRoot}`,
			});
			if (result.checkedClean) {
				const firstSilentRun = recordDegradationOnce({
					kind: "tool-result-linked-worktree-clean",
					subject: worktreeRoot,
					reason: `a linked-worktree edit produced no finding: ${filePath}`,
				});
				if (firstSilentRun) {
					queueAgentAdvisory(
						`pi-lens analysed the edit at ${filePath} in the linked worktree ${worktreeRoot} (full LSP, formatting, autofix and dispatch) and found nothing to report.`,
						advisoryScope,
					);
				}
			}
		}
	}

	if (result.isError) {
		return {
			content: [...event.content, { type: "text", text: result.output }],
			isError: true,
			structuredContent: event.structuredContent,
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
		// #3519: the attached bytes are "authoritative for subsequent edits",
		// so they are the agent's whole-file view: hashed from the attachment,
		// not from a disk another writer may have moved since the pipeline read
		// it. Only when delivered: without it the agent's view is its own write.
		if (attachAuthoritativeContent && !getFlag("no-read-guard")) {
			const evidence = deliveredLineEvidence(postMutation.content, 1);
			deps.readGuard?.recordRead(
				{
					filePath: postMutation.filePath,
					requestedOffset: 1,
					requestedLimit: evidence.lineCount,
					effectiveOffset: 1,
					effectiveLimit: evidence.lineCount,
					expandedByLsp: false,
					...(evidence.lineHashes && { lineHashes: evidence.lineHashes }),
					turnIndex: runtime.turnIndex,
					writeIndex: runtime.peekWriteIndex(),
					timestamp: Date.now(),
					source: "autofix-attachment",
				},
				{ stampFileTime: false },
			);
			logConversationRead(
				"autofix-attachment",
				postMutation.filePath,
				1,
				evidence,
			);
		}
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
		structuredContent: event.structuredContent,
	};
}
