/**
 * Auto-Installation System for pi-lens
 * 
 * Automatically installs required tools when they're not found:
 * - typescript-language-server (for LSP)
 * - pyright (Python type checking)
 * - ruff (Python linting)
 * - @biomejs/biome (JS/TS/JSON linting)
 * - @ast-grep/cli (structural search)
 * 
 * Strategies:
 * - npm packages via npx/bun
 * - pip packages
 * - GitHub releases (for platform-specific binaries)
 */

import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

// Global installation directory for pi-lens tools
const TOOLS_DIR = path.join(process.cwd(), ".pi-lens", "tools");

// --- Tool Definitions ---

interface ToolDefinition {
	id: string;
	name: string;
	checkCommand: string;
	checkArgs: string[];
	installStrategy: "npm" | "pip" | "github";
	packageName?: string;
	binaryName?: string;
}

const TOOLS: ToolDefinition[] = [
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
	{
		id: "ast-grep",
		name: "ast-grep",
		checkCommand: "ast-grep",
		checkArgs: ["--version"],
		installStrategy: "npm",
		packageName: "@ast-grep/cli",
		binaryName: "sg",
	},
];

// --- Check Functions ---

/**
 * Check if a command is available in PATH
 */
async function isCommandAvailable(
	command: string,
	args: string[] = ["--version"]
): Promise<boolean> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, { stdio: "ignore" });
		proc.on("exit", (code) => resolve(code === 0));
		proc.on("error", () => resolve(false));
	});
}

/**
 * Check if a tool is installed (globally or locally)
 */
export async function isToolInstalled(toolId: string): Promise<boolean> {
	const tool = TOOLS.find((t) => t.id === toolId);
	if (!tool) return false;

	// Check global PATH
	if (await isCommandAvailable(tool.checkCommand, tool.checkArgs)) {
		return true;
	}

	// Check local tools directory
	const localPath = path.join(TOOLS_DIR, "node_modules", ".bin", tool.binaryName || tool.id);
	try {
		await fs.access(localPath);
		return true;
	} catch {
		return false;
	}
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

	// Check local
	const localPath = path.join(TOOLS_DIR, "node_modules", ".bin", tool.binaryName || tool.id);
	try {
		await fs.access(localPath);
		return localPath;
	} catch {
		return undefined;
	}
}

// --- Installation Functions ---

/**
 * Install an npm package tool
 */
async function installNpmTool(
	packageName: string,
	binaryName: string
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
				JSON.stringify({ name: "pi-lens-tools", version: "1.0.0" }, null, 2)
			);
		}

		// Install via npm or bun
		const pm = process.env.BUN_INSTALL ? "bun" : "npm";
		const proc = spawn(pm, ["install", packageName], {
			cwd: TOOLS_DIR,
			stdio: ["ignore", "pipe", "pipe"],
		});

		return new Promise((resolve, reject) => {
			let stderr = "";
			proc.stderr?.on("data", (data) => (stderr += data));

			proc.on("exit", async (code) => {
				if (code === 0) {
					const binPath = path.join(TOOLS_DIR, "node_modules", ".bin", binaryName);
					// Make executable on Unix
					if (process.platform !== "win32") {
						try {
							await fs.chmod(binPath, 0o755);
						} catch { /* ignore */ }
					}
					resolve(binPath);
				} else {
					reject(new Error(`Failed to install ${packageName}: ${stderr}`));
				}
			});

			proc.on("error", (err) => reject(err));
		});
	} catch (err) {
		console.error(`[auto-install] Failed to install npm tool ${packageName}:`, err);
		return undefined;
	}
}

/**
 * Install a pip package tool
 */
async function installPipTool(packageName: string): Promise<string | undefined> {
	try {
		const pipCmd = process.platform === "win32" ? "pip" : "pip3";
		const proc = spawn(pipCmd, ["install", "--user", packageName], {
			stdio: ["ignore", "pipe", "pipe"],
		});

		return new Promise((resolve, reject) => {
			let stderr = "";
			proc.stderr?.on("data", (data) => (stderr += data));

			proc.on("exit", (code) => {
				if (code === 0) {
					resolve(packageName); // pip installs to PATH
				} else {
					reject(new Error(`Failed to install ${packageName}: ${stderr}`));
				}
			});

			proc.on("error", (err) => reject(err));
		});
	} catch (err) {
		console.error(`[auto-install] Failed to install pip tool ${packageName}:`, err);
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
			case "npm":
				if (!tool.packageName || !tool.binaryName) return false;
				const npmPath = await installNpmTool(tool.packageName, tool.binaryName);
				return npmPath !== undefined;

			case "pip":
				if (!tool.packageName) return false;
				const pipPath = await installPipTool(tool.packageName);
				return pipPath !== undefined;

			default:
				console.error(`[auto-install] Unsupported strategy: ${tool.installStrategy}`);
				return false;
		}
	} catch (err) {
		console.error(`[auto-install] Failed to install ${tool.name}:`, err);
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

	// Try to install
	const installed = await installTool(toolId);
	if (!installed) {
		return undefined;
	}

	// Return the path after installation
	return getToolPath(toolId);
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
