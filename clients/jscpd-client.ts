/**
 * jscpd Client for pi-lens
 *
 * Detects copy-paste / duplicate code blocks across the project.
 * Helps the agent avoid unknowingly duplicating logic that already exists.
 *
 * Requires: npm install -D jscpd
 * Docs: https://github.com/kucherenko/jscpd
 */

import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getExcludedDirGlobs,
	getProjectIgnoreGlobs,
	getProjectIgnoreMatcher,
	isExcludedDirName,
} from "./file-utils.js";
import { safeSpawnAsync } from "./safe-spawn.js";

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

const EMPTY_RESULT: JscpdResult = {
	success: false,
	clones: [],
	duplicatedLines: 0,
	totalLines: 0,
	percentage: 0,
};

const SCAN_TIMEOUT_MS = 30_000;

// --- Client ---

export class JscpdClient {
	private available: boolean | null = null;
	private ensureInFlight: Promise<boolean> | null = null;
	private inFlight = new Map<string, Promise<JscpdResult>>();
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose ? (msg) => console.error(`[jscpd] ${msg}`) : () => {};
	}

	/**
	 * Fast recursive source file presence check.
	 * Avoids running jscpd when repo has no relevant source files.
	 *
	 * Originally this gate accepted only JS/TS extensions (commit 8b5d588).
	 * That made pi-lens's jscpd integration effectively JS/TS-only even
	 * though jscpd's tokenizer covers 15+ languages. Pure-Python /
	 * pure-Go / pure-Rust / pure-Java / etc. repos got zero clone
	 * detection. Closes #126: extend the gate to every language jscpd
	 * tokenizes well. Languages with no jscpd tokenizer (Gleam, Zig,
	 * Fish) are deliberately excluded — the gate change wouldn't help
	 * them.
	 */
	private hasSourceFilesRecursive(rootDir: string): boolean {
		const stack = [rootDir];
		const ignoreMatcher = getProjectIgnoreMatcher(rootDir);
		let visited = 0;
		const MAX_ENTRIES = 6000;

		while (stack.length > 0 && visited < MAX_ENTRIES) {
			const dir = stack.pop();
			if (!dir) continue;

			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				continue;
			}

			for (const entry of entries) {
				visited += 1;
				if (entry.isSymbolicLink()) continue;
				if (entry.isDirectory()) {
					const fullPath = path.join(dir, entry.name);
					if (isExcludedDirName(entry.name)) continue;
					if (ignoreMatcher.isIgnored(fullPath, true)) continue;
					stack.push(fullPath);
					continue;
				}
				if (!entry.isFile()) continue;
				if (ignoreMatcher.isIgnored(path.join(dir, entry.name), false))
					continue;
				if (
					/\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|java|go|rs|rb|php|swift|kt|kts|dart|lua|scala|c|h|cpp|cc|cxx|hpp|hxx|cs|m|mm)$/.test(
						entry.name,
					)
				) {
					if (entry.name.endsWith(".d.ts")) continue;
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * Check if jscpd is available, auto-install if not
	 */
	async ensureAvailable(): Promise<boolean> {
		// Fast path: already checked
		if (this.available !== null) return this.available;

		// Deduplicate concurrent calls
		if (this.ensureInFlight) return this.ensureInFlight;

		this.ensureInFlight = this.doEnsureAvailable();
		try {
			return await this.ensureInFlight;
		} finally {
			this.ensureInFlight = null;
		}
	}

	private async doEnsureAvailable(): Promise<boolean> {
		// Fast path: check local install before any spawn
		const isWin = process.platform === "win32";
		const localBase = path.join(
			os.homedir(),
			".pi-lens",
			"tools",
			"node_modules",
			".bin",
			"jscpd",
		);
		const localCandidates = isWin
			? [`${localBase}.cmd`, `${localBase}.exe`, localBase]
			: [localBase];
		for (const candidate of localCandidates) {
			try {
				if (fs.existsSync(candidate)) {
					this.available = true;
					return true;
				}
			} catch {
				// continue
			}
		}

		// Check if available in PATH (short timeout — if not instantly available, it's not in PATH)
		const result = await safeSpawnAsync("jscpd", ["--version"], {
			timeout: 1500,
		});
		this.available = !result.error && result.status === 0;
		if (this.available) {
			return true;
		}

		// Auto-install via pi-lens installer
		const { ensureTool } = await import("./installer/index.js");
		const installedPath = await ensureTool("jscpd");

		if (installedPath) {
			this.available = true;
			return true;
		}

		this.available = false;
		return false;
	}

	/**
	 * Scan a directory for duplicate code blocks.
	 * Uses a temp output dir to capture JSON report.
	 * @param isTsProject - If true, excludes .js files (they're compiled artifacts in TS projects)
	 */
	async scan(
		cwd: string,
		minLines = 5,
		minTokens = 50,
		isTsProject = false,
	): Promise<JscpdResult> {
		const targetDir = path.resolve(cwd);

		// Return early for non-existent or empty directories before probing/installing.
		if (!fs.existsSync(targetDir)) {
			return { ...EMPTY_RESULT };
		}
		if (!this.hasSourceFilesRecursive(targetDir)) {
			return { ...EMPTY_RESULT, success: true };
		}

		if (!(await this.ensureAvailable())) {
			return { ...EMPTY_RESULT };
		}

		const key = `${targetDir}:${minLines}:${minTokens}:${isTsProject}`;
		const existing = this.inFlight.get(key);
		if (existing) {
			this.log(`Scan already in flight for ${targetDir}; sharing result`);
			return existing;
		}

		const promise = this.runScan(
			targetDir,
			minLines,
			minTokens,
			isTsProject,
		).finally(() => {
			this.inFlight.delete(key);
		});
		this.inFlight.set(key, promise);
		return promise;
	}

	private async runScan(
		cwd: string,
		minLines: number,
		minTokens: number,
		isTsProject: boolean,
	): Promise<JscpdResult> {
		const outDir = mkdtempSync(`${os.tmpdir()}${path.sep}pi-lens-jscpd-`);

		// Build ignore pattern from shared exclusions + scanner-specific patterns.
		const baseIgnores = [
			...getExcludedDirGlobs(),
			...getProjectIgnoreGlobs(cwd),
			"**/*.md",
			"**/*.txt",
			"**/*.json",
			"**/*.yaml",
			"**/*.yml",
			"**/*.toml",
			"**/*.lock",
			"**/*.test.*",
			"**/*.spec.*",
			"**/*.poc.test.*",
			"**/__tests__/**",
			"**/tests/**",
		];
		if (isTsProject) {
			baseIgnores.push("**/*.js", "**/*.jsx");
		}
		const ignorePattern = baseIgnores.join(",");

		try {
			const result = await safeSpawnAsync(
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
					ignorePattern,
				],
				{
					timeout: SCAN_TIMEOUT_MS,
					cwd,
				},
			);

			if (result.error) {
				this.log(`Scan error: ${result.error.message}`);
				return { ...EMPTY_RESULT };
			}

			const reportPath = path.join(outDir, "jscpd-report.json");
			if (!fs.existsSync(reportPath)) {
				return { ...EMPTY_RESULT, success: true };
			}

			return this.parseReport(reportPath);
		} catch (err: any) {
			this.log(`Scan error: ${err.message}`);
			return { ...EMPTY_RESULT };
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
