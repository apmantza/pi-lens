/**
 * LSP Service Layer for pi-lens
 *
 * Manages multiple LSP clients per workspace with:
 * - Auto-spawning based on file type
 * - Effect-TS service composition
 * - Bus event integration
 * - Resource cleanup
 */

import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isTestMode } from "../env-utils.js";
import {
	getGlobalPiLensDir,
	getProjectIgnoreMatcher,
	isExcludedDirName,
} from "../file-utils.js";
import { recordLsp } from "../widget-state.js";
import { logLatency } from "../latency-logger.js";
import { normalizeMapKey, uriToPath } from "../path-utils.js";
import type {
	LSPClientInfo,
	LSPOperationSupport,
	LSPShutdownOptions,
	LSPWorkspaceDiagnosticsSupport,
} from "./client.js";
import { createLSPClient } from "./client.js";
import { getServersForFileWithConfig } from "./config.js";
import { getLanguageId } from "./language.js";
import type { LSPServerInfo } from "./server.js";
import {
	LSP_SERVERS,
	isDirectLspCommandTemporarilyUnavailable,
} from "./server.js";
import { getStrategy } from "./server-strategies.js";
import { raceToCompletion } from "./aggregation.js";
import {
	applyWorkspaceEdit,
	mergeWorkspaceTextEditsByPriority,
	summarizeWorkspaceEdit,
} from "./edits.js";

// --- Types ---

export interface LSPState {
	clients: Map<string, LSPClientInfo>; // key: "serverId:root"
	servers: Map<string, LSPServerInfo>;
	broken: Map<string, number>; // servers that failed to initialize with retry-at timestamp
	inFlight: Map<string, Promise<SpawnedServer | undefined>>; // prevent duplicate spawns
	clientSpawnedAt: Map<string, number>; // key: "serverId:root" → epoch ms of last successful spawn
}

const BROKEN_BASE_COOLDOWN_MS = 15_000;
const BROKEN_MAX_COOLDOWN_MS = 5 * 60_000; // cap at 5 minutes
const BROKEN_PERMANENT_AFTER = 5; // disable for session after N consecutive failures
const OPTIONAL_LSP_RETRY_COOLDOWN_MS = 5 * 60_000;
const OPTIONAL_LSP_SERVER_IDS = new Set<string>();
const NAV_CLIENT_WAIT_TIMEOUT_MS = Math.max(
	0,
	Number.parseInt(process.env.PI_LENS_LSP_NAV_CLIENT_WAIT_MS ?? "1500", 10) ||
		1500,
);
const TOUCH_DEBOUNCE_MS = Math.max(
	0,
	Number.parseInt(process.env.PI_LENS_LSP_TOUCH_DEBOUNCE_MS ?? "1500", 10) ||
		1500,
);

/**
 * Read the `PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS` env override at call time
 * (process.env mutations in tests stay live). Returns undefined when unset,
 * non-numeric, or negative — callers fall back through the explicit option
 * chain in {@link LSPService.touchFile}.
 */
function readEnvDiagnosticsWaitMs(): number | undefined {
	const raw = process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
	if (raw === undefined) return undefined;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
	return parsed;
}
const DIAGNOSTICS_SEMANTIC_SETTLE_THRESHOLD_MS = Math.max(
	0,
	Number.parseInt(
		process.env.PI_LENS_LSP_DIAGNOSTICS_SEMANTIC_THRESHOLD_MS ?? "250",
		10,
	) || 250,
);
const DIAGNOSTICS_SEMANTIC_SETTLE_WAIT_MS = Math.max(
	0,
	Number.parseInt(
		process.env.PI_LENS_LSP_DIAGNOSTICS_SEMANTIC_SETTLE_MS ?? "400",
		10,
	) || 400,
);
// Once the fastest client has diagnostics, remaining clients get this window before
// we proceed with whatever results are ready. 0 disables early-unblock.
const EARLY_UNBLOCK_GRACE_MS = Math.max(
	0,
	Number.parseInt(
		process.env.PI_LENS_LSP_EARLY_UNBLOCK_GRACE_MS ?? "400",
		10,
	) || 400,
);
const CASCADE_DIAGNOSTICS_TTL_MS = 240_000;
const SESSIONSTART_LOG_DIR = getGlobalPiLensDir();
const SESSIONSTART_LOG = path.join(SESSIONSTART_LOG_DIR, "sessionstart.log");

function logSessionStart(msg: string): void {
	if (isTestMode()) {
		return;
	}
	const line = `[${new Date().toISOString()}] ${msg}\n`;
	void fs
		.mkdir(SESSIONSTART_LOG_DIR, { recursive: true })
		.then(() => fs.appendFile(SESSIONSTART_LOG, line))
		.catch(() => {
			// best-effort logging
		});
}

export interface SpawnedServer {
	client: LSPClientInfo;
	info: LSPServerInfo;
}

export interface LSPCapabilitySnapshot {
	serverId: string;
	root: string;
	operationSupport: LSPOperationSupport;
	workspaceDiagnosticsSupport: LSPWorkspaceDiagnosticsSupport;
	/** Commands the server advertised for workspace/executeCommand (the allowlist) */
	advertisedCommands: string[];
	/** Top-level keys of the raw ServerCapabilities advertised at initialize. */
	rawCapabilityKeys: string[];
}

export interface LSPRenameFileResult {
	applied: boolean;
	serverIds: string[];
	willRenameFailures: Array<{ serverId: string; error: string }>;
	didRenameFailures: Array<{ serverId: string; error: string }>;
	droppedConflicts: number;
	inputEditCount: number;
	summary: string[];
	descriptions?: string[];
	files?: string[];
}

export interface LSPDiagnosticsHealth {
	health: "ok" | "ok_empty" | "no_clients" | "no_clients_stale" | "destroyed";
	failureKind: string;
	serverCountAttempted: number;
	serverCountReady: number;
	candidateServerIds: string[];
	mergedCount: number;
	dedupDroppedCount: number;
	checkedAt: string;
}

function mergeLspDiagnostics(
	diagnostics: import("./client.js").LSPDiagnostic[],
): import("./client.js").LSPDiagnostic[] {
	const merged: import("./client.js").LSPDiagnostic[] = [];
	const seen = new Set<string>();
	for (const diagnostic of diagnostics) {
		const key = [
			diagnostic.range.start.line,
			diagnostic.range.start.character,
			diagnostic.message,
		].join(":");
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(diagnostic);
	}
	return merged;
}

export type LSPDiagnosticsMode = "none" | "document" | "full";
export type LSPTouchClientScope = "primary" | "all" | "with-auxiliary";

export interface LSPTouchFileOptions {
	diagnostics?: LSPDiagnosticsMode;
	source?: string;
	clientScope?: LSPTouchClientScope;
	/**
	 * For clientScope "with-auxiliary": the auxiliary server ids (e.g. "opengrep")
	 * to attach alongside the primary. The caller (lsp runner) computes which are
	 * enabled (it owns flag access); the service just spawns + collects them.
	 */
	auxiliaryServerIds?: readonly string[];
	/** Budget for waiting on the LSP client to spawn / become ready. */
	maxClientWaitMs?: number;
	/**
	 * Budget for waiting on `textDocument/publishDiagnostics` after the notify
	 * lands. The dispatch-lsp-runner sets this to a tighter value so a slow
	 * LSP on one file doesn't dominate the per-edit pipeline budget (#117).
	 *
	 * Resolution order (first wins):
	 *   1. `PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS` env var (user override)
	 *   2. this option
	 *   3. `maxClientWaitMs` (legacy fallback)
	 *   4. built-in defaults (3000 ms for `full`, 1200 ms for `document`)
	 */
	maxDiagnosticsWaitMs?: number;
	/** Return merged diagnostics from the clients touched by this call. */
	collectDiagnostics?: boolean;
	/** Skip workspace/didChangeWatchedFiles — use for cascade reads, not real fs changes */
	silent?: boolean;
}

export interface LSPWorkspaceDiagnosticResult {
	filePath: string;
	diagnostics: import("./client.js").LSPDiagnostic[];
	count: number;
	error?: string;
}

const WORKSPACE_DIAGNOSTICS_CONCURRENCY = 8;

// Hard cap on the workspace-diagnostics walk. Even though this is an explicit,
// user-invoked project-wide tool, the walk must be bounded so a misrooted run
// (e.g. cwd that resolves to $HOME) can't enumerate an entire home tree (#250).
// Generous — real projects are well under this; override for monorepos.
const DEFAULT_MAX_WORKSPACE_DIAGNOSTIC_FILES = 5000;

function getMaxWorkspaceDiagnosticFiles(): number {
	const override = Number.parseInt(
		process.env.PI_LENS_LSP_WORKSPACE_MAX_FILES ?? "",
		10,
	);
	return Number.isFinite(override) && override > 0
		? override
		: DEFAULT_MAX_WORKSPACE_DIAGNOSTIC_FILES;
}

/**
 * Async, event-loop-yielding walk of the workspace to find LSP-supported source
 * files. Uses `fs.promises.readdir` so each directory read hands control back to
 * the loop — a synchronous `readdirSync` recursion blocks the loop for the whole
 * O(N) enumeration (~44ms at 1.4k files, scaling linearly on monorepos).
 *
 * Directory/file exclusion goes through the SAME ignore matcher every other scan
 * surface uses: `isExcludedDirName` for default dependency/build dirs plus the
 * project's `.pi-lens.json` / `.gitignore` patterns via `getProjectIgnoreMatcher`.
 * Previously this walk used its own hardcoded skip-dir set, which silently
 * dropped user `"ignore": [...]` patterns and diverged from the canonical list
 * (#243). The walk is also hard-capped (#250).
 */
async function collectWorkspaceDiagnosticFiles(
	root: string,
	maxFiles: number = getMaxWorkspaceDiagnosticFiles(),
	signal?: AbortSignal,
): Promise<string[]> {
	const files: string[] = [];
	const ignoreMatcher = getProjectIgnoreMatcher(root);
	async function walk(current: string): Promise<void> {
		if (signal?.aborted || files.length >= maxFiles) return;
		let entries: nodeFs.Dirent[];
		try {
			entries = await nodeFs.promises.readdir(current, {
				withFileTypes: true,
			});
		} catch {
			return;
		}
		for (const entry of entries) {
			if (signal?.aborted || files.length >= maxFiles) return;
			if (entry.isSymbolicLink()) continue;
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (isExcludedDirName(entry.name)) continue;
				if (ignoreMatcher.isIgnored(full, true)) continue;
				await walk(full);
			} else if (
				entry.isFile() &&
				!ignoreMatcher.isIgnored(full, false) &&
				getServersForFileWithConfig(full).length > 0
			) {
				files.push(full);
			}
		}
	}
	await walk(root);
	return files;
}

// --- Service ---

export class LSPService {
	private state: LSPState;
	private readonly workspaceProbeLogged = new Set<string>();
	private readonly warmStartLogged = new Set<string>();
	private readonly optionalFailureLogged = new Set<string>();
	private readonly optionalDisabled = new Set<string>();
	/** Consecutive failure counts for exponential backoff circuit breaker */
	private readonly failureCounts = new Map<string, number>();
	/** Server/root keys disabled for the rest of this session after repeated failures. */
	private readonly permanentlyBroken = new Set<string>();
	/**
	 * Last non-empty diagnostic result per normalized file path.
	 * Returned as a fallback when no live LSP clients are available so the
	 * widget keeps showing the last known issues rather than going blank.
	 */
	private readonly lastKnownDiagnostics = new Map<
		string,
		import("./client.js").LSPDiagnostic[]
	>();
	/**
	 * SHA-256 of the file content that produced the matching {@link
	 * lastKnownDiagnostics} entry, when that content is known (set by
	 * {@link touchFile}). Lets a hot-path consumer verify a cached entry is for
	 * the *current* bytes before trusting it as fresh — see
	 * {@link getLastKnownDiagnostics}. Absent for entries written without content
	 * (the service-level {@link getDiagnostics} merge), so a hash-guarded read of
	 * those falls through to a fresh check rather than serving a stale result.
	 */
	private readonly lastKnownContentHash = new Map<string, string>();
	private readonly lastDiagnosticsHealth = new Map<
		string,
		LSPDiagnosticsHealth
	>();
	private readonly recentTouches = new Map<
		string,
		{ fingerprint: string; touchedAt: number; clientScope: LSPTouchClientScope }
	>();
	/** True after shutdown() has been called; blocks new operations */
	private isDestroyed = false;

	constructor() {
		this.state = {
			clients: new Map(),
			servers: new Map(),
			broken: new Map(),
			inFlight: new Map(),
			clientSpawnedAt: new Map(),
		};
	}

	/** Guard: return true if service is shutting down or shut down */
	private checkDestroyed(): boolean {
		return this.isDestroyed;
	}

	private fingerprintContent(content: string): string {
		if (content.length <= 96) {
			return `${content.length}:${content}`;
		}
		return `${content.length}:${content.slice(0, 48)}:${content.slice(-48)}`;
	}

	/**
	 * Should the whole touchFile call short-circuit? Only when the caller does
	 * NOT need diagnostics — those callers still need to wait for the LSP to
	 * publish, even if the notify itself is a no-op.
	 */
	private shouldSkipTouch(
		filePath: string,
		content: string,
		clientScope: LSPTouchClientScope,
		waitForDiagnostics: boolean,
	): boolean {
		if (waitForDiagnostics) return false;
		return this.shouldSkipNotify(filePath, content, clientScope);
	}

	/**
	 * Should the didOpen/didChange notify be skipped while keeping the
	 * waitForDiagnostics step? True when the same content was already pushed
	 * recently. Skipping the notify avoids the diagnostic-cache clear that
	 * notify.open does, so the LSP doesn't restart computation it already
	 * finished for the first push.
	 *
	 * Concretely: the post-write tool_result fires touchFile with
	 * diagnosticsMode="none" first; the dispatch-lsp-runner fires it again
	 * with diagnosticsMode="document" moments later. Without this check the
	 * second call's notify clears in-progress diagnostics and the LSP has to
	 * start over — observed as multi-second waits on slow TS projects.
	 */
	private shouldSkipNotify(
		filePath: string,
		content: string,
		clientScope: LSPTouchClientScope,
	): boolean {
		if (TOUCH_DEBOUNCE_MS <= 0) return false;
		const key = `${normalizeMapKey(filePath)}:${clientScope}`;
		const previous = this.recentTouches.get(key);
		if (!previous) return false;
		const now = Date.now();
		if (now - previous.touchedAt > TOUCH_DEBOUNCE_MS) return false;
		return previous.fingerprint === this.fingerprintContent(content);
	}

	private markTouched(
		filePath: string,
		content: string,
		clientScope: LSPTouchClientScope,
	): void {
		const key = `${normalizeMapKey(filePath)}:${clientScope}`;
		const now = Date.now();
		this.recentTouches.set(key, {
			fingerprint: this.fingerprintContent(content),
			touchedAt: now,
			clientScope,
		});
		// Trim entries that are already past the debounce window — shouldSkipTouch
		// ignores them anyway, so they serve no purpose. Only sweep when the map
		// exceeds the threshold to avoid iterating on every call.
		if (this.recentTouches.size > 200) {
			for (const [k, v] of this.recentTouches) {
				if (now - v.touchedAt > TOUCH_DEBOUNCE_MS) {
					this.recentTouches.delete(k);
				}
			}
		}
	}

	private activeClientsForCwd(
		cwd: string,
		priorityServerIds: string[] = [],
	): Array<{ serverId: string; client: LSPClientInfo }> {
		const normalizedCwd = normalizeMapKey(cwd);
		const priority = new Map(
			priorityServerIds.map((serverId, index) => [serverId, index]),
		);
		const entries: Array<{ serverId: string; client: LSPClientInfo }> = [];
		for (const [key, client] of this.state.clients) {
			if (!client.isAlive()) continue;
			const separator = key.indexOf(":");
			const serverId = separator >= 0 ? key.slice(0, separator) : key;
			const root = normalizeMapKey(client.root);
			const sameOrNested =
				root === normalizedCwd ||
				root.startsWith(`${normalizedCwd}/`) ||
				normalizedCwd.startsWith(`${root}/`);
			if (!sameOrNested) continue;
			entries.push({ serverId, client });
		}
		return entries.sort(
			(a, b) =>
				(priority.get(a.serverId) ?? Number.MAX_SAFE_INTEGER) -
				(priority.get(b.serverId) ?? Number.MAX_SAFE_INTEGER),
		);
	}

	/**
	 * Get or create LSP client for a file
	 * Prevents duplicate client creation via in-flight promise tracking
	 */
	async getClientForFile(
		filePath: string,
		maxWaitMs?: number,
		hardCapMs?: number,
	): Promise<SpawnedServer | undefined> {
		if (this.checkDestroyed()) return undefined;
		// Primary selection considers language servers only — auxiliary servers
		// (opengrep, …) attach alongside the primary and are never chosen as it.
		const servers = getServersForFileWithConfig(filePath).filter(
			(s) => s.role !== "auxiliary",
		);
		const serverWaitOverrideMs = servers.reduce(
			(max, server) => Math.max(max, server.clientWaitTimeoutMs ?? 0),
			0,
		);
		// hardCapMs is a caller-imposed ceiling (e.g. pipeline budget) that
		// prevents tool_result from blocking the TUI for the full LSP cold-start
		// window. When no server config sets a wait (serverWaitOverrideMs = 0),
		// hardCapMs is used directly — Math.min(0, cap) = 0 would otherwise
		// take the no-timeout branch and block indefinitely (e.g. pyright, which
		// has no clientWaitTimeoutMs but can take 30s to initialize on cold start).
		const serverBaseMs = Math.max(maxWaitMs ?? 0, serverWaitOverrideMs);
		const effectiveMaxWaitMs =
			hardCapMs !== undefined
				? serverBaseMs > 0
					? Math.min(serverBaseMs, hardCapMs)
					: hardCapMs
				: serverBaseMs;

		const withBudget = async (): Promise<SpawnedServer | undefined> => {
			if (servers.length === 0) return undefined;

			// Try each matching server
			for (const server of servers) {
				const spawned = await this.ensureClientForServer(filePath, server);
				if (spawned) {
					logLatency({
						type: "phase",
						phase: "lsp_client_selected",
						filePath,
						durationMs: 0,
						metadata: {
							serverId: server.id,
							candidateCount: servers.length,
						},
					});
					return spawned;
				}
			}

			logLatency({
				type: "phase",
				phase: "lsp_client_unavailable",
				filePath,
				durationMs: 0,
				metadata: {
					candidateCount: servers.length,
					servers: servers.map((server) => server.id),
				},
			});

			return undefined;
		};

		if (!effectiveMaxWaitMs || effectiveMaxWaitMs <= 0) {
			return withBudget();
		}

		const timeoutSentinel = Symbol("lsp-client-wait-timeout");
		const waitResult = await Promise.race<
			SpawnedServer | undefined | typeof timeoutSentinel
		>([
			withBudget(),
			new Promise<typeof timeoutSentinel>((resolve) =>
				setTimeout(() => resolve(timeoutSentinel), effectiveMaxWaitMs),
			),
		]);

		if (waitResult === timeoutSentinel) {
			// Snapshot known client health — scan by serverId prefix (no root needed)
			const knownHealth = [...this.state.clients.entries()]
				.filter(([k]) => servers.some((s) => k.startsWith(`${s.id}:`)))
				.map(([k, c]) => ({
					serverId: k.split(":")[0],
					alive: c.isAlive(),
					spawnedAt: this.state.clientSpawnedAt.get(k) ?? null,
				}));
			logLatency({
				type: "phase",
				phase: "lsp_client_wait_timeout",
				filePath,
				durationMs: effectiveMaxWaitMs,
				metadata: {
					maxWaitMs: effectiveMaxWaitMs,
					serverIds: servers.map((s) => s.id),
					// servers absent from knownHealth were never spawned or are still spawning
					knownClientHealth: knownHealth,
				},
			});
			return undefined;
		}

		return waitResult;
	}

	/**
	 * Get or create ALL LSP clients that can serve a file.
	 * Used for diagnostics aggregation across complementary servers.
	 */
	async getClientsForFile(
		filePath: string,
	): Promise<{ clients: SpawnedServer[]; serverCountAttempted: number }> {
		const servers = getServersForFileWithConfig(filePath);
		if (servers.length === 0) return { clients: [], serverCountAttempted: 0 };

		// Count servers with a valid root as "attempted" — extension-only matches
		// that fail the root check are not real spawn attempts.
		const roots = await Promise.all(servers.map((s) => s.root(filePath)));
		const serverCountAttempted = roots.filter(Boolean).length;

		const spawned = await Promise.all(
			servers.map((server) => this.ensureClientForServer(filePath, server)),
		);
		return {
			clients: spawned.filter((entry): entry is SpawnedServer =>
				Boolean(entry),
			),
			serverCountAttempted,
		};
	}

	/**
	 * Spawn/get the AUXILIARY clients for a file (role:"auxiliary") restricted to
	 * the enabled set. These attach alongside the primary on the with-auxiliary
	 * diagnostics path (cross-cutting scanners like opengrep).
	 */
	async getAuxiliaryClientsForFile(
		filePath: string,
		enabledIds: ReadonlySet<string>,
	): Promise<SpawnedServer[]> {
		if (this.checkDestroyed() || enabledIds.size === 0) return [];
		const servers = getServersForFileWithConfig(filePath).filter(
			(s) => s.role === "auxiliary" && enabledIds.has(s.id),
		);
		if (servers.length === 0) return [];
		const spawned = await Promise.all(
			servers.map((server) => this.ensureClientForServer(filePath, server)),
		);
		return spawned.filter((entry): entry is SpawnedServer => Boolean(entry));
	}

	/**
	 * Get a warm LSP client for a file without spawning.
	 * Returns undefined if no matching client is already connected and alive.
	 */
	async getWarmClientForFile(
		filePath: string,
	): Promise<SpawnedServer | undefined> {
		if (this.checkDestroyed()) return undefined;
		const servers = getServersForFileWithConfig(filePath);
		for (const server of servers) {
			const root = await server.root(filePath);
			if (!root) continue;
			const key = `${server.id}:${normalizeMapKey(root)}`;
			const existing = this.state.clients.get(key);
			if (existing?.isAlive()) {
				return { client: existing, info: server };
			}
		}
		return undefined;
	}

	private async ensureClientForServer(
		filePath: string,
		server: LSPServerInfo,
	): Promise<SpawnedServer | undefined> {
		const root = await server.root(filePath);
		if (!root) return undefined;
		const allowInstall = this.shouldAllowInstall(filePath, root);

		const normalizedRoot = normalizeMapKey(root);
		const key = `${server.id}:${normalizedRoot}`;
		const isOptionalServer = OPTIONAL_LSP_SERVER_IDS.has(server.id); // NOSONAR: set intentionally empty — no optional servers configured yet

		if (
			server.availabilityKey &&
			isDirectLspCommandTemporarilyUnavailable(server.availabilityKey)
		) {
			logLatency({
				type: "phase",
				phase: "lsp_client_skipped_unavailable_command",
				filePath,
				durationMs: 0,
				metadata: {
					serverId: server.id,
					command: server.availabilityKey,
				},
			});
			return undefined;
		}

		if (isOptionalServer && this.optionalDisabled.has(key)) {
			return undefined;
		}
		if (this.permanentlyBroken.has(key)) {
			logLatency({
				type: "phase",
				phase: "lsp_client_skipped_broken",
				filePath,
				durationMs: 0,
				metadata: {
					serverId: server.id,
					permanent: true,
				},
			});
			return undefined;
		}

		const existing = this.state.clients.get(key);
		if (existing) {
			if (existing.isAlive()) {
				if (!this.warmStartLogged.has(key)) {
					logSessionStart(
						`lsp warm-start ${server.id}: reused root=${root} file=${filePath}`,
					);
					this.warmStartLogged.add(key);
				}
				return { client: existing, info: server };
			}
			// Dead client — was previously alive, now needs respawn
			const spawnedAt = this.state.clientSpawnedAt.get(key);
			logLatency({
				type: "phase",
				phase: "lsp_server_respawn",
				filePath,
				durationMs: 0,
				metadata: {
					serverId: server.id,
					root,
					uptimeMs: spawnedAt != null ? Date.now() - spawnedAt : null,
				},
			});
			try {
				await existing.shutdown();
			} catch {
				/* ignore dead client shutdown errors */
			}
			this.state.clients.delete(key);
			this.state.clientSpawnedAt.delete(key);
			this.state.broken.delete(key);
		}

		const brokenUntil = this.state.broken.get(key);
		if (typeof brokenUntil === "number" && brokenUntil > Date.now()) {
			logLatency({
				type: "phase",
				phase: "lsp_client_skipped_broken",
				filePath,
				durationMs: 0,
				metadata: {
					serverId: server.id,
					retryInMs: Math.max(0, brokenUntil - Date.now()),
				},
			});
			return undefined;
		}
		if (typeof brokenUntil === "number" && brokenUntil <= Date.now()) {
			this.state.broken.delete(key);
			if (isOptionalServer) this.optionalDisabled.delete(key);
		}

		const inFlight = this.state.inFlight.get(key);
		if (inFlight) {
			return inFlight;
		}

		const spawnPromise = this.spawnClient(
			server,
			root,
			key,
			filePath,
			allowInstall,
		);
		this.state.inFlight.set(key, spawnPromise);

		try {
			return await spawnPromise;
		} finally {
			this.state.inFlight.delete(key);
		}
	}

	private shouldAllowInstall(_filePath: string, _root: string): boolean {
		return process.env.PI_LENS_DISABLE_LSP_INSTALL !== "1";
	}

	/**
	 * Internal: spawn a client for a server/root combination
	 */
	private async spawnClient(
		server: LSPServerInfo,
		root: string,
		key: string,
		filePath: string,
		allowInstall: boolean,
	): Promise<SpawnedServer | undefined> {
		const isOptionalServer = OPTIONAL_LSP_SERVER_IDS.has(server.id); // NOSONAR: set intentionally empty — no optional servers configured yet
		const startedAt = Date.now();
		logSessionStart(
			`lsp spawn ${server.id}: start root=${root} install=${allowInstall ? "enabled" : "disabled"} file=${filePath}`,
		);
		recordLsp(server.id, root, "spawn_start");
		try {
			const spawned = await server.spawn(root, { allowInstall });
			if (!spawned) {
				logSessionStart(
					`lsp spawn ${server.id}: unavailable (${Date.now() - startedAt}ms)`,
				);
				recordLsp(server.id, root, "spawn_failed", Date.now() - startedAt);
				const uCount = (this.failureCounts.get(key) ?? 0) + 1;
				this.failureCounts.set(key, uCount);
				const uCooldown = Math.min(
					BROKEN_BASE_COOLDOWN_MS * 2 ** (uCount - 1),
					BROKEN_MAX_COOLDOWN_MS,
				);
				this.state.broken.set(key, Date.now() + uCooldown);
				if (uCount >= BROKEN_PERMANENT_AFTER) {
					this.permanentlyBroken.add(key);
					logSessionStart(
						`lsp spawn ${server.id}: permanently disabled after ${uCount} failures`,
					);
				}
				return undefined;
			}

			const client = await createLSPClient({
				serverId: server.id,
				process: spawned.process,
				root,
				initialization: spawned.initialization,
				initializeTimeoutMs: server.initializeTimeoutMs,
			});
			const wsDiag =
				typeof client.getWorkspaceDiagnosticsSupport === "function"
					? client.getWorkspaceDiagnosticsSupport()
					: {
							advertised: false,
							mode: "push-only" as const,
							diagnosticProviderKind: "unavailable",
						};

			this.state.clients.set(key, client);
			this.state.clientSpawnedAt.set(key, Date.now());
			this.failureCounts.delete(key);
			if (isOptionalServer) {
				this.optionalDisabled.delete(key);
				this.optionalFailureLogged.delete(key);
			}
			logSessionStart(
				`lsp spawn ${server.id}: success source=${spawned.source ?? "unknown"} (${Date.now() - startedAt}ms)`,
			);
			recordLsp(server.id, root, "spawn_success", Date.now() - startedAt);
			if (!this.workspaceProbeLogged.has(key)) {
				logSessionStart(
					`lsp workspace-diag probe ${server.id}: advertised=${wsDiag.advertised} mode=${wsDiag.mode} provider=${wsDiag.diagnosticProviderKind}`,
				);
				this.workspaceProbeLogged.add(key);
			}
			return { client, info: server };
		} catch (err) {
			recordLsp(server.id, root, "spawn_failed", Date.now() - startedAt);
			if (!isOptionalServer || !this.optionalFailureLogged.has(key)) {
				logSessionStart(
					`lsp spawn ${server.id}: failed (${Date.now() - startedAt}ms) error=${err instanceof Error ? err.message : String(err)}`,
				);
				if (isOptionalServer) {
					this.optionalFailureLogged.add(key);
				}
			}
			const eCount = (this.failureCounts.get(key) ?? 0) + 1;
			this.failureCounts.set(key, eCount);
			const eCooldown = isOptionalServer
				? OPTIONAL_LSP_RETRY_COOLDOWN_MS
				: Math.min(
						BROKEN_BASE_COOLDOWN_MS * 2 ** (eCount - 1),
						BROKEN_MAX_COOLDOWN_MS,
					);
			this.state.broken.set(key, Date.now() + eCooldown);
			if (!isOptionalServer && eCount >= BROKEN_PERMANENT_AFTER) {
				this.permanentlyBroken.add(key);
				logSessionStart(
					`lsp spawn ${server.id}: permanently disabled after ${eCount} failures`,
				);
			}
			if (isOptionalServer) {
				this.optionalDisabled.add(key);
			}
			return undefined;
		}
	}

	/**
	 * Open a file in LSP (sends textDocument/didOpen)
	 */
	async openFile(
		filePath: string,
		content: string,
		options?: { preserveDiagnostics?: boolean; spawnBudgetMs?: number },
	): Promise<void> {
		if (this.checkDestroyed()) return;
		const spawned = await this.getClientForFile(
			filePath,
			undefined,
			options?.spawnBudgetMs,
		);
		if (!spawned) return;

		const languageId = getLanguageId(filePath) ?? "plaintext";
		await spawned.client.notify.open(
			filePath,
			content,
			languageId,
			options?.preserveDiagnostics,
		);
	}

	/**
	 * Update file content (sends textDocument/didChange)
	 */
	async updateFile(filePath: string, content: string): Promise<void> {
		if (this.checkDestroyed()) return;
		const spawned = await this.getClientForFile(filePath);
		if (!spawned) return;

		await spawned.client.notify.change(filePath, content);
	}

	/**
	 * Touch a file like OpenCode's LSP flow: ensure document is open/synced,
	 * and optionally collect diagnostics with explicit scope.
	 */
	async touchFile(
		filePath: string,
		content: string,
		options: LSPTouchFileOptions = {},
	): Promise<import("./client.js").LSPDiagnostic[] | undefined> {
		if (this.checkDestroyed()) return;
		const startedAt = Date.now();
		const normalizedPath = normalizeMapKey(filePath);
		const diagnosticsMode = options.collectDiagnostics
			? (options.diagnostics ?? "document")
			: (options.diagnostics ?? "none");
		const source = options.source ?? "unknown";
		const clientScope: LSPTouchClientScope =
			options.clientScope ?? (diagnosticsMode === "full" ? "all" : "primary");
		const useAllClients = clientScope === "all";
		let spawned: SpawnedServer[];
		let serverCountAttempted: number;
		if (useAllClients) {
			const result = await this.getClientsForFile(filePath);
			spawned = result.clients;
			serverCountAttempted = result.serverCountAttempted;
		} else if (clientScope === "with-auxiliary") {
			// Primary language server + the enabled cross-cutting auxiliaries
			// (opengrep, …). The aggregation layer merges/dedups their diagnostics.
			const [entry, aux] = await Promise.all([
				this.getClientForFile(filePath, options.maxClientWaitMs),
				this.getAuxiliaryClientsForFile(
					filePath,
					new Set(options.auxiliaryServerIds ?? []),
				),
			]);
			spawned = entry ? [entry, ...aux] : aux;
			serverCountAttempted = spawned.length;
		} else {
			const entry = await this.getClientForFile(
				filePath,
				options.maxClientWaitMs,
			);
			spawned = entry ? [entry] : [];
			serverCountAttempted =
				spawned.length > 0
					? 1
					: getServersForFileWithConfig(filePath).length > 0
						? 1
						: 0;
		}
		if (spawned.length === 0) {
			logLatency({
				type: "phase",
				phase: "lsp_touch_file",
				filePath: normalizedPath,
				durationMs: Date.now() - startedAt,
				metadata: {
					serverCountAttempted,
					serverCountReady: 0,
					clientScope,
					diagnosticsMode,
					source,
					maxClientWaitMs: options.maxClientWaitMs,
					failureKind: "no_clients",
				},
			});
			return;
		}

		if (
			this.shouldSkipTouch(
				filePath,
				content,
				clientScope,
				diagnosticsMode !== "none",
			)
		) {
			logLatency({
				type: "phase",
				phase: "lsp_touch_file",
				filePath: normalizedPath,
				durationMs: Date.now() - startedAt,
				metadata: {
					serverCountReady: spawned.length,
					clientScope,
					diagnosticsMode,
					source,
					failureKind: "success",
					skipped: true,
					reason: "debounced_unchanged_content",
				},
			});
			return [];
		}

		const languageId = getLanguageId(filePath) ?? "plaintext";
		const silent = options.silent ?? false;
		// When the same content was already pushed to the LSP within the touch
		// debounce window, skip the notify — pushing again clears the LSP's
		// diagnostic cache (via notify.open) and forces it to restart work it
		// already did. This is what makes the post-write touch + dispatch-lsp-
		// runner touch sequence expensive on slow TS projects.
		const notifySkipped = this.shouldSkipNotify(filePath, content, clientScope);
		const diagnosticBaselines = new Map(
			spawned.map((entry) => [entry.client, entry.client.diagnosticsVersion]),
		);
		if (!notifySkipped) {
			await Promise.all(
				spawned.map((entry) =>
					entry.client.notify.open(
						filePath,
						content,
						languageId,
						undefined,
						silent,
					),
				),
			);
		}

		let diagnosticsTimedOut = false;
		if (diagnosticsMode !== "none") {
			// Resolution: env wins so users can tune the cap without rebuilding.
			// Otherwise, on the single-server hot path (primary scope), use that
			// server's own strategy budget (server-strategies.ts) so a fast server
			// (TypeScript ~1s) isn't held to a flat multi-second wait while a slow
			// one (rust-analyzer 3s) gets the time it needs — bounded by any caller
			// ceiling that exists to protect the per-edit pipeline budget (#203).
			// The multi-server "full"/cascade path keeps the flat resolution.
			const envWait = readEnvDiagnosticsWaitMs();
			const callerCap = options.maxDiagnosticsWaitMs ?? options.maxClientWaitMs;
			const modeFloor = diagnosticsMode === "full" ? 3000 : 1200;
			// Each server gets its OWN deadline, bounded by the caller cap as a
			// CEILING (never a floor) — so a clean push-silent primary (typescript
			// ~1s) can't hold the whole touch to a slow auxiliary's budget, and a
			// slow aux (opengrep) can't override the per-edit cap. Resolves as soon
			// as a server publishes; this is just its individual deadline. (#242)
			const perServerTimeout = (serverId: string): number => {
				const strategyWait = getStrategy(serverId).aggregateWaitMs;
				if (callerCap !== undefined) {
					return Math.min(callerCap, strategyWait > 0 ? strategyWait : callerCap);
				}
				return strategyWait > 0 ? strategyWait : modeFloor;
			};
			let timeoutFor: (serverId: string) => number;
			if (envWait !== undefined) {
				// Env override is a single flat cap so users can tune without rebuilding.
				timeoutFor = () => envWait;
			} else if (
				(!useAllClients && spawned.length === 1) ||
				clientScope === "with-auxiliary"
			) {
				timeoutFor = perServerTimeout;
			} else {
				timeoutFor = () => callerCap ?? modeFloor;
			}
			// Detection deadline = the slowest individual server's budget.
			const timeoutMs = Math.max(
				0,
				...spawned.map((e) => timeoutFor(e.client.serverId)),
			);
			const waitStartedAt = Date.now();
			await Promise.all(
				spawned.map((entry) => {
					const serverTimeout = timeoutFor(entry.client.serverId);
					const baseline = diagnosticBaselines.get(entry.client);
					const wait =
						!notifySkipped && Number.isFinite(baseline)
							? entry.client.waitForDiagnostics(filePath, serverTimeout, {
									minVersion: baseline,
								})
							: entry.client.waitForDiagnostics(filePath, serverTimeout);
					return wait.catch(() => undefined);
				}),
			);
			const waitedMs = Date.now() - waitStartedAt;
			// Within ~20 ms of the configured budget we treat it as a timeout;
			// the LSP didn't beat the cap. Diagnostics that arrive late still
			// land in the client's cache and surface on the next edit.
			if (waitedMs + 20 >= timeoutMs) {
				diagnosticsTimedOut = true;
				logLatency({
					type: "phase",
					phase: "lsp_diagnostics_timeout",
					filePath: normalizedPath,
					durationMs: waitedMs,
					metadata: {
						source,
						clientScope,
						diagnosticsMode,
						timeoutMs,
					},
				});
			}
		}

		const collected = options.collectDiagnostics
			? mergeLspDiagnostics(
					spawned.flatMap((entry) => entry.client.getDiagnostics(filePath)),
				)
			: undefined;

		// Prime the last-known cache WITH the hash of the content we just synced,
		// so a hot-path consumer (actionable-warnings at turn_end) can verify the
		// cached diagnostics are for the current bytes before reusing them instead
		// of paying for a second open+wait. Only when we actually collected — a
		// non-collecting touch (didChange-only) leaves the prior entry intact.
		if (collected !== undefined) {
			const normalizedKey = normalizeMapKey(filePath);
			if (collected.length > 0) {
				this.lastKnownDiagnostics.set(normalizedKey, collected);
				this.lastKnownContentHash.set(normalizedKey, this.hashContent(content));
			} else {
				this.lastKnownDiagnostics.delete(normalizedKey);
				this.lastKnownContentHash.delete(normalizedKey);
			}
		}

		// Only refresh the recent-touches entry when we actually pushed. Skipping
		// here keeps the original push timestamp intact so the debounce window
		// expires naturally instead of being extended by every reuse.
		if (!notifySkipped) {
			this.markTouched(filePath, content, clientScope);
		}

		logLatency({
			type: "phase",
			phase: "lsp_touch_file",
			filePath: normalizedPath,
			durationMs: Date.now() - startedAt,
			metadata: {
				serverCountReady: spawned.length,
				clientScope,
				diagnosticsMode,
				source,
				failureKind: "success",
				collectedDiagnostics: collected?.length,
				notifySkipped,
				diagnosticsTimedOut,
			},
		});
		return collected ?? [];
	}

	/**
	 * Get diagnostics for a file
	 */
	getDiagnosticsHealth(filePath: string): LSPDiagnosticsHealth | undefined {
		return this.lastDiagnosticsHealth.get(normalizeMapKey(filePath));
	}

	/**
	 * Return whatever LSP diagnostics were last cached for this file without
	 * triggering a fresh open / wait / merge. Returns `undefined` when nothing
	 * was ever cached; callers should treat that as distinct from "cached but
	 * empty" (`[]`), which means LSP confirmed no diagnostics last time.
	 *
	 * Intended for hot-path consumers (e.g. actionable-warnings at turn_end)
	 * that already paid for a `touchFile` during dispatch and just want to
	 * read the result without a second LSP round trip.
	 *
	 * Pass `expectedContentHash` (sha256 of the current file bytes) to guard
	 * against staleness: the entry is returned only when it was primed by a
	 * `touchFile` for the *same* content. On mismatch — or for an entry written
	 * without content (the service-level merge) — this returns `undefined` so the
	 * caller does a fresh check instead of serving a previous turn's diagnostics.
	 * Omit it for display consumers (the widget) that accept last-known.
	 */
	getLastKnownDiagnostics(
		filePath: string,
		expectedContentHash?: string,
	): import("./client.js").LSPDiagnostic[] | undefined {
		const normalizedKey = normalizeMapKey(filePath);
		if (expectedContentHash !== undefined) {
			const knownHash = this.lastKnownContentHash.get(normalizedKey);
			if (knownHash === undefined || knownHash !== expectedContentHash) {
				return undefined;
			}
		}
		return this.lastKnownDiagnostics.get(normalizedKey);
	}

	async getDiagnostics(
		filePath: string,
		diagnosticsMode: LSPDiagnosticsMode = "full",
	): Promise<import("./client.js").LSPDiagnostic[]> {
		const normalizedPath = normalizeMapKey(filePath);
		if (this.checkDestroyed()) {
			this.lastDiagnosticsHealth.set(normalizedPath, {
				health: "destroyed",
				failureKind: "destroyed",
				serverCountAttempted: 0,
				serverCountReady: 0,
				candidateServerIds: getServersForFileWithConfig(filePath).map(
					(s) => s.id,
				),
				mergedCount: 0,
				dedupDroppedCount: 0,
				checkedAt: new Date().toISOString(),
			});
			return [];
		}
		const startedAt = Date.now();
		const candidateServerIds = getServersForFileWithConfig(filePath).map(
			(s) => s.id,
		);
		const { clients: spawned, serverCountAttempted } =
			await this.getClientsForFile(filePath);
		if (spawned.length === 0) {
			const stale = this.lastKnownDiagnostics.get(normalizedPath);
			const failureKind = stale?.length ? "no_clients_stale" : "no_clients";
			this.lastDiagnosticsHealth.set(normalizedPath, {
				health: failureKind,
				failureKind,
				serverCountAttempted,
				serverCountReady: 0,
				candidateServerIds,
				mergedCount: stale?.length ?? 0,
				dedupDroppedCount: 0,
				checkedAt: new Date().toISOString(),
			});
			logLatency({
				type: "phase",
				phase: "lsp_diagnostics_aggregate",
				filePath: normalizedPath,
				durationMs: Date.now() - startedAt,
				metadata: {
					serverCountAttempted,
					serverCountReady: 0,
					mergedCount: stale?.length ?? 0,
					dedupDroppedCount: 0,
					failureKind,
					health: failureKind,
					servers: [],
				},
			});
			return stale ?? [];
		}

		// Per-server entries produced by client waits. Each promise resolves
		// with a PerServerEntry; raceToCompletion collects them as they finish.
		type PerServerEntry = {
			serverId: string;
			waitMs: number;
			diagnosticCount: number;
			diagnostics: import("./client.js").LSPDiagnostic[];
		};

		const clientWaits: Promise<PerServerEntry>[] = spawned.map(
			async (entry) => {
				const waitStart = Date.now();
				const strategy = getStrategy(entry.info.id);
				await entry.client.waitForDiagnostics(
					filePath,
					strategy.aggregateWaitMs,
				);
				let diagnostics = entry.client.getDiagnostics(filePath);
				const firstWaitMs = Date.now() - waitStart;
				if (
					strategy.expectSemanticSecondPush &&
					diagnostics.length === 0 &&
					firstWaitMs < DIAGNOSTICS_SEMANTIC_SETTLE_THRESHOLD_MS
				) {
					await entry.client.waitForDiagnostics(
						filePath,
						DIAGNOSTICS_SEMANTIC_SETTLE_WAIT_MS,
					);
					diagnostics = entry.client.getDiagnostics(filePath);
				}
				return {
					serverId: entry.info.id,
					waitMs: Date.now() - waitStart,
					diagnosticCount: diagnostics.length,
					diagnostics,
				};
			},
		);

		// Document mode: 0ms grace — return as soon as any client has results.
		// Full mode: 400ms grace — wait a bit for other clients to catch up.
		const graceMs = diagnosticsMode === "document" ? 0 : EARLY_UNBLOCK_GRACE_MS;

		// Result-aware racing: trigger early-unblock when any client has results,
		// OR when a seedFirstPush server returns (its first push is authoritative
		// even when empty — waiting longer yields nothing more).
		const perServer = await raceToCompletion(
			clientWaits,
			(results) =>
				results.some(
					(r) => r.diagnosticCount > 0 || getStrategy(r.serverId).seedFirstPush,
				),
			{
				timeoutMs: Math.max(
					...spawned.map((entry) => getStrategy(entry.info.id).aggregateWaitMs),
				),
				graceMs,
			},
		);

		// Fill in any slots that timed out before producing results.
		const earlyUnblockedCount = spawned.length - perServer.length;
		const perServerFull: PerServerEntry[] = spawned.map((entry) => {
			const found = perServer.find((r) => r.serverId === entry.info.id);
			return (
				found ?? {
					serverId: entry.info.id,
					waitMs: getStrategy(entry.info.id).aggregateWaitMs,
					diagnosticCount: 0,
					diagnostics: [],
				}
			);
		});

		// Deduplicate across servers (same diagnostic reported by multiple tools).

		const merged: import("./client.js").LSPDiagnostic[] = [];
		const seen = new Set<string>();
		for (const entry of perServerFull) {
			for (const diagnostic of entry.diagnostics) {
				const key = [
					diagnostic.range.start.line,
					diagnostic.range.start.character,
					diagnostic.message,
				].join(":");
				if (seen.has(key)) continue;
				seen.add(key);
				merged.push(diagnostic);
			}
		}

		const rawCount = perServerFull.reduce(
			(sum, entry) => sum + entry.diagnosticCount,
			0,
		);
		const serversWithDiagnostics = perServerFull.filter(
			(entry) => entry.diagnosticCount > 0,
		).length;
		const failureKind = merged.length === 0 ? "ok_empty" : "success";

		this.lastDiagnosticsHealth.set(normalizedPath, {
			health: failureKind === "success" ? "ok" : "ok_empty",
			failureKind,
			serverCountAttempted,
			serverCountReady: perServerFull.length,
			candidateServerIds,
			mergedCount: merged.length,
			dedupDroppedCount: rawCount - merged.length,
			checkedAt: new Date().toISOString(),
		});

		logLatency({
			type: "phase",
			phase: "lsp_diagnostics_aggregate",
			filePath: normalizedPath,
			durationMs: Date.now() - startedAt,
			metadata: {
				serverCountAttempted,
				serverCountReady: perServerFull.length,
				serverCountWithDiagnostics: serversWithDiagnostics,
				mergedCount: merged.length,
				dedupDroppedCount: rawCount - merged.length,
				earlyUnblockedCount,
				diagnosticsMode,
				failureKind,
				health: failureKind === "success" ? "ok" : "ok_empty",
				servers: perServerFull.map((entry) => ({
					id: entry.serverId,
					waitMs: entry.waitMs,
					diagnosticCount: entry.diagnosticCount,
				})),
			},
		});

		// Keep last known so the widget can show stale diagnostics if LSP dies.
		// Live clients returning [] means genuinely no errors — clear the stale
		// entry so the widget doesn't show resolved issues. This path has no
		// content in hand, so drop any content hash: a hash-guarded read won't
		// trust this entry as current (it falls through to a fresh check), while
		// the unguarded widget read still gets last-known for display.
		if (merged.length > 0) {
			this.lastKnownDiagnostics.set(normalizedPath, merged);
		} else {
			this.lastKnownDiagnostics.delete(normalizedPath);
		}
		this.lastKnownContentHash.delete(normalizedPath);

		return merged;
	}

	private hashContent(content: string): string {
		return createHash("sha256").update(content).digest("hex");
	}

	/**
	 * Navigation: go to definition
	 */
	async definition(filePath: string, line: number, character: number) {
		const spawned = await this.getClientForFile(
			filePath,
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return [];
		return spawned.client.definition(filePath, line, character);
	}

	/**
	 * Navigation: go to the type definition of the symbol at a position
	 */
	async typeDefinition(filePath: string, line: number, character: number) {
		const spawned = await this.getClientForFile(
			filePath,
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return [];
		return spawned.client.typeDefinition(filePath, line, character);
	}

	/**
	 * Navigation: go to the declaration of the symbol at a position
	 */
	async declaration(filePath: string, line: number, character: number) {
		const spawned = await this.getClientForFile(
			filePath,
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return [];
		return spawned.client.declaration(filePath, line, character);
	}

	/**
	 * Navigation: find all references
	 */
	async references(
		filePath: string,
		line: number,
		character: number,
		includeDeclaration = true,
	) {
		const spawned = await this.getClientForFile(
			filePath,
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return [];
		return spawned.client.references(
			filePath,
			line,
			character,
			includeDeclaration,
		);
	}

	/**
	 * Navigation: hover info
	 */
	async hover(filePath: string, line: number, character: number) {
		const spawned = await this.getClientForFile(
			filePath,
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return null;
		return spawned.client.hover(filePath, line, character);
	}

	/**
	 * Navigation: signature help at cursor position
	 */
	async signatureHelp(filePath: string, line: number, character: number) {
		const spawned = await this.getClientForFile(
			filePath,
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return null;
		return spawned.client.signatureHelp(filePath, line, character);
	}

	/**
	 * Navigation: symbols in document
	 */
	async documentSymbol(filePath: string) {
		const spawned = await this.getClientForFile(
			filePath,
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return [];
		return spawned.client.documentSymbol(filePath);
	}

	/**
	 * Navigation: workspace-wide symbol search
	 */
	async workspaceSymbol(query: string, filePath?: string) {
		if (filePath) {
			const spawned = await this.getClientForFile(
				filePath,
				NAV_CLIENT_WAIT_TIMEOUT_MS,
			);
			if (!spawned) return [];
			return spawned.client.workspaceSymbol(query);
		}

		// Use the first active client for workspace-level queries
		const clients = Array.from(this.state.clients.values());
		if (clients.length === 0) return [];
		return clients[0].workspaceSymbol(query);
	}

	/**
	 * Commands advertised for workspace/executeCommand. If filePath is given,
	 * the server for that file; otherwise the first active client.
	 */
	async getAdvertisedCommands(filePath?: string): Promise<string[]> {
		if (filePath) {
			const spawned = await this.getClientForFile(
				filePath,
				NAV_CLIENT_WAIT_TIMEOUT_MS,
			);
			if (!spawned) return [];
			return spawned.client.getAdvertisedCommands();
		}
		const first = this.state.clients.values().next().value;
		return first ? first.getAdvertisedCommands() : [];
	}

	/**
	 * Run a server command via workspace/executeCommand (hardened: allowlisted by
	 * advertisement in the client). If filePath is given, target that file's
	 * server; otherwise the first active client.
	 */
	async executeCommand(
		filePath: string | undefined,
		command: string,
		args?: unknown[],
	): Promise<{ executed: boolean; result?: unknown; reason?: string }> {
		if (filePath) {
			const spawned = await this.getClientForFile(
				filePath,
				NAV_CLIENT_WAIT_TIMEOUT_MS,
			);
			if (!spawned) {
				return { executed: false, reason: "no LSP server for file" };
			}
			return spawned.client.executeCommand(command, args);
		}
		const first = this.state.clients.values().next().value;
		if (!first) return { executed: false, reason: "no active LSP server" };
		return first.executeCommand(command, args);
	}

	/**
	 * Capability snapshot for LSP operations.
	 * If filePath is provided, probes that server; otherwise uses first active client.
	 */
	async getOperationSupport(
		filePath?: string,
	): Promise<import("./client.js").LSPOperationSupport | null> {
		if (filePath) {
			const spawned = await this.getClientForFile(filePath);
			if (!spawned) return null;
			const getter = spawned.client.getOperationSupport;
			if (typeof getter !== "function") return null;
			return getter();
		}

		const first = this.state.clients.values().next().value;
		if (!first) return null;
		const getter = first.getOperationSupport;
		if (typeof getter !== "function") return null;
		return getter();
	}

	/**
	 * Capability snapshot for workspace diagnostics support.
	 * If filePath is provided, probes that server; otherwise uses first active client.
	 */
	async getCapabilitySnapshots(
		filePath?: string,
	): Promise<LSPCapabilitySnapshot[]> {
		if (this.checkDestroyed()) return [];
		const snapshots: LSPCapabilitySnapshot[] = [];

		if (filePath) {
			const servers = getServersForFileWithConfig(filePath);
			for (const server of servers) {
				const root = await server.root(filePath);
				if (!root) continue;
				const client = this.state.clients.get(
					`${server.id}:${normalizeMapKey(root)}`,
				);
				if (!client?.isAlive()) continue;
				snapshots.push({
					serverId: server.id,
					root,
					operationSupport: client.getOperationSupport(),
					workspaceDiagnosticsSupport: client.getWorkspaceDiagnosticsSupport(),
					advertisedCommands: client.getAdvertisedCommands(),
					rawCapabilityKeys: client.getRawCapabilityKeys?.() ?? [],
				});
			}
			return snapshots;
		}

		for (const [key, client] of this.state.clients) {
			if (!client.isAlive()) continue;
			const separator = key.indexOf(":");
			const serverId = separator >= 0 ? key.slice(0, separator) : key;
			snapshots.push({
				serverId,
				root: client.root,
				operationSupport: client.getOperationSupport(),
				workspaceDiagnosticsSupport: client.getWorkspaceDiagnosticsSupport(),
				advertisedCommands: client.getAdvertisedCommands(),
				rawCapabilityKeys: client.getRawCapabilityKeys?.() ?? [],
			});
		}
		return snapshots;
	}

	async getWorkspaceDiagnosticsSupport(
		filePath?: string,
	): Promise<import("./client.js").LSPWorkspaceDiagnosticsSupport | null> {
		if (filePath) {
			const spawned = await this.getClientForFile(filePath);
			if (!spawned) return null;
			const getter = spawned.client.getWorkspaceDiagnosticsSupport;
			if (typeof getter !== "function") return null;
			return getter();
		}

		const first = this.state.clients.values().next().value;
		if (!first) return null;
		const getter = first.getWorkspaceDiagnosticsSupport;
		if (typeof getter !== "function") return null;
		return getter();
	}

	/**
	 * Navigation: available code actions at position/range
	 */
	async codeAction(
		filePath: string,
		line: number,
		character: number,
		endLine: number,
		endCharacter: number,
	) {
		const spawned = await this.getClientForFile(
			filePath,
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return [];
		return spawned.client.codeAction(
			filePath,
			line,
			character,
			endLine,
			endCharacter,
		);
	}

	/**
	 * Navigation: rename symbol at position
	 */
	async rename(
		filePath: string,
		line: number,
		character: number,
		newName: string,
	) {
		const spawned = await this.getClientForFile(
			filePath,
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return null;
		return spawned.client.rename(filePath, line, character, newName);
	}

	async renameFile(
		oldFilePath: string,
		newFilePath: string,
		options: { cwd: string; apply?: boolean },
	): Promise<LSPRenameFileResult> {
		const cwd = options.cwd;
		const apply = options.apply ?? false;
		const priorityServerIds = getServersForFileWithConfig(oldFilePath).map(
			(server) => server.id,
		);
		const activeClients = this.activeClientsForCwd(cwd, priorityServerIds);
		const willRenameFailures: Array<{ serverId: string; error: string }> = [];
		const didRenameFailures: Array<{ serverId: string; error: string }> = [];

		const willResults = await Promise.all(
			activeClients.map(async ({ serverId, client }) => {
				try {
					return {
						serverId,
						edit: await client.willRenameFiles(oldFilePath, newFilePath),
					};
				} catch (err) {
					willRenameFailures.push({
						serverId,
						error: err instanceof Error ? err.message : String(err),
					});
					return { serverId, edit: null };
				}
			}),
		);

		const successfulWillResults = willResults.filter(
			(result) =>
				!willRenameFailures.some(
					(failure) => failure.serverId === result.serverId,
				),
		);
		if (activeClients.length > 0 && successfulWillResults.length === 0) {
			throw new Error(
				`workspace/willRenameFiles failed for all active LSP servers: ${willRenameFailures.map((failure) => `${failure.serverId}: ${failure.error}`).join("; ")}`,
			);
		}

		const merged = mergeWorkspaceTextEditsByPriority(successfulWillResults);
		const summary = summarizeWorkspaceEdit(merged.edit, cwd);
		if (!apply) {
			return {
				applied: false,
				serverIds: activeClients.map((entry) => entry.serverId),
				willRenameFailures,
				didRenameFailures,
				droppedConflicts: merged.droppedConflicts,
				inputEditCount: merged.inputEditCount,
				summary,
			};
		}

		const applied = await applyWorkspaceEdit(merged.edit, cwd);
		await fs.mkdir(path.dirname(newFilePath), { recursive: true });
		await fs.rename(oldFilePath, newFilePath);
		const relOld =
			path.relative(cwd, oldFilePath).replace(/\\/g, "/") ||
			path.basename(oldFilePath);
		const relNew =
			path.relative(cwd, newFilePath).replace(/\\/g, "/") ||
			path.basename(newFilePath);
		const renameDescription = `Renamed ${relOld} → ${relNew}`;

		await Promise.all(
			activeClients.map(async ({ serverId, client }) => {
				try {
					await client.didRenameFiles(oldFilePath, newFilePath);
				} catch (err) {
					didRenameFailures.push({
						serverId,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}),
		);

		return {
			applied: true,
			serverIds: activeClients.map((entry) => entry.serverId),
			willRenameFailures,
			didRenameFailures,
			droppedConflicts: merged.droppedConflicts,
			inputEditCount: merged.inputEditCount,
			summary,
			descriptions: [...applied.descriptions, renameDescription],
			files: [...new Set([...applied.files, oldFilePath, newFilePath])],
		};
	}

	/**
	 * Navigation: go to implementation
	 */
	async implementation(filePath: string, line: number, character: number) {
		const spawned = await this.getClientForFile(
			filePath,
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return [];
		return spawned.client.implementation(filePath, line, character);
	}

	/**
	 * Navigation: prepare call hierarchy at position
	 */
	async prepareCallHierarchy(
		filePath: string,
		line: number,
		character: number,
	) {
		const spawned = await this.getClientForFile(
			filePath,
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return [];
		return spawned.client.prepareCallHierarchy(filePath, line, character);
	}

	/**
	 * Navigation: find incoming calls (callers)
	 */
	async incomingCalls(item: import("./client.js").LSPCallHierarchyItem) {
		const spawned = await this.getClientForFile(
			uriToPath(item.uri),
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return [];
		return spawned.client.incomingCalls(item);
	}

	/**
	 * Navigation: find outgoing calls (callees)
	 */
	async outgoingCalls(item: import("./client.js").LSPCallHierarchyItem) {
		const spawned = await this.getClientForFile(
			uriToPath(item.uri),
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return [];
		return spawned.client.outgoingCalls(item);
	}

	/**
	 * Actively scan every LSP-supported source file under a project root.
	 * This is intentionally expensive and used only by explicit project-wide tools.
	 */
	async runWorkspaceDiagnostics(
		cwd: string,
		options: { maxFiles?: number; signal?: AbortSignal } = {},
	): Promise<LSPWorkspaceDiagnosticResult[]> {
		const startedAt = Date.now();
		const root = path.resolve(cwd);
		const { signal } = options;
		// Cap the per-file LSP sweep: a Next.js-scale project can route thousands
		// of files through the language server at concurrency 8, and without a
		// caller cap that grinds for tens of minutes (#341). `maxFiles` lets
		// lens_diagnostics' `maxLspFiles` bound it; falls back to the env/default.
		const maxFiles =
			typeof options.maxFiles === "number" &&
			Number.isFinite(options.maxFiles) &&
			options.maxFiles > 0
				? Math.floor(options.maxFiles)
				: getMaxWorkspaceDiagnosticFiles();
		const files = await collectWorkspaceDiagnosticFiles(root, maxFiles, signal);
		const results: LSPWorkspaceDiagnosticResult[] = new Array(files.length);
		let nextIndex = 0;
		const workers = Math.min(WORKSPACE_DIAGNOSTICS_CONCURRENCY, files.length);
		await Promise.all(
			Array.from({ length: workers }, async () => {
				while (true) {
					// Honor cancellation: a long sweep must stop when the agent/user
					// aborts the turn rather than chew through the remaining files
					// (#341). Already-collected results are returned as a partial.
					if (signal?.aborted) return;
					const index = nextIndex;
					nextIndex += 1;
					if (index >= files.length) return;
					const filePath = files[index];
					try {
						const content = await nodeFs.promises.readFile(filePath, "utf-8");
						const diagnostics = await this.touchFile(filePath, content, {
							diagnostics: "document",
							collectDiagnostics: true,
							clientScope: "all",
							source: "lens_diagnostics_full",
						});
						results[index] = {
							filePath,
							diagnostics: diagnostics ?? [],
							count: diagnostics?.length ?? 0,
						};
					} catch (err) {
						results[index] = {
							filePath,
							diagnostics: [],
							count: 0,
							error: err instanceof Error ? err.message : String(err),
						};
					}
				}
			}),
		);

		logLatency({
			type: "phase",
			phase: "lsp_workspace_diagnostics",
			filePath: root,
			durationMs: Date.now() - startedAt,
			metadata: {
				filesChecked: files.length,
				diagnosticCount: results.reduce(
					(sum, result) => sum + (result?.count ?? 0),
					0,
				),
				concurrency: WORKSPACE_DIAGNOSTICS_CONCURRENCY,
				maxFiles,
				aborted: signal?.aborted ?? false,
			},
		});

		return results.filter(Boolean);
	}

	/**
	 * Get all diagnostics across all tracked files (for cascade checking)
	 */
	async getAllDiagnostics(): Promise<
		Map<string, { diags: import("./client.js").LSPDiagnostic[]; ts: number }>
	> {
		const all = new Map<
			string,
			{ diags: import("./client.js").LSPDiagnostic[]; ts: number }
		>();
		const now = Date.now();
		for (const [_key, client] of this.state.clients) {
			// Resolve existence asynchronously (was a blocking existsSync per tracked
			// file inside the prune predicate) so this cascade-checking path doesn't
			// hold the event loop; then prune with a synchronous, in-memory predicate.
			const trackedPaths = client.getTrackedDiagnosticPaths();
			const existingPaths = new Set<string>();
			await Promise.all(
				trackedPaths.map(async (filePath) => {
					try {
						await nodeFs.promises.access(filePath);
						existingPaths.add(filePath);
					} catch {
						/* missing → will be pruned */
					}
				}),
			);
			client.pruneDiagnostics(
				(filePath, ts) =>
					!existingPaths.has(filePath) ||
					now - ts > CASCADE_DIAGNOSTICS_TTL_MS,
			);
			const clientDiags = client.getAllDiagnostics();
			for (const [filePath, entry] of clientDiags) {
				const existing = all.get(filePath);
				if (existing) {
					existing.diags = mergeLspDiagnostics([
						...existing.diags,
						...entry.diags,
					]);
					existing.ts = Math.max(existing.ts, entry.ts);
				} else {
					all.set(filePath, { diags: [...entry.diags], ts: entry.ts });
				}
			}
		}
		return all;
	}

	/**
	 * Check whether a file type/root has any configured LSP support.
	 * Pure capability check — does not spawn or wait for clients.
	 */
	supportsLSP(filePath: string): boolean {
		return getServersForFileWithConfig(filePath).length > 0;
	}

	/**
	 * Check whether an LSP client is already alive for a file.
	 * Lightweight — does not spawn or wait for a client.
	 */
	async hasWarmLSP(filePath: string): Promise<boolean> {
		const spawned = await this.getWarmClientForFile(filePath);
		return Boolean(spawned);
	}

	/**
	 * Check if LSP is available for a file.
	 * May spawn a client; prefer supportsLSP()/hasWarmLSP() when you only need
	 * a capability or warm-state check.
	 */
	async hasLSP(filePath: string): Promise<boolean> {
		const spawned = await this.getClientForFile(filePath);
		return Boolean(spawned);
	}

	/**
	 * Shutdown all LSP clients
	 */
	async shutdown(options: LSPShutdownOptions = {}): Promise<void> {
		if (this.checkDestroyed()) return;
		this.isDestroyed = true;
		// Cancel any in-flight spawns
		this.state.inFlight.clear();

		for (const [_key, client] of this.state.clients) {
			try {
				await client.shutdown(options);
			} catch {
				// pi-lens-ignore: missing-error-propagation — per-client shutdown failure, must not abort remaining shutdowns
			}
		}
		this.state.clients.clear();
		this.state.broken.clear();
		this.workspaceProbeLogged.clear();
		this.warmStartLogged.clear();
	}

	/**
	 * Get status of all active clients
	 */
	getStatus(): Array<{ serverId: string; root: string; connected: boolean }> {
		return Array.from(this.state.clients.entries()).map(([key, client]) => {
			const [serverId, root] = key.split(":");
			return { serverId, root, connected: client.isAlive() };
		});
	}

	/**
	 * Count clients that are currently alive (connected and initialized).
	 * Lightweight — does not spawn or wait for anything.
	 */
	getAliveClientCount(): number {
		let count = 0;
		for (const client of this.state.clients.values()) {
			if (client.isAlive()) count++;
		}
		return count;
	}

	/**
	 * Distinct serverIds of currently-alive clients, ordered primary-first then
	 * auxiliary (cross-cutting scanners like opengrep/ast-grep), stable within
	 * each group. Deduped across roots — one warm server serving two roots
	 * collapses to a single id. Lightweight: does not spawn or wait. (#267)
	 */
	getAliveServerIds(): string[] {
		const primary: string[] = [];
		const aux: string[] = [];
		const seen = new Set<string>();
		for (const client of this.state.clients.values()) {
			if (!client.isAlive()) continue;
			const id = client.serverId;
			if (seen.has(id)) continue;
			seen.add(id);
			const role = LSP_SERVERS.find((s) => s.id === id)?.role;
			(role === "auxiliary" ? aux : primary).push(id);
		}
		return [...primary, ...aux];
	}
}

// --- Singleton Instance ---

let globalLSPService: LSPService | null = null;

export function getLSPService(): LSPService {
	if (!globalLSPService) {
		globalLSPService = new LSPService();
	}
	return globalLSPService;
}

export function resetLSPService(options: LSPShutdownOptions = {}): void {
	if (globalLSPService) {
		globalLSPService.shutdown(options).catch(() => {});
	}
	globalLSPService = null;
}

/**
 * Test-only: exposes the async workspace-diagnostics file walk so its
 * event-loop occupancy can be guarded (see workspace-diagnostics-occupancy
 * test). Not part of the public API.
 */
export function __collectWorkspaceDiagnosticFilesForTest(
	root: string,
	maxFiles?: number,
	signal?: AbortSignal,
): Promise<string[]> {
	return maxFiles === undefined
		? collectWorkspaceDiagnosticFiles(path.resolve(root), undefined, signal)
		: collectWorkspaceDiagnosticFiles(path.resolve(root), maxFiles, signal);
}
