/**
 * Biome check runner for dispatch system
 *
 * Runs `biome check --output-format=json` to capture diagnostics,
 * then runs `biome check --write` to auto-fix.
 *
 * Diagnostics are shown to the agent BEFORE fixing — teaching signal.
 * Auto-fix happens silently after.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolvePackagePath } from "../../package-root.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";

const BIOME_CONFIGS = ["biome.json", "biome.jsonc"];

function hasUserBiomeConfig(cwd: string): boolean {
	for (const cfg of BIOME_CONFIGS) {
		if (fs.existsSync(path.join(cwd, cfg))) return true;
	}
	return false;
}

function findBiome(cwd: string): string {
	const isWin = process.platform === "win32";
	const local = path.join(
		cwd,
		"node_modules",
		".bin",
		isWin ? "biome.cmd" : "biome",
	);
	if (fs.existsSync(local)) return local;
	return "biome";
}

interface BiomeDiagnostic {
	severity: "error" | "warning" | "information" | "hint";
	category: string;
	message: string;
	location: {
		source: string;
		start: { line: number; column: number };
		end: { line: number; column: number };
	};
	tags?: string[];
}

function parseBiomeJson(raw: string, filePath: string): Diagnostic[] {
	try {
		const result = JSON.parse(raw);
		const diagnostics: BiomeDiagnostic[] = result.diagnostics || [];

		return diagnostics.map((d) => ({
			id: `biome:${d.category}:${d.location.start.line}`,
			message: d.message,
			filePath,
			line: d.location.start.line,
			column: d.location.start.column,
			severity: d.severity === "error" ? "error" : "warning",
			semantic: d.severity === "error" ? "blocking" : ("warning" as const),
			tool: "biome",
			rule: d.category,
		}));
	} catch {
		return [];
	}
}

const biomeCheckJsonRunner: RunnerDefinition = {
	id: "biome-check-json",
	appliesTo: ["jsts"],
	priority: 10,
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || path.dirname(ctx.filePath);

		// Check if Biome is available
		const biomeCmd = findBiome(cwd);
		const versionCheck = await safeSpawnAsync(biomeCmd, ["--version"], {
			timeout: 5000,
			cwd,
		});
		if (versionCheck.error || versionCheck.status !== 0) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Build config path — use user's if exists, else pi-lens config
		const userHasConfig = hasUserBiomeConfig(cwd);
		const configArg = userHasConfig
			? [
					"--config-path=" +
						path.join(
							cwd,
							fs.existsSync(path.join(cwd, "biome.jsonc"))
								? "biome.jsonc"
								: "biome.json",
						),
				]
			: ["--config-path=" + resolvePackagePath("config/biome/core.jsonc")];

		// Step 1: Capture diagnostics (before fixing)
		const checkResult = await safeSpawnAsync(
			biomeCmd,
			[
				"check",
				"--output-format=json",
				"--no-errors-on-unmatched",
				...configArg,
				ctx.filePath,
			],
			{ timeout: 30000, cwd },
		);

		const diagnostics =
			checkResult.status === 0 || checkResult.status === 1
				? parseBiomeJson(
						checkResult.stdout || checkResult.stderr || "",
						ctx.filePath,
					)
				: [];

		// Step 2: Auto-fix (silently)
		await safeSpawnAsync(
			biomeCmd,
			[
				"check",
				"--write",
				"--no-errors-on-unmatched",
				...configArg,
				ctx.filePath,
			],
			{ timeout: 30000, cwd },
		);

		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const hasErrors = diagnostics.some((d) => d.semantic === "blocking");
		return {
			status: hasErrors ? "failed" : "succeeded",
			diagnostics,
			semantic: hasErrors ? "blocking" : "warning",
		};
	},
};

export default biomeCheckJsonRunner;
