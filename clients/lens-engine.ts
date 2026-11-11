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
import { resolveLanguageScope } from "./language-registry.js";
import { initLSPConfig } from "./lsp/config.js";
import { getLSPService } from "./lsp/capabilities.js";
import { acquireWarmWordIndex } from "./mcp/analyze.js";
import {
	normalizeEphemeralMapKey,
	normalizeMapKey,
	toPosix,
} from "./path-utils.js";
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
	isEmptyWordIndexQuery,
	parseWordIndexQuery,
	type RankedFile,
	searchWordIndex,
	triggerBackgroundWordIndexBuild,
} from "./word-index.js";

// --- Facades (re-exported so adapters import only this module) ---------------

export { analyzeFile, type McpAnalyzeResult } from "./mcp/analyze.js";
export { createMcpHost } from "./mcp/host-shim.js";
export {
	boundUnixSocketPath,
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
	renderModuleReportPreset,
	resolveModuleReportPreset,
} from "./module-report.js";
export {
	type ProjectReport,
	projectReport,
	projectReportViewIsJson,
	renderTextProjectReport,
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

/** Slimmed wire shape (#517 conformity). A `symbol` row carries `hits` and a
 * single-line `startLine`/`endLine` span marking its best-matching line
 * (`lines[0]`, the file's own best-scoring identifier hit) rather than a
 * fabricated whole-file range, since the word index tracks scattered per-line
 * matches, not a symbol span. Read derivation: offset=startLine,
 * limit=endLine-startLine+1 for a one-line peek — prefer module_report on
 * `file` for the real outline. A `file` row (#5135) is a term-less scope
 * listing: no `hits`, no line span, and the renderer fabricates neither. No
 * per-hit `read` block, no repeated raw `lines[]` array on the wire. */
interface SymbolSearchHit {
	file: string;
	score: number;
	/** Producer-owned row shape (#5135): `symbol` for a ranked identifier
	 * match, `file` for a term-less scope listing. The renderer branches on this
	 * and never infers the kind from `hits` or an empty line list. */
	kind: "symbol" | "file";
	/** Present iff `kind === "symbol"`: query-token occurrences. */
	hits?: number;
	/** Present iff `kind === "symbol"`: the best-matching line, a single-line
	 * span. A `file` row carries no line and the renderer fabricates none. */
	startLine?: number;
	endLine?: number;
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
	 * Files and directories scoping hits: the entries `readPathsArgument` returns
	 * (#5371), where a glob has already been expanded to the paths it names. A
	 * file entry scopes that file, a directory entry its whole subtree, and an
	 * entry is compared as a path, never read as a pattern, so a file named
	 * `[id].ts` is that file. A relative entry resolves against `cwd`.
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
	// One predicate, shared with the inline `lang:` filter: it is filename-aware
	// (a language the registry declares by basename — Jenkinsfile, Gemfile — or a
	// kind named by pattern — Dockerfile, Makefile — has no extension to match)
	// and normalizes the token once (MCP passes `lang` through as typed). An
	// unknown token selects nothing here; `symbolSearch` refuses it before the
	// index is touched (#5135), so no production call reaches this with one.
	const scope = resolveLanguageScope(lang);
	return "refusal" in scope ? false : scope.matches(file);
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
	// #5371 r2: the reader already expanded every glob, so each entry is a
	// CONCRETE file or directory. It is compared as text, never read as a pattern:
	// a file named `[id].ts` or `b{1,2}.ts` is a name, and the engine used to hand
	// it back to minimatch and drop it (#5393 F9).
	const scope = paths?.length ? scopeEntryKeys(cwd, paths) : undefined;
	return (file: string) => {
		if (scope && !fileIsInScope(file, scope)) return false;
		if (lang && !symbolSearchFileMatchesLang(file, lang)) return false;
		return true;
	};
}

/** Lexical, slash-folded keys for the entries (a relative spelling resolves
 * against `cwd`). Lexical on purpose: this runs once per indexed file. */
function scopeEntryKeys(cwd: string, paths: readonly string[]): Set<string> {
	return new Set(
		paths.map((entry) => normalizeEphemeralMapKey(path.resolve(cwd, entry))),
	);
}

/** A file is in scope when it IS an entry or sits under an entry directory:
 * the file's own key, then each ancestor, is looked up in the entry set. */
function fileIsInScope(file: string, scope: ReadonlySet<string>): boolean {
	let key = normalizeEphemeralMapKey(path.resolve(file));
	for (;;) {
		if (scope.has(key)) return true;
		const cut = key.lastIndexOf("/");
		if (cut < 0) return false;
		key = key.slice(0, cut);
		// Up to the root: "" on POSIX, "c:" on a drive; the root entry spells "/".
		if (!key.includes("/")) return scope.has(`${key}/`);
	}
}

/** The refusal sentence for the first unknown `lang` token a call carries —
 * the structured `options.lang` or any inline `lang:` value — or `undefined`
 * when every token resolves (#5135). Pure: it needs no index. */
function unknownLangRefusal(
	query: string,
	lang: string | undefined,
): string | undefined {
	const tokens = lang?.trim() ? [lang] : [];
	for (const entry of parseWordIndexQuery(query).filters) {
		if (entry.key === "lang") tokens.push(entry.value);
	}
	for (const token of tokens) {
		const scope = resolveLanguageScope(token);
		if ("refusal" in scope) return scope.refusal;
	}
	return undefined;
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

/** The one refusal sentence both `symbol_search` surfaces return for a call
 * with neither search terms nor scope (#5135). Owned here so the pi tool and
 * the MCP mirror cannot drift; `SymbolSearchResult.refusal` carries it. */
export const SYMBOL_SEARCH_EMPTY_QUERY_REFUSAL =
	"Provide a non-empty `query`, or scope the search with `paths`/`lang` or an inline `lang:`/`file:`/`ext:` filter.";

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
	/** Set when the call was malformed (#5135): neither terms nor scope, or an
	 * unknown `lang` token. The surfaces return this sentence as an isError
	 * refusal, never as an empty result. `available` stays true — the engine
	 * could answer; the request was not one. */
	refusal?: string;
}

function toSymbolSearchHit(result: RankedFile): SymbolSearchHit {
	if (result.kind === "file") {
		// A scope listing (#5135) is a file row: no line, no hit count. The
		// producer owns the shape; nothing is inferred or fabricated here.
		return { file: result.file, score: result.score, kind: "file" };
	}
	const line = result.lines[0] ?? 1;
	return {
		file: result.file,
		score: result.score,
		kind: "symbol",
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
 *
 * A call with neither terms nor scope, or with an unknown `lang` token
 * (structured or inline; checked before the index is touched), returns
 * `refusal` instead of an empty result (#5135); the surfaces turn that into an
 * isError. A term-less call that
 * carries a scope (inline filters, or `options.paths`/`options.lang`) returns a
 * listing of the scoped files.
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

	// #5135: a call with neither terms nor scope is a malformed request, not an
	// empty result. Decided HERE (one owner) so the pi tool and the MCP mirror
	// cannot diverge; both surfaces return `refusal` as an isError.
	if (
		isEmptyWordIndexQuery(query) &&
		!options.paths?.length &&
		!options.lang?.trim()
	) {
		return {
			available: true,
			query,
			results: [],
			refusal: SYMBOL_SEARCH_EMPTY_QUERY_REFUSAL,
		};
	}
	// #5135: an unknown `lang` (structured option or inline `lang:`) refuses HERE,
	// before the index is acquired, so the answer depends on neither the index
	// being warm, nor a term having postings, nor a file reaching the per-file
	// predicate.
	const unknownLang = unknownLangRefusal(query, options.lang);
	if (unknownLang) {
		return { available: true, query, results: [], refusal: unknownLang };
	}
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

/** One ranked row. A `symbol` row prints the path, one line number
 * (`toSymbolSearchHit` sets `endLine = startLine`, so `12-12` would spend bytes
 * on nothing), the score, the hit count, and any graph annotations it carries.
 * A `file` row (#5135) prints the path ALONE — no score, no line, no hit count.
 * The producer sets `kind`; the renderer never infers the kind from a hit count
 * or an empty line list and never fabricates a line. An annotation prints
 * whenever its key is present: `fanIn: 0` is an answer ("no known importers"),
 * so the gate is the type, never truthiness (#5104). */
function formatSymbolSearchRow(
	hit: SymbolSearchHit,
	position: number,
	cwd: string,
): string {
	const file = path.relative(cwd, hit.file);
	if (hit.kind === "file") return `  ${position}. ${file}`;
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
	return `  ${position}. ${file} ${hit.startLine} (${detail.join(", ")})`;
}

/**
 * The one renderer for `symbol_search`'s model-facing text (#5104): a header,
 * one row per hit — a `symbol` row prints the path, its line, score, hit count
 * and any graph annotations; a `file` listing row (#5135) prints the path
 * alone — and a footer carrying the index coverage, on MCP the snapshot
 * staleness note, and one next-step line naming the top-ranked hit through the
 * host's own outline tool name. The pi tool and the MCP mirror both call this,
 * so the surfaces cannot drift and neither appends a JSON payload — the ranked
 * table IS the answer. The empty-result path renders through the same footer,
 * so a capped index stays visible there too.
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
