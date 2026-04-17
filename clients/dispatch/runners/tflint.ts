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

const tflint = createAvailabilityChecker("tflint", ".exe");

interface TflintIssue {
	rule: { name: string; severity: string };
	message: string;
	range: {
		filename: string;
		start: { line: number; column: number };
	};
}

interface TflintOutput {
	issues: TflintIssue[];
	errors: Array<{ message: string }>;
}

function parseTflintOutput(raw: string, filePath: string): Diagnostic[] {
	try {
		const parsed = JSON.parse(raw) as TflintOutput;
		const issues = parsed.issues ?? [];

		return issues.map((issue) => {
			const severity = issue.rule.severity === "error" ? "error" : "warning";
			return {
				id: `tflint-${issue.rule.name}-${issue.range.start.line}`,
				message: `[${issue.rule.name}] ${issue.message}`,
				filePath,
				line: issue.range.start.line,
				column: issue.range.start.column,
				severity,
				semantic: severity === "error" ? "blocking" : "warning",
				tool: "tflint",
				rule: issue.rule.name,
				fixable: false,
			};
		});
	} catch {
		return [];
	}
}

const tflintRunner: RunnerDefinition = {
	id: "tflint",
	appliesTo: ["terraform"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();

		let cmd: string | null = null;
		if (tflint.isAvailable(cwd)) {
			cmd = tflint.getCommand(cwd);
		} else {
			const managed = await ensureTool("tflint");
			if (managed) cmd = managed;
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const absPath = path.resolve(cwd, ctx.filePath);
		const result = await safeSpawnAsync(
			cmd,
			["--format=json", "--no-color", `--filter=${path.basename(absPath)}`],
			{ cwd, timeout: 30000 },
		);

		if (result.error && !result.stdout) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const diagnostics = parseTflintOutput(result.stdout || "", ctx.filePath);
		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const hasErrors = diagnostics.some((d) => d.severity === "error");
		return {
			status: hasErrors ? "failed" : "succeeded",
			diagnostics,
			semantic: hasErrors ? "blocking" : "warning",
		};
	},
};

export default tflintRunner;
