/**
 * The pre-dispatch LSP sync (`resyncLspFile`) must never let a wedged language
 * server hang the edit. Its didChange/didOpen write can backpressure forever
 * when the server's stdin isn't drained, so the sync is bounded by a hard budget
 * (PI_LENS_LSP_SYNC_BUDGET_MS) and the turn's abort signal (Escape) — whichever
 * wins, resyncLspFile returns and the edit proceeds. Regression guard for the
 * "8h invisible edit hang" class.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../clients/lsp/index.js", () => ({ getLSPService: vi.fn() }));

import { resyncLspFile } from "../../clients/pipeline.js";
import { getLSPService } from "../../clients/lsp/index.js";
import { setAmbientAbortSignal } from "../../clients/safe-spawn.js";

const getFlag = () => undefined;
const dbg = () => {};

function mockService(touchFile: () => Promise<unknown>) {
	vi.mocked(getLSPService).mockReturnValue({
		supportsLSP: () => true,
		touchFile: vi.fn(touchFile),
	} as any);
}

beforeEach(() => {
	process.env.PI_LENS_LSP_SYNC_BUDGET_MS = "50";
	setAmbientAbortSignal(undefined);
});
afterEach(() => {
	delete process.env.PI_LENS_LSP_SYNC_BUDGET_MS;
	setAmbientAbortSignal(undefined);
	vi.restoreAllMocks();
});

describe("resyncLspFile — bounded pre-dispatch LSP sync", () => {
	it("abandons a wedged touch after the budget instead of hanging", async () => {
		// touchFile that never resolves = a server whose didChange write backpressures.
		mockService(() => new Promise(() => {}));
		const started = Date.now();
		await resyncLspFile("/proj/a.ts", "content", true, false, getFlag, dbg);
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(45);
		expect(elapsed).toBeLessThan(2000); // returned, did not hang
	});

	it("returns immediately when the turn is already aborted, without touching", async () => {
		const controller = new AbortController();
		controller.abort();
		setAmbientAbortSignal(controller.signal);
		const touch = vi.fn(() => new Promise(() => {}));
		mockService(touch);
		const started = Date.now();
		await resyncLspFile("/proj/a.ts", "content", true, false, getFlag, dbg);
		expect(Date.now() - started).toBeLessThan(30);
		expect(touch).not.toHaveBeenCalled();
	});

	it("bails as soon as Escape aborts mid-flight (before the budget)", async () => {
		mockService(() => new Promise(() => {}));
		const controller = new AbortController();
		setAmbientAbortSignal(controller.signal);
		process.env.PI_LENS_LSP_SYNC_BUDGET_MS = "10000"; // long, so abort wins the race
		const started = Date.now();
		const p = resyncLspFile("/proj/a.ts", "content", true, false, getFlag, dbg);
		setTimeout(() => controller.abort(), 30);
		await p;
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("completes normally (fast) when the server is healthy", async () => {
		const touch = vi.fn(() => Promise.resolve([]));
		mockService(touch);
		const started = Date.now();
		await resyncLspFile("/proj/a.ts", "content", true, false, getFlag, dbg);
		expect(Date.now() - started).toBeLessThan(45); // resolved well before the budget
		expect(touch).toHaveBeenCalledTimes(1);
	});
});
