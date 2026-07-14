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
import {
	getResourceFootprint as getResourceFootprintSnapshot,
	type ResourceFootprint,
} from "./instance-registry.js";
import { initLSPConfig } from "./lsp/config.js";
import { getLSPService } from "./lsp/index.js";
import { getOrLoadWarmWordIndex } from "./mcp/analyze.js";
import { scanProjectDiagnostics } from "./project-diagnostics/scanner.js";
import type { ProjectDiagnosticsSnapshot } from "./project-diagnostics/types.js";
import * as path from "node:path";
import { normalizeMapKey } from "./path-utils.js";
import { loadProjectSnapshot } from "./project-snapshot.js";
import {
	centralityFromReverseDeps,
	deserializeWordIndex,
	type RankedFile,
	searchWordIndex,
	triggerBackgroundWordIndexBuild,
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
	readEnclosing,
	type ReadEnclosingOptions,
	type ReadEnclosingResult,
	readSymbol,
	type ReadSymbolResult,
	type RecommendedRead,
	renderCompactModuleReport,
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

export type { ResourceFootprint } from "./instance-registry.js";

/**
 * #620: total CPU/RAM footprint attributable to pi-lens across every process
 * it owns — every registered instance's host, plus that instance's live LSP
 * children. Reads the machine-global `~/.pi-lens/instances.json` registry, so
 * this answers across ALL concurrent pi-lens sessions/worktrees on the box,
 * not just this one. Best-effort: reflects whatever heartbeats have landed so
 * far — a stale-heartbeat instance simply reports its last-sampled numbers.
 */
export function resourceFootprint(): Promise<ResourceFootprint> {
	return getResourceFootprintSnapshot();
}

/** Slimmed wire shape (#517 conformity): `startLine`/`endLine` mark the hit's
 * best-matching line (`lines[0]`, the file's own best-scoring identifier hit);
 * a single-line span rather than a fabricated whole-file range, since the word
 * index tracks scattered per-line matches, not a symbol span. Read derivation:
 * offset=startLine, limit=endLine-startLine+1 for a one-line peek — prefer
 * module_report on `file` for the real outline. No per-hit `read` block, no
 * repeated raw `lines[]` array on the wire. */
export interface SymbolSearchHit {
	file: string;
	score: number;
	hits: number;
	startLine: number;
	endLine: number;
}

export interface SymbolSearchResult {
	/** False when no word index has been built/persisted for this workspace yet. */
	available: boolean;
	query: string;
	results: SymbolSearchHit[];
	/** Actionable guidance when `available` is false (#348 decision 3): the
	 * index build was kicked off in the background (deduped per cwd), never
	 * blocking this call — retry shortly. */
	hint?: string;
	/**
	 * ISO timestamp the persisted project snapshot (`ProjectSnapshot.generatedAt`)
	 * was last written — the snapshot backs BOTH the word index this search ranks
	 * over and the `reverseDeps` centrality boost. Present whenever `available` is
	 * true. Additive (#536): an MCP adapter uses this to compute a staleness hint;
	 * omitted (not surfaced) on the pi tool surface, whose index is per-edit warm.
	 */
	snapshotGeneratedAt?: string;
}

function toSymbolSearchHit(result: RankedFile): SymbolSearchHit {
	const line = result.lines[0] ?? 1;
	return {
		file: result.file,
		score: result.score,
		hits: result.hits,
		startLine: line,
		endLine: line,
	};
}

/**
 * Ranked identifier search over the persisted word index (#162). Mostly
 * stateless: loads the index from the project snapshot (built by the session
 * scan, in either the pi extension or the MCP session), so it works without a
 * warm runtime. Returns `available: false` when no index exists yet — and
 * kicks off a single bounded background build for this workspace (deduped per
 * cwd, never blocking this call) so a retry shortly after succeeds (#348
 * decision 3).
 *
 * #536 rider: prefers the warm in-memory index (`getOrLoadWarmWordIndex`,
 * clients/mcp/analyze.ts) over a fresh disk read when one exists for this
 * cwd — a warm `pilens_analyze` call updates that live copy synchronously but
 * persists it to disk on a debounce (default 1500ms), so without this a query
 * immediately following an analyze in the SAME process would read stale
 * on-disk state until the debounce flushes. Falls back to the stateless disk
 * read exactly as before when no warm copy is cached (nothing has called
 * pilens_analyze yet this process, or #348 phase 2's forward-index isn't
 * available) — this function's public contract (available/hint/results shape)
 * is unchanged either way.
 */
export function symbolSearch(
	query: string,
	cwd: string,
	limit = 20,
): SymbolSearchResult {
	const snapshot = loadProjectSnapshot(cwd);
	const index = getOrLoadWarmWordIndex(cwd) ?? deserializeWordIndex(snapshot?.wordIndex);
	if (!index) {
		triggerBackgroundWordIndexBuild(cwd);
		return {
			available: false,
			query,
			results: [],
			hint: "Word index is building in the background for this workspace — retry this query shortly.",
		};
	}
	// Boost well-connected files using the snapshot's reverse-dependency
	// (importedBy) counts; snapshot keys are normalized, index keys are raw.
	const centrality = centralityFromReverseDeps(
		index,
		snapshot?.reverseDeps,
		(file) => normalizeMapKey(path.resolve(file)),
	);
	const results = searchWordIndex(index, query, { limit, centrality });
	return {
		available: true,
		query,
		results: results.map(toSymbolSearchHit),
		snapshotGeneratedAt: snapshot?.generatedAt,
	};
}

// symbolImpact was removed (#304 follow-up): the transitive blast radius is now
// served by module_report's `blastRadius` option (clients/module-report.ts), which
// calls computeTransitiveImpact (review-graph/query.ts) directly over the cached
// graph. No engine wrapper is needed.
