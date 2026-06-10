/**
 * LSP Server Definitions for pi-lens
 *
 * Defines 40+ language servers with:
 * - Root detection (monorepo support)
 * - Auto-installation strategies
 * - Platform-specific handling
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { access, appendFile, mkdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isTestMode } from "../env-utils.js";
import { getGlobalPiLensDir } from "../file-utils.js";
import { KIND_EXTENSIONS } from "../file-kinds.js";
import { ensureTool, getToolEnvironment } from "../installer/index.js";
import { logLatency } from "../latency-logger.js";
import { isCommandAvailableAsync } from "../safe-spawn.js";
import { type LSPProcess, launchLSP } from "./launch.js";
import { normalizeMapKey } from "./path-utils.js";

// --- Types ---

export type RootFunction = (file: string) => Promise<string | undefined>;

export interface LSPSpawnOptions {
	allowInstall?: boolean;
}

export interface LSPServerInfo {
	id: string;
	name: string;
	extensions: readonly string[];
	root: RootFunction;
	/** Simple command name whose absence disables spawn attempts briefly across roots. */
	availabilityKey?: string;
	/**
	 * Optional per-server initialize timeout.
	 * Useful for servers like Ruby LSP that do real project bootstrap work
	 * before they can answer initialize.
	 */
	initializeTimeoutMs?: number;
	/**
	 * Optional per-server wait budget for navigation requests that need a client
	 * to become ready first.
	 */
	clientWaitTimeoutMs?: number;
	/**
	 * Server recomputes/pushes dependent-file diagnostics after primary file changes.
	 * Cascade can read its passive snapshot instead of actively touching neighbors.
	 */
	autoPropagateDiagnostics?: boolean;
	spawn(
		root: string,
		options?: LSPSpawnOptions,
	): Promise<
		| {
				process: LSPProcess;
				initialization?: Record<string, unknown>;
				source?: "direct" | "managed" | "package-manager" | "interactive";
		  }
		| undefined
	>;
	autoInstall?: () => Promise<boolean>;
}

function isLspInstallDisabled(): boolean {
	return process.env.PI_LENS_DISABLE_LSP_INSTALL === "1";
}

function canInstall(allowInstall?: boolean): boolean {
	return allowInstall !== false && !isLspInstallDisabled();
}

function isCommandNotFoundError(error: unknown): boolean {
	const msg = String(error);
	return (
		msg.includes("not found") ||
		msg.includes("ENOENT") ||
		msg.includes("not recognized")
	);
}

const DIRECT_LSP_NEGATIVE_TTL_MS = Math.max(
	30_000,
	Number.parseInt(
		process.env.PI_LENS_DIRECT_LSP_NEGATIVE_TTL_MS ?? "600000",
		10,
	) || 600_000,
);
const directLspCommandUnavailableUntil = new Map<string, number>();
const directLspCommandSkipLoggedUntil = new Map<string, number>();

function isSimpleCommand(command: string): boolean {
	return (
		!path.isAbsolute(command) &&
		!command.includes("/") &&
		!command.includes("\\")
	);
}

export function isDirectLspCommandTemporarilyUnavailable(
	command: string,
): boolean {
	const until = directLspCommandUnavailableUntil.get(command);
	if (!until || until <= Date.now()) {
		directLspCommandUnavailableUntil.delete(command);
		return false;
	}
	const loggedUntil = directLspCommandSkipLoggedUntil.get(command) ?? 0;
	if (loggedUntil <= Date.now()) {
		logSessionStart(
			`lsp direct command ${command}: skipped by negative availability cache (${Math.max(0, until - Date.now())}ms remaining)`,
		);
		directLspCommandSkipLoggedUntil.set(command, until);
	}
	return true;
}

function markDirectLspCommandUnavailable(command: string): void {
	if (!isSimpleCommand(command)) return;
	directLspCommandUnavailableUntil.set(
		command,
		Date.now() + DIRECT_LSP_NEGATIVE_TTL_MS,
	);
	directLspCommandSkipLoggedUntil.delete(command);
}

const SESSIONSTART_LOG_DIR = getGlobalPiLensDir();
const SESSIONSTART_LOG = path.join(SESSIONSTART_LOG_DIR, "sessionstart.log");
const PI_LENS_BIN_DIR = path.join(getGlobalPiLensDir(), "bin");

function logSessionStart(message: string): void {
	if (isTestMode()) {
		return;
	}
	const line = `[${new Date().toISOString()}] ${message}\n`;
	mkdir(SESSIONSTART_LOG_DIR, { recursive: true })
		.then(() => appendFile(SESSIONSTART_LOG, line))
		.catch(() => {
			// best-effort logging
		});
}

// ---------------------------------------------------------------------------
// Unified binary resolution + launch
// ---------------------------------------------------------------------------
//
// Replaces the four ad-hoc patterns (launchWithDirectOrPackageManager,
// spawnWithInteractiveInstall, manual ensureTool chains, installPolicy enum).
//
// Resolution chain (first match wins):
//   1. Explicit candidates (project node_modules, full paths)
//   2. System PATH (bare command name)
//   3. ensureTool() — managed npm/pip install via installer registry
//   4. runtimeInstall — language-native install (go install, gem install, …)
//   5. [future] github — platform binary download
//
// All steps are silent and gated by canInstall(). Returns undefined if no
// binary can be found or installed.

interface ResolveAndLaunchSpec {
	/** Ordered list of full paths / bare commands to try first */
	candidates: string[];
	/** LSP args to pass on launch */
	args: string[];
	/** Working directory */
	cwd: string;
	/** Optional env overrides */
	env?: NodeJS.ProcessEnv;
	/** installer tool ID — checked/installed via ensureTool() */
	managedToolId?: string;
	/** Runtime install: check this command is on PATH, then run installer */
	runtimeInstall?: {
		runtimeCommand: string;
		install: () => Promise<boolean>;
		/** After a successful install, retry these candidates (defaults to spec.candidates) */
		retryCandidates?: string[];
	};
}

async function resolveAndLaunch(
	spec: ResolveAndLaunchSpec,
	allowInstall: boolean | undefined,
): Promise<
	| { process: LSPProcess; source: "direct" | "managed" | "package-manager" }
	| undefined
> {
	const toolLabel =
		spec.managedToolId ??
		spec.candidates[spec.candidates.length - 1] ??
		"unknown";
	let lastRuntimeFailure: Error | undefined;
	const trackRuntimeFailure = (err: unknown): void => {
		const message = err instanceof Error ? err.message : String(err);
		if (!isCommandNotFoundError(message)) {
			lastRuntimeFailure = err instanceof Error ? err : new Error(message);
		}
	};

	// Step 1 & 2 — try all explicit candidates (includes bare command = PATH lookup)
	for (const [index, command] of spec.candidates.entries()) {
		logLatency({
			type: "phase",
			phase: "lsp_launch_candidate_attempt",
			filePath: spec.cwd,
			durationMs: 0,
			metadata: {
				tool: toolLabel,
				command,
				index,
				totalCandidates: spec.candidates.length,
				allowInstall: canInstall(allowInstall),
			},
		});
		logSessionStart(
			`lsp launch candidate attempt tool=${toolLabel} idx=${index}/${spec.candidates.length - 1} command=${command} cwd=${spec.cwd}`,
		);
		try {
			const proc = await launchLSP(command, spec.args, {
				cwd: spec.cwd,
				env: spec.env,
			});
			logLatency({
				type: "phase",
				phase: "lsp_launch_candidate_success",
				filePath: spec.cwd,
				durationMs: 0,
				metadata: {
					tool: toolLabel,
					command,
					index,
					source: "direct",
				},
			});
			logSessionStart(
				`lsp launch candidate success tool=${toolLabel} idx=${index} command=${command} source=direct`,
			);
			return { process: proc, source: "direct" };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logLatency({
				type: "phase",
				phase: "lsp_launch_candidate_failed",
				filePath: spec.cwd,
				durationMs: 0,
				metadata: {
					tool: toolLabel,
					command,
					index,
					error: message,
				},
			});
			logSessionStart(
				`lsp launch candidate failed tool=${toolLabel} idx=${index} command=${command} error=${message}`,
			);
			trackRuntimeFailure(err);
			// try next
		}
	}

	if (!canInstall(allowInstall)) {
		logSessionStart(
			`lsp launch install blocked tool=${toolLabel} cwd=${spec.cwd} allowInstall=${allowInstall !== false} globalDisabled=${isLspInstallDisabled()}`,
		);
		logLatency({
			type: "phase",
			phase: "lsp_launch_install_blocked",
			filePath: spec.cwd,
			durationMs: 0,
			metadata: {
				tool: toolLabel,
				allowInstall,
				globalInstallDisabled: isLspInstallDisabled(),
			},
		});
		return undefined;
	}

	// Step 3 — managed install via installer registry
	if (spec.managedToolId) {
		logSessionStart(
			`lsp launch ensure-tool start tool=${spec.managedToolId} cwd=${spec.cwd}`,
		);
		const installed = await ensureTool(spec.managedToolId);
		logSessionStart(
			`lsp launch ensure-tool result tool=${spec.managedToolId} installed=${installed ? "yes" : "no"} path=${installed ?? ""}`,
		);
		logLatency({
			type: "phase",
			phase: "lsp_launch_ensure_tool_result",
			filePath: spec.cwd,
			durationMs: 0,
			metadata: {
				tool: spec.managedToolId,
				installed: Boolean(installed),
				path: installed,
			},
		});
		if (installed) {
			try {
				const proc = await launchLSP(installed, spec.args, {
					cwd: spec.cwd,
					env: spec.env,
				});
				logSessionStart(
					`lsp launch managed success tool=${spec.managedToolId} command=${installed} source=managed`,
				);
				logLatency({
					type: "phase",
					phase: "lsp_launch_managed_success",
					filePath: spec.cwd,
					durationMs: 0,
					metadata: {
						tool: spec.managedToolId,
						command: installed,
					},
				});
				return { process: proc, source: "managed" };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				logSessionStart(
					`lsp launch managed failed tool=${spec.managedToolId} command=${installed} error=${message}`,
				);
				logLatency({
					type: "phase",
					phase: "lsp_launch_managed_failed",
					filePath: spec.cwd,
					durationMs: 0,
					metadata: {
						tool: spec.managedToolId,
						command: installed,
						error: message,
					},
				});
				trackRuntimeFailure(err);

				// force-reinstall: when a PATH-resolved tool (bare command name)
				// fails to launch (e.g. broken symlink, missing .dll), nuke the
				// caches and download a managed copy from the registry.
				const looksPathResolved =
					!installed.includes("/") && !installed.includes("\\");
				if (looksPathResolved) {
					logSessionStart(
						`lsp launch managed retry force-reinstall tool=${spec.managedToolId}`,
					);
					const reinstalled = await ensureTool(spec.managedToolId, {
						forceReinstall: true,
					});
					if (reinstalled) {
						try {
							const proc = await launchLSP(reinstalled, spec.args, {
								cwd: spec.cwd,
								env: spec.env,
							});
							logSessionStart(
								`lsp launch managed force-reinstall success tool=${spec.managedToolId} command=${reinstalled}`,
							);
							logLatency({
								type: "phase",
								phase: "lsp_launch_managed_force_reinstall_success",
								filePath: spec.cwd,
								durationMs: 0,
								metadata: {
									tool: spec.managedToolId,
									command: reinstalled,
								},
							});
							return { process: proc, source: "managed" };
						} catch (retryErr) {
							logSessionStart(
								`lsp launch managed force-reinstall failed tool=${spec.managedToolId} error=${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
							);
						}
					}
				}
				// fall through
			}
		}
	}

	// Step 4 — language-native runtime install (go install, gem install, …)
	if (spec.runtimeInstall && (await isOnPath(spec.runtimeInstall.runtimeCommand))) {
		const ok = await spec.runtimeInstall.install();
		if (ok) {
			const retry = spec.runtimeInstall.retryCandidates ?? spec.candidates;
			for (const command of retry) {
				try {
					const proc = await launchLSP(command, spec.args, {
						cwd: spec.cwd,
						env: spec.env,
					});
					return { process: proc, source: "managed" };
				} catch (err) {
					trackRuntimeFailure(err);
					// try next
				}
			}
		}
	}

	if (lastRuntimeFailure) {
		throw lastRuntimeFailure;
	}

	return undefined;
}

function nodeBinCandidates(root: string, baseName: string): string[] {
	const localBase = path.join(root, "node_modules", ".bin", baseName);
	if (process.platform === "win32") {
		return [`${localBase}.cmd`, `${localBase}.exe`, baseName];
	}
	return [localBase, baseName];
}

const ESLINT_CONFIG_FILES = [
	".eslintrc",
	".eslintrc.js",
	".eslintrc.cjs",
	".eslintrc.json",
	".eslintrc.yaml",
	".eslintrc.yml",
	"eslint.config.js",
	"eslint.config.mjs",
	"eslint.config.cjs",
	"eslint.config.ts",
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function packageHasEslintDependency(pkg: Record<string, unknown>): boolean {
	for (const section of [
		"dependencies",
		"devDependencies",
		"peerDependencies",
		"optionalDependencies",
	]) {
		const deps = pkg[section];
		if (isRecord(deps) && Object.hasOwn(deps, "eslint")) {
			return true;
		}
	}
	return false;
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

function rejectHomeRoot(root: string): string | undefined {
	return normalizeRootKey(root) === normalizeRootKey(os.homedir())
		? undefined
		: root;
}

function normalizeSlashKey(value: string): string {
	const normalized = path.resolve(value).replace(/\\/g, "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function piAgentExtensionsRootKey(file: string): string | undefined {
	const dirKey = normalizeSlashKey(path.dirname(path.resolve(file)));
	const marker = "/.pi/agent/extensions";
	const index = dirKey.indexOf(marker);
	if (index === -1) return undefined;
	return dirKey.slice(0, index + marker.length);
}

export const EslintRoot: RootFunction = async (file: string) => {
	let currentDir = path.resolve(path.dirname(file));
	const fsRoot = path.parse(currentDir).root;

	while (true) {
		for (const cfg of ESLINT_CONFIG_FILES) {
			if (await pathExists(path.join(currentDir, cfg))) {
				return rejectHomeRoot(currentDir);
			}
		}

		const pkgPath = path.join(currentDir, "package.json");
		if (await pathExists(pkgPath)) {
			try {
				const pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as unknown;
				if (
					isRecord(pkg) &&
					(pkg.eslintConfig !== undefined || packageHasEslintDependency(pkg))
				) {
					return rejectHomeRoot(currentDir);
				}
			} catch {
				// Invalid package.json is not a positive ESLint signal.
			}

			// Treat package.json as a package boundary. A parent repo-level ESLint setup
			// should not make plain nested JS packages pay the ESLint LSP startup cost.
			return undefined;
		}

		if (currentDir === fsRoot) break;
		const parent = path.dirname(currentDir);
		if (parent === currentDir) break;
		currentDir = parent;
	}

	return undefined;
};

function normalizeRootKey(root: string): string {
	return process.platform === "win32"
		? path.resolve(root).toLowerCase()
		: path.resolve(root);
}

function IgnoreHomeRoot(primary: RootFunction): RootFunction {
	const homeKey = normalizeRootKey(os.homedir());
	return async (file: string): Promise<string | undefined> => {
		const root = await primary(file);
		if (!root) return undefined;
		return normalizeRootKey(root) === homeKey ? undefined : root;
	};
}

function rubyBinCandidates(baseName: string): string[] {
	const candidates: string[] = [];
	const home = os.homedir();
	const isWin = process.platform === "win32";
	const ext = isWin ? ".bat" : "";

	// mise and asdf version managers — same layout on all platforms
	candidates.push(
		path.join(
			home,
			".local",
			"share",
			"mise",
			"installs",
			"ruby",
			"bin",
			`${baseName}${ext}`,
		),
	);
	candidates.push(
		path.join(home, ".asdf", "installs", "ruby", "bin", `${baseName}${ext}`),
	);

	if (isWin) {
		// Ruby installer drops versioned dirs on C: by convention, but the drive
		// and version suffix vary — scan what's actually present instead of hardcoding
		const driveRoot = path.parse(home).root; // e.g. "C:\"
		try {
			const entries = readdirSync(driveRoot);
			for (const entry of entries) {
				if (/^ruby\d/i.test(entry)) {
					candidates.push(
						path.join(driveRoot, entry, "bin", `${baseName}.bat`),
					);
					candidates.push(path.join(driveRoot, entry, "bin", baseName));
				}
			}
		} catch {
			// drive root not readable — skip
		}
	}

	return candidates;
}

type InitializationConfig = Record<string, unknown>;

interface InteractiveServerSpec {
	id: string;
	name: string;
	extensions: readonly string[];
	root: RootFunction;
	language: string;
	command: string | ((root: string) => string);
	args?: string[] | ((root: string) => string[]);
	initialization?:
		| InitializationConfig
		| ((root: string) => InitializationConfig);
}

function createInteractiveServer(spec: InteractiveServerSpec): LSPServerInfo {
	return {
		id: spec.id,
		name: spec.name,
		extensions: spec.extensions,
		root: spec.root,
		availabilityKey:
			typeof spec.command === "string" && isSimpleCommand(spec.command)
				? spec.command
				: undefined,
		async spawn(root) {
			const command =
				typeof spec.command === "function" ? spec.command(root) : spec.command;
			const args =
				typeof spec.args === "function" ? spec.args(root) : spec.args || [];
			// Try to launch directly — no auto-install for language-runtime tools
			// (C#, Java, Swift, etc. require their SDK; cannot npm/pip install them)
			if (
				isSimpleCommand(command) &&
				isDirectLspCommandTemporarilyUnavailable(command)
			) {
				return undefined;
			}
			try {
				const proc = await launchLSP(command, args, { cwd: root });
				const initialization =
					typeof spec.initialization === "function"
						? spec.initialization(root)
						: spec.initialization;
				return { process: proc, source: "direct", initialization };
			} catch (err) {
				if (isCommandNotFoundError(err)) {
					markDirectLspCommandUnavailable(command);
				}
				return undefined;
			}
		},
	};
}

export function PriorityRoot(
	markerGroups: string[][],
	excludePatterns?: string[],
	stopDir?: string,
): RootFunction {
	const resolvers = markerGroups.map((markers) =>
		NearestRoot(markers, excludePatterns, stopDir),
	);
	return async (file: string) => {
		for (const resolve of resolvers) {
			const root = await resolve(file);
			if (root) return root;
		}
		return undefined;
	};
}

export const FileDirRoot: RootFunction = async (file: string) =>
	path.resolve(path.dirname(file));

export function RootWithFallback(
	primary: RootFunction,
	fallback: RootFunction = FileDirRoot,
): RootFunction {
	return async (file: string): Promise<string | undefined> => {
		const primaryRoot = await primary(file);
		if (primaryRoot) return primaryRoot;
		return fallback(file);
	};
}

export function WorkspacePriorityRoot(
	markerGroups: string[][],
	excludePatterns?: string[],
): RootFunction {
	return async (file: string) =>
		PriorityRoot(markerGroups, excludePatterns, process.cwd())(file);
}

// --- Root Detection Helpers ---

// --- Interactive Install Helper ---

/**
 * Walk up the directory tree looking for project root markers.
 *
 * NearestRoot(includePatterns, excludePatterns?) → RootFunction
 *
 * - includePatterns: file/dir names that signal the project root (e.g. ["package.json"])
 * - excludePatterns: if any of these exist in a directory, skip it (e.g. ["node_modules"])
 * - stopDir: walk stops here (defaults to filesystem root; set to project cwd for safety)
 *
 * Equivalent to createRootDetector; exported under both names for clarity.
 */
export function NearestRoot(
	includePatterns: string[],
	excludePatterns?: string[],
	stopDir?: string,
): RootFunction {
	// Per-instance caches — each NearestRoot(markers) call gets its own Map so
	// different servers (e.g. TypeScript vs Go) with different marker sets never
	// share entries. vi.resetModules() in tests resets module state between cases.
	const cache = new Map<string, string>();
	const inFlight = new Map<string, Promise<string | undefined>>();

	return async (file: string): Promise<string | undefined> => {
		// Cache key is the resolved directory — all files in the same dir share a root.
		const startDir = path.resolve(path.dirname(file));
		const dirKey = normalizeMapKey(startDir);

		// Fast path: already resolved for this directory.
		const cached = cache.get(dirKey);
		if (cached !== undefined) return cached;

		// In-flight deduplication: if N parallel pipelines edit files in the same
		// directory simultaneously, only one stat-walk runs; the rest await the same
		// promise. This is the main fix for parallel-turn LSP timeout spikes.
		const flying = inFlight.get(dirKey);
		if (flying) return flying;

		const promise = (async (): Promise<string | undefined> => {
			let currentDir = startDir;
			const fsRoot = path.parse(currentDir).root;
			const stop = stopDir ? path.resolve(stopDir) : fsRoot;

			while (true) {
				if (
					stop !== fsRoot &&
					currentDir.startsWith(stop + path.sep) === false &&
					currentDir !== stop
				) {
					break;
				}

				// Check exclude patterns — skip this dir (but keep walking up)
				if (excludePatterns) {
					let excluded = false;
					for (const pattern of excludePatterns) {
						try {
							await stat(path.join(currentDir, pattern));
							excluded = true;
							break;
						} catch {
							/* not found */
						}
					}
					if (excluded) {
						currentDir = path.dirname(currentDir);
						continue;
					}
				}

				// Check include patterns
				for (const pattern of includePatterns) {
					try {
						await stat(path.join(currentDir, pattern));
						return currentDir;
					} catch {
						/* not found */
					}
				}

				if (currentDir === stop || currentDir === fsRoot) {
					break;
				}

				currentDir = path.dirname(currentDir);
			}

			return undefined;
		})();

		inFlight.set(dirKey, promise);
		try {
			const result = await promise;
			// Only cache successful hits. Undefined results are not cached so that
			// a newly-created root marker (e.g. package.json added mid-session) is
			// detected on the next call.
			if (result !== undefined) cache.set(dirKey, result);
			return result;
		} finally {
			inFlight.delete(dirKey);
		}
	};
}

/** Alias kept for backward compatibility */
export const createRootDetector = NearestRoot;

// --- Runtime Tool Helpers ---

/**
 * Check if a command is available on system PATH.
 *
 * Async (was a blocking `spawnSync("where"/"which")`): runs on the spawn
 * fall-through path (Step 4, runtime-install gate). The shared
 * `isCommandAvailableAsync` spawns the same finder via `safeSpawnAsync` with a
 * 5s timeout, so a stalled finder can no longer freeze the loop. Semantics are
 * preserved: true iff the finder exits 0.
 */
function isOnPath(command: string): Promise<boolean> {
	return isCommandAvailableAsync(command);
}

/**
 * Try to install gopls via `go install`. Resolves true if the install succeeded.
 */
function tryGoInstallGopls(): Promise<boolean> {
	return new Promise((resolve) => {
		const isWindows = process.platform === "win32";
		const proc = spawnSync(
			isWindows ? "go.exe" : "go",
			["install", "golang.org/x/tools/gopls@latest"],
			{ stdio: "ignore", shell: false },
		);
		resolve(proc.status === 0);
	});
}

function tryDotnetToolInstall(tool: string): Promise<boolean> {
	return new Promise((resolve) => {
		mkdirSync(PI_LENS_BIN_DIR, { recursive: true });
		const proc = spawnSync(
			"dotnet",
			["tool", "install", "--tool-path", PI_LENS_BIN_DIR, tool],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false },
		);
		if (proc.status === 0) {
			resolve(true);
			return;
		}

		const stderr = proc.stderr ?? "";
		if (stderr.includes("No NuGet sources are defined or enabled")) {
			logSessionStart(
				`lsp dotnet-install: NuGet sources missing — cannot install ${tool}. ` +
					`Run: dotnet nuget add source https://api.nuget.org/v3/index.json -n nuget.org`,
			);
			resolve(false);
			return;
		}

		const updateProc = spawnSync(
			"dotnet",
			["tool", "update", "--tool-path", PI_LENS_BIN_DIR, tool],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false },
		);
		resolve(updateProc.status === 0);
	});
}

/**
 * Locate tsserver.js — tries local project, then pi-lens managed TypeScript.
 * Returns the path to tsserver.js, or undefined if not found.
 */
async function findTsserverPath(
	root: string,
	allowInstall: boolean | undefined,
): Promise<string | undefined> {
	const fs = await import("node:fs/promises");
	const candidates = [
		path.join(root, "node_modules", "typescript", "lib", "tsserver.js"),
		path.join(
			process.cwd(),
			"node_modules",
			"typescript",
			"lib",
			"tsserver.js",
		),
	];
	for (const p of candidates) {
		try {
			await fs.access(p);
			return p;
		} catch {
			/* not found */
		}
	}
	if (canInstall(allowInstall)) {
		const tscPath = await ensureTool("typescript");
		if (tscPath) {
			for (const p of [
				path.join(
					path.dirname(tscPath),
					"..",
					"typescript",
					"lib",
					"tsserver.js",
				),
				path.join(
					path.dirname(tscPath),
					"..",
					"..",
					"typescript",
					"lib",
					"tsserver.js",
				),
			]) {
				try {
					await fs.access(p);
					return p;
				} catch {
					/* not found */
				}
			}
		}
	}
	return undefined;
}

function dotnetToolCandidates(tool: string): string[] {
	const home = os.homedir();
	return [
		path.join(PI_LENS_BIN_DIR, `${tool}.exe`),
		path.join(PI_LENS_BIN_DIR, tool),
		path.join(home, ".dotnet", "tools", `${tool}.exe`),
		path.join(home, ".dotnet", "tools", tool),
		tool,
	].filter(Boolean);
}

/**
 * Try to install a gem to the pi-lens bin dir. Resolves true if the install succeeded.
 */
async function tryGemInstall(gem: string): Promise<boolean> {
	const { join } = await import("node:path");
	const { homedir } = await import("node:os");
	const binDir = join(homedir(), ".pi-lens", "bin");
	const { mkdir } = await import("node:fs/promises");
	await mkdir(binDir, { recursive: true });

	return new Promise((resolve) => {
		const proc = spawnSync(
			"gem",
			["install", gem, "--bindir", binDir, "--no-document"],
			{ stdio: "ignore", shell: false },
		);
		// Add binDir to PATH so subsequent lookups find the installed gem
		if (proc.status === 0) {
			const sep = process.platform === "win32" ? ";" : ":";
			if (!process.env.PATH?.includes(binDir)) {
				process.env.PATH = `${binDir}${sep}${process.env.PATH ?? ""}`;
			}
		}
		resolve(proc.status === 0);
	});
}

/**
 * Wraps a root function so it returns undefined for files inside a Deno project.
 * Prevents TypeScript LSP from being spawned alongside Deno LSP for the same file,
 * which would produce false diagnostics for Deno-specific APIs.
 */
export function DenoExcludeRoot(primary: RootFunction): RootFunction {
	const denoDetector = createRootDetector(["deno.json", "deno.jsonc"]);
	return async (file: string): Promise<string | undefined> => {
		const denoRoot = await denoDetector(file);
		if (denoRoot) return undefined;
		return primary(file);
	};
}

/**
 * Find the active Python interpreter inside the nearest virtual environment.
 * Search order: VIRTUAL_ENV → CONDA_PREFIX → .venv → venv (all under root).
 * Returns undefined when no venv python binary is found.
 */
export async function detectPythonVenv(
	root: string,
): Promise<string | undefined> {
	const isWin = process.platform === "win32";
	const candidates = [
		process.env.VIRTUAL_ENV,
		process.env.CONDA_PREFIX,
		path.join(root, ".venv"),
		path.join(root, "venv"),
	].filter((v): v is string => Boolean(v));

	for (const venv of candidates) {
		const pythonPath = isWin
			? path.join(venv, "Scripts", "python.exe")
			: path.join(venv, "bin", "python");
		try {
			await access(pythonPath);
			return pythonPath;
		} catch {
			// not found — try next candidate
		}
	}
	return undefined;
}

// --- Server Definitions ---

const JS_TS_LSP_EXTENSIONS = KIND_EXTENSIONS["jsts"].filter(
	(ext) => ext !== ".svelte" && ext !== ".vue",
);

// Marker set used for both the unbounded TypeScriptProjectRoot walk and the
// extension-bounded walk below. Kept in one place so both code paths look
// for the same project signals.
const TS_PROJECT_MARKERS = [
	"package-lock.json",
	"bun.lockb",
	"bun.lock",
	"pnpm-lock.yaml",
	"yarn.lock",
	"package.json",
] as const;

const TypeScriptProjectRoot = IgnoreHomeRoot(
	createRootDetector([...TS_PROJECT_MARKERS]),
);

/**
 * Walk up from the file's directory looking for a TypeScript project marker,
 * but stop at `extensionRootKey` so we never escape the .pi/agent/extensions
 * boundary into a higher-up project (e.g. ~/.pi/agent/package.json which
 * would pull every extension in the directory into one LSP workspace).
 *
 * Returns the nearest directory containing a marker, or undefined if none
 * is found between the file and the extensions root inclusive.
 */
async function findExtensionBoundedRoot(
	file: string,
	extensionRootKey: string,
): Promise<string | undefined> {
	const startDir = path.resolve(path.dirname(file));
	let currentDir = startDir;
	while (true) {
		for (const pattern of TS_PROJECT_MARKERS) {
			try {
				await stat(path.join(currentDir, pattern));
				return currentDir;
			} catch {
				/* not found, try next marker */
			}
		}
		// Stop at or beyond the extensions root — never walk into the
		// pi-agent-wide scope.
		const currentKey = normalizeSlashKey(currentDir);
		if (currentKey === extensionRootKey) return undefined;
		const parent = path.dirname(currentDir);
		if (parent === currentDir) return undefined;
		currentDir = parent;
	}
}

/**
 * Check whether the directory immediately containing the extensions folder
 * (i.e. `.pi/agent/`) holds any TypeScript project marker. This narrowly
 * detects the #123 scenario — pi itself installs a package.json at
 * `~/.pi/agent/` and the user's extension has none of its own — without
 * picking up accidental markers further up the filesystem.
 */
async function hasAgentLevelProjectMarker(
	extensionRootKey: string,
): Promise<boolean> {
	const agentDir = path.dirname(extensionRootKey);
	if (!agentDir || agentDir === extensionRootKey) return false;
	for (const pattern of TS_PROJECT_MARKERS) {
		try {
			await stat(path.join(agentDir, pattern));
			return true;
		} catch {
			/* not found, try next */
		}
	}
	return false;
}

const TypeScriptRoot: RootFunction = DenoExcludeRoot(async (file) => {
	const extensionRootKey = piAgentExtensionsRootKey(file);
	if (extensionRootKey) {
		// Bounded walk so we never adopt a parent (e.g. ~/.pi/agent/) as the
		// LSP root.
		const bounded = await findExtensionBoundedRoot(file, extensionRootKey);
		if (bounded) return bounded;
		// No marker inside the extension boundary. If pi itself has a
		// package.json at ~/.pi/agent/ (the #123 setup), the previous code
		// returned undefined and the LSP silently failed to start. Fall
		// back to a per-file scope so the LSP at least runs.
		if (await hasAgentLevelProjectMarker(extensionRootKey)) {
			return FileDirRoot(file);
		}
		// Truly loose extension file with no project context anywhere
		// relevant — preserve the existing skip behavior (LSP shouldn't
		// analyze a lone .ts file with no package.json above or below).
		return undefined;
	}
	const projectRoot = await TypeScriptProjectRoot(file);
	if (projectRoot) return projectRoot;
	return FileDirRoot(file);
});

export const TypeScriptServer: LSPServerInfo = {
	id: "typescript",
	name: "TypeScript Language Server",
	extensions: JS_TS_LSP_EXTENSIONS,
	autoPropagateDiagnostics: true,
	root: TypeScriptRoot,
	async spawn(root, options) {
		const fs = await import("node:fs/promises");
		let source: "direct" | "managed" = "direct";

		// Find typescript-language-server - prefer local project version
		let lspPath: string | undefined;
		const localLsp = path.join(
			root,
			"node_modules",
			".bin",
			"typescript-language-server",
		);
		const localLspCmd = path.join(
			root,
			"node_modules",
			".bin",
			"typescript-language-server.cmd",
		);

		// Check for local version first (Windows .cmd first, then Unix)
		for (const checkPath of [localLspCmd, localLsp]) {
			try {
				await fs.access(checkPath);
				lspPath = checkPath;
				break;
			} catch {
				/* not found */
			}
		}

		// Fall back to auto-installed version
		if (!lspPath) {
			if (canInstall(options?.allowInstall)) {
				lspPath = await ensureTool("typescript-language-server");
				source = "managed";
			}
			if (!lspPath) {
				return undefined;
			}
		}

		// Find tsserver.js — also try relative to the LSP binary for local installs
		let tsserverPath = await findTsserverPath(root, options?.allowInstall);
		if (!tsserverPath) {
			const localCandidate = path.join(
				path.dirname(lspPath),
				"..",
				"typescript",
				"lib",
				"tsserver.js",
			);
			try {
				await fs.access(localCandidate);
				tsserverPath = localCandidate;
			} catch {
				/* not found */
			}
		}
		if (tsserverPath) source = "managed";

		// Use absolute path and proper environment
		const env = await getToolEnvironment();
		const proc = await launchLSP(lspPath, ["--stdio"], {
			cwd: root,
			env: {
				...env,
				TSSERVER_PATH: tsserverPath,
			},
		});

		return {
			process: proc,
			source,
			initialization: tsserverPath
				? { tsserver: { path: tsserverPath } }
				: undefined,
		};
	},
};

export const DenoServer: LSPServerInfo = {
	id: "deno",
	name: "Deno Language Server",
	extensions: JS_TS_LSP_EXTENSIONS,
	autoPropagateDiagnostics: true,
	root: createRootDetector(["deno.json", "deno.jsonc"]),
	async spawn(root) {
		try {
			const proc = await launchLSP("deno", ["lsp"], { cwd: root });
			return { process: proc, source: "direct" };
		} catch {
			return undefined;
		}
	},
};

export const PythonServer: LSPServerInfo = {
	id: "python",
	name: "Pyright Language Server",
	extensions: KIND_EXTENSIONS["python"],
	root: RootWithFallback(
		createRootDetector([
			".git",
			"pyproject.toml",
			"setup.py",
			"setup.cfg",
			"requirements.txt",
			"Pipfile",
			"poetry.lock",
		]),
	),
	async spawn(root, options) {
		const env = await getToolEnvironment();
		let source: "direct" | "managed" | "package-manager" = "direct";

		// openFilesOnly: true — analyse only open files rather than the full workspace.
		// Avoids the 5–14 s cold-start on large projects caused by workspace-wide
		// analysis on startup. Deep type checking is still available via the standalone
		// pyright CLI runner that runs in parallel.
		const pyrightInit = (pythonPath?: string): Record<string, unknown> => ({
			...(pythonPath ? { pythonPath } : {}),
			openFilesOnly: true,
		});

		// Prefer pyright-langserver; basedpyright-langserver is a drop-in fork with
		// the same --stdio protocol and additional rules (e.g. reportUnusedExpression).
		const localCandidates = [
			...nodeBinCandidates(root, "pyright-langserver"),
			...nodeBinCandidates(root, "basedpyright-langserver"),
		];
		const direct = await resolveAndLaunch(
			{ candidates: localCandidates, args: ["--stdio"], cwd: root, env },
			false,
		);
		if (direct) {
			const pythonPath = await detectPythonVenv(root);
			return {
				process: direct.process,
				source: direct.source,
				initialization: pyrightInit(pythonPath),
			};
		}

		if (!canInstall(options?.allowInstall)) {
			return undefined;
		}

		const pyrightPath = await ensureTool("pyright");
		if (!pyrightPath) return undefined;
		source = "managed";

		const binDir = path.dirname(pyrightPath);
		const isWindows = process.platform === "win32";
		const managedCandidates = isWindows
			? [
					path.join(binDir, "pyright-langserver.cmd"),
					path.join(binDir, "pyright-langserver"),
					"pyright-langserver",
				]
			: [path.join(binDir, "pyright-langserver"), "pyright-langserver"];

		const resolved = await resolveAndLaunch(
			{ candidates: managedCandidates, args: ["--stdio"], cwd: root, env },
			false,
		);
		if (!resolved) return undefined;

		const pythonPath = await detectPythonVenv(root);
		return {
			process: resolved.process,
			source,
			initialization: pyrightInit(pythonPath),
		};
	},
};

export const PythonJediServer: LSPServerInfo = {
	id: "python-jedi",
	name: "Jedi Language Server",
	extensions: KIND_EXTENSIONS["python"],
	root: RootWithFallback(
		createRootDetector([
			".git",
			"pyproject.toml",
			"setup.py",
			"setup.cfg",
			"requirements.txt",
			"Pipfile",
			"poetry.lock",
		]),
	),
	async spawn(root) {
		try {
			const proc = await launchLSP("jedi-language-server", [], { cwd: root });
			const pythonPath = await detectPythonVenv(root);
			const initialization: Record<string, unknown> = pythonPath
				? { workspace: { environmentPath: pythonPath } }
				: {};
			return { process: proc, source: "direct", initialization };
		} catch {
			return undefined;
		}
	},
};

export const GoServer: LSPServerInfo = {
	id: "go",
	name: "gopls",
	extensions: KIND_EXTENSIONS["go"],
	root: RootWithFallback(
		WorkspacePriorityRoot([["go.work"], ["go.mod", "go.sum"], [".git"]]),
	),
	async spawn(root, options) {
		const result = await resolveAndLaunch(
			{
				candidates: ["gopls"],
				args: [],
				cwd: root,
				runtimeInstall: {
					runtimeCommand: "go",
					install: tryGoInstallGopls,
				},
			},
			options?.allowInstall,
		);
		if (!result) return undefined;
		return { ...result, initialization: { ui: { semanticTokens: true } } };
	},
};

async function hasWorkspaceSection(cargoPath: string): Promise<boolean> {
	try {
		const { readFile } = await import("node:fs/promises");
		const content = await readFile(cargoPath, "utf-8");
		return /^\s*\[workspace\]/m.test(content);
	} catch {
		return false;
	}
}

function RustWorkspaceRoot(): RootFunction {
	const crateRoot = createRootDetector(["Cargo.toml", "Cargo.lock"]);
	return async (file: string): Promise<string | undefined> => {
		const root = await crateRoot(file);
		if (!root) return undefined;
		let current = root;
		const fsRoot = path.parse(current).root;
		while (true) {
			const parent = path.dirname(current);
			if (parent === current || parent === fsRoot) break;
			const parentCargo = path.join(parent, "Cargo.toml");
			if (await hasWorkspaceSection(parentCargo)) {
				return parent;
			}
			current = parent;
		}
		return root;
	};
}

export const RustServer: LSPServerInfo = {
	id: "rust",
	name: "rust-analyzer",
	extensions: KIND_EXTENSIONS["rust"],
	// No FileDirRoot fallback (#201): rust-analyzer is a heavy workspace server
	// that is useless without a Cargo manifest. With the fallback, every .rs file
	// written before a Cargo.toml exists resolved to its OWN directory as the
	// root, and since clients dedup by `${serverId}:${root}`, each directory
	// spawned a separate rust-analyzer (one per file/dir during scaffolding).
	// Returning undefined here skips the spawn until a Cargo.toml gives a stable,
	// shared crate root — then all files share one server.
	root: RustWorkspaceRoot(),
	async spawn(root, options) {
		// Prefer rustup-installed rust-analyzer; fall back to GitHub-downloaded managed copy
		const result = await resolveAndLaunch(
			{
				candidates: ["rust-analyzer"],
				args: [],
				cwd: root,
				managedToolId: "rust-analyzer",
			},
			options?.allowInstall,
		);
		if (!result) return undefined;
		return {
			...result,
			initialization: {
				cargo: { buildScripts: { enable: true } },
				procMacro: { enable: true },
				diagnostics: { enable: true },
			},
		};
	},
};

export const RubyServer: LSPServerInfo = {
	id: "ruby",
	name: "Ruby LSP",
	extensions: KIND_EXTENSIONS["ruby"],
	root: RootWithFallback(
		PriorityRoot([["Gemfile", ".ruby-version"], [".git"]]),
	),
	// Ruby LSP may need extra time to finish composed-bundle setup before it can
	// answer initialize/documentSymbol on cold start.
	initializeTimeoutMs: 30_000,
	clientWaitTimeoutMs: 30_000,
	async spawn(root, options) {
		// Try ruby-lsp first, then solargraph, then rubocop --lsp
		// Each has different args so we can't use a single resolveAndLaunch call
		const rubylsp = await resolveAndLaunch(
			{
				candidates: ["ruby-lsp", ...rubyBinCandidates("ruby-lsp")],
				args: [],
				cwd: root,
				runtimeInstall: {
					runtimeCommand: "gem",
					install: () => tryGemInstall("ruby-lsp"),
					retryCandidates: ["ruby-lsp", ...rubyBinCandidates("ruby-lsp")],
				},
			},
			options?.allowInstall,
		);
		if (rubylsp) return rubylsp;

		// Solargraph fallback
		const solargraph = await resolveAndLaunch(
			{
				candidates: ["solargraph", ...rubyBinCandidates("solargraph")],
				args: ["stdio"],
				cwd: root,
			},
			false, // don't install solargraph — already tried gem install above
		);
		if (solargraph) return solargraph;

		// rubocop --lsp fallback
		return resolveAndLaunch(
			{
				candidates: ["rubocop", ...rubyBinCandidates("rubocop")],
				args: ["--lsp"],
				cwd: root,
			},
			false,
		);
	},
};

export const RubySolargraphServer: LSPServerInfo = {
	id: "ruby-solargraph",
	name: "Solargraph",
	extensions: KIND_EXTENSIONS["ruby"],
	root: RootWithFallback(
		PriorityRoot([["Gemfile", ".ruby-version"], [".git"]]),
	),
	async spawn(root) {
		for (const command of ["solargraph", ...rubyBinCandidates("solargraph")]) {
			try {
				const proc = await launchLSP(command, ["stdio"], { cwd: root });
				return { process: proc, source: "direct" };
			} catch {
				// try next candidate
			}
		}
		return undefined;
	},
};

export const PHPServer: LSPServerInfo = {
	id: "php",
	name: "Intelephense",
	extensions: KIND_EXTENSIONS["php"],
	root: RootWithFallback(
		createRootDetector(["composer.json", "composer.lock"]),
	),
	async spawn(root, options) {
		const result = await resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "intelephense"),
				args: ["--stdio"],
				cwd: root,
				managedToolId: "intelephense",
			},
			options?.allowInstall,
		);
		if (!result) return undefined;
		return {
			...result,
			initialization: {
				storagePath: path.join(getGlobalPiLensDir(), "intelephense"),
			},
		};
	},
};

export const CSharpServer: LSPServerInfo = {
	id: "csharp",
	name: "csharp-ls",
	extensions: KIND_EXTENSIONS["csharp"],
	// NOTE (#201): this has the same per-file-dir fallback trap as rust did, but
	// can't be fixed the same way yet — `createRootDetector` matches markers by
	// EXACT filename (`stat(dir/.csproj)`), so `.sln`/`.csproj`/`.slnx` never
	// match a real `Foo.csproj`/`Foo.sln`. C# root detection therefore relies
	// entirely on the FileDirRoot fallback today; removing it would disable C#.
	// Fixing this needs extension/glob marker support first (tracked on #201).
	root: RootWithFallback(createRootDetector([".sln", ".csproj", ".slnx"])),
	async spawn(root, options) {
		const candidates = dotnetToolCandidates("csharp-ls");

		return resolveAndLaunch(
			{
				candidates,
				args: [],
				cwd: root,
				runtimeInstall: {
					runtimeCommand: "dotnet",
					install: () => tryDotnetToolInstall("csharp-ls"),
					retryCandidates: candidates,
				},
			},
			options?.allowInstall,
		);
	},
};

export const OmniSharpServer = createInteractiveServer({
	id: "omnisharp",
	name: "OmniSharp",
	extensions: KIND_EXTENSIONS["csharp"],
	root: createRootDetector([".sln", ".csproj", ".slnx"]),
	language: "csharp",
	command: "OmniSharp",
	args: ["--languageserver"],
});

export const FSharpServer = createInteractiveServer({
	id: "fsharp",
	name: "FSAutocomplete",
	extensions: KIND_EXTENSIONS["fsharp"],
	root: createRootDetector([".sln", ".fsproj"]),
	language: "fsharp",
	command: "fsautocomplete",
});

export const JavaServer = createInteractiveServer({
	id: "java",
	name: "JDT Language Server",
	extensions: KIND_EXTENSIONS["java"],
	root: RootWithFallback(
		createRootDetector(["pom.xml", "build.gradle", ".classpath"]),
	),
	language: "java",
	command: () => process.env.JDTLS_PATH || "jdtls",
});

export const KotlinServer: LSPServerInfo = {
	id: "kotlin",
	name: "Kotlin Language Server",
	extensions: KIND_EXTENSIONS["kotlin"],
	root: RootWithFallback(
		createRootDetector(["build.gradle.kts", "build.gradle", "pom.xml"]),
	),
	async spawn(root, options) {
		// Prefer the newer official Kotlin LSP CLI when available, but keep
		// compatibility with the older fwcd kotlin-language-server command.
		return resolveAndLaunch(
			{
				candidates: ["kotlin-lsp", "kotlin-language-server"],
				args: [],
				cwd: root,
			},
			options?.allowInstall,
		);
	},
};

export const SwiftServer = createInteractiveServer({
	id: "swift",
	name: "SourceKit-LSP",
	extensions: KIND_EXTENSIONS["swift"],
	root: createRootDetector(["Package.swift"]),
	language: "swift",
	command: "sourcekit-lsp",
});

export const DartServer = createInteractiveServer({
	id: "dart",
	name: "Dart Analysis Server",
	extensions: KIND_EXTENSIONS["dart"],
	root: RootWithFallback(createRootDetector(["pubspec.yaml"])),
	language: "dart",
	command: "dart",
	args: ["language-server", "--protocol=lsp"],
});

export const LuaServer = createInteractiveServer({
	id: "lua",
	name: "Lua Language Server",
	extensions: KIND_EXTENSIONS["lua"],
	root: createRootDetector([".luarc.json", ".luacheckrc"]),
	language: "lua",
	command: "lua-language-server",
});

export const CppServer = createInteractiveServer({
	id: "cpp",
	name: "clangd",
	extensions: KIND_EXTENSIONS["cxx"],
	root: RootWithFallback(
		createRootDetector([
			"compile_commands.json",
			".clangd",
			"CMakeLists.txt",
			"Makefile",
		]),
	),
	language: "cpp",
	command: "clangd",
	args: ["--background-index"],
});

export const ZigServer: LSPServerInfo = {
	id: "zig",
	name: "ZLS",
	extensions: KIND_EXTENSIONS["zig"],
	root: RootWithFallback(createRootDetector(["build.zig"])),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: ["zls"],
				args: [],
				cwd: root,
				managedToolId: "zls",
			},
			options?.allowInstall,
		);
	},
};

export const HaskellServer = createInteractiveServer({
	id: "haskell",
	name: "Haskell Language Server",
	extensions: KIND_EXTENSIONS["haskell"],
	root: createRootDetector(["stack.yaml", "cabal.project", "*.cabal"]),
	language: "haskell",
	command: "haskell-language-server-wrapper",
	args: ["--lsp"],
});

export const ElixirServer = createInteractiveServer({
	id: "elixir",
	name: "ElixirLS",
	extensions: KIND_EXTENSIONS["elixir"],
	root: RootWithFallback(createRootDetector(["mix.exs"])),
	language: "elixir",
	command: "elixir-ls",
});

export const GleamServer = createInteractiveServer({
	id: "gleam",
	name: "Gleam LSP",
	extensions: KIND_EXTENSIONS["gleam"],
	root: RootWithFallback(createRootDetector(["gleam.toml"])),
	language: "gleam",
	command: "gleam",
	args: ["lsp"],
});

export const OCamlServer = createInteractiveServer({
	id: "ocaml",
	name: "ocamllsp",
	extensions: KIND_EXTENSIONS["ocaml"],
	root: createRootDetector(["dune-project", "opam"]),
	language: "ocaml",
	command: "ocamllsp",
});

export const ClojureServer = createInteractiveServer({
	id: "clojure",
	name: "Clojure LSP",
	extensions: KIND_EXTENSIONS["clojure"],
	root: createRootDetector(["deps.edn", "project.clj"]),
	language: "clojure",
	command: "clojure-lsp",
});

export const TerraformServer: LSPServerInfo = {
	id: "terraform",
	name: "Terraform LSP",
	extensions: KIND_EXTENSIONS["terraform"],
	root: RootWithFallback(
		createRootDetector([".terraform.lock.hcl", ".terraform"]),
	),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: ["terraform-ls"],
				args: ["serve"],
				cwd: root,
				managedToolId: "terraform-ls",
			},
			options?.allowInstall,
		);
	},
};

export const NixServer = createInteractiveServer({
	id: "nix",
	name: "nixd",
	extensions: KIND_EXTENSIONS["nix"],
	root: createRootDetector(["flake.nix"]),
	language: "nix",
	command: "nixd",
});

export const BashServer: LSPServerInfo = {
	id: "bash",
	name: "Bash Language Server",
	extensions: [".bash", ".sh", ".zsh"],
	root: FileDirRoot,
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "bash-language-server"),
				args: ["start"],
				cwd: root,
				managedToolId: "bash-language-server",
			},
			options?.allowInstall,
		);
	},
};

export const DockerServer: LSPServerInfo = {
	id: "docker",
	name: "Dockerfile Language Server",
	extensions: [".dockerfile", "Dockerfile"],
	root: RootWithFallback(
		PriorityRoot([
			[
				"docker-compose.yml",
				"docker-compose.yaml",
				"compose.yml",
				"compose.yaml",
			],
			[".git"],
		]),
	),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "docker-langserver"),
				args: ["--stdio"],
				cwd: root,
				managedToolId: "dockerfile-language-server-nodejs",
			},
			options?.allowInstall,
		);
	},
};

export const YamlServer: LSPServerInfo = {
	id: "yaml",
	name: "YAML Language Server",
	extensions: KIND_EXTENSIONS["yaml"],
	root: RootWithFallback(
		PriorityRoot([
			[".yamllint", "yamllint.yml", "yamllint.yaml", "pyproject.toml"],
			[".git"],
		]),
	),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "yaml-language-server"),
				args: ["--stdio"],
				cwd: root,
				managedToolId: "yaml-language-server",
			},
			options?.allowInstall,
		);
	},
};

export const JsonServer: LSPServerInfo = {
	id: "json",
	name: "VSCode JSON Language Server",
	extensions: KIND_EXTENSIONS["json"],
	root: RootWithFallback(
		WorkspacePriorityRoot([
			["package.json", "tsconfig.json", "jsconfig.json"],
			[".git"],
		]),
	),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: ["vscode-json-language-server"],
				args: ["--stdio"],
				cwd: root,
				managedToolId: "vscode-json-language-server",
			},
			options?.allowInstall,
		);
	},
};

export const HtmlServer: LSPServerInfo = {
	id: "html",
	name: "VSCode HTML Language Server",
	extensions: KIND_EXTENSIONS["html"],
	root: RootWithFallback(
		IgnoreHomeRoot(
			PriorityRoot([["package.json", "index.html", "vite.config.ts"]]),
		),
	),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "vscode-html-language-server"),
				args: ["--stdio"],
				cwd: root,
				managedToolId: "vscode-html-languageserver-bin",
			},
			options?.allowInstall,
		);
	},
};

export const TomlServer: LSPServerInfo = {
	id: "toml",
	name: "Taplo",
	extensions: KIND_EXTENSIONS["toml"],
	root: RootWithFallback(
		PriorityRoot([["pyproject.toml", "Cargo.toml", "taplo.toml"], [".git"]]),
	),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: ["taplo"],
				args: ["lsp", "stdio"],
				cwd: root,
				managedToolId: "taplo",
			},
			options?.allowInstall,
		);
	},
};

export const PrismaServer: LSPServerInfo = {
	id: "prisma",
	name: "Prisma Language Server",
	extensions: KIND_EXTENSIONS["prisma"],
	root: RootWithFallback(
		createRootDetector(["prisma/schema.prisma", "schema.prisma"]),
	),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "prisma-language-server"),
				args: ["--stdio"],
				cwd: root,
				managedToolId: "@prisma/language-server",
			},
			options?.allowInstall,
		);
	},
};

// --- Web Framework & Styling Servers ---

export const VueServer: LSPServerInfo = {
	id: "vue",
	name: "Vue Language Server",
	extensions: [".vue"],
	root: RootWithFallback(
		IgnoreHomeRoot(
			createRootDetector([
				"package.json",
				"package-lock.json",
				"bun.lockb",
				"bun.lock",
				"pnpm-lock.yaml",
				"yarn.lock",
			]),
		),
	),
	async spawn(root, options) {
		const tsserverPath = await findTsserverPath(root, options?.allowInstall);

		// Vue Language Server needs Vue dependencies installed to resolve types.
		// Without node_modules, navigation requests will timeout or return empty.
		const hasPackageJson = existsSync(path.join(root, "package.json"));
		const hasNodeModules = existsSync(path.join(root, "node_modules"));
		if (hasPackageJson && !hasNodeModules) {
			logSessionStart(
				`lsp vue: node_modules missing in ${root} — Vue navigation may be limited. ` +
					`Run: npm install (or pnpm/yarn install) in this project.`,
			);
		}

		const proc = await resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "vue-language-server"),
				args: ["--stdio"],
				cwd: root,
				managedToolId: "@vue/language-server",
			},
			options?.allowInstall,
		);
		if (!proc) return undefined;
		return {
			process: proc.process,
			source: proc.source,
			initialization: tsserverPath
				? { typescript: { tsdk: path.dirname(tsserverPath) } }
				: undefined,
		};
	},
};

export const SvelteServer: LSPServerInfo = {
	id: "svelte",
	name: "Svelte Language Server",
	extensions: [".svelte"],
	root: RootWithFallback(
		IgnoreHomeRoot(
			createRootDetector([
				"package.json",
				"package-lock.json",
				"bun.lockb",
				"bun.lock",
				"pnpm-lock.yaml",
				"yarn.lock",
			]),
		),
	),
	async spawn(root, options) {
		const tsserverPath = await findTsserverPath(root, options?.allowInstall);
		const proc = await resolveAndLaunch(
			{
				candidates: [
					...nodeBinCandidates(root, "svelteserver"),
					...nodeBinCandidates(root, "svelte-language-server"),
				],
				args: ["--stdio"],
				cwd: root,
				managedToolId: "svelte-language-server",
			},
			options?.allowInstall,
		);
		if (!proc) return undefined;
		return {
			process: proc.process,
			source: proc.source,
			initialization: tsserverPath
				? { typescript: { tsdk: path.dirname(tsserverPath) } }
				: undefined,
		};
	},
};

export const ESLintServer: LSPServerInfo = {
	id: "eslint",
	name: "ESLint Language Server",
	// Note: .ts/.tsx handled by TypeScript LSP + Biome
	extensions: [".js", ".jsx", ".svelte", ".vue"],
	root: EslintRoot,
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "vscode-eslint-language-server"),
				args: ["--stdio"],
				cwd: root,
				managedToolId: "vscode-langservers-extracted",
			},
			options?.allowInstall,
		);
	},
};

export const CssServer: LSPServerInfo = {
	id: "css",
	name: "CSS Language Server",
	extensions: KIND_EXTENSIONS["css"],
	root: RootWithFallback(
		IgnoreHomeRoot(
			PriorityRoot([
				[
					"package.json",
					"postcss.config.js",
					"tailwind.config.js",
					"vite.config.ts",
				],
			]),
		),
	),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "vscode-css-language-server"),
				args: ["--stdio"],
				cwd: root,
				managedToolId: "vscode-css-languageserver",
			},
			options?.allowInstall,
		);
	},
};

// --- Registry ---

export const LSP_SERVERS: LSPServerInfo[] = [
	TypeScriptServer,
	DenoServer,
	PythonServer, // pyright / basedpyright — preferred; openFilesOnly avoids cold-start
	PythonJediServer, // fallback when neither pyright nor basedpyright is available
	GoServer,
	RustServer,
	RubyServer,
	PHPServer,
	// PowerShellServer — not included; no viable LSP binary, coverage notice fires instead
	CSharpServer,
	OmniSharpServer,
	FSharpServer,
	JavaServer,
	KotlinServer,
	SwiftServer,
	DartServer,
	LuaServer,
	CppServer,
	ZigServer,
	HaskellServer,
	ElixirServer,
	GleamServer,
	OCamlServer,
	ClojureServer,
	TerraformServer,
	NixServer,
	BashServer,
	DockerServer,
	YamlServer,
	JsonServer,
	HtmlServer,
	TomlServer,
	PrismaServer,
	// Web frameworks & styling
	VueServer,
	SvelteServer,
	ESLintServer,
	CssServer,
];

/**
 * Get server for a file extension
 */
export function getServerForExtension(ext: string): LSPServerInfo | undefined {
	return LSP_SERVERS.find((server) => server.extensions.includes(ext));
}

/**
 * Get server by ID
 */
export function getServerById(id: string): LSPServerInfo | undefined {
	return LSP_SERVERS.find((server) => server.id === id);
}

/**
 * Get all servers for a file (may have multiple matches)
 */
export function getServersForFile(filePath: string): LSPServerInfo[] {
	const ext = path.extname(filePath).toLowerCase();
	return LSP_SERVERS.filter((server) => server.extensions.includes(ext));
}
