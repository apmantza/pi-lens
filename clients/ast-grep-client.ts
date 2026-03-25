/**
 * AstGrep Client for pi-lens
 *
 * Structural code analysis using ast-grep CLI.
 * Scans files against YAML rule definitions.
 *
 * Requires: npm install -D @ast-grep/cli
 * Rules: ./rules/ directory
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// --- Types ---

export interface RuleDescription {
	id: string;
	message: string;
	note?: string;
	severity: "error" | "warning" | "info" | "hint";
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

// New ast-grep JSON format
interface AstGrepJsonDiagnostic {
	ruleId: string;
	severity: string;
	message: string;
	note?: string;
	labels: Array<{
		text: string;
		range: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		file?: string;
		style: string;
	}>;
	// Legacy format support
	Message?: { text: string };
	Severity?: string;
	spans?: Array<{
		context: string;
		range: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		file: string;
	}>;
	name?: string;
}

// --- Client ---

export class AstGrepClient {
	private available: boolean | null = null;
	private ruleDir: string;
	private log: (msg: string) => void;
	private ruleDescriptions: Map<string, RuleDescription> | null = null;

	constructor(ruleDir?: string, verbose = false) {
		this.ruleDir =
			ruleDir ||
			path.join(
				typeof __dirname !== "undefined" ? __dirname : ".",
				"..",
				"rules",
			);
		this.log = verbose
			? (msg: string) => console.log(`[ast-grep] ${msg}`)
			: () => {};
	}

	/**
	 * Load rule descriptions from YAML files
	 */
	private loadRuleDescriptions(): Map<string, RuleDescription> {
		if (this.ruleDescriptions !== null) return this.ruleDescriptions;

		const descriptions = new Map<string, RuleDescription>();

		// Find the rules directory - check more specific paths first
		const possiblePaths = [
			path.join(this.ruleDir, "ast-grep-rules", "rules"),
			path.join(this.ruleDir, "rules"),
			this.ruleDir,
		];

		const rulesPath = possiblePaths.find((p) => fs.existsSync(p));

		if (!rulesPath) {
			this.log(
				`Rule descriptions: no rules directory found in ${possiblePaths.join(", ")}`,
			);
			this.ruleDescriptions = descriptions;
			return descriptions;
		}

		try {
			const files = fs.readdirSync(rulesPath).filter((f) => f.endsWith(".yml"));
			this.log(`Loaded ${files.length} rule descriptions from ${rulesPath}`);
			for (const file of files) {
				const filePath = path.join(rulesPath, file);
				const content = fs.readFileSync(filePath, "utf-8");
				const rule = this.parseRuleYaml(content);
				if (rule) {
					descriptions.set(rule.id, rule);
				}
			}
		} catch (err: any) {
			this.log(`Failed to load rule descriptions: ${err.message}`);
		}

		this.ruleDescriptions = descriptions;
		return descriptions;
	}

	/**
	 * Simple YAML parser for rule descriptions
	 */
	private parseRuleYaml(content: string): RuleDescription | null {
		const result: Partial<RuleDescription> = {};

		// Extract id
		const idMatch = content.match(/^id:\s*(.+)$/m);
		if (idMatch) result.id = idMatch[1].trim();

		// Extract message (handle quoted strings)
		const msgMatch =
			content.match(/^message:\s*"([^"]+)"/m) ||
			content.match(/^message:\s*'([^']+)'/m) ||
			content.match(/^message:\s*(.+)$/m);
		if (msgMatch)
			result.message = (msgMatch[3] || msgMatch[2] || msgMatch[1]).trim();

		// Extract note (multiline, indented lines)
		const noteMatch = content.match(
			/^note:\s*\|([\s\S]*?)(?=^\w|\n\n|\nrule:)/m,
		);
		if (noteMatch) {
			result.note = noteMatch[1]
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
				.join(" ");
		}

		// Extract severity
		const sevMatch = content.match(/^severity:\s*(.+)$/m);
		if (sevMatch) result.severity = this.mapSeverity(sevMatch[1].trim());

		if (result.id && result.message) {
			return result as RuleDescription;
		}
		return null;
	}

	/**
	 * Check if ast-grep CLI is available
	 */
	isAvailable(): boolean {
		if (this.available !== null) return this.available;

		const result = spawnSync("npx", ["sg", "--version"], {
			encoding: "utf-8",
			timeout: 10000,
			shell: true,
		});

		this.available = !result.error && result.status === 0;
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
		return this.runSg([
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

		const result = await this.runSg(args);
		return { matches: result.matches, applied: apply, error: result.error };
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
		if (!this.isAvailable()) return [];

		const tmpDir = require("node:os").tmpdir();
		const ts = Date.now();
		const ruleDir = require("node:path").join(tmpDir, `pi-lens-similar-${ts}`);
		const rulesSubdir = require("node:path").join(ruleDir, "rules");
		const ruleFile = require("node:path").join(
			rulesSubdir,
			"find-functions.yml",
		);
		const configFile = require("node:path").join(ruleDir, ".sgconfig.yml");

		require("node:fs").mkdirSync(rulesSubdir, { recursive: true });
		require("node:fs").writeFileSync(configFile, `ruleDirs:\n  - ./rules\n`);
		require("node:fs").writeFileSync(
			ruleFile,
			`id: find-functions
language: ${lang}
rule:
  kind: function_declaration
severity: info
message: found
`,
		);

		try {
			const result = spawnSync(
				"npx",
				["sg", "scan", "--config", configFile, "--json", dir],
				{
					encoding: "utf-8",
					timeout: 30000,
					shell: true,
				},
			);

			const output = result.stdout || result.stderr || "";
			if (!output.trim()) return [];

			const items = JSON.parse(output);
			const matches = Array.isArray(items) ? items : [items];

			// Normalize each function by removing identifiers
			const normalized = new Map<
				string,
				Array<{ name: string; file: string; line: number }>
			>();

			for (const item of matches) {
				const text = item.text || "";
				const nameMatch = text.match(/function\s+(\w+)/);
				if (!nameMatch?.[1]) continue;

				// Normalize by replacing function name with FN, parameters with P1..Pn, and removing specific values
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
				const signature = body.slice(0, 200);

				if (!normalized.has(signature)) {
					normalized.set(signature, []);
				}

				const line =
					item.range?.start?.line || item.labels?.[0]?.range?.start?.line || 0;
				normalized.get(signature)?.push({
					name: nameMatch[1],
					file: item.file,
					line: line + 1,
				});
			}

			// Return groups with more than one function
			const result_groups: Array<{
				pattern: string;
				functions: Array<{ name: string; file: string; line: number }>;
			}> = [];
			for (const [pattern, functions] of normalized) {
				if (functions.length > 1) {
					result_groups.push({ pattern, functions });
				}
			}

			return result_groups;
		} catch {
			return [];
		} finally {
			try {
				require("node:fs").rmSync(ruleDir, { recursive: true, force: true });
			} catch (err) { void err; }
		}
	}

	/**
	 * Scan for exported function names in a directory
	 */
	async scanExports(
		dir: string,
		lang: string = "typescript",
	): Promise<Map<string, string>> {
		const exports = new Map<string, string>();

		if (!this.isAvailable()) {
			return exports;
		}

		const tmpDir = require("node:os").tmpdir();
		const ts = Date.now();
		const ruleDir = require("node:path").join(tmpDir, `pi-lens-exports-${ts}`);
		const rulesSubdir = require("node:path").join(ruleDir, "rules");
		const ruleFile = require("node:path").join(
			rulesSubdir,
			"find-functions.yml",
		);
		const configFile = require("node:path").join(ruleDir, ".sgconfig.yml");

		require("node:fs").mkdirSync(rulesSubdir, { recursive: true });

		require("node:fs").writeFileSync(configFile, `ruleDirs:\n  - ./rules\n`);
		require("node:fs").writeFileSync(
			ruleFile,
			`id: find-functions
language: ${lang}
rule:
  kind: function_declaration
severity: info
message: found
`,
		);

		try {
			const result = spawnSync(
				"npx",
				["sg", "scan", "--config", configFile, "--json", dir],
				{
					encoding: "utf-8",
					timeout: 15000,
					shell: true,
				},
			);

			const output = result.stdout || result.stderr || "";
			this.log(`scanExports output length: ${output.length}`);
			if (output.trim()) {
				try {
					const items = JSON.parse(output);
					const matches = Array.isArray(items) ? items : [items];

					for (const item of matches) {
						const text = item.text || "";
						const nameMatch = text.match(/function\s+(\w+)/);
						if (nameMatch?.[1]) {
							this.log(`scanExports found: ${nameMatch[1]} in ${item.file}`);
							exports.set(nameMatch[1], item.file);
						}
					}
				} catch (e) {
					this.log(`scanExports parse error: ${e}`);
				}
			}
		} catch (err: any) {
			this.log(`scanExports error: ${err.message}`);
		} finally {
			try {
				require("node:fs").rmSync(ruleDir, { recursive: true, force: true });
			} catch (err) { void err; }
		}

		return exports;
	}

	private runSg(
		args: string[],
	): Promise<{ matches: AstGrepMatch[]; error?: string }> {
		return new Promise((resolve) => {
			const proc = spawn("npx", ["sg", ...args], {
				stdio: ["ignore", "pipe", "pipe"],
				shell: true,
			});
			let stdout = "";
			let stderr = "";

			proc.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
			proc.stderr.on("data", (data: Buffer) => (stderr += data.toString()));

			proc.on("error", (err: Error) => {
				if (err.message.includes("ENOENT")) {
					resolve({
						matches: [],
						error: "ast-grep CLI not found. Install: npm i -D @ast-grep/cli",
					});
				} else {
					resolve({ matches: [], error: err.message });
				}
			});

			proc.on("close", (code: number | null) => {
				if (code !== 0 && !stdout.trim()) {
					resolve({
						matches: [],
						error: stderr.includes("No files found")
							? undefined
							: stderr.trim() || `Exit code ${code}`,
					});
					return;
				}
				if (!stdout.trim()) {
					resolve({ matches: [] });
					return;
				}
				try {
					const parsed = JSON.parse(stdout);
					const matches = Array.isArray(parsed) ? parsed : [parsed];
					resolve({ matches });
				} catch {
					resolve({ matches: [], error: "Failed to parse output" });
				}
			});
		});
	}

	formatMatches(matches: AstGrepMatch[], isDryRun = false): string {
		if (matches.length === 0) return "No matches found";
		const MAX = 50;
		const shown = matches.slice(0, MAX);
		const lines = shown.map((m) => {
			const loc = `${m.file}:${m.range.start.line + 1}:${m.range.start.column + 1}`;
			const text = m.text.length > 100 ? `${m.text.slice(0, 100)}...` : m.text;
			return isDryRun && m.replacement
				? `${loc}\n  - ${text}\n  + ${m.replacement}`
				: `${loc}: ${text}`;
		});
		if (matches.length > MAX)
			lines.unshift(`Found ${matches.length} matches (showing first ${MAX}):`);
		return lines.join("\n");
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

			return this.parseOutput(output, absolutePath);
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

			// Include note for actionable guidance
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

	// --- Internal ---

	private parseOutput(output: string, filterFile: string): AstGrepDiagnostic[] {
		const diagnostics: AstGrepDiagnostic[] = [];
		const resolvedFilterFile = path.resolve(filterFile);

		// Try parsing as JSON array first (new format)
		try {
			const items: AstGrepJsonDiagnostic[] = JSON.parse(output);
			if (Array.isArray(items)) {
				for (const item of items) {
					const diag = this.parseDiagnostic(item, resolvedFilterFile);
					if (diag) diagnostics.push(diag);
				}
				return diagnostics;
			}
		} catch {
			// Not a JSON array, try ndjson format (legacy)
		}

		// Parse ndjson (one JSON object per line) - legacy format
		const lines = output.split("\n").filter((l) => l.trim());

		for (const line of lines) {
			try {
				const item: AstGrepJsonDiagnostic = JSON.parse(line);
				const diag = this.parseDiagnostic(item, resolvedFilterFile);
				if (diag) diagnostics.push(diag);
			} catch {
				// Skip unparseable lines
			}
		}

		return diagnostics;
	}

	private parseDiagnostic(
		item: AstGrepJsonDiagnostic,
		filterFile: string,
	): AstGrepDiagnostic | null {
		// New format uses labels array
		if (item.labels && item.labels.length > 0) {
			const label =
				item.labels.find((l) => l.style === "primary") || item.labels[0];
			const filePath = path.resolve(label.file || filterFile);

			// Filter to our file
			if (filePath !== filterFile) return null;

			const start = label.range?.start || { line: 0, column: 0 };
			const end = label.range?.end || start;

			return {
				line: start.line + 1, // ast-grep is 0-indexed, we want 1-indexed
				column: start.column,
				endLine: end.line + 1,
				endColumn: end.column,
				severity: this.mapSeverity(item.severity),
				message: item.message || "Unknown issue",
				rule: item.ruleId || "unknown",
				ruleDescription: this.getRuleDescription(item.ruleId || "unknown"),
				file: filePath,
			};
		}

		// Legacy format uses spans array
		if (item.spans && item.spans.length > 0) {
			const span = item.spans[0];
			const filePath = path.resolve(span.file || filterFile);

			// Filter to our file
			if (filePath !== filterFile) return null;

			const start = span.range?.start || { line: 0, column: 0 };
			const end = span.range?.end || start;

			const ruleId = item.name || item.ruleId || "unknown";
			return {
				line: start.line + 1,
				column: start.column,
				endLine: end.line + 1,
				endColumn: end.column,
				severity: this.mapSeverity(item.severity || item.Severity || "warning"),
				message: item.Message?.text || item.message || "Unknown issue",
				rule: ruleId,
				ruleDescription: this.getRuleDescription(ruleId),
				file: filePath,
			};
		}

		return null;
	}

	getRuleDescription(ruleId: string): RuleDescription | undefined {
		const descriptions = this.loadRuleDescriptions();
		return descriptions.get(ruleId);
	}

	private mapSeverity(severity: string): AstGrepDiagnostic["severity"] {
		const lower = severity.toLowerCase();
		if (lower === "error") return "error";
		if (lower === "warning") return "warning";
		if (lower === "info") return "info";
		return "hint";
	}
}
