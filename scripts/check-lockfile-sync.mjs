#!/usr/bin/env node
/**
 * Fail if package-lock.json drifts from package.json's identity or declared
 * dependency specs. A committed lock that disagrees with package.json makes
 * `npm ci` delete node_modules then hard-fail.
 *
 * It also refuses a lock that dropped a package's `libc` field, which npm older
 * than package.json's pin writes nowhere (#5207). The drop is judged against
 * what the commit records: the index when git stages a lock, the working copy
 * when the index holds no change for it, and the merge base with origin/master
 * when the commit records HEAD's bytes unchanged (#5213).
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
	hasPackagesMap,
	validatePackageLockSync,
} from "./lib/package-lock-sync.mjs";
import {
	getPinnedNpmVersion,
	runLockfileCompleteness,
} from "./lib/lockfile-completeness.mjs";

const complete = process.argv.slice(2).includes("--complete");
const LOCKFILE = "package-lock.json";
const BASE_REF = "origin/master";
const GIT_TIMEOUT_MS = 10_000;
// Node caps a child's stdout at 1 MiB by default, and that default must not be
// the gate's byte bound: the lock is 314 KB today and grows with the tree. 8 MiB
// keeps ~25x headroom; a lock past it is a refusal (ENOBUFS), never a silent
// skip.
const GIT_MAX_STDOUT_BYTES = 8 * 1024 * 1024;

function read(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch (err) {
		console.error(`Cannot read ${file}: ${err.message}`);
		process.exit(1);
	}
	let value;
	try {
		value = JSON.parse(text);
	} catch (err) {
		console.error(`Cannot read ${file}: ${err.message}`);
		process.exit(1);
	}
	return { text, value };
}

/**
 * One git read through the fixture environment seam, or the reason it failed.
 * `maxBuffer` and the timeout bound the child; every failure is the caller's
 * to classify, and only the forms that mean "nothing committed to compare" may
 * be read as a skip (#5213 F2).
 */
function git(args, gitFixtureEnv) {
	try {
		return {
			text: String(
				gitExecFileSync(args, {
					cwd: process.cwd(),
					gitFixtureEnv,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					timeout: GIT_TIMEOUT_MS,
					maxBuffer: GIT_MAX_STDOUT_BYTES,
				}),
			),
		};
	} catch (error) {
		return { error };
	}
}

function gitFailureDetail(error) {
	const stderr = String(error?.stderr ?? "").trim();
	return stderr.split("\n")[0] || error?.message || String(error);
}

function ranWithoutError(status, stderr) {
	return status === 1 && stderr === "";
}

// `git rev-parse --verify --quiet` answers "no such ref" with exit 1 and no
// stderr, which is how an unborn HEAD and an absent origin/master read. The one
// stderr form that also means "nothing committed to compare" is a directory
// that is not a repository at all. Every other stderr — a checkout git refuses
// to read (`safe.directory`), a broken object store, a read that ran out of
// buffer or time — is a failure the gate must not turn into a pass.
const NOT_A_REPOSITORY = /fatal: not a git repository/;

function resolveRef(ref) {
	const result = git(["rev-parse", "--verify", "--quiet", ref]);
	if (!result.error) return { sha: result.text.trim() };
	const stderr = String(result.error.stderr ?? "").trim();
	if (
		ranWithoutError(result.error.status, stderr) ||
		NOT_A_REPOSITORY.test(stderr)
	)
		return { absent: true };
	return { failure: gitFailureDetail(result.error) };
}

/**
 * A file's bytes at a resolved ref. `ls-tree` answers an absent path with
 * empty output instead of an error, so absence needs no stderr classification
 * and any other failure stays a failure.
 */
function readRefFile(ref, file) {
	const listed = git(["ls-tree", "--name-only", ref, "--", file]);
	if (listed.error) return { failure: gitFailureDetail(listed.error) };
	if (listed.text.trim() === "") return { absent: true };
	const shown = git(["show", `${ref}:${file}`]);
	if (shown.error) return { failure: gitFailureDetail(shown.error) };
	return { text: shown.text };
}

/**
 * The blob the commit records. Git commits the index, so a staged lock is the
 * one the commit will hold: `ls-files --stage` prints nothing for an untracked
 * path and one `mode sha stage\tpath` line otherwise, and `cat-file -p` reads
 * exactly that object (#5213 F1).
 */
function readStagedFile(file) {
	const listed = git(["ls-files", "--stage", "--", file], {
		keep: ["GIT_INDEX_FILE"],
	});
	if (listed.error) return { failure: gitFailureDetail(listed.error) };
	const entry = listed.text.trim();
	if (entry === "") return { absent: true };
	const sha = entry.split(/\s+/)[1];
	if (!sha)
		return {
			failure: `ls-files --stage printed an unexpected entry: ${entry}`,
		};
	const blob = git(["cat-file", "-p", sha]);
	if (blob.error) return { failure: gitFailureDetail(blob.error) };
	return { text: blob.text };
}

/**
 * A lock this gate can compare, or the record for one it cannot. A shape the
 * gate does not recognize (a `null` root, a v1 lock with no `packages` map)
 * takes the same record as invalid JSON: an unrecognized lock is not a clean
 * one (#5213 F4).
 */
function parseLock(text, label) {
	let value;
	try {
		value = JSON.parse(text);
	} catch (err) {
		return { unreadable: `${label} is unreadable: ${err.message}` };
	}
	if (!hasPackagesMap(value))
		return { unreadable: `${label} is unreadable: no packages map` };
	return { lock: value };
}

function shortSha(sha) {
	return sha.slice(0, 7);
}

function judgeLibc(beforeLock, afterLock, judged, recordedBy, compared, note) {
	const drifted = findLibcDrift(beforeLock, afterLock);
	if (drifted.length > 0) return { drifted, compared, note };
	return {
		clean: `${judged} keeps every "libc" field ${recordedBy} recorded ✓`,
		note,
	};
}

/**
 * The base a clean tree is judged against: the merge base with origin/master,
 * when both refs resolve and the merge base is not HEAD itself. A shallow PR
 * checkout has no origin/master, and then the record says so instead of
 * claiming a comparison it did not make (#5213 F3).
 */
function committedBase(headSha) {
	const remote = resolveRef(BASE_REF);
	if (remote.failure)
		return {
			unverifiable: `git could not resolve ${BASE_REF}: ${remote.failure}`,
		};
	if (remote.absent)
		return {
			skipped: `clean tree: ${LOCKFILE} matches HEAD and ${BASE_REF} does not resolve, so there is no base to compare`,
		};

	const merged = git(["merge-base", BASE_REF, "HEAD"]);
	if (merged.error) {
		const stderr = String(merged.error.stderr ?? "").trim();
		if (ranWithoutError(merged.error.status, stderr))
			return {
				skipped: `clean tree: ${LOCKFILE} matches HEAD and ${BASE_REF} shares no history with it, so there is no base to compare`,
			};
		return {
			unverifiable: `git could not find the merge base with ${BASE_REF}: ${gitFailureDetail(merged.error)}`,
		};
	}
	const sha = merged.text.trim();
	if (sha === headSha)
		return {
			skipped: `clean tree: ${LOCKFILE} matches HEAD and HEAD (${shortSha(sha)}) is the merge base with ${BASE_REF}, so no lockfile change is in play`,
		};

	const file = readRefFile(sha, LOCKFILE);
	if (file.failure)
		return {
			unverifiable: `git could not read the merge base with ${BASE_REF} (${shortSha(sha)}): ${file.failure}`,
		};
	if (file.absent)
		return {
			skipped: `clean tree: the merge base with ${BASE_REF} (${shortSha(sha)}) holds no ${LOCKFILE}`,
		};
	const lock = parseLock(file.text, `the merge base's ${LOCKFILE}`);
	if (lock.unreadable) return { skipped: lock.unreadable };
	return {
		lock: lock.lock,
		recordedBy: `the merge base with ${BASE_REF} (${shortSha(sha)})`,
	};
}

/**
 * Judge the libc fields of the lock this commit records. The verdict names the
 * two sides it compared, so no run reports a comparison it did not make.
 */
function libcDriftOutcome(workingText, workingLock) {
	const headRef = resolveRef("HEAD");
	if (headRef.failure)
		return { unverifiable: `git could not read HEAD: ${headRef.failure}` };
	if (headRef.absent)
		return {
			skipped:
				"HEAD records no commit, so there is no committed lock to compare",
		};

	const headFile = readRefFile("HEAD", LOCKFILE);
	if (headFile.failure)
		return { unverifiable: `git could not read HEAD: ${headFile.failure}` };
	if (headFile.absent) return { skipped: `HEAD holds no ${LOCKFILE}` };
	const headLock = parseLock(headFile.text, `HEAD's ${LOCKFILE}`);
	if (headLock.unreadable) return { skipped: headLock.unreadable };

	const staged = readStagedFile(LOCKFILE);
	if (staged.failure)
		return {
			unverifiable: `git could not read the staged ${LOCKFILE}: ${staged.failure}`,
		};
	const note =
		staged.text !== undefined && staged.text !== workingText
			? `package-lock libc drift: the working ${LOCKFILE} differs from the staged copy this commit records; the check reads the staged copy.`
			: undefined;

	if (staged.text !== undefined && staged.text !== headFile.text) {
		const stagedLock = parseLock(staged.text, `the staged ${LOCKFILE}`);
		if (stagedLock.unreadable)
			return { unverifiable: stagedLock.unreadable, note };
		return judgeLibc(
			headLock.lock,
			stagedLock.lock,
			`the staged ${LOCKFILE}`,
			"HEAD",
			`HEAD → the staged ${LOCKFILE}`,
			note,
		);
	}

	if (workingText !== headFile.text)
		return judgeLibc(
			headLock.lock,
			workingLock,
			LOCKFILE,
			"HEAD",
			`HEAD → ${LOCKFILE}`,
		);

	const base = committedBase(headRef.sha);
	if (base.unverifiable) return { unverifiable: base.unverifiable };
	if (base.skipped) return { skipped: base.skipped };
	return judgeLibc(
		base.lock,
		headLock.lock,
		LOCKFILE,
		base.recordedBy,
		`${base.recordedBy} → HEAD`,
	);
}

/** `package.json`'s npm pin, or why the refusal cannot name it (#5213 F5). */
function pinnedNpm() {
	try {
		return { npm: getPinnedNpmVersion() };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

const pkg = read("package.json");
const lock = read(LOCKFILE);
const problems = validatePackageLockSync(pkg.value, lock.value);

if (problems.length > 0) {
	console.error(formatPackageLockSyncFailure(problems));
	process.exit(1);
}

console.log("package-lock.json is in sync with package.json ✓");

const outcome = libcDriftOutcome(lock.text, lock.value);
if (outcome.unverifiable) {
	if (outcome.note) console.log(outcome.note);
	console.error(
		`package-lock libc drift: unverifiable (${outcome.unverifiable})`,
	);
	process.exit(complete ? 3 : 1);
}
if (outcome.skipped) {
	console.log(`package-lock libc drift: not checked (${outcome.skipped})`);
} else if (outcome.drifted) {
	if (outcome.note) console.log(outcome.note);
	console.error(
		formatLibcDriftFailure(outcome.drifted, pinnedNpm(), outcome.compared),
	);
	process.exit(1);
} else {
	console.log(outcome.clean);
}
if (outcome.note) console.log(outcome.note);

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
