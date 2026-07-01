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
import { access, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { MessageConnection } from "../deps/vscode-jsonrpc.js";
import { logLatency } from "../latency-logger.js";
// vscode-jsonrpc v9 ships an `exports` map exposing the Node entry as the
// `./node` subpath (no `.js`); the old `/node.js` file path no longer resolves.
import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "../deps/vscode-jsonrpc.js";

import { applyWorkspaceEdit } from "./edits.js";
import type { LSPProcess } from "./launch.js";
import { normalizeMapKey, uriToPath } from "./path-utils.js";
import {
	ADVERTISED_POSITION_ENCODINGS,
	convertCharacterOffset,
	lineTextAt,
	negotiatePositionEncoding,
	type PositionEncoding,
} from "./position-encoding.js";
import { getStrategy } from "./server-strategies.js";
import { WatchedFilesQueue } from "./watch-queue.js";

// Opt-in publishDiagnostics trace (PILENS_PUB_DEBUG=1) — read once, negligible
// hot-path cost. Surfaces each server's publish behavior (version + count) to
// diagnose the clean-file affirmative-signal question (#240): which servers
// publish an empty-with-version set on a clean scan vs go silent.
const PUB_DEBUG = Boolean(process.env.PILENS_PUB_DEBUG);

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
	isPreferred?: boolean;
	disabled?: { reason?: string };
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

export interface LSPShutdownOptions {
	/**
	 * Fast shutdown is for process/session teardown paths where extension cleanup
	 * must not keep the TUI or Node process alive. It sends exit/kill signals and
	 * unreferences child handles/timers instead of waiting for graceful escalation.
	 */
	fast?: boolean;
	/**
	 * Set only when the host process itself is exiting (e.g. `session_shutdown`
	 * during `pi update`), i.e. the event loop is already closing. In that state,
	 * spawning a child process (the Windows `taskkill /T` tree-kill) makes libuv
	 * call `uv_async_send` on the closing loop-wakeup handle and hard-aborts
	 * (Assertion `!(handle->flags & UV_HANDLE_CLOSING)`, `src\win\async.c`). When
	 * set, we kill via the handle we already hold (synchronous `TerminateProcess`,
	 * no new async handle) instead of spawning. Distinct from `fast`, which also
	 * covers mid-session teardowns (subagent/turn boundaries) where the host keeps
	 * running and the `/T` tree-kill is still wanted to avoid zombie accumulation.
	 */
	processExiting?: boolean;
}

export interface LSPOperationSupport {
	definition: boolean;
	typeDefinition: boolean;
	declaration: boolean;
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
	/** True if the server process has exited or been killed */
	processExited: () => boolean;
	/** Last N lines of server stderr for diagnostics */
	recentStderr: (lines?: number) => string;
	/** Pre-request health check — returns error string if process is dead */
	checkAlive: () => string | undefined;
	notify: {
		open(
			filePath: string,
			content: string,
			languageId: string,
			preserveDiagnostics?: boolean,
			silent?: boolean,
		): Promise<void>;
		change(filePath: string, content: string): Promise<void>;
	};
	getDiagnostics(filePath: string): LSPDiagnostic[];
	/** Monotonic counter bumped when fresh diagnostics are stored for this client. */
	readonly diagnosticsVersion: number;
	waitForDiagnostics(
		filePath: string,
		timeoutMs?: number,
		options?: { minVersion?: number },
	): Promise<void>;
	/** Get all tracked diagnostics with timestamps (for cascade checking) */
	getAllDiagnostics(): Map<string, { diags: LSPDiagnostic[]; ts: number }>;
	pruneDiagnostics(
		predicate: (
			filePath: string,
			ts: number,
			diags: LSPDiagnostic[],
		) => boolean,
	): number;
	/**
	 * Paths of every file with tracked diagnostics. Lets callers resolve
	 * file existence asynchronously (off the event loop) and then prune with a
	 * synchronous, in-memory predicate — instead of a blocking `existsSync` per
	 * file inside `pruneDiagnostics`.
	 */
	getTrackedDiagnosticPaths(): string[];
	/** Capability snapshot for workspace diagnostics support */
	getWorkspaceDiagnosticsSupport(): LSPWorkspaceDiagnosticsSupport;
	/** Capability snapshot for navigation/edit operations */
	getOperationSupport(): LSPOperationSupport;
	/** Commands the server advertised for workspace/executeCommand (the allowlist) */
	getAdvertisedCommands(): string[];
	/** Top-level keys of the raw ServerCapabilities advertised at initialize —
	 *  the full advertised surface (incl. providers pi-lens does not parse). */
	getRawCapabilityKeys(): string[];
	/**
	 * Run a server command via workspace/executeCommand. Hardened: the command
	 * MUST be in the server's advertised list or this rejects without sending.
	 * Any resulting server-initiated workspace/applyEdit is applied during the
	 * call (and only then).
	 */
	executeCommand(
		command: string,
		args?: unknown[],
	): Promise<{ executed: boolean; result?: unknown; reason?: string }>;
	/** Go to definition — returns Location[] */
	definition(
		filePath: string,
		line: number,
		character: number,
	): Promise<LSPLocation[]>;
	/** Go to the type definition of the symbol at a position */
	typeDefinition(
		filePath: string,
		line: number,
		character: number,
	): Promise<LSPLocation[]>;
	/** Go to the declaration of the symbol at a position */
	declaration(
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
	/** Ask server for edits before a source file rename. */
	willRenameFiles(
		oldFilePath: string,
		newFilePath: string,
	): Promise<LSPWorkspaceEdit | null>;
	/** Notify server after a source file rename. */
	didRenameFiles(oldFilePath: string, newFilePath: string): Promise<void>;
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
	shutdown(options?: LSPShutdownOptions): Promise<void>;
}

// --- Constants ---

const INITIALIZE_TIMEOUT_MS = positiveIntFromEnv(
	"PI_LENS_LSP_INIT_TIMEOUT_MS",
	15_000,
); // 15s — npx downloads are handled by ensureTool, not here

/**
 * The client capabilities advertised in every `initialize`. The textDocument set
 * is intentionally COMPLETE and spec-compliant: servers built on
 * OmniSharp.Extensions.LanguageServer (PowerShell Editor Services, #278)
 * dereference these sub-capabilities while handling `initialize` and throw a
 * NullReferenceException when an expected one is absent, hanging the handshake. A
 * partial textDocument object (the old `synchronization: {didOpen, didChange}` —
 * not even valid TextDocumentSyncClientCapabilities fields) triggered exactly
 * that. Declaring the full set is harmless to other servers (they act only on the
 * requests we actually send), so this is the single, server-agnostic shape.
 * Exported for the regression guard in client-internals tests.
 */
export const CLIENT_CAPABILITIES = {
	general: { positionEncodings: ADVERTISED_POSITION_ENCODINGS },
	window: { workDoneProgress: true },
	workspace: {
		workspaceFolders: true,
		configuration: true,
		didChangeWatchedFiles: { dynamicRegistration: true },
	},
	textDocument: {
		synchronization: {
			dynamicRegistration: false,
			willSave: false,
			willSaveWaitUntil: false,
			didSave: true,
		},
		completion: {
			dynamicRegistration: false,
			completionItem: { snippetSupport: false },
		},
		hover: { dynamicRegistration: false },
		signatureHelp: { dynamicRegistration: false },
		definition: { dynamicRegistration: false },
		typeDefinition: { dynamicRegistration: false },
		implementation: { dynamicRegistration: false },
		references: { dynamicRegistration: false },
		documentSymbol: { dynamicRegistration: false },
		codeAction: { dynamicRegistration: false },
		rename: { dynamicRegistration: false },
		publishDiagnostics: {
			relatedInformation: true,
			versionSupport: true,
		},
	},
} as const;
const NAV_REQUEST_TIMEOUT_MS = positiveIntFromEnv(
	"PI_LENS_LSP_NAV_REQUEST_TIMEOUT_MS",
	10_000,
); // 10s — per-request ceiling; prevents heavy servers (vue, svelte) from hanging
const DIAGNOSTICS_WAIT_TIMEOUT_MS = positiveIntFromEnv(
	"PI_LENS_LSP_DIAGNOSTICS_WAIT_MS",
	10_000,
);
const PULL_DIAGNOSTICS_RETRY_INTERVAL_MS = positiveIntFromEnv(
	"PI_LENS_LSP_PULL_RETRY_INTERVAL_MS",
	250,
);
const SHUTDOWN_REQUEST_TIMEOUT_MS = positiveIntFromEnv(
	"PI_LENS_LSP_SHUTDOWN_TIMEOUT_MS",
	1000,
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
	readonly pushDiagnostics: Map<string, LSPDiagnostic[]>;
	readonly pushDiagnosticTimestamps: Map<string, number>;
	readonly documentPullDiagnostics: Map<string, LSPDiagnostic[]>;
	readonly documentPullDiagnosticTimestamps: Map<string, number>;
	readonly pendingDiagnostics: Map<string, ReturnType<typeof setTimeout>>;
	readonly diagnosticEmitter: EventEmitter;
	diagnosticsVersion: number;
	readonly documentVersions: Map<string, number>;
	/** The LSP document version (`publishDiagnostics.version`) the cached
	 *  diagnostics for a path were computed against. Only set when the server
	 *  reports a version; absent entries mean "version unknown" and are treated
	 *  as fresh so version-less servers keep working. */
	readonly diagnosticDocVersions: Map<string, number>;
	readonly openDocuments: Set<string>;
	readonly pendingOpens: Set<string>;
	/** Mutable: updated by applyDynamicCapabilities after registerCapability events */
	workspaceDiagnosticsSupport: LSPWorkspaceDiagnosticsSupport;
	/** Mutable: upgraded by applyDynamicCapabilities after registerCapability events */
	operationSupport: LSPOperationSupport;
	/** Top-level keys of the raw ServerCapabilities from initialize (sorted) —
	 *  captured once; the full advertised surface for diagnostics/documentation. */
	rawCapabilityKeys?: string[];
	/** Position encoding the server negotiated at initialize (#269). UTF-16 unless
	 *  the server advertised otherwise; drives character-offset translation on
	 *  outgoing navigation requests. */
	positionEncoding: PositionEncoding;
	/** Baseline mode from static initResult — used to revert on unregister */
	staticDiagnosticsMode: "pull" | "push-only";
	/** Live dynamic registrations from client/registerCapability: id → method */
	readonly dynamicRegistrations: Map<string, string>;
	/**
	 * Commands the server advertised it can run via workspace/executeCommand
	 * (initialize `executeCommandProvider.commands` + any dynamically registered
	 * `registerOptions.commands`). Mutable — dynamic registration adds to it.
	 * This is the executeCommand allowlist: only members may be executed.
	 */
	advertisedCommands: Set<string>;
	/**
	 * Gate for server-initiated `workspace/applyEdit`. Bumped only for the
	 * duration of an explicit executeCommand call; outside that window an
	 * unsolicited server applyEdit is refused (a server must not push edits to
	 * disk whenever it likes — only as the direct effect of an opted-in command).
	 */
	serverEditsAllowed: number;
	readonly serverId: string;
	readonly root: string;
	readonly lspProcess: LSPProcess;
	/**
	 * Per-client debounced `workspace/didChangeWatchedFiles` batcher (#271).
	 * Two-phase init (needs `state` for its flush closure) — assigned right after
	 * the state literal, like `workspaceDiagnosticsSupport`.
	 */
	watchQueue: WatchedFilesQueue;
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

export async function killProcessTree(
	proc: {
		kill(signal?: NodeJS.Signals | number): boolean;
		unref?: () => void;
		exitCode?: number | null;
		signalCode?: NodeJS.Signals | null;
	},
	pid: number,
	options: LSPShutdownOptions = {},
): Promise<void> {
	// If our child has already exited, its PID is dead and the OS may have
	// RECYCLED it. The Windows `taskkill /F /T` below force-kills the PID's whole
	// tree, so on a recycled PID it would kill an unrelated process (in the test
	// suite this occasionally nuked a vitest worker fork → "Worker exited
	// unexpectedly" with no fatal dump). There is nothing left for us to kill, and
	// the handle-based proc.kill() below is moot, so return early.
	if (
		(proc.exitCode != null || proc.signalCode != null) &&
		!options.processExiting
	) {
		proc.unref?.();
		return;
	}
	if (process.platform === "win32" && pid > 0) {
		// Host process is exiting (loop already closing): never spawn a child here —
		// the spawn's uv_async_send on the closing loop-wakeup handle hard-aborts
		// (src\win\async.c). Kill the direct child via the handle we already hold
		// (TerminateProcess; synchronous, no async handle). Orphaned grandchildren
		// are reaped by the OS as the host exits.
		if (options.processExiting) {
			try {
				proc.kill();
			} catch {
				// best-effort
			}
			proc.unref?.();
			return;
		}
		try {
			// Absolute path avoids PATH-resolution: SystemRoot is set by Windows itself.
			const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
			const killer = nodeSpawn(taskkill, ["/F", "/T", "/PID", String(pid)], {
				shell: false,
				windowsHide: true,
				stdio: "ignore",
				detached: !!options.fast,
			});
			if (options.fast) {
				killer.unref();
				proc.unref?.();
				return;
			}
			await new Promise<void>((resolve) => {
				killer.once("close", () => resolve());
				killer.once("error", () => resolve());
			});
		} catch {
			// ignore
		}
		return;
	}

	const killPosixProcessGroup = (signal: NodeJS.Signals): boolean => {
		if (pid <= 0) return false;
		try {
			process.kill(-pid, signal);
			return true;
		} catch {
			return false;
		}
	};
	const killDirectChild = (signal: NodeJS.Signals): void => {
		try {
			proc.kill(signal);
		} catch {
			// best-effort
		}
	};

	try {
		if (!killPosixProcessGroup("SIGTERM")) {
			killDirectChild("SIGTERM");
		}
		if (options.fast) {
			const timer = setTimeout(() => {
				if (!(proc as { killed?: boolean }).killed) {
					if (!killPosixProcessGroup("SIGKILL")) {
						killDirectChild("SIGKILL");
					}
				}
			}, 1500);
			timer.unref?.();
			proc.unref?.();
			return;
		}
		// SIGTERM → 1.5s → SIGKILL escalation.
		// SIGTERM alone can leave zombie processes if the server hangs.
		await new Promise<void>((resolve) => setTimeout(resolve, 1500));
		if (!(proc as { killed?: boolean }).killed) {
			if (!killPosixProcessGroup("SIGKILL")) {
				killDirectChild("SIGKILL");
			}
		}
	} catch {
		// ignore
	}
}

export function stripDiagnosticNoiseLines(message: string): string {
	const cleaned = message
		.split(/\r?\n/)
		.filter((line) => {
			const trimmed = line.trim();
			if (/^for further information visit\b/i.test(trimmed)) return false;
			if (/^https?:\/\/\S+$/i.test(trimmed)) return false;
			return true;
		})
		.join("\n")
		.trim();
	return cleaned || message.trim() || message;
}

function normalizeLspDiagnostic(diagnostic: LSPDiagnostic): LSPDiagnostic {
	const message = stripDiagnosticNoiseLines(diagnostic.message);
	return message === diagnostic.message
		? diagnostic
		: { ...diagnostic, message };
}

function normalizeLspDiagnostics(
	diagnostics: LSPDiagnostic[],
): LSPDiagnostic[] {
	return diagnostics.map(normalizeLspDiagnostic);
}

function mergeDiagnosticLists(
	push: LSPDiagnostic[] | undefined,
	pull: LSPDiagnostic[] | undefined,
): LSPDiagnostic[] {
	const merged: LSPDiagnostic[] = [];
	const seen = new Set<string>();
	for (const diagnostic of [...(push ?? []), ...(pull ?? [])]) {
		const key = [
			diagnostic.range.start.line,
			diagnostic.range.start.character,
			diagnostic.range.end.line,
			diagnostic.range.end.character,
			diagnostic.code ?? "",
			diagnostic.source ?? "",
			diagnostic.message,
		].join(":");
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(diagnostic);
	}
	return merged;
}

function getMergedDiagnosticsForPath(
	state: LSPClientState,
	normalizedPath: string,
): LSPDiagnostic[] {
	const legacy = state as unknown as {
		diagnostics?: Map<string, LSPDiagnostic[]>;
	};
	return mergeDiagnosticLists(
		state.pushDiagnostics?.get(normalizedPath) ??
			legacy.diagnostics?.get(normalizedPath),
		state.documentPullDiagnostics?.get(normalizedPath),
	);
}

function clearDiagnosticsForPath(
	state: LSPClientState,
	normalizedPath: string,
): void {
	const legacy = state as unknown as {
		diagnostics?: Map<string, LSPDiagnostic[]>;
		diagnosticTimestamps?: Map<string, number>;
	};
	state.pushDiagnostics?.delete(normalizedPath);
	state.pushDiagnosticTimestamps?.delete(normalizedPath);
	state.documentPullDiagnostics?.delete(normalizedPath);
	state.documentPullDiagnosticTimestamps?.delete(normalizedPath);
	state.diagnosticDocVersions?.delete(normalizedPath);
	legacy.diagnostics?.delete(normalizedPath);
	legacy.diagnosticTimestamps?.delete(normalizedPath);
}

// Methods that can be registered dynamically and map to operationSupport keys
const DYNAMIC_OPERATION_METHOD_MAP: Record<string, keyof LSPOperationSupport> =
	{
		"textDocument/definition": "definition",
		"textDocument/typeDefinition": "typeDefinition",
		"textDocument/declaration": "declaration",
		"textDocument/references": "references",
		"textDocument/hover": "hover",
		"textDocument/signatureHelp": "signatureHelp",
		"textDocument/documentSymbol": "documentSymbol",
		"workspace/symbol": "workspaceSymbol",
		"textDocument/codeAction": "codeAction",
		"textDocument/rename": "rename",
		"textDocument/implementation": "implementation",
		"textDocument/prepareCallHierarchy": "callHierarchy",
	};

export function applyDynamicCapabilities(state: LSPClientState): void {
	const registeredMethods = new Set(state.dynamicRegistrations.values());

	const hasDynamicPull =
		registeredMethods.has("textDocument/diagnostic") ||
		registeredMethods.has("workspace/diagnostic");

	if (hasDynamicPull) {
		state.workspaceDiagnosticsSupport = {
			advertised: true,
			mode: "pull",
			diagnosticProviderKind: "dynamic",
		};
	} else if (
		state.staticDiagnosticsMode === "push-only" &&
		state.workspaceDiagnosticsSupport.diagnosticProviderKind === "dynamic"
	) {
		// Was only dynamically registered, now unregistered — revert to push-only
		state.workspaceDiagnosticsSupport = {
			advertised: false,
			mode: "push-only",
			diagnosticProviderKind: "none",
		};
	}

	for (const [method, key] of Object.entries(DYNAMIC_OPERATION_METHOD_MAP)) {
		if (registeredMethods.has(method)) {
			state.operationSupport[key] = true;
		}
	}
}

function setupIncomingHandlers(
	state: LSPClientState,
	initialization: Record<string, unknown> | undefined,
): void {
	state.connection.onNotification(
		"textDocument/publishDiagnostics",
		(params: { uri: string; diagnostics?: LSPDiagnostic[]; version?: number }) => {
			const filePath = uriToPath(params.uri);
			const normalizedPath = normalizeMapKey(filePath);
			const newDiags = normalizeLspDiagnostics(params.diagnostics || []);
			const docVersion = params.version;
			if (PUB_DEBUG) {
				console.error(
					`[lsp-pub] server=${state.serverId} pubVersion=${docVersion} docVersion=${state.documentVersions?.get(normalizedPath)} diags=${newDiags.length}`,
				);
			}
			const strategy = getStrategy(state.serverId);
			// Record the document version these diagnostics were computed against
			// (when the server reports it) so waitForDiagnostics can reject results
			// that lag behind the latest didChange instead of serving them as fresh.
			const recordDocVersion = (): void => {
				if (docVersion !== undefined) {
					state.diagnosticDocVersions.set(normalizedPath, docVersion);
				}
			};

			// Seed on first push for servers whose first push is known complete.
			// Bypasses the debounce timer entirely — resolves waiting promises immediately.
			if (
				strategy.seedFirstPush &&
				!state.pushDiagnostics.has(normalizedPath)
			) {
				state.pushDiagnostics.set(normalizedPath, newDiags);
				state.pushDiagnosticTimestamps.set(normalizedPath, Date.now());
				recordDocVersion();
				state.diagnosticsVersion += 1;
				state.diagnosticEmitter.emit("diagnostics", normalizedPath);
				return;
			}

			const existingTimer = state.pendingDiagnostics.get(normalizedPath);
			if (existingTimer) clearTimeout(existingTimer);

			const timer = setTimeout(() => {
				state.pushDiagnostics.set(normalizedPath, newDiags);
				state.pushDiagnosticTimestamps.set(normalizedPath, Date.now());
				recordDocVersion();
				state.pendingDiagnostics.delete(normalizedPath);
				state.diagnosticsVersion += 1;
				state.diagnosticEmitter.emit("diagnostics", normalizedPath);
			}, strategy.debounceMs);

			state.pendingDiagnostics.set(normalizedPath, timer);
		},
	);

	state.connection.onRequest("workspace/workspaceFolders", () => [
		{ name: "workspace", uri: pathToFileURL(state.root).href },
	]);
	state.connection.onRequest(
		"client/registerCapability",
		async (params: {
			registrations?: Array<{
				id: string;
				method: string;
				registerOptions?: { commands?: unknown };
			}>;
		}) => {
			for (const reg of params?.registrations ?? []) {
				if (reg.id && reg.method) {
					state.dynamicRegistrations.set(reg.id, reg.method);
				}
				// executeCommand commands can arrive dynamically too — merge them
				// into the allowlist so dynamically-registered commands are runnable.
				if (
					reg.method === "workspace/executeCommand" &&
					Array.isArray(reg.registerOptions?.commands)
				) {
					for (const cmd of reg.registerOptions.commands) {
						if (typeof cmd === "string") state.advertisedCommands.add(cmd);
					}
				}
			}
			applyDynamicCapabilities(state);
		},
	);
	state.connection.onRequest(
		"client/unregisterCapability",
		async (params: { unregisterations?: Array<{ id: string }> }) => {
			for (const unreg of params?.unregisterations ?? []) {
				if (unreg.id) {
					state.dynamicRegistrations.delete(unreg.id);
				}
			}
			applyDynamicCapabilities(state);
		},
	);
	// Server-initiated edits (the mutation vector for executeCommand). Honored
	// ONLY while an explicit executeCommand is in flight (serverEditsAllowed > 0);
	// an unsolicited applyEdit outside that window is refused so a server can't
	// push edits to disk at will. Applied through the same applyWorkspaceEdit path
	// as every other edit.
	state.connection.onRequest(
		"workspace/applyEdit",
		async (params: { edit?: { changes?: unknown; documentChanges?: unknown } }) => {
			if (state.serverEditsAllowed <= 0 || !params?.edit) {
				return { applied: false, failureReason: "edit not solicited" };
			}
			try {
				await applyWorkspaceEdit(
					params.edit as Parameters<typeof applyWorkspaceEdit>[0],
					state.root,
				);
				return { applied: true };
			} catch (err) {
				return {
					applied: false,
					failureReason: err instanceof Error ? err.message : String(err),
				};
			}
		},
	);
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

	state.lspProcess.process.on("exit", (code) => {
		const wasConnected = state.isConnected;
		state.isConnected = false;
		state.isDestroyed = true;
		disposeClientConnection(state);
		if (wasConnected) {
			logLatency({
				type: "phase",
				phase: "lsp_server_unexpected_exit",
				filePath: state.root,
				durationMs: 0,
				metadata: {
					serverId: state.serverId,
					pid: state.lspProcess.pid,
					exitCode: code ?? null,
				},
			});
		}
	});
}

/**
 * Outcome of a pull-diagnostics request. Distinguishes an AFFIRMATIVE answer
 * (the server replied — either `found` with diagnostics or an authoritative
 * empty `clean`) from `unavailable` (dead client / no reply / thrown). #240: a
 * failed pull must NEVER be read as clean — only an authoritative empty report
 * is clean. A bare count conflated the two (0 = clean OR failed).
 */
type PullDiagnosticsOutcome =
	| { status: "found"; count: number }
	| { status: "clean" }
	| { status: "unavailable" };

async function clientRequestPullDiagnostics(
	state: LSPClientState,
	filePath: string,
): Promise<PullDiagnosticsOutcome> {
	if (!isClientAlive(state)) return { status: "unavailable" };
	const uri = pathToFileURL(filePath).href;
	try {
		const report = await safeSendRequest<{
			kind?: string;
			items?: LSPDiagnostic[];
			relatedDocuments?: Record<string, { items?: LSPDiagnostic[] }>;
		}>(state.connection, "textDocument/diagnostic", { textDocument: { uri } });

		if (!report) return { status: "unavailable" };

		const normalizedPath = normalizeMapKey(filePath);
		const primaryItems = normalizeLspDiagnostics(report.items ?? []);
		const now = Date.now();
		state.documentPullDiagnostics.set(normalizedPath, primaryItems);
		state.documentPullDiagnosticTimestamps.set(normalizedPath, now);
		state.diagnosticsVersion += 1;
		let totalCount = primaryItems.length;

		if (report.relatedDocuments) {
			for (const [relatedUri, related] of Object.entries(
				report.relatedDocuments,
			)) {
				const relatedPath = uriToPath(relatedUri);
				const relatedItems = normalizeLspDiagnostics(related?.items ?? []);
				state.documentPullDiagnostics.set(
					normalizeMapKey(relatedPath),
					relatedItems,
				);
				state.documentPullDiagnosticTimestamps.set(
					normalizeMapKey(relatedPath),
					now,
				);
				totalCount += relatedItems.length;
			}
		}

		state.diagnosticEmitter.emit("diagnostics", normalizedPath);
		return totalCount > 0
			? { status: "found", count: totalCount }
			: { status: "clean" };
	} catch {
		return { status: "unavailable" };
	}
}

export async function clientWaitForDiagnostics(
	state: LSPClientState,
	filePath: string,
	timeoutMs: number,
	options: { minVersion?: number } = {},
): Promise<void> {
	const normalizedPath = normalizeMapKey(filePath);
	const minVersion = options.minVersion;
	const hasFreshDiagnostics = (): boolean =>
		minVersion === undefined || state.diagnosticsVersion > minVersion;

	// Version coherence: a cached push is "stale" only when the server reported
	// the document version it computed against AND that version lags the latest
	// didChange we sent. This prevents serving diagnostics from a superseded
	// version as fresh (e.g. once the redundant double-push is collapsed and the
	// dispatch wait runs without a push-counter baseline — #203). Unknown version
	// (server omits it) is treated as current so version-less servers are
	// unaffected, and the timeout remains the backstop.
	const isVersionStale = (): boolean => {
		const cachedVersion = state.diagnosticDocVersions?.get(normalizedPath);
		if (cachedVersion === undefined) return false;
		const currentVersion = state.documentVersions?.get(normalizedPath);
		return currentVersion !== undefined && cachedVersion < currentVersion;
	};

	if (state.workspaceDiagnosticsSupport.mode === "pull") {
		// Pull is authoritative. An AFFIRMATIVE outcome — diagnostics `found`, or
		// an authoritative empty `clean` report — ends the wait. An `unavailable`
		// pull (dead client / no reply / thrown) is NOT clean and must not
		// short-circuit: fall through to the push-wait/timeout backstop. This is
		// the #240 fix — previously the early-return also fired on
		// `hasFreshDiagnostics()`, which is unconditionally true when there is no
		// version baseline (`minVersion === undefined`), so a failed pull returned
		// 0 and was read as a fresh clean.
		let outcome = await clientRequestPullDiagnostics(state, filePath);
		if (outcome.status === "found") return;
		let sawClean = outcome.status === "clean";

		const strategy = getStrategy(state.serverId);
		const retryBudgetMs =
			strategy.pullRetryBudgetMs > 0
				? Math.min(timeoutMs, strategy.pullRetryBudgetMs)
				: 0;
		const startedAt = Date.now();

		// Retry within budget to catch incremental servers whose first pull is
		// empty while analysis is still running (rust-analyzer). A `clean` seen at
		// any point is a valid affirmative answer for this touch.
		while (outcome.status !== "found" && Date.now() - startedAt < retryBudgetMs) {
			await new Promise((resolve) =>
				setTimeout(resolve, PULL_DIAGNOSTICS_RETRY_INTERVAL_MS),
			);
			outcome = await clientRequestPullDiagnostics(state, filePath);
			if (outcome.status === "clean") sawClean = true;
		}
		if (outcome.status === "found" || sawClean) return;
	}

	if (
		hasFreshDiagnostics() &&
		!isVersionStale() &&
		getMergedDiagnosticsForPath(state, normalizedPath).length > 0
	) {
		return;
	}

	return new Promise<void>((resolve) => {
		let debounceTimer: ReturnType<typeof setTimeout> | undefined;

		const onDiagnostics = (fp: string) => {
			if (normalizeMapKey(fp) !== normalizedPath) return;
			if (!hasFreshDiagnostics() || isVersionStale()) return;
			if (debounceTimer) clearTimeout(debounceTimer);

			// Adaptive debounce: use time since last push to compute remaining
			// wait instead of always waiting the full debounce window.
			const strategy = getStrategy(state.serverId);
			const hit = state.pushDiagnosticTimestamps.get(normalizedPath);
			const timeSincePush = hit ? Date.now() - hit : Infinity;
			const remaining = Math.max(0, strategy.debounceMs - timeSincePush);

			debounceTimer = setTimeout(() => {
				state.diagnosticEmitter.off("diagnostics", onDiagnostics);
				clearTimeout(timeout);
				resolve();
			}, remaining);
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
	silent = false,
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
			clearDiagnosticsForPath(state, normalizedPath);
		}
		// Scanners that only re-scan on a fresh open (opengrep ignores didChange):
		// close + reopen so the re-edit actually triggers a re-scan instead of
		// silently publishing nothing.
		if (getStrategy(state.serverId).reopenOnResync) {
			await safeSendNotification(state.connection, "textDocument/didClose", {
				textDocument: { uri },
			});
			state.openDocuments.delete(normalizedPath);
			state.documentVersions.set(normalizedPath, 0);
			if (!isClientAlive(state)) return;
			await safeSendNotification(state.connection, "textDocument/didOpen", {
				textDocument: { uri, languageId, version: 0, text: content },
			});
			state.openDocuments.add(normalizedPath);
			return;
		}
		await safeSendNotification(state.connection, "textDocument/didChange", {
			textDocument: { uri, version },
			contentChanges: [{ text: content }],
		});
		return;
	}

	state.pendingOpens.add(normalizedPath);
	state.documentVersions.set(normalizedPath, 0);
	clearDiagnosticsForPath(state, normalizedPath); // always clear for initial open

	// Send workspace notification first (like opencode does).
	// Skipped in silent mode — cascade reads a file for diagnostics,
	// not reporting a real filesystem change. Avoids N project-wide
	// rechecks on push-diagnostics LSPs (TypeScript, Python) per CR-1.
	if (!silent) {
		// Async existence probe (was a synchronous existsSync on the document-open
		// path — a stat that blocks the loop during first-read/warm). The notify
		// type is unchanged: 2 (Changed) when the file exists on disk, else 1
		// (Created). access() rejects when absent.
		let fileExists = true;
		try {
			await access(filePath);
		} catch {
			fileExists = false;
		}
		// #271: enqueue instead of sending now — the per-client queue coalesces a
		// turn's file opens into a single notification, so push-diagnostics servers
		// re-analyze the project once per burst rather than once per file. didOpen
		// (below) still carries this file's content immediately, so the open
		// document is analyzed without waiting on the batched watcher notify.
		state.watchQueue.enqueue(uri, fileExists ? 2 : 1);
	}

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
	clearDiagnosticsForPath(state, normalizedPath);
	await safeSendNotification(state.connection, "textDocument/didChange", {
		textDocument: { uri, version },
		contentChanges: [{ text: content }],
	});
}

export async function clientShutdown(
	state: LSPClientState,
	options: LSPShutdownOptions = {},
): Promise<void> {
	state.isConnected = false;
	state.isDestroyed = true;
	for (const timer of state.pendingDiagnostics.values()) {
		clearTimeout(timer);
	}
	state.pendingDiagnostics.clear();
	state.pendingOpens.clear();
	state.openDocuments.clear();
	// #271: drop any pending watched-files batch + its timer (a dying client's
	// queued FS changes are moot, and the timer must not outlive the connection).
	state.watchQueue?.cancel();
	state.diagnosticEmitter.removeAllListeners();
	if (!options.fast) {
		try {
			await withTimeout(
				safeSendRequest(state.connection, "shutdown", {}),
				SHUTDOWN_REQUEST_TIMEOUT_MS,
			);
		} catch {
			/* ignore — proceed to exit/kill so shutdown cannot hang the session */
		}
		try {
			await safeSendNotification(state.connection, "exit", {});
		} catch {
			/* ignore */
		}
	}
	disposeClientConnection(state);
	const pid = state.lspProcess.pid;
	// On Windows, killing the direct child first can orphan grandchildren before
	// taskkill can traverse the tree. Kill the full tree first and wait briefly.
	await killProcessTree(state.lspProcess.process, pid, options);
}

/**
 * Translate a caller-supplied (UTF-16) `(line, character)` into the position the
 * server expects under its negotiated encoding (#269). UTF-16 is the identity —
 * the common case pays nothing (no I/O). For UTF-8/UTF-32 we read the target
 * line from disk (pi edits files on disk before navigating, so disk == the
 * server's content) and re-measure the character offset; a read failure falls
 * back to the raw offset rather than dropping the request.
 */
async function toWirePosition(
	state: LSPClientState,
	filePath: string,
	line: number,
	character: number,
): Promise<{ line: number; character: number }> {
	if (state.positionEncoding === "utf-16") return { line, character };
	try {
		const content = await readFile(filePath, "utf8");
		return {
			line,
			character: convertCharacterOffset(
				state.positionEncoding,
				lineTextAt(content, line),
				character,
			),
		};
	} catch {
		return { line, character };
	}
}

// #276: drop a navigation result whose document was edited while the request was
// in flight. Mirrors the diagnostics-path staleness check (isVersionStale) which
// compares the version computed-against to the latest didChange. Default on;
// PI_LENS_LSP_NAV_STALE_DROP=0 disables it if it ever over-drops.
function navStaleDropEnabled(): boolean {
	return process.env.PI_LENS_LSP_NAV_STALE_DROP !== "0";
}

async function navRequest<T>(
	state: LSPClientState,
	method: string,
	params: Record<string, unknown>,
	// When provided, the request is dropped if the document's version advances
	// (an edit landed) between send and response. Omit for non-single-file
	// requests (workspaceSymbol, call-hierarchy follow-ups) that have no version.
	staleCheckPath?: string,
): Promise<T | null | undefined> {
	if (!isClientAlive(state)) return null;
	const normalizedPath =
		staleCheckPath !== undefined ? normalizeMapKey(staleCheckPath) : undefined;
	const requestVersion =
		normalizedPath !== undefined
			? state.documentVersions.get(normalizedPath)
			: undefined;
	const result = (await withTimeout(
		safeSendRequest<T>(state.connection, method, params),
		NAV_REQUEST_TIMEOUT_MS,
	).catch((err: unknown) => {
		if (err instanceof Error && err.message.startsWith("Timeout after")) {
			return undefined;
		}
		throw err;
	})) as T | undefined;
	// requestVersion === undefined (never opened, or version-less) → unaffected,
	// matching the diagnostics path; the request timeout remains the backstop.
	if (
		normalizedPath !== undefined &&
		requestVersion !== undefined &&
		navStaleDropEnabled()
	) {
		const currentVersion = state.documentVersions.get(normalizedPath);
		if (currentVersion !== undefined && currentVersion > requestVersion) {
			return undefined;
		}
	}
	return result;
}

async function resolveCodeActionBestEffort(
	state: LSPClientState,
	action: LSPCodeAction,
): Promise<LSPCodeAction> {
	if (!isClientAlive(state) || action.edit) return action;
	try {
		const resolved = await withTimeout(
			safeSendRequest<LSPCodeAction>(
				state.connection,
				"codeAction/resolve",
				action,
			),
			NAV_REQUEST_TIMEOUT_MS,
		);
		if (!resolved || typeof resolved !== "object") return action;
		return { ...action, ...resolved };
	} catch {
		// codeAction/resolve is optional. Keep the original lightweight action when
		// the server does not support resolve or fails to populate an edit.
		return action;
	}
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

	// Persistent stderr ring buffer — captures last ~100 lines for diagnostics.
	// Used in error messages to show what the server said before dying.
	const stderrRing: string[] = [];
	const MAX_STDERR_LINES = 100;

	const onStderr = (chunk: Buffer | string): void => {
		stderrRing.push(chunk.toString());
		if (stderrRing.length > MAX_STDERR_LINES) stderrRing.shift();
		// Also capture startup stderr for the initialized-failed error path
		if (startupState.stderr.length < 4096) {
			startupState.stderr += chunk.toString();
		}
	};

	const recentStderr = (lines = 10): string =>
		stderrRing.slice(-lines).join("").trim();

	// Pre-request health check — returns error string if process is dead.
	const checkProcessAlive = (): string | undefined => {
		const exited = lspProcess.process.exitCode;
		if (exited !== null) {
			const tail = recentStderr(20);
			return `LSP server ${serverId} exited with code ${exited}${tail ? `. stderr: ${tail}` : ""}`;
		}
		if ((lspProcess.process as { killed?: boolean }).killed) {
			return `LSP server ${serverId} was killed`;
		}
		return undefined;
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

	(lspProcess.stderr as NodeJS.ReadableStream).on("data", onStderr);
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
		// these are filled in after initialize — cast to avoid two-phase init
		workspaceDiagnosticsSupport:
			undefined as unknown as LSPWorkspaceDiagnosticsSupport,
		operationSupport: undefined as unknown as LSPOperationSupport,
		staticDiagnosticsMode: "push-only",
		positionEncoding: "utf-16",
		dynamicRegistrations: new Map(),
		advertisedCommands: new Set(),
		serverEditsAllowed: 0,
		serverId,
		root,
		lspProcess,
		// two-phase: the flush closure needs `state` (below)
		watchQueue: undefined as unknown as WatchedFilesQueue,
	};

	// #271: batch per-file workspace/didChangeWatchedFiles into one notification
	// per debounce window, so an N-file turn re-indexes the server once, not N×.
	state.watchQueue = new WatchedFilesQueue((changes) => {
		if (!isClientAlive(state)) return;
		void safeSendNotification(
			state.connection,
			"workspace/didChangeWatchedFiles",
			{ changes },
		);
	});

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
				capabilities: CLIENT_CAPABILITIES,
				initializationOptions: initialization,
			}),
			initializeTimeoutMs,
		);
	} catch (err) {
		// Hard-kill the hung process so it doesn't become a zombie.
		// SIGTERM alone is unreliable on Windows for cmd.exe/PowerShell trees.
		const pid = lspProcess.pid;
		void killProcessTree(lspProcess.process, pid);
		setTimeout(() => {
			if (!lspProcess.process.killed && process.platform !== "win32") {
				lspProcess.process.kill("SIGKILL");
			}
		}, 2000);
		throw err;
	} finally {
		(lspProcess.stderr as NodeJS.ReadableStream).off("data", onStderr);
	}

	if (initResult === undefined) {
		const compactStderr = startupState.stderr
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 320);
		const reinstallHint =
			serverId === "cpp"
				? "Install clangd (LLVM/clang-tools) and ensure clangd.exe is on PATH."
				: `Try reinstalling: npm install -g ${serverId}-language-server.`;
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
				`The server binary may be missing or crashed immediately. ${reinstallHint} ` +
				`telemetry: ${telemetry}`,
		);
	}

	state.workspaceDiagnosticsSupport =
		detectWorkspaceDiagnosticsSupport(initResult);
	state.operationSupport = detectOperationSupport(initResult);
	state.positionEncoding = negotiatePositionEncoding(
		(initResult as { capabilities?: unknown })?.capabilities,
	);
	state.rawCapabilityKeys = Object.keys(
		(initResult as { capabilities?: Record<string, unknown> })?.capabilities ??
			{},
	).sort((a, b) => a.localeCompare(b));
	for (const cmd of detectExecuteCommands(initResult)) {
		state.advertisedCommands.add(cmd);
	}
	state.staticDiagnosticsMode = state.workspaceDiagnosticsSupport.mode;

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

		/** True if the server process has exited or been killed. */
		processExited: () =>
			lspProcess.process.exitCode !== null ||
			(lspProcess.process as { killed?: boolean }).killed === true,

		/** Last N lines of server stderr for diagnostics. */
		recentStderr: (lines?: number) => recentStderr(lines),

		/** Pre-request health check — returns error string if dead. */
		checkAlive: () => checkProcessAlive(),

		notify: {
			async open(filePath, content, languageId, preserveDiagnostics, silent) {
				return handleNotifyOpen(
					state,
					filePath,
					content,
					languageId,
					preserveDiagnostics,
					silent,
				);
			},
			async change(filePath, content) {
				return handleNotifyChange(state, filePath, content);
			},
		},

		getDiagnostics(filePath) {
			return getMergedDiagnosticsForPath(state, normalizeMapKey(filePath));
		},

		getAllDiagnostics() {
			const result = new Map<string, { diags: LSPDiagnostic[]; ts: number }>();
			const keys = new Set([
				...state.pushDiagnostics.keys(),
				...state.documentPullDiagnostics.keys(),
			]);
			for (const key of keys) {
				result.set(key, {
					diags: getMergedDiagnosticsForPath(state, key),
					ts: Math.max(
						state.pushDiagnosticTimestamps.get(key) ?? 0,
						state.documentPullDiagnosticTimestamps.get(key) ?? 0,
					),
				});
			}
			return result;
		},

		getTrackedDiagnosticPaths() {
			return [
				...new Set([
					...state.pushDiagnostics.keys(),
					...state.documentPullDiagnostics.keys(),
				]),
			];
		},

		pruneDiagnostics(predicate) {
			let removed = 0;
			const keys = new Set([
				...state.pushDiagnostics.keys(),
				...state.documentPullDiagnostics.keys(),
			]);
			for (const key of keys) {
				const diags = getMergedDiagnosticsForPath(state, key);
				const ts = Math.max(
					state.pushDiagnosticTimestamps.get(key) ?? 0,
					state.documentPullDiagnosticTimestamps.get(key) ?? 0,
				);
				if (!predicate(key, ts, diags)) continue;
				clearDiagnosticsForPath(state, key);
				removed++;
			}
			return removed;
		},

		getWorkspaceDiagnosticsSupport() {
			return state.workspaceDiagnosticsSupport;
		},

		getOperationSupport() {
			return state.operationSupport;
		},

		getAdvertisedCommands() {
			return [...state.advertisedCommands];
		},

		getRawCapabilityKeys() {
			return state.rawCapabilityKeys ?? [];
		},

		async executeCommand(command, args) {
			if (!isClientAlive(state)) {
				return { executed: false, reason: "lsp client not alive" };
			}
			// Hardening: allowlist-by-advertisement. Only commands the server
			// itself declared (static or dynamic) may run — no arbitrary strings.
			if (!state.advertisedCommands.has(command)) {
				return {
					executed: false,
					reason: `command "${command}" is not advertised by the ${state.serverId} server`,
				};
			}
			state.serverEditsAllowed += 1;
			try {
				const result = await safeSendRequest<unknown>(
					state.connection,
					"workspace/executeCommand",
					{ command, arguments: args ?? [] },
				);
				return { executed: true, result };
			} finally {
				state.serverEditsAllowed -= 1;
			}
		},

		get diagnosticsVersion() {
			return state.diagnosticsVersion;
		},

		async waitForDiagnostics(
			filePath,
			timeoutMs = DIAGNOSTICS_WAIT_TIMEOUT_MS,
			options,
		) {
			return clientWaitForDiagnostics(state, filePath, timeoutMs, options);
		},

		async definition(filePath, line, character) {
			const result = await navRequest<LSPLocation | LSPLocation[]>(
				state,
				"textDocument/definition",
				{
					textDocument: { uri: pathToFileURL(filePath).href },
					position: await toWirePosition(state, filePath, line, character),
				},
				filePath,
			);
			if (!result) return [];
			return Array.isArray(result) ? result : [result];
		},

		async typeDefinition(filePath, line, character) {
			const result = await navRequest<LSPLocation | LSPLocation[]>(
				state,
				"textDocument/typeDefinition",
				{
					textDocument: { uri: pathToFileURL(filePath).href },
					position: await toWirePosition(state, filePath, line, character),
				},
				filePath,
			);
			if (!result) return [];
			return Array.isArray(result) ? result : [result];
		},

		async declaration(filePath, line, character) {
			const result = await navRequest<LSPLocation | LSPLocation[]>(
				state,
				"textDocument/declaration",
				{
					textDocument: { uri: pathToFileURL(filePath).href },
					position: await toWirePosition(state, filePath, line, character),
				},
				filePath,
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
					position: await toWirePosition(state, filePath, line, character),
					context: { includeDeclaration },
				},
				filePath,
			);
			return result ?? [];
		},

		async hover(filePath, line, character) {
			const result = await navRequest<LSPHover>(
				state,
				"textDocument/hover",
				{
					textDocument: { uri: pathToFileURL(filePath).href },
					position: await toWirePosition(state, filePath, line, character),
				},
				filePath,
			);
			return result ?? null;
		},

		async signatureHelp(filePath, line, character) {
			const result = await navRequest<LSPSignatureHelp>(
				state,
				"textDocument/signatureHelp",
				{
					textDocument: { uri: pathToFileURL(filePath).href },
					position: await toWirePosition(state, filePath, line, character),
				},
				filePath,
			);
			return result ?? null;
		},

		async documentSymbol(filePath) {
			const result = await navRequest<LSPSymbol[]>(
				state,
				"textDocument/documentSymbol",
				{ textDocument: { uri: pathToFileURL(filePath).href } },
				filePath,
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
						start: await toWirePosition(state, filePath, line, character),
						end: await toWirePosition(state, filePath, endLine, endCharacter),
					},
					context: {
						diagnostics: getMergedDiagnosticsForPath(
							state,
							normalizeMapKey(filePath),
						),
					},
				},
			);
			if (!result || !Array.isArray(result)) return [];
			const actions = result.filter(
				(item): item is LSPCodeAction =>
					typeof item === "object" && item !== null && "title" in item,
			);
			return Promise.all(
				actions.map((action) => resolveCodeActionBestEffort(state, action)),
			);
		},

		async rename(filePath, line, character, newName) {
			const result = await navRequest<LSPWorkspaceEdit>(
				state,
				"textDocument/rename",
				{
					textDocument: { uri: pathToFileURL(filePath).href },
					position: await toWirePosition(state, filePath, line, character),
					newName,
				},
				filePath,
			);
			return result ?? null;
		},

		async willRenameFiles(oldFilePath, newFilePath) {
			const result = await navRequest<LSPWorkspaceEdit>(
				state,
				"workspace/willRenameFiles",
				{
					files: [
						{
							oldUri: pathToFileURL(oldFilePath).href,
							newUri: pathToFileURL(newFilePath).href,
						},
					],
				},
			);
			return result ?? null;
		},

		async didRenameFiles(oldFilePath, newFilePath) {
			if (!isClientAlive(state)) return;
			await safeSendNotification(state.connection, "workspace/didRenameFiles", {
				files: [
					{
						oldUri: pathToFileURL(oldFilePath).href,
						newUri: pathToFileURL(newFilePath).href,
					},
				],
			});
		},

		async implementation(filePath, line, character) {
			const result = await navRequest<LSPLocation | LSPLocation[]>(
				state,
				"textDocument/implementation",
				{
					textDocument: { uri: pathToFileURL(filePath).href },
					position: await toWirePosition(state, filePath, line, character),
				},
				filePath,
			);
			if (!result) return [];
			return Array.isArray(result) ? result : [result];
		},

		async prepareCallHierarchy(filePath, line, character) {
			const result = await navRequest<
				LSPCallHierarchyItem | LSPCallHierarchyItem[]
			>(
				state,
				"textDocument/prepareCallHierarchy",
				{
					textDocument: { uri: pathToFileURL(filePath).href },
					position: await toWirePosition(state, filePath, line, character),
				},
				filePath,
			);
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

		async shutdown(options?: LSPShutdownOptions) {
			return clientShutdown(state, options);
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
	let timeout: ReturnType<typeof setTimeout> | undefined;
	// Suppress unhandled rejection if `promise` rejects AFTER the timeout
	// wins the race — Promise.race settles on the first result but the
	// losing promises still run, and any later rejection would be uncaught.
	promise.catch(() => {});
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error(`Timeout after ${timeoutMs}ms`)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
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

function detectExecuteCommands(initResult: unknown): string[] {
	const capabilities =
		typeof initResult === "object" && initResult !== null
			? (initResult as { capabilities?: Record<string, unknown> }).capabilities
			: undefined;
	const provider = capabilities?.executeCommandProvider;
	if (typeof provider !== "object" || provider === null) return [];
	const commands = (provider as { commands?: unknown }).commands;
	if (!Array.isArray(commands)) return [];
	return commands.filter((cmd): cmd is string => typeof cmd === "string");
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
		typeDefinition: hasProvider("typeDefinitionProvider"),
		declaration: hasProvider("declarationProvider"),
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
