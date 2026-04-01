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
import path from "node:path";

export interface LSPProcess {
	process: ChildProcess;
	stdin: NodeJS.WritableStream;
	stdout: NodeJS.ReadableStream;
	stderr: NodeJS.ReadableStream;
	pid: number;
}

const isWindows = process.platform === "win32";

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
	rejectOnImmediateError?: (err: Error) => void,
): void {
	proc.on("error", (err) => {
		// Log the error but don't crash - the caller should handle this gracefully
		console.error(`[lsp] Spawn error for ${context}:`, err.message);

		// If we have a reject function and this is an immediate spawn error, reject
		if (
			rejectOnImmediateError &&
			(err as NodeJS.ErrnoException).code === "ENOENT"
		) {
			rejectOnImmediateError(err);
		}
	});

	// Also handle unexpected exit (process crash after successful spawn)
	proc.on("exit", (code, signal) => {
		if (code !== 0 && code !== null) {
			console.error(
				`[lsp] ${context} exited with code ${code}${signal ? ` (signal: ${signal})` : ""}`,
			);
		}
	});

	proc.on("close", (code, signal) => {
		if (code !== 0 && code !== null) {
			console.error(
				`[lsp] ${context} closed with code ${code}${signal ? ` (signal: ${signal})` : ""}`,
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
	const env = { ...process.env, ...options.env };

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
			const globalHasExt = /\.(exe|cmd|bat)$/i.test(spawnCommand);
			needsShell = isWindows && (spawnCommand.includes(" ") || !globalHasExt);
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
				console.error(`[lsp] Trying npm global: ${npmGlobalPath}`);
				// Recompute needsShell for npm global path
				const globalHasExt = /\.(exe|cmd|bat)$/i.test(npmGlobalPath);
				const needsShellGlobal =
					isWindows && (npmGlobalPath.includes(" ") || !globalHasExt);
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

	// For Windows and certain spawn failures, the error is async (ENOENT)
	// We need to wait a small tick to catch immediate spawn failures
	await new Promise<void>((resolve, reject) => {
		let settled = false;

		// Attach error handler that can reject for immediate errors
		proc.on("error", (err: Error & { code?: string }) => {
			if (!settled && err.code === "ENOENT") {
				settled = true;
				reject(
					new Error(
						`LSP server binary not found: ${command}. ` +
							`Install it or check your PATH.`,
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
							`The binary may be missing or corrupted.`,
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

	// Re-attach the permanent error handler now that we've passed the danger zone
	_attachErrorHandler(proc, command);

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
		const shellCommand = `npx -y ${packageName}${argsStr ? ` ${argsStr}` : ""}`;

		const cwd = String(options.cwd ?? process.cwd());
		const env = { ...process.env, ...options.env };

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
				if (!settled && err.code === "ENOENT") {
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

	return launchLSP("npx", ["-y", packageName, ...args], options);
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
