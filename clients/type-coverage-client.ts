/**
 * TypeCoverage Client for pi-lens
 *
 * Measures what percentage of TypeScript identifiers are properly typed
 * (i.e. not implicitly or explicitly `any`). Complements the LSP — the LSP
 * catches hard errors, this catches type weakness.
 *
 * Requires: npm install -D type-coverage
 * Docs: https://github.com/plantain-00/type-coverage
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";

// --- Types ---

export interface TypeCoverageResult {
	success: boolean;
	percentage: number;
	typed: number;
	total: number;
	untypedLocations: UntypedLocation[];
}

export interface UntypedLocation {
	file: string;
	line: number;
	column: number;
	name: string;
}

// --- Client ---

export class TypeCoverageClient {
	private available: boolean | null = null;
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose
			? (msg) => console.log(`[type-coverage] ${msg}`)
			: () => {};
	}

	isAvailable(): boolean {
		if (this.available !== null) return this.available;
		const result = spawnSync("npx", ["type-coverage", "--version"], {
			encoding: "utf-8",
			timeout: 10000,
			shell: true,
		});
		this.available = !result.error && result.status === 0;
		return this.available;
	}

	/**
	 * Run type-coverage on the project at cwd.
	 * Uses --detail to get per-identifier locations for untyped names.
	 * Uses --strict to count `any` casts as untyped.
	 */
	scan(cwd: string): TypeCoverageResult {
		if (!this.isAvailable()) {
			return {
				success: false,
				percentage: 0,
				typed: 0,
				total: 0,
				untypedLocations: [],
			};
		}

		try {
			const result = spawnSync(
				"npx",
				[
					"type-coverage",
					"--detail",
					"--strict",
					"--ignore-files",
					"**/*.d.ts",
				],
				{
					encoding: "utf-8",
					timeout: 30000,
					cwd,
					shell: true,
				},
			);

			const output = (result.stdout ?? "") + (result.stderr ?? "");
			return this.parseOutput(output, cwd);
		} catch (err: any) {
			this.log(`Scan error: ${err.message}`);
			return {
				success: false,
				percentage: 0,
				typed: 0,
				total: 0,
				untypedLocations: [],
			};
		}
	}

	formatResult(result: TypeCoverageResult, maxLocations = 10): string {
		if (!result.success) return "";

		const pct = result.percentage.toFixed(1);
		let icon = "✗";
		if (result.percentage >= 95) icon = "✓";
		else if (result.percentage >= 80) icon = "⚠";

		let output = `[type-coverage] ${icon} ${pct}% typed (${result.typed}/${result.total} identifiers)`;

		if (result.untypedLocations.length === 0) {
			output += " — fully typed\n";
			return output;
		}

		output += `:\n`;
		for (const loc of result.untypedLocations.slice(0, maxLocations)) {
			output += `  ${path.basename(loc.file)}:${loc.line}:${loc.column} — ${loc.name}\n`;
		}

		if (result.untypedLocations.length > maxLocations) {
			output += `  ... and ${result.untypedLocations.length - maxLocations} more\n`;
		}

		return output;
	}

	// --- Internal ---

	private parseOutput(output: string, cwd: string): TypeCoverageResult {
		const untypedLocations: UntypedLocation[] = [];

		// Parse detail lines: "path/to/file.ts:line:col: name"
		const detailPattern = /^(.+):(\d+):(\d+):\s+(.+)$/gm;
		let match: RegExpExecArray | null;
		while ((match = detailPattern.exec(output)) !== null) {
			const [, file, line, col, name] = match;
			// Skip the summary line which also matches the pattern
			if (name.includes("%") || name.includes("/")) continue;
			untypedLocations.push({
				file: path.resolve(cwd, file),
				line: parseInt(line, 10),
				column: parseInt(col, 10),
				name: name.trim(),
			});
		}

		// Parse summary: "(3979 / 4100) 97.04%"
		const summaryMatch = output.match(/\((\d+)\s*\/\s*(\d+)\)\s*([\d.]+)%/);
		if (!summaryMatch) {
			return {
				success: false,
				percentage: 0,
				typed: 0,
				total: 0,
				untypedLocations: [],
			};
		}

		const typed = parseInt(summaryMatch[1], 10);
		const total = parseInt(summaryMatch[2], 10);
		const percentage = parseFloat(summaryMatch[3]);

		return { success: true, percentage, typed, total, untypedLocations };
	}
}
