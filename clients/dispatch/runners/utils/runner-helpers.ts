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
import { logSessionStart } from "../../../sessionstart-logger.js";
import { getGlobalPiLensDir } from "../../../file-utils.js";
import {
	createGenerationSource,
	type GenerationHandle,
} from "../../../generation-guard.js";
import { PathKeyedMap } from "../../../path-keyed-map.js";
import {
	normalizeEphemeralMapKey,
	normalizeMapKey,
} from "../../../path-utils.js";
import {
	ensureTool,
	getInstallAttempt,
	getLastEnsureResolutionSource,
	getToolInstallStrategy,
	isSpawnableCommand,
	resetPathWalkMemo,
	type InstallAttempt,
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
import { isInSpawnTimeoutCooldown } from "../../../spawn-timeout-cooldown.js";
import {
	type AvailabilityCause,
	type AvailabilityLatch,
	type AvailabilityOutcome,
	type ProbeEvidence,
	type ProbeFailureShape,
	classifyProbeFailure,
	createAvailabilityLatch,
	describeInstallAttempt,
	describeProbeEvidence,
	isLatchingOutcome,
	logAvailabilityDecision,
	startHostStallSampler,
	transientRetryDelayMs,
} from "./availability-policy.js";

export type {
	AvailabilityCause,
	AvailabilityDecision,
	AvailabilityLatch,
	AvailabilityOutcome,
} from "./availability-policy.js";
export {
	createAvailabilityLatch,
	classifyProbeFailure,
	describeProbeEvidence,
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
 * Managed-shim candidates for a Node CLI tool, in the installer's own
 * preference order (`getToolPath`'s managed-first branch: `.cmd`, then `.exe`,
 * then extensionless on Windows; extensionless elsewhere).
 *
 * The pi-lens dir is read per call, never memoized at module load, so tests that
 * point `getGlobalPiLensDir` at a temp home still see their own tree.
 */
function managedNodeToolCandidates(tool: string): string[] {
	const base = path.join(
		getGlobalPiLensDir(),
		"tools",
		"node_modules",
		".bin",
		tool,
	);
	return process.platform === "win32"
		? [`${base}.cmd`, `${base}.exe`, base]
		: [base];
}

type ManagedVerdict = "absent" | "ok" | "broken" | "unverified";

type ManagedVerdictMemo =
	| { verdict: "ok" | "broken" }
	/**
	 * A probe that never got a fair run. Held under a cooldown, not forever: a
	 * cold-cache host can blow the budget on a perfectly good shim, and one slow
	 * first touch must not pin "cannot verify" for the whole session.
	 */
	| { verdict: "unverified"; retryAtMs: number; attempts: number };

/**
 * Verification verdicts for managed shims, keyed by path + mtime + size, so a
 * reinstall re-verifies and a session start re-arms.
 *
 * A plain `Map`, not a `PathKeyedMap`: `managedNodeToolCandidates` is the ONLY
 * producer of these paths, so the write and read forms are the same string by
 * construction and cannot diverge on case or separator.
 */
const managedBinaryVerdicts = new Map<string, ManagedVerdictMemo>();
/**
 * Verifications in progress, keyed the same way. Concurrent first touches of
 * one shim share the single probe instead of each spawning their own — the
 * same in-flight-share shape `resolveInstallInFlightByCwd` uses for installs
 * (#1674 review F2).
 */
const managedVerifyInFlight = new Map<string, Promise<ManagedVerdict>>();

/**
 * Budget for the managed-shim verification spawn.
 *
 * 5s, not the checker's default probe budget: a cold npm shim on a cold file
 * cache measured just over 2s in the #1674 review, so a tighter budget spends
 * the whole wait and still learns nothing. This runs once per shim per session
 * on the success path, and the installer's own verification keeps its more
 * generous 10s.
 */
const MANAGED_VERIFY_TIMEOUT_MS = 5000;
/** First cooldown after a verification that never got a fair run. */
const MANAGED_VERIFY_COOLDOWN_MS = 60_000;
/**
 * Ceiling for the cooldown ladder — a shim that keeps stalling is still
 * re-probed every 15 minutes.
 */
const MANAGED_VERIFY_COOLDOWN_MAX_MS = 15 * 60_000;

function managedVerifyCooldownMs(attempts: number): number {
	return Math.min(
		MANAGED_VERIFY_COOLDOWN_MAX_MS,
		MANAGED_VERIFY_COOLDOWN_MS * 2 ** (attempts - 1),
	);
}

async function runManagedVerification(
	candidate: string,
	stamp: string,
	priorAttempts: number,
	generation: GenerationHandle,
): Promise<ManagedVerdict> {
	let transient = false;
	let ok: boolean;
	try {
		const { verifyToolBinary } = await import("../../../installer/index.js");
		ok = await verifyToolBinary(
			candidate,
			undefined,
			() => {
				transient = true;
			},
			MANAGED_VERIFY_TIMEOUT_MS,
		);
	} catch {
		// The verifier itself could not run — installer-isolated unit tests mock
		// this module without it, and a throw here says nothing about the shim.
		// "Cannot verify" is not "broken": keep the on-disk answer.
		transient = true;
		ok = false;
	}
	// An unspawnable prober is never a durable verdict (#1569): a timeout or a
	// spawn-boundary failure says nothing about the shim, so it never demotes
	// the candidate. It IS remembered, under a cooldown, so the wait is paid
	// once per window rather than on every resolve (#1674 review F1).
	// A verification that straddles a session boundary answers ITS caller, but
	// its verdict belongs to the session that asked. Writing it into the fresh
	// session would hand the new session the old one's cooldown — the exact
	// re-arm this state clears at `session_start` (#1674 review F5). Same guard
	// the install seam's in-flight share uses.
	if (!ok && transient) {
		const attempts = priorAttempts + 1;
		generation.guardedWrite(stamp, () => {
			managedBinaryVerdicts.set(stamp, {
				verdict: "unverified",
				attempts,
				retryAtMs: Date.now() + managedVerifyCooldownMs(attempts),
			});
		});
		return "unverified";
	}
	generation.guardedWrite(stamp, () => {
		managedBinaryVerdicts.set(stamp, { verdict: ok ? "ok" : "broken" });
	});
	if (!ok) {
		// Once per shim per session, at the moment the verdict is reached — the
		// memo answers every later call, so this cannot become per-dispatch spam.
		logSessionStart(
			`dispatch availability: managed shim ${candidate} exists but does not run; falling through to PATH`,
		);
	}
	return ok ? "ok" : "broken";
}

async function verifyManagedCandidate(
	candidate: string,
): Promise<ManagedVerdict> {
	let stamp: string;
	try {
		const stat = fs.statSync(candidate);
		stamp = `${candidate}:${stat.mtimeMs}:${stat.size}`;
	} catch {
		return "absent";
	}
	const memo = managedBinaryVerdicts.get(stamp);
	let priorAttempts = 0;
	if (memo) {
		if (memo.verdict !== "unverified") return memo.verdict;
		if (Date.now() < memo.retryAtMs) return "unverified";
		priorAttempts = memo.attempts;
	}
	const existing = managedVerifyInFlight.get(stamp);
	if (existing) return existing;
	const generation = availabilityGeneration.capture();
	const probe = runManagedVerification(
		candidate,
		stamp,
		priorAttempts,
		generation,
	).finally(() => {
		// A settling old-session probe must not evict the live entry a new
		// session already started for the same shim (#1674 review F5).
		generation.guardedWrite(stamp, () => {
			if (managedVerifyInFlight.get(stamp) === probe) {
				managedVerifyInFlight.delete(stamp);
			}
		});
	});
	managedVerifyInFlight.set(stamp, probe);
	return probe;
}

/**
 * The managed shim for a Node CLI tool (`~/.pi-lens/tools/node_modules/.bin/<tool>`),
 * or null when no candidate on disk actually runs.
 *
 * Verification uses the installer's own `verifyToolBinary`, the same check its
 * managed-first branch runs before returning a managed path. A bare
 * `existsSync` let a broken shim shadow a working PATH binary — the on-disk
 * file wins the race and then fails every spawn behind it (#1657). knip and
 * jscpd each carried a line-for-line copy of this resolver; #1476 folds them
 * into one definition so the next managed tool inherits the fast path instead
 * of a fourth copy.
 *
 * A settled verdict is memoized per file identity for the session, so the fast
 * path answers without a spawn after the first call (#1467). A probe that
 * cannot run keeps the optimistic answer rather than turning a stall into a
 * "missing tool", and is memoized under a bounded cooldown ladder so the wait
 * is paid once per window instead of on every resolve — while a shim that
 * stalls on a cold cache still gets re-probed later (#1674 review F1).
 * Concurrent first touches share one probe (#1674 review F2).
 */
export async function findManagedNodeToolBinary(
	tool: string,
): Promise<string | null> {
	for (const candidate of managedNodeToolCandidates(tool)) {
		const verdict = await verifyManagedCandidate(candidate);
		if (verdict === "ok" || verdict === "unverified") return candidate;
	}
	return null;
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
): (cwd: string) => Promise<string> {
	return async (cwd: string): Promise<string> => {
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

		// Managed-dir install (~/.pi-lens/tools/node_modules/.bin/<command>) — the
		// same shim `ensureTool()` installs npm-strategy tools into. Checked BEFORE
		// the bare-name PATH fallback (#1638): without this, a tool that only
		// exists in the managed dir never resolves here, so `resolveAvailableOrInstall`
		// clears the checker's cache on every install recovery for nothing — the
		// very next probe misses PATH again, spawns a doomed `--version` process,
		// and only THEN falls through to `ensureTool`'s own cache. One managed-dir
		// check settles it without a spawn — after one verification per shim per
		// session, so a shim that cannot run falls through to PATH instead of
		// shadowing a working binary (#1657).
		const managed = await findManagedNodeToolBinary(command);
		if (managed) return managed;

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
	fastPath?: () => string | null | Promise<string | null>;
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
// Which (cwd, toolId) pairs already got their ONE compensating `available`
// row this session for a GENUINE correction (#1612 review F2).
// `checker.reset()` clears the checker's own cache on every install recovery,
// so the NEXT call re-probes PATH from scratch — and that probe keeps missing
// for a managed-dir-only install (createVenvFinder never searches the managed
// tools dir; tracked separately as its own bug). Without this memo, every one
// of those repeat probe failures looks like a fresh correction and re-logs
// "available", even though only the first call actually ran an install.
//
// A correction is genuine only when a latched `unavailable` row for the same
// pair stood before it. `verifyOrInstallCommand` also emits through this seam
// with NO prior latch behind it (biome-check and oxlint reach it with no
// checker probe at all), and burning this memo on such a row silences the
// LATER genuine latch-then-recover for the same pair — the #1606 defect back
// through the #1612 seam (#1657). Those rows dedupe against
// `uncorrectedEmissionsByCwd` instead, so repeats stay suppressed without
// pre-empting the real correction.
const correctedAvailabilityByCwd = new PathKeyedMap<Set<string>>(
	normalizeMapKey,
);
// Which (cwd, toolId) pairs already emitted an `available` row that corrected
// nothing (no latched `unavailable` stood before it). Same one-row-per-session
// bound as the memo above, kept in a SEPARATE scope so it cannot answer for a
// correction that has not happened yet (#1657).
const uncorrectedEmissionsByCwd = new PathKeyedMap<Set<string>>(
	normalizeMapKey,
);
// Which (cwd, tool) pairs currently stand latched `unavailable` in the durable
// log. Recorded where such a row is actually written, so "was there anything
// to correct" is read from the log's own history rather than assumed by the
// caller. Session-scoped: `resetDispatchAvailabilityState` clears it, so a new
// session re-arms instead of inheriting the last one's latches (#1657).
const latchedUnavailableByCwd = new PathKeyedMap<Set<string>>(normalizeMapKey);
// Checkers are created by runner modules and may also be created dynamically.
// Keep the session reset as a generation rather than retaining every checker
// reset closure forever.
//
// #1754: the counter itself is now the shared `GenerationSource` primitive, so
// the capture-before-await/check-after guards below are one implementation
// instead of five hand-rolled ones, and a dropped straddling write is visible
// in the degradation ledger instead of silent.
const availabilityGeneration = createGenerationSource("dispatch-availability");

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

function hasId(
	map: PathKeyedMap<Set<string>>,
	cwd: string,
	id: string,
): boolean {
	return map.get(cwd)?.has(id) ?? false;
}

function addId(map: PathKeyedMap<Set<string>>, cwd: string, id: string): void {
	let ids = map.get(cwd);
	if (!ids) {
		ids = new Set();
		map.set(cwd, ids);
	}
	ids.add(id);
}

function deleteIds(
	map: PathKeyedMap<Set<string>>,
	cwd: string,
	ids: string[],
): void {
	const existing = map.get(cwd);
	if (!existing) return;
	for (const id of ids) existing.delete(id);
	if (existing.size === 0) map.delete(cwd);
}

/**
 * True once a compensating `available` row has already fired for this
 * (cwd, toolId) pair this session; `noteAvailabilityCorrected` records it the
 * first time. #1612 review F2's "once per correction" — see
 * `correctedAvailabilityByCwd`'s comment for why repeats need suppressing.
 */
function hasCorrectedAvailability(cwd: string, toolId: string): boolean {
	return hasId(correctedAvailabilityByCwd, cwd, toolId);
}

function noteAvailabilityCorrected(cwd: string, toolId: string): void {
	addId(correctedAvailabilityByCwd, cwd, toolId);
}

/**
 * Record that a latched `unavailable` row now stands for this pair. Called
 * from each seam that writes one (the availability checker and the shared
 * probe latch), so a later compensating row can tell a genuine correction
 * from a no-op emission (#1657).
 */
function noteLatchedUnavailable(cwd: string, tool: string): void {
	addId(latchedUnavailableByCwd, cwd, tool);
}

/**
 * Drop the latch record for a pair, because the row it described no longer
 * stands. Called on every `available` verdict as well as on the compensating
 * row itself, so a latch cannot outlive the state it describes and later back
 * a "correction" that corrects nothing (#1674 review F3).
 */
function clearLatchedUnavailable(cwd: string, ...tools: string[]): void {
	deleteIds(latchedUnavailableByCwd, cwd, tools);
}

/**
 * Every name a latched row for this pair could have been written under. A
 * checker logs its COMMAND (sometimes a resolved absolute path), the install
 * seam knows a toolId, and the two are not always the same string. One
 * derivation feeds BOTH the lookup and the clear, so the two can never
 * disagree about which key the latch lives under (#1674 review F3).
 */
function latchKeysFor(toolId: string, command?: string): string[] {
	const keys = [toolId];
	if (command) keys.push(command, path.basename(command));
	return keys;
}

/**
 * True when a latched `unavailable` row stands for any of these keys. A false
 * positive only restores the pre-#1657 behavior (the row emits and burns the
 * correction memo); a false negative still emits the row, under the
 * uncorrected scope. Neither can swallow a genuine correction.
 */
function hasLatchedUnavailable(cwd: string, tools: string[]): boolean {
	return tools.some((tool) => hasId(latchedUnavailableByCwd, cwd, tool));
}

/**
 * Which installer family resolved a tool, for the compensating row's
 * `evidence.source` (#1612 review F1). Reads the registry's own
 * `installStrategy` rather than hand-mapping per toolId — the two cannot
 * drift apart because there is only one list.
 */
function sourceTagForToolId(toolId: string): ProbeEvidence["source"] {
	switch (getToolInstallStrategy(toolId)) {
		case "npm":
			return "managed-dir";
		case "pip":
			return "pip-user";
		case "github":
			return "github-release";
		case "archive":
			return "archive-dist";
		case "maven":
			return "maven-jar";
		default:
			// "gem" has no CLI runner behind this seam yet, and an unknown toolId
			// means the registry lookup itself missed — either way, no tag beats
			// a guessed one.
			return undefined;
	}
}

/**
 * How to tag a not-fresh install resolution in the compensating row's
 * evidence (#1636 review, carried over from #1615's verify). `getInstallAttempt`
 * answers `undefined` for BOTH a genuine cache hit and a plain PATH/managed-dir
 * discovery, and answers `declined`/`skipped` for a policy refusal that still
 * hands back whatever discovery found — three different facts a single
 * `"cache"` tag used to flatten into one. `declined`/`skipped` take priority
 * over the source map: a project-trust decline overwrites whatever the
 * discovery pass underneath it found (see `ensureTool`'s trust-gate branch in
 * installer/index.ts), so by the time this reads it, "declined" is the honest
 * answer regardless of how the binary was actually found.
 */
function resolvedTagForAttempt(
	toolId: string,
	attempt: InstallAttempt | undefined,
): "cache" | "path" | "declined" {
	if (attempt?.outcome === "declined" || attempt?.outcome === "skipped") {
		return "declined";
	}
	return getLastEnsureResolutionSource(toolId) === "path" ? "path" : "cache";
}

/**
 * Emit the ONE compensating `available` row for a (cwd, toolId) correction,
 * after a latched unavailable probe recovers via `ensureTool`. This is the
 * SINGLE row constructor for every caller behind this seam —
 * `resolveAvailableOrInstallUnshared` (#1612) and `verifyOrInstallCommand`
 * (#1636) both call it rather than each hand-rolling their own, which is
 * exactly the drift #1610's own review caught the first time this shape
 * shipped twice.
 *
 * Gated on the once-per-correction memo (`correctedAvailabilityByCwd`,
 * #1612 review F2): `checker.reset()` / a cleared probe cache means the NEXT
 * call for the same (cwd, toolId) can resolve the same tool again with no
 * fresh attempt behind it, and that must not re-log a "fresh correction"
 * every time.
 *
 * `latchKeys` are every name a latched `unavailable` row for this pair could
 * carry. A row that clears one of them is a genuine correction and burns the
 * correction memo; a row with nothing to correct dedupes in its own scope, so
 * it cannot silence the genuine latch-then-recover that follows it for the
 * same pair (#1657).
 */
function emitCompensatingAvailableRow(
	cwd: string,
	toolId: string,
	installStartedAt: number,
	installedPath: string,
	latchKeys: string[],
): void {
	if (hasCorrectedAvailability(cwd, toolId)) return;
	const correctsLatchedRow = hasLatchedUnavailable(cwd, latchKeys);
	if (correctsLatchedRow) {
		noteAvailabilityCorrected(cwd, toolId);
		// Clear every key the latch could live under, not just the toolId: the
		// checker records the row under its COMMAND, and a leftover entry would
		// later back a "correction" with nothing behind it (#1674 review F3).
		clearLatchedUnavailable(cwd, ...latchKeys);
	} else {
		if (hasId(uncorrectedEmissionsByCwd, cwd, toolId)) return;
		addId(uncorrectedEmissionsByCwd, cwd, toolId);
	}
	// `installed`/`installedPath` can come back truthy WITHOUT ensureTool
	// running an install this call — its in-memory cache, its on-disk probe
	// cache, getToolPath finding it already present, or a concurrent peer's
	// install all return a path with no fresh attempt recorded. Deriving from
	// `getInstallAttempt` (rather than asserting "succeeded" because the path
	// is truthy, or hand-rolling a second mapping) is what #1610's OWN
	// failure-path mirror bug was caught on review; read the REAL outcome
	// through the one function that already knows how, don't assume it. Hard
	// import, no `typeof` guard (#1636 review): a genuinely removed export
	// must throw here, not silently read as "not attempted".
	const attempt = getInstallAttempt(toolId);
	const installEvidence = describeInstallAttempt(attempt);
	const evidence: ProbeEvidence = {
		...installEvidence,
		binary: path.basename(installedPath),
		source: sourceTagForToolId(toolId),
		// Set alongside any non-"succeeded" outcome: the path is truthy but
		// nothing ran this call, so it came from an already-known-good answer
		// rather than a fresh attempt (#1612 review F2).
		...(installEvidence.install !== "succeeded" && {
			resolved: resolvedTagForAttempt(toolId, attempt),
		}),
		// The whole point of the memo split, on the record: a reader can tell a
		// row that cleared a latched `unavailable` from one that corrected
		// nothing, without re-deriving it from the surrounding rows (#1674
		// review F4).
		correctsLatchedRow,
	};
	logAvailabilityDecision(
		{
			tool: toolId,
			verdict: "available",
			outcome: "success",
			cause: "ok",
			elapsedMs: Date.now() - installStartedAt,
			// `checker.reset()`/a fresh probe just cleared whatever cache stood
			// behind this call, so nothing is actually held pinned the instant
			// this row is written — the very next probe starts fresh
			// (#1612 review F3). Writing `true` here would claim a durability
			// this call doesn't have.
			latched: false,
			classifiedBy: "caller",
			evidence,
		},
		cwd,
	);
}

/** Reset availability/install suppression at the session boundary. */
export function resetDispatchAvailabilityState(): void {
	installAttemptsByCwd.clear();
	resolveInstallInFlightByCwd.clear();
	correctedAvailabilityByCwd.clear();
	uncorrectedEmissionsByCwd.clear();
	latchedUnavailableByCwd.clear();
	managedBinaryVerdicts.clear();
	managedVerifyInFlight.clear();
	resetPathWalkMemo();
	availabilityGeneration.bump();
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
	let checkerGeneration = availabilityGeneration.current();

	const findCommand = createVenvFinder(command, windowsExt);

	function ensureCurrentGeneration(): void {
		if (checkerGeneration === availabilityGeneration.current()) return;
		cacheByCwd.clear();
		inFlightByCwd.clear();
		checkerGeneration = availabilityGeneration.current();
	}

	const reset = (): void => {
		cacheByCwd.clear();
		inFlightByCwd.clear();
		checkerGeneration = availabilityGeneration.current();
	};

	function getCache(cwd: string): AvailabilityCache {
		ensureCurrentGeneration();
		const key = path.resolve(cwd || process.cwd());
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
			/** How the outcome was reached, and the facts behind it (#1500). */
			classifiedBy?: "probe" | "caller";
			evidence?: ProbeEvidence;
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
			retryAfterMs = transientRetryDelayMs(
				cache.transientAttempts,
				verdict.cause,
			);
			cache.retryAtMs = Date.now() + retryAfterMs;
		}
		const latched = verdict.available || isLatchingOutcome(verdict.outcome);
		// Remember the pair whose durable row now says "unavailable and staying
		// that way" — that is the row a later compensating `available` row
		// corrects, and the only thing that makes such a row a correction
		// (#1657).
		if (!verdict.available && latched) {
			noteLatchedUnavailable(resolvedCwd, command);
		} else if (verdict.available) {
			// The latched row this pair carried no longer stands: THIS row says
			// the tool is back. Dropping the record here keeps a stale latch from
			// backing a later "correction" that corrects nothing (#1674 F3).
			clearLatchedUnavailable(resolvedCwd, ...latchKeysFor(command));
		}
		logAvailabilityDecision(
			{
				tool: command,
				verdict: verdict.available ? "available" : "unavailable",
				outcome: verdict.outcome,
				cause: verdict.cause,
				elapsedMs: verdict.elapsedMs,
				latched,
				...(verdict.classifiedBy !== undefined && {
					classifiedBy: verdict.classifiedBy,
				}),
				...(verdict.evidence !== undefined && { evidence: verdict.evidence }),
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
			const fastPath = await options.fastPath?.();
			if (fastPath) {
				cache.command = fastPath;
				noteDecision(cache, resolvedCwd, {
					available: true,
					outcome: "success",
					cause: "fast-path",
					elapsedMs: 0,
					// Caller-asserted, and justifiably: an on-disk shim IS the tool, so
					// there is no spawn to derive anything from (#1500).
					classifiedBy: "caller",
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
						// The workspace is gone. Asserted from a stat, not a probe, and it
						// must never read as "the tool is missing" (#1500).
						classifiedBy: "caller",
					});
					return false;
				}
			} catch {
				noteDecision(cache, resolvedCwd, {
					available: false,
					outcome: "non-installable",
					cause: "bad-cwd",
					elapsedMs: 0,
					classifiedBy: "caller",
				});
				return false;
			}

			const cmd = await findCommand(resolvedCwd);
			// #1995: a command cooling down after a RUNTIME timeout (lint or
			// autofix lane blew its real budget) must not re-probe on every
			// edit - the positive verdict is effectively cooled. Consult-only:
			// probe timeouts do NOT arm the cooldown here, because a single
			// slow --version under host stall (#1467) is transient evidence,
			// and session-long suppression from it would contradict the
			// #1494 retry ladder this classification exists for.
			if (isInSpawnTimeoutCooldown(cmd)) {
				noteDecision(cache, resolvedCwd, {
					available: false,
					outcome: "transient",
					cause: "probe-timeout",
					elapsedMs: 0,
					classifiedBy: "caller",
					evidence: {
						command: cmd,
						status: null,
					},
				});
				return false;
			}
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
					classifiedBy: "probe",
					evidence: describeProbeEvidence(result),
				});
				return true;
			}

			const { outcome, cause, evidence } = classifyProbeFailure(result, {
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
				classifiedBy: "probe",
				evidence,
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
				cache.available !== false ||
				isLatchingOutcome(cache.outcome ?? "missing"),
			retryAtMs: cache.retryAtMs,
		};
	}

	return { isAvailableAsync, getCommand, getOutcome, getVerdict, reset };
}

/** What a `createCwdCachedProbe` probe hands back for classification (#1494). */
export interface CwdProbeResult extends ProbeFailureShape {
	status?: number | null;
}

export interface CwdCachedProbeOptions {
	/** Tool name used in the `availability_decision` record. */
	tool: string;
	/** Probe budget the verdict was measured against, ms. Reported, not enforced. */
	budgetMs?: number;
	/** Outcome for a failure the taxonomy cannot classify. Default non-installable. */
	unclassifiedFailureOutcome?: AvailabilityOutcome;
}

export interface CwdCachedProbe {
	(cwd: string): Promise<boolean>;
	/** The last verdict for a cwd, for messaging and telemetry. */
	getVerdict(cwd: string): AvailabilityVerdict;
	reset(): void;
}

/**
 * Per-cwd cached availability probe for spawn signatures that don't fit
 * `createAvailabilityChecker` — multi-arg subcommands like `cargo clippy
 * --version` and `mix credo --version`, or a dynamically-resolved
 * `<cmd> --version` such as eslint's local-then-global binary. Each cwd is
 * probed at most once per verdict; concurrent first-time callers share the
 * in-flight promise.
 *
 * Those three ARE the consumers. `npx biome --version` used to be named here as
 * one and never was: biome resolves through `resolveManagedToolClient` and its
 * own latch in `biome-client.ts`.
 *
 * ## Latch policy (#1494)
 *
 * This used to cache the boolean forever, so one stalled `eslint --version`
 * disabled eslint for that cwd until the process restarted. The verdict now
 * goes through `availability-policy.ts`: the probe returns the SPAWN RESULT,
 * the policy classifies it, and only a durable outcome (`missing` /
 * `non-installable`) latches. A timeout, abort or host stall expires on a
 * bounded cooldown and the next caller re-probes.
 */
export function createCwdCachedProbe(
	probe: (cwd: string) => Promise<CwdProbeResult>,
	options: CwdCachedProbeOptions,
): CwdCachedProbe {
	const latchByCwd = new PathKeyedMap<AvailabilityLatch>(
		normalizeEphemeralMapKey,
	);
	const inFlightByCwd = new PathKeyedMap<Promise<boolean>>(
		normalizeEphemeralMapKey,
	);
	let probeGeneration = availabilityGeneration.current();

	function clear(): void {
		latchByCwd.clear();
		inFlightByCwd.clear();
	}

	function ensureCurrentGeneration(): void {
		if (probeGeneration === availabilityGeneration.current()) return;
		clear();
		probeGeneration = availabilityGeneration.current();
	}

	function latchFor(key: string): AvailabilityLatch {
		const existing = latchByCwd.get(key);
		if (existing) return existing;
		const created = createAvailabilityLatch();
		latchByCwd.set(key, created);
		return created;
	}

	function note(
		latch: AvailabilityLatch,
		key: string,
		verdict: {
			available: boolean;
			outcome: AvailabilityOutcome;
			cause: AvailabilityCause;
			elapsedMs: number;
			hostStallMs: number;
			/** What the spawn returned, for the record's audit trail (#1500). */
			evidence?: ProbeEvidence;
		},
	): void {
		let retryAfterMs: number | undefined;
		if (verdict.available) {
			latch.noteAvailable(verdict.cause);
		} else {
			const delay = latch.noteUnavailable(verdict.outcome, verdict.cause);
			if (delay > 0) retryAfterMs = delay;
		}
		const latched = verdict.available || isLatchingOutcome(verdict.outcome);
		// Same correction bookkeeping as the checker seam above (#1657).
		if (!verdict.available && latched) {
			noteLatchedUnavailable(key, options.tool);
		} else if (verdict.available) {
			clearLatchedUnavailable(key, ...latchKeysFor(options.tool));
		}
		logAvailabilityDecision(
			{
				tool: options.tool,
				verdict: verdict.available ? "available" : "unavailable",
				outcome: verdict.outcome,
				cause: verdict.cause,
				elapsedMs: verdict.elapsedMs,
				latched,
				hostStallMs: verdict.hostStallMs,
				...(retryAfterMs !== undefined && { retryAfterMs }),
				...(options.budgetMs !== undefined && { budgetMs: options.budgetMs }),
				// Every verdict here is derived from the probe this seam just ran.
				classifiedBy: "probe",
				...(verdict.evidence !== undefined && { evidence: verdict.evidence }),
			},
			key,
		);
	}

	const run = (cwd: string): Promise<boolean> => {
		ensureCurrentGeneration();
		const key = path.resolve(cwd || process.cwd());
		const latch = latchFor(key);
		const memo = latch.read();
		if (memo !== null) return Promise.resolve(memo);

		const existing = inFlightByCwd.get(key);
		if (existing) return existing;

		const promiseGeneration = probeGeneration;
		let promise: Promise<boolean>;
		promise = (async () => {
			// The probe budget is enforced by a HOST-side timer, so a stalled event
			// loop expires it while the child is still healthy. Measure the stall
			// that overlapped the window and hand it to the classifier (#1467).
			const stallSampler = startHostStallSampler();
			const startedAt = Date.now();
			let result: CwdProbeResult | undefined;
			let thrown: unknown;
			try {
				result = await probe(key);
			} catch (error) {
				thrown = error;
			}
			const hostStallMs = stallSampler.stop();
			const elapsedMs = Date.now() - startedAt;
			// A probe that threw carries its errno in the Error, which is exactly
			// what the taxonomy reads — so a thrown EAGAIN stays transient instead
			// of collapsing into an untyped `false`.
			const shape: CwdProbeResult = result ?? {
				error: thrown instanceof Error ? thrown : new Error(String(thrown)),
			};

			if (result && !result.error && result.status === 0) {
				note(latch, key, {
					available: true,
					outcome: "success",
					cause: "ok",
					elapsedMs,
					hostStallMs,
					evidence: describeProbeEvidence(result, options.tool),
				});
				return true;
			}

			const { outcome, cause, evidence } = classifyProbeFailure(shape, {
				hostStallMs,
				command: options.tool,
				unclassifiedFailureOutcome: options.unclassifiedFailureOutcome,
			});
			note(latch, key, {
				available: false,
				outcome,
				cause,
				elapsedMs,
				hostStallMs,
				evidence,
			});
			return false;
		})().finally(() => {
			// A session reset clears the map and a caller may immediately start a
			// replacement probe for the same cwd; the old promise must not delete
			// that newer-generation entry when it settles.
			if (
				probeGeneration === promiseGeneration &&
				inFlightByCwd.get(key) === promise
			) {
				inFlightByCwd.delete(key);
			}
		});
		inFlightByCwd.set(key, promise);
		return promise;
	};

	const cached = run as CwdCachedProbe;
	cached.getVerdict = (cwd: string): AvailabilityVerdict => {
		ensureCurrentGeneration();
		const latch = latchFor(path.resolve(cwd || process.cwd()));
		const outcome = latch.getOutcome();
		return {
			outcome,
			cause: latch.getCause(),
			elapsedMs: 0,
			// Read the OUTCOME, never `read()`: `read()` answers `null` both for a
			// cwd that was never probed and for a transient verdict whose cooldown
			// expired, and `!== false` turned both of those into `latched: true` —
			// the opposite of the truth in the expired case.
			latched: outcome !== null && isLatchingOutcome(outcome),
			retryAtMs: latch.getRetryAtMs(),
		};
	};
	cached.reset = (): void => {
		clear();
		probeGeneration = availabilityGeneration.current();
	};
	return cached;
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
	const installStartedAt = Date.now();
	const installed = await ensureTool(toolId);
	if (installed) {
		noteInstallSuccess(toolId, cwd);
		// A latched `unavailable` row MAY stand here, written by whatever probe
		// the caller ran first — but not always. The on-disk pre-check above
		// logs nothing, and two runners reach this seam with no checker probe at
		// all (biome-check and oxlint call
		// `resolveToolCommandWithInstallFallback` directly, #1657). So the row is
		// emitted either way, and only a call that really clears a latched row is
		// recorded as a correction. Without the row, the durable log keeps saying
		// the tool is off after the installer just brought it back — the third
		// seam of #1606/#1610/#1612 (#1636).
		emitCompensatingAvailableRow(
			cwd,
			toolId,
			installStartedAt,
			installed,
			latchKeysFor(toolId, command),
		);
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
	const installStartedAt = Date.now();
	const installed = await ensureTool(toolId);
	if (installed) {
		noteInstallSuccess(toolId, cwd);
		checker.reset?.();
		// The PATH probe above already wrote a latched `unavailable` row via
		// `checker.isAvailableAsync`. Without a compensating row here, the durable
		// log keeps saying the tool is off after the installer just brought it
		// back — the shape #1606/PR #1610 fixed in `ensureViaInstaller`, shared
		// here by ~16 runners behind this helper (#1612), and by
		// `verifyOrInstallCommand` for the third seam (#1636).
		//
		// `checker.reset()` above clears the checker's cache, so the NEXT call
		// re-probes PATH from scratch — and for a managed-dir-only install that
		// probe misses again unless `createVenvFinder` finds it first (#1638).
		// Left unguarded, every one of those repeat misses would re-fire this
		// row, claiming a fresh install each time — `emitCompensatingAvailableRow`
		// gates on the once-per-correction memo to prevent that.
		//
		// The probe above returned the latching `missing` outcome, so a latched
		// `unavailable` row stands for this pair right now — recorded under the
		// checker's own command name. Record it under the toolId too, so the
		// emitter can READ that a correction is happening from the same ledger
		// every other caller reads, instead of being told so by an argument
		// (#1674 review F3).
		noteLatchedUnavailable(cwd, toolId);
		// This IS a genuine correction: the probe above returned the latching
		// `missing` outcome, so a latched `unavailable` row stands for this pair
		// right now (#1657).
		emitCompensatingAvailableRow(
			cwd,
			toolId,
			installStartedAt,
			installed,
			latchKeysFor(toolId, checker.getCommand(cwd) ?? undefined),
		);
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

	// Same capture-before-await guard as the managed-verify seam, via the same
	// primitive (#1754): a settling old-session transaction must not evict the
	// entry a NEW session already installed for this (cwd, tool).
	const generation = availabilityGeneration.capture();
	const promise = resolveAvailableOrInstallUnshared(
		checker,
		toolId,
		cwd,
	).finally(() => {
		generation.guardedWrite(`${toolId}@${key}`, () => {
			const current = resolveInstallInFlightByCwd.get(key);
			if (current?.get(toolId) === promise) {
				current.delete(toolId);
				if (current.size === 0) resolveInstallInFlightByCwd.delete(key);
			}
		});
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
/**
 * Candidates that were UNREACHABLE, in ask order (#1568).
 *
 * The sweep stops at the first candidate that answers, so at the moment of a
 * win this list is exactly the set of candidates ahead of the winner that never
 * got a fair hearing — i.e. the preferred tiers the winner did not really beat.
 *
 * Basenames, because tier 1 is an absolute `node_modules/.bin` path and this
 * list is written to latency.log (#1568 review F3).
 */
let sgSweepUnreachable: string[] = [];
/**
 * Candidates that were probed and answered DURABLY missing this sweep — a
 * real ENOENT/non-installable verdict, not a stall (#1593). The retained-arm
 * fallback below only knows the sweep saw SOME transient candidate; without
 * this list it cannot tell "the memoized winner itself just proved absent"
 * from "an unrelated sibling merely stalled", and re-serves a command this
 * very sweep disproved.
 */
let sgSweepDurablyMissing: string[] = [];

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
		const name = path.basename(cmd);
		if (!sgSweepUnreachable.includes(name)) sgSweepUnreachable.push(name);
	} else if (!sgSweepDurablyMissing.includes(cmd)) {
		sgSweepDurablyMissing.push(cmd);
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
let sgAvailabilityGeneration = availabilityGeneration.current();

function ensureCurrentSgGeneration(): void {
	if (sgAvailabilityGeneration === availabilityGeneration.current()) return;
	sgLatch.reset();
	sgCmd = null;
	sgCmdArgs = [];
	sgAvailableInFlight = null;
	sgAvailabilityGeneration = availabilityGeneration.current();
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
		sgSweepUnreachable = [];
		sgSweepDurablyMissing = [];
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

		// Nothing answered, and nothing answered TRANSIENTLY, while the verdict we
		// are about to overwrite is a provisional win whose command we still hold.
		// #1476's principle applies to the result as much as to the probe: a
		// timeout says nothing about the tool, so it cannot erase a command this
		// process proved working one cooldown ago. Keep serving it and re-arm
		// (#1568 review F1) — UNLESS this very sweep just proved the memoized
		// command durably missing (#1593): a sibling tier stalling is not license
		// to re-serve a winner that ENOENTed a moment ago in the same pass.
		if (
			sgSweepSawTransient &&
			sgLatch.isProvisional() &&
			sgCmd !== null &&
			!sgSweepDurablyMissing.includes(sgCmd)
		) {
			noteSgAvailable(startedAt, { retained: true });
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

/**
 * Record a successful shared-ast-grep sweep, with one decision record.
 *
 * A win reached while an EARLIER candidate was unreachable is provisional
 * (#1568). The sweep stops at the first candidate that answers, so
 * `sgSweepSawTransient` at this point means precisely "a tier this one is
 * supposed to lose to never got a fair hearing" — the winner is used now, but
 * caching it for the session would pin a healthy PATH ast-grep behind `npx`
 * until the next restart.
 *
 * `retained` marks the other provisional case (#1568 review F1): no candidate
 * answered at all, so the winner being reported is the one the previous sweep
 * found, kept rather than discarded on a timeout.
 */
function noteSgAvailable(
	startedAt: number,
	opts: { retained?: boolean } = {},
): void {
	const provisional = sgSweepSawTransient;
	let retryAfterMs = 0;
	if (provisional) {
		retryAfterMs = sgLatch.noteProvisionallyAvailable(sgSweepTransientCause);
	} else {
		sgLatch.noteAvailable();
	}
	logAvailabilityDecision({
		tool: "ast-grep",
		verdict: "available",
		outcome: "success",
		cause: provisional ? sgSweepTransientCause : "ok",
		elapsedMs: Date.now() - startedAt,
		latched: !provisional,
		hostStallMs: sgSweepHostStallMs,
		budgetMs: 5000,
		...(provisional && {
			provisional: true,
			unreachablePreferred: [...sgSweepUnreachable],
			...(opts.retained === true && { retained: true }),
			...(retryAfterMs > 0 && { retryAfterMs }),
		}),
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
