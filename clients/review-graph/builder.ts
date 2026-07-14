import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FactStore } from "../dispatch/fact-store.js";
import { fileContentProvider } from "../dispatch/facts/file-content.js";
import type { FunctionSummary } from "../dispatch/facts/function-facts.js";
import type { ImportEntry } from "../dispatch/facts/import-facts.js";
import type { DispatchContext } from "../dispatch/types.js";
import { featureHintMetadata } from "../feature-hints.js";
import { detectFileKind, KIND_EXTENSIONS } from "../file-kinds.js";
import { detectFileRole } from "../file-role.js";
import { getProjectDataDir } from "../file-utils.js";
import { logLatency } from "../latency-logger.js";
import {
	isAtOrAboveHomeDir,
	normalizeFilePath,
	normalizeMapKey,
} from "../path-utils.js";
import { collectProjectSourceFilesAsync } from "../project-scan-policy.js";
import { resolveImportToFiles } from "./import-resolvers.js";
import { RUNTIME_CONFIG } from "../runtime-config.js";
import { getSharedTreeSitterClient } from "../tree-sitter-shared.js";
import {
	type ExtractedSymbols,
	TreeSitterSymbolExtractor,
} from "../tree-sitter-symbol-extractor.js";
import { resolveGitIdentity } from "./git-identity.js";
import { buildSymbolId } from "./symbol-id.js";
import type { ReviewGraph, ReviewGraphEdge, ReviewGraphNode } from "./types.js";

// v3 (#260): test files are no longer indexed. Bumping the version makes
// loadPersistedGraph reject any v2 snapshot (which still contains test-file
// nodes/edges) → a clean tests-free rebuild on first load after upgrade, for
// every project, without anyone deleting the cache by hand.
// v4 (#655, narrow first slice): symbol-node IDs changed shape from
// `<file>:<name>` to `<file>:<name>:<kind>:<startLine>` (see symbol-id.ts) to
// stop overloads/same-named methods/nested functions from colliding onto one
// node. A v3 snapshot's nodes/edges still use the old ID shape throughout, so
// it must be rejected rather than merged with newly-built v4 IDs — same
// safe-rebuild mechanism as the v2→v3 bump above.
const REVIEW_GRAPH_VERSION = "v4";
const MAIN_KINDS = new Set([
	"jsts",
	"python",
	"go",
	"rust",
	"ruby",
	"cxx",
	// Languages added in #152: WASMs + symbol queries now available
	"java",
	"kotlin",
	"dart",
	"elixir",
	"csharp",
	"php",
	"swift",
	"lua",
	"ocaml",
	"zig",
	"shell",
]);

// File extensions for the kinds the graph actually ingests. Scoping the source
// walk to these means the maxGraphFiles cap counts only graph-relevant files —
// so a repo heavy in JSON/YAML/Markdown doesn't trip the cap on files the graph
// would have filtered out anyway (the cap is on the walk, not on noise). #250.
const MAIN_KIND_EXTENSIONS: string[] = Array.from(MAIN_KINDS).flatMap(
	(kind) => KIND_EXTENSIONS[kind as keyof typeof KIND_EXTENSIONS] ?? [],
);
const CHANGED_SYMBOLS_PREFIX = "session.reviewGraph.changedSymbols:";
const extractorCache = new Map<string, TreeSitterSymbolExtractor>();

// Per-invocation Promise cache: deduplicates concurrent buildOrUpdateGraph calls
// for the same (cwd, changedFiles). Cleared at the start of each pipeline
// invocation. A separate workspace cache below preserves the expensive parsed
// graph across invocations when source file mtimes/sizes have not changed.
const _buildCache = new Map<string, Promise<ReviewGraph>>();
const _workspaceGraphCache = new Map<
	string,
	{
		signature: string;
		fileSignatures: Map<string, string>;
		fileHashes?: Map<string, string>;
		graph: ReviewGraph;
		/**
		 * The RuntimeCoordinator projectSeq at the time this entry was built (#451).
		 * Only set on entries built in-process with a seqHint present. An entry
		 * hydrated from the disk snapshot has none ⇒ no seq fast path for it until a
		 * seq-hinted build records one.
		 */
		builtAtProjectSeq?: number;
		/** Wall-clock of the last full walk+stat verify — bounds staleness vs external edits (#451). */
		lastFullVerifyMs?: number;
		/** Count of consecutive seq fast-path builds since the last full verify (#451). */
		fastPathSinceVerify?: number;
		/** #459: generation of this entry's graph content — see ReviewGraph.buildGeneration. */
		buildGeneration?: number;
	}
>();

// #459: process-wide monotonic source for ReviewGraph.buildGeneration stamps.
// Never reset (uniqueness is the invariant — a workspace-cache clear must not
// let a new build collide with a generation a derived-data cache recorded
// earlier in the same process).
let _graphGenerationCounter = 0;

/**
 * RuntimeCoordinator sequence hint (#451). Threaded from the deferred cascade so
 * the builder can ask "which files changed since I last built?" and skip its
 * per-build O(project) walk+stat sweep. Optional end-to-end: absent ⇒ today's
 * behavior exactly.
 */
export interface GraphSeqHint {
	projectSeq: () => number;
	getFilesChangedSince: (seq: number) => string[];
}

/** Beyond this many seq-changed files, incremental re-extract nears sweep cost — just sweep (#451). */
const SEQ_FASTPATH_MAX_CHANGES = 32;
/** Force a full walk+stat re-verify at least this often in wall time (external-edit safety valve, #451). */
const SEQ_FASTPATH_REVERIFY_MS = 5 * 60_000;
/** ...and at least every Nth fast-path build per workspace. */
const SEQ_FASTPATH_REVERIFY_EVERY = 20;

type SeqFastpathFallback =
	| "no-seq"
	| "too-many-changes"
	| "new-file"
	| "verify-due"
	| "removed-file"
	| "stat-error";

export type GraphBuildInfo = {
	reused: boolean;
	mode: "full" | "cached" | "incremental" | "skipped" | "seq-fastpath";
	skipReason?: string;
	sourceFileCount?: number;
	maxFileCount?: number;
	/** When the seq fast path was attempted but fell back to the sweep (#451). */
	seqFastpathFallback?: SeqFastpathFallback;
	/**
	 * #459: whether this build changed the graph content. `mode` alone is NOT
	 * enough to tell — both "cached" and "seq-fastpath" cover a real no-op AND
	 * (for seq-fastpath) a genuine incremental re-extract, depending on whether
	 * any files actually needed re-parsing. INFORMATIONAL (logs) ONLY: this
	 * lives in a single global slot that overlapping deferred cascades can
	 * clobber between a build and its caller's read, so derived-data caches
	 * must key invalidation off `ReviewGraph.buildGeneration` (which travels
	 * with the returned instance), never off this flag.
	 */
	graphChanged: boolean;
};

function seqFastpathEnabled(): boolean {
	const raw = process.env.PI_LENS_GRAPH_SEQ_FASTPATH;
	return raw !== "0" && raw !== "false";
}

let _lastGraphBuildInfo: GraphBuildInfo = {
	reused: false,
	mode: "full",
	graphChanged: true,
};

export function clearGraphCache(): void {
	_buildCache.clear();
}

export function clearReviewGraphWorkspaceCache(): void {
	_buildCache.clear();
	_workspaceGraphCache.clear();
	_lastGraphBuildInfo = { reused: false, mode: "full", graphChanged: true };
}

// #300 Edge 2: the review-graph's cross-worktree isolation is INCIDENTAL to
// the cwd-derived data-dir slug (getProjectDataDir) — it holds only because
// every process is launched with its own worktree as cwd. If a host ever
// passes the main repo root as cwd while editing worktree files by absolute
// path, that assumption silently breaks. This doesn't hard-fail (the issue
// is explicit: log-once observability is enough) — it just makes the
// assumption visible. The Set records every cwd whose check has RUN (not just
// mismatches), so resolveGitIdentity's fs reads happen once per cwd per
// process — zero per-build cost after the first, mismatch or not.
const _cwdWorktreeCheckedCwds = new Set<string>();

export function _resetCwdWorktreeMismatchLogForTests(): void {
	_cwdWorktreeCheckedCwds.clear();
}

function logCwdWorktreeMismatchOnce(cwd: string): void {
	const key = normalizeMapKey(cwd);
	if (_cwdWorktreeCheckedCwds.has(key)) return;
	_cwdWorktreeCheckedCwds.add(key);
	const identity = resolveGitIdentity(cwd);
	if (!identity) return; // not a git repo — nothing to compare against
	if (identity.worktreeRoot === normalizeFilePath(path.resolve(cwd))) return;
	logLatency({
		type: "phase",
		phase: "review_graph_cwd_worktree_mismatch",
		filePath: cwd,
		durationMs: 0,
		metadata: { cwd, worktreeRoot: identity.worktreeRoot },
	});
}

export function getLastGraphBuildInfo(): GraphBuildInfo {
	return _lastGraphBuildInfo;
}

/**
 * Read-only access to the already-built review graph for `cwd` — NEVER builds.
 * Returns a query-ready clone of the in-memory cached graph if one exists, else
 * undefined. For read-substitute callers (module_report, #256) that must not
 * trigger a synchronous full rebuild on the agent's call path: a full build
 * re-runs every fact provider (TS-compiler ASTs for jsts, tree-sitter for the
 * rest), and two of those racing OOM'd pi. Callers degrade to outline-only when
 * this returns undefined; the live edit pipeline keeps the cache warm so in pi it
 * is almost always present (possibly a few edits stale, which is fine for a
 * navigation read).
 */
// Stored snapshots are cloned with EMPTY index maps (see cloneGraph). Build them
// once, in place, so the read accessor can hand back the cached object directly
// instead of clone+reindex on every call (#260: module_report was burning
// 200-425ms each over a 13.5MB graph). The snapshot is never mutated after
// caching — a new build replaces the map entry rather than editing in place — so
// the populated indexes stay valid and the object is safe to share read-only.
function ensureIndexed(graph: ReviewGraph): void {
	if (graph.edges.length > 0 && graph.edgesByFrom.size === 0) {
		rebuildIndexes(graph);
	}
}

/**
 * READ-ONLY accessor. Returns the cached graph as a SHARED, already-indexed
 * object — callers (module_report's outline + blast radius) must not mutate it. No clone,
 * no per-call reindex.
 */
export function getCachedReviewGraph(cwd: string): ReviewGraph | undefined {
	const key = normalizeMapKey(cwd);
	const cached = _workspaceGraphCache.get(key);
	if (cached) {
		ensureIndexed(cached.graph);
		return cached.graph;
	}
	// Tier 3: the persisted disk snapshot. This is the cross-PROCESS path — the
	// edit pipeline (one process) persists the graph; a separate module_report
	// process reads it here instead of seeing an empty in-memory cache (the
	// "graph: cold" symptom). Possibly a few edits stale, which is fine for a
	// navigation read. Warm the in-memory cache so repeat reads in this process
	// skip the disk read. loadPersistedGraph already rebuilt the indexes.
	// #300: this read is BLIND — nothing downstream content-verifies it, so a
	// stamped snapshot from a different HEAD/worktree must be dropped here.
	const disk = loadPersistedGraph(cwd, { verifyGitStamp: true });
	if (!disk) return undefined;
	_workspaceGraphCache.set(key, {
		signature: disk.signature,
		fileSignatures: disk.fileSignatures,
		fileHashes: disk.fileHashes,
		graph: disk.graph,
	});
	return disk.graph;
}

function makeCtx(
	filePath: string,
	cwd: string,
	facts: FactStore,
): DispatchContext {
	return {
		filePath,
		cwd,
		kind: detectFileKind(filePath),
		fileRole: detectFileRole(filePath),
		pi: { getFlag: () => undefined },
		autofix: false,
		deltaMode: false,
		facts,
		blockingOnly: false,
		modifiedRanges: undefined,
		hasTool: async () => false,
		log: () => {},
	};
}

function escapeRegExp(string: string): string {
	return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createEmptyGraph(): ReviewGraph {
	return {
		version: REVIEW_GRAPH_VERSION,
		builtAt: new Date().toISOString(),
		nodes: new Map(),
		edges: [],
		edgesByFrom: new Map(),
		edgesByTo: new Map(),
		fileNodes: new Map(),
		symbolNodesByFile: new Map(),
		changedSymbolsByFile: new Map(),
	};
}

function cloneGraph(graph: ReviewGraph): ReviewGraph {
	return {
		version: graph.version,
		builtAt: graph.builtAt,
		nodes: new Map(graph.nodes),
		edges: graph.edges.map((edge) => ({ ...edge })),
		edgesByFrom: new Map(),
		edgesByTo: new Map(),
		fileNodes: new Map(),
		symbolNodesByFile: new Map(),
		changedSymbolsByFile: new Map(graph.changedSymbolsByFile),
	};
}

function sourceSignatureEntry(file: string): string {
	try {
		const stat = fs.statSync(file);
		return `${stat.size}:${stat.mtimeMs}`;
	} catch {
		return "missing";
	}
}

// Chunked-yield budget for the per-edit signature/stat loops. 100 stat calls
// per chunk keeps each synchronous burst well under pi's typing window while
// adding negligible scheduling overhead. The work and its output are identical
// to a tight synchronous loop — only the loop yields the event loop between
// chunks so a large project's cascade graph rebuild can't freeze the TUI.
const STAT_YIELD_EVERY = 100;

const yieldToLoop = (): Promise<void> =>
	new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Async, chunked-yield twin of the per-file source-signature map. Produces the
 * exact same `file -> "size:mtimeMs"` map as a synchronous loop, but yields to
 * the event loop every {@link STAT_YIELD_EVERY} stats. Used on the per-edit
 * cascade path where statting every project file synchronously would otherwise
 * block the loop for hundreds of ms on a large repo.
 */
async function sourceSignatureMapAsync(
	files: string[],
): Promise<Map<string, string>> {
	const signatures = new Map<string, string>();
	let sinceYield = 0;
	for (const file of files) {
		signatures.set(file, sourceSignatureEntry(file));
		if (++sinceYield >= STAT_YIELD_EVERY) {
			sinceYield = 0;
			await yieldToLoop();
		}
	}
	return signatures;
}

function sourceSignatureFromMap(signatures: Map<string, string>): string {
	return [...signatures.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([file, signature]) => `${file}:${signature}`)
		.join("|");
}

function contentHashEntry(file: string): string {
	try {
		// sha256, not for security — a content fingerprint for change detection;
		// avoids SonarCloud's weak-hash (sha1/md5) flag.
		return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
	} catch {
		return "missing";
	}
}

/**
 * Async, chunked-yield content-hash map for a set of files. Used at full build
 * to record per-file content hashes so a later run can tell a *content* change
 * apart from pure mtime/size drift (formatter no-op, git checkout) — see
 * {@link confirmContentChanged}. Reads file bytes, so it runs only on the
 * (rare) full-build path, not the per-edit signature loop.
 */
async function sourceHashMapAsync(
	files: string[],
): Promise<Map<string, string>> {
	const hashes = new Map<string, string>();
	let sinceYield = 0;
	for (const file of files) {
		hashes.set(file, contentHashEntry(file));
		if (++sinceYield >= STAT_YIELD_EVERY) {
			sinceYield = 0;
			await yieldToLoop();
		}
	}
	return hashes;
}

/**
 * #202: confirm which mtime/size-changed candidates actually changed CONTENT. A
 * candidate whose content hash matches the prior hash is pure mtime drift —
 * reusing its already-parsed graph nodes is safe. Returns the truly
 * content-changed subset plus the merged hash map (prior hashes + freshly
 * computed candidate hashes) for persisting. When prior hashes are absent (a
 * pre-#202 cache), every candidate reports as changed, so behavior degrades
 * exactly to the old mtime-only logic — never a false reuse.
 */
async function confirmContentChanged(
	candidates: string[],
	previousHashes: Map<string, string> | undefined,
): Promise<{ trulyChanged: string[]; hashes: Map<string, string> }> {
	const prior = previousHashes ?? new Map<string, string>();
	const hashes = new Map(prior);
	const trulyChanged: string[] = [];
	let sinceYield = 0;
	for (const file of candidates) {
		const hash = contentHashEntry(file);
		hashes.set(file, hash);
		if (prior.get(file) !== hash) trulyChanged.push(file);
		if (++sinceYield >= STAT_YIELD_EVERY) {
			sinceYield = 0;
			await yieldToLoop();
		}
	}
	return { trulyChanged, hashes };
}

interface SignatureDelta {
	added: string[];
	removed: string[];
	changed: string[];
}

/**
 * #202: structural delta between two source-signature maps. The predecessor
 * (changedSignatureFiles) returned undefined on ANY count change, so a single
 * newly-created file forced a full whole-repo rebuild — the dominant cause of
 * the multi-second graph_build spikes during a burst of new files (pi-lens has
 * no fs-watcher, so it learns of N new sibling files all at once on the next
 * edit). Reporting added / removed / changed explicitly lets an add-only or
 * change-only delta be applied incrementally — see {@link tryIncrementalFromCache}.
 */
function diffSignatureMaps(
	previous: Map<string, string>,
	next: Map<string, string>,
): SignatureDelta {
	const added: string[] = [];
	const changed: string[] = [];
	for (const [file, signature] of next) {
		const oldSignature = previous.get(file);
		if (oldSignature === undefined) added.push(file);
		else if (oldSignature !== signature) changed.push(file);
	}
	const removed: string[] = [];
	for (const file of previous.keys()) {
		if (!next.has(file)) removed.push(file);
	}
	return { added, removed, changed };
}

function getReviewGraphMaxFiles(): number {
	const override = Number.parseInt(
		process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES ?? "",
		10,
	);
	return Number.isFinite(override) && override > 0
		? override
		: RUNTIME_CONFIG.reviewGraph.maxFiles;
}

function getReviewGraphMaxFileBytes(): number {
	const override = Number.parseInt(
		process.env.PI_LENS_REVIEW_GRAPH_MAX_FILE_BYTES ?? "",
		10,
	);
	return Number.isFinite(override) && override > 0
		? override
		: RUNTIME_CONFIG.reviewGraph.maxFileBytes;
}

function isWithinReviewGraphSizeLimit(file: string): boolean {
	try {
		return fs.statSync(file).size <= getReviewGraphMaxFileBytes();
	} catch {
		return false;
	}
}

async function getGraphSourceFiles(cwd: string): Promise<string[]> {
	// Async, chunked-yield walk (identical output to the sync collector) so the
	// per-edit cascade graph rebuild doesn't block the event loop on a large repo.
	//
	// Cap the walk at maxGraphFiles+1: an over-limit repo (or a root that climbed
	// to $HOME) short-circuits collection instead of enumerating the entire tree
	// and paying a statSync per file before the caller bails on count (#250). When
	// the cap is hit the caller skips the build on count alone, so the unfiltered
	// over-limit list is all it needs — see _doBuildGraph's too_many_files branch.
	const maxGraphFiles = getReviewGraphMaxFiles();
	const collected = await collectProjectSourceFilesAsync(cwd, {
		// Only walk graph-relevant extensions so the cap counts what the graph
		// keeps (post-filter), not JSON/YAML/MD noise it would discard anyway.
		extensions: MAIN_KIND_EXTENSIONS,
		maxFiles: maxGraphFiles + 1,
	});
	if (collected.length > maxGraphFiles) {
		// Contents are unused by the too_many_files branch; return the capped list
		// so the caller's `length > maxGraphFiles` check still trips.
		return collected;
	}
	const result: string[] = [];
	let sinceYield = 0;
	for (const raw of collected) {
		const file = normalizeMapKey(raw);
		const kind = detectFileKind(file);
		// isWithinReviewGraphSizeLimit does a statSync per file — yield periodically
		// so the size-limit filter (one stat each) can't hold the loop in one burst.
		// #260: test files are NOT graph-relevant (a heavily-tested repo was ~56%
		// tests, bloating the graph + every build/clone/serialize). The role check
		// is pure string work, so it also short-circuits the per-file statSync.
		if (
			!!kind &&
			MAIN_KINDS.has(kind) &&
			detectFileRole(file) !== "test" &&
			isWithinReviewGraphSizeLimit(file)
		) {
			result.push(file);
		}
		if (++sinceYield >= STAT_YIELD_EVERY) {
			sinceYield = 0;
			await yieldToLoop();
		}
	}
	return result;
}

function addNode(graph: ReviewGraph, node: ReviewGraphNode): void {
	graph.nodes.set(node.id, node);
	if (node.kind === "file" && node.filePath) {
		graph.fileNodes.set(node.filePath, node.id);
	}
}

function addEdge(graph: ReviewGraph, edge: ReviewGraphEdge): void {
	graph.edges.push(edge);
	const from = graph.edgesByFrom.get(edge.from) ?? [];
	from.push(edge);
	graph.edgesByFrom.set(edge.from, from);
	const to = graph.edgesByTo.get(edge.to) ?? [];
	to.push(edge);
	graph.edgesByTo.set(edge.to, to);
}

function rebuildIndexes(graph: ReviewGraph): void {
	graph.edgesByFrom = new Map();
	graph.edgesByTo = new Map();
	graph.fileNodes = new Map();
	graph.symbolNodesByFile = new Map();
	for (const node of graph.nodes.values()) {
		if (node.kind === "file" && node.filePath) {
			graph.fileNodes.set(node.filePath, node.id);
		}
		if (node.kind === "symbol" && node.filePath) {
			const ids = graph.symbolNodesByFile.get(node.filePath) ?? [];
			ids.push(node.id);
			graph.symbolNodesByFile.set(node.filePath, ids);
		}
	}
	for (const edge of graph.edges) {
		const from = graph.edgesByFrom.get(edge.from) ?? [];
		from.push(edge);
		graph.edgesByFrom.set(edge.from, from);
		const to = graph.edgesByTo.get(edge.to) ?? [];
		to.push(edge);
		graph.edgesByTo.set(edge.to, to);
	}
}

const GRAPH_CACHE_FILENAME = "review-graph.json";

interface PersistedGraphData {
	version: string;
	builtAt: string;
	signature: string;
	fileSignatures?: Array<[string, string]>;
	fileHashes?: Array<[string, string]>;
	nodes: Array<[string, ReviewGraphNode]>;
	edges: ReviewGraphEdge[];
	// #300: git identity captured at persist time (fs-resolved, no `git` spawn —
	// see git-identity.ts). Optional so an older snapshot without a stamp still
	// loads exactly as before — only a PRESENT stamp that MISMATCHES the current
	// repo drops the snapshot. Absent for non-git cwds (no check possible).
	gitStamp?: { headCommit: string; worktreeRoot: string };
}

function loadPersistedGraph(
	cwd: string,
	opts?: { verifyGitStamp?: boolean },
): {
	signature: string;
	fileSignatures: Map<string, string>;
	fileHashes: Map<string, string>;
	graph: ReviewGraph;
} | null {
	const cachePath = path.join(getProjectDataDir(cwd), "cache", GRAPH_CACHE_FILENAME);
	try {
		const raw = fs.readFileSync(cachePath, "utf-8");
		const data = JSON.parse(raw) as PersistedGraphData;
		if (data.version !== REVIEW_GRAPH_VERSION) return null;
		if (opts?.verifyGitStamp && data.gitStamp) {
			// #300: a stamped snapshot must match the CURRENT repo identity. This
			// closes the "worktree removed + re-added at the same path for a
			// different branch" edge — the data-dir slug is reused, but the stamp
			// mismatch forces a cold rebuild instead of serving the old branch's
			// graph. Opt-in per call site: only the BLIND read path
			// (getCachedReviewGraph) verifies — the build path's tier-2 load is
			// already content-verified downstream (signature + #202 hash confirm),
			// and dropping there on every HEAD move would nuke the cold cache
			// after each commit. Any resolution failure (non-git, unreadable HEAD)
			// yields undefined from resolveGitIdentity — treated as "can't
			// verify," not a mismatch, so it does NOT drop the snapshot.
			const current = resolveGitIdentity(cwd);
			if (
				current &&
				(current.headCommit !== data.gitStamp.headCommit ||
					current.worktreeRoot !== data.gitStamp.worktreeRoot)
			) {
				return null;
			}
		}
		const graph: ReviewGraph = {
			version: data.version,
			builtAt: data.builtAt,
			nodes: new Map(data.nodes),
			edges: data.edges,
			edgesByFrom: new Map(),
			edgesByTo: new Map(),
			fileNodes: new Map(),
			symbolNodesByFile: new Map(),
			changedSymbolsByFile: new Map(),
		};
		rebuildIndexes(graph);
		return {
			signature: data.signature,
			fileSignatures: new Map(data.fileSignatures ?? []),
			fileHashes: new Map(data.fileHashes ?? []),
			graph,
		};
	} catch {
		return null;
	}
}

/**
 * The version string of the persisted graph, read cheaply from the HEAD of the
 * cache file (the `version` key is serialized first) — never parses the multi-MB
 * body. Returns null when no graph is persisted.
 */
function getPersistedReviewGraphVersion(cwd: string): string | null {
	const cachePath = path.join(
		getProjectDataDir(cwd),
		"cache",
		GRAPH_CACHE_FILENAME,
	);
	let fd: number | undefined;
	try {
		fd = fs.openSync(cachePath, "r");
		const buf = Buffer.alloc(200);
		const n = fs.readSync(fd, buf, 0, 200, 0);
		const match = buf.toString("utf-8", 0, n).match(/"version"\s*:\s*"([^"]+)"/);
		return match ? match[1] : null;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				/* ignore */
			}
		}
	}
}

/**
 * True when a persisted graph exists but was written under an OLDER
 * REVIEW_GRAPH_VERSION — a schema/scope change (#260: test exclusion) means it
 * must be rebuilt. The session bootstrap consults this to proactively rebuild
 * once after an upgrade, so reads aren't stranded cold until the next edit.
 * Returns false when nothing is persisted (a normal cold start builds on demand).
 */
export function isReviewGraphMigrationNeeded(cwd: string): boolean {
	const version = getPersistedReviewGraphVersion(cwd);
	return version !== null && version !== REVIEW_GRAPH_VERSION;
}

// --- Throttled, size-guarded graph persistence (circuit-breaker, #260) ---
// The whole graph is serialized as one blob. Doing that synchronously on every
// edit turn — `JSON.stringify` of a multi-MB graph plus number formatting for
// every line/complexity/fanout — spiked the host into a `Fatal ... Zone` OOM,
// especially when it overlapped the next build or the host's tsc. Two guards:
//   1. Coalesce: a burst of edits schedules ONE write after a quiet window,
//      instead of one full serialize per turn (the spike multiplier).
//   2. Ceiling: refuse to serialize a graph above an element cap (fail-safe —
//      log + skip rather than OOM the host; same fail-closed spirit as the
//      read-guard).
const GRAPH_PERSIST_DEBOUNCE_MS_DEFAULT = 1500;
const GRAPH_PERSIST_MAX_ELEMENTS_DEFAULT = 200_000;

function graphPersistDebounceMs(): number {
	const raw = Number(process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS);
	return Number.isFinite(raw) && raw >= 0
		? raw
		: GRAPH_PERSIST_DEBOUNCE_MS_DEFAULT;
}

function graphPersistMaxElements(): number {
	const raw = Number(process.env.PI_LENS_GRAPH_PERSIST_MAX_ELEMENTS);
	return Number.isFinite(raw) && raw > 0
		? raw
		: GRAPH_PERSIST_MAX_ELEMENTS_DEFAULT;
}

interface PendingPersist {
	cacheDir: string;
	cachePath: string;
	data: PersistedGraphData;
	elementCount: number;
}
const _pendingPersist = new Map<string, PendingPersist>();
const _persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

function writePending(key: string): void {
	const pending = _pendingPersist.get(key);
	if (!pending) return;
	_pendingPersist.delete(key);
	const timer = _persistTimers.get(key);
	if (timer) {
		clearTimeout(timer);
		_persistTimers.delete(key);
	}
	const startedAt = Date.now();
	let json: string;
	try {
		json = JSON.stringify(pending.data);
	} catch (err) {
		console.error(
			"[review-graph] cache serialize failed:",
			(err as Error).message,
		);
		return;
	}
	logLatency({
		type: "phase",
		phase: "review_graph_persist",
		filePath: pending.cachePath,
		durationMs: Date.now() - startedAt,
		metadata: { elements: pending.elementCount, bytes: json.length },
	});
	fs.mkdir(pending.cacheDir, { recursive: true }, (mkdirErr) => {
		if (mkdirErr) {
			console.error(
				"[review-graph] cache dir creation failed:",
				mkdirErr.message,
			);
			return;
		}
		// Write-to-temp + rename so the snapshot lands atomically: a reader
		// (another process's blind load, or the tier-2 disk load in tests) must
		// never see a created-but-partially-written file — that parses as
		// corrupt and silently forces a full rebuild. rename() replaces the
		// destination atomically on both POSIX and Windows (libuv uses
		// MOVEFILE_REPLACE_EXISTING).
		const tmpPath = `${pending.cachePath}.tmp-${process.pid}`;
		fs.writeFile(tmpPath, json, "utf-8", (writeErr) => {
			if (writeErr) {
				console.error("[review-graph] cache write failed:", writeErr.message);
				return;
			}
			fs.rename(tmpPath, pending.cachePath, (renameErr) => {
				if (renameErr) {
					console.error(
						"[review-graph] cache rename failed:",
						renameErr.message,
					);
					fs.rm(tmpPath, { force: true }, () => {});
				}
			});
		});
	});
}

// Flush any pending writes synchronously at process teardown so a debounced
// snapshot isn't lost. Sync writes only (no child spawn — see the teardown
// libuv hazard); best-effort.
let _persistExitHookInstalled = false;
function ensurePersistExitHook(): void {
	if (_persistExitHookInstalled) return;
	_persistExitHookInstalled = true;
	process.once("exit", () => {
		for (const [, pending] of _pendingPersist) {
			try {
				fs.mkdirSync(pending.cacheDir, { recursive: true });
				// Same atomic tmp+rename as writePending: even at teardown a crash
				// mid-write must not leave a truncated snapshot for the next start.
				const tmpPath = `${pending.cachePath}.tmp-${process.pid}`;
				fs.writeFileSync(tmpPath, JSON.stringify(pending.data), "utf-8");
				fs.renameSync(tmpPath, pending.cachePath);
			} catch {
				// Teardown is best-effort; a missed persist just re-confirms next start.
			}
		}
		_pendingPersist.clear();
	});
}

function persistGraph(
	cwd: string,
	signature: string,
	fileSignatures: Map<string, string>,
	fileHashes: Map<string, string> | undefined,
	graph: ReviewGraph,
): void {
	const elementCount = graph.nodes.size + graph.edges.length;
	const cap = graphPersistMaxElements();
	if (elementCount > cap) {
		// Fail-safe: a runaway graph would OOM the host on serialize. Skip + log.
		logLatency({
			type: "phase",
			phase: "review_graph_persist",
			filePath: cwd,
			durationMs: 0,
			metadata: { skipped: "size_cap", elements: elementCount, cap },
		});
		return;
	}
	const cacheDir = path.join(getProjectDataDir(cwd), "cache");
	const cachePath = path.join(cacheDir, GRAPH_CACHE_FILENAME);
	// #300: resolve the git stamp fresh at persist time (HEAD changes on
	// commit/checkout, so it isn't cached like the gitdir location — but these
	// are plain fs reads, cheap even called per-persist). undefined for
	// non-git cwds, which serializes as `gitStamp: undefined` → omitted key.
	const gitStamp = resolveGitIdentity(cwd);
	// Build the serializable shape now (cheap array views over the snapshot the
	// caller already cloned), but defer the expensive stringify+write to the
	// debounced flush so a burst of edits collapses to a single write.
	const data: PersistedGraphData = {
		version: graph.version,
		builtAt: graph.builtAt,
		signature,
		fileSignatures: Array.from(fileSignatures.entries()),
		fileHashes: fileHashes ? Array.from(fileHashes.entries()) : undefined,
		nodes: Array.from(graph.nodes.entries()),
		edges: graph.edges,
		gitStamp,
	};
	const key = normalizeMapKey(cwd);
	_pendingPersist.set(key, { cacheDir, cachePath, data, elementCount });
	ensurePersistExitHook();

	const debounce = graphPersistDebounceMs();
	const existing = _persistTimers.get(key);
	if (existing) clearTimeout(existing);
	if (debounce === 0) {
		writePending(key);
		return;
	}
	const timer = setTimeout(() => writePending(key), debounce);
	// Don't keep the event loop alive solely for a cache write.
	if (typeof timer.unref === "function") timer.unref();
	_persistTimers.set(key, timer);
}

/** Test hook: force any pending debounced persist to write immediately. */
export function flushReviewGraphPersistsForTests(): void {
	for (const key of [..._pendingPersist.keys()]) writePending(key);
}

function localImportToFile(
	cwd: string,
	filePath: string,
	source: string,
): string | undefined {
	if (!source.startsWith(".")) return undefined;
	const base = path.resolve(path.dirname(filePath), source);
	const candidates = [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		`${base}.js`,
		`${base}.jsx`,
		path.join(base, "index.ts"),
		path.join(base, "index.tsx"),
		path.join(base, "index.js"),
		path.join(base, "index.jsx"),
	];
	for (const candidate of candidates) {
		if (candidate.startsWith(path.resolve(cwd)) && fs.existsSync(candidate)) {
			return normalizeMapKey(candidate);
		}
	}
	return undefined;
}

function upsertChangedSymbols(
	graph: ReviewGraph,
	facts: FactStore,
	filePath: string,
): void {
	// #260: tests aren't in the graph, so don't track their changed symbols.
	if (detectFileRole(filePath) === "test") return;
	const normalized = normalizeMapKey(filePath);
	const changed = facts.getSessionFact<string[]>(
		`${CHANGED_SYMBOLS_PREFIX}${normalized}`,
	);
	if (changed && changed.length > 0) {
		graph.changedSymbolsByFile.set(normalized, [...changed]);
	} else {
		graph.changedSymbolsByFile.delete(normalized);
	}
}

async function ensureReviewGraphFacts(
	filePath: string,
	cwd: string,
	facts: FactStore,
): Promise<void> {
	const ctx = makeCtx(filePath, cwd, facts);
	await fileContentProvider.run(ctx, facts);
	// The import/function fact providers parse via the shared tree-sitter client
	// (#419/#402 — no `typescript` compiler). Loaded on demand + run here so
	// file.imports / file.reexports / file.functionSummaries are populated before
	// the graph reads them; if the parse stack is unavailable the graph builds
	// without structural facts rather than failing (the shared client loads
	// web-tree-sitter lazily, so that degrade otherwise lives at client.init()).
	try {
		const [{ importFactProvider }, { functionFactProvider }] =
			await Promise.all([
				import("../dispatch/facts/import-facts.js"),
				import("../dispatch/facts/function-facts.js"),
			]);
		// Both providers are async (tree-sitter parse) — await so the facts are
		// populated before the graph reads them.
		await importFactProvider.run(ctx, facts);
		await functionFactProvider.run(ctx, facts);
	} catch (err) {
		console.error(
			`[pi-lens] review-graph structural facts disabled (degraded mode): ${
				(err as Error)?.message ?? String(err)
			}`,
		);
	}
}

function addJsTsFile(
	graph: ReviewGraph,
	cwd: string,
	filePath: string,
	facts: FactStore,
): void {
	const normalized = normalizeMapKey(filePath);
	const content = facts.getFileFact<string>(normalized, "file.content") ?? "";
	const fileNodeId = `file:${normalized}`;
	addNode(graph, {
		id: fileNodeId,
		kind: "file",
		language: "jsts",
		filePath: normalized,
		metadata: {
			lineCount: content.split("\n").length,
			...featureHintMetadata(normalized),
		},
	});

	const imports =
		facts.getFileFact<ImportEntry[]>(normalized, "file.imports") ?? [];
	const functions =
		facts.getFileFact<FunctionSummary[]>(
			normalized,
			"file.functionSummaries",
		) ?? [];

	for (const entry of imports) {
		const localFile = localImportToFile(cwd, normalized, entry.source);
		if (localFile) {
			const targetId = `file:${localFile}`;
			if (!graph.nodes.has(targetId)) {
				addNode(graph, {
					id: targetId,
					kind: "file",
					language: detectFileKind(localFile) ?? "jsts",
					filePath: localFile,
				});
			}
			addEdge(graph, { from: fileNodeId, to: targetId, kind: "imports" });
		} else {
			const targetId = `${entry.source.startsWith(".") ? "module" : "external"}:${entry.source}`;
			if (!graph.nodes.has(targetId)) {
				addNode(graph, {
					id: targetId,
					kind: entry.source.startsWith(".") ? "module" : "external",
					language: "jsts",
					metadata: { source: entry.source },
				});
			}
			addEdge(graph, { from: fileNodeId, to: targetId, kind: "imports" });
		}
	}

	for (const fn of functions) {
		const symbolId = buildSymbolId(normalized, fn.name, "function", fn.line);
		addNode(graph, {
			id: symbolId,
			kind: "symbol",
			language: "jsts",
			filePath: normalized,
			symbolName: fn.name,
			symbolKind: "function",
			exported: new RegExp(
				String.raw`export\s+(?:async\s+)?(?:function|const|let|var)\s+${escapeRegExp(fn.name)}\b`,
			).test(content),
			metadata: {
				line: fn.line,
				column: fn.column,
				cyclomaticComplexity: fn.cyclomaticComplexity,
				maxNestingDepth: fn.maxNestingDepth,
				isBoundaryWrapper: fn.isBoundaryWrapper,
				isPassThroughWrapper: fn.isPassThroughWrapper,
				...featureHintMetadata(`${fn.name} ${normalized}`),
			},
		});
		addEdge(graph, { from: fileNodeId, to: symbolId, kind: "contains" });
		addEdge(graph, { from: fileNodeId, to: symbolId, kind: "defines" });
		for (const callee of fn.outgoingCalls) {
			const targetId = callee.includes(".")
				? `external:${callee}`
				: `symbol-name:${callee}`;
			if (!graph.nodes.has(targetId)) {
				addNode(graph, {
					id: targetId,
					kind: callee.includes(".") ? "external" : "symbol",
					language: "jsts",
					symbolName: callee.includes(".") ? undefined : callee,
					metadata: { unresolvedName: callee },
				});
			}
			addEdge(graph, {
				from: symbolId,
				to: targetId,
				kind: "calls",
				metadata: { unresolvedName: callee },
				// A definite external call (`callee.includes(".")`) is never
				// ambiguous — no in-project candidate to collide with, so no
				// resolution marker. An in-project bare-name callee starts
				// "name-only" and resolveDeferredSymbolEdges below may upgrade it
				// to "exact" once every file has been added.
				...(callee.includes(".") ? {} : { resolution: "name-only" }),
			});
		}
	}
}

function mapKindToTreeSitterLanguage(
	kind: string | undefined,
	filePath?: string,
): string | undefined {
	switch (kind) {
		case "python": return "python";
		case "go": return "go";
		case "rust": return "rust";
		case "ruby": return "ruby";
		case "cxx": {
			const ext = filePath ? path.extname(filePath).toLowerCase() : "";
			return ext === ".c" || ext === ".h" ? "c" : "cpp";
		}
		case "java": return "java";
		case "kotlin": return "kotlin";
		case "dart": return "dart";
		case "elixir": return "elixir";
		case "csharp": return "csharp";
		case "php": return "php";
		case "swift": return "swift";
		case "lua": return "lua";
		case "ocaml": return "ocaml";
		case "zig": return "zig";
		case "shell": return "bash";
		default: return undefined;
	}
}

async function getExtractor(
	languageId: string,
): Promise<TreeSitterSymbolExtractor | null> {
	if (extractorCache.has(languageId)) return extractorCache.get(languageId)!;
	const client = getSharedTreeSitterClient();
	if (!client) return null;
	const extractor = new TreeSitterSymbolExtractor(languageId, client);
	const ok = await extractor.init();
	if (!ok) return null;
	extractorCache.set(languageId, extractor);
	return extractor;
}

async function extractTreeSitterSymbols(
	filePath: string,
	languageId: string,
): Promise<ExtractedSymbols> {
	const empty: ExtractedSymbols = { symbols: [], refs: [], imports: [] };
	const treeSitterClient = getSharedTreeSitterClient();
	if (!treeSitterClient) return empty;
	const initialized = await treeSitterClient.init();
	if (!initialized) return empty;
	const tree = await treeSitterClient.parseFile(filePath, languageId);
	if (!tree) return empty;
	const extractor = await getExtractor(languageId);
	if (!extractor) return empty;
	const content = fs.readFileSync(filePath, "utf-8");
	return extractor.extract(tree, filePath, content);
}

// #655: some grammars' SYMBOL_QUERIES match the SAME declaration node under two
// patterns — e.g. python's generic `function_definition` rule also matches a
// method's `function_definition` nested inside a class body, in addition to
// the class-scoped "method" rule (tree-sitter-symbol-extractor.ts has no
// `#not-`-style scope predicate to exclude it). `extract()` then yields TWO
// Symbol records for one real declaration: identical name/line/column,
// differing only in `kind` ("function" vs "method"). The pre-#655
// `${file}:${name}` ID silently collapsed these onto one node (`Map.set`
// overwrote by name, last-extracted kind winning in whatever order
// `Query.matches` returned). The new kind-qualified ID would otherwise turn
// that pre-existing extractor quirk into two REAL, persisted duplicate nodes
// for one symbol — so dedupe by (name, line, column) here, preferring the
// more specific kind, keeping exactly one node per real declaration regardless
// of how many query patterns matched it.
const SYMBOL_KIND_SPECIFICITY: Record<string, number> = {
	method: 2,
	property: 2,
};

function dedupeSamePositionSymbols(
	symbols: ExtractedSymbols["symbols"],
): ExtractedSymbols["symbols"] {
	const bestByKey = new Map<string, ExtractedSymbols["symbols"][number]>();
	for (const symbol of symbols) {
		const key = `${symbol.name} ${symbol.line} ${symbol.column}`;
		const existing = bestByKey.get(key);
		if (!existing) {
			bestByKey.set(key, symbol);
			continue;
		}
		const existingScore = SYMBOL_KIND_SPECIFICITY[existing.kind] ?? 0;
		const candidateScore = SYMBOL_KIND_SPECIFICITY[symbol.kind] ?? 0;
		if (candidateScore > existingScore) bestByKey.set(key, symbol);
	}
	return [...bestByKey.values()];
}

function addTreeSitterFile(
	graph: ReviewGraph,
	cwd: string,
	filePath: string,
	languageId: string,
	extracted: ExtractedSymbols,
): void {
	const normalized = normalizeMapKey(filePath);
	const fileNodeId = `file:${normalized}`;
	addNode(graph, {
		id: fileNodeId,
		kind: "file",
		language: languageId,
		filePath: normalized,
		metadata: featureHintMetadata(normalized),
	});

	for (const symbol of dedupeSamePositionSymbols(extracted.symbols)) {
		const symbolId = buildSymbolId(
			normalized,
			symbol.name,
			symbol.kind,
			symbol.line,
		);
		addNode(graph, {
			id: symbolId,
			kind: "symbol",
			language: languageId,
			filePath: normalized,
			symbolName: symbol.name,
			symbolKind: symbol.kind,
			exported: symbol.isExported,
			metadata: {
				line: symbol.line,
				column: symbol.column,
				signature: symbol.signature,
				...featureHintMetadata(`${symbol.name} ${normalized}`),
			},
		});
		addEdge(graph, { from: fileNodeId, to: symbolId, kind: "contains" });
		addEdge(graph, { from: fileNodeId, to: symbolId, kind: "defines" });
	}

	for (const ref of extracted.refs) {
		const targetId = `symbol-name:${ref.symbolId.split(":").pop() ?? ref.symbolId}`;
		if (!graph.nodes.has(targetId)) {
			addNode(graph, {
				id: targetId,
				kind: "symbol",
				language: languageId,
				symbolName: ref.symbolId.split(":").pop() ?? ref.symbolId,
				metadata: { unresolvedName: ref.symbolId },
			});
		}
		addEdge(graph, {
			from: fileNodeId,
			to: targetId,
			kind: "references",
			metadata: { line: ref.line, column: ref.column },
			// Always starts bare-name-only (the extractor has no scope/type info);
			// resolveDeferredSymbolEdges may upgrade this to "exact" below.
			resolution: "name-only",
		});
	}

	// #249: import edges for tree-sitter languages. First try to resolve the
	// source to in-project FILE(s) (ruby/zig/bash/dart relative paths, python
	// dotted modules, go package dirs, java source-root files — see
	// import-resolvers.ts); on success emit real file→file edges like jsts/cxx.
	// An unresolvable source (stdlib, third-party, namespace-only langs) falls
	// back to an UNRESOLVED external/module node — never a fabricated file edge.
	for (const imp of extracted.imports) {
		const resolved = resolveImportToFiles(cwd, filePath, languageId, imp.source);
		if (resolved.length > 0) {
			for (const target of resolved) {
				const toNode = ensureFileNode(
					graph,
					target,
					mapKindToTreeSitterLanguage(detectFileKind(target), target) ??
						languageId,
				);
				addEdge(graph, {
					from: fileNodeId,
					to: toNode,
					kind: "imports",
					metadata: { line: imp.line, source: imp.source },
				});
			}
			continue;
		}
		const isRelative = imp.source.startsWith(".");
		const targetId = `${isRelative ? "module" : "external"}:${imp.source}`;
		if (!graph.nodes.has(targetId)) {
			addNode(graph, {
				id: targetId,
				kind: isRelative ? "module" : "external",
				language: languageId,
				metadata: { source: imp.source },
			});
		}
		addEdge(graph, {
			from: fileNodeId,
			to: targetId,
			kind: "imports",
			metadata: { line: imp.line },
		});
	}
}

function ensureFileNode(
	graph: ReviewGraph,
	filePath: string,
	languageId: string,
): string {
	const normalized = normalizeMapKey(filePath);
	const existing = graph.fileNodes.get(normalized);
	if (existing) return existing;
	const fileNodeId = `file:${normalized}`;
	addNode(graph, {
		id: fileNodeId,
		kind: "file",
		language: languageId,
		filePath: normalized,
		metadata: featureHintMetadata(normalized),
	});
	return fileNodeId;
}

function resolveCxxInclude(
	cwd: string,
	filePath: string,
	source: string,
): string | undefined {
	const candidates = [
		path.resolve(path.dirname(filePath), source),
		path.resolve(cwd, source),
		path.resolve(cwd, "include", source),
		path.resolve(cwd, "src", source),
	];
	const root = path.resolve(cwd);
	for (const candidate of candidates) {
		if (!candidate.startsWith(root + path.sep) && candidate !== root) continue;
		if (fs.existsSync(candidate) && detectFileKind(candidate) === "cxx") {
			return normalizeMapKey(candidate);
		}
	}
	return undefined;
}

function parseLocalCxxInclude(line: string): string | undefined {
	let i = 0;
	while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
	if (line[i] !== "#") return undefined;
	i += 1;
	while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
	if (!line.startsWith("include", i)) return undefined;
	i += "include".length;
	if (i >= line.length || (line[i] !== " " && line[i] !== "\t")) {
		return undefined;
	}
	while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
	if (line[i] !== '"') return undefined;
	i += 1;
	const start = i;
	while (i < line.length && line[i] !== '"') i += 1;
	if (i >= line.length || i === start) return undefined;
	return line.slice(start, i);
}

function addCxxIncludeEdges(
	graph: ReviewGraph,
	cwd: string,
	filePath: string,
): void {
	let content = "";
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return;
	}
	const fromNode = ensureFileNode(graph, filePath, "cpp");
	for (const line of content.split(/\r?\n/)) {
		const source = parseLocalCxxInclude(line);
		if (!source) continue;
		const target = resolveCxxInclude(cwd, filePath, source);
		if (!target) continue;
		const languageId = mapKindToTreeSitterLanguage("cxx", target) ?? "cpp";
		const toNode = ensureFileNode(graph, target, languageId);
		addEdge(graph, {
			from: fromNode,
			to: toNode,
			kind: "imports",
			metadata: { source },
		});
	}
}

function removeFileOwnedGraphData(
	graph: ReviewGraph,
	filePath: string,
): ReviewGraphEdge[] {
	const normalized = normalizeMapKey(filePath);
	const fileNodeId = `file:${normalized}`;
	const removedIds = new Set<string>();
	const removedSymbolIds = new Set<string>();
	for (const [id, node] of graph.nodes) {
		if (node.filePath !== normalized) continue;
		removedIds.add(id);
		if (node.kind === "symbol") removedSymbolIds.add(id);
	}
	if (graph.nodes.has(fileNodeId)) removedIds.add(fileNodeId);

	const preservedIncomingSymbolEdges: ReviewGraphEdge[] = [];
	graph.edges = graph.edges.filter((edge) => {
		const fromRemoved = removedIds.has(edge.from);
		const toRemoved = removedIds.has(edge.to);
		if (fromRemoved) return false;
		if (removedSymbolIds.has(edge.to)) {
			preservedIncomingSymbolEdges.push({ ...edge });
			return false;
		}
		// Preserve importer edges to the stable file node id; the node is re-added below.
		if (toRemoved && edge.to === fileNodeId) return true;
		return !toRemoved;
	});
	for (const id of removedIds) graph.nodes.delete(id);
	rebuildIndexes(graph);
	return preservedIncomingSymbolEdges;
}

async function addFileToGraph(
	graph: ReviewGraph,
	cwd: string,
	file: string,
	facts: FactStore,
): Promise<void> {
	const kind = detectFileKind(file);
	if (!kind || !MAIN_KINDS.has(kind)) return;
	// #260: tests aren't graph-relevant — guard the per-file chokepoint too so
	// the incremental/cascade path (a changed *.test.ts) never adds them either.
	if (detectFileRole(file) === "test") return;
	if (kind === "jsts") {
		await ensureReviewGraphFacts(file, cwd, facts);
		addJsTsFile(graph, cwd, file, facts);
		return;
	}
	const languageId = mapKindToTreeSitterLanguage(kind, file);
	if (!languageId) return;
	const extracted = await extractTreeSitterSymbols(file, languageId);
	addTreeSitterFile(graph, cwd, file, languageId, extracted);
	if (kind === "cxx") addCxxIncludeEdges(graph, cwd, file);
}

function restoreValidIncomingEdges(
	graph: ReviewGraph,
	edges: ReviewGraphEdge[],
): void {
	const existing = new Set(
		graph.edges.map(
			(edge) =>
				`${edge.from}\u0000${edge.to}\u0000${edge.kind}\u0000${JSON.stringify(edge.metadata ?? {})}`,
		),
	);
	for (const edge of edges) {
		if (!graph.nodes.has(edge.from) || !graph.nodes.has(edge.to)) continue;
		const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind}\u0000${JSON.stringify(edge.metadata ?? {})}`;
		if (existing.has(key)) continue;
		graph.edges.push(edge);
		existing.add(key);
	}
	rebuildIndexes(graph);
}

async function updateGraphFiles(
	graph: ReviewGraph,
	cwd: string,
	files: string[],
	facts: FactStore,
): Promise<void> {
	const preservedIncoming: ReviewGraphEdge[] = [];
	for (const file of files) {
		preservedIncoming.push(...removeFileOwnedGraphData(graph, file));
		await addFileToGraph(graph, cwd, file, facts);
	}
	restoreValidIncomingEdges(graph, preservedIncoming);
	resolveDeferredSymbolEdges(graph);
	graph.changedSymbolsByFile.clear();
	for (const file of files) {
		upsertChangedSymbols(graph, facts, file);
	}
}

function resolveDeferredSymbolEdges(graph: ReviewGraph): void {
	const symbolNameToIds = new Map<string, string[]>();
	for (const node of graph.nodes.values()) {
		if (node.kind !== "symbol" || !node.symbolName) continue;
		if (node.metadata?.unresolvedName) continue;
		const ids = symbolNameToIds.get(node.symbolName) ?? [];
		ids.push(node.id);
		symbolNameToIds.set(node.symbolName, ids);
	}

	graph.edges = graph.edges.map((edge) => {
		const targetNode = graph.nodes.get(edge.to);
		if (!targetNode?.metadata?.unresolvedName) return edge;
		const candidates = symbolNameToIds.get(targetNode.symbolName ?? "") ?? [];
		if (candidates.length === 1) {
			// Exactly one same-named real symbol exists graph-wide: the bare-name
			// match is provably unambiguous (refs #655 — resolution confidence).
			return { ...edge, to: candidates[0], resolution: "exact" };
		}
		// 0 or 2+ candidates: stays on the unresolved placeholder, resolution
		// stays "name-only" (set at edge creation) — a consumer must not treat
		// this edge's target as a confirmed graph node.
		return edge;
	});
	rebuildIndexes(graph);
}

interface CachedGraphEntry {
	signature: string;
	fileSignatures: Map<string, string>;
	fileHashes?: Map<string, string>;
	graph: ReviewGraph;
	/** #459: generation of this entry's graph content — see ReviewGraph.buildGeneration. */
	buildGeneration?: number;
}

interface IncrementalCtx {
	cwd: string;
	normalizedCwd: string;
	normalizedChanged: string[];
	fileSignatures: Map<string, string>;
	signature: string;
	facts: FactStore;
	/** #451: seq to stamp onto the freshly-built entry (undefined ⇒ no fast path later). */
	seqAtBuildStart?: number;
}

/**
 * #451: the freshness-provenance fields written onto a workspace cache entry by
 * any path that has just done (or reused a still-valid result of) the full
 * walk+stat sweep. Records the projectSeq CAPTURED AT BUILD START — not read at
 * stamp time — so a bump that interleaves during this build's awaits has
 * seq > stamp and is re-ingested by the next diff (a miss would be a silently
 * stale graph; a redundant re-extract is harmless). Also resets the
 * periodic-reverify clock/counter — this build IS the verify.
 */
function verifiedCacheFields(seqAtBuildStart: number | undefined): {
	builtAtProjectSeq?: number;
	lastFullVerifyMs: number;
	fastPathSinceVerify: number;
} {
	return {
		builtAtProjectSeq: seqAtBuildStart,
		lastFullVerifyMs: Date.now(),
		fastPathSinceVerify: 0,
	};
}

/**
 * #202: satisfy a build from a cached graph entry incrementally when the source
 * file set changed only by ADDITIONS and/or CONTENT changes (no removals).
 * Returns the query-ready graph, or undefined when an incremental update doesn't
 * apply (a file was removed, the cache has no signatures to diff, or nothing
 * actually changed) and the caller must fall through.
 *
 * This is the lever that keeps a burst of newly-created files off the
 * full-rebuild path. `updateGraphFiles` re-parses each target from disk and is a
 * remove-then-add that no-ops the remove for a not-yet-present file, so adding
 * the new files (plus any hash-confirmed content changes) incrementally is
 * correct regardless of whether the file was in this edit's changed set —
 * dropping the old `.every(in changedSet)` restriction that bailed to a full
 * rebuild for a sibling that changed on disk outside the current edit.
 */
async function tryIncrementalFromCache(
	cached: CachedGraphEntry,
	ctx: IncrementalCtx,
): Promise<ReviewGraph | undefined> {
	if (cached.fileSignatures.size === 0) return undefined;
	const { added, removed, changed } = diffSignatureMaps(
		cached.fileSignatures,
		ctx.fileSignatures,
	);
	// A removal must prune nodes/edges and can dangle incoming edges; that's rare
	// on an edit burst — fall through to a correct full rebuild.
	if (removed.length > 0) return undefined;
	if (added.length === 0 && changed.length === 0) return undefined;

	// Confirm size/mtime-changed EXISTING files by content hash so pure drift
	// (formatter no-op, git checkout, re-save) neither reparses nor forces a full
	// build. Added files are genuinely new — no prior hash to compare.
	const { trulyChanged, hashes } = await confirmContentChanged(
		changed,
		cached.fileHashes,
	);
	const filesToUpdate = [...added, ...trulyChanged];

	if (filesToUpdate.length === 0) {
		// Pure drift on existing files only — reuse the cached graph as-is.
		// #459: content unchanged ⇒ carry the entry's generation forward (a legacy
		// or disk-hydrated entry without one gets a fresh stamp — conservative:
		// derived caches see it as new and rebuild once).
		const generation = cached.buildGeneration ?? ++_graphGenerationCounter;
		const graph = cloneGraph(cached.graph);
		rebuildIndexes(graph);
		graph.changedSymbolsByFile.clear();
		for (const file of ctx.normalizedChanged) {
			upsertChangedSymbols(graph, ctx.facts, file);
		}
		_workspaceGraphCache.set(ctx.normalizedCwd, {
			signature: ctx.signature,
			fileSignatures: new Map(ctx.fileSignatures),
			fileHashes: hashes,
			graph: cloneGraph(cached.graph),
			buildGeneration: generation,
			...verifiedCacheFields(ctx.seqAtBuildStart),
		});
		// #260: pure drift leaves the graph unchanged — don't rewrite the disk blob.
		_lastGraphBuildInfo = { reused: true, mode: "cached", graphChanged: false };
		graph.buildGeneration = generation;
		ctx.facts.setSessionFact("session.reviewGraph", graph);
		return graph;
	}

	// Record content hashes for the newly-added files too, so the next run can
	// tell their future drift from a real change (otherwise they would re-confirm
	// as changed on every build until the next full rebuild).
	for (const file of added) {
		hashes.set(file, contentHashEntry(file));
	}

	const graph = cloneGraph(cached.graph);
	await updateGraphFiles(graph, ctx.cwd, filesToUpdate, ctx.facts);
	// #459: real re-extract ⇒ new generation.
	const generation = ++_graphGenerationCounter;
	const graphSnapshot = cloneGraph(graph);
	_workspaceGraphCache.set(ctx.normalizedCwd, {
		signature: ctx.signature,
		fileSignatures: new Map(ctx.fileSignatures),
		fileHashes: hashes,
		graph: graphSnapshot,
		buildGeneration: generation,
		...verifiedCacheFields(ctx.seqAtBuildStart),
	});
	persistGraph(
		ctx.cwd,
		ctx.signature,
		ctx.fileSignatures,
		hashes,
		graphSnapshot,
	);
	_lastGraphBuildInfo = { reused: true, mode: "incremental", graphChanged: true };
	graph.buildGeneration = generation;
	ctx.facts.setSessionFact("session.reviewGraph", graph);
	return graph;
}

function hasGraphKindExtension(file: string): boolean {
	const kind = detectFileKind(file);
	return !!kind && MAIN_KINDS.has(kind) && detectFileRole(file) !== "test";
}

type SeqFastpathResult =
	| { graph: ReviewGraph }
	| { fallback: SeqFastpathFallback };

/**
 * #451: satisfy a build WITHOUT the O(project) walk+stat sweep, using the
 * RuntimeCoordinator's seq state to enumerate exactly which files changed since
 * this workspace graph was last built. On success sets `_lastGraphBuildInfo` and
 * returns `{ graph }`; on any doubt returns `{ fallback }` WITHOUT touching
 * `_lastGraphBuildInfo` (the caller's full sweep sets the mode and stamps the
 * fallback reason). Correctness bar is HIGH: any doubt ⇒ fall back.
 */
async function trySeqFastpath(
	cwd: string,
	normalizedCwd: string,
	normalizedChanged: string[],
	facts: FactStore,
	seqHint: GraphSeqHint,
	seqAtBuildStart: number,
): Promise<SeqFastpathResult> {
	const cached = _workspaceGraphCache.get(normalizedCwd);
	// Condition 2: need an in-process entry that recorded a build seq.
	if (!cached || cached.builtAtProjectSeq === undefined) {
		return { fallback: "no-seq" };
	}

	// Condition 5: periodic full re-verify safety valve (external edits — IDE, git
	// checkout — never bump projectSeq). Age OR count triggers a sweep.
	const now = Date.now();
	const ageMs =
		cached.lastFullVerifyMs === undefined
			? Number.POSITIVE_INFINITY
			: now - cached.lastFullVerifyMs;
	const sinceVerify = cached.fastPathSinceVerify ?? 0;
	if (ageMs > SEQ_FASTPATH_REVERIFY_MS || sinceVerify >= SEQ_FASTPATH_REVERIFY_EVERY) {
		return { fallback: "verify-due" };
	}

	// Condition 3: bounded change set. changed ∪ changedFiles(param), normalized.
	const changedSet = new Set(seqHint.getFilesChangedSince(cached.builtAtProjectSeq));
	for (const file of normalizedChanged) changedSet.add(file);
	const changed = [...changedSet];
	if (changed.length > SEQ_FASTPATH_MAX_CHANGES) {
		return { fallback: "too-many-changes" };
	}

	// Condition 4 + removal check. A file already known to the graph is safe. A
	// file NOT in fileSignatures must exist on disk with a graph-kind extension
	// (a genuine new file — updateGraphFiles' remove-then-add handles the add). A
	// changed file that no longer exists on disk is a DELETION: incremental has no
	// node-removal here, so fall back to the sweep (simple + correct).
	const filesToUpdate: string[] = [];
	for (const file of changed) {
		const known = cached.fileSignatures.has(file);
		let existsOnDisk = false;
		try {
			existsOnDisk = fs.statSync(file).isFile();
		} catch {
			existsOnDisk = false;
		}
		if (!existsOnDisk) {
			// Known-but-now-missing = deletion; unknown-and-missing = irrelevant
			// (e.g. a non-source path). Either way, be safe: known deletions need the
			// sweep; unknown missing files we can just ignore.
			if (known) {
				return { fallback: "removed-file" };
			}
			continue;
		}
		if (!known) {
			// New file: only ingest if it's a graph-relevant kind; a changed
			// non-source sibling (config, doc) is simply not graph material.
			if (!hasGraphKindExtension(file)) continue;
		}
		filesToUpdate.push(file);
	}

	if (filesToUpdate.length === 0) {
		// Nothing graph-relevant actually changed. Reuse the cached graph as-is,
		// refresh changed-symbol annotations, bump the fast-path counter.
		const graph = cloneGraph(cached.graph);
		rebuildIndexes(graph);
		graph.changedSymbolsByFile.clear();
		for (const file of normalizedChanged) {
			upsertChangedSymbols(graph, facts, file);
		}
		// Stamp the seq captured at BUILD START — a bump that raced in during this
		// build has seq > stamp and is re-diffed next build, never missed.
		cached.builtAtProjectSeq = seqAtBuildStart;
		cached.fastPathSinceVerify = sinceVerify + 1;
		// #459: nothing graph-relevant changed — this is a genuine no-op reuse.
		const generation = (cached.buildGeneration ??= ++_graphGenerationCounter);
		_lastGraphBuildInfo = { reused: true, mode: "seq-fastpath", graphChanged: false };
		graph.buildGeneration = generation;
		facts.setSessionFact("session.reviewGraph", graph);
		return { graph };
	}

	// Incremental re-extract over exactly the changed files. Reuses the SAME
	// machinery as the signature-diff incremental path (updateGraphFiles), so
	// there's no second incremental implementation.
	const graph = cloneGraph(cached.graph);
	try {
		await updateGraphFiles(graph, cwd, filesToUpdate, facts);
	} catch {
		return { fallback: "stat-error" };
	}

	// Update fileSignatures/fileHashes for ONLY the touched files (stat/hash just
	// those — the whole point of the fast path). Recompute the aggregate signature
	// the same way the incremental branch does (sourceSignatureFromMap).
	const nextSignatures = new Map(cached.fileSignatures);
	const nextHashes = new Map(cached.fileHashes ?? new Map<string, string>());
	for (const file of filesToUpdate) {
		nextSignatures.set(file, sourceSignatureEntry(file));
		nextHashes.set(file, contentHashEntry(file));
	}
	const nextSignature = sourceSignatureFromMap(nextSignatures);

	// #459: real re-extract ⇒ new generation.
	const generation = ++_graphGenerationCounter;
	const graphSnapshot = cloneGraph(graph);
	_workspaceGraphCache.set(normalizedCwd, {
		signature: nextSignature,
		fileSignatures: nextSignatures,
		fileHashes: nextHashes,
		graph: graphSnapshot,
		buildGeneration: generation,
		// Build-start seq, not stamp-time: see verifiedCacheFields — a bump that
		// interleaved during updateGraphFiles' awaits must be re-diffed next build.
		builtAtProjectSeq: seqAtBuildStart,
		lastFullVerifyMs: cached.lastFullVerifyMs,
		fastPathSinceVerify: sinceVerify + 1,
	});
	persistGraph(cwd, nextSignature, nextSignatures, nextHashes, graphSnapshot);
	// #459: filesToUpdate was non-empty — this fastpath re-extracted real files,
	// so (unlike the no-op branch above) the graph object did change.
	_lastGraphBuildInfo = { reused: true, mode: "seq-fastpath", graphChanged: true };
	graph.buildGeneration = generation;
	facts.setSessionFact("session.reviewGraph", graph);
	return { graph };
}

async function _doBuildGraph(
	cwd: string,
	changedFiles: string[],
	facts: FactStore,
	seqHint?: GraphSeqHint,
): Promise<ReviewGraph> {
	const normalizedCwd = normalizeMapKey(cwd);
	const normalizedChanged = changedFiles.map((file) => normalizeMapKey(file));
	const normalizedChangedSet = new Set(normalizedChanged);
	logCwdWorktreeMismatchOnce(cwd);

	// #622: reject a cwd that IS (or is an ancestor of) $HOME before any walk is
	// attempted. The 3 real per-edit callers (dispatch/integration.ts's
	// computeCascadeForFile, mcp/analyze.ts, tree-sitter.ts's
	// runBlastRadiusInBackground) pass their session/pipeline cwd straight
	// through on the assumption it's already a real project root — true when Pi
	// is launched inside a repo, false when Pi is launched from $HOME itself and
	// then edits an absolute-path file in some other repo. In that case
	// getGraphSourceFiles's maxGraphFiles cap (#250) only trips AFTER a full
	// unfiltered $HOME walk (206k+ files, ~500s of blocked event loop — #622),
	// because the cap counts post-filter *kept* files, not directory entries
	// visited. Bail before the walk starts instead, mirroring the same
	// isAtOrAboveHomeDir ceiling already used by startup-scan.ts,
	// dead-code-client.ts, knip-client.ts, and runtime-session.ts's
	// resolveSnapshotRoot for the identical class of escape (#253/#250). Unlike
	// those (which resolve a root by walking UP from an arbitrary start dir),
	// this checks cwd directly: buildOrUpdateGraph's contract is that cwd
	// already IS the project root, so there is no safe substitute root to fall
	// back to here — skip graph construction entirely (matching #622's own
	// stated expected behavior) rather than walking a directory the caller never
	// asked for.
	if (isAtOrAboveHomeDir(path.resolve(cwd))) {
		const graph = createEmptyGraph();
		for (const file of normalizedChanged) {
			upsertChangedSymbols(graph, facts, file);
		}
		_lastGraphBuildInfo = {
			reused: false,
			mode: "skipped",
			skipReason: "unsafe_root",
			// #459: never persisted/reused, same as the too_many_files skip below —
			// treat as changed so dependents never trust stale derived state.
			graphChanged: true,
		};
		facts.setSessionFact("session.reviewGraph", graph);
		return graph;
	}

	// #451: capture the seq BEFORE any await — every builtAtProjectSeq stamp in
	// this build uses this value, so a bump that interleaves mid-build has
	// seq > stamp and is re-diffed next build (redundant re-extract, never a miss).
	const seqAtBuildStart = seqHint?.projectSeq();

	// #451: seq fast path — skip the O(project) walk+stat sweep when the
	// RuntimeCoordinator can tell us exactly which files changed. Any doubt inside
	// falls through to the full sweep below (which refreshes the verify clock). The
	// fallback reason is stamped onto whichever build-info the sweep records, so
	// cascade.log can watch the fast-path hit/miss rate.
	let seqFastpathFallback: SeqFastpathFallback | undefined;
	if (seqHint && seqAtBuildStart !== undefined && seqFastpathEnabled()) {
		const fast = await trySeqFastpath(
			cwd,
			normalizedCwd,
			normalizedChanged,
			facts,
			seqHint,
			seqAtBuildStart,
		);
		if ("graph" in fast) return fast.graph;
		seqFastpathFallback = fast.fallback;
	}

	const filesToBuild = await getGraphSourceFiles(cwd);
	const maxGraphFiles = getReviewGraphMaxFiles();
	if (filesToBuild.length > maxGraphFiles) {
		const graph = createEmptyGraph();
		graph.version = REVIEW_GRAPH_VERSION;
		graph.builtAt = new Date().toISOString();
		for (const file of normalizedChanged) {
			upsertChangedSymbols(graph, facts, file);
		}
		_lastGraphBuildInfo = {
			reused: false,
			mode: "skipped",
			skipReason: "too_many_files",
			sourceFileCount: filesToBuild.length,
			maxFileCount: maxGraphFiles,
			seqFastpathFallback,
			// #459: a fresh empty graph is returned every call on this path (never
			// persisted/reused) — treat it as changed so dependents never trust stale
			// derived state across skip/unskip transitions. Deliberately NOT stamped
			// with a buildGeneration: absent ⇒ derived caches rebuild every time.
			graphChanged: true,
		};
		facts.setSessionFact("session.reviewGraph", graph);
		return graph;
	}
	const fileSignatures = await sourceSignatureMapAsync(filesToBuild);
	const signature = sourceSignatureFromMap(fileSignatures);

	// Tier 1: in-memory cache (hot path — same process, already built this session)
	const memCached = _workspaceGraphCache.get(normalizedCwd);
	if (memCached?.signature === signature) {
		const graph = cloneGraph(memCached.graph);
		rebuildIndexes(graph);
		graph.changedSymbolsByFile.clear();
		for (const file of normalizedChanged) {
			upsertChangedSymbols(graph, facts, file);
		}
		// #451: a signature-matching hit means the walk+stat just confirmed nothing
		// changed — a legitimate full verify. Refresh the clock/counter and seq so a
		// later fast path diffs from here and the periodic re-verify resets.
		Object.assign(memCached, verifiedCacheFields(seqAtBuildStart));
		// #459: content unchanged ⇒ carry the entry's generation forward.
		const generation = (memCached.buildGeneration ??= ++_graphGenerationCounter);
		_lastGraphBuildInfo = {
			reused: true,
			mode: "cached",
			seqFastpathFallback,
			graphChanged: false,
		};
		graph.buildGeneration = generation;
		facts.setSessionFact("session.reviewGraph", graph);
		return graph;
	}
	if (memCached) {
		const incremental = await tryIncrementalFromCache(memCached, {
			cwd,
			normalizedCwd,
			normalizedChanged,
			fileSignatures,
			signature,
			facts,
			seqAtBuildStart,
		});
		if (incremental) {
			_lastGraphBuildInfo.seqFastpathFallback = seqFastpathFallback;
			return incremental;
		}
	}

	// Tier 2: disk cache (cold start — files unchanged since last persist).
	// #300: deliberately does NOT verify the git stamp — the signature match /
	// #202 content-hash confirm below already content-verify the load, and
	// dropping on every HEAD move would force a full whole-repo rebuild after
	// each plain `git commit` (HEAD moves, files unchanged).
	const diskCached = loadPersistedGraph(cwd);
	if (diskCached?.signature === signature) {
		const graph = cloneGraph(diskCached.graph);
		rebuildIndexes(graph);
		graph.changedSymbolsByFile.clear();
		for (const file of normalizedChanged) {
			upsertChangedSymbols(graph, facts, file);
		}
		// #459: disk-hydrated content is new to THIS process — fresh stamp (a prior
		// process's derived caches don't exist here; in-process derived caches from
		// before a workspace-cache clear must not match it).
		const generation = ++_graphGenerationCounter;
		_workspaceGraphCache.set(normalizedCwd, {
			signature,
			fileSignatures: new Map(fileSignatures),
			fileHashes: diskCached.fileHashes,
			graph: cloneGraph(diskCached.graph),
			buildGeneration: generation,
			...verifiedCacheFields(seqAtBuildStart),
		});
		_lastGraphBuildInfo = {
			reused: true,
			mode: "cached",
			seqFastpathFallback,
			graphChanged: false,
		};
		graph.buildGeneration = generation;
		facts.setSessionFact("session.reviewGraph", graph);
		return graph;
	}
	if (diskCached) {
		// #202: same incremental path as the in-memory tier. This is where it pays
		// off most — on cold start, git/checkout mtime drift or a burst of new
		// files since the last persist would otherwise force a full whole-repo
		// rebuild; the delta + content-hash confirm reuses the persisted graph.
		const incremental = await tryIncrementalFromCache(
			{
				signature: diskCached.signature,
				fileSignatures: diskCached.fileSignatures,
				fileHashes: diskCached.fileHashes,
				graph: diskCached.graph,
			},
			{
				cwd,
				normalizedCwd,
				normalizedChanged,
				fileSignatures,
				signature,
				facts,
				seqAtBuildStart,
			},
		);
		if (incremental) {
			_lastGraphBuildInfo.seqFastpathFallback = seqFastpathFallback;
			return incremental;
		}
	}

	// Tier 3: full build
	const graph = createEmptyGraph();
	for (const file of filesToBuild) {
		await addFileToGraph(graph, cwd, file, facts);
		if (normalizedChangedSet.has(file)) {
			upsertChangedSymbols(graph, facts, file);
		}
	}

	resolveDeferredSymbolEdges(graph);
	graph.version = REVIEW_GRAPH_VERSION;
	graph.builtAt = new Date().toISOString();
	// #202: record per-file content hashes so the next run can tell a real
	// content change apart from pure mtime/size drift. Only runs on the (rare)
	// full-build path; the OS file cache is warm from the parse above.
	const fileHashes = await sourceHashMapAsync(filesToBuild);
	// #459: full rebuild ⇒ new generation.
	const generation = ++_graphGenerationCounter;
	const graphSnapshot = cloneGraph(graph);
	_workspaceGraphCache.set(normalizedCwd, {
		signature,
		fileSignatures: new Map(fileSignatures),
		fileHashes,
		graph: graphSnapshot,
		buildGeneration: generation,
		...verifiedCacheFields(seqAtBuildStart),
	});
	persistGraph(cwd, signature, fileSignatures, fileHashes, graphSnapshot); // fire-and-forget
	_lastGraphBuildInfo = {
		reused: false,
		mode: "full",
		seqFastpathFallback,
		graphChanged: true,
	};
	graph.buildGeneration = generation;
	facts.setSessionFact("session.reviewGraph", graph);
	return graph;
}

export function buildOrUpdateGraph(
	cwd: string,
	changedFiles: string[],
	facts: FactStore,
	seqHint?: GraphSeqHint,
): Promise<ReviewGraph> {
	const cacheKey = `${cwd}|${[...changedFiles].sort((a, b) => a.localeCompare(b)).join(",")}`;
	const cached = _buildCache.get(cacheKey);
	if (cached) return cached;

	const promise = _doBuildGraph(cwd, changedFiles, facts, seqHint).catch((err) => {
		_buildCache.delete(cacheKey);
		throw err as Error;
	});
	_buildCache.set(cacheKey, promise);
	return promise;
}

/**
 * Extract symbols and refs from an already-built ReviewGraph for call graph construction.
 * Reuses parsed data without re-running tree-sitter — symbols come from "symbol" nodes,
 * refs come from "references" edges. Line numbers are unavailable here (not stored in graph
 * nodes), so caller attribution falls back to file-level keys in buildCallGraph.
 */
export function extractSymbolsAndRefsFromGraph(
	graph: ReviewGraph,
): {
	allSymbols: Map<string, import("../symbol-types.js").Symbol[]>;
	allRefs: Map<string, import("../symbol-types.js").SymbolRef[]>;
} {
	const allSymbols = new Map<string, import("../symbol-types.js").Symbol[]>();
	const allRefs = new Map<string, import("../symbol-types.js").SymbolRef[]>();

	for (const node of graph.nodes.values()) {
		if (node.kind === "symbol" && node.filePath && node.symbolName) {
			const sym: import("../symbol-types.js").Symbol = {
				id: `${node.filePath}:${node.symbolName}`,
				name: node.symbolName,
				kind: "function" as const,
				filePath: node.filePath,
				line: 1,
				column: 1,
				isExported: false,
			};
			const list = allSymbols.get(node.filePath) ?? [];
			list.push(sym);
			allSymbols.set(node.filePath, list);
		}
	}

	for (const edge of graph.edges) {
		if (edge.kind === "references" && edge.from.startsWith("file:")) {
			const callerFile = edge.from.slice("file:".length);
			const refName = edge.to.startsWith("symbol-name:")
				? edge.to.slice("symbol-name:".length)
				: edge.to.split(":").pop() ?? edge.to;
			const ref: import("../symbol-types.js").SymbolRef = {
				symbolId: `${callerFile}:${refName}`,
				filePath: callerFile,
				line: (edge.metadata as { line?: number } | undefined)?.line ?? 1,
				column: (edge.metadata as { column?: number } | undefined)?.column ?? 1,
			};
			const list = allRefs.get(callerFile) ?? [];
			list.push(ref);
			allRefs.set(callerFile, list);
		}
	}

	return { allSymbols, allRefs };
}
