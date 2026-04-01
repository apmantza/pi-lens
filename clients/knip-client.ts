/**
 * Knip Client for pi-local
 *
 * Detects unused exports, files, dependencies, and more.
 * Essential for safe refactoring — I need to know what's dead code
 * before I can clean it up.
 *
 * Requires: npm install -D knip
 * Docs: https://knip.dev/
 */

import * as path from "node:path";
import { safeSpawn } from "./safe-spawn.js";

// --- Types ---

export interface KnipIssue {
	type: "export" | "file" | "dependency" | "devDependency" | "unlisted" | "bin";
	name: string;
	file?: string;
	line?: number;
	package?: string;
}

export interface KnipResult {
	success: boolean;
	issues: KnipIssue[];
	unusedExports: KnipIssue[];
	unusedFiles: KnipIssue[];
	unusedDeps: KnipIssue[];
	unlistedDeps: KnipIssue[];
	summary: string;
}

// --- Client ---

export class KnipClient {
	private knipAvailable: boolean | null = null;
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose
			? (msg: string) => console.error(`[knip] ${msg}`)
			: () => {};
	}

	/**
	 * Check if knip CLI is available, auto-install if not
	 */
	async ensureAvailable(): Promise<boolean> {
		// Fast path: already checked
		if (this.knipAvailable !== null) return this.knipAvailable;

		// Check if available in PATH (fast)
		const pathResult = safeSpawn("knip", ["--version"], {
			timeout: 5000,
		});
		if (!pathResult.error && pathResult.status === 0) {
			this.knipAvailable = true;
			this.log("Knip found in PATH");
			return true;
		}

		// Auto-install via pi-lens installer
		this.log("Knip not found, attempting auto-install...");
		const { ensureTool } = await import("./installer/index.js");
		const installedPath = await ensureTool("knip");

		if (installedPath) {
			this.knipAvailable = true;
			this.log(`Knip auto-installed: ${installedPath}`);
			return true;
		}

		this.knipAvailable = false;
		return false;
	}

	/**
	 * Check if knip CLI is available (legacy sync method)
	 * Prefer ensureAvailable() for auto-install behavior
	 */
	isAvailable(): boolean {
		if (this.knipAvailable !== null) return this.knipAvailable;

		const result = safeSpawn("npx", ["knip", "--version"], {
			timeout: 10000,
		});

		this.knipAvailable = !result.error && result.status === 0;
		if (this.knipAvailable) {
			this.log(`Knip available`);
		}

		return this.knipAvailable;
	}

	/**
	 * Run knip analysis on the project
	 */
	analyze(cwd?: string, ignore?: string[]): KnipResult {
		if (!this.isAvailable()) {
			return {
				success: false,
				issues: [],
				unusedExports: [],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
				summary: "Knip not available. Install with: npm install -D knip",
			};
		}

		const targetDir = cwd || process.cwd();

		try {
			const args = [
				"knip",
				"--reporter=json",
				"--include",
				"files,exports,types,dependencies,unlisted",
			];
			if (ignore && ignore.length > 0) {
				args.push("--ignore", ignore.join(","));
			}

			const result = safeSpawn("npx", args, {
				timeout: 30000,
				cwd: targetDir,
			});

			// Knip exits 0 on success (even with issues), 1 on errors
			const output = result.stdout || "";
			this.log(`Knip output length: ${output.length}`);
			if (output.length < 500) {
				this.log(`Knip output sample: ${output}`);
			}
			if (!output.trim()) {
				return {
					success: true,
					issues: [],
					unusedExports: [],
					unusedFiles: [],
					unusedDeps: [],
					unlistedDeps: [],
					summary: "No issues found",
				};
			}

			return this.parseOutput(output);
		} catch (err: any) {
			this.log(`Analysis error: ${err.message}`);
			return {
				success: false,
				issues: [],
				unusedExports: [],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
				summary: `Error: ${err.message}`,
			};
		}
	}

	/**
	 * Find unused exports in a specific file
	 */
	findUnusedExports(filePath: string): string[] {
		const result = this.analyze(path.dirname(filePath));
		const basename = path.basename(filePath);

		return result.unusedExports
			.filter((e) => e.file?.includes(basename))
			.map((e) => e.name);
	}

	/**
	 * Format results for LLM consumption
	 */
	formatResult(result: KnipResult, maxItems = 20): string {
		if (!result.success) return `[Knip] ${result.summary}`;
		if (result.issues.length === 0) return "";

		let output = `[Knip] ${result.issues.length} issue(s)`;
		if (result.unusedExports.length)
			output += ` — ${result.unusedExports.length} unused export(s)`;
		if (result.unusedFiles.length)
			output += ` — ${result.unusedFiles.length} unused file(s)`;
		if (result.unusedDeps.length)
			output += ` — ${result.unusedDeps.length} unused dep(s)`;
		if (result.unlistedDeps.length)
			output += ` — ${result.unlistedDeps.length} unlisted dep(s)`;
		output += ":\n";

		// Show unused exports first (most useful for refactoring)
		if (result.unusedExports.length > 0) {
			output += "\n  Unused exports:\n";
			for (const issue of result.unusedExports.slice(0, maxItems)) {
				const loc = issue.file ? ` (${path.basename(issue.file)})` : "";
				output += `    - ${issue.name}${loc}\n`;
			}
			if (result.unusedExports.length > maxItems) {
				output += `    ... and ${result.unusedExports.length - maxItems} more\n`;
			}
		}

		// Show unused files
		if (result.unusedFiles.length > 0) {
			output += "\n  Unused files:\n";
			for (const issue of result.unusedFiles.slice(0, 10)) {
				output += `    - ${issue.name}\n`;
			}
		}

		// Show unused deps (might be worth removing)
		if (result.unusedDeps.length > 0) {
			output += "\n  Unused dependencies:\n";
			for (const issue of result.unusedDeps) {
				output += `    - ${issue.package || issue.name}\n`;
			}
		}

		return output;
	}

	// --- Internal ---

	private parseOutput(output: string): KnipResult {
		try {
			const data = JSON.parse(output);
			const issues: KnipIssue[] = [];
			const unusedExports: KnipIssue[] = [];
			const unusedFiles: KnipIssue[] = [];
			const unusedDeps: KnipIssue[] = [];
			const unlistedDeps: KnipIssue[] = [];

			// Knip JSON format: { issues: [ { file, exports:[], files:[], dependencies:[], ... } ] }
			const fileEntries: any[] = data.issues ?? [];

			for (const entry of fileEntries) {
				const file: string = entry.file ?? "";

				const push = (
					arr: any[],
					type: KnipIssue["type"],
					target: KnipIssue[],
				) => {
					for (const item of arr) {
						const issue: KnipIssue = {
							type,
							name: item.name ?? item.symbol ?? String(item),
							file,
							line: item.line,
							package: item.package,
						};
						issues.push(issue);
						target.push(issue);
					}
				};

				push(entry.exports ?? [], "export", unusedExports);
				push(entry.types ?? [], "export", unusedExports);
				push(entry.files ?? [], "file", unusedFiles);
				push(entry.dependencies ?? [], "dependency", unusedDeps);
				push(entry.devDependencies ?? [], "devDependency", unusedDeps);
				push(entry.unlisted ?? [], "unlisted", unlistedDeps);
			}

			return {
				success: true,
				issues,
				unusedExports,
				unusedFiles,
				unusedDeps,
				unlistedDeps,
				summary: `Found ${issues.length} issues`,
			};
		} catch (err) {
			void err;
			this.log("Failed to parse knip JSON output");
			return {
				success: false,
				issues: [],
				unusedExports: [],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
				summary: "Failed to parse output",
			};
		}
	}
}
