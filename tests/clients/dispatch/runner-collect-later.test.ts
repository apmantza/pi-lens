import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	classifyObservedRunner,
	COLLECT_LATER_THRESHOLD_MS,
	observeRunnerLatency,
	resetObservedRunnerLatency,
} from "../../../clients/dispatch/collect-later-tier.js";
import {
	drainPendingRunnerFindings,
	deferRunnerFindings,
	dropStaleRunnerFindings,
	peekSettledRunnerFindings,
	pendingRunnerFindingsSize,
	requeueRunnerFindings,
	resetPendingRunnerFindings,
	settlePendingRunnerFindingsForTests,
} from "../../../clients/dispatch/pending-runner-findings.js";
import { createGenerationSource } from "../../../clients/generation-guard.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import type { RunnerResult } from "../../../clients/dispatch/types.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../../clients/latency-logger.js";
import { readNdjsonRows } from "../../support/ndjson-rows.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../test-utils.js";

describe("observed runner collect-later tier (#2116)", () => {
	const projectRoot = setupTestEnvironment("pi-lens-runner-tier-").tmpDir;
	const filePath = join(projectRoot, "fixture.ts");

	afterAll(async () => {
		await cleanupTestEnvironmentsDrained("pi-lens-runner-tier-");
	});

	beforeEach(() => {
		resetObservedRunnerLatency();
		resetPendingRunnerFindings();
		resetDegradationLedger();
		writeFileSync(filePath, "const fixture = 1;\n");
	});

	it("moves a previously slow runner off the edit result and delivers its finding at turn end", async () => {
		observeRunnerLatency({
			projectRoot,
			runnerId: "fixture-runner",
			durationMs: COLLECT_LATER_THRESHOLD_MS + 1,
		});
		let resolve!: (result: RunnerResult) => void;
		const completed = new Promise<RunnerResult>((r) => (resolve = r));
		const registry = new RunnerRegistry();
		registry.register({
			id: "fixture-runner",
			appliesTo: ["jsts"],
			priority: 1,
			run: async () => completed,
		});
		const ctx = createDispatchContext(
			filePath,
			projectRoot,
			{ getFlag: () => false },
			new FactStore(),
		);
		Object.defineProperty(ctx, "writeIndex", { value: 1 });
		expect(
			classifyObservedRunner(ctx.projectRoot ?? ctx.cwd, "fixture-runner"),
		).toBe("collect-later");

		const edit = await Promise.race([
			dispatchForFile(
				ctx,
				[{ mode: "all", runnerIds: ["fixture-runner"] }],
				registry,
			),
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error("edit waited for deferred runner")),
					100,
				),
			),
		]);
		expect(edit.diagnostics).toEqual([]);

		resolve({
			status: "succeeded",
			diagnostics: [
				{
					id: "fixture-finding",
					message: "late finding",
					filePath,
					tool: "fixture-runner",
					severity: "warning",
					semantic: "warning",
				},
			],
			semantic: "warning",
		});
		const late = await drainPendingRunnerFindings(100);
		expect(late).toHaveLength(1);
		expect(late[0]?.result?.diagnostics[0]?.id).toBe("fixture-finding");
	}, 20_000);

	describe("#5413: one collect-later run in flight per (project, runner)", () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		/**
		 * A slow runner whose every run parks on its own gate, so the test owns
		 * when each run settles. `starts` counts runner starts, `peak` is the
		 * most runs in flight at once, and run N answers with finding `run-N`
		 * for the file it was given.
		 */
		function gatedRunner(runnerId: string) {
			const state = {
				starts: 0,
				inFlight: 0,
				peak: 0,
				/** The writeIndex each start ran for, in start order. */
				writes: [] as Array<number | undefined>,
			};
			const gates: Array<() => void> = [];
			const files: string[] = [];
			const registry = new RunnerRegistry();
			registry.register({
				id: runnerId,
				appliesTo: ["jsts"],
				priority: 1,
				run: async (runCtx) => {
					state.starts += 1;
					const n = state.starts;
					state.writes.push(runCtx.writeIndex);
					files.push(runCtx.filePath);
					state.inFlight += 1;
					state.peak = Math.max(state.peak, state.inFlight);
					await new Promise<void>((open) => gates.push(open));
					state.inFlight -= 1;
					return {
						status: "succeeded",
						diagnostics: [
							{
								id: `run-${n}`,
								message: `run ${n}`,
								filePath: runCtx.filePath,
								tool: runnerId,
								severity: "warning",
								semantic: "warning",
							},
						],
						semantic: "warning",
					};
				},
			});
			observeRunnerLatency({
				projectRoot,
				runnerId,
				durationMs: COLLECT_LATER_THRESHOLD_MS + 1,
			});
			return { state, gates, files, registry };
		}

		async function write(
			registry: RunnerRegistry,
			runnerId: string,
			file: string,
			writeIndex: number,
		) {
			const ctx = createDispatchContext(
				file,
				projectRoot,
				{ getFlag: () => false },
				new FactStore(),
			);
			Object.defineProperty(ctx, "writeIndex", { value: writeIndex });
			await dispatchForFile(
				ctx,
				[{ mode: "all", runnerIds: [runnerId] }],
				registry,
			);
		}

		/** Let a settled run's continuation start the next queued run. */
		async function settleTicks(): Promise<void> {
			for (let i = 0; i < 5; i++)
				await new Promise<void>((resolve) => setImmediate(resolve));
		}

		it("three quick writes start one run while the first is in flight, then one rerun for the latest bytes", async () => {
			vi.stubEnv("PI_LENS_TEST_MODE", "0");
			const { state, gates, registry } = gatedRunner("coalesce-runner");
			await flushLatencyLog();
			const logStart = existsSync(getLatencyLogPath())
				? statSync(getLatencyLogPath()).size
				: 0;
			await write(registry, "coalesce-runner", filePath, 1);
			await write(registry, "coalesce-runner", filePath, 2);
			await write(registry, "coalesce-runner", filePath, 3);
			// Recurrence: each write started its own run (runnerStarts=3,
			// peakConcurrent=3 in the 2026-11-08 probe).
			expect(state.starts).toBe(1);
			expect(state.peak).toBe(1);
			// The decision is on each write's pending row: writes 2 and 3 owe the
			// rerun, write 1 started the run.
			await flushLatencyLog();
			const read = readNdjsonRows<{
				runnerId?: string;
				status?: string;
				metadata?: { coalesced?: boolean };
			}>(getLatencyLogPath(), logStart);
			expect(read.skipped).toBe(0);
			expect(
				read.rows
					.filter(
						(row) =>
							row.runnerId === "coalesce-runner" && row.status === "pending",
					)
					.map((row) => row.metadata?.coalesced === true),
			).toEqual([false, true, true]);

			gates[0]?.();
			await settleTicks();
			// Writes 2 and 3 coalesce into ONE rerun, started only after the
			// first run settled.
			expect(state.starts).toBe(2);
			// The rerun answers for the latest write (3), not the write that queued
			// it (2): a later write to the file replaces the queued start.
			expect(state.writes).toEqual([1, 3]);
			expect(state.peak).toBe(1);
			gates[1]?.();
			await settlePendingRunnerFindingsForTests();
			expect(state.starts).toBe(2);

			const late = await drainPendingRunnerFindings(0);
			expect(
				late.map((entry) => [
					entry.writeIndex,
					entry.result?.diagnostics[0]?.id,
				]),
			).toEqual([
				[1, "run-1"],
				[2, "run-2"],
				[3, "run-2"],
			]);
		});

		it("queues each file once and runs the queue one at a time", async () => {
			const { state, gates, files, registry } = gatedRunner("queue-runner");
			const fileB = join(projectRoot, "b.ts");
			const fileC = join(projectRoot, "c.ts");
			writeFileSync(fileB, "const b = 1;\n");
			writeFileSync(fileC, "const c = 1;\n");
			await write(registry, "queue-runner", filePath, 1);
			await write(registry, "queue-runner", fileB, 1);
			await write(registry, "queue-runner", fileC, 1);
			await write(registry, "queue-runner", fileB, 2);
			expect(state.starts).toBe(1);
			for (let run = 0; run < 3; run++) {
				gates[run]?.();
				await settleTicks();
			}
			await settlePendingRunnerFindingsForTests();
			expect(state.peak).toBe(1);
			expect(files.map((file) => file.split(/[\\/]/).pop())).toEqual([
				"fixture.ts",
				"b.ts",
				"c.ts",
			]);
		});

		it("a session reset drops the queued rerun and the next write starts at once", async () => {
			const { state, gates, registry } = gatedRunner("reset-runner");
			await write(registry, "reset-runner", filePath, 1);
			await write(registry, "reset-runner", filePath, 2);
			expect(state.starts).toBe(1);

			// session_start: the store and the tier state reset in one tick.
			resetPendingRunnerFindings();
			resetObservedRunnerLatency();
			observeRunnerLatency({
				projectRoot,
				runnerId: "reset-runner",
				durationMs: COLLECT_LATER_THRESHOLD_MS + 1,
			});
			await write(registry, "reset-runner", filePath, 1);
			// The new session does not wait behind the retired session's run.
			expect(state.starts).toBe(2);

			gates[0]?.();
			await settleTicks();
			// The retired session's queued rerun never starts.
			expect(state.starts).toBe(2);
			// Nor does the retired run, settling, release the new session's
			// flight: a write now queues behind run 2 instead of running beside it.
			// Run 1 settled fast and observed the runner inline; keep it slow.
			observeRunnerLatency({
				projectRoot,
				runnerId: "reset-runner",
				durationMs: COLLECT_LATER_THRESHOLD_MS + 1,
			});
			await write(registry, "reset-runner", filePath, 2);
			expect(state.starts).toBe(2);
			gates[1]?.();
			await settleTicks();
			expect(state.starts).toBe(3);
			expect(state.inFlight).toBe(1);
			gates[2]?.();
			await settlePendingRunnerFindingsForTests();
			expect(state.starts).toBe(3);
		});
	});

	it("recovers to inline after a fast observed run", () => {
		expect(classifyObservedRunner(projectRoot, "fixture-runner")).toBe(
			"inline",
		);
		expect(
			observeRunnerLatency({
				projectRoot,
				runnerId: "fixture-runner",
				durationMs: COLLECT_LATER_THRESHOLD_MS + 1,
			}),
		).toBe("collect-later");
		expect(
			observeRunnerLatency({
				projectRoot,
				runnerId: "fixture-runner",
				durationMs: 1,
			}),
		).toBe("inline");
	});

	it("keeps a deferred failure visible and delivers the affirmative failure", async () => {
		observeRunnerLatency({
			projectRoot,
			runnerId: "failed-runner",
			durationMs: COLLECT_LATER_THRESHOLD_MS + 1,
		});
		let resolve!: (result: RunnerResult) => void;
		const registry = new RunnerRegistry();
		registry.register({
			id: "failed-runner",
			appliesTo: ["jsts"],
			priority: 1,
			run: async () => new Promise<RunnerResult>((r) => (resolve = r)),
		});
		const ctx = createDispatchContext(
			filePath,
			projectRoot,
			{ getFlag: () => false },
			new FactStore(),
		);
		Object.defineProperty(ctx, "writeIndex", { value: 1 });
		const edit = await dispatchForFile(
			ctx,
			[{ mode: "all", runnerIds: ["failed-runner"] }],
			registry,
		);
		expect(edit.output).toContain("failed-runner");
		expect(edit.output).toContain("Pending runners");

		resolve({
			status: "failed",
			diagnostics: [],
			semantic: "warning",
			failureKind: "timeout",
			failureMessage: "runner timed out",
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		const late = await drainPendingRunnerFindings(0);
		expect(late[0]?.result).toMatchObject({
			status: "failed",
			failureKind: "timeout",
		});
	});

	// #3796 item 2. Recurrence prevented: the collect-later runner row logged
	// only `{tier, delivered}`, so the log analyzer fell back to counting
	// diagnostics and filed a fault arm that carries a synthetic diagnostic as
	// a finding. Read back from the real latency.log sink.
	it("writes failureKind and failureMessage on the collect-later latency row", async () => {
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		try {
			const outcomes: Record<string, RunnerResult> = {
				"kind-runner": {
					status: "failed",
					diagnostics: [],
					semantic: "warning",
					failureKind: "parser_error",
					failureMessage: "kind-runner output could not be parsed",
				},
				"kindless-runner": {
					status: "failed",
					diagnostics: [],
					semantic: "warning",
				},
				"clean-runner": {
					status: "succeeded",
					diagnostics: [],
					semantic: "none",
				},
			};
			const registry = new RunnerRegistry();
			for (const runnerId of Object.keys(outcomes)) {
				observeRunnerLatency({
					projectRoot,
					runnerId,
					durationMs: COLLECT_LATER_THRESHOLD_MS + 1,
				});
				registry.register({
					id: runnerId,
					appliesTo: ["jsts"],
					priority: 1,
					run: async () => outcomes[runnerId],
				});
			}
			const ctx = createDispatchContext(
				filePath,
				projectRoot,
				{ getFlag: () => false },
				new FactStore(),
			);
			Object.defineProperty(ctx, "writeIndex", { value: 1 });
			await dispatchForFile(
				ctx,
				[{ mode: "all", runnerIds: Object.keys(outcomes) }],
				registry,
			);
			await drainPendingRunnerFindings(100);
			await flushLatencyLog();
			const rows = readFileSync(getLatencyLogPath(), "utf-8")
				.trim()
				.split("\n")
				.map(
					(line) =>
						JSON.parse(line) as {
							type?: string;
							runnerId?: string;
							status?: string;
							filePath?: string;
							metadata?: { tier?: string };
						},
				)
				.filter(
					(row) =>
						row.type === "runner" &&
						row.metadata?.tier === "collect-later" &&
						row.status !== "pending" &&
						row.filePath === filePath,
				);
			const metadataOf = (runnerId: string) =>
				rows.find((row) => row.runnerId === runnerId)?.metadata;
			expect(metadataOf("kind-runner")).toEqual({
				tier: "collect-later",
				delivered: "turn_end",
				failureKind: "parser_error",
				failureMessage: "kind-runner output could not be parsed",
			});
			expect(metadataOf("kindless-runner")).toEqual({
				tier: "collect-later",
				delivered: "turn_end",
			});
			expect(metadataOf("clean-runner")).toEqual({
				tier: "collect-later",
				delivered: "turn_end",
			});
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("does not defer a slow observation outside a write dispatch", async () => {
		observeRunnerLatency({
			projectRoot,
			runnerId: "direct-runner",
			durationMs: COLLECT_LATER_THRESHOLD_MS + 1,
		});
		const registry = new RunnerRegistry();
		registry.register({
			id: "direct-runner",
			appliesTo: ["jsts"],
			priority: 1,
			run: async () => ({
				status: "succeeded",
				diagnostics: [
					{
						id: "direct",
						message: "direct",
						filePath,
						tool: "direct",
						severity: "warning",
						semantic: "warning",
					},
				],
				semantic: "warning",
			}),
		});
		const ctx = createDispatchContext(
			filePath,
			projectRoot,
			{ getFlag: () => false },
			new FactStore(),
		);
		const result = await dispatchForFile(
			ctx,
			[{ mode: "all", runnerIds: ["direct-runner"] }],
			registry,
		);
		expect(result.diagnostics).toHaveLength(1);
		expect(result.output).not.toContain("Pending runners");
		expect(await drainPendingRunnerFindings(0)).toEqual([]);
	});

	it("records the runner and file when the pending cap evicts an entry", () => {
		for (let i = 0; i <= 50; i++) {
			deferRunnerFindings({
				filePath: `${projectRoot}/evicted-${i}.ts`,
				cwd: projectRoot,
				projectRoot,
				runnerId: `runner-${i}`,
				markedAtMs: Date.now(),
				promise: new Promise<RunnerResult>(() => {}),
			});
		}
		const group = getDegradationSummary().find(
			(entry) => entry.kind === "runner-findings-evicted",
		);
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]?.subject).toContain("runner-0");
	});

	it("drops a stale completed result and records the coverage gap", async () => {
		const result: RunnerResult = {
			status: "succeeded",
			diagnostics: [
				{
					id: "stale",
					message: "stale",
					filePath,
					tool: "runner",
					severity: "warning",
					semantic: "warning",
				},
			],
			semantic: "warning",
		};
		deferRunnerFindings({
			filePath,
			cwd: projectRoot,
			projectRoot,
			runnerId: "stale-runner",
			markedAtMs: 1,
			promise: Promise.resolve(result),
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		const stale = (await drainPendingRunnerFindings(0))[0];
		dropStaleRunnerFindings(stale!);
		expect(await drainPendingRunnerFindings(0)).toEqual([]);
		expect(getDegradationSummary()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "runner-findings-stale",
					latestReasons: [
						expect.objectContaining({
							subject: `stale-runner:${filePath}`,
						}),
					],
				}),
			]),
		);
	});

	describe("#3568: a dispatch that straddles a session replacement", () => {
		/**
		 * An inline runner parks the group; the collect-later runner after it is
		 * deferred only once the gate opens, after the test's `/new`.
		 */
		async function deferAfterGate(replace: boolean) {
			observeRunnerLatency({
				projectRoot,
				runnerId: "fixture-runner",
				durationMs: COLLECT_LATER_THRESHOLD_MS + 1,
			});
			let open!: () => void;
			const gate = new Promise<void>((r) => (open = r));
			let entered!: () => void;
			const parked = new Promise<void>((r) => (entered = r));
			const registry = new RunnerRegistry();
			registry.register({
				id: "gate-runner",
				appliesTo: ["jsts"],
				priority: 1,
				run: async () => {
					entered();
					await gate;
					return { status: "succeeded", diagnostics: [], semantic: "none" };
				},
			});
			registry.register({
				id: "fixture-runner",
				appliesTo: ["jsts"],
				priority: 2,
				run: async () => ({
					status: "succeeded",
					diagnostics: [],
					semantic: "warning",
				}),
			});
			const sessions = createGenerationSource("test-runtime-session");
			const ctx = createDispatchContext(
				filePath,
				projectRoot,
				{ getFlag: () => false },
				new FactStore(),
				undefined,
				undefined,
				undefined,
				1,
				undefined,
				undefined,
				sessions.capture(),
			);
			const dispatch = dispatchForFile(
				ctx,
				[{ mode: "all", runnerIds: ["gate-runner", "fixture-runner"] }],
				registry,
			);
			await parked;
			// session_start clears the store and bumps the generation in one tick.
			if (replace) {
				resetPendingRunnerFindings();
				sessions.bump();
			}
			open();
			await dispatch;
			return pendingRunnerFindingsSize();
		}

		it("a session-1 dispatch defers no runner into session 2's store", async () => {
			expect(await deferAfterGate(true)).toBe(0);
			expect(
				getDegradationSummary()
					.filter((entry) => entry.kind === "generation-guard-stale-write")
					.flatMap((entry) => entry.latestReasons.map((r) => r.subject)),
			).toEqual([
				`test-runtime-session:fixture-runner:${normalizeMapKey(filePath)}`,
			]);
		});

		it("no-drop (shape 54): a dispatch still in its session defers its runner", async () => {
			expect(await deferAfterGate(false)).toBe(1);
		});
	});

	it("drops a requeued, capacity-held result once its scope has retired (#3758/#3813)", async () => {
		const sessions = createGenerationSource("test-runtime-session");
		deferRunnerFindings({
			filePath,
			cwd: projectRoot,
			projectRoot,
			runnerId: "requeue-runner",
			markedAtMs: Date.now(),
			promise: Promise.resolve({
				status: "succeeded",
				diagnostics: [],
				semantic: "warning",
			}),
			session: sessions.capture(),
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		// The turn-end cap cut the part that carried this settled answer, so the
		// delivery hold hands it back for the next turn end (#3813). The drained
		// entry carries the producer's handle; without it the requeue re-enters
		// unfenced and the next drain delivers it into the successor scope.
		const drained = (await drainPendingRunnerFindings(0))[0]!;
		requeueRunnerFindings({ ...drained, result: drained.result! });
		// `/new`: the scope that owned the result retired before the next turn end.
		sessions.bump();

		// The snapshot preserved the producer's handle, so both the gate's peek
		// and the turn-end drain reject the requeued entry after the retire.
		expect(peekSettledRunnerFindings()).toEqual([]);
		expect(await drainPendingRunnerFindings(0)).toEqual([]);
		expect(pendingRunnerFindingsSize()).toBe(0);
		expect(
			getDegradationSummary()
				.filter((entry) => entry.kind === "generation-guard-stale-write")
				.flatMap((entry) => entry.latestReasons.map((row) => row.subject)),
		).toEqual([
			expect.stringContaining("commit-gate:requeue-runner"),
			expect.stringContaining("turn-end:requeue-runner"),
		]);
	});

	it("drops a retired scope's settled answer from the gate's peek (#3758/#3814)", async () => {
		const sessions = createGenerationSource("test-runtime-session");
		deferRunnerFindings({
			filePath,
			cwd: projectRoot,
			projectRoot,
			runnerId: "peek-runner",
			markedAtMs: Date.now(),
			promise: Promise.resolve({
				status: "succeeded",
				diagnostics: [],
				semantic: "warning",
			}),
			session: sessions.capture(),
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		sessions.bump();

		// The commit gate's read is non-draining and applies the same owned
		// admission the turn-end drain does.
		expect(peekSettledRunnerFindings()).toEqual([]);
		expect(pendingRunnerFindingsSize()).toBe(1);
		expect(
			getDegradationSummary()
				.filter((entry) => entry.kind === "generation-guard-stale-write")
				.flatMap((entry) => entry.latestReasons.map((row) => row.subject)),
		).toEqual([expect.stringContaining("commit-gate:peek-runner")]);
	});

	it("no-drop (shape 54): admits a released writer's deferral with no captured handle", async () => {
		// Shape 57: a producer from a released version defers without a session.
		// The fence narrows known-retired answers; it never drops an unfenced one.
		deferRunnerFindings({
			filePath,
			cwd: projectRoot,
			projectRoot,
			runnerId: "released-runner",
			markedAtMs: Date.now(),
			promise: Promise.resolve({
				status: "succeeded",
				diagnostics: [],
				semantic: "warning",
			}),
		});
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(peekSettledRunnerFindings().map((entry) => entry.filePath)).toEqual([
			filePath,
		]);
		expect(
			(await drainPendingRunnerFindings(0)).map((entry) => entry.filePath),
		).toEqual([filePath]);
	});

	// Recurrence: the tier-flip row and the `runner-collect-later` record were
	// spelled twice in dispatcher.ts (the collect-later run and the inline run);
	// a copy edited alone would flip a runner's tier without its row, or count a
	// slow run on one path only. Each cell drives one former copy through
	// dispatchForFile and reads the rows back.
	describe("one tier observation for every runner run (fold of two copies)", () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		const SLOW: RunnerResult = {
			status: "failed",
			diagnostics: [],
			semantic: "warning",
			failureKind: "timeout",
		};
		const FAST: RunnerResult = {
			status: "succeeded",
			diagnostics: [],
			semantic: "none",
		};

		async function runOnce(
			runnerId: string,
			result: RunnerResult,
			writeIndex: number | undefined,
		) {
			vi.stubEnv("PI_LENS_TEST_MODE", "0");
			const registry = new RunnerRegistry();
			registry.register({
				id: runnerId,
				appliesTo: ["jsts"],
				priority: 1,
				run: async () => result,
			});
			const ctx = createDispatchContext(
				filePath,
				projectRoot,
				{ getFlag: () => false },
				new FactStore(),
			);
			if (writeIndex !== undefined) {
				Object.defineProperty(ctx, "writeIndex", { value: writeIndex });
			}
			await dispatchForFile(
				ctx,
				[{ mode: "all", runnerIds: [runnerId] }],
				registry,
			);
			await drainPendingRunnerFindings(100);
			await flushLatencyLog();
			const flips = readFileSync(getLatencyLogPath(), "utf-8")
				.trim()
				.split("\n")
				.map(
					(line) =>
						JSON.parse(line) as {
							type?: string;
							phase?: string;
							filePath?: string;
							metadata?: Record<string, unknown>;
						},
				)
				.filter(
					(row) =>
						row.type === "phase" &&
						row.phase === "runner_collect_later_tier_flip" &&
						row.filePath === filePath &&
						row.metadata?.runnerId === runnerId,
				)
				.map((row) => row.metadata);
			const counted = getDegradationSummary().find(
				(entry) => entry.kind === "runner-collect-later",
			);
			return { flips, counted };
		}

		it("an inline post-write run that times out flips the runner to collect-later, with its row and one count", async () => {
			const { flips, counted } = await runOnce("flip-down-runner", SLOW, 1);
			expect(flips).toEqual([
				{
					runnerId: "flip-down-runner",
					from: "inline",
					to: "collect-later",
					projectRoot,
				},
			]);
			expect(counted?.count).toBe(1);
			expect(counted?.latestReasons[0]?.subject).toBe(
				`${projectRoot}:flip-down-runner`,
			);
			expect(counted?.latestReasons[0]?.reason).toMatch(
				/^observed \d+ms, threshold 5000ms \(count: 1\)$/,
			);
			expect(classifyObservedRunner(projectRoot, "flip-down-runner")).toBe(
				"collect-later",
			);
		});

		it("an inline post-write run that stays fast leaves no flip row and no count", async () => {
			const { flips, counted } = await runOnce("steady-runner", FAST, 1);
			expect(flips).toEqual([]);
			expect(counted).toBeUndefined();
			expect(classifyObservedRunner(projectRoot, "steady-runner")).toBe(
				"inline",
			);
		});

		it("a collect-later run that finishes fast recovers the runner with its flip row and no count", async () => {
			observeRunnerLatency({
				projectRoot,
				runnerId: "recovering-runner",
				durationMs: COLLECT_LATER_THRESHOLD_MS + 1,
			});
			const { flips, counted } = await runOnce("recovering-runner", FAST, 1);
			expect(flips).toEqual([
				{
					runnerId: "recovering-runner",
					from: "collect-later",
					to: "inline",
					projectRoot,
				},
			]);
			expect(counted).toBeUndefined();
			expect(classifyObservedRunner(projectRoot, "recovering-runner")).toBe(
				"inline",
			);
		});

		it("a collect-later run that is slow again counts once and writes no flip row", async () => {
			observeRunnerLatency({
				projectRoot,
				runnerId: "still-slow-runner",
				durationMs: COLLECT_LATER_THRESHOLD_MS + 1,
			});
			const { flips, counted } = await runOnce("still-slow-runner", SLOW, 1);
			expect(flips).toEqual([]);
			expect(counted?.count).toBe(1);
			expect(counted?.latestReasons[0]?.subject).toBe(
				`${projectRoot}:still-slow-runner`,
			);
			expect(counted?.latestReasons[0]?.reason).toMatch(
				/^observed \d+ms, threshold 5000ms \(count: 1\)$/,
			);
			expect(classifyObservedRunner(projectRoot, "still-slow-runner")).toBe(
				"collect-later",
			);
		});

		it("a dispatch with no write index observes nothing: no tier, no flip row, no count", async () => {
			const { flips, counted } = await runOnce(
				"direct-slow-runner",
				SLOW,
				undefined,
			);
			expect(flips).toEqual([]);
			expect(counted).toBeUndefined();
			expect(classifyObservedRunner(projectRoot, "direct-slow-runner")).toBe(
				"inline",
			);
		});
	});
});
