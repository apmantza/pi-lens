import * as path from "node:path";
import { ensureTool } from "../../installer/index.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { PRIORITY } from "../priorities.js";

const ktlint = createAvailabilityChecker("ktlint", ".exe");

interface KtlintError {
	line: number;
	col: number;
	detail: string;
	ruleId: string;
}

interface KtlintResult {
	file: string;
	errors: KtlintError[];
}

function parseKtlintOutput(raw: string, filePath: string): Diagnostic[] {
	try {
		const parsed = JSON.parse(raw) as KtlintResult[];
		if (!Array.isArray(parsed)) return [];

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
		return [];
	}
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
			const managed = await ensureTool("ktlint");
			if (managed) cmd = managed;
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const absPath = path.resolve(cwd, ctx.filePath);
		const result = await safeSpawnAsync(
			cmd,
			["--reporter=json", absPath],
			{ cwd, timeout: 30000 },
		);

		// ktlint exits non-zero when issues found — that's expected
		if (result.error && !result.stdout) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const diagnostics = parseKtlintOutput(result.stdout || "", ctx.filePath);
		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		return { status: "succeeded", diagnostics, semantic: "warning" };
	},
};

export default ktlintRunner;
