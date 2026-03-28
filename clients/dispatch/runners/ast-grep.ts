/**
 * ast-grep runner for dispatch system
 *
 * Structural code analysis for detecting patterns like:
 * - redundant state
 * - async/await issues
 * - security anti-patterns
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";

const astGrepRunner: RunnerDefinition = {
	id: "ast-grep",
	appliesTo: ["jsts", "python", "go", "rust", "cxx"],
	priority: 30,
	enabledByDefault: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Check if ast-grep is available
		const check = spawnSync("sg", ["--version"], {
			encoding: "utf-8",
			timeout: 5000,
			shell: true,
		});

		if (check.error || check.status !== 0) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Find ast-grep config
		const configPath = findAstGrepConfig(ctx.cwd);
		if (!configPath) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Run ast-grep scan on the file
		const args = ["scan", "--config", configPath, "--json", ctx.filePath];

		const result = spawnSync("sg", args, {
			encoding: "utf-8",
			timeout: 30000,
			shell: true,
		});

		const raw = result.stdout + result.stderr;

		if (result.status === 0 && !raw.trim()) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// Parse results
		const diagnostics = parseAstGrepOutput(raw, ctx.filePath);

		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		return {
			status: "failed",
			diagnostics,
			semantic: "warning",
		};
	},
};

function findAstGrepConfig(cwd: string): string | undefined {
	const candidates = [
		"rules/ast-grep-rules/.sgconfig.yml",
		".sgconfig.yml",
		"sgconfig.yml",
	];

	for (const candidate of candidates) {
		const fullPath = `${cwd}/${candidate}`;
		if (fs.existsSync(fullPath)) {
			return fullPath;
		}
	}

	return undefined;
}

function parseAstGrepOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	// Try to parse as JSON
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			for (const item of parsed) {
				const line = item.range?.start?.line || 1;
				diagnostics.push({
					id: `ast-grep-${line}-${item.rule || "unknown"}`,
					message: item.message || item.lines || "",
					filePath,
					line,
					severity: item.severity === "error" ? "error" : "warning",
					semantic: item.severity === "error" ? "blocking" : "warning",
					tool: "ast-grep",
					rule: item.rule || "unknown",
					fixable: !!item.replacement,
					fixSuggestion: item.replacement
						? "Run `sg fix` to auto-fix"
						: undefined,
				});
			}
		}
	} catch {
		// Not JSON, try line-by-line parsing
		const lines = raw.split("\n");
		for (const line of lines) {
			if (line.includes(":") && line.includes("L")) {
				const match = line.match(/L(\d+):?\s*(.+)/);
				if (match) {
					diagnostics.push({
						id: `ast-grep-${match[1]}-line`,
						message: match[2].trim(),
						filePath,
						line: parseInt(match[1], 10),
						severity: "warning",
						semantic: "warning",
						tool: "ast-grep",
					});
				}
			}
		}
	}

	return diagnostics;
}

export default astGrepRunner;
