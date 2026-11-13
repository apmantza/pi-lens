import { toolAbsentSkip } from "./utils/runner-helpers.js";
import { skipped } from "../types.js";
import { hasToolConfig } from "../../tool-config-presence.js";
import * as path from "node:path";
import { pathsEqual, relativeInside } from "../../path-utils.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { logRunnerAdvisoryOnce } from "../../tool-cwd.js";
import { getLinterPolicyForCwd } from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	resolveRunnerCwd,
	resolveToolCommandWithInstallFallback,
} from "./utils/runner-helpers.js";
import { parseToolRun } from "./utils/tool-failure.js";
import { finishParsedRun } from "./utils/tool-failure.js";
import { semanticFor } from "../types.js";

function parseYamllintParsable(
	raw: string,
	filePath: string,
	cwd: string,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const absTarget = path.resolve(cwd, filePath);
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const match = line.match(
			/^(.*?):(\d+):(\d+):\s*\[(error|warning)\]\s*(.*?)\s*\(([^)]+)\)\s*$/i,
		);
		if (!match) continue;
		if (!pathsEqual(path.resolve(cwd, match[1]!), absTarget)) continue;

		const severity = match[4]!.toLowerCase() === "error" ? "error" : "warning";
		diagnostics.push({
			id: `yamllint-${match[2]}-${match[3]}-${match[6]}`,
			message: `[${match[6]}] ${match[5]}`,
			filePath,
			line: Number(match[2]),
			column: Number(match[3]),
			severity,
			semantic: semanticFor(severity),
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
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "yamllint");
		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("yamllint")) {
			return skipped("not-preferred");
		}
		const hasConfig = hasToolConfig("yamllint", cwd);
		if (!hasConfig) {
			logRunnerAdvisoryOnce(
				ctx,
				"yamllint",
				cwd,
				"yamllint: no config detected, running with default rules",
			);
		}

		const cmd = await resolveToolCommandWithInstallFallback(cwd, "yamllint");

		if (!cmd) return toolAbsentSkip(cwd, { id: "yamllint" });

		// #5544: the CLI matches its config's `ignore` globs against the path string
		// it is handed, so an absolute argument lets a glob that names an ANCESTOR of
		// the file exclude the file from its own lint — a lane under
		// `<scratch>/.claude/worktrees/lane1` with a `.yamllint` of `ignore: .claude/`
		// answered "no files selected", exit 0, and the runner reported a silent
		// clean. The spawn cwd is the project, so the argument is the
		// project-relative path, actionlint's form
		// (clients/dispatch/runners/actionlint.ts); a dispatched file outside the
		// project keeps today's absolute form, as it has no project-relative spelling.
		const targetRel = relativeInside(cwd, ctx.filePath) ?? ctx.filePath;

		// #5544 round 2: the `--` is the price of a relative argument. A root-level
		// file named `-a.yml` reached argparse as an unknown option, so yamllint
		// answered `one of the arguments FILE_OR_DIR - is required` and exited 2 — a
		// visible skipped run, never the file's findings. The option terminator makes
		// argparse stop reading flags, and it is inert for every ordinary name.
		// (Probed: `yamllint -f parsable -a.yml` exit 2, no lint; `-- -a.yml` reports
		// document-start and trailing-spaces.)
		const result = await safeSpawnAsync(
			cmd,
			["-f", "parsable", "--", targetRel],
			{
				cwd,
				timeout: 15000,
			},
		);

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
			{
				result,
				output: result.stdout,
				// EXIT TABLE (yamllint 1.35 docs https://yamllint.readthedocs.io/en/stable/): 0 clean; 1 findings; 2 error; other nonzero rejected.
				exitCodes: { ran: [1, 2] },
			},
			// ADR 0009: the finding is attributed to the dispatched path; the parser
			// resolves the tool's project-relative report against the spawn cwd.
			(out) => parseYamllintParsable(out, ctx.filePath, cwd),
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
