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
//
// #2698 review round 2, F3: the `git ls-files` listing this repo produces is
// 451 KB today (43% of Node's 1 MB default `maxBuffer`) and grows with every
// dependency bump (it walks node_modules' own ignored/tracked state too) --
// so an unbounded call was one `npm install` away from ENOBUFS. `maxBuffer`
// is now 16 MB (same value scripts/prune-agent-worktrees.mjs's own `git()`
// helper uses for the same class of listing), and a wall-clock `timeout` +
// `killSignal` guards a stalled call the same way: that file's own comment
// records a single `git status --porcelain` measured over 100 SECONDS on
// this box under multi-agent contention (#2435) -- a phenomenon of THIS
// machine, not of `git ls-files` specifically, so the same bound applies
// here. Both failures now THROW (never silently degrade) -- the caller
// (scripts/lib/knip-runner.mjs) must fail loudly, not run knip against a
// still-built tree that would silently regenerate the false "unused files"
// report this wrapper exists to prevent.
import { existsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as path from "node:path";

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;

/**
 * @typedef {{
 *   git?: (args: string[]) => string,
 *   maxBuffer?: number,
 * }} PurgeDeps `git` is an injectable git runner for tests; defaults to a
 *   real `git` child process. `maxBuffer` overrides the real runner's
 *   buffer cap (tests only -- `deps.git` bypasses it entirely).
 */

/**
 * @param {string} repoRoot
 * @param {PurgeDeps} [deps]
 * @returns {string[]} repo-relative paths of the files removed, sorted.
 */
export function purgeCompiledSiblings(repoRoot, deps = {}) {
	const git =
		deps.git ??
		((args) =>
			execFileSync("git", args, {
				cwd: repoRoot,
				encoding: "utf-8",
				shell: false,
				maxBuffer: deps.maxBuffer ?? DEFAULT_MAX_BUFFER,
				timeout: GIT_TIMEOUT_MS,
				killSignal: "SIGKILL",
			}));

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
