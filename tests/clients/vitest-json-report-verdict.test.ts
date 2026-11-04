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
	/** Raw replacement for the pytest spawn. */
	pytest: undefined as undefined | { stdout: string; status: number },
}));

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
	evaluateGitGuard,
	mergeGitGuardTestFailure,
} from "../../clients/git-guard.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import { setProjectTrustState } from "../../clients/project-trust.js";
import { scannerReportParentDir } from "../../clients/scanner-temp-root.js";
import { TestRunnerClient } from "../../clients/test-runner-client.js";
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
	fake.spawns.length = 0;
	fake.fixtures.clear();
	fake.pytest = undefined;
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

	it("vitest 3 (report on stdout): a failing test stays blocked", async () => {
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

	it("reads vitest 3's stdout report", async () => {
		const result = await run("fail", "3");
		expect(result).toMatchObject({ passed: 1, failed: 1 });
		expect(result.error).toBeUndefined();
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
