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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDataDir } from "./file-utils.js";
import { isAtOrAboveHomeDir } from "./path-utils.js";
import { safeSpawnAsync } from "./safe-spawn.js";

// --- Types ---

export interface KnipIssue {
	type:
		| "export"
		| "file"
		| "dependency"
		| "devDependency"
		| "unlisted"
		| "bin"
		| "enumMember";
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

const EMPTY_RESULT: Omit<KnipResult, "summary"> = {
	success: false,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
};

const ANALYSIS_TIMEOUT_MS = 30_000;

// --- Client ---

export class KnipClient {
	private knipAvailable: boolean | null = null;
	private ensureInFlight: Promise<boolean> | null = null;
	private log: (msg: string) => void;

	/**
	 * De-dupe concurrent `analyze()` calls against the same project root.
	 *
	 * Without this guard, two back-to-back turn_end events (or a turn_end
	 * firing while the session_start scan is still in flight) can each spawn
	 * a fresh `knip` process over the same tree. Two concurrent knip
	 * runs are CPU-bound and cause the exact pathology we're fixing: load
	 * averages >5, TUI freezes, and zombie processes reparented to init
	 * after pi exits mid-scan.
	 *
	 * Key: canonicalised project root (not the caller's cwd). Value is the
	 * in-flight promise; completing clears the slot.
	 */
	private inFlight = new Map<string, Promise<KnipResult>>();

	constructor(verbose = false) {
		this.log = verbose
			? (msg: string) => console.error(`[knip] ${msg}`)
			: () => {};
	}

	/**
	 * Find the nearest directory with a project/knip config marker.
	 *
	 * Returns `null` when no marker is found up to the filesystem root.
	 * Callers MUST treat a null return as "no project here, skip knip" —
	 * previously this fell back to `startDir`, which on a bare cwd like
	 * `/home/v` caused knip to recurse through every project and balloon
	 * memory/CPU.
	 */
	private resolveProjectRoot(
		startDir: string,
		homeDirOverride?: string,
	): string | null {
		const markers = [
			"package.json",
			"knip.json",
			"knip.ts",
			"knip.config.js",
			"knip.config.ts",
		];
		const boundaries = [".git", ".hg", ".svn"];
		const homeDir = path.resolve(homeDirOverride ?? os.homedir());
		let current = path.resolve(startDir);
		// Safety bound: in practice depths are ~10. This cap just prevents a
		// pathological symlink loop from hanging the search.
		for (let depth = 0; depth < 64; depth++) {
			// Never treat a package/knip config at $HOME — or above it, such as
			// /home/package.json from a shared parent — as the project for startup
			// analysis. That escapes the workspace and can make knip scan the whole
			// home tree from an empty folder (#296/#250).
			if (isAtOrAboveHomeDir(current, homeDir)) {
				return null;
			}

			if (markers.some((m) => fs.existsSync(path.join(current, m)))) {
				return current;
			}

			// Do not escape the current repository just to find an unrelated parent
			// package.json. Unity/non-JS repos often have no package.json at their
			// root; walking past their .git boundary can accidentally pick up
			// ~/package.json and make knip scan the entire home directory.
			if (boundaries.some((m) => fs.existsSync(path.join(current, m)))) {
				return null;
			}

			const parent = path.dirname(current);
			if (parent === current) return null;
			current = parent;
		}
		return null;
	}

	/**
	 * Check if knip CLI is available, auto-install if not
	 */
	async ensureAvailable(): Promise<boolean> {
		// Fast path: already checked
		if (this.knipAvailable !== null) return this.knipAvailable;
		if (this.ensureInFlight) return this.ensureInFlight;

		this.ensureInFlight = this.doEnsureAvailable();
		try {
			return await this.ensureInFlight;
		} finally {
			this.ensureInFlight = null;
		}
	}

	private async doEnsureAvailable(): Promise<boolean> {
		// Check if available in PATH (fast)
		const pathResult = await safeSpawnAsync("knip", ["--version"], {
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
	 * Run knip analysis on the project.
	 *
	 * Async (uses `safeSpawnAsync`) so it never blocks the event loop —
	 * knip scans on large monorepos can take tens of seconds, and the
	 * previous `spawnSync` implementation froze the TUI for the entire
	 * duration.
	 *
	 * Re-entrancy safe: concurrent calls resolving to the same project
	 * root share a single knip process via `inFlight`.
	 */
	async analyze(cwd?: string, _ignore?: string[]): Promise<KnipResult> {
		const targetDir = this.resolveProjectRoot(cwd || process.cwd());
		if (!targetDir) {
			// No package.json / knip config anywhere up the tree. Running knip
			// from an arbitrary cwd (e.g. $HOME) has no defined meaning and in
			// practice walks huge irrelevant trees — bail early.
			this.log(
				`No project root found from ${cwd || process.cwd()}; skipping knip`,
			);
			return {
				...EMPTY_RESULT,
				success: true,
				summary: "No project root found; knip skipped",
			};
		}

		if (!(await this.ensureAvailable())) {
			return {
				...EMPTY_RESULT,
				summary: "Knip not available. Install with: npm install -D knip",
			};
		}

		const key = path.resolve(targetDir);
		const existing = this.inFlight.get(key);
		if (existing) {
			this.log(`Analysis already in flight for ${key}; sharing result`);
			return existing;
		}

		const promise = this.runAnalyze(key).finally(() => {
			this.inFlight.delete(key);
		});
		this.inFlight.set(key, promise);
		return promise;
	}

	private async runAnalyze(targetDir: string): Promise<KnipResult> {
		// Cache dir is routed through pi-lens's project-data-dir convention (NOT
		// knip's own default `./node_modules/.cache/knip`) so it lives alongside
		// every other project cache (see cache-manager.ts, call-graph.ts) and is
		// covered by the existing `.pi-lens/` gitignore entry.
		//
		// Caveat (per knip's docs): a cached run does NOT pick up newly-added
		// `.gitignore` files automatically — the cache must be deleted to detect
		// them. Not auto-handled here; this is a documented tradeoff, not a bug.
		const cacheLocation = path.join(getProjectDataDir(targetDir), "cache", "knip");

		// knip (verified against 6.26.0) silently fails to persist the cache when
		// `--cache-location` points at a directory that doesn't exist yet: its
		// internal auto-mkdir throws ENOENT (swallowed internally, debug-logged
		// only) on Windows, so the very first run — and every run after, since the
		// dir never gets created — degrades to an uncached scan with no error
		// surfaced. Pre-creating the dir avoids that path entirely; matches the
		// mkdirSync-before-spawn convention call-graph.ts already uses for its
		// cache file's parent dir.
		try {
			fs.mkdirSync(cacheLocation, { recursive: true });
		} catch (err) {
			this.log(`Failed to pre-create knip cache dir ${cacheLocation}: ${err}`);
		}

		const args = [
			"--reporter=json",
			"--include",
			// enumMembers surfaces unused enum members — finer-grained than
			// file-level exports. (knip 6.x has NO `classMembers` issue type; passing
			// it makes knip exit 2 with zero output, silently disabling the scan —
			// verified against knip 6.20. Valid member-level type here is enumMembers.)
			"files,exports,types,dependencies,unlisted,enumMembers",
			"--cache",
			"--cache-location",
			cacheLocation,
		];

		const result = await safeSpawnAsync("knip", args, {
			timeout: ANALYSIS_TIMEOUT_MS,
			cwd: targetDir,
			env: await this.getKnipEnvironment(targetDir),
		});

		if (result.error) {
			this.log(`Analysis error: ${result.error.message}`);
			return {
				...EMPTY_RESULT,
				summary: `Error: ${result.error.message}`,
			};
		}

		// Knip exits 0 on success (even with issues), 1 on errors
		const output = result.stdout || "";
		this.log(`Knip output length: ${output.length}`);
		if (output.length < 500) {
			this.log(`Knip output sample: ${output}`);
		}
		if (!output.trim()) {
			return {
				...EMPTY_RESULT,
				success: true,
				summary: "No issues found",
			};
		}

		return this.parseOutput(output);
	}

	private async getKnipEnvironment(targetDir: string): Promise<NodeJS.ProcessEnv> {
		const { getToolEnvironment } = await import("./installer/index.js");
		const env = await getToolEnvironment();
		const separator = process.platform === "win32" ? ";" : ":";
		const currentPath = env.PATH || env.Path || process.env.PATH || "";
		const localBin = path.join(targetDir, "node_modules", ".bin");
		const augmentedPath = `${localBin}${separator}${currentPath}`;

		return {
			...env,
			PATH: augmentedPath,
			...(process.platform === "win32" ? { Path: augmentedPath } : {}),
		};
	}

	/**
	 * Find unused exports in a specific file
	 */
	async findUnusedExports(filePath: string): Promise<string[]> {
		const result = await this.analyze(path.dirname(filePath));
		const basename = path.basename(filePath);

		return result.unusedExports
			.filter((e) => e.file?.includes(basename))
			.map((e) => e.name);
	}

	/**
	 * Format results for LLM consumption. Delegates to the pure
	 * `formatKnipResult` so callers (e.g. turn-end) can format without a live
	 * client instance.
	 */
	formatResult(result: KnipResult, maxItems = 20): string {
		return formatKnipResult(result, maxItems);
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

			const addIssue = (issue: KnipIssue) => {
				issues.push(issue);
				if (issue.type === "export" || issue.type === "enumMember") {
					unusedExports.push(issue);
				}
				if (issue.type === "file") unusedFiles.push(issue);
				if (issue.type === "dependency" || issue.type === "devDependency") {
					unusedDeps.push(issue);
				}
				if (issue.type === "unlisted" || issue.type === "bin") {
					unlistedDeps.push(issue);
				}
			};

			// Knip JSON format (grouped): { issues: [ { file, exports:[], files:[], dependencies:[], ... } ] }
			const fileEntries: any[] = Array.isArray(data?.issues) ? data.issues : [];

			for (const entry of fileEntries) {
				const file: string = entry.file ?? "";

				const push = (
					arr: any[],
					type: KnipIssue["type"],
					_target: KnipIssue[],
				) => {
					for (const item of arr) {
						addIssue({
							type,
							name: item.name ?? item.symbol ?? String(item),
							file,
							line: item.line,
							package: item.package,
						});
					}
				};

				push(entry.exports ?? [], "export", unusedExports);
				push(entry.types ?? [], "export", unusedExports);
				push(entry.enumMembers ?? [], "enumMember", unusedExports);
				push(entry.files ?? [], "file", unusedFiles);
				push(entry.dependencies ?? [], "dependency", unusedDeps);
				push(entry.devDependencies ?? [], "devDependency", unusedDeps);
				push(entry.unlisted ?? [], "unlisted", unlistedDeps);
				push(entry.binaries ?? [], "bin", unlistedDeps);
			}

			// Fallback format: flat list of issue objects
			if (issues.length === 0 && Array.isArray(data)) {
				for (const item of data) {
					if (!item || typeof item !== "object") continue;
					const rawType = String(
						item.type ?? item.issueType ?? item.kind ?? "file",
					).toLowerCase();
					const type: KnipIssue["type"] =
						rawType === "export" || rawType === "exports"
							? "export"
							: rawType === "dependency"
								? "dependency"
								: rawType === "devdependency"
									? "devDependency"
									: rawType === "unlisted"
										? "unlisted"
										: rawType === "bin" || rawType === "binaries"
											? "bin"
											: "file";
					addIssue({
						type,
						name: String(
							item.name ??
								item.symbol ??
								item.package ??
								item.message ??
								"unknown",
						),
						file: item.file ?? item.path ?? item.location?.file,
						line: item.line ?? item.location?.line,
						package: item.package,
					});
				}
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
				...EMPTY_RESULT,
				summary: "Failed to parse output",
			};
		}
	}
}

/**
 * Format a KnipResult for the agent (the FULL dead-code picture: all unused
 * exports/members, files, and deps — not a delta). Pure: no client instance or
 * `this`, so turn-end can surface findings without depending on the injected
 * client exposing the method. Returns "" when there is nothing to report.
 * Unlisted deps are intentionally omitted here — they're surfaced as a
 * delta-gated blocker (newly broken imports), not as cleanup advice.
 */
export function formatKnipResult(result: KnipResult, maxItems = 20): string {
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
