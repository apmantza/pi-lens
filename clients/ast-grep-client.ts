/**
 * AstGrep Client for pi-lens
 *
 * Structural code analysis using ast-grep CLI.
 * Scans files against YAML rule definitions.
 *
 * Requires: npm install -D @ast-grep/cli
 * Rules: ./rules/ directory
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { AstGrepParser } from "./ast-grep-parser.js";
import { AstGrepRuleManager } from "./ast-grep-rule-manager.js";
import { type SgMatch, SgRunner } from "./sg-runner.js";

const _getExtensionDir = () => {
	if (typeof __dirname !== "undefined") {
		return __dirname;
	}
	return ".";
};

// --- Types ---

export interface RuleDescription {
	id: string;
	message: string;
	note?: string;
	severity: "error" | "warning" | "info" | "hint";
	grade?: number;
}

export interface AstGrepMatch {
	file: string;
	range: {
		start: { line: number; column: number };
		end: { line: number; column: number };
	};
	text: string;
	replacement?: string;
}

export interface AstGrepDiagnostic {
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	severity: "error" | "warning" | "info" | "hint";
	message: string;
	rule: string;
	ruleDescription?: RuleDescription;
	file: string;
	fix?: string;
}

// --- Client ---

export class AstGrepClient {
	private available: boolean | null = null;
	private ruleDir: string;
	private log: (msg: string) => void;
	private ruleManager: AstGrepRuleManager;
	private runner: SgRunner;

	constructor(ruleDir?: string, verbose = false) {
		this.ruleDir = ruleDir || path.join(process.cwd(), "rules");
		this.log = verbose
			? (msg: string) => console.error(`[ast-grep] ${msg}`)
			: () => {};
		this.ruleManager = new AstGrepRuleManager(this.ruleDir, this.log);
		this.runner = new SgRunner(verbose);
	}

	/**
	 * Check if ast-grep CLI is available
	 */
	isAvailable(): boolean {
		if (this.available !== null) return this.available;
		this.available = this.runner.isAvailable();
		if (this.available) {
			this.log("ast-grep available");
		}
		return this.available;
	}

	/**
	 * Search for AST patterns in files
	 */
	async search(
		pattern: string,
		lang: string,
		paths: string[],
	): Promise<{ matches: AstGrepMatch[]; error?: string }> {
		return this.runner.exec([
			"run",
			"-p",
			pattern,
			"--lang",
			lang,
			"--json=compact",
			...paths,
		]);
	}

	/**
	 * Search and replace AST patterns
	 */
	async replace(
		pattern: string,
		rewrite: string,
		lang: string,
		paths: string[],
		apply = false,
	): Promise<{ matches: AstGrepMatch[]; applied: boolean; error?: string }> {
		const args = [
			"run",
			"-p",
			pattern,
			"-r",
			rewrite,
			"--lang",
			lang,
			"--json=compact",
		];
		if (apply) args.push("--update-all");
		args.push(...paths);

		const result = await this.runner.exec(args);
		return { matches: result.matches, applied: apply, error: result.error };
	}

	/**
	 * Run a one-off scan with a temporary rule and configuration
	 */
	private runTempScan(
		dir: string,
		ruleId: string,
		ruleYaml: string,
		timeout = 30000,
	): any[] {
		if (!this.isAvailable()) return [];
		return this.runner.tempScan(dir, ruleId, ruleYaml, timeout);
	}

	/**
	 * Find similar functions by comparing normalized AST structure
	 */
	async findSimilarFunctions(
		dir: string,
		lang: string = "typescript",
	): Promise<
		Array<{
			pattern: string;
			functions: Array<{ name: string; file: string; line: number }>;
		}>
	> {
		const ruleYaml = `id: find-functions
language: ${lang}
rule:
  kind: function_declaration
severity: info
message: found
`;

		const matches = this.runTempScan(dir, "find-functions", ruleYaml);
		if (matches.length === 0) return [];

		return this.groupSimilarFunctions(matches);
	}

	private groupSimilarFunctions(matches: any[]): Array<{
		pattern: string;
		functions: Array<{ name: string; file: string; line: number }>;
	}> {
		const grouped = new Map<
			string,
			Array<{ name: string; file: string; line: number }>
		>();

		for (const item of matches) {
			const name = this.extractFunctionName(item.text);
			if (!name) continue;

			const signature = this.normalizeFunction(item.text);
			const line =
				(item.range?.start?.line || item.labels?.[0]?.range?.start?.line || 0) +
				1;

			const group = grouped.get(signature) ?? [];
			group.push({ name, file: item.file, line });
			grouped.set(signature, group);
		}

		return Array.from(grouped.entries())
			.filter(([_, functions]) => functions.length > 1)
			.map(([pattern, functions]) => ({ pattern, functions }));
	}

	/**
	 * Extract function name from match text
	 */
	private extractFunctionName(text: string): string | null {
		return text.match(/function\s+(\w+)/)?.[1] ?? null;
	}

	private normalizeFunction(text: string): string {
		const normalizedText = text
			.replace(/function\s+\w+/, "function FN")
			.replace(/\bconst\b|\blet\b|\bvar\b/g, "VAR")
			.replace(/["'].*?["']/g, "STR")
			.replace(/`[^`]*`/g, "TMPL")
			.replace(/\b\d+\b/g, "NUM")
			.replace(/\btrue\b|\bfalse\b/g, "BOOL")
			.replace(/\/\/.*/g, "")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\s+/g, " ")
			.trim();

		// Extract just the body structure
		const bodyMatch = normalizedText.match(/\{(.*)\}/);
		const body = bodyMatch ? bodyMatch[1].trim() : normalizedText;

		// Use first 200 chars as signature
		return body.slice(0, 200);
	}

	/**
	 * Scan for exported function names in a directory
	 */
	async scanExports(
		dir: string,
		lang: string = "typescript",
	): Promise<Map<string, string>> {
		const exports = new Map<string, string>();
		const ruleYaml = `id: find-functions
language: ${lang}
rule:
  kind: function_declaration
severity: info
message: found
`;

		const matches = this.runTempScan(dir, "find-functions", ruleYaml, 15000);
		this.log(`scanExports output length: ${matches.length}`);

		for (const item of matches) {
			const text = item.text || "";
			const nameMatch = text.match(/function\s+(\w+)/);
			if (nameMatch?.[1]) {
				this.log(`scanExports found: ${nameMatch[1]} in ${item.file}`);
				exports.set(nameMatch[1], item.file);
			}
		}

		return exports;
	}

	formatMatches(matches: AstGrepMatch[], isDryRun = false): string {
		return this.runner.formatMatches(matches as SgMatch[], isDryRun);
	}

	/**
	 * Scan a file against all rules
	 */
	scanFile(filePath: string): AstGrepDiagnostic[] {
		if (!this.isAvailable()) return [];

		const absolutePath = path.resolve(filePath);
		if (!fs.existsSync(absolutePath)) return [];

		const configPath = path.join(this.ruleDir, ".sgconfig.yml");

		try {
			const result = spawnSync(
				"npx",
				["sg", "scan", "--config", configPath, "--json", absolutePath],
				{
					encoding: "utf-8",
					timeout: 15000,
					shell: true,
				},
			);

			// ast-grep exits 1 when it finds issues
			const output = result.stdout || result.stderr || "";
			if (!output.trim()) return [];

			const parser = new AstGrepParser(
				(id) => this.getRuleDescription(id),
				(sev) => this.mapSeverity(sev),
			);
			return parser.parseOutput(output, absolutePath);
		} catch (err: any) {
			this.log(`Scan error: ${err.message}`);
			return [];
		}
	}

	/**
	 * Format diagnostics for LLM consumption
	 */
	formatDiagnostics(diags: AstGrepDiagnostic[]): string {
		if (diags.length === 0) return "";

		const errors = diags.filter((d) => d.severity === "error");
		const warnings = diags.filter((d) => d.severity === "warning");
		const hints = diags.filter((d) => d.severity === "hint");

		let output = `[ast-grep] ${diags.length} structural issue(s)`;
		if (errors.length) output += ` — ${errors.length} error(s)`;
		if (warnings.length) output += ` — ${warnings.length} warning(s)`;
		if (hints.length) output += ` — ${hints.length} hint(s)`;
		output += ":\n";

		for (const d of diags.slice(0, 10)) {
			const loc =
				d.line === d.endLine ? `L${d.line}` : `L${d.line}-${d.endLine}`;
			const ruleInfo = d.ruleDescription
				? `${d.rule}: ${d.ruleDescription.message}`
				: d.rule;
			const fix = d.fix || d.ruleDescription?.note ? " [fixable]" : "";
			output += `  ${ruleInfo} (${loc})${fix}\n`;

			if (d.ruleDescription?.note) {
				const shortNote = d.ruleDescription.note.split("\n")[0];
				output += `    → ${shortNote}\n`;
			}
		}

		if (diags.length > 10) {
			output += `  ... and ${diags.length - 10} more\n`;
		}

		return output;
	}

	getRuleDescription(ruleId: string): RuleDescription | undefined {
		return this.ruleManager.loadRuleDescriptions().get(ruleId);
	}

	private mapSeverity(severity: string): AstGrepDiagnostic["severity"] {
		const lower = severity.toLowerCase();
		if (lower === "error") return "error";
		if (lower === "warning") return "warning";
		if (lower === "info") return "info";
		return "hint";
	}
}
