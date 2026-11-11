import { toolAbsentSkip } from "./utils/runner-helpers.js";
import { skipped } from "../types.js";
import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import { hasToolConfig } from "../../tool-config-presence.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { PRIORITY } from "../priorities.js";
import { finishParsedRun, parseToolRun } from "./utils/tool-failure.js";
import { createCwdCachedProbe } from "./utils/runner-helpers.js";

const CREDO_PROBE_BUDGET_MS = 10_000;

// Per-cwd cached `mix credo --version` probe (#120), governed by the shared
// availability policy (#1494). The probe returns the spawn result so the policy
// can tell a cold-BEAM timeout from a genuinely absent credo: the 10 s budget
// here is the widest in the repo and the most likely to expire on a slow first
// compile, and latching that as "not installed" used to disable credo for the
// rest of the session.
const probeCredo = createCwdCachedProbe(
	(cwd) =>
		safeSpawnAsync("mix", ["credo", "--version"], {
			timeout: CREDO_PROBE_BUDGET_MS,
			cwd,
		}),
	{ tool: "credo", budgetMs: CREDO_PROBE_BUDGET_MS },
);

interface CredoIssue {
	filename: string;
	line_no: number;
	column: number | null;
	message: string;
	category: string;
	check: string;
	priority: number;
}

interface CredoOutput {
	issues: CredoIssue[];
}

// `mix credo <file>` is single-file-scoped today, so blanket attribution would
// be correct — but map issue.filename (resolved against cwd) for robustness so
// this stays correct if the invocation ever widens to a directory (#265 A4).
export function parseCredoJson(
	raw: string,
	fallbackPath: string,
	cwd: string,
): Diagnostic[] {
	try {
		const output: CredoOutput = JSON.parse(raw);
		return (output.issues ?? []).map((issue) => ({
			id: `credo:${issue.check}:${issue.line_no}`,
			message: `[${issue.check}] ${issue.message}`,
			filePath:
				issue.filename && issue.filename.trim()
					? path.isAbsolute(issue.filename)
						? issue.filename
						: path.resolve(cwd, issue.filename)
					: fallbackPath,
			line: issue.line_no,
			column: issue.column ?? 1,
			severity:
				issue.priority <= 10 ? ("error" as const) : ("warning" as const),
			semantic:
				issue.priority <= 10 ? ("blocking" as const) : ("warning" as const),
			tool: "credo",
			rule: issue.check,
			fixable: false,
		}));
	} catch {
		return [];
	}
}

const credoRunner: RunnerDefinition = {
	id: "credo",
	appliesTo: ["elixir"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	skipTestFiles: false,
	// mix never walks up, so the seam answers for `cwd` alone.
	requiresConfig: (cwd) => hasToolConfig("mix", cwd),

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "credo");

		if (!credoRunner.requiresConfig?.(cwd)) {
			return skipped("not-configured");
		}

		// Credo ships as a mix dependency — cached per-cwd probe (see probeCredo).
		if (!(await probeCredo(cwd))) {
			return toolAbsentSkip(cwd, { checker: probeCredo });
		}

		const absPath = path.resolve(cwd, ctx.filePath);
		const result = await safeSpawnAsync(
			"mix",
			["credo", "--format", "json", "--strict", absPath],
			{ timeout: 30000, cwd },
		);

		const parsed = parseToolRun(
			"credo",
			{
				result,
				// EXIT TABLE (Credo 1.7 measured fixture): 0 clean; 1 findings; 2 error; other nonzero rejected.
				exitCodes: { ran: [1, 2] },
			},
			(raw) => parseCredoJson(raw, ctx.filePath, cwd),
			{ parseStreams: "stdout-else-stderr" },
		);
		if (parsed.skipped) return parsed.skipped;
		return finishParsedRun({
			tool: "credo",
			ctx,
			result,
			diagnostics: parsed.diagnostics,
		});
	},
};

export default credoRunner;
