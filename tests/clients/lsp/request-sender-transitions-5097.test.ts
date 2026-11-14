/**
 * #5097: the transition cells of the one request sender (`safeSendRequest`)
 * that a real fake server cannot pin deterministically: a server that exits
 * mid-request, a late answer after the release, a ContentModified retry racing
 * the release, and the answer-in-time row.
 *
 * Connection-double tests: `state.connection.sendRequest` is a mock that
 * records the cancellation token it was handed (matches
 * `nav-request-timeout-telemetry.test.ts`).
 *
 * Recurrence each case guards: a request released on timeout or abort that
 * (a) is also cancelled when answered in time, (b) leaks an unhandled
 * rejection when the server's late reply or exit lands after the release,
 * (c) is re-sent by the ContentModified retry after the caller gave up, or
 * (d) counts the cancel's own `RequestCancelled` as a late answer.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { latencyEvents } = vi.hoisted(() => ({
	latencyEvents: [] as Array<Record<string, unknown>>,
}));
vi.mock("../../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: vi.fn((event: Record<string, unknown>) => {
			latencyEvents.push(event);
		}),
	};
});

import { resetDegradationLedger } from "../../../clients/degradation-ledger.js";
import {
	isConnectionBusy,
	type LSPClientState,
	navRequest,
} from "../../../clients/lsp/client.js";
import { createMockState } from "./mock-client-state.js";

const FILE = "/project/app.ts";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Seen {
	token: { isCancellationRequested: boolean } | undefined;
	calls: number;
}

function install(
	state: LSPClientState,
	handler: (call: number) => Promise<unknown>,
): Seen {
	const seen: Seen = { token: undefined, calls: 0 };
	state.connection.sendRequest = vi.fn(
		(_method: string, _params: unknown, token?: unknown) => {
			seen.calls += 1;
			seen.token = token as Seen["token"];
			return handler(seen.calls);
		},
	) as unknown as typeof state.connection.sendRequest;
	return seen;
}

const lateAnswers = () =>
	latencyEvents.filter((e) => e.phase === "lsp_nav_late_answer_discarded");

afterEach(() => {
	latencyEvents.length = 0;
	resetDegradationLedger();
});

describe("the request sender's transitions (#5097)", () => {
	it("an answer in time sends no cancel, leaves the connection idle, and leaves no timer to cancel later", async () => {
		const state = createMockState();
		const seen = install(state, async () => ({ contents: "ok" }));
		const abort = new AbortController();

		await expect(
			navRequest(state, "textDocument/hover", {}, undefined, 30, abort.signal),
		).resolves.toEqual({ contents: "ok" });

		expect(seen.token?.isCancellationRequested).toBe(false);
		expect(isConnectionBusy(state.connection)).toBe(false);
		// The bound's timer is gone and so is the abort listener: neither the
		// deadline nor a later Esc cancels a finished request's token.
		await wait(80);
		abort.abort();
		expect(seen.token?.isCancellationRequested).toBe(false);
	});

	it("a server that exits mid-request resolves undefined, releases the count, and sends no cancel", async () => {
		const state = createMockState();
		const seen = install(state, async () => {
			await wait(20);
			throw new Error(
				"Pending response rejected since connection got disposed",
			);
		});

		await expect(
			navRequest(state, "textDocument/hover", {}, undefined, 500),
		).resolves.toBeUndefined();

		expect(isConnectionBusy(state.connection)).toBe(false);
		expect(seen.token?.isCancellationRequested ?? false).toBe(false);
	});

	it("a timeout then the server's own RequestCancelled reply is released and is not a late answer", async () => {
		const state = createMockState();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const seen = install(state, async () => {
				await wait(80);
				throw Object.assign(new Error("cancelled"), { code: -32800 });
			});

			await expect(
				navRequest(state, "textDocument/hover", {}, FILE, 20),
			).rejects.toThrow("LSP request timed out");
			expect(seen.token?.isCancellationRequested).toBe(true);
			expect(isConnectionBusy(state.connection)).toBe(false);

			await wait(150);
			expect(lateAnswers()).toHaveLength(0);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("a timeout then a real late reply reaches the late-answer hook once", async () => {
		const state = createMockState();
		install(state, async () => {
			await wait(80);
			return { contents: "late" };
		});

		await expect(
			navRequest(state, "textDocument/hover", {}, FILE, 20),
		).rejects.toThrow("LSP request timed out");
		expect(lateAnswers()).toHaveLength(0);
		await wait(150);
		expect(lateAnswers()).toHaveLength(1);
	});

	it("an abort returns at once, cancels the token, and is not a late answer when the server answers anyway", async () => {
		const state = createMockState();
		const seen = install(state, async () => {
			await wait(120);
			return { contents: "answered after Esc" };
		});
		const abort = new AbortController();
		const call = navRequest(
			state,
			"textDocument/hover",
			{},
			FILE,
			500,
			abort.signal,
		);
		await wait(10);
		const abortedAt = Date.now();
		abort.abort();

		await expect(call).resolves.toBeUndefined();
		expect(Date.now() - abortedAt).toBeLessThan(100);
		expect(seen.token?.isCancellationRequested).toBe(true);
		expect(isConnectionBusy(state.connection)).toBe(false);
		await wait(200);
		expect(lateAnswers()).toHaveLength(0);
	});

	it("a ContentModified reply after the release is not retried", async () => {
		const state = createMockState();
		const seen = install(state, async () => {
			await wait(60);
			throw Object.assign(new Error("content modified"), { code: -32801 });
		});

		await expect(
			navRequest(state, "textDocument/hover", {}, FILE, 20),
		).rejects.toThrow("LSP request timed out");
		await wait(150);

		expect(seen.calls).toBe(1);
	});

	it("an already-aborted signal sends nothing", async () => {
		const state = createMockState();
		const seen = install(state, async () => ({ contents: "never" }));
		const abort = new AbortController();
		abort.abort();

		await expect(
			navRequest(state, "textDocument/hover", {}, undefined, 500, abort.signal),
		).resolves.toBeUndefined();
		expect(seen.calls).toBe(0);
		expect(isConnectionBusy(state.connection)).toBe(false);
	});
});
