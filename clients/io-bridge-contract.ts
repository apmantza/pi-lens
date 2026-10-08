/**
 * The untyped half of the unified File I/O Lifecycle Bridge v2 (#3654).
 *
 * This module is a deliberate dependency leaf. It owns the mount key, the
 * version, the frozen public type surface, and the lookup helper — nothing
 * that could reach back into another `clients/` module. `clients/io-bridge.ts`
 * implements the bridge and `clients/process-bridge.ts` owns the first-wins
 * mount body. The frozen v1 shims never look the mount up: the read shim
 * calls the bridge body with the deps `index.ts` hands it, and the mutation
 * shim calls the bookkeeping owner (`clients/mutation-bridge.ts`) that the
 * bridge itself calls. Keeping the types here lets `clients/read-bridge.ts`
 * name them without importing the implementation.
 *
 * The type surface is RFC 3654 §3 verbatim plus one documented addition: the
 * `v1-compat` fields on `ReadFacet` / `MutationFacet`. D14 freezes the v1
 * shims' observable behavior, and the only way a shim can delegate to
 * `record()` while keeping that behavior is to express the v1 inputs it must
 * thread through (`touchedLines`, `provenance`, `readGuardBranchEpoch`,
 * `lineage`, a pinned read `source`). They are optional and no v2-native
 * caller needs them; see `docs/io-bridge-v2-migration.md`.
 */
import { getProcessBridge } from "./process-bridge.js";
import type { LineageHandle } from "./session-scope.js";

/** Stable Symbol key — identical across module reloads in the same process. */
export const IO_BRIDGE_SYMBOL: unique symbol = Symbol.for("pi-lens:io-bridge");

/**
 * Bridge API version. `version` covers minors; a breaking major mounts at a
 * new symbol key (the slot is first-wins frozen for the process lifetime).
 */
export const IO_BRIDGE_VERSION = 2 as const;

/** 1-indexed closed line interval: `[start, end]` where `start <= end`. */
export type LineRange = [start: number, end: number];

/** Map of 1-indexed line numbers to alphanumeric line-content hashes. */
export type LineHashMap = Record<number, string>;

export interface ReadFacet {
	/**
	 * 1-indexed line ranges delivered to the model. REQUIRED.
	 * `[]` represents an explicit zero-line / 0-byte read (#3652).
	 * A full-file read is represented by `[[1, lineCount]]`.
	 */
	ranges: LineRange[];

	/**
	 * Delivered raw text starting at `ranges[0][0]`.
	 * Valid ONLY when `ranges.length === 1` (a single contiguous span).
	 */
	content?: string;

	/**
	 * Precomputed alphanumeric line hashes keyed by absolute 1-indexed line
	 * numbers. Supports multi-span reads. Every key must fall within a declared
	 * range or the entry is `malformed`.
	 */
	lineHashes?: LineHashMap;

	/**
	 * Evidence collection mode:
	 * - `"caller"` (default): use `content` / `lineHashes` if provided. If
	 *   neither is provided, record coverage-only with NO hashes and NO disk
	 *   reads.
	 * - `"disk"`: the bridge synchronously disk-reads and hashes the declared
	 *   ranges.
	 */
	evidence?: "caller" | "disk";

	/**
	 * v1-compat: pin the `ReadRecord.source` provenance. The frozen v1 read
	 * shim passes `bridge:<consumer>`; v2-native callers omit it and get
	 * `io-bridge:<consumer>`.
	 */
	source?: string;
}

/** Fields shared by every mutation kind. */
interface MutationFacetBase {
	/**
	 * Whether to queue deferred autofix and formatting for `agent_settled`.
	 * Defaults to `true`, which also publishes `pilens:format:queued` on
	 * `pi.events` for newly-queued files (the v1 event drop, #3650).
	 * `false` suppresses both queueing and emission.
	 */
	deferAutofix?: boolean;

	/** Whether the mutation changed import/require statements. Defaults to `false`. */
	importsChanged?: boolean;

	/** v1-compat: explicit `[start, end]` the v1 mutation seam records. */
	touchedLines?: LineRange;

	/** v1-compat: producer provenance (#2430). */
	provenance?: "observed" | "settled-sweep";

	/** v1-compat: the branch epoch the producer captured before awaiting (#3677). */
	readGuardBranchEpoch?: number;

	/** v1-compat: the lineage handle captured before awaiting (#3620/#3709). */
	lineage?: LineageHandle;
}

export type MutationFacet =
	| ({
			kind: "edit";
			/** 1-indexed line ranges modified. Must be non-empty. */ ranges: LineRange[];
	  } & MutationFacetBase)
	| ({
			/**
			 * Whole-file authorship. The authored bytes are not part of the
			 * contract yet: creation read evidence from them is #3524's design
			 * (G9), and a field nothing consumes would freeze an unwired promise.
			 */
			kind: "write";
	  } & MutationFacetBase)
	| { kind: "delete" };

export interface BridgeEntry {
	/**
	 * Path to the file. Non-empty string, preserved verbatim. Scope runs on
	 * this raw string (`deps.isRecordable(filePath)`) with no pre-resolution;
	 * internal map keying stays with the read guard's own normalizers (F1).
	 */
	filePath: string;

	/** Optional caller identity for logging and telemetry, e.g. `"my-tool"`. */
	consumer?: string;

	/** Mutation facet (at most one). Mutually exclusive with `read` on `delete`. */
	mutate?: MutationFacet;

	/** Read facet (at most one). */
	read?: ReadFacet;
}

export type RecordReason =
	| "malformed"
	| "out-of-scope"
	| "ignored"
	| "no-read-guard"
	| "stale-lineage"
	| "bookkeeping-error";

export type RecordOutcome =
	| { accepted: true }
	| { accepted: false; reason: RecordReason };

export interface RecordResult {
	read?: RecordOutcome;
	mutate?: RecordOutcome;
}

export interface PiLensIOBridge {
	readonly version: 2;
	/**
	 * Synchronously records file I/O. Atomic: `mutate` executes strictly before
	 * `read`. Evaluates per-facet scope and `no-read-guard` gates and never
	 * throws.
	 */
	record(entry: BridgeEntry): RecordResult;
}

/**
 * The mounted bridge, or `undefined` when pi-lens has not registered one, a
 * differently-versioned bridge occupies the key, or the mount is missing
 * `record` (D11). A version mismatch means "unsupported", never "reset".
 */
export function getIOBridge(): PiLensIOBridge | undefined {
	const candidate = getProcessBridge<PiLensIOBridge>(IO_BRIDGE_SYMBOL, 2);
	return typeof candidate?.record === "function" ? candidate : undefined;
}
