import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
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

		let cmd: string | null = null;
		if (htmlhint.isAvailable(cwd)) {
			cmd = htmlhint.getCommand(cwd);
		} else {
			cmd = await resolveToolCommandWithInstallFallback(cwd, "htmlhint");
		}

		if (!cmd) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const rulesJson = JSON.stringify(HTMLHINT_RULES);
		const result = await safeSpawnAsync(
			cmd,
			[
				"--rules",
				rulesJson,
				"--format",
				"unix",
				path.resolve(cwd, ctx.filePath),
			],
			{ cwd },
		);

		if (result.error && !result.stdout && !result.stderr) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const output = result.stdout || result.stderr || "";
		const diagnostics = parseHtmlhintOutput(output, ctx.filePath);

		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const hasErrors = diagnostics.some((d) => d.severity === "error");
		return {
			status: "failed",
			diagnostics,
			semantic: hasErrors ? "blocking" : "warning",
		};
	},
};

export default htmlhintRunner;
