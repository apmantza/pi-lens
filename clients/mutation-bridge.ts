/**
 * Generic mutation-recording bridge for pi-lens (#2423).
 *
 * ## Trust model — explicitly advisory
 *
 * Sibling of `clients/read-bridge.ts` and it inherits that module's trust
 * model verbatim: any code sharing this Node.js process already has full access
 * to pi-lens's internal state, so the bridge is not a security boundary. What
 * it provides is a stable API surface, one place for flag and scope checks, and
 * defensive validation that catches integration bugs early.
 *
 * ## What it is for
 *
 * `clients/mutating-tool.ts` classifies mutations pi-lens SEES as tool events.
 * A producer that writes a file some other way — a co-process extension with
 * its own registered tool, or pi-lens's own `ast_grep_replace` running
 * `--update-all` — is invisible to that path. It records the mutation here
 * instead, and the same downstream bookkeeping runs: read-guard staleness
 * stamp, turn-state modified ranges, an attributed change-log receipt, and a
 * DEFERRED autofix and format pass at `agent_settled`.
 *
 * Deferred, not immediate, is deliberate: a bulk rewrite usually touches many
 * files, and formatting each one as it lands fights the producer that is still
 * writing.
 *
 * Protocol (producer side)
 * ────────────────────────
 *
 *   const bridge = (globalThis as any)[Symbol.for("pi-lens:mutation-bridge")];
 *   bridge?.recordMutation({
 *     filePath,      // absolute path
 *     kind,          // "write" (whole file authored) or "edit" (part changed)
 *     touchedLines,  // optional [start, end], 1-based inclusive
 *     editRanges,    // optional [start, end][] for a scattered multi-range edit
 *     consumer,      // optional identifier, e.g. "my-extension"
 *   });
 *
 * Check `bridge.version` before calling. A bridge whose version you do not
 * recognize is unsupported. Calling before pi-lens is loaded, or when the guard
 * is disabled, is safe: the bridge is absent or the call is dropped.
 *
 * `recordMutation` returns `true` when pi-lens took the record and `false` when
 * it dropped it (malformed payload, out-of-scope path, or a bookkeeping error),
 * so a producer can count its own drops.
 *
 * Protocol (registration side, internal to pi-lens)
 * ──────────────────────────────────────────────────
 * `registerMutationBridge` is called once from the extension factory, next to
 * `registerReadBridge`, behind a module-level singleton guard so factory
 * re-activations do not mount a second bridge. Every dep is a GETTER resolved
 * at call time, so a replaced runtime or cache manager is picked up without
 * re-registration — the same live-getter discipline the read bridge uses.
 */
import { recordDegradationOnce } from "./degradation-ledger.js";
import {
	classifyBridgeMutation,
	type BridgeMutationEntry,
	type MutatingToolClassification,
} from "./mutating-tool.js";
import { noteAgentMutation } from "./fix-run-restore.js";
import { noteMutationHandled } from "./observed-mutation.js";
import type { ProjectChangeSource } from "./project-changes.js";
import {
	type BridgeActivation,
	getProcessBridge,
	rebindableProcessBridgeDeps,
	registerProcessBridge,
} from "./process-bridge.js";
import { recordDroppedRead } from "./session-scope.js";
import { publishFormatQueued } from "./format-events-publish.js";

/** Stable Symbol key — identical across module reloads in the same process. */
export const MUTATION_BRIDGE_KEY: unique symbol = Symbol.for(
	"pi-lens:mutation-bridge",
);

/** Payload a producer passes when recording a mutation. */
export type MutationBridgeEntry = BridgeMutationEntry;

/** The object mounted at `globalThis[MUTATION_BRIDGE_KEY]`. */
export interface MutationBridge {
	/**
	 * Bridge API version. Check this before calling `recordMutation` — if the
	 * version is not one you recognize, treat the bridge as unsupported.
	 */
	readonly version: 1;
	/** `true` when pi-lens recorded the mutation, `false` when it dropped it. */
	recordMutation(entry: MutationBridgeEntry): boolean;
}

/** The bookkeeping surfaces the bridge drives. Every one is optional-tolerant. */
export interface MutationBridgeDeps {
	onUnavailable?: () => void;
	getRuntime(): {
		turnIndex: number;
		telemetrySessionId?: string;
		/**
		 * The live read guard. Required: the real `RuntimeCoordinator` always
		 * exposes it (a lazily-built getter), and #3677's bound needs its
		 * `currentBranchEpoch` on every call.
		 */
		readGuard: {
			/** #3677: the live epoch a forwarded epoch is validated against. */
			currentBranchEpoch: number;
			recordWritten?: (
				filePath: string,
				opts?: {
					branchEpoch?: number;
					stampFileTime?: boolean;
					advanceAuthorship?: boolean;
					toolCallId?: string;
					authoredRanges?: Array<[number, number]>;
					authorship?: "partial" | "whole-file" | "unknown";
					allowFirstAuthorship?: boolean;
				},
			) => void;
		};
		recordProjectMutation?: (args: {
			filePath: string;
			source: ProjectChangeSource;
			cwd?: string;
			changedRange?: { start: number; end: number };
			onAppendError?: (err: unknown) => void;
		}) => unknown;
		deferMutation?: (
			filePath: string,
			cwd: string,
			toolName: string,
			turnStateCwd: string,
			kind: "autofix" | "format",
			ownerSessionId?: string,
			originCwd?: string,
			readGuardBranchEpoch?: number,
		) => boolean;
	};
	getCacheManager(): {
		addModifiedRange?: (
			filePath: string,
			range: { start: number; end: number },
			importsChanged: boolean,
			cwd: string,
			sessionId?: string | null,
		) => unknown;
	};
	/** Workspace root used for turn-state and change-log bookkeeping. */
	getProjectRoot(): string;
	/** Formatter/language root for this file — the deferred pass's cwd. */
	getDispatchCwd(filePath: string): string;
	/** Line count used when a `write` records no explicit range. */
	countFileLines(filePath: string): number;
	/**
	 * Return `true` when the entry should be recorded. Called on EVERY
	 * `recordMutation` invocation so flag and project-root changes take effect
	 * immediately without re-registration.
	 *
	 * Path-scope ONLY (ignored/vendor/#project-root) — deliberately does not
	 * consult `no-read-guard` (#2465). That flag decides whether the
	 * read-guard staleness stamp fires (`shouldStampReadGuard` below), not
	 * whether the write happened at all; folding it in here used to drop
	 * turn-state and the change-log receipt along with the stamp, the same
	 * conflation `clients/runtime-tool-result.ts` avoids by gating
	 * `readGuard.recordWritten` alone.
	 */
	isRecordable(filePath: string): boolean;
	/**
	 * Whether the read-guard staleness stamp (`runtime.readGuard.recordWritten`)
	 * should fire for this call. Optional — omitted (e.g. in tests that don't
	 * care) defaults to `true`, preserving the stamp-always behavior every
	 * existing caller had before #2465. `no-read-guard` is the ONLY thing that
	 * should make this `false`; it must never also affect `isRecordable`
	 * above, or turn-state/the receipt silently drop with it.
	 */
	shouldStampReadGuard?(): boolean;
	dbg?: (msg: string) => void;
	/** Test seam for the deferred-format event; defaults to the real publisher. */
	publishFormatQueued?: typeof publishFormatQueued;
}

/**
 * A 1-indexed closed `[start, end]` line range. The one range check both
 * bridges use: this module's v1 entries and `clients/io-bridge.ts`'s v2
 * facets (#3654).
 */
export function isValidRange(value: unknown): value is [number, number] {
	if (!Array.isArray(value) || value.length !== 2) return false;
	const [start, end] = value;
	return (
		typeof start === "number" &&
		typeof end === "number" &&
		Number.isInteger(start) &&
		Number.isInteger(end) &&
		start >= 1 &&
		end >= start
	);
}

/**
 * Validate a raw entry from an untrusted caller. Deliberately lightweight, for
 * the same reason `read-bridge.ts` gives: this is an advisory protocol between
 * same-process extensions, so the goal is catching typos and bad numbers rather
 * than enforcing a boundary. Returns the first problem, or `undefined` when the
 * entry is valid. This is the one mutation-entry validator: the v2 bridge
 * translates its facet into this shape and reports the same detail (#3654).
 */
function mutationEntryProblem(entry: unknown): string | undefined {
	if (typeof entry !== "object" || entry === null)
		return "entry must be an object";
	const e = entry as Record<string, unknown>;

	if (typeof e["filePath"] !== "string" || e["filePath"] === "")
		return "filePath must be a non-empty string";

	const kind = e["kind"];
	if (kind !== "write" && kind !== "edit")
		return 'kind must be "edit" or "write"';

	if (e["touchedLines"] !== undefined && !isValidRange(e["touchedLines"]))
		return "touchedLines must be 1-indexed [start, end]";

	const editRanges = e["editRanges"];
	if (editRanges !== undefined) {
		if (!Array.isArray(editRanges) || editRanges.length === 0)
			return "edit ranges must be a non-empty array";
		if (!editRanges.every(isValidRange))
			return "edit ranges must be 1-indexed [start, end] with start <= end";
	}

	if (e["consumer"] !== undefined && typeof e["consumer"] !== "string")
		return "consumer must be a string";

	if (
		e["importsChanged"] !== undefined &&
		typeof e["importsChanged"] !== "boolean"
	)
		return "importsChanged must be a boolean";

	if (e["deferAutofix"] !== undefined && typeof e["deferAutofix"] !== "boolean")
		return "deferAutofix must be a boolean";

	// #2430: only the observational net's two values are accepted. An unknown
	// string is rejected rather than silently downgraded, so a producer that
	// invents a provenance learns about it instead of publishing a wrong one.
	const provenance = e["provenance"];
	if (
		provenance !== undefined &&
		provenance !== "observed" &&
		provenance !== "settled-sweep"
	)
		return 'provenance must be "observed" or "settled-sweep"';

	// #4187 R4-1: the call id licenses an authorship advance, so a producer that
	// invents a non-string one must be told rather than silently downgraded to
	// "no call" (which would end an authorship the call did license).
	if (e["toolCallId"] !== undefined && typeof e["toolCallId"] !== "string")
		return "toolCallId must be a string";

	return undefined;
}

export function isValidMutationEntry(
	entry: unknown,
): entry is MutationBridgeEntry {
	return mutationEntryProblem(entry) === undefined;
}

/**
 * #3677: a foreign producer may pass the read guard's branch epoch it captured
 * before it awaited. Resolve it into the epoch the bridge forwards to both
 * consumers: `ReadGuard.recordWritten` (a concrete epoch makes the guard
 * refuse to credit a write that landed on a different branch, #3521) and
 * `RuntimeCoordinator.deferMutation`, whose `Math.max` merge a foreign value
 * must never reach (#3677's poison).
 *
 * Only an integer from 0 to the live guard's `currentBranchEpoch` is a
 * capture this scope can hold: `branchEpoch` only counts up within a scope.
 * Anything else is ignored for BOTH consumers, with one bounded degradation
 * record per session, the same fail-open-to-current treatment a producer that
 * omits the field gets. That includes a well-formed epoch ABOVE the live one
 * (#3763 item 5). #3677 round 3 read such a value as a dead session's capture
 * (a new `ReadGuard` restarts at 0 after `resetForSession`) and skipped the
 * stamp and the deferral, silently under `no-read-guard`. Session currency is
 * the entry's lineage since S3 (#3759): the one in-process producer that
 * sends an epoch, the settled sweep, sends the lineage it captured with it,
 * and the fence in {@link recordMutationThroughSeam} drops a dead session's
 * replay before this runs. A producer without a lineage cannot learn an epoch
 * at all (the bridge exposes none), so a value above the live one is
 * invented. Recorded once per session: the count is not the signal, the
 * producer bug is.
 */
function resolveReadGuardBranchEpoch(
	value: unknown,
	currentEpoch: number,
): number | undefined {
	if (value === undefined) return undefined;
	const wellFormed =
		typeof value === "number" && Number.isInteger(value) && value >= 0;
	if (wellFormed && value <= currentEpoch) return value;
	recordDegradationOnce({
		kind: "mutation-bridge-invalid-branch-epoch",
		subject: "readGuardBranchEpoch",
		// #3677 review round 1 F3: `typeof`, never `String(value)` — a
		// null-proto object has no `toString`, and the throw dropped the whole
		// record (turn state, receipt, deferral) out of the bridge's try.
		reason: wellFormed
			? `ignored a readGuardBranchEpoch above the live epoch (${value} > ${currentEpoch})`
			: `ignored a foreign readGuardBranchEpoch (typeof ${typeof value}) (current ${currentEpoch})`,
	});
	return undefined;
}

/**
 * The one range the change log records for this mutation. A multi-range edit
 * records its bounding box, matching how `runtime-tool-result.ts` collapses a
 * multi-hunk diff (`singleRange`) — the change log carries one range per entry.
 */
function resolveChangedRange(
	classification: MutatingToolClassification,
	deps: MutationBridgeDeps,
	filePath: string,
): { start: number; end: number } {
	if (classification.touchedLines) {
		const [start, end] = classification.touchedLines;
		return { start, end };
	}
	if (classification.editRanges && classification.editRanges.length > 0) {
		const starts = classification.editRanges.map(([start]) => start);
		const ends = classification.editRanges.map(([, end]) => end);
		return { start: Math.min(...starts), end: Math.max(...ends) };
	}
	// No range stated. A write replaced the whole file, and an edit whose ranges
	// the producer could not name is treated the same way: the safe
	// over-approximation is the entire file, never an empty set.
	return { start: 1, end: Math.max(1, deps.countFileLines(filePath)) };
}

function resolveAuthorshipRanges(
	classification: MutatingToolClassification,
): Array<[number, number]> | undefined {
	if (classification.authorshipUnknown === true) return undefined;
	if (classification.editRanges && classification.editRanges.length > 0)
		return classification.editRanges;
	if (classification.touchedLines) return [classification.touchedLines];
	return undefined;
}

/** Why a mutation record was not credited to live session state (#3654). */
export type MutationRecordReason =
	| "malformed"
	| "out-of-scope"
	| "stale-lineage"
	| "bookkeeping-error";

/** The full answer {@link recordMutationOutcome} gives (#3654). */
export interface MutationRecordOutcome {
	/** v1 `recordMutation()`'s boolean: the receipt/bookkeeping was taken. */
	recorded: boolean;
	/**
	 * v2 live-state acceptance. False only for a drop, or for a retired lineage
	 * when the caller asked to reject one (`rejectStaleLineage`).
	 */
	accepted: boolean;
	/** Present when `accepted` is false. */
	reason?: MutationRecordReason;
	/** The validator's problem (or the out-of-scope path) for a drop. */
	detail?: string;
	/**
	 * Deferred kinds this call newly enqueued (a same-kind re-touch is silent),
	 * the exact population published as `pilens:format:queued` on `pi.events`.
	 */
	queued: ReadonlyArray<"autofix" | "format">;
}

/** The two drop answers that carry no bookkeeping. */
function rejectedOutcome(
	reason: "malformed" | "out-of-scope",
	detail: string,
): MutationRecordOutcome {
	return { recorded: false, accepted: false, reason, detail, queued: [] };
}

/** Everything the bookkeeping stages share once an entry is admitted. */
interface MutationBookkeepingContext {
	entry: MutationBridgeEntry;
	classification: ReturnType<typeof classifyBridgeMutation>;
	deps: MutationBridgeDeps;
	runtime: ReturnType<MutationBridgeDeps["getRuntime"]>;
	filePath: string;
	projectRoot: string;
	dispatchCwd: string;
}

/**
 * The live-state decision plus the read-guard staleness stamp (#3620/#3709,
 * #2465, #3525). Returns whether the producer's session is still live and the
 * resolved branch epoch the deferred queue should carry (#3677).
 */
function stampLiveMutation(
	ctx: MutationBookkeepingContext,
	stampReadGuard: boolean,
): { sessionLive: boolean; stamp: number | undefined } {
	const { entry, classification, runtime, filePath } = ctx;
	const lineage = entry.lineage;
	let sessionLive = true;
	if (
		lineage !== undefined &&
		lineage.guardedWrite(filePath, () => true) !== true
	) {
		sessionLive = false;
		// The write's own queue-time epoch is the entry's, when it has one.
		if (stampReadGuard) {
			recordDroppedRead(
				lineage,
				entry.provenance ?? classification.toolName,
				entry.readGuardBranchEpoch ?? lineage.branchEpoch,
			);
		}
	}
	// #3677: resolve the foreign epoch BEFORE either consumer sees it, so the
	// `Math.max` merge of the deferred queue never gets a value this scope
	// cannot hold. A dead session's replay was dropped above, unresolved.
	const stamp = sessionLive
		? resolveReadGuardBranchEpoch(
				entry.readGuardBranchEpoch,
				runtime.readGuard.currentBranchEpoch,
			)
		: undefined;
	// 1. Staleness stamp: the file changed under pi-lens, so a later edit is
	//    judged by read coverage rather than by this write.
	if (sessionLive && stampReadGuard) {
		const authoredRanges = resolveAuthorshipRanges(classification);
		runtime.readGuard.recordWritten?.(filePath, {
			...(stamp !== undefined && { branchEpoch: stamp }),
			// A process bridge reports a mutation, not the bytes delivered to the
			// conversation. Credit authorship, but leave FileTime at its last
			// conversation-backed observation (#3865).
			stampFileTime: false,
			// Nor may it re-baseline an existing authorship over bytes it wrote
			// around (#4131, #4187 R2-4): only the observed replay had a
			// pre-write check, its tool_call's retire. The rest (a co-process
			// producer, ast_grep_replace or an LSP edit) may create a first
			// authorship; settled-sweep drift never does (#4210).
			advanceAuthorship: entry.provenance === "observed",
			// A first bridge credit is limited to the producer's reported range;
			// settled-sweep drift has no producer evidence and may not create one.
			...(authoredRanges !== undefined && { authoredRanges }),
			authorship:
				authoredRanges !== undefined
					? "partial"
					: entry.kind === "write"
						? "whole-file"
						: "unknown",
			allowFirstAuthorship: entry.provenance !== "settled-sweep",
			// #4187 R4-1: and an observed replay advances only a path its OWN
			// call licensed at tool_call (`ReadGuard.noteCheckedPaths`), since a
			// tool writes a set wider than the one it named. An entry with no
			// call (a co-process producer, a server-initiated edit) names none.
			...(entry.toolCallId !== undefined && { toolCallId: entry.toolCallId }),
		});
	}
	return { sessionLive, stamp };
}

/** Turn state (2) and the attributed change-log receipt (3), then the handled mark. */
function applyTurnAndChangeLog(
	ctx: MutationBookkeepingContext,
	sessionLive: boolean,
): void {
	const { entry, classification, deps, runtime, filePath, projectRoot } = ctx;
	const changedRange = resolveChangedRange(classification, deps, filePath);
	if (sessionLive) {
		deps
			.getCacheManager()
			.addModifiedRange?.(
				filePath,
				changedRange,
				entry.importsChanged ?? false,
				projectRoot,
				entry.sessionId ?? runtime.telemetrySessionId,
			);
	}
	runtime.recordProjectMutation?.({
		filePath,
		source: `agent-tool:${classification.toolName}`,
		cwd: projectRoot,
		changedRange,
		onAppendError: (err) =>
			deps.dbg?.(`mutation_bridge: change log append failed: ${err}`),
	});
	// #2430: this file is now accounted for this run, so the `agent_settled`
	// sweep re-baselines it instead of reporting the same bytes as drift no tool
	// call explains. It sits OUTSIDE the `deferAutofix` guard below and must stay
	// there (#2465): "pi-lens accounted for this write" and "pi-lens will also
	// format this file later" are different questions.
	noteMutationHandled(filePath);
}

/**
 * 4. Deferred autofix and format at `agent_settled` — never immediate. Pushes
 * into the caller's array so a throw mid-loop keeps the kinds already queued.
 */
function queueDeferredMutation(
	ctx: MutationBookkeepingContext,
	sessionLive: boolean,
	stamp: number | undefined,
	queued: Array<"autofix" | "format">,
): void {
	const { entry, classification, runtime, filePath, projectRoot, dispatchCwd } =
		ctx;
	if (!sessionLive || entry.deferAutofix === false) return;
	for (const kind of ["autofix", "format"] as const) {
		const landed = runtime.deferMutation?.(
			filePath,
			dispatchCwd,
			classification.toolName,
			projectRoot,
			kind,
			runtime.telemetrySessionId,
			projectRoot,
			// #3521: the settled sweep's epoch, so a record it queues after
			// a /tree is not credited to the new branch. #3677: a value this
			// scope cannot hold is dropped (undefined), so the merge uses the
			// current epoch.
			stamp,
		);
		if (landed) queued.push(kind);
	}
}

/** The stages inside the producer's try: stamp, turn state, change log, deferral. */
function runMutationBookkeeping(
	ctx: MutationBookkeepingContext,
	queued: Array<"autofix" | "format">,
): boolean {
	const stampReadGuard = ctx.deps.shouldStampReadGuard?.() ?? true;
	const { sessionLive, stamp } = stampLiveMutation(ctx, stampReadGuard);
	applyTurnAndChangeLog(ctx, sessionLive);
	queueDeferredMutation(ctx, sessionLive, stamp, queued);
	return sessionLive;
}

/**
 * The mutation-recording body, exported so tests drive it against a real
 * `RuntimeCoordinator` and `CacheManager` without mounting the global
 * singleton.
 *
 * Returns the richer outcome (#3654) the unified bridge needs: the v1 boolean
 * the frozen shim still returns, the v2 live-state acceptance, and the kinds
 * this call newly enqueued for the deferred pass.
 *
 * `rejectStaleLineage` is the one behavioral knob. A retired lineage still
 * runs the same bookkeeping (receipt, handled mark, deferral skip) either way;
 * v2 reports it as `accepted:false, reason:"stale-lineage"` while the frozen
 * v1 shim keeps the historical `recorded:true` it has always returned.
 */
export function recordMutationOutcome(
	entry: unknown,
	deps: MutationBridgeDeps,
	opts?: { rejectStaleLineage?: boolean },
): MutationRecordOutcome {
	const problem = mutationEntryProblem(entry);
	if (problem !== undefined) {
		deps.dbg?.(`mutation_bridge: dropped malformed entry: ${problem}`);
		return rejectedOutcome("malformed", problem);
	}
	const valid = entry as MutationBridgeEntry;
	if (!deps.isRecordable(valid.filePath)) {
		deps.dbg?.(`mutation_bridge: out of scope ${valid.filePath}`);
		return rejectedOutcome("out-of-scope", valid.filePath);
	}
	const outcome = runAdmittedMutation(valid, deps, opts);
	if (outcome.queued.length > 0) publishQueued(valid, deps, outcome.queued);
	return outcome;
}

/**
 * #3654: announce the files this call newly queued for the deferred pass
 * (`pilens:format:queued`, the v1 event drop #3650), for every producer:
 * the v1 shim and the v2 bridge both reach this one body. Fire-and-forget.
 */
function publishQueued(
	entry: MutationBridgeEntry,
	deps: MutationBridgeDeps,
	queued: ReadonlyArray<"autofix" | "format">,
): void {
	const publish = deps.publishFormatQueued ?? publishFormatQueued;
	try {
		publish({
			filePath: entry.filePath,
			cwd: deps.getDispatchCwd(entry.filePath),
			tool: entry.kind,
			kinds: [...queued],
			...(deps.dbg !== undefined && { dbg: deps.dbg }),
		});
	} catch (err) {
		deps.dbg?.(
			`mutation_bridge: format-queued publish failed for ${entry.filePath}: ${err}`,
		);
	}
}

/** The bookkeeping for a valid, in-scope entry. */
function runAdmittedMutation(
	entry: MutationBridgeEntry,
	deps: MutationBridgeDeps,
	opts: { rejectStaleLineage?: boolean } | undefined,
): MutationRecordOutcome {
	// #3598: an observed or bridged producer's write is an agent mutation a
	// running whole-package fixer must not erase. Read it before the bookkeeping.
	noteAgentMutation(entry.filePath);

	const ctx: MutationBookkeepingContext = {
		entry,
		classification: classifyBridgeMutation(entry),
		deps,
		runtime: deps.getRuntime(),
		filePath: entry.filePath,
		projectRoot: deps.getProjectRoot(),
		dispatchCwd: deps.getDispatchCwd(entry.filePath),
	};
	const queued: Array<"autofix" | "format"> = [];
	let sessionLive = true;
	try {
		sessionLive = runMutationBookkeeping(ctx, queued);
	} catch (err) {
		// Bookkeeping must never break a producer's own write path.
		deps.dbg?.(`mutation_bridge: recording failed for ${ctx.filePath}: ${err}`);
		return {
			recorded: false,
			accepted: false,
			reason: "bookkeeping-error",
			detail: `${err}`,
			queued,
		};
	}
	const accepted = sessionLive || opts?.rejectStaleLineage !== true;
	return accepted
		? { recorded: true, accepted: true, queued }
		: { recorded: true, accepted: false, reason: "stale-lineage", queued };
}

/**
 * The v1 `recordMutation()` boolean answer, over the same one body. A v1
 * caller sees only that boolean, so an out-of-scope drop is recorded here,
 * once per producer, with the path (#4140); the v2 io-bridge records its own
 * `io-bridge-mutate-dropped` for the same outcome and must not get a second
 * row (#4185 round 1, F5).
 */
export function recordMutationThroughSeam(
	entry: unknown,
	deps: MutationBridgeDeps,
): boolean {
	const outcome = recordMutationOutcome(entry, deps);
	if (outcome.reason === "out-of-scope") {
		// The entry's producer name, read the way the validator above reads it.
		const producer = (entry as Record<string, unknown> | null)?.["consumer"];
		recordDegradationOnce({
			kind: "mutation-bridge-out-of-scope",
			subject: `${typeof producer === "string" ? producer : "unknown"}:out-of-scope`,
			reason: `${outcome.detail ?? "<unknown path>"}: the producer's path is outside the project or unresolvable; bridge bookkeeping was not admitted`,
		});
	}
	return outcome.recorded;
}

/**
 * Identity for a direct registration that does not name the activation its
 * deps were built for (unit tests). A real activation passes the live
 * `RuntimeCoordinator` (`deps.getRuntime()`), so a fresh module graph rebinds
 * the shared deps cell (`rebindableProcessBridgeDeps`, #4169).
 */
const DEFAULT_ACTIVATION = Symbol("pi-lens:mutation-bridge-activation");

/**
 * Mount the bridge singleton. Call once from inside the extension factory,
 * protected by the caller's module-level flag. Subsequent calls are no-ops
 * (first-wins, `clients/process-bridge.ts` owns the mount body — see that
 * module's header, #2437).
 *
 * `activation` is the identity the `deps` were built for. A call carrying a
 * new one rebinds the shared deps cell, so a `/reload` that re-evaluates the
 * module graph keeps the mounted bridge pointed at the live runtime (#4169).
 */
export function registerMutationBridge(
	deps: MutationBridgeDeps,
	activation: BridgeActivation = DEFAULT_ACTIVATION,
): void {
	const currentDeps = rebindableProcessBridgeDeps(
		"mutation-bridge-deps",
		1,
		activation,
		deps,
	);
	registerProcessBridge(MUTATION_BRIDGE_KEY, (): MutationBridge => ({
		version: 1 as const,
		recordMutation(entry: MutationBridgeEntry): boolean {
			// #3654: the v1 shim calls the one bookkeeping body the v2 bridge
			// also calls, so it gains the `pilens:format:queued` publish with no
			// translation through v2. A retired lineage keeps the v1 answer
			// (`true`: the receipt was taken).
			const liveDeps = currentDeps();
			if (!liveDeps) {
				deps.onUnavailable?.();
				return false;
			}
			return recordMutationThroughSeam(entry, liveDeps);
		},
	}));
}

/**
 * The mounted bridge, or `undefined` when pi-lens has not registered one (or
 * a differently-versioned bridge is mounted, or the mounted value is missing
 * `recordMutation`).
 *
 * In-repo producers use this instead of reaching for `globalThis` themselves,
 * so there is one spelling of the key and one version check.
 */
export function getMutationBridge(): MutationBridge | undefined {
	const candidate = getProcessBridge<MutationBridge>(MUTATION_BRIDGE_KEY, 1);
	return typeof candidate?.recordMutation === "function"
		? candidate
		: undefined;
}
