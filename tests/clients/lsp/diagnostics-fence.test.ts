/**
 * #3484: a diagnostics fence for servers that publish without a version.
 *
 * Recurrence this file prevents: a version-less server's publish for the
 * content BEFORE a touch arrived after the touch's clear, was stored (no
 * version, so `isSupersededPush` could not drop it) and settled the touch's
 * diagnostics wait, with or without a baseline. `touchFile` then reported the
 * old content's diagnostics as this edit's answer.
 *
 * The fix sends `textDocument/documentSymbol` in the same tick as the content
 * notification and drops version-less publishes for the path until its reply.
 * Known limit (the model's `FenceAsyncServer`): a server that answers the fence
 * and THEN publishes an older analysis still defeats it.
 *
 * Production chain: the REAL client (`handleNotifyOpen`, the REAL
 * `publishDiagnostics` handler from `setupIncomingHandlers`,
 * `clientWaitForDiagnostics`) over `createMockState`; the JSON-RPC connection is
 * the only double, and its sends are held with gates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logLatency } = vi.hoisted(() => ({ logLatency: vi.fn() }));
vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency,
}));

import {
	clientWaitForDiagnostics,
	handleNotifyChange,
	diagnosticsVersionForPath,
	handleNotifyOpen,
	isConnectionBusy,
	publicationCountsForPath,
	type LSPClientState,
	type LSPDiagnostic,
	setupIncomingHandlers,
} from "../../../clients/lsp/client.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import {
	gatedPromise,
	type GatedPromise,
} from "../../support/fault-injection.js";
import { createMockState } from "./mock-client-state.js";

const FILE = "/project/src/app.ts";
const KEY = normalizeMapKey(FILE);
const URI = `file://${FILE}`;
const STALE: LSPDiagnostic = {
	severity: 1,
	message: "error computed for content 0 (pre-touch)",
	range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
};
const FRESH: LSPDiagnostic = { ...STALE, message: "computed for content 1" };
const QUIET_MS = 1_000;
const WAIT_MS = 600;

type Publish = (params: {
	uri: string;
	diagnostics?: LSPDiagnostic[];
	version?: number;
}) => void;

interface Harness {
	state: LSPClientState;
	publish: Publish;
	wire: string[];
	change: GatedPromise<void>;
	fence: GatedPromise<unknown>;
	/** The cancellation token each fence request was sent with. */
	tokens: Array<{ isCancellationRequested: boolean } | undefined>;
}

/**
 * `serverId` picks the strategy: "yaml" carries the measured `reply-first`
 * fence marker; "docker" and "test-server" do not. `onFence` runs when the
 * fence request is sent, before its reply: the docker shape publishes the new
 * content there.
 */
function harness(
	options: {
		documentSymbol?: boolean;
		serverId?: string;
		onFence?: (publish: Publish) => void;
	} = {},
): Harness {
	const state = createMockState({ serverId: options.serverId ?? "yaml" });
	state.operationSupport.documentSymbol = options.documentSymbol ?? true;
	state.openDocuments.add(KEY);
	state.openDocumentUris?.set(KEY, URI);
	state.documentVersions.set(KEY, 0);
	const wire: string[] = [];
	const change = gatedPromise<void>();
	const fence = gatedPromise<unknown>();
	vi.mocked(state.connection.sendNotification).mockImplementation(
		async (method: unknown) => {
			wire.push(String(method));
			if (method === "textDocument/didChange") await change.promise;
		},
	);
	const tokens: Harness["tokens"] = [];
	let publishRef: Publish | undefined;
	vi.mocked(state.connection.sendRequest).mockImplementation((async (
		method: unknown,
		_params: unknown,
		token?: { isCancellationRequested: boolean },
	) => {
		wire.push(String(method));
		if (method === "textDocument/documentSymbol") {
			tokens.push(token);
			if (options.onFence && publishRef) options.onFence(publishRef);
			return fence.promise;
		}
		return undefined;
	}) as never);
	setupIncomingHandlers(state, {});
	const calls = vi.mocked(state.connection.onNotification).mock
		.calls as unknown as Array<[string, Publish]>;
	const publish = calls.find(
		(call) => call[0] === "textDocument/publishDiagnostics",
	)?.[1] as Publish;
	publishRef = publish;
	return { state, publish, wire, change, fence, tokens };
}

/** The server has published for content 0, with or without a version. */
async function primed(h: Harness, versioned: boolean): Promise<void> {
	h.publish({
		uri: URI,
		diagnostics: [STALE],
		...(versioned ? { version: 0 } : {}),
	});
	await vi.advanceTimersByTimeAsync(QUIET_MS);
}

/**
 * The issue's replay: the touch's didChange is in flight when the server,
 * still on content 0, publishes for it; then the send lands, the quiet window
 * passes, and the touch waits.
 */
async function replay(
	h: Harness,
	options: { versionedStale: boolean; baseline: boolean },
): Promise<{ waitedMs: number; result: LSPDiagnostic[] | undefined }> {
	const baseline = diagnosticsVersionForPath(h.state, KEY);
	const touch = handleNotifyOpen(h.state, FILE, "content 1", "typescript");
	await vi.advanceTimersByTimeAsync(0);
	h.publish({
		uri: URI,
		diagnostics: [STALE],
		...(options.versionedStale ? { version: 0 } : {}),
	});
	h.change.resolve();
	await touch;
	await vi.advanceTimersByTimeAsync(QUIET_MS);
	const started = Date.now();
	const wait = clientWaitForDiagnostics(
		h.state,
		FILE,
		WAIT_MS,
		options.baseline ? { minVersion: baseline } : {},
	);
	await vi.advanceTimersByTimeAsync(WAIT_MS + 10);
	await wait;
	return {
		waitedMs: Date.now() - started,
		result: h.state.pushDiagnostics.get(KEY),
	};
}

describe("#3484 — diagnostics fence for version-less servers", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		logLatency.mockClear();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("does not settle a baseline wait on a version-less publish for the pre-touch content", async () => {
		const h = harness();
		await primed(h, false);

		const { waitedMs, result } = await replay(h, {
			versionedStale: false,
			baseline: true,
		});

		expect(result ?? []).not.toContainEqual(STALE);
		expect(waitedMs).toBeGreaterThanOrEqual(WAIT_MS);
	});

	it("does not settle a no-baseline (skipped touch) wait on it either", async () => {
		const h = harness();
		await primed(h, false);

		const { waitedMs, result } = await replay(h, {
			versionedStale: false,
			baseline: false,
		});

		expect(result ?? []).not.toContainEqual(STALE);
		expect(waitedMs).toBeGreaterThanOrEqual(WAIT_MS);
	});

	it("sends the fence in the same tick as the didChange, while the didChange is still in flight", async () => {
		const h = harness();
		await primed(h, false);

		const touch = handleNotifyOpen(h.state, FILE, "content 1", "typescript");
		await vi.advanceTimersByTimeAsync(0);

		expect(h.wire).toEqual([
			"textDocument/didChange",
			"textDocument/documentSymbol",
		]);
		h.change.resolve();
		await touch;
	});

	// Every branch that clears the path's diagnostics before a send arms the
	// fence at that first send, in the same tick.
	it.each([
		{
			branch: "the change path's didChange (updateFile)",
			open: true,
			serverId: "yaml",
			send: (s: LSPClientState) => handleNotifyChange(s, FILE, "content 1"),
			first: "textDocument/didChange",
		},
		{
			branch: "the change path's fallback didOpen",
			open: false,
			serverId: "yaml",
			send: (s: LSPClientState) => handleNotifyChange(s, FILE, "content 1"),
			first: "textDocument/didOpen",
		},
		{
			branch: "a first didOpen",
			open: false,
			serverId: "yaml",
			send: (s: LSPClientState) =>
				handleNotifyOpen(s, FILE, "content 1", "typescript", false, true),
			first: "textDocument/didOpen",
		},
	])("arms the fence at $branch", async ({ open, serverId, send, first }) => {
		const h = harness();
		(h.state as { serverId: string }).serverId = serverId;
		if (!open) {
			h.state.openDocuments.delete(KEY);
			h.state.documentVersions.delete(KEY);
		}
		await primed(h, false);
		h.change.resolve();

		await send(h.state);

		expect(h.wire.slice(0, 2)).toEqual([first, "textDocument/documentSymbol"]);
	});

	it("accepts a version-less publish for the new content once the fence is answered", async () => {
		const h = harness();
		await primed(h, false);
		await replay(h, { versionedStale: false, baseline: true });

		h.fence.resolve([]);
		await vi.advanceTimersByTimeAsync(0);
		h.publish({ uri: URI, diagnostics: [FRESH] });
		await vi.advanceTimersByTimeAsync(QUIET_MS);

		expect(h.state.pushDiagnostics.get(KEY)).toEqual([FRESH]);
		// The reply also settles the fence's bound: no timer is left behind.
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps a versioned publish that arrives while a fence is out", async () => {
		const h = harness();
		await primed(h, false);
		await replay(h, { versionedStale: false, baseline: true });

		h.publish({ uri: URI, diagnostics: [FRESH], version: 1 });
		await vi.advanceTimersByTimeAsync(QUIET_MS);

		expect(h.state.diagnosticFences.size).toBe(1);
		expect(h.state.pushDiagnostics.get(KEY)).toEqual([FRESH]);
	});

	it("lifts the fence on an error reply", async () => {
		const h = harness();
		await primed(h, false);
		await replay(h, { versionedStale: false, baseline: true });

		h.fence.reject(new Error("MethodNotFound"));
		await vi.advanceTimersByTimeAsync(0);
		h.publish({ uri: URI, diagnostics: [FRESH] });
		await vi.advanceTimersByTimeAsync(QUIET_MS);

		expect(h.state.pushDiagnostics.get(KEY)).toEqual([FRESH]);
	});

	it("lifts an unanswered fence at the diagnostics wait ceiling and records it", async () => {
		const h = harness();
		await primed(h, false);
		await replay(h, { versionedStale: false, baseline: true });

		await vi.advanceTimersByTimeAsync(10_000);
		h.publish({ uri: URI, diagnostics: [FRESH] });
		await vi.advanceTimersByTimeAsync(QUIET_MS);

		expect(h.state.pushDiagnostics.get(KEY)).toEqual([FRESH]);
		expect(h.state.diagnosticFences.size).toBe(0);
		const rows = logLatency.mock.calls
			.map(
				([entry]) =>
					entry as { phase?: string; metadata?: { outcome?: string } },
			)
			.filter((entry) => entry.phase === "lsp_diagnostics_fence");
		expect(rows.map((row) => row.metadata?.outcome)).toEqual(["timeout"]);
	});

	it("keeps a newer touch's fence when the older fence is answered", async () => {
		const h = harness();
		await primed(h, false);
		h.change.resolve();
		const second = gatedPromise<unknown>();
		let fences = 0;
		vi.mocked(h.state.connection.sendRequest).mockImplementation((async () =>
			++fences === 1 ? h.fence.promise : second.promise) as never);
		await handleNotifyOpen(h.state, FILE, "content 1", "typescript");
		await handleNotifyOpen(h.state, FILE, "content 2", "typescript");

		h.fence.resolve([]);
		await vi.advanceTimersByTimeAsync(0);
		h.publish({ uri: URI, diagnostics: [STALE] });
		await vi.advanceTimersByTimeAsync(QUIET_MS);

		expect(fences).toBe(2);
		expect(h.state.pushDiagnostics.get(KEY)).toBeUndefined();
	});

	it("sends no fence to an unmarked versioned server, whose own guards drop the stale publish", async () => {
		const h = harness({ serverId: "test-server" });
		await primed(h, true);

		const { result } = await replay(h, {
			versionedStale: true,
			baseline: true,
		});

		expect(h.wire).not.toContain("textDocument/documentSymbol");
		expect(result ?? []).not.toContainEqual(STALE);
	});

	// Round 1 F3: the marker is a measured server property, so a marked server
	// is fenced from its first touch; nothing is learned from its publishes.
	it("fences a measured reply-first server from its first touch", async () => {
		const h = harness();
		h.change.resolve();

		await handleNotifyOpen(h.state, FILE, "content 1", "typescript");

		expect(h.wire).toEqual([
			"textDocument/didChange",
			"textDocument/documentSymbol",
		]);
		// An answered fence that dropped nothing writes no row.
		h.fence.resolve([]);
		await vi.advanceTimersByTimeAsync(0);
		expect(h.state.diagnosticFences.size).toBe(0);
		expect(
			logLatency.mock.calls.filter(
				([entry]) =>
					(entry as { phase?: string }).phase === "lsp_diagnostics_fence",
			),
		).toEqual([]);
	});

	it("records a timed-out fence even when it dropped nothing", async () => {
		const h = harness();
		h.change.resolve();
		await handleNotifyOpen(h.state, FILE, "content 1", "typescript");

		await vi.advanceTimersByTimeAsync(10_000);

		const rows = logLatency.mock.calls
			.map(
				([entry]) =>
					entry as {
						phase?: string;
						metadata?: { outcome?: string; droppedPublishes?: number };
					},
			)
			.filter((entry) => entry.phase === "lsp_diagnostics_fence")
			.map((entry) => entry.metadata);
		expect(rows).toEqual([
			expect.objectContaining({ outcome: "timeout", droppedPublishes: 0 }),
		]);
	});

	// Round 1 F1: docker-langserver publishes the new content 2-3 ms after the
	// didChange, BEFORE it would answer a fence, and never republishes. Fencing
	// it dropped its only fresh answer; an unmarked server is not fenced.
	it("keeps a publish-first server's fresh answer (docker shape: unmarked, no fence)", async () => {
		const h = harness({
			serverId: "docker",
			onFence: (publish) => publish({ uri: URI, diagnostics: [FRESH] }),
		});
		await primed(h, false);
		const baseline = diagnosticsVersionForPath(h.state, KEY);
		const touch = handleNotifyOpen(h.state, FILE, "content 1", "typescript");
		await vi.advanceTimersByTimeAsync(0);
		h.publish({ uri: URI, diagnostics: [FRESH] });
		h.change.resolve();
		await touch;
		await vi.advanceTimersByTimeAsync(QUIET_MS);
		const wait = clientWaitForDiagnostics(h.state, FILE, WAIT_MS, {
			minVersion: baseline,
		});
		await vi.advanceTimersByTimeAsync(WAIT_MS + 10);
		await wait;

		expect(h.state.pushDiagnostics.get(KEY)).toEqual([FRESH]);
		expect(h.wire).not.toContain("textDocument/documentSymbol");
	});

	// Round 1 F2: a drop leaves a pushed record, so a fenced server whose fresh
	// answers were being dropped is visible in the log.
	it("records how many publishes the fence dropped when it is answered", async () => {
		const h = harness();
		await primed(h, false);
		await replay(h, { versionedStale: false, baseline: true });

		h.fence.resolve([]);
		await vi.advanceTimersByTimeAsync(0);

		const rows = logLatency.mock.calls
			.map(
				([entry]) =>
					entry as {
						phase?: string;
						metadata?: { outcome?: string; droppedPublishes?: number };
					},
			)
			.filter((entry) => entry.phase === "lsp_diagnostics_fence")
			.map((entry) => entry.metadata);
		expect(rows).toEqual([
			expect.objectContaining({ outcome: "reply", droppedPublishes: 1 }),
		]);
	});

	// #3310 x #3484: on the indexing-class server (php) a fence-dropped EMPTY
	// first publish spends the one-shot hold: it was skipped already, and
	// holding the next publish too would swallow the real answer. A dropped
	// NON-empty publish leaves the hold armed (a timeout, never a false clean).
	// A dropped empty publish that clears a cached or pending finding is not the
	// hold's first-publish shape either, so it leaves the hold armed too.
	it.each([
		{ shape: "an empty first publish", diagnostics: [], spent: true },
		{ shape: "a non-empty publish", diagnostics: [STALE], spent: false },
		{
			shape: "an empty publish over a cached push",
			diagnostics: [],
			spent: false,
			cached: true,
		},
		{
			shape: "an empty publish over a pending debounce",
			diagnostics: [],
			spent: false,
			pending: true,
		},
	])(
		"a fence-dropped $shape on the indexing server leaves the hold spent=$spent",
		async ({ diagnostics, spent, cached, pending }) => {
			const h = harness({ serverId: "php" });
			const touch = handleNotifyOpen(h.state, FILE, "content 1", "php");
			await vi.advanceTimersByTimeAsync(0);
			expect(h.state.diagnosticFences.size).toBe(1);
			if (cached) h.state.pushDiagnostics.set(KEY, [STALE]);
			const timer = setTimeout(() => {}, 60_000);
			if (pending) h.state.pendingDiagnostics.set(KEY, timer);

			h.publish({ uri: URI, diagnostics });

			expect(h.state.emptyFirstPublishHoldSpent).toBe(spent);
			// The spend is recorded, once, like a hold on the stored path.
			const held = logLatency.mock.calls
				.map(([entry]) => entry as { phase?: string; metadata?: unknown })
				.filter((entry) => entry.phase === "lsp_empty_first_publish_held");
			expect(held).toEqual(
				spent
					? [
							expect.objectContaining({
								metadata: expect.objectContaining({ via: "fence-drop" }),
							}),
						]
					: [],
			);
			clearTimeout(timer);
			h.state.pendingDiagnostics.delete(KEY);
			h.change.resolve();
			await touch;
		},
	);

	it("records a fence-drop spend at most once per client", async () => {
		const h = harness({ serverId: "php" });
		const touch = handleNotifyOpen(h.state, FILE, "content 1", "php");
		await vi.advanceTimersByTimeAsync(0);

		h.publish({ uri: URI, diagnostics: [] });
		h.publish({ uri: URI, diagnostics: [] });

		const held = logLatency.mock.calls.filter(
			([entry]) =>
				(entry as { phase?: string }).phase === "lsp_empty_first_publish_held",
		);
		expect(held).toHaveLength(1);
		h.change.resolve();
		await touch;
	});

	// #3482: a publish received but never stored still answers one send, so the
	// late-auxiliary backlog must count it; the fence drop is such a return.
	it("counts a publish the fence dropped toward the path's publications (#3482)", async () => {
		const h = harness();
		await primed(h, false);
		expect(publicationCountsForPath(h.state, KEY)).toEqual({
			sent: 1,
			published: 1,
		});

		await replay(h, { versionedStale: false, baseline: true });

		expect(publicationCountsForPath(h.state, KEY)).toEqual({
			sent: 2,
			published: 2,
		});
	});

	// Round 1 F4: a fence request is bookkeeping, not work the server is doing
	// for a caller, so it never holds the client busy (capacity and idle
	// eviction read isBusy), and an unanswered or superseded fence is cancelled.
	it("never marks the connection busy, and cancels a timed-out fence", async () => {
		const h = harness();
		await primed(h, false);
		await replay(h, { versionedStale: false, baseline: true });

		expect(isConnectionBusy(h.state.connection)).toBe(false);
		expect(h.tokens[0]?.isCancellationRequested).toBe(false);
		await vi.advanceTimersByTimeAsync(10_000);

		expect(h.tokens[0]?.isCancellationRequested).toBe(true);
		expect(isConnectionBusy(h.state.connection)).toBe(false);
	});

	it("cancels a fence a newer touch supersedes", async () => {
		const h = harness();
		h.change.resolve();
		await handleNotifyOpen(h.state, FILE, "content 1", "typescript");
		await handleNotifyOpen(h.state, FILE, "content 2", "typescript");

		expect(h.tokens.map((t) => t?.isCancellationRequested)).toEqual([
			true,
			false,
		]);
	});

	it("keeps today's behaviour, recorded once, when a marked server advertises no documentSymbol", async () => {
		const h = harness({ documentSymbol: false });
		await primed(h, false);

		const { result } = await replay(h, {
			versionedStale: false,
			baseline: true,
		});
		h.change.resolve();
		await handleNotifyOpen(h.state, FILE, "content 2", "typescript");

		expect(h.wire).not.toContain("textDocument/documentSymbol");
		// The documented limit this skip keeps: the stale publish settles.
		expect(result).toEqual([STALE]);
		const rows = logLatency.mock.calls
			.map(
				([entry]) =>
					entry as { phase?: string; metadata?: { outcome?: string } },
			)
			.filter((entry) => entry.phase === "lsp_diagnostics_fence");
		expect(rows.map((row) => row.metadata?.outcome)).toEqual(["no-request"]);
	});
});
