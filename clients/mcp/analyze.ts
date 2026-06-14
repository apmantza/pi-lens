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
	dispatchLintWithResult,
	getLatencyReports,
} from "../dispatch/integration.js";
import type { Diagnostic } from "../dispatch/types.js";
import { getDiagnosticTracker } from "../diagnostic-tracker.js";
import { getLSPService } from "../lsp/index.js";
import { recordDiagnostics } from "../widget-state.js";
import { createMcpHost } from "./host-shim.js";

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
	const host = createMcpHost({ "no-delta": true, ...(options.flags ?? {}) });

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
