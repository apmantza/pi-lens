/**
 * #5097: the transition cells of the one request sender (`safeSendRequest`)
 * that a real fake server cannot pin deterministically: a server that exits
 * mid-request, a late answer after the release, a ContentModified reply racing
 * the release, and the answer-in-time row. Fake timers drive the deadline.
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	isConnectionBusy,
	type LSPClientState,
	navRequest,
} from "../../../clients/lsp/client.js";
import { createMockState } from "./mock-client-state.js";

const FILE = "/project/app.ts";

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

beforeEach(() => {
	vi.useFakeTimers();
});

/** Settles with `value` or rejects with `error` after `ms` of fake time. */
const after = (ms: number, outcome: { value: unknown } | { error: Error }) =>
	new Promise((resolve, reject) => {
		setTimeout(() => {
			if ("error" in outcome) reject(outcome.error);
			else resolve(outcome.value);
		}, ms);
	});

afterEach(() => {
	vi.useRealTimers();
	resetDegradationLedger();
});

const lateAnswerCount = () =>
	getDegradationSummary().find((g) => g.kind === "lsp-nav-late-answer")
		?.count ?? 0;

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
		await vi.advanceTimersByTimeAsync(80);
		abort.abort();
		expect(seen.token?.isCancellationRequested).toBe(false);
	});

	it("a server that exits mid-request resolves undefined, releases the count, and sends no cancel", async () => {
		const state = createMockState();
		const seen = install(state, () =>
			after(20, {
				error: new Error(
					"Pending response rejected since connection got disposed",
				),
			}),
		);

		const call = navRequest(state, "textDocument/hover", {}, undefined, 500);
		await vi.advanceTimersByTimeAsync(25);

		await expect(call).resolves.toBeUndefined();
		expect(isConnectionBusy(state.connection)).toBe(false);
		expect(seen.token?.isCancellationRequested ?? false).toBe(false);
	});

	it("a timeout then the server's own RequestCancelled reply is released and is not a late answer", async () => {
		const state = createMockState();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const seen = install(state, () =>
				after(80, {
					error: Object.assign(new Error("cancelled"), { code: -32800 }),
				}),
			);

			const call = navRequest(state, "textDocument/hover", {}, FILE, 20);
			const rejected = expect(call).rejects.toThrow("LSP request timed out");
			await vi.advanceTimersByTimeAsync(25);
			await rejected;
			expect(seen.token?.isCancellationRequested).toBe(true);
			expect(isConnectionBusy(state.connection)).toBe(false);

			await vi.advanceTimersByTimeAsync(150);
			expect(lateAnswerCount()).toBe(0);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("a timeout then a real late reply reaches the late-answer hook once", async () => {
		const state = createMockState();
		install(state, () => after(80, { value: { contents: "late" } }));

		const call = navRequest(state, "textDocument/hover", {}, FILE, 20);
		const rejected = expect(call).rejects.toThrow("LSP request timed out");
		await vi.advanceTimersByTimeAsync(25);
		await rejected;
		expect(lateAnswerCount()).toBe(0);

		await vi.advanceTimersByTimeAsync(150);
		expect(lateAnswerCount()).toBe(1);
	});

	it("an abort returns at once, cancels the token, and is not a late answer when the server answers anyway", async () => {
		const state = createMockState();
		const seen = install(state, () =>
			after(120, { value: { contents: "answered after Esc" } }),
		);
		const abort = new AbortController();
		let settled = false;
		const call = navRequest(
			state,
			"textDocument/hover",
			{},
			FILE,
			500,
			abort.signal,
		).then((value) => {
			settled = true;
			return value;
		});
		await vi.advanceTimersByTimeAsync(10);
		expect(settled).toBe(false);
		abort.abort();
		// Far short of the server's 120 ms and the 500 ms bound.
		await vi.advanceTimersByTimeAsync(1);

		expect(settled).toBe(true);
		await expect(call).resolves.toBeUndefined();
		expect(seen.token?.isCancellationRequested).toBe(true);
		expect(isConnectionBusy(state.connection)).toBe(false);
		await vi.advanceTimersByTimeAsync(200);
		expect(lateAnswerCount()).toBe(0);
	});

	it("a ContentModified reply after the release is not retried", async () => {
		const state = createMockState();
		const seen = install(state, () =>
			after(60, {
				error: Object.assign(new Error("content modified"), { code: -32801 }),
			}),
		);

		const call = navRequest(state, "textDocument/hover", {}, FILE, 20);
		const rejected = expect(call).rejects.toThrow("LSP request timed out");
		await vi.advanceTimersByTimeAsync(25);
		await rejected;
		await vi.advanceTimersByTimeAsync(150);

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
