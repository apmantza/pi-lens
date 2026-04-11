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
import type { LSPClientInfo } from "./client.js";
import { createLSPClient } from "./client.js";
import { getServersForFileWithConfig } from "./config.js";
import { getLanguageId } from "./language.js";
import type { LSPServerInfo } from "./server.js";
import { normalizeMapKey, uriToPath } from "../path-utils.js";
import { detectFileKind } from "../file-kinds.js";
import { detectProjectLanguageProfile } from "../language-profile.js";
import { logLatency } from "../latency-logger.js";

// --- Types ---

export interface LSPState {
	clients: Map<string, LSPClientInfo>; // key: "serverId:root"
	servers: Map<string, LSPServerInfo>;
	broken: Map<string, number>; // servers that failed to initialize with retry-at timestamp
	inFlight: Map<string, Promise<SpawnedServer | undefined>>; // prevent duplicate spawns
}

const BROKEN_RETRY_COOLDOWN_MS = 15_000;
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
	private languagePolicyCache = new Map<string, { allowInstall: boolean; expiresAt: number }>();
	private workspaceProbeLogged = new Set<string>();
	private warmStartLogged = new Set<string>();
	private emitConsoleLspErrors = process.env.PI_LENS_CONSOLE_LSP === "1";

	constructor() {
		this.state = {
			clients: new Map(),
			servers: new Map(),
			broken: new Map(),
			inFlight: new Map(),
		};
	}

	/**
	 * Get or create LSP client for a file
	 * Prevents duplicate client creation via in-flight promise tracking
	 */
	async getClientForFile(filePath: string): Promise<SpawnedServer | undefined> {
		const servers = getServersForFileWithConfig(filePath);
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

	private async ensureClientForServer(
		filePath: string,
		server: LSPServerInfo,
	): Promise<SpawnedServer | undefined> {
		const root = await server.root(filePath);
		if (!root) return undefined;
		const allowInstall = this.shouldAllowInstall(filePath, root);

		const normalizedRoot = normalizeMapKey(root);
		const key = `${server.id}:${normalizedRoot}`;

		const existing = this.state.clients.get(key);
		if (existing) {
			if (!existing.isAlive()) {
				try {
					await existing.shutdown();
				} catch {
					/* ignore dead client shutdown errors */
				}
				this.state.clients.delete(key);
				this.state.broken.delete(key);
			} else {
				if (!this.warmStartLogged.has(key)) {
					logSessionStart(
						`lsp warm-start ${server.id}: reused root=${root} file=${filePath}`,
					);
					this.warmStartLogged.add(key);
				}
				return { client: existing, info: server };
			}
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
		}

		const inFlight = this.state.inFlight.get(key);
		if (inFlight) {
			return inFlight;
		}

		const spawnPromise = this.spawnClient(server, root, key, filePath, allowInstall);
		this.state.inFlight.set(key, spawnPromise);

		try {
			return await spawnPromise;
		} finally {
			this.state.inFlight.delete(key);
		}
	}

	private shouldAllowInstall(filePath: string, root: string): boolean {
		if (process.env.PI_LENS_AUTO_INSTALL === "1") return true;

		const kind = detectFileKind(filePath);
		if (!kind) return true;

		const cacheKey = `${normalizeMapKey(root)}:${kind}`;
		const now = Date.now();
		const cached = this.languagePolicyCache.get(cacheKey);
		if (cached && cached.expiresAt > now) {
			return cached.allowInstall;
		}

		let allowInstall = true;
		try {
			const profile = detectProjectLanguageProfile(root);
			const count = profile.counts[kind] ?? 0;
			const configured = !!profile.configured[kind];
			const singleLanguageProject = profile.detectedKinds.length <= 1;
			allowInstall = configured || count > 1 || singleLanguageProject;
		} catch {
			allowInstall = true;
		}

		this.languagePolicyCache.set(cacheKey, {
			allowInstall,
			expiresAt: now + 10_000,
		});

		return allowInstall;
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
		const startedAt = Date.now();
		logSessionStart(
			`lsp spawn ${server.id}: start root=${root} policy=${server.installPolicy ?? "unknown"} install=${allowInstall ? "enabled" : "disabled"} file=${filePath}`,
		);
		try {
			const spawned = await server.spawn(root, { allowInstall });
			if (!spawned) {
				logSessionStart(
					`lsp spawn ${server.id}: unavailable (${Date.now() - startedAt}ms)`,
				);
				this.state.broken.set(key, Date.now() + BROKEN_RETRY_COOLDOWN_MS);
				return undefined;
			}

			const client = await createLSPClient({
				serverId: server.id,
				process: spawned.process,
				root,
				initialization: spawned.initialization,
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
			logSessionStart(
				`lsp spawn ${server.id}: success source=${spawned.source ?? server.installPolicy ?? "unknown"} (${Date.now() - startedAt}ms)`,
			);
			if (!this.workspaceProbeLogged.has(key)) {
				logSessionStart(
					`lsp workspace-diag probe ${server.id}: advertised=${wsDiag.advertised} mode=${wsDiag.mode} provider=${wsDiag.diagnosticProviderKind}`,
				);
				this.workspaceProbeLogged.add(key);
			}
			return { client, info: server };
		} catch (err) {
			logSessionStart(
				`lsp spawn ${server.id}: failed (${Date.now() - startedAt}ms) error=${err instanceof Error ? err.message : String(err)}`,
			);
			const errorMsg = err instanceof Error ? err.message : String(err);
			if (this.emitConsoleLspErrors) {
				if (errorMsg.includes("Timeout")) {
					console.error(
						`[lsp] ${server.id} timed out during initialization (${errorMsg}). The server may be downloading or the project is large. Skipping.`,
					);
				} else if (errorMsg.includes("stream was destroyed")) {
					console.error(
						`[lsp] ${server.id} stream was destroyed. The server binary may be missing or crashed immediately. Try reinstalling: npm install -g ${server.id}-language-server`,
					);
				} else if (errorMsg.includes("exited immediately")) {
					console.error(
						`[lsp] ${server.id} ${errorMsg}. Try reinstalling: npm install -g ${server.id}-language-server`,
					);
				} else {
					console.error(`[lsp] Failed to spawn ${server.id}:`, err);
				}
			}
			this.state.broken.set(key, Date.now() + BROKEN_RETRY_COOLDOWN_MS);
			return undefined;
		}
	}

	/**
	 * Open a file in LSP (sends textDocument/didOpen)
	 */
	async openFile(filePath: string, content: string): Promise<void> {
		const spawned = await this.getClientForFile(filePath);
		if (!spawned) return;

		const languageId = getLanguageId(filePath) ?? "plaintext";
		await spawned.client.notify.open(filePath, content, languageId);
	}

	/**
	 * Update file content (sends textDocument/didChange)
	 */
	async updateFile(filePath: string, content: string): Promise<void> {
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
	): Promise<void> {
		const startedAt = Date.now();
		const normalizedPath = normalizeMapKey(filePath);
		const spawned = useAllClients
			? await this.getClientsForFile(filePath)
			: await this.getClientForFile(filePath).then((entry) =>
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
				clientScope: useAllClients ? "all" : "primary",
				failureKind: "no_clients",
			},
			});
			return;
		}

		const languageId = getLanguageId(filePath) ?? "plaintext";
		await Promise.all(
			spawned.map((entry) => entry.client.notify.open(filePath, content, languageId)),
		);

		if (waitForDiagnostics) {
			await Promise.all(
				spawned.map((entry) =>
					entry.client.waitForDiagnostics(filePath, 1200).catch(() => undefined),
				),
			);
		}

		logLatency({
			type: "phase",
			phase: "lsp_touch_file",
			filePath: normalizedPath,
			durationMs: Date.now() - startedAt,
			metadata: {
				serverCountReady: spawned.length,
				clientScope: useAllClients ? "all" : "primary",
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

		const perServer = await Promise.all(
			spawned.map(async (entry) => {
				const waitStart = Date.now();
				await entry.client.waitForDiagnostics(filePath, 3000);
				const diagnostics = entry.client.getDiagnostics(filePath);
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
		const failureKind = merged.length === 0 ? "empty_result" : "success";

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
				health: failureKind === "success" ? "ok" : "empty_result",
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
		const spawned = await this.getClientForFile(filePath);
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
		const spawned = await this.getClientForFile(filePath);
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
		const spawned = await this.getClientForFile(filePath);
		if (!spawned) return null;
		return spawned.client.hover(filePath, line, character);
	}

	/**
	 * Navigation: signature help at cursor position
	 */
	async signatureHelp(filePath: string, line: number, character: number) {
		const spawned = await this.getClientForFile(filePath);
		if (!spawned) return null;
		return spawned.client.signatureHelp(filePath, line, character);
	}

	/**
	 * Navigation: symbols in document
	 */
	async documentSymbol(filePath: string) {
		const spawned = await this.getClientForFile(filePath);
		if (!spawned) return [];
		return spawned.client.documentSymbol(filePath);
	}

	/**
	 * Navigation: workspace-wide symbol search
	 */
	async workspaceSymbol(query: string, filePath?: string) {
		if (filePath) {
			const spawned = await this.getClientForFile(filePath);
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
	async getOperationSupport(filePath?: string): Promise<
		import("./client.js").LSPOperationSupport | null
	> {
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
	async getWorkspaceDiagnosticsSupport(filePath?: string): Promise<
		import("./client.js").LSPWorkspaceDiagnosticsSupport | null
	> {
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
		const spawned = await this.getClientForFile(filePath);
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
		const spawned = await this.getClientForFile(filePath);
		if (!spawned) return null;
		return spawned.client.rename(filePath, line, character, newName);
	}

	/**
	 * Navigation: go to implementation
	 */
	async implementation(filePath: string, line: number, character: number) {
		const spawned = await this.getClientForFile(filePath);
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
		const spawned = await this.getClientForFile(filePath);
		if (!spawned) return [];
		return spawned.client.prepareCallHierarchy(filePath, line, character);
	}

	/**
	 * Navigation: find incoming calls (callers)
	 */
	async incomingCalls(item: import("./client.js").LSPCallHierarchyItem) {
		const spawned = await this.getClientForFile(uriToPath(item.uri));
		if (!spawned) return [];
		return spawned.client.incomingCalls(item);
	}

	/**
	 * Navigation: find outgoing calls (callees)
	 */
	async outgoingCalls(item: import("./client.js").LSPCallHierarchyItem) {
		const spawned = await this.getClientForFile(uriToPath(item.uri));
		if (!spawned) return [];
		return spawned.client.outgoingCalls(item);
	}

	/**
	 * Get all diagnostics across all tracked files (for cascade checking)
	 */
	async getAllDiagnostics(): Promise<
		Map<string, import("./client.js").LSPDiagnostic[]>
	> {
		const all = new Map<string, import("./client.js").LSPDiagnostic[]>();
		for (const [_key, client] of this.state.clients) {
			const clientDiags = client.getAllDiagnostics();
			for (const [filePath, diags] of clientDiags) {
				const existing = all.get(filePath) ?? [];
				all.set(filePath, [...existing, ...diags]);
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
		// Cancel any in-flight spawns
		this.state.inFlight.clear();

		for (const [key, client] of this.state.clients) {
			try {
				await client.shutdown();
			} catch (err) {
				console.error(`[lsp] Error shutting down ${key}:`, err);
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
