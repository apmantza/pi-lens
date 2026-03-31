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

import type { FileKind } from "../file-kinds.js";
import { detectFileKind } from "../file-kinds.js";
import { isTestFile } from "../file-utils.js";
import { safeSpawn } from "../safe-spawn.js";
import type {
	BaselineStore,
	Diagnostic,
	DispatchContext,
	DispatchResult,
	OutputSemantic,
	PiAgentAPI,
	RunnerDefinition,
	RunnerGroup,
	RunnerResult,
} from "./types.js";
import { formatDiagnostics } from "./utils/format-utils.js";

// --- In-Memory Baseline Store ---

export function createBaselineStore(): BaselineStore {
	const baselines = new Map<string, unknown[]>();

	return {
		get(filePath) {
			return baselines.get(filePath);
		},
		set(filePath, diagnostics) {
			baselines.set(filePath, diagnostics);
		},
		clear() {
			baselines.clear();
		},
	};
}

// --- Runner Registry ---

const globalRegistry = new Map<string, RunnerDefinition>();

export function registerRunner(runner: RunnerDefinition): void {
	if (globalRegistry.has(runner.id)) {
		console.error(`[dispatch] Duplicate runner: ${runner.id}`);
		return;
	}
	globalRegistry.set(runner.id, runner);
}

export function getRunner(id: string): RunnerDefinition | undefined {
	return globalRegistry.get(id);
}

export function getRunnersForKind(
	kind: FileKind | undefined,
	filePath?: string,
): RunnerDefinition[] {
	if (!kind) return [];
	const runners: RunnerDefinition[] = [];
	const isTest = filePath ? isTestFile(filePath) : false;

	for (const runner of globalRegistry.values()) {
		// Skip runners that shouldn't run on test files
		if (isTest && runner.skipTestFiles) continue;

		if (runner.appliesTo.includes(kind) || runner.appliesTo.length === 0) {
			runners.push(runner);
		}
	}
	return runners.sort((a, b) => a.priority - b.priority);
}

export function listRunners(): RunnerDefinition[] {
	return Array.from(globalRegistry.values());
}

/**
 * Clear all registered runners. Used primarily for testing.
 */
export function clearRunnerRegistry(): void {
	globalRegistry.clear();
}

// --- Tool Availability Cache ---

const toolCache = new Map<string, boolean>();

function checkToolAvailability(command: string): boolean {
	if (toolCache.has(command)) {
		return toolCache.get(command)!;
	}
	try {
		const result = safeSpawn(command, ["--version"], {
			timeout: 5000,
		});
		const available = result.status === 0;
		toolCache.set(command, available);
		return available;
	} catch {
		toolCache.set(command, false);
		return false;
	}
}

// --- Dispatch Context Factory ---

export function createDispatchContext(
	filePath: string,
	cwd: string,
	pi: PiAgentAPI,
	baselines?: BaselineStore,
): DispatchContext {
	const kind = detectFileKind(filePath);

	return {
		filePath,
		cwd,
		kind,
		pi,
		autofix: !!(pi.getFlag("autofix-biome") || pi.getFlag("autofix-ruff")),
		deltaMode: !pi.getFlag("no-delta"),
		baselines: baselines ?? createBaselineStore(),

		async hasTool(command: string): Promise<boolean> {
			return checkToolAvailability(command);
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

// --- Main Dispatch Function ---

export async function dispatchForFile(
	ctx: DispatchContext,
	groups: RunnerGroup[],
): Promise<DispatchResult> {
	const allDiagnostics: Diagnostic[] = [];
	const _fixed: Diagnostic[] = [];
	let stopped = false;

	for (const group of groups) {
		if (stopped && ctx.pi.getFlag("stop-on-error")) {
			break;
		}

		// Filter runners by kind if specified
		const runnerIds = group.filterKinds
			? group.runnerIds.filter((id) => {
					const runner = getRunner(id);
					return runner && ctx.kind && group.filterKinds?.includes(ctx.kind);
				})
			: group.runnerIds;

		const semantic = group.semantic ?? "warning";

		for (const runnerId of runnerIds) {
			const runner = getRunner(runnerId);
			if (!runner) continue;

			// Check preconditions
			if (runner.when && !(await runner.when(ctx))) {
				continue;
			}

			const result = await runRunner(ctx, runner, semantic);

			// Apply delta mode filtering
			let diagnostics = result.diagnostics;
			if (ctx.deltaMode && result.semantic !== "silent") {
				const before = ctx.baselines.get(ctx.filePath);
				if (before) {
					const filtered = filterDelta(
						diagnostics,
						before as Diagnostic[],
						(d) => d.id,
					);
					diagnostics = filtered.new;
					// TODO: Track fixed diagnostics
				}
				// Update baseline
				ctx.baselines.set(ctx.filePath, [...allDiagnostics, ...diagnostics]);
			}

			allDiagnostics.push(...diagnostics);

			// Check for blockers
			if (semantic === "blocking" && diagnostics.length > 0) {
				stopped = true;
			}
		}
	}

	// Categorize results
	const blockers = allDiagnostics.filter((d) => d.semantic === "blocking");
	const warnings = allDiagnostics.filter(
		(d) => d.semantic === "warning" || d.semantic === "none",
	);
	const fixedItems = allDiagnostics.filter((d) => d.semantic === "fixed");

	// Format output — only blocking issues shown inline
	// Warnings tracked but not shown (noise) — surfaced via /lens-booboo
	let output = formatDiagnostics(blockers, "blocking");
	output += formatDiagnostics(fixedItems, "fixed");

	return {
		diagnostics: allDiagnostics,
		blockers,
		warnings,
		fixed: fixedItems,
		output,
		hasBlockers: blockers.length > 0,
	};
}

// --- Run Single Runner ---

async function runRunner(
	ctx: DispatchContext,
	runner: RunnerDefinition,
	defaultSemantic: OutputSemantic,
): Promise<RunnerResult> {
	try {
		const result = await runner.run(ctx);
		return {
			...result,
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

export async function dispatchLint(
	filePath: string,
	cwd: string,
	pi: PiAgentAPI,
	baselines?: BaselineStore,
): Promise<string> {
	const ctx = createDispatchContext(filePath, cwd, pi, baselines);

	// Get runners for this file kind
	const runners = getRunnersForKind(ctx.kind);
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

	const result = await dispatchForFile(ctx, groups);
	return result.output;
}
