/**
 * jscpd Client for pi-lens
 *
 * Detects copy-paste / duplicate code blocks across the project.
 * Helps the agent avoid unknowingly duplicating logic that already exists.
 *
 * Requires: npm install -D jscpd
 * Docs: https://github.com/kucherenko/jscpd
 */

import { formatToolFailure } from "./dispatch/runners/utils/tool-failure.js";
import { createSubsystemLogger } from "./extension-log.js";
import { incrementDegradationCount } from "./degradation-ledger.js";
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getExcludedDirGlobs,
	getProjectIgnoreGlobs,
	getProjectIgnoreMatcher,
} from "./file-utils.js";
import { findNodeToolBinary } from "./package-manager.js";
import { isAtOrAboveHomeDir, isFullyQualified } from "./path-utils.js";
import { getJscpdMaxEntriesDerived } from "./project-scale.js";
import {
	createAvailabilityChecker,
	findManagedNodeToolBinary,
	resolveAvailableOrInstall,
} from "./dispatch/runners/utils/runner-helpers.js";
import { safeSpawnAsync } from "./safe-spawn.js";
import { shouldRecurseIntoDir, walkTreeStackSync } from "./source-walker.js";

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

/** jscpd's own config-file names, in its discovery order, checked at `cwd` only
 * (jscpd does not walk up). */
const JSCPD_CONFIG_FILENAMES = [".jscpd.json", "jscpd.json"];

/**
 * True when the project ships its own jscpd config: a `.jscpd.json`/
 * `jscpd.json` file, or a `package.json` `jscpd` field. jscpd discovers either
 * unaided, but `--min-lines`/`--min-tokens`/`--ignore` on the CLI override
 * whatever the config sets — passing them unconditionally silently discarded a
 * project's own thresholds and ignore list (#1731, discipline A).
 */
function hasProjectJscpdConfig(cwd: string): boolean {
	for (const name of JSCPD_CONFIG_FILENAMES) {
		if (fs.existsSync(path.join(cwd, name))) return true;
	}
	try {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(cwd, "package.json"), "utf-8"),
		);
		if (pkg && typeof pkg === "object" && pkg.jscpd !== undefined) return true;
	} catch {
		// No/malformed package.json — "no project config" is the honest answer.
	}
	return false;
}

const jscpdAvailability = createAvailabilityChecker("jscpd", "", ["--version"], {
	probeTimeout: 1500,
	// One definition of the managed-shim fast path, shared with knip (#1476).
	fastPath: () => findManagedNodeToolBinary("jscpd"),
});

// --- Client ---

export class JscpdClient {
	// Absolute path of a MANAGED jscpd (the global ~/.pi-lens tools shim
	// discovered by the availability fast path, or the ensureTool install
	// result), else null. Nullable on purpose: a bare-name sentinel can't
	// distinguish "resolved" from "on PATH" — ensureTool may legitimately
	// return a bare command for an already-spawnable tool (#1289 review).
	// Project-local binaries are NOT stored; each scan resolves those against
	// its own cwd via findNodeToolBinary.
	private jscpdManagedPath: string | null = null;
	private inFlight = new Map<string, Promise<JscpdResult>>();
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose ? createSubsystemLogger("jscpd") : () => {};
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
		const ignoreMatcher = getProjectIgnoreMatcher(rootDir);
		const state = { visited: 0 };
		// #776: derived from the `maxProjectFiles` scale knob (project-scale.ts),
		// reproducing this same 6,000 default at the default base.
		const MAX_ENTRIES = getJscpdMaxEntriesDerived(rootDir);

		// #761: the traversal loop, readdir-safety, and directory-recursion
		// decision are the shared `walkTreeStackSync` engine; this client keeps
		// its own per-entry policy (skip ALL symlinks — files too — before the
		// dir/file branch, its own multi-language source regex, and a
		// per-directory entry budget via `shouldStop`, matching the pre-#761
		// `while (stack.length > 0 && visited < MAX_ENTRIES)` condition: the
		// current directory's entry loop always finishes, but no further
		// directory is popped once the budget is spent).
		return walkTreeStackSync(
			rootDir,
			(entry, fullPath) => {
				state.visited += 1;
				if (entry.isSymbolicLink()) return "skip";
				if (entry.isDirectory()) {
					return shouldRecurseIntoDir(entry, fullPath, {
						ignoreMatcher,
						followSymlinks: true,
					})
						? "recurse"
						: "skip";
				}
				if (!entry.isFile()) return "skip";
				const isSourceExt =
					/\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|java|go|rs|rb|php|swift|kt|kts|dart|lua|scala|c|h|cpp|cc|cxx|hpp|hxx|cs|m|mm)$/.test(
						entry.name,
					);
				// #1974: run the cheap extension gate BEFORE the ignore matcher —
				// `isIgnored` recompiles minimatch patterns per unique path, so a
				// non-source file (e.g. runtime output like wal/*.log) must not pay
				// it. A file that fails the ext gate is skipped either way.
				if (!isSourceExt) return "skip";
				if (ignoreMatcher.isIgnored(fullPath, false)) return "skip";
				if (entry.name.endsWith(".d.ts")) return "skip";
				return "stop";
			},
			{ shouldStop: () => state.visited >= MAX_ENTRIES },
		);
	}

	/**
	 * Check if jscpd is available, auto-install if not
	 */
	async ensureAvailable(): Promise<boolean> {
		const resolved = await resolveAvailableOrInstall(
			jscpdAvailability,
			"jscpd",
			process.cwd(),
		);
		if (!resolved) return false;
		if (isFullyQualified(resolved)) this.jscpdManagedPath = resolved;
		return true;
	}

	/**
	 * #1623: public availability verdict for callers outside the dispatch
	 * graph (mode=full's fresh-fetch) that need to say WHY `ensureAvailable()`
	 * most recently returned false, using the SAME outcome/cause the shared
	 * `jscpdAvailability` checker already tracks — not a re-guessed "jscpd
	 * binary unavailable" that can't tell a transient retry-cooldown probe
	 * from a durable absence.
	 */
	getAvailabilityVerdict(): {
		outcome: ReturnType<typeof jscpdAvailability.getOutcome>;
		cause: ReturnType<typeof jscpdAvailability.getVerdict>["cause"];
		retryAtMs: number;
	} {
		const verdict = jscpdAvailability.getVerdict(process.cwd());
		return {
			outcome: verdict.outcome,
			cause: verdict.cause,
			retryAtMs: verdict.retryAtMs,
		};
	}

	/**
	 * Scan a directory for duplicate code blocks.
	 * Uses a temp output dir to capture JSON report.
	 * @param isTsProject - If true, excludes .js files (they're compiled artifacts in TS projects)
	 *
	 * Root contract (#747/#250): unlike `KnipClient`/`DeadCodeClient`, this
	 * client does NOT resolve a project root via `findNearestMarkerRoot`, so it
	 * has historically relied on every caller to guard the scan root itself. The
	 * `isAtOrAboveHomeDir` refusal below is belt-and-braces internal protection
	 * so a FUTURE caller that forgets that contract can't spawn a whole-$HOME
	 * jscpd walk (the observed OOM: a jscpd run from a WSL home reached 44 GB
	 * RSS). `options.homeDir` overrides `os.homedir()` for tests.
	 */
	async scan(
		cwd: string,
		minLines = 5,
		minTokens = 50,
		isTsProject = false,
		options: { homeDir?: string } = {},
	): Promise<JscpdResult> {
		const targetDir = path.resolve(cwd);

		// #747/#250: never walk from a cwd at/above $HOME — from there jscpd's
		// tokenizer would run across every unrelated repo under home.
		if (isAtOrAboveHomeDir(targetDir, options.homeDir)) {
			this.log(`Refusing scan of unsafe root at/above home: ${targetDir}`);
			return { ...EMPTY_RESULT };
		}

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
			// Prefer a local/global-installed jscpd (any manager) over npx (#375).
			const bin = await findNodeToolBinary("jscpd", cwd);
			const { cmd, prefix } = bin
				? { cmd: bin, prefix: [] as string[] }
				: this.jscpdManagedPath
					? { cmd: this.jscpdManagedPath, prefix: [] as string[] }
					: { cmd: "npx", prefix: ["jscpd"] };
			// A project's own jscpd config wins outright (#1731, discipline A):
			// these three flags all override whatever it sets, so none are passed
			// when the project ships one — jscpd discovers it unaided.
			const hasConfig = hasProjectJscpdConfig(cwd);
			const result = await safeSpawnAsync(
				cmd,
				[
					...prefix,
					".",
					...(hasConfig
						? []
						: ["--min-lines", String(minLines), "--min-tokens", String(minTokens)]),
					"--reporters",
					"json",
					"--output",
					outDir,
					...(hasConfig ? [] : ["--ignore", ignorePattern]),
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

			// Empirical exit-code table (jscpd 3.5.10, verified live for #1736's
			// sweep): a genuinely clean run (no clones) exits 0 and writes NO
			// report file — jscpd only writes `jscpd-report.json` when it has
			// something to report. A crashed run (uncaught exception, e.g. a bad
			// scan path) ALSO writes no report file, but exits nonzero. The
			// missing-file check alone can't tell those apart, so a nonzero exit
			// with no report file is reported as errored, never as "0 clones".
			// (Not `spawnFailedWithNoOutput` — the parsed artifact here is a
			// report FILE, not stdout, so the shared stdout-based discriminator
			// doesn't apply; the underlying "nonzero exit -> not clean" rule is
			// the same one.)
			const reportPath = path.join(outDir, "jscpd-report.json");
			if (!fs.existsSync(reportPath)) {
				if (result.status !== 0) {
					// #1816: one shared wording, one truncation, signal named.
					// `reportMissing` is the artifact-tool arm of the same
					// primitive — the parsed artifact here is a report FILE.
					const reason = formatToolFailure({
						tool: "jscpd",
						status: result.status,
						signal: result.signal,
						stderr: result.stderr,
						reportMissing: true,
						fields: { command: cmd },
					});
					this.log(reason);
					incrementDegradationCount({
						kind: "runner-empty-result",
						subject: "jscpd",
						reason,
					});
					return { ...EMPTY_RESULT };
				}
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
