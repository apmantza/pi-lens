/**
 * LSP Configuration for pi-lens
 *
 * Allows users to define custom LSP servers via configuration.
 *
 * Config file: .pi-lens/lsp.json
 *
 * Example:
 * {
 *   "servers": {
 *     "my-server": {
 *       "name": "My Custom LSP",
 *       "extensions": [".myext"],
 *       "command": "my-lsp-server",
 *       "args": ["--stdio"],
 *       "rootMarkers": ["package.json"]
 *     }
 *   }
 * }
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchLSP } from "./launch.js";
import {
	createRootDetector,
	LSP_SERVERS,
	type LSPServerInfo,
} from "./server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Types ---

export interface CustomServerConfig {
	name: string;
	extensions: string[];
	command: string;
	args?: string[];
	rootMarkers?: string[];
	env?: Record<string, string>;
}

export interface LSPConfig {
	servers?: Record<string, CustomServerConfig>;
	disabledServers?: string[];
}

// --- Config Loading ---

const CONFIG_PATHS = [".pi-lens/lsp.json", ".pi-lens.json", "pi-lsp.json"];

/**
 * Load LSP configuration from file
 */
export async function loadLSPConfig(cwd: string): Promise<LSPConfig> {
	let dir = path.resolve(cwd);
	while (true) {
		for (const configPath of CONFIG_PATHS) {
			const fullPath = path.join(dir, configPath);
			try {
				const content = await fs.readFile(fullPath, "utf-8");
				const config = JSON.parse(content) as LSPConfig;
				console.error(`[lsp-config] Loaded config from ${fullPath}`);
				return config;
			} catch {
				// File doesn't exist or is invalid, try next
			}
		}

		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return {};
}

// --- Custom Server Factory ---

/**
 * Create LSPServerInfo from user configuration
 */
export function createCustomServer(
	config: CustomServerConfig,
	id: string,
): LSPServerInfo {
	return {
		id,
		name: config.name,
		extensions: config.extensions,
		root: config.rootMarkers
			? createRootDetector(config.rootMarkers)
			: async () => process.cwd(),
		async spawn(root) {
			const proc = await launchLSP(config.command, config.args ?? ["--stdio"], {
				cwd: root,
				env: config.env ? { ...process.env, ...config.env } : process.env,
			});
			return { process: proc };
		},
	};
}

// --- Registry Management ---

let customServers: LSPServerInfo[] = [];
let disabledServerIds: Set<string> = new Set();

/**
 * Initialize LSP configuration (call at session start)
 */
export async function initLSPConfig(cwd: string): Promise<void> {
	const config = await loadLSPConfig(cwd);

	// Clear previous custom servers
	customServers = [];
	disabledServerIds = new Set(config.disabledServers ?? []);

	// Register custom servers from config
	if (config.servers) {
		for (const [id, serverConfig] of Object.entries(config.servers)) {
			try {
				const server = createCustomServer(serverConfig, id);
				customServers.push(server);
				console.error(
					`[lsp-config] Registered custom server: ${id} (${serverConfig.name})`,
				);
			} catch (err) {
				// pi-lens-ignore: missing-error-propagation — per-server registration, skip bad entries
				console.error(`[lsp-config] Failed to register server ${id}:`, err);
			}
		}
	}
}

/**
 * Get all available servers (built-in + custom, minus disabled)
 */
export function getAllServers(): LSPServerInfo[] {
	const all = [...LSP_SERVERS, ...customServers];
	return all.filter((s) => !disabledServerIds.has(s.id));
}

/**
 * Check if a server is disabled
 */
export function isServerDisabled(serverId: string): boolean {
	return disabledServerIds.has(serverId);
}

// --- Override getServersForFile to include custom servers

export function getServersForFileWithConfig(filePath: string): LSPServerInfo[] {
	const ext = path.extname(filePath).toLowerCase();
	return getAllServers().filter((server) => server.extensions.includes(ext));
}

// Re-export with config support
export { getAllServers as getServersForFile };
