import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { getLinterPolicyForCwd } from "../../tool-policy.js";
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
import { parseToolRun } from "./utils/tool-failure.js";
import { finishParsedRun } from "./utils/tool-failure.js";

const htmlhint = createAvailabilityChecker("htmlhint");

const HTMLHINT_RULES = {
	"tag-pair": true,
	"attr-no-duplication": true,
	"tagname-lowercase": true,
	"doctype-first": false,
	"spec-char-escape": true,
	"id-unique": true,
};

function parseHtmlhintOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	// unix format: "file:line:col: message [severity/rule]"
	const lineRe = /^.+?:(\d+):(\d+): (.+?) \[(error|warning)\/([^\]]+)\]/;

	for (const line of raw.split("\n")) {
		const match = line.match(lineRe);
		if (!match) continue;

		const lineNum = parseInt(match[1], 10);
		const col = parseInt(match[2], 10);
		const message = match[3].trim();
		const level = match[4];
		const rule = match[5].trim();
		const severity = level === "error" ? "error" : "warning";

		diagnostics.push({
			id: `htmlhint-${rule}-${lineNum}`,
			message,
			filePath,
			line: lineNum,
			column: col,
			severity,
			semantic: severity === "error" ? "blocking" : "warning",
			tool: "htmlhint",
			rule,
			fixable: false,
		});
	}

	return diagnostics;
}

const htmlhintRunner: RunnerDefinition = {
	id: "htmlhint",
	appliesTo: ["html"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("htmlhint")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let cmd: string | null = null;
		if (await htmlhint.isAvailableAsync(cwd)) {
			cmd = htmlhint.getCommand(cwd);
		} else {
			cmd = await resolveToolCommandWithInstallFallback(cwd, "htmlhint");
		}

		if (!cmd) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// htmlhint's --rules flag takes a comma-separated ruleid list
		// ("tag-pair,id-class-value=underline"), NOT a JSON object. The old JSON
		// blob parsed as one bogus rule id, leaving ZERO rules enabled — every
		// file read CLEAN (exit 0, no output) no matter what it contained.
		// Root-caused live against htmlhint 1.x after the tier-1 parser smoke
		// caught htmlhint reporting 0 findings on the planted tag-pair defect.
		// Entries set to false are omitted: under --rules semantics an unlisted
		// rule is off, which is exactly what `false` means here.
		const rulesArg = Object.entries(HTMLHINT_RULES)
			.flatMap(([rule, enabled]) => (enabled === true ? [rule] : []))
			.join(",");
		const result = await safeSpawnAsync(
			cmd,
			[
				"--rules",
				rulesArg,
				"--format",
				"unix",
				path.resolve(cwd, ctx.filePath),
			],
			{ cwd },
		);

		// #1948: htmlhint exits 1 when it finds errors and prints them in `unix`
		// format on stdout. Zero parsed out of a nonzero exit is a parser break.
		const output = result.stdout || result.stderr || "";
		const run = parseToolRun("htmlhint", { result, output }, (out) =>
			parseHtmlhintOutput(out, ctx.filePath),
		);
		if (run.skipped) return run.skipped;

		const diagnostics = run.diagnostics;
		return finishParsedRun({
			tool: "htmlhint",
			ctx,
			result,
			diagnostics,
			classify: (diagnostics) => {
				const hasErrors = diagnostics.some((d) => d.severity === "error");
				return {
					status: "failed",
					semantic: hasErrors ? "blocking" : "warning",
				};
			},
		});
	},
};

export default htmlhintRunner;
