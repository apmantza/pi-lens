/**
 * Safe cross-platform spawn utilities
 *
 * Provides both sync (deprecated) and async versions for gradual migration.
 *
 * Async version features:
 * - Non-blocking execution
 * - Proper process cleanup on timeout (no zombies)
 * - Batch execution with concurrency limits
 * - AbortSignal support for cancellation
 *
 * Migration guide:
 * - Change: safeSpawn(cmd, args, opts)
 * - To: await safeSpawnAsync(cmd, args, opts)
 */

import { type SpawnOptions, spawn, spawnSync } from "node:child_process";

export interface SpawnResult {
	stdout: string;
	stderr: string;
	status: number | null;
	error?: Error;
}

export interface SafeSpawnOptions {
	timeout?: number;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/**
 * Escape a single argument for cmd.exe when shell:true is required.
 * Only used on Windows to avoid DEP0190 (args+shell concatenation warning).
 */
function cmdEscapeArg(arg: string): string {
	if (!/[\s"&|<>^()]/.test(arg)) return arg;
	return `"${arg.replace(/"/g, '""')}"`;
}

// ============================================================================
// ASYNC VERSION (Recommended - Non-blocking)
// ============================================================================

/**
 * Async spawn with timeout and proper process cleanup.
 *
 * Unlike spawnSync, this:
 * - Doesn't block the event loop
 * - Kills the process on timeout (preventing zombies)
 * - Supports cancellation via AbortSignal
 *
 * @example
 * const result = await safeSpawnAsync("npm", ["test"], { timeout: 30000 });
 * if (result.error) console.error("Failed:", result.error);
 */
export async function safeSpawnAsync(
	command: string,
	args: string[],
	options?: SafeSpawnOptions,
): Promise<SpawnResult> {
	const timeout = options?.timeout ?? 30000;
	const abortSignal = options?.signal;

	return new Promise((resolve) => {
		// Check for early abort
		if (abortSignal?.aborted) {
			resolve({
				stdout: "",
				stderr: "",
				status: null,
				error: new Error("Spawn aborted before start"),
			});
			return;
		}

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let killed = false;

		// Spawn the process (non-blocking)
		// On Windows, use shell mode for .cmd files (like pyright, biome).
		// Bake args into the command string when shell:true to avoid DEP0190.
		const isWindows = process.platform === "win32";
		const spawnCmd = isWindows
			? [command, ...args.map(cmdEscapeArg)].join(" ")
			: command;
		const spawnArgs = isWindows ? [] : args;
		const child = spawn(spawnCmd, spawnArgs, {
			cwd: options?.cwd,
			env: { ...process.env, ...options?.env },
			windowsHide: true,
			shell: isWindows,
		});

		// Handle abort signal
		const onAbort = () => {
			if (!killed && !child.killed) {
				killed = true;
				child.kill("SIGTERM");
				// Force kill after 1s if still running
				setTimeout(() => {
					if (!child.killed) {
						child.kill("SIGKILL");
					}
				}, 1000);
			}
		};
		abortSignal?.addEventListener("abort", onAbort, { once: true });

		// Collect output
		child.stdout?.setEncoding("utf-8");
		child.stderr?.setEncoding("utf-8");
		child.stdout?.on("data", (data) => (stdout += data));
		child.stderr?.on("data", (data) => (stderr += data));

		// Timeout handling - KILL the process, don't just abandon it
		const timeoutId = setTimeout(() => {
			timedOut = true;
			if (!killed && !child.killed) {
				killed = true;
				child.kill("SIGTERM");
				// Force kill after 1s grace period
				setTimeout(() => {
					if (!child.killed) {
						child.kill("SIGKILL");
					}
				}, 1000);
			}
		}, timeout);

		// Process completion
		child.on("close", (code, signal) => {
			clearTimeout(timeoutId);
			abortSignal?.removeEventListener("abort", onAbort);

			if (timedOut) {
				resolve({
					stdout,
					stderr,
					status: null,
					error: new Error(
						`Process timed out after ${timeout}ms (killed with ${signal || "SIGTERM"})`,
					),
				});
			} else if (signal) {
				resolve({
					stdout,
					stderr,
					status: null,
					error: new Error(`Process killed by signal: ${signal}`),
				});
			} else {
				resolve({ stdout, stderr, status: code });
			}
		});

		child.on("error", (err) => {
			clearTimeout(timeoutId);
			abortSignal?.removeEventListener("abort", onAbort);
			resolve({ stdout, stderr, status: null, error: err });
		});
	});
}

/**
 * Run multiple commands concurrently with limited concurrency.
 *
 * This prevents resource contention when running many linters.
 * Uses async spawn with concurrency limiting built-in.
 *
 * @example
 * const results = await safeSpawnBatch([
 *   { command: "biome", args: ["check", "file.ts"] },
 *   { command: "ruff", args: ["check", "file.py"] },
 * ], 3); // Max 3 concurrent
 */
export async function safeSpawnBatch(
	commands: Array<{
		command: string;
		args: string[];
		options?: SafeSpawnOptions;
	}>,
	concurrency = 3,
): Promise<SpawnResult[]> {
	const results: SpawnResult[] = [];

	// Process in batches to limit concurrent processes
	for (let i = 0; i < commands.length; i += concurrency) {
		const batch = commands.slice(i, i + concurrency);
		const batchResults = await Promise.all(
			batch.map(({ command, args, options }) =>
				safeSpawnAsync(command, args, options),
			),
		);
		results.push(...batchResults);
	}

	return results;
}

/**
 * Check if a command is available in PATH (async version)
 */
export async function isCommandAvailableAsync(
	command: string,
): Promise<boolean> {
	const finder = process.platform === "win32" ? "where" : "which";
	const result = await safeSpawnAsync(finder, [command], { timeout: 5000 });
	return result.status === 0 && !result.error;
}

/**
 * Find the full path to a command (async version)
 */
export async function findCommandAsync(
	command: string,
): Promise<string | null> {
	const finder = process.platform === "win32" ? "where" : "which";
	const result = await safeSpawnAsync(finder, [command], { timeout: 5000 });

	if (result.status !== 0 || result.error) return null;

	// Take first line (first match)
	return result.stdout.trim().split("\n")[0] || null;
}

// ============================================================================
// SYNC VERSION (Deprecated - Blocking, for backward compatibility)
// ============================================================================

/**
 * Escape an argument for Windows shell execution.
 * Handles spaces, quotes, $variables, and special characters.
 */
function escapeWindowsArg(arg: string): string {
	if (arg.includes("$")) {
		return `'${arg.replace(/'/g, "'\\''")}'`;
	}
	if (!/[\s"]/.test(arg)) return arg;
	return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Construct a command string for Windows shell execution.
 */
function buildWindowsCommand(command: string, args: string[]): string {
	const escapedArgs = args.map(escapeWindowsArg).join(" ");
	return `${command} ${escapedArgs}`;
}

/**
 * ⚠️ DEPRECATED: Use safeSpawnAsync instead.
 *
 * This blocks the entire Node.js event loop until the process exits.
 * If the process hangs, pi will freeze.
 *
 * Kept for backward compatibility during migration.
 */
export function safeSpawn(
	command: string,
	args: string[],
	options?: SafeSpawnOptions,
): SpawnResult {
	if (process.platform === "win32") {
		// shell:true here is justified only because this deprecated sync function
		// predates safeSpawnAsync. It will be eliminated when safeSpawn is removed.
		const fullCommand = buildWindowsCommand(command, args);
		const result = spawnSync(fullCommand, {
			...(options as SpawnOptions),
			encoding: "utf-8",
			shell: true,
			windowsHide: true,
		});

		return {
			stdout: result.stdout?.toString() || "",
			stderr: result.stderr?.toString() || "",
			status: result.status,
			error: result.error,
		};
	}

	const result = spawnSync(command, args, {
		...(options as SpawnOptions),
		encoding: "utf-8",
		shell: false,
		windowsHide: true,
	});

	return {
		stdout: result.stdout?.toString() || "",
		stderr: result.stderr?.toString() || "",
		status: result.status,
		error: result.error,
	};
}

/**
 * Check if a command is available in PATH (sync version - deprecated)
 * @deprecated Use isCommandAvailableAsync
 */
export function isCommandAvailable(command: string): boolean {
	const result = safeSpawn(
		process.platform === "win32" ? "where" : "which",
		[command],
		{ timeout: 5000 },
	);
	return result.status === 0;
}

/**
 * Find the full path to a command (sync version - deprecated)
 * @deprecated Use findCommandAsync
 */
export function findCommand(command: string): string | null {
	const finder = process.platform === "win32" ? "where" : "which";
	const result = safeSpawn(finder, [command], { timeout: 5000 });

	if (result.status !== 0) return null;

	return result.stdout.trim().split("\n")[0] || null;
}
