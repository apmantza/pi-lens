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
export type StatFn = (
	targetPath: string,
) => { mtimeMs: number; size: number } | undefined;

const realStat: StatFn = (targetPath) => {
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
	/**
	 * #2300: the entry file's byte size at startup, from the same stat call as
	 * `mtimeMs`. A rebuild that lands in the same mtime bucket as the startup
	 * stat (coarse filesystem mtime granularity) but changes the bundle's
	 * length would otherwise be invisible to `checkStaleness`'s mtime-only
	 * comparison.
	 */
	size: number;
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
	return { entryPath, mtimeMs: info.mtimeMs, size: info.size };
}

export interface StalenessCheckResult {
	/** true when the on-disk entry's mtime or size no longer matches the startup stamp. */
	stale: boolean;
	/** The stamp captured at startup (echoed for logging/tests). */
	stamp: BuildStamp;
	/** The mtime observed on THIS check (undefined if the stat failed). */
	currentMtimeMs: number | undefined;
}

/**
 * One-shot comparison: re-stats `stamp.entryPath` and compares against the
 * startup mtime AND size (#2300 — a same-mtime-bucket rebuild that changes
 * the bundle's length is otherwise invisible). A failed re-stat (file briefly
 * missing mid-rebuild-write, or an installed-package layout) is treated as
 * NOT stale — we only ever flag a build change we can positively observe,
 * never assume one from an I/O hiccup (false positives would make every tool
 * call route to fresh, which defeats the warm server's entire purpose).
 */
export function checkStaleness(
	stamp: BuildStamp,
	stat: StatFn = realStat,
): StalenessCheckResult {
	const info = stat(stamp.entryPath);
	if (!info) return { stale: false, stamp, currentMtimeMs: undefined };
	return {
		stale: info.mtimeMs !== stamp.mtimeMs || info.size !== stamp.size,
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

	constructor(
		stamp: BuildStamp | undefined,
		options: StalenessGateOptions = {},
	) {
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

// --- Warm build-staleness — per-tool warn-only set (#535) --------------------
//
// `pilens_analyze` is handled specially above (force-routes to the existing
// `fresh` worker fork — it's a stateless per-file dispatch with no dependency
// on warm-process-only state). Every OTHER tool below either:
//   - depends on state that only exists inside THIS long-lived process (the
//     in-memory review graph built by warm `pilens_analyze` calls, the warm
//     LSP client fleet, the latency/diagnostic counters, the CacheManager) —
//     a fresh fork would start with none of that and answer differently, not
//     "more correctly"; or
//   - is cheap/rare enough (rebuild, session_start) that building bespoke
//     fresh-fork plumbing isn't worth it yet.
// So the honest move for all of them is #535's "honest degrade": warn, don't
// silently serve, and don't pretend a fresh fork would help.
//
//   pilens_module_report, pilens_symbol_search — warm review-graph / word-index
//     cache is in-memory only; a fresh fork has an EMPTY graph, which is a
//     worse answer than a stale-but-populated one with a warning attached.
//   pilens_project_scan                        — CacheManager instance is warm-
//     process state; scan results are cache-derived.
//   pilens_health, pilens_latency              — these tools report ON the warm
//     process itself (alive LSP clients, this session's latency log) — the
//     question "is this call's ANSWER stale" doesn't quite apply, but the code
//     answering it might still be a stale build, so still worth a note.
//   pilens_session_start, pilens_turn_end      — mutate warm LSP/graph state;
//     must run in-process, can't be forked fresh.
//   pilens_ast_grep_search, pilens_ast_grep_replace,
//   pilens_lsp_navigation, pilens_diagnostics — depend on the warm LSP
//     fleet / ast-grep client instances; no fresh-fork machinery exists for
//     them today (only pilens_analyze's worker.ts loads a fresh dispatch
//     graph) and the LSP fleet specifically CANNOT be recreated cheaply per
//     call, so warn is the only honest option.
//   pilens_read_symbol, pilens_read_enclosing  — stateless file reads, but no
//     existing fresh-fork path either; warn rather than silently answer with
//     however this stale build's tree-sitter/read-symbol logic behaves.
//   pilens_effective_config                    — derives (never reads) the
//     LSP config for the file's directory to say which servers it selects,
//     and the merge/deny semantics it explains are compiled code; a stale
//     build would explain a resolution the running one no longer performs.
//
// `pilens_rebuild` is deliberately excluded: it doesn't answer with analysis
// at all (it shells out to `npm run build`/`build:dist`), and it's the very
// mechanism that CAUSES staleness — noting "stale" on the tool that fixes
// staleness would be confusing, not honest.
export const WARN_ONLY_STALE_TOOLS = new Set([
	"pilens_module_report",
	"pilens_project_report",
	"pilens_symbol_search",
	"pilens_project_scan",
	"pilens_health",
	"pilens_latency",
	"pilens_session_start",
	"pilens_turn_end",
	"pilens_ast_grep_search",
	"pilens_ast_grep_replace",
	"pilens_lsp_navigation",
	"pilens_read_symbol",
	"pilens_read_enclosing",
	"pilens_effective_config",
]);
