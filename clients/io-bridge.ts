/**
 * Unified File I/O Lifecycle Bridge v2 (#3654).
 *
 * One synchronous, non-throwing `record(entry)` covers file observation
 * (`read`), partial modification (`edit`), whole-file authorship (`write`),
 * and deletion (`delete`). A compound `{ mutate, read }` call is atomic: the
 * mutation facet runs strictly before the read facet, so a producer that
 * already wrote the bytes and then previews them never desynchronizes the
 * read guard's staleness stamp.
 *
 * The frozen v1 shims keep their v1 return types and keys (D14) over the same
 * bodies: the read shim (`clients/read-bridge.ts`) translates its entry and
 * calls {@link recordIOEntry} (index.ts hands it the same deps this mount
 * gets), and the mutation shim calls the bookkeeping owner directly.
 *
 * Ownership: the mutation bookkeeping rule, its validator and the
 * `pilens:format:queued` publish stay in `clients/mutation-bridge.ts`
 * (`recordMutationOutcome`); this module translates the facet into that
 * entry and never re-derives it. The read path uses the read guard's own
 * content-binding and in-memory-hash seams, and the delete path asks
 * `clients/confirmed-delete.ts`, the verdict the native bash path also uses.
 *
 * Drops are returned synchronously as `RecordOutcome` AND recorded in the
 * degradation ledger as `io-bridge-read-dropped` / `io-bridge-mutate-dropped`
 * with subject `"${caller}:${reason}"`, so a monitor can join the log row to
 * the caller's own count (F5).
 */
import { judgeConfirmedDelete } from "./confirmed-delete.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import {
	IO_BRIDGE_SYMBOL,
	IO_BRIDGE_VERSION,
	type BridgeEntry,
	type LineHashMap,
	type LineRange,
	type PiLensIOBridge,
	type ReadFacet,
	type RecordOutcome,
	type RecordReason,
	type RecordResult,
} from "./io-bridge-contract.js";
import {
	isValidRange,
	recordMutationOutcome,
	type MutationBridgeDeps,
} from "./mutation-bridge.js";
import {
	captureReadContentBinding,
	deliveredLineEvidence,
	type ReadContentBinding,
	type ReadRecord,
} from "./read-guard.js";
import {
	type BridgeActivation,
	rebindableProcessBridgeDeps,
	registerProcessBridge,
} from "./process-bridge.js";

export {
	IO_BRIDGE_SYMBOL,
	IO_BRIDGE_VERSION,
	type BridgeEntry,
	type RecordOutcome,
	type RecordReason,
};

export { getIOBridge } from "./io-bridge-contract.js";

/** The read-guard surface the bridge drives. */
export interface ReadGuardBridgeSurface {
	recordRead(
		record: ReadRecord,
		opts?: { captureLineHashes?: boolean; stampFileTime?: boolean },
	): void;
	forgetPath(filePath: string): void;
	hasKnownPath(filePath: string): boolean;
}

/** The bookkeeping surfaces the bridge drives, on top of the mutation bridge's. */
export interface IOBridgeDeps extends MutationBridgeDeps {
	/** The live read guard; resolved at call time. */
	getReadGuard(): ReadGuardBridgeSurface;
	/** The agent-turn index for a recorded read. */
	getTurnIndex(): number;
	/** The agent-write index at record time. */
	peekWriteIndex(): number;
	/**
	 * The live lens flag getter (`no-read-guard`, `no-lsp`). `bridge` names the
	 * owning bridge for the stale-ctx diagnostic ("<bridge>-bridge"). The v1
	 * read shim runs its own recordability gate before delegating (D14: it must
	 * keep the `"read-bridge"` subject and the near-match stale rethrow), so
	 * the read facet attributes its duplicate read `"read"` and the ledger's
	 * `kind\0subject` once-key collapses the two into one row. Omitted means
	 * the native v2 surface (`"io-bridge"`).
	 */
	getFlag(
		name: string,
		bridge?: "read" | "mutation" | "io",
	): boolean | string | undefined;
	/** Delete gate 1 (`clients/confirmed-delete.ts`). */
	isExternalOrVendorFile(filePath: string): boolean;
	/** Delete gate 2 (`clients/confirmed-delete.ts`). */
	isPathIgnoredByProject(filePath: string): boolean;
	/** After a confirmed delete: tell LSP clients the watched file is gone (type 3). */
	notifyExternalFileChange(
		filePath: string,
		type: number,
	): void | Promise<void>;
	/** The filesystem probes the bridge performs itself. */
	nodeFs: {
		existsSync(filePath: string): boolean;
		statSync(filePath: string): { size: number };
	};
}

/**
 * Identity for a direct registration that does not name the activation its
 * deps were built for (unit tests). A real activation passes the live
 * `RuntimeCoordinator` (`deps.getRuntime()`), so a fresh module graph rebinds
 * the shared deps cell (`rebindableProcessBridgeDeps`, #4169).
 */
const DEFAULT_ACTIVATION = Symbol("pi-lens:io-bridge-activation");

/** Mount the bridge singleton. First-wins, `clients/process-bridge.ts` owns the body. */
export function registerIOBridge(
	deps: IOBridgeDeps,
	activation: BridgeActivation = DEFAULT_ACTIVATION,
): void {
	const currentDeps = rebindableProcessBridgeDeps(
		"io-bridge-deps",
		1,
		activation,
		deps,
	);
	registerProcessBridge(IO_BRIDGE_SYMBOL, (): PiLensIOBridge => ({
		version: IO_BRIDGE_VERSION,
		record(entry: BridgeEntry): RecordResult {
			const liveDeps = currentDeps();
			if (!liveDeps) {
				deps.onUnavailable?.();
				return {
					read: { accepted: false, reason: "unavailable" },
					mutate: { accepted: false, reason: "unavailable" },
				};
			}
			return recordIOEntry(entry, liveDeps);
		},
	}));
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Whether the raw entry carries a facet. A facet set to `undefined` is absent;
 * any other value (including a non-object) is present so it reaches its own
 * validation and reports `malformed` rather than being silently ignored.
 */
function hasFacet(
	raw: Record<string, unknown>,
	key: "read" | "mutate",
): boolean {
	return raw[key] !== undefined;
}

function readConsumer(raw: Record<string, unknown>): string {
	const caller = raw["consumer"];
	return typeof caller === "string" && caller !== "" ? caller : "unknown";
}

/** `ranges` must be an array of 1-indexed `[start, end]` pairs. */
function readRangesProblem(ranges: unknown): string | undefined {
	if (!Array.isArray(ranges)) return "ranges must be an array";
	if (!ranges.every(isValidRange)) {
		return "ranges must be 1-indexed [start, end] with start <= end";
	}
	return undefined;
}

function readEvidenceProblem(evidence: unknown): string | undefined {
	if (evidence === undefined || evidence === "caller" || evidence === "disk") {
		return undefined;
	}
	return 'evidence must be "caller" or "disk"';
}

/** `content` is a string, and only a single range (or the explicit empty one) may carry it. */
function readContentProblem(
	content: unknown,
	declared: LineRange[],
): string | undefined {
	if (content === undefined) return undefined;
	if (typeof content !== "string") return "content must be a string";
	const singleRange = declared.length === 1;
	const explicitEmpty = declared.length === 0 && content === "";
	if (!singleRange && !explicitEmpty) {
		return "content is valid only with a single range";
	}
	return undefined;
}

function readSourceProblem(source: unknown): string | undefined {
	if (source === undefined || typeof source === "string") return undefined;
	return "source must be a string";
}

/** Every `lineHashes` key must be an integer line inside a declared range. */
function readLineHashesProblem(
	lineHashes: unknown,
	declared: LineRange[],
): string | undefined {
	if (lineHashes === undefined) return undefined;
	if (!isRecordObject(lineHashes) || Array.isArray(lineHashes)) {
		return "lineHashes must be an object keyed by line number";
	}
	for (const [key, value] of Object.entries(lineHashes)) {
		const line = Number(key);
		if (!Number.isInteger(line) || line < 1 || typeof value !== "string") {
			return `lineHashes[${key}] must map an integer line to a string hash`;
		}
		if (!declared.some(([start, end]) => line >= start && line <= end)) {
			return `lineHashes key ${key} falls outside every declared range`;
		}
	}
	return undefined;
}

/**
 * A read-facet problem string, or `undefined` when valid. `ranges` is required;
 * `[]` is the explicit zero-line read. `content` is valid only with a single
 * range. Every `lineHashes` key must fall inside a declared range.
 */
function readFacetProblem(read: unknown): string | undefined {
	if (!isRecordObject(read)) return "read facet must be an object";
	const ranges = read["ranges"];
	const rangesProblem = readRangesProblem(ranges);
	if (rangesProblem !== undefined) return rangesProblem;
	const declared = ranges as LineRange[];
	return (
		readEvidenceProblem(read["evidence"]) ??
		readContentProblem(read["content"], declared) ??
		readSourceProblem(read["source"]) ??
		readLineHashesProblem(read["lineHashes"], declared)
	);
}

function drop(
	facet: "read" | "mutate",
	caller: string,
	reason: RecordReason,
	detail: string,
): RecordOutcome {
	if (facet === "read") {
		recordDegradationOnce({
			kind: "io-bridge-read-dropped",
			subject: `${caller}:${reason}`,
			reason: detail,
		});
	} else {
		recordDegradationOnce({
			kind: "io-bridge-mutate-dropped",
			subject: `${caller}:${reason}`,
			reason: detail,
		});
	}
	return { accepted: false, reason };
}

/** The `lineHashes` a caller-mode read should store, or `undefined` for coverage-only. */
function selectLineHashes(
	read: ReadFacet,
	start: number,
	end: number,
): LineHashMap | undefined {
	const within = (hashes: LineHashMap): LineHashMap => {
		const picked: LineHashMap = {};
		for (const [key, value] of Object.entries(hashes)) {
			const line = Number(key);
			if (line >= start && line <= end) picked[line] = value;
		}
		return picked;
	};
	if (read.lineHashes !== undefined) return within(read.lineHashes);
	if (read.content !== undefined) {
		const derived = deliveredLineEvidence(read.content, start).lineHashes;
		return derived === undefined ? undefined : within(derived);
	}
	return undefined;
}

interface OneRangeRecord {
	filePath: string;
	requestedOffset: number;
	requestedLimit: number;
	effectiveOffset: number;
	effectiveLimit: number;
	source: string;
	turnIndex: number;
	writeIndex: number;
	lineHashes?: LineHashMap;
	contentBinding?: ReadContentBinding;
	captureLineHashes: boolean;
	/**
	 * #3865: whether the read is evidence of every byte of the file: a disk
	 * read of every line whose content binding covers the whole file, or the
	 * zero-line read of an empty file. Only such a read moves the whole-file FileTime; a
	 * range leaves it at its last whole-file stamp, and its hashes (and a
	 * range binding) judge the lines it covered.
	 */
	wholeFile?: boolean;
}

function recordOneRange(
	guard: ReadGuardBridgeSurface,
	args: OneRangeRecord,
): void {
	guard.recordRead(
		{
			filePath: args.filePath,
			requestedOffset: args.requestedOffset,
			requestedLimit: args.requestedLimit,
			effectiveOffset: args.effectiveOffset,
			effectiveLimit: args.effectiveLimit,
			expandedByLsp: false,
			turnIndex: args.turnIndex,
			writeIndex: args.writeIndex,
			timestamp: Date.now(),
			source: args.source,
			...(args.lineHashes !== undefined && { lineHashes: args.lineHashes }),
			...(args.contentBinding !== undefined && {
				contentBinding: args.contentBinding,
			}),
		},
		{
			captureLineHashes: args.captureLineHashes,
			stampFileTime: args.wholeFile === true,
		},
	);
}

/** Shared, resolved inputs for the read facet's two recording branches. */
interface ReadRecordContext {
	read: ReadFacet;
	deps: IOBridgeDeps;
	filePath: string;
	source: string;
	guard: ReadGuardBridgeSurface;
	turnIndex: number;
	writeIndex: number;
}

/**
 * The explicit zero-line read: it credits whole-file coverage only for a genuinely
 * empty file; anything else would credit lines the agent never saw (#3652).
 * Returns a drop detail, or `undefined` when recorded.
 */
function recordZeroLineRead(ctx: ReadRecordContext): string | undefined {
	let size: number;
	try {
		size = ctx.deps.nodeFs.statSync(ctx.filePath).size;
	} catch (err) {
		return `${err}`;
	}
	if (size !== 0) {
		return `zero-line read of a non-empty file (${size} bytes)`;
	}
	recordOneRange(ctx.guard, {
		filePath: ctx.filePath,
		requestedOffset: 1,
		requestedLimit: 0,
		effectiveOffset: 1,
		effectiveLimit: Number.MAX_SAFE_INTEGER,
		source: ctx.source,
		turnIndex: ctx.turnIndex,
		writeIndex: ctx.writeIndex,
		captureLineHashes: false,
		wholeFile: true,
	});
	return undefined;
}

/**
 * One declared range in caller- or disk-evidence mode. Returns a drop detail, or
 * `undefined` when recorded; a disk read of an absent file is refused.
 */
function recordRange(
	ctx: ReadRecordContext,
	start: number,
	end: number,
): string | undefined {
	// A `MAX_SAFE_INTEGER` end is the v1 "whole file" spelling; keep the
	// requested limit identical to v1 rather than `end - start + 1`.
	const limit =
		end === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : end - start + 1;
	const base: OneRangeRecord = {
		filePath: ctx.filePath,
		requestedOffset: start,
		requestedLimit: limit,
		effectiveOffset: start,
		effectiveLimit: limit,
		source: ctx.source,
		turnIndex: ctx.turnIndex,
		writeIndex: ctx.writeIndex,
		captureLineHashes: ctx.read.evidence === "disk",
	};
	if (ctx.read.evidence === "disk") {
		if (!ctx.deps.nodeFs.existsSync(ctx.filePath)) {
			return `disk read of an absent file: ${ctx.filePath}`;
		}
		const binding = captureReadContentBinding(ctx.filePath, start, limit);
		recordOneRange(ctx.guard, {
			...base,
			...(binding !== undefined && { contentBinding: binding }),
			// A whole-file binding hashes every byte, but only a read of every
			// line delivered them all.
			wholeFile:
				binding?.fullFile === true && start === 1 && end >= binding.limit,
		});
		return undefined;
	}
	const hashes = selectLineHashes(ctx.read, start, end);
	recordOneRange(ctx.guard, {
		...base,
		...(hashes !== undefined && { lineHashes: hashes }),
	});
	return undefined;
}

function recordReadFacet(
	raw: Record<string, unknown>,
	caller: string,
	deps: IOBridgeDeps,
): RecordOutcome {
	const problem = readFacetProblem(raw["read"]);
	if (problem !== undefined) return drop("read", caller, "malformed", problem);
	const read = raw["read"] as ReadFacet;
	const filePath = raw["filePath"];
	if (typeof filePath !== "string" || filePath === "") {
		return drop(
			"read",
			caller,
			"malformed",
			"filePath must be a non-empty string",
		);
	}
	if (deps.getFlag("no-read-guard", "read")) {
		return drop("read", caller, "no-read-guard", filePath);
	}
	if (!deps.isRecordable(filePath)) {
		return drop("read", caller, "out-of-scope", filePath);
	}

	const ctx: ReadRecordContext = {
		read,
		deps,
		filePath,
		source: read.source ?? `io-bridge:${caller}`,
		guard: deps.getReadGuard(),
		turnIndex: deps.getTurnIndex(),
		writeIndex: deps.peekWriteIndex(),
	};

	if (read.ranges.length === 0) {
		const detail = recordZeroLineRead(ctx);
		return detail === undefined
			? { accepted: true }
			: drop("read", caller, "bookkeeping-error", detail);
	}

	for (const [start, end] of read.ranges) {
		try {
			const detail = recordRange(ctx, start, end);
			if (detail !== undefined) {
				return drop("read", caller, "bookkeeping-error", detail);
			}
		} catch (err) {
			return drop("read", caller, "bookkeeping-error", `${err}`);
		}
	}
	return { accepted: true };
}

function recordDeleteFacet(
	filePath: string,
	caller: string,
	deps: IOBridgeDeps,
): RecordOutcome {
	// Enclosing gate (RFC D3). `no-lsp` is read again below, where it suppresses
	// only the LSP notification; the eviction still runs (RFC §6). The native
	// bash path skips the whole delete under `no-lsp` instead.
	if (deps.getFlag("no-read-guard", "mutation")) {
		return drop("mutate", caller, "no-read-guard", filePath);
	}
	const guard = deps.getReadGuard();
	const verdict = judgeConfirmedDelete(filePath, {
		isExternalOrVendorFile: (p) => deps.isExternalOrVendorFile(p),
		isPathIgnoredByProject: (p) => deps.isPathIgnoredByProject(p),
		hasKnownPath: (p) => guard.hasKnownPath(p),
		existsSync: (p) => deps.nodeFs.existsSync(p),
	});
	if (verdict === "out-of-scope" || verdict === "ignored") {
		return drop("mutate", caller, verdict, filePath);
	}
	// Untracked and already absent: nothing to evict, nothing to notify. Any
	// other path still on disk means the caller recorded before deleting.
	if (verdict === "untracked" && !deps.nodeFs.existsSync(filePath)) {
		return { accepted: true };
	}
	if (verdict !== "confirmed") {
		return drop(
			"mutate",
			caller,
			"bookkeeping-error",
			`delete confirmed for a file still on disk: ${filePath}`,
		);
	}
	guard.forgetPath(filePath);
	if (!deps.getFlag("no-lsp", "mutation")) {
		try {
			void Promise.resolve(deps.notifyExternalFileChange(filePath, 3)).catch(
				(err) => {
					deps.dbg?.(
						`io_bridge: external-delete notify failed for ${filePath}: ${err}`,
					);
				},
			);
		} catch (err) {
			deps.dbg?.(
				`io_bridge: external-delete notify threw for ${filePath}: ${err}`,
			);
		}
	}
	return { accepted: true };
}

/** The facet fields the bookkeeping owner reads under the same names. */
const MUTATE_PASSTHROUGH_KEYS = [
	"touchedLines",
	"deferAutofix",
	"importsChanged",
	"provenance",
	"readGuardBranchEpoch",
	"lineage",
] as const;

function recordMutateFacet(
	raw: Record<string, unknown>,
	caller: string,
	deps: IOBridgeDeps,
): RecordOutcome {
	const mutate = raw["mutate"];
	if (!isRecordObject(mutate)) {
		return drop(
			"mutate",
			caller,
			"malformed",
			"mutate facet must be an object",
		);
	}
	const kind = mutate["kind"];
	const filePath = raw["filePath"];
	if (typeof filePath !== "string" || filePath === "") {
		return drop(
			"mutate",
			caller,
			"malformed",
			"filePath must be a non-empty string",
		);
	}
	if (kind === "delete") return recordDeleteFacet(filePath, caller, deps);
	// Anything else is an edit/write for the owner: translate the facet into
	// its entry once. The owner validates every field, `kind` included (one
	// validator, #3654 F3), and runs the seam: scope
	// gate, lineage fence, stamp, turn state, receipt, deferral, publish.
	// `consumer` rides along so the change log names the producer
	// (`agent-tool:<name>`), never `agent-tool:unknown`.
	const entry: Record<string, unknown> = { filePath, kind };
	if (caller !== "unknown") entry["consumer"] = caller;
	if (kind === "edit" && mutate["ranges"] !== undefined) {
		entry["editRanges"] = mutate["ranges"];
	}
	for (const key of MUTATE_PASSTHROUGH_KEYS) {
		if (mutate[key] !== undefined) entry[key] = mutate[key];
	}
	const outcome = recordMutationOutcome(entry, deps, {
		rejectStaleLineage: true,
	});
	if (!outcome.accepted) {
		return drop(
			"mutate",
			caller,
			outcome.reason ?? "bookkeeping-error",
			outcome.detail ?? filePath,
		);
	}
	return { accepted: true };
}

/**
 * Wrap one facet so a bookkeeping surprise becomes a `bookkeeping-error`
 * outcome (D9: `record()` never throws) without silencing the other facet.
 */
function safeFacet(
	caller: string,
	facet: "read" | "mutate",
	run: () => RecordOutcome,
): RecordOutcome {
	try {
		return run();
	} catch (err) {
		return drop(facet, caller, "bookkeeping-error", `${err}`);
	}
}

/**
 * The bridge body: the mounted `record()` and the v1 read shim both call it
 * with the same deps, so the shim exercises exactly what v2 runs.
 */
export function recordIOEntry(
	raw: BridgeEntry,
	deps: IOBridgeDeps,
): RecordResult {
	if (!isRecordObject(raw)) {
		const detail = "entry must be an object";
		return {
			read: drop("read", "unknown", "malformed", detail),
			mutate: drop("mutate", "unknown", "malformed", detail),
		};
	}
	const caller = readConsumer(raw);
	const hasRead = hasFacet(raw, "read");
	const hasMutate = hasFacet(raw, "mutate");

	if (!hasRead && !hasMutate) {
		const detail = "entry carries no read or mutate facet";
		return {
			read: drop("read", caller, "malformed", detail),
			mutate: drop("mutate", caller, "malformed", detail),
		};
	}

	// D3 negative path: deleting while binding a read is contradictory, and both
	// facets are malformed.
	if (
		hasMutate &&
		hasRead &&
		isRecordObject(raw["mutate"]) &&
		raw["mutate"]["kind"] === "delete"
	) {
		const detail = "delete cannot be combined with read";
		return {
			read: drop("read", caller, "malformed", detail),
			mutate: drop("mutate", caller, "malformed", detail),
		};
	}

	// Atomic ordering: mutate strictly before read.
	const result: RecordResult = {};
	if (hasMutate) {
		result.mutate = safeFacet(caller, "mutate", () =>
			recordMutateFacet(raw, caller, deps),
		);
	}
	if (hasRead) {
		result.read = safeFacet(caller, "read", () =>
			recordReadFacet(raw, caller, deps),
		);
	}
	return result;
}
