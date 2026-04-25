/**
 * LSP Service Layer for pi-lens
 *
 * Manages multiple LSP clients per workspace with:
 * - Auto-spawning based on file type
 * - Effect-TS service composition
 * - Bus event integration
 * - Resource cleanup
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logLatency } from "../latency-logger.js";
import { normalizeMapKey, uriToPath } from "../path-utils.js";
import type { LSPClientInfo } from "./client.js";
import { createLSPClient } from "./client.js";
import { getServersForFileWithConfig } from "./config.js";
import { getLanguageId } from "./language.js";
import type { LSPServerInfo } from "./server.js";

// --- Types ---

export interface LSPState {
	clients: Map<string, LSPClientInfo>; // key: "serverId:root"
	servers: Map<string, LSPServerInfo>;
	broken: Map<string, number>; // servers that failed to initialize with retry-at timestamp
	inFlight: Map<string, Promise<SpawnedServer | undefined>>; // prevent duplicate spawns
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
const SESSIONSTART_LOG_DIR = path.join(os.homedir(), ".pi-lens");
const SESSIONSTART_LOG = path.join(SESSIONSTART_LOG_DIR, "sessionstart.log");

function logSessionStart(msg: string): void {
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

// --- Service ---

export class LSPService {
	private state: LSPState;
	private workspaceProbeLogged = new Set<string>();
	private warmStartLogged = new Set<string>();
	private optionalFailureLogged = new Set<string>();
	private optionalDisabled = new Set<string>();
	/** Consecutive failure counts for exponential backoff circuit breaker */
	private failureCounts = new Map<string, number>();
	private recentTouches = new Map<
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
		this.recentTouches.set(key, {
			fingerprint: this.fingerprintContent(content),
			touchedAt: Date.now(),
			clientScope,
		});
	}

	/**
	 * Get or create LSP client for a file
	 * Prevents duplicate client creation via in-flight promise tracking
	 */
	async getClientForFile(
		filePath: string,
		maxWaitMs?: number,
	): Promise<SpawnedServer | undefined> {
		if (this.checkDestroyed()) return undefined;
		const servers = getServersForFileWithConfig(filePath);
		const serverWaitOverrideMs = servers.reduce(
			(max, server) => Math.max(max, server.clientWaitTimeoutMs ?? 0),
			0,
		);
		const effectiveMaxWaitMs = Math.max(maxWaitMs ?? 0, serverWaitOverrideMs);

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

		const timeoutResult = await Promise.race<SpawnedServer | undefined>([
			withBudget(),
			new Promise<undefined>((resolve) =>
				setTimeout(() => resolve(undefined), effectiveMaxWaitMs),
			),
		]);

		if (!timeoutResult) {
			logLatency({
				type: "phase",
				phase: "lsp_client_wait_timeout",
				filePath,
				durationMs: effectiveMaxWaitMs,
				metadata: {
					maxWaitMs: effectiveMaxWaitMs,
				},
			});
		}

		return timeoutResult;
	}

	/**
	 * Get or create ALL LSP clients that can serve a file.
	 * Used for diagnostics aggregation across complementary servers.
	 */
	async getClientsForFile(filePath: string): Promise<SpawnedServer[]> {
		const servers = getServersForFileWithConfig(filePath);
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
			if (existing && existing.isAlive()) {
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
		const isOptionalServer = OPTIONAL_LSP_SERVER_IDS.has(server.id);

		if (isOptionalServer && this.optionalDisabled.has(key)) {
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
			try {
				await existing.shutdown();
			} catch {
				/* ignore dead client shutdown errors */
			}
			this.state.clients.delete(key);
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

	private shouldAllowInstall(filePath: string, root: string): boolean {
		void filePath;
		void root;
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
		const isOptionalServer = OPTIONAL_LSP_SERVER_IDS.has(server.id);
		const startedAt = Date.now();
		logSessionStart(
			`lsp spawn ${server.id}: start root=${root} install=${allowInstall ? "enabled" : "disabled"} file=${filePath}`,
		);
		try {
			const spawned = await server.spawn(root, { allowInstall });
			if (!spawned) {
				logSessionStart(
					`lsp spawn ${server.id}: unavailable (${Date.now() - startedAt}ms)`,
				);
				const uCount = (this.failureCounts.get(key) ?? 0) + 1;
				this.failureCounts.set(key, uCount);
				const uCooldown = Math.min(
					BROKEN_BASE_COOLDOWN_MS * 2 ** (uCount - 1),
					BROKEN_MAX_COOLDOWN_MS,
				);
				this.state.broken.set(key, Date.now() + uCooldown);
				if (uCount >= BROKEN_PERMANENT_AFTER) {
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
			this.failureCounts.delete(key);
			if (isOptionalServer) {
				this.optionalDisabled.delete(key);
				this.optionalFailureLogged.delete(key);
			}
			logSessionStart(
				`lsp spawn ${server.id}: success source=${spawned.source ?? "unknown"} (${Date.now() - startedAt}ms)`,
			);
			if (!this.workspaceProbeLogged.has(key)) {
				logSessionStart(
					`lsp workspace-diag probe ${server.id}: advertised=${wsDiag.advertised} mode=${wsDiag.mode} provider=${wsDiag.diagnosticProviderKind}`,
				);
				this.workspaceProbeLogged.add(key);
			}
			return { client, info: server };
		} catch (err) {
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
		options?: { preserveDiagnostics?: boolean },
	): Promise<void> {
		if (this.checkDestroyed()) return;
		const spawned = await this.getClientForFile(filePath);
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
	 * and optionally wait briefly for diagnostics warm-up.
	 */
	async touchFile(
		filePath: string,
		content: string,
		waitForDiagnostics = false,
		source = "unknown",
		useAllClients = false,
		maxClientWaitMs?: number,
	): Promise<void> {
		if (this.checkDestroyed()) return;
		const startedAt = Date.now();
		const normalizedPath = normalizeMapKey(filePath);
		const clientScope = useAllClients ? "all" : "primary";
		const spawned = useAllClients
			? await this.getClientsForFile(filePath)
			: await this.getClientForFile(filePath, maxClientWaitMs).then((entry) =>
					entry ? [entry] : [],
				);
		if (spawned.length === 0) {
			logLatency({
				type: "phase",
				phase: "lsp_touch_file",
				filePath: normalizedPath,
				durationMs: Date.now() - startedAt,
				metadata: {
					serverCountReady: 0,
					clientScope,
					failureKind: "no_clients",
				},
			});
			return;
		}

		if (
			this.shouldSkipTouch(filePath, content, clientScope, waitForDiagnostics)
		) {
			logLatency({
				type: "phase",
				phase: "lsp_touch_file",
				filePath: normalizedPath,
				durationMs: Date.now() - startedAt,
				metadata: {
					serverCountReady: spawned.length,
					clientScope,
					waitForDiagnostics,
					source,
					failureKind: "success",
					skipped: true,
					reason: "debounced_unchanged_content",
				},
			});
			return;
		}

		const languageId = getLanguageId(filePath) ?? "plaintext";
		await Promise.all(
			spawned.map((entry) =>
				entry.client.notify.open(filePath, content, languageId),
			),
		);

		if (waitForDiagnostics) {
			await Promise.all(
				spawned.map((entry) =>
					entry.client
						.waitForDiagnostics(filePath, 1200)
						.catch(() => undefined),
				),
			);
		}

		this.markTouched(filePath, content, clientScope);

		logLatency({
			type: "phase",
			phase: "lsp_touch_file",
			filePath: normalizedPath,
			durationMs: Date.now() - startedAt,
			metadata: {
				serverCountReady: spawned.length,
				clientScope,
				waitForDiagnostics,
				source,
				failureKind: "success",
			},
		});
	}

	/**
	 * Get diagnostics for a file
	 */
	async getDiagnostics(
		filePath: string,
	): Promise<import("./client.js").LSPDiagnostic[]> {
		if (this.checkDestroyed()) return [];
		const startedAt = Date.now();
		const normalizedPath = normalizeMapKey(filePath);
		const spawned = await this.getClientsForFile(filePath);
		if (spawned.length === 0) {
			logLatency({
				type: "phase",
				phase: "lsp_diagnostics_aggregate",
				filePath: normalizedPath,
				durationMs: Date.now() - startedAt,
				metadata: {
					serverCountAttempted: 0,
					serverCountReady: 0,
					mergedCount: 0,
					dedupDroppedCount: 0,
					failureKind: "no_clients",
					health: "no_clients",
					servers: [],
				},
			});
			return [];
		}

		// TypeScript LSP pushes two diagnostic batches: syntactic first (fast, often
		// empty), semantic second (~500ms later). If the first wait resolves quickly
		// with no results, do a second short wait to catch the semantic batch.
		const SEMANTIC_SETTLE_THRESHOLD_MS = 200;
		const SEMANTIC_SETTLE_WAIT_MS = 800;

		const perServer = await Promise.all(
			spawned.map(async (entry) => {
				const waitStart = Date.now();
				await entry.client.waitForDiagnostics(filePath, 5000);
				let diagnostics = entry.client.getDiagnostics(filePath);
				const firstWaitMs = Date.now() - waitStart;
				if (
					diagnostics.length === 0 &&
					firstWaitMs < SEMANTIC_SETTLE_THRESHOLD_MS
				) {
					await entry.client.waitForDiagnostics(
						filePath,
						SEMANTIC_SETTLE_WAIT_MS,
					);
					diagnostics = entry.client.getDiagnostics(filePath);
				}
				return {
					serverId: entry.info.id,
					waitMs: Date.now() - waitStart,
					diagnosticCount: diagnostics.length,
					diagnostics,
				};
			}),
		);

		const merged: import("./client.js").LSPDiagnostic[] = [];
		const seen = new Set<string>();
		for (const entry of perServer) {
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

		const rawCount = perServer.reduce(
			(sum, entry) => sum + entry.diagnosticCount,
			0,
		);
		const serversWithDiagnostics = perServer.filter(
			(entry) => entry.diagnosticCount > 0,
		).length;
		const failureKind = merged.length === 0 ? "ok_empty" : "success";

		logLatency({
			type: "phase",
			phase: "lsp_diagnostics_aggregate",
			filePath: normalizedPath,
			durationMs: Date.now() - startedAt,
			metadata: {
				serverCountAttempted: getServersForFileWithConfig(filePath).length,
				serverCountReady: perServer.length,
				serverCountWithDiagnostics: serversWithDiagnostics,
				mergedCount: merged.length,
				dedupDroppedCount: rawCount - merged.length,
				failureKind,
				health: failureKind === "success" ? "ok" : "ok_empty",
				servers: perServer.map((entry) => ({
					id: entry.serverId,
					waitMs: entry.waitMs,
					diagnosticCount: entry.diagnosticCount,
				})),
			},
		});

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
		for (const [_key, client] of this.state.clients) {
			const clientDiags = client.getAllDiagnostics();
			for (const [filePath, entry] of clientDiags) {
				const existing = all.get(filePath);
				if (existing) {
					existing.diags.push(...entry.diags);
					existing.ts = Math.max(existing.ts, entry.ts);
				} else {
					all.set(filePath, { diags: [...entry.diags], ts: entry.ts });
				}
			}
		}
		return all;
	}

	/**
	 * Check if LSP is available for a file
	 */
	async hasLSP(filePath: string): Promise<boolean> {
		const spawned = await this.getClientForFile(filePath);
		return Boolean(spawned);
	}

	/**
	 * Shutdown all LSP clients
	 */
	async shutdown(): Promise<void> {
		if (this.checkDestroyed()) return;
		this.isDestroyed = true;
		// Cancel any in-flight spawns
		this.state.inFlight.clear();

		for (const [_key, client] of this.state.clients) {
			try {
				await client.shutdown();
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
		return Array.from(this.state.clients.entries()).map(([key, _client]) => {
			const [serverId, root] = key.split(":");
			return { serverId, root, connected: true };
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

export function resetLSPService(): void {
	if (globalLSPService) {
		globalLSPService.shutdown().catch(() => {});
	}
	globalLSPService = null;
}
