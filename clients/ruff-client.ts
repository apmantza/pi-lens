/**
 * Ruff Client for pi-lens
 *
 * Fast Python linting and formatting via Ruff CLI.
 * Replaces flake8, pylint, isort, black, pyupgrade.
 *
 * Requires: pip install ruff
 * Docs: https://docs.astral.sh/ruff/
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isFileKind } from "./file-kinds.js";
import { safeSpawn, safeSpawnAsync } from "./safe-spawn.js";

// --- Types ---

export interface RuffDiagnostic {
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	severity: "error" | "warning";
	message: string;
	rule: string;
	file: string;
	fixable: boolean;
}

// ruff check --output-format json
interface RuffJsonDiagnostic {
	code: string | null;
	message: string;
	location: { row: number; column: number };
	end_location: { row: number; column: number };
	fix: { applicability: string } | null;
	filename: string;
}

// --- Client ---

export class RuffClient {
	private ruffAvailable: boolean | null = null;
	private ensureInFlight: Promise<boolean> | null = null;
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose
			? (msg: string) => console.error(`[ruff] ${msg}`)
			: () => {};
	}

	/**
	 * Check if ruff CLI is available, auto-install if not.
	 *
	 * Re-entrancy safe: concurrent first-time callers share a single
	 * `ensureInFlight` promise so probing/auto-install isn't duplicated.
	 * Mirrors the dedupe pattern in `SgRunner` / `KnipClient` /
	 * `DependencyChecker`.
	 */
	async ensureAvailable(): Promise<boolean> {
		if (this.ruffAvailable !== null) return this.ruffAvailable;
		if (this.ensureInFlight) return this.ensureInFlight;

		this.ensureInFlight = this.doEnsureAvailable();
		try {
			return await this.ensureInFlight;
		} finally {
			this.ensureInFlight = null;
		}
	}

	private async doEnsureAvailable(): Promise<boolean> {
		// Check if available in PATH
		const result = await safeSpawnAsync("ruff", ["--version"], {
			timeout: 5000,
		});
		this.ruffAvailable = !result.error && result.status === 0;

		if (this.ruffAvailable) {
			this.log(`Ruff found: ${result.stdout.trim()}`);
			return true;
		}

		// Auto-install via pi-lens installer
		this.log("Ruff not found, attempting auto-install...");
		const { ensureTool } = await import("./installer/index.js");
		const installedPath = await ensureTool("ruff");

		if (installedPath) {
			this.log(`Ruff auto-installed: ${installedPath}`);
			this.ruffAvailable = true;
			return true;
		}

		this.log("Ruff auto-install failed");
		return false;
	}

	/**
	 * Check if ruff CLI is available (legacy sync method)
	 * Prefer ensureAvailable() for auto-install behavior
	 */
	isAvailable(): boolean {
		if (this.ruffAvailable !== null) return this.ruffAvailable;

		try {
			const result = safeSpawn("ruff", ["--version"], {
				timeout: 5000,
			});
			this.ruffAvailable = !result.error && result.status === 0;
			if (this.ruffAvailable) {
				this.log(`Ruff found: ${result.stdout.trim()}`);
			}
		} catch (err) {
			void err;
			this.ruffAvailable = false;
		}

		return this.ruffAvailable;
	}

	/**
	 * Check if a file is a Python file
	 */
	isPythonFile(filePath: string): boolean {
		return isFileKind(filePath, "python");
	}

	/**
	 * Lint a Python file
	 */
	checkFile(filePath: string): RuffDiagnostic[] {
		if (!this.isAvailable()) return [];

		const absolutePath = path.resolve(filePath);
		if (!fs.existsSync(absolutePath)) return [];

		try {
			const result = safeSpawn(
				"ruff",
				[
					"check",
					"--output-format",
					"json",
					"--target-version",
					"py310",
					absolutePath,
				],
				{
					timeout: 10000,
				},
			);

			// ruff exits 1 when it finds issues (normal)
			const output = result.stdout || "";
			if (!output.trim()) return [];

			return this.parseOutput(output, absolutePath);
		} catch (err: any) {
			this.log(`Check error: ${err.message}`);
			return [];
		}
	}

	/**
	 * Check if file has formatting issues (ruff format --check)
	 */
	checkFormatting(filePath: string): string {
		if (!this.isAvailable()) return "";

		const absolutePath = path.resolve(filePath);
		if (!fs.existsSync(absolutePath)) return "";

		try {
			const result = safeSpawn(
				"ruff",
				["format", "--check", "--diff", absolutePath],
				{
					timeout: 10000,
				},
			);

			// ruff format --check exits 1 when changes needed
			if (result.status === 0) return "";

			const diff = result.stdout || "";
			if (!diff.trim()) return "";

			// Count lines that would change
			const diffLines = diff
				.split("\n")
				.filter((l) => l.startsWith("+") || l.startsWith("-")).length;
			return `[Ruff Format] ${diffLines} line(s) would change — run 'ruff format ${path.basename(filePath)}' to fix`;
		} catch (err) {
			void err;
			return "";
		} // Intentionally return empty string on diff failure
	}

	/**
	 * Auto-fix linting issues (writes to disk)
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
				error: "Ruff not available",
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
			const beforeDiags = this.checkFile(filePath);
			const fixableCount = beforeDiags.filter((d) => d.fixable).length;

			const result = safeSpawn("ruff", ["check", "--fix", absolutePath], {
				timeout: 15000,
			});

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
				error: "Ruff not available",
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

			const pre = await safeSpawnAsync(
				"ruff",
				[
					"check",
					"--output-format",
					"json",
					"--target-version",
					"py310",
					absolutePath,
				],
				{ timeout: 10000 },
			);
			const beforeDiags = pre.stdout?.trim()
				? this.parseOutput(pre.stdout, absolutePath)
				: [];
			const fixableCount = beforeDiags.filter((d) => d.fixable).length;

			const fix = await safeSpawnAsync(
				"ruff",
				["check", "--fix", absolutePath],
				{ timeout: 15000 },
			);

			if (fix.error) {
				return {
					success: false,
					changed: false,
					fixed: 0,
					error: fix.error.message,
				};
			}

			const after = await fs.promises.readFile(absolutePath, "utf-8");
			const changed = before !== after;

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
	 * Fix multiple Python files at once (much faster than file-by-file)
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
				error: "Ruff not available",
			};
		}

		// Filter to existing Python files
		const validFiles = filePaths
			.map((f) => path.resolve(f))
			.filter((f) => fs.existsSync(f) && f.endsWith(".py"));

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

			// Run ruff once on all files - much faster than per file
			const result = safeSpawn("ruff", ["check", "--fix", ...validFiles], {
				timeout: 60000, // Longer timeout for batch
			});

			if (result.error) {
				return {
					success: false,
					fixed: 0,
					changed: 0,
					error: result.error.message,
				};
			}

			this.log(
				`Fixed ${totalFixable} issue(s) in ${validFiles.length} file(s)`,
			);

			return { success: true, fixed: totalFixable, changed: validFiles.length };
		} catch (err: any) {
			return {
				success: false,
				fixed: 0,
				changed: 0,
				error: err.message,
			};
		}
	}

	/**
	 * Format a Python file (writes to disk)
	 */
	formatFile(filePath: string): {
		success: boolean;
		changed: boolean;
		error?: string;
	} {
		if (!this.isAvailable())
			return { success: false, changed: false, error: "Ruff not available" };

		const absolutePath = path.resolve(filePath);
		if (!fs.existsSync(absolutePath))
			return { success: false, changed: false, error: "File not found" };

		const content = fs.readFileSync(absolutePath, "utf-8");

		try {
			const result = safeSpawn("ruff", ["format", absolutePath], {
				timeout: 10000,
			});

			if (result.error) {
				return { success: false, changed: false, error: result.error.message };
			}

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
	 * Format diagnostics for LLM consumption
	 */
	formatDiagnostics(diags: RuffDiagnostic[]): string {
		if (diags.length === 0) return "";

		const errors = diags.filter((d) => d.severity === "error");
		const warnings = diags.filter((d) => d.severity === "warning");
		const fixable = diags.filter((d) => d.fixable);

		let result = `[Ruff] ${diags.length} issue(s)`;
		if (errors.length) result += ` — ${errors.length} error(s)`;
		if (warnings.length) result += ` — ${warnings.length} warning(s)`;
		if (fixable.length) result += ` — ${fixable.length} auto-fixable`;
		result += ":\n";

		for (const d of diags.slice(0, 15)) {
			const loc =
				d.line === d.endLine
					? `L${d.line}:${d.column}-${d.endColumn}`
					: `L${d.line}:${d.column}-L${d.endLine}:${d.endColumn}`;
			const fix = d.fixable ? " [fixable]" : "";
			result += `  [${d.rule}] ${loc} ${d.message}${fix}\n`;
		}

		if (diags.length > 15) {
			result += `  ... and ${diags.length - 15} more\n`;
		}

		if (fixable.length > 0) {
			result += `\n  Run 'ruff check --fix ${path.basename(diags[0].file)}' to auto-fix ${fixable.length} issue(s)\n`;
		}

		return result;
	}

	// --- Internal ---

	private parseOutput(output: string, filterFile?: string): RuffDiagnostic[] {
		if (!output.trim()) return [];

		try {
			const items: RuffJsonDiagnostic[] = JSON.parse(output);
			const diagnostics: RuffDiagnostic[] = [];

			for (const item of items) {
				// Filter to single file if requested
				if (filterFile && path.resolve(item.filename) !== filterFile) continue;

				diagnostics.push({
					line: item.location.row - 1, // ruff is 1-indexed
					column: item.location.column - 1,
					endLine: item.end_location.row - 1,
					endColumn: item.end_location.column - 1,
					severity: item.code?.startsWith("E") ? "error" : "warning",
					message: item.message,
					rule: item.code || "unknown",
					file: item.filename,
					fixable: item.fix !== null,
				});
			}

			return diagnostics;
		} catch (err) {
			void err;
			this.log("Failed to parse ruff JSON output");
			return [];
		}
	}
}
