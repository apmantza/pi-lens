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
import { access, appendFile, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureTool, getToolEnvironment } from "../installer/index.js";
import { logLatency } from "../latency-logger.js";
import { type LSPProcess, launchLSP } from "./launch.js";

// --- Types ---

export type RootFunction = (file: string) => Promise<string | undefined>;

export interface LSPSpawnOptions {
	allowInstall?: boolean;
}

export interface LSPServerInfo {
	id: string;
	name: string;
	extensions: string[];
	root: RootFunction;
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

const SESSIONSTART_LOG_DIR = path.join(os.homedir(), ".pi-lens");
const SESSIONSTART_LOG = path.join(SESSIONSTART_LOG_DIR, "sessionstart.log");
const PI_LENS_BIN_DIR = path.join(os.homedir(), ".pi-lens", "bin");

function logSessionStart(message: string): void {
	const line = `[${new Date().toISOString()}] ${message}\n`;
	void mkdir(SESSIONSTART_LOG_DIR, { recursive: true })
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
				// fall through
			}
		}
	}

	// Step 4 — language-native runtime install (go install, gem install, …)
	if (spec.runtimeInstall && isOnPath(spec.runtimeInstall.runtimeCommand)) {
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
	extensions: string[];
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
		async spawn(root) {
			const command =
				typeof spec.command === "function" ? spec.command(root) : spec.command;
			const args =
				typeof spec.args === "function" ? spec.args(root) : spec.args || [];
			// Try to launch directly — no auto-install for language-runtime tools
			// (C#, Java, Swift, etc. require their SDK; cannot npm/pip install them)
			try {
				const proc = await launchLSP(command, args, { cwd: root });
				const initialization =
					typeof spec.initialization === "function"
						? spec.initialization(root)
						: spec.initialization;
				return { process: proc, source: "direct", initialization };
			} catch {
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
	return async (file: string): Promise<string | undefined> => {
		let currentDir = path.resolve(path.dirname(file));
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
	};
}

/** Alias kept for backward compatibility */
export const createRootDetector = NearestRoot;

// --- Runtime Tool Helpers ---

/**
 * Check if a command is available on system PATH (synchronous, no process spawn overhead).
 */
function isOnPath(command: string): boolean {
	const isWindows = process.platform === "win32";
	const result = spawnSync(isWindows ? "where" : "which", [command], {
		stdio: "ignore",
		shell: false,
	});
	return result.status === 0;
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

export const TypeScriptServer: LSPServerInfo = {
	id: "typescript",
	name: "TypeScript Language Server",
	extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
	autoPropagateDiagnostics: true,
	root: DenoExcludeRoot(
		RootWithFallback(
			IgnoreHomeRoot(
				createRootDetector([
					"package-lock.json",
					"bun.lockb",
					"bun.lock",
					"pnpm-lock.yaml",
					"yarn.lock",
					"package.json",
				]),
			),
		),
	),
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
	extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
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
	extensions: [".py", ".pyi"],
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

		const localCandidates = nodeBinCandidates(root, "pyright-langserver");
		const direct = await resolveAndLaunch(
			{ candidates: localCandidates, args: ["--stdio"], cwd: root, env },
			false,
		);
		if (direct) {
			const pythonPath = await detectPythonVenv(root);
			return {
				process: direct.process,
				source: direct.source,
				initialization: pythonPath ? { pythonPath } : {},
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
			initialization: pythonPath ? { pythonPath } : {},
		};
	},
};

export const PythonPylspServer: LSPServerInfo = {
	id: "python-pylsp",
	name: "Python LSP Server (pylsp)",
	extensions: [".py", ".pyi"],
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
			const proc = await launchLSP("pylsp", [], { cwd: root });
			const pythonPath = await detectPythonVenv(root);
			const initialization: Record<string, unknown> = pythonPath
				? { pylsp: { plugins: { jedi: { environment: pythonPath } } } }
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
	extensions: [".go"],
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
	extensions: [".rs"],
	root: RootWithFallback(RustWorkspaceRoot()),
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
	extensions: [".rb", ".rake", ".gemspec", ".ru"],
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
	extensions: [".rb", ".rake", ".gemspec", ".ru"],
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
	extensions: [".php"],
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
				storagePath: path.join(os.homedir(), ".pi-lens", "intelephense"),
			},
		};
	},
};

export const CSharpServer: LSPServerInfo = {
	id: "csharp",
	name: "csharp-ls",
	extensions: [".cs"],
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
	extensions: [".cs"],
	root: createRootDetector([".sln", ".csproj", ".slnx"]),
	language: "csharp",
	command: "OmniSharp",
	args: ["--languageserver"],
});

export const FSharpServer = createInteractiveServer({
	id: "fsharp",
	name: "FSAutocomplete",
	extensions: [".fs", ".fsi", ".fsx"],
	root: createRootDetector([".sln", ".fsproj"]),
	language: "fsharp",
	command: "fsautocomplete",
});

export const JavaServer = createInteractiveServer({
	id: "java",
	name: "JDT Language Server",
	extensions: [".java"],
	root: RootWithFallback(
		createRootDetector(["pom.xml", "build.gradle", ".classpath"]),
	),
	language: "java",
	command: () => process.env.JDTLS_PATH || "jdtls",
});

export const KotlinServer: LSPServerInfo = {
	id: "kotlin",
	name: "Kotlin Language Server",
	extensions: [".kt", ".kts"],
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
	extensions: [".swift"],
	root: createRootDetector(["Package.swift"]),
	language: "swift",
	command: "sourcekit-lsp",
});

export const DartServer = createInteractiveServer({
	id: "dart",
	name: "Dart Analysis Server",
	extensions: [".dart"],
	root: RootWithFallback(createRootDetector(["pubspec.yaml"])),
	language: "dart",
	command: "dart",
	args: ["language-server", "--protocol=lsp"],
});

export const LuaServer = createInteractiveServer({
	id: "lua",
	name: "Lua Language Server",
	extensions: [".lua"],
	root: createRootDetector([".luarc.json", ".luacheckrc"]),
	language: "lua",
	command: "lua-language-server",
});

export const CppServer = createInteractiveServer({
	id: "cpp",
	name: "clangd",
	extensions: [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp"],
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
	extensions: [".zig", ".zon"],
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
	extensions: [".hs", ".lhs"],
	root: createRootDetector(["stack.yaml", "cabal.project", "*.cabal"]),
	language: "haskell",
	command: "haskell-language-server-wrapper",
	args: ["--lsp"],
});

export const ElixirServer = createInteractiveServer({
	id: "elixir",
	name: "ElixirLS",
	extensions: [".ex", ".exs"],
	root: RootWithFallback(createRootDetector(["mix.exs"])),
	language: "elixir",
	command: "elixir-ls",
});

export const GleamServer = createInteractiveServer({
	id: "gleam",
	name: "Gleam LSP",
	extensions: [".gleam"],
	root: RootWithFallback(createRootDetector(["gleam.toml"])),
	language: "gleam",
	command: "gleam",
	args: ["lsp"],
});

export const OCamlServer = createInteractiveServer({
	id: "ocaml",
	name: "ocamllsp",
	extensions: [".ml", ".mli"],
	root: createRootDetector(["dune-project", "opam"]),
	language: "ocaml",
	command: "ocamllsp",
});

export const ClojureServer = createInteractiveServer({
	id: "clojure",
	name: "Clojure LSP",
	extensions: [".clj", ".cljs", ".cljc", ".edn"],
	root: createRootDetector(["deps.edn", "project.clj"]),
	language: "clojure",
	command: "clojure-lsp",
});

export const TerraformServer: LSPServerInfo = {
	id: "terraform",
	name: "Terraform LSP",
	extensions: [".tf", ".tfvars"],
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
	extensions: [".nix"],
	root: createRootDetector(["flake.nix"]),
	language: "nix",
	command: "nixd",
});

export const BashServer: LSPServerInfo = {
	id: "bash",
	name: "Bash Language Server",
	extensions: [".sh", ".bash", ".zsh"],
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
	extensions: [".yaml", ".yml"],
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
	extensions: [".json", ".jsonc"],
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
	extensions: [".html", ".htm"],
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
	extensions: [".toml"],
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
	extensions: [".prisma"],
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
	extensions: [".js", ".jsx", ".vue", ".svelte"], // Note: .ts/.tsx handled by TypeScript LSP + Biome
	root: IgnoreHomeRoot(
		createRootDetector([
			".eslintrc",
			".eslintrc.json",
			".eslintrc.js",
			"eslint.config.js",
			"eslint.config.mjs",
			"package.json",
		]),
	),
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
	extensions: [".css", ".scss", ".sass", ".less"],
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
	PythonServer,
	PythonPylspServer,
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
