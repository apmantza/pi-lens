// flake-shape: raw-timer-wait — the subject IS the wall-clock batch bound (budgetMs) racing real settle latency; the 25 ms post-abort resolves model safeSpawnAsync settling on the child's exit event after the kill, and delay(400)/delay(250) prove a run can outlive the batch close — fake timers would collapse the very ordering the assertions discriminate (#2522 R3 F4, #2528 R4 P3c).
/**
 * #2504 AC2 — the turn-end test-runner fan-out must be bounded.
 *
 * The reported turn fired 59 concurrent `vitest.cmd` spawns from a single
 * `Promise.allSettled(targets.map(runTestFileAsync))`: no concurrency cap, no
 * batch-wide wall budget, no target-count cap, and 9 of the targets pointed at
 * test files deleted from the repo long ago (each one spawned a runner only to
 * come back "Test file not found"). The event loop starved
 * (`cpuCoverageRatio 0.56`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// The latency writer captures its path through these production imports.
// Own it before import, independently of the per-case project/machine homes.
const logHome = await vi.hoisted(async () => {
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const home = mkdtempSync(join(tmpdir(), "pi-lens-runner-bounds-log-"));
	vi.stubEnv("PI_LENS_HOME", home);
	return home;
});

import {
	CacheManager,
	MCP_TURN_STATE_OWNER_ID,
} from "../../clients/cache-manager.js";
import { DependencyChecker } from "../../clients/dependency-checker.js";
import { KnipClient } from "../../clients/knip-client.js";
import { mergeGitGuardTestFailure } from "../../clients/git-guard.js";
import { setAmbientAbortSignal } from "../../clients/safe-spawn.js";
import { TestRunnerClient } from "../../clients/test-runner-client.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	clearLatencyLog,
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import { peekTestFindings } from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	TEST_RUNNER_BATCH_BUDGET_MS,
	TEST_RUNNER_BATCH_CONCURRENCY,
	TEST_RUNNER_MAX_DEFERRALS,
	TEST_RUNNER_MAX_PERSISTED_TARGETS,
	TEST_RUNNER_MAX_TARGETS,
	handleTurnEnd,
	runTestTargetsBounded,
} from "../../clients/runtime-turn.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

const SOURCE_COUNT = 20;
/**
 * Sources whose conventional test companion does NOT exist on disk.
 *
 * They are the FIRST sources in the worklist, deliberately (#2504 review
 * round 2, F4). Placed last — past `TEST_RUNNER_MAX_TARGETS` — the existsSync
 * guard was untestable: deleting it left those sources to be dropped by the
 * target-count cap instead, so `ran` still held no missing file and the
 * assertion below stayed green over the deleted guard. Ahead of the cap
 * boundary, deleting the guard puts them straight into the fired batch.
 */
const MISSING_TEST_COMPANIONS = 3;

let env: { tmpDir: string; cleanup: () => void };

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-2504-runner-");
	resetDegradationLedger();
});

afterEach(() => {
	env.cleanup();
	resetDegradationLedger();
});
afterAll(async () => {
	await flushLatencyLog();
	vi.unstubAllEnvs();
	removeTempDirSync(logHome);
});

it("keeps the captured latency sink private after per-case home changes", () => {
	// #3644: the parent-companion witness's late pin did not isolate its clear.
	vi.stubEnv("PI_LENS_HOME", path.join(env.tmpDir, "machine"));
	try {
		expect(getLatencyLogPath()).toBe(path.join(logHome, "latency.log"));
	} finally {
		vi.unstubAllEnvs();
	}
});

const delay = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

describe("#2504 AC2 — bounded test-runner batch helper", () => {
	it("never exceeds the concurrency cap", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		await runTestTargetsBounded({
			targets: Array.from({ length: 24 }, (_, i) => `t${i}`),
			concurrency: 4,
			budgetMs: 60_000,
			run: async () => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await delay(5);
				inFlight -= 1;
				return "ok";
			},
		});
		expect(maxInFlight).toBeLessThanOrEqual(4);
	});

	it("stops dispatching once the batch wall budget is spent", async () => {
		let started = 0;
		const outcome = await runTestTargetsBounded({
			targets: Array.from({ length: 40 }, (_, i) => `t${i}`),
			concurrency: 2,
			budgetMs: 40,
			run: async () => {
				started += 1;
				await delay(15);
				return "ok";
			},
		});
		expect(started).toBeLessThan(40);
		expect(outcome.deferred.length).toBeGreaterThan(0);
		expect(outcome.stopReason).toBe("budget");
	});

	/**
	 * #2522 review round 3 F4, re-founded in round 4 (I4) — "the batch closed"
	 * is not "the target was cut", and the answer must not depend on macrotask
	 * ordering.
	 *
	 * A target that produced a real value BEFORE the bound fired must keep its
	 * result and take no attempt toward `TEST_RUNNER_MAX_DEFERRALS`; otherwise a
	 * suite that keeps finishing inside the budget is eventually retired as "too
	 * slow". Round 3 got this by draining the queue with a `setImmediate` hop —
	 * which is exactly the ordering dependence that then misclassified a spawn
	 * aborted before it started (P3c). Round 4 stamps the answer in the `.then`
	 * attached at dispatch instead.
	 *
	 * The close is tripped the way production trips it — from a TIMER, i.e. a
	 * macrotask strictly after this value exists — not synchronously from inside
	 * `run`, which no spawn can do.
	 */
	it("keeps the result of a target that finished before the bound fired", async () => {
		const controller = new AbortController();
		const outcome = await runTestTargetsBounded({
			targets: ["already-done", "still-running"],
			concurrency: 1,
			budgetMs: 60_000,
			signal: controller.signal,
			run: async (target: string) => {
				if (target === "already-done") {
					setTimeout(() => controller.abort(), 0);
					return `${target}-value`;
				}
				// Not abort-aware, exactly like a spawn that has not noticed the kill
				// yet: it can only settle long after the close.
				await delay(400);
				return `${target}-value`;
			},
		});

		expect(outcome.stopReason).toBe("abort");
		// The finished target's result is kept...
		expect(outcome.results).toEqual([
			{ status: "fulfilled", value: "already-done-value" },
		]);
		// ...and it is NOT counted as a cut, so it takes no attempt. Only the
		// target that had not produced anything when the bound fired is deferred.
		expect(outcome.deferred).toEqual(["still-running"]);
	});

	/**
	 * #2522 review round 4, P3c — abort BEFORE the spawn.
	 *
	 * `safeSpawnAsync` resolves SYNCHRONOUSLY when the signal it is handed is
	 * already aborted, and `test-runner-client.ts` `await`s `resolveExec` before
	 * it ever reaches the spawn. So a target dispatched just before the bound
	 * comes back as a FULFILLED runner-error value — "Spawn aborted before
	 * start" — describing work that never happened. Round 3's queue hop folded
	 * exactly that value back into `results`, so the target counted as a
	 * completed run, was never deferred, and never ran.
	 *
	 * The double is production-faithful on the axis under test: it awaits (as
	 * `resolveExec` does) and then honours an already-aborted signal by
	 * resolving with the runner-error shape. The shape itself is pinned against
	 * the REAL client in `test-runner-client.test.ts`.
	 */
	it("defers a target whose spawn was aborted before it started", async () => {
		const outcome = await runTestTargetsBounded({
			targets: ["aborted-pre-spawn", "still-running"],
			concurrency: 2,
			budgetMs: 30,
			run: async (target: string, batchSignal: AbortSignal) => {
				if (target === "aborted-pre-spawn") {
					// `runTestFileAsync` awaits `resolveExec` and only THEN reaches
					// `safeSpawnAsync`, whose early-abort branch resolves
					// SYNCHRONOUSLY, with no child spawned at all. Arriving there just
					// as the batch aborts is exactly this: the value appears in the
					// microtask drain that follows the close, describing work that
					// never happened. (This is deliberately NOT the killed-spawn
					// shape, which settles later on the child's `exit` event — that
					// one is `killableClient`/the F1 tests.)
					await new Promise<void>((resolve) => {
						if (batchSignal.aborted) return resolve();
						batchSignal.addEventListener("abort", () => resolve(), {
							once: true,
						});
					});
					return {
						file: target,
						runner: "vitest",
						passed: 0,
						failed: 0,
						error: "Runner error: Spawn aborted before start",
					};
				}
				await delay(400);
				return { file: target, runner: "vitest", passed: 1, failed: 0 };
			},
		});

		expect(outcome.stopReason).toBe("budget");
		// A value produced only because the batch was cut is not a result.
		expect(outcome.results).toHaveLength(0);
		expect(outcome.deferred).toEqual(["aborted-pre-spawn", "still-running"]);
	});

	it("stops dispatching when the ambient abort signal fires", async () => {
		const controller = new AbortController();
		let started = 0;
		const outcome = await runTestTargetsBounded({
			targets: Array.from({ length: 40 }, (_, i) => `t${i}`),
			concurrency: 2,
			budgetMs: 60_000,
			signal: controller.signal,
			run: async () => {
				started += 1;
				if (started === 4) controller.abort();
				await delay(5);
				return "ok";
			},
		});
		expect(started).toBeLessThan(40);
		expect(outcome.deferred.length).toBeGreaterThan(0);
		expect(outcome.stopReason).toBe("abort");
	});

	it("returns a settled result per dispatched target and survives a rejection", async () => {
		const outcome = await runTestTargetsBounded({
			targets: ["a", "b", "c"],
			concurrency: 2,
			budgetMs: 60_000,
			run: async (t: string) => {
				if (t === "b") throw new Error("boom");
				return t;
			},
		});
		expect(outcome.results).toHaveLength(3);
		expect(outcome.results.filter((r) => r.status === "rejected")).toHaveLength(
			1,
		);
		expect(outcome.deferred).toHaveLength(0);
	});
});

describe("#2504 AC2 — turn_end wires the bounds into the real fan-out", () => {
	it("caps concurrency, caps the target count, and never spawns for a missing test file", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);

		fs.mkdirSync(path.join(env.tmpDir, "src"), { recursive: true });
		for (let i = 0; i < SOURCE_COUNT; i++) {
			fs.writeFileSync(
				path.join(env.tmpDir, "src", `f${i}.ts`),
				`export const v${i} = ${i};\n`,
			);
			// The FIRST N sources deliberately have NO test file on disk — see
			// MISSING_TEST_COMPANIONS. Everything after them does, so the
			// target-count cap is still reached and still exercised.
			if (i >= MISSING_TEST_COMPANIONS) {
				fs.writeFileSync(
					path.join(env.tmpDir, "src", `f${i}.test.ts`),
					"export {};\n",
				);
			}
			cacheManager.addModifiedRange(
				path.join(env.tmpDir, "src", `f${i}.ts`),
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				runtime.telemetrySessionId,
			);
		}

		let inFlight = 0;
		let maxInFlight = 0;
		let completed = 0;
		const ran: string[] = [];
		const testRunnerClient = {
			getTestRunTarget: (abs: string) => ({
				testFile: abs.replace(/\.ts$/, ".test.ts"),
				runner: "vitest",
				config: undefined,
				strategy: "self",
			}),
			runTestFileAsync: async (testFile: string) => {
				ran.push(testFile);
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await delay(15);
				inFlight -= 1;
				completed += 1;
				return {
					file: testFile,
					runner: "vitest",
					passed: 1,
					failed: 0,
					duration: 1,
				};
			},
			formatResult: () => "",
		};

		await handleTurnEnd({
			ctxCwd: env.tmpDir,
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager,
			knipClient: {
				ensureAvailable: async () => false,
				analyze: async () => EMPTY_KNIP_RESULT,
			},
			deadCodeClients: [],
			depChecker: { ensureAvailable: async () => false },
			testRunnerClient,
			resetLSPService: () => {},
			resetFormatService: () => {},
			// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		} as any);

		// The fan-out is deliberately fire-and-forget; wait for it to settle.
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && (completed === 0 || inFlight > 0)) {
			await delay(20);
		}

		// Literals, not the constants — this assertion has to go red on
		// pre-fix code for the BUG's reason (unbounded fan-out), not because a
		// not-yet-exported constant is `undefined`.
		expect(ran.length).toBeGreaterThan(0);
		expect(maxInFlight).toBeLessThanOrEqual(4);
		expect(ran.length).toBeLessThanOrEqual(12);
		expect(maxInFlight).toBeLessThanOrEqual(TEST_RUNNER_BATCH_CONCURRENCY);
		expect(ran.length).toBeLessThanOrEqual(TEST_RUNNER_MAX_TARGETS);
		for (const testFile of ran) {
			expect(fs.existsSync(testFile)).toBe(true);
		}
		// Named, so a failure says WHICH guard broke rather than only that some
		// nonexistent file was spawned for. These three sit ahead of the
		// target-count cap, so only the existsSync guard can keep them out.
		for (let i = 0; i < MISSING_TEST_COMPANIONS; i++) {
			expect(ran.some((f) => f.endsWith(`f${i}.test.ts`))).toBe(false);
		}
		// The cap is genuinely reached even after the missing companions are
		// dropped, so this case still covers both bounds at once.
		expect(ran.length).toBe(TEST_RUNNER_MAX_TARGETS);
	});
});

/**
 * #2522: the real turn-end candidate loop (`runtime-turn.ts`) must never
 * fire a resolved target under the built-in integration/e2e exclusion list,
 * regardless of which strategy (failed-first/related/self) resolved it —
 * reproduced through the real `handleTurnEnd` selection loop, not a
 * hand-fed input shaped to hit the guard.
 */
describe("#2522 AC1 — turn_end selection excludes integration/e2e targets", () => {
	it("never spawns a target resolved under tests/integration/, and dbg reports the exclusion without guessing its cause", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);

		fs.mkdirSync(path.join(env.tmpDir, "src"), { recursive: true });
		fs.mkdirSync(path.join(env.tmpDir, "tests", "integration"), {
			recursive: true,
		});
		const source = path.join(env.tmpDir, "src", "delegate.ts");
		fs.writeFileSync(source, "export const delegate = 1;\n");
		const integrationTest = path.join(
			env.tmpDir,
			"tests",
			"integration",
			"opencode-delegate.test.ts",
		);
		fs.writeFileSync(integrationTest, "export {};\n");
		cacheManager.addModifiedRange(
			source,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			runtime.telemetrySessionId,
		);

		const ran: string[] = [];
		const dbgLines: string[] = [];
		const testRunnerClient = {
			// Mirrors the reported turn: whichever strategy resolved it, the
			// candidate's OWN test file lands under tests/integration/.
			getTestRunTarget: () => ({
				testFile: integrationTest,
				runner: "vitest",
				config: undefined,
				strategy: "related",
			}),
			runTestFileAsync: async (testFile: string) => {
				ran.push(testFile);
				return {
					file: testFile,
					runner: "vitest",
					passed: 1,
					failed: 0,
					duration: 1,
				};
			},
			formatResult: () => "",
		};

		await handleTurnEnd({
			ctxCwd: env.tmpDir,
			getFlag: () => false,
			dbg: (msg: string) => dbgLines.push(msg),
			runtime,
			cacheManager,
			knipClient: {
				ensureAvailable: async () => false,
				analyze: async () => EMPTY_KNIP_RESULT,
			},
			deadCodeClients: [],
			depChecker: { ensureAvailable: async () => false },
			testRunnerClient,
			resetLSPService: () => {},
			resetFormatService: () => {},
			// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		} as any);

		// The fan-out is fire-and-forget; give it a beat, then assert nothing
		// was ever dispatched (there's only one candidate, and it's excluded).
		await delay(200);

		expect(ran).toHaveLength(0);
		expect(dbgLines).toContainEqual(
			expect.stringContaining(
				`test target excluded by the built-in turn-end policy, skipping spawn (${path.relative(env.tmpDir, integrationTest)})`,
			),
		);
	});

	it("reports a nested worktree exclusion without mislabelling it integration/e2e", async () => {
		// Regression: the turn-end gate now excludes a nested Git checkout as
		// well as integration/e2e suites; its debug record must not invent a reason.
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		fs.writeFileSync(
			path.join(env.tmpDir, "vitest.config.ts"),
			"export default {};\n",
		);
		const worktree = path.join(env.tmpDir, ".worktrees", "other");
		fs.mkdirSync(worktree, { recursive: true });
		fs.writeFileSync(
			path.join(worktree, ".git"),
			"gitdir: /git/worktrees/other\n",
		);
		const nestedTest = path.join(worktree, "tests", "other.test.ts");
		fs.mkdirSync(path.dirname(nestedTest));
		fs.writeFileSync(nestedTest, "export {};\n");
		cacheManager.addModifiedRange(
			nestedTest,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			runtime.telemetrySessionId,
		);

		const realClient = new TestRunnerClient(false);
		expect(realClient.getTestRunTarget(nestedTest, env.tmpDir)?.strategy).toBe(
			"self",
		);
		// Keep typed real clients; only replace the external test execution. This
		// fixture has no package.json/knip config, and the madge flag is disabled.
		const run = vi.spyOn(realClient, "runTestFileAsync").mockResolvedValue({
			file: nestedTest,
			sourceFile: nestedTest,
			runner: "vitest",
			passed: 1,
			failed: 0,
			skipped: 0,
			duration: 1,
			failures: [],
		});
		const dbgLines: string[] = [];
		try {
			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: (msg: string) => dbgLines.push(msg),
				runtime,
				cacheManager,
				knipClient: new KnipClient(false),
				deadCodeClients: [],
				depChecker: new DependencyChecker(false),
				testRunnerClient: realClient,
				resetLSPService: () => {},
				resetFormatService: () => {},
			});

			expect(run).not.toHaveBeenCalled();
			expect(dbgLines).toContainEqual(
				expect.stringContaining(
					"test target excluded by the built-in turn-end policy",
				),
			);
			expect(dbgLines.join("\n")).not.toContain("integration/e2e");
		} finally {
			run.mockRestore();
		}
	});

	it("runs the parent companion when a foreign checkout supplies the first discovery match", async () => {
		// R2: a late veto used to discard the foreign match without recovering
		// its parent alternative. Enter through real turn-end selection and state.
		// Pin per-case state before construction; the log sink was pinned at import.
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		vi.stubEnv("PI_LENS_HOME", path.join(env.tmpDir, "machine"));
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			fs.mkdirSync(path.join(env.tmpDir, ".git"));
			fs.writeFileSync(
				path.join(env.tmpDir, ".git", "HEAD"),
				"ref: refs/heads/main\n",
			);
			fs.writeFileSync(path.join(env.tmpDir, "pytest.ini"), "[pytest]\n");
			const source = path.join(env.tmpDir, "widget.py");
			fs.writeFileSync(source, "VALUE = 1\n");
			const nested = path.join(env.tmpDir, "tests", "a-checkout");
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(
				path.join(nested, ".git"),
				"gitdir: /git/worktrees/other\n",
			);
			const foreign = path.join(nested, "test_widget.py");
			fs.writeFileSync(foreign, "def test_foreign(): pass\n");
			const parent = path.join(
				env.tmpDir,
				"tests",
				"z-parent",
				"test_widget.py",
			);
			fs.mkdirSync(path.dirname(parent));
			fs.writeFileSync(parent, "def test_parent(): pass\n");
			cacheManager.addModifiedRange(
				source,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				runtime.telemetrySessionId,
			);

			const client = new TestRunnerClient(false);
			expect(client.findTestFile(source, env.tmpDir)?.testFile).toBe(foreign);
			const ran: string[] = [];
			const run = vi
				.spyOn(client, "runTestFileAsync")
				.mockImplementation(async (testFile) => {
					ran.push(testFile);
					return {
						file: testFile,
						sourceFile: source,
						runner: "pytest",
						passed: 1,
						failed: 0,
						skipped: 0,
						duration: 1,
						failures: [],
					};
				});
			// Clear the real, file-owned sink captured before production imports.
			clearLatencyLog();
			try {
				await handleTurnEnd({
					ctxCwd: env.tmpDir,
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager,
					knipClient: new KnipClient(false),
					deadCodeClients: [],
					depChecker: new DependencyChecker(false),
					testRunnerClient: client,
					resetLSPService: () => {},
					resetFormatService: () => {},
				});
				await flushLatencyLog();
				expect(ran).toEqual([parent]);
				expect(fs.readFileSync(getLatencyLogPath(), "utf8")).toContain(
					'"kind":"test-discovery-foreign-checkout"',
				);
			} finally {
				run.mockRestore();
			}
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

/**
 * #2522 AC3: through the REAL `handleTurnEnd` delivery path (not a
 * hand-written cache record), a batch made entirely of RUNNER errors must be
 * persisted and delivered as advisory; a batch containing a genuine failing
 * test must keep the "fix before continuing" framing, unchanged.
 */
describe("#2522 AC3 — delivery framing distinguishes runner errors from real failures", () => {
	it("persists runnerErrorOnly:true and delivers advisory framing for an all-runner-error batch", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);

		fs.mkdirSync(path.join(env.tmpDir, "src"), { recursive: true });
		const source = path.join(env.tmpDir, "src", "widget.ts");
		const testFile = path.join(env.tmpDir, "src", "widget.test.ts");
		fs.writeFileSync(source, "export const widget = 1;\n");
		fs.writeFileSync(testFile, "export {};\n");
		cacheManager.addModifiedRange(
			source,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			runtime.telemetrySessionId,
		);

		let settled = false;
		const testRunnerClient = {
			getTestRunTarget: () => ({
				testFile,
				runner: "vitest",
				config: undefined,
				strategy: "self",
			}),
			runTestFileAsync: async () => {
				settled = true;
				// A runner error: the suite never started (missing provider/
				// binary), so `failed === 0` by construction — mirrors
				// `test-runner-client.ts`'s own `emptyResult` shape.
				return {
					file: testFile,
					sourceFile: source,
					runner: "vitest",
					passed: 0,
					failed: 0,
					error: "spawn opencode ENOENT",
				};
			},
			formatResult: (r: { error?: string }) =>
				`[Tests] ⚠ Could not run tests: ${r.error}`,
		};

		await handleTurnEnd({
			ctxCwd: env.tmpDir,
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager,
			knipClient: {
				ensureAvailable: async () => false,
				analyze: async () => EMPTY_KNIP_RESULT,
			},
			deadCodeClients: [],
			depChecker: { ensureAvailable: async () => false },
			testRunnerClient,
			resetLSPService: () => {},
			resetFormatService: () => {},
			// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		} as any);

		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && !settled) await delay(20);
		// Give the fire-and-forget `.then()` a beat to land the cache write.
		await delay(100);

		const persisted = cacheManager.readCache<{
			content: string;
			runnerErrorOnly?: boolean;
		}>("test-runner-findings", env.tmpDir)?.data;
		expect(persisted?.content).toContain("Could not run tests");
		expect(persisted?.runnerErrorOnly).toBe(true);

		const message =
			peekTestFindings(cacheManager, env.tmpDir, runtime)?.messages[0]
				?.content ?? "";
		expect(message).toContain("advisory");
		expect(message).not.toContain("fix before continuing");
	});

	it("persists runnerErrorOnly:false and keeps the blocking framing for a genuine failure", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);

		fs.mkdirSync(path.join(env.tmpDir, "src"), { recursive: true });
		const source = path.join(env.tmpDir, "src", "widget.ts");
		const testFile = path.join(env.tmpDir, "src", "widget.test.ts");
		fs.writeFileSync(source, "export const widget = 1;\n");
		fs.writeFileSync(testFile, "export {};\n");
		cacheManager.addModifiedRange(
			source,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			runtime.telemetrySessionId,
		);

		let settled = false;
		const testRunnerClient = {
			getTestRunTarget: () => ({
				testFile,
				runner: "vitest",
				config: undefined,
				strategy: "self",
			}),
			runTestFileAsync: async () => {
				settled = true;
				return {
					file: testFile,
					sourceFile: source,
					runner: "vitest",
					passed: 0,
					failed: 1,
					failures: [{ name: "widget works", message: "expected 1 to be 2" }],
				};
			},
			formatResult: () => "[Tests] ✗ 1/1 failed",
		};

		await handleTurnEnd({
			ctxCwd: env.tmpDir,
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager,
			knipClient: {
				ensureAvailable: async () => false,
				analyze: async () => EMPTY_KNIP_RESULT,
			},
			deadCodeClients: [],
			depChecker: { ensureAvailable: async () => false },
			testRunnerClient,
			resetLSPService: () => {},
			resetFormatService: () => {},
			// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		} as any);

		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && !settled) await delay(20);
		await delay(100);

		const persisted = cacheManager.readCache<{
			content: string;
			runnerErrorOnly?: boolean;
		}>("test-runner-findings", env.tmpDir)?.data;
		expect(persisted?.runnerErrorOnly).toBe(false);

		const message =
			peekTestFindings(cacheManager, env.tmpDir, runtime)?.messages[0]
				?.content ?? "";
		expect(message).toContain(
			"Test failures detected last turn — fix before continuing",
		);
	});
});

describe("#2504 AC2 — cap constants", () => {
	// `caps concurrency at 4` was deleted in the #2522 round-4 pass (AGENTS.md
	// "Test assessment and removal"). It restated `TEST_RUNNER_BATCH_CONCURRENCY
	// === 4` and nothing else: changing the constant to 3 reds that case and
	// NOTHING in the whole file, because 4 is a tuning value, not an invariant.
	// The behaviour that matters — the pool never exceeds whatever cap it is
	// handed — is pinned by the named survivor `never exceeds the concurrency
	// cap` at the top of this file, which drives the real
	// `runTestTargetsBounded`. The relation below is different and is kept: it
	// is a premise guard for the fan-out test in this file (the target cap has
	// to bite before the worklist runs out, or that test proves nothing).
	it("caps the per-turn target count", () => {
		expect(TEST_RUNNER_MAX_TARGETS).toBeGreaterThan(0);
		expect(TEST_RUNNER_MAX_TARGETS).toBeLessThan(SOURCE_COUNT);
	});
});

/**
 * #2522 AC2: the batch-wide wall budget must sit well under the turn, and
 * distinct from (well below) the per-target 60s spawn timeout
 * (`test-runner-client.ts`'s `runTestFileAsync`) — reconciled to ONE
 * constant rather than adding a second budget alongside #2509's 90s.
 */
describe("#2522 AC2 — batch wall budget reconciled below the turn", () => {
	it("is well under a turn and well under the 60s per-target timeout", () => {
		expect(TEST_RUNNER_BATCH_BUDGET_MS).toBeLessThanOrEqual(20_000);
		expect(TEST_RUNNER_BATCH_BUDGET_MS).toBeLessThan(60_000);
	});
});

/**
 * #2522 review round 2, F1 — the deferral AC2 promised was never built.
 *
 * `runTestTargetsBounded` returned only a skipped COUNT: the identity of the
 * targets that never produced a result was thrown away, so "deferred to the
 * next turn" was a comment, not a mechanism. Three consequences, all
 * reproduced below through the REAL production path:
 *
 *  - a single target slower than the 20s batch budget yields `results: []` —
 *    no cache record at all, zero output, every turn, forever;
 *  - a PARTIAL batch (>=1 target settled clean, the rest cut at the bound)
 *    fell through to the `results.length > 0` branch and wrote `content: ""`
 *    plus "all tests passed", relaxing the commit gate on the strength of a
 *    batch that never finished;
 *  - the worker pool kept running after the batch returned, so an in-flight
 *    spawn ran to its own 60s timeout and then MUTATED the results array the
 *    caller had already consumed.
 */
describe("#2522 R2 F1 — the batch bound kills in flight and hands back a deferral set", () => {
	it("kills in-flight targets at the wall budget and never mutates results after returning", async () => {
		const abortsSeen: string[] = [];
		const outcome = await runTestTargetsBounded<string, string>({
			targets: ["a", "b", "c", "d", "e", "f"],
			concurrency: 2,
			budgetMs: 60,
			// Production-faithful double: the real `run` hands its target to
			// `runTestFileAsync` -> `safeSpawnAsync`, which kills the child when
			// the signal it was handed aborts. A double that ignored the signal
			// would let an inert fix look green.
			run: async (target, signal) => {
				await new Promise<void>((resolve) => {
					const onAbort = (): void => {
						abortsSeen.push(target);
						// #2522 review round 3, F4: a killed child does NOT settle in
						// the same tick as the abort — `safeSpawnAsync` resolves on the
						// process's `exit` event. Settling synchronously here would
						// claim the target finished in time, which is exactly the case
						// the F4 fold-in is there to tell apart from a cut.
						setTimeout(resolve, 25);
					};
					if (signal.aborted) return onAbort();
					signal.addEventListener("abort", onAbort, { once: true });
				});
				return target;
			},
		});

		expect(outcome.stopReason).toBe("budget");
		// Every target is accounted for: nothing settled, so all six defer.
		expect(outcome.deferred).toHaveLength(6);
		expect(outcome.results).toHaveLength(0);
		// The in-flight pair was actually KILLED, not left to its own timeout.
		expect(abortsSeen.length).toBeGreaterThan(0);

		// The killed runs resolve after the batch has already returned. The
		// consumed results array must not grow under the caller.
		const lengthAtReturn = outcome.results.length;
		await delay(250);
		expect(outcome.results).toHaveLength(lengthAtReturn);
	});

	it("defers a single target that outlives the budget, and returns it by identity", async () => {
		const outcome = await runTestTargetsBounded<{ testFile: string }, string>({
			targets: [{ testFile: "/repo/tests/slow.test.ts" }],
			concurrency: 4,
			budgetMs: 50,
			// Same production-faithful kill latency as above (#2522 R3 F4).
			run: async (_target, signal) =>
				new Promise<string>((resolve) => {
					signal.addEventListener(
						"abort",
						() => setTimeout(() => resolve("killed"), 25),
						{ once: true },
					);
				}),
		});

		expect(outcome.results).toHaveLength(0);
		expect(outcome.deferred.map((t) => t.testFile)).toEqual([
			"/repo/tests/slow.test.ts",
		]);
	});
});

/**
 * #2522 review round 2, F1 — the same defect through the REAL `handleTurnEnd`
 * fan-out and the REAL `test-runner-findings` cache, not the helper in
 * isolation: a partial batch must never be recorded as a clean run, and the
 * cut targets must come back next turn.
 */
describe("#2522 R2 F1 — turn_end persists and re-runs the deferral set", () => {
	it("records a partial batch as deferred, not clean, and leaves the commit gate standing", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);

		fs.mkdirSync(path.join(env.tmpDir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(env.tmpDir, "vitest.config.ts"),
			"export default {}\n",
		);
		const TARGETS = 8;
		for (let i = 0; i < TARGETS; i++) {
			const source = path.join(env.tmpDir, "src", `p${i}.ts`);
			fs.writeFileSync(source, `export const p${i} = ${i};\n`);
			fs.writeFileSync(
				path.join(env.tmpDir, "src", `p${i}.test.ts`),
				"export {};\n",
			);
			cacheManager.addModifiedRange(
				source,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				runtime.telemetrySessionId,
			);
		}

		// A REAL prior test-failure blocker on the first target, seeded through
		// the production commit-gate API. It names a file that then settles
		// CLEAN in this turn's partial batch — pre-fix, the "all tests passed"
		// branch cleared it on the strength of a batch that never finished.
		const clearedTarget = path.join(env.tmpDir, "src", "p0.test.ts");
		mergeGitGuardTestFailure(
			cacheManager,
			env.tmpDir,
			runtime,
			"[Tests] p0.test.ts FAIL 0p/1f",
			[clearedTarget],
		);

		const controller = new AbortController();
		setAmbientAbortSignal(controller.signal);
		let calls = 0;
		const ran: string[] = [];
		const dbgLines: string[] = [];
		const client = new TestRunnerClient(false);
		// Real getTestRunTarget / real selection loop; only the spawn is doubled,
		// and the double honours the per-target signal exactly as safeSpawnAsync
		// does.
		(client as unknown as { runTestFileAsync: unknown }).runTestFileAsync =
			async (
				testFile: string,
				_cwd: string,
				request: { signal?: AbortSignal },
			) => {
				const n = ++calls;
				ran.push(testFile);
				if (n <= 2) {
					return {
						file: testFile,
						runner: "vitest",
						passed: 1,
						failed: 0,
						duration: 1,
					};
				}
				await delay(30);
				if (n === 3) controller.abort();
				await new Promise<void>((resolve) => {
					if (request.signal?.aborted) return resolve();
					request.signal?.addEventListener("abort", () => resolve(), {
						once: true,
					});
				});
				// #2522 review round 3, F4: a REAL killed spawn does not resolve in
				// the same tick as the abort — `safeSpawnAsync` settles on the
				// child's `exit` event, milliseconds later. Resolving synchronously
				// here would make this double claim the target finished in time,
				// which is the one thing the F4 fold-in distinguishes.
				await delay(20);
				return {
					file: testFile,
					runner: "vitest",
					passed: 0,
					failed: 0,
					error: "killed at the batch bound",
				};
			};

		try {
			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name: string) => name === "lens-guard",
				dbg: (msg: string) => dbgLines.push(msg),
				runtime,
				cacheManager,
				knipClient: {
					ensureAvailable: async () => false,
					analyze: async () => EMPTY_KNIP_RESULT,
				},
				deadCodeClients: [],
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: client,
				resetLSPService: () => {},
				resetFormatService: () => {},
				// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
			} as any);

			const deadline = Date.now() + 5000;
			while (Date.now() < deadline && calls < 3) await delay(20);
			await delay(300);
		} finally {
			setAmbientAbortSignal(undefined);
		}

		const persisted = cacheManager.readCache<{
			content: string;
			deferredTargets?: {
				testFile: string;
				runner: string;
				attempts?: number;
			}[];
		}>("test-runner-findings", env.tmpDir)?.data;

		// The deferral set exists, by identity, in the cache the next turn reads.
		expect(persisted?.deferredTargets?.length ?? 0).toBeGreaterThan(0);
		// ...stamped with its first cut, so a target that never fits the budget
		// can be retired instead of carried forever.
		expect(persisted?.deferredTargets?.[0]?.attempts).toBe(1);
		// NOT a clean run: no empty-content record, and the agent is told.
		expect(persisted?.content ?? "").toContain("deferred to the next turn");
		expect(dbgLines.some((l) => l.includes("all tests passed"))).toBe(false);

		// And the commit gate was not relaxed by an unfinished batch.
		const guard = cacheManager.readCache<{ testFailures?: boolean }>(
			"turn-end-findings",
			env.tmpDir,
		)?.data;
		expect(guard?.testFailures).toBe(true);
	});

	it("runs the persisted deferral set FIRST on the next turn, ahead of this turn's own target", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);

		fs.mkdirSync(path.join(env.tmpDir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(env.tmpDir, "vitest.config.ts"),
			"export default {}\n",
		);
		const source = path.join(env.tmpDir, "src", "fresh.ts");
		const freshTest = path.join(env.tmpDir, "src", "fresh.test.ts");
		const carried = path.join(env.tmpDir, "src", "carried.test.ts");
		fs.writeFileSync(source, "export const fresh = 1;\n");
		fs.writeFileSync(freshTest, "export {};\n");
		fs.writeFileSync(carried, "export {};\n");
		cacheManager.addModifiedRange(
			source,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			runtime.telemetrySessionId,
		);

		// Exactly what the previous turn's partial batch persists — including the
		// session stamp (#2522 R3 F5): a deferral belongs to the session that cut
		// it, and an unstamped list is treated as another session's.
		cacheManager.writeCache(
			"test-runner-findings",
			{
				content: "1 test target(s) deferred to the next turn",
				deferredTargets: [
					{
						testFile: carried,
						runner: "vitest",
						sessionId: runtime.telemetrySessionId,
					},
				],
			},
			env.tmpDir,
		);

		const ran: string[] = [];
		const client = new TestRunnerClient(false);
		(client as unknown as { runTestFileAsync: unknown }).runTestFileAsync =
			async (testFile: string) => {
				ran.push(testFile);
				return {
					file: testFile,
					runner: "vitest",
					passed: 1,
					failed: 0,
					duration: 1,
				};
			};

		await handleTurnEnd({
			ctxCwd: env.tmpDir,
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager,
			knipClient: {
				ensureAvailable: async () => false,
				analyze: async () => EMPTY_KNIP_RESULT,
			},
			deadCodeClients: [],
			depChecker: { ensureAvailable: async () => false },
			testRunnerClient: client,
			resetLSPService: () => {},
			resetFormatService: () => {},
			// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		} as any);

		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && ran.length < 2) await delay(20);
		await delay(150);

		// Deferred first, then this turn's own related/self target.
		expect(ran[0]).toBe(path.resolve(carried));
		expect(ran).toContain(path.resolve(freshTest));
		// Consumed: the list is retired once it has been dispatched, so a target
		// can never be carried forever.
		const persisted = cacheManager.readCache<{
			deferredTargets?: { testFile: string }[];
		}>("test-runner-findings", env.tmpDir)?.data;
		expect(persisted?.deferredTargets ?? []).toHaveLength(0);
	});
});

/**
 * #2522 review round 2/3 — the deferral must not become a livelock.
 *
 * The review's own measurement is the proof this is required, not
 * hypothetical: editing `clients/runtime-turn.ts` resolves
 * `tests/index-integration.test.ts` through the `related` strategy, and that
 * file takes 26 393 ms — MORE than the whole 20 000 ms batch budget, on its
 * own. Deferring it puts it first in the next batch, where it is cut again at
 * 20 s, and again, forever: 20 s of spawned vitest burnt every single turn,
 * with the target never finishing and never being reported.
 *
 * A target that has already outlived the budget `TEST_RUNNER_MAX_DEFERRALS`
 * times is therefore retired from turn-end selection with a counted
 * degradation naming it, rather than carried indefinitely.
 *
 * Round 3, F1: the retirement has to OUTLIVE THE TURN to be a retirement.
 * Round 2's retire branch logged, counted, and `continue`d — leaving no record
 * anywhere — so the candidate loop below it re-resolved the very same file
 * through `related` in the SAME turn and ran it with a fresh (undefined)
 * attempt count. Steady state was a 3-turn cycle: cut, cut, "retire", run,
 * cut, cut, "retire", run — the slow suite spawned and killed on every single
 * turn, the `--lens-guard` clean branch never reached, and the deferral
 * advisory delivered every turn. The fixtures below therefore seed the slow
 * suite's COMPANION SOURCE into the worklist, which is what makes the
 * candidate loop re-resolve it exactly as production does.
 */
describe("#2522 R2/R3 — a target that never fits the budget is retired, not carried forever", () => {
	/**
	 * `forever.ts` + `forever.test.ts` (the slow suite, reachable through the
	 * `related` strategy on every turn that touches its source) and `fresh.ts` +
	 * `fresh.test.ts` (an ordinary target that must keep running).
	 */
	function seedRetirementProject(longTarget = false): {
		fresh: string;
		freshTest: string;
		foreverSource: string;
		forever: string;
	} {
		fs.mkdirSync(path.join(env.tmpDir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(env.tmpDir, "vitest.config.ts"),
			"export default {}\n",
		);
		const fresh = path.join(env.tmpDir, "src", "fresh.ts");
		const freshTest = path.join(env.tmpDir, "src", "fresh.test.ts");
		const foreverSource = path.join(env.tmpDir, "src", "forever.ts");
		const forever = path.join(
			env.tmpDir,
			"src",
			longTarget
				? `forever.test.ts${"x".repeat(70)}.test.ts`
				: "forever.test.ts",
		);
		fs.writeFileSync(fresh, "export const fresh = 1;\n");
		fs.writeFileSync(freshTest, "export {};\n");
		fs.writeFileSync(foreverSource, "export const forever = 1;\n");
		fs.writeFileSync(forever, "export {};\n");
		return { fresh, freshTest, foreverSource, forever };
	}

	function markEdited(
		cacheManager: CacheManager,
		runtime: RuntimeCoordinator,
		sources: string[],
		ownerKind: "pi" | "mcp" = "pi",
	): void {
		for (const source of sources) {
			cacheManager.addModifiedRange(
				source,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				ownerKind === "mcp"
					? MCP_TURN_STATE_OWNER_ID
					: runtime.telemetrySessionId,
				ownerKind,
			);
		}
	}

	function recordingClient(ran: string[]): TestRunnerClient {
		const client = new TestRunnerClient(false);
		(client as unknown as { runTestFileAsync: unknown }).runTestFileAsync =
			async (testFile: string) => {
				ran.push(testFile);
				return {
					file: testFile,
					runner: "vitest",
					passed: 1,
					failed: 0,
					duration: 1,
				};
			};
		return client;
	}

	async function runTurn(args: {
		cacheManager: CacheManager;
		runtime: RuntimeCoordinator;
		client: TestRunnerClient;
		dbgLines: string[];
	}): Promise<void> {
		await handleTurnEnd({
			ctxCwd: env.tmpDir,
			getFlag: () => false,
			dbg: (msg: string) => args.dbgLines.push(msg),
			runtime: args.runtime,
			cacheManager: args.cacheManager,
			knipClient: {
				ensureAvailable: async () => false,
				analyze: async () => EMPTY_KNIP_RESULT,
			},
			deadCodeClients: [],
			depChecker: { ensureAvailable: async () => false },
			testRunnerClient: args.client,
			resetLSPService: () => {},
			resetFormatService: () => {},
			// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		} as any);
	}

	it("retires a target at its attempt cap even though the candidate loop re-resolves it", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const { fresh, freshTest, foreverSource, forever } =
			seedRetirementProject();
		// BOTH sources are edited this turn, so `forever.test.ts` is reachable
		// through `related` — the production shape round 2's fixture omitted.
		markEdited(cacheManager, runtime, [fresh, foreverSource]);

		// Already cut at the budget TEST_RUNNER_MAX_DEFERRALS times, by THIS
		// session.
		cacheManager.writeCache(
			"test-runner-findings",
			{
				content: "1 test target(s) deferred to the next turn",
				deferredTargets: [
					{
						testFile: forever,
						runner: "vitest",
						attempts: TEST_RUNNER_MAX_DEFERRALS,
						sessionId: runtime.telemetrySessionId,
					},
				],
			},
			env.tmpDir,
		);

		const ran: string[] = [];
		const dbgLines: string[] = [];
		await runTurn({
			cacheManager,
			runtime,
			client: recordingClient(ran),
			dbgLines,
		});

		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && ran.length < 1) await delay(20);
		await delay(150);

		// This turn's own target still runs; the exhausted one does not — not via
		// the deferral list, and not via the `related` strategy either.
		expect(ran).toContain(path.resolve(freshTest));
		expect(ran).not.toContain(path.resolve(forever));
		// Never silent: the agent is told which target was retired and why...
		expect(
			dbgLines.some(
				(l) => l.includes("forever.test.ts") && l.includes("retiring deferred"),
			),
		).toBe(true);
		// ...and told again when the candidate loop tries to re-select it.
		expect(
			dbgLines.some(
				(l) =>
					l.includes("forever.test.ts") &&
					l.includes("retired earlier this session"),
			),
		).toBe(true);
		// The retirement is PERSISTED, stamped with the session that made it, so
		// the next turn honours it instead of resetting the counter to zero.
		const persisted = cacheManager.readCache<{
			deferredTargets?: { testFile: string }[];
			retiredTargets?: {
				testFile: string;
				attempts?: number;
				sessionId?: string;
			}[];
		}>("test-runner-findings", env.tmpDir)?.data;
		expect(
			(persisted?.deferredTargets ?? []).some(
				(t) => path.resolve(t.testFile) === path.resolve(forever),
			),
		).toBe(false);
		const retiredEntry = (persisted?.retiredTargets ?? []).find(
			(t) => path.resolve(t.testFile) === path.resolve(forever),
		);
		expect(retiredEntry).toBeDefined();
		expect(retiredEntry?.attempts).toBe(TEST_RUNNER_MAX_DEFERRALS);
		expect(retiredEntry?.sessionId).toBe(runtime.telemetrySessionId);
		// The retirement is counted in the ledger, not merely logged.
		expect(JSON.stringify(getDegradationSummary())).toContain(
			"forever.test.ts",
		);
	});

	/**
	 * The retirement is persisted by the turn's OWN write, not by the batch
	 * outcome. A `turn_end` fires its batch and returns; the session can end,
	 * the batch can be superseded, or its `.then` can throw, and none of those
	 * may cost the cap what it just measured. `writeTestFindings` applies
	 * `retiredCarry` to every write in the block for exactly this reason.
	 */
	it("persists the retirement before the batch it fired has settled", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const { fresh, foreverSource, forever } = seedRetirementProject();
		markEdited(cacheManager, runtime, [fresh, foreverSource]);
		cacheManager.writeCache(
			"test-runner-findings",
			{
				content: "1 test target(s) deferred to the next turn",
				deferredTargets: [
					{
						testFile: forever,
						runner: "vitest",
						attempts: TEST_RUNNER_MAX_DEFERRALS,
						sessionId: runtime.telemetrySessionId,
					},
				],
			},
			env.tmpDir,
		);

		const controller = new AbortController();
		setAmbientAbortSignal(controller.signal);
		const dbgLines: string[] = [];
		const client = new TestRunnerClient(false);
		// The batch never settles on its own — only the abort below releases it,
		// so the assertion runs strictly before any outcome write.
		(client as unknown as { runTestFileAsync: unknown }).runTestFileAsync =
			async (
				testFile: string,
				_cwd: string,
				request: { signal?: AbortSignal },
			) => {
				await new Promise<void>((resolve) => {
					if (request.signal?.aborted) return resolve();
					request.signal?.addEventListener("abort", () => resolve(), {
						once: true,
					});
				});
				return {
					file: testFile,
					runner: "vitest",
					passed: 0,
					failed: 0,
					error: "killed at the batch bound",
				};
			};

		try {
			await runTurn({ cacheManager, runtime, client, dbgLines });

			const midFlight = cacheManager.readCache<{
				retiredTargets?: { testFile: string }[];
			}>("test-runner-findings", env.tmpDir)?.data;
			expect(
				(midFlight?.retiredTargets ?? []).some(
					(t) => path.resolve(t.testFile) === path.resolve(forever),
				),
			).toBe(true);
		} finally {
			controller.abort();
			setAmbientAbortSignal(undefined);
		}
		await delay(300);
	});

	it("keeps the retirement remedy with a long test target path (#3712)", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const { fresh, foreverSource, forever } = seedRetirementProject(true);
		markEdited(cacheManager, runtime, [fresh, foreverSource]);
		cacheManager.writeCache(
			"test-runner-findings",
			{
				content: "1 test target(s) deferred to the next turn",
				deferredTargets: [
					{
						testFile: forever,
						runner: "vitest",
						attempts: TEST_RUNNER_MAX_DEFERRALS,
						sessionId: runtime.telemetrySessionId,
					},
				],
			},
			env.tmpDir,
		);
		await runTurn({
			cacheManager,
			runtime,
			client: recordingClient([]),
			dbgLines: [],
		});
		const reason =
			getDegradationSummary().find(
				(group) => group.kind === "test-runner-batch-capped",
			)?.latestReasons[0]?.reason ?? "";
		// #3712: the remedy must precede the long relative target path.
		expect(reason).toContain("run it explicitly");
	});

	it("keeps the target retired on the NEXT turn, with no deferral list left to read", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const { fresh, freshTest, foreverSource, forever } =
			seedRetirementProject();
		markEdited(cacheManager, runtime, [fresh, foreverSource]);
		cacheManager.writeCache(
			"test-runner-findings",
			{
				content: "1 test target(s) deferred to the next turn",
				deferredTargets: [
					{
						testFile: forever,
						runner: "vitest",
						attempts: TEST_RUNNER_MAX_DEFERRALS,
						sessionId: runtime.telemetrySessionId,
					},
				],
			},
			env.tmpDir,
		);

		const firstRan: string[] = [];
		const firstDbg: string[] = [];
		await runTurn({
			cacheManager,
			runtime,
			client: recordingClient(firstRan),
			dbgLines: firstDbg,
		});
		let deadline = Date.now() + 5000;
		while (Date.now() < deadline && firstRan.length < 1) await delay(20);
		await delay(150);

		// Turn 2 carries NO deferral list — the retirement is the only thing left
		// standing between the candidate loop and another 20 s of spawned vitest.
		const betweenTurns = cacheManager.readCache<{
			deferredTargets?: unknown[];
		}>("test-runner-findings", env.tmpDir)?.data;
		expect(betweenTurns?.deferredTargets ?? []).toHaveLength(0);

		markEdited(cacheManager, runtime, [fresh, foreverSource]);
		const secondRan: string[] = [];
		const secondDbg: string[] = [];
		await runTurn({
			cacheManager,
			runtime,
			client: recordingClient(secondRan),
			dbgLines: secondDbg,
		});
		deadline = Date.now() + 5000;
		while (Date.now() < deadline && secondRan.length < 1) await delay(20);
		await delay(150);

		expect(secondRan).toContain(path.resolve(freshTest));
		expect(secondRan).not.toContain(path.resolve(forever));
	});

	/**
	 * A target can be BOTH retired and back on the deferral list: the F3 merge
	 * lets a superseded batch push a cut target into `deferredTargets` after
	 * this session already retired it. Re-announcing that retirement would
	 * inflate the ledger count and duplicate the persisted entry.
	 */
	it("does not re-record a retirement the record already carries", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const { fresh, foreverSource, forever } = seedRetirementProject();
		markEdited(cacheManager, runtime, [fresh, foreverSource]);
		cacheManager.writeCache(
			"test-runner-findings",
			{
				content: "",
				deferredTargets: [
					{
						testFile: forever,
						runner: "vitest",
						attempts: TEST_RUNNER_MAX_DEFERRALS + 1,
						sessionId: runtime.telemetrySessionId,
					},
				],
				retiredTargets: [
					{
						testFile: forever,
						runner: "vitest",
						attempts: TEST_RUNNER_MAX_DEFERRALS,
						sessionId: runtime.telemetrySessionId,
					},
				],
			},
			env.tmpDir,
		);

		const ran: string[] = [];
		const dbgLines: string[] = [];
		await runTurn({
			cacheManager,
			runtime,
			client: recordingClient(ran),
			dbgLines,
		});
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && ran.length < 1) await delay(20);
		await delay(150);

		expect(ran).not.toContain(path.resolve(forever));
		// Announced once, when it was retired — not again on every later turn.
		expect(
			dbgLines.filter(
				(l) => l.includes("retiring deferred") && l.includes("forever.test.ts"),
			),
		).toHaveLength(0);
		const persisted = cacheManager.readCache<{
			retiredTargets?: { testFile: string }[];
		}>("test-runner-findings", env.tmpDir)?.data;
		expect(persisted?.retiredTargets ?? []).toHaveLength(1);
	});

	/**
	 * The other half of the session stamp: a RETIREMENT is a measurement of one
	 * session's batch budget under one session's load. A new session re-arms it
	 * — otherwise a suite retired once is silently excluded from turn-end
	 * selection forever, on every future session, with nothing on disk that ever
	 * expires (#2522 R3 F5, the #2504 stale-owner shape).
	 */
	it("re-arms a retirement recorded by a previous session", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const { fresh, freshTest, foreverSource, forever } =
			seedRetirementProject();
		markEdited(cacheManager, runtime, [fresh, foreverSource]);
		cacheManager.writeCache(
			"test-runner-findings",
			{
				content: "",
				retiredTargets: [
					{
						testFile: forever,
						runner: "vitest",
						attempts: TEST_RUNNER_MAX_DEFERRALS,
						sessionId: `${runtime.telemetrySessionId}-a-previous-session`,
					},
				],
			},
			env.tmpDir,
		);

		const ran: string[] = [];
		const dbgLines: string[] = [];
		await runTurn({
			cacheManager,
			runtime,
			client: recordingClient(ran),
			dbgLines,
		});
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && ran.length < 2) await delay(20);
		await delay(150);

		expect(ran).toContain(path.resolve(freshTest));
		expect(ran).toContain(path.resolve(forever));
		// #2522 review round 4, I1: re-arming is a SELECTION decision. The other
		// session's row is left exactly where it was — this session ignores it, it
		// does not get to delete it. Round 3 wrote the filtered list straight back,
		// which is how a turn taken through the MCP route erased the pi route's
		// retirements (and vice versa) on the very same project.
		const persisted = cacheManager.readCache<{
			retiredTargets?: { testFile: string; sessionId?: string }[];
		}>("test-runner-findings", env.tmpDir)?.data;
		expect(persisted?.retiredTargets ?? []).toHaveLength(1);
		expect(persisted?.retiredTargets?.[0]?.sessionId).toBe(
			`${runtime.telemetrySessionId}-a-previous-session`,
		);
	});

	it("does not adopt a deferral list carried over from another session", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const { fresh, freshTest } = seedRetirementProject();
		markEdited(cacheManager, runtime, [fresh]);

		// The previous SESSION's cut batch, still on disk. Adopting it re-fires a
		// suite for edits this session never made, and — worse — inherits its
		// attempt counter, so one cut here could retire a target this session has
		// never once measured (#2522 R3 F5, the #2504 stale-owner shape).
		const strangerTest = path.join(env.tmpDir, "src", "stranger.test.ts");
		fs.writeFileSync(strangerTest, "export {};\n");
		cacheManager.writeCache(
			"test-runner-findings",
			{
				content: "1 test target(s) deferred to the next turn",
				deferredTargets: [
					{
						testFile: strangerTest,
						runner: "vitest",
						attempts: 1,
						sessionId: `${runtime.telemetrySessionId}-a-previous-session`,
					},
				],
			},
			env.tmpDir,
		);

		const ran: string[] = [];
		const dbgLines: string[] = [];
		await runTurn({
			cacheManager,
			runtime,
			client: recordingClient(ran),
			dbgLines,
		});
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && ran.length < 1) await delay(20);
		await delay(150);

		expect(ran).toContain(path.resolve(freshTest));
		expect(ran).not.toContain(path.resolve(strangerTest));
		// I1: ignored, not deleted — the session that cut it still owes that run.
		// Asserted before the log line so this reds on the behaviour.
		const persisted = cacheManager.readCache<{
			deferredTargets?: { testFile: string }[];
		}>("test-runner-findings", env.tmpDir)?.data;
		expect(
			(persisted?.deferredTargets ?? []).some(
				(t) => path.resolve(t.testFile) === path.resolve(strangerTest),
			),
		).toBe(true);
		expect(
			dbgLines.some((l) => l.includes("belonging to another session")),
		).toBe(true);
	});
});

/**
 * #2522 review round 3, F3 — a superseded batch must hand its cut targets over,
 * not drop them.
 *
 * The pre-run write of EVERY batch resets `deferredTargets` to `[]`, and a
 * newer batch never sees an older one's cut set. So when two batches overlap,
 * the older one's `supersededByNewerGeneration` early-return took the identity
 * of every target it had been cut on straight to the floor: never deferred,
 * never re-selected, and the suite they belong to simply never ran again.
 */
describe("#2522 R3 F3 — a superseded batch carries its cut targets forward", () => {
	it("merges the cut set into the newer generation's record instead of dropping it", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);

		fs.mkdirSync(path.join(env.tmpDir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(env.tmpDir, "vitest.config.ts"),
			"export default {}\n",
		);
		const TARGETS = 6;
		for (let i = 0; i < TARGETS; i++) {
			const source = path.join(env.tmpDir, "src", `s${i}.ts`);
			fs.writeFileSync(source, `export const s${i} = ${i};\n`);
			fs.writeFileSync(
				path.join(env.tmpDir, "src", `s${i}.test.ts`),
				"export {};\n",
			);
			cacheManager.addModifiedRange(
				source,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				runtime.telemetrySessionId,
			);
		}

		const controller = new AbortController();
		setAmbientAbortSignal(controller.signal);
		const ran: string[] = [];
		const dbgLines: string[] = [];
		const client = new TestRunnerClient(false);
		(client as unknown as { runTestFileAsync: unknown }).runTestFileAsync =
			async (
				testFile: string,
				_cwd: string,
				request: { signal?: AbortSignal },
			) => {
				ran.push(testFile);
				await new Promise<void>((resolve) => {
					if (request.signal?.aborted) return resolve();
					request.signal?.addEventListener("abort", () => resolve(), {
						once: true,
					});
				});
				// A real killed spawn settles on the child's `exit` event, not in
				// the same tick as the abort (#2522 R3 F4).
				await delay(20);
				return {
					file: testFile,
					runner: "vitest",
					passed: 0,
					failed: 0,
					error: "killed at the batch bound",
				};
			};

		try {
			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: (msg: string) => dbgLines.push(msg),
				runtime,
				cacheManager,
				knipClient: {
					ensureAvailable: async () => false,
					analyze: async () => EMPTY_KNIP_RESULT,
				},
				deadCodeClients: [],
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: client,
				resetLSPService: () => {},
				resetFormatService: () => {},
				// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
			} as any);

			const dispatched = Date.now() + 5000;
			while (Date.now() < dispatched && ran.length < 1) await delay(20);

			// A NEWER batch publishes for this project while this one is still in
			// flight — bumping the generation and writing its OWN deferral set.
			// `s0.test.ts` is on both sides: the newer batch has already cut it
			// five times, this stale one is cutting it for the first. The merge
			// must keep the HIGHER count, or a target trades an attempt back for
			// every overlap and never converges on the retirement cap.
			cacheManager.writeCache(
				"test-runner-findings",
				{
					content: "",
					testRunGeneration: 999,
					deferredTargets: [
						{
							testFile: path.join(env.tmpDir, "src", "s0.test.ts"),
							runner: "vitest",
							attempts: 5,
							sessionId: runtime.telemetrySessionId,
						},
					],
				},
				env.tmpDir,
			);
			controller.abort();
			await delay(400);
		} finally {
			setAmbientAbortSignal(undefined);
		}

		const persisted = cacheManager.readCache<{
			testRunGeneration?: number;
			deferredTargets?: { testFile: string; attempts?: number }[];
		}>("test-runner-findings", env.tmpDir)?.data;

		// The newer generation still owns the record — the stale batch published
		// nothing of its own...
		expect(persisted?.testRunGeneration).toBe(999);
		// ...but the targets it was cut on are now the newer generation's problem
		// rather than nobody's.
		const merged = persisted?.deferredTargets ?? [];
		expect(merged.length).toBeGreaterThan(1);
		// The overlapping target keeps the higher attempt count, so progress
		// toward the retirement cap is never traded back.
		const overlap = merged.find(
			(t) =>
				path.resolve(t.testFile) ===
				path.resolve(path.join(env.tmpDir, "src", "s0.test.ts")),
		);
		expect(overlap?.attempts).toBe(5);
		// The stale batch's own cut targets are charged their first attempt.
		expect(
			merged.filter((t) => t.attempts === 1).length,
		).toBeGreaterThanOrEqual(1);
		expect(
			dbgLines.some((l) => l.includes("into the newer generation's deferral")),
		).toBe(true);
	});
});

/**
 * #2522 review round 4 — the state-space round.
 *
 * Three rounds each fixed a finding on the `test-runner-findings` record and
 * introduced the next one, so this block is written from the record's model
 * rather than from the last diff. Four persisted concerns (`content`,
 * `testRunGeneration`/`runnerErrorOnly`, `deferredTargets`, `retiredTargets`),
 * seven writers, and four axes: session identity (own / foreign / absent),
 * generation ordering, cut vs complete vs abort-before-spawn, and the per-turn
 * target cap. The invariants pinned here:
 *
 *  I1 a foreign-session entry is never destroyed by a write — foreign entries
 *     are filtered at SELECTION only;
 *  I2 every `deferredTargets` write MERGES against the live record;
 *  I3 `attempts` accumulates across turns and actually reaches the cap;
 *  I5 a carried entry rejected only by the per-turn cap stays on the list.
 *
 * (I4 — cut vs complete decided by the dispatch-time stamp rather than by
 * macrotask ordering — is pinned in the batch-helper describe at the top of
 * this file.)
 */
describe("#2522 R4 — the deferral record across sessions, generations and caps", () => {
	/** The identity `index.ts` passes; `clients/mcp/session.ts` passes none. */
	const PI_SESSION = "pi-stable-session-2522";

	function seedProject(names: string[]): Record<string, string> {
		fs.mkdirSync(path.join(env.tmpDir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(env.tmpDir, "vitest.config.ts"),
			"export default {}\n",
		);
		const out: Record<string, string> = {};
		for (const name of names) {
			const source = path.join(env.tmpDir, "src", `${name}.ts`);
			const test = path.join(env.tmpDir, "src", `${name}.test.ts`);
			fs.writeFileSync(source, `export const ${name} = 1;\n`);
			fs.writeFileSync(test, "export {};\n");
			out[name] = source;
			out[`${name}Test`] = test;
		}
		return out;
	}

	function markEdited(
		cacheManager: CacheManager,
		runtime: RuntimeCoordinator,
		sources: string[],
		ownerKind: "pi" | "mcp" = "pi",
	): void {
		for (const source of sources) {
			cacheManager.addModifiedRange(
				source,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				ownerKind === "mcp"
					? MCP_TURN_STATE_OWNER_ID
					: runtime.telemetrySessionId,
				ownerKind,
			);
		}
	}

	/** Settles immediately — an ordinary, complete run. */
	function completingClient(ran: string[]): TestRunnerClient {
		const client = new TestRunnerClient(false);
		(client as unknown as { runTestFileAsync: unknown }).runTestFileAsync =
			async (testFile: string) => {
				ran.push(testFile);
				return {
					file: testFile,
					runner: "vitest",
					passed: 1,
					failed: 0,
					duration: 1,
				};
			};
		return client;
	}

	/**
	 * Settles only once the BATCH signal fires, then after a short delay —
	 * production-faithful for a killed spawn, which resolves on the child's
	 * `exit` event rather than in the abort listener's own tick.
	 */
	function killableClient(ran: string[]): TestRunnerClient {
		const client = new TestRunnerClient(false);
		(client as unknown as { runTestFileAsync: unknown }).runTestFileAsync =
			async (
				testFile: string,
				_cwd: string,
				request: { signal?: AbortSignal },
			) => {
				ran.push(testFile);
				await new Promise<void>((resolve) => {
					if (request.signal?.aborted) return resolve();
					request.signal?.addEventListener("abort", () => resolve(), {
						once: true,
					});
				});
				await delay(20);
				return {
					file: testFile,
					runner: "vitest",
					passed: 0,
					failed: 0,
					error: "killed at the batch bound",
				};
			};
		return client;
	}

	async function runTurn(args: {
		cacheManager: CacheManager;
		runtime: RuntimeCoordinator;
		client: TestRunnerClient;
		dbg?: (msg: string) => void;
		sessionId?: string;
		mcp?: boolean;
	}): Promise<void> {
		const effectiveSessionId = args.mcp
			? undefined
			: (args.sessionId ?? args.runtime.telemetrySessionId);
		await handleTurnEnd({
			ctxCwd: env.tmpDir,
			getFlag: () => false,
			dbg: args.dbg ?? (() => {}),
			runtime: args.runtime,
			cacheManager: args.cacheManager,
			knipClient: {
				ensureAvailable: async () => false,
				analyze: async () => EMPTY_KNIP_RESULT,
			},
			deadCodeClients: [],
			depChecker: { ensureAvailable: async () => false },
			testRunnerClient: args.client,
			resetLSPService: () => {},
			resetFormatService: () => {},
			...(effectiveSessionId ? { sessionId: effectiveSessionId } : {}),
			...(args.mcp
				? {
						owner: {
							kind: "mcp" as const,
							id: MCP_TURN_STATE_OWNER_ID,
							pid: process.pid,
							lastSeen: new Date().toISOString(),
						},
					}
				: {}),
			// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		} as any);
	}

	interface PersistedEntry {
		testFile: string;
		attempts?: number;
		sessionId?: string;
	}

	function readRecord(cacheManager: CacheManager): {
		testRunGeneration?: number;
		deferredTargets?: PersistedEntry[];
		retiredTargets?: PersistedEntry[];
	} {
		return (
			cacheManager.readCache<{
				testRunGeneration?: number;
				deferredTargets?: PersistedEntry[];
				retiredTargets?: PersistedEntry[];
			}>("test-runner-findings", env.tmpDir)?.data ?? {}
		);
	}

	const entryFor = (
		list: PersistedEntry[],
		file: string,
	): PersistedEntry | undefined =>
		list.find((t) => path.resolve(t.testFile) === path.resolve(file));

	/**
	 * Cut ONE real turn-end batch and return once its outcome has been written.
	 * The bound is the ambient abort signal, which is how `handleTurnEnd`'s own
	 * caller cancels a turn — the same code path the 20 s wall budget takes,
	 * with a timer in front of it instead of an event.
	 */
	async function runCutTurn(args: {
		cacheManager: CacheManager;
		runtime: RuntimeCoordinator;
		dbg?: (msg: string) => void;
		sessionId?: string;
	}): Promise<string[]> {
		const controller = new AbortController();
		setAmbientAbortSignal(controller.signal);
		const ran: string[] = [];
		try {
			await runTurn({
				...args,
				client: killableClient(ran),
				dbg: args.dbg,
			});
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline && ran.length < 1) await delay(20);
			controller.abort();
			await delay(300);
		} finally {
			setAmbientAbortSignal(undefined);
		}
		return ran;
	}

	/**
	 * P1 — the finding this round opened on.
	 *
	 * `index.ts` hands `handleTurnEnd` pi's stable session id;
	 * `clients/mcp/session.ts:311` hands it none, so that route stamps
	 * `runtime.telemetrySessionId` instead. Both routes fire against the same
	 * project, so both identities are live at once. Round 3 filtered the two
	 * persisted lists to the current session and then wrote the FILTERED lists
	 * straight back, so a single turn taken through the other route erased
	 * everything the first route had recorded: `retired: []`, `deferred: []`.
	 */
	it("does not destroy another session's deferral and retirement lists", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const p = seedProject(["slow", "fresh"]);

		// Turn 1, through the pi route: a REAL cut batch stamps PI_SESSION.
		markEdited(cacheManager, runtime, [p.slow]);
		await runCutTurn({ cacheManager, runtime, sessionId: PI_SESSION });
		const afterPi = readRecord(cacheManager);
		expect(entryFor(afterPi.deferredTargets ?? [], p.slowTest)?.sessionId).toBe(
			PI_SESSION,
		);

		// Turn 2, through the MCP route: no sessionId, so `telemetrySessionId`.
		const ran: string[] = [];
		const dbgLines: string[] = [];
		markEdited(cacheManager, runtime, [p.fresh], "mcp");
		await runTurn({
			cacheManager,
			runtime,
			client: completingClient(ran),
			mcp: true,
			dbg: (m) => dbgLines.push(m),
		});
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && ran.length < 1) await delay(20);
		await delay(200);

		// THE invariant first, so this reds on the behaviour and not on a log
		// string: the MCP turn did not delete the pi route's deferral.
		const afterMcp = readRecord(cacheManager);
		const carried = entryFor(afterMcp.deferredTargets ?? [], p.slowTest);
		expect(carried).toBeDefined();
		expect(carried?.sessionId).toBe(PI_SESSION);
		// And it ran its own target without adopting the foreign one.
		expect(ran).toContain(path.resolve(p.freshTest));
		expect(ran).not.toContain(path.resolve(p.slowTest));
		expect(
			dbgLines.some((l) => l.includes("belonging to another session")),
		).toBe(true);
	});

	/**
	 * P1b — the consequence. With the retirement erased by the other route's
	 * turn, the pi route re-resolves the retired suite through `related` and
	 * fires it again: the livelock `TEST_RUNNER_MAX_DEFERRALS` exists to end.
	 */
	it("keeps its own retirement across a foreign session's turn", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const p = seedProject(["forever", "fresh"]);

		// The pi route has already measured `forever.test.ts` as too slow.
		cacheManager.writeCache(
			"test-runner-findings",
			{
				content: "",
				retiredTargets: [
					{
						testFile: p.foreverTest,
						runner: "vitest",
						attempts: TEST_RUNNER_MAX_DEFERRALS,
						sessionId: PI_SESSION,
					},
				],
			},
			env.tmpDir,
		);

		// A turn on the MCP route (different identity) runs in between.
		const mcpRan: string[] = [];
		markEdited(cacheManager, runtime, [p.fresh, p.forever], "mcp");
		await runTurn({
			cacheManager,
			runtime,
			client: completingClient(mcpRan),
			mcp: true,
		});
		let deadline = Date.now() + 5000;
		while (Date.now() < deadline && mcpRan.length < 1) await delay(20);
		await delay(200);

		// Back on the pi route: the retirement must still be standing.
		const piRan: string[] = [];
		const dbgLines: string[] = [];
		markEdited(cacheManager, runtime, [p.fresh, p.forever]);
		await runTurn({
			cacheManager,
			runtime,
			client: completingClient(piRan),
			dbg: (m) => dbgLines.push(m),
			sessionId: PI_SESSION,
		});
		deadline = Date.now() + 5000;
		while (Date.now() < deadline && piRan.length < 1) await delay(20);
		await delay(200);

		expect(piRan).toContain(path.resolve(p.freshTest));
		expect(piRan).not.toContain(path.resolve(p.foreverTest));
		expect(
			dbgLines.some((l) => l.includes("retired earlier this session")),
		).toBe(true);
	});

	/**
	 * P6 — I2, through two REAL overlapping `handleTurnEnd` batches.
	 *
	 * Round 3's F3 test hand-wrote the newer generation's record, so it only
	 * ever proved the older batch's hand-over. The write that actually loses the
	 * hand-over is the NEWER batch's own publish: its clean branch wrote
	 * `deferredTargets: []`, flattening the set the stale batch had just merged
	 * in. Both batches here are real turns.
	 */
	it("keeps both batches' cut sets when two real turn-end batches overlap", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const p = seedProject(["alpha", "beta"]);

		const controllerA = new AbortController();
		setAmbientAbortSignal(controllerA.signal);
		const ranA: string[] = [];
		let releaseB: () => void = () => {};
		const bReleased = new Promise<void>((resolve) => {
			releaseB = resolve;
		});
		try {
			// Batch A: dispatched, still in flight, cut later.
			markEdited(cacheManager, runtime, [p.alpha]);
			await runTurn({ cacheManager, runtime, client: killableClient(ranA) });
			let deadline = Date.now() + 5000;
			while (Date.now() < deadline && ranA.length < 1) await delay(20);

			// Batch B starts and takes the newer generation, but does not publish
			// until it is released — so batch A's hand-over lands first.
			setAmbientAbortSignal(undefined);
			const clientB = new TestRunnerClient(false);
			const ranB: string[] = [];
			(clientB as unknown as { runTestFileAsync: unknown }).runTestFileAsync =
				async (testFile: string) => {
					ranB.push(testFile);
					await bReleased;
					return {
						file: testFile,
						runner: "vitest",
						passed: 1,
						failed: 0,
						duration: 1,
					};
				};
			markEdited(cacheManager, runtime, [p.beta]);
			await runTurn({ cacheManager, runtime, client: clientB });
			deadline = Date.now() + 5000;
			while (Date.now() < deadline && ranB.length < 1) await delay(20);

			// A is cut; superseded by B's generation, so it hands its cut set over
			// rather than publishing.
			controllerA.abort();
			await delay(300);
			expect(
				entryFor(readRecord(cacheManager).deferredTargets ?? [], p.alphaTest),
			).toBeDefined();

			// Now B publishes — clean, with nothing of its own deferred.
			releaseB();
			await delay(300);
		} finally {
			releaseB();
			setAmbientAbortSignal(undefined);
			await delay(50);
		}

		const persisted = readRecord(cacheManager);
		// B's clean publish must not flatten what A handed over.
		const alpha = entryFor(persisted.deferredTargets ?? [], p.alphaTest);
		expect(alpha).toBeDefined();
		expect(alpha?.attempts).toBe(1);
		// B's own target completed, so it owes nothing.
		expect(
			entryFor(persisted.deferredTargets ?? [], p.betaTest),
		).toBeUndefined();
	});

	/**
	 * I3 — the attempt counter has to survive real turns.
	 *
	 * Hard-coding `attempts: 1` at the batch outcome left the whole suite green
	 * before this test existed: every other case seeded the count it wanted to
	 * see. Three real turns, one cut batch each, and the cap must actually
	 * arrive.
	 */
	it("accumulates a real attempt per cut turn until the cap retires the target", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const p = seedProject(["forever"]);

		expect(TEST_RUNNER_MAX_DEFERRALS).toBe(2);

		markEdited(cacheManager, runtime, [p.forever]);
		await runCutTurn({ cacheManager, runtime });
		expect(
			entryFor(readRecord(cacheManager).deferredTargets ?? [], p.foreverTest)
				?.attempts,
		).toBe(1);

		markEdited(cacheManager, runtime, [p.forever]);
		await runCutTurn({ cacheManager, runtime });
		expect(
			entryFor(readRecord(cacheManager).deferredTargets ?? [], p.foreverTest)
				?.attempts,
		).toBe(2);

		// Third turn: the carried entry is at the cap, so it is retired instead of
		// dispatched — and the candidate loop cannot re-resolve it either.
		const ran: string[] = [];
		const dbgLines: string[] = [];
		markEdited(cacheManager, runtime, [p.forever]);
		await runTurn({
			cacheManager,
			runtime,
			client: completingClient(ran),
			dbg: (m) => dbgLines.push(m),
		});
		await delay(300);

		expect(ran).not.toContain(path.resolve(p.foreverTest));
		const final = readRecord(cacheManager);
		expect(entryFor(final.retiredTargets ?? [], p.foreverTest)?.attempts).toBe(
			TEST_RUNNER_MAX_DEFERRALS,
		);
		expect(
			dbgLines.some(
				(l) => l.includes("retiring deferred") && l.includes("forever.test.ts"),
			),
		).toBe(true);
	});

	/**
	 * P5 / I5 — a carried entry the per-turn cap has no room for.
	 *
	 * Round 3 folded that case in with "missing file, excluded, unknown runner"
	 * and dropped the entry outright, under a `dbg` line that said the file no
	 * longer resolved. A carry larger than `TEST_RUNNER_MAX_TARGETS` therefore
	 * lost its tail on every turn: 16 carried in, 12 run, 4 gone.
	 */
	it("holds the carried targets it cannot fit under the per-turn cap", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const CARRIED = TEST_RUNNER_MAX_TARGETS + 4;
		const names = Array.from({ length: CARRIED }, (_, i) => `c${i}`);
		const p = seedProject([...names, "edited"]);
		// The turn needs at least one edited file to reach the test-runner block;
		// this one's own companion is dropped by the missing-file guard, so it
		// takes none of the cap's slots.
		fs.rmSync(p.editedTest);
		markEdited(cacheManager, runtime, [p.edited]);

		cacheManager.writeCache(
			"test-runner-findings",
			{
				content: "",
				deferredTargets: names.map((n) => ({
					testFile: p[`${n}Test`],
					runner: "vitest",
					attempts: 1,
					sessionId: runtime.telemetrySessionId,
				})),
			},
			env.tmpDir,
		);

		const ran: string[] = [];
		const dbgLines: string[] = [];
		await runTurn({
			cacheManager,
			runtime,
			client: completingClient(ran),
			dbg: (m) => dbgLines.push(m),
		});
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline && ran.length < TEST_RUNNER_MAX_TARGETS) {
			await delay(20);
		}
		await delay(300);

		expect(ran).toHaveLength(TEST_RUNNER_MAX_TARGETS);
		const held = readRecord(cacheManager).deferredTargets ?? [];
		expect(held).toHaveLength(CARRIED - TEST_RUNNER_MAX_TARGETS);
		// Held, not run — so no attempt is charged and a target the turn simply
		// had no room for is not walked toward retirement.
		for (const entry of held) expect(entry.attempts).toBe(1);
		// And the reason is its own, not "no longer resolves".
		expect(
			dbgLines.some((l) => l.includes("held") && l.includes("per-turn cap")),
		).toBe(true);
	});

	/**
	 * The bound that I1 makes necessary: nothing prunes another session's rows
	 * any more, so without a ceiling the record grows by a few rows per session
	 * forever, on a file read at every single turn_end.
	 */
	it("bounds the persisted target lists", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const p = seedProject(["fresh"]);
		markEdited(cacheManager, runtime, [p.fresh]);

		const foreign = Array.from(
			{ length: TEST_RUNNER_MAX_PERSISTED_TARGETS + 16 },
			(_, i) => ({
				testFile: path.join(env.tmpDir, "src", `ghost${i}.test.ts`),
				runner: "vitest",
				attempts: 1,
				sessionId: `stale-session-${i}`,
			}),
		);
		cacheManager.writeCache(
			"test-runner-findings",
			{ content: "", deferredTargets: foreign },
			env.tmpDir,
		);

		const ran: string[] = [];
		const dbgLines: string[] = [];
		await runTurn({
			cacheManager,
			runtime,
			client: completingClient(ran),
			dbg: (m) => dbgLines.push(m),
		});
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && ran.length < 1) await delay(20);
		await delay(300);

		const persisted = readRecord(cacheManager).deferredTargets ?? [];
		expect(persisted).toHaveLength(TEST_RUNNER_MAX_PERSISTED_TARGETS);
		expect(dbgLines.some((l) => l.includes("bounded to the newest"))).toBe(
			true,
		);
	});

	/**
	 * S1 — observability on the route that has none.
	 *
	 * `clients/mcp/session.ts` calls `handleTurnEnd` with `dbg: noop`, so every
	 * `turn_end:` line the deferral machinery writes is invisible on the route
	 * that fires it most. One pushed latency record says what happened to the
	 * carried list.
	 */
	it("pushes one latency record for the deferral set on a route with no dbg", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const p = seedProject(["carried", "fresh"]);
		markEdited(cacheManager, runtime, [p.fresh]);
		cacheManager.writeCache(
			"test-runner-findings",
			{
				content: "",
				deferredTargets: [
					{
						testFile: p.carriedTest,
						runner: "vitest",
						attempts: 1,
						sessionId: runtime.telemetrySessionId,
					},
				],
			},
			env.tmpDir,
		);

		// `logLatency` short-circuits under `isTestMode()`, so the record can only
		// be observed with the same opt-out the other latency-log tests in this
		// repo use. The captured sink stays in this file's pre-import logHome,
		// independently of later per-case home changes or parallel suites.
		const previousTestMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		clearLatencyLog();
		const ran: string[] = [];
		try {
			// No `dbg` — exactly the MCP/Stop-hook shape.
			await runTurn({ cacheManager, runtime, client: completingClient(ran) });
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline && ran.length < 2) await delay(20);
			await delay(300);
			await flushLatencyLog();
		} finally {
			if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = previousTestMode;
		}

		const entry = fs
			.readFileSync(getLatencyLogPath(), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.find((e) => e.phase === "test_runner_deferral");
		expect(entry).toBeDefined();
		const metadata = entry?.metadata as Record<string, unknown> | undefined;
		expect(metadata?.carried).toBe(1);
		expect(metadata?.redispatched).toBe(1);
	});
});
