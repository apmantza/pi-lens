import * as path from "node:path";
import * as fs from "node:fs";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { PRIORITY } from "../priorities.js";

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

function hasPhpstanConfig(cwd: string): boolean {
	return (
		fs.existsSync(path.join(cwd, "phpstan.neon")) ||
		fs.existsSync(path.join(cwd, "phpstan.neon.dist")) ||
		fs.existsSync(path.join(cwd, "phpstan.dist.neon"))
	);
}

function resolvePhpstan(cwd: string): string | null {
	if (phpstan.isAvailable(cwd)) return phpstan.getCommand(cwd);

	// Check vendor/bin (Composer install)
	const vendorBin = path.join(
		cwd,
		"vendor",
		"bin",
		process.platform === "win32" ? "phpstan.bat" : "phpstan",
	);
	if (fs.existsSync(vendorBin)) return vendorBin;

	return null;
}

const phpstanRunner: RunnerDefinition = {
	id: "phpstan",
	appliesTo: ["php"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();

		// Only run if phpstan config present — avoids noisy defaults on unconfigured projects
		if (!hasPhpstanConfig(cwd)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const cmd = resolvePhpstan(cwd);
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
