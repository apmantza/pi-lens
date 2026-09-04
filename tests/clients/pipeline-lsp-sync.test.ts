// flake-shape: raw-timer-wait — "records NOTHING when Escape aborts mid-flight" (#2523 slice 2) schedules `setTimeout(() => controller.abort(), 20)` to fire the caller's abort DURING an in-flight, never-resolving `resyncLspFile` call; the subject is the ordering (abort arrives mid-await, not before or after), which a fake clock cannot exercise against a real never-settling mock without a manual `vi.advanceTimersByTimeAsync` that would just re-encode the same real ordering (#2557 review round 3).
/**
 * The pre-dispatch LSP sync (`resyncLspFile`) must never let a wedged language
 * server hang the edit. Its didChange/didOpen write can backpressure forever
 * when the server's stdin isn't drained, so the sync is bounded by a hard budget
 * (PI_LENS_LSP_SYNC_BUDGET_MS) and the turn's abort signal (Escape) — whichever
 * wins, resyncLspFile returns and the edit proceeds. Regression guard for the
 * "8h invisible edit hang" class.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatedPromise, starveBudget } from "../support/fault-injection.js";

vi.mock("../../clients/lsp/index.js", () => ({ getLSPService: vi.fn() }));

const logLatencyMock = vi.fn();

vi.mock("../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<typeof import("../../clients/latency-logger.js")>()),
	logLatency: (entry: unknown) => logLatencyMock(entry),
}));

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { resyncLspFile } from "../../clients/pipeline.js";
import { getLSPService } from "../../clients/lsp/index.js";
import { setAmbientAbortSignal } from "../../clients/safe-spawn.js";

const getFlag = () => undefined;
const dbg = () => {};

function mockService(
	touchFile: () => Promise<unknown>,
	isSpawnInFlight: () => boolean = () => false,
) {
	vi.mocked(getLSPService).mockReturnValue({
		supportsLSP: () => true,
		touchFile: vi.fn(touchFile),
		isSpawnInFlight: vi.fn(isSpawnInFlight),
		getAuxiliaryClientsForFile: vi.fn().mockResolvedValue([]),
	} as any);
}

beforeEach(() => {
	starveBudget("PI_LENS_LSP_SYNC_BUDGET_MS", 50);
	setAmbientAbortSignal(undefined);
	logLatencyMock.mockClear();
	resetDegradationLedger();
});
afterEach(() => {
	delete process.env.PI_LENS_LSP_SYNC_BUDGET_MS;
	setAmbientAbortSignal(undefined);
	vi.restoreAllMocks();
});

describe("resyncLspFile — bounded pre-dispatch LSP sync", () => {
	it("abandons a wedged touch after the budget instead of hanging", async () => {
		// touchFile that never resolves = a server whose didChange write backpressures.
		// Kit-gated (#1838): the wedge is an explicit gatedPromise, so "the budget
		// fired before the work completed" holds on any scheduler, any load.
		const gate = gatedPromise<unknown>();
		mockService(() => gate.promise);
		const started = Date.now();
		await resyncLspFile("/proj/a.ts", "content", true, false, getFlag, dbg);
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(45);
		expect(elapsed).toBeLessThan(2000); // returned, did not hang
		gate.resolve(null); // release the gate so nothing dangles into teardown
	});

	// #2523 slice 2. The bound above used to be `combineAbortSignals(abort,
	// AbortSignal.timeout(budgetMs))` fed into a hand-rolled `Promise.race` —
	// a private fifth copy of "deadline AND signal" that recorded nothing.
	// It is `bounded()` now, and the ledger row is the only difference an
	// elapsed-time assertion cannot see: revert the fold and this reds on a
	// missing `hook-await-exceeded`, while every case around it stays green.
	it("records the abandonment under hook-await-exceeded, naming the seam", async () => {
		const gate = gatedPromise<unknown>();
		mockService(() => gate.promise);
		await resyncLspFile("/proj/a.ts", "content", true, false, getFlag, dbg);
		const group = getDegradationSummary().find(
			(entry) => entry.kind === "hook-await-exceeded",
		);
		expect(group?.latestReasons.at(-1)?.subject).toBe(
			"tool_result_edit:resyncLspFile",
		);
		// The pre-existing latency record is NOT replaced by the ledger row —
		// the two answer different questions (which server stalled, versus
		// which hook budget was spent).
		expect(
			logLatencyMock.mock.calls
				.map((call) => call[0])
				.some((entry: any) => entry.phase === "lsp_sync_abandoned"),
		).toBe(true);
		gate.resolve(null);
	});

	it("records NOTHING when Escape aborts mid-flight — a cancel is not a degradation", async () => {
		// `bounded()`'s cause precedence, at this call site: a caller abort
		// must not surface in `pilens_health` next to a wedged server. Fold the
		// signal back out of the race and this case reds, because the deadline
		// would then be the only way out.
		mockService(() => new Promise(() => {}));
		const controller = new AbortController();
		setAmbientAbortSignal(controller.signal);
		process.env.PI_LENS_LSP_SYNC_BUDGET_MS = "10000";
		const pending = resyncLspFile(
			"/proj/a.ts",
			"content",
			true,
			false,
			getFlag,
			dbg,
		);
		setTimeout(() => controller.abort(), 20);
		await pending;
		// The WHOLE summary, not just `hook-await-exceeded`: recording a cancel
		// under the informational `hook-await-abandoned` kind instead would be
		// the same inversion in a quieter tier, and a kind-specific assertion
		// would wave it through (measured — that mutation left this green).
		expect(getDegradationSummary()).toEqual([]);
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

	// #1766: the resync deadline can expire while the target server's FIRST
	// spawn is still in flight (a cold spawn slower than the budget). The old
	// wording blamed that server as "slow/wedged" — a verdict about a running
	// server — even though it did not exist yet. Synthesize the race
	// deterministically via isSpawnInFlight rather than real spawn timing.
	it("reports spawn-in-flight, not slow/wedged, when the deadline fires during the server's first spawn", async () => {
		const dbgCalls: string[] = [];
		const dbgSpy = (msg: string) => dbgCalls.push(msg);
		mockService(
			() => new Promise(() => {}), // touch never resolves within the test
			() => true, // the target server's spawn is still unresolved
		);
		await resyncLspFile(
			"/proj/new.json",
			"content",
			true,
			false,
			getFlag,
			dbgSpy,
		);

		const joined = dbgCalls.join("\n");
		expect(joined).toContain("spawn-in-flight");
		expect(joined).not.toContain("slow/wedged");

		const abandoned = logLatencyMock.mock.calls
			.map((call) => call[0])
			.find((entry: any) => entry.phase === "lsp_sync_abandoned");
		expect(abandoned?.metadata?.reason).toBe("spawn-in-flight");
		expect(abandoned?.filePath).toBe("/proj/new.json");
	});

	it("still reports slow/wedged when no spawn is in flight (a genuinely stalled running server)", async () => {
		const dbgCalls: string[] = [];
		const dbgSpy = (msg: string) => dbgCalls.push(msg);
		mockService(
			() => new Promise(() => {}),
			() => false, // no spawn pending — this server is already running
		);
		await resyncLspFile("/proj/a.ts", "content", true, false, getFlag, dbgSpy);

		const joined = dbgCalls.join("\n");
		expect(joined).toContain("slow/wedged");
		expect(joined).not.toContain("spawn-in-flight");

		const abandoned = logLatencyMock.mock.calls
			.map((call) => call[0])
			.find((entry: any) => entry.phase === "lsp_sync_abandoned");
		expect(abandoned?.metadata?.reason).toBe("timeout");
	});

	// #1766 review F3: a service double (or a future service shape) that lacks
	// isSpawnInFlight must not throw. An unguarded call throws into the
	// swallow-all catch in resyncLspFile, which suppresses the
	// lsp_sync_abandoned record entirely — a stall that used to be logged
	// (even with the wrong reason) would go completely silent.
	it("degrades to the old timeout wording, without throwing, when the service lacks isSpawnInFlight", async () => {
		const dbgCalls: string[] = [];
		const dbgSpy = (msg: string) => dbgCalls.push(msg);
		vi.mocked(getLSPService).mockReturnValue({
			supportsLSP: () => true,
			touchFile: vi.fn(() => new Promise(() => {})),
			getAuxiliaryClientsForFile: vi.fn().mockResolvedValue([]),
			// isSpawnInFlight intentionally omitted — partial double / older shape.
		} as any);

		await resyncLspFile("/proj/a.ts", "content", true, false, getFlag, dbgSpy);

		const joined = dbgCalls.join("\n");
		expect(joined).toContain("slow/wedged");
		expect(joined).not.toContain("after autofix error"); // did not fall into the catch

		const abandoned = logLatencyMock.mock.calls
			.map((call) => call[0])
			.find((entry: any) => entry.phase === "lsp_sync_abandoned");
		expect(abandoned).toBeDefined();
		expect(abandoned?.metadata?.reason).toBe("timeout");
	});

	it("kicks off auxiliary server acquisition concurrently and unawaited (#2540)", async () => {
		const neverResolvingAux = new Promise<never>(() => {});
		const getAuxSpy = vi.fn().mockImplementation(() => neverResolvingAux);
		vi.mocked(getLSPService).mockReturnValue({
			supportsLSP: () => true,
			touchFile: vi.fn().mockResolvedValue("done"),
			getAuxiliaryClientsForFile: getAuxSpy,
		} as any);

		const resyncPromise = resyncLspFile(
			"/proj/a.ts",
			"content",
			true,
			false,
			() => undefined,
			dbg,
		);

		// resyncLspFile resolves immediately without waiting on auxiliary warmup
		await expect(resyncPromise).resolves.toBeUndefined();
		expect(getAuxSpy).toHaveBeenCalledTimes(1);
	});
});
