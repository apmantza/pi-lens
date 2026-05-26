/**
 * LSP Service Layer for pi-lens
 *
 * Manages multiple LSP clients per workspace with:
 * - Auto-spawning based on file type
 * - Effect-TS service composition
 * - Bus event integration
 * - Resource cleanup
 */

import * as nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recordLsp } from "../widget-state.js";
import { logLatency } from "../latency-logger.js";
import { normalizeMapKey, uriToPath } from "../path-utils.js";
import type { LSPClientInfo, LSPShutdownOptions } from "./client.js";
import { createLSPClient } from "./client.js";
import { getServersForFileWithConfig } from "./config.js";
import { getLanguageId } from "./language.js";
import type { LSPServerInfo } from "./server.js";
import { isDirectLspCommandTemporarilyUnavailable } from "./server.js";
import { getStrategy } from "./server-strategies.js";
import { raceToCompletion } from "./aggregation.js";

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
const SESSIONSTART_LOG_DIR = path.join(os.homedir(), ".pi-lens");
const SESSIONSTART_LOG = path.join(SESSIONSTART_LOG_DIR, "sessionstart.log");

function logSessionStart(msg: string): void {
	if (
		process.env.PI_LENS_TEST_MODE === "1" ||
		(process.env.VITEST && process.env.PI_LENS_TEST_MODE !== "0")
	) {
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
export type LSPTouchClientScope = "primary" | "all";

export interface LSPTouchFileOptions {
	diagnostics?: LSPDiagnosticsMode;
	source?: string;
	clientScope?: LSPTouchClientScope;
	maxClientWaitMs?: number;
	/** Return merged diagnostics from the clients touched by this call. */
	collectDiagnostics?: boolean;
	/** Skip workspace/didChangeWatchedFiles — use for cascade reads, not real fs changes */
	silent?: boolean;
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
	private readonly lastDiagnosticsHealth = new Map<
		string,
		LSPDiagnosticsHealth
	>();
	private readonly recentTouches = new Map<
		string,
		{ fingerprint: string; touchedAt: number; clientScope: "primary" | "all" }
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

	private shouldSkipTouch(
		filePath: string,
		content: string,
		clientScope: "primary" | "all",
		waitForDiagnostics: boolean,
	): boolean {
		if (waitForDiagnostics || TOUCH_DEBOUNCE_MS <= 0) {
			return false;
		}

		const key = `${normalizeMapKey(filePath)}:${clientScope}`;
		const previous = this.recentTouches.get(key);
		if (!previous) return false;

		const now = Date.now();
		if (now - previous.touchedAt > TOUCH_DEBOUNCE_MS) {
			return false;
		}

		return previous.fingerprint === this.fingerprintContent(content);
	}

	private markTouched(
		filePath: string,
		content: string,
		clientScope: "primary" | "all",
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
		const servers = getServersForFileWithConfig(filePath);
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

		if (diagnosticsMode !== "none") {
			const timeoutMs =
				options.maxClientWaitMs ?? (diagnosticsMode === "full" ? 3000 : 1200);
			await Promise.all(
				spawned.map((entry) =>
					entry.client
						.waitForDiagnostics(filePath, timeoutMs)
						.catch(() => undefined),
				),
			);
		}

		const collected = options.collectDiagnostics
			? mergeLspDiagnostics(
					spawned.flatMap((entry) => entry.client.getDiagnostics(filePath)),
				)
			: undefined;

		this.markTouched(filePath, content, clientScope);

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
		// entry so the widget doesn't show resolved issues.
		if (merged.length > 0) {
			this.lastKnownDiagnostics.set(normalizedPath, merged);
		} else {
			this.lastKnownDiagnostics.delete(normalizedPath);
		}

		return merged;
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
			client.pruneDiagnostics(
				(filePath, ts) =>
					!nodeFs.existsSync(filePath) || now - ts > CASCADE_DIAGNOSTICS_TTL_MS,
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
