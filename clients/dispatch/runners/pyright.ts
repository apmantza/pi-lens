/**
 * Pyright runner for dispatch system
 *
 * Provides real Python type-checking (not just linting).
 * Catches type errors like: result: str = add(1, 2)  # Type "int" not assignable to "str"
 *
 * Requires: pyright (pip install pyright or npm install -g pyright)
 */

import { ensureTool } from "../../installer/index.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";

const pyright = createAvailabilityChecker("pyright", ".exe");

const pyrightRunner: RunnerDefinition = {
	id: "pyright",
	appliesTo: ["python"],
	priority: 5, // Higher priority than ruff (10) - type errors are more important
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// When --lens-lsp is active, the `lsp` runner (priority 4) already provides
		// Pyright diagnostics via the language server — skip the CLI to avoid duplication.
		if (ctx.pi.getFlag("lens-lsp")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const cwd = ctx.cwd || process.cwd();

		// Get pyright command - try multiple strategies
		let cmd: string | null = null;

		// Strategy 1: Check cached availability (fast path)
		if (pyright.isAvailable(cwd)) {
			cmd = pyright.getCommand();
		}

		// Strategy 2: Try to find pyright via ensureTool (installs if needed)
		if (!cmd) {
			const installedPath = await ensureTool("pyright");
			if (installedPath) cmd = installedPath;
		}

		// Strategy 3: Direct PATH check (handles module cache staleness)
		if (!cmd) {
			const { findCommandAsync } = await import("../../safe-spawn.js");
			const foundCmd: string | null = await findCommandAsync("pyright");
			if (foundCmd) cmd = foundCmd;
		}

		// If still no pyright, skip this runner
		if (!cmd) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Run pyright with JSON output
		const result = await safeSpawnAsync(cmd, ["--outputjson", ctx.filePath], {
			timeout: 60000,
		});

		// Pyright returns non-zero when errors found, that's OK
		if (result.error) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const output = (result.stdout || "").trim();
		if (!output) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		try {
			const data = JSON.parse(output);
			const diagnostics = parsePyrightOutput(data, ctx.filePath);

			if (diagnostics.length === 0) {
				return { status: "succeeded", diagnostics: [], semantic: "none" };
			}

			const hasErrors = diagnostics.some((d) => d.severity === "error");

			return {
				status: hasErrors ? "failed" : "succeeded",
				diagnostics,
				semantic: hasErrors
					? "blocking"
					: diagnostics.length > 0
						? "warning"
						: "none",
			};
		} catch {
			// JSON parse error
			return {
				status: "failed",
				diagnostics: [],
				semantic: "none",
				rawOutput: output.slice(0, 500),
			};
		}
	},
};

function parsePyrightOutput(data: any, _filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	// Pyright JSON output has generalDiagnostics array
	const generalDiags = data.generalDiagnostics || [];

	for (const diag of generalDiags) {
		// Skip if not for this file (pyright may output diagnostics for imports)
		// For now, include all - caller will filter if needed

		diagnostics.push({
			id: `pyright-${diag.rule || diag.start?.line || "unknown"}`,
			message: diag.message || "Type error",
			filePath: diag.file || _filePath,
			line: diag.start?.line || 0,
			column: diag.start?.column || 0,
			severity: diag.severity === "error" ? "error" : "warning",
			semantic: diag.severity === "error" ? "blocking" : "warning",
			tool: "pyright",
			rule: diag.rule,
		});
	}

	return diagnostics;
}

export default pyrightRunner;
