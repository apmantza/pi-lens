#!/usr/bin/env node
/**
 * Fail if package-lock.json drifts from package.json's identity or declared
 * dependency specs. A committed lock that disagrees with package.json makes
 * `npm ci` delete node_modules then hard-fail.
 *
 * Deterministic on purpose. It compares dependency SPEC STRINGS, not resolved
 * transitive versions, so it never flags spurious upstream republishes. Fix
 * any failure with `npm install` (which rewrites the lock) and commit the
 * result.
 */
import * as fs from "node:fs";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";
import {
	findLibcDrift,
	formatLibcDriftFailure,
	formatPackageLockSyncFailure,
	validatePackageLockSync,
} from "./lib/package-lock-sync.mjs";
import {
	getPinnedNpmVersion,
	runLockfileCompleteness,
} from "./lib/lockfile-completeness.mjs";

const complete = process.argv.slice(2).includes("--complete");
const GIT_TIMEOUT_MS = 10_000;

function read(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch (err) {
		console.error(`Cannot read ${file}: ${err.message}`);
		process.exit(1);
	}
}

/**
 * The lockfile this checkout committed, or the reason it cannot be read.
 *
 * A lockfile change is compared against HEAD: the pre-commit hook sees the
 * rewrite in the working tree while HEAD still holds the lock the last commit
 * wrote (#5207). A tree with no HEAD lock (first commit, a consumer tarball,
 * no git) has nothing to compare and says so instead of guessing.
 */
function readCommittedLock() {
	let stdout;
	try {
		stdout = gitExecFileSync(["show", "HEAD:package-lock.json"], {
			cwd: process.cwd(),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: GIT_TIMEOUT_MS,
		});
	} catch (err) {
		const detail =
			String(err.stderr ?? "")
				.trim()
				.split("\n")[0] || err.message;
		return {
			skipped: `git show HEAD:package-lock.json failed: ${detail}`,
		};
	}
	try {
		return { lock: JSON.parse(stdout) };
	} catch (err) {
		return {
			skipped: `HEAD's package-lock.json is unreadable: ${err.message}`,
		};
	}
}

const pkg = read("package.json");
const lock = read("package-lock.json");
const problems = validatePackageLockSync(pkg, lock);

if (problems.length > 0) {
	console.error(formatPackageLockSyncFailure(problems));
	process.exit(1);
}

console.log("package-lock.json is in sync with package.json ✓");

const committed = readCommittedLock();
if (committed.lock === undefined) {
	console.log(`package-lock libc drift: not checked (${committed.skipped})`);
} else {
	const drifted = findLibcDrift(committed.lock, lock);
	if (drifted.length > 0) {
		console.error(formatLibcDriftFailure(drifted, getPinnedNpmVersion()));
		process.exit(1);
	}
	console.log(
		'package-lock.json keeps every "libc" field it recorded at HEAD ✓',
	);
}

if (complete) {
	const result = runLockfileCompleteness();
	if (!result.ok && !result.inconclusive) {
		console.error(`lockfile:complete: ${result.reason}`);
		if (result.output) console.error(result.output);
		process.exit(1);
	}
	if (result.inconclusive) {
		console.error(`lockfile:complete: inconclusive: ${result.reason}`);
		if (result.output) console.error(result.output);
		process.exit(3);
	}
	console.log(`lockfile:complete: stable under npm@${result.pin} ✓`);
}
