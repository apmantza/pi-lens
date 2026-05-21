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
import {
	getSgCommand,
	isSgAvailable,
} from "./dispatch/runners/utils/runner-helpers.js";
import { getProjectIgnoreGlobs } from "./file-utils.js";
import { safeSpawn, safeSpawnAsync } from "./safe-spawn.js";

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

function sgExcludeArgsForProject(rootDir: string): string[] {
	return getProjectIgnoreGlobs(rootDir).flatMap((glob) => [
		"--globs",
		`!${glob}`,
	]);
}

export interface SgMatch {
	file: string;
	range: {
		start: { line: number; column: number };
		end: { line: number; column: number };
	};
	text: string;
	replacement?: string;
}

export interface SgResult {
	matches: SgMatch[];
	totalMatches: number;
	truncated: boolean;
	error?: string;
}

export class SgRunner {
	private log: (msg: string) => void;
	private sgPath: string | null = null;
	private sgArgsPrefix: string[] = [];
	private available: boolean | null = null;

	constructor(verbose = false) {
		this.log = verbose
			? (msg: string) => console.error(`[sg-runner] ${msg}`)
			: () => {};
	}

	/**
	 * Check if ast-grep CLI is available, auto-install if not
	 */
	async ensureAvailable(): Promise<boolean> {
		// Fast path: already checked
		if (this.available !== null) return this.available;

		// Check PATH first. Prefer the canonical ast-grep binary; on Linux,
		// /usr/bin/sg is the util-linux group-switch command and is not ast-grep.
		const pathCommand = await this.probeCommandCandidates([
			{ cmd: "ast-grep", argsPrefix: [] },
			{ cmd: "sg", argsPrefix: [] },
			{ cmd: "npx", argsPrefix: ["--no", "--", "ast-grep"] },
		]);
		if (pathCommand) {
			this.sgPath = pathCommand.cmd;
			this.sgArgsPrefix = pathCommand.argsPrefix;
			this.available = true;
			this.log(`ast-grep found: ${pathCommand.cmd}`);
			return true;
		}

		// Auto-install via pi-lens installer
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
	 * Check if ast-grep CLI is available (legacy sync method)
	 * Prefer ensureAvailable() for auto-install behavior
	 */
	isAvailable(): boolean {
		if (this.available !== null) return this.available;

		this.available = isSgAvailable();
		return this.available;
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
				// Use bash -c with properly escaped command
				// In bash, use single quotes around arguments containing $ to prevent expansion
				const escapedArgs = allArgs.map((arg) => {
					// For bash, wrap $-containing args in single quotes
					if (arg.includes("$")) {
						return `'${arg.replace(/'/g, "'\\''")}'`;
					}
					// For other args with spaces/special chars, use double quotes
					if (/[\s"]/.test(arg)) {
						return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
					}
					return arg;
				});
				const escapedCmd = /[\s"]/g.test(command.cmd)
					? `"${command.cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
					: command.cmd;
				const bashCommand = `${escapedCmd} ${escapedArgs.join(" ")}`;
				proc = spawn("bash", ["-c", bashCommand], {
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

	/**
	 * Run ast-grep synchronously (for simple scans)
	 */
	execSync(args: string[]): { output: string; error?: string } {
		const { cmd: sgCmd, args: sgPre } = getSgCommand();
		const result = safeSpawn(sgCmd, [...sgPre, ...args], {
			timeout: 30000,
		});

		if (result.error) {
			return { output: "", error: result.error.message };
		}

		const output = result.stdout || result.stderr || "";
		return { output };
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

	/**
	 * Run a temporary rule scan (creates temp dir with rule file)
	 */
	tempScan(
		dir: string,
		ruleId: string,
		ruleYaml: string,
		timeout = 30000,
	): SgMatch[] {
		const { sessionDir, configFile } = this.prepareTempScan(ruleId, ruleYaml);
		try {
			const { cmd: sgCmd, args: sgPre } = getSgCommand();
			const result = safeSpawn(
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

	/** Run a rule file scan — delegates to tempScan with a fixed rule id. */
	scanWithRule(ruleYaml: string, dir: string, timeout = 30000): SgMatch[] {
		return this.tempScan(dir, "rule", ruleYaml, timeout);
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
					: "[APPLIED] No changes made (no matches found).";
			}
			return "No matches found";
		}

		const shown = matches.slice(0, maxItems);
		const lines = shown.map((m) => {
			const loc = `${m.file}:${m.range.start.line + 1}:${m.range.start.column + 1}`;
			const text = m.text.length > 100 ? `${m.text.slice(0, 100)}...` : m.text;
			return isDryRun && m.replacement
				? `${loc}\n  - ${text}\n  + ${m.replacement}`
				: `${loc}: ${text}`;
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
