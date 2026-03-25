/**
 * Biome Client for pi-local
 *
 * All-in-one: formatting + linting for JS/TS/JSX/TSX/CSS/JSON
 * Replaces Prettier with 15-50x faster Rust-based tool.
 *
 * Requires: npm install @biomejs/biome (or npx @biomejs/biome)
 * Docs: https://biomejs.dev/
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// --- Types ---

export interface BiomeDiagnostic {
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	severity: "error" | "warning" | "info" | "hint";
	message: string;
	rule?: string;
	category: "lint" | "format";
	fixable: boolean;
}

interface BiomeJsonDiagnostic {
	message: string;
	severity: "error" | "warning" | "info" | "hint";
	category: string;
	span?: {
		start: { line: number; column: number };
		end: { line: number; column: number };
	};
	advice?: Array<{ message: string }>;
}

// --- Client ---

export class BiomeClient {
	private biomeAvailable: boolean | null = null;
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose
			? (msg: string) => console.log(`[biome] ${msg}`)
			: () => {};
	}

	/**
	 * Check if biome CLI is available
	 */
	isAvailable(): boolean {
		if (this.biomeAvailable !== null) return this.biomeAvailable;

		// Try npx biome first (works without global install)
		const result = spawnSync("npx", ["@biomejs/biome", "--version"], {
			encoding: "utf-8",
			timeout: 10000,
			shell: true,
		});

		this.biomeAvailable = !result.error && result.status === 0;
		if (this.biomeAvailable) {
			const version = result.stdout?.trim() || "unknown";
			this.log(`Biome found: ${version}`);
		} else {
			this.log(
				"Biome not available — install with: npm install -D @biomejs/biome",
			);
		}

		return this.biomeAvailable;
	}

	/**
	 * Check if a file is supported by Biome
	 */
	isSupportedFile(filePath: string): boolean {
		const ext = path.extname(filePath).toLowerCase();
		return [
			".js",
			".jsx",
			".ts",
			".tsx",
			".css",
			".json",
			".mjs",
			".cjs",
		].includes(ext);
	}

	/**
	 * Run biome check (format + lint) without fixing — returns diagnostics
	 */
	checkFile(filePath: string): BiomeDiagnostic[] {
		if (!this.isAvailable()) return [];

		const absolutePath = path.resolve(filePath);
		if (!fs.existsSync(absolutePath)) return [];

		try {
			const result = spawnSync(
				"npx",
				[
					"@biomejs/biome",
					"check",
					"--reporter=json",
					"--max-diagnostics=50",
					absolutePath,
				],
				{
					encoding: "utf-8",
					timeout: 15000,
					shell: true,
				},
			);

			// Biome exits 0 on success, 1 on issues found
			const output = result.stdout || "";
			if (!output.trim()) return [];

			return this.parseDiagnostics(output, absolutePath);
		} catch (err: any) {
			this.log(`Check error: ${err.message}`);
			return [];
		}
	}

	/**
	 * Format a file (writes to disk)
	 */
	formatFile(filePath: string): {
		success: boolean;
		changed: boolean;
		error?: string;
	} {
		if (!this.isAvailable())
			return { success: false, changed: false, error: "Biome not available" };

		const absolutePath = path.resolve(filePath);
		if (!fs.existsSync(absolutePath))
			return { success: false, changed: false, error: "File not found" };

		const content = fs.readFileSync(absolutePath, "utf-8");

		try {
			const result = spawnSync(
				"npx",
				["@biomejs/biome", "format", "--write", absolutePath],
				{
					encoding: "utf-8",
					timeout: 15000,
					shell: true,
				},
			);

			if (result.error) {
				return { success: false, changed: false, error: result.error.message };
			}

			// Re-read to see if changed
			const formatted = fs.readFileSync(absolutePath, "utf-8");
			const changed = content !== formatted;

			if (changed) {
				this.log(`Formatted ${path.basename(filePath)}`);
			}

			return { success: true, changed };
		} catch (err: any) {
			return { success: false, changed: false, error: err.message };
		}
	}

	/**
	 * Fix both formatting and linting issues (writes to disk)
	 */
	fixFile(filePath: string): {
		success: boolean;
		changed: boolean;
		fixed: number;
		error?: string;
	} {
		if (!this.isAvailable())
			return {
				success: false,
				changed: false,
				fixed: 0,
				error: "Biome not available",
			};

		const absolutePath = path.resolve(filePath);
		if (!fs.existsSync(absolutePath))
			return {
				success: false,
				changed: false,
				fixed: 0,
				error: "File not found",
			};

		const content = fs.readFileSync(absolutePath, "utf-8");

		try {
			// First, count issues before fixing
			const beforeDiags = this.checkFile(filePath);
			const fixableCount = beforeDiags.filter((d) => d.fixable).length;

			// Apply fixes
			const result = spawnSync(
				"npx",
				[
					"@biomejs/biome",
					"check",
					"--write",
					"--unsafe", // Apply unsafe fixes too
					absolutePath,
				],
				{
					encoding: "utf-8",
					timeout: 15000,
					shell: true,
				},
			);

			if (result.error) {
				return {
					success: false,
					changed: false,
					fixed: 0,
					error: result.error.message,
				};
			}

			const fixed = fs.readFileSync(absolutePath, "utf-8");
			const changed = content !== fixed;

			if (changed) {
				this.log(
					`Fixed ${fixableCount} issue(s) in ${path.basename(filePath)}`,
				);
			}

			return { success: true, changed, fixed: fixableCount };
		} catch (err: any) {
			return { success: false, changed: false, fixed: 0, error: err.message };
		}
	}

	/**
	 * Format diagnostics for LLM consumption
	 */
	formatDiagnostics(diags: BiomeDiagnostic[], _filename: string): string {
		if (diags.length === 0) return "";

		const lintIssues = diags.filter((d) => d.category === "lint");
		const formatIssues = diags.filter((d) => d.category === "format");
		const errors = diags.filter((d) => d.severity === "error");
		const fixable = diags.filter((d) => d.fixable);

		let result = `[Biome] ${diags.length} issue(s)`;
		if (lintIssues.length) result += ` — ${lintIssues.length} lint`;
		if (formatIssues.length) result += ` — ${formatIssues.length} format`;
		if (errors.length) result += ` — ${errors.length} error(s)`;
		if (fixable.length) result += ` — ${fixable.length} fixable`;
		result += ":\n";

		for (const d of diags.slice(0, 15)) {
			const loc =
				d.line === d.endLine
					? `L${d.line}:${d.column}`
					: `L${d.line}:${d.column}-L${d.endLine}:${d.endColumn}`;
			const rule = d.rule ? ` [${d.rule}]` : "";
			const fix = d.fixable ? " ✓" : "";
			result += `  ${loc}${rule} ${d.message}${fix}\n`;
		}

		if (diags.length > 15) {
			result += `  ... and ${diags.length - 15} more\n`;
		}

		return result;
	}

	/**
	 * Generate a diff-like summary of formatting changes
	 */
	getFormatDiff(filePath: string): string {
		if (!this.isAvailable()) return "";

		const absolutePath = path.resolve(filePath);
		if (!fs.existsSync(absolutePath)) return "";

		const content = fs.readFileSync(absolutePath, "utf-8");

		try {
			// Get formatted output without writing
			const result = spawnSync(
				"npx",
				["@biomejs/biome", "format", absolutePath],
				{
					encoding: "utf-8",
					timeout: 15000,
					shell: true,
				},
			);

			if (result.error || !result.stdout) return "";

			const formatted = result.stdout;
			if (content === formatted) return "";

			return this.computeDiff(content, formatted);
		} catch {
			return "";
		}
	}

	// --- Internal ---

	private parseDiagnostics(
		output: string,
		filterFile: string,
	): BiomeDiagnostic[] {
		try {
			// Biome JSON output: {"summary": {...}, "diagnostics": [...], ...}
			const result = JSON.parse(output);
			const diagnostics: BiomeDiagnostic[] = [];

			const diags = result.diagnostics || [];
			const filterPath = path.resolve(filterFile);

			for (const item of diags) {
				// Filter to our file
				const itemPath = item.location?.path;
				if (itemPath && path.resolve(itemPath) !== filterPath) continue;

				const loc = item.location || {};
				const start = loc.start || {};
				const end = loc.end || start;
				const isLint = item.category?.startsWith("lint/") || false;
				const isFormat = item.category === "format";
				const isAssist = item.category?.startsWith("assist/");

				// Skip non-lint/format diagnostics (like summaries)
				if (!isLint && !isFormat && !isAssist) continue;

				// Determine if fixable based on category
				const fixable =
					isFormat ||
					isAssist ||
					item.category?.includes("organizeImports") ||
					item.message?.includes("fix");

				diagnostics.push({
					line: start.line ?? 1,
					column: start.column ?? 1,
					endLine: end.line ?? start.line ?? 1,
					endColumn: end.column ?? start.column ?? 1,
					severity: item.severity || "warning",
					message: item.message || "Unknown issue",
					rule: isLint ? item.category?.replace("lint/", "") : undefined,
					category: isLint ? "lint" : "format",
					fixable,
				});
			}

			return diagnostics;
		} catch {
			this.log("Failed to parse biome JSON output");
			return [];
		}
	}

	private computeDiff(original: string, formatted: string): string {
		const origLines = original.split("\n");
		const formLines = formatted.split("\n");

		let changedLines = 0;
		const changes: string[] = [];

		const maxLen = Math.max(origLines.length, formLines.length);

		for (let i = 0; i < maxLen; i++) {
			const orig = origLines[i] ?? "";
			const form = formLines[i] ?? "";

			if (orig !== form) {
				changedLines++;
				if (changes.length < 5) {
					if (orig && form) {
						changes.push(
							`  L${i + 1}: \`${orig.trim()}\` → \`${form.trim()}\``,
						);
					} else if (!form) {
						changes.push(`  L${i + 1}: remove line`);
					} else {
						changes.push(`  L${i + 1}: add line`);
					}
				}
			}
		}

		let result = `  ${changedLines} line(s) would change`;
		if (origLines.length !== formLines.length) {
			result += ` (${origLines.length} → ${formLines.length} lines)`;
		}
		result += "\n";

		for (const c of changes) {
			result += `${c}\n`;
		}

		if (changedLines > 5) {
			result += `  ... and ${changedLines - 5} more\n`;
		}

		return result;
	}
}
