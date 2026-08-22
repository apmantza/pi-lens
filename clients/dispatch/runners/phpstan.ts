import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { getLinterPolicyForCwd, hasPhpstanConfig } from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	createAvailabilityChecker,
	resolveVendorToolCommand,
} from "./utils/runner-helpers.js";
import type { ToolExitCodes } from "./utils/spawn-outcome.js";
import { parseToolRun } from "./utils/tool-failure.js";
import { finishParsedRun } from "./utils/tool-failure.js";

// phpstan's documented exit codes: 0 = no errors, 1 = errors found, 2 = a
// fatal/internal error that stopped the analysis. Only 1 is a run that carries
// findings.
const PHPSTAN_EXIT_CODES: ToolExitCodes = { ran: [1] };

const phpstan = createAvailabilityChecker("phpstan", ".phar");

interface PhpstanError {
	message: string;
	line: number | null;
	ignorable?: boolean;
	/** phpstan 1.10+ error identifier, e.g. "return.type". */
	identifier?: string;
}

/**
 * Real `phpstan analyse --error-format=json` output, verified against phpstan
 * 2.2.8 — see tests/fixtures/runner-output/phpstan/real.captured.json.
 *
 * `errors` is the error COUNT, a number; the findings live in `messages`. This
 * parser read `errors` as the array (#1937), so `for...of` threw on a number,
 * the catch swallowed it, and a configured phpstan project reported zero
 * findings while the CLI exited 1 — the #1933 vale shape.
 */
interface PhpstanFileErrors {
	errors: number;
	messages: PhpstanError[];
}

interface PhpstanOutput {
	files: Record<string, PhpstanFileErrors>;
	errors: string[];
}

// phpstan analyses the target file PLUS its dependency closure and keys errors
// by the real file in `output.files`. Attribute each diagnostic to that key
// (resolved against cwd) rather than blanket-stamping ctx.filePath — otherwise a
// cross-file regression is mis-located onto the edited file (#265 A3). We do NOT
// filter to the edited file: surfacing the cross-file impact is the point.
export function parsePhpstanJson(
	raw: string,
	fallbackPath: string,
	cwd: string,
): Diagnostic[] {
	try {
		const output: PhpstanOutput = JSON.parse(raw);
		const diagnostics: Diagnostic[] = [];

		for (const [file, fileErrors] of Object.entries(output.files ?? {})) {
			const filePath =
				file && file.trim()
					? path.isAbsolute(file)
						? file
						: path.resolve(cwd, file)
					: fallbackPath;
			for (const err of fileErrors?.messages ?? []) {
				diagnostics.push({
					id: `phpstan:${err.line ?? 1}:${err.message.slice(0, 40)}`,
					message: err.message,
					filePath,
					line: err.line ?? 1,
					column: 1,
					severity: "error",
					semantic: "blocking",
					tool: "phpstan",
					rule: err.identifier || "phpstan",
					fixable: false,
				});
			}
		}

		// #1937 round 2: the top-level `errors[]` array carries phpstan's
		// FILE-INDEPENDENT findings — internal errors, and ignore patterns that
		// matched nothing. A run can report `totals.errors: 1` with `files: {}`
		// and exit 1, and reading only `files` turned that into zero
		// diagnostics: the same defect class as the `errors`-vs-`messages` bug
		// above, one level up. Pinned by
		// tests/fixtures/runner-output/phpstan/top-level-errors.captured.json.
		//
		// These have no file or line, so they attach to the edited file at line
		// 1. That is the honest placement: the reader needs to see them, and
		// there is nowhere truer to put them.
		for (const message of output.errors ?? []) {
			if (typeof message !== "string" || !message.trim()) continue;
			diagnostics.push({
				id: `phpstan:global:${message.slice(0, 40)}`,
				message,
				filePath: fallbackPath,
				line: 1,
				column: 1,
				severity: "error",
				semantic: "blocking",
				tool: "phpstan",
				rule: "phpstan/analysis",
				fixable: false,
			});
		}

		return diagnostics;
	} catch {
		return [];
	}
}

async function resolvePhpstan(cwd: string): Promise<string | null> {
	if (await phpstan.isAvailableAsync(cwd)) return phpstan.getCommand(cwd);
	return resolveVendorToolCommand(cwd, "phpstan", ".bat");
}

const phpstanRunner: RunnerDefinition = {
	id: "phpstan",
	appliesTo: ["php"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("phpstan")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Only run if phpstan config present — avoids noisy defaults on unconfigured projects
		if (!hasPhpstanConfig(cwd)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const cmd = await resolvePhpstan(cwd);
		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const absPath = path.resolve(cwd, ctx.filePath);
		const result = await safeSpawnAsync(
			cmd,
			["analyse", "--error-format=json", "--no-progress", absPath],
			{ timeout: 30000, cwd },
		);

		// phpstan exits 0 = no errors, 1 = errors found, 2 = fatal. The fatal
		// case used to return `skipped` silently; routing it through the shared
		// seam keeps that verdict and adds the bounded `runner-empty-result` row
		// (#1816), and the exit-1 case now also records when the JSON report
		// parses to nothing (#1948) — the shape the error-count-as-array bug had.
		const run = parseToolRun(
			"phpstan",
			{ result, exitCodes: PHPSTAN_EXIT_CODES },
			(out) => parsePhpstanJson(out, ctx.filePath, cwd),
			{ parseOutput: result.stdout ?? "" },
		);
		if (run.skipped) return run.skipped;

		const diagnostics = run.diagnostics;
		return finishParsedRun({
			tool: "phpstan",
			ctx,
			result,
			diagnostics,
			classify: () => ({ status: "failed", semantic: "blocking" }),
		});
	},
};

export default phpstanRunner;
