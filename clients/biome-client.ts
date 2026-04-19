/**
 * Biome Client for pi-lens
 *
 * All-in-one: formatting + linting for JS/TS/JSX/TSX/CSS/JSON
 * Replaces Prettier with 15-50x faster Rust-based tool.
 *
 * Requires: npm install @biomejs/biome (or npx @biomejs/biome)
 * Docs: https://biomejs.dev/
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isFileKind } from "./file-kinds.js";
import { safeSpawn, safeSpawnAsync } from "./safe-spawn.js";

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
	private localBinaryPath: string | null = null;
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose
			? (msg: string) => console.error(`[biome] ${msg}`)
			: () => {};
	}

	/**
	 * Resolve the fastest available biome binary.
	 * Prefers local node_modules/.bin/biome (skip npx overhead ~1s).
	 * Falls back to global biome, then npx.
	 */
	private getBiomeBinary(): { cmd: string; args: string[] } {
		if (this.localBinaryPath) return { cmd: this.localBinaryPath, args: [] };

		// Walk up from cwd looking for node_modules/.bin/biome.
		// Also check ~/.pi-lens/tools (where ensureTool("biome") auto-installs),
		// so we avoid the ~1.5s `npx @biomejs/biome --version` fallback when
		// the tool is already installed but not in the project's node_modules.
		// On Windows prefer .cmd (native batch) over the sh wrapper — 2x faster.
		const isWin = process.platform === "win32";
		const piLensBin = path.join(
			os.homedir(),
			".pi-lens",
			"tools",
			"node_modules",
			".bin",
		);
		const candidates = isWin
			? [
					path.join(process.cwd(), "node_modules", ".bin", "biome.cmd"),
					path.join(process.cwd(), "node_modules", ".bin", "biome"),
					path.join(piLensBin, "biome.cmd"),
					path.join(piLensBin, "biome"),
				]
			: [
					path.join(process.cwd(), "node_modules", ".bin", "biome"),
					path.join(process.cwd(), "node_modules", ".bin", "biome.cmd"),
					path.join(piLensBin, "biome"),
				];
		for (const p of candidates) {
			if (fs.existsSync(p)) {
				this.localBinaryPath = p;
				return { cmd: p, args: [] };
			}
		}
		// Fallback: npx (slower but works anywhere)
		return { cmd: "npx", args: ["@biomejs/biome"] };
	}

	/**
	 * Spawn biome with the fastest available binary.
	 */
	private spawnBiome(args: string[], timeout = 15000) {
		const { cmd, args: prefix } = this.getBiomeBinary();
		return safeSpawn(cmd, [...prefix, ...args], { timeout });
	}

	private async spawnBiomeAsync(args: string[], timeout = 15000) {
		const { cmd, args: prefix } = this.getBiomeBinary();
		return safeSpawnAsync(cmd, [...prefix, ...args], { timeout });
	}

	/**
	 * Check if biome CLI is available
	 */
	isAvailable(): boolean {
		if (this.biomeAvailable !== null) return this.biomeAvailable;

		const result = this.spawnBiome(["--version"], 10000);

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
	 * Ensure Biome is available, auto-installing if necessary.
	 * Prefer this over isAvailable() for auto-install behavior.
	 */
	async ensureAvailable(): Promise<boolean> {
		if (this.biomeAvailable !== null) return this.biomeAvailable;

		// Check if already available
		const result = this.spawnBiome(["--version"], 10000);
		if (!result.error && result.status === 0) {
			this.biomeAvailable = true;
			return true;
		}

		// Auto-install via pi-lens installer
		this.log("Biome not found, attempting auto-install...");
		const { ensureTool } = await import("./installer/index.js");
		const installedPath = await ensureTool("biome");

		if (installedPath) {
			this.log(`Biome auto-installed: ${installedPath}`);
			// Set the installed path as local binary to avoid npx overhead
			this.localBinaryPath = installedPath;
			this.biomeAvailable = true;
			return true;
		}

		this.log("Biome auto-install failed");
		this.biomeAvailable = false;
		return false;
	}

	/**
	 * Check if a file is supported by Biome
	 */
	isSupportedFile(filePath: string): boolean {
		return isFileKind(filePath, ["jsts", "json", "css"]);
	}

	// --- Internal helpers ---

	/**
	 * Validate path and availability — returns path or null on failure
	 */
	private withValidatedPath(filePath: string): string | null {
		if (!this.isAvailable()) return null;

		const absolutePath = path.resolve(filePath);
		if (!fs.existsSync(absolutePath)) return null;

		return absolutePath;
	}

	/**
	 * Run biome check (format + lint) without fixing — returns diagnostics
	 */
	checkFile(filePath: string): BiomeDiagnostic[] {
		const absolutePath = this.withValidatedPath(filePath);
		if (!absolutePath) return [];

		try {
			const result = this.spawnBiome([
				"check",
				"--reporter=json",
				"--max-diagnostics=50",
				absolutePath,
			]);

			// Biome exits 0 on success, 1 on issues found
			const output = result.stdout || "";
			if (!output.trim()) return [];

			return this.parseDiagnostics(output, absolutePath);
		} catch (err) {
			this.log(
				`Check error: ${err instanceof Error ? err.message : String(err)}`,
			);
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
		const absolutePath = this.withValidatedPath(filePath);
		if (!absolutePath)
			return {
				success: false,
				changed: false,
				error: this.isAvailable() ? "File not found" : "Biome not available",
			};

		const content = fs.readFileSync(absolutePath, "utf-8");

		try {
			const result = this.spawnBiome(["format", "--write", absolutePath]);

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
		} catch (err) {
			return {
				success: false,
				changed: false,
				error: err instanceof Error ? err.message : String(err),
			};
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
		const absolutePath = this.withValidatedPath(filePath);
		if (!absolutePath)
			return {
				success: false,
				changed: false,
				fixed: 0,
				error: this.isAvailable() ? "File not found" : "Biome not available",
			};

		const content = fs.readFileSync(absolutePath, "utf-8");

		try {
			// Single invocation: check --write applies safe formatting + lint fixes.
			// No pre-flight checkFile() needed — content diff tells us if anything changed.
			const result = this.spawnBiome(["check", "--write", absolutePath]);

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
				this.log(`Fixed issue(s) in ${path.basename(filePath)}`);
			}

			return { success: true, changed, fixed: changed ? 1 : 0 };
		} catch (err) {
			return {
				success: false,
				changed: false,
				fixed: 0,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * Async auto-fix variant for pipeline use (non-blocking spawn).
	 */
	async fixFileAsync(filePath: string): Promise<{
		success: boolean;
		changed: boolean;
		fixed: number;
		error?: string;
	}> {
		if (!(await this.ensureAvailable())) {
			return {
				success: false,
				changed: false,
				fixed: 0,
				error: "Biome not available",
			};
		}

		const absolutePath = path.resolve(filePath);
		if (!fs.existsSync(absolutePath)) {
			return {
				success: false,
				changed: false,
				fixed: 0,
				error: "File not found",
			};
		}

		try {
			const before = await fs.promises.readFile(absolutePath, "utf-8");
			const result = await this.spawnBiomeAsync([
				"check",
				"--write",
				absolutePath,
			]);

			if (result.error) {
				return {
					success: false,
					changed: false,
					fixed: 0,
					error: result.error.message,
				};
			}

			const after = await fs.promises.readFile(absolutePath, "utf-8");
			const changed = before !== after;

			if (changed) {
				this.log(`Fixed issue(s) in ${path.basename(filePath)}`);
			}

			return { success: true, changed, fixed: changed ? 1 : 0 };
		} catch (err) {
			return {
				success: false,
				changed: false,
				fixed: 0,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * Fix multiple files at once (much faster than file-by-file)
	 */
	fixFiles(filePaths: string[]): {
		success: boolean;
		fixed: number;
		changed: number;
		error?: string;
	} {
		if (!this.isAvailable()) {
			return {
				success: false,
				fixed: 0,
				changed: 0,
				error: "Biome not available",
			};
		}

		// Filter to existing files
		const validFiles = filePaths
			.map((f) => path.resolve(f))
			.filter((f) => fs.existsSync(f));

		if (validFiles.length === 0) {
			return { success: true, fixed: 0, changed: 0 };
		}

		try {
			// Count fixable issues before fixing
			let totalFixable = 0;
			for (const file of validFiles) {
				const diags = this.checkFile(file);
				totalFixable += diags.filter((d) => d.fixable).length;
			}

			// Run biome once on all files - much faster than npx per file
			const result = safeSpawn(
				"npx",
				["@biomejs/biome", "check", "--write", "--unsafe", ...validFiles],
				{
					timeout: 60000, // Longer timeout for batch
				},
			);

			if (result.error) {
				return {
					success: false,
					fixed: 0,
					changed: 0,
					error: result.error.message,
				};
			}

			// Count how many files actually changed
			let changedCount = 0;
			for (const _file of validFiles) {
				// We don't know exactly which files changed without re-reading,
				// so we report total files processed
				changedCount++;
			}

			this.log(
				`Fixed ${totalFixable} issue(s) in ${validFiles.length} file(s)`,
			);

			return { success: true, fixed: totalFixable, changed: changedCount };
		} catch (err) {
			return {
				success: false,
				fixed: 0,
				changed: 0,
				error: err instanceof Error ? err.message : String(err),
			};
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
		const absolutePath = this.withValidatedPath(filePath);
		if (!absolutePath) return "";

		const content = fs.readFileSync(absolutePath, "utf-8");

		try {
			// Get formatted output without writing
			const result = safeSpawn(
				"npx",
				["@biomejs/biome", "format", absolutePath],
				{
					timeout: 15000,
				},
			);

			if (result.error || !result.stdout) return "";

			const formatted = result.stdout;
			if (content === formatted) return "";

			return this.computeDiff(content, formatted);
		} catch (err) {
			void err;
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
		} catch (err) {
			void err;
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
