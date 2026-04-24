/**
 * Biome check runner for dispatch system
 *
 * Dispatch mode is diagnostics-only.
 * Autofix is handled earlier by the post-write pipeline to avoid
 * mutating files mid-dispatch after LSP sync has already happened.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolvePackagePath } from "../../package-root.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { getJstsLintPolicyForCwd, hasBiomeConfig } from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";

function hasUserBiomeConfig(cwd: string): boolean {
	return hasBiomeConfig(cwd);
}

interface BiomeBinary {
	cmd: string;
	argsPrefix: string[];
}

// Cache binary resolution to avoid repeated fs checks
let cachedBiomeBinary: BiomeBinary | null = null;
let cachedCwd: string | null = null;

function findBiome(cwd: string): BiomeBinary {
	// Return cached result if cwd hasn't changed
	if (cachedBiomeBinary && cachedCwd === cwd) {
		return cachedBiomeBinary;
	}

	const isWin = process.platform === "win32";
	const local = path.join(
		cwd,
		"node_modules",
		".bin",
		isWin ? "biome.cmd" : "biome",
	);
	if (fs.existsSync(local)) {
		cachedBiomeBinary = { cmd: local, argsPrefix: [] };
		cachedCwd = cwd;
		return cachedBiomeBinary;
	}

	// Check pi-lens tools directory (where ensureTool("biome") auto-installs)
	const piLensBin = path.join(
		os.homedir(),
		".pi-lens",
		"tools",
		"node_modules",
		".bin",
		isWin ? "biome.cmd" : "biome",
	);
	if (fs.existsSync(piLensBin)) {
		cachedBiomeBinary = { cmd: piLensBin, argsPrefix: [] };
		cachedCwd = cwd;
		return cachedBiomeBinary;
	}

	// Fall back to npx (slower but works anywhere, auto-installs if needed)
	cachedBiomeBinary = { cmd: "npx", argsPrefix: ["@biomejs/biome"] };
	cachedCwd = cwd;
	return cachedBiomeBinary;
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

function parseBiomeJson(
	raw: string,
	filePath: string,
): { diagnostics: Diagnostic[]; parseError?: string } {
	try {
		const result = JSON.parse(raw);
		const diagnostics: BiomeDiagnostic[] = result.diagnostics || [];

		return {
			diagnostics: diagnostics.map((d) => ({
				id: `biome:${d.category}:${d.location.start.line}`,
				message: d.message,
				filePath,
				line: d.location.start.line,
				column: d.location.start.column,
				severity: d.severity === "error" ? "error" : "warning",
				semantic: d.severity === "error" ? "blocking" : ("warning" as const),
				tool: "biome",
				rule: d.category,
				fixable: d.tags?.includes("fixable") ?? false,
			})),
		};
	} catch (err) {
		return {
			diagnostics: [],
			parseError: err instanceof Error ? err.message : String(err),
		};
	}
}

const biomeCheckJsonRunner: RunnerDefinition = {
	id: "biome-check-json",
	appliesTo: ["jsts"],
	priority: PRIORITY.FORMAT_AND_LINT_PRIMARY,
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || path.dirname(ctx.filePath);
		const policy = getJstsLintPolicyForCwd(cwd);

		// Defer to ESLint/oxlint if the project has explicitly configured one —
		// biome runs as the default linter only when no alternative is present.
		if (!policy.hasBiomeConfig && policy.hasExplicitNonBiomeLinter) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Check if Biome is available (resolve binary path)
		const biomeBinary = findBiome(cwd);

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
			: [
					"--config-path=" +
						resolvePackagePath(import.meta.url, "config/biome/core.jsonc"),
				];

		// Run biome lint (diagnostics only - format is handled separately)
		const checkResult = await safeSpawnAsync(
			biomeBinary.cmd,
			[
				...biomeBinary.argsPrefix,
				"lint",
				"--reporter=json",
				"--no-errors-on-unmatched",
				...configArg,
				ctx.filePath,
			],
			{ timeout: 30000, cwd },
		);

		// Handle spawn errors (e.g., binary not found)
		if (checkResult.error) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const parsed =
			checkResult.status === 0 || checkResult.status === 1
				? parseBiomeJson(checkResult.stdout || "", ctx.filePath)
				: { diagnostics: [] as Diagnostic[] };

		if (parsed.parseError) {
			const raw = checkResult.stdout || checkResult.stderr || "";
			const preview = raw.replace(/\s+/g, " ").slice(0, 160);
			return {
				status: "failed",
				diagnostics: [
					{
						id: "biome:parse-error:1",
						message: `Biome JSON parse failed: ${parsed.parseError}${preview ? ` (output preview: ${preview})` : ""}`,
						filePath: ctx.filePath,
						line: 1,
						column: 1,
						severity: "warning",
						semantic: "warning",
						tool: "biome",
					},
				],
				semantic: "warning",
			};
		}

		const diagnostics = parsed.diagnostics;

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
