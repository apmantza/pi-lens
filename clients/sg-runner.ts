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
	error?: string;
}

export class SgRunner {
	private log: (msg: string) => void;
	private sgPath: string | null = null;
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

		// Check if available in PATH (fast)
		const pathResult = await safeSpawnAsync("sg", ["--version"], {
			timeout: 5000,
		});
		if (!pathResult.error && pathResult.status === 0) {
			this.sgPath = "sg";
			this.available = true;
			this.log("ast-grep found in PATH");
			return true;
		}

		// Auto-install via pi-lens installer
		this.log("ast-grep not found, attempting auto-install...");
		const { ensureTool } = await import("./installer/index.js");
		const installedPath = await ensureTool("ast-grep");

		if (installedPath) {
			this.sgPath = installedPath;
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

	/**
	 * Get the sg command to use (local binary or "sg" from PATH)
	 */
	private getSgCommand(): string {
		return this.sgPath || "sg";
	}

	/**
	 * Run ast-grep asynchronously, return parsed matches
	 */
	async exec(args: string[]): Promise<SgResult> {
		return new Promise((resolve) => {
			// On Windows with Git Bash/MSYS2, we need to use bash to properly
			// handle $variables in patterns (prevent shell expansion)
			const isWindows = process.platform === "win32";
			const hasBash = process.env.MSYSTEM || process.env.GIT_SHELL;

			let proc;
			if (isWindows && hasBash) {
				// Use bash -c with properly escaped command
				// In bash, use single quotes around arguments containing $ to prevent expansion
				const escapedArgs = args.map((arg) => {
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
				const bashCommand = `${this.getSgCommand()} ${escapedArgs.join(" ")}`;
				proc = spawn("bash", ["-c", bashCommand], {
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
			} else if (isWindows) {
				// Fallback: shell:true needed for npm-installed .cmd wrappers on Windows.
				// Pass cmd and args separately — do not concatenate into one string.
				proc = spawn(this.getSgCommand(), args.map(escapeWindowsArg), {
					stdio: ["ignore", "pipe", "pipe"],
					shell: true,
					windowsHide: true,
				});
			} else {
				// Unix: normal spawn without shell
				proc = spawn(this.getSgCommand(), args, {
					stdio: ["ignore", "pipe", "pipe"],
				});
			}

			let stdout = "";
			let stderr = "";

			proc.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
			proc.stderr.on("data", (data: Buffer) => (stderr += data.toString()));

			proc.on("error", (err: Error) => {
				if (err.message.includes("ENOENT")) {
					resolve({
						matches: [],
						error: "ast-grep CLI not found. Install: npm i -D @ast-grep/cli",
					});
				} else {
					resolve({ matches: [], error: err.message });
				}
			});

			proc.on("close", (code: number | null) => {
				// ast-grep exit codes:
				// 0 = matches found
				// 1 = no matches found (NOT an error, just empty result)
				// 2+ or non-zero with stderr = actual error

				if (code !== 0 && !stdout.trim()) {
					// No stdout - check if this is a real error or just "no matches"
					const stderrMsg = stderr.trim();

					// Exit code 1 with no stderr typically means "no matches" in ast-grep
					// This is normal behavior, not an error
					if (code === 1 && !stderrMsg) {
						resolve({ matches: [] });
						return;
					}

					// Check stderr for specific error patterns
					if (stderrMsg.includes("Multiple AST nodes are detected")) {
						resolve({
							matches: [],
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
							matches: [],
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

					// Unknown error - include what we have
					resolve({
						matches: [],
						error: stderrMsg || `Command failed with exit code ${code}`,
					});
					return;
				}
				if (!stdout.trim()) {
					resolve({ matches: [] });
					return;
				}
				try {
					const parsed = JSON.parse(stdout);
					const matches = Array.isArray(parsed) ? parsed : [parsed];
					resolve({ matches });
				} catch {
					resolve({ matches: [], error: "Failed to parse output" });
				}
			});
		});
	}

	/**
	 * Run ast-grep synchronously (for simple scans)
	 */
	execSync(args: string[]): { output: string; error?: string } {
		const { cmd: sgCmd, args: sgPre } = getSgCommand();
		const result = safeSpawn(sgCmd, [...sgPre, "sg", ...args], {
			timeout: 30000,
		});

		if (result.error) {
			return { output: "", error: result.error.message };
		}

		const output = result.stdout || result.stderr || "";
		return { output };
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
		const tmpDir = os.tmpdir();
		const ts = Date.now();
		const sessionDir = path.join(tmpDir, `pi-lens-temp-${ruleId}-${ts}`);
		const rulesSubdir = path.join(sessionDir, "rules");
		const ruleFile = path.join(rulesSubdir, `${ruleId}.yml`);
		const configFile = path.join(sessionDir, ".sgconfig.yml");

		try {
			fs.mkdirSync(rulesSubdir, { recursive: true });
			fs.writeFileSync(configFile, `ruleDirs:\n  - ./rules\n`);
			fs.writeFileSync(ruleFile, ruleYaml);

			const result = safeSpawn(
				"npx",
				["sg", "scan", "--config", configFile, "--json", dir],
				{ timeout },
			);

			const output = result.stdout || result.stderr || "";
			if (!output.trim()) return [];

			const items = JSON.parse(output);
			return Array.isArray(items) ? items : [items];
		} catch {
			return [];
		} finally {
			try {
				fs.rmSync(sessionDir, { recursive: true, force: true });
			} catch (err) {
				this.log(`Cleanup failed: ${(err as Error).message}`);
			}
		}
	}

	/**
	 * Run a rule file scan (temporary config approach) - alias for tempScan
	 */
	scanWithRule(ruleYaml: string, dir: string, timeout = 30000): SgMatch[] {
		const sessionDir = path.join(os.tmpdir(), `sg-scan-${Date.now()}`);
		const rulesSubdir = path.join(sessionDir, "rules");
		const configFile = path.join(sessionDir, ".sgconfig.yml");
		const ruleFile = path.join(rulesSubdir, "rule.yml");

		try {
			fs.mkdirSync(rulesSubdir, { recursive: true });
			fs.writeFileSync(configFile, `ruleDirs:\n  - ./rules\n`);
			fs.writeFileSync(ruleFile, ruleYaml);

			const result = safeSpawn(
				"npx",
				["sg", "scan", "--config", configFile, "--json", dir],
				{ timeout },
			);

			const output = result.stdout || result.stderr || "";
			if (!output.trim()) return [];

			const items = JSON.parse(output);
			return Array.isArray(items) ? items : [items];
		} catch {
			return [];
		} finally {
			try {
				fs.rmSync(sessionDir, { recursive: true, force: true });
			} catch (err) {
				this.log(`Cleanup failed: ${(err as Error).message}`);
			}
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
