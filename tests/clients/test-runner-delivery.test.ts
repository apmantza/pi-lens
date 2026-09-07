import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotAdvisoryProvenance } from "../../clients/advisory-provenance.js";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	_resetTestRunnerDeliveryForTests,
	consumeStagedTestRunnerFindings,
	deliverTestRunnerFindings,
	deliverStagedTestRunnerFindings,
	resetTestRunnerDelivery,
	stageTestRunnerDelivery,
} from "../../clients/test-runner-delivery.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("automatic test-runner delivery (#2366)", () => {
	afterEach(() => _resetTestRunnerDeliveryForTests());

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

	it("does not rehydrate a shared-cache marker into another activation", () => {
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

			expect(
				consumeStagedTestRunnerFindings({
					cwd: env.tmpDir,
					sessionId: "session-a",
					ownerId: "activation-b",
					cacheManager: cache,
					runtime,
				}),
			).toBeUndefined();
			expect(
				consumeStagedTestRunnerFindings({
					cwd: env.tmpDir,
					sessionId: "session-a",
					ownerId: "activation-a",
					cacheManager: cache,
					runtime,
				})?.messages,
			).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});

	it("carries a result when a prompt makes the immediate idle check fail", () => {
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
			deliverTestRunnerFindings({
				ctx: { cwd: env.tmpDir, isIdle: () => idle },
				cacheManager: cache,
				runtime,
				sessionId: "session-a",
			});
			idle = true;
			deliverTestRunnerFindings({
				ctx: { cwd: env.tmpDir, isIdle: () => idle },
				cacheManager: cache,
				runtime,
				sessionId: "session-a",
			});
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

	it("does not resurrect an older generation after a clean result supersedes it", () => {
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

	it("delivers each activation's staged result through its own owner", () => {
		const { env, cache, runtime } = setup();
		try {
			const secondaryRuntime = new RuntimeCoordinator();
			secondaryRuntime.setTelemetryIdentity({ sessionId: "session-b" });
			const primaryOwner = {
				ownerId: "activation-primary",
				cacheManager: cache,
				runtime,
				getCtx: () => ({ cwd: env.tmpDir, isIdle: () => true }),
			};
			const secondaryOwner = {
				ownerId: "activation-secondary",
				cacheManager: cache,
				runtime: secondaryRuntime,
				getCtx: () => ({ cwd: env.tmpDir, isIdle: () => true }),
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

			deliverStagedTestRunnerFindings({
				cwd: env.tmpDir,
				sessionId: "session-a",
				ownerId: "activation-primary",
			});
			deliverStagedTestRunnerFindings({
				cwd: env.tmpDir,
				sessionId: "session-b",
				ownerId: "activation-secondary",
			});
		} finally {
			env.cleanup();
		}
	});

	it("honors the authoritative provenance suppression decision", () => {
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
});
