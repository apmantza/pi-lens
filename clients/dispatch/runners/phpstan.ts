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

const phpstan = createAvailabilityChecker("phpstan", ".phar");

interface PhpstanError {
	message: string;
	line: number | null;
	ignorable: boolean;
}

interface PhpstanFileErrors {
	errors: PhpstanError[];
}

interface PhpstanOutput {
	files: Record<string, PhpstanFileErrors>;
	errors: string[];
}

function parsePhpstanJson(raw: string, filePath: string): Diagnostic[] {
	try {
		const output: PhpstanOutput = JSON.parse(raw);
		const diagnostics: Diagnostic[] = [];

		for (const [, fileErrors] of Object.entries(output.files ?? {})) {
			for (const err of fileErrors.errors ?? []) {
				diagnostics.push({
					id: `phpstan:${err.line ?? 1}:${err.message.slice(0, 40)}`,
					message: err.message,
					filePath,
					line: err.line ?? 1,
					column: 1,
					severity: "error",
					semantic: "blocking",
					tool: "phpstan",
					rule: "phpstan",
					fixable: false,
				});
			}
		}

		return diagnostics;
	} catch {
		return [];
	}
}

async function resolvePhpstan(cwd: string): Promise<string | null> {
	if (await (phpstan.isAvailableAsync(cwd)))
		return phpstan.getCommand(cwd);
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

		// phpstan exits 0 = no errors, 1 = errors found, 2 = fatal
		if (result.status === 2 || result.error) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}
		if (result.status === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const diagnostics = parsePhpstanJson(result.stdout ?? "", ctx.filePath);
		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		return { status: "failed", diagnostics, semantic: "blocking" };
	},
};

export default phpstanRunner;
