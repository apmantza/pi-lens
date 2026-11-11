import { toolAbsentSkip } from "./utils/runner-helpers.js";
import { resolve } from "node:path";
import { pathsEqual } from "../../path-utils.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import { recordDegradationOnce } from "../../degradation-ledger.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { findingsResult } from "../types.js";
import {
	createAvailabilityChecker,
	resolveAdoptedRootCommand,
} from "./utils/runner-helpers.js";
import { parseToolRun, skipUnlessToolRan } from "./utils/tool-failure.js";

// fish_indent ships with fish — not separately installable, no managed fallback
const fishIndent = createAvailabilityChecker("fish_indent");
// `fish --no-execute` is the only fish tool that reports a syntax error:
// fish_indent --check exits 0 on an unterminated quote and on a missing `end`
// in a formatted file (#4454). It is the same install, so it is a second argv
// of this runner rather than a second runner.
const fish = createAvailabilityChecker("fish");

// The subject of the `runner-empty-result` / `runner-parsed-nothing` rows the
// syntax step leaves when it ran but could not decide.
const SYNTAX_STEP = "fish-syntax-check";

/**
 * `fish --no-execute` header: `<file> (line N): <message>`, the file as spelled
 * in argv. Source excerpts and the `warning: Error while reading file` trailer
 * follow it and are ignored; only the first matching header counts. A header naming another file is not ours to report.
 */
function parseSyntaxErrors(
	output: string,
	filePath: string,
	cwd: string,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (const line of output.split("\n")) {
		const [, reported, lineText, message] =
			line.match(/^(.+) \(line (\d+)\): (.+)$/) ?? [];
		if (!reported || !lineText || !message) continue;
		// fish 3.3.1 prints an absolute argv path as `~` + that path
		// (`~/home/u/x.fish`), and 3.1 abbreviates HOME to `~`; both end in the
		// checked file's own path. Another file's header still fails this test.
		const wanted = resolve(cwd, filePath);
		if (
			!pathsEqual(resolve(cwd, reported), wanted) &&
			!(reported.startsWith("~/") && wanted.endsWith(reported.slice(1)))
		)
			continue;
		const lineNumber = Number(lineText);
		diagnostics.push({
			id: `fish-syntax-${filePath}:${lineNumber}`,
			message: `fish: ${message.trim()}`,
			filePath,
			line: lineNumber,
			column: 1,
			severity: "error",
			semantic: "blocking",
			tool: "fish-indent",
			rule: "fish-syntax-error",
		});
		// fish reports only the first parse error, and its header precedes the
		// source excerpt; a later header-shaped line is file text, not fish's.
		break;
	}
	return diagnostics;
}

// EXIT TABLE (fish 4.9.3, measured fixture: tests/fixtures/runner-output/
// fish-indent/syntax-*.captured.json). `fish --no-execute` exits 0 for a file
// that parses and 127 both for a syntax error (a `<file> (line N): ...` header
// on stderr) and for a file it could not read (no header). Any other exit is
// a rejected invocation, never a completed parse.
const FISH_SYNTAX_EXIT_CODES = { ran: [127] } as const;

// Both blocking returns below (a syntax error, an I/O error) fail the run the
// same way.
const BLOCKING_VERDICT = { status: "failed", semantic: "blocking" } as const;

const fishIndentRunner: RunnerDefinition = {
	id: "fish-indent",
	appliesTo: ["fish"],
	priority: PRIORITY.FORMAT_AND_LINT_PRIMARY,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "fish-indent");
		const cmd =
			ctx.analysisRootMode === "adopted"
				? resolveAdoptedRootCommand("fish_indent", ctx, cwd)
				: (await fishIndent.isAvailableAsync(cwd))
					? fishIndent.getCommand(cwd)
					: null;
		if (!cmd) return toolAbsentSkip();

		// Syntax first: fish_indent --check cannot see a syntax error. `--no-execute`
		// parses only, never runs a command or a command substitution, and
		// `--no-config` keeps even the startup files out. When the check cannot
		// decide (fish absent, killed, unreadable output) the format check still
		// runs, and the gap leaves one bounded ledger row, never a silent pass.
		const fishCmd =
			ctx.analysisRootMode === "adopted"
				? resolveAdoptedRootCommand("fish", ctx, cwd)
				: (await fish.isAvailableAsync(cwd))
					? fish.getCommand(cwd)
					: null;
		if (fishCmd) {
			const syntax = await safeSpawnAsync(
				fishCmd,
				["--no-config", "--no-execute", ctx.filePath],
				{ timeout: 10000, cwd },
			);
			const parsed = parseToolRun<Diagnostic>(
				SYNTAX_STEP,
				{
					result: syntax,
					output: syntax.stderr ?? "",
					exitCodes: FISH_SYNTAX_EXIT_CODES,
				},
				(output) => parseSyntaxErrors(output, ctx.filePath, cwd),
			);
			if (parsed.diagnostics.length > 0) {
				return findingsResult(parsed.diagnostics, BLOCKING_VERDICT);
			}
		} else {
			recordDegradationOnce({
				kind: "fish-syntax-check-unavailable",
				subject: "fish",
				reason:
					"fish not found next to fish_indent: syntax errors are not checked",
			});
		}

		// --check: exits 0 if already formatted, 1 if reformatting would change the file
		const result = await safeSpawnAsync(cmd, ["--check", ctx.filePath], {
			timeout: 10000,
			cwd,
		});

		if (result.status === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// A fish_indent that was killed or timed out reported no exit status and
		// said nothing: without this the empty stderr below reads as "just needs
		// formatting" (#4522). The narrow test keeps a nonzero exit with an empty
		// stderr (an older fish_indent) a format finding.
		if (result.signal || result.status === null) {
			const didNotRun = skipUnlessToolRan("fish_indent", { result });
			if (didNotRun) return didNotRun;
		}

		// Non-zero exit: either needs formatting or something else was reported on
		// stderr. fish_indent 4.9.3 --check prints the file's own name there for a
		// merely unformatted file (#4454); that is the format finding below, not an
		// error. It prints the path as spelled in argv, so compare resolved paths.
		const stderrLine = (result.stderr ?? "")
			.split("\n")
			.find(
				(l) =>
					l.trim() &&
					!pathsEqual(resolve(cwd, l.trim()), resolve(cwd, ctx.filePath)),
			);
		if (stderrLine) {
			// Any other stderr is an I/O error such as `Opening "x" failed` (4.9.3
			// --check never reports a syntax error; the fish --no-execute step above
			// does, #4454). Take the line number from "filename (line N): message"
			// if present.
			const lineMatch = stderrLine.match(/\(line\s+(\d+)\)/);
			const line = lineMatch ? Number(lineMatch[1]) : 1;
			const diagnostics: Diagnostic[] = [
				{
					id: `fish-indent-parse-${ctx.filePath}`,
					message: `fish_indent: ${stderrLine.trim()}`,
					filePath: ctx.filePath,
					line,
					column: 1,
					severity: "error",
					semantic: "blocking",
					tool: "fish-indent",
					rule: "fish-indent-parse-error",
				},
			];
			return findingsResult(diagnostics, BLOCKING_VERDICT);
		}

		// Clean stderr — file just needs formatting
		const diagnostics: Diagnostic[] = [
			{
				id: `fish-indent-format-${ctx.filePath}`,
				message: "Fish script is not formatted — run `fish_indent -w` to fix",
				filePath: ctx.filePath,
				line: 1,
				column: 1,
				severity: "warning",
				semantic: "warning",
				tool: "fish-indent",
				rule: "fish-indent-unformatted",
				fixable: true,
				autoFixAvailable: false,
				fixKind: "manual",
			},
		];
		return { status: "succeeded", diagnostics, semantic: "warning" };
	},
};

export default fishIndentRunner;
