import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { resolveLocalFirstAsync } from "./utils/runner-helpers.js";

function parsePrismaValidateOutput(
	raw: string,
	filePath: string,
): Diagnostic[] {
	const output = raw
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((line) => !line.startsWith("Environment variables loaded"))
		.filter((line) => !line.startsWith("Prisma schema loaded"))
		.join(" ");

	if (!output) return [];

	const message =
		output.match(/Error:\s*(.+)$/i)?.[1]?.trim() ??
		output.match(/Validation Error Count:\s*\d+\s*(.+)$/i)?.[1]?.trim() ??
		output;
	const lineMatch = output.match(/:(\d+)(?::\d+)?\b/);

	return [
		{
			id: `prisma-validate:${lineMatch?.[1] ?? "1"}`,
			message,
			filePath,
			line: lineMatch ? Number.parseInt(lineMatch[1], 10) : 1,
			column: 1,
			severity: "error",
			semantic: "blocking",
			tool: "prisma-validate",
			rule: "schema",
			fixable: false,
		},
	];
}

const prismaValidateRunner: RunnerDefinition = {
	id: "prisma-validate",
	appliesTo: ["prisma"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "prisma-validate");
		const resolved = await resolveLocalFirstAsync("prisma", cwd);
		const absPath = path.resolve(cwd, ctx.filePath);
		const result = await safeSpawnAsync(
			resolved.cmd,
			[...resolved.args, "validate", "--schema", absPath],
			{ timeout: 20000, cwd },
		);

		if (result.error && !result.stdout && !result.stderr) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		if (result.status === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const diagnostics = parsePrismaValidateOutput(
			`${result.stdout ?? ""}\n${result.stderr ?? ""}`,
			ctx.filePath,
		);
		if (diagnostics.length === 0) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		return {
			status: "failed",
			diagnostics,
			semantic: "blocking",
		};
	},
};

export default prismaValidateRunner;
