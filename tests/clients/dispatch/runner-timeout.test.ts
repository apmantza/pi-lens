/**
 * Tests for per-runner timeoutMs and timer cleanup in runRunner.
 *
 * Covers:
 * - runner.timeoutMs overrides the global 30 s default
 * - a runner that finishes quickly is never cut off
 * - both outcomes (success and throw) complete without hanging
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	clearCoverageNoticeState,
	createDispatchContext,
	RunnerRegistry,
	dispatchForFile as runDispatchForFile,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import type { RunnerGroup, RunnerResult } from "../../../clients/dispatch/types.js";

describe("runRunner timeout behavior", () => {
	let registry: RunnerRegistry;

	function dispatchForFile(
		ctx: Parameters<typeof runDispatchForFile>[0],
		groups: RunnerGroup[],
	) {
		return runDispatchForFile(ctx, groups, registry);
	}

	function createMockContext(filePath: string) {
		return createDispatchContext(
			filePath,
			"/project",
			{ getFlag: () => false },
			new FactStore(),
		);
	}

	beforeEach(() => {
		registry = new RunnerRegistry();
		clearCoverageNoticeState();
	});

	it(
		"fires at runner-level timeoutMs, not the 30 s global default",
		async () => {
			// runner never resolves — only the dispatcher timeout can settle this
			registry.register({
				id: "slow-tool",
				appliesTo: ["jsts"],
				priority: 10,
				enabledByDefault: true,
				timeoutMs: 30,
				async run(): Promise<RunnerResult> {
					return new Promise(() => {});
				},
			});

			const ctx = createMockContext("test.ts");
			const result = await dispatchForFile(ctx, [
				{ mode: "all", runnerIds: ["slow-tool"] },
			]);

			// timed out → no diagnostics, no blockers
			expect(result.diagnostics).toHaveLength(0);
			expect(result.hasBlockers).toBe(false);
		},
		500,
	);

	it("does not cut off a runner that finishes before its timeoutMs", async () => {
		registry.register({
			id: "fast-tool",
			appliesTo: ["jsts"],
			priority: 10,
			enabledByDefault: true,
			timeoutMs: 5_000,
			async run(): Promise<RunnerResult> {
				return {
					status: "succeeded",
					diagnostics: [
						{
							id: "fast-warn",
							message: "warning from fast-tool",
							filePath: "test.ts",
							severity: "warning",
							semantic: "warning",
							tool: "fast-tool",
						},
					],
					semantic: "warning",
				};
			},
		});

		const ctx = createMockContext("test.ts");
		const result = await dispatchForFile(ctx, [
			{ mode: "all", runnerIds: ["fast-tool"] },
		]);

		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].id).toBe("fast-warn");
	});

	it(
		"returns failed/empty when the runner throws before its timeoutMs",
		async () => {
			registry.register({
				id: "exploding",
				appliesTo: ["jsts"],
				priority: 10,
				enabledByDefault: true,
				timeoutMs: 5_000,
				async run(): Promise<RunnerResult> {
					throw new Error("runner blew up");
				},
			});

			const ctx = createMockContext("test.ts");
			const result = await dispatchForFile(ctx, [
				{ mode: "all", runnerIds: ["exploding"] },
			]);

			expect(result.diagnostics).toHaveLength(0);
			expect(result.hasBlockers).toBe(false);
		},
	);

	it(
		"slow runner times out while fast runner in the same group still returns its diagnostics",
		async () => {
			// slow-a never resolves — times out at 30 ms
			registry.register({
				id: "slow-a",
				appliesTo: ["jsts"],
				priority: 10,
				enabledByDefault: true,
				timeoutMs: 30,
				async run(): Promise<RunnerResult> {
					return new Promise(() => {});
				},
			});

			// fast-b resolves immediately
			registry.register({
				id: "fast-b",
				appliesTo: ["jsts"],
				priority: 11,
				enabledByDefault: true,
				timeoutMs: 5_000,
				async run(): Promise<RunnerResult> {
					return {
						status: "succeeded",
						diagnostics: [
							{
								id: "b-warn",
								message: "from fast-b",
								filePath: "test.ts",
								severity: "warning",
								semantic: "warning",
								tool: "fast-b",
							},
						],
						semantic: "warning",
					};
				},
			});

			const ctx = createMockContext("test.ts");
			const result = await dispatchForFile(ctx, [
				// mode "all" runs both; slow-a times out, fast-b succeeds
				{ mode: "all", runnerIds: ["slow-a", "fast-b"] },
			]);

			expect(result.diagnostics.map((d) => d.id)).toEqual(["b-warn"]);
		},
		500,
	);
});
