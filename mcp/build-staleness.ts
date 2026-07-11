/**
 * Warm-server build-staleness detection (#535).
 *
 * The MCP server is long-lived (weeks, per #514/#256's warm/fresh doctrine) —
 * it loads its code ONCE at process start and never re-reads disk. A
 * `npm run build:dist` or a `git merge` that changes `dist/mcp/server.js` (or
 * the in-place `mcp/server.js` during dev) never reaches an already-running
 * warm server: it keeps serving the OLD schema/logic indefinitely. Dogfooding
 * #517 caught this live — a post-#517 rebuild still answered with the
 * pre-#517 `pilens_module_report` shape. That is the "plausible-but-wrong"
 * failure mode the #240/#511 honesty doctrine exists to prevent, not a mere
 * error — so the warm boundary must detect it and say so, never silently
 * serve stale.
 *
 * Design: capture an mtime "stamp" of the server's own entry file at process
 * start (module-level, once). On each call at the warm boundary, cheaply
 * re-stat the SAME file and compare. A full content hash was considered and
 * rejected for the hot path — mtime already changes on any rebuild/checkout
 * that touches the file (build tools + git both update it), and hashing the
 * whole bundle on every tool call is needless I/O; mtime is the same signal
 * class the #492 cross-process reader already trusts for freshness.
 *
 Pure/testable: `computeBuildStamp`/`checkStaleness` take an injectable stat
 * function so tests never touch the real filesystem or a real build.
 *
 * Throttle: re-stating on EVERY call would still be one syscall per call —
 * cheap, but under a tool-call burst (e.g. a batch of `pilens_symbol_search`)
 * that's needless repeated I/O for a condition that changes at most once per
 * rebuild. `StalenessGate` re-stats at most once per `checkIntervalMs`
 * (default 1000ms, matching the #492 precedent's "cheap per-call check, not
 * per-call I/O" shape) and reuses the last verdict in between.
 */

import * as fs from "node:fs";

/** Injectable so tests never touch the real filesystem. */
export type StatFn = (targetPath: string) => { mtimeMs: number } | undefined;

export const realStat: StatFn = (targetPath) => {
	try {
		return fs.statSync(targetPath);
	} catch {
		return undefined;
	}
};

/** The stamp captured once at server startup. */
export interface BuildStamp {
	entryPath: string;
	mtimeMs: number;
}

/**
 * Captures the startup stamp for `entryPath` (the server's own loaded module
 * file). Returns `undefined` if the entry can't be stat'd — e.g. running from
 * a bundle/packaging layout where the on-disk file legitimately doesn't exist
 * at that path; in that case staleness checking degrades to "always fresh"
 * rather than false-flagging every call.
 */
export function computeBuildStamp(
	entryPath: string,
	stat: StatFn = realStat,
): BuildStamp | undefined {
	const info = stat(entryPath);
	if (!info) return undefined;
	return { entryPath, mtimeMs: info.mtimeMs };
}

export interface StalenessCheckResult {
	/** true when the on-disk entry's mtime no longer matches the startup stamp. */
	stale: boolean;
	/** The stamp captured at startup (echoed for logging/tests). */
	stamp: BuildStamp;
	/** The mtime observed on THIS check (undefined if the stat failed). */
	currentMtimeMs: number | undefined;
}

/**
 * One-shot comparison: re-stats `stamp.entryPath` and compares against the
 * startup mtime. A failed re-stat (file briefly missing mid-rebuild-write, or
 * an installed-package layout) is treated as NOT stale — we only ever flag a
 * build change we can positively observe, never assume one from an I/O
 * hiccup (false positives would make every tool call route to fresh, which
 * defeats the warm server's entire purpose).
 */
export function checkStaleness(
	stamp: BuildStamp,
	stat: StatFn = realStat,
): StalenessCheckResult {
	const info = stat(stamp.entryPath);
	if (!info) return { stale: false, stamp, currentMtimeMs: undefined };
	return {
		stale: info.mtimeMs !== stamp.mtimeMs,
		stamp,
		currentMtimeMs: info.mtimeMs,
	};
}

export interface StalenessGateOptions {
	/** Minimum time between real re-stats; cached verdict is reused in between. */
	checkIntervalMs?: number;
	stat?: StatFn;
	/** Defaults to `Date.now` — overridable for tests. */
	now?: () => number;
}

/**
 * Mtime-gated staleness gate for the hot call path (mirrors the #492
 * cross-process reader's "one `fs.stat`, cache the verdict" shape): a burst
 * of tool calls within `checkIntervalMs` of each other costs exactly ONE
 * `fs.stat`, not one per call.
 */
export class StalenessGate {
	private readonly stamp: BuildStamp | undefined;
	private readonly checkIntervalMs: number;
	private readonly stat: StatFn;
	private readonly now: () => number;
	private lastCheckedAt: number | undefined;
	private lastVerdict = false;

	constructor(stamp: BuildStamp | undefined, options: StalenessGateOptions = {}) {
		this.stamp = stamp;
		this.checkIntervalMs = options.checkIntervalMs ?? 1000;
		this.stat = options.stat ?? realStat;
		this.now = options.now ?? Date.now;
	}

	/** True when the warm server's loaded code is known to be stale. */
	isStale(): boolean {
		if (!this.stamp) return false; // no stamp captured — never flag
		const nowMs = this.now();
		if (
			this.lastCheckedAt !== undefined &&
			nowMs - this.lastCheckedAt < this.checkIntervalMs
		) {
			return this.lastVerdict;
		}
		this.lastCheckedAt = nowMs;
		this.lastVerdict = checkStaleness(this.stamp, this.stat).stale;
		return this.lastVerdict;
	}
}

/** Env kill switch: `PI_LENS_WARM_STALENESS_CHECK=0` disables the whole guard. */
export function stalenessCheckEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env.PI_LENS_WARM_STALENESS_CHECK !== "0";
}

/**
 * Standard advisory text appended when a tool result was served through the
 * fresh-fork route because the warm build was stale.
 */
export const STALE_SERVED_BY_FRESH =
	"fresh (warm code stale — restart the Claude session to re-warm)";

/**
 * Standard advisory text for tools that CANNOT be routed to a fresh fork
 * (they depend on warm-process-only state: the in-memory review graph, the
 * word-index cache, the warm LSP fleet) — honest degrade instead of routing.
 */
export const STALE_WARN_ONLY =
	"warmCodeStale: this result was served by the warm server's loaded code, " +
	"which is older than the on-disk build (a rebuild or merge landed after " +
	"this session started). Restart the Claude session to re-warm, or use " +
	"pilens_rebuild + a tool that supports mode=fresh if available.";
