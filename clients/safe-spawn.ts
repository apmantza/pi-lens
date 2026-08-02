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

import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
	spawnSync,
} from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { logLatency } from "./latency-logger.js";
import { startSpawnUsageSampler } from "./resource-sampler.js";

export interface SpawnResourceUsage {
	sampleCount: number;
	avgCpuPercent: number;
	peakCpuPercent: number;
	avgRssBytes: number;
	peakRssBytes: number;
}

export type SpawnFailureKind = "aborted" | "timeout" | "spawn" | "signal";

export interface SpawnResult {
	stdout: string;
	stderr: string;
	status: number | null;
	error?: Error;
	/** Structured failure reason; nonzero exit statuses are not spawn failures. */
	failure?: SpawnFailureKind;
	/** True when stdout or stderr was capped before process completion. */
	outputTruncated?: boolean;
	/** Peak/average CPU%+RSS sampled across this spawn's lifetime (#620).
	 *  `undefined` when no sample ever landed (process exited faster than the
	 *  first poll tick, or sampling failed for the whole invocation) — never
	 *  read that as "zero resource usage". */
	resourceUsage?: SpawnResourceUsage;
}

export interface SafeSpawnOptions {
	timeout?: number;
	/** Absolute wall-clock deadline. The earlier of this and `timeout` wins. */
	deadlineAt?: number;
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
	/**
	 * Label recorded on the resource-usage latency.log phase entry (#620) —
	 * typically the runner/tool id (e.g. "jscpd", "knip"). Defaults to the
	 * bare command name when omitted. Purely cosmetic (log correlation); never
	 * affects spawn behavior.
	 */
	resourceLabel?: string;
	/** Maximum bytes retained across stdout and stderr for this child. */
	maxOutputBytes?: number;
	/**
	 * Couple a long-lived, side-effecting child to this Node process. Registered
	 * children are synchronously tree-killed during process exit/signals.
	 * Windows Job Objects would make this kernel-enforced, but require a native
	 * dependency; keep this dependency-free fallback until that follow-up.
	 */
	lifetimeCoupled?: boolean;
}

interface LifetimeCleanupState {
	pids: Set<number>;
	installed: boolean;
}

// Vitest reloads modules inside a reused worker. Keep this registry on the
// process so those module instances share one signal/exit listener set.
const lifetimeStateKey = Symbol.for("pi-lens.safe-spawn.lifetime-state");
const processWithLifetimeState = process as typeof process & {
	[lifetimeStateKey]?: LifetimeCleanupState;
};
const lifetimeState =
	processWithLifetimeState[lifetimeStateKey] ??
	(processWithLifetimeState[lifetimeStateKey] = {
		pids: new Set<number>(),
		installed: false,
	});

function killPidTreeSync(pid: number): void {
	if (process.platform === "win32") {
		try {
			const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
			spawnSync(taskkill, ["/F", "/T", "/PID", String(pid)], {
				shell: false,
				windowsHide: true,
				stdio: "ignore",
			});
		} catch {
			// Runs from process `exit`/signal handlers — a SYNCHRONOUS spawn throw
			// (Windows `spawn UNKNOWN`/EINVAL, the pidusage bug class, #533) would
			// become an uncaughtException during shutdown. Best-effort tree-kill:
			// swallow it, mirroring the already-guarded POSIX branch below.
		}
		return;
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Child already exited.
	}
}

function installLifetimeCleanup(): void {
	if (lifetimeState.installed) return;
	lifetimeState.installed = true;
	process.once("exit", () => {
		for (const pid of lifetimeState.pids) killPidTreeSync(pid);
	});
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as NodeJS.Signals[]) {
		process.once(signal, () => {
			for (const pid of lifetimeState.pids) killPidTreeSync(pid);
			process.kill(process.pid, signal);
		});
	}
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
 * Escape a single argument for the Windows command interpreter.
 * The result is embedded in the `/c` command string below, so metacharacters
 * must remain inside a quoted argument rather than becoming command syntax.
 */
function cmdEscapeArg(arg: string): string {
	if (!/[\s"&|<>^()]/.test(arg)) return arg;
	return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Build the cmd.exe command string used for Windows wrapper spawning.
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
// WINDOWS COMMAND RESOLUTION (#817)
//
// CodeQL flagged clients/safe-spawn.ts:192 (js/command-line-injection #17/#19,
// js/shell-command-injection-from-environment #18): the old code always routed
// EVERY Windows spawn through `cmd.exe /d /s /c <hand-built string>`, string-
// concatenating caller-tainted `command`/`args` into a shell command line.
// `%` cannot be escaped on a /c line (it expands even inside double quotes)
// and cmd's quote-state toggling can defeat `""` doubling — the escaping was
// unsound, not just a CodeQL false positive.
//
// The fix resolves `command` ourselves (a `where`-equivalent PATH + PATHEXT
// walk) and only falls back to the cmd.exe wrapper for `.cmd`/`.bat` shims,
// which cannot run without it. `.exe`/`.com` — the overwhelming majority of
// spawns (sg, biome, ruff, git, node, where.exe...) — spawn directly with
// `shell: false` and a real args array: no command line is ever built, so
// there is nothing for cmd.exe to reinterpret.
// ============================================================================

interface ResolvedWindowsCommand {
	/** Absolute path to the resolved executable. */
	resolvedPath: string;
	/** Lowercased extension including the leading dot, e.g. ".exe", ".cmd". */
	ext: string;
}

/**
 * Cached PATH + PATHEXT resolution results, keyed by
 * `${command}\0${PATH}\0${cwd}` so a changed PATH or cwd never hits a stale
 * entry. Session-lived (matches this repo's other resolution caches, e.g.
 * `clients/workspace-topology.ts`'s `resetWorkspaceTopology`) — cleared via
 * `resetSafeSpawnWindowsCommandCache()`, wired into `handleSessionStart`.
 */
const windowsCommandCache = new Map<string, ResolvedWindowsCommand | null>();

/** Reset hook for session start — see `clients/runtime-session.ts`. */
export function resetSafeSpawnWindowsCommandCache(): void {
	windowsCommandCache.clear();
}

function getPathExts(): string[] {
	const raw = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
	return raw
		.split(";")
		.map((ext) => ext.trim().toLowerCase())
		.filter(Boolean);
}

function statIsFile(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

function resolveWindowsCommandUncached(
	command: string,
	cwd: string | undefined,
): ResolvedWindowsCommand | null {
	const pathExts = getPathExts();
	const existingExt = path.extname(command).toLowerCase();
	const hasKnownExt = pathExts.includes(existingExt);

	const tryBase = (base: string): ResolvedWindowsCommand | null => {
		if (hasKnownExt) {
			return statIsFile(base) ? { resolvedPath: base, ext: existingExt } : null;
		}
		for (const ext of pathExts) {
			const candidate = base + ext;
			if (statIsFile(candidate)) return { resolvedPath: candidate, ext };
		}
		return null;
	};

	const hasPathSep = /[\\/]/.test(command);
	if (hasPathSep || path.isAbsolute(command)) {
		const base = path.isAbsolute(command)
			? command
			: path.resolve(cwd ?? process.cwd(), command);
		return tryBase(base);
	}

	const pathDirs = (process.env.PATH ?? process.env.Path ?? "").split(";");
	for (const dir of pathDirs) {
		if (!dir) continue;
		const found = tryBase(path.join(dir, command));
		if (found) return found;
	}
	return null;
}

/** Cached `where`-equivalent: resolve `command` to a real file via PATH + PATHEXT. */
function resolveWindowsCommand(
	command: string,
	cwd: string | undefined,
): ResolvedWindowsCommand | null {
	const cacheKey = `${command}\0${process.env.PATH ?? process.env.Path ?? ""}\0${cwd ?? ""}`;
	if (windowsCommandCache.has(cacheKey)) {
		return windowsCommandCache.get(cacheKey) ?? null;
	}
	const resolved = resolveWindowsCommandUncached(command, cwd);
	windowsCommandCache.set(cacheKey, resolved);
	return resolved;
}

/**
 * Characters that make a cmd.exe `/c` command line unsound to build from
 * caller-tainted input: `%`/`!` expand even inside double quotes and cannot
 * be escaped on a `/c` line (only `%%` works, and only in batch files), `"`
 * can toggle cmd's quote-parsing state past the doubling convention, and
 * CR/LF let an argument masquerade as a second command. Reject rather than
 * attempt to escape these (#817) — silent stripping would just move the
 * unsoundness, not remove it.
 */
const CMD_UNSAFE_CHARS = /["%!\r\n]/;

/** First caller-tainted value (command or an arg) that can't be safely
 * passed through the .cmd/.bat cmd.exe wrapper, or `undefined` if all clear. */
function findCmdUnsafeValue(
	command: string,
	args: string[],
): string | undefined {
	if (CMD_UNSAFE_CHARS.test(command)) return command;
	return args.find((arg) => CMD_UNSAFE_CHARS.test(arg));
}

function synthesizeEnoentError(command: string): NodeJS.ErrnoException {
	// Shaped like Node's native `spawn <cmd> ENOENT` error (message/code/
	// syscall/path) so existing `err.message.includes("ENOENT")` /
	// `err.code === "ENOENT"` call sites (e.g. sg-runner.ts, lsp/launch.ts)
	// keep working now that Windows resolution happens before spawn instead
	// of inside cmd.exe.
	const err = new Error(`spawn ${command} ENOENT`) as NodeJS.ErrnoException;
	err.code = "ENOENT";
	err.syscall = "spawn";
	err.path = command;
	return err;
}

/**
 * One-shot `chcp 65001` before the FIRST direct (.exe/.com) Windows spawn.
 *
 * Mechanism: `chcp` mutates the code page of the console the current process
 * is attached to, and that mutation persists for the console's lifetime —
 * it is not per-child-process state. The old cmd.exe-wrapper path re-ran
 * `chcp 65001 >nul 2>&1 &&` on every single spawn, which was always
 * redundant after the first call; memoizing here (module-level, once per
 * process) is a strict improvement, not a behavior change. Runs through a
 * tiny pinned cmd.exe spawn (same `%SystemRoot%\System32\cmd.exe` pin as
 * `killTree` below) with a static, hardcoded command string — no caller-
 * tainted data anywhere near it.
 */
let utf8ConsoleCodePageApplied = false;

function ensureUtf8ConsoleCodePageOnce(): void {
	if (utf8ConsoleCodePageApplied) return;
	utf8ConsoleCodePageApplied = true;
	try {
		const cmdExe = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`;
		spawnSync(cmdExe, ["/d", "/s", "/c", "chcp 65001 >nul 2>&1"], {
			shell: false,
			windowsHide: true,
		});
	} catch {
		// Best-effort: worst case is non-ASCII tool output mis-decoded, not a
		// spawn failure — never let this block the real spawn.
	}
}

/** Test-only: allow tests to force the chcp one-shot to run again. */
export function resetUtf8ConsoleCodePageStateForTests(): void {
	utf8ConsoleCodePageApplied = false;
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
	const configuredTimeout =
		options?.timeout !== undefined &&
		Number.isFinite(options.timeout) &&
		options.timeout >= 0
			? options.timeout
			: 30000;
	const deadlineRemaining =
		options?.deadlineAt !== undefined && Number.isFinite(options.deadlineAt)
			? options.deadlineAt - Date.now()
			: Number.POSITIVE_INFINITY;
	const timeout = Math.max(0, Math.min(configuredTimeout, deadlineRemaining));
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
				failure: "aborted",
			});
			return;
		}
		if (timeout <= 0) {
			resolve({
				stdout: "",
				stderr: "",
				status: null,
				error: new Error(`Process timed out after ${timeout}ms`),
				failure: "timeout",
			});
			return;
		}

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		let killed = false;
		let outputTruncated = false;
		const maxOutputBytes =
			options?.maxOutputBytes !== undefined &&
			Number.isFinite(options.maxOutputBytes) &&
			options.maxOutputBytes > 0
				? Math.floor(options.maxOutputBytes)
				: undefined;
		const appendOutput = (current: string, chunk: string | Buffer): string => {
			const text = typeof chunk === "string" ? chunk : chunk.toString();
			if (maxOutputBytes === undefined) return current + text;
			const used = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
			const remaining = maxOutputBytes - used;
			if (remaining <= 0) {
				outputTruncated = true;
				return current;
			}
			const bytes = Buffer.byteLength(text);
			if (bytes <= remaining) return current + text;
			outputTruncated = true;
			return current + Buffer.from(text).subarray(0, remaining).toString();
		};

		// Spawn the process (non-blocking). Keeping Node's `shell` option false
		// is important on every path here: shell:true concatenates tainted
		// arguments into a command line before spawning (CodeQL #17 / CWE-78).
		//
		// On Windows (#817): resolve `command` ourselves (PATH + PATHEXT walk,
		// cached) instead of always routing through cmd.exe.
		//   - .exe/.com  → spawn the resolved path directly, args stay a real
		//     array, no shell involved at all (injection-proof).
		//   - .cmd/.bat  → these are scripts cmd.exe must interpret (npm shims
		//     are the common case), so keep the wrapper, but pin the
		//     interpreter to %SystemRoot%\System32\cmd.exe (never trust
		//     ComSpec — CodeQL #18) and VALIDATE args instead of trying to
		//     escape them: reject anything containing `"`, `%`, `!`, or CR/LF
		//     rather than spawn with an unsound escape.
		//   - unresolvable → synthesize an ENOENT-shaped error instead of
		//     letting cmd.exe report "not recognized" from inside a shell.
		const isWindows = process.platform === "win32";
		let spawnCmd = command;
		let spawnArgs = args;
		let windowsVerbatimArguments = false;
		let resolutionError: Error | undefined;

		if (isWindows) {
			const resolved = resolveWindowsCommand(command, options?.cwd);
			if (!resolved) {
				resolutionError = synthesizeEnoentError(command);
			} else if (resolved.ext === ".cmd" || resolved.ext === ".bat") {
				// Validate the RESOLVED path (what actually gets interpolated
				// into the /c line via buildWindowsShellCommand below), not the
				// caller's original `command` string — a resolved path
				// containing `%`/`!` would otherwise reach the shell unvalidated.
				const unsafeValue = findCmdUnsafeValue(resolved.resolvedPath, args);
				if (unsafeValue !== undefined) {
					resolutionError = new Error(
						`Refusing to spawn "${resolved.resolvedPath}" via cmd.exe: ` +
							`${JSON.stringify(unsafeValue)} contains a character ("` +
							`, %, !, or CR/LF) that cannot be safely escaped on a ` +
							`cmd.exe /c command line (CWE-78, #817). Rename/quote the ` +
							"value or invoke the tool without going through cmd.exe.",
					);
				} else {
					// Pin the interpreter — never trust ComSpec/COMSPEC (#18): an
					// env-controlled ComSpec could point anywhere.
					spawnCmd = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`;
					spawnArgs = [
						"/d",
						"/s",
						"/c",
						buildWindowsShellCommand(resolved.resolvedPath, args),
					];
					// The `/c` payload is already quoted by buildWindowsShellCommand.
					// Prevent Node from escaping those quotes a second time when it
					// builds cmd.exe's Windows command line.
					windowsVerbatimArguments = true;
				}
			} else {
				// .exe / .com: direct spawn, no cmd.exe anywhere in the picture.
				ensureUtf8ConsoleCodePageOnce();
				spawnCmd = resolved.resolvedPath;
				spawnArgs = args;
			}
		}

		if (resolutionError) {
			resolve({
				stdout: "",
				stderr: "",
				status: null,
				error: resolutionError,
				failure: "spawn",
			});
			return;
		}

		let child: ChildProcess;
		try {
			child = spawn(spawnCmd, spawnArgs, {
				cwd: options?.cwd,
				env: { ...process.env, ...options?.env },
				windowsHide: true,
				shell: false,
				windowsVerbatimArguments,
			});
		} catch (err) {
			// A SYNCHRONOUS spawn throw (Windows `spawn UNKNOWN`/EINVAL — the
			// pidusage bug class, #533) must NOT reject this Promise: every caller
			// relies on safeSpawnAsync never rejecting (they inspect result.error),
			// and many invoke it fire-and-forget in best-effort/background paths, so
			// a rejection here could surface as an unhandledRejection that crashes
			// the host. Resolve the failure gracefully instead — same contract as an
			// asynchronously-emitted `'error'` event (handled below).
			resolve({
				stdout: "",
				stderr: "",
				status: null,
				error: err instanceof Error ? err : new Error(String(err)),
				failure: "spawn",
			});
			return;
		}
		if (options?.lifetimeCoupled && child.pid) {
			installLifetimeCleanup();
			lifetimeState.pids.add(child.pid);
		}

		// #620: bracket this spawn's lifetime with a short-interval CPU/RSS poll
		// (started right here, stopped in the "close" handler below) so transient
		// analyzer children (jscpd, knip, madge, gitleaks, etc.) — which live too
		// briefly for heartbeat-cadence sampling to reliably catch — still get a
		// peak/average resource reading. `startSpawnUsageSampler` itself is
		// best-effort/never-throws by design, but this call site wraps it anyway
		// (belt and suspenders: the sampling seam must never be the reason a real
		// spawn fails) with a no-op fallback sampler.
		let usageSampler: { stop: () => SpawnResourceUsage | null };
		try {
			usageSampler = startSpawnUsageSampler(child.pid);
		} catch {
			usageSampler = { stop: () => null };
		}
		const resourceLabel = options?.resourceLabel ?? command;

		// On Windows, shell:true means child.pid is cmd.exe — child.kill() only
		// kills the wrapper, leaving the actual subprocess (e.g. knip/npx) alive
		// as an orphan. Use taskkill /F /T to kill the full process tree instead.
		const killTree = async (): Promise<void> => {
			if (isWindows && child.pid && child.pid > 0) {
				const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
				try {
					await new Promise<void>((done) => {
						const killer = spawn(
							taskkill,
							["/F", "/T", "/PID", String(child.pid)],
							{
								shell: false,
								windowsHide: true,
								stdio: "ignore",
							},
						);
						killer.once("close", () => done());
						killer.once("error", () => {
							child.kill("SIGKILL");
							done();
						});
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
			aborted = true;
			if (!killed && !child.killed) {
				killed = true;
				void killTree();
			}
		};
		abortSignal?.addEventListener("abort", onAbort, { once: true });

		// Output-cap kills are awaited by the close handler below, just like
		// timeout/abort kills. This keeps a noisy CLI from continuing in the
		// background after its retained output has been bounded.
		let killPromise: Promise<void> | undefined;
		const stopForOutputLimit = (): void => {
			if (outputTruncated && !killed && !child.killed) {
				killed = true;
				killPromise = killTree();
			}
		};

		// Collect output
		child.stdout?.setEncoding("utf-8");
		child.stderr?.setEncoding("utf-8");
		child.stdout?.on("data", (data) => {
			stdout = appendOutput(stdout, data);
			stopForOutputLimit();
		});
		child.stderr?.on("data", (data) => {
			stderr = appendOutput(stderr, data);
			stopForOutputLimit();
		});

		// Timeout handling - KILL the process, don't just abandon it
		const timeoutId = setTimeout(() => {
			timedOut = true;
			if (!killed && !child.killed) {
				killed = true;
				killPromise = killTree();
			}
		}, timeout);

		// #620: stop the poll and log peak/average CPU%+RSS for this invocation
		// into the existing per-runner latency.log phase entries — best-effort,
		// wrapped so a logging hiccup can never affect the resolved SpawnResult.
		const finishResourceUsage = (): SpawnResourceUsage | undefined => {
			const summary = usageSampler.stop();
			if (!summary) return undefined;
			try {
				logLatency({
					type: "phase",
					phase: "spawn_resource_usage",
					filePath: "",
					durationMs: 0,
					metadata: {
						command: resourceLabel,
						...summary,
					},
				});
			} catch {
				// best-effort logging only
			}
			return summary;
		};

		// Process completion
		child.on("close", async (code, signal) => {
			clearTimeout(timeoutId);
			abortSignal?.removeEventListener("abort", onAbort);
			if (child.pid) lifetimeState.pids.delete(child.pid);
			await killPromise;
			const resourceUsage = finishResourceUsage();

			const outputInfo = outputTruncated ? { outputTruncated: true } : {};
			if (timedOut) {
				resolve({
					stdout,
					stderr,
					status: null,
					error: new Error(
						`Process timed out after ${timeout}ms (killed with ${signal || "SIGTERM"})`,
					),
					failure: "timeout",
					...outputInfo,
					resourceUsage,
				});
			} else if (aborted) {
				resolve({
					stdout,
					stderr,
					status: null,
					error: new Error("Spawn aborted"),
					failure: "aborted",
					...outputInfo,
					resourceUsage,
				});
			} else if (signal) {
				resolve({
					stdout,
					stderr,
					status: null,
					error: new Error(`Process killed by signal: ${signal}`),
					failure: "signal",
					...outputInfo,
					resourceUsage,
				});
			} else {
				resolve({ stdout, stderr, status: code, ...outputInfo, resourceUsage });
			}
		});

		child.on("error", (err) => {
			clearTimeout(timeoutId);
			abortSignal?.removeEventListener("abort", onAbort);
			if (child.pid) lifetimeState.pids.delete(child.pid);
			const resourceUsage = finishResourceUsage();
			let failure: SpawnFailureKind = "spawn";
			if (aborted) failure = "aborted";
			else if (timedOut) failure = "timeout";
			resolve({
				stdout,
				stderr,
				status: null,
				error: err,
				failure,
				...(outputTruncated ? { outputTruncated: true } : {}),
				resourceUsage,
			});
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
 * ⚠️ DEPRECATED: Use safeSpawnAsync instead.
 *
 * This blocks the entire Node.js event loop until the process exits.
 * If the process hangs, pi will freeze.
 *
 * Kept for backward compatibility during migration (today's only caller:
 * `test-runner-client.ts`'s synchronous pytest-on-PATH probe, called from a
 * sync detection path with many sync callers/tests — not a trivial async
 * migration, see #817 follow-up discussion).
 *
 * #817: the Windows branch used to build a `cmd.exe`/`shell:true` command
 * line from unvalidated caller input (CodeQL #17/#18/#19), same unsoundness
 * as the async version had. It now shares the exact same resolution/
 * validation seams as `safeSpawnAsync` — `resolveWindowsCommand` (cached
 * PATH+PATHEXT walk), direct `spawnSync(resolvedPath, args, { shell: false })`
 * for `.exe`/`.com`, the pinned-cmd.exe wrapper + `findCmdUnsafeValue`
 * rejection for `.cmd`/`.bat`, and a synthesized ENOENT when unresolvable.
 * No `shell: true` anywhere.
 */
export function safeSpawn(
	command: string,
	args: string[],
	options?: SafeSpawnOptions,
): SpawnResult {
	if (process.platform === "win32") {
		const resolved = resolveWindowsCommand(command, options?.cwd);
		if (!resolved) {
			return {
				stdout: "",
				stderr: "",
				status: null,
				error: synthesizeEnoentError(command),
			};
		}

		let spawnCmd: string;
		let spawnArgs: string[];
		let windowsVerbatimArguments = false;

		if (resolved.ext === ".cmd" || resolved.ext === ".bat") {
			// Validate the value that actually gets interpolated into the /c
			// line — the RESOLVED path, not the caller's original (possibly
			// extensionless) `command` string — plus every arg.
			const unsafeValue = findCmdUnsafeValue(resolved.resolvedPath, args);
			if (unsafeValue !== undefined) {
				return {
					stdout: "",
					stderr: "",
					status: null,
					error: new Error(
						`Refusing to spawn "${resolved.resolvedPath}" via cmd.exe: ` +
							`${JSON.stringify(unsafeValue)} contains a character ("` +
							`, %, !, or CR/LF) that cannot be safely escaped on a ` +
							`cmd.exe /c command line (CWE-78, #817). Rename/quote the ` +
							"value or invoke the tool without going through cmd.exe.",
					),
				};
			}
			spawnCmd = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`;
			spawnArgs = [
				"/d",
				"/s",
				"/c",
				buildWindowsShellCommand(resolved.resolvedPath, args),
			];
			windowsVerbatimArguments = true;
		} else {
			ensureUtf8ConsoleCodePageOnce();
			spawnCmd = resolved.resolvedPath;
			spawnArgs = args;
		}

		const result = spawnSync(spawnCmd, spawnArgs, {
			...(options as SpawnOptions),
			encoding: "utf-8",
			shell: false,
			windowsHide: true,
			windowsVerbatimArguments,
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
