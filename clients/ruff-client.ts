/**
 * Ruff Client for pi-lens
 *
 * Fast Python linting and formatting via Ruff CLI.
 * Replaces flake8, pylint, isort, black, pyupgrade.
 *
 * Requires: pip install ruff
 * Docs: https://docs.astral.sh/ruff/
 */

import { createSubsystemLogger } from "./extension-log.js";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	createAvailabilityChecker,
	resolveAvailableOrInstall,
} from "./dispatch/runners/utils/runner-helpers.js";
import { isFileKind } from "./file-kinds.js";
import { pathsEqual } from "./path-utils.js";
import { safeSpawnAsync } from "./safe-spawn.js";
import { resolveToolCwd } from "./tool-cwd.js";
import { ruffConfigArgs } from "./tool-policy.js";

// --- Types ---

export interface RuffDiagnostic {
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	severity: "error" | "warning";
	message: string;
	rule: string;
	file: string;
	fixable: boolean;
}

// ruff check --output-format json
interface RuffJsonDiagnostic {
	code: string | null;
	message: string;
	location: { row: number; column: number };
	end_location: { row: number; column: number };
	fix: { applicability: string } | null;
	filename: string;
}

// --- Client ---

const ruffAvailability = createAvailabilityChecker("ruff", ".exe");

export class RuffClient {
	private ruffCommand = "ruff";
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose ? createSubsystemLogger("ruff") : () => {};
	}

	/**
	 * Check if ruff CLI is available, auto-install if not.
	 *
	 * Re-entrancy safe: the shared availability seam deduplicates the complete
	 * probe/auto-install transaction per cwd and tool, so concurrent callers do
	 * not duplicate installation attempts.
	 */
	async ensureAvailable(): Promise<boolean> {
		const resolved = await resolveAvailableOrInstall(
			ruffAvailability,
			"ruff",
			process.cwd(),
		);
		if (!resolved) return false;
		this.ruffCommand = resolved;
		return true;
	}

	/**
	 * Check if a file is a Python file
	 */
	isPythonFile(filePath: string): boolean {
		return isFileKind(filePath, "python");
	}

	/**
	 * Async auto-fix variant for pipeline use (non-blocking spawn).
	 * `cwd` is the dispatch language root. It is the seam's starting point,
	 * not the answer: `resolveToolCwd` walks from the file to the nearest
	 * `pyproject.toml`/`ruff.toml`/`.ruff.toml` at or above it, capped inside
	 * `cwd` (and at `$HOME` when there is none), so a file in a nested package
	 * gets that package's config rather than the workspace-root one.
	 */
	async fixFileAsync(
		filePath: string,
		cwd?: string,
	): Promise<{
		success: boolean;
		changed: boolean;
		fixed: number;
		error?: string;
	}> {
		if (!(await this.ensureAvailable())) {
			return {
				success: false,
				changed: false,
				fixed: 0,
				error: "Ruff not available",
			};
		}

		const absolutePath = path.resolve(filePath);
		if (!fs.existsSync(absolutePath)) {
			return {
				success: false,
				changed: false,
				fixed: 0,
				error: "File not found",
			};
		}

		try {
			const before = await fs.promises.readFile(absolutePath, "utf-8");

			// #2894: the root ruff resolves its config from now comes from the
			// shared seam, not a local `cwd ?? path.dirname(file)`. `tool-policy.ts`
			// requires the lint runner (`ruff.ts`, on `resolveRunnerCwd`) and this
			// autofix path to consume the SAME policy; deriving the root two
			// different ways is how they drift, and the hand-rolled form ignored a
			// nested `pyproject.toml` whenever the caller passed a workspace root.
			const ruffCwd = resolveToolCwd("runner", "ruff", absolutePath, {
				...(cwd !== undefined && { cwd }),
			}).cwd;
			// Shared config-args seam (#1247): the lint runner consumes the same
			// builder, so `check --fix` can never drift to ruff's default rule
			// set when the project lacks its own config and the package-owned
			// core.toml fallback applies.
			const configArgs = ruffConfigArgs(ruffCwd);

			const pre = await safeSpawnAsync(
				this.ruffCommand,
				[
					"check",
					// `--no-fix --no-fix-only` (#5119): the count below must see the
					// findings; a project `fix = true` / `fix-only = true` made this
					// pass fix them first.
					"--no-fix",
					"--no-fix-only",
					"--output-format",
					"json",
					// No target-version override here (#4638): one made the pre-check
					// parse at py310 while `check --fix` below (and the lint runner)
					// read the project's own setting, so a 3.12-only line looked
					// fixable to one pass and unparseable to the other. Ruff
					// discovers the level from the project config itself; a value
					// derived here would be a second owner of that decision.
					...configArgs,
					absolutePath,
				],
				{ timeout: 10000, cwd: ruffCwd },
			);
			const beforeDiags = pre.stdout?.trim()
				? this.parseOutput(pre.stdout, ruffCwd, absolutePath)
				: [];
			const fixableCount = beforeDiags.filter((d) => d.fixable).length;

			const fix = await safeSpawnAsync(
				this.ruffCommand,
				["check", "--fix", ...configArgs, absolutePath],
				{ timeout: 15000, cwd: ruffCwd },
			);

			if (fix.error) {
				return {
					success: false,
					changed: false,
					fixed: 0,
					error: fix.error.message,
				};
			}

			const after = await fs.promises.readFile(absolutePath, "utf-8");
			const changed = before !== after;

			if (changed) {
				this.log(
					`Fixed ${fixableCount} issue(s) in ${path.basename(filePath)}`,
				);
			}

			return { success: true, changed, fixed: fixableCount };
		} catch (err: any) {
			return { success: false, changed: false, fixed: 0, error: err.message };
		}
	}

	// --- Internal ---

	/**
	 * `cwd` is the directory ruff RAN in, and it is REQUIRED: a default would
	 * hide the wrong base at a call site that forgot it (#3284's D11).
	 *
	 * ruff's JSON `filename` is the `SourceFile`'s name verbatim — the JSON
	 * renderer reads `span.file().path(resolver)` (ruff 0.16.8
	 * `crates/ruff_db/src/diagnostic/render/json.rs:58,120`), which for a ruff
	 * (not `ty`) diagnostic is `file.name()` (`crates/ruff_db/src/diagnostic/
	 * mod.rs:1187-1193`), NOT the cwd-relative `relative_path` the text
	 * renderers use (`mod.rs:1195-1204`). That name is
	 * `SourceFileBuilder::new(path.to_string_lossy(), …)`
	 * (`crates/ruff_linter/src/linter.rs:1049`) over a path the resolver has
	 * already absolutized ("Normalize every path (e.g., convert from relative to
	 * absolute)", `crates/ruff_workspace/src/resolver.rs:484`). So ruff echoes
	 * the absolute path we hand it as argv: the BASE was already right here and
	 * the fold deletes a `path.resolve` with no base — which silently meant the
	 * EXTENSION's `process.cwd()`, not ruff's — rather than leaving it for a
	 * future relative invocation to re-enable.
	 */
	private parseOutput(
		output: string,
		cwd: string,
		filterFile?: string,
	): RuffDiagnostic[] {
		if (!output.trim()) return [];

		try {
			const items: RuffJsonDiagnostic[] = JSON.parse(output);
			const diagnostics: RuffDiagnostic[] = [];

			for (const item of items) {
				// Filter to single file if requested. #3278/#3286: one seam answers
				// "is this reported diagnostic about the file I ran for?" — resolve
				// the tool's spelling against the cwd the tool RAN in and compare
				// through `pathsEqual`, the repo's on-disk identity predicate. A bare
				// `!==` treats a spelling that differs only in case (the SAME file on
				// Windows and on a case-folding POSIX mount) as a different file and
				// drops every finding for the edited file (#209, #3277).
				if (
					filterFile &&
					!pathsEqual(path.resolve(cwd, item.filename), filterFile)
				)
					continue;

				diagnostics.push({
					line: item.location.row - 1, // ruff is 1-indexed
					column: item.location.column - 1,
					endLine: item.end_location.row - 1,
					endColumn: item.end_location.column - 1,
					severity: item.code?.startsWith("E") ? "error" : "warning",
					message: item.message,
					rule: item.code || "unknown",
					file: item.filename,
					fixable: item.fix !== null,
				});
			}

			return diagnostics;
		} catch (err) {
			void err;
			this.log("Failed to parse ruff JSON output");
			return [];
		}
	}
}
