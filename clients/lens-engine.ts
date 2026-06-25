/**
 * LensEngine — the single internal-facing seam for pi-lens host adapters.
 *
 * The maintainability rule: host adapters (the MCP server today; index.ts can
 * adopt incrementally) talk ONLY to this module, never reaching into pi-lens
 * internals directly. So when an internal API is refactored, the break surfaces
 * HERE (one file, TypeScript-loud), not scattered across the adapter. New
 * mirrored capabilities (cascade, call-graph, …) get a method here and the
 * adapter just routes to it — coupling stays capped at this interface instead of
 * growing per tool.
 *
 * It re-exports the per-concern facades (analyze / review / session / ipc) and
 * adds thin wrappers over the remaining internal reach-ins (latency, project
 * scan, LSP status, diagnostic stats, LSP config).
 */

import { getDiagnosticTracker } from "./diagnostic-tracker.js";
import {
	type DispatchLatencyReport,
	getLatencyReports,
} from "./dispatch/integration.js";
import { initLSPConfig } from "./lsp/config.js";
import { getLSPService } from "./lsp/index.js";
import { scanProjectDiagnostics } from "./project-diagnostics/scanner.js";
import type { ProjectDiagnosticsSnapshot } from "./project-diagnostics/types.js";
import type { ImpactHit } from "./review-graph/query.js";
import type { ReviewGraphEdgeKind } from "./review-graph/types.js";
import * as path from "node:path";
import { normalizeMapKey } from "./path-utils.js";
import { loadProjectSnapshot } from "./project-snapshot.js";
import {
	centralityFromReverseDeps,
	deserializeWordIndex,
	type RankedFile,
	searchWordIndex,
} from "./word-index.js";

// --- Facades (re-exported so adapters import only this module) ---------------

export {
	analyzeFile,
	type AnalyzeFileOptions,
	type McpAnalyzeResult,
} from "./mcp/analyze.js";
export { createMcpHost } from "./mcp/host-shim.js";
export {
	ipcPathForCwd,
	requestWarmAnalyze,
	type WarmAnalyzeRequest,
} from "./mcp/ipc.js";
export {
	analyzeFileFresh,
	resolveRebuildScript,
	runRebuild,
	type ScanDiagnostic,
	summarizeScan,
} from "./mcp/review.js";
export {
	runSessionStart,
	runTurnEnd,
	type SessionStartOutcome,
	type TurnEndOutcome,
} from "./mcp/session.js";
export {
	moduleReport,
	type ModuleReport,
	type ModuleReportOptions,
	type ModuleSymbolEntry,
	readSymbol,
	type ReadSymbolResult,
	type RecommendedRead,
} from "./module-report.js";

// --- Query wrappers (own the remaining internal reach-ins) -------------------

/** Recent dispatch latency reports (latency.log schema), newest first. */
export function recentLatency(
	limit = 5,
	fileFilter?: string,
): DispatchLatencyReport[] {
	let reports = getLatencyReports();
	if (fileFilter) {
		const needle = fileFilter.replace(/\\/g, "/");
		reports = reports.filter((report) =>
			report.filePath.replace(/\\/g, "/").endsWith(needle),
		);
	}
	return reports.slice(-limit).reverse();
}

/** Cheap project-wide scan (tree-sitter + fact rules). */
export function projectScan(
	cwd: string,
	maxFiles?: number,
): Promise<ProjectDiagnosticsSnapshot> {
	return scanProjectDiagnostics({ cwd, tier: "cheap", maxFiles });
}

export interface LspStatus {
	aliveClients: number;
	servers: Array<{ serverId: string; root: string; connected: boolean }>;
}

/** Alive LSP client count + per-server status. */
export function lspStatus(): LspStatus {
	const lsp = getLSPService();
	return { aliveClients: lsp.getAliveClientCount(), servers: lsp.getStatus() };
}

/** Session diagnostic counters (shown / auto-fixed / unresolved …). */
export function diagnosticStats(): ReturnType<
	ReturnType<typeof getDiagnosticTracker>["getStats"]
> {
	return getDiagnosticTracker().getStats();
}

/** Initialise LSP config for a workspace (idempotent at the LSP layer). */
export function ensureLspConfig(cwd: string): Promise<void> {
	return initLSPConfig(cwd);
}

export interface SymbolSearchResult {
	/** False when no word index has been built/persisted for this workspace yet. */
	available: boolean;
	query: string;
	results: RankedFile[];
}

/**
 * Ranked identifier search over the persisted word index (#162). Stateless:
 * loads the index from the project snapshot (built by the session scan, in
 * either the pi extension or the MCP session), so it works without a warm
 * runtime. Returns `available: false` when no index exists yet.
 */
export function symbolSearch(
	query: string,
	cwd: string,
	limit = 20,
): SymbolSearchResult {
	const snapshot = loadProjectSnapshot(cwd);
	const index = deserializeWordIndex(snapshot?.wordIndex);
	if (!index) return { available: false, query, results: [] };
	// Boost well-connected files using the snapshot's reverse-dependency
	// (importedBy) counts; snapshot keys are normalized, index keys are raw.
	const centrality = centralityFromReverseDeps(
		index,
		snapshot?.reverseDeps,
		(file) => normalizeMapKey(path.resolve(file)),
	);
	return {
		available: true,
		query,
		results: searchWordIndex(index, query, { limit, centrality }),
	};
}

export interface SymbolImpactResult {
	/** False when the review graph is empty (no session scan has run). */
	available: boolean;
	seedFile: string;
	hits: ImpactHit[];
	truncated: boolean;
	maxDepthReached: number;
}

/**
 * Transitive, depth-bounded impact of a file ("what depends on this") over the
 * review graph's call/reference/import edges (#162). READ-ONLY (#260): consumes
 * the already-cached review graph and walks incoming edges — never builds one
 * (cold cache → available:false). The `module_report` blast-radius section (#304)
 * is the agent-facing surface for this; this engine helper is kept as a reusable
 * read-only seam.
 */
export async function symbolImpact(
	file: string,
	cwd: string,
	options?: {
		maxDepth?: number;
		relations?: ReviewGraphEdgeKind[];
		maxHits?: number;
	},
): Promise<SymbolImpactResult> {
	// READ-ONLY (#260): consume the already-built review graph, never build one.
	// buildOrUpdateGraph(cwd, [], freshFactStore) defeats the incremental path
	// (empty changedFiles → Tier-3 full rebuild on any drift) and races the edit
	// pipeline's build under a separate _buildCache key — an OOM vector. Cold
	// cache → available:false until a scan/edit warms it (same contract as
	// module_report, #256).
	const { getCachedReviewGraph } = await import("./review-graph/builder.js");
	const { computeTransitiveImpact } = await import("./review-graph/query.js");
	const graph = getCachedReviewGraph(cwd);
	if (!graph) {
		return {
			available: false,
			seedFile: path.resolve(cwd, file),
			hits: [],
			truncated: false,
			maxDepthReached: 0,
		};
	}
	const result = computeTransitiveImpact(
		graph,
		path.resolve(cwd, file),
		options,
	);
	return { available: graph.nodes.size > 0, ...result };
}
