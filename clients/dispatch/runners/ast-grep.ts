/**
 * ast-grep runner for dispatch system
 *
 * Structural code analysis for detecting patterns like:
 * - redundant state
 * - async/await issues
 * - security anti-patterns
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

// Simple YAML fix: field extractor
function extractFixFromRule(
	ruleId: string,
	ruleDir: string,
): string | undefined {
	try {
		const rulePath = `${ruleDir}/${ruleId}.yml`;
		if (!fs.existsSync(rulePath)) return undefined;

		const content = fs.readFileSync(rulePath, "utf-8");
		const fixMatch = content.match(/^fix:\s*\|?([\s\S]*?)(?=^\w|^rule:|Z)/m);
		if (fixMatch) {
			return fixMatch[1]
				.split("\n")
				.map((line) => line.replace(/^\s*\|?\s*/, ""))
				.filter((line) => line.length > 0)
				.join("\n");
		}
	} catch {
		// Ignore errors
	}
	return undefined;
}

const astGrepRunner: RunnerDefinition = {
	id: "ast-grep",
	appliesTo: ["jsts", "python", "go", "rust", "cxx"],
	priority: 30,
	enabledByDefault: false,
	skipTestFiles: true, // Many rules are noisy in tests

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Check if ast-grep is available (use npx for local installs)
		const check = await safeSpawnAsync("npx", ["sg", "--version"], {
			timeout: 5000,
		});

		if (check.error || check.status !== 0) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Find ast-grep config
		const configPath = findAstGrepConfig(ctx.cwd);
		if (!configPath) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Run ast-grep scan on the file (use npx for local installs)
		const args = ["sg", "scan", "--config", configPath, "--json", ctx.filePath];

		const result = await safeSpawnAsync("npx", args, {
			timeout: 30000,
		});

		const raw = result.stdout + result.stderr;

		if (result.status === 0 && !raw.trim()) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// Parse results
		const diagnostics = parseAstGrepOutput(raw, ctx.filePath, configPath);

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
		path.join(cwd, "rules", "ast-grep-rules", ".sgconfig.yml"),
		path.join(cwd, ".sgconfig.yml"),
		path.join(cwd, "sgconfig.yml"),
		resolvePackagePath(import.meta.url, "rules", "ast-grep-rules", ".sgconfig.yml"),
	];

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	return undefined;
}

function parseAstGrepOutput(
	raw: string,
	filePath: string,
	_configPath?: string,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	// Try to parse as JSON
	// Determine rule directory for fix: extraction
	const ruleDir = _configPath
		? path.join(path.dirname(_configPath), "rules")
		: resolvePackagePath(import.meta.url, "rules", "ast-grep-rules", "rules");

	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			for (const item of parsed) {
				const line = item.range?.start?.line || 1;
				const ruleId = item.rule || "unknown";

				// Build message with inline fix suggestion
				let message = item.message || item.lines || "";
				let fixSuggestion: string | undefined;

				if (item.replacement) {
					// Show the actual code change inline in the message
					const replacementPreview =
						item.replacement.length > 40
							? `${item.replacement.substring(0, 40)}...`
							: item.replacement;
					message += `\n💡 Suggested fix: → "${replacementPreview}"`;
					fixSuggestion = `Replace with: ${item.replacement}`;
				} else {
					// Try to get fix: from rule YAML
					const ruleFix = extractFixFromRule(ruleId, ruleDir);
					if (ruleFix) {
						const fixPreview =
							ruleFix.length > 60 ? `${ruleFix.substring(0, 60)}...` : ruleFix;
						message += `\n💡 Suggested fix:\n${fixPreview}`;
						fixSuggestion = ruleFix;
					}
				}

				diagnostics.push({
					id: `ast-grep-${line}-${ruleId}`,
					message,
					filePath,
					line,
					severity: item.severity === "error" ? "error" : "warning",
					semantic: item.severity === "error" ? "blocking" : "warning",
					tool: "ast-grep",
					rule: ruleId,
					fixable: !!item.replacement || !!fixSuggestion,
					fixSuggestion,
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
