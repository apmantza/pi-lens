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

export interface LSPServerInfo {
	id: string;
	name: string;
	extensions: string[];
	root: RootFunction;
	installPolicy?: "none" | "interactive" | "managed" | "package-manager";
	spawn(
		root: string,
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

function isCommandNotFoundError(error: unknown): boolean {
	const msg = String(error);
	return msg.includes("not found") || msg.includes("ENOENT");
}

async function launchViaPackageManagerWithPolicy(
	packageName: string,
	args: string[],
	options: { cwd: string },
): Promise<LSPProcess | undefined> {
	if (isLspInstallDisabled()) {
		return undefined;
	}
	return launchViaPackageManager(packageName, args, options);
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
	options: { cwd: string },
	spawnFn: () => LSPProcess | Promise<LSPProcess>,
): Promise<LSPProcess | undefined> {
	try {
		return await spawnFn();
	} catch (error) {
		if (isLspInstallDisabled()) {
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
		let currentDir = path.dirname(file);
		const fsRoot = path.parse(currentDir).root;
		const stop = stopDir ?? fsRoot;

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
	async spawn(root) {
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
			if (!isLspInstallDisabled()) {
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
	async spawn(root) {
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
			if (!isLspInstallDisabled()) {
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
		let proc;
		if (langserverPath) {
			// Use resolved langserver path
			proc = await launchLSP(langserverPath, ["--stdio"], {
				cwd: root,
				env,
			});
		} else {
			if (isLspInstallDisabled()) {
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
				proc = await launchViaPackageManager("pyright-langserver", ["--stdio"], {
					cwd: root,
					env,
				});
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

export const GoServer: LSPServerInfo = {
	id: "go",
	name: "gopls",
	extensions: [".go"],
	installPolicy: "interactive",
	root: PriorityRoot([["go.work"], ["go.mod", "go.sum"]]),
	async spawn(root) {
		const proc = await spawnWithInteractiveInstall(
			"go",
			"gopls",
			[],
			{ cwd: root },
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
	async spawn(root) {
		const proc = await spawnWithInteractiveInstall(
			"rust",
			"rust-analyzer",
			[],
			{ cwd: root },
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
	root: createRootDetector(["Gemfile", ".ruby-version"]),
	async spawn(root) {
		// Try ruby-lsp first (prompts to install via gem if missing), fall back to solargraph
		const proc = await spawnWithInteractiveInstall(
			"ruby",
			"ruby-lsp",
			[],
			{ cwd: root },
			async () => {
				try {
					return await launchLSP("ruby-lsp", [], { cwd: root });
				} catch {
					const fallback = await launchViaPackageManagerWithPolicy(
						"solargraph",
						["stdio"],
						{ cwd: root },
					);
					if (!fallback) throw new Error("ENOENT: command not found");
					return fallback;
				}
			},
		);
		return proc ? { process: proc, source: "package-manager" } : undefined;
	},
};

export const PHPServer: LSPServerInfo = {
	id: "php",
	name: "Intelephense",
	installPolicy: "package-manager",
	extensions: [".php"],
	root: createRootDetector(["composer.json", "composer.lock"]),
	async spawn(root) {
		const proc = await launchViaPackageManagerWithPolicy(
			"intelephense",
			["--stdio"],
			{ cwd: root },
		);
		if (!proc) return undefined;
		return {
			process: proc,
			initialization: { storagePath: path.join(__dirname, ".intelephense") },
		};
	},
};

export const CSharpServer: LSPServerInfo = {
	id: "csharp",
	name: "csharp-ls",
	installPolicy: "interactive",
	extensions: [".cs"],
	root: createRootDetector([".sln", ".csproj", ".slnx"]),
	async spawn(root) {
		const proc = await spawnWithInteractiveInstall(
			"csharp",
			"csharp-ls",
			[],
			{ cwd: root },
			async () => await launchLSP("csharp-ls", [], { cwd: root }),
		);
		return proc ? { process: proc, source: "package-manager" } : undefined;
	},
};

export const FSharpServer: LSPServerInfo = {
	id: "fsharp",
	name: "FSAutocomplete",
	installPolicy: "interactive",
	extensions: [".fs", ".fsi", ".fsx"],
	root: createRootDetector([".sln", ".fsproj"]),
	async spawn(root) {
		const proc = await spawnWithInteractiveInstall(
			"fsharp",
			"fsautocomplete",
			[],
			{ cwd: root },
			async () => await launchLSP("fsautocomplete", [], { cwd: root }),
		);
		return proc ? { process: proc } : undefined;
	},
};

export const JavaServer: LSPServerInfo = {
	id: "java",
	name: "JDT Language Server",
	installPolicy: "interactive",
	extensions: [".java"],
	root: createRootDetector(["pom.xml", "build.gradle", ".classpath"]),
	async spawn(root) {
		const jdtlsPath = process.env.JDTLS_PATH || "jdtls";
		const proc = await spawnWithInteractiveInstall(
			"java",
			jdtlsPath,
			[],
			{ cwd: root },
			async () => await launchLSP(jdtlsPath, [], { cwd: root }),
		);
		return proc ? { process: proc } : undefined;
	},
};

export const KotlinServer: LSPServerInfo = {
	id: "kotlin",
	name: "Kotlin Language Server",
	installPolicy: "interactive",
	extensions: [".kt", ".kts"],
	root: createRootDetector(["build.gradle.kts", "build.gradle", "pom.xml"]),
	async spawn(root) {
		const proc = await spawnWithInteractiveInstall(
			"kotlin",
			"kotlin-language-server",
			[],
			{ cwd: root },
			async () => await launchLSP("kotlin-language-server", [], { cwd: root }),
		);
		return proc ? { process: proc } : undefined;
	},
};

export const SwiftServer: LSPServerInfo = {
	id: "swift",
	name: "SourceKit-LSP",
	installPolicy: "interactive",
	extensions: [".swift"],
	root: createRootDetector(["Package.swift"]),
	async spawn(root) {
		const proc = await spawnWithInteractiveInstall(
			"swift",
			"sourcekit-lsp",
			[],
			{ cwd: root },
			async () => await launchLSP("sourcekit-lsp", [], { cwd: root }),
		);
		return proc ? { process: proc } : undefined;
	},
};

export const DartServer: LSPServerInfo = {
	id: "dart",
	name: "Dart Analysis Server",
	installPolicy: "interactive",
	extensions: [".dart"],
	root: createRootDetector(["pubspec.yaml"]),
	async spawn(root) {
		const proc = await spawnWithInteractiveInstall(
			"dart",
			"dart",
			["language-server", "--protocol=lsp"],
			{ cwd: root },
			async () =>
				await launchLSP("dart", ["language-server", "--protocol=lsp"], { cwd: root }),
		);
		return proc ? { process: proc } : undefined;
	},
};

export const LuaServer: LSPServerInfo = {
	id: "lua",
	name: "Lua Language Server",
	installPolicy: "interactive",
	extensions: [".lua"],
	root: createRootDetector([".luarc.json", ".luacheckrc"]),
	async spawn(root) {
		const proc = await spawnWithInteractiveInstall(
			"lua",
			"lua-language-server",
			[],
			{ cwd: root },
			async () => await launchLSP("lua-language-server", [], { cwd: root }),
		);
		return proc ? { process: proc } : undefined;
	},
};

export const CppServer: LSPServerInfo = {
	id: "cpp",
	name: "clangd",
	installPolicy: "interactive",
	extensions: [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp"],
	root: createRootDetector([
		"compile_commands.json",
		".clangd",
		"CMakeLists.txt",
		"Makefile",
	]),
	async spawn(root) {
		const proc = await spawnWithInteractiveInstall(
			"cpp",
			"clangd",
			["--background-index"],
			{ cwd: root },
			async () => await launchLSP("clangd", ["--background-index"], { cwd: root }),
		);
		return proc ? { process: proc } : undefined;
	},
};

export const ZigServer: LSPServerInfo = {
	id: "zig",
	name: "ZLS",
	installPolicy: "interactive",
	extensions: [".zig", ".zon"],
	root: createRootDetector(["build.zig"]),
	async spawn(root) {
		const proc = await spawnWithInteractiveInstall(
			"zig",
			"zls",
			[],
			{ cwd: root },
			async () => await launchLSP("zls", [], { cwd: root }),
		);
		return proc ? { process: proc } : undefined;
	},
};

export const HaskellServer: LSPServerInfo = {
	id: "haskell",
	name: "Haskell Language Server",
	installPolicy: "interactive",
	extensions: [".hs", ".lhs"],
	root: createRootDetector(["stack.yaml", "cabal.project", "*.cabal"]),
	async spawn(root) {
		const proc = await spawnWithInteractiveInstall(
			"haskell",
			"haskell-language-server-wrapper",
			["--lsp"],
			{ cwd: root },
			async () =>
				await launchLSP("haskell-language-server-wrapper", ["--lsp"], { cwd: root }),
		);
		return proc ? { process: proc } : undefined;
	},
};

export const ElixirServer: LSPServerInfo = {
	id: "elixir",
	name: "ElixirLS",
	installPolicy: "interactive",
	extensions: [".ex", ".exs"],
	root: createRootDetector(["mix.exs"]),
	async spawn(root) {
		const proc = await spawnWithInteractiveInstall(
			"elixir",
			"elixir-ls",
			[],
			{ cwd: root },
			async () => await launchLSP("elixir-ls", [], { cwd: root }),
		);
		return proc ? { process: proc } : undefined;
	},
};

export const GleamServer: LSPServerInfo = {
	id: "gleam",
	name: "Gleam LSP",
	installPolicy: "interactive",
	extensions: [".gleam"],
	root: createRootDetector(["gleam.toml"]),
	async spawn(root) {
		const proc = await spawnWithInteractiveInstall(
			"gleam",
			"gleam",
			["lsp"],
			{ cwd: root },
			async () => await launchLSP("gleam", ["lsp"], { cwd: root }),
		);
		return proc ? { process: proc } : undefined;
	},
};

export const OCamlServer: LSPServerInfo = {
	id: "ocaml",
	name: "ocamllsp",
	installPolicy: "interactive",
	extensions: [".ml", ".mli"],
	root: createRootDetector(["dune-project", "opam"]),
	async spawn(root) {
		const proc = await spawnWithInteractiveInstall(
			"ocaml",
			"ocamllsp",
			[],
			{ cwd: root },
			async () => await launchLSP("ocamllsp", [], { cwd: root }),
		);
		return proc ? { process: proc } : undefined;
	},
};

export const ClojureServer: LSPServerInfo = {
	id: "clojure",
	name: "Clojure LSP",
	installPolicy: "interactive",
	extensions: [".clj", ".cljs", ".cljc", ".edn"],
	root: createRootDetector(["deps.edn", "project.clj"]),
	async spawn(root) {
		const proc = await spawnWithInteractiveInstall(
			"clojure",
			"clojure-lsp",
			[],
			{ cwd: root },
			async () => await launchLSP("clojure-lsp", [], { cwd: root }),
		);
		return proc ? { process: proc } : undefined;
	},
};

export const TerraformServer: LSPServerInfo = {
	id: "terraform",
	name: "Terraform LSP",
	installPolicy: "interactive",
	extensions: [".tf", ".tfvars"],
	root: createRootDetector([".terraform.lock.hcl"]),
	async spawn(root) {
		const proc = await spawnWithInteractiveInstall(
			"terraform",
			"terraform-ls",
			["serve"],
			{ cwd: root },
			async () => await launchLSP("terraform-ls", ["serve"], { cwd: root }),
		);
		return proc ? { process: proc } : undefined;
	},
};

export const NixServer: LSPServerInfo = {
	id: "nix",
	name: "nixd",
	installPolicy: "interactive",
	extensions: [".nix"],
	root: createRootDetector(["flake.nix"]),
	async spawn(root) {
		const proc = await spawnWithInteractiveInstall(
			"nix",
			"nixd",
			[],
			{ cwd: root },
			async () => await launchLSP("nixd", [], { cwd: root }),
		);
		return proc ? { process: proc } : undefined;
	},
};

export const BashServer: LSPServerInfo = {
	id: "bash",
	name: "Bash Language Server",
	extensions: [".sh", ".bash", ".zsh"],
	installPolicy: "interactive",
	root: async () => process.cwd(),
	async spawn() {
		const cwd = process.cwd();
		const proc = await spawnWithInteractiveInstall(
			"bash",
			"bash-language-server",
			["start"],
			{ cwd },
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
	root: async () => process.cwd(),
	async spawn() {
		// Use npx since it's not auto-installed
		const proc = await launchViaPackageManagerWithPolicy(
			"dockerfile-language-server-nodejs",
			["--stdio"],
			{ cwd: process.cwd() },
		);
		if (!proc) return undefined;
		return { process: proc };
	},
};

export const YamlServer: LSPServerInfo = {
	id: "yaml",
	name: "YAML Language Server",
	extensions: [".yaml", ".yml"],
	installPolicy: "interactive",
	root: async () => process.cwd(),
	async spawn() {
		const cwd = process.cwd();
		const proc = await spawnWithInteractiveInstall(
			"yaml",
			"yaml-language-server",
			["--stdio"],
			{ cwd },
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
	root: async () => process.cwd(),
	async spawn() {
		const cwd = process.cwd();
		const proc = await spawnWithInteractiveInstall(
			"json",
			"vscode-json-language-server",
			["--stdio"],
			{ cwd },
			async () =>
				await launchLSP("vscode-json-language-server", ["--stdio"], {}),
		);
		return proc ? { process: proc } : undefined;
	},
};

export const PrismaServer: LSPServerInfo = {
	id: "prisma",
	name: "Prisma Language Server",
	installPolicy: "package-manager",
	extensions: [".prisma"],
	root: createRootDetector(["prisma/schema.prisma"]),
	async spawn(root) {
		// Use npx since it's not auto-installed
		const proc = await launchViaPackageManagerWithPolicy(
			"@prisma/language-server",
			["--stdio"],
			{ cwd: root },
		);
		if (!proc) return undefined;
		return { process: proc };
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
	async spawn(root) {
		let proc: LSPProcess | undefined;
		let source: "direct" | "package-manager" = "direct";
		try {
			proc = await launchLSP("vue-language-server", ["--stdio"], {
				cwd: root,
			});
		} catch (error) {
			if (!isCommandNotFoundError(error)) {
				throw error;
			}
			proc = await launchViaPackageManagerWithPolicy(
				"@vue/language-server",
				["--stdio"],
				{ cwd: root },
			);
			source = "package-manager";
		}
		if (!proc) return undefined;
		return { process: proc, source };
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
	async spawn(root) {
		let proc: LSPProcess | undefined;
		let source: "direct" | "package-manager" = "direct";
		try {
			proc = await launchLSP("svelteserver", ["--stdio"], {
				cwd: root,
			});
		} catch (error) {
			if (!isCommandNotFoundError(error)) {
				throw error;
			}
			proc = await launchViaPackageManagerWithPolicy(
				"svelte-language-server",
				["--stdio"],
				{ cwd: root },
			);
			source = "package-manager";
		}
		if (!proc) return undefined;
		return { process: proc, source };
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
	async spawn(root) {
		// Try via package manager (npx) since it's not auto-installed
		try {
			const proc = await launchViaPackageManagerWithPolicy(
				"vscode-eslint-language-server",
				["--stdio"],
				{ cwd: root },
			);
			if (!proc) return undefined;
			return { process: proc, source: "package-manager" };
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
	root: async () => process.cwd(),
	async spawn() {
		// Use npx since it's not auto-installed
		const proc = await launchViaPackageManagerWithPolicy(
			"vscode-css-languageserver",
			["--stdio"],
			{ cwd: process.cwd() },
		);
		if (!proc) return undefined;
		return { process: proc, source: "package-manager" };
	},
};

// --- Registry ---

export const LSP_SERVERS: LSPServerInfo[] = [
	TypeScriptServer,
	PythonServer,
	GoServer,
	RustServer,
	RubyServer,
	PHPServer,
	CSharpServer,
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
