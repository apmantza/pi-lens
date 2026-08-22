import { safeSpawnAsync } from "../../safe-spawn.js";
import { getLinterPolicyForCwd, hasSqlfluffConfig } from "../../tool-policy.js";
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
import type { ToolExitCodes } from "./utils/spawn-outcome.js";
import { parseToolRun } from "./utils/tool-failure.js";
import { finishParsedRun } from "./utils/tool-failure.js";

const sqlfluff = createAvailabilityChecker("sqlfluff", ".exe");

// sqlfluff exit codes (its CLI docs): 0 = clean, 1 = violations found, 2 = a
// user error that stopped the lint (unknown dialect, unreadable config).
// Only 2 is a rejected invocation.
//
// The exit TABLE is what protects this runner, not the nothing-to-parse rule:
// sqlfluff writes its user errors to STDOUT, not stderr (live: an unknown
// dialect prints the error there), so stdout is non-empty and the fallback
// rule would read the failed run as a run that found nothing.
const SQLFLUFF_EXIT_CODES: ToolExitCodes = { ran: [1] };

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

// sqlfluff's JSON lint output does not carry a per-violation fixable flag —
// `sqlfluff fix` is a separate command and the lint surface doesn't tell us
// which violations its `--fix` would resolve. Mirror the stylelint /
// markdownlint pattern from commit 9c8db1b: maintain a curated set of rule
// codes whose `fix` is deterministic and safe, sourced from sqlfluff's docs
// pages that document each rule as "Auto-fix: yes" with a deterministic
// rewrite. Update when sqlfluff adds or removes fixable rules.
//
// Scope: layout / capitalisation / safe-convention / alias-formatting /
// reference-formatting rules whose fixes don't change query semantics.
// Excluded: ambiguity rules (AM01..), structural rules whose fix may
// change query plan (ST05, ST07..), and CV05 (which can flip null
// comparisons in ways that change result sets).
const SQLFLUFF_FIXABLE_RULES = new Set<string>([
	// Layout — pure formatting
	"LT01",
	"LT02",
	"LT03",
	"LT04",
	"LT05",
	"LT06",
	"LT07",
	"LT08",
	"LT09",
	"LT10",
	"LT11",
	"LT12",
	"LT13",
	// Capitalisation — pure formatting
	"CP01",
	"CP02",
	"CP03",
	"CP04",
	"CP05",
	// Aliasing — safe formatting / unused-alias removal
	"AL01",
	"AL05",
	"AL06",
	"AL07",
	"AL08",
	"AL09",
	// Convention — safe formatting / equivalent rewrites
	"CV01",
	"CV02",
	"CV06",
	"CV07",
	"CV10",
	"CV11",
	// References — quoting / qualifier formatting
	"RF02",
	"RF04",
	"RF05",
	"RF06",
	// Structure — only deterministic-safe simplifications
	"ST01",
	"ST02",
]);

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
				const fixable = SQLFLUFF_FIXABLE_RULES.has(code);
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
					fixable,
					fixSuggestion: fixable
						? "Run `sqlfluff fix` to apply the deterministic auto-correction for this rule."
						: undefined,
				});
			}
		}
		return diagnostics;
	} catch {
		return [];
	}
}

// Exported for the parser unit tests (#112 sqlfluff slice).
export { parseSqlfluffOutput };

const sqlfluffRunner: RunnerDefinition = {
	id: "sqlfluff",
	appliesTo: ["sql"],
	priority: PRIORITY.SQL_LINT,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("sqlfluff")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}
		const hasConfig = hasSqlfluffConfig(cwd);
		if (!hasConfig) {
			ctx.log("sqlfluff: no config detected, using ANSI dialect defaults");
		}

		let cmd: string | null = null;
		if (await sqlfluff.isAvailableAsync(cwd)) {
			cmd = sqlfluff.getCommand(cwd);
		} else {
			cmd = await resolveToolCommandWithInstallFallback(cwd, "sqlfluff");
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		// #1937: this used to be `args.splice(2, 0, "--dialect", "ansi")` on
		// `["lint", "--format", "json", file]`, which inserts BETWEEN the flag
		// and its value and yields `lint --format --dialect ansi json file`.
		// sqlfluff rejects `--dialect` as the value of `--format` and exits 2,
		// so every SQL project WITHOUT a .sqlfluff — exactly the case this
		// dialect default exists to serve — was never linted. Built in order
		// rather than patched by index, and pinned by the argv-tie assertion
		// in runners/captured-real-output.test.ts.
		const args = ["lint", "--format", "json"];
		if (!hasConfig) {
			args.push("--dialect", "ansi");
		}
		args.push(ctx.filePath);

		const result = await safeSpawnAsync(cmd, args, {
			timeout: 20000,
			cwd,
		});

		// #1816: this runner read `result.status` zero times, so a user error
		// fell through `parseSqlfluffOutput`'s JSON catch to zero violations and
		// reported the SQL file as clean.
		// #1948: sqlfluff exit 1 with a JSON report we read nothing out of is a
		// parser break, not a clean file.
		const run = parseToolRun(
			"sqlfluff",
			{ result, exitCodes: SQLFLUFF_EXIT_CODES },
			(out) => parseSqlfluffOutput(out, ctx.filePath),
			{ parseOutput: result.stdout ?? "" },
		);
		if (run.skipped) return run.skipped;

		const diagnostics = run.diagnostics;
		return finishParsedRun({
			tool: "sqlfluff",
			ctx,
			result,
			diagnostics,
			classify: () => ({ status: "failed", semantic: "warning" }),
		});
	},
};

export default sqlfluffRunner;
