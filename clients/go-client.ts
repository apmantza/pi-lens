/**
 * Go Client for pi-lens
 *
 * Provides Go type checking and linting via gopls and go vet.
 *
 * Requires: gopls (go install golang.org/x/tools/gopls@latest)
 * Docs: https://pkg.go.dev/golang.org/x/tools/gopls
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { safeSpawnAsync } from "./safe-spawn.js";

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
	private goAvailable: boolean | null = null;
	private goPath: string | null = null;
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose
			? (msg: string) => console.error(`[go] ${msg}`)
			: () => {};
	}

	/**
	 * Find go executable path (async — probes PATH candidates off the event loop).
	 */
	async findGoPathAsync(): Promise<string | null> {
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
					const result = await safeSpawnAsync(p, ["version"], {
						timeout: 3000,
					});
					if (!result.error && result.status === 0) {
						this.goPath = p;
						return p;
					}
				}
			} catch (err) {
				void err;
			}
		}

		return null;
	}

	/**
	 * Check if Go is installed (cached)
	 */
	async isGoAvailableAsync(): Promise<boolean> {
		if (this.goAvailable !== null) return this.goAvailable;
		this.goAvailable = (await this.findGoPathAsync()) !== null;
		if (this.goAvailable) {
			this.log(`Go found: ${this.goPath}`);
		}
		return this.goAvailable;
	}

	/**
	 * Check if a file is a Go file
	 */
	isGoFile(filePath: string): boolean {
		return path.extname(filePath).toLowerCase() === ".go";
	}

}
