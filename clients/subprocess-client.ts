/**
 * Base class for CLI tool clients that communicate via subprocess.
 *
 * Provides common patterns for:
 * - Availability checking (cached)
 * - File type detection
 * - Running CLI commands
 * - Logging
 *
 * Subclasses implement:
 * - getToolName(): The CLI tool name
 * - getCheckCommand(): Command to check availability
 * - isSupportedFile(): File extensions the tool handles
 * - parseOutput(): Parse CLI output into diagnostics
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface Diagnostic {
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	severity: "error" | "warning" | "info" | "hint";
	message: string;
	rule?: string;
	file: string;
	fixable?: boolean;
}

export abstract class SubprocessClient<T extends Diagnostic> {
	protected available: boolean | null = null;
	protected log: (msg: string) => void;
	private toolName: string;

	constructor(verbose = false) {
		this.toolName = this.getToolName();
		this.log = verbose
			? (msg: string) => console.log(`[${this.toolName}] ${msg}`)
			: () => {};
	}

	/**
	 * The name of the CLI tool (used in log messages)
	 */
	protected abstract getToolName(): string;

	/**
	 * Command and args to check if the tool is available
	 * e.g., ["ruff", "--version"] or ["npx", "@biomejs/biome", "--version"]
	 */
	protected abstract getCheckCommand(): string[];

	/**
	 * File extensions this tool supports (with dots)
	 * e.g., [".py"] or [".ts", ".tsx", ".js", ".jsx"]
	 */
	protected abstract getSupportedExtensions(): string[];

	/**
	 * Parse CLI output into diagnostics
	 */
	protected abstract parseOutput(output: string, filePath: string): T[];

	/**
	 * Check if the CLI tool is available (cached)
	 */
	isAvailable(): boolean {
		if (this.available !== null) return this.available;

		const cmd = this.getCheckCommand();
		try {
			const result = spawnSync(cmd[0], cmd.slice(1), {
				encoding: "utf-8",
				timeout: 10000,
				shell: true,
			});

			this.available = !result.error && result.status === 0;
			if (this.available) {
				this.log(`${this.toolName} found`);
			} else {
				this.log(`${this.toolName} not available`);
			}
		} catch {
			this.available = false;
		}

		return this.available;
	}

	/**
	 * Check if a file is supported by this tool
	 */
	isSupportedFile(filePath: string): boolean {
		const ext = path.extname(filePath).toLowerCase();
		return this.getSupportedExtensions().includes(ext);
	}

	/**
	 * Run the tool on a file and return diagnostics
	 */
	abstract checkFile(filePath: string): T[];

	/**
	 * Run a command and return the result
	 */
	protected runCommand(
		cmd: string[],
		options: {
			cwd?: string;
			timeout?: number;
			input?: string;
		} = {},
	): ReturnType<typeof spawnSync> {
		const { cwd, timeout = 15000, input } = options;

		try {
			const result = spawnSync(cmd[0], cmd.slice(1), {
				encoding: "utf-8",
				timeout,
				cwd,
				shell: true,
				input,
			});

			if (result.error) {
				this.log(`Command error: ${result.error.message}`);
			}

			return result;
		} catch (err: any) {
			this.log(`Command failed: ${err.message}`);
			return {
				error: err,
				status: 1,
				stdout: "",
				stderr: err.message,
			} as unknown as ReturnType<typeof spawnSync>;
		}
	}

	/**
	 * Resolve a file path to absolute
	 */
	protected resolvePath(filePath: string): string {
		return path.resolve(filePath);
	}

	/**
	 * Check if a file exists
	 */
	protected fileExists(filePath: string): boolean {
		return fs.existsSync(filePath);
	}
}
