/**
 * Effect-TS Integration for pi-lens Dispatch
 * 
 * Bridges the Effect service layer with the existing dispatch system.
 * 
 * This provides:
 * - Concurrent runner execution with Effect.all
 * - Timeout handling for slow runners
 * - Graceful error recovery
 * - Bus event integration
 */

import {
	runRunnersConcurrent,
	executeEffect,
	formatError,
	type RunnerResult,
	type ConcurrentRunnerResult,
} from "./runner-service.js";

import {
	DiagnosticFound,
	RunnerStarted,
	RunnerCompleted,
	FileModified,
	type Diagnostic,
} from "../bus/events.js";

import type { DispatchContext, RunnerGroup } from "../dispatch/types.js";

// --- Enhanced Result Type ---

export interface EffectDispatchResult {
	diagnostics: Diagnostic[];
	blockers: Diagnostic[];
	warnings: Diagnostic[];
	fixed: Diagnostic[];
	silent: Diagnostic[];
	output: string;
	hasBlockers: boolean;
	durationMs: number;
	runnerResults: ConcurrentRunnerResult[];
}

// --- Core Functions ---

/**
 * Run all runners in a group concurrently using Effect
 */
async function runGroupConcurrent(
	ctx: DispatchContext,
	group: RunnerGroup,
): Promise<{ results: ConcurrentRunnerResult[]; diagnostics: Diagnostic[] }> {
	const { getRunner, getRunnersForKind } = await import("../dispatch/dispatcher.js");
	const startTime = Date.now();

	// Get runner definitions
	const runnerDefs = group.filterKinds
		? group.runnerIds
				.filter((id) => {
					const runner = getRunner(id);
					return runner && ctx.kind && group.filterKinds?.includes(ctx.kind);
				})
		: group.runnerIds;

	const runners = runnerDefs
		.map((id) => getRunner(id))
		.filter((r): r is NonNullable<typeof r> => r !== undefined)
		.filter((r) => (r.when ? r.when(ctx) : true));

	if (runners.length === 0) {
		return { results: [], diagnostics: [] };
	}

	// Build the single runner execution function
	const runSingle = async (filePath: string, runnerId: string): Promise<RunnerResult> => {
		const runner = getRunner(runnerId);
		if (!runner) {
			return { diagnostics: [], durationMs: 0 };
		}

		// Publish started event
		RunnerStarted.publish({
			runnerId,
			filePath,
			timestamp: Date.now(),
		});

		const runnerStart = Date.now();
		let status: "completed" | "failed" = "completed";
		let diagnostics: Diagnostic[] = [];

		try {
			const result = await runner.run(ctx);
			diagnostics = result.diagnostics.map((d) => ({
				id: d.id,
				message: d.message,
				filePath: ctx.filePath,
				line: d.line,
				column: d.column,
				severity: d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "info",
				semantic: result.semantic ?? "warning",
				tool: runnerId,
				rule: d.rule,
				fixable: d.fixable,
				fixSuggestion: d.fixSuggestion,
			}));

			// Publish diagnostic found event
			if (diagnostics.length > 0) {
				DiagnosticFound.publish({
					runnerId,
					filePath: ctx.filePath,
					diagnostics,
					durationMs: Date.now() - runnerStart,
				});
			}

			return {
				diagnostics: diagnostics.map((d) => ({
					id: d.id,
					message: d.message,
					severity: d.severity,
				})),
				durationMs: Date.now() - runnerStart,
			};
		} catch (err) {
			status = "failed";
			return {
				diagnostics: [],
				durationMs: Date.now() - runnerStart,
				error: String(err),
			};
		} finally {
			// Publish completed event
			RunnerCompleted.publish({
				runnerId,
				filePath: ctx.filePath,
				status,
				durationMs: Date.now() - runnerStart,
				diagnosticCount: diagnostics.length,
			});
		}
	};

	// Run all runners concurrently using Effect
	const runnerIds = runners.map((r) => r.id);
	const concurrentResults = await executeEffect(
		runRunnersConcurrent(ctx.filePath, runnerIds, runSingle, 30_000)
	);

	// Collect all diagnostics
	const allDiagnostics: Diagnostic[] = [];
	for (const result of concurrentResults) {
		if (result.status === "success") {
			allDiagnostics.push(
				...result.diagnostics.map((d) => ({
					id: d.id,
					message: d.message,
					filePath: ctx.filePath,
					severity: d.severity,
					semantic: group.semantic ?? "warning",
					tool: result.runnerId,
				}))
			);
		}
	}

	return {
		results: concurrentResults,
		diagnostics: allDiagnostics,
	};
}

// --- Formatting ---

const EMOJI: Record<string, string> = {
	blocking: "🔴",
	warning: "🟡",
	fixed: "✅",
	silent: "📊",
	none: "",
};

function formatDiagnostic(d: Diagnostic): string {
	const line = d.line ? `L${d.line}: ` : "";
	const indented = d.message.split("\n").join("\n  ");
	return `  ${line}${indented}`;
}

function formatDiagnostics(
	diagnostics: Diagnostic[],
	semantic: string,
	maxDisplay = 10,
): string {
	if (diagnostics.length === 0) return "";

	const emoji = EMOJI[semantic] ?? EMOJI.warning;
	let output = "";

	if (semantic === "blocking") {
		output += `\n${emoji} STOP — ${diagnostics.length} issue(s) must be fixed:\n`;
	} else if (semantic === "warning") {
		output += `\n${emoji} ${diagnostics.length} warning(s):\n`;
	} else if (semantic === "fixed") {
		output += `\n${emoji} Auto-fixed ${diagnostics.length} issue(s):\n`;
	}

	for (const d of diagnostics.slice(0, maxDisplay)) {
		output += `${formatDiagnostic(d)}\n`;
	}

	if (diagnostics.length > maxDisplay) {
		output += `  ... and ${diagnostics.length - maxDisplay} more\n`;
	}

	return output;
}

// --- Main Dispatch Function ---

export async function dispatchWithEffect(
	ctx: DispatchContext,
	groups: RunnerGroup[],
): Promise<EffectDispatchResult> {
	const startTime = Date.now();
	const allDiagnostics: Diagnostic[] = [];
	const allRunnerResults: ConcurrentRunnerResult[] = [];
	let stopped = false;

	// Publish file modified event
	FileModified.publish({
		filePath: ctx.filePath,
		changeType: "external",
	});

	for (const group of groups) {
		if (stopped && ctx.pi.getFlag("stop-on-error")) {
			break;
		}

		const { results, diagnostics } = await runGroupConcurrent(ctx, group);

		allDiagnostics.push(...diagnostics);
		allRunnerResults.push(...results);

		// Check for blockers
		const semantic = group.semantic ?? "warning";
		if (semantic === "blocking" && diagnostics.length > 0) {
			stopped = true;
		}
	}

	// Categorize results
	const blockers = allDiagnostics.filter((d) => d.semantic === "blocking");
	const warnings = allDiagnostics.filter(
		(d) => d.semantic === "warning" || d.semantic === "none",
	);
	const fixedItems = allDiagnostics.filter((d) => d.semantic === "fixed");
	const silentItems = allDiagnostics.filter((d) => d.semantic === "silent");

	// Format output
	let output = formatDiagnostics(blockers, "blocking");
	output += formatDiagnostics(fixedItems, "fixed");

	const durationMs = Date.now() - startTime;

	// Log performance info in debug mode
	if (ctx.pi.getFlag("lens-bus-debug")) {
		console.error(`[effect] Total duration: ${durationMs}ms`);
		for (const r of allRunnerResults) {
			console.error(`[effect] ${r.runnerId}: ${r.status} (${r.durationMs}ms)`);
		}
	}

	return {
		diagnostics: allDiagnostics,
		blockers,
		warnings,
		fixed: fixedItems,
		silent: silentItems,
		output,
		hasBlockers: blockers.length > 0,
		durationMs,
		runnerResults: allRunnerResults,
	};
}

// --- Simple Integration Helper ---

export async function dispatchLintWithEffect(
	filePath: string,
	cwd: string,
	pi: { getFlag(flag: string): string | boolean | undefined },
): Promise<string> {
	const { createDispatchContext } = await import("../dispatch/dispatcher.js");
	const { TOOL_PLANS } = await import("../dispatch/plan.js");

	const ctx = createDispatchContext(filePath, cwd, pi);

	const kind = ctx.kind;
	if (!kind) return "";

	const plan = TOOL_PLANS[kind];
	if (!plan) return "";

	const result = await dispatchWithEffect(ctx, plan.groups);
	return result.output;
}
