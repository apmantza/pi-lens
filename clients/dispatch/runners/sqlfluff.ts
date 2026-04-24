import { safeSpawn } from "../../safe-spawn.js";
import { hasSqlfluffConfig } from "../../tool-policy.js";
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

const sqlfluff = createAvailabilityChecker("sqlfluff", ".exe");

export { hasSqlfluffConfig };

type SqlfluffJson = Array<{
	filepath?: string;
	violations?: Array<{
		code?: string;
		description?: string;
		line_no?: number;
		line_pos?: number;
	}>;
}>;

function parseSqlfluffOutput(raw: string, filePath: string): Diagnostic[] {
	if (!raw.trim()) return [];
	try {
		const parsed = JSON.parse(raw) as SqlfluffJson;
		if (!Array.isArray(parsed)) return [];

		const diagnostics: Diagnostic[] = [];
		for (const item of parsed) {
			for (const v of item.violations ?? []) {
				if (!v.description) continue;
				const code = v.code ?? "SQL";
				diagnostics.push({
					id: `sqlfluff-${v.line_no ?? 1}-${v.line_pos ?? 1}-${code}`,
					message: `[${code}] ${v.description}`,
					filePath,
					line: v.line_no ?? 1,
					column: v.line_pos ?? 1,
					severity: "warning",
					semantic: "warning",
					tool: "sqlfluff",
					rule: code,
				});
			}
		}
		return diagnostics;
	} catch {
		return [];
	}
}

const sqlfluffRunner: RunnerDefinition = {
	id: "sqlfluff",
	appliesTo: ["sql"],
	priority: PRIORITY.SQL_LINT,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const hasConfig = hasSqlfluffConfig(cwd);
		if (!hasConfig) {
			ctx.log("sqlfluff: no config detected, using ANSI dialect defaults");
		}

		let cmd: string | null = null;
		if (sqlfluff.isAvailable(cwd)) {
			cmd = sqlfluff.getCommand(cwd);
		} else {
			cmd = await resolveToolCommandWithInstallFallback(cwd, "sqlfluff");
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const args = ["lint", "--format", "json", ctx.filePath];
		if (!hasConfig) {
			args.splice(2, 0, "--dialect", "ansi");
		}

		const result = safeSpawn(cmd, args, {
			timeout: 20000,
		});

		const diagnostics = parseSqlfluffOutput(result.stdout ?? "", ctx.filePath);
		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		return {
			status: "failed",
			diagnostics,
			semantic: "warning",
		};
	},
};

export default sqlfluffRunner;
