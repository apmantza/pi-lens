import { spawn } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";
import {
	claimScratchDir,
	ownerAlive,
	SCRATCH_DIR_ROOT,
	sweepScratchDirs,
} from "./lib/scratch-dir.mjs";
import { acquireSharedSlot } from "./lib/suite-lock.mjs";

// Verdicts are PER TEST (file + full name from vitest's JSON report), never per
// file: a red test that also fails on base must not hide a sibling test in the
// same file that the change broke (#3724 review r1, F3). Only RED-ON-BASE for
// every failing test justifies calling a red "unrelated".
export const EXIT = {
	OK: 0, // RED-ON-BASE for every failing test, or ALL-GREEN
	CAUSED: 1,
	USAGE: 2,
	INCONCLUSIVE: 3,
	BUILD: 4,
};

export const HEAD_GREEN_MESSAGE =
	"HEAD green when run alone; the red may be concurrency OR a flaky change. Not evidence of unrelated.";
const LOAD_FAILURE_MESSAGE =
	"The suite failed to load on both HEAD and base with different errors. Not evidence of unrelated.";

const RUN_PREFIX = "pi-lens-red-on-base-";
const USAGE =
	"usage: node scripts/red-on-base.mjs <test files…> [--base ref] [--repeat N]";

class UsageError extends Error {}
class Interrupted extends Error {}

/**
 * Classify each HEAD-failing test against the base run.
 * `head` is one `{ failed: string[] }` per HEAD run; `base` is `{ failed }`.
 */
export function decideVerdict({ head, base }) {
	const runs = head.length;
	const redCounts = new Map();
	for (const run of head)
		for (const id of new Set(run.failed))
			redCounts.set(id, (redCounts.get(id) ?? 0) + 1);
	const baseFailed = new Set(base.failed);
	// A suite-load failure has one id per file whatever the cause, so "red on
	// both sides" only means "same cause" when the load error text matches.
	const headLoadErrors = new Map();
	for (const run of head)
		for (const [id, message] of Object.entries(run.loadErrors ?? {}))
			headLoadErrors.set(id, [...(headLoadErrors.get(id) ?? []), message]);
	const tests = [...redCounts].map(([id, count]) => {
		if (count < runs)
			return {
				id,
				verdict: "INCONCLUSIVE",
				detail: `red in ${count}/${runs} HEAD runs`,
			};
		if (
			baseFailed.has(id) &&
			(headLoadErrors.get(id) ?? []).some(
				(message) => message !== base.loadErrors?.[id],
			)
		)
			return {
				id,
				verdict: "INCONCLUSIVE",
				detail: "suite failed to load on both sides with different errors",
			};
		return {
			id,
			verdict: baseFailed.has(id) ? "RED-ON-BASE" : "CAUSED-BY-CHANGE",
		};
	});
	const has = (verdict) => tests.some((test) => test.verdict === verdict);
	let verdict;
	if (has("CAUSED-BY-CHANGE")) verdict = "CAUSED-BY-CHANGE";
	else if (has("INCONCLUSIVE")) verdict = "INCONCLUSIVE";
	else if (tests.length) verdict = "RED-ON-BASE";
	else verdict = base.failed.length ? "INCONCLUSIVE" : "ALL-GREEN";
	return { verdict, tests };
}

/** Ids (`file > full name`) of every failed test in a vitest JSON report. */
export function failedTestIds(report, cwd) {
	const ids = [];
	for (const file of report.testResults ?? []) {
		const rel = relative(cwd, file.name).split(sep).join("/");
		const failed = (file.assertionResults ?? []).filter(
			(assertion) => assertion.status === "failed",
		);
		for (const assertion of failed) ids.push(`${rel} > ${assertion.fullName}`);
		// A suite that failed to load has no assertions; it is still one red.
		if (file.status === "failed" && !failed.length)
			ids.push(`${rel} > (suite failed to run)`);
	}
	return [...new Set(ids)];
}

/** Load-error text per suite-load failure id, tree root replaced so the HEAD
 *  and base worktree paths compare equal. */
export function suiteLoadErrors(report, cwd) {
	const errors = {};
	for (const file of report.testResults ?? []) {
		const failedTests = (file.assertionResults ?? []).some(
			(assertion) => assertion.status === "failed",
		);
		if (file.status !== "failed" || failedTests) continue;
		const rel = relative(cwd, file.name).split(sep).join("/");
		errors[`${rel} > (suite failed to run)`] = (file.message ?? "")
			.split(cwd)
			.join("<root>");
	}
	return errors;
}

function parseArgs(argv) {
	const files = [];
	let base = "origin/master";
	let repeat = 1;
	let testCommand;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--base") base = argv[++index];
		else if (arg === "--repeat") repeat = Number(argv[++index]);
		else if (arg === "--test-command") testCommand = argv[++index];
		else if (arg.startsWith("--")) throw new UsageError(`unknown flag ${arg}`);
		else files.push(arg);
	}
	if (!files.length) throw new UsageError("no test files given");
	if (!Number.isInteger(repeat) || repeat < 1)
		throw new UsageError("--repeat must be a positive integer");
	return { files, base, repeat, testCommand };
}

function git(args, cwd) {
	return gitExecFileSync(args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function tail(text) {
	return text.slice(-1500).trim();
}

/** Unlink the shared-install symlink BEFORE git sees the worktree: a forced
 *  remove that follows it can delete the shared install (#3173). */
function removeWorktree(cwd, worktree) {
	const nodeModules = join(worktree, "node_modules");
	try {
		if (lstatSync(nodeModules).isSymbolicLink()) unlinkSync(nodeModules);
	} catch {
		// no link (never created, or already gone)
	}
	try {
		git(["worktree", "remove", "--force", worktree], cwd);
	} catch (error) {
		console.error(`red-on-base: worktree remove failed: ${error.message}`);
	}
	rmSync(worktree, { recursive: true, force: true });
}

/** A SIGKILLed run leaves a registered worktree behind; reap the ones whose
 *  owner is dead, with the same unlink-first order as a normal exit. */
function reapStaleRuns(cwd) {
	let entries;
	try {
		entries = readdirSync(SCRATCH_DIR_ROOT);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.startsWith(RUN_PREFIX)) continue;
		const dir = join(SCRATCH_DIR_ROOT, entry);
		if (ownerAlive(dir) === false) removeWorktree(cwd, join(dir, "base"));
	}
	sweepScratchDirs(SCRATCH_DIR_ROOT, RUN_PREFIX);
	try {
		git(["worktree", "prune"], cwd);
	} catch {
		// prune is housekeeping; the run itself does not depend on it
	}
}

function readReport(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

export async function main(argv = process.argv.slice(2)) {
	const cwd = process.cwd();
	let args;
	let baseSha;
	let headSha;
	try {
		args = parseArgs(argv);
		for (const file of args.files)
			if (!existsSync(resolve(cwd, file)))
				throw new UsageError(`${file} does not exist in this tree`);
		try {
			baseSha = git(["rev-parse", "--verify", args.base], cwd).trim();
		} catch {
			throw new UsageError(`--base ${args.base} is not a commit`);
		}
		headSha = git(["rev-parse", "HEAD"], cwd).trim();
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		console.error(`red-on-base: ${error.message}\n${USAGE}`);
		return EXIT.USAGE;
	}
	const { files, base, repeat, testCommand } = args;

	reapStaleRuns(cwd);
	const runRoot = realpathSync(claimScratchDir(SCRATCH_DIR_ROOT, RUN_PREFIX));
	const worktree = join(runRoot, "base");
	const tmp = join(runRoot, "tmp");
	const homes = {
		head: join(runRoot, "head-home"),
		base: join(runRoot, "base-home"),
	};
	for (const dir of [tmp, ...Object.values(homes)]) mkdirSync(dir);
	const envFor = (side) => ({
		...process.env,
		TMPDIR: tmp,
		PI_LENS_HOME: homes[side],
		PI_LENS_TEST_MAX_WORKERS: "6",
	});

	const live = new Set();
	let interrupted = 0;
	let added = false;
	const throwIfInterrupted = () => {
		if (interrupted) throw new Interrupted();
	};
	const signalGroup = (child, signal) => {
		try {
			// detached children lead their own group, so a build's or a
			// runner's grandchildren die with them
			if (process.platform === "win32") child.kill(signal);
			else process.kill(-child.pid, signal);
		} catch {
			// already gone
		}
	};
	const onSignal = (signal) => {
		if (interrupted) return;
		interrupted = osConstants.signals[signal];
		for (const entry of live) {
			signalGroup(entry.child, "SIGTERM");
			setTimeout(() => signalGroup(entry.child, "SIGKILL"), 3000).unref();
		}
	};
	const onSigint = () => onSignal("SIGINT");
	const onSigterm = () => onSignal("SIGTERM");
	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);

	async function run(command, commandArgs, options) {
		const child = spawn(command, commandArgs, {
			...options,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		let output = "";
		for (const stream of [child.stdout, child.stderr]) {
			stream.setEncoding("utf8");
			stream.on("data", (chunk) => {
				output = (output + chunk).slice(-4000);
			});
		}
		const entry = { child };
		live.add(entry);
		const result = await new Promise((settle) => {
			child.once("close", (status, signal) => settle({ status, signal }));
			child.once("error", (error) => {
				output += String(error);
				settle({ status: null, signal: null });
			});
		});
		live.delete(entry);
		throwIfInterrupted();
		return { ...result, output };
	}

	const build = (cwdOfTree, side) =>
		run("npm", ["run", "build"], { cwd: cwdOfTree, env: envFor(side) });

	let reportCount = 0;
	async function runTests(cwdOfTree, side, testFiles) {
		reportCount += 1;
		const outputFile = join(runRoot, `report-${reportCount}.json`);
		const vitestArgs = [
			"run",
			"--reporter=json",
			`--outputFile=${outputFile}`,
			...testFiles,
		];
		const options = { cwd: cwdOfTree, env: envFor(side) };
		const result = testCommand?.endsWith(".mjs")
			? await run(process.execPath, [testCommand, ...vitestArgs], options)
			: await run(
					testCommand ?? resolve(cwdOfTree, "node_modules/.bin/vitest"),
					vitestArgs,
					options,
				);
		const report = readReport(outputFile);
		const failed = report ? failedTestIds(report, cwdOfTree) : [];
		const loadErrors = report ? suiteLoadErrors(report, cwdOfTree) : {};
		// A red with no failing test to name (no report, a signal, an unhandled
		// error) cannot be attributed to either side.
		const broken = !report || (result.status !== 0 && !failed.length);
		return {
			failed,
			loadErrors,
			broken,
			status: result.status,
			output: result.output,
		};
	}

	// #3853: the whole red-on-base run (every comparison and repeat run, plus
	// the two builds) takes ONE shared test-suite slot. Several agents may run
	// targeted suites concurrently, but none may overlap a full-suite run. The
	// slot is acquired once here, not per spawn, so there is no recursive
	// acquisition; `PI_LENS_TEST_NO_LOCK=1` (the same bypass with-test-lock
	// honors) skips it when the caller already holds one.
	let lock = null;
	try {
		if (process.env.PI_LENS_TEST_NO_LOCK !== "1") {
			lock = await acquireSharedSlot({
				log: (message) => console.error(`red-on-base: ${message}`),
			});
		}
		console.log(`HEAD ${headSha}`);
		console.log(`BASE ${base} ${baseSha}`);

		const headBuild = await build(cwd, "head");
		if (headBuild.status !== 0) {
			console.error(
				`red-on-base: HEAD build failed (status ${headBuild.status}); fix the build first.\n${tail(headBuild.output)}`,
			);
			return EXIT.BUILD;
		}
		git(["worktree", "add", "--detach", worktree, baseSha], cwd);
		added = true;
		symlinkSync(
			resolve(cwd, "node_modules"),
			join(worktree, "node_modules"),
			"dir",
		);
		const baseBuild = await build(worktree, "base");
		if (baseBuild.status !== 0) {
			console.error(
				`red-on-base: base build failed (status ${baseBuild.status}) at ${baseSha}.\n${tail(baseBuild.output)}`,
			);
			return EXIT.BUILD;
		}

		const headRuns = [];
		for (let attempt = 0; attempt < repeat; attempt += 1)
			headRuns.push(await runTests(cwd, "head", files));
		// A file the change adds does not exist on base: that is "no such test",
		// not a red (vitest would exit 1 on it).
		const baseFiles = files.filter((file) => existsSync(join(worktree, file)));
		const baseRun = baseFiles.length
			? await runTests(worktree, "base", baseFiles)
			: { failed: [], broken: false };

		const broken = [
			...headRuns.map((headRun, index) => [`HEAD run ${index + 1}`, headRun]),
			["base run", baseRun],
		].filter(([, result]) => result.broken);
		if (broken.length) {
			for (const [name, result] of broken)
				console.log(
					`${name}: no per-test report (status ${result.status}); cannot attribute.\n${tail(result.output)}`,
				);
			console.log("VERDICT: INCONCLUSIVE");
			return EXIT.INCONCLUSIVE;
		}

		const result = decideVerdict({ head: headRuns, base: baseRun });
		for (const test of result.tests)
			console.log(
				`${test.verdict}  ${test.id}${test.detail ? ` (${test.detail})` : ""}`,
			);
		if (result.verdict === "INCONCLUSIVE") {
			if (
				result.tests.some((test) =>
					test.detail?.startsWith("suite failed to load"),
				)
			)
				console.log(LOAD_FAILURE_MESSAGE);
			if (
				result.tests.some(
					(test) => !test.detail?.startsWith("suite failed to load"),
				)
			)
				console.log(HEAD_GREEN_MESSAGE);
		}
		if (result.verdict === "ALL-GREEN")
			console.log(
				"Nothing failed on HEAD or base; the red was not reproduced. Not evidence of unrelated.",
			);
		console.log(`VERDICT: ${result.verdict}`);
		return (
			{
				"CAUSED-BY-CHANGE": EXIT.CAUSED,
				INCONCLUSIVE: EXIT.INCONCLUSIVE,
			}[result.verdict] ?? EXIT.OK
		);
	} catch (error) {
		if (error instanceof Interrupted) return 128 + interrupted;
		console.error(`red-on-base: ${error.message}`);
		return EXIT.INCONCLUSIVE;
	} finally {
		process.removeListener("SIGINT", onSigint);
		process.removeListener("SIGTERM", onSigterm);
		if (added) removeWorktree(cwd, worktree);
		rmSync(runRoot, { recursive: true, force: true });
		if (lock) await lock.release();
	}
}

if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === resolve(process.argv[1])
)
	process.exitCode = await main();
