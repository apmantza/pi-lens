import { toolAbsentSkip } from "./utils/runner-helpers.js";
import path from "node:path";
import { pathsEqual, toPosix } from "../../path-utils.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { resolveToolCommandWithInstallFallback } from "./utils/runner-helpers.js";
import { finishParsedRun, parseToolRun } from "./utils/tool-failure.js";

type ActionlintIssue = {
	message?: string;
	filepath?: string;
	line?: number;
	column?: number;
	kind?: string;
	snippet?: string;
	end_line?: number;
	end_column?: number;
};

export function isGitHubWorkflowFile(filePath: string): boolean {
	const normalized = toPosix(filePath);
	return /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(normalized);
}

function toDiagnostic(issue: ActionlintIssue, filePath: string): Diagnostic {
	const line = issue.line && issue.line > 0 ? issue.line : 1;
	const column = issue.column && issue.column > 0 ? issue.column : 1;
	const rule = issue.kind || "actionlint";
	const message = issue.message || "GitHub Actions workflow issue";
	const idMessage = message
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, 80);

	return {
		id: `actionlint-${rule}-${line}-${column}-${idMessage}`,
		message,
		filePath,
		line,
		column,
		severity: "error",
		semantic: "blocking",
		tool: "actionlint",
		rule,
		defectClass: "correctness",
		matchedText: issue.snippet,
	};
}

export function parseActionlintJson(
	raw: string,
	filePath: string,
	cwd: string,
): Diagnostic[] {
	const trimmed = raw.trim();
	if (!trimmed) return [];
	// #3295: actionlint resolves reusable-workflow and composite-action refs, so
	// its `filepath` is not always the workflow we asked about.
	const absTarget = path.resolve(cwd, filePath);
	const isTarget = (issue: ActionlintIssue): boolean =>
		!issue.filepath || pathsEqual(path.resolve(cwd, issue.filepath), absTarget);

	try {
		const parsed = JSON.parse(trimmed) as ActionlintIssue[] | ActionlintIssue;
		const issues = Array.isArray(parsed) ? parsed : [parsed];
		return issues.flatMap((issue) =>
			isTarget(issue) ? [toDiagnostic(issue, filePath)] : [],
		);
	} catch {
		// Some actionlint versions or wrappers may emit one JSON object per line.
		const diagnostics: Diagnostic[] = [];
		for (const line of trimmed.split(/\r?\n/)) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as ActionlintIssue;
				if (!isTarget(parsed)) continue;
				diagnostics.push(toDiagnostic(parsed, filePath));
			} catch {
				// Ignore non-JSON chatter; the caller will synthesize a generic diagnostic
				// if actionlint failed and no structured diagnostics were parsed.
			}
		}
		return diagnostics;
	}
}

const actionlintRunner: RunnerDefinition = {
	id: "actionlint",
	appliesTo: ["yaml"],
	priority: PRIORITY.YAML_LINT + 1,
	skipTestFiles: false,

	when(ctx: DispatchContext): boolean {
		return isGitHubWorkflowFile(ctx.filePath);
	},

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "actionlint");
		let cmd: string | null = null;

		cmd = await resolveToolCommandWithInstallFallback(cwd, "actionlint");

		if (!cmd) return toolAbsentSkip(cwd, { id: "actionlint" });

		const relativeFilePath = path.relative(cwd, ctx.filePath) || ctx.filePath;
		const result = await safeSpawnAsync(
			cmd,
			["-format", "{{json .}}", relativeFilePath],
			{
				cwd,
				timeout: 15000,
			},
		);

		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		const parsed = parseToolRun(
			"actionlint",
			{
				result,
				output,
				// EXIT TABLE (actionlint 1.7.7 measured fixture): 0 clean; 1 findings; 2 error; other nonzero rejected.
				exitCodes: { ran: [1, 2] },
			},
			(raw) => parseActionlintJson(raw, ctx.filePath, cwd),
		);
		if (parsed.skipped) return parsed.skipped;
		return finishParsedRun({
			tool: "actionlint",
			ctx,
			result,
			diagnostics: parsed.diagnostics,
			classify: () => ({ status: "failed", semantic: "blocking" }),
		});
	},
};

export default actionlintRunner;
