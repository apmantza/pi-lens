// flake-shape: real-process-spawn — real `git worktree add` / `git submodule add` children write the linked-worktree `.git` files and the `worktrees/*/gitdir` registry that checkout ownership is read from; an in-process stub would only restate the assumption under test

/**
 * #3871: turn_end test selection runs in the checkout that OWNS the edit.
 *
 * Recurrence prevented (live session 01a0f1c5, 2026-09-30, 191 of 196 edits in
 * `.worktrees/*`, session cwd = the main checkout): after #3649 every edit in a
 * linked worktree resolved its test against the session checkout and then lost
 * the foreign-checkout gate. `turn_end: firing N test target(s)` went from 44
 * (B2a) to 0 (B3), `test target excluded by the built-in turn-end policy`
 * named two edited worktree test files, and a worktree source whose name also
 * existed under the session's `tests/` would have run the SESSION's test for a
 * worktree edit. The #3649 failed-first crossover (35 of 39 failed-first runs
 * replayed another worktree's failing file) must stay closed.
 *
 * Every case drives the real `handleTurnEnd`, the real `TestRunnerClient` and
 * the real `CacheManager` over REAL git worktrees. The one thing faked is the
 * test process (`safeSpawnAsync`): a recorder that returns a vitest-shaped
 * result for the test file named in its args, so the assertions read what the
 * production code asked the runner to do (command, cwd, file), not what it
 * believed.
 *
 * Boundary decision (flake-shape): no real test runner spawn and no wall-clock
 * wait; the batch is awaited through the production `runTestFileAsync` promises.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// The latency writer captures its path at import time, including through
// transitive imports: pin the home before any client module loads.
const logHome = await vi.hoisted(async () => {
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const home = mkdtempSync(join(tmpdir(), "pi-lens-3871-log-"));
	vi.stubEnv("PI_LENS_HOME", home);
	return home;
});

const runner = vi.hoisted(() => ({
	spawns: [] as Array<{ command: string; args: string[]; cwd: string }>,
	/** Absolute test files whose spawn reports one failing test. */
	failing: new Set<string>(),
}));
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync: vi.fn(
		async (command: string, args: string[], options?: { cwd?: string }) => {
			const testFile = args.find((arg) => /\.(test\.ts|py)$/.test(arg));
			if (testFile === undefined) return { stdout: "", stderr: "", status: 0 };
			runner.spawns.push({ command, args, cwd: options?.cwd ?? "" });
			const failed = runner.failing.has(path.resolve(testFile)) ? 1 : 0;
			return {
				stdout: JSON.stringify({
					numFailedTests: failed,
					numPassedTests: failed ? 0 : 1,
					testResults: failed
						? [
								{
									name: testFile,
									status: "failed",
									assertionResults: [
										{
											status: "failed",
											title: "renders",
											failureMessages: ["expected 1 to be 2"],
											location: { line: 12, column: 1 },
										},
									],
								},
							]
						: [],
				}),
				stderr: "",
				status: failed ? 1 : 0,
			};
		},
	),
}));
vi.mock("../../clients/sessionstart-logger.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/sessionstart-logger.js")
	>()),
	logSessionStart: vi.fn(),
}));

import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { _resetInstanceRegistryEnabledForTests } from "../../clients/instance-registry.js";
import { KnipClient } from "../../clients/knip-client.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import { peekTestFindings } from "../../clients/runtime-context.js";
import {
	isExcludedTestTarget,
	RUNNERS,
	TestRunnerClient,
} from "../../clients/test-runner-client.js";
import {
	clearLatencyLog,
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import { gitExecFileSync } from "../support/git-fixture-env.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

const SESSION = "test-root-session";

let env: ReturnType<typeof setupTestEnvironment>;
let runtime: RuntimeCoordinator;
let cacheManager: CacheManager;
let client: TestRunnerClient;
let main: string;
/** The session cwd the turn runs under: `main`, or a spelling of it for the cases that need one. */
let session: string;
let dbgLines: string[];
let dbgWaiters: Array<{ pattern: RegExp; resolve: () => void }>;
let runCalls: { mock: { results: Array<{ value: unknown }> } };

function git(cwd: string, ...args: string[]): void {
	gitExecFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function write(dir: string, relative: string, content: string): string {
	const file = path.join(dir, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

/**
 * The runner shim a checkout owns: `resolveExec` prefers
 * `<root>/node_modules/.bin/vitest`, so which shim a spawn names is which
 * checkout's own `node_modules` resolved the runner.
 */
function installRunnerShim(root: string): string {
	const bin = path.join(root, "node_modules", ".bin");
	fs.mkdirSync(bin, { recursive: true });
	const shim = path.join(bin, "vitest");
	fs.writeFileSync(shim, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(shim, 0o755);
	return shim;
}

/** A real repository: a vitest config, a source file and its companion test. `.worktrees/` is NOT ignored (the plegma shape). */
function initRepo(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "t");
	write(dir, "package.json", '{"name":"fixture","version":"1.0.0"}\n');
	write(dir, "vitest.config.ts", "export default {};\n");
	write(dir, "src/widget.ts", "export const widget = 1;\n");
	write(dir, "tests/widget.test.ts", "export {};\n");
	write(dir, "tests/unit/self.test.ts", "export {};\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "init");
	installRunnerShim(dir);
}

function addWorktree(
	name: string,
	options: { install?: boolean } = {},
): string {
	const dir = path.join(main, ".worktrees", name);
	git(main, "worktree", "add", "-q", "-b", name, dir);
	if (options.install !== false) installRunnerShim(dir);
	return dir;
}

function dbg(line: string): void {
	dbgLines.push(line);
	for (const waiter of dbgWaiters)
		if (waiter.pattern.test(line)) waiter.resolve();
}

/** Resolves when the turn has logged a line matching `pattern` (no timers: the turn's own log is the signal). */
function dbgSeen(pattern: RegExp): Promise<void> {
	if (dbgLines.some((line) => pattern.test(line))) return Promise.resolve();
	return new Promise((resolve) => dbgWaiters.push({ pattern, resolve }));
}

/** The agent wrote `file`: the worklist row turn_end reads, plus the runtime's own seq bump. */
function edit(file: string): void {
	runtime.recordProjectMutation({ filePath: file, source: "agent-edit" });
	cacheManager.addModifiedRange(
		file,
		{ start: 1, end: 1 },
		false,
		session,
		SESSION,
	);
}

async function turnEnd(): Promise<void> {
	await handleTurnEnd({
		ctxCwd: session,
		getFlag: () => false,
		dbg,
		runtime,
		cacheManager,
		knipClient: new KnipClient(false),
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: client,
		resetLSPService: () => {},
		resetFormatService: () => {},
	} as unknown as Parameters<typeof handleTurnEnd>[0]);
}

/**
 * The turn's test batch is fired without being awaited. Its runner promises are
 * the production `runTestFileAsync` calls (spied, not replaced), so awaiting
 * them is awaiting the real runs: the process boundary is already settled, and
 * the failed-target record is written inside each call before it resolves.
 */
async function batchSettled(spawnCount: number): Promise<void> {
	// The pool dispatches the next target when one settles, so keep awaiting
	// until no call is left that this snapshot has not seen.
	let seen = 0;
	while (seen < runCalls.mock.results.length) {
		seen = runCalls.mock.results.length;
		await Promise.allSettled(
			runCalls.mock.results.map((call) => call.value as Promise<unknown>),
		);
	}
	expect(runner.spawns).toHaveLength(spawnCount);
}

function spawned(): Array<{ cwd: string; file: string; command: string }> {
	return runner.spawns.map((spawn) => ({
		cwd: fs.realpathSync.native(spawn.cwd),
		file: fs.realpathSync.native(
			spawn.args.find((arg) => /\.(test\.ts|py)$/.test(arg)) as string,
		),
		command: spawn.command,
	}));
}

function real(p: string): string {
	return fs.realpathSync.native(p);
}

/** The durable `test-target-foreign-checkout` rows (metadata is only on the log, not the in-memory summary). */
async function foreignRows(): Promise<Array<Record<string, unknown>>> {
	await flushLatencyLog();
	const log = fs.existsSync(getLatencyLogPath())
		? fs.readFileSync(getLatencyLogPath(), "utf8")
		: "";
	return log
		.split("\n")
		.filter((line) => line.includes('"kind":"test-target-foreign-checkout"'))
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeAll(() => {
	vi.stubEnv("PI_LENS_INSTANCE_REGISTRY", "0");
	_resetInstanceRegistryEnabledForTests();
});
afterAll(async () => {
	await flushLatencyLog();
	removeTempDirSync(logHome);
	vi.unstubAllEnvs();
	_resetInstanceRegistryEnabledForTests();
});

beforeEach(async () => {
	resetDegradationLedger();
	clearLatencyLog();
	await flushLatencyLog();
	runner.spawns.length = 0;
	runner.failing.clear();
	dbgLines = [];
	dbgWaiters = [];
	env = setupTestEnvironment("pi-lens-3871-test-root-");
	vi.stubEnv("PI_LENS_HOME", path.join(env.tmpDir, "machine"));
	vi.stubEnv("PI_LENS_TEST_MODE", "0");
	vi.stubEnv("VIRTUAL_ENV", "");
	vi.stubEnv("CONDA_PREFIX", "");
	vi.stubEnv("UV_PROJECT_ENVIRONMENT", "");
	main = path.join(env.tmpDir, "main");
	session = main;
	initRepo(main);
	runtime = new RuntimeCoordinator();
	runtime.projectRoot = main;
	runtime.setTelemetryIdentity({ sessionId: SESSION });
	cacheManager = new CacheManager(false);
	client = new TestRunnerClient(false);
	runCalls = vi.spyOn(client, "runTestFileAsync");
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.stubEnv("PI_LENS_INSTANCE_REGISTRY", "0");
	vi.stubEnv("PI_LENS_HOME", logHome);
	env.cleanup();
});

describe("#3871 test root: the checkout that owns the edit", () => {
	it("runs a linked worktree's edited test in that worktree, with its own runner install", async () => {
		const x = addWorktree("x");
		const xTest = path.join(x, "tests", "unit", "self.test.ts");
		edit(xTest);

		await turnEnd();
		await batchSettled(1);

		expect(spawned()).toEqual([
			{
				cwd: real(x),
				file: real(xTest),
				command: path.join(real(x), "node_modules", ".bin", "vitest"),
			},
		]);
	});

	it("selects a worktree source's own companion, never the session checkout's same-named test", async () => {
		// main has tests/widget.test.ts too: resolving against the session cwd
		// would run THAT file for an edit in x.
		const x = addWorktree("x");
		edit(path.join(x, "src", "widget.ts"));

		await turnEnd();
		await batchSettled(1);

		expect(spawned().map((spawn) => spawn.file)).toEqual([
			real(path.join(x, "tests", "widget.test.ts")),
		]);
		expect(spawned()[0]?.cwd).toBe(real(x));
	});

	it("leaves an edit in the session checkout exactly as before", async () => {
		addWorktree("x");
		const mainTest = path.join(main, "tests", "unit", "self.test.ts");
		edit(mainTest);

		await turnEnd();
		await batchSettled(1);

		expect(spawned()).toEqual([
			{
				cwd: real(main),
				file: real(mainTest),
				command: path.join(real(main), "node_modules", ".bin", "vitest"),
			},
		]);
	});

	it("runs each edited checkout's tests in its own root in one turn", async () => {
		const x = addWorktree("x");
		const y = addWorktree("y");
		edit(path.join(main, "tests", "unit", "self.test.ts"));
		edit(path.join(x, "tests", "unit", "self.test.ts"));
		edit(path.join(y, "tests", "unit", "self.test.ts"));

		await turnEnd();
		await batchSettled(3);

		const byRoot = new Map(spawned().map((spawn) => [spawn.cwd, spawn.file]));
		expect(byRoot.get(real(main))).toBe(
			real(path.join(main, "tests", "unit", "self.test.ts")),
		);
		expect(byRoot.get(real(x))).toBe(
			real(path.join(x, "tests", "unit", "self.test.ts")),
		);
		expect(byRoot.get(real(y))).toBe(
			real(path.join(y, "tests", "unit", "self.test.ts")),
		);
	});

	describe("the #3649 failed-first crossover stays closed", () => {
		it("does not replay a failing worktree test for an edit in a sibling worktree or the session checkout", async () => {
			const x = addWorktree("x");
			const y = addWorktree("y");
			const xTest = path.join(x, "tests", "unit", "self.test.ts");
			runner.failing.add(xTest);
			edit(xTest);
			await turnEnd();
			await batchSettled(1);
			expect(spawned().map((spawn) => spawn.file)).toEqual([real(xTest)]);

			// Turn 2: an unrelated source edit in y. x's recorded failure must not
			// be selected for it.
			runner.spawns.length = 0;
			dbgLines.length = 0;
			runtime.beginTurn();
			edit(path.join(y, "src", "widget.ts"));
			await turnEnd();
			await batchSettled(1);
			expect(spawned().map((spawn) => spawn.file)).toEqual([
				real(path.join(y, "tests", "widget.test.ts")),
			]);

			// Turn 3: the session checkout.
			runner.spawns.length = 0;
			dbgLines.length = 0;
			runtime.beginTurn();
			edit(path.join(main, "src", "widget.ts"));
			await turnEnd();
			await batchSettled(1);
			expect(spawned().map((spawn) => spawn.file)).toEqual([
				real(path.join(main, "tests", "widget.test.ts")),
			]);
		});

		it("still replays the worktree's own failure first for the next edit in that worktree", async () => {
			const x = addWorktree("x");
			const xTest = path.join(x, "tests", "unit", "self.test.ts");
			runner.failing.add(xTest);
			edit(xTest);
			await turnEnd();
			await batchSettled(1);

			runner.spawns.length = 0;
			dbgLines.length = 0;
			runtime.beginTurn();
			edit(path.join(x, "src", "widget.ts"));
			await turnEnd();
			await batchSettled(1);

			expect(spawned()).toEqual([
				expect.objectContaining({ cwd: real(x), file: real(xTest) }),
			]);
			expect(dbgLines.join("\n")).toContain("(failed-first)");
		});

		it("rejects a sibling worktree's test against the session root and says it shares the repository", async () => {
			const x = addWorktree("x");
			const xTest = path.join(x, "tests", "unit", "self.test.ts");

			expect(isExcludedTestTarget(xTest, main)).toBe(true);
			expect(isExcludedTestTarget(xTest, x)).toBe(false);
			expect(await foreignRows()).toEqual([
				expect.objectContaining({
					metadata: expect.objectContaining({ sameCommonDir: "true" }),
				}),
			]);
		});
	});

	describe("independent checkouts keep today's exclusion", () => {
		it("excludes a nested independent clone's test and records sameCommonDir false", async () => {
			const clone = path.join(main, "vendor-clone");
			initRepo(clone);
			edit(path.join(clone, "tests", "unit", "self.test.ts"));

			await turnEnd();

			expect(runner.spawns).toEqual([]);
			expect(await foreignRows()).toEqual([
				expect.objectContaining({
					metadata: expect.objectContaining({ sameCommonDir: "false" }),
				}),
			]);
		});

		it("excludes a submodule's test and records sameCommonDir false", async () => {
			const upstream = path.join(env.tmpDir, "upstream");
			initRepo(upstream);
			git(
				main,
				"-c",
				"protocol.file.allow=always",
				"submodule",
				"add",
				"-q",
				upstream,
				"sub",
			);
			installRunnerShim(path.join(main, "sub"));
			edit(path.join(main, "sub", "tests", "unit", "self.test.ts"));

			await turnEnd();

			expect(runner.spawns).toEqual([]);
			expect(await foreignRows()).toEqual([
				expect.objectContaining({
					metadata: expect.objectContaining({ sameCommonDir: "false" }),
				}),
			]);
		});
	});

	describe("no per-turn root cap", () => {
		// Recurrence prevented (#3871 r2 review F3): a cap of 3 linked worktrees
		// saved about 0.2 ms per root (spawns are already capped at 12) and
		// silently dropped the fourth worktree's tests.
		it("runs the tests of every edited worktree, however many", async () => {
			const worktrees = ["w1", "w2", "w3", "w4", "w5"].map((name) =>
				addWorktree(name),
			);
			for (const dir of worktrees)
				edit(path.join(dir, "tests", "unit", "self.test.ts"));

			await turnEnd();
			await batchSettled(worktrees.length);

			expect(
				spawned()
					.map((spawn) => spawn.cwd)
					.sort(),
			).toEqual(worktrees.map((dir) => real(dir)).sort());
		});

		it("lets a fresh edit in a fourth worktree run beside three carried targets", async () => {
			const carried = ["w1", "w2", "w3"].map((name) => addWorktree(name));
			const fresh = addWorktree("w4");
			cacheManager.writeCache(
				"test-runner-findings",
				{
					content: "deferred",
					deferredTargets: carried.map((dir) => ({
						testFile: path.join(dir, "tests", "unit", "self.test.ts"),
						runner: "vitest",
						attempts: 1,
						sessionId: runtime.telemetrySessionId,
					})),
				},
				main,
			);
			edit(path.join(fresh, "tests", "unit", "self.test.ts"));

			await turnEnd();
			await batchSettled(4);

			expect(
				spawned()
					.map((spawn) => spawn.cwd)
					.sort(),
			).toEqual([...carried, fresh].map((dir) => real(dir)).sort());
		});
	});

	describe("a failure is located relative to the session checkout", () => {
		// Recurrence prevented (#3871 r2 review F1): the failure's location was
		// rendered against the worktree root (`at tests/unit/self.test.ts:12`)
		// into a session whose own checkout holds a file at that path.
		it("delivers a worktree failure located under .worktrees/x, not at the worktree-relative path", async () => {
			const x = addWorktree("x");
			const xTest = path.join(x, "tests", "unit", "self.test.ts");
			runner.failing.add(xTest);
			edit(xTest);

			await turnEnd();
			await dbgSeen(/failure\(s\) cached for pull diagnostics/);

			expect(
				fs.existsSync(path.join(main, "tests", "unit", "self.test.ts")),
			).toBe(true);
			const delivered = peekTestFindings(cacheManager, main, runtime, true);
			expect(JSON.stringify(delivered)).toContain(
				"at .worktrees/x/tests/unit/self.test.ts:12",
			);
		});

		it("keeps a session-checkout failure's location as it was", async () => {
			const mainTest = path.join(main, "tests", "unit", "self.test.ts");
			runner.failing.add(mainTest);
			edit(mainTest);

			await turnEnd();
			await dbgSeen(/failure\(s\) cached for pull diagnostics/);

			expect(
				JSON.stringify(peekTestFindings(cacheManager, main, runtime, true)),
			).toContain("at tests/unit/self.test.ts:12");
		});
	});

	describe("a worktree without its own runner install", () => {
		// Recurrence prevented (#3871 r2 review F2): a fresh worktree has the
		// committed vitest config but no node_modules or venv, so the run fell
		// through to `npx vitest` (a 13 s fetch of an unpinned vitest) or a bare
		// `python`, in an environment the worktree never installed.
		const skipRows = () =>
			getDegradationSummary().find(
				(group) => group.kind === "turn-end-test-root-skipped",
			);

		it("starts no process, counts the skip, and publishes no clean run", async () => {
			const bare = addWorktree("bare", { install: false });
			edit(path.join(bare, "tests", "unit", "self.test.ts"));

			await turnEnd();
			await dbgSeen(/no-runner-install/);

			expect(runner.spawns).toEqual([]);
			expect(skipRows()?.count).toBe(1);
			expect(JSON.stringify(skipRows())).toContain("no-runner-install");
			expect(JSON.stringify(skipRows())).toContain(".worktrees/bare");
			expect(
				cacheManager.readCache("test-runner-findings", main)?.data,
			).not.toEqual(expect.objectContaining({ results: expect.anything() }));
		});

		it("still runs the installed worktree beside the bare one", async () => {
			const bare = addWorktree("bare", { install: false });
			const x = addWorktree("x");
			edit(path.join(bare, "tests", "unit", "self.test.ts"));
			edit(path.join(x, "tests", "unit", "self.test.ts"));

			await turnEnd();
			await dbgSeen(/no-runner-install/);
			await batchSettled(1);

			expect(spawned().map((spawn) => spawn.cwd)).toEqual([real(x)]);
		});

		it("leaves the session checkout its fallbacks", async () => {
			fs.rmSync(path.join(main, "node_modules"), { recursive: true });
			const mainTest = path.join(main, "tests", "unit", "self.test.ts");
			edit(mainTest);

			await turnEnd();
			await batchSettled(1);

			expect(runner.spawns[0]?.command).toBe("npx");
			expect(skipRows()).toBeUndefined();
		});

		it("resolves a worktree's python from its own venv, and refuses without one (pytest)", async () => {
			const x = addWorktree("x", { install: false });
			const test = write(x, "tests/test_widget.py", "def test_a(): pass\n");
			const run = () =>
				client.runTestFileAsync(test, x, {
					runner: "pytest",
					config: RUNNERS.pytest,
					requireOwnInstall: true,
				});

			expect((await run()).notRun).toBe("no-runner-install");
			expect(runner.spawns).toEqual([]);

			const python = path.join(x, ".venv", "bin", "python");
			write(x, path.join(".venv", "bin", "python"), "#!/bin/sh\nexit 0\n");
			fs.chmodSync(python, 0o755);
			expect((await run()).notRun).toBeUndefined();
			expect(runner.spawns.map((spawn) => spawn.command)).toEqual([python]);
		});
	});

	describe("ownership resolution", () => {
		it("keeps a worktree's failure through a turn in a sibling worktree", async () => {
			// Recurrence prevented: the failed-first state keyed by one root for every
			// checkout. With a shared key the sibling turn retires x's entry as foreign
			// and x's next edit loses its replay.
			const x = addWorktree("x");
			const y = addWorktree("y");
			const xTest = path.join(x, "tests", "unit", "self.test.ts");
			runner.failing.add(xTest);
			edit(xTest);
			await turnEnd();
			await batchSettled(1);

			runner.spawns.length = 0;
			dbgLines.length = 0;
			runtime.beginTurn();
			edit(path.join(y, "src", "widget.ts"));
			await turnEnd();
			await batchSettled(1);

			runner.spawns.length = 0;
			dbgLines.length = 0;
			runtime.beginTurn();
			edit(path.join(x, "src", "widget.ts"));
			await turnEnd();
			await batchSettled(1);

			expect(spawned()).toEqual([
				expect.objectContaining({ cwd: real(x), file: real(xTest) }),
			]);
			expect(dbgLines.join("\n")).toContain("(failed-first)");
		});

		it("runs two tests edited in the same worktree directory", async () => {
			// Recurrence prevented: the per-directory owner memo answering the
			// session root for the second file of a directory.
			const x = addWorktree("x");
			const other = write(x, "tests/unit/other.test.ts", "export {};\n");
			edit(path.join(x, "tests", "unit", "self.test.ts"));
			edit(other);

			await turnEnd();
			await batchSettled(2);

			expect(spawned().map((spawn) => spawn.cwd)).toEqual([real(x), real(x)]);
		});

		it("names a worktree test relative to a symlinked session cwd", async () => {
			// Recurrence prevented (#3893 r3 spelling): a root in its canonical
			// spelling renders the target as `../main/.worktrees/...` against the
			// session's own spelling.
			const x = addWorktree("x");
			const alias = path.join(env.tmpDir, "alias");
			fs.symlinkSync(
				main,
				alias,
				process.platform === "win32" ? "junction" : "dir",
			);
			session = alias;
			runtime.projectRoot = alias;
			edit(path.join(alias, ".worktrees", "x", "src", "widget.ts"));

			await turnEnd();
			await batchSettled(1);

			expect(dbgLines.join("\n")).toContain(
				"test vitest .worktrees/x/tests/widget.test.ts (related)",
			);
			expect(spawned()[0]?.cwd).toBe(real(x));
		});

		it("excludes a nested repository's test in a session that is not a checkout", async () => {
			// Recurrence prevented: a session cwd outside any git checkout (the
			// AGENTS.md by-design case) crashed owner resolution with a TypeError.
			const folder = path.join(env.tmpDir, "plain");
			const repo = path.join(folder, "repo");
			initRepo(repo);
			session = folder;
			runtime.projectRoot = folder;
			edit(path.join(repo, "tests", "unit", "self.test.ts"));

			await expect(turnEnd()).resolves.toBeUndefined();

			expect(runner.spawns).toEqual([]);
			expect(await foreignRows()).toEqual([
				expect.objectContaining({
					metadata: expect.objectContaining({ sameCommonDir: "false" }),
				}),
			]);
		});
	});

	describe("a carried deferred target", () => {
		it("re-runs in the linked worktree that owns it", async () => {
			const x = addWorktree("x");
			const xTest = path.join(x, "tests", "unit", "self.test.ts");
			cacheManager.writeCache(
				"test-runner-findings",
				{
					content: "deferred",
					deferredTargets: [
						{
							testFile: xTest,
							runner: "vitest",
							attempts: 1,
							sessionId: runtime.telemetrySessionId,
						},
					],
				},
				main,
			);
			// An edit with no companion test: the carried target is the only work.
			write(main, "src/lonely.ts", "export const lonely = 1;\n");
			edit(path.join(main, "src", "lonely.ts"));

			await turnEnd();
			await batchSettled(1);

			expect(spawned()).toEqual([
				expect.objectContaining({
					cwd: real(x),
					file: real(xTest),
					command: path.join(real(x), "node_modules", ".bin", "vitest"),
				}),
			]);
		});
	});
});
