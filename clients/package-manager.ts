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
import { isCommandAvailableAsync, safeSpawnAsync } from "./safe-spawn.js";

export type NodePackageManager = "npm" | "pnpm" | "yarn" | "bun";

/**
 * Fallback preference when nothing is declared (or the declared manager is
 * missing). npm first for maximum compatibility; bun last. A project lockfile
 * always overrides this order.
 */
const PREFERENCE: readonly NodePackageManager[] = ["npm", "pnpm", "yarn", "bun"];

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

const availabilityCache = new Map<NodePackageManager, Promise<boolean>>();

function isAvailable(pm: NodePackageManager): Promise<boolean> {
	let cached = availabilityCache.get(pm);
	if (!cached) {
		cached = isCommandAvailableAsync(pm);
		availabilityCache.set(pm, cached);
	}
	return cached;
}

/** Clear the process-wide availability cache. Intended for tests. */
export function _resetPackageManagerCache(): void {
	availabilityCache.clear();
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
export function formatRunScript(pm: NodePackageManager, script: string): string {
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
 * Args to install a single package **globally** (`-g`). npm/pnpm/bun spell this
 * `install -g` / `add -g`; yarn uses `global add` (yarn classic — Berry removed
 * global installs, but pi-lens's manager resolution prefers npm/pnpm first, so
 * yarn is only chosen when it is the declared/only manager). The resulting
 * binary is found again by `allAvailableGlobalBinDirs`, which covers every
 * manager's global bin dir.
 */
export function globalInstallArgs(pm: NodePackageManager, pkg: string): string[] {
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

/** Directories where a given manager installs global binaries. */
async function globalBinDirsFor(pm: NodePackageManager): Promise<string[]> {
	if (pm === "bun") {
		// bun has no per-call query cost — the global bin dir is deterministic.
		const base = process.env.BUN_INSTALL || path.join(os.homedir(), ".bun");
		return [path.join(base, "bin")];
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
	if (pm === "npm") {
		return [onWindows() ? out : path.join(out, "bin")];
	}
	return [out];
}

/**
 * Global bin directories for every installed manager, deduped. Used to locate a
 * globally-installed tool binary when PATH is stale (e.g. right after an
 * `install -g`) or when the tool was installed via a non-npm manager.
 */
export async function allAvailableGlobalBinDirs(): Promise<string[]> {
	const dirs: string[] = [];
	const seen = new Set<string>();
	for (const pm of PREFERENCE) {
		if (!(await isAvailable(pm))) continue;
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

/** Local `node_modules/.bin/<tool>` walking up from `startDir` to the fs root. */
function findLocalBinUpwards(
	tool: string,
	startDir: string,
	windowsExt: string,
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
