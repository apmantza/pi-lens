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
import { getIsolatedNpxSpawnOptions } from "../../tool-probe.js";
import { finishParsedRun } from "./utils/tool-failure.js";

/**
 * The trailer of prisma's own validation report, measured on prisma 6.16.2:
 * every schema-error run ends with `Validation Error Count: N` (#3781).
 * Measured on prisma 4.16.2, 5.22.0, 6.16.2 and 7.10.0 (stderr; the runner joins both streams).
 */
const PRISMA_VALIDATION_REPORT = /\bValidation Error Count:\s*\d+/;

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
			{
				timeout: 20000,
				// ONE neutral-cwd seam for npx fallbacks (#4193, #4268 acceptance 3),
				// an override of the resolver's project cwd that the scan can still see.
				cwd,
				...(resolved.cmd === "npx" ? getIsolatedNpxSpawnOptions() : {}),
			},
		);

		if (result.error && !result.stdout && !result.stderr) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		if (result.status === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
		const diagnostics = parsePrismaValidateOutput(output, ctx.filePath);
		if (diagnostics.length === 0) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		return finishParsedRun({
			tool: "prisma-validate",
			ctx,
			result,
			// #3781: only prisma's own validation report is findings. Any other
			// nonzero output (npm's E404 when `npx --no prisma` has nothing to
			// run) is a tool that never validated, and goes to the shared
			// parse-error arm instead of becoming a blocking "schema" finding.
			diagnostics: PRISMA_VALIDATION_REPORT.test(output) ? diagnostics : [],
			classify: () => ({ status: "failed", semantic: "blocking" }),
		});
	},
};

export default prismaValidateRunner;
