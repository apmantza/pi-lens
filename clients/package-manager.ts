/**
 * Node.js package-manager resolution and command building.
 *
 * Single source of truth for "which package manager should we use here, and how
 * do we spell each command (run script / install / exec / global bin) for it".
 * Supports npm, pnpm, yarn and bun so pi-lens works on whatever manager the
 * machine actually ships.
 *
 * Resolution order (see `resolveNodePackageManager`):
 *   1. What the project declares — lockfile, then the corepack `packageManager`
 *      field — *if that manager is actually installed*.
 *   2. Otherwise the first installed manager in `PREFERENCE` (npm first for
 *      maximum compatibility, bun last).
 *   3. `npm` as a final fallback so callers always get a usable value.
 */

import * as fs from "node:fs";
import { BoundedFifoMap } from "./bounded-cache.js";
import * as os from "node:os";
import * as path from "node:path";
import { resolve as resolvePath } from "node:path";
import {
	type AvailabilityLatch,
	classifyProbeFailure,
	createAvailabilityLatch,
	isTransientDecision,
	logAvailabilityDecision,
	startHostStallSampler,
} from "./dispatch/runners/utils/availability-policy.js";
import {
	safeSpawnAsync,
	getPathExts,
	isAcceptedCommandFile,
} from "./safe-spawn.js";
import { probeToolAsync } from "./tool-probe.js";
import { createAvailabilityProbeFlight } from "./availability-probe-flight.js";
import {
	createGenerationSource,
	type GenerationHandle,
} from "./generation-guard.js";
import {
	isAtOrAboveHomeDir,
	isUnderCanonicalDir,
	isUnderDir,
	normalizeFilePath,
	pathsEqual,
	realpathOrResolve,
	walkUpDirs,
} from "./path-utils.js";
import { getProjectTrustState } from "./project-trust.js";
import {
	getDegradationLedgerGeneration,
	recordDegradationOnce,
} from "./degradation-ledger.js";
import { logExtension } from "./extension-log.js";

export type NodePackageManager = "npm" | "pnpm" | "yarn" | "bun";

/**
 * Fallback preference when nothing is declared (or the declared manager is
 * missing). npm first for maximum compatibility; bun last. A project lockfile
 * always overrides this order.
 */
const PREFERENCE: readonly NodePackageManager[] = [
	"npm",
	"pnpm",
	"yarn",
	"bun",
];

const packageManagerProbeFlights =
	createAvailabilityProbeFlight<
		Awaited<ReturnType<typeof probeAvailability>>
	>();

function onWindows(): boolean {
	return process.platform === "win32";
}

function isNodePackageManager(value: string): value is NodePackageManager {
	return (
		value === "npm" || value === "pnpm" || value === "yarn" || value === "bun"
	);
}

// ============================================================================
// DETECTION
// ============================================================================

/**
 * Detect the package manager a Node.js project declares, without checking
 * whether it is installed. Lockfiles win over the corepack `packageManager`
 * field. Returns `undefined` when the project makes no declaration.
 */
export function detectNodePackageManager(
	targetPath: string,
): NodePackageManager | undefined {
	if (
		fs.existsSync(path.join(targetPath, "bun.lockb")) ||
		fs.existsSync(path.join(targetPath, "bun.lock"))
	) {
		return "bun";
	}
	if (fs.existsSync(path.join(targetPath, "pnpm-lock.yaml"))) {
		return "pnpm";
	}
	if (fs.existsSync(path.join(targetPath, "yarn.lock"))) {
		return "yarn";
	}
	if (fs.existsSync(path.join(targetPath, "package-lock.json"))) {
		return "npm";
	}
	return readPackageManagerField(targetPath);
}

/** Read the corepack `"packageManager": "pnpm@8.15.0"` field from package.json. */
function readPackageManagerField(
	targetPath: string,
): NodePackageManager | undefined {
	try {
		const pkgPath = path.join(targetPath, "package.json");
		if (!fs.existsSync(pkgPath)) return undefined;
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
			packageManager?: unknown;
		};
		if (typeof pkg.packageManager !== "string") return undefined;
		const name = pkg.packageManager.split("@")[0].trim().toLowerCase();
		return isNodePackageManager(name) ? name : undefined;
	} catch {
		return undefined;
	}
}

// ============================================================================
// AVAILABILITY (cached per process; reset in tests)
// ============================================================================

/**
 * Budget for the `where`/`which <pm>` probe. Matches the previous
 * `isCommandAvailableAsync` default so the observable timing is unchanged.
 */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * A timed-out probe used to be memoized as a permanent `false` — the process
 * would silently downgrade a declared pnpm/yarn manager to npm for its whole
 * life. The blast radius was internal: this resolver only serves installs
 * into pi-lens's own managed tools directory and `pilens_rebuild` on a
 * pi-lens source checkout, never a user project's lockfile (#1496). Each
 * manager now sits behind the shared transient-aware latch (#1467/#1476):
 * only a genuine absence (`where`/`which` exits non-zero, or ENOENT) latches;
 * a timeout, abort or host stall expires on a cooldown and is re-probed.
 */
/**
 * #4530 round 9: the availability of a package manager now depends on project
 * trust (a manager reachable only through an untrusted project's PATH is not
 * available), so the latch and the in-flight probe are keyed by the trust
 * scope as well as the manager. `turn_start` re-adopts the host's answer, and a
 * flip reads the other scope's keys — empty, so the next lookup re-probes —
 * instead of serving a verdict the other trust state produced.
 */
function trustScope(): "trusted" | "scoped" {
	return getProjectTrustState() === "trusted" ? "trusted" : "scoped";
}

function availabilityKey(pm: NodePackageManager, cwd: string): string {
	return `${trustScope()}:${normalizeFilePath(cwd)}:${pm}`;
}

const availabilityLatches = new BoundedFifoMap<string, AvailabilityLatch>(8);

function getLatch(key: string): AvailabilityLatch {
	let latch = availabilityLatches.get(key);
	if (!latch) {
		latch = createAvailabilityLatch();
		availabilityLatches.set(key, latch);
	}
	return latch;
}

/**
 * Whether `pm` can run. `key` is captured by the caller (with the manager that
 * goes with it) so a trust flip during an awaited probe cannot make a later
 * stage read a latch it did not start under (defect shapes 19 and 58).
 */
async function probeAvailability(
	pm: NodePackageManager,
	key: string,
	cwd: string,
): Promise<boolean> {
	const latch = getLatch(key);
	const startedAt = Date.now();
	const finder = onWindows() ? "where" : "which";
	const sampler = startHostStallSampler();
	let result: Awaited<ReturnType<typeof safeSpawnAsync>>;
	let hostStallMs: number;
	try {
		// #4530: the lookup resolves through the trust-scoped PATH.
		const env = trustScopedSpawnEnv(cwd);
		result = await probeToolAsync(finder, [pm], {
			timeout: PROBE_TIMEOUT_MS,
			...(env && { env }),
		});
	} finally {
		hostStallMs = sampler.stop();
	}
	const elapsedMs = Date.now() - startedAt;

	if (result.status === 0 && !result.error) {
		latch.noteAvailable();
		logAvailabilityDecision({
			tool: pm,
			verdict: "available",
			outcome: "success",
			cause: "ok",
			elapsedMs,
			latched: true,
			hostStallMs,
			budgetMs: PROBE_TIMEOUT_MS,
			classifiedBy: "probe",
		});
		return true;
	}

	const { outcome, cause, evidence } = classifyProbeFailure(result, {
		hostStallMs,
		// Preserve pre-#1496 meaning for anything the classifier can't place: a
		// present manager that rejects its probe is durable, same as before.
		unclassifiedFailureOutcome: "missing",
	});
	const retryAfterMs = latch.noteUnavailable(outcome, cause);
	logAvailabilityDecision({
		tool: pm,
		verdict: "unavailable",
		outcome,
		cause,
		elapsedMs,
		latched: outcome !== "transient",
		hostStallMs,
		...(retryAfterMs > 0 && { retryAfterMs }),
		budgetMs: PROBE_TIMEOUT_MS,
		classifiedBy: "probe",
		evidence,
	});
	return false;
}

/**
 * Resolve whether `pm` is available. `onTransient`, when given, fires
 * whenever the resolved `false` came from a probe that never got a fair
 * hearing (a stall, an abort, a host-level failure classified `transient` by
 * `classifyProbeFailure`) rather than a genuine absence — including when that
 * verdict is served from the latch's own cooldown-bounded memo, not just on a
 * fresh probe (#1585).
 *
 * Before this, the return type was a bare boolean: a caller like
 * `allAvailableGlobalBinDirs` could not tell "pnpm isn't installed" from
 * "the `where pnpm` probe stalled", so a transient miss silently dropped
 * pnpm's global bin dir with no way to flag the result as provisional —
 * exactly the boolean-collapse `getToolPath`'s `onTransient` plumbing (#1569)
 * was built to avoid, one layer up.
 */
function isAvailable(
	pm: NodePackageManager,
	cwd: string,
	onTransient?: () => void,
): Promise<boolean> {
	const key = availabilityKey(pm, cwd);
	const latch = getLatch(key);

	const reportIfTransient = (result: boolean): boolean => {
		if (!result && isTransientDecision({ outcome: latch.getOutcome() })) {
			onTransient?.();
		}
		return result;
	};

	const memo = latch.read();
	if (memo !== null) return Promise.resolve(reportIfTransient(memo));

	// A verdict can now expire, so concurrent callers arriving just after a
	// cooldown must share ONE probe rather than each spawning their own.
	const shared = packageManagerProbeFlights.run(key, () =>
		probeAvailability(pm, key, cwd),
	);
	return shared.promise.then(reportIfTransient);
}

/**
 * Clear the process-wide availability cache: pnpm/yarn/bun/npm each sit
 * behind their own module-local `AvailabilityLatch` in `availabilityLatches`,
 * so `resetDispatchAvailabilityState`'s generation counter (the mechanism
 * most dispatch runners inherit) never reaches them — the same shape as
 * psscriptanalyzer's (#1490) and zizmor's (#1535) module-local latches.
 * Without this wired into `session_start`, a genuine "pnpm is missing"
 * verdict from one session stayed latched into the next: install pnpm mid
 * day, start a fresh session, pi-lens still reports it missing until a
 * process restart (#1653). Called from `handleSessionStart`'s per-session
 * reset block beside `resetZizmorTokenAvailability()` /
 * `resetPsScriptAnalyzerAvailability()`; also used directly by tests. Also
 * clears `globalBinDirCache`, whose memo lifetime rides the same reset — it
 * must not outlive the availability verdicts it was derived from (#1602).
 */
export function _resetPackageManagerCache(): void {
	packageManagerCacheGeneration.bump();
	availabilityLatches.clear();
	packageManagerProbeFlights.clear();
	globalBinDirCache.clear();
	globalBinDirProbeFlights.clear();
}

// ============================================================================
// RESOLUTION
// ============================================================================

/**
 * Resolve which package manager to use for `cwd`: the project's declared manager
 * if installed, otherwise the first installed manager in `PREFERENCE`, otherwise
 * `npm`.
 */
export async function resolveNodePackageManager(
	cwd: string = process.cwd(),
): Promise<NodePackageManager> {
	const declared = detectNodePackageManager(cwd);
	if (declared && (await isAvailable(declared, cwd))) {
		return declared;
	}
	for (const pm of PREFERENCE) {
		if (await isAvailable(pm, cwd)) return pm;
	}
	return "npm";
}

// ============================================================================
// COMMAND BUILDERS
// ============================================================================

/** Platform-specific executable name (`.cmd`/`.exe` on Windows). */
export function pmBinary(pm: NodePackageManager): string {
	if (!onWindows()) return pm;
	return pm === "bun" ? "bun.exe" : `${pm}.cmd`;
}

/** Args to run a package.json script — `run <script>` works for all managers. */
export function runScriptArgs(script: string): string[] {
	return ["run", script];
}

export interface InstallOptions {
	/** Skip lifecycle scripts (`--ignore-scripts`). */
	ignoreScripts?: boolean;
	/** npm-only escape hatch for peer-dep conflicts (`--legacy-peer-deps`). */
	legacyPeerDeps?: boolean;
}

/**
 * Args to install a single package. npm uses `install`; pnpm/yarn/bun use `add`.
 * `--legacy-peer-deps` is npm-only and silently dropped for other managers.
 */
export function installArgs(
	pm: NodePackageManager,
	pkg: string,
	options: InstallOptions = {},
): string[] {
	const args = [pm === "npm" ? "install" : "add"];
	if (options.ignoreScripts) args.push("--ignore-scripts");
	if (options.legacyPeerDeps && pm === "npm") args.push("--legacy-peer-deps");
	args.push(pkg);
	return args;
}

/**
 * Args to re-resolve an already-declared dependency to the newest version its
 * recorded range still permits. npm/pnpm/bun spell this `update`; yarn classic
 * spells it `upgrade`.
 *
 * This is the command that repairs a dependency frozen by its own lockfile.
 * `installArgs` re-runs the install, and a lockfile entry that already
 * satisfies the range makes that a no-op: pi-lens's managed tools tree stayed
 * on the version written at first install for the life of the machine even
 * though the declared caret range permitted 28 newer minors (#1730).
 */
export function updateArgs(
	pm: NodePackageManager,
	pkg: string,
	options: Pick<InstallOptions, "ignoreScripts"> = {},
): string[] {
	const args = [pm === "yarn" ? "upgrade" : "update"];
	if (options.ignoreScripts) args.push("--ignore-scripts");
	args.push(pkg);
	return args;
}

// ============================================================================
// GLOBAL BIN DISCOVERY
// ============================================================================

/**
 * Per-manager global bin dir, memoized for the process (cleared alongside
 * `availabilityLatches` in `_resetPackageManagerCache`). Only a SUCCESSFUL
 * lookup is cached: a spawn failure here is evidence about this call, not
 * about the manager (the manager already passed `isAvailable`'s own probe),
 * so it must not latch an empty result the way a genuine absence would. The
 * generation guard owns post-await cache publication, so a probe crossing
 * a session reset cannot repopulate the fresh memo. Reset clears the flight
 * map separately, so later callers cannot share the pre-reset probe.
 */
// Keyed by trust scope too (#4530): a scoped query answers differently.
const globalBinDirCache = new BoundedFifoMap<string, string[]>(8);
const packageManagerCacheGeneration = createGenerationSource(
	"package-manager-global-bin",
);
const globalBinDirProbeFlights = createAvailabilityProbeFlight<string[]>();

/** Directories where a given manager installs global binaries. */
async function globalBinDirsFor(
	pm: NodePackageManager,
	cwd: string,
): Promise<string[]> {
	const key = availabilityKey(pm, cwd);
	const cached = globalBinDirCache.get(key);
	if (cached) return cached;
	const generation = packageManagerCacheGeneration.capture();

	// Concurrent callers (dispatch runs several tools per edit) must share ONE
	// probe rather than each spawning their own `npm config get prefix` (#1602).
	const shared = globalBinDirProbeFlights.run(key, () =>
		probeGlobalBinDirs(pm, key, generation, cwd),
	);
	return shared.promise;
}

async function probeGlobalBinDirs(
	pm: NodePackageManager,
	key: string,
	generation: GenerationHandle,
	cwd: string,
): Promise<string[]> {
	if (pm === "bun") {
		// bun has no per-call query cost — the global bin dir is deterministic.
		const base = process.env.BUN_INSTALL || path.join(os.homedir(), ".bun");
		const dirs = [path.join(base, "bin")];
		generation.guardedWrite(key, () => {
			globalBinDirCache.set(key, dirs);
		});
		return dirs;
	}

	const query =
		pm === "npm"
			? ["config", "get", "prefix"]
			: pm === "pnpm"
				? ["bin", "-g"]
				: ["global", "bin"]; // yarn
	// #4530: under an untrusted project the query resolves through the
	// trust-scoped PATH and runs from HOME, so project configuration cannot
	// redirect a global lookup.
	const env = trustScopedSpawnEnv(cwd);
	const res = await safeSpawnAsync(pmBinary(pm), query, {
		timeout: 5000,
		...(env && { env, cwd: os.homedir() }),
	});
	if (res.status !== 0 || res.error) return [];
	const out = res.stdout.trim();
	if (!out) return [];

	// npm reports a prefix; binaries live in `<prefix>/bin` on Unix, `<prefix>`
	// on Windows. pnpm/yarn already print the bin dir directly.
	const dirs =
		pm === "npm" ? [onWindows() ? out : path.join(out, "bin")] : [out];
	generation.guardedWrite(key, () => {
		globalBinDirCache.set(key, dirs);
	});
	return dirs;
}

/**
 * Global bin directories for every installed manager, deduped. Used to locate a
 * globally-installed tool binary when PATH is stale (e.g. right after an
 * `install -g`) or when the tool was installed via a non-npm manager.
 *
 * `onTransient`, when given, fires once per manager whose `isAvailable` probe
 * was transient (stalled/unspawnable, not a genuine absence) — the boolean
 * `allAvailableGlobalBinDirs` returns can't itself distinguish "not
 * installed" from "couldn't tell", so a caller that persists this result
 * needs the callback to know the answer may be incomplete (#1585).
 */
export async function allAvailableGlobalBinDirs(
	onTransient?: () => void,
	cwd: string = process.cwd(),
): Promise<string[]> {
	const dirs: string[] = [];
	const seen = new Set<string>();
	for (const pm of PREFERENCE) {
		if (!(await isAvailable(pm, cwd, onTransient))) continue;
		for (const dir of await globalBinDirsFor(pm, cwd)) {
			const normalized = path.resolve(dir);
			if (seen.has(normalized)) continue;
			seen.add(normalized);
			// #4530: a global bin dir that reaches an untrusted project is no
			// global one.
			if (trustScopedPath(normalized, cwd) !== normalized) continue;
			dirs.push(normalized);
		}
	}
	return dirs;
}

/**
 * Locate a globally-installed tool binary across every installed manager's
 * global bin dir (npm/pnpm/yarn/bun) by direct file lookup — no spawn, no PATH
 * reliance. Returns the full path, or `undefined` if not found.
 *
 * This is the manager-agnostic replacement for a bare `<tool> --version` PATH
 * probe: it finds tools installed via `pnpm add -g` / `bun add -g` (whose bin
 * dirs are often not on PATH) and survives the PATH-cache staleness that follows
 * an `install -g`. On Windows it checks the `.cmd` shim, then `.exe`, then the
 * remaining PATHEXT suffixes and bare name; on Unix just the bare name.
 */
export async function findGlobalBinary(
	command: string,
	windowsExt = ".cmd",
	cwd: string = process.cwd(),
): Promise<string | undefined> {
	const candidates = onWindows()
		? [...new Set([windowsExt, ".exe", ...getPathExts(process.env), ""])].map(
				(ext) => `${command}${ext}`,
			)
		: [command];
	try {
		for (const binDir of await allAvailableGlobalBinDirs(undefined, cwd)) {
			for (const name of candidates) {
				const full = path.join(binDir, name);
				if (!isAcceptedCommandFile(full)) continue;
				// #4530 round 9: the directory is outside the project, but the file
				// it holds can still be a link into it (an npm-linked language
				// server, say), and `isAcceptedCommandFile` follows that link. The
				// trust verdict therefore belongs to the target, not the directory.
				if (commandResolvesIntoProject(full, cwd)) {
					refuseGlobalCommandTarget(full);
					continue;
				}
				return full;
			}
		}
	} catch {
		// Manager probes can fail (missing binary, spawn error) — treat as "not
		// found" so callers fall through to their next resolution step.
	}
	return undefined;
}

/**
 * The three project-local bin-directory shapes in this repo, most-preferred
 * first. Exported so every caller passes the SAME constant instead of
 * re-listing the directory names next to its own copy of the walk — the venv
 * list alone had three independent spellings before #2544 review F1
 * (`formatters.ts`, `runner-helpers.ts`'s `createVenvFinder`,
 * `dead-code-client.ts`'s `venvCandidates`).
 *
 * `VENV_BIN_DIRS` lists BOTH the POSIX (`bin`) and Windows (`Scripts`) layouts
 * unconditionally rather than branching on `process.platform` at module load:
 * a module-load platform constant cannot be forced per test, so the other
 * branch is never exercised on the ubuntu lane (defect shape 30). The extra
 * two `existsSync` calls per directory are the price of a testable list, and
 * a `.venv/Scripts` on Linux (or `.venv/bin` under msys) resolves correctly
 * instead of being invisible.
 */
export const NODE_MODULES_BIN_DIRS: readonly string[] = [
	path.join("node_modules", ".bin"),
];
export const VENDOR_BIN_DIRS: readonly string[] = [path.join("vendor", "bin")];
export const VENV_BIN_DIRS: readonly string[] = [
	path.join(".venv", "bin"),
	path.join("venv", "bin"),
	path.join(".venv", "Scripts"),
	path.join("venv", "Scripts"),
];

/** Every project-local bin layout supported by the canonical resolver above. */
export const PROJECT_LOCAL_BIN_DIRS: readonly string[] = [
	...NODE_MODULES_BIN_DIRS,
	...VENDOR_BIN_DIRS,
	...VENV_BIN_DIRS,
];

/** A local candidate was present, but pi's trust policy refused its use. */
export interface LocalBinTrustRefusal {
	readonly kind: "refused-by-trust";
	readonly tool: string;
	readonly root: string;
	readonly trust: "untrusted" | "unknown";
}

export type LocalBinLookup = string | LocalBinTrustRefusal;

export function isLocalBinTrustRefusal(
	value: LocalBinLookup | undefined,
): value is LocalBinTrustRefusal {
	return (
		typeof value === "object" &&
		value !== null &&
		value.kind === "refused-by-trust"
	);
}

export function localBinPath(
	value: LocalBinLookup | undefined,
): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function refuseLocalBin(tool: string, root: string): LocalBinTrustRefusal {
	const trust = getProjectTrustState() as "untrusted" | "unknown";
	const resolvedRoot = resolvePath(root);
	const subject = `project-local-binary:${resolvedRoot}:${tool}`;
	if (
		recordDegradationOnce({
			kind: "trust-refusal",
			subject,
			reason: `project-local binary refused: pi project trust is ${trust}`,
		})
	) {
		logExtension({
			subsystem: "project-trust",
			level: "warn",
			message:
				"project-local binary refused: mark the project trusted in pi or upgrade pi",
			metadata: { tool, root: resolvedRoot, trust },
		});
	}
	return { kind: "refused-by-trust", tool, root: resolvedRoot, trust };
}

/** Every project-local bin dir of `cwd` and its ancestors below HOME. */
function* projectLocalBinDirs(cwd: string): Generator<string> {
	for (const ancestor of walkUpDirs(cwd)) {
		if (isAtOrAboveHomeDir(ancestor, os.homedir())) return;
		for (const binDir of PROJECT_LOCAL_BIN_DIRS)
			yield path.join(ancestor, binDir);
	}
}

/** Keep trust classification beside the resolver's canonical directory set. */
export function isProjectLocalBinPath(
	resolvedCommand: string,
	cwd: string,
): boolean {
	for (const binDir of projectLocalBinDirs(cwd)) {
		if (isUnderDir(resolvedCommand, binDir)) return true;
	}
	return false;
}

/**
 * #4515: a test for whether one PATH entry (or a global bin dir) can resolve
 * a bare command into the project at `cwd`. It counts when it is a
 * project-local bin dir of `cwd` or an ancestor, lies at or under `cwd`, or is
 * relative: a relative entry follows each spawn's cwd, and on POSIX an empty
 * entry is the cwd. A `cwd` at or above HOME is no project, the ceiling the
 * project-local walk already stops at (#4530), so HOME's own tool dirs stay
 * usable there. Each directory is filesystem-resolved once per test, not per entry.
 */
function projectReach(cwd: string): (entry: string) => boolean {
	const posix = process.platform !== "win32";
	const dirs = [
		...(isAtOrAboveHomeDir(cwd, os.homedir()) ? [] : [cwd]),
		...projectLocalBinDirs(cwd),
	].map((dir) => normalizeFilePath(realpathOrResolve(dir)));
	return (entry) => {
		if (entry === "") return posix;
		if (!path.isAbsolute(entry)) return true;
		const canonical = normalizeFilePath(realpathOrResolve(entry));
		return dirs.some((dir) => isUnderCanonicalDir(canonical, dir));
	};
}

/** #4515: whether a bare command spawned with this process's PATH can resolve into `cwd`. */
export function commandSearchReachesProject(cwd: string): boolean {
	return (process.env.PATH ?? "").split(path.delimiter).some(projectReach(cwd));
}

/**
 * #4530 round 9: whether a RESOLVED command's real target lies in the project
 * pi has not trusted. A trust check on the directory that holds the command
 * answers a different question: a global bin dir outside the project (or an
 * outside PATH entry) can hold a link into it — an npm-linked language server
 * is the ordinary case — and the resolver follows that link when it spawns.
 * The target is what runs, so the target is what the trust gate judges
 * (#4566 round 9).
 */
export function commandResolvesIntoProject(
	resolvedCommand: string,
	cwd: string = process.cwd(),
): boolean {
	if (getProjectTrustState() === "trusted") return false;
	const target = normalizeFilePath(realpathOrResolve(resolvedCommand));
	const reaches = projectReach(cwd);
	if (reaches(target)) return true;
	// #4566 F3: npm Windows shims are regular files, not symlinks. Their
	// script is the executable target; unknown script text cannot vouch for it.
	if (!/\.(?:cmd|ps1)$/i.test(resolvedCommand)) return false;
	try {
		const content = fs.readFileSync(resolvedCommand, "utf8");
		const match =
			/["'](?:%~dp0|%dp0%|\$basedir)[/\\]([^"'\r\n]+\.(?:mjs|cjs|js))["']/i.exec(
				content,
			)?.[1];
		if (!match) return true;
		const script = path.resolve(
			path.dirname(resolvedCommand),
			match.replace(/[/\\]/g, path.sep),
		);
		return reaches(normalizeFilePath(realpathOrResolve(script)));
	} catch {
		return true;
	}
}

/**
 * One bounded record per (target, session) for a global command that resolves
 * into the project; the link's own spelling is kept in the metadata so the
 * global directory that holds it stays identifiable.
 */
function refuseGlobalCommandTarget(resolvedCommand: string): void {
	const trust = getProjectTrustState() as "untrusted" | "unknown";
	const target = normalizeFilePath(realpathOrResolve(resolvedCommand));
	if (
		recordDegradationOnce({
			kind: "trust-refusal",
			subject: `global-command-target:${target}`,
			reason: `global command target could not be admitted outside the project: pi project trust is ${trust}`,
		})
	) {
		logExtension({
			subsystem: "project-trust",
			level: "warn",
			message:
				"global command target could not be admitted outside the project: mark the project trusted in pi or upgrade pi",
			metadata: { command: resolvedCommand, target, trust },
		});
	}
}

/**
 * #4530: the user-facing PATH-refusal notice is once per session, not once per
 * refused entry. Several entries can reach the same project (an absolute
 * `node_modules/.bin` and husky's relative one), and each warns with the same
 * sentence, so the message names no entry and repeating it adds no signal. The
 * `trust-refusal` ledger row below stays per entry, so the exact set is still
 * observable. Keyed on the degradation generation, which `session_start`
 * bumps, the same re-arm `unknownProjectLocalNoticeGeneration` uses.
 */
let trustScopedPathNoticeGeneration = -1;

/**
 * #4530: `pathValue` without the entries that reach the session project
 * (`process.cwd()`) or `cwd`, while pi has not trusted the project; a trusted
 * project gets `pathValue` back unchanged. pi-lens's own lookups, and the
 * tools they start, resolve names through this PATH, so a binary inside the
 * project never answers for a global one. Each ignored entry is recorded once
 * per session; the notice is emitted once per session. `refusedEntries`, when
 * supplied, receives those path spellings.
 */
export function trustScopedPath(
	pathValue: string,
	cwd: string = process.cwd(),
	refusedEntries?: string[],
): string {
	const trust = getProjectTrustState();
	if (trust === "trusted") return pathValue;
	const generation = getDegradationLedgerGeneration();
	const session = process.cwd();
	const reaches = [session, ...(pathsEqual(cwd, session) ? [] : [cwd])].map(
		projectReach,
	);
	const kept: string[] = [];
	for (const entry of pathValue.split(path.delimiter)) {
		if (!reaches.some((reach) => reach(entry))) {
			kept.push(entry);
			continue;
		}
		refusedEntries?.push(entry);
		recordDegradationOnce({
			kind: "trust-refusal",
			subject: `project-path-entry:${entry}`,
			reason: `lookup dir inside the project ignored: pi project trust is ${trust}`,
		});
		if (trustScopedPathNoticeGeneration !== generation) {
			trustScopedPathNoticeGeneration = generation;
			logExtension({
				subsystem: "project-trust",
				level: "warn",
				message:
					"lookup dir inside the project ignored: mark the project trusted in pi or upgrade pi",
				metadata: { entry, trust },
			});
		}
	}
	return kept.join(path.delimiter);
}

/**
 * #4530 round 9: a PATH value built from `parts`, never carrying a
 * zero-length entry. POSIX makes the kernel search the child's own working
 * directory for a zero-length PATH and for a zero-length entry between
 * separators, so a value pi-lens composes must not contain one — a trust-scoped
 * PATH that lost every entry is the case that made this visible (measured on
 * Linux: `PATH=""` ran `./pnpm-shim` from the cwd, a removed PATH did not).
 * The ONE seam every composer in the tree joins through, so the rule cannot
 * drift per call site.
 */
export function normalizeSearchPath(
	parts: readonly string[],
	separator: string = path.delimiter,
): string {
	return parts
		.flatMap((part) => part.split(separator))
		.filter((entry) => entry !== "")
		.join(separator);
}

/**
 * #4530 round 9: put `pathValue`, scoped by {@link trustScopedPath}, onto a
 * child's environment, or REMOVE the key when every entry was refused.
 *
 * A scoped result can be empty — every entry reached the project — and an empty
 * PATH is not "no directories": it hands project code back the lookup the trust
 * gate just took away (see {@link normalizeSearchPath}). A child with no PATH
 * falls back to the system default search path, which never contains the cwd.
 */
export function setTrustScopedPath(
	env: NodeJS.ProcessEnv,
	pathValue: string,
	cwd: string = process.cwd(),
): void {
	const scoped = trustScopedPath(pathValue, cwd);
	// POSIX has one lookup key. Windows spellings name the same variable.
	const spellings = new Set(
		onWindows()
			? Object.keys(env).filter((key) => key.toLowerCase() === "path")
			: ["PATH"],
	);
	if (scoped !== "") spellings.add("PATH");
	for (const key of spellings) {
		if (scoped === "") delete env[key];
		else env[key] = scoped;
	}
	if (scoped !== "" && process.platform === "win32") env.Path = scoped;
}

/**
 * #4530: the environment for a spawn pi-lens makes on its own behalf, with
 * every PATH spelling scoped by {@link trustScopedPath}, or `undefined` when
 * the project is trusted and the caller keeps its environment.
 */
export function trustScopedSpawnEnv(
	cwd: string = process.cwd(),
): NodeJS.ProcessEnv | undefined {
	if (getProjectTrustState() === "trusted") return undefined;
	const env: NodeJS.ProcessEnv = { ...process.env };
	const spelling = onWindows()
		? Object.keys(env).find((key) => key.toLowerCase() === "path")
		: env.PATH === undefined
			? undefined
			: "PATH";
	// An env without the platform PATH key inherits the system default search path.
	if (spelling !== undefined) setTrustScopedPath(env, env[spelling] ?? "", cwd);
	return env;
}

/** Tuning for {@link findLocalBinUpwards}. */
export interface LocalBinWalkOptions {
	/**
	 * Extension tried BEFORE the bare name on Windows. Default `.cmd`. An
	 * EMPTY string means the caller already spelled every name it wants (the
	 * ast-grep sweep passes `ast-grep.cmd`/`ast-grep.exe`/`ast-grep` itself, in
	 * a shell-dependent order this option cannot express) — without that case
	 * the bare name would be probed twice and reported twice.
	 */
	readonly windowsExt?: string;
	/** HOME ceiling; injectable so tests never touch the real home. */
	readonly homeDir?: string;
	/**
	 * Project-relative directories that hold the bin, most-preferred first.
	 * Default {@link NODE_MODULES_BIN_DIRS}; {@link VENDOR_BIN_DIRS} (Composer)
	 * and {@link VENV_BIN_DIRS} (Python) are the other two shapes in the repo.
	 */
	readonly binDirs?: readonly string[];
	/**
	 * Whether to expand `windowsExt` into the candidate names. Defaults to a
	 * LIVE `process.platform` read (never a module-load constant, shape 30).
	 * Injectable so the ubuntu Unit tests lane can exercise the Windows
	 * candidate ORDER — which only exists when there are two names — instead of
	 * leaving it to a dev box (#2544 review F4).
	 */
	readonly isWindows?: boolean;
	/**
	 * Whether the HOME ceiling applies to this walk. Default `true` — the
	 * ceiling is the right default for every PROJECT-tree resolution (#2514).
	 *
	 * `false` is for exactly one caller: `buildSgLocalBins`' walk from
	 * pi-lens's OWN install directory (`runner-helpers.ts`), never a project
	 * cwd. `pi install npm:pi-lens` installs into the HOME-level manifest
	 * (`~/package.json` → `~/node_modules/pi-lens`), so the bundled
	 * `@ast-grep/cli` shim can sit AT `~/node_modules/.bin/ast-grep` — a
	 * directory the ceiling exists precisely to stop at. The ceiling is a
	 * project-tree policy ("a bin found at or above HOME can never be THIS
	 * PROJECT's own dependency"); it says nothing about where pi-lens's own
	 * install tree is allowed to live, so this walk is exempt (#2544 round 4
	 * F1).
	 */
	readonly ceiling?: boolean;
}

/**
 * THE project-local tool-bin walk: yields every accepted `<binDir>/<tool>`
 * in `startDir` or one of its ancestors, nearest first, stopping at the HOME
 * ceiling (never the fs root — see below).
 *
 * A generator on purpose. {@link findLocalBinUpwards} takes the first match and
 * the walk suspends there — no ancestor above the hit is ever stat'd, which is
 * what a per-edit resolver needs — while {@link findLocalBinsUpwards} drains it
 * for the ast-grep probe sweep, the one caller that legitimately wants every
 * candidate above `startDir`. One walk body, two arities, no "collect-all"
 * flag whose disabled half nothing can observe.
 * `ceiling: false` opts a walk out of the HOME stop entirely (own-install
 * trees only, see {@link LocalBinWalkOptions.ceiling}); {@link findLocalBinsAt}
 * / {@link findLocalBinAt} below are the non-walking sibling for callers that
 * must check exactly one directory and never climb (`createVenvFinder`,
 * vulture's `venvCandidates`).
 *
 * `tools` is a LIST because the sweep callers probe several spellings of the
 * same tool and the preference order is per-directory: all of a directory's
 * candidates, in `tools` order, before the parent directory is looked at.
 *
 * `binDirs` makes this the ONLY such walker in the repo. Before #2544 there
 * were SIX copies of this loop — `formatters.ts`'s `findInNodeModules` /
 * `findInVendorBin` / `findInVenv`, `oxlint.ts`'s `resolveLocalVp`,
 * `runner-helpers.ts`'s `findNodeBinRoots` and `resolveVendorToolCommand` —
 * and they had drifted apart: only this one resolved a relative `startDir`,
 * only this one had the #2514 HOME ceiling, and `vp` was resolved with
 * OPPOSITE ceiling policies depending on whether `formatters.ts` or `oxlint.ts`
 * asked (#2544 review F1). They all delegate here now.
 *
 * Candidate order is EXT-OUTER, DIR-INNER: on Windows every `binDir` is tried
 * with `windowsExt` before any is tried with the bare name, matching what the
 * `.venv/Scripts` walker did before the fold.
 */
/**
 * Expand `tools` into the actual candidate file names for one directory,
 * EXT-OUTER: on Windows every tool's extended name is tried before any tool's
 * bare name (`windowsExt === ""` means the caller already spelled every name
 * it wants — the ast-grep sweep passes `ast-grep.cmd`/`ast-grep.exe`/`ast-grep`
 * itself in a shell-dependent order this option cannot express).
 */
function expandCandidateNames(
	tools: readonly string[],
	windowsExt: string,
	isWindows: boolean,
): string[] {
	return isWindows && windowsExt !== ""
		? tools.flatMap((tool) => [`${tool}${windowsExt}`, tool])
		: [...tools];
}

/** Every accepted `<dir>/<binDir>/<name>`, for exactly `dir` — no walk. */
function* matchesInDir(
	dir: string,
	names: readonly string[],
	binDirs: readonly string[],
): Generator<string, undefined> {
	for (const name of names) {
		for (const binDir of binDirs) {
			const full = path.join(dir, binDir, name);
			if (isAcceptedCommandFile(full)) yield full;
		}
	}
}

function* localBinMatches(
	tools: readonly string[],
	startDir: string,
	options: LocalBinWalkOptions,
): Generator<string, undefined> {
	const {
		windowsExt = ".cmd",
		homeDir = os.homedir(),
		binDirs = NODE_MODULES_BIN_DIRS,
		isWindows = onWindows(),
		ceiling = true,
	} = options;
	const names = expandCandidateNames(tools, windowsExt, isWindows);
	for (const dir of walkUpDirs(startDir)) {
		// Tool-resolution walker, not a config lookup (#2514/#2517 policy):
		// escaping the project upward past HOME means STOP, not keep reading. A
		// config-file lookup (`findLocalToolConfig`) keeps climbing past HOME
		// because the underlying tool would find a legitimate global config
		// there too; a `node_modules/.bin` match found at or above HOME can
		// never be THIS project's own installed dependency — it is some
		// unrelated home-level manifest (the pi-extensions bin shim, #2514).
		// Default-on (not opt-in like `findLocalToolConfig`'s `options.homeDir`)
		// because there is no legitimate case for this resolver to hand back a
		// bin from outside the project tree. `ceiling: false` (own-install
		// walk only, #2544 round 4 F1) skips this check entirely.
		if (ceiling && isAtOrAboveHomeDir(dir, homeDir)) return;
		yield* matchesInDir(dir, names, binDirs);
	}
}

/**
 * The nearest project-local `<binDir>/<tool>` at or above `startDir`, or
 * `undefined`. See {@link localBinMatches} for the walk itself.
 *
 * Exported so callers that must NOT pay for global-bin discovery can reuse this
 * walk instead of copying it. `findNodeToolBinary` below adds `findGlobalBinary`,
 * which spawns a probe per package manager; a caller resolving a command on
 * every run (knip, #1721) needs the filesystem half only.
 */
export function findLocalBinUpwards(
	tool: string,
	startDir: string,
	options: LocalBinWalkOptions = {},
): LocalBinLookup | undefined {
	// `.next().value`, not a `for…of` that returns on its first iteration: the
	// latter is a single-iteration loop (SonarCloud S1751, and it reads as one
	// too). The generator is simply left suspended after the first match — it
	// holds no resource that needs closing, which is exactly why the walk above
	// never stats an ancestor beyond the hit.
	const match = localBinMatches([tool], startDir, options).next().value;
	if (match === undefined || options.ceiling === false) return match;
	if (getProjectTrustState() !== "trusted")
		return refuseLocalBin(tool, startDir);
	return match;
}

/**
 * EVERY project-local match for `tools` at or above `startDir`, nearest first.
 *
 * For the ast-grep availability sweep (`runner-helpers.ts`'s `buildSgLocalBins`,
 * which spawns `--version` against each candidate until one answers, both for
 * the project walk and — with `ceiling: false` — pi-lens's own install-tree
 * walk), which previously hand-rolled its own unceilinged climb precisely
 * because the singular `findLocalBinUpwards` could not express "all of them"
 * (#2544 review F1).
 *
 * NOT for a "project's own venv/vendor-bin first" resolver: `createVenvFinder`
 * and vulture's `venvCandidates` looked like this walk's other two callers in
 * round 3, but that was an unrequested behaviour change (round 3 introduced
 * ancestor climbing where a single cwd/root lookup existed before, with no
 * #2514 defect behind it) — reverted in round 4 F2 to {@link findLocalBinsAt}.
 */
export function findLocalBinsUpwards(
	tools: readonly string[],
	startDir: string,
	options: LocalBinWalkOptions = {},
): LocalBinLookup[] {
	const matches = [...localBinMatches(tools, startDir, options)];
	if (
		matches.length === 0 ||
		options.ceiling === false ||
		getProjectTrustState() === "trusted"
	) {
		return matches;
	}
	return [refuseLocalBin(tools.join(","), startDir)];
}

/**
 * EVERY `<dir>/<binDir>/<tool>` that exists for exactly `dir` — no ancestor
 * walk, so the HOME ceiling is moot (a single directory can never climb past
 * it).
 *
 * For the "project's own venv/vendor-bin first" resolvers that must NOT climb
 * to a parent project (#2544 round 4 F2): `createVenvFinder` and vulture's
 * `venvCandidates` were fixed `cwd`/`root` lookups before #2544 review round 3
 * converted them into ancestor walks with no reported defect behind the
 * conversion (an unrelated sibling project's interpreter at `~/code/.venv`
 * could then outrank PATH for `~/code/app`, which has no venv of its own).
 * Reverted here; `binDirs`/`windowsExt` stay shared with the walking helpers
 * above so the three directory shapes have exactly one spelling.
 */
export function findLocalBinsAt(
	tools: readonly string[],
	dir: string,
	options: Pick<
		LocalBinWalkOptions,
		"windowsExt" | "binDirs" | "isWindows"
	> = {},
): LocalBinLookup[] {
	const {
		windowsExt = ".cmd",
		binDirs = NODE_MODULES_BIN_DIRS,
		isWindows = onWindows(),
	} = options;
	const names = expandCandidateNames(tools, windowsExt, isWindows);
	const matches = [...matchesInDir(path.resolve(dir), names, binDirs)];
	if (matches.length === 0 || getProjectTrustState() === "trusted")
		return matches;
	return [refuseLocalBin(tools.join(","), dir)];
}

/** The nearest — i.e. first-listed — `<dir>/<binDir>/<tool>` match, or `undefined`. */
export function findLocalBinAt(
	tool: string,
	dir: string,
	options: Pick<
		LocalBinWalkOptions,
		"windowsExt" | "binDirs" | "isWindows"
	> = {},
): LocalBinLookup | undefined {
	const match = findLocalBinsAt([tool], dir, options)[0];
	return match;
}

/**
 * Locate a Node CLI tool's binary, preferring a local `node_modules/.bin`
 * (walking up from `cwd`) then any installed package manager's global bin dir
 * (npm/pnpm/yarn/bun). Returns the absolute path, or `undefined` so the caller
 * can fall back to its own `npx` invocation.
 *
 * This is the shared "widen the global-bin lookup" step from #375: the client
 * resolvers that previously jumped straight from a local check to `npx <tool>`
 * now find tools installed via `pnpm add -g` / `bun add -g` (off PATH) too,
 * without changing their npx fallback semantics.
 */
export async function findNodeToolBinary(
	tool: string,
	cwd: string,
	windowsExt = ".cmd",
): Promise<string | undefined> {
	return (
		localBinPath(findLocalBinUpwards(tool, cwd, { windowsExt })) ??
		(await findGlobalBinary(tool, windowsExt, cwd))
	);
}
