/**
 * #2507 — the counted keep-alive's own state machine.
 *
 * The END-TO-END property (a real headless child neither exiting mid-call nor
 * hanging after it) lives in
 * `tests/clients/lsp/headless-tool-call-keepalive.test.ts`, where a real
 * process's real event loop is the thing under observation. What is provable
 * in-process, and what this file pins, is everything that decides WHETHER a
 * referenced handle exists at each moment: arm on the first hold, stay armed
 * across overlapping holds, disarm on the last release, and — the inverse
 * defect — force-release past the bound so a leaked hold cannot pin a process
 * open forever.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acquireEventLoopHold,
	getEventLoopHoldMaxMs,
	_eventLoopHoldCountForTests,
	_eventLoopKeepAliveForTests,
	_resetEventLoopHoldForTests,
} from "../../clients/event-loop-hold.js";
import { getWorkspaceSweepMaxHoldAgeMs } from "../../clients/lsp/workspace-sweep-hold.js";

const logLatencyMock = vi.fn();

vi.mock("../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<typeof import("../../clients/latency-logger.js")>()),
	logLatency: (entry: unknown) => logLatencyMock(entry),
}));

function loggedPhase(phase: string): boolean {
	return logLatencyMock.mock.calls.some(
		(call: unknown[]) => (call[0] as { phase?: string })?.phase === phase,
	);
}

describe("event-loop hold (#2507)", () => {
	beforeEach(() => {
		logLatencyMock.mockReset();
		_resetEventLoopHoldForTests();
	});

	afterEach(() => {
		_resetEventLoopHoldForTests();
		vi.useRealTimers();
	});

	it("holds nothing while idle", () => {
		expect(_eventLoopHoldCountForTests()).toBe(0);
		expect(_eventLoopKeepAliveForTests()).toEqual({
			armed: false,
			hasRef: false,
		});
	});

	it("arms a REFERENCED handle for the first hold and disarms on the last release", () => {
		const release = acquireEventLoopHold("lsp_diagnostics");
		// `hasRef` is the whole point: an armed-but-unref'd handle would leave
		// the loop exactly as drainable as it was before the fix.
		expect(_eventLoopKeepAliveForTests()).toEqual({
			armed: true,
			hasRef: true,
		});
		release();
		expect(_eventLoopHoldCountForTests()).toBe(0);
		expect(_eventLoopKeepAliveForTests()).toEqual({
			armed: false,
			hasRef: false,
		});
	});

	it("stays armed while an overlapping hold is still outstanding", () => {
		const first = acquireEventLoopHold("lsp_diagnostics");
		const second = acquireEventLoopHold("lens_diagnostics");
		expect(_eventLoopHoldCountForTests()).toBe(2);
		first();
		expect(_eventLoopHoldCountForTests()).toBe(1);
		expect(_eventLoopKeepAliveForTests().armed).toBe(true);
		second();
		expect(_eventLoopKeepAliveForTests().armed).toBe(false);
	});

	it("releases idempotently — a double release never drops someone else's hold", () => {
		const first = acquireEventLoopHold("lsp_diagnostics");
		const second = acquireEventLoopHold("symbol_search");
		first();
		first();
		expect(_eventLoopHoldCountForTests()).toBe(1);
		expect(_eventLoopKeepAliveForTests().armed).toBe(true);
		second();
		expect(_eventLoopHoldCountForTests()).toBe(0);
	});

	it("force-releases past the bound so a leaked hold cannot pin the process open", () => {
		vi.useFakeTimers();
		acquireEventLoopHold("lsp_diagnostics");
		expect(_eventLoopKeepAliveForTests().armed).toBe(true);

		vi.advanceTimersByTime(getEventLoopHoldMaxMs() + 1);

		expect(_eventLoopHoldCountForTests()).toBe(0);
		expect(_eventLoopKeepAliveForTests().armed).toBe(false);
		expect(loggedPhase("event_loop_hold_force_released")).toBe(true);
		const record = logLatencyMock.mock.calls
			.map((call) => call[0] as { phase?: string; metadata?: unknown })
			.find((entry) => entry.phase === "event_loop_hold_force_released");
		expect(record?.metadata).toMatchObject({
			releasedHolds: 1,
			labels: ["lsp_diagnostics"],
		});
	});

	it("reaps only the hold that is actually stale and keeps holding for the younger one", () => {
		// #2649 review F1. The bound is per HOLD, not per epoch: a call that
		// starts while an older one is still running must get its OWN max age,
		// not inherit the remaining sliver of the first one's. The round-1 code
		// armed one timer on 0→1 and cleared EVERY token when it fired, so a
		// tool call issued late in a legitimate `lens_diagnostics mode=full`
		// was force-released seconds after starting — the #2507 drain,
		// reproduced BY the fix. One hold could never show it; two of
		// different ages is the case that can.
		vi.useFakeTimers();
		const maxMs = getEventLoopHoldMaxMs();
		acquireEventLoopHold("lens_diagnostics");
		vi.advanceTimersByTime(maxMs - 1_000);
		acquireEventLoopHold("lsp_diagnostics");

		// Past the OLD hold's deadline, nowhere near the young one's.
		vi.advanceTimersByTime(2_000);

		expect(_eventLoopHoldCountForTests()).toBe(1);
		expect(_eventLoopKeepAliveForTests()).toEqual({
			armed: true,
			hasRef: true,
		});
		const record = logLatencyMock.mock.calls
			.map((call) => call[0] as { phase?: string; metadata?: unknown })
			.find((entry) => entry.phase === "event_loop_hold_force_released");
		// The record names the wedged call only — a healthy bystander in
		// `labels` would make the row unable to say what actually wedged.
		expect(record?.metadata).toMatchObject({
			releasedHolds: 1,
			labels: ["lens_diagnostics"],
		});
	});

	it("re-arms for the survivor's own deadline rather than disarming", () => {
		// #2649 review F1, second half: after a reap the timer must be armed
		// again for the SOONEST remaining deadline, or the survivor is held by
		// nothing (drain) or forever (leak).
		vi.useFakeTimers();
		const maxMs = getEventLoopHoldMaxMs();
		acquireEventLoopHold("lens_diagnostics");
		vi.advanceTimersByTime(maxMs - 1_000);
		acquireEventLoopHold("lsp_diagnostics");
		vi.advanceTimersByTime(2_000);
		expect(_eventLoopHoldCountForTests()).toBe(1);

		// The survivor's own full max age, measured from ITS acquire.
		vi.advanceTimersByTime(maxMs);

		expect(_eventLoopHoldCountForTests()).toBe(0);
		expect(_eventLoopKeepAliveForTests().armed).toBe(false);
		const records = logLatencyMock.mock.calls
			.map((call) => call[0] as { phase?: string; metadata?: unknown })
			.filter((entry) => entry.phase === "event_loop_hold_force_released");
		expect(records).toHaveLength(2);
		expect(records[1]?.metadata).toMatchObject({
			releasedHolds: 1,
			labels: ["lsp_diagnostics"],
		});
	});

	it("records the keep-alive being taken, once per session", () => {
		// #2649 review F2: without this the ONLY record the hold ever writes is
		// the failsafe, so a reader cannot tell "the keep-alive works" from
		// "the keep-alive was never wired at all" (the #2526 gap shape).
		const first = acquireEventLoopHold("lsp_diagnostics");
		first();
		const second = acquireEventLoopHold("symbol_search");
		second();
		const armed = logLatencyMock.mock.calls
			.map((call) => call[0] as { phase?: string; metadata?: unknown })
			.filter((entry) => entry.phase === "event_loop_hold_armed");
		expect(armed).toHaveLength(1);
		expect(armed[0]?.metadata).toMatchObject({
			label: "lsp_diagnostics",
			maxHoldMs: getEventLoopHoldMaxMs(),
		});
	});

	it("a throwing latency sink cannot break the caller that took the hold", () => {
		// #2649 verify F3, first half. `recordFirstArm` runs on the acquire path,
		// so a broken sink used to throw straight out of `acquireEventLoopHold` —
		// and `normalizeToolDefinition` takes the hold OUTSIDE its own try, so the
		// tool call rejected with "sink broke" instead of returning its result.
		// The house rule at `clients/runtime-tool-call.ts`: a guard that fails
		// because its telemetry broke is worse than no guard.
		logLatencyMock.mockImplementation(() => {
			throw new Error("sink broke");
		});

		let release: (() => void) | undefined;
		expect(() => {
			release = acquireEventLoopHold("lsp_diagnostics");
		}).not.toThrow();
		// And the hold it handed back is a REAL one, not a swallowed no-op.
		expect(_eventLoopHoldCountForTests()).toBe(1);
		expect(_eventLoopKeepAliveForTests()).toEqual({
			armed: true,
			hasRef: true,
		});
		release?.();
		expect(_eventLoopHoldCountForTests()).toBe(0);
		expect(_eventLoopKeepAliveForTests().armed).toBe(false);
	});

	it("a throwing latency sink cannot strand a survivor un-re-armed", () => {
		// #2649 verify F3, second half: the force-release log sits between the
		// reap and the re-arm, so a throw there skipped `armForNextDeadline` and
		// left the surviving hold referenced by nothing and never re-armed —
		// the exact outcome the code's own comment names.
		vi.useFakeTimers();
		const maxMs = getEventLoopHoldMaxMs();
		acquireEventLoopHold("lens_diagnostics");
		vi.advanceTimersByTime(maxMs - 1_000);
		acquireEventLoopHold("lsp_diagnostics");
		logLatencyMock.mockImplementation(() => {
			throw new Error("sink broke");
		});

		// The reap fires with the sink broken. Nothing may escape the timer
		// callback either — an uncaught throw there takes the process down.
		expect(() => vi.advanceTimersByTime(2_000)).not.toThrow();

		expect(_eventLoopHoldCountForTests()).toBe(1);
		expect(_eventLoopKeepAliveForTests()).toEqual({
			armed: true,
			hasRef: true,
		});

		// Re-armed for the survivor's OWN deadline, not merely left armed.
		logLatencyMock.mockImplementation(() => undefined);
		vi.advanceTimersByTime(maxMs);
		expect(_eventLoopHoldCountForTests()).toBe(0);
		expect(_eventLoopKeepAliveForTests().armed).toBe(false);
	});

	it("derives its bound from the longest legitimate operation's own ceiling", () => {
		// Not a second tunable literal: the full-scan wall clock plus the shared
		// safety margin, the same derivation the workspace-sweep hold's max-age
		// failsafe uses (AGENTS.md shape 15's "derive, don't re-declare").
		expect(getEventLoopHoldMaxMs()).toBe(getWorkspaceSweepMaxHoldAgeMs());
	});
});
