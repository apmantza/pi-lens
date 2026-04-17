/**
 * LSP Server Definitions for pi-lens
 *
 * Defines 40+ language servers with:
 * - Root detection (monorepo support)
 * - Auto-installation strategies
 * - Platform-specific handling
 */

import { appendFile, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureTool, getToolEnvironment } from "../installer/index.js";
import { logLatency } from "../latency-logger.js";
import {
	type LSPProcess,
	launchLSP,
} from "./launch.js";

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
	return msg.includes("not found") || msg.includes("ENOENT") || msg.includes("not recognized");
}

const SESSIONSTART_LOG_DIR = path.join(os.homedir(), ".pi-lens");
const SESSIONSTART_LOG = path.join(SESSIONSTART_LOG_DIR, "sessionstart.log");

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
): Promise<{ process: LSPProcess; source: "direct" | "managed" | "package-manager" } | undefined> {
	const toolLabel = spec.managedToolId ?? spec.candidates[spec.candidates.length - 1] ?? "unknown";
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
			const proc = await launchLSP(command, spec.args, { cwd: spec.cwd, env: spec.env });
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
		logSessionStart(`lsp launch ensure-tool start tool=${spec.managedToolId} cwd=${spec.cwd}`);
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
				const proc = await launchLSP(installed, spec.args, { cwd: spec.cwd, env: spec.env });
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
					const proc = await launchLSP(command, spec.args, { cwd: spec.cwd, env: spec.env });
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
		return [
			`${localBase}.cmd`,
			`${localBase}.ps1`,
			`${localBase}.exe`,
			localBase,
			baseName,
		];
	}
	return [localBase, baseName];
}

function rubyBinCandidates(baseName: string): string[] {
	const candidates: string[] = [];
	const userProfile = process.env.USERPROFILE;
	if (userProfile) {
		candidates.push(
			path.join(
				userProfile,
				".local",
				"share",
				"mise",
				"installs",
				"ruby",
				"bin",
				`${baseName}.bat`,
			),
		);
		candidates.push(
			path.join(
				userProfile,
				".asdf",
				"installs",
				"ruby",
				"bin",
				`${baseName}.bat`,
			),
		);
	}
	candidates.push(path.join("C:\\Ruby34-x64", "bin", `${baseName}.bat`));
	candidates.push(path.join("C:\\Ruby33-x64", "bin", `${baseName}.bat`));
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
	initialization?: InitializationConfig | ((root: string) => InitializationConfig);
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
				typeof spec.args === "function"
					? spec.args(root)
					: spec.args || [];
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

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

// --- Server Definitions ---

export const TypeScriptServer: LSPServerInfo = {
	id: "typescript",
	name: "TypeScript Language Server",
	extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
	root: createRootDetector([
		"package-lock.json",
		"bun.lockb",
		"bun.lock",
		"pnpm-lock.yaml",
		"yarn.lock",
		"package.json",
	]),
	async spawn(root, options) {
		const path = await import("node:path");
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

		// Find tsserver.js path (needed for TypeScript LSP initialization)
		// Check relative to the LSP path first, then project root
		let tsserverPath: string | undefined;
		const tsserverCandidates = [
			// Relative to LSP binary (for locally installed)
			path.join(
				path.dirname(lspPath),
				"..",
				"typescript",
				"lib",
				"tsserver.js",
			),
			// Project root
			path.join(root, "node_modules", "typescript", "lib", "tsserver.js"),
			// Current working directory
			path.join(
				process.cwd(),
				"node_modules",
				"typescript",
				"lib",
				"tsserver.js",
			),
		];

		for (const checkPath of tsserverCandidates) {
			try {
				await fs.access(checkPath);
				tsserverPath = checkPath;
				break;
			} catch {
				/* not found */
			}
		}

		if (!tsserverPath && canInstall(options?.allowInstall)) {
			const tscPath = await ensureTool("typescript");
			if (tscPath) {
				const managedTsserverCandidates = [
					path.join(path.dirname(tscPath), "..", "typescript", "lib", "tsserver.js"),
					path.join(path.dirname(tscPath), "..", "..", "typescript", "lib", "tsserver.js"),
				];
				for (const checkPath of managedTsserverCandidates) {
					try {
						await fs.access(checkPath);
						tsserverPath = checkPath;
						source = "managed";
						break;
					} catch {
						/* not found */
					}
				}
			}
		}

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
	root: createRootDetector([
		".git",
		"pyproject.toml",
		"setup.py",
		"setup.cfg",
		"requirements.txt",
		"Pipfile",
		"poetry.lock",
	]),
	async spawn(root, options) {
		const path = await import("node:path");
		const fs = await import("node:fs/promises");
		const env = await getToolEnvironment();
		let source: "direct" | "managed" | "package-manager" = "direct";

		// Strategy 1: Find pyright - prefer local project version
		let pyrightPath: string | undefined;
		const localPyright = path.join(root, "node_modules", ".bin", "pyright");
		const localPyrightCmd = path.join(
			root,
			"node_modules",
			".bin",
			"pyright.cmd",
		);

		// Check for local version first (Windows .cmd first, then Unix)
		for (const checkPath of [localPyrightCmd, localPyright]) {
			try {
				await fs.access(checkPath);
				pyrightPath = checkPath;
				break;
			} catch {
				/* not found */
			}
		}

		// Strategy 2: Fall back to auto-installed version
		if (!pyrightPath) {
			if (canInstall(options?.allowInstall)) {
				pyrightPath = await ensureTool("pyright");
				source = "managed";
			}
		}

		// Strategy 3: Use found pyright to derive pyright-langserver path
		let langserverPath: string | undefined;
		if (pyrightPath) {
			// Derive langserver from pyright binary location
			// Both are in the same .bin directory
			const binDir = path.dirname(pyrightPath);
			const isWindows = process.platform === "win32";

			const candidates = isWindows
				? [
						path.join(binDir, "pyright-langserver.cmd"),
						path.join(binDir, "pyright-langserver.ps1"),
						path.join(binDir, "pyright-langserver"),
					]
				: [path.join(binDir, "pyright-langserver")];

			for (const candidate of candidates) {
				try {
					await fs.access(candidate);
					langserverPath = candidate;
					break;
				} catch {
					/* not found */
				}
			}
		}

		// Spawn the LSP server
		const candidates = langserverPath
			? [langserverPath, "pyright-langserver"]
			: ["pyright-langserver"];
		const resolved = await resolveAndLaunch(
			{ candidates, args: ["--stdio"], cwd: root, env, managedToolId: "pyright" },
			options?.allowInstall,
		);
		if (!resolved) return undefined;
		const proc = resolved.process;
		source = resolved.source;

		// Detect virtual environment
		const initialization: Record<string, unknown> = {};
		const venvPaths = [
			path.join(root, ".venv"),
			path.join(root, "venv"),
			process.env.VIRTUAL_ENV,
		].filter(Boolean);

		for (const venv of venvPaths) {
			if (!venv) continue;
			try {
				const pythonPath =
					process.platform === "win32"
						? path.join(venv, "Scripts", "python.exe")
						: path.join(venv, "bin", "python");

				await fs.access(pythonPath);
				// Pyright expects pythonPath at top level, not nested
				initialization.pythonPath = pythonPath;
				break;
			} catch {
				/* not found */
			}
		}

		return { process: proc, initialization, source };
	},
};

export const PythonPylspServer: LSPServerInfo = {
	id: "python-pylsp",
	name: "Python LSP Server (pylsp)",
	extensions: [".py", ".pyi"],
	root: createRootDetector([
		".git",
		"pyproject.toml",
		"setup.py",
		"setup.cfg",
		"requirements.txt",
		"Pipfile",
		"poetry.lock",
	]),
	async spawn(root) {
		try {
			const proc = await launchLSP("pylsp", [], { cwd: root });
			return { process: proc, source: "direct" };
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

export const RustServer: LSPServerInfo = {
	id: "rust",
	name: "rust-analyzer",
	extensions: [".rs"],
	root: RootWithFallback(createRootDetector(["Cargo.toml", "Cargo.lock"])),
	async spawn(root, options) {
		// Prefer rustup-installed rust-analyzer; fall back to GitHub-downloaded managed copy
		const result = await resolveAndLaunch(
			{ candidates: ["rust-analyzer"], args: [], cwd: root, managedToolId: "rust-analyzer" },
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
	root: PriorityRoot([["Gemfile", ".ruby-version"], [".git"]]),
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
			{ candidates: ["solargraph", ...rubyBinCandidates("solargraph")], args: ["stdio"], cwd: root },
			false, // don't install solargraph — already tried gem install above
		);
		if (solargraph) return solargraph;

		// rubocop --lsp fallback
		return resolveAndLaunch(
			{ candidates: ["rubocop", ...rubyBinCandidates("rubocop")], args: ["--lsp"], cwd: root },
			false,
		);
	},
};

export const RubySolargraphServer: LSPServerInfo = {
	id: "ruby-solargraph",
	name: "Solargraph",
	extensions: [".rb", ".rake", ".gemspec", ".ru"],
	root: PriorityRoot([["Gemfile", ".ruby-version"], [".git"]]),
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
	root: RootWithFallback(createRootDetector(["composer.json", "composer.lock"])),
	async spawn(root, options) {
		const result = await resolveAndLaunch(
			{ candidates: nodeBinCandidates(root, "intelephense"), args: ["--stdio"], cwd: root, managedToolId: "intelephense" },
			options?.allowInstall,
		);
		if (!result) return undefined;
		return { ...result, initialization: { storagePath: path.join(__dirname, ".intelephense") } };
	},
};

export const CSharpServer = createInteractiveServer({
	id: "csharp",
	name: "csharp-ls",
	extensions: [".cs"],
	root: createRootDetector([".sln", ".csproj", ".slnx"]),
	language: "csharp",
	command: "csharp-ls",
});

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
	root: createRootDetector(["pom.xml", "build.gradle", ".classpath"]),
	language: "java",
	command: () => process.env.JDTLS_PATH || "jdtls",
});

export const KotlinServer = createInteractiveServer({
	id: "kotlin",
	name: "Kotlin Language Server",
	extensions: [".kt", ".kts"],
	root: createRootDetector(["build.gradle.kts", "build.gradle", "pom.xml"]),
	language: "kotlin",
	command: "kotlin-language-server",
});

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
	root: createRootDetector(["pubspec.yaml"]),
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
	root: createRootDetector([
		"compile_commands.json",
		".clangd",
		"CMakeLists.txt",
		"Makefile",
	]),
	language: "cpp",
	command: "clangd",
	args: ["--background-index"],
});

export const ZigServer = createInteractiveServer({
	id: "zig",
	name: "ZLS",
	extensions: [".zig", ".zon"],
	root: createRootDetector(["build.zig"]),
	language: "zig",
	command: "zls",
});

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
	root: createRootDetector(["mix.exs"]),
	language: "elixir",
	command: "elixir-ls",
});

export const GleamServer = createInteractiveServer({
	id: "gleam",
	name: "Gleam LSP",
	extensions: [".gleam"],
	root: createRootDetector(["gleam.toml"]),
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

export const TerraformServer = createInteractiveServer({
	id: "terraform",
	name: "Terraform LSP",
	extensions: [".tf", ".tfvars"],
	root: createRootDetector([".terraform.lock.hcl"]),
	language: "terraform",
	command: "terraform-ls",
	args: ["serve"],
});

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
			{ candidates: nodeBinCandidates(root, "bash-language-server"), args: ["start"], cwd: root, managedToolId: "bash-language-server" },
			options?.allowInstall,
		);
	},
};

export const DockerServer: LSPServerInfo = {
	id: "docker",
	name: "Dockerfile Language Server",
	extensions: [".dockerfile", "Dockerfile"],
	root: PriorityRoot([["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"], [".git"]]),
	spawn(root, options) {
		return resolveAndLaunch(
			{ candidates: nodeBinCandidates(root, "docker-langserver"), args: ["--stdio"], cwd: root, managedToolId: "dockerfile-language-server-nodejs" },
			options?.allowInstall,
		);
	},
};

export const YamlServer: LSPServerInfo = {
	id: "yaml",
	name: "YAML Language Server",
	extensions: [".yaml", ".yml"],
	root: PriorityRoot([[".yamllint", "yamllint.yml", "yamllint.yaml", "pyproject.toml"], [".git"]]),
	spawn(root, options) {
		return resolveAndLaunch(
			{ candidates: ["yaml-language-server"], args: ["--stdio"], cwd: root, managedToolId: "yaml-language-server" },
			options?.allowInstall,
		);
	},
};

export const JsonServer: LSPServerInfo = {
	id: "json",
	name: "VSCode JSON Language Server",
	extensions: [".json", ".jsonc"],
	root: RootWithFallback(
		WorkspacePriorityRoot([["package.json", "tsconfig.json", "jsconfig.json"], [".git"]]),
	),
	spawn(root, options) {
		return resolveAndLaunch(
			{ candidates: ["vscode-json-language-server"], args: ["--stdio"], cwd: root, managedToolId: "vscode-json-language-server" },
			options?.allowInstall,
		);
	},
};

export const HtmlServer: LSPServerInfo = {
	id: "html",
	name: "VSCode HTML Language Server",
	extensions: [".html", ".htm"],
	root: PriorityRoot([["package.json", "index.html", "vite.config.ts"], [".git"]]),
	spawn(root, options) {
		return resolveAndLaunch(
			{ candidates: nodeBinCandidates(root, "vscode-html-language-server"), args: ["--stdio"], cwd: root, managedToolId: "vscode-html-languageserver-bin" },
			options?.allowInstall,
		);
	},
};

export const TomlServer = createInteractiveServer({
	id: "toml",
	name: "Taplo",
	extensions: [".toml"],
	root: PriorityRoot([["pyproject.toml", "Cargo.toml", "taplo.toml"], [".git"]]),
	language: "toml",
	command: "taplo",
	args: ["lsp", "stdio"],
});

export const PrismaServer: LSPServerInfo = {
	id: "prisma",
	name: "Prisma Language Server",
	extensions: [".prisma"],
	root: RootWithFallback(createRootDetector(["prisma/schema.prisma", "schema.prisma"])),
	spawn(root, options) {
		return resolveAndLaunch(
			{ candidates: nodeBinCandidates(root, "prisma-language-server"), args: ["--stdio"], cwd: root, managedToolId: "@prisma/language-server" },
			options?.allowInstall,
		);
	},
};

// --- Web Framework & Styling Servers ---

export const VueServer: LSPServerInfo = {
	id: "vue",
	name: "Vue Language Server",
	extensions: [".vue"],
	root: createRootDetector([
		"package-lock.json",
		"bun.lockb",
		"bun.lock",
		"pnpm-lock.yaml",
		"yarn.lock",
	]),
	spawn(root, options) {
		return resolveAndLaunch(
			{ candidates: nodeBinCandidates(root, "vue-language-server"), args: ["--stdio"], cwd: root, managedToolId: "@vue/language-server" },
			options?.allowInstall,
		);
	},
};

export const SvelteServer: LSPServerInfo = {
	id: "svelte",
	name: "Svelte Language Server",
	extensions: [".svelte"],
	root: createRootDetector([
		"package-lock.json",
		"bun.lockb",
		"bun.lock",
		"pnpm-lock.yaml",
		"yarn.lock",
	]),
	spawn(root, options) {
		return resolveAndLaunch(
			{ candidates: [...nodeBinCandidates(root, "svelteserver"), ...nodeBinCandidates(root, "svelte-language-server")], args: ["--stdio"], cwd: root, managedToolId: "svelte-language-server" },
			options?.allowInstall,
		);
	},
};

export const ESLintServer: LSPServerInfo = {
	id: "eslint",
	name: "ESLint Language Server",
	extensions: [".js", ".jsx", ".vue", ".svelte"], // Note: .ts/.tsx handled by TypeScript LSP + Biome
	root: createRootDetector([
		".eslintrc",
		".eslintrc.json",
		".eslintrc.js",
		"eslint.config.js",
		"eslint.config.mjs",
		"package.json",
	]),
	spawn(root, options) {
		return resolveAndLaunch(
			{ candidates: nodeBinCandidates(root, "vscode-eslint-language-server"), args: ["--stdio"], cwd: root, managedToolId: "vscode-langservers-extracted" },
			options?.allowInstall,
		);
	},
};

export const CssServer: LSPServerInfo = {
	id: "css",
	name: "CSS Language Server",
	extensions: [".css", ".scss", ".sass", ".less"],
	root: PriorityRoot([["package.json", "postcss.config.js", "tailwind.config.js", "vite.config.ts"], [".git"]]),
	spawn(root, options) {
		return resolveAndLaunch(
			{ candidates: nodeBinCandidates(root, "vscode-css-language-server"), args: ["--stdio"], cwd: root, managedToolId: "vscode-css-languageserver" },
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
	RubySolargraphServer,
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
