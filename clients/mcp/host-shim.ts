/**
 * Host shim for the MCP path.
 *
 * pi-lens's dispatch core only couples to the host through a single-method
 * interface — `PiAgentAPI.getFlag`. When pi-lens runs *inside pi*, that flag
 * resolver is backed by pi's CLI flags + project/global config. When it runs as
 * an MCP server (no pi process, no CLI flags), we back it by project/global
 * config + env + optional per-call overrides instead. This is the *entire* host
 * coupling the MCP path has to satisfy — everything else under `clients/` is
 * host-neutral.
 */

import {
	loadPiLensGlobalConfig,
	resolvePiLensFlag,
} from "../lens-config.js";
import type { PiAgentAPI } from "../dispatch/types.js";
import { loadPiLensProjectConfig } from "../project-lens-config.js";

/**
 * Build a `PiAgentAPI` for the MCP path. `overrides` lets a single MCP tool call
 * pin flags for that analysis (e.g. `no-lsp: true` to bench the non-LSP path)
 * without mutating config. Precedence: override → project config → global
 * config default.
 */
export function createMcpHost(
	overrides?: Record<string, boolean | string | undefined>,
	projectRoot = process.cwd(),
): PiAgentAPI {
	const config = loadPiLensGlobalConfig();
	const projectConfig = loadPiLensProjectConfig(projectRoot);
	return {
		getFlag(name: string): boolean | string | undefined {
			if (overrides && Object.hasOwn(overrides, name)) {
				return overrides[name];
			}
			return resolvePiLensFlag(name, undefined, config, projectConfig);
		},
	};
}
