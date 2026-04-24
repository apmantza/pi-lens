import * as nodeFs from "node:fs";
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
	resolveToolCommand,
	resolveToolCommandWithInstallFallback,
} from "./utils/runner-helpers.js";

const prettier = createAvailabilityChecker("prettier", ".cmd");

const PRETTIER_CONFIGS = [
	".prettierrc",
	".prettierrc.json",
	".prettierrc.yml",
	".prettierrc.yaml",
	".prettierrc.js",
	".prettierrc.cjs",
	".prettierrc.mjs",
	"prettier.config.js",
	"prettier.config.cjs",
	"prettier.config.mjs",
];

function hasPrettierConfig(cwd: string): boolean {
	if (PRETTIER_CONFIGS.some((cfg) => nodeFs.existsSync(path.join(cwd, cfg))))
		return true;
	try {
		const pkg = JSON.parse(
			nodeFs.readFileSync(path.join(cwd, "package.json"), "utf-8"),
		);
		if (pkg.prettier) return true;
	} catch {}
	return false;
}

async function resolvePrettier(cwd: string): Promise<string | null> {
	if (prettier.isAvailable(cwd)) return prettier.getCommand(cwd);
	const resolved = resolveToolCommand(cwd, "prettier");
	if (resolved && resolved !== "prettier") return resolved;
	return resolveToolCommandWithInstallFallback(cwd, "prettier");
}

const prettierCheckRunner: RunnerDefinition = {
	id: "prettier-check",
	appliesTo: ["css", "html"],
	priority: PRIORITY.FORMAT_AND_LINT_PRIMARY,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const fileDir = path.dirname(path.resolve(cwd, ctx.filePath));
		const hasConfig = hasPrettierConfig(fileDir) || hasPrettierConfig(cwd);
		if (!hasConfig) {
			// Run with sensible defaults even without explicit config
		}

		const cmd = await resolvePrettier(cwd);
		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const absPath = path.resolve(cwd, ctx.filePath);
		const result = await safeSpawnAsync(
			cmd,
			["--check", "--no-color", absPath],
			{ timeout: 15000, cwd },
		);

		// exit 0 = formatted, exit 1 = needs formatting, exit 2 = error
		if (result.status === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}
		if (result.status === 2 || result.error) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const diagnostic: Diagnostic = {
			id: "prettier-check:format",
			message: "File is not formatted. Run prettier --write to fix.",
			filePath: ctx.filePath,
			line: 1,
			column: 1,
			severity: "warning",
			semantic: "warning",
			tool: "prettier-check",
			rule: "formatting",
			fixable: true,
		};

		return {
			status: "succeeded",
			diagnostics: [diagnostic],
			semantic: "warning",
		};
	},
};

export default prettierCheckRunner;
