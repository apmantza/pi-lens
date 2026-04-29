/**
 * Project rules scanner for pi-lens.
 *
 * Scans for rule files that other tools/agents may have left:
 * - .claude/rules/   — Claude Code rule files
 * - .agents/rules/   — Generic agent rule files
 * - .cursorrules     — Cursor IDE rules
 * - CLAUDE.md        — Claude Code project context
 * - AGENTS.md        — Generic agent context
 *
 * These are surfaced in the system prompt so the agent knows
 * to read them when relevant.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ProjectRule {
	source: string; // ".claude/rules", ".agents/rules", "root"
	name: string; // filename or display name
	filePath: string; // absolute path
	relativePath: string; // relative to cwd
}

export interface RuleScanResult {
	rules: ProjectRule[];
	hasCustomRules: boolean;
}

const RULE_DIRS = [
	{ dir: ".claude/rules", source: ".claude/rules" },
	{ dir: ".agents/rules", source: ".agents/rules" },
];

const RULE_FILES = [
	{ file: "CLAUDE.md", source: "root" },
	{ file: "AGENTS.md", source: "root" },
	{ file: ".cursorrules", source: "root" },
];

const PROMPT_RULES_MAX_TOTAL = 12;
const PROMPT_RULES_MAX_PER_SOURCE = 4;
const PROMPT_RULES_MAX_CHARS = 900;

function findMarkdownFiles(dir: string, baseDir: string): ProjectRule[] {
	const results: ProjectRule[] = [];

	if (!fs.existsSync(dir)) return results;

	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...findMarkdownFiles(fullPath, baseDir));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			results.push({
				source: path.relative(baseDir, dir) || path.basename(baseDir),
				name: entry.name,
				filePath: fullPath,
				relativePath: path.relative(baseDir, fullPath).replace(/\\/g, "/"),
			});
		}
	}
	return results;
}

export function scanProjectRules(cwd: string): RuleScanResult {
	const rules: ProjectRule[] = [];

	// Scan rule directories
	for (const { dir, source } of RULE_DIRS) {
		const dirPath = path.join(cwd, dir);
		if (fs.existsSync(dirPath)) {
			const found = findMarkdownFiles(dirPath, path.join(cwd, dir));
			for (const rule of found) {
				rules.push({
					source,
					name: rule.name,
					filePath: rule.filePath,
					relativePath: `${dir}/${rule.relativePath}`,
				});
			}
		}
	}

	// Check for root-level rule files
	for (const { file, source } of RULE_FILES) {
		const filePath = path.join(cwd, file);
		if (fs.existsSync(filePath)) {
			rules.push({
				source,
				name: file,
				filePath,
				relativePath: file,
			});
		}
	}

	return {
		rules,
		hasCustomRules: rules.length > 0,
	};
}

export function formatRulesForPrompt(result: RuleScanResult): string {
	if (!result.hasCustomRules) return "";

	// Group by source
	const bySource = new Map<string, ProjectRule[]>();
	for (const rule of result.rules) {
		const existing = bySource.get(rule.source) ?? [];
		existing.push(rule);
		bySource.set(rule.source, existing);
	}

	const sections: string[] = [];
	let emittedTotal = 0;

	const sortedSources = [...bySource.keys()].sort((a, b) => a.localeCompare(b));
	for (const source of sortedSources) {
		if (emittedTotal >= PROMPT_RULES_MAX_TOTAL) break;
		const rules = bySource.get(source) ?? [];
		const sortedRules = [...rules].sort((a, b) =>
			a.relativePath.localeCompare(b.relativePath),
		);

		const remainingBudget = PROMPT_RULES_MAX_TOTAL - emittedTotal;
		const shown = sortedRules.slice(
			0,
			Math.min(PROMPT_RULES_MAX_PER_SOURCE, remainingBudget),
		);
		emittedTotal += shown.length;

		const list = shown.map((r) => `- \`${r.relativePath}\``);
		if (sortedRules.length > shown.length) {
			list.push(`- ... and ${sortedRules.length - shown.length} more in ${source}`);
		}
		sections.push(`From ${source}/:\n${list.join("\n")}`);
	}

	const hidden = result.rules.length - emittedTotal;
	if (hidden > 0) {
		sections.push(`... and ${hidden} additional rule file(s) not listed.`);
	}

	const full = sections.join("\n\n");
	if (full.length <= PROMPT_RULES_MAX_CHARS) return full;
	return `${full.slice(0, PROMPT_RULES_MAX_CHARS)}\n... (truncated)`;
}
