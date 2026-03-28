/**
 * Tool Availability Caching for pi-lens
 *
 * Provides cached tool availability checks to avoid repeated spawnSync calls.
 * Tools like biome, ruff, ast-grep are checked once per session.
 */

import { spawnSync } from "node:child_process";

// --- Types ---

export interface ToolInfo {
	name: string;
	command: string;
	versionCommand?: string[];
	versionPattern?: RegExp;
}

// --- Tool Registry ---

export const TOOL_REGISTRY: ToolInfo[] = [
	{
		name: "biome",
		command: "npx",
		versionCommand: ["@biomejs/biome", "--version"],
		versionPattern: /(\d+\.\d+\.\d+)/,
	},
	{
		name: "ruff",
		command: "ruff",
		versionCommand: ["--version"],
		versionPattern: /(\d+\.\d+\.\d+)/,
	},
	{
		name: "ast-grep",
		command: "npx",
		versionCommand: ["sg", "--version"],
		versionPattern: /(\d+\.\d+\.\d+)/,
	},
	{
		name: "knip",
		command: "npx",
		versionCommand: ["knip", "--version"],
		versionPattern: /(\d+\.\d+\.\d+)/,
	},
	{
		name: "jscpd",
		command: "npx",
		versionCommand: ["jscpd", "--version"],
		versionPattern: /(\d+\.\d+\.\d+)/,
	},
	{
		name: "type-coverage",
		command: "npx",
		versionCommand: ["type-coverage", "--version"],
		versionPattern: /(\d+\.\d+\.\d+)/,
	},
	{
		name: "madge",
		command: "npx",
		versionCommand: ["madge", "--version"],
		versionPattern: /(\d+\.\d+\.\d+)/,
	},
	{
		name: "tsc",
		command: "npx",
		versionCommand: ["tsc", "--version"],
		versionPattern: /Version\s+(\d+\.\d+\.\d+)/,
	},
	{
		name: "go",
		command: "go",
		versionCommand: ["version"],
		versionPattern: /go(\d+\.\d+\.\d+)/,
	},
	{
		name: "cargo",
		command: "cargo",
		versionCommand: ["--version"],
		versionPattern: /(\d+\.\d+\.\d+)/,
	},
];

// --- Cache ---

interface CacheEntry {
	available: boolean;
	version?: string;
	timestamp: number;
}

const TOOL_CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// --- Functions ---

/**
 * Clear the tool availability cache.
 * Useful for testing or when tool installations change.
 */
export function clearToolCache(): void {
	TOOL_CACHE.clear();
}

/**
 * Get cached tool availability or check if available.
 * Uses cached result if within TTL.
 */
export function isToolAvailable(toolName: string): boolean {
	const cached = TOOL_CACHE.get(toolName);
	if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
		return cached.available;
	}

	// Check availability
	const tool = TOOL_REGISTRY.find((t) => t.name === toolName);
	if (!tool) {
		// Unknown tool - try direct command check
		const result = spawnSync(toolName, ["--version"], {
			encoding: "utf-8",
			timeout: 5000,
			shell: true,
		});
		const available = !result.error && result.status === 0;
		TOOL_CACHE.set(toolName, {
			available,
			version: available
				? extractVersion(result.stdout + result.stderr, /(\S+)/)
				: undefined,
			timestamp: Date.now(),
		});
		return available;
	}

	// Check using tool's version command
	if (tool.versionCommand) {
		const result = spawnSync(tool.command, tool.versionCommand, {
			encoding: "utf-8",
			timeout: 10000,
			shell: true,
		});
		const available = !result.error && result.status === 0;
		const output = result.stdout + result.stderr;
		const version = tool.versionPattern
			? extractVersion(output, tool.versionPattern)
			: undefined;

		TOOL_CACHE.set(toolName, {
			available,
			version,
			timestamp: Date.now(),
		});

		return available;
	}

	return false;
}

/**
 * Get cached tool version if available.
 */
export function getToolVersion(toolName: string): string | undefined {
	const cached = TOOL_CACHE.get(toolName);
	if (cached?.version) {
		return cached.version;
	}

	// Try to get version even if not cached
	const tool = TOOL_REGISTRY.find((t) => t.name === toolName);
	if (tool?.versionCommand) {
		const result = spawnSync(tool.command, tool.versionCommand, {
			encoding: "utf-8",
			timeout: 10000,
			shell: true,
		});
		if (!result.error && result.status === 0) {
			const output = result.stdout + result.stderr;
			return tool.versionPattern
				? extractVersion(output, tool.versionPattern)
				: output.trim();
		}
	}

	return undefined;
}

/**
 * Check multiple tools at once and return their availability.
 */
export function checkToolsAvailable(toolNames: string[]): Map<string, boolean> {
	const results = new Map<string, boolean>();
	for (const name of toolNames) {
		results.set(name, isToolAvailable(name));
	}
	return results;
}

/**
 * Get all available tools.
 */
export function getAvailableTools(): string[] {
	const available: string[] = [];
	for (const tool of TOOL_REGISTRY) {
		if (isToolAvailable(tool.name)) {
			available.push(tool.name);
		}
	}
	return available;
}

// --- Helpers ---

function extractVersion(output: string, pattern: RegExp): string | undefined {
	const match = output.match(pattern);
	return match ? match[1] : undefined;
}

/**
 * Convenience wrapper for checking common tools.
 */
export class ToolAvailabilityChecker {
	private toolNames: string[];

	constructor(toolNames: string[]) {
		this.toolNames = toolNames;
	}

	/**
	 * Check if all tools in the list are available.
	 */
	allAvailable(): boolean {
		return this.toolNames.every((name) => isToolAvailable(name));
	}

	/**
	 * Check if any tool in the list is available.
	 */
	anyAvailable(): boolean {
		return this.toolNames.some((name) => isToolAvailable(name));
	}

	/**
	 * Get list of available tools in this list.
	 */
	getAvailable(): string[] {
		return this.toolNames.filter((name) => isToolAvailable(name));
	}

	/**
	 * Get list of unavailable tools in this list.
	 */
	getUnavailable(): string[] {
		return this.toolNames.filter((name) => !isToolAvailable(name));
	}
}
