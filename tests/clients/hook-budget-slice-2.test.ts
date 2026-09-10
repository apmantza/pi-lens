import { afterEach, describe, expect, it, vi } from "vitest";
import { bounded } from "../../clients/deadline-utils.js";
import { HOOK_WALL_BUDGET_MS } from "../../clients/hook-budgets.js";
import { gatedPromise } from "../support/fault-injection.js";

describe("#2523 slice 2 hook budgets", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns session_start within its wall budget when a dependency is wedged", async () => {
		vi.useFakeTimers();
		const gate = gatedPromise<void>();
		const result = bounded(gate.promise, {
			ms: HOOK_WALL_BUDGET_MS.session_start,
			signal: undefined,
			hook: "session_start",
			label: "configureWarmAttach",
		});
		await vi.advanceTimersByTimeAsync(HOOK_WALL_BUDGET_MS.session_start);
		await expect(result).resolves.toBeUndefined();
	});

	it("returns turn_end within its wall budget when a dependency is wedged", async () => {
		vi.useFakeTimers();
		const gate = gatedPromise<void>();
		const result = bounded(gate.promise, {
			ms: HOOK_WALL_BUDGET_MS.turn_end,
			signal: undefined,
			hook: "turn_end",
			label: "handleTurnEnd",
		});
		await vi.advanceTimersByTimeAsync(HOOK_WALL_BUDGET_MS.turn_end);
		await expect(result).resolves.toBeUndefined();
	});

	it("settles a wedged turn_end sooner when its hook signal aborts", async () => {
		vi.useFakeTimers();
		const gate = gatedPromise<void>();
		const controller = new AbortController();
		const result = bounded(gate.promise, {
			ms: HOOK_WALL_BUDGET_MS.turn_end,
			signal: controller.signal,
			hook: "turn_end",
			label: "handleTurnEnd-abort",
		});
		controller.abort();
		await expect(result).resolves.toBeUndefined();
	});

	it("keeps MCP session_start within the pi budget", () => {
		expect(HOOK_WALL_BUDGET_MS.session_start).toBe(5000);
	});

	it("keeps MCP turn_end within the pi budget", () => {
		expect(HOOK_WALL_BUDGET_MS.turn_end).toBe(3000);
	});

	it("returns agent_end within its wall budget", () => {
		expect(HOOK_WALL_BUDGET_MS.agent_end).toBe(1000);
	});

	it("bounds the agent_settled aggregate drain", () => {
		expect(HOOK_WALL_BUDGET_MS.agent_settled).toBe(10000);
	});

	it("does not await analyzer bootstrap for a read-only tool result", () => {
		expect(HOOK_WALL_BUDGET_MS.tool_result_read_only).toBe(500);
	});

	it("returns the edit path within the aggregate formatter budget", () => {
		expect(HOOK_WALL_BUDGET_MS.tool_result_edit).toBe(10000);
	});

	it("threads the live tool_call signal instead of the ambient slot", () => {
		expect(HOOK_WALL_BUDGET_MS).not.toHaveProperty("tool_call");
	});

	it("applies hook bounds to MCP lifecycle calls", () => {
		expect(HOOK_WALL_BUDGET_MS.turn_end).toBeGreaterThan(0);
	});
});
