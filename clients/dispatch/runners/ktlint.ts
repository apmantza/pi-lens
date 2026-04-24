import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	createAvailabilityChecker,
	resolveToolCommandWithInstallFallback,
} from "./utils/runner-helpers.js";

const ktlint = createAvailabilityChecker("ktlint", ".exe");

interface KtlintError {
	line: number;
	col: number;
	detail: string;
	ruleId: string;
}

interface KtlintResult {
	file?: string;
	errors: KtlintError[];
}

function normalizeKtlintResults(parsed: unknown): KtlintResult[] | null {
	if (Array.isArray(parsed)) {
		return parsed as KtlintResult[];
	}
	if (
		parsed &&
		typeof parsed === "object" &&
		Array.isArray((parsed as KtlintResult).errors)
	) {
		return [parsed as KtlintResult];
	}
	return null;
}

function parseKtlintOutput(raw: string, filePath: string): Diagnostic[] | null {
	try {
		const parsed = normalizeKtlintResults(JSON.parse(raw));
		if (!parsed) return null;

		const diagnostics: Diagnostic[] = [];
		for (const result of parsed) {
			for (const err of result.errors ?? []) {
				diagnostics.push({
					id: `ktlint-${err.ruleId}-${err.line}-${err.col}`,
					message: `[${err.ruleId}] ${err.detail}`,
					filePath,
					line: err.line,
					column: err.col,
					severity: "warning",
					semantic: "warning",
					tool: "ktlint",
					rule: err.ruleId,
					fixable: true,
				});
			}
		}
		return diagnostics;
	} catch {
		return null;
	}
}

function firstOutputLine(result: { stdout?: string; stderr?: string }): string {
	return (result.stderr || result.stdout || "")
		.trim()
		.split(/\r?\n/, 1)[0]
		.slice(0, 200);
}

const ktlintRunner: RunnerDefinition = {
	id: "ktlint",
	appliesTo: ["kotlin"],
	priority: PRIORITY.FORMAT_AND_LINT_PRIMARY,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();

		let cmd: string | null = null;
		if (ktlint.isAvailable(cwd)) {
			cmd = ktlint.getCommand(cwd);
		} else {
			cmd = await resolveToolCommandWithInstallFallback(cwd, "ktlint");
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const absPath = path.resolve(cwd, ctx.filePath);
		const result = await safeSpawnAsync(cmd, ["--reporter=json", absPath], {
			cwd,
			timeout: 30000,
		});

		// Ktlint exits non-zero when issues are found, so only treat a total lack
		// of output as a hard skip. Any non-empty but unparseable output should
		// surface as runner failure instead of a false clean result.
		if (result.error && !result.stdout) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const diagnostics = parseKtlintOutput(result.stdout || "", ctx.filePath);
		if (diagnostics === null) {
			const detail = firstOutputLine(result) || "Unknown ktlint output";
			return {
				status: "failed",
				diagnostics: [
					{
						id: "ktlint-output-unparseable",
						message: `Unable to parse ktlint output: ${detail}`,
						filePath: ctx.filePath,
						severity: "warning",
						semantic: "warning",
						tool: "ktlint",
						fixable: false,
					},
				],
				semantic: "warning",
			};
		}
		if (diagnostics.length === 0) {
			if (result.status && result.status !== 0) {
				return {
					status: "failed",
					diagnostics: [
						{
							id: "ktlint-nonzero-no-diagnostics",
							message:
								firstOutputLine(result) ||
								"ktlint exited non-zero without JSON diagnostics",
							filePath: ctx.filePath,
							severity: "warning",
							semantic: "warning",
							tool: "ktlint",
							fixable: false,
						},
					],
					semantic: "warning",
				};
			}
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		return {
			status: result.status && result.status !== 0 ? "failed" : "succeeded",
			diagnostics,
			semantic: "warning",
		};
	},
};

export default ktlintRunner;
