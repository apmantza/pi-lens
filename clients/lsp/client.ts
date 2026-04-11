/**
 * LSP Client for pi-lens
 *
 * Handles JSON-RPC communication with language servers:
 * - Initialize/shutdown lifecycle
 * - Document synchronization (didOpen, didChange)
 * - Diagnostics with debouncing
 * - Request/response handling
 */

import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import type { MessageConnection } from "vscode-jsonrpc";
import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node.js";

import type { LSPProcess } from "./launch.js";
import { normalizeMapKey, uriToPath } from "./path-utils.js";

// --- Types ---

export interface LSPDiagnostic {
	severity: 1 | 2 | 3 | 4; // Error, Warning, Info, Hint
	message: string;
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
	code?: string | number;
	source?: string;
}

export interface LSPLocation {
	uri: string;
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
}

export interface LSPHover {
	contents:
		| string
		| { kind: string; value: string }
		| Array<string | { language: string; value: string }>;
	range?: LSPLocation["range"];
}

export interface LSPSignatureHelp {
	signatures: Array<{
		label: string;
		documentation?: string | { kind: string; value: string };
		parameters?: Array<{
			label: string | [number, number];
			documentation?: string | { kind: string; value: string };
		}>;
	}>;
	activeSignature?: number;
	activeParameter?: number;
}

export interface LSPCodeAction {
	title: string;
	kind?: string;
	diagnostics?: LSPDiagnostic[];
	edit?: unknown;
	command?: unknown;
	data?: unknown;
}

export interface LSPWorkspaceEdit {
	changes?: Record<string, unknown[]>;
	documentChanges?: unknown[];
	changeAnnotations?: Record<string, unknown>;
}

export interface LSPWorkspaceDiagnosticsSupport {
	advertised: boolean;
	mode: "pull" | "push-only";
	diagnosticProviderKind: string;
}

export interface LSPOperationSupport {
	definition: boolean;
	references: boolean;
	hover: boolean;
	signatureHelp: boolean;
	documentSymbol: boolean;
	workspaceSymbol: boolean;
	codeAction: boolean;
	rename: boolean;
	implementation: boolean;
	callHierarchy: boolean;
}

export interface LSPSymbol {
	name: string;
	kind: number;
	location?: LSPLocation;
	range?: LSPLocation["range"];
	selectionRange?: LSPLocation["range"];
	detail?: string;
	children?: LSPSymbol[];
}

// --- Call Hierarchy Types ---

export interface LSPCallHierarchyItem {
	name: string;
	kind: number;
	uri: string;
	range: LSPLocation["range"];
	selectionRange: LSPLocation["range"];
}

export interface LSPCallHierarchyIncomingCall {
	from: LSPCallHierarchyItem;
	fromRanges: LSPLocation["range"][];
}

export interface LSPCallHierarchyOutgoingCall {
	to: LSPCallHierarchyItem;
	fromRanges: LSPLocation["range"][];
}

export interface LSPClientInfo {
	serverId: string;
	root: string;
	connection: MessageConnection;
	/** Check if the connection is still alive */
	isAlive: () => boolean;
	notify: {
		open(filePath: string, content: string, languageId: string): Promise<void>;
		change(filePath: string, content: string): Promise<void>;
	};
	getDiagnostics(filePath: string): LSPDiagnostic[];
	waitForDiagnostics(filePath: string, timeoutMs?: number): Promise<void>;
	/** Get all tracked diagnostics (for cascade checking) */
	getAllDiagnostics(): Map<string, LSPDiagnostic[]>;
	/** Capability snapshot for workspace diagnostics support */
	getWorkspaceDiagnosticsSupport(): LSPWorkspaceDiagnosticsSupport;
	/** Capability snapshot for navigation/edit operations */
	getOperationSupport(): LSPOperationSupport;
	/** Go to definition — returns Location[] */
	definition(
		filePath: string,
		line: number,
		character: number,
	): Promise<LSPLocation[]>;
	/** Find all references */
	references(
		filePath: string,
		line: number,
		character: number,
		includeDeclaration?: boolean,
	): Promise<LSPLocation[]>;
	/** Hover info at position */
	hover(
		filePath: string,
		line: number,
		character: number,
	): Promise<LSPHover | null>;
	/** Signature help at position */
	signatureHelp(
		filePath: string,
		line: number,
		character: number,
	): Promise<LSPSignatureHelp | null>;
	/** Symbols in a document */
	documentSymbol(filePath: string): Promise<LSPSymbol[]>;
	/** Workspace-wide symbol search */
	workspaceSymbol(query: string): Promise<LSPSymbol[]>;
	/** Available code actions at a range */
	codeAction(
		filePath: string,
		line: number,
		character: number,
		endLine: number,
		endCharacter: number,
	): Promise<LSPCodeAction[]>;
	/** Rename symbol at position */
	rename(
		filePath: string,
		line: number,
		character: number,
		newName: string,
	): Promise<LSPWorkspaceEdit | null>;
	/** Go to implementation */
	implementation(
		filePath: string,
		line: number,
		character: number,
	): Promise<LSPLocation[]>;
	/** Prepare call hierarchy at position */
	prepareCallHierarchy(
		filePath: string,
		line: number,
		character: number,
	): Promise<LSPCallHierarchyItem[]>;
	/** Find incoming calls (callers) */
	incomingCalls(
		item: LSPCallHierarchyItem,
	): Promise<LSPCallHierarchyIncomingCall[]>;
	/** Find outgoing calls (callees) */
	outgoingCalls(
		item: LSPCallHierarchyItem,
	): Promise<LSPCallHierarchyOutgoingCall[]>;
	shutdown(): Promise<void>;
}

// --- Constants ---

const DIAGNOSTICS_DEBOUNCE_MS = positiveIntFromEnv(
	"PI_LENS_LSP_DIAGNOSTICS_DEBOUNCE_MS",
	150,
); // ms — waits for follow-up semantic diagnostics
const INITIALIZE_TIMEOUT_MS = positiveIntFromEnv(
	"PI_LENS_LSP_INIT_TIMEOUT_MS",
	15_000,
); // 15s — npx downloads are handled by ensureTool, not here
const DIAGNOSTICS_WAIT_TIMEOUT_MS = positiveIntFromEnv(
	"PI_LENS_LSP_DIAGNOSTICS_WAIT_MS",
	10_000,
);
const PULL_DIAGNOSTICS_RETRY_BUDGET_MS = positiveIntFromEnv(
	"PI_LENS_LSP_PULL_RETRY_BUDGET_MS",
	1200,
);
const PULL_DIAGNOSTICS_RETRY_INTERVAL_MS = positiveIntFromEnv(
	"PI_LENS_LSP_PULL_RETRY_INTERVAL_MS",
	250,
);

const LSP_CRASH_CODES = new Set([
	"ERR_STREAM_DESTROYED",
	"ERR_STREAM_WRITE_AFTER_END",
	"EPIPE",
	"ECONNRESET",
]);

let crashGuardInstalled = false;

function isIgnorableLspRuntimeCrash(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const code = (err as { code?: string }).code;
	if (code && LSP_CRASH_CODES.has(code)) return true;
	const msg = err.message.toLowerCase();
	const stack = (err.stack ?? "").toLowerCase();
	return (
		msg.includes("stream") ||
		msg.includes("write after end") ||
		stack.includes("vscode-jsonrpc/lib/node/ril.js")
	);
}

function installCrashGuard(): void {
	if (crashGuardInstalled) return;
	crashGuardInstalled = true;

	process.on("uncaughtException", (err) => {
		if (isIgnorableLspRuntimeCrash(err)) {
			return;
		}
		throw err;
	});

	process.on("unhandledRejection", (reason) => {
		if (isIgnorableLspRuntimeCrash(reason)) {
			return;
		}
	});
}

// --- Client Factory ---

export async function createLSPClient(options: {
	serverId: string;
	process: LSPProcess;
	root: string;
	initialization?: Record<string, unknown>;
}): Promise<LSPClientInfo> {
	installCrashGuard();

	const { serverId, process: lspProcess, root, initialization } = options;

	// Attach persistent 'error' listeners to all three stdio streams.
	//
	// Why: when the LSP process exits, Node.js destroys its stdio streams and
	// may emit 'error' (ERR_STREAM_DESTROYED / EPIPE / ECONNRESET) on them.
	// Without a listener that becomes an uncaught exception.
	//
	// vscode-jsonrpc attaches its own error listeners to stdin/stdout via
	// WritableStreamWrapper / ReadableStreamWrapper, but those listeners are
	// removed when connection.dispose() is called. Our listeners are permanent
	// so they cover the window between dispose() and process.kill(), as well as
	// any cases where the process dies before the connection is set up.
	//
	// stderr: nobody else ever attaches an error listener here.
	// stdout: vscode-jsonrpc covers it during the connection lifetime, but not
	//         after dispose(). After dispose() the stream is about to be
	//         destroyed anyway, so we just swallow the error.
	const streamErrorHandler =
		(label: string) => (err: Error & { code?: string }) => {
			if (
				err.code === "ERR_STREAM_DESTROYED" ||
				err.code === "ERR_STREAM_WRITE_AFTER_END" ||
				err.code === "EPIPE" ||
				err.code === "ECONNRESET"
			)
				return;
			console.error(`[lsp] ${serverId} ${label} stream error:`, err.message);
		};

	(lspProcess.stdin as NodeJS.WritableStream).on(
		"error",
		streamErrorHandler("stdin"),
	);
	(lspProcess.stdout as NodeJS.ReadableStream).on(
		"error",
		streamErrorHandler("stdout"),
	);
	(lspProcess.stderr as NodeJS.ReadableStream).on(
		"error",
		streamErrorHandler("stderr"),
	);

	// Create JSON-RPC connection
	const connection = createMessageConnection(
		new StreamMessageReader(lspProcess.stdout),
		new StreamMessageWriter(lspProcess.stdin),
	);

	// Track diagnostics per file
	const diagnostics = new Map<string, LSPDiagnostic[]>();
	const pendingDiagnostics = new Map<string, ReturnType<typeof setTimeout>>();

	// Local event emitter — signals waitForDiagnostics when new diagnostics arrive.
	// Scoped to this client instance; replaces global bus pub/sub.
	// setMaxListeners guards against Node.js warning for concurrent waitForDiagnostics calls.
	const diagnosticEmitter = new EventEmitter();
	diagnosticEmitter.setMaxListeners(50);

	// Handle incoming diagnostics with debouncing
	connection.onNotification(
		"textDocument/publishDiagnostics",
		(params: { uri: string; diagnostics?: LSPDiagnostic[] }) => {
			const filePath = uriToPath(params.uri);
			const normalizedPath = normalizeMapKey(filePath);
			const newDiags: LSPDiagnostic[] = params.diagnostics || [];

			// Debounce: clear existing timer and set new one
			const existingTimer = pendingDiagnostics.get(normalizedPath);
			if (existingTimer) clearTimeout(existingTimer);

			const timer = setTimeout(() => {
				diagnostics.set(normalizedPath, newDiags);
				pendingDiagnostics.delete(normalizedPath);

				// Signal any active waitForDiagnostics calls for this file.
				diagnosticEmitter.emit("diagnostics", normalizedPath);
			}, DIAGNOSTICS_DEBOUNCE_MS);

			pendingDiagnostics.set(normalizedPath, timer);
		},
	);

	// Handle server requests
	connection.onRequest("workspace/workspaceFolders", () => [
		{
			name: "workspace",
			uri: pathToFileURL(root).href,
		},
	]);

	connection.onRequest("client/registerCapability", async () => {});
	connection.onRequest("client/unregisterCapability", async () => {});
	connection.onRequest("workspace/configuration", async () => [
		initialization ?? {},
	]);
	connection.onRequest("window/workDoneProgress/create", async () => {});

	// Start listening
	connection.listen();

	// Track connection state
	let isConnected = true;
	let lastError: Error | undefined;
	let isDestroyed = false;
	let connectionDisposed = false;

	function disposeConnection(): void {
		if (connectionDisposed) return;
		connectionDisposed = true;
		try {
			connection.dispose();
		} catch {
			// ignore
		}
	}

	// Handle connection errors and close events
	connection.onError((error) => {
		lastError = error instanceof Error ? error : new Error(String(error));
		isConnected = false;
		isDestroyed = true;
		disposeConnection();
		console.error(`[lsp] ${serverId} connection error:`, lastError.message);
	});

	connection.onClose(() => {
		isConnected = false;
		isDestroyed = true;
		disposeConnection();
	});

	// Also handle process exit to catch crashes immediately
	lspProcess.process.on("exit", (code) => {
		isConnected = false;
		isDestroyed = true;
		disposeConnection();
		if (code !== 0 && code !== null) {
			console.error(`[lsp] ${serverId} process exited with code ${code}`);
		}
	});

	// Helper to check if process is still alive before operations
	function isProcessAlive(): boolean {
		return isConnected && !isDestroyed && !lspProcess.process.killed;
	}

	// Send initialize request with error handling
	const initResult = await withTimeout(
		safeSendRequest(connection, "initialize", {
			processId: process.pid,
			rootUri: pathToFileURL(root).href,
			workspaceFolders: [
				{
					name: "workspace",
					uri: pathToFileURL(root).href,
				},
			],
			capabilities: {
				window: {
					workDoneProgress: true,
				},
				workspace: {
					workspaceFolders: true, // Simple boolean for broader compatibility
					configuration: true,
					didChangeWatchedFiles: {
						dynamicRegistration: true,
					},
				},
				textDocument: {
					synchronization: {
						didOpen: true,
						didChange: true,
					},
					publishDiagnostics: {
						versionSupport: true,
					},
				},
			},
			initializationOptions: initialization,
		}),
		INITIALIZE_TIMEOUT_MS,
	);

	if (initResult === undefined) {
		throw new Error(
			`[lsp] ${serverId} failed to initialize - stream may have been destroyed. ` +
				`The server binary may be missing or crashed immediately. Try reinstalling: npm install -g ${serverId}-language-server`,
		);
	}

	const workspaceDiagnosticsSupport = detectWorkspaceDiagnosticsSupport(initResult);
	const operationSupport = detectOperationSupport(initResult);

	// Send initialized notification
	await safeSendNotification(connection, "initialized", {});

	// Send configuration if provided (helps pyright and other servers)
	if (initialization) {
		await safeSendNotification(connection, "workspace/didChangeConfiguration", {
			settings: initialization,
		});
	}

	// Track open documents with version numbers
	const documentVersions = new Map<string, number>();
	const openDocuments = new Set<string>();

	return {
		serverId,
		root,
		connection,
		isAlive: () => isProcessAlive(),

		notify: {
			async open(filePath, content, languageId) {
				if (!isProcessAlive()) return;
				const uri = pathToFileURL(filePath).href;
				// Normalize path for Windows case-insensitive lookup
				const normalizedPath = normalizeMapKey(filePath);

				// Some servers are strict about duplicate didOpen. If the document is
				// already open, treat this as a full-content update instead.
				if (openDocuments.has(normalizedPath)) {
					const version = (documentVersions.get(normalizedPath) ?? 0) + 1;
					documentVersions.set(normalizedPath, version);
					await safeSendNotification(connection, "textDocument/didChange", {
						textDocument: { uri, version },
						contentChanges: [{ text: content }],
					});
					return;
				}

				documentVersions.set(normalizedPath, 0);
				diagnostics.delete(normalizedPath); // Clear stale diagnostics

				// Send workspace notification first (like opencode does)
				await safeSendNotification(
					connection,
					"workspace/didChangeWatchedFiles",
					{
						changes: [
							{
								uri,
								type: 1, // Created
							},
						],
					},
				);

				if (!isProcessAlive()) return;

				await safeSendNotification(connection, "textDocument/didOpen", {
					textDocument: {
						uri,
						languageId,
						version: 0,
						text: content,
					},
				});
				openDocuments.add(normalizedPath);
			},

			async change(filePath, content) {
				if (!isProcessAlive()) return;
				const uri = pathToFileURL(filePath).href;
				// Normalize path for Windows case-insensitive lookup
				const normalizedPath = normalizeMapKey(filePath);
				if (!openDocuments.has(normalizedPath)) {
					// Safety fallback: keep protocol ordering valid even if caller sends
					// didChange before first didOpen for this document.
					await safeSendNotification(connection, "textDocument/didOpen", {
						textDocument: {
							uri,
							languageId: "plaintext",
							version: 0,
							text: content,
						},
					});
					documentVersions.set(normalizedPath, 0);
					openDocuments.add(normalizedPath);
					return;
				}
				const version = (documentVersions.get(normalizedPath) ?? 0) + 1;
				documentVersions.set(normalizedPath, version);

				await safeSendNotification(connection, "textDocument/didChange", {
					textDocument: { uri, version },
					contentChanges: [{ text: content }],
				});
			},
		},

		getDiagnostics(filePath) {
			// Normalize path for Windows case-insensitive lookup
			const normalizedPath = normalizeMapKey(filePath);
			return diagnostics.get(normalizedPath) ?? [];
		},

		getAllDiagnostics() {
			// Return copy of all tracked diagnostics (for cascade checking)
			return new Map(diagnostics);
		},

		getWorkspaceDiagnosticsSupport() {
			return workspaceDiagnosticsSupport;
		},

		getOperationSupport() {
			return operationSupport;
		},

		async waitForDiagnostics(filePath, timeoutMs = DIAGNOSTICS_WAIT_TIMEOUT_MS) {
			const normalizedPath = normalizeMapKey(filePath);

			if (workspaceDiagnosticsSupport.mode === "pull") {
				const firstPullCount = await requestPullDiagnostics(filePath);
				if (firstPullCount > 0) return;

				const retryBudgetMs = Math.min(
					timeoutMs,
					PULL_DIAGNOSTICS_RETRY_BUDGET_MS,
				);
				const startedAt = Date.now();
				let latestCount = firstPullCount;

				while (
					latestCount === 0 &&
					Date.now() - startedAt < retryBudgetMs
				) {
					await new Promise((resolve) =>
						setTimeout(resolve, PULL_DIAGNOSTICS_RETRY_INTERVAL_MS),
					);
					latestCount = await requestPullDiagnostics(filePath);
				}

				return;
			}

			// Fast path: diagnostics already available
			if (diagnostics.has(normalizedPath)) return;

			return new Promise<void>((resolve) => {
				let debounceTimer: ReturnType<typeof setTimeout> | undefined;

				// Listen on the local emitter for this client's diagnostic notifications.
				// No runnerId filter needed — this emitter is scoped to this client instance.
				const onDiagnostics = (fp: string) => {
					if (normalizeMapKey(fp) !== normalizedPath) return;

					// Debounce: reset on each event to catch follow-up semantic diagnostics
					// (LSP often sends syntax diagnostics first, semantic ones shortly after).
					if (debounceTimer) clearTimeout(debounceTimer);
					debounceTimer = setTimeout(() => {
						diagnosticEmitter.off("diagnostics", onDiagnostics);
						clearTimeout(timeout);
						resolve();
					}, DIAGNOSTICS_DEBOUNCE_MS);
				};

				diagnosticEmitter.on("diagnostics", onDiagnostics);

				// Timeout fallback: resolve even if no diagnostics arrive
				// (some files have no errors, or the server may be slow)
				const timeout = setTimeout(() => {
					if (debounceTimer) clearTimeout(debounceTimer);
					diagnosticEmitter.off("diagnostics", onDiagnostics);
					resolve();
				}, timeoutMs);
			});
		},

		async definition(filePath, line, character) {
			if (!isProcessAlive()) return [];
			const uri = pathToFileURL(filePath).href;
			const result = await safeSendRequest<LSPLocation | LSPLocation[]>(
				connection,
				"textDocument/definition",
				{
					textDocument: { uri },
					position: { line, character },
				},
			);
			if (!result) return [];
			return Array.isArray(result) ? result : [result];
		},

		async references(filePath, line, character, includeDeclaration = true) {
			if (!isProcessAlive()) return [];
			const uri = pathToFileURL(filePath).href;
			const result = await safeSendRequest<LSPLocation[]>(
				connection,
				"textDocument/references",
				{
					textDocument: { uri },
					position: { line, character },
					context: { includeDeclaration },
				},
			);
			return result ?? [];
		},

		async hover(filePath, line, character) {
			if (!isProcessAlive()) return null;
			const uri = pathToFileURL(filePath).href;
			const result = await safeSendRequest<LSPHover>(
				connection,
				"textDocument/hover",
				{
					textDocument: { uri },
					position: { line, character },
				},
			);
			return result ?? null;
		},

		async signatureHelp(filePath, line, character) {
			if (!isProcessAlive()) return null;
			const uri = pathToFileURL(filePath).href;
			const result = await safeSendRequest<LSPSignatureHelp>(
				connection,
				"textDocument/signatureHelp",
				{
					textDocument: { uri },
					position: { line, character },
				},
			);
			return result ?? null;
		},

		async documentSymbol(filePath) {
			if (!isProcessAlive()) return [];
			const uri = pathToFileURL(filePath).href;
			const result = await safeSendRequest<LSPSymbol[]>(
				connection,
				"textDocument/documentSymbol",
				{
					textDocument: { uri },
				},
			);
			return result ?? [];
		},

		async workspaceSymbol(query) {
			if (!isProcessAlive()) return [];
			const result = await safeSendRequest<LSPSymbol[]>(
				connection,
				"workspace/symbol",
				{
					query,
				},
			);
			return result ?? [];
		},

		async codeAction(
			filePath,
			line,
			character,
			endLine,
			endCharacter,
		) {
			if (!isProcessAlive()) return [];
			const uri = pathToFileURL(filePath).href;
			const result = await safeSendRequest<unknown[]>(
				connection,
				"textDocument/codeAction",
				{
					textDocument: { uri },
					range: {
						start: { line, character },
						end: { line: endLine, character: endCharacter },
					},
					context: {
						diagnostics: diagnostics.get(normalizeMapKey(filePath)) ?? [],
					},
				},
			);
			if (!result || !Array.isArray(result)) return [];
			return result.filter(
				(item): item is LSPCodeAction =>
					typeof item === "object" && item !== null && "title" in item,
			);
		},

		async rename(filePath, line, character, newName) {
			if (!isProcessAlive()) return null;
			const uri = pathToFileURL(filePath).href;
			const result = await safeSendRequest<LSPWorkspaceEdit>(
				connection,
				"textDocument/rename",
				{
					textDocument: { uri },
					position: { line, character },
					newName,
				},
			);
			return result ?? null;
		},

		async implementation(filePath, line, character) {
			if (!isProcessAlive()) return [];
			const uri = pathToFileURL(filePath).href;
			const result = await safeSendRequest<LSPLocation | LSPLocation[]>(
				connection,
				"textDocument/implementation",
				{
					textDocument: { uri },
					position: { line, character },
				},
			);
			if (!result) return [];
			return Array.isArray(result) ? result : [result];
		},

		// --- Call Hierarchy Methods ---

		async prepareCallHierarchy(filePath, line, character) {
			if (!isProcessAlive()) return [];
			const uri = pathToFileURL(filePath).href;
			const result = await safeSendRequest<
				LSPCallHierarchyItem | LSPCallHierarchyItem[]
			>(connection, "textDocument/prepareCallHierarchy", {
				textDocument: { uri },
				position: { line, character },
			});
			if (!result) return [];
			return Array.isArray(result) ? result : [result];
		},

		async incomingCalls(item) {
			if (!isProcessAlive()) return [];
			const result = await safeSendRequest<LSPCallHierarchyIncomingCall[]>(
				connection,
				"callHierarchy/incomingCalls",
				{
					item,
				},
			);
			return result ?? [];
		},

		async outgoingCalls(item) {
			if (!isProcessAlive()) return [];
			const result = await safeSendRequest<LSPCallHierarchyOutgoingCall[]>(
				connection,
				"callHierarchy/outgoingCalls",
				{
					item,
				},
			);
			return result ?? [];
		},

		async shutdown() {
			isConnected = false;
			isDestroyed = true;
			// Clear pending timers
			for (const timer of pendingDiagnostics.values()) {
				clearTimeout(timer);
			}
			pendingDiagnostics.clear();
			openDocuments.clear();

			// Remove all diagnostic listeners (cancels any in-flight waitForDiagnostics)
			diagnosticEmitter.removeAllListeners();

			// Graceful shutdown - ignore errors from destroyed streams
			try {
				await safeSendRequest(connection, "shutdown", {});
			} catch {
				/* ignore */
			}
			try {
				await safeSendNotification(connection, "exit", {});
			} catch {
				/* ignore */
			}

			disposeConnection();
			lspProcess.process.kill();
		},
	};

	async function requestPullDiagnostics(filePath: string): Promise<number> {
		if (!isProcessAlive()) return 0;
		const uri = pathToFileURL(filePath).href;
		try {
			const report = await safeSendRequest<{
				kind?: string;
				items?: LSPDiagnostic[];
				relatedDocuments?: Record<string, { items?: LSPDiagnostic[] }>;
			}>(connection, "textDocument/diagnostic", {
				textDocument: { uri },
			});

			if (!report) return 0;

			const normalizedPath = normalizeMapKey(filePath);
			const primaryItems = report.items ?? [];
			diagnostics.set(normalizedPath, primaryItems);
			let totalCount = primaryItems.length;

			if (report.relatedDocuments) {
				for (const [relatedUri, related] of Object.entries(
					report.relatedDocuments,
				)) {
					const relatedPath = uriToPath(relatedUri);
					const relatedItems = related?.items ?? [];
					diagnostics.set(normalizeMapKey(relatedPath), relatedItems);
					totalCount += relatedItems.length;
				}
			}

			diagnosticEmitter.emit("diagnostics", normalizedPath);
			return totalCount;
		} catch {
			return 0;
		}
	}
}

// Helper to safely send notifications - catches stream destruction
async function safeSendNotification(
	connection: MessageConnection,
	method: string,
	params: unknown,
): Promise<void> {
	try {
		await connection.sendNotification(method as never, params as never);
	} catch (err) {
		if (isStreamError(err)) {
			// Silently ignore - stream was destroyed, connection error handlers will update state
			return;
		}
		throw err;
	}
}

// Helper to safely send requests - catches stream destruction
async function safeSendRequest<T>(
	connection: MessageConnection,
	method: string,
	params: unknown,
): Promise<T | undefined> {
	try {
		return (await connection.sendRequest(
			method as never,
			params as never,
		)) as T;
	} catch (err) {
		if (isStreamError(err)) {
			// Silently ignore - stream was destroyed
			return undefined;
		}
		throw err;
	}
}

// Helper to detect stream destruction / connection disposal errors.
// vscode-jsonrpc throws these when the LSP server process exits while
// requests are still in flight:
//   "Connection is disposed."
//   "Pending response rejected since connection got disposed"
// Neither phrase contains "stream", "destroyed", or "closed", which is
// why we must also match "disposed" and "cancelled" here.
function isStreamError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const msg = err.message.toLowerCase();
	return (
		msg.includes("stream") ||
		msg.includes("destroyed") ||
		msg.includes("closed") ||
		msg.includes("disposed") ||
		msg.includes("cancelled") ||
		(err as { code?: string }).code === "ERR_STREAM_DESTROYED" ||
		(err as { code?: string }).code === "ERR_STREAM_WRITE_AFTER_END" ||
		(err as { code?: string }).code === "EPIPE"
	);
}

// Using shared path utilities from path-utils.ts

function severityFromNumber(
	sev: number,
): "error" | "warning" | "info" | "hint" {
	switch (sev) {
		case 1:
			return "error";
		case 2:
			return "warning";
		case 3:
			return "info";
		case 4:
			return "hint";
		default:
			return "error";
	}
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	// Suppress unhandled rejection if `promise` rejects AFTER the timeout
	// wins the race — Promise.race settles on the first result but the
	// losing promises still run, and any later rejection would be uncaught.
	promise.catch(() => {});
	return Promise.race([
		promise,
		new Promise<T>((_, reject) =>
			setTimeout(
				() => reject(new Error(`Timeout after ${timeoutMs}ms`)),
				timeoutMs,
			),
		),
	]);
}

function positiveIntFromEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return parsed;
}

function detectWorkspaceDiagnosticsSupport(
	initResult: unknown,
): LSPWorkspaceDiagnosticsSupport {
	const capabilities =
		typeof initResult === "object" && initResult !== null
			? (initResult as { capabilities?: Record<string, unknown> }).capabilities
			: undefined;
	const diagnosticProvider = capabilities?.diagnosticProvider;
	if (!diagnosticProvider) {
		return {
			advertised: false,
			mode: "push-only",
			diagnosticProviderKind: "none",
		};
	}

	if (typeof diagnosticProvider === "boolean") {
		return {
			advertised: diagnosticProvider,
			mode: diagnosticProvider ? "pull" : "push-only",
			diagnosticProviderKind: "boolean",
		};
	}

	if (typeof diagnosticProvider === "object") {
		return {
			advertised: true,
			mode: "pull",
			diagnosticProviderKind: "object",
		};
	}

	return {
		advertised: false,
		mode: "push-only",
		diagnosticProviderKind: typeof diagnosticProvider,
	};
}

function detectOperationSupport(initResult: unknown): LSPOperationSupport {
	const capabilities =
		typeof initResult === "object" && initResult !== null
			? (initResult as { capabilities?: Record<string, unknown> }).capabilities
			: undefined;

	const hasProvider = (key: string): boolean => {
		const value = capabilities?.[key];
		if (value === undefined || value === null) return false;
		if (typeof value === "boolean") return value;
		return true;
	};

	return {
		definition: hasProvider("definitionProvider"),
		references: hasProvider("referencesProvider"),
		hover: hasProvider("hoverProvider"),
		signatureHelp: hasProvider("signatureHelpProvider"),
		documentSymbol: hasProvider("documentSymbolProvider"),
		workspaceSymbol: hasProvider("workspaceSymbolProvider"),
		codeAction: hasProvider("codeActionProvider"),
		rename: hasProvider("renameProvider"),
		implementation: hasProvider("implementationProvider"),
		callHierarchy: hasProvider("callHierarchyProvider"),
	};
}
