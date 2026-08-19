/**
 * Shared runner utilities for pi-lens dispatch system
 *
 * Extracted common patterns from multiple runners to reduce duplication:
 * - Venv-aware command finders
 * - Availability checkers with caching
 * - Config file finders
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { logSessionStart } from "../../../sessionstart-logger.js";
import { getGlobalPiLensDir } from "../../../file-utils.js";
import { PathKeyedMap } from "../../../path-keyed-map.js";
import {
	normalizeEphemeralMapKey,
	normalizeMapKey,
} from "../../../path-utils.js";
import {
	ensureTool,
	isSpawnableCommand,
	resetPathWalkMemo,
} from "../../../installer/index.js";
import {
	getServersForFileWithConfig,
	isServerDisabled,
} from "../../../lsp/config.js";
import { findGlobalBinary } from "../../../package-manager.js";
import { safeSpawnAsync } from "../../../safe-spawn.js";
import {
	getToolCommandSpec,
	shouldAutoInstallTool,
} from "../../../tool-policy.js";
import type { DispatchContext } from "../../types.js";
import {
	type AvailabilityCause,
	type AvailabilityOutcome,
	classifyProbeFailure,
	createAvailabilityLatch,
	isLatchingOutcome,
	logAvailabilityDecision,
	startHostStallSampler,
	transientRetryDelayMs,
} from "./availability-policy.js";

export type {
	AvailabilityCause,
	AvailabilityDecision,
	AvailabilityOutcome,
} from "./availability-policy.js";
export {
	createAvailabilityLatch,
	classifyProbeFailure,
	describeUnavailability,
	isTransientDecision,
	logAvailabilityDecision,
	startHostStallSampler,
} from "./availability-policy.js";

/**
 * True when the LSP runner will cover `ctx.filePath` via the given PRIMARY server
 * id. Used by CLI runners that duplicate a linter a warm LSP already wraps
 * (taplo↔`toml` LSP = `taplo lsp`; shellcheck↔`bash` LSP runs shellcheck
 * internally) so they SELF-SKIP and stop double-reporting the same findings (#233)
 * — the same dormant-when-LSP-covers pattern the ast-grep napi runner uses.
 *
 * Non-spawning and conservative: honors the `no-lsp` kill switch + per-server
 * disable/config, and only matches when this server is the SELECTED primary for
 * the file (first non-auxiliary candidate). The caller additionally gates on tool
 * availability, so coverage never regresses when the LSP is absent/disabled.
 */
export function lspPrimaryCoversFile(
	ctx: DispatchContext,
	serverId: string,
): boolean {
	if (ctx.pi?.getFlag?.("no-lsp")) return false;
	if (isServerDisabled(serverId, ctx.filePath)) return false;
	const primary = getServersForFileWithConfig(ctx.filePath).find(
		(s) => s.role !== "auxiliary",
	);
	return primary?.id === serverId;
}

/**
 * Walk up from startDir until we find a directory containing node_modules/.bin.
 * Returns all such roots found up to the filesystem root — not just the nearest —
 * so callers can search them all for a specific binary.
 */
function findNodeBinRoots(startDir: string): string[] {
	const roots: string[] = [];
	let current = startDir;
	const fsRoot = path.parse(current).root;
	while (current !== fsRoot) {
		if (fs.existsSync(path.join(current, "node_modules", ".bin"))) {
			roots.push(current);
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return roots;
}

let _thisDir = path.dirname(fileURLToPath(import.meta.url));
if (typeof __dirname !== "undefined") {
	_thisDir = __dirname;
}

// Managed tools directory (~/.pi-lens/tools) — where ensureTool() installs binaries
const _managedToolsDir = path.join(getGlobalPiLensDir(), "tools");

/**
 * The managed shim for a Node CLI tool (`~/.pi-lens/tools/node_modules/.bin/<tool>`),
 * or null when it is not on disk.
 *
 * When the shim exists the tool IS installed, so availability needs no spawn at
 * all — and a spawn that cannot happen cannot time out (#1467). knip and jscpd
 * each carried a line-for-line copy of this resolver; #1476 folds them into one
 * definition so the next managed tool inherits the fast path instead of a
 * fourth copy.
 *
 * The pi-lens dir is read per call, never memoized at module load, so tests that
 * point `getGlobalPiLensDir` at a temp home still see their own tree.
 */
export function findManagedNodeToolBinary(tool: string): string | null {
	const base = path.join(
		getGlobalPiLensDir(),
		"tools",
		"node_modules",
		".bin",
		tool,
	);
	const candidates =
		process.platform === "win32" ? [`${base}.cmd`, `${base}.exe`, base] : [base];
	try {
		return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
	} catch {
		return null;
	}
}

// =============================================================================
// VENV-AWARE COMMAND FINDER
// =============================================================================

/**
 * Find a command in venv first, then fall back to global.
 * Checks common venv locations (.venv, venv) before trying global.
 *
 * The resolved path is returned verbatim: every spawn consumer runs with
 * `shell: false` (safe-spawn, #817), so wrapping it in quotes would make it
 * a literal filename that ENOENTs on every platform (#1508).
 */
export function createVenvFinder(
	command: string,
	windowsExt = "",
): (cwd: string) => string {
	return (cwd: string): string => {
		const venvPaths = [
			`.venv/bin/${command}`,
			`venv/bin/${command}`,
			`.venv/Scripts/${command}${windowsExt}`,
			`venv/Scripts/${command}${windowsExt}`,
		];

		for (const venvPath of venvPaths) {
			const fullPath = path.join(cwd, venvPath);
			if (fs.existsSync(fullPath)) {
				return fullPath;
			}
		}

		// Fall back to global
		return command;
	};
}

// =============================================================================
// AVAILABILITY CHECKER FACTORY
// =============================================================================

export type ClientAvailabilityResult<T> =
	| { outcome: "success"; value: T }
	| { outcome: Exclude<AvailabilityOutcome, "success">; value?: undefined };

/** Typed client-facing install seam for ordered/custom candidate probes. */
export async function resolveManagedToolClient<T>(options: {
	toolId: string;
	cwd: string;
	probe: () => Promise<ClientAvailabilityResult<T>>;
	acceptInstalled: (path: string) => Promise<T | null> | T | null;
}): Promise<ClientAvailabilityResult<T>> {
	const probed = await options.probe();
	if (probed.outcome !== "missing") return probed;
	if (!shouldAutoInstallTool(options.toolId)) return probed;
	const state = installStateFor(options.cwd, options.toolId);
	if (state.suppressed) return probed;
	const installed = await ensureTool(options.toolId);
	if (!installed) {
		noteInstallFailure(options.toolId, options.cwd);
		return probed;
	}
	const value = await options.acceptInstalled(installed);
	if (value === null) {
		noteInstallFailure(options.toolId, options.cwd);
		return { outcome: "non-installable" };
	}
	noteInstallSuccess(options.toolId, options.cwd);
	return { outcome: "success", value };
}

type AvailabilityCache = {
	available: boolean | null;
	command: string | null;
	outcome: AvailabilityOutcome | null;
	cause: AvailabilityCause | null;
	/** How long the last probe took, ms — surfaced in the unavailable message. */
	elapsedMs: number;
	/** Epoch ms after which a transient `false` may be re-probed; 0 = latched. */
	retryAtMs: number;
	/** Consecutive transient failures, for the bounded exponential cooldown. */
	transientAttempts: number;
};

export interface AvailabilityCheckerOptions {
	probeTimeout?: number;
	fastPath?: () => string | null;
	/** Environment used by both the availability probe and later client spawns. */
	environment?: (cwd: string) => Promise<NodeJS.ProcessEnv>;
	/** Compatibility for legacy probes whose test doubles carry no failure kind. */
	unclassifiedFailureOutcome?: AvailabilityOutcome;
}

/**
 * Child environment for managed-installable tools. Keeping this beside the
 * probe/install seam makes managed npm shims visible to every standalone
 * client, rather than only to Knip (#1289).
 */
export async function getManagedToolEnvironment(
	_toolId: string,
	cwd?: string,
): Promise<NodeJS.ProcessEnv> {
	let env: NodeJS.ProcessEnv;
	try {
		const { getToolEnvironment } = await import("../../../installer/index.js");
		env = await getToolEnvironment();
	} catch {
		// Installer-isolated unit tests historically mock only ensureTool. The
		// ambient fallback preserves that isolation; production always exports it.
		env = { ...process.env };
	}
	if (!cwd) return env;
	const separator = process.platform === "win32" ? ";" : ":";
	const currentPath = env.PATH || env.Path || process.env.PATH || "";
	const localBin = path.join(cwd, "node_modules", ".bin");
	const augmentedPath = `${localBin}${separator}${currentPath}`;
	return {
		...env,
		PATH: augmentedPath,
		...(process.platform === "win32" ? { Path: augmentedPath } : {}),
	};
}

/** Read-only managed/PATH discovery for spawn-time resolution memos. */
export async function discoverManagedTool(
	toolId: string,
): Promise<string | null> {
	return (await ensureTool(toolId, { allowInstall: false })) ?? null;
}

type InstallAttemptState = {
	attempts: number;
	suppressed: boolean;
};

// This is session-scoped state, not a process-global tool/path cache. The cwd
// key is normalized by PathKeyedMap and is cleared at session_start. A failed
// install must not become an install attempt on every eligible file/turn.
const installAttemptsByCwd = new PathKeyedMap<Map<string, InstallAttemptState>>(
	normalizeMapKey,
);
const resolveInstallInFlightByCwd = new PathKeyedMap<
	Map<string, Promise<string | null>>
>(normalizeEphemeralMapKey);
// Checkers are created by runner modules and may also be created dynamically.
// Keep the session reset as a generation rather than retaining every checker
// reset closure forever.
let availabilityStateGeneration = 0;

function installStateFor(cwd: string, toolId: string): InstallAttemptState {
	let states = installAttemptsByCwd.get(cwd);
	if (!states) {
		states = new Map();
		installAttemptsByCwd.set(cwd, states);
	}
	let state = states.get(toolId);
	if (!state) {
		state = { attempts: 0, suppressed: false };
		states.set(toolId, state);
	}
	return state;
}

function noteInstallFailure(toolId: string, cwd: string): void {
	const state = installStateFor(cwd, toolId);
	state.attempts += 1;
	state.suppressed = true;
	logSessionStart(
		`dispatch availability ${toolId}: install attempt ${state.attempts} failed; suppressing retries until the next session or a successful install`,
	);
}

function noteInstallSuccess(toolId: string, cwd: string): void {
	const states = installAttemptsByCwd.get(cwd);
	states?.delete(toolId);
	if (states?.size === 0) installAttemptsByCwd.delete(cwd);
}

/** Reset availability/install suppression at the session boundary. */
export function resetDispatchAvailabilityState(): void {
	installAttemptsByCwd.clear();
	resolveInstallInFlightByCwd.clear();
	resetPathWalkMemo();
	availabilityStateGeneration += 1;
}

/** What the last probe for a cwd decided, for messaging and telemetry (#1467). */
export interface AvailabilityVerdict {
	outcome: AvailabilityOutcome | null;
	cause: AvailabilityCause | null;
	elapsedMs: number;
	/** True when the verdict is remembered until the next session reset. */
	latched: boolean;
	/** Epoch ms after which a transient verdict may be re-probed; 0 = latched. */
	retryAtMs: number;
}

/**
 * Create a cached availability checker for a command.
 * The checker will look for the command in venv first, then global.
 *
 * `versionArgs` defaults to `["--version"]` but some tools reject that flag and
 * expose version under a subcommand instead (e.g. `zig version`, not
 * `zig --version`). Passing the wrong probe makes the runner silently skip on
 * every machine, so toolchains with a non-standard version command must override
 * this.
 *
 * ## Latch policy (#1467)
 *
 * A `missing` / `non-installable` verdict is durable and is cached for the
 * session. A `transient` verdict — timeout, abort, EAGAIN — is NOT: it is
 * cached only for a bounded cooldown, after which the next caller re-probes.
 * An installed tool therefore recovers on its own, without a host restart.
 */
export function createAvailabilityChecker(
	command: string,
	windowsExt = "",
	versionArgs: string[] = ["--version"],
	options: AvailabilityCheckerOptions = {},
): {
	isAvailableAsync: (cwd?: string) => Promise<boolean>;
	getCommand: (cwd?: string) => string | null;
	getOutcome: (cwd?: string) => AvailabilityOutcome | null;
	getVerdict: (cwd?: string) => AvailabilityVerdict;
	reset: () => void;
} {
	const cacheByCwd = new PathKeyedMap<AvailabilityCache>(
		normalizeEphemeralMapKey,
	);
	const inFlightByCwd = new PathKeyedMap<Promise<boolean>>(
		normalizeEphemeralMapKey,
	);
	let checkerGeneration = availabilityStateGeneration;

	const findCommand = createVenvFinder(command, windowsExt);

	function ensureCurrentGeneration(): void {
		if (checkerGeneration === availabilityStateGeneration) return;
		cacheByCwd.clear();
		inFlightByCwd.clear();
		checkerGeneration = availabilityStateGeneration;
	}

	const reset = (): void => {
		cacheByCwd.clear();
		inFlightByCwd.clear();
		checkerGeneration = availabilityStateGeneration;
	};

	function getCache(cwd: string): AvailabilityCache {
		ensureCurrentGeneration();
		const resolvedCwd = path.resolve(cwd || process.cwd());
		const pathHash = createHash("sha256")
			.update(process.env.PATH ?? "")
			.digest("hex")
			.slice(0, 8);
		const key = `${resolvedCwd}|${pathHash}`;
		const existing = cacheByCwd.get(key);
		if (existing) return existing;
		const created: AvailabilityCache = {
			available: null,
			command: null,
			outcome: null,
			cause: null,
			elapsedMs: 0,
			retryAtMs: 0,
			transientAttempts: 0,
		};
		cacheByCwd.set(key, created);
		return created;
	}

	/** Record a verdict on the cache and emit exactly one decision record. */
	function noteDecision(
		cache: AvailabilityCache,
		resolvedCwd: string,
		verdict: {
			available: boolean;
			outcome: AvailabilityOutcome;
			cause: AvailabilityCause;
			elapsedMs: number;
			hostStallMs?: number;
		},
	): void {
		cache.available = verdict.available;
		cache.outcome = verdict.outcome;
		cache.cause = verdict.cause;
		cache.elapsedMs = verdict.elapsedMs;
		let retryAfterMs: number | undefined;
		if (verdict.available) {
			cache.retryAtMs = 0;
			cache.transientAttempts = 0;
		} else if (isLatchingOutcome(verdict.outcome)) {
			cache.retryAtMs = 0;
			cache.transientAttempts = 0;
		} else {
			cache.transientAttempts += 1;
			retryAfterMs = transientRetryDelayMs(cache.transientAttempts, verdict.cause);
			cache.retryAtMs = Date.now() + retryAfterMs;
		}
		logAvailabilityDecision(
			{
				tool: command,
				verdict: verdict.available ? "available" : "unavailable",
				outcome: verdict.outcome,
				cause: verdict.cause,
				elapsedMs: verdict.elapsedMs,
				latched: verdict.available || isLatchingOutcome(verdict.outcome),
				...(verdict.hostStallMs !== undefined && {
					hostStallMs: verdict.hostStallMs,
				}),
				...(retryAfterMs !== undefined && { retryAfterMs }),
				budgetMs: options.probeTimeout ?? 5000,
			},
			resolvedCwd,
		);
	}

	async function isAvailableAsync(cwd?: string): Promise<boolean> {
		ensureCurrentGeneration();
		const resolvedCwd = cwd || process.cwd();
		const cache = getCache(resolvedCwd);
		if (cache.available === false) {
			// A durable "this machine does not have the tool" stays cached; a
			// transient probe failure only holds until its cooldown expires, so an
			// installed tool cannot be disabled for the life of the process by one
			// slow second at warm-up (#1467).
			if (cache.outcome !== "transient") return false;
			if (Date.now() < cache.retryAtMs) return false;
			cache.available = null;
		}
		if (cache.available === true && cache.command) {
			if (await isSpawnableCommand(cache.command)) return true;
			// Cached-positive spawn feedback: a removed absolute path or vanished
			// PATH command must fall through to a fresh probe immediately.
			cache.available = null;
			cache.command = null;
			cache.outcome = null;
			cache.cause = null;
		}

		const key = path.resolve(resolvedCwd);
		const existing = inFlightByCwd.get(key);
		if (existing) return existing;

		const promiseGeneration = checkerGeneration;
		let promise: Promise<boolean>;
		promise = (async () => {
			const fastPath = options.fastPath?.();
			if (fastPath) {
				cache.command = fastPath;
				noteDecision(cache, resolvedCwd, {
					available: true,
					outcome: "success",
					cause: "fast-path",
					elapsedMs: 0,
				});
				return true;
			}

			// A bad/removed workspace must not be mistaken for a missing tool and
			// trigger an install. This async probe stays off the synchronous dispatch
			// burst and makes the failure taxonomy explicit at the seam.
			try {
				const cwdStat = await fs.promises.stat(resolvedCwd);
				if (!cwdStat.isDirectory()) {
					noteDecision(cache, resolvedCwd, {
						available: false,
						outcome: "non-installable",
						cause: "bad-cwd",
						elapsedMs: 0,
					});
					return false;
				}
			} catch {
				noteDecision(cache, resolvedCwd, {
					available: false,
					outcome: "non-installable",
					cause: "bad-cwd",
					elapsedMs: 0,
				});
				return false;
			}

			const cmd = findCommand(resolvedCwd);
			const env = await options.environment?.(resolvedCwd);
			// The probe budget is enforced by a HOST-side timer, so host event-loop
			// stalls are charged to the child. Measure the stall that overlapped the
			// window and hand it to the classifier (#1467).
			const stallSampler = startHostStallSampler();
			const startedAt = Date.now();
			let result: Awaited<ReturnType<typeof safeSpawnAsync>>;
			let hostStallMs: number;
			try {
				result = await safeSpawnAsync(cmd, versionArgs, {
					timeout: options.probeTimeout ?? 5000,
					cwd: resolvedCwd,
					env,
				});
			} finally {
				hostStallMs = stallSampler.stop();
			}
			const elapsedMs = Date.now() - startedAt;

			if (!result.error && result.status === 0) {
				cache.command = cmd;
				noteDecision(cache, resolvedCwd, {
					available: true,
					outcome: "success",
					cause: "ok",
					elapsedMs,
					hostStallMs,
				});
				return true;
			}

			const { outcome, cause } = classifyProbeFailure(result, {
				hostStallMs,
				unclassifiedFailureOutcome: options.unclassifiedFailureOutcome,
			});
			// Only a TYPED tool-not-found invalidates the PATH walk memo; an
			// `unclassifiedFailureOutcome: "missing"` compatibility verdict is a
			// guess, not evidence that PATH changed.
			if (result.spawnFailure?.kind === "tool-not-found") resetPathWalkMemo();
			noteDecision(cache, resolvedCwd, {
				available: false,
				outcome,
				cause,
				elapsedMs,
				hostStallMs,
			});
			return false;
		})().finally(() => {
			// A session reset clears this map and a caller may immediately start a
			// replacement probe for the same cwd. The old promise must not delete
			// that newer-generation entry when it settles.
			if (
				checkerGeneration === promiseGeneration &&
				inFlightByCwd.get(key) === promise
			) {
				inFlightByCwd.delete(key);
			}
		});
		inFlightByCwd.set(key, promise);
		return promise;
	}

	function getCommand(cwd?: string): string | null {
		ensureCurrentGeneration();
		const cache = getCache(cwd || process.cwd());
		return cache.command;
	}

	function getOutcome(cwd?: string): AvailabilityOutcome | null {
		ensureCurrentGeneration();
		return getCache(cwd || process.cwd()).outcome;
	}

	function getVerdict(cwd?: string): AvailabilityVerdict {
		ensureCurrentGeneration();
		const cache = getCache(cwd || process.cwd());
		return {
			outcome: cache.outcome,
			cause: cache.cause,
			elapsedMs: cache.elapsedMs,
			latched:
				cache.available !== false || isLatchingOutcome(cache.outcome ?? "missing"),
			retryAtMs: cache.retryAtMs,
		};
	}

	return { isAvailableAsync, getCommand, getOutcome, getVerdict, reset };
}

/**
 * Per-cwd cached availability probe for spawn signatures that don't fit
 * `createAvailabilityChecker` — multi-arg subcommands like `npx biome
 * --version`, `cargo clippy --version`, `mix credo --version`, or a
 * dynamically-resolved `<cmd> --version`. Each cwd is probed at most once;
 * concurrent first-time callers share the in-flight promise.
 *
 * The cache stores the boolean outcome forever (same shape as
 * `createAvailabilityChecker`): once known unavailable for a cwd, the
 * runner stays skipped for that cwd until the process restarts. Pass a
 * fresh probe for retry-after-install flows.
 */
export function createCwdCachedProbe(
	probe: (cwd: string) => Promise<boolean>,
): (cwd: string) => Promise<boolean> {
	const cacheByCwd = new PathKeyedMap<Promise<boolean>>(
		normalizeEphemeralMapKey,
	);
	let probeGeneration = availabilityStateGeneration;
	return (cwd: string) => {
		if (probeGeneration !== availabilityStateGeneration) {
			cacheByCwd.clear();
			probeGeneration = availabilityStateGeneration;
		}
		const key = path.resolve(cwd || process.cwd());
		const existing = cacheByCwd.get(key);
		if (existing) return existing;
		const promise = probe(key).catch(() => false);
		cacheByCwd.set(key, promise);
		return promise;
	};
}

export function resolveNodeToolCommand(
	cwd: string,
	toolName: string,
	windowsExt = ".cmd",
): string {
	const isWin = process.platform === "win32";
	const binName = isWin ? `${toolName}${windowsExt}` : toolName;
	const local = path.join(cwd, "node_modules", ".bin", binName);
	if (fs.existsSync(local)) return local;
	return toolName;
}

export function resolveToolCommand(cwd: string, toolId: string): string | null {
	const spec = getToolCommandSpec(toolId);
	if (!spec) return null;
	return resolveNodeToolCommand(cwd, spec.command, spec.windowsExt ?? ".cmd");
}

export function resolveVendorToolCommand(
	cwd: string,
	toolName: string,
	windowsExt = ".bat",
): string | null {
	const isWin = process.platform === "win32";
	const candidates = isWin
		? [
				path.join("vendor", "bin", `${toolName}${windowsExt}`),
				path.join("vendor", "bin", toolName),
			]
		: [path.join("vendor", "bin", toolName)];
	let dir = cwd;
	const root = path.parse(dir).root;
	while (true) {
		for (const candidate of candidates) {
			const full = path.join(dir, candidate);
			if (fs.existsSync(full)) return full;
		}
		if (dir === root) break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

export async function resolveToolCommandWithInstallFallback(
	cwd: string,
	toolId: string,
	timeout = 5000,
): Promise<string | null> {
	const spec = getToolCommandSpec(toolId);
	if (!spec) return null;
	return resolveCommandWithInstallFallback(
		resolveToolCommand(cwd, toolId) ?? spec.command,
		spec.managedToolId ?? toolId,
		cwd,
		spec.versionArgs ?? ["--version"],
		timeout,
	);
}

async function verifyOrInstallCommand(
	command: string,
	toolId: string,
	cwd: string,
	versionArgs: string[] = ["--version"],
	timeout = 5000,
): Promise<string | null> {
	// Skip the --version spawn when the command isn't even on disk — the ~μs
	// stat/PATH walk beats a guaranteed-to-fail spawn round-trip.
	const spawnable = await isSpawnableCommand(command);
	if (spawnable) {
		const versionCheck = await safeSpawnAsync(command, versionArgs, {
			timeout,
			cwd,
		});
		if (!versionCheck.error && versionCheck.status === 0) {
			return command;
		}
		// A command that was found but rejected its probe is not fixed by a
		// reinstall. This also covers permissions and malformed shims.
		return null;
	}
	if (!shouldAutoInstallTool(toolId)) return null;

	const state = installStateFor(cwd, toolId);
	if (state.suppressed) return null;
	const installed = await ensureTool(toolId);
	if (installed) {
		noteInstallSuccess(toolId, cwd);
		return installed;
	}
	noteInstallFailure(toolId, cwd);
	return null;
}

export async function resolveCommandArgsWithInstallFallback(
	command: { cmd: string; args: string[] },
	toolId: string,
	cwd: string,
	versionArgs: string[] = ["--version"],
	timeout = 5000,
): Promise<{ cmd: string; args: string[] } | null> {
	const versionCheck = await safeSpawnAsync(
		command.cmd,
		[...command.args, ...versionArgs],
		{ timeout, cwd },
	);
	if (!versionCheck.error && versionCheck.status === 0) {
		return command;
	}
	const installed = await verifyOrInstallCommand(
		command.cmd,
		toolId,
		cwd,
		versionArgs,
		timeout,
	);
	if (!installed) {
		return null;
	}
	if (installed === command.cmd) {
		return command;
	}
	return { cmd: installed, args: [] };
}

export async function resolveCommandWithInstallFallback(
	command: string,
	toolId: string,
	cwd: string,
	versionArgs: string[] = ["--version"],
	timeout = 5000,
): Promise<string | null> {
	return verifyOrInstallCommand(command, toolId, cwd, versionArgs, timeout);
}

async function resolveAvailableOrInstallUnshared(
	checker: {
		isAvailableAsync: (cwd?: string) => Promise<boolean>;
		getCommand: (cwd?: string) => string | null;
		getOutcome?: (cwd?: string) => AvailabilityOutcome | null;
		reset?: () => void;
	},
	toolId: string,
	cwd: string,
): Promise<string | null> {
	const available = await checker.isAvailableAsync(cwd);
	if (available) {
		return checker.getCommand(cwd);
	}
	// Only a typed ENOENT/missing-command result is repairable by installing.
	// Probe failures caused by bad cwd, permissions, rejected flags, aborts, and
	// timeouts are unavailable/non-installable and must not enter an install loop.
	if (checker.getOutcome?.(cwd) !== "missing") return null;
	if (!shouldAutoInstallTool(toolId)) return null;

	const state = installStateFor(cwd, toolId);
	if (state.suppressed) {
		return null;
	}
	const installed = await ensureTool(toolId);
	if (installed) {
		noteInstallSuccess(toolId, cwd);
		checker.reset?.();
		return installed;
	}
	noteInstallFailure(toolId, cwd);
	return null;
}

/** Share the complete probe/install transaction for each cwd/tool pair. */
export function resolveAvailableOrInstall(
	checker: {
		isAvailableAsync: (cwd?: string) => Promise<boolean>;
		getCommand: (cwd?: string) => string | null;
		getOutcome?: (cwd?: string) => AvailabilityOutcome | null;
		reset?: () => void;
	},
	toolId: string,
	cwd: string,
): Promise<string | null> {
	const key = normalizeEphemeralMapKey(cwd);
	let byTool = resolveInstallInFlightByCwd.get(key);
	if (!byTool) {
		byTool = new Map();
		resolveInstallInFlightByCwd.set(key, byTool);
	}
	const existing = byTool.get(toolId);
	if (existing) return existing;

	const generation = availabilityStateGeneration;
	const promise = resolveAvailableOrInstallUnshared(
		checker,
		toolId,
		cwd,
	).finally(() => {
		if (generation !== availabilityStateGeneration) return;
		const current = resolveInstallInFlightByCwd.get(key);
		if (current?.get(toolId) === promise) {
			current.delete(toolId);
			if (current.size === 0) resolveInstallInFlightByCwd.delete(key);
		}
	});
	byTool.set(toolId, promise);
	return promise;
}

// =============================================================================
// SHARED AST-GREP AVAILABILITY
// =============================================================================

/**
 * Shared ast-grep availability across all slop runners, behind the transient-
 * aware latch (#1476). This module-level memo carried the same shape `SgRunner`
 * did — one failed sweep, including a timeout, disabled ast-grep for every slop
 * runner for the life of the process.
 */
const sgLatch = createAvailabilityLatch();
let sgCmd: string | null = null;
let sgCmdArgs: string[] = [];
/** Classification of the current sweep, accumulated across candidates. */
let sgSweepSawTransient = false;
let sgSweepTransientCause: AvailabilityCause = "probe-timeout";
let sgSweepHostStallMs = 0;

function isAstGrepVersionOutput(output: string): boolean {
	return /\bast[- ]grep\b/i.test(output);
}

async function probeAstGrepCommandAsync(
	cmd: string,
	argsPrefix: string[] = [],
): Promise<boolean> {
	const sampler = startHostStallSampler();
	let check: Awaited<ReturnType<typeof safeSpawnAsync>>;
	let hostStallMs: number;
	try {
		check = await safeSpawnAsync(cmd, [...argsPrefix, "--version"], {
			timeout: 5000,
		});
	} finally {
		hostStallMs = sampler.stop();
		sgSweepHostStallMs += hostStallMs;
	}
	if (
		!check.error &&
		check.status === 0 &&
		isAstGrepVersionOutput(`${check.stdout}\n${check.stderr}`)
	) {
		return true;
	}
	const { outcome, cause } = classifyProbeFailure(check, { hostStallMs });
	if (outcome === "transient") {
		sgSweepSawTransient = true;
		sgSweepTransientCause = cause;
	}
	return false;
}

/** Pre-filter local node_modules/.bin candidates that actually exist on disk. */
function buildSgLocalBins(): string[] {
	const isWin = process.platform === "win32";
	const hasBash = !!(
		process.env.MSYSTEM ||
		process.env.GIT_SHELL ||
		process.env.BASH
	);
	const extensions = isWin
		? hasBash
			? ["", ".exe", ".cmd"]
			: [".cmd", ".exe", ""]
		: [""];
	const binaryCandidates = ["ast-grep", "sg"].flatMap((base) =>
		extensions.map((ext) => `${base}${ext}`),
	);
	const binRoots = [
		...findNodeBinRoots(_thisDir),
		...findNodeBinRoots(process.cwd()),
		_managedToolsDir,
	];
	const bins: string[] = [];
	for (const root of binRoots) {
		for (const candidate of binaryCandidates) {
			const localBin = path.join(root, "node_modules", ".bin", candidate);
			if (fs.existsSync(localBin)) bins.push(localBin);
		}
	}
	return bins;
}

let sgAvailableInFlight: Promise<boolean> | null = null;
let sgAvailabilityGeneration = availabilityStateGeneration;

function ensureCurrentSgGeneration(): void {
	if (sgAvailabilityGeneration === availabilityStateGeneration) return;
	sgLatch.reset();
	sgCmd = null;
	sgCmdArgs = [];
	sgAvailableInFlight = null;
	sgAvailabilityGeneration = availabilityStateGeneration;
}

export async function isSgAvailableAsync(): Promise<boolean> {
	ensureCurrentSgGeneration();
	// `read()` returns null when the last verdict was transient and its cooldown
	// expired: re-probe rather than stay dead for the session (#1476).
	const memo = sgLatch.read();
	if (memo !== null) return memo;
	if (sgAvailableInFlight) return sgAvailableInFlight;

	sgAvailableInFlight = (async () => {
		const startedAt = Date.now();
		sgSweepSawTransient = false;
		sgSweepTransientCause = "probe-timeout";
		sgSweepHostStallMs = 0;
		// 1. Local node_modules/.bin
		for (const localBin of buildSgLocalBins()) {
			if (await probeAstGrepCommandAsync(localBin)) {
				sgCmd = localBin;
				sgCmdArgs = [];
				noteSgAvailable(startedAt);
				return true;
			}
		}

		// 2. Global PATH
		for (const cmd of ["ast-grep", "sg"]) {
			if (await probeAstGrepCommandAsync(cmd)) {
				sgCmd = cmd;
				sgCmdArgs = [];
				noteSgAvailable(startedAt);
				return true;
			}
		}

		// 2b. Any package manager's global bin dir (npm/pnpm/yarn/bun) — catches
		// `pnpm add -g @ast-grep/cli` installs whose bin dir is off PATH (#375).
		for (const name of ["ast-grep", "sg"]) {
			const globalBin = await findGlobalBinary(name);
			if (globalBin && (await probeAstGrepCommandAsync(globalBin))) {
				sgCmd = globalBin;
				sgCmdArgs = [];
				noteSgAvailable(startedAt);
				return true;
			}
		}

		// 3. npx --no (cache-only, no silent download).
		if (await probeAstGrepCommandAsync("npx", ["--no", "--", "ast-grep"])) {
			sgCmd = "npx";
			sgCmdArgs = ["--no", "--", "ast-grep"];
			noteSgAvailable(startedAt);
			return true;
		}

		// A timeout on ANY candidate is evidence about the host, not the tool.
		noteSgUnavailable(
			startedAt,
			sgSweepSawTransient ? "transient" : "missing",
			sgSweepSawTransient ? sgSweepTransientCause : "not-found",
		);
		return false;
	})().finally(() => {
		sgAvailableInFlight = null;
	});

	return sgAvailableInFlight;
}

/** Record a successful shared-ast-grep sweep, with one decision record. */
function noteSgAvailable(startedAt: number): void {
	sgLatch.noteAvailable();
	logAvailabilityDecision({
		tool: "ast-grep",
		verdict: "available",
		outcome: "success",
		cause: "ok",
		elapsedMs: Date.now() - startedAt,
		latched: true,
		hostStallMs: sgSweepHostStallMs,
		budgetMs: 5000,
	});
}

/** Record a failed shared-ast-grep sweep; a transient verdict expires. */
function noteSgUnavailable(
	startedAt: number,
	outcome: "missing" | "transient",
	cause: AvailabilityCause,
): void {
	const retryAfterMs = sgLatch.noteUnavailable(outcome, cause);
	logAvailabilityDecision({
		tool: "ast-grep",
		verdict: "unavailable",
		outcome,
		cause,
		elapsedMs: Date.now() - startedAt,
		latched: outcome !== "transient",
		hostStallMs: sgSweepHostStallMs,
		...(retryAfterMs > 0 && { retryAfterMs }),
		budgetMs: 5000,
	});
}

export function getSgCommand(): { cmd: string; args: string[] } {
	ensureCurrentSgGeneration();
	return {
		cmd: sgCmd ?? "npx",
		args: sgCmdArgs.length ? sgCmdArgs : ["--no", "--", "ast-grep"],
	};
}

// =============================================================================
// LOCAL-FIRST BINARY RESOLUTION
// =============================================================================

/**
 * Find a tool binary preferring local node_modules/.bin, then any installed
 * package manager's global bin dir (npm/pnpm/yarn/bun), then global PATH. Only
 * falls back to `npx --no` as a last resort — the universal cache-only exec
 * (npx ships with node and never silently downloads), so this stays
 * manager-agnostic without risking a surprise `dlx` fetch on pnpm/yarn/bun.
 *
 * Returns: { cmd, args } where args may include the `["--no", toolName]` npx
 * preamble.
 */
export async function resolveLocalFirstAsync(
	toolName: string,
	cwd: string,
	windowsExt = ".cmd",
): Promise<{ cmd: string; args: string[] }> {
	const isWin = process.platform === "win32";
	const binName = isWin ? `${toolName}${windowsExt}` : toolName;

	// 1. Local node_modules/.bin (project-installed)
	const local = path.join(cwd, "node_modules", ".bin", binName);
	if (fs.existsSync(local)) return { cmd: local, args: [] };

	// 2. Global bin dir of ANY installed manager (npm/pnpm/yarn/bun) — direct
	//    file lookup, so it finds tools installed via `pnpm add -g` / `bun add -g`
	//    (whose bin dirs are often off PATH) and survives PATH staleness after an
	//    `install -g`. No spawn.
	const globalBin = await findGlobalBinary(toolName, windowsExt);
	if (globalBin) return { cmd: globalBin, args: [] };

	// 3. Global PATH (already installed system-wide, on PATH)
	const globalCheck = await safeSpawnAsync(toolName, ["--version"], {
		timeout: 3000,
	});
	if (!globalCheck.error && globalCheck.status === 0) {
		return { cmd: toolName, args: [] };
	}

	// 4. npx --no fallback — universal cache-only exec (no silent download)
	return { cmd: "npx", args: ["--no", toolName] };
}

// =============================================================================
// PRE-BUILT CHECKERS FOR COMMON TOOLS
// =============================================================================

export const pyright = createAvailabilityChecker("pyright", ".exe");
export const ruff = createAvailabilityChecker("ruff", ".exe");
export const biome = createAvailabilityChecker("biome");
export const sg = {
	isAvailableAsync: isSgAvailableAsync,
	getCommand: getSgCommand,
};
