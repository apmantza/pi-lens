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
import { existsSync, statSync, unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import https from "node:https";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { writeFileAtomicAsync } from "../atomic-write.js";
import { BoundedLruCache } from "../bounded-cache.js";
import { logExtension } from "../extension-log.js";
import { isFullyQualified } from "../path-utils.js";
import {
	assertInstallAllowed,
	projectTrustDenialReason,
} from "../project-trust.js";

const _installerRequire = createRequire(import.meta.url);

import { createGunzip } from "node:zlib";
import { TRANSIENT_MAX_COOLDOWN_MS } from "../dispatch/runners/utils/availability-policy.js";
import { recordDegradationOnce } from "../degradation-ledger.js";
import { commitDurableStoreAsync } from "../durable-store.js";
import { getGlobalPiLensDir } from "../file-utils.js";
import {
	allAvailableGlobalBinDirs,
	installArgs,
	pmBinary,
	resolveNodePackageManager,
} from "../package-manager.js";
import {
	resetSafeSpawnWindowsCommandCache,
	safeSpawnAsync,
} from "../safe-spawn.js";
import { logSessionStart } from "../sessionstart-logger.js";

// Global installation directory for pi-lens tools
const TOOLS_DIR = path.join(getGlobalPiLensDir(), "tools");
const INSTALL_LOCK_PATH = path.join(TOOLS_DIR, ".install.lock");
const activeInstallLocks = new Set<string>();
let installLockExitCleanupRegistered = false;

/**
 * The managed tools tree, for callers that need to tell a path `getToolPath()`
 * returned from the managed install apart from a global/PATH hit (the tool
 * registry is this module's business — don't re-derive `<pi-lens home>/tools`).
 */
export function getManagedToolsDir(): string {
	return TOOLS_DIR;
}

interface InstallLockOwner {
	pid: number;
	createdAt: number;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function acquireInstallLock(): Promise<{
	release?: () => Promise<void>;
	reason?: string;
}> {
	await fs.mkdir(TOOLS_DIR, { recursive: true });
	// #946 review F2: the waiter's bound must exceed the owner's install bound
	// (PI_LENS_INSTALL_TIMEOUT_MS, default 120s) — a 30s waiter gave up on a
	// legitimate slow install and reported the tool unavailable for the whole
	// session even though it arrived seconds later.
	const timeoutMs =
		Number(process.env.PI_LENS_INSTALL_LOCK_TIMEOUT_MS) || 150_000;
	const deadline = Date.now() + timeoutMs;
	let lastOwner = "unknown owner";

	while (Date.now() < deadline) {
		try {
			const handle = await fs.open(INSTALL_LOCK_PATH, "wx");
			await handle.writeFile(
				JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
			);
			await handle.close();
			activeInstallLocks.add(INSTALL_LOCK_PATH);
			if (!installLockExitCleanupRegistered) {
				installLockExitCleanupRegistered = true;
				process.once("exit", () => {
					for (const lockPath of activeInstallLocks) {
						try {
							unlinkSync(lockPath);
						} catch {
							// Best effort; the next owner verifies this PID is dead.
						}
					}
				});
			}
			let released = false;
			return {
				release: async () => {
					if (released) return;
					released = true;
					activeInstallLocks.delete(INSTALL_LOCK_PATH);
					await fs.rm(INSTALL_LOCK_PATH, { force: true });
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				const owner = JSON.parse(
					await fs.readFile(INSTALL_LOCK_PATH, "utf8"),
				) as InstallLockOwner;
				lastOwner = `pid=${owner.pid} createdAt=${owner.createdAt}`;
				// #946 review F1: PID liveness alone cannot detect a hard-killed
				// owner whose PID Windows has recycled — that lock would poison
				// every future install with a full-timeout wait. A lock older
				// than any legitimate install (owner install bound + slack) is
				// stale regardless of what the PID now points at.
				const maxAgeMs =
					(Number(process.env.PI_LENS_INSTALL_TIMEOUT_MS) || 120_000) + 60_000;
				const expired =
					Number.isFinite(owner.createdAt) &&
					Date.now() - owner.createdAt > maxAgeMs;
				if (
					expired ||
					(Number.isInteger(owner.pid) &&
						owner.pid > 0 &&
						!isProcessAlive(owner.pid))
				) {
					await fs.rm(INSTALL_LOCK_PATH, { force: true });
					continue;
				}
			} catch (readError) {
				lastOwner = "unreadable owner";
				// An unreadable/empty lock has no createdAt to age out — fall
				// back to the file's own mtime for the max-age check so it is
				// eventually recoverable (#946 review F1/F6).
				try {
					const stat = await fs.stat(INSTALL_LOCK_PATH);
					const maxAgeMs =
						(Number(process.env.PI_LENS_INSTALL_TIMEOUT_MS) || 120_000) +
						60_000;
					if (Date.now() - stat.mtimeMs > maxAgeMs) {
						await fs.rm(INSTALL_LOCK_PATH, { force: true });
						continue;
					}
				} catch {
					// stat raced a release — loop and retry acquisition.
				}
				void readError;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	return {
		reason: `timed out after ${timeoutMs}ms waiting for shared tools install lock (${lastOwner})`,
	};
}

// Directory for GitHub-downloaded binaries
const GITHUB_BIN_DIR = path.join(getGlobalPiLensDir(), "bin");

// Debug flag - set via PI_LENS_DEBUG=1 or --debug
const DEBUG =
	process.env.PI_LENS_DEBUG === "1" || process.argv.includes("--debug");

/** Test-only platform seam for Windows resource-layout coverage on Linux CI. */
function installerPlatform(): NodeJS.Platform {
	const override = process.env.PI_LENS_TEST_PLATFORM;
	if (override === "win32" || override === "linux") {
		return override;
	}
	return process.platform;
}

/**
 * Log debug messages only when DEBUG is enabled
 */
function debugLog(...args: unknown[]): void {
	if (DEBUG) {
		// #1333: DEBUG gate preserved; sink is extension.log, never the TUI.
		logExtension({
			subsystem: "auto-install",
			level: "debug",
			message: args
				.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
				.join(" "),
		});
	}
}

// --- Tool Definitions ---

/**
 * The subset of a GitHub `releases/latest` response pi-lens reads: the tag that
 * identifies the release, and the downloadable assets attached to it.
 */
export interface GitHubReleaseMetadata {
	tag_name?: string;
	assets: Array<{ name: string; browser_download_url: string }>;
}

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
 * arch ⇒ unsupported (`undefined`). Arches outside x64/arm64 (ia32, ppc64, …)
 * are unsupported too — no release entry ships a 32-bit or exotic asset, and
 * handing back the x64 substring there would install an unrunnable binary.
 */
function archAssetMatch(table: {
	linux?: { x64?: string; arm64?: string };
	darwin?: { x64?: string; arm64?: string };
	win32?: { x64?: string; arm64?: string };
}): (platform: string, arch: string) => string | undefined {
	return (platform, arch) => {
		if (arch !== "x64" && arch !== "arm64") return undefined;
		return table[platform as "linux" | "darwin" | "win32"]?.[arch];
	};
}

// Go-style `<os>_<arch>.zip` release assets, shared verbatim by tflint and
// terraform-ls — both entries carried byte-identical ladders, down to the asset
// strings themselves.
const OS_ARCH_ZIP_ASSETS = {
	linux: { x64: "linux_amd64.zip", arm64: "linux_arm64.zip" },
	darwin: { x64: "darwin_amd64.zip", arm64: "darwin_arm64.zip" },
	win32: { x64: "windows_amd64.zip", arm64: "windows_arm64.zip" },
};

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
		// The managed compiler serves the classic typescript-language-server
		// fallback. TypeScript 7 removed lib/tsserver.js and is selected only from
		// project-local installs through the native `tsc --lsp --stdio` path.
		// Revisit when typescript-language-server supports TS 7 — refs #1436.
		packageName: "typescript@5.9.3",
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
		id: "fish-lsp",
		name: "Fish Language Server",
		checkCommand: "fish-lsp",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "fish-lsp",
		binaryName: "fish-lsp",
	},
	{
		id: "cmake-language-server",
		name: "CMake Language Server",
		checkCommand: "cmake-language-server",
		checkArgs: ["--version"],
		installStrategy: "pip",
		packageName: "cmake-language-server",
		binaryName: "cmake-language-server",
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
		id: "helm",
		name: "Helm",
		checkCommand: "helm",
		checkArgs: ["version", "--short"],
		installStrategy: "github",
		binaryName: "helm",
		github: {
			repo: "helm/helm",
			assetMatch: (platform, arch) => {
				// helm publishes per-OS archives: tar.gz for POSIX, zip for Windows.
				const cpu = arch === "arm64" ? "arm64" : "amd64";
				if (platform === "linux") return `linux-${cpu}.tar.gz`;
				if (platform === "darwin") return `darwin-${cpu}.tar.gz`;
				if (platform === "win32") return `windows-${cpu}.zip`;
				return undefined;
			},
			// Release archives nest the executable under an OS/arch directory;
			// the installer searches recursively and adds the Windows suffix.
			binaryInArchive: "helm",
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
		checkArgs: [
			"-NoProfile",
			"-Command",
			"$PSVersionTable.PSVersion.ToString()",
		],
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
					return arch === "x64"
						? `${base}/clangd-linux-${version}.zip`
						: undefined;
				if (platform === "darwin") return `${base}/clangd-mac-${version}.zip`;
				if (platform === "win32")
					return `${base}/clangd-windows-${version}.zip`;
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
			assetMatch: archAssetMatch(OS_ARCH_ZIP_ASSETS),
			binaryInArchive: "tflint",
		},
	},
	{
		// Terragrunt ships a bare native binary per platform on GitHub releases.
		// Windows arm64 uses the x64 binary through Windows' built-in emulation —
		// there is no terragrunt_windows_arm64.exe upstream.
		id: "terragrunt",
		name: "terragrunt",
		checkCommand: "terragrunt",
		checkArgs: ["--version"],
		installStrategy: "github",
		binaryName: "terragrunt",
		github: {
			repo: "gruntwork-io/terragrunt",
			assetMatch: archAssetMatch({
				linux: {
					x64: "terragrunt_linux_amd64",
					arm64: "terragrunt_linux_arm64",
				},
				darwin: {
					x64: "terragrunt_darwin_amd64",
					arm64: "terragrunt_darwin_arm64",
				},
				win32: {
					x64: "terragrunt_windows_amd64.exe",
					arm64: "terragrunt_windows_amd64.exe",
				},
			}),
			// bare binary — no binaryInArchive
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
			assetMatch: archAssetMatch(OS_ARCH_ZIP_ASSETS),
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
		// CUE ships a single native binary per platform on GitHub releases;
		// the LSP runs via `cue lsp serve`. Used as managedToolId by CueServer.
		id: "cue",
		name: "CUE",
		checkCommand: "cue",
		checkArgs: ["version"],
		installStrategy: "github",
		binaryName: "cue",
		github: {
			repo: "cue-lang/cue",
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
			binaryInArchive: "cue",
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
					return arch === "arm64" ? "expert_linux_arm64" : "expert_linux_amd64";
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
const installFailureReasons = new Map<string, string>();

/** Last honest install refusal/failure reason for callers that need diagnostics. */
export function getInstallFailureReason(toolId: string): string | undefined {
	return installFailureReasons.get(toolId);
}

/**
 * What the last install attempt for a tool actually DID (#1500 review).
 *
 * `installFailureReasons` cannot answer this and never could: it is a REFUSAL
 * map, written by the `PI_LENS_DISABLE_TOOL_INSTALL` branches and the install-lock
 * skip, and by nothing on the genuine-failure or success paths. Inferring
 * attempt-ness from it inverts the answer in both directions — a kill-switch
 * decline reads as a failed download, and a failed download reads as a policy
 * decision. So the outcome is recorded explicitly, at each branch that knows it.
 *
 *   * `succeeded`  — an install ran and reported success.
 *   * `failed`     — an install ran and did not succeed. The retry candidate.
 *   * `declined`   — policy said no: kill switch, `allowInstall: false`, project
 *                    trust, an unknown tool id. Nothing ran.
 *   * `skipped`    — another process holds the install lock. Nothing ran.
 */
export type InstallAttemptOutcome =
	| "succeeded"
	| "failed"
	| "declined"
	| "skipped";

export interface InstallAttempt {
	outcome: InstallAttemptOutcome;
	/** Why, when there is something to say. */
	reason?: string;
	/** Epoch ms, so a caller can tell a fresh record from a stale one. */
	at: number;
}

const installAttempts = new Map<string, InstallAttempt>();

function noteInstallAttempt(
	toolId: string,
	outcome: InstallAttemptOutcome,
	reason?: string,
): void {
	installAttempts.set(toolId, { outcome, reason, at: Date.now() });
}

/** Record an outcome only if this attempt has not already recorded its own. */
function noteInstallAttemptIfUnrecorded(
	toolId: string,
	outcome: InstallAttemptOutcome,
	reason?: string,
): void {
	if (installAttempts.has(toolId)) return;
	noteInstallAttempt(toolId, outcome, reason);
}

/**
 * What the last install attempt for `toolId` did, or `undefined` when no attempt
 * has been recorded in this session. Consumers map this onto the
 * `availability_decision` record's install evidence (#1500).
 */
export function getInstallAttempt(toolId: string): InstallAttempt | undefined {
	return installAttempts.get(toolId);
}

/**
 * How the last `ensureTool` call for `toolId` resolved a path WITHOUT
 * recording an install attempt (#1636 review). `getInstallAttempt` answers
 * "undefined" for three different situations that a compensating-row consumer
 * must not collapse into one label:
 *
 *   * `"session-cache"` — the in-memory `resolvedPathCache` already held a
 *     verified path (fast path 1).
 *   * `"probe-cache"`   — the persistent on-disk probe cache answered without
 *     a fresh spawn (fast path 2).
 *   * `"path"`          — `getToolPath` found the binary this call, on PATH,
 *     a package manager's global bin dir, or the managed tools dir — a plain
 *     discovery, not a cache hit.
 *
 * Reset alongside `installAttempts` at the top of every `ensureToolResolved`
 * call so a stale source never survives past the attempt it described.
 */
export type EnsureResolutionSource = "session-cache" | "probe-cache" | "path";

const lastEnsureResolutionSource = new Map<string, EnsureResolutionSource>();

export function getLastEnsureResolutionSource(
	toolId: string,
): EnsureResolutionSource | undefined {
	return lastEnsureResolutionSource.get(toolId);
}

// Session-lifetime cache: once a tool path is resolved, skip the process-spawn check on subsequent calls.
const resolvedPathCache = new BoundedLruCache<string, string>(256);

/** Re-arm resolved tool paths when a new session may have changed PATH. */
export function resetResolvedPathCache(): void {
	resolvedPathCache.clear();
}

// --- Persistent probe cache ---

interface ProbeCacheEntry {
	path: string;
	mtimeMs: number;
	cachedAt: number;
	/**
	 * True when the `getToolPath` resolution that produced `path` saw a
	 * transient probe failure (a stall, a kill, an unspawnable candidate) on
	 * some tier before landing here — never a clean "not found" (#1569). Such
	 * a selection may be a degraded fallback masking a preferred tier that was
	 * merely unlucky at that moment, so it is not trusted for the full 24h
	 * TTL: it ages out after `PROBE_CACHE_TRANSIENT_COOLDOWN_MS` instead, the
	 * same window the live probe policy (`availability-policy.ts`) uses to
	 * decide a transient verdict is worth re-checking. Absent/`false` means
	 * every candidate along the way either succeeded or was cleanly missing.
	 */
	transient?: boolean;
}

type ProbeCache = Record<string, ProbeCacheEntry>;

const PROBE_CACHE_PATH = path.join(getGlobalPiLensDir(), "probe-cache.json");
const PROBE_CACHE_LOCK_STALE_MS = 180_000;
const PROBE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * How long a transient-tainted entry (see `ProbeCacheEntry.transient`) is
 * served before `getToolPath` is asked again, instead of the full 24h TTL
 * (#1569). Shares the shared probe policy's transient ceiling rather than
 * inventing a new number for the same "how long is a stall worth trusting"
 * question.
 */
const PROBE_CACHE_TRANSIENT_COOLDOWN_MS = TRANSIENT_MAX_COOLDOWN_MS;
const PROBE_CACHE_FLUSH_LOCK_WAIT_MS = 250;
const PROBE_CACHE_FLUSH_RETRY_DELAY_MS = 300;
const PROBE_CACHE_FLUSH_RETRY_MAX_DELAY_MS = 30_000;

let _probeCache: ProbeCache | null = null;
let _probeCacheDirty = false;
let _probeCacheFlushTimer: ReturnType<typeof setTimeout> | null = null;
let _probeCacheWriteInFlight: Promise<ProbeCacheFlushResult> | null = null;
let _probeCacheRetryAttempt = 0;
let _probeCacheChangeGeneration = 0;
// Read-modify-write deltas let a long-lived process merge with entries another
// process discovered after this process's initial read. `null` is a deliberate
// deletion (TTL/stale-path eviction), not an absent map value.
const _probeCacheChanges = new Map<string, ProbeCacheEntry | null>();
const _probeCacheChangeVersions = new Map<string, number>();

async function readProbeCache(): Promise<ProbeCache> {
	if (_probeCache !== null) return _probeCache;
	try {
		const raw = await fs.readFile(PROBE_CACHE_PATH, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("probe-cache root is not an object");
		}
		_probeCache = parsed as ProbeCache;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException | undefined)?.code;
		if (code !== "ENOENT") {
			logSessionStart(
				`auto-install probe-cache: read failed (${code ?? "invalid"}); treating cache as unavailable`,
			);
		}
		_probeCache = {};
	}
	return _probeCache;
}

function markProbeCacheChange(
	toolId: string,
	entry: ProbeCacheEntry | null,
): void {
	_probeCacheChanges.set(toolId, entry);
	_probeCacheChangeVersions.set(toolId, ++_probeCacheChangeGeneration);
	_probeCacheDirty = true;
	scheduleProbeFlush();
}

function scheduleProbeFlush(delayMs = PROBE_CACHE_FLUSH_RETRY_DELAY_MS): void {
	if (_probeCacheFlushTimer !== null) return;
	_probeCacheFlushTimer = setTimeout(() => {
		void flushProbeCache();
	}, delayMs);
	_probeCacheFlushTimer.unref?.();
}

function scheduleProbeFlushRetry(): void {
	const delay = Math.min(
		PROBE_CACHE_FLUSH_RETRY_MAX_DELAY_MS,
		PROBE_CACHE_FLUSH_RETRY_DELAY_MS *
			2 ** Math.min(_probeCacheRetryAttempt, 6),
	);
	_probeCacheRetryAttempt += 1;
	scheduleProbeFlush(delay);
}

export type ProbeCacheFlushResult =
	| "idle"
	| "written"
	| "written-with-pending"
	| "deferred"
	| "failed";

type ProbeCacheFlushSnapshot = {
	changes: Map<string, ProbeCacheEntry | null>;
	versions: Map<string, number>;
};

function snapshotProbeCacheChanges(): ProbeCacheFlushSnapshot {
	return {
		changes: new Map(_probeCacheChanges),
		versions: new Map(_probeCacheChangeVersions),
	};
}

/**
 * Deserialize the on-disk probe-cache for the LOCKED write-side merge
 * (`writeProbeCache`'s `commitDurableStoreAsync` call). Unlike `readProbeCache`
 * (the ordinary session-lookup path, which already degrades a parse/shape
 * failure to `{}`), this used to THROW on a torn/corrupt file — which does
 * not crash the caller (`writeProbeCache` wraps the whole commit in try/catch
 * and retries), but it also means the corrupt file on disk is never repaired:
 * every retry re-reads the same torn bytes, re-throws, and gives up again,
 * forever (#1609 layer b). Degrading here too, exactly like `readProbeCache`,
 * lets the next successful flush's `merge` step overwrite the torn file with
 * a valid one instead of looping on it indefinitely.
 */
function deserializeProbeCache(contents: string | undefined): ProbeCache {
	if (contents === undefined) return {};
	try {
		const parsed: unknown = JSON.parse(contents);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("probe-cache root is not an object");
		}
		return parsed as ProbeCache;
	} catch (err) {
		logSessionStart(
			`auto-install probe-cache: write-side read was corrupt (${(err as Error).message}); recovering as empty`,
		);
		return {};
	}
}

function applyProbeCacheChanges(
	disk: ProbeCache,
	changes: Map<string, ProbeCacheEntry | null>,
): void {
	for (const [toolId, entry] of changes) {
		if (entry === null) delete disk[toolId];
		else disk[toolId] = entry;
	}
}

/**
 * Install-lifetime ageing belongs to the authoritative merge, not only to the
 * lookup path: a sibling process may have left expired entries on disk since
 * this process loaded its in-memory snapshot. The async durable-store lock
 * supplies the probe cache's former quarantine/stale-owner recovery.
 */
function ageProbeCache(disk: ProbeCache): void {
	const now = Date.now();
	for (const [toolId, entry] of Object.entries(disk)) {
		const ttl = entry.transient
			? PROBE_CACHE_TRANSIENT_COOLDOWN_MS
			: PROBE_CACHE_TTL_MS;
		if (!Number.isFinite(entry.cachedAt) || entry.cachedAt < now - ttl) {
			delete disk[toolId];
		}
	}
}

function publishProbeCacheWrite(
	disk: ProbeCache,
	snapshotVersions: Map<string, number>,
): ProbeCacheFlushResult {
	// Publish the sibling-process merge plus any updates that arrived during
	// the write. Only an unchanged snapshot entry is retired.
	const pendingAfterWrite = new Map(_probeCacheChanges);
	_probeCache = disk;
	for (const [toolId, entry] of pendingAfterWrite) {
		if (entry === null) delete _probeCache[toolId];
		else _probeCache[toolId] = entry;
	}
	for (const [toolId, version] of snapshotVersions) {
		if (_probeCacheChangeVersions.get(toolId) === version) {
			_probeCacheChanges.delete(toolId);
			_probeCacheChangeVersions.delete(toolId);
		}
	}
	_probeCacheDirty = _probeCacheChanges.size > 0;
	_probeCacheRetryAttempt = 0;
	return _probeCacheDirty ? "written-with-pending" : "written";
}

async function writeProbeCache(): Promise<ProbeCacheFlushResult> {
	try {
		// Snapshot versions before the awaited disk read/write. A new update for
		// the same tool may arrive while the atomic write is in flight; its newer
		// version must remain pending for the next flush.
		const { changes, versions } = snapshotProbeCacheChanges();
		let result: ProbeCacheFlushResult = "written";
		const committed = await commitDurableStoreAsync({
			path: PROBE_CACHE_PATH,
			deserialize: deserializeProbeCache,
			merge: (disk) => {
				ageProbeCache(disk);
				applyProbeCacheChanges(disk, changes);
				return disk;
			},
			serialize: (disk) => JSON.stringify(disk, null, 2),
			waitMs: PROBE_CACHE_FLUSH_LOCK_WAIT_MS,
			retryMs: 25,
			staleMs: PROBE_CACHE_LOCK_STALE_MS,
			timeoutMessage: "Timed out waiting for probe-cache lock",
			onContention: "skip-log",
			logContention: () => {
				logSessionStart(
					"auto-install probe-cache: flush deferred because another process owns the lock",
				);
			},
			afterWriteLocked: (disk) => {
				result = publishProbeCacheWrite(disk, versions);
			},
		});
		if (committed === undefined) {
			scheduleProbeFlushRetry();
			return "deferred";
		}
		return result;
	} catch (err) {
		// Keep dirty state so a later timer/explicit flush can retry. The error
		// is logged without paths, source, or command text; an unavailable cache
		// must never look like a clean empty cache to operators.
		logSessionStart(
			`auto-install probe-cache: flush failed (${(err as NodeJS.ErrnoException | undefined)?.code ?? "write error"}); pending update retained`,
		);
		scheduleProbeFlushRetry();
		return "failed";
	}
}

/** Await pending probe-cache persistence before a one-shot process exits. */
export async function flushProbeCache(): Promise<ProbeCacheFlushResult> {
	if (_probeCacheFlushTimer !== null) {
		clearTimeout(_probeCacheFlushTimer);
		_probeCacheFlushTimer = null;
	}
	// #946 review F4: if the 300ms timer's write already started, the dirty
	// flag is false but the write may still be in flight — an immediate
	// process.exit would truncate it. Always await the in-flight write.
	if (_probeCacheWriteInFlight) {
		await _probeCacheWriteInFlight;
		if (!_probeCacheDirty) return "written";
	}
	if (!_probeCacheDirty || _probeCache === null) return "idle";

	const write = writeProbeCache();
	_probeCacheWriteInFlight = write;
	try {
		return await write;
	} finally {
		if (_probeCacheWriteInFlight === write) _probeCacheWriteInFlight = null;
	}
}

function isAstGrepVersionOutput(output: string): boolean {
	return /\bast[- ]grep\b/i.test(output);
}

async function verifyAstGrepProbePath(binPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(binPath, ["--version"], {
				stdio: ["ignore", "pipe", "pipe"],
				shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(binPath),
				timeout: 5000,
			});
		} catch {
			// SYNCHRONOUS spawn throw (Windows `spawn UNKNOWN`/EINVAL, the pidusage
			// bug class, #533) — best-effort probe, resolve rather than reject.
			resolve(false);
			return;
		}
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

	// A transient-tainted entry (#1569) is not trusted past the shorter
	// transient cooldown, even inside the 24h TTL — the selection it recorded
	// may be a degraded fallback that a since-recovered preferred tier should
	// now beat.
	const ttl = entry.transient
		? PROBE_CACHE_TRANSIENT_COOLDOWN_MS
		: PROBE_CACHE_TTL_MS;
	if (Date.now() - entry.cachedAt > ttl) {
		logSessionStart(
			`auto-install probe-cache ${toolId}: miss (${entry.transient ? "transient cooldown" : "ttl"} expired)`,
		);
		delete cache[toolId];
		markProbeCacheChange(toolId, null);
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
			markProbeCacheChange(toolId, null);
			return undefined;
		}
		if (toolId === "ast-grep" && !(await verifyAstGrepProbePath(entry.path))) {
			logSessionStart(
				`auto-install probe-cache ${toolId}: miss (not ast-grep: ${entry.path})`,
			);
			delete cache[toolId];
			markProbeCacheChange(toolId, null);
			return undefined;
		}
		return entry.path;
	} catch {
		logSessionStart(
			`auto-install probe-cache ${toolId}: miss (gone: ${entry.path})`,
		);
		delete cache[toolId];
		markProbeCacheChange(toolId, null);
		return undefined;
	}
}

// Exported for testing only.
export async function updateProbeCache(
	toolId: string,
	resolvedPath: string,
	transient = false,
): Promise<void> {
	try {
		const stat = await fs.stat(resolvedPath);
		const cache = await readProbeCache();
		const entry: ProbeCacheEntry = {
			path: resolvedPath,
			mtimeMs: stat.mtimeMs,
			cachedAt: Date.now(),
			...(transient && { transient: true }),
		};
		cache[toolId] = entry;
		markProbeCacheChange(toolId, entry);
	} catch {
		// best-effort
	}
}

// Exported for testing only.
export function resetProbeCacheStateForTesting(): void {
	_probeCache = null;
	_probeCacheDirty = false;
	_probeCacheChanges.clear();
	_probeCacheChangeVersions.clear();
	_probeCacheChangeGeneration = 0;
	_probeCacheRetryAttempt = 0;
	resetResolvedPathCache();
	ensureInFlight.clear();
	installFailureReasons.clear();
	installAttempts.clear();
	lastEnsureResolutionSource.clear();
	lastManagedInstallVersion.clear();
	lastResolveTransient.clear();
	resetPathWalkMemo();
	if (_probeCacheFlushTimer !== null) {
		clearTimeout(_probeCacheFlushTimer);
		_probeCacheFlushTimer = null;
	}
}

// --- Check Functions ---

const pathWalkMemo = new Map<string, boolean>();

function hashSync(value: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}

export function resetPathWalkMemo(): void {
	pathWalkMemo.clear();
}

/**
 * Check if a command is available in PATH by walking PATH entries and
 * verifying each candidate is a real file with non-zero size.
 * Catches broken symlinks (stat throws ENOENT or returns size 0) without
 * spawning a process — ~μs per candidate vs ~50ms for which/where.
 */
export async function isCommandAvailable(
	command: string,
	_args?: string[],
): Promise<boolean> {
	const isWindows = installerPlatform() === "win32";
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

/**
 * Can `command` even be spawned? Path-bearing commands stat the file directly;
 * bare names walk PATH. ~μs either way — callers use this to skip a `--version`
 * probe that is guaranteed to fail with a full spawn round-trip.
 */
export async function isSpawnableCommand(command: string): Promise<boolean> {
	if (/[\\/]/.test(command)) {
		try {
			const stat = statSync(command);
			return stat.isFile() && stat.size > 0;
		} catch {
			return false;
		}
	}
	const memoKey = `${command}:${hashSync(process.env.PATH || "")}`;
	if (pathWalkMemo.has(memoKey)) return pathWalkMemo.get(memoKey) ?? false;
	const isSpawnable = await isCommandAvailable(command);
	pathWalkMemo.set(memoKey, isSpawnable);
	return isSpawnable;
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
 * Parse the exact version pinned in a TOOLS `packageName` spec, e.g.
 * `"jscpd@3.5.10"` -> `"3.5.10"`. Scoped packages (`"@ast-grep/cli"`) have no
 * pin unless a version is appended after the package name
 * (`"@scope/pkg@1.2.3"`) — `lastIndexOf("@")` on a bare scope marker (index 0)
 * correctly reports "no pin" rather than mistaking the scope for a version.
 * Returns undefined when packageName has no explicit `@version` suffix.
 */
function parsePinnedVersion(packageName: string): string | undefined {
	const at = packageName.lastIndexOf("@");
	if (at <= 0) return undefined;
	return packageName.slice(at + 1) || undefined;
}

/** Extract the first semver-ish token (e.g. "3.5.10") from `--version` output. */
function extractVersionToken(output: string): string | undefined {
	return output.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/)?.[0];
}

/**
 * Version reported by the last successful `--version` probe of a pi-lens
 * managed local npm install, keyed by toolId. Populated only inside
 * getToolPath()'s managed-local-install checks below — i.e. only when that
 * code path already spawns verifyToolBinary anyway (cache hits in
 * ensureTool()'s fast paths never reach getToolPath, so this never adds a new
 * spawn). Consumed by ensureTool() to detect drift against the tool's current
 * `packageName` pin (#589) — deliberately scoped to installStrategy "npm"
 * with an explicit version pin; unpinned tools and non-npm strategies (github/
 * maven/archive) never populate or read this map.
 */
const lastManagedInstallVersion = new Map<string, string>();

/**
 * Verify a tool binary actually works by running --version
 * This catches broken symlinks, partial installs, and corrupted binaries.
 * `onVersionOutput`, when provided, receives the raw stdout on a successful
 * (exit 0) probe — used to piggyback version-pin drift detection onto this
 * already-happening spawn instead of adding a new one (#589).
 *
 * Exported so every managed-binary check runs THIS verification rather than a
 * bare `existsSync` of its own: an on-disk shim that cannot run must not
 * shadow a working PATH binary (#1657).
 */
export async function verifyToolBinary(
	binPath: string,
	onVersionOutput?: (output: string) => void,
	/**
	 * Called when a `false` verdict came from a probe that never got a fair
	 * run — a spawn timeout/signal or a spawn-boundary EAGAIN/EBUSY/sync throw
	 * — rather than the binary actually rejecting `--version` (#1569). An
	 * unspawnable prober is never a durable verdict: a caller that falls
	 * through to a lower-priority candidate on one of these must not let the
	 * fallback's selection be trusted as if the preferred candidate were
	 * genuinely broken.
	 */
	onTransient?: () => void,
	/**
	 * Spawn budget, ms. Install paths keep the generous default; a latency-
	 * sensitive caller on the dispatch hot path passes a shorter one and treats
	 * the expiry as transient rather than as a verdict (#1657).
	 */
	timeoutMs = 10000,
): Promise<boolean> {
	// #2015: safeSpawnAsync instead of raw spawn. Raw spawn's timeout
	// SIGTERMed only cmd.exe on Windows (.cmd shims run shell:true), orphaning
	// the grandchild node process - which kept scanning, held handles against
	// the cleanup rm, and turned one slow cold-start verify into an
	// install/verify/reinstall loop (23 SIGTERMs observed in one day).
	// lifetimeCoupled tree-kill prevents orphans; result.signal gives a typed
	// kill-reason for transient classification.
	const isWindows = installerPlatform() === "win32";
	const hasKnownWindowsExt = /\.(cmd|exe|ps1)$/i.test(binPath);

	// On Windows, resolve the best executable path:
	// - extensionless → prefer .cmd (cmd.exe-safe)
	// - .ps1 → prefer .cmd sibling to avoid PowerShell execution-policy hangs
	// - .cmd / .exe → use as-is
	let execPath = isWindows && !hasKnownWindowsExt ? `${binPath}.cmd` : binPath;

	if (isWindows && /\.ps1$/i.test(execPath)) {
		const cmdSibling = `${execPath.slice(0, -4)}.cmd`;
		if (require("node:fs").existsSync(cmdSibling)) {
			execPath = cmdSibling;
		}
	}
	const useShell = isWindows && /\.(cmd|bat)$/i.test(execPath);
	// safe-spawn routes .cmd/.bat through its cmd.exe wrapper internally
	// (shell:false always at the child boundary; the wrapper string is built
	// there), so no shell option exists or is needed here.
	void useShell;

	try {
		const result = await safeSpawnAsync(execPath, ["--version"], {
			timeout: timeoutMs,
		});
		const output = `${result.stdout}\n${result.stderr}`;
		if (result.status === 0 && !result.error) {
			debugLog(`Verified: ${binPath} (version: ${result.stdout.trim()})`);
			onVersionOutput?.(result.stdout);
			return true;
		}
		if (isLspTransportRequiredError(output)) {
			// Valid stdio LSP server that rejects `--version` (#208) — the
			// transport-required error proves the binary works.
			debugLog(`Verified (stdio LSP, transport-required): ${binPath}`);
			return true;
		}
		// A kill (timeout fired) or spawn-boundary failure is a stall, not a
		// verdict from the binary (#1569 transient semantics).
		if (result.signal !== undefined || result.spawnFailure) onTransient?.();
		logSessionStart(
			`auto-install verify: failed for ${binPath} (kind=${result.signal ? `killed-signal=${result.signal}` : result.error ? "spawn-error" : "exit-nonzero"}${result.status !== null ? `, exit=${result.status}` : ""})`,
		);
		return false;
	} catch (err) {
		// Spawn-boundary throw (Windows `spawn UNKNOWN`/EINVAL, the pidusage
		// bug class, #533) — best-effort verify, resolve rather than reject.
		// The prober itself never ran, so this says nothing about the binary.
		logSessionStart(
			`auto-install verify: spawn threw for ${binPath} (${err instanceof Error ? err.message : String(err)})`,
		);
		onTransient?.();
		return false;
	}
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
				let proc: ReturnType<typeof spawn>;
				try {
					proc = spawn(tool.checkCommand, ["--version"], {
						stdio: ["ignore", "pipe", "pipe"],
						shell: process.platform === "win32",
						timeout: 5000,
					});
				} catch {
					// SYNCHRONOUS spawn throw (Windows `spawn UNKNOWN`/EINVAL, the
					// pidusage bug class, #533) — best-effort, resolve empty version.
					resolve("");
					return;
				}
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
			installerPlatform() === "win32" ? `${localBase}.cmd` : localBase;
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
	const suffix = spec.suffixes[`${installerPlatform()}-${process.arch}`];
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
		const isWin = installerPlatform() === "win32";
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

/**
 * Whether the most recent {@link getToolPath} resolution for a tool saw a
 * transient probe failure on some candidate before landing on its answer
 * (#1569). A side channel, in the same shape as `lastManagedInstallVersion`
 * above: `getToolPath` keeps its `string | undefined` return so its many
 * callers are untouched, and `ensureToolResolved` reads this immediately
 * after awaiting it to decide how long the persisted probe-cache entry may
 * be trusted for.
 */
const lastResolveTransient = new Map<string, boolean>();

/**
 * The resolution identity the most recent install of each tool used — a GitHub
 * release tag, a pinned archive URL, a Maven GAV (#1747).
 *
 * A side channel in the same shape as `lastManagedInstallVersion`: the install
 * functions keep their `string | undefined` return, and `finishInstallAttempt`
 * reads this to stamp the refresh state at install time. Without that stamp a
 * freshly installed tool would look "never refreshed" and pay a redundant
 * re-resolution the first time the cadence came round.
 */
const lastInstallResolutionId = new Map<string, string>();

/**
 * True when the tool path `getToolPath` most recently returned for `toolId`
 * was selected after a candidate tier failed transiently — a stalled or
 * unspawnable probe, never a clean "not found". Such a selection may be a
 * degraded fallback masking a preferred tier that is actually fine, so a
 * caller persisting it must not trust it for the full 24h TTL (#1569).
 */
export function wasLastResolveTransient(toolId: string): boolean {
	return lastResolveTransient.get(toolId) ?? false;
}

export async function getToolPath(toolId: string): Promise<string | undefined> {
	let sawTransient = false;
	const markTransient = (): void => {
		sawTransient = true;
	};
	const result = await getToolPathResolved(toolId, markTransient);
	lastResolveTransient.set(toolId, sawTransient);
	return result;
}

async function getToolPathResolved(
	toolId: string,
	onTransient: () => void,
): Promise<string | undefined> {
	const tool = TOOLS.find((t) => t.id === toolId);
	if (!tool) return undefined;

	// Tree-bundle archives (no launcher) are "installed" ONLY when extracted — the
	// extract dir is authoritative. No PATH/global/npm fallback: the runtime that
	// drives the bundle (e.g. pwsh) may be on PATH while the bundle itself is
	// absent, which must NOT read as installed (else the bundle never downloads).
	if (tool.installStrategy === "archive" && !tool.archive?.launcher) {
		return getArchiveTreeBundlePath(tool);
	}

	// Version-pin drift detection (#589) is scoped to npm-strategy tools with an
	// explicit `@version` pin — everything else (unpinned npm entries, pip/gem,
	// github/maven/archive) has no drift signal to piggyback on here. Clear any
	// stale entry up front so a miss on the checks below never leaves a prior
	// call's version lingering for ensureTool() to misread.
	const pinnedVersion =
		tool.installStrategy === "npm" && tool.packageName
			? parsePinnedVersion(tool.packageName)
			: undefined;
	if (pinnedVersion) lastManagedInstallVersion.delete(toolId);
	const recordVersion = pinnedVersion
		? (output: string): void => {
				const seen = extractVersionToken(output);
				if (seen) lastManagedInstallVersion.set(toolId, seen);
			}
		: undefined;

	// Fast path: check local npm install first (where auto-install places tools).
	// This avoids the ~2-5s overhead of spawning npm global probes and PATH
	// searches for tools we already manage locally.
	const localBase = path.join(
		TOOLS_DIR,
		"node_modules",
		".bin",
		tool.binaryName || tool.id,
	);
	if (installerPlatform() === "win32") {
		// Prefer .cmd over extensionless — Node.js can't execute POSIX shell scripts on Windows
		const cmdPath = `${localBase}.cmd`;
		try {
			await fs.access(cmdPath);
			if (await verifyToolBinary(cmdPath, recordVersion, onTransient)) {
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
			if (await verifyToolBinary(exePath, recordVersion, onTransient)) {
				return exePath;
			}
			logSessionStart(
				`auto-install verify: ${exePath} exists but is broken, will reinstall`,
			);
		} catch {
			// fall through to extensionless
		}
	}
	if (installerPlatform() !== "win32") {
		try {
			await fs.access(localBase);
			if (await verifyToolBinary(localBase, recordVersion, onTransient)) {
				return localBase;
			}
			logSessionStart(
				`auto-install verify: ${localBase} exists but is broken, will reinstall`,
			);
		} catch {
			// fall through to global checks
		}
	}

	// npm/pnpm/bun: prefer the native per-platform binary directly. The main
	// package's launcher often can't find it under a symlink store / after a
	// skipped postinstall, but the binary IS installed — resolve + verify it
	// before falling back to PATH or a (re)install.
	if (tool.platformPackage) {
		const platformBin = resolvePlatformPackageBinary(tool);
		if (
			platformBin &&
			(await verifyToolBinary(platformBin, undefined, onTransient))
		) {
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
		const npmPath = await findNpmGlobalToolPath(
			tool.binaryName || tool.id,
			onTransient,
		);
		if (npmPath) {
			return npmPath;
		}
	}

	// For pip tools, also probe user-level script locations
	if (tool.installStrategy === "pip") {
		const pipPath = await findPipUserToolPath(
			tool.binaryName || tool.id,
			onTransient,
		);
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
	onTransient?: () => void,
): Promise<string | undefined> {
	const isWindows = process.platform === "win32";
	const binDirs = await getNpmGlobalBinCandidates(onTransient);

	for (const dir of binDirs) {
		const candidates = isWindows
			? [
					path.join(dir, `${binaryName}.cmd`),
					path.join(dir, `${binaryName}.exe`),
				]
			: [path.join(dir, binaryName)];

		for (const candidate of candidates) {
			try {
				await fs.access(candidate);
				if (await verifyToolBinary(candidate, undefined, onTransient)) {
					return candidate;
				}
			} catch {
				// continue
			}
		}
	}

	return undefined;
}

async function getNpmGlobalBinCandidates(
	onTransient?: () => void,
): Promise<string[]> {
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
	// may have been installed globally via any of them. `onTransient` surfaces
	// a manager whose availability probe stalled rather than genuinely failed,
	// so its bin dir may be missing from `dirs` for a reason other than "not
	// installed" (#1585).
	for (const dir of await allAvailableGlobalBinDirs(onTransient)) {
		add(dir);
	}

	return dirs;
}

async function findPipUserToolPath(
	binaryName: string,
	onTransient?: () => void,
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
					if (await verifyToolBinary(candidate, undefined, onTransient)) {
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
			let proc: ReturnType<typeof spawn>;
			try {
				proc = spawn(spawnCmd, isWin ? [] : probe.args, {
					stdio: ["ignore", "pipe", "pipe"],
					shell: isWin,
				});
			} catch {
				// SYNCHRONOUS spawn throw (Windows `spawn UNKNOWN`/EINVAL, the
				// pidusage bug class, #533) — best-effort probe, resolve empty.
				resolve("");
				return;
			}

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

interface HttpGetResponse {
	statusCode: number;
	body: Buffer;
	/** Response `ETag`, when the server sent one. */
	etag?: string;
}

/**
 * Fetch a URL, following up to `maxRedirects` redirects, and surface the status
 * line and `ETag` alongside the body.
 *
 * `304 Not Modified` resolves rather than rejects: the periodic GitHub
 * re-resolution (#1747) sends `If-None-Match` and a 304 is its cheapest and
 * most desirable answer — the release has not moved, no asset is downloaded,
 * and GitHub does not charge the request against the caller's rate limit. Every
 * other non-2xx status is still an error.
 *
 * Any caller-supplied headers are dropped when a redirect crosses to a
 * different host, so an Authorization header can never leak to a redirect
 * target (e.g. a release CDN).
 */
function httpsGetWithMeta(
	url: string,
	maxRedirects = 5,
	headers: Record<string, string> = {},
): Promise<HttpGetResponse> {
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
						return resolve(
							httpsGetWithMeta(location, maxRedirects - 1, nextHeaders),
						);
					}
					const etag =
						typeof res.headers.etag === "string" ? res.headers.etag : undefined;
					if (res.statusCode === 304) {
						res.resume();
						return resolve({ statusCode: 304, body: Buffer.alloc(0), etag });
					}
					if (res.statusCode !== 200) {
						res.resume();
						return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
					}
					const chunks: Buffer[] = [];
					res.on("data", (chunk: Buffer) => chunks.push(chunk));
					res.on("end", () =>
						resolve({ statusCode: 200, body: Buffer.concat(chunks), etag }),
					);
					res.on("error", reject);
				},
			)
			.on("error", reject);
	});
}

/**
 * Fetch a URL and return the raw Buffer of the response body. Rejects on any
 * non-200 status (a 304 is impossible here — no caller of this form sends a
 * validator header).
 */
async function httpsGet(
	url: string,
	maxRedirects = 5,
	headers: Record<string, string> = {},
): Promise<Buffer> {
	const response = await httpsGetWithMeta(url, maxRedirects, headers);
	if (response.statusCode !== 200) {
		throw new Error(`HTTP ${response.statusCode} for ${url}`);
	}
	return response.body;
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
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(command, args, {
				cwd,
				stdio: "ignore",
				shell: process.platform === "win32",
			});
		} catch {
			// SYNCHRONOUS spawn throw (Windows `spawn UNKNOWN`/EINVAL, the pidusage
			// bug class, #533) — resolve false rather than reject/crash.
			resolve(false);
			return;
		}
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
	/**
	 * Release metadata the caller already fetched. The periodic refresh (#1747)
	 * resolves `releases/latest` to decide whether the tag moved at all, and
	 * hands the SAME response here rather than paying a second GitHub API call
	 * for an answer it already has.
	 */
	prefetchedRelease?: GitHubReleaseMetadata,
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

	// Fetch latest release metadata from GitHub API, unless the caller already did.
	let releaseJson: GitHubReleaseMetadata;
	if (prefetchedRelease) {
		releaseJson = prefetchedRelease;
		logSessionStart(
			`github-install ${tool.id}: using caller-supplied release metadata for ${spec.repo} (${prefetchedRelease.tag_name ?? "untagged"})`,
		);
	} else {
		logSessionStart(
			`github-install ${tool.id}: fetching release metadata from ${spec.repo}`,
		);
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
	}

	if (releaseJson.tag_name) {
		lastInstallResolutionId.set(tool.id, releaseJson.tag_name);
	}

	// #1759 review F3: a 200 whose body has no `assets` array (an unexpected
	// GitHub API shape, not a real release) used to reach `pickReleaseAsset`
	// and throw inside `.find`, uncaught by anything in this function. For the
	// REFRESH caller that throw skipped every stamp write, so the tool never
	// got a failure stamp and re-took the one-per-session slot forever. Failing
	// here, like a missing asset match, keeps this an ordinary "no install"
	// outcome both callers already handle.
	if (!Array.isArray(releaseJson.assets)) {
		logSessionStart(
			`github-install ${tool.id}: release metadata has no assets array`,
		);
		return undefined;
	}

	const asset =
		pickReleaseAsset(releaseJson.assets, assetSubstring) ??
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
			await writeFileAtomicAsync(destPath, decompressed, {
				bestEffort: false,
				mode: 0o750,
			});
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
			await writeFileAtomicAsync(destPath, assetBuffer, {
				bestEffort: false,
				mode: 0o750,
			});
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
			await writeFileAtomicAsync(
				path.join(GITHUB_BIN_DIR, extraName),
				extraBuffer,
				{ bestEffort: false, mode: 0o750 },
			);
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

/**
 * Does this npm package need its lifecycle scripts to install correctly?
 *
 * Exported so the periodic refresh (#1730) re-runs each package under the SAME
 * script policy its original install used. A refresh that drops
 * `--ignore-scripts` for biome or `@ast-grep/cli` leaves the JS launcher
 * updated and its native binary on the old version.
 */
export function npmToolNeedsPostinstall(packageName: string): boolean {
	return NEEDS_POSTINSTALL.has(packageName);
}

/**
 * The managed npm tools whose installed version is free to move — every
 * registry entry with `installStrategy: "npm"` and an UNPINNED `packageName`.
 *
 * Derived from `TOOLS` on every call rather than listed by hand: a hand-kept
 * copy of a registry is the single-source-of-truth defect this repo keeps
 * finding, and a new npm tool added to `TOOLS` must be refreshed without anyone
 * remembering a second list.
 *
 * Packages carrying an explicit `name@1.2.3` pin are excluded. The pin IS the
 * intended version, and #589's drift check already reinstalls a managed copy
 * that wanders off it.
 */
export function getRefreshableManagedNpmTools(): Array<{
	toolId: string;
	packageName: string;
	binaryName: string;
}> {
	return getRefreshableManagedTools()
		.filter((candidate) => candidate.strategy === "npm")
		.map((candidate) => ({
			toolId: candidate.toolId,
			// The npm branch of getRefreshableManagedTools only admits entries that
			// have both, so these are total.
			packageName: candidate.packageName as string,
			binaryName: candidate.binaryName as string,
		}));
}

// --- Periodic refresh seam for the non-npm strategies (#1747) ---

export type ManagedToolStrategy = ToolDefinition["installStrategy"];

export interface RefreshableManagedTool {
	toolId: string;
	strategy: ManagedToolStrategy;
	packageName?: string;
	/** npm only — what `installNpmTool` verifies after an install or update. */
	binaryName?: string;
	/**
	 * The identity of what the tool's coordinate resolves to TODAY, when that
	 * identity is knowable without a network call. `archive` and `maven` entries
	 * carry a version pinned in this registry, so their identity is the resolved
	 * URL or the Maven GAV; a change to it means the installed artifact is stale
	 * against the pin. `github` resolves `releases/latest` at refresh time and
	 * `npm`/`pip`/`gem` resolve inside their package manager, so all three leave
	 * this undefined.
	 */
	pinnedCoordinate?: string;
}

/** The Maven GAV a `maven` entry pins, as a stable identity string. */
function mavenCoordinate(spec: MavenJarSpec): string {
	return [
		spec.repoBaseUrl ?? MAVEN_CENTRAL_BASE,
		spec.groupId,
		spec.artifactId,
		spec.version,
		spec.classifier ?? "",
	].join(":");
}

/**
 * Every managed tool whose installed copy is allowed to move, across ALL six
 * install strategies — the single source of truth the periodic refresh selects
 * from (#1730, #1747).
 *
 * Derived from `TOOLS` on every call rather than listed by hand. A hand-kept
 * copy of a registry is the defect shape this repo keeps re-finding, and a tool
 * added to `TOOLS` must become refreshable without anyone remembering a second
 * list.
 *
 * Excluded: npm packages carrying an explicit `name@1.2.3` pin (the pin IS the
 * intended version, and #589's drift check already repairs those), and any
 * entry with no coordinate to re-resolve at all.
 */
export function getRefreshableManagedTools(): RefreshableManagedTool[] {
	const refreshable: RefreshableManagedTool[] = [];
	for (const tool of TOOLS) {
		switch (tool.installStrategy) {
			case "npm": {
				if (!tool.packageName) continue;
				if (parsePinnedVersion(tool.packageName) !== undefined) continue;
				// `binaryName` is what `installNpmTool` verifies after an install, and
				// the refresh has to verify the SAME path after an update. An npm
				// entry without one cannot be verified, so it is not refreshed either.
				if (!tool.binaryName) continue;
				refreshable.push({
					toolId: tool.id,
					strategy: "npm",
					packageName: tool.packageName,
					binaryName: tool.binaryName,
				});
				break;
			}
			case "pip":
			case "gem": {
				if (!tool.packageName) continue;
				refreshable.push({
					toolId: tool.id,
					strategy: tool.installStrategy,
					packageName: tool.packageName,
				});
				break;
			}
			case "github": {
				if (!tool.github) continue;
				refreshable.push({ toolId: tool.id, strategy: "github" });
				break;
			}
			case "maven": {
				if (!tool.maven) continue;
				refreshable.push({
					toolId: tool.id,
					strategy: "maven",
					pinnedCoordinate: mavenCoordinate(tool.maven),
				});
				break;
			}
			case "archive": {
				if (!tool.archive) continue;
				const url = resolveArchiveUrl(tool.archive);
				// No archive for this platform/arch: nothing is installed and nothing
				// can be refreshed.
				if (!url) continue;
				refreshable.push({
					toolId: tool.id,
					strategy: "archive",
					pinnedCoordinate: url,
				});
				break;
			}
		}
	}
	return refreshable;
}

/**
 * Is this tool present in a location pi-lens itself installs to?
 *
 * Deliberately filesystem-only — no spawn, no network. The refresh runs this
 * over candidates on a background timer, and a presence check that spawned a
 * probe per tool would cost more than the refresh it gates.
 *
 * A tool pi-lens has never installed is never refreshed: `pip install -U` or a
 * release download on an absent tool would turn a refresh into an unrequested
 * install.
 */
export async function isManagedToolPresent(toolId: string): Promise<boolean> {
	const tool = TOOLS.find((t) => t.id === toolId);
	if (!tool) return false;
	switch (tool.installStrategy) {
		case "npm": {
			if (!tool.packageName) return false;
			try {
				await fs.access(
					path.join(
						TOOLS_DIR,
						"node_modules",
						tool.packageName,
						"package.json",
					),
				);
				return true;
			} catch {
				return false;
			}
		}
		case "github":
		case "maven":
			return (
				(await findGitHubToolPath(tool.binaryName ?? tool.id)) !== undefined
			);
		case "archive":
			// A launcher archive leaves a shim in the managed bin; a TREE BUNDLE
			// leaves only its extract dir, confirmed via the tree marker.
			return (
				(await findGitHubToolPath(tool.binaryName ?? tool.id)) !== undefined ||
				(await getArchiveTreeBundlePath(tool)) !== undefined
			);
		case "pip":
		case "gem": {
			// pip/gem installs are not namespaced to pi-lens: they land in the
			// user's site/gem dirs, so there is no pi-lens-owned directory to look
			// in. The persisted probe cache is the record of where this tool last
			// resolved, and it is written from the same discovery pass the install
			// path uses. An entry whose file is gone is not presence.
			const cached = (await readProbeCache())[toolId];
			return cached?.path !== undefined && existsSync(cached.path);
		}
		default:
			return false;
	}
}

/**
 * Version this tool reports today, read by running its own `--version` probe.
 *
 * Only used for `pip` and `gem`, the two strategies with no readable
 * coordinate: their package managers install into user-owned directories with
 * no manifest pi-lens can read, so the binary itself is the only source. Costs
 * one spawn, bounded by the same one-tool-per-session budget as the refresh.
 */
async function probeManagedToolVersion(
	tool: ToolDefinition,
): Promise<string | undefined> {
	const cached = (await readProbeCache())[tool.id];
	if (!cached?.path || !existsSync(cached.path)) return undefined;
	try {
		const result = await safeSpawnAsync(cached.path, tool.checkArgs, {
			timeout: 10_000,
			ignoreAmbientSignal: true,
			resourceLabel: `tool-refresh-version:${tool.id}`,
		});
		if (result.status !== 0) return undefined;
		return extractVersionToken(`${result.stdout}\n${result.stderr}`);
	} catch {
		return undefined;
	}
}

/** What the caller already knows about this tool from its persisted stamp. */
export interface ManagedToolRefreshKnownState {
	/** Last recorded resolution identity (release tag, or pinned coordinate). */
	resolutionId?: string;
	/** Last recorded `ETag` for the GitHub release query. */
	etag?: string;
	/** Last recorded installed version. */
	version?: string;
}

export interface ManagedToolRefreshAttempt {
	ok: boolean;
	/** True when the re-resolution proved nothing moved, so nothing was downloaded. */
	unchanged: boolean;
	/** Resolution identity to persist for the next comparison. */
	resolutionId?: string;
	/** `ETag` to persist and replay as `If-None-Match` next time. */
	etag?: string;
	/**
	 * Version now installed, when this strategy can read one. Per-strategy
	 * meaning documented once, on `ManagedToolRefreshEntry.version` in
	 * `managed-tool-refresh.ts` (#1759 review F8) — this field feeds that one
	 * directly.
	 */
	version?: string;
	/** Failure detail for the ledger, when `ok` is false. */
	reason?: string;
	/**
	 * Refused before any strategy ran — the install kill-switch, the
	 * project-trust gate, or a held install lock (#1759 review F2). Distinct
	 * from a real failure: the caller neither degrades nor stamps a refusal,
	 * so the retry cooldown is not spent on a block that has nothing to do
	 * with the tool itself.
	 */
	declined?: boolean;
}

export interface ManagedInstallGate {
	ok: boolean;
	/** Present only when `ok` is true; the caller must release it when done. */
	release?: () => Promise<void>;
	/** Present only when `ok` is false — always a refusal, never a failure. */
	reason?: string;
}

/**
 * The three checks every install-triggering path must clear before touching
 * `TOOLS_DIR`: the `PI_LENS_DISABLE_TOOL_INSTALL` kill-switch, the
 * `assertInstallAllowed` project-trust gate (the #1334 S5 boundary), and the
 * shared install lock — acquired here, released by the caller when its
 * strategy work finishes.
 *
 * Shared by `refreshManagedTool` below (the five non-npm strategies) and
 * `refreshNpmOne` in `managed-tool-refresh.ts` (#1759 review R2), so a
 * refusal means the same thing everywhere — a declined, unstamped skip, not
 * a degradation — regardless of which of the six strategies asked. Before
 * this was pulled out as its own function, npm's refresh spawned `npm
 * update` directly with none of these three checks: the kill switch, the
 * trust gate and the lock governed five strategies and silently exempted
 * the sixth.
 */
export async function acquireManagedInstallGate(
	context: string,
): Promise<ManagedInstallGate> {
	if (process.env.PI_LENS_DISABLE_TOOL_INSTALL === "1") {
		return {
			ok: false,
			reason: "installation disabled by PI_LENS_DISABLE_TOOL_INSTALL=1",
		};
	}
	if (!assertInstallAllowed(context)) {
		return {
			ok: false,
			reason: `project trust: ${projectTrustDenialReason()}`,
		};
	}
	// Held for the whole strategy call, not just the final write — a refresh
	// can race a concurrent `ensureTool` install of the SAME tool into the SAME
	// managed destination, and both write to `TOOLS_DIR` unlocked otherwise.
	const lock = await acquireInstallLock();
	if (!lock.release) {
		return { ok: false, reason: lock.reason ?? "install lock held" };
	}
	return { ok: true, release: lock.release };
}

/**
 * Re-resolve one non-npm managed tool and, only if its coordinate actually
 * moved, reinstall it (#1747).
 *
 * Never throws and never removes the installed copy: on any failure the
 * currently installed version keeps serving and the caller records a
 * degradation. npm is NOT handled here — `managed-tool-refresh.ts` owns that
 * path because it needs the package-manager resolver, and gates itself
 * through `acquireManagedInstallGate` directly.
 *
 * #1759 review F2: this used to call the strategy functions directly, which
 * bypassed every install guard `installTool`/`ensureTool` honor —
 * `PI_LENS_DISABLE_TOOL_INSTALL`, the `assertInstallAllowed` project-trust
 * gate (the #1334 S5 boundary), and `acquireInstallLock`. A refresh IS an
 * install trigger, just an unattended one, so it now passes through the same
 * three gates before any strategy runs. A refusal is `declined: true`, not a
 * degradation — see `ManagedToolRefreshAttempt.declined`.
 */
export async function refreshManagedTool(
	toolId: string,
	known: ManagedToolRefreshKnownState = {},
): Promise<ManagedToolRefreshAttempt> {
	const tool = TOOLS.find((t) => t.id === toolId);
	if (!tool) {
		return { ok: false, unchanged: true, reason: "unknown tool id" };
	}
	if (
		tool.installStrategy !== "github" &&
		tool.installStrategy !== "pip" &&
		tool.installStrategy !== "gem" &&
		tool.installStrategy !== "maven" &&
		tool.installStrategy !== "archive"
	) {
		return {
			ok: false,
			unchanged: true,
			reason: `strategy ${tool.installStrategy} is not refreshable here`,
		};
	}
	// Captured into a local so the narrowing above survives the `await` below —
	// TS drops property narrowing (`tool.installStrategy`) across an `await`,
	// which would otherwise make the switch look non-exhaustive.
	const strategy = tool.installStrategy;

	const gate = await acquireManagedInstallGate(
		`managed tool refresh: ${toolId}`,
	);
	if (!gate.ok) {
		return { ok: false, unchanged: true, declined: true, reason: gate.reason };
	}
	try {
		switch (strategy) {
			case "github":
				return await refreshGitHubManagedTool(tool, known);
			case "pip":
			case "gem":
				return await refreshPackageManagerManagedTool(tool);
			case "maven":
			case "archive":
				return await refreshPinnedManagedTool(tool, known);
			default:
				return {
					ok: false,
					unchanged: true,
					reason: `strategy ${strategy} is not refreshable here`,
				};
		}
	} finally {
		await gate.release?.();
	}
}

/**
 * `github`: ask `releases/latest` whether the tag moved, and download only if
 * it did.
 *
 * Three things keep 27 GitHub-release tools off GitHub's rate limit. The
 * per-tool weekly stamp means one query per tool per week; the one-refresh-per-
 * session budget means at most one query per session; and the stored `ETag`
 * replayed as `If-None-Match` makes the common answer a 304, which GitHub does
 * not charge against the limit at all. A 304, or a tag equal to the recorded
 * one, downloads nothing.
 */
async function refreshGitHubManagedTool(
	tool: ToolDefinition,
	known: ManagedToolRefreshKnownState,
): Promise<ManagedToolRefreshAttempt> {
	const spec = tool.github;
	if (!spec) return { ok: false, unchanged: true, reason: "no github spec" };

	let response: HttpGetResponse;
	try {
		response = await httpsGetWithMeta(
			`https://api.github.com/repos/${spec.repo}/releases/latest`,
			5,
			{
				...githubApiAuthHeaders(),
				...(known.etag ? { "If-None-Match": known.etag } : {}),
			},
		);
	} catch (err) {
		return {
			ok: false,
			unchanged: true,
			reason: `release query failed: ${(err as Error).message}`,
		};
	}

	if (response.statusCode === 304) {
		return {
			ok: true,
			unchanged: true,
			resolutionId: known.resolutionId,
			etag: known.etag,
			version: known.version,
		};
	}

	let release: GitHubReleaseMetadata;
	try {
		const parsed: unknown = JSON.parse(response.body.toString("utf8"));
		// #1759 review F3: `JSON.parse` succeeds on `null`, an array, or a bare
		// string just as happily as on an object — any of those would throw
		// reading `.tag_name` below, uncaught, and skip every stamp write this
		// candidate ever gets. Reject the shape here instead of downstream.
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("release metadata is not an object");
		}
		release = parsed as GitHubReleaseMetadata;
	} catch (err) {
		return {
			ok: false,
			unchanged: true,
			reason: `release metadata unparseable: ${(err as Error).message}`,
		};
	}
	const tag = release.tag_name;
	if (!tag) {
		return { ok: false, unchanged: true, reason: "release has no tag_name" };
	}
	if (known.resolutionId === tag) {
		return {
			ok: true,
			unchanged: true,
			resolutionId: tag,
			etag: response.etag ?? known.etag,
			version: known.version ?? tag,
		};
	}

	const installed = await installGitHubTool(tool, release);
	if (!installed) {
		return {
			ok: false,
			unchanged: true,
			// Keep the ETag off the failure stamp: replaying it would make the next
			// attempt a 304 and skip the download this one never completed.
			resolutionId: known.resolutionId,
			version: known.version,
			reason: `install from release ${tag} failed`,
		};
	}
	const verified = await verifyRefreshedArtifact(tool, installed);
	if (!verified) {
		return {
			ok: false,
			unchanged: false,
			resolutionId: known.resolutionId,
			version: known.version,
			reason: `release ${tag} installed but its binary does not run`,
		};
	}
	return {
		ok: true,
		unchanged: false,
		resolutionId: tag,
		etag: response.etag,
		version: tag,
	};
}

/**
 * Confirm a just-refreshed artifact still runs, and re-stamp the probe cache
 * with its new mtime.
 *
 * A refresh REPLACES a working binary in place. Without this check a release
 * that ships a broken or wrong-architecture asset would be written over a
 * healthy copy and surface later as a dispatch failure with no obvious cause.
 * The verdict goes back to the caller, which degrades and marks the stamp
 * failed so the shorter retry cooldown applies.
 *
 * An archive TREE BUNDLE has no single binary to run; `installArchiveTool`
 * already confirms its tree marker, so the install's own success is the check.
 */
async function verifyRefreshedArtifact(
	tool: ToolDefinition,
	installedPath: string,
): Promise<boolean> {
	if (tool.installStrategy === "archive" && !tool.archive?.launcher) {
		// A tree bundle has no single binary to run — `installArchiveTool` already
		// confirmed its tree marker — but it still needs its NEW mtime recorded
		// (#1759 review F7), or the persisted probe entry keeps the pre-refresh
		// mtime and forces a full re-resolution on the next dispatch anyway.
		await updateProbeCache(tool.id, installedPath);
		return true;
	}
	if (!(await verifyToolBinary(installedPath))) {
		logSessionStart(
			`managed-tool-refresh ${tool.id}: refreshed artifact at ${installedPath} failed its --version check`,
		);
		return false;
	}
	// Record the NEW mtime rather than leaving the persisted entry to miss its
	// mtime check and force a full re-resolution on the next dispatch.
	await updateProbeCache(tool.id, installedPath);
	return true;
}

/**
 * `pip` and `gem`: re-run pi-lens's own install command in upgrade form.
 *
 * There is no coordinate to compare first — the registry pins no version and
 * the package managers install into user-owned directories with no manifest
 * pi-lens can read — so the tool's own `--version` output before and after is
 * what says whether anything moved.
 */
async function refreshPackageManagerManagedTool(
	tool: ToolDefinition,
): Promise<ManagedToolRefreshAttempt> {
	if (!tool.packageName) {
		return { ok: false, unchanged: true, reason: "no package name" };
	}
	const previous = await probeManagedToolVersion(tool);
	const installed =
		tool.installStrategy === "pip"
			? // `-U` is the whole fix: without it pip treats the installed copy as
				// satisfying the requirement and the day-one version never moves.
				await installPipTool(tool.packageName, { upgrade: true })
			: // `gem install` always fetches the newest version that satisfies the
				// requirement, so the install command IS the upgrade command.
				await installGemTool(tool.packageName);
	if (!installed) {
		return {
			ok: false,
			unchanged: true,
			version: previous,
			reason: `${tool.installStrategy} upgrade failed`,
		};
	}
	const current = await probeManagedToolVersion(tool);
	if (previous !== undefined && current === undefined) {
		// The tool answered `--version` before the upgrade and does not now: the
		// upgrade replaced a working copy with a broken one. Say so rather than
		// stamping success on a tool that no longer runs.
		return {
			ok: false,
			unchanged: false,
			version: previous,
			reason: `${tool.installStrategy} upgrade left the binary unable to report a version`,
		};
	}
	return {
		ok: true,
		// An unreadable version on both sides cannot prove a move, so it reads as
		// unchanged rather than inventing one.
		unchanged:
			previous === undefined || current === undefined || previous === current,
		version: current ?? previous,
	};
}

/**
 * `maven` and `archive`: both pin an explicit version in THIS registry, so
 * their coordinate cannot move upstream — it moves when pi-lens bumps it.
 *
 * The freeze for these two is therefore the mirror image of the npm one: the
 * installer only installs when the tool is ABSENT, so a repo that bumps
 * spotbugs from 4.10.2 to 4.11.0 leaves every existing machine on 4.10.2
 * forever. Comparing the recorded coordinate against the registry's current one
 * catches exactly that, and costs no network when they match.
 *
 * A tool with no recorded coordinate is reinstalled once. pi-lens cannot read
 * which pin the installed artifact came from — an archive bundle carries no
 * manifest it writes — so the only way to make the installed copy provably
 * match the declared pin is to install it. That happens at most once per tool,
 * ever, and the stamp it writes suppresses it from then on.
 */
async function refreshPinnedManagedTool(
	tool: ToolDefinition,
	known: ManagedToolRefreshKnownState,
): Promise<ManagedToolRefreshAttempt> {
	const coordinate =
		tool.installStrategy === "maven"
			? tool.maven && mavenCoordinate(tool.maven)
			: tool.archive && resolveArchiveUrl(tool.archive);
	if (!coordinate) {
		return {
			ok: false,
			unchanged: true,
			reason: "no coordinate for this platform",
		};
	}
	if (known.resolutionId === coordinate) {
		return {
			ok: true,
			unchanged: true,
			resolutionId: coordinate,
			version: known.version,
		};
	}
	const installed =
		tool.installStrategy === "maven"
			? await installMavenTool(tool)
			: await installArchiveTool(tool);
	if (!installed) {
		return {
			ok: false,
			unchanged: true,
			resolutionId: known.resolutionId,
			version: known.version,
			reason: `reinstall from ${coordinate} failed`,
		};
	}
	if (!(await verifyRefreshedArtifact(tool, installed))) {
		return {
			ok: false,
			unchanged: false,
			resolutionId: known.resolutionId,
			version: known.version,
			reason: `reinstall from ${coordinate} produced an artifact that does not run`,
		};
	}
	return {
		ok: true,
		// A first-ever stamp is an adoption, not a version move: the coordinate did
		// not change, pi-lens simply had no record of it. Reporting it as a move
		// would put a false "x → y" row in the log.
		unchanged: known.resolutionId === undefined,
		resolutionId: coordinate,
		version: coordinate,
	};
}

/**
 * The managed `node_modules/.bin` path for a tool binary, spelled the way
 * `installNpmTool` spells it (npm writes a `.cmd` shim on Windows, and that
 * shim — not its extensionless POSIX sibling — is the executable).
 *
 * Exported so the periodic refresh (#1730) verifies the same path the install
 * verified, instead of rebuilding the convention next to it.
 */
export function resolveManagedNpmBinPath(binaryName: string): string {
	const binBase = path.join(TOOLS_DIR, "node_modules", ".bin", binaryName);
	return installerPlatform() === "win32" ? `${binBase}.cmd` : binBase;
}

/**
 * Drop every cached claim about where a tool resolves: the in-memory
 * resolved-path cache and the 24h on-disk probe cache.
 *
 * The probe cache keys on the binary's path and mtime, and a package-manager
 * update rewrites the package while frequently leaving the `.bin` shim's mtime
 * alone. Without this, a refresh that changed the version — or left a binary
 * that no longer runs — kept serving the previous answer from cache for up to
 * a day (#1746 review F2). Callers fall through to a fresh probe, which is the
 * path that can repair a broken install.
 */
export function invalidateManagedToolResolution(toolId: string): void {
	resolvedPathCache.delete(toolId);
	if (_probeCache !== null) delete _probeCache[toolId];
	markProbeCacheChange(toolId, null);
}

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
	lastInstallResolutionId.set(tool.id, mavenCoordinate(spec));

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
		await writeFileAtomicAsync(jarPath, jarBuffer, { bestEffort: false });

		// Launcher so the tool resolves as a normal command in the managed bin.
		const launcherName = isWindows ? `${binaryName}.bat` : binaryName;
		const launcherPath = path.join(GITHUB_BIN_DIR, launcherName);
		if (isWindows) {
			await writeFileAtomicAsync(
				launcherPath,
				`@echo off\r\njava -jar "%~dp0${tool.id}.jar" %*\r\n`,
				{ bestEffort: false },
			);
		} else {
			await writeFileAtomicAsync(
				launcherPath,
				`#!/bin/sh\nexec java -jar "$(dirname "$0")/${tool.id}.jar" "$@"\n`,
				{ bestEffort: false, mode: 0o750 },
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

/**
 * Move a verified-good extracted tree into its final, stable location without
 * ever leaving `finalDir` empty or missing while a working copy was there
 * (#1759 review F1).
 *
 * Both renames are same-volume directory renames (TOOLS_DIR never spans a
 * filesystem boundary here), so each one individually is as close to atomic
 * as the OS gives us. The gap between them — `finalDir` briefly absent — is
 * unavoidable without OS-level directory-swap support, but it is now
 * MICROSECONDS, not "however long the network download and tar extraction
 * take", and a failure on the second rename restores the backup rather than
 * leaving `finalDir` gone.
 *
 * Worst case (#1759 review R4): the second rename AND the rollback rename it
 * triggers both fail (e.g. the volume went read-only mid-swap). `finalDir` is
 * then genuinely empty and the only surviving copy sits at `finalDir.rollback`
 * — this function still throws either way, so the caller's install/refresh
 * reports failure rather than success, and `invalidateManagedToolResolution`
 * on that failure path (#1759 review F1) is what actually recovers: it drops
 * the cached resolved path, so the next `ensureTool` probe finds nothing at
 * `finalDir`, treats the tool as absent, and reinstalls from scratch. The
 * orphaned `.rollback` directory is NOT reclaimed by that reinstall — it is
 * only cleaned up the next time `swapExtractedDir` runs a SUCCESSFUL swap for
 * this same tool (the unconditional `fs.rm(backupDir, ...)` below), so it can
 * sit on disk for a while. The degradation this records below is what makes
 * that orphan discoverable rather than a silent leak.
 */
// Exported for the rollback-path unit test (#1759 review R3) — the failure
// this guards is only reachable by making the SECOND rename throw, which a
// full `installArchiveTool` run has no test-controlled pause point to force
// without mocking `node:fs` wholesale.
export async function swapExtractedDir(
	toolId: string,
	tmpDir: string,
	finalDir: string,
): Promise<void> {
	const backupDir = `${finalDir}.rollback`;
	await fs.rm(backupDir, { recursive: true, force: true });
	let hadPrevious = false;
	try {
		await fs.rename(finalDir, backupDir);
		hadPrevious = true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	try {
		await fs.rename(tmpDir, finalDir);
	} catch (err) {
		if (hadPrevious) {
			try {
				await fs.rename(backupDir, finalDir);
			} catch (rollbackErr) {
				// The double-failure worst case: `finalDir` is empty and the only
				// surviving copy is the orphan at `backupDir`. Record it — this is
				// the one path where a swallowed catch here would make that orphan
				// invisible, not just inconvenient.
				recordDegradationOnce({
					kind: "managed-tool-refresh",
					subject: toolId,
					reason: `swap rollback failed after a failed install: working copy orphaned at ${backupDir} (${(rollbackErr as Error).message})`,
				});
				logSessionStart(
					`archive-install ${toolId}: swap rollback failed — working copy orphaned at ${backupDir} (${(rollbackErr as Error).message})`,
				);
			}
		}
		throw err;
	}
	if (hadPrevious) {
		await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
	}
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

	lastInstallResolutionId.set(tool.id, url);

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
	//
	// #1759 review F1: extraction and verification happen in a TMP dir, never
	// in `extractDir` itself. `extractDir` is the location a refresh's caller
	// (and every prior session) is currently serving from; the old code
	// `fs.rm`'d it before extraction even started, so a corrupt download or a
	// failed tar left the tool GONE rather than "kept the installed version" —
	// exactly the outcome the failure log line claimed did not happen. The
	// installed copy is now untouched until the replacement is proven good.
	const extractName = tool.id;
	const tmpExtractName = `${extractName}.refresh-tmp`;
	const archiveName = `${tool.id}.download.${spec.kind === "zip" ? "zip" : "tgz"}`;
	const extractDir = path.join(TOOLS_DIR, extractName);
	const tmpExtractDir = path.join(TOOLS_DIR, tmpExtractName);
	const tmpArchive = path.join(TOOLS_DIR, archiveName);
	try {
		await fs.mkdir(TOOLS_DIR, { recursive: true });
		// Clear any stale tmp dir from an interrupted prior attempt — this is the
		// SCRATCH location, never the live install, so clearing it never risks the
		// working copy.
		await fs.rm(tmpExtractDir, { recursive: true, force: true });
		await fs.mkdir(tmpExtractDir, { recursive: true });
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
			tmpExtractName,
			...(stripComponents > 0 ? [`--strip-components=${stripComponents}`] : []),
		];
		// Resolve `tar` to an absolute path on Windows (System32\tar.exe is the
		// bsdtar shipped with Windows 10+) so extraction can't be hijacked via a
		// writable PATH entry — same hardening as the taskkill spawn. On POSIX `tar`
		// is a trusted coreutil whose absolute path varies by distro, so it stays
		// bare (consistent with every other tool spawn).
		const tarBin = isWindows
			? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe`
			: "tar";
		const extractResult = await safeSpawnAsync(tarBin, tarArgs, {
			cwd: TOOLS_DIR,
			timeout: 120_000,
			ignoreAmbientSignal: true,
			lifetimeCoupled: true,
		});
		const extracted = {
			ok: extractResult.status === 0,
			stderr: extractResult.error?.message ?? extractResult.stderr,
		};
		await fs.rm(tmpArchive, { force: true });
		if (!extracted.ok) {
			logSessionStart(
				`archive-install ${tool.id}: extraction failed: ${extracted.stderr} — keeping installed version`,
			);
			await fs
				.rm(tmpExtractDir, { recursive: true, force: true })
				.catch(() => {});
			return undefined;
		}

		// Tree bundle (no launcher): the whole extracted tree IS the artifact. Verify
		// the marker exists — in the TMP dir, before it becomes the live one — the
		// consuming server launches a runtime against a bootstrap inside it (e.g.
		// PSES via pwsh).
		if (!spec.launcher) {
			const tmpMarker = spec.treeMarker
				? path.join(tmpExtractDir, ...spec.treeMarker.split("/"))
				: tmpExtractDir;
			try {
				await fs.access(tmpMarker);
			} catch {
				logSessionStart(
					`archive-install ${tool.id}: tree marker not found at ${tmpMarker} after extraction — keeping installed version`,
				);
				await fs
					.rm(tmpExtractDir, { recursive: true, force: true })
					.catch(() => {});
				return undefined;
			}
			await swapExtractedDir(tool.id, tmpExtractDir, extractDir);
			logSessionStart(
				`archive-install ${tool.id}: installed tree bundle → ${extractDir} (extracted ${archiveBuffer.length} bytes)`,
			);
			debugLog(`[archive] installed ${tool.name} bundle → ${extractDir}`);
			return extractDir;
		}

		// The launcher inside the TMP extracted tree (e.g. bin/spotbugs[.bat]),
		// verified before the tree becomes the live one.
		const launcherParts = spec.launcher.split("/").map((p) => p);
		const tmpInnerLauncher = path.join(tmpExtractDir, ...launcherParts);
		const tmpResolvedInner = isWindows
			? `${tmpInnerLauncher}.bat`
			: tmpInnerLauncher;
		try {
			await fs.access(tmpResolvedInner);
		} catch {
			logSessionStart(
				`archive-install ${tool.id}: launcher not found at ${tmpResolvedInner} after extraction — keeping installed version`,
			);
			await fs
				.rm(tmpExtractDir, { recursive: true, force: true })
				.catch(() => {});
			return undefined;
		}
		if (!isWindows) await fs.chmod(tmpResolvedInner, 0o750).catch(() => {});

		await swapExtractedDir(tool.id, tmpExtractDir, extractDir);

		// The launcher path inside `extractDir` — stable across every install and
		// refresh, since `extractDir` itself never changes — computed fresh now
		// that the swap has put the verified tree there.
		const innerLauncher = path.join(extractDir, ...launcherParts);
		const resolvedInner = isWindows ? `${innerLauncher}.bat` : innerLauncher;

		// Thin shim in the managed bin so discovery (findGitHubToolPath) resolves
		// it like any other managed tool. `call`/`exec` preserves the real
		// launcher's own %~dp0/$0 so it still finds its sibling lib/.
		await fs.mkdir(GITHUB_BIN_DIR, { recursive: true });
		const launcherName = isWindows ? `${binaryName}.bat` : binaryName;
		const shimPath = path.join(GITHUB_BIN_DIR, launcherName);
		if (isWindows) {
			await writeFileAtomicAsync(
				shimPath,
				`@echo off\r\ncall "${resolvedInner}" %*\r\n`,
				{ bestEffort: false },
			);
		} else {
			await writeFileAtomicAsync(
				shimPath,
				`#!/bin/sh\nexec "${resolvedInner}" "$@"\n`,
				{ bestEffort: false, mode: 0o750 },
			);
		}
		logSessionStart(
			`archive-install ${tool.id}: installed → ${shimPath} (extracted ${archiveBuffer.length} bytes)`,
		);
		debugLog(`[archive] installed ${tool.name} → ${shimPath}`);
		return shimPath;
	} catch (err) {
		await fs.rm(tmpArchive, { force: true }).catch(() => {});
		await fs
			.rm(tmpExtractDir, { recursive: true, force: true })
			.catch(() => {});
		logSessionStart(
			`archive-install ${tool.id}: install failed: ${(err as Error).message} — keeping installed version`,
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
			await writeFileAtomicAsync(
				packageJsonPath,
				JSON.stringify({ name: "pi-lens-tools", version: "1.0.0" }, null, 2),
				{ bestEffort: false },
			);
		}

		// Resolve the package manager for the tools dir and build install args.
		const isWindows = installerPlatform() === "win32";
		const pm = await resolveNodePackageManager(TOOLS_DIR);
		const testNpmScript =
			process.env.PI_LENS_TEST_MODE === "1"
				? process.env.PI_LENS_TEST_NPM_SCRIPT
				: undefined;
		const pmCommand = testNpmScript ? process.execPath : pmBinary(pm);
		// Use --ignore-scripts unless the package explicitly needs postinstall
		// (e.g. biome downloads a platform-specific native binary via postinstall).
		const needsScripts = NEEDS_POSTINSTALL.has(packageName);
		const baseInstallArgs = installArgs(pm, packageName, {
			ignoreScripts: !needsScripts,
		});

		const INSTALL_TIMEOUT_MS =
			Number(process.env.PI_LENS_INSTALL_TIMEOUT_MS) || 120_000;
		const runInstallAttempt = async (
			args: string[],
		): Promise<{ ok: boolean; stderr: string }> => {
			const result = await safeSpawnAsync(pmCommand, args, {
				cwd: TOOLS_DIR,
				timeout: INSTALL_TIMEOUT_MS,
				ignoreAmbientSignal: true,
				lifetimeCoupled: true,
			});
			return {
				ok: result.status === 0,
				stderr: result.error?.message ?? result.stderr,
			};
		};

		let outcome = await runInstallAttempt([
			...(testNpmScript ? [testNpmScript] : []),
			...baseInstallArgs,
		]);

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
			outcome = await runInstallAttempt([
				...(testNpmScript ? [testNpmScript] : []),
				...retryArgs,
			]);
		}

		if (!outcome.ok) {
			throw new Error(`Failed to install ${packageName}: ${outcome.stderr}`);
		}

		// npm creates a command shim on Windows; retain that actual executable path
		// rather than probing/storing the extensionless POSIX sibling.
		const binBase = path.join(TOOLS_DIR, "node_modules", ".bin", binaryName);
		const binPath =
			installerPlatform() === "win32" ? `${binBase}.cmd` : binBase;

		// Make executable on Unix
		if (installerPlatform() !== "win32") {
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
		let lastAttemptTransient = false;
		for (let attempt = 1; attempt <= 3; attempt++) {
			lastAttemptTransient = false;
			isValid = await verifyToolBinary(binPath, undefined, () => {
				lastAttemptTransient = true;
			});
			if (isValid) break;
			if (attempt < 3) {
				logSessionStart(
					`auto-install verify ${binaryName}: attempt ${attempt} failed, retrying in ${attempt}s`,
				);
				await new Promise((r) => setTimeout(r, 1000 * attempt));
			}
		}
		if (!isValid && lastAttemptTransient) {
			// #2015: a killed/spawn-failed prober is NOT a verdict about the
			// binary (#1569 semantics). Cold-start verifies on fresh installs
			// legitimately exceed the budget on Windows (Defender/OneDrive
			// first-touch scanning of new node_modules). Deleting a possibly-
			// healthy install here is what turned one slow verify into the
			// reinstall loop - keep the installation; the next ensureTool
			// re-probes the existing binary via discovery instead of
			// reinstalling from scratch.
			logSessionStart(
				`auto-install ${packageName}: verification inconclusive (transient); keeping installation for re-probe`,
			);
			return undefined;
		}
		if (!isValid) {
			logSessionStart(
				`auto-install ${packageName}: installed but verification failed, cleaning up`,
			);
			// Clean up the broken installation
			try {
				const packagePath = path.join(TOOLS_DIR, "node_modules", packageName);
				await fs.rm(packagePath, { recursive: true, force: true });
				await fs.rm(binBase, { force: true });
				if (isWindows) {
					await fs.rm(`${binBase}.cmd`, { force: true });
					await fs.rm(`${binBase}.ps1`, { force: true });
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
	/**
	 * Add `-U`, turning the install into an upgrade. Without it `pip install`
	 * treats an already-present package as satisfied and leaves the day-one
	 * version in place forever — the freeze #1747 is about. The flag is the ONLY
	 * difference between install and refresh: same command ladder, same
	 * `--user` target, so a refresh can never write somewhere the install would
	 * not have.
	 */
	options: { upgrade?: boolean } = {},
): Promise<string | undefined> {
	try {
		const isWindows = process.platform === "win32";
		const verb = options.upgrade
			? ["install", "-U", "--user"]
			: ["install", "--user"];
		const pipCandidates = isWindows
			? [
					{ command: "pip", args: [...verb, packageName] },
					{
						command: "py",
						args: ["-m", "pip", ...verb, packageName],
					},
					{
						command: "python",
						args: ["-m", "pip", ...verb, packageName],
					},
				]
			: [
					{ command: "pip3", args: [...verb, packageName] },
					{ command: "pip", args: [...verb, packageName] },
					{
						command: "python3",
						args: ["-m", "pip", ...verb, packageName],
					},
					{
						command: "python",
						args: ["-m", "pip", ...verb, packageName],
					},
				];

		let lastError = "";
		for (const candidate of pipCandidates) {
			const pipResult = await safeSpawnAsync(
				candidate.command,
				candidate.args,
				{
					timeout: 120_000,
					ignoreAmbientSignal: true,
					lifetimeCoupled: true,
				},
			);
			const outcome = {
				ok: pipResult.status === 0,
				error: (pipResult.error?.message ?? pipResult.stderr).trim(),
			};

			if (outcome.ok) {
				// Ensure user-level scripts directory is available in current process PATH.
				// This helps tools installed via `pip install --user` become immediately callable.
				const userBaseResult = await new Promise<string>((resolve) => {
					let probe: ReturnType<typeof spawn>;
					try {
						probe = spawn(candidate.command, ["-m", "site", "--user-base"], {
							stdio: ["ignore", "pipe", "pipe"],
							shell: isWindows,
						});
					} catch {
						// SYNCHRONOUS spawn throw (Windows `spawn UNKNOWN`/EINVAL, the
						// pidusage bug class, #533) — best-effort probe, resolve empty.
						resolve("");
						return;
					}
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
		const gemResult = await safeSpawnAsync(
			"gem",
			["install", packageName, "--no-document"],
			{
				timeout: 120_000,
				ignoreAmbientSignal: true,
				lifetimeCoupled: true,
			},
		);
		const outcome = {
			ok: gemResult.status === 0,
			error: (gemResult.error?.message ?? gemResult.stderr).trim(),
		};

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
 * Stamp the refresh state at INSTALL time (#1747).
 *
 * An install has just done, by definition, the freshest possible resolution.
 * Recording it here means the periodic refresh starts its cadence from the
 * install rather than treating a day-old tool as never checked — and it is what
 * spares the archive/maven entries a redundant re-download the first time their
 * coordinate comparison runs with no recorded pin.
 *
 * npm is skipped: its install case already calls `stampManagedToolInstalled`
 * directly (#1746 review F4), which reads the installed version off disk. That
 * call happens synchronously before this funnel runs, so stamping npm again
 * here — with no version, since `lastInstallResolutionId` is never set for
 * npm — would overwrite the version-bearing stamp with a version-less one.
 *
 * Lazily imported so `installer/index.ts` keeps no static dependency on the
 * refresh module (which imports this one). Best-effort: a stamp that cannot be
 * written only costs one extra re-resolution later, so it never fails an
 * install.
 */
async function stampInstallResolution(toolId: string): Promise<void> {
	const tool = TOOLS.find((t) => t.id === toolId);
	if (tool?.installStrategy === "npm") return;
	try {
		const resolutionId = lastInstallResolutionId.get(toolId);
		const refresh = await import("./managed-tool-refresh.js");
		await refresh.stampManagedToolInstall(toolId, resolutionId);
	} catch {
		// best-effort
	}
}

async function finishInstallAttempt(
	toolId: string,
	ok: boolean,
	startedAt: number,
): Promise<boolean> {
	logSessionStart(
		`auto-install ${toolId}: ${ok ? "success" : "failed"} (${Date.now() - startedAt}ms)`,
	);
	if (ok) await stampInstallResolution(toolId);
	// Every install strategy funnels its outcome through here, so this one write
	// records attempt-ness for all of them (#1500).
	noteInstallAttempt(
		toolId,
		ok ? "succeeded" : "failed",
		ok ? undefined : (installFailureReasons.get(toolId) ?? "install failed"),
	);
	if (ok) {
		// A prior availability probe may have cached ENOENT for this exact child
		// PATH. Make a successful mutation visible immediately rather than waiting
		// for the bounded negative-cache TTL or the next session reset (#1199).
		resetSafeSpawnWindowsCommandCache();
		// #1276: the madge managed-path memo is keyed only by projectRoot, but
		// reads PATH/discovery/install state that a completed install can just
		// have changed — drop it here too, right alongside the safe-spawn reset.
		// AWAITED (not fire-and-forget): a caller that starts the next madge
		// resolution the instant `installTool`/`ensureTool` resolves must observe
		// the reset memo, not a stale pre-install one, and a rejected dynamic
		// import must not become a silent unhandled rejection. Dynamic import
		// avoids a static dependency-checker.js <-> installer/index.js cycle
		// (dependency-checker.js already imports this module dynamically for the
		// same reason).
		try {
			const { resetMadgeManagedPathMemo } =
				await import("../dependency-checker.js");
			resetMadgeManagedPathMemo();
		} catch (err) {
			logSessionStart(
				`auto-install ${toolId}: madge memo reset failed: ${(err as Error).message}`,
			);
		}
	}
	return ok;
}

/**
 * Install a tool by ID
 */
export async function installTool(toolId: string): Promise<boolean> {
	if (process.env.PI_LENS_DISABLE_TOOL_INSTALL === "1") {
		installFailureReasons.set(
			toolId,
			"installation disabled by PI_LENS_DISABLE_TOOL_INSTALL=1",
		);
		noteInstallAttempt(
			toolId,
			"declined",
			"installation disabled by PI_LENS_DISABLE_TOOL_INSTALL=1",
		);
		logSessionStart(
			`auto-install ${toolId}: refused — PI_LENS_DISABLE_TOOL_INSTALL=1`,
		);
		return false;
	}
	const tool = TOOLS.find((t) => t.id === toolId);
	if (!tool) {
		noteInstallAttempt(toolId, "declined", "unknown tool id");
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
				if (npmPath !== undefined) {
					// #1746 review F4: an install just resolved this package's range
					// against the registry, so record it as freshly checked. Otherwise a
					// new machine that installs 22 tools today has 22 unstamped tools,
					// and spends the next 22 sessions running `npm update` on packages
					// it installed minutes ago.
					//
					// Dynamic import, not a static one: managed-tool-refresh.ts imports
					// THIS module for the tool registry, and a static import back would
					// be a cycle. By the time this line runs the module graph is long
					// since evaluated, so the lazy import is safe and also keeps the
					// refresh module off the startup path.
					await import("./managed-tool-refresh.js")
						.then((m) =>
							m.stampManagedToolInstalled(tool.id, tool.packageName as string),
						)
						.catch(() => {
							// Best-effort telemetry: a missing stamp costs one wasted
							// update later, never a wrong version, and must not fail the
							// install that just succeeded.
						});
				}
				return finishInstallAttempt(tool.id, npmPath !== undefined, startedAt);
			}

			case "pip": {
				if (!tool.packageName) return false;
				const pipPath = await installPipTool(tool.packageName);
				return finishInstallAttempt(tool.id, pipPath !== undefined, startedAt);
			}

			case "gem": {
				if (!tool.packageName) return false;
				const gemPath = await installGemTool(tool.packageName);
				return finishInstallAttempt(tool.id, gemPath !== undefined, startedAt);
			}

			case "github": {
				if (!tool.github) return false;
				const ghPath = await installGitHubTool(tool);
				return finishInstallAttempt(tool.id, ghPath !== undefined, startedAt);
			}

			case "maven": {
				if (!tool.maven) return false;
				const mavenPath = await installMavenTool(tool);
				return finishInstallAttempt(
					tool.id,
					mavenPath !== undefined,
					startedAt,
				);
			}

			case "archive": {
				if (!tool.archive) return false;
				const archivePath = await installArchiveTool(tool);
				return finishInstallAttempt(
					tool.id,
					archivePath !== undefined,
					startedAt,
				);
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
 * Ensure a tool is installed (check first, install if missing).
 *
 * #1334 S5: when the pi host has actively denied project trust, the INSTALL
 * half is switched off here — the request degrades to the existing
 * `allowInstall:false` discovery-only path rather than failing outright, so an
 * already-present binary keeps working while nothing is downloaded or executed
 * on behalf of an untrusted project. A host with no trust surface at all
 * (`"unknown"`) is unaffected.
 */
export async function ensureTool(
	toolId: string,
	opts?: { forceReinstall?: boolean; allowInstall?: boolean },
): Promise<string | undefined> {
	if (
		opts?.allowInstall !== false &&
		!assertInstallAllowed(`managed tool ensure: ${toolId}`)
	) {
		logSessionStart(
			`auto-install ensure ${toolId}: install gated — ${projectTrustDenialReason()}; discovery only`,
		);
		const denialReason = projectTrustDenialReason();
		const discovered = await ensureToolResolved(toolId, {
			...opts,
			allowInstall: false,
		});
		// AFTER the discovery pass, which clears the per-attempt record on entry.
		noteInstallAttempt(toolId, "declined", `project trust: ${denialReason}`);
		return discovered;
	}
	return ensureToolResolved(toolId, opts);
}

async function ensureToolResolved(
	toolId: string,
	opts?: { forceReinstall?: boolean; allowInstall?: boolean },
): Promise<string | undefined> {
	installFailureReasons.delete(toolId);
	// A fresh ensure supersedes whatever the last one recorded, and the trust-gate
	// branch above deliberately keeps its `declined` record by never reaching here.
	installAttempts.delete(toolId);
	lastEnsureResolutionSource.delete(toolId);
	const cacheResolvedPath = (
		result: string | undefined,
	): string | undefined => {
		if (result) {
			resolvedPathCache.set(toolId, result);
			void updateProbeCache(toolId, result, wasLastResolveTransient(toolId));
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
			markProbeCacheChange(toolId, null);
		} catch {
			// best-effort
		}

		if (opts.allowInstall === false) {
			noteInstallAttempt(toolId, "declined", "install disabled by caller");
			logSessionStart(
				`auto-install ensure ${toolId}: force reinstall blocked — install disabled, discovery only (${Date.now() - ensureStartMs}ms)`,
			);
			return cacheResolvedPath(await getToolPath(toolId));
		}
		if (process.env.PI_LENS_DISABLE_TOOL_INSTALL === "1") {
			installFailureReasons.set(
				toolId,
				"installation disabled by PI_LENS_DISABLE_TOOL_INSTALL=1",
			);
			noteInstallAttempt(
				toolId,
				"declined",
				"installation disabled by PI_LENS_DISABLE_TOOL_INSTALL=1",
			);
			logSessionStart(
				`auto-install ensure ${toolId}: refused — PI_LENS_DISABLE_TOOL_INSTALL=1`,
			);
			return undefined;
		}

		const lock = await acquireInstallLock();
		if (!lock.release) {
			noteInstallAttempt(toolId, "skipped", lock.reason ?? "install lock held");
			logSessionStart(`auto-install ensure ${toolId}: ${lock.reason}`);
			return undefined;
		}
		let installed: boolean;
		try {
			installed = await installTool(toolId);
		} finally {
			await lock.release();
		}
		if (!installed) {
			// installTool RAN. Whatever it recorded stands; otherwise this is a
			// genuine failure, which is what the caller needs to see (#1500).
			noteInstallAttemptIfUnrecorded(toolId, "failed", "install failed");
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
	if (cached) {
		if (!isFullyQualified(cached)) {
			lastEnsureResolutionSource.set(toolId, "session-cache");
			return cached;
		}
		try {
			await fs.access(cached);
			lastEnsureResolutionSource.set(toolId, "session-cache");
			return cached;
		} catch {
			// The executor would report ENOENT for this cached positive. Evict it
			// before discovery so the failure heals on this call, not after restart.
		}
		resolvedPathCache.delete(toolId);
		const probeCache = await readProbeCache();
		delete probeCache[toolId];
		markProbeCacheChange(toolId, null);
		logSessionStart(
			`auto-install ensure ${toolId}: cached path disappeared; re-probing`,
		);
	}

	// Fast path 2: persistent probe cache — fs.access + stat, no process spawn.
	const diskCached = await checkProbeCache(toolId);
	if (diskCached) {
		resolvedPathCache.set(toolId, diskCached);
		lastEnsureResolutionSource.set(toolId, "probe-cache");
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
			// Version-pin drift (#589): getToolPath() above just spawned
			// verifyToolBinary on the managed local install anyway (this is the
			// slow path — fast paths 1/2 above already returned before reaching
			// here), so lastManagedInstallVersion was populated for free if this
			// is a pinned npm tool. Compare it to the current pin and, on
			// mismatch, route through the EXISTING forceReinstall codepath rather
			// than resolving to a known-stale binary. Piggybacks entirely on the
			// probe-cache's ~once-per-24h/once-per-session cadence — no new spawn.
			const tool = TOOLS.find((t) => t.id === toolId);
			const pinnedVersion =
				tool?.installStrategy === "npm" && tool.packageName
					? parsePinnedVersion(tool.packageName)
					: undefined;
			if (pinnedVersion) {
				const seenVersion = lastManagedInstallVersion.get(toolId);
				if (seenVersion && seenVersion !== pinnedVersion) {
					lastManagedInstallVersion.delete(toolId);
					logSessionStart(
						`auto-install ensure ${toolId}: version drift (installed ${seenVersion} != pinned ${pinnedVersion}) — forcing reinstall (${Date.now() - ensureStartMs}ms)`,
					);
					return ensureTool(toolId, {
						forceReinstall: true,
						allowInstall: opts?.allowInstall,
					});
				}
			}

			resolvedPathCache.set(toolId, existingPath);
			void updateProbeCache(
				toolId,
				existingPath,
				wasLastResolveTransient(toolId),
			);
			lastEnsureResolutionSource.set(toolId, "path");
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
			noteInstallAttempt(toolId, "declined", "install disabled by caller");
			logSessionStart(
				`auto-install ensure ${toolId}: install disabled — discovery only, not found (${Date.now() - ensureStartMs}ms)`,
			);
			return undefined;
		}
		if (process.env.PI_LENS_DISABLE_TOOL_INSTALL === "1") {
			installFailureReasons.set(
				toolId,
				"installation disabled by PI_LENS_DISABLE_TOOL_INSTALL=1",
			);
			noteInstallAttempt(
				toolId,
				"declined",
				"installation disabled by PI_LENS_DISABLE_TOOL_INSTALL=1",
			);
			logSessionStart(
				`auto-install ensure ${toolId}: refused — PI_LENS_DISABLE_TOOL_INSTALL=1 (${Date.now() - ensureStartMs}ms)`,
			);
			return undefined;
		}

		const lock = await acquireInstallLock();
		if (!lock.release) {
			installFailureReasons.set(toolId, lock.reason ?? "install lock failed");
			noteInstallAttempt(toolId, "skipped", lock.reason ?? "install lock held");
			logSessionStart(`auto-install ensure ${toolId}: ${lock.reason}`);
			return undefined;
		}
		let installed: boolean;
		try {
			// Cross-process double-check: the lock waiter may now observe the tool
			// installed by its predecessor and must not run a second package manager.
			const installedByPeer = await getToolPath(toolId);
			if (installedByPeer) {
				noteInstallAttempt(
					toolId,
					"succeeded",
					"installed by a concurrent process",
				);
				resolvedPathCache.set(toolId, installedByPeer);
				void updateProbeCache(
					toolId,
					installedByPeer,
					wasLastResolveTransient(toolId),
				);
				return installedByPeer;
			}
			installed = await installTool(toolId);
		} finally {
			await lock.release();
		}
		if (!installed) {
			// installTool RAN and did not succeed. A genuine failure unless it
			// recorded a more specific outcome of its own (#1500).
			noteInstallAttemptIfUnrecorded(toolId, "failed", "install failed");
			logSessionStart(
				`auto-install ensure ${toolId}: unavailable (${Date.now() - ensureStartMs}ms)`,
			);
			return undefined;
		}

		const result = await getToolPath(toolId);
		if (result) {
			resolvedPathCache.set(toolId, result);
			void updateProbeCache(toolId, result, wasLastResolveTransient(toolId));
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
 * The registry's own install strategy for `toolId`, or `undefined` for an
 * unknown id. Single source of truth for anything that needs to LABEL how a
 * tool gets installed (e.g. the availability-decision evidence's `source`
 * tag, #1612) — derived from the same `TOOLS` entry `ensureTool` dispatches
 * on, so the label can never drift out of sync with the actual installer.
 */
export function getToolInstallStrategy(
	toolId: string,
): ToolDefinition["installStrategy"] | undefined {
	return TOOLS.find((tool) => tool.id === toolId)?.installStrategy;
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
	"terragrunt",
	"terraform-ls",
	"zls",
	"hadolint",
	"helm",
	"gitleaks",
	"taplo",
	"vale",
	"opengrep",
	"deno",
	"clojure-lsp",
	"cue",
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

// Signature/checksum siblings a release publishes next to the real asset. A
// bare-binary tool's substring IS the whole asset name, so `includes` alone
// matches `<asset>.asc` too and would install a signature file as the binary.
const ASSET_SIDECAR_SUFFIXES = [
	".asc",
	".sig",
	".minisig",
	".pem",
	".cert",
	".sbom",
	".sha256",
	".sha256sum",
	".md5",
];

function isAssetSidecar(name: string): boolean {
	const lower = name.toLowerCase();
	return ASSET_SIDECAR_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

export function pickReleaseAsset<T extends { name: string }>(
	assets: T[],
	assetSubstring: string,
): T | undefined {
	return (
		assets.find((a) => a.name === assetSubstring) ??
		assets.find(
			(a) => a.name.includes(assetSubstring) && !isAssetSidecar(a.name),
		)
	);
}

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
