/**
 * Shared connection-double fixtures for LSP client-internals tests.
 *
 * These build an `LSPClientState` whose `connection` is a plain mock object —
 * NOT a wire-protocol server. Tests drive the client by replacing
 * `state.connection.sendRequest` / reading `sendNotification` calls. Extracted
 * from `client-internals.test.ts` (#1667) so a second test file can reuse the
 * same state shape instead of maintaining a parallel copy that drifts every
 * time `LSPClientState` gains a field.
 */

import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type { MessageConnection } from "vscode-jsonrpc";
import type { LSPClientState } from "../../../clients/lsp/client.js";
import { TEXT_DOCUMENT_SYNC_KIND_FULL } from "../../../clients/lsp/sync-kind.js";
import { WatchedFilesQueue } from "../../../clients/lsp/watch-queue.js";

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

export function createMockLspProcess() {
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

export function createMockState(
	overrides?: Partial<LSPClientState>,
): LSPClientState {
	const diagnosticEmitter = new EventEmitter();
	diagnosticEmitter.setMaxListeners(50);
	const state: LSPClientState = {
		isConnected: true,
		isDestroyed: false,
		shutdownRequested: false,
		shutdownPromise: undefined,
		shutdownOptions: undefined,
		exitedAt: undefined,
		connectionDisposed: false,
		lastError: undefined,
		connection: createMockConnection(),
		pushDiagnostics: new Map(),
		pushDiagnosticTimestamps: new Map(),
		documentPullDiagnostics: new Map(),
		documentPullDiagnosticVersions: new Map(),
		documentPullDiagnosticTimestamps: new Map(),
		pullFailureHistory: [],
		pendingDiagnostics: new Map(),
		diagnosticPublicationCounts: new Map(),
		documentOpenedAt: new Map(),
		diagnosticEmitter,
		diagnosticsVersion: 0,
		diagnosticsVersionsByPath: new Map(),
		documentVersions: new Map(),
		notifyChangeQueues: new Map(),
		diagnosticDocVersions: new Map(),
		documentContentHashes: new Map(),
		incrementalTextRetainedEntries: 0,
		incrementalTextRetainedBytes: 0,
		diagnosticBindings: new Map(),
		pullResultIds: new Map(),
		workspacePullResultCache: new Map(),
		openDocuments: new Set(),
		closedDocuments: new Set(),
		// #1669 review F8: REQUIRED, not left to the `?.`-optional default —
		// both are `optional` on `LSPClientState`, and a factory that omits
		// them makes every test exercise the `?.`-fallback branch (e.g.
		// `state.openDocumentUris?.get(...) ?? pathToFileURL(...)`) instead of
		// the real optional-field-present path every live client actually
		// runs under.
		openDocumentUris: new Map(),
		pendingOpens: new Set(),
		projectIdentityProbedFiles: new Set(),
		// #1669: mirrors `createLSPClient`'s own initial state literal, which
		// sets this explicitly rather than leaving it undefined — a test that
		// needs a non-Full kind still overrides it per call.
		syncKind: TEXT_DOCUMENT_SYNC_KIND_FULL,
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
			codeActionResolve: false,
			rename: false,
			willRenameFiles: false,
			didRenameFiles: false,
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
		// biome-ignore lint/suspicious/noExplicitAny: mock process shape
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
