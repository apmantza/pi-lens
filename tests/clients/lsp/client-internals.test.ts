/**
 * LSP Client Internals Tests
 *
 * Tests clientWaitForDiagnostics, handleNotifyOpen, and handleNotifyChange
 * directly with mock LSPClientState to avoid spawning real language servers.
 */

import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { MessageConnection } from "vscode-jsonrpc";
import {
	applyDynamicCapabilities,
	CLIENT_CAPABILITIES,
	clientRequestWorkspaceDiagnostics,
	clientShutdown,
	clientWaitForDiagnostics,
	handleNotifyChange,
	navRequest,
	runServerCommand,
	stripDiagnosticNoiseLines,
	handleNotifyOpen,
	type LSPClientState,
} from "../../../clients/lsp/client.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { WatchedFilesQueue } from "../../../clients/lsp/watch-queue.js";

const TEST_FILE = "/project/app.ts";
const TEST_KEY = normalizeMapKey(TEST_FILE);

describe("CLIENT_CAPABILITIES (#278 regression)", () => {
	// PowerShell Editor Services (OmniSharp.Extensions.LanguageServer) NPEs during
	// `initialize` when textDocument sub-capabilities it dereferences are absent —
	// a partial object hangs the handshake. Keep the set COMPLETE so PSES (and any
	// OmniSharp-based server) initializes.
	it("advertises a complete, spec-compliant textDocument capability set", () => {
		const td = CLIENT_CAPABILITIES.textDocument as Record<string, unknown>;
		for (const key of [
			"synchronization",
			"completion",
			"hover",
			"signatureHelp",
			"definition",
			"typeDefinition",
			"implementation",
			"references",
			"documentSymbol",
			"codeAction",
			"rename",
			"publishDiagnostics",
		]) {
			expect(td[key], `textDocument.${key} present`).toBeTypeOf("object");
		}
		// The old NON-STANDARD shape that triggered the NPE must not return:
		// didOpen/didChange are not TextDocumentSyncClientCapabilities fields.
		const sync = td.synchronization as Record<string, unknown>;
		expect(sync).not.toHaveProperty("didOpen");
		expect(sync).not.toHaveProperty("didChange");
		// Version-aware diagnostics (#240/#276) must stay advertised.
		expect(
			(CLIENT_CAPABILITIES.textDocument.publishDiagnostics as { versionSupport?: boolean })
				.versionSupport,
		).toBe(true);
	});
});

function createMockConnection(): MessageConnection {
	return {
		sendNotification: vi.fn().mockResolvedValue(undefined),
		sendRequest: vi.fn().mockResolvedValue(undefined),
		onNotification: vi.fn(),
		onRequest: vi.fn().mockResolvedValue(undefined),
		onError: vi.fn(),
		onClose: vi.fn(),
		listen: vi.fn(),
		dispose: vi.fn(),
	} as unknown as MessageConnection;
}

function createMockLspProcess() {
	return {
		pid: 12345,
		process: { killed: false, kill: vi.fn() } as unknown as NodeJS.Process,
		stdin: {
			on: vi.fn(),
			off: vi.fn(),
			write: vi.fn(),
		} as unknown as NodeJS.WritableStream,
		stdout: {
			on: vi.fn(),
			off: vi.fn(),
			pipe: vi.fn(),
		} as unknown as NodeJS.ReadableStream,
		stderr: { on: vi.fn(), off: vi.fn() } as unknown as NodeJS.ReadableStream,
	};
}

function createMockState(overrides?: Partial<LSPClientState>): LSPClientState {
	const diagnosticEmitter = new EventEmitter();
	diagnosticEmitter.setMaxListeners(50);
	const state: LSPClientState = {
		isConnected: true,
		isDestroyed: false,
		connectionDisposed: false,
		lastError: undefined,
		connection: createMockConnection(),
		pushDiagnostics: new Map(),
		pushDiagnosticTimestamps: new Map(),
		documentPullDiagnostics: new Map(),
		documentPullDiagnosticTimestamps: new Map(),
		pendingDiagnostics: new Map(),
		diagnosticEmitter,
		diagnosticsVersion: 0,
		documentVersions: new Map(),
		diagnosticDocVersions: new Map(),
		openDocuments: new Set(),
		pendingOpens: new Set(),
		workspaceDiagnosticsSupport: {
			advertised: false,
			mode: "push-only",
			workspaceDiagnostics: false,
			diagnosticProviderKind: "none",
		},
		operationSupport: {
			definition: false,
			typeDefinition: false,
			declaration: false,
			references: false,
			hover: false,
			signatureHelp: false,
			documentSymbol: false,
			workspaceSymbol: false,
			codeAction: false,
			rename: false,
			implementation: false,
			callHierarchy: false,
		},
		staticDiagnosticsMode: "push-only",
		positionEncoding: "utf-16",
		dynamicRegistrations: new Map(),
		advertisedCommands: new Set(),
		serverEditsAllowed: 0,
		serverId: "test-server",
		root: "/project",
		lspProcess: createMockLspProcess() as any,
		watchQueue: undefined as unknown as WatchedFilesQueue,
		...overrides,
	};
	// #271: mirror production — the queue flushes a batched didChangeWatchedFiles
	// through the (mock) connection. Tests drive it via state.watchQueue.flush().
	if (!state.watchQueue) {
		state.watchQueue = new WatchedFilesQueue((changes) => {
			void state.connection.sendNotification(
				"workspace/didChangeWatchedFiles",
				{ changes },
			);
		});
	}
	return state;
}

describe("stripDiagnosticNoiseLines", () => {
	it("removes bare URL and further-information diagnostic lines", () => {
		expect(
			stripDiagnosticNoiseLines(
				"actual error\nfor further information visit https://example.test\nhttps://example.test/docs",
			),
		).toBe("actual error");
	});
});

describe("clientShutdown", () => {
	it("skips LSP protocol handshake in fast mode", async () => {
		const process = {
			killed: false,
			kill: vi.fn(() => true),
			unref: vi.fn(),
		};
		const state = createMockState({
			lspProcess: {
				...createMockLspProcess(),
				pid: 0,
				process,
			} as any,
		});

		await clientShutdown(state, { fast: true });

		expect(state.connection.sendRequest).not.toHaveBeenCalled();
		expect(state.connection.sendNotification).not.toHaveBeenCalled();
		expect(state.connection.dispose).toHaveBeenCalledTimes(1);
		expect(process.kill).toHaveBeenCalledWith("SIGTERM");
		expect(process.unref).toHaveBeenCalledTimes(1);
	});
});

describe("handleNotifyOpen", () => {
	it("sends didOpen on first open", async () => {
		const state = createMockState();
		await handleNotifyOpen(state, TEST_FILE, "const x = 1;", "typescript");

		const calls = vi.mocked(state.connection.sendNotification).mock.calls;
		const didOpenCall = calls.find((c) => c[0] === "textDocument/didOpen");
		expect(didOpenCall).toBeDefined();
		expect(state.openDocuments.has(TEST_KEY)).toBe(true);
	});

	it("suppresses didChangeWatchedFiles in silent open mode", async () => {
		const state = createMockState();
		await handleNotifyOpen(
			state,
			TEST_FILE,
			"const x = 1;",
			"typescript",
			false,
			true,
		);

		const calls = vi.mocked(state.connection.sendNotification).mock.calls;
		expect(calls.some((c) => c[0] === "workspace/didChangeWatchedFiles")).toBe(
			false,
		);
		expect(calls.some((c) => c[0] === "textDocument/didOpen")).toBe(true);
	});

	it("batches didChangeWatchedFiles via the watch queue in normal open mode (#271)", async () => {
		const state = createMockState();
		await handleNotifyOpen(state, TEST_FILE, "const x = 1;", "typescript");

		// #271: the notify is now enqueued, not sent inline — not yet on the wire.
		let calls = vi.mocked(state.connection.sendNotification).mock.calls;
		expect(calls.some((c) => c[0] === "workspace/didChangeWatchedFiles")).toBe(
			false,
		);
		expect(state.watchQueue.size).toBe(1);

		// flushing the debounce window emits a single batched notification.
		state.watchQueue.flush();
		calls = vi.mocked(state.connection.sendNotification).mock.calls;
		const watched = calls.find(
			(c) => c[0] === "workspace/didChangeWatchedFiles",
		);
		expect(watched).toBeDefined();
		expect((watched?.[1] as { changes: unknown[] }).changes).toHaveLength(1);
	});

	it("coalesces multiple file opens into ONE didChangeWatchedFiles (#271)", async () => {
		const state = createMockState();
		await handleNotifyOpen(state, TEST_FILE, "const x = 1;", "typescript");
		await handleNotifyOpen(
			state,
			`${TEST_FILE}.other.ts`,
			"const y = 2;",
			"typescript",
		);
		expect(state.watchQueue.size).toBe(2);

		state.watchQueue.flush();
		const watchedCalls = vi
			.mocked(state.connection.sendNotification)
			.mock.calls.filter((c) => c[0] === "workspace/didChangeWatchedFiles");
		// one notification for the whole burst, carrying both URIs
		expect(watchedCalls).toHaveLength(1);
		expect(
			(watchedCalls[0][1] as { changes: unknown[] }).changes,
		).toHaveLength(2);
	});

	it("sends didChange on re-open", async () => {
		const state = createMockState();
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);

		await handleNotifyOpen(state, TEST_FILE, "const y = 2;", "typescript");

		const calls = vi.mocked(state.connection.sendNotification).mock.calls;
		const didChangeCall = calls.find((c) => c[0] === "textDocument/didChange");
		expect(didChangeCall).toBeDefined();
		expect(state.documentVersions.get(TEST_KEY)).toBe(1);
	});

	it("does nothing when client is not alive", async () => {
		const state = createMockState({ isConnected: false });
		await handleNotifyOpen(state, TEST_FILE, "const x = 1;", "typescript");

		expect(state.connection.sendNotification).not.toHaveBeenCalled();
	});

	it("tracks pending opens until didOpen completes", async () => {
		const state = createMockState();
		expect(state.pendingOpens.has(TEST_KEY)).toBe(false);

		await handleNotifyOpen(state, TEST_FILE, "const x = 1;", "typescript");

		expect(state.pendingOpens.has(TEST_KEY)).toBe(false);
		expect(state.openDocuments.has(TEST_KEY)).toBe(true);
	});

	it("clears diagnostics on open", async () => {
		const state = createMockState();
		state.pushDiagnostics.set(TEST_KEY, [
			{
				severity: 1,
				message: "old",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 0 },
				},
			},
		]);

		await handleNotifyOpen(state, TEST_FILE, "const x = 1;", "typescript");

		expect(state.pushDiagnostics.has(TEST_KEY)).toBe(false);
	});
});

describe("handleNotifyChange", () => {
	it("sends didChange when document is open", async () => {
		const state = createMockState();
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);

		await handleNotifyChange(state, TEST_FILE, "const y = 2;");

		const calls = vi.mocked(state.connection.sendNotification).mock.calls;
		const didChangeCall = calls.find((c) => c[0] === "textDocument/didChange");
		expect(didChangeCall).toBeDefined();
		expect(state.documentVersions.get(TEST_KEY)).toBe(1);
	});

	it("falls back to didOpen when document not yet open", async () => {
		const state = createMockState();

		await handleNotifyChange(state, TEST_FILE, "const y = 2;");

		const calls = vi.mocked(state.connection.sendNotification).mock.calls;
		const didOpenCall = calls.find((c) => c[0] === "textDocument/didOpen");
		expect(didOpenCall).toBeDefined();
		expect(state.openDocuments.has(TEST_KEY)).toBe(true);
	});

	it("clears stale diagnostics before sending change", async () => {
		const state = createMockState();
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);
		state.pushDiagnostics.set(TEST_KEY, [
			{
				severity: 1,
				message: "old push",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 0 },
				},
			},
		]);
		state.documentPullDiagnostics.set(TEST_KEY, [
			{
				severity: 1,
				message: "old pull",
				range: {
					start: { line: 0, character: 1 },
					end: { line: 0, character: 1 },
				},
			},
		]);

		await handleNotifyChange(state, TEST_FILE, "const y = 2;");

		expect(state.pushDiagnostics.has(TEST_KEY)).toBe(false);
		expect(state.documentPullDiagnostics.has(TEST_KEY)).toBe(false);
	});

	it("does nothing when client is not alive", async () => {
		const state = createMockState({ isConnected: false });
		await handleNotifyChange(state, TEST_FILE, "const y = 2;");

		expect(state.connection.sendNotification).not.toHaveBeenCalled();
	});
});

describe("clientWaitForDiagnostics", () => {
	it("resolves immediately if diagnostics already cached", async () => {
		const state = createMockState();
		state.diagnosticsVersion = 1;
		state.pushDiagnostics.set(TEST_KEY, [
			{
				severity: 1,
				message: "error",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 0 },
				},
			},
		]);

		await clientWaitForDiagnostics(state, TEST_FILE, 1000);
		// Should resolve immediately without waiting
	});

	it("does not accept cached diagnostics at or below minVersion", async () => {
		const state = createMockState();
		state.diagnosticsVersion = 1;
		state.pushDiagnostics.set(TEST_KEY, [
			{
				severity: 1,
				message: "stale error",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 0 },
				},
			},
		]);

		const start = Date.now();
		await clientWaitForDiagnostics(state, TEST_FILE, 50, { minVersion: 1 });
		const elapsed = Date.now() - start;

		expect(elapsed).toBeGreaterThanOrEqual(40);
	});

	it("resolves when diagnostics advance past minVersion", async () => {
		const state = createMockState();
		state.diagnosticsVersion = 1;

		const waitPromise = clientWaitForDiagnostics(state, TEST_FILE, 5000, {
			minVersion: 1,
		});

		setTimeout(() => {
			state.diagnosticsVersion = 2;
			state.diagnosticEmitter.emit("diagnostics", TEST_FILE);
		}, 50);

		await waitPromise;
	});

	it("resolves when diagnostics arrive via emitter", async () => {
		const state = createMockState();

		const waitPromise = clientWaitForDiagnostics(state, TEST_FILE, 5000);

		// Simulate diagnostics arriving after a short delay
		setTimeout(() => {
			state.diagnosticEmitter.emit("diagnostics", TEST_FILE);
		}, 50);

		await waitPromise;
	});

	it("resolves after timeout if no diagnostics arrive", async () => {
		const state = createMockState();

		const start = Date.now();
		await clientWaitForDiagnostics(state, TEST_FILE, 100);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeGreaterThanOrEqual(90);
	});

	it("ignores diagnostics for other files", async () => {
		const state = createMockState();

		const waitPromise = clientWaitForDiagnostics(state, TEST_FILE, 5000);

		// Emit diagnostics for a different file
		setTimeout(() => {
			state.diagnosticEmitter.emit("diagnostics", "/project/other.ts");
		}, 50);

		// Emit for the right file after a bit longer
		setTimeout(() => {
			state.diagnosticEmitter.emit("diagnostics", TEST_FILE);
		}, 100);

		await waitPromise;
	});
});

describe("clientWaitForDiagnostics — pull mode (#240)", () => {
	// serverId "typescript" → pullRetryBudgetMs 0, so no incremental retry loop;
	// the first pull outcome is decisive. mode "pull" routes through the pull
	// branch. diagnosticProviderKind "object" = an advertised pull provider.
	const pullState = (): LSPClientState =>
		createMockState({
			serverId: "typescript",
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: false,
				diagnosticProviderKind: "object",
			},
		});

	it("resolves immediately on an authoritative empty (clean) pull report", async () => {
		const state = pullState();
		state.connection.sendRequest = vi
			.fn()
			.mockResolvedValue({ kind: "full", items: [] });

		const start = Date.now();
		await clientWaitForDiagnostics(state, TEST_FILE, 1000);
		expect(Date.now() - start).toBeLessThan(80);
	});

	it("resolves immediately when the pull returns diagnostics (found)", async () => {
		const state = pullState();
		state.connection.sendRequest = vi.fn().mockResolvedValue({
			kind: "full",
			items: [
				{
					severity: 1,
					message: "boom",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 0 },
					},
				},
			],
		});

		const start = Date.now();
		await clientWaitForDiagnostics(state, TEST_FILE, 1000);
		expect(Date.now() - start).toBeLessThan(80);
	});

	it("does NOT treat a failed/unavailable pull as clean — waits the budget rather than short-circuiting", async () => {
		const state = pullState();
		// undefined reply → safeSendRequest returns undefined → outcome
		// "unavailable". With no minVersion baseline the OLD code returned
		// immediately via `|| hasFreshDiagnostics()` (a false clean); the fix must
		// instead fall through to the push-wait/timeout backstop.
		state.connection.sendRequest = vi.fn().mockResolvedValue(undefined);

		const start = Date.now();
		await clientWaitForDiagnostics(state, TEST_FILE, 120);
		expect(Date.now() - start).toBeGreaterThanOrEqual(100);
	});

	it("bounds a hung pull request instead of hanging forever", async () => {
		const state = pullState();
		// A pull-mode server that accepts textDocument/diagnostic but NEVER
		// replies (stream stays alive). safeSendRequest only settles on a reply or
		// a destroyed stream, so pre-fix this await never resolves and hangs the
		// whole diagnostics wait (→ pipeline → flush → lens_diagnostics). The
		// per-request withTimeout must bound it: time out → unavailable → fall
		// through to the push backstop and resolve within the caller's budget.
		state.connection.sendRequest = vi.fn(() => new Promise<never>(() => {}));

		const start = Date.now();
		await clientWaitForDiagnostics(state, TEST_FILE, 120);
		const elapsed = Date.now() - start;
		// Went through the timeout→backstop path (not a false early clean)...
		expect(elapsed).toBeGreaterThanOrEqual(100);
		// ...and did NOT hang on the never-resolving request.
		expect(elapsed).toBeLessThan(2000);
	});
});

describe("navRequest — per-request timeout ceiling (#365)", () => {
	// workspaceSymbol and codeAction now route through navRequest, so its
	// withTimeout ceiling is what stops a hung server (a request the server
	// accepts but never replies to — safeSendRequest only settles on a reply or
	// a destroyed stream) from hanging those tools forever.
	const TEST_FILE = "/proj/file.ts";

	it.each(["workspace/symbol", "textDocument/codeAction"])(
		"bounds a hung %s request instead of hanging forever",
		async (method) => {
			const state = createMockState();
			state.connection.sendRequest = vi.fn(() => new Promise<never>(() => {}));

			const start = Date.now();
			const result = await navRequest(state, method, {}, undefined, 120);
			const elapsed = Date.now() - start;

			expect(result).toBeUndefined();
			// Went through the timeout, not an instant error return...
			expect(elapsed).toBeGreaterThanOrEqual(100);
			// ...and did not hang on the never-resolving request.
			expect(elapsed).toBeLessThan(2000);
		},
	);

	it("returns the server result unchanged on a normal reply", async () => {
		const state = createMockState();
		const payload = [{ name: "sym", kind: 12 }];
		state.connection.sendRequest = vi.fn().mockResolvedValue(payload);

		const result = await navRequest(state, "workspace/symbol", {}, undefined, 120);
		expect(result).toEqual(payload);
	});

	it("drops a single-file result when the document version advances mid-request", async () => {
		const state = createMockState();
		const key = normalizeMapKey(TEST_FILE);
		state.documentVersions.set(key, 1);
		// An edit lands while the request is in flight → the reply is stale.
		state.connection.sendRequest = vi.fn(async () => {
			state.documentVersions.set(key, 2);
			return [{ title: "stale action" }];
		});

		const result = await navRequest(
			state,
			"textDocument/codeAction",
			{},
			TEST_FILE,
			120,
		);
		expect(result).toBeUndefined();
	});
});

describe("navRequest — $/cancelRequest on abort (#238 Item 1)", () => {
	it("does not send at all when the signal is already aborted", async () => {
		const state = createMockState();
		state.connection.sendRequest = vi.fn().mockResolvedValue([{ name: "x" }]);
		const controller = new AbortController();
		controller.abort();

		const result = await navRequest(
			state,
			"textDocument/definition",
			{},
			undefined,
			120,
			controller.signal,
		);

		expect(result).toBeUndefined();
		expect(state.connection.sendRequest).not.toHaveBeenCalled();
	});

	it("passes a CancellationToken when a signal is provided, none otherwise", async () => {
		const state = createMockState();
		state.connection.sendRequest = vi.fn().mockResolvedValue([]);

		await navRequest(state, "workspace/symbol", {}, undefined, 120);
		// No ambient signal in tests → third arg (token) is undefined.
		expect(vi.mocked(state.connection.sendRequest).mock.calls[0]?.[2]).toBeUndefined();

		await navRequest(
			state,
			"workspace/symbol",
			{},
			undefined,
			120,
			new AbortController().signal,
		);
		// Signal provided → a real CancellationToken is threaded to the server.
		const token = vi.mocked(state.connection.sendRequest).mock.calls[1]?.[2] as {
			onCancellationRequested?: unknown;
		};
		expect(token?.onCancellationRequested).toBeTypeOf("function");
	});

	it("cancels an in-flight request when the turn is abandoned mid-request", async () => {
		const state = createMockState();
		// Mock a server that only settles when its request token is cancelled —
		// exactly what vscode-jsonrpc does after emitting `$/cancelRequest`.
		state.connection.sendRequest = vi.fn(
			(_method: unknown, _params: unknown, token: any) =>
				new Promise((_resolve, reject) => {
					token?.onCancellationRequested(() => {
						const err = new Error("Request cancelled") as Error & {
							code: number;
						};
						err.code = -32800; // RequestCancelled
						reject(err);
					});
				}),
		) as unknown as typeof state.connection.sendRequest;

		const controller = new AbortController();
		const pending = navRequest(
			state,
			"textDocument/references",
			{},
			undefined,
			5000,
			controller.signal,
		);
		// Abort after the request is in flight → token cancels → server rejects.
		await new Promise((r) => setTimeout(r, 0));
		controller.abort();

		expect(await pending).toBeUndefined();
		expect(state.connection.sendRequest).toHaveBeenCalledTimes(1);
	});
});

describe("navRequest — ContentModified retry (#238 Item 2)", () => {
	const modified = (): Error => {
		const err = new Error("content modified") as Error & { code: number };
		err.code = -32801;
		return err;
	};

	it("retries once on ContentModified and returns the retried result", async () => {
		const state = createMockState();
		let calls = 0;
		state.connection.sendRequest = vi.fn(async () => {
			calls += 1;
			if (calls === 1) throw modified();
			return [{ name: "fresh" }];
		}) as unknown as typeof state.connection.sendRequest;

		const result = await navRequest(
			state,
			"textDocument/definition",
			{},
			undefined,
			500,
		);

		expect(result).toEqual([{ name: "fresh" }]);
		expect(state.connection.sendRequest).toHaveBeenCalledTimes(2);
	});

	it("returns empty (not a throw) when ContentModified persists after the retry", async () => {
		const state = createMockState();
		state.connection.sendRequest = vi.fn(async () => {
			throw modified();
		}) as unknown as typeof state.connection.sendRequest;

		const result = await navRequest(
			state,
			"textDocument/definition",
			{},
			undefined,
			500,
		);

		expect(result).toBeUndefined();
		// One retry only — not an unbounded loop.
		expect(state.connection.sendRequest).toHaveBeenCalledTimes(2);
	});

	it("does not retry a permanent RequestFailed (-32803)", async () => {
		const state = createMockState();
		state.connection.sendRequest = vi.fn(async () => {
			const err = new Error("request failed") as Error & { code: number };
			err.code = -32803;
			throw err;
		}) as unknown as typeof state.connection.sendRequest;

		await expect(
			navRequest(state, "textDocument/definition", {}, undefined, 500),
		).rejects.toThrow();
		expect(state.connection.sendRequest).toHaveBeenCalledTimes(1);
	});

	it("does not retry when the signal aborts between attempts", async () => {
		const state = createMockState();
		const controller = new AbortController();
		state.connection.sendRequest = vi.fn(async () => {
			controller.abort(); // turn abandoned exactly as the first attempt fails
			throw modified();
		}) as unknown as typeof state.connection.sendRequest;

		const result = await navRequest(
			state,
			"textDocument/definition",
			{},
			undefined,
			500,
			controller.signal,
		);

		expect(result).toBeUndefined();
		// Aborted → no second attempt.
		expect(state.connection.sendRequest).toHaveBeenCalledTimes(1);
	});
});

describe("runServerCommand — executeCommand timeout backstop (#365)", () => {
	const advertised = (): LSPClientState => {
		const state = createMockState();
		state.advertisedCommands.add("test.command");
		return state;
	};

	it("bounds a hung command with the generous backstop and surfaces it honestly", async () => {
		const state = advertised();
		state.connection.sendRequest = vi.fn(() => new Promise<never>(() => {}));

		const start = Date.now();
		const outcome = await runServerCommand(state, "test.command", [], 120);
		const elapsed = Date.now() - start;

		expect(outcome.executed).toBe(false);
		expect(outcome.reason).toMatch(/timed out.*may still be applying/i);
		expect(elapsed).toBeGreaterThanOrEqual(100);
		expect(elapsed).toBeLessThan(2000);
		// The serverEditsAllowed window must close even on timeout.
		expect(state.serverEditsAllowed).toBe(0);
	});

	it("returns the command result on a normal reply", async () => {
		const state = advertised();
		state.connection.sendRequest = vi.fn().mockResolvedValue({ applied: true });

		const outcome = await runServerCommand(state, "test.command", [], 120);
		expect(outcome).toEqual({ executed: true, result: { applied: true } });
		expect(state.serverEditsAllowed).toBe(0);
	});

	it("refuses a command the server never advertised (hardening preserved)", async () => {
		const state = createMockState(); // advertisedCommands empty
		state.connection.sendRequest = vi.fn().mockResolvedValue({ applied: true });

		const outcome = await runServerCommand(state, "evil.command", [], 120);
		expect(outcome.executed).toBe(false);
		expect(outcome.reason).toMatch(/not advertised/i);
		// Never sent, and the edit window never opened.
		expect(state.connection.sendRequest).not.toHaveBeenCalled();
		expect(state.serverEditsAllowed).toBe(0);
	});
});

describe("applyDynamicCapabilities", () => {
	it("upgrades to pull mode when textDocument/diagnostic is registered", () => {
		const state = createMockState();
		state.dynamicRegistrations.set("diag-1", "textDocument/diagnostic");

		applyDynamicCapabilities(state);

		expect(state.workspaceDiagnosticsSupport.mode).toBe("pull");
		expect(state.workspaceDiagnosticsSupport.advertised).toBe(true);
		expect(state.workspaceDiagnosticsSupport.diagnosticProviderKind).toBe(
			"dynamic",
		);
	});

	it("upgrades to pull mode when workspace/diagnostic is registered", () => {
		const state = createMockState();
		state.dynamicRegistrations.set("ws-diag-1", "workspace/diagnostic");

		applyDynamicCapabilities(state);

		expect(state.workspaceDiagnosticsSupport.mode).toBe("pull");
	});

	it("reverts to push-only when dynamic pull registration is removed", () => {
		const state = createMockState();
		state.dynamicRegistrations.set("diag-1", "textDocument/diagnostic");
		applyDynamicCapabilities(state);
		expect(state.workspaceDiagnosticsSupport.mode).toBe("pull");

		state.dynamicRegistrations.delete("diag-1");
		applyDynamicCapabilities(state);

		expect(state.workspaceDiagnosticsSupport.mode).toBe("push-only");
		expect(state.workspaceDiagnosticsSupport.advertised).toBe(false);
	});

	it("does not revert pull mode when statically advertised", () => {
		const state = createMockState({
			staticDiagnosticsMode: "pull",
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: false,
				diagnosticProviderKind: "object",
			},
		});
		// Even with no dynamic registrations, static pull should remain
		applyDynamicCapabilities(state);

		expect(state.workspaceDiagnosticsSupport.mode).toBe("pull");
		expect(state.workspaceDiagnosticsSupport.diagnosticProviderKind).toBe(
			"object",
		);
	});

	it("upgrades operation capabilities when methods are registered", () => {
		const state = createMockState();
		state.dynamicRegistrations.set("def-1", "textDocument/definition");
		state.dynamicRegistrations.set("ref-1", "textDocument/references");
		state.dynamicRegistrations.set("hover-1", "textDocument/hover");

		applyDynamicCapabilities(state);

		expect(state.operationSupport.definition).toBe(true);
		expect(state.operationSupport.references).toBe(true);
		expect(state.operationSupport.hover).toBe(true);
		expect(state.operationSupport.rename).toBe(false); // not registered
	});

	it("does not downgrade already-true operation capabilities on unregister", () => {
		const state = createMockState({
			operationSupport: {
				definition: true,
				typeDefinition: false,
				declaration: false,
				references: false,
				hover: false,
				signatureHelp: false,
				documentSymbol: false,
				workspaceSymbol: false,
				codeAction: false,
				rename: false,
				implementation: false,
				callHierarchy: false,
			},
		});
		// No dynamic registrations — definition was statically true
		applyDynamicCapabilities(state);

		expect(state.operationSupport.definition).toBe(true);
	});

	it("ignores unknown registration methods without throwing", () => {
		const state = createMockState();
		state.dynamicRegistrations.set("unknown-1", "some/unknownMethod");

		expect(() => applyDynamicCapabilities(state)).not.toThrow();
		expect(state.workspaceDiagnosticsSupport.mode).toBe("push-only");
	});
});

describe("clientRequestWorkspaceDiagnostics — real report parsing", () => {
	function reportItem(absPath: string, kind: string, diags: unknown[] = []) {
		return { uri: pathToFileURL(absPath).href, version: 1, kind, items: diags };
	}
	function diag(message: string) {
		return {
			severity: 1,
			message,
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 3 },
			},
		};
	}

	it("parses a WorkspaceDiagnosticReport into per-file diagnostics", async () => {
		const state = createMockState({
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: true,
				diagnosticProviderKind: "object",
			},
		});
		vi.mocked(state.connection.sendRequest).mockResolvedValue({
			items: [
				reportItem("/project/a.ts", "full", [diag("boom"), diag("bang")]),
				reportItem("/project/b.ts", "full", []),
				// "unchanged" carries no items — must be skipped, not returned empty.
				reportItem("/project/c.ts", "unchanged"),
			],
		});

		const out = await clientRequestWorkspaceDiagnostics(state, 1000);

		expect(state.connection.sendRequest).toHaveBeenCalledWith(
			"workspace/diagnostic",
			{ previousResultIds: [] },
		);
		expect(out).toBeDefined();
		const byName = (name: string) =>
			out?.find((r) => r.filePath.split("\\").join("/").endsWith(name));
		expect(byName("a.ts")?.diagnostics).toHaveLength(2);
		expect(byName("b.ts")?.diagnostics).toHaveLength(0);
		expect(byName("c.ts")).toBeUndefined(); // unchanged → skipped
	});

	it("returns undefined without sending when the server doesn't advertise workspace pull", async () => {
		const state = createMockState(); // workspaceDiagnostics: false by default
		const out = await clientRequestWorkspaceDiagnostics(state, 1000);
		expect(out).toBeUndefined();
		expect(state.connection.sendRequest).not.toHaveBeenCalled();
	});

	it("returns undefined on a malformed report (no items array)", async () => {
		const state = createMockState({
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: true,
				diagnosticProviderKind: "object",
			},
		});
		vi.mocked(state.connection.sendRequest).mockResolvedValue({ nope: true });
		expect(await clientRequestWorkspaceDiagnostics(state, 1000)).toBeUndefined();
	});

	it("returns undefined when the request throws or yields nothing (dead/timeout)", async () => {
		const state = createMockState({
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: true,
				diagnosticProviderKind: "object",
			},
		});
		vi.mocked(state.connection.sendRequest).mockRejectedValue(new Error("dead"));
		expect(await clientRequestWorkspaceDiagnostics(state, 1000)).toBeUndefined();
	});
});
