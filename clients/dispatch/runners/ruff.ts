/**
 * Ruff runner for dispatch system
 *
 * Dispatch mode is diagnostics-only.
 * Autofix is handled earlier by the post-write pipeline to avoid
 * mutating files mid-dispatch after LSP sync has already happened.
 * Supports venv-local installations.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ensureTool } from "../../installer/index.js";
import { resolvePackagePath } from "../../package-root.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { stripAnsi } from "../../sanitize.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { parseRuffOutput } from "./utils/diagnostic-parsers.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";

const RUFF_PROJECT_CONFIGS = ["ruff.toml", ".ruff.toml"];

function hasProjectRuffConfig(cwd: string): boolean {
	for (const cfg of RUFF_PROJECT_CONFIGS) {
		if (fs.existsSync(path.join(cwd, cfg))) return true;
	}
	// Check pyproject.toml for [tool.ruff]
	const pyproject = path.join(cwd, "pyproject.toml");
	if (fs.existsSync(pyproject)) {
		try {
			return fs.readFileSync(pyproject, "utf-8").includes("[tool.ruff]");
		} catch {}
	}
	return false;
}

const ruff = createAvailabilityChecker("ruff", ".exe");

function parseRuffJson(raw: string, filePath: string): Diagnostic[] {
	try {
		const parsed = JSON.parse(raw) as Array<{
			code?: string;
			message?: string;
			filename?: string;
			location?: { row?: number; column?: number };
			severity?: string;
			fix?: unknown;
		}>;
		if (!Array.isArray(parsed)) return [];

		return parsed.map((item, index) => {
			const severity = item.severity === "error" ? "error" : "warning";
			const code = item.code || "ruff";
			return {
				id: `ruff-${code}-${item.location?.row ?? index + 1}`,
				message: item.message || code,
				filePath: item.filename || filePath,
				line: item.location?.row ?? 1,
				column: item.location?.column ?? 1,
				severity,
				semantic: severity === "error" ? "blocking" : "warning",
				tool: "ruff",
				rule: code,
				fixable: Boolean(item.fix),
			};
		});
	} catch {
		return [];
	}
}

const ruffRunner: RunnerDefinition = {
	id: "ruff-lint",
	appliesTo: ["python"],
	priority: PRIORITY.FORMAT_AND_LINT_PRIMARY,
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		let cmd: string | null = null;
		if (ruff.isAvailable(cwd)) {
			cmd = ruff.getCommand(cwd);
		} else {
			const installed = await ensureTool("ruff");
			if (!installed) {
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}
			cmd = installed;
		}
		if (!cmd) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const configArgs: string[] = hasProjectRuffConfig(cwd)
			? []
			: [
					"--config",
					resolvePackagePath(import.meta.url, "config/ruff/core.toml"),
				];

		// Step 1: Capture diagnostics (before fixing) — teaching signal for the agent
		const checkResult = await safeSpawnAsync(
			cmd,
			["check", "--output-format", "json", ...configArgs, ctx.filePath],
			{ timeout: 30000 },
		);

		const raw = stripAnsi(checkResult.stdout + checkResult.stderr);
		const diagnostics = parseRuffJson(checkResult.stdout || "", ctx.filePath);
		const parsedDiagnostics =
			diagnostics.length > 0 ? diagnostics : parseRuffOutput(raw, ctx.filePath);

		if (checkResult.status === 0 && parsedDiagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		if (parsedDiagnostics.length === 0) {
			return {
				status: "failed",
				diagnostics: [],
				semantic: "warning",
				rawOutput: raw.slice(0, 500),
			};
		}

		const hasErrors = parsedDiagnostics.some((d) => d.severity === "error");

		return {
			status: hasErrors ? "failed" : "succeeded",
			diagnostics: parsedDiagnostics,
			semantic: hasErrors ? "blocking" : "warning",
		};
	},
};

export default ruffRunner;
