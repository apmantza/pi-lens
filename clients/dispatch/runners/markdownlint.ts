import { safeSpawnAsync } from "../../safe-spawn.js";
import {
	getLinterPolicyForCwd,
	hasMarkdownlintConfig,
} from "../../tool-policy.js";
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

const markdownlint = createAvailabilityChecker("markdownlint-cli2", ".cmd");

// markdownlint-cli2 text output does not include per-violation fixability,
// so we keep a static allowlist of MD### rules whose --fix is deterministic.
// Sourced from the rule pages in
// https://github.com/DavidAnson/markdownlint/blob/main/doc/Rules.md — every
// entry below is documented as "Fixable: yes" (or equivalent). Update when
// markdownlint adds or changes auto-fix support.
const MARKDOWNLINT_FIXABLE_RULES = new Set<string>([
	"MD001",
	"MD004",
	"MD005",
	"MD007",
	"MD009",
	"MD010",
	"MD011",
	"MD012",
	"MD014",
	"MD018",
	"MD019",
	"MD020",
	"MD021",
	"MD022",
	"MD023",
	"MD026",
	"MD027",
	"MD030",
	"MD031",
	"MD032",
	"MD034",
	"MD037",
	"MD038",
	"MD039",
	"MD044",
	"MD047",
	"MD049",
	"MD050",
	"MD053",
	"MD058",
]);

// markdownlint-cli2 output: `path:line[:col] [error|warning] MD###/name[/name…] message`
// Two things the original parser missed (→ silent 0 diagnostics, #212):
//   1. cli2 emits a severity token (`error`/`warning`) between the col and the
//      rule code — older markdownlint-cli did not.
//   2. some rules carry MULTIPLE slash-separated names (e.g.
//      `MD041/first-line-heading/first-line-h1`).
// The severity token is optional so older/relative-path output still parses.
function parseMarkdownlintOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		// Rule code is MD### followed by one or more slash-joined names. Use a
		// single char class (`[\w/-]+`) rather than a nested quantifier
		// (`(?:/[\w-]+)+`) so there's no super-linear backtracking (S5852).
		const match = line.match(
			/^.*?:(\d+)(?::(\d+))?\s+(?:error|warning)?\s*(MD\d+\/[\w/-]+)\s+(.+)$/,
		);
		if (!match) continue;
		const [, lineNum, col, ruleCode, message] = match;
		const ruleName = ruleCode.split("/")[0];
		const fixable = MARKDOWNLINT_FIXABLE_RULES.has(ruleName);
		diagnostics.push({
			id: `markdownlint-${lineNum}-${ruleName}`,
			message: `[${ruleCode}] ${message}`,
			filePath,
			line: Number(lineNum),
			column: col ? Number(col) : 1,
			severity: "warning",
			semantic: "warning",
			tool: "markdownlint",
			rule: ruleName,
			fixable,
			fixSuggestion: fixable
				? "Run `markdownlint-cli2 --fix` to apply the deterministic auto-correction for this rule."
				: undefined,
		});
	}
	return diagnostics;
}

const markdownlintRunner: RunnerDefinition = {
	id: "markdownlint",
	appliesTo: ["markdown"],
	priority: PRIORITY.DOC_QUALITY,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("markdownlint")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}
		const hasConfig = hasMarkdownlintConfig(cwd);
		if (!hasConfig) {
			// Run with sensible defaults even without explicit config
		}

		let cmd: string | null = null;
		if (await (markdownlint.isAvailableAsync(cwd))) {
			cmd = markdownlint.getCommand(cwd);
		} else {
			cmd = await resolveToolCommandWithInstallFallback(cwd, "markdownlint");
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const configArgs = hasConfig ? [] : ["--disable", "MD013"];
		const result = await safeSpawnAsync(cmd, [...configArgs, ctx.filePath], {
			timeout: 15000,
			cwd,
		});

		const raw = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		const diagnostics = parseMarkdownlintOutput(raw, ctx.filePath);
		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		return { status: "succeeded", diagnostics, semantic: "warning" };
	},
};

export default markdownlintRunner;
