/**
 * Go Client for pi-lens
 *
 * Provides Go type checking and linting via gopls and go vet.
 *
 * Requires: gopls (go install golang.org/x/tools/gopls@latest)
 * Docs: https://pkg.go.dev/golang.org/x/tools/gopls
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// --- Types ---

export interface GoDiagnostic {
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	severity: "error" | "warning" | "info";
	message: string;
	rule?: string;
	file: string;
}

// --- Common install paths ---

const GO_WINDOWS_PATHS = [
	"C:\\Program Files\\Go\\bin\\go.exe",
	"C:\\Go\\bin\\go.exe",
	"go.exe", // PATH
];

const GO_UNIX_PATHS = [
	"/usr/local/go/bin/go",
	"/usr/bin/go",
	"go", // PATH
];

// --- Client ---

export class GoClient {
	private goplsAvailable: boolean | null = null;
	private goAvailable: boolean | null = null;
	private goPath: string | null = null;
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose ? (msg: string) => console.log(`[go] ${msg}`) : () => {};
	}

	/**
	 * Find go executable path
	 */
	private findGoPath(): string | null {
		if (this.goPath) return this.goPath;

		const paths =
			process.platform === "win32" ? GO_WINDOWS_PATHS : GO_UNIX_PATHS;

		for (const p of paths) {
			try {
				if (p.includes("\\") || p.includes("/")) {
					// Absolute path - check if exists
					if (fs.existsSync(p)) {
						this.goPath = p;
						return p;
					}
				} else {
					// Relative (PATH) - try running it
					const result = spawnSync(p, ["version"], {
						encoding: "utf-8",
						timeout: 3000,
						shell: true,
					});
					if (!result.error && result.status === 0) {
						this.goPath = p;
						return p;
					}
				}
			} catch (err) { void err; }
		}

		return null;
	}

	/**
	 * Check if Go is installed
	 */
	isGoAvailable(): boolean {
		if (this.goAvailable !== null) return this.goAvailable;
		this.goAvailable = this.findGoPath() !== null;
		if (this.goAvailable) {
			this.log(`Go found: ${this.goPath}`);
		}
		return this.goAvailable;
	}

	/**
	 * Check if gopls is installed
	 */
	isGoplsAvailable(): boolean {
		if (this.goplsAvailable !== null) return this.goplsAvailable;

		const result = spawnSync("gopls", ["version"], {
			encoding: "utf-8",
			timeout: 5000,
			shell: true,
		});

		this.goplsAvailable = !result.error && result.status === 0;
		if (this.goplsAvailable) {
			this.log(`gopls found: ${result.stdout?.trim()}`);
		}
		return this.goplsAvailable;
	}

	/**
	 * Check if a file is a Go file
	 */
	isGoFile(filePath: string): boolean {
		return path.extname(filePath).toLowerCase() === ".go";
	}

	/**
	 * Run go vet on a file and return diagnostics
	 */
	checkFile(filePath: string): GoDiagnostic[] {
		const goExe = this.findGoPath();
		if (!goExe) return [];

		const absolutePath = path.resolve(filePath);
		if (!fs.existsSync(absolutePath)) return [];

		const dir = path.dirname(absolutePath);
		const fileName = path.basename(absolutePath);

		try {
			// Run go vet on the specific file
			const goCmd = goExe.includes(" ") ? `"${goExe}"` : goExe;
			const result = spawnSync(goCmd, ["vet", fileName], {
				encoding: "utf-8",
				timeout: 15000,
				cwd: dir,
				shell: true,
			});

			const output = (result.stderr || "") + (result.stdout || "");
			return this.parseOutput(output, absolutePath);
		} catch (err: any) {
			this.log(`Check error: ${err.message}`);
			return [];
		}
	}

	/**
	 * Run go build to check for compilation errors
	 */
	buildCheck(cwd: string): GoDiagnostic[] {
		if (!this.isGoAvailable()) return [];

		try {
			const result = spawnSync("go", ["build", "./..."], {
				encoding: "utf-8",
				timeout: 30000,
				cwd,
				shell: true,
			});

			const output = (result.stderr || "") + (result.stdout || "");
			return this.parseOutput(output, cwd);
		} catch (err: any) {
			this.log(`Build check error: ${err.message}`);
			return [];
		}
	}

	/**
	 * Format diagnostics for LLM consumption
	 */
	formatDiagnostics(diags: GoDiagnostic[], maxItems = 10): string {
		if (diags.length === 0) return "";

		const errors = diags.filter((d) => d.severity === "error");
		const warnings = diags.filter((d) => d.severity === "warning");

		let output = `[Go] ${diags.length} issue(s)`;
		if (errors.length) output += ` — ${errors.length} error(s)`;
		if (warnings.length) output += ` — ${warnings.length} warning(s)`;
		output += ":\n";

		for (const d of diags.slice(0, maxItems)) {
			const loc = `L${d.line}:${d.column}`;
			const rule = d.rule ? ` [${d.rule}]` : "";
			output += `  [${d.severity}] ${loc} ${d.message}${rule}\n`;
		}

		if (diags.length > maxItems) {
			output += `  ... and ${diags.length - maxItems} more\n`;
		}

		return output;
	}

	// --- Internal ---

	private parseOutput(output: string, fileOrDir: string): GoDiagnostic[] {
		if (!output.trim()) return [];

		const diags: GoDiagnostic[] = [];
		// Go vet/build output format: "file.go:line:col: message"
		const pattern = /^(.+?):(\d+):(?:(\d+):)?\s*(?:([^:]+):\s*)?(.+)$/gm;
		let match;

		while ((match = pattern.exec(output)) !== null) {
			const [, file, line, col, rule, message] = match;
			const lineNum = parseInt(line, 10);
			const colNum = col ? parseInt(col, 10) : 1;

			// Filter to the specific file if a file path was provided
			const absFile = path.isAbsolute(file)
				? file
				: path.resolve(path.dirname(fileOrDir), file);
			if (path.extname(absFile) !== ".go") continue;

			const isError =
				message.includes("undefined") ||
				message.includes("cannot") ||
				message.includes("syntax error") ||
				rule === "compile";

			diags.push({
				line: lineNum,
				column: colNum - 1,
				endLine: lineNum,
				endColumn: colNum,
				severity: isError ? "error" : "warning",
				message: message.trim().slice(0, 300),
				rule: rule?.trim(),
				file: absFile,
			});
		}

		return diags;
	}
}
