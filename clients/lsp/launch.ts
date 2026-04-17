/**
 * LSP Process Launch Utilities
 *
 * Handles spawning LSP servers via various methods:
 * - Direct binary execution (using absolute paths on Windows)
 * - Node.js scripts (npx/bun)
 * - Package manager execution
 */

import {
	type ChildProcess,
	execSync,
	spawn as nodeSpawn,
	type SpawnOptions,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LSPProcess {
	process: ChildProcess;
	stdin: NodeJS.WritableStream;
	stdout: NodeJS.ReadableStream;
	stderr: NodeJS.ReadableStream;
	pid: number;
}

const isWindows = process.platform === "win32";
const SESSIONSTART_LOG_DIR = path.join(os.homedir(), ".pi-lens");
const SESSIONSTART_LOG = path.join(SESSIONSTART_LOG_DIR, "sessionstart.log");

function logSessionStart(msg: string): void {
	const line = `[${new Date().toISOString()}] ${msg}\n`;
	try {
		fs.mkdirSync(SESSIONSTART_LOG_DIR, { recursive: true });
		fs.appendFileSync(SESSIONSTART_LOG, line);
	} catch {}
}

function compactLogValue(value: string, max = 280): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) return "";
	return normalized.length > max
		? `${normalized.slice(0, max)}...`
		: normalized;
}

function delimiterForPlatform(platform: NodeJS.Platform): string {
	return platform === "win32" ? ";" : ":";
}

function splitPathEntries(value: string | undefined, delimiter: string): string[] {
	if (!value) return [];
	return value
		.split(delimiter)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function normalizePathEntry(entry: string, platform: NodeJS.Platform): string {
	const normalized = path.normalize(entry);
	return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function combinePathValuesForPlatform(
	values: Array<string | undefined>,
	platform: NodeJS.Platform = process.platform,
): string {
	const unique: string[] = [];
	const seen = new Set<string>();
	const delimiter = delimiterForPlatform(platform);

	for (const value of values) {
		for (const entry of splitPathEntries(value, delimiter)) {
			const key = normalizePathEntry(entry, platform);
			if (seen.has(key)) continue;
			seen.add(key);
			unique.push(entry);
		}
	}

	return unique.join(delimiter);
}

function resolvePathValue(env: NodeJS.ProcessEnv): string {
	return combinePathValuesForPlatform([env.PATH, env.Path, env.path]);
}

function buildAugmentedPath(basePath?: string): string {
	const candidates: string[] = [];
	const nodeDir = path.dirname(process.execPath);
	if (nodeDir) {
		candidates.push(nodeDir);
	}

	if (isWindows) {
		const userProfile = process.env.USERPROFILE;
		if (userProfile) {
			candidates.push(path.join(userProfile, ".cargo", "bin"));
			candidates.push(path.join(userProfile, "go", "bin"));
		}
		candidates.push(path.join("C:\\", "Program Files", "Go", "bin"));
		candidates.push(path.join("C:\\", "Go", "bin"));
		candidates.push(path.join("C:\\", "Ruby34-x64", "bin"));
		candidates.push(path.join("C:\\", "Ruby33-x64", "bin"));
	}

	const existing = new Set<string>();
	for (const entry of splitPathEntries(basePath, path.delimiter)) {
		if (!entry) continue;
		existing.add(normalizePathEntry(entry, process.platform));
	}

	const toAppend: string[] = [];
	for (const candidate of candidates) {
		if (!candidate || !fs.existsSync(candidate)) continue;
		const normalized = normalizePathEntry(candidate, process.platform);
		if (existing.has(normalized)) continue;
		toAppend.push(candidate);
		existing.add(normalized);
	}

	if (toAppend.length === 0) return basePath ?? "";
	if (!basePath) return toAppend.join(path.delimiter);
	return `${basePath}${path.delimiter}${toAppend.join(path.delimiter)}`;
}

/**
 * Find binary in npm global directory
 * Works around PATH caching issue after npm install -g
 */
function _findBinaryInNpmGlobal(command: string): string | undefined {
	try {
		// Get npm global prefix
		const prefix = execSync("npm prefix -g", { encoding: "utf-8" }).trim();

		// On Windows, binaries are directly in the prefix dir
		// On Unix, they're in prefix/bin
		const binDir = isWindows ? prefix : path.join(prefix, "bin");

		// Check for Windows variants
		const candidates = isWindows
			? [
					path.join(binDir, `${command}.cmd`),
					path.join(binDir, `${command}.exe`),
					path.join(binDir, command),
				]
			: [path.join(binDir, command)];

		for (const candidate of candidates) {
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Try to spawn a process, throwing immediately if it fails
 */
function trySpawn(
	command: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	needsShell: boolean,
): ChildProcess {
	let proc: ChildProcess;

	if (needsShell) {
		// Use shell mode with quoted command
		const shellCommand = `"${command}" ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`;
		proc = nodeSpawn(shellCommand, [], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: false,
			windowsHide: true,
			shell: true,
		});
	} else {
		// Use normal spawn without shell
		proc = nodeSpawn(command, args, {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: false,
			windowsHide: isWindows,
		});
	}

	if (!proc.stdin || !proc.stdout || !proc.stderr) {
		throw new Error(`Failed to spawn LSP server: ${command}`);
	}

	// Check if process exited immediately (spawn failure - synchronous check)
	if (proc.exitCode !== null || proc.killed) {
		throw new Error(
			`LSP server ${command} exited immediately (code: ${proc.exitCode}). ` +
				`The binary may be missing or corrupted.`,
		);
	}

	return proc;
}

/**
 * Attach error handler to a spawned process to prevent ENOENT crashes
 * This catches "command not found" errors and other spawn failures
 * Returns a promise that rejects if an immediate error occurs
 */
function _attachErrorHandler(
	proc: ChildProcess,
	context: string,
	logContext?: {
		command: string;
		args: string[];
		cwd: string;
		pid?: number;
	},
	rejectOnImmediateError?: (err: Error) => void,
): void {
	let stderrPreview = "";
	let closeLogged = false;
	const onStderr = (chunk: Buffer | string): void => {
		if (stderrPreview.length >= 4000) return;
		stderrPreview += chunk.toString();
	};
	proc.stderr?.on("data", onStderr);

	proc.on("error", (err) => {
		if (logContext) {
			logSessionStart(
				`lsp process ${context}: spawn-error command=${logContext.command} args=${JSON.stringify(logContext.args)} cwd=${logContext.cwd} pid=${logContext.pid ?? 0} error=${err.message}${stderrPreview ? ` stderr=${compactLogValue(stderrPreview)}` : ""}`,
			);
		}

		// If we have a reject function and this is an immediate spawn error, reject
		if (
			rejectOnImmediateError &&
			(err as NodeJS.ErrnoException).code === "ENOENT"
		) {
			rejectOnImmediateError(err);
		}
	});

	proc.on("close", (code, signal) => {
		if (closeLogged) return;
		closeLogged = true;
		proc.stderr?.off("data", onStderr);
		if (code !== 0 && code !== null) {
			if (logContext) {
				logSessionStart(
					`lsp process ${context}: closed code=${code}${signal ? ` signal=${signal}` : ""} command=${logContext.command} args=${JSON.stringify(logContext.args)} cwd=${logContext.cwd} pid=${logContext.pid ?? 0}${stderrPreview ? ` stderr=${compactLogValue(stderrPreview)}` : ""}`,
				);
			}
		} else if (signal && logContext) {
			logSessionStart(
				`lsp process ${context}: closed signal=${signal} command=${logContext.command} args=${JSON.stringify(logContext.args)} cwd=${logContext.cwd} pid=${logContext.pid ?? 0}${stderrPreview ? ` stderr=${compactLogValue(stderrPreview)}` : ""}`,
			);
		}
	});
}

/**
 * Spawn an LSP server process
 *
 * Key fixes for Windows:
 * - Uses absolute paths (relative paths fail in shell mode)
 * - Uses shell: true for .cmd files
 * - Uses windowsHide to prevent console window popup
 * - Detects immediate spawn failures (ENOENT) before returning
 *
 * @param command - Command to run (e.g., "typescript-language-server")
 * @param args - Arguments (e.g., ["--stdio"])
 * @param options - Spawn options including cwd, env
 * @returns LSPProcess handle
 */
export async function launchLSP(
	command: string,
	args: string[] = [],
	options: SpawnOptions = {},
): Promise<LSPProcess> {
	const cwd = String(options.cwd ?? process.cwd());
	const mergedEnv = { ...process.env, ...options.env };
	const augmentedPath = buildAugmentedPath(resolvePathValue(mergedEnv));
	const env: NodeJS.ProcessEnv = {
		...mergedEnv,
		PATH: augmentedPath,
		...(isWindows ? { Path: augmentedPath } : {}),
	};

	// Resolve command path
	// - If already absolute, use as-is
	// - If it's a simple command (no path separators), let system find it via PATH
	// - Otherwise, resolve relative to cwd
	const resolvedCommand = path.isAbsolute(command)
		? command
		: command.includes(path.sep) || command.includes("/")
			? path.resolve(cwd, command)
			: command; // Let system find it via PATH

	// Compute needsShell based on command
	// On Windows, shell: true is needed for .cmd/.bat files and extensionless binaries
	// .exe files can be spawned directly, but .cmd/.bat require shell interpretation
	const hasScriptExtension = /\.(cmd|bat)$/i.test(resolvedCommand);
	let needsShell =
		isWindows &&
		(resolvedCommand.includes(" ") ||
			hasScriptExtension ||
			!/\.(exe|cmd|bat)$/i.test(resolvedCommand));

	// Try to spawn the process
	// If command not found, try npm global as fallback (handles PATH caching after install)
	let spawnCommand = resolvedCommand;

	// First, try to find in npm global if it's a simple command name
	if (
		!path.isAbsolute(command) &&
		!command.includes(path.sep) &&
		!command.includes("/")
	) {
		const npmGlobalPath = _findBinaryInNpmGlobal(command);
		if (npmGlobalPath) {
			spawnCommand = npmGlobalPath;
			// Recompute needsShell for npm global path
			needsShell =
				isWindows &&
				(spawnCommand.includes(" ") ||
					/\.(cmd|bat)$/i.test(spawnCommand) ||
					!/\.(exe|cmd|bat)$/i.test(spawnCommand));
		}
	}

	let proc: ChildProcess;

	try {
		proc = trySpawn(spawnCommand, args, cwd, env, needsShell);
	} catch (err) {
		// If spawn failed with simple command, try npm global
		if (
			!path.isAbsolute(command) &&
			!command.includes(path.sep) &&
			!command.includes("/")
		) {
			const npmGlobalPath = _findBinaryInNpmGlobal(command);
			if (npmGlobalPath && npmGlobalPath !== spawnCommand) {
				// Recompute needsShell for npm global path
				const needsShellGlobal =
					isWindows &&
					(npmGlobalPath.includes(" ") ||
						/\.(cmd|bat)$/i.test(npmGlobalPath) ||
						!/\.(exe|cmd|bat)$/i.test(npmGlobalPath));
				proc = trySpawn(npmGlobalPath, args, cwd, env, needsShellGlobal);
			} else {
				throw err;
			}
		} else {
			throw err;
		}
	}

	if (!proc.stdin || !proc.stdout || !proc.stderr) {
		throw new Error(`Failed to spawn LSP server: ${command}`);
	}

	// Check if process exited immediately (spawn failure - synchronous check)
	if (proc.exitCode !== null || proc.killed) {
		throw new Error(
			`LSP server ${command} exited immediately (code: ${proc.exitCode}). ` +
				`The binary may be missing or corrupted.`,
		);
	}

	logSessionStart(
		`lsp launch: command=${command} resolved=${spawnCommand} args=${JSON.stringify(args)} cwd=${cwd} shell=${needsShell ? "true" : "false"} pid=${proc.pid ?? 0}`,
	);

	const formatStartupStderr = (stderr: string): string => {
		const normalized = compactLogValue(stderr);
		if (!normalized) return "";
		return ` stderr=${normalized}`;
	};

	let startupStderr = "";
	const onStartupStderr = (chunk: Buffer | string): void => {
		if (startupStderr.length >= 4000) return;
		startupStderr += chunk.toString();
	};
	proc.stderr?.on("data", onStartupStderr);

	// For Windows and certain spawn failures, the error is async (ENOENT)
	// We need to wait a small tick to catch immediate spawn failures
	try {
		await new Promise<void>((resolve, reject) => {
		let settled = false;

		// Attach error handler that can reject for immediate errors
		proc.on("error", (err: Error & { code?: string }) => {
			if (!settled && (err.code === "ENOENT" || err.code === "EINVAL")) {
				settled = true;
				reject(
					new Error(
						`LSP server binary not found: ${command}. ` +
							`Install it or check your PATH.${formatStartupStderr(startupStderr)}`,
					),
				);
			}
		});

		// Also listen for immediate exit
		proc.on("exit", (code: number | null) => {
			if (!settled && code !== null) {
				settled = true;
				reject(
					new Error(
						`LSP server ${command} exited immediately with code ${code}. ` +
							`The binary may be missing or corrupted.${formatStartupStderr(startupStderr)}`,
					),
				);
			}
		});

		// Give it a small window to fail immediately (ENOENT on Windows is fast)
		setTimeout(() => {
			if (!settled) {
				settled = true;
				resolve();
			}
		}, 50);
		});
	} finally {
		proc.stderr?.off("data", onStartupStderr);
	}

	// Re-attach the permanent error handler now that we've passed the danger zone
	_attachErrorHandler(proc, command, {
		command: spawnCommand,
		args,
		cwd,
		pid: proc.pid ?? 0,
	});

	return {
		process: proc,
		stdin: proc.stdin,
		stdout: proc.stdout,
		stderr: proc.stderr,
		pid: proc.pid ?? 0,
	};
}

/**
 * Spawn via package manager (npx/bun)
 */
export async function launchViaPackageManager(
	packageName: string,
	args: string[] = [],
	options: SpawnOptions = {},
): Promise<LSPProcess> {
	// Prefer bun if available, fall back to npx (use .cmd on Windows)
	const isWin = process.platform === "win32";

	if (process.env.BUN_INSTALL) {
		return launchLSP(
			isWin ? "bun.exe" : "bun",
			["x", packageName, ...args],
			options,
		);
	}

	// For npx on Windows, use shell mode with the full command string
	if (isWin) {
		const argsStr = args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ");
		// --no prevents silent download of uncached packages
		const shellCommand = `npx --no ${packageName}${argsStr ? ` ${argsStr}` : ""}`;

		const cwd = String(options.cwd ?? process.cwd());
		const mergedEnv = { ...process.env, ...options.env };
		const augmentedPath = buildAugmentedPath(resolvePathValue(mergedEnv));
		const env: NodeJS.ProcessEnv = {
			...mergedEnv,
			PATH: augmentedPath,
			...(isWindows ? { Path: augmentedPath } : {}),
		};

		const proc = nodeSpawn(shellCommand, [], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: false,
			windowsHide: true,
			shell: true,
		});

		if (!proc.stdin || !proc.stdout || !proc.stderr) {
			throw new Error(`Failed to spawn package manager for: ${packageName}`);
		}

		// Check for immediate spawn failure on Windows
		await new Promise<void>((resolve, reject) => {
			let settled = false;

			proc.on("error", (err: Error & { code?: string }) => {
				if (!settled && (err.code === "ENOENT" || err.code === "EINVAL")) {
					settled = true;
					reject(
						new Error(
							`Package manager not found for: ${packageName}. ` +
								`Install Node.js or check your PATH.`,
						),
					);
				}
			});

			proc.on("exit", (code: number | null) => {
				if (!settled && code !== null) {
					settled = true;
					reject(
						new Error(
							`Package manager exited immediately for: ${packageName} (code: ${code})`,
						),
					);
				}
			});

			setTimeout(() => {
				if (!settled) {
					settled = true;
					resolve();
				}
			}, 50);
		});

		// Attach permanent error handler
		_attachErrorHandler(proc, packageName);

		return {
			process: proc,
			stdin: proc.stdin,
			stdout: proc.stdout,
			stderr: proc.stderr,
			pid: proc.pid ?? 0,
		};
	}

	// --no prevents silent download of uncached packages; user must have
	// already installed the LSP server via the interactive-install flow.
	return launchLSP("npx", ["--no", packageName, ...args], options);
}

/**
 * Spawn via Node.js directly
 */
export async function launchViaNode(
	scriptPath: string,
	args: string[] = [],
	options: SpawnOptions = {},
): Promise<LSPProcess> {
	return launchLSP(process.execPath, [scriptPath, ...args], options);
}

/**
 * Spawn via Python module
 */
export async function launchViaPython(
	moduleName: string,
	args: string[] = [],
	options: SpawnOptions = {},
): Promise<LSPProcess> {
	// On Windows, prefer 'py' launcher, fall back to 'python'
	const pythonCmd = process.platform === "win32" ? "py" : "python3";
	return launchLSP(pythonCmd, ["-m", moduleName, ...args], options);
}

/**
 * Stop an LSP process gracefully
 */
export async function stopLSP(handle: LSPProcess): Promise<void> {
	return new Promise((resolve) => {
		// Send SIGTERM first
		handle.process.kill("SIGTERM");

		// Force kill after timeout
		const timeout = setTimeout(() => {
			if (!handle.process.killed) {
				handle.process.kill("SIGKILL");
			}
		}, 5000);

		handle.process.on("exit", () => {
			clearTimeout(timeout);
			resolve();
		});

		handle.process.on("error", () => {
			clearTimeout(timeout);
			resolve();
		});
	});
}
