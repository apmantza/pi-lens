/**
 * #4782: a stored push answer never settles a diagnostics wait while a LATER
 * receipt for the same path sits in the publish handler's quiet window.
 *
 * Recurrence this file prevents: the #4507 phantom STOP under load. A bash
 * command rewrote a dependency z.ts and its dependent a.ts. The primary's
 * answer for a.ts checked against z.ts's old bytes was stored; its answer
 * after z.ts's change arrived right before the drain reply and was still in
 * its quiet window when the dispatch read a.ts, so the read took the stored
 * one (`tests/clients/head-move-resync-4493.test.ts` drives that end to end).
 *
 * Production chain: the REAL `publishDiagnostics` handler from
 * `setupIncomingHandlers` and the REAL `clientWaitForDiagnostics` over
 * `createMockState` ("test-server": the default strategy, a 150 ms quiet
 * window); the JSON-RPC connection is the only double. Each case records the
 * cache the moment the wait resolves: that is what `touchFile` reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearDiagnosticsForPath,
	clientWaitForDiagnostics,
	type LSPClientState,
	type LSPDiagnostic,
	noteServerShowMessage,
	setupIncomingHandlers,
} from "../../../clients/lsp/client.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { createMockState } from "./mock-client-state.js";

const FILE = "/project/src/a.ts";
const KEY = normalizeMapKey(FILE);
const URI = `file://${FILE}`;
const QUIET_MS = 150;
const WAIT_MS = 2_000;
const STALE: LSPDiagnostic = {
	severity: 1,
	message: "Module '\"./z\"' has no exported member 'isChatModelConfig'.",
	range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
};
const FOUND: LSPDiagnostic = { ...STALE, message: "a finding that stands" };

type Publish = (params: {
	uri: string;
	diagnostics?: LSPDiagnostic[];
	version?: number;
}) => void;

function harness(overrides?: Partial<LSPClientState>): {
	state: LSPClientState;
	publish: Publish;
} {
	const state = createMockState(overrides);
	state.openDocuments.add(KEY);
	state.openDocumentUris?.set(KEY, URI);
	state.documentVersions.set(KEY, 1);
	setupIncomingHandlers(state, {});
	const calls = vi.mocked(state.connection.onNotification).mock
		.calls as unknown as Array<[string, Publish]>;
	const publish = calls.find(
		(call) => call[0] === "textDocument/publishDiagnostics",
	)?.[1] as Publish;
	return { state, publish };
}

/** Start a no-baseline wait (the skipped dispatch touch's) and watch it. */
function startWait(state: LSPClientState) {
	const started = Date.now();
	const settled: { at?: number; read?: LSPDiagnostic[] } = {};
	const wait = clientWaitForDiagnostics(state, FILE, WAIT_MS).then(() => {
		settled.at = Date.now() - started;
		settled.read = state.pushDiagnostics.get(KEY);
	});
	return { wait, settled };
}

describe("#4782: a later receipt in the quiet window outranks the stored answer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// Recurrence: #4782, the measured shape: the wait starts with the stale
	// answer stored and the newer one pending.
	it("does not return the stored answer at once while a later receipt is pending", async () => {
		const { state, publish } = harness();
		publish({ uri: URI, diagnostics: [STALE] });
		await vi.advanceTimersByTimeAsync(QUIET_MS);
		publish({ uri: URI, diagnostics: [] });

		const { wait, settled } = startWait(state);
		await vi.advanceTimersByTimeAsync(WAIT_MS);
		await wait;

		expect(settled.read).toEqual([]);
		expect(settled.at).toBeLessThan(WAIT_MS);
	});

	// Recurrence: the same race one step later: the stale answer is stored
	// while the wait listens, and the newer receipt arrives before the quiet
	// window it armed comes due.
	it("does not settle on the stored answer when a later receipt arrives inside the quiet window", async () => {
		const { state, publish } = harness();
		const { wait, settled } = startWait(state);
		publish({ uri: URI, diagnostics: [STALE] });
		await vi.advanceTimersByTimeAsync(QUIET_MS + 100);
		publish({ uri: URI, diagnostics: [] });
		await vi.advanceTimersByTimeAsync(WAIT_MS);
		await wait;

		expect(settled.read).toEqual([]);
		expect(settled.at).toBeLessThan(WAIT_MS);
	});

	// Recurrence: a guard that waits for a receipt must not wait out the whole
	// budget when that receipt is dropped unstored: superseded here (an older
	// version than the one sent), so the stored answer decides at once again.
	it("settles on the stored answer as soon as the pending receipt is dropped as superseded", async () => {
		const { state, publish } = harness();
		publish({ uri: URI, diagnostics: [FOUND], version: 1 });
		await vi.advanceTimersByTimeAsync(QUIET_MS);
		publish({ uri: URI, diagnostics: [], version: 0 });

		const { wait, settled } = startWait(state);
		await vi.advanceTimersByTimeAsync(WAIT_MS);
		await wait;

		expect(settled.read).toEqual([FOUND]);
		expect(settled.at).toBeLessThanOrEqual(QUIET_MS);
	});

	// Recurrence: the other unstored exit (#4764): an empty receipt from a
	// scanner whose rules failed to load while it was pending is refused.
	it("settles on the stored answer as soon as the pending receipt is refused for a config failure", async () => {
		const { state, publish } = harness();
		publish({ uri: URI, diagnostics: [FOUND] });
		await vi.advanceTimersByTimeAsync(QUIET_MS);
		publish({ uri: URI, diagnostics: [] });
		state.configLoadFailure = { message: "rules failed to load", atMs: 0 };

		const { wait, settled } = startWait(state);
		await vi.advanceTimersByTimeAsync(WAIT_MS);
		await wait;

		expect(settled.read).toEqual([FOUND]);
		expect(settled.at).toBeLessThanOrEqual(QUIET_MS);
	});

	// Recurrence: a quiet window that came due while a receipt was pending is
	// owed its settle when that receipt is dropped, even on an empty answer
	// (an empty cache alone never ends a wait at its start).
	it("settles a deferred quiet window when the pending receipt is dropped", async () => {
		const { state, publish } = harness();
		const { wait, settled } = startWait(state);
		publish({ uri: URI, diagnostics: [], version: 1 });
		await vi.advanceTimersByTimeAsync(QUIET_MS + 100);
		publish({ uri: URI, diagnostics: [STALE], version: 0 });
		await vi.advanceTimersByTimeAsync(WAIT_MS);
		await wait;

		expect(settled.read).toEqual([]);
		expect(settled.at).toBeLessThan(WAIT_MS);
	});

	// Recurrence: #4785 review F1. A seed-first store left the receipt pending
	// before it alive, so the pending-receipt rule made the wait defer to that
	// OLDER answer, which then overwrote the newer one. The path: an auxiliary
	// with a stored empty answer and a finding pending; its #4764 config failure
	// retracts the empty store and keeps the timer; the next publish seeds.
	it("a seed-first store supersedes the receipt pending before it", async () => {
		// `zizmor` is a registry auxiliary whose strategy row sets
		// `seedFirstPush: true` (wait-policy/strategies.ts). This test first used
		// `eslint`, a runner id, not a server; its strategy row was deleted (#5485).
		const { state, publish } = harness({
			serverId: "zizmor",
			serverRole: "auxiliary",
		});
		const NEW: LSPDiagnostic = { ...STALE, message: "the newest answer" };
		publish({ uri: URI, diagnostics: [] });
		publish({ uri: URI, diagnostics: [STALE] });
		noteServerShowMessage(state, {
			type: 1,
			message:
				"Fatal error: failed to load config from https://example.invalid/p/default",
		});
		publish({ uri: URI, diagnostics: [NEW] });

		const { wait, settled } = startWait(state);
		await vi.advanceTimersByTimeAsync(WAIT_MS);
		await wait;

		expect(settled.read).toEqual([NEW]);
		expect(state.pushDiagnostics.get(KEY)).toEqual([NEW]);
		expect(settled.at).toBe(0);
	});

	// Recurrence: #4785 verify F4. Round 2 ended this wait at once when the
	// clear cancelled the pending receipt, on a store the clear had emptied,
	// and the touch read that early resolve as a confirmed clean. The wait now
	// waits for the server's next answer (or its deadline).
	it("waits for a later answer when a clear cancels the pending receipt it deferred to", async () => {
		const { state, publish } = harness();
		publish({ uri: URI, diagnostics: [FOUND] });
		await vi.advanceTimersByTimeAsync(QUIET_MS);
		publish({ uri: URI, diagnostics: [] });

		const { wait, settled } = startWait(state);
		clearDiagnosticsForPath(state, KEY);
		await vi.advanceTimersByTimeAsync(100);
		publish({ uri: URI, diagnostics: [STALE] });
		await vi.advanceTimersByTimeAsync(WAIT_MS);
		await wait;

		expect(settled.read).toEqual([STALE]);
		expect(settled.at).toBeLessThan(WAIT_MS);
	});

	// Recurrence: #4785 verify F4, the window sibling (on master too). A clear
	// inside the quiet window a store armed emptied the store, and the window
	// still settled: an early resolve with nothing stored.
	it("does not settle on a store that a clear removed inside the quiet window", async () => {
		const { state, publish } = harness();
		const { wait, settled } = startWait(state);
		publish({ uri: URI, diagnostics: [FOUND] });
		await vi.advanceTimersByTimeAsync(QUIET_MS + 50);
		clearDiagnosticsForPath(state, KEY);
		await vi.advanceTimersByTimeAsync(QUIET_MS);
		publish({ uri: URI, diagnostics: [STALE] });
		await vi.advanceTimersByTimeAsync(WAIT_MS);
		await wait;

		expect(settled.read).toEqual([STALE]);
		expect(settled.at).toBeLessThan(WAIT_MS);
	});

	// Recurrence: #4785 verify F4 through the drop exit. After a clear, a
	// superseded receipt's drop must not end a deferred wait on the emptied
	// store; the answer for the new send does.
	it("does not end a deferred wait on a drop after a clear emptied the store", async () => {
		const { state, publish } = harness();
		const NEW: LSPDiagnostic = { ...STALE, message: "the answer for v2" };
		publish({ uri: URI, diagnostics: [FOUND], version: 1 });
		await vi.advanceTimersByTimeAsync(QUIET_MS);
		publish({ uri: URI, diagnostics: [], version: 1 });

		const { wait, settled } = startWait(state);
		clearDiagnosticsForPath(state, KEY);
		state.documentVersions.set(KEY, 2);
		publish({ uri: URI, diagnostics: [STALE], version: 1 });
		await vi.advanceTimersByTimeAsync(QUIET_MS + 50);
		publish({ uri: URI, diagnostics: [NEW], version: 2 });
		await vi.advanceTimersByTimeAsync(WAIT_MS);
		await wait;

		expect(settled.read).toEqual([NEW]);
		expect(settled.at).toBeLessThan(WAIT_MS);
	});
});
