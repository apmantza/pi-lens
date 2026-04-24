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

		let cmd: string | null = null;
		if (hadolint.isAvailable(cwd)) {
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

		if (result.error && !result.stdout) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const output = result.stdout || "";
		const diagnostics = parseHadolintOutput(output, ctx.filePath);

		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const hasErrors = diagnostics.some((d) => d.severity === "error");
		return {
			status: "failed",
			diagnostics,
			semantic: hasErrors ? "blocking" : "warning",
		};
	},
};

export default hadolintRunner;
