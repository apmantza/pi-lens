/**
 * Dispatch integration helpers
 *
 * Provides utilities for integrating the declarative dispatch system
 * with the existing index.ts tool_result handler.
 */

import { detectFileKind } from "../file-kinds.js";
import type { FileKind } from "../file-kinds.js";
import { getDiagnosticLogger, type LogContext } from "../diagnostic-logger.js";
import {
	getLspCapableKinds,
	getPrimaryDispatchGroup,
} from "../language-policy.js";
import {
	formatSlopScoreSummary,
	type SlopScoreSummary,
} from "../session-summary.js";
import { FactStore } from "./fact-store.js";
import {
	clearLatencyReports,
	clearCoverageNoticeState,
	createDispatchContext,
	RunnerRegistry,
	type DispatchLatencyReport,
	dispatchForFile,
	formatLatencyReport,
	getLatencyReports,
	type RunnerLatency,
} from "./dispatcher.js";
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

import { registerDefaultRunners } from "./runners/index.js";
import {
	buildOrUpdateGraph,
	computeImpactCascade,
	formatImpactCascade,
} from "../review-graph/service.js";
import { resolveRunnerPath } from "./runner-context.js";

// Register fact providers
import { registerProvider } from "./fact-runner.js";
import { runProviders } from "./fact-runner.js";
import { fileContentProvider } from "./facts/file-content.js";
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
import { errorObscuringRule } from "./rules/error-obscuring.js";
import { errorSwallowingRule } from "./rules/error-swallowing.js";
import { asyncNoiseRule } from "./rules/async-noise.js";
import { passThroughWrappersRule } from "./rules/pass-through-wrappers.js";
import { placeholderCommentsRule } from "./rules/placeholder-comments.js";
import { highComplexityRule } from "./rules/high-complexity.js";
import { unsafeBoundaryRule } from "./rules/unsafe-boundary.js";
import { asyncUnnecessaryWrapperRule } from "./rules/async-unnecessary-wrapper.js";
import { missingErrorPropagationRule } from "./rules/missing-error-propagation.js";
import { highFanOutRule } from "./rules/high-fan-out.js";
import {
	commentedOutCodeRule,
	duplicateStringLiteralRule,
	functionInLoopRule,
	jwtWithoutVerifyRule,
	corsWildcardRule,
	dynamicRegexpRule,
	maxSwitchCasesRule,
	commentedCredentialsRule,
} from "./rules/sonar-rules.js";
import {
	noMagicNumbersRule,
	noBooleanParamsRule,
	highImportCouplingRule,
	noComplexConditionalsRule,
	highEntropyStringRule,
} from "./rules/quality-rules.js";
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
registerRule(noMagicNumbersRule);
registerRule(noBooleanParamsRule);
registerRule(highImportCouplingRule);
registerRule(noComplexConditionalsRule);
registerRule(highEntropyStringRule);

const sessionFacts = new FactStore();
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
	"no-magic-numbers",
	"no-boolean-params",
	"high-import-coupling",
	"no-complex-conditionals",
	"high-entropy-string",
]);
const sessionSlopRuleCounts = new Map<string, number>();
let sessionSlopDiagnosticCount = 0;
let sessionWrittenLineCount = 0;

// Debounced ast-grep warning scan — fires 2s after the last write to a jsts file.
// Runs warning-tier rules that are too expensive to include in the blocking write path,
// logs all diagnostics for history without surfacing anything to the agent.
const astGrepWarnDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
	const lineCount = ctx.facts.getFileFact<number>(ctx.filePath, "file.lineCount");
	if (typeof lineCount === "number" && Number.isFinite(lineCount) && lineCount > 0) {
		sessionWrittenLineCount += lineCount;
	}

	for (const diagnostic of diagnostics) {
		const ruleId = detectFactRuleId(diagnostic);
		if (!ruleId) continue;
		sessionSlopDiagnosticCount += 1;
		sessionSlopRuleCounts.set(ruleId, (sessionSlopRuleCounts.get(ruleId) ?? 0) + 1);
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
	const lspEnabled = !!pi.getFlag("lens-lsp") && !pi.getFlag("no-lsp");
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
		return group.runnerIds.every((id, index) => primary.runnerIds[index] === id);
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
		const lspEnabled = !!pi.getFlag("lens-lsp") && !pi.getFlag("no-lsp");
		const policyGroup = getPrimaryDispatchGroup(kind as FileKind, lspEnabled);
		if (policyGroup) return [policyGroup];
		if (lspEnabled && LSP_CAPABLE_KINDS.has(kind as FileKind)) {
			return [{ mode: "all", runnerIds: ["lsp"], filterKinds: [kind as FileKind] }];
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
}

export async function computeImpactCascadeForFile(
	filePath: string,
	cwd: string,
): Promise<string | undefined> {
	const normalizedFile = resolveRunnerPath(cwd, filePath);
	const graph = await buildOrUpdateGraph(cwd, [normalizedFile], sessionFacts);
	const impact = computeImpactCascade(graph, normalizedFile);
	return formatImpactCascade(impact);
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
