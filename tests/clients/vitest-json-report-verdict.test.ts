/**
 * #5257: a test run whose report the runner could not read must never clear
 * the `--lens-guard` test-failure blocker.
 *
 * Recurrence prevented (2026-11-04 probe at eef7e948b): vitest 5 writes
 * `--reporter=json` to `.vitest/json/output.json` and prints only `JSON report
 * written to <path>`. `parseJsonTestOutput` caught the `JSON.parse` failure and
 * returned an error-free empty result, `handleTurnEnd` logged "all tests passed"
 * and called `clearGitGuardTestFailure`, so `evaluateGitGuard` went from
 * `block: true` to `block: false` over a genuinely failing test.
 *
 * Every case drives the real `handleTurnEnd`, the real `TestRunnerClient`, the
 * real `CacheManager` and the real `evaluateGitGuard`. The one thing faked is
 * the vitest PROCESS (`safeSpawnAsync`), which replays reports CAPTURED from
 * real vitest 5.0.5 and 3.2.7 runs (`tests/fixtures/vitest-json-report/`) and
 * honours `--outputFile` exactly as the real CLI does: with the flag it writes
 * the report there, without it vitest 5 writes `.vitest/json/output.json` under
 * the child's cwd and prints only the notice, vitest 3 prints the report.
 *
 * #5270 adds the pytest half: the same real `handleTurnEnd` path over output
 * CAPTURED from real pytest 9.2.0 runs (`tests/fixtures/pytest-output/`), replayed
 * by the faked pytest PROCESS. Recurrence prevented (2026-11-04 probe, real
 * pytest 9.2.0 through `TestRunnerClient` and turn-end): `1 passed, 1 error`
 * (a fixture raised), exit 1, parsed as passed=1 failed=0 with no error, logged
 * "all tests passed" and cleared the `--lens-guard` blocker.
 *
 * Boundary decision (flake-shape): no real test runner spawn and no wall-clock
 * wait; completion is awaited on the turn's own debug line.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	/** "5": report goes to the file; "3": report goes to stdout. */
	version: "5" as "5" | "3",
	/** Fixture name per test-file basename; absent = the fake writes nothing. */
	fixtures: new Map<string, string>(),
	/** Fixture directory root. */
	root: "",
	spawns: [] as Array<{ command: string; args: string[]; cwd: string }>,
	/** #5270: ignore `--outputFile` and print the report on stdout (a wrapper). */
	stdoutOnly: false,
	/** Raw replacement for the pytest spawn. */
	pytest: undefined as undefined | { stdout: string; status: number },
}));

/** Captured pytest 9.2.0 runs (fixture name -> exit code, see the README). */
const PYTEST_RUNS = {
	pass: 0,
	xfail: 0,
	mixed: 1,
	fail_and_error: 1,
	collect: 2,
	empty: 5,
	// #5270 r1: exit 1 with no error term (a coverage threshold, a plain failure).
	cov_fail_under: 1,
	errors_plural: 1,
	failed_and_passed: 1,
	failed_only: 1,
	// #5276 r2: exit 3 (pytest.exit or INTERNALERROR) after a summary was printed.
	exit3_pytest_exit: 3,
	exit3_internalerror: 3,
	exit3_after_failure: 3,
} as const;
type PytestRun = keyof typeof PYTEST_RUNS;
function pytestRun(name: PytestRun): { stdout: string; status: number } {
	return {
		stdout: fs.readFileSync(
			path.join(
				fileURLToPath(new URL("../fixtures/pytest-output/", import.meta.url)),
				"pytest-9.2.0",
				`${name}.txt`,
			),
			"utf8",
		),
		status: PYTEST_RUNS[name],
	};
}

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync: vi.fn(
		async (command: string, args: string[], options?: { cwd?: string }) => {
			const testFile = args.find((arg) => /\.(test\.ts|py)$/.test(arg));
			if (testFile === undefined) return { stdout: "", stderr: "", status: 0 };
			const cwd = options?.cwd ?? "";
			fake.spawns.push({ command, args, cwd });
			if (args.includes("pytest")) {
				return { stderr: "", ...(fake.pytest ?? { stdout: "", status: 0 }) };
			}
			const name = fake.fixtures.get(path.basename(testFile));
			const dir = fake.version === "5" ? "vitest-5.0.5" : "vitest-3.2.7";
			const file =
				fake.version === "5" ? `${name}.json` : `${name}.stdout.json`;
			const report =
				name === undefined
					? undefined
					: fs.readFileSync(path.join(fake.root, dir, file), "utf8");
			const status = report?.includes('"success":false') ? 1 : 0;
			if (fake.stdoutOnly) return { stdout: report ?? "", stderr: "", status };
			const flag = args.find((arg) => arg.startsWith("--outputFile="));
			let outputFile = flag?.slice("--outputFile=".length);
			if (fake.version === "5" && outputFile === undefined) {
				// vitest 5 default: the report lands in the project, not on stdout.
				outputFile = path.join(cwd, ".vitest", "json", "output.json");
			}
			if (outputFile !== undefined) {
				if (report !== undefined) {
					fs.mkdirSync(path.dirname(outputFile), { recursive: true });
					fs.writeFileSync(outputFile, report);
				}
				return {
					stdout: `JSON report written to ${outputFile}\n`,
					stderr: "",
					status,
				};
			}
			return { stdout: report ?? "", stderr: "", status };
		},
	),
}));

import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	evaluateGitGuard,
	mergeGitGuardTestFailure,
} from "../../clients/git-guard.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import { setProjectTrustState } from "../../clients/project-trust.js";
import { scannerReportParentDir } from "../../clients/scanner-temp-root.js";
import {
	isCompletedPassResult,
	TestRunnerClient,
} from "../../clients/test-runner-client.js";
import { setupTestEnvironment } from "./test-utils.js";

fake.root = fileURLToPath(
	new URL("../fixtures/vitest-json-report/", import.meta.url),
);

const SESSION = "vitest-verdict-session";
const EMPTY_KNIP = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	summary: "skipped",
};
const TERMINAL =
	/all tests passed|test failure|partial test batch|no completed test result/;

let env: ReturnType<typeof setupTestEnvironment>;
let root: string;
let runtime: RuntimeCoordinator;
let cacheManager: CacheManager;
let client: TestRunnerClient;
let dbgLines: string[];

function write(relative: string, content: string): string {
	const file = path.join(root, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

/** One edited source with its companion test; the fake replays `fixture` for it. */
function plant(name: string, fixture: string | undefined): string {
	const src = write(`src/${name}.ts`, `export const ${name} = 1;\n`);
	const test = write(`src/${name}.test.ts`, "export {};\n");
	if (fixture !== undefined) fake.fixtures.set(`${name}.test.ts`, fixture);
	cacheManager.addModifiedRange(
		src,
		{ start: 1, end: 1 },
		false,
		root,
		SESSION,
	);
	return test;
}

function seedBlocker(...files: string[]): void {
	mergeGitGuardTestFailure(
		cacheManager,
		root,
		runtime,
		"[Tests] ✗ 1/1 failed — vitest",
		files,
	);
}

/** Basenames still recorded as test-failure blockers. */
function blockerFiles(): string[] {
	const record = cacheManager.readCache<{ testFailureFiles?: string[] }>(
		"turn-end-findings",
		root,
	)?.data;
	return (record?.testFailureFiles ?? []).map((file) => path.basename(file));
}

const blocked = (): boolean =>
	evaluateGitGuard(runtime, cacheManager, root).block;

async function turnEnd(): Promise<void> {
	dbgLines = [];
	let seen: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		seen = resolve;
	});
	await handleTurnEnd({
		ctxCwd: root,
		getFlag: (flag: string) => flag === "lens-guard",
		dbg: (line: string) => {
			dbgLines.push(line);
			if (TERMINAL.test(line)) seen();
		},
		runtime,
		cacheManager,
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () => EMPTY_KNIP,
		},
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: client,
		resetLSPService: () => {},
		resetFormatService: () => {},
	} as unknown as Parameters<typeof handleTurnEnd>[0]);
	await done;
}

beforeEach(() => {
	setProjectTrustState("trusted");
	resetDegradationLedger();
	fake.spawns.length = 0;
	fake.fixtures.clear();
	fake.pytest = undefined;
	fake.stdoutOnly = false;
	fake.version = "5";
	env = setupTestEnvironment("pi-lens-5257-");
	vi.stubEnv("PI_LENS_HOME", path.join(env.tmpDir, "machine"));
	root = env.tmpDir;
	write("package.json", '{"name":"fixture","type":"module"}\n');
	write("vitest.config.mjs", "export default {};\n");
	// The project's own runner install, so no `npx` fetch is attempted.
	const shim = write("node_modules/.bin/vitest", "#!/bin/sh\nexit 0\n");
	fs.chmodSync(shim, 0o755);
	runtime = new RuntimeCoordinator();
	runtime.projectRoot = root;
	runtime.setTelemetryIdentity({ sessionId: SESSION });
	cacheManager = new CacheManager(false);
	client = new TestRunnerClient(false);
});
afterEach(() => {
	vi.unstubAllEnvs();
	env.cleanup();
});

describe("a failing vitest test keeps the commit blocked", () => {
	it("vitest 5 (report in a file): a failing test stays blocked and is reported", async () => {
		const test = plant("a", "fail");
		seedBlocker(test);
		expect(blocked()).toBe(true);
		await turnEnd();
		expect(blocked()).toBe(true);
		expect(dbgLines.join("\n")).not.toContain("all tests passed");
		const findings = cacheManager.readCache<{ content: string }>(
			"test-runner-findings",
			root,
		)?.data;
		expect(findings?.content).toContain("failed");
	});

	it("vitest 3: a failing test stays blocked", async () => {
		fake.version = "3";
		const test = plant("a", "fail");
		seedBlocker(test);
		await turnEnd();
		expect(blocked()).toBe(true);
	});

	it("vitest 5: a passing test still clears its blocker (the guard is not stuck)", async () => {
		const test = plant("a", "pass");
		seedBlocker(test);
		await turnEnd();
		expect(dbgLines.join("\n")).toContain("all tests passed");
		expect(blocked()).toBe(false);
	});

	it("vitest 3: a passing test still clears its blocker", async () => {
		fake.version = "3";
		const test = plant("a", "pass");
		seedBlocker(test);
		await turnEnd();
		expect(blocked()).toBe(false);
	});
});

describe("a batch with no completed, parsed result never reads as passed", () => {
	for (const fixture of ["empty", "skipped", "import-error"]) {
		it(`vitest 5 ${fixture}: blocker kept, no "all tests passed"`, async () => {
			const test = plant("a", fixture);
			seedBlocker(test);
			await turnEnd();
			expect(dbgLines.join("\n")).not.toContain("all tests passed");
			expect(blocked()).toBe(true);
		});
	}

	it("a zero-test batch says why it did not clear (the no-completed-result record)", async () => {
		const test = plant("a", "empty");
		seedBlocker(test);
		await turnEnd();
		expect(dbgLines).toContain(
			"turn_end: no completed test result — NOT recorded as a clean run; the test-failure blocker is untouched",
		);
		expect(
			getDegradationSummary().find(
				(group) => group.kind === "test-run-no-completed-result",
			)?.count,
		).toBe(1);
	});

	it("an unreadable report (runner printed only the notice): blocker kept", async () => {
		const test = plant("a", undefined);
		seedBlocker(test);
		await turnEnd();
		expect(dbgLines.join("\n")).not.toContain("all tests passed");
		expect(blocked()).toBe(true);
	});

	it("a not-found-only batch (file deleted between selection and spawn): blocker kept", async () => {
		const test = plant("a", "pass");
		seedBlocker(test);
		const real = client.runTestFileAsync.bind(client) as (
			...args: unknown[]
		) => Promise<unknown>;
		vi.spyOn(client, "runTestFileAsync").mockImplementation(((
			...args: unknown[]
		) => {
			fs.rmSync(test);
			return real(...args);
		}) as unknown as typeof client.runTestFileAsync);
		await turnEnd();
		expect(dbgLines.join("\n")).not.toContain("all tests passed");
		// The record, not `evaluateGitGuard`: the commit gate itself drops a
		// blocker whose file no longer exists, which would pass for the wrong reason.
		expect(blockerFiles()).toEqual(["a.test.ts"]);
	});

	it("a mixed batch clears only the file that completed", async () => {
		const passing = plant("a", "pass");
		const empty = plant("b", "empty");
		seedBlocker(passing, empty);
		await turnEnd();
		expect(dbgLines.join("\n")).toContain("all tests passed");
		expect(blockerFiles()).toEqual(["b.test.ts"]);
		expect(blocked()).toBe(true);
	});
});

describe("TestRunnerClient parse verdict", () => {
	async function run(
		fixture: string | undefined,
		version: "5" | "3" = "5",
	): Promise<Awaited<ReturnType<TestRunnerClient["runTestFileAsync"]>>> {
		fake.version = version;
		const test = plant("a", fixture);
		const detected = client.detectRunner(root, test);
		expect(detected?.runner).toBe("vitest");
		return client.runTestFileAsync(test, root, {
			runner: "vitest",
			config: detected!.config,
		});
	}

	it("reads vitest 5's report file: counts, failure name and duration", async () => {
		const result = await run("fail");
		expect(result).toMatchObject({ passed: 1, failed: 1 });
		expect(result.error).toBeUndefined();
		expect(result.failures.map((f) => f.name)).toEqual(["x"]);
		expect(result.duration).toBeGreaterThanOrEqual(0);
	});

	it("reads vitest 3's report file", async () => {
		const result = await run("fail", "3");
		expect(result).toMatchObject({ passed: 1, failed: 1 });
		expect(result.error).toBeUndefined();
	});

	// #5270: real vitest 3.2.4 and 5.0.5 print only `JSON report written to
	// <path>` on stdout when `--outputFile` is passed (the runner always passes
	// it), so there is no stdout fallback: a report on stdout with no file is an
	// unreadable report. Recurrence prevented: a dead fallback with no test (F2
	// of the #5268 review) that would silently re-admit stdout parsing.
	it("a report only on stdout (no file written) is an error result, not parsed", async () => {
		fake.stdoutOnly = true;
		const result = await run("pass", "3");
		expect(result.error).toMatch(/Could not read vitest test output/);
		expect(result.passed + result.failed).toBe(0);
	});

	it("a vitest 5 import error is an error result, not a clean zero", async () => {
		const result = await run("import-error");
		expect(result.error).toMatch(/Cannot find module/);
		expect(result.failed).toBe(0);
	});

	it("an unparseable report is an error result whatever the stdout says", async () => {
		const result = await run(undefined);
		expect(result.error).toBeTruthy();
		expect(result.passed + result.failed).toBe(0);
	});

	it("passes --outputFile under the scanner scratch root, unique per run, removed after", async () => {
		await run("pass");
		await run("pass");
		const flags = fake.spawns.map((spawn) =>
			spawn.args.find((arg) => arg.startsWith("--outputFile=")),
		);
		expect(flags.every((flag) => flag !== undefined)).toBe(true);
		const paths = flags.map((flag) => flag!.slice("--outputFile=".length));
		expect(new Set(paths).size).toBe(2);
		for (const reportPath of paths) {
			expect(path.dirname(path.dirname(reportPath))).toBe(
				scannerReportParentDir(),
			);
			expect(fs.existsSync(path.dirname(reportPath))).toBe(false);
		}
		// Never the project tree.
		expect(fs.existsSync(path.join(root, ".vitest"))).toBe(false);
	});

	it.each([
		"{}",
		"null",
		"[]",
		'"ok"',
		"",
		'{"numPassedTests":1}',
		'{"numFailedTests":0}',
		"JSON report written to /x/output.json",
	])("output %j that is not a test report is an error result", (stdout) => {
		const parse = (client as any).parseVitestOutput.bind(client);
		const result = parse(stdout, "", "/p/a.test.ts", "/p", "vitest");
		expect(result.error).toBeTruthy();
		expect(result.passed + result.failed).toBe(0);
	});

	it("pytest: a failing exit with no parsable summary is an error, not a clean zero", async () => {
		write("pytest.ini", "[pytest]\n");
		const test = write("test_a.py", "def test_a(): assert False\n");
		fake.pytest = { stdout: "Traceback: internal error\n", status: 3 };
		const detected = client.detectRunner(root, test);
		expect(detected?.runner).toBe("pytest");
		const result = await client.runTestFileAsync(test, root, {
			runner: "pytest",
			config: detected!.config,
		});
		expect(result.error).toBeTruthy();
	});
});

describe("pytest: errors beside passes never read as passed (#5270)", () => {
	/** An edited source with its `tests/test_<name>.py`; the fake replays `run`. */
	function plantPython(name: string, run: PytestRun): string {
		write("pytest.ini", "[pytest]\n");
		write(
			process.platform === "win32"
				? ".venv/Scripts/python.exe"
				: ".venv/bin/python",
			"",
		);
		const src = write(`${name}.py`, "x = 1\n");
		const test = write(`tests/test_${name}.py`, "def test_a(): pass\n");
		fake.pytest = pytestRun(run);
		cacheManager.addModifiedRange(
			src,
			{ start: 1, end: 1 },
			false,
			root,
			SESSION,
		);
		return test;
	}

	async function parse(run: PytestRun) {
		const test = plantPython("a", run);
		const detected = client.detectRunner(root, test);
		expect(detected?.runner).toBe("pytest");
		return client.runTestFileAsync(test, root, {
			runner: "pytest",
			config: detected!.config,
		});
	}

	it("1 passed, 1 error (a raising fixture): an error result, not a pass", async () => {
		const result = await parse("mixed");
		expect(result).toMatchObject({ passed: 1, failed: 0 });
		expect(result.error).toMatch(/1 error/);
	});

	it("1 failed, 1 error: the failure stays counted and the error is named", async () => {
		const result = await parse("fail_and_error");
		expect(result).toMatchObject({ passed: 0, failed: 1 });
		expect(result.error).toMatch(/1 error/);
	});

	it("a collection error is an error result (exit 2 still says interrupted)", async () => {
		const result = await parse("collect");
		expect(result.error).toBe("Pytest interrupted");
	});

	it("an xfail beside a pass is still a pass", async () => {
		const result = await parse("xfail");
		expect(result).toMatchObject({ passed: 1, failed: 0 });
		expect(result.error).toBeUndefined();
	});

	// State table (exit x summary terms -> verdict), after exit 4 (config error)
	// and exit 2 (interrupted), which keep their own messages:
	//   0 | passed>0                   -> pass
	//   1 | passed>0 failed=0 errors=0 -> pass (pytest-cov --cov-fail-under)
	//   1 | passed=0 failed>0          -> failed, no error
	//   1 | passed>0 failed>0          -> failed, no error
	//   1 | errors>0 (singular/plural) -> error naming the count
	//   1 or 3 | no summary line       -> error "no summary read"
	//   3 | passed>0 or failed>0      -> error "internal error" (failures kept)
	//   0 | passed=0 failed=0 (skips)   -> no error, not a completed pass
	//   5 | no tests                   -> no error, not a completed pass
	// Recurrence prevented (r1 of #5276): the first cut errored on ANY non-zero
	// exit that counted no failure, so a passing run under `--cov-fail-under`
	// (exit 1) became a permanent runner error and kept the commit blocker.
	it.each([
		["cov_fail_under", 1, 0, undefined],
		["failed_only", 0, 1, undefined],
		["failed_and_passed", 1, 1, undefined],
		["errors_plural", 0, 0, /^Pytest reported 2 errors /],
	] as const)(
		"%s (exit 1): passed=%i failed=%i, error %s",
		async (run, passed, failed, error) => {
			const result = await parse(run);
			expect(result).toMatchObject({ passed, failed });
			if (error === undefined) expect(result.error).toBeUndefined();
			else expect(result.error).toMatch(error);
		},
	);

	// #5270 acceptance 2: exit 3 is pytest's internal error (or a
	// `pytest.exit(returncode=3)`): the run stopped early, so the summary it
	// still prints is partial whatever it counts. Recurrence prevented (verify
	// r2 V1 of #5276, real pytest 9.2.0): `1 passed` then exit 3 read as a
	// completed pass and cleared the commit blocker.
	it.each([
		["exit3_pytest_exit", 1, 0],
		["exit3_internalerror", 2, 0],
		["exit3_after_failure", 0, 1],
	] as const)(
		"%s (exit 3): passed=%i failed=%i is an internal error, never a completed pass",
		async (run, passed, failed) => {
			const result = await parse(run);
			expect(result).toMatchObject({ passed, failed });
			expect(result.error).toBe("Pytest internal error (exit 3)");
			expect(isCompletedPassResult(result)).toBe(false);
		},
	);

	it("exit 0 with only skips counted is no error and no completed pass", async () => {
		const test = plantPython("a", "pass");
		fake.pytest = { stdout: "1 skipped in 0.00s\n", status: 0 };
		const detected = client.detectRunner(root, test);
		const result = await client.runTestFileAsync(test, root, {
			runner: "pytest",
			config: detected!.config,
		});
		expect(result).toMatchObject({ passed: 0, failed: 0, skipped: 1 });
		expect(result.error).toBeUndefined();
		expect(isCompletedPassResult(result)).toBe(false);
	});

	it.each([1, 3])(
		"exit %i with no summary line is an error, never a clean result",
		async (status) => {
			const test = plantPython("a", "pass");
			fake.pytest = { stdout: "garbled output\n", status };
			const detected = client.detectRunner(root, test);
			const result = await client.runTestFileAsync(test, root, {
				runner: "pytest",
				config: detected!.config,
			});
			expect(result.error).toBe(
				`Pytest exited with ${status} (no summary read)`,
			);
		},
	);

	it("exit 5 (no tests collected) is not an error and is not a completed pass", async () => {
		const result = await parse("empty");
		expect(result).toMatchObject({ passed: 0, failed: 0 });
		expect(result.error).toBeUndefined();
		expect(isCompletedPassResult(result)).toBe(false);
	});

	it("turn-end: 1 passed, 1 error keeps the blocker and never says all tests passed", async () => {
		const test = plantPython("a", "mixed");
		seedBlocker(test);
		expect(blocked()).toBe(true);
		await turnEnd();
		expect(dbgLines.join("\n")).not.toContain("all tests passed");
		expect(blocked()).toBe(true);
	});

	it("turn-end: exit 5 (no tests collected) keeps the old blocker", async () => {
		const test = plantPython("a", "empty");
		seedBlocker(test);
		await turnEnd();
		expect(dbgLines.join("\n")).not.toContain("all tests passed");
		expect(blocked()).toBe(true);
	});

	it("turn-end: 1 passed then exit 3 (pytest.exit) keeps the blocker", async () => {
		const test = plantPython("a", "exit3_pytest_exit");
		seedBlocker(test);
		await turnEnd();
		expect(dbgLines.join("\n")).not.toContain("all tests passed");
		expect(blocked()).toBe(true);
	});

	it("turn-end: a clean pytest pass still clears its blocker (the guard is not stuck)", async () => {
		const test = plantPython("a", "pass");
		seedBlocker(test);
		await turnEnd();
		expect(dbgLines.join("\n")).toContain("all tests passed");
		expect(blocked()).toBe(false);
	});

	it("turn-end: a pass under --cov-fail-under (exit 1) still clears its blocker", async () => {
		const test = plantPython("a", "cov_fail_under");
		seedBlocker(test);
		await turnEnd();
		expect(dbgLines.join("\n")).toContain("all tests passed");
		expect(blocked()).toBe(false);
	});

	// Class sweep of #5270: PHPUnit and mix test share pytest's guard shape
	// (`exit !== 0 && passed === 0 && failed === 0`). It stays as on master:
	// a non-zero exit that counted passes is the run's own threshold, not a
	// runner error. The outputs are hand-shaped (no PHP or Elixir toolchain on
	// the lane host; does not prove a real phpunit/mix run). Recurrence
	// prevented: dropping the `failed === 0` arm marks every all-failing run
	// (passed=0, failed>0) a runner error, which no other test pinned (F1 of
	// r1 of #5276).
	// [runner, parser method, passes only, all failing, no summary, error].
	const TEXT_RUNNERS = [
		[
			"phpunit",
			"parsePhpunitOutput",
			"Tests: 3, Assertions: 3, Warnings: 1.\n",
			"Tests: 1, Assertions: 1, Failures: 1.\n",
			"PHP Fatal error: boom\n",
			/PHPUnit runner error/,
		],
		[
			"mix",
			"parseMixTestOutput",
			"3 tests, 0 failures\n",
			"1 test, 1 failure\n",
			"** (CompileError) boom\n",
			/mix test runner error/,
		],
	] as const;

	it.each(TEXT_RUNNERS)(
		"%s: exit 1 reads passes and failures as counted, no summary as an error",
		(runner, method, passes, failing, noSummary, message) => {
			const parse = (client as any)[method].bind(client);
			const passing = parse(passes, "", 1, "/p/x_test", runner);
			expect(passing).toMatchObject({ passed: 3, failed: 0 });
			expect(passing.error).toBeUndefined();
			const failed = parse(failing, "", 1, "/p/x_test", runner);
			expect(failed).toMatchObject({ passed: 0, failed: 1 });
			expect(failed.error).toBeUndefined();
			expect(parse(noSummary, "", 1, "/p/x_test", runner).error).toMatch(
				message,
			);
		},
	);
});
