#!/usr/bin/env node
/**
 * scripts/worktree-remove.mjs (#5111) -- the one sanctioned way to remove a
 * linked worktree.
 *
 *   node scripts/worktree-remove.mjs <path> [--force]
 *
 * The #3173 hazard: `git worktree remove` on a tree whose `node_modules` is a
 * symlink into the main checkout follows the link and empties the SHARED
 * install under every lane. The Bash guard (scripts/hooks/guard-bash.mjs)
 * denies a hand-typed remove over such a tree, and agents answered with an
 * `rm` first and a retry (215 refusals in 14 days, #3995 slice B). This
 * script is that sequence in one step, in order:
 *
 *   1. resolve `<path>` and refuse unless it is a registered LINKED worktree
 *      (not the main checkout, not a plain directory);
 *   2. `lstat` its `node_modules`: a symlink is unlinked (the link only, never
 *      its target), a real directory is a refusal -- never `rm -rf`, the
 *      #2704 class -- and anything else is left to git;
 *   3. `git worktree remove <path>`, with `--force` only when the caller
 *      passed it (a single force; git still refuses a locked tree).
 *
 * Every refusal happens before anything is unlinked. The decision on
 * `node_modules` reuses {@link classifyNodeModules}, the same classifier
 * `pr-worktree.mjs close` uses; `close` stays separate because it adds the
 * review-root, clean-tree and branch rails this script does not want.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { classifyNodeModules } from "./lib/pr-worktree.mjs";
import { parseWorktreeList } from "./lib/worktree-hygiene.mjs";

const USAGE = "usage: node scripts/worktree-remove.mjs <path> [--force]";

/** @param {string[]} args @param {{cwd?: string}} [options] */
function defaultGitExec(args, options = {}) {
	return execFileSync("git", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...options,
	});
}

/** @param {string} p @returns {string} */
function canonicalPath(p) {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

/**
 * The whole CLI, resolving an exit code instead of touching `process`.
 *
 * @param {{ argv?: string[], cwd?: string,
 *   gitExec?: (args: string[], options?: {cwd?: string}) => string,
 *   stdout?: (message: string) => void, stderr?: (message: string) => void }} [options]
 * @returns {number} 0 removed, 1 refused or failed, 2 usage
 */
export function run({
	argv = process.argv.slice(2),
	cwd = process.cwd(),
	gitExec = defaultGitExec,
	stdout = console.log,
	stderr = console.error,
} = {}) {
	let force = false;
	/** @type {string[]} */
	const targets = [];
	for (const arg of argv) {
		if (arg === "--force") force = true;
		else if (arg.startsWith("-") || targets.length > 0) {
			stderr(USAGE);
			return 2;
		} else targets.push(arg);
	}
	if (targets.length !== 1) {
		stderr(USAGE);
		return 2;
	}
	const target = canonicalPath(path.resolve(cwd, targets[0]));
	let rows;
	try {
		rows = parseWorktreeList(
			gitExec(["worktree", "list", "--porcelain"], { cwd: target }),
		);
	} catch (error) {
		stderr(`${target} is not inside a git worktree: ${error.message}`);
		return 1;
	}
	const mainRoot = rows[0] ? canonicalPath(rows[0].path) : null;
	if (target === mainRoot) {
		stderr(`refusing to remove the main checkout ${target}`);
		return 1;
	}
	if (!rows.some((row) => canonicalPath(row.path) === target)) {
		stderr(`${target} is not a registered git worktree`);
		return 1;
	}
	const nodeModules = path.join(target, "node_modules");
	let entry = null;
	try {
		entry = fs.lstatSync(nodeModules);
	} catch {
		entry = null;
	}
	const kind = classifyNodeModules(entry);
	if (kind === "directory") {
		stderr(
			`refusing: ${nodeModules} is a real directory, not a symlink. Remove it only after confirming the main checkout's install is intact, then retry.`,
		);
		return 1;
	}
	if (kind === "symlink") {
		try {
			fs.unlinkSync(nodeModules);
		} catch (error) {
			stderr(`failed to unlink symlinked node_modules: ${error.message}`);
			return 1;
		}
	}
	try {
		gitExec(["worktree", "remove", ...(force ? ["--force"] : []), target], {
			cwd: mainRoot ?? cwd,
		});
	} catch (error) {
		stderr(`failed to remove worktree ${target}: ${error.message}`);
		return 1;
	}
	stdout(target);
	return 0;
}

/** The real entry point: exit code only, so `run` stays process-free. */
export function main() {
	process.exitCode = run();
}

const ENTRY = process.argv[1]
	? pathToFileURL(process.argv[1]).href === import.meta.url
	: false;
if (ENTRY) main();
