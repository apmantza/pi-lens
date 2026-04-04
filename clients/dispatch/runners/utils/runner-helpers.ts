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
import { resolvePackagePath } from "../../../package-root.js";
import { safeSpawn } from "../../../safe-spawn.js";

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
				return quoteWindows && windowsExt
					? `"${fullPath}"`
					: fullPath;
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
	getCommand: () => string | null;
} {
	const cache: AvailabilityCache = {
		available: null,
		command: null,
	};

	const findCommand = createVenvFinder(command, windowsExt, true);

	function isAvailable(cwd?: string): boolean {
		if (cache.available !== null) return cache.available;

		const cmd = findCommand(cwd || process.cwd());
		const result = safeSpawn(cmd, ["--version"], {
			timeout: 5000,
		});

		cache.available = !result.error && result.status === 0;
		if (cache.available) {
			cache.command = cmd;
		}
		return cache.available;
	}

	function getCommand(): string | null {
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

		const extensionPaths = [
			resolvePackagePath(import.meta.url, "rules", ruleDirName, ".sgconfig.yml"),
			path.resolve(cwd, `rules/${ruleDirName}/.sgconfig.yml`),
			path.resolve(cwd, `../rules/${ruleDirName}/.sgconfig.yml`),
		];

		for (const fullPath of extensionPaths) {
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

/**
 * Check if ast-grep CLI is available (shared cache)
 */
export function isSgAvailable(): boolean {
	if (sgAvailable !== null) return sgAvailable;

	const check = safeSpawn("npx", ["sg", "--version"], {
		timeout: 5000,
	});

	sgAvailable = !check.error && check.status === 0;
	return sgAvailable;
}

// =============================================================================
// PRE-BUILT CHECKERS FOR COMMON TOOLS
// =============================================================================

export const pyright = createAvailabilityChecker("pyright", ".exe");
export const ruff = createAvailabilityChecker("ruff", ".exe");
export const biome = createAvailabilityChecker("biome");
export const sg = { isAvailable: isSgAvailable, getCommand: () => "npx" };
