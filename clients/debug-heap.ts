/**
 * On-demand V8 heap-snapshot writer — the `PI_LENS_DEBUG_HEAP` sibling that
 * `clients/memory-sampler.ts`'s docstring names as the SEPARATE, explicitly
 * opt-in mechanism for #1126's acceptance criterion ("a heap snapshot of a
 * >1 GB instance identifying the dominant retainers"). The periodic
 * `memory_sample` latency.log line answers "how many bytes are resident right
 * now, broken down by subsystem, over time"; this answers the follow-up
 * question it cannot — "WHICH objects actually retain those bytes" — by writing
 * a `.heapsnapshot` an operator opens in Chrome DevTools › Memory (or clinic /
 * heapdump tooling). It is the retainer-attribution half of #1126's memory
 * observability, deliberately kept out of the always-on sampler because a heap
 * snapshot is expensive (see COST below).
 *
 * `PI_LENS_DEBUG_HEAP=1` (read ONCE at module load, exactly like
 * `debug-handles.ts` — a flag baked in at startup, never toggled mid-session):
 *   - OFF (default): every export below is a no-op that returns immediately on
 *     the flag check. No file is written, no `node:v8` snapshot work happens,
 *     no ndjson writer is constructed — zero cost on any path. The one caller,
 *     the on-demand `/lens-health` diagnostics command, guards on
 *     `isDebugHeapEnabled()` first, so an unset flag costs a single boolean
 *     read. This is NEVER wired to a hot hook, a timer, or a lifecycle event.
 *   - ON: `writeHeapSnapshotNow(label)` calls `v8.writeHeapSnapshot()` to
 *     `~/.pi-lens/heap-<pid>-<iso>.heapsnapshot` and appends ONE ndjson
 *     breadcrumb (path, pid, `rssBytes`, `durationMs`) to `heap-snapshots.log`
 *     via the standard size-bounded `createNdjsonLogger` family (same rotation
 *     bounds every other pi-lens log gets, #1101-era registry). The breadcrumb
 *     lets latency.log's `memory_sample` trajectory and the on-disk snapshot
 *     files cross-reference each other after the fact.
 *
 * COST: `v8.writeHeapSnapshot()` is a SYNCHRONOUS, multi-hundred-MB, multi-
 * second operation that pauses the whole process — which is exactly why it is
 * (a) strictly opt-in behind `PI_LENS_DEBUG_HEAP`, and (b) only ever invoked on
 * explicit operator demand via `/lens-health`, never on an automatic path.
 * Auto-capturing a snapshot when a `memory_sample` crosses an RSS threshold is
 * a DELIBERATELY-DEFERRED follow-up (see #1126) precisely because a threshold
 * trigger would reintroduce that multi-second pause onto an automatic path.
 *
 * Bounded axis (AGENTS.md recurring-defect shape 9 — "a resource bounded on one
 * axis while it grows on another"): the `.heapsnapshot` FILES are the growing
 * axis — each is large, and repeated `/lens-health` invocations accumulate them
 * — and unlike the breadcrumb log they are NOT ndjson-rotated. So every
 * `writeHeapSnapshotNow()` prunes the snapshot directory down to the newest
 * `SNAPSHOT_RETENTION` files after writing. Keeping the NEWEST N (not pinning
 * the earliest, the opposite of `debug-handles.ts`'s creation-site tracker) is
 * the correct policy HERE: an operator triggers each snapshot deliberately to
 * capture the CURRENT grown state of a long-lived instance, so the latest
 * snapshots ARE the evidence — there is no "leak hides among the earliest
 * handles" ordering to protect, as there is for the handle tracer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as v8 from "node:v8";
import { getGlobalPiLensLogDir } from "./probe-home-state.js";
import { getMaxLogSizeMB } from "./log-rotation-limits.js";
import { createNdjsonLogger, type NdjsonLogger } from "./ndjson-logger.js";

/** Read once at module load — see module docstring. Not re-read per call. */
const DEBUG_HEAP_ENABLED = process.env.PI_LENS_DEBUG_HEAP === "1";

/** Newest-N `.heapsnapshot` files kept in the pi-lens dir; older ones are
 *  pruned after every write. See the module docstring's shape-9 note for why
 *  newest-kept (not earliest-pinned) is the right retention policy here. */
export const SNAPSHOT_RETENTION = 3;

const SNAPSHOT_PREFIX = "heap-";
const SNAPSHOT_SUFFIX = ".heapsnapshot";

const HEAP_SNAPSHOT_LOG_FILE = path.join(
	getGlobalPiLensLogDir(),
	"heap-snapshots.log",
);

// Only ever constructed when the flag is on — the entire cost of this module
// when unset is the one boolean check at the top of each export below.
const writer: NdjsonLogger | null = DEBUG_HEAP_ENABLED
	? createNdjsonLogger({
			filePath: HEAP_SNAPSHOT_LOG_FILE,
			maxBytes: getMaxLogSizeMB() * 1024 * 1024,
		})
	: null;

/** True iff `PI_LENS_DEBUG_HEAP=1` was set when this module first loaded. */
export function isDebugHeapEnabled(): boolean {
	return DEBUG_HEAP_ENABLED;
}

export function getHeapSnapshotLogPath(): string {
	return HEAP_SNAPSHOT_LOG_FILE;
}

/** Resolve once all enqueued breadcrumb writes are on disk (tests). */
export function flushHeapSnapshotLog(): Promise<void> {
	return writer ? writer.flush() : Promise.resolve();
}

/**
 * PURE: build a filesystem-safe snapshot filename. The ISO timestamp's `:`/`.`
 * are illegal in Windows paths, so they are folded to `-` (this repo develops
 * on Windows; see AGENTS.md's OS-agnostic rule). Exported for tests.
 */
export function snapshotFileName(pid: number, isoTs: string): string {
	return `${SNAPSHOT_PREFIX}${pid}-${isoTs.replace(/[:.]/g, "-")}${SNAPSHOT_SUFFIX}`;
}

/**
 * Prune the snapshot directory to the newest `keep` `.heapsnapshot` files,
 * deleting older ones (bounds the growing on-disk axis — see the module
 * docstring). Best-effort: unreadable dir / unstattable / undeletable files are
 * skipped, never thrown. Returns the paths actually removed (for tests).
 */
export function pruneOldSnapshots(
	dir: string,
	keep: number = SNAPSHOT_RETENTION,
): string[] {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const snapshots = names
		.filter(
			(name) =>
				name.startsWith(SNAPSHOT_PREFIX) && name.endsWith(SNAPSHOT_SUFFIX),
		)
		.map((name) => {
			const full = path.join(dir, name);
			let mtimeMs = 0;
			try {
				mtimeMs = fs.statSync(full).mtimeMs;
			} catch {
				// unstattable (racing delete): sorts oldest, pruned first
			}
			return { full, mtimeMs };
		})
		.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

	const removed: string[] = [];
	for (const stale of snapshots.slice(Math.max(0, keep))) {
		try {
			fs.rmSync(stale.full, { force: true });
			removed.push(stale.full);
		} catch {
			// best-effort — a failed prune must never break the caller
		}
	}
	return removed;
}

export interface HeapSnapshotResult {
	/** Absolute path of the `.heapsnapshot` file written. */
	path: string;
	/** `process.memoryUsage().rss` at capture time — the number the snapshot
	 *  explains, echoed so the breadcrumb and file are self-describing. */
	rssBytes: number;
	/** Wall-clock ms the synchronous snapshot write took (its process pause). */
	durationMs: number;
}

/**
 * Write one heap snapshot to `~/.pi-lens/`, append a breadcrumb line, and prune
 * to the newest `SNAPSHOT_RETENTION` files. A pure no-op returning `null` — no
 * file, no allocation past the flag check — when `PI_LENS_DEBUG_HEAP` was unset
 * at startup. `label` records the trigger (currently only `"lens_health"`).
 */
export function writeHeapSnapshotNow(label: string): HeapSnapshotResult | null {
	if (!DEBUG_HEAP_ENABLED) return null;
	const dir = getGlobalPiLensLogDir();
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch {
		// dir already exists / unwritable — writeHeapSnapshot will surface it
	}
	const ts = new Date().toISOString();
	const target = path.join(dir, snapshotFileName(process.pid, ts));
	const rssBytes = process.memoryUsage().rss;
	const start = Date.now();
	let written: string;
	try {
		// Returns the filename it actually wrote to.
		written = v8.writeHeapSnapshot(target);
	} catch {
		// A snapshot can fail under memory pressure — the very condition it is
		// most wanted in. Best-effort: report failure by returning null rather
		// than throwing into the diagnostics command.
		return null;
	}
	const durationMs = Date.now() - start;
	pruneOldSnapshots(dir);
	writer?.log({
		ts,
		label,
		path: written,
		pid: process.pid,
		rssBytes,
		durationMs,
	});
	return { path: written, rssBytes, durationMs };
}
