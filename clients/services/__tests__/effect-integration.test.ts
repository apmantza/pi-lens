/**
 * Effect Integration Tests
 *
 * Tests for Effect-TS concurrent runner execution.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	DispatchContext,
	RunnerDefinition,
	RunnerGroup,
	RunnerResult,
} from "../../dispatch/types.js";
import {
	clearRunnerRegistry,
	getRunner,
	listRunners,
	registerRunner,
} from "../../dispatch/dispatcher.js";
import {
	dispatchLintWithEffect,
	dispatchWithEffect,
	type EffectDispatchResult,
} from "../effect-integration.js";

describe("Effect Integration", () => {
	beforeEach(async () => {
		clearRunnerRegistry();
		// Register a simple test runner
		const testRunner: RunnerDefinition = {
			id: "test-runner",
			appliesTo: ["jsts"],
			priority: 10,
			enabledByDefault: true,
			async run(ctx) {
				return {
					status: "succeeded",
					diagnostics: [{
						id: "test:1",
						message: "Test diagnostic",
						filePath: ctx.filePath,
						severity: "info",
						semantic: "silent",
						tool: "test-runner",
					}],
					semantic: "none",
				};
			},
		};
		registerRunner(testRunner);
	});

	it("should have runners registered", () => {
		const runners = listRunners();
		expect(runners.length).toBeGreaterThan(0);
		expect(runners.some(r => r.id === "test-runner")).toBe(true);
	});

	it("should run effect integration with real runners", async () => {
		const ctx: DispatchContext = {
			filePath: "test.ts",
			cwd: "/test",
			kind: "jsts",
			pi: {
				getFlag: vi.fn(() => false),
			},
			autofix: true,
			deltaMode: false,
			baselines: new Map(),
			hasTool: vi.fn(() => Promise.resolve(false)),
			log: vi.fn(),
		};

		// Get actual runners for jsts
		const { getRunnersForKind } = await import("../../dispatch/dispatcher.js");
		const runners = getRunnersForKind("jsts");
		
		const group: RunnerGroup = {
			runnerIds: runners.slice(0, 2).map(r => r.id), // Use first 2 runners
			mode: "all",
		};

		const result = await dispatchWithEffect(ctx, [group]);
		
		// Just verify it doesn't crash and returns valid result
		expect(result).toBeDefined();
		expect(typeof result.durationMs).toBe("number");
	});

	it("should handle --lens-effect flag path", async () => {
		const mockPi = {
			getFlag: vi.fn((flag: string) => flag === "lens-effect"),
			readFile: vi.fn(),
			writeFile: vi.fn(),
			editFile: vi.fn(),
			bash: vi.fn(),
			ui: {
				notify: vi.fn(),
				progress: vi.fn(),
				prompt: vi.fn(),
			},
			llm: {
				stream: vi.fn(),
				createMessage: vi.fn(),
			},
		};

		const output = await dispatchLintWithEffect("test.ts", "/test", mockPi);
		expect(typeof output).toBe("string");
	});
});
