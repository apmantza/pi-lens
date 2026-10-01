/**
 * Turn-end integration for the blocker freshness gate (#1631).
 *
 * Drives the real `handleTurnEnd` and asserts the two agent-visible guarantees:
 *   1. A cached blocker whose dependency drifted out-of-band is NOT re-served as an
 *      authoritative "Unresolved from this turn" blocker; it is demoted to a
 *      `[stale — re-run to confirm]` advisory (acceptance criteria 1–2).
 *   2. Every turn end emits one `blocker_freshness_sweep` latency record naming the
 *      revalidated/retired/kept counts (acceptance criterion 5), so a future replay
 *      incident is reconstructible from `~/.pi-lens/latency.log` alone.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return { ...actual, logLatency };
});

import { CacheManager } from "../../clients/cache-manager.js";
import { gateFindingsByPathFreshness } from "../../clients/advisory-provenance.js";
import {
	drainPendingRunnerFindings,
	deferRunnerFindings,
	pendingRunnerFindingsSize,
	resetPendingRunnerFindings,
} from "../../clients/dispatch/pending-runner-findings.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { _resetInstanceRegistryEnabledForTests } from "../../clients/instance-registry.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	cancelLSPIdleReset,
	handleTurnEnd,
} from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

function makeTurnEndDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	overrides: Record<string, unknown> = {},
) {
	return {
		ctxCwd: undefined,
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
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
		...overrides,
	} as any;
}

function driftIntoFuture(filePath: string): void {
	const future = new Date(Date.now() + 60_000);
	fs.utimesSync(filePath, future, future);
}

/**
 * #3274: turn_end fires the instance-registry heartbeat as fire-and-forget
 * (`void updateHeartbeat()`, clients/runtime-turn.ts) and never waits for it.
 * When its file lock is contended, `withInstanceRegistryLock` arms a ~20 ms
 * backoff timer — a timer the hook neither owns nor awaits, but one the
 * `vi.getTimerCount()` pin below counts.
 *
 * That was invisible while turn_end ran its scanner-cache reads synchronously:
 * the hook returned before the heartbeat's first `await` continuation. #3274's
 * async reads yield the event loop, so the heartbeat chain now advances DURING
 * the turn, and the case below failed 2 of 6 parallel runs with
 * `expected 2 to be 1`. Measured, not inferred — a `setTimeout` trace on the
 * failing runs named `withInstanceRegistryLock` ← `updateHeartbeat` both
 * times, at 18 ms and 22 ms, while all five `bounded()` deadline timers were
 * armed AND cleared in the same run.
 *
 * The registry is a cross-process file the hook only writes to best-effort, so
 * this file turns it off through its own shipped kill switch rather than
 * mocking a module or loosening the assertion: the count then measures what it
 * is meant to measure, the timers turn_end itself schedules.
 */
beforeAll(() => {
	vi.stubEnv("PI_LENS_INSTANCE_REGISTRY", "0");
	_resetInstanceRegistryEnabledForTests();
});

afterAll(() => {
	vi.unstubAllEnvs();
	_resetInstanceRegistryEnabledForTests();
});

afterEach(() => {
	cancelLSPIdleReset();
	vi.useRealTimers();
	resetPendingRunnerFindings();
	resetDegradationLedger();
	logLatency.mockClear();
});

describe("turn-end blocker freshness (#1631)", () => {
	it("arms idle reset before delivering a pending runner on a no-write turn", async () => {
		vi.useFakeTimers();
		const env = setupTestEnvironment("pi-lens-runner-idle-reset-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "runner-idle-session" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			deferRunnerFindings({
				filePath: path.join(env.tmpDir, "pending.ts"),
				cwd: env.tmpDir,
				projectRoot: env.tmpDir,
				runnerId: "never-settling-runner",
				markedAtMs: Date.now(),
				promise: new Promise(() => {}),
			});

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);

			// The deferred work remains owned for a later turn, but delivery still ran.
			expect(pendingRunnerFindingsSize()).toBe(1);
			expect(
				logLatency.mock.calls.some(
					([entry]) => entry?.phase === "late_runner_findings",
				),
			).toBe(true);
			expect(vi.getTimerCount()).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	it("re-serves a drifted blocker as a [stale] advisory, not an authoritative blocker, and logs the sweep", async () => {
		const env = setupTestEnvironment("pi-lens-fresh-turnend-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "fresh-session" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			// Consumer test file + the dependency it imports.
			const consumer = path.join(env.tmpDir, "git-env.test.ts");
			const dep = path.join(env.tmpDir, "worktree.ts");
			fs.mkdirSync(path.dirname(consumer), { recursive: true });
			fs.writeFileSync(dep, "export const other = 1;\n");
			fs.writeFileSync(
				consumer,
				'import { gitEnv } from "./worktree.js";\nexport const t = gitEnv;\n',
			);

			// The agent edited the consumer; the dispatch recorded a blocker.
			runtime.bumpFileSeq(consumer);
			cacheManager.addModifiedRange(
				consumer,
				{ start: 1, end: 2 },
				false,
				env.tmpDir,
				"fresh-session",
			);
			runtime.recordInlineBlockers(
				consumer,
				"🔴 L1 No exported member 'gitEnv' on './worktree.js'",
				1,
				["lsp"],
			);

			// The dependency is fixed out-of-band after the verdict.
			driftIntoFuture(dep);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);

			// The turn-end advisory must NOT re-assert the stale blocker.
			const findings = cacheManager.readCache<{ content: string }>(
				"turn-end-findings",
				env.tmpDir,
			);
			const content = findings?.data?.content ?? "";
			expect(content).toContain("[stale — re-run to confirm]");
			expect(content).toContain(path.basename(consumer));
			expect(content).not.toContain("Unresolved from this turn");

			// One bounded latency record names the freshness counts.
			const sweepRecord = logLatency.mock.calls
				.map((call) => call[0])
				.find(
					(entry: any) =>
						entry?.type === "phase" &&
						entry?.phase === "blocker_freshness_sweep",
				);
			expect(sweepRecord).toBeDefined();
			expect(sweepRecord.metadata).toMatchObject({
				total: 1,
				revalidated: 1,
				kept: 0,
			});
		} finally {
			env.cleanup();
		}
	});

	it("still re-serves an un-drifted blocker as an authoritative blocker", async () => {
		const env = setupTestEnvironment("pi-lens-fresh-turnend-keep-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "keep-session" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			const consumer = path.join(env.tmpDir, "consumer.ts");
			const dep = path.join(env.tmpDir, "dep.ts");
			fs.mkdirSync(path.dirname(consumer), { recursive: true });
			fs.writeFileSync(dep, "export const x = 1;\n");
			fs.writeFileSync(
				consumer,
				'import { x } from "./dep.js";\nexport const y = x;\n',
			);

			runtime.bumpFileSeq(consumer);
			cacheManager.addModifiedRange(
				consumer,
				{ start: 1, end: 2 },
				false,
				env.tmpDir,
				"keep-session",
			);
			runtime.recordInlineBlockers(consumer, "🔴 a real blocker", 1, ["lsp"]);
			// Pin the dependency in the past so it cannot read as drifted.
			const past = new Date(Date.now() - 60_000);
			fs.utimesSync(dep, past, past);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);

			const findings = cacheManager.readCache<{ content: string }>(
				"turn-end-findings",
				env.tmpDir,
			);
			const content = findings?.data?.content ?? "";
			expect(content).toContain("Unresolved from this turn");
			expect(content).not.toContain("[stale — re-run to confirm]");
		} finally {
			env.cleanup();
		}
	});

	it("drops stale deferred runner findings and records the coverage gap", async () => {
		const env = setupTestEnvironment("pi-lens-runner-fresh-turnend-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "runner-fresh-session" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const filePath = path.join(env.tmpDir, "runner.ts");
			fs.writeFileSync(filePath, "export const value = 1;\n");
			const markedAtMs = 1;
			deferRunnerFindings({
				filePath,
				cwd: env.tmpDir,
				projectRoot: env.tmpDir,
				runnerId: "slow-runner",
				markedAtMs,
				promise: Promise.resolve({
					status: "succeeded",
					diagnostics: [
						{
							id: "old",
							message: "old bytes",
							filePath,
							tool: "slow-runner",
							severity: "warning",
							semantic: "warning",
						},
					],
					semantic: "warning",
				}),
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			await new Promise<void>((resolve) => setImmediate(resolve));
			const completed = (await drainPendingRunnerFindings(0))[0]!;
			deferRunnerFindings({
				...completed,
				markedAtMs,
				promise: Promise.resolve(completed.result!),
			});
			driftIntoFuture(filePath);
			expect(
				gateFindingsByPathFreshness({
					cwd: env.tmpDir,
					sources: {
						"test-runner": {
							findings: [{ filePath }],
							scannedAt: markedAtMs,
							citedPath: (finding: { filePath: string }) => finding.filePath,
						},
					},
				})["test-runner"].stale,
			).toHaveLength(1);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);

			const findings = cacheManager.readCache<{ content: string }>(
				"turn-end-findings",
				env.tmpDir,
			);
			expect(findings?.data?.content ?? "").not.toContain("old bytes");
			expect(pendingRunnerFindingsSize()).toBe(0);
			expect(getDegradationSummary()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "runner-findings-stale",
						latestReasons: [
							expect.objectContaining({
								subject: `slow-runner:${filePath}`,
							}),
						],
					}),
				]),
			);
			const runnerRecord = logLatency.mock.calls
				.map((call) => call[0])
				.find((entry: any) => entry?.phase === "late_runner_findings");
			expect(runnerRecord?.metadata).toMatchObject({
				delivered: 0,
				stale: 1,
				dropped: 1,
				deliveredIds: [],
			});
		} finally {
			env.cleanup();
		}
	});

	it("delivers a completed runner finding on a no-write turn", async () => {
		const env = setupTestEnvironment("pi-lens-runner-no-write-turn-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "runner-no-write-session" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const filePath = path.join(env.tmpDir, "runner.ts");
			fs.writeFileSync(filePath, "export const value = 1;\n");
			deferRunnerFindings({
				filePath,
				cwd: env.tmpDir,
				projectRoot: env.tmpDir,
				runnerId: "late-eslint",
				markedAtMs: Date.now() + 60_000,
				promise: Promise.resolve({
					status: "succeeded",
					diagnostics: [
						{
							id: "late-id",
							message: "late bytes",
							filePath,
							tool: "late-eslint",
							severity: "warning",
							semantic: "warning",
						},
					],
					semantic: "warning",
				}),
			});

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);

			const content =
				cacheManager.readCache<{ content: string }>(
					"turn-end-findings",
					env.tmpDir,
				)?.data?.content ?? "";
			expect(content).toContain("late-id");
			const runnerRecord = logLatency.mock.calls
				.map((call) => call[0])
				.find((entry: any) => entry?.phase === "late_runner_findings");
			expect(runnerRecord?.metadata).toMatchObject({
				delivered: 1,
				stale: 0,
				deliveredIds: ["late-id"],
			});
		} finally {
			env.cleanup();
		}
	});
	// #3796 item 1. Recurrence prevented: a deferred (collect-later) runner
	// whose findings fail its check reports `status: "failed"` WITH
	// diagnostics; turn end treated every `failed` as a broken runner and
	// `continue`d, so the agent got "Deferred runner pyright failed" and never
	// the type error. Only a failed result with NO diagnostics is broken.
	describe("deferred runner reporting failed (#3796)", () => {
		async function runDeferredFailed(opts: {
			diagnostics: Array<{ id: string; message: string; semantic: string }>;
			markedAtMs?: number;
			driftAfterMark?: boolean;
			failureMessage?: string;
			runnerId?: string;
			/** `null` leaves the result without a failureKind (the item-3 arms). */
			failureKind?: string | null;
		}) {
			const env = setupTestEnvironment("pi-lens-runner-failed-turnend-");
			try {
				const runtime = new RuntimeCoordinator();
				runtime.setTelemetryIdentity({ sessionId: "runner-failed-session" });
				runtime.beginTurn();
				const cacheManager = new CacheManager(false);
				const filePath = path.join(env.tmpDir, "runner.py");
				fs.writeFileSync(filePath, "x: int = 1\n");
				deferRunnerFindings({
					filePath,
					cwd: env.tmpDir,
					projectRoot: env.tmpDir,
					runnerId: opts.runnerId ?? "pyright",
					markedAtMs: opts.markedAtMs ?? Date.now() + 60_000,
					promise: Promise.resolve({
						status: "failed",
						...(opts.failureKind === null
							? {}
							: { failureKind: opts.failureKind ?? "blocking_diagnostics" }),
						failureMessage: opts.failureMessage,
						diagnostics: opts.diagnostics.map((d) => ({
							...d,
							filePath,
							tool: opts.runnerId ?? "pyright",
							severity: d.semantic === "blocking" ? "error" : "warning",
						})),
						semantic: "blocking",
					} as any),
				});
				if (opts.driftAfterMark) {
					await new Promise<void>((resolve) => setImmediate(resolve));
					await new Promise<void>((resolve) => setImmediate(resolve));
					driftIntoFuture(filePath);
				}
				await handleTurnEnd(
					makeTurnEndDeps(runtime, cacheManager, {
						ctxCwd: env.tmpDir,
						getFlag: (name: string) => name === "lens-guard",
					}),
				);
				const guard = cacheManager.readCache<{
					content: string;
					hasBlockers?: boolean;
				}>("turn-end-findings", env.tmpDir)?.data;
				const content = guard?.content ?? "";
				const record = logLatency.mock.calls
					.map((call) => call[0])
					.find((entry: any) => entry?.phase === "late_runner_findings");
				return {
					content,
					hasBlockers: guard?.hasBlockers,
					metadata: record?.metadata,
				};
			} finally {
				env.cleanup();
			}
		}

		it("delivers a failed deferred runner's blocking finding instead of a broken-runner note", async () => {
			const { content, metadata, hasBlockers } = await runDeferredFailed({
				diagnostics: [
					{
						id: "probe-type-error",
						message: "PROBE-TYPE-ERROR Type str is not assignable to int",
						semantic: "blocking",
					},
				],
			});
			expect(content).toContain("PROBE-TYPE-ERROR");
			expect(content).not.toContain("Deferred runner");
			// A blocking finding must not be framed as "no action required".
			expect(content).not.toContain("no action required");
			expect(content).toContain("blocking: fix before continuing");
			// The late part rides the advisory channel: it must not flip the
			// git guard (pre-existing channel for deferred findings).
			expect(hasBlockers).toBe(false);
			expect(metadata).toMatchObject({
				pending: 1,
				delivered: 1,
				failed: 0,
				stale: 0,
				deliveredIds: ["probe-type-error"],
			});
		});

		it("still reports a failed deferred runner with no diagnostics as broken", async () => {
			const { content, metadata } = await runDeferredFailed({
				diagnostics: [],
				failureMessage: "spawn ENOENT",
			});
			expect(content).toContain("Deferred runner pyright failed");
			expect(content).toContain("spawn ENOENT");
			expect(metadata).toMatchObject({ delivered: 0, failed: 1 });
		});

		it("delivers a failed deferred runner's warning-only finding as advisory", async () => {
			const { content, metadata } = await runDeferredFailed({
				diagnostics: [
					{ id: "warn-id", message: "WARN-ONLY-PROBE", semantic: "warning" },
				],
			});
			expect(content).toContain("WARN-ONLY-PROBE");
			expect(content).toContain("Advisory — no action required");
			expect(content).not.toContain("Deferred runner");
			expect(metadata).toMatchObject({ delivered: 1, failed: 0 });
		});

		// #3796 r2 F1. Recurrence prevented: keying only on diagnostics hid the
		// failure of runners that return `failed` + a failureKind + PARTIAL
		// diagnostics (rust-clippy timeout, lsp server_error, oxlint).
		it("reports a failed deferred runner with a fault kind as broken and still delivers its partial finding", async () => {
			const { content, metadata } = await runDeferredFailed({
				runnerId: "rust-clippy",
				failureKind: "timeout",
				diagnostics: [
					{
						id: "clippy-partial",
						message: "CLIPPY-PARTIAL-PROBE",
						semantic: "warning",
					},
				],
			});
			expect(content).toContain("Deferred runner rust-clippy failed (timeout)");
			expect(content).toContain("CLIPPY-PARTIAL-PROBE");
			expect(metadata).toMatchObject({
				delivered: 1,
				failed: 1,
				deliveredIds: ["clippy-partial"],
			});
		});

		// The four item-3 arms set no failureKind; until #3796 item 3 gives them
		// one they are indistinguishable from findings and are delivered.
		it("delivers a failed deferred result with diagnostics and no failureKind as findings", async () => {
			const { content, metadata } = await runDeferredFailed({
				failureKind: null,
				diagnostics: [
					{ id: "no-kind", message: "NO-KIND-PROBE", semantic: "warning" },
				],
			});
			expect(content).toContain("NO-KIND-PROBE");
			expect(content).not.toContain("Deferred runner");
			expect(metadata).toMatchObject({ delivered: 1, failed: 0 });
		});

		it("still drops a failed deferred runner's stale blocking finding", async () => {
			const { content, metadata } = await runDeferredFailed({
				markedAtMs: 1,
				driftAfterMark: true,
				diagnostics: [
					{
						id: "stale-id",
						message: "STALE-BLOCKING-PROBE",
						semantic: "blocking",
					},
				],
			});
			expect(content).not.toContain("STALE-BLOCKING-PROBE");
			expect(content).not.toContain("Deferred runner");
			expect(metadata).toMatchObject({
				delivered: 0,
				stale: 1,
				dropped: 1,
				failed: 0,
			});
		});
	});
});
