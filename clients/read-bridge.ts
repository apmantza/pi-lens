/**
 * Generic read-recording bridge for pi-lens.
 *
 * ## Trust model — explicitly advisory
 *
 * This bridge is an **advisory, trust-based protocol** for same-process Pi
 * extensions. Any code sharing the same Node.js process already has full
 * access to pi-lens's internal state, so the bridge cannot and does not
 * provide a meaningful security boundary. What it *does* provide is:
 *
 * - A stable API surface so extensions do not need to import pi-lens
 *   internals directly.
 * - A single place for flag/scope checks (no-read-guard, ignored paths).
 * - Basic defensive validation to catch integration bugs early (malformed
 *   payloads).
 *
 * Mounts a `ReadBridge` object at `globalThis[READ_BRIDGE_KEY]` that any
 * co-process extension can call to register a file read against pi-lens's
 * read-guard — without either party needing to know about the other.
 *
 * Protocol (producer side)
 * ────────────────────────
 * A co-process Pi extension that performs file reads outside pi-lens's
 * awareness (e.g. via a custom registered tool) can forward those reads so
 * that a subsequent `edit` call on the same file is not blocked by the
 * read-before-edit guard:
 *
 *   const bridge = (globalThis as any)[Symbol.for("pi-lens:read-bridge")];
 *   bridge?.recordRead({
 *     filePath,          // absolute path
 *     requestedOffset,   // 1-indexed first line (default 1)
 *     requestedLimit,    // line count, undefined for the whole file, or 0 for an (empty-file) zero-line read
 *     consumer,          // optional identifier, e.g. "my-extension" (appears in read-guard.log)
 *   });
 *
 * Check `bridge.version` before calling to guard against future incompatible
 * changes — a bridge whose version you don't recognise should be treated as
 * unsupported.
 *
 * The timestamp is stamped by the bridge itself (Date.now()) to match
 * exactly how the internal read path works.
 *
 * Calling before pi-lens is loaded, or when the guard is disabled via
 * `PI_LENS_NO_READ_GUARD`, is safe — the bridge is absent or the call is
 * silently dropped.
 *
 * Protocol (registration side, internal to pi-lens)
 * ──────────────────────────────────────────────────
 * `registerReadBridge` is called once from inside the extension factory
 * (after `getLensFlag` is available) via the `_readBridgeRegistered`
 * singleton guard so that factory re-activations in the same process do not
 * mount a second bridge.
 *
 * The `isRecordable` predicate is re-evaluated on every `recordRead` call
 * using the *current* activation's flag getter (stored in a module-level
 * holder refreshed on every factory activation — same pattern as
 * `_turnSummaryEmitCtx`), so flag changes take effect immediately.
 *
 * Since #3654 this shim is a translator: a valid, recordable entry becomes a
 * v2 `disk`-evidence read facet and goes to the unified bridge's body
 * (`recordIOEntry` in `clients/io-bridge.ts`, injected as `deps.forward`), the
 * same body the mounted v2 bridge runs. There is no second v1 body.
 */
import { registerProcessBridge } from "./process-bridge.js";
import type {
	BridgeEntry,
	LineRange,
	RecordResult,
} from "./io-bridge-contract.js";

/** Stable Symbol key — identical across module reloads in the same process. */
export const READ_BRIDGE_KEY: unique symbol = Symbol.for("pi-lens:read-bridge");

/** Payload a producer passes when recording a read. */
export interface ReadBridgeEntry {
	/**
	 * Absolute path to the file that was read. Since #3654 a read of a file
	 * that is absent when the call lands records nothing (v2's disk-evidence
	 * read refuses it, with an `io-bridge-read-dropped` ledger row).
	 */
	filePath: string;
	/** First line read (1-indexed). Defaults to 1 when no offset was given. */
	requestedOffset: number;
	/**
	 * Number of lines read. `undefined` means the whole file was requested;
	 * pi-lens will treat the effective limit as the full file length.
	 * `0` is a valid observation only when the target file exists and is
	 * empty: it grants whole-file coverage (normalized to line 1) so a
	 * subsequent edit is authorized. A zero-line read carries no
	 * `contentBinding` — no content was delivered, so there is nothing to
	 * bind — and a zero-line read of a non-empty or unreadable file is
	 * dropped.
	 */
	requestedLimit: number | undefined;
	/**
	 * Optional caller identity. Surfaced as `source: "bridge:<consumer>"`
	 * in `read-guard.log` so the worklog shows which extension satisfied
	 * the read-before-edit guard. Defaults to `"unknown"` when omitted.
	 */
	consumer?: string;
}

/** The object mounted at `globalThis[READ_BRIDGE_KEY]`. */
export interface ReadBridge {
	/**
	 * Bridge API version. Check this before calling `recordRead` — if the
	 * version is not one you recognise, treat the bridge as unsupported.
	 */
	readonly version: 1;
	recordRead(entry: ReadBridgeEntry): void;
}

interface BridgeDeps {
	/**
	 * Return `true` when the entry should be forwarded to the read-guard.
	 * Called on every `recordRead` invocation so flag / project-root changes
	 * take effect immediately without re-registration.
	 */
	isRecordable(filePath: string): boolean;
	/** The unified bridge body (`recordIOEntry` bound to the live deps). */
	forward(entry: BridgeEntry): RecordResult;
}

/**
 * Validate a raw entry from an untrusted caller.
 * Returns `true` when the entry is structurally sound and safe to forward.
 *
 * Validation is deliberately lightweight — this is an advisory protocol
 * between same-process extensions (see the module-level trust-model note).
 * The goal is to catch integration bugs (typo'd fields, bad numbers) early
 * rather than to enforce a security boundary.
 */
function isValidEntry(entry: unknown): entry is ReadBridgeEntry {
	if (typeof entry !== "object" || entry === null) return false;
	const e = entry as Record<string, unknown>;

	// filePath must be a non-empty string (absolute paths are expected but
	// we don't re-resolve here — `isRecordable` handles scope checks).
	if (typeof e["filePath"] !== "string" || e["filePath"] === "") return false;

	// requestedOffset must be a finite integer ≥ 1.
	const offset = e["requestedOffset"];
	if (
		typeof offset !== "number" ||
		!Number.isFinite(offset) ||
		offset < 1 ||
		!Number.isInteger(offset)
	)
		return false;

	// requestedLimit must be undefined or a finite non-negative integer. 0 is
	// admitted here and narrowed to genuinely empty files by v2's zero-line read.
	const limit = e["requestedLimit"];
	if (limit !== undefined) {
		if (
			typeof limit !== "number" ||
			!Number.isFinite(limit) ||
			limit < 0 ||
			!Number.isInteger(limit)
		)
			return false;
	}

	return true;
}

/**
 * The v2 `ranges` a v1 entry's offset/limit denotes. `undefined` means
 * whole-file; `MAX_SAFE_INTEGER` avoids an unsafe `offset + …` and lets the
 * guard's own file-length probe clip the effective limit. A zero-line read
 * (`requestedLimit: 0`) is v2's explicit zero-line read, `[]`: it credits
 * whole-file coverage only for a genuinely empty file (#3652). Spelling it as
 * the range `[offset, offset - 1]` is malformed in v2, so the read was dropped
 * and the next edit of the empty file blocked (#3654 F1).
 */
function delegatedRanges(entry: ReadBridgeEntry): LineRange[] {
	const offset = entry.requestedOffset;
	if (entry.requestedLimit === 0) return [];
	const limit = entry.requestedLimit ?? Number.MAX_SAFE_INTEGER;
	const end =
		limit === Number.MAX_SAFE_INTEGER
			? Number.MAX_SAFE_INTEGER
			: offset + limit - 1;
	return [[offset, end]];
}

/**
 * Mount the bridge singleton. Call once from inside the extension factory
 * (protected by the `_readBridgeRegistered` module-level flag). Subsequent
 * calls are no-ops (first-wins, `clients/process-bridge.ts` owns the mount
 * body — see that module's header, #2437).
 */
export function registerReadBridge(deps: BridgeDeps): void {
	registerProcessBridge(READ_BRIDGE_KEY, (): ReadBridge => ({
		version: 1 as const,
		recordRead(entry: ReadBridgeEntry): void {
			// Validate the payload before doing anything else — this catches
			// integration bugs in callers (malformed fields, bad numbers).
			if (!isValidEntry(entry)) return;

			// #3654 D14: the v1 recordability gate runs FIRST, on the v1 path. Its
			// flag read is this bridge's own ("read-bridge" subject, and a
			// near-match stale error rethrows as v1 did); delegating first would
			// report "io-bridge" and swallow the rethrow inside the v2
			// never-throw wrapper.
			if (!deps.isRecordable(entry.filePath)) return;

			// The v2 body stamps the timestamp (Date.now()), the turn and write
			// indexes, and the `bridge:<consumer>` provenance read-guard.log shows.
			deps.forward({
				filePath: entry.filePath,
				...(entry.consumer !== undefined && { consumer: entry.consumer }),
				read: {
					ranges: delegatedRanges(entry),
					evidence: "disk",
					source: `bridge:${entry.consumer ?? "unknown"}`,
				},
			});
		},
	}));
}
