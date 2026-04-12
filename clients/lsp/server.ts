/**
 * LSP Server Definitions for pi-lens
 *
 * Defines 40+ language servers with:
 * - Root detection (monorepo support)
 * - Auto-installation strategies
 * - Platform-specific handling
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import { ensureTool, getToolEnvironment } from "../installer/index.js";
import {
	promptForInstall,
	supportsInteractiveInstall,
} from "./interactive-install.js";
import {
	type LSPProcess,
	launchLSP,
	launchViaPackageManager,
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
	installPolicy?: "none" | "interactive" | "managed" | "package-manager";
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
	return msg.includes("not found") || msg.includes("ENOENT");
}

async function launchViaPackageManagerWithPolicy(
	packageName: string,
	args: string[],
	options: { cwd: string; allowInstall?: boolean },
): Promise<LSPProcess | undefined> {
	if (!canInstall(options.allowInstall)) {
		return undefined;
	}
	return launchViaPackageManager(packageName, args, options);
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

async function launchWithDirectOrPackageManager(
	directCommands: string[],
	packageName: string,
	args: string[],
	options: { cwd: string; env?: NodeJS.ProcessEnv; allowInstall?: boolean },
): Promise<{ process: LSPProcess; source: "direct" | "package-manager" } | undefined> {
	for (const command of directCommands) {
		try {
			const process = await launchLSP(command, args, options);
			return { process, source: "direct" };
		} catch (error) {
			if (!isCommandNotFoundError(error)) {
				throw error;
			}
		}
	}

	const process = await launchViaPackageManagerWithPolicy(packageName, args, {
		cwd: options.cwd,
		allowInstall: options.allowInstall,
	});
	if (!process) return undefined;
	return { process, source: "package-manager" };
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
		installPolicy: "interactive",
		extensions: spec.extensions,
		root: spec.root,
		async spawn(root, options) {
			const command =
				typeof spec.command === "function" ? spec.command(root) : spec.command;
			const args =
				typeof spec.args === "function"
					? spec.args(root)
					: spec.args || [];
			const proc = await spawnWithInteractiveInstall(
				spec.language,
				command,
				args,
				{ cwd: root, allowInstall: options?.allowInstall },
				async () => await launchLSP(command, args, { cwd: root }),
			);
			if (!proc) return undefined;
			const initialization =
				typeof spec.initialization === "function"
					? spec.initialization(root)
					: spec.initialization;
			return { process: proc, source: "interactive", initialization };
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

// --- Root Detection Helpers ---

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Interactive Install Helper ---

/**
 * Spawn LSP with interactive install support for common languages
 *
 * For Go, Rust, YAML, JSON, Bash: prompts user to install if tool not found
 * Other languages: throws error with install instructions
 */
async function spawnWithInteractiveInstall(
	language: string,
	_command: string,
	_args: string[],
	options: { cwd: string; allowInstall?: boolean },
	spawnFn: () => LSPProcess | Promise<LSPProcess>,
): Promise<LSPProcess | undefined> {
	try {
		return await spawnFn();
	} catch (error) {
		if (!canInstall(options.allowInstall)) {
			return undefined;
		}
		// Check if this is a "command not found" error
		const errorMsg = String(error);
		if (!errorMsg.includes("not found") && !errorMsg.includes("ENOENT")) {
			throw error; // Re-throw if it's a different error
		}

		// Check if language supports interactive install
		if (supportsInteractiveInstall(language)) {
			const shouldInstall = await promptForInstall(language, options.cwd);
			if (shouldInstall) {
				// Try again after install
				return await spawnFn();
			}
			// User declined, return undefined to skip this LSP
			return undefined;
		}

		// For other languages, throw with install instructions
		throw error;
	}
}

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

		while (currentDir !== fsRoot) {
			// Bail out if we've reached the stop boundary
			if (
				currentDir === stop ||
				(currentDir.startsWith(stop + path.sep) === false &&
					currentDir === stop)
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

			currentDir = path.dirname(currentDir);
		}

		return undefined;
	};
}

/** Alias kept for backward compatibility */
export const createRootDetector = NearestRoot;

// --- Server Definitions ---

export const TypeScriptServer: LSPServerInfo = {
	id: "typescript",
	name: "TypeScript Language Server",
	installPolicy: "managed",
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
				console.error("[lsp] typescript-language-server not found");
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
	installPolicy: "none",
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

export const BiomeLspServer: LSPServerInfo = {
	id: "biome-lsp",
	name: "Biome LSP Proxy",
	installPolicy: "package-manager",
	extensions: [
		".ts",
		".tsx",
		".js",
		".jsx",
		".mjs",
		".cjs",
		".mts",
		".cts",
		".json",
		".jsonc",
		".css",
		".scss",
		".sass",
		".less",
	],
	root: PriorityRoot([["biome.json", "biome.jsonc", "package.json"], [".git"]]),
	async spawn(root, options) {
		const launched = await launchWithDirectOrPackageManager(
			nodeBinCandidates(root, "biome"),
			"@biomejs/biome",
			["lsp-proxy"],
			{ cwd: root, allowInstall: options?.allowInstall },
		);
		if (!launched) return undefined;
		return { process: launched.process, source: launched.source };
	},
};

export const PythonServer: LSPServerInfo = {
	id: "python",
	name: "Pyright Language Server",
	installPolicy: "managed",
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
			if (!pyrightPath) {
				console.error("[lsp] pyright not found, falling back to npx");
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
					if (process.env.PI_LENS_DEBUG === "1") {
						console.error(`[lsp] Found pyright-langserver: ${candidate}`);
					}
					break;
				} catch {
					/* not found */
				}
			}
		}

		// Spawn the LSP server
		let proc: LSPProcess;
		if (langserverPath) {
			// Use resolved langserver path
			proc = await launchLSP(langserverPath, ["--stdio"], {
				cwd: root,
				env,
			});
		} else {
			if (!canInstall(options?.allowInstall)) {
				try {
					proc = await launchLSP("pyright-langserver", ["--stdio"], {
						cwd: root,
						env,
					});
				} catch {
					return undefined;
				}
			} else {
				// Fallback to npx for auto-download
				console.error("[lsp] Falling back to npx for pyright-langserver");
				const managed = await launchViaPackageManagerWithPolicy(
					"pyright-langserver",
					["--stdio"],
					{ cwd: root, allowInstall: options?.allowInstall },
				);
				if (!managed) return undefined;
				proc = managed;
				source = "package-manager";
			}
		}

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
	installPolicy: "none",
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
	installPolicy: "interactive",
	root: PriorityRoot([["go.work"], ["go.mod", "go.sum"]]),
	async spawn(root, options) {
		const proc = await spawnWithInteractiveInstall(
			"go",
			"gopls",
			[],
			{ cwd: root, allowInstall: options?.allowInstall },
			async () => await launchLSP("gopls", [], { cwd: root }),
		);
		// gopls works best with minimal initialization options
		// The client capabilities fix (workspaceFolders: true) is the key fix
		return proc
			? {
					process: proc,
					initialization: {
						// Disable experimental features that may cause issues
						ui: {
							semanticTokens: true,
						},
					},
				}
			: undefined;
	},
};

export const RustServer: LSPServerInfo = {
	id: "rust",
	name: "rust-analyzer",
	extensions: [".rs"],
	installPolicy: "interactive",
	root: createRootDetector(["Cargo.toml", "Cargo.lock"]),
	async spawn(root, options) {
		const proc = await spawnWithInteractiveInstall(
			"rust",
			"rust-analyzer",
			[],
			{ cwd: root, allowInstall: options?.allowInstall },
			async () => await launchLSP("rust-analyzer", [], { cwd: root }),
		);
		// rust-analyzer needs minimal initialization to avoid capability mismatches
		return proc
			? {
					process: proc,
					initialization: {
						// Disable features that may conflict with our client capabilities
						cargo: {
							buildScripts: { enable: true },
						},
						procMacro: { enable: true },
						diagnostics: { enable: true },
					},
				}
			: undefined;
	},
};

export const RubyServer: LSPServerInfo = {
	id: "ruby",
	name: "Ruby LSP",
	installPolicy: "interactive",
	extensions: [".rb", ".rake", ".gemspec", ".ru"],
	root: PriorityRoot([["Gemfile", ".ruby-version"], [".git"]]),
	async spawn(root, options) {
		// Try ruby-lsp first, then solargraph, then rubocop --lsp
		const proc = await spawnWithInteractiveInstall(
			"ruby",
			"ruby-lsp",
			[],
			{ cwd: root, allowInstall: options?.allowInstall },
			async () => {
				for (const command of ["ruby-lsp", ...rubyBinCandidates("ruby-lsp")]) {
					try {
						return await launchLSP(command, [], { cwd: root });
					} catch {
						// try next ruby-lsp candidate
					}
				}

				for (const command of ["solargraph", ...rubyBinCandidates("solargraph")]) {
					try {
						return await launchLSP(command, ["stdio"], { cwd: root });
					} catch {
						// try next solargraph candidate
					}
				}

				for (const command of ["rubocop", ...rubyBinCandidates("rubocop")]) {
					try {
						return await launchLSP(command, ["--lsp"], { cwd: root });
					} catch {
						// try next rubocop candidate
					}
				}

				throw new Error("ENOENT: command not found");
			},
		);
		return proc ? { process: proc, source: "interactive" } : undefined;
	},
};

export const RubySolargraphServer: LSPServerInfo = {
	id: "ruby-solargraph",
	name: "Solargraph",
	installPolicy: "none",
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
	installPolicy: "package-manager",
	extensions: [".php"],
	root: createRootDetector(["composer.json", "composer.lock"]),
	async spawn(root, options) {
		const launched = await launchWithDirectOrPackageManager(
			nodeBinCandidates(root, "intelephense"),
			"intelephense",
			["--stdio"],
			{ cwd: root, allowInstall: options?.allowInstall },
		);
		if (!launched) return undefined;
		return {
			process: launched.process,
			source: launched.source,
			initialization: { storagePath: path.join(__dirname, ".intelephense") },
		};
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
	installPolicy: "interactive",
	root: async () => process.cwd(),
	async spawn(_root, options) {
		const cwd = process.cwd();
		const proc = await spawnWithInteractiveInstall(
			"bash",
			"bash-language-server",
			["start"],
			{ cwd, allowInstall: options?.allowInstall },
			async () => await launchLSP("bash-language-server", ["start"], {}),
		);
		return proc ? { process: proc } : undefined;
	},
};

export const DockerServer: LSPServerInfo = {
	id: "docker",
	name: "Dockerfile Language Server",
	installPolicy: "package-manager",
	extensions: [".dockerfile", "Dockerfile"],
	root: PriorityRoot([["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"], [".git"]]),
	async spawn(_root, options) {
		const launched = await launchWithDirectOrPackageManager(
			nodeBinCandidates(process.cwd(), "docker-langserver"),
			"dockerfile-language-server-nodejs",
			["--stdio"],
			{ cwd: process.cwd(), allowInstall: options?.allowInstall },
		);
		if (!launched) return undefined;
		return { process: launched.process, source: launched.source };
	},
};

export const YamlServer: LSPServerInfo = {
	id: "yaml",
	name: "YAML Language Server",
	extensions: [".yaml", ".yml"],
	installPolicy: "interactive",
	root: PriorityRoot([[".yamllint", "yamllint.yml", "yamllint.yaml", "pyproject.toml"], [".git"]]),
	async spawn(_root, options) {
		const cwd = process.cwd();
		const proc = await spawnWithInteractiveInstall(
			"yaml",
			"yaml-language-server",
			["--stdio"],
			{ cwd, allowInstall: options?.allowInstall },
			async () => await launchLSP("yaml-language-server", ["--stdio"], {}),
		);
		return proc ? { process: proc } : undefined;
	},
};

export const JsonServer: LSPServerInfo = {
	id: "json",
	name: "VSCode JSON Language Server",
	extensions: [".json", ".jsonc"],
	installPolicy: "interactive",
	root: PriorityRoot([["package.json", "tsconfig.json", "jsconfig.json"], [".git"]]),
	async spawn(_root, options) {
		const cwd = process.cwd();
		const proc = await spawnWithInteractiveInstall(
			"json",
			"vscode-json-language-server",
			["--stdio"],
			{ cwd, allowInstall: options?.allowInstall },
			async () =>
				await launchLSP("vscode-json-language-server", ["--stdio"], {}),
		);
		return proc ? { process: proc } : undefined;
	},
};

export const HtmlServer: LSPServerInfo = {
	id: "html",
	name: "VSCode HTML Language Server",
	installPolicy: "package-manager",
	extensions: [".html", ".htm"],
	root: PriorityRoot([["package.json", "index.html", "vite.config.ts"], [".git"]]),
	async spawn(_root, options) {
		const launched = await launchWithDirectOrPackageManager(
			nodeBinCandidates(process.cwd(), "vscode-html-language-server"),
			"vscode-html-languageserver-bin",
			["--stdio"],
			{ cwd: process.cwd(), allowInstall: options?.allowInstall },
		);
		if (!launched) return undefined;
		return { process: launched.process, source: launched.source };
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
	installPolicy: "package-manager",
	extensions: [".prisma"],
	root: createRootDetector(["prisma/schema.prisma"]),
	async spawn(root, options) {
		const launched = await launchWithDirectOrPackageManager(
			nodeBinCandidates(root, "prisma-language-server"),
			"@prisma/language-server",
			["--stdio"],
			{ cwd: root, allowInstall: options?.allowInstall },
		);
		if (!launched) return undefined;
		return { process: launched.process, source: launched.source };
	},
};

// --- Web Framework & Styling Servers ---

export const VueServer: LSPServerInfo = {
	id: "vue",
	name: "Vue Language Server",
	extensions: [".vue"],
	installPolicy: "package-manager",
	root: createRootDetector([
		"package-lock.json",
		"bun.lockb",
		"bun.lock",
		"pnpm-lock.yaml",
		"yarn.lock",
	]),
	async spawn(root, options) {
		const launched = await launchWithDirectOrPackageManager(
			nodeBinCandidates(root, "vue-language-server"),
			"@vue/language-server",
			["--stdio"],
			{ cwd: root, allowInstall: options?.allowInstall },
		);
		if (!launched) return undefined;
		return { process: launched.process, source: launched.source };
	},
};

export const SvelteServer: LSPServerInfo = {
	id: "svelte",
	name: "Svelte Language Server",
	extensions: [".svelte"],
	installPolicy: "package-manager",
	root: createRootDetector([
		"package-lock.json",
		"bun.lockb",
		"bun.lock",
		"pnpm-lock.yaml",
		"yarn.lock",
	]),
	async spawn(root, options) {
		const launched = await launchWithDirectOrPackageManager(
			[...nodeBinCandidates(root, "svelteserver"), ...nodeBinCandidates(root, "svelte-language-server")],
			"svelte-language-server",
			["--stdio"],
			{ cwd: root, allowInstall: options?.allowInstall },
		);
		if (!launched) return undefined;
		return { process: launched.process, source: launched.source };
	},
};

export const ESLintServer: LSPServerInfo = {
	id: "eslint",
	name: "ESLint Language Server",
	installPolicy: "package-manager",
	extensions: [".js", ".jsx", ".vue", ".svelte"], // Note: .ts/.tsx handled by TypeScript LSP + Biome
	root: createRootDetector([
		".eslintrc",
		".eslintrc.json",
		".eslintrc.js",
		"eslint.config.js",
		"eslint.config.mjs",
		"package.json",
	]),
	async spawn(root, options) {
		// Try via package manager (npx) since it's not auto-installed
		try {
			const launched = await launchWithDirectOrPackageManager(
				nodeBinCandidates(root, "vscode-eslint-language-server"),
				"vscode-eslint-language-server",
				["--stdio"],
				{ cwd: root, allowInstall: options?.allowInstall },
			);
			if (!launched) return undefined;
			return { process: launched.process, source: launched.source };
		} catch {
			// Fall back to global install message
			console.error(
				"[lsp] ESLint Language Server not found. Install: npm install -g vscode-langservers-extracted",
			);
			return undefined;
		}
	},
};

export const CssServer: LSPServerInfo = {
	id: "css",
	name: "CSS Language Server",
	installPolicy: "package-manager",
	extensions: [".css", ".scss", ".sass", ".less"],
	root: PriorityRoot([["package.json", "postcss.config.js", "tailwind.config.js", "vite.config.ts"], [".git"]]),
	async spawn(_root, options) {
		const launched = await launchWithDirectOrPackageManager(
			nodeBinCandidates(process.cwd(), "vscode-css-language-server"),
			"vscode-css-languageserver",
			["--stdio"],
			{ cwd: process.cwd(), allowInstall: options?.allowInstall },
		);
		if (!launched) return undefined;
		return { process: launched.process, source: launched.source };
	},
};

// --- Registry ---

export const LSP_SERVERS: LSPServerInfo[] = [
	TypeScriptServer,
	DenoServer,
	BiomeLspServer,
	PythonServer,
	PythonPylspServer,
	GoServer,
	RustServer,
	RubyServer,
	RubySolargraphServer,
	PHPServer,
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
