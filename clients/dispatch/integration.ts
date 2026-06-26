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
	type RunnerResultSink,
} from "./dispatcher.js";
import { FactStore } from "./fact-store.js";
import { TOOL_PLANS } from "./plan.js";
import type {
	DispatchResult,
	ModifiedRange,
	PiAgentAPI,
	RunnerGroup,
	RunnerResult,
} from "./types.js";

export type { DispatchLatencyReport, RunnerLatency };
// Re-export latency tracking types and functions
export { clearLatencyReports, formatLatencyReport, getLatencyReports };

import * as nodeFs from "node:fs";
import { fileURLToPath } from "node:url";
import { formatCascadeNeighborDiagnostics } from "../cascade-format.js";
import { logCascade } from "../cascade-logger.js";
import type {
	CascadeResult,
	CascadeRun,
	CascadeSkipReason,
} from "../cascade-types.js";
import { getDiagnosticTracker } from "../diagnostic-tracker.js";
import { getServersForFileWithConfig } from "../lsp/config.js";
import { getLSPService } from "../lsp/index.js";
import { isExternalOrVendorFile, normalizeMapKey } from "../path-utils.js";
import { getProjectIgnoreMatcher } from "../file-utils.js";
import {
	clearReviewGraphWorkspaceCache,
	getLastGraphBuildInfo,
} from "../review-graph/builder.js";
import {
	buildReverseDependencyIndexFromGraph,
	getAffectedFilesFromIndex,
	writeReverseDependencyIndexToSnapshot,
} from "../reverse-deps.js";
import {
	buildOrUpdateGraph,
	computeImpactCascade,
	computeTransitiveImpact,
	formatImpactCascade,
} from "../review-graph/service.js";
import { clearModuleGraphCache } from "../review-graph/workspace-modules.js";
import { RUNTIME_CONFIG } from "../runtime-config.js";
import {
	findCompiledClassesDir,
	hasJavaBuildDescriptor,
} from "../tool-policy.js";
// Register fact providers
import { registerProvider, runProviders } from "./fact-runner.js";
import { fileContentProvider } from "./facts/file-content.js";
import { resolveRunnerPath, toRunnerDisplayPath } from "./runner-context.js";
import { registerDefaultRunners } from "./runners/index.js";
import { convertLspDiagnostics } from "./utils/lsp-diagnostics.js";

registerProvider(fileContentProvider);

// The TypeScript-compiler-backed fact providers (try-catch / function / comment
// / import) are registered lazily by ensureTypeScriptDispatchUnits() in
// fact-runner, the first time a dispatch runs — keeping `typescript` out of the
// eager entry graph so an unresolved-dep failure degrades instead of crashing
// the extension at load (#285/#335).

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
import { unsafeBoundaryRule } from "./rules/unsafe-boundary.js";
import {
	loadPiLensProjectConfig,
	type PiLensProjectConfig,
} from "../project-lens-config.js";

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
// quality-rules + sonar-rules (TypeScript-compiler-backed) are registered lazily
// by ensureTypeScriptDispatchUnits() in fact-runner — see the note above.

/**
 * Load a project's `.pi-lens.json` config.
 *
 * Rule thresholds are consumed from `DispatchContext.projectConfig` during rule
 * evaluation, not applied to process-global module state. Keeping this helper as
 * a thin loader preserves the existing integration seam while avoiding
 * cross-workspace threshold bleed when multiple dispatches overlap.
 */
export function applyProjectLensConfig(cwd: string): PiLensProjectConfig {
	return loadPiLensProjectConfig(cwd);
}

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

// SpotBugs analyzes JVM bytecode, so it applies to java + kotlin. Opt-in
// (lens-spotbugs flag) and only when a Java build descriptor + compiled .class
// dir exist — the runner itself mtime-caches so it doesn't re-run per keystroke. #133
const SPOTBUGS_SUPPORTED_KINDS = new Set<FileKind>(["java", "kotlin"]);

function withSpotbugsGroup(
	kind: FileKind,
	groups: RunnerGroup[],
	ctx: ReturnType<typeof createDispatchContext>,
): RunnerGroup[] {
	if (!SPOTBUGS_SUPPORTED_KINDS.has(kind)) return groups;
	if (!ctx.pi.getFlag("lens-spotbugs")) return groups;
	if (!hasJavaBuildDescriptor(ctx.cwd) || !findCompiledClassesDir(ctx.cwd)) {
		return groups;
	}
	if (groups.some((group) => group.runnerIds.includes("spotbugs")))
		return groups;
	return [
		...groups,
		{
			mode: "all",
			runnerIds: ["spotbugs"],
			filterKinds: [kind],
			semantic: "warning",
		},
	];
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
 *
 * Pass `cwd` to also re-apply the project's `.pi-lens.json` rule thresholds
 * (a no-op when the file is absent or unchanged, since the loader is
 * mtime-cached). Optional for backward compatibility with tests that don't
 * care about per-project thresholds.
 */
export function resetDispatchBaselines(cwd?: string): void {
	if (cwd) applyProjectLensConfig(cwd);
	sessionFacts.clearAll();
	resetSessionSlopScore();
	clearCoverageNoticeState();
	clearReviewGraphWorkspaceCache();
	clearModuleGraphCache();
	neighborTouchCache.clear();
	recentlyCleanNeighborCache.clear();
	primaryFilesThisTurn.clear();
	cascadeDiagnosticBaselines.clear();
	cascadeSessionStats = {
		runs: 0,
		diagnosticsSurfaced: 0,
		coldSnapshotTouches: 0,
	};
	for (const timer of astGrepWarnDebounceTimers.values()) clearTimeout(timer);
	astGrepWarnDebounceTimers.clear();
}

let cascadeSessionStats = {
	runs: 0,
	diagnosticsSurfaced: 0,
	coldSnapshotTouches: 0,
};

export function getCascadeSessionStats(): {
	runs: number;
	diagnosticsSurfaced: number;
	coldSnapshotTouches: number;
} {
	return { ...cascadeSessionStats };
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

// Cross-turn clean cache: neighbor touches that recently returned no errors can
// be skipped for a few turns. LSP servers push diagnostics proactively when a
// file becomes unhealthy, so repeatedly re-opening known-clean neighbors is low value.
type RecentlyCleanNeighborEntry = { turnSeq: number; checkedAt: number };
const recentlyCleanNeighborCache = new Map<
	string,
	RecentlyCleanNeighborEntry
>();
const RECENTLY_CLEAN_TTL_TURNS = 5;

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
	for (const [key, entry] of recentlyCleanNeighborCache) {
		if (turnSeq - entry.turnSeq > RECENTLY_CLEAN_TTL_TURNS) {
			recentlyCleanNeighborCache.delete(key);
		}
	}
}

const CASCADE_TTL_MS = 240_000;
const MAX_PER_FILE = RUNTIME_CONFIG.pipeline.cascadeMaxDiagnosticsPerFile;
const MAX_FILES = RUNTIME_CONFIG.pipeline.cascadeMaxFiles;

// Bounded transitive cascade (#162): expand neighbour derivation beyond the
// one-hop importers/callers to depth-2 dependents, so an edit's blast radius
// reaches indirect dependents — capped so the per-edit cost stays bounded. The
// one-hop set is always the floor (it sorts first, before depth-2). Both
// env-tunable; set depth to 1 to restore the old one-hop-only behaviour.
const CASCADE_TRANSITIVE_DEPTH = Math.max(
	1,
	Number.parseInt(process.env.PI_LENS_CASCADE_TRANSITIVE_DEPTH ?? "2", 10) || 2,
);
const CASCADE_NEIGHBOUR_BUDGET = Math.max(
	MAX_FILES,
	Number.parseInt(process.env.PI_LENS_CASCADE_NEIGHBOUR_BUDGET ?? "40", 10) ||
		40,
);
const CASCADE_GRAPH_KINDS = new Set([
	"jsts",
	"python",
	"go",
	"rust",
	"ruby",
	"cxx",
]);

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
/**
 * Whether a cascade neighbour is suppressed by the project's ignore config
 * (`.pi-lens.json` / `.gitignore` / global `~/.pi-lens/config.json`), via the
 * same `getProjectIgnoreMatcher` every other scan surface uses. Cascade surfaces
 * collateral diagnostics in OTHER files an edit touched; a file the user ignores
 * (e.g. a `*.test.ts` glob in `.pi-lens.json`) must not be re-surfaced here just
 * because it imports the edited file — project walk and lens_diagnostics already
 * filter it, and cascade was the last surface that didn't (#297). Fail-open: a
 * config-probe error never drops a neighbour, matching the walkers' behaviour.
 */
function isIgnoredCascadeNeighbor(filePath: string, cwd: string): boolean {
	try {
		return getProjectIgnoreMatcher(cwd).isIgnored(filePath, false);
	} catch {
		return false;
	}
}

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
): Promise<CascadeRun> {
	const { hasBlockers = false, dbg, turnSeq = 0, writeSeq } = options;

	ensureCascadeTurnScope(turnSeq);

	if (hasBlockers) {
		logCascade({
			phase: "cascade_skip",
			filePath,
			reason: "primary_has_blockers",
		});
		return {
			filePath,
			result: undefined,
			neighborCount: 0,
			diagnosticCount: 0,
			skipReason: "blockers" as CascadeSkipReason,
		};
	}

	const fileKind = detectFileKind(filePath);
	if (!fileKind) {
		logCascade({ phase: "cascade_skip", filePath, reason: "non_code_file" });
		return {
			filePath,
			result: undefined,
			neighborCount: 0,
			diagnosticCount: 0,
			skipReason: "non_code" as CascadeSkipReason,
		};
	}

	const normalizedFile = resolveRunnerPath(cwd, filePath);
	const normalizedFileKey = normalizeMapKey(normalizedFile);

	// B10: record this file as a primary edit so later cascade calls in the same
	// turn won't show it as a neighbor.
	primaryFilesThisTurn.add(normalizedFileKey);

	let impact: ReturnType<typeof computeImpactCascade> = {
		filePath: normalizedFile,
		changedSymbols: [],
		directImporters: [],
		directCallers: [],
		neighborFiles: [],
		riskFlags: [],
	};
	let sortedNeighbors: string[] = [];
	let importerSet = new Set<string>();
	let callerSet = new Set<string>();
	let referenceCount = 0;

	if (CASCADE_GRAPH_KINDS.has(fileKind)) {
		const graphStart = Date.now();
		const graph = await buildOrUpdateGraph(cwd, [normalizedFile], sessionFacts);
		const graphMs = Date.now() - graphStart;
		const reverseDepsIndex = buildReverseDependencyIndexFromGraph({
			cwd,
			graph,
		});
		const reverseDepsSaved = writeReverseDependencyIndexToSnapshot({
			cwd,
			index: reverseDepsIndex,
			dbg,
		});
		logCascade({
			phase: "reverse_deps_cache",
			filePath,
			durationMs: Date.now() - graphStart,
			metadata: {
				action: "refresh_from_review_graph",
				savedToSnapshot: reverseDepsSaved,
				importsFileCount: Object.keys(reverseDepsIndex.imports).length,
				importedByFileCount: Object.keys(reverseDepsIndex.importedBy).length,
				importEdgeCount: Object.values(reverseDepsIndex.imports).reduce(
					(total, imports) => total + imports.length,
					0,
				),
			},
		});

		// Count files represented in the graph (nodes with a filePath).
		const graphFileCount = new Set(
			[...graph.nodes.values()].flatMap((n) =>
				n.filePath ? [n.filePath] : [],
			),
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
			metadata: {
				graphBuildMode: graphBuildInfo.mode,
				skipReason: graphBuildInfo.skipReason,
				sourceFileCount: graphBuildInfo.sourceFileCount,
				maxFileCount: graphBuildInfo.maxFileCount,
			},
		});

		impact = computeImpactCascade(graph, normalizedFile, cwd);
		const reverseDepNeighbors = getAffectedFilesFromIndex(
			reverseDepsIndex,
			normalizedFile,
			1,
			MAX_FILES * 2,
		);
		logCascade({
			phase: "reverse_deps_cache",
			filePath,
			metadata: {
				action: "merge_neighbors",
				depth: 1,
				neighborCount: reverseDepNeighbors.length,
				neighbors: reverseDepNeighbors.slice(0, 10),
			},
		});
		if (reverseDepNeighbors.length > 0) {
			impact.directImporters = [
				...new Set([...impact.directImporters, ...reverseDepNeighbors]),
			];
			impact.neighborFiles = [
				...new Set([...impact.neighborFiles, ...reverseDepNeighbors]),
			];
			logCascade({
				phase: "neighbor_snapshot",
				filePath,
				neighborFile: "[reverse-deps-cache]",
				diagnosticCount: reverseDepNeighbors.length,
				autoPropagate: false,
				metadata: { reverseDepsCache: true },
			});
		}

		// Symbol-level blast radius via LSP references (precision upgrade over
		// file-level import edges). Only when changed symbols are detected.
		// Keep the budget tight: 750ms per symbol, 1200ms total, max 3 symbols.
		if (impact.changedSymbols.length > 0) {
			const lspService = getLSPService();
			const symbolNodeIds =
				graph.symbolNodesByFile.get(normalizedFileKey) ?? [];
			const refFiles = new Set<string>();
			const refsStart = Date.now();
			for (const symbolName of impact.changedSymbols.slice(0, 3)) {
				const symbolNodeId = symbolNodeIds.find((id) => {
					const node = graph.nodes.get(id);
					return node?.symbolName === symbolName;
				});
				if (!symbolNodeId) continue;
				const node = graph.nodes.get(symbolNodeId);
				const line = Number(node?.metadata?.line ?? 0);
				const column = Number(node?.metadata?.column ?? 0);
				if (line <= 0) continue;
				try {
					const refs = await Promise.race([
						lspService.references(normalizedFile, line - 1, column - 1, false),
						new Promise<never>((_, reject) =>
							setTimeout(() => reject(new Error("timeout")), 750),
						),
					]);
					for (const ref of refs) {
						let resolved: string;
						try {
							resolved = ref.uri.startsWith("file://")
								? fileURLToPath(ref.uri)
								: ref.uri;
						} catch {
							continue;
						}
						if (
							normalizeMapKey(resolved) !== normalizedFileKey &&
							nodeFs.existsSync(resolved)
						) {
							refFiles.add(normalizeMapKey(resolved));
						}
					}
				} catch {
					// Timeout or LSP error — fall back to import-graph neighbors
				}
				if (Date.now() - refsStart > 1200) break; // Hard ceiling
			}
			if (refFiles.size > 0) {
				impact.neighborFiles = [
					...new Set([...impact.neighborFiles, ...refFiles]),
				];
				logCascade({
					phase: "neighbor_snapshot",
					filePath,
					neighborFile: "[lsp-references]",
					diagnosticCount: refFiles.size,
					durationMs: Date.now() - refsStart,
					autoPropagate: false,
					metadata: { lspReferences: true },
				});
			}
		}

		// Bounded transitive expansion: add depth>1 dependents (indirect
		// importers/callers/referencers) so the blast radius isn't limited to one
		// hop. The one-hop sets above remain the floor (they sort first); these
		// fill the remaining budget. Graph BFS is in-memory + capped.
		if (CASCADE_TRANSITIVE_DEPTH > 1) {
			const transitive = computeTransitiveImpact(graph, normalizedFile, {
				maxDepth: CASCADE_TRANSITIVE_DEPTH,
				maxHits: CASCADE_NEIGHBOUR_BUDGET,
			});
			const added = [
				...new Set(
					transitive.hits
						.map((hit) => hit.file)
						.filter(
							(file) => file && normalizeMapKey(file) !== normalizedFileKey,
						),
				),
			].filter((file) => !impact.neighborFiles.includes(file));
			if (added.length > 0) {
				impact.neighborFiles = [...impact.neighborFiles, ...added];
				logCascade({
					phase: "neighbor_snapshot",
					filePath,
					neighborFile: "[transitive-impact]",
					diagnosticCount: added.length,
					autoPropagate: false,
					metadata: {
						transitive: true,
						maxDepth: CASCADE_TRANSITIVE_DEPTH,
						maxDepthReached: transitive.maxDepthReached,
						truncated: transitive.truncated,
					},
				});
			}
		}

		// Sort by relationship strength (B6) then cap to the neighbour budget.
		// directImporters are most impactful, then callers, then reference edges.
		importerSet = new Set(impact.directImporters);
		callerSet = new Set(impact.directCallers);
		// neighbors that are neither direct importers nor callers are reference-edge neighbors
		const importerOrCallerSet = new Set([
			...impact.directImporters,
			...impact.directCallers,
		]);
		referenceCount = impact.neighborFiles.filter(
			(n) => !importerOrCallerSet.has(n),
		).length;
		sortedNeighbors = [...impact.neighborFiles]
			.filter((n) => nodeFs.existsSync(n))
			.filter((n) => !isExternalOrVendorFile(n, cwd))
			// Honour the project's ignore config: a user-ignored neighbour (e.g.
			// `**/*.test.ts`) must not surface as collateral cascade noise (#297).
			.filter((n) => !isIgnoredCascadeNeighbor(n, cwd))
			// B10: exclude files already edited as primary this turn — their own pipeline
			// run is the authoritative diagnostic source; showing them as neighbors is noise.
			.filter((n) => !primaryFilesThisTurn.has(normalizeMapKey(n)))
			.sort((a, b) => {
				const rank = (p: string) =>
					importerSet.has(p) ? 0 : callerSet.has(p) ? 1 : 2;
				return rank(a) - rank(b);
			})
			.slice(0, CASCADE_NEIGHBOUR_BUDGET);
	} else {
		logCascade({
			phase: "cascade_skip",
			filePath,
			reason: "unsupported_graph_kind",
			metadata: { fileKind },
		});
		return {
			filePath,
			result: undefined,
			neighborCount: 0,
			diagnosticCount: 0,
			skipReason: "non_code" as CascadeSkipReason,
		};
	}

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
	let coldSnapshotPaths: string[] = [];

	if (sortedNeighbors.length > 0) {
		const snapshotPaths = sortedNeighbors.filter(shouldReadCascadeFromSnapshot);
		const activePaths = sortedNeighbors.filter(
			(n) => !shouldReadCascadeFromSnapshot(n),
		);

		// Auto-propagating LSPs (TypeScript/Deno) — read passive snapshot with normalized key.
		// When the snapshot is valid, use it immediately (no touch needed — server already has
		// fresh data from auto-propagation). When missing or stale, fall through to the active
		// touch pool below so we get real diagnostics instead of silently returning zero.
		coldSnapshotPaths = [];
		for (const neighborPath of snapshotPaths) {
			const neighborStart = Date.now();
			const entry = allDiags.get(normalizeMapKey(neighborPath));
			const snapshotAgeSec = entry
				? Math.round((Date.now() - entry.ts) / 1000)
				: undefined;
			const snapshotValid =
				entry != null && Date.now() - entry.ts < CASCADE_TTL_MS;

			if (!snapshotValid) {
				// No usable snapshot — queue for active touch alongside non-jsts neighbors.
				logCascade({
					phase: "neighbor_snapshot",
					filePath,
					neighborFile: neighborPath,
					diagnosticCount: 0,
					durationMs: Date.now() - neighborStart,
					autoPropagate: true,
					snapshotMissing: entry == null,
					snapshotAgeSec,
					coldSnapshot: true,
				});
				coldSnapshotPaths.push(neighborPath);
				continue;
			}

			const diags = convertLspDiagnostics(
				entry.diags.filter((d) => d.severity === 1).slice(0, MAX_PER_FILE),
				neighborPath,
				{ source: "cascade" },
			);
			producedLspData = true;
			const durationMs = Date.now() - neighborStart;

			logCascade({
				phase: "neighbor_snapshot",
				filePath,
				neighborFile: neighborPath,
				diagnosticCount: diags.length,
				durationMs,
				autoPropagate: true,
				snapshotMissing: false,
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

		// fan-out active touches in parallel (A3):
		// - non-jsts neighbors (always touched)
		// - autoPropagate neighbors whose snapshot was missing/stale (coldSnapshotPaths)
		//   use a tighter 1000ms budget since the server is expected to be warm already.
		const touchResults = await Promise.allSettled(
			[...activePaths, ...coldSnapshotPaths].map(async (neighborPath) => {
				const isColdSnapshot = coldSnapshotPaths.includes(neighborPath);
				const neighborStart = Date.now();
				const cacheKey = normalizeMapKey(neighborPath);

				const passiveEntry = allDiags.get(cacheKey);
				const hasFreshPassiveErrors =
					passiveEntry != null &&
					Date.now() - passiveEntry.ts < CASCADE_TTL_MS &&
					passiveEntry.diags.some((d) => d.severity === 1);
				const recentlyClean = recentlyCleanNeighborCache.get(cacheKey);
				if (
					recentlyClean &&
					turnSeq - recentlyClean.turnSeq <= RECENTLY_CLEAN_TTL_TURNS &&
					!hasFreshPassiveErrors
				) {
					producedLspData = true;
					const durationMs = Date.now() - neighborStart;
					logCascade({
						phase: "neighbor_snapshot",
						filePath,
						neighborFile: neighborPath,
						diagnosticCount: 0,
						durationMs,
						autoPropagate: false,
						snapshotMissing: false,
						metadata: {
							recentlyClean: true,
							cleanTurnSeq: recentlyClean.turnSeq,
						},
					});
					return {
						filePath: neighborPath,
						reason: neighborReason(importerSet, callerSet, neighborPath),
						diagnostics: [],
						lspTouched: false,
						durationMs,
					} satisfies CascadeResult["neighbors"][number];
				}

				// A5: skip re-touch if this neighbor was already diagnosed at the current
				// write sequence. A new write (higher writeSeq) invalidates the cache entry.
				const cached =
					writeSeq != null ? neighborTouchCache.get(cacheKey) : undefined;
				if (cached?.turnSeq === turnSeq && cached?.writeSeq === writeSeq) {
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
				// Cold-snapshot neighbors (autoPropagate LSP, server warm) use a tighter
				// 1000ms budget — they should respond quickly; we'd rather return zero
				// than block cascade for 2s on a slow open.
				const rawDiags = await lspService.touchFile(neighborPath, content, {
					diagnostics: "document",
					collectDiagnostics: true,
					maxClientWaitMs: isColdSnapshot ? 1000 : 2000,
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
				if (diags.length === 0) {
					recentlyCleanNeighborCache.set(cacheKey, {
						turnSeq,
						checkedAt: Date.now(),
					});
				} else {
					recentlyCleanNeighborCache.delete(cacheKey);
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
					coldSnapshot: isColdSnapshot,
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

		const allTouchPaths = [...activePaths, ...coldSnapshotPaths];
		for (let i = 0; i < touchResults.length; i++) {
			const result = touchResults[i];
			const neighborPath = allTouchPaths[i];
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
		appendFallbackNeighbors(neighbors, allDiags, normalizedFileKey, cwd);
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
			neighbors: visibleNeighbors.slice(0, 10).map((n) => ({
				file: n.filePath.replace(/\\/g, "/").split("/").slice(-2).join("/"),
				diagnostics: n.diagnostics.length,
			})),
		},
	});

	const diagCount = visibleNeighbors.reduce(
		(sum, n) => sum + n.diagnostics.length,
		0,
	);

	cascadeSessionStats.runs += 1;
	cascadeSessionStats.diagnosticsSurfaced += diagCount;
	cascadeSessionStats.coldSnapshotTouches += coldSnapshotPaths.length;

	if (!formatted) {
		const skipReason: CascadeSkipReason =
			visibleNeighbors.length === 0 ? "no_neighbors" : "clean";
		return {
			filePath,
			result: undefined,
			neighborCount: visibleNeighbors.length,
			diagnosticCount: diagCount,
			skipReason,
		};
	}

	getDiagnosticTracker().trackShown(
		visibleNeighbors.flatMap((n) => n.diagnostics),
	);

	return {
		filePath,
		result: { filePath, impact, neighbors: visibleNeighbors, formatted },
		neighborCount: visibleNeighbors.length,
		diagnosticCount: diagCount,
	};
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
	cwd: string,
): void {
	const now = Date.now();
	const seen = new Set(neighbors.map((n) => normalizeMapKey(n.filePath)));
	for (const [diagPath, { diags, ts }] of allDiags) {
		const diagKey = normalizeMapKey(diagPath);
		if (diagKey === normalizedFileKey || seen.has(diagKey)) continue;
		if (primaryFilesThisTurn.has(diagKey)) continue;
		if (isExternalOrVendorFile(diagPath, cwd)) continue;
		if (isIgnoredCascadeNeighbor(diagPath, cwd)) continue;
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

	const impactHeader = formatImpactCascade(
		impact,
		RUNTIME_CONFIG.pipeline.cascadeMaxFiles,
	);
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

	const groups = withSpotbugsGroup(
		kind,
		getDispatchGroupsForKind(kind, pi),
		ctx,
	);
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
	options?: { blockingOnly?: boolean },
): Promise<DispatchResult> {
	// Default true preserves the per-edit fast path (errors only). Callers that
	// want the full picture (warnings + structural smells), e.g. the MCP review
	// facade, pass blockingOnly=false to run every runner.
	const ctx = createDispatchContext(
		filePath,
		cwd,
		pi,
		sessionFacts,
		options?.blockingOnly ?? true,
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
			blockerOutput: "",
			hasBlockers: false,
		};
	}

	const groups = withSpotbugsGroup(
		kind,
		getDispatchGroupsForKind(kind, pi),
		ctx,
	);
	if (groups.length === 0) {
		return {
			diagnostics: [],
			blockers: [],
			warnings: [],
			baselineWarningCount: 0,
			fixed: [],
			resolvedCount: 0,
			output: "",
			blockerOutput: "",
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

/** Per-runner outcome captured while driving the real dispatch path. */
export interface RunnerOutcome {
	runnerId: string;
	result: RunnerResult;
}

/**
 * Same real dispatch path as {@link dispatchLintWithResult} (real context, real
 * file-kind→runner selection, real `run()` → spawn → tool), but also returns
 * each runner's exact `RunnerResult` (status + `failureKind` + diagnostics) via
 * the `onRunnerResult` sink. The live tool-smoke harness (#209) uses this to
 * assert each supported tool spawned and exited cleanly without re-implementing
 * dispatch's selection/gating. Defaults to `blockingOnly: false` so every
 * applicable runner (not just blocking ones) executes.
 */
export async function dispatchLintDetailed(
	filePath: string,
	cwd: string,
	pi: PiAgentAPI,
	options?: { blockingOnly?: boolean; modifiedRanges?: ModifiedRange[] },
): Promise<{ result: DispatchResult; runners: RunnerOutcome[] }> {
	const empty: DispatchResult = {
		diagnostics: [],
		blockers: [],
		warnings: [],
		baselineWarningCount: 0,
		fixed: [],
		resolvedCount: 0,
		output: "",
		blockerOutput: "",
		hasBlockers: false,
	};

	const ctx = createDispatchContext(
		filePath,
		cwd,
		pi,
		sessionFacts,
		options?.blockingOnly ?? false,
		options?.modifiedRanges,
	);
	sessionFacts.clearFileFactsFor(ctx.filePath);

	const kind = ctx.kind;
	if (!kind) return { result: empty, runners: [] };

	const groups = withSpotbugsGroup(
		kind,
		getDispatchGroupsForKind(kind, pi),
		ctx,
	);
	if (groups.length === 0) return { result: empty, runners: [] };

	const runners: RunnerOutcome[] = [];
	const sink: RunnerResultSink = (runnerId, result) => {
		runners.push({ runnerId, result });
	};

	await runProviders(ctx);
	const result = await dispatchForFile(
		ctx,
		groups,
		sessionRunnerRegistry,
		sink,
	);
	trackSessionSlopStats(ctx, result.diagnostics);

	return { result, runners };
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
