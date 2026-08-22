import { safeSpawnAsync } from "../../safe-spawn.js";
import { getLinterPolicyForCwd, hasYamllintConfig } from "../../tool-policy.js";
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
import { parseToolRun } from "./utils/tool-failure.js";
import { finishParsedRun } from "./utils/tool-failure.js";

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
		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("yamllint")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}
		const hasConfig = hasYamllintConfig(cwd);
		if (!hasConfig) {
			ctx.log("yamllint: no config detected, running with default rules");
		}

		let cmd: string | null = null;
		if (await yamllint.isAvailableAsync(cwd)) {
			cmd = yamllint.getCommand(cwd);
		} else {
			cmd = await resolveToolCommandWithInstallFallback(cwd, "yamllint");
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const result = await safeSpawnAsync(cmd, ["-f", "parsable", ctx.filePath], {
			timeout: 15000,
		});

		// #1816: this runner read `result.status` zero times, so a yamllint
		// that rejected its config reported a clean YAML file.
		//
		// No exit-code table: yamllint returns 2 both for "warnings only" and
		// for an argparse usage error, so declaring 2 a rejection would discard
		// real warnings. The discriminator is the STREAM instead. `-f parsable`
		// writes findings to stdout and nothing else; stderr carries usage text
		// and tracebacks. So the gate judges "nothing to parse" on stdout alone,
		// while the parser still reads both streams.
		const raw = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		// #1948: classify on stdout as before, parse both streams as before, and
		// record when a failing run yields nothing.
		const run = parseToolRun(
			"yamllint",
			{ result, output: result.stdout },
			(out) => parseYamllintParsable(out, ctx.filePath),
			{ parseOutput: raw },
		);
		if (run.skipped) return run.skipped;

		const diagnostics = run.diagnostics;
		return finishParsedRun({
			tool: "yamllint",
			ctx,
			result,
			diagnostics,
		});
	},
};

export default yamllintRunner;
