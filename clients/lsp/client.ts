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
import { access, lstat, readFile } from "node:fs/promises";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { emitBounded } from "../bounded-telemetry.js";
import { withTimeout } from "../deadline-utils.js";
import { minimatch } from "../deps/minimatch.js";
import {
	incrementDegradationCount,
	recordDegradationOnce,
} from "../degradation-ledger.js";
import type { MessageConnection } from "../deps/vscode-jsonrpc.js";
// vscode-jsonrpc v9 ships an `exports` map exposing the Node entry as the
// `./node` subpath (no `.js`); the old `/node.js` file path no longer resolves.
import {
	CancellationTokenSource,
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "../deps/vscode-jsonrpc.js";
import { logExtension } from "../extension-log.js";
import { recordLspChild, removeLspChild } from "../instance-registry.js";
import { workspaceDiagnosticsCacheSessionStart } from "./workspace-diagnostics-session.js";
import { logLatency } from "../latency-logger.js";
import {
	type LspMutationContext,
	newLspMutationCorrelationId,
} from "../lsp-mutation.js";
import { getProcessSingleton } from "../process-singletons.js";
import { getAmbientAbortSignal } from "../safe-spawn.js";
import { raceToCompletion } from "./aggregation.js";
import {
	hashDiagnosticContent,
	type StoredDiagnosticBinding,
} from "./diagnostic-binding.js";
import { applyWorkspaceEdit, normalizeWorkspaceEditToUtf16 } from "./edits.js";
import type { LSPProcess } from "./launch.js";
import { normalizeMapKey, uriToPath } from "./path-utils.js";
import {
	ADVERTISED_POSITION_ENCODINGS,
	convertCharacterOffset,
	lineTextAt,
	negotiatePositionEncoding,
	type PositionEncoding,
} from "./position-encoding.js";
import {
	negotiateSyncKind,
	TEXT_DOCUMENT_SYNC_KIND_FULL,
	TEXT_DOCUMENT_SYNC_KIND_INCREMENTAL,
	type TextDocumentSyncKind,
} from "./sync-kind.js";
import { probeTsserverProjectIdentity } from "./tsserver-sync.js";
import { getStrategy } from "./wait-policy/index.js";
import { WatchedFilesQueue } from "./watch-queue.js";
import {
	clearAllWorkspaceDiagnosticsCaches,
	clearWorkspaceDiagnosticsCacheAtAndAbove,
} from "./workspace-diagnostics-cache.js";

// Opt-in publishDiagnostics trace (PILENS_PUB_DEBUG=1) — read once, negligible
// hot-path cost. Surfaces each server's publish behavior (version + count) to
// diagnose the clean-file affirmative-signal question (#240): which servers
// publish an empty-with-version set on a clean scan vs go silent.
const PUB_DEBUG = Boolean(process.env.PILENS_PUB_DEBUG);

/**
 * #472/#449: extract a per-spawn-unique "marker" from an LSP server's resolved
 * args, for the instance registry's command-line re-identification fallback
 * (used when a recorded child's pid is dead/recycled but its process tree
 * grandchild — e.g. ast-grep's native exe behind a dead node wrapper — is
 * still alive under a different pid).
 *
 * Generalized, NOT ast-grep-specific (uniformity requirement — no per-server
 * special casing): the value immediately following a `--config`/`-c` flag, if
 * that value looks like a path under a temp directory (`os.tmpdir()`). This
 * covers ast-grep's `lsp --config <tmp sgconfig path>` (clients/sgconfig.ts)
 * today, and any other server later launched with a temp-file `--config`/`-c`
 * argument, without new server-specific code.
 */
function extractSpawnMarker(
	args: readonly string[] | undefined,
): string | undefined {
	if (!args) return undefined;
	const tmpDir = os.tmpdir();
	for (let i = 0; i < args.length - 1; i++) {
		const flag = args[i];
		if (flag === "--config" || flag === "-c") {
			const value = args[i + 1];
			if (value?.startsWith(tmpDir)) return value;
		}
	}
	return undefined;
}

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

export interface LSPPullFailure {
	timestamp: number;
	method: "textDocument/diagnostic" | "workspace/diagnostic";
	code?: number | string;
	message: string;
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
	/**
	 * The server advertises `workspace/diagnostic` (a single project-wide pull),
	 * distinct from `mode: "pull"` which only reflects per-document
	 * `textDocument/diagnostic` support.
	 */
	workspaceDiagnostics: boolean;
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
	/**
	 * Human-readable label identifying why this shutdown was triggered — e.g.
	 * `"session_start"`, `"idle"`, `"session_shutdown"`, `"pipeline_crash"`.
	 * Written to latency.log as `lsp_service_reset.metadata.reason` so the death
	 * side of the LSP lifecycle is distinguishable from the birth side.
	 */
	reason?: string;
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
	/** `codeActionProvider.resolveProvider === true` at initialize. */
	codeActionResolve: boolean;
	rename: boolean;
	/** `workspace.fileOperations.willRename` registration options at initialize. */
	willRenameFiles: boolean;
	/** #1971: `workspace.fileOperations.didRename` registration options at initialize. */
	didRenameFiles: boolean;
	implementation: boolean;
	callHierarchy: boolean;
}

export interface LSPSymbol {
	name: string;
	kind: number;
	containerName?: string;
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
	/** Session cwd, distinct from the language-server project root. */
	sessionCwd?: string;
	connection: MessageConnection;
	/** Check if the connection is still alive */
	isAlive: () => boolean;
	/** True if the server process has exited or been killed */
	processExited: () => boolean;
	/**
	 * #1127: true only when THIS client's own `shutdown()` was called before
	 * it went dead (session teardown, `#743` notify-backpressure eviction,
	 * generation resets, …). False for a genuine crash — process exit/signal
	 * with no preceding `shutdown()` call — so a caller respawning a dead
	 * client can tell a deliberate kill apart from an unexpected runtime exit
	 * and only count the latter toward the failure breaker.
	 */
	wasShutdownIntentional: () => boolean;
	/**
	 * #1127: wall-clock time this client FIRST observed its own death
	 * (connection close/error or process exit, whichever fires first), or
	 * `undefined` if it hasn't died yet. A caller computing server lifetime
	 * MUST use this, not the time it happened to notice the client was dead —
	 * detection is lazy (the next file attach) and can trail the actual death
	 * by minutes to hours (#1127's documented opengrep pattern), which would
	 * make every early crash look like a long, healthy run.
	 */
	getExitedAt: () => number | undefined;
	/** Last N lines of server stderr for diagnostics */
	recentStderr: (lines?: number) => string;
	/** Bounded operational pull failures; unsupported-method errors are omitted. */
	getPullFailureHistory?: () => LSPPullFailure[];
	/** Pre-request health check — returns error string if process is dead */
	checkAlive: () => string | undefined;
	/**
	 * #1277: cheap request round-trip proving the server is actually
	 * responding, not merely that the process/connection hasn't died.
	 * `isAlive()`/`checkAlive()` can't tell a wedged server (accepted the
	 * notify write, then stopped answering) from a healthy one — this sends a
	 * bounded real request and reports whether anything came back in time.
	 * Optional so existing test/mock clients (pre-#1277) that don't implement
	 * it don't need updating; callers treat a missing implementation as alive
	 * (`pingLiveness?.() ?? true`), matching the codebase's existing optional-
	 * capability-accessor pattern (`getRawCapabilityKeys`, `getLaunchVariant`).
	 */
	pingLiveness?: (timeoutMs?: number) => Promise<boolean>;
	/**
	 * #2358: the OS pid of the server's live process tree (the direct child;
	 * on Windows a `cmd`/`.cmd` shim's pid, whose real descendant does the
	 * work). The notify-stall breaker's liveness discriminator samples this
	 * pid's CPU to tell a busy server from a dead input path before tearing it
	 * down. Optional because test/mock clients model no real process — a
	 * client without it keeps the pre-#2358 demote-at-budget behavior.
	 */
	getProcessPid?: () => number | undefined;
	notify: {
		open(
			filePath: string,
			content: string,
			languageId: string,
			preserveDiagnostics?: boolean,
			silent?: boolean,
		): Promise<void>;
		change(filePath: string, content: string): Promise<void>;
		/**
		 * #1668: queue a `workspace/didChangeWatchedFiles` entry for a disk
		 * change this client did not learn about through didOpen/didChange —
		 * an external bash write/delete outside the open-document sync path.
		 * `type` is the LSP `FileChangeType` (1 Created, 2 Changed, 3 Deleted).
		 * Routes through the same #271 debounced queue as a first-time open, so
		 * a burst of external changes still flushes as one notification.
		 */
		watchedFileChange(filePath: string, type: number): void;
	};
	getDiagnostics(filePath: string): LSPDiagnostic[];
	/**
	 * #1095: the stored content binding for the diagnostics currently tracked
	 * for `filePath` — {version?, contentHash?} of the document version those
	 * diagnostics were computed against. `undefined` when nothing is tracked or
	 * the server never reported a version (a version-less server → caller treats
	 * the binding as "unknown", i.e. pre-#1095 behavior).
	 */
	getDiagnosticBinding(filePath: string): StoredDiagnosticBinding | undefined;
	/** Monotonic counter bumped when fresh diagnostics are stored for this client.
	 *  Client-GLOBAL: any path's publication advances it, so it cannot answer
	 *  "did this server report on file X?" — use `getDiagnosticsVersionForPath`. */
	readonly diagnosticsVersion: number;
	/**
	 * #1531: the value `diagnosticsVersion` held when diagnostics were last stored
	 * for `filePath` — 0 when this client has stored none. Compare a baseline read
	 * before a notify against a later read to prove a publication landed for THAT
	 * file, rather than for an unrelated one on the same client. REQUIRED: an
	 * optional accessor let a double silently fall back to the global counter,
	 * which is the very defect this closes — every client, real or test, answers
	 * per path.
	 */
	getDiagnosticsVersionForPath(filePath: string): number;
	waitForDiagnostics(
		filePath: string,
		timeoutMs?: number,
		options?: {
			minVersion?: number;
			pullOnly?: boolean;
			/** #1639: distinguishes a genuine content-collecting settle from a
			 *  warm-up-only touch (`ensureWarmForSweep`'s readiness probe, which
			 *  runs a real pull round trip but never wants the diagnostics
			 *  content). Both are legitimate `lsp_typescript_diagnostic_sequence`
			 *  observations for the same file, often seconds or milliseconds
			 *  apart — tagging the source keeps them distinguishable instead of
			 *  reading as duplicates. Defaults to "pull". */
			pullSettleSource?: "pull" | "pull-warmup";
		},
	): Promise<void>;
	/** Get all tracked diagnostics with timestamps (for cascade checking). #1095:
	 *  each entry also carries the stored content `binding` (absent when no
	 *  version-bearing publish set it). */
	getAllDiagnostics(): Map<
		string,
		{ diags: LSPDiagnostic[]; ts: number; binding?: StoredDiagnosticBinding }
	>;
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
	/**
	 * Issue one project-wide `workspace/diagnostic` pull. Resolves per-file
	 * reports, or `undefined` when unsupported/dead/timed-out/malformed.
	 */
	requestWorkspaceDiagnostics(budgetMs: number): Promise<
		| Array<{
				filePath: string;
				diagnostics: LSPDiagnostic[];
				/** #1104: sha256 of the file bytes active at the moment this pull's
				 *  answer for `filePath` was resolved — present for a "full" report
				 *  (fresh read) or inherited from the prior pull for an "unchanged"
				 *  one; absent only when the file could not be read. */
				contentHash?: string;
		  }>
		| undefined
	>;
	/** Capability snapshot for navigation/edit operations */
	getOperationSupport(): LSPOperationSupport;
	/** File-operation registrations rejected during initialize parsing. */
	getMalformedFileOperationRegistrations(): ReadonlySet<
		"willRename" | "didRename"
	>;
	/** Commands the server advertised for workspace/executeCommand (the allowlist) */
	getAdvertisedCommands(): string[];
	/** Top-level keys of the raw ServerCapabilities advertised at initialize —
	 *  the full advertised surface (incl. providers pi-lens does not parse). */
	getRawCapabilityKeys(): string[];
	/** See `LSPServerInfo.spawn`'s `launchVariant` (server.ts) — which concrete
	 *  binary/protocol variant this client instance is actually running.
	 *  Undefined = single-variant server or not yet reported (fail-safe:
	 *  consumers must treat that as classic/default behavior). */
	getLaunchVariant(): "classic" | "native-ts7" | undefined;
	/**
	 * Run a server command via workspace/executeCommand. Hardened: the command
	 * MUST be in the server's advertised list or this rejects without sending.
	 * Any resulting server-initiated workspace/applyEdit is applied during the
	 * call (and only then).
	 */
	executeCommand(
		command: string,
		args?: unknown[],
		mutationContext?: LspMutationContext,
	): Promise<{ executed: boolean; result?: unknown; reason?: string }>;
	/**
	 * #1412/#1640: read-only sibling of `executeCommand` for identity and
	 * telemetry probes. Same allowlist-by-advertisement hardening, but it never
	 * touches `serverEditsAllowed` / `activeMutationContext` — so a probe firing
	 * mid-flight cannot wipe a concurrent real command's mutation context, and
	 * cannot itself open the `workspace/applyEdit` acceptance window. Carries the
	 * short probe timeout, not the generous mutation backstop.
	 */
	executeReadOnlyCommand(
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
	/** Whether this exact document has already been opened on the server. */
	isDocumentOpen(filePath: string): boolean;
	/** Whether this client currently has an LSP request in flight. */
	isBusy?(): boolean;
	/** URI spelling used when this document was opened. */
	getDocumentUri(filePath: string): string | undefined;
	/** Close an open document, if present, without opening or spawning anything. */
	closeDocument(filePath: string): Promise<void>;
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
	didRenameFiles(
		oldFilePath: string,
		newFilePath: string,
		oldUri?: string,
		newUri?: string,
	): Promise<void>;
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

/**
 * One document-notification queue entry. A queued entry has not started its
 * transport write yet, so replacing it cannot leave the server with a partial
 * protocol message. Once `run` starts, the entry is never replaced; a newer
 * document state waits behind it and supersedes only the still-pending entry.
 */
interface PendingDocumentNotify {
	run: (coalescedCount: number) => Promise<void>;
	waiters: Array<{
		resolve: () => void;
		reject: (error: unknown) => void;
	}>;
	coalescedCount: number;
}

/**
 * Per-file queue state. The map itself is per LSP client, so the key pair is
 * effectively (client, normalized path). Different files retain independent
 * queues and therefore retain the existing parallel-send behavior.
 */
interface DocumentNotifyQueue {
	pending?: PendingDocumentNotify;
	running: boolean;
}

// --- Constants ---

export const INITIALIZE_TIMEOUT_MS = positiveIntFromEnv(
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
	// #974: workDoneProgress is intentionally NOT advertised. pi-lens never
	// consumes `$/progress` notifications (grepped: zero listeners anywhere in
	// clients/), so declaring the capability only invites servers to open
	// progress tokens pi-lens will silently ignore — and opengrep's
	// `--experimental` LSP mode crash-loops when it can't parse our
	// spec-correct `{"result": null}` reply to its
	// `window/workDoneProgress/create` request. "Only advertise what you
	// implement" — the `window/workDoneProgress/create` handler below stays as
	// a defensive no-op in case a server ignores capabilities and asks anyway.
	window: {},
	workspace: {
		workspaceFolders: true,
		configuration: true,
		didChangeWatchedFiles: { dynamicRegistration: true },
		fileOperations: {
			dynamicRegistration: false,
			willRename: true,
			didRename: true,
		},
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
		codeAction: {
			dynamicRegistration: false,
			dataSupport: true,
			resolveSupport: { properties: ["edit", "command"] },
			// #1971 review: without literal support, LSP 3.17 constrains
			// textDocument/codeAction responses to Command[] — resolve of an edit
			// would then be protocol-invalid. We parse CodeAction objects.
			codeActionLiteralSupport: {
				codeActionKind: {
					valueSet: [
						"quickfix",
						"refactor",
						"refactor.extract",
						"refactor.inline",
						"refactor.rewrite",
						"source",
						"source.organizeImports",
					],
				},
			},
		},
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
// Per-request ceiling for pull diagnostics (textDocument/diagnostic), mirroring
// NAV_REQUEST_TIMEOUT_MS. safeSendRequest only settles on a reply or a *destroyed*
// stream, so a pull-mode server that is alive but hung (accepts the request, never
// replies) would await forever — hanging clientWaitForDiagnostics and, upstream,
// the diagnostics flush. On timeout the request is treated as `unavailable`, which
// (per #240) is NOT read as clean and falls through to the bounded push backstop.
const PULL_REQUEST_TIMEOUT_MS = positiveIntFromEnv(
	"PI_LENS_LSP_PULL_REQUEST_TIMEOUT_MS",
	10_000,
);
// #1773: the smallest budget this codebase treats as usable — dispatching
// BELOW it is not a real attempt. The old clamp (`Math.max(1, ...)`) let an
// exhausted `budgetMs` (0 or negative) through as a 1ms pull — sent, timed
// out by construction, and recorded as a genuine `lsp_pull_diagnostic_timeout`
// with a fabricated `effectiveBudgetMs: 1` (observed live: both pull-timeout
// records in the 2026-08-20 plegma dogfood session carried exactly that).
// 5ms sits below the smallest budget this codebase's own regression fixtures
// already treat as a real dispatch (`tests/clients/lsp/pull-diagnostic-
// timeout-telemetry.test.ts` exercises 20ms and 30ms as genuinely-attempted-
// then-timed-out) and above the 1-4ms band that is indistinguishable from
// "already exhausted" — a local stdio server round trip (write + compute +
// parse) needs more than a handful of milliseconds even on the fast path.
// `budgetMs === PULL_MIN_USABLE_BUDGET_MS` dispatches (the comparison below
// is strict `<`), so the name reads literally: this is the floor value that
// still gets a real attempt.
const PULL_MIN_USABLE_BUDGET_MS = 5;
const SHUTDOWN_REQUEST_TIMEOUT_MS = positiveIntFromEnv(
	"PI_LENS_LSP_SHUTDOWN_TIMEOUT_MS",
	1000,
);
// #1620: the `exit` NOTIFICATION needs its own ceiling, for the same reason the
// `shutdown` REQUEST has one. A notification write on a pipe that is not
// draining neither resolves nor rejects, so `safeSendNotification`'s catch never
// runs and the await is unbounded. The #1459 wedged-write breaker calls this
// teardown precisely when that stdin has already been PROVEN wedged, so the
// unbounded await was the whole mechanism of the leak. Kept equal to the request
// budget: a healthy server still gets a brief graceful window before the kill.
const EXIT_NOTIFY_TIMEOUT_MS = positiveIntFromEnv(
	"PI_LENS_LSP_EXIT_NOTIFY_TIMEOUT_MS",
	1000,
);
// #1277: cheap liveness round-trip for the silent-clean gates (`index.ts`).
// Those gates convert a diagnostics-wait timeout into a confirmed-clean
// result from a STATIC capability classification (`silentOnClean`) alone —
// but a wedged server (accepted the notify write, then hung) satisfies that
// classification identically to a genuinely clean one. This is deliberately
// short relative to NAV_REQUEST_TIMEOUT_MS: it only needs to prove the
// connection round-trips SOMETHING before the touch reports clean, not
// complete a real navigation request.
const LIVENESS_PING_TIMEOUT_MS = positiveIntFromEnv(
	"PI_LENS_LSP_LIVENESS_PING_TIMEOUT_MS",
	300,
);
// Distinctive, unlikely-to-collide query string — the response content is
// never inspected, only whether one arrived before the timeout.
const LIVENESS_PING_QUERY = "__pi_lens_liveness_ping__";
// #1104: bound on `state.workspacePullResultCache` — one entry per distinct
// file the server has ever returned a `resultId` for across this client's
// lifetime. A full clear on overflow (rather than an LRU) is fine, same
// reasoning as `DISK_BINDING_MEMO_MAX` in diagnostic-binding.ts: each entry is
// cheaply rebuilt by the next full pull, the worst case is just one extra full
// (non-`unchanged`) report per affected file.
const WORKSPACE_PULL_RESULT_CACHE_MAX = 4096;
// #1713: `workspace/diagnostic` has no per-file/per-identifier request to key
// telemetry identity on — it is one project-wide pull — so timeout/late-answer
// records use this fixed subject/scope instead of a real path.
const WORKSPACE_PULL_SCOPE = "*workspace*";
// #1669 review N2: cap on simultaneous re-pulls the `workspace/diagnostic/
// refresh` handler fires for open documents. A workspace with hundreds of
// open documents fanning out one `textDocument/diagnostic` request each,
// with no cap, floods the server the refresh itself just told us is under
// load. Small and fixed — this is a background improvement after the
// protocol reply, never something worth tuning per project.
const REFRESH_REPULL_CONCURRENCY = 4;

/** Run `mapper` over `items` with at most `concurrency` in flight at once.
 *  Same shape as `dependency-checker.ts`'s helper of the same name — a
 *  worker-pool pattern repeated per-file by design in this codebase rather
 *  than shared, so each caller can keep it un-exported and file-local. */
async function mapWithConcurrency<T>(
	items: readonly T[],
	concurrency: number,
	mapper: (item: T) => Promise<void>,
): Promise<void> {
	if (items.length === 0) return;
	let nextIndex = 0;
	const workerCount = Math.max(1, Math.min(concurrency, items.length));
	const worker = async (): Promise<void> => {
		while (true) {
			const index = nextIndex++;
			if (index >= items.length) return;
			await mapper(items[index]);
		}
	};
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
// Anti-deadlock backstop for workspace/executeCommand. Deliberately generous
// (30s): the command is mutating and legitimately long-running (a real server
// refactor / organize-imports), so this must not truncate valid work — it only
// stops a hung server from blocking the caller forever. On timeout the command
// may still be applying server-side; we surface that rather than pretend it ran.
const EXECUTE_COMMAND_TIMEOUT_MS = positiveIntFromEnv(
	"PI_LENS_LSP_EXECUTE_COMMAND_TIMEOUT_MS",
	30_000,
);
// #1412 H1: short ceiling for the read-only tsserver project-identity probe.
// This is a telemetry sample, not a mutation — it must never hold the door
// open for anything close to EXECUTE_COMMAND_TIMEOUT_MS.
const PROBE_COMMAND_TIMEOUT_MS = positiveIntFromEnv(
	"PI_LENS_LSP_PROJECT_IDENTITY_PROBE_TIMEOUT_MS",
	2_500,
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

/**
 * #1667: one live `client/registerCapability` entry, with the fields of
 * `registerOptions` this client actually acts on.
 *
 * The map used to store the method name alone. That silently discarded
 * `identifier` — the diagnostic SOURCE a `textDocument/diagnostic` registration
 * speaks for. Roslyn registers "syntax", "semantic" and "analyzers" as separate
 * sources; vtsls does the same. With the identifier gone the pull path issued
 * one bare request and every other source's findings were never asked for.
 * `workspaceDiagnostics` was discarded the same way, so workspace-pull support
 * had to be guessed from the method name.
 */
export interface DynamicRegistration {
	readonly method: string;
	/** `registerOptions.identifier`. Absent = the server's default/bare source. */
	readonly identifier?: string;
	/** `registerOptions.workspaceDiagnostics` — whether THIS registration also
	 *  serves a workspace-wide pull. Absent = the server did not say. */
	readonly workspaceDiagnostics?: boolean;
	/** `registerOptions.commands` for a `workspace/executeCommand` registration. */
	readonly commands?: readonly string[];
}

export interface LSPClientState {
	isConnected: boolean;
	isDestroyed: boolean;
	/** Set only by clientShutdown() — distinguishes an intentional kill from a
	 *  genuine crash so the exit handler below logs the latter even when the
	 *  JSON-RPC connection's onClose/onError already flipped isConnected false
	 *  before the process 'exit' event fires (the ordering that previously
	 *  made every crash silently look "expected"). */
	shutdownRequested: boolean;
	/**
	 * #1620 residual 3: set on the FIRST `clientShutdown()` call and awaited
	 * by every subsequent one on the same state whose options are no MORE
	 * aggressive than these (see `shutdownOptions` and
	 * `isAtLeastAsAggressiveShutdown`), instead of each caller re-running the
	 * RPC handshake and emitting its own `lsp_client_shutdown` record. Two of
	 * the 8 call sites can race the same client (e.g. a ceiling eviction and
	 * a #1459 notify-stall demotion) — the individual teardown steps are
	 * idempotent, but a duplicated record inflates any
	 * `shutdownOutcome: "forced"` count read from the log. `undefined` until
	 * the first call.
	 *
	 * #1620 residual review F1: a call whose options ARE more aggressive
	 * (e.g. a `fast`+`processExiting` session-exit reset racing a graceful
	 * eviction teardown that is still mid-handshake) does NOT dedupe onto
	 * this promise — that in-flight teardown may still spawn `taskkill` and
	 * await its close event, which is exactly what `processExiting` exists
	 * to forbid during a closing event loop. It starts (and stores) its own
	 * teardown instead; see `clientShutdown`.
	 */
	shutdownPromise: Promise<void> | undefined;
	/** #1620 residual review F1: the options the current `shutdownPromise`
	 *  was started with — compared against a new call's options to decide
	 *  dedupe vs. escalate. `undefined` exactly when `shutdownPromise` is. */
	shutdownOptions: LSPShutdownOptions | undefined;
	/**
	 * #1127: wall-clock time the client FIRST observed its own death (whichever
	 * of connection close/error or the process 'exit' event fires first — see
	 * `setupConnectionLifecycle`). Detection of a dead client happens lazily,
	 * on the next `getClientForFile` attach — which, per #1127's real-world
	 * pattern, can be minutes to hours after the process actually died. A
	 * caller computing "how long did this server live" MUST use
	 * `exitedAt - spawnedAt`, never `detectionTime - spawnedAt`: the latter
	 * conflates "dead quickly" with "attached to rarely" and would wrongly
	 * exempt an early-crashing server from the runtime-exit breaker just
	 * because nobody happened to touch it again for a while. `undefined`
	 * until the client actually dies.
	 */
	exitedAt: number | undefined;
	connectionDisposed: boolean;
	lastError: Error | undefined;
	readonly connection: MessageConnection;
	readonly pushDiagnostics: Map<string, LSPDiagnostic[]>;
	readonly pushDiagnosticTimestamps: Map<string, number>;
	readonly documentPullDiagnostics: Map<string, LSPDiagnostic[]>;
	readonly documentPullDiagnosticTimestamps: Map<string, number>;
	/** Most recent operational pull failures, capped to avoid unbounded telemetry. */
	readonly pullFailureHistory: LSPPullFailure[];
	readonly pendingDiagnostics: Map<string, ReturnType<typeof setTimeout>>;
	/** Receive sequence and didOpen epoch used only for bounded TypeScript
	 * diagnostic-publication telemetry. Plain Maps keyed by the already
	 * normalized document path: every access site passes `normalizedPath`, and
	 * a PathKeyedMap here would re-run the uncached realpath normalizer on the
	 * hot JSON-RPC receive path (~60µs/call) for a value only telemetry reads. */
	readonly diagnosticPublicationCounts: Map<string, number>;
	readonly documentOpenedAt: Map<string, number>;
	readonly diagnosticEmitter: EventEmitter;
	diagnosticsVersion: number;
	/** #1531: the value `diagnosticsVersion` had when fresh diagnostics were last
	 *  STORED for each path. It records the global counter's value rather than a
	 *  private per-path sequence, so the numbers stay globally monotonic: a
	 *  baseline captured for path A remains comparable even after A's entry is
	 *  evicted, while a publication for path B never moves A's stamp. That is what
	 *  lets the auxiliary evidence check ask "did this aux publish for THIS file?"
	 *  instead of "did anything at all land on this client?". Written in lockstep
	 *  with `pushDiagnostics`/`documentPullDiagnostics`, cleared by
	 *  `clearDiagnosticsForPath`. A plain Map keyed by the already normalized path
	 *  for the same hot-receive-path reason as `diagnosticPublicationCounts`
	 *  above; readers fold their input through `normalizeMapKey`. */
	readonly diagnosticsVersionsByPath: Map<string, number>;
	readonly documentVersions: Map<string, number>;
	/** #2113/#2357: latest-pending same-path document sends; different paths stay parallel. */
	readonly notifyChangeQueues: Map<string, DocumentNotifyQueue>;
	/** The LSP document version (`publishDiagnostics.version`) the cached
	 *  diagnostics for a path were computed against. Only set when the server
	 *  reports a version; absent entries mean "version unknown" and are treated
	 *  as fresh so version-less servers keep working. */
	readonly diagnosticDocVersions: Map<string, number>;
	/** #1095: the exact content fingerprint of the LAST didOpen/didChange payload
	 *  we sent for a path, tagged with the document version it was sent as.
	 *  Captured at SEND time on in-memory content (never a disk read on the
	 *  notification path) so a later `publishDiagnostics` echoing that version can
	 *  bind its diagnostics to the content they were computed against.
	 *
	 *  #1669: `text` additionally retains that same payload's full content, but
	 *  ONLY when `syncKind` is Incremental — the one case that needs it, to
	 *  compute the NEXT change's full-range replace against the document as the
	 *  server last saw it (see `buildContentChanges`). Full/None servers never
	 *  populate it, so the common case pays no extra retained memory.
	 *
	 *  #2066: `lastLine` is where that same send's `scanSentContent` pass left
	 *  the end of `text`, so the next change reads two numbers instead of
	 *  re-walking (and re-splitting) the whole document for them. It travels
	 *  with `text` and only with `text`: the eviction rewrite below drops both
	 *  together, and a position describing text that is gone would be a lie. */
	readonly documentContentHashes: Map<
		string,
		{
			version: number;
			hash: string;
			text?: string;
			lastLine?: LastLinePosition;
		}
	>;
	/** #2065: full Incremental-sync text is an LRU-like bounded subset of the
	 * per-path content-binding map. The binding remains after text eviction. */
	incrementalTextRetainedEntries?: number;
	incrementalTextRetainedBytes?: number;
	/** #2065 fix round 1 F5: insertion-ordered set of paths that currently bear
	 * retained Incremental text, oldest first — a parallel index into
	 * `documentContentHashes` so eviction can find the oldest text-bearing
	 * entry in O(1) instead of spreading and scanning every path (including
	 * already-stripped ones) on every didChange past the cap. Kept in lockstep
	 * with `documentContentHashes`'s `text` field: added when text is
	 * (re)written, removed when text is stripped or the path closes. */
	incrementalTextBearingPaths?: Set<string>;
	/** #1095: the content binding for the diagnostics currently stored for a path
	 *  — {version, contentHash} of the document those diagnostics were computed
	 *  against. Set only when the accepted publish carried a version; a version-
	 *  less server never populates this, so its binding reads "unknown" and
	 *  behavior is unchanged. Kept in lockstep with `pushDiagnostics`: written on
	 *  publish accept, cleared by `clearDiagnosticsForPath`. */
	readonly diagnosticBindings: Map<string, StoredDiagnosticBinding>;
	/** #1104: the server-issued `resultId` from the last `textDocument/diagnostic`
	 *  pull for a path (primary or a `relatedDocuments` entry), so the NEXT pull
	 *  can send it as `previousResultId` and receive an `unchanged` report instead
	 *  of a full recompute. Cleared with the rest of a path's diagnostic state by
	 *  `clearDiagnosticsForPath` so a resync never inherits a stale basis.
	 *
	 *  #1667: keyed by (path, diagnostic identifier), not by path alone — result
	 *  ids are per SOURCE. A server registering several diagnostic sources
	 *  (Roslyn: syntax/semantic/analyzers) issues an independent id per source,
	 *  and echoing one source's id to another makes the server answer
	 *  `unchanged` against a basis it never issued. Build keys with
	 *  `pullSourceKey`; the bare (identifier-less) source keys on the plain path
	 *  so single-source servers are byte-identical to before. */
	readonly pullResultIds: Map<string, string>;
	/** #1667: per-source pull diagnostics for a path — outer key the normalized
	 *  path, inner key the diagnostic identifier (`""` for the bare source).
	 *  `documentPullDiagnostics` holds the DEDUPED UNION of these, recomputed
	 *  after every source's report, so each source can be replaced independently
	 *  without one source's answer wiping another's. Optional: a state built
	 *  before this field existed lazily gains it on first pull. */
	documentPullDiagnosticsBySource?: Map<string, Map<string, LSPDiagnostic[]>>;
	/** #1667: per-path pull generation, bumped by `clearDiagnosticsForPath`. The
	 *  fan-out leaves losing pulls running so their results still merge into the
	 *  cache; a resync that lands in that window must not be overwritten by a
	 *  pull computed against the content it just replaced. A late write whose
	 *  captured generation no longer matches is dropped. */
	pullGenerations?: Map<string, number>;
	/** #1667: the sequence number of the NEWEST request issued for each
	 *  `pullSourceKey(path, identifier)`. The generation counter above only
	 *  guards against a resync; it says nothing about two overlapping fan-outs
	 *  for the SAME unchanged content. `ensureWarmForSweep` touches a file and
	 *  the real touch follows ~60ms later, so touch 2 can re-pull a source and
	 *  store a fresh answer while touch 1's slow answer for that same source is
	 *  still in flight - and the late loser would clobber the newer result.
	 *  Each request stamps its own number here; a write whose stamp is no longer
	 *  the newest is dropped. */
	pullRequestSequences?: Map<string, number>;
	/** #1889: requests whose caller timed out and sent `$/cancelRequest`, but
	 *  whose server-side request has not settled yet. Cancellation is advisory:
	 *  a server may accept it and keep computing. A later pull for the same
	 *  path/source must not be admitted until this promise settles, or repeated
	 *  caller deadlines can still build an unbounded server queue. */
	abandonedPullRequests?: Map<string, Promise<unknown>>;
	/** #1104: per-path cache of the last `workspace/diagnostic` pull's resultId +
	 *  diagnostics + content binding, so an `unchanged` report in a LATER pull can
	 *  inherit the prior basis instead of the record site staying stuck at
	 *  "unknown" forever. Keyed by normalized path; `uri` retains the server's
	 *  exact spelling for echoing back in `previousResultIds`. */
	readonly workspacePullResultCache: Map<
		string,
		{
			uri: string;
			resultId: string;
			diagnostics: LSPDiagnostic[];
			contentHash?: string;
		}
	>;
	readonly openDocuments: Set<string>;
	/** Paths explicitly closed during this client lifetime; late publishes are dropped. */
	readonly closedDocuments?: Set<string>;
	/** Original URI spelling for each open document; path keys are normalized. */
	readonly openDocumentUris?: Map<string, string>;
	readonly pendingOpens: Set<string>;
	/** Normalized files already claimed by the classic tsserver project probe. */
	projectIdentityProbedFiles?: Set<string>;
	/** Mutable: updated by applyDynamicCapabilities after registerCapability events */
	workspaceDiagnosticsSupport: LSPWorkspaceDiagnosticsSupport;
	/** Mutable: upgraded by applyDynamicCapabilities after registerCapability events */
	operationSupport: LSPOperationSupport;
	/** #1971: parsed `FileOperationRegistrationOptions` filters from initialize —
	 *  the server registered WHICH paths it cares about for willRename/didRename.
	 *  Sends outside these filters are suppressed at this boundary. */
	fileOperationFilters?: {
		willRename?: LSPFileOperationFilter[];
		didRename?: LSPFileOperationFilter[];
	};
	/** Static initialize-time distinction for capability-skip telemetry. */
	fileOperationMalformedRegistrations?: Set<"willRename" | "didRename">;
	/** Top-level keys of the raw ServerCapabilities from initialize (sorted) —
	 *  captured once; the full advertised surface for diagnostics/documentation. */
	rawCapabilityKeys?: string[];
	/** Position encoding the server negotiated at initialize (#269). UTF-16 unless
	 *  the server advertised otherwise; drives character-offset translation on
	 *  outgoing navigation requests. */
	positionEncoding: PositionEncoding;
	/** #1669: `textDocumentSync.change` kind the server negotiated at initialize
	 *  — None (0), Full (1) or Incremental (2). Optional so existing state
	 *  literals across the test suite don't all need updating; every read site
	 *  falls back to `TEXT_DOCUMENT_SYNC_KIND_FULL`, which is the whole-document
	 *  `{ text }` shape pi-lens has always sent — an absent value never changes
	 *  behavior. Set once at initialize, next to `positionEncoding`. */
	syncKind?: TextDocumentSyncKind;
	/** Baseline mode from static initResult — used to revert on unregister */
	staticDiagnosticsMode: "pull" | "push-only";
	/** Live dynamic registrations from client/registerCapability: id → record.
	 *  #1667: the record carries the registration's `registerOptions`, not just
	 *  its method. Dropping `identifier` made every diagnostic source of a
	 *  multi-source server collapse into one bare pull. */
	readonly dynamicRegistrations: Map<string, DynamicRegistration>;
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
	/** One active command context is safe to associate with a nested applyEdit.
	 * Concurrent commands deliberately clear this rather than cross-correlate. */
	activeMutationContext?: LspMutationContext;
	activeMutationDepth?: number;
	readonly serverId: string;
	/** See `LSPServerInfo.spawn`'s `launchVariant` (server.ts). Undefined =
	 *  single-variant server or not yet reported. */
	readonly launchVariant?: "classic" | "native-ts7";
	readonly root: string;
	readonly lspProcess: LSPProcess;
	/**
	 * Per-client debounced `workspace/didChangeWatchedFiles` batcher (#271).
	 * Two-phase init (needs `state` for its flush closure) — assigned right after
	 * the state literal, like `workspaceDiagnosticsSupport`.
	 */
	watchQueue: WatchedFilesQueue;
}

/** #2065: bound both the path count and UTF-16 heap represented by retained
 * Incremental-sync text. The map keeps the newest sent paths when evicting. */
export const MAX_INCREMENTAL_TEXT_RETAINED_ENTRIES = 128;
export const MAX_INCREMENTAL_TEXT_RETAINED_BYTES = 64 * 1024 * 1024;

/**
 * #2065 fix round 1: a PROJECTION registry, not a second source of truth for
 * "which clients are live" — its only job is letting `memory-sampler.ts`
 * total retained-text bytes across clients without importing `LSPService`.
 * Considered projecting straight off `LSPService.state.clients` (the
 * manager's own client map, `clients/lsp/index.ts`) instead of keeping this
 * Set at all, and rejected it for two reasons:
 *   1. Import direction: `clients/lsp/index.ts` imports THIS file, not the
 *      reverse, so reading `LSPService.state.clients` from here (or from
 *      `memory-sampler.ts`, which every other snapshot in that module reaches
 *      by importing the owning subsystem directly, e.g.
 *      `getReviewGraphWorkspaceCacheSnapshot`, `getDispatchCascadeCacheStats`)
 *      means importing the higher-level manager from the lower-level client
 *      module — a layering inversion, not a cycle fix.
 *   2. `LSPService.state.clients` is ITSELF only lazily reconciled against
 *      real client death — a crashed client's slot is noticed and evicted on
 *      the next `getClientForFile` attach, not at crash time (see
 *      `markExitedIfUnset`'s docstring above). Projecting off it would not
 *      give memory-sampler any more real-time accuracy than this Set; it
 *      would just move the same "who deregisters, and when" question onto a
 *      larger, higher-risk surface (the manager's routing map) for no gain.
 *
 * What makes this safe to keep as a second collection: it has exactly ONE
 * lifecycle seam. `spawnClient` is the only writer that adds (below), and
 * `disposeClientConnection` is the only writer that removes — and that
 * function is itself the single convergence point every permanent-death path
 * (`connection.onError`, `connection.onClose`, the process `exit` handler,
 * and `clientShutdownOnce`'s `finally`) already funnels through, guarded by
 * the same `connectionDisposed` idempotency flag that gates the connection
 * teardown itself. Membership can therefore never drift from "has this
 * client's connection been torn down" — there is nowhere else in the file
 * that can flip a client from alive to permanently dead without going
 * through `disposeClientConnection`.
 *
 * PROCESS-SCOPED, not module-scoped (#2130 criterion 2). This Set is what
 * `memory_sample.subsystems.lsp.clients` counts, and a module-scope Set counted
 * only the clients this MODULE EVALUATION spawned. pi evaluates the pi-lens
 * graph up to nine times per process (#2146, measured `host_boot` = 9) and each
 * evaluation builds its own `LSPService` and fleet (#2157 item 1), so a
 * secondary root's servers — spawned by a later evaluation — were invisible to
 * the sampler running in the first. That is the reported symptom exactly:
 * `clients: 1` in `memory_sample` beside `lspChildCount: 2` in `instances.json`,
 * with two tsservers alive. Sharing the Set through `getProcessSingleton` makes
 * both the count and `roots` span every root the process serves.
 *
 * Both seams share it, which is the whole requirement: sharing only the add
 * site would build a Set that never shrinks, a worse leak than the undercount.
 */
const ACTIVE_CLIENTS_FAMILY = "lsp-client.active-clients";
/** Bump when the cell's shape changes. */
const ACTIVE_CLIENTS_VERSION = 1;

function activeLspClientSet(): Set<LSPClientState> {
	return getProcessSingleton(
		ACTIVE_CLIENTS_FAMILY,
		ACTIVE_CLIENTS_VERSION,
		() => new Set<LSPClientState>(),
	);
}

export function getLspDocumentTextRetentionSnapshot(): {
	clients: number;
	entries: number;
	bytes: number;
	/**
	 * #2130: how many DISTINCT project roots the live clients are spread
	 * across. `clients` alone cannot answer "are two tsservers up because one
	 * root needs two servers, or because this host is serving two roots" —
	 * which is the exact question the multi-root host raised, and the reason a
	 * `clients` count with no root discriminator is not enough to reconcile
	 * `memory_sample` against `instances.json`'s `lspChildCount`.
	 *
	 * A COUNT, not a path list: this rides on a per-turn record, so it must
	 * stay bounded (one small integer) no matter how many roots a host serves.
	 * The paths themselves live in `instances.json`'s `projectRoots`.
	 */
	roots: number;
} {
	let entries = 0;
	let bytes = 0;
	const roots = new Set<string>();
	const active = activeLspClientSet();
	for (const state of active) {
		entries += state.incrementalTextRetainedEntries ?? 0;
		bytes += state.incrementalTextRetainedBytes ?? 0;
		if (typeof state.root === "string" && state.root.length > 0) {
			roots.add(state.root);
		}
	}
	return { clients: active.size, entries, bytes, roots: roots.size };
}

function isClientAlive(state: LSPClientState): boolean {
	return (
		state.isConnected && !state.isDestroyed && !state.lspProcess.process.killed
	);
}

function disposeClientConnection(state: LSPClientState): void {
	if (state.connectionDisposed) return;
	state.connectionDisposed = true;
	// #2065 fix round 1: this is the ONE place every permanent-death path
	// converges (onError, onClose, the process 'exit' handler, and
	// clientShutdownOnce's finally) — see setupConnectionLifecycle below and
	// clientShutdownOnce. Deregistering here, guarded by the idempotency flag
	// above, means a crash that never re-attaches still frees its retained
	// text instead of pinning it for the rest of the process lifetime.
	activeLspClientSet().delete(state);
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
		once?: (event: "exit", listener: () => void) => unknown;
		off?: (event: "exit", listener: () => void) => unknown;
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
		// (TerminateProcess; synchronous, no async handle).
		//
		// #472 CORRECTION of a prior false claim here ("orphaned grandchildren are
		// reaped by the OS as the host exits"): Windows does NOT kill children when
		// a parent dies. For shell/.cmd-wrapped servers the direct child is
		// cmd.exe, so this path only ever kills the wrapper — the actual server
		// (its grandchild) survives by design whenever it doesn't independently
		// exit. It relies entirely on best-effort backstops instead: (1) the
		// server observing stdin EOF once the wrapper's pipes close, (2) LSP
		// `initialize.processId: process.pid` (some servers self-watchdog on that
		// pid dying — typescript-language-server does, ast-grep's native binary
		// does not, an upstream spec violation), and (3) the #449/#472
		// cross-process instance registry's orphan reaper, which is the only
		// mechanism that works regardless of why a pipe write-end stayed open
		// (e.g. Windows handle-inheritance capture by a long-lived process). This
		// is why registering every LSP child at spawn matters uniformly — do NOT
		// weaken this direct-child-only kill to try to chase grandchildren here;
		// spawning taskkill in this branch is exactly the libuv hazard above.
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
				killer.once("error", (err) => {
					logLatency({
						type: "phase",
						phase: "lsp_kill_escalation",
						filePath: "",
						durationMs: 0,
						metadata: { pid, platform: "win32", taskkillError: String(err) },
					});
					resolve();
				});
			});
		} catch (err) {
			logLatency({
				type: "phase",
				phase: "lsp_kill_escalation",
				filePath: "",
				durationMs: 0,
				metadata: { pid, platform: "win32", taskkillSpawnError: String(err) },
			});
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
		// #1114: gate the escalation on OBSERVED exit, not `proc.killed`. Node
		// only sets `proc.killed = true` when `proc.kill()` (the ChildProcess
		// method) successfully SENDS a signal — never when the process actually
		// dies, and the primary SIGTERM path above goes through the raw
		// `process.kill(-pid, …)` process-group call, which never touches
		// `proc.killed` at all. Checking `!proc.killed` here was therefore
		// either always-true (unconditional SIGKILL after the window,
		// regardless of whether the group already died — group-kill path) or
		// always-false/dead (direct-child fallback path, same shape as the
		// safe-spawn escalation bug). An `exit` listener set once, up front,
		// gives a real observed-death signal for both. Seeded from the same
		// `exitCode`/`signalCode` pre-check the top-of-function early return
		// uses (:689) — that early return is skipped when
		// `options.processExiting` is set, so a process that was ALREADY dead
		// on entry can still reach here; without seeding, `exited` would stay
		// false (the "exit" event already fired before this listener was
		// attached) and the fast/non-fast branches below would still fire a
		// redundant group SIGKILL at the escalation window.
		let exited = proc.exitCode != null || proc.signalCode != null;
		proc.once?.("exit", () => {
			exited = true;
		});
		if (!killPosixProcessGroup("SIGTERM")) {
			killDirectChild("SIGTERM");
		}
		if (options.fast) {
			const timer = setTimeout(() => {
				if (!exited) {
					logLatency({
						type: "phase",
						phase: "lsp_kill_escalation",
						filePath: "",
						durationMs: 1500,
						metadata: { pid, platform: "posix", method: "SIGKILL", fast: true },
					});
					if (!killPosixProcessGroup("SIGKILL")) {
						killDirectChild("SIGKILL");
					}
				}
			}, 1500);
			timer.unref?.();
			proc.unref?.();
			return;
		}
		// SIGTERM → exit-or-1.5s → SIGKILL escalation. SIGTERM alone can leave
		// zombie processes if the server hangs — but a server that dies promptly
		// must resolve on its exit event, not sleep the full escalation window
		// (that unconditional 1500ms was the whole cost of every graceful LSP
		// teardown, ×N clients per session and per test).
		const exitedInTime = await new Promise<boolean>((resolve) => {
			if (proc.exitCode != null || proc.signalCode != null) {
				resolve(true);
				return;
			}
			const onExit = (): void => {
				clearTimeout(timer);
				resolve(true);
			};
			const timer = setTimeout(() => {
				proc.off?.("exit", onExit);
				resolve(false);
			}, 1500);
			proc.once?.("exit", onExit);
		});
		if (!exitedInTime && !exited) {
			logLatency({
				type: "phase",
				phase: "lsp_kill_escalation",
				filePath: "",
				durationMs: 1500,
				metadata: { pid, platform: "posix", method: "SIGKILL", fast: false },
			});
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

/**
 * Union of diagnostic lists, first occurrence wins, exact duplicates dropped.
 * Variadic since #1667 so the per-identifier pull sources merge through the
 * SAME key as the push/pull merge rather than growing a second dedupe rule.
 */
function mergeDiagnosticLists(
	...lists: (LSPDiagnostic[] | undefined)[]
): LSPDiagnostic[] {
	const merged: LSPDiagnostic[] = [];
	const seen = new Set<string>();
	for (const diagnostic of lists.flatMap((list) => list ?? [])) {
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
	// SAFETY: `diagnostics` is the pre-split field name that older states (and
	// older embedders holding a state built before `pushDiagnostics` existed)
	// still carry. It is absent from `LSPClientState` on purpose — new code
	// must not write it. The cast declares it OPTIONAL, so the read below is
	// still `undefined`-guarded and a state without it falls through to the
	// current field.
	const legacy = state as unknown as {
		diagnostics?: Map<string, LSPDiagnostic[]>;
	};
	return mergeDiagnosticLists(
		state.pushDiagnostics?.get(normalizedPath) ??
			legacy.diagnostics?.get(normalizedPath),
		state.documentPullDiagnostics?.get(normalizedPath),
	);
}

/**
 * #1667: per-source pull-diagnostic bookkeeping.
 *
 * A pull-mode server can expose several diagnostic SOURCES, each named by its
 * registration's `registerOptions.identifier` (Roslyn: syntax, semantic,
 * analyzers). Each source answers independently, with its own `resultId` and
 * its own findings, so per-path state that used to be a single slot has to
 * become one slot per (path, source):
 *
 *  - `pullResultIds` keys on `pullSourceKey(path, identifier)`, so an
 *    `unchanged` report is only ever answered against the id THAT source
 *    issued (#240/#1104 machinery, now per source).
 *  - `documentPullDiagnosticsBySource` holds each source's findings, and
 *    `documentPullDiagnostics` is their deduped union - recomputed whenever a
 *    source reports, so a fresh answer from one source never wipes another's.
 *
 * The bare (identifier-less) source keys on the plain path, so a single-source
 * server stores exactly what it stored before this change.
 */
// NUL is the one byte a filesystem path can never contain, so
// `path + SEP + identifier` is unambiguous: no path/identifier pair can
// produce the same key as a different pair, and the bare source's key (the
// plain path) can never collide with a named source's.
const PULL_SOURCE_KEY_SEPARATOR = "\u0000";
const BARE_PULL_SOURCE = "";

function pullSourceKey(
	normalizedPath: string,
	identifier: string | undefined,
): string {
	return identifier === undefined
		? normalizedPath
		: `${normalizedPath}${PULL_SOURCE_KEY_SEPARATOR}${identifier}`;
}

/** Every `pullResultIds` key belonging to a path - the bare key plus one per
 *  identifier. Used by the clear path so a resync drops EVERY source's basis. */
function pullSourceKeysForPath(
	state: LSPClientState,
	normalizedPath: string,
): string[] {
	const prefix = `${normalizedPath}${PULL_SOURCE_KEY_SEPARATOR}`;
	return [
		normalizedPath,
		...[...(state.pullResultIds?.keys() ?? [])].filter((key) =>
			key.startsWith(prefix),
		),
	];
}

function pullSourcesFor(
	state: LSPClientState,
	normalizedPath: string,
): Map<string, LSPDiagnostic[]> {
	if (!state.documentPullDiagnosticsBySource) {
		state.documentPullDiagnosticsBySource = new Map();
	}
	let sources = state.documentPullDiagnosticsBySource.get(normalizedPath);
	if (!sources) {
		sources = new Map();
		state.documentPullDiagnosticsBySource.set(normalizedPath, sources);
	}
	return sources;
}

/** This source's currently stored findings for a path - what an `unchanged`
 *  report inherits. Falls back to the whole per-path list when the source map
 *  has no entry yet, so a state that pulled before this change (or a caller
 *  that seeded `documentPullDiagnostics` directly) still inherits correctly. */
function pullSourceDiagnostics(
	state: LSPClientState,
	normalizedPath: string,
	identifier: string | undefined,
): LSPDiagnostic[] {
	const sources = state.documentPullDiagnosticsBySource?.get(normalizedPath);
	const stored = sources?.get(identifier ?? BARE_PULL_SOURCE);
	if (stored) return stored;
	return sources && sources.size > 0
		? []
		: (state.documentPullDiagnostics.get(normalizedPath) ?? []);
}

/** Store one source's findings and republish the union to
 *  `documentPullDiagnostics`, which every reader outside this file uses. */
function storePullSourceDiagnostics(
	state: LSPClientState,
	normalizedPath: string,
	identifier: string | undefined,
	diagnostics: LSPDiagnostic[],
): void {
	const sources = pullSourcesFor(state, normalizedPath);
	sources.set(identifier ?? BARE_PULL_SOURCE, diagnostics);
	state.documentPullDiagnostics.set(
		normalizedPath,
		mergeDiagnosticLists(...sources.values()),
	);
}

/** #1667: the pull generation for a path. The fan-out deliberately lets losing
 *  pulls run to completion so their findings still reach the cache; a resync
 *  that lands first must win, so every late write re-checks this. */
function pullGenerationFor(
	state: LSPClientState,
	normalizedPath: string,
): number {
	return state.pullGenerations?.get(normalizedPath) ?? 0;
}

function bumpPullGeneration(
	state: LSPClientState,
	normalizedPath: string,
): void {
	if (!state.pullGenerations) state.pullGenerations = new Map();
	state.pullGenerations.set(
		normalizedPath,
		(state.pullGenerations.get(normalizedPath) ?? 0) + 1,
	);
}

/** #1667: claim the newest-request slot for a source and return the claim.
 *  Called at REQUEST time; `isNewestPullRequest` re-checks it at WRITE time so
 *  a slow answer from an earlier fan-out cannot overwrite a newer one's. */
function claimPullRequestSequence(
	state: LSPClientState,
	sourceKey: string,
): number {
	if (!state.pullRequestSequences) state.pullRequestSequences = new Map();
	const next = (state.pullRequestSequences.get(sourceKey) ?? 0) + 1;
	state.pullRequestSequences.set(sourceKey, next);
	return next;
}

function isNewestPullRequest(
	state: LSPClientState,
	sourceKey: string,
	sequence: number,
): boolean {
	return (state.pullRequestSequences?.get(sourceKey) ?? 0) === sequence;
}

/**
 * #1667: drop every trace of a diagnostic source the server just unregistered.
 *
 * `client/unregisterCapability` retires a source, but its findings sit in
 * `documentPullDiagnosticsBySource` and its resultId in `pullResultIds`, so
 * without this the union keeps serving a retired source's diagnostics until
 * something resyncs the file. Roslyn and vtsls re-register their sources on
 * solution reload, which is exactly when the old source's findings are stale.
 *
 * Purges the source's slice from every path and republishes each affected
 * path's union, so the removal is visible on the next read rather than only
 * after the next pull.
 */
function retirePullSource(state: LSPClientState, identifier: string): void {
	const suffix = `${PULL_SOURCE_KEY_SEPARATOR}${identifier}`;
	for (const source of [state.pullResultIds, state.pullRequestSequences]) {
		if (!source) continue;
		for (const key of [...source.keys()]) {
			if (key.endsWith(suffix)) source.delete(key);
		}
	}
	for (const [
		normalizedPath,
		sources,
	] of state.documentPullDiagnosticsBySource ?? []) {
		if (!sources.delete(identifier)) continue;
		state.documentPullDiagnostics.set(
			normalizedPath,
			mergeDiagnosticLists(...sources.values()),
		);
		bumpDiagnosticsVersion(state, normalizedPath);
		state.diagnosticEmitter.emit("diagnostics", normalizedPath);
	}
}

/**
 * #1667: the diagnostic sources to pull for a document - always the bare
 * request (a server may answer it even while registering named sources, and it
 * is the ONLY request a single-source server understands), plus one per
 * distinct `identifier` on a live `textDocument/diagnostic` registration.
 *
 * Derived from `dynamicRegistrations` on every call rather than cached in a
 * parallel list: the registration map is the single source of truth, and
 * `client/unregisterCapability` must be able to retire a source immediately.
 */
export function pullDiagnosticSources(
	state: LSPClientState,
): (string | undefined)[] {
	const identifiers = new Set<string>();
	for (const registration of state.dynamicRegistrations?.values() ?? []) {
		if (registration.method !== "textDocument/diagnostic") continue;
		if (registration.identifier) identifiers.add(registration.identifier);
	}
	// Sorted for a stable, reproducible request order in logs and tests; the
	// fan-out is parallel, so order carries no priority.
	return [undefined, ...[...identifiers].sort((a, b) => a.localeCompare(b))];
}

/** #1531: bump the client-global diagnostics counter and stamp the path it was
 * bumped FOR. The single seam every "fresh diagnostics stored" site goes
 * through, so the per-path stamp can never drift from the global counter. */
export function bumpDiagnosticsVersion(
	state: LSPClientState,
	normalizedPath: string,
): void {
	state.diagnosticsVersion += 1;
	state.diagnosticsVersionsByPath?.set(
		normalizedPath,
		state.diagnosticsVersion,
	);
}

/** #1531: the global counter's value when diagnostics were last stored for
 * `normalizedPath`, or 0 when nothing is stored. 0 is a safe floor because the
 * counter starts at 0 and only ever increases, so any later publication for the
 * path compares greater than a baseline read while it was absent. */
export function diagnosticsVersionForPath(
	state: LSPClientState,
	normalizedPath: string,
): number {
	return state.diagnosticsVersionsByPath?.get(normalizedPath) ?? 0;
}

/** Exported for tests: the quiet-window timer cancel on clear/resync is the
 * headline #1412 safety property (a stale versionless publication must never
 * land after the document content changed). */
export function clearDiagnosticsForPath(
	state: LSPClientState,
	normalizedPath: string,
): void {
	// SAFETY: same pre-split field names as `getMergedDiagnosticsForPath`.
	// Clearing must cover the legacy maps too, or a state that still carries
	// them replays a stale diagnostic after the clear. Both are declared
	// OPTIONAL, so every use below is `?.`-guarded on a state that lacks them.
	const legacy = state as unknown as {
		diagnostics?: Map<string, LSPDiagnostic[]>;
		diagnosticTimestamps?: Map<string, number>;
	};
	state.pushDiagnostics?.delete(normalizedPath);
	const pending = state.pendingDiagnostics?.get(normalizedPath);
	if (pending) clearTimeout(pending);
	state.pendingDiagnostics?.delete(normalizedPath);
	state.pushDiagnosticTimestamps?.delete(normalizedPath);
	state.documentPullDiagnostics?.delete(normalizedPath);
	state.documentPullDiagnosticTimestamps?.delete(normalizedPath);
	state.diagnosticDocVersions?.delete(normalizedPath);
	// #1095: a cleared path must never serve a stale content binding alongside a
	// later publish — drop it with the diagnostics it described. (The last-sent
	// `documentContentHashes` record is intentionally retained: it describes what
	// we sent, which the NEXT publish for that version still needs to bind to.)
	state.diagnosticBindings?.delete(normalizedPath);
	// #1531: the per-path publication stamp describes diagnostics that no longer
	// exist — drop it with them. Safe because the stamps hold the GLOBAL counter's
	// value: a baseline captured before this clear still compares less than any
	// later publication for the path, so dropping the entry cannot manufacture a
	// missed answer.
	state.diagnosticsVersionsByPath?.delete(normalizedPath);
	// #1104: a resync invalidates any `unchanged`-report basis too — the next
	// pull must not inherit a resultId/contentHash computed against the
	// content this resync just replaced.
	// #1667: every SOURCE's basis, not just the bare one - a multi-source server
	// holds one resultId per identifier, and leaving even one behind lets the
	// next pull inherit against content this resync replaced.
	for (const key of pullSourceKeysForPath(state, normalizedPath)) {
		state.pullResultIds?.delete(key);
	}
	// `pullRequestSequences` is deliberately NOT cleared here. It is a
	// monotonic per-source counter, and resetting it would let a request issued
	// BEFORE this resync claim the same number as one issued after, so the stale
	// answer would pass the newest-request check. The two guards cover different
	// cases and neither subsumes the other: the generation bump below invalidates
	// in-flight work when nothing newer was requested, and the sequence stamp
	// invalidates it when something newer was.
	state.documentPullDiagnosticsBySource?.delete(normalizedPath);
	// #1667: invalidate any pull still in flight for this path. The fan-out lets
	// losing pulls run to completion so their findings still reach the cache;
	// without this bump one of them could resurrect what this resync cleared.
	bumpPullGeneration(state, normalizedPath);
	state.workspacePullResultCache?.delete(normalizedPath);
	legacy.diagnostics?.delete(normalizedPath);
	legacy.diagnosticTimestamps?.delete(normalizedPath);
}

/**
 * #1639: `durationMs` measures the PULL SETTLE ITSELF — the caller passes how
 * long `clientRequestPullDiagnostics` (plus any retries) took to resolve
 * `found`/`clean` — never time-since-didOpen. Document age is a genuinely
 * useful signal but a DIFFERENT one; it stays under its own honest name in
 * `metadata.elapsedSinceDidOpenMs`, exactly like the push-path `logSequence`
 * above already does. Before this fix the top-level field carried the same
 * age value pull requests use for retry-budget bookkeeping, so a session's
 * latency percentiles for this phase read multi-second document lifetimes as
 * millisecond operation costs (147/239 records read >60s "durations" for
 * settles that took milliseconds).
 *
 * `version` reads the real tracked version from `diagnosticsVersionsByPath`
 * (bumped by `bumpDiagnosticsVersion` right after this pull's diagnostics
 * were stored — see the `documentPullDiagnostics.set` call above it) instead
 * of a hardcoded `null`, which made every pull settle look "unbound" to
 * staleness forensics even though this codebase already tracks a real
 * version for the path. Falls back to the explicit `"pull-unversioned"`
 * marker only when nothing has been stored yet, so "no data" is never
 * confused with "confirmed no version" (`null`).
 *
 * `pullSettleSource` distinguishes the two legitimate call paths that can
 * both settle a pull for the same file close together: a real
 * content-collecting touch ("pull") and `ensureWarmForSweep`'s warm-up-only
 * touch ("pull-warmup"), which runs a real round trip purely to prove the
 * server answers before the sweep's real touch immediately follows it.
 * Before this fix both logged identically as settleSource "pull", so a
 * session with warm-up sweeps double-counted: 239 records against 145
 * touches, with same-file pairs ~60ms apart and near-identical document
 * ages — the warm-up settle and the real touch's settle for the same file.
 */
function logTypeScriptPullSettle(
	state: LSPClientState,
	normalizedPath: string,
	durationMs: number,
	pullSettleSource: "pull" | "pull-warmup",
): void {
	if (state.serverId !== "typescript") return;
	const diagnostics = state.documentPullDiagnostics.get(normalizedPath) ?? [];
	const elapsedSinceDidOpenMs = Math.max(
		0,
		Date.now() - (state.documentOpenedAt.get(normalizedPath) ?? Date.now()),
	);
	const diagnosticCodes = [
		...new Set(
			diagnostics
				.map((diagnostic) => diagnostic.code)
				.filter((code): code is string | number => code !== undefined)
				.map(String),
		),
	].slice(0, 8);
	const trackedVersion = state.diagnosticsVersionsByPath?.get(normalizedPath);
	logLatency({
		type: "phase",
		phase: "lsp_typescript_diagnostic_sequence",
		filePath: normalizedPath,
		durationMs,
		metadata: {
			serverId: state.serverId,
			outcome: "settled",
			launchVariant: state.launchVariant ?? "unknown",
			publicationIndex:
				state.diagnosticPublicationCounts.get(normalizedPath) ?? 0,
			version: trackedVersion ?? "pull-unversioned",
			diagnosticCount: diagnostics.length,
			diagnosticCodes,
			elapsedSinceDidOpenMs,
			settledReturn: true,
			settleSource: pullSettleSource,
		},
	});
}

/** Where a document's last LSP-addressable line begins (#2066). */
interface LastLinePosition {
	/** Its 0-based line index. */
	index: number;
	/** Its first character's offset into the document. */
	start: number;
}

interface SentContentScan {
	/** `\n` count — `contentLineCount` is this + 1. */
	lfNewlineCount: number;
	lastLine: LastLinePosition;
}

/**
 * #2066: the ONE full-document walk a send needs, replacing the two that used
 * to run independently — a `charCodeAt` loop counting `\n` for the
 * `lsp_document_send` line count, and a `.split(/\r\n|\r|\n/)` in
 * `buildContentChanges` that materialized one substring per line to read the
 * last one. The #1095 sha256 is a third walk and stays; it is native, and it
 * is load-bearing.
 *
 * The two counts here are deliberately NOT the same number and must not be
 * collapsed into one. `lfNewlineCount` counts `\n` only, because its consumer
 * pairs against `diagnostic_past_eof`, whose gate counts LF BYTES
 * (`clients/diagnostic-line-freshness.ts`); merging the conventions would put
 * the two records one apart on exactly the mixed-ending documents the pairing
 * exists to debug. `lastLine` uses the full LSP terminator set (`\r\n`, lone
 * `\r`, `\n` — #1669 review F6), because a CRLF or classic-Mac document whose
 * terminators went uncounted computes a range ending mid-document.
 */
function scanSentContent(content: string): SentContentScan {
	let lfNewlineCount = 0;
	let index = 0;
	let start = 0;
	// `charCodeAt`, not `codePointAt` (typescript:S7758, accepted): both are
	// compared against 10/13, which no surrogate unit or astral code point can
	// equal, so they are interchangeable here — but `codePointAt` measured 8%
	// slower on a 400 KiB LF document (0.716 vs 0.663 ms/scan), because every
	// ordinary character pays a surrogate-pair check this loop never uses.
	for (let i = 0; i < content.length; i++) {
		const code = content.charCodeAt(i);
		if (code !== 10 && code !== 13) continue;
		if (code === 10) {
			lfNewlineCount++;
		} else if (content.charCodeAt(i + 1) === 10) {
			// `\r\n` is ONE line terminator, and still carries the `\n` the
			// LF-only count wants.
			lfNewlineCount++;
			i++;
		}
		index++;
		start = i + 1;
	}
	return { lfNewlineCount, lastLine: { index, start } };
}

/**
 * #1095: fingerprint the EXACT didOpen/didChange payload text at SEND time and
 * tag it with the document version it was sent as, so a later
 * `publishDiagnostics` echoing that version can bind its diagnostics to the
 * content they were computed against. Runs on in-memory content — never a disk
 * read on the notification path (I1). Bounded by the same file-size gates the
 * caller already applies to the content it hands us.
 */
function recordSentContent(
	state: LSPClientState,
	normalizedPath: string,
	version: number,
	content: string,
	coalescedCount = 0,
): void {
	const scan = scanSentContent(content);
	const previous = state.documentContentHashes.get(normalizedPath);
	if (previous && previous.version > version) {
		incrementDegradationCount({
			kind: "lsp-document-send-order",
			subject: `${state.serverId}:${normalizedPath}`,
			reason: `recorded version ${version} after newer version ${previous.version}`,
		});
		return;
	}
	if (previous?.text !== undefined) {
		state.incrementalTextRetainedEntries = Math.max(
			0,
			(state.incrementalTextRetainedEntries ?? 1) - 1,
		);
		state.incrementalTextRetainedBytes = Math.max(
			0,
			(state.incrementalTextRetainedBytes ?? previous.text.length * 2) -
				previous.text.length * 2,
		);
		// #2065 fix round 1 F5: the path is about to be rewritten below (and
		// possibly re-marked text-bearing) — drop the stale membership first so
		// the reinsert further down lands at the END of the recency order
		// instead of leaving a duplicate-free but stale position.
		state.incrementalTextBearingPaths?.delete(normalizedPath);
	}
	// #2065 fix round 1 F5: eviction recency now lives in
	// `incrementalTextBearingPaths` (above/below), not this map's own
	// insertion order — no remaining reader iterates `documentContentHashes`
	// for order (every other site below is a keyed `.get`/`.delete`). The
	// reinsert is kept anyway so a log or future debug dump that DOES walk
	// this map in insertion order still reads "most recently sent last",
	// matching the aux set it mirrors, rather than a stale mixed order.
	state.documentContentHashes.delete(normalizedPath);
	state.documentContentHashes.set(normalizedPath, {
		version,
		hash: hashDiagnosticContent(content),
		// #1669: retain the full text only for Incremental — the sole reader
		// (`buildContentChanges`) needs it to compute the NEXT change against
		// what the server last saw; Full/None never read this field.
		// #2066: `lastLine` is that reader's answer, already computed by the
		// scan above — it rides along with the text it describes.
		...(state.syncKind === TEXT_DOCUMENT_SYNC_KIND_INCREMENTAL && {
			text: content,
			lastLine: scan.lastLine,
		}),
	});
	if (state.syncKind === TEXT_DOCUMENT_SYNC_KIND_INCREMENTAL) {
		state.incrementalTextRetainedEntries =
			(state.incrementalTextRetainedEntries ?? 0) + 1;
		state.incrementalTextRetainedBytes =
			(state.incrementalTextRetainedBytes ?? 0) + content.length * 2;
		// #2065 fix round 1 F5: track membership in the same insertion (=
		// recency) order as `documentContentHashes` itself, so eviction below
		// never needs to spread and scan the full content-binding map —
		// including paths whose text was already stripped — just to find the
		// oldest text-bearing one.
		if (!state.incrementalTextBearingPaths) {
			state.incrementalTextBearingPaths = new Set();
		}
		state.incrementalTextBearingPaths.add(normalizedPath);
		while (
			(state.incrementalTextRetainedEntries ?? 0) >
				MAX_INCREMENTAL_TEXT_RETAINED_ENTRIES ||
			(state.incrementalTextRetainedBytes ?? 0) >
				MAX_INCREMENTAL_TEXT_RETAINED_BYTES
		) {
			const oldestPath = state.incrementalTextBearingPaths
				?.values()
				.next().value;
			if (oldestPath === undefined) break;
			const binding = state.documentContentHashes.get(oldestPath);
			state.incrementalTextBearingPaths.delete(oldestPath);
			if (!binding || binding.text === undefined) continue;
			// #2066: `lastLine` is dropped here with the text it describes. The
			// #1095 version/hash binding is what must survive the strip.
			state.documentContentHashes.set(oldestPath, {
				version: binding.version,
				hash: binding.hash,
			});
			state.incrementalTextRetainedEntries = Math.max(
				0,
				(state.incrementalTextRetainedEntries ?? 1) - 1,
			);
			state.incrementalTextRetainedBytes = Math.max(
				0,
				(state.incrementalTextRetainedBytes ?? 0) - binding.text.length * 2,
			);
		}
	}
	// #1641 criterion 3: the in-memory document's version + content length AT
	// SEND TIME, so a later "diagnostic cited a line past current disk EOF"
	// record (`diagnostic_past_eof`, clients/diagnostic-line-freshness.ts) can be
	// paired with the send that produced the divergent in-memory document —
	// today only the symptom (the stale citation) is observable; this is the
	// cause side of the same timeline.
	//
	// Review round F4/F1: `contentLineCount` MUST use the same LSP-addressable
	// convention as the gate itself (newline count + 1 — a trailing `\n` adds
	// one more, empty, addressable line; an empty document is still 1 line),
	// or the two records disagree by one at exactly the boundary this counter
	// exists to help debug. #2066: the count comes from `scanSentContent`
	// above, which folded this loop into the walk `buildContentChanges` was
	// already paying for; the LF-only convention is unchanged.
	logLatency({
		type: "phase",
		phase: "lsp_document_send",
		filePath: normalizedPath,
		durationMs: 0,
		metadata: {
			version,
			contentLength: content.length,
			contentLineCount: scan.lfNewlineCount + 1,
			...(coalescedCount > 0 && { coalescedCount }),
		},
	});
}

/**
 * #1669: the `contentChanges` array for a `textDocument/didChange` notification.
 *
 * Full/None (or unrecognized/absent) sync kind: unchanged — a single
 * whole-document `{ text }` event, the shape pi-lens has always sent.
 *
 * Incremental: a server registering Incremental-only expects every change
 * event to carry a `range`; a shapeless whole-document event is out of spec
 * for it. Rather than hand-roll a real diff, send the SAFEST incremental
 * representation of a full update — one ranged edit spanning the entire
 * PREVIOUS document (start of file to its last character), replacing it with
 * the entire new content. That is spec-valid for any Incremental server and
 * semantically identical to the Full-sync event it replaces.
 *
 * The previous document's end position is computed from the text
 * `recordSentContent` retained for THIS path the last time content was sent
 * (reusing that seam rather than a second parallel content store — see its
 * doc comment). No prior text on record (first change since Incremental was
 * negotiated, or the path was never sent before) falls back to the
 * whole-document shape — still spec-valid, and self-heals once the next
 * change has a retained previous text to diff against.
 */
function buildContentChanges(
	state: LSPClientState,
	normalizedPath: string,
	content: string,
): Array<{
	range?: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
	text: string;
}> {
	if (state.syncKind !== TEXT_DOCUMENT_SYNC_KIND_INCREMENTAL) {
		return [{ text: content }];
	}
	const previous = state.documentContentHashes.get(normalizedPath);
	if (previous?.text === undefined) {
		return [{ text: content }];
	}
	const previousText = previous.text;
	// #2066: `recordSentContent` scanned this exact text when it sent it, so
	// read where it left the last line instead of walking (and splitting) the
	// document a second time. An entry carrying text without that position was
	// written by something else — resolve it through the SAME scanner, never a
	// second convention that can drift from it.
	const lastLine = previous.lastLine ?? scanSentContent(previousText).lastLine;
	const lastLineText = previousText.slice(lastLine.start);
	return [
		{
			range: {
				start: { line: 0, character: 0 },
				end: {
					line: lastLine.index,
					character: convertCharacterOffset(
						state.positionEncoding,
						lastLineText,
						lastLineText.length,
					),
				},
			},
			text: content,
		},
	];
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
	const registrations = [...state.dynamicRegistrations.values()];
	const registeredMethods = new Set(registrations.map((r) => r.method));

	const hasDynamicPull =
		registeredMethods.has("textDocument/diagnostic") ||
		registeredMethods.has("workspace/diagnostic");

	if (hasDynamicPull) {
		state.workspaceDiagnosticsSupport = {
			advertised: true,
			mode: "pull",
			// #1667: workspace-pull support is what the REGISTRATION declares. The
			// spec registers workspace pull as `registerOptions.workspaceDiagnostics`
			// on a `textDocument/diagnostic` registration - `workspace/diagnostic` is
			// not itself a registrable method - so reading the method name alone
			// missed every conforming server and this client never issued a
			// workspace pull for one. The method-name check stays as a fallback for
			// servers that register it as a method anyway.
			workspaceDiagnostics:
				registrations.some((r) => r.workspaceDiagnostics === true) ||
				registeredMethods.has("workspace/diagnostic"),
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
			workspaceDiagnostics: false,
			diagnosticProviderKind: "none",
		};
	}

	for (const [method, key] of Object.entries(DYNAMIC_OPERATION_METHOD_MAP)) {
		if (registeredMethods.has(method)) {
			state.operationSupport[key] = true;
		}
	}
}

/**
 * Resolve a `workspace/configuration` request item's `section` (a dot-path,
 * e.g. "scan.jobs") against the server's `initializationOptions` blob.
 * - No section (undefined/empty) → the whole blob, per spec ("if a scope
 *   isn't asked for" the client returns the full settings for that scope).
 * - An unresolvable path → `null`, never the whole blob — a server asking
 *   for a section it doesn't get must not silently receive unrelated config.
 * Exported for the #983 regression test.
 */
export type ConfigurationSection =
	| Record<string, unknown>
	| unknown[]
	| string
	| number
	| boolean
	| null;

export function resolveConfigurationSection(
	initialization: Record<string, unknown> | undefined,
	section: string | undefined,
): ConfigurationSection {
	if (!initialization) return section ? null : {};
	if (!section) return initialization;
	let cur: unknown = initialization;
	for (const part of section.split(".")) {
		if (typeof cur !== "object" || cur === null || !Object.hasOwn(cur, part)) {
			return null;
		}
		cur = (cur as Record<string, unknown>)[part];
	}
	return cur as ConfigurationSection;
}

// Exported (only) so tests can invoke the publishDiagnostics notification
// handler directly against a mock LSPClientState/connection without spawning
// a real language server. Not part of the public client API surface.
export function setupIncomingHandlers(
	state: LSPClientState,
	initialization: Record<string, unknown> | undefined,
): void {
	state.connection.onNotification(
		"textDocument/publishDiagnostics",
		(params: {
			uri: string;
			diagnostics?: LSPDiagnostic[];
			version?: number;
		}) => {
			// #1639: the settle operation's own clock for THIS publish. A
			// "quiet-window" settle's durationMs below measures from here (when
			// this publish arrived and — armed or re-armed — the debounce timer)
			// to when that timer actually fires, i.e. the real debounce wait, not
			// time-since-didOpen.
			const publishReceivedAt = Date.now();
			const filePath = uriToPath(params.uri);
			const normalizedPath = normalizeMapKey(filePath);
			// A server can flush a queued publish after didClose during teardown.
			// Do not resurrect diagnostics or their content binding for a document
			// that is no longer open on this client.
			if (state.closedDocuments?.has(normalizedPath)) return;
			const newDiags = normalizeLspDiagnostics(params.diagnostics || []);
			const docVersion = params.version;
			if (PUB_DEBUG) {
				// #1333: PUB_DEBUG gate preserved; sink is extension.log.
				logExtension({
					subsystem: "lsp-pub",
					level: "debug",
					message: `server=${state.serverId} pubVersion=${docVersion} docVersion=${state.documentVersions?.get(normalizedPath)} diags=${newDiags.length}`,
				});
			}
			const strategy = getStrategy(state.serverId, state.launchVariant);
			// Publication counting and code extraction exist only for the
			// TypeScript diagnostic-sequence telemetry; skip the bookkeeping for
			// every other push server on this hot receive path.
			const isTypeScriptTelemetry = state.serverId === "typescript";
			const publicationIndex = isTypeScriptTelemetry
				? (state.diagnosticPublicationCounts.get(normalizedPath) ?? 0) + 1
				: 0;
			if (isTypeScriptTelemetry) {
				state.diagnosticPublicationCounts.set(normalizedPath, publicationIndex);
			}
			const diagnosticCodes = isTypeScriptTelemetry
				? [
						...new Set(
							newDiags
								.map((diagnostic) => diagnostic.code)
								.filter((code): code is string | number => code !== undefined)
								.map(String),
						),
					].slice(0, 8)
				: [];
			// #1639: `durationMs` measures the settle operation, never
			// time-since-didOpen — document age keeps its own honest name in
			// `metadata.elapsedSinceDidOpenMs`, exactly like the pull-path
			// producer above. Before this fix EVERY call (settled or not) logged
			// the doc-age value as durationMs, which is what actually produced
			// the issue's cited evidence: this push-path producer, not the pull
			// path, emitted all 239 records (147 of them >60s "durations" for
			// settles that took milliseconds; a 61ms same-file pair is this
			// function's OWN unsettled-then-settled shape — the
			// `logSequence(false)` raw-receipt record immediately followed by
			// the `logSequence(true, ...)` settle record for the same publish).
			// - "first-push": settles immediately — the seed-first-push strategy
			//   bypasses the debounce timer entirely, so there is no wait to
			//   measure; durationMs is 0.
			// - "quiet-window": the real debounce wait, timed from THIS publish's
			//   own receipt (a later publish that re-arms the timer captures its
			//   OWN `publishReceivedAt`, so a re-armed wait is timed from the
			//   push that actually won the debounce, not the first one that lost
			//   it).
			// - "publication": a raw per-publication receipt, never itself a
			//   settle — durationMs is 0 and `settledReturn` stays false. This
			//   is the record that used to log with NO settleSource at all;
			//   giving it one closes AC3 (distinguish, don't silently overload,
			//   the phase's two shapes) for the pairs that actually occur.
			const logSequence = (
				settledReturn: boolean,
				settleSource: "first-push" | "quiet-window" | "publication",
				durationMs: number,
			): void => {
				if (state.serverId !== "typescript") return;
				const elapsedSinceDidOpenMs = Math.max(
					0,
					Date.now() -
						(state.documentOpenedAt.get(normalizedPath) ?? Date.now()),
				);
				logLatency({
					type: "phase",
					phase: "lsp_typescript_diagnostic_sequence",
					filePath: normalizedPath,
					durationMs,
					metadata: {
						serverId: state.serverId,
						outcome: settledReturn ? "settled" : "published",
						launchVariant: state.launchVariant ?? "unknown",
						publicationIndex,
						version: docVersion ?? "push-unversioned",
						diagnosticCount: newDiags.length,
						diagnosticCodes,
						elapsedSinceDidOpenMs,
						settledReturn,
						settleSource,
					},
				});
			};
			// Record the document version these diagnostics were computed against
			// (when the server reports it) so waitForDiagnostics can reject results
			// that lag behind the latest didChange instead of serving them as fresh.
			const recordDocVersion = (): void => {
				if (docVersion !== undefined) {
					state.diagnosticDocVersions.set(normalizedPath, docVersion);
				}
				recordBinding();
			};
			// #1095: bind the just-stored diagnostics to the content they were
			// computed against. Only when the server reported a version AND we still
			// hold the sent-content fingerprint for exactly that version — otherwise
			// no contentHash is recorded, so the binding reads "unknown" and a
			// version-less server behaves exactly as before. Runs at the same
			// write-time moment as `pushDiagnostics.set` (superseded pushes are
			// dropped before this via `isSupersededPush`, so a binding never lags the
			// latest sent version).
			const recordBinding = (): void => {
				if (docVersion === undefined) {
					state.diagnosticBindings.delete(normalizedPath);
					return;
				}
				const sent = state.documentContentHashes.get(normalizedPath);
				state.diagnosticBindings.set(normalizedPath, {
					version: docVersion,
					contentHash:
						sent && sent.version === docVersion ? sent.hash : undefined,
				});
			};

			// Late/superseded-push guard: if the server stamped this push with a
			// version and that version already lags the latest didChange we sent,
			// this is analysis for an edit that's since been overtaken — caching it
			// would let getDiagnostics()/getAllDiagnostics()/pruneDiagnostics() (none
			// of which consult isVersionStale — that check only gates the *wait*
			// helper below) serve stale results as current until the next genuinely
			// fresh push overwrites them. Drop it before it reaches the cache instead.
			// Checked at write time (not at notification-receipt time) so a push that
			// arrives fresh but whose debounce timer fires after a later didChange is
			// still caught. Version-less servers (docVersion undefined) are
			// unaffected — that's an intentional, separate tradeoff (see
			// isVersionStale below), not something this guard touches.
			//
			// Known, deliberately out-of-scope gaps: the pull-diagnostics path
			// (clientRequestPullDiagnostics/clientRequestWorkspaceDiagnostics) has no
			// version stamp to compare against in this codebase's current handling,
			// so nothing analogous is applied there. The other gap this note used to
			// record — `diagnosticsVersion` being a single global counter, so an
			// unrelated path's fresh push satisfied a wait for THIS path — is closed by
			// #1531: every bump also stamps `diagnosticsVersionsByPath`, and both the
			// `minVersion` freshness gate and the auxiliary answered/silent evidence
			// check read that per-path stamp.
			const isSupersededPush = (): boolean => {
				if (docVersion === undefined) return false;
				const currentVersion = state.documentVersions.get(normalizedPath);
				return currentVersion !== undefined && docVersion < currentVersion;
			};

			// Seed on first push for servers whose first push is known complete.
			// Bypasses the debounce timer entirely — resolves waiting promises immediately.
			if (
				strategy.seedFirstPush &&
				!state.pushDiagnostics.has(normalizedPath)
			) {
				if (isSupersededPush()) return;
				state.pushDiagnostics.set(normalizedPath, newDiags);
				state.pushDiagnosticTimestamps.set(normalizedPath, Date.now());
				recordDocVersion();
				bumpDiagnosticsVersion(state, normalizedPath);
				state.diagnosticEmitter.emit("diagnostics", normalizedPath);
				// Immediate settle — no debounce wait to measure.
				logSequence(true, "first-push", 0);
				return;
			}
			// A raw per-publication receipt, not itself a settle.
			logSequence(false, "publication", 0);

			const existingTimer = state.pendingDiagnostics.get(normalizedPath);
			if (existingTimer) clearTimeout(existingTimer);

			const timer = setTimeout(() => {
				state.pendingDiagnostics.delete(normalizedPath);
				if (isSupersededPush()) return;
				state.pushDiagnostics.set(normalizedPath, newDiags);
				state.pushDiagnosticTimestamps.set(normalizedPath, Date.now());
				recordDocVersion();
				bumpDiagnosticsVersion(state, normalizedPath);
				state.diagnosticEmitter.emit("diagnostics", normalizedPath);
				// The real debounce wait, timed from THIS publish's own receipt.
				logSequence(true, "quiet-window", Date.now() - publishReceivedAt);
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
				registerOptions?: {
					commands?: unknown;
					identifier?: unknown;
					workspaceDiagnostics?: unknown;
				};
			}>;
		}) => {
			for (const reg of params?.registrations ?? []) {
				const options = reg.registerOptions;
				const commands = Array.isArray(options?.commands)
					? options.commands.filter(
							(cmd): cmd is string => typeof cmd === "string",
						)
					: undefined;
				if (reg.id && reg.method) {
					// #1667: keep the whole registration, not just its method. An empty
					// `identifier` is treated as absent - it names no source, and
					// sending `identifier: ""` would be a second, indistinguishable
					// bare pull.
					state.dynamicRegistrations.set(reg.id, {
						method: reg.method,
						...(typeof options?.identifier === "string" && options.identifier
							? { identifier: options.identifier }
							: {}),
						...(typeof options?.workspaceDiagnostics === "boolean"
							? { workspaceDiagnostics: options.workspaceDiagnostics }
							: {}),
						...(commands ? { commands } : {}),
					});
				}
				// executeCommand commands can arrive dynamically too — merge them
				// into the allowlist so dynamically-registered commands are runnable.
				if (reg.method === "workspace/executeCommand" && commands) {
					for (const cmd of commands) state.advertisedCommands.add(cmd);
				}
			}
			applyDynamicCapabilities(state);
		},
	);
	state.connection.onRequest(
		"client/unregisterCapability",
		async (params: { unregisterations?: Array<{ id: string }> }) => {
			const retiredIdentifiers = new Set<string>();
			for (const unreg of params?.unregisterations ?? []) {
				if (!unreg.id) continue;
				const registration = state.dynamicRegistrations.get(unreg.id);
				state.dynamicRegistrations.delete(unreg.id);
				if (
					registration?.method === "textDocument/diagnostic" &&
					registration.identifier
				) {
					retiredIdentifiers.add(registration.identifier);
				}
			}
			// #1667: a retired source's cached findings and resultId must go with
			// it, or the union keeps serving them. Checked after the deletes above,
			// and only when NO surviving registration still speaks for that
			// identifier.
			const stillRegistered = new Set(
				[...state.dynamicRegistrations.values()]
					.filter((r) => r.method === "textDocument/diagnostic")
					.map((r) => r.identifier),
			);
			for (const identifier of retiredIdentifiers) {
				if (!stillRegistered.has(identifier)) {
					retirePullSource(state, identifier);
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
		async (params: {
			edit?: { changes?: unknown; documentChanges?: unknown };
		}): Promise<{ applied: boolean; failureReason?: string }> => {
			if (state.serverEditsAllowed <= 0 || !params?.edit) {
				return { applied: false, failureReason: "edit not solicited" };
			}
			const context =
				(state.activeMutationDepth ?? 0) === 1
					? state.activeMutationContext
					: undefined;
			const telemetryContext: LspMutationContext = context ?? {
				cwd: state.root,
				correlationId: newLspMutationCorrelationId(),
				tool: "lsp-workspace-applyEdit",
				source: "lsp-edit",
			};
			try {
				await applyWorkspaceEdit(
					params.edit as Parameters<typeof applyWorkspaceEdit>[0],
					state.root,
					{
						positionEncoding: state.positionEncoding,
						documentVersions: state.documentVersions,
						mutationContext: telemetryContext,
					},
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
	// #983: the LSP spec requires the response array to have exactly one entry
	// per requested item, each resolved against that item's `section` (a
	// dot-path into the server's config, e.g. "scan.jobs") — not a fixed
	// single-element array duplicating the whole blob for every item. An item
	// with no `section` gets the whole blob (that's what "no section" means
	// per spec); an unresolvable section gets `null`, never the whole blob.
	state.connection.onRequest(
		"workspace/configuration",
		async (params: { items?: Array<{ section?: string }> }) => {
			const items = params?.items ?? [];
			return items.map((item) =>
				resolveConfigurationSection(initialization, item?.section),
			);
		},
	);
	state.connection.onRequest("window/workDoneProgress/create", async () => {});
	// #1669: a server can send `workspace/diagnostic/refresh` (typically after a
	// project-wide config change) to say every pull result it has already
	// reported may be stale. Left unhandled, vscode-jsonrpc replies
	// MethodNotFound to a server explicitly telling us its results are stale —
	// this is exactly the signal `workspacePullResultCache` and the persisted
	// workspace-diagnostics cache want (the #1461 family, server-initiated for
	// once). Reply null per spec and drop both so the NEXT pull recomputes
	// instead of replaying — or inheriting an `unchanged` basis from — results
	// the server just told us to distrust.
	// #1669 review R1: single-flight coalescing latch for the re-pull pool
	// below, scoped to THIS client (one `setupIncomingHandlers` call per
	// connection). A refresh FLOOD — a watch-mode rebuild or a `git checkout`
	// can legitimately fire many `workspace/diagnostic/refresh` requests in a
	// tight burst — used to queue one independent capped pool PER refresh:
	// N refreshes meant N pools running concurrently (peak concurrency N x
	// the per-pool cap) and N full passes over every open document (N x
	// redundant pulls for the SAME documents). `refreshRepullRunning` gates a
	// SECOND pool from ever starting while one is already in flight;
	// `refreshRepullRerunRequested` remembers that at least one more refresh
	// arrived meanwhile and coalesces it into exactly ONE trailing rerun
	// after the current pool finishes, using a FRESH snapshot of open
	// documents at rerun time (not the stale list from whenever the burst
	// started) — so an arbitrarily large burst still costs at most 2 passes
	// and never more than `REFRESH_REPULL_CONCURRENCY` pulls at once.
	let refreshRepullRunning = false;
	let refreshRepullRerunRequested = false;

	const runRefreshRepullPool = async (): Promise<void> => {
		do {
			refreshRepullRerunRequested = false;
			const toRepull =
				state.workspaceDiagnosticsSupport.mode === "pull"
					? [...state.openDocuments]
					: [];
			if (toRepull.length > 0) {
				try {
					await mapWithConcurrency(
						toRepull,
						REFRESH_REPULL_CONCURRENCY,
						async (normalizedPath) => {
							const uri = state.openDocumentUris?.get(normalizedPath);
							const filePath = uri ? uriToPath(uri) : normalizedPath;
							await clientRequestPullDiagnostics(state, filePath);
						},
					);
				} catch (err) {
					// #1669 review N2: rejections are observed, never
					// `void`-swallowed — `clientRequestPullDiagnostics` itself never
					// throws (it returns an `unavailable` outcome), so this only
					// fires on a genuine programming error, but a silent throw
					// inside `mapWithConcurrency`'s `Promise.all` must not vanish.
					incrementDegradationCount({
						kind: "lsp-pull-unconfirmed",
						subject: state.serverId,
						reason: `refresh re-pull threw: ${err instanceof Error ? err.message : String(err)}`,
					});
				}
			}
			// A refresh that arrived WHILE this pool was running gets exactly
			// one more pass, never a pass per refresh.
		} while (refreshRepullRerunRequested);
		refreshRepullRunning = false;
	};

	state.connection.onRequest("workspace/diagnostic/refresh", async () => {
		state.workspacePullResultCache.clear();
		// #1669 review F1: clear every on-disk sweep cache this process has
		// recorded a cwd for — `state.root` alone is a per-SERVER identity
		// marker that a monorepo/multi-root project routinely nests BELOW the
		// real sweep cwd, so clearing ONLY there would miss the cache file the
		// sweep actually reads/writes. See the doc comment on
		// `clearAllWorkspaceDiagnosticsCaches`.
		clearAllWorkspaceDiagnosticsCaches();
		// #1669 review N3: ALSO clear at `state.root` directly. The registry
		// above only knows cwds a sweep has already run under IN THIS PROCESS —
		// a refresh arriving before this project's first sweep this process
		// (e.g. right after a respawn) would otherwise clear nothing at all,
		// and a later sweep would load the untouched, now-genuinely-stale
		// on-disk cache a PRIOR process/session left behind. `state.root` is
		// the one cwd this handler can always reach regardless of registry
		// state — a cheap, durable backstop for the common single-root case
		// where root and sweep cwd coincide. It does NOT cover a monorepo
		// subproject a sweep hasn't reached yet under a DIFFERENT cwd than
		// `state.root` — that residual gap is tracked in #1707, not silently
		// claimed as solved (see `clearAllWorkspaceDiagnosticsCaches`'s doc
		// comment for the full shape).
		clearWorkspaceDiagnosticsCacheAtAndAbove(state.root);
		// #1669 review F3: a server-initiated "everything may be stale" signal
		// must drop the SAME per-document state a normal resync already drops
		// via `clearDiagnosticsForPath` (pullResultIds, pushDiagnostics,
		// documentPullDiagnostics, diagnosticBindings,
		// diagnosticsVersionsByPath, ...) — dropping only
		// `workspacePullResultCache` above left every open document's OTHER
		// pull state intact, so the next pull would echo a disowned
		// `previousResultId`, get back `kind: "unchanged"`, and re-confirm
		// stale diagnostics under a fresh timestamp; nothing would ever
		// re-pull on its own. This clear is cheap and always runs — every
		// refresh in a burst gets its own, unlike the re-pull pool below.
		for (const normalizedPath of state.openDocuments) {
			clearDiagnosticsForPath(state, normalizedPath);
		}
		// #1669 review N2: reply to the PROTOCOL request now — every clear
		// above is synchronous and already complete, so there is nothing left
		// this reply should wait on. The re-pull below is a background
		// improvement (so an open document reflects the refresh without
		// waiting on its next edit), never something worth delaying — or
		// risking — the required `null` reply over.
		if (
			state.workspaceDiagnosticsSupport.mode === "pull" &&
			state.openDocuments.size > 0
		) {
			if (refreshRepullRunning) {
				// #1669 review R1: a pool is already in flight from an earlier
				// refresh in this burst — coalesce instead of starting a second
				// one.
				refreshRepullRerunRequested = true;
			} else {
				refreshRepullRunning = true;
				// `setImmediate` defers even the SYNCHRONOUS prefix of the pool
				// (URI lookups, map bookkeeping) to the next tick, so it can
				// never compete with this reply for the current one regardless
				// of how many documents are open.
				setImmediate(() => {
					void runRefreshRepullPool();
				});
			}
		}
		return null;
	});
}

/**
 * #1127: record the FIRST moment this client observed its own death. Detection
 * of a dead client (the next `getClientForFile` attach in index.ts) can happen
 * long after the process actually died — this timestamp is the only reliable
 * "when did it die" signal, so it must be set here, at the earliest death
 * signal, not derived later from detection time.
 */
function markExitedIfUnset(state: LSPClientState): void {
	if (state.exitedAt === undefined) {
		state.exitedAt = Date.now();
	}
}

function setupConnectionLifecycle(
	state: LSPClientState,
	recentStderr: (lines?: number) => string,
): void {
	state.connection.onError(([error]: [Error, ...unknown[]]) => {
		state.lastError = error instanceof Error ? error : new Error(String(error));
		state.isConnected = false;
		state.isDestroyed = true;
		markExitedIfUnset(state);
		disposeClientConnection(state);
	});

	state.connection.onClose(() => {
		state.isConnected = false;
		state.isDestroyed = true;
		markExitedIfUnset(state);
		disposeClientConnection(state);
	});

	state.lspProcess.process.on("exit", (code, signal) => {
		// Gate on shutdownRequested (our own clientShutdown() call), not
		// isConnected: a genuine crash's connection.onClose/onError handler above
		// can fire and flip isConnected false BEFORE this 'exit' event arrives,
		// which used to make the old `wasConnected` check silently swallow every
		// crash whose transport died before the process itself reported exiting
		// (previously: 5 ast-grep deaths during a dogfooding sweep logged only
		// "respawn, uptime=Xms" — no exit code, no signal, no stderr — because
		// none of them tripped this log).
		const wasIntentional = state.shutdownRequested;
		state.isConnected = false;
		state.isDestroyed = true;
		markExitedIfUnset(state);
		disposeClientConnection(state);
		if (!wasIntentional) {
			logLatency({
				type: "phase",
				phase: "lsp_server_unexpected_exit",
				filePath: state.root,
				durationMs: 0,
				metadata: {
					serverId: state.serverId,
					pid: state.lspProcess.pid,
					exitCode: code ?? null,
					exitSignal: signal ?? null,
					stderrTail: recentStderr(20),
				},
			});
		}
	});

	// #1969: the exit CAUSE, in the degradation ledger.
	//
	// The `exit` log above is one latency.log line per death. That line is
	// necessary but not sufficient: an ast-grep child died 14 times in one day
	// with `code=1` and empty stderr, and the only thing visible downstream was
	// 19 `lsp_client_skipped_broken` cooldowns and 32 coverage gaps — fallout
	// with no cause attached. The ledger is what a session-end health read
	// looks at, so the cause belongs there too, counted per server.
	//
	// `close` rather than `exit`: `close` fires only after the child's stdio
	// streams have drained, so "stderr was empty" is a statement about the
	// server rather than a race against the pipe. `exit` can arrive first with
	// stderr still buffered.
	//
	// Gated on `shutdownRequested` exactly as the exit log is — an eviction or
	// an ordinary teardown is not a degradation and must not be recorded.
	// `incrementDegradationCount` counts every occurrence and retains the
	// latest reason per server, so a server dying in a loop shows as one entry
	// with an honest count rather than N entries.
	state.lspProcess.process.on("close", (code, signal) => {
		if (state.shutdownRequested) return;
		try {
			const stderrTail = recentStderr(20);
			incrementDegradationCount({
				kind: "lsp-server-unexpected-close",
				subject: state.serverId,
				reason:
					`closed unprompted: code=${code ?? "none"} signal=${signal ?? "none"} ` +
					`stderr=${stderrTail.length > 0 ? `present(${stderrTail.length}b)` : "empty"} root=${state.root}`,
			});
		} catch {
			// Telemetry must never break the observed path.
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

/**
 * One diagnostic SOURCE's outcome. `primaryCount` is the part of `count` that
 * belongs to the REQUESTED file — `count` also includes `relatedDocuments`.
 * The fan-out races on `primaryCount` because "the answer arrived" means the
 * file the caller asked about has an answer, not that some other document did.
 */
type PullSourceOutcome =
	| { status: "found"; count: number; primaryCount: number }
	| { status: "clean" }
	| { status: "unavailable" };

/** Margin between each source's own request timeout and the race's backstop
 *  deadline, so the natural "all sources settled" path wins over the backstop
 *  and the race never reports `unavailable` for sources that did answer. */
const PULL_RACE_BACKSTOP_MARGIN_MS = 25;

/**
 * #1667: pull EVERY registered diagnostic source for a file, in parallel, and
 * answer as soon as the first source returns findings for that file.
 *
 * Roslyn, vtsls and some Java setups register `textDocument/diagnostic` once
 * per source (syntax, semantic, analyzers), each named by
 * `registerOptions.identifier`. One bare request asks only the server's default
 * source, so whole categories of findings were never requested. The fan-out
 * asks all of them plus the bare request.
 *
 * Timing is deliberate and load-bearing:
 *  - PARALLEL, never one source after another. Sequencing would add every
 *    slow source's latency to every touch.
 *  - The race resolves on the FIRST source with findings for the file, with no
 *    settle or debounce window after the match. A post-match wait is the exact
 *    latency shape #1112/#1407 already cost this codebase once.
 *  - Losing sources are NOT cancelled. Each source writes its own findings into
 *    the pull cache before it resolves, so a late answer merges in the
 *    background and the NEXT read of the file sees it. Late answers are not
 *    dropped, they are just not waited for.
 *
 * The race runs inside the existing `raceToCompletion` primitive rather than a
 * second first-wins helper.
 */
async function clientRequestPullDiagnostics(
	state: LSPClientState,
	filePath: string,
	budgetMs: number = PULL_REQUEST_TIMEOUT_MS,
): Promise<PullDiagnosticsOutcome> {
	if (!isClientAlive(state)) return { status: "unavailable" };
	const sources = pullDiagnosticSources(state);
	if (sources.length === 1) {
		// The overwhelmingly common case: no named sources registered. Skip the
		// race entirely so a single-source server pays nothing for this feature.
		return aggregatePullOutcomes(state, filePath, [
			await pullDiagnosticSource(state, filePath, budgetMs, undefined),
		]);
	}

	const attempts = sources.map((identifier) =>
		pullDiagnosticSource(state, filePath, budgetMs, identifier),
	);
	const settled = await raceToCompletion(
		attempts,
		(results) =>
			results.some((r) => r.status === "found" && r.primaryCount > 0),
		{
			// No graceMs: finalize the instant a source answers for this file.
			// The per-request `withTimeout` inside each attempt is the real bound;
			// this deadline is only a backstop, so it sits just past it.
			timeoutMs:
				Math.max(1, Math.min(PULL_REQUEST_TIMEOUT_MS, budgetMs)) +
				PULL_RACE_BACKSTOP_MARGIN_MS,
		},
	);
	return aggregatePullOutcomes(state, filePath, settled);
}

/**
 * Collapse the sources that answered into one outcome for the caller.
 * `found` beats `clean` beats `unavailable`: a source with findings is an
 * answer, an authoritative empty report is an answer, and only "nobody
 * answered" is unavailable (#240 — an empty result must distinguish clean
 * from errored).
 */
function aggregatePullOutcomes(
	state: LSPClientState,
	filePath: string,
	outcomes: PullSourceOutcome[],
): PullDiagnosticsOutcome {
	const found = outcomes.filter((o) => o.status === "found");
	if (found.length > 0) {
		const normalizedPath = normalizeMapKey(filePath);
		// The union for the requested file, which is what a caller reading the
		// cache will see. A source that only reported `relatedDocuments` findings
		// contributes nothing there, so fall back to its own count.
		const unionCount =
			state.documentPullDiagnostics.get(normalizedPath)?.length ?? 0;
		return {
			status: "found",
			count: Math.max(unionCount, ...found.map((o) => o.count)),
		};
	}
	// #240, applied across sources: `clean` is an authoritative "this file has no
	// findings", and one source saying so proves nothing about a source that
	// FAILED to answer. A fan-out where any source errored is therefore
	// unavailable, not clean - the caller falls through to the push-wait/timeout
	// backstop instead of recording a confirmed-clean touch it cannot support.
	// (`raceToCompletion` drops still-pending promises from its result array, so
	// "every source settled, none errored" is the only shape that reads clean.)
	if (outcomes.some((o) => o.status === "unavailable")) {
		return { status: "unavailable" };
	}
	return outcomes.some((o) => o.status === "clean")
		? { status: "clean" }
		: { status: "unavailable" };
}

async function pullDiagnosticSource(
	state: LSPClientState,
	filePath: string,
	budgetMs: number,
	identifier: string | undefined,
): Promise<PullSourceOutcome> {
	if (!isClientAlive(state)) return { status: "unavailable" };
	const normalizedPath = normalizeMapKey(filePath);
	// #1773: a budget at or below the usable floor cannot complete a real
	// round trip. Skip the dispatch entirely — no `safeSendRequest` call, no
	// generation/sequence claim — and say so with a distinct record, so
	// `lsp_pull_diagnostic_timeout` only ever means a pull was genuinely
	// attempted. The caller sees the same `unavailable` outcome a timeout
	// would have produced (#240: unavailable, never a false clean), so
	// nothing downstream of this call changes shape.
	if (budgetMs < PULL_MIN_USABLE_BUDGET_MS) {
		emitBounded(
			"lsp_pull_skipped_budget_exhausted",
			`${state.serverId}::${pullSourceKey(normalizedPath, identifier)}`,
			{
				type: "phase",
				filePath: normalizedPath,
				durationMs: 0,
				metadata: {
					identifier: identifier ?? "bare",
					remainingBudgetMs: budgetMs,
					server: state.serverId,
				},
			},
			{
				ledgerKind: "lsp-pull-skipped-budget-exhausted",
				reason: `pull skipped on ${state.serverId}: budget already exhausted (${budgetMs}ms remaining)`,
			},
		);
		return { status: "unavailable" };
	}
	const uri = pathToFileURL(filePath).href;
	// #1104: echo the last resultId we hold for this document so a server that
	// hasn't changed its view can answer `kind: "unchanged"` instead of
	// recomputing — see the `kind === "unchanged"` branch below for how that's
	// honored (inherit, never treat an omitted `items` as clean).
	// #1667: read THIS source's id, never another source's. Result ids are
	// issued per source, so echoing a syntax id on a semantic request asks the
	// server to compare against a basis it never handed out.
	const sourceKey = pullSourceKey(normalizedPath, identifier);
	if (state.abandonedPullRequests?.has(sourceKey)) {
		return { status: "unavailable" };
	}
	const previousResultId = state.pullResultIds.get(sourceKey);
	// #1667: the generation this pull was computed against. A resync landing
	// while the request is in flight bumps it, and every write below is dropped
	// rather than resurrecting state the resync cleared.
	const generation = pullGenerationFor(state, normalizedPath);
	// #1667: claim the newest-request slot for THIS source. Two fan-outs can
	// overlap for the same file with no resync between them (`ensureWarmForSweep`
	// touches, then the real touch follows ~60ms later), so the generation check
	// alone would let a slow answer from the earlier round land on top of a newer
	// one. Re-checked at write time below.
	const requestSequence = claimPullRequestSequence(state, sourceKey);
	// #1889: give the request a cancellation token. `withTimeout` only abandons
	// its await; aborting in the timeout branch below also sends `$/cancelRequest`
	// so repeated touches cannot leave an aging backlog inside the server.
	const requestStartedAt = Date.now();
	const effectiveTimeoutMs = Math.max(
		1,
		Math.min(PULL_REQUEST_TIMEOUT_MS, budgetMs),
	);
	const pullAbort = new AbortController();
	const pullSettlement = { cancelled: false };
	const requestPromise = safeSendRequest<{
		kind?: string;
		resultId?: string;
		items?: LSPDiagnostic[];
		relatedDocuments?: Record<
			string,
			{ kind?: string; resultId?: string; items?: LSPDiagnostic[] }
		>;
	}>(
		state.connection,
		"textDocument/diagnostic",
		{
			textDocument: { uri },
			// #1667: name the source this request is for, so the server answers
			// from that source instead of its default one.
			...(identifier !== undefined && { identifier }),
			...(previousResultId !== undefined && { previousResultId }),
		},
		pullAbort.signal,
		pullSettlement,
	);
	try {
		// withTimeout is the backstop against a hung pull-mode server: without it
		// this await never settles unless the stream is destroyed. Bounded by the
		// smaller of the absolute ceiling and the caller's remaining wait budget.
		// On timeout the caught error yields `unavailable` below (never a false
		// `clean`), so it falls through to the push-wait/timeout backstop.
		const report = await withTimeout(requestPromise, effectiveTimeoutMs);

		if (!report) {
			recordPullFailure(
				state,
				"textDocument/diagnostic",
				new Error("empty response"),
			);
			return { status: "unavailable" };
		}

		const now = Date.now();
		// #1104: the fingerprint of the content we last sent for this document —
		// the SAME `documentContentHashes` entry the push binding path uses
		// (`recordSentContent` runs unconditionally on every didOpen/didChange,
		// regardless of push/pull mode), so this costs no extra read. A pull
		// response describes whatever the server had when it answered, which for
		// a pi-lens-opened document is exactly that last-sent payload.
		const sentHash = state.documentContentHashes.get(normalizedPath)?.hash;
		// #1667: two ways this answer can already be obsolete, and neither may
		// write. Report the round trip as unavailable - a superseded answer is not
		// evidence the file is clean (#240).
		//  - A resync landed while the request was in flight, so these findings
		//    describe content that no longer exists.
		//  - A LATER request for this same source has already been issued (an
		//    overlapping fan-out), so this answer is the stale loser and would
		//    clobber the newer result.
		if (
			pullGenerationFor(state, normalizedPath) !== generation ||
			!isNewestPullRequest(state, sourceKey, requestSequence)
		) {
			return { status: "unavailable" };
		}
		let primaryCount: number;
		if (report.kind === "unchanged") {
			// #1104: same resultId basis as last time — an omitted `items` here
			// means "no change", NOT "clean". Overwriting with `[]` would be the
			// exact false-clean shape #570/#571 already fixed for the touch path;
			// keep the previously stored diagnostics and binding as-is.
			// #1667: "the previously stored diagnostics" means THIS SOURCE's, so
			// one source reporting unchanged neither inherits nor disturbs another
			// source's findings for the same file.
			primaryCount = pullSourceDiagnostics(
				state,
				normalizedPath,
				identifier,
			).length;
			// Still a fresh confirmation as of `now` even though the content is
			// unchanged — bump the timestamp so `getAllDiagnostics()` doesn't read
			// this entry as aging purely because the server had nothing new to say.
			state.documentPullDiagnosticTimestamps.set(normalizedPath, now);
		} else {
			const primaryItems = normalizeLspDiagnostics(report.items ?? []);
			// #1667: replace only this source's slice; `documentPullDiagnostics`
			// becomes the deduped union of every source that has reported.
			storePullSourceDiagnostics(
				state,
				normalizedPath,
				identifier,
				primaryItems,
			);
			state.documentPullDiagnosticTimestamps.set(normalizedPath, now);
			bumpDiagnosticsVersion(state, normalizedPath);
			state.diagnosticBindings.set(normalizedPath, { contentHash: sentHash });
			primaryCount = primaryItems.length;
		}
		let totalCount = primaryCount;
		if (report.resultId !== undefined) {
			state.pullResultIds.set(sourceKey, report.resultId);
		} else {
			state.pullResultIds.delete(sourceKey);
		}

		// #1531 note (pre-existing, unchanged): a related document's diagnostics are
		// STORED below but earn no version bump and therefore no per-path stamp —
		// exactly as before, since this loop never bumped the global counter either.
		// A wait on a path that only ever hears about itself through some other
		// document's `relatedDocuments` sees no freshness evidence and rides its
		// timeout. Direction is under-detection, and correcting it means deciding
		// what a related-document publication is evidence OF (its binding is
		// honestly "unknown" per #1104), so it stays out of scope here.
		if (report.relatedDocuments) {
			for (const [relatedUri, related] of Object.entries(
				report.relatedDocuments,
			)) {
				const relatedPath = uriToPath(relatedUri);
				const relatedNormalized = normalizeMapKey(relatedPath);
				// #1667: a related document's report belongs to the SAME source as
				// the request that carried it, so it stores and inherits under that
				// source's key too.
				if (related?.kind === "unchanged") {
					totalCount += pullSourceDiagnostics(
						state,
						relatedNormalized,
						identifier,
					).length;
					state.documentPullDiagnosticTimestamps.set(relatedNormalized, now);
				} else {
					const relatedItems = normalizeLspDiagnostics(related?.items ?? []);
					storePullSourceDiagnostics(
						state,
						relatedNormalized,
						identifier,
						relatedItems,
					);
					state.documentPullDiagnosticTimestamps.set(relatedNormalized, now);
					// #1104: a related document's diagnostics were NOT computed against
					// content we independently sent/fingerprinted (we never requested
					// it directly) — its binding stays honestly "unknown" rather than
					// borrowing the primary document's hash.
					state.diagnosticBindings.delete(relatedNormalized);
					totalCount += relatedItems.length;
				}
				if (related?.resultId !== undefined) {
					state.pullResultIds.set(
						pullSourceKey(relatedNormalized, identifier),
						related.resultId,
					);
				}
			}
		}

		state.diagnosticEmitter.emit("diagnostics", normalizedPath);
		return totalCount > 0
			? { status: "found", count: totalCount, primaryCount }
			: { status: "clean" };
	} catch (err) {
		if (isPullTimeoutError(err, effectiveTimeoutMs)) {
			trackAbandonedPullRequest(state, sourceKey, requestPromise);
			pullAbort.abort();
			recordPullTimeoutTelemetry({
				scope: normalizedPath,
				identifier,
				effectiveBudgetMs: effectiveTimeoutMs,
				hadPreviousResultId: previousResultId !== undefined,
				elapsedMs: Date.now() - requestStartedAt,
				server: state.serverId,
			});
			armLateAnswerTelemetry({
				requestPromise,
				scope: normalizedPath,
				identifier,
				subject: sourceKey,
				requestStartedAt,
				server: state.serverId,
				settlement: pullSettlement,
			});
		}
		recordPullFailure(state, "textDocument/diagnostic", err);
		return { status: "unavailable" };
	}
}

function trackAbandonedPullRequest(
	state: LSPClientState,
	sourceKey: string,
	requestPromise: Promise<unknown>,
): void {
	if (!state.abandonedPullRequests) state.abandonedPullRequests = new Map();
	state.abandonedPullRequests.set(sourceKey, requestPromise);
	const release = () => {
		if (state.abandonedPullRequests?.get(sourceKey) === requestPromise) {
			state.abandonedPullRequests.delete(sourceKey);
		}
	};
	requestPromise.then(release, release);
}

/**
 * #1713: `withTimeout` rejects with this EXACT message (`clients/deadline-utils.ts`)
 * only when its own timer wins the race — every other rejection is the request
 * itself failing (bad params, dead connection, thrown by the server). Only the
 * timer-won case is a "the answer might still be coming" situation worth a
 * late-answer watch; a request that already failed fast has nothing further to
 * observe.
 */
function isPullTimeoutError(err: unknown, timeoutMs: number): boolean {
	return err instanceof Error && err.message === `Timeout after ${timeoutMs}ms`;
}

/**
 * #1713: every pull timeout emits exactly one bounded latency.log record — the
 * observability gap the issue names (`withTimeout`'s throw previously skipped
 * ALL telemetry for this site). Never throws: telemetry must not perturb the
 * timeout path, which has already decided to return `unavailable` regardless.
 *
 * #1743: routed through `emitBounded`. This phase takes NO rising-edge gate
 * and NO per-turn cap, which is the pre-existing behavior kept exactly: a
 * pull timeout costs at least the full budget (seconds), so the call cadence
 * already bounds the volume, unlike `navRequest` below. The helper still
 * supplies the identity discipline and the registry membership the sweep
 * checks.
 */
function recordPullTimeoutTelemetry(args: {
	scope: string;
	identifier: string | undefined;
	effectiveBudgetMs: number;
	hadPreviousResultId: boolean;
	elapsedMs: number;
	server: string;
}): void {
	// #1771: this record is written on a genuine failure path (a dispatched
	// pull that never answered), so per the bounded-telemetry rule
	// (`clients/bounded-telemetry.ts`) it needs a `ledgerKind`, not just the
	// detailed latency.log record. Before this it counted nothing in the
	// degradation ledger — every occurrence wrote a detail line, but nothing
	// tallied. No `risingEdgePer`: timeouts repeat and every one should count,
	// matching the pre-existing "no rising-edge gate" behavior for the
	// detailed record itself.
	emitBounded(
		"lsp_pull_diagnostic_timeout",
		`${args.server}::${args.scope}::${args.identifier ?? "bare"}`,
		{
			type: "phase",
			filePath: args.scope,
			durationMs: args.elapsedMs,
			metadata: {
				identifier: args.identifier ?? "bare",
				effectiveBudgetMs: args.effectiveBudgetMs,
				hadPreviousResultId: args.hadPreviousResultId,
				server: args.server,
			},
		},
		{
			ledgerKind: "lsp-pull-diagnostic-timeout",
			reason: `pull timeout on ${args.server} after ${args.elapsedMs}ms (budget ${args.effectiveBudgetMs}ms)`,
		},
	);
}

/**
 * #1713: a telemetry-only continuation on the ALREADY-abandoned request
 * promise. `withTimeout` only raced it against a timer — the request is still
 * live server-side — so if it eventually resolves, this is the only place that
 * ever finds out. Purely observational: it runs after the caller has already
 * moved on with `unavailable`, and it never writes into `state`.
 *
 * Bounded via the degradation-ledger convention (`incrementDegradationCount`,
 * chosen over a hand-rolled per-identity rising-edge Set): the ledger already
 * caps entries per kind and re-arms at `session_start`
 * (`resetDegradationLedger`, wired into `handleSessionStart`), so reusing it
 * avoids a second latch this fix would otherwise have to register and reset
 * itself. `subject` is the same `pullSourceKey` (path + identifier) the pull
 * path already uses, so the discriminating identity survives aggregation.
 *
 * Attaching `.then` here creates no timer, socket, or other handle — it only
 * observes a promise the request already created — so it cannot keep the
 * process alive a moment longer than that pending request already does.
 */
function armLateAnswerTelemetry(args: {
	requestPromise: Promise<unknown>;
	scope: string;
	identifier: string | undefined;
	subject: string;
	requestStartedAt: number;
	server: string;
	settlement: { cancelled: boolean };
}): void {
	args.requestPromise.then(
		() => {
			if (args.settlement.cancelled) return;
			try {
				const elapsedMs = Date.now() - args.requestStartedAt;
				// #1743: `emitBounded` counts every late answer in the ledger
				// under the same `pullSourceKey` subject as before, then writes
				// the record. No rising-edge gate, matching #1713's original
				// behavior: a late answer arrives at most once per abandoned
				// request, so the record count cannot exceed the timeout count.
				emitBounded(
					"lsp_pull_late_answer_discarded",
					args.subject,
					{
						type: "phase",
						filePath: args.scope,
						durationMs: elapsedMs,
						metadata: { identifier: args.identifier ?? "bare" },
					},
					{
						ledgerKind: "lsp-pull-late-answer",
						reason: `late pull answer discarded after ${elapsedMs}ms`,
					},
				);
			} catch {
				// Telemetry must never break the observed path.
			}
		},
		(err: unknown) => {
			// #1774: the abandoned request eventually REJECTED rather than
			// answering. Behavior is unchanged — the rejection is still
			// swallowed here, exactly as before — but "timeout then silence"
			// and "timeout then server rejection (e.g. ContentModified)" were
			// previously indistinguishable: `recordPullFailure` at request
			// time reports the FIRST failure only, and this rejection happens
			// strictly after that request already timed out, so it needs its
			// own record. Bounded via the degradation ledger, same shape as
			// the late-answer branch above, so this rejection cannot outpace
			// the timeout count that gates it.
			try {
				const elapsedMs = Date.now() - args.requestStartedAt;
				const candidate = err as { code?: unknown; message?: unknown };
				const code =
					typeof candidate?.code === "number" ||
					typeof candidate?.code === "string"
						? candidate.code
						: undefined;
				emitBounded(
					"lsp_pull_late_rejection",
					// #1774 review: prefix the server, same reason the timeout kind
					// does (#1771). The workspace call site's `subject` is the bare
					// `WORKSPACE_PULL_SCOPE` constant — without the server prefix,
					// two servers' abandoned-workspace-pull rejections would collapse
					// into one ledger subject and hide which server is storming.
					`${args.server}::${args.subject}`,
					{
						type: "phase",
						filePath: args.scope,
						durationMs: elapsedMs,
						metadata: {
							identifier: args.identifier ?? "bare",
							server: args.server,
							...(code !== undefined && { code }),
						},
					},
					{
						ledgerKind: "lsp-pull-late-rejection",
						reason: `late pull rejection ${elapsedMs}ms after timeout${code !== undefined ? ` (code ${code})` : ""}`,
					},
				);
			} catch {
				// Telemetry must never break the observed path.
			}
		},
	);
}

const PULL_FAILURE_HISTORY_LIMIT = 10;

function recordPullFailure(
	state: LSPClientState,
	method: LSPPullFailure["method"],
	error: unknown,
): void {
	const candidate = error as { code?: unknown; message?: unknown };
	const message =
		typeof candidate.message === "string" ? candidate.message : "";
	const unsupportedMessage =
		/^(?:method not found|unknown method|unsupported method)(?::|$)/i;
	if (
		candidate.code === -32601 ||
		candidate.code === "-32601" ||
		unsupportedMessage.test(message.trim())
	)
		return;
	state.pullFailureHistory.push({
		timestamp: Date.now(),
		method,
		...(typeof candidate.code === "number" || typeof candidate.code === "string"
			? { code: candidate.code }
			: {}),
		message:
			typeof candidate.message === "string" ? candidate.message : String(error),
	});
	if (state.pullFailureHistory.length > PULL_FAILURE_HISTORY_LIMIT) {
		state.pullFailureHistory.splice(
			0,
			state.pullFailureHistory.length - PULL_FAILURE_HISTORY_LIMIT,
		);
	}
}

/**
 * One project-wide `workspace/diagnostic` pull — a single request that returns
 * diagnostics for every document the server knows, instead of opening N files.
 * Returns per-file reports, or `undefined` on unsupported/dead/timeout/malformed
 * (caller falls back to the per-file path). `unchanged`-kind items carry no
 * diagnostics and are skipped, so a file absent from the result is "clean".
 */
export async function clientRequestWorkspaceDiagnostics(
	state: LSPClientState,
	budgetMs: number,
): Promise<
	| Array<{
			filePath: string;
			diagnostics: LSPDiagnostic[];
			contentHash?: string;
	  }>
	| undefined
> {
	if (!isClientAlive(state)) return undefined;
	if (!state.workspaceDiagnosticsSupport.workspaceDiagnostics) return undefined;
	if (state.abandonedPullRequests?.has(WORKSPACE_PULL_SCOPE)) return undefined;
	// #1104: echo every resultId we hold from a PRIOR pull so the server can
	// answer `kind: "unchanged"` for files it hasn't recomputed, instead of
	// resending (and us re-hashing) every file on every sweep.
	const previousResultIds = Array.from(
		state.workspacePullResultCache.values(),
	).map((entry) => ({ uri: entry.uri, value: entry.resultId }));
	// #1773: same floor as `pullDiagnosticSource` — an exhausted budget here is
	// the SAME clamp-then-dispatch defect via a second entry point. Observed
	// live in the 2026-08-20 plegma dogfood session via
	// `lsp_workspace_diagnostics_start` (not just the `lens_diagnostics_full`
	// fan-out `pullDiagnosticSource` covers), so this call site needs its own
	// skip, not just a shared helper the caller happens to hit.
	if (budgetMs < PULL_MIN_USABLE_BUDGET_MS) {
		emitBounded(
			"lsp_pull_skipped_budget_exhausted",
			`${state.serverId}::${WORKSPACE_PULL_SCOPE}`,
			{
				type: "phase",
				filePath: WORKSPACE_PULL_SCOPE,
				durationMs: 0,
				metadata: {
					identifier: "bare",
					remainingBudgetMs: budgetMs,
					server: state.serverId,
				},
			},
			{
				ledgerKind: "lsp-pull-skipped-budget-exhausted",
				reason: `workspace pull skipped on ${state.serverId}: budget already exhausted (${budgetMs}ms remaining)`,
			},
		);
		return undefined;
	}
	// #1713: declared OUTSIDE the try so the catch below can still reach them —
	// same shape as `pullDiagnosticSource` above. Captured outside `withTimeout`
	// so a timeout still holds a live handle on the request for the late-answer
	// watch.
	const workspacePullStartedAt = Date.now();
	const workspacePullTimeoutMs = Math.max(1, budgetMs);
	const workspacePullAbort = new AbortController();
	const workspacePullSettlement = { cancelled: false };
	const workspaceRequestPromise = safeSendRequest<{
		items?: Array<{
			uri?: string;
			kind?: string;
			resultId?: string;
			items?: LSPDiagnostic[];
		}>;
	}>(
		state.connection,
		"workspace/diagnostic",
		{ previousResultIds },
		workspacePullAbort.signal,
		workspacePullSettlement,
	);
	try {
		const report = await withTimeout(
			workspaceRequestPromise,
			workspacePullTimeoutMs,
		);
		if (!report || !Array.isArray(report.items)) return undefined;
		const out: Array<{
			filePath: string;
			diagnostics: LSPDiagnostic[];
			contentHash?: string;
		}> = [];
		// #1669 review N1: ONE deadline, shared across every "unchanged, no
		// cached basis" fallback pull this call makes — not a fresh `budgetMs`
		// grant handed to EACH one. A refresh clears `workspacePullResultCache`,
		// so the very next sweep after a refresh can route every item down this
		// path; granting each one the full budget serially turned a bounded call
		// unbounded (measured: 6 files x 300ms budget = 1844ms; worst case is
		// the normal case — 2000 files x 30s). Mirrors the shared-budget shape
		// `runWorkspaceDiagnosticsSwept`'s `perFileMs` bounds each file to,
		// scoped to fallback pulls made from within THIS one call.
		const fallbackPullDeadline = Date.now() + Math.max(1, budgetMs);
		for (const item of report.items) {
			if (!item?.uri) continue;
			const filePath = uriToPath(item.uri);
			const normalizedPath = normalizeMapKey(filePath);
			if (item.kind === "unchanged") {
				// #1104: inherit the prior pull's diagnostics + content binding for
				// the SAME resultId basis — an "unchanged" report never carries
				// `items`, so without this a file the server confirmed unchanged
				// would silently drop out of the sweep result entirely.
				const prior = state.workspacePullResultCache.get(normalizedPath);
				if (!prior) {
					// #1669 review F4: no earlier basis to inherit (e.g. right after a
					// `workspace/diagnostic/refresh` cleared `workspacePullResultCache`)
					// — the server is answering "unchanged" against a resultId basis we
					// no longer hold, so there is nothing honest to report for this
					// file from THIS response. `continue`-ing here would make the file
					// silently absent from `out`, which the caller reads as "clean" —
					// a false clean for a file the server just told us it hasn't even
					// looked at freshly. Treat it as needs-full-pull: request the
					// per-file diagnostic directly instead.
					const remainingMs = fallbackPullDeadline - Date.now();
					if (remainingMs <= 0) {
						// #1669 review N1: the shared fallback-pull deadline is already
						// exhausted by earlier files in this same loop — bail WITHOUT
						// attempting a request (never fabricate clean; this file was
						// never actually asked about) and surface it as unavailable via
						// the same degradation ledger path as a real unavailable pull.
						incrementDegradationCount({
							kind: "lsp-pull-unconfirmed",
							subject: state.serverId,
							reason:
								"unchanged report with no workspacePullResultCache basis; the shared fallback-pull deadline was already exhausted by earlier files this sweep",
						});
						continue;
					}
					const outcome = await clientRequestPullDiagnostics(
						state,
						filePath,
						remainingMs,
					);
					if (outcome.status === "found") {
						out.push({
							filePath,
							diagnostics:
								state.documentPullDiagnostics.get(normalizedPath) ?? [],
							contentHash:
								state.diagnosticBindings.get(normalizedPath)?.contentHash,
						});
					} else if (outcome.status === "unavailable") {
						// Genuinely unconfirmed — never fabricate a clean result. Recorded
						// via the shared degradation ledger (AGENTS.md: repeated
						// degradations use incrementDegradationCount, not a hand-rolled
						// counter) so a server that keeps racing refresh against sweeps
						// is visible in aggregate instead of silently absorbed per-file.
						incrementDegradationCount({
							kind: "lsp-pull-unconfirmed",
							subject: state.serverId,
							reason:
								"unchanged report with no workspacePullResultCache basis, and the per-file fallback pull was unavailable",
						});
					}
					// "clean": genuinely clean, correctly absent from `out`.
					continue;
				}
				if (item.resultId !== undefined) {
					state.workspacePullResultCache.set(normalizedPath, {
						...prior,
						resultId: item.resultId,
					});
				}
				out.push({
					filePath,
					diagnostics: prior.diagnostics,
					contentHash: prior.contentHash,
				});
				continue;
			}
			// "full" (or a non-conforming server omitting `kind`, per the LSP
			// default) — recompute and re-fingerprint.
			const diagnostics = normalizeLspDiagnostics(item.items ?? []);
			// #1104: fingerprint the file bytes active AT REQUEST TIME. Best-effort —
			// a read failure (deleted/unreadable mid-sweep) just leaves contentHash
			// undefined, so the binding reads honestly "unknown", never fabricated.
			let contentHash: string | undefined;
			try {
				contentHash = hashDiagnosticContent(await readFile(filePath, "utf-8"));
			} catch {
				contentHash = undefined;
			}
			if (item.resultId !== undefined) {
				if (
					state.workspacePullResultCache.size >= WORKSPACE_PULL_RESULT_CACHE_MAX
				) {
					state.workspacePullResultCache.clear();
				}
				state.workspacePullResultCache.set(normalizedPath, {
					uri: item.uri,
					resultId: item.resultId,
					diagnostics,
					contentHash,
				});
			} else {
				state.workspacePullResultCache.delete(normalizedPath);
			}
			out.push({ filePath, diagnostics, contentHash });
		}
		return out;
	} catch (err) {
		if (isPullTimeoutError(err, workspacePullTimeoutMs)) {
			trackAbandonedPullRequest(
				state,
				WORKSPACE_PULL_SCOPE,
				workspaceRequestPromise,
			);
			workspacePullAbort.abort();
			recordPullTimeoutTelemetry({
				scope: WORKSPACE_PULL_SCOPE,
				identifier: undefined,
				effectiveBudgetMs: workspacePullTimeoutMs,
				hadPreviousResultId: previousResultIds.length > 0,
				elapsedMs: Date.now() - workspacePullStartedAt,
				server: state.serverId,
			});
			armLateAnswerTelemetry({
				requestPromise: workspaceRequestPromise,
				scope: WORKSPACE_PULL_SCOPE,
				identifier: undefined,
				subject: WORKSPACE_PULL_SCOPE,
				requestStartedAt: workspacePullStartedAt,
				server: state.serverId,
				settlement: workspacePullSettlement,
			});
		}
		recordPullFailure(state, "workspace/diagnostic", err);
		return undefined;
	}
}

export async function clientWaitForDiagnostics(
	state: LSPClientState,
	filePath: string,
	timeoutMs: number,
	options: {
		minVersion?: number;
		pullOnly?: boolean;
		pullSettleSource?: "pull" | "pull-warmup";
	} = {},
): Promise<void> {
	const normalizedPath = normalizeMapKey(filePath);
	const minVersion = options.minVersion;
	const pullSettleSource = options.pullSettleSource ?? "pull";
	// #1531: the freshness gate is PER PATH. `minVersion` is a reading of the
	// client-global counter, and `diagnosticsVersionsByPath` stores that same
	// counter's value at each store — the two are on one axis, so comparing them
	// asks "has a publication landed for THIS file since the baseline?" instead of
	// "has anything at all landed on this client?". Reading the global counter here
	// let a sibling file's publication end this file's wait before its own budget
	// lapsed, which then labelled the outcome row `silent` (reserved for "own
	// budget lapsed with nothing published") instead of `cut_off`.
	const hasFreshDiagnostics = (): boolean =>
		minVersion === undefined ||
		diagnosticsVersionForPath(state, normalizedPath) > minVersion;

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
		// #1639: the settle operation's OWN clock — durationMs on the eventual
		// log record measures from here, never from didOpen (that stays in
		// metadata.elapsedSinceDidOpenMs, computed separately below).
		const pullSettleStartedAt = Date.now();
		let outcome = await clientRequestPullDiagnostics(
			state,
			filePath,
			timeoutMs,
		);
		if (outcome.status === "found") {
			logTypeScriptPullSettle(
				state,
				normalizedPath,
				Date.now() - pullSettleStartedAt,
				pullSettleSource,
			);
			return;
		}
		let sawClean = outcome.status === "clean";

		const strategy = getStrategy(state.serverId, state.launchVariant);
		const retryBudgetMs =
			strategy.pullRetryBudgetMs > 0
				? Math.min(timeoutMs, strategy.pullRetryBudgetMs)
				: 0;
		const startedAt = Date.now();

		// Retry within budget to catch incremental servers whose first pull is
		// empty while analysis is still running (rust-analyzer). A `clean` seen at
		// any point is a valid affirmative answer for this touch.
		while (
			outcome.status !== "found" &&
			Date.now() - startedAt < retryBudgetMs
		) {
			await new Promise((resolve) =>
				setTimeout(resolve, PULL_DIAGNOSTICS_RETRY_INTERVAL_MS),
			);
			outcome = await clientRequestPullDiagnostics(
				state,
				filePath,
				Math.max(0, retryBudgetMs - (Date.now() - startedAt)),
			);
			if (outcome.status === "clean") sawClean = true;
		}
		if (options.pullOnly) {
			if (outcome.status === "found" || sawClean) {
				logTypeScriptPullSettle(
					state,
					normalizedPath,
					Date.now() - pullSettleStartedAt,
					pullSettleSource,
				);
			}
			return;
		}
		if (outcome.status === "found" || sawClean) {
			logTypeScriptPullSettle(
				state,
				normalizedPath,
				Date.now() - pullSettleStartedAt,
				pullSettleSource,
			);
			return;
		}
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
			const strategy = getStrategy(state.serverId, state.launchVariant);
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

/**
 * Queue a watched-files change for a file this client did not learn about
 * through textDocument/didOpen or didChange — an external bash write/delete,
 * or any other disk change outside the open-document sync path (#1668).
 * Shares `handleNotifyOpen`'s per-client debounced queue (#271), so a burst
 * of external changes coalesces into one notification per debounce window
 * instead of flooding the server with one per file.
 */
export function handleNotifyExternalChange(
	state: LSPClientState,
	filePath: string,
	type: number,
): void {
	if (!isClientAlive(state)) return;
	const normalizedPath = normalizeMapKey(filePath);
	const uri =
		state.openDocumentUris?.get(normalizedPath) ?? pathToFileURL(filePath).href;
	state.watchQueue.enqueue(uri, type);
}

async function handleNotifyOpenOnce(
	state: LSPClientState,
	filePath: string,
	content: string,
	languageId: string,
	preserveDiagnostics = false,
	silent = false,
	coalescedCount = 0,
): Promise<void> {
	if (!isClientAlive(state)) return;
	const normalizedPath = normalizeMapKey(filePath);
	const uri =
		state.openDocumentUris?.get(normalizedPath) ?? pathToFileURL(filePath).href;

	if (
		state.openDocuments.has(normalizedPath) ||
		state.pendingOpens.has(normalizedPath)
	) {
		const version = (state.documentVersions.get(normalizedPath) ?? 0) + 1;
		state.documentVersions.set(normalizedPath, version);
		// preserveDiagnostics: skip cache clear for format-only resyncs so
		// waitForDiagnostics fast-paths instead of waiting up to 5s for TypeScript
		// to re-publish what it already knows (formatting doesn't change semantics).
		// #1095 note: this also retains the prior content `binding`. Until the
		// server republishes for the new version, a binding read compares the OLD
		// content hash against the NEW disk bytes → boundToCurrentDisk `false` →
		// the consumer demotes to inconclusive. That's the SAFE (#533) direction (a
		// transient "unconfirmed", never a false-clean), self-healing on the next
		// publish — not a correctness hazard, unlike the reopen false-TRUE above.
		if (!preserveDiagnostics) {
			clearDiagnosticsForPath(state, normalizedPath);
		}
		// Scanners that only re-scan on a fresh open (opengrep ignores didChange):
		// close + reopen so the re-edit actually triggers a re-scan instead of
		// silently publishing nothing.
		if (getStrategy(state.serverId, state.launchVariant).reopenOnResync) {
			await safeSendNotification(state.connection, "textDocument/didClose", {
				textDocument: { uri },
			});
			state.openDocuments.delete(normalizedPath);
			state.openDocumentUris?.delete(normalizedPath);
			// #1095 (P2-3): carry the version counter FORWARD across the
			// close+reopen instead of resetting to 0. LSP lets a didOpen use any
			// version, and reusing 0 for successive resyncs made the version
			// ambiguous — a late publish for an earlier resync's content echoed the
			// SAME 0 as the current send, so the superseded-push guard (0 < 0 is
			// false) accepted it and `recordBinding` bound STALE diagnostics to the
			// CURRENT content's fingerprint → an affirmative boundToCurrentDisk TRUE
			// for a stale view (worse than "unknown"). Monotonic versions make that
			// late echo strictly older → dropped by isSupersededPush → never bound.
			state.documentVersions.set(normalizedPath, version);
			state.documentOpenedAt.set(normalizedPath, Date.now());
			state.diagnosticPublicationCounts.set(normalizedPath, 0);
			if (!isClientAlive(state)) return;
			const reopenSent = await safeSendNotification(
				state.connection,
				"textDocument/didOpen",
				{ textDocument: { uri, languageId, version, text: content } },
			);
			// #1669 review F7: only mirror the send locally once it actually left
			// the process — see safeSendNotification's doc comment.
			if (reopenSent)
				recordSentContent(
					state,
					normalizedPath,
					version,
					content,
					coalescedCount,
				);
			state.openDocuments.add(normalizedPath);
			state.openDocumentUris?.set(normalizedPath, uri);
			return;
		}
		const changeSent = await safeSendNotification(
			state.connection,
			"textDocument/didChange",
			{
				textDocument: { uri, version },
				contentChanges: buildContentChanges(state, normalizedPath, content),
			},
		);
		if (changeSent)
			recordSentContent(
				state,
				normalizedPath,
				version,
				content,
				coalescedCount,
			);
		return;
	}

	state.pendingOpens.add(normalizedPath);
	state.documentVersions.set(normalizedPath, 0);
	state.documentOpenedAt.set(normalizedPath, Date.now());
	state.diagnosticPublicationCounts.set(normalizedPath, 0);
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

	const openSent = await safeSendNotification(
		state.connection,
		"textDocument/didOpen",
		{ textDocument: { uri, languageId, version: 0, text: content } },
	);
	if (openSent)
		recordSentContent(state, normalizedPath, 0, content, coalescedCount);
	state.pendingOpens.delete(normalizedPath);
	state.openDocuments.add(normalizedPath);
	state.closedDocuments?.delete(normalizedPath);
	state.openDocumentUris?.set(normalizedPath, uri);
	// Telemetry is deliberately detached after didOpen succeeds.
	// #1412 H1: routed through runReadOnlyServerCommand, NOT runServerCommand —
	// the probe must never open the serverEditsAllowed/activeMutationContext
	// mutation-acceptance window; it is a diagnostic sample, not a mutation, and
	// carries its own short PROBE_COMMAND_TIMEOUT_MS backstop. The probe itself
	// is classic-only and swallows every failure.
	void probeTsserverProjectIdentity({
		serverId: state.serverId,
		launchVariant: state.launchVariant,
		clientRoot: state.root,
		file: filePath,
		normalizedFile: normalizedPath,
		probedFiles:
			state.projectIdentityProbedFiles ??
			(state.projectIdentityProbedFiles = new Set()),
		commandChannel: {
			executeCommand: (command, args) =>
				runReadOnlyServerCommand(state, command, args),
		},
	});
}

/**
 * Replace only notifications that have not started a transport write. A
 * microtask starts the first entry so a synchronous burst of callers installs
 * one latest entry before any bytes are handed to vscode-jsonrpc. Once an
 * entry starts, it runs to completion; LSP has no cancellation/acknowledgement
 * for notifications, so dropping a started write could violate didOpen before
 * didChange ordering or leave a partial message in the pipe.
 */
function enqueueDocumentNotify(
	state: LSPClientState,
	normalizedPath: string,
	run: (coalescedCount: number) => Promise<void>,
): Promise<void> {
	let queue = state.notifyChangeQueues.get(normalizedPath);
	if (!queue) {
		queue = { running: false };
		state.notifyChangeQueues.set(normalizedPath, queue);
	}
	return new Promise<void>((resolve, reject) => {
		const previous = queue?.pending;
		// Keep superseded callers attached to the replacement's completion. The
		// notification is dropped, but callers such as the auxiliary backlog
		// ledger must not observe completion before the newest content is sent.
		const waiters = previous?.waiters ?? [];
		waiters.push({ resolve, reject });
		queue!.pending = {
			run,
			waiters,
			coalescedCount: (previous?.coalescedCount ?? 0) + (previous ? 1 : 0),
		};
		if (queue!.running) return;
		queue!.running = true;
		// Let same-turn callers replace the unwritten entry before the runner
		// invokes the transport. Different path queues still start independently.
		void Promise.resolve().then(async () => {
			try {
				for (;;) {
					const next = queue!.pending;
					if (!next) break;
					queue!.pending = undefined;
					try {
						await next.run(next.coalescedCount);
						for (const waiter of next.waiters) waiter.resolve();
					} catch (error) {
						for (const waiter of next.waiters) waiter.reject(error);
					}
				}
			} finally {
				queue!.running = false;
				if (
					!queue!.pending &&
					state.notifyChangeQueues.get(normalizedPath) === queue
				) {
					state.notifyChangeQueues.delete(normalizedPath);
				}
			}
		});
	});
}

/** Drop unwritten document notifications when a client is torn down. */
function cancelDocumentNotifyQueues(state: LSPClientState): void {
	for (const queue of state.notifyChangeQueues.values()) {
		for (const waiter of queue.pending?.waiters ?? []) waiter.resolve();
		queue.pending = undefined;
	}
	state.notifyChangeQueues.clear();
}

export function handleNotifyOpen(
	state: LSPClientState,
	filePath: string,
	content: string,
	languageId: string,
	preserveDiagnostics = false,
	silent = false,
): Promise<void> {
	if (!isClientAlive(state)) return Promise.resolve();
	const normalizedPath = normalizeMapKey(filePath);
	return enqueueDocumentNotify(state, normalizedPath, (coalescedCount) =>
		handleNotifyOpenOnce(
			state,
			filePath,
			content,
			languageId,
			preserveDiagnostics,
			silent,
			coalescedCount,
		),
	);
}

async function handleNotifyChangeOnce(
	state: LSPClientState,
	filePath: string,
	content: string,
	normalizedPath: string,
	coalescedCount = 0,
): Promise<void> {
	if (!isClientAlive(state)) return;
	const uri =
		state.openDocumentUris?.get(normalizedPath) ?? pathToFileURL(filePath).href;

	if (!state.openDocuments.has(normalizedPath)) {
		// Safety fallback: keep protocol ordering valid even if caller sends
		// didChange before first didOpen for this document.
		const fallbackOpenSent = await safeSendNotification(
			state.connection,
			"textDocument/didOpen",
			{
				textDocument: {
					uri,
					languageId: "plaintext",
					version: 0,
					text: content,
				},
			},
		);
		state.documentVersions.set(normalizedPath, 0);
		state.documentOpenedAt.set(normalizedPath, Date.now());
		state.diagnosticPublicationCounts.set(normalizedPath, 0);
		if (fallbackOpenSent)
			recordSentContent(state, normalizedPath, 0, content, coalescedCount);
		state.openDocuments.add(normalizedPath);
		state.openDocumentUris?.set(normalizedPath, uri);
		return;
	}

	const version = (state.documentVersions.get(normalizedPath) ?? 0) + 1;
	state.documentVersions.set(normalizedPath, version);
	// Clear stale diagnostics before sending new content so waitForDiagnostics
	// doesn't return immediately with the previous edit's results.
	clearDiagnosticsForPath(state, normalizedPath);
	const changeSent = await safeSendNotification(
		state.connection,
		"textDocument/didChange",
		{
			textDocument: { uri, version },
			contentChanges: buildContentChanges(state, normalizedPath, content),
		},
	);
	if (changeSent)
		recordSentContent(state, normalizedPath, version, content, coalescedCount);
}

/**
 * #2113: serialize the read/build/send/record transaction per document. The
 * content-change payload must be built against the content recorded by the
 * preceding send for this path; unrelated paths retain parallel sends.
 */
export function handleNotifyChange(
	state: LSPClientState,
	filePath: string,
	content: string,
): Promise<void> {
	if (!isClientAlive(state)) return Promise.resolve();
	const normalizedPath = normalizeMapKey(filePath);
	return enqueueDocumentNotify(state, normalizedPath, (coalescedCount) =>
		handleNotifyChangeOnce(
			state,
			filePath,
			content,
			normalizedPath,
			coalescedCount,
		),
	);
}

/** Close a document through the same lifecycle path exposed by the client. */
export async function closeDocument(
	state: LSPClientState,
	filePath: string,
): Promise<void> {
	if (!isClientAlive(state)) return;
	const normalizedPath = normalizeMapKey(filePath);
	if (!state.openDocuments.has(normalizedPath)) return;
	await safeSendNotification(state.connection, "textDocument/didClose", {
		textDocument: {
			uri:
				state.openDocumentUris?.get(normalizedPath) ??
				pathToFileURL(filePath).href,
		},
	});
	state.openDocuments.delete(normalizedPath);
	state.closedDocuments?.add(normalizedPath);
	state.openDocumentUris?.delete(normalizedPath);
	state.documentVersions.delete(normalizedPath);
	state.documentOpenedAt.delete(normalizedPath);
	state.diagnosticPublicationCounts.delete(normalizedPath);
	// #1412 L1: projectIdentityProbedFiles is a claim-once memo scoped to the
	// document's open lifetime (re-probing a closed-then-reopened file is
	// harmless and cheap) — mirror openDocuments' own per-close cleanup so it
	// doesn't grow unbounded across a long session's worth of open/close churn.
	state.projectIdentityProbedFiles?.delete(normalizedPath);
	const retained = state.documentContentHashes.get(normalizedPath);
	if (retained?.text !== undefined) {
		state.incrementalTextRetainedEntries = Math.max(
			0,
			(state.incrementalTextRetainedEntries ?? 1) - 1,
		);
		state.incrementalTextRetainedBytes = Math.max(
			0,
			(state.incrementalTextRetainedBytes ?? retained.text.length * 2) -
				retained.text.length * 2,
		);
		// #2065 fix round 2 N1: `recordSentContent` and the eviction loop both
		// delete from `incrementalTextBearingPaths` when they strip a path's
		// text, but neither runs on close — this was the missing third writer.
		// Without it, a closed path's membership in the aux set survives
		// forever: below the 128-entry/64 MiB cap the eviction loop that would
		// otherwise clean it up never runs at all, so the set grows by one
		// stale entry per open/close cycle with nothing ever draining it — the
		// exact unbounded-per-path-store class #2065 exists to close, just
		// moved into the aux index instead of the byte-retention count itself.
		state.incrementalTextBearingPaths?.delete(normalizedPath);
	}
	// Keep the hash/version binding only while the document is open; the full
	// text is needed for the next edit, never after didClose (#2065).
	state.documentContentHashes.delete(normalizedPath);
	clearDiagnosticsForPath(state, normalizedPath);
	// #2065 fix round 2 (reverts fix round 1 F4): `pullGenerations` is the
	// eighth per-path map in this family, but it is deliberately NOT cleared
	// here — the same reasoning `clearDiagnosticsForPath` already documents
	// above for `pullRequestSequences` applies to this counter too, and fix
	// round 1's F4 missed it. `pullGenerationFor` defaults a missing entry to
	// `0`, so deleting the entry on close resets the counter. A pull already
	// in flight before the close captured its generation BEFORE this close's
	// `clearDiagnosticsForPath` bump above ran. If the document is closed and
	// reopened before that in-flight pull's write lands, deleting the entry
	// here would let the counter read back as `0` again — the exact value the
	// stale write's stale captured generation equals — so the write-time
	// `!== generation` check at its call site would wrongly accept a stale
	// answer computed against the pre-close content. Leaving the counter
	// monotonic and un-reset keeps every pre-close capture permanently
	// distinguishable from whatever the counter reads afterward, no matter how
	// many closes or reopens happen in between. The cost is one integer per
	// path that outlives the document's open lifetime — negligible next to
	// correctness here.
}

/**
 * #1620 residual review F1: `fast` and `processExiting` only ever escalate —
 * a `true` demands strictly less work (or none) than a `false`, never more.
 * `existing` covers `requested` when it is at least as demanding on BOTH
 * axes, so deduping onto it can't silently downgrade what the new caller
 * needs (e.g. a `processExiting` caller must never inherit a teardown that
 * might still spawn `taskkill`).
 */
function isAtLeastAsAggressiveShutdown(
	existing: LSPShutdownOptions,
	requested: LSPShutdownOptions,
): boolean {
	return (
		!!existing.fast >= !!requested.fast &&
		!!existing.processExiting >= !!requested.processExiting
	);
}

export function clientShutdown(
	state: LSPClientState,
	options: LSPShutdownOptions = {},
): Promise<void> {
	// #1620 residual 3: idempotent across racing callers — see the doc comment
	// on `LSPClientState.shutdownPromise`. The FIRST call starts the real
	// teardown and stores its promise; every subsequent call (any of the 8
	// call sites, on the same state) whose options are no MORE aggressive
	// awaits that same promise instead of running the RPC handshake and
	// emitting `lsp_client_shutdown` again.
	//
	// #1620 residual review F1: a call whose options ARE more aggressive does
	// NOT dedupe — it starts (and takes over as) its own teardown instead.
	// The concrete failure this closes: `resetLSPService`'s session-exit path
	// (`index.ts`) calls `shutdown({fast:true, processExiting:true})` — the
	// event loop is already closing, and `processExiting` exists precisely so
	// this teardown never spawns `taskkill` (a closing-loop `uv_async_send`
	// hard-aborts, `src\win\async.c`). If a GRACEFUL teardown (default
	// options — e.g. `client_ceiling_lru` eviction) is already in flight on
	// this same client when the exit path arrives, blindly deduping would
	// make the exit path inherit that graceful run's own `taskkill` spawn and
	// its close-event wait — the exact hazard `processExiting` forbids, on
	// top of blocking the closing loop for however long that takes. The
	// weaker in-flight teardown is left to finish on its own (every step
	// downstream — dispose, kill, deregister — is already idempotent).
	if (
		state.shutdownPromise &&
		state.shutdownOptions &&
		isAtLeastAsAggressiveShutdown(state.shutdownOptions, options)
	) {
		return state.shutdownPromise;
	}
	state.shutdownOptions = options;
	const attempt = clientShutdownOnce(state, options);
	state.shutdownPromise = attempt;
	// #1620 residual review F3: a REJECTED teardown (e.g. `killProcessTree`
	// throwing something its own internal catches don't cover) must not
	// latch a permanently-rejected promise here — every later call, even one
	// with equal or weaker options, would dedupe onto it forever and never
	// retry, so the child leaks silently with no further kill/dispose/
	// deregister attempt. Clear the latch on rejection (only if nothing more
	// aggressive has already superseded it) so the NEXT call starts a fresh
	// attempt instead of re-handing back the same dead promise. The rejection
	// itself still propagates to whoever is awaiting `attempt` right now —
	// this only affects callers that haven't asked yet.
	attempt.catch(() => {
		if (state.shutdownPromise === attempt) {
			state.shutdownPromise = undefined;
			state.shutdownOptions = undefined;
		}
	});
	return attempt;
}

async function clientShutdownOnce(
	state: LSPClientState,
	options: LSPShutdownOptions,
): Promise<void> {
	const shutdownStart = Date.now();
	state.shutdownRequested = true;
	state.isConnected = false;
	state.isDestroyed = true;
	for (const timer of state.pendingDiagnostics.values()) {
		clearTimeout(timer);
	}
	state.pendingDiagnostics.clear();
	state.pendingOpens.clear();
	state.openDocuments.clear();
	state.openDocumentUris?.clear();
	// #2357: superseded notifications that have not started writing are moot
	// once this client is dead; resolve their callers and release the queue.
	cancelDocumentNotifyQueues(state);
	// #1412 L1: mirror openDocuments' clear — a shut-down/evicted client's
	// probe memo is moot along with everything else document-scoped.
	state.projectIdentityProbedFiles?.clear();
	// #271: drop any pending watched-files batch + its timer (a dying client's
	// queued FS changes are moot, and the timer must not outlive the connection).
	state.watchQueue?.cancel();
	state.diagnosticEmitter.removeAllListeners();
	let shutdownRequestTimedOut = false;
	let exitNotifyTimedOut = false;
	// #1620 residual 1 / residual-review F2: a failure that ISN'T the timer
	// winning was previously folded into the same "*TimedOut" flag as a real
	// timeout — honest for the rolled-up `shutdownOutcome` (still "forced"
	// either way), imprecise about WHICH failure happened. Two shapes land
	// here, both meaning "no confirmation this reached the server":
	//   (a) a genuine promise rejection that isn't the timer (an immediate
	//       protocol error) — reaches the `catch` below.
	//   (b) `safeSendRequest`/`safeSendNotification` SWALLOW a stream error
	//       (EPIPE, disposed connection — `isStreamError`) and RESOLVE
	//       instead of rejecting, so the `catch` never runs at all. A real
	//       `shutdown` reply is `null`, never `undefined`, and a real `exit`
	//       notify send returns `true`; `undefined`/`false` is the swallow
	//       case. Without this, a coded EPIPE reported `shutdownOutcome:
	//       "graceful"` — nothing was delivered, but the log called it clean.
	let shutdownRequestUndelivered = false;
	let exitNotifyUndelivered = false;
	// #1620: the graceful handshake is BEST-EFFORT and the teardown is not. A
	// teardown path must not depend on the health of the thing it is tearing
	// down — the breaker fires exactly when the server is unresponsive. Keep the
	// handshake inside the `try` and every irreversible teardown step in the
	// `finally`, so disposal, the record, the deregistration, and the kill run no
	// matter how the two writes behave, and so a future added await here cannot
	// reintroduce the class.
	try {
		if (!options.fast) {
			try {
				const shutdownAck = await withTimeout(
					safeSendRequest(state.connection, "shutdown", {}),
					SHUTDOWN_REQUEST_TIMEOUT_MS,
				);
				if (shutdownAck === undefined) shutdownRequestUndelivered = true;
			} catch (err) {
				/* ignore — proceed to exit/kill so shutdown cannot hang the session */
				if (isShutdownTimeoutError(err, SHUTDOWN_REQUEST_TIMEOUT_MS)) {
					shutdownRequestTimedOut = true;
				} else {
					shutdownRequestUndelivered = true;
				}
			}
			try {
				const exitSent = await withTimeout(
					safeSendNotification(state.connection, "exit", {}),
					EXIT_NOTIFY_TIMEOUT_MS,
				);
				if (exitSent === false) exitNotifyUndelivered = true;
			} catch (err) {
				/* ignore — same reason as the request above */
				if (isShutdownTimeoutError(err, EXIT_NOTIFY_TIMEOUT_MS)) {
					exitNotifyTimedOut = true;
				} else {
					exitNotifyUndelivered = true;
				}
			}
		}
	} finally {
		// #2065 fix round 1: deregistration now lives in disposeClientConnection
		// itself (the convergence point for every crash/dispose path, not just
		// this graceful one) — see its comment.
		disposeClientConnection(state);
		const pid = state.lspProcess.pid;
		logLatency({
			type: "phase",
			phase: "lsp_client_shutdown",
			filePath: state.root,
			durationMs: Date.now() - shutdownStart,
			metadata: {
				serverId: state.serverId,
				pid,
				fast: !!options.fast,
				processExiting: !!options.processExiting,
				shutdownRequestTimedOut,
				// #1620: `shutdownRequestTimedOut` covered only the request half, so
				// a hung exit notify was indistinguishable from a clean exit — and
				// pre-fix no record was emitted at all. Report both halves plus one
				// rolled-up verdict, so a forced teardown is countable from the log.
				exitNotifyTimedOut,
				// #1620 residual 1 / residual-review F2: the *Undelivered pair covers
				// the failure the *TimedOut pair used to also claim — a rejection
				// that is NOT the timer winning, OR (the F2 gap) a swallowed stream
				// error that `safeSendRequest`/`safeSendNotification` resolved
				// instead of rejecting, so no exception ever reached the catches
				// above. Both still roll into shutdownOutcome "forced" below — an
				// undelivered write is never reported as "graceful".
				shutdownRequestUndelivered,
				exitNotifyUndelivered,
				shutdownOutcome: options.fast
					? "fast"
					: shutdownRequestTimedOut ||
						  exitNotifyTimedOut ||
						  shutdownRequestUndelivered ||
						  exitNotifyUndelivered
						? "forced"
						: "graceful",
			},
		});
		// #449/#472: deregister this LSP child from the instance registry. Fire-
		// and-forget (async fs, no spawn) — must not add latency/risk to shutdown,
		// including the `processExiting` path where the event loop is closing
		// (#234 forbids spawning here, but a plain fs write/rename is fine; even
		// so, we don't await it to keep this teardown path as fast as before).
		// #1724: pass this spawn's marker so removeLspChild can guard against a
		// pid-recycling window (a NEW child claiming this exact pid before this
		// fire-and-forget write lands) rather than removing whichever child
		// currently sits at this pid.
		void removeLspChild(pid, extractSpawnMarker(state.lspProcess.args)).catch(
			(err) => {
				logLatency({
					type: "phase",
					phase: "lsp_registry_write_failed",
					filePath: "",
					durationMs: 0,
					metadata: { op: "remove", pid, error: String(err) },
				});
			},
		);
		// On Windows, killing the direct child first can orphan grandchildren before
		// taskkill can traverse the tree. Kill the full tree first and wait briefly.
		// Safe and idempotent on an already-exited child: killProcessTree returns
		// early on an observed exit rather than signalling a possibly-recycled pid.
		await killProcessTree(state.lspProcess.process, pid, options);
	}
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

// Exported for the timeout regression tests (#365). `timeoutMs` overrides the
// per-request ceiling so a test can bound a hung server quickly.
export async function navRequest<T>(
	state: LSPClientState,
	method: string,
	params: Record<string, unknown>,
	// When provided, the request is dropped if the document's version advances
	// (an edit landed) between send and response. Omit for non-single-file
	// requests (workspaceSymbol, call-hierarchy follow-ups) that have no version.
	staleCheckPath?: string,
	timeoutMs: number = NAV_REQUEST_TIMEOUT_MS,
	// Cancels the in-flight request (LSP `$/cancelRequest`) when the turn is
	// abandoned. Defaults to the ambient abort signal set around dispatch/tool
	// handling, so callers get cancellation for free without a signature change
	// (#238 Item 1). Pass explicitly in tests.
	signal: AbortSignal | undefined = getAmbientAbortSignal(),
): Promise<T | null | undefined> {
	if (!isClientAlive(state)) return null;
	const normalizedPath =
		staleCheckPath !== undefined ? normalizeMapKey(staleCheckPath) : undefined;
	const requestVersion =
		normalizedPath !== undefined
			? state.documentVersions.get(normalizedPath)
			: undefined;
	// #1716: captured OUTSIDE withTimeout, mirroring #1713's pull-diagnostic
	// fix (`pullDiagnosticSource`), so a timeout's catch below still holds a
	// live handle on the request for the late-answer watch. `withTimeout`
	// only races it against a timer — the request keeps running server-side
	// either way, and without this handle an abandoned answer would settle
	// into the void with no way to observe it.
	const requestStartedAt = Date.now();
	const requestPromise = safeSendRequest<T>(
		state.connection,
		method,
		params,
		signal,
	);
	const result = (await withTimeout(requestPromise, timeoutMs).catch(
		(err: unknown) => {
			if (isNavTimeoutError(err, timeoutMs)) {
				recordNavTimeoutTelemetry({
					method,
					scope: normalizedPath,
					budgetMs: timeoutMs,
					elapsedMs: Date.now() - requestStartedAt,
				});
				armNavLateAnswerTelemetry({
					requestPromise,
					method,
					scope: normalizedPath,
					requestStartedAt,
				});
				return undefined;
			}
			if (err instanceof Error && err.message.startsWith("Timeout after")) {
				return undefined;
			}
			throw err;
		},
	)) as T | undefined;
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

/**
 * #1716: `withTimeout` rejects with this EXACT message (`clients/deadline-
 * utils.ts`) only when its own timer wins the race — mirrors #1713's
 * `isPullTimeoutError`. Only the timer-won case is a "the answer might still
 * be coming" situation worth a late-answer watch; a request that already
 * failed fast (or a stale-message coincidence) has nothing further to
 * observe. `navRequest`'s own behavior still falls back to the looser
 * `startsWith` check afterward, unchanged, so this stricter check only gates
 * telemetry — never the existing timeout-handling behavior.
 */
function isNavTimeoutError(err: unknown, timeoutMs: number): boolean {
	return err instanceof Error && err.message === `Timeout after ${timeoutMs}ms`;
}

/**
 * #1620 residual 1: `withTimeout` rejects with this EXACT message only when
 * its own timer wins the race — mirrors #1713's `isPullTimeoutError` and
 * #1716's `isNavTimeoutError`. `clientShutdown`'s two catches previously
 * treated ANY rejection (a real timeout OR an immediate protocol error) as
 * "timed out"; honest for the rolled-up `shutdownOutcome` (both are
 * "forced"), imprecise for the per-field flag a log reader keys on.
 */
function isShutdownTimeoutError(err: unknown, timeoutMs: number): boolean {
	return err instanceof Error && err.message === `Timeout after ${timeoutMs}ms`;
}

// #1716: subject/scope used when a nav request has no `staleCheckPath` (e.g.
// workspaceSymbol, call-hierarchy follow-ups) — mirrors WORKSPACE_PULL_SCOPE
// above for the same reason: telemetry identity needs a stable placeholder
// where there is no real path.
const NAV_REQUEST_NO_PATH_SCOPE = "*no-path*";

/**
 * #1716: `navRequest` is the highest-volume LSP call site — hover,
 * definition, references, signatureHelp, documentSymbol, workspace/symbol,
 * call hierarchy all route through it, often several times per turn. A stuck
 * server can storm timeouts across many methods and files far faster than
 * the pull-diagnostic path #1713 fixed, so a per-event latency.log write
 * (that fix's shape) would itself become the flood. Every timeout is still
 * counted exactly, via the degradation ledger (bounded, in-memory, no I/O),
 * but only the RISING EDGE — the first occurrence per (method, file) this
 * session — also pays for a detailed log write. `incrementDegradationCount`'s
 * return value (`true` on the first occurrence for a kind/subject pair) is
 * reused as that rising-edge gate instead of a second hand-rolled latch: it
 * already re-arms at session_start via `resetDegradationLedger`, so this
 * adds zero new module state. Never throws: telemetry must not perturb a
 * path that has already decided to return `undefined` regardless.
 */
function recordNavTimeoutTelemetry(args: {
	method: string;
	scope: string | undefined;
	budgetMs: number;
	elapsedMs: number;
}): void {
	// #1743: `risingEdgePer: "identity"` is the same gate this site hand-rolled
	// off `incrementDegradationCount`'s return value, now expressed as an
	// option. The ledger still counts every timeout exactly, per (method, file).
	emitBounded(
		"lsp_nav_request_timeout",
		`${args.method}:${args.scope ?? NAV_REQUEST_NO_PATH_SCOPE}`,
		{
			type: "phase",
			filePath: args.scope ?? NAV_REQUEST_NO_PATH_SCOPE,
			durationMs: args.elapsedMs,
			metadata: { method: args.method, effectiveBudgetMs: args.budgetMs },
		},
		{
			ledgerKind: "lsp-nav-request-timeout",
			risingEdgePer: "identity",
			reason: `timeout budget=${args.budgetMs}ms elapsed=${args.elapsedMs}ms`,
		},
	);
}

/**
 * #1716: nav-request sibling of #1713's `armLateAnswerTelemetry`. A
 * telemetry-only continuation on the ALREADY-abandoned request promise —
 * purely observational, never touches `state`, and attaching `.then` here
 * creates no new timer, socket, or other handle, so it cannot keep the
 * process alive a moment longer than the pending request already does.
 *
 * Bounded the same way as the timeout record above: every late answer is
 * counted exactly via the ledger, but only the rising edge per (method,
 * file) also writes an `lsp_nav_late_answer_discarded` record.
 *
 * Nav answers are read-once — unlike diagnostics' persistent pull cache,
 * there is no stale value this could poison — so this exists purely for
 * observability: telling a dogfood session "truly hung" apart from
 * "answered late", the same distinction #1713 made possible for pulls.
 */
function armNavLateAnswerTelemetry(args: {
	requestPromise: Promise<unknown>;
	method: string;
	scope: string | undefined;
	requestStartedAt: number;
}): void {
	args.requestPromise.then(
		() => {
			try {
				const elapsedMs = Date.now() - args.requestStartedAt;
				// #1743: same rising-edge gate as the timeout record above, now
				// carried by the helper instead of hand-rolled here.
				emitBounded(
					"lsp_nav_late_answer_discarded",
					`${args.method}:${args.scope ?? NAV_REQUEST_NO_PATH_SCOPE}`,
					{
						type: "phase",
						filePath: args.scope ?? NAV_REQUEST_NO_PATH_SCOPE,
						durationMs: elapsedMs,
						metadata: { method: args.method },
					},
					{
						ledgerKind: "lsp-nav-late-answer",
						risingEdgePer: "identity",
						reason: `late nav answer discarded after ${elapsedMs}ms`,
					},
				);
			} catch {
				// Telemetry must never break the observed path.
			}
		},
		() => {
			// The abandoned request eventually failed rather than answering —
			// not an "answer discarded" event. Nothing more to record here; this
			// handler exists so the request's eventual rejection never surfaces
			// as an unhandled rejection.
		},
	);
}

/**
 * #1969: pick the request the liveness probe may send to THIS server.
 *
 * The probe only needs a round-trip, so any request works — but it must be one
 * the server advertised. #1277 originally hardcoded `workspace/symbol` because
 * it needs no open document, and treated `MethodNotFound` as proof of life.
 * That rationale is sound for the round-trip, and wrong as a default: a server
 * that does not implement the method logs an error for every probe. ast-grep's
 * tower_lsp backend wrote "got a 'workspace/symbol' request, but it is not
 * implemented" on each one, and its `code=1` deaths clustered after them
 * (#1969). pi-lens must not keep pushing an unimplemented method at a server
 * just to learn it is awake.
 *
 * The ladder, best first:
 *  1. `workspace/symbol` when `workspaceSymbolProvider` is advertised — the
 *     #1277 probe, unchanged, and still needs no open document.
 *  2. `textDocument/documentSymbol` on an already-open document when
 *     `documentSymbolProvider` is advertised. Read-only, scoped to a document
 *     the server already has, and cheap.
 *  3. `textDocument/hover` at the start of an already-open document when
 *     `hoverProvider` is advertised. This step is what keeps ast-grep covered:
 *     `docs/servercapabilities.md:53` records its advertised set as
 *     codeActionProvider, executeCommandProvider, hoverProvider and
 *     textDocumentSync — no symbol provider of either kind. #1714's own
 *     measurement (clients/lsp/index.ts, `paceAuxNotify`) timed hover against
 *     the real ast-grep binary at 1 ms idle and 2086 ms behind 30 `didOpen`s,
 *     the same ordering proof it recorded for `workspace/symbol`. So the
 *     notify throttle keeps a real barrier here, not a hollow one.
 *  4. Nothing. The caller then reports liveness from process and connection
 *     state alone, and records that it did.
 *
 * `MethodNotFound`-counts-as-alive still holds for every probe: dynamic
 * registration can retract a capability after `initialize`, and an error reply
 * is still a reply. What changes is that pi-lens no longer PROVOKES that error
 * on every probe.
 */
function chooseLivenessProbe(
	state: LSPClientState,
): { method: string; params: unknown } | undefined {
	if (state.operationSupport?.workspaceSymbol === true) {
		return {
			method: "workspace/symbol",
			params: { query: LIVENESS_PING_QUERY },
		};
	}
	const openUri = firstOpenDocumentUri(state);
	if (openUri === undefined) return undefined;
	if (state.operationSupport?.documentSymbol === true) {
		return {
			method: "textDocument/documentSymbol",
			params: { textDocument: { uri: openUri } },
		};
	}
	if (state.operationSupport?.hover === true) {
		return {
			method: "textDocument/hover",
			params: {
				textDocument: { uri: openUri },
				position: { line: 0, character: 0 },
			},
		};
	}
	return undefined;
}

/** URI of any document this client currently holds open, if it holds one. */
function firstOpenDocumentUri(state: LSPClientState): string | undefined {
	for (const normalizedPath of state.openDocuments) {
		const uri = state.openDocumentUris?.get(normalizedPath);
		if (uri !== undefined) return uri;
	}
	return undefined;
}

// #1277: cheap liveness round-trip used by the silent-clean gates in
// `index.ts`. `isAlive()`/`checkAlive()` only look at process/connection
// state — a server that accepted the notify write and then wedged (still
// running, connection still open, just never replying) reads as "alive" by
// those checks even though it will never answer anything again. This sends a
// real request (see `chooseLivenessProbe` for which, #1969) and reports
// whether the connection round-tripped it — success, a genuine
// protocol-level error (e.g. MethodNotFound), and a stream-destroyed/
// cancelled response (safeSendRequest swallows those to `undefined`, so the
// final `isClientAlive` re-check is what catches "died mid-flight") ALL count
// as "alive"; only a real timeout, or the connection having gone down by the
// time this resolves, reports dead. The response content itself is never
// inspected — only whether one arrived in time.
async function clientPingLiveness(
	state: LSPClientState,
	timeoutMs: number = LIVENESS_PING_TIMEOUT_MS,
): Promise<boolean> {
	if (!isClientAlive(state)) return false;
	const probe = chooseLivenessProbe(state);
	if (probe === undefined) {
		// #1969: no advertised method to probe with, so this answer comes from
		// process and connection state alone — exactly the checks the probe
		// exists to strengthen. Say so in the ledger rather than let a weaker
		// verdict pass as the strong one. Rising edge per server, via the
		// ledger's own tally; the count carries the repeats.
		try {
			incrementDegradationCount({
				kind: "lsp-liveness-probe-unsupported",
				subject: state.serverId,
				reason:
					"no advertised request method to probe with (no " +
					"workspaceSymbolProvider, and no open document with " +
					"documentSymbolProvider or hoverProvider); liveness from " +
					"process and connection state only",
			});
		} catch {
			// Telemetry must never break the observed path.
		}
		return isClientAlive(state);
	}
	try {
		await withTimeout(
			safeSendRequest(state.connection, probe.method, probe.params),
			timeoutMs,
		);
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("Timeout after")) {
			return false;
		}
		// A real protocol-level error reply still proves the server round-
		// tripped the request — fall through to the alive re-check below
		// rather than treating an error response as "dead".
	}
	return isClientAlive(state);
}

// Run an advertised server command via workspace/executeCommand, with the
// generous EXECUTE_COMMAND_TIMEOUT_MS anti-deadlock backstop. Preserves the
// hardening invariants: allowlist-by-advertisement (only commands the server
// declared) and the serverEditsAllowed window that gates server-driven
// applyEdit to the duration of an explicit call. Exported with an overridable
// `timeoutMs` for the #365 regression tests.
export async function runServerCommand(
	state: LSPClientState,
	command: string,
	args: unknown[] | undefined,
	timeoutMs: number = EXECUTE_COMMAND_TIMEOUT_MS,
	mutationContext?: LspMutationContext,
): Promise<{ executed: boolean; result?: unknown; reason?: string }> {
	if (!isClientAlive(state)) {
		return { executed: false, reason: "lsp client not alive" };
	}
	if (!state.advertisedCommands.has(command)) {
		return {
			executed: false,
			reason: `command "${command}" is not advertised by the ${state.serverId} server`,
		};
	}
	state.serverEditsAllowed += 1;
	state.activeMutationDepth = (state.activeMutationDepth ?? 0) + 1;
	if (state.activeMutationDepth === 1)
		state.activeMutationContext = mutationContext;
	else state.activeMutationContext = undefined;
	try {
		let result: unknown;
		try {
			result = await withTimeout(
				safeSendRequest<unknown>(state.connection, "workspace/executeCommand", {
					command,
					arguments: args ?? [],
				}),
				timeoutMs,
			);
		} catch (err) {
			// Generous backstop only: a timeout means the server is hung (or the
			// command is running longer than the ceiling). Surface it honestly — the
			// command may still be applying — instead of hanging the caller. Real
			// (non-timeout) errors still propagate.
			if (err instanceof Error && err.message.startsWith("Timeout after")) {
				return {
					executed: false,
					reason: `workspace/executeCommand timed out after ${timeoutMs}ms — the command may still be applying server-side`,
				};
			}
			throw err;
		}
		return { executed: true, result };
	} finally {
		state.serverEditsAllowed -= 1;
		state.activeMutationDepth = Math.max(
			0,
			(state.activeMutationDepth ?? 0) - 1,
		);
		if (state.activeMutationDepth === 0)
			state.activeMutationContext = undefined;
	}
}

// #1412 H1/H2: read-only sibling of runServerCommand for telemetry/identity
// probes that must NOT participate in the mutation-acceptance window. Unlike
// runServerCommand this never touches serverEditsAllowed, activeMutationDepth,
// or activeMutationContext — a probe firing mid-flight must leave a concurrent
// real executeCommand's mutation context untouched, and must not itself open
// the workspace/applyEdit acceptance window (client.ts's applyEdit handler
// gates on serverEditsAllowed > 0). Preserves the allowlist-by-advertisement
// invariant. Short PROBE_COMMAND_TIMEOUT_MS backstop — this is a diagnostic
// sample, not a mutation, and must never hold anything up for anywhere near
// EXECUTE_COMMAND_TIMEOUT_MS.
export async function runReadOnlyServerCommand(
	state: LSPClientState,
	command: string,
	args: unknown[] | undefined,
	timeoutMs: number = PROBE_COMMAND_TIMEOUT_MS,
): Promise<{ executed: boolean; result?: unknown; reason?: string }> {
	if (!isClientAlive(state)) {
		return { executed: false, reason: "lsp client not alive" };
	}
	if (!state.advertisedCommands.has(command)) {
		return {
			executed: false,
			reason: `command "${command}" is not advertised by the ${state.serverId} server`,
		};
	}
	try {
		const result = await withTimeout(
			safeSendRequest<unknown>(state.connection, "workspace/executeCommand", {
				command,
				arguments: args ?? [],
			}),
			timeoutMs,
		);
		return { executed: true, result };
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("Timeout after")) {
			return {
				executed: false,
				reason: `workspace/executeCommand timed out after ${timeoutMs}ms`,
			};
		}
		throw err;
	}
}

function validateWorkspaceEditVersions(
	state: LSPClientState,
	edit: { documentChanges?: unknown[] },
): void {
	for (const change of edit.documentChanges ?? []) {
		if (
			typeof change !== "object" ||
			change === null ||
			!("textDocument" in change)
		)
			continue;
		const textDocument = (
			change as { textDocument?: { uri?: unknown; version?: unknown } }
		).textDocument;
		if (
			!textDocument ||
			typeof textDocument.uri !== "string" ||
			textDocument.version == null
		)
			continue;
		const current = state.documentVersions.get(
			normalizeMapKey(uriToPath(textDocument.uri)),
		);
		if (current === undefined || current !== textDocument.version) {
			throw new Error(
				`stale workspace edit document version for ${textDocument.uri}`,
			);
		}
	}
}

// Neutralize numeric `textDocument.version` stamps AFTER they have been
// validated against the live document map. The tool apply paths (rename
// apply:true in tools/lsp-navigation.ts, code-action autofix in
// actionable-warnings.ts) call applyWorkspaceEdit without a documentVersions
// map, so a preserved numeric version would fail preflight 100% of the time for
// servers that stamp real versions (gopls stamps open documents). Setting the
// version to null is the spec's "do not check" — the freshness guarantee has
// already been provided here by validateWorkspaceEditVersions at the correct
// moment. The server-initiated workspace/applyEdit handler does NOT route
// through here (it applies params.edit directly with state.documentVersions),
// so its real preflight version check is left fully intact.
function stripDocumentVersions(edit: LSPWorkspaceEdit): LSPWorkspaceEdit {
	if (!Array.isArray(edit.documentChanges)) return edit;
	const documentChanges = edit.documentChanges.map((change) => {
		if (
			typeof change === "object" &&
			change !== null &&
			"textDocument" in change &&
			"edits" in change
		) {
			const textDocument = (change as { textDocument?: { version?: unknown } })
				.textDocument;
			if (textDocument && typeof textDocument.version === "number") {
				return {
					...(change as Record<string, unknown>),
					textDocument: { ...textDocument, version: null },
				};
			}
		}
		return change;
	});
	return { ...edit, documentChanges } as LSPWorkspaceEdit;
}

export async function normalizeClientWorkspaceEdit(
	state: LSPClientState,
	edit: LSPWorkspaceEdit,
): Promise<LSPWorkspaceEdit> {
	validateWorkspaceEditVersions(state, edit);
	const normalized = (await normalizeWorkspaceEditToUtf16(
		edit,
		state.positionEncoding,
		state.root,
	)) as LSPWorkspaceEdit;
	return stripDocumentVersions(normalized);
}

async function resolveCodeActionBestEffort(
	state: LSPClientState,
	action: LSPCodeAction,
): Promise<LSPCodeAction> {
	if (!isClientAlive(state)) return action;
	if (action.edit) {
		return {
			...action,
			edit: await normalizeClientWorkspaceEdit(
				state,
				action.edit as LSPWorkspaceEdit,
			),
		};
	}
	if (!state.operationSupport.codeActionResolve) {
		recordDegradationOnce({
			kind: "lsp-capability-skip",
			subject: `${state.serverId}:codeAction/resolve`,
			reason: "server did not advertise codeActionProvider.resolveProvider",
		});
		return action;
	}
	let resolved: LSPCodeAction | null | undefined;
	try {
		resolved = await withTimeout(
			safeSendRequest<LSPCodeAction>(
				state.connection,
				"codeAction/resolve",
				action,
			),
			NAV_REQUEST_TIMEOUT_MS,
		);
	} catch {
		// codeAction/resolve is optional. Keep the original lightweight action when
		// the server does not support resolve or fails to populate an edit.
		return action;
	}
	if (!resolved || typeof resolved !== "object") return action;
	const merged = { ...action, ...resolved };
	return merged.edit
		? {
				...merged,
				edit: await normalizeClientWorkspaceEdit(
					state,
					merged.edit as LSPWorkspaceEdit,
				),
			}
		: merged;
}

// --- Client Factory ---

export async function createLSPClient(options: {
	serverId: string;
	process: LSPProcess;
	root: string;
	/** Session cwd, distinct from the language-server project root. */
	sessionCwd?: string;
	initialization?: Record<string, unknown>;
	initializeTimeoutMs?: number;
	/** See `LSPServerInfo.spawn`'s `launchVariant` (server.ts) — which concrete
	 *  binary/protocol variant was launched for this server id. Undefined =
	 *  single-variant server or not yet reported; consumers must treat that as
	 *  the classic/default behavior (fail-safe). */
	launchVariant?: "classic" | "native-ts7";
}): Promise<LSPClientInfo> {
	installCrashGuard();

	const {
		serverId,
		process: lspProcess,
		root,
		sessionCwd,
		initialization,
		initializeTimeoutMs = INITIALIZE_TIMEOUT_MS,
		launchVariant,
	} = options;

	// #449/#472: register this LSP child in the cross-process instance registry
	// as soon as we have a live pid — BEFORE `initialize` completes, not after.
	// Registering early means a child that dies/hangs during initialize (the
	// catch block below kills it) is still deregistered by that same path via
	// removeLspChild, and a process that crashes mid-initialize is still
	// visible to the orphan reaper rather than silently untracked. Fire-and-
	// forget: registry I/O must never block or fail LSP startup.
	void recordLspChild({
		pid: lspProcess.pid,
		serverId,
		command: lspProcess.command,
		marker: extractSpawnMarker(lspProcess.args),
		sessionIdentity: {
			projectRoot: sessionCwd ?? process.cwd(),
			rootSource: sessionCwd ? "service-cwd" : "lsp-fallback",
			startedAt: new Date(
				workspaceDiagnosticsCacheSessionStart(),
			).toISOString(),
		},
	}).catch((err) => {
		// best-effort observability — never fail LSP startup over this
		logLatency({
			type: "phase",
			phase: "lsp_registry_write_failed",
			filePath: "",
			durationMs: 0,
			metadata: { op: "record", pid: lspProcess.pid, error: String(err) },
		});
	});

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

	// SAFETY: three fields below are seeded `undefined as unknown as T` because
	// they cannot be built here. `workspaceDiagnosticsSupport` and
	// `operationSupport` are derived from the server's `initialize` result, and
	// `watchQueue`'s flush closure needs `state` itself. Each is assigned
	// in this same function before `state` reaches any caller:
	// `state.watchQueue` on the statement immediately after this literal, and
	// the two capability fields right after the `initialize` handshake
	// returns. Reorder that and the fields are genuinely `undefined` at their
	// declared non-optional types.
	const state: LSPClientState = {
		isConnected: true,
		isDestroyed: false,
		shutdownRequested: false,
		shutdownPromise: undefined,
		shutdownOptions: undefined,
		exitedAt: undefined,
		connectionDisposed: false,
		lastError: undefined,
		connection,
		pushDiagnostics: new Map(),
		pushDiagnosticTimestamps: new Map(),
		documentPullDiagnostics: new Map(),
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
		incrementalTextBearingPaths: new Set(),
		incrementalTextRetainedBytes: 0,
		diagnosticBindings: new Map(),
		pullResultIds: new Map(),
		documentPullDiagnosticsBySource: new Map(),
		pullGenerations: new Map(),
		pullRequestSequences: new Map(),
		workspacePullResultCache: new Map(),
		openDocuments: new Set(),
		closedDocuments: new Set(),
		openDocumentUris: new Map(),
		pendingOpens: new Set(),
		projectIdentityProbedFiles: new Set(),
		// these are filled in after initialize — cast to avoid two-phase init
		workspaceDiagnosticsSupport:
			// SAFETY: initialize fills this capability before any workspace diagnostic request.
			undefined as unknown as LSPWorkspaceDiagnosticsSupport,
		// SAFETY: initialize fills this capability before operation dispatch.
		operationSupport: undefined as unknown as LSPOperationSupport,
		staticDiagnosticsMode: "push-only",
		positionEncoding: "utf-16",
		syncKind: TEXT_DOCUMENT_SYNC_KIND_FULL,
		dynamicRegistrations: new Map(),
		advertisedCommands: new Set(),
		serverEditsAllowed: 0,
		activeMutationDepth: 0,
		serverId,
		launchVariant,
		root,
		lspProcess,
		// two-phase: the flush closure needs `state` (below)
		// SAFETY: state construction completes before the flush closure can run.
		watchQueue: undefined as unknown as WatchedFilesQueue,
	};
	activeLspClientSet().add(state);

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
	setupConnectionLifecycle(state, recentStderr);

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
		// #1969: claim this kill BEFORE issuing it. `setupConnectionLifecycle`
		// ran above, so its `exit` and `close` handlers are already armed on
		// this child, and both read `state.shutdownRequested` to tell a crash
		// from a teardown we asked for. The kill below is one we asked for.
		// Without this line it reported as an unprompted death, fabricating a
		// `lsp-server-unexpected-close` entry reading
		// "code=1 signal=none stderr=empty" — character for character the
		// ast-grep signature this issue exists to make trustworthy — every time
		// a server merely failed to complete its handshake. It also silenced a
		// false `lsp_server_unexpected_exit` latency line that this path has
		// been writing since the #615 follow-up.
		state.shutdownRequested = true;
		// Hard-kill the hung process so it doesn't become a zombie.
		// SIGTERM alone is unreliable on Windows for cmd.exe/PowerShell trees.
		const pid = lspProcess.pid;
		void killProcessTree(lspProcess.process, pid);
		// A child registered above (recordLspChild) but never reaching a healthy
		// createLSPClient return must still be deregistered here — otherwise the
		// registry keeps a stale entry for a process we just killed.
		void removeLspChild(pid, extractSpawnMarker(lspProcess.args)).catch(
			(err) => {
				// best-effort — a stale registry entry is harmless (the reaper's
				// liveness check will find it dead on the next sweep regardless)
				logLatency({
					type: "phase",
					phase: "lsp_registry_write_failed",
					filePath: "",
					durationMs: 0,
					metadata: { op: "remove", pid, error: String(err) },
				});
			},
		);
		setTimeout(() => {
			// #1114: gate on the process's own observed `exitCode`/`signalCode`,
			// not `.killed` — `killProcessTree` above signals the POSIX process
			// GROUP via the raw `process.kill(-pid, …)`, which never touches
			// this `ChildProcess` instance's `.killed` flag, so `!…killed` here
			// was always true and this 2s backstop unconditionally re-sent
			// SIGKILL even when the group had already exited. `exitCode` alone
			// is insufficient too: a process that died FROM a signal (the
			// common case here — killProcessTree's own SIGTERM/SIGKILL) has
			// `exitCode === null` forever and only `signalCode` set, so
			// checking `exitCode === null` alone still re-SIGKILLs that corpse
			// on the common path (harmless — `kill()` on an already-exited pid
			// is a swallowed no-op — but not actually "observed still alive").
			// Require both null to mean "no exit observed by either signal".
			if (
				lspProcess.process.exitCode === null &&
				lspProcess.process.signalCode === null &&
				process.platform !== "win32"
			) {
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
	const capabilities = ((initResult as { capabilities?: unknown })
		?.capabilities ?? {}) as Record<string, unknown>;
	const workspace = isCapabilityRecord(capabilities.workspace)
		? capabilities.workspace
		: undefined;
	const fileOperations = isCapabilityRecord(workspace)
		? workspace.fileOperations
		: undefined;
	const malformedFileOperationRegistrations = new Set<
		"willRename" | "didRename"
	>();
	if (isCapabilityRecord(fileOperations)) {
		for (const operation of ["willRename", "didRename"] as const) {
			if (
				fileOperations[operation] !== undefined &&
				parseFileOperationFilters(fileOperations[operation]) === undefined
			) {
				malformedFileOperationRegistrations.add(operation);
			}
		}
	}
	state.fileOperationMalformedRegistrations =
		malformedFileOperationRegistrations;
	if (isCapabilityRecord(fileOperations)) {
		state.fileOperationFilters = {
			willRename: parseFileOperationFilters(fileOperations.willRename),
			didRename: parseFileOperationFilters(fileOperations.didRename),
		};
	}
	state.positionEncoding = negotiatePositionEncoding(
		(initResult as { capabilities?: unknown })?.capabilities,
	);
	state.syncKind = negotiateSyncKind(
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

		/** #1127: mirrors `state.shutdownRequested` — see interface doc. */
		wasShutdownIntentional: () => state.shutdownRequested,

		/** #1127: mirrors `state.exitedAt` — see interface doc. */
		getExitedAt: () => state.exitedAt,

		/** Last N lines of server stderr for diagnostics. */
		recentStderr: (lines?: number) => recentStderr(lines),
		getPullFailureHistory: () =>
			state.pullFailureHistory.map((entry) => ({
				...entry,
				message: entry.message.slice(0, 200),
			})),

		/** Pre-request health check — returns error string if dead. */
		checkAlive: () => checkProcessAlive(),

		/** #1277: cheap request round-trip proving the server still responds. */
		pingLiveness: (timeoutMs?: number) => clientPingLiveness(state, timeoutMs),

		/** #2358: the OS pid of the live server process (see interface doc). */
		getProcessPid: () => lspProcess.pid,

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
			watchedFileChange(filePath, type) {
				handleNotifyExternalChange(state, filePath, type);
			},
		},

		getDiagnostics(filePath) {
			return getMergedDiagnosticsForPath(state, normalizeMapKey(filePath));
		},

		getDiagnosticBinding(filePath) {
			return state.diagnosticBindings.get(normalizeMapKey(filePath));
		},

		getDiagnosticsVersionForPath(filePath) {
			return diagnosticsVersionForPath(state, normalizeMapKey(filePath));
		},

		getAllDiagnostics() {
			const result = new Map<
				string,
				{
					diags: LSPDiagnostic[];
					ts: number;
					binding?: StoredDiagnosticBinding;
				}
			>();
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
					binding: state.diagnosticBindings.get(key),
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
			].map((filePath) =>
				process.platform === "win32" ? filePath.replace(/\//g, "\\") : filePath,
			);
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

		requestWorkspaceDiagnostics(budgetMs: number) {
			return clientRequestWorkspaceDiagnostics(state, budgetMs);
		},

		getOperationSupport() {
			return state.operationSupport;
		},

		getMalformedFileOperationRegistrations() {
			return state.fileOperationMalformedRegistrations ?? new Set();
		},

		getAdvertisedCommands() {
			return [...state.advertisedCommands];
		},

		getRawCapabilityKeys() {
			return state.rawCapabilityKeys ?? [];
		},

		getLaunchVariant() {
			return state.launchVariant;
		},

		async executeCommand(command, args, mutationContext) {
			return runServerCommand(
				state,
				command,
				args,
				EXECUTE_COMMAND_TIMEOUT_MS,
				mutationContext,
			);
		},

		async executeReadOnlyCommand(command, args) {
			return runReadOnlyServerCommand(state, command, args);
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

		isDocumentOpen(filePath) {
			return state.openDocuments.has(normalizeMapKey(filePath));
		},

		isBusy() {
			return (activeRequestsByConnection.get(connection) ?? 0) > 0;
		},

		getDocumentUri(filePath) {
			return state.openDocumentUris?.get(normalizeMapKey(filePath));
		},

		async workspaceSymbol(query) {
			if (!isClientAlive(state)) return [];
			// Route through navRequest for the shared withTimeout ceiling — a hung
			// server would otherwise await forever (safeSendRequest only settles on
			// a reply or a destroyed stream). No staleCheckPath: not single-file.
			const result = await navRequest<LSPSymbol[]>(state, "workspace/symbol", {
				query,
			});
			return result ?? [];
		},

		async codeAction(filePath, line, character, endLine, endCharacter) {
			if (!isClientAlive(state)) return [];
			const uri = pathToFileURL(filePath).href;
			// navRequest adds the shared withTimeout ceiling + single-file
			// stale-drop (matches documentSymbol); a hung server no longer awaits
			// forever, and code actions computed against superseded content drop.
			const result = await navRequest<unknown[]>(
				state,
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
				filePath,
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
			return result ? await normalizeClientWorkspaceEdit(state, result) : null;
		},

		closeDocument: (filePath) => closeDocument(state, filePath),

		async willRenameFiles(oldFilePath, newFilePath) {
			if (!isClientAlive(state)) return null;
			// #1971 review: the server registered WHICH paths it cares about.
			// Sending outside those filters asks a question the server never
			// signed up to answer.
			const oldUri = pathToFileURL(oldFilePath).href;
			const newUri = pathToFileURL(newFilePath).href;
			if (
				!(await fileOperationFiltersMatch(
					state.fileOperationFilters?.willRename,
					oldUri,
					newUri,
					oldFilePath,
					newFilePath,
				))
			) {
				recordDegradationOnce({
					kind: "lsp-capability-skip",
					subject: `${state.serverId}:workspace/willRenameFiles:filter`,
					reason: "filter-mismatch",
				});
				return null;
			}
			const result = await navRequest<LSPWorkspaceEdit>(
				state,
				"workspace/willRenameFiles",
				{
					files: [
						{
							oldUri,
							newUri,
						},
					],
				},
			);
			return result ? await normalizeClientWorkspaceEdit(state, result) : null;
		},

		async didRenameFiles(oldFilePath, newFilePath, oldUri, newUri) {
			if (!isClientAlive(state)) return;
			// `fileOperationFilters.didRename` is parsed by the same predicate that
			// derives operationSupport.didRenameFiles (see
			// isFileOperationRegistrationOptions). Thus filters undefined iff the
			// capability is absent; the service-level gate remains the enforcement
			// point for aggregated dispatch.
			// #1971 review: same registration-filter discipline as willRename —
			// the server only signed up to hear about matching paths.
			const wireOldUri = oldUri ?? pathToFileURL(oldFilePath).href;
			const wireNewUri = newUri ?? pathToFileURL(newFilePath).href;
			if (
				!(await fileOperationFiltersMatch(
					state.fileOperationFilters?.didRename,
					wireOldUri,
					wireNewUri,
					oldFilePath,
					newFilePath,
				))
			) {
				recordDegradationOnce({
					kind: "lsp-capability-skip",
					subject: `${state.serverId}:workspace/didRenameFiles:filter`,
					reason: "filter-mismatch",
				});
				return;
			}
			await safeSendNotification(state.connection, "workspace/didRenameFiles", {
				files: [
					{
						oldUri: wireOldUri,
						newUri: wireNewUri,
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
/**
 * Returns `true` once the notification was actually handed to the transport,
 * `false` when a stream error was swallowed (connection error handlers will
 * update state separately). #1669 review F7: callers that mirror what they
 * just told the server locally (`recordSentContent`) MUST gate on this
 * return value — recording a send that never left the process would desync
 * the mirror from what the server actually has, with nothing to self-heal
 * it (the next Incremental range would be computed against content the
 * server never saw).
 */
async function safeSendNotification(
	connection: MessageConnection,
	method: string,
	params: unknown,
): Promise<boolean> {
	try {
		await connection.sendNotification(method as never, params as never);
		return true;
	} catch (err) {
		if (isStreamError(err)) {
			// Silently ignore - stream was destroyed, connection error handlers will update state
			return false;
		}
		throw err;
	}
}

const activeRequestsByConnection = new WeakMap<MessageConnection, number>();

// Helper to safely send requests - catches stream destruction
async function safeSendRequest<T>(
	connection: MessageConnection,
	method: string,
	params: unknown,
	// When provided, aborting the signal cancels the in-flight request via
	// vscode-jsonrpc's CancellationToken → an LSP `$/cancelRequest` notification,
	// so a server stops computing a result the agent has already abandoned (#238
	// Item 1). The rejection that follows is swallowed (treated as `undefined`).
	signal?: AbortSignal,
	settlement?: { cancelled: boolean },
): Promise<T | undefined> {
	// Already abandoned before we even sent — don't bother the server.
	if (signal?.aborted) return undefined;

	let tokenSource: InstanceType<typeof CancellationTokenSource> | undefined;
	let onAbort: (() => void) | undefined;
	if (signal) {
		tokenSource = new CancellationTokenSource();
		onAbort = () => tokenSource?.cancel();
		signal.addEventListener("abort", onAbort, { once: true });
	}

	// Only pass a token when cancellation is wired, so the call shape is unchanged
	// for the (many) requests without a signal.
	const send = () =>
		tokenSource
			? connection.sendRequest(
					method as never,
					params as never,
					tokenSource.token as never,
				)
			: connection.sendRequest(method as never, params as never);

	activeRequestsByConnection.set(
		connection,
		(activeRequestsByConnection.get(connection) ?? 0) + 1,
	);
	try {
		// One safe retry on ContentModified (-32801): the document changed under
		// us, so the server discarded the request. A single retry beats returning
		// empty — correctness-under-edit is pi-lens's whole hot path (#238 Item 2).
		const MAX_ATTEMPTS = 2;
		for (let attempt = 1; ; attempt++) {
			try {
				return (await send()) as T;
			} catch (err) {
				if (isCancellationError(err)) {
					if (settlement) settlement.cancelled = true;
					return undefined;
				}
				if (isStreamError(err)) {
					// Stream destroyed; connection handlers update client state separately.
					return undefined;
				}
				if (isContentModifiedError(err)) {
					// Retry once (unless we've since been aborted); if it's still
					// ContentModified after that, return empty rather than throwing a
					// code callers don't understand. RequestFailed (-32803) and other
					// codes are permanent and fall through to the rethrow below.
					if (attempt < MAX_ATTEMPTS && !signal?.aborted) continue;
					return undefined;
				}
				throw err;
			}
		}
	} finally {
		const remaining = (activeRequestsByConnection.get(connection) ?? 1) - 1;
		if (remaining > 0) activeRequestsByConnection.set(connection, remaining);
		else activeRequestsByConnection.delete(connection);
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		tokenSource?.dispose();
	}
}

// vscode-jsonrpc rejects a token-cancelled request with a `ResponseError` whose
// code is `RequestCancelled` (-32800) or `ServerCancelled` (-32802). Treat both
// as "no result" rather than a failure. (isStreamError also matches the
// "cancelled" message text; this adds the structured error-code path.)
function isCancellationError(err: unknown): boolean {
	const code = (err as { code?: unknown } | null)?.code;
	return code === -32800 || code === -32802;
}

// `ContentModified` (-32801): the document changed while the request was in
// flight, so the server couldn't answer against a consistent state. Retryable —
// the only LSP error code worth a second attempt on the edit hot path (#238).
function isContentModifiedError(err: unknown): boolean {
	return (err as { code?: unknown } | null)?.code === -32801;
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
			workspaceDiagnostics: false,
			diagnosticProviderKind: "none",
		};
	}

	if (typeof diagnosticProvider === "boolean") {
		return {
			advertised: diagnosticProvider,
			mode: diagnosticProvider ? "pull" : "push-only",
			// The boolean form of diagnosticProvider only signals document pull.
			workspaceDiagnostics: false,
			diagnosticProviderKind: "boolean",
		};
	}

	if (typeof diagnosticProvider === "object") {
		return {
			advertised: true,
			mode: "pull",
			workspaceDiagnostics:
				(diagnosticProvider as { workspaceDiagnostics?: unknown })
					.workspaceDiagnostics === true,
			diagnosticProviderKind: "object",
		};
	}

	return {
		advertised: false,
		mode: "push-only",
		workspaceDiagnostics: false,
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
		return isCapabilityRecord(value);
	};
	const codeActionProvider = capabilities?.codeActionProvider;
	const workspace = capabilities?.workspace;
	const fileOperations = isCapabilityRecord(workspace)
		? workspace.fileOperations
		: undefined;

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
		codeActionResolve:
			isCapabilityRecord(codeActionProvider) &&
			codeActionProvider.resolveProvider === true,
		rename: hasProvider("renameProvider"),
		willRenameFiles:
			isCapabilityRecord(fileOperations) &&
			isFileOperationRegistrationOptions(fileOperations.willRename),
		didRenameFiles:
			isCapabilityRecord(fileOperations) &&
			isFileOperationRegistrationOptions(fileOperations.didRename),
		implementation: hasProvider("implementationProvider"),
		callHierarchy: hasProvider("callHierarchyProvider"),
	};
}

function isCapabilityRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileOperationRegistrationOptions(value: unknown): boolean {
	return parseFileOperationFilters(value) !== undefined;
}

/** One parsed `FileOperationFilter` from a registration-options object. */
export interface LSPFileOperationFilter {
	scheme: string | undefined;
	glob: string;
	matches: "file" | "folder" | undefined;
	ignoreCase: boolean;
}

/**
 * Parse the filters of a `FileOperationRegistrationOptions` object. Returns
 * `undefined` when the options are absent or malformed — callers treat that as
 * "no interest declared" and fail closed, never sending the operation.
 */
function parseFileOperationFilters(
	value: unknown,
): LSPFileOperationFilter[] | undefined {
	if (!isCapabilityRecord(value) || !Array.isArray(value.filters)) {
		return undefined;
	}
	const filters: LSPFileOperationFilter[] = [];
	for (const entry of value.filters) {
		if (!isCapabilityRecord(entry)) return undefined;
		const pattern = entry.pattern;
		if (
			!isCapabilityRecord(pattern) ||
			typeof pattern.glob !== "string" ||
			pattern.glob.trim() === ""
		) {
			return undefined;
		}
		if (
			entry.scheme !== undefined &&
			(typeof entry.scheme !== "string" ||
				entry.scheme.trim() === "" ||
				!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(entry.scheme))
		) {
			return undefined;
		}
		const matches = pattern.matches;
		if (matches !== undefined && matches !== "file" && matches !== "folder") {
			return undefined;
		}
		if (pattern.options !== undefined && !isCapabilityRecord(pattern.options)) {
			return undefined;
		}
		const options = isCapabilityRecord(pattern.options)
			? pattern.options
			: undefined;
		if (
			options?.ignoreCase !== undefined &&
			typeof options.ignoreCase !== "boolean"
		) {
			return undefined;
		}
		filters.push({
			scheme: entry.scheme?.toLowerCase(),
			glob: pattern.glob,
			matches: matches === "file" || matches === "folder" ? matches : undefined,
			ignoreCase: options?.ignoreCase === true,
		});
	}
	return filters;
}

/**
 * Whether ANY parsed filter expresses interest in either path of a rename.
 * Conservative by design: unsupported URI schemes, an unresolved explicit
 * file/folder kind, malformed URIs, and zero filters all match nothing.
 */
async function fileOperationFiltersMatch(
	filters: LSPFileOperationFilter[] | undefined,
	oldUri: string,
	newUri: string,
	oldFilePath: string,
	newFilePath: string,
): Promise<boolean> {
	if (!filters || filters.length === 0) return false;
	const candidates = [oldUri, newUri].flatMap(fileOperationUriCandidates);
	const entityKind = filters.some((filter) => filter.matches !== undefined)
		? await probeRenameEntityKind(oldFilePath, newFilePath)
		: undefined;
	for (const filter of filters) {
		if (filter.scheme !== undefined && filter.scheme !== "file") continue;
		if (filter.matches !== undefined && filter.matches !== entityKind) continue;
		for (const candidate of candidates) {
			try {
				if (
					minimatch(candidate, filter.glob, {
						nocase: filter.ignoreCase,
						dot: true,
					})
				) {
					return true;
				}
			} catch {
				// Malformed glob implementations must never widen server fan-out.
			}
		}
	}
	return false;
}

function fileOperationUriCandidates(uri: string): string[] {
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		return [];
	}
	// pi-lens performs local filesystem renames only. Even when a caller supplies
	// preserved URI spelling, another scheme cannot describe that operation.
	if (parsed.protocol.toLowerCase() !== "file:") return [];
	let uriPath: string;
	try {
		uriPath = decodeURIComponent(parsed.pathname).replace(/\\/g, "/");
	} catch {
		return [];
	}
	return [uriPath];
}

async function probeRenameEntityKind(
	oldFilePath: string,
	newFilePath: string,
): Promise<"file" | "folder" | undefined> {
	for (const filePath of [oldFilePath, newFilePath]) {
		try {
			const info = await lstat(filePath);
			return info.isDirectory() ? "folder" : "file";
		} catch {
			// Before the rename the old path normally exists; after it, the new path
			// does. Probe both instead of deriving behavior from the host OS.
		}
	}
	return undefined;
}
