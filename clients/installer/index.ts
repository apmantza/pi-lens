/**
 * Auto-Installation System for pi-lens
 *
 * Minimal auto-install: Core tools that run frequently.
 * Other tools require manual installation with clear instructions.
 *
 * Auto-install (21 tools):
 * - typescript-language-server (TypeScript LSP)
 * - pyright (Python LSP)
 * - bash-language-server (Bash LSP)
 * - yaml-language-server (YAML LSP)
 * - vscode-langservers-extracted (JSON LSP)
 * - ruff (Python linting)
 * - @biomejs/biome (JS/TS/JSON linting/formatting)
 * - oxlint (JS/TS linting)
 * - madge (circular dependency detection)
 * - jscpd (duplicate code detection)
 * - @ast-grep/cli (structural code search)
 * - knip (dead code detection)
 * - yamllint (YAML linting)
 * - sqlfluff (SQL linting/formatting)
 * - markdownlint-cli2 (Markdown linting)
 * - mypy (Python type checking)
 * - stylelint (CSS/SCSS/Less linting)
 * - shellcheck (shell script linting) [GitHub release]
 * - shfmt (shell script formatting) [GitHub release]
 * - rust-analyzer (Rust LSP) [GitHub release]
 * - golangci-lint (Go linting) [GitHub release]
 *
 * Manual install required (25+ tools):
 * - yaml-language-server: npm install -g yaml-language-server
 * - vscode-json-languageserver: npm install -g vscode-langservers-extracted
 * - bash-language-server: npm install -g bash-language-server
 * - svelte-language-server: npm install -g svelte-language-server
 * - vscode-eslint-language-server: npm install -g vscode-langservers-extracted
 * - vscode-css-languageserver: npm install -g vscode-langservers-extracted
 * - @prisma/language-server: npm install -g @prisma/language-server
 * - dockerfile-language-server: npm install -g dockerfile-language-server-nodejs
 * - @vue/language-server: npm install -g @vue/language-server
 * - And all language-specific servers (gopls, rust-analyzer, etc.)
 *
 * Strategies:
 * - npm packages via npx/bun
 * - pip packages
 * - GitHub releases (platform-specific binaries → ~/.pi-lens/bin/)
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { createGunzip } from "node:zlib";

// Global installation directory for pi-lens tools
const TOOLS_DIR = path.join(os.homedir(), ".pi-lens", "tools");

// Directory for GitHub-downloaded binaries
const GITHUB_BIN_DIR = path.join(os.homedir(), ".pi-lens", "bin");

// Debug flag - set via PI_LENS_DEBUG=1 or --debug
const DEBUG =
	process.env.PI_LENS_DEBUG === "1" || process.argv.includes("--debug");
const SESSIONSTART_LOG_DIR = path.join(os.homedir(), ".pi-lens");
const SESSIONSTART_LOG = path.join(SESSIONSTART_LOG_DIR, "sessionstart.log");

/**
 * Log debug messages only when DEBUG is enabled
 */
function debugLog(...args: unknown[]): void {
	if (DEBUG) {
		console.error("[auto-install:debug]", ...args);
	}
}

function logSessionStart(msg: string): void {
	const line = `[${new Date().toISOString()}] ${msg}\n`;
	void fs
		.mkdir(SESSIONSTART_LOG_DIR, { recursive: true })
		.then(() => fs.appendFile(SESSIONSTART_LOG, line))
		.catch(() => {
			// best-effort logging
		});
}

// --- Tool Definitions ---

interface GitHubAssetSpec {
	/** owner/repo on GitHub */
	repo: string;
	/**
	 * Return the asset filename substring to match for this platform/arch,
	 * or undefined if the platform is unsupported.
	 * platform: "linux" | "darwin" | "win32"
	 * arch:     "x64" | "arm64" | "ia32" | ...
	 */
	assetMatch: (platform: string, arch: string) => string | undefined;
	/**
	 * If the asset is an archive, the name of the binary inside it.
	 * For bare .gz files (e.g. rust-analyzer) leave undefined — the asset IS the binary.
	 */
	binaryInArchive?: string;
	hashiCorpReleaseProduct?: string;
}

interface ToolDefinition {
	id: string;
	name: string;
	checkCommand: string;
	checkArgs: string[];
	installStrategy: "npm" | "pip" | "github";
	packageName?: string;
	binaryName?: string;
	github?: GitHubAssetSpec;
}

const TOOLS: ToolDefinition[] = [
	// Core LSP servers
	{
		id: "typescript-language-server",
		name: "TypeScript Language Server",
		checkCommand: "typescript-language-server",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "typescript-language-server",
		binaryName: "typescript-language-server",
	},
	{
		id: "typescript",
		name: "TypeScript",
		checkCommand: "tsc",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "typescript",
		binaryName: "tsc",
	},
	{
		id: "pyright",
		name: "Pyright",
		checkCommand: "pyright",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "pyright",
		binaryName: "pyright",
	},
	// Linting/formatting tools
	{
		id: "prettier",
		name: "Prettier",
		checkCommand: "prettier",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "prettier",
		binaryName: "prettier",
	},
	{
		id: "ruff",
		name: "Ruff",
		checkCommand: "ruff",
		checkArgs: ["--version"],
		installStrategy: "pip",
		packageName: "ruff",
		binaryName: "ruff",
	},
	{
		id: "biome",
		name: "Biome",
		checkCommand: "biome",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "@biomejs/biome",
		binaryName: "biome",
	},
	// Analysis tools (run at session start / turn end)
	{
		id: "madge",
		name: "Madge",
		checkCommand: "madge",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "madge",
		binaryName: "madge",
	},
	{
		id: "jscpd",
		name: "jscpd",
		checkCommand: "jscpd",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "jscpd@3.5.10", // jscpd v4 introduced reprism dep whose lib/languages/ dir is missing from the published package — v3.5.x is the last stable release
		binaryName: "jscpd",
	},
	// Structural search and dead code detection
	{
		id: "ast-grep",
		name: "ast-grep CLI",
		checkCommand: "sg",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "@ast-grep/cli",
		binaryName: "sg",
	},
	{
		id: "knip",
		name: "Knip",
		checkCommand: "knip",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "knip",
		binaryName: "knip",
	},
	{
		id: "yamllint",
		name: "yamllint",
		checkCommand: "yamllint",
		checkArgs: ["--version"],
		installStrategy: "pip",
		packageName: "yamllint",
		binaryName: "yamllint",
	},
	{
		id: "sqlfluff",
		name: "sqlfluff",
		checkCommand: "sqlfluff",
		checkArgs: ["--version"],
		installStrategy: "pip",
		packageName: "sqlfluff",
		binaryName: "sqlfluff",
	},
	{
		id: "bash-language-server",
		name: "Bash Language Server",
		checkCommand: "bash-language-server",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "bash-language-server",
		binaryName: "bash-language-server",
	},
	{
		id: "yaml-language-server",
		name: "YAML Language Server",
		checkCommand: "yaml-language-server",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "yaml-language-server",
		binaryName: "yaml-language-server",
	},
	{
		id: "vscode-json-language-server",
		name: "VSCode JSON Language Server",
		checkCommand: "vscode-json-language-server",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "vscode-langservers-extracted",
		binaryName: "vscode-json-language-server",
	},
	{
		id: "vscode-langservers-extracted",
		name: "VSCode ESLint Language Server",
		checkCommand: "vscode-eslint-language-server",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "vscode-langservers-extracted",
		binaryName: "vscode-eslint-language-server",
	},
	{
		id: "vscode-html-languageserver-bin",
		name: "VSCode HTML Language Server",
		checkCommand: "vscode-html-language-server",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "vscode-html-languageserver-bin",
		binaryName: "vscode-html-language-server",
	},
	{
		id: "htmlhint",
		name: "HTMLHint",
		checkCommand: "htmlhint",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "htmlhint",
		binaryName: "htmlhint",
	},
	{
		id: "hadolint",
		name: "Hadolint",
		checkCommand: "hadolint",
		checkArgs: ["--version"],
		installStrategy: "github",
		binaryName: "hadolint",
		github: {
			repo: "hadolint/hadolint",
			assetMatch: (platform, arch) => {
				if (platform === "linux")
					return arch === "arm64" ? "linux.aarch64" : "linux.x86_64";
				if (platform === "darwin")
					return arch === "arm64" ? "macos-arm64" : "macos-x86_64";
				if (platform === "win32") return "windows-x86_64.exe";
				return undefined;
			},
		},
	},
	{
		id: "vscode-css-languageserver",
		name: "VSCode CSS Language Server",
		checkCommand: "vscode-css-language-server",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "vscode-css-languageserver",
		binaryName: "vscode-css-language-server",
	},
	{
		id: "dockerfile-language-server-nodejs",
		name: "Dockerfile Language Server",
		checkCommand: "docker-langserver",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "dockerfile-language-server-nodejs",
		binaryName: "docker-langserver",
	},
	{
		id: "intelephense",
		name: "Intelephense",
		checkCommand: "intelephense",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "intelephense",
		binaryName: "intelephense",
	},
	{
		id: "@prisma/language-server",
		name: "Prisma Language Server",
		checkCommand: "prisma-language-server",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "@prisma/language-server",
		binaryName: "prisma-language-server",
	},
	{
		id: "@vue/language-server",
		name: "Vue Language Server",
		checkCommand: "vue-language-server",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "@vue/language-server",
		binaryName: "vue-language-server",
	},
	{
		id: "svelte-language-server",
		name: "Svelte Language Server",
		checkCommand: "svelteserver",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "svelte-language-server",
		binaryName: "svelteserver",
	},
	{
		id: "markdownlint",
		name: "markdownlint-cli2",
		checkCommand: "markdownlint-cli2",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "markdownlint-cli2",
		binaryName: "markdownlint-cli2",
	},
	{
		id: "mypy",
		name: "mypy",
		checkCommand: "mypy",
		checkArgs: ["--version"],
		installStrategy: "pip",
		packageName: "mypy",
		binaryName: "mypy",
	},
	{
		id: "stylelint",
		name: "Stylelint",
		checkCommand: "stylelint",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "stylelint",
		binaryName: "stylelint",
	},
	{
		id: "oxlint",
		name: "Oxlint",
		checkCommand: "oxlint",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "oxlint",
		binaryName: "oxlint",
	},
	// GitHub release binaries
	{
		id: "shellcheck",
		name: "ShellCheck",
		checkCommand: "shellcheck",
		checkArgs: ["--version"],
		installStrategy: "github",
		binaryName: "shellcheck",
		github: {
			repo: "koalaman/shellcheck",
			assetMatch: (platform, arch) => {
				if (platform === "linux")
					return arch === "arm64"
						? "linux.aarch64.tar.xz"
						: "linux.x86_64.tar.xz";
				if (platform === "darwin")
					return arch === "arm64"
						? "darwin.aarch64.tar.xz"
						: "darwin.x86_64.tar.xz";
				if (platform === "win32") return "zip";
				return undefined;
			},
			binaryInArchive: "shellcheck",
		},
	},
	{
		id: "shfmt",
		name: "shfmt",
		checkCommand: "shfmt",
		checkArgs: ["--version"],
		installStrategy: "github",
		binaryName: "shfmt",
		github: {
			repo: "mvdan/sh",
			assetMatch: (platform, arch) => {
				if (platform === "linux")
					return arch === "arm64" ? "linux_arm64" : "linux_amd64";
				if (platform === "darwin")
					return arch === "arm64" ? "darwin_arm64" : "darwin_amd64";
				if (platform === "win32")
					return arch === "arm64" ? "windows_arm64.exe" : "windows_amd64.exe";
				return undefined;
			},
			// bare binary, no archive
		},
	},
	{
		id: "rust-analyzer",
		name: "rust-analyzer",
		checkCommand: "rust-analyzer",
		checkArgs: ["--version"],
		installStrategy: "github",
		binaryName: "rust-analyzer",
		github: {
			repo: "rust-lang/rust-analyzer",
			assetMatch: (platform, arch) => {
				if (platform === "linux")
					return arch === "arm64"
						? "aarch64-unknown-linux-gnu.gz"
						: "x86_64-unknown-linux-gnu.gz";
				if (platform === "darwin")
					return arch === "arm64"
						? "aarch64-apple-darwin.gz"
						: "x86_64-apple-darwin.gz";
				if (platform === "win32") return "x86_64-pc-windows-msvc.zip";
				return undefined;
			},
			// Linux/macOS: bare .gz; Windows: .zip archive containing rust-analyzer.exe
		},
	},
	{
		id: "golangci-lint",
		name: "golangci-lint",
		checkCommand: "golangci-lint",
		checkArgs: ["--version"],
		installStrategy: "github",
		binaryName: "golangci-lint",
		github: {
			repo: "golangci/golangci-lint",
			assetMatch: (platform, arch) => {
				if (platform === "linux")
					return arch === "arm64" ? "linux-arm64.tar.gz" : "linux-amd64.tar.gz";
				if (platform === "darwin")
					return arch === "arm64"
						? "darwin-arm64.tar.gz"
						: "darwin-amd64.tar.gz";
				if (platform === "win32")
					return arch === "arm64" ? "windows-arm64.zip" : "windows-amd64.zip";
				return undefined;
			},
			binaryInArchive: "golangci-lint",
		},
	},
	{
		id: "ktlint",
		name: "ktlint",
		checkCommand: "ktlint",
		checkArgs: ["--version"],
		installStrategy: "github",
		binaryName: "ktlint",
		github: {
			// ktlint ships one universal binary "ktlint" for Linux/macOS (GraalVM native)
			// and "ktlint.bat" for Windows (requires Java). No arm64-specific asset.
			repo: "pinterest/ktlint",
			assetMatch: (platform, _arch) => {
				if (platform === "linux") return "ktlint";
				if (platform === "darwin") return "ktlint";
				if (platform === "win32") return "ktlint.bat";
				return undefined;
			},
		},
	},
	{
		id: "tflint",
		name: "tflint",
		checkCommand: "tflint",
		checkArgs: ["--version"],
		installStrategy: "github",
		binaryName: "tflint",
		github: {
			repo: "terraform-linters/tflint",
			assetMatch: (platform, arch) => {
				if (platform === "linux")
					return arch === "arm64" ? "linux_arm64.zip" : "linux_amd64.zip";
				if (platform === "darwin")
					return arch === "arm64" ? "darwin_arm64.zip" : "darwin_amd64.zip";
				if (platform === "win32")
					return arch === "arm64" ? "windows_arm64.zip" : "windows_amd64.zip";
				return undefined;
			},
			binaryInArchive: "tflint",
		},
	},
	{
		id: "taplo",
		name: "taplo",
		checkCommand: "taplo",
		checkArgs: ["--version"],
		installStrategy: "github",
		binaryName: "taplo",
		github: {
			repo: "tamasfe/taplo",
			assetMatch: (platform, arch) => {
				if (platform === "linux")
					return arch === "arm64"
						? "taplo-linux-aarch64.gz"
						: "taplo-linux-x86_64.gz";
				if (platform === "darwin")
					return arch === "arm64"
						? "taplo-darwin-aarch64.gz"
						: "taplo-darwin-x86_64.gz";
				if (platform === "win32") return "taplo-windows-x86_64.gz";
				return undefined;
			},
		},
	},
	{
		id: "terraform-ls",
		name: "terraform-ls",
		checkCommand: "terraform-ls",
		checkArgs: ["version"],
		installStrategy: "github",
		binaryName: "terraform-ls",
		github: {
			repo: "hashicorp/terraform-ls",
			hashiCorpReleaseProduct: "terraform-ls",
			assetMatch: (platform, arch) => {
				if (platform === "linux")
					return arch === "arm64" ? "linux_arm64.zip" : "linux_amd64.zip";
				if (platform === "darwin")
					return arch === "arm64" ? "darwin_arm64.zip" : "darwin_amd64.zip";
				if (platform === "win32")
					return arch === "arm64" ? "windows_arm64.zip" : "windows_amd64.zip";
				return undefined;
			},
			binaryInArchive: "terraform-ls",
		},
	},
	{
		id: "zls",
		name: "zls",
		checkCommand: "zls",
		checkArgs: ["--version"],
		installStrategy: "github",
		binaryName: "zls",
		github: {
			repo: "zigtools/zls",
			assetMatch: (platform, arch) => {
				if (platform === "linux")
					return arch === "arm64"
						? "aarch64-linux.tar.xz"
						: "x86_64-linux.tar.xz";
				if (platform === "darwin")
					return arch === "arm64"
						? "aarch64-macos.tar.xz"
						: "x86_64-macos.tar.xz";
				if (platform === "win32")
					return arch === "arm64"
						? "aarch64-windows.zip"
						: "x86_64-windows.zip";
				return undefined;
			},
			binaryInArchive: "zls",
		},
	},
];

const ensureInFlight = new Map<string, Promise<string | undefined>>();

// Session-lifetime cache: once a tool path is resolved, skip the process-spawn check on subsequent calls.
const resolvedPathCache = new Map<string, string>();

// --- Check Functions ---

/**
 * Check if a command is available in PATH
 */
async function isCommandAvailable(
	command: string,
	args: string[] = ["--version"],
): Promise<boolean> {
	return new Promise((resolve) => {
		// On Windows, use shell: true to handle .cmd files
		const isWindows = process.platform === "win32";
		const proc = isWindows
			? spawn(`${command} ${args.join(" ")}`, [], {
					stdio: "ignore",
					shell: true,
				})
			: spawn(command, args, { stdio: "ignore" });

		let resolved = false;
		const timeoutId = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				proc.kill();
				resolve(false);
			}
		}, 5000);

		proc.on("exit", (code) => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timeoutId);
				resolve(code === 0);
			}
		});
		proc.on("error", () => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timeoutId);
				resolve(false);
			}
		});
	});
}

// --- Verification Functions

/**
 * Verify a tool binary actually works by running --version
 * This catches broken symlinks, partial installs, and corrupted binaries
 */
async function verifyToolBinary(binPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const isWindows = process.platform === "win32";
		const hasKnownWindowsExt = /\.(cmd|exe|ps1)$/i.test(binPath);

		// On Windows, resolve the best executable path:
		// - extensionless → prefer .cmd (cmd.exe-safe)
		// - .ps1 → prefer .cmd sibling to avoid PowerShell execution-policy hangs
		// - .cmd / .exe → use as-is
		let execPath =
			isWindows && !hasKnownWindowsExt ? `${binPath}.cmd` : binPath;
		let useShell = isWindows && /\.(cmd|bat)$/i.test(execPath);

		if (isWindows && /\.ps1$/i.test(execPath)) {
			const cmdSibling = `${execPath.slice(0, -4)}.cmd`;
			if (require("node:fs").existsSync(cmdSibling)) {
				execPath = cmdSibling;
				useShell = true;
			} else {
				// Fall back to running without shell — cmd.exe can't run .ps1
				useShell = false;
			}
		}

		const proc = spawn(execPath, ["--version"], {
			timeout: 10000,
			stdio: ["ignore", "pipe", "pipe"],
			shell: useShell,
		});

		let stdout = "";
		let stderr = "";

		proc.stdout?.on("data", (data) => (stdout += data));
		proc.stderr?.on("data", (data) => (stderr += data));

		proc.on("exit", (code) => {
			if (code === 0) {
				debugLog(`Verified: ${binPath} (version: ${stdout.trim()})`);
				resolve(true);
			} else {
				logSessionStart(
					`auto-install verify: failed for ${binPath} (exit=${code})`,
				);
				resolve(false);
			}
		});

		proc.on("error", (err) => {
			logSessionStart(
				`auto-install verify: error for ${binPath}: ${err.message}`,
			);
			resolve(false);
		});
	});
}

export type ToolSource =
	| "global-path"
	| "npm-global"
	| "pip-user"
	| "pi-lens-auto"
	| "github-release"
	| "npx-fallback"
	| "not-installed";

export interface ToolStatus {
	id: string;
	name: string;
	installed: boolean;
	source: ToolSource;
	path?: string;
	version?: string;
	strategy: "npm" | "pip" | "github";
}

/**
 * Get detailed status for all tools
 */
export async function getAllToolStatuses(): Promise<ToolStatus[]> {
	const statuses: ToolStatus[] = [];

	for (const tool of TOOLS) {
		const status: ToolStatus = {
			id: tool.id,
			name: tool.name,
			installed: false,
			source: "not-installed",
			strategy: tool.installStrategy,
		};

		// 1. Check if in PATH (global)
		if (await isCommandAvailable(tool.checkCommand, tool.checkArgs)) {
			status.installed = true;
			status.source = "global-path";
			status.path = tool.checkCommand;
			// Try to get version
			const versionResult = await new Promise<string>((resolve) => {
				const proc = spawn(tool.checkCommand, ["--version"], {
					stdio: ["ignore", "pipe", "pipe"],
					shell: process.platform === "win32",
					timeout: 5000,
				});
				let out = "";
				proc.stdout?.on("data", (d) => (out += d));
				proc.stderr?.on("data", (d) => (out += d));
				proc.on("exit", () =>
					resolve(out.trim().split("\n")[0]?.slice(0, 30) || ""),
				);
				proc.on("error", () => resolve(""));
			});
			status.version = versionResult || undefined;
			statuses.push(status);
			continue;
		}

		// 2. Check npm global
		if (tool.installStrategy === "npm") {
			const npmPath = await findNpmGlobalToolPath(tool.binaryName || tool.id);
			if (npmPath) {
				status.installed = true;
				status.source = "npm-global";
				status.path = npmPath;
				statuses.push(status);
				continue;
			}
		}

		// 3. Check pip user install
		if (tool.installStrategy === "pip") {
			const pipPath = await findPipUserToolPath(tool.binaryName || tool.id);
			if (pipPath) {
				status.installed = true;
				status.source = "pip-user";
				status.path = pipPath;
				statuses.push(status);
				continue;
			}
		}

		// 4. Check GitHub releases (~/.pi-lens/bin/)
		if (tool.installStrategy === "github") {
			const githubPath = await findGitHubToolPath(tool.binaryName || tool.id);
			if (githubPath) {
				status.installed = true;
				status.source = "github-release";
				status.path = githubPath;
				statuses.push(status);
				continue;
			}
		}

		// 5. Check pi-lens auto-install (~/.pi-lens/tools/)
		const localBase = path.join(
			TOOLS_DIR,
			"node_modules",
			".bin",
			tool.binaryName || tool.id,
		);
		const localPath =
			process.platform === "win32" ? `${localBase}.cmd` : localBase;
		try {
			await fs.access(localPath);
			if (await verifyToolBinary(localPath)) {
				status.installed = true;
				status.source = "pi-lens-auto";
				status.path = localPath;
				statuses.push(status);
				continue;
			}
		} catch {
			// fall through to not-installed
		}

		// 6. Not installed - will use npx fallback if npm strategy
		if (tool.installStrategy === "npm") {
			status.source = "npx-fallback";
		}

		statuses.push(status);
	}

	return statuses;
}

/**
 * Check if a tool is installed (globally or locally)
 */
export async function isToolInstalled(toolId: string): Promise<boolean> {
	return (await getToolPath(toolId)) !== undefined;
}

/**
 * Get the path to a tool (global or local)
 */
export async function getToolPath(toolId: string): Promise<string | undefined> {
	const tool = TOOLS.find((t) => t.id === toolId);
	if (!tool) return undefined;

	// Fast path: check local npm install first (where auto-install places tools).
	// This avoids the ~2-5s overhead of spawning npm global probes and PATH
	// searches for tools we already manage locally.
	const localBase = path.join(
		TOOLS_DIR,
		"node_modules",
		".bin",
		tool.binaryName || tool.id,
	);
	if (process.platform === "win32") {
		// Prefer .cmd over extensionless — Node.js can't execute POSIX shell scripts on Windows
		const cmdPath = `${localBase}.cmd`;
		try {
			await fs.access(cmdPath);
			if (await verifyToolBinary(cmdPath)) {
				return cmdPath;
			}
			logSessionStart(
				`auto-install verify: ${cmdPath} exists but is broken, will reinstall`,
			);
		} catch {
			// fall through to .exe
		}
		// Also check .exe — some postinstall scripts (e.g. @ast-grep/cli) place a
		// .exe directly without a .cmd wrapper
		const exePath = `${localBase}.exe`;
		try {
			await fs.access(exePath);
			if (await verifyToolBinary(exePath)) {
				return exePath;
			}
			logSessionStart(
				`auto-install verify: ${exePath} exists but is broken, will reinstall`,
			);
		} catch {
			// fall through to extensionless
		}
	}
	try {
		await fs.access(localBase);
		if (await verifyToolBinary(localBase)) {
			return localBase;
		}
		logSessionStart(
			`auto-install verify: ${localBase} exists but is broken, will reinstall`,
		);
	} catch {
		// fall through to global checks
	}

	// Check if global
	if (await isCommandAvailable(tool.checkCommand, tool.checkArgs)) {
		return tool.checkCommand;
	}

	if (tool.installStrategy === "npm") {
		const npmPath = await findNpmGlobalToolPath(tool.binaryName || tool.id);
		if (npmPath) {
			return npmPath;
		}
	}

	// For pip tools, also probe user-level script locations
	if (tool.installStrategy === "pip") {
		const pipPath = await findPipUserToolPath(tool.binaryName || tool.id);
		if (pipPath) {
			return pipPath;
		}
	}

	// For github-strategy tools, probe ~/.pi-lens/bin/
	if (tool.installStrategy === "github") {
		const githubPath = await findGitHubToolPath(tool.binaryName || tool.id);
		if (githubPath) return githubPath;
		return undefined;
	}

	return undefined;
}

async function findGitHubToolPath(
	binaryName: string,
): Promise<string | undefined> {
	const isWindows = process.platform === "win32";
	const candidates = isWindows
		? [
				path.join(GITHUB_BIN_DIR, `${binaryName}.exe`),
				path.join(GITHUB_BIN_DIR, `${binaryName}.bat`),
				path.join(GITHUB_BIN_DIR, `${binaryName}.cmd`),
				path.join(GITHUB_BIN_DIR, binaryName),
			]
		: [path.join(GITHUB_BIN_DIR, binaryName)];

	for (const candidate of candidates) {
		try {
			await fs.access(candidate);
			return candidate;
		} catch {
			// continue
		}
	}
	return undefined;
}

function hasExecutableExtension(name: string): boolean {
	return /\.(exe|bat|cmd|ps1)$/i.test(name);
}

function getGitHubInstalledBinaryName(
	binaryName: string,
	platform: string,
	assetName: string,
): string {
	if (platform !== "win32") return binaryName;
	if (hasExecutableExtension(binaryName)) return binaryName;
	if (assetName.endsWith(".bat")) return `${binaryName}.bat`;
	if (assetName.endsWith(".cmd")) return `${binaryName}.cmd`;
	return `${binaryName}.exe`;
}

function getArchiveBinaryCandidates(
	binaryName: string,
	platform: string,
	assetName: string,
): string[] {
	if (platform !== "win32") return [binaryName];
	if (hasExecutableExtension(binaryName)) return [binaryName];
	const candidates = new Set<string>();
	if (assetName.endsWith(".bat")) candidates.add(`${binaryName}.bat`);
	if (assetName.endsWith(".cmd")) candidates.add(`${binaryName}.cmd`);
	candidates.add(`${binaryName}.exe`);
	candidates.add(binaryName);
	candidates.add(`${binaryName}.bat`);
	candidates.add(`${binaryName}.cmd`);
	return [...candidates];
}

async function findNpmGlobalToolPath(
	binaryName: string,
): Promise<string | undefined> {
	const isWindows = process.platform === "win32";
	const binDirs = await getNpmGlobalBinCandidates();

	for (const dir of binDirs) {
		const candidates = isWindows
			? [
					path.join(dir, `${binaryName}.cmd`),
					path.join(dir, `${binaryName}.exe`),
					path.join(dir, binaryName),
				]
			: [path.join(dir, binaryName)];

		for (const candidate of candidates) {
			try {
				await fs.access(candidate);
				if (await verifyToolBinary(candidate)) {
					return candidate;
				}
			} catch {
				// continue
			}
		}
	}

	return undefined;
}

async function getNpmGlobalBinCandidates(): Promise<string[]> {
	const dirs: string[] = [];
	const seen = new Set<string>();

	const add = (value: string | undefined): void => {
		if (!value) return;
		const normalized = path.resolve(value.trim());
		if (!normalized) return;
		if (seen.has(normalized)) return;
		seen.add(normalized);
		dirs.push(normalized);
	};

	if (process.platform === "win32") {
		add(path.join(process.env.APPDATA || "", "npm"));
	} else {
		add(path.join(os.homedir(), ".npm-global", "bin"));
	}

	const pm = process.platform === "win32" ? "npm.cmd" : "npm";
	const prefix = await new Promise<string>((resolve) => {
		const proc = spawn(pm, ["config", "get", "prefix"], {
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32",
		});

		let stdout = "";
		proc.stdout?.on("data", (data: Buffer | string) => (stdout += data));
		proc.on("exit", (code) => resolve(code === 0 ? stdout.trim() : ""));
		proc.on("error", () => resolve(""));
	});

	if (prefix) {
		add(process.platform === "win32" ? prefix : path.join(prefix, "bin"));
	}

	return dirs;
}

async function findPipUserToolPath(
	binaryName: string,
): Promise<string | undefined> {
	const isWindows = process.platform === "win32";
	const userBaseCandidates = await getPythonUserBaseCandidates();

	for (const userBase of userBaseCandidates) {
		const scriptDirs: string[] = [
			path.join(userBase, isWindows ? "Scripts" : "bin"),
		];

		if (isWindows) {
			try {
				const children = await fs.readdir(userBase, { withFileTypes: true });
				for (const entry of children) {
					if (!entry.isDirectory()) continue;
					if (!/^python\d+$/i.test(entry.name)) continue;
					scriptDirs.push(path.join(userBase, entry.name, "Scripts"));
				}
			} catch {
				// ignore
			}
		}

		for (const dir of scriptDirs) {
			const candidates = isWindows
				? [
						path.join(dir, `${binaryName}.exe`),
						path.join(dir, `${binaryName}.cmd`),
						path.join(dir, binaryName),
					]
				: [path.join(dir, binaryName)];

			for (const candidate of candidates) {
				try {
					await fs.access(candidate);
					if (await verifyToolBinary(candidate)) {
						return candidate;
					}
				} catch {
					// continue
				}
			}
		}
	}

	return undefined;
}

async function getPythonUserBaseCandidates(): Promise<string[]> {
	const candidates: string[] = [];
	const seen = new Set<string>();

	const add = (value: string | undefined): void => {
		if (!value) return;
		const normalized = value.trim();
		if (!normalized) return;
		if (seen.has(normalized)) return;
		seen.add(normalized);
		candidates.push(normalized);
	};

	if (process.platform === "win32") {
		add(path.join(process.env.APPDATA || "", "Python"));
	}

	const probes: Array<{ command: string; args: string[] }> =
		process.platform === "win32"
			? [
					{ command: "py", args: ["-m", "site", "--user-base"] },
					{ command: "python", args: ["-m", "site", "--user-base"] },
				]
			: [
					{ command: "python3", args: ["-m", "site", "--user-base"] },
					{ command: "python", args: ["-m", "site", "--user-base"] },
				];

	for (const probe of probes) {
		const userBase = await new Promise<string>((resolve) => {
			const proc = spawn(probe.command, probe.args, {
				stdio: ["ignore", "pipe", "pipe"],
				shell: process.platform === "win32",
			});

			let stdout = "";
			proc.stdout?.on("data", (data: Buffer | string) => (stdout += data));
			proc.on("exit", (code) => resolve(code === 0 ? stdout.trim() : ""));
			proc.on("error", () => resolve(""));
		});
		add(userBase);
	}

	return candidates;
}

// --- Installation Functions

/**
 * Fetch a URL, following up to `maxRedirects` redirects.
 * Returns the raw Buffer of the response body.
 */
function httpsGet(url: string, maxRedirects = 5): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		https
			.get(url, { headers: { "User-Agent": "pi-lens/1.0" } }, (res) => {
				if (
					res.statusCode &&
					res.statusCode >= 300 &&
					res.statusCode < 400 &&
					res.headers.location
				) {
					if (maxRedirects === 0)
						return reject(new Error("Too many redirects"));
					return resolve(httpsGet(res.headers.location, maxRedirects - 1));
				}
				if (res.statusCode !== 200) {
					res.resume();
					return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
				}
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => resolve(Buffer.concat(chunks)));
				res.on("error", reject);
			})
			.on("error", reject);
	});
}

/**
 * Run a shell command and return true on exit code 0.
 */
function runCommand(
	command: string,
	args: string[],
	cwd: string,
): Promise<boolean> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd,
			stdio: "ignore",
			shell: process.platform === "win32",
		});
		proc.on("exit", (code) => resolve(code === 0));
		proc.on("error", () => resolve(false));
	});
}

/**
 * Download and install a tool from a GitHub release.
 * Returns the path to the installed binary, or undefined on failure.
 */
async function installGitHubTool(
	tool: ToolDefinition,
): Promise<string | undefined> {
	const spec = tool.github;
	if (!spec) return undefined;

	const platform = process.platform; // "linux" | "darwin" | "win32"
	const arch = process.arch; // "x64" | "arm64" | ...
	const assetSubstring = spec.assetMatch(platform, arch);
	if (!assetSubstring) {
		logSessionStart(
			`github-install ${tool.id}: unsupported platform=${platform} arch=${arch}`,
		);
		return undefined;
	}

	// Fetch latest release metadata from GitHub API
	logSessionStart(
		`github-install ${tool.id}: fetching release metadata from ${spec.repo}`,
	);
	let releaseJson: {
		tag_name?: string;
		assets: Array<{ name: string; browser_download_url: string }>;
	};
	try {
		const body = await httpsGet(
			`https://api.github.com/repos/${spec.repo}/releases/latest`,
		);
		releaseJson = JSON.parse(body.toString("utf8"));
	} catch (err) {
		logSessionStart(
			`github-install ${tool.id}: release fetch failed: ${(err as Error).message}`,
		);
		return undefined;
	}

	const asset =
		releaseJson.assets.find((a) => a.name.includes(assetSubstring)) ??
		deriveHashiCorpReleaseAsset(tool, releaseJson.tag_name, assetSubstring);
	if (!asset) {
		logSessionStart(
			`github-install ${tool.id}: no asset matched "${assetSubstring}"`,
		);
		return undefined;
	}

	logSessionStart(`github-install ${tool.id}: downloading ${asset.name}`);
	debugLog(
		`[github] downloading ${asset.name} from ${asset.browser_download_url}`,
	);

	// Download the asset
	const downloadStart = Date.now();
	let assetBuffer: Buffer;
	try {
		assetBuffer = await httpsGet(asset.browser_download_url);
		logSessionStart(
			`github-install ${tool.id}: downloaded ${asset.name} (${assetBuffer.length} bytes, ${Date.now() - downloadStart}ms)`,
		);
	} catch (err) {
		logSessionStart(
			`github-install ${tool.id}: download failed: ${(err as Error).message}`,
		);
		return undefined;
	}

	await fs.mkdir(GITHUB_BIN_DIR, { recursive: true });

	const binaryName = tool.binaryName ?? tool.id;
	const isWindows = platform === "win32";
	const finalBinaryName = getGitHubInstalledBinaryName(
		binaryName,
		platform,
		asset.name,
	);
	const destPath = path.join(GITHUB_BIN_DIR, finalBinaryName);

	const assetName = asset.name;

	try {
		if (assetName.endsWith(".gz") && !assetName.endsWith(".tar.gz")) {
			// Bare gzip (e.g. rust-analyzer-x86_64-unknown-linux-gnu.gz) — decompress directly
			const decompressed = await new Promise<Buffer>((resolve, reject) => {
				const gunzip = createGunzip();
				const chunks: Buffer[] = [];
				gunzip.on("data", (chunk: Buffer) => chunks.push(chunk));
				gunzip.on("end", () => resolve(Buffer.concat(chunks)));
				gunzip.on("error", reject);
				gunzip.end(assetBuffer);
			});
			await fs.writeFile(destPath, decompressed, { mode: 0o755 });
		} else if (assetName.endsWith(".tar.gz") || assetName.endsWith(".tar.xz")) {
			// Write archive to temp file, extract with system tar
			const tmpArchive = path.join(GITHUB_BIN_DIR, `_tmp_${assetName}`);
			await fs.writeFile(tmpArchive, assetBuffer);
			const tmpDir = path.join(GITHUB_BIN_DIR, `_tmp_extract_${tool.id}`);
			await fs.mkdir(tmpDir, { recursive: true });

			const extracted = await runCommand(
				"tar",
				["xf", tmpArchive, "-C", tmpDir, "--strip-components=1"],
				GITHUB_BIN_DIR,
			);
			await fs.rm(tmpArchive, { force: true });

			if (!extracted) {
				await fs.rm(tmpDir, { recursive: true, force: true });
				logSessionStart(
					`github-install ${tool.id}: tar extraction failed for ${assetName}`,
				);
				return undefined;
			}

			// Find the binary inside extracted dir
			const srcBinary = path.join(tmpDir, spec.binaryInArchive ?? binaryName);
			await fs.rename(srcBinary, destPath);
			await fs.rm(tmpDir, { recursive: true, force: true });
			if (!isWindows) await fs.chmod(destPath, 0o755);
		} else if (assetName.endsWith(".zip")) {
			// Write zip to temp, extract with unzip (Linux/macOS) or Expand-Archive (Windows)
			const tmpArchive = path.join(GITHUB_BIN_DIR, `_tmp_${assetName}`);
			await fs.writeFile(tmpArchive, assetBuffer);
			const tmpDir = path.join(GITHUB_BIN_DIR, `_tmp_extract_${tool.id}`);
			await fs.mkdir(tmpDir, { recursive: true });

			const extracted = isWindows
				? await runCommand(
						"powershell",
						[
							"-NoProfile",
							"-Command",
							`Expand-Archive -LiteralPath '${tmpArchive}' -DestinationPath '${tmpDir}' -Force`,
						],
						GITHUB_BIN_DIR,
					)
				: await runCommand(
						"unzip",
						["-q", "-o", tmpArchive, "-d", tmpDir],
						GITHUB_BIN_DIR,
					);

			await fs.rm(tmpArchive, { force: true });

			if (!extracted) {
				await fs.rm(tmpDir, { recursive: true, force: true });
				logSessionStart(
					`github-install ${tool.id}: zip extraction failed for ${assetName}`,
				);
				return undefined;
			}

			// Find binary — may be at root or inside a subdir
			const archiveBinaryName = spec.binaryInArchive ?? binaryName;
			const srcBinary = await findFirstFileRecursive(
				tmpDir,
				getArchiveBinaryCandidates(archiveBinaryName, platform, assetName),
			);
			if (!srcBinary) {
				await fs.rm(tmpDir, { recursive: true, force: true });
				logSessionStart(
					`github-install ${tool.id}: binary candidates ${JSON.stringify(
						getArchiveBinaryCandidates(archiveBinaryName, platform, assetName),
					)} not found in zip ${assetName}`,
				);
				return undefined;
			}
			await fs.rename(srcBinary, destPath);
			await fs.rm(tmpDir, { recursive: true, force: true });
			if (!isWindows) await fs.chmod(destPath, 0o755);
		} else {
			// Bare binary (e.g. shfmt_*_linux_amd64)
			await fs.writeFile(destPath, assetBuffer, { mode: 0o755 });
		}
	} catch (err) {
		logSessionStart(
			`github-install ${tool.id}: install failed: ${(err as Error).message}`,
		);
		return undefined;
	}

	debugLog(`[github] installed ${tool.name} → ${destPath}`);
	logSessionStart(`github-install ${tool.id}: installed → ${destPath}`);
	return destPath;
}

/** Recursively find the first matching file under a directory. */
async function findFirstFileRecursive(
	dir: string,
	names: string[],
): Promise<string | undefined> {
	const wanted = new Set(names.map((name) => name.toLowerCase()));
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			const found = await findFirstFileRecursive(full, names);
			if (found) return found;
		} else if (wanted.has(entry.name.toLowerCase())) {
			return full;
		}
	}
	return undefined;
}

/**
 * Install an npm package tool
 */
/**
 * Packages that require postinstall scripts to download native binaries.
 * All others get --ignore-scripts to prevent arbitrary code execution during install.
 */
const NEEDS_POSTINSTALL = new Set([
	"@biomejs/biome",
	"@ast-grep/cli", // postinstall copies platform binary (ast-grep.exe/sg.exe) into place
	"@ast-grep/napi",
	"esbuild",
	"intelephense", // postinstall fetches platform binary; --ignore-scripts breaks install
]);

async function installNpmTool(
	packageName: string,
	binaryName: string,
): Promise<string | undefined> {
	try {
		// Ensure tools directory exists
		await fs.mkdir(TOOLS_DIR, { recursive: true });

		// Create a minimal package.json if it doesn't exist
		const packageJsonPath = path.join(TOOLS_DIR, "package.json");
		try {
			await fs.access(packageJsonPath);
		} catch {
			await fs.writeFile(
				packageJsonPath,
				JSON.stringify({ name: "pi-lens-tools", version: "1.0.0" }, null, 2),
			);
		}

		// Install via npm or bun (use .cmd on Windows)
		const isWindows = process.platform === "win32";
		let pm = isWindows ? "npm.cmd" : "npm";
		if (process.env.BUN_INSTALL) {
			pm = isWindows ? "bun.exe" : "bun";
		}
		// Use --ignore-scripts unless the package explicitly needs postinstall
		// (e.g. biome downloads a platform-specific native binary via postinstall).
		const needsScripts = NEEDS_POSTINSTALL.has(
			packageName.split("@")[0] ?? packageName,
		);
		const baseInstallArgs = needsScripts
			? ["install", packageName]
			: ["install", "--ignore-scripts", packageName];

		const INSTALL_TIMEOUT_MS = 120_000;
		const runInstallAttempt = async (
			args: string[],
		): Promise<{ ok: boolean; stderr: string }> =>
			new Promise((resolve) => {
				const proc = spawn(pm, args, {
					cwd: TOOLS_DIR,
					stdio: ["ignore", "pipe", "pipe"],
					shell: isWindows, // Required for .cmd files on Windows
				});

				let stderr = "";
				proc.stderr?.on("data", (data) => (stderr += data));

				const timer = setTimeout(() => {
					proc.kill();
					resolve({
						ok: false,
						stderr: `install timed out after ${INSTALL_TIMEOUT_MS / 1000}s`,
					});
				}, INSTALL_TIMEOUT_MS);

				proc.on("exit", (code) => {
					clearTimeout(timer);
					resolve({ ok: code === 0, stderr });
				});
				proc.on("error", (err) => {
					clearTimeout(timer);
					resolve({ ok: false, stderr: err.message });
				});
			});

		let outcome = await runInstallAttempt(baseInstallArgs);

		const isNpm = pm === "npm" || pm === "npm.cmd";
		const erResolve =
			outcome.ok === false &&
			/npm\s+error\s+ERESOLVE|\bERESOLVE\b|could not resolve/i.test(
				outcome.stderr,
			);

		if (isNpm && erResolve) {
			const retryArgs = needsScripts
				? ["install", "--legacy-peer-deps", packageName]
				: ["install", "--ignore-scripts", "--legacy-peer-deps", packageName];
			logSessionStart(
				`auto-install npm ${packageName}: retry with --legacy-peer-deps after ERESOLVE`,
			);
			outcome = await runInstallAttempt(retryArgs);
		}

		if (!outcome.ok) {
			throw new Error(`Failed to install ${packageName}: ${outcome.stderr}`);
		}

		const binPath = path.join(TOOLS_DIR, "node_modules", ".bin", binaryName);

		// Make executable on Unix
		if (process.platform !== "win32") {
			try {
				await fs.chmod(binPath, 0o755);
			} catch {
				/* ignore */
			}
		}

		// Brief delay — lets npm postinstall scripts finish writing bin wrappers
		// before we stat/exec them (eliminates a race on slow Windows I/O).
		await new Promise((r) => setTimeout(r, 500));

		// Verify the binary actually works, retrying with backoff to handle
		// postinstall scripts that complete asynchronously after npm exits 0.
		debugLog(`Verifying ${binaryName}...`);
		let isValid = false;
		for (let attempt = 1; attempt <= 3; attempt++) {
			isValid = await verifyToolBinary(binPath);
			if (isValid) break;
			if (attempt < 3) {
				logSessionStart(
					`auto-install verify ${binaryName}: attempt ${attempt} failed, retrying in ${attempt}s`,
				);
				await new Promise((r) => setTimeout(r, 1000 * attempt));
			}
		}
		if (!isValid) {
			logSessionStart(
				`auto-install ${packageName}: installed but verification failed, cleaning up`,
			);
			// Clean up the broken installation
			try {
				const packagePath = path.join(TOOLS_DIR, "node_modules", packageName);
				await fs.rm(packagePath, { recursive: true, force: true });
				await fs.rm(binPath, { force: true });
				if (isWindows) {
					await fs.rm(`${binPath}.cmd`, { force: true });
					await fs.rm(`${binPath}.ps1`, { force: true });
				}
			} catch {
				/* ignore cleanup errors */
			}
			return undefined;
		}

		return binPath;
	} catch (err) {
		logSessionStart(
			`auto-install npm ${packageName}: exception: ${(err as Error).message}`,
		);
		return undefined;
	}
}
/**
 * Install a pip package tool
 */
async function installPipTool(
	packageName: string,
): Promise<string | undefined> {
	try {
		const isWindows = process.platform === "win32";
		const pipCandidates = isWindows
			? [
					{ command: "pip", args: ["install", "--user", packageName] },
					{
						command: "py",
						args: ["-m", "pip", "install", "--user", packageName],
					},
					{
						command: "python",
						args: ["-m", "pip", "install", "--user", packageName],
					},
				]
			: [
					{ command: "pip3", args: ["install", "--user", packageName] },
					{ command: "pip", args: ["install", "--user", packageName] },
					{
						command: "python3",
						args: ["-m", "pip", "install", "--user", packageName],
					},
					{
						command: "python",
						args: ["-m", "pip", "install", "--user", packageName],
					},
				];

		let lastError = "";
		for (const candidate of pipCandidates) {
			const outcome = await new Promise<{ ok: boolean; error: string }>(
				(resolve) => {
					const proc = spawn(candidate.command, candidate.args, {
						stdio: ["ignore", "pipe", "pipe"],
						shell: isWindows, // Required for .cmd files on Windows
					});

					let stderr = "";
					proc.stderr?.on("data", (data) => (stderr += data));

					proc.on("exit", (code) => {
						if (code === 0) {
							resolve({ ok: true, error: "" });
						} else {
							resolve({ ok: false, error: stderr.trim() });
						}
					});

					proc.on("error", (err) => {
						resolve({ ok: false, error: err.message });
					});
				},
			);

			if (outcome.ok) {
				// Ensure user-level scripts directory is available in current process PATH.
				// This helps tools installed via `pip install --user` become immediately callable.
				const userBaseResult = await new Promise<string>((resolve) => {
					const probe = spawn(
						candidate.command,
						["-m", "site", "--user-base"],
						{
							stdio: ["ignore", "pipe", "pipe"],
							shell: isWindows,
						},
					);
					let stdout = "";
					probe.stdout?.on("data", (data) => (stdout += data));
					probe.on("exit", (code) => {
						if (code === 0) resolve(stdout.trim());
						else resolve("");
					});
					probe.on("error", () => resolve(""));
				});

				if (userBaseResult) {
					const candidateScriptDirs: string[] = [
						path.join(userBaseResult, isWindows ? "Scripts" : "bin"),
					];

					if (isWindows) {
						// Some Python setups report USER_BASE as ...\Roaming\Python,
						// while scripts live in ...\Roaming\Python\PythonXY\Scripts.
						try {
							const children = await fs.readdir(userBaseResult, {
								withFileTypes: true,
							});
							for (const entry of children) {
								if (!entry.isDirectory()) continue;
								if (!/^python\d+$/i.test(entry.name)) continue;
								candidateScriptDirs.push(
									path.join(userBaseResult, entry.name, "Scripts"),
								);
							}
						} catch {
							// ignore
						}
					}

					const currentPath =
						process.env.PATH || process.env.Path || process.env.path || "";
					const separator = isWindows ? ";" : ":";
					const normalizedPath = currentPath
						.toLowerCase()
						.split(separator)
						.map((p) => p.trim());

					for (const scriptsDir of candidateScriptDirs) {
						try {
							await fs.access(scriptsDir);
							if (!normalizedPath.includes(scriptsDir.toLowerCase())) {
								const existingPath =
									process.env.PATH ||
									process.env.Path ||
									process.env.path ||
									"";
								const updatedPath = `${scriptsDir}${separator}${existingPath}`;
								process.env.PATH = updatedPath;
								if (isWindows) {
									process.env.Path = updatedPath;
								}
								debugLog(`Added pip user scripts dir to PATH: ${scriptsDir}`);
							}
						} catch {
							debugLog(`pip user scripts dir not accessible: ${scriptsDir}`);
						}
					}
				}

				return packageName;
			}

			lastError = `${candidate.command} ${candidate.args.join(" ")}: ${outcome.error}`;
			debugLog(`[pip-fallback] ${lastError}`);
		}

		throw new Error(
			`Failed to install ${packageName}: no usable pip command found (${lastError || "unknown error"})`,
		);
	} catch (err) {
		logSessionStart(
			`auto-install pip ${packageName}: exception: ${(err as Error).message}`,
		);
		return undefined;
	}
}

/**
 * Install a tool by ID
 */
export async function installTool(toolId: string): Promise<boolean> {
	const tool = TOOLS.find((t) => t.id === toolId);
	if (!tool) {
		logSessionStart(`auto-install ${toolId}: unknown tool id`);
		return false;
	}

	const startedAt = Date.now();
	logSessionStart(
		`auto-install ${tool.id}: start strategy=${tool.installStrategy} package=${tool.packageName ?? "n/a"}`,
	);

	try {
		switch (tool.installStrategy) {
			case "npm": {
				if (!tool.packageName || !tool.binaryName) return false;
				const npmPath = await installNpmTool(tool.packageName, tool.binaryName);
				const ok = npmPath !== undefined;
				logSessionStart(
					`auto-install ${tool.id}: ${ok ? "success" : "failed"} (${Date.now() - startedAt}ms)`,
				);
				return ok;
			}

			case "pip": {
				if (!tool.packageName) return false;
				const pipPath = await installPipTool(tool.packageName);
				const ok = pipPath !== undefined;
				logSessionStart(
					`auto-install ${tool.id}: ${ok ? "success" : "failed"} (${Date.now() - startedAt}ms)`,
				);
				return ok;
			}

			case "github": {
				if (!tool.github) return false;
				const ghPath = await installGitHubTool(tool);
				const ok = ghPath !== undefined;
				logSessionStart(
					`auto-install ${tool.id}: ${ok ? "success" : "failed"} (${Date.now() - startedAt}ms)`,
				);
				return ok;
			}

			default:
				logSessionStart(`auto-install ${tool.id}: unsupported strategy`);
				return false;
		}
	} catch (err) {
		logSessionStart(
			`auto-install ${tool.id}: exception ${(err as Error).message} (${Date.now() - startedAt}ms)`,
		);
		return false;
	}
}

/**
 * Ensure a tool is installed (check first, install if missing)
 */
export async function ensureTool(toolId: string): Promise<string | undefined> {
	// Fast path: return cached path without spawning a process
	const cached = resolvedPathCache.get(toolId);
	if (cached) return cached;

	const ensureStartMs = Date.now();
	logSessionStart(`auto-install ensure ${toolId}: start`);
	// Check if already installed
	const existingPath = await getToolPath(toolId);
	if (existingPath) {
		resolvedPathCache.set(toolId, existingPath);
		logSessionStart(
			`auto-install ensure ${toolId}: already available at ${existingPath} (${Date.now() - ensureStartMs}ms)`,
		);
		return existingPath;
	}

	const inFlight = ensureInFlight.get(toolId);
	if (inFlight) {
		logSessionStart(
			`auto-install ensure ${toolId}: waiting for in-flight install`,
		);
		return inFlight;
	}

	const installPromise = (async () => {
		const installed = await installTool(toolId);
		if (!installed) {
			return undefined;
		}

		return getToolPath(toolId);
	})();

	ensureInFlight.set(toolId, installPromise);
	try {
		const result = await installPromise;
		if (result) {
			resolvedPathCache.set(toolId, result);
			logSessionStart(
				`auto-install ensure ${toolId}: success at ${result} (${Date.now() - ensureStartMs}ms)`,
			);
		} else {
			logSessionStart(
				`auto-install ensure ${toolId}: unavailable (${Date.now() - ensureStartMs}ms)`,
			);
		}
		return result;
	} finally {
		ensureInFlight.delete(toolId);
	}
}

// --- Integration Helpers ---

/**
 * Get environment with tool paths added
 */
export async function getToolEnvironment(): Promise<NodeJS.ProcessEnv> {
	const localBin = path.join(TOOLS_DIR, "node_modules", ".bin");
	const currentPath =
		process.env.PATH || process.env.Path || process.env.path || "";
	const separator = process.platform === "win32" ? ";" : ":";
	const nodeDir = path.dirname(process.execPath);
	const withNode = nodeDir
		? `${nodeDir}${separator}${currentPath}`
		: currentPath;
	const augmentedPath = `${GITHUB_BIN_DIR}${separator}${localBin}${separator}${withNode}`;

	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: augmentedPath,
	};

	if (process.platform === "win32") {
		env.Path = augmentedPath;
	}

	return env;
}

// --- Status Check ---

/**
 * Check status of all managed tools
 */
export async function checkAllTools(): Promise<
	Array<{ id: string; name: string; installed: boolean; path?: string }>
> {
	const results = [];
	for (const tool of TOOLS) {
		const path = await getToolPath(tool.id);
		results.push({
			id: tool.id,
			name: tool.name,
			installed: path !== undefined,
			path,
		});
	}
	return results;
}

export function isKnownToolId(toolId: string): boolean {
	return TOOLS.some((tool) => tool.id === toolId);
}

/**
 * Resolve the GitHub asset filename substring for a tool on a given platform/arch.
 * Returns undefined if the tool has no GitHub spec or no asset for the platform.
 * Exported for testing only.
 */
export function resolveGitHubAsset(
	toolId: string,
	platform: string,
	arch: string,
): string | undefined {
	const tool = TOOLS.find((t) => t.id === toolId);
	return tool?.github?.assetMatch(platform, arch);
}

export function resolveGitHubInstalledBinaryName(
	toolId: string,
	platform: string,
	assetName: string,
): string | undefined {
	const tool = TOOLS.find((t) => t.id === toolId);
	if (!tool) return undefined;
	return getGitHubInstalledBinaryName(
		tool.binaryName ?? tool.id,
		platform,
		assetName,
	);
}

export function resolveGitHubArchiveBinaryCandidates(
	toolId: string,
	platform: string,
	assetName: string,
): string[] | undefined {
	const tool = TOOLS.find((t) => t.id === toolId);
	if (!tool) return undefined;
	const binaryName = tool.github?.binaryInArchive ?? tool.binaryName ?? tool.id;
	return getArchiveBinaryCandidates(binaryName, platform, assetName);
}

type DownloadAsset = { name: string; browser_download_url: string };

function deriveHashiCorpReleaseAsset(
	tool: ToolDefinition,
	tagName: string | undefined,
	assetSubstring: string,
): DownloadAsset | undefined {
	const product = tool.github?.hashiCorpReleaseProduct;
	if (!product || !tagName) return undefined;

	const version = tagName.replace(/^v/, "").trim();
	if (!version) return undefined;

	const assetName = `${product}_${version}_${assetSubstring}`;
	return {
		name: assetName,
		browser_download_url: `https://releases.hashicorp.com/${product}/${version}/${assetName}`,
	};
}

export function resolveDerivedHashiCorpReleaseAsset(
	toolId: string,
	tagName: string,
	platform: string,
	arch: string,
): DownloadAsset | undefined {
	const tool = TOOLS.find((t) => t.id === toolId);
	if (!tool) return undefined;
	const assetSubstring = tool.github?.assetMatch(platform, arch);
	if (!assetSubstring) return undefined;
	return deriveHashiCorpReleaseAsset(tool, tagName, assetSubstring);
}
