/**
 * Project Report (#773) — the top of the discovery funnel: `project_report` →
 * `module_report` → `read_symbol`. Answers "orient me in this project" from
 * data the review graph already computes, so no line of output exists unless
 * it changes which file the calling agent opens next (no vanity metrics —
 * no file counts, LOC averages, language breakdowns as their own section).
 *
 * READ-ONLY over the cached review graph, mirroring module_report's #256
 * no-build contract: this tool's product IS the graph, so a cold cache kicks
 * off a single bounded background build (deduped per cwd, fire-and-forget)
 * and returns `available: false` with an actionable retry hint — the same
 * shape symbol_search's cold word-index path uses (clients/lens-engine.ts).
 * The call never blocks on a build.
 *
 * Six sections, each capped and ranked worst/most-important first:
 *  1. trust     — graph freshness + coverage + edge-resolution-quality mix.
 *  2. hubs      — top fan-in files (the repo's contract surface).
 *  3. entryPoints — near-zero fan-in, high fan-out files (activation/CLI/mains).
 *  4. subsystems — directory-level import graph: cycles + layering violations.
 *  5. riskHotspots — fan-in × max per-symbol cyclomatic complexity.
 *  6. deadWeight — zero-importer files that aren't entry points (low-confidence
 *     — shipped with an explicit disclaimer; dynamic imports/runtime
 *     registration/test-only reachability all produce false positives here).
 *
 * Non-goals (v1, refs #773): no per-symbol detail (module_report's job), no
 * delta/"since ref" mode (needs git integration — a follow-up), no prose
 * summarization (structural facts only; the calling agent composes its own
 * narrative). Middle-man detection is NOT surfaced here: the review graph
 * does not currently persist that signal on symbol nodes (module_report
 * computes it per-file, on demand, from raw file content — see
 * middle-man-analysis.ts) and re-deriving it project-wide would mean
 * re-reading and re-scanning every class-bearing file on this read-only,
 * never-blocks path. A follow-up could have the builder persist the signal
 * into symbol-node metadata so this path can read it for free.
 */

import * as path from "node:path";
import type { FactStore } from "./dispatch/fact-store.js";
import { normalizeMapKey, toProjectRelativePath } from "./path-utils.js";
import { loadProjectSnapshotWithoutWordIndex } from "./project-snapshot.js";
import {
	formatReviewGraphRevisionDriftNote,
	type ReviewGraphRevisionDrift,
} from "./review-graph/revision-drift.js";
import type { ReviewGraph } from "./review-graph/types.js";

export interface ProjectReportOptions {
	/** Scales every ranked list's cap (default 10). A single knob, per #773's
	 * mechanics — no per-section limit params. */
	limit?: number;
	/** Optional task hint used only to re-rank sections toward relevant
	 * subsystems; never expands scope or triggers scans. The project-level
	 * analogue of module_report's `focus`-ranked recommendedReads. */
	focus?: string;
	/** Rendering instruction only (mirrors module_report's `view`): "compact"
	 * signals the caller to use `renderCompactProjectReport` instead of JSON.
	 * The computed data is identical either way. */
	view?: "compact";
}

interface ProjectReportTrust {
	graphBuiltAt: string;
	/** Files with a node in the cached graph. */
	filesCovered: number;
	/** Project source-file count from the persisted project snapshot (#773:
	 * reuses that existing file-count source rather than a new tree walk).
	 * Equal to `filesCovered` when no snapshot exists yet (honest fallback,
	 * not a claim of full coverage). */
	filesTotal: number;
	/** filesCovered / filesTotal, clamped to [0, 1]. */
	coverage: number;
	/** Fraction of resolution-tagged calls/references edges in each tier.
	 * Edges without a `resolution` tag (imports/contains/defines, or an
	 * unambiguous external call) are excluded from the denominator. */
	resolution: {
		exact: number;
		import: number;
		receiverType: number;
		nameOnly: number;
		/** Count backing the fractions above — 0 means no resolution-tagged
		 * edges exist yet (e.g. a graph with no jsts files). */
		sampleSize: number;
	};
	/** True when the graph is older than a "trust this without a refresh"
	 * threshold. */
	stale: boolean;
	/**
	 * #1961: present when the served snapshot was persisted at a different
	 * commit than the current HEAD. The read path verifies tree identity, not
	 * revision, so a revision difference is reported here rather than hiding
	 * the graph. Absent on an in-process graph and on a matching snapshot.
	 */
	revisionDrift?: ReviewGraphRevisionDrift;
	/** True when coverage is low enough that whole subsystems may be
	 * invisible to every other section below. */
	lowCoverage: boolean;
	/** Exact element coverage when persistence capped this on-disk graph. */
	persistCoverage?: ReviewGraph["persistCoverage"];
	/** Human-readable call-outs for the two flags above — always non-empty
	 * when `stale` or `lowCoverage` is true (#773: "must say so explicitly"). */
	notes: string[];
}

interface ProjectReportFileRef {
	suggestedNext: { tool: "module_report"; path: string };
}

interface ProjectReportHub extends ProjectReportFileRef {
	file: string;
	fanIn: number;
	blastRadius: number;
	/** Comma-joined most-imported exported symbol names, when known. */
	role?: string;
}

interface ProjectReportEntryPoint extends ProjectReportFileRef {
	file: string;
	fanIn: number;
	fanOut: number;
}

interface DirectoryEdge {
	from: string;
	to: string;
	count: number;
}

interface DirectoryCycle {
	dirs: string[];
	edgeCount: number;
}

interface LayeringViolation {
	/** The minority (against-the-grain) direction. */
	from: string;
	to: string;
	count: number;
	/** Edge count in the dominant (majority) direction for the same pair. */
	dominantCount: number;
}

interface SubsystemMap {
	directories: string[];
	edges: DirectoryEdge[];
	/** Directory-level import cycles, worst-first (most edges among the
	 * cycle's members). */
	cycles: DirectoryCycle[];
	/** Edges running against the dominant direction for their directory pair
	 * — layering violations, worst-first. */
	violations: LayeringViolation[];
}

interface RiskHotspot extends ProjectReportFileRef {
	file: string;
	fanIn: number;
	maxComplexity: number;
	/** fanIn * maxComplexity — the ranking key. */
	score: number;
}

interface DeadWeightFile extends ProjectReportFileRef {
	file: string;
}

export interface ProjectReport {
	/** False on a cold cache (no graph yet) or an unreadable project root. */
	available: boolean;
	/** Actionable guidance when `available` is false: a background build was
	 * kicked off (deduped per cwd), never blocking this call. */
	hint?: string;
	/** Most recent background/build attempt, including terminal skip/failure
	 * reasons so a cold report never masquerades as perpetual progress. */
	lastBuildAttempt?: {
		when: string;
		outcome: "running" | "succeeded" | "skipped" | "failed";
		reason?: string;
		/** Process-wide monotonic build identity (#2441). `when` is wall-clock
		 * ISO and two attempts can land in the same millisecond — this is the
		 * one field that always distinguishes attempts; compare it, not `when`. */
		buildId?: number;
	};
	view?: "compact";
	trust?: ProjectReportTrust;
	hubs?: ProjectReportHub[];
	entryPoints?: ProjectReportEntryPoint[];
	subsystems?: SubsystemMap;
	riskHotspots?: RiskHotspot[];
	deadWeight?: {
		files: DeadWeightFile[];
		/** Always present alongside `files` (#773: "ALWAYS include the
		 * low-confidence disclaimer line"), even when the list is empty, so a
		 * caller who inspects only `deadWeight.files.length === 0` still saw
		 * the caveat travel with the section. */
		disclaimer: string;
	};
}

const DEFAULT_LIMIT = 10;
const STALE_THRESHOLD_MS = 15 * 60_000; // 15 minutes
const LOW_COVERAGE_THRESHOLD = 0.8;
const DEAD_WEIGHT_DISCLAIMER =
	"Low confidence: dynamic imports, runtime registration, and test-only " +
	"reachability all produce false positives here — verify with a real " +
	"usage search (symbol_search/grep) before deleting anything listed.";

function clampLimit(limit: number | undefined): number {
	return Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT));
}

// Same display-path convention as module-report.ts's toDisplayPath: cwd-relative
// + forward-slashed under the project root, else the absolute (slash-normalized)
// path. Delegates to the shape-aware toProjectRelativePath (#1163/#1194) instead
// of hand-rolling with host-default path.isAbsolute/path.relative, which
// mis-parses a Windows-shaped path (e.g. a persisted graph symbol-key path) on
// Linux CI: path.isAbsolute("C:\\repo\\x.ts") is false there, short-circuiting
// to the raw absolute path instead of relativizing (#1024 divergence class).
function toDisplayPath(p: string, projectRoot: string): string {
	return toProjectRelativePath(p, projectRoot);
}

/** Test-only export (refs #1194) so the shape-aware delegation can be verified
 * directly without standing up a full review graph — mirrors the
 * `_reset*ForTests` underscore convention used elsewhere in this file. */
export function _toDisplayPathForTests(p: string, projectRoot: string): string {
	return toDisplayPath(p, projectRoot);
}

function suggestedNext(displayPath: string): {
	tool: "module_report";
	path: string;
} {
	return { tool: "module_report", path: displayPath };
}

// --- focus re-ranking (module_report's normalizeFocus/focusScore pattern) ----
// Duplicated rather than imported: module-report.ts doesn't export these, and
// the two token sets are scored slightly differently downstream (whole
// section rankings here vs per-symbol/per-callback there), so a shared export
// would be a false abstraction for two call sites.

function normalizeFocus(focus: string | undefined): string[] {
	return (focus ?? "")
		.toLowerCase()
		.split(/[^a-z0-9_.]+/)
		.map((part) => part.trim())
		.filter((part) => part.length >= 3)
		.slice(0, 8);
}

function focusScore(text: string, terms: string[]): number {
	if (terms.length === 0) return 0;
	const haystack = text.toLowerCase();
	return terms.reduce(
		(score, term) => score + (haystack.includes(term) ? 6 : 0),
		0,
	);
}

// --- file-level fan-in/fan-out over internal "imports" edges -----------------

interface FileDegrees {
	/** fileNodeId -> set of importer fileNodeIds. */
	fanIn: Map<string, Set<string>>;
	/** fileNodeId -> set of imported fileNodeIds. */
	fanOut: Map<string, Set<string>>;
}

function buildFileDegrees(graph: ReviewGraph): FileDegrees {
	const fanIn = new Map<string, Set<string>>();
	const fanOut = new Map<string, Set<string>>();
	for (const edge of graph.edges) {
		if (edge.kind !== "imports") continue;
		if (edge.from === edge.to) continue;
		const fromNode = graph.nodes.get(edge.from);
		const toNode = graph.nodes.get(edge.to);
		if (!fromNode || fromNode.kind !== "file") continue;
		if (!toNode || toNode.kind !== "file") continue; // internal files only
		let outSet = fanOut.get(edge.from);
		if (!outSet) {
			outSet = new Set();
			fanOut.set(edge.from, outSet);
		}
		outSet.add(edge.to);
		let inSet = fanIn.get(edge.to);
		if (!inSet) {
			inSet = new Set();
			fanIn.set(edge.to, inSet);
		}
		inSet.add(edge.from);
	}
	return { fanIn, fanOut };
}

// --- section 1: trust header --------------------------------------------------

function computeTrust(
	graph: ReviewGraph,
	cwd: string,
	// Passed in rather than looked up here: the builder is imported dynamically
	// by `projectReport` to keep the module graph acyclic, and the value must be
	// computed per render, never cached (#1961 review F3).
	drift: ReviewGraphRevisionDrift | undefined,
): ProjectReportTrust {
	const filesCovered = graph.fileNodes.size;
	const snapshot = loadProjectSnapshotWithoutWordIndex(cwd);
	const snapshotFileCount = snapshot ? Object.keys(snapshot.files).length : 0;
	const persistedTotal = graph.persistCoverage?.totalFiles ?? 0;
	const filesTotal = Math.max(filesCovered, snapshotFileCount, persistedTotal);
	const coverage = filesTotal > 0 ? filesCovered / filesTotal : 1;

	let exact = 0;
	let imp = 0;
	let receiverType = 0;
	let nameOnly = 0;
	for (const edge of graph.edges) {
		if (edge.kind !== "calls" && edge.kind !== "references") continue;
		switch (edge.resolution) {
			case "exact":
				exact += 1;
				break;
			case "import":
				imp += 1;
				break;
			case "receiver-type":
				receiverType += 1;
				break;
			case "name-only":
				nameOnly += 1;
				break;
			default:
				break;
		}
	}
	const sampleSize = exact + imp + receiverType + nameOnly;
	const frac = (n: number) => (sampleSize > 0 ? n / sampleSize : 0);

	const ageMs = Date.now() - Date.parse(graph.builtAt);
	const stale = Number.isFinite(ageMs) && ageMs > STALE_THRESHOLD_MS;
	const lowCoverage =
		coverage < LOW_COVERAGE_THRESHOLD ||
		graph.persistCoverage?.partial === true;

	const notes: string[] = [];
	// #1961: the blind read now SERVES a snapshot stamped at a different HEAD
	// rather than dropping it. Age alone would not catch a branch switch made
	// minutes ago, so the revision difference gets its own note.
	if (drift) notes.push(formatReviewGraphRevisionDriftNote(drift));
	if (stale) {
		const ageMin = Math.round(ageMs / 60_000);
		notes.push(
			`Graph is stale: built ${ageMin}m ago. Sections below may miss recent edits — run pilens_rebuild or re-analyze to refresh.`,
		);
	}
	if (lowCoverage) {
		if (graph.persistCoverage?.partial) {
			const p = graph.persistCoverage;
			const totalFiles = p.totalFiles ?? filesCovered;
			const persistedFiles = p.persistedFiles ?? filesCovered;
			if (p.sourceFilesTruncated) {
				notes.push(
					`Partial source walk: at least ${totalFiles} source files were represented before the visited-entry budget stopped enumeration; ${persistedFiles} files are in this graph.`,
				);
			} else {
				notes.push(
					`Partial persisted graph: ${p.persistedNodes}/${p.totalNodes} nodes, ${p.persistedEdges}/${p.totalEdges} edges, and ${persistedFiles}/${totalFiles} files were retained under the ${p.cap}-element cap — whole subsystems may be invisible below.`,
				);
			}
		} else {
			notes.push(
				`Low coverage: only ${filesCovered}/${filesTotal} project files (${Math.round(coverage * 100)}%) are in the graph — whole subsystems may be invisible below.`,
			);
		}
	}

	return {
		graphBuiltAt: graph.builtAt,
		filesCovered,
		filesTotal,
		coverage,
		resolution: {
			exact: frac(exact),
			import: frac(imp),
			receiverType: frac(receiverType),
			nameOnly: frac(nameOnly),
			sampleSize,
		},
		stale,
		...(drift ? { revisionDrift: drift } : {}),
		lowCoverage,
		persistCoverage: graph.persistCoverage?.partial
			? graph.persistCoverage
			: undefined,
		notes,
	};
}

// --- section 2: hubs -----------------------------------------------------------

function roleFor(graph: ReviewGraph, filePath: string): string | undefined {
	const symbolIds = graph.symbolNodesByFile.get(filePath) ?? [];
	const scored: Array<{ name: string; refs: number }> = [];
	for (const symbolId of symbolIds) {
		const node = graph.nodes.get(symbolId);
		if (!node || !node.exported || !node.symbolName) continue;
		const refs = (graph.edgesByTo.get(symbolId) ?? []).filter(
			(e) => e.kind === "calls" || e.kind === "references",
		).length;
		scored.push({ name: node.qualifiedName ?? node.symbolName, refs });
	}
	scored.sort((a, b) => b.refs - a.refs);
	const top = scored.slice(0, 3).filter((s) => s.refs > 0);
	return top.length > 0 ? top.map((s) => s.name).join(", ") : undefined;
}

async function computeHubs(
	graph: ReviewGraph,
	degrees: FileDegrees,
	cwd: string,
	limit: number,
	focusTerms: string[],
): Promise<ProjectReportHub[]> {
	const { computeTransitiveImpact } = await import("./review-graph/query.js");
	const ranked = [...graph.fileNodes.entries()]
		.map(([filePath, fileNodeId]) => ({
			filePath,
			fileNodeId,
			fanIn: degrees.fanIn.get(fileNodeId)?.size ?? 0,
		}))
		.filter((f) => f.fanIn > 0)
		.sort((a, b) => {
			const focusDelta =
				focusScore(a.filePath, focusTerms) - focusScore(b.filePath, focusTerms);
			if (focusDelta !== 0) return -focusDelta;
			return b.fanIn - a.fanIn || a.filePath.localeCompare(b.filePath);
		})
		.slice(0, limit);

	return ranked.map((f) => {
		const impact = computeTransitiveImpact(graph, f.filePath, { maxDepth: 3 });
		const display = toDisplayPath(f.filePath, cwd);
		return {
			file: display,
			fanIn: f.fanIn,
			blastRadius: impact.hits.length,
			role: roleFor(graph, f.filePath),
			suggestedNext: suggestedNext(display),
		};
	});
}

// --- section 3: entry points ---------------------------------------------------

function computeEntryPoints(
	graph: ReviewGraph,
	degrees: FileDegrees,
	cwd: string,
	limit: number,
	focusTerms: string[],
): { entryPoints: ProjectReportEntryPoint[]; entryPointFiles: Set<string> } {
	const candidates = [...graph.fileNodes.entries()]
		.map(([filePath, fileNodeId]) => ({
			filePath,
			fanIn: degrees.fanIn.get(fileNodeId)?.size ?? 0,
			fanOut: degrees.fanOut.get(fileNodeId)?.size ?? 0,
		}))
		.filter((f) => f.fanIn === 0 && f.fanOut > 0)
		.sort((a, b) => {
			const focusDelta =
				focusScore(a.filePath, focusTerms) - focusScore(b.filePath, focusTerms);
			if (focusDelta !== 0) return -focusDelta;
			return b.fanOut - a.fanOut || a.filePath.localeCompare(b.filePath);
		});

	// The exclusion set for dead weight is UNCAPPED (#773: "zero-importer files
	// that aren't entry points") — an entry-point-like file past the display
	// cap must not be reclassified as suspected dead weight.
	const entryPointFiles = new Set(candidates.map((c) => c.filePath));
	const entryPoints = candidates.slice(0, limit).map((f) => {
		const display = toDisplayPath(f.filePath, cwd);
		return {
			file: display,
			fanIn: f.fanIn,
			fanOut: f.fanOut,
			suggestedNext: suggestedNext(display),
		};
	});
	return { entryPoints, entryPointFiles };
}

// --- section 4: subsystem map (directory-level aggregation) -------------------

// Depth heuristic (#773): first path segment under the project root by
// default; collapse to a deeper (two-segment) cluster only for files under a
// segment that dominates the covered file set (so a monorepo's one giant
// top-level dir still gets useful sub-clustering instead of one blob node).
const DOMINANCE_THRESHOLD = 0.4;

function directoryClusters(
	filePaths: string[],
	cwd: string,
): Map<string, string> {
	const segmentsOf = (filePath: string) =>
		toDisplayPath(filePath, cwd).split("/").filter(Boolean);
	const topCounts = new Map<string, number>();
	const perFileSegments = new Map<string, string[]>();
	for (const filePath of filePaths) {
		const segments = segmentsOf(filePath);
		perFileSegments.set(filePath, segments);
		const top = segments.length > 1 ? segments[0] : "(root)";
		topCounts.set(top, (topCounts.get(top) ?? 0) + 1);
	}
	const total = filePaths.length || 1;
	const dominant = new Set(
		[...topCounts.entries()]
			.filter(([, count]) => count / total >= DOMINANCE_THRESHOLD)
			.map(([seg]) => seg),
	);
	const clusterOf = new Map<string, string>();
	for (const filePath of filePaths) {
		const segments = perFileSegments.get(filePath) ?? [];
		if (segments.length <= 1) {
			clusterOf.set(filePath, "(root)");
			continue;
		}
		const top = segments[0];
		if (dominant.has(top) && segments.length > 2) {
			clusterOf.set(filePath, `${segments[0]}/${segments[1]}`);
		} else {
			clusterOf.set(filePath, top);
		}
	}
	return clusterOf;
}

// Tarjan SCC over the (small, directory-granularity) cluster graph — finds
// every strongly-connected component, i.e. every directory-level import cycle.
function tarjanSCCs(
	nodes: string[],
	adjacency: Map<string, Set<string>>,
): string[][] {
	let index = 0;
	const indices = new Map<string, number>();
	const lowlink = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const sccs: string[][] = [];

	function strongConnect(v: string) {
		indices.set(v, index);
		lowlink.set(v, index);
		index += 1;
		stack.push(v);
		onStack.add(v);
		for (const w of adjacency.get(v) ?? []) {
			if (!indices.has(w)) {
				strongConnect(w);
				lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
			} else if (onStack.has(w)) {
				lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
			}
		}
		if (lowlink.get(v) === indices.get(v)) {
			const scc: string[] = [];
			let w: string;
			do {
				w = stack.pop()!;
				onStack.delete(w);
				scc.push(w);
			} while (w !== v);
			sccs.push(scc);
		}
	}

	for (const v of nodes) {
		if (!indices.has(v)) strongConnect(v);
	}
	return sccs;
}

function computeSubsystems(
	graph: ReviewGraph,
	cwd: string,
	limit: number,
): SubsystemMap {
	const filePaths = [...graph.fileNodes.keys()];
	const clusterOf = directoryClusters(filePaths, cwd);
	const fileNodeIdToCluster = new Map<string, string>();
	for (const [filePath, nodeId] of graph.fileNodes) {
		const cluster = clusterOf.get(filePath);
		if (cluster) fileNodeIdToCluster.set(nodeId, cluster);
	}

	const edgeCounts = new Map<string, number>(); // "from|to" -> count
	for (const edge of graph.edges) {
		if (edge.kind !== "imports") continue;
		const fromCluster = fileNodeIdToCluster.get(edge.from);
		const toCluster = fileNodeIdToCluster.get(edge.to);
		if (!fromCluster || !toCluster || fromCluster === toCluster) continue;
		const key = `${fromCluster}|${toCluster}`;
		edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
	}

	const directories = [...new Set(clusterOf.values())].sort((a, b) =>
		a.localeCompare(b),
	);
	const edges: DirectoryEdge[] = [...edgeCounts.entries()]
		.map(([key, count]) => {
			const [from, to] = key.split("|");
			return { from, to, count };
		})
		.sort((a, b) => b.count - a.count || a.from.localeCompare(b.from));

	// Layering violations: for each unordered pair with edges both ways, the
	// minority direction is the violation candidate (#773). Ties (equal counts,
	// genuinely ambiguous "dominant direction") are skipped rather than guessed.
	const seenPairs = new Set<string>();
	const violations: LayeringViolation[] = [];
	for (const edge of edges) {
		const pairKey = [edge.from, edge.to]
			.sort((a, b) => a.localeCompare(b))
			.join("|");
		if (seenPairs.has(pairKey)) continue;
		const reverseKey = `${edge.to}|${edge.from}`;
		const reverseCount = edgeCounts.get(reverseKey);
		if (reverseCount === undefined || reverseCount === edge.count) continue;
		seenPairs.add(pairKey);
		if (edge.count < reverseCount) {
			violations.push({
				from: edge.from,
				to: edge.to,
				count: edge.count,
				dominantCount: reverseCount,
			});
		} else {
			violations.push({
				from: edge.to,
				to: edge.from,
				count: reverseCount,
				dominantCount: edge.count,
			});
		}
	}
	violations.sort((a, b) => b.count - a.count || a.from.localeCompare(b.from));

	const adjacency = new Map<string, Set<string>>();
	for (const dir of directories) adjacency.set(dir, new Set());
	for (const edge of edges) {
		adjacency.get(edge.from)?.add(edge.to);
	}
	const sccs = tarjanSCCs(directories, adjacency).filter(
		(scc) => scc.length > 1,
	);
	const cycles: DirectoryCycle[] = sccs
		.map((scc) => {
			const members = new Set(scc);
			let edgeCount = 0;
			for (const edge of edges) {
				if (members.has(edge.from) && members.has(edge.to))
					edgeCount += edge.count;
			}
			return { dirs: [...scc].sort((a, b) => a.localeCompare(b)), edgeCount };
		})
		.sort((a, b) => b.edgeCount - a.edgeCount);

	return {
		directories,
		edges: edges.slice(0, limit),
		cycles: cycles.slice(0, limit),
		violations: violations.slice(0, limit),
	};
}

// --- section 5: risk hotspots ---------------------------------------------------

function computeRiskHotspots(
	graph: ReviewGraph,
	degrees: FileDegrees,
	cwd: string,
	limit: number,
	focusTerms: string[],
): RiskHotspot[] {
	const ranked = [...graph.fileNodes.entries()]
		.map(([filePath, fileNodeId]) => {
			const symbolIds = graph.symbolNodesByFile.get(filePath) ?? [];
			let maxComplexity = 0;
			for (const symbolId of symbolIds) {
				const complexity =
					graph.nodes.get(symbolId)?.metadata?.cyclomaticComplexity;
				if (typeof complexity === "number" && complexity > maxComplexity) {
					maxComplexity = complexity;
				}
			}
			const fanIn = degrees.fanIn.get(fileNodeId)?.size ?? 0;
			return { filePath, fanIn, maxComplexity, score: fanIn * maxComplexity };
		})
		.filter((f) => f.score > 0)
		.sort((a, b) => {
			const focusDelta =
				focusScore(a.filePath, focusTerms) - focusScore(b.filePath, focusTerms);
			if (focusDelta !== 0) return -focusDelta;
			return b.score - a.score || a.filePath.localeCompare(b.filePath);
		})
		.slice(0, limit);

	return ranked.map((f) => {
		const display = toDisplayPath(f.filePath, cwd);
		return {
			file: display,
			fanIn: f.fanIn,
			maxComplexity: f.maxComplexity,
			score: f.score,
			suggestedNext: suggestedNext(display),
		};
	});
}

// --- section 6: suspected dead weight --------------------------------------------

function computeDeadWeight(
	graph: ReviewGraph,
	degrees: FileDegrees,
	entryPointFiles: Set<string>,
	cwd: string,
	limit: number,
): { files: DeadWeightFile[]; disclaimer: string } {
	const candidates = [...graph.fileNodes.entries()]
		.filter(([filePath, nodeId]) => {
			if (entryPointFiles.has(filePath)) return false;
			const fanIn = degrees.fanIn.get(nodeId)?.size ?? 0;
			return fanIn === 0;
		})
		.map(([filePath, fileNodeId]) => ({
			filePath,
			fanOut: degrees.fanOut.get(fileNodeId)?.size ?? 0,
		}))
		// Truly-isolated files (zero fan-in AND zero fan-out) first — the
		// highest-confidence dead weight — then rising fan-out.
		.sort((a, b) => a.fanOut - b.fanOut || a.filePath.localeCompare(b.filePath))
		.slice(0, limit);

	return {
		files: candidates.map((f) => {
			const display = toDisplayPath(f.filePath, cwd);
			return { file: display, suggestedNext: suggestedNext(display) };
		}),
		disclaimer: DEAD_WEIGHT_DISCLAIMER,
	};
}

// --- cold-path background build (mirrors word-index.ts's #348 pattern) --------

const inFlightGraphBuilds = new Set<string>();

/** Test-only: reset the in-flight-build guard between test files/cases. */
export function _resetProjectReportBuildGuardForTests(): void {
	inFlightGraphBuilds.clear();
}

/**
 * What the cold-path trigger actually did, so the hint can say it honestly
 * (#1962). "started" means THIS call began a build; "already_running" means a
 * build for the same workspace was already in flight and absorbed the call.
 * Before #1962 the caller only knew whether it had added a key to
 * `inFlightGraphBuilds`, and reported "a retry was started" on the strength of
 * that — while the builder's dedupe cache returned a settled promise and no
 * build ran at all.
 */
type BackgroundBuildTrigger = "started" | "already_running";

/**
 * The builder entry points the trigger needs, taken from the module's own
 * types rather than re-declared here, so a signature change cannot drift past
 * this call site. `projectReport` already imports the builder dynamically (to
 * keep the module graph acyclic) and hands the pair in.
 */
type BackgroundBuildDeps = Pick<
	typeof import("./review-graph/builder.js"),
	"buildOrUpdateGraph" | "isGraphBuildInFlight"
> & { FactStore: new () => FactStore };

function triggerBackgroundGraphBuild(
	cwd: string,
	deps: BackgroundBuildDeps,
): BackgroundBuildTrigger {
	const key = normalizeMapKey(path.resolve(cwd));
	if (inFlightGraphBuilds.has(key)) return "already_running";
	// Ask the builder, not just this module's own guard: a build kicked off by
	// the edit pipeline or another reader never touches `inFlightGraphBuilds`.
	// The probe and the call are in ONE synchronous block on purpose — awaiting
	// between them (the pre-#1962 dynamic imports did) reopens the race.
	const deduped = deps.isGraphBuildInFlight(key, []);
	inFlightGraphBuilds.add(key);
	const build = deps
		.buildOrUpdateGraph(key, [], new deps.FactStore())
		.catch(() => {
			// buildOrUpdateGraph records the durable failure and surfaced status.
		});
	void build.finally(() => inFlightGraphBuilds.delete(key));
	return deduped ? "already_running" : "started";
}

// --- entry point ---------------------------------------------------------------

/**
 * Project-level orientation report (#773), read-only over the cached review
 * graph. Returns `available: false` on a cold cache and kicks off a background
 * build (never blocking this call) — see module-level doc comment.
 */
export async function projectReport(
	cwd: string,
	options?: ProjectReportOptions,
): Promise<ProjectReport> {
	const limit = clampLimit(options?.limit);
	const focusTerms = normalizeFocus(options?.focus);
	const view = options?.view;

	const {
		getCachedReviewGraph,
		getReviewGraphSizeSkipVerdict,
		getLastReviewGraphBuildAttempt,
		buildOrUpdateGraph,
		isGraphBuildInFlight,
		getReviewGraphRevisionDrift,
	} = await import("./review-graph/builder.js");
	let graph: ReviewGraph | undefined;
	try {
		graph = getCachedReviewGraph(cwd);
	} catch {
		graph = undefined;
	}

	if (!graph) {
		// #782: a fresh size-skip verdict means the graph will never build at the
		// CURRENT cap — retrying "shortly" is actively wrong guidance here, so
		// this branches before the generic cold-cache hint (and skips kicking off
		// another background build that would just re-hit the same cap).
		let sizeSkip: ReturnType<typeof getReviewGraphSizeSkipVerdict>;
		try {
			sizeSkip = getReviewGraphSizeSkipVerdict(cwd);
		} catch {
			sizeSkip = undefined;
		}
		if (sizeSkip) {
			const lastBuildAttempt = getLastReviewGraphBuildAttempt(cwd);
			return {
				available: false,
				hint:
					`review graph disabled: project has more than ${sizeSkip.maxFileCount} files ` +
					`(cap ${sizeSkip.maxFileCount}) — raise maxProjectFiles in .pi-lens.json ` +
					"or set PI_LENS_REVIEW_GRAPH_MAX_FILES; for CI/cron, run " +
					"npx pi-lens build-graph after configuring the cap",
				...(lastBuildAttempt ? { lastBuildAttempt } : {}),
				...(view ? { view } : {}),
			};
		}
		const previousAttempt = getLastReviewGraphBuildAttempt(cwd);
		const { FactStore } = await import("./dispatch/fact-store.js");
		const trigger = triggerBackgroundGraphBuild(cwd, {
			buildOrUpdateGraph,
			isGraphBuildInFlight,
			FactStore,
		});
		const started = trigger === "started";
		// #1962: report the attempt that is CURRENT. When this call started a
		// build, `buildOrUpdateGraph` has already recorded a fresh `running`
		// attempt synchronously, and the previous outcome belongs in the hint
		// text, not in a field labelled "last attempt". When no build started,
		// the earlier attempt genuinely IS the current one.
		const lastBuildAttempt = started
			? (getLastReviewGraphBuildAttempt(cwd) ?? previousAttempt)
			: previousAttempt;
		// A terminal previous outcome is the useful half of the message: it says
		// WHY the graph is missing. It is prefixed to whichever verdict follows,
		// rather than selecting between two parallel sentence pairs — the first
		// version of this branch did that, and its terminal-plus-deduped arm was
		// unreachable (#1962 review F1). A pending build always records a
		// `running` attempt synchronously, so "terminal" and "not started" cannot
		// both hold for the same key.
		const terminal =
			previousAttempt?.outcome === "failed" ||
			previousAttempt?.outcome === "skipped";
		const cause = terminal
			? `Review graph unavailable: ${previousAttempt?.reason ?? previousAttempt?.outcome}. `
			: "";
		return {
			available: false,
			hint: started
				? terminal
					? `${cause}A retry was started.`
					: "No review graph cached for this workspace yet — a build was kicked off in the background; retry this call shortly."
				: `${cause}A build is already running for this workspace; retry this call shortly.`,
			...(lastBuildAttempt ? { lastBuildAttempt } : {}),
			...(view ? { view } : {}),
		};
	}

	const degrees = buildFileDegrees(graph);
	// Computed on THIS render, from the workspace entry's stamped commit and the
	// worktree's HEAD right now — never from a value cached beside the graph.
	const trust = computeTrust(graph, cwd, getReviewGraphRevisionDrift(cwd));
	const hubs = await computeHubs(graph, degrees, cwd, limit, focusTerms);
	const { entryPoints, entryPointFiles } = computeEntryPoints(
		graph,
		degrees,
		cwd,
		limit,
		focusTerms,
	);
	const subsystems = computeSubsystems(graph, cwd, limit);
	const riskHotspots = computeRiskHotspots(
		graph,
		degrees,
		cwd,
		limit,
		focusTerms,
	);
	const deadWeight = computeDeadWeight(
		graph,
		degrees,
		entryPointFiles,
		cwd,
		limit,
	);
	const lastBuildAttempt = getLastReviewGraphBuildAttempt(cwd);

	return {
		available: true,
		...(lastBuildAttempt ? { lastBuildAttempt } : {}),
		...(view ? { view } : {}),
		trust,
		hubs,
		entryPoints,
		subsystems,
		riskHotspots,
		deadWeight,
	};
}

// --- compact (line-oriented text) rendering -------------------------------------

function fmtPct(n: number): string {
	return `${Math.round(n * 100)}%`;
}

/**
 * Render a ProjectReport as line-oriented text (mirrors
 * renderCompactModuleReport's convention) — cheapest option, one line per
 * ranked item instead of a repeated-keys JSON object.
 */
export function renderCompactProjectReport(report: ProjectReport): string {
	if (!report.available) {
		return `project_report — unavailable${report.hint ? `: ${report.hint}` : ""}`;
	}
	const lines: string[] = [];
	// #919: an available graph whose persist failed serves this process fine
	// but leaves the NEXT session cold — compact view must say so, not only
	// the JSON view.
	if (report.lastBuildAttempt?.reason) {
		lines.push(`! build: ${report.lastBuildAttempt.reason}`);
	}
	const t = report.trust;
	if (t) {
		lines.push(
			`TRUST: built ${t.graphBuiltAt} — ${t.filesCovered}/${t.filesTotal} files (${fmtPct(t.coverage)} coverage)` +
				(t.resolution.sampleSize > 0
					? ` — resolution: exact ${fmtPct(t.resolution.exact)}, import ${fmtPct(t.resolution.import)}, receiver-type ${fmtPct(t.resolution.receiverType)}, name-only ${fmtPct(t.resolution.nameOnly)}`
					: " — no resolution-tagged edges yet"),
		);
		for (const note of t.notes) lines.push(`  ! ${note}`);
	}
	if (report.hubs?.length) {
		lines.push("HUBS:");
		for (const h of report.hubs) {
			const role = h.role ? ` — ${h.role}` : "";
			lines.push(
				`  ${h.file}${role}; ${h.fanIn} importer(s), blastRadius ${h.blastRadius}`,
			);
		}
	}
	if (report.entryPoints?.length) {
		lines.push("ENTRY POINTS:");
		for (const e of report.entryPoints) {
			lines.push(`  ${e.file}; fan-out ${e.fanOut}`);
		}
	}
	if (report.subsystems) {
		const s = report.subsystems;
		lines.push(
			`SUBSYSTEMS: ${s.directories.length} directories, ${s.edges.length} cross-dir edge group(s)`,
		);
		if (s.cycles.length > 0) {
			lines.push("  CYCLES:");
			for (const c of s.cycles) {
				lines.push(`    ${c.dirs.join(" <-> ")} (${c.edgeCount} edges)`);
			}
		}
		if (s.violations.length > 0) {
			lines.push("  LAYERING VIOLATIONS:");
			for (const v of s.violations) {
				lines.push(
					`    ${v.from} -> ${v.to} (${v.count} edge(s), against the dominant ${v.to} -> ${v.from} direction, ${v.dominantCount} edge(s))`,
				);
			}
		}
	}
	if (report.riskHotspots?.length) {
		lines.push("RISK HOTSPOTS:");
		for (const r of report.riskHotspots) {
			lines.push(
				`  ${r.file}; fan-in ${r.fanIn} × max complexity ${r.maxComplexity} = ${r.score}`,
			);
		}
	}
	if (report.deadWeight) {
		lines.push(`DEAD WEIGHT (${report.deadWeight.disclaimer}):`);
		for (const d of report.deadWeight.files) {
			lines.push(`  ${d.file}`);
		}
		if (report.deadWeight.files.length === 0) lines.push("  (none found)");
	}
	return lines.join("\n");
}
