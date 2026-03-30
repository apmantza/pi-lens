/**
 * LSP Server Definitions for pi-lens
 * 
 * Defines 40+ language servers with:
 * - Root detection (monorepo support)
 * - Auto-installation strategies
 * - Platform-specific handling
 */

import path from "path";
import { launchLSP, launchViaPackageManager, launchViaNode, type LSPProcess } from "./launch.js";
import { ensureTool, getToolPath, getToolEnvironment } from "../installer/index.js";

// --- Types ---

export type RootFunction = (file: string) => Promise<string | undefined>;

export interface LSPServerInfo {
	id: string;
	name: string;
	extensions: string[];
	root: RootFunction;
	spawn(root: string): Promise<{ process: LSPProcess; initialization?: Record<string, unknown> } | undefined>;
	autoInstall?: () => Promise<boolean>;
}

// --- Root Detection Helpers ---

import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Walk up the tree looking for project root markers
 */
export function createRootDetector(
	includePatterns: string[],
	excludePatterns?: string[]
): RootFunction {
	return async (file: string): Promise<string | undefined> => {
		let currentDir = path.dirname(file);
		const root = path.parse(currentDir).root;

		while (currentDir !== root) {
			// Check exclude patterns first
			if (excludePatterns) {
				for (const pattern of excludePatterns) {
					const checkPath = path.join(currentDir, pattern);
					try {
						const stat = await import("fs/promises").then(fs => fs.stat(checkPath));
						if (stat) return undefined; // Excluded
					} catch { /* not found */ }
				}
			}

			// Check include patterns
			for (const pattern of includePatterns) {
				const checkPath = path.join(currentDir, pattern);
				try {
					const stat = await import("fs/promises").then(fs => fs.stat(checkPath));
					if (stat) return currentDir;
				} catch { /* not found */ }
			}

			currentDir = path.dirname(currentDir);
		}

		return undefined;
	};
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
	async spawn(root) {
		// Ensure typescript-language-server is installed
		const toolPath = await ensureTool("typescript-language-server");
		if (!toolPath) {
			console.error("[lsp] typescript-language-server not found and could not be installed");
			return undefined;
		}

		// Use the installed tool
		const env = await getToolEnvironment();
		const proc = launchLSP("typescript-language-server", ["--stdio"], { cwd: root, env });
		return { process: proc };
	},
};

export const PythonServer: LSPServerInfo = {
	id: "python",
	name: "Pyright Language Server",
	extensions: [".py", ".pyi"],
	root: createRootDetector([
		"pyproject.toml",
		"setup.py",
		"setup.cfg",
		"requirements.txt",
		"Pipfile",
		"poetry.lock",
	]),
	async spawn(root) {
		// Ensure pyright is installed
		const toolPath = await ensureTool("pyright");
		if (!toolPath) {
			console.error("[lsp] pyright not found and could not be installed");
			return undefined;
		}

		const env = await getToolEnvironment();
		const proc = launchLSP("pyright-langserver", ["--stdio"], { cwd: root, env });
		
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
				const pythonPath = process.platform === "win32"
					? path.join(venv, "Scripts", "python.exe")
					: path.join(venv, "bin", "python");
				
				await import("fs/promises").then(fs => fs.access(pythonPath));
				initialization.python = { pythonPath };
				break;
			} catch { /* not found */ }
		}

		return { process: proc, initialization };
	},
};

export const GoServer: LSPServerInfo = {
	id: "go",
	name: "gopls",
	extensions: [".go"],
	root: createRootDetector(["go.mod", "go.sum"]),
	async spawn(root) {
		const proc = launchLSP("gopls", [], { cwd: root });
		return { process: proc };
	},
};

export const RustServer: LSPServerInfo = {
	id: "rust",
	name: "rust-analyzer",
	extensions: [".rs"],
	root: createRootDetector(["Cargo.toml", "Cargo.lock"]),
	async spawn(root) {
		const proc = launchLSP("rust-analyzer", [], { cwd: root });
		return { process: proc };
	},
};

export const RubyServer: LSPServerInfo = {
	id: "ruby",
	name: "Ruby LSP",
	extensions: [".rb", ".rake", ".gemspec", ".ru"],
	root: createRootDetector(["Gemfile", ".ruby-version"]),
	async spawn(root) {
		// Try ruby-lsp first, fall back to solargraph
		try {
			const proc = launchLSP("ruby-lsp", [], { cwd: root });
			return { process: proc };
		} catch {
			const proc = launchViaPackageManager("solargraph", ["stdio"], { cwd: root });
			return { process: proc };
		}
	},
};

export const PHPServer: LSPServerInfo = {
	id: "php",
	name: "Intelephense",
	extensions: [".php"],
	root: createRootDetector(["composer.json", "composer.lock"]),
	async spawn(root) {
		const proc = launchViaPackageManager("intelephense", ["--stdio"], { cwd: root });
		return { process: proc, initialization: { storagePath: path.join(__dirname, ".intelephense") } };
	},
};

export const CSharpServer: LSPServerInfo = {
	id: "csharp",
	name: "csharp-ls",
	extensions: [".cs"],
	root: createRootDetector([".sln", ".csproj", ".slnx"]),
	async spawn(root) {
		const proc = launchLSP("csharp-ls", [], { cwd: root });
		return { process: proc };
	},
};

export const FSharpServer: LSPServerInfo = {
	id: "fsharp",
	name: "FSAutocomplete",
	extensions: [".fs", ".fsi", ".fsx"],
	root: createRootDetector([".sln", ".fsproj"]),
	async spawn(root) {
		const proc = launchLSP("fsautocomplete", [], { cwd: root });
		return { process: proc };
	},
};

export const JavaServer: LSPServerInfo = {
	id: "java",
	name: "JDT Language Server",
	extensions: [".java"],
	root: createRootDetector(["pom.xml", "build.gradle", ".classpath"]),
	async spawn(root) {
		// JDTLS requires special handling - paths to launcher jar
		const jdtlsPath = process.env.JDTLS_PATH || "jdtls";
		const proc = launchLSP(jdtlsPath, [], { cwd: root });
		return { process: proc };
	},
};

export const KotlinServer: LSPServerInfo = {
	id: "kotlin",
	name: "Kotlin Language Server",
	extensions: [".kt", ".kts"],
	root: createRootDetector(["build.gradle.kts", "build.gradle", "pom.xml"]),
	async spawn(root) {
		const proc = launchLSP("kotlin-language-server", [], { cwd: root });
		return { process: proc };
	},
};

export const SwiftServer: LSPServerInfo = {
	id: "swift",
	name: "SourceKit-LSP",
	extensions: [".swift"],
	root: createRootDetector(["Package.swift"]),
	async spawn(root) {
		const proc = launchLSP("sourcekit-lsp", [], { cwd: root });
		return { process: proc };
	},
};

export const DartServer: LSPServerInfo = {
	id: "dart",
	name: "Dart Analysis Server",
	extensions: [".dart"],
	root: createRootDetector(["pubspec.yaml"]),
	async spawn(root) {
		const proc = launchLSP("dart", ["language-server", "--protocol=lsp"], { cwd: root });
		return { process: proc };
	},
};

export const LuaServer: LSPServerInfo = {
	id: "lua",
	name: "Lua Language Server",
	extensions: [".lua"],
	root: createRootDetector([".luarc.json", ".luacheckrc"]),
	async spawn(root) {
		const proc = launchLSP("lua-language-server", [], { cwd: root });
		return { process: proc };
	},
};

export const CppServer: LSPServerInfo = {
	id: "cpp",
	name: "clangd",
	extensions: [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp"],
	root: createRootDetector([
		"compile_commands.json",
		".clangd",
		"CMakeLists.txt",
		"Makefile",
	]),
	async spawn(root) {
		const proc = launchLSP("clangd", ["--background-index"], { cwd: root });
		return { process: proc };
	},
};

export const ZigServer: LSPServerInfo = {
	id: "zig",
	name: "ZLS",
	extensions: [".zig", ".zon"],
	root: createRootDetector(["build.zig"]),
	async spawn(root) {
		const proc = launchLSP("zls", [], { cwd: root });
		return { process: proc };
	},
};

export const HaskellServer: LSPServerInfo = {
	id: "haskell",
	name: "Haskell Language Server",
	extensions: [".hs", ".lhs"],
	root: createRootDetector(["stack.yaml", "cabal.project", "*.cabal"]),
	async spawn(root) {
		const proc = launchLSP("haskell-language-server-wrapper", ["--lsp"], { cwd: root });
		return { process: proc };
	},
};

export const ElixirServer: LSPServerInfo = {
	id: "elixir",
	name: "ElixirLS",
	extensions: [".ex", ".exs"],
	root: createRootDetector(["mix.exs"]),
	async spawn(root) {
		const proc = launchLSP("elixir-ls", [], { cwd: root });
		return { process: proc };
	},
};

export const GleamServer: LSPServerInfo = {
	id: "gleam",
	name: "Gleam LSP",
	extensions: [".gleam"],
	root: createRootDetector(["gleam.toml"]),
	async spawn(root) {
		const proc = launchLSP("gleam", ["lsp"], { cwd: root });
		return { process: proc };
	},
};

export const OCamlServer: LSPServerInfo = {
	id: "ocaml",
	name: "ocamllsp",
	extensions: [".ml", ".mli"],
	root: createRootDetector(["dune-project", "opam"]),
	async spawn(root) {
		const proc = launchLSP("ocamllsp", [], { cwd: root });
		return { process: proc };
	},
};

export const ClojureServer: LSPServerInfo = {
	id: "clojure",
	name: "Clojure LSP",
	extensions: [".clj", ".cljs", ".cljc", ".edn"],
	root: createRootDetector(["deps.edn", "project.clj"]),
	async spawn(root) {
		const proc = launchLSP("clojure-lsp", [], { cwd: root });
		return { process: proc };
	},
};

export const TerraformServer: LSPServerInfo = {
	id: "terraform",
	name: "Terraform LSP",
	extensions: [".tf", ".tfvars"],
	root: createRootDetector([".terraform.lock.hcl"]),
	async spawn(root) {
		const proc = launchLSP("terraform-ls", ["serve"], { cwd: root });
		return { process: proc };
	},
};

export const NixServer: LSPServerInfo = {
	id: "nix",
	name: "nixd",
	extensions: [".nix"],
	root: createRootDetector(["flake.nix"]),
	async spawn(root) {
		const proc = launchLSP("nixd", [], { cwd: root });
		return { process: proc };
	},
};

export const BashServer: LSPServerInfo = {
	id: "bash",
	name: "Bash Language Server",
	extensions: [".sh", ".bash", ".zsh"],
	root: async () => process.cwd(),
	async spawn() {
		const proc = launchViaPackageManager("bash-language-server", ["start"], {});
		return { process: proc };
	},
};

export const DockerServer: LSPServerInfo = {
	id: "docker",
	name: "Dockerfile Language Server",
	extensions: [".dockerfile", "Dockerfile"],
	root: async () => process.cwd(),
	async spawn() {
		const proc = launchViaPackageManager("dockerfile-language-server-nodejs", ["--stdio"], {});
		return { process: proc };
	},
};

export const YamlServer: LSPServerInfo = {
	id: "yaml",
	name: "YAML Language Server",
	extensions: [".yaml", ".yml"],
	root: async () => process.cwd(),
	async spawn() {
		const proc = launchViaPackageManager("yaml-language-server", ["--stdio"], {});
		return { process: proc };
	},
};

export const JsonServer: LSPServerInfo = {
	id: "json",
	name: "VSCode JSON Language Server",
	extensions: [".json", ".jsonc"],
	root: async () => process.cwd(),
	async spawn() {
		const proc = launchViaPackageManager("vscode-json-languageserver", ["--stdio"], {});
		return { process: proc };
	},
};

export const PrismaServer: LSPServerInfo = {
	id: "prisma",
	name: "Prisma Language Server",
	extensions: [".prisma"],
	root: createRootDetector(["prisma/schema.prisma"]),
	async spawn(root) {
		const proc = launchViaPackageManager("@prisma/language-server", ["--stdio"], { cwd: root });
		return { process: proc };
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
