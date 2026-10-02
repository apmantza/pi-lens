import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	failedTestIds,
	HEAD_GREEN_MESSAGE,
} from "../../scripts/red-on-base.mjs";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { gitExecFileSync, gitFixtureEnv } from "../support/git-fixture-env.js";
import { acquireTestLock, getLockPath } from "../../scripts/lib/suite-lock.mjs";

// flake-shape: real-process-spawn — the real CLI, Git worktree lifecycle,
// signal delivery and child-process cleanup ordering are the contract;
// in-process stubs cannot prove them. The ONLY seam is --test-command, a fake
// `vitest run --reporter=json` (tests/support/red-on-base-fake-vitest.mjs)
// whose report shape is pinned to a real vitest 5.0.2 report below.
// lane: ubuntu Unit tests (POSIX sh git shim, TMPDIR-derived scratch root).

const CLI = path.resolve("scripts/red-on-base.mjs");
const FAKE = path.resolve("tests/support/red-on-base-fake-vitest.mjs");
const REAL_REPORT = path.resolve(
	"tests/scripts/fixtures/red-on-base-vitest-report.json",
);

type TestSpec = {
	name: string;
	status: "passed" | "failed";
	failOnRuns?: number[];
};
type Scenario = {
	files: Record<
		string,
		{ tests: TestSpec[] } | { suiteFailure: true | string }
	>;
	buildExit?: number;
	noReport?: boolean;
	failExit?: boolean;
	signalParent?: boolean;
};
type Repo = ReturnType<typeof makeRepo>;

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const pass = (name: string): TestSpec => ({ name, status: "passed" });
const red = (name: string, failOnRuns?: number[]): TestSpec => ({
	name,
	status: "failed",
	failOnRuns,
});
const file = (...tests: TestSpec[]) => ({ tests });

function git(cwd: string, ...args: string[]) {
	return gitExecFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(base: Scenario, head: Scenario) {
	const env = setupTestEnvironment("pi-lens-red-on-base-test-");
	cleanups.push(env.cleanup);
	const root = path.join(env.tmpDir, "repo");
	const tmp = path.join(env.tmpDir, "tmp");
	const bin = path.join(env.tmpDir, "bin");
	for (const dir of [root, tmp, bin]) fs.mkdirSync(dir);
	const commit = (scenario: Scenario, message: string) => {
		fs.rmSync(path.join(root, "tests"), { recursive: true, force: true });
		fs.writeFileSync(
			path.join(root, "package.json"),
			JSON.stringify({ scripts: { build: `node ${FAKE} --build` } }),
		);
		fs.writeFileSync(path.join(root, ".gitignore"), "node_modules\n");
		fs.writeFileSync(
			path.join(root, "scenario.json"),
			JSON.stringify(scenario),
		);
		for (const name of Object.keys(scenario.files)) {
			fs.mkdirSync(path.join(root, path.dirname(name)), { recursive: true });
			fs.writeFileSync(path.join(root, name), `// ${message}\n`);
		}
		git(root, "add", ".");
		git(
			root,
			"-c",
			"user.email=t@example.com",
			"-c",
			"user.name=T",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			message,
		);
	};
	git(root, "init", "-q", "-b", "main");
	commit(base, "base");
	commit(head, "head");
	fs.mkdirSync(path.join(root, "node_modules"));
	// The real git behind a PATH shim that refuses `worktree remove --force` while
	// node_modules is still inside the tree (the #3173 hazard) and logs each ok one.
	const realGit = spawnSync("sh", ["-c", "command -v git"], {
		encoding: "utf8",
	}).stdout.trim();
	fs.writeFileSync(
		path.join(bin, "git"),
		[
			"#!/bin/sh",
			`real=${realGit}`,
			"if [ \"$1 $2 $3\" = 'worktree remove --force' ]; then",
			'  if [ -e "$4/node_modules" ] || [ -L "$4/node_modules" ]; then echo \'node_modules still present at remove\' >&2; exit 91; fi',
			'  echo unlink-before-remove >> "$CLEANUP_LOG"',
			"fi",
			"if [ \"$1 $2\" = 'worktree add' ] && [ -n \"$FAIL_WORKTREE_ADD\" ]; then echo 'add refused' >&2; exit 92; fi",
			'exec "$real" "$@"',
		].join("\n"),
		{ mode: 0o755 },
	);
	return {
		root,
		tmp,
		bin,
		probeLog: path.join(env.tmpDir, "probe.log"),
		cleanupLog: path.join(env.tmpDir, "cleanup.log"),
		ambientHome: path.join(env.tmpDir, "ambient-home"),
	};
}

function run(
	repo: Repo,
	argv: string[],
	extraEnv: Record<string, string> = {},
) {
	const env: NodeJS.ProcessEnv = {
		...gitFixtureEnv(repo.root),
		PATH: `${repo.bin}${path.delimiter}${process.env.PATH}`,
		TMPDIR: repo.tmp,
		PI_LENS_HOME: repo.ambientHome,
		PROBE_LOG: repo.probeLog,
		CLEANUP_LOG: repo.cleanupLog,
		...extraEnv,
	};
	// A hermetic fixture: the ambient runner's test-lock bypass (CI sets
	// `PI_LENS_TEST_NO_LOCK=1` for an isolated box) must not leak into the
	// child, or the #3853 exclusive-holder arm silently skips the lock it
	// exists to prove. The bypass stays production behavior; a test that wants
	// it passes it through `extraEnv`.
	if (!("PI_LENS_TEST_NO_LOCK" in extraEnv)) delete env.PI_LENS_TEST_NO_LOCK;
	return spawnSync(process.execPath, [CLI, ...argv, "--test-command", FAKE], {
		cwd: repo.root,
		encoding: "utf8",
		timeout: 120_000,
		env,
	});
}

type Probe = {
	phase: string;
	cwd: string;
	pid: number;
	home: string;
	tmp: string;
	files?: string[];
};
const probes = (repo: Repo): Probe[] =>
	fs.existsSync(repo.probeLog)
		? fs
				.readFileSync(repo.probeLog, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
		: [];
const cleanupLines = (repo: Repo) =>
	fs.existsSync(repo.cleanupLog)
		? fs.readFileSync(repo.cleanupLog, "utf8").trim().split("\n")
		: [];
const worktrees = (repo: Repo) =>
	git(repo.root, "worktree", "list", "--porcelain")
		.split("\n")
		.filter((line) => line.startsWith("worktree ")).length;
const scratch = (repo: Repo) => {
	const dir = path.join(repo.tmp, "pi-lens-scratch");
	return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};
function expectCleanedUp(repo: Repo) {
	expect(worktrees(repo)).toBe(1);
	expect(scratch(repo)).toEqual([]);
}
const verdictLine = (stdout: string) =>
	stdout.split("\n").find((line) => line.startsWith("VERDICT: "));
const baseTests = (repo: Repo) =>
	probes(repo).filter((e) => e.phase === "test" && e.cwd !== repo.root);
const headTests = (repo: Repo) =>
	probes(repo).filter((e) => e.phase === "test" && e.cwd === repo.root);

const A = "tests/a.test.mjs";

describe("red-on-base report parsing", () => {
	it("reads the failed tests and the failed suite out of a real vitest 5.0.2 report", () => {
		// The vector was generated by running the repo's vitest (5.0.2) with
		// --reporter=json over a passing/failing/skipped test and an unloadable
		// file, paths rewritten to /repo. A hand-shaped double would encode a guess.
		const report = JSON.parse(fs.readFileSync(REAL_REPORT, "utf8"));
		expect(failedTestIds(report, "/repo")).toEqual([
			"tests/scripts/zz/load.test.ts > (suite failed to run)",
			"tests/scripts/zz/vec.test.ts > suite fails",
		]);
	});
});

describe("red-on-base CLI verdicts", () => {
	it("CAUSED-BY-CHANGE: red on HEAD, green on base, exit 1, both SHAs and both builds", () => {
		const repo = makeRepo(
			{ files: { [A]: file(pass("t")) } },
			{ files: { [A]: file(red("t")) } },
		);
		const result = run(repo, [A, "--base", "HEAD~1"]);
		expect(result.status).toBe(1);
		expect(result.stdout).toContain(
			`HEAD ${git(repo.root, "rev-parse", "HEAD")}`,
		);
		expect(result.stdout).toContain(
			`BASE HEAD~1 ${git(repo.root, "rev-parse", "HEAD~1")}`,
		);
		expect(result.stdout).toContain(`CAUSED-BY-CHANGE  ${A} > t`);
		expect(verdictLine(result.stdout)).toBe("VERDICT: CAUSED-BY-CHANGE");
		// HEAD and base are both built and both tested, the base one elsewhere.
		const builds = probes(repo).filter((e) => e.phase === "build");
		expect(builds.map((e) => e.cwd === repo.root)).toEqual([true, false]);
		expect(headTests(repo)).toHaveLength(1);
		expect(baseTests(repo)).toHaveLength(1);
		expectCleanedUp(repo);
		expect(cleanupLines(repo)).toEqual(["unlink-before-remove"]);
	});

	it("RED-ON-BASE: red on both sides, exit 0", () => {
		const repo = makeRepo(
			{ files: { [A]: file(red("t")) } },
			{ files: { [A]: file(red("t")) } },
		);
		const result = run(repo, [A, "--base", "HEAD~1"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(`RED-ON-BASE  ${A} > t`);
		expect(verdictLine(result.stdout)).toBe("VERDICT: RED-ON-BASE");
		expectCleanedUp(repo);
	});

	it("per test, not per file: a base-red test does not hide a change-broken sibling", () => {
		const repo = makeRepo(
			{ files: { [A]: file(red("X pre-existing"), pass("Y")) } },
			{ files: { [A]: file(red("X pre-existing"), red("Y")) } },
		);
		const result = run(repo, [A, "--base", "HEAD~1"]);
		expect(result.status).toBe(1);
		expect(result.stdout).toContain(`RED-ON-BASE  ${A} > X pre-existing`);
		expect(result.stdout).toContain(`CAUSED-BY-CHANGE  ${A} > Y`);
		expect(verdictLine(result.stdout)).toBe("VERDICT: CAUSED-BY-CHANGE");
	});

	it("a test file the change adds is CAUSED-BY-CHANGE, not red on a base that lacks it", () => {
		const B = "tests/new.test.mjs";
		const repo = makeRepo(
			{ files: { [A]: file(pass("t")) } },
			{ files: { [A]: file(pass("t")), [B]: file(red("new feature")) } },
		);
		const result = run(repo, [A, B, "--base", "HEAD~1"]);
		expect(result.status).toBe(1);
		expect(result.stdout).toContain(`CAUSED-BY-CHANGE  ${B} > new feature`);
		// Base is only asked about the file it has.
		expect(baseTests(repo).map((e) => e.files)).toEqual([[A]]);
	});

	it("a run over only new test files never runs the base tests and is CAUSED-BY-CHANGE", () => {
		const B = "tests/new.test.mjs";
		const repo = makeRepo(
			{ files: { [A]: file(pass("t")) } },
			{ files: { [A]: file(pass("t")), [B]: file(red("new feature")) } },
		);
		const result = run(repo, [B, "--base", "HEAD~1"]);
		expect(result.status).toBe(1);
		expect(verdictLine(result.stdout)).toBe("VERDICT: CAUSED-BY-CHANGE");
		expect(baseTests(repo)).toEqual([]);
		expectCleanedUp(repo);
	});

	it("a suite that fails to load is a red with its own id, compared across sides", () => {
		const caused = makeRepo(
			{ files: { [A]: file(pass("t")) } },
			{ files: { [A]: { suiteFailure: true } } },
		);
		const causedResult = run(caused, [A, "--base", "HEAD~1"]);
		expect(causedResult.status).toBe(1);
		expect(causedResult.stdout).toContain(
			`CAUSED-BY-CHANGE  ${A} > (suite failed to run)`,
		);
		const onBase = makeRepo(
			{ files: { [A]: { suiteFailure: true } } },
			{ files: { [A]: { suiteFailure: true } } },
		);
		const onBaseResult = run(onBase, [A, "--base", "HEAD~1"]);
		expect(onBaseResult.status).toBe(0);
		expect(onBaseResult.stdout).toContain(
			`RED-ON-BASE  ${A} > (suite failed to run)`,
		);
	});

	it("INCONCLUSIVE: a suite that fails to load on both sides with different causes is not red-on-base", () => {
		// The verifier's probe (verify-3729-r2 6a): base cannot load the file for
		// cause A, HEAD for cause B; one id per file made that RED-ON-BASE, exit 0.
		const repo = makeRepo(
			{ files: { [A]: { suiteFailure: "Cannot find module './a'" } } },
			{ files: { [A]: { suiteFailure: "SyntaxError: cause B" } } },
		);
		const result = run(repo, [A, "--base", "HEAD~1"]);
		expect(result.status).toBe(3);
		expect(result.stdout).toContain(
			`INCONCLUSIVE  ${A} > (suite failed to run) (suite failed to load on both sides with different errors)`,
		);
		expect(result.stdout).toContain(
			"The suite failed to load on both HEAD and base with different errors. Not evidence of unrelated.",
		);
		// #3748 item 4: the concurrency hint misattributes a load failure.
		expect(result.stdout).not.toContain("HEAD green when run alone");
		expect(verdictLine(result.stdout)).toBe("VERDICT: INCONCLUSIVE");
	});

	it("INCONCLUSIVE: mixed load failure and flaky test print both applicable messages", () => {
		// #3748 F1: a load failure must not suppress the concurrency hint for a
		// separate flaky test in the same CLI run.
		const B = "tests/b.test.mjs";
		const repo = makeRepo(
			{
				files: {
					[A]: { suiteFailure: "Cannot find module './a'" },
					[B]: file(pass("flaky")),
				},
			},
			{
				files: {
					[A]: { suiteFailure: "SyntaxError: cause B" },
					[B]: file(red("flaky", [1])),
				},
			},
		);
		const result = run(repo, [A, B, "--base", "HEAD~1", "--repeat", "3"]);
		expect(result.status).toBe(3);
		expect(result.stdout).toContain(
			"The suite failed to load on both HEAD and base with different errors. Not evidence of unrelated.",
		);
		expect(result.stdout).toContain(HEAD_GREEN_MESSAGE);
		expect(verdictLine(result.stdout)).toBe("VERDICT: INCONCLUSIVE");
	});

	it("a suite load error that differs only by the tree path is the same cause: RED-ON-BASE", () => {
		const message =
			"Cannot find module './x' imported from %CWD%/tests/a.test.mjs";
		const repo = makeRepo(
			{ files: { [A]: { suiteFailure: message } } },
			{ files: { [A]: { suiteFailure: message } } },
		);
		const result = run(repo, [A, "--base", "HEAD~1"]);
		expect(result.status).toBe(0);
		expect(verdictLine(result.stdout)).toBe("VERDICT: RED-ON-BASE");
	});

	it("ALL-GREEN: nothing fails anywhere, exit 0, and says it is not evidence of unrelated", () => {
		const repo = makeRepo(
			{ files: { [A]: file(pass("t")) } },
			{ files: { [A]: file(pass("t")) } },
		);
		const result = run(repo, [A, "--base", "HEAD~1"]);
		expect(result.status).toBe(0);
		expect(verdictLine(result.stdout)).toBe("VERDICT: ALL-GREEN");
		expect(result.stdout).toContain("Not evidence of unrelated");
	});

	it("INCONCLUSIVE: a test red in some HEAD runs but not all, with counts (--repeat)", () => {
		const repo = makeRepo(
			{ files: { [A]: file(pass("flaky")) } },
			{ files: { [A]: file(red("flaky", [1])) } },
		);
		const result = run(repo, [A, "--base", "HEAD~1", "--repeat", "3"]);
		expect(result.status).toBe(3);
		expect(result.stdout).toContain(
			`INCONCLUSIVE  ${A} > flaky (red in 1/3 HEAD runs)`,
		);
		expect(result.stdout).toContain(
			"HEAD green when run alone; the red may be concurrency OR a flaky change. Not evidence of unrelated.",
		);
		expect(verdictLine(result.stdout)).toBe("VERDICT: INCONCLUSIVE");
		expect(headTests(repo)).toHaveLength(3);
	});

	it("INCONCLUSIVE: HEAD green while base is red is not a HEAD verdict", () => {
		const repo = makeRepo(
			{ files: { [A]: file(red("t")) } },
			{ files: { [A]: file(pass("t")) } },
		);
		const result = run(repo, [A, "--base", "HEAD~1"]);
		expect(result.status).toBe(3);
		expect(verdictLine(result.stdout)).toBe("VERDICT: INCONCLUSIVE");
	});

	it("CAUSED-BY-CHANGE outranks INCONCLUSIVE when a run has both a flaky and a broken test", () => {
		const repo = makeRepo(
			{ files: { [A]: file(pass("flaky"), pass("Y")) } },
			{ files: { [A]: file(red("flaky", [1]), red("Y")) } },
		);
		const result = run(repo, [A, "--base", "HEAD~1", "--repeat", "3"]);
		expect(result.status).toBe(1);
		expect(result.stdout).toContain(`INCONCLUSIVE  ${A} > flaky`);
		expect(result.stdout).toContain(`CAUSED-BY-CHANGE  ${A} > Y`);
		expect(verdictLine(result.stdout)).toBe("VERDICT: CAUSED-BY-CHANGE");
	});

	it("INCONCLUSIVE: a nonzero exit whose report names no failing test is not attributable", () => {
		const repo = makeRepo(
			{ files: { [A]: file(pass("t")) } },
			{ files: { [A]: file(pass("t")) }, failExit: true },
		);
		const result = run(repo, [A, "--base", "HEAD~1"]);
		expect(result.status).toBe(3);
		expect(result.stdout).toContain("HEAD run 1: no per-test report");
		expect(verdictLine(result.stdout)).toBe("VERDICT: INCONCLUSIVE");
	});

	it("INCONCLUSIVE: a run with no per-test report is never counted as red", () => {
		const repo = makeRepo(
			{ files: { [A]: file(pass("t")) } },
			{ files: { [A]: file(pass("t")) }, noReport: true },
		);
		const result = run(repo, [A, "--base", "HEAD~1"]);
		expect(result.status).toBe(3);
		expect(result.stdout).toContain("HEAD run 1: no per-test report");
		expect(verdictLine(result.stdout)).toBe("VERDICT: INCONCLUSIVE");
	});
});

describe("red-on-base usage and build failures", () => {
	it("a typo'd test path is a usage error (exit 2), builds nothing and prints no verdict", () => {
		const repo = makeRepo(
			{ files: { [A]: file(pass("t")) } },
			{ files: { [A]: file(pass("t")) } },
		);
		const result = run(repo, ["tests/typo.test.mjs", "--base", "HEAD~1"]);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("tests/typo.test.mjs does not exist");
		expect(result.stdout).not.toContain("VERDICT");
		expect(probes(repo)).toEqual([]);
	});

	it.each([
		[[], "no test files given"],
		[[A, "--repeat", "0"], "--repeat must be a positive integer"],
		[[A, "--bogus"], "unknown flag --bogus"],
	])(
		"bad arguments %j are a usage error (exit 2) before anything runs",
		(argv, message) => {
			const repo = makeRepo(
				{ files: { [A]: file(pass("t")) } },
				{ files: { [A]: file(pass("t")) } },
			);
			const result = run(repo, argv);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain(message);
			expect(probes(repo)).toEqual([]);
		},
	);

	it("a --base that is not a commit is a usage error (exit 2)", () => {
		const repo = makeRepo(
			{ files: { [A]: file(pass("t")) } },
			{ files: { [A]: file(pass("t")) } },
		);
		const result = run(repo, [A, "--base", "no-such-ref"]);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("--base no-such-ref is not a commit");
		expect(probes(repo)).toEqual([]);
	});

	it("a HEAD build failure is exit 4 before any test runs", () => {
		const repo = makeRepo(
			{ files: { [A]: file(pass("t")) } },
			{ files: { [A]: file(red("t")) }, buildExit: 1 },
		);
		const result = run(repo, [A, "--base", "HEAD~1"]);
		expect(result.status).toBe(4);
		expect(result.stderr).toContain("HEAD build failed");
		expect(result.stdout).not.toContain("VERDICT");
		expect(probes(repo).filter((e) => e.phase === "test")).toEqual([]);
		expectCleanedUp(repo);
	});

	it("a tool failure (git refuses the base worktree) is exit 3, never 0, and prints no verdict", () => {
		const repo = makeRepo(
			{ files: { [A]: file(pass("t")) } },
			{ files: { [A]: file(pass("t")) } },
		);
		const result = run(repo, [A, "--base", "HEAD~1"], {
			FAIL_WORKTREE_ADD: "1",
		});
		expect(result.status).toBe(3);
		expect(result.stderr).toContain("red-on-base:");
		expect(result.stdout).not.toContain("VERDICT");
		expectCleanedUp(repo);
	});

	it("a base build failure is exit 4, no verdict, and the worktree is unlinked then removed", () => {
		const repo = makeRepo(
			{ files: { [A]: file(pass("t")) }, buildExit: 1 },
			{ files: { [A]: file(red("t")) } },
		);
		const result = run(repo, [A, "--base", "HEAD~1"]);
		expect(result.status).toBe(4);
		expect(result.stderr).toContain("base build failed");
		expect(result.stdout).not.toContain("VERDICT");
		expect(probes(repo).filter((e) => e.phase === "test")).toEqual([]);
		expectCleanedUp(repo);
		expect(cleanupLines(repo)).toEqual(["unlink-before-remove"]);
	});
});

describe("red-on-base hygiene pins", () => {
	it("pins TMPDIR and a separate PI_LENS_HOME for every HEAD and base child", () => {
		const repo = makeRepo(
			{ files: { [A]: file(pass("t")) } },
			{ files: { [A]: file(pass("t")) } },
		);
		run(repo, [A, "--base", "HEAD~1"]);
		const log = probes(repo);
		expect(log).toHaveLength(4); // head build, base build, head test, base test
		const scratchRoot = fs.realpathSync(path.join(repo.tmp, "pi-lens-scratch"));
		for (const entry of log) {
			expect(entry.home).not.toBe(repo.ambientHome);
			expect(entry.home.startsWith(scratchRoot)).toBe(true);
			expect(entry.tmp.startsWith(scratchRoot)).toBe(true);
		}
		const homeOf = (phase: string, onBase: boolean) =>
			log.find((e) => e.phase === phase && (e.cwd !== repo.root) === onBase)
				?.home;
		expect(homeOf("test", false)).toBe(homeOf("build", false));
		expect(homeOf("test", true)).toBe(homeOf("build", true));
		expect(homeOf("test", false)).not.toBe(homeOf("test", true));
	});
});

describe("red-on-base interruption", () => {
	const interrupted = { files: { [A]: file(pass("t")) }, signalParent: true };
	const green = { files: { [A]: file(pass("t")) } };

	it.each([
		["SIGINT", 130],
		["SIGTERM", 143],
	])(
		"%s mid base-run kills the child, cleans up, exits %i and prints no verdict",
		(signal, code) => {
			const repo = makeRepo(interrupted, green);
			const result = run(repo, [A, "--base", "HEAD~1"], {
				FAKE_SIGNAL_PARENT: signal,
			});
			expect(result.signal).toBeNull();
			expect(result.status).toBe(code);
			expect(result.stdout).not.toContain("VERDICT");
			expect(result.stdout).not.toMatch(
				/CAUSED-BY-CHANGE|RED-ON-BASE|ALL-GREEN/,
			);
			expectCleanedUp(repo);
			expect(cleanupLines(repo)).toEqual(["unlink-before-remove"]);
			const [child] = baseTests(repo);
			expect(() => process.kill(child.pid, 0)).toThrow(/ESRCH/);
			// The runner's own child died with the process group (no marker).
			expect(fs.existsSync(`${repo.probeLog}.grandchild`)).toBe(false);
		},
	);

	it("a runner that ignores SIGTERM is SIGKILLed rather than waited out", () => {
		const repo = makeRepo(interrupted, green);
		const result = run(repo, [A, "--base", "HEAD~1"], {
			FAKE_SIGNAL_PARENT: "SIGTERM",
			FAKE_IGNORE_SIGTERM: "1",
		});
		expect(result.status).toBe(143);
		// Waited out, the ignoring runner would reach its own 8s exit and write this.
		expect(fs.existsSync(`${repo.probeLog}.survived`)).toBe(false);
		expectCleanedUp(repo);
	});

	it("a SIGKILLed run leaves a worktree that the next run reaps, unlinking first", () => {
		const repo = makeRepo(interrupted, green);
		const killed = run(repo, [A, "--base", "HEAD~1"], {
			FAKE_SIGNAL_PARENT: "SIGKILL",
		});
		expect(killed.signal).toBe("SIGKILL");
		const [stranded] = baseTests(repo);
		// Precondition: the leftover is real (registered, symlink still in place).
		expect(worktrees(repo)).toBe(2);
		expect(
			fs.lstatSync(path.join(stranded.cwd, "node_modules")).isSymbolicLink(),
		).toBe(true);
		expect(cleanupLines(repo)).toEqual([]);

		const next = run(repo, [A, "--base", "HEAD~1"]);
		expect(next.status).toBe(0);
		expectCleanedUp(repo);
		expect(fs.existsSync(stranded.cwd)).toBe(false);
		// One removal for the reaped leftover, one for the second run's own worktree.
		expect(cleanupLines(repo)).toEqual([
			"unlink-before-remove",
			"unlink-before-remove",
		]);
	});
});

describe("shared test-suite slot (#3853)", () => {
	it("waits behind a live exclusive holder and refuses to run vitest", async () => {
		// The whole red-on-base run takes one shared slot. A full-suite
		// (exclusive) holder must make it wait and then refuse, never run
		// concurrently: a real in-process store plus the real spawned CLI, no
		// mocked lock.
		const repo = makeRepo(
			{ files: { [A]: file(pass("t")) } },
			{ files: { [A]: file(pass("t")) } },
		);
		fs.mkdirSync(repo.ambientHome, { recursive: true });
		const previousHome = process.env.PI_LENS_HOME;
		process.env.PI_LENS_HOME = repo.ambientHome;
		const exclusive = await acquireTestLock({
			lockPath: getLockPath(),
			slots: 2,
			pollIntervalMs: 10,
			heartbeatIntervalMs: 5_000,
		});
		try {
			const result = run(repo, [A, "--base", "HEAD~1"], {
				PI_LENS_TEST_LOCK_TIMEOUT_MS: "250",
			});
			expect(result.status).toBe(3);
			expect(result.stderr).toContain("exclusive test-suite lock held by PID");
			// The slot was never free: no test process ran.
			expect(probes(repo).filter((entry) => entry.phase === "test")).toEqual(
				[],
			);
		} finally {
			await exclusive.release();
			if (previousHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previousHome;
		}
	});
});
