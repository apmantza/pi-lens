/**
 * Dependency Checker for pi-local
 *
 * Real-time circular dependency detection.
 * Caches the dependency graph and only re-scans when imports change.
 * Runs in the tool_result hook like ast-grep and Biome.
 *
 * Requires: npm install -D madge
 * Docs: https://github.com/pahen/madge
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { safeSpawn, safeSpawnAsync } from "./safe-spawn.js";

// --- Types ---

export interface CircularDep {
	file: string;
	path: string[]; // The cycle path
}

export interface DepCheckResult {
	hasCircular: boolean;
	circular: CircularDep[];
	checked: boolean;
	cacheHit: boolean;
}

// --- Graph Cache ---

interface FileImports {
	imports: Set<string>;
	timestamp: number;
}

// --- Client ---

export class DependencyChecker {
	private available: boolean | null = null;
	private log: (msg: string) => void;

	// Cache: file path -> its imports
	private importCache = new Map<string, FileImports>();

	// Circular deps: last known circular deps
	private lastCircular: CircularDep[] = [];

	// Files that are part of a circular dependency
	private circularFiles = new Set<string>();

	constructor(verbose = false) {
		this.log = verbose
			? (msg: string) => console.error(`[deps] ${msg}`)
			: () => {};
	}

	/**
	 * Check if madge is available, auto-install if not
	 */
	async ensureAvailable(): Promise<boolean> {
		// Fast path: already checked
		if (this.available !== null) return this.available;

		// Check if available in PATH
		const result = await safeSpawnAsync("madge", ["--version"], {
			timeout: 5000,
		});
		this.available = !result.error && result.status === 0;

		if (this.available) {
			this.log(`Madge found: ${result.stdout?.trim()}`);
			return true;
		}

		// Auto-install via pi-lens installer
		this.log("Madge not found, attempting auto-install...");
		const { ensureTool } = await import("./installer/index.js");
		const installedPath = await ensureTool("madge");

		if (installedPath) {
			this.log(`Madge auto-installed: ${installedPath}`);
			this.available = true;
			return true;
		}

		this.log("Madge auto-install failed");
		return false;
	}

	/**
	 * Check if madge is available (legacy sync method)
	 * Prefer ensureAvailable() for auto-install behavior
	 */
	isAvailable(): boolean {
		if (this.available !== null) return this.available;

		const result = safeSpawn("npx", ["madge", "--version"], {
			timeout: 5000,
		});

		this.available = !result.error && result.status === 0;
		if (this.available) {
			this.log("Madge available for dependency checking");
		}

		return this.available;
	}

	/**
	 * Check if a file is part of a circular dependency (from cache)
	 */
	isInCircular(filePath: string): boolean {
		const normalized = path.resolve(filePath);
		return this.circularFiles.has(normalized);
	}

	/**
	 * Get circular deps for a specific file
	 */
	getCircularForFile(filePath: string): string[] {
		const normalized = path.resolve(filePath);
		const deps: string[] = [];

		for (const dep of this.lastCircular) {
			if (dep.file === normalized || dep.path.includes(normalized)) {
				// Add the other files in the cycle
				for (const f of dep.path) {
					if (f !== normalized) {
						deps.push(path.relative(process.cwd(), f));
					}
				}
			}
		}

		return Array.from(new Set(deps));
	}

	/**
	 * Extract imports from a TypeScript/JavaScript file
	 */
	extractImports(filePath: string): Set<string> {
		const content = fs.readFileSync(filePath, "utf-8");
		const imports = new Set<string>();

		// Match import statements: import ... from '...'
		const importPattern =
			/(?:import|export)\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
		const requirePattern = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

		let match;
		while ((match = importPattern.exec(content)) !== null) {
			if (match[1].startsWith(".")) {
				imports.add(match[1]);
			}
		}

		while ((match = requirePattern.exec(content)) !== null) {
			if (match[1].startsWith(".")) {
				imports.add(match[1]);
			}
		}

		return imports;
	}

	/**
	 * Check if imports have changed for a file
	 */
	importsChanged(filePath: string): boolean {
		const normalized = path.resolve(filePath);

		if (!fs.existsSync(normalized)) {
			this.importCache.delete(normalized);
			return true;
		}

		const stat = fs.statSync(normalized);
		const cached = this.importCache.get(normalized);

		// Fast path: timestamp hasn't changed
		if (cached && cached.timestamp >= stat.mtimeMs) {
			return false;
		}

		// Compare actual imports
		const newImports = this.extractImports(normalized);
		const hasChanged = !cached || !this.setsEqual(cached.imports, newImports);

		// Update cache
		this.importCache.set(normalized, {
			imports: newImports,
			timestamp: stat.mtimeMs,
		});
		return hasChanged;
	}

	/**
	 * Check if two sets have the same elements
	 */
	private setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
		if (a.size !== b.size) return false;
		for (const item of a) {
			if (!b.has(item)) return false;
		}
		return true;
	}

	/**
	 * Quick circular dependency check using DFS on cached graph.
	 * Only re-runs full madge check when imports change.
	 */
	checkFile(filePath: string, cwd?: string): DepCheckResult {
		const normalized = path.resolve(filePath);

		// Return early for non-existent files without running availability check
		if (!fs.existsSync(normalized)) {
			return {
				hasCircular: false,
				circular: [],
				checked: false,
				cacheHit: false,
			};
		}

		if (!this.isAvailable()) {
			return {
				hasCircular: false,
				circular: [],
				checked: false,
				cacheHit: false,
			};
		}

		const projectRoot = cwd || process.cwd();

		// Check if imports changed
		const importsChanged = this.importsChanged(normalized);

		if (!importsChanged) {
			// Return cached result
			return {
				hasCircular: this.circularFiles.has(normalized),
				circular: this.lastCircular.filter(
					(d) => d.file === normalized || d.path.includes(normalized),
				),
				checked: true,
				cacheHit: true,
			};
		}

		this.log(
			`Imports changed for ${path.basename(filePath)}, checking dependencies...`,
		);

		// Run madge on the specific file (fast)
		try {
			const result = safeSpawn(
				"npx",
				[
					"madge",
					"--circular",
					"--extensions",
					"ts,tsx,js,jsx",
					"--json",
					normalized,
				],
				{
					timeout: 15000,
					cwd: projectRoot,
				},
			);

			const output = result.stdout || "[]";
			const parsed = JSON.parse(output);

			// Madge --circular --json returns array of cycle arrays: [["a.ts", "b.ts"], ...]
			const cycles: string[][] = Array.isArray(parsed) ? parsed : [];
			const circular: CircularDep[] = [];
			const circularFiles = new Set<string>();

			for (const cycle of cycles) {
				const resolvedPaths = cycle.map((f: string) =>
					path.resolve(projectRoot, f),
				);
				for (const f of resolvedPaths) {
					circularFiles.add(f);
				}
				circular.push({
					file: resolvedPaths[0],
					path: resolvedPaths,
				});
			}

			this.lastCircular = circular;
			this.circularFiles = circularFiles;

			return {
				hasCircular: circular.length > 0,
				circular: circular.filter(
					(d) => d.file === normalized || d.path.includes(normalized),
				),
				checked: true,
				cacheHit: false,
			};
		} catch (err: any) {
			this.log(`Check error: ${err.message}`);
			return {
				hasCircular: false,
				circular: [],
				checked: false,
				cacheHit: false,
			};
		}
	}

	/**
	 * Format circular dependency warning for LLM
	 */
	formatWarning(filePath: string, deps: string[]): string {
		if (deps.length === 0) return "";

		const filename = path.basename(filePath);
		const depNames = deps.map((d) => path.basename(d));

		let output = `[Circular Deps] ${filename} is in a cycle:\n`;
		output += `  ${filename} ↔ ${depNames.join(", ")}\n`;
		output += `\n  Consider extracting shared code to a separate module.\n`;

		return output;
	}

	/**
	 * Full project scan (for /check-deps command)
	 */
	scanProject(cwd?: string): { circular: CircularDep[]; count: number } {
		const projectRoot = cwd || process.cwd();

		// Return early for non-existent or empty directories
		if (!fs.existsSync(projectRoot)) {
			return { circular: [], count: 0 };
		}
		const entries = fs.readdirSync(projectRoot);
		const hasSourceFiles = entries.some(
			(e) => /\.(ts|tsx|js|jsx)$/.test(e) && !e.endsWith(".d.ts"),
		);
		if (!hasSourceFiles) {
			return { circular: [], count: 0 };
		}

		if (!this.isAvailable()) {
			return { circular: [], count: 0 };
		}

		try {
			const result = safeSpawn(
				"npx",
				[
					"madge",
					"--circular",
					"--extensions",
					"ts,tsx,js,jsx",
					"--json",
					projectRoot,
				],
				{
					timeout: 30000,
					cwd: projectRoot,
				},
			);

			const output = result.stdout || "{}";
			const data = JSON.parse(output);

			const circular: CircularDep[] = [];
			const circularFiles = new Set<string>();

			for (const [file, deps] of Object.entries(data)) {
				if (Array.isArray(deps) && deps.length > 0) {
					const resolvedFile = path.resolve(file);
					circularFiles.add(resolvedFile);

					circular.push({
						file: resolvedFile,
						path: [resolvedFile, ...deps.map((d: string) => path.resolve(d))],
					});
				}
			}

			this.lastCircular = circular;
			this.circularFiles = circularFiles;

			return { circular, count: circular.length };
		} catch (err: any) {
			this.log(`Scan error: ${err.message}`);
			return { circular: [], count: 0 };
		}
	}

	/**
	 * Format full scan results
	 */
	formatScanResult(circular: CircularDep[]): string {
		if (circular.length === 0) return "";

		// Group by cycle to avoid duplicate entries
		const seen = new Set<string>();
		let output = `[Circular Deps] ${circular.length} cycle(s) found:\n`;

		for (const dep of circular) {
			const cycleKey = dep.path.sort().join("→");
			if (seen.has(cycleKey)) continue;
			seen.add(cycleKey);

			const names = dep.path.map((p) => path.relative(process.cwd(), p));
			output += `  • ${names.join(" → ")}\n`;
		}

		output += "\n  Consider extracting shared code to break cycles.\n";

		return output;
	}
}
