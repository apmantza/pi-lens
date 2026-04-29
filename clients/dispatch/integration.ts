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

import { clearGraphCache } from "../review-graph/builder.js";
import {
	buildOrUpdateGraph,
	computeImpactCascade,
	formatImpactCascade,
} from "../review-graph/service.js";
import type { CascadeResult } from "../cascade-types.js";
import { logCascade } from "../cascade-logger.js";
import { getLSPService } from "../lsp/index.js";
import { isFileKind } from "../file-kinds.js";
import * as nodeFs from "node:fs";
// Register fact providers
import { registerProvider, runProviders } from "./fact-runner.js";
import { fileContentProvider } from "./facts/file-content.js";
import { resolveRunnerPath, toRunnerDisplayPath } from "./runner-context.js";
import { registerDefaultRunners } from "./runners/index.js";

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
	clearGraphCache();
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
 * Unified cascade orchestration — builds graph, discovers neighbors, and
 * gathers per-file diagnostics with structured logging to cascade.log.
 *
 * autoPropagate (jsts): tsserver pushes diagnostics automatically, so we
 * read from the passive snapshot instead of touching neighbors actively.
 */
export async function computeCascadeForFile(
	filePath: string,
	cwd: string,
	options: {
		hasBlockers?: boolean;
		isNewFile?: boolean;
		dbg?: (msg: string) => void;
	} = {},
): Promise<CascadeResult | undefined> {
	const { hasBlockers = false, isNewFile = false, dbg } = options;

	if (hasBlockers || isNewFile) {
		logCascade({
			phase: "cascade_skip",
			filePath,
			reason: hasBlockers ? "primary_has_blockers" : "new_file",
		});
		return undefined;
	}

	const normalizedFile = resolveRunnerPath(cwd, filePath);
	const graphStart = Date.now();
	const graph = await buildOrUpdateGraph(cwd, [normalizedFile], sessionFacts);
	const graphMs = Date.now() - graphStart;

	logCascade({
		phase: "graph_build",
		filePath,
		graphBuiltMs: graphMs,
	});

	const impact = computeImpactCascade(graph, normalizedFile);
	const neighborFiles = impact.neighborFiles.filter(
		(n) => nodeFs.existsSync(n),
	);

	logCascade({
		phase: "neighbors_computed",
		filePath,
		neighborCount: neighborFiles.length,
		metadata: { neighbors: neighborFiles.slice(0, 10) },
	});

	const lspService = getLSPService();
	const CASCADE_TTL_MS = 240_000;
	const MAX_PER_FILE = 20;

	const neighbors: CascadeResult["neighbors"] = [];

	for (const neighborPath of neighborFiles) {
		const neighborStart = Date.now();
		const autoPropagate = isFileKind(neighborPath, "jsts");

		if (autoPropagate) {
			// tsserver tracks all files — read from passive snapshot
			const allDiags = await lspService.getAllDiagnostics();
			const entry = allDiags.get(neighborPath);
			const diags = entry && Date.now() - entry.ts < CASCADE_TTL_MS
				? entry.diags.filter((d) => d.severity === 1).slice(0, MAX_PER_FILE)
				: [];
			const durationMs = Date.now() - neighborStart;

			logCascade({
				phase: "neighbor_snapshot",
				filePath,
				neighborFile: neighborPath,
				diagnosticCount: diags.length,
				durationMs,
				autoPropagate: true,
			});

			neighbors.push({
				filePath: neighborPath,
				reason: determineNeighborReason(impact, neighborPath),
				diagnostics: diags,
				lspTouched: false,
				durationMs,
			});
		} else {
			// Actively touch with silent=true to avoid triggering N project-wide rechecks
			try {
				const content = nodeFs.readFileSync(neighborPath, "utf8");
				await lspService.touchFile(neighborPath, content, {
					diagnostics: "full",
					silent: true,
					source: "cascade",
				});
				const rawDiags = await lspService.getDiagnostics(neighborPath);
				const diags = rawDiags
					.filter((d) => d.severity === 1)
					.slice(0, MAX_PER_FILE);
				const durationMs = Date.now() - neighborStart;

				logCascade({
					phase: "neighbor_touch",
					filePath,
					neighborFile: neighborPath,
					diagnosticCount: diags.length,
					durationMs,
					lspTouched: true,
				});

				neighbors.push({
					filePath: neighborPath,
					reason: determineNeighborReason(impact, neighborPath),
					diagnostics: diags,
					lspTouched: true,
					durationMs,
				});
			} catch (err) {
				dbg?.(`cascade neighbor touch error for ${neighborPath}: ${err}`);
				logCascade({
					phase: "neighbor_fallback",
					filePath,
					neighborFile: neighborPath,
					fallbackUsed: true,
					error: String(err),
				});
				// Fall back to passive snapshot
				const allDiags = await lspService.getAllDiagnostics();
				const entry = allDiags.get(neighborPath);
				const diags = entry && Date.now() - entry.ts < CASCADE_TTL_MS
					? entry.diags.filter((d) => d.severity === 1).slice(0, MAX_PER_FILE)
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

	const formatted = formatCascadeResult(filePath, cwd, impact, neighbors);

	logCascade({
		phase: "cascade_result",
		filePath,
		neighborCount: neighbors.length,
		diagnosticCount: neighbors.reduce((sum, n) => sum + n.diagnostics.length, 0),
		metadata: { hasOutput: formatted.length > 0 },
	});

	return { filePath, impact, neighbors, formatted };
}

function determineNeighborReason(
	impact: ReturnType<typeof computeImpactCascade>,
	neighborPath: string,
): CascadeResult["neighbors"][number]["reason"] {
	if (impact.directImporters.includes(neighborPath)) return "imports";
	if (impact.directCallers.includes(neighborPath)) return "calls";
	return "references";
}

function formatCascadeResult(
	filePath: string,
	cwd: string,
	impact: ReturnType<typeof computeImpactCascade>,
	neighbors: CascadeResult["neighbors"],
): string {
	const withErrors = neighbors.filter((n) => n.diagnostics.length > 0);
	if (withErrors.length === 0) return "";

	const impactHeader = formatImpactCascade(impact);
	let out = impactHeader ? `${impactHeader}\n` : "";
	out += `📐 Cascade errors in ${withErrors.length} neighbor file(s) — fix before finishing turn:`;

	for (const neighbor of withErrors) {
		const display = toRunnerDisplayPath(cwd, neighbor.filePath);
		out += `\n<diagnostics file="${display}">`;
		for (const d of neighbor.diagnostics) {
			const line = (d.range?.start?.line ?? 0) + 1;
			const col = (d.range?.start?.character ?? 0) + 1;
			const code = d.code ? ` code=${String(d.code)}` : "";
			out += `\n  line ${line}, col ${col}${code}: ${d.message.split("\n")[0].slice(0, 100)}`;
		}
		out += "\n</diagnostics>";
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
