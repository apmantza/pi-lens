/**
 * Regression test for #1097 — `pi --print --no-session` never exits after
 * `agent_settled`.
 *
 * Root cause: `LSPService.getClientForFile` raced the client-wait against an
 * inline `setTimeout(effectiveMaxWaitMs)` whose handle was never stored, so when
 * the client resolved first (the common case) the losing timer stayed a REF'D
 * pending timer for the full remaining wait budget. In a long-lived interactive
 * session that is invisible; in a one-shot print process it keeps the event loop
 * alive for up to `effectiveMaxWaitMs` after the run settles, so the completed
 * process hangs instead of exiting (a recurrence of #22's symptom via a
 * different handle).
 *
 * The fix clears the timer once the race settles. This test proves it by racing
 * a fast client win against a large wait budget and asserting no pending timer
 * survives — it FAILS on the pre-fix code (the orphaned wait timer lingers) and
 * PASSES once the timer is cleared.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

const FILE = "C:/repo/main.ts";
const LARGE_WAIT_MS = 15_000;

function makeServer(id: string) {
	return {
		id,
		name: id,
		extensions: [".ts"],
		idleEviction: "resident",
		root: async () => "C:/repo",
		spawn: vi.fn(async () => ({
			process: {
				killed: false,
				kill: vi.fn(),
				on: vi.fn(),
				removeListener: vi.fn(),
			},
			source: "test",
		})),
	};
}

function makeFakeClient() {
	return {
		isAlive: () => true,
		shutdown: async () => {},
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		waitForDiagnostics: vi.fn(() => Promise.resolve()),
		getDiagnostics: vi.fn(() => []),
	};
}

describe("getClientForFile — wait-timer cleanup (#1097)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("clears the wait timer when the client wins the race, leaving no pending timer", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		createLSPClient.mockResolvedValue(makeFakeClient());
		getServersForFileWithConfig.mockReturnValue([makeServer("ts")]);

		// Warm the client into the cache so the getClientForFile call below takes
		// the cached-alive path (no spawn) — isolating the wait timer as the only
		// timer that could be armed during the call.
		await service.getClientsForFile(FILE);
		await vi.runAllTimersAsync();

		// Baseline: no timers should be pending once warmup has fully settled.
		expect(vi.getTimerCount()).toBe(0);

		// The client is cached and alive, so `withBudget()` wins the race well
		// before the LARGE_WAIT_MS timeout. Pre-fix, the losing setTimeout is
		// orphaned but still pending here.
		const spawned = await service.getClientForFile(FILE, LARGE_WAIT_MS);
		expect(spawned).toBeTruthy();

		// The core assertion: the wait timer must have been cleared. On the pre-fix
		// code this is 1 (the orphaned LARGE_WAIT_MS timer) — the exact handle that
		// kept the one-shot process alive.
		expect(vi.getTimerCount()).toBe(0);
	});
});
