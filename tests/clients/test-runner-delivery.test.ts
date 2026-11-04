import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { snapshotAdvisoryProvenance } from "../../clients/advisory-provenance.js";
import { resetBoundedTelemetry } from "../../clients/bounded-telemetry.js";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	clearLatencyLog,
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import {
	_resetTestRunnerDeliveryForTests,
	consumeStagedTestRunnerFindings,
	deliverTestRunnerFindings,
	deliverStagedTestRunnerFindings,
	resetTestRunnerDelivery,
	stageTestRunnerDelivery,
} from "../../clients/test-runner-delivery.js";
import { KnipClient } from "../../clients/knip-client.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import {
	type TestResult,
	TestRunnerClient,
} from "../../clients/test-runner-client.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("automatic test-runner delivery (#2366)", () => {
	// Records are read back from the real latency sink (AGENTS.md: flush and
	// read the real sink), so a logger that drops them reds these cells.
	// PI_LENS_TEST_MODE=0 is the sanctioned opt-out that lets the logger write;
	// the harness's per-worker PI_LENS_HOME keeps the sink private to this file.
	let previousTestMode: string | undefined;
	beforeEach(async () => {
		previousTestMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		clearLatencyLog();
		await flushLatencyLog();
	});

	afterEach(async () => {
		_resetTestRunnerDeliveryForTests();
		resetBoundedTelemetry();
		resetDegradationLedger();
		clearLatencyLog();
		await flushLatencyLog();
		if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
		else process.env.PI_LENS_TEST_MODE = previousTestMode;
	});

	/** Metadata of each `phase` record on the real latency log, oldest first. */
	async function latencyMetadata(
		phase: string,
	): Promise<Array<Record<string, unknown>>> {
		await flushLatencyLog();
		const file = getLatencyLogPath();
		const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
		return text
			.split(/\r?\n/)
			.filter(Boolean)
			.map(
				(line) =>
					JSON.parse(line) as {
						phase?: string;
						metadata?: Record<string, unknown>;
					},
			)
			.filter((entry) => entry.phase === phase)
			.map((entry) => entry.metadata ?? {});
	}

	const deliveryRecords = () => latencyMetadata("test_runner_delivery");

	const deliveryOutcomes = async (): Promise<unknown[]> =>
		(await deliveryRecords()).map((record) => record.outcome);

	function setup() {
		const env = setupTestEnvironment("pi-lens-test-delivery-");
		const cache = new CacheManager(false);
		const runtime = new RuntimeCoordinator();
		runtime.setTelemetryIdentity({ sessionId: "session-a" });
		cache.writeCache(
			"test-runner-findings",
			{ content: "FAIL test/app.test.ts:1", testRunGeneration: 1 },
			env.tmpDir,
		);
		return { env, cache, runtime };
	}

	/**
	 * A batch publish as turn_end writes it: content, the launch generation,
	 * and the provenance stamp of the generation that produced the content.
	 */
	function publishStamped(
		cwd: string,
		cache: CacheManager,
		runtime: RuntimeCoordinator,
		generation: number,
	): string {
		const file = path.join(cwd, "src", "app.ts");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "export const x = 1;\n");
		const content = `FAIL app.test.ts generation-${generation}`;
		cache.writeCache(
			"test-runner-findings",
			{
				content,
				testRunGeneration: generation,
				provenance: snapshotAdvisoryProvenance({
					cwd,
					runtime,
					generation,
					files: [{ path: file, role: "test" }],
				}),
			},
			cwd,
		);
		return content;
	}

	it("delivers once through context without appending a terminal entry", () => {
		const { env, cache, runtime } = setup();
		try {
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			deliverTestRunnerFindings({
				ctx: { cwd: env.tmpDir, isIdle: () => true },
				cacheManager: cache,
				runtime,
				sessionId: "session-a",
			});
			expect(
				cache.readCache<{
					deliveryEligible?: { sessionId: string; generation: number };
				}>("test-runner-findings", env.tmpDir)?.data.deliveryEligible,
			).toMatchObject({ sessionId: "session-a", generation: 1 });
			// This is the exact reset invoked by production handleSessionStart.
			resetTestRunnerDelivery();

			expect(
				cache.readCache<{ content: string }>("test-runner-findings", env.tmpDir)
					?.data.content,
			).toContain("FAIL");
			const context = consumeStagedTestRunnerFindings({
				cwd: env.tmpDir,
				sessionId: "session-a",
				cacheManager: cache,
				runtime,
			});
			expect(context?.messages).toHaveLength(1);
			expect(context?.messages[0]?.content).toContain(
				"[pi-lens automated check — not a user request]",
			);
			expect(context?.messages[0]?.content).toContain("FAIL");
			expect(
				cache.readCache<Record<string, unknown>>(
					"test-runner-findings",
					env.tmpDir,
				)?.data.content,
			).toBe("");
			resetTestRunnerDelivery();
			expect(
				consumeStagedTestRunnerFindings({
					cwd: env.tmpDir,
					sessionId: "session-a",
					cacheManager: cache,
					runtime,
				}),
			).toBeUndefined();
			expect(
				cache.readCache<{ deliveryEligible?: unknown }>(
					"test-runner-findings",
					env.tmpDir,
				)?.data.deliveryEligible,
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("records the run-for and delivery file sequences for each delivered verdict (#2542)", async () => {
		const { env, cache, runtime } = setup();
		try {
			const sourceFile = path.join(env.tmpDir, "src/app.ts");
			runtime.recordProjectMutation({
				filePath: sourceFile,
				source: "agent-edit",
			});
			cache.writeCache(
				"test-runner-findings",
				{
					content: "FAIL app.test.ts",
					testRunGeneration: 1,
					verdicts: [
						{
							file: "app.test.ts",
							sourceFile,
							fileSeq: { state: "known", value: 1 },
						},
					],
				},
				env.tmpDir,
			);
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			runtime.recordProjectMutation({
				filePath: sourceFile,
				source: "agent-edit",
			});
			deliverTestRunnerFindings({
				ctx: { cwd: env.tmpDir, isIdle: () => true },
				cacheManager: cache,
				runtime,
				sessionId: "session-a",
			});
			consumeStagedTestRunnerFindings({
				cwd: env.tmpDir,
				sessionId: "session-a",
				cacheManager: cache,
				runtime,
			});

			expect(
				await latencyMetadata("test_runner_verdict_delivery"),
			).toContainEqual(
				expect.objectContaining({
					sessionId: "session-a",
					verdictCount: 1,
					staleCount: 1,
					unknownCount: 0,
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("delivers a stale verdict with its edit gap and re-queues a run for the current file (#2542)", async () => {
		const { env, cache, runtime } = setup();
		try {
			const sourceFile = path.join(env.tmpDir, "src/app.ts");
			const testFile = path.join(env.tmpDir, "app.test.ts");
			runtime.recordProjectMutation({
				filePath: sourceFile,
				source: "agent-edit",
			});
			cache.writeCache(
				"test-runner-findings",
				{
					content: "FAIL app.test.ts",
					testRunGeneration: 1,
					verdicts: [
						{
							file: testFile,
							sourceFile,
							runner: "vitest",
							fileSeq: { state: "known", value: 1 },
						},
					],
				},
				env.tmpDir,
			);
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			// Two later edits: the delivery gap is 2, and the run is for a file
			// state the agent has moved past.
			runtime.recordProjectMutation({
				filePath: sourceFile,
				source: "agent-edit",
			});
			runtime.recordProjectMutation({
				filePath: sourceFile,
				source: "agent-edit",
			});
			deliverTestRunnerFindings({
				ctx: { cwd: env.tmpDir, isIdle: () => true },
				cacheManager: cache,
				runtime,
				sessionId: "session-a",
			});
			const findings = consumeStagedTestRunnerFindings({
				cwd: env.tmpDir,
				sessionId: "session-a",
				cacheManager: cache,
				runtime,
			});

			expect(findings?.messages[0]?.content).toContain(
				`verdict for an older version of ${sourceFile} (2 edits ago); re-running`,
			);
			expect(findings?.messages[0]?.content).toContain("FAIL app.test.ts");
			// The re-queue rides the deferred-target list the next turn_end
			// dispatches first, stamped to the session that saw the verdict.
			expect(
				cache.readCache<{
					deferredTargets?: Array<Record<string, unknown>>;
				}>("test-runner-findings", env.tmpDir)?.data.deferredTargets,
			).toEqual([
				expect.objectContaining({
					testFile,
					sourceFile,
					runner: "vitest",
					sessionId: "session-a",
				}),
			]);
			expect(
				await latencyMetadata("test_runner_verdict_delivery"),
			).toContainEqual(
				expect.objectContaining({
					staleCount: 1,
					staleGaps: [2],
					rerunQueued: 1,
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("delivers a current verdict unchanged and queues nothing (#2542)", async () => {
		const { env, cache, runtime } = setup();
		try {
			const sourceFile = path.join(env.tmpDir, "src/fresh.ts");
			const testFile = path.join(env.tmpDir, "fresh.test.ts");
			runtime.recordProjectMutation({
				filePath: sourceFile,
				source: "agent-edit",
			});
			cache.writeCache(
				"test-runner-findings",
				{
					content: "FAIL fresh.test.ts",
					testRunGeneration: 1,
					verdicts: [
						{
							file: testFile,
							sourceFile,
							runner: "vitest",
							fileSeq: { state: "known", value: 1 },
						},
					],
				},
				env.tmpDir,
			);
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			deliverTestRunnerFindings({
				ctx: { cwd: env.tmpDir, isIdle: () => true },
				cacheManager: cache,
				runtime,
				sessionId: "session-a",
			});
			const findings = consumeStagedTestRunnerFindings({
				cwd: env.tmpDir,
				sessionId: "session-a",
				cacheManager: cache,
				runtime,
			});

			expect(findings?.messages[0]?.content).not.toContain(
				"verdict for an older version of",
			);
			expect(
				cache.readCache<{ deferredTargets?: unknown }>(
					"test-runner-findings",
					env.tmpDir,
				)?.data.deferredTargets,
			).toBeUndefined();
			expect(
				await latencyMetadata("test_runner_verdict_delivery"),
			).toContainEqual(
				expect.objectContaining({
					staleCount: 0,
					rerunQueued: 0,
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("delivers an unknown-sequence verdict unchanged and queues nothing (#2542)", async () => {
		const { env, cache, runtime } = setup();
		try {
			const sourceFile = path.join(env.tmpDir, "src/legacy.ts");
			const testFile = path.join(env.tmpDir, "legacy.test.ts");
			runtime.recordProjectMutation({
				filePath: sourceFile,
				source: "agent-edit",
			});
			cache.writeCache(
				"test-runner-findings",
				{
					content: "FAIL legacy.test.ts",
					testRunGeneration: 1,
					// A runner is present: the unknown sequence, not a missing runner,
					// is what must keep this verdict out of the re-queue.
					verdicts: [{ file: testFile, sourceFile, runner: "vitest" }],
				} as never,
				env.tmpDir,
			);
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			runtime.recordProjectMutation({
				filePath: sourceFile,
				source: "agent-edit",
			});
			deliverTestRunnerFindings({
				ctx: { cwd: env.tmpDir, isIdle: () => true },
				cacheManager: cache,
				runtime,
				sessionId: "session-a",
			});
			const findings = consumeStagedTestRunnerFindings({
				cwd: env.tmpDir,
				sessionId: "session-a",
				cacheManager: cache,
				runtime,
			});

			expect(findings?.messages[0]?.content).not.toContain(
				"verdict for an older version of",
			);
			expect(
				cache.readCache<{ deferredTargets?: unknown }>(
					"test-runner-findings",
					env.tmpDir,
				)?.data.deferredTargets,
			).toBeUndefined();
			expect(
				await latencyMetadata("test_runner_verdict_delivery"),
			).toContainEqual(
				expect.objectContaining({
					staleCount: 0,
					unknownCount: 1,
					rerunQueued: 0,
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("legacy verdict without file sequence is delivered as unknown through the real idle path", async () => {
		const { env, cache, runtime } = setup();
		try {
			const sourceFile = path.join(env.tmpDir, "src/legacy.ts");
			runtime.recordProjectMutation({
				filePath: sourceFile,
				source: "agent-edit",
			});
			cache.writeCache(
				"test-runner-findings",
				{
					content: "FAIL legacy.test.ts",
					testRunGeneration: 1,
					verdicts: [
						{ file: "legacy.test.ts", sourceFile },
						{ file: "legacy.test.ts", sourceFile },
					],
				} as never,
				env.tmpDir,
			);
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 2,
				hasFindings: true,
			});
			deliverTestRunnerFindings({
				ctx: { cwd: env.tmpDir, isIdle: () => true },
				cacheManager: cache,
				runtime,
				sessionId: "session-a",
			});
			const findings = consumeStagedTestRunnerFindings({
				cwd: env.tmpDir,
				sessionId: "session-a",
				cacheManager: cache,
				runtime,
			});

			expect(findings?.messages).toHaveLength(1);
			expect(
				await latencyMetadata("test_runner_verdict_delivery"),
			).toContainEqual(
				expect.objectContaining({
					verdictCount: 0,
					staleCount: 0,
					unknownCount: 2,
				}),
			);
			const ledger = getDegradationSummary().find(
				(group) => group.kind === "test-runner-delivery",
			);
			expect(ledger?.count).toBe(1);
			expect(ledger?.latestReasons).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});

	it("does not rehydrate an eligible marker into a different session", () => {
		const { env, cache, runtime } = setup();
		try {
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			deliverTestRunnerFindings({
				ctx: { cwd: env.tmpDir, isIdle: () => true },
				cacheManager: cache,
				runtime,
				sessionId: "session-a",
			});

			// Production session_start clears only the in-memory pointer.
			resetTestRunnerDelivery();
			const secondaryRuntime = new RuntimeCoordinator();
			secondaryRuntime.setTelemetryIdentity({ sessionId: "session-b" });
			expect(
				consumeStagedTestRunnerFindings({
					cwd: env.tmpDir,
					sessionId: "session-b",
					cacheManager: cache,
					runtime: secondaryRuntime,
				}),
			).toBeUndefined();
			expect(
				cache.readCache<{
					content: string;
					deliveryEligible?: { sessionId: string };
				}>("test-runner-findings", env.tmpDir)?.data,
			).toMatchObject({
				content: "FAIL test/app.test.ts:1",
				deliveryEligible: { sessionId: "session-a" },
			});

			const findings = consumeStagedTestRunnerFindings({
				cwd: env.tmpDir,
				sessionId: "session-a",
				cacheManager: cache,
				runtime,
			});
			expect(findings?.messages).toHaveLength(1);
			expect(findings?.messages[0]?.content).toContain("FAIL");
			expect(
				consumeStagedTestRunnerFindings({
					cwd: env.tmpDir,
					sessionId: "session-a",
					cacheManager: cache,
					runtime,
				}),
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("rehydrates a shared-cache marker after quit-and-resume", () => {
		const { env, cache, runtime } = setup();
		try {
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				owner: {
					ownerId: "activation-a",
					cacheManager: cache,
					runtime,
					getCtx: () => ({ cwd: env.tmpDir, isIdle: () => true }),
				},
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			deliverTestRunnerFindings({
				ctx: { cwd: env.tmpDir, isIdle: () => true },
				cacheManager: cache,
				runtime,
				sessionId: "session-a",
				ownerId: "activation-a",
			});
			resetTestRunnerDelivery();

			const resumed = consumeStagedTestRunnerFindings({
				cwd: env.tmpDir,
				sessionId: "session-a",
				ownerId: "activation-b",
				cacheManager: cache,
				runtime,
			});
			expect(resumed?.messages).toHaveLength(1);
			expect(resumed?.messages[0]?.content).toContain("FAIL");
		} finally {
			env.cleanup();
		}
	});

	it("carries a result when a prompt makes the immediate idle check fail", async () => {
		const { env, cache, runtime } = setup();
		try {
			let idle = false;
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			const deliver = () =>
				deliverTestRunnerFindings({
					ctx: { cwd: env.tmpDir, isIdle: () => idle },
					cacheManager: cache,
					runtime,
					sessionId: "session-a",
				});
			const consume = () =>
				consumeStagedTestRunnerFindings({
					cwd: env.tmpDir,
					sessionId: "session-a",
					cacheManager: cache,
					runtime,
				});
			deliver();
			expect(await deliveryOutcomes()).toEqual(["staged", "carried"]);
			expect(consume()).toBeUndefined();
			idle = true;
			deliver();
			expect(await deliveryOutcomes()).toEqual([
				"staged",
				"carried",
				"eligible",
			]);
			expect(consume()?.messages[0]?.content).toContain("FAIL");
		} finally {
			env.cleanup();
		}
	});

	it("rechecks idleness immediately before append", () => {
		const { env, cache, runtime } = setup();
		try {
			let checks = 0;
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			deliverTestRunnerFindings({
				ctx: {
					cwd: env.tmpDir,
					isIdle: () => ++checks === 1,
				},
				cacheManager: cache,
				runtime,
				sessionId: "session-a",
			});
			expect(checks).toBe(2);
		} finally {
			env.cleanup();
		}
	});

	it("retains a result when a stale host context rejects idle access", () => {
		const { env, cache, runtime } = setup();
		try {
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			expect(() =>
				deliverTestRunnerFindings({
					ctx: {
						cwd: env.tmpDir,
						isIdle: () => {
							throw new Error("stale context");
						},
					},
					cacheManager: cache,
					runtime,
					sessionId: "session-a",
				}),
			).not.toThrow();
		} finally {
			env.cleanup();
		}
	});

	it("does not resurrect an older generation after a clean result supersedes it", async () => {
		const { env, cache, runtime } = setup();
		try {
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			cache.writeCache(
				"test-runner-findings",
				{ content: "", testRunGeneration: 2 },
				env.tmpDir,
			);
			// Staging the clean result drops generation 1's pending delivery, so
			// delivery finds nothing left to supersede: one "superseded" record.
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 2,
				targetCount: 1,
				hasFindings: false,
			});
			deliverTestRunnerFindings({
				ctx: { cwd: env.tmpDir, isIdle: () => true },
				cacheManager: cache,
				runtime,
				sessionId: "session-a",
			});
			expect(await deliveryOutcomes()).toEqual(["staged", "superseded"]);
			expect(
				cache.readCache<{ deliveryEligible?: unknown }>(
					"test-runner-findings",
					env.tmpDir,
				)?.data.deliveryEligible,
			).toBeUndefined();
			expect(
				consumeStagedTestRunnerFindings({
					cwd: env.tmpDir,
					sessionId: "session-a",
					cacheManager: cache,
					runtime,
				}),
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("drops a pending older generation while newer findings remain cached", () => {
		const { env, cache, runtime } = setup();
		try {
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			// Keep generation 1 pending. Only the persisted cache high-water mark
			// advances, so this assertion is red if the delivery guard is removed.
			cache.writeCache(
				"test-runner-findings",
				{ content: "FAIL newer-generation.test.ts:1", testRunGeneration: 2 },
				env.tmpDir,
			);
			deliverTestRunnerFindings({
				ctx: { cwd: env.tmpDir, isIdle: () => true },
				cacheManager: cache,
				runtime,
				sessionId: "session-a",
			});
			expect(
				cache.readCache<{ content: string }>("test-runner-findings", env.tmpDir)
					?.data.content,
			).toContain("newer-generation");
		} finally {
			env.cleanup();
		}
	});

	it("delivers each activation's staged result through its own owner", async () => {
		const { env, cache, runtime } = setup();
		try {
			const secondaryRuntime = new RuntimeCoordinator();
			secondaryRuntime.setTelemetryIdentity({ sessionId: "session-b" });
			// Both results publish while their runs are going (pi's `isIdle()` is
			// false until `agent_settled`); each settle then finds its host idle.
			let idle = false;
			const primaryOwner = {
				ownerId: "activation-primary",
				cacheManager: cache,
				runtime,
				getCtx: () => ({ cwd: env.tmpDir, isIdle: () => idle }),
			};
			const secondaryOwner = {
				ownerId: "activation-secondary",
				cacheManager: cache,
				runtime: secondaryRuntime,
				getCtx: () => ({ cwd: env.tmpDir, isIdle: () => idle }),
			};
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 11,
				hasFindings: true,
				owner: primaryOwner,
			});
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-b",
				generation: 1,
				targetCount: 22,
				hasFindings: true,
				owner: secondaryOwner,
			});

			const marker = () =>
				cache.readCache<{
					deliveryEligible?: { sessionId: string };
				}>("test-runner-findings", env.tmpDir)?.data.deliveryEligible
					?.sessionId;
			idle = true;
			// A session staged by one activation is not delivered by another.
			deliverStagedTestRunnerFindings({
				cwd: env.tmpDir,
				sessionId: "session-b",
				ownerId: "activation-primary",
			});
			expect(marker()).toBeUndefined();

			deliverStagedTestRunnerFindings({
				cwd: env.tmpDir,
				sessionId: "session-a",
				ownerId: "activation-primary",
			});
			expect(marker()).toBe("session-a");
			deliverStagedTestRunnerFindings({
				cwd: env.tmpDir,
				sessionId: "session-b",
				ownerId: "activation-secondary",
			});
			expect(marker()).toBe("session-b");
			expect(
				(await deliveryRecords())
					.filter((record) => record.outcome === "eligible")
					.map((record) => [record.sessionId, record.targetCount]),
			).toEqual([
				["session-a", 11],
				["session-b", 22],
			]);
		} finally {
			env.cleanup();
		}
	});

	it("honors the authoritative provenance suppression decision", async () => {
		const { env, cache, runtime } = setup();
		try {
			const file = path.join(env.tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "export const x = 1;\n");
			const provenance = snapshotAdvisoryProvenance({
				cwd: env.tmpDir,
				runtime,
				generation: 1,
				files: [{ path: file, role: "test" }],
			});
			cache.writeCache(
				"test-runner-findings",
				{ content: "FAIL app.test.ts:1", testRunGeneration: 1, provenance },
				env.tmpDir,
			);
			fs.rmSync(file);
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			deliverTestRunnerFindings({
				ctx: { cwd: env.tmpDir, isIdle: () => true },
				cacheManager: cache,
				runtime,
				sessionId: "session-a",
			});
			expect(await deliveryOutcomes()).toEqual(["staged", "superseded"]);
			expect(
				cache.readCache<{ deliveryEligible?: unknown }>(
					"test-runner-findings",
					env.tmpDir,
				)?.data.deliveryEligible,
			).toBeUndefined();
			expect(
				consumeStagedTestRunnerFindings({
					cwd: env.tmpDir,
					sessionId: "session-a",
					cacheManager: cache,
					runtime,
				}),
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("delivers eligible findings without a terminal renderer", () => {
		const { env, cache, runtime } = setup();
		try {
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			deliverTestRunnerFindings({
				ctx: { cwd: env.tmpDir, isIdle: () => true },
				cacheManager: cache,
				runtime,
				sessionId: "session-a",
			});
			expect(
				consumeStagedTestRunnerFindings({
					cwd: env.tmpDir,
					sessionId: "session-a",
					cacheManager: cache,
					runtime,
				})?.messages[0]?.content,
			).toContain("FAIL");
		} finally {
			env.cleanup();
		}
	});

	it("does not consume before settlement and consumes once after settlement", () => {
		const { env, cache, runtime } = setup();
		try {
			let idle = false;
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			const deliver = () =>
				deliverTestRunnerFindings({
					ctx: { cwd: env.tmpDir, isIdle: () => idle },
					cacheManager: cache,
					runtime,
					sessionId: "session-a",
				});
			expect(
				consumeStagedTestRunnerFindings({
					cwd: env.tmpDir,
					sessionId: "session-a",
					cacheManager: cache,
					runtime,
				}),
			).toBeUndefined();
			deliver();
			expect(
				consumeStagedTestRunnerFindings({
					cwd: env.tmpDir,
					sessionId: "session-a",
					cacheManager: cache,
					runtime,
				}),
			).toBeUndefined();
			idle = true;
			deliver();
			expect(
				consumeStagedTestRunnerFindings({
					cwd: env.tmpDir,
					sessionId: "session-a",
					cacheManager: cache,
					runtime,
				})?.messages,
			).toHaveLength(1);
			resetTestRunnerDelivery();
			expect(
				consumeStagedTestRunnerFindings({
					cwd: env.tmpDir,
					sessionId: "session-a",
					cacheManager: cache,
					runtime,
				}),
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("keeps only the newest generation when an older completion arrives late", () => {
		const { env, cache, runtime } = setup();
		try {
			cache.writeCache(
				"test-runner-findings",
				{ content: "FAIL generation-2", testRunGeneration: 2 },
				env.tmpDir,
			);
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 2,
				targetCount: 1,
				hasFindings: true,
			});
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			deliverTestRunnerFindings({
				ctx: { cwd: env.tmpDir, isIdle: () => true },
				cacheManager: cache,
				runtime,
				sessionId: "session-a",
			});
			const delivered = consumeStagedTestRunnerFindings({
				cwd: env.tmpDir,
				sessionId: "session-a",
				cacheManager: cache,
				runtime,
			});
			expect(delivered?.messages[0]?.content).toContain("generation-2");
		} finally {
			env.cleanup();
		}
	});

	it("drops an eligible result if a newer generation wins before context build", () => {
		const { env, cache, runtime } = setup();
		try {
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			deliverTestRunnerFindings({
				ctx: { cwd: env.tmpDir, isIdle: () => true },
				cacheManager: cache,
				runtime,
				sessionId: "session-a",
			});
			cache.writeCache(
				"test-runner-findings",
				{ content: "FAIL generation-2", testRunGeneration: 2 },
				env.tmpDir,
			);
			expect(
				consumeStagedTestRunnerFindings({
					cwd: env.tmpDir,
					sessionId: "session-a",
					cacheManager: cache,
					runtime,
				}),
			).toBeUndefined();
			expect(
				cache.readCache<{ content: string }>("test-runner-findings", env.tmpDir)
					?.data.content,
			).toContain("generation-2");
		} finally {
			env.cleanup();
		}
	});

	/**
	 * #5259, the persisted view: an eligible marker written for generation 1
	 * survives a pre-run write that bumps `testRunGeneration` to 2 and keeps
	 * generation 1's content. Recurrence: the resumed context build read the
	 * bumped generation and dropped the marker as superseded.
	 */
	it("rehydrates an eligible failure across a run that launched but has not published (#5259)", () => {
		const { env, cache, runtime } = setup();
		try {
			const published = publishStamped(env.tmpDir, cache, runtime, 1);
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			deliverTestRunnerFindings({
				ctx: { cwd: env.tmpDir, isIdle: () => true },
				cacheManager: cache,
				runtime,
				sessionId: "session-a",
			});
			// The turn_end pre-run write: generation 2 launches, content kept.
			const eligible = cache.readCache<Record<string, unknown>>(
				"test-runner-findings",
				env.tmpDir,
			)?.data;
			cache.writeCache(
				"test-runner-findings",
				{ ...eligible, testRunGeneration: 2 },
				env.tmpDir,
			);
			resetTestRunnerDelivery();
			const resumed = consumeStagedTestRunnerFindings({
				cwd: env.tmpDir,
				sessionId: "session-a",
				cacheManager: cache,
				runtime,
			});
			expect(resumed?.messages[0]?.content).toContain(published);
		} finally {
			env.cleanup();
		}
	});

	/**
	 * #5259 real path: `handleTurnEnd` with the real `TestRunnerClient` (only
	 * its spawn, `runTestFileAsync`, is replaced so each batch's completion is
	 * under the test's control), the real cache and the real delivery module.
	 * The host's `isIdle()` follows pi: false from a prompt until
	 * `agent_settled`, true from the settle until the next prompt.
	 */
	async function realTimeline(prefix: string) {
		const env = setupTestEnvironment(prefix);
		const root = env.tmpDir;
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = root;
		runtime.setTelemetryIdentity({ sessionId: "session-a" });
		// The fixture has a package.json, so turn_end would start a real knip
		// scan; this cell is about test delivery (PR #5279 review thread).
		runtime.markStartupScanInFlight("knip", 0);
		const cache = new CacheManager(false);
		fs.writeFileSync(
			path.join(root, "package.json"),
			'{"name":"fixture","version":"1.0.0"}\n',
		);
		fs.writeFileSync(
			path.join(root, "vitest.config.ts"),
			"export default {};\n",
		);
		const bin = path.join(root, "node_modules", ".bin");
		fs.mkdirSync(bin, { recursive: true });
		fs.writeFileSync(path.join(bin, "vitest"), "#!/bin/sh\nexit 0\n");
		fs.chmodSync(path.join(bin, "vitest"), 0o755);
		const source = path.join(root, "src/foo.ts");
		const testFile = path.join(root, "src/foo.test.ts");
		fs.mkdirSync(path.dirname(source), { recursive: true });
		fs.writeFileSync(source, "export const foo = 1;\n");
		fs.writeFileSync(testFile, "export {};\n");

		const client = new TestRunnerClient();
		const runs: Array<(result: TestResult) => void> = [];
		vi.spyOn(client, "runTestFileAsync").mockImplementation(
			() => new Promise<TestResult>((resolve) => runs.push(resolve)),
		);
		let idle = false;
		let staged: () => void = () => {};
		const owner = {
			ownerId: "owner-a",
			cacheManager: cache,
			runtime,
			getCtx: () => ({ cwd: root, isIdle: () => idle }),
		};
		let edits = 0;
		return {
			env,
			runs,
			/** One agent turn: an edit, then its turn_end launches a batch. */
			async editTurn() {
				idle = false;
				edits += 1;
				fs.writeFileSync(source, `export const foo = ${edits};\n`);
				runtime.beginTurn();
				runtime.recordProjectMutation({
					filePath: source,
					source: "agent-edit",
				});
				cache.addModifiedRange(
					source,
					{ start: 1, end: 1 },
					false,
					root,
					"session-a",
				);
				await handleTurnEnd({
					ctxCwd: root,
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager: cache,
					knipClient: new KnipClient(false),
					deadCodeClients: [],
					depChecker: { ensureAvailable: async () => false },
					testRunnerClient: client,
					sessionId: "session-a",
					onTestRunnerComplete: (
						delivery: Parameters<typeof stageTestRunnerDelivery>[0],
					) => {
						stageTestRunnerDelivery({ ...delivery, owner });
						staged();
					},
					resetLSPService: () => {},
					resetFormatService: () => {},
				} as unknown as Parameters<typeof handleTurnEnd>[0]);
			},
			/** The oldest running batch fails with `message` and publishes. */
			async fail(message: string) {
				const published = new Promise<void>((resolve) => {
					staged = resolve;
				});
				runs.shift()?.({
					file: testFile,
					sourceFile: source,
					runner: "vitest",
					passed: 0,
					failed: 1,
					skipped: 0,
					failures: [{ name: "foo", message }],
					duration: 5,
				});
				await published;
			},
			generation: () =>
				cache.readCache<{ testRunGeneration?: number }>(
					"test-runner-findings",
					root,
				)?.data.testRunGeneration,
			/** agent_settled's quiet-window task, through the production entry. */
			settle() {
				idle = true;
				deliverStagedTestRunnerFindings({
					cwd: root,
					sessionId: "session-a",
					ownerId: "owner-a",
				});
			},
			/** A context build of the running agent (the first one is the prompt's). */
			contextBuild() {
				idle = false;
				return consumeStagedTestRunnerFindings({
					cwd: root,
					sessionId: "session-a",
					ownerId: "owner-a",
					cacheManager: cache,
					runtime,
				})?.messages[0]?.content;
			},
		};
	}

	/**
	 * #5259 S0: turn A's batch fails (generation 1) and is staged; turn B
	 * launches a second batch whose pre-run write bumps `testRunGeneration` to 2
	 * but keeps generation 1's content, and that batch is still in flight at
	 * `agent_settled`. Recurrence: the settle read the bumped generation, dropped
	 * generation 1 as superseded, and the failure reached the model one whole
	 * agent run late (P3, after the next settle) instead of at P2.
	 */
	it("delivers a staged failure at the next prompt when a newer run has launched but not published (#5259)", async () => {
		const t = await realTimeline("pi-lens-5259-s0-");
		try {
			await t.editTurn();
			await t.fail("expected 1 to be 2");
			expect(t.generation()).toBe(1);
			await t.editTurn();
			expect(t.runs).toHaveLength(1);
			expect(t.generation()).toBe(2);

			t.settle();
			expect(t.contextBuild()).toContain("expected 1 to be 2");

			// S2r: batch B fails while the next run is going. A context build of
			// that run never takes it; the run's own settle makes it eligible.
			await t.fail("expected 2 to be 3");
			expect(t.contextBuild()).toBeUndefined();
			t.settle();
			expect(t.contextBuild()).toContain("expected 2 to be 3");
			expect(t.contextBuild()).toBeUndefined();
			const eligible = (await deliveryRecords()).filter(
				(row) => row.outcome === "eligible",
			);
			expect(eligible.map((row) => row.deliveryBoundary)).toEqual([
				"agent_settled",
				"agent_settled",
			]);
			// A publish during a run is not a prompt racing the settle.
			expect(await deliveryOutcomes()).not.toContain("carried");
		} finally {
			vi.restoreAllMocks();
			t.env.cleanup();
		}
	});

	/**
	 * #5259 S2 (PR #5279 review F2): the batch is still running at
	 * `agent_settled` and fails before the next prompt. Recurrence: eligibility
	 * was set only at the settle, so the failure waited for the next run's
	 * settle and reached the model at P3.
	 */
	it("delivers a failure that finishes after agent_settled at the next prompt (#5259)", async () => {
		const t = await realTimeline("pi-lens-5259-s2-");
		try {
			await t.editTurn();
			t.settle();
			await t.fail("expected 1 to be 2");
			expect(t.contextBuild()).toContain("expected 1 to be 2");
			t.settle();
			expect(t.contextBuild()).toBeUndefined();
			const eligible = (await deliveryRecords()).filter(
				(row) => row.outcome === "eligible",
			);
			expect(eligible).toHaveLength(1);
			expect(eligible[0]?.deliveryBoundary).toBe("published-idle");
		} finally {
			vi.restoreAllMocks();
			t.env.cleanup();
		}
	});

	/**
	 * #5259 S1 (PR #5279 review F2): A fails and is eligible at the settle; the
	 * newer batch B fails between the settle and the next prompt. Recurrence:
	 * B's stage replaced A's eligible delivery with one that waited for the next
	 * settle, so P2 got nothing and B arrived at P3. A stays superseded.
	 */
	it("delivers a newer failure that finishes between agent_settled and the next prompt instead of the older one (#5259)", async () => {
		const t = await realTimeline("pi-lens-5259-s1-");
		try {
			await t.editTurn();
			await t.fail("expected 1 to be 2");
			await t.editTurn();
			t.settle();
			await t.fail("expected 2 to be 3");
			const atP2 = t.contextBuild();
			expect(atP2).toContain("expected 2 to be 3");
			expect(atP2).not.toContain("expected 1 to be 2");
			t.settle();
			expect(t.contextBuild()).toBeUndefined();
		} finally {
			vi.restoreAllMocks();
			t.env.cleanup();
		}
	});

	/**
	 * #5259: a publish that cannot read the host's idle state (a stale context
	 * throws) records the failure and leaves the delivery for the settle.
	 * Recurrence guarded: the new stage-time read must not drop a result or
	 * throw into the batch's publish.
	 */
	it("leaves a result for the settle when the publish cannot read the host's idle state (#5259)", async () => {
		const { env, cache, runtime } = setup();
		try {
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
				owner: {
					ownerId: "owner-a",
					cacheManager: cache,
					runtime,
					getCtx: () => ({
						cwd: env.tmpDir,
						isIdle: () => {
							throw new Error("stale context");
						},
					}),
				},
			});
			const failed = (await deliveryRecords()).filter(
				(row) => row.outcome === "delivery-failed",
			);
			expect(failed).toHaveLength(1);
			expect(failed[0]?.deliveryBoundary).toBe("published-idle");
			expect(failed[0]?.error).toContain("stale context");
			deliverTestRunnerFindings({
				ctx: { cwd: env.tmpDir, isIdle: () => true },
				cacheManager: cache,
				runtime,
				sessionId: "session-a",
				ownerId: "owner-a",
			});
			expect(
				consumeStagedTestRunnerFindings({
					cwd: env.tmpDir,
					sessionId: "session-a",
					ownerId: "owner-a",
					cacheManager: cache,
					runtime,
				})?.messages[0]?.content,
			).toContain("FAIL test/app.test.ts:1");
		} finally {
			env.cleanup();
		}
	});
});
