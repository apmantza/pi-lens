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
import { resolveToolCommandWithInstallFallback } from "./dispatch/runners/utils/runner-helpers.js";
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

export class RuffClient {
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose ? createSubsystemLogger("ruff") : () => {};
	}

	/**
	 * Check if ruff CLI is available for `cwd`, auto-install if not.
	 *
	 * The answer is the shared per-tool resolver's (#5410), the one the
	 * `ruff-lint` runner asks, so the lint and the fix run the same binary:
	 * the project's own venv at exactly `cwd`, then managed, then PATH. The
	 * default `process.cwd()` is for the session-start warm-up, which has no
	 * file; a fix names the cwd its file runs in.
	 */
	async ensureAvailable(cwd: string = process.cwd()): Promise<boolean> {
		return (await resolveToolCommandWithInstallFallback(cwd, "ruff")) !== null;
	}

	/** Resolve the command and cwd a file's runner will use, before any write hold. */
	async resolveCommandForFile(
		filePath: string,
		cwd?: string,
	): Promise<{ cwd: string; command: string | null }> {
		const resolvedCwd = resolveToolCwd(
			"runner",
			"ruff",
			path.resolve(filePath),
			{
				...(cwd !== undefined && { cwd }),
			},
		).cwd;
		return {
			cwd: resolvedCwd,
			command: await resolveToolCommandWithInstallFallback(resolvedCwd, "ruff"),
		};
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
		ruffCommand?: string | null,
	): Promise<{
		success: boolean;
		changed: boolean;
		fixed: number;
		error?: string;
	}> {
		const absolutePath = path.resolve(filePath);
		// #2894: the root ruff resolves its config from comes from the shared
		// seam, not a local `cwd ?? path.dirname(file)`. `tool-policy.ts`
		// requires the lint runner (`ruff.ts`, on `resolveRunnerCwd`) and this
		// autofix path to consume the SAME policy; deriving the root two
		// different ways is how they drift, and the hand-rolled form ignored a
		// nested `pyproject.toml` whenever the caller passed a workspace root.
		// The binary is asked at that same root (#5410), so the fix runs the
		// ruff the lint ran.
		const resolution =
			ruffCommand === undefined
				? await this.resolveCommandForFile(absolutePath, cwd)
				: { cwd: cwd ?? path.dirname(absolutePath), command: ruffCommand };
		const ruffCwd = resolution.cwd;
		const resolvedRuffCommand = resolution.command;
		if (resolvedRuffCommand === null) {
			return {
				success: false,
				changed: false,
				fixed: 0,
				error: "Ruff not available",
			};
		}

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

			// Shared config-args seam (#1247): the lint runner consumes the same
			// builder, so `check --fix` can never drift to ruff's default rule
			// set when the project lacks its own config and the package-owned
			// core.toml fallback applies.
			const configArgs = ruffConfigArgs(ruffCwd);

			const pre = await safeSpawnAsync(
				resolvedRuffCommand,
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
				resolvedRuffCommand,
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
