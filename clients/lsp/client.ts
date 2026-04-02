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

export interface LSPSymbol {
	name: string;
	kind: number;
	location?: LSPLocation;
	range?: LSPLocation["range"];
	selectionRange?: LSPLocation["range"];
	detail?: string;
	children?: LSPSymbol[];
}

export interface LSPClientInfo {
	serverId: string;
	root: string;
	connection: MessageConnection;
	notify: {
		open(filePath: string, content: string, languageId: string): Promise<void>;
		change(filePath: string, content: string): Promise<void>;
	};
	getDiagnostics(filePath: string): LSPDiagnostic[];
	waitForDiagnostics(filePath: string, timeoutMs?: number): Promise<void>;
	/** Get all tracked diagnostics (for cascade checking) */
	getAllDiagnostics(): Map<string, LSPDiagnostic[]>;
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
	/** Symbols in a document */
	documentSymbol(filePath: string): Promise<LSPSymbol[]>;
	/** Workspace-wide symbol search */
	workspaceSymbol(query: string): Promise<LSPSymbol[]>;
	/** Go to implementation */
	implementation(
		filePath: string,
		line: number,
		character: number,
	): Promise<LSPLocation[]>;
	shutdown(): Promise<void>;
}

// --- Constants ---

const DIAGNOSTICS_DEBOUNCE_MS = 150; // ms — waits for follow-up semantic diagnostics
const INITIALIZE_TIMEOUT_MS = 120_000; // 2 minutes (was 45s) - allows time for npx to download packages

// --- Client Factory ---

export async function createLSPClient(options: {
	serverId: string;
	process: LSPProcess;
	root: string;
	initialization?: Record<string, unknown>;
}): Promise<LSPClientInfo> {
	const { serverId, process: lspProcess, root, initialization } = options;

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
			const newDiags: LSPDiagnostic[] = params.diagnostics || [];

			// Debounce: clear existing timer and set new one
			const existingTimer = pendingDiagnostics.get(filePath);
			if (existingTimer) clearTimeout(existingTimer);

			const timer = setTimeout(() => {
				diagnostics.set(filePath, newDiags);
				pendingDiagnostics.delete(filePath);

				// Signal any active waitForDiagnostics calls for this file.
				diagnosticEmitter.emit("diagnostics", filePath);
			}, DIAGNOSTICS_DEBOUNCE_MS);

			pendingDiagnostics.set(filePath, timer);
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

	// Send initialize request
	await withTimeout(
		connection.sendRequest("initialize", {
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

	// Send initialized notification
	await connection.sendNotification("initialized", {});

	// Send configuration if provided (helps pyright and other servers)
	if (initialization) {
		await connection.sendNotification("workspace/didChangeConfiguration", {
			settings: initialization,
		});
	}

	// Track open documents with version numbers
	const documentVersions = new Map<string, number>();

	return {
		serverId,
		root,
		connection,

		notify: {
			async open(filePath, content, languageId) {
				const uri = pathToFileURL(filePath).href;
				// Normalize path for Windows case-insensitive lookup
				const normalizedPath = normalizeMapKey(filePath);
				documentVersions.set(normalizedPath, 0);
				diagnostics.delete(normalizedPath); // Clear stale diagnostics

				// Send workspace notification first (like opencode does)
				await connection.sendNotification("workspace/didChangeWatchedFiles", {
					changes: [
						{
							uri,
							type: 1, // Created
						},
					],
				});

				await connection.sendNotification("textDocument/didOpen", {
					textDocument: {
						uri,
						languageId,
						version: 0,
						text: content,
					},
				});
			},

			async change(filePath, content) {
				const uri = pathToFileURL(filePath).href;
				// Normalize path for Windows case-insensitive lookup
				const normalizedPath = normalizeMapKey(filePath);
				const version = (documentVersions.get(normalizedPath) ?? 0) + 1;
				documentVersions.set(normalizedPath, version);

				await connection.sendNotification("textDocument/didChange", {
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

		async waitForDiagnostics(filePath, timeoutMs = 10000) {
			const normalizedPath = normalizeMapKey(filePath);

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
			const uri = pathToFileURL(filePath).href;
			try {
				const result = await connection.sendRequest("textDocument/definition", {
					textDocument: { uri },
					position: { line, character },
				});
				if (!result) return [];
				return Array.isArray(result) ? result : [result];
			} catch {
				return [];
			}
		},

		async references(filePath, line, character, includeDeclaration = true) {
			const uri = pathToFileURL(filePath).href;
			try {
				const result = await connection.sendRequest("textDocument/references", {
					textDocument: { uri },
					position: { line, character },
					context: { includeDeclaration },
				});
				return Array.isArray(result) ? result : [];
			} catch {
				return [];
			}
		},

		async hover(filePath, line, character) {
			const uri = pathToFileURL(filePath).href;
			try {
				return (await connection.sendRequest("textDocument/hover", {
					textDocument: { uri },
					position: { line, character },
				})) as LSPHover | null;
			} catch {
				return null;
			}
		},

		async documentSymbol(filePath) {
			const uri = pathToFileURL(filePath).href;
			try {
				const result = await connection.sendRequest(
					"textDocument/documentSymbol",
					{
						textDocument: { uri },
					},
				);
				return Array.isArray(result) ? result : [];
			} catch {
				return [];
			}
		},

		async workspaceSymbol(query) {
			try {
				const result = await connection.sendRequest("workspace/symbol", {
					query,
				});
				return Array.isArray(result) ? result : [];
			} catch {
				return [];
			}
		},

		async implementation(filePath, line, character) {
			const uri = pathToFileURL(filePath).href;
			try {
				const result = await connection.sendRequest(
					"textDocument/implementation",
					{
						textDocument: { uri },
						position: { line, character },
					},
				);
				if (!result) return [];
				return Array.isArray(result) ? result : [result];
			} catch {
				return [];
			}
		},

		async shutdown() {
			// Clear pending timers
			for (const timer of pendingDiagnostics.values()) {
				clearTimeout(timer);
			}
			pendingDiagnostics.clear();

			// Remove all diagnostic listeners (cancels any in-flight waitForDiagnostics)
			diagnosticEmitter.removeAllListeners();

			// Graceful shutdown
			try {
				await connection.sendRequest("shutdown");
				await connection.sendNotification("exit");
			} catch {
				/* ignore */
			}

			connection.dispose();
			lspProcess.process.kill();
		},
	};
}

// --- Utilities ---

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
