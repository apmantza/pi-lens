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
	spawn as nodeSpawn,
	type SpawnOptions,
} from "node:child_process";
import path from "node:path";

export interface LSPProcess {
	process: ChildProcess;
	stdin: NodeJS.WritableStream;
	stdout: NodeJS.ReadableStream;
	stderr: NodeJS.ReadableStream;
	pid: number;
}

// Helper to detect if running on Windows
const isWindows = process.platform === "win32";

/**
 * Attach error handler to a spawned process to prevent ENOENT crashes
 * This catches "command not found" errors and other spawn failures
 */
function _attachErrorHandler(proc: ChildProcess, context: string): void {
	proc.on("error", (err) => {
		// Log the error but don't crash - the caller should handle this gracefully
		console.error(`[lsp] Spawn error for ${context}:`, err.message);
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
 *
 * @param command - Command to run (e.g., "typescript-language-server")
 * @param args - Arguments (e.g., ["--stdio"])
 * @param options - Spawn options including cwd, env
 * @returns LSPProcess handle
 */
export function launchLSP(
	command: string,
	args: string[] = [],
	options: SpawnOptions = {},
): LSPProcess {
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

	// On Windows with shell: true, we need to quote the command if it has spaces
	const needsShell =
		isWindows &&
		(resolvedCommand.includes(" ") || resolvedCommand.includes(".cmd"));

	let proc: ChildProcess;

	if (needsShell) {
		// Use shell mode with quoted command
		const shellCommand = `"${resolvedCommand}" ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`;
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
		proc = nodeSpawn(resolvedCommand, args, {
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

	// Attach error handler to prevent ENOENT crashes and track later failures
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
export function launchViaPackageManager(
	packageName: string,
	args: string[] = [],
	options: SpawnOptions = {},
): LSPProcess {
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

		// Attach error handler to prevent ENOENT crashes
		_attachErrorHandler(proc, packageName);

		return {
			process: proc,
			stdin: proc.stdin!,
			stdout: proc.stdout!,
			stderr: proc.stderr!,
			pid: proc.pid ?? 0,
		};
	}

	return launchLSP("npx", ["-y", packageName, ...args], options);
}

/**
 * Spawn via Node.js directly
 */
export function launchViaNode(
	scriptPath: string,
	args: string[] = [],
	options: SpawnOptions = {},
): LSPProcess {
	return launchLSP(process.execPath, [scriptPath, ...args], options);
}

/**
 * Spawn via Python module
 */
export function launchViaPython(
	moduleName: string,
	args: string[] = [],
	options: SpawnOptions = {},
): LSPProcess {
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
