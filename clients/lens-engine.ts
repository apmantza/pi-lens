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

import * as path from "node:path";
import { minimatch } from "./deps/minimatch.js";
import { getDiagnosticTracker } from "./diagnostic-tracker.js";
import { applyPushedFindingPolicyByFile } from "./dispatch/finding-policy.js";
import {
	type DispatchLatencyReport,
	getLatencyReports,
} from "./dispatch/integration.js";
import {
	getResourceFootprint as getResourceFootprintSnapshot,
	type ResourceFootprint,
} from "./instance-registry.js";
import { extensionsForLanguageToken } from "./language-registry.js";
import { initLSPConfig } from "./lsp/config.js";
import { getLSPService } from "./lsp/capabilities.js";
import { acquireWarmWordIndex } from "./mcp/analyze.js";
import { normalizeMapKey, relativeInside, toPosix } from "./path-utils.js";
import { scanProjectDiagnostics } from "./project-diagnostics/scanner.js";
import type { ProjectDiagnosticsSnapshot } from "./project-diagnostics/types.js";
import { loadProjectSnapshotWithoutWordIndex } from "./project-snapshot.js";
import { resolveLensToolName, type LensToolHost } from "./tool-config.js";
import type { ReviewGraph } from "./review-graph/types.js";
import {
	getTreeSitterRuntimeStatus,
	type TreeSitterRuntimeStatus,
} from "./tree-sitter-shared.js";
import {
	centralityFromReverseDeps,
	getWordIndexBuildStatus,
	type RankedFile,
	searchWordIndex,
	triggerBackgroundWordIndexBuild,
} from "./word-index.js";

// --- Facades (re-exported so adapters import only this module) ---------------

export { analyzeFile, type McpAnalyzeResult } from "./mcp/analyze.js";
export { createMcpHost } from "./mcp/host-shim.js";
export {
	createWarmIpcLineReader,
	createWarmIpcRequestQueue,
	ipcPathForCwd,
	readTurnEndStatus,
	unlinkStaleUnixSocket,
	WARM_TURN_END_SCHEMA_VERSION,
	type WarmAnalyzeRequest,
	type WarmTurnEndRequest,
	type WarmTurnEndResponse,
} from "./mcp/ipc.js";
export {
	analyzeFileFresh,
	canRebuildPiLens,
	resolveRebuildScript,
	runRebuild,
	summarizeScan,
} from "./mcp/review.js";
export {
	acknowledgeTurnEnd,
	runSessionStart,
	runTurnEnd,
	runTurnEndForIpc,
} from "./mcp/session.js";
export {
	moduleReport,
	readEnclosing,
	readSymbol,
	renderCompactModuleReport,
} from "./module-report.js";
export {
	type ProjectReport,
	projectReport,
	renderCompactProjectReport,
} from "./project-report.js";
// Effective-config introspection (#2427). A facade rather than a wrapper for
// the same reason the others are: the computation reaches into the config
// resolution, the LSP registry and the dispatch plan at once, and putting that
// composition here would make this file the fourth place that knows how a
// server is selected. Adapters route to it; nobody re-derives it.
export {
	effectiveConfig,
	type EffectiveConfigView,
	type EffectiveFileView,
	type EffectiveServerDecision,
	isEffectiveFileViewError,
} from "./effective-config.js";

// --- Query wrappers (own the remaining internal reach-ins) -------------------

/** Recent dispatch latency reports (latency.log schema), newest first. */
export function recentLatency(
	limit = 5,
	fileFilter?: string,
): DispatchLatencyReport[] {
	let reports = getLatencyReports();
	if (fileFilter) {
		const needle = toPosix(fileFilter);
		reports = reports.filter((report) =>
			toPosix(report.filePath).endsWith(needle),
		);
	}
	return reports.slice(-limit).reverse();
}

/**
 * Cheap project-wide scan (tree-sitter + fact rules).
 *
 * `includeGenerated` (#1107 phase 2 review): scan WITHOUT the generated/
 * artifact NAME-heuristic filter — the actionable opt-out
 * `generatedSkipNotice` below points a user at. Default `false` (existing
 * filtering behavior unchanged).
 *
 * #1634: the returned rows have passed the finding policy (stored
 * dispositions, `.pi-lens.json` rule policy, inline `pi-lens-ignore`) every
 * other agent-facing surface applies, and `dispositionSuppressed` counts what
 * it dropped. The persisted snapshot stays raw: each reader filters it.
 */
export async function projectScan(
	cwd: string,
	maxFiles?: number,
	includeGenerated?: boolean,
): Promise<ProjectDiagnosticsSnapshot & { dispositionSuppressed: number }> {
	const scan = await scanProjectDiagnostics({
		cwd,
		tier: "cheap",
		maxFiles,
		includeGenerated,
	});
	const policy = applyPushedFindingPolicyByFile(scan.diagnostics, cwd);
	return {
		...scan,
		diagnostics: policy.kept,
		dispositionSuppressed: policy.suppressed,
	};
}

/**
 * #784: `scanTruncated` (#760) reaches this seam intact but, until now, no
 * caller rendered it — a capped scan read as a complete clean sweep to the
 * agent/user. One shared, unit-testable line adapters can append to their
 * rendered summary, matching the #777 warm-skip notify's override-hint style.
 * Returns `undefined` when the scan was not truncated (no line to append).
 */
export function scanTruncationNotice(
	snapshot: Pick<
		ProjectDiagnosticsSnapshot,
		"scanTruncated" | "filesScanned" | "treeSitterStatus"
	>,
): string | undefined {
	if (!snapshot.scanTruncated) return undefined;
	if (snapshot.treeSitterStatus === "wasm_aborted_restart_required") {
		return (
			`⚠ Scan stopped after ${snapshot.filesScanned} complete file(s): the ` +
			"tree-sitter WASM runtime aborted. Results are partial and were not cached; " +
			"restart the pi-lens extension/MCP server to restore structural analysis."
		);
	}
	return (
		`⚠ Scan truncated at ${snapshot.filesScanned} file(s) — results are partial; ` +
		"raise maxProjectFiles in .pi-lens.json to scan fully."
	);
}

/**
 * #1107 phase 2: `generatedNameOnlySkips`/`generatedDirSkips` reach this seam
 * via `ProjectDiagnosticsSnapshot` but need explicit rendering, same pattern
 * as `scanTruncationNotice` above — otherwise a user has no way to learn the
 * generated-name heuristic silently excluded files/directories short of
 * reading `latency.log`'s `source_walk_skip_summary` line directly.
 *
 * #1107 phase 2 review round 2 (P1, empirically proven): this deliberately
 * keys off `generatedNameOnlySkips`, NOT the raw `generatedFileSkips` total.
 * `generatedFileSkips` counts every file the generated/artifact heuristic
 * skipped, including STRONG evidence (lockfiles, declaration files, minified/
 * bundle/chunk output — expected on nearly every real repo) and
 * content-CONFIRMED WEAK matches (the escape hatch checked and a genuine
 * generated-code header was present). Keying the notice off that total meant
 * a repo with nothing more unusual than a `package-lock.json` and an ambient
 * `.d.ts` showed "2 file(s) excluded" on literally every scan forever — the
 * signal drowned itself on day one. `generatedNameOnlySkips` is the narrower,
 * genuinely at-risk residual: a WEAK name match trusted with NO corroborating
 * evidence check at all (only reachable when a caller opts out of the header
 * probe — source-filter.ts's default project-walk path always enables it).
 * Post-escape-hatch, this should be rare-to-zero on the default path, which
 * is exactly what makes the notice meaningful again when it DOES fire.
 * `generatedDirSkips` stays in the trigger condition unchanged: directory-
 * level pruning has no escape hatch at all (the walk never enumerates a
 * pruned directory's contents to check them), so it is always a genuine
 * "real files may be hiding in here, unverified" signal, not a
 * false-positive-prone one — see `generatedDirSkips`'s doc on
 * `SourceCollectionResult`.
 *
 * Returns `undefined` when neither counter is set (nothing to append).
 */
export function generatedSkipNotice(
	snapshot: Pick<
		ProjectDiagnosticsSnapshot,
		"generatedNameOnlySkips" | "generatedDirSkips"
	>,
	host: LensToolHost = "pi",
): string | undefined {
	const files = snapshot.generatedNameOnlySkips ?? 0;
	const dirs = snapshot.generatedDirSkips ?? 0;
	if (files === 0 && dirs === 0) return undefined;
	const parts: string[] = [];
	if (files > 0) parts.push(`${files} file(s)`);
	if (dirs > 0) parts.push(`${dirs} director${dirs === 1 ? "y" : "ies"}`);
	// #2535 F1: name the tools THIS host can call. pi has no project-scan
	// surface, so it names only its diagnostics tool; MCP names both. A
	// known-but-unmapped host resolves to undefined and is left out, never
	// printed as a name the host cannot resolve.
	const targets = [
		resolveLensToolName("project_scan", host),
		resolveLensToolName("lens_diagnostics", host),
	].filter((tool): tool is string => tool !== undefined);
	const scanRef = targets.length > 0 ? ` to ${targets.join(" / ")}` : "";
	return (
		`ℹ ${parts.join(" and ")} excluded by generated-name heuristics with no ` +
		"confirming evidence — a real hand-written file/directory whose name " +
		"looks generated (e.g. `gen.ts`, `generated/`) can be excluded too; " +
		`pass includeGenerated: true${scanRef} to scan without this filter if you suspect a false skip.`
	);
}

/** Process-wide tree-sitter health for host status surfaces. */
export function treeSitterRuntimeStatus(): TreeSitterRuntimeStatus {
	return getTreeSitterRuntimeStatus();
}

export interface LspStatus {
	aliveClients: number;
	servers: Array<{
		serverId: string;
		root: string;
		connected: boolean;
		pullFailureHistory: Array<{
			timestamp: number;
			method: string;
			code?: number | string;
			message: string;
		}>;
	}>;
	brokenServers: ReturnType<
		ReturnType<typeof getLSPService>["getBrokenStatus"]
	>;
}

/** Alive LSP client count + per-server status. */
export function lspStatus(): LspStatus {
	const lsp = getLSPService();
	return {
		aliveClients: lsp.getAliveClientCount(),
		servers: lsp.getStatus(),
		brokenServers: lsp.getBrokenStatus(),
	};
}

export function renderLspBrokenStatusLines(
	brokenServers: LspStatus["brokenServers"],
): string[] {
	return brokenServers.map((server) =>
		server.permanentlyBroken
			? `  ✗ ${server.serverId} — disabled after ${server.failures} failures (${server.root})`
			: `  ✗ ${server.serverId} — cooling down after ${server.failures} failure(s) until ${new Date(server.cooldownUntil).toISOString()} (${server.root})`,
	);
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
interface SymbolSearchHit {
	file: string;
	score: number;
	hits: number;
	startLine: number;
	endLine: number;
	/**
	 * Graph-aware transparency for the ranking (#771): present only when the
	 * cached review graph happens to be warm (never built/blocked on for this —
	 * see `symbolSearch`'s doc comment). `fanIn` is the SAME reverse-dependency
	 * centrality value already used to boost this hit's score (0 when the file
	 * has no known importers); `complexity` is the highest per-symbol cyclomatic
	 * complexity the graph recorded for this file, omitted when the graph has no
	 * symbol nodes for it (e.g. a non-jsts file, or the file has none).
	 */
	annotations?: { fanIn: number; complexity?: number };
}

/**
 * Optional pre-ranking scope for `symbolSearch` (#771). Both filters are
 * applied to the word index BEFORE BM25/priors/centrality scoring runs, so a
 * surviving file's score is identical to what an unfiltered query would have
 * produced for it — only which files make it into `results` changes. Omitting
 * both (the default) reproduces today's output byte-for-byte.
 */
export interface SymbolSearchOptions {
	/**
	 * Glob array scoping hits to matching files — same shape/semantics as
	 * `ast_grep_search`'s `paths` param: a bare directory/file entry scopes its
	 * whole subtree, a full glob pattern (`src/**\/*.ts`) is matched as-is.
	 * Matched against each candidate file's path relative to `cwd`.
	 */
	paths?: string[];
	/**
	 * Restrict hits to one language, using the same language identifiers as
	 * `ast_grep_search`'s `lang` param (e.g. "typescript", "python", "go").
	 */
	lang?: string;
}

/**
 * symbol_search's `lang` filter.
 *
 * The extension table this used to consult was a NINTH hand-written language ->
 * extensions map, kept here because `clients/` never reaches into `tools/`
 * (AGENTS.md's MCP-mirror layering note) — and it had drifted from every other
 * one (#2424 review, S2): `css` claimed `.scss`/`.less`, `json` claimed
 * `.jsonc`, `php` omitted its four alias extensions, `ruby` omitted `.ru`, and
 * `solidity` was not a language the registry (or any grammar, or the ast-grep
 * napi matrix) knows at all.
 *
 * The layering constraint was never a reason to duplicate the DATA, only a
 * reason not to import the tool's token list. `extensionsForLanguageToken`
 * resolves the token against the canonical registry instead.
 *
 * Exported so `tests/clients/language-registry-drift.test.ts` guards the SEAM
 * and not just the projection behind it: a future local table reintroduced
 * here would satisfy a registry-only assertion but fail this one.
 */
export function symbolSearchFileMatchesLang(
	file: string,
	lang: string,
): boolean {
	const exts = extensionsForLanguageToken(lang);
	if (exts.length === 0) return false;
	return exts.includes(path.extname(file).toLowerCase());
}

/** Same glob semantics as ast_grep_search's `paths`: a bare directory/file
 * entry scopes its whole subtree (via a `/**` suffix match), a full glob
 * pattern is matched as-is. `paths` entries arrive host-resolved (#5038), so
 * `src`, `./src` and the absolute directory scope the same files. An entry at
 * or under `cwd` is matched as its `cwd`-relative spelling: the workspace
 * prefix is a literal, never glob syntax, so a directory named `app[1]` or
 * `app{a,b}` keeps its scope (#5047 F1), while the part the caller wrote after
 * it (`src/**\/*.ts`) is still a pattern. Any other entry (outside `cwd`, or a
 * relative glob) is also tried against the candidate's absolute spelling. */
function fileMatchesPathGlobs(
	file: string,
	cwd: string,
	globs: readonly string[],
): boolean {
	const rel = path.relative(cwd, file).split(path.sep).join("/");
	const abs = path.resolve(file).split(path.sep).join("/");
	const options = { dot: true, nocase: process.platform === "win32" };
	const matches = (candidate: string, pattern: string) =>
		minimatch(candidate, pattern, options) ||
		minimatch(candidate, `${pattern}/**`, options);
	return globs.some((raw) => {
		const within = path.isAbsolute(raw) ? relativeInside(cwd, raw) : undefined;
		// An entry at or under `cwd` is matched on the relative spelling alone,
		// never against the absolute candidate, whose workspace prefix is not a
		// pattern. `cwd` itself relativizes to "", which scopes the whole workspace.
		if (within !== undefined) return matches(rel, toPosix(within) || "**");
		const pattern = toPosix(raw);
		return matches(rel, pattern) || (abs !== rel && matches(abs, pattern));
	});
}

function buildSymbolSearchFileFilter(
	cwd: string,
	options: SymbolSearchOptions,
): ((file: string) => boolean) | undefined {
	// The entries are reader-admitted (`readPathsArgument`, #5041): a blank one
	// is refused there, so this seam keeps no copy of the rule (#5047 F5).
	const paths = options.paths;
	const lang = options.lang?.trim();
	if (!paths?.length && !lang) return undefined;
	return (file: string) => {
		if (paths?.length && !fileMatchesPathGlobs(file, cwd, paths)) return false;
		if (lang && !symbolSearchFileMatchesLang(file, lang)) return false;
		return true;
	};
}

/**
 * Attaches read-only graph signals to already-ranked hits (#771) — mutates
 * each hit in place. `fanIn` reuses the SAME `centrality` map `symbolSearch`
 * already computed for its ranking boost (zero extra cost); `complexity` is
 * the highest per-symbol `cyclomaticComplexity` the (warm) review graph
 * recorded for that file. Caller only invokes this when `graph` is defined —
 * never builds one itself.
 */
function annotateSymbolSearchHitsWithGraph(
	hits: SymbolSearchHit[],
	centrality: Map<string, number>,
	graph: ReviewGraph,
): void {
	for (const hit of hits) {
		const normalized = normalizeMapKey(path.resolve(hit.file));
		const fanIn = centrality.get(hit.file) ?? 0;
		let complexity: number | undefined;
		for (const symbolId of graph.symbolNodesByFile.get(normalized) ?? []) {
			const raw = graph.nodes.get(symbolId)?.metadata?.cyclomaticComplexity;
			if (
				typeof raw === "number" &&
				(complexity === undefined || raw > complexity)
			) {
				complexity = raw;
			}
		}
		hit.annotations = {
			fanIn,
			...(complexity !== undefined ? { complexity } : {}),
		};
	}
}

export interface SymbolSearchResult {
	/** False when no word index has been built/persisted for this workspace yet. */
	available: boolean;
	query: string;
	results: SymbolSearchHit[];
	/** Coverage of the persisted/warm index used for this answer. */
	coverage?: { files: number; truncated: boolean };
	/** Actionable guidance when `available` is false (#348 decision 3): the
	 * index build was kicked off in the background (deduped per cwd), never
	 * blocking this call — retry shortly. */
	hint?: string;
	/** Why an unavailable index cannot currently answer authoritatively. */
	unavailableReason?: "building" | "refused" | "last-build-failed";
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
 * #536 rider: prefers the warm in-memory index (`acquireWarmWordIndex`,
 * clients/mcp/analyze.ts) over a fresh disk read when one exists for this
 * cwd — a warm `pilens_analyze` call updates that live copy synchronously but
 * persists it to disk on a debounce (default 1500ms), so without this a query
 * immediately following an analyze in the SAME process would read stale
 * on-disk state until the debounce flushes. Falls back to the stateless disk
 * read exactly as before when no warm copy is cached (nothing has called
 * pilens_analyze yet this process, or #348 phase 2's forward-index isn't
 * available) — this function's public contract (available/hint/results shape)
 * is unchanged either way.
 *
 * `options.paths`/`options.lang` (#771) scope the word index BEFORE ranking
 * (`searchWordIndex`'s `fileFilter`), so a surviving file's score is identical
 * to an unfiltered run; omitting both reproduces prior output byte-for-byte.
 *
 * Every hit is additionally annotated (#771) with the graph signals already
 * available when the cached review graph happens to be warm —
 * `getCachedReviewGraph` (`clients/review-graph/builder.ts`) is a READ-ONLY
 * accessor: an in-memory miss falls through to a persisted-disk read, and
 * NOTHING here ever triggers a fresh build. A cold cache (no in-memory graph,
 * no persisted snapshot) simply omits `annotations` — this function's latency
 * profile is unchanged either way. The module is dynamic-imported (mirroring
 * module-report.ts's own lazy load of it) so an unused review graph costs
 * nothing on this hot path.
 */
export async function symbolSearch(
	query: string,
	cwd: string,
	limit = 20,
	options: SymbolSearchOptions = {},
): Promise<SymbolSearchResult> {
	// #5038: `limit` follows the same `max(1, floor)` rule as `project_report`.
	// A zero, negative or fractional limit used to reach `searchWordIndex`
	// unchanged, and `limit: 0` answered "no files matched" — a wrong answer for
	// a call that only mis-spelled its budget.
	const effectiveLimit = Number.isFinite(limit)
		? Math.max(1, Math.floor(limit))
		: 20;
	const warmLease = acquireWarmWordIndex(cwd);
	const snapshot = loadProjectSnapshotWithoutWordIndex(cwd);
	const index = warmLease.index;
	if (!index) {
		warmLease.release();
		const priorStatus = getWordIndexBuildStatus(cwd);
		const status =
			priorStatus?.state === "refused"
				? priorStatus
				: triggerBackgroundWordIndexBuild(cwd);
		const unavailableReason =
			priorStatus?.state === "failed"
				? "last-build-failed"
				: status.state === "refused"
					? "refused"
					: "building";
		const hint =
			unavailableReason === "refused"
				? `Word index build was refused for safety: ${status.state === "refused" ? status.reason : "unsafe workspace root"}. Run symbol_search from inside a project directory.`
				: unavailableReason === "last-build-failed"
					? `The last word index build failed: ${priorStatus?.state === "failed" ? priorStatus.reason : "unknown error"}. A retry is now running in the background.`
					: "Word index is building in the background for this workspace — retry this query shortly.";
		return {
			available: false,
			query,
			results: [],
			unavailableReason,
			hint,
		};
	}
	// Boost well-connected files using the snapshot's reverse-dependency
	// (importedBy) counts; snapshot keys are normalized, index keys are raw.
	let centrality: Map<string, number>;
	let results: RankedFile[];
	try {
		centrality = centralityFromReverseDeps(
			index,
			snapshot?.reverseDeps,
			(file) => normalizeMapKey(path.resolve(file)),
		);
		const fileFilter = buildSymbolSearchFileFilter(cwd, options);
		results = searchWordIndex(index, query, {
			limit: effectiveLimit,
			centrality,
			fileFilter,
		});
	} finally {
		warmLease.release();
	}
	const hits = results.map(toSymbolSearchHit);

	const { getCachedReviewGraph } = await import("./review-graph/builder.js");
	const graph = getCachedReviewGraph(cwd);
	if (graph) annotateSymbolSearchHitsWithGraph(hits, centrality, graph);

	return {
		available: true,
		query,
		results: hits,
		coverage: { files: index.docCount, truncated: index.truncated === true },
		snapshotGeneratedAt: snapshot?.generatedAt,
	};
}

/** Host-specific spelling of the outline tool the footer's next-step line
 * names (#5104): pi's `module_report`, MCP's `pilens_module_report`. */
export type SymbolSearchReportTool = "module_report" | "pilens_module_report";

/** Options for `renderCompactSymbolSearch`. */
export interface CompactSymbolSearchOptions {
	/** Directory every hit path is printed relative to. */
	cwd: string;
	/** MCP-only staleness note (`graphStalenessNote` in `mcp/server.ts`). */
	stalenessNote?: string;
	/** Tool the next-step line names. Defaults to the pi spelling. */
	reportTool?: SymbolSearchReportTool;
}

/** The index-coverage sentence both `symbol_search` surfaces print. A capped
 * index says so: an incomplete answer must not read as a complete one. */
function coverageLine(
	coverage: SymbolSearchResult["coverage"],
): string | undefined {
	if (!coverage) return undefined;
	return `Index covers ${coverage.files} files${coverage.truncated ? " (capped — results may be incomplete)" : ""}.`;
}

/** One ranked row: range first, one line number (`toSymbolSearchHit` sets
 * `endLine = startLine`, so `12-12` would spend bytes on nothing), then the
 * score, the hit count, and the graph annotations the hit carries. An
 * annotation prints whenever its key is present: `fanIn: 0` is an answer ("no
 * known importers"), so the gate is the type, never truthiness (#5104). */
function formatSymbolSearchRow(
	hit: SymbolSearchHit,
	position: number,
	cwd: string,
): string {
	const annotations = hit.annotations;
	const detail = [
		`score ${hit.score.toFixed(2)}`,
		`${hit.hits} hit(s)`,
		...(typeof annotations?.fanIn === "number"
			? [`fanIn ${annotations.fanIn}`]
			: []),
		...(typeof annotations?.complexity === "number"
			? [`complexity ${annotations.complexity}`]
			: []),
	];
	return `  ${position}. ${path.relative(cwd, hit.file)} ${hit.startLine} (${detail.join(", ")})`;
}

/**
 * The one renderer for `symbol_search`'s model-facing text (#5104): a header,
 * one row per ranked hit (path relative to `cwd`, its line, score, hit count
 * and any graph annotations), and a footer carrying the index coverage, on MCP
 * the snapshot staleness note, and one next-step line naming the top-ranked
 * hit through the host's own outline tool name. The pi tool and the MCP mirror
 * both call this, so the surfaces cannot drift and neither appends a JSON
 * payload — the ranked table IS the answer. The empty-result path renders
 * through the same footer, so a capped index stays visible there too.
 */
export function renderCompactSymbolSearch(
	result: SymbolSearchResult,
	options: CompactSymbolSearchOptions,
): string {
	const hits = result.results;
	const sections = [
		hits.length > 0
			? [
					`Top ${hits.length} file(s) for "${result.query}":`,
					...hits.map((hit, index) =>
						formatSymbolSearchRow(hit, index + 1, options.cwd),
					),
				].join("\n")
			: `No files matched "${result.query}".`,
	];
	const footer: string[] = [];
	const coverage = coverageLine(result.coverage);
	if (coverage) footer.push(coverage);
	if (options.stalenessNote) footer.push(options.stalenessNote);
	const top = hits[0];
	if (top) {
		footer.push(
			`Next: ${options.reportTool ?? "module_report"} ${path.relative(options.cwd, top.file)}`,
		);
	}
	if (footer.length > 0) sections.push(footer.join("\n"));
	return sections.join("\n\n");
}

// symbolImpact was removed (#304 follow-up): the transitive blast radius is now
// served by module_report's `blastRadius` option (clients/module-report.ts), which
// calls computeTransitiveImpact (review-graph/query.ts) directly over the cached
// graph. No engine wrapper is needed.
