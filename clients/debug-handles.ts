/**
 * Handle-origin tracer, institutionalized from the hand-rolled `async_hooks`
 * instrumentation the #1097 investigation used to find a leaked, ref'd
 * `setTimeout` keeping a `--print --no-session` process alive after
 * `agent_settled` (root-caused/fixed in #1110). The #1097 reporter explicitly
 * asked for a built-in active-resource dump (#1123 item 4) so the next
 * "process won't exit" report is a one-line diagnostic instead of a fresh
 * multi-hour expedition.
 *
 * `PI_LENS_DEBUG_HANDLES=1` (read ONCE at module load — i.e. must be set
 * before pi-lens starts, not toggled mid-session):
 *   - OFF (default): every export below is a no-op that returns immediately
 *     on the flag check — no writer constructed, no async_hooks hook
 *     installed, zero allocations on any hot path. `dumpActiveHandles` is
 *     called from live lifecycle hooks (index.ts `agent_settled` /
 *     `session_shutdown`), so this module must cost nothing when unset.
 *   - ON: (a) `dumpActiveHandles(label)` calls `process.getActiveResourcesInfo()`,
 *     tallies counts by resource type, and writes one ndjson line to
 *     `~/.pi-lens/debug-handles.log` via the standard `createNdjsonLogger`
 *     family (size-bounded, log-cleanup registered — the same rotation
 *     bounds every other pi-lens log gets, #1101-era registry via
 *     clients/ndjson-logger.ts's self-registration + clients/log-cleanup.ts).
 *     (b) an `async_hooks` creation-site tracker, installed at module load
 *     ONLY when the flag is on, records a trimmed `Error().stack` per
 *     tracked resource id for timer/socket/handle async-hook types and
 *     removes the entry on `destroy`. This is a real per-resource-creation
 *     cost — `async_hooks` hooks run on every init/destroy in the process —
 *     so it is strictly opt-in and documented here as a debug-only expense,
 *     never installed unless the flag was on before this module first loads.
 *
 * Bounded tracker (the one-axis-rule, docs/engineering-principles.md "Design shared state once, at design time"): the creation-site map is capped at
 * `TRACKER_MAX_ENTRIES` before adding a new entry past the cap — never
 * unbounded growth even in a pathological timer-storm session. Eviction
 * protects the first `TRACKER_PROTECTED_COUNT` insertion-order entries and
 * evicts the oldest entry OUTSIDE that protected zone instead: a #1097-style
 * leaked handle is typically among the EARLIEST created in a session (it's
 * the one nothing ever cleaned up), so a naive drop-oldest policy would let a
 * later burst past the cap evict exactly the evidence this tracer exists to
 * capture, silently. `evictedCount` (a running total, always present on the
 * dump entry once the tracker is installed) makes any eviction — protected
 * or not — an explicit, visible fact instead of a silent gap in attribution.
 */

import * as asyncHooks from "node:async_hooks";
import * as path from "node:path";
import { getGlobalPiLensLogDir } from "./probe-home-state.js";
import { getMaxLogSizeMB } from "./log-rotation-limits.js";
import { createNdjsonLogger, type NdjsonLogger } from "./ndjson-logger.js";

/** Read once at module load — see module docstring. Not re-read per call. */
const DEBUG_HANDLES_ENABLED = process.env.PI_LENS_DEBUG_HANDLES === "1";

const DEBUG_HANDLES_LOG_FILE = path.join(
	getGlobalPiLensLogDir(),
	"debug-handles.log",
);

/** Cap on tracked in-flight creation sites (bounded past this). */
export const TRACKER_MAX_ENTRIES = 500;

/** The first N insertion-order entries are never evicted — see the module
 *  docstring's "leaked handles skew early" rationale. Must stay well below
 *  `TRACKER_MAX_ENTRIES` so there is always an evictable, unprotected tail. */
export const TRACKER_PROTECTED_COUNT = 100;

/** async_hooks `type` strings worth attributing: timers, sockets, process/
 *  signal handles — the shapes #1097's hand-rolled tracer actually needed
 *  (a `Timeout`). Excludes high-frequency non-handle async resources
 *  (`PROMISE`, `FSREQCALLBACK`, ...) that would dominate the map with no
 *  "why is the process still alive" signal. */
const TRACKED_TYPE_RE =
	/^(Timeout|Immediate|TCPWRAP|TCPSOCKETWRAP|TCPCONNECTWRAP|PIPEWRAP|PIPECONNECTWRAP|UDPWRAP|UDPSENDWRAP|TTYWRAP|ProcessWrap|Signal)/;

interface TrackedResource {
	type: string;
	stack: string;
}

function trimStack(raw: string | undefined): string {
	if (!raw) return "";
	// Drop the "Error" header line and this module's own init() frame; keep a
	// bounded number of caller frames — enough to identify the call site
	// without unbounded per-entry memory.
	const lines = raw.split("\n").slice(1);
	const callerLines = lines.filter(
		(line) =>
			!line.includes("debug-handles.js") && !line.includes("debug-handles.ts"),
	);
	return callerLines.slice(0, 8).join("\n").slice(0, 2000);
}

/** Running total of tracker evictions this process (never reset) — surfaced
 *  on every dump entry once the tracker is installed, per the P2 fix: an
 *  eviction must always be a visible fact, never a silent attribution gap. */
let trackedEvictedCount = 0;

/** Test-only accessor for the running eviction total. */
export function _evictedCountForTest(): number {
	return trackedEvictedCount;
}

/** Record one tracked resource's creation site. Once the bounded cap is
 *  reached, evicts the oldest entry OUTSIDE the first `TRACKER_PROTECTED_COUNT`
 *  insertion-order entries (Map iteration order == insertion order) — see the
 *  module docstring for why the earliest entries are protected instead of
 *  evicted. Shared by the real async_hooks `init` callback and the test-only
 *  simulator so the eviction policy has exactly one implementation. */
function recordTrackedInit(
	map: Map<number, TrackedResource>,
	asyncId: number,
	type: string,
): void {
	if (!TRACKED_TYPE_RE.test(type)) return;
	if (map.size >= TRACKER_MAX_ENTRIES) {
		let index = 0;
		let evictKey: number | undefined;
		for (const key of map.keys()) {
			if (index >= TRACKER_PROTECTED_COUNT) {
				evictKey = key;
				break;
			}
			index++;
		}
		if (evictKey !== undefined) {
			map.delete(evictKey);
			trackedEvictedCount++;
		}
	}
	map.set(asyncId, { type, stack: trimStack(new Error().stack) });
}

function installHandleTracker(): Map<number, TrackedResource> {
	const map = new Map<number, TrackedResource>();
	const hook = asyncHooks.createHook({
		init(asyncId: number, type: string) {
			recordTrackedInit(map, asyncId, type);
		},
		destroy(asyncId: number) {
			map.delete(asyncId);
		},
	});
	hook.enable();
	return map;
}

// Only ever constructed/installed when the flag is on — the entire cost of
// this module when unset is this one boolean check per export below.
const trackedResources: Map<number, TrackedResource> | null =
	DEBUG_HANDLES_ENABLED ? installHandleTracker() : null;

const writer: NdjsonLogger | null = DEBUG_HANDLES_ENABLED
	? createNdjsonLogger({
			filePath: DEBUG_HANDLES_LOG_FILE,
			maxBytes: getMaxLogSizeMB() * 1024 * 1024,
		})
	: null;

/** True iff `PI_LENS_DEBUG_HANDLES=1` was set when this module first loaded. */
export function isDebugHandlesEnabled(): boolean {
	return DEBUG_HANDLES_ENABLED;
}

export function getDebugHandlesLogPath(): string {
	return DEBUG_HANDLES_LOG_FILE;
}

/** Resolve once all enqueued debug-handles writes are on disk (tests). */
export function flushDebugHandlesLog(): Promise<void> {
	return writer ? writer.flush() : Promise.resolve();
}

function safeGetActiveResourcesInfo(): string[] {
	try {
		// SAFETY: `process.getActiveResourcesInfo` is a real Node API (>=17.3)
		// that @types/node does not declare on `Process`. The cast only widens
		// the type to say the method MIGHT be there; the `typeof fn ===
		// "function"` guard on the next line is what actually decides, so a
		// runtime without it returns [] rather than throwing.
		const fn = (
			process as unknown as { getActiveResourcesInfo?: () => string[] }
		).getActiveResourcesInfo;
		return typeof fn === "function" ? fn.call(process) : [];
	} catch {
		return [];
	}
}

interface CreationSiteSummary {
	type: string;
	count: number;
	sampleStack: string;
}

/** One representative stack per tracked TYPE (not per resource id) — keeps
 *  each dump line bounded regardless of how many live entries the capped
 *  map currently holds. */
function summarizeCreationSites(
	map: Map<number, TrackedResource>,
): CreationSiteSummary[] {
	const byType = new Map<string, CreationSiteSummary>();
	for (const { type, stack } of map.values()) {
		const existing = byType.get(type);
		if (existing) {
			existing.count++;
		} else {
			byType.set(type, { type, count: 1, sampleStack: stack });
		}
	}
	return [...byType.values()];
}

export interface DebugHandlesLogEntry {
	ts: string;
	label: string;
	total: number;
	counts: Record<string, number>;
	/** Present only when the async_hooks tracker was installed at startup. */
	creationSites?: CreationSiteSummary[];
	/** Running total of tracker-cap evictions since startup (present whenever
	 *  `creationSites` is) — a nonzero value means attribution for this dump
	 *  is INCOMPLETE: some in-flight resources' creation sites were evicted
	 *  past the bounded cap and are no longer traceable. Always present (even
	 *  at 0) rather than only-on-eviction so "no evictions" is an explicit,
	 *  verifiable fact rather than an absent-field inference. */
	evictedCount?: number;
}

/**
 * Dump `process.getActiveResourcesInfo()` counts-by-type (and, when the
 * tracker was installed at startup, per-type creation-site attribution) to
 * `debug-handles.log`. A pure no-op — no allocation past the flag check —
 * when `PI_LENS_DEBUG_HANDLES` was unset at startup.
 */
export function dumpActiveHandles(label: string): void {
	if (!DEBUG_HANDLES_ENABLED || !writer) return;
	const resources = safeGetActiveResourcesInfo();
	const counts: Record<string, number> = {};
	for (const type of resources) {
		counts[type] = (counts[type] ?? 0) + 1;
	}
	const entry: DebugHandlesLogEntry = {
		ts: new Date().toISOString(),
		label,
		total: resources.length,
		counts,
	};
	if (trackedResources) {
		entry.creationSites = summarizeCreationSites(trackedResources);
		entry.evictedCount = trackedEvictedCount;
	}
	writer.log(entry);
}

/** Test-only view of the tracker's current size (bounded-cap assertions). */
export function _trackedResourceCountForTest(): number {
	return trackedResources?.size ?? 0;
}

/** Test-only: is `asyncId` still tracked? (protected-vs-evicted assertions). */
export function _isTrackedForTest(asyncId: number): boolean {
	return trackedResources?.has(asyncId) ?? false;
}

/** Test-only: synthesize an `init` call against the installed tracker without
 *  depending on real async resource creation timing. No-op when disabled. */
export function _simulateTrackedInitForTest(
	asyncId: number,
	type: string,
): void {
	if (!trackedResources) return;
	recordTrackedInit(trackedResources, asyncId, type);
}
