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
import { safeSpawnAsync } from "./safe-spawn.js";

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
	 * Check if a file is a Python file
	 */
	isPythonFile(filePath: string): boolean {
		return isFileKind(filePath, "python");
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
