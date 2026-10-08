import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
});
