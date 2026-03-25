/**
 * Rust Client for pi-lens
 *
 * Provides Rust type checking and linting via cargo check and clippy.
 *
 * Requires: cargo (rustup)
 * Docs: https://doc.rust-lang.org/cargo/
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// --- Types ---

export interface RustDiagnostic {
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	severity: "error" | "warning" | "note" | "help";
	message: string;
	code?: string;
	file: string;
}

interface CargoMessage {
	reason: "compiler-artifact" | "compiler-message" | "build-script-executed";
	message?: {
		level: string;
		code?: string;
		message: string;
		spans?: Array<{
			line_start: number;
			line_end: number;
			column_start: number;
			column_end: number;
			file_name: string;
		}>;
	};
}

// --- Common install paths ---

const CARGO_WINDOWS_PATHS = [
	path.join(process.env.USERPROFILE || "", ".cargo", "bin", "cargo.exe"),
	"C:\\cargo\\bin\\cargo.exe",
	"cargo.exe", // PATH
];

const CARGO_UNIX_PATHS = [
	path.join(process.env.HOME || "", ".cargo", "bin", "cargo"),
	"/usr/local/cargo/bin/cargo",
	"/usr/bin/cargo",
	"cargo", // PATH
];

// --- Client ---

export class RustClient {
	private cargoAvailable: boolean | null = null;
	private cargoPath: string | null = null;
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose
			? (msg: string) => console.log(`[rust] ${msg}`)
			: () => {};
	}

	/**
	 * Find cargo executable path
	 */
	private findCargoPath(): string | null {
		if (this.cargoPath) return this.cargoPath;

		const paths =
			process.platform === "win32" ? CARGO_WINDOWS_PATHS : CARGO_UNIX_PATHS;

		for (const p of paths) {
			try {
				if (p.includes("\\") || p.includes("/")) {
					if (fs.existsSync(p)) {
						this.cargoPath = p;
						return p;
					}
				} else {
					const result = spawnSync(p, ["--version"], {
						encoding: "utf-8",
						timeout: 3000,
						shell: true,
					});
					if (!result.error && result.status === 0) {
						this.cargoPath = p;
						return p;
					}
				}
			} catch (err) { void err; }
		}

		return null;
	}

	/**
	 * Check if cargo is installed
	 */
	isAvailable(): boolean {
		if (this.cargoAvailable !== null) return this.cargoAvailable;
		this.cargoAvailable = this.findCargoPath() !== null;
		if (this.cargoAvailable) {
			this.log(`Cargo found: ${this.cargoPath}`);
		}
		return this.cargoAvailable;
	}

	/**
	 * Check if a file is a Rust file
	 */
	isRustFile(filePath: string): boolean {
		return path.extname(filePath).toLowerCase() === ".rs";
	}

	/**
	 * Run cargo check on the project
	 */
	checkFile(filePath: string, cwd: string): RustDiagnostic[] {
		const cargoExe = this.findCargoPath();
		if (!cargoExe) return [];

		const absolutePath = path.resolve(filePath);
		if (!fs.existsSync(absolutePath)) return [];

		try {
			const cargoCmd = cargoExe.includes(" ") ? `"${cargoExe}"` : cargoExe;
			const result = spawnSync(
				cargoCmd,
				["check", "--message-format", "json"],
				{
					encoding: "utf-8",
					timeout: 60000,
					cwd,
					shell: true,
				},
			);

			const output = result.stdout || "";
			return this.parseJsonOutput(output, absolutePath);
		} catch (err: any) {
			this.log(`Check error: ${err.message}`);
			return [];
		}
	}

	/**
	 * Run clippy for additional lints
	 */
	clippyCheck(cwd: string): RustDiagnostic[] {
		if (!this.isAvailable()) return [];

		try {
			const result = spawnSync(
				"cargo",
				["clippy", "--message-format", "json"],
				{
					encoding: "utf-8",
					timeout: 60000,
					cwd,
					shell: true,
				},
			);

			const output = result.stdout || "";
			return this.parseJsonOutput(output, "");
		} catch (err: any) {
			this.log(`Clippy error: ${err.message}`);
			return [];
		}
	}

	/**
	 * Format diagnostics for LLM consumption
	 */
	formatDiagnostics(diags: RustDiagnostic[], maxItems = 10): string {
		if (diags.length === 0) return "";

		const errors = diags.filter((d) => d.severity === "error");
		const warnings = diags.filter((d) => d.severity === "warning");

		let output = `[Rust] ${diags.length} issue(s)`;
		if (errors.length) output += ` — ${errors.length} error(s)`;
		if (warnings.length) output += ` — ${warnings.length} warning(s)`;
		output += ":\n";

		for (const d of diags.slice(0, maxItems)) {
			const loc = `L${d.line}:${d.column}`;
			const code = d.code ? ` [${d.code}]` : "";
			output += `  [${d.severity}] ${loc} ${d.message.slice(0, 200)}${code}\n`;
		}

		if (diags.length > maxItems) {
			output += `  ... and ${diags.length - maxItems} more\n`;
		}

		return output;
	}

	// --- Internal ---

	private parseJsonOutput(
		output: string,
		filterFile: string,
	): RustDiagnostic[] {
		if (!output.trim()) return [];

		const diags: RustDiagnostic[] = [];
		const lines = output.split("\n").filter((l) => l.trim());

		for (const line of lines) {
			try {
				const msg: CargoMessage = JSON.parse(line);

				if (msg.reason === "compiler-message" && msg.message) {
					const { level, message, spans, code } = msg.message;

					// Only include errors and warnings
					if (level !== "error" && level !== "warning" && level !== "note") {
						continue;
					}

					// Get location from spans
					if (spans && spans.length > 0) {
						for (const span of spans) {
							const file = span.file_name;

							// Filter to specific file if provided
							if (
								filterFile &&
								path.resolve(file) !== path.resolve(filterFile)
							) {
								continue;
							}

							diags.push({
								line: span.line_start,
								column: span.column_start - 1,
								endLine: span.line_end,
								endColumn: span.column_end - 1,
								severity: level as RustDiagnostic["severity"],
								message: message.slice(0, 300),
								code,
								file: path.resolve(file),
							});
						}
					} else {
						// No span info, add as general diagnostic
						diags.push({
							line: 1,
							column: 0,
							endLine: 1,
							endColumn: 0,
							severity: level as RustDiagnostic["severity"],
							message: message.slice(0, 300),
							code,
							file: filterFile || "",
						});
					}
				}
			} catch (err) { void err; } // Skip non-JSON lines
		}

		return diags;
	}
}
