import * as path from "node:path";
import { pathsEqual } from "../../path-utils.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import {
	getAutofixCapability,
	getLinterPolicyForCwd,
} from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { resolveToolCommandWithInstallFallback } from "./utils/runner-helpers.js";
import { finishParsedRun, parseToolRun } from "./utils/tool-failure.js";

// KtLint's exit contract, declared HERE rather than in the shared classifier:
// an admission is a property of this tool, and #3291 round 2 shipped it through
// a shared `parseToolRun` option that silently erased every OTHER runner's
// table. KtLint 1.8.0's CLI page documents the JSON reporter and a nonzero exit
// on violations, but does not enumerate numeric classes; 1, 2 and 3 are the
// statuses this runner observes carrying a valid reporter payload, and a valid
// payload is the evidence that analysis was reached. Any other nonzero status
// stays a rejected invocation.
const KTLINT_EXIT_CODES = { ran: [1, 2, 3] } as const;

// Field names are the JSON reporter's own, read from ktlint 1.8.0's real output
// (tests/fixtures/runner-output/ktlint/real.captured.json): `column`, `message`
// and `rule`. The names this runner read before (`col`, `detail`, `ruleId`) were
// never in that output, so every finding parsed as `[undefined] undefined`
// (#4522).
interface KtlintError {
	line: number;
	column: number;
	message: string;
	rule: string;
}

interface KtlintResult {
	file?: string;
	errors: KtlintError[];
}

function normalizeKtlintResults(parsed: unknown): KtlintResult[] | null {
	if (Array.isArray(parsed)) {
		return parsed as KtlintResult[];
	}
	if (
		parsed &&
		typeof parsed === "object" &&
		Array.isArray((parsed as KtlintResult).errors)
	) {
		return [parsed as KtlintResult];
	}
	return null;
}

function parseResults(text: string): KtlintResult[] | null {
	try {
		return normalizeKtlintResults(JSON.parse(text));
	} catch {
		return null;
	}
}

/**
 * ktlint 1.8.0 prints its own log lines (`HH:MM:SS.mmm [main] WARN ...`) on
 * stdout, ahead of the reporter's JSON document
 * (tests/fixtures/runner-output/ktlint/real.captured.json), so the whole stream
 * is not JSON. The document starts at the first line that opens one (a log line
 * never starts with `[` or `{`) and ends at the last line that closes one and
 * still parses (#4522: the dirty cell of the tool-state matrix read the real
 * bytes as a parse error).
 */
function parseReporterDocument(raw: string): KtlintResult[] | null {
	const lines = raw.split(/\r?\n/);
	const start = lines.findIndex((line) => /^\s*[[{]/.test(line));
	if (start < 0) return parseResults(raw);
	for (let end = lines.length - 1; end >= start; end--) {
		if (!/[\]}]\s*$/.test(lines[end] ?? "")) continue;
		const results = parseResults(lines.slice(start, end + 1).join("\n"));
		if (results) return results;
	}
	return null;
}

function parseKtlintOutput(
	raw: string,
	filePath: string,
	cwd: string,
): Diagnostic[] | null {
	try {
		const parsed = parseReporterDocument(raw);
		if (!parsed) return null;

		const autofix = getAutofixCapability("ktlint");
		const diagnostics: Diagnostic[] = [];
		const absTarget = path.resolve(cwd, filePath);
		for (const result of parsed) {
			// #3295: ktlint's JSON reporter is an array of FILES; `.editorconfig`
			// globs put more than the argv in it.
			if (result.file && !pathsEqual(path.resolve(cwd, result.file), absTarget))
				continue;
			for (const err of result.errors ?? []) {
				diagnostics.push({
					id: `ktlint-${err.rule}-${err.line}-${err.column}`,
					message: `[${err.rule}] ${err.message}`,
					filePath,
					line: err.line,
					column: err.column,
					severity: "warning",
					semantic: "warning",
					tool: "ktlint",
					rule: err.rule,
					fixable: true,
					autoFixAvailable: autofix?.safePipelineAutofix ?? false,
					fixKind: autofix?.fixKind === "none" ? undefined : autofix?.fixKind,
				});
			}
		}
		return diagnostics;
	} catch {
		return null;
	}
}

const ktlintRunner: RunnerDefinition = {
	id: "ktlint",
	appliesTo: ["kotlin"],
	priority: PRIORITY.FORMAT_AND_LINT_PRIMARY,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "ktlint");
		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("ktlint")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const cmd = await resolveToolCommandWithInstallFallback(cwd, "ktlint");

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const absPath = path.resolve(cwd, ctx.filePath);
		const result = await safeSpawnAsync(cmd, ["--reporter=json", absPath], {
			cwd,
			timeout: 30000,
		});

		// `output` is what the classifier judges AND what the parser reads: ktlint
		// writes its reporter payload to stdout and its errors to stderr, so both
		// are one wire here. The exit table rides in this same per-runner input,
		// never in a shared option (#3291 r3).
		const run = parseToolRun<Diagnostic>(
			"ktlint",
			{
				result,
				output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
				exitCodes: KTLINT_EXIT_CODES,
			},
			(output) => parseKtlintOutput(output, ctx.filePath, cwd) ?? [],
		);
		if (run.skipped) return run.skipped;
		return finishParsedRun({
			tool: "ktlint",
			ctx,
			result,
			diagnostics: run.diagnostics,
		});
	},
};

export default ktlintRunner;
