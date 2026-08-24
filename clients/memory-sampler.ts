/**
 * Periodic memory-attribution sample (#1123 item 2, expanded on top of item 1's
 * loop_block windowing — the #1126 sizing study's "instrumentation the next
 * report should add" list is this module's requirements).
 *
 * The #1126 sizing study diagnosed a 1.37 GB instance from code + serialized
 * artifacts alone, because nothing recorded a per-subsystem trajectory over
 * time — the same detection-without-attribution gap loop_block had before
 * #1122/#1125. This module answers "what is resident right now, broken down
 * by subsystem" as a single ndjson `memory_sample` `latency.log` line, emitted
 * every `MEMORY_SAMPLE_TURN_INTERVAL` turns (cheap enough not to need finer
 * throttling).
 *
 * HARD CONSTRAINT: every field here is an O(1) `Map`/array `.size`/`.length`
 * read, or a `process.memoryUsage()` call — nothing here iterates a large
 * structure's contents, and nothing takes a heap snapshot. `PI_LENS_DEBUG_HEAP`
 * (item 4's memory sibling) is a SEPARATE, explicitly opt-in mechanism, out of
 * scope here.
 *
 * WASM linear-memory byte length gap (documented, not silently dropped): the
 * #1126 spec asked for `Module.wasmMemory.buffer.byteLength` off the
 * web-tree-sitter parser runtime. Inspecting the installed web-tree-sitter
 * 0.25.10 package (see `clients/tree-sitter-client.ts#getRuntimeStats`'s
 * docstring) confirmed that value is not reachable through any public export
 * — only through package-internal reflection or by overriding Emscripten's
 * `wasmMemory` module option with a hand-built `WebAssembly.Memory` (a
 * stability risk for an observability-only feature, given a memory-import
 * mismatch would break structural analysis entirely). `process.memoryUsage()`
 * `arrayBuffers` is used as the process-wide proxy instead — WASM linear
 * memory backs an ArrayBuffer, so it is already included there.
 */

import type { WordIndex } from "./word-index.js";
import { getSharedTreeSitterClient } from "./tree-sitter-shared.js";
import { getReviewGraphWorkspaceCacheSnapshot } from "./review-graph/builder.js";
import { getDispatchCascadeCacheStats } from "./dispatch/integration.js";

/** Every N turns, emit one `memory_sample` latency.log line (#1123 item 2). */
export const MEMORY_SAMPLE_TURN_INTERVAL = 10;

/** True on turn 10, 20, 30, ... — never on turn 0 (nothing meaningful is
 *  resident yet at session start). Pure so the cadence is unit-testable
 *  without driving a real turn loop. */
export function shouldEmitMemorySample(turnIndex: number): boolean {
	return turnIndex > 0 && turnIndex % MEMORY_SAMPLE_TURN_INTERVAL === 0;
}

/**
 * Rising-edge cadence (#1999): when heapUsed grows more than
 * {@link HEAP_GROWTH_TIGHTEN_RATIO} between two sampled turns, sampling
 * tightens from every {@link MEMORY_SAMPLE_TURN_INTERVAL} turns to every turn
 * until growth stabilizes. The state below is module-scoped SESSION state —
 * reset it at every primary `session_start` via
 * {@link resetMemorySamplerCadence} (defect shape 17: a process-lifetime latch
 * holding a session-scoped signal).
 */
export const HEAP_GROWTH_TIGHTEN_RATIO = 1.2;

let _lastSampledHeapUsedBytes = 0;
let _tightenThroughTurn = 0;

/** Clear the rising-edge cadence state. Called on primary session_start. */
export function resetMemorySamplerCadence(): void {
	_lastSampledHeapUsedBytes = 0;
	_tightenThroughTurn = 0;
}

/** PURE: >20% heap growth between two sampled readings warrants tightening. */
export function isRapidHeapGrowth(
	previousHeapUsedBytes: number,
	currentHeapUsedBytes: number,
): boolean {
	return (
		previousHeapUsedBytes > 0 &&
		currentHeapUsedBytes > previousHeapUsedBytes * HEAP_GROWTH_TIGHTEN_RATIO
	);
}

/** Record the heap reading of a sample just emitted at `turnIndex`. A rapid
 *  growth edge extends the tightened window through the NEXT turn; each
 *  subsequent still-growing sample (including one taken inside an already
 *  tightened window) extends it again, so the window naturally expires once
 *  growth stabilizes. Monotonic max so an out-of-order turn can never shrink
 *  the window. O(1). */
export function recordMemorySampleOutcome(
	heapUsedBytes: number,
	turnIndex: number,
): void {
	if (isRapidHeapGrowth(_lastSampledHeapUsedBytes, heapUsedBytes)) {
		_tightenThroughTurn = Math.max(_tightenThroughTurn, turnIndex + 1);
	}
	_lastSampledHeapUsedBytes = heapUsedBytes;
}

/** Adaptive gate used by turn_end: base every-10 cadence OR an open tightened
 *  window. Pure w.r.t. its argument; the window itself is session state owned
 *  by {@link recordMemorySampleOutcome}. */
export function shouldEmitMemorySampleAdaptive(turnIndex: number): boolean {
	if (turnIndex <= 0) return false;
	return (
		turnIndex % MEMORY_SAMPLE_TURN_INTERVAL === 0 ||
		turnIndex <= _tightenThroughTurn
	);
}

export interface MemoryProcessUsage {
	rssBytes: number;
	heapUsedBytes: number;
	heapTotalBytes: number;
	externalBytes: number;
	arrayBuffersBytes: number;
	/** OS high-water mark (#1999): `process.resourceUsage().maxRSS` × 1024.
	 *  On Windows libuv backs BOTH this and `rssBytes` with the same
	 *  `GetProcessMemoryInfo()` call — rss reads `WorkingSetSize` (current),
	 *  maxRSS reads `PeakWorkingSetSize` (high-water) — see libuv
	 *  src/win/util.c `uv_resident_set_memory`. So `rss` IS the OS current
	 *  working set at sample time (tasklist's "Mem Usage" column); there is no
	 *  second live counter to cross-check it against, hence no separate OS call
	 *  here. The #1999 "327MB sample vs 1767MB tasklist" gap is TEMPORAL, not
	 *  counter divergence: the sampler fired at an idle/trimmed moment while
	 *  tasklist observed a peak. `peakWorkingSetBytes` makes that distinguishable
	 *  from logs alone: rss ≪ peak ⇒ samples are catching valleys, not missing
	 *  growth. `null` when the reading is unavailable. */
	peakWorkingSetBytes: number | null;
}

/** PURE: reshape Node's `process.memoryUsage()` (+ optional
 *  `process.resourceUsage()`) into this module's field names — testable
 *  without touching the real process. */
export function toMemoryProcessUsage(
	mem: NodeJS.MemoryUsage,
	resourceUsage?: Partial<NodeJS.ResourceUsage>,
): MemoryProcessUsage {
	const maxKb = resourceUsage?.maxRSS;
	return {
		rssBytes: mem.rss,
		heapUsedBytes: mem.heapUsed,
		heapTotalBytes: mem.heapTotal,
		externalBytes: mem.external,
		arrayBuffersBytes: mem.arrayBuffers,
		peakWorkingSetBytes:
			typeof maxKb === "number" && Number.isFinite(maxKb) && maxKb > 0
				? maxKb * 1024
				: null,
	};
}

export interface MemorySampleSubsystems {
	reviewGraph: {
		cacheEntries: number;
		totalNodes: number;
		totalEdges: number;
	};
	/** `null` when no word index has been built yet this session. */
	wordIndex: {
		docs: number;
		postings: number;
		forwardEntries: number;
	} | null;
	/** `null` when the shared tree-sitter client hasn't been created yet
	 *  (WASM runtime never touched this session) or has aborted. */
	treeSitter: {
		languagesLoaded: number;
		parsersLoaded: number;
		queryCacheSize: number;
		queryBatchCacheSize: number;
		treeCacheSize: number;
		treeCacheMaxSize: number;
		treeCacheTotalBytes: number;
	} | null;
	dispatchCaches: {
		recentlyCleanNeighborCacheSize: number;
	};
}

/** Session-age ridealong (#1999): lets growth-vs-age curves be plotted from
 *  latency.log alone. */
export interface MemorySampleSessionContext {
	sessionAgeMs: number;
	sessionStartedAt: number;
	turnCount: number;
}

export interface MemorySample {
	process: MemoryProcessUsage;
	subsystems: MemorySampleSubsystems;
	/** Present only when the caller supplies session context. */
	session?: MemorySampleSessionContext;
}

/**
 * Live O(1)/O(bounded-cache-size) subsystem counters. Impure (reads
 * process-global singletons) but every individual read is a `.size`/`.length`
 * access — see the module docstring's hard constraint.
 */
export function collectMemorySampleSubsystems(
	wordIndex: WordIndex | null,
): MemorySampleSubsystems {
	const reviewGraph = getReviewGraphWorkspaceCacheSnapshot();

	const treeSitterClient = getSharedTreeSitterClient();
	const treeSitter = treeSitterClient
		? (() => {
				const runtimeStats = treeSitterClient.getRuntimeStats();
				const cacheStats = treeSitterClient.getParseCacheStats();
				return {
					...runtimeStats,
					treeCacheSize: cacheStats.size,
					treeCacheMaxSize: cacheStats.maxSize,
					treeCacheTotalBytes: cacheStats.totalBytes,
				};
			})()
		: null;

	const dispatchCaches = getDispatchCascadeCacheStats();

	return {
		reviewGraph,
		wordIndex: wordIndex
			? {
					docs: wordIndex.docLengths.size,
					postings: wordIndex.postings.size,
					forwardEntries: wordIndex.forward?.size ?? 0,
				}
			: null,
		treeSitter,
		dispatchCaches,
	};
}

/** Assemble one full sample. `mem` is injectable for tests; defaults to a
 *  live `process.memoryUsage()` read. `resourceUsage` (peak working set) and
 *  `session` are optional ridealongs (#1999); when `resourceUsage` is omitted
 *  a live `process.resourceUsage()` read supplies the peak. */
export function buildMemorySample(
	wordIndex: WordIndex | null,
	mem: NodeJS.MemoryUsage = process.memoryUsage(),
	resourceUsage?: Partial<NodeJS.ResourceUsage>,
	session?: MemorySampleSessionContext,
): MemorySample {
	let resolvedResourceUsage = resourceUsage;
	if (!resolvedResourceUsage) {
		try {
			resolvedResourceUsage = process.resourceUsage();
		} catch {
			resolvedResourceUsage = undefined;
		}
	}
	return {
		process: toMemoryProcessUsage(mem, resolvedResourceUsage),
		subsystems: collectMemorySampleSubsystems(wordIndex),
		session,
	};
}

const toMb = (bytes: number): number => Math.round(bytes / (1024 * 1024));

/**
 * PURE: one compact `/lens-health` line reusing the same sample the periodic
 * latency.log emitter builds — RSS + heap/external, plus the two subsystem
 * numbers most useful for spotting an attribution outlier at a glance: the
 * tree-sitter tree-cache byte total (the only subsystem counter here that is
 * ALREADY in bytes, so it's directly comparable to RSS) and the review-graph
 * node/edge counts (the multiple-graph-copies question #1126 called out).
 * Follows #1125's health-line style (a single summary line, no per-subsystem
 * breakdown table — that's what latency.log's `memory_sample` is for).
 */
export function formatMemoryHealthLine(sample: MemorySample): string {
	const { process: proc, subsystems } = sample;
	const treeCache = subsystems.treeSitter
		? `${toMb(subsystems.treeSitter.treeCacheTotalBytes)}MB (${subsystems.treeSitter.treeCacheSize} trees)`
		: "n/a";
	const graph = `${subsystems.reviewGraph.totalNodes}n/${subsystems.reviewGraph.totalEdges}e (${subsystems.reviewGraph.cacheEntries} cwd)`;
	// #1999: peak WS rides along when known — rss far below peak means the
	// periodic samples are catching idle valleys, not the true high-water mark.
	const peak =
		proc.peakWorkingSetBytes !== null
			? ` · peak WS ${toMb(proc.peakWorkingSetBytes)}MB`
			: "";
	return (
		`Memory: RSS ${toMb(proc.rssBytes)}MB · heap ${toMb(proc.heapUsedBytes)}/${toMb(proc.heapTotalBytes)}MB` +
		` · external ${toMb(proc.externalBytes)}MB${peak}` +
		` · tree-sitter cache ${treeCache} · review-graph ${graph}`
	);
}
