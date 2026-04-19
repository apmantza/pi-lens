/**
 * Interactive LSP Installer
 *
 * Provides lazy auto-install with user prompt for common languages.
 *
 * Features:
 * - 30-second timeout with auto-accept
 * - --auto-install flag for non-interactive mode
 * - User choice caching per project
 * - Only prompts for "common" languages (Go, Rust, YAML, JSON, Bash)
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

function canUseInteractivePrompt(): boolean {
	return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function isToolOnPath(toolId: string): Promise<boolean> {
	const locator = process.platform === "win32" ? "where" : "which";

	return new Promise((resolve) => {
		const proc = spawn(locator, [toolId], { stdio: "ignore", shell: false });
		proc.on("close", (code) => resolve(code === 0));
		proc.on("error", () => resolve(false));
	});
}

/**
 * Install strategy:
 * - "npm":    npm install -g <packageName>  (managed by pi-lens, goes into .pi-lens/tools)
 * - "shell":  run installCommand verbatim in a shell  (gem, dotnet, brew, etc.)
 * - "manual": can't auto-install — show installCommand and tell the user to run it
 */
type InstallStrategy = "npm" | "shell" | "manual";

interface LanguageConfig {
	toolId: string;
	toolName: string;
	/** Shown to user and used as the shell command for "shell" strategy */
	installCommand: string;
	/** npm package name — required for "npm" strategy */
	packageName?: string;
	installStrategy: InstallStrategy;
}

// Languages that support interactive auto-install prompt
const COMMON_LANGUAGES: Record<string, LanguageConfig> = {
	// --- Originally supported ---
	go: {
		toolId: "gopls",
		toolName: "Go Language Server (gopls)",
		installCommand: "go install golang.org/x/tools/gopls@latest",
		installStrategy: "shell",
	},
	rust: {
		toolId: "rust-analyzer",
		toolName: "Rust Language Server (rust-analyzer)",
		installCommand: "rustup component add rust-analyzer",
		installStrategy: "shell",
	},
	yaml: {
		toolId: "yaml-language-server",
		toolName: "YAML Language Server",
		installCommand: "npm install -g yaml-language-server",
		packageName: "yaml-language-server",
		installStrategy: "npm",
	},
	json: {
		toolId: "vscode-json-language-server",
		toolName: "JSON Language Server",
		installCommand: "npm install -g vscode-langservers-extracted",
		packageName: "vscode-langservers-extracted",
		installStrategy: "npm",
	},
	bash: {
		toolId: "bash-language-server",
		toolName: "Bash Language Server",
		installCommand: "npm install -g bash-language-server",
		packageName: "bash-language-server",
		installStrategy: "npm",
	},
	// --- Tier-4: previously silent on ENOENT ---
	ruby: {
		toolId: "ruby-lsp",
		toolName: "Ruby LSP",
		installCommand: "gem install ruby-lsp",
		installStrategy: "shell",
	},
	php: {
		toolId: "intelephense",
		toolName: "PHP Language Server (Intelephense)",
		installCommand: "npm install -g intelephense",
		packageName: "intelephense",
		installStrategy: "npm",
	},
	csharp: {
		toolId: "csharp-ls",
		toolName: "C# Language Server (csharp-ls)",
		installCommand: "dotnet tool install -g csharp-ls",
		installStrategy: "shell",
	},
	fsharp: {
		toolId: "fsautocomplete",
		toolName: "F# Language Server (FSAutocomplete)",
		installCommand: "dotnet tool install -g fsautocomplete",
		installStrategy: "shell",
	},
	java: {
		toolId: "jdtls",
		toolName: "Java Language Server (Eclipse JDT LS)",
		installCommand:
			"brew install jdtls  # or: https://github.com/eclipse-jdtls/eclipse.jdt.ls",
		installStrategy: "manual",
	},
	kotlin: {
		toolId: "kotlin-language-server",
		toolName: "Kotlin Language Server",
		installCommand:
			"brew install kotlin-language-server  # or: https://github.com/fwcd/kotlin-language-server",
		installStrategy: "manual",
	},
	swift: {
		toolId: "sourcekit-lsp",
		toolName: "Swift Language Server (SourceKit-LSP)",
		installCommand:
			"xcode-select --install  # bundled with Xcode / Swift toolchain",
		installStrategy: "manual",
	},
	dart: {
		toolId: "dart",
		toolName: "Dart Language Server",
		installCommand: "# Install Dart SDK: https://dart.dev/get-dart",
		installStrategy: "manual",
	},
	lua: {
		toolId: "lua-language-server",
		toolName: "Lua Language Server",
		installCommand: "brew install lua-language-server",
		installStrategy: "shell",
	},
	cpp: {
		toolId: "clangd",
		toolName: "C/C++ Language Server (clangd)",
		installCommand: "brew install llvm  # or: apt install clangd",
		installStrategy: "manual",
	},
	zig: {
		toolId: "zls",
		toolName: "Zig Language Server (ZLS)",
		installCommand: "brew install zls",
		installStrategy: "shell",
	},
	haskell: {
		toolId: "haskell-language-server-wrapper",
		toolName: "Haskell Language Server",
		installCommand: "ghcup install hls",
		installStrategy: "shell",
	},
	elixir: {
		toolId: "elixir-ls",
		toolName: "Elixir Language Server (ElixirLS)",
		installCommand:
			"# Download from: https://github.com/elixir-lsp/elixir-ls/releases",
		installStrategy: "manual",
	},
	gleam: {
		toolId: "gleam",
		toolName: "Gleam Language Server",
		installCommand: "brew install gleam",
		installStrategy: "shell",
	},
	ocaml: {
		toolId: "ocamllsp",
		toolName: "OCaml Language Server (ocamllsp)",
		installCommand: "opam install ocaml-lsp-server",
		installStrategy: "shell",
	},
	clojure: {
		toolId: "clojure-lsp",
		toolName: "Clojure Language Server",
		installCommand: "brew install clojure-lsp/brew/clojure-lsp",
		installStrategy: "shell",
	},
	terraform: {
		toolId: "terraform-ls",
		toolName: "Terraform Language Server",
		installCommand: "brew install hashicorp/tap/terraform-ls",
		installStrategy: "shell",
	},
	nix: {
		toolId: "nixd",
		toolName: "Nix Language Server (nixd)",
		installCommand: "nix profile install nixpkgs#nixd",
		installStrategy: "shell",
	},
};

interface InstallChoice {
	choice: "yes" | "no" | "auto";
	timestamp: number;
}

/**
 * Get the cache file path for install choices
 */
function getCachePath(cwd: string): string {
	return path.join(cwd, ".pi-lens", "install-choices.json");
}

/**
 * Read cached install choices
 */
async function readChoices(
	cwd: string,
): Promise<Record<string, InstallChoice>> {
	try {
		const cachePath = getCachePath(cwd);
		const content = await fs.readFile(cachePath, "utf-8");
		return JSON.parse(content);
	} catch {
		return {};
	}
}

/**
 * Save install choice to cache
 */
async function saveChoice(
	cwd: string,
	toolId: string,
	choice: "yes" | "no" | "auto",
): Promise<void> {
	const choices = await readChoices(cwd);
	choices[toolId] = { choice, timestamp: Date.now() };

	try {
		const cachePath = getCachePath(cwd);
		await fs.mkdir(path.dirname(cachePath), { recursive: true });
		await fs.writeFile(cachePath, JSON.stringify(choices, null, 2));
	} catch {
		// Ignore cache write errors
	}
}

/**
 * Prompt user with timeout
 */
function promptUser(timeoutMs: number): Promise<"yes" | "no"> {
	return new Promise((resolve) => {
		// Set up stdin for single char input
		process.stdin.setRawMode?.(true);
		process.stdin.resume();
		process.stdin.setEncoding("utf8");

		const onData = (data: Buffer | string) => {
			const char = data.toString().trim().toLowerCase();
			cleanup();

			if (char === "y" || char === "\n" || char === "\r") {
				resolve("yes");
			} else if (char === "n") {
				resolve("no");
			}
			// For any other input, auto-accept after timeout
		};

		process.stdin.on("data", onData);

		// Auto-decline after timeout
		const timeout = setTimeout(() => {
			cleanup();
			resolve("no");
		}, timeoutMs);

		// Handle stdin closing
		process.stdin.on("end", () => {
			cleanup();
			resolve("no");
		});

		function cleanup() {
			clearTimeout(timeout);
			process.stdin.removeListener("data", onData);
			process.stdin.setRawMode?.(false);
			process.stdin.pause();
		}
	});
}

/**
 * Check if --auto-install flag is set
 */
function isAutoInstallEnabled(): boolean {
	// Check environment variable or process arguments
	return (
		process.env.PI_LENS_AUTO_INSTALL === "1" ||
		process.argv.includes("--auto-install")
	);
}

/**
 * Attempt to install a tool using the configured strategy.
 *
 * - "npm":    npm install -g <packageName>
 * - "shell":  run installCommand verbatim via shell (gem, dotnet, brew, etc.)
 * - "manual": can't auto-install — print the command and return false
 */
async function installTool(config: LanguageConfig): Promise<boolean> {
	const { toolId, toolName, installCommand, packageName, installStrategy } =
		config;

	if (installStrategy === "manual") {
		return false;
	}

	const [cmd, ...args] =
		installStrategy === "npm" && packageName
			? ["npm", "install", "-g", packageName]
			: process.platform === "win32"
				? ["powershell", "-NoProfile", "-Command", installCommand]
				: ["sh", "-c", installCommand];

	return new Promise((resolve) => {
		const proc = spawn(cmd, args, { stdio: "inherit", shell: false });

		proc.on("close", (code) => {
			if (code === 0) {
				resolve(true);
			} else {
				resolve(false);
			}
		});

		proc.on("error", () => {
			resolve(false);
		});
	});
}

/**
 * Prompt user for installation with timeout, or auto-install if flag set
 *
 * @param language - Language identifier (go, rust, yaml, json, bash)
 * @param cwd - Project root
 * @returns true if tool is/should be installed, false to skip
 */
export async function promptForInstall(
	language: string,
	cwd: string,
): Promise<boolean> {
	const config = COMMON_LANGUAGES[language];
	if (!config) {
		// Not a common language, don't prompt
		return false;
	}

	// Check cache first
	const choices = await readChoices(cwd);
	const cached = choices[config.toolId];

	if (cached) {
		// Cache valid for 30 days
		const thirtyDays = 30 * 24 * 60 * 60 * 1000;
		if (Date.now() - cached.timestamp < thirtyDays) {
			if (cached.choice === "yes" || cached.choice === "auto") {
				const toolAvailable = await isToolOnPath(config.toolId);
				if (toolAvailable) {
					return true;
				}
			} else {
				return false; // User previously declined
			}
		}
	}

	// Check auto-install flag
	if (isAutoInstallEnabled()) {
		await saveChoice(cwd, config.toolId, "auto");
		return installTool(config);
	}

	if (!canUseInteractivePrompt()) {
		return false;
	}

	// For manual-only tools, skip the Y/n prompt because user must install manually.
	if (config.installStrategy === "manual") {
		await saveChoice(cwd, config.toolId, "no");
		return false;
	}
	const answer = await promptUser(10000);
	await saveChoice(cwd, config.toolId, answer);

	if (answer === "yes") {
		return installTool(config);
	}
	return false;
}

/**
 * Get install command for display purposes
 */
export function getInstallCommand(language: string): string | undefined {
	return COMMON_LANGUAGES[language]?.installCommand;
}

/**
 * Get install strategy for a language (exposed for testing)
 */
export function getInstallStrategy(
	language: string,
): InstallStrategy | undefined {
	return COMMON_LANGUAGES[language]?.installStrategy;
}

/**
 * Check if a language supports interactive install
 */
export function supportsInteractiveInstall(language: string): boolean {
	return language in COMMON_LANGUAGES;
}



