/**
 * ESLint runner for dispatch system
 *
 * Runs ESLint on JS/TS files when an ESLint config is present in the project.
 * Prefers the local node_modules installation over global.
 *
 * Gate: skips when no ESLint config is detected (project uses Biome/OxLint instead).
 */

import { safeSpawnAsync } from "../../safe-spawn.js";
import { hasEslintConfig } from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { resolveToolCommand } from "./utils/runner-helpers.js";

interface EslintMessage {
	ruleId: string | null;
	severity: 1 | 2;
	message: string;
	line: number;
	column: number;
	fix?: unknown;
}

interface EslintFileResult {
	filePath: string;
	messages: EslintMessage[];
}

function parseEslintJson(
	raw: string,
	filePath: string,
): { diagnostics: Diagnostic[]; parseError?: string } {
	try {
		const results: EslintFileResult[] = JSON.parse(raw);
		const diagnostics: Diagnostic[] = [];

		for (const fileResult of results) {
			for (const msg of fileResult.messages) {
				const severity = msg.severity === 2 ? "error" : "warning";
				diagnostics.push({
					id: `eslint:${msg.ruleId ?? "unknown"}:${msg.line}`,
					message: msg.ruleId ? `${msg.ruleId}: ${msg.message}` : msg.message,
					filePath,
					line: msg.line ?? 1,
					column: msg.column ?? 1,
					severity,
					semantic: severity === "error" ? "blocking" : "warning",
					tool: "eslint",
					rule: msg.ruleId ?? undefined,
					fixable: !!msg.fix,
				});
			}
		}

		return { diagnostics };
	} catch (err) {
		return {
			diagnostics: [],
			parseError: err instanceof Error ? err.message : String(err),
		};
	}
}

const eslintRunner: RunnerDefinition = {
	id: "eslint",
	appliesTo: ["jsts"],
	priority: PRIORITY.LINT_SECONDARY,
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const userHasConfig = hasEslintConfig(cwd);

		// Only run if project has an ESLint config.
		if (!userHasConfig) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const cmd = resolveToolCommand(cwd, "eslint") ?? "eslint";

		// Verify ESLint is actually executable
		const versionCheck = await safeSpawnAsync(cmd, ["--version"], {
			timeout: 5000,
			cwd,
		});
		if (versionCheck.error || versionCheck.status !== 0) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const result = await safeSpawnAsync(
			cmd,
			["--format", "json", "--no-error-on-unmatched-pattern", ctx.filePath],
			{ timeout: 30000, cwd },
		);

		// ESLint exits 1 when there are lint errors, 2 on fatal/config error
		if (result.status === 2) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const raw = result.stdout || result.stderr || "";

		if (result.status === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const parsed = parseEslintJson(raw, ctx.filePath);
		if (parsed.parseError && raw.trim().length > 0) {
			const preview = raw.replace(/\s+/g, " ").slice(0, 160);
			return {
				status: "failed",
				diagnostics: [
					{
						id: "eslint:parse-error:1",
						message: `ESLint JSON parse failed: ${parsed.parseError}${preview ? ` (output preview: ${preview})` : ""}`,
						filePath: ctx.filePath,
						line: 1,
						column: 1,
						severity: "warning",
						semantic: "warning",
						tool: "eslint",
					},
				],
				semantic: "warning",
			};
		}

		const diagnostics = parsed.diagnostics;
		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const hasErrors = diagnostics.some((d) => d.semantic === "blocking");
		return {
			status: "failed",
			diagnostics,
			semantic: hasErrors ? "blocking" : "warning",
		};
	},
};

export default eslintRunner;
