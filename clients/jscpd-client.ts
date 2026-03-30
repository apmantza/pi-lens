/**
 * jscpd Client for pi-lens
 *
 * Detects copy-paste / duplicate code blocks across the project.
 * Helps the agent avoid unknowingly duplicating logic that already exists.
 *
 * Requires: npm install -D jscpd
 * Docs: https://github.com/kucherenko/jscpd
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { safeSpawn } from "./safe-spawn.js";

// --- Types ---

export interface DuplicateClone {
	fileA: string;
	startA: number;
	fileB: string;
	startB: number;
	lines: number;
	tokens: number;
}

export interface JscpdResult {
	success: boolean;
	clones: DuplicateClone[];
	duplicatedLines: number;
	totalLines: number;
	percentage: number;
}

// --- Client ---

export class JscpdClient {
	private available: boolean | null = null;
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose ? (msg) => console.error(`[jscpd] ${msg}`) : () => {};
	}

	isAvailable(): boolean {
		if (this.available !== null) return this.available;
		const result = safeSpawn("npx", ["jscpd", "--version"], {
			timeout: 5000,
		});
		this.available = !result.error && result.status === 0;
		return this.available;
	}

	/**
	 * Scan a directory for duplicate code blocks.
	 * Uses a temp output dir to capture JSON report.
	 */
	scan(cwd: string, minLines = 5, minTokens = 50): JscpdResult {
		// Return early for non-existent or empty directories
		if (!fs.existsSync(cwd)) {
			return {
				success: false,
				clones: [],
				duplicatedLines: 0,
				totalLines: 0,
				percentage: 0,
			};
		}
		const entries = fs.readdirSync(cwd);
		const hasSourceFiles = entries.some(
			(e) => /\.(ts|tsx|js|jsx)$/.test(e) && !e.endsWith(".d.ts"),
		);
		if (!hasSourceFiles) {
			return {
				success: true,
				clones: [],
				duplicatedLines: 0,
				totalLines: 0,
				percentage: 0,
			};
		}

		if (!this.isAvailable()) {
			return {
				success: false,
				clones: [],
				duplicatedLines: 0,
				totalLines: 0,
				percentage: 0,
			};
		}

		const outDir = path.join(os.tmpdir(), `pi-lens-jscpd-${Date.now()}`);
		fs.mkdirSync(outDir, { recursive: true });

		try {
			safeSpawn(
				"npx",
				[
					"jscpd",
					".",
					"--min-lines",
					String(minLines),
					"--min-tokens",
					String(minTokens),
					"--reporters",
					"json",
					"--output",
					outDir,
					"--ignore",
					"**/node_modules/**,**/dist/**,**/build/**,**/.git/**,**/.pi-lens/**,**/*.md,**/*.txt,**/*.json,**/*.yaml,**/*.yml,**/*.toml,**/*.lock,**/*.test.*,**/*.spec.*,**/*.poc.test.*,**/__tests__/**,**/tests/**"
				],
				{
					timeout: 30000,
					cwd,
				},
			);

			const reportPath = path.join(outDir, "jscpd-report.json");
			if (!fs.existsSync(reportPath)) {
				return {
					success: true,
					clones: [],
					duplicatedLines: 0,
					totalLines: 0,
					percentage: 0,
				};
			}

			return this.parseReport(reportPath);
		} catch (err: any) {
			this.log(`Scan error: ${err.message}`);
			return {
				success: false,
				clones: [],
				duplicatedLines: 0,
				totalLines: 0,
				percentage: 0,
			};
		} finally {
			try {
				fs.rmSync(outDir, { recursive: true, force: true });
			} catch (err) {
				void err;
			}
		}
	}

	formatResult(result: JscpdResult, maxClones = 8): string {
		if (!result.success || result.clones.length === 0) return "";

		const pct = result.percentage.toFixed(1);
		let output = `[jscpd] ${result.clones.length} duplicate block(s) — ${pct}% of codebase (${result.duplicatedLines}/${result.totalLines} lines):\n`;

		for (const clone of result.clones.slice(0, maxClones)) {
			const a = `${path.basename(clone.fileA)}:${clone.startA}`;
			const b = `${path.basename(clone.fileB)}:${clone.startB}`;
			output += `  ${clone.lines} lines — ${a} ↔ ${b}\n`;
		}

		if (result.clones.length > maxClones) {
			output += `  ... and ${result.clones.length - maxClones} more\n`;
		}

		return output;
	}

	// --- Internal ---

	private parseReport(reportPath: string): JscpdResult {
		try {
			const data = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
			// Stats live in statistics.total, not statistics.clones
			const total = data.statistics?.total ?? {};

			const duplicatedLines: number = total.duplicatedLines ?? 0;
			const totalLines: number = total.lines ?? 0;
			const percentage: number =
				total.percentage ??
				(totalLines > 0 ? (duplicatedLines / totalLines) * 100 : 0);

			const rawClones: any[] = data.duplicates ?? [];
			const clones: DuplicateClone[] = rawClones.map((c: any) => ({
				fileA: c.firstFile?.name ?? "",
				startA: c.firstFile?.start ?? 0,
				fileB: c.secondFile?.name ?? "",
				startB: c.secondFile?.start ?? 0,
				lines: c.lines ?? 0,
				tokens: c.tokens ?? 0,
			}));

			return { success: true, clones, duplicatedLines, totalLines, percentage };
		} catch (err) {
			void err;
			return {
				success: false,
				clones: [],
				duplicatedLines: 0,
				totalLines: 0,
				percentage: 0,
			};
		}
	}
}
