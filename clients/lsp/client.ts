/**
 * LSP Client for pi-lens
 *
 * Handles JSON-RPC communication with language servers:
 * - Initialize/shutdown lifecycle
 * - Document synchronization (didOpen, didChange)
 * - Diagnostics with debouncing
 * - Request/response handling
 */

import { spawn as nodeSpawn } from "node:child_process";
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
		open(filePath: string, content: string, languageId: string, preserveDiagnostics?: boolean): Promise<void>;
		change(filePath: string, content: string): Promise<void>;
	};
	getDiagnostics(filePath: string): LSPDiagnostic[];
	waitForDiagnostics(filePath: string, timeoutMs?: number): Promise<void>;
	/** Get all tracked diagnostics with timestamps (for cascade checking) */
	getAllDiagnostics(): Map<string, { diags: LSPDiagnostic[]; ts: number }>;
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
const NAV_REQUEST_TIMEOUT_MS = positiveIntFromEnv(
	"PI_LENS_LSP_NAV_REQUEST_TIMEOUT_MS",
	10_000,
); // 10s — per-request ceiling; prevents heavy servers (vue, svelte) from hanging
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
		throw reason instanceof Error ? reason : new Error(String(reason));
	});
}

// --- Client State + Module-level helpers ---

export interface LSPClientState {
	isConnected: boolean;
	isDestroyed: boolean;
	connectionDisposed: boolean;
	lastError: Error | undefined;
	readonly connection: MessageConnection;
	readonly diagnostics: Map<string, LSPDiagnostic[]>;
	readonly diagnosticTimestamps: Map<string, number>;
	readonly pendingDiagnostics: Map<string, ReturnType<typeof setTimeout>>;
	readonly diagnosticEmitter: EventEmitter;
	readonly documentVersions: Map<string, number>;
	readonly openDocuments: Set<string>;
	readonly pendingOpens: Set<string>;
	readonly workspaceDiagnosticsSupport: LSPWorkspaceDiagnosticsSupport;
	readonly operationSupport: LSPOperationSupport;
	readonly serverId: string;
	readonly root: string;
	readonly lspProcess: LSPProcess;
}

function isClientAlive(state: LSPClientState): boolean {
	return (
		state.isConnected && !state.isDestroyed && !state.lspProcess.process.killed
	);
}

function disposeClientConnection(state: LSPClientState): void {
	if (state.connectionDisposed) return;
	state.connectionDisposed = true;
	try {
		state.connection.dispose();
	} catch {
		// ignore
	}
}

function setupIncomingHandlers(
	state: LSPClientState,
	initialization: Record<string, unknown> | undefined,
): void {
	state.connection.onNotification(
		"textDocument/publishDiagnostics",
		(params: { uri: string; diagnostics?: LSPDiagnostic[] }) => {
			const filePath = uriToPath(params.uri);
			const normalizedPath = normalizeMapKey(filePath);
			const newDiags: LSPDiagnostic[] = params.diagnostics || [];

			const existingTimer = state.pendingDiagnostics.get(normalizedPath);
			if (existingTimer) clearTimeout(existingTimer);

			const timer = setTimeout(() => {
				state.diagnostics.set(normalizedPath, newDiags);
				state.diagnosticTimestamps.set(normalizedPath, Date.now());
				state.pendingDiagnostics.delete(normalizedPath);
				state.diagnosticEmitter.emit("diagnostics", normalizedPath);
			}, DIAGNOSTICS_DEBOUNCE_MS);

			state.pendingDiagnostics.set(normalizedPath, timer);
		},
	);

	state.connection.onRequest("workspace/workspaceFolders", () => [
		{ name: "workspace", uri: pathToFileURL(state.root).href },
	]);
	state.connection.onRequest("client/registerCapability", async () => {});
	state.connection.onRequest("client/unregisterCapability", async () => {});
	state.connection.onRequest("workspace/configuration", async () => [
		initialization ?? {},
	]);
	state.connection.onRequest("window/workDoneProgress/create", async () => {});
}

function setupConnectionLifecycle(state: LSPClientState): void {
	state.connection.onError(([error]: [Error, ...unknown[]]) => {
		state.lastError = error instanceof Error ? error : new Error(String(error));
		state.isConnected = false;
		state.isDestroyed = true;
		disposeClientConnection(state);
	});

	state.connection.onClose(() => {
		state.isConnected = false;
		state.isDestroyed = true;
		disposeClientConnection(state);
	});

	state.lspProcess.process.on("exit", (_code) => {
		state.isConnected = false;
		state.isDestroyed = true;
		disposeClientConnection(state);
	});
}

async function clientRequestPullDiagnostics(
	state: LSPClientState,
	filePath: string,
): Promise<number> {
	if (!isClientAlive(state)) return 0;
	const uri = pathToFileURL(filePath).href;
	try {
		const report = await safeSendRequest<{
			kind?: string;
			items?: LSPDiagnostic[];
			relatedDocuments?: Record<string, { items?: LSPDiagnostic[] }>;
		}>(state.connection, "textDocument/diagnostic", { textDocument: { uri } });

		if (!report) return 0;

		const normalizedPath = normalizeMapKey(filePath);
		const primaryItems = report.items ?? [];
		const now = Date.now();
		state.diagnostics.set(normalizedPath, primaryItems);
		state.diagnosticTimestamps.set(normalizedPath, now);
		let totalCount = primaryItems.length;

		if (report.relatedDocuments) {
			for (const [relatedUri, related] of Object.entries(
				report.relatedDocuments,
			)) {
				const relatedPath = uriToPath(relatedUri);
				const relatedItems = related?.items ?? [];
				state.diagnostics.set(normalizeMapKey(relatedPath), relatedItems);
				state.diagnosticTimestamps.set(normalizeMapKey(relatedPath), now);
				totalCount += relatedItems.length;
			}
		}

		state.diagnosticEmitter.emit("diagnostics", normalizedPath);
		return totalCount;
	} catch {
		return 0;
	}
}

export async function clientWaitForDiagnostics(
	state: LSPClientState,
	filePath: string,
	timeoutMs: number,
): Promise<void> {
	const normalizedPath = normalizeMapKey(filePath);

	if (state.workspaceDiagnosticsSupport.mode === "pull") {
		const firstPullCount = await clientRequestPullDiagnostics(state, filePath);
		if (firstPullCount > 0) return;

		const retryBudgetMs = Math.min(timeoutMs, PULL_DIAGNOSTICS_RETRY_BUDGET_MS);
		const startedAt = Date.now();
		let latestCount = firstPullCount;

		while (latestCount === 0 && Date.now() - startedAt < retryBudgetMs) {
			await new Promise((resolve) =>
				setTimeout(resolve, PULL_DIAGNOSTICS_RETRY_INTERVAL_MS),
			);
			latestCount = await clientRequestPullDiagnostics(state, filePath);
		}
		if (latestCount > 0) return;
	}

	if (state.diagnostics.has(normalizedPath)) return;

	return new Promise<void>((resolve) => {
		let debounceTimer: ReturnType<typeof setTimeout> | undefined;

		const onDiagnostics = (fp: string) => {
			if (normalizeMapKey(fp) !== normalizedPath) return;
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				state.diagnosticEmitter.off("diagnostics", onDiagnostics);
				clearTimeout(timeout);
				resolve();
			}, DIAGNOSTICS_DEBOUNCE_MS);
		};

		state.diagnosticEmitter.on("diagnostics", onDiagnostics);

		const timeout = setTimeout(() => {
			if (debounceTimer) clearTimeout(debounceTimer);
			state.diagnosticEmitter.off("diagnostics", onDiagnostics);
			resolve();
		}, timeoutMs);
	});
}

export async function handleNotifyOpen(
	state: LSPClientState,
	filePath: string,
	content: string,
	languageId: string,
	preserveDiagnostics = false,
): Promise<void> {
	if (!isClientAlive(state)) return;
	const uri = pathToFileURL(filePath).href;
	const normalizedPath = normalizeMapKey(filePath);

	if (
		state.openDocuments.has(normalizedPath) ||
		state.pendingOpens.has(normalizedPath)
	) {
		const version = (state.documentVersions.get(normalizedPath) ?? 0) + 1;
		state.documentVersions.set(normalizedPath, version);
		// preserveDiagnostics: skip cache clear for format-only resyncs so
		// waitForDiagnostics fast-paths instead of waiting up to 5s for TypeScript
		// to re-publish what it already knows (formatting doesn't change semantics).
		if (!preserveDiagnostics) {
			state.diagnostics.delete(normalizedPath);
		}
		await safeSendNotification(state.connection, "textDocument/didChange", {
			textDocument: { uri, version },
			contentChanges: [{ text: content }],
		});
		return;
	}

	state.pendingOpens.add(normalizedPath);
	state.documentVersions.set(normalizedPath, 0);
	state.diagnostics.delete(normalizedPath); // always clear for initial open

	// Send workspace notification first (like opencode does)
	await safeSendNotification(
		state.connection,
		"workspace/didChangeWatchedFiles",
		{ changes: [{ uri, type: 1 }] },
	);

	if (!isClientAlive(state)) return;

	await safeSendNotification(state.connection, "textDocument/didOpen", {
		textDocument: { uri, languageId, version: 0, text: content },
	});
	state.pendingOpens.delete(normalizedPath);
	state.openDocuments.add(normalizedPath);
}

export async function handleNotifyChange(
	state: LSPClientState,
	filePath: string,
	content: string,
): Promise<void> {
	if (!isClientAlive(state)) return;
	const uri = pathToFileURL(filePath).href;
	const normalizedPath = normalizeMapKey(filePath);

	if (!state.openDocuments.has(normalizedPath)) {
		// Safety fallback: keep protocol ordering valid even if caller sends
		// didChange before first didOpen for this document.
		await safeSendNotification(state.connection, "textDocument/didOpen", {
			textDocument: { uri, languageId: "plaintext", version: 0, text: content },
		});
		state.documentVersions.set(normalizedPath, 0);
		state.openDocuments.add(normalizedPath);
		return;
	}

	const version = (state.documentVersions.get(normalizedPath) ?? 0) + 1;
	state.documentVersions.set(normalizedPath, version);
	// Clear stale diagnostics before sending new content so waitForDiagnostics
	// doesn't return immediately with the previous edit's results.
	state.diagnostics.delete(normalizedPath);
	await safeSendNotification(state.connection, "textDocument/didChange", {
		textDocument: { uri, version },
		contentChanges: [{ text: content }],
	});
}

async function clientShutdown(state: LSPClientState): Promise<void> {
	state.isConnected = false;
	state.isDestroyed = true;
	for (const timer of state.pendingDiagnostics.values()) {
		clearTimeout(timer);
	}
	state.pendingDiagnostics.clear();
	state.pendingOpens.clear();
	state.openDocuments.clear();
	state.diagnosticEmitter.removeAllListeners();
	try {
		await safeSendRequest(state.connection, "shutdown", {});
	} catch {
		/* ignore */
	}
	try {
		await safeSendNotification(state.connection, "exit", {});
	} catch {
		/* ignore */
	}
	disposeClientConnection(state);
	state.lspProcess.process.kill();
}

async function navRequest<T>(
	state: LSPClientState,
	method: string,
	params: Record<string, unknown>,
): Promise<T | null | undefined> {
	if (!isClientAlive(state)) return null;
	return withTimeout(
		safeSendRequest<T>(state.connection, method, params),
		NAV_REQUEST_TIMEOUT_MS,
	).catch((err: unknown) => {
		if (err instanceof Error && err.message.startsWith("Timeout after")) {
			return undefined;
		}
		throw err;
	}) as Promise<T | undefined>;
}

// --- Client Factory ---

export async function createLSPClient(options: {
	serverId: string;
	process: LSPProcess;
	root: string;
	initialization?: Record<string, unknown>;
	initializeTimeoutMs?: number;
}): Promise<LSPClientInfo> {
	installCrashGuard();

	const {
		serverId,
		process: lspProcess,
		root,
		initialization,
		initializeTimeoutMs = INITIALIZE_TIMEOUT_MS,
	} = options;

	const startupState: {
		exitCode: number | null;
		exitSignal: NodeJS.Signals | null;
		closeCode: number | null;
		closeSignal: NodeJS.Signals | null;
		stderr: string;
	} = {
		exitCode: null,
		exitSignal: null,
		closeCode: null,
		closeSignal: null,
		stderr: "",
	};

	const onStartupStderr = (chunk: Buffer | string): void => {
		if (startupState.stderr.length >= 4096) return;
		startupState.stderr += chunk.toString();
	};
	const onProcessExit = (
		code: number | null,
		signal: NodeJS.Signals | null,
	): void => {
		startupState.exitCode = code;
		startupState.exitSignal = signal;
	};
	const onProcessClose = (
		code: number | null,
		signal: NodeJS.Signals | null,
	): void => {
		startupState.closeCode = code;
		startupState.closeSignal = signal;
	};

	(lspProcess.stderr as NodeJS.ReadableStream).on("data", onStartupStderr);
	lspProcess.process.on("exit", onProcessExit);
	lspProcess.process.on("close", onProcessClose);

	// Attach persistent 'error' listeners to all three stdio streams.
	//
	// Why: when the LSP process exits, Node.js destroys its stdio streams and
	// may emit 'error' (ERR_STREAM_DESTROYED / EPIPE / ECONNRESET) on them.
	// Without a listener that becomes an uncaught exception.
	//
	// vscode-jsonrpc covers stdin/stdout during the connection lifetime but
	// removes its listeners on dispose(). Our permanent listeners cover the gap.
	const streamErrorHandler =
		(_label: string) => (err: Error & { code?: string }) => {
			if (
				err.code === "ERR_STREAM_DESTROYED" ||
				err.code === "ERR_STREAM_WRITE_AFTER_END" ||
				err.code === "EPIPE" ||
				err.code === "ECONNRESET"
			)
				return;
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

	const connection = createMessageConnection(
		new StreamMessageReader(lspProcess.stdout),
		new StreamMessageWriter(lspProcess.stdin),
	);

	// Local event emitter — signals waitForDiagnostics when new diagnostics arrive.
	// Scoped to this client instance. setMaxListeners guards against Node.js warning
	// for concurrent waitForDiagnostics calls.
	const diagnosticEmitter = new EventEmitter();
	diagnosticEmitter.setMaxListeners(50);

	const state: LSPClientState = {
		isConnected: true,
		isDestroyed: false,
		connectionDisposed: false,
		lastError: undefined,
		connection,
		diagnostics: new Map(),
		diagnosticTimestamps: new Map(),
		pendingDiagnostics: new Map(),
		diagnosticEmitter,
		documentVersions: new Map(),
		openDocuments: new Set(),
		pendingOpens: new Set(),
		// these are filled in after initialize — cast to avoid two-phase init
		workspaceDiagnosticsSupport:
			undefined as unknown as LSPWorkspaceDiagnosticsSupport,
		operationSupport: undefined as unknown as LSPOperationSupport,
		serverId,
		root,
		lspProcess,
	};

	setupIncomingHandlers(state, initialization);
	connection.listen();
	setupConnectionLifecycle(state);

	let initResult: Awaited<ReturnType<typeof safeSendRequest>>;
	try {
		initResult = await withTimeout(
			safeSendRequest(connection, "initialize", {
				processId: process.pid,
				rootUri: pathToFileURL(root).href,
				workspaceFolders: [
					{ name: "workspace", uri: pathToFileURL(root).href },
				],
				capabilities: {
					window: { workDoneProgress: true },
					workspace: {
						workspaceFolders: true,
						configuration: true,
						didChangeWatchedFiles: { dynamicRegistration: true },
					},
					textDocument: {
						synchronization: { didOpen: true, didChange: true },
						publishDiagnostics: { versionSupport: true },
					},
				},
				initializationOptions: initialization,
			}),
			initializeTimeoutMs,
		);
	} catch (err) {
		// Hard-kill the hung process so it doesn't become a zombie.
		// SIGTERM alone is unreliable on Windows for cmd.exe/PowerShell trees.
		const pid = lspProcess.pid;
		lspProcess.process.kill("SIGTERM");
		if (process.platform === "win32" && pid > 0) {
			try {
				nodeSpawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
					shell: false,
					windowsHide: true,
				});
			} catch {}
		}
		setTimeout(() => {
			if (!lspProcess.process.killed) lspProcess.process.kill("SIGKILL");
		}, 2000);
		throw err;
	} finally {
		(lspProcess.stderr as NodeJS.ReadableStream).off("data", onStartupStderr);
	}

	if (initResult === undefined) {
		const compactStderr = startupState.stderr
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 320);
		const telemetry = [
			`pid=${lspProcess.pid}`,
			`exitCode=${startupState.exitCode ?? "none"}`,
			`exitSignal=${startupState.exitSignal ?? "none"}`,
			`closeCode=${startupState.closeCode ?? "none"}`,
			`closeSignal=${startupState.closeSignal ?? "none"}`,
			`root=${root}`,
			compactStderr ? `stderr=${compactStderr}` : "stderr=<empty>",
		].join(" ");
		throw new Error(
			`[lsp] ${serverId} failed to initialize - stream may have been destroyed. ` +
				`The server binary may be missing or crashed immediately. Try reinstalling: npm install -g ${serverId}-language-server. ` +
				`telemetry: ${telemetry}`,
		);
	}

	(
		state as { workspaceDiagnosticsSupport: LSPWorkspaceDiagnosticsSupport }
	).workspaceDiagnosticsSupport = detectWorkspaceDiagnosticsSupport(initResult);
	(state as { operationSupport: LSPOperationSupport }).operationSupport =
		detectOperationSupport(initResult);

	await safeSendNotification(connection, "initialized", {});
	if (initialization) {
		await safeSendNotification(connection, "workspace/didChangeConfiguration", {
			settings: initialization,
		});
	}

	return {
		serverId,
		root,
		connection,
		isAlive: () => isClientAlive(state),

		notify: {
			async open(filePath, content, languageId, preserveDiagnostics) {
				return handleNotifyOpen(state, filePath, content, languageId, preserveDiagnostics);
			},
			async change(filePath, content) {
				return handleNotifyChange(state, filePath, content);
			},
		},

		getDiagnostics(filePath) {
			return state.diagnostics.get(normalizeMapKey(filePath)) ?? [];
		},

		getAllDiagnostics() {
			const result = new Map<string, { diags: LSPDiagnostic[]; ts: number }>();
			for (const [key, diags] of state.diagnostics) {
				result.set(key, {
					diags,
					ts: state.diagnosticTimestamps.get(key) ?? 0,
				});
			}
			return result;
		},

		getWorkspaceDiagnosticsSupport() {
			return state.workspaceDiagnosticsSupport;
		},

		getOperationSupport() {
			return state.operationSupport;
		},

		async waitForDiagnostics(
			filePath,
			timeoutMs = DIAGNOSTICS_WAIT_TIMEOUT_MS,
		) {
			return clientWaitForDiagnostics(state, filePath, timeoutMs);
		},

		async definition(filePath, line, character) {
			const result = await navRequest<LSPLocation | LSPLocation[]>(
				state,
				"textDocument/definition",
				{
					textDocument: { uri: pathToFileURL(filePath).href },
					position: { line, character },
				},
			);
			if (!result) return [];
			return Array.isArray(result) ? result : [result];
		},

		async references(filePath, line, character, includeDeclaration = true) {
			const result = await navRequest<LSPLocation[]>(
				state,
				"textDocument/references",
				{
					textDocument: { uri: pathToFileURL(filePath).href },
					position: { line, character },
					context: { includeDeclaration },
				},
			);
			return result ?? [];
		},

		async hover(filePath, line, character) {
			const result = await navRequest<LSPHover>(state, "textDocument/hover", {
				textDocument: { uri: pathToFileURL(filePath).href },
				position: { line, character },
			});
			return result ?? null;
		},

		async signatureHelp(filePath, line, character) {
			const result = await navRequest<LSPSignatureHelp>(
				state,
				"textDocument/signatureHelp",
				{
					textDocument: { uri: pathToFileURL(filePath).href },
					position: { line, character },
				},
			);
			return result ?? null;
		},

		async documentSymbol(filePath) {
			const result = await navRequest<LSPSymbol[]>(
				state,
				"textDocument/documentSymbol",
				{ textDocument: { uri: pathToFileURL(filePath).href } },
			);
			return result ?? [];
		},

		async workspaceSymbol(query) {
			if (!isClientAlive(state)) return [];
			const result = await safeSendRequest<LSPSymbol[]>(
				connection,
				"workspace/symbol",
				{ query },
			);
			return result ?? [];
		},

		async codeAction(filePath, line, character, endLine, endCharacter) {
			if (!isClientAlive(state)) return [];
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
						diagnostics: state.diagnostics.get(normalizeMapKey(filePath)) ?? [],
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
			const result = await navRequest<LSPWorkspaceEdit>(
				state,
				"textDocument/rename",
				{
					textDocument: { uri: pathToFileURL(filePath).href },
					position: { line, character },
					newName,
				},
			);
			return result ?? null;
		},

		async implementation(filePath, line, character) {
			const result = await navRequest<LSPLocation | LSPLocation[]>(
				state,
				"textDocument/implementation",
				{
					textDocument: { uri: pathToFileURL(filePath).href },
					position: { line, character },
				},
			);
			if (!result) return [];
			return Array.isArray(result) ? result : [result];
		},

		async prepareCallHierarchy(filePath, line, character) {
			const result = await navRequest<
				LSPCallHierarchyItem | LSPCallHierarchyItem[]
			>(state, "textDocument/prepareCallHierarchy", {
				textDocument: { uri: pathToFileURL(filePath).href },
				position: { line, character },
			});
			if (!result) return [];
			return Array.isArray(result) ? result : [result];
		},

		async incomingCalls(item) {
			const result = await navRequest<LSPCallHierarchyIncomingCall[]>(
				state,
				"callHierarchy/incomingCalls",
				{ item },
			);
			return result ?? [];
		},

		async outgoingCalls(item) {
			const result = await navRequest<LSPCallHierarchyOutgoingCall[]>(
				state,
				"callHierarchy/outgoingCalls",
				{ item },
			);
			return result ?? [];
		},

		async shutdown() {
			return clientShutdown(state);
		},
	};
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
