/**
 * #1620 — clientShutdown must stay bounded when the connection is wedged.
 *
 * The #1459 wedged-write breaker fires precisely when a server's stdin is not
 * draining. clientShutdown then handed that same stdin a synchronous
 * obligation: `await safeSendNotification(connection, "exit", {})` with no
 * timeout. The write never settled and never rejected, so disposal, the
 * lsp_client_shutdown record, and killProcessTree never ran —
 * every demoted server leaked.
 *
 * These tests drive clientShutdown against a connection double whose
 * "shutdown" request AND "exit" notification both never settle, and assert the
 * teardown still completes. Pre-fix they hang to their own vitest timeout.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageConnection } from "vscode-jsonrpc";
import { removeLspChild } from "../../../clients/instance-registry.js";
import { logLatency } from "../../../clients/latency-logger.js";
import { createMockState } from "./mock-client-state.js";

// Keep both budgets short so a wedged double is bounded well inside the
// per-test timeout. Assigned before any dynamic `client.js` import below, so
// the module-load-time env reads see these values.
process.env.PI_LENS_LSP_SHUTDOWN_TIMEOUT_MS = "50";
process.env.PI_LENS_LSP_EXIT_NOTIFY_TIMEOUT_MS = "50";

vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency: vi.fn(),
}));
vi.mock("../../../clients/instance-registry.js", () => ({
	recordLspChild: vi.fn().mockResolvedValue(undefined),
	removeLspChild: vi.fn().mockResolvedValue(undefined),
}));

type ClientModule = typeof import("../../../clients/lsp/client.js");

/**
 * A connection whose sends NEVER settle — the wedged-stdin case. Returning a
 * forever-pending promise is exactly what a jsonrpc write on a non-draining
 * pipe does: it neither resolves nor rejects, so `safeSendNotification`'s catch
 * never runs.
 */
function createWedgedConnection(): MessageConnection {
	return {
		sendNotification: vi.fn(() => new Promise<void>(() => {})),
		sendRequest: vi.fn(() => new Promise<never>(() => {})),
		onNotification: vi.fn(),
		onRequest: vi.fn(),
		onError: vi.fn(),
		onClose: vi.fn(),
		listen: vi.fn(),
		dispose: vi.fn(),
	} as unknown as MessageConnection;
}

function createWedgedState(kill: ReturnType<typeof vi.fn>) {
	// Build the state through the shared fixture so this test follows the real
	// LSPClientState contract, including lifecycle maps such as
	// `notifyChangeQueues`. Only the connection and child process boundaries are
	// doubled because they provide the wedged-transport and safe-pid probes.
	return createMockState({
		connection: createWedgedConnection(),
		serverId: "wedged",
		root: "/project",
		// pid 0 keeps killProcessTree off both the win32 `taskkill /F /T` branch
		// and the POSIX process-group kill, so the test can never signal a real
		// pid (a recycled pid once nuked a vitest worker — #1114). The direct
		// `proc.kill(SIGTERM)` fallback still runs, which is what we assert on.
		lspProcess: {
			pid: 0,
			process: {
				killed: false,
				exitCode: null,
				signalCode: null,
				kill,
				unref: vi.fn(),
				// Report the child exiting promptly so killProcessTree resolves on
				// the exit event instead of sleeping its 1500ms SIGKILL window.
				once: (_event: "exit", listener: () => void) => {
					setImmediate(listener);
				},
				off: vi.fn(),
			},
		} as any,
	});
}

/** How many `lsp_client_shutdown` records the teardowns so far wrote. */
function shutdownRecords(): number {
	return vi
		.mocked(logLatency)
		.mock.calls.filter(([e]) => e?.phase === "lsp_client_shutdown").length;
}

describe("clientShutdown with a fully wedged connection (#1620)", () => {
	beforeEach(() => {
		vi.mocked(logLatency).mockReset();
		vi.mocked(removeLspChild).mockClear();
	});

	it("resolves, disposes, and kills when both writes hang", async () => {
		const mod: ClientModule = await import("../../../clients/lsp/client.js");
		const kill = vi.fn(() => true);
		const state = createWedgedState(kill);

		await mod.clientShutdown(state);

		expect(state.connection.dispose).toHaveBeenCalledTimes(1);
		// #5699: the shutdown leaves the child's registry entry for the observed
		// exit (createLSPClient's listener). Removed here, before the kill, a
		// host killed in between kept no record of a server still running.
		expect(removeLspChild).not.toHaveBeenCalled();
		expect(kill).toHaveBeenCalled();
	}, 5_000);

	it("records lsp_client_shutdown marking the exit notify as forced", async () => {
		const mod: ClientModule = await import("../../../clients/lsp/client.js");
		const state = createWedgedState(vi.fn(() => true));

		await mod.clientShutdown(state);

		const hit = vi
			.mocked(logLatency)
			.mock.calls.find(([e]) => e?.phase === "lsp_client_shutdown");
		expect(hit).toBeDefined();
		const meta = hit![0].metadata!;
		expect(meta.serverId).toBe("wedged");
		expect(meta.shutdownRequestTimedOut).toBe(true);
		expect(meta.exitNotifyTimedOut).toBe(true);
		expect(meta.shutdownOutcome).toBe("forced");
	}, 5_000);

	it("marks a clean handshake graceful", async () => {
		const mod: ClientModule = await import("../../../clients/lsp/client.js");
		const state = createWedgedState(vi.fn(() => true));
		// Real LSP servers reply to "shutdown" with `null` (spec'd, `undefined`
		// is the swallowed-stream-error sentinel `safeSendRequest` itself
		// returns) — a faithful double resolves with the real shape rather
		// than colliding with that sentinel.
		state.connection.sendRequest = vi.fn().mockResolvedValue(null);
		state.connection.sendNotification = vi.fn().mockResolvedValue(undefined);

		await mod.clientShutdown(state);

		const hit = vi
			.mocked(logLatency)
			.mock.calls.find(([e]) => e?.phase === "lsp_client_shutdown");
		const meta = hit![0].metadata!;
		expect(meta.shutdownRequestTimedOut).toBe(false);
		expect(meta.exitNotifyTimedOut).toBe(false);
		expect(meta.shutdownOutcome).toBe("graceful");
	}, 5_000);

	// The #1459 breaker's caller view: demoteForNotifyStall fires
	// `void client.shutdown()` and immediately drops the entry. If that promise
	// never settles the child is never killed and never deregistered, which is
	// the leak the issue reports. Assert the settle is bounded.
	it("settles inside the shutdown budget so a demotion cannot leak", async () => {
		const mod: ClientModule = await import("../../../clients/lsp/client.js");
		const kill = vi.fn(() => true);
		const state = createWedgedState(kill);

		let settled = false;
		void mod.clientShutdown(state).then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 1000));

		expect(settled, "clientShutdown must settle within 1000ms").toBe(true);
		expect(kill).toHaveBeenCalled();
	}, 5_000);

	// #1620 residual 1: a rejection that is NOT the timer winning (a genuine
	// protocol error — NOT stream-shaped, so safeSendNotification's own
	// isStreamError check does not swallow it) must not be reported as a
	// timeout — the two are both "forced" for the rolled-up verdict, but the
	// per-field flag should say which happened. Mutation-proof: if
	// `isShutdownTimeoutError`'s exact-message check is loosened back to
	// "catch sets *TimedOut unconditionally", this rejection case flips to
	// `exitNotifyTimedOut: true` and the assertion below goes red.
	it("marks a genuine rejection as *Undelivered, not *TimedOut", async () => {
		const mod: ClientModule = await import("../../../clients/lsp/client.js");
		const state = createWedgedState(vi.fn(() => true));
		// Real LSP servers reply to "shutdown" with `null` (spec'd, `undefined`
		// is the swallowed-stream-error sentinel `safeSendRequest` itself
		// returns) — a faithful double resolves with the real shape rather
		// than colliding with that sentinel.
		state.connection.sendRequest = vi.fn().mockResolvedValue(null);
		// Deliberately NOT stream-shaped (no "stream"/"destroyed"/"closed"/
		// "disposed"/"cancelled" in the message, no EPIPE/ERR_STREAM_* code) —
		// safeSendNotification's `isStreamError` check must NOT swallow this,
		// so it actually reaches clientShutdownOnce's own catch.
		state.connection.sendNotification = vi
			.fn()
			.mockRejectedValue(new Error("Method not found"));

		await mod.clientShutdown(state);

		const hit = vi
			.mocked(logLatency)
			.mock.calls.find(([e]) => e?.phase === "lsp_client_shutdown");
		const meta = hit![0].metadata!;
		expect(meta.exitNotifyTimedOut).toBe(false);
		expect(meta.exitNotifyUndelivered).toBe(true);
		expect(meta.shutdownRequestTimedOut).toBe(false);
		expect(meta.shutdownRequestUndelivered).toBe(false);
		expect(meta.shutdownOutcome).toBe("forced");
	}, 5_000);

	// #1620 residual-review F2: safeSendNotification/safeSendRequest SWALLOW a
	// stream error (EPIPE, disposed connection — isStreamError) and RESOLVE
	// (false/undefined) instead of rejecting, so clientShutdownOnce's own
	// catch never runs for this case — a coded EPIPE must still be reported
	// as undelivered, not silently "graceful". Uses a genuinely CODED EPIPE
	// (matching isStreamError's `.code === "EPIPE"` branch), unlike a plain
	// `Error("write EPIPE")` which is NOT stream-shaped by message alone and
	// would (wrongly) exercise the rejection path above instead. Mutation-
	// proof: removing the `exitSent === false` / `shutdownAck === undefined`
	// checks turns this red — shutdownOutcome flips to "graceful" even though
	// nothing was delivered.
	it("marks a swallowed EPIPE as *Undelivered instead of reporting a clean exit", async () => {
		const mod: ClientModule = await import("../../../clients/lsp/client.js");
		const state = createWedgedState(vi.fn(() => true));
		const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
		state.connection.sendRequest = vi.fn().mockRejectedValue(epipe);
		state.connection.sendNotification = vi.fn().mockRejectedValue(epipe);

		await mod.clientShutdown(state);

		const hit = vi
			.mocked(logLatency)
			.mock.calls.find(([e]) => e?.phase === "lsp_client_shutdown");
		const meta = hit![0].metadata!;
		expect(meta.shutdownRequestTimedOut).toBe(false);
		expect(meta.exitNotifyTimedOut).toBe(false);
		expect(meta.shutdownRequestUndelivered).toBe(true);
		expect(meta.exitNotifyUndelivered).toBe(true);
		expect(meta.shutdownOutcome).toBe("forced");
	}, 5_000);

	// #1620 residual 3: two racing callers on the same state (8 call sites can
	// race the same client — see LSPClientState.shutdownPromise) must not each
	// run the RPC handshake and emit their own record. Mutation-proof: if the
	// `state.shutdownPromise` guard in clientShutdown() is removed, this test
	// goes red — TWO lsp_client_shutdown records and TWO kills instead of one.
	it("is idempotent: a second concurrent call awaits the first instead of re-running teardown", async () => {
		const mod: ClientModule = await import("../../../clients/lsp/client.js");
		const kill = vi.fn(() => true);
		const state = createWedgedState(kill);

		const first = mod.clientShutdown(state);
		const second = mod.clientShutdown(state);
		await Promise.all([first, second]);

		const hits = vi
			.mocked(logLatency)
			.mock.calls.filter(([e]) => e?.phase === "lsp_client_shutdown");
		expect(hits).toHaveLength(1);
		expect(kill).toHaveBeenCalledTimes(1);

		// A THIRD, sequential call after settlement also reuses the same
		// promise rather than starting a fresh teardown.
		await mod.clientShutdown(state);
		const hitsAfterThird = vi
			.mocked(logLatency)
			.mock.calls.filter(([e]) => e?.phase === "lsp_client_shutdown");
		expect(hitsAfterThird).toHaveLength(1);
	}, 5_000);

	// #1620 residual-review F1: a MORE aggressive call racing a weaker
	// in-flight teardown must not dedupe onto it — the concrete failure is
	// `resetLSPService`'s session-exit path (`index.ts:2719`,
	// `{fast:true, processExiting:true}`, called while the event loop is
	// closing) racing a graceful `client_ceiling_lru` eviction that is still
	// mid-handshake. Blind deduping would make the exit path wait out the
	// graceful run's SHUTDOWN_REQUEST_TIMEOUT_MS+EXIT_NOTIFY_TIMEOUT_MS
	// budget (100ms here, real budgets 1s+1s) and inherit whatever kill path
	// the graceful run takes — exactly what `processExiting` exists to
	// forbid. Mutation-proof: reverting the escalation check back to
	// unconditional `if (state.shutdownPromise) return state.shutdownPromise;`
	// turns this red — `fastElapsed` would be ~100ms instead of near-zero.
	it("F1: a fast+processExiting call escalates instead of waiting behind a weaker in-flight teardown", async () => {
		const mod: ClientModule = await import("../../../clients/lsp/client.js");
		const kill = vi.fn(() => true);
		const state = createWedgedState(kill);

		// Started but deliberately NOT awaited — the wedged connection means
		// this is still inside its SHUTDOWN_REQUEST_TIMEOUT_MS (50ms env
		// override) wait when the fast call below fires.
		const graceful = mod.clientShutdown(state);

		const fastStart = Date.now();
		await mod.clientShutdown(state, { fast: true, processExiting: true });
		const fastElapsed = Date.now() - fastStart;

		// The graceful budget is 50ms (request) + 50ms (notify) = 100ms; the
		// fast+processExiting path must resolve well inside that, proving it
		// ran its OWN teardown rather than inheriting the graceful one's wait.
		expect(fastElapsed).toBeLessThan(50);
		expect(kill).toHaveBeenCalled();

		const fastHit = vi
			.mocked(logLatency)
			.mock.calls.find(
				([e]) =>
					e?.phase === "lsp_client_shutdown" && e.metadata?.fast === true,
			);
		expect(fastHit).toBeDefined();
		expect(fastHit![0].metadata!.shutdownOutcome).toBe("fast");

		// Let the superseded graceful attempt settle too, so it doesn't leak
		// into the next test as a dangling unhandled rejection/timer.
		await graceful.catch(() => {});
	}, 5_000);

	// #1620 residual-review F3: a REJECTED teardown must not latch a
	// permanently-rejected `shutdownPromise` — every later call (even with
	// equal/weaker options) would otherwise dedupe onto that dead promise
	// forever, and the child would never get another kill/dispose/deregister
	// attempt (a silent leak). Forces a rejection via `killProcessTree`'s
	// uncaught `proc.unref()` call on the already-exited early-return path
	// (`exitCode` pre-set, `processExiting` unset). Mutation-proof: removing
	// the `attempt.catch(...)` clearing block turns this red — the retry never
	// records a second shutdown.
	it("F3: clears shutdownPromise on rejection so a retry actually retries", async () => {
		const mod: ClientModule = await import("../../../clients/lsp/client.js");
		const kill = vi.fn(() => true);
		const state = createWedgedState(kill);
		state.connection.sendRequest = vi.fn().mockResolvedValue(null);
		state.connection.sendNotification = vi.fn().mockResolvedValue(undefined);
		// Already "exited" so killProcessTree takes its early-return branch,
		// whose `proc.unref?.()` call is NOT wrapped in its own try/catch —
		// making it throw simulates any uncaught exception in that path.
		// `exitCode` is typed readonly on the real ChildProcess this double
		// stands in for — cast just this assignment, not the whole double.
		(state.lspProcess.process as { exitCode: number | null }).exitCode = 0;
		state.lspProcess.process.unref = () => {
			throw new Error("boom: simulated killProcessTree failure");
		};

		const firstAttempt = mod.clientShutdown(state);
		await expect(firstAttempt).rejects.toThrow("boom");
		// The clearing `.catch()` was attached (inside clientShutdown, before
		// this test ever saw the promise) ahead of the `.rejects` assertion
		// above, so per promise reaction ordering it has already run by the
		// time that `await` resolves — `shutdownPromise` is cleared here.
		expect(kill).not.toHaveBeenCalled(); // never reached kill — rejected before it
		expect(shutdownRecords()).toBe(1); // recorded once, before the throw

		// Fix the transient problem and retry — a cleared latch must start a
		// FRESH teardown, not return the same dead (or absent) promise.
		state.lspProcess.process.unref = vi.fn();
		const secondAttempt = mod.clientShutdown(state);
		expect(secondAttempt).not.toBe(firstAttempt);
		await secondAttempt;
		expect(shutdownRecords()).toBe(2);
	}, 5_000);
});
