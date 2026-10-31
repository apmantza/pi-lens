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
	checkToolAvailability,
	clearCoverageNoticeState,
	clearLatencyReports,
	createDispatchContext,
	deltaBaselineFactKey,
	type DispatchLatencyReport,
	dispatchForFile,
	formatLatencyReport,
	getLatencyReports,
	type RunnerLatency,
	RunnerRegistry,
	type RunnerResultSink,
} from "./dispatcher.js";
import { spawnAbortScope } from "../safe-spawn.js";
import { emitBounded } from "../bounded-telemetry.js";
import {
	incrementDegradationCount,
	recordDegradationOnce,
} from "../degradation-ledger.js";
import { FactStore, setFactStoreEvictionReporter } from "./fact-store.js";
import { canWriteAnalysisRoot, resolveAnalysisRoot } from "../analysis-root.js";
import { resolveLanguageRootForFile } from "../language-profile.js";
import { classifyObservedRunner } from "./collect-later-tier.js";
import {
	PRE_EDIT_SEED_RUNNER_IDS,
	preEditSeedFactKey,
	seedFromCapture,
} from "./pre-edit-seed.js";
import { TOOL_PLANS } from "./plan.js";
import type {
	DispatchContext,
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
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import {
	CASCADE_NEIGHBOUR_BUDGET,
	type CascadeBudgetZone,
	deriveCascadeNeighbourBudget,
} from "../cascade-budget.js";
import {
	applyCascadeDisplayPolicy,
	composeCascadeSection,
	formatCascadeNeighborDiagnostics,
	getCascadePendingNeighborCount,
	recordCascadeFindingPolicy,
	resetCascadePendingNeighbors,
	resetCascadeUnansweredPrimariesDelivered,
	splitCascadeUnansweredPrimaries,
} from "../cascade-format.js";
import { logCascade } from "../cascade-logger.js";
import type {
	CascadeResult,
	CascadeRun,
	CascadeSectionLayout,
	CascadeSkipReason,
	CascadeUnconfirmed,
	CascadeUnconfirmedReason,
} from "../cascade-types.js";
import { getDiagnosticTracker } from "../diagnostic-tracker.js";
import type { GenerationHandle } from "../generation-guard.js";
import {
	classifyCascadeWaitTier,
	isTierAwareCascadeEnabled,
	recordOutstandingCascadeTouch,
} from "../lsp/cascade-tier.js";
import {
	type BoundToCurrentDisk,
	type TouchFileResult,
	bindingStateLabel,
	readBoundToCurrentDisk,
	touchCoverageGap,
} from "../lsp/diagnostic-binding.js";
import { getServersForFileWithConfig } from "../lsp/config.js";
import { demoteEnvironmentGapDiagnostics } from "../lsp/environment-gap.js";
import {
	classifyJsTsGlobalScope,
	goPackageFiles,
	goPackagePeersOf,
	implicitScopeOf,
	isGoSourceFile,
} from "../lsp/implicit-scope.js";
import { getLSPService } from "../lsp/capabilities.js";
import {
	isExternalOrVendorFile,
	normalizeMapKey,
	toPosix,
} from "../path-utils.js";
import { getProjectIgnoreMatcher } from "../file-utils.js";
import {
	resetAstGrepNapiLoadState,
	resetAstGrepUnsupportedLanguageLog,
} from "./runners/ast-grep-napi.js";
import {
	isTreeSitterWasmAborted,
	resetTreeSitterClientLoadState,
} from "../tree-sitter-shared.js";
import { isTestRoleCollateral } from "../collateral-test-role.js";
import {
	clearReviewGraphWorkspaceCache,
	getGraphBuildInfoForGraph,
	getGraphImportChanges,
	graphBuildInfoIsTrustworthy,
	graphWasmTrapDetail,
} from "../review-graph/builder.js";
import {
	buildReverseDependencyIndexFromGraph,
	getAffectedFilesFromIndex,
	patchReverseDependencyIndex,
	rankFilesByReverseDependencyCentrality,
	writeReverseDependencyIndexToSnapshot,
	type ReverseDependencyIndex,
} from "../reverse-deps.js";
import {
	buildOrUpdateGraph,
	computeImpactCascade,
	computeTransitiveImpact,
	formatImpactCascade,
} from "../review-graph/service.js";
import { clearModuleGraphCache } from "../review-graph/workspace-modules.js";
import { releaseWorkspaceTopologyIdleTimers } from "../workspace-topology.js";
import { RUNTIME_CONFIG } from "../runtime-config.js";
import {
	findCompiledClassesDir,
	hasJavaBuildDescriptor,
} from "../tool-policy.js";
import {
	removeWordIndexDocumentAsync,
	updateWordIndexDocumentForEdit,
	WORD_INDEX_MAX_BYTES,
	type WordIndex,
} from "../word-index.js";
import { reconcileCascadeNeighborLspErrors } from "../widget-state.js";
import { writeOrderToken } from "../write-ordering-guard.js";
import { findAuxiliaryProfileForSource } from "./auxiliary-lsp.js";
// Register fact providers. All register eagerly here (the dispatch entry) — the
// tree-sitter-backed providers included, since the parsing stack loads
// `web-tree-sitter` lazily inside client.init(), not at module import, so it
// stays out of the eager graph and degrades there rather than crashing at load.
import { registerProvider, runProviders } from "./fact-runner.js";
import { commentFactProvider } from "./facts/comment-facts.js";
import { fileContentProvider } from "./facts/file-content.js";
import { functionFactProvider } from "./facts/function-facts.js";
import { importFactProvider } from "./facts/import-facts.js";
import { tryCatchFactProvider } from "./facts/try-catch-facts.js";
import { resolveRunnerPath, toRunnerDisplayPath } from "./runner-context.js";
import { registerDefaultRunners } from "./runners/index.js";
import { convertLspDiagnostics } from "./utils/lsp-diagnostics.js";

registerProvider(fileContentProvider);
registerProvider(tryCatchFactProvider);
registerProvider(functionFactProvider);
registerProvider(commentFactProvider);
registerProvider(importFactProvider);

// Register fact rules
import { registerRule } from "./fact-rule-runner.js";
import { asyncNoiseRule } from "./rules/async-noise.js";
import { asyncUnnecessaryWrapperRule } from "./rules/async-unnecessary-wrapper.js";
import { corsWildcardRule } from "./rules/cors-wildcard.js";
import { errorObscuringRule } from "./rules/error-obscuring.js";
import { errorSwallowingRule } from "./rules/error-swallowing.js";
import { highComplexityRule } from "./rules/high-complexity.js";
import { highFanOutRule } from "./rules/high-fan-out.js";
import { highImportCouplingRule } from "./rules/high-import-coupling.js";
import { missingErrorPropagationRule } from "./rules/missing-error-propagation.js";
import { commentedCredentialsRule } from "./rules/no-commented-credentials.js";
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
registerRule(highImportCouplingRule);
registerRule(corsWildcardRule);
registerRule(commentedCredentialsRule);

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

// "dispatch" labels this store's eviction telemetry (#2243 review round 3,
// F1) — other production FactStore instances exist (mcp/analyze.ts,
// lens-map.ts, project-diagnostics/scanner.ts, runtime-session.ts's
// session-start call-graph task, mcp/cli.ts, and the pre-edit capture's store
// below); a shared constant subject let
// runtime-session's session-start review-graph walk consume the once-per-
// session ledger slot before any dispatch ran, misattributing the record.
const sessionFacts = new FactStore("dispatch");
/**
 * #4483: file facts for the pre-edit capture. Its own store, so a capture
 * the `tool_call` bound abandoned can never write the old bytes' facts over
 * the ones the file's real dispatch is using. Tool availability still reads
 * and warms the shared session facts (`hasTool` in
 * `capturePreEditLinterFindings`): it is keyed by command, not by content.
 * Cleared with them at `session_start`.
 */
const preEditCaptureFacts = new FactStore("pre-edit-capture");
/** #4543: retain live slots through teardown, including across session reset. */
const preEditCapturesInFlight = new Map<string, AbortController>();
const MAX_PRE_EDIT_CAPTURES = 4;

// #2243 item 4: wire the fact-store's capacity-eviction telemetry to the
// ledger from HERE, not from fact-store.ts. fact-store stays an import leaf so
// it cannot re-enter the safe-spawn ↔ degradation-ledger cycle (see
// `setFactStoreEvictionReporter`). The reporter forwards each store's own
// subject, so the ledger's per-kind+subject dedupe emits exactly ONE record
// per session PER STORE, re-arming when the ledger resets at session_start.
//
// #2247 review F1: the axis was previously dropped here, so
// `recordDegradationOnce`'s `${kind}\0${subject}` dedupe collapsed a store's
// count-axis and byte-axis evictions onto the SAME key — whichever axis
// tripped first (always count, since 1024 typical files land far under 64
// MiB) silently consumed the once-per-session slot and a later byte-axis
// eviction on that same store recorded nothing. Fold the axis into the
// subject (`<store>:<axis>`), matching this ledger's own `<store>:<file>`
// convention (see `demoted-finding-retired`'s doc comment) rather than
// growing the `kind` union per axis. `pinned-over-budget` (#2247 review F2)
// is a distinct condition, not an eviction, so it gets its own kind instead
// of sharing the eviction kind's subject convention.
setFactStoreEvictionReporter((subject, axis, reason) => {
	if (axis === "pinned-over-budget") {
		recordDegradationOnce({
			kind: "fact-store-pinned-over-budget",
			subject,
			reason,
		});
		return;
	}
	recordDegradationOnce({
		kind: "fact-store-capacity-eviction",
		subject: `${subject}:${axis}`,
		reason,
	});
});
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

	const timer = setTimeout(() => {
		astGrepWarnDebounceTimers.delete(filePath);
		void runAstGrepWarningScan(filePath, cwd, pi, logContext).catch(() => {
			// Non-critical background scan — swallow errors silently
		});
	}, AST_GREP_WARN_DEBOUNCE_MS);

	astGrepWarnDebounceTimers.set(filePath, timer);
}

/**
 * Run the debounced ast-grep warning scan for one jsts file.
 *
 * #2243 item 1: this is a dispatch entry point like dispatchLint*, so it must
 * follow the same discipline. It fires ~2 s after the last write, and in that
 * window the review-graph project walk (`buildOrUpdateGraph`) seeds facts for
 * every file into the SAME `sessionFacts`, which can evict this file's
 * `file.content`. `dispatcher.ts` reads that fact back with `?? ""` for inline
 * suppressions, so a stale or evicted read silently stops applying
 * `pi-lens-ignore`. Two guards, matching the other dispatch callers:
 *   1. `beginDispatchFor` pins the file for the dispatch (released in the
 *      finally), so a concurrent walk cannot evict it mid-dispatch. This
 *      does NOT clear the file's existing facts the way `clearFileFactsFor`
 *      does for the other dispatch callers (#2243 review round 3, F5): this
 *      scan fires ~2s after the SAME edit's inline dispatch already
 *      re-derived every fact for this file, so a second clear+re-derive
 *      here bought nothing but ~51ms of redundant re-parsing across all
 *      five providers (measured; a warm-cache read is ~1ms).
 *   2. `runProviders` still re-derives `file.content` when it's actually
 *      missing (a genuine miss — evicted, or never computed), so the read
 *      never depends on staleness.
 * `facts` is injected only for tests; production always uses `sessionFacts`.
 */
export async function runAstGrepWarningScan(
	filePath: string,
	cwd: string,
	pi: PiAgentAPI,
	logContext: LogContext,
	facts: FactStore = sessionFacts,
): Promise<void> {
	const ctx = createDispatchContext(filePath, cwd, pi, facts, false);
	if (ctx.kind !== "jsts") return;

	facts.beginDispatchFor(ctx.filePath);
	try {
		// Single-runner group: ast-grep only, warning mode (blockingOnly=false)
		const group: RunnerGroup = {
			mode: "all",
			runnerIds: ["ast-grep-napi"],
			filterKinds: ["jsts"],
		};
		await runProviders(ctx);
		const result = await dispatchForFile(ctx, [group], sessionRunnerRegistry);
		if (result.diagnostics.length === 0) return;

		const logger = getDiagnosticLogger();
		for (const d of result.diagnostics) {
			logger.logCaught(d, logContext, false);
		}
	} finally {
		facts.endDispatchFor(ctx.filePath);
	}
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
					const runnerIds = group.runnerIds.filter((id) => id !== "lsp");
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
	resetAstGrepUnsupportedLanguageLog();
	// #1567: a genuine-failure verdict or a live transient cooldown on the
	// napi load latch is session-scoped state, not process-lifetime state.
	resetAstGrepNapiLoadState();
	// #1592: same shape for the web-tree-sitter load latch — an evaluation-
	// shaped rejection is session-scoped state, not process-lifetime state.
	resetTreeSitterClientLoadState();
	sessionFacts.clearAll();
	// #4483: the pre-edit capture's file facts and availability go with them.
	for (const controller of preEditCapturesInFlight.values()) controller.abort();
	preEditCaptureFacts.clearAll();
	resetSessionSlopScore();
	clearCoverageNoticeState();
	clearReviewGraphWorkspaceCache();
	clearReverseDepsIndexCache();
	clearModuleGraphCache();
	resetCascadeUnansweredPrimariesDelivered();
	resetCascadePendingNeighbors();
	primaryFilesThisTurn.clear();
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

// #1899: the A5 per-write `neighborTouchCache` used to live here. It was
// removed as dead BY CONSTRUCTION, not merely unused. Its read gate required
// `cached.turnSeq === turnSeq && cached.writeSeq === writeSeq`, and `writeSeq`
// is pi's per-write index (`ctx.telemetry.writeIndex`, clients/pipeline.ts),
// which advances on every write. One write starts one cascade, so a hit needed
// two cascade computations inside a SINGLE write — a shape the pipeline never
// produces. Dogfooding measured 0 hits across 236 cold touches.
//
// Broadening it was considered and rejected. Dropping the `writeSeq` equality
// to make it turn-scoped would serve a neighbour's diagnostics from BEFORE a
// later write in the same turn, which is the stale-answer trap #1092/#1095
// closed. The one reuse that remains is the passive snapshot, and only when it
// was published after this compute started (#4486, `isPostEditObservation`).
//
// #4486: the cross-turn recently-clean cache (`recentlyCleanNeighborCache`,
// five turns) was deleted for the same reason. Every compute starts after a
// primary edit, so a clean answer from an earlier compute is never an
// observation of the state this one is asked about; it answered clean
// without a touch for a neighbour the edit had just broken.

/** O(1) entry counts of the cascade's session-bounded records (#1123 item 2
 *  memory attribution) — `Map.size` reads, never iterated.
 *  `pendingNeighborCount` (#4487) is the pending neighbour-error record in
 *  clients/cascade-format.ts, capped at 256 entries. `sessionFactEntries`
 *  (#2282) is the dispatch `FactStore`'s own `sessionFacts` footprint: the
 *  fixed-vocabulary map (small, unbounded by design) plus the bounded
 *  per-file map (capped at `MAX_SESSION_FACT_RECORDS` — see `fact-store.ts`). */
export function getDispatchCascadeCacheStats(): {
	pendingNeighborCount: number;
	sessionFactEntries: number;
} {
	return {
		pendingNeighborCount: getCascadePendingNeighborCount(),
		sessionFactEntries: sessionFacts.getSessionFactEntryCount(),
	};
}

// B10: tracks files that were the *primary* edited file this turn.
// These are excluded from cascade neighbor results — their own pipeline run
// already reported their diagnostics authoritatively.
let cascadeTurnScope = 0;
const primaryFilesThisTurn = new Set<string>();

function ensureCascadeTurnScope(turnSeq: number): void {
	if (turnSeq === cascadeTurnScope) return;
	cascadeTurnScope = turnSeq;
	primaryFilesThisTurn.clear();
}

/**
 * #4486: an answer is an observation of the state this compute is asked about
 * only when it was published after the compute started. The pipeline starts
 * the compute after the primary's dispatch returned, and that dispatch awaited
 * the primary's didChange, so anything stamped later was computed against the
 * edit. Erring late costs a touch; erring early served a pre-edit clean as
 * current (a 4 s old snapshot of a neighbour the edit had broken). Replaces the
 * 240 s TTL at every reader: the passive snapshot, the touch-error fallback,
 * the degraded fallback, and — #5040 — a touch's own reused answer.
 */
function isPostEditObservation(
	publishedAt: number,
	cascadeStart: number,
): boolean {
	return publishedAt > cascadeStart;
}

/**
 * #4485: how long a silent-push neighbour (no command to pull with) is given
 * to publish after its touch. Silence through it leaves the neighbour
 * unconfirmed, never clean. The per-touch caps of the waiting path (1000 ms
 * cold snapshot, 2000 ms) are unchanged.
 */
const SILENT_PUSH_WAIT_MS = 1000;

const MAX_PER_FILE = RUNTIME_CONFIG.pipeline.cascadeMaxDiagnosticsPerFile;
const MAX_FILES = RUNTIME_CONFIG.pipeline.cascadeMaxFiles;
/**
 * How many of ONE neighbour's ERRORs the display policy may look at (#3157
 * round 2, F1). `MAX_PER_FILE` is the DISPLAY cap and now applies to the
 * survivors, so this is the separate, deliberately generous bound on the
 * policy's INPUT — four full display caps of headroom, so a neighbour would
 * need 80 suppressed findings before a genuine one could fall off the end
 * again.
 *
 * It exists because the policy's cost is linear in the finding count once a
 * project has ANY disposition mark (the zero-I/O hoist in
 * `finding-policy.ts` stops firing and every finding expands into its
 * candidate identities): measured on 40 real neighbours, 1.31 ms/neighbour at
 * 20 findings, 4.74 ms at 80, and 28.29 ms at 500 — that last one is 1131
 * ms/edit across a full 40-neighbour walk, a quarter of the `cascadeSettleWaitMs`
 * window, for a neighbour nobody can read anyway. Truncation here is COUNTED
 * (`inputTruncated` on the `cascade_finding_policy` row), because an input
 * bound whose loss is invisible is exactly the defect F1 found.
 */
const MAX_POLICY_INPUT_PER_FILE = MAX_PER_FILE * 4;

/**
 * The genuine language-server ERROR diagnostics from a cascade neighbor
 * re-check, ready to reconcile into the footer widget (#1093).
 *
 * Drops any diagnostic whose `source` matches an auxiliary-LSP profile
 * (opengrep/ast-grep/zizmor/typos — `findAuxiliaryProfileForSource`). The
 * cascade's `convertLspDiagnostics` tags everything `tool: "lsp"`,
 * `semantic: "blocking"` and — unlike every OTHER widget writer
 * (`runners/lsp.ts`, `tools/lsp-diagnostics.ts`, `tools/lens-diagnostics.ts`) —
 * never runs `retagAuxiliaryDiagnostics`. Since `getAllDiagnostics` /
 * `touchFile({clientScope:"all"})` include the auxiliary servers' findings,
 * writing them here would (a) DOUBLE-COUNT a neighbor's own correctly-tagged aux
 * entry and (b) ESCALATE an advisory/suppressed aux finding into a blocking
 * `tool:"lsp"` error, bypassing aux policy (semantic downgrade, native
 * `# nosemgrep`/`zizmor:ignore` suppression, `skipTestFiles`). Aux findings are
 * per-file lint/security signals the neighbor's OWN per-edit runners own; they
 * are not cross-file impact, so the cascade simply excludes them and the merge
 * (`reconcileCascadeNeighborLspErrors`) preserves the neighbor's existing aux
 * entries untouched. This keeps `isLspErrorEntry`'s "tool === 'lsp' uniquely
 * identifies a genuine language-server entry" contract true for what we write.
 *
 * The DISPLAY list is no longer "left as-is" as it was for #1093: since #3157
 * every display site runs `cascadeDisplay` → `applyCascadeDisplayPolicy`, which
 * applies the finding-policy stack AND keeps the auxiliary retag's own drop set
 * — so the display drops natively-suppressed aux findings while still RENDERING
 * the aux findings this widget writer excludes wholesale. The two remain
 * deliberately different: this one protects `isLspErrorEntry`'s "tool === 'lsp'"
 * contract for PERSISTED widget state, which the ephemeral display list never
 * touches.
 */
function cascadeReconcilableLspErrors(
	rawDiags: readonly import("../lsp/client.js").LSPDiagnostic[],
	neighborPath: string,
): ReturnType<typeof convertLspDiagnostics> {
	// #4532 round 6 (review NEW-2; AGENTS.md shape 71): the environment-gap
	// rule the cascade display runs (`applyCascadeDisplayPolicy`), applied before
	// the ERROR filter, so a gap the agent no longer sees is not persisted as a
	// blocking footer entry either. A demoted row is a warning and leaves here
	// as every LSP warning does. The rule reads TypeScript rows only, so an
	// auxiliary row passes through it untouched and is dropped below.
	return convertLspDiagnostics(
		demoteEnvironmentGapDiagnostics([...rawDiags], { filePath: neighborPath })
			.filter(
				(d) => d.severity === 1 && !findAuxiliaryProfileForSource(d.source),
			)
			.slice(0, MAX_PER_FILE),
		neighborPath,
	);
}

/**
 * #1095: is this active-touch result a CONFIRMED observation of the neighbor's
 * current on-disk LSP-error state — safe to reconcile into the footer widget and
 * (when clean) to seed the recently-clean neighbor cache?
 *
 * Composes the two independent disqualifiers into ONE clearly-named predicate so
 * a future flag cannot be silently missed at just one of the several gate sites:
 *  - `inconclusive` (#1093/#571): the notify/diagnostics wait lapsed its deadline,
 *    so a resolved `[]` is NOT a confirmed clean (the #533 false-clean trap).
 *    #1549: this now means a PRIMARY's deadline lapsed. A slow auxiliary lands in
 *    the coverage-gap bullet below instead of collapsing the whole touch, so this
 *    predicate still fails closed for it while the primary's findings survive —
 *    which is the point: the two disqualifiers were doing one job for two causes.
 *  - a COVERAGE GAP (#1470/#1493): an auxiliary never reported — its push wait was
 *    cut off by the aux grace timer (#1470), or it stayed silent with no stored
 *    publication for this content (#1493) — so the merged result is missing whatever
 *    that scanner would have said. Such a touch is deliberately NOT `inconclusive`
 *    (the primary answered), which is exactly why it needs naming here: reading
 *    `!inconclusive` alone would let a hung or silent opengrep wipe a live footer
 *    finding and seed the recently-clean cache.
 *  - `binding.boundToCurrentDisk === false` (#1095): the diagnostics were computed
 *    against a DIFFERENT disk state than what is on disk now (the server's view
 *    diverged / a pre-fix buffer) — not an observation of current disk. `true` and
 *    `"unknown"` both pass; `"unknown"` preserves pre-#1095 behavior for a
 *    version-less server exactly.
 *
 * #1179: both flags are EXPLICIT enumerable fields on the `touchFile`
 * `TouchFileResult` wrapper — read them off the wrapper (`rawDiags`), whose
 * `.diags` a downstream `.filter()`/copy operates on without touching the flags.
 */
function readInconclusive(rawDiags: unknown): boolean {
	return (rawDiags as { inconclusive?: boolean })?.inconclusive === true;
}

/**
 * #1549: an inconclusive `neighbor_touch` row used to carry NO attribution, so a
 * forensic sweep could only infer the cause from duration histograms. `touchFile`
 * now names the PRIMARY server(s) whose deadline produced the verdict and which
 * deadline it was (`notify-write` vs `diagnostics-wait`, or `mixed`) — carry both
 * into cascade.log so the record stands on its own. Read off the wrapper, like
 * every other flag here (#1179).
 */
function readInconclusiveAttribution(rawDiags: unknown): {
	inconclusiveServerIds?: string[];
	inconclusiveReason?: string;
} {
	const wrapper = rawDiags as {
		inconclusiveServerIds?: string[];
		inconclusiveReason?: string;
	};
	return {
		...(wrapper?.inconclusiveServerIds?.length && {
			inconclusiveServerIds: [...wrapper.inconclusiveServerIds],
		}),
		...(wrapper?.inconclusiveReason && {
			inconclusiveReason: wrapper.inconclusiveReason,
		}),
	};
}

function isConfirmedTouch(rawDiags: TouchFileResult): boolean {
	return (
		!readInconclusive(rawDiags) &&
		touchCoverageGap(rawDiags).length === 0 &&
		readBoundToCurrentDisk(rawDiags) !== false
	);
}

/**
 * #5040: the cached answer this touch reused instead of producing its own
 * (`TouchFileResult.reusedAnswer` — a notify-skipped push server whose entry
 * stood unchanged through the touch). Read off the wrapper, like every other
 * flag here (#1179).
 */
function readReusedAnswer(
	rawDiags: unknown,
): { serverId: string; publishedAt: number } | undefined {
	const reused = (
		rawDiags as { reusedAnswer?: { serverId?: unknown; publishedAt?: unknown } }
	)?.reusedAnswer;
	return typeof reused?.serverId === "string" &&
		typeof reused.publishedAt === "number"
		? { serverId: reused.serverId, publishedAt: reused.publishedAt }
		: undefined;
}

/**
 * #5040: is this touch's answer older than the edit this cascade is about?
 *
 * A push-only server publishes for a dependent when ITS project model changes,
 * not when we ask (jdtls republishes one importer of a broken exporter and
 * never the other — PR #5035's wire capture). The touch of a neighbour sends
 * nothing for unchanged content, so the only answer it can report is the entry
 * the server already held; when that entry predates this run, nothing has
 * re-asked the server since the exporter changed, and a clean verdict for it
 * would be an all-clear for a dependent nobody re-checked. It is unconfirmed,
 * by the same rule `isPostEditObservation` (#4486) already applies to the
 * passive snapshot, the touch-error fallback and the degraded fallback.
 *
 * Not a disqualifier when the answer postdates the run: the server DID publish
 * for this neighbour after the edit (rows 1-4 of the PR's state table), and the
 * neighbour keeps whatever verdict it earned.
 */
function isPreEditAnswer(
	rawDiags: TouchFileResult,
	cascadeStart: number,
): boolean {
	const reused = readReusedAnswer(rawDiags);
	return (
		reused !== undefined &&
		!isPostEditObservation(reused.publishedAt, cascadeStart)
	);
}

// #459: the reverse-dependency index is a pure function of the review graph.
// Rebuilding it (O(graph edges)) and re-writing it to the project snapshot
// (disk write) on every cascade run is wasted work whenever the graph build
// was a cache hit. Keyed per-workspace (normalized cwd — same key shape as
// builder.ts's _workspaceGraphCache) so unrelated workspaces never share or
// clobber each other's cached index. Freshness is keyed on the generation
// stamp the entry's index was built from (ReviewGraph.buildGeneration).
type ReverseDepsCacheEntry = {
	index: ReverseDependencyIndex;
	savedToSnapshot: boolean;
	/** buildGeneration of the graph this index was derived from. */
	generation: number | undefined;
	lastUsedAt: number;
	idleTimer?: ReturnType<typeof setTimeout>;
};
const reverseDepsIndexCache = new Map<string, ReverseDepsCacheEntry>();
const REVERSE_DEPS_MAX_WARM_ROOTS = 8;
const REVERSE_DEPS_IDLE_EVICT_MS_DEFAULT = 20 * 60_000;

function reverseDepsIdleEvictMs(): number {
	const value = Number.parseInt(
		process.env.PI_LENS_REVERSE_DEPS_IDLE_EVICT_MS ?? "",
		10,
	);
	return Number.isSafeInteger(value) && value > 0
		? value
		: REVERSE_DEPS_IDLE_EVICT_MS_DEFAULT;
}

function deleteReverseDepsEntry(key: string): void {
	const entry = reverseDepsIndexCache.get(key);
	if (entry?.idleTimer !== undefined) clearTimeout(entry.idleTimer);
	if (entry) entry.idleTimer = undefined;
	reverseDepsIndexCache.delete(key);
}

function touchReverseDepsEntry(
	key: string,
	entry: ReverseDepsCacheEntry,
	armIdleTimer = true,
): void {
	entry.lastUsedAt = Date.now();
	if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
	entry.idleTimer = undefined;
	if (!armIdleTimer) return;
	const stamp = entry.lastUsedAt;
	entry.idleTimer = setTimeout(() => {
		if (reverseDepsIndexCache.get(key) !== entry || entry.lastUsedAt !== stamp)
			return;
		deleteReverseDepsEntry(key);
	}, reverseDepsIdleEvictMs());
	entry.idleTimer.unref?.();
}

function setReverseDepsEntry(
	key: string,
	entry: Omit<ReverseDepsCacheEntry, "lastUsedAt" | "idleTimer">,
	armIdleTimer = true,
): void {
	const previous = reverseDepsIndexCache.get(key);
	if (previous?.idleTimer !== undefined) {
		clearTimeout(previous.idleTimer);
		previous.idleTimer = undefined;
	}
	const resident: ReverseDepsCacheEntry = { ...entry, lastUsedAt: Date.now() };
	reverseDepsIndexCache.set(key, resident);
	touchReverseDepsEntry(key, resident, armIdleTimer);
	while (reverseDepsIndexCache.size > REVERSE_DEPS_MAX_WARM_ROOTS) {
		const victim = [...reverseDepsIndexCache.entries()].sort(
			([, a], [, b]) => a.lastUsedAt - b.lastUsedAt,
		)[0];
		if (!victim) break;
		deleteReverseDepsEntry(victim[0]);
	}
}

function reverseDepsReuseEnabled(): boolean {
	const raw = process.env.PI_LENS_REVERSE_DEPS_REUSE;
	return raw !== "0" && raw !== "false";
}

/** Test-reset hook — mirrors clearReviewGraphWorkspaceCache's scope. */
export function clearReverseDepsIndexCache(): void {
	for (const key of reverseDepsIndexCache.keys()) deleteReverseDepsEntry(key);
}

/** Test-only visibility for Tier-2 eviction/recovery tests. */
export function _getReverseDepsIndexCacheKeysForTests(): string[] {
	return [...reverseDepsIndexCache.entries()]
		.sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)
		.map(([key]) => key);
}

/** Test-only seed that still exercises the production timer/cap seam. */
export function _seedReverseDepsIndexCacheForTests(
	key: string,
	index: ReverseDependencyIndex,
	generation?: number,
): void {
	setReverseDepsEntry(key, { index, savedToSnapshot: false, generation });
}

// #5055: how many unplaced referrers the advisory names; the rest are counted.
const UNPLACED_REFERRER_NAMED = 3;

// Bounded transitive cascade (#162): expand neighbour derivation beyond the
// one-hop importers/callers to depth-2 dependents, so an edit's blast radius
// reaches indirect dependents — capped so the per-edit cost stays bounded. The
// one-hop set is always the floor (it sorts first, before depth-2). Both
// env-tunable; set depth to 1 to restore the old one-hop-only behaviour.
const CASCADE_TRANSITIVE_DEPTH = Math.max(
	1,
	Number.parseInt(process.env.PI_LENS_CASCADE_TRANSITIVE_DEPTH ?? "2", 10) || 2,
);
// #1462: the cap itself, and the derivation that narrows it when this run has
// already spent the settle window, live in clients/cascade-budget.ts alongside
// `cascadeSettleWaitMs` — the two knobs only make sense read together.
// Exported (not just module-local) so the MCP warm-analyze seam
// (clients/mcp/analyze.ts, #536) can gate its own buildOrUpdateGraph call on
// the SAME file-kind eligibility this cascade path uses — one source of truth
// for "does this language get graph nodes at all", never a second hardcoded copy.
export const CASCADE_GRAPH_KINDS = new Set([
	"jsts",
	"python",
	"go",
	"rust",
	"ruby",
	"cxx",
	"java",
]);

/**
 * Unified cascade orchestration — builds graph, discovers neighbors, and
 * gathers per-file diagnostics with structured logging to cascade.log.
 *
 * autoPropagate (jsts): tsserver pushes diagnostics automatically, so we
 * read from the passive snapshot instead of touching neighbors actively.
 *
 * Degraded fallback: when the graph yields no neighbours for a graphed kind,
 * fall back to the passive LSP snapshot from getAllDiagnostics to preserve
 * cascade coverage. A kind outside this set skips as `non_code` first.
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

/**
 * #348 phase 2 per-edit seam: update the warm in-memory word index for one
 * file, mirroring the review graph's per-edit rebuild at the same call site.
 *
 * Rules (each a documented, deliberate simplicity choice, not an oversight):
 *  - `wordIndex` null (no index loaded yet) ⇒ no-op. Cold-session handoff is
 *    OWNED by phase 1's lifecycle/background build, never invented here — an
 *    edit arriving before that build finishes just doesn't update anything;
 *    the eventual full build already reflects every file on disk, incl. this
 *    edit, so nothing is lost, only delayed.
 *  - `wordIndex.forward` undefined (pre-phase-2 index shape, e.g. a snapshot
 *    persisted before this feature or one still using the old serialized
 *    shape) ⇒ no-op. `updateWordIndexDocument` already refuses to mutate a
 *    forward-index-less index (see its doc comment) — this is the same rule
 *    surfaced one layer up so the caller isn't left guessing why nothing
 *    happened. The NEXT full rebuild (session-start lifecycle) installs a
 *    forward-index-bearing index that later edits CAN update incrementally.
 *  - `content` undefined (pipeline couldn't read the file — deleted, or a
 *    transient race) ⇒ no-op. Deletions aren't plumbed at this seam (this
 *    call site only ever sees the edited file's post-write content, never a
 *    delete event) — a removed file ages out at the next full rebuild, same
 *    scope boundary the review graph accepts for deletes.
 *  - File over the shared `WORD_INDEX_MAX_BYTES` cap ⇒ removed/absent from
 *    the index (never partially indexed) — same cap phase 1's build path
 *    enforces via `collectWordIndexDocs`.
 *  - The file's analysis root is not writable by this session (`adopted`, or
 *    `none`) ⇒ no-op. The index is SESSION state, and an adopted root is a
 *    foreign project the session serves read-only: it gets LSP and the
 *    allowlisted per-file linters, never a session-keyed record (#4242). This
 *    is `canWriteAnalysisRoot`'s rule, the same one the formatter and the
 *    autofix writer ask, resolved against the authoritative workspace root
 *    rather than the language root this cascade runs in.
 *  - On a successful update, `onUpdated` fires so the caller can schedule a
 *    debounced persist (never a synchronous write per edit — same #260
 *    discipline as the graph).
 *
 * Race safety against a build-in-progress: the update runs cooperatively, on
 * an 8 ms budget, through the word index's own per-index operation queue
 * (#2067 AC4). It used to run synchronously here, on the reasoning that two
 * overlapping cascades (#450's unawaited concurrency) could not interleave
 * mid-mutation if nothing ever yielded — the reviewer's 300-document probe had
 * lost 1,719 postings during an 8 ms yield. That hazard is what the queue
 * closed: every async operation on one index is chained behind the previous
 * one in call order, so overlapping cascades are ordered rather than
 * interleaved, and the cooperative arena compactor is separately proof against
 * a synchronous edit landing mid-copy (#2117 review F2). What the synchronous
 * variant could not fix is its own cost: one replacement on a 2,600-document
 * corpus held the event loop for the whole replacement, which is the block
 * #2067 measured at 1.1 s before interning and still tens of ms after it.
 *
 * The only cross-build hazard is a full session-start rebuild REPLACING
 * `runtime.wordIndex` with a new object between the caller reading
 * `runtime.wordIndex` (in runtime-tool-result.ts, synchronous) and this
 * function receiving it — in that case this call simply mutates whichever
 * index object it was handed (old or new), and the other one is
 * abandoned/superseded, never corrupted.
 */
async function updateWordIndexForCascade(args: {
	wordIndex?: WordIndex | null;
	filePath: string;
	content?: string;
	/**
	 * Authoritative workspace root (`PipelineContext.projectRoot`), against which
	 * the file's analysis-root class is resolved. `cwd` at the call site is the
	 * LANGUAGE root, which in an adopted project is a directory the session does
	 * not own — resolving against it would call a foreign file a `session` one.
	 */
	sessionRoot: string;
	onUpdated?: (index: WordIndex) => void;
	dbg?: (msg: string) => void;
}): Promise<void> {
	const { wordIndex, filePath, content, onUpdated, dbg, sessionRoot } = args;
	if (!wordIndex || !wordIndex.forward) return;
	if (content === undefined) return;
	// #4242: the index is session state, so only a file the session owns may
	// enter it. Asked only once a write was otherwise going to happen, so the
	// record below names a real refusal rather than a cold-index no-op.
	if (!canWriteAnalysisRoot(resolveAnalysisRoot(filePath, sessionRoot))) {
		emitBounded(
			"adopted_root_writer_skipped",
			`${filePath}:word-index`,
			{
				filePath,
				durationMs: 0,
				metadata: { writer: "word-index" },
			},
			{ ledgerKind: "adopted-root-writer-skipped", risingEdgePer: "identity" },
		);
		return;
	}

	const byteLength = Buffer.byteLength(content, "utf-8");
	if (byteLength > WORD_INDEX_MAX_BYTES) {
		await removeWordIndexDocumentAsync(wordIndex, filePath);
		dbg?.(`word-index per-edit: dropped ${filePath} (over size cap)`);
	} else {
		await updateWordIndexDocumentForEdit(wordIndex, {
			path: filePath,
			content,
		});
		dbg?.(`word-index per-edit: updated ${filePath}`);
	}
	onUpdated?.(wordIndex);
}

/**
 * #4438: the most an ambient file's change adds to the cascade. Such a file
 * reaches every JS/TS file of the project, so the expansion takes the most
 * central ones by reverse-dependency rank and discloses the cut.
 */
const IMPLICIT_SCOPE_NEIGHBOR_CAP = MAX_FILES * 2;

/**
 * #4438: the files whose implicit scope holds `changedFile` (absolute), as
 * `normalizeMapKey` spellings: a Go file's package peers that
 * `goPackagePeersOf` admits in both directions (same package clause, both in
 * the host build, a test file evidence only for test peers), and for
 * a file whose global-scope role reads `"feeds"`, the JS/TS files of the
 * reverse-dependency index, most central first, at most
 * {@link IMPLICIT_SCOPE_NEIGHBOR_CAP}. `cut` is set when the cap left some out.
 * Membership is {@link implicitScopeOf}, asked of each candidate. #4438 r2: a
 * role that cannot be read (`"unknown"`) expands nothing; the cache's
 * fail-closed answer is not this caller's.
 */
function implicitScopeDependentsOf(
	changedFile: string,
	index: ReverseDependencyIndex,
): { files: string[]; cut?: { checked: number; total: number } } {
	const changed = normalizeMapKey(changedFile);
	if (isGoSourceFile(changed)) {
		// #4438 r3: a dependent is a peer in the host build (`peerOf`) for
		// which the changed file is evidence; the second test differs from the
		// first for a test or build-excluded changed file.
		const peerOf = goPackagePeersOf(changed);
		return {
			files: peerOf
				? (goPackageFiles(nodePath.dirname(changedFile)) ?? [])
						.map((file) => normalizeMapKey(file))
						.filter(
							(peer) =>
								peerOf(peer) && goPackagePeersOf(peer)?.(changed) === true,
						)
				: [],
		};
	}
	let changedFeeds: boolean | undefined;
	const feeds = (): boolean =>
		(changedFeeds ??= classifyJsTsGlobalScope(changedFile) === "feeds");
	const reaches = (candidate: string) =>
		implicitScopeOf(candidate, feeds)?.(changed) === true;
	// A cost bound, not a filter: when the changed file feeds no global scope,
	// `reaches` answers false for every candidate, so this skips ranking the
	// whole index on every module write.
	if (!feeds()) return { files: [] };
	const reached = rankFilesByReverseDependencyCentrality(index).filter(reaches);
	return reached.length > IMPLICIT_SCOPE_NEIGHBOR_CAP
		? {
				files: reached.slice(0, IMPLICIT_SCOPE_NEIGHBOR_CAP),
				cut: {
					checked: IMPLICIT_SCOPE_NEIGHBOR_CAP,
					total: reached.length,
				},
			}
		: { files: reached };
}

export async function computeCascadeForFile(
	filePath: string,
	cwd: string,
	options: {
		hasBlockers?: boolean;
		dbg?: (msg: string) => void;
		/** Turn/write sequence from RuntimeCoordinator — scopes cascade caches (A5/B10) */
		turnSeq?: number;
		/** #3540 r2: the primary edit's order turn, for its widget writes. */
		orderTurn?: number;
		writeSeq?: number;
		/**
		 * Authoritative workspace root (`PipelineContext.projectRoot`). `cwd` above
		 * is the LANGUAGE root (`resolveLanguageRootForFile`), which in a monorepo
		 * is a nested directory — while the disposition store and the
		 * `.pi-lens.json` rule policy the cascade display filter consults are
		 * written under the PROJECT root (`lens_diagnostic_mark` is wired with
		 * `() => runtime.projectRoot`). Reading them from a nested language root
		 * opens a different `diagnostic-dispositions.json` and silently no-ops
		 * every mark — the #1030 defect, which is why `dispatcher.ts` reads both
		 * with `ctx.projectRoot ?? ctx.cwd`. Omitted, `cwd` is used, which is also
		 * the single-root case.
		 */
		projectRoot?: string;
		/**
		 * RuntimeCoordinator sequence state (#451). When present, the graph build
		 * below can take the seq fast path and skip the O(project) walk+stat sweep.
		 * `projectSeq` is read at build time (deferred cascade, #450).
		 */
		seqState?: {
			projectSeq: () => number;
			getFilesChangedSince: (seq: number) => string[];
		};
		/** Current turn_end cascade settle start, or undefined outside that wait. */
		turnEndCascadeSettleStart?: () => number | undefined;
		/**
		 * Post-format/post-fix file content, already read by the pipeline before
		 * this deferred cascade runs (#348 phase 2). Reused here to update the
		 * warm in-memory word index at the SAME seam as the graph rebuild below —
		 * no extra I/O path, just one file's tokenization. `undefined` when the
		 * pipeline couldn't read the file (deleted, race) — the word-index update
		 * is skipped in that case.
		 */
		fileContent?: string;
		/**
		 * Live reference to `runtime.wordIndex` (#348 phase 2). `null` means no
		 * index is loaded in memory yet — the per-edit path is then a documented
		 * no-op (cold handoff): phase 1's lifecycle/background build owns "cold",
		 * never this seam. A non-null index with no `forward` map (pre-phase-2 /
		 * deserialized from an old snapshot) is also a no-op — the caller's next
		 * full rebuild installs a forward-index-bearing index that later edits
		 * CAN update incrementally.
		 */
		wordIndex?: WordIndex | null;
		/** Debounced-persist hook for the updated word index (#348 phase 2). */
		onWordIndexUpdated?: (index: WordIndex) => void;
		/**
		 * #3512: the session current when this compute was dispatched. It runs
		 * detached and can outlive a same-cwd replacement, whose reset has
		 * already cleared the tier-3 registry; a touch it records afterwards is
		 * dropped through this handle rather than reconciled for the new session.
		 */
		sessionGeneration?: GenerationHandle;
	} = {},
): Promise<CascadeRun> {
	const reverseDepsTimersToRelease = new Set<string>();
	const reverseDepsEntriesAtStart = new Set(reverseDepsIndexCache.values());
	// #1462: legacy callers use this run's age when sizing the neighbour walk.
	// The pipeline supplies a live turn_end clock so deferred work does not charge
	// time that elapsed before turn_end began waiting.
	const cascadeStart = Date.now();
	try {
		const {
			hasBlockers = false,
			dbg,
			turnSeq = 0,
			orderTurn,
			writeSeq,
			projectRoot,
			seqState,
			turnEndCascadeSettleStart,
			fileContent,
			wordIndex,
			onWordIndexUpdated,
			sessionGeneration,
		} = options;
		// #3540: the primary edit's widget order, turn first.
		const widgetOrder = writeOrderToken(orderTurn, writeSeq);

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

		// #348 phase 2: warm per-edit word-index maintenance, review-graph style —
		// update at the SAME seam as the graph rebuild below, using content the
		// pipeline already read (no extra I/O). See computeCascadeForFile's
		// `wordIndex`/`fileContent` doc comments for the cold/no-forward-index
		// no-op rules.
		//
		// Keyed by `path.resolve(filePath)` (native separators, tool-input casing).
		// Since #1025 the word index's path maps are `PathKeyedMap`s that fold every
		// key through `wordIndexKey` (`normalizeEphemeralMapKey` — slash-fold +
		// win32-lowercase) INTERNALLY, so this per-edit key and the build path's own
		// walk-derived key (`collectWordIndexDocs` → `collectSourceFilesAsync`)
		// collapse to the same entry regardless of on-disk-vs-input casing/separator.
		// The old hazard — this update silently orphaning a SECOND entry next to the
		// walker's original-cased one — is now structurally impossible at the map
		// layer, so this seam no longer has to hand-match the build path's key shape.
		await updateWordIndexForCascade({
			wordIndex,
			filePath: nodePath.resolve(filePath),
			content: fileContent,
			sessionRoot: projectRoot ?? cwd,
			onUpdated: onWordIndexUpdated,
			dbg,
		});

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
		let cascadeCandidateCount = 0;
		let cascadeEligibleCount = 0;
		let cascadeFilterDroppedCount = 0;
		// #1446 item 4: how many eligible neighbors the flat CASCADE_NEIGHBOUR_BUDGET
		// cut off, distinct from candidates dropped by the filters above it
		// (missing on disk, vendor, ignored, already-primary-this-turn) — those are
		// never actionable regardless of budget, so counting them as "truncated"
		// would overstate what a larger budget could actually recover.
		let cascadeBudgetTruncated = 0;
		let transitiveTruncated = false;
		// #4438: the implicit-scope expansion's cut, when an ambient file reached
		// more JS/TS files than IMPLICIT_SCOPE_NEIGHBOR_CAP.
		let implicitScopeCut: { checked: number; total: number } | undefined;
		// #1462: the budget actually in force for THIS run and the settle time left
		// when it was sized. Both are overwritten inside the graph branch below,
		// which is the only path that reaches `cascade_result` — the other branch
		// returns a `non_code` skip before any of this is logged.
		let cascadeNeighbourBudget = CASCADE_NEIGHBOUR_BUDGET;
		let cascadeBudgetRemainingMs = 0;
		let cascadeBudgetZone: CascadeBudgetZone = "fits";
		let cascadeDeliveryWindowMs = 0;

		if (CASCADE_GRAPH_KINDS.has(fileKind)) {
			const graphStart = Date.now();
			const graph = await buildOrUpdateGraph(
				cwd,
				[normalizedFile],
				sessionFacts,
				seqState,
			);
			const graphMs = Date.now() - graphStart;
			// #459: the reuse decision keys on graph.buildGeneration — a stamp that
			// travels WITH the graph instance this cascade holds. Deliberately NOT the
			// global last-build-info slot: post-#450 cascades overlap, and another
			// cascade's cache-hit build can overwrite that slot (graphChanged:false)
			// between this build mutating the graph and this read — which would turn a
			// changed graph into a spurious reuse of a stale index that steady-state
			// cache hits then never heal. Generation equality can't be clobbered into
			// a false positive: a graph-mutating build always mints a new generation.
			// An unstamped graph (mode "skipped") always rebuilds.
			const graphBuildInfo = getGraphBuildInfoForGraph(graph);
			// #1179 fail-closed: `getGraphBuildInfoForGraph` falls back to the global
			// last-build slot on a WeakMap identity miss, which — once some real build
			// has stamped — could carry a SIBLING graph's healthy `mode: "cached"`. The
			// degraded-marker gate below must not read a sibling's state, so it checks
			// trustworthiness and, when the slot cannot be trusted for THIS graph, treats
			// coverage as unknown (degraded) rather than clean. Always trustworthy on the
			// live path — every `_doBuildGraph` return stamps the graph before the cascade
			// reads it — so this is inert today and only hardens a future unstamped graph.
			const graphBuildInfoTrustworthy = graphBuildInfoIsTrustworthy(graph);
			const workspaceKey = normalizeMapKey(cwd);
			const cachedReverseDeps = reverseDepsIndexCache.get(workspaceKey);
			if (cachedReverseDeps) {
				touchReverseDepsEntry(workspaceKey, cachedReverseDeps, false);
				reverseDepsTimersToRelease.add(workspaceKey);
			}
			const importDelta = getGraphImportChanges(graph);
			// A one-step delta is only usable against an index cached at exactly the
			// delta's predecessor generation. Builds minted elsewhere (mcp analyze,
			// lens-map, session warm) advance generations whose import changes this
			// delta does not cover — reusing/patching across that gap stamps a stale
			// index as current, and generation equality then hides the loss forever
			// (#939 review finding 1).
			const deltaContiguous =
				importDelta !== undefined &&
				importDelta.fromGeneration !== undefined &&
				cachedReverseDeps !== undefined &&
				cachedReverseDeps.generation === importDelta.fromGeneration;
			const importChanges = deltaContiguous ? importDelta.changes : undefined;
			const importsChanged = importChanges?.some(
				(change) =>
					change.existedBefore !== change.existsAfter ||
					change.priorTargets.length !== change.newTargets.length ||
					change.priorTargets.some(
						(target, index) => target !== change.newTargets[index],
					),
			);
			const canReuse =
				reverseDepsReuseEnabled() &&
				cachedReverseDeps !== undefined &&
				((graph.buildGeneration !== undefined &&
					cachedReverseDeps.generation === graph.buildGeneration) ||
					(importChanges !== undefined && !importsChanged));

			let reverseDepsIndex: ReverseDependencyIndex;
			let reverseDepsSaved: boolean;
			if (canReuse && cachedReverseDeps) {
				reverseDepsIndex = cachedReverseDeps.index;
				reverseDepsSaved = cachedReverseDeps.savedToSnapshot;
				cachedReverseDeps.generation = graph.buildGeneration;
				logCascade({
					phase: "reverse_deps_cache",
					filePath,
					durationMs: Date.now() - graphStart,
					metadata: {
						action: "reused_unchanged",
						savedToSnapshot: reverseDepsSaved,
						importsFileCount: Object.keys(reverseDepsIndex.imports).length,
						importedByFileCount: Object.keys(reverseDepsIndex.importedBy)
							.length,
					},
				});
			} else if (cachedReverseDeps && importChanges && importsChanged) {
				reverseDepsIndex = patchReverseDependencyIndex(
					cachedReverseDeps.index,
					importChanges,
				);
				reverseDepsSaved = writeReverseDependencyIndexToSnapshot({
					cwd,
					index: reverseDepsIndex,
					dbg,
				});
				setReverseDepsEntry(
					workspaceKey,
					{
						index: reverseDepsIndex,
						savedToSnapshot: reverseDepsSaved,
						generation: graph.buildGeneration,
					},
					false,
				);
				reverseDepsTimersToRelease.add(workspaceKey);
				logCascade({
					phase: "reverse_deps_cache",
					filePath,
					durationMs: Date.now() - graphStart,
					metadata: {
						action: "patched_import_changes",
						changedFileCount: importChanges.length,
						savedToSnapshot: reverseDepsSaved,
					},
				});
			} else {
				reverseDepsIndex = buildReverseDependencyIndexFromGraph({
					cwd,
					graph,
				});
				reverseDepsSaved = writeReverseDependencyIndexToSnapshot({
					cwd,
					index: reverseDepsIndex,
					dbg,
				});
				setReverseDepsEntry(
					workspaceKey,
					{
						index: reverseDepsIndex,
						savedToSnapshot: reverseDepsSaved,
						generation: graph.buildGeneration,
					},
					false,
				);
				reverseDepsTimersToRelease.add(workspaceKey);
				logCascade({
					phase: "reverse_deps_cache",
					filePath,
					durationMs: Date.now() - graphStart,
					metadata: {
						action: "refresh_from_review_graph",
						savedToSnapshot: reverseDepsSaved,
						importsFileCount: Object.keys(reverseDepsIndex.imports).length,
						importedByFileCount: Object.keys(reverseDepsIndex.importedBy)
							.length,
						importEdgeCount: Object.values(reverseDepsIndex.imports).reduce(
							(total, imports) => total + imports.length,
							0,
						),
					},
				});
			}

			// Count files represented in the graph (nodes with a filePath).
			const graphFileCount = new Set(
				[...graph.nodes.values()].flatMap((n) =>
					n.filePath ? [n.filePath] : [],
				),
			).size;

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
					// #451: when the seq fast path fell back (or was skipped), why — so
					// cascade.log surfaces the fast-path hit/miss rate.
					seqFastpathFallback: graphBuildInfo.seqFastpathFallback,
				},
			});

			impact = computeImpactCascade(graph, normalizedFile, cwd);
			// #1023: buildOrUpdateGraph returns an EMPTY graph (seeded only with the
			// changed file's own symbols) when the repo is over
			// PI_LENS_REVIEW_GRAPH_MAX_FILES (`too_many_files`) or the root is unsafe
			// (`unsafe_root`) — both stamp mode "skipped" on the already-read
			// graphBuildInfo. A capped or entry-budget-truncated graph is also not a
			// complete dependent set even though it has nodes, so it must not look like
			// a clean leaf. Thread the ALREADY-KNOWN degraded state (never re-derived)
			// onto the result so the turn-end seam surfaces an honest advisory instead
			// of a silent all-clear (#533). Keyed strictly off the graph's explicit
			// degraded marker, NOT off `neighborFiles.length === 0`.
			if (
				(graphBuildInfo.mode === "skipped" ||
					graph.persistCoverage?.partial === true ||
					// #3605: a wasm trap cost some file its symbols and imports.
					(graphBuildInfo.wasmTrappedFiles ?? 0) > 0 ||
					// #3678 F-B: once the process-wide runtime aborts, later builds
					// contain no tree-sitter symbols and may have no trapped-file count.
					isTreeSitterWasmAborted() ||
					!graphBuildInfoTrustworthy) &&
				!impact.indeterminate
			) {
				const coverage = graph.persistCoverage;
				impact.indeterminate = {
					reason: "graph_degraded",
					detail: !graphBuildInfoTrustworthy
						? // #1179 fail-closed: the graph's own build-info was not found under
							// its identity and the global slot may be a sibling build's — don't
							// trust its mode. Surface an honest "unknown" advisory rather than a
							// (possibly sibling-derived) all-clear.
							"review graph coverage unknown — build state unavailable for this graph"
						: graphBuildInfo.mode === "skipped"
							? graphBuildInfo.skipReason === "too_many_files"
								? graphBuildInfo.sourceFileCountTruncated
									? `review graph disabled — more than ${graphBuildInfo.maxFileCount ?? "?"} files (cap ${graphBuildInfo.maxFileCount ?? "?"})`
									: `review graph disabled — ${graphBuildInfo.sourceFileCount ?? "?"} files over the ${graphBuildInfo.maxFileCount ?? "?"} cap`
								: graphBuildInfo.skipReason === "unsafe_root"
									? "review graph skipped — workspace root is at/above home dir"
									: `review graph unavailable (${graphBuildInfo.skipReason ?? "skipped"})`
							: isTreeSitterWasmAborted()
								? "review graph degraded — tree-sitter is disabled for this process until restart"
								: graphBuildInfo.wasmTrappedFiles
									? graphWasmTrapDetail(graphBuildInfo.wasmTrappedFiles)
									: coverage?.sourceFilesTruncated
										? "review graph partial — source walk stopped at its visited-entry budget"
										: "review graph partial — persisted graph coverage is incomplete",
					sourceFileCount: graphBuildInfo.sourceFileCount,
					maxFileCount: graphBuildInfo.maxFileCount,
				};
			}
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

			// #4438: dependents no import names, through the one implicit-scope
			// test (`lsp/implicit-scope.ts`) the diagnostics cache and the
			// inline-blocker sweep read: a Go file's package peers, and the JS/TS
			// files whose scope a changed ambient file feeds.
			const implicitDependents = implicitScopeDependentsOf(
				normalizedFile,
				reverseDepsIndex,
			);
			implicitScopeCut = implicitDependents.cut;
			if (implicitDependents.files.length > 0) {
				impact.neighborFiles = [
					...new Set([...impact.neighborFiles, ...implicitDependents.files]),
				];
				logCascade({
					phase: "neighbor_snapshot",
					filePath,
					neighborFile: "[implicit-scope]",
					diagnosticCount: implicitDependents.files.length,
					autoPropagate: false,
					metadata: { implicitScope: true, ...implicitDependents.cut },
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
					// #1109: store the timer and clear it once the race settles. Without
					// this, when `references()` wins (the common case), the losing
					// `setTimeout` stays a REF'D pending timer for the remaining 750ms —
					// harmless in a long-lived session, but a keep-alive tail in a
					// one-shot `pi --print` process (same uncleared-race-timeout class
					// fixed for the LSP client-wait leak in clients/lsp/index.ts, #1097).
					let refsTimer: ReturnType<typeof setTimeout> | undefined;
					try {
						const refs = await Promise.race([
							lspService.references(
								normalizedFile,
								line - 1,
								column - 1,
								false,
							),
							new Promise<never>((_, reject) => {
								refsTimer = setTimeout(() => reject(new Error("timeout")), 750);
							}),
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
					} finally {
						if (refsTimer !== undefined) clearTimeout(refsTimer);
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

			// #1462: size the rest of this run against the on-time window it has NOT
			// already spent. Derived HERE — after the graph build, the reverse-deps
			// refresh and the LSP-reference expansion, which is where the measured
			// overruns were bought — and used for both the transitive BFS cap and the
			// final slice, so a rescued run expands less as well as walking less.
			// Narrowing happens ONLY inside the rescue band (see cascade-budget.ts):
			// a run that is merely late keeps the whole set and is delivered complete
			// by #1443's carry-over, because a dropped neighbour is lost for good
			// while a late one is not. A wired callback that cannot observe an active
			// turn_end wait uses zero elapsed time rather than charging pre-turn age.
			{
				const settleStart = turnEndCascadeSettleStart?.();
				const elapsedMs = turnEndCascadeSettleStart
					? settleStart !== undefined && Number.isFinite(settleStart)
						? Math.max(0, Date.now() - settleStart)
						: 0
					: Date.now() - cascadeStart;
				const decision = deriveCascadeNeighbourBudget({ elapsedMs });
				cascadeNeighbourBudget = decision.budget;
				cascadeBudgetRemainingMs = decision.remainingMs;
				cascadeBudgetZone = decision.zone;
				cascadeDeliveryWindowMs = decision.deliveryWindowMs;
			}

			// Bounded transitive expansion: add depth>1 dependents (indirect
			// importers/callers/referencers) so the blast radius isn't limited to one
			// hop. The one-hop sets above remain the floor (they sort first); these
			// fill the remaining budget. Graph BFS is in-memory + capped.
			if (CASCADE_TRANSITIVE_DEPTH > 1) {
				const transitive = computeTransitiveImpact(graph, normalizedFile, {
					maxDepth: CASCADE_TRANSITIVE_DEPTH,
					maxHits: cascadeNeighbourBudget,
				});
				transitiveTruncated = transitive.truncated;
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

			// #1080: exclude KNOWN test-role files from every collateral impact
			// surface — the formatted header (formatImpactCascade reads `impact`
			// directly for `Direct importers`/`Direct callers`/`Check next` counts and
			// names), the active-touch/passive-snapshot neighbor set (sortedNeighbors is
			// derived from `impact.neighborFiles` below), and the returned `impact`
			// object. Applied HERE — after graph neighbors, reverse-deps, LSP reference
			// expansion, and transitive expansion have all been merged in — so it covers
			// every neighbor source (incl. module-level downstream files that entered via
			// computeImpactCascade and reference URIs pointing at `*.test.*`). Filtering
			// upstream of `sortedNeighbors` also means a test URI is never actively
			// touched solely for cascade diagnostics. Composes the shared `detectFileRole`
			// seam; a classifier failure RETAINS the candidate (honest — never a false
			// clean). The project ignore filter below is separate and unchanged (#297).
			cascadeCandidateCount = impact.neighborFiles.length;
			impact.directImporters = impact.directImporters.filter(
				(f) => !isTestRoleCollateral(f),
			);
			impact.directCallers = impact.directCallers.filter(
				(f) => !isTestRoleCollateral(f),
			);
			impact.neighborFiles = impact.neighborFiles.filter(
				(f) => !isTestRoleCollateral(f),
			);

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
			const eligibleNeighbors = [...impact.neighborFiles]
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
				});
			// #5055: a file whose reference to a changed symbol stayed on its
			// name-only placeholder is a dependent the graph could not see. When the
			// run has no neighbor to check, that file is the difference between a
			// leaf and an unproven dependent set, so it leaves the run indeterminate
			// instead of `no_neighbors`. Only a file edited this turn is accounted
			// for (B10: its own pipeline run answers for it), and a file removed
			// outside pi is gone, which the seq fast path's cached graph does not
			// know until its periodic re-verify (the neighbour chain above filters
			// the same way). The graph holds no test, vendor or ignored file, so no
			// other state clears a referrer.
			// Gated on the empty run on purpose: a run that has neighbors already
			// speaks, and flagging every unplaced common-name call there marked 185
			// of 515 files of this repo's own graph.
			if (eligibleNeighbors.length === 0 && !impact.indeterminate) {
				const unplaced = (impact.nameOnlyReferrers ?? []).filter(
					(f) =>
						!primaryFilesThisTurn.has(normalizeMapKey(f)) &&
						nodeFs.existsSync(f),
				);
				if (unplaced.length > 0) {
					const shown = unplaced
						.slice(0, UNPLACED_REFERRER_NAMED)
						.map((f) => toPosix(nodePath.relative(cwd, f)))
						.join(", ");
					const more =
						unplaced.length > UNPLACED_REFERRER_NAMED
							? ` (+${unplaced.length - UNPLACED_REFERRER_NAMED} more)`
							: "";
					impact.indeterminate = {
						reason: "unresolved_reference",
						detail: `${unplaced.length} file(s) reference a changed symbol by name alone, and several definitions share the name: ${shown}${more}`,
						unplacedReferrerCount: unplaced.length,
					};
				}
			}
			cascadeEligibleCount = eligibleNeighbors.length;
			cascadeFilterDroppedCount = Math.max(
				0,
				cascadeCandidateCount - cascadeEligibleCount,
			);
			cascadeBudgetTruncated = Math.max(
				0,
				eligibleNeighbors.length - cascadeNeighbourBudget,
			);
			sortedNeighbors = eligibleNeighbors.slice(0, cascadeNeighbourBudget);
			if (
				cascadeBudgetTruncated > 0 ||
				transitiveTruncated ||
				implicitScopeCut
			) {
				const budget = {
					candidateCount: cascadeCandidateCount,
					eligibleCount: cascadeEligibleCount,
					selectedCount: sortedNeighbors.length,
					truncatedCount: cascadeBudgetTruncated,
					...(transitiveTruncated && { transitiveTruncated: true }),
				};
				const detailParts = [
					...(cascadeBudgetTruncated > 0
						? [
								`cascade neighbor budget checked ${budget.selectedCount} of ${budget.eligibleCount} eligible dependents ` +
									`(${budget.truncatedCount} omitted)`,
							]
						: []),
					...(transitiveTruncated
						? [
								"transitive expansion was capped before all eligible dependents were enumerated",
							]
						: []),
					...(implicitScopeCut
						? [
								`implicit-scope expansion checked ${implicitScopeCut.checked} of ${implicitScopeCut.total} JS/TS files`,
							]
						: []),
				];
				const detail = detailParts.join("; ");
				impact.indeterminate = impact.indeterminate
					? {
							...impact.indeterminate,
							detail: impact.indeterminate.detail
								? `${impact.indeterminate.detail}; ${detail}`
								: detail,
							budget,
						}
					: { reason: "budget_truncated", detail, budget };
			}
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
			metadata: {
				neighbors: sortedNeighbors.slice(0, 10),
				candidateNeighborCount: cascadeCandidateCount,
				eligibleNeighborCount: cascadeEligibleCount,
				filterDroppedCount: cascadeFilterDroppedCount,
				budgetTrimmedCount: cascadeBudgetTruncated,
			},
		});

		const lspService = getLSPService();

		// Hoist passive snapshot once — used for auto-propagating LSPs and fallback path.
		// #1095 memo-freeze caveat: each getAllDiagnostics() result attaches `.binding`
		// as a LAZY getter that memoizes its disk verdict PER RESULT OBJECT. This cascade
		// re-calls getAllDiagnostics() every run and never retains the Map across turns,
		// so every run reads a FRESH verdict against current disk. If cross-turn retention
		// of this Map is ever introduced, the memoized binding would freeze stale — re-read
		// a fresh getAllDiagnostics() result at binding-read time instead of caching it.
		const allDiags = await lspService.getAllDiagnostics();

		const neighbors: CascadeResult["neighbors"] = [];
		let producedLspData = false;
		let coldSnapshotPaths: string[] = [];
		// #1104: did any DEGRADED-fallback display path (touch-error fallback,
		// appendFallbackNeighbors) withhold a post-edit entry solely because its
		// content binding was rejected (`boundToCurrentDisk === false` — computed
		// against a diverged/pre-fix-edit disk state)? Tracked separately from
		// `producedLspData` so the HONESTY check below can tell "genuinely nothing to
		// show" apart from "something existed but was untrustworthy and was hidden" —
		// the latter must not collapse into a clean-looking result (#1104 honesty
		// rule, same doctrine as #1023's graph-degraded indeterminate marker).
		let fallbackBindingRejected = false;
		const noLspCandidatePaths = new Set<string>();
		// #1444: neighbours whose in-lane wait was skipped for the quiet-window
		// reconcile to answer later. Logged on `cascade_result` so a cascade that
		// deferred EVERY neighbour is distinguishable from a genuine leaf (both are
		// `neighborCount: 0` with no output otherwise).
		let collectLaterSkipped = 0;
		// F1 (#1446 follow-up): `coldTouches` must be counted at the point each
		// neighbour's OUTCOME is actually known, not derived from `coldSnapshotPaths`
		// (finalized earlier). These counters partition the selected-neighbour
		// outcomes; passive snapshots and no-server selections are tracked
		// separately instead of silently disappearing from the denominator.
		// `coldTouches` includes every genuine active touch attempt, while
		// `touchFailures` is its separate bounded failure subtype.
		// #4485: `silentWaitTouches` counts the silent-push touches (answered or
		// not) and `deferredTouches` the subset left unanswered and recorded
		// outstanding. `commandPullTouches` is the subset of `coldTouches` sent
		// to a silent server through the #707 sync confirm.
		let deferredTouches = 0;
		let silentWaitTouches = 0;
		let commandPullTouches = 0;
		let coldTouches = 0;
		let passiveSnapshotHits = 0;
		let noLspConfigured = 0;
		let touchFailures = 0;
		// #3157: this run's AGGREGATE display-policy drops, across every neighbour
		// the four display sites below rendered. Aggregate, not per neighbour: a
		// cascade walks up to `CASCADE_NEIGHBOUR_BUDGET` (40) neighbours per edit,
		// so a record inside the loop would be per-occurrence logging on a per-edit
		// path — one bounded row per RUN instead (docs/engineering-principles.md "Every new failure path gets bounded observability").
		// `policyElapsedMs` accumulates ONLY the stack's own time (round 2, F2): a
		// clock started here would have spanned the whole `touchFile` fan-out and
		// reported the neighbour WALK as the policy phase — hundreds of ms against
		// the sub-millisecond cost AC 3 measured, under the same phase literal the
		// quiet-window lane writes.
		let policyElapsedMs = 0;
		// #4485: each neighbour's ERROR count as observed, before the display
		// policy and caps, for the `cascade_result` row. Bounded by the
		// selected slice plus the degraded fallback's `MAX_FILES`.
		const rawErrorsByPath = new Map<string, number>();
		// #4487: the selected neighbours freshly observed by this run, clean
		// or not (`CascadeRun.observedNeighborPaths`).
		const observedPaths: string[] = [];
		// #4485: selected neighbours the run does not cover, by the server asked
		// and by WHY (`CascadeRun.unconfirmed`).
		const unconfirmedByServer = new Map<
			string,
			{
				serverId: string;
				reason: CascadeUnconfirmedReason;
				waitMs: number;
				paths: string[];
			}
		>();
		const noteUnconfirmed = (
			serverId: string,
			reason: CascadeUnconfirmedReason,
			waitMs: number,
			neighborPath: string,
		): void => {
			// The key carries the reason: one server can hold BOTH shapes for
			// different neighbours in one run, and merging them would attribute one
			// cause's paths to the other's sentence (#5040, defect shape 24).
			const key = `${reason}:${serverId}`;
			const group = unconfirmedByServer.get(key) ?? {
				serverId,
				reason,
				waitMs,
				paths: [],
			};
			group.waitMs = Math.max(group.waitMs, waitMs);
			group.paths.push(neighborPath);
			unconfirmedByServer.set(key, group);
		};
		const policyCounts = {
			suppressed: 0,
			auxSuppressed: 0,
			total: 0,
			inputTruncated: 0,
		};
		/**
		 * The ONE seam every in-lane cascade DISPLAY list goes through (#3157).
		 *
		 * Before this, all four sites open-coded `convertLspDiagnostics(...)` and
		 * rendered the result raw: `grep applyFindingPolicy clients/dispatch/
		 * integration.ts` returned nothing, so a neighbour ERROR the agent had
		 * marked `false-positive` was hidden by `mode=delta`/`mode=full`/the
		 * per-edit dispatcher/the probe lane/the quiet-window cascade run and STILL
		 * re-reported here on every edit that cascaded to it. The severity filter
		 * and the `MAX_PER_FILE` display cap were the fourth copy of the same three
		 * lines and fold in with it.
		 *
		 * `neighborContent` is passed by the ONE caller that has already read the
		 * neighbour (the active touch reads it to feed `touchFile`) — those are the
		 * exact bytes the diagnostics were computed against, so it is both free and
		 * more faithful than a re-read. The other three sites let the shared helper
		 * read once, and only once a neighbour actually has an ERROR to render.
		 *
		 * Stage order (round 2, F1): severity filter → input bound → convert →
		 * retag → policy → DISPLAY cap. `MAX_PER_FILE` is applied to the survivors
		 * inside the helper; applying it here, before the policy, let policy drops
		 * consume display slots and rendered a false clean.
		 */
		const cascadeDisplay = (
			rawDiags: readonly import("../lsp/client.js").LSPDiagnostic[],
			neighborPath: string,
			neighborContent?: string,
		): CascadeResult["neighbors"][number]["diagnostics"] => {
			const started = Date.now();
			const errors = rawDiags.filter((d) => d.severity === 1);
			rawErrorsByPath.set(neighborPath, errors.length);
			const policyInput = errors.slice(0, MAX_POLICY_INPUT_PER_FILE);
			const result = applyCascadeDisplayPolicy(policyInput, {
				cwd,
				policyRoot: projectRoot ?? cwd,
				filePath: neighborPath,
				displayCap: MAX_PER_FILE,
				...(neighborContent !== undefined && { content: neighborContent }),
			});
			policyCounts.suppressed += result.suppressed;
			policyCounts.auxSuppressed += result.auxSuppressed;
			policyCounts.total += result.total;
			policyCounts.inputTruncated += errors.length - policyInput.length;
			policyElapsedMs += Date.now() - started;
			return result.diagnostics;
		};

		if (sortedNeighbors.length > 0) {
			const snapshotPaths = sortedNeighbors.filter(
				shouldReadCascadeFromSnapshot,
			);
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
				// #4486: only a snapshot published after this compute started is an
				// observation of the edited state; an older one, whatever its age,
				// falls through to the touch below.
				const postEdit =
					entry != null && isPostEditObservation(entry.ts, cascadeStart);
				// #1095: content binding is the INNER gate; post-edit stays the outer bound.
				//   false     → the server's diagnostics were computed against a DIFFERENT
				//               disk state (e.g. the PRE-fix content) — don't trust or
				//               reconcile this snapshot; fall through to an active touch on
				//               the same (cold-snapshot) budget as a TTL-stale entry. This
				//               kills the window where the first cascade after a fix-edit
				//               replays the neighbor's pre-fix snapshot.
				//   "unknown" → version-less/unreadable: reconcile if post-edit.
				//   true      → bound to current disk: reconcile (post-edit still the outer bound).
				// Reading `.binding` triggers the lazy disk verify on the getAllDiagnostics
				// result — done ONLY when post-edit so a doomed (stale) entry never pays the
				// stat+hash.
				const boundToDisk: BoundToCurrentDisk | undefined = postEdit
					? readBoundToCurrentDisk(entry)
					: undefined;
				const bindingRejected = boundToDisk === false;
				const snapshotValid = postEdit && !bindingRejected;

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
						// #1095: distinguish a binding-rejected fall-through (post-edit but the
						// server's view diverged from disk) from a missing or pre-edit one.
						...(bindingRejected && {
							metadata: { bindingState: bindingStateLabel(boundToDisk) },
						}),
						// #4486: a snapshot from before this compute started.
						...(entry != null &&
							!postEdit && { metadata: { predatesCascade: true } }),
					});
					coldSnapshotPaths.push(neighborPath);
					continue;
				}

				// #692: `source: "cascade"` used to be passed here to label `rule`
				// (`cascade:<code>`) — that override is gone (identity must come from
				// the diagnostic's own source; see `scanOrigin`'s doc comment), and
				// cascade neighbor diagnostics are ephemeral display-only output
				// (never reconciled into persisted widget/dedup state), so the label
				// had no remaining purpose and is simply dropped rather than migrated.
				// #3157 site 1 of 4: the passive cold-snapshot hit.
				const diags = cascadeDisplay(entry.diags, neighborPath);
				producedLspData = true;
				passiveSnapshotHits++;
				observedPaths.push(neighborPath);
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

				// #1093: a valid passive snapshot IS a confirmed observation of this
				// neighbor's current LSP-error state (#571 semantics) — reconcile it into
				// the footer widget, INCLUDING the confirmed-clean `[]` case, so a
				// fix-edit to the primary that resolves a cross-file error in this
				// neighbor clears the neighbor's now-stale footer entry (the #1092
				// defect). MERGE (genuine LSP errors only — auxiliary findings excluded,
				// see `cascadeReconcilableLspErrors`) so a live biome/ruff/aux finding or
				// LSP warning on the neighbor is preserved. Keyed by the primary edit's
				// `writeSeq` so a genuinely newer per-edit write still wins the
				// WriteOrderingGuard. `observedAt = entry.ts` (the snapshot's own publish
				// time) — NOT now() — so replaying a snapshot never re-arms the
				// mtime-staleness gate (the same #1092 re-arming defect this PR fixes
				// for cache hits).
				//
				// #1186: `observedAt` here stamps only the INCOMING LSP-error entries.
				// PRESERVED entries keep their own (possibly fresher) per-entry
				// `observedAt`, and `reconcileStaleWidgetFiles` now gates per ENTRY — so
				// if the neighbor's mtime later falls between this `entry.ts` and a
				// preserved entry's real observation time, only the stale incoming entry
				// drops and the fresher preserved finding survives (previously the whole
				// record was over-cleared; that residual is now fixed).
				reconcileCascadeNeighborLspErrors(
					neighborPath,
					cascadeReconcilableLspErrors(entry.diags, neighborPath),
					widgetOrder,
					entry.ts,
				);

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

					// #1899: the A5 same-write cache read stood here. See the removal note
					// at the module's cache declarations — the gate could only pass inside
					// a single write, which never runs two cascades.

					const configuredServerCount =
						getServersForFileWithConfig(neighborPath).length;
					if (configuredServerCount === 0) {
						noLspConfigured++;
						noLspCandidatePaths.add(cacheKey);
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
					// #3481: stamped before the read; the touches below run after awaits,
					// and the stamp keeps them from landing over a newer write's touch.
					const readStamp = performance.now();
					// #3573: the wall-clock twin, the confirmed touch's widget row's
					// `observedAt`: a dependency written while the touch waits on the
					// server is then newer than the row.
					const readAtMs = Date.now();
					const content = await nodeFs.promises.readFile(neighborPath, "utf8");

					// #458/#1444/#4485: tier-aware cascade-lane wait (cascade-tier.ts).
					// A `command-pull` server is silent on clean but can be asked: it
					// takes the waiting touch below, whose #707 sync confirm gets
					// tsserver's verdict. A silent server with nothing to ask
					// (`tier3-silent`, `collect-later`) is touched without collecting
					// and given SILENT_PUSH_WAIT_MS to publish; silence leaves the
					// neighbour unconfirmed and recorded outstanding, never clean.
					// Ambiguous/missing capability data always classifies as "waits"
					// (today's behavior). The whole attempt is try/caught: any
					// surprise (a service shape that doesn't expose
					// getCapabilitySnapshots/getClientForFile, a thrown rejection)
					// falls through to the existing full-wait path below rather than
					// skip the wait on a failure.
					if (isTierAwareCascadeEnabled()) {
						try {
							const snapshots =
								(await lspService.getCapabilitySnapshots?.(neighborPath)) ?? [];
							const tier = classifyCascadeWaitTier(
								lspService,
								neighborPath,
								snapshots,
							);
							if (tier === "command-pull") commandPullTouches++;
							if (
								tier === "tier3-silent" ||
								tier === "collect-later" ||
								tier === "diagnostics-unsupported"
							) {
								const spawnedForTouch =
									await lspService.getClientForFile(neighborPath);
								if (spawnedForTouch) {
									const touchedClient = spawnedForTouch.client;
									// #4485: the client-wide counter, read BEFORE the notify.
									// A publish for THIS file stores the counter's then
									// value as the file's version, so a file version above
									// it proves a publish for this file after the touch;
									// a sibling neighbour's publish cannot (#1531).
									const versionBefore = touchedClient.diagnosticsVersion;
									// Sampled BEFORE the touchFile notify: a publish landing
									// in the notify→record gap must read as post-touch at
									// reconcile time, never be misclassified as pre-touch
									// (the reconcile compares this against the client's
									// PER-FILE publish timestamp — see cascade-tier.ts).
									const touchedAt = Date.now();
									await lspService.touchFile(neighborPath, content, {
										diagnostics: "none",
										collectDiagnostics: false,
										silent: true,
										source: "cascade",
										clientScope: "primary",
										readStamp,
									});
									if (tier === "diagnostics-unsupported") {
										logCascade({
											phase: "cascade_skip",
											filePath,
											neighborFile: neighborPath,
											durationMs: Date.now() - neighborStart,
											lspServerCount: configuredServerCount,
											coldSnapshot: isColdSnapshot,
											metadata: {
												serverId: spawnedForTouch.client.serverId,
												waitTier: tier,
											},
										});
										return undefined;
									}
									silentWaitTouches++;
									await touchedClient.waitForDiagnostics(
										neighborPath,
										SILENT_PUSH_WAIT_MS,
										{ minVersion: versionBefore },
									);
									// The client's own per-file read: what the publish
									// after the touch left (an empty list is a clean answer).
									const published =
										touchedClient.getDiagnosticsVersionForPath(neighborPath) >
										versionBefore
											? touchedClient.getDiagnostics(neighborPath)
											: undefined;
									if (published) {
										// A publish for this file after the touch: a confirmed
										// observation, reconciled like the waiting path's.
										const diags = cascadeDisplay(
											published,
											neighborPath,
											content,
										);
										producedLspData = true;
										observedPaths.push(neighborPath);
										const durationMs = Date.now() - neighborStart;
										logCascade({
											phase: "neighbor_touch",
											filePath,
											neighborFile: neighborPath,
											diagnosticCount: diags.length,
											durationMs,
											lspTouched: true,
											lspServerCount: configuredServerCount,
											coldSnapshot: isColdSnapshot,
											metadata: {
												serverId: touchedClient.serverId,
												waitTier: tier,
												silentWait: "answered",
											},
										});
										reconcileCascadeNeighborLspErrors(
											neighborPath,
											cascadeReconcilableLspErrors(published, neighborPath),
											widgetOrder,
											readAtMs,
										);
										return {
											filePath: neighborPath,
											reason: neighborReason(
												importerSet,
												callerSet,
												neighborPath,
											),
											diagnostics: diags,
											lspTouched: true as const,
											durationMs,
										} satisfies CascadeResult["neighbors"][number];
									}
									// Silence through the wait: the neighbour is unconfirmed
									// (the run says so) and stays outstanding for turn_end's
									// peek and the quiet window.
									const recordTouch = () =>
										recordOutstandingCascadeTouch({
											filePath: neighborPath,
											serverId: touchedClient.serverId,
											touchedAt,
											client: new WeakRef(touchedClient),
										});
									if (sessionGeneration)
										sessionGeneration.guardedWrite(neighborPath, recordTouch);
									else recordTouch();
									noteUnconfirmed(
										touchedClient.serverId,
										"no-answer",
										SILENT_PUSH_WAIT_MS,
										neighborPath,
									);
									const durationMs = Date.now() - neighborStart;
									if (tier === "collect-later") collectLaterSkipped++;
									deferredTouches++;
									logCascade({
										phase: "cascade_tier3_skip",
										filePath,
										neighborFile: neighborPath,
										durationMs,
										lspServerCount: configuredServerCount,
										coldSnapshot: isColdSnapshot,
										metadata: {
											serverId: touchedClient.serverId,
											waitTier: tier,
											silentWait: "unconfirmed",
											silentWaitMs: SILENT_PUSH_WAIT_MS,
										},
									});
									// Not an answer (#240 doctrine). Return undefined: the
									// degraded-fallback path below still has a chance to
									// surface a post-edit passive snapshot.
									return undefined;
								}
							}
						} catch (tierErr) {
							dbg?.(
								`cascade tier-aware skip attempt failed for ${neighborPath}, falling back to full wait: ${tierErr}`,
							);
						}
					}

					// Open with silent=true (suppresses didChangeWatchedFiles rechecks, C2)
					// and collect diagnostics from the same touched clients.
					// Cold-snapshot neighbors (autoPropagate LSP, server warm) use a tighter
					// 1000ms budget — they should respond quickly; we'd rather return zero
					// than block cascade for 2s on a slow open.
					// F1: this is the ONE remaining outcome after the silent-push path
					// has been ruled out — a genuine active LSP touch is being issued
					// right now. Count it here (an attempt, whether it resolves, times
					// out, or the promise rejects below in the allSettled catch) rather
					// than from `coldSnapshotPaths`, which is finalized before any of the
					// above checks run.
					coldTouches++;
					// #1720: language-server scope only, matching the tier-aware touch
					// above (`clientScope: "primary"`, integration.ts:1826). A neighbor's
					// content did not change — only its import target did — so an
					// auxiliary scanner's (ast-grep/opengrep/typos) file-local verdict for
					// it cannot have changed; only cross-file type semantics (the
					// language server) can. `reconcileCascadeNeighborLspErrors` already
					// merges errors-only and preserves the neighbor's existing aux
					// findings by construction (see its doc comment and
					// `cascadeReconcilableLspErrors` above), so an `"all"`-scope touch
					// paid full aux notify traffic and aux confirmation-wait latency for
					// a re-derivation nothing downstream ever reads. `"primary"` resolves
					// per `neighborPath` (`getClientForFile` → `getServersForFileWithConfig`),
					// so a multi-language neighbor still gets its OWN language server,
					// not the primary edit's.
					const rawDiags = await lspService.touchFile(neighborPath, content, {
						diagnostics: "document",
						collectDiagnostics: true,
						maxClientWaitMs: isColdSnapshot ? 1000 : 2000,
						silent: true,
						source: "cascade",
						clientScope: "primary",
						readStamp,
						nameUnansweredPrimaries: true,
					});
					if (!rawDiags) {
						// #3483: the idle reset can destroy the service this compute
						// captured while neighbours are still being touched; both
						// destroyed returns in touchFile (entry and client acquire)
						// come back undefined. Keep the neighbour as unconfirmed, or
						// the run silently loses it and can read "clean".
						if (!lspService.checkDestroyed()) return undefined;
						const durationMs = Date.now() - neighborStart;
						logCascade({
							phase: "neighbor_touch",
							filePath,
							neighborFile: neighborPath,
							diagnosticCount: 0,
							durationMs,
							lspTouched: true,
							lspServerCount: configuredServerCount,
							coldSnapshot: isColdSnapshot,
							metadata: {
								inconclusive: true,
								inconclusiveReason: "service-destroyed",
							},
						});
						return {
							filePath: neighborPath,
							reason: neighborReason(importerSet, callerSet, neighborPath),
							diagnostics: [],
							lspTouched: true as const,
							inconclusive: true as const,
							durationMs,
						} satisfies CascadeResult["neighbors"][number];
					}
					// #4403 round 4 (N2): no primary answered, and the touch says
					// why. That is not an inconclusive re-check of this neighbour;
					// it holds for every file the server serves, so the run names
					// the server once (`splitCascadeUnansweredPrimaries`) instead of
					// listing each neighbour.
					// `resolveTouchVerdict` gives this reason only with the ids.
					if (rawDiags.inconclusiveReason === "primary-unavailable") {
						const serverIds = rawDiags.inconclusiveServerIds ?? [];
						const cause = rawDiags.primaryUnavailableCause ?? "unstarted";
						// #5014 r2 (F2): a `fallbackFor` alternate can answer while its
						// owner is named here. Its findings are delivered beside the
						// line; they never confirm the neighbour (no reconcile, no
						// observation).
						// #5034 r7: and only when they describe this run's bytes. An
						// answer from before the edit (#5040, the rule the branch below
						// applies) or one computed for other bytes than disk (#1095, the
						// rule the runner applies to this touch shape, #5034 r3 F7) is
						// withheld; the line stays, so the neighbour never reads clean.
						const preEditAnswer = isPreEditAnswer(rawDiags, cascadeStart)
							? readReusedAnswer(rawDiags)
							: undefined;
						const bindingRejected = readBoundToCurrentDisk(rawDiags) === false;
						const diags =
							preEditAnswer || bindingRejected
								? []
								: cascadeDisplay(rawDiags.diags, neighborPath, content);
						const durationMs = Date.now() - neighborStart;
						logCascade({
							phase: "neighbor_touch",
							filePath,
							neighborFile: neighborPath,
							diagnosticCount: diags.length,
							durationMs,
							lspTouched: true,
							lspServerCount: configuredServerCount,
							coldSnapshot: isColdSnapshot,
							metadata: {
								inconclusive: true,
								...readInconclusiveAttribution(rawDiags),
								primaryUnavailableCause: cause,
								...(preEditAnswer && {
									preEditAnswer: true,
									answerServerId: preEditAnswer.serverId,
									answerPublishedAt: preEditAnswer.publishedAt,
									cascadeStart,
								}),
								...(bindingRejected && {
									bindingState: bindingStateLabel(false),
								}),
							},
						});
						return {
							filePath: neighborPath,
							reason: neighborReason(importerSet, callerSet, neighborPath),
							diagnostics: diags,
							lspTouched: true as const,
							primaryUnavailable: { serverIds: [...serverIds], cause },
							durationMs,
						} satisfies CascadeResult["neighbors"][number];
					}
					// #5040: the answer exists, but it predates this run's edit. A
					// push-only server (jdtls) publishes for a dependent when ITS model
					// changes, not when we ask, so a notify-skipped touch of unchanged
					// content reports whatever the server last published — possibly from
					// before the exporter changed. That is not an observation of the
					// post-edit state, so it is neither an answer to display nor a
					// confirmed clean: the neighbour is named unconfirmed and the run
					// never reads `clean` for it (the same refusal the passive snapshot
					// and both fallbacks already make, #4486).
					const reusedAnswer = readReusedAnswer(rawDiags);
					if (
						isPreEditAnswer(rawDiags, cascadeStart) &&
						reusedAnswer !== undefined
					) {
						const durationMs = Date.now() - neighborStart;
						noteUnconfirmed(
							reusedAnswer.serverId,
							"pre-edit-answer",
							0,
							neighborPath,
						);
						// One counted record per server and path: the reason a run cannot
						// answer for this neighbour is field evidence (is this server ever
						// re-publishing its dependents?), so it is a count, not a
						// once-per-session flag.
						incrementDegradationCount({
							kind: "cascade-pre-edit-answer",
							subject: `${reusedAnswer.serverId}:${normalizeMapKey(neighborPath)}`,
							reason: `no publication for this dependent since the edit, so the cached answer is ${Math.max(0, cascadeStart - reusedAnswer.publishedAt)} ms older than this run`,
						});
						logCascade({
							phase: "neighbor_touch",
							filePath,
							neighborFile: neighborPath,
							diagnosticCount: 0,
							durationMs,
							lspTouched: true,
							lspServerCount: configuredServerCount,
							coldSnapshot: isColdSnapshot,
							metadata: {
								preEditAnswer: true,
								answerServerId: reusedAnswer.serverId,
								answerPublishedAt: reusedAnswer.publishedAt,
								cascadeStart,
								answerAgeMs: cascadeStart - reusedAnswer.publishedAt,
							},
						});
						// Not an answer (#240 doctrine): the degraded-fallback path below
						// still has a chance to surface a post-edit passive snapshot.
						return undefined;
					}
					// #1093/#571/#1095: a touch result is only a CONFIRMED observation of the
					// neighbor's current on-disk state when it is neither `inconclusive` (the
					// notify/diagnostics wait lapsed — e.g. the tight 1000ms cold-snapshot
					// budget on a slow server) NOR bound-false (`binding.boundToCurrentDisk
					// === false` — the diagnostics were computed against a different disk state
					// than what's on disk now). Either disqualifier means a resolved `[]` is
					// NOT a confirmed clean: treating it as one would WIPE a live footer finding
					// (the #533 false-clean trap, worse than the stale-display bug). Both flags
					// are folded into `isConfirmedTouch` so no gate below can miss one. A
					// confirmed result reconciles and counts as this run's observation of
					// the neighbour (#4487); an unconfirmed one does neither.
					// #5040: the age axis is NOT folded in: it is refused above, in the
					// branch that also records the ledger row, because it applies to the
					// CLEAN claim and to the findings alike and returns before this read.
					const confirmed = isConfirmedTouch(rawDiags);
					const bindingRejected = readBoundToCurrentDisk(rawDiags) === false;
					const inconclusive = readInconclusive(rawDiags);
					// #1470/#1493: the third, independent reason a touch is unconfirmed — an
					// auxiliary that never reported, cut off by our grace timer or silent
					// with nothing published for this content. Logged alongside the other two
					// so cascade.log alone still tells the three apart.
					const unconfirmedServerIds = touchCoverageGap(rawDiags);
					// #692: `source: "cascade"` no longer overrides `rule` (see the
					// doc comment on the sibling call above) — dropped rather than
					// migrated to `scanOrigin` since cascade output never touches
					// persisted widget/dedup state.
					// #1179: the severity filter inside `cascadeDisplay` operates on
					// `rawDiags.diags`; the `inconclusive`/`binding` flags read above
					// stay on the `rawDiags` wrapper and are unaffected (the shape-5 fix).
					// #3157 site 2 of 4: the fresh in-lane touch. `content` is the copy
					// this touch was computed against — no second read.
					// #5051: bound-false answers are not displayed either. Rows computed
					// for bytes the neighbour no longer holds are not this edit's
					// cascade error; the runner withholds the same rows (#5017 L, one
					// reader: `readBoundToCurrentDisk`), as the primary-unavailable
					// branch above does (#5034 r7). The neighbour stays in the result,
					// flagged `inconclusive` below, so the run owes it its line and
					// never reads clean.
					const diags = bindingRejected
						? []
						: cascadeDisplay(rawDiags.diags, neighborPath, content);
					const durationMs = Date.now() - neighborStart;

					// #1899: the A5 same-write cache write stood here.
					producedLspData = true;
					if (confirmed) observedPaths.push(neighborPath);

					logCascade({
						phase: "neighbor_touch",
						filePath,
						neighborFile: neighborPath,
						diagnosticCount: diags.length,
						durationMs,
						lspTouched: true,
						lspServerCount: configuredServerCount,
						coldSnapshot: isColdSnapshot,
						// #1104: an unconfirmed touch has two independent, otherwise
						// indistinguishable causes — `inconclusive` (the notify/diagnostics
						// wait lapsed its deadline) and bound-false (`bindingState`, #1095 —
						// diagnostics computed against a diverged disk state). Surface
						// `inconclusive` unconditionally so cascade.log alone (no
						// cross-referencing latency.log) tells them apart; `bindingState`
						// stays conditional since "bound" carries no extra signal.
						metadata: {
							inconclusive,
							// #1549: WHICH primary and WHICH deadline, present only when the
							// touch actually reported itself inconclusive.
							...(inconclusive && readInconclusiveAttribution(rawDiags)),
							...(bindingRejected && {
								bindingState: bindingStateLabel(false),
							}),
							...(unconfirmedServerIds.length > 0 && {
								unconfirmedServerIds: [...unconfirmedServerIds],
							}),
						},
					});

					// #1093/#1095: a completed, CONFIRMED active touch is a confirmed
					// observation of this neighbor's current LSP-error state (#571) —
					// reconcile it into the footer widget, INCLUDING the confirmed-clean `[]`
					// case, so a fix-edit to the primary that resolves a cross-file error in
					// this neighbor clears the neighbor's now-stale footer entry (the #1092
					// defect). MERGE (genuine LSP errors only — auxiliary findings excluded,
					// see `cascadeReconcilableLspErrors`) so a live biome/ruff/aux finding or
					// LSP warning survives this errors-only re-check. Keyed by the primary
					// edit's `writeSeq` so a genuinely newer per-edit write still wins the
					// WriteOrderingGuard. `observedAt` is the neighbor's read (#3573). The
					// inconclusive touch, the BOUND-FALSE touch (#1095 — computed against a
					// diverged disk state), the unanswered silent-push touch and the
					// rejected-touch fallback are all deliberately NOT reconciled — none
					// is a confirmed observation.
					if (confirmed) {
						reconcileCascadeNeighborLspErrors(
							neighborPath,
							cascadeReconcilableLspErrors(rawDiags.diags, neighborPath),
							widgetOrder,
							readAtMs,
						);
					}

					return {
						filePath: neighborPath,
						reason: neighborReason(importerSet, callerSet, neighborPath),
						diagnostics: diags,
						lspTouched: true as const,
						...((inconclusive || bindingRejected) && {
							inconclusive: true as const,
						}),
						// #1459: carry the coverage gap to the agent-facing surface. A
						// scanner whose breaker was open, whose resync the fan-out gate
						// deferred, or whom the aux grace timer cut off never looked at this
						// file — without this the neighbour reaches the agent as
						// `{ diagnostics: [] }` with no marker, which is the false-clean the
						// touch already refuses to claim for itself.
						...(unconfirmedServerIds.length > 0 && {
							unconfirmedServerIds: [...unconfirmedServerIds],
						}),
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
					touchFailures++;
					// A3: one failed LSP doesn't kill the rest — fall back to passive snapshot
					dbg?.(
						`cascade neighbor touch error for ${neighborPath}: ${result.reason}`,
					);
					const entry = allDiags.get(normalizeMapKey(neighborPath));
					// #4486: the same post-edit gate as the passive snapshot; a
					// pre-edit entry is not this neighbour's current state.
					const postEdit =
						entry != null && isPostEditObservation(entry.ts, cascadeStart);
					// #1104: consult binding before trusting a post-edit fallback snapshot —
					// MATCH #1100/#1095 semantics (false → skip, "unknown" → use, true →
					// use). Without this, a failed active touch could still re-display a
					// bound-false (pre-fix-edit) snapshot even though the reconcile path
					// (#1100) already refuses to trust it for the widget. Reading
					// `.binding` triggers the lazy disk verify — done ONLY when post-edit,
					// same discipline as the snapshot-tier gate above.
					const boundToDisk: BoundToCurrentDisk | undefined = postEdit
						? readBoundToCurrentDisk(entry)
						: undefined;
					const bindingRejected = boundToDisk === false;
					if (bindingRejected) fallbackBindingRejected = true;
					logCascade({
						phase: "neighbor_fallback",
						filePath,
						neighborFile: neighborPath,
						fallbackUsed: true,
						error: String(result.reason),
						// #1104: distinguish a binding-rejected fallback (post-edit but the
						// server's view diverged from disk) from a missing or pre-edit one —
						// same conditional pattern as the neighbor_touch/neighbor_snapshot
						// phases above.
						...(bindingRejected && {
							metadata: { bindingState: bindingStateLabel(boundToDisk) },
						}),
					});
					// #692: `source: "cascade"` dropped (see the doc comment above the
					// first cascade call site in this file) — no longer affects `rule`
					// and cascade output never touches persisted widget/dedup state.
					// #3157 site 3 of 4: the touch-error fallback. The touch failed, so
					// no content was read for this neighbour — the helper reads it.
					const diags =
						postEdit && !bindingRejected
							? cascadeDisplay(entry.diags, neighborPath)
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
		// not merely when the graph returned zero neighbors. In a mixed run, only
		// candidates that had no configured LSP may use passive fallback; broadening
		// to unrelated cache entries would make the partial active result misleading.
		if (producedLspData && noLspCandidatePaths.size > 0) {
			const bindingRejected = appendFallbackNeighbors(
				neighbors,
				allDiags,
				normalizedFileKey,
				cwd,
				filePath,
				cascadeDisplay,
				cascadeStart,
				noLspCandidatePaths,
			);
			if (bindingRejected) fallbackBindingRejected = true;
		} else if (!producedLspData) {
			const bindingRejected = appendFallbackNeighbors(
				neighbors,
				allDiags,
				normalizedFileKey,
				cwd,
				filePath,
				cascadeDisplay,
				cascadeStart,
			);
			if (bindingRejected) fallbackBindingRejected = true;
			if (neighbors.some((n) => n.reason === "fallback")) {
				logCascade({
					phase: "neighbor_fallback",
					filePath,
					fallbackUsed: true,
					neighborCount: neighbors.length,
				});
			}
		}

		// #3157: ONE row per cascade run, covering every neighbour the four display
		// sites filtered — never one per neighbour. `durationMs` is the stack's own
		// accumulated time (the content reads the fold added included), NOT the
		// neighbour walk it runs inside, so this row stays comparable with the
		// quiet-window lane's row under the same phase literal (round 2, F2).
		// Silent when nothing was dropped or truncated; gated inside
		// `recordCascadeFindingPolicy`.
		recordCascadeFindingPolicy({
			filePath,
			durationMs: policyElapsedMs,
			suppressed: policyCounts.suppressed,
			total: policyCounts.total,
			auxSuppressed: policyCounts.auxSuppressed,
			inputTruncated: policyCounts.inputTruncated,
		});

		// #4403 round 4 (N2): a neighbour no primary answered for stays in the
		// result only while the run names its server, so turn_end's ownership
		// pass delivers the line. Once that line was delivered the agent was
		// told, once per session, that the server's neighbours are not checked;
		// no pending line repeats it (#4485 row 7). The run still never reads
		// clean: its skip reason is "indeterminate".
		// #4487: no delta here any more. Every observed error is listed on
		// every run; turn_end gives each neighbour to one result per turn and
		// labels an error it delivered on an earlier turn.
		const unansweredPrimaries = splitCascadeUnansweredPrimaries(neighbors);
		const primaryUnavailableToldBefore = unansweredPrimaries.dropped.length > 0;
		const visibleNeighbors = [
			...unansweredPrimaries.answered,
			...unansweredPrimaries.unanswered,
		];

		const layout = cascadeSectionLayout(
			cwd,
			impact,
			visibleNeighbors.length,
			impact.neighborFiles.length,
			policyCounts.suppressed,
			policyCounts.inputTruncated,
		);
		// @delivery-surface: dispatch-integration:in-lane-cascade
		const neighborBlock = formatCascadeNeighborDiagnostics(
			cwd,
			visibleNeighbors,
			{ noun: layout.noun, includeReason: layout.includeReason },
		);
		const format = (unansweredPrimaryNote?: string): string =>
			composeCascadeSection(neighborBlock, layout, unansweredPrimaryNote);
		const notes = unansweredPrimaries.notes;
		const formatted = format(notes.map((note) => note.line).join("\n"));

		// #1104 HONESTY: filtering a bound-false display candidate must not turn a
		// degraded/indeterminate cascade into a clean-looking one (same doctrine as
		// #1023's graph-degraded marker). If every candidate the degraded-fallback
		// paths considered this run was binding-rejected and nothing else produced
		// output, thread the SAME indeterminate marker #1023 built so the turn-end
		// advisory (clients/runtime-turn.ts) surfaces an honest note instead of
		// silence — never let a withheld-stale-snapshot run look like a genuine
		// clean leaf. `!impact.indeterminate` preserves a graph-degraded marker that
		// already exists (never overwritten).
		if (!formatted && fallbackBindingRejected && !impact.indeterminate) {
			impact.indeterminate = {
				reason: "lsp_binding_rejected",
				detail:
					"cascade fallback diagnostics were withheld — stale snapshot content did not match current disk (binding rejected)",
			};
		}

		const filesWithErrors = visibleNeighbors.filter(
			(n) => n.diagnostics.length > 0,
		).length;
		const selectedOutcomeCount =
			passiveSnapshotHits + silentWaitTouches + coldTouches + noLspConfigured;
		// #4485: the unanswered neighbours, by server (bounded by the selected
		// slice). Any of them keeps the run from reading `no_neighbors`/`clean`.
		const unconfirmedServers = [...unconfirmedByServer.values()];
		const unconfirmedCount = unconfirmedServers.reduce(
			(sum, group) => sum + group.paths.length,
			0,
		);
		const unconfirmed: CascadeUnconfirmed | undefined =
			unconfirmedCount > 0
				? { count: unconfirmedCount, servers: unconfirmedServers }
				: undefined;
		const observedNeighborPaths =
			observedPaths.length > 0 ? observedPaths.slice() : undefined;
		let rawErrors = 0;
		for (const count of rawErrorsByPath.values()) rawErrors += count;
		const selectedOutcomeGap = Math.max(
			0,
			sortedNeighbors.length - selectedOutcomeCount,
		);
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
				indeterminateReason: impact.indeterminate?.reason,
				candidateNeighborCount: cascadeCandidateCount,
				eligibleNeighborCount: cascadeEligibleCount,
				filterDroppedCount: cascadeFilterDroppedCount,
				selectedNeighborCount: sortedNeighbors.length,
				selectedOutcomeCount,
				selectedOutcomeGap,
				passiveSnapshotHits,
				noLspConfigured,
				touchFailures,
				// #1444: >0 means "answers are still outstanding", not "nothing found".
				collectLaterSkipped,
				// Log when cascade ran but found nothing — distinguishes "clean" from "no signal"
				noNeighbors: visibleNeighbors.length === 0,
				noErrors: visibleNeighbors.length > 0 && filesWithErrors === 0,
				// #1446 item 5: outcome counts as numbers instead of an inference
				// from `coldSnapshot`/`snapshotMissing` flags scattered across
				// per-neighbor `neighbor_touch`/`neighbor_snapshot` rows.
				// F1: passive snapshots + silentWaitTouches + coldTouches + no-server
				// selections partition the selected neighbours; touchFailures and
				// commandPullTouches are subtypes of coldTouches, deferredTouches
				// (unanswered, recorded outstanding) a subtype of silentWaitTouches.
				silentWaitTouches,
				deferredTouches,
				coldTouches,
				commandPullTouches,
				// #4485: neighbours left unanswered within their bound; >0 means the
				// run is not a clean verdict for them.
				unconfirmed: unconfirmedCount,
				// #4485: ERRORs as observed, before the display policy and caps
				// (there is no delta to count before any more, #4487).
				rawErrors,
				// #1446 item 4: the budget in force and how many eligible candidates
				// it cut off this run — the correctness half (a truncated run being
				// silently discarded) is #1443.
				// #1462: `neighborBudget` is now the DERIVED budget (still "the one in
				// force"); `neighborBudgetCeiling` is the flat cap, `budgetRemainingMs`
				// the on-time window left when it was sized, and `budgetZone` the rule
				// that decided it. Only `budgetZone: "narrowed"` shortens a walk — the
				// other three keep the flat cap, so a row where budget < ceiling is a
				// deliberate rescue, never a cold-start stub. `budgetDeliveryWindowMs`
				// records how long the pipeline (turn_end settle + quiet-window drain)
				// keeps a slow run alive, which is why the other zones can afford to
				// stay wide.
				//
				// NOTE for whoever reads these rows: `budgetTruncated` INVERTS under a
				// narrowed budget — it is `eligible - budget`, so a smaller budget
				// mechanically raises it. Compare truncation WITHIN a zone, never
				// across one.
				neighborBudget: cascadeNeighbourBudget,
				neighborBudgetCeiling: CASCADE_NEIGHBOUR_BUDGET,
				budgetRemainingMs: cascadeBudgetRemainingMs,
				budgetZone: cascadeBudgetZone,
				budgetDeliveryWindowMs: cascadeDeliveryWindowMs,
				budgetTruncated: cascadeBudgetTruncated,
				transitiveTruncated,
				budgetTrimmedCount: cascadeBudgetTruncated,
				budgetDerivationDisabled: cascadeBudgetZone === "no-rescue-window",
				budgetDerivationDisabledReason:
					cascadeBudgetZone === "no-rescue-window"
						? "no-rescue-window"
						: undefined,
				neighbors: visibleNeighbors.slice(0, 10).map((n) => ({
					file: toPosix(n.filePath).split("/").slice(-2).join("/"),
					diagnostics: n.diagnostics.length,
					rawErrors: rawErrorsByPath.get(n.filePath) ?? 0,
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
			// #1023: an indeterminate compute (degraded/cold/missing-node graph) must
			// NOT collapse into "no_neighbors" — that is the exact silent all-clear the
			// bug is about. Distinguish it by the marker threaded onto `impact`, never
			// by `visibleNeighbors.length === 0` alone (a healthy leaf is also empty).
			// #4485: the same for a run that left selected neighbours unanswered.
			// It is not a leaf and not clean; turn_end names them.
			if (impact.indeterminate || unconfirmed || primaryUnavailableToldBefore) {
				return {
					filePath,
					result: undefined,
					neighborCount: visibleNeighbors.length,
					diagnosticCount: diagCount,
					skipReason: "indeterminate",
					...(impact.indeterminate && { indeterminate: impact.indeterminate }),
					selectedNeighborPaths: sortedNeighbors.slice(),
					...(unconfirmed && { unconfirmed }),
					...(observedNeighborPaths && { observedNeighborPaths }),
				};
			}
			const skipReason: CascadeSkipReason =
				visibleNeighbors.length === 0 ? "no_neighbors" : "clean";
			return {
				filePath,
				result: undefined,
				neighborCount: visibleNeighbors.length,
				diagnosticCount: diagCount,
				skipReason,
				...(observedNeighborPaths && { observedNeighborPaths }),
			};
		}

		getDiagnosticTracker().trackShown(
			visibleNeighbors.flatMap((n) => n.diagnostics),
		);

		return {
			filePath,
			result: {
				filePath,
				impact,
				neighbors: visibleNeighbors,
				formatted,
				// #4403 round 5 (V1): turn_end drops a line whose servers were
				// delivered or already shown this turn (clients/cascade-format.ts).
				...(notes.length > 0 && {
					unansweredPrimaries: { notes, formattedWithoutNotes: format() },
				}),
				// #4487: turn_end re-renders the neighbours this result owns.
				layout,
			},
			neighborCount: visibleNeighbors.length,
			diagnosticCount: diagCount,
			// #4495 round 3: the read bound of every neighbour listed above.
			checkedAt: cascadeStart,
			...(unconfirmed && { unconfirmed }),
			...(observedNeighborPaths && { observedNeighborPaths }),
			// #1023: even when some fallback neighbors surfaced, a degraded graph means
			// the dependent set is INCOMPLETE — carry the marker so the turn-end seam
			// still notes downstream impact was under-computed this turn.
			...(impact.indeterminate && { indeterminate: impact.indeterminate }),
		};
	} finally {
		// Keep the cache entry warm, but do not let a one-shot cascade leave an
		// idle handle behind. The next consumer re-arms it through touch.
		for (const key of reverseDepsTimersToRelease) {
			const entry = reverseDepsIndexCache.get(key);
			if (entry?.idleTimer !== undefined) clearTimeout(entry.idleTimer);
			if (entry) entry.idleTimer = undefined;
		}
		for (const [key, entry] of reverseDepsIndexCache) {
			if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
			entry.idleTimer = undefined;
			if (
				!reverseDepsTimersToRelease.has(key) &&
				reverseDepsEntriesAtStart.has(entry)
			) {
				reverseDepsTimersToRelease.add(key);
			}
		}
		for (const timer of astGrepWarnDebounceTimers.values()) clearTimeout(timer);
		astGrepWarnDebounceTimers.clear();
		releaseWorkspaceTopologyIdleTimers();
	}
}

/**
 * Returns `true` when at least one otherwise-eligible candidate was withheld
 * because its content binding was rejected (#1104) — the caller folds this
 * into the run-level `fallbackBindingRejected` flag for the honesty check.
 */
function appendFallbackNeighbors(
	neighbors: CascadeResult["neighbors"],
	allDiags: Map<
		string,
		{ diags: import("../lsp/client.js").LSPDiagnostic[]; ts: number }
	>,
	normalizedFileKey: string,
	cwd: string,
	filePath: string,
	/** The run's shared display-policy seam (#3157) — see `cascadeDisplay` in
	 * `computeCascadeForFile`. */
	cascadeDisplay: (
		rawDiags: readonly import("../lsp/client.js").LSPDiagnostic[],
		neighborPath: string,
	) => CascadeResult["neighbors"][number]["diagnostics"],
	/** #4486: the compute's start; only an entry published after it is shown. */
	cascadeStart: number,
	allowedPaths?: ReadonlySet<string>,
): boolean {
	const seen = new Set(neighbors.map((n) => normalizeMapKey(n.filePath)));
	let bindingRejected = false;
	for (const [diagPath, entry] of allDiags) {
		const { diags } = entry;
		const diagKey = normalizeMapKey(diagPath);
		if (diagKey === normalizedFileKey || seen.has(diagKey)) continue;
		if (allowedPaths && !allowedPaths.has(diagKey)) continue;
		if (primaryFilesThisTurn.has(diagKey)) continue;
		if (isExternalOrVendorFile(diagPath, cwd)) continue;
		if (isIgnoredCascadeNeighbor(diagPath, cwd)) continue;
		// #1080: a KNOWN test-role file must not surface as a collateral fallback
		// neighbor either (the passive-snapshot path the graph/reference filters
		// above never reach). Ignore filtering (#297) stays separate and above.
		if (isTestRoleCollateral(diagPath)) continue;
		if (!nodeFs.existsSync(diagPath)) continue;
		// #4486: a cached entry from before the compute started describes the
		// tree before the edit. Both injected runs of the forensic window came
		// from here, under the 240 s TTL this replaced.
		if (!isPostEditObservation(entry.ts, cascadeStart)) continue;
		// #1104: a post-edit entry is not automatically trustworthy — consult
		// binding the same way the reconcile path (#1100) and the touch-error
		// fallback above do. `false` → skip (a stale/pre-fix-edit snapshot whose
		// server view diverged from current disk); "unknown"/`true` → unchanged
		// (the pre-#1104 fallback contract). Reading `.binding` triggers the lazy
		// disk verify — done ONLY when post-edit, per the established discipline.
		const boundToDisk = readBoundToCurrentDisk(entry);
		if (boundToDisk === false) {
			bindingRejected = true;
			logCascade({
				phase: "neighbor_fallback",
				filePath,
				neighborFile: diagPath,
				fallbackUsed: false,
				metadata: { bindingState: bindingStateLabel(false) },
			});
			continue;
		}
		// #692: `source: "cascade"` dropped — see the doc comment above the
		// first cascade display call site in this file.
		// #3157 site 4 of 4: the degraded fallback. `cascadeDisplay` is passed in
		// rather than re-derived so this run's aggregate drop counters see it too.
		const errors = cascadeDisplay(diags, diagPath);
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
	return bindingRejected;
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

/** The in-lane section's frame around its neighbour block. */
function cascadeSectionLayout(
	cwd: string,
	impact: ReturnType<typeof computeImpactCascade>,
	listedNeighbors: number,
	totalNeighbors: number,
	policySuppressed: number,
	policyInputTruncated: number,
): CascadeSectionLayout {
	// A10: include truncated filenames so agent knows which files were cut
	const truncated = totalNeighbors - listedNeighbors;
	let truncationLine = "";
	if (truncated > 0) {
		const truncatedNames = impact.neighborFiles
			.slice(listedNeighbors, listedNeighbors + 3)
			.map((p) => toRunnerDisplayPath(cwd, p))
			.join(", ");
		const moreLabel = truncatedNames
			? `${truncated} more dependent file(s): ${truncatedNames}`
			: `${truncated} more dependent file(s)`;
		truncationLine = `... and ${moreLabel}`;
	}
	return {
		cwd,
		noun: "neighbor",
		includeReason: true,
		header:
			formatImpactCascade(impact, RUNTIME_CONFIG.pipeline.cascadeMaxFiles) ??
			"",
		truncationLine,
		// #3157 round 3, N1: `policyInputTruncated > 0` means this run's own
		// cost bound declined to evaluate findings that exist — the #1459
		// coverage-gap case, not a verdict — so it must speak even with nothing
		// to render, with the same closing clause as the "did not cover" line
		// for a neighbour no scanner looked at (`clients/cascade-format.ts`).
		coverageLine:
			policyInputTruncated > 0
				? `⚠️ Cascade did not evaluate ${policyInputTruncated} finding(s) — the per-neighbor ` +
					`policy input is bounded at ${MAX_POLICY_INPUT_PER_FILE}; no findings does NOT mean clean here.`
				: "",
		policySuppressed,
	};
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
	projectRoot?: string,
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
		projectRoot,
	);
	sessionFacts.clearFileFactsFor(ctx.filePath);
	// #2243 item 2: release the pin when the dispatch settles, so the pin set
	// tracks in-flight dispatches rather than the last N files touched.
	try {
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
	} finally {
		sessionFacts.endDispatchFor(ctx.filePath);
	}
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
	options?: {
		blockingOnly?: boolean;
		projectRoot?: string;
		/** Ordered per-file pipeline token, when called from tool_result. */
		writeIndex?: number;
		/** #3568: the tool_result handler's session. */
		sessionGeneration?: GenerationHandle;
		/** Stable session identity for deferred runner delivery. */
		sessionId?: string;
		/** Runtime telemetry identity, when known (#1448) — see
		 * DispatchContext.telemetryModel's doc. */
		telemetryModel?: string;
		telemetryProvider?: string;
		analysisRootMode?: import("../analysis-root.js").AnalysisRootMode;
		/**
		 * Pull surface (`pilens_analyze`): emit the coverage notice on every call
		 * instead of latching it once per session (refs #3791). Leave unset for
		 * the pi push surface, which keeps the once-per-session latch.
		 */
		dedupeCoverageNotice?: boolean;
		/** #4484 round 3: `DispatchContext.owedRanges`. */
		owedRanges?: ReadonlyMap<string, readonly ModifiedRange[]>;
		/** #4509: `DispatchContext.recordedRunnerIds`. */
		recordedRunnerIds?: ReadonlySet<string>;
	},
): Promise<DispatchResult> {
	// Default true preserves the per-edit fast path (errors only). Callers that
	// want the full picture (warnings + structural smells), e.g. the MCP review
	// facade, pass blockingOnly=false to run every runner.
	const created = createDispatchContext(
		filePath,
		cwd,
		pi,
		sessionFacts,
		options?.blockingOnly ?? true,
		modifiedRanges,
		options?.projectRoot,
		options?.writeIndex,
		options?.telemetryModel,
		options?.telemetryProvider,
		options?.sessionGeneration,
		options?.sessionId,
		options?.analysisRootMode,
	);
	const ctx: DispatchContext =
		options?.owedRanges?.size || options?.recordedRunnerIds?.size
			? {
					...created,
					...(options.owedRanges?.size && { owedRanges: options.owedRanges }),
					...(options.recordedRunnerIds?.size && {
						recordedRunnerIds: options.recordedRunnerIds,
					}),
				}
			: created;
	sessionFacts.clearFileFactsFor(ctx.filePath);
	// #2243 item 2: release the pin when the dispatch settles.
	try {
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
		const result = await dispatchForFile(
			ctx,
			groups,
			sessionRunnerRegistry,
			undefined,
			// exactOptionalPropertyTypes: omit the key rather than pass
			// `undefined`, which the target option type rejects (#3791).
			{
				...(options?.dedupeCoverageNotice !== undefined && {
					dedupeCoverageNotice: options.dedupeCoverageNotice,
				}),
			},
		);
		trackSessionSlopStats(ctx, result.diagnostics);

		// Schedule debounced ast-grep warning scan for jsts files.
		// Runs 2s after the last write — collapses rapid sequential edits into one scan.
		// Results are logged only, never surfaced to the agent.
		if (kind === "jsts" && logContext) {
			scheduleAstGrepWarningScan(filePath, cwd, pi, logContext);
		}

		return result;
	} finally {
		sessionFacts.endDispatchFor(ctx.filePath);
	}
}

/** #4483: why a pre-edit capture did not seed the file. */
export type PreEditCaptureSkip =
	| "no-delta"
	| "outside-session-root"
	| "already-dispatched"
	/** A capture of the file is still running (one the bound abandoned). */
	| "in-flight"
	| "capacity"
	| "no-kind"
	| "generated"
	| "no-linter"
	| "unreadable";

/** #4483: what one pre-edit capture did, for the `tool_call` record. */
export type PreEditCaptureOutcome =
	| {
			outcome: "seeded";
			/** Blocking linter findings installed as the seed. */
			seeded: number;
			/** Linter runners the capture ran. */
			runners: string[];
	  }
	| { outcome: "skipped"; reason: PreEditCaptureSkip }
	| {
			/** The runs finished but their findings no longer describe the file
			 *  as it is before its first dispatch, so nothing was installed. */
			outcome: "discarded";
			reason:
				| "bytes-changed"
				| "already-dispatched"
				| "session-replaced"
				| "aborted";
	  };

/**
 * #4483: run the file's inline linters over the bytes still on disk before
 * its first edit this session, and install their blocking findings as the
 * file's pre-edit seed (clients/dispatch/pre-edit-seed.ts).
 *
 * Called from the `tool_call` of a classified write or edit, under the
 * caller's bound, before the host writes. Only linter runners run (no
 * language server, type checker, gated runner or scanner), and not one the
 * observed tier has moved to collect-later. The seed is installed only while
 * it still describes the file before its first dispatch: no delta baseline
 * or seed exists yet, the file still holds the bytes the runs read, and the
 * session is the one that started the capture. A capture the caller stopped
 * waiting for therefore installs nothing once the host has written.
 */
export async function capturePreEditLinterFindings(
	filePath: string,
	workspaceRoot: string,
	pi: PiAgentAPI,
	session: { isCurrent(): boolean },
	signal?: AbortSignal,
): Promise<PreEditCaptureOutcome> {
	if (pi.getFlag("no-delta")) return { outcome: "skipped", reason: "no-delta" };
	const analysisRootMode = resolveAnalysisRoot(filePath, workspaceRoot);
	if (analysisRootMode === "none" || analysisRootMode === "adopted")
		return { outcome: "skipped", reason: "outside-session-root" };
	const projectRoot = nodePath.resolve(workspaceRoot);
	const dispatchCwd = resolveLanguageRootForFile(filePath, workspaceRoot);
	// The dispatch's own key path (`createDispatchContext`'s), so a later write
	// pays two map lookups here and nothing else.
	const keyPath = normalizeMapKey(resolveRunnerPath(dispatchCwd, filePath));
	const baselineKey = deltaBaselineFactKey(keyPath);
	const seedKey = preEditSeedFactKey(keyPath);
	const dispatched = () =>
		sessionFacts.hasBoundedSessionFact(baselineKey) ||
		sessionFacts.wasBoundedSessionFactEvicted(baselineKey) ||
		sessionFacts.hasBoundedSessionFact(seedKey);
	if (dispatched()) return { outcome: "skipped", reason: "already-dispatched" };
	if (preEditCapturesInFlight.has(keyPath))
		return { outcome: "skipped", reason: "in-flight" };
	if (preEditCapturesInFlight.size >= MAX_PRE_EDIT_CAPTURES) {
		recordDegradationOnce({
			kind: "pre-edit-capture-incomplete",
			subject: "pre-edit",
			reason: "capacity",
		});
		return { outcome: "skipped", reason: "capacity" };
	}
	const created = createDispatchContext(
		filePath,
		dispatchCwd,
		pi,
		preEditCaptureFacts,
		true,
		undefined,
		projectRoot,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		analysisRootMode,
	);
	const ctx: DispatchContext = {
		...created,
		deltaMode: false,
		preEditCapture: true,
		hasTool: (command) => checkToolAvailability(command, sessionFacts),
	};
	const kind = ctx.kind;
	if (!kind) return { outcome: "skipped", reason: "no-kind" };
	if (ctx.fileRole === "generated")
		return { outcome: "skipped", reason: "generated" };
	const groups = withSpotbugsGroup(
		kind,
		getDispatchGroupsForKind(kind, pi),
		ctx,
	).flatMap((group) => {
		const runnerIds = group.runnerIds.filter(
			(id) =>
				PRE_EDIT_SEED_RUNNER_IDS.has(id) &&
				classifyObservedRunner(projectRoot, id) === "inline",
		);
		return runnerIds.length > 0 ? [{ ...group, runnerIds }] : [];
	});
	if (groups.length === 0) return { outcome: "skipped", reason: "no-linter" };
	let before: Buffer;
	try {
		before = nodeFs.readFileSync(ctx.filePath);
	} catch {
		return { outcome: "skipped", reason: "unreadable" };
	}
	const content = before.toString("utf8");
	const controller = new AbortController();
	const captureSignal = signal
		? AbortSignal.any([signal, controller.signal])
		: controller.signal;
	preEditCapturesInFlight.set(keyPath, controller);
	preEditCaptureFacts.clearFileFactsFor(ctx.filePath);
	preEditCaptureFacts.setFileFact(ctx.filePath, "file.content", content);
	try {
		const result = await spawnAbortScope.run(captureSignal, () =>
			dispatchForFile(ctx, groups, sessionRunnerRegistry, undefined, {
				dedupeCoverageNotice: false,
			}),
		);
		if (captureSignal.aborted)
			return { outcome: "discarded", reason: "aborted" };
		if (!session.isCurrent())
			return { outcome: "discarded", reason: "session-replaced" };
		if (dispatched())
			return { outcome: "discarded", reason: "already-dispatched" };
		let now: Buffer | undefined;
		try {
			now = nodeFs.readFileSync(ctx.filePath);
		} catch {
			now = undefined;
		}
		if (!now?.equals(before))
			return { outcome: "discarded", reason: "bytes-changed" };
		const seed = seedFromCapture(result.blockers, content);
		sessionFacts.setBoundedSessionFact(seedKey, seed);
		return {
			outcome: "seeded",
			seeded: seed.length,
			runners: groups.flatMap((g) => g.runnerIds),
		};
	} finally {
		preEditCapturesInFlight.delete(keyPath);
		preEditCaptureFacts.endDispatchFor(ctx.filePath);
	}
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
	options?: {
		blockingOnly?: boolean;
		modifiedRanges?: ModifiedRange[];
		projectRoot?: string;
	},
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
		options?.projectRoot,
	);
	sessionFacts.clearFileFactsFor(ctx.filePath);
	// #2243 item 2: release the pin when the dispatch settles.
	try {
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
	} finally {
		sessionFacts.endDispatchFor(ctx.filePath);
	}
}

/**
 * Get list of available runners for a file
 */
export async function getAvailableRunners(filePath: string): Promise<string[]> {
	const kind = detectFileKind(filePath);
	if (!kind) return [];

	const normalizedPath = toPosix(filePath);
	const pathForFilter = normalizedPath.startsWith("/")
		? normalizedPath
		: `/${normalizedPath}`;
	const runners = sessionRunnerRegistry.getForKind(kind, pathForFilter);
	return runners.map((r) => r.id);
}
