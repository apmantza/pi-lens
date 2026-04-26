/**
 * LSP Client Internals Tests
 *
 * Tests clientWaitForDiagnostics, handleNotifyOpen, and handleNotifyChange
 * directly with mock LSPClientState to avoid spawning real language servers.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { MessageConnection } from "vscode-jsonrpc";
import {
	applyDynamicCapabilities,
	clientWaitForDiagnostics,
	handleNotifyChange,
	handleNotifyOpen,
	type LSPClientState,
} from "../../../clients/lsp/client.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";

const TEST_FILE = "/project/app.ts";
const TEST_KEY = normalizeMapKey(TEST_FILE);

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
	return {
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
		documentVersions: new Map(),
		openDocuments: new Set(),
		pendingOpens: new Set(),
		workspaceDiagnosticsSupport: {
			advertised: false,
			mode: "push-only",
			diagnosticProviderKind: "none",
		},
		operationSupport: {
			definition: false,
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
		dynamicRegistrations: new Map(),
		serverId: "test-server",
		root: "/project",
		lspProcess: createMockLspProcess() as any,
		...overrides,
	};
}

describe("handleNotifyOpen", () => {
	it("sends didOpen on first open", async () => {
		const state = createMockState();
		await handleNotifyOpen(state, TEST_FILE, "const x = 1;", "typescript");

		const calls = vi.mocked(state.connection.sendNotification).mock.calls;
		const didOpenCall = calls.find((c) => c[0] === "textDocument/didOpen");
		expect(didOpenCall).toBeDefined();
		expect(state.openDocuments.has(TEST_KEY)).toBe(true);
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
