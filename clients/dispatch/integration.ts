/**
 * Dispatch integration helpers
 *
 * Provides utilities for integrating the declarative dispatch system
 * with the existing index.ts tool_result handler.
 */

import { CASCADE_DIAGNOSTICS_TTL_MS } from "../cascade-types.js";
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
import { recordDegradationOnce } from "../degradation-ledger.js";
import { FactStore, setFactStoreEvictionReporter } from "./fact-store.js";
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
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import {
	CASCADE_NEIGHBOUR_BUDGET,
	type CascadeBudgetZone,
	deriveCascadeNeighbourBudget,
} from "../cascade-budget.js";
import { formatCascadeNeighborDiagnostics } from "../cascade-format.js";
import { logCascade } from "../cascade-logger.js";
import type {
	CascadeResult,
	CascadeRun,
	CascadeSkipReason,
} from "../cascade-types.js";
import { getDiagnosticTracker } from "../diagnostic-tracker.js";
import {
	classifyCascadeWaitTier,
	isTierAwareCascadeEnabled,
	recordOutstandingCascadeTouch,
} from "../lsp/cascade-tier.js";
import {
	type BoundToCurrentDisk,
	type TouchFileResult,
	bindingStateLabel,
	touchCoverageGap,
} from "../lsp/diagnostic-binding.js";
import { getServersForFileWithConfig } from "../lsp/config.js";
import { getLSPService } from "../lsp/index.js";
import { isExternalOrVendorFile, normalizeMapKey } from "../path-utils.js";
import { getProjectIgnoreMatcher } from "../file-utils.js";
import {
	resetAstGrepNapiLoadState,
	resetAstGrepUnsupportedLanguageLog,
} from "./runners/ast-grep-napi.js";
import { resetTreeSitterClientLoadState } from "../tree-sitter-shared.js";
import { isTestRoleCollateral } from "../collateral-test-role.js";
import {
	clearReviewGraphWorkspaceCache,
	getGraphBuildInfoForGraph,
	getGraphImportChanges,
	graphBuildInfoIsTrustworthy,
} from "../review-graph/builder.js";
import {
	buildReverseDependencyIndexFromGraph,
	getAffectedFilesFromIndex,
	patchReverseDependencyIndex,
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
// F1) — five other production FactStore instances exist (mcp/analyze.ts,
// lens-map.ts, project-diagnostics/scanner.ts, runtime-session.ts's
// session-start call-graph task, mcp/cli.ts); a shared constant subject let
// runtime-session's session-start review-graph walk consume the once-per-
// session ledger slot before any dispatch ran, misattributing the record.
const sessionFacts = new FactStore("dispatch");
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
			runnerIds: ["ast-grep"],
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
	resetSessionSlopScore();
	clearCoverageNoticeState();
	clearReviewGraphWorkspaceCache();
	clearReverseDepsIndexCache();
	clearModuleGraphCache();
	recentlyCleanNeighborCache.clear();
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
// closed. The two caches that remain already cover the safe reuse: the
// passive-snapshot path (TTL plus content binding) and
// `recentlyCleanNeighborCache` (clean answers only, with a fresh-passive-error
// override).

// Cross-turn clean cache: neighbor touches that recently returned no errors can
// be skipped for a few turns. LSP servers push diagnostics proactively when a
// file becomes unhealthy, so repeatedly re-opening known-clean neighbors is low value.
type RecentlyCleanNeighborEntry = { turnSeq: number; checkedAt: number };
const recentlyCleanNeighborCache = new Map<
	string,
	RecentlyCleanNeighborEntry
>();

/** O(1) entry count of this module's turn-bounded cache (#1123 item 2
 *  memory attribution) — a `Map.size` read, never iterated.
 *  `sessionFactEntries` (#2282) is the dispatch `FactStore`'s own
 *  `sessionFacts` footprint: the fixed-vocabulary map (small, unbounded by
 *  design) plus the bounded per-file map (capped at `MAX_SESSION_FACT_RECORDS`
 *  — see `fact-store.ts`), so this number is now itself bounded rather than
 *  invisible growth. */
export function getDispatchCascadeCacheStats(): {
	recentlyCleanNeighborCacheSize: number;
	sessionFactEntries: number;
} {
	return {
		recentlyCleanNeighborCacheSize: recentlyCleanNeighborCache.size,
		sessionFactEntries: sessionFacts.getSessionFactEntryCount(),
	};
}
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
	for (const [key, entry] of recentlyCleanNeighborCache) {
		if (turnSeq - entry.turnSeq > RECENTLY_CLEAN_TTL_TURNS) {
			recentlyCleanNeighborCache.delete(key);
		}
	}
}

const MAX_PER_FILE = RUNTIME_CONFIG.pipeline.cascadeMaxDiagnosticsPerFile;
const MAX_FILES = RUNTIME_CONFIG.pipeline.cascadeMaxFiles;

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
 * The DISPLAY list (`diags` at each call site) is deliberately left as-is —
 * that is pre-existing cascade output behavior, out of scope for #1093.
 */
function cascadeReconcilableLspErrors(
	rawDiags: readonly import("../lsp/client.js").LSPDiagnostic[],
	neighborPath: string,
): ReturnType<typeof convertLspDiagnostics> {
	return convertLspDiagnostics(
		rawDiags
			.filter(
				(d) => d.severity === 1 && !findAuxiliaryProfileForSource(d.source),
			)
			.slice(0, MAX_PER_FILE),
		neighborPath,
	);
}

/**
 * Read the content `binding` verdict off a diagnostics result (#1095).
 *
 * `touchFile` carries `binding` as an EXPLICIT enumerable field on its
 * `TouchFileResult` wrapper (#1179), so it survives any copy of `.diags`.
 * `getAllDiagnostics` still attaches `binding` as a lazy, disk-verifying
 * NON-enumerable getter on each Map entry — reading it directly off the
 * producer's own entry (never a spread/clone, which drops non-enumerables)
 * triggers the disk verify exactly once (memoized per entry). Accepts either
 * shape; returns `undefined` when no binding was attached at all (a partially-
 * mocked client, a non-collecting touch) — indistinguishable from "unknown" at
 * every call site, which is the intended pre-#1095 fall-through.
 */
function readBoundToCurrentDisk(
	rawDiags: unknown,
): BoundToCurrentDisk | undefined {
	return (rawDiags as { binding?: { boundToCurrentDisk?: BoundToCurrentDisk } })
		?.binding?.boundToCurrentDisk;
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
	onUpdated?: (index: WordIndex) => void;
	dbg?: (msg: string) => void;
}): Promise<void> {
	const { wordIndex, filePath, content, onUpdated, dbg } = args;
	if (!wordIndex || !wordIndex.forward) return;
	if (content === undefined) return;

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

export async function computeCascadeForFile(
	filePath: string,
	cwd: string,
	options: {
		hasBlockers?: boolean;
		dbg?: (msg: string) => void;
		/** Turn/write sequence from RuntimeCoordinator — scopes cascade caches (A5/B10) */
		turnSeq?: number;
		writeSeq?: number;
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
			writeSeq,
			seqState,
			turnEndCascadeSettleStart,
			fileContent,
			wordIndex,
			onWordIndexUpdated,
		} = options;

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
			if (cascadeBudgetTruncated > 0 || transitiveTruncated) {
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
		// appendFallbackNeighbors) withhold a TTL-fresh entry solely because its
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
		// #1446 item 5: `recentlyCleanNeighborCache` hits are the whole point of the
		// cache, but they were never counted — the only visible signal was 267s/day
		// of touch wall time with no way to tell whether the cache was absorbing
		// repeat work or every touch was cold. (#1899 removed the sibling
		// `cacheHits` counter along with the dead `neighborTouchCache`.)
		let recentlyCleanHits = 0;
		// F1 (#1446 follow-up): `coldTouches` must be counted at the point each
		// neighbour's OUTCOME is actually known, not derived from `coldSnapshotPaths`
		// (finalized earlier, before the cache-hit checks below run against it). Using
		// the pre-outcome list let a neighbour double-count (cold-snapshot AND cache/
		// recently-clean hit) or vanish from every bucket (an `activePaths` neighbour —
		// e.g. Python/Go — that misses both caches). These counters partition the
		// selected-neighbour outcomes; passive snapshots and no-server selections are
		// tracked separately instead of silently disappearing from the denominator.
		// `coldTouches` includes every genuine active touch attempt, while
		// `touchFailures` is its separate bounded failure subtype.
		let deferredTouches = 0;
		let coldTouches = 0;
		let passiveSnapshotHits = 0;
		let noLspConfigured = 0;
		let touchFailures = 0;

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
				const ttlFresh =
					entry != null && Date.now() - entry.ts < CASCADE_DIAGNOSTICS_TTL_MS;
				// #1095: content binding is the INNER gate; TTL stays the outer bound.
				//   false     → the server's diagnostics were computed against a DIFFERENT
				//               disk state (e.g. the PRE-fix content) — don't trust or
				//               reconcile this snapshot; fall through to an active touch on
				//               the same (cold-snapshot) budget as a TTL-stale entry. This
				//               kills the window where the first cascade after a fix-edit
				//               replays the neighbor's pre-fix snapshot.
				//   "unknown" → version-less/unreadable: keep EXACTLY the pre-#1095 TTL-only
				//               behavior (reconcile if TTL-fresh).
				//   true      → bound to current disk: reconcile (TTL still the outer bound).
				// Reading `.binding` triggers the lazy disk verify on the getAllDiagnostics
				// result — done ONLY when TTL-fresh so a doomed (stale) entry never pays the
				// stat+hash.
				const boundToDisk: BoundToCurrentDisk | undefined = ttlFresh
					? readBoundToCurrentDisk(entry)
					: undefined;
				const bindingRejected = boundToDisk === false;
				const snapshotValid = ttlFresh && !bindingRejected;

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
						// #1095: distinguish a binding-rejected fall-through (TTL-fresh but the
						// server's view diverged from disk) from a plain TTL-stale/missing one.
						...(bindingRejected && {
							metadata: { bindingState: bindingStateLabel(boundToDisk) },
						}),
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
				const diags = convertLspDiagnostics(
					entry.diags.filter((d) => d.severity === 1).slice(0, MAX_PER_FILE),
					neighborPath,
				);
				producedLspData = true;
				passiveSnapshotHits++;
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
				// time, up to CASCADE_DIAGNOSTICS_TTL_MS old) — NOT now() — so replaying an aging
				// snapshot never re-arms the mtime-staleness gate (the same #1092
				// re-arming defect this PR fixes for cache hits).
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
					writeSeq,
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

					const passiveEntry = allDiags.get(cacheKey);
					const hasFreshPassiveErrors =
						passiveEntry != null &&
						Date.now() - passiveEntry.ts < CASCADE_DIAGNOSTICS_TTL_MS &&
						passiveEntry.diags.some((d) => d.severity === 1);
					const recentlyClean = recentlyCleanNeighborCache.get(cacheKey);
					if (
						recentlyClean &&
						turnSeq - recentlyClean.turnSeq <= RECENTLY_CLEAN_TTL_TURNS &&
						!hasFreshPassiveErrors
					) {
						producedLspData = true;
						recentlyCleanHits++;
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
					const content = await nodeFs.promises.readFile(neighborPath, "utf8");

					// #458/#1444: tier-aware cascade-lane wait. A Tier-3 silent server
					// cannot give this wait an affirmative clean signal. Native TS7 does
					// publish, but not inside the cold-snapshot budget. In both cases the
					// in-lane budget is pure cost. Fire the touch (didOpen/
					// didChange still happens — the server starts real work) and record
					// it as outstanding for the agent_settled quiet window to reconcile
					// instead of waiting here. Ambiguous/missing capability data always
					// classifies as "waits" (today's behavior) — see cascade-tier.ts.
					// The whole attempt is try/caught: any surprise (a service shape
					// that doesn't expose getCapabilitySnapshots/getClientForFile, a
					// thrown rejection) falls through to the existing full-wait path
					// below rather than skip the wait on a failure.
					if (isTierAwareCascadeEnabled()) {
						try {
							const snapshots =
								(await lspService.getCapabilitySnapshots?.(neighborPath)) ?? [];
							const tier = classifyCascadeWaitTier(
								lspService,
								neighborPath,
								snapshots,
							);
							if (
								tier === "tier3-silent" ||
								tier === "collect-later" ||
								tier === "diagnostics-unsupported"
							) {
								const spawnedForTouch =
									await lspService.getClientForFile(neighborPath);
								if (spawnedForTouch) {
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
									recordOutstandingCascadeTouch({
										filePath: neighborPath,
										serverId: spawnedForTouch.client.serverId,
										touchedAt,
									});
									const durationMs = Date.now() - neighborStart;
									if (tier === "collect-later") collectLaterSkipped++;
									// F1: both tier3-silent and collect-later skip the in-lane
									// wait and record an outstanding touch for the quiet-window
									// reconcile — neither a cache hit nor a genuine completed
									// cold touch, so both share this explicit "deferred" bucket
									// instead of falling out of the partition uncounted.
									deferredTouches++;
									logCascade({
										phase: "cascade_tier3_skip",
										filePath,
										neighborFile: neighborPath,
										durationMs,
										lspServerCount: configuredServerCount,
										coldSnapshot: isColdSnapshot,
										metadata: {
											serverId: spawnedForTouch.client.serverId,
											waitTier: tier,
										},
									});
									// Deliberately NOT cached as clean/diagnosed — the wait was
									// skipped, not resolved, so recentlyCleanNeighborCache must
									// not treat this as a real answer
									// (#240 doctrine). Return undefined: the degraded-fallback
									// path below still has a chance to surface a passive/stale
									// snapshot, same as any other "no fresh data this touch" case.
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
					// F1: this is the ONE remaining outcome after cache hit, recently-clean
					// hit, and tier-aware deferral have all been ruled out — a genuine
					// active LSP touch is being issued right now. Count it here (an
					// attempt, whether it resolves, times out, or the promise rejects
					// below in the allSettled catch) rather than from `coldSnapshotPaths`,
					// which is finalized before any of the above checks run and includes
					// neighbours that resolve via cache/recently-clean instead.
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
					});
					if (!rawDiags) return undefined;
					// #1093/#571/#1095: a touch result is only a CONFIRMED observation of the
					// neighbor's current on-disk state when it is neither `inconclusive` (the
					// notify/diagnostics wait lapsed — e.g. the tight 1000ms cold-snapshot
					// budget on a slow server) NOR bound-false (`binding.boundToCurrentDisk
					// === false` — the diagnostics were computed against a different disk state
					// than what's on disk now). Either disqualifier means a resolved `[]` is
					// NOT a confirmed clean: treating it as one would WIPE a live footer finding
					// (the #533 false-clean trap, worse than the stale-display bug). Both flags
					// are folded into `isConfirmedTouch` so no gate below can miss one. A
					// confirmed result reconciles and may seed the recently-clean cache; an
					// unconfirmed one does neither (else the short-circuit on the next cascade
					// would make the wipe self-sustain).
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
					// #1179: `.filter()` here operates on `rawDiags.diags`; the
					// `inconclusive`/`binding` flags read above stay on the `rawDiags`
					// wrapper and are unaffected by this copy (the shape-5 fix).
					const diags = convertLspDiagnostics(
						rawDiags.diags
							.filter((d) => d.severity === 1)
							.slice(0, MAX_PER_FILE),
						neighborPath,
					);
					const durationMs = Date.now() - neighborStart;

					// #1899: the A5 same-write cache write stood here.
					if (diags.length === 0) {
						// Only a CONFIRMED clean touch may seed the recently-clean cache
						// (#1095: a bound-false touch is unconfirmed, exactly like inconclusive).
						if (confirmed) {
							recentlyCleanNeighborCache.set(cacheKey, {
								turnSeq,
								checkedAt: Date.now(),
							});
						}
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
					// WriteOrderingGuard. `observedAt` stays now (a fresh touch). The
					// inconclusive touch, the BOUND-FALSE touch (#1095 — computed against a
					// diverged disk state), the tier-3-silent skip, the recently-clean
					// short-circuit, the within-turn cache hit, and the rejected-touch
					// fallback are all deliberately NOT reconciled — none is a confirmed
					// observation.
					if (confirmed) {
						reconcileCascadeNeighborLspErrors(
							neighborPath,
							cascadeReconcilableLspErrors(rawDiags.diags, neighborPath),
							writeSeq,
						);
					}

					return {
						filePath: neighborPath,
						reason: neighborReason(importerSet, callerSet, neighborPath),
						diagnostics: diags,
						lspTouched: true as const,
						...(inconclusive && { inconclusive: true as const }),
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
					const ttlFresh =
						entry != null && Date.now() - entry.ts < CASCADE_DIAGNOSTICS_TTL_MS;
					// #1104: consult binding before trusting a TTL-fresh fallback snapshot —
					// MATCH #1100/#1095 semantics (false → skip, "unknown" → keep the
					// pre-#1104 TTL-only behavior, true → use). Without this, a failed
					// active touch could still re-display a bound-false (pre-fix-edit)
					// snapshot even though the reconcile path (#1100) already refuses to
					// trust it for the widget — the widget is protected but the display
					// wasn't. Reading `.binding` triggers the lazy disk verify — done ONLY
					// when TTL-fresh, same discipline as the snapshot-tier gate above.
					const boundToDisk: BoundToCurrentDisk | undefined = ttlFresh
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
						// #1104: distinguish a binding-rejected fallback (TTL-fresh but the
						// server's view diverged from disk) from a plain TTL-stale/missing
						// one — same conditional pattern as the neighbor_touch/neighbor_snapshot
						// phases above.
						...(bindingRejected && {
							metadata: { bindingState: bindingStateLabel(boundToDisk) },
						}),
					});
					// #692: `source: "cascade"` dropped (see the doc comment above the
					// first cascade call site in this file) — no longer affects `rule`
					// and cascade output never touches persisted widget/dedup state.
					const diags =
						ttlFresh && !bindingRejected
							? convertLspDiagnostics(
									entry.diags
										.filter((d) => d.severity === 1)
										.slice(0, MAX_PER_FILE),
									neighborPath,
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

		const visibleNeighbors = applyCascadeDeltaBaselines(neighbors);

		const formatted = formatCascadeResult(
			cwd,
			impact,
			visibleNeighbors,
			impact.neighborFiles.length,
		);

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
			passiveSnapshotHits +
			recentlyCleanHits +
			deferredTouches +
			coldTouches +
			noLspConfigured;
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
				// #1446 item 5: cache effectiveness as a number instead of an inference
				// from `coldSnapshot`/`snapshotMissing` flags scattered across
				// per-neighbor `neighbor_touch`/`neighbor_snapshot` rows.
				// F1: recentlyCleanHits + deferredTouches + coldTouches
				// retain their outcome semantics. Passive snapshots and no-server selections
				// complete the selected-neighbor denominator; touchFailures is a bounded
				// subtype of coldTouches, not an additional outcome.
				recentlyCleanHits,
				deferredTouches,
				coldTouches,
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
			// #1023: an indeterminate compute (degraded/cold/missing-node graph) must
			// NOT collapse into "no_neighbors" — that is the exact silent all-clear the
			// bug is about. Distinguish it by the marker threaded onto `impact`, never
			// by `visibleNeighbors.length === 0` alone (a healthy leaf is also empty).
			if (impact.indeterminate) {
				return {
					filePath,
					result: undefined,
					neighborCount: visibleNeighbors.length,
					diagnosticCount: diagCount,
					skipReason: "indeterminate",
					indeterminate: impact.indeterminate,
					selectedNeighborPaths: sortedNeighbors.slice(),
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
			sessionFacts.getBoundedSessionFact<import("./types.js").Diagnostic[]>(
				baselineKey,
			);
		sessionFacts.setBoundedSessionFact(baselineKey, [...neighbor.diagnostics]);
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
	allowedPaths?: ReadonlySet<string>,
): boolean {
	const now = Date.now();
	const seen = new Set(neighbors.map((n) => normalizeMapKey(n.filePath)));
	let bindingRejected = false;
	for (const [diagPath, entry] of allDiags) {
		const { diags, ts } = entry;
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
		if (now - ts > CASCADE_DIAGNOSTICS_TTL_MS) continue;
		// #1104: a TTL-fresh entry is not automatically trustworthy — consult
		// binding the same way the reconcile path (#1100) and the touch-error
		// fallback above do. `false` → skip (a stale/pre-fix-edit snapshot whose
		// server view diverged from current disk); "unknown"/`true` → unchanged
		// (the pre-#1104 fallback contract). Reading `.binding` triggers the lazy
		// disk verify — done ONLY when TTL-fresh, per the established discipline.
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
		// first cascade `convertLspDiagnostics` call site in this file.
		const errors = convertLspDiagnostics(
			diags.filter((d) => d.severity === 1).slice(0, MAX_PER_FILE),
			diagPath,
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
		/** Runtime telemetry identity, when known (#1448) — see
		 * DispatchContext.telemetryModel's doc. */
		telemetryModel?: string;
		telemetryProvider?: string;
	},
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
		options?.projectRoot,
		options?.writeIndex,
		options?.telemetryModel,
		options?.telemetryProvider,
	);
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
		const result = await dispatchForFile(ctx, groups, sessionRunnerRegistry);
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
