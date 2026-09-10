/**
 * Unit tests for the central stale-ctx guard (#1925).
 *
 * `tests/index-wiring.test.ts` proves the wrapper is APPLIED to each real
 * `pi.on` registration. This file proves the wrapper's own policy, including
 * the two branches an end-to-end probe cannot tell apart: short-circuiting
 * BEFORE dispatch, and classifying a stale throw that races in mid-handler.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	isStaleExtensionCtxError,
	wrapSessionEventHandler,
	wrapSessionEventHandlerWithResult,
} from "../../clients/session-event-guard.js";
import { makeStaleCtx, STALE_CTX_MESSAGE } from "../support/pi-mock.js";

/** A live ctx: `isIdle()` answers instead of throwing, so the probe says true. */
function liveCtx(): unknown {
	return { isIdle: () => true, cwd: process.cwd() };
}

function staleGroup() {
	return getDegradationSummary().find(
		(group) => group.kind === "extension-ctx-stale",
	);
}

function identityFallbackGroup() {
	return getDegradationSummary().find(
		(group) => group.kind === "turn-context-identity-fallback",
	);
}

describe("wrapSessionEventHandler (#1925)", () => {
	beforeEach(() => {
		resetDegradationLedger();
	});

	it("never dispatches to the handler when the ctx probes stale", async () => {
		const handler = vi.fn();
		const guarded = wrapSessionEventHandler("turn_end", handler);

		await guarded({} as never, makeStaleCtx() as never);

		// The point of probing BEFORE dispatch: the handler's first ctx read is
		// not the detector. Catching the throw afterwards would also keep the
		// host safe, but only after running whatever the handler does first.
		expect(handler).not.toHaveBeenCalled();
		expect(staleGroup()?.latestReasons[0]?.reason).toContain("pre-dispatch");
	});

	it("dispatches on a live ctx and returns the handler's own result", async () => {
		const guarded = wrapSessionEventHandler(
			"turn_start",
			(_event: never, _ctx: never) => "handled",
		);

		expect(guarded({} as never, liveCtx() as never)).toBe("handled");
		expect(staleGroup()).toBeUndefined();
	});

	it("dispatches when the probe is INCONCLUSIVE rather than assuming stale", async () => {
		// No ctx at all, and a ctx of an unexpected shape, both probe
		// `undefined`. Guessing "dead" there would silently disable pi-lens on
		// any host whose ctx does not expose `isIdle`.
		const handler = vi.fn();
		const guarded = wrapSessionEventHandler("agent_end", handler);

		guarded({} as never, undefined as never);
		guarded({} as never, { cwd: "/repo" } as never);

		expect(handler).toHaveBeenCalledTimes(2);
		expect(staleGroup()).toBeUndefined();
	});

	it("classifies a stale throw that races in after the probe (sync)", () => {
		const guarded = wrapSessionEventHandler(
			"tool_result",
			(_event: never, _ctx: never) => {
				throw new Error(STALE_CTX_MESSAGE);
			},
		);

		expect(() => guarded({} as never, liveCtx() as never)).not.toThrow();
		expect(staleGroup()?.latestReasons[0]?.reason).toContain("mid-handler");
	});

	it("classifies a stale rejection that races in after the probe (async)", async () => {
		const guarded = wrapSessionEventHandler(
			"agent_settled",
			async (_event: never, _ctx: never) => {
				throw new Error(STALE_CTX_MESSAGE);
			},
		);

		await expect(
			guarded({} as never, liveCtx() as never),
		).resolves.toBeUndefined();
		expect(staleGroup()?.latestReasons[0]?.reason).toContain("mid-handler");
	});

	it("lets a NON-stale failure through, sync and async, and counts nothing", async () => {
		const syncGuarded = wrapSessionEventHandler(
			"turn_end",
			(_event: never, _ctx: never) => {
				throw new Error("boom");
			},
		);
		const asyncGuarded = wrapSessionEventHandler(
			"turn_end",
			async (_event: never, _ctx: never) => {
				throw new Error("boom");
			},
		);

		expect(() => syncGuarded({} as never, liveCtx() as never)).toThrow("boom");
		await expect(asyncGuarded({} as never, liveCtx() as never)).rejects.toThrow(
			"boom",
		);
		expect(staleGroup()).toBeUndefined();
	});

	it("keeps the event name as the ledger subject, and counts every skip", async () => {
		const turnEnd = wrapSessionEventHandler("turn_end", vi.fn());
		const toolResult = wrapSessionEventHandler("tool_result", vi.fn());

		turnEnd({} as never, makeStaleCtx() as never);
		turnEnd({} as never, makeStaleCtx() as never);
		toolResult({} as never, makeStaleCtx() as never);

		// Three skips, two subjects: aggregation must still answer WHICH handler
		// is being skipped after the detailed records stop.
		expect(staleGroup()?.count).toBe(3);
		expect(
			staleGroup()
				?.latestReasons.map((entry) => entry.subject)
				.sort(),
		).toEqual(["tool_result", "turn_end"]);
	});

	it("never lets a broken debug sink decide whether the event is handled", () => {
		const guarded = wrapSessionEventHandler("turn_start", vi.fn(), {
			dbg: () => {
				throw new Error("sink is broken");
			},
		});

		expect(() => guarded({} as never, makeStaleCtx() as never)).not.toThrow();
		expect(staleGroup()?.count).toBe(1);
	});

	it("records a stable identity resolution fallback once", () => {
		const guarded = wrapSessionEventHandler("turn_start", vi.fn());
		const ctx = {
			isIdle: () => true,
			get sessionManager(): never {
				throw new Error("session manager unavailable");
			},
		};

		guarded({} as never, ctx as never);
		guarded({} as never, ctx as never);

		expect(identityFallbackGroup()).toEqual(
			expect.objectContaining({
				kind: "turn-context-identity-fallback",
				count: 1,
			}),
		);
	});
});

/**
 * The value-returning variant (#1929).
 *
 * `context` must hand pi a message list on the live path, so it could not use
 * the void wrapper: a skip resolving to `undefined` was a guess about what
 * `undefined` means to the host, not a stated decision. This variant makes the
 * stale-path value an explicit argument. These tests use a SENTINEL fallback,
 * not `undefined`, so a wrapper that quietly hardcodes `undefined` again reds
 * here rather than passing by coincidence.
 */
describe("wrapSessionEventHandlerWithResult (#1929)", () => {
	const FALLBACK = { fallback: true } as const;

	beforeEach(() => {
		resetDegradationLedger();
	});

	function guard(handler: (event: unknown, ctx: unknown) => unknown) {
		return wrapSessionEventHandlerWithResult<unknown, unknown, unknown>(
			"context",
			handler,
			{ onStaleResult: () => FALLBACK },
		);
	}

	it("returns the handler's own value on a live ctx and calls no fallback", () => {
		const onStaleResult = vi.fn(() => ({ messages: ["fallback"] }));
		const guarded = wrapSessionEventHandlerWithResult<
			unknown,
			unknown,
			{ messages: string[] }
		>("context", () => ({ messages: ["injected"] }), { onStaleResult });

		expect(guarded({}, liveCtx())).toEqual({ messages: ["injected"] });
		expect(onStaleResult).not.toHaveBeenCalled();
		expect(staleGroup()).toBeUndefined();
	});

	it("returns the STATED fallback, not undefined, when the ctx probes stale", () => {
		const handler = vi.fn();
		const guarded = guard(handler);

		expect(guarded({}, makeStaleCtx())).toBe(FALLBACK);
		expect(handler).not.toHaveBeenCalled();
		expect(staleGroup()?.latestReasons[0]?.reason).toContain("pre-dispatch");
	});

	it("returns the stated fallback for a stale throw racing in mid-handler", () => {
		const guarded = guard(() => {
			throw new Error(STALE_CTX_MESSAGE);
		});

		expect(guarded({}, liveCtx())).toBe(FALLBACK);
		expect(staleGroup()?.latestReasons[0]?.reason).toContain("mid-handler");
	});

	it("resolves an async stale rejection to the stated fallback", async () => {
		const guarded = guard(async () => {
			throw new Error(STALE_CTX_MESSAGE);
		});

		await expect(guarded({}, liveCtx())).resolves.toBe(FALLBACK);
		expect(staleGroup()?.latestReasons[0]?.reason).toContain("mid-handler");
	});

	it("gives the fallback the EVENT and never the ctx that just died", () => {
		// The ctx is the thing that proved dead. Passing it to the fallback would
		// put a throwing accessor inside the guard that exists to absorb it.
		const onStaleResult = vi.fn(() => FALLBACK);
		const guarded = wrapSessionEventHandlerWithResult<
			unknown,
			unknown,
			unknown
		>("context", vi.fn(), { onStaleResult });
		const event = { messages: [{ role: "user", content: "keep me" }] };

		expect(guarded(event, makeStaleCtx())).toBe(FALLBACK);
		expect(onStaleResult).toHaveBeenCalledTimes(1);
		expect(onStaleResult).toHaveBeenCalledWith(event);
	});

	it("keeps a NON-stale failure loud and records nothing", async () => {
		const syncGuarded = guard(() => {
			throw new Error("boom");
		});
		const asyncGuarded = guard(async () => {
			throw new Error("boom");
		});

		expect(() => syncGuarded({}, liveCtx())).toThrow("boom");
		await expect(asyncGuarded({}, liveCtx())).rejects.toThrow("boom");
		expect(staleGroup()).toBeUndefined();
	});

	it("records under its own event name, like the void wrapper", () => {
		guard(vi.fn())({}, makeStaleCtx());

		expect(staleGroup()?.count).toBe(1);
		expect(staleGroup()?.latestReasons[0]?.subject).toBe("context");
	});
});

describe("isStaleExtensionCtxError (#1925)", () => {
	it("matches the SDK's message and nothing else", () => {
		expect(isStaleExtensionCtxError(new Error(STALE_CTX_MESSAGE))).toBe(true);
		expect(isStaleExtensionCtxError(new Error("some other failure"))).toBe(
			false,
		);
		expect(isStaleExtensionCtxError(STALE_CTX_MESSAGE)).toBe(false);
		expect(isStaleExtensionCtxError(undefined)).toBe(false);
	});
});
