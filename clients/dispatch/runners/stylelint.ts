import * as nodeFs from "node:fs";
import * as path from "node:path";
import { ensureTool } from "../../installer/index.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { PRIORITY } from "../priorities.js";

const stylelint = createAvailabilityChecker("stylelint", ".cmd");

const STYLELINT_CONFIGS = [
	".stylelintrc",
	".stylelintrc.json",
	".stylelintrc.jsonc",
	".stylelintrc.yaml",
	".stylelintrc.yml",
	".stylelintrc.js",
	".stylelintrc.cjs",
	"stylelint.config.js",
	"stylelint.config.cjs",
	"stylelint.config.mjs",
];

function hasStylelintConfig(cwd: string): boolean {
	if (STYLELINT_CONFIGS.some((cfg) => nodeFs.existsSync(path.join(cwd, cfg))))
		return true;
	try {
		const pkg = JSON.parse(
			nodeFs.readFileSync(path.join(cwd, "package.json"), "utf-8"),
		);
		if (pkg.stylelint) return true;
	} catch {}
	return false;
}

interface StylelintWarning {
	line: number;
	column: number;
	severity: string;
	rule: string;
	text: string;
}

interface StylelintResult {
	source: string;
	warnings: StylelintWarning[];
}

function parseStylelintJson(
	raw: string,
	filePath: string,
): Diagnostic[] {
	try {
		const results: StylelintResult[] = JSON.parse(raw);
		const diagnostics: Diagnostic[] = [];
		for (const result of results) {
			for (const w of result.warnings) {
				const severity = w.severity === "error" ? "error" : "warning";
				diagnostics.push({
					id: `stylelint-${w.line}-${w.rule}`,
					message: `[${w.rule}] ${w.text.replace(/\s*\(stylelint.*?\)$/, "")}`,
					filePath,
					line: w.line,
					column: w.column,
					severity,
					semantic: severity === "error" ? "blocking" : "warning",
					tool: "stylelint",
					rule: w.rule,
				});
			}
		}
		return diagnostics;
	} catch {
		return [];
	}
}

const stylelintRunner: RunnerDefinition = {
	id: "stylelint",
	appliesTo: ["css"],
	priority: PRIORITY.FORMAT_AND_LINT_PRIMARY,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();

		if (!hasStylelintConfig(cwd)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let cmd: string | null = null;
		if (stylelint.isAvailable(cwd)) {
			cmd = stylelint.getCommand(cwd);
		} else {
			// Try local node_modules first
			const local = path.join(
				cwd,
				"node_modules",
				".bin",
				process.platform === "win32" ? "stylelint.cmd" : "stylelint",
			);
			if (nodeFs.existsSync(local)) {
				cmd = local;
			} else {
				const installed = await ensureTool("stylelint");
				if (!installed) {
					return { status: "skipped", diagnostics: [], semantic: "none" };
				}
				cmd = installed;
			}
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const result = await safeSpawnAsync(
			cmd,
			["--formatter", "json", ctx.filePath],
			{ timeout: 20000, cwd },
		);

		const raw = result.stdout ?? "";
		const diagnostics = parseStylelintJson(raw, ctx.filePath);
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

export default stylelintRunner;
