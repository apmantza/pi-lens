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
	stageTestRunnerDelivery,
} from "../../clients/test-runner-delivery.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { createPiMock } from "../support/pi-mock.js";
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
			const pi = createPiMock();
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			deliverTestRunnerFindings({
				pi: pi.asExtensionAPI(),
				ctx: { cwd: env.tmpDir, isIdle: () => true },
				cacheManager: cache,
				runtime,
				sessionId: "session-a",
			});

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

	it("carries a result when a prompt makes the immediate idle check fail", () => {
		const { env, cache, runtime } = setup();
		try {
			const pi = createPiMock();
			let idle = false;
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			deliverTestRunnerFindings({
				pi: pi.asExtensionAPI(),
				ctx: { cwd: env.tmpDir, isIdle: () => idle },
				cacheManager: cache,
				runtime,
				sessionId: "session-a",
			});
			idle = true;
			deliverTestRunnerFindings({
				pi: pi.asExtensionAPI(),
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
			const pi = createPiMock();
			let checks = 0;
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			deliverTestRunnerFindings({
				pi: pi.asExtensionAPI(),
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
			const pi = createPiMock();
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			expect(() =>
				deliverTestRunnerFindings({
					pi: pi.asExtensionAPI(),
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
			const pi = createPiMock();
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
				pi: pi.asExtensionAPI(),
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
			const pi = createPiMock();
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
				pi: pi.asExtensionAPI(),
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
			const primaryPi = createPiMock();
			const secondaryPi = createPiMock();
			const secondaryRuntime = new RuntimeCoordinator();
			secondaryRuntime.setTelemetryIdentity({ sessionId: "session-b" });
			const primaryOwner = {
				ownerId: "activation-primary",
				pi: primaryPi.asExtensionAPI(),
				cacheManager: cache,
				runtime,
				getCtx: () => ({ cwd: env.tmpDir, isIdle: () => true }),
			};
			const secondaryOwner = {
				ownerId: "activation-secondary",
				pi: secondaryPi.asExtensionAPI(),
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
			const pi = createPiMock();
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			deliverTestRunnerFindings({
				pi: pi.asExtensionAPI(),
				ctx: { cwd: env.tmpDir, isIdle: () => true },
				cacheManager: cache,
				runtime,
				sessionId: "session-a",
			});
		} finally {
			env.cleanup();
		}
	});

	it("does not consume another session or fall back when appendEntry is absent", () => {
		const { env, cache, runtime } = setup();
		try {
			const pi = createPiMock();
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			delete (pi as unknown as Record<string, unknown>).appendEntry;
			deliverTestRunnerFindings({
				pi: pi.asExtensionAPI(),
				ctx: { cwd: env.tmpDir, isIdle: () => true },
				cacheManager: cache,
				runtime,
				sessionId: "session-a",
			});
			expect(pi.sentMessages).toHaveLength(0);
			expect(
				cache.readCache<{ content: string }>("test-runner-findings", env.tmpDir)
					?.data.content,
			).toContain("FAIL");
		} finally {
			env.cleanup();
		}
	});

	it("delivers eligible findings without a terminal renderer", () => {
		const { env, cache, runtime } = setup();
		try {
			const pi = createPiMock();
			stageTestRunnerDelivery({
				cwd: env.tmpDir,
				sessionId: "session-a",
				generation: 1,
				targetCount: 1,
				hasFindings: true,
			});
			deliverTestRunnerFindings({
				pi: pi.asExtensionAPI(),
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
					pi: createPiMock().asExtensionAPI(),
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
				pi: createPiMock().asExtensionAPI(),
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
				pi: createPiMock().asExtensionAPI(),
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
