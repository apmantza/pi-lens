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
import { getGlobalPiLensDir } from "../../../file-utils.js";
import { ensureTool } from "../../../installer/index.js";
import {
	getServersForFileWithConfig,
	isServerDisabled,
} from "../../../lsp/config.js";
import { findGlobalBinary } from "../../../package-manager.js";
import { safeSpawnAsync } from "../../../safe-spawn.js";
import {
	getToolCommandSpec,
	shouldAutoInstallTool,
} from "../../../tool-policy.js";
import type { DispatchContext } from "../../types.js";

/**
 * True when the LSP runner will cover `ctx.filePath` via the given PRIMARY server
 * id. Used by CLI runners that duplicate a linter a warm LSP already wraps
 * (taplo↔`toml` LSP = `taplo lsp`; shellcheck↔`bash` LSP runs shellcheck
 * internally) so they SELF-SKIP and stop double-reporting the same findings (#233)
 * — the same dormant-when-LSP-covers pattern the ast-grep napi runner uses.
 *
 * Non-spawning and conservative: honors the `no-lsp` kill switch + per-server
 * disable/config, and only matches when this server is the SELECTED primary for
 * the file (first non-auxiliary candidate). The caller additionally gates on tool
 * availability, so coverage never regresses when the LSP is absent/disabled.
 */
export function lspPrimaryCoversFile(
	ctx: DispatchContext,
	serverId: string,
): boolean {
	if (ctx.pi?.getFlag?.("no-lsp")) return false;
	if (isServerDisabled(serverId, ctx.filePath)) return false;
	const primary = getServersForFileWithConfig(ctx.filePath).find(
		(s) => s.role !== "auxiliary",
	);
	return primary?.id === serverId;
}

/**
 * Walk up from startDir until we find a directory containing node_modules/.bin.
 * Returns all such roots found up to the filesystem root — not just the nearest —
 * so callers can search them all for a specific binary.
 */
function findNodeBinRoots(startDir: string): string[] {
	const roots: string[] = [];
	let current = startDir;
	const fsRoot = path.parse(current).root;
	while (current !== fsRoot) {
		if (fs.existsSync(path.join(current, "node_modules", ".bin"))) {
			roots.push(current);
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return roots;
}

let _thisDir = path.dirname(fileURLToPath(import.meta.url));
if (typeof __dirname !== "undefined") {
	_thisDir = __dirname;
}

// Managed tools directory (~/.pi-lens/tools) — where ensureTool() installs binaries
const _managedToolsDir = path.join(getGlobalPiLensDir(), "tools");

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
 *
 * `versionArgs` defaults to `["--version"]` but some tools reject that flag and
 * expose version under a subcommand instead (e.g. `zig version`, not
 * `zig --version`). Passing the wrong probe makes the runner silently skip on
 * every machine, so toolchains with a non-standard version command must override
 * this.
 */
export function createAvailabilityChecker(
	command: string,
	windowsExt = "",
	versionArgs: string[] = ["--version"],
): {
	isAvailableAsync: (cwd?: string) => Promise<boolean>;
	getCommand: (cwd?: string) => string | null;
} {
	const cacheByCwd = new Map<string, AvailabilityCache>();
	const inFlightByCwd = new Map<string, Promise<boolean>>();

	const findCommand = createVenvFinder(command, windowsExt, true);

	function getCache(cwd: string): AvailabilityCache {
		const key = path.resolve(cwd || process.cwd());
		const existing = cacheByCwd.get(key);
		if (existing) return existing;
		const created: AvailabilityCache = { available: null, command: null };
		cacheByCwd.set(key, created);
		return created;
	}

	async function isAvailableAsync(cwd?: string): Promise<boolean> {
		const resolvedCwd = cwd || process.cwd();
		const cache = getCache(resolvedCwd);
		if (cache.available !== null) return cache.available;

		const key = path.resolve(resolvedCwd);
		const existing = inFlightByCwd.get(key);
		if (existing) return existing;

		const promise = (async () => {
			const cmd = findCommand(resolvedCwd);
			const result = await safeSpawnAsync(cmd, versionArgs, {
				timeout: 5000,
			});

			cache.available = !result.error && result.status === 0;
			if (cache.available) {
				cache.command = cmd;
			}
			return cache.available;
		})().finally(() => {
			inFlightByCwd.delete(key);
		});
		inFlightByCwd.set(key, promise);
		return promise;
	}

	function getCommand(cwd?: string): string | null {
		const cache = getCache(cwd || process.cwd());
		return cache.command;
	}

	return { isAvailableAsync, getCommand };
}

/**
 * Per-cwd cached availability probe for spawn signatures that don't fit
 * `createAvailabilityChecker` — multi-arg subcommands like `npx biome
 * --version`, `cargo clippy --version`, `mix credo --version`, or a
 * dynamically-resolved `<cmd> --version`. Each cwd is probed at most once;
 * concurrent first-time callers share the in-flight promise.
 *
 * The cache stores the boolean outcome forever (same shape as
 * `createAvailabilityChecker`): once known unavailable for a cwd, the
 * runner stays skipped for that cwd until the process restarts. Pass a
 * fresh probe for retry-after-install flows.
 */
export function createCwdCachedProbe(
	probe: (cwd: string) => Promise<boolean>,
): (cwd: string) => Promise<boolean> {
	const cacheByCwd = new Map<string, Promise<boolean>>();
	return (cwd: string) => {
		const key = path.resolve(cwd || process.cwd());
		const existing = cacheByCwd.get(key);
		if (existing) return existing;
		const promise = probe(key).catch(() => false);
		cacheByCwd.set(key, promise);
		return promise;
	};
}

export function resolveNodeToolCommand(
	cwd: string,
	toolName: string,
	windowsExt = ".cmd",
): string {
	const isWin = process.platform === "win32";
	const binName = isWin ? `${toolName}${windowsExt}` : toolName;
	const local = path.join(cwd, "node_modules", ".bin", binName);
	if (fs.existsSync(local)) return local;
	return toolName;
}

export function resolveToolCommand(cwd: string, toolId: string): string | null {
	const spec = getToolCommandSpec(toolId);
	if (!spec) return null;
	return resolveNodeToolCommand(cwd, spec.command, spec.windowsExt ?? ".cmd");
}

export function resolveVendorToolCommand(
	cwd: string,
	toolName: string,
	windowsExt = ".bat",
): string | null {
	const isWin = process.platform === "win32";
	const candidates = isWin
		? [
				path.join("vendor", "bin", `${toolName}${windowsExt}`),
				path.join("vendor", "bin", toolName),
			]
		: [path.join("vendor", "bin", toolName)];
	let dir = cwd;
	const root = path.parse(dir).root;
	while (true) {
		for (const candidate of candidates) {
			const full = path.join(dir, candidate);
			if (fs.existsSync(full)) return full;
		}
		if (dir === root) break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

export async function resolveToolCommandWithInstallFallback(
	cwd: string,
	toolId: string,
	timeout = 5000,
): Promise<string | null> {
	const spec = getToolCommandSpec(toolId);
	if (!spec) return null;
	return resolveCommandWithInstallFallback(
		resolveToolCommand(cwd, toolId) ?? spec.command,
		spec.managedToolId ?? toolId,
		cwd,
		spec.versionArgs ?? ["--version"],
		timeout,
	);
}

async function verifyOrInstallCommand(
	command: string,
	toolId: string,
	cwd: string,
	versionArgs: string[] = ["--version"],
	timeout = 5000,
): Promise<string | null> {
	const versionCheck = await safeSpawnAsync(command, versionArgs, {
		timeout,
		cwd,
	});
	if (!versionCheck.error && versionCheck.status === 0) {
		return command;
	}
	if (!shouldAutoInstallTool(toolId)) {
		return null;
	}
	const installed = await ensureTool(toolId);
	if (!installed) return null;
	const installedCheck = await safeSpawnAsync(installed, versionArgs, {
		timeout,
		cwd,
	});
	if (installedCheck.error || installedCheck.status !== 0) {
		return null;
	}
	return installed;
}

export async function resolveCommandArgsWithInstallFallback(
	command: { cmd: string; args: string[] },
	toolId: string,
	cwd: string,
	versionArgs: string[] = ["--version"],
	timeout = 5000,
): Promise<{ cmd: string; args: string[] } | null> {
	const versionCheck = await safeSpawnAsync(
		command.cmd,
		[...command.args, ...versionArgs],
		{ timeout, cwd },
	);
	if (!versionCheck.error && versionCheck.status === 0) {
		return command;
	}
	const installed = await verifyOrInstallCommand(
		command.cmd,
		toolId,
		cwd,
		versionArgs,
		timeout,
	);
	if (!installed) {
		return null;
	}
	if (installed === command.cmd) {
		return command;
	}
	return { cmd: installed, args: [] };
}

export async function resolveCommandWithInstallFallback(
	command: string,
	toolId: string,
	cwd: string,
	versionArgs: string[] = ["--version"],
	timeout = 5000,
): Promise<string | null> {
	return verifyOrInstallCommand(command, toolId, cwd, versionArgs, timeout);
}

export async function resolveAvailableOrInstall(
	checker: {
		isAvailableAsync: (cwd?: string) => Promise<boolean>;
		getCommand: (cwd?: string) => string | null;
	},
	toolId: string,
	cwd: string,
): Promise<string | null> {
	const available = await checker.isAvailableAsync(cwd);
	if (available) {
		return checker.getCommand(cwd);
	}
	if (!shouldAutoInstallTool(toolId)) {
		return null;
	}
	const installed = await ensureTool(toolId);
	return installed ?? null;
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

// Shared ast-grep availability cache across all slop runners
let sgAvailable: boolean | null = null;
let sgCmd: string | null = null;
let sgCmdArgs: string[] = [];

function isAstGrepVersionOutput(output: string): boolean {
	return /\bast[- ]grep\b/i.test(output);
}

async function probeAstGrepCommandAsync(
	cmd: string,
	argsPrefix: string[] = [],
): Promise<boolean> {
	const check = await safeSpawnAsync(cmd, [...argsPrefix, "--version"], {
		timeout: 5000,
	});
	return (
		!check.error &&
		check.status === 0 &&
		isAstGrepVersionOutput(`${check.stdout}\n${check.stderr}`)
	);
}

/** Pre-filter local node_modules/.bin candidates that actually exist on disk. */
function buildSgLocalBins(): string[] {
	const isWin = process.platform === "win32";
	const hasBash = !!(
		process.env.MSYSTEM ||
		process.env.GIT_SHELL ||
		process.env.BASH
	);
	const extensions = isWin
		? hasBash
			? ["", ".exe", ".cmd"]
			: [".cmd", ".exe", ""]
		: [""];
	const binaryCandidates = ["ast-grep", "sg"].flatMap((base) =>
		extensions.map((ext) => `${base}${ext}`),
	);
	const binRoots = [
		...findNodeBinRoots(_thisDir),
		...findNodeBinRoots(process.cwd()),
		_managedToolsDir,
	];
	const bins: string[] = [];
	for (const root of binRoots) {
		for (const candidate of binaryCandidates) {
			const localBin = path.join(root, "node_modules", ".bin", candidate);
			if (fs.existsSync(localBin)) bins.push(localBin);
		}
	}
	return bins;
}

let sgAvailableInFlight: Promise<boolean> | null = null;

export async function isSgAvailableAsync(): Promise<boolean> {
	if (sgAvailable !== null) return sgAvailable;
	if (sgAvailableInFlight) return sgAvailableInFlight;

	sgAvailableInFlight = (async () => {
		// 1. Local node_modules/.bin
		for (const localBin of buildSgLocalBins()) {
			if (await probeAstGrepCommandAsync(localBin)) {
				sgCmd = localBin; sgCmdArgs = []; sgAvailable = true;
				return true;
			}
		}

		// 2. Global PATH
		for (const cmd of ["ast-grep", "sg"]) {
			if (await probeAstGrepCommandAsync(cmd)) {
				sgCmd = cmd; sgCmdArgs = []; sgAvailable = true;
				return true;
			}
		}

		// 2b. Any package manager's global bin dir (npm/pnpm/yarn/bun) — catches
		// `pnpm add -g @ast-grep/cli` installs whose bin dir is off PATH (#375).
		for (const name of ["ast-grep", "sg"]) {
			const globalBin = await findGlobalBinary(name);
			if (globalBin && (await probeAstGrepCommandAsync(globalBin))) {
				sgCmd = globalBin; sgCmdArgs = []; sgAvailable = true;
				return true;
			}
		}

		// 3. npx --no (cache-only, no silent download).
		if (await probeAstGrepCommandAsync("npx", ["--no", "--", "ast-grep"])) {
			sgCmd = "npx"; sgCmdArgs = ["--no", "--", "ast-grep"]; sgAvailable = true;
			return true;
		}

		sgAvailable = false;
		return false;
	})().finally(() => {
		sgAvailableInFlight = null;
	});

	return sgAvailableInFlight;
}

export function getSgCommand(): { cmd: string; args: string[] } {
	return {
		cmd: sgCmd ?? "npx",
		args: sgCmdArgs.length ? sgCmdArgs : ["--no", "--", "ast-grep"],
	};
}

// =============================================================================
// LOCAL-FIRST BINARY RESOLUTION
// =============================================================================

/**
 * Find a tool binary preferring local node_modules/.bin, then any installed
 * package manager's global bin dir (npm/pnpm/yarn/bun), then global PATH. Only
 * falls back to `npx --no` as a last resort — the universal cache-only exec
 * (npx ships with node and never silently downloads), so this stays
 * manager-agnostic without risking a surprise `dlx` fetch on pnpm/yarn/bun.
 *
 * Returns: { cmd, args } where args may include the `["--no", toolName]` npx
 * preamble.
 */
export async function resolveLocalFirstAsync(
	toolName: string,
	cwd: string,
	windowsExt = ".cmd",
): Promise<{ cmd: string; args: string[] }> {
	const isWin = process.platform === "win32";
	const binName = isWin ? `${toolName}${windowsExt}` : toolName;

	// 1. Local node_modules/.bin (project-installed)
	const local = path.join(cwd, "node_modules", ".bin", binName);
	if (fs.existsSync(local)) return { cmd: local, args: [] };

	// 2. Global bin dir of ANY installed manager (npm/pnpm/yarn/bun) — direct
	//    file lookup, so it finds tools installed via `pnpm add -g` / `bun add -g`
	//    (whose bin dirs are often off PATH) and survives PATH staleness after an
	//    `install -g`. No spawn.
	const globalBin = await findGlobalBinary(toolName, windowsExt);
	if (globalBin) return { cmd: globalBin, args: [] };

	// 3. Global PATH (already installed system-wide, on PATH)
	const globalCheck = await safeSpawnAsync(toolName, ["--version"], {
		timeout: 3000,
	});
	if (!globalCheck.error && globalCheck.status === 0) {
		return { cmd: toolName, args: [] };
	}

	// 4. npx --no fallback — universal cache-only exec (no silent download)
	return { cmd: "npx", args: ["--no", toolName] };
}

// =============================================================================
// PRE-BUILT CHECKERS FOR COMMON TOOLS
// =============================================================================

export const pyright = createAvailabilityChecker("pyright", ".exe");
export const ruff = createAvailabilityChecker("ruff", ".exe");
export const biome = createAvailabilityChecker("biome");
export const sg = {
	isAvailableAsync: isSgAvailableAsync,
	getCommand: getSgCommand,
};
