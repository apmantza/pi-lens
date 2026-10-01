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
import { getProcessBridge, registerProcessBridge } from "./process-bridge.js";
import { recordDroppedRead } from "./session-scope.js";

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
				opts?: { branchEpoch?: number; stampFileTime?: boolean },
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
}

function isValidRange(value: unknown): value is [number, number] {
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
 * than enforcing a boundary.
 */
export function isValidMutationEntry(
	entry: unknown,
): entry is MutationBridgeEntry {
	if (typeof entry !== "object" || entry === null) return false;
	const e = entry as Record<string, unknown>;

	if (typeof e["filePath"] !== "string" || e["filePath"] === "") return false;

	const kind = e["kind"];
	if (kind !== "write" && kind !== "edit") return false;

	if (e["touchedLines"] !== undefined && !isValidRange(e["touchedLines"]))
		return false;

	const editRanges = e["editRanges"];
	if (editRanges !== undefined) {
		if (!Array.isArray(editRanges) || editRanges.length === 0) return false;
		if (!editRanges.every(isValidRange)) return false;
	}

	if (e["consumer"] !== undefined && typeof e["consumer"] !== "string")
		return false;

	if (
		e["importsChanged"] !== undefined &&
		typeof e["importsChanged"] !== "boolean"
	)
		return false;

	if (e["deferAutofix"] !== undefined && typeof e["deferAutofix"] !== "boolean")
		return false;

	// #2430: only the observational net's two values are accepted. An unknown
	// string is rejected rather than silently downgraded, so a producer that
	// invents a provenance learns about it instead of publishing a wrong one.
	const provenance = e["provenance"];
	if (
		provenance !== undefined &&
		provenance !== "observed" &&
		provenance !== "settled-sweep"
	)
		return false;

	return true;
}

/**
 * #3677: a foreign producer may pass the read guard's branch epoch it captured
 * before it awaited. Resolve it into the epoch the bridge forwards, and
 * whether it may queue a deferral at all.
 *
 * `stamp` reaches `ReadGuard.recordWritten`. A concrete epoch makes the guard
 * refuse to credit a write that landed on a different branch (#3521). A
 * well-formed epoch ABOVE the live guard's `currentBranchEpoch` is not this
 * guard's: `branchEpoch` only counts up, and a new `ReadGuard` restarts at 0
 * after `resetForSession` (#3521 review round 2 F1), so a capture from a dead
 * session lands here. It is still handed to the stamp so the guard fails
 * closed rather than crediting a dead session's write to the new one.
 *
 * `stamp` also reaches `RuntimeCoordinator.deferMutation` when a value at or
 * below the current epoch is queued. For one above it, `queueable` is false
 * and the bridge queues nothing (#3677 round 3, verify r2 V2): the
 * drain's own `recordWritten` credits a record at the epoch it carries, so
 * queuing at the current epoch credited the dead session's write one hop
 * later, and queuing at the captured epoch would let `Math.max` keep it over
 * a record the new session queued itself (#3677's false block).
 * `resetForSession` already drops every deferral the dead session queued.
 *
 * Only a value that is not an integer `>= 0` at all (NaN, a negative, a
 * fraction, a string, a null-proto object) is ignored for BOTH consumers, with
 * one bounded degradation record per session — the same fail-open-to-current
 * treatment a producer that omits the field gets. Recorded once per session:
 * the count is not the signal, the producer bug is.
 */
function resolveReadGuardBranchEpoch(
	value: unknown,
	currentEpoch: number,
): { stamp: number | undefined; queueable: boolean } {
	if (value === undefined) return { stamp: undefined, queueable: true };
	if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
		return { stamp: value, queueable: value <= currentEpoch };
	}
	recordDegradationOnce({
		kind: "mutation-bridge-invalid-branch-epoch",
		subject: "readGuardBranchEpoch",
		// #3677 review round 1 F3: `typeof`, never `String(value)` — a
		// null-proto object has no `toString`, and the throw dropped the whole
		// record (turn state, receipt, deferral) out of the bridge's try.
		reason: `ignored a foreign readGuardBranchEpoch (typeof ${typeof value}) (current ${currentEpoch})`,
	});
	return { stamp: undefined, queueable: true };
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

/**
 * The mutation-recording body, exported so tests drive it against a real
 * `RuntimeCoordinator` and `CacheManager` without mounting the global
 * singleton.
 */
export function recordMutationThroughSeam(
	entry: unknown,
	deps: MutationBridgeDeps,
): boolean {
	if (!isValidMutationEntry(entry)) {
		deps.dbg?.("mutation_bridge: dropped malformed entry");
		return false;
	}
	if (!deps.isRecordable(entry.filePath)) {
		deps.dbg?.(`mutation_bridge: out of scope ${entry.filePath}`);
		return false;
	}

	// #3598: an observed or bridged producer's write is an agent mutation a
	// running whole-package fixer must not erase. Read it before the bookkeeping.
	noteAgentMutation(entry.filePath);

	const classification = classifyBridgeMutation(entry);
	const filePath = entry.filePath;
	const runtime = deps.getRuntime();
	const projectRoot = deps.getProjectRoot();
	const dispatchCwd = deps.getDispatchCwd(filePath);

	try {
		// #3677: resolve the foreign epoch BEFORE either consumer sees it. The
		// stamp keeps a captured epoch fail-closed; the deferred queue only gets
		// a value the `Math.max` merge cannot poison.
		const resolvedEpoch = resolveReadGuardBranchEpoch(
			entry.readGuardBranchEpoch,
			runtime.readGuard.currentBranchEpoch,
		);
		const stampReadGuard = deps.shouldStampReadGuard?.() ?? true;
		// #3620/#3709: once the producer's scope has retired, the replay writes
		// none of the live session's state (the stamp, turn state and deferral
		// below); the receipt and the handled mark are disk facts and stay. The
		// epoch alone cannot refuse it: it restarts at 0 in every scope. No
		// lineage (every external producer): fail-open, as before.
		const lineage = entry.lineage;
		let sessionLive = true;
		if (
			lineage !== undefined &&
			lineage.guardedWrite(filePath, () => true) !== true
		) {
			sessionLive = false;
			// The write's own queue-time epoch is the entry's, when it has one.
			if (stampReadGuard)
				recordDroppedRead(
					lineage,
					entry.provenance ?? classification.toolName,
					entry.readGuardBranchEpoch ?? lineage.branchEpoch,
				);
		}
		// 1. Staleness stamp: the file changed under pi-lens, so a later edit is
		//    judged by read coverage rather than by this write. #2465: gated on
		//    `shouldStampReadGuard` (the `no-read-guard` flag) ALONE — the
		//    `isRecordable` check above already passed, so the write itself is
		//    still bookkept below whether or not the stamp fires.
		if (sessionLive && stampReadGuard) {
			runtime.readGuard.recordWritten?.(filePath, {
				...(resolvedEpoch.stamp !== undefined && {
					branchEpoch: resolvedEpoch.stamp,
				}),
				// #3525: settled-sweep drift is unattributed, and the agent never
				// saw it: authorship, not FileTime.
				...(entry.provenance === "settled-sweep" && { stampFileTime: false }),
			});
		}

		// 2. Turn state: this is the insert that leaves `turn-state.json` `files`
		//    non-empty for a mutation no `tool_result` described. `importsChanged`
		//    defaults to `false` (the historical, pre-#2450 behavior every
		//    existing producer that doesn't compute it still gets); a producer
		//    that DOES know the real value threads it through the entry instead
		//    of this seam silently understating it (#2450 review round 2, F1).
		const changedRange = resolveChangedRange(classification, deps, filePath);
		if (sessionLive)
			deps
				.getCacheManager()
				.addModifiedRange?.(
					filePath,
					changedRange,
					entry.importsChanged ?? false,
					projectRoot,
					runtime.telemetrySessionId,
				);

		// 3. Attributed change-log receipt. The source carries the producer's
		//    identity instead of collapsing onto `agent-edit`, so a report can
		//    tell an extension's rewrite apart from the model's own edit.
		runtime.recordProjectMutation?.({
			filePath,
			source: `agent-tool:${classification.toolName}`,
			cwd: projectRoot,
			changedRange,
			onAppendError: (err) =>
				deps.dbg?.(`mutation_bridge: change log append failed: ${err}`),
		});

		// #2430: this file is now accounted for this run, so the `agent_settled`
		// sweep re-baselines it instead of reporting the same bytes as drift no
		// tool call explains. Every in-process producer passes through here, so
		// this is the one place that has to say so.
		//
		// It sits OUTSIDE the `deferAutofix` guard below and must stay there
		// (#2465). "pi-lens accounted for this write" and "pi-lens will also
		// format this file later" are different questions: the LSP
		// mutation-bridge fallback passes `deferAutofix: false` precisely
		// because an LSP-applied edit is not this seam's to format, and it is
		// still a write pi-lens recorded. Move this inside the guard and every
		// such write is re-read by the settled sweep as unattributed drift.
		noteMutationHandled(filePath);

		// 4. Deferred autofix and format at `agent_settled` — never immediate.
		//    Skippable per entry (`deferAutofix: false`, #2450 review round 2 F3):
		//    the LSP mutation-bridge fallback (`clients/lsp-mutation.ts`) sets
		//    this because `bookkeepLspMutation`'s direct path never enqueues a
		//    deferred pass for an LSP-applied edit — the two branches must stay
		//    behaviorally equivalent for the same write. Every other producer
		//    (ast_grep_replace, a third-party extension) omits the field and
		//    keeps deferring, unchanged.
		//    #3677 round 3: nothing is queued for an epoch above the live one.
		if (
			sessionLive &&
			entry.deferAutofix !== false &&
			resolvedEpoch.queueable
		) {
			for (const kind of ["autofix", "format"] as const) {
				runtime.deferMutation?.(
					filePath,
					dispatchCwd,
					classification.toolName,
					projectRoot,
					kind,
					runtime.telemetrySessionId,
					projectRoot,
					// #3521: the settled sweep's epoch, so a record it queues after
					// a /tree is not credited to the new branch. #3677: a malformed
					// value is dropped (undefined), so the merge uses the current
					// epoch.
					resolvedEpoch.stamp,
				);
			}
		}
	} catch (err) {
		// Bookkeeping must never break a producer's own write path.
		deps.dbg?.(`mutation_bridge: recording failed for ${filePath}: ${err}`);
		return false;
	}
	return true;
}

/**
 * Mount the bridge singleton. Call once from inside the extension factory,
 * protected by the caller's module-level flag. Subsequent calls are no-ops
 * (first-wins, `clients/process-bridge.ts` owns the mount body — see that
 * module's header, #2437).
 */
export function registerMutationBridge(deps: MutationBridgeDeps): void {
	registerProcessBridge(MUTATION_BRIDGE_KEY, (): MutationBridge => ({
		version: 1 as const,
		recordMutation(entry: MutationBridgeEntry): boolean {
			return recordMutationThroughSeam(entry, deps);
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
