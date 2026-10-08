#!/usr/bin/env node
/**
 * scripts/pr-worktree.mjs (#3723)
 *
 * One command for the review / trailing-commit worktree sequence the
 * orchestrator and its reviewers repeat many times a day:
 *
 *   node scripts/pr-worktree.mjs open <PR|branch> [--merge|--head] [--name NAME]
 *   node scripts/pr-worktree.mjs close <path>
 *
 * `open` resolves a PR head via `gh pr view --json headRefName` (only when
 * the default name needs it), fetches `pull/<n>/head`
 * (or `pull/<n>/merge` under `--merge`) from `origin`, creates a worktree
 * under `~/Desktop/pi-lens-worktrees/<name>`, and symlinks the main
 * checkout's `node_modules`. It prints the absolute path. Before the fetch it
 * refuses (exit 2, nothing created) a destination that is the main checkout or
 * inside a registered non-bare checkout, symlinks resolved: a HOME pinned
 * under the source checkout would otherwise nest a second tree in it (#3981).
 * An exact hit on another registered tree is left to git.
 * `PI_LENS_WORKTREES_ROOT` is the way out.
 *
 * `close` first checks every rail (registered worktree, not the main
 * checkout, inside the worktrees root, clean tree), all before touching
 * anything. Then it lstat's the worktree's `node_modules`: a symlink is
 * unlinked, a real directory is a refusal (never `rm -rf`, the #2704 class),
 * and only then does `git worktree remove` run; finally the local branch
 * `open` created is deleted -- unless it holds commits no remote has, in
 * which case it is kept and a hint is printed. A branch the caller already
 * owned is left in place.
 *
 * The close decision is a pure function of a table in
 * scripts/lib/pr-worktree.mjs; this file owns only the I/O. `run()` is
 * exported with injectable `gitExec`/`ghExec`/sinks so the process boundary
 * is observable; `main()` is the real entry point. `PI_LENS_GH_JSON` injects
 * the `gh` lookup's JSON for tests and CI, and `PI_LENS_WORKTREES_ROOT`
 * overrides the destination and close-rail root -- both unset in normal use.
 *
 * The Bash guard (scripts/hooks/guard-bash.mjs) denies a hand-typed `git
 * worktree remove` on a tree whose `node_modules` is an outside symlink; this
 * tool is the sanctioned form of that sequence and is listed in the hook
 * suite's allow corpus (tests/scripts/guard-bash-hook.test.ts).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	classifyNodeModules,
	deriveClosePlan,
	deriveOpenPlan,
	nestedDestinationError,
	worktreeBranchName,
} from "./lib/pr-worktree.mjs";
import { parseWorktreeList } from "./lib/worktree-hygiene.mjs";

const USAGE = [
	"usage:",
	"  node scripts/pr-worktree.mjs open <PR|branch> [--merge|--head] [--name NAME]",
	"  node scripts/pr-worktree.mjs close <path>",
].join("\n");

/** @param {string[]} args @param {{cwd?: string}} [options] */
function defaultGitExec(args, options = {}) {
	return execFileSync("git", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...options,
	});
}

/** @param {string[]} args @param {{cwd?: string}} [options] */
function defaultGhExec(args, options = {}) {
	return execFileSync("gh", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...options,
	});
}

/**
 * Destination root for opened worktrees. `PI_LENS_WORKTREES_ROOT` is the
 * CI/test override; the default is the maintainer's review root.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveWorktreesRoot(env = process.env) {
	const override = env.PI_LENS_WORKTREES_ROOT?.trim();
	if (override) return override;
	return path.join(os.homedir(), "Desktop", "pi-lens-worktrees");
}

/**
 * git config suffix under `branch.<name>.` recording the commit `open` created
 * the branch at, so `close` can tell "the PR head, never touched" from "commits
 * made here that no remote has" (a PR head lives only under `refs/pull`).
 */
const OPEN_BASE_KEY = "pilensbase";

/** @param {string} p @returns {string} */
function canonicalPath(p) {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

/**
 * Realpath of the nearest existing ancestor with the missing tail re-joined:
 * `open` judges a destination it has not created yet, which `canonicalPath`
 * would only `path.resolve`, leaving a symlinked HOME or root unresolved.
 *
 * @param {string} p absolute path
 * @returns {string}
 */
function canonicalDestination(p) {
	const missing = [];
	let existing = p;
	for (;;) {
		try {
			return path.join(fs.realpathSync(existing), ...missing);
		} catch {
			const parent = path.dirname(existing);
			if (parent === existing) return p;
			missing.unshift(path.basename(existing));
			existing = parent;
		}
	}
}

/**
 * @param {string[]} argv
 * @returns {{ command: string|null, target: string|null, mode: string|null,
 *   name: string|null, help: boolean, errors: string[] }}
 */
export function parseArgs(argv) {
	const [command = null, ...rest] = argv;
	const options = {
		command,
		target: null,
		mode: null,
		name: null,
		help: false,
		errors: [],
	};
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (arg === "--merge" || arg === "--head") {
			options.mode = arg.slice(2);
			continue;
		}
		if (arg === "--name") {
			options.name = rest[++index] ?? null;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}
		if (arg.startsWith("-")) {
			options.errors.push(`unknown option ${arg}`);
			continue;
		}
		if (options.target === null) {
			options.target = arg;
			continue;
		}
		options.errors.push(`unexpected argument ${arg}`);
	}
	return options;
}

/**
 * @param {string} prNumber
 * @param {NodeJS.ProcessEnv} env
 * @param {(args: string[], options?: {cwd?: string}) => string} ghExec
 * @param {string} cwd
 * @returns {{ headRefName?: string|null }}
 */
function resolvePrHead(prNumber, env, ghExec, cwd) {
	const injected = env.PI_LENS_GH_JSON?.trim();
	const raw =
		injected ??
		ghExec(["pr", "view", prNumber, "--json", "headRefName"], { cwd });
	try {
		return JSON.parse(raw);
	} catch {
		throw new Error(`gh pr view ${prNumber} returned unparseable JSON`);
	}
}

/**
 * One stderr line naming the main checkout's shared install, so an emptied one
 * is visible at the next `open` instead of at the next worker complaint
 * (#4044: a lane's `npm ci` emptied it on 2026-10-07 and nothing reported it
 * for a minute). npm's hidden lockfile survives an `npm ci` wipe, so it does
 * not count as an entry. stderr, because stdout is the path callers capture.
 *
 * @param {string} mainRoot
 * @param {(message: string) => void} stderr
 */
function reportMainInstall(mainRoot, stderr) {
	let entries = null;
	try {
		entries = fs
			.readdirSync(path.join(mainRoot, "node_modules"))
			.filter((name) => name !== ".package-lock.json").length;
	} catch {
		entries = null;
	}
	if (entries === null) stderr(`main node_modules: absent (${mainRoot})`);
	else if (entries === 0)
		stderr(
			`WARNING: main node_modules is EMPTY (${mainRoot}): every lane linking it is broken; reinstall in the main checkout (#4044)`,
		);
	else stderr(`main node_modules: ${entries} entries`);
}

/**
 * @param {{ target: string, mode: string|null, name: string|null }} options
 * @param {object} io
 * @returns {number}
 */
function executeOpen(options, io) {
	const { gitExec, ghExec, env, cwd, stdout, stderr, worktreesRoot } = io;
	const numeric = /^\d+$/.test(options.target);
	let prHead = null;
	// The head branch only names the default worktree; --merge and --name
	// make it unused, so they must not pay a `gh` round trip.
	if (numeric && !options.name && options.mode !== "merge") {
		try {
			prHead = resolvePrHead(options.target, env, ghExec, cwd);
		} catch (error) {
			stderr(`failed to resolve PR ${options.target}: ${error.message}`);
			return 1;
		}
	}
	const plan = deriveOpenPlan({
		target: options.target,
		mode: options.mode,
		name: options.name,
		worktreesRoot,
		prHead,
	});
	if (!plan.ok) {
		stderr(plan.error);
		return 2;
	}
	// Judged before the fetch, the mkdir and the add so a refusal leaves nothing
	// behind. Relative to `cwd`, the directory `git worktree add` resolves from.
	let rows;
	try {
		rows = parseWorktreeList(
			gitExec(["worktree", "list", "--porcelain"], { cwd }),
		);
	} catch (error) {
		stderr(`failed to list worktrees: ${error.message}`);
		return 1;
	}
	const checkouts = rows
		.filter((row) => !row.bare)
		.map((row) => canonicalPath(row.path));
	const refusal = nestedDestinationError({
		destination: canonicalDestination(path.resolve(cwd, plan.path)),
		checkouts,
		mainCheckout: rows[0] && !rows[0].bare ? canonicalPath(rows[0].path) : null,
	});
	if (refusal) {
		stderr(refusal);
		return 2;
	}
	try {
		if (plan.fetchRefspec) {
			gitExec(["fetch", "origin", plan.fetchRefspec], { cwd });
		}
		// Resolved from `cwd` like the guard and `git worktree add`, not from the
		// process cwd, so a relative root run from a subdirectory leaves no stray
		// directory inside the source.
		fs.mkdirSync(path.resolve(cwd, worktreesRoot), { recursive: true });
		const addArgs = ["worktree", "add"];
		if (plan.branch) addArgs.push("-b", plan.branch);
		addArgs.push(plan.path, plan.commitish);
		gitExec(addArgs, { cwd });
		if (plan.branch) {
			const base = gitExec(["rev-parse", plan.branch], { cwd }).trim();
			gitExec(["config", `branch.${plan.branch}.${OPEN_BASE_KEY}`, base], {
				cwd,
			});
		}
	} catch (error) {
		stderr(`failed to create worktree ${plan.path}: ${error.message}`);
		return 1;
	}
	const mainRoot = rows[0]?.path;
	if (mainRoot) {
		const source = path.join(mainRoot, "node_modules");
		const link = path.join(plan.path, "node_modules");
		let linkExists = false;
		try {
			fs.lstatSync(link);
			linkExists = true;
		} catch {
			linkExists = false;
		}
		if (!linkExists && fs.existsSync(source)) {
			try {
				fs.symlinkSync(source, link);
			} catch (error) {
				stderr(`warning: could not symlink node_modules: ${error.message}`);
			}
		}
		reportMainInstall(mainRoot, stderr);
	}
	stdout(plan.path);
	return 0;
}

/**
 * The commit `open` recorded for `branch`, or null (none recorded, or not a
 * commit id): with no base every commit counts, which keeps the branch.
 *
 * @param {(args: string[], options?: {cwd?: string}) => string} gitExec
 * @param {string} cwd
 * @param {string} branch
 * @returns {string|null}
 */
function openBase(gitExec, cwd, branch) {
	try {
		const base = gitExec(
			["config", "--get", `branch.${branch}.${OPEN_BASE_KEY}`],
			{ cwd },
		).trim();
		return /^[0-9a-f]{40,64}$/.test(base) ? base : null;
	} catch {
		return null;
	}
}

/**
 * Commits on `branch` that no remote has, excluding the commit `open` created
 * it at. Any failure counts as unpushed: the dangerous direction is deleting
 * a branch whose commits nothing else holds.
 *
 * @param {(args: string[], options?: {cwd?: string}) => string} gitExec
 * @param {string} cwd
 * @param {string} branch
 * @returns {boolean}
 */
function hasUnpushedCommits(gitExec, cwd, branch) {
	try {
		const args = ["rev-list", "--count", branch, "--not", "--remotes"];
		const base = openBase(gitExec, cwd, branch);
		if (base) args.push(base);
		return gitExec(args, { cwd }).trim() !== "0";
	} catch {
		return true;
	}
}

/**
 * Unpushed commits on the tree's own HEAD when it is DETACHED (a named HEAD is
 * covered by the branch check). `failed` is true when git could not say, which
 * the planner treats as a refusal: a detached commit has no ref to keep it.
 *
 * @param {(args: string[], options?: {cwd?: string}) => string} gitExec
 * @param {string} worktreePath
 * @param {string} branch
 * @returns {{ commits: string[], failed: boolean }}
 */
function detachedHeadCommits(gitExec, worktreePath, branch) {
	try {
		gitExec(["symbolic-ref", "-q", "HEAD"], { cwd: worktreePath });
		return { commits: [], failed: false };
	} catch {
		// Exit 1 is a detached HEAD (any other failure also falls through to
		// the rev-list below, which then fails closed).
	}
	try {
		const args = ["rev-list", "--oneline", "HEAD", "--not", "--remotes"];
		const base = openBase(gitExec, worktreePath, branch);
		if (base) args.push(base);
		const out = gitExec(args, { cwd: worktreePath }).trim();
		return { commits: out === "" ? [] : out.split(/\r?\n/), failed: false };
	} catch {
		return { commits: [], failed: true };
	}
}

/**
 * @param {{ target: string }} options
 * @param {object} io
 * @returns {number}
 */
function executeClose(options, io) {
	const { gitExec, cwd, callerCwd, stdout, stderr, worktreesRoot } = io;
	let rows;
	try {
		rows = parseWorktreeList(
			gitExec(["worktree", "list", "--porcelain"], { cwd }),
		);
	} catch (error) {
		stderr(`failed to list worktrees: ${error.message}`);
		return 1;
	}
	// Every fact below is read-only; nothing is unlinked until the plan, which
	// holds every refusal, has accepted them all.
	const worktreePath = canonicalPath(path.resolve(callerCwd, options.target));
	const registered = rows.some(
		(row) => canonicalPath(row.path) === worktreePath,
	);
	let dirty = false;
	if (registered) {
		try {
			dirty =
				gitExec(["status", "--porcelain"], { cwd: worktreePath }).trim() !== "";
		} catch (error) {
			stderr(`failed to read status of ${worktreePath}: ${error.message}`);
			return 1;
		}
	}
	const branch = worktreeBranchName(worktreePath);
	const detached = registered
		? detachedHeadCommits(gitExec, worktreePath, branch)
		: { commits: [], failed: false };
	let entry = null;
	try {
		entry = fs.lstatSync(path.join(worktreePath, "node_modules"));
	} catch {
		entry = null;
	}
	let branchExists = false;
	try {
		gitExec(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
			cwd,
		});
		branchExists = true;
	} catch {
		branchExists = false;
	}
	const plan = deriveClosePlan({
		worktreePath,
		worktreesRoot: canonicalPath(worktreesRoot),
		mainRoot: rows[0] ? canonicalPath(rows[0].path) : null,
		registered,
		dirty,
		detachedCommits: detached.commits,
		detachedCheckFailed: detached.failed,
		nodeModulesKind: classifyNodeModules(entry),
		branchExists,
		branchUnpushed: branchExists && hasUnpushedCommits(gitExec, cwd, branch),
	});
	if (!plan.ok) {
		stderr(plan.error);
		return plan.code;
	}
	if (plan.unlinkNodeModules) {
		try {
			fs.unlinkSync(path.join(worktreePath, "node_modules"));
		} catch (error) {
			stderr(`failed to unlink symlinked node_modules: ${error.message}`);
			return 1;
		}
	}
	try {
		gitExec(["worktree", "remove", worktreePath], { cwd });
	} catch (error) {
		stderr(`failed to remove worktree ${worktreePath}: ${error.message}`);
		return 1;
	}
	if (plan.branchToDelete) {
		try {
			gitExec(["branch", "-D", plan.branchToDelete], { cwd });
		} catch (error) {
			stderr(
				`warning: could not delete ${plan.branchToDelete}: ${error.message}`,
			);
		}
	}
	if (plan.branchKept) stderr(plan.branchKept);
	stdout(worktreePath);
	return 0;
}

/**
 * The whole CLI, resolving an exit code instead of touching `process` so a
 * test can drive it through the real entry function with injected command
 * boundaries.
 *
 * @param {{ argv?: string[], cwd?: string, env?: NodeJS.ProcessEnv,
 *   gitExec?: (args: string[], options?: {cwd?: string}) => string,
 *   ghExec?: (args: string[], options?: {cwd?: string}) => string,
 *   stdout?: (message: string) => void, stderr?: (message: string) => void }} [options]
 * @returns {number}
 */
export function run({
	argv = process.argv.slice(2),
	cwd = process.cwd(),
	env = process.env,
	gitExec = defaultGitExec,
	ghExec = defaultGhExec,
	stdout = console.log,
	stderr = console.error,
} = {}) {
	const options = parseArgs(argv);
	if (options.help) {
		stdout(USAGE);
		return 0;
	}
	if (!options.command || options.errors.length > 0) {
		for (const message of options.errors) stderr(message);
		stderr(USAGE);
		return 2;
	}
	if (options.command !== "open" && options.command !== "close") {
		stderr(`unknown command ${options.command}`);
		stderr(USAGE);
		return 2;
	}
	if (!options.target) {
		stderr(USAGE);
		return 2;
	}
	let repoRoot;
	try {
		repoRoot = gitExec(["rev-parse", "--show-toplevel"], { cwd }).trim();
	} catch (error) {
		stderr(`not a git repository: ${error.message}`);
		return 2;
	}
	const io = {
		gitExec,
		ghExec,
		env,
		cwd: repoRoot,
		callerCwd: cwd,
		stdout,
		stderr,
		worktreesRoot: resolveWorktreesRoot(env),
	};
	return options.command === "open"
		? executeOpen(options, io)
		: executeClose(options, io);
}

/** The real entry point: exit code only, so `run` stays process-free. */
export function main() {
	process.exitCode = run();
}

const ENTRY = process.argv[1]
	? pathToFileURL(process.argv[1]).href === import.meta.url
	: false;
if (ENTRY) main();
