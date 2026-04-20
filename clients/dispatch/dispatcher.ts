/**
 * Declarative Tool Dispatcher for pi-lens
 *
 * Redesigned to handle the full complexity of pi-lens's tool_result handler:
 * - Multiple tools with different semantics (blocking, warning, silent)
 * - Delta mode (baseline tracking)
 * - Autofix handling
 * - Output aggregation and formatting
 *
 * Key abstractions:
 * - RunnerDefinition: A tool that can be run
 * - Diagnostic: Structured issue representation
 * - OutputSemantic: How to display (blocking, warning, silent, etc.)
 * - BaselineStore: Track pre-existing issues for delta mode
 */

import * as path from "node:path";
import type { FileKind } from "../file-kinds.js";
import { detectFileKind } from "../file-kinds.js";
import { isTestFile } from "../file-utils.js";
import { getPrimaryDispatchGroup } from "../language-policy.js";
import { resolveLanguageRootForFile } from "../language-profile.js";
import { logLatency } from "../latency-logger.js";
import { normalizeMapKey } from "../path-utils.js";
import { RUNTIME_CONFIG } from "../runtime-config.js";
import { safeSpawnAsync } from "../safe-spawn.js";
import { classifyDiagnostic } from "./diagnostic-taxonomy.js";
import type { FactStore } from "./fact-store.js";
import { getToolPlan } from "./plan.js";
import { resolveRunnerPath } from "./runner-context.js";
import { getToolProfile } from "./tool-profile.js";
import type {
	Diagnostic,
	DispatchContext,
	DispatchResult,
	OutputSemantic,
	PiAgentAPI,
	RunnerDefinition,
	RunnerGroup,
	RunnerRegistry as RunnerRegistryContract,
	RunnerResult,
} from "./types.js";
import { formatDiagnostics } from "./utils/format-utils.js";

// --- Runner Registry ---

export class RunnerRegistry implements RunnerRegistryContract {
	private readonly runners = new Map<string, RunnerDefinition>();

	register(runner: RunnerDefinition): void {
		if (this.runners.has(runner.id)) return;
		this.runners.set(runner.id, runner);
	}

	get(id: string): RunnerDefinition | undefined {
		return this.runners.get(id);
	}

	getForKind(kind: FileKind, filePath?: string): RunnerDefinition[] {
		const matching: RunnerDefinition[] = [];
		const isTest = filePath ? isTestFile(filePath) : false;

		for (const runner of this.runners.values()) {
			if (isTest && runner.skipTestFiles) continue;
			if (runner.appliesTo.includes(kind) || runner.appliesTo.length === 0) {
				matching.push(runner);
			}
		}

		return matching.sort((a, b) => a.priority - b.priority);
	}

	list(): RunnerDefinition[] {
		return Array.from(this.runners.values());
	}

	clear(): void {
		this.runners.clear();
	}
}

// --- Tool Availability Cache ---

/**
 * Normalize a command name to a FactStore session key.
 * Strips .cmd/.exe suffixes (case-insensitive) and lowercases,
 * then prefixes with "session.toolCache.".
 */
export function normalizeCacheKey(cmd: string): string {
	const normalized = cmd.replace(/\.(cmd|exe)$/i, "").toLowerCase();
	return `session.toolCache.${normalized}`;
}

async function checkToolAvailability(
	command: string,
	facts: FactStore,
): Promise<boolean> {
	const key = normalizeCacheKey(command);
	const cached = facts.getSessionFact<boolean>(key);
	if (cached !== undefined) {
		return cached;
	}
	try {
		const result = await safeSpawnAsync(command, ["--version"], {
			timeout: 5000,
		});
		const available = result.status === 0;
		facts.setSessionFact(key, available);
		return available;
	} catch {
		facts.setSessionFact(key, false);
		return false;
	}
}

// --- Dispatch Context Factory ---

export function createDispatchContext(
	filePath: string,
	cwd: string,
	pi: PiAgentAPI,
	facts: FactStore,
	blockingOnly?: boolean,
	modifiedRanges?: import("./types.js").ModifiedRange[],
): DispatchContext {
	const absoluteFilePath = resolveRunnerPath(cwd, filePath);
	const normalizedCwd = normalizeMapKey(
		resolveLanguageRootForFile(absoluteFilePath, cwd),
	);
	const normalizedFilePath = normalizeMapKey(absoluteFilePath);
	const kind = detectFileKind(normalizedFilePath);

	return {
		filePath: normalizedFilePath,
		cwd: normalizedCwd,
		kind,
		pi,
		autofix: false,
		deltaMode: !pi.getFlag("no-delta"),
		facts,
		blockingOnly,
		modifiedRanges,

		async hasTool(command: string): Promise<boolean> {
			return checkToolAvailability(command, facts);
		},

		log(message: string): void {
			console.error(`[dispatch] ${message}`);
		},
	};
}

// --- Delta Mode Logic ---

/**
 * Filter diagnostics to only show NEW issues (delta mode)
 */
function filterDelta<T extends { id: string }>(
	after: T[],
	before: T[] | undefined,
	keyFn: (d: T) => string,
): { new: T[]; fixed: T[] } {
	const beforeSet = new Set((before ?? []).map(keyFn));
	const afterSet = new Set(after.map(keyFn));

	const fixed = (before ?? []).filter((d) => !afterSet.has(keyFn(d)));
	const newItems = after.filter((d) => !beforeSet.has(keyFn(d)));

	return { new: newItems, fixed };
}

function semanticRank(semantic: OutputSemantic): number {
	if (semantic === "blocking") return 4;
	if (semantic === "warning") return 3;
	if (semantic === "fixed") return 2;
	if (semantic === "silent") return 1;
	return 0;
}

function toolPriority(tool: string, defectClass: string): number {
	return getToolProfile(tool, defectClass).dedupPriority;
}

function dedupeOverlappingDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
	const byKey = new Map<string, Diagnostic>();

	for (const d of diagnostics) {
		const defectClass = d.defectClass ?? classifyDiagnostic(d);
		const line = d.line ?? 1;
		const column = d.column ?? 1;
		const ruleKey = d.rule || d.id || "unknown";
		const key = `${d.filePath}:${line}:${column}:${defectClass}:${ruleKey}`;
		const current = byKey.get(key);
		if (!current) {
			byKey.set(key, { ...d, defectClass });
			continue;
		}

		const currScore =
			semanticRank(current.semantic) * 100 +
			toolPriority(current.tool, defectClass);
		const nextScore =
			semanticRank(d.semantic) * 100 + toolPriority(d.tool, defectClass);
		if (nextScore > currScore) {
			byKey.set(key, { ...d, defectClass });
		}
	}

	return [...byKey.values()];
}

/**
 * Apply inline suppression comments.
 * Syntax: `// pi-lens-ignore: rule-id` (JS/TS) or `# pi-lens-ignore: rule-id` (Python/Ruby/etc.)
 * Place on the same line as the diagnostic or the line immediately above it.
 */
function applyInlineSuppressions(
	diagnostics: Diagnostic[],
	content: string,
): Diagnostic[] {
	if (!content || !diagnostics.length) return diagnostics;

	// Build a set of (line, ruleId) pairs that are suppressed.
	// Line numbers are 1-based to match diagnostic line numbers.
	const suppressed = new Set<string>();
	const lines = content.split("\n");
	const SUPPRESS_RE = /(?:\/\/|#)\s*pi-lens-ignore:\s*(.+)/;
	for (let i = 0; i < lines.length; i++) {
		const m = SUPPRESS_RE.exec(lines[i]);
		if (!m) continue;
		const rules = m[1]
			.split(",")
			.map((r) => r.trim())
			.filter(Boolean);
		const suppressedLine = i + 1; // same line (1-based)
		const nextLine = i + 2; // next line (1-based)
		for (const ruleId of rules) {
			suppressed.add(`${suppressedLine}:${ruleId}`);
			suppressed.add(`${nextLine}:${ruleId}`);
		}
	}

	if (suppressed.size === 0) return diagnostics;

	return diagnostics.filter((d) => {
		const ruleId = d.rule ?? d.id ?? "";
		const line = d.line ?? 1;
		return !suppressed.has(`${line}:${ruleId}`);
	});
}

function suppressLintOverlapsWithLsp(diagnostics: Diagnostic[]): Diagnostic[] {
	const lspBySpanClass = new Set<string>();
	const lspByLine = new Set<string>();
	const isLintTool = (tool: string): boolean => {
		return getToolProfile(tool).lintLike;
	};

	for (const d of diagnostics) {
		if (d.tool !== "lsp" && d.tool !== "ts-lsp") continue;
		const line = d.line ?? 1;
		const defectClass = d.defectClass ?? classifyDiagnostic(d);
		lspBySpanClass.add(`${d.filePath}:${line}:${defectClass}`);
		lspByLine.add(`${d.filePath}:${line}`);
	}

	if (lspByLine.size === 0) return diagnostics;

	return diagnostics.filter((d) => {
		if (d.tool === "lsp" || d.tool === "ts-lsp") return true;
		if (!isLintTool(d.tool)) return true;
		if (d.semantic === "blocking" || d.severity === "error") return true;

		const line = d.line ?? 1;
		const defectClass = d.defectClass ?? classifyDiagnostic(d);
		const key = `${d.filePath}:${line}:${defectClass}`;
		if (lspBySpanClass.has(key)) return false;

		// Conservative fallback for unclassified overlap at same line.
		if (defectClass === "unknown") {
			return !lspByLine.has(`${d.filePath}:${line}`);
		}

		return true;
	});
}

function isUnusedValueDiagnostic(d: Diagnostic): boolean {
	const raw = `${d.id ?? ""} ${d.rule ?? ""} ${d.message ?? ""}`.toLowerCase();
	if (raw.includes("no-unused")) return true;
	if (/\b(6133|6192|6196)\b/.test(raw)) return true;

	const rule = String(d.rule ?? "").toLowerCase();
	if (rule.includes("unused")) return true;

	const message = d.message.toLowerCase();
	return (
		message.includes("is declared but its value is never read") ||
		message.includes("is assigned a value but never used") ||
		message.includes("declared but never used") ||
		message.includes("unused")
	);
}

function promoteDeltaUnusedToBlockers(diagnostics: Diagnostic[]): Diagnostic[] {
	return diagnostics.map((d) => {
		if (!isUnusedValueDiagnostic(d)) return d;
		if (d.semantic === "blocking" || d.severity === "error") return d;
		return {
			...d,
			severity: "error",
			semantic: "blocking",
			fixSuggestion:
				d.fixSuggestion ??
				"Remove the unused declaration or rename with '_' prefix if intentionally unused.",
		};
	});
}

// --- Latency Logger ---

export interface RunnerLatency {
	runnerId: string;
	startTime: number;
	endTime: number;
	durationMs: number;
	status: "succeeded" | "failed" | "skipped" | "when_skipped";
	diagnosticCount: number;
	semantic: string;
}

export interface DispatchLatencyReport {
	filePath: string;
	fileKind: string | undefined;
	overallStartMs: number;
	overallEndMs: number;
	totalDurationMs: number;
	runners: RunnerLatency[];
	stoppedEarly: boolean;
	totalDiagnostics: number;
	blockers: number;
	warnings: number;
}

function buildCoverageNotice(
	ctx: DispatchContext,
	runnerLatencies: RunnerLatency[],
): Diagnostic | undefined {
	if (!ctx.kind) return undefined;
	const lspEnabled = !ctx.pi.getFlag("no-lsp");
	const primary = getPrimaryDispatchGroup(ctx.kind, lspEnabled);
	if (!primary || primary.runnerIds.length === 0) return undefined;

	const relevant = runnerLatencies.filter((r) =>
		primary.runnerIds.includes(r.runnerId),
	);
	if (relevant.length === 0) return undefined;

	// Check primary runners first
	const primaryHasCoverage = relevant.some(
		(r) => r.status === "succeeded" || r.status === "failed",
	);
	if (primaryHasCoverage) return undefined;

	const allPrimarySkipped = relevant.every(
		(r) => r.status === "skipped" || r.status === "when_skipped",
	);
	if (!allPrimarySkipped) return undefined;

	const plan = getToolPlan(ctx.kind);
	const fallbackRunnerIds = new Set(
		(plan?.groups ?? [])
			.filter(
				(group) =>
					!group.runnerIds.every((runnerId) =>
						primary.runnerIds.includes(runnerId),
					),
			)
			.flatMap((group) => group.runnerIds)
			.filter((runnerId) => !primary.runnerIds.includes(runnerId)),
	);

	// Structural-only runners (tree-sitter, ast-grep, similarity) are not
	// substitutes for real linters — don't suppress the notice if only they ran.
	const STRUCTURAL_RUNNERS = new Set([
		"tree-sitter",
		"ast-grep-napi",
		"similarity",
		"spellcheck",
		"architect",
		"fact-rules",
	]);
	const anyLinterHasCoverage = runnerLatencies.some(
		(r) =>
			fallbackRunnerIds.has(r.runnerId) &&
			!STRUCTURAL_RUNNERS.has(r.runnerId) &&
			(r.status === "succeeded" || r.status === "failed"),
	);
	if (anyLinterHasCoverage) return undefined;

	const onceKey = `${ctx.kind}:${normalizeMapKey(ctx.filePath)}`;
	if (coverageNoticeSeen.has(onceKey)) return undefined;
	coverageNoticeSeen.add(onceKey);

	return {
		id: `coverage-unavailable:${ctx.kind}:${path.basename(ctx.filePath)}`,
		message: `Pi-lens analysis unavailable. Tools for ${ctx.kind} not installed.`,
		filePath: ctx.filePath,
		severity: "warning",
		semantic: "warning",
		tool: "pi-lens",
	};
}

const latencyReports: DispatchLatencyReport[] = [];
const coverageNoticeSeen = new Set<string>();

export function getLatencyReports(): DispatchLatencyReport[] {
	return [...latencyReports];
}

export function clearLatencyReports(): void {
	latencyReports.length = 0;
}

export function clearCoverageNoticeState(): void {
	coverageNoticeSeen.clear();
}

export function formatLatencyReport(report: DispatchLatencyReport): string {
	const lines: string[] = [];
	lines.push(
		`\n═══════════════════════════════════════════════════════════════`,
	);
	lines.push(`📊 DISPATCH LATENCY REPORT: ${report.filePath.split("/").pop()}`);
	lines.push(
		`   Kind: ${report.fileKind || "unknown"} | Total: ${report.totalDurationMs}ms`,
	);
	lines.push(`───────────────────────────────────────────────────────────────`);
	lines.push(
		`Runner                          Duration  Status    Issues  Semantic`,
	);
	lines.push(`───────────────────────────────────────────────────────────────`);

	for (const r of report.runners) {
		const name = r.runnerId.padEnd(30);
		const dur = `${r.durationMs}ms`.padStart(8);
		const status = r.status.padStart(9);
		const issues = String(r.diagnosticCount).padStart(6);
		const sem = r.semantic.padStart(8);
		const slowMarker =
			r.durationMs > 500 ? " 🔥" : r.durationMs > 100 ? " ⚡" : "";
		lines.push(`${name}${dur}${status}${issues}${sem}${slowMarker}`);
	}

	lines.push(`───────────────────────────────────────────────────────────────`);
	lines.push(
		`Total: ${report.runners.length} runners | Stopped early: ${report.stoppedEarly}`,
	);
	lines.push(
		`Diagnostics: ${report.totalDiagnostics} (${report.blockers} blockers, ${report.warnings} warnings)`,
	);

	// Show top 3 slowest
	const sorted = [...report.runners].sort(
		(a, b) => b.durationMs - a.durationMs,
	);
	if (sorted.length > 0 && sorted[0].durationMs > 100) {
		lines.push(`\n🐌 Slowest runners:`);
		for (const r of sorted.slice(0, 3)) {
			if (r.durationMs > 50) {
				lines.push(`   ${r.runnerId}: ${r.durationMs}ms (${r.status})`);
			}
		}
	}

	lines.push(`═══════════════════════════════════════════════════════════════`);
	return lines.join("\n");
}

// --- Group runner (used by dispatchForFile for parallel execution) ---

interface GroupResult {
	diagnostics: Diagnostic[];
	latencies: RunnerLatency[];
	hadBlocker: boolean;
}

/**
 * Execute all runners in a single group.
 *
 * - mode "fallback": run runners sequentially and stop at the first
 *   one that succeeds (returns status !== "skipped").
 * - mode "all" (default): run all runners in the group sequentially
 *   and collect every diagnostic.
 *
 * Groups themselves are run in parallel by dispatchForFile, so this
 * function must NOT mutate shared state.
 */
async function runGroup(
	ctx: DispatchContext,
	group: RunnerGroup,
	registry: RunnerRegistryContract,
): Promise<GroupResult> {
	const diagnostics: Diagnostic[] = [];
	const latencies: RunnerLatency[] = [];
	let hadBlocker = false;

	// Filter runners by kind if specified
	const runnerIds = group.filterKinds
		? group.runnerIds.filter((id) => {
				const runner = registry.get(id);
				return runner && ctx.kind && group.filterKinds?.includes(ctx.kind);
			})
		: group.runnerIds;

	const semantic = group.semantic ?? "warning";

	for (const runnerId of runnerIds) {
		const runnerStart = Date.now();
		const runner = registry.get(runnerId);

		if (!runner) {
			latencies.push({
				runnerId,
				startTime: runnerStart,
				endTime: Date.now(),
				durationMs: 0,
				status: "skipped",
				diagnosticCount: 0,
				semantic: "unknown",
			});
			logLatency({
				type: "runner",
				filePath: ctx.filePath,
				runnerId,
				durationMs: 0,
				status: "not_registered",
				diagnosticCount: 0,
				semantic: "unknown",
			});
			continue;
		}

		// Check preconditions
		let shouldRun = true;
		if (runner.when) {
			try {
				shouldRun = await runner.when(ctx);
			} catch (error) {
				ctx.log(`Runner ${runner.id} precondition failed: ${error}`);
				shouldRun = false;
			}
		}
		if (!shouldRun) {
			latencies.push({
				runnerId,
				startTime: runnerStart,
				endTime: Date.now(),
				durationMs: Date.now() - runnerStart,
				status: "when_skipped",
				diagnosticCount: 0,
				semantic: runner.id,
			});
			logLatency({
				type: "runner",
				filePath: ctx.filePath,
				runnerId,
				durationMs: 0,
				status: "when_skipped",
				diagnosticCount: 0,
				semantic: "when_condition",
			});
			continue;
		}

		const result = await runRunner(ctx, runner, semantic);
		const runnerEnd = Date.now();
		const duration = runnerEnd - runnerStart;

		latencies.push({
			runnerId,
			startTime: runnerStart,
			endTime: runnerEnd,
			durationMs: duration,
			status: result.status,
			diagnosticCount: result.diagnostics.length,
			semantic: result.semantic ?? semantic,
		});
		logLatency({
			type: "runner",
			filePath: ctx.filePath,
			runnerId,
			startedAt: new Date(runnerStart).toISOString(),
			durationMs: duration,
			status: result.status,
			diagnosticCount: result.diagnostics.length,
			semantic: result.semantic ?? semantic,
		});

		diagnostics.push(...result.diagnostics);

		const resultSemantic = result.semantic ?? semantic;
		if (
			(resultSemantic === "blocking" && result.diagnostics.length > 0) ||
			result.diagnostics.some((d) => d.semantic === "blocking")
		) {
			hadBlocker = true;
		}

		// mode:"fallback" — stop at first successful runner
		if (group.mode === "fallback" && result.status === "succeeded") {
			break;
		}
	}

	return { diagnostics, latencies, hadBlocker };
}

// --- Main Dispatch Function ---

export async function dispatchForFile(
	ctx: DispatchContext,
	groups: RunnerGroup[],
	registry: RunnerRegistryContract,
): Promise<DispatchResult> {
	const _overallStart = Date.now();
	const allDiagnostics: Diagnostic[] = [];
	const _fixed: Diagnostic[] = [];
	let stopped = false;
	const runnerLatencies: RunnerLatency[] = [];

	// Debug logging goes to latency log only (not console - avoid noise)
	const allRunnerIds = groups.flatMap((g) => g.runnerIds);
	logLatency({
		type: "phase",
		filePath: ctx.filePath,
		phase: "dispatch_start",
		durationMs: 0,
		metadata: {
			groupCount: groups.length,
			kind: ctx.kind,
			runners: allRunnerIds.join(","),
		},
	});

	// Run all groups in parallel — they are independent and don't depend on
	// each other's results. Within each group, mode:"fallback" semantics are
	// preserved (sequential first-success). Results are merged in original
	// group order so output is deterministic.
	const groupResults = await Promise.all(
		groups.map((group) => runGroup(ctx, group, registry)),
	);

	// Count baseline warnings before filtering (for delta count display)
	const relativeKey = path.relative(ctx.cwd, ctx.filePath).replace(/\\/g, "/");
	const baselineAbsKey = `session.baseline.${normalizeMapKey(ctx.filePath)}`;
	const baselineRelKey = `session.baseline.${normalizeMapKey(relativeKey)}`;
	const previousBaseline = ctx.deltaMode
		? (ctx.facts.getSessionFact<Diagnostic[]>(baselineAbsKey) ??
			ctx.facts.getSessionFact<Diagnostic[]>(baselineRelKey))
		: undefined;
	const baselineWarnings = previousBaseline?.filter(
		(d) => d.semantic === "warning" || d.semantic === "none",
	);
	const baselineWarningCount = baselineWarnings?.length ?? 0;

	for (const {
		diagnostics: groupDiags,
		latencies,
		hadBlocker,
	} of groupResults) {
		runnerLatencies.push(...latencies);

		allDiagnostics.push(...groupDiags);
		if (hadBlocker) stopped = true;
	}

	// Apply delta mode ONCE across the full diagnostic set.
	// This avoids partial-baseline corruption when processing multiple groups.
	const dedupedDiagnostics = dedupeOverlappingDiagnostics(allDiagnostics);
	const overlapSuppressed = suppressLintOverlapsWithLsp(dedupedDiagnostics);
	const fileContent =
		ctx.facts.getFileFact<string>(ctx.filePath, "file.content") ?? "";
	const inlineSuppressed = applyInlineSuppressions(
		overlapSuppressed,
		fileContent,
	);
	let visibleDiagnostics = inlineSuppressed;
	let resolvedCount = 0;
	if (ctx.deltaMode && previousBaseline) {
		const filtered = filterDelta(
			visibleDiagnostics,
			previousBaseline,
			(d) => d.id,
		);
		visibleDiagnostics = promoteDeltaUnusedToBlockers(filtered.new);
		resolvedCount = filtered.fixed.length;
	}

	// Persist full current snapshot for next run (not delta-filtered subset).
	if (ctx.deltaMode) {
		ctx.facts.setSessionFact(baselineAbsKey, [...dedupedDiagnostics]);
		ctx.facts.setSessionFact(baselineRelKey, [...dedupedDiagnostics]);
	}

	// Categorize results
	const blockers = visibleDiagnostics.filter((d) => d.semantic === "blocking");
	const warnings = visibleDiagnostics.filter(
		(d) => d.semantic === "warning" || d.semantic === "none",
	);
	const fixedItems = visibleDiagnostics.filter((d) => d.semantic === "fixed");

	// Append fixed and fixable diagnostics to the persistent worklog
	if (fixedItems.length > 0) {
		import("../fix-worklog.js")
			.then(({ appendToWorklog }) => {
				appendToWorklog(ctx.cwd, fixedItems, true);
			})
			.catch(() => {});
	}
	const fixableWarnings = warnings.filter((d) => d.fixable);
	if (fixableWarnings.length > 0) {
		import("../fix-worklog.js")
			.then(({ appendToWorklog }) => {
				appendToWorklog(ctx.cwd, fixableWarnings, false);
			})
			.catch(() => {});
	}

	const inlineBlockers = blockers.filter((d) => d.tool !== "similarity");
	const inlineFixed = fixedItems.filter((d) => d.tool !== "similarity");
	const coverageNotice = buildCoverageNotice(ctx, runnerLatencies);

	// Format output — only blocking issues shown inline
	// Warnings tracked but not shown (noise) — surfaced via /lens-booboo
	let output = formatDiagnostics(inlineBlockers, "blocking");
	output += formatDiagnostics(inlineFixed, "fixed");
	if (coverageNotice) {
		output += formatDiagnostics([coverageNotice], "warning", 1);
		warnings.push(coverageNotice);
	}

	// Generate and store latency report
	const overallEnd = Date.now();
	const latencyReport: DispatchLatencyReport = {
		filePath: ctx.filePath,
		fileKind: ctx.kind,
		overallStartMs: _overallStart,
		overallEndMs: overallEnd,
		totalDurationMs: overallEnd - _overallStart,
		runners: runnerLatencies,
		stoppedEarly: stopped,
		totalDiagnostics: visibleDiagnostics.length,
		blockers: blockers.length,
		warnings: warnings.length,
	};

	// Store for later analysis
	latencyReports.push(latencyReport);

	// Keep only last 100 reports to prevent memory bloat
	if (latencyReports.length > 100) {
		latencyReports.shift();
	}

	// Runner latencies already logged immediately after execution (line ~329)
	// The runnerLatencies array is stored in latencyReport for aggregate analysis
	// No need to log again here - would create duplicates in the log

	// Log summary to latency log only (not console - avoid noise)
	const sumMs = runnerLatencies.reduce((s, r) => s + r.durationMs, 0);
	const wallClockMs = latencyReport.totalDurationMs;
	logLatency({
		type: "tool_result",
		filePath: ctx.filePath,
		durationMs: wallClockMs,
		wallClockMs,
		sumMs,
		parallelGainMs: Math.max(0, sumMs - wallClockMs),
		result: "dispatch_complete",
		metadata: {
			runners: runnerLatencies.map((r) => ({
				id: r.runnerId,
				startedAt: new Date(r.startTime).toISOString(),
				duration: r.durationMs,
				status: r.status,
			})),
			totalDiagnostics: visibleDiagnostics.length,
			blockers: blockers.length,
		},
	});

	return {
		diagnostics: visibleDiagnostics,
		blockers,
		warnings,
		baselineWarningCount,
		fixed: fixedItems,
		resolvedCount,
		output,
		hasBlockers: blockers.length > 0,
	};
}

// --- Run Single Runner ---

/** Maximum wall-clock time a single runner may take before we abort it. */
const RUNNER_TIMEOUT_MS = RUNTIME_CONFIG.dispatch.runnerTimeoutMs;

function looksLikeDiagnosticCodePath(value: string): boolean {
	if (!value) return false;
	const text = value.trim();
	if (!text) return false;
	const base = path.basename(text.replace(/\\/g, "/"));
	if (/^lsp:\d+(?::\d+)?$/i.test(text) || /^lsp:\d+(?::\d+)?$/i.test(base)) {
		return true;
	}
	if (/^similarity[-:]/i.test(text) || /^similarity[-:]/i.test(base)) {
		return true;
	}
	if (
		/^[a-z-]+:\d+(?::\d+)?$/i.test(text) ||
		/^[a-z-]+:\d+(?::\d+)?$/i.test(base)
	) {
		return true;
	}
	return false;
}

function normalizeDiagnosticFilePath(
	ctx: DispatchContext,
	rawPath?: string,
): string {
	if (typeof rawPath === "string" && looksLikeDiagnosticCodePath(rawPath)) {
		ctx.log(
			`runner path normalization: ignored diagnostic code-like path '${rawPath}', using current file`,
		);
		return resolveRunnerPath(ctx.cwd, ctx.filePath);
	}

	return resolveRunnerPath(ctx.cwd, rawPath || ctx.filePath);
}

async function runRunner(
	ctx: DispatchContext,
	runner: RunnerDefinition,
	defaultSemantic: OutputSemantic,
): Promise<RunnerResult> {
	try {
		const result = await Promise.race([
			runner.run(ctx),
			new Promise<never>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new Error(
								`Runner ${runner.id} timed out after ${RUNNER_TIMEOUT_MS}ms`,
							),
						),
					RUNNER_TIMEOUT_MS,
				),
			),
		]);

		const diagnostics = result.diagnostics.map((d) => ({
			...d,
			filePath: normalizeDiagnosticFilePath(ctx, d.filePath),
		}));

		return {
			...result,
			diagnostics,
			semantic: result.semantic ?? defaultSemantic,
		};
	} catch (error) {
		ctx.log(`Runner ${runner.id} failed: ${error}`);
		return {
			status: "failed",
			diagnostics: [],
			semantic: defaultSemantic,
		};
	}
}

// --- Simple Integration Helper ---

/**
 * @internal
 * Low-level dispatch entry point. Use `dispatchLint` from `./integration.js` instead —
 * that version provides session-persistent baselines and FactStore.
 * This function creates an ephemeral FactStore per call; facts do not persist across calls.
 */
export async function dispatchLint(
	filePath: string,
	cwd: string,
	pi: PiAgentAPI,
	facts: FactStore,
	registry: RunnerRegistryContract,
): Promise<string> {
	// By default, only run BLOCKING rules for fast feedback on file write
	const ctx = createDispatchContext(filePath, cwd, pi, facts, true);

	// Get runners for this file kind
	if (!ctx.kind) return "";
	const runners = registry.getForKind(ctx.kind, ctx.filePath);
	if (runners.length === 0) {
		return "";
	}

	// Create groups from registered runners (all in fallback mode)
	const groups: RunnerGroup[] = [
		{
			mode: "fallback",
			runnerIds: runners.map((r) => r.id),
		},
	];

	const result = await dispatchForFile(ctx, groups, registry);
	return result.output;
}
