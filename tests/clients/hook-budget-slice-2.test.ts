import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { FormatService } from "../../clients/format-service.js";
import { HOOK_WALL_BUDGET_MS } from "../../clients/hook-budgets.js";
import { wrapSessionEventHandler } from "../../clients/session-event-guard.js";
import { gatedPromise } from "../support/fault-injection.js";

const formatterRunner = vi.hoisted(() => vi.fn());

vi.mock("../../clients/formatters-lazy.js", () => ({
	loadFormatters: async () => ({
		getFormattersForFile: async () => [
			{ name: "biome", command: [], extensions: [".ts"] },
		],
		formatFile: formatterRunner,
	}),
}));

const liveCtx = (signal?: AbortSignal) => ({ isIdle: () => true, signal });

describe("#2523 slice 2 real hook budget seams", () => {
	beforeEach(() => resetDegradationLedger());
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("returns session_start within its wall budget when a dependency is wedged", async () => {
		vi.useFakeTimers();
		const gate = gatedPromise<void>();
		const guarded = wrapSessionEventHandler(
			"session_start",
			(_event: never, _ctx: never) => gate.promise,
		);
		const result = guarded({} as never, liveCtx() as never);
		await vi.advanceTimersByTimeAsync(HOOK_WALL_BUDGET_MS.session_start);
		await expect(result).resolves.toBeUndefined();
		expect(gate.settled()).toBe(false);
	});

	it("returns turn_end within its wall budget when a dependency is wedged", async () => {
		vi.useFakeTimers();
		const gate = gatedPromise<void>();
		const guarded = wrapSessionEventHandler(
			"turn_end",
			(_event: never, _ctx: never) => gate.promise,
		);
		const result = guarded({} as never, liveCtx() as never);
		await vi.advanceTimersByTimeAsync(HOOK_WALL_BUDGET_MS.turn_end);
		await expect(result).resolves.toBeUndefined();
		expect(gate.settled()).toBe(false);
	});

	it("releases an aborted turn_end without recording a failure", async () => {
		const controller = new AbortController();
		const gate = gatedPromise<void>();
		const guarded = wrapSessionEventHandler(
			"turn_end",
			(_event: never, _ctx: never) => gate.promise,
		);
		const result = guarded({} as never, liveCtx(controller.signal) as never);
		controller.abort();
		await expect(result).resolves.toBeUndefined();
		expect(
			getDegradationSummary().some(
				(group) => group.kind === "hook-await-exceeded",
			),
		).toBe(false);
	});

	it("records one rising edge per hook and await label under a flood", async () => {
		vi.useFakeTimers();
		const guarded = wrapSessionEventHandler(
			"agent_end",
			(_event: never, _ctx: never) => new Promise<void>(() => {}),
		);
		const results = Array.from({ length: 50 }, () =>
			guarded({} as never, liveCtx() as never),
		);
		await vi.advanceTimersByTimeAsync(HOOK_WALL_BUDGET_MS.agent_end);
		await Promise.all(results);
		const rows = getDegradationSummary().filter(
			(group) => group.kind === "hook-await-exceeded",
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.latestReasons[0]?.subject).toBe(
			"agent_end:registered-handler",
		);
	});

	it("does not await analyzer bootstrap for a read-only tool result", async () => {
		vi.useFakeTimers();
		const gate = gatedPromise<void>();
		const guarded = wrapSessionEventHandler(
			"tool_result",
			(_event: never, _ctx: never) => gate.promise,
			{
				budgetKey: "tool_result_read_only",
			},
		);
		const result = guarded({} as never, liveCtx() as never);
		await vi.advanceTimersByTimeAsync(
			HOOK_WALL_BUDGET_MS.tool_result_read_only,
		);
		await expect(result).resolves.toBeUndefined();
		expect(gate.settled()).toBe(false);
	});

	it("returns the edit path within the aggregate formatter budget", async () => {
		vi.useFakeTimers();
		const gate = gatedPromise<never>();
		formatterRunner.mockReturnValue(gate.promise);
		const service = new FormatService("budget-test", true);
		const filePath = path.join(os.tmpdir(), `budget-test-${process.pid}.ts`);
		fs.writeFileSync(filePath, "const value = 1;\n");
		service.recordRead(filePath);
		const result = service.formatFile(filePath, {
			budgetMs: HOOK_WALL_BUDGET_MS.tool_result_edit,
		});
		await vi.advanceTimersByTimeAsync(HOOK_WALL_BUDGET_MS.tool_result_edit);
		await expect(result).resolves.toMatchObject({ allSucceeded: false });
		expect(gate.settled()).toBe(false);
		fs.rmSync(filePath, { force: true });
	});

	it("forwards the executing hook to the formatter aggregate ledger", async () => {
		vi.useFakeTimers();
		const gate = gatedPromise<never>();
		formatterRunner.mockReturnValue(gate.promise);
		const service = new FormatService("hook-attribution-test", true);
		const filePath = path.join(
			os.tmpdir(),
			`hook-attribution-test-${process.pid}.ts`,
		);
		fs.writeFileSync(filePath, "const value = 1;\n");
		service.recordRead(filePath);
		const result = service.formatFile(filePath, {
			budgetMs: HOOK_WALL_BUDGET_MS.agent_settled,
			hook: "agent_settled",
		});
		await vi.advanceTimersByTimeAsync(HOOK_WALL_BUDGET_MS.agent_settled);
		await result;
		expect(
			getDegradationSummary().some(
				(group) =>
					group.kind === "hook-await-exceeded" &&
					group.latestReasons.some((reason) =>
						reason.subject.includes("agent_settled:formatter-aggregate"),
					),
			),
		).toBe(true);
		gate.resolve(undefined as never);
		fs.rmSync(filePath, { force: true });
	});

	it("keeps a caller-aborted formatter out of failure and requeue semantics", async () => {
		vi.useFakeTimers();
		const gate = gatedPromise<never>();
		const controller = new AbortController();
		formatterRunner.mockReturnValue(gate.promise);
		const service = new FormatService("abort-test", true);
		const filePath = path.join(os.tmpdir(), `abort-test-${process.pid}.ts`);
		fs.writeFileSync(filePath, "const value = 1;\n");
		service.recordRead(filePath);
		const result = service.formatFile(filePath, {
			signal: controller.signal,
		});
		controller.abort();
		await expect(result).resolves.toMatchObject({ formatters: [] });
		expect(gate.settled()).toBe(false);
		fs.rmSync(filePath, { force: true });
	});
});
