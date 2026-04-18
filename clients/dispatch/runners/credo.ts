import * as path from "node:path";
import * as fs from "node:fs";
import { safeSpawnAsync } from "../../safe-spawn.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { PRIORITY } from "../priorities.js";

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

function parseCredoJson(raw: string, filePath: string): Diagnostic[] {
	try {
		const output: CredoOutput = JSON.parse(raw);
		return (output.issues ?? []).map((issue) => ({
			id: `credo:${issue.check}:${issue.line_no}`,
			message: `[${issue.check}] ${issue.message}`,
			filePath,
			line: issue.line_no,
			column: issue.column ?? 1,
			severity: issue.priority <= 10 ? ("error" as const) : ("warning" as const),
			semantic: issue.priority <= 10 ? ("blocking" as const) : ("warning" as const),
			tool: "credo",
			rule: issue.check,
			fixable: false,
		}));
	} catch {
		return [];
	}
}

function hasMixExs(cwd: string): boolean {
	return fs.existsSync(path.join(cwd, "mix.exs"));
}

const credoRunner: RunnerDefinition = {
	id: "credo",
	appliesTo: ["elixir"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();

		if (!hasMixExs(cwd)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Credo ships as a mix dependency — check it's available
		const check = await safeSpawnAsync("mix", ["credo", "--version"], {
			timeout: 10000,
			cwd,
		});
		if (check.error || check.status !== 0) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const absPath = path.resolve(cwd, ctx.filePath);
		const result = await safeSpawnAsync(
			"mix",
			["credo", "--format", "json", "--strict", absPath],
			{ timeout: 30000, cwd },
		);

		// credo exits 1 when issues found, 0 when clean
		if (result.status === null || result.status > 1) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const diagnostics = parseCredoJson(result.stdout ?? "", ctx.filePath);
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

export default credoRunner;
