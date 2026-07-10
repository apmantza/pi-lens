import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleSessionStart } from "../../clients/runtime-session.js";
import {
	_resetSessionLifecycleForTests,
	classifySessionStart,
	classifySessionStartGuarded,
	decideSessionStart,
	getSecondarySessionCount,
	noteSessionShutdown,
	probeCtxActive,
	registerPrimarySession,
	registerSecondarySession,
} from "../../clients/session-lifecycle.js";
import { setupTestEnvironment } from "./test-utils.js";

function activeCtx(): unknown {
	return { isIdle: () => false };
}

function staleCtx(): unknown {
	return {
		isIdle: () => {
			throw new Error(
				"This extension ctx is stale after session replacement or reload.",
			);
		},
	};
}

function weirdThrowCtx(): unknown {
	return {
		isIdle: () => {
			throw new Error("some other unrelated error");
		},
	};
}

describe("classifySessionStart (pure truth table)", () => {
	afterEach(() => {
		_resetSessionLifecycleForTests();
	});

	it("no prior -> primary", () => {
		expect(
			classifySessionStart({
				hasPrior: false,
				priorCtxActive: undefined,
				sameSessionId: false,
			}),
		).toBe("primary");
	});

	it("prior exists, same session id -> sequential-replacement", () => {
		expect(
			classifySessionStart({
				hasPrior: true,
				priorCtxActive: true,
				sameSessionId: true,
			}),
		).toBe("sequential-replacement");
	});

	it("prior exists, confirmed invalidated (priorCtxActive=false) -> sequential-replacement", () => {
		expect(
			classifySessionStart({
				hasPrior: true,
				priorCtxActive: false,
				sameSessionId: false,
			}),
		).toBe("sequential-replacement");
	});

	it("prior exists, still active, different session id -> concurrent-secondary", () => {
		expect(
			classifySessionStart({
				hasPrior: true,
				priorCtxActive: true,
				sameSessionId: false,
			}),
		).toBe("concurrent-secondary");
	});

	it("prior exists, inconclusive probe -> sequential-replacement (fail-safe)", () => {
		expect(
			classifySessionStart({
				hasPrior: true,
				priorCtxActive: undefined,
				sameSessionId: false,
			}),
		).toBe("sequential-replacement");
	});
});

describe("classifySessionStartGuarded (kill switch)", () => {
	const prevEnv = process.env.PI_LENS_CONCURRENT_SESSION_GUARD;

	afterEach(() => {
		_resetSessionLifecycleForTests();
		if (prevEnv === undefined) {
			delete process.env.PI_LENS_CONCURRENT_SESSION_GUARD;
		} else {
			process.env.PI_LENS_CONCURRENT_SESSION_GUARD = prevEnv;
		}
	});

	it("PI_LENS_CONCURRENT_SESSION_GUARD=0 forces sequential-replacement even for a live concurrent sibling", () => {
		process.env.PI_LENS_CONCURRENT_SESSION_GUARD = "0";
		expect(
			classifySessionStartGuarded({
				hasPrior: true,
				priorCtxActive: true,
				sameSessionId: false,
			}),
		).toBe("sequential-replacement");
	});

	it("PI_LENS_CONCURRENT_SESSION_GUARD=0 with no prior still reports primary", () => {
		process.env.PI_LENS_CONCURRENT_SESSION_GUARD = "0";
		expect(
			classifySessionStartGuarded({
				hasPrior: false,
				priorCtxActive: undefined,
				sameSessionId: false,
			}),
		).toBe("primary");
	});

	it("guard enabled (default / any non-'0' value) behaves like the pure classifier", () => {
		delete process.env.PI_LENS_CONCURRENT_SESSION_GUARD;
		expect(
			classifySessionStartGuarded({
				hasPrior: true,
				priorCtxActive: true,
				sameSessionId: false,
			}),
		).toBe("concurrent-secondary");
	});
});

describe("probeCtxActive", () => {
	it("normal getter returns true", () => {
		expect(probeCtxActive(activeCtx())).toBe(true);
	});

	it("throwing getter with the stale-ctx message returns false", () => {
		expect(probeCtxActive(staleCtx())).toBe(false);
	});

	it("throwing getter with an unrelated message returns undefined (inconclusive)", () => {
		expect(probeCtxActive(weirdThrowCtx())).toBeUndefined();
	});

	it("missing accessor returns undefined", () => {
		expect(probeCtxActive({})).toBeUndefined();
	});

	it("null/undefined ctx returns undefined", () => {
		expect(probeCtxActive(null)).toBeUndefined();
		expect(probeCtxActive(undefined)).toBeUndefined();
	});

	it("never throws out of the probe", () => {
		expect(() => probeCtxActive(staleCtx())).not.toThrow();
		expect(() => probeCtxActive(weirdThrowCtx())).not.toThrow();
	});
});

describe("noteSessionShutdown", () => {
	afterEach(() => {
		_resetSessionLifecycleForTests();
	});

	it("no primary registered -> primary (nothing to compare against)", () => {
		expect(noteSessionShutdown(activeCtx(), "some-id")).toBe("primary");
	});

	it("shutdown carries the SAME session id as the registered primary -> primary", () => {
		registerPrimarySession(activeCtx(), "session-a");
		expect(noteSessionShutdown(activeCtx(), "session-a")).toBe("primary");
	});

	it("different session id AND the registered primary's ctx still probes active -> secondary", () => {
		const primaryCtx = activeCtx();
		registerPrimarySession(primaryCtx, "session-a");
		expect(noteSessionShutdown(activeCtx(), "session-b")).toBe("secondary");
	});

	it("different session id but the registered primary's ctx is confirmed stale -> primary (fail-safe)", () => {
		registerPrimarySession(staleCtx(), "session-a");
		expect(noteSessionShutdown(activeCtx(), "session-b")).toBe("primary");
	});

	it("different session id but the primary's ctx probe is inconclusive -> primary (fail-safe)", () => {
		registerPrimarySession(weirdThrowCtx(), "session-a");
		expect(noteSessionShutdown(activeCtx(), "session-b")).toBe("primary");
	});

	// D1 regression: a single ordinary session whose getSessionId() is
	// unavailable registers with sessionId=undefined; at its OWN shutdown its
	// ctx is still active (pi invalidates on replacement, not shutdown). It
	// must classify primary — else teardown is skipped on EVERY clean exit
	// and the LSP fleet leaks (#472 orphan class).
	it("primary's own shutdown with BOTH ids undefined and its own still-active ctx -> primary (ctx identity)", () => {
		const ownCtx = activeCtx();
		registerPrimarySession(ownCtx, undefined);
		expect(noteSessionShutdown(ownCtx, undefined)).toBe("primary");
	});

	it("primary's own shutdown with BOTH ids undefined and a per-emit FRESH ctx -> primary (unknown-id guard)", () => {
		// pi's ExtensionRunner.emit() builds a fresh ctx object per emit, so
		// the shutdown ctx normally differs from the registered one — the
		// unknown-id guard is the load-bearing fix for D1.
		registerPrimarySession(activeCtx(), undefined);
		expect(noteSessionShutdown(activeCtx(), undefined)).toBe("primary");
	});

	it("ctx identity beats an id mismatch (id read glitch) -> primary", () => {
		const ownCtx = activeCtx();
		registerPrimarySession(ownCtx, "session-a");
		expect(noteSessionShutdown(ownCtx, "session-b")).toBe("primary");
	});

	it("shutdown session id unknown while primary's id is known -> primary (never secondary on uncertainty)", () => {
		registerPrimarySession(activeCtx(), "session-a");
		expect(noteSessionShutdown(activeCtx(), undefined)).toBe("primary");
	});

	it("primary's id unknown while the shutdown id is known -> primary (never secondary on uncertainty)", () => {
		registerPrimarySession(activeCtx(), undefined);
		expect(noteSessionShutdown(activeCtx(), "session-b")).toBe("primary");
	});

	// Accepted fail-safe trade: a REAL secondary with unknown ids classifies
	// primary — its teardown runs and hurts the parent, same as pre-#473
	// behavior (a conservative miss). Uncertainty must never classify
	// secondary, because the false-secondary direction skips the primary's
	// own teardown on every clean exit.
	it("both ids undefined + DIFFERENT ctx + primary probes active -> primary (conservative miss, by design)", () => {
		registerPrimarySession(activeCtx(), undefined);
		expect(noteSessionShutdown(activeCtx(), undefined)).toBe("primary");
	});
});

describe("decideSessionStart (orchestration helper used by index.ts)", () => {
	beforeEach(() => {
		_resetSessionLifecycleForTests();
	});
	afterEach(() => {
		_resetSessionLifecycleForTests();
		delete process.env.PI_LENS_CONCURRENT_SESSION_GUARD;
	});

	it("first session_start in the process -> primary, runFullSessionStart true", () => {
		const decision = decideSessionStart(activeCtx(), "session-a");
		expect(decision.classification).toBe("primary");
		expect(decision.runFullSessionStart).toBe(true);
		expect(decision.secondaryCount).toBe(0);
	});

	it("second session_start with a live sibling primary -> concurrent-secondary, runFullSessionStart false", () => {
		decideSessionStart(activeCtx(), "session-a");
		const decision = decideSessionStart(activeCtx(), "session-b");
		expect(decision.classification).toBe("concurrent-secondary");
		expect(decision.runFullSessionStart).toBe(false);
		expect(decision.secondaryCount).toBe(1);
		expect(getSecondarySessionCount()).toBe(1);
	});

	it("multiple concurrent secondaries increment the counter", () => {
		decideSessionStart(activeCtx(), "session-a");
		decideSessionStart(activeCtx(), "session-b");
		const third = decideSessionStart(activeCtx(), "session-c");
		expect(third.secondaryCount).toBe(2);
	});

	it("same session id re-announcing itself -> sequential-replacement, runs full session start", () => {
		decideSessionStart(activeCtx(), "session-a");
		const decision = decideSessionStart(activeCtx(), "session-a");
		expect(decision.classification).toBe("sequential-replacement");
		expect(decision.runFullSessionStart).toBe(true);
	});

	it("SAME ctx object re-announcing itself (even with a different/unknown id) -> sequential-replacement, never concurrent", () => {
		const ownCtx = activeCtx();
		decideSessionStart(ownCtx, "session-a");
		const withDifferentId = decideSessionStart(ownCtx, "session-b");
		expect(withDifferentId.classification).toBe("sequential-replacement");
		expect(withDifferentId.runFullSessionStart).toBe(true);
		const withUnknownId = decideSessionStart(ownCtx, undefined);
		expect(withUnknownId.classification).toBe("sequential-replacement");
		expect(withUnknownId.runFullSessionStart).toBe(true);
	});

	it("prior ctx confirmed stale -> sequential-replacement, runs full session start", () => {
		registerPrimarySession(staleCtx(), "session-a");
		const decision = decideSessionStart(activeCtx(), "session-b");
		expect(decision.classification).toBe("sequential-replacement");
		expect(decision.runFullSessionStart).toBe(true);
	});

	it("kill switch forces sequential-replacement for what would otherwise be concurrent", () => {
		decideSessionStart(activeCtx(), "session-a");
		process.env.PI_LENS_CONCURRENT_SESSION_GUARD = "0";
		const decision = decideSessionStart(activeCtx(), "session-b");
		expect(decision.classification).toBe("sequential-replacement");
		expect(decision.runFullSessionStart).toBe(true);
	});

	it("registerSecondarySession alone (without decideSessionStart) still increments the shared counter", () => {
		registerPrimarySession(activeCtx(), "session-a");
		registerSecondarySession();
		expect(getSecondarySessionCount()).toBe(1);
	});
});

/**
 * Behavioral test mirroring index.ts's session_start wiring: classify via
 * `decideSessionStart`, and only call `handleSessionStart` when the decision
 * says to. This is the seam index.ts itself delegates to (the SDK's
 * `pi.on("session_start", ...)` cannot be invoked directly in a test), so
 * exercising this composition IS exercising the real wiring's behavior.
 */
async function runGuardedSessionStart(
	runtime: RuntimeCoordinator,
	resetLSPService: () => void,
	ctx: unknown,
	sessionId: string | undefined,
	tmpDir: string,
) {
	const decision = decideSessionStart(ctx, sessionId);
	if (!decision.runFullSessionStart) {
		return decision;
	}
	await handleSessionStart({
		ctxCwd: tmpDir,
		getFlag: () => false,
		notify: () => {},
		dbg: () => {},
		log: () => {},
		runtime,
		metricsClient: { reset: () => {} },
		cacheManager: { writeCache: () => {}, readCache: () => null },
		todoScanner: { scanDirectory: () => ({ items: [] }) },
		astGrepClient: {},
		biomeClient: {},
		ruffClient: {},
		knipClient: {},
		jscpdClient: {},
		depChecker: {},
		testRunnerClient: {
			detectRunner: () => null,
			runTestFile: () => ({ failed: 0, error: false }),
		},
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		ensureTool: async () => null,
		cleanStaleTsBuildInfo: () => [],
		resetDispatchBaselines: () => {},
		resetLSPService,
	} as any);
	return decision;
}

describe("concurrent session_start guard — behavioral (index.ts wiring seam)", () => {
	beforeEach(() => {
		_resetSessionLifecycleForTests();
	});
	afterEach(() => {
		_resetSessionLifecycleForTests();
		delete process.env.PI_LENS_CONCURRENT_SESSION_GUARD;
	});

	it("a concurrent secondary session_start leaves runtime.sessionGeneration unchanged and never calls resetLSPService", async () => {
		const env = setupTestEnvironment("pi-lens-concurrent-secondary-");
		try {
			const runtime = new RuntimeCoordinator();
			const resetLSPService = vi.fn();

			// Primary session_start (the parent).
			await runGuardedSessionStart(
				runtime,
				resetLSPService,
				activeCtx(),
				"parent-session",
				env.tmpDir,
			);
			const generationAfterPrimary = runtime.sessionGeneration;
			expect(resetLSPService).toHaveBeenCalledTimes(1);

			// Concurrent in-process subagent bind — the parent's ctx is still
			// active (activeCtx() never throws), and the session id differs.
			const decision = await runGuardedSessionStart(
				runtime,
				resetLSPService,
				activeCtx(),
				"subagent-session",
				env.tmpDir,
			);

			expect(decision.classification).toBe("concurrent-secondary");
			expect(runtime.sessionGeneration).toBe(generationAfterPrimary);
			// Still only the one call from the primary's session_start.
			expect(resetLSPService).toHaveBeenCalledTimes(1);
		} finally {
			env.cleanup();
		}
	});

	it("with PI_LENS_CONCURRENT_SESSION_GUARD=0, the same sequence resets as today (behavior unchanged)", async () => {
		const env = setupTestEnvironment("pi-lens-guard-disabled-");
		try {
			const runtime = new RuntimeCoordinator();
			const resetLSPService = vi.fn();

			await runGuardedSessionStart(
				runtime,
				resetLSPService,
				activeCtx(),
				"parent-session",
				env.tmpDir,
			);
			const generationAfterPrimary = runtime.sessionGeneration;
			expect(resetLSPService).toHaveBeenCalledTimes(1);

			process.env.PI_LENS_CONCURRENT_SESSION_GUARD = "0";
			const decision = await runGuardedSessionStart(
				runtime,
				resetLSPService,
				activeCtx(),
				"subagent-session",
				env.tmpDir,
			);

			expect(decision.classification).toBe("sequential-replacement");
			expect(decision.runFullSessionStart).toBe(true);
			// Kill switch: today's behavior — reset runs again, generation bumps.
			expect(resetLSPService).toHaveBeenCalledTimes(2);
			expect(runtime.sessionGeneration).toBeGreaterThan(generationAfterPrimary);
		} finally {
			env.cleanup();
		}
	});
});
