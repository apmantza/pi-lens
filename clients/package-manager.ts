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
import * as os from "node:os";
import * as path from "node:path";
import {
	type AvailabilityLatch,
	classifyProbeFailure,
	createAvailabilityLatch,
	isTransientDecision,
	logAvailabilityDecision,
	startHostStallSampler,
} from "./dispatch/runners/utils/availability-policy.js";
import { safeSpawnAsync } from "./safe-spawn.js";
import { createAvailabilityProbeFlight } from "./availability-probe-flight.js";
import {
	createGenerationSource,
	type GenerationHandle,
} from "./generation-guard.js";

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
const availabilityLatches = new Map<NodePackageManager, AvailabilityLatch>();

function getLatch(pm: NodePackageManager): AvailabilityLatch {
	let latch = availabilityLatches.get(pm);
	if (!latch) {
		latch = createAvailabilityLatch();
		availabilityLatches.set(pm, latch);
	}
	return latch;
}

async function probeAvailability(pm: NodePackageManager): Promise<boolean> {
	const latch = getLatch(pm);
	const startedAt = Date.now();
	const finder = onWindows() ? "where" : "which";
	const sampler = startHostStallSampler();
	let result: Awaited<ReturnType<typeof safeSpawnAsync>>;
	let hostStallMs: number;
	try {
		result = await safeSpawnAsync(finder, [pm], { timeout: PROBE_TIMEOUT_MS });
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
	onTransient?: () => void,
): Promise<boolean> {
	const latch = getLatch(pm);

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
	const shared = packageManagerProbeFlights.run(`package-manager:${pm}`, () =>
		probeAvailability(pm),
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
	if (declared && (await isAvailable(declared))) {
		return declared;
	}
	for (const pm of PREFERENCE) {
		if (await isAvailable(pm)) return pm;
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

/** Human-readable "run script" command for display (bare manager name). */
export function formatRunScript(
	pm: NodePackageManager,
	script: string,
): string {
	return `${pm} run ${script}`;
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

/**
 * Args to install a single package **globally** (`-g`). npm/pnpm/bun spell this
 * `install -g` / `add -g`; yarn uses `global add` (yarn classic — Berry removed
 * global installs, but pi-lens's manager resolution prefers npm/pnpm first, so
 * yarn is only chosen when it is the declared/only manager). The resulting
 * binary is found again by `allAvailableGlobalBinDirs`, which covers every
 * manager's global bin dir.
 */
export function globalInstallArgs(
	pm: NodePackageManager,
	pkg: string,
): string[] {
	switch (pm) {
		case "yarn":
			return ["global", "add", pkg];
		case "npm":
			return ["install", "-g", pkg];
		default: // pnpm, bun
			return ["add", "-g", pkg];
	}
}

/**
 * Command + args to run a package's binary without a global install — the
 * `npx --no <pkg>` equivalent for each manager (`bun x`, `pnpm dlx`, `yarn dlx`).
 */
export function execArgs(
	pm: NodePackageManager,
	pkg: string,
	args: string[] = [],
): { command: string; args: string[] } {
	switch (pm) {
		case "bun":
			return { command: pmBinary("bun"), args: ["x", pkg, ...args] };
		case "pnpm":
			return { command: pmBinary("pnpm"), args: ["dlx", pkg, ...args] };
		case "yarn":
			return { command: pmBinary("yarn"), args: ["dlx", pkg, ...args] };
		default:
			// --no prevents silently downloading an uncached package.
			return {
				command: onWindows() ? "npx.cmd" : "npx",
				args: ["--no", pkg, ...args],
			};
	}
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
const globalBinDirCache = new Map<NodePackageManager, string[]>();
const packageManagerCacheGeneration = createGenerationSource(
	"package-manager-global-bin",
);
const globalBinDirProbeFlights = createAvailabilityProbeFlight<string[]>();

/** Directories where a given manager installs global binaries. */
async function globalBinDirsFor(pm: NodePackageManager): Promise<string[]> {
	const cached = globalBinDirCache.get(pm);
	if (cached) return cached;
	const generation = packageManagerCacheGeneration.capture();

	// Concurrent callers (dispatch runs several tools per edit) must share ONE
	// probe rather than each spawning their own `npm config get prefix` (#1602).
	const shared = globalBinDirProbeFlights.run(pm, () =>
		probeGlobalBinDirs(pm, generation),
	);
	return shared.promise;
}

async function probeGlobalBinDirs(
	pm: NodePackageManager,
	generation: GenerationHandle,
): Promise<string[]> {
	if (pm === "bun") {
		// bun has no per-call query cost — the global bin dir is deterministic.
		const base = process.env.BUN_INSTALL || path.join(os.homedir(), ".bun");
		const dirs = [path.join(base, "bin")];
		generation.guardedWrite(pm, () => {
			globalBinDirCache.set(pm, dirs);
		});
		return dirs;
	}

	const query =
		pm === "npm"
			? ["config", "get", "prefix"]
			: pm === "pnpm"
				? ["bin", "-g"]
				: ["global", "bin"]; // yarn
	const res = await safeSpawnAsync(pmBinary(pm), query, { timeout: 5000 });
	if (res.status !== 0 || res.error) return [];
	const out = res.stdout.trim();
	if (!out) return [];

	// npm reports a prefix; binaries live in `<prefix>/bin` on Unix, `<prefix>`
	// on Windows. pnpm/yarn already print the bin dir directly.
	const dirs =
		pm === "npm" ? [onWindows() ? out : path.join(out, "bin")] : [out];
	generation.guardedWrite(pm, () => {
		globalBinDirCache.set(pm, dirs);
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
): Promise<string[]> {
	const dirs: string[] = [];
	const seen = new Set<string>();
	for (const pm of PREFERENCE) {
		if (!(await isAvailable(pm, onTransient))) continue;
		for (const dir of await globalBinDirsFor(pm)) {
			const normalized = path.resolve(dir);
			if (seen.has(normalized)) continue;
			seen.add(normalized);
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
 * bare name; on Unix just the bare name.
 */
export async function findGlobalBinary(
	command: string,
	windowsExt = ".cmd",
): Promise<string | undefined> {
	const candidates = onWindows()
		? [`${command}${windowsExt}`, `${command}.exe`, command]
		: [command];
	try {
		for (const binDir of await allAvailableGlobalBinDirs()) {
			for (const name of candidates) {
				const full = path.join(binDir, name);
				if (fs.existsSync(full)) return full;
			}
		}
	} catch {
		// Manager probes can fail (missing binary, spawn error) — treat as "not
		// found" so callers fall through to their next resolution step.
	}
	return undefined;
}

/**
 * Local `node_modules/.bin/<tool>` walking up from `startDir` to the fs root.
 *
 * Exported so callers that must NOT pay for global-bin discovery can reuse this
 * walk instead of copying it. `findNodeToolBinary` below adds `findGlobalBinary`,
 * which spawns a probe per package manager; a caller resolving a command on
 * every run (knip, #1721) needs the filesystem half only.
 */
export function findLocalBinUpwards(
	tool: string,
	startDir: string,
	windowsExt = ".cmd",
): string | undefined {
	const names = onWindows() ? [`${tool}${windowsExt}`, tool] : [tool];
	let dir = path.resolve(startDir);
	const root = path.parse(dir).root;
	while (true) {
		for (const name of names) {
			const full = path.join(dir, "node_modules", ".bin", name);
			if (fs.existsSync(full)) return full;
		}
		if (dir === root) break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
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
		findLocalBinUpwards(tool, cwd, windowsExt) ??
		(await findGlobalBinary(tool, windowsExt))
	);
}
