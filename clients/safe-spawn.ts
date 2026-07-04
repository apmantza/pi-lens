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
	/**
	 * Opt out of the ambient turn abort signal (which is otherwise the default).
	 * Set this for long, side-effecting operations like tool installs that should
	 * run to completion even if the agent turn is interrupted — matching the old
	 * uncancellable sync `safeSpawn` they replaced (so a half-finished
	 * `gem install` / `go install` can't be left behind by an Esc). An explicit
	 * `signal` still takes precedence over both.
	 */
	ignoreAmbientSignal?: boolean;
}

// ============================================================================
// AMBIENT TURN ABORT SIGNAL
// ============================================================================

/**
 * The current turn's abort signal, published by the lifecycle handlers from
 * pi's `ctx.signal`. Threading the signal explicitly through every
 * dispatch → runner → spawn call site would be invasive, so instead
 * `safeSpawnAsync` defaults to this ambient signal when a call doesn't pass its
 * own. The effect: pressing Esc mid-turn aborts in-flight linter / formatter /
 * type-checker child processes (process-tree kill on Windows) instead of letting
 * them run to their timeout.
 *
 * Each spawn captures the signal at call time (attaching its own abort listener),
 * so clearing this after a handler returns only affects *future* spawns — work
 * already in flight keeps the signal it started with.
 */
let ambientAbortSignal: AbortSignal | undefined;

/** Publish (or clear, with `undefined`) the current turn's abort signal. */
export function setAmbientAbortSignal(signal: AbortSignal | undefined): void {
	ambientAbortSignal = signal;
}

/**
 * The current turn's abort signal, for in-process awaits that aren't child
 * spawns (e.g. an LSP JSON-RPC write that can backpressure on a wedged server).
 * Child spawns read the ambient signal internally; this getter lets the
 * interactive pipeline honor Escape on non-spawn LSP calls too.
 */
export function getAmbientAbortSignal(): AbortSignal | undefined {
	return ambientAbortSignal;
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

/**
 * Build the cmd.exe command string used for Windows `shell:true` spawning.
 *
 * The COMMAND must be escaped the same way as the args — escaping only the args
 * (the bug behind #214) means a tool whose resolved path contains a space (e.g.
 * `C:\Program Files\Go\bin\go.exe`) makes cmd.exe parse `C:\Program` as the
 * command and fail with "'C:\Program' is not recognized". `cmdEscapeArg` is a
 * no-op for space-free commands, so this is safe for the npm/.pi-lens tool paths
 * that already worked. The `chcp 65001` prefix forces the UTF-8 code page (so
 * tool output isn't mangled by the system code page) and, as a side benefit,
 * keeps the (possibly quoted) command off the front of the line, avoiding
 * cmd.exe's `/s` outer-quote-stripping quirk.
 */
export function buildWindowsShellCommand(
	command: string,
	args: string[],
): string {
	return `chcp 65001 >nul 2>&1 && ${[command, ...args].map(cmdEscapeArg).join(" ")}`;
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
	// Fall back to the current turn's ambient signal (set from ctx.signal) so an
	// Esc/abort mid-turn cancels dispatches that didn't thread a signal of their
	// own — unless the caller opts out (installs, which must run to completion).
	const abortSignal =
		options?.signal ??
		(options?.ignoreAmbientSignal ? undefined : ambientAbortSignal);

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
		// On Windows, prefix with `chcp 65001` to force UTF-8 code page for the
		// cmd.exe session. Without this, tools that output UTF-8 (sg, biome, ruff,
		// etc.) have their bytes decoded as the system code page (CP850/CP1252/
		// CP936/CP932), producing garbled characters in stderr error messages.
		const spawnCmd = isWindows
			? buildWindowsShellCommand(command, args)
			: command;
		const spawnArgs = isWindows ? [] : args;
		const child = spawn(spawnCmd, spawnArgs, {
			cwd: options?.cwd,
			env: { ...process.env, ...options?.env },
			windowsHide: true,
			shell: isWindows,
		});

		// On Windows, shell:true means child.pid is cmd.exe — child.kill() only
		// kills the wrapper, leaving the actual subprocess (e.g. knip/npx) alive
		// as an orphan. Use taskkill /F /T to kill the full process tree instead.
		const killTree = () => {
			if (isWindows && child.pid && child.pid > 0) {
				const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
				try {
					spawn(taskkill, ["/F", "/T", "/PID", String(child.pid)], {
						shell: false,
						windowsHide: true,
					});
				} catch {
					child.kill("SIGKILL");
				}
			} else {
				child.kill("SIGTERM");
				setTimeout(() => {
					if (!child.killed) child.kill("SIGKILL");
				}, 1000);
			}
		};

		// Handle abort signal
		const onAbort = () => {
			if (!killed && !child.killed) {
				killed = true;
				killTree();
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
				killTree();
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
