/**
 * Auto-Installation System for pi-lens
 *
 * Minimal auto-install: Core tools that run frequently.
 * Other tools require manual installation with clear instructions.
 *
 * Auto-install (22 tools):
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
 * - actionlint (GitHub Actions workflow linting) [GitHub release]
 * - sqlfluff (SQL linting/formatting)
 * - markdownlint-cli2 (Markdown linting)
 * - mypy (Python type checking)
 * - rubocop (Ruby linting/autofix)
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
import { existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import https from "node:https";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const _installerRequire = createRequire(import.meta.url);
import { createGunzip } from "node:zlib";
import { isTestMode } from "../env-utils.js";
import { getGlobalPiLensDir } from "../file-utils.js";
import {
	allAvailableGlobalBinDirs,
	installArgs,
	pmBinary,
	resolveNodePackageManager,
} from "../package-manager.js";

// Global installation directory for pi-lens tools
const TOOLS_DIR = path.join(getGlobalPiLensDir(), "tools");

// Directory for GitHub-downloaded binaries
const GITHUB_BIN_DIR = path.join(getGlobalPiLensDir(), "bin");

// Debug flag - set via PI_LENS_DEBUG=1 or --debug
const DEBUG =
	process.env.PI_LENS_DEBUG === "1" || process.argv.includes("--debug");
const SESSIONSTART_LOG_DIR = getGlobalPiLensDir();
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
	if (isTestMode()) {
		return;
	}
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
	/**
	 * Additional release assets (EXACT names) to download as bare files alongside
	 * the primary binary. Needed when the primary is a wrapper that references a
	 * sibling file — e.g. ktlint's Windows `ktlint.bat` runs `java -jar %~dp0ktlint`,
	 * so the `ktlint` jar must land next to it (#218).
	 */
	extraAssets?: (platform: string, arch: string) => string[];
}

/**
 * A tool distributed as a runnable fat JAR on a Maven repository (default Maven
 * Central). Installed by downloading the JAR into the managed bin and writing a
 * `java -jar` launcher next to it, so it resolves like any other managed binary.
 * Requires a JRE at run time.
 */
export interface MavenJarSpec {
	groupId: string;
	artifactId: string;
	version: string;
	/** Classifier for the runnable fat jar, e.g. "with-dependencies". */
	classifier?: string;
	/** Maven repo base URL (default Maven Central). */
	repoBaseUrl?: string;
}

export interface ArchiveSpec {
	/**
	 * Download URL for the distribution archive (.tgz/.zip). Either a single
	 * platform-agnostic string (e.g. PowerShell Editor Services, a .NET bundle) or
	 * a resolver `(platform, arch) => url | undefined` for servers that ship a
	 * per-platform (and sometimes per-arch) archive — clangd, lua-language-server,
	 * etc. Returning `undefined` marks the current platform/arch unsupported, and
	 * the install degrades to "unavailable" (never a hard failure).
	 *   platform: "linux" | "darwin" | "win32"
	 *   arch:     "x64" | "arm64" | ...
	 */
	url: string | ((platform: string, arch: string) => string | undefined);
	/** Archive kind — both extracted via `tar` (Windows bsdtar handles zip too). */
	kind: "tgz" | "zip";
	/**
	 * Launcher path relative to the archive's top-level dir (which is stripped on
	 * extraction), e.g. "bin/spotbugs". On win32 the installer resolves the
	 * sibling `.bat`. OMIT for a TREE BUNDLE (a multi-folder module distribution
	 * with no single launcher binary, e.g. PowerShellEditorServices) — the whole
	 * extracted tree is the artifact and the install resolves to the extract dir
	 * (`~/.pi-lens/tools/<id>`) rather than a shim. The consuming server then
	 * launches a runtime (pwsh/java/node) against a bootstrap inside the tree.
	 */
	launcher?: string;
	/**
	 * Components to strip on extraction. Default 1: drops a single versioned
	 * top-level dir so launcher paths are stable (spotbugs-X.Y.Z/bin → bin). Set 0
	 * for a multi-folder bundle that has NO wrapping dir (PSES extracts several
	 * sibling module folders at the root — stripping would flatten/merge them).
	 */
	stripComponents?: number;
	/**
	 * For a tree bundle (no launcher), a path relative to the extract dir that must
	 * exist after extraction to confirm success, e.g.
	 * "PowerShellEditorServices/Start-EditorServices.ps1". Used in place of the
	 * launcher-existence check.
	 */
	treeMarker?: string;
}

export interface ToolDefinition {
	id: string;
	name: string;
	checkCommand: string;
	checkArgs: string[];
	installStrategy: "npm" | "pip" | "gem" | "github" | "maven" | "archive";
	packageName?: string;
	binaryName?: string;
	github?: GitHubAssetSpec;
	maven?: MavenJarSpec;
	archive?: ArchiveSpec;
	/**
	 * For npm tools whose runnable binary ships in a per-platform
	 * optional-dependency package (e.g. `@ast-grep/cli-<platform>`,
	 * `@biomejs/cli-<platform>`). Under pnpm/bun the main package's JS launcher
	 * frequently can't locate that binary (symlink store / skipped postinstall),
	 * but the binary itself IS installed — so resolve it directly. The general
	 * mechanism for any npm/pnpm/bun-distributed platform-CLI tool.
	 */
	platformPackage?: PlatformPackageSpec;
}

export interface PlatformPackageSpec {
	/** Base name; the platform package is `${base}-${suffix}`. Defaults to `packageName`. */
	base?: string;
	/** node `${platform}-${arch}` → npm package-name suffix. */
	suffixes: Record<string, string>;
	/** Candidate binary filenames at the platform package root (first existing wins). */
	binaries: string[];
}

/**
 * Build a GitHub-release `assetMatch` from a small per-platform table, replacing
 * the copy-pasted `if (platform === "linux") return arch === "arm64" ? … : …`
 * ladder that several release entries repeat verbatim. Each platform maps to its
 * `x64` (default) and optional `arm64` asset substring; a missing platform or
 * arch ⇒ unsupported (`undefined`), exactly as the hand-written ladders behaved.
 */
function archAssetMatch(table: {
	linux?: { x64?: string; arm64?: string };
	darwin?: { x64?: string; arm64?: string };
	win32?: { x64?: string; arm64?: string };
}): (platform: string, arch: string) => string | undefined {
	return (platform, arch) => {
		const entry = table[platform as "linux" | "darwin" | "win32"];
		if (!entry) return undefined;
		return arch === "arm64" ? entry.arm64 : entry.x64;
	};
}

export const TOOLS: ToolDefinition[] = [
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
		// Alternate Python LSP (fallback when pyright/the `python` server is
		// unavailable or disabled). Used as a managedToolId by PythonJediServer.
		id: "jedi-language-server",
		name: "Jedi Language Server",
		checkCommand: "jedi-language-server",
		checkArgs: ["--version"],
		installStrategy: "pip",
		packageName: "jedi-language-server",
		binaryName: "jedi-language-server",
	},
	{
		id: "biome",
		name: "Biome",
		checkCommand: "biome",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "@biomejs/biome",
		binaryName: "biome",
		platformPackage: {
			base: "@biomejs/cli",
			suffixes: {
				"linux-x64": "linux-x64",
				"linux-arm64": "linux-arm64",
				"darwin-x64": "darwin-x64",
				"darwin-arm64": "darwin-arm64",
				"win32-x64": "win32-x64",
				"win32-arm64": "win32-arm64",
			},
			binaries: ["biome"],
		},
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
		packageName: "jscpd@5.0.12", // v4's packaging bug (reprism dep missing lib/languages/) is gone in v5's ground-up Rust rewrite — verified: real per-platform native binary (jscpd-windows-x64-msvc etc. via optionalDependencies, no missing-dir regression), --min-lines/--min-tokens/--reporters/--output/--ignore all unchanged, JSON schema fields read by clients/jscpd-client.ts's parseReport() (statistics.total.*, duplicates[].firstFile/secondFile.name+start, .lines, .tokens) are identical, and it's ~50x faster on this repo (4.1s -> 76ms detection time) — closes #582
		binaryName: "jscpd",
	},
	// Structural search and dead code detection
	{
		id: "ast-grep",
		name: "ast-grep CLI",
		checkCommand: "ast-grep",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "@ast-grep/cli",
		binaryName: "ast-grep",
		platformPackage: {
			suffixes: {
				"linux-x64": "linux-x64-gnu",
				"linux-arm64": "linux-arm64-gnu",
				"darwin-x64": "darwin-x64",
				"darwin-arm64": "darwin-arm64",
				"win32-x64": "win32-x64-msvc",
				"win32-arm64": "win32-arm64-msvc",
				"win32-ia32": "win32-ia32-msvc",
			},
			binaries: ["ast-grep", "sg"],
		},
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
		// Opengrep: a single standalone binary per platform on GitHub releases —
		// no login, no telemetry (the reason for switching off Semgrep, #111).
		id: "opengrep",
		name: "Opengrep",
		checkCommand: "opengrep",
		checkArgs: ["--version"],
		installStrategy: "github",
		binaryName: "opengrep",
		github: {
			repo: "opengrep/opengrep",
			assetMatch: (platform, arch) => {
				if (platform === "linux")
					return arch === "arm64"
						? "opengrep_manylinux_aarch64"
						: "opengrep_manylinux_x86";
				if (platform === "darwin")
					return arch === "arm64" ? "opengrep_osx_arm64" : "opengrep_osx_x86";
				// One x86 Windows build; runs on arm64 Windows via emulation.
				if (platform === "win32") return "opengrep_windows_x86.exe";
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
		id: "rubocop",
		name: "RuboCop",
		checkCommand: "rubocop",
		checkArgs: ["--version"],
		installStrategy: "gem",
		packageName: "rubocop",
		binaryName: "rubocop",
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
		// Alternate JS/TS LSP (fallback when the `typescript` server is unavailable
		// or disabled — e.g. Deno projects). Used as a managedToolId by DenoServer.
		// Every platform ships a .zip containing the `deno` binary (the github
		// strategy extracts it, as it does for rust-analyzer's Windows .zip).
		id: "deno",
		name: "Deno",
		checkCommand: "deno",
		checkArgs: ["--version"],
		installStrategy: "github",
		binaryName: "deno",
		github: {
			repo: "denoland/deno",
			assetMatch: (platform, arch) => {
				if (platform === "linux")
					return arch === "arm64"
						? "deno-aarch64-unknown-linux-gnu.zip"
						: "deno-x86_64-unknown-linux-gnu.zip";
				if (platform === "darwin")
					return arch === "arm64"
						? "deno-aarch64-apple-darwin.zip"
						: "deno-x86_64-apple-darwin.zip";
				// Windows ships only x86_64 (runs under emulation on arm64).
				if (platform === "win32") return "deno-x86_64-pc-windows-msvc.zip";
				return undefined;
			},
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
			// ktlint ships a self-executable `ktlint` (a JAR with a shell preamble)
			// for Linux/macOS, plus a `ktlint.bat` wrapper for Windows that runs
			// `java -jar %~dp0ktlint`. On Windows BOTH files are needed: the .bat AND
			// the `ktlint` jar it wraps (#218). No arm64-specific asset.
			repo: "pinterest/ktlint",
			assetMatch: (platform, _arch) => {
				if (platform === "linux") return "ktlint";
				if (platform === "darwin") return "ktlint";
				if (platform === "win32") return "ktlint.bat";
				return undefined;
			},
			extraAssets: (platform) => (platform === "win32" ? ["ktlint"] : []),
		},
	},
	{
		// ktfmt (Meta's opinionated Kotlin formatter) ships only as a Maven-Central
		// fat JAR — no native binary, no npm package — so it uses the maven strategy
		// (#129). Run via a `java -jar` launcher; requires a JRE.
		id: "ktfmt",
		name: "ktfmt",
		checkCommand: "ktfmt",
		checkArgs: ["--version"],
		installStrategy: "maven",
		binaryName: "ktfmt",
		maven: {
			groupId: "com.facebook",
			artifactId: "ktfmt",
			version: "0.63",
			classifier: "with-dependencies",
		},
	},
	{
		// SpotBugs (bytecode bug-pattern analyzer for Java/Kotlin/Scala/Groovy)
		// ships as a distribution archive — a lib/ of many JARs + bin/ launchers,
		// NOT a runnable fat JAR — so it uses the archive strategy, not maven
		// (refs #133). Requires a JRE (gated by the runner, not the install).
		id: "spotbugs",
		name: "SpotBugs",
		checkCommand: "spotbugs",
		checkArgs: ["-version"],
		installStrategy: "archive",
		binaryName: "spotbugs",
		archive: {
			url: "https://github.com/spotbugs/spotbugs/releases/download/4.10.2/spotbugs-4.10.2.tgz",
			kind: "tgz",
			launcher: "bin/spotbugs",
		},
	},
	{
		// PowerShell Editor Services (#278). NOT a single binary — a multi-folder
		// PowerShell MODULE BUNDLE launched via `pwsh Start-EditorServices.ps1
		// -Stdio` (see PowerShellServer.spawn). archive TREE BUNDLE: the release zip
		// extracts sibling module dirs (PowerShellEditorServices/, PSReadLine/,
		// PSScriptAnalyzer/) at the root with no wrapping dir, so stripComponents:0
		// + no launcher — the whole tree is kept and resolved to its extract dir.
		// checkCommand "pwsh" documents the runtime but is unused for resolution
		// (tree bundles resolve only via the extract dir + treeMarker).
		id: "powershell-editor-services",
		name: "PowerShell Editor Services",
		checkCommand: "pwsh",
		checkArgs: ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
		installStrategy: "archive",
		binaryName: "powershell-editor-services",
		archive: {
			url: "https://github.com/PowerShell/PowerShellEditorServices/releases/download/v4.6.0/PowerShellEditorServices.zip",
			kind: "zip",
			stripComponents: 0,
			treeMarker: "PowerShellEditorServices/Start-EditorServices.ps1",
		},
	},
	{
		// clangd (C/C++/Obj-C LSP, #241) — a self-contained native TREE BUNDLE: the
		// release zip wraps `clangd_<ver>/{bin,lib}` (bin/clangd[.exe] + the bundled
		// libclang headers under lib/), so stripComponents:1 drops the version dir and
		// the whole tree is kept (no launcher). Unlike PSES there is no external
		// runtime — CppServer launches `<bundle>/bin/clangd` directly. checkCommand
		// documents the binary but is unused for resolution (tree bundles resolve only
		// via the extract dir + treeMarker). Platform-matched url: clangd ships x64
		// prebuilts; arm runs the x64 build under Rosetta/emulation (darwin/win32),
		// while linux/arm64 has no official build → undefined (graceful unavailable).
		id: "clangd",
		name: "clangd",
		checkCommand: "clangd",
		checkArgs: ["--version"],
		installStrategy: "archive",
		binaryName: "clangd",
		archive: {
			url: (platform, arch) => {
				const version = "22.1.0";
				const base = `https://github.com/clangd/clangd/releases/download/${version}`;
				if (platform === "linux")
					return arch === "x64" ? `${base}/clangd-linux-${version}.zip` : undefined;
				if (platform === "darwin") return `${base}/clangd-mac-${version}.zip`;
				if (platform === "win32") return `${base}/clangd-windows-${version}.zip`;
				return undefined;
			},
			kind: "zip",
			stripComponents: 1,
			treeMarker: "bin",
		},
	},
	{
		// lua-language-server (#564, split from #241) — same self-contained native
		// TREE BUNDLE shape as clangd: bin/lua-language-server[.exe] + bundled
		// locale/meta files, no external runtime. UNLIKE clangd, the release
		// archive has NO wrapping version dir (verified by inspecting the actual
		// 3.18.2 linux-x64 .tar.gz and win32-x64 .zip contents: `bin/`, `LICENSE`,
		// `locale/`, … sit at archive root) — so stripComponents:0, not 1.
		// LuaServer launches `<bundle>/bin/lua-language-server` directly.
		// checkCommand documents the binary but is unused for resolution (tree
		// bundles resolve only via the extract dir + treeMarker). Platform-matched
		// url: LuaLS publishes darwin/linux x64+arm64 and win32 x64 (no win32/arm64
		// build as of 3.18.2 → undefined, graceful unavailable); asset naming
		// verified against the live GitHub release listing, not guessed.
		id: "lua-language-server",
		name: "lua-language-server",
		checkCommand: "lua-language-server",
		checkArgs: ["--version"],
		installStrategy: "archive",
		binaryName: "lua-language-server",
		archive: {
			url: (platform, arch) => {
				const version = "3.18.2";
				const base = `https://github.com/LuaLS/lua-language-server/releases/download/${version}`;
				if (platform === "linux")
					return arch === "arm64"
						? `${base}/lua-language-server-${version}-linux-arm64.tar.gz`
						: `${base}/lua-language-server-${version}-linux-x64.tar.gz`;
				if (platform === "darwin")
					return arch === "arm64"
						? `${base}/lua-language-server-${version}-darwin-arm64.tar.gz`
						: `${base}/lua-language-server-${version}-darwin-x64.tar.gz`;
				if (platform === "win32")
					return arch === "arm64"
						? undefined
						: `${base}/lua-language-server-${version}-win32-x64.zip`;
				return undefined;
			},
			kind: "zip",
			stripComponents: 0,
			treeMarker: "bin",
		},
	},
	{
		id: "actionlint",
		name: "actionlint",
		checkCommand: "actionlint",
		checkArgs: ["--version"],
		installStrategy: "github",
		binaryName: "actionlint",
		github: {
			repo: "rhysd/actionlint",
			assetMatch: (platform, arch) => {
				if (platform === "linux")
					return arch === "arm64" ? "linux_arm64.tar.gz" : "linux_amd64.tar.gz";
				if (platform === "darwin")
					return arch === "arm64"
						? "darwin_arm64.tar.gz"
						: "darwin_amd64.tar.gz";
				if (platform === "win32")
					return arch === "arm64" ? "windows_arm64.zip" : "windows_amd64.zip";
				return undefined;
			},
			binaryInArchive: "actionlint",
		},
	},
	{
		// zizmor: GitHub Actions workflow security scanner that speaks LSP (#272).
		// cargo-dist release archives, one per target triple, each holding a single
		// `zizmor` binary (extracted via the recursive binary find). Online audits
		// (known-vulnerable-actions, unpinned-uses, …) need a GitHub token — the LSP
		// spawn forwards one via resolveZizmorGitHubToken (clients/zizmor-config.ts).
		id: "zizmor",
		name: "zizmor",
		checkCommand: "zizmor",
		checkArgs: ["--version"],
		installStrategy: "github",
		binaryName: "zizmor",
		github: {
			repo: "zizmorcore/zizmor",
			assetMatch: (platform, arch) => {
				if (platform === "linux")
					return arch === "arm64"
						? "aarch64-unknown-linux-gnu.tar.gz"
						: "x86_64-unknown-linux-gnu.tar.gz";
				if (platform === "darwin")
					return arch === "arm64"
						? "aarch64-apple-darwin.tar.gz"
						: "x86_64-apple-darwin.tar.gz";
				// One x86 Windows build; arm64 Windows runs it under emulation.
				if (platform === "win32") return "x86_64-pc-windows-msvc.zip";
				return undefined;
			},
			binaryInArchive: "zizmor",
		},
	},
	{
		// typos-lsp: source-code spell checker that speaks LSP (#283). cargo-dist
		// release archives, one per target triple, each holding a single `typos-lsp`
		// binary (extracted via the recursive binary find). NO token / network — the
		// dictionary is compiled in. The binary takes no `--version` (it ignores args
		// and serves the LSP on stdin/stdout); the PATH probe ignores checkArgs and
		// verifyToolBinary runs with stdin:ignore so the server gets EOF and exits.
		id: "typos-lsp",
		name: "typos-lsp",
		checkCommand: "typos-lsp",
		checkArgs: ["--version"],
		installStrategy: "github",
		binaryName: "typos-lsp",
		github: {
			repo: "tekumara/typos-lsp",
			assetMatch: (platform, arch) => {
				if (platform === "linux")
					return arch === "arm64"
						? "aarch64-unknown-linux-gnu.tar.gz"
						: "x86_64-unknown-linux-gnu.tar.gz";
				if (platform === "darwin")
					return arch === "arm64"
						? "aarch64-apple-darwin.tar.gz"
						: "x86_64-apple-darwin.tar.gz";
				if (platform === "win32")
					// Native win-arm64 build (one better than zizmor, which emulates).
					return arch === "arm64"
						? "aarch64-pc-windows-msvc.zip"
						: "x86_64-pc-windows-msvc.zip";
				return undefined;
			},
			binaryInArchive: "typos-lsp",
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
		id: "gitleaks",
		name: "gitleaks",
		checkCommand: "gitleaks",
		checkArgs: ["version"],
		installStrategy: "github",
		binaryName: "gitleaks",
		github: {
			repo: "gitleaks/gitleaks",
			// gitleaks asset naming uses `x64` not `amd64` (unlike most Go-built
			// tools). Substring match is exact-enough — release assets are
			// named e.g. `gitleaks_8.18.4_linux_x64.tar.gz`.
			assetMatch: archAssetMatch({
				linux: { x64: "linux_x64.tar.gz", arm64: "linux_arm64.tar.gz" },
				darwin: { x64: "darwin_x64.tar.gz", arm64: "darwin_arm64.tar.gz" },
				win32: { x64: "windows_x64.zip", arm64: "windows_arm64.zip" },
			}),
			binaryInArchive: "gitleaks",
		},
	},
	{
		id: "trivy",
		name: "Trivy",
		checkCommand: "trivy",
		checkArgs: ["--version"],
		installStrategy: "github",
		binaryName: "trivy",
		github: {
			repo: "aquasecurity/trivy",
			// Trivy asset naming is `trivy_<ver>_<OS>-<bits>.{tar.gz,zip}` with a
			// capitalized OS and `64bit`/`ARM64` arch tokens — e.g.
			// `trivy_0.71.2_Linux-64bit.tar.gz`, `trivy_0.71.2_macOS-ARM64.tar.gz`.
			// No windows-arm64 asset exists (win32.arm64 omitted), so (like
			// swiftlint) trivy is absent from GITHUB_TOOLS and covered by the
			// weaker "at least one platform" guard.
			assetMatch: archAssetMatch({
				linux: { x64: "Linux-64bit.tar.gz", arm64: "Linux-ARM64.tar.gz" },
				darwin: { x64: "macOS-64bit.tar.gz", arm64: "macOS-ARM64.tar.gz" },
				win32: { x64: "windows-64bit.zip" },
			}),
			binaryInArchive: "trivy",
		},
	},
	{
		id: "swiftlint",
		name: "SwiftLint",
		checkCommand: "swiftlint",
		checkArgs: ["--version"],
		installStrategy: "github",
		binaryName: "swiftlint",
		github: {
			repo: "realm/SwiftLint",
			assetMatch: (platform, arch) => {
				if (platform === "darwin") return "portable_swiftlint.zip";
				if (platform === "linux")
					return arch === "arm64"
						? "swiftlint_linux_arm64.zip"
						: "swiftlint_linux_amd64.zip";
				return undefined;
			},
			binaryInArchive: "swiftlint",
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
		id: "vale",
		name: "Vale",
		checkCommand: "vale",
		checkArgs: ["--version"],
		installStrategy: "github",
		binaryName: "vale",
		github: {
			repo: "vale-cli/vale",
			assetMatch: (platform, arch) => {
				const version = "3.14.2";
				if (platform === "linux")
					return arch === "arm64"
						? `vale_${version}_Linux_arm64.tar.gz`
						: `vale_${version}_Linux_64-bit.tar.gz`;
				if (platform === "darwin")
					return arch === "arm64"
						? `vale_${version}_macOS_arm64.tar.gz`
						: `vale_${version}_macOS_64-bit.tar.gz`;
				if (platform === "win32") return `vale_${version}_Windows_64-bit.zip`;
				return undefined;
			},
			binaryInArchive: "vale",
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
	{
		// clojure-lsp ships a self-contained native (GraalVM) binary per platform
		// on GitHub releases — no JVM needed. Used as managedToolId by ClojureServer.
		// The .zip carries the bare binary (located recursively on extract).
		id: "clojure-lsp",
		name: "clojure-lsp",
		checkCommand: "clojure-lsp",
		checkArgs: ["--version"],
		installStrategy: "github",
		binaryName: "clojure-lsp",
		github: {
			repo: "clojure-lsp/clojure-lsp",
			assetMatch: (platform, arch) => {
				if (platform === "linux")
					return arch === "arm64"
						? "native-linux-aarch64.zip"
						: "native-linux-amd64.zip";
				if (platform === "darwin")
					return arch === "arm64"
						? "native-macos-aarch64.zip"
						: "native-macos-amd64.zip";
				// Only an x86_64 Windows native build; runs on arm64 via emulation.
				if (platform === "win32") return "native-windows-amd64.zip";
				return undefined;
			},
			binaryInArchive: "clojure-lsp",
		},
	},
	{
		// gleam ships a single static binary per platform on GitHub releases; the
		// LSP runs via `gleam lsp`. Used as managedToolId by GleamServer. The linux
		// build is a FLAT musl tarball (a bare `gleam`), handled by the recursive
		// tar-binary lookup in installGitHubTool.
		id: "gleam",
		name: "Gleam",
		checkCommand: "gleam",
		checkArgs: ["--version"],
		installStrategy: "github",
		binaryName: "gleam",
		github: {
			repo: "gleam-lang/gleam",
			assetMatch: (platform, arch) => {
				if (platform === "linux")
					return arch === "arm64"
						? "aarch64-unknown-linux-musl.tar.gz"
						: "x86_64-unknown-linux-musl.tar.gz";
				if (platform === "darwin")
					return arch === "arm64"
						? "aarch64-apple-darwin.tar.gz"
						: "x86_64-apple-darwin.tar.gz";
				if (platform === "win32")
					return arch === "arm64"
						? "aarch64-pc-windows-msvc.zip"
						: "x86_64-pc-windows-msvc.zip";
				return undefined;
			},
			binaryInArchive: "gleam",
		},
	},
	{
		// marksman ships a single BARE (uncompressed) binary per platform on GitHub
		// releases — no archive, so it lands via the bare-binary branch of
		// installGitHubTool (the `else` that writes the asset directly, like shfmt).
		// Used as managedToolId by MarksmanServer; LSP entrypoint is `marksman
		// server` (stdio). macOS ships a universal binary; Windows has only x64
		// (runs on arm64 via emulation) — so all six platform/arch combos resolve.
		id: "marksman",
		name: "Marksman",
		checkCommand: "marksman",
		checkArgs: ["--version"],
		installStrategy: "github",
		binaryName: "marksman",
		github: {
			repo: "artempyanykh/marksman",
			assetMatch: (platform, arch) => {
				if (platform === "linux")
					return arch === "arm64"
						? "marksman-linux-arm64"
						: "marksman-linux-x64";
				if (platform === "darwin") return "marksman-macos";
				if (platform === "win32") return "marksman.exe";
				return undefined;
			},
			// bare binary — no binaryInArchive
		},
	},
	{
		// Expert ships a bare native binary per platform on GitHub releases. Its
		// `--stdio` flag is required to start the LSP transport. Windows arm64 uses
		// the x64 binary through Windows' built-in x64 emulation.
		id: "expert",
		name: "Expert",
		checkCommand: "expert",
		checkArgs: ["--version"],
		installStrategy: "github",
		binaryName: "expert",
		github: {
			repo: "expert-lsp/expert",
			assetMatch: (platform, arch) => {
				if (arch !== "x64" && arch !== "arm64") return undefined;
				if (platform === "linux")
					return arch === "arm64"
						? "expert_linux_arm64"
						: "expert_linux_amd64";
				if (platform === "darwin")
					return arch === "arm64"
						? "expert_darwin_arm64"
						: "expert_darwin_amd64";
				if (platform === "win32") return "expert_windows_amd64.exe";
				return undefined;
			},
			// bare binary — no binaryInArchive
		},
	},
];

const ensureInFlight = new Map<string, Promise<string | undefined>>();

// Session-lifetime cache: once a tool path is resolved, skip the process-spawn check on subsequent calls.
const resolvedPathCache = new Map<string, string>();

// --- Persistent probe cache ---

interface ProbeCacheEntry {
	path: string;
	mtimeMs: number;
	cachedAt: number;
}

type ProbeCache = Record<string, ProbeCacheEntry>;

const PROBE_CACHE_PATH = path.join(getGlobalPiLensDir(), "probe-cache.json");
const PROBE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let _probeCache: ProbeCache | null = null;
let _probeCacheDirty = false;
let _probeCacheFlushTimer: ReturnType<typeof setTimeout> | null = null;

async function readProbeCache(): Promise<ProbeCache> {
	if (_probeCache !== null) return _probeCache;
	try {
		const raw = await fs.readFile(PROBE_CACHE_PATH, "utf-8");
		_probeCache = JSON.parse(raw) as ProbeCache;
	} catch {
		_probeCache = {};
	}
	return _probeCache;
}

function scheduleProbeFlush(): void {
	if (_probeCacheFlushTimer !== null) return;
	_probeCacheFlushTimer = setTimeout(() => {
		_probeCacheFlushTimer = null;
		if (!_probeCacheDirty || _probeCache === null) return;
		_probeCacheDirty = false;
		void fs
			.writeFile(PROBE_CACHE_PATH, JSON.stringify(_probeCache, null, 2))
			.catch(() => {});
	}, 300);
	_probeCacheFlushTimer.unref?.();
}

function isAstGrepVersionOutput(output: string): boolean {
	return /\bast[- ]grep\b/i.test(output);
}

async function verifyAstGrepProbePath(binPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const proc = spawn(binPath, ["--version"], {
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(binPath),
			timeout: 5000,
		});
		let output = "";
		proc.stdout?.on("data", (data) => (output += data));
		proc.stderr?.on("data", (data) => (output += data));
		proc.on("exit", (code) => {
			resolve(code === 0 && isAstGrepVersionOutput(output));
		});
		proc.on("error", () => resolve(false));
	});
}

// Exported for testing only.
export async function checkProbeCache(
	toolId: string,
): Promise<string | undefined> {
	const cache = await readProbeCache();
	const entry = cache[toolId];
	if (!entry) return undefined;

	if (Date.now() - entry.cachedAt > PROBE_CACHE_TTL_MS) {
		logSessionStart(`auto-install probe-cache ${toolId}: miss (ttl expired)`);
		delete cache[toolId];
		_probeCacheDirty = true;
		scheduleProbeFlush();
		return undefined;
	}

	try {
		await fs.access(entry.path);
		const stat = await fs.stat(entry.path);
		if (stat.mtimeMs !== entry.mtimeMs) {
			logSessionStart(
				`auto-install probe-cache ${toolId}: miss (mtime changed)`,
			);
			delete cache[toolId];
			_probeCacheDirty = true;
			scheduleProbeFlush();
			return undefined;
		}
		if (toolId === "ast-grep" && !(await verifyAstGrepProbePath(entry.path))) {
			logSessionStart(
				`auto-install probe-cache ${toolId}: miss (not ast-grep: ${entry.path})`,
			);
			delete cache[toolId];
			_probeCacheDirty = true;
			scheduleProbeFlush();
			return undefined;
		}
		return entry.path;
	} catch {
		logSessionStart(
			`auto-install probe-cache ${toolId}: miss (gone: ${entry.path})`,
		);
		delete cache[toolId];
		_probeCacheDirty = true;
		scheduleProbeFlush();
		return undefined;
	}
}

// Exported for testing only.
export async function updateProbeCache(
	toolId: string,
	resolvedPath: string,
): Promise<void> {
	try {
		const stat = await fs.stat(resolvedPath);
		const cache = await readProbeCache();
		cache[toolId] = {
			path: resolvedPath,
			mtimeMs: stat.mtimeMs,
			cachedAt: Date.now(),
		};
		_probeCacheDirty = true;
		scheduleProbeFlush();
	} catch {
		// best-effort
	}
}

// Exported for testing only.
export function resetProbeCacheStateForTesting(): void {
	_probeCache = null;
	_probeCacheDirty = false;
	resolvedPathCache.clear();
	ensureInFlight.clear();
	if (_probeCacheFlushTimer !== null) {
		clearTimeout(_probeCacheFlushTimer);
		_probeCacheFlushTimer = null;
	}
}

// --- Check Functions ---

/**
 * Check if a command is available in PATH by walking PATH entries and
 * verifying each candidate is a real file with non-zero size.
 * Catches broken symlinks (stat throws ENOENT or returns size 0) without
 * spawning a process — ~μs per candidate vs ~50ms for which/where.
 */
async function isCommandAvailable(
	command: string,
	_args?: string[],
): Promise<boolean> {
	const isWindows = process.platform === "win32";
	const pathEnv =
		process.env.PATH || process.env.Path || process.env.path || "";
	const dirs = pathEnv.split(path.delimiter);

	// On Windows, probe .exe, .cmd, and .bat extensions in addition to bare name.
	// On Unix, probe bare name and extensionless (scripts, symlinks).
	const names = isWindows
		? [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`]
		: [command];

	for (const dir of dirs) {
		if (!dir) continue;
		for (const name of names) {
			const candidate = path.join(dir, name);
			try {
				const stat = statSync(candidate);
				// isFile() returns false for broken symlinks (target missing)
				if (stat.isFile() && stat.size > 0) {
					return true;
				}
			} catch {
				// ENOENT or permission denied — skip this candidate
			}
		}
	}

	return false;
}

// --- Verification Functions

/**
 * Stdio LSP servers built on `vscode-languageserver-node` (the entire
 * `vscode-langservers-extracted` family — json/css/html/eslint, and markdown)
 * reject a bare `--version`: `createConnection()` throws immediately because no
 * transport flag was supplied, and the process exits non-zero. That error is
 * positive proof the binary loaded and is a working LSP server — it just needs
 * `--stdio` to actually run — so `--version`-based verification must treat it as
 * success rather than a broken install (#208). A genuinely broken binary fails
 * with a different error (SyntaxError, ERR_MODULE_NOT_FOUND, …) that does not
 * match this pattern, so the broken-install guard is preserved.
 */
export function isLspTransportRequiredError(output: string): boolean {
	return /Connection (?:input|output) stream is not set|Use arguments of createConnection/i.test(
		output,
	);
}

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

		// When shell:true (Windows .cmd), bake args into the command string to avoid DEP0190.
		const spawnCmd = useShell ? `"${execPath}" --version` : execPath;
		const proc = spawn(spawnCmd, useShell ? [] : ["--version"], {
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
			} else if (isLspTransportRequiredError(`${stdout}\n${stderr}`)) {
				// Valid stdio LSP server that rejects `--version` (#208) — the
				// transport-required error proves the binary works.
				debugLog(`Verified (stdio LSP, transport-required): ${binPath}`);
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
	| "maven-jar"
	| "archive-dist"
	| "npx-fallback"
	| "not-installed";

export interface ToolStatus {
	id: string;
	name: string;
	installed: boolean;
	source: ToolSource;
	path?: string;
	version?: string;
	strategy: ToolDefinition["installStrategy"];
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

		// 0. Tree-bundle archives resolve ONLY to their extract dir — never via a
		// PATH/global probe (the runtime may be present while the bundle is absent).
		if (tool.installStrategy === "archive" && !tool.archive?.launcher) {
			const bundleDir = await getArchiveTreeBundlePath(tool);
			if (bundleDir) {
				status.installed = true;
				status.source = "archive-dist";
				status.path = bundleDir;
			}
			statuses.push(status);
			continue;
		}

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

		// 4. Check managed bin (~/.pi-lens/bin/) — github releases + maven/archive launchers
		if (
			tool.installStrategy === "github" ||
			tool.installStrategy === "maven" ||
			tool.installStrategy === "archive"
		) {
			const githubPath = await findGitHubToolPath(tool.binaryName || tool.id);
			if (githubPath) {
				status.installed = true;
				status.source =
					tool.installStrategy === "maven"
						? "maven-jar"
						: tool.installStrategy === "archive"
							? "archive-dist"
							: "github-release";
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
 * Resolve an installed archive TREE BUNDLE (an `archive` tool with no launcher)
 * to its extract dir, confirmed via the tree marker. Returns undefined when the
 * tool isn't a tree bundle or isn't extracted yet.
 */
async function getArchiveTreeBundlePath(
	tool: ToolDefinition,
): Promise<string | undefined> {
	if (tool.installStrategy !== "archive" || tool.archive?.launcher) {
		return undefined;
	}
	const extractDir = path.join(TOOLS_DIR, tool.id);
	const marker = tool.archive?.treeMarker
		? path.join(extractDir, ...tool.archive.treeMarker.split("/"))
		: extractDir;
	try {
		await fs.access(marker);
		return extractDir;
	} catch {
		return undefined;
	}
}

/**
 * Get the path to a tool (global or local)
 */
/**
 * Resolve a tool's native binary from its per-platform optional-dependency
 * package (e.g. `@ast-grep/cli-linux-x64-gnu`), following pnpm/bun symlinks via
 * the MAIN package's resolver. This is the reliable path for npm/pnpm/bun
 * installs: the JS launcher in the main package frequently can't locate the
 * binary under a symlink/isolated store (or after a skipped postinstall), but
 * the binary is installed — find it directly. Returns undefined if the tool
 * has no platformPackage spec, the platform is unsupported, or it isn't found.
 */
export function resolvePlatformPackageBinary(
	tool: ToolDefinition,
): string | undefined {
	const spec = tool.platformPackage;
	if (!spec || !tool.packageName) return undefined;
	const suffix = spec.suffixes[`${process.platform}-${process.arch}`];
	if (!suffix) return undefined;
	const platformPkg = `${spec.base ?? tool.packageName}-${suffix}`;
	try {
		// Resolve the platform package FROM the main package, which owns it as an
		// optional dependency (pnpm exposes it there, not to arbitrary roots).
		const mainPkgJson = _installerRequire.resolve(
			`${tool.packageName}/package.json`,
		);
		const fromMain = createRequire(mainPkgJson);
		let pkgDir: string;
		try {
			pkgDir = path.dirname(fromMain.resolve(`${platformPkg}/package.json`));
		} catch {
			pkgDir = path.dirname(
				_installerRequire.resolve(`${platformPkg}/package.json`),
			);
		}
		const isWin = process.platform === "win32";
		for (const bin of spec.binaries) {
			for (const name of isWin ? [`${bin}.exe`, bin] : [bin]) {
				const candidate = path.join(pkgDir, name);
				if (existsSync(candidate)) return candidate;
			}
		}
	} catch {
		// not installed / not resolvable for this layout
	}
	return undefined;
}

export async function getToolPath(toolId: string): Promise<string | undefined> {
	const tool = TOOLS.find((t) => t.id === toolId);
	if (!tool) return undefined;

	// Tree-bundle archives (no launcher) are "installed" ONLY when extracted — the
	// extract dir is authoritative. No PATH/global/npm fallback: the runtime that
	// drives the bundle (e.g. pwsh) may be on PATH while the bundle itself is
	// absent, which must NOT read as installed (else the bundle never downloads).
	if (tool.installStrategy === "archive" && !tool.archive?.launcher) {
		return getArchiveTreeBundlePath(tool);
	}

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

	// npm/pnpm/bun: prefer the native per-platform binary directly. The main
	// package's launcher often can't find it under a symlink store / after a
	// skipped postinstall, but the binary IS installed — resolve + verify it
	// before falling back to PATH or a (re)install.
	if (tool.platformPackage) {
		const platformBin = resolvePlatformPackageBinary(tool);
		if (platformBin && (await verifyToolBinary(platformBin))) {
			logSessionStart(
				`auto-install ${toolId}: resolved platform-package binary at ${platformBin}`,
			);
			return platformBin;
		}
		logSessionStart(
			`auto-install ${toolId}: platform-package binary not resolved (${process.platform}-${process.arch}, base=${tool.platformPackage.base ?? tool.packageName}) — falling back to PATH/managed install`,
		);
	}

	// For github/maven tools, prefer the managed install (~/.pi-lens/bin/) over
	// PATH. Managed installs are known-good binaries/launchers pi-lens downloaded
	// as a fallback when a PATH-resolved tool was broken or missing. Checking
	// before PATH ensures force-reinstall flows find the newly downloaded binary.
	if (
		tool.installStrategy === "github" ||
		tool.installStrategy === "maven" ||
		tool.installStrategy === "archive"
	) {
		const githubPath = await findGitHubToolPath(tool.binaryName || tool.id);
		if (githubPath) return githubPath;
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

	// Global bin dirs for every installed manager (npm/pnpm/yarn/bun) — a tool
	// may have been installed globally via any of them.
	for (const dir of await allAvailableGlobalBinDirs()) {
		add(dir);
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
			const isWin = process.platform === "win32";
			// Bake args into command string when shell:true on Windows to avoid DEP0190.
			const spawnCmd = isWin
				? [probe.command, ...probe.args].join(" ")
				: probe.command;
			const proc = spawn(spawnCmd, isWin ? [] : probe.args, {
				stdio: ["ignore", "pipe", "pipe"],
				shell: isWin,
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
 * Authorization header for the GitHub REST API, when a token is available.
 * Unauthenticated GitHub API is 60 req/hr per IP — exhausted constantly on
 * shared-IP CI runners, which silently fails every github-strategy install.
 * Authenticated is 5000 req/hr. Used ONLY for the `api.github.com` metadata
 * call, never the asset download (see installGitHubTool) — the release CDN must
 * not receive the token.
 */
function githubApiAuthHeaders(): Record<string, string> {
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	return token ? { Authorization: `Bearer ${token}` } : {};
}

function sameHost(a: string, b: string): boolean {
	try {
		return new URL(a).host === new URL(b).host;
	} catch {
		return false;
	}
}

/**
 * Fetch a URL, following up to `maxRedirects` redirects.
 * Returns the raw Buffer of the response body. Any caller-supplied headers are
 * dropped when a redirect crosses to a different host, so an Authorization
 * header can never leak to a redirect target (e.g. a release CDN).
 */
function httpsGet(
	url: string,
	maxRedirects = 5,
	headers: Record<string, string> = {},
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		https
			.get(
				url,
				{ headers: { "User-Agent": "pi-lens/1.0", ...headers } },
				(res) => {
					if (
						res.statusCode &&
						res.statusCode >= 300 &&
						res.statusCode < 400 &&
						res.headers.location
					) {
						if (maxRedirects === 0)
							return reject(new Error("Too many redirects"));
						const location = res.headers.location;
						const nextHeaders = sameHost(url, location)
							? headers
							: (() => {
									const { Authorization: _drop, ...rest } = headers;
									return rest;
								})();
						return resolve(httpsGet(location, maxRedirects - 1, nextHeaders));
					}
					if (res.statusCode !== 200) {
						res.resume();
						return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
					}
					const chunks: Buffer[] = [];
					res.on("data", (chunk: Buffer) => chunks.push(chunk));
					res.on("end", () => resolve(Buffer.concat(chunks)));
					res.on("error", reject);
				},
			)
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
			5,
			githubApiAuthHeaders(),
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
			await fs.writeFile(destPath, decompressed, { mode: 0o750 });
		} else if (assetName.endsWith(".tar.gz") || assetName.endsWith(".tar.xz")) {
			// Write archive to temp file, extract with system tar
			const tmpArchive = path.join(GITHUB_BIN_DIR, `_tmp_${assetName}`);
			await fs.writeFile(tmpArchive, assetBuffer);
			const tmpDir = path.join(GITHUB_BIN_DIR, `_tmp_extract_${tool.id}`);
			await fs.mkdir(tmpDir, { recursive: true });

			const extracted = await runCommand(
				"tar",
				["xf", tmpArchive, "-C", tmpDir],
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

			// Locate the binary at any depth — handles both flat tarballs (e.g.
			// gleam ships a bare `gleam` at the archive root) and tools nested
			// under a top-level dir (e.g. shellcheck-vX/shellcheck). Each registered
			// tar tool has a uniquely-named binary, so a recursive match is
			// unambiguous; this replaces the old `--strip-components=1` assumption,
			// which silently extracted nothing from a flat tarball.
			const tarBinaryName = spec.binaryInArchive ?? binaryName;
			const tarSrcBinary = await findFirstFileRecursive(
				tmpDir,
				getArchiveBinaryCandidates(tarBinaryName, platform, assetName),
			);
			if (!tarSrcBinary) {
				await fs.rm(tmpDir, { recursive: true, force: true });
				logSessionStart(
					`github-install ${tool.id}: binary candidates ${JSON.stringify(
						getArchiveBinaryCandidates(tarBinaryName, platform, assetName),
					)} not found in tar ${assetName}`,
				);
				return undefined;
			}
			await fs.rename(tarSrcBinary, destPath);
			await fs.rm(tmpDir, { recursive: true, force: true });
			if (!isWindows) await fs.chmod(destPath, 0o750);
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
			if (!isWindows) await fs.chmod(destPath, 0o750);
		} else {
			// Bare binary (e.g. shfmt_*_linux_amd64)
			await fs.writeFile(destPath, assetBuffer, { mode: 0o750 });
		}
	} catch (err) {
		logSessionStart(
			`github-install ${tool.id}: install failed: ${(err as Error).message}`,
		);
		return undefined;
	}

	// Download any sibling assets the primary wrapper depends on (e.g. ktlint's
	// `ktlint` jar next to `ktlint.bat`, #218). Matched by EXACT name and written
	// as bare files into the same dir; a missing one fails the install.
	for (const extraName of spec.extraAssets?.(platform, arch) ?? []) {
		const extraAsset = releaseJson.assets.find((a) => a.name === extraName);
		if (!extraAsset) {
			logSessionStart(
				`github-install ${tool.id}: required extra asset "${extraName}" not found`,
			);
			return undefined;
		}
		try {
			const extraBuffer = await httpsGet(extraAsset.browser_download_url);
			await fs.writeFile(path.join(GITHUB_BIN_DIR, extraName), extraBuffer, {
				mode: 0o750,
			});
			logSessionStart(
				`github-install ${tool.id}: installed extra asset ${extraName} (${extraBuffer.length} bytes)`,
			);
		} catch (err) {
			logSessionStart(
				`github-install ${tool.id}: extra asset ${extraName} download failed: ${(err as Error).message}`,
			);
			return undefined;
		}
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

const MAVEN_CENTRAL_BASE = "https://repo1.maven.org/maven2";

/**
 * Install a Maven-distributed runnable fat JAR: download it into the managed bin
 * and write a `java -jar` launcher next to it (so it resolves like any managed
 * binary via findGitHubToolPath). Requires a JRE — gated on `java` availability.
 */
async function installMavenTool(
	tool: ToolDefinition,
): Promise<string | undefined> {
	const spec = tool.maven;
	if (!spec) return undefined;
	const binaryName = tool.binaryName ?? tool.id;
	const isWindows = process.platform === "win32";

	if (!(await isCommandAvailable("java", ["-version"]))) {
		logSessionStart(
			`maven-install ${tool.id}: java not found — a JAR tool can't run without a JRE`,
		);
		return undefined;
	}

	// Strip trailing slashes without a regex (the `\/+$` form trips ReDoS
	// scanners — S5852 — even though the input is a trusted constant/registry
	// value). A plain loop is unambiguously linear.
	let base = spec.repoBaseUrl ?? MAVEN_CENTRAL_BASE;
	while (base.endsWith("/")) base = base.slice(0, -1);
	const groupPath = spec.groupId.replace(/\./g, "/");
	const jarFile = `${spec.artifactId}-${spec.version}${
		spec.classifier ? `-${spec.classifier}` : ""
	}.jar`;
	const url = `${base}/${groupPath}/${spec.artifactId}/${spec.version}/${jarFile}`;

	logSessionStart(`maven-install ${tool.id}: downloading ${url}`);
	let jarBuffer: Buffer;
	try {
		jarBuffer = await httpsGet(url);
	} catch (err) {
		logSessionStart(
			`maven-install ${tool.id}: download failed: ${(err as Error).message}`,
		);
		return undefined;
	}

	try {
		await fs.mkdir(GITHUB_BIN_DIR, { recursive: true });
		const jarPath = path.join(GITHUB_BIN_DIR, `${tool.id}.jar`);
		await fs.writeFile(jarPath, jarBuffer);

		// Launcher so the tool resolves as a normal command in the managed bin.
		const launcherName = isWindows ? `${binaryName}.bat` : binaryName;
		const launcherPath = path.join(GITHUB_BIN_DIR, launcherName);
		if (isWindows) {
			await fs.writeFile(
				launcherPath,
				`@echo off\r\njava -jar "%~dp0${tool.id}.jar" %*\r\n`,
			);
		} else {
			await fs.writeFile(
				launcherPath,
				`#!/bin/sh\nexec java -jar "$(dirname "$0")/${tool.id}.jar" "$@"\n`,
				{ mode: 0o750 },
			);
		}
		logSessionStart(
			`maven-install ${tool.id}: installed → ${launcherPath} (${jarBuffer.length} bytes)`,
		);
		debugLog(`[maven] installed ${tool.name} → ${launcherPath}`);
		return launcherPath;
	} catch (err) {
		logSessionStart(
			`maven-install ${tool.id}: install failed: ${(err as Error).message}`,
		);
		return undefined;
	}
}

/**
 * Install a tool that ships as a distribution archive (.tgz/.zip with a lib/ of
 * JARs + bin/ launchers — e.g. SpotBugs), not a single runnable binary or fat
 * JAR. Downloads the archive, extracts it (top-level dir stripped) into
 * ~/.pi-lens/tools/<id>/, then writes a thin launcher shim into the managed bin
 * so the tool resolves like any other via findGitHubToolPath. Extraction uses
 * `tar` (present on Windows 10+ as bsdtar, which also reads .zip).
 */
/**
 * Resolve an {@link ArchiveSpec} download URL for the current platform/arch.
 * A string URL is platform-agnostic; a function resolves per platform/arch and
 * may return `undefined` (unsupported → caller degrades to "unavailable").
 * Exported for the tool-registry contract test.
 */
export function resolveArchiveUrl(
	spec: ArchiveSpec,
	platform: string = process.platform,
	arch: string = process.arch,
): string | undefined {
	return typeof spec.url === "function" ? spec.url(platform, arch) : spec.url;
}

async function installArchiveTool(
	tool: ToolDefinition,
): Promise<string | undefined> {
	const spec = tool.archive;
	if (!spec) return undefined;
	const binaryName = tool.binaryName ?? tool.id;
	const isWindows = process.platform === "win32";

	const url = resolveArchiveUrl(spec);
	if (!url) {
		logSessionStart(
			`archive-install ${tool.id}: no archive for ${process.platform}/${process.arch} — unsupported, skipping`,
		);
		return undefined;
	}

	logSessionStart(`archive-install ${tool.id}: downloading ${url}`);
	let archiveBuffer: Buffer;
	try {
		archiveBuffer = await httpsGet(url);
	} catch (err) {
		logSessionStart(
			`archive-install ${tool.id}: download failed: ${(err as Error).message}`,
		);
		return undefined;
	}

	// Use basenames + cwd:TOOLS_DIR for the tar spawn so no argument contains a
	// drive-letter colon — GNU tar (MSYS) otherwise reads `C:\…` as an rsync
	// `host:path` ("Cannot connect to C:"). Relative paths work for both GNU tar
	// and Windows bsdtar, so we avoid the GNU-only `--force-local` (which bsdtar
	// rejects). fs.* calls still use the absolute paths.
	const extractName = tool.id;
	const archiveName = `${tool.id}.download.${spec.kind === "zip" ? "zip" : "tgz"}`;
	const extractDir = path.join(TOOLS_DIR, extractName);
	const tmpArchive = path.join(TOOLS_DIR, archiveName);
	try {
		await fs.mkdir(TOOLS_DIR, { recursive: true });
		// Clear any prior extraction so a reinstall is clean.
		await fs.rm(extractDir, { recursive: true, force: true });
		await fs.mkdir(extractDir, { recursive: true });
		await fs.writeFile(tmpArchive, archiveBuffer);

		// `--strip-components=N` drops N leading path components. Default 1 drops a
		// versioned top-level dir so a launcher path stays stable (bin/… not
		// spotbugs-X.Y.Z/bin/…). A TREE BUNDLE (stripComponents:0) has no wrapping
		// dir — stripping would flatten/merge its sibling module folders — so the
		// flag is omitted. bsdtar handles both .tgz and .zip with -xf.
		const stripComponents = spec.stripComponents ?? 1;
		const tarArgs = [
			spec.kind === "tgz" ? "-xzf" : "-xf",
			archiveName,
			"-C",
			extractName,
			...(stripComponents > 0
				? [`--strip-components=${stripComponents}`]
				: []),
		];
		// Resolve `tar` to an absolute path on Windows (System32\tar.exe is the
		// bsdtar shipped with Windows 10+) so extraction can't be hijacked via a
		// writable PATH entry — same hardening as the taskkill spawn. On POSIX `tar`
		// is a trusted coreutil whose absolute path varies by distro, so it stays
		// bare (consistent with every other tool spawn).
		const tarBin = isWindows
			? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe`
			: "tar";
		const extracted = await new Promise<{ ok: boolean; stderr: string }>(
			(resolve) => {
				const proc = spawn(tarBin, tarArgs, {
					cwd: TOOLS_DIR,
					stdio: ["ignore", "ignore", "pipe"],
				});
				let stderr = "";
				proc.stderr?.on("data", (d) => (stderr += d));
				const timer = setTimeout(() => {
					proc.kill();
					resolve({ ok: false, stderr: "extraction timed out" });
				}, 120_000);
				proc.on("exit", (code) => {
					clearTimeout(timer);
					resolve({ ok: code === 0, stderr });
				});
				proc.on("error", (err) => resolve({ ok: false, stderr: err.message }));
			},
		);
		await fs.rm(tmpArchive, { force: true });
		if (!extracted.ok) {
			logSessionStart(
				`archive-install ${tool.id}: extraction failed: ${extracted.stderr}`,
			);
			return undefined;
		}

		// Tree bundle (no launcher): the whole extracted tree IS the artifact. Verify
		// the marker exists and resolve to the extract dir — the consuming server
		// launches a runtime against a bootstrap inside it (e.g. PSES via pwsh).
		if (!spec.launcher) {
			const marker = spec.treeMarker
				? path.join(extractDir, ...spec.treeMarker.split("/"))
				: extractDir;
			try {
				await fs.access(marker);
			} catch {
				logSessionStart(
					`archive-install ${tool.id}: tree marker not found at ${marker} after extraction`,
				);
				return undefined;
			}
			logSessionStart(
				`archive-install ${tool.id}: installed tree bundle → ${extractDir} (extracted ${archiveBuffer.length} bytes)`,
			);
			debugLog(`[archive] installed ${tool.name} bundle → ${extractDir}`);
			return extractDir;
		}

		// The launcher inside the extracted tree (e.g. bin/spotbugs[.bat]).
		const innerLauncher = path.join(
			extractDir,
			...spec.launcher.split("/").map((p) => p),
		);
		const resolvedInner = isWindows ? `${innerLauncher}.bat` : innerLauncher;
		try {
			await fs.access(resolvedInner);
		} catch {
			logSessionStart(
				`archive-install ${tool.id}: launcher not found at ${resolvedInner} after extraction`,
			);
			return undefined;
		}
		if (!isWindows) await fs.chmod(resolvedInner, 0o750).catch(() => {});

		// Thin shim in the managed bin so discovery (findGitHubToolPath) resolves
		// it like any other managed tool. `call`/`exec` preserves the real
		// launcher's own %~dp0/$0 so it still finds its sibling lib/.
		await fs.mkdir(GITHUB_BIN_DIR, { recursive: true });
		const launcherName = isWindows ? `${binaryName}.bat` : binaryName;
		const shimPath = path.join(GITHUB_BIN_DIR, launcherName);
		if (isWindows) {
			await fs.writeFile(
				shimPath,
				`@echo off\r\ncall "${resolvedInner}" %*\r\n`,
			);
		} else {
			await fs.writeFile(
				shimPath,
				`#!/bin/sh\nexec "${resolvedInner}" "$@"\n`,
				{ mode: 0o750 },
			);
		}
		logSessionStart(
			`archive-install ${tool.id}: installed → ${shimPath} (extracted ${archiveBuffer.length} bytes)`,
		);
		debugLog(`[archive] installed ${tool.name} → ${shimPath}`);
		return shimPath;
	} catch (err) {
		await fs.rm(tmpArchive, { force: true }).catch(() => {});
		logSessionStart(
			`archive-install ${tool.id}: install failed: ${(err as Error).message}`,
		);
		return undefined;
	}
}

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

		// Resolve the package manager for the tools dir and build install args.
		const isWindows = process.platform === "win32";
		const pm = await resolveNodePackageManager(TOOLS_DIR);
		const pmCommand = pmBinary(pm);
		// Use --ignore-scripts unless the package explicitly needs postinstall
		// (e.g. biome downloads a platform-specific native binary via postinstall).
		const needsScripts = NEEDS_POSTINSTALL.has(packageName);
		const baseInstallArgs = installArgs(pm, packageName, {
			ignoreScripts: !needsScripts,
		});

		const INSTALL_TIMEOUT_MS = 120_000;
		const runInstallAttempt = async (
			args: string[],
		): Promise<{ ok: boolean; stderr: string }> =>
			new Promise((resolve) => {
				const proc = spawn(pmCommand, args, {
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

		// --legacy-peer-deps is npm-only; retry just npm's ERESOLVE failures.
		const erResolve =
			outcome.ok === false &&
			/npm\s+error\s+ERESOLVE|\bERESOLVE\b|could not resolve/i.test(
				outcome.stderr,
			);

		if (pm === "npm" && erResolve) {
			const retryArgs = installArgs(pm, packageName, {
				ignoreScripts: !needsScripts,
				legacyPeerDeps: true,
			});
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
				await fs.chmod(binPath, 0o750);
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

async function installGemTool(
	packageName: string,
): Promise<string | undefined> {
	try {
		const isWindows = process.platform === "win32";
		const outcome = await new Promise<{ ok: boolean; error: string }>(
			(resolve) => {
				const proc = spawn("gem", ["install", packageName, "--no-document"], {
					stdio: ["ignore", "pipe", "pipe"],
					shell: isWindows,
				});

				let stderr = "";
				proc.stderr?.on("data", (data) => (stderr += data));
				proc.on("exit", (code) => {
					resolve({ ok: code === 0, error: stderr.trim() });
				});
				proc.on("error", (err) => {
					resolve({ ok: false, error: err.message });
				});
			},
		);

		if (!outcome.ok) {
			throw new Error(
				`Failed to install ${packageName} via gem: ${outcome.error}`,
			);
		}

		return packageName;
	} catch (err) {
		logSessionStart(
			`auto-install gem ${packageName}: exception: ${(err as Error).message}`,
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

			case "gem": {
				if (!tool.packageName) return false;
				const gemPath = await installGemTool(tool.packageName);
				const ok = gemPath !== undefined;
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

			case "maven": {
				if (!tool.maven) return false;
				const mavenPath = await installMavenTool(tool);
				const ok = mavenPath !== undefined;
				logSessionStart(
					`auto-install ${tool.id}: ${ok ? "success" : "failed"} (${Date.now() - startedAt}ms)`,
				);
				return ok;
			}

			case "archive": {
				if (!tool.archive) return false;
				const archivePath = await installArchiveTool(tool);
				const ok = archivePath !== undefined;
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
export async function ensureTool(
	toolId: string,
	opts?: { forceReinstall?: boolean; allowInstall?: boolean },
): Promise<string | undefined> {
	const cacheResolvedPath = (result: string | undefined): string | undefined => {
		if (result) {
			resolvedPathCache.set(toolId, result);
			void updateProbeCache(toolId, result);
		}
		return result;
	};

	// forceReinstall: nuke caches, download from managed source, skip PATH entirely.
	// Used when a PATH-resolved tool proves broken at launch (e.g. broken symlink).
	// allowInstall:false wins over forceReinstall: caches are still cleared, but
	// the function falls back to discovery-only and never downloads.
	if (opts?.forceReinstall) {
		const ensureStartMs = Date.now();
		logSessionStart(
			`auto-install ensure ${toolId}: force reinstall — clearing caches`,
		);

		// Clear in-memory session cache
		resolvedPathCache.delete(toolId);

		// Clear persistent probe cache entry so getToolPath won't return stale PATH result
		try {
			const probeCache = await readProbeCache();
			delete probeCache[toolId];
			_probeCacheDirty = true;
			scheduleProbeFlush();
		} catch {
			// best-effort
		}

		if (opts.allowInstall === false) {
			logSessionStart(
				`auto-install ensure ${toolId}: force reinstall blocked — install disabled, discovery only (${Date.now() - ensureStartMs}ms)`,
			);
			return cacheResolvedPath(await getToolPath(toolId));
		}

		// Force download
		const installed = await installTool(toolId);
		if (!installed) {
			logSessionStart(
				`auto-install ensure ${toolId}: force reinstall failed (${Date.now() - ensureStartMs}ms)`,
			);
			return undefined;
		}

		// Find the newly installed binary (github-local check now comes before PATH)
		const result = cacheResolvedPath(await getToolPath(toolId));
		if (result) {
			logSessionStart(
				`auto-install ensure ${toolId}: force reinstall success at ${result} (${Date.now() - ensureStartMs}ms)`,
			);
		}
		return result;
	}

	// Fast path 1: in-memory session cache — no I/O.
	const cached = resolvedPathCache.get(toolId);
	if (cached) return cached;

	// Fast path 2: persistent probe cache — fs.access + stat, no process spawn.
	const diskCached = await checkProbeCache(toolId);
	if (diskCached) {
		resolvedPathCache.set(toolId, diskCached);
		logSessionStart(
			`auto-install ensure ${toolId}: probe cache hit → ${diskCached}`,
		);
		return diskCached;
	}

	// Coalesce the whole ensure operation, not just installation. Most startup
	// duplicates race while checking already-installed tools, before installTool()
	// would ever run. The key includes the install policy so a discovery-only
	// caller cannot accidentally inherit an install-allowed caller's download (or
	// vice versa).
	const inFlightKey =
		opts?.allowInstall === false ? `${toolId}:discovery-only` : toolId;
	const inFlight = ensureInFlight.get(inFlightKey);
	if (inFlight) {
		logSessionStart(
			`auto-install ensure ${toolId}: waiting for in-flight ensure (${inFlightKey})`,
		);
		return inFlight;
	}

	const ensureStartMs = Date.now();
	const ensurePromise = (async () => {
		logSessionStart(`auto-install ensure ${toolId}: start`);

		// Check if already installed.
		const existingPath = await getToolPath(toolId);
		if (existingPath) {
			resolvedPathCache.set(toolId, existingPath);
			void updateProbeCache(toolId, existingPath);
			logSessionStart(
				`auto-install ensure ${toolId}: already available at ${existingPath} (${Date.now() - ensureStartMs}ms)`,
			);
			return existingPath;
		}

		// Discovery and install are SEPARATE concerns. getToolPath() above already
		// probed PATH / npm-global / managed bin — offline-safe, no download. When the
		// caller forbids installs (allowInstall:false, e.g. PI_LENS_DISABLE_LSP_INSTALL=1)
		// we must still return a discovered binary and only skip the actual install.
		if (opts?.allowInstall === false) {
			logSessionStart(
				`auto-install ensure ${toolId}: install disabled — discovery only, not found (${Date.now() - ensureStartMs}ms)`,
			);
			return undefined;
		}

		const installed = await installTool(toolId);
		if (!installed) {
			logSessionStart(
				`auto-install ensure ${toolId}: unavailable (${Date.now() - ensureStartMs}ms)`,
			);
			return undefined;
		}

		const result = await getToolPath(toolId);
		if (result) {
			resolvedPathCache.set(toolId, result);
			void updateProbeCache(toolId, result);
			logSessionStart(
				`auto-install ensure ${toolId}: success at ${result} (${Date.now() - ensureStartMs}ms)`,
			);
		} else {
			logSessionStart(
				`auto-install ensure ${toolId}: unavailable (${Date.now() - ensureStartMs}ms)`,
			);
		}
		return result;
	})();

	ensureInFlight.set(inFlightKey, ensurePromise);
	try {
		return await ensurePromise;
	} finally {
		ensureInFlight.delete(inFlightKey);
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
 * GitHub-release tools that ship an asset for **every** supported
 * platform/arch combo (linux/darwin/win32 × x64/arm64). This is the set the
 * full asset-matrix test (tests/clients/installer/github-release.test.ts)
 * iterates, so membership must stay in lockstep with the registry — the
 * tool-registry-consistency test enforces that every `installStrategy: "github"`
 * entry resolving all six combos appears here, and vice versa.
 *
 * `swiftlint` is deliberately absent: it has no Windows asset (macOS + Linux
 * only), so it cannot satisfy the full matrix and is covered by the weaker
 * "at least one platform" guard instead.
 */
export const GITHUB_TOOLS = [
	"shellcheck",
	"shfmt",
	"rust-analyzer",
	"golangci-lint",
	"ktlint",
	"actionlint",
	"zizmor",
	"typos-lsp",
	"tflint",
	"terraform-ls",
	"zls",
	"hadolint",
	"gitleaks",
	"taplo",
	"vale",
	"opengrep",
	"deno",
	"clojure-lsp",
	"gleam",
	"marksman",
	"expert",
] as const;
export type GitHubToolId = (typeof GITHUB_TOOLS)[number];

/**
 * Resolve the GitHub asset filename substring for a tool on a given platform/arch.
 * Returns undefined if the tool has no GitHub spec or no asset for the platform.
 * Exported for testing only.
 */
export function resolveGitHubAsset(
	toolId: GitHubToolId,
	platform: string,
	arch: string,
): string | undefined {
	const tool = TOOLS.find((t) => t.id === toolId);
	return tool?.github?.assetMatch(platform, arch);
}

export function resolveGitHubInstalledBinaryName(
	toolId: GitHubToolId,
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
	toolId: GitHubToolId,
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
