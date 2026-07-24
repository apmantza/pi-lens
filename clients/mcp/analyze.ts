/**
 * Host-neutral analysis facade for the MCP path.
 *
 * This is the heart of the "real review loop": it runs the *same* per-edit
 * dispatch pipeline pi-lens runs inside pi (`dispatchLintWithResult`) on a file,
 * and returns a structured, JSON-serializable result — diagnostics plus the
 * latency record for that dispatch, in the same schema pi writes to latency.log.
 *
 * Because the only host coupling is `getFlag` (see host-shim), this runs with no
 * pi process: an MCP server (or a `fresh` worker importing the freshly-built
 * dist) can drive it directly, letting Claude observe a commit's real behavioral
 * + perf impact first-hand rather than inferring it from pasted logs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CacheManager } from "../cache-manager.js";
import {
	CASCADE_GRAPH_KINDS,
	dispatchLintWithResult,
	getLatencyReports,
} from "../dispatch/integration.js";
import { FactStore } from "../dispatch/fact-store.js";
import type { Diagnostic } from "../dispatch/types.js";
import { detectFileKind } from "../file-kinds.js";
import { getDiagnosticTracker } from "../diagnostic-tracker.js";
import { getLSPService } from "../lsp/index.js";
import { loadProjectSnapshot } from "../project-snapshot.js";
import { buildOrUpdateGraph } from "../review-graph/service.js";
import { recordDiagnostics } from "../widget-state.js";
import {
	deserializeWordIndex,
	removeWordIndexDocument,
	scheduleWordIndexPersist,
	updateWordIndexDocument,
	WORD_INDEX_MAX_BYTES,
	type WordIndex,
} from "../word-index.js";
import { createMcpHost } from "./host-shim.js";

// #536: module-scoped FactStore for the warm-analyze graph seam, mirroring the
// per-edit cascade path's own module-level `sessionFacts` singleton
// (clients/dispatch/integration.ts) — buildOrUpdateGraph's incremental/cached
// tiers key off a stable FactStore instance across calls, so a fresh FactStore
// per call would defeat that reuse. Scoped separately from integration.ts's
// singleton since this file has no dependency on that module's internal state.
const warmGraphFacts = new FactStore();

// #536 rider (issue body: "when #348 phase 2 lands, the word-index per-edit
// update should ride the SAME seam so both indexes stay warm together"):
// MCP has no RuntimeCoordinator/`runtime.wordIndex` to hold a live index the
// way pi's per-edit seam does (clients/dispatch/integration.ts's
// `updateWordIndexForCascade`, called from clients/runtime-tool-result.ts with
// `runtime.wordIndex`) — this process-scoped Map is the MCP-side equivalent: a
// per-cwd live WordIndex, loaded once from the persisted snapshot and mutated
// in place thereafter, mirroring `runtime.wordIndex`'s lifecycle for a process
// that has no other place to hold it. `undefined` cached value = "checked,
// nothing usable" (index missing or pre-phase-2/no-forward-map), distinct from
// "never checked" (key absent) — avoids re-attempting a snapshot load with no
// forward index on every single analyze call.
const warmWordIndexes = new Map<string, WordIndex | undefined>();

/**
 * Look up (loading from the persisted snapshot on first use per cwd) the warm
 * in-memory word index this analyze facade keeps mutated in place. Exported so
 * `symbolSearch()` (clients/lens-engine.ts) can prefer this live copy over a
 * fresh disk read when one exists for the cwd — otherwise a query immediately
 * following a warm `pilens_analyze` call in the SAME process would read a
 * stale on-disk snapshot until the debounced persist (default 1500ms) flushes.
 */
export function getOrLoadWarmWordIndex(cwd: string): WordIndex | undefined {
	const key = path.resolve(cwd);
	if (warmWordIndexes.has(key)) return warmWordIndexes.get(key);
	const snapshot = loadProjectSnapshot(key);
	const index = deserializeWordIndex(snapshot?.wordIndex) ?? undefined;
	// Same phase-2 rule as updateWordIndexForCascade: no forward index ⇒ no
	// incremental primitive available, so don't cache it as "usable" — this
	// call site's whole point is the incremental single-doc update.
	const usable = index?.forward ? index : undefined;
	warmWordIndexes.set(key, usable);
	return usable;
}

/**
 * Test-only reset — the module-level warm cache otherwise survives across
 * unrelated test cases in the same vitest worker.
 */
export function _resetWarmWordIndexCacheForTests(): void {
	warmWordIndexes.clear();
}

// Generous warm-up budgets: a cold language server needs to spawn AND publish
// diagnostics. The per-edit dispatch runner caps these tightly (spawn budget +
// 2500ms) for latency; a review tool prioritises completeness, so we pre-warm
// with room to spare, then the measured dispatch reads the warm cache.
// Bounded so a cold analysis can't hang: enough for fast servers (pyright,
// rust-analyzer, gopls) and a warm typescript-language-server, but NOT enough to
// fully load a large TS project from cold — that exceeds any per-call budget and
// is the persistent warm server's job (see the `lsp` honesty signal + Tier 2).
const WARMUP_CLIENT_WAIT_MS = 10_000;
const WARMUP_DIAGNOSTICS_WAIT_MS = 6_000;

/** One diagnostic, flattened to the fields an MCP consumer needs. */
export interface McpAnalyzeDiagnostic {
	line?: number;
	column?: number;
	severity: Diagnostic["severity"];
	semantic: Diagnostic["semantic"];
	tool: string;
	rule?: string;
	code?: string;
	message: string;
	fixable?: boolean;
	fixSuggestion?: string;
}

/** Per-runner timing, mirroring the latency.log `runners[]` schema. */
export interface McpRunnerLatency {
	runnerId: string;
	durationMs: number;
	status: string;
	diagnosticCount: number;
}

export interface McpAnalyzeResult {
	filePath: string;
	cwd: string;
	fileKind: string | undefined;
	/** Wall-clock time the facade spent in dispatch (includes provider warmup). */
	durationMs: number;
	hasBlockers: boolean;
	counts: {
		diagnostics: number;
		blockers: number;
		warnings: number;
		fixed: number;
	};
	diagnostics: McpAnalyzeDiagnostic[];
	/**
	 * The LSP runner's outcome, surfaced explicitly so a cold/indexing server's
	 * `0 diagnostics` is never silently mistaken for "clean". On a large project a
	 * cold language server can take longer to load than any per-call warm-up, so
	 * `ran` + `status` + `durationMs` let the consumer judge completeness (and
	 * prefer warm mode / a re-run once the persistent server has indexed).
	 */
	lsp?: {
		ran: boolean;
		status: string;
		diagnosticCount: number;
		durationMs: number;
	};
	/** The dispatch latency report for this run (latency.log schema), if captured. */
	latency?: {
		totalDurationMs: number;
		stoppedEarly: boolean;
		runners: McpRunnerLatency[];
	};
}

export interface AnalyzeFileOptions {
	/** Per-call flag overrides for the host shim (e.g. `{ "no-lsp": true }`). */
	flags?: Record<string, boolean | string | undefined>;
	/**
	 * Only run blocking (error-level) rules — pi's fast on-write path. Default
	 * false: a review wants the full picture (warnings + structural smells).
	 */
	blockingOnly?: boolean;
	/**
	 * Pre-warm the LSP (spawn + wait for published diagnostics) before the
	 * measured dispatch, so a cold server doesn't make the run report 0 LSP
	 * diagnostics. Default true; the `fresh` worker relies on it (always cold).
	 */
	warmLsp?: boolean;
	/**
	 * Record results into the session widget-state + diagnostic tracker so the
	 * query tools (`pilens_diagnostics`, `pilens_health`) reflect this analysis.
	 * Default true; harmless (and discarded) in the short-lived `fresh` worker.
	 */
	record?: boolean;
	/**
	 * Mark the file as edited-this-turn in on-disk turn-state, so a subsequent
	 * `pilens_turn_end` (knip/jscpd/dep/tests/cascade) picks it up with no
	 * explicit file list. Default false — only the edit-detection paths (the
	 * warm `pilens_analyze` and the PostToolUse-hook bin) enable it, so `fresh`
	 * benchmarking doesn't pollute the real turn-state.
	 */
	registerTurnState?: boolean;
	/**
	 * Maintain the review graph for this file after a successful dispatch — the
	 * SAME `buildOrUpdateGraph` call pi's per-edit cascade path makes
	 * (`computeCascadeForFile`, clients/dispatch/integration.ts), so
	 * `pilens_module_report`'s usedBy/blastRadius and `pilens_symbol_search`'s
	 * centrality reflect files analyzed via MCP, not just session-start state.
	 * Default false — this is a DELIBERATE opt-in gate (#536), not a
	 * per-call-site inference from cwd/process, because `analyzeFile` is the
	 * shared facade for BOTH the warm in-process path (mcp/server.ts) and the
	 * `fresh` worker (mcp/worker.ts, forked per-call, always cold, exits after
	 * one result) — the fresh worker's process-lifetime is too short for the
	 * persist debounce to ever flush, and building/persisting a graph from a
	 * one-shot throwaway process on every fresh analysis would be pure waste
	 * plus a needless disk write. Only mcp/server.ts's two warm call sites (the
	 * IPC handler and the direct tool dispatch) set this true. This retires the
	 * #256 "read-only facade" contract for warm mode specifically; `fresh`
	 * stays read-only.
	 */
	updateGraph?: boolean;
}

function toMcpDiagnostic(diagnostic: Diagnostic): McpAnalyzeDiagnostic {
	return {
		line: diagnostic.line,
		column: diagnostic.column,
		severity: diagnostic.severity,
		semantic: diagnostic.semantic,
		tool: diagnostic.tool,
		rule: diagnostic.rule,
		code: diagnostic.code,
		message: diagnostic.message,
		fixable: diagnostic.fixable,
		fixSuggestion: diagnostic.fixSuggestion,
	};
}

/**
 * Pre-warm the LSP for a file: spawn the server and wait for it to publish
 * diagnostics, so the subsequent dispatch reads a warm cache instead of a cold
 * (empty) one. Best-effort — failures never block the analysis.
 */
async function warmLspForFile(
	absPath: string,
	host: ReturnType<typeof createMcpHost>,
): Promise<void> {
	if (host.getFlag("no-lsp")) return;
	const lspService = getLSPService();
	if (!lspService.supportsLSP(absPath)) return;
	let content: string;
	try {
		content = fs.readFileSync(absPath, "utf8");
	} catch {
		return;
	}
	try {
		await lspService.touchFile(absPath, content, {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "primary",
			maxClientWaitMs: WARMUP_CLIENT_WAIT_MS,
			maxDiagnosticsWaitMs: WARMUP_DIAGNOSTICS_WAIT_MS,
			source: "mcp-warmup",
		});
	} catch {
		// Best-effort warm-up; the dispatch runner still tries on its own.
	}
}

/**
 * Run the dispatch pipeline on `filePath` and return a structured result.
 *
 * Unlike pi's per-edit path this defaults to the *full* analysis (warnings +
 * structural smells, not just blocking errors), pre-warms the LSP so a cold
 * server doesn't under-report, records into the session diagnostic state so the
 * query tools compose, and runs delta-free so a repeated analysis of an
 * unchanged file is a consistent full snapshot rather than "new issues only".
 *
 * The latency report is matched against the dispatches appended *during this
 * call* (we snapshot the report count first), so concurrent callers don't pick
 * up each other's timings.
 */
export async function analyzeFile(
	filePath: string,
	cwd: string,
	options: AnalyzeFileOptions = {},
): Promise<McpAnalyzeResult> {
	const absPath = path.isAbsolute(filePath)
		? filePath
		: path.resolve(cwd, filePath);
	// no-delta by default → a full snapshot every call (not delta-filtered);
	// caller flags win over the default.
	const host = createMcpHost(
		{ "no-delta": true, ...(options.flags ?? {}) },
		cwd,
	);

	if (options.warmLsp !== false) {
		await warmLspForFile(absPath, host);
	}

	const reportsBefore = getLatencyReports().length;
	const start = Date.now();
	const result = await dispatchLintWithResult(absPath, cwd, host, undefined, undefined, {
		blockingOnly: options.blockingOnly ?? false,
	});
	const durationMs = Date.now() - start;

	if (options.record !== false) {
		// Mirror pipeline.ts's recording so pilens_diagnostics (mode=all) and
		// pilens_health see what this analysis found.
		recordDiagnostics(absPath, result.diagnostics);
		if (result.diagnostics.length > 0) {
			getDiagnosticTracker().trackShown(result.diagnostics);
		}
	}

	if (options.registerTurnState) {
		// Full-file range, importsChanged=true (conservative → dep/knip re-check
		// broadly). No sessionId — leaving it unset avoids turn_end's stale-session
		// eviction. Best-effort.
		try {
			const lineCount = fs.readFileSync(absPath, "utf8").split("\n").length;
			new CacheManager().addModifiedRange(
				absPath,
				{ start: 1, end: lineCount },
				true,
				cwd,
			);
		} catch {
			// unreadable — skip turn-state registration
		}
	}

	if (options.updateGraph && !result.hasBlockers) {
		// #536: maintain the review graph on a successful warm analysis — the same
		// call pi's per-edit cascade path makes (computeCascadeForFile), gated the
		// same way (CASCADE_GRAPH_KINDS: only languages the graph actually models,
		// and skipped when the file has blockers, matching the cascade path's own
		// "primary_has_blockers" skip). buildOrUpdateGraph owns its own debounced
		// persist + seq machinery internally — this is the ONLY call needed; no
		// separate persist/flush step. Best-effort: a graph build failure must
		// never fail the analysis itself (the diagnostics are already computed).
		const fileKind = detectFileKind(absPath);
		if (fileKind && CASCADE_GRAPH_KINDS.has(fileKind)) {
			try {
				await buildOrUpdateGraph(cwd, [absPath], warmGraphFacts);
			} catch {
				// Best-effort — the graph update is additive; a failure here must not
				// surface as an analyze failure.
			}
		}

		// #536 rider: ride the SAME seam for the word index (#348 phase 2's
		// per-edit primitive), mirroring pi's `updateWordIndexForCascade`
		// (clients/dispatch/integration.ts) rule-for-rule rather than reusing it
		// directly — that function is module-private and reads its file-content
		// argument from the pipeline's already-read buffer, whereas this seam
		// reads the file itself (no pipeline hook here). Same rules: a cached
		// index with no `forward` map (or none loaded) ⇒ no-op (no incremental
		// primitive available — the eventual full rebuild covers it); an
		// oversized file is REMOVED, never partially indexed; the update is
		// synchronous (no interleaving hazard — MCP is single-process, same as
		// pi); a successful update schedules the SAME debounced persist
		// (`scheduleWordIndexPersist`, `PI_LENS_WORD_INDEX_PERSIST_DEBOUNCE_MS`)
		// pi's path uses — no second persist mechanism.
		//
		// Key shape: `path.resolve(absPath)`, matching the build path's own keys
		// (collectWordIndexDocs → collectSourceFilesAsync), NOT normalizeMapKey —
		// see updateWordIndexForCascade's doc comment for why a mismatched key
		// silently orphans a duplicate entry instead of replacing it.
		const warmIndex = getOrLoadWarmWordIndex(cwd);
		if (warmIndex) {
			try {
				const content = fs.readFileSync(absPath, "utf8");
				const byteLength = Buffer.byteLength(content, "utf-8");
				if (byteLength > WORD_INDEX_MAX_BYTES) {
					removeWordIndexDocument(warmIndex, absPath);
				} else {
					updateWordIndexDocument(warmIndex, { path: absPath, content });
				}
				scheduleWordIndexPersist(cwd, warmIndex);
			} catch {
				// unreadable/deleted, or an update failure — best-effort, same as the
				// graph update above.
			}
		}
	}

	// dispatchForFile appended a latency report during the call above. Match the
	// newly-added report for this exact path; fall back to the most recent new
	// report if the path normalization differs.
	const newReports = getLatencyReports().slice(reportsBefore);
	const latencyReport =
		newReports.find((report) => path.resolve(report.filePath) === absPath) ??
		newReports[newReports.length - 1];

	const lspRunner = latencyReport?.runners.find(
		(runner) => runner.runnerId === "lsp",
	);
	const lsp = lspRunner
		? {
				ran:
					lspRunner.status !== "skipped" &&
					lspRunner.status !== "when_skipped",
				status: lspRunner.status,
				diagnosticCount: lspRunner.diagnosticCount,
				durationMs: lspRunner.durationMs,
			}
		: undefined;

	return {
		filePath: absPath,
		cwd,
		fileKind: latencyReport?.fileKind,
		durationMs,
		hasBlockers: result.hasBlockers,
		counts: {
			diagnostics: result.diagnostics.length,
			blockers: result.blockers.length,
			warnings: result.warnings.length,
			fixed: result.fixed.length,
		},
		lsp,
		diagnostics: result.diagnostics.map(toMcpDiagnostic),
		latency: latencyReport
			? {
					totalDurationMs: latencyReport.totalDurationMs,
					stoppedEarly: latencyReport.stoppedEarly,
					runners: latencyReport.runners.map((runner) => ({
						runnerId: runner.runnerId,
						durationMs: runner.durationMs,
						status: runner.status,
						diagnosticCount: runner.diagnosticCount,
					})),
				}
			: undefined,
	};
}
