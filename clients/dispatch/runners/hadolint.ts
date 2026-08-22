import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { getLinterPolicyForCwd } from "../../tool-policy.js";
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

const hadolint = createAvailabilityChecker("hadolint", ".exe");

interface HadolintResult {
	line: number;
	code: string;
	message: string;
	column: number;
	file: string;
	level: "error" | "warning" | "info" | "style";
}

function parseHadolintOutput(raw: string, filePath: string): Diagnostic[] {
	try {
		const parsed = JSON.parse(raw) as HadolintResult[];
		if (!Array.isArray(parsed)) return [];

		return parsed.map((item) => {
			const severity = item.level === "error" ? "error" : "warning";
			return {
				id: `hadolint-${item.code}-${item.line}`,
				message: `[${item.code}] ${item.message}`,
				filePath,
				line: item.line,
				column: item.column ?? 1,
				severity,
				semantic: severity === "error" ? "blocking" : "warning",
				tool: "hadolint",
				rule: item.code,
				fixable: false,
			};
		});
	} catch {
		return [];
	}
}

const hadolintRunner: RunnerDefinition = {
	id: "hadolint",
	appliesTo: ["docker"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("hadolint")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let cmd: string | null = null;
		if (await hadolint.isAvailableAsync(cwd)) {
			cmd = hadolint.getCommand(cwd);
		} else {
			cmd = await resolveToolCommandWithInstallFallback(cwd, "hadolint");
		}

		if (!cmd) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const result = await safeSpawnAsync(
			cmd,
			["--format", "json", "--no-fail", path.resolve(cwd, ctx.filePath)],
			{ cwd },
		);

		// #1948: hadolint runs with `--no-fail`, so it exits 0 even when it finds
		// something. A nonzero exit therefore means hadolint itself failed, and
		// zero parsed diagnostics out of whatever it printed is a parser break.
		const run = parseToolRun("hadolint", { result }, (out) =>
			parseHadolintOutput(out, ctx.filePath),
		);
		if (run.skipped) return run.skipped;

		const diagnostics = run.diagnostics;
		return finishParsedRun({
			tool: "hadolint",
			ctx,
			result,
			diagnostics,
			classify: (diagnostics) => {
				const hasErrors = diagnostics.some((d) => d.severity === "error");
				return {
					status: "failed",
					semantic: hasErrors ? "blocking" : "warning",
				};
			},
		});
	},
};

export default hadolintRunner;
