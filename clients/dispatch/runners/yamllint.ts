import { safeSpawn } from "../../safe-spawn.js";
import { hasYamllintConfig } from "../../tool-policy.js";
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

const yamllint = createAvailabilityChecker("yamllint", ".exe");

export { hasYamllintConfig };

function parseYamllintParsable(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const match = line.match(
			/^(.*?):(\d+):(\d+):\s*\[(error|warning)\]\s*(.*?)\s*\(([^)]+)\)\s*$/i,
		);
		if (!match) continue;

		const severity = match[4].toLowerCase() === "error" ? "error" : "warning";
		diagnostics.push({
			id: `yamllint-${match[2]}-${match[3]}-${match[6]}`,
			message: `[${match[6]}] ${match[5]}`,
			filePath,
			line: Number(match[2]),
			column: Number(match[3]),
			severity,
			semantic: severity === "error" ? "blocking" : "warning",
			tool: "yamllint",
			rule: match[6],
		});
	}
	return diagnostics;
}

const yamllintRunner: RunnerDefinition = {
	id: "yamllint",
	appliesTo: ["yaml"],
	priority: PRIORITY.YAML_LINT,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const hasConfig = hasYamllintConfig(cwd);
		if (!hasConfig) {
			ctx.log("yamllint: no config detected, running with default rules");
		}

		let cmd: string | null = null;
		if (yamllint.isAvailable(cwd)) {
			cmd = yamllint.getCommand(cwd);
		} else {
			cmd = await resolveToolCommandWithInstallFallback(cwd, "yamllint");
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const result = safeSpawn(cmd, ["-f", "parsable", ctx.filePath], {
			timeout: 15000,
		});

		const diagnostics = parseYamllintParsable(
			`${result.stdout ?? ""}${result.stderr ?? ""}`,
			ctx.filePath,
		);
		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const hasBlocking = diagnostics.some((d) => d.semantic === "blocking");
		return {
			status: hasBlocking ? "failed" : "succeeded",
			diagnostics,
			semantic: hasBlocking ? "blocking" : "warning",
		};
	},
};

export default yamllintRunner;
