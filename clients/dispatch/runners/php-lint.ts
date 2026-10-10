import * as path from "node:path";
import { pathsEqual } from "../../path-utils.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";
import { finishParsedRun, parseToolRun } from "./utils/tool-failure.js";

// PHP's `-l` exit contract, declared HERE rather than in the shared classifier
// (#3291 r3): an admission is a property of this tool. The manual documents
// `-l` as syntax-check-only with a nonzero return on failure; the captured
// PHP 8.3.32 wire exits 1 in the usual CLI path and 255 (the shell reading of
// PHP's documented -1) for the parse-error wire. Both are completed analyses
// whose output must reach the parser; any other nonzero status stays a
// rejected invocation.
const PHP_LINT_EXIT_CODES = { ran: [1, 255] } as const;

const php = createAvailabilityChecker("php", ".exe");
// #4242: an adopted root never runs a project-local interpreter, whatever the
// session trust. This checker skips the project-local `.venv` rung, so a
// `<adoptedRoot>/.venv/bin/php` is neither probed nor executed.
const phpAdoptedRoot = createAvailabilityChecker("php", ".exe", ["--version"], {
	allowProjectLocal: false,
});

function parsePhpLintOutput(
	raw: string,
	filePath: string,
	cwd: string,
): Diagnostic[] {
	const output = raw.trim();
	if (!output || !/(?:PHP )?Parse error:/i.test(output)) return [];

	const lineMatch = output.match(/on line (\d+)/i);
	const messageMatch =
		output.match(
			/PHP Parse error:\s*(.+?)(?:\s+in\s+(.+?)\s+on line \d+)?$/im,
		) ??
		output.match(/Parse error:\s*(.+?)(?:\s+in\s+(.+?)\s+on line \d+)?$/im);
	// #3295: PHP names the file it could not parse in the same sentence. `php -l`
	// follows no includes today, so this drops nothing under our argv — it pins
	// the attribution the parser was asserting without asking.
	const reported = messageMatch?.[2]?.trim();
	if (
		reported &&
		!pathsEqual(path.resolve(cwd, reported), path.resolve(cwd, filePath))
	)
		return [];

	return [
		{
			id: `php-lint:${lineMatch?.[1] ?? "1"}`,
			message: messageMatch?.[1]?.trim() ?? output,
			filePath,
			line: lineMatch ? Number.parseInt(lineMatch[1], 10) : 1,
			column: 1,
			severity: "error",
			semantic: "blocking",
			tool: "php-lint",
			rule: "syntax",
			fixable: false,
		},
	];
}

const phpLintRunner: RunnerDefinition = {
	id: "php-lint",
	appliesTo: ["php"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "php-lint");
		const checker = ctx.analysisRootMode === "adopted" ? phpAdoptedRoot : php;
		if (!(await checker.isAvailableAsync(cwd))) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const cmd = checker.getCommand(cwd);
		if (!cmd) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const absPath = path.resolve(cwd, ctx.filePath);
		const result = await safeSpawnAsync(cmd, ["-l", absPath], {
			timeout: 15000,
			cwd,
		});
		// `output` is what the classifier judges AND what the parser reads: the
		// parse error arrives on stderr, so both streams are one wire here. The
		// exit table rides in this same per-runner input, never in a shared
		// option (#3291 r3).
		const run = parseToolRun<Diagnostic>(
			"php-lint",
			{
				result,
				output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
				exitCodes: PHP_LINT_EXIT_CODES,
			},
			(output) => parsePhpLintOutput(output, ctx.filePath, cwd),
		);
		if (run.skipped) return run.skipped;
		return finishParsedRun({
			tool: "php-lint",
			ctx,
			result,
			diagnostics: run.diagnostics,
			classify: () => ({ status: "failed", semantic: "blocking" }),
		});
	},
};

export default phpLintRunner;
