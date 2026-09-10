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
import { BoundedFifoMap } from "./bounded-cache.js";
import { logLatency } from "./latency-logger.js";
import { recordDegradation } from "./degradation-ledger.js";
import { logExtension } from "./extension-log.js";
import { isFullyQualifiedWin32 } from "./path-utils.js";
import { startSpawnUsageSampler } from "./resource-sampler.js";
import { compareOrdinal } from "./string-utils.js";

export interface SpawnResourceUsage {
	sampleCount: number;
	avgCpuPercent: number;
	peakCpuPercent: number;
	avgRssBytes: number;
	peakRssBytes: number;
}

export type SpawnFailureKind = "aborted" | "timeout" | "spawn" | "signal";

export type SpawnFailureType =
	| "tool-not-found"
	| "cwd-unresolvable"
	| "permission-denied"
	| "spawn-failed"
	| "timeout"
	| "killed";

/** Intent-level spawn failure. `cause` retains the original OS Error/errno. */
export class SpawnFailureError extends Error {
	readonly name = "SpawnFailureError";

	constructor(
		readonly kind: SpawnFailureType,
		message: string,
		readonly cause: Error,
	) {
		super(message, { cause });
	}
}

export function hasSpawnFailureKind(
	error: unknown,
	kind: SpawnFailureType,
): boolean {
	return (
		error instanceof Error &&
		"kind" in error &&
		(error as { kind?: unknown }).kind === kind
	);
}

/**
 * #2010: derive teardown evidence from observed timestamps.
 *
 * Pure by design so every branch is deterministically unit-testable,
 * including the natural-exit-at-budget-expiry race where the timeout
 * callback arms a kill against an already-dead child.
 *
 * - No recorded kill start (the guard saw the child already dying), no
 *   observed death at all, or death PREDATING the kill start: the child
 *   left on its own -> "exited", ms 0. Claiming a kill we cannot
 *   distinguish from a natural exit would be invented evidence.
 * - Death observed after the kill started: "escalate-kill" when the
 *   SIGKILL escalation fired, otherwise "killed-by-signal"; ms is the
 *   observed gap (floor 0 - clock jitter must never produce a negative).
 */
export function resolveTeardownOutcome(input: {
	killStartedAtMs?: number;
	deathObservedAtMs?: number;
	escalated: boolean;
}):
	| {
			ms: number;
			outcome: "exited" | "killed-by-signal" | "escalate-kill";
	  }
	| undefined {
	// Another path (abort / output-limit) owns this death: emitting teardown
	// evidence here would describe a kill this timeout didn't perform.
	if (
		input.killStartedAtMs === undefined ||
		input.deathObservedAtMs === undefined
	) {
		return undefined;
	}
	// True natural-exit race: the child beat the budget-expired kill by a
	// hair - death observed before (or exactly at) the kill start.
	if (input.deathObservedAtMs <= input.killStartedAtMs) {
		return { ms: 0, outcome: "exited" };
	}
	return {
		ms: Math.max(0, input.deathObservedAtMs - input.killStartedAtMs),
		outcome: input.escalated ? "escalate-kill" : "killed-by-signal",
	};
}

export interface SpawnResult {
	stdout: string;
	stderr: string;
	status: number | null;
	/**
	 * The signal that killed the child, when one did (#1816). Before this the
	 * signal name lived only inside `error.message`, so no caller could name it
	 * and every ledger reason rendered a SIGKILLed tool indistinguishably from
	 * a clean exit. Absent for a normally-exited process.
	 */
	signal?: NodeJS.Signals;
	error?: Error;
	/** Typed spawn-boundary failure; nonzero tool exits do not populate it. */
	spawnFailure?: SpawnFailureError;
	/** Structured failure reason; nonzero exit statuses are not spawn failures. */
	failure?: SpawnFailureKind;
	/**
	 * #2010: how the process tree died after the spawn's OWN timeout budget
	 * expired - present on that path only. `ms` is wall-clock from budget
	 * expiry to observed tree death, measured separately from the budget so
	 * a slow teardown is visible rather than folded into "how long the tool
	 * ran". `outcome`: the child beat the signal ("exited"), the first
	 * signal ended it ("killed-by-signal"), or the SIGKILL escalation fired
	 * ("escalate-kill"). Platform note: on Windows taskkill /F is always
	 * forceful and arms no escalation timer, so "escalate-kill" is
	 * POSIX-only; forced Windows kills report "killed-by-signal" despite no
	 * signal being delivered - the name describes the semantic tier
	 * (first-tier vs escalated force), not the OS mechanism.
	 */
	timeoutTeardown?: {
		ms: number;
		outcome: "exited" | "killed-by-signal" | "escalate-kill";
	};
	/** True when stdout or stderr was capped before process completion. */
	outputTruncated?: boolean;
	/** True when the output cap started terminating the child. */
	killedForOutputCap?: boolean;
	/** True when the optional streaming matcher saw a matching chunk. */
	streamingMatch?: boolean;
	/** Peak/average CPU%+RSS sampled across this spawn's lifetime (#620).
	 *  `undefined` when no sample ever landed (process exited faster than the
	 *  first poll tick, or sampling failed for the whole invocation) — never
	 *  read that as "zero resource usage". */
	resourceUsage?: SpawnResourceUsage;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function errorCode(error: Error): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}

async function cwdIsUnresolvable(cwd: string | undefined): Promise<boolean> {
	if (cwd === undefined) return false;
	try {
		return !(await fs.promises.stat(cwd)).isDirectory();
	} catch {
		return true;
	}
}

function cwdIsUnresolvableSync(cwd: string | undefined): boolean {
	if (cwd === undefined) return false;
	try {
		return !fs.statSync(cwd).isDirectory();
	} catch {
		return true;
	}
}

/**
 * Best-effort presence probe used ONLY to disambiguate ENOENT when the cwd is
 * ALSO unresolvable (#1340 review): a genuinely missing tool must classify as
 * tool-not-found even under a broken cwd, or auto-install can never repair it.
 * Absolute commands are probed directly (with PATHEXT variants on Windows);
 * bare names scan PATH. A relative-with-separator command under a broken cwd
 * is genuinely ambiguous -- we err toward cwd-unresolvable there, because
 * repairing the cwd is actionable while a reinstall loop (#1199) is not.
 */
function commandProbablyPresent(command: string): boolean | "ambiguous" {
	const exts =
		process.platform === "win32"
			? [
					"",
					...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
						.split(";")
						.filter(Boolean),
				]
			: [""];
	const existsWithExt = (base: string): boolean => {
		for (const ext of exts) {
			try {
				if (fs.existsSync(base + ext)) return true;
			} catch {
				// unreadable candidate -- keep probing
			}
		}
		return false;
	};
	if (path.isAbsolute(command)) return existsWithExt(command);
	if (command.includes("/") || command.includes("\\")) return "ambiguous";
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (dir && existsWithExt(path.join(dir, command))) return true;
	}
	return false;
}

/**
 * Shared errno->bucket mapping. `cwdUnresolvable` is the only async-vs-sync
 * difference between the two public classifiers, so it arrives as a resolved
 * flag and everything else lives once (Sonar duplication finding, #1340).
 */
function classifyWithCwdFlag(
	cause: Error,
	options: { command: string; cwd?: string },
	cwdUnresolvable: boolean,
): SpawnFailureError {
	const code = errorCode(cause);
	let failure: SpawnFailureError;
	if (
		code === "ENOENT" &&
		cwdUnresolvable &&
		commandProbablyPresent(options.command) !== false
	) {
		failure = new SpawnFailureError(
			"cwd-unresolvable",
			`Cannot spawn ${options.command}: working directory is unresolvable (${options.cwd})`,
			cause,
		);
	} else if (code === "ENOENT") {
		failure = new SpawnFailureError(
			"tool-not-found",
			`Cannot spawn ${options.command}: tool not found (${cause.message})`,
			cause,
		);
	} else if (code === "EACCES" || code === "EPERM") {
		failure = new SpawnFailureError(
			"permission-denied",
			`Cannot spawn ${options.command}: permission denied`,
			cause,
		);
	} else {
		failure = new SpawnFailureError(
			"spawn-failed",
			`Cannot spawn ${options.command}: ${cause.message}`,
			cause,
		);
	}
	recordSpawnClassification(failure, options);
	return failure;
}

const loggedSpawnClassifications = new Set<string>();
const SPAWN_CLASSIFICATION_LOG_CAP = 200;

function recordSpawnClassification(
	failure: SpawnFailureError,
	options: { command: string; cwd?: string },
): void {
	const pair = `${failure.kind}\0${options.command}`;
	if (!loggedSpawnClassifications.has(pair)) {
		if (loggedSpawnClassifications.size >= SPAWN_CLASSIFICATION_LOG_CAP) {
			loggedSpawnClassifications.clear();
		}
		loggedSpawnClassifications.add(pair);
		logExtension({
			subsystem: "safe-spawn",
			level: "debug",
			message: "spawn failure classified",
			metadata: {
				kind: failure.kind,
				command: options.command,
				cwd: options.cwd,
			},
		});
	}
	if (failure.kind !== "tool-not-found") {
		recordDegradation({
			kind: "spawn-failure",
			subject: options.command,
			reason: `${failure.kind}${options.cwd ? ` in ${options.cwd}` : ""}`,
		});
	}
}

/** Classify a raw Node spawn error without discarding its errno-bearing Error. */
export async function classifySpawnFailure(
	error: unknown,
	options: { command: string; cwd?: string },
): Promise<SpawnFailureError> {
	const cause = toError(error);
	const needsCwdProbe = errorCode(cause) === "ENOENT";
	const cwdUnresolvable =
		needsCwdProbe && (await cwdIsUnresolvable(options.cwd));
	return classifyWithCwdFlag(cause, options, cwdUnresolvable);
}

function classifySpawnFailureSync(
	error: unknown,
	options: { command: string; cwd?: string },
): SpawnFailureError {
	const cause = toError(error);
	const needsCwdProbe = errorCode(cause) === "ENOENT";
	const cwdUnresolvable = needsCwdProbe && cwdIsUnresolvableSync(options.cwd);
	return classifyWithCwdFlag(cause, options, cwdUnresolvable);
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
	/** Match output chunks before output-cap truncation can discard them. */
	matchWhileStreaming?: RegExp;
	/** Optional stdin payload. Supplying it always writes and closes stdin. */
	input?: string;
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
		// #2026: negative pid = whole process group (POSIX children spawn
		// detached), reaching grandchildren too. Any failure (ESRCH = already
		// gone, EPERM = raced) falls through to the direct-child attempt.
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			process.kill(pid, "SIGKILL");
		}
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
 * cmd.exe's `/s` outer-quote-stripping quirk. #2023: chcp is invoked via its
 * absolute `%SystemRoot%\System32\chcp.com` path and chained with `&`, not
 * `&&` — a child environment whose PATH cannot resolve System32 used to fail
 * the bare `chcp` lookup, and `&&` then short-circuited EVERY .cmd/.bat spawn
 * into exit 1 with empty output. With the pin plus `&`, even a chcp failure
 * can never suppress the real command.
 */
export function buildWindowsShellCommand(
	command: string,
	args: string[],
): string {
	const chcp = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\chcp.com`;
	return `${chcp} 65001 >nul 2>&1 & ${[command, ...args].map(cmdEscapeArg).join(" ")}`;
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

export interface ResolvedWindowsCommand {
	/** Absolute path to the resolved executable. */
	resolvedPath: string;
	/** Lowercased extension including the leading dot, e.g. ".exe", ".cmd". */
	ext: string;
}

/**
 * The extensions this resolver treats as executable suffixes on their own,
 * independent of PATHEXT: `.exe`/`.com` and `.cmd`/`.bat`. An explicit suffix
 * outside this set is not treated as a "known executable extension" unless
 * the caller's own PATHEXT says so (#1201).
 *
 * This is a RESOLUTION set, not a dispatch whitelist — do not read it as "the
 * only extensions this module can spawn". Dispatch in
 * `safeSpawnAsync`/`safeSpawn` below routes `.cmd`/`.bat` through the cmd.exe
 * wrapper and EVERYTHING ELSE to direct spawn, so a resolved path with any
 * other suffix (reachable only when the caller's own PATHEXT lists it) is
 * direct-spawned. That is deliberate and not a widening: CreateProcess does no
 * ShellExecute file-association lookup, the default Windows PATHEXT already
 * contains `.VBS`/`.JS`/`.WSF`/`.MSC`, and the set here is strictly narrower
 * than the pre-#1201 behavior. Only the doc claim was ever wrong.
 */
const WINDOWS_DIRECT_RESOLVABLE_EXTS = new Set([
	".exe",
	".com",
	".cmd",
	".bat",
]);

/**
 * Merge a parent and child environment using Windows' case-insensitive variable
 * names. Node's JavaScript environment object can contain both `PATH` and
 * `Path`, even though Windows treats them as one variable. Removing an older
 * spelling before each assignment gives explicit child overrides precedence
 * over every ambient spelling and ensures the environment passed to spawn has
 * one unambiguous value.
 */
export function mergeWindowsEnvironment(
	base: NodeJS.ProcessEnv,
	overrides?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const entries = new Map<string, { key: string; value: string }>();
	const assign = (source: NodeJS.ProcessEnv | undefined): void => {
		if (!source) return;
		for (const [key, value] of Object.entries(source)) {
			const folded = key.toLowerCase();
			// Delete before setting so the last explicit spelling wins while the
			// folded map remains O(n) instead of scanning the merged object for
			// every environment entry.
			entries.delete(folded);
			if (value !== undefined) entries.set(folded, { key, value });
		}
	};
	assign(base);
	assign(overrides);

	const merged: NodeJS.ProcessEnv = {};
	for (const { key, value } of entries.values()) merged[key] = value;
	return merged;
}

function getWindowsEnvironmentValue(
	env: NodeJS.ProcessEnv,
	name: string,
): string | undefined {
	let value: string | undefined;
	for (const [key, entry] of Object.entries(env)) {
		if (key.toLowerCase() === name.toLowerCase()) value = entry;
	}
	return value;
}

function driveLetter(value: string): string | undefined {
	const match = /^([A-Za-z]):/.exec(value);
	return match?.[1]?.toUpperCase();
}

function isDriveAbsolute(value: string, drive: string): boolean {
	return (
		value.length >= 3 &&
		value[0]?.toUpperCase() === drive.toUpperCase() &&
		value[1] === ":" &&
		(value[2] === "\\" || value[2] === "/")
	);
}

/** `X:\...` or `X:/...` — a drive-absolute path, for any drive letter. */
function isDriveAbsoluteAnyDrive(value: string): boolean {
	const drive = driveLetter(value);
	return drive !== undefined && isDriveAbsolute(value, drive);
}

/** `\\server\share\...` — a UNC path. Two leading separators, not more. */
function isUncWindowsPath(value: string): boolean {
	return (
		(value[0] === "\\" || value[0] === "/") &&
		(value[1] === "\\" || value[1] === "/") &&
		value[2] !== "\\" &&
		value[2] !== "/"
	);
}

/**
 * A path is "fully qualified" (self-contained, no ambient current-directory
 * lookup required) only when it is drive-absolute (`X:\...`) or UNC
 * (`\\server\share`). `path.win32.isAbsolute("\tools")` also returns `true`
 * for a *rooted* path — one relative to the current drive's root rather than
 * a specific drive — and treating that as fully qualified was the #1201
 * bug: it got statSync'd against the *host* drive while a different
 * `effectiveCwd`/`resolvedDrive` supplied the drive cmd.exe actually used to
 * execute it, so a different file could be validated than executed.
 */
function isFullyQualifiedWindowsPath(value: string): boolean {
	return isFullyQualifiedWin32(value) && !isRootedWindowsPath(value);
}

/**
 * `\tools` or `/tools` — rooted at the current drive's root, but naming no
 * drive of its own (distinct from both `X:\tools` fully-qualified and
 * `X:tools` drive-relative-to-current-directory). Windows resolves this
 * against the root of whichever drive is "current", not the current
 * directory on that drive.
 */
function isRootedWindowsPath(value: string): boolean {
	return (
		(value[0] === "\\" || value[0] === "/") &&
		driveLetter(value) === undefined &&
		!isUncWindowsPath(value)
	);
}

/**
 * Resolve a rooted path (`\tools`) against the ROOT of `driveSource`'s drive
 * — not `driveSource` itself — matching Windows' own rooted-path semantics.
 *
 * When `driveSource` carries NO drive letter, this returns the normalized
 * value rather than `undefined` (#1201, recurring defect shape 2). A
 * drive-less "current drive" provenance means we are not on a drive-lettered
 * filesystem at all — a POSIX host, or a UNC `process.cwd()` such as
 * `\\server\share\...`, which Node permits on real Windows. In that namespace
 * a rooted path is already as qualified as any path can be, so there is
 * nothing to anchor and normalizing is the correct (and pre-#1201) answer.
 * Returning `undefined` instead used to collapse the whole resolution to
 * `null` without a single `statSync`, i.e. a false ENOENT — the exact failure
 * signature #1199 exists to remove. This function must therefore never fail
 * closed on the *shape* of a value that may not be a Windows path at all;
 * the filesystem probe downstream is what decides whether it exists.
 */
function resolveRootedWindowsPath(value: string, driveSource: string): string {
	const drive = driveLetter(driveSource);
	if (drive === undefined) return path.win32.normalize(value);
	return path.win32.normalize(path.win32.resolve(`${drive}:\\`, value));
}

/**
 * Return a validated Windows per-drive current directory. Windows exposes
 * these as environment entries such as `=D:`; unlike ordinary environment
 * variables they are not safe to synthesize from a drive letter. A malformed
 * or wrong-drive value is deliberately ignored so drive-relative resolution
 * fails closed instead of guessing a root.
 *
 * Node never surfaces `=X:` keys from the ambient `process.env` (verified:
 * `Object.keys(process.env).filter(k => k.startsWith("="))` is empty), so
 * this provenance is only ever available when a caller supplies it
 * explicitly in an `env` override — e.g. a test, or a future integration
 * that reads it from a lower-level Windows API. That's a real, if narrow,
 * use: keep this path rather than deleting it, but never synthesize a value
 * Node itself can't hand us.
 */
function getValidatedPerDriveCwd(
	env: NodeJS.ProcessEnv,
	drive: string,
): string | undefined {
	const value = getWindowsEnvironmentValue(env, `=${drive}:`);
	if (value === undefined || !isDriveAbsolute(value, drive)) return undefined;
	return path.win32.normalize(value);
}

function resolveEffectiveWindowsCwd(
	cwd: string | undefined,
	env: NodeJS.ProcessEnv,
): string | undefined {
	if (cwd === undefined) {
		// No caller-supplied cwd: `process.cwd()` IS the effective cwd already —
		// the real, canonical filesystem cwd of THIS process, not a string that
		// needs (re)classifying. On a POSIX CI host it naturally carries no
		// drive letter; that's fine, it never needs one here. Only a
		// CALLER-SUPPLIED cwd string goes through the fully-qualified/rooted/
		// drive-relative classification below — running `process.cwd()`'s own
		// value through `isRootedWindowsPath` was itself a #1201 regression: a
		// drive-less POSIX path (e.g. Linux CI's real cwd) satisfies that
		// predicate too (single leading separator, no drive letter), which then
		// sent it to `resolveRootedWindowsPath` looking for a drive letter on
		// `process.cwd()` that — being the very same drive-less string — could
		// never supply one, resolving to `undefined` (recurring defect shape
		// 2/7: `path.win32.resolve` falls back to `process.cwd()`, which
		// supplies a drive on Windows and none on Linux).
		return path.win32.normalize(process.cwd());
	}
	const requestedDrive = driveLetter(cwd);
	if (requestedDrive !== undefined && !isDriveAbsoluteAnyDrive(cwd)) {
		// `D:foo` — drive-relative to that drive's own current directory.
		const base = getValidatedPerDriveCwd(env, requestedDrive);
		return base === undefined
			? undefined
			: path.win32.normalize(path.win32.resolve(base, cwd));
	}
	if (isFullyQualifiedWindowsPath(cwd)) return path.win32.normalize(cwd);
	if (isRootedWindowsPath(cwd)) {
		// `\tools` — rooted at the CURRENT drive's root.
		//
		// Note the deliberate asymmetry with `resolveWindowsPathEntry`, which
		// anchors rooted PATH entries to `effectiveCwd`'s drive instead. Both
		// use the SAME rule — "anchor to the best available "current drive"
		// provenance at this point in the pipeline" — they just sit at
		// different points. Here we are *computing* `effectiveCwd`, so it does
		// not exist yet and the process's own cwd is the only provenance
		// available (on real Windows it always carries a drive letter). By the
		// time a PATH entry is resolved, `effectiveCwd` is known and is the
		// strictly better answer, because it is the drive the child will
		// actually run from — anchoring PATH entries to the host drive there
		// would validate one file and execute another. Neither call can fail
		// closed on a drive-less provenance; see `resolveRootedWindowsPath`.
		return resolveRootedWindowsPath(cwd, process.cwd());
	}
	return path.win32.normalize(path.win32.resolve(process.cwd(), cwd));
}

function resolveDriveRelativeWindowsPath(
	value: string,
	effectiveCwd: string | undefined,
	env: NodeJS.ProcessEnv,
): string | undefined {
	const drive = driveLetter(value);
	if (drive === undefined) return undefined;
	const cwdDrive =
		effectiveCwd === undefined ? undefined : driveLetter(effectiveCwd);
	const base =
		cwdDrive?.toUpperCase() === drive
			? effectiveCwd
			: getValidatedPerDriveCwd(env, drive);
	if (base === undefined) return undefined;
	return path.win32.normalize(path.win32.resolve(base, value));
}

function resolveWindowsPathEntry(
	entry: string,
	effectiveCwd: string | undefined,
	env: NodeJS.ProcessEnv,
): string | undefined {
	if (driveLetter(entry) !== undefined && !isDriveAbsoluteAnyDrive(entry)) {
		return resolveDriveRelativeWindowsPath(entry, effectiveCwd, env);
	}
	if (isFullyQualifiedWindowsPath(entry)) return path.win32.normalize(entry);
	if (isRootedWindowsPath(entry)) {
		// `\tools` — rooted at the effective child cwd's drive root, not the
		// host process's drive (#1201: a rooted PATH entry must resolve on
		// the SAME drive the child will actually run cmd.exe/the resolved
		// binary from). See `resolveEffectiveWindowsCwd`'s rooted branch for
		// why that function anchors to `process.cwd()` instead — same rule,
		// different point in the pipeline. `undefined` here means the cwd
		// itself was unprovable, which is a genuinely different condition
		// from "the provenance carries no drive letter".
		return effectiveCwd === undefined
			? undefined
			: resolveRootedWindowsPath(entry, effectiveCwd);
	}
	if (effectiveCwd === undefined) return undefined;
	return path.win32.normalize(path.win32.resolve(effectiveCwd, entry));
}

/**
 * Cached PATH + PATHEXT resolution results. The effective child environment is
 * part of the key, not the ambient process environment: one caller's managed
 * bin directory must never poison another caller's resolution. The key also
 * carries the canonical child cwd and Windows `=X:` per-drive cwd entries,
 * because both affect relative PATH and drive-relative lookup. Session-lived
 * (matches this repo's other resolution caches, e.g.
 * `clients/workspace-topology.ts`'s `resetWorkspaceTopology`) — cleared via
 * `resetSafeSpawnWindowsCommandCache()`, wired into `handleSessionStart`. The
 * cache is also count-bounded with oldest-entry eviction because a long-lived
 * process can encounter unbounded cwd/environment combinations.
 */
export const WINDOWS_COMMAND_CACHE_MAX_ENTRIES = 256;
const WINDOWS_COMMAND_NEGATIVE_CACHE_TTL_MS = 1000;
interface WindowsCommandCacheEntry {
	resolved: ResolvedWindowsCommand | null;
	checkedAt: number;
}
const windowsCommandCache = new BoundedFifoMap<
	string,
	WindowsCommandCacheEntry
>(WINDOWS_COMMAND_CACHE_MAX_ENTRIES);

/** Reset after session replacement or a successful managed install. */
export function resetSafeSpawnWindowsCommandCache(): void {
	windowsCommandCache.clear();
	loggedSpawnClassifications.clear();
}

function cacheWindowsCommandResult(
	key: string,
	resolved: ResolvedWindowsCommand | null,
): void {
	// Resolution entries are session-scoped and cheap to recompute. The
	// caller always deletes any stale entry for `key` before reaching here
	// (see resolveWindowsCommandForEnvironment), so this can only grow the
	// map; BoundedFifoMap evicts the oldest insertion first once the map
	// exceeds capacity, so a long-lived process cannot retain every cwd /
	// environment it has ever touched.
	windowsCommandCache.set(key, { resolved, checkedAt: Date.now() });
}

function getPathExts(env: NodeJS.ProcessEnv): string[] {
	const raw =
		getWindowsEnvironmentValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD";
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
	effectiveCwd: string | undefined,
	env: NodeJS.ProcessEnv,
): ResolvedWindowsCommand | null {
	const pathExts = getPathExts(env);
	const existingExt = path.win32.extname(command).toLowerCase();
	const hasExplicitExt = existingExt.length > 0;
	// A suffix is "known executable" when it's one of the four extensions this
	// resolver actually knows how to run (direct .exe/.com, or the
	// cmd.exe-wrapped .cmd/.bat) OR it's explicitly listed in the caller's own
	// PATHEXT. Anything else with a dot is NOT necessarily "an extension" — a
	// versioned interpreter (`python3.11`, `node-v20.1`) has an `extname()` of
	// `.11`/`.1` that is part of the basename, not a suffix to match exactly
	// (#1201).
	const isKnownExecutableExt = (ext: string): boolean =>
		WINDOWS_DIRECT_RESOLVABLE_EXTS.has(ext) || pathExts.includes(ext);

	const tryBase = (base: string): ResolvedWindowsCommand | null => {
		// Additive, not exclusive: an explicit, known-executable suffix is
		// tried as an exact candidate FIRST (this also lets a caller ask for
		// `foo.cmd` even when the current PATHEXT doesn't happen to list
		// `.CMD`). Whenever the suffix ISN'T a PATHEXT entry — no extension at
		// all, or a versioned/unknown one like `.11` — the PATHEXT-append loop
		// ALSO runs against the full base, so `python3.11` still finds
		// `python3.11.exe`. An unknown suffix (e.g. `foo.txt`) never gets an
		// exact-match short-circuit: that would let an arbitrary
		// non-executable file resolve as "spawnable" and reach the
		// direct-spawn branch downstream.
		if (
			hasExplicitExt &&
			isKnownExecutableExt(existingExt) &&
			statIsFile(base)
		) {
			return { resolvedPath: base, ext: existingExt };
		}
		if (!hasExplicitExt || !pathExts.includes(existingExt)) {
			for (const ext of pathExts) {
				const candidate = base + ext;
				if (statIsFile(candidate)) return { resolvedPath: candidate, ext };
			}
		}
		return null;
	};

	const hasPathSep = /[\\/]/.test(command);
	// `D:tool.exe` is drive-relative on Windows, not a bare PATH command. It
	// uses the effective cwd only when that cwd is on D:. For another drive we
	// require an explicit, validated `=D:` provenance entry; otherwise this
	// resolver fails closed rather than guessing `D:\\` or searching PATH.
	const hasDrivePrefix = driveLetter(command) !== undefined;
	if (hasPathSep || hasDrivePrefix || isFullyQualifiedWindowsPath(command)) {
		let base: string | undefined;
		if (isFullyQualifiedWindowsPath(command)) {
			base = path.win32.normalize(command);
		} else if (hasDrivePrefix) {
			base = resolveDriveRelativeWindowsPath(command, effectiveCwd, env);
		} else if (isRootedWindowsPath(command)) {
			base =
				effectiveCwd === undefined
					? undefined
					: resolveRootedWindowsPath(command, effectiveCwd);
		} else if (effectiveCwd !== undefined) {
			base = path.win32.normalize(path.win32.resolve(effectiveCwd, command));
		}
		return base === undefined ? null : tryBase(base);
	}

	// A bare command (no path separator) is a plain PATH search. Absolute PATH
	// entries don't need `effectiveCwd` at all, so an unresolvable cwd must
	// only skip the relative entries (handled per-entry in
	// resolveWindowsPathEntry below), not abort the whole search (#1201: a bad
	// cwd shouldn't make an otherwise-resolvable command look "not installed").
	const pathValue = getWindowsEnvironmentValue(env, "PATH") ?? "";
	const pathDirs = pathValue.split(path.win32.delimiter);
	for (const dir of pathDirs) {
		if (!dir) continue;
		const resolvedDir = resolveWindowsPathEntry(dir, effectiveCwd, env);
		if (resolvedDir === undefined) continue;
		const found = tryBase(path.win32.join(resolvedDir, command));
		if (found) return found;
	}
	return null;
}

/**
 * Resolve a Windows command using the exact environment that will be passed to
 * the child. Exported as a small platform-independent test/diagnostic seam;
 * callers should pass a Windows-shaped environment and do not need to mutate
 * `process.env` to exercise resolution. Drive-relative commands (`D:tool.exe`)
 * use a same-drive effective cwd, or a validated absolute `=D:` entry for a
 * different drive; without that provenance they fail closed and never search
 * PATH. Relative PATH entries use the canonical effective child cwd.
 */
export function resolveWindowsCommandForEnvironment(
	command: string,
	cwd: string | undefined,
	env: NodeJS.ProcessEnv,
): ResolvedWindowsCommand | null {
	const effectiveCwd = resolveEffectiveWindowsCwd(cwd, env);
	const pathValue = getWindowsEnvironmentValue(env, "PATH");
	const pathExtValue = getWindowsEnvironmentValue(env, "PATHEXT");
	const perDriveCwds = Object.entries(env)
		.flatMap(([key, value]) =>
			/^=[A-Za-z]:$/.test(key)
				? ([[key.toLowerCase(), value] as const] as const)
				: [],
		)
		.sort(([left], [right]) => compareOrdinal(left, right));
	// Keep presence separate from value: absent PATHEXT means the Windows
	// default extension list, while PATHEXT="" means no implicit extensions.
	// The per-drive snapshot is equally important: it is provenance for
	// drive-relative commands and PATH entries, not ambient decoration.
	const cacheKey = JSON.stringify([
		"win32",
		command,
		pathValue === undefined ? ["absent"] : ["present", pathValue],
		pathExtValue === undefined ? ["absent"] : ["present", pathExtValue],
		effectiveCwd === undefined ? ["unresolved"] : ["resolved", effectiveCwd],
		perDriveCwds,
	]);
	const cached = windowsCommandCache.get(cacheKey);
	if (cached) {
		// Positive entries are revalidated on every hit so an executable deleted
		// or replaced mid-session cannot remain spawnable through stale cache
		// state. Negative entries are short-lived to discover external installs;
		// pi-lens-managed installs also reset the cache immediately on success.
		if (cached.resolved && statIsFile(cached.resolved.resolvedPath)) {
			return cached.resolved;
		}
		if (
			!cached.resolved &&
			Date.now() - cached.checkedAt <= WINDOWS_COMMAND_NEGATIVE_CACHE_TTL_MS
		) {
			return null;
		}
		windowsCommandCache.delete(cacheKey);
	}
	const resolved = resolveWindowsCommandUncached(command, effectiveCwd, env);
	cacheWindowsCommandResult(cacheKey, resolved);
	return resolved;
}

/** Cached `where`-equivalent for the effective child environment. */
function resolveWindowsCommand(
	command: string,
	cwd: string | undefined,
	env: NodeJS.ProcessEnv,
): ResolvedWindowsCommand | null {
	return resolveWindowsCommandForEnvironment(command, cwd, env);
}

function getSpawnEnvironment(
	overrides: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
	return process.platform === "win32"
		? mergeWindowsEnvironment(process.env, overrides)
		: { ...process.env, ...overrides };
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
	// syscall/path) so the typed classifier retains the same diagnostic cause
	// now that Windows resolution happens before spawn instead of inside cmd.exe.
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
			// #1980 population sweep: a synchronous spawn with no timeout parks
			// the event loop for as long as the child takes, and nothing here
			// bounds that. `chcp` is normally instant, but this runs before the
			// FIRST real spawn of the process, which is exactly when a cold or
			// antivirus-throttled cmd.exe is slowest. Matches the 5s bound every
			// other synchronous child-process site in this repo already carries.
			timeout: 5000,
		});
	} catch {
		// Best-effort: worst case is non-ASCII tool output decoded incorrectly, not a
		// spawn failure — never let this block the real spawn.
	}
}

/**
 * Test-only seam: clear the one-shot `chcp` memoization.
 *
 * No test observes it today — the memoized work only runs inside a real
 * Windows direct spawn, so exercising it would mean a Windows-only test, and
 * the state it guards is a console code page, not behavior any assertion
 * depends on. This is kept purely so a future Windows-only test (or a second
 * caller of `ensureUtf8ConsoleCodePageOnce`) can reset process-lifetime state
 * without reaching into the module; it was dropped once as unrelated scope
 * creep in an earlier #1199 revision and restored on review. Do not read the
 * export as evidence of existing coverage (#1201).
 */
export function resetUtf8ConsoleCodePageStateForTests(): void {
	utf8ConsoleCodePageApplied = false;
}

// #1656: post-exit pipe-idle wait constants. Node's "close" event only fires
// once every stdio fd referencing the child has been released — a
// daemonized descendant that inherited our stdout/stderr pipe (the Windows
// no-job-object case) can hold that fd open forever, hanging "close" even
// though the child we spawned is long dead. A fixed post-exit deadline
// avoids that hang but truncates a legitimately still-streaming child. The
// idle-grace construction (adopted from pi's `waitForChildProcess`) does
// neither: after "exit", wait for the pipes to go quiet — no data for
// EXIT_PIPE_IDLE_GRACE_MS, re-armed on every chunk — so a quiet inherited
// handle still releases after one grace window while an actively-writing
// descendant keeps being read. EXIT_PIPE_IDLE_MAX_WAIT_MS caps the total
// extra wait so a pathological, never-quiet descendant can't extend the
// caller's overall budget unboundedly.
const EXIT_PIPE_IDLE_GRACE_MS = 100;
const EXIT_PIPE_IDLE_MAX_WAIT_MS = 2000;

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
 * ## Why this bound is NOT `bounded()` — the one documented exception (#2523)
 *
 * #2523 slice 2 folded every other "deadline AND abort signal" implementation
 * in the tree onto `clients/deadline-utils.ts#bounded`. This one stays, and it
 * is not a copy of the same idea:
 *
 * `bounded()` ABANDONS a promise — it stops waiting and lets the work run on
 * unobserved, which is safe precisely because everything it wraps is in-process
 * (a dynamic import, an LSP round trip, a `stat`). This function's work is a
 * CHILD PROCESS, and abandoning one leaks it. So its timer does not settle a
 * race at all: `timeoutId` sets `timedOut`, then runs `killTree()` — SIGTERM,
 * an escalation timer, SIGKILL, and on Windows a `taskkill /T` of the whole
 * tree — and the promise settles only when the child's own `close` arrives (or
 * the escalation gives up). The result it produces carries the teardown
 * EVIDENCE (`timeoutTeardown`, #2010): which signal killed it, whether the
 * tree actually died, how long it took. Replacing that with `bounded()` would
 * return `undefined` at the deadline and leave a live `vitest`/`gradle` behind
 * — the orphan class #2504 measured as 59 concurrent spawns starving a turn.
 *
 * The rule the exception preserves: a bound that can CANCEL its work must
 * cancel it. `bounded()` is for work that cannot be cancelled; this is not
 * that. Anything wrapping THIS function still gets `bounded()` around its own
 * await if it needs one.
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
			const cause = new Error("Spawn aborted before start");
			resolve({
				stdout: "",
				stderr: "",
				status: null,
				error: cause,
				failure: "aborted",
				spawnFailure: new SpawnFailureError("killed", cause.message, cause),
			});
			return;
		}
		if (timeout <= 0) {
			const cause = new Error(`Process timed out after ${timeout}ms`);
			resolve({
				stdout: "",
				stderr: "",
				status: null,
				error: cause,
				failure: "timeout",
				spawnFailure: new SpawnFailureError("timeout", cause.message, cause),
			});
			return;
		}

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		let killed = false;
		let outputTruncated = false;
		let killedForOutputCap = false;
		let streamingMatch = false;
		// #1651 review: a single boolean the close/error handlers both check
		// AND set, so whichever one decides the outcome first wins outright —
		// the DECISION itself is shape-based (see the `close` handler below),
		// this flag only stops the loser from resolving a second time.
		let resolved = false;
		// The most recent 'error' Error, captured the instant the event fires
		// regardless of whether that handler goes on to resolve. The `close`
		// handler's shape-based branch (code === null || code < 0) reads this
		// when it decides FIRST, so a genuinely informative ENOENT/EACCES/etc.
		// Error is used when it happens to already be available, instead of
		// always falling back to a generic synthesized one.
		let pendingSpawnError: Error | undefined;
		// #1109: the non-Windows SIGTERM→SIGKILL escalation timer (armed in
		// killTree below). Stored per-call (never shared) so the close/error
		// handlers can clear it if the child exits before it fires — same
		// uncleared-race-timeout class as the LSP client-wait leak (#1097):
		// a ref'd 1s timer that outlives the child it was escalating against
		// would keep a one-shot `pi --print` process alive for up to 1s.
		let escalationTimer: ReturnType<typeof setTimeout> | undefined;
		let teardownStartedAtMs: number | undefined;
		let teardownEscalated = false;
		// #2010: teardown evidence for the spawn's OWN timeout. The wall clock
		// starts when the budget expires and the tree-kill is issued, and stops
		// when the process tree is observed dead (`await killPromise` settles)
		// - measured SEPARATELY from the budget itself, so a slow teardown is
		// visible instead of silently inflating "how long the tool ran".
		// `teardownEscalated` names whether SIGTERM sufficed or the SIGKILL
		// escalation fired (POSIX; Windows taskkill /F is always forceful).
		// #1114: `child.killed` is set by Node the moment `kill()` successfully
		// SENDS a signal, not when the child actually dies — so gating the
		// escalation on `!child.killed` right after a successful `SIGTERM` send
		// is always false and the SIGKILL branch is unreachable. Track observed
		// death via the close/error handlers instead (set synchronously, before
		// any `await`, so a timer firing during the close handler's `await
		// killPromise` still observes the flag correctly).
		let closed = false;
		// #1656: set only while the post-exit idle-pipe wait is active (see
		// waitForPipeIdle below); the stdout/stderr "data" handlers call this to
		// re-arm the grace timer on every chunk. `undefined` before exit / after
		// the wait settles, so the calls below are no-ops outside that window.
		let rearmIdleGrace: (() => void) | undefined;
		const maxOutputBytes =
			options?.maxOutputBytes !== undefined &&
			Number.isFinite(options.maxOutputBytes) &&
			options.maxOutputBytes > 0
				? Math.floor(options.maxOutputBytes)
				: undefined;
		const outputTruncationMarker = "\n...[output truncated]...\n";
		type OutputStream = "stdout" | "stderr";
		type OutputPart = { stream: OutputStream; text: string };
		let retainedHead: OutputPart[] = [];
		let retainedTail: OutputPart[] = [];
		let retainedTailBytes = 0;
		let retainedTailLimit = 0;
		let truncationStream: OutputStream = "stderr";
		const streamingMatcher = options?.matchWhileStreaming;
		const streamingCarryBytes = streamingMatcher
			? Math.max(0, streamingMatcher.source.length - 1)
			: 0;
		const streamingCarry: Record<OutputStream, string> = {
			stdout: "",
			stderr: "",
		};
		const bytePrefix = (text: string, bytes: number): string =>
			Buffer.from(text).subarray(0, bytes).toString();
		const byteSuffix = (text: string, bytes: number): string => {
			const buffer = Buffer.from(text);
			return buffer.subarray(Math.max(0, buffer.byteLength - bytes)).toString();
		};
		const appendTail = (part: OutputPart, maxBytes: number): void => {
			if (maxBytes <= 0) return;
			retainedTail.push({ stream: part.stream, text: part.text });
			retainedTailBytes += Buffer.byteLength(part.text);
			while (retainedTailBytes > maxBytes && retainedTail.length > 0) {
				const first = retainedTail[0];
				const excess = retainedTailBytes - maxBytes;
				const firstBytes = Buffer.byteLength(first.text);
				if (firstBytes <= excess) {
					retainedTail.shift();
					retainedTailBytes -= firstBytes;
				} else {
					first.text = byteSuffix(first.text, firstBytes - excess);
					retainedTailBytes -= excess;
				}
			}
		};
		const renderOutput = (stream: OutputStream): string => {
			const head = retainedHead
				.filter((part) => part.stream === stream)
				.map((part) => part.text)
				.join("");
			const tail = retainedTail
				.filter((part) => part.stream === stream)
				.map((part) => part.text)
				.join("");
			const marker = stream === truncationStream ? outputTruncationMarker : "";
			return head + marker + tail;
		};
		const refreshRetainedOutputs = (): void => {
			stdout = renderOutput("stdout");
			stderr = renderOutput("stderr");
		};
		const appendOutput = (
			stream: OutputStream,
			current: string,
			chunk: string | Buffer,
		): string => {
			const text = typeof chunk === "string" ? chunk : chunk.toString();
			if (maxOutputBytes === undefined || outputTruncated) {
				if (maxOutputBytes === undefined) return current + text;
				appendTail({ stream, text }, retainedTailLimit);
				truncationStream = stream;
				return renderOutput(stream);
			}
			const used = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
			const bytes = Buffer.byteLength(text);
			if (used + bytes <= maxOutputBytes) return current + text;
			outputTruncated = true;
			truncationStream = stream;
			const available = Math.max(
				0,
				maxOutputBytes - Buffer.byteLength(outputTruncationMarker),
			);
			const headBytes = Math.floor(available / 2);
			const tailBytes = available - headBytes;
			retainedTailLimit = tailBytes;
			const parts: OutputPart[] = [
				{ stream: "stdout", text: stdout },
				{ stream: "stderr", text: stderr },
				{ stream, text },
			];
			let headRemaining = headBytes;
			for (const part of parts) {
				if (headRemaining <= 0) break;
				const kept = bytePrefix(part.text, headRemaining);
				if (kept) retainedHead.push({ stream: part.stream, text: kept });
				headRemaining -= Buffer.byteLength(kept);
			}
			let tailRemaining = tailBytes;
			for (
				let index = parts.length - 1;
				index >= 0 && tailRemaining > 0;
				index--
			) {
				const part = parts[index];
				const kept = byteSuffix(part.text, tailRemaining);
				if (kept) {
					retainedTail.unshift({ stream: part.stream, text: kept });
					tailRemaining -= Buffer.byteLength(kept);
				}
			}
			retainedTailBytes = tailBytes - tailRemaining;
			return renderOutput(stream);
		};
		const matchStreamingChunk = (
			stream: OutputStream,
			chunk: string | Buffer,
		): void => {
			if (streamingMatch || !streamingMatcher) return;
			const text = typeof chunk === "string" ? chunk : chunk.toString();
			streamingMatcher.lastIndex = 0;
			streamingMatch = streamingMatcher.test(streamingCarry[stream] + text);
			if (streamingCarryBytes > 0) {
				streamingCarry[stream] = Buffer.from(streamingCarry[stream] + text)
					.subarray(-streamingCarryBytes)
					.toString();
			}
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
		const spawnEnv = getSpawnEnvironment(options?.env);
		// The cwd handed to the CHILD process doesn't need OUR validation —
		// Windows resolves it natively, exactly as it did before #817 ever
		// touched this file. A drive-relative cwd (`D:work`) without a
		// validated `=D:` env entry can't be canonicalized by us (Node never
		// surfaces `=X:` keys from the ambient environment — see
		// `getValidatedPerDriveCwd`'s doc comment), but that is a gap in OUR
		// provenance, not evidence the cwd itself is bad. Fall back to the raw
		// value instead of failing the whole spawn before ever attempting it
		// (#1201) — command resolution just below still fails closed for any
		// relative PATH entry that would need this cwd to be canonical.
		// No `?? process.cwd()` third arm: `resolveEffectiveWindowsCwd(undefined,
		// env)` always returns a string, so the only way to reach `undefined`
		// here is a DEFINED-but-unprovable `options.cwd`, which `?? options?.cwd`
		// already covers. A `process.cwd()` arm would be unreachable, and it
		// would read like a live silent-wrong-directory hazard (#1201).
		const spawnCwd = isWindows
			? (resolveEffectiveWindowsCwd(options?.cwd, spawnEnv) ?? options?.cwd)
			: options?.cwd;
		let spawnCmd = command;
		let spawnArgs = args;
		let windowsVerbatimArguments = false;
		let resolutionError: Error | undefined;

		if (isWindows) {
			// Pass the ORIGINAL (unresolved) cwd here, not `spawnCwd` above — this
			// seam intentionally fails closed on unprovable drive-relative
			// provenance (matches `resolveWindowsCommandForEnvironment`'s
			// documented contract and its dedicated test coverage), independent
			// of the passthrough fallback the actual child cwd gets above.
			const resolved = resolveWindowsCommand(command, options?.cwd, spawnEnv);
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
			void classifySpawnFailure(resolutionError, {
				command,
				cwd: options?.cwd,
			}).then((spawnFailure) =>
				resolve({
					stdout: "",
					stderr: "",
					status: null,
					error: resolutionError,
					failure: "spawn",
					spawnFailure,
				}),
			);
			return;
		}

		let child: ChildProcess;
		// #2026: on POSIX, run the child in its OWN process group (detached).
		// killTree/killPidTreeSync then signal the whole GROUP (-pid), which
		// makes grandchildren (npm -> node, sh -> sleep, etc.) die with their
		// tool instead of surviving every timeout as orphans. Detachment stops
		// direct terminal-signal delivery, so EVERY POSIX pid registers for
		// lifetime cleanup - pi's signal/exit handlers forward the kill,
		// preserving die-with-host semantics.
		const posixProcessGroup = process.platform !== "win32";
		try {
			child = spawn(spawnCmd, spawnArgs, {
				cwd: spawnCwd,
				env: spawnEnv,
				windowsHide: true,
				shell: false,
				windowsVerbatimArguments,
				detached: posixProcessGroup,
			});
		} catch (err) {
			// A SYNCHRONOUS spawn throw (Windows `spawn UNKNOWN`/EINVAL — the
			// pidusage bug class, #533) must NOT reject this Promise: every caller
			// relies on safeSpawnAsync never rejecting (they inspect result.error),
			// and many invoke it fire-and-forget in best-effort/background paths, so
			// a rejection here could surface as an unhandledRejection that crashes
			// the host. Resolve the failure gracefully instead — same contract as an
			// asynchronously-emitted `'error'` event (handled below).
			const cause = toError(err);
			void classifySpawnFailure(cause, { command, cwd: options?.cwd }).then(
				(spawnFailure) =>
					resolve({
						stdout: "",
						stderr: "",
						status: null,
						error: cause,
						failure: "spawn",
						spawnFailure,
					}),
			);
			return;
		}
		// Keep historical open stdin by default. An opted-in payload is written
		// completely and followed by EOF; input: "" closes stdin immediately.
		if (options?.input !== undefined) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(options.input);
		}
		if (child.pid && (posixProcessGroup || options?.lifetimeCoupled)) {
			// #2026: POSIX registers unconditionally - detached children no
			// longer receive terminal signals directly, so the lifetime
			// cleanup's signal forwarding IS their die-with-host path.
			installLifetimeCleanup();
			lifetimeState.pids.add(child.pid);
		}

		// #620: bracket this spawn's lifetime with a short-interval CPU/RSS poll
		// (started right here, stopped in finalize() below) so transient
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
			} else if (posixProcessGroup && child.pid && child.pid > 0) {
				// #2026: signal the whole process group. Grandchildren spawned
				// by the tool share its group, so one signal reaches the whole
				// tree; a negative-pid ESRCH means it already exited.
				const pgid = -child.pid;
				try {
					process.kill(pgid, "SIGTERM");
				} catch {
					child.kill("SIGTERM");
				}
				// #2027 round-1: gate the SIGKILL escalation on GROUP liveness,
				// not direct-child death - a tool can exit instantly on SIGTERM
				// while a SIGTERM-hardy grandchild keeps the group alive. The
				// timer stays REF'D for group mode (max 1s tail after resolve):
				// it is the only backstop for this group once finalize deletes
				// the pid from lifetimeState.
				escalationTimer = setTimeout(() => {
					let groupAlive = true;
					try {
						process.kill(pgid, 0);
					} catch {
						groupAlive = false;
					}
					if (!groupAlive) return;
					teardownEscalated = true;
					logLatency({
						type: "phase",
						phase: "spawn_group_kill_escalation",
						filePath: "",
						durationMs: 0,
						metadata: { pgid: child.pid },
					});
					try {
						process.kill(pgid, "SIGKILL");
					} catch {
						// Raced with group exit.
					}
				}, 1000);
			} else {
				child.kill("SIGTERM");
				escalationTimer = setTimeout(() => {
					if (!closed) {
						teardownEscalated = true;
						child.kill("SIGKILL");
					}
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

		// Output-cap kills are awaited by finalize() below, just like
		// timeout/abort kills. An armed, unmatched streaming matcher is the one
		// exception: retention remains bounded, but the caller's timeout is the
		// bound while the child gets a chance to emit its rescue line.
		let killPromise: Promise<void> | undefined;
		const stopForOutputLimit = (): void => {
			const waitingForStreamingMatch =
				streamingMatcher !== undefined && !streamingMatch;
			if (
				outputTruncated &&
				!waitingForStreamingMatch &&
				!killed &&
				!child.killed
			) {
				killedForOutputCap = true;
				killed = true;
				killPromise = killTree();
			}
		};

		// Collect output
		child.stdout?.setEncoding("utf-8");
		child.stderr?.setEncoding("utf-8");
		child.stdout?.on("data", (data) => {
			matchStreamingChunk("stdout", data);
			stdout = appendOutput("stdout", stdout, data);
			if (outputTruncated) refreshRetainedOutputs();
			stopForOutputLimit();
			rearmIdleGrace?.();
		});
		child.stderr?.on("data", (data) => {
			matchStreamingChunk("stderr", data);
			stderr = appendOutput("stderr", stderr, data);
			if (outputTruncated) refreshRetainedOutputs();
			stopForOutputLimit();
			rearmIdleGrace?.();
		});

		// #1673 review round 3 (F2): registered HERE, at spawn time, alongside
		// the other handlers above — not inside `waitForPipeIdle`. Real Node
		// emits `close` a fraction of a millisecond after `exit` (both fire in
		// the same "process exit" turn, well before any microtask), so a
		// listener attached inside `waitForPipeIdle` — which `finalize` only
		// reaches after `await killPromise`, at least one microtask later — is
		// always attaching to an event that has already happened. That's why
		// the round-2 `child.on("close", finish)` placed inside
		// `waitForPipeIdle` never actually caught a real spawn's `close` early:
		// every real call still paid the full grace window. Capturing the
		// boolean here, before any await, means `waitForPipeIdle` can check
		// "did close already happen" synchronously the moment it runs.
		let closeSeen = false;
		// #2010: WHEN death was observed - the stop-clock for teardown evidence
		// and the discriminator for its outcome. A close that predates the
		// budget-expired kill means the child exited on its own ("exited"), no
		// matter that the timer callback raced and armed a kill anyway.
		let closedAtMs: number | undefined;
		child.on("close", () => {
			closeSeen = true;
			closedAtMs ??= Date.now();
		});

		// Timeout handling - KILL the process, don't just abandon it
		const timeoutId = setTimeout(() => {
			timedOut = true;
			if (!killed && !child.killed) {
				killed = true;
				teardownStartedAtMs = Date.now();
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

		// #1656: wait for stdout/stderr to fall idle after exit instead of
		// waiting for Node's "close" event (see the constants' doc comment
		// above). Resolves immediately if the child has no pipes to drain.
		//
		// These timers stay REF'D, matching `timeoutId`/`escalationTimer`
		// elsewhere in this function: the caller's own settlement depends on
		// them firing, so unref'ing would let a short-lived host process (a
		// one-shot CLI whose only other in-flight work was this spawn) exit
		// the event loop before `finish` ever runs — silently abandoning this
		// promise instead of merely leaking a handle. Both paths to `finish`
		// clear both timers, so nothing outlives settlement either way.
		const waitForPipeIdle = (): Promise<void> => {
			if (!child.stdout && !child.stderr) return Promise.resolve();
			// #1673 review round 3 (F2): `close` fires a fraction of a
			// millisecond after `exit` for a real Node child — well before
			// `finalize`'s `await killPromise` ever yields, i.e. before this
			// function is even called. By the time we get here, `closeSeen`
			// (set by the listener registered at spawn time, above) already
			// reflects reality for the overwhelming majority of real spawns:
			// nothing is holding this child's stdio open, so don't pay out the
			// 100ms grace window for a signal that already arrived.
			if (closeSeen) return Promise.resolve();
			return new Promise((finishIdleWait) => {
				let settled = false;
				let graceTimer: ReturnType<typeof setTimeout> | undefined;
				const capTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
					finish();
				}, EXIT_PIPE_IDLE_MAX_WAIT_MS);
				const finish = (): void => {
					if (settled) return;
					settled = true;
					rearmIdleGrace = undefined;
					if (graceTimer) clearTimeout(graceTimer);
					clearTimeout(capTimer);
					// Optional chaining, not a bare call: `child` is a real Node
					// ChildProcess (always an EventEmitter, always has this) in
					// production, but several existing test doubles across the
					// suite fake stdio-bearing children as plain objects with only
					// the handful of methods (`on`, `kill`, ...) their scenario
					// needs — no `removeListener`. Skipping cleanup on those is
					// harmless (the fake is torn down with the test either way);
					// crashing here from inside a timer callback is not: it would
					// throw before `finishIdleWait()` runs, hanging every caller's
					// `safeSpawnAsync` promise (#1673 review round 2 caught this
					// live in tests/clients/installer/version-drift.test.ts).
					child.removeListener?.("close", finish);
					finishIdleWait();
				};
				// The `closeSeen` fast-path above catches the common case (close
				// already happened by the time we get here). This listener is
				// the fallback for the rare case where `close` genuinely lands
				// DURING the wait — e.g. a child whose stdio takes a beat
				// longer than usual to release, but still well under the grace
				// window. `close` is a stronger signal than "no data for
				// EXIT_PIPE_IDLE_GRACE_MS", so finishing on it here still beats
				// waiting out the timer. The anti-hang property is untouched
				// either way: a daemonized descendant holding the pipe open is
				// EXACTLY the case where `close` never fires at all, so the
				// grace/cap timers still bound that case as before.
				child.on("close", finish);
				rearmIdleGrace = (): void => {
					if (graceTimer) clearTimeout(graceTimer);
					graceTimer = setTimeout(finish, EXIT_PIPE_IDLE_GRACE_MS);
				};
				rearmIdleGrace();
			});
		};

		// Process completion
		//
		// #1656 x #1651/#1670: finalize off BOTH `exit` and `close`, not just
		// one — each covers a shape the other misses.
		//   - `exit` is what unblocks the #1656 hang: a daemonized descendant
		//     that inherited our stdout/stderr pipe can hold that fd open
		//     forever, so `close` (which waits for every fd referencing the
		//     child to release) never fires even though the child we spawned
		//     is long dead. `exit` always fires once the child itself exits,
		//     independent of who still holds its pipes.
		//   - `close` is still wired because a child that never actually
		//     launched (bad binary, EACCES, ...) gets NO `exit` event at all —
		//     Node only emits `error` then `close(code<0, null)` for that
		//     shape (#1651/#1670's shape guard below decides from exactly
		//     this). `exit`-only would make that guard unreachable.
		// Whichever fires first drives `finalize`; `settled` (distinct from
		// `resolved`, which `finalize` itself owns) stops the second event
		// from dispatching a redundant, concurrently-racing `finalize` call —
		// double-invoking it would double-run `waitForPipeIdle` and
		// `finishResourceUsage` against the same child.
		let settled = false;
		const onChildSettle = (
			code: number | null,
			signal: NodeJS.Signals | null,
		): void => {
			if (settled || resolved) return;
			settled = true;
			closed = true;
			clearTimeout(timeoutId);
			abortSignal?.removeEventListener("abort", onAbort);
			if (child.pid) lifetimeState.pids.delete(child.pid);
			void finalize(code, signal);
		};

		const finalize = async (
			code: number | null,
			signal: NodeJS.Signals | null,
		): Promise<void> => {
			// Belt, not the decision: whichever path settles `resolved` FIRST
			// wins. A healthy run's outcome must never be discarded by a late,
			// unrelated 'error' (e.g. a post-exit kill() that itself failed
			// with EPERM, #1651 review F4) — so this only bails when something
			// else has ALREADY resolved, never on `error` merely having fired.
			await killPromise;
			if (resolved) return;
			// #1109: the child has exited - clear the non-Windows escalation
			// timer so it doesn't linger as a ref'd handle. #2027 EXCEPTION:
			// in POSIX group mode the timer is the liveness-gated SIGKILL
			// backstop for SIGTERM-hardy grandchildren; it stays armed and
			// self-cleans within 1s of firing (max 1s ref'd tail).
			if (escalationTimer && !posixProcessGroup) {
				clearTimeout(escalationTimer);
			}
			// #1673 review F1: latch the verdict as DECIDED here, before the
			// idle-pipe wait — not after it. `code`/`signal`/`timedOut`/`aborted`
			// are already fixed by this point (they don't change during the
			// wait), so nothing below depends on staying unresolved across it.
			// Leaving `resolved` false across the wait would reopen the exact
			// race #1651 review F4 closed: a late, unrelated 'error' (e.g. a
			// post-exit kill() failing with EPERM) landing inside the
			// idle-grace window (bounded, but up to EXIT_PIPE_IDLE_MAX_WAIT_MS)
			// would steal an already-decided healthy verdict. Pre-#1656 that
			// race window was one microtask — the gap between `close` firing
			// and `resolve()` being called synchronously in the same handler.
			// This closes the window back down to that same shape instead of
			// widening it to the whole wait.
			resolved = true;
			await waitForPipeIdle();
			const resourceUsage = finishResourceUsage();

			const outputInfo = {
				...(outputTruncated ? { outputTruncated: true } : {}),
				...(killedForOutputCap ? { killedForOutputCap: true } : {}),
			};
			const streamingMatchInfo = streamingMatch ? { streamingMatch: true } : {};
			// #1816: surface the signal name as a field on every path where one
			// exists, so callers can NAME it instead of scraping `error.message`.
			const signalInfo = signal ? { signal } : {};
			if (timedOut) {
				const cause = new Error(
					`Process timed out after ${timeout}ms (killed with ${signal || "SIGTERM"})`,
				);
				// #2010: teardown evidence lives ONLY on the timeout path - it
				// describes how long the tree took to die after the budget
				// expired, and how it died ("exited" = the child beat the signal;
				// "killed-by-signal" / "escalate-kill" = how WE ended it).
				const timeoutTeardown = resolveTeardownOutcome({
					killStartedAtMs: teardownStartedAtMs,
					deathObservedAtMs: closedAtMs,
					escalated: teardownEscalated,
				});
				resolve({
					stdout,
					stderr,
					status: null,
					error: cause,
					failure: "timeout",
					...signalInfo,
					...(timeoutTeardown && { timeoutTeardown }),
					spawnFailure: new SpawnFailureError("timeout", cause.message, cause),
					...outputInfo,
					...streamingMatchInfo,
					resourceUsage,
				});
			} else if (aborted) {
				const cause = new Error("Spawn aborted");
				resolve({
					stdout,
					stderr,
					status: null,
					error: cause,
					failure: "aborted",
					...signalInfo,
					spawnFailure: new SpawnFailureError("killed", cause.message, cause),
					...outputInfo,
					...streamingMatchInfo,
					resourceUsage,
				});
			} else if (signal) {
				const cause = new Error(`Process killed by signal: ${signal}`);
				resolve({
					stdout,
					stderr,
					status: null,
					error: cause,
					failure: "signal",
					...signalInfo,
					spawnFailure: new SpawnFailureError("killed", cause.message, cause),
					...outputInfo,
					...streamingMatchInfo,
					resourceUsage,
				});
			} else if (code === null || code < 0) {
				// #1651 review F3: a real completed process never exits with a
				// null or negative code (Node reports the negated libuv/errno for
				// a child that never launched — e.g. ENOENT: -2 on Linux, -4058
				// on Windows). This decides from that SHAPE alone, independent of
				// whether/when 'error' has fired — Node's docs leave the
				// 'error'/'close' ordering for a failed spawn unspecified, and a
				// same-microtask re-check (the #1651 first-round fix) still loses
				// if 'error' lands a tick later via setImmediate/nextTick.
				// Reuse `pendingSpawnError` when 'error' already landed (a more
				// informative Error — ENOENT vs EACCES vs other); otherwise
				// synthesize an ENOENT-shaped one so a genuinely missing tool is
				// never read as a clean, answered run.
				const cause = pendingSpawnError ?? synthesizeEnoentError(command);
				const spawnFailure = await classifySpawnFailure(cause, {
					command,
					cwd: options?.cwd,
				});
				resolve({
					stdout,
					stderr,
					status: code,
					error: cause,
					failure: "spawn",
					spawnFailure,
					...outputInfo,
					...streamingMatchInfo,
					resourceUsage,
				});
			} else {
				resolve({
					stdout,
					stderr,
					status: code,
					...outputInfo,
					...streamingMatchInfo,
					resourceUsage,
				});
			}
		};

		child.on("exit", onChildSettle);
		child.on("close", onChildSettle);

		child.on("error", (err) => {
			// Capture unconditionally — even when `close` already resolved, this
			// keeps the most recent Error available for anyone reading state
			// mid-flight, and costs nothing (the assignment, not a resolve).
			pendingSpawnError = err;
			// A completed run's own verdict must never be downgraded by an
			// unrelated LATE error (#1651 review F4 — e.g. a post-exit kill()
			// failing with EPERM after `close(0, null)` already answered).
			if (resolved) return;
			resolved = true;
			closed = true;
			clearTimeout(timeoutId);
			abortSignal?.removeEventListener("abort", onAbort);
			// #2027: group-mode timer stays armed as the grandchild backstop.
			if (escalationTimer && !posixProcessGroup) {
				clearTimeout(escalationTimer);
			}
			if (child.pid) lifetimeState.pids.delete(child.pid);
			const resourceUsage = finishResourceUsage();
			let failure: SpawnFailureKind = "spawn";
			if (aborted) failure = "aborted";
			else if (timedOut) failure = "timeout";
			const controlFailure = aborted
				? new SpawnFailureError("killed", err.message, err)
				: timedOut
					? new SpawnFailureError("timeout", err.message, err)
					: undefined;
			const finish = (spawnFailure: SpawnFailureError): void =>
				resolve({
					stdout,
					stderr,
					status: null,
					error: err,
					failure,
					spawnFailure,
					...(outputTruncated ? { outputTruncated: true } : {}),
					...(killedForOutputCap ? { killedForOutputCap: true } : {}),
					...(streamingMatch ? { streamingMatch: true } : {}),
					resourceUsage,
				});
			if (controlFailure) finish(controlFailure);
			else {
				void classifySpawnFailure(err, { command, cwd: options?.cwd }).then(
					finish,
				);
			}
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
	const spawnEnv = getSpawnEnvironment(options?.env);
	if (process.platform === "win32") {
		// See the matching comment in safeSpawnAsync: the child's cwd doesn't
		// need OUR validation (Windows resolves it natively), so an unprovable
		// drive-relative cwd falls back to the raw value instead of failing the
		// whole spawn before ever attempting it (#1201). Command resolution
		// below intentionally still uses the ORIGINAL raw cwd and fails closed
		// for PATH entries that would need it to be canonical.
		// See safeSpawnAsync for why there is no `?? process.cwd()` third arm.
		const spawnCwd =
			resolveEffectiveWindowsCwd(options?.cwd, spawnEnv) ?? options?.cwd;
		const resolved = resolveWindowsCommand(command, options?.cwd, spawnEnv);
		if (!resolved) {
			const error = synthesizeEnoentError(command);
			return {
				stdout: "",
				stderr: "",
				status: null,
				error,
				failure: "spawn",
				spawnFailure: classifySpawnFailureSync(error, {
					command,
					cwd: options?.cwd,
				}),
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
				const error = new Error(
					`Refusing to spawn "${resolved.resolvedPath}" via cmd.exe: ` +
						`${JSON.stringify(unsafeValue)} contains a character ("` +
						`, %, !, or CR/LF) that cannot be safely escaped on a ` +
						`cmd.exe /c command line (CWE-78, #817). Rename/quote the ` +
						"value or invoke the tool without going through cmd.exe.",
				);
				return {
					stdout: "",
					stderr: "",
					status: null,
					error,
					failure: "spawn",
					spawnFailure: classifySpawnFailureSync(error, {
						command,
						cwd: options?.cwd,
					}),
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
			cwd: spawnCwd,
			env: spawnEnv,
			encoding: "utf-8",
			shell: false,
			windowsHide: true,
			windowsVerbatimArguments,
		});

		const spawnFailure = result.error
			? classifySpawnFailureSync(result.error, { command, cwd: options?.cwd })
			: undefined;
		return {
			stdout: result.stdout?.toString() || "",
			stderr: result.stderr?.toString() || "",
			status: result.status,
			error: result.error,
			...(spawnFailure ? { failure: "spawn" as const, spawnFailure } : {}),
		};
	}

	const result = spawnSync(command, args, {
		...(options as SpawnOptions),
		// Explicit override, not just the spread above: `options.env` alone
		// would otherwise reach the child as a full replacement (no
		// process.env merge, no PATH) instead of the merged environment the
		// resolver/Windows branch above both use (#1201) — the module's
		// "resolver and child receive the same merged environment" invariant
		// must hold on every platform, not just Windows.
		env: spawnEnv,
		encoding: "utf-8",
		shell: false,
		windowsHide: true,
	});

	const spawnFailure = result.error
		? classifySpawnFailureSync(result.error, { command, cwd: options?.cwd })
		: undefined;
	return {
		stdout: result.stdout?.toString() || "",
		stderr: result.stderr?.toString() || "",
		status: result.status,
		error: result.error,
		...(spawnFailure ? { failure: "spawn" as const, spawnFailure } : {}),
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
