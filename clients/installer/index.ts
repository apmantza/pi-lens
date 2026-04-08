/**
 * Auto-Installation System for pi-lens
 *
 * Minimal auto-install: Core tools that run frequently.
 * Other tools require manual installation with clear instructions.
 *
 * Auto-install (10 tools):
 * - typescript-language-server (TypeScript LSP)
 * - pyright (Python LSP)
 * - ruff (Python linting)
 * - @biomejs/biome (JS/TS/JSON linting/formatting)
 * - madge (circular dependency detection)
 * - jscpd (duplicate code detection)
 * - @ast-grep/cli (structural code search)
 * - knip (dead code detection)
 * - yamllint (YAML linting)
 * - sqlfluff (SQL linting/formatting)
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
 * - GitHub releases (for platform-specific binaries - not yet implemented)
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Global installation directory for pi-lens tools
const TOOLS_DIR = path.join(os.homedir(), ".pi-lens", "tools");

// Debug flag - set via PI_LENS_DEBUG=1 or --debug
const DEBUG =
	process.env.PI_LENS_DEBUG === "1" || process.argv.includes("--debug");

/**
 * Log debug messages only when DEBUG is enabled
 */
function debugLog(...args: unknown[]): void {
	if (DEBUG) {
		console.error("[auto-install:debug]", ...args);
	}
}

// --- Tool Definitions ---

interface ToolDefinition {
	id: string;
	name: string;
	checkCommand: string;
	checkArgs: string[];
	installStrategy: "npm" | "pip" | "github";
	packageName?: string;
	binaryName?: string;
	// GitHub release download fields
	githubRepo?: string; // e.g., "clangd/clangd"
	githubAssetMatch?: (platform: string, arch: string) => string | undefined;
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
		packageName: "jscpd",
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
];

const ensureInFlight = new Map<string, Promise<string | undefined>>();

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
		proc.on("exit", (code) => resolve(code === 0));
		proc.on("error", () => resolve(false));
	});
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

	// Check local
	const localPath = path.join(
		TOOLS_DIR,
		"node_modules",
		".bin",
		tool.binaryName || tool.id,
	);
	try {
		await fs.access(localPath);
		return localPath;
	} catch {
		return undefined;
	}
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
					path.join(dir, `${binaryName}.ps1`),
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

// --- Verification Functions

/**
 * Verify a tool binary actually works by running --version
 * This catches broken symlinks, partial installs, and corrupted binaries
 */
async function verifyToolBinary(binPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		// Add .cmd extension on Windows for the actual binary
		const isWindows = process.platform === "win32";
		const hasKnownWindowsExt = /\.(cmd|exe|ps1)$/i.test(binPath);
		const execPath =
			isWindows && !hasKnownWindowsExt ? `${binPath}.cmd` : binPath;

		const proc = spawn(execPath, ["--version"], {
			timeout: 10000, // 10 second timeout for verification
			stdio: ["ignore", "pipe", "pipe"],
			shell: isWindows, // Required for .cmd wrappers on Windows
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
				console.error(`[auto-install] Verification failed for ${binPath}`);
				debugLog("Exit code:", code, "stderr:", stderr);
				resolve(false);
			}
		});

		proc.on("error", (err) => {
			console.error(`[auto-install] Verification failed for ${binPath}`);
			debugLog("Error:", err.message);
			resolve(false);
		});
	});
}

// --- Installation Functions

/**
 * Install an npm package tool
 */
/**
 * Packages that require postinstall scripts to download native binaries.
 * All others get --ignore-scripts to prevent arbitrary code execution during install.
 */
const NEEDS_POSTINSTALL = new Set([
	"@biomejs/biome",
	"@ast-grep/napi",
	"esbuild",
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
		const pm = process.env.BUN_INSTALL
			? isWindows
				? "bun.exe"
				: "bun"
			: isWindows
				? "npm.cmd"
				: "npm";
		// Use --ignore-scripts unless the package explicitly needs postinstall
		// (e.g. biome downloads a platform-specific native binary via postinstall).
		const needsScripts = NEEDS_POSTINSTALL.has(
			packageName.split("@")[0] ?? packageName,
		);
		const installArgs = needsScripts
			? ["install", packageName]
			: ["install", "--ignore-scripts", packageName];
		const proc = spawn(pm, installArgs, {
			cwd: TOOLS_DIR,
			stdio: ["ignore", "pipe", "pipe"],
			shell: isWindows, // Required for .cmd files on Windows
		});

		return new Promise((resolve, reject) => {
			let stderr = "";
			proc.stderr?.on("data", (data) => (stderr += data));

			proc.on("exit", async (code) => {
				if (code === 0) {
					const binPath = path.join(
						TOOLS_DIR,
						"node_modules",
						".bin",
						binaryName,
					);

					// Make executable on Unix
					if (process.platform !== "win32") {
						try {
							await fs.chmod(binPath, 0o755);
						} catch {
							/* ignore */
						}
					}

					// NEW: Verify the binary actually works before returning
					debugLog(`Verifying ${binaryName}...`);
					const isValid = await verifyToolBinary(binPath);
					if (!isValid) {
						console.error(
							`[auto-install] ${packageName} installed but verification failed (binary may be corrupted)`,
						);
						// Clean up the broken installation
						try {
							const packagePath = path.join(
								TOOLS_DIR,
								"node_modules",
								packageName,
							);
							await fs.rm(packagePath, { recursive: true, force: true });
							await fs.rm(binPath, { force: true });
							if (isWindows) {
								await fs.rm(`${binPath}.cmd`, { force: true });
								await fs.rm(`${binPath}.ps1`, { force: true });
							}
						} catch {
							/* ignore cleanup errors */
						}
						resolve(undefined);
						return;
					}

					resolve(binPath);
				} else {
					reject(new Error(`Failed to install ${packageName}: ${stderr}`));
				}
			});

			proc.on("error", (err) => reject(err));
		});
	} catch (err) {
		console.error(
			`[auto-install] Failed to install ${packageName}: ${(err as Error).message}`,
		);
		debugLog("Full error:", err);
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
					{ command: "py", args: ["-m", "pip", "install", "--user", packageName] },
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
					{ command: "python", args: ["-m", "pip", "install", "--user", packageName] },
				];

		let lastError = "";
		for (const candidate of pipCandidates) {
			const outcome = await new Promise<{ ok: boolean; error: string }>((resolve) => {
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
			});

			if (outcome.ok) {
				// Ensure user-level scripts directory is available in current process PATH.
				// This helps tools installed via `pip install --user` become immediately callable.
				const userBaseResult = await new Promise<string>((resolve) => {
					const probe = spawn(candidate.command, ["-m", "site", "--user-base"], {
						stdio: ["ignore", "pipe", "pipe"],
						shell: isWindows,
					});
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

					const currentPath = process.env.PATH || "";
					const separator = isWindows ? ";" : ":";
					const normalizedPath = currentPath
						.toLowerCase()
						.split(separator)
						.map((p) => p.trim());

					for (const scriptsDir of candidateScriptDirs) {
						try {
							await fs.access(scriptsDir);
							if (!normalizedPath.includes(scriptsDir.toLowerCase())) {
								process.env.PATH = `${scriptsDir}${separator}${process.env.PATH || ""}`;
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
		console.error(
			`[auto-install] Failed to install ${packageName}: ${(err as Error).message}`,
		);
		debugLog("Full error:", err);
		return undefined;
	}
}

/**
 * Install a tool by ID
 */
export async function installTool(toolId: string): Promise<boolean> {
	const tool = TOOLS.find((t) => t.id === toolId);
	if (!tool) {
		console.error(`[auto-install] Unknown tool: ${toolId}`);
		return false;
	}

	console.error(`[auto-install] Installing ${tool.name}...`);

	try {
		switch (tool.installStrategy) {
			case "npm": {
				if (!tool.packageName || !tool.binaryName) return false;
				const npmPath = await installNpmTool(tool.packageName, tool.binaryName);
				return npmPath !== undefined;
			}

			case "pip": {
				if (!tool.packageName) return false;
				const pipPath = await installPipTool(tool.packageName);
				return pipPath !== undefined;
			}

			default:
				console.error(
					`[auto-install] Unsupported strategy: ${tool.installStrategy}`,
				);
				return false;
		}
	} catch (err) {
		console.error(
			`[auto-install] Failed to install ${tool.name}: ${(err as Error).message}`,
		);
		debugLog("Full error:", err);
		return false;
	}
}

/**
 * Ensure a tool is installed (check first, install if missing)
 */
export async function ensureTool(toolId: string): Promise<string | undefined> {
	// Check if already installed
	const existingPath = await getToolPath(toolId);
	if (existingPath) {
		return existingPath;
	}

	const inFlight = ensureInFlight.get(toolId);
	if (inFlight) {
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
		return await installPromise;
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
	const currentPath = process.env.PATH || "";
	const separator = process.platform === "win32" ? ";" : ":";

	return {
		...process.env,
		PATH: `${localBin}${separator}${currentPath}`,
	};
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
