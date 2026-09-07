// scripts/lib/knip-sibling-purge.mjs (#2698)
//
// The compiled-sibling-removal logic scripts/run-knip.mjs needs before every
// `knip` invocation, split out so it's importable from a test without
// spawning the real `knip` binary. See scripts/run-knip.mjs's header comment
// for WHY this is required (knip's resolver prefers an existing `.js` file
// over a `.ts` source for a `.js` specifier, and its graph walker does not
// gitignore-filter a resolved import target).
//
// Scoped and reversible on purpose: only a file that is BOTH (a) untracked
// and gitignored (`git ls-files --others --ignored --exclude-standard`) AND
// (b) sits beside a TRACKED `.ts` file of the same basename is removed.
// Never a bare `git clean` — that would also sweep grammars/, dist/, and any
// other gitignored state this script has no business touching.
import { existsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as path from "node:path";

/**
 * @typedef {{ git?: (args: string[]) => string }} PurgeDeps injectable git
 *   runner for tests; defaults to a real `git` child process.
 */

/**
 * @param {string} repoRoot
 * @param {PurgeDeps} [deps]
 * @returns {string[]} repo-relative paths of the files removed, sorted.
 */
export function purgeCompiledSiblings(repoRoot, deps = {}) {
	const git =
		deps.git ??
		((args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8" }));

	const ignoredJs = git([
		"ls-files",
		"--others",
		"--ignored",
		"--exclude-standard",
		"--",
		"*.js",
	]);
	const trackedTs = git(["ls-files", "--", "*.ts"]);

	const tsFiles = new Set(trackedTs.split("\n").filter(Boolean));
	const purged = [];
	for (const jsRelPath of ignoredJs.split("\n").filter(Boolean)) {
		const tsRelPath = `${jsRelPath.slice(0, -".js".length)}.ts`;
		if (!tsFiles.has(tsRelPath)) continue;
		const absPath = path.join(repoRoot, jsRelPath);
		if (existsSync(absPath)) {
			unlinkSync(absPath);
			purged.push(jsRelPath);
		}
	}
	return purged.sort();
}
