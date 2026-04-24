import { safeSpawn } from "../../safe-spawn.js";
import { hasMarkdownlintConfig } from "../../tool-policy.js";
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

const markdownlint = createAvailabilityChecker("markdownlint-cli2", ".cmd");

// markdownlint-cli output: path/to/file.md:10:3 MD013/line-length Line length
function parseMarkdownlintOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		// Format: filePath:line[:col] ruleCode/ruleName message
		const match = line.match(/^.*?:(\d+)(?::(\d+))?\s+(MD\d+\/[\w-]+)\s+(.+)$/);
		if (!match) continue;
		const [, lineNum, col, ruleCode, message] = match;
		const ruleName = ruleCode.split("/")[0];
		diagnostics.push({
			id: `markdownlint-${lineNum}-${ruleName}`,
			message: `[${ruleCode}] ${message}`,
			filePath,
			line: Number(lineNum),
			column: col ? Number(col) : 1,
			severity: "warning",
			semantic: "warning",
			tool: "markdownlint",
			rule: ruleName,
		});
	}
	return diagnostics;
}

const markdownlintRunner: RunnerDefinition = {
	id: "markdownlint",
	appliesTo: ["markdown"],
	priority: PRIORITY.DOC_QUALITY,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		if (!hasMarkdownlintConfig(cwd)) {
			// Run with sensible defaults even without explicit config
		}

		let cmd: string | null = null;
		if (markdownlint.isAvailable(cwd)) {
			cmd = markdownlint.getCommand(cwd);
		} else {
			cmd = await resolveToolCommandWithInstallFallback(cwd, "markdownlint");
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const configArgs = hasMarkdownlintConfig(cwd) ? [] : ["--disable", "MD013"];
		const result = safeSpawn(cmd, [...configArgs, ctx.filePath], {
			timeout: 15000,
			cwd,
		});

		const raw = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		const diagnostics = parseMarkdownlintOutput(raw, ctx.filePath);
		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		return { status: "succeeded", diagnostics, semantic: "warning" };
	},
};

export default markdownlintRunner;
