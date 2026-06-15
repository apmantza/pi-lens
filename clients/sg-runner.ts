/**
 * SgRunner - encapsulates ast-grep subprocess management
 *
 * Extracted from AstGrepClient to simplify the main client.
 * Handles: spawn, spawnSync, temp dir management, JSON parsing.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getSgCommand } from "./dispatch/runners/utils/runner-helpers.js";
import { getProjectIgnoreGlobs } from "./file-utils.js";
import { safeSpawnAsync } from "./safe-spawn.js";

/**
 * Escape an argument for Windows cmd.exe shell execution.
 * Handles spaces, quotes, and special characters.
 */
function escapeWindowsArg(arg: string): string {
	// If no special characters, return as-is
	if (!/[\s"]/.test(arg)) return arg;

	// Escape quotes by doubling them
	return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Build the `bash -c` argv that runs `cmd` with `allArgs` as POSITIONAL
 * parameters. The script is the constant `"$0" "$@"`, so bash re-emits the
 * command and every arg verbatim — no parameter expansion, no word-splitting.
 *
 * Two properties this guarantees, neither of which string-interpolation could:
 *  - ast-grep `$METAVAR` patterns reach the binary literally (not shell-expanded).
 *  - an environment-derived command path (PATH-resolved `ast-grep`/`sg`/`npx`)
 *    cannot inject shell — it's argv[0], never part of the script string
 *    (CodeQL js/shell-command-injection-from-environment).
 */
export function buildBashRunArgs(cmd: string, allArgs: string[]): string[] {
	return ["-c", '"$0" "$@"', cmd, ...allArgs];
}

function sgExcludeArgsForProject(rootDir: string): string[] {
	return getProjectIgnoreGlobs(rootDir).flatMap((glob) => [
		"--globs",
		`!${glob}`,
	]);
}

interface SgMetaVarNode {
	text: string;
	range: {
		start: { line: number; column: number };
		end: { line: number; column: number };
	};
}

export interface SgMatch {
	file: string;
	range: {
		start: { line: number; column: number };
		end: { line: number; column: number };
	};
	text: string;
	lines?: string;
	language?: string;
	replacement?: string;
	metaVariables?: {
		single: Record<string, SgMetaVarNode>;
		multi: Record<string, SgMetaVarNode[]>;
		transformed: Record<string, string>;
	};
}

export interface SgResult {
	matches: SgMatch[];
	totalMatches: number;
	truncated: boolean;
	error?: string;
}

export interface SgRawResult {
	stdout: string;
	stderr: string;
	status: number | null;
	error?: string;
}

/**
 * Format metavariable captures for display below a match line.
 * Single captures: $VAR=x  $NAME=foo
 * Multi captures:  $$$ARGS=a,b,c
 * Returns undefined when there are no meaningful captures.
 */
function formatMetaVarCaptures(
	mv: SgMatch["metaVariables"],
): string | undefined {
	if (!mv) return undefined;
	const parts: string[] = [];

	for (const [name, node] of Object.entries(mv.single)) {
		if (node.text) parts.push(`$${name}=${node.text}`);
	}
	for (const [name, nodes] of Object.entries(mv.multi)) {
		if (nodes.length > 0) {
			const joined = nodes.map((n) => n.text).join("");
			if (joined) parts.push(`$$$${name}=${joined}`);
		}
	}
	for (const [name, value] of Object.entries(mv.transformed)) {
		if (value) parts.push(`@${name}=${value}`);
	}

	if (parts.length === 0) return undefined;
	return `  ${parts.join("  ")}`;
}

export class SgRunner {
	private log: (msg: string) => void;
	private sgPath: string | null = null;
	private sgArgsPrefix: string[] = [];
	private available: boolean | null = null;
	private ensureInFlight: Promise<boolean> | null = null;

	constructor(verbose = false) {
		this.log = verbose
			? (msg: string) => console.error(`[sg-runner] ${msg}`)
			: () => {};
	}

	/**
	 * Check if ast-grep CLI is available, auto-install if not.
	 *
	 * Re-entrancy safe: concurrent first-time callers share a single
	 * `ensureInFlight` promise so probing/auto-install isn't duplicated
	 * across session-start tasks. Mirrors the dedupe pattern in
	 * `KnipClient.ensureAvailable` and `DependencyChecker.ensureAvailable`.
	 */
	async ensureAvailable(): Promise<boolean> {
		// Fast path: already checked.
		if (this.available !== null) return this.available;
		if (this.ensureInFlight) return this.ensureInFlight;

		this.ensureInFlight = this.doEnsureAvailable();
		try {
			return await this.ensureInFlight;
		} finally {
			this.ensureInFlight = null;
		}
	}

	private async doEnsureAvailable(): Promise<boolean> {
		// Step 1: PATH — canonical binary names + npx fallback.
		// Prefer ast-grep over sg on Linux: /usr/bin/sg is util-linux, not ast-grep.
		const pathCommand = await this.probeCommandCandidates([
			{ cmd: "ast-grep", argsPrefix: [] },
			{ cmd: "sg", argsPrefix: [] },
			{ cmd: "npx", argsPrefix: ["--no", "--", "ast-grep"] },
		]);
		if (pathCommand) {
			this.sgPath = pathCommand.cmd;
			this.sgArgsPrefix = pathCommand.argsPrefix;
			this.available = true;
			this.log(`ast-grep found on PATH: ${pathCommand.cmd}`);
			return true;
		}

		// Step 2: platform-specific npm package binaries.
		// Covers setups where @ast-grep/cli-{os}-{arch} is installed but the binary
		// directory is not on PATH (common with pnpm, Yarn PnP, or isolated installs).
		const platformBinary = await this.probePlatformPackageBinary();
		if (platformBinary) {
			this.sgPath = platformBinary;
			this.sgArgsPrefix = [];
			this.available = true;
			this.log(`ast-grep found via platform package: ${platformBinary}`);
			return true;
		}

		// Step 3: Homebrew (macOS only).
		if (process.platform === "darwin") {
			const brewBinary = await this.probeHomebrew();
			if (brewBinary) {
				this.sgPath = brewBinary;
				this.sgArgsPrefix = [];
				this.available = true;
				this.log(`ast-grep found via Homebrew: ${brewBinary}`);
				return true;
			}
		}

		// Step 4: auto-install via pi-lens installer.
		this.log("ast-grep not found, attempting auto-install...");
		const { ensureTool } = await import("./installer/index.js");
		const installedPath = await ensureTool("ast-grep");

		if (installedPath && (await this.probeCommand(installedPath, []))) {
			this.sgPath = installedPath;
			this.sgArgsPrefix = [];
			this.available = true;
			this.log(`ast-grep auto-installed: ${installedPath}`);
			return true;
		}

		this.available = false;
		return false;
	}

	/**
	 * Probe platform-specific @ast-grep/cli-{os}-{arch} npm packages.
	 * These ship the binary at the package root (sg / sg.exe).
	 */
	private async probePlatformPackageBinary(): Promise<string | undefined> {
		const { platform, arch } = process;
		const exeName = platform === "win32" ? "sg.exe" : "sg";

		// Map Node.js platform/arch to @ast-grep/cli package suffix.
		const pkgSuffixes: string[] = [];
		if (platform === "linux" && arch === "x64") pkgSuffixes.push("linux-x64-gnu");
		if (platform === "linux" && arch === "arm64") pkgSuffixes.push("linux-arm64-gnu");
		if (platform === "darwin" && arch === "arm64") pkgSuffixes.push("darwin-arm64");
		if (platform === "darwin" && arch === "x64") pkgSuffixes.push("darwin-x64");
		if (platform === "win32" && arch === "x64") pkgSuffixes.push("win32-x64-msvc");
		if (platform === "win32" && arch === "arm64") pkgSuffixes.push("win32-arm64-msvc");

		// Search roots: local node_modules and any parent node_modules directories.
		const searchRoots: string[] = [];
		let dir = process.cwd();
		for (let depth = 0; depth < 5; depth++) {
			searchRoots.push(path.join(dir, "node_modules"));
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}

		for (const suffix of pkgSuffixes) {
			const pkgName = `@ast-grep/cli-${suffix}`;
			for (const root of searchRoots) {
				const candidate = path.join(root, pkgName, exeName);
				try {
					if (fs.existsSync(candidate) && (await this.probeCommand(candidate, []))) {
						return candidate;
					}
				} catch {
					// not found or not executable — try next
				}
			}
		}
		return undefined;
	}

	/**
	 * Probe Homebrew installation (macOS only).
	 * Runs `brew --prefix ast-grep` and checks the resulting bin directory.
	 */
	private async probeHomebrew(): Promise<string | undefined> {
		try {
			const result = await safeSpawnAsync("brew", ["--prefix", "ast-grep"], {
				timeout: 3000,
			});
			if (result.error || result.status !== 0) return undefined;
			const prefix = result.stdout.trim();
			if (!prefix) return undefined;
			for (const name of ["ast-grep", "sg"]) {
				const candidate = path.join(prefix, "bin", name);
				if (fs.existsSync(candidate) && (await this.probeCommand(candidate, []))) {
					return candidate;
				}
			}
		} catch {
			// brew not installed or timed out
		}
		return undefined;
	}

	private isAstGrepVersionOutput(output: string): boolean {
		return /\bast[- ]grep\b/i.test(output);
	}

	private async probeCommand(
		cmd: string,
		argsPrefix: string[],
	): Promise<boolean> {
		const result = await safeSpawnAsync(cmd, [...argsPrefix, "--version"], {
			timeout: 5000,
		});
		return (
			!result.error &&
			result.status === 0 &&
			this.isAstGrepVersionOutput(`${result.stdout}\n${result.stderr}`)
		);
	}

	private async probeCommandCandidates(
		candidates: Array<{ cmd: string; argsPrefix: string[] }>,
	): Promise<{ cmd: string; argsPrefix: string[] } | undefined> {
		for (const candidate of candidates) {
			if (await this.probeCommand(candidate.cmd, candidate.argsPrefix)) {
				return candidate;
			}
		}
		return undefined;
	}

	/**
	 * Get the ast-grep command to use, plus any npx prefix arguments.
	 */
	private getSgCommand(): { cmd: string; argsPrefix: string[] } {
		return {
			cmd: this.sgPath || "ast-grep",
			argsPrefix: this.sgArgsPrefix,
		};
	}

	async execRaw(args: string[], timeout = 30000): Promise<SgRawResult> {
		const command = this.getSgCommand();
		const result = await safeSpawnAsync(
			command.cmd,
			[...command.argsPrefix, ...args],
			{ timeout },
		);
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			status: result.status,
			error: result.error?.message,
		};
	}

	/**
	 * Run ast-grep asynchronously, return parsed matches
	 */
	async exec(args: string[]): Promise<SgResult> {
		return new Promise((resolve) => {
			const command = this.getSgCommand();
			const allArgs = [...command.argsPrefix, ...args];
			// On Windows with Git Bash/MSYS2, we need to use bash to properly
			// handle $variables in patterns (prevent shell expansion)
			const isWindows = process.platform === "win32";
			const hasBash = process.env.MSYSTEM || process.env.GIT_SHELL;

			let proc;
			if (isWindows && hasBash) {
				// Run via bash (Git Bash/MSYS2) so $-metavariables in ast-grep
				// patterns aren't shell-expanded. Pass the command + args as
				// POSITIONAL parameters (`"$0"`/`"$@"`) instead of interpolating
				// them into the -c string: bash re-emits `"$@"` verbatim — no
				// parameter expansion, no word-splitting — so patterns stay literal
				// AND an environment-derived command path cannot inject shell
				// (fixes CodeQL js/shell-command-injection-from-environment). This
				// also removes the brittle hand-rolled quoting it replaced.
				proc = spawn("bash", buildBashRunArgs(command.cmd, allArgs), {
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
			} else if (isWindows) {
				// Fallback: shell:true needed for npm-installed .cmd wrappers on Windows.
				// Pass cmd and args separately — do not concatenate into one string.
				proc = spawn(command.cmd, allArgs.map(escapeWindowsArg), {
					stdio: ["ignore", "pipe", "pipe"],
					shell: true,
					windowsHide: true,
				});
			} else {
				// Unix: normal spawn without shell
				proc = spawn(command.cmd, allArgs, {
					stdio: ["ignore", "pipe", "pipe"],
				});
			}

			let stdout = "";
			let stderr = "";

			proc.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
			proc.stderr.on("data", (data: Buffer) => (stderr += data.toString()));

			const empty = (): SgResult => ({
				matches: [],
				totalMatches: 0,
				truncated: false,
			});

			proc.on("error", (err: Error) => {
				if (err.message.includes("ENOENT")) {
					resolve({
						...empty(),
						error: "ast-grep CLI not found. Install: npm i -D @ast-grep/cli",
					});
				} else {
					resolve({ ...empty(), error: err.message });
				}
			});

			proc.on("close", (code: number | null) => {
				if (code !== 0 && !stdout.trim()) {
					const stderrMsg = stderr.trim();

					if (code === 1 && !stderrMsg) {
						resolve(empty());
						return;
					}

					if (stderrMsg.includes("Multiple AST nodes are detected")) {
						resolve({
							...empty(),
							error:
								`Invalid AST pattern: The pattern appears to contain multiple AST nodes or is malformed.\n` +
								`Common causes:\n` +
								`  1. Missing parentheses: use it($TEST) not it"test"\n` +
								`  2. Raw text without structure: use console.log($MSG) not just "console.log"\n` +
								`  3. Unclosed quotes or brackets\n\n` +
								`Original error: ${stderrMsg}`,
						});
						return;
					}

					if (stderrMsg.includes("Cannot parse query")) {
						resolve({
							...empty(),
							error:
								`Pattern syntax error: The pattern could not be parsed as valid code.\n` +
								`Tips:\n` +
								`  - Patterns must be valid ${args.includes("--lang") ? args[args.indexOf("--lang") + 1] : "language"} syntax\n` +
								`  - Use metavariables like $NAME, $ARGS for variable parts\n` +
								`  - Example: 'function $NAME($$$PARAMS) { $$$BODY }'\n\n` +
								`Original error: ${stderrMsg}`,
						});
						return;
					}

					resolve({
						...empty(),
						error: stderrMsg || `Command failed with exit code ${code}`,
					});
					return;
				}
				if (!stdout.trim()) {
					resolve(empty());
					return;
				}
				try {
					const parsed = JSON.parse(stdout);
					const matches = Array.isArray(parsed) ? parsed : [parsed];
					resolve({
						matches,
						totalMatches: matches.length,
						truncated: false,
					});
				} catch {
					resolve({ ...empty(), error: "Failed to parse output" });
				}
			});
		});
	}

	// --- Shared helpers for temp-dir rule scans ---

	private prepareTempScan(
		ruleId: string,
		ruleYaml: string,
	): {
		sessionDir: string;
		configFile: string;
	} {
		const sessionDir = path.join(
			os.tmpdir(),
			`pi-lens-temp-${ruleId}-${Date.now()}`,
		);
		const rulesSubdir = path.join(sessionDir, "rules");
		const configFile = path.join(sessionDir, ".sgconfig.yml");
		fs.mkdirSync(rulesSubdir, { recursive: true });
		fs.writeFileSync(configFile, `ruleDirs:\n  - ./rules\n`);
		fs.writeFileSync(path.join(rulesSubdir, `${ruleId}.yml`), ruleYaml);
		return { sessionDir, configFile };
	}

	private parseScanOutput(output: string): SgMatch[] {
		if (!output.trim()) return [];
		const items = JSON.parse(output);
		return Array.isArray(items) ? items : [items];
	}

	private cleanupTempScan(sessionDir: string): void {
		try {
			fs.rmSync(sessionDir, { recursive: true, force: true });
		} catch (err) {
			this.log(`Cleanup failed: ${(err as Error).message}`);
		}
	}

	async tempScanAsync(
		dir: string,
		ruleId: string,
		ruleYaml: string,
		timeout = 30000,
	): Promise<SgMatch[]> {
		const { sessionDir, configFile } = this.prepareTempScan(ruleId, ruleYaml);
		try {
			const { cmd: sgCmd, args: sgPre } = getSgCommand();
			const result = await safeSpawnAsync(
				sgCmd,
				[
					...sgPre,
					"scan",
					"--config",
					configFile,
					"--json",
					...sgExcludeArgsForProject(dir),
					dir,
				],
				{ timeout },
			);
			return this.parseScanOutput(result.stdout || result.stderr || "");
		} catch {
			return [];
		} finally {
			this.cleanupTempScan(sessionDir);
		}
	}

	/**
	 * Run a rule scan with optional fix application.
	 * Dry-run: --json (returns matches for preview).
	 * Apply:   --update-all (writes fixes defined in the YAML `fix:` field).
	 */
	async tempScanWithFixAsync(
		dir: string,
		ruleId: string,
		ruleYaml: string,
		applyFixes: boolean,
		timeout = 30000,
	): Promise<{ matches: SgMatch[]; error?: string }> {
		const { sessionDir, configFile } = this.prepareTempScan(ruleId, ruleYaml);
		try {
			const { cmd: sgCmd, args: sgPre } = getSgCommand();
			if (!applyFixes) {
				const result = await safeSpawnAsync(
					sgCmd,
					[...sgPre, "scan", "--config", configFile, "--json",
						...sgExcludeArgsForProject(dir), dir],
					{ timeout },
				);
				return { matches: this.parseScanOutput(result.stdout || result.stderr || "") };
			}
			// Apply: capture matches BEFORE writing — once --update-all applies
			// the fix the rule no longer matches, so a post-apply json pass would
			// report zero even on a successful apply. Count first, then write.
			const jsonResult = await safeSpawnAsync(
				sgCmd,
				[...sgPre, "scan", "--config", configFile, "--json",
					...sgExcludeArgsForProject(dir), dir],
				{ timeout },
			);
			const matches = this.parseScanOutput(
				jsonResult.stdout || jsonResult.stderr || "",
			);
			const applyResult = await safeSpawnAsync(
				sgCmd,
				[...sgPre, "scan", "--config", configFile, "--update-all",
					...sgExcludeArgsForProject(dir), dir],
				{ timeout },
			);
			if (applyResult.error) {
				return { matches: [], error: applyResult.error.message };
			}
			return { matches };
		} catch (err) {
			return { matches: [], error: String(err) };
		} finally {
			this.cleanupTempScan(sessionDir);
		}
	}

	/**
	 * Format matches for display
	 */
	formatMatches(
		matches: SgMatch[],
		isDryRun = false,
		maxItems = 50,
		showModeIndicator = false,
	): string {
		if (matches.length === 0) {
			if (showModeIndicator) {
				return isDryRun
					? "[DRY-RUN] No matches found."
					: "[NOT APPLIED] No matches found — nothing was changed. Run ast_grep_search to confirm the pattern matches before applying.";
			}
			return "No matches found";
		}

		const shown = matches.slice(0, maxItems);
		const lines = shown.map((m) => {
			const loc = `${m.file}:${m.range.start.line + 1}:${m.range.start.column + 1}`;
			const text = m.text.length > 100 ? `${m.text.slice(0, 100)}...` : m.text;
			const langSuffix = m.language ? `  [${m.language}]` : "";
			const base =
				isDryRun && m.replacement
					? `${loc}\n  - ${text}\n  + ${m.replacement}`
					: `${loc}: ${text}${langSuffix}`;
			const captures = formatMetaVarCaptures(m.metaVariables);
			return captures ? `${base}\n${captures}` : base;
		});

		if (matches.length > maxItems) {
			lines.unshift(
				`Found ${matches.length} matches (showing first ${maxItems}):`,
			);
		}

		if (showModeIndicator) {
			const prefix = isDryRun ? "[DRY-RUN]" : "[APPLIED]";
			const suffix = isDryRun
				? "\n\n(Dry run — use apply=true to apply changes)"
				: "";
			return `${prefix} ${matches.length} replacement(s):\n\n${lines.join("\n")}${suffix}`;
		}

		return lines.join("\n");
	}
}
