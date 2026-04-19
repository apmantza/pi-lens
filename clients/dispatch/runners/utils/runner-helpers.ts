/**
 * Shared runner utilities for pi-lens dispatch system
 *
 * Extracted common patterns from multiple runners to reduce duplication:
 * - Venv-aware command finders
 * - Availability checkers with caching
 * - Config file finders
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { safeSpawn } from "../../../safe-spawn.js";

// Resolve pi-lens's own node_modules/.bin regardless of process.cwd()
const _dirname =
	typeof __dirname !== "undefined"
		? __dirname
		: path.dirname(fileURLToPath(import.meta.url));
const _piLensRoot = path.resolve(_dirname, "../../../../..");

// =============================================================================
// VENV-AWARE COMMAND FINDER
// =============================================================================

export interface VenvPathConfig {
	unixPaths: string[];
	windowsPaths: string[];
	quoteWindowsPaths?: boolean;
}

/**
 * Find a command in venv first, then fall back to global.
 * Checks common venv locations (.venv, venv) before trying global.
 */
export function createVenvFinder(
	command: string,
	windowsExt = "",
	quoteWindows = false,
): (cwd: string) => string {
	return (cwd: string): string => {
		const venvPaths = [
			`.venv/bin/${command}`,
			`venv/bin/${command}`,
			`.venv/Scripts/${command}${windowsExt}`,
			`venv/Scripts/${command}${windowsExt}`,
		];

		for (const venvPath of venvPaths) {
			const fullPath = path.join(cwd, venvPath);
			if (fs.existsSync(fullPath)) {
				return quoteWindows && windowsExt ? `"${fullPath}"` : fullPath;
			}
		}

		// Fall back to global
		return command;
	};
}

// =============================================================================
// AVAILABILITY CHECKER FACTORY
// =============================================================================

type AvailabilityCache = {
	available: boolean | null;
	command: string | null;
};

/**
 * Create a cached availability checker for a command.
 * The checker will look for the command in venv first, then global.
 */
export function createAvailabilityChecker(
	command: string,
	windowsExt = "",
): {
	isAvailable: (cwd?: string) => boolean;
	getCommand: (cwd?: string) => string | null;
} {
	const cacheByCwd = new Map<string, AvailabilityCache>();

	const findCommand = createVenvFinder(command, windowsExt, true);

	function getCache(cwd: string): AvailabilityCache {
		const key = path.resolve(cwd || process.cwd());
		const existing = cacheByCwd.get(key);
		if (existing) return existing;
		const created: AvailabilityCache = { available: null, command: null };
		cacheByCwd.set(key, created);
		return created;
	}

	function isAvailable(cwd?: string): boolean {
		const resolvedCwd = cwd || process.cwd();
		const cache = getCache(resolvedCwd);
		if (cache.available !== null) return cache.available;

		const cmd = findCommand(resolvedCwd);
		const result = safeSpawn(cmd, ["--version"], {
			timeout: 5000,
		});

		cache.available = !result.error && result.status === 0;
		if (cache.available) {
			cache.command = cmd;
		}
		return cache.available;
	}

	function getCommand(cwd?: string): string | null {
		const cache = getCache(cwd || process.cwd());
		return cache.command;
	}

	return { isAvailable, getCommand };
}

// =============================================================================
// CONFIG FILE FINDER FACTORY
// =============================================================================

/**
 * Create a config file finder for rule directories.
 * Common pattern used by slop runners and similar tools.
 */
export function createConfigFinder(
	ruleDirName: string,
): (cwd: string) => string | undefined {
	return (cwd: string): string | undefined => {
		// Check for local config first
		const localPath = path.join(cwd, "rules", ruleDirName, ".sgconfig.yml");
		if (fs.existsSync(localPath)) {
			return localPath;
		}

		// Fall back to extension rules
		const extensionPaths = [
			`rules/${ruleDirName}/.sgconfig.yml`,
			`../rules/${ruleDirName}/.sgconfig.yml`,
		];

		for (const candidate of extensionPaths) {
			const fullPath = path.resolve(cwd, candidate);
			if (fs.existsSync(fullPath)) {
				return fullPath;
			}
		}

		return undefined;
	};
}

// =============================================================================
// SHARED AST-GREP AVAILABILITY
// =============================================================================

// Shared sg availability cache across all slop runners
let sgAvailable: boolean | null = null;
let sgCmd: string | null = null;
let sgCmdArgs: string[] = [];

/**
 * Check if ast-grep CLI (sg) is available.
 * Prefers local node_modules/.bin/sg, then global sg, then npx --no sg (cache-only).
 */
export function isSgAvailable(): boolean {
	if (sgAvailable !== null) return sgAvailable;

	// 1. Local node_modules/.bin/sg — check pi-lens install dir first, then cwd
	const isWin = process.platform === "win32";
	// On Windows with Git Bash, prefer the bare 'sg' shim (bash-compatible) over
	// .cmd/.ps1 which bash cannot execute. In plain cmd/PowerShell, .cmd is fine.
	const hasBash = !!(process.env.MSYSTEM || process.env.GIT_SHELL || process.env.BASH);
	const sgCandidates = isWin
		? (hasBash ? ["sg", "sg.exe", "sg.cmd", "sg.ps1"] : ["sg.cmd", "sg.ps1", "sg.exe", "sg"])
		: ["sg"];
	const binRoots = [_piLensRoot, process.cwd()];
	for (const root of binRoots) {
		for (const candidate of sgCandidates) {
			const localSg = path.join(root, "node_modules", ".bin", candidate);
			if (!fs.existsSync(localSg)) continue;
			const check = safeSpawn(localSg, ["--version"], { timeout: 5000 });
			if (!check.error && check.status === 0) {
				sgCmd = localSg;
				sgCmdArgs = [];
				sgAvailable = true;
				return true;
			}
		}
	}

	// 2. Global sg
	const globalCheck = safeSpawn("sg", ["--version"], { timeout: 5000 });
	if (!globalCheck.error && globalCheck.status === 0) {
		sgCmd = "sg";
		sgCmdArgs = [];
		sgAvailable = true;
		return true;
	}

	// 3. npx --no (cache-only, no silent download)
	const npxCheck = safeSpawn("npx", ["--no", "sg", "--version"], {
		timeout: 5000,
	});
	sgAvailable = !npxCheck.error && npxCheck.status === 0;
	if (sgAvailable) {
		sgCmd = "npx";
		sgCmdArgs = ["--no"];
	}
	return sgAvailable;
}

export function getSgCommand(): { cmd: string; args: string[] } {
	return { cmd: sgCmd ?? "npx", args: sgCmdArgs.length ? sgCmdArgs : ["--no"] };
}

// =============================================================================
// LOCAL-FIRST BINARY RESOLUTION
// =============================================================================

/**
 * Find a tool binary preferring local node_modules/.bin over global PATH.
 * Only falls back to npx as a last resort (avoids silent network downloads).
 *
 * Returns: { cmd, args } where args may include ["npx", toolName] preamble.
 */
export function resolveLocalFirst(
	toolName: string,
	cwd: string,
	windowsExt = ".cmd",
): { cmd: string; args: string[] } {
	const isWin = process.platform === "win32";
	const binName = isWin ? `${toolName}${windowsExt}` : toolName;

	// 1. Local node_modules/.bin (project-installed)
	const local = path.join(cwd, "node_modules", ".bin", binName);
	if (fs.existsSync(local)) return { cmd: local, args: [] };

	// 2. Global PATH (already installed system-wide)
	const globalCheck = safeSpawn(toolName, ["--version"], { timeout: 3000 });
	if (!globalCheck.error && globalCheck.status === 0) {
		return { cmd: toolName, args: [] };
	}

	// 3. npx fallback — only for already-cached packages (no silent download)
	return { cmd: "npx", args: ["--no", toolName] };
}

// =============================================================================
// PRE-BUILT CHECKERS FOR COMMON TOOLS
// =============================================================================

export const pyright = createAvailabilityChecker("pyright", ".exe");
export const ruff = createAvailabilityChecker("ruff", ".exe");
export const biome = createAvailabilityChecker("biome");
export const sg = { isAvailable: isSgAvailable, getCommand: getSgCommand };
