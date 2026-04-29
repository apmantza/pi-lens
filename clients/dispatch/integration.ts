/**
 * Dispatch integration helpers
 *
 * Provides utilities for integrating the declarative dispatch system
 * with the existing index.ts tool_result handler.
 */

import { getDiagnosticLogger, type LogContext } from "../diagnostic-logger.js";
import type { FileKind } from "../file-kinds.js";
import { detectFileKind } from "../file-kinds.js";
import {
	getLspCapableKinds,
	getPrimaryDispatchGroup,
} from "../language-policy.js";
import {
	formatSlopScoreSummary,
	type SlopScoreSummary,
} from "../session-summary.js";
import {
	clearCoverageNoticeState,
	clearLatencyReports,
	createDispatchContext,
	type DispatchLatencyReport,
	dispatchForFile,
	formatLatencyReport,
	getLatencyReports,
	type RunnerLatency,
	RunnerRegistry,
} from "./dispatcher.js";
import { FactStore } from "./fact-store.js";
import { TOOL_PLANS } from "./plan.js";
import type {
	DispatchResult,
	ModifiedRange,
	PiAgentAPI,
	RunnerGroup,
} from "./types.js";

export type { DispatchLatencyReport, RunnerLatency };
// Re-export latency tracking types and functions
export { clearLatencyReports, formatLatencyReport, getLatencyReports };

import * as nodeFs from "node:fs";
import { formatCascadeNeighborDiagnostics } from "../cascade-format.js";
import { logCascade } from "../cascade-logger.js";
import type { CascadeResult } from "../cascade-types.js";
import { getDiagnosticTracker } from "../diagnostic-tracker.js";
import { getServersForFileWithConfig } from "../lsp/config.js";
import { getLSPService } from "../lsp/index.js";
import { normalizeMapKey } from "../path-utils.js";
import {
	clearReviewGraphWorkspaceCache,
	getLastGraphBuildInfo,
} from "../review-graph/builder.js";
import {
	buildOrUpdateGraph,
	computeImpactCascade,
	formatImpactCascade,
} from "../review-graph/service.js";
import { RUNTIME_CONFIG } from "../runtime-config.js";
// Register fact providers
import { registerProvider, runProviders } from "./fact-runner.js";
import { fileContentProvider } from "./facts/file-content.js";
import { resolveRunnerPath, toRunnerDisplayPath } from "./runner-context.js";
import { registerDefaultRunners } from "./runners/index.js";
import { convertLspDiagnostics } from "./utils/lsp-diagnostics.js";

registerProvider(fileContentProvider);

import { tryCatchFactProvider } from "./facts/try-catch-facts.js";

registerProvider(tryCatchFactProvider);

import { functionFactProvider } from "./facts/function-facts.js";

registerProvider(functionFactProvider);

import { commentFactProvider } from "./facts/comment-facts.js";

registerProvider(commentFactProvider);

import { importFactProvider } from "./facts/import-facts.js";

registerProvider(importFactProvider);

// Register fact rules
import { registerRule } from "./fact-rule-runner.js";
import { asyncNoiseRule } from "./rules/async-noise.js";
import { asyncUnnecessaryWrapperRule } from "./rules/async-unnecessary-wrapper.js";
import { errorObscuringRule } from "./rules/error-obscuring.js";
import { errorSwallowingRule } from "./rules/error-swallowing.js";
import { highComplexityRule } from "./rules/high-complexity.js";
import { highFanOutRule } from "./rules/high-fan-out.js";
import { missingErrorPropagationRule } from "./rules/missing-error-propagation.js";
import { passThroughWrappersRule } from "./rules/pass-through-wrappers.js";
import { placeholderCommentsRule } from "./rules/placeholder-comments.js";
import {
	highImportCouplingRule,
	noBooleanParamsRule,
	noComplexConditionalsRule,
} from "./rules/quality-rules.js";
import {
	commentedCredentialsRule,
	commentedOutCodeRule,
	corsWildcardRule,
	duplicateStringLiteralRule,
	dynamicRegexpRule,
	functionInLoopRule,
	jwtWithoutVerifyRule,
	maxSwitchCasesRule,
} from "./rules/sonar-rules.js";
import { unsafeBoundaryRule } from "./rules/unsafe-boundary.js";

registerRule(errorObscuringRule);
registerRule(errorSwallowingRule);
registerRule(asyncNoiseRule);
registerRule(passThroughWrappersRule);
registerRule(placeholderCommentsRule);
registerRule(highComplexityRule);
registerRule(unsafeBoundaryRule);
registerRule(asyncUnnecessaryWrapperRule);
registerRule(missingErrorPropagationRule);
registerRule(highFanOutRule);
registerRule(commentedOutCodeRule);
registerRule(duplicateStringLiteralRule);
registerRule(functionInLoopRule);
registerRule(jwtWithoutVerifyRule);
registerRule(corsWildcardRule);
registerRule(dynamicRegexpRule);
registerRule(maxSwitchCasesRule);
registerRule(commentedCredentialsRule);
registerRule(noBooleanParamsRule);
registerRule(highImportCouplingRule);
registerRule(noComplexConditionalsRule);

const sessionFacts = new FactStore();
const cascadeDiagnosticBaselines = new Map<
	string,
	import("./types.js").Diagnostic[]
>();
const sessionRunnerRegistry = new RunnerRegistry();
registerDefaultRunners(sessionRunnerRegistry);
const LSP_CAPABLE_KINDS = new Set<FileKind>(getLspCapableKinds());
const FACT_RULE_IDS = new Set([
	"error-obscuring",
	"error-swallowing",
	"async-noise",
	"pass-through-wrappers",
	"placeholder-comments",
	"high-complexity",
	"unsafe-boundary",
	"async-unnecessary-wrapper",
	"missing-error-propagation",
	"high-fan-out",
	"commented-out-code",
	"duplicate-string-literal",
	"function-in-loop",
	"jwt-without-verify",
	"cors-wildcard",
	"dynamic-regexp",
	"max-switch-cases",
	"no-commented-credentials",
	"no-boolean-params",
	"high-import-coupling",
	"no-complex-conditionals",
]);
const sessionSlopRuleCounts = new Map<string, number>();
let sessionSlopDiagnosticCount = 0;
let sessionWrittenLineCount = 0;

// Debounced ast-grep warning scan — fires 2s after the last write to a jsts file.
// Runs warning-tier rules that are too expensive to include in the blocking write path,
// logs all diagnostics for history without surfacing anything to the agent.
const astGrepWarnDebounceTimers = new Map<
	string,
	ReturnType<typeof setTimeout>
>();
const AST_GREP_WARN_DEBOUNCE_MS = 2000;

function scheduleAstGrepWarningScan(
	filePath: string,
	cwd: string,
	pi: PiAgentAPI,
	logContext: LogContext,
): void {
	const existing = astGrepWarnDebounceTimers.get(filePath);
	if (existing) clearTimeout(existing);

	const timer = setTimeout(async () => {
		astGrepWarnDebounceTimers.delete(filePath);
		try {
			const ctx = createDispatchContext(filePath, cwd, pi, sessionFacts, false);
			if (ctx.kind !== "jsts") return;

			// Single-runner group: ast-grep only, warning mode (blockingOnly=false)
			const group: RunnerGroup = {
				mode: "all",
				runnerIds: ["ast-grep"],
				filterKinds: ["jsts"],
			};
			const result = await dispatchForFile(ctx, [group], sessionRunnerRegistry);
			if (result.diagnostics.length === 0) return;

			const logger = getDiagnosticLogger();
			for (const d of result.diagnostics) {
				logger.logCaught(d, logContext, false);
			}
		} catch {
			// Non-critical background scan — swallow errors silently
		}
	}, AST_GREP_WARN_DEBOUNCE_MS);

	astGrepWarnDebounceTimers.set(filePath, timer);
}

function resetSessionSlopScore(): void {
	sessionSlopRuleCounts.clear();
	sessionSlopDiagnosticCount = 0;
	sessionWrittenLineCount = 0;
}

function detectFactRuleId(diagnostic: {
	id?: string;
	rule?: string;
	tool?: string;
}): string | undefined {
	if (diagnostic.rule && FACT_RULE_IDS.has(diagnostic.rule)) {
		return diagnostic.rule;
	}
	if (diagnostic.tool && FACT_RULE_IDS.has(diagnostic.tool)) {
		return diagnostic.tool;
	}
	if (diagnostic.id) {
		const prefix = diagnostic.id.split(":", 1)[0];
		if (FACT_RULE_IDS.has(prefix)) {
			return prefix;
		}
	}
	return undefined;
}

function trackSessionSlopStats(
	ctx: ReturnType<typeof createDispatchContext>,
	diagnostics: DispatchResult["diagnostics"],
): void {
	const lineCount = ctx.facts.getFileFact<number>(
		ctx.filePath,
		"file.lineCount",
	);
	if (
		typeof lineCount === "number" &&
		Number.isFinite(lineCount) &&
		lineCount > 0
	) {
		sessionWrittenLineCount += lineCount;
	}

	for (const diagnostic of diagnostics) {
		const ruleId = detectFactRuleId(diagnostic);
		if (!ruleId) continue;
		sessionSlopDiagnosticCount += 1;
		sessionSlopRuleCounts.set(
			ruleId,
			(sessionSlopRuleCounts.get(ruleId) ?? 0) + 1,
		);
	}
}

export function getDispatchSlopScoreSummary(): SlopScoreSummary | undefined {
	if (sessionSlopDiagnosticCount === 0 || sessionWrittenLineCount <= 0) {
		return undefined;
	}

	const totalKlocWritten = sessionWrittenLineCount / 1000;
	const ruleCounts = [...sessionSlopRuleCounts.entries()]
		.map(([ruleId, count]) => ({ ruleId, count }))
		.sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId));

	return {
		totalRuleDiagnostics: sessionSlopDiagnosticCount,
		totalKlocWritten,
		scorePerKloc: sessionSlopDiagnosticCount / totalKlocWritten,
		ruleCounts,
	};
}

export function getDispatchSlopScoreLine(): string {
	const summary = getDispatchSlopScoreSummary();
	if (!summary) return "";
	return formatSlopScoreSummary(summary);
}

function withPrimaryPolicyGroup(
	kind: keyof typeof TOOL_PLANS,
	groups: RunnerGroup[],
	pi: PiAgentAPI,
): RunnerGroup[] {
	const lspEnabled = !pi.getFlag("no-lsp");
	const normalizedGroups = lspEnabled
		? groups
		: groups
				.map((group) => {
					const runnerIds = group.runnerIds.filter(
						(id) => id !== "lsp" && id !== "ts-lsp",
					);
					if (runnerIds.length === 0) return null;
					return {
						...group,
						runnerIds,
					};
				})
				.filter((group): group is RunnerGroup => group !== null);

	const primary = getPrimaryDispatchGroup(kind as FileKind, lspEnabled);
	if (!primary) return normalizedGroups;

	const alreadyHasPrimary = normalizedGroups.some((group) => {
		if (group.mode !== primary.mode) return false;
		if (group.runnerIds.length !== primary.runnerIds.length) return false;
		return group.runnerIds.every(
			(id, index) => primary.runnerIds[index] === id,
		);
	});
	if (alreadyHasPrimary) return normalizedGroups;

	return [primary, ...normalizedGroups];
}

export function getDispatchGroupsForKind(
	kind: keyof typeof TOOL_PLANS,
	pi: PiAgentAPI,
): RunnerGroup[] {
	const plan = TOOL_PLANS[kind];
	if (!plan) {
		const lspEnabled = !pi.getFlag("no-lsp");
		const policyGroup = getPrimaryDispatchGroup(kind as FileKind, lspEnabled);
		if (policyGroup) return [policyGroup];
		if (lspEnabled && LSP_CAPABLE_KINDS.has(kind as FileKind)) {
			return [
				{ mode: "all", runnerIds: ["lsp"], filterKinds: [kind as FileKind] },
			];
		}
		return [];
	}
	return withPrimaryPolicyGroup(kind, plan.groups, pi);
}

/**
 * Reset baselines — call on session_start so a new session
 * starts with a clean slate.
 */
export function resetDispatchBaselines(): void {
	sessionFacts.clearAll();
	resetSessionSlopScore();
	clearCoverageNoticeState();
	clearReviewGraphWorkspaceCache();
	neighborTouchCache.clear();
	primaryFilesThisTurn.clear();
	cascadeDiagnosticBaselines.clear();
}

// A5: per-turn neighbor-touch cache keyed by normalized path.
// Avoids re-touching the same neighbor on every write in a multi-file refactor.
// Invalidated when writeSeq advances (i.e. a new write starts a new pipeline run).
type NeighborCacheEntry = {
	turnSeq: number;
	writeSeq: number;
	diagnostics: import("./types.js").Diagnostic[];
};
const neighborTouchCache = new Map<string, NeighborCacheEntry>();

// B10: tracks files that were the *primary* edited file this turn.
// These are excluded from cascade neighbor results — their own pipeline run
// already reported their diagnostics authoritatively.
let cascadeTurnScope = 0;
const primaryFilesThisTurn = new Set<string>();

function ensureCascadeTurnScope(turnSeq: number): void {
	if (turnSeq === cascadeTurnScope) return;
	cascadeTurnScope = turnSeq;
	primaryFilesThisTurn.clear();
	neighborTouchCache.clear();
}

const CASCADE_TTL_MS = 240_000;
const MAX_PER_FILE = RUNTIME_CONFIG.pipeline.cascadeMaxDiagnosticsPerFile;
const MAX_FILES = RUNTIME_CONFIG.pipeline.cascadeMaxFiles;

/**
 * Unified cascade orchestration — builds graph, discovers neighbors, and
 * gathers per-file diagnostics with structured logging to cascade.log.
 *
 * autoPropagate (jsts): tsserver pushes diagnostics automatically, so we
 * read from the passive snapshot instead of touching neighbors actively.
 *
 * Degraded fallback: when the graph produces no neighbors (ungraphed languages
 * like Java/Kotlin/C#), fall back to the passive LSP snapshot from getAllDiagnostics
 * to preserve cascade coverage.
 */
export async function computeCascadeForFile(
	filePath: string,
	cwd: string,
	options: {
		hasBlockers?: boolean;
		dbg?: (msg: string) => void;
		/** Turn/write sequence from RuntimeCoordinator — scopes cascade caches (A5/B10) */
		turnSeq?: number;
		writeSeq?: number;
	} = {},
): Promise<CascadeResult | undefined> {
	const { hasBlockers = false, dbg, turnSeq = 0, writeSeq } = options;

	ensureCascadeTurnScope(turnSeq);

	if (hasBlockers) {
		logCascade({
			phase: "cascade_skip",
			filePath,
			reason: "primary_has_blockers",
		});
		return undefined;
	}

	const normalizedFile = resolveRunnerPath(cwd, filePath);
	const normalizedFileKey = normalizeMapKey(normalizedFile);

	// B10: record this file as a primary edit so later cascade calls in the same
	// turn won't show it as a neighbor.
	primaryFilesThisTurn.add(normalizedFileKey);

	const graphStart = Date.now();
	const graph = await buildOrUpdateGraph(cwd, [normalizedFile], sessionFacts);
	const graphMs = Date.now() - graphStart;

	// Count files represented in the graph (nodes with a filePath).
	const graphFileCount = new Set(
		[...graph.nodes.values()].flatMap((n) => (n.filePath ? [n.filePath] : [])),
	).size;

	const graphBuildInfo = getLastGraphBuildInfo();
	logCascade({
		phase: "graph_build",
		filePath,
		graphBuiltMs: graphMs,
		graphReused: graphBuildInfo.reused,
		graphNodeCount: graph.nodes.size,
		graphFileCount,
		graphChangedSymbolCount: (
			graph.changedSymbolsByFile.get(normalizedFileKey) ?? []
		).length,
		metadata: { graphBuildMode: graphBuildInfo.mode },
	});

	const impact = computeImpactCascade(graph, normalizedFile);

	// Sort by relationship strength (B6) then cap to MAX_FILES.
	// directImporters are most impactful, then callers, then reference edges.
	const importerSet = new Set(impact.directImporters);
	const callerSet = new Set(impact.directCallers);
	// neighbors that are neither direct importers nor callers are reference-edge neighbors
	const importerOrCallerSet = new Set([
		...impact.directImporters,
		...impact.directCallers,
	]);
	const referenceCount = impact.neighborFiles.filter(
		(n) => !importerOrCallerSet.has(n),
	).length;
	const sortedNeighbors = [...impact.neighborFiles]
		.filter((n) => nodeFs.existsSync(n))
		// B10: exclude files already edited as primary this turn — their own pipeline
		// run is the authoritative diagnostic source; showing them as neighbors is noise.
		.filter((n) => !primaryFilesThisTurn.has(normalizeMapKey(n)))
		.sort((a, b) => {
			const rank = (p: string) =>
				importerSet.has(p) ? 0 : callerSet.has(p) ? 1 : 2;
			return rank(a) - rank(b);
		})
		.slice(0, MAX_FILES);

	logCascade({
		phase: "neighbors_computed",
		filePath,
		neighborCount: sortedNeighbors.length,
		totalNeighborCount: impact.neighborFiles.length,
		importerCount: impact.directImporters.length,
		callerCount: impact.directCallers.length,
		referenceCount: Math.max(0, referenceCount),
		riskFlags: impact.riskFlags,
		metadata: { neighbors: sortedNeighbors.slice(0, 10) },
	});

	const lspService = getLSPService();

	// Hoist passive snapshot once — used for auto-propagating LSPs and fallback path.
	const allDiags = await lspService.getAllDiagnostics();

	const neighbors: CascadeResult["neighbors"] = [];
	let producedLspData = false;

	if (sortedNeighbors.length > 0) {
		const snapshotPaths = sortedNeighbors.filter(shouldReadCascadeFromSnapshot);
		const activePaths = sortedNeighbors.filter(
			(n) => !shouldReadCascadeFromSnapshot(n),
		);

		// Auto-propagating LSPs (TypeScript/Deno) — read passive snapshot with normalized key.
		for (const neighborPath of snapshotPaths) {
			const neighborStart = Date.now();
			const entry = allDiags.get(normalizeMapKey(neighborPath));
			const snapshotAgeSec = entry
				? Math.round((Date.now() - entry.ts) / 1000)
				: undefined;
			const snapshotValid =
				entry != null && Date.now() - entry.ts < CASCADE_TTL_MS;
			const diags = snapshotValid
				? convertLspDiagnostics(
						entry.diags.filter((d) => d.severity === 1).slice(0, MAX_PER_FILE),
						neighborPath,
						{ source: "cascade" },
					)
				: [];
			if (snapshotValid) producedLspData = true;
			const durationMs = Date.now() - neighborStart;

			logCascade({
				phase: "neighbor_snapshot",
				filePath,
				neighborFile: neighborPath,
				diagnosticCount: diags.length,
				durationMs,
				autoPropagate: true,
				snapshotMissing: entry == null,
				snapshotAgeSec,
			});

			neighbors.push({
				filePath: neighborPath,
				reason: neighborReason(importerSet, callerSet, neighborPath),
				diagnostics: diags,
				lspTouched: false,
				durationMs,
			});
		}

		// non-jsts: fan-out active touches in parallel (A3), single wait per neighbor.
		// touchFile("none") opens the doc; getDiagnostics waits once for fresh results.
		const touchResults = await Promise.allSettled(
			activePaths.map(async (neighborPath) => {
				const neighborStart = Date.now();
				const cacheKey = normalizeMapKey(neighborPath);

				// A5: skip re-touch if this neighbor was already diagnosed at the current
				// write sequence. A new write (higher writeSeq) invalidates the cache entry.
				const cached =
					writeSeq != null ? neighborTouchCache.get(cacheKey) : undefined;
				if (
					cached != null &&
					cached.turnSeq === turnSeq &&
					cached.writeSeq === writeSeq
				) {
					producedLspData = true;
					const durationMs = Date.now() - neighborStart;
					logCascade({
						phase: "neighbor_snapshot",
						filePath,
						neighborFile: neighborPath,
						diagnosticCount: cached.diagnostics.length,
						durationMs,
						autoPropagate: false,
						snapshotMissing: false,
						metadata: { cachedWriteSeq: writeSeq },
					});
					return {
						filePath: neighborPath,
						reason: neighborReason(importerSet, callerSet, neighborPath),
						diagnostics: cached.diagnostics,
						lspTouched: false,
						durationMs,
					} satisfies CascadeResult["neighbors"][number];
				}

				const configuredServerCount =
					getServersForFileWithConfig(neighborPath).length;
				if (configuredServerCount === 0) {
					logCascade({
						phase: "neighbor_fallback",
						filePath,
						neighborFile: neighborPath,
						fallbackUsed: false,
						error: "no_lsp_server_configured",
					});
					return undefined;
				}

				// A6: async read to avoid blocking event loop on network-mounted drives
				const content = await nodeFs.promises.readFile(neighborPath, "utf8");
				// Open with silent=true (suppresses didChangeWatchedFiles rechecks, C2)
				// and collect diagnostics from the same touched clients.
				const rawDiags = await lspService.touchFile(neighborPath, content, {
					diagnostics: "document",
					collectDiagnostics: true,
					maxClientWaitMs: 2000,
					silent: true,
					source: "cascade",
					clientScope: "all",
				});
				if (!rawDiags) return undefined;
				const diags = convertLspDiagnostics(
					rawDiags.filter((d) => d.severity === 1).slice(0, MAX_PER_FILE),
					neighborPath,
					{ source: "cascade" },
				);
				const durationMs = Date.now() - neighborStart;

				// Update cache for this neighbor at the current write sequence
				if (writeSeq != null) {
					neighborTouchCache.set(cacheKey, {
						turnSeq,
						writeSeq,
						diagnostics: diags,
					});
				}
				producedLspData = true;

				logCascade({
					phase: "neighbor_touch",
					filePath,
					neighborFile: neighborPath,
					diagnosticCount: diags.length,
					durationMs,
					lspTouched: true,
					lspServerCount: configuredServerCount,
				});

				return {
					filePath: neighborPath,
					reason: neighborReason(importerSet, callerSet, neighborPath),
					diagnostics: diags,
					lspTouched: true as const,
					durationMs,
				} satisfies CascadeResult["neighbors"][number];
			}),
		);

		for (let i = 0; i < touchResults.length; i++) {
			const result = touchResults[i];
			const neighborPath = activePaths[i];
			if (result.status === "fulfilled") {
				if (result.value) neighbors.push(result.value);
			} else {
				// A3: one failed LSP doesn't kill the rest — fall back to passive snapshot
				dbg?.(
					`cascade neighbor touch error for ${neighborPath}: ${result.reason}`,
				);
				logCascade({
					phase: "neighbor_fallback",
					filePath,
					neighborFile: neighborPath,
					fallbackUsed: true,
					error: String(result.reason),
				});
				const entry = allDiags.get(normalizeMapKey(neighborPath));
				const diags =
					entry && Date.now() - entry.ts < CASCADE_TTL_MS
						? convertLspDiagnostics(
								entry.diags
									.filter((d) => d.severity === 1)
									.slice(0, MAX_PER_FILE),
								neighborPath,
								{ source: "cascade" },
							)
						: [];
				neighbors.push({
					filePath: neighborPath,
					reason: "fallback",
					diagnostics: diags,
					lspTouched: false,
				});
			}
		}
	}

	// CR-3/A2: degraded fallback when no neighbor produced trustworthy LSP data —
	// not merely when the graph returned zero neighbors.
	if (!producedLspData) {
		appendFallbackNeighbors(neighbors, allDiags, normalizedFileKey);
		if (neighbors.some((n) => n.reason === "fallback")) {
			logCascade({
				phase: "neighbor_fallback",
				filePath,
				fallbackUsed: true,
				neighborCount: neighbors.length,
			});
		}
	}

	const visibleNeighbors = applyCascadeDeltaBaselines(neighbors);

	const formatted = formatCascadeResult(
		cwd,
		impact,
		visibleNeighbors,
		impact.neighborFiles.length,
	);

	const filesWithErrors = visibleNeighbors.filter(
		(n) => n.diagnostics.length > 0,
	).length;
	logCascade({
		phase: "cascade_result",
		filePath,
		neighborCount: visibleNeighbors.length,
		diagnosticCount: visibleNeighbors.reduce(
			(sum, n) => sum + n.diagnostics.length,
			0,
		),
		metadata: {
			filesWithErrors,
			hasOutput: formatted.length > 0,
			// Log when cascade ran but found nothing — distinguishes "clean" from "no signal"
			noNeighbors: visibleNeighbors.length === 0,
			noErrors: visibleNeighbors.length > 0 && filesWithErrors === 0,
		},
	});

	if (!formatted) return undefined;

	getDiagnosticTracker().trackShown(
		visibleNeighbors.flatMap((n) => n.diagnostics),
	);

	return { filePath, impact, neighbors: visibleNeighbors, formatted };
}

function diagnosticDeltaKey(
	diagnostic: import("./types.js").Diagnostic,
): string {
	return [
		diagnostic.id,
		diagnostic.rule ?? "",
		diagnostic.line ?? 0,
		diagnostic.column ?? 0,
		diagnostic.message,
	].join(":");
}

function applyCascadeDeltaBaselines(
	neighbors: CascadeResult["neighbors"],
): CascadeResult["neighbors"] {
	return neighbors.map((neighbor) => {
		const baselineKey = `session.baseline.cascade.${normalizeMapKey(neighbor.filePath)}`;
		const previous =
			cascadeDiagnosticBaselines.get(baselineKey) ??
			sessionFacts.getSessionFact<import("./types.js").Diagnostic[]>(
				baselineKey,
			);
		cascadeDiagnosticBaselines.set(baselineKey, [...neighbor.diagnostics]);
		sessionFacts.setSessionFact(baselineKey, [...neighbor.diagnostics]);
		if (!previous) return neighbor;
		const before = new Set(previous.map(diagnosticDeltaKey));
		return {
			...neighbor,
			diagnostics: neighbor.diagnostics.filter(
				(diagnostic) => !before.has(diagnosticDeltaKey(diagnostic)),
			),
		};
	});
}

function appendFallbackNeighbors(
	neighbors: CascadeResult["neighbors"],
	allDiags: Map<
		string,
		{ diags: import("../lsp/client.js").LSPDiagnostic[]; ts: number }
	>,
	normalizedFileKey: string,
): void {
	const now = Date.now();
	const seen = new Set(neighbors.map((n) => normalizeMapKey(n.filePath)));
	for (const [diagPath, { diags, ts }] of allDiags) {
		const diagKey = normalizeMapKey(diagPath);
		if (diagKey === normalizedFileKey || seen.has(diagKey)) continue;
		if (!nodeFs.existsSync(diagPath)) continue;
		if (now - ts > CASCADE_TTL_MS) continue;
		const errors = convertLspDiagnostics(
			diags.filter((d) => d.severity === 1).slice(0, MAX_PER_FILE),
			diagPath,
			{ source: "cascade" },
		);
		if (errors.length === 0) continue;
		neighbors.push({
			filePath: diagPath,
			reason: "fallback",
			diagnostics: errors,
			lspTouched: false,
		});
		seen.add(diagKey);
		if (neighbors.length >= MAX_FILES) break;
	}
}

function shouldReadCascadeFromSnapshot(filePath: string): boolean {
	return getServersForFileWithConfig(filePath).some(
		(server) => server.autoPropagateDiagnostics === true,
	);
}

function neighborReason(
	importerSet: Set<string>,
	callerSet: Set<string>,
	neighborPath: string,
): CascadeResult["neighbors"][number]["reason"] {
	if (importerSet.has(neighborPath)) return "imports";
	if (callerSet.has(neighborPath)) return "calls";
	return "references";
}

function formatCascadeResult(
	cwd: string,
	impact: ReturnType<typeof computeImpactCascade>,
	neighbors: CascadeResult["neighbors"],
	totalNeighbors: number,
): string {
	const diagnosticsBlock = formatCascadeNeighborDiagnostics(cwd, neighbors, {
		noun: "neighbor",
		includeReason: true,
	});
	if (!diagnosticsBlock) return "";

	const impactHeader = formatImpactCascade(impact);
	let out = impactHeader
		? `${impactHeader}\n${diagnosticsBlock}`
		: diagnosticsBlock;

	// A10: include truncated filenames so agent knows which files were cut
	const truncated = totalNeighbors - neighbors.length;
	if (truncated > 0) {
		const truncatedNames = impact.neighborFiles
			.slice(neighbors.length, neighbors.length + 3)
			.map((p) => toRunnerDisplayPath(cwd, p))
			.join(", ");
		const moreLabel = truncatedNames
			? `${truncated} more dependent file(s): ${truncatedNames}`
			: `${truncated} more dependent file(s)`;
		out += `\n... and ${moreLabel}`;
	}

	return out;
}

/**
 * Run linting for a file using the declarative dispatch system
 *
 * @param filePath - Path to the file to lint
 * @param cwd - Project root directory
 * @param pi - Pi agent API (for flags)
 * @returns Output string to display to user
 */
export async function dispatchLint(
	filePath: string,
	cwd: string,
	pi: PiAgentAPI,
	modifiedRanges?: ModifiedRange[],
): Promise<string> {
	// By default, only run BLOCKING rules for fast feedback on file write
	// Uses persistent sessionBaselines so delta mode actually filters
	// pre-existing issues after the first write.
	const ctx = createDispatchContext(
		filePath,
		cwd,
		pi,
		sessionFacts,
		true,
		modifiedRanges,
	);
	sessionFacts.clearFileFactsFor(ctx.filePath);

	const kind = ctx.kind;
	if (!kind) return "";

	const groups = getDispatchGroupsForKind(kind, pi);
	if (groups.length === 0) return "";

	await runProviders(ctx);
	const result = await dispatchForFile(ctx, groups, sessionRunnerRegistry);
	trackSessionSlopStats(ctx, result.diagnostics);
	return result.output;
}

/**
 * Run linting and return full result (including diagnostics)
 */
export async function dispatchLintWithResult(
	filePath: string,
	cwd: string,
	pi: PiAgentAPI,
	modifiedRanges?: ModifiedRange[],
	logContext?: LogContext,
): Promise<DispatchResult> {
	const ctx = createDispatchContext(
		filePath,
		cwd,
		pi,
		sessionFacts,
		true,
		modifiedRanges,
	);
	sessionFacts.clearFileFactsFor(ctx.filePath);

	const kind = ctx.kind;
	if (!kind) {
		return {
			diagnostics: [],
			blockers: [],
			warnings: [],
			baselineWarningCount: 0,
			fixed: [],
			resolvedCount: 0,
			output: "",
			hasBlockers: false,
		};
	}

	const groups = getDispatchGroupsForKind(kind, pi);
	if (groups.length === 0) {
		return {
			diagnostics: [],
			blockers: [],
			warnings: [],
			baselineWarningCount: 0,
			fixed: [],
			resolvedCount: 0,
			output: "",
			hasBlockers: false,
		};
	}

	await runProviders(ctx);
	const result = await dispatchForFile(ctx, groups, sessionRunnerRegistry);
	trackSessionSlopStats(ctx, result.diagnostics);

	// Schedule debounced ast-grep warning scan for jsts files.
	// Runs 2s after the last write — collapses rapid sequential edits into one scan.
	// Results are logged only, never surfaced to the agent.
	if (kind === "jsts" && logContext) {
		scheduleAstGrepWarningScan(filePath, cwd, pi, logContext);
	}

	return result;
}

/**
 * Check if a file should be processed by the dispatcher
 * based on the file kind
 */
export function shouldDispatch(filePath: string): boolean {
	const kind = detectFileKind(filePath);
	return kind !== undefined;
}

/**
 * Get list of available runners for a file
 */
export async function getAvailableRunners(filePath: string): Promise<string[]> {
	const kind = detectFileKind(filePath);
	if (!kind) return [];

	const normalizedPath = filePath.replace(/\\/g, "/");
	const pathForFilter = normalizedPath.startsWith("/")
		? normalizedPath
		: `/${normalizedPath}`;
	const runners = sessionRunnerRegistry.getForKind(kind, pathForFilter);
	return runners.map((r) => r.id);
}
