import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { constants as zlibConstants, gunzipSync, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../atomic-write.js";
import type { CallGraphEvidenceCoverage } from "../call-graph.js";
import type { FactStore } from "../dispatch/fact-store.js";
import { fileContentProvider } from "../dispatch/facts/file-content.js";
import type { FunctionSummary } from "../dispatch/facts/function-facts.js";
import type {
	ImportEntry,
	ReExportEntry,
} from "../dispatch/facts/import-facts.js";
import type { DispatchContext } from "../dispatch/types.js";
import { lazyEnvNumber } from "../env-utils.js";
import { featureHintMetadata } from "../feature-hints.js";
import { detectFileKind, KIND_EXTENSIONS } from "../file-kinds.js";
import { detectFileRole } from "../file-role.js";
import { getProjectDataDir } from "../file-utils.js";
import { collectUntrackedIgnoredIds } from "../git-tracked-ignore.js";
import { realIsPidAlive } from "../instance-reaper.js";
import { logLatency } from "../latency-logger.js";
import {
	containerNameChain,
	getOpenDocumentSymbols,
	lspSymbolKindName,
} from "../lsp-document-symbols.js";
import type { LSPSymbol } from "../lsp/client.js";
import {
	isAtOrAboveHomeDir,
	normalizeFilePath,
	normalizeMapKey,
	toProjectRelativePath,
} from "../path-utils.js";
import { collectProjectSourceFilesWithBudgetAsync } from "../project-scan-policy.js";
import { getReviewGraphMaxFilesDerived } from "../project-scale.js";
import {
	jsTsCandidatePaths,
	resolveAliasedImport,
	resolveImportToFiles,
	resolveProjectReferenceImport,
	resolveWorkspacePackageImport,
} from "./import-resolvers.js";
import { RUNTIME_CONFIG } from "../runtime-config.js";
import {
	buildReverseDependencyIndexFromGraph,
	rankFilesByReverseDependencyCentrality,
} from "../reverse-deps.js";
import { buildQualifiedName, findOwnerName } from "../symbol-containment.js";
import { logTreeSitterCacheStats } from "../tree-sitter-logger.js";
import {
	flushReviewGraphLogSync,
	logReviewGraph,
	makeReviewGraphBuildMetadata,
	type ReviewGraphBuildMode,
	type ReviewGraphBuildMetadata,
	type ReviewGraphPersistenceMetadata,
} from "../review-graph-logger.js";
import { getSharedTreeSitterClient } from "../tree-sitter-shared.js";
import {
	type ExtractedSymbols,
	TreeSitterSymbolExtractor,
} from "../tree-sitter-symbol-extractor.js";
import { withTreeSitterRoot } from "../tree-sitter-shared.js";
import { incrementDegradationCount } from "../degradation-ledger.js";
import { resolveGitIdentity } from "./git-identity.js";
import {
	formatReviewGraphRevisionDriftNote,
	type ReviewGraphRevisionDrift,
} from "./revision-drift.js";
import { buildSymbolId } from "./symbol-id.js";
import type {
	ReviewGraph,
	ReviewGraphEdge,
	ReviewGraphNode,
	ReviewGraphPersistCoverage,
} from "./types.js";
import type { SymbolKind, SymbolRef } from "../symbol-types.js";
import type {
	ReviewGraphPersistWorkerRequest,
	ReviewGraphPersistWorkerResult,
} from "./persist-worker.js";
import {
	clearReviewGraphFileIr,
	getFreshReviewGraphFileIr,
	type ReviewGraphExtractionStatus,
	type ReviewGraphStructuralIr,
	reviewGraphIrContentHash,
} from "./shared-extraction-ir.js";

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
// v5 (#694): import resolution now prefers a `.ts`/`.tsx`/`.mts`/`.cts` source
// twin over a compiled `.js`/`.mjs`/`.cjs` sibling (jsTsCandidatePaths), and
// node creation is gated against untracked-AND-gitignored targets (see
// git-tracked-ignore.ts). A v4 snapshot from a compile-in-place project has
// cross-file import edges materialized on the compiled artifact nodes
// throughout (up to 100% of them, per #694's measurement) — merging that with
// newly-built v5 edges would leave the graph in mixed, partially-corrected
// state. Same safe-rebuild mechanism as the v2→v3/v3→v4 bumps above.
// v6 (#703): `getProjectIgnoreMatcher` is now tracked-aware — a TRACKED file
// that merely matches a `.gitignore`/global pattern (e.g.
// `clients/test-runner-client.ts` vs. `.gitignore`'s `test-*.ts`) is no
// longer dropped from the walk. A v5 snapshot built before this fix is
// missing those nodes entirely (never walked, never parsed) and instead has
// phantom compiled-artifact nodes standing in for them (0 symbols, importer
// edges materialized on the wrong node) — merging that with newly-walked v6
// nodes would leave the phantom AND the real node coexisting. Same
// safe-rebuild mechanism as the v2→v3/v3→v4/v4→v5 bumps above.
// v7 (#939): the canonical snapshot is streamed gzip. A v7 payload in the
// legacy uncompressed filename remains readable for one compatibility release.
// v8 (#1070): call/reference evidence now records call-like vs type-only
// references and tree-sitter query coverage, so call-graph consumers cannot
// mistake incomplete extraction for a clean zero.
export const REVIEW_GRAPH_VERSION = "v8";
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
/** The bounded, source-filtered extension set shared by graph cache readers. */
export const REVIEW_GRAPH_SOURCE_EXTENSIONS: readonly string[] =
	MAIN_KIND_EXTENSIONS;
const CHANGED_SYMBOLS_PREFIX = "session.reviewGraph.changedSymbols:";
const extractorCache = new Map<string, TreeSitterSymbolExtractor | null>();

// IN-FLIGHT Promise cache: deduplicates CONCURRENT buildOrUpdateGraph calls for
// the same (cwd, changedFiles). A separate workspace cache below preserves the
// expensive parsed graph across invocations when source file mtimes/sizes have
// not changed.
//
// #1962: an entry lives only while its build is PENDING — `buildOrUpdateGraph`
// deletes it on settle, success or failure alike. It used to delete only on
// rejection, so a settled promise for a SKIPPED or COMPLETED build answered
// every later call for the same key forever. The pipeline's `clearGraphCache()`
// (pipeline.ts) was the only thing that ever removed it, and the background
// build project_report kicks off never goes through the pipeline: four
// project_report calls over 37s produced ONE build_started, while the tool told
// the agent a retry had been started each time. That is the process-lifetime
// latch shape from AGENTS.md — dedupe state whose lifetime must be the
// operation's, not the process's.
const _buildCache = new Map<string, Promise<ReviewGraph>>();
interface WorkspaceGraphCacheEntry {
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
	/**
	 * #1961: `gitStamp.headCommit` of the DISK SNAPSHOT this entry was
	 * hydrated from, when the blind read served one. Absent on an entry built
	 * in-process — that graph has no stamped revision to differ from.
	 *
	 * Only the stamped commit is stored. The drift PAIR is derived per call by
	 * `getReviewGraphRevisionDrift`, because the current HEAD half is true
	 * only at the instant it is read (#1961 review F3).
	 */
	snapshotStampedHead?: string;
	lastUsedAt: number;
	idleTimer?: ReturnType<typeof setTimeout>;
}
const _workspaceGraphCache = new Map<string, WorkspaceGraphCacheEntry>();
const REVIEW_GRAPH_MAX_WARM_WORKSPACES = 8;
const REVIEW_GRAPH_IDLE_EVICT_MS_DEFAULT = 20 * 60_000;
// A workspace-wide clear must invalidate builds for workspaces that are not
// resident yet, too. This process-wide component therefore survives cache
// deletion; per-workspace eviction/reset increments the map component below.
let _workspaceCacheEpoch = 0;
const _workspaceCacheEpochs = new Map<string, number>();

function workspaceCacheEpoch(key: string): number {
	return _workspaceCacheEpoch + (_workspaceCacheEpochs.get(key) ?? 0);
}

function reviewGraphIdleEvictMs(): number {
	const value = Number.parseInt(
		process.env.PI_LENS_REVIEW_GRAPH_IDLE_EVICT_MS ?? "",
		10,
	);
	return Number.isSafeInteger(value) && value > 0
		? value
		: REVIEW_GRAPH_IDLE_EVICT_MS_DEFAULT;
}

function clearWorkspaceGraphTimer(entry: {
	idleTimer?: ReturnType<typeof setTimeout>;
}): void {
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	entry.idleTimer = undefined;
}

/**
 * The canonical workspace identity for a `_buildCache` key (#1962 review F2).
 *
 * `path.resolve` collapses `.`/`..` segments and anchors a relative path on
 * every OS; `normalizeMapKey` folds separator and casing, and it does that by
 * probing the filesystem (`realpathSync.native`) rather than branching on
 * `process.platform`. Both steps are idempotent, so feeding this an
 * already-canonical key — which the two read sites below do — returns it
 * unchanged.
 */
function buildCacheWorkspaceKey(cwd: string): string {
	return normalizeMapKey(path.resolve(cwd));
}

/**
 * The workspace half of an existing `_buildCache` key. `buildCacheKey`
 * canonicalizes that half at construction, so this is a plain split.
 */
function buildCacheKeyWorkspace(buildKey: string): string | undefined {
	const separator = buildKey.indexOf("|");
	return separator >= 0 ? buildKey.slice(0, separator) : undefined;
}

function evictWorkspaceGraph(
	key: string,
	entry: WorkspaceGraphCacheEntry,
): void {
	if (_workspaceGraphCache.get(key) !== entry) return;
	clearWorkspaceGraphTimer(entry);
	// `key` is a workspace-cache key; run it through the build-key derivation so
	// both sides of this comparison are canonical the same way. Idempotent, so
	// an already-canonical key passes through untouched (#1962 review F2).
	const buildWorkspace = buildCacheWorkspaceKey(key);
	for (const buildKey of _buildCache.keys()) {
		if (buildCacheKeyWorkspace(buildKey) === buildWorkspace) {
			_buildCache.delete(buildKey);
		}
	}
	_workspaceCacheEpochs.set(key, (_workspaceCacheEpochs.get(key) ?? 0) + 1);
	_workspaceGraphCache.delete(key);
}

function scheduleWorkspaceGraphEviction(
	key: string,
	entry: WorkspaceGraphCacheEntry,
): void {
	clearWorkspaceGraphTimer(entry);
	const epoch = workspaceCacheEpoch(key);
	entry.idleTimer = setTimeout(() => {
		entry.idleTimer = undefined;
		if (
			_workspaceGraphCache.get(key) !== entry ||
			workspaceCacheEpoch(key) !== epoch
		)
			return;
		evictWorkspaceGraph(key, entry);
	}, reviewGraphIdleEvictMs());
	entry.idleTimer.unref?.();
}

function touchWorkspaceGraph(key: string): void {
	const entry = _workspaceGraphCache.get(key);
	if (!entry) return;
	entry.lastUsedAt = Date.now();
	scheduleWorkspaceGraphEviction(key, entry);
}

function setWorkspaceGraph(
	key: string,
	entry: Omit<WorkspaceGraphCacheEntry, "lastUsedAt" | "idleTimer">,
	epoch?: number,
): boolean {
	if (epoch !== undefined && workspaceCacheEpoch(key) !== epoch) return false;
	const resident: WorkspaceGraphCacheEntry = {
		...entry,
		lastUsedAt: Date.now(),
	};
	_workspaceGraphCache.set(key, resident);
	scheduleWorkspaceGraphEviction(key, resident);
	while (_workspaceGraphCache.size > REVIEW_GRAPH_MAX_WARM_WORKSPACES) {
		const victim = [..._workspaceGraphCache.entries()].sort(
			([, a], [, b]) => a.lastUsedAt - b.lastUsedAt,
		)[0];
		if (!victim) break;
		evictWorkspaceGraph(victim[0], victim[1]);
	}
	return true;
}

// #459: process-wide monotonic source for ReviewGraph.buildGeneration stamps.
// Never reset (uniqueness is the invariant — a workspace-cache clear must not
// let a new build collide with a generation a derived-data cache recorded
// earlier in the same process).
let _graphGenerationCounter = 0;
// Build invocation identity is separate from graph content generation: cached
// builds can reuse content while still needing a stable lifecycle join key.
let _buildIdCounter = 0;

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
	| "partial-base"
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
	sourceFileCountTruncated?: boolean;
	maxFileCount?: number;
	/** Reason the graph was successfully built but persisted only partially. */
	persistReason?: string;
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

function graphLogMetadata(
	graph: ReviewGraph,
	options: {
		buildId?: number;
		projectSeq?: number;
		seqHint?: boolean;
		mode?: ReviewGraphBuildMode;
		sourceFileCount?: number;
		sourceFileCountTruncated?: boolean;
	} = {},
): ReviewGraphBuildMetadata {
	return makeReviewGraphBuildMetadata(graph, options);
}

function seqFastpathEnabled(): boolean {
	const raw = process.env.PI_LENS_GRAPH_SEQ_FASTPATH;
	return raw !== "0" && raw !== "false";
}

let _lastGraphBuildInfo: GraphBuildInfo = {
	reused: false,
	mode: "full",
	graphChanged: true,
};
// The global slot above is retained for legacy status surfaces, but overlapping
// deferred builds need a per-result identity for lifecycle telemetry.
const _graphBuildInfoByGraph = new WeakMap<ReviewGraph, GraphBuildInfo>();
// #1179: true once ANY graph has been stamped since the last cache clear — i.e.
// `_lastGraphBuildInfo` may now hold a REAL build's info (a potential sibling)
// rather than the pristine `mode: "full"` default. Used only by the fail-closed
// safety read below to decide whether the global slot is safe to serve on a
// WeakMap identity miss.
let _anyGraphStamped = false;

function setGraphBuildInfo(graph: ReviewGraph, info: GraphBuildInfo): void {
	_lastGraphBuildInfo = info;
	_graphBuildInfoByGraph.set(graph, info);
	_anyGraphStamped = true;
}

export function getGraphBuildInfoForGraph(graph: ReviewGraph): GraphBuildInfo {
	return _graphBuildInfoByGraph.get(graph) ?? _lastGraphBuildInfo;
}

/**
 * #1179 (fail-closed guard, latent P3 from the #1108/#1180 side-channel audit).
 * Whether `getGraphBuildInfoForGraph(graph)` can be TRUSTED to describe `graph`
 * itself — for a SAFETY gate that must never read a sibling graph's state.
 *
 * `getGraphBuildInfoForGraph` deliberately falls back to the global
 * `_lastGraphBuildInfo` slot on a WeakMap identity miss — fine for the telemetry
 * and `updateGraphBuildInfo` base-read callers, where a sibling build's `mode` is
 * only informational (and the first stamp of a graph legitimately bases off the
 * prior slot). But a gate that decides degraded-vs-clean must not read a DIFFERENT
 * graph's `mode: "cached"` (healthy) off that fallback, or it would mistake an
 * unstamped/rehydrated graph for a clean leaf and serve a silent all-clear (the
 * #533 false-clean trap). Such a caller reads THIS first and, when it returns
 * false, fails CLOSED (treats coverage as unknown/degraded) instead of trusting
 * the slot.
 *
 * Trustworthy iff EITHER the graph's own identity is present in the WeakMap (the
 * fallback is not even taken), OR nothing has been stamped since the last cache
 * clear (`_lastGraphBuildInfo` is still the pristine `mode: "full"` default, which
 * cannot be a sibling's real state). Only a miss AFTER some real build has stamped
 * — where the global slot could be a sibling's info — is untrustworthy.
 *
 * Live path: always trustworthy. Every `_doBuildGraph` return stamps the graph via
 * `setGraphBuildInfo` before returning it, so the cascade reads the freshly-stamped
 * same-identity instance (`has(graph)` true) and the miss branch is unreachable
 * today. This only hardens a future path that ever surfaces an unstamped graph.
 */
export function graphBuildInfoIsTrustworthy(graph: ReviewGraph): boolean {
	return _graphBuildInfoByGraph.has(graph) || !_anyGraphStamped;
}

function updateGraphBuildInfo(
	graph: ReviewGraph,
	patch: Partial<GraphBuildInfo>,
): GraphBuildInfo {
	const info = { ...getGraphBuildInfoForGraph(graph), ...patch };
	setGraphBuildInfo(graph, info);
	return info;
}

export function clearGraphCache(): void {
	_buildCache.clear();
}

export function clearReviewGraphWorkspaceCache(cwd?: string): void {
	if (cwd === undefined) {
		_buildCache.clear();
		for (const entry of _workspaceGraphCache.values())
			clearWorkspaceGraphTimer(entry);
		_workspaceGraphCache.clear();
		_workspaceCacheEpoch++;
		_sizeSkipVerdicts.clear();
	} else {
		const normalized = normalizeMapKey(cwd);
		// Compare the key's WORKSPACE half only, both sides canonicalized the same
		// way. The old form normalized the whole key, changed-file list included,
		// which is neither meaningful nor cheap (#1962 review F2).
		const buildWorkspace = buildCacheWorkspaceKey(cwd);
		for (const key of _buildCache.keys()) {
			if (buildCacheKeyWorkspace(key) === buildWorkspace) {
				_buildCache.delete(key);
			}
		}
		const entry = _workspaceGraphCache.get(normalized);
		if (entry) clearWorkspaceGraphTimer(entry);
		_workspaceCacheEpochs.set(
			normalized,
			(_workspaceCacheEpochs.get(normalized) ?? 0) + 1,
		);
		_workspaceGraphCache.delete(normalized);
		_sizeSkipVerdicts.delete(normalized);
	}
	_lastGraphBuildInfo = { reused: false, mode: "full", graphChanged: true };
	// #1179: the global slot is back to the pristine default, so a subsequent
	// identity miss can safely serve it again (it cannot be a sibling's state).
	_anyGraphStamped = false;
}

let _reviewGraphBuildGateForTests: (() => Promise<void>) | undefined;

/** Test seam for deterministically interleaving a build with cache eviction. */
export function _setReviewGraphBuildGateForTests(
	gate: (() => Promise<void>) | undefined,
): void {
	_reviewGraphBuildGateForTests = gate;
}

export interface ReviewGraphWorkspaceCacheSnapshot {
	/** Resident entries in `_workspaceGraphCache` — one per distinct cwd this
	 *  process has built a graph for (#1123 item 2 memory attribution). */
	cacheEntries: number;
	/** Sum of `graph.nodes.size` across every resident entry. */
	totalNodes: number;
	/** Sum of `graph.edges.length` across every resident entry. */
	totalEdges: number;
}

/**
 * O(cache-entries) snapshot of the resident workspace graph cache — NOT
 * O(nodes)/O(edges): only `.size`/`.length` are read per entry, never the
 * graph contents themselves (#1123 item 2 memory-attribution sample). Cache
 * entries are per-cwd and normally number 1 (a session_start clears the
 * cache), so this is cheap enough for a per-N-turn sample.
 */
export function getReviewGraphWorkspaceCacheSnapshot(): ReviewGraphWorkspaceCacheSnapshot {
	let totalNodes = 0;
	let totalEdges = 0;
	for (const entry of _workspaceGraphCache.values()) {
		totalNodes += entry.graph.nodes.size;
		totalEdges += entry.graph.edges.length;
	}
	return {
		cacheEntries: _workspaceGraphCache.size,
		totalNodes,
		totalEdges,
	};
}

/** Test-only cache keys, including the LRU order from oldest to newest. */
export function _getReviewGraphWorkspaceCacheKeysForTests(): string[] {
	return [..._workspaceGraphCache.entries()]
		.sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)
		.map(([key]) => key);
}

export function _getReviewGraphCacheStateForTests(cwd: string):
	| {
			signature: string;
			fileSignatures: Map<string, string>;
			fileHashes?: Map<string, string>;
	  }
	| undefined {
	const cached = _workspaceGraphCache.get(normalizeMapKey(cwd));
	if (!cached) return undefined;
	touchWorkspaceGraph(normalizeMapKey(cwd));
	return {
		signature: cached.signature,
		fileSignatures: new Map(cached.fileSignatures),
		fileHashes: cached.fileHashes ? new Map(cached.fileHashes) : undefined,
	};
}

/**
 * Identity of the canonical review-graph cache used by derived projections.
 * This is deliberately read-only: callers get the cache's source signature and
 * graph schema version, never the source-file map or graph itself.
 *
 * The workspace entry is populated by both the in-memory build path and the
 * persisted-snapshot hydration path, so consumers do not need a second source
 * walk (or an independent mtime policy) to validate derived data.
 */
export interface ReviewGraphCacheIdentity {
	version: string;
	signature: string;
}

export function getReviewGraphCacheIdentity(
	cwd: string,
	graph?: ReviewGraph,
): ReviewGraphCacheIdentity | undefined {
	const cached = _workspaceGraphCache.get(normalizeMapKey(cwd));
	if (!cached) return undefined;
	touchWorkspaceGraph(normalizeMapKey(cwd));
	// #1088: `version` is the constant schema tag ("v8" today) — identical for
	// every live graph, so comparing it can never detect that `graph` is a
	// stale instance the workspace cache has since replaced (e.g. a concurrent
	// build racing between this caller's projection snapshot and its identity
	// lookup). Compare the ENTRY's generation stamp (#459), not the stored
	// graph object's: reuse paths store an unstamped `cloneGraph` copy and
	// stamp only the returned instance, so `cached.graph.buildGeneration` is
	// undefined on every drift-reuse / disk-hit entry while the caller's graph
	// carries the entry's generation. The both-undefined case is legitimate
	// only for the tier-3 hydration entry, where the caller holds the exact
	// stored instance — anything else unstamped must not resolve an identity
	// (e.g. the size-skip empty graph racing a hydrated entry).
	if (graph) {
		if (
			cached.buildGeneration === undefined &&
			graph.buildGeneration === undefined
		) {
			if (cached.graph !== graph) return undefined;
		} else if (cached.buildGeneration !== graph.buildGeneration) {
			return undefined;
		}
	}
	const version = graph?.version ?? cached.graph.version;
	if (
		typeof version !== "string" ||
		version.length === 0 ||
		typeof cached.signature !== "string"
	) {
		return undefined;
	}
	return { version, signature: cached.signature };
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
 * Test-only: force the last-build-info slot (e.g. to simulate a `too_many_files`
 * size-skip without walking a real over-cap repo). #1023 degraded-path coverage.
 */
export function _setLastGraphBuildInfoForTests(info: GraphBuildInfo): void {
	_lastGraphBuildInfo = info;
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
	// #782: a fresh size-skip verdict means the LAST build attempt found the
	// repo over the file cap — any graph cached/persisted from before that
	// (necessarily built over a smaller file set, since the too_many_files
	// branch never populates either cache tier) would silently under-report
	// fan-in/blastRadius as if the repo were still that small. Stop serving it
	// while the verdict is fresh rather than let it look current; it comes back
	// automatically the moment the verdict expires (repo shrunk, or the cap was
	// raised) and a build succeeds again.
	if (getReviewGraphSizeSkipVerdict(cwd)) return undefined;
	const cached = _workspaceGraphCache.get(key);
	if (cached) {
		touchWorkspaceGraph(key);
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
	// #1961: a snapshot stamped for a DIFFERENT WORKTREE is dropped here; one
	// stamped at a different HEAD is served and marked drifted. See
	// loadPersistedGraph for the one-policy rationale.
	const disk = loadPersistedGraph(cwd, {
		verifyWorktreeIdentity: true,
		allowPartial: true,
	});
	if (!disk) return undefined;
	setWorkspaceGraph(key, {
		signature: disk.signature,
		fileSignatures: disk.fileSignatures,
		fileHashes: disk.fileHashes,
		graph: disk.graph,
		// Durable half of the drift fact. The current-HEAD half is never cached
		// beside it — see getReviewGraphRevisionDrift (#1961 review F3).
		...(disk.stampedHead ? { snapshotStampedHead: disk.stampedHead } : {}),
	});
	return disk.graph;
}

/**
 * Revision drift for `cwd`'s currently cached graph, computed NOW (#1961).
 *
 * Returns the stamped/current commit pair when the warm entry came from a disk
 * snapshot whose stamp names a commit other than the worktree's HEAD at this
 * instant, and `undefined` otherwise — including the case where HEAD has moved
 * BACK to the stamped commit, which resolves the drift and must clear the note.
 *
 * Derived, never stored: caching the pair is what made the first version of
 * this feature report a commit that had since stopped being HEAD, and keep
 * reporting drift after it was resolved. Callers ask on every render.
 */
export function getReviewGraphRevisionDrift(
	cwd: string,
): ReviewGraphRevisionDrift | undefined {
	const entry = _workspaceGraphCache.get(normalizeMapKey(cwd));
	const stampedHead = entry?.snapshotStampedHead;
	if (!stampedHead) return undefined;
	const current = resolveGitIdentity(cwd);
	// Unresolvable identity is "can't tell", never "drifted" — the same
	// fail-open rule loadPersistedGraph applies to the worktree check.
	if (!current || current.headCommit === stampedHead) return undefined;
	return { stampedHead, currentHead: current.headCommit };
}

// Re-exported so a consumer that already imports the builder dynamically
// (module_report) gets the accessor and its renderer from one place (#1961).
export { formatReviewGraphRevisionDriftNote };

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
		// Edges are immutable values: update paths replace/filter entries rather
		// than mutating them, so copying the array is sufficient isolation.
		edges: [...graph.edges],
		edgesByFrom: new Map(),
		edgesByTo: new Map(),
		fileNodes: new Map(),
		symbolNodesByFile: new Map(),
		changedSymbolsByFile: new Map(graph.changedSymbolsByFile),
		// Carry the partial-coverage marker so a clone can never silently pose as
		// a complete graph (#936 review). The build path additionally refuses a
		// partial base outright; this keeps any other cloner honest.
		persistCoverage: graph.persistCoverage,
	};
}

/** Refresh the content timestamp only when an incremental path changed graph data. */
function refreshGraphBuiltAt(graph: ReviewGraph): void {
	graph.builtAt = new Date().toISOString();
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

// #776: `PI_LENS_REVIEW_GRAPH_MAX_FILES` (the existing per-subsystem env
// override) still wins outright; below it, the derived `maxProjectFiles`
// scale-knob value (see `project-scale.ts`) replaces the old hardcoded
// `RUNTIME_CONFIG.reviewGraph.maxFiles` constant as the fallback — the ratio
// table reproduces that same 1,000-file default at the default base, so this
// is behavior-neutral when nothing is configured.
export function getReviewGraphMaxFiles(cwd?: string): number {
	const override = Number.parseInt(
		process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES ?? "",
		10,
	);
	return Number.isFinite(override) && override > 0
		? override
		: getReviewGraphMaxFilesDerived(cwd);
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

// #782: a size-skipped build (too_many_files below) is otherwise
// indistinguishable, at the read layer, from an ordinary cold cache — and a
// graph cached/persisted BEFORE the repo crossed the cap kept being served by
// getCachedReviewGraph forever. Recording a TTL'd "size-skip verdict" per cwd
// fixes both: getCachedReviewGraph consults it below to stop serving a
// pre-cap graph while the repo is confirmed over cap, and consumers
// (project_report) can read it to render an honest "disabled, not cold" hint
// instead of "retry shortly".
//
// In-memory only, per cwd, mirroring `_workspaceGraphCache` — not persisted
// to disk. Every real caller either rebuilds within a session (the edit
// pipeline, project_report's background trigger) or restarts the process (a
// fresh in-memory verdict is recomputed on the very next build attempt), so
// there's no cross-process staleness gap worth the extra persistence
// machinery `too-many-source-files` needed (that verdict is cached across
// process starts specifically to skip a slow walk — this one is a cheap
// flag alongside a walk that already ran).
//
// TTL default matches project-report.ts's STALE_THRESHOLD_MS (15 minutes):
// long enough that a single flag isn't thrashed by back-to-back builds, short
// enough that a repo shrink or a `.pi-lens.json`/env cap raise is noticed
// without restarting the process.
const DEFAULT_REVIEW_GRAPH_SIZE_SKIP_TTL_MS = 15 * 60_000;

const _sizeSkipTtl = lazyEnvNumber(
	"PI_LENS_REVIEW_GRAPH_SIZE_SKIP_TTL_MS",
	DEFAULT_REVIEW_GRAPH_SIZE_SKIP_TTL_MS,
);

/** Test-only: clears the memoized TTL so a subsequent call re-reads the env var. */
export const _resetReviewGraphSizeSkipTtlForTests = _sizeSkipTtl._resetForTests;

export interface ReviewGraphSizeSkipVerdict {
	/**
	 * Graph-relevant source files observed before the capped walk stopped.
	 * This is the maxFileCount+1 sentinel, NOT the project's exact file count.
	 */
	sourceFileCount: number;
	/** The cap (derived `maxProjectFiles` or `PI_LENS_REVIEW_GRAPH_MAX_FILES`) that was exceeded. */
	maxFileCount: number;
	/** `sourceFileCount` is maxFileCount+1 sentinel data, not an exact total. */
	sourceFileCountTruncated: true;
	/** Wall-clock (`Date.now()`) the skip was recorded — see {@link getReviewGraphSizeSkipVerdict}. */
	skippedAt: number;
}

export interface ReviewGraphBuildAttempt {
	when: string;
	outcome: "running" | "succeeded" | "skipped" | "failed";
	buildId?: number;
	reason?: string;
}

const _buildAttempts = new Map<string, ReviewGraphBuildAttempt>();

export function getLastReviewGraphBuildAttempt(
	cwd: string,
): ReviewGraphBuildAttempt | undefined {
	return _buildAttempts.get(normalizeMapKey(cwd));
}

export function _resetReviewGraphBuildAttemptsForTests(): void {
	_buildAttempts.clear();
}

function recordBuildAttempt(
	cwd: string,
	outcome: ReviewGraphBuildAttempt["outcome"],
	reason?: string,
	buildId?: number,
): void {
	const key = normalizeMapKey(cwd);
	const prior = _buildAttempts.get(key);
	// Build IDs are assigned at start, so a terminal event from an older
	// overlapping build must never overwrite the newest build's status/reason.
	// Keep the newest started attempt as the project-report truth source.
	if (
		prior?.buildId !== undefined &&
		(buildId === undefined || buildId < prior.buildId)
	) {
		return;
	}
	_buildAttempts.set(key, {
		when: new Date().toISOString(),
		outcome,
		...(buildId === undefined ? {} : { buildId }),
		...(reason ? { reason } : {}),
	});
}

function recordPersistFailure(
	cwd: string,
	reason: string,
	error: string,
	pending?: PendingPersist,
	workerState?: {
		started: boolean;
		completed: boolean;
		fallbackReason?: string;
	},
): void {
	// A debounced persist can fail AFTER a newer build already recorded
	// "failed" or "running" for this cwd — don't relabel a dead/in-flight
	// build as succeeded; only annotate a record that says succeeded.
	const prior = _buildAttempts.get(normalizeMapKey(cwd));
	const pendingBuildId = pending?.graphMetadata.buildId;
	const belongsToCurrentBuild =
		pendingBuildId === undefined || prior?.buildId === pendingBuildId;
	if (
		belongsToCurrentBuild &&
		(prior === undefined || prior.outcome === "succeeded")
	) {
		recordBuildAttempt(
			cwd,
			"succeeded",
			`graph built but persistence failed: ${error}`,
			pendingBuildId,
		);
	}
	logReviewGraph({
		cwd,
		phase: "persist_failed",
		reason,
		error,
		...(pending
			? {
					observability: persistObservability(pending, {
						status: "failed",
						reason: workerState?.fallbackReason ?? reason,
						workerStarted: workerState?.started,
						workerCompleted: workerState?.completed,
						...(workerState?.fallbackReason ? { workerFallback: true } : {}),
					}),
				}
			: {}),
	});
}

const _sizeSkipVerdicts = new Map<string, ReviewGraphSizeSkipVerdict>();

/** Test-only: clears every recorded size-skip verdict. */
export function _resetReviewGraphSizeSkipVerdictsForTests(): void {
	_sizeSkipVerdicts.clear();
}

function recordReviewGraphSizeSkip(
	cwd: string,
	sourceFileCount: number,
	maxFileCount: number,
): void {
	_sizeSkipVerdicts.set(normalizeMapKey(cwd), {
		sourceFileCount,
		maxFileCount,
		sourceFileCountTruncated: true,
		skippedAt: Date.now(),
	});
}

function clearReviewGraphSizeSkip(cwd: string): void {
	_sizeSkipVerdicts.delete(normalizeMapKey(cwd));
}

const REVIEW_GRAPH_SIZE_NEAR_MISS_RATIO = 0.05;

function isReviewGraphSizeNearMiss(
	sourceFileCount: number,
	maxFileCount: number,
): boolean {
	return (
		sourceFileCount > maxFileCount &&
		sourceFileCount <= maxFileCount * (1 + REVIEW_GRAPH_SIZE_NEAR_MISS_RATIO)
	);
}

/**
 * The most recent size-skip verdict for `cwd`, if one was recorded and it's
 * still within its TTL — undefined once expired (a shrink or a raised cap
 * gets re-checked on the next build attempt) or if no skip has ever been
 * recorded. Consumers (project_report) use this to tell "graph disabled
 * because the repo is over the file cap" apart from "cold cache, build in
 * progress".
 */
export function getReviewGraphSizeSkipVerdict(
	cwd: string,
	now: number = Date.now(),
): ReviewGraphSizeSkipVerdict | undefined {
	const key = normalizeMapKey(cwd);
	const verdict = _sizeSkipVerdicts.get(key);
	if (!verdict) return undefined;
	if (now - verdict.skippedAt >= _sizeSkipTtl.get()) {
		_sizeSkipVerdicts.delete(key);
		return undefined;
	}
	return verdict;
}

interface GraphSourceFilesResult {
	files: string[];
	/** Number of source files represented by this walk; a lower bound when truncated. */
	sourceFileCount: number;
	/** Per-build file cap captured before the asynchronous walk begins. */
	maxFileCount: number;
	entryBudgetExceeded: boolean;
}

// Test-only override so the entry-budget propagation contract can be exercised
// without constructing a 200k-entry fixture tree.
let _reviewGraphEntryBudgetForTests: number | undefined;
export function _setReviewGraphEntryBudgetForTests(
	maxScanEntries?: number,
): void {
	_reviewGraphEntryBudgetForTests = maxScanEntries;
}

let _reviewGraphEntryCounterForTests: (() => void) | undefined;
export function _setReviewGraphEntryCounterForTests(
	counter?: () => void,
): void {
	_reviewGraphEntryCounterForTests = counter;
}

export async function getGraphSourceFiles(
	cwd: string,
): Promise<GraphSourceFilesResult> {
	// Async, chunked-yield walk (identical output to the sync collector) so the
	// per-edit cascade graph rebuild doesn't block the event loop on a large repo.
	//
	// Cap the walk at maxGraphFiles+1: an over-limit repo (or a root that climbed
	// to $HOME) short-circuits collection instead of enumerating the entire tree
	// and paying a statSync per file before the caller bails on count (#250). When
	// the cap is hit the caller skips the build on count alone, so the unfiltered
	// over-limit list is all it needs — see _doBuildGraph's too_many_files branch.
	const maxGraphFiles = getReviewGraphMaxFiles(cwd);
	// #760: the maxFiles cap bounds results FOUND, not entries VISITED. A mixed
	// tree with few source files among a huge pile of non-source files can trip the
	// entry budget first. That result is a useful partial graph, but its lower-bound
	// count MUST travel with the graph and persistence metadata; it is never clean.
	const { files: collected, entryBudgetExceeded } =
		await collectProjectSourceFilesWithBudgetAsync(cwd, {
			// Only walk graph-relevant extensions so the cap counts what the graph
			// keeps (post-filter), not JSON/YAML/MD noise it would discard anyway.
			extensions: MAIN_KIND_EXTENSIONS,
			maxFiles: maxGraphFiles + 1,
			...(_reviewGraphEntryBudgetForTests === undefined
				? {}
				: { maxScanEntries: _reviewGraphEntryBudgetForTests }),
			...(_reviewGraphEntryCounterForTests === undefined
				? {}
				: { onEntryVisited: _reviewGraphEntryCounterForTests }),
		});
	if (entryBudgetExceeded) {
		logLatency({
			type: "phase",
			phase: "review_graph_source_walk_entry_budget",
			filePath: cwd,
			durationMs: 0,
			metadata: { cwd, collectedFiles: collected.length },
		});
	}
	if (collected.length > maxGraphFiles) {
		// Contents are unused by the too_many_files branch; return the capped list
		// so the caller's `length > maxGraphFiles` check still trips.
		return {
			files: collected,
			sourceFileCount: collected.length,
			maxFileCount: maxGraphFiles,
			entryBudgetExceeded,
		};
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
	return {
		files: result,
		sourceFileCount: result.length,
		maxFileCount: maxGraphFiles,
		entryBudgetExceeded,
	};
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

const GRAPH_CACHE_FILENAME = "review-graph.json.gz";
const LEGACY_GRAPH_CACHE_FILENAME = "review-graph.json";
// #936 limit 2: the mid-build resume checkpoint lives in its OWN file, distinct
// from the authoritative `review-graph.json.gz`. Keeping it separate is the
// core honesty guarantee — `loadPersistedGraph` / `getCachedReviewGraph` only
// ever read the authoritative snapshot, so a mid-build checkpoint can never be
// laundered to a consumer as a complete graph. It is read back exclusively by
// the full-build resume path (`loadReviewGraphCheckpoint`).
const GRAPH_CHECKPOINT_FILENAME = "review-graph.checkpoint.json.gz";

interface PersistedGraphData {
	version: string;
	builtAt: string;
	signature: string;
	fileSignatures?: Array<[string, string]>;
	fileHashes?: Array<[string, string]>;
	nodes: Array<[string, ReviewGraphNode]>;
	edges: ReviewGraphEdge[];
	/** Honest total-vs-persisted counts for capped snapshots (#936). */
	coverage?: ReviewGraphPersistCoverage;
	// #300: git identity captured at persist time (fs-resolved, no `git` spawn —
	// see git-identity.ts). Optional so an older snapshot without a stamp still
	// loads exactly as before — only a PRESENT stamp that MISMATCHES the current
	// repo drops the snapshot. Absent for non-git cwds (no check possible).
	gitStamp?: { headCommit: string; worktreeRoot: string };
}

/**
 * Record what the blind read decided about a stamped snapshot (#1961).
 *
 * Bounded the way AGENTS.md requires and `bounded-telemetry.ts` documents: the
 * ledger counts EVERY occurrence exactly, and only the rising edge per
 * (verdict, cwd) also writes the detailed `review-graph.log` record. The
 * accessor runs on every module_report / lens-engine / project_report call, so
 * an unbounded record here would flood the log during a single navigation
 * session. No second latch: the rising edge comes from the ledger's own tally.
 */
function logSnapshotReadVerdict(
	cwd: string,
	phase: "snapshot_read_dropped" | "snapshot_read_drifted",
	reason: string,
): void {
	const verdict = phase === "snapshot_read_dropped" ? "dropped" : "drifted";
	const isRisingEdge = incrementDegradationCount({
		kind: "review-graph-snapshot-read",
		// Subject keeps BOTH discriminators, so aggregation still answers which
		// workspace and which verdict after the detailed records stop.
		subject: `${verdict}:${normalizeMapKey(cwd)}`,
		reason,
	});
	if (!isRisingEdge) return;
	logReviewGraph({ cwd, phase, reason });
}

function loadPersistedGraph(
	cwd: string,
	opts?: { verifyWorktreeIdentity?: boolean; allowPartial?: boolean },
): {
	signature: string;
	fileSignatures: Map<string, string>;
	fileHashes: Map<string, string>;
	graph: ReviewGraph;
	/**
	 * `gitStamp.headCommit` of the snapshot just loaded, when it names a commit
	 * other than the current HEAD. The durable half of the drift fact — the
	 * caller stores this and pairs it with a freshly resolved HEAD per render
	 * (#1961 review F3). Set only under `verifyWorktreeIdentity`; the build path
	 * content-verifies downstream and has no use for it.
	 */
	stampedHead?: string;
} | null {
	const cacheDir = path.join(getProjectDataDir(cwd), "cache");
	const cachePath = path.join(cacheDir, GRAPH_CACHE_FILENAME);
	const legacyPath = path.join(cacheDir, LEGACY_GRAPH_CACHE_FILENAME);
	try {
		const raw = fs.existsSync(cachePath)
			? gunzipSync(fs.readFileSync(cachePath)).toString("utf-8")
			: fs.readFileSync(legacyPath, "utf-8");
		const data = JSON.parse(raw) as PersistedGraphData;
		// Derived projections require a canonical source identity. Legacy or
		// malformed snapshots are unavailable, never a clean empty graph.
		if (
			data.version !== REVIEW_GRAPH_VERSION ||
			typeof data.signature !== "string" ||
			typeof data.builtAt !== "string" ||
			!Array.isArray(data.nodes) ||
			!Array.isArray(data.edges)
		)
			return null;
		if (data.coverage?.partial && !opts?.allowPartial) return null;
		// #1961: ONE verification policy across both load paths — verify tree
		// IDENTITY, never revision. A HEAD move says nothing about file contents,
		// and the build path's tier-2 load has said so since #300 (see the comment
		// above its `loadPersistedGraph(cwd)` call): dropping on every HEAD move
		// forces a full whole-repo rebuild after each plain `git commit`. The BLIND
		// read path used to do exactly that, which is why a snapshot survived a
		// median of ~12 minutes before every reader saw "graph: cold".
		//
		// What stays: `worktreeRoot`. A snapshot stamped for a DIFFERENT worktree
		// reached this data dir through slug reuse, so it describes another tree
		// and nothing downstream would catch it — this read is blind. What goes:
		// the `headCommit` equality drop. A revision difference is now REPORTED
		// (`stampedHead` below → `getReviewGraphRevisionDrift` → computeTrust and
		// module_report) instead of hiding the graph. Any resolution failure
		// (non-git, unreadable HEAD) yields undefined from resolveGitIdentity —
		// "can't verify," not a mismatch, so it does not drop the snapshot.
		let stampedHead: string | undefined;
		if (opts?.verifyWorktreeIdentity && data.gitStamp) {
			const current = resolveGitIdentity(cwd);
			if (current && current.worktreeRoot !== data.gitStamp.worktreeRoot) {
				logSnapshotReadVerdict(
					cwd,
					"snapshot_read_dropped",
					"worktree_mismatch",
				);
				return null;
			}
			if (current && current.headCommit !== data.gitStamp.headCommit) {
				stampedHead = data.gitStamp.headCommit;
				logSnapshotReadVerdict(cwd, "snapshot_read_drifted", "head_moved");
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
			persistCoverage: data.coverage,
		};
		rebuildIndexes(graph);
		return {
			signature: data.signature,
			fileSignatures: new Map(data.fileSignatures ?? []),
			fileHashes: new Map(data.fileHashes ?? []),
			graph,
			...(stampedHead ? { stampedHead } : {}),
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
	const cacheDir = path.join(getProjectDataDir(cwd), "cache");
	const cachePath = path.join(cacheDir, GRAPH_CACHE_FILENAME);
	const legacyPath = path.join(cacheDir, LEGACY_GRAPH_CACHE_FILENAME);
	if (fs.existsSync(cachePath)) {
		// #950 review F4: never inflate+parse the whole multi-MB snapshot just
		// to read the version. `version` is serialized first, so decompressing
		// the first few KB (Z_SYNC_FLUSH tolerates the truncated stream) is
		// enough to sniff it — the gz analogue of the legacy 200-byte header
		// read below.
		let fd: number | undefined;
		try {
			fd = fs.openSync(cachePath, "r");
			const compressed = Buffer.alloc(4096);
			const n = fs.readSync(fd, compressed, 0, compressed.length, 0);
			const head = gunzipSync(compressed.subarray(0, n), {
				finishFlush: zlibConstants.Z_SYNC_FLUSH,
			}).toString("utf-8");
			const match = head.match(/"version"\s*:\s*"([^"]+)"/);
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
	let fd: number | undefined;
	try {
		fd = fs.openSync(legacyPath, "r");
		const buf = Buffer.alloc(200);
		const n = fs.readSync(fd, buf, 0, 200, 0);
		const match = buf
			.toString("utf-8", 0, n)
			.match(/"version"\s*:\s*"([^"]+)"/);
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
//   2. Ceiling: serialize only a centrality-ranked subgraph above the element
//      cap. Its coverage marker stays honest without risking the full-graph OOM
//      that introduced this guard.
const GRAPH_PERSIST_DEBOUNCE_MS_DEFAULT = 1500;
export const GRAPH_PERSIST_MAX_ELEMENTS_DEFAULT = 500_000;

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
	signature: string;
	fileSignatures: Map<string, string>;
	fileHashes?: Map<string, string>;
	graph: ReviewGraph;
	gitStamp?: { headCommit: string; worktreeRoot: string };
	elementCount: number;
	generation: number;
	attemptId: number;
	graphMetadata: ReviewGraphBuildMetadata;
	persistenceMetadata: ReviewGraphPersistenceMetadata;
}
const _pendingPersist = new Map<string, PendingPersist>();
const _persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const _persistGenerations = new Map<string, number>();
const _workerRequests = new Map<
	number,
	{ key: string; pending: PendingPersist }
>();
let _persistWorker: Worker | undefined;
let _persistWorkerRequestId = 0;
let _persistAttemptId = 0;
let _workerDisabled = false;
let _persistWorkerUnavailableReason: string | undefined;
let _lastWorkerFallbackReasonForTests: string | undefined;

// #936/#958 follow-up: the mid-build resume checkpoint offloads its stringify+
// gzip to the SAME shared persist worker (keeping the gzip of a growing graph
// off the event loop during a background build). Tracked in a disjoint id/
// generation space so handleWorkerResult routes a checkpoint promotion — a
// distinct target path — without touching the authoritative-persist path. A
// checkpoint write is best-effort: a lost one only costs a cold rebuild, so a
// worker failure/death just drops it (the prior stride's checkpoint stays on
// disk) rather than falling back like the authoritative persist does.
interface PendingCheckpointWrite {
	cwd: string;
	generation: number;
	checkpointPath: string;
	stagePath: string;
	nodes: number;
	edges: number;
	processed: number;
	target: number;
}
const _checkpointGenerations = new Map<string, number>();
const _checkpointWorkerRequests = new Map<number, PendingCheckpointWrite>();
// Test-observable: how many checkpoint writes actually took the OFFLOADED
// (worker) path rather than the synchronous fallback, so a test can assert the
// offload really fired instead of passing trivially on a completed build.
let _checkpointOffloadCountForTests = 0;

function persistedData(pending: PendingPersist): PersistedGraphData {
	return {
		version: pending.graph.version,
		builtAt: pending.graph.builtAt,
		signature: pending.signature,
		fileSignatures: Array.from(pending.fileSignatures.entries()),
		fileHashes: pending.fileHashes
			? Array.from(pending.fileHashes.entries())
			: undefined,
		nodes: Array.from(pending.graph.nodes.entries()),
		edges: pending.graph.edges,
		coverage: pending.graph.persistCoverage,
		gitStamp: pending.gitStamp,
	};
}

function countRetainedSourceFiles(
	graph: ReviewGraph,
	sourceFilePaths?: Iterable<string>,
): number {
	if (sourceFilePaths === undefined) return graph.fileNodes.size;
	const sourceKeys = new Set<string>();
	for (const filePath of sourceFilePaths) {
		sourceKeys.add(normalizeMapKey(filePath));
	}
	let retained = 0;
	for (const filePath of sourceKeys) {
		if (graph.fileNodes.has(filePath)) retained++;
	}
	return retained;
}

function graphCoverage(
	graph: ReviewGraph,
	cap: number,
	sourceFileCount = graph.persistCoverage?.totalFiles ?? graph.fileNodes.size,
	sourceFilesTruncated = graph.persistCoverage?.sourceFilesTruncated === true,
	sourceFilePaths?: Iterable<string>,
): ReviewGraphPersistCoverage {
	const inherited = graph.persistCoverage;
	return {
		partial: inherited?.partial === true || sourceFilesTruncated,
		cap,
		totalNodes: graph.nodes.size,
		totalEdges: graph.edges.length,
		persistedNodes: graph.nodes.size,
		persistedEdges: graph.edges.length,
		totalFiles: sourceFileCount,
		persistedFiles: countRetainedSourceFiles(graph, sourceFilePaths),
		...(sourceFilesTruncated ? { sourceFilesTruncated: true } : {}),
		...(inherited?.inProgress ? { inProgress: true } : {}),
	};
}

/**
 * Keep whole per-file node groups in reverse-dependency-centrality order, then
 * retain as many induced edges as fit. The node budget mirrors the source
 * graph's node/edge ratio so symbol-dense and edge-dense repositories both
 * retain a useful mix instead of allowing either side to consume the cap.
 */
function capGraphForPersist(
	cwd: string,
	graph: ReviewGraph,
	cap: number,
	options: {
		sourceFileCount?: number;
		sourceFilesTruncated?: boolean;
		sourceFilePaths?: Iterable<string>;
	} = {},
): ReviewGraph {
	const totalElements = graph.nodes.size + graph.edges.length;
	const nodeBudget = Math.max(
		1,
		Math.floor((cap * graph.nodes.size) / totalElements),
	);
	const reverseDeps = buildReverseDependencyIndexFromGraph({ cwd, graph });
	const rankedFiles = rankFilesByReverseDependencyCentrality(reverseDeps);
	const nodeIdsByFile = new Map<string, string[]>();
	for (const [id, node] of graph.nodes) {
		if (!node.filePath) continue;
		const ids = nodeIdsByFile.get(node.filePath) ?? [];
		ids.push(id);
		nodeIdsByFile.set(node.filePath, ids);
	}

	const keptIds = new Set<string>();
	for (const filePath of rankedFiles) {
		const ids = nodeIdsByFile.get(filePath) ?? [];
		if (ids.length === 0) continue;
		const effectiveNodeBudget =
			keptIds.size === 0
				? Math.max(nodeBudget, Math.min(cap, ids.length))
				: nodeBudget;
		if (keptIds.size + ids.length > effectiveNodeBudget) continue;
		for (const id of ids) keptIds.add(id);
	}
	const nodes = new Map([...graph.nodes].filter(([id]) => keptIds.has(id)));
	const edgeBudget = Math.max(0, cap - nodes.size);
	const edges = graph.edges
		.filter((edge) => keptIds.has(edge.from) && keptIds.has(edge.to))
		.slice(0, edgeBudget);
	const coverage: ReviewGraphPersistCoverage = {
		partial: true,
		cap,
		totalNodes: graph.nodes.size,
		totalEdges: graph.edges.length,
		persistedNodes: nodes.size,
		persistedEdges: edges.length,
		totalFiles:
			options.sourceFileCount ??
			graph.persistCoverage?.totalFiles ??
			graph.fileNodes.size,
		persistedFiles: 0,
		...(options.sourceFilesTruncated ||
		graph.persistCoverage?.sourceFilesTruncated
			? { sourceFilesTruncated: true as const }
			: {}),
		...(graph.persistCoverage?.inProgress ? { inProgress: true as const } : {}),
	};
	const capped: ReviewGraph = {
		...graph,
		nodes,
		edges,
		edgesByFrom: new Map(),
		edgesByTo: new Map(),
		fileNodes: new Map(),
		symbolNodesByFile: new Map(),
		changedSymbolsByFile: new Map(),
		persistCoverage: undefined,
	};
	rebuildIndexes(capped);
	coverage.persistedFiles = countRetainedSourceFiles(
		capped,
		options.sourceFilePaths,
	);
	capped.persistCoverage = coverage;
	return capped;
}

function persistObservability(
	pending: PendingPersist,
	patch: Partial<ReviewGraphPersistenceMetadata>,
): {
	graph: ReviewGraphBuildMetadata;
	persistence: ReviewGraphPersistenceMetadata;
} {
	return {
		graph: pending.graphMetadata,
		persistence: { ...pending.persistenceMetadata, ...patch },
	};
}

function logPersistSuccess(
	key: string,
	pending: PendingPersist,
	stats: {
		rawBytes: number;
		gzBytes: number;
		serializeMs: number;
		writeMs: number;
		offloaded: boolean;
	},
	workerState: {
		started: boolean;
		completed: boolean;
		fallback?: boolean;
	} = { started: false, completed: false },
): void {
	logLatency({
		type: "phase",
		phase: "review_graph_persist",
		filePath: pending.cachePath,
		durationMs: stats.serializeMs + stats.writeMs,
		metadata: { elements: pending.elementCount, ...stats },
	});
	logReviewGraph({
		cwd: key,
		phase: "persist_succeeded",
		elements: pending.elementCount,
		...stats,
		observability: persistObservability(pending, {
			status: "succeeded",
			workerStarted: workerState.started,
			workerCompleted: workerState.completed,
			...(workerState.fallback ? { workerFallback: true } : {}),
		}),
	});
}

function writePendingOnMainThread(
	key: string,
	pending: PendingPersist,
	reason?: string,
	workerState: {
		started: boolean;
		completed: boolean;
		fallbackReason?: string;
	} = { started: false, completed: false },
): void {
	const serializeStarted = performance.now();
	try {
		const json = JSON.stringify(persistedData(pending));
		const serializeMs = performance.now() - serializeStarted;
		const rawBytes = Buffer.byteLength(json);
		const writeStarted = performance.now();
		const gzip = gzipSync(json);
		fs.mkdirSync(pending.cacheDir, { recursive: true });
		writeFileAtomic(pending.cachePath, gzip, { bestEffort: false });
		fs.rmSync(path.join(pending.cacheDir, LEGACY_GRAPH_CACHE_FILENAME), {
			force: true,
		});
		logPersistSuccess(
			key,
			pending,
			{
				rawBytes,
				gzBytes: gzip.byteLength,
				serializeMs,
				writeMs: performance.now() - writeStarted,
				offloaded: false,
			},
			{
				started: workerState.started,
				completed: workerState.completed,
				fallback: Boolean(reason),
			},
		);
		if (reason) {
			// The persist SUCCEEDED via fallback — log the degradation under its
			// own phase, not persist_failed (#950 review F7: a success followed
			// by persist_failed read as contradiction in telemetry).
			_lastWorkerFallbackReasonForTests = reason;
			logReviewGraph({
				cwd: key,
				phase: "worker_fallback",
				reason: "worker_fallback",
				error: reason,
				offloaded: false,
				observability: persistObservability(pending, {
					status: "fallback",
					workerStarted: workerState.started,
					workerCompleted: workerState.completed,
					workerFallback: true,
					reason: workerState.fallbackReason ?? "worker_fallback",
				}),
			});
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		recordPersistFailure(
			key,
			"cache_write_failed",
			message,
			pending,
			workerState,
		);
		// #1333: recordPersistFailure already emits `phase: "persist_failed"` to
		// review-graph.log with this same message — the console.error was a
		// duplicate RAW write into pi's frame, not a second destination.
	}
}

function handleWorkerResult(result: ReviewGraphPersistWorkerResult): void {
	// Checkpoint offloads share this worker but promote to a different target;
	// route them out before the authoritative-persist path (disjoint id space,
	// so a checkpoint id is never also an authoritative one).
	const checkpoint = _checkpointWorkerRequests.get(result.id);
	if (checkpoint) {
		handleCheckpointWorkerResult(checkpoint, result);
		return;
	}
	const request = _workerRequests.get(result.id);
	if (!request) {
		fs.rm(result.stagePath, { force: true }, () => {});
		return;
	}
	_workerRequests.delete(result.id);
	const { key, pending } = request;
	const currentGeneration = _persistGenerations.get(key);
	if (currentGeneration !== result.generation) {
		// Removing the request makes completion observable to test/CLI waiters.
		// Reap our completed loser synchronously first so "no requests in flight"
		// also means its stage namespace is clean (#1318). Caught (#1361 review):
		// force suppresses ENOENT but not EBUSY/EPERM (Windows AV/backup can
		// briefly hold the handle) -- a failed reap must never abort this
		// callback, or the WINNING generation's completion is lost with it. The
		// startup sweep reclaims anything a failed unlink leaves behind.
		try {
			fs.rmSync(result.stagePath, { force: true });
		} catch (reapErr) {
			logReviewGraph({
				cwd: key,
				phase: "persist_failed",
				reason: `superseded-stage reap failed: ${String(reapErr)}`,
			});
		}
		logReviewGraph({
			cwd: key,
			phase: "persist_skipped",
			reason: "superseded",
			observability: persistObservability(pending, {
				status: "superseded",
				supersededByGeneration: currentGeneration,
				reason: "newer_generation_scheduled",
				workerStarted: true,
				workerCompleted: true,
			}),
		});
		return;
	}
	if (
		result.error ||
		result.rawBytes === undefined ||
		result.gzBytes === undefined ||
		result.serializeMs === undefined ||
		result.writeMs === undefined
	) {
		fs.rm(result.stagePath, { force: true }, () => {});
		writePendingOnMainThread(
			key,
			pending,
			result.error ?? "invalid worker result",
			{
				started: true,
				completed: true,
				fallbackReason: result.error ? "worker_error" : "invalid_worker_result",
			},
		);
		return;
	}
	try {
		fs.renameSync(result.stagePath, pending.cachePath);
		fs.rmSync(path.join(pending.cacheDir, LEGACY_GRAPH_CACHE_FILENAME), {
			force: true,
		});
		logPersistSuccess(
			key,
			pending,
			{
				rawBytes: result.rawBytes,
				gzBytes: result.gzBytes,
				serializeMs: result.serializeMs,
				writeMs: result.writeMs,
				offloaded: true,
			},
			{ started: true, completed: true },
		);
	} catch (err) {
		fs.rm(result.stagePath, { force: true }, () => {});
		writePendingOnMainThread(
			key,
			pending,
			err instanceof Error ? err.message : String(err),
			{
				started: true,
				completed: true,
				fallbackReason: "promotion_failed",
			},
		);
	}
}

function handleCheckpointWorkerResult(
	cp: PendingCheckpointWrite,
	result: ReviewGraphPersistWorkerResult,
): void {
	_checkpointWorkerRequests.delete(result.id);
	// Best-effort: a failed offload just means no checkpoint for this stride —
	// the prior stride's checkpoint is still on disk and the next stride retries.
	// Still surface it: a SYSTEMIC failure (disk full, perms, worker crash-loop)
	// makes resume silently never work, and `checkpoint_written` just stops.
	if (result.error || result.gzBytes === undefined) {
		logReviewGraph({
			cwd: cp.cwd,
			phase: "checkpoint_write_failed",
			reason: "worker_error",
			error: result.error ?? "worker returned no gz metrics",
		});
		fs.rm(result.stagePath, { force: true }, () => {});
		return;
	}
	// Generation gate: a newer checkpoint stride, or build completion / a
	// discarded resume (deleteReviewGraphCheckpoint bumps the generation before
	// removing the file), supersedes this write — discard the stale stage rather
	// than resurrect a checkpoint over a fresher one or a completed build.
	if (_checkpointGenerations.get(cp.cwd) !== cp.generation) {
		fs.rm(result.stagePath, { force: true }, () => {});
		return;
	}
	try {
		fs.renameSync(result.stagePath, cp.checkpointPath);
		logReviewGraph({
			cwd: cp.cwd,
			phase: "checkpoint_written",
			nodes: cp.nodes,
			edges: cp.edges,
			processed: cp.processed,
			target: cp.target,
			offloaded: true,
		});
	} catch (err) {
		logReviewGraph({
			cwd: cp.cwd,
			phase: "checkpoint_write_failed",
			reason: "promote_failed",
			error: err instanceof Error ? err.message : String(err),
		});
		fs.rm(result.stagePath, { force: true }, () => {});
	}
}

function handleWorkerDeath(reason: string): void {
	_persistWorkerUnavailableReason = reason;
	_persistWorker = undefined;
	_workerDisabled = true;
	const requests = [..._workerRequests.values()];
	_workerRequests.clear();
	for (const { key, pending } of requests) {
		if (_persistGenerations.get(key) !== pending.generation) {
			logReviewGraph({
				cwd: key,
				phase: "persist_skipped",
				reason: "superseded",
				observability: persistObservability(pending, {
					status: "superseded",
					supersededByGeneration: _persistGenerations.get(key),
					reason: "worker_death_after_newer_generation",
					workerStarted: true,
					workerCompleted: false,
				}),
			});
			continue;
		}
		writePendingOnMainThread(key, pending, reason, {
			started: true,
			completed: false,
			fallbackReason: "worker_death",
		});
	}
	// Best-effort checkpoints don't fall back (no retained DTO to pin heap); drop
	// their in-flight requests and clean up any stage files they may have left.
	const checkpoints = [..._checkpointWorkerRequests.values()];
	_checkpointWorkerRequests.clear();
	for (const cp of checkpoints) {
		logReviewGraph({
			cwd: cp.cwd,
			phase: "checkpoint_write_failed",
			reason: "worker_death",
			error: reason,
		});
		fs.rm(cp.stagePath, { force: true }, () => {});
	}
}

function resolvePersistWorkerPath(): string | undefined {
	// esbuild's dist bundle does NOT rewrite new URL(...) asset refs, so from
	// the bundled dist/index.js a sibling ./persist-worker.js resolves beside
	// the BUNDLE where nothing exists (#950 review F1 — the worker silently
	// never ran in production). Try the compiled-sibling layout first (source
	// checkout / unbundled dist/clients tree), then the dist-tree path
	// relative to the bundle entry.
	const candidates = [
		new URL("./persist-worker.js", import.meta.url),
		new URL("./clients/review-graph/persist-worker.js", import.meta.url),
	];
	for (const url of candidates) {
		try {
			const resolved = fileURLToPath(url);
			if (fs.existsSync(resolved)) return resolved;
		} catch {
			/* try next layout */
		}
	}
	return undefined;
}

function getPersistWorker(): Worker | undefined {
	if (_workerDisabled) return undefined;
	if (_persistWorker) return _persistWorker;
	try {
		const workerPath = resolvePersistWorkerPath();
		if (workerPath === undefined) {
			handleWorkerDeath("persist worker script not found in any layout");
			return undefined;
		}
		const worker = new Worker(workerPath);
		worker.on("message", handleWorkerResult);
		worker.on("error", (err: Error) => handleWorkerDeath(err.message));
		worker.on("exit", (code) => {
			if (_persistWorker !== worker) return;
			const hasPendingRequests =
				_workerRequests.size > 0 || _checkpointWorkerRequests.size > 0;
			if (code !== 0 || hasPendingRequests) {
				handleWorkerDeath(
					code !== 0
						? `persist worker exited with code ${code}`
						: "persist worker exited with pending requests",
				);
			} else {
				// Clean exit with no pending work (unref'd worker at teardown, or host
				// recycling): drop the stale reference so a later persist respawns
				// instead of posting into a dead worker (#950 review F7).
				_persistWorker = undefined;
			}
		});
		// #1148: adding a message listener refs the Worker's public MessagePort.
		// Unref only after every listener is installed so it stays background-only.
		worker.unref();
		_persistWorker = worker;
		return worker;
	} catch (err) {
		handleWorkerDeath(err instanceof Error ? err.message : String(err));
		return undefined;
	}
}

function writePending(key: string): void {
	const pending = _pendingPersist.get(key);
	if (!pending) return;
	_pendingPersist.delete(key);
	const timer = _persistTimers.get(key);
	if (timer) {
		clearTimeout(timer);
		_persistTimers.delete(key);
	}
	const worker = getPersistWorker();
	if (!worker) {
		const unavailableReason =
			_persistWorkerUnavailableReason ?? "persist worker unavailable";
		writePendingOnMainThread(key, pending, unavailableReason, {
			started: false,
			completed: false,
			fallbackReason: unavailableReason,
		});
		return;
	}
	const id = ++_persistWorkerRequestId;
	const stagePath = `${pending.cachePath}.stage-${process.pid}-${pending.generation}`;
	const request: ReviewGraphPersistWorkerRequest = {
		id,
		cwd: key,
		generation: pending.generation,
		stagePath,
		data: persistedData(pending),
		elements: pending.elementCount,
		testDelayMs:
			process.env.NODE_ENV === "test"
				? Number(process.env.PI_LENS_TEST_PERSIST_WORKER_DELAY_MS) || undefined
				: undefined,
	};
	_workerRequests.set(id, { key, pending });
	worker.postMessage(request);
}

// Flush any pending writes synchronously at process teardown so a debounced
// snapshot isn't lost. Sync writes only (no child spawn — see the teardown
// libuv hazard); best-effort.
let _persistExitHookInstalled = false;
function flushPendingReviewGraphPersistsAtExit(): void {
	const keys = new Set([
		..._pendingPersist.keys(),
		...[..._workerRequests.values()].map((request) => request.key),
	]);
	for (const key of keys) {
		// Shared with the CLI's forced flush — same persistedData DTO, same
		// atomic writer (#762), distinct failure label per source.
		flushReviewGraphPersist(key, "exit_hook");
	}
	// The review-graph logger's shared process-exit flusher was registered
	// before this hook. Flush again after emitting exit-hook outcomes so a
	// successful forced write cannot leave its lifecycle event buffered.
	flushReviewGraphLogSync();
	void _persistWorker?.terminate();
}

/** Test-only seam for the exit-hook ordering/durability contract. */
export function flushReviewGraphPersistsForExitForTests(): void {
	flushPendingReviewGraphPersistsAtExit();
}

function ensurePersistExitHook(): void {
	if (_persistExitHookInstalled) return;
	_persistExitHookInstalled = true;
	process.once("exit", flushPendingReviewGraphPersistsAtExit);
}

// #950 review F3: a process that dies between a worker's staged write and its
// promotion leaves review-graph.json.gz.stage-<pid>-<gen> (and the worker's
// <stage>.tmp-<pid>) behind forever — the exit hook can't run
// handleWorkerResult's rm. Sweep leftovers from PRIOR processes once per cache
// dir.
//
// #1206: `cacheDir` is the SHARED project cache dir (getProjectDataDir/cache)
// that every durable store stages into via writeFileAtomic's generic
// `<target>.tmp-<pid>`. The old predicate also matched that shape, so this
// sweep deleted OTHER modules' in-flight staging files in the window between
// their write and their rename — turning their rename into ENOENT (propagated
// out of markDisposition for bestEffort:false stores) or silently dropping the
// update. The sweep is therefore scoped to artifacts the review graph itself
// produces, all of which are `<review-graph.*>.stage-<pid>-<gen>`:
//   review-graph.json.gz.stage-<pid>-<gen>              (persistGraph, L1861)
//   review-graph.checkpoint.json.gz.stage-<pid>-<gen>   (checkpoint, L2259)
//   ...plus either's worker tmp `<stage>.tmp-<pid>`, which still carries both
//   the `review-graph.` prefix and the `.stage-` marker.
// (LEGACY_GRAPH_CACHE_FILENAME, `review-graph.json`, is never staged — it is
// only ever `rmSync`'d as a one-time migration cleanup — so it is not a
// producer here despite matching the prefix.)
// The bare `.tmp-<pid>` shape is never matched, which also makes this sweep
// independent of any change to atomic-write's staging name (#1205). Dropping
// that shape means the review-graph sweep is no longer the incidental GC for
// other stores' orphaned atomic-write temps; the generic `.tmp-*` namespace is
// now swept at session_start by instance-reaper (#1228), not by this graph
// artifact-specific pass.
//
// Liveness: an entry whose embedded stage pid is still alive belongs to a
// concurrent healthy owner (or to us) and is skipped, reusing the reaper's
// conservative `realIsPidAlive` (ESRCH-only-means-dead) rather than inventing
// a second liveness probe. A recycled pid can therefore leave one stale stage
// file behind instead of destroying a live one — deliberately the safe
// direction; a later process whose pid table has moved on sweeps it.
const _sweptStageDirs = new Set<string>();
const REVIEW_GRAPH_ARTIFACT_PREFIX = "review-graph.";
const STAGE_PID_PATTERN = /\.stage-(\d+)-/;

/** True only for a review-graph stage artifact left behind by a dead process. */
function isStaleReviewGraphStageFile(entry: string): boolean {
	if (!entry.startsWith(REVIEW_GRAPH_ARTIFACT_PREFIX)) return false;
	const match = STAGE_PID_PATTERN.exec(entry);
	if (!match) return false;
	const pid = Number(match[1]);
	if (pid === process.pid) return false; // our own live stage file
	return !realIsPidAlive(pid);
}

function sweepStaleStageFiles(cacheDir: string): void {
	if (_sweptStageDirs.has(cacheDir)) return;
	_sweptStageDirs.add(cacheDir);
	fs.readdir(cacheDir, (err, entries) => {
		if (err) return;
		for (const entry of entries) {
			if (!isStaleReviewGraphStageFile(entry)) continue;
			fs.rm(path.join(cacheDir, entry), { force: true }, () => {});
		}
	});
}

/** Test seam: the sweep runs at most once per cache dir per process. */
export function _resetReviewGraphStageSweepForTests(): void {
	_sweptStageDirs.clear();
}

function persistGraph(
	cwd: string,
	signature: string,
	fileSignatures: Map<string, string>,
	fileHashes: Map<string, string> | undefined,
	graph: ReviewGraph,
	options: {
		buildId?: number;
		projectSeq?: number;
		seqHint?: boolean;
		mode?: ReviewGraphBuildMode;
		sourceFileCount?: number;
		sourceFilesTruncated?: boolean;
		sourceFilePaths?: Iterable<string>;
	} = {},
): string | undefined {
	const totalElementCount = graph.nodes.size + graph.edges.length;
	const cap = graphPersistMaxElements();
	const sourceFileCount = options.sourceFileCount ?? fileSignatures.size;
	const sourceFilePaths = options.sourceFilePaths ?? fileSignatures.keys();
	const persistedGraph =
		totalElementCount > cap
			? capGraphForPersist(cwd, graph, cap, {
					sourceFileCount,
					sourceFilesTruncated: options.sourceFilesTruncated,
					sourceFilePaths,
				})
			: {
					...graph,
					persistCoverage: graphCoverage(
						graph,
						cap,
						sourceFileCount,
						options.sourceFilesTruncated,
						sourceFilePaths,
					),
				};
	const elementCount = persistedGraph.nodes.size + persistedGraph.edges.length;
	const sourceWalkPartial =
		persistedGraph.persistCoverage?.sourceFilesTruncated === true;
	let persistReason: string | undefined;
	if (totalElementCount > cap) {
		const coverage = persistedGraph.persistCoverage;
		if (!coverage) return;
		logLatency({
			type: "phase",
			phase: "review_graph_persist",
			filePath: cwd,
			durationMs: 0,
			metadata: {
				partial: true,
				totalElements: totalElementCount,
				persistedElements: elementCount,
				cap,
			},
		});
		persistReason =
			`persisted partial review graph (${elementCount}/${totalElementCount} elements; ` +
			`${coverage.persistedNodes}/${coverage.totalNodes} nodes, ` +
			`${coverage.persistedEdges}/${coverage.totalEdges} edges; ${cap} cap)`;
	} else if (sourceWalkPartial) {
		persistReason = "persisted partial review graph (source walk entry budget)";
	}
	const cacheDir = path.join(getProjectDataDir(cwd), "cache");
	const cachePath = path.join(cacheDir, GRAPH_CACHE_FILENAME);
	sweepStaleStageFiles(cacheDir);
	// #300: resolve the git stamp fresh at persist time (HEAD changes on
	// commit/checkout, so it isn't cached like the gitdir location — but these
	// are plain fs reads, cheap even called per-persist). undefined for
	// non-git cwds, which serializes as `gitStamp: undefined` → omitted key.
	const gitStamp = resolveGitIdentity(cwd);
	// Retain the immutable snapshot inputs and build their O(graph) serializable
	// arrays only after the quiet window. Replacing a pending entry during an edit
	// burst now avoids both serialization and the pre-serialization full copies.
	const key = normalizeMapKey(cwd);
	const priorGeneration = _persistGenerations.get(key);
	const existingPending = _pendingPersist.get(key);
	const existingTimer = _persistTimers.get(key);
	const generation = (priorGeneration ?? 0) + 1;
	const attemptId = ++_persistAttemptId;
	const coalesced = Boolean(existingPending || existingTimer);
	_persistGenerations.set(key, generation);
	const graphMetadata = graphLogMetadata(persistedGraph, {
		...options,
		sourceFileCount,
		sourceFileCountTruncated:
			persistedGraph.persistCoverage?.sourceFilesTruncated === true,
	});
	const persistenceMetadata: ReviewGraphPersistenceMetadata = {
		generation,
		attemptId,
		status: "scheduled",
		...(priorGeneration === undefined
			? {}
			: {
					supersededGeneration: priorGeneration,
					coalesced,
					reason: coalesced ? "debounced_coalescing" : "in_flight_supersession",
				}),
	};
	const pending: PendingPersist = {
		cacheDir,
		cachePath,
		signature,
		fileSignatures,
		fileHashes,
		graph: persistedGraph,
		gitStamp,
		elementCount,
		generation,
		attemptId,
		graphMetadata,
		persistenceMetadata,
	};
	if (existingPending) {
		logReviewGraph({
			cwd: key,
			phase: "persist_skipped",
			reason: "superseded",
			observability: persistObservability(existingPending, {
				status: "superseded",
				supersededByGeneration: generation,
				reason: "newer_generation_scheduled",
				workerStarted: false,
				workerCompleted: false,
			}),
		});
	}
	_pendingPersist.set(key, pending);
	if (totalElementCount > cap || sourceWalkPartial) {
		logReviewGraph({
			cwd,
			phase: "persist_partial",
			reason:
				totalElementCount > cap
					? "element_cap_exceeded"
					: "source_walk_entry_budget",
			elements: totalElementCount,
			persistedElements: elementCount,
			cap,
			observability: {
				graph: graphMetadata,
				persistence: persistenceMetadata,
			},
		});
	}
	logReviewGraph({
		cwd,
		phase: "persist_scheduled",
		elements: elementCount,
		cap,
		observability: {
			graph: graphMetadata,
			persistence: persistenceMetadata,
		},
	});
	ensurePersistExitHook();

	const debounce = graphPersistDebounceMs();
	const existing = _persistTimers.get(key);
	if (existing) clearTimeout(existing);
	if (debounce === 0) {
		writePending(key);
		return persistReason;
	}
	const timer = setTimeout(() => writePending(key), debounce);
	// Don't keep the event loop alive solely for a cache write.
	if (typeof timer.unref === "function") timer.unref();
	_persistTimers.set(key, timer);
	return persistReason;
}

// --- Cross-session resumable full build (checkpointing, #936 limit 2) ---
// A full build walks + tree-sitter-parses every source file, then resolves
// cross-file edges once at the end. On a large repo with short-lived sessions
// that whole pass can be killed before it finishes and, with no checkpoint,
// the next session starts from scratch — so it may NEVER complete. During the
// full-build extraction loop we periodically snapshot the PRE-resolution graph
// plus the exact set of files already folded into it (with content hashes) to
// a dedicated checkpoint file. A later session resumes from that snapshot,
// re-walking only files that changed/appeared since, and finishes the build.
//
// Correctness (equivalence to a cold full build) rests on one property of the
// extraction: `addFileToGraph`'s per-file contribution (the nodes it adds and
// the edges it adds, with their metadata) depends ONLY on that file's content
// and the cwd — never on other files or on processing order, because ALL
// cross-file linking is deferred to `resolveDeferredSymbolEdges`, run once
// after every file is in. So the pre-resolution graph is the order-independent
// union of per-file contributions (shared placeholder / imported-file stub
// nodes are created idempotently by id). Resuming therefore reconstructs the
// identical pre-resolution graph as long as the reused files' contributions
// are still current — which the content-hash + ignored-id + git gates below
// enforce, failing open to a cold build on any doubt.

const GRAPH_CHECKPOINT_EVERY_FILES_DEFAULT = 250;
const GRAPH_CHECKPOINT_MIN_INTERVAL_MS_DEFAULT = 5_000;

function graphCheckpointEveryFiles(): number {
	const raw = Number(process.env.PI_LENS_GRAPH_CHECKPOINT_EVERY_FILES);
	return Number.isFinite(raw) && raw > 0
		? Math.floor(raw)
		: GRAPH_CHECKPOINT_EVERY_FILES_DEFAULT;
}

function graphCheckpointMinIntervalMs(): number {
	const raw = Number(process.env.PI_LENS_GRAPH_CHECKPOINT_MIN_INTERVAL_MS);
	return Number.isFinite(raw) && raw >= 0
		? raw
		: GRAPH_CHECKPOINT_MIN_INTERVAL_MS_DEFAULT;
}

interface ReviewGraphCheckpointData {
	version: string;
	builtAt: string;
	/**
	 * Honesty marker (#936): this payload is a MID-BUILD snapshot, never a
	 * complete graph. Only the resume path in `_doBuildGraph` ever reads it.
	 */
	inProgress: true;
	/** Total files this build is walking toward — telemetry only. */
	targetFileCount: number;
	/** Files whose per-file contribution is already in `nodes`/`edges`, keyed to
	 * the sha256 of the exact bytes extracted, so a later session can detect and
	 * re-walk any that changed since. */
	processedFiles: Array<[string, string]>;
	/** Fingerprint of the untracked-AND-ignored id set (#694) used during
	 * extraction. It steers import-edge target resolution, so a change would make
	 * reused files' edges stale — resume fails open to a cold build on mismatch. */
	ignoredIdsHash: string;
	/** PRE-resolution nodes (resolveDeferredSymbolEdges has NOT run). */
	nodes: Array<[string, ReviewGraphNode]>;
	/** PRE-resolution edges (cross-file `calls`/`references` still point at
	 * unresolved placeholder nodes). */
	edges: ReviewGraphEdge[];
	gitStamp?: { headCommit: string; worktreeRoot: string };
}

function reviewGraphCheckpointPath(cwd: string): string {
	return path.join(getProjectDataDir(cwd), "cache", GRAPH_CHECKPOINT_FILENAME);
}

/** Stable fingerprint of the untracked-ignored id set. `undefined` (fetch
 * degraded / not requested) hashes distinctly from an empty set, so a resume
 * only reuses a checkpoint built under the same ignore state. */
function hashIgnoredIds(ignoredIds: ReadonlySet<string> | undefined): string {
	if (ignoredIds === undefined) return "unavailable";
	const joined = [...ignoredIds]
		.sort((a, b) => a.localeCompare(b))
		.join("\u0000");
	return createHash("sha256").update(joined).digest("hex");
}

/** Assemble the checkpoint DTO from the current PRE-resolution graph. Isolated
 * so both the offloaded and synchronous writers serialize identical bytes. */
function buildReviewGraphCheckpointData(
	cwd: string,
	graph: ReviewGraph,
	processedHashes: Map<string, string>,
	targetFileCount: number,
	ignoredIds: ReadonlySet<string> | undefined,
): ReviewGraphCheckpointData {
	return {
		version: REVIEW_GRAPH_VERSION,
		builtAt: new Date().toISOString(),
		inProgress: true,
		targetFileCount,
		processedFiles: Array.from(processedHashes.entries()),
		ignoredIdsHash: hashIgnoredIds(ignoredIds),
		nodes: Array.from(graph.nodes.entries()),
		edges: graph.edges,
		gitStamp: resolveGitIdentity(cwd),
	};
}

/**
 * Write a mid-build checkpoint for `cwd`. Best-effort. `graph` MUST be
 * pre-resolution; `processedHashes` MUST contain exactly the files already
 * folded into it. The stringify+gzip is offloaded to the shared persist worker
 * (keeping the gzip of a growing graph off the event loop during a background
 * build), generation-gated so a slow write can't clobber a newer checkpoint or
 * resurrect one over a completed build; it falls back to a synchronous write
 * when the worker is unavailable. A lost checkpoint only costs a cold rebuild.
 */
function writeReviewGraphCheckpoint(
	cwd: string,
	graph: ReviewGraph,
	processedHashes: Map<string, string>,
	targetFileCount: number,
	ignoredIds: ReadonlySet<string> | undefined,
): void {
	const generation = (_checkpointGenerations.get(cwd) ?? 0) + 1;
	_checkpointGenerations.set(cwd, generation);
	let data: ReviewGraphCheckpointData;
	try {
		data = buildReviewGraphCheckpointData(
			cwd,
			graph,
			processedHashes,
			targetFileCount,
			ignoredIds,
		);
	} catch {
		return; // best-effort — building the DTO failed, skip this stride
	}
	const worker = _workerDisabled ? undefined : getPersistWorker();
	if (!worker) {
		writeReviewGraphCheckpointSync(cwd, data, {
			nodes: graph.nodes.size,
			edges: graph.edges.length,
			processed: processedHashes.size,
			target: targetFileCount,
		});
		return;
	}
	const checkpointPath = reviewGraphCheckpointPath(cwd);
	const cacheDir = path.dirname(checkpointPath);
	try {
		fs.mkdirSync(cacheDir, { recursive: true });
	} catch (err) {
		// Can't stage — skip this stride (best-effort), but surface it.
		logReviewGraph({
			cwd,
			phase: "checkpoint_write_failed",
			reason: "mkdir_failed",
			error: err instanceof Error ? err.message : String(err),
		});
		return;
	}
	sweepStaleStageFiles(cacheDir);
	ensurePersistExitHook();
	const id = ++_persistWorkerRequestId;
	const stagePath = `${checkpointPath}.stage-${process.pid}-${generation}`;
	_checkpointWorkerRequests.set(id, {
		cwd,
		generation,
		checkpointPath,
		stagePath,
		nodes: graph.nodes.size,
		edges: graph.edges.length,
		processed: processedHashes.size,
		target: targetFileCount,
	});
	const request: ReviewGraphPersistWorkerRequest = {
		id,
		cwd,
		generation,
		stagePath,
		data,
		elements: graph.nodes.size + graph.edges.length,
		testDelayMs:
			process.env.NODE_ENV === "test"
				? Number(process.env.PI_LENS_TEST_PERSIST_WORKER_DELAY_MS) || undefined
				: undefined,
	};
	worker.postMessage(request);
	_checkpointOffloadCountForTests++;
}

/** Synchronous checkpoint write — the worker-unavailable fallback and the
 * teardown/test-seam path where an async promotion couldn't land in time. */
function writeReviewGraphCheckpointSync(
	cwd: string,
	data: ReviewGraphCheckpointData,
	counts: { nodes: number; edges: number; processed: number; target: number },
): void {
	try {
		const gzip = gzipSync(JSON.stringify(data));
		fs.mkdirSync(path.dirname(reviewGraphCheckpointPath(cwd)), {
			recursive: true,
		});
		writeFileAtomic(reviewGraphCheckpointPath(cwd), gzip, { bestEffort: true });
		logReviewGraph({
			cwd,
			phase: "checkpoint_written",
			nodes: counts.nodes,
			edges: counts.edges,
			processed: counts.processed,
			target: counts.target,
		});
	} catch (err) {
		// Best-effort: a failed checkpoint just means no resume next session —
		// but surface it so a persistent write failure isn't invisible.
		logReviewGraph({
			cwd,
			phase: "checkpoint_write_failed",
			reason: "sync_write_failed",
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/** Remove the checkpoint once a complete authoritative graph exists (or when a
 * stale checkpoint is discarded). Best-effort. Bumps the checkpoint generation
 * first so any still-in-flight offloaded write for `cwd` is gated out and can
 * never re-create the file after this delete. */
function deleteReviewGraphCheckpoint(cwd: string): void {
	_checkpointGenerations.set(cwd, (_checkpointGenerations.get(cwd) ?? 0) + 1);
	fs.rm(reviewGraphCheckpointPath(cwd), { force: true }, () => {});
}

interface LoadedReviewGraphCheckpoint {
	/** Hydrated PRE-resolution graph, marked partial + inProgress. */
	graph: ReviewGraph;
	processedHashes: Map<string, string>;
	ignoredIdsHash: string;
	targetFileCount: number;
}

/**
 * Read back a checkpoint for `cwd`, gated on the graph version (single source of
 * truth: {@link REVIEW_GRAPH_VERSION}) and, when both stamps resolve, the git
 * WORKTREE identity — the same one-policy guard `loadPersistedGraph` uses, and
 * for the same reason (#1961): the resume path content-verifies every processed
 * file by hash below (`contentHashEntry` vs `processedHashes`) and evicts the
 * stale ones, so revision equality proves nothing the hashes do not already
 * prove. Dropping on a HEAD move threw away a whole resumable partial build
 * after each plain `git commit`. Returns null (and best-effort deletes an
 * unusable file) when absent/stale/corrupt.
 * The returned graph carries `persistCoverage.inProgress` so it can never be
 * mistaken for a complete graph if it escapes the resume path.
 */
function loadReviewGraphCheckpoint(
	cwd: string,
): LoadedReviewGraphCheckpoint | null {
	const checkpointPath = reviewGraphCheckpointPath(cwd);
	let data: ReviewGraphCheckpointData;
	try {
		if (!fs.existsSync(checkpointPath)) return null;
		data = JSON.parse(
			gunzipSync(fs.readFileSync(checkpointPath)).toString("utf-8"),
		) as ReviewGraphCheckpointData;
	} catch {
		// A checkpoint file was present but unreadable — the operator would
		// otherwise see a full cold rebuild with no hint the checkpoint existed.
		logReviewGraph({ cwd, phase: "checkpoint_discarded", reason: "corrupt" });
		deleteReviewGraphCheckpoint(cwd);
		return null;
	}
	if (data.version !== REVIEW_GRAPH_VERSION || data.inProgress !== true) {
		logReviewGraph({
			cwd,
			phase: "checkpoint_discarded",
			reason:
				data.version !== REVIEW_GRAPH_VERSION
					? "version_mismatch"
					: "not_in_progress",
		});
		deleteReviewGraphCheckpoint(cwd);
		return null;
	}
	if (data.gitStamp) {
		const current = resolveGitIdentity(cwd);
		if (current && current.worktreeRoot !== data.gitStamp.worktreeRoot) {
			logReviewGraph({
				cwd,
				phase: "checkpoint_discarded",
				reason: "worktree_mismatch",
			});
			deleteReviewGraphCheckpoint(cwd);
			return null;
		}
	}
	const totalNodes = data.nodes.length;
	const totalEdges = data.edges.length;
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
		persistCoverage: {
			partial: true,
			inProgress: true,
			cap: 0,
			totalNodes,
			totalEdges,
			persistedNodes: totalNodes,
			persistedEdges: totalEdges,
			totalFiles: data.targetFileCount,
			persistedFiles: 0,
		},
	};
	rebuildIndexes(graph);
	if (graph.persistCoverage) {
		graph.persistCoverage.persistedFiles = countRetainedSourceFiles(
			graph,
			data.processedFiles.map(([filePath]) => filePath),
		);
	}
	return {
		graph,
		processedHashes: new Map(data.processedFiles),
		ignoredIdsHash: data.ignoredIdsHash,
		targetFileCount: data.targetFileCount,
	};
}

/**
 * Drop nodes with no `filePath` (shared placeholder / imported-file-stub /
 * external / module nodes) that no edge references after a stale-file eviction.
 * A cold full build's pre-resolution graph never contains such zero-edge
 * placeholders (each is created immediately before an edge to it, and the full
 * path removes no edges), so pruning them makes a reconciled resume graph
 * node-for-node identical to a cold build BEFORE `resolveDeferredSymbolEdges`
 * runs. Must be called only on a pre-resolution graph.
 */
function pruneOrphanNonFileNodes(graph: ReviewGraph): void {
	const referenced = new Set<string>();
	for (const edge of graph.edges) {
		referenced.add(edge.from);
		referenced.add(edge.to);
	}
	for (const [id, node] of graph.nodes) {
		if (!node.filePath && !referenced.has(id)) graph.nodes.delete(id);
	}
}

interface ResumedBuild {
	graph: ReviewGraph;
	fileHashes: Map<string, string>;
	remaining: string[];
}

/**
 * Attempt to resume a full build for `cwd` from a prior session's checkpoint.
 * Returns a seed graph (the reconciled pre-resolution checkpoint), the content
 * hashes of the files it reuses, and the list of files still to extract; or
 * null when there is no usable checkpoint (caller does a cold full build).
 *
 * Reconciliation vs. the CURRENT target file set (`filesToBuild`):
 *  - A processed file no longer in the target set (deleted/renamed/now-excluded)
 *    can invalidate OTHER kept files' import edges, which this pass does not
 *    rebuild — so ANY such removal fails open to a cold build (correctness over
 *    reuse, per #936).
 *  - A processed file still present but whose content changed is evicted and
 *    re-walked (its contribution is self-contained; cross-file links re-resolve
 *    globally at the end).
 *  - The ignored-id fingerprint must match (import-edge resolution depends on
 *    it), else fail open.
 */
async function tryResumeFromCheckpoint(
	cwd: string,
	filesToBuild: string[],
	ignoredIds: ReadonlySet<string> | undefined,
): Promise<ResumedBuild | null> {
	const loaded = loadReviewGraphCheckpoint(cwd);
	if (!loaded) return null;
	if (loaded.ignoredIdsHash !== hashIgnoredIds(ignoredIds)) {
		logReviewGraph({
			cwd,
			phase: "checkpoint_discarded",
			reason: "ignored_ids_mismatch",
			processed: loaded.processedHashes.size,
			target: filesToBuild.length,
		});
		deleteReviewGraphCheckpoint(cwd);
		return null;
	}
	const targetSet = new Set(filesToBuild);
	// Removed-file guard: a processed file gone from the target set can leave a
	// kept importer's edges stale — fail open rather than serve a wrong graph.
	for (const file of loaded.processedHashes.keys()) {
		if (!targetSet.has(file)) {
			logReviewGraph({
				cwd,
				phase: "checkpoint_discarded",
				reason: "removed_file",
				processed: loaded.processedHashes.size,
				target: filesToBuild.length,
			});
			deleteReviewGraphCheckpoint(cwd);
			return null;
		}
	}
	// Detect content changes among processed files (chunked stat/hash sweep).
	const reusableHashes = new Map<string, string>();
	const stale: string[] = [];
	let sinceYield = 0;
	for (const [file, priorHash] of loaded.processedHashes) {
		const currentHash = contentHashEntry(file);
		if (currentHash === priorHash) reusableHashes.set(file, currentHash);
		else stale.push(file);
		if (++sinceYield >= STAT_YIELD_EVERY) {
			sinceYield = 0;
			await yieldToLoop();
		}
	}
	if (reusableHashes.size === 0) {
		// Nothing survivable — no benefit over a cold build; discard.
		logReviewGraph({
			cwd,
			phase: "checkpoint_discarded",
			reason: "all_stale",
			stale: stale.length,
			target: filesToBuild.length,
		});
		deleteReviewGraphCheckpoint(cwd);
		return null;
	}
	const graph = loaded.graph;
	// Evict every stale (content-changed) processed file so its outdated
	// contribution is replaced by a fresh walk below.
	for (const file of stale) removeFileOwnedGraphData(graph, file);
	pruneOrphanNonFileNodes(graph);
	graph.changedSymbolsByFile = new Map();
	const remaining = filesToBuild.filter((file) => !reusableHashes.has(file));
	logReviewGraph({
		cwd,
		phase: "checkpoint_resumed",
		reused: reusableHashes.size,
		stale: stale.length,
		remaining: remaining.length,
		target: filesToBuild.length,
	});
	return { graph, fileHashes: reusableHashes, remaining };
}

/** Test-only: inspect the on-disk resume checkpoint for `cwd` (raw payload),
 * or null when none is present. Lets tests assert the honesty marker and the
 * recorded processed-file set without exporting the whole checkpoint machinery. */
export function _readReviewGraphCheckpointForTests(cwd: string): {
	inProgress: boolean;
	processedFiles: string[];
	nodeCount: number;
	edgeCount: number;
	persistCoverage: ReviewGraphPersistCoverage | undefined;
} | null {
	const loaded = loadReviewGraphCheckpoint(cwd);
	if (!loaded) return null;
	return {
		inProgress: loaded.graph.persistCoverage?.inProgress === true,
		processedFiles: [...loaded.processedHashes.keys()],
		nodeCount: loaded.graph.nodes.size,
		edgeCount: loaded.graph.edges.length,
		persistCoverage: loaded.graph.persistCoverage,
	};
}

/** Test hook: force any pending debounced persist to write immediately. */
export function flushReviewGraphPersistsForTests(): void {
	for (const key of [..._pendingPersist.keys()]) {
		const pending = _pendingPersist.get(key);
		if (!pending) continue;
		_pendingPersist.delete(key);
		const timer = _persistTimers.get(key);
		if (timer) clearTimeout(timer);
		_persistTimers.delete(key);
		writePendingOnMainThread(key, pending);
	}
}

/** Test-only: wait until worker requests (authoritative persist AND offloaded
 * checkpoint) have either landed or degraded. */
export async function waitForReviewGraphPersistsForTests(): Promise<void> {
	for (
		let attempts = 0;
		attempts < 200 &&
		(_workerRequests.size > 0 || _checkpointWorkerRequests.size > 0);
		attempts++
	) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Test-only: exercise the degraded worker-death path. */
export async function terminateReviewGraphPersistWorkerForTests(): Promise<void> {
	const worker = _persistWorker;
	if (worker) await worker.terminate();
}

/** Test-only: restore worker creation after a deliberate death. */
export function resetReviewGraphPersistWorkerForTests(): void {
	_workerDisabled = false;
	_persistWorker = undefined;
	_persistWorkerUnavailableReason = undefined;
	_lastWorkerFallbackReasonForTests = undefined;
	_checkpointWorkerRequests.clear();
	_checkpointGenerations.clear();
	_checkpointOffloadCountForTests = 0;
}

/** Test-only: count of checkpoint writes that took the offloaded worker path. */
export function getCheckpointOffloadCountForTests(): number {
	return _checkpointOffloadCountForTests;
}

export function getReviewGraphWorkerFallbackReasonForTests():
	| string
	| undefined {
	return _lastWorkerFallbackReasonForTests;
}

export interface ReviewGraphPersistFlushResult {
	ok: boolean;
	path?: string;
	bytes?: number;
	elements?: number;
	reason?: string;
	/** Honest total-vs-persisted counts when the cap forced a partial snapshot
	 * (#936 limit 3) — standalone callers must surface this, not just "ok". */
	coverage?: ReviewGraphPersistCoverage;
}

/**
 * Force and verify one workspace's queued graph snapshot before a standalone
 * process exits. This is the out-of-band counterpart to the teardown hook:
 * it consumes the same persist payload and uses the same atomic writer.
 */
/** On-disk snapshot path for a workspace — for standalone tools that must
 * distinguish "snapshot already current" from "persist never happened". */
export function reviewGraphCachePath(cwd: string): string {
	return path.join(getProjectDataDir(cwd), "cache", GRAPH_CACHE_FILENAME);
}

export function flushReviewGraphPersist(
	cwd: string,
	source: "cli" | "exit_hook" = "cli",
): ReviewGraphPersistFlushResult {
	const key = normalizeMapKey(cwd);
	// #950 review F2: pick the NEWEST generation across the debounced pending
	// entry AND every in-flight worker request, and remove ALL of them — the
	// old first-match scan could force-write a stale generation and then let
	// a newer in-flight worker result pass the (reset) generation gate after
	// the flush. Removed requests' late results hit the no-request branch in
	// handleWorkerResult, which deletes their stage files.
	let pending = _pendingPersist.get(key);
	const removedWorkerRequests: PendingPersist[] = [];
	let selectedWorkerRequest: PendingPersist | undefined;
	for (const [id, request] of [..._workerRequests]) {
		if (request.key !== key) continue;
		_workerRequests.delete(id);
		removedWorkerRequests.push(request.pending);
		if (!pending || request.pending.generation > pending.generation) {
			pending = request.pending;
			selectedWorkerRequest = request.pending;
		}
	}
	for (const removed of removedWorkerRequests) {
		if (!pending || removed.generation === pending.generation) continue;
		logReviewGraph({
			cwd: key,
			phase: "persist_skipped",
			reason: "superseded",
			observability: persistObservability(removed, {
				status: "superseded",
				supersededByGeneration: pending.generation,
				reason: "forced_flush_newest_generation",
				workerStarted: true,
				workerCompleted: false,
			}),
		});
	}
	if (!pending) {
		return {
			ok: false,
			reason: "no graph snapshot was queued for persistence",
		};
	}
	// Invalidate every staged worker completion before doing the forced write.
	// Workers never promote their own stage file, so a late result can only be
	// discarded by handleWorkerResult and cannot overwrite this snapshot.
	_persistGenerations.set(
		key,
		Math.max(_persistGenerations.get(key) ?? 0, pending.generation) + 1,
	);
	_pendingPersist.delete(key);
	const timer = _persistTimers.get(key);
	if (timer) {
		clearTimeout(timer);
		_persistTimers.delete(key);
	}

	const startedAt = performance.now();
	try {
		const serializeStarted = performance.now();
		const json = JSON.stringify(persistedData(pending));
		const serializeMs = performance.now() - serializeStarted;
		const rawBytes = Buffer.byteLength(json);
		const writeStarted = performance.now();
		const gzip = gzipSync(json);
		fs.mkdirSync(pending.cacheDir, { recursive: true });
		writeFileAtomic(pending.cachePath, gzip, { bestEffort: false });
		fs.rmSync(path.join(pending.cacheDir, LEGACY_GRAPH_CACHE_FILENAME), {
			force: true,
		});
		const writeMs = performance.now() - writeStarted;
		logLatency({
			type: "phase",
			phase: "review_graph_persist",
			filePath: pending.cachePath,
			durationMs: performance.now() - startedAt,
			metadata: {
				elements: pending.elementCount,
				rawBytes,
				gzBytes: gzip.byteLength,
				serializeMs,
				writeMs,
				offloaded: false,
			},
		});
		logReviewGraph({
			cwd,
			phase: "persist_succeeded",
			elements: pending.elementCount,
			rawBytes,
			gzBytes: gzip.byteLength,
			serializeMs,
			writeMs,
			offloaded: false,
			observability: persistObservability(pending, {
				status: "succeeded",
				reason: source === "exit_hook" ? "exit_flush" : "forced_flush",
				workerStarted: selectedWorkerRequest !== undefined,
				workerCompleted: false,
			}),
		});
		return {
			ok: true,
			path: pending.cachePath,
			bytes: gzip.byteLength,
			elements: pending.elementCount,
			coverage: pending.graph.persistCoverage,
		};
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		recordPersistFailure(
			cwd,
			source === "exit_hook" ? "exit_flush_failed" : "forced_flush_failed",
			reason,
			pending,
			selectedWorkerRequest
				? {
						started: true,
						completed: false,
						fallbackReason: "forced_flush_write_failed",
					}
				: undefined,
		);
		return { ok: false, reason };
	}
}

/**
 * Resolve a relative ESM import to an in-project file — the warm jsts
 * counterpart to import-resolvers.ts's `resolveJsTs` (the cold module_report
 * path). Both share `jsTsCandidatePaths`'s SOURCE-TWIN-PREFERRING candidate
 * order (#694: try `.ts`/`.tsx`/`.mts`/`.cts` before the literal/compiled
 * extension) so a repo that compiles in place never diverges on which of the
 * two an import edge lands on.
 *
 * `ignoredIds` (#694): when the first existing candidate is untracked-AND-
 * gitignored (a build artifact with no surviving source twin — see
 * git-tracked-ignore.ts), it is skipped rather than returned, so the ignore
 * invariant (#243) reaches import-resolution-created nodes too, not just the
 * initial file walk. Undefined ⇒ no filtering (the fetch degraded or wasn't
 * requested).
 *
 * A bare specifier (`react`, `@scope/pkg[/subpath]`) is resolved against
 * known workspace package names (#775) via `resolveWorkspacePackageImport` —
 * the same resolver the cold module_report path (`resolveJsTs`) uses — before
 * falling back to `undefined` (external dep, unchanged behavior).
 */
function localImportToFile(
	cwd: string,
	filePath: string,
	source: string,
	ignoredIds?: ReadonlySet<string>,
): string | undefined {
	if (!source.startsWith(".")) {
		const aliased = resolveAliasedImport(cwd, source, path.dirname(filePath));
		const referenced = aliased.length
			? []
			: resolveProjectReferenceImport(cwd, source, path.dirname(filePath));
		const resolved = aliased.length
			? aliased
			: referenced.length
				? referenced
				: resolveWorkspacePackageImport(cwd, source);
		for (const normalized of resolved) {
			if (ignoredIds?.has(normalized)) continue;
			return normalized;
		}
		return undefined;
	}
	const root = path.resolve(cwd);
	for (const candidate of jsTsCandidatePaths(filePath, source)) {
		const relative = path.relative(root, candidate);
		if (
			(relative.startsWith("..") &&
				(relative.length === 2 || relative.startsWith(`..${path.sep}`))) ||
			path.isAbsolute(relative) ||
			!fs.existsSync(candidate)
		)
			continue;
		const normalized = normalizeMapKey(candidate);
		if (ignoredIds?.has(normalized)) continue;
		return normalized;
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
	contentOverride?: string | null,
): Promise<void> {
	const ctx = makeCtx(filePath, cwd, facts);
	if (contentOverride === undefined) {
		await fileContentProvider.run(ctx, facts);
	} else {
		facts.setFileFact(filePath, "file.content", contentOverride);
	}
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
		// pi-lens-ignore: missing-error-propagation
	} catch (err) {
		logReviewGraph({
			cwd,
			phase: "build_skipped",
			reason: "structural_facts_disabled",
			error: (err as Error)?.message ?? String(err),
		});
	}
}

function addJsTsFile(
	graph: ReviewGraph,
	cwd: string,
	filePath: string,
	facts: FactStore,
	ignoredIds?: ReadonlySet<string>,
): void {
	const normalized = normalizeMapKey(filePath);
	const hintPath = toProjectRelativePath(normalized, cwd);
	const content = facts.getFileFact<string>(normalized, "file.content") ?? "";
	const fileNodeId = `file:${normalized}`;
	// The function-facts provider uses the shared tree-sitter integration for
	// both TypeScript and JavaScript-family grammars. Do not suppress JS call
	// evidence merely because import resolution may canonicalize a compiled twin
	// onto its source; the graph must describe every supported source file, and
	// lens-map performs the separate presentation-level twin merge.
	const warmCallCoverage =
		facts.getFileFact<string>(normalized, "file.functionFactsCoverage") ??
		"unavailable";
	const importCoverage =
		facts.getFileFact<string>(normalized, "file.importFactsCoverage") ??
		"unavailable";
	addNode(graph, {
		id: fileNodeId,
		kind: "file",
		language: "jsts",
		filePath: normalized,
		metadata: {
			lineCount: content.split("\n").length,
			extractionCoverage: {
				definitions: warmCallCoverage,
				references: warmCallCoverage,
				imports: importCoverage,
				calls: warmCallCoverage,
			},
			...featureHintMetadata(hintPath),
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
		const localFile = localImportToFile(
			cwd,
			normalized,
			entry.source,
			ignoredIds,
		);
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

	// refs #655 phase 2 ("import" resolution tier): a bare-name callee that
	// matches a named/default import specifier hints exactly which in-project
	// FILE it should resolve against, narrowing resolveDeferredSymbolEdges'
	// candidate search below (before it falls back to the graph-wide
	// uniqueness check). Only local (in-project) import sources produce a
	// hint — third-party/stdlib imports have no graph file to narrow to.
	const importedNameToFile = new Map<string, string>();
	for (const entry of imports) {
		const localFile = localImportToFile(
			cwd,
			normalized,
			entry.source,
			ignoredIds,
		);
		if (!localFile) continue;
		for (const name of entry.names) importedNameToFile.set(name, localFile);
		if (entry.defaultName) importedNameToFile.set(entry.defaultName, localFile);
	}

	// refs #655 phase 2 (qualified names + "receiver-type" resolution): build
	// the per-file `Owner.method -> symbolId[]` map alongside each node so the
	// second pass below (call-site resolution) can look up SAME-FILE receiver
	// types without a second traversal. Collecting ALL matches (not just the
	// last-written one) lets the resolver below tell "exactly one real target"
	// apart from "this owner+name pair is itself ambiguous" (duplicate/overload
	// declarations sharing one qualified name) — the latter must stay
	// "name-only", never guess one of the 2+ candidates.
	const methodsByQualifiedName = new Map<string, string[]>();
	for (const fn of functions) {
		const symbolId = buildSymbolId(normalized, fn.name, "function", fn.line);
		const qualifiedName = buildQualifiedName(fn.owner, fn.name);
		if (qualifiedName) {
			const existing = methodsByQualifiedName.get(qualifiedName) ?? [];
			existing.push(symbolId);
			methodsByQualifiedName.set(qualifiedName, existing);
		}
		addNode(graph, {
			id: symbolId,
			kind: "symbol",
			language: "jsts",
			filePath: normalized,
			symbolName: fn.name,
			symbolKind: "function",
			...(qualifiedName ? { qualifiedName } : {}),
			exported: new RegExp(
				String.raw`export\s+(?:async\s+)?(?:function|const|let|var)\s+${escapeRegExp(fn.name)}\b`,
			).test(content),
			metadata: {
				line: fn.line,
				endLine: fn.endLine,
				column: fn.column,
				cyclomaticComplexity: fn.cyclomaticComplexity,
				maxNestingDepth: fn.maxNestingDepth,
				isBoundaryWrapper: fn.isBoundaryWrapper,
				isPassThroughWrapper: fn.isPassThroughWrapper,
				...featureHintMetadata(`${fn.name} ${hintPath}`),
			},
		});
		addEdge(graph, { from: fileNodeId, to: symbolId, kind: "contains" });
		addEdge(graph, { from: fileNodeId, to: symbolId, kind: "defines" });
	}

	for (const fn of functions) {
		const symbolId = buildSymbolId(normalized, fn.name, "function", fn.line);
		// Member call sites (`obj.method()`) with a same-file, structurally
		// determinable receiver type resolve directly here — refs #655 phase 2
		// "receiver-type" tier. Skip their text form in the outgoingCalls loop
		// below (memberCallText) so the same call site doesn't double-edge.
		const memberCallTexts = new Set<string>();
		for (const site of fn.memberCallSites ?? []) {
			const callText = `${site.receiver}.${site.method}`;
			memberCallTexts.add(callText);
			const receiverClass = fn.receiverTypes?.[site.receiver];
			const candidates = receiverClass
				? (methodsByQualifiedName.get(`${receiverClass}.${site.method}`) ?? [])
				: [];
			if (candidates.length === 1) {
				addEdge(graph, {
					from: symbolId,
					to: candidates[0],
					kind: "calls",
					metadata: {
						unresolvedName: callText,
						receiver: site.receiver,
						receiverType: receiverClass,
					},
					resolution: "receiver-type",
				});
				continue;
			}
			if (candidates.length > 1) {
				// The receiver's class is known, but that class has 2+ same-named
				// methods (duplicate/overload declarations) — the owner+name pair
				// itself is ambiguous. Point at a qualified-name placeholder (not the
				// bare-name one, which would incorrectly conflate this with unrelated
				// same-named methods elsewhere) and stay "name-only": never guess
				// which of the 2+ candidates this call reaches.
				const qualifiedPlaceholderId = `symbol-qualified-name:${receiverClass}.${site.method}`;
				if (!graph.nodes.has(qualifiedPlaceholderId)) {
					addNode(graph, {
						id: qualifiedPlaceholderId,
						kind: "symbol",
						language: "jsts",
						symbolName: site.method,
						qualifiedName: `${receiverClass}.${site.method}`,
						metadata: {
							unresolvedName: callText,
							ambiguousCandidates: candidates.length,
						},
					});
				}
				addEdge(graph, {
					from: symbolId,
					to: qualifiedPlaceholderId,
					kind: "calls",
					metadata: {
						unresolvedName: callText,
						receiver: site.receiver,
						receiverType: receiverClass,
					},
					resolution: "name-only",
				});
				continue;
			}
			// Receiver type unknown — falls back to the same "definite external"
			// placeholder the pre-#655 code used for every dotted call;
			// conservative (never claims a resolution tier it can't back up).
			const externalId = `external:${callText}`;
			if (!graph.nodes.has(externalId)) {
				addNode(graph, {
					id: externalId,
					kind: "external",
					language: "jsts",
					metadata: { unresolvedName: callText },
				});
			}
			addEdge(graph, {
				from: symbolId,
				to: externalId,
				kind: "calls",
				metadata: { unresolvedName: callText },
			});
		}

		for (const callee of fn.outgoingCalls) {
			if (memberCallTexts.has(callee)) continue;
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
			const importHintFile = !callee.includes(".")
				? importedNameToFile.get(callee)
				: undefined;
			addEdge(graph, {
				from: symbolId,
				to: targetId,
				kind: "calls",
				metadata: {
					unresolvedName: callee,
					...(importHintFile ? { importHintFile } : {}),
				},
				// A definite external call (`callee.includes(".")`) is never
				// ambiguous — no in-project candidate to collide with, so no
				// resolution marker. An in-project bare-name callee starts
				// "name-only" and resolveDeferredSymbolEdges below may upgrade it
				// to "import" (when importHintFile narrows it) or "exact" once
				// every file has been added.
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
		case "python":
			return "python";
		case "go":
			return "go";
		case "rust":
			return "rust";
		case "ruby":
			return "ruby";
		case "cxx": {
			const ext = filePath ? path.extname(filePath).toLowerCase() : "";
			return ext === ".c" || ext === ".h" ? "c" : "cpp";
		}
		case "java":
			return "java";
		case "kotlin":
			return "kotlin";
		case "dart":
			return "dart";
		case "elixir":
			return "elixir";
		case "csharp":
			return "csharp";
		case "php":
			return "php";
		case "swift":
			return "swift";
		case "lua":
			return "lua";
		case "ocaml":
			return "ocaml";
		case "zig":
			return "zig";
		case "shell":
			return "bash";
		default:
			return undefined;
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
	if (!ok) {
		// Memoize failures too (#955 review): the scan loop probes the
		// extractor once per file, and an unmemoized grammar-load failure
		// re-attempted resolution (possibly a lazy fetch) for every file of
		// that language. A restart re-probes; within a process, one verdict.
		extractorCache.set(languageId, null);
		return null;
	}
	extractorCache.set(languageId, extractor);
	return extractor;
}

async function extractTreeSitterSymbols(
	filePath: string,
	languageId: string,
	contentOverride?: string | null,
): Promise<ExtractedSymbols> {
	const empty: ExtractedSymbols = {
		symbols: [],
		refs: [],
		imports: [],
		coverage: {
			definitions: "unavailable",
			references: "unavailable",
			imports: "unavailable",
		},
	};
	if (contentOverride === null) return empty;
	const treeSitterClient = getSharedTreeSitterClient();
	if (!treeSitterClient) return empty;
	const initialized = await treeSitterClient.init();
	if (!initialized) return empty;
	const extractor = await getExtractor(languageId);
	if (!extractor) return empty;
	const content = contentOverride ?? fs.readFileSync(filePath, "utf-8");
	const extracted = await treeSitterClient.withParsedTree(
		filePath,
		languageId,
		content,
		(tree) => extractor.extract(tree, filePath, content),
	);
	return extracted.parsed ? extracted.value : empty;
}

/**
 * Extract the compact graph-facing facts while the scanner's parse is still
 * hot. The caller publishes the result only after every consumer of that file
 * has completed, so cancellation can never expose an in-progress entry.
 */
export async function captureReviewGraphStructuralIr(
	filePath: string,
	cwd: string,
	content: string,
	facts: FactStore,
): Promise<{ complete: boolean; structural?: ReviewGraphStructuralIr }> {
	const kind = detectFileKind(filePath);
	if (!kind || !MAIN_KINDS.has(kind) || detectFileRole(filePath) === "test") {
		return { complete: true };
	}
	if (kind === "jsts") {
		if (
			!facts.hasFileFact(filePath, "file.imports") ||
			!facts.hasFileFact(filePath, "file.reexports") ||
			!facts.hasFileFact(filePath, "file.functionSummaries")
		) {
			await ensureReviewGraphFacts(filePath, cwd, facts, content);
		}
		const parsed = await withTreeSitterRoot(filePath, content, () => true);
		if (!parsed.parsed) return { complete: false };
		const functionCoverage: ReviewGraphExtractionStatus =
			(facts.getFileFact<string>(filePath, "file.functionFactsCoverage") as
				| ReviewGraphExtractionStatus
				| undefined) ?? "unavailable";
		const importCoverage: ReviewGraphExtractionStatus =
			(facts.getFileFact<string>(filePath, "file.importFactsCoverage") as
				| ReviewGraphExtractionStatus
				| undefined) ?? "unavailable";
		const coverage = {
			definitions: functionCoverage,
			references: functionCoverage,
			imports: importCoverage,
			calls: functionCoverage,
		} as const;
		if (Object.values(coverage).some((status) => status !== "complete")) {
			return { complete: false };
		}
		return {
			complete: true,
			structural: {
				kind: "jsts",
				imports:
					facts.getFileFact<ImportEntry[]>(filePath, "file.imports") ?? [],
				reexports:
					facts.getFileFact<ReExportEntry[]>(filePath, "file.reexports") ?? [],
				functionSummaries:
					facts.getFileFact<FunctionSummary[]>(
						filePath,
						"file.functionSummaries",
					) ?? [],
				coverage,
			},
		};
	}
	const languageId = mapKindToTreeSitterLanguage(kind, filePath);
	// A graph-relevant kind without a tree-sitter mapping is unsupported, not
	// an empty successful extraction. Do not publish a complete IR for it.
	if (!languageId) return { complete: false };
	const client = getSharedTreeSitterClient();
	if (!client || !(await client.init())) return { complete: false };
	const extractor = await getExtractor(languageId);
	if (!extractor) return { complete: false };
	const result = await client.withParsedTree(
		filePath,
		languageId,
		content,
		(tree) => extractor.extract(tree, filePath, content),
	);
	if (!result.parsed) return { complete: false };
	return {
		complete: true,
		structural: {
			kind: "tree-sitter",
			languageId,
			extracted: result.value,
		},
	};
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
		const key = `${symbol.name}0000${symbol.line}0000${symbol.column}`;
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
	ignoredIds?: ReadonlySet<string>,
): void {
	const normalized = normalizeMapKey(filePath);
	const hintPath = toProjectRelativePath(normalized, cwd);
	const fileNodeId = `file:${normalized}`;
	addNode(graph, {
		id: fileNodeId,
		kind: "file",
		language: languageId,
		filePath: normalized,
		metadata: {
			...featureHintMetadata(hintPath),
			extractionCoverage: extracted.coverage,
		},
	});

	const dedupedSymbols = dedupeSamePositionSymbols(extracted.symbols);
	// refs #655 phase 2: qualified (owner-chain) display name, computed via the
	// SAME strict-containment/smallest-span algorithm module-report.ts's outline
	// nesting (`nestEntries`, #301) uses over its own tree-sitter-symbol-extractor
	// output — see symbol-containment.ts. Candidates are the file's OWN deduped
	// symbol list; a symbol with no strictly-containing entry (top-level) gets
	// no qualifiedName.
	const containers = dedupedSymbols.map((s) => ({
		name: s.name,
		startLine: s.line,
		endLine: s.endLine ?? s.line,
	}));

	for (const symbol of dedupedSymbols) {
		const symbolId = buildSymbolId(
			normalized,
			symbol.name,
			symbol.kind,
			symbol.line,
		);
		const owner = findOwnerName(
			containers,
			symbol.line,
			symbol.endLine ?? symbol.line,
		);
		const qualifiedName = buildQualifiedName(owner, symbol.name);
		addNode(graph, {
			id: symbolId,
			kind: "symbol",
			language: languageId,
			filePath: normalized,
			symbolName: symbol.name,
			symbolKind: symbol.kind,
			...(qualifiedName ? { qualifiedName } : {}),
			exported: symbol.isExported,
			metadata: {
				line: symbol.line,
				endLine: symbol.endLine,
				column: symbol.column,
				signature: symbol.signature,
				...featureHintMetadata(`${symbol.name} ${hintPath}`),
			},
		});
		addEdge(graph, { from: fileNodeId, to: symbolId, kind: "contains" });
		addEdge(graph, { from: fileNodeId, to: symbolId, kind: "defines" });
	}

	for (const ref of extracted.refs) {
		const refName = ref.symbolName ?? ref.symbolId;
		const targetId = `symbol-name:${refName}`;
		if (!graph.nodes.has(targetId)) {
			addNode(graph, {
				id: targetId,
				kind: "symbol",
				language: languageId,
				symbolName: refName,
				metadata: { unresolvedName: refName },
			});
		}
		addEdge(graph, {
			from: fileNodeId,
			to: targetId,
			kind: "references",
			metadata: {
				line: ref.line,
				column: ref.column,
				referenceKind: ref.referenceKind ?? "unknown",
			},
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
		// #694: drop any resolved target that's untracked-AND-gitignored (a build
		// artifact with no surviving source twin) BEFORE deciding resolved vs
		// unresolved — a fully-filtered-out result falls through to the same
		// unresolved module/external placeholder below, never a fabricated
		// ignored-file node.
		const resolved = resolveImportToFiles(
			cwd,
			filePath,
			languageId,
			imp.source,
		).filter((target) => !ignoredIds?.has(target));
		if (resolved.length > 0) {
			for (const target of resolved) {
				const toNode = ensureFileNode(
					graph,
					target,
					cwd,
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

/**
 * Add documentSymbol results only after tree-sitter produced no declarations.
 * Hierarchical responses preserve their parent/child containment. Flat
 * SymbolInformation results (including native TypeScript 7) recover the same
 * containment through `containerName` when the owner is present in the result.
 */
export function addLspFallbackSymbols(
	graph: ReviewGraph,
	filePath: string,
	languageId: string,
	symbols: LSPSymbol[],
): number {
	const normalized = normalizeMapKey(filePath);
	const fileNodeId = `file:${normalized}`;
	let added = 0;
	const flatOwnerIds = new Map<string, string>();
	for (const symbol of symbols) {
		const range = symbol.range ?? symbol.location?.range;
		if (!range) continue;
		const kind = lspSymbolKindName(symbol.kind);
		const id = buildSymbolId(
			normalized,
			symbol.name,
			kind,
			range.start.line + 1,
		);
		flatOwnerIds.set(symbol.name, id);
		if (symbol.containerName) {
			flatOwnerIds.set(`${symbol.containerName}.${symbol.name}`, id);
		}
	}
	const visit = (
		items: LSPSymbol[],
		parentId: string,
		ancestry: string[],
	): void => {
		for (const symbol of items) {
			const range = symbol.range ?? symbol.location?.range;
			if (!range) continue;
			const line = range.start.line + 1;
			const kind = lspSymbolKindName(symbol.kind);
			const symbolId = buildSymbolId(normalized, symbol.name, kind, line);
			// Shared with the read-path enrichment (#951 Sonar dedup): flat
			// results qualify through the full containerName chain, not just
			// the immediate owner.
			const owners =
				ancestry.length > 0 ? ancestry : containerNameChain(symbol, symbols);
			const qualifiedName =
				owners.length > 0 ? [...owners, symbol.name].join(".") : undefined;
			addNode(graph, {
				id: symbolId,
				kind: "symbol",
				language: languageId,
				filePath: normalized,
				symbolName: symbol.name,
				symbolKind: kind,
				...(qualifiedName ? { qualifiedName } : {}),
				provenance: "lsp",
				metadata: {
					line,
					column: range.start.character,
					endLine: range.end.line + 1,
					...featureHintMetadata(`${symbol.name} ${normalized}`),
				},
			});
			const resolvedParentId =
				ancestry.length === 0 && symbol.containerName
					? (flatOwnerIds.get(symbol.containerName) ?? parentId)
					: parentId;
			addEdge(graph, {
				from: resolvedParentId,
				to: symbolId,
				kind: "contains",
			});
			addEdge(graph, { from: fileNodeId, to: symbolId, kind: "defines" });
			added++;
			if (symbol.children) {
				visit(symbol.children, symbolId, [...owners, symbol.name]);
			}
		}
	};
	visit(symbols, fileNodeId, []);
	return added;
}

function ensureFileNode(
	graph: ReviewGraph,
	filePath: string,
	cwd: string,
	languageId: string,
): string {
	const normalized = normalizeMapKey(filePath);
	const hintPath = toProjectRelativePath(normalized, cwd);
	const existing = graph.fileNodes.get(normalized);
	if (existing) return existing;
	const fileNodeId = `file:${normalized}`;
	addNode(graph, {
		id: fileNodeId,
		kind: "file",
		language: languageId,
		filePath: normalized,
		metadata: featureHintMetadata(hintPath),
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
	ignoredIds?: ReadonlySet<string>,
	contentOverride?: string | null,
): void {
	let content = contentOverride;
	if (content === undefined) {
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			return;
		}
	}
	if (content === null) return;
	const fromNode = ensureFileNode(graph, filePath, cwd, "cpp");
	for (const line of content.split(/\r?\n/)) {
		const source = parseLocalCxxInclude(line);
		if (!source) continue;
		const target = resolveCxxInclude(cwd, filePath, source);
		// #694: same ignore-gate as the tree-sitter import loop above — an
		// untracked-AND-gitignored include target never becomes a node.
		if (!target || ignoredIds?.has(target)) continue;
		const languageId = mapKindToTreeSitterLanguage("cxx", target) ?? "cpp";
		const toNode = ensureFileNode(graph, target, cwd, languageId);
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
	return preservedIncomingSymbolEdges;
}

async function addFileToGraph(
	graph: ReviewGraph,
	cwd: string,
	file: string,
	facts: FactStore,
	ignoredIds?: ReadonlySet<string>,
	contentOverride?: string | null,
): Promise<void> {
	const kind = detectFileKind(file);
	if (!kind || !MAIN_KINDS.has(kind)) return;
	// #260: tests aren't graph-relevant — guard the per-file chokepoint too so
	// the incremental/cascade path (a changed *.test.ts) never adds them either.
	if (detectFileRole(file) === "test") return;
	const contentHash =
		typeof contentOverride === "string"
			? reviewGraphIrContentHash(contentOverride)
			: undefined;
	const sharedIr = contentHash
		? getFreshReviewGraphFileIr(cwd, file, contentHash)?.structural
		: undefined;
	if (kind === "jsts") {
		// Release content ONLY when this builder seeded it. The incremental
		// per-edit path receives the LIVE dispatch FactStore (via the
		// fire-and-forget blast-radius build), and the dispatch still reads
		// file.content after its runner groups settle — inline suppressions,
		// dispositions, and fact rules would race a delete and silently see
		// undefined. Content the dispatch put there is the dispatch's to free.
		const dispatchOwnsContent =
			facts.getFileFact<string>(file, "file.content") !== undefined &&
			contentOverride == null;
		try {
			if (sharedIr?.kind === "jsts") {
				facts.setFileFact(file, "file.content", contentOverride ?? "");
				facts.setFileFact(file, "file.imports", sharedIr.imports);
				facts.setFileFact(file, "file.reexports", sharedIr.reexports);
				facts.setFileFact(
					file,
					"file.functionSummaries",
					sharedIr.functionSummaries,
				);
				facts.setFileFact(
					file,
					"file.functionFactsCoverage",
					sharedIr.coverage.calls,
				);
				facts.setFileFact(
					file,
					"file.importFactsCoverage",
					sharedIr.coverage.imports,
				);
			} else {
				await ensureReviewGraphFacts(file, cwd, facts, contentOverride);
			}
			addJsTsFile(graph, cwd, file, facts, ignoredIds);
		} finally {
			// The graph has copied every durable value it needs. Keep derived facts
			// available to callers, but do not retain full source in a shared store.
			if (!dispatchOwnsContent) facts.deleteFileFact(file, "file.content");
		}
		return;
	}
	const languageId = mapKindToTreeSitterLanguage(kind, file);
	if (!languageId) return;
	const irExtracted =
		sharedIr?.kind === "tree-sitter" && sharedIr.languageId === languageId
			? sharedIr.extracted
			: undefined;
	const extracted =
		irExtracted ??
		(await extractTreeSitterSymbols(file, languageId, contentOverride));
	addTreeSitterFile(graph, cwd, file, languageId, extracted, ignoredIds);
	// Zero symbols consults the warm/open LSP fallback REGARDLESS of whether
	// the symbols came from shared IR or direct extraction (#955 review): a
	// degraded extractor (defs query failed to compile — init() deliberately
	// succeeds, the documented kotlin case) yields parsed-true/empty, and
	// treating that as authoritative would silently lose a whole language's
	// symbols whenever a scan preceded the build. For genuinely empty files
	// the fallback is a no-op unless the file is open in a warm client.
	if (extracted.symbols.length === 0) {
		const lspSymbols = await getOpenDocumentSymbols(file);
		const added = lspSymbols
			? addLspFallbackSymbols(graph, file, languageId, lspSymbols)
			: 0;
		logReviewGraph({
			phase: "lsp_symbol_fallback",
			cwd,
			reason: lspSymbols
				? added > 0
					? "added"
					: "empty-response"
				: "unavailable-or-failed",
			nodes: added,
		});
	}
	if (kind === "cxx") {
		addCxxIncludeEdges(graph, cwd, file, ignoredIds, contentOverride);
	}
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
}

export interface GraphFileImportChange {
	filePath: string;
	existedBefore: boolean;
	existsAfter: boolean;
	priorTargets: string[];
	newTargets: string[];
}

export interface GraphImportDelta {
	/** buildGeneration of the predecessor graph this delta was computed
	 * against. A consumer holding an index cached at any OTHER generation must
	 * NOT reuse/patch with this delta — generations minted by other call sites
	 * (mcp analyze, lens-map, session warm builds) carry import changes this
	 * one-step delta does not cover (#939 review). */
	fromGeneration: number | undefined;
	changes: GraphFileImportChange[];
}

const _graphImportChanges = new WeakMap<ReviewGraph, GraphImportDelta>();

/** One-step import-edge delta produced by this exact returned graph instance. */
export function getGraphImportChanges(
	graph: ReviewGraph,
): GraphImportDelta | undefined {
	return _graphImportChanges.get(graph);
}

function importTargetsForFile(graph: ReviewGraph, filePath: string): string[] {
	const normalized = normalizeMapKey(filePath);
	const fileNodeId = graph.fileNodes.get(normalized) ?? `file:${normalized}`;
	const targets = new Set<string>();
	// Cached graph snapshots intentionally omit derived indexes; read the
	// canonical edge collection so the delta is correct before the first rebuild.
	for (const edge of graph.edges) {
		if (edge.from !== fileNodeId) continue;
		if (edge.kind !== "imports") continue;
		const target = graph.nodes.get(edge.to)?.filePath;
		if (target) targets.add(normalizeMapKey(target));
	}
	return [...targets].sort((a, b) => a.localeCompare(b));
}

async function updateGraphFiles(
	graph: ReviewGraph,
	cwd: string,
	files: string[],
	facts: FactStore,
	ignoredIds?: ReadonlySet<string>,
): Promise<GraphFileImportChange[]> {
	const prior = files.map((file) => ({
		filePath: normalizeMapKey(file),
		existedBefore: graph.fileNodes.has(normalizeMapKey(file)),
		priorTargets: importTargetsForFile(graph, file),
	}));
	const preservedIncoming: ReviewGraphEdge[] = [];
	for (const file of files) {
		preservedIncoming.push(...removeFileOwnedGraphData(graph, file));
		await addFileToGraph(graph, cwd, file, facts, ignoredIds);
	}
	restoreValidIncomingEdges(graph, preservedIncoming);
	resolveDeferredSymbolEdges(graph, false);
	rebuildIndexes(graph);
	graph.changedSymbolsByFile.clear();
	for (const file of files) {
		upsertChangedSymbols(graph, facts, file);
	}
	return prior.map(({ filePath, existedBefore, priorTargets }) => ({
		filePath,
		existedBefore,
		existsAfter: graph.fileNodes.has(filePath),
		priorTargets,
		newTargets: importTargetsForFile(graph, filePath),
	}));
}

function resolveDeferredSymbolEdges(graph: ReviewGraph, rebuild = true): void {
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
		// refs #655 phase 2 ("import" tier): the calling file's own imports named
		// exactly which in-project file this bare callee comes from (see
		// `addJsTsFile`'s `importHintFile`). Narrow to that file BEFORE the
		// graph-wide uniqueness check — a name that's ambiguous project-wide can
		// still be unambiguous once scoped to the one file it was imported from.
		const importHintFile = edge.metadata?.importHintFile as string | undefined;
		if (importHintFile) {
			const scoped = candidates.filter(
				(id) => graph.nodes.get(id)?.filePath === importHintFile,
			);
			if (scoped.length === 1) {
				return { ...edge, to: scoped[0], resolution: "import" };
			}
		}
		if (candidates.length === 1) {
			// Exactly one same-named real symbol exists graph-wide: the bare-name
			// match is provably unambiguous (refs #655 — resolution confidence).
			return { ...edge, to: candidates[0], resolution: "exact" };
		}
		// 0 or 2+ candidates (and no import hint narrowed it): stays on the
		// unresolved placeholder, resolution stays "name-only" (set at edge
		// creation) — a consumer must not treat this edge's target as a
		// confirmed graph node.
		return edge;
	});
	if (rebuild) rebuildIndexes(graph);
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
	buildId?: number;
	seqHint?: boolean;
	mode?: ReviewGraphBuildMode;
	normalizedCwd: string;
	normalizedChanged: string[];
	fileSignatures: Map<string, string>;
	signature: string;
	facts: FactStore;
	/** #451: seq to stamp onto the freshly-built entry (undefined ⇒ no fast path later). */
	seqAtBuildStart?: number;
	/** #694: untracked-AND-ignored ids, fetched once per build — see `_doBuildGraph`. */
	ignoredIds?: ReadonlySet<string>;
	cacheEpoch?: number;
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
		setWorkspaceGraph(
			ctx.normalizedCwd,
			{
				signature: ctx.signature,
				fileSignatures: new Map(ctx.fileSignatures),
				fileHashes: hashes,
				graph: cloneGraph(cached.graph),
				buildGeneration: generation,
				...verifiedCacheFields(ctx.seqAtBuildStart),
			},
			ctx.cacheEpoch,
		);
		// #260: pure drift leaves the graph unchanged — don't rewrite the disk blob.
		setGraphBuildInfo(graph, {
			reused: true,
			mode: "cached",
			graphChanged: false,
		});
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

	const priorGeneration = cached.graph.buildGeneration;
	const graph = cloneGraph(cached.graph);
	const importChanges = await updateGraphFiles(
		graph,
		ctx.cwd,
		filesToUpdate,
		ctx.facts,
		ctx.ignoredIds,
	);
	refreshGraphBuiltAt(graph);
	// #459: real re-extract ⇒ new generation.
	const generation = ++_graphGenerationCounter;
	graph.buildGeneration = generation;
	setWorkspaceGraph(
		ctx.normalizedCwd,
		{
			signature: ctx.signature,
			fileSignatures: new Map(ctx.fileSignatures),
			fileHashes: hashes,
			graph,
			buildGeneration: generation,
			...verifiedCacheFields(ctx.seqAtBuildStart),
		},
		ctx.cacheEpoch,
	);
	const persistReason = persistGraph(
		ctx.cwd,
		ctx.signature,
		ctx.fileSignatures,
		hashes,
		graph,
		{
			buildId: ctx.buildId,
			projectSeq: ctx.seqAtBuildStart,
			seqHint: ctx.seqHint,
			mode: ctx.mode,
		},
	);
	setGraphBuildInfo(graph, {
		reused: true,
		mode: "incremental",
		...(persistReason ? { persistReason } : {}),
		graphChanged: true,
	});
	_graphImportChanges.set(graph, {
		fromGeneration: priorGeneration,
		changes: importChanges,
	});
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
	buildId: number | undefined,
	normalizedCwd: string,
	normalizedChanged: string[],
	facts: FactStore,
	seqHint: GraphSeqHint,
	seqAtBuildStart: number,
	ignoredIds?: ReadonlySet<string>,
	cacheEpoch?: number,
): Promise<SeqFastpathResult> {
	const cached = _workspaceGraphCache.get(normalizedCwd);
	// Condition 2: need an in-process complete entry that recorded a build seq.
	// A capped or entry-budget-truncated graph is read-only orientation data, not
	// a safe incremental base; force the next build through a complete walk.
	if (cached?.graph.persistCoverage?.partial) {
		return { fallback: "partial-base" };
	}
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
	if (
		ageMs > SEQ_FASTPATH_REVERIFY_MS ||
		sinceVerify >= SEQ_FASTPATH_REVERIFY_EVERY
	) {
		return { fallback: "verify-due" };
	}

	// Condition 3: bounded change set. changed ∪ changedFiles(param), normalized.
	const changedSet = new Set(
		seqHint
			.getFilesChangedSince(cached.builtAtProjectSeq)
			.map((file) => normalizeMapKey(file)),
	);
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
	const candidateFiles: string[] = [];
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
		candidateFiles.push(file);
	}

	// A pi-observed write can advance projectSeq without changing bytes (format
	// no-op, save, or an idempotent edit). Confirm content before re-extracting so
	// the seq fast path does not refresh builtAt or claim graphChanged for drift.
	const { trulyChanged, hashes } = await confirmContentChanged(
		candidateFiles,
		cached.fileHashes,
	);
	if (trulyChanged.length === 0) {
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
		const nextSignatures = new Map(cached.fileSignatures);
		for (const file of candidateFiles) {
			nextSignatures.set(file, sourceSignatureEntry(file));
		}
		cached.signature = sourceSignatureFromMap(nextSignatures);
		cached.fileSignatures = nextSignatures;
		cached.fileHashes = hashes;
		cached.builtAtProjectSeq = seqAtBuildStart;
		cached.fastPathSinceVerify = sinceVerify + 1;
		// #459: nothing graph-relevant changed — this is a genuine no-op reuse.
		const generation = (cached.buildGeneration ??= ++_graphGenerationCounter);
		setGraphBuildInfo(graph, {
			reused: true,
			mode: "seq-fastpath",
			graphChanged: false,
		});
		graph.buildGeneration = generation;
		facts.setSessionFact("session.reviewGraph", graph);
		return { graph };
	}

	// Incremental re-extract over exactly the content-changed files. Reuses the
	// SAME machinery as the signature-diff incremental path (updateGraphFiles), so
	// there's no second incremental implementation.
	const filesToUpdate = trulyChanged;
	const priorGeneration = cached.graph.buildGeneration;
	const graph = cloneGraph(cached.graph);
	let importChanges: GraphFileImportChange[];
	try {
		importChanges = await updateGraphFiles(
			graph,
			cwd,
			filesToUpdate,
			facts,
			ignoredIds,
		);
	} catch {
		return { fallback: "stat-error" };
	}
	refreshGraphBuiltAt(graph);

	// Update fileSignatures/fileHashes for ONLY the touched files (stat/hash just
	// those — the whole point of the fast path). Recompute the aggregate signature
	// the same way the incremental branch does (sourceSignatureFromMap).
	const nextSignatures = new Map(cached.fileSignatures);
	for (const file of candidateFiles) {
		nextSignatures.set(file, sourceSignatureEntry(file));
	}
	const nextSignature = sourceSignatureFromMap(nextSignatures);

	// #459: real re-extract ⇒ new generation.
	const generation = ++_graphGenerationCounter;
	graph.buildGeneration = generation;
	setWorkspaceGraph(
		normalizedCwd,
		{
			signature: nextSignature,
			fileSignatures: nextSignatures,
			fileHashes: hashes,
			graph,
			buildGeneration: generation,
			// Build-start seq, not stamp-time: see verifiedCacheFields — a bump that
			// interleaved during updateGraphFiles' awaits must be re-diffed next build.
			builtAtProjectSeq: seqAtBuildStart,
			lastFullVerifyMs: cached.lastFullVerifyMs,
			fastPathSinceVerify: sinceVerify + 1,
		},
		cacheEpoch,
	);
	const persistReason = persistGraph(
		cwd,
		nextSignature,
		nextSignatures,
		hashes,
		graph,
		{
			buildId,
			projectSeq: seqAtBuildStart,
			seqHint: true,
			mode: "seq-fastpath",
		},
	);
	// #459: filesToUpdate was non-empty — this fastpath re-extracted real files,
	// so (unlike the no-op branch above) the graph object did change.
	setGraphBuildInfo(graph, {
		reused: true,
		mode: "seq-fastpath",
		...(persistReason ? { persistReason } : {}),
		graphChanged: true,
	});
	_graphImportChanges.set(graph, {
		fromGeneration: priorGeneration,
		changes: importChanges,
	});
	facts.setSessionFact("session.reviewGraph", graph);
	return { graph };
}

async function _doBuildGraph(
	cwd: string,
	changedFiles: string[],
	facts: FactStore,
	seqHint?: GraphSeqHint,
	buildId?: number,
): Promise<ReviewGraph> {
	const normalizedCwd = normalizeMapKey(cwd);
	const cacheEpoch = workspaceCacheEpoch(normalizedCwd);
	// `await undefined` still yields a microtask, which reorders overlapping
	// builds in production where no test gate is installed — only await a gate
	// that exists.
	if (_reviewGraphBuildGateForTests) await _reviewGraphBuildGateForTests();
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
		setGraphBuildInfo(graph, {
			reused: false,
			mode: "skipped",
			skipReason: "unsafe_root",
			// #459: never persisted/reused, same as the too_many_files skip below —
			// treat as changed so dependents never trust stale derived state.
			graphChanged: true,
		});
		facts.setSessionFact("session.reviewGraph", graph);
		return graph;
	}

	// #451: capture the seq BEFORE any await — every builtAtProjectSeq stamp in
	// this build uses this value, so a bump that interleaves mid-build has
	// seq > stamp and is re-diffed next build (redundant re-extract, never a miss).
	const seqAtBuildStart = seqHint?.projectSeq();

	// #694: kick off the untracked-AND-ignored id fetch concurrently with the
	// walk below — it's independent of both. Memoized/time-bounded internally
	// (git-tracked-ignore.ts) so a hot per-edit rebuild loop shares one `git`
	// spawn instead of paying for one per file/per edit.
	const ignoredIdsPromise = collectUntrackedIgnoredIds(cwd);

	// #451: seq fast path — skip the O(project) walk+stat sweep when the
	// RuntimeCoordinator can tell us exactly which files changed. Any doubt inside
	// falls through to the full sweep below (which refreshes the verify clock). The
	// fallback reason is stamped onto whichever build-info the sweep records, so
	// cascade.log can watch the fast-path hit/miss rate.
	let seqFastpathFallback: SeqFastpathFallback | undefined;
	if (seqHint && seqAtBuildStart !== undefined && seqFastpathEnabled()) {
		const fast = await trySeqFastpath(
			cwd,
			buildId,
			normalizedCwd,
			normalizedChanged,
			facts,
			seqHint,
			seqAtBuildStart,
			await ignoredIdsPromise,
			cacheEpoch,
		);
		if ("graph" in fast) return fast.graph;
		seqFastpathFallback = fast.fallback;
	}

	const sourceCollection = await getGraphSourceFiles(cwd);
	const filesToBuild = sourceCollection.files;
	const sourceFileCount = sourceCollection.sourceFileCount;
	const sourceFilesTruncated = sourceCollection.entryBudgetExceeded;
	const ignoredIds = await ignoredIdsPromise;
	const maxGraphFiles = sourceCollection.maxFileCount;
	if (filesToBuild.length > maxGraphFiles) {
		const graph = createEmptyGraph();
		graph.version = REVIEW_GRAPH_VERSION;
		graph.builtAt = new Date().toISOString();
		for (const file of normalizedChanged) {
			upsertChangedSymbols(graph, facts, file);
		}
		// #782: record a TTL'd verdict so getCachedReviewGraph can stop serving
		// any graph cached/persisted from before the repo crossed the cap, and so
		// project_report can render an honest "disabled at N files" hint instead
		// of "retry shortly" — see getReviewGraphSizeSkipVerdict.
		recordReviewGraphSizeSkip(cwd, sourceFileCount, maxGraphFiles);
		// #775 R3: `_lastGraphBuildInfo`/the size-skip verdict above are only
		// SURFACED by callers that happen to read them (dispatch/integration.ts's
		// cascade path logs a `graph_build` phase; lens-map.ts, project-report.ts,
		// mcp/analyze.ts, runtime-session.ts, and tree-sitter.ts's runner do not).
		// Log unconditionally here, at the one place every caller funnels through,
		// so a monorepo crossing the cap is never a SILENT truncation — no caller
		// wiring required (AGENTS.md: no silent caps).
		logLatency({
			type: "phase",
			phase: "review_graph_size_skip",
			filePath: cwd,
			durationMs: 0,
			metadata: {
				cwd,
				sourceFileCount,
				maxFileCount: maxGraphFiles,
				sourceFileCountLabel: `more than ${maxGraphFiles} files`,
				sourceFileCountTruncated: true,
			},
		});
		if (isReviewGraphSizeNearMiss(sourceFileCount, maxGraphFiles)) {
			logLatency({
				type: "phase",
				phase: "review_graph_size_near_miss",
				filePath: cwd,
				durationMs: 0,
				metadata: {
					cwd,
					maxFileCount: maxGraphFiles,
					sourceFileCount,
					sourceFileCountLabel: `more than ${maxGraphFiles} files`,
					sourceFileCountTruncated: true,
				},
			});
		}
		setGraphBuildInfo(graph, {
			reused: false,
			mode: "skipped",
			skipReason: "too_many_files",
			sourceFileCount,
			sourceFileCountTruncated:
				sourceFilesTruncated || filesToBuild.length > maxGraphFiles,
			maxFileCount: maxGraphFiles,
			seqFastpathFallback,
			// #459: a fresh empty graph is returned every call on this path (never
			// persisted/reused) — treat it as changed so dependents never trust stale
			// derived state across skip/unskip transitions. Deliberately NOT stamped
			// with a buildGeneration: absent ⇒ derived caches rebuild every time.
			graphChanged: true,
		});
		facts.setSessionFact("session.reviewGraph", graph);
		return graph;
	}
	// #782: the repo is within the cap on this build attempt — drop any
	// previously recorded size-skip verdict immediately (rather than waiting
	// out the TTL) so a shrink or a raised cap re-enables reads the moment a
	// build actually succeeds.
	if (!sourceFilesTruncated) clearReviewGraphSizeSkip(cwd);
	const fileSignatures = await sourceSignatureMapAsync(filesToBuild);
	const signature = sourceSignatureFromMap(fileSignatures);

	// Tier 1: in-memory cache (hot path — same process, already built this session)
	let memCached = sourceFilesTruncated
		? undefined
		: _workspaceGraphCache.get(normalizedCwd);
	// A partial graph (hydrated from a capped snapshot for read-only orientation
	// via getCachedReviewGraph) can share this cache. It MUST NOT seed a build:
	// serving it silently drops the capped-away nodes/edges, and extending then
	// re-persisting it would launder partial coverage onto disk as a complete
	// snapshot (#936 review). Ignore it here — the disk tier rejects a partial
	// base too, so the build falls through to a full rebuild.
	if (memCached?.graph.persistCoverage?.partial) memCached = undefined;
	if (memCached?.signature === signature) {
		touchWorkspaceGraph(normalizedCwd);
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
		const generation = (memCached.buildGeneration ??=
			++_graphGenerationCounter);
		setGraphBuildInfo(graph, {
			reused: true,
			mode: "cached",
			seqFastpathFallback,
			graphChanged: false,
		});
		graph.buildGeneration = generation;
		facts.setSessionFact("session.reviewGraph", graph);
		return graph;
	}
	if (memCached) {
		const incremental = await tryIncrementalFromCache(memCached, {
			cwd,
			buildId,
			seqHint: seqHint !== undefined,
			mode: "incremental",
			normalizedCwd,
			normalizedChanged,
			fileSignatures,
			signature,
			facts,
			seqAtBuildStart,
			ignoredIds,
			cacheEpoch,
		});
		if (incremental) {
			updateGraphBuildInfo(incremental, { seqFastpathFallback });
			return incremental;
		}
	}

	// Tier 2: disk cache (cold start — files unchanged since last persist).
	// #300: deliberately does NOT verify the git stamp — the signature match /
	// #202 content-hash confirm below already content-verify the load, and
	// dropping on every HEAD move would force a full whole-repo rebuild after
	// each plain `git commit` (HEAD moves, files unchanged).
	const diskCached = sourceFilesTruncated ? null : loadPersistedGraph(cwd);
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
		setWorkspaceGraph(
			normalizedCwd,
			{
				signature,
				fileSignatures: new Map(fileSignatures),
				fileHashes: diskCached.fileHashes,
				graph: cloneGraph(diskCached.graph),
				buildGeneration: generation,
				...verifiedCacheFields(seqAtBuildStart),
			},
			cacheEpoch,
		);
		setGraphBuildInfo(graph, {
			reused: true,
			mode: "cached",
			seqFastpathFallback,
			graphChanged: false,
		});
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
				buildId,
				seqHint: seqHint !== undefined,
				mode: "incremental",
				normalizedCwd,
				normalizedChanged,
				fileSignatures,
				signature,
				facts,
				seqAtBuildStart,
				ignoredIds,
			},
		);
		if (incremental) {
			updateGraphBuildInfo(incremental, { seqFastpathFallback });
			return incremental;
		}
	}

	// Tier 3: full build — resumed from a prior session's checkpoint when one is
	// present and still current (#936 limit 2), else cold from an empty graph.
	const resumed = sourceFilesTruncated
		? null
		: await tryResumeFromCheckpoint(cwd, filesToBuild, ignoredIds);
	const graph = resumed?.graph ?? createEmptyGraph();
	const filesToExtract = resumed?.remaining ?? filesToBuild;
	const treeSitterClient = getSharedTreeSitterClient();
	// #1941: grow the tree cache to span THIS pass's actual per-parse working
	// set before parsing starts — filesToExtract, not filesToBuild. On a cold
	// build they're the same array; on a resumed build filesToExtract is only
	// the checkpoint's remaining (unprocessed) files, since resumed files are
	// reused from the checkpoint graph and never re-parsed here. Sizing to
	// filesToBuild on a resume would over-grow the cache for files this pass
	// never touches. Same #1715 pattern as scanner.ts:147 — monotonic and
	// ceiling-bounded inside ensureTreeCacheCapacity itself.
	treeSitterClient?.ensureTreeCacheCapacity(filesToExtract.length);
	const extractionStartedAt = Date.now();
	// Seeded with the reused files' hashes on resume so the completed snapshot
	// still records a hash for every file (needed by #202 incremental next time).
	const fileHashes = resumed?.fileHashes ?? new Map<string, string>();
	// #936: after each file, snapshot the PRE-resolution graph + processed-file
	// hashes so a killed session can resume. Gated by BOTH a file-count stride
	// and a min wall-time interval so a long build pays only a handful of writes.
	const checkpointEvery = graphCheckpointEveryFiles();
	const checkpointMinIntervalMs = graphCheckpointMinIntervalMs();
	const testStopAfter = Number(
		process.env.PI_LENS_GRAPH_CHECKPOINT_TEST_STOP_AFTER,
	);
	let filesSinceCheckpoint = 0;
	let lastCheckpointMs = Date.now();
	let extractedCount = 0;
	const extractFiles = async (): Promise<void> => {
		for (const file of filesToExtract) {
			let content: string | null;
			try {
				const bytes = fs.readFileSync(file);
				content = bytes.toString("utf-8");
				fileHashes.set(file, createHash("sha256").update(bytes).digest("hex"));
			} catch {
				content = null;
				fileHashes.set(file, "missing");
			}
			await addFileToGraph(graph, cwd, file, facts, ignoredIds, content);
			if (normalizedChangedSet.has(file)) {
				upsertChangedSymbols(graph, facts, file);
			}
			extractedCount++;
			filesSinceCheckpoint++;
			// Test seam: simulate a session killed mid-build after N files, having
			// just written a checkpoint. Write SYNCHRONOUSLY so the checkpoint is
			// deterministically on disk before the abort throw — the offloaded path
			// would not have promoted yet. The next (un-stopped) build resumes it.
			if (
				Number.isFinite(testStopAfter) &&
				testStopAfter > 0 &&
				extractedCount >= testStopAfter
			) {
				writeReviewGraphCheckpointSync(
					cwd,
					buildReviewGraphCheckpointData(
						cwd,
						graph,
						fileHashes,
						filesToBuild.length,
						ignoredIds,
					),
					{
						nodes: graph.nodes.size,
						edges: graph.edges.length,
						processed: fileHashes.size,
						target: filesToBuild.length,
					},
				);
				throw new Error("__review_graph_checkpoint_test_abort__");
			}
			const remainingAfter = filesToExtract.length - extractedCount;
			if (
				filesSinceCheckpoint >= checkpointEvery &&
				remainingAfter >= checkpointEvery &&
				Date.now() - lastCheckpointMs >= checkpointMinIntervalMs
			) {
				writeReviewGraphCheckpoint(
					cwd,
					graph,
					fileHashes,
					filesToBuild.length,
					ignoredIds,
				);
				filesSinceCheckpoint = 0;
				lastCheckpointMs = Date.now();
			}
		}
	};
	const extractAndDrainIr = async (): Promise<void> => {
		try {
			await extractFiles();
		} finally {
			// The build consumed every fresh entry (consume-once deletes them);
			// leftovers are stale/test/non-build files nothing will ever read.
			// Clearing here bounds the registry to the scan-to-build window
			// (#955 review — the #886 retention class).
			clearReviewGraphFileIr(cwd);
		}
	};
	if (treeSitterClient) {
		await treeSitterClient.withParseCacheMeasurement(
			extractAndDrainIr,
			(stats) => {
				logTreeSitterCacheStats({
					scope: "review_graph_full",
					filePath: cwd,
					fileCount: filesToBuild.length,
					durationMs: Date.now() - extractionStartedAt,
					stats,
					// #1982: this scope never runs an ast-grep pass (extraction is
					// tree-sitter only), so durationMs carries none and explicit
					// zeros keep every cache_stats record uniformly parseable.
					astGrep: { durationMs: 0, fileCount: 0 },
				});
			},
		);
	} else {
		await extractAndDrainIr();
	}

	// #936: a changed file that was REUSED from the checkpoint (unchanged content)
	// is never revisited by the extraction loop above, so run its changed-symbol
	// upsert here — matching what a cold build's inline pass would have done.
	if (resumed) {
		for (const file of normalizedChangedSet) {
			if (resumed.fileHashes.has(file)) {
				upsertChangedSymbols(graph, facts, file);
			}
		}
	}

	resolveDeferredSymbolEdges(graph);
	graph.version = REVIEW_GRAPH_VERSION;
	graph.builtAt = new Date().toISOString();
	// #936: the build is now complete over the full target set — drop the
	// in-progress/partial marker a resumed seed carried so the finished graph is
	// never mistaken for (or persisted as) a partial one, and retire the
	// checkpoint now that an authoritative snapshot supersedes it.
	graph.persistCoverage = sourceFilesTruncated
		? graphCoverage(
				graph,
				graphPersistMaxElements(),
				sourceFileCount,
				true,
				filesToBuild,
			)
		: undefined;
	deleteReviewGraphCheckpoint(cwd);
	// #202: the full-build pass hashes the same bytes it supplies to extraction,
	// so change detection does not reread every file after the graph is built.
	// #459: full rebuild ⇒ new generation.
	const generation = ++_graphGenerationCounter;
	const graphSnapshot = cloneGraph(graph);
	rebuildIndexes(graphSnapshot);
	// Keep the content generation on the persisted snapshot instance too, so
	// scheduled persistence logs join the same graph identity as build success.
	graphSnapshot.buildGeneration = generation;
	setWorkspaceGraph(
		normalizedCwd,
		{
			signature,
			fileSignatures: new Map(fileSignatures),
			fileHashes,
			graph: graphSnapshot,
			buildGeneration: generation,
			...verifiedCacheFields(seqAtBuildStart),
		},
		cacheEpoch,
	);
	const persistReason = persistGraph(
		cwd,
		signature,
		fileSignatures,
		fileHashes,
		graphSnapshot,
		{
			buildId,
			projectSeq: seqAtBuildStart,
			seqHint: seqHint !== undefined,
			mode: "full",
			sourceFileCount,
			sourceFilesTruncated,
		},
	); // fire-and-forget
	setGraphBuildInfo(graph, {
		reused: false,
		mode: "full",
		sourceFileCount,
		sourceFileCountTruncated: sourceFilesTruncated,
		seqFastpathFallback,
		...(persistReason ? { persistReason } : {}),
		graphChanged: true,
	});
	graph.buildGeneration = generation;
	facts.setSessionFact("session.reviewGraph", graph);
	return graph;
}

/**
 * The one place the in-flight dedupe key is derived — and the one place its
 * workspace half is normalized (#1962 review F2).
 *
 * The key used to interpolate the caller's RAW `cwd`. Callers hand in whatever
 * path they hold: `runtime-session.ts:1562`, `lens-map.ts:1243`, and
 * `mcp/cli.ts:59` pass an unnormalized root, while project_report's trigger
 * passes `normalizeMapKey(path.resolve(cwd))`. On Windows those differ by
 * separator and casing alone, so ONE workspace produced two live `_buildCache`
 * entries: two concurrent full builds of the same repo (the #256 two-build OOM
 * shape), and an `isGraphBuildInFlight` probe that answered about a key nobody
 * else used. Folding here makes every caller land on one key without any of
 * them having to know that.
 *
 * The derivation lives in {@link buildCacheWorkspaceKey}, which the two sites
 * that read build keys BACK also use, so write and read agree by construction
 * rather than by coincidence.
 */
function buildCacheKey(cwd: string, changedFiles: string[]): string {
	return `${buildCacheWorkspaceKey(cwd)}|${[...changedFiles].sort((a, b) => a.localeCompare(b)).join(",")}`;
}

/**
 * Whether a build for this exact (cwd, changedFiles) key is PENDING right now
 * (#1962). Callers that report to a user — project_report's cold-path trigger —
 * read this BEFORE calling `buildOrUpdateGraph`, so "a retry was started" is
 * only said when a build actually started rather than when an in-flight one
 * absorbed the call. Check and call must happen in the same synchronous block;
 * anything awaited between them reopens the race this exists to close.
 */
export function isGraphBuildInFlight(
	cwd: string,
	changedFiles: string[] = [],
): boolean {
	return _buildCache.has(buildCacheKey(cwd, changedFiles));
}

export function buildOrUpdateGraph(
	cwd: string,
	changedFiles: string[],
	facts: FactStore,
	seqHint?: GraphSeqHint,
): Promise<ReviewGraph> {
	const cacheKey = buildCacheKey(cwd, changedFiles);
	// Only a PENDING build is here (see `_buildCache`), so this dedupes genuine
	// concurrency and nothing else.
	const cached = _buildCache.get(cacheKey);
	if (cached) return cached;

	const startedAt = Date.now();
	const buildId = ++_buildIdCounter;
	recordBuildAttempt(cwd, "running", undefined, buildId);
	const startedProjectSeq = seqHint?.projectSeq();
	logReviewGraph({
		cwd,
		phase: "build_started",
		observability: {
			graph: {
				buildId,
				...(startedProjectSeq === undefined
					? {}
					: { projectSeq: startedProjectSeq }),
				...(seqHint === undefined ? {} : { seqHint: true }),
				nodes: 0,
				edges: 0,
			},
		},
	});
	const promise = _doBuildGraph(cwd, changedFiles, facts, seqHint, buildId)
		.then((graph) => {
			const buildInfo = getGraphBuildInfoForGraph(graph);
			if (buildInfo.mode === "skipped") {
				const reason = buildInfo.skipReason ?? "skipped";
				recordBuildAttempt(cwd, "skipped", reason, buildId);
				logReviewGraph({
					cwd,
					phase: "build_skipped",
					reason,
					durationMs: Date.now() - startedAt,
					observability: {
						graph: graphLogMetadata(graph, {
							buildId,
							projectSeq: startedProjectSeq,
							seqHint: seqHint !== undefined,
							mode: buildInfo.mode,
							sourceFileCount: buildInfo.sourceFileCount,
							sourceFileCountTruncated: buildInfo.sourceFileCountTruncated,
						}),
					},
				});
			} else {
				const reason = buildInfo.persistReason;
				recordBuildAttempt(cwd, "succeeded", reason, buildId);
				logReviewGraph({
					cwd,
					phase: "build_succeeded",
					durationMs: Date.now() - startedAt,
					nodes: graph.nodes.size,
					edges: graph.edges.length,
					...(reason ? { reason } : {}),
					observability: {
						graph: graphLogMetadata(graph, {
							buildId,
							projectSeq: startedProjectSeq,
							seqHint: seqHint !== undefined,
							mode: buildInfo.mode,
							sourceFileCount: buildInfo.sourceFileCount,
							sourceFileCountTruncated: buildInfo.sourceFileCountTruncated,
						}),
					},
				});
			}
			return graph;
		})
		.catch((err) => {
			const reason = err instanceof Error ? err.message : String(err);
			recordBuildAttempt(cwd, "failed", reason, buildId);
			logReviewGraph({
				cwd,
				phase: "build_failed",
				reason,
				durationMs: Date.now() - startedAt,
				error: reason,
				observability: {
					graph: {
						buildId,
						...(seqHint === undefined ? {} : { seqHint: true }),
						nodes: 0,
						edges: 0,
					},
				},
			});
			throw err as Error;
		});
	_buildCache.set(cacheKey, promise);
	// #1962: the entry's lifetime is the BUILD's, not the process's. Settling —
	// fulfilled, skipped, or rejected — releases the key so the next caller
	// really builds. The identity guard means a newer build that already claimed
	// the key survives this older build's cleanup. `then(fn, fn)` rather than
	// `finally` so the derived promise handles the rejection instead of raising
	// an unhandled one; the returned `promise` is unchanged either way.
	const release = (): void => {
		if (_buildCache.get(cacheKey) === promise) _buildCache.delete(cacheKey);
	};
	promise.then(release, release);
	return promise;
}

/**
 * Normalize graph symbol/call/reference evidence for call-graph construction.
 *
 * Graph node ids are opaque canonical identities (kind and line are part of the
 * id), so this adapter always reads target metadata from the target node. It
 * retains unresolved/type-only evidence for bounded coverage accounting, but
 * buildCallGraph will not turn those records into concrete edges.
 */
export function extractSymbolsAndRefsFromGraph(graph: ReviewGraph): {
	allSymbols: Map<string, import("../symbol-types.js").Symbol[]>;
	allRefs: Map<string, import("../symbol-types.js").SymbolRef[]>;
	coverage: CallGraphEvidenceCoverage;
} {
	const allSymbols = new Map<string, import("../symbol-types.js").Symbol[]>();
	const allRefs = new Map<string, import("../symbol-types.js").SymbolRef[]>();
	const nodeSymbols = new Map<string, import("../symbol-types.js").Symbol>();
	const coverage: CallGraphEvidenceCoverage = {
		totalEvidence: 0,
		callsEvidence: 0,
		referencesEvidence: 0,
		eligibleEvidence: 0,
		resolvedEvidence: 0,
		unresolvedEvidence: 0,
		typeOnlyEvidence: 0,
		unsupportedEvidence: 0,
		sameFileEvidence: 0,
		duplicateEvidence: 0,
		complete:
			graph.persistCoverage?.partial !== true &&
			graph.persistCoverage?.inProgress !== true,
		languages: {},
	};

	const numberMetadata = (
		node: ReviewGraphNode | undefined,
		key: string,
	): number | undefined => {
		const value = node?.metadata?.[key];
		return typeof value === "number" && Number.isFinite(value)
			? value
			: undefined;
	};
	const symbolKind = (node: ReviewGraphNode): SymbolKind => {
		switch (node.symbolKind) {
			case "class":
			case "interface":
			case "type":
			case "variable":
			case "method":
			case "property":
			case "function":
				return node.symbolKind;
			default:
				return "function";
		}
	};

	for (const node of graph.nodes.values()) {
		if (node.kind !== "symbol" || !node.filePath || !node.symbolName) continue;
		const sym: import("../symbol-types.js").Symbol = {
			id: node.id,
			name: node.symbolName,
			kind: symbolKind(node),
			filePath: node.filePath,
			line: numberMetadata(node, "line") ?? 1,
			endLine: numberMetadata(node, "endLine"),
			column: numberMetadata(node, "column") ?? 1,
			isExported: node.exported === true,
		};
		nodeSymbols.set(node.id, sym);
		const list = allSymbols.get(node.filePath) ?? [];
		list.push(sym);
		allSymbols.set(node.filePath, list);
	}

	const addRef = (ref: SymbolRef): void => {
		const list = allRefs.get(ref.filePath) ?? [];
		list.push(ref);
		allRefs.set(ref.filePath, list);
	};

	for (const edge of graph.edges) {
		if (edge.kind !== "calls" && edge.kind !== "references") continue;
		coverage.totalEvidence++;
		if (edge.kind === "calls") coverage.callsEvidence++;
		else coverage.referencesEvidence++;

		const fromNode = graph.nodes.get(edge.from);
		const targetNode = graph.nodes.get(edge.to);
		const callerFile =
			fromNode?.kind === "symbol"
				? fromNode.filePath
				: fromNode?.kind === "file"
					? fromNode.filePath
					: edge.from.startsWith("file:")
						? edge.from.slice("file:".length)
						: undefined;
		if (!callerFile) {
			coverage.unsupportedEvidence++;
			continue;
		}
		const metadata = edge.metadata ?? {};
		const referenceKind =
			edge.kind === "calls"
				? "call"
				: metadata.referenceKind === "call"
					? "call"
					: metadata.referenceKind === "type"
						? "type"
						: "unknown";
		const resolution =
			edge.resolution ??
			(targetNode && !targetNode.metadata?.unresolvedName
				? "exact"
				: "unresolved");
		const targetSymbol = nodeSymbols.get(edge.to);
		const targetName =
			targetNode?.symbolName ??
			(edge.to.startsWith("symbol-name:")
				? edge.to.slice("symbol-name:".length)
				: undefined);
		const line =
			typeof metadata.line === "number"
				? metadata.line
				: (numberMetadata(fromNode, "line") ?? 1);
		const column =
			typeof metadata.column === "number"
				? metadata.column
				: (numberMetadata(fromNode, "column") ?? 1);
		addRef({
			symbolId: targetName ? `${callerFile}:${targetName}` : edge.to,
			filePath: callerFile,
			line,
			column,
			evidenceKind: edge.kind,
			referenceKind,
			targetId: edge.to,
			callerSymbolId: fromNode?.kind === "symbol" ? fromNode.id : undefined,
			resolution,
			targetName,
			targetKind: targetNode?.symbolKind,
			targetFilePath: targetNode?.filePath,
			targetLine: numberMetadata(targetNode, "line"),
			targetColumn: numberMetadata(targetNode, "column"),
		});

		if (referenceKind === "type") coverage.typeOnlyEvidence++;
		else if (referenceKind !== "call") coverage.unsupportedEvidence++;
		else if (
			!targetSymbol ||
			resolution === "name-only" ||
			resolution === "unresolved"
		) {
			coverage.unresolvedEvidence++;
		} else {
			coverage.eligibleEvidence++;
			coverage.resolvedEvidence++;
		}
	}

	// Capped/partial graph persistence and file-level extractor metadata are
	// explicit degradation signals for read-only consumers. Missing metadata is
	// also unavailable: old/synthetic file nodes cannot prove that definitions,
	// references, or the TS/TSX warm function facts were attempted successfully.
	let sawRelevantFileNode = false;
	for (const node of graph.nodes.values()) {
		if (node.kind !== "file") continue;
		sawRelevantFileNode = true;
		const extraction = node.metadata?.extractionCoverage as
			| Record<string, "complete" | "partial" | "unavailable" | undefined>
			| undefined;
		const statuses = extraction ? Object.values(extraction) : [];
		const languageStatus =
			!extraction || statuses.length === 0 || statuses.includes("unavailable")
				? "unavailable"
				: statuses.includes("partial")
					? "partial"
					: "complete";
		if (languageStatus !== "complete") coverage.complete = false;
		if (node.language) {
			const prior = coverage.languages![node.language];
			coverage.languages![node.language] =
				prior === "unavailable" || languageStatus === "unavailable"
					? "unavailable"
					: prior === "partial" || languageStatus === "partial"
						? "partial"
						: languageStatus;
		}
	}
	// A graph with symbols/evidence but no file coverage metadata is a
	// synthetic/legacy shape that cannot prove which source files were
	// actually extracted. Do not let it masquerade as a complete scan.
	// No file node means there is no bounded source/extractor coverage to
	// justify a clean empty call graph (including an entirely empty or
	// external-only synthetic graph).
	if (!sawRelevantFileNode) coverage.complete = false;

	return { allSymbols, allRefs, coverage };
}
